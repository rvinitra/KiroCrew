"""The denial differential must fail on a newly-refused golden path, and only then.

``scripts/deny_diff.py`` answers one question about a deny-rule change: does the
tightened rule now refuse an operation the product depends on? The answer is a
before/after classification, so the thing that can silently break is the
COMPARISON -- a gate that classifies one tree twice, or that reads a loosening as
a regression, reports a confident verdict about nothing.

So the exit-code paths are proven against two hand-built classifier trees rather
than against the real matcher. The real one is what the gate measures; making it
also the fixture would mean the tests could only assert whatever it happens to do
today, and a regression could not be staged at all. The fakes travel the SAME
subprocess path as production -- ``PYTHONPATH`` at a materialized tree, one child
per side, verdicts diffed in the parent -- with only the ref-to-checkout resolver
replaced, which is why an exit code proven here is the exit code CI produces.

One test then runs the real classifier: ``base == head == HEAD`` over the fallback
corpus must find zero regressions. That is the property the two fakes cannot
check -- that the corpus names operations the shipped rules actually allow, so a
red on a future PR means that PR tightened something, not that the corpus was
wrong when it was written.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deny_diff.py"
FALLBACK_CORPUS = ROOT / "scripts" / "deny_diff_fixture.json"

SPEC = importlib.util.spec_from_file_location("deny_diff", SCRIPT)
assert SPEC and SPEC.loader
deny_diff = importlib.util.module_from_spec(SPEC)
# Registered BEFORE exec: the script's dataclasses resolve their own (string)
# annotations through ``sys.modules[cls.__module__]``, so a module executed
# without a registration raises at class-creation time rather than at use.
sys.modules[SPEC.name] = deny_diff
SPEC.loader.exec_module(deny_diff)


#: A whole classifier, in the shape the worker imports it: a package under
#: ``src/`` exposing ``is_denied``. Everything the differential needs from a tree
#: is this one function, which is why a fake can be this small -- and why the
#: subprocess path can be exercised for real instead of mocked out.
_FAKE_CLASSIFIER = """
DENIED = {denied!r}


def is_denied(command, *args, **kwargs):
    return "Blocked by security policy: fake rule" if command in DENIED else None
"""


def _fake_tree(root: Path, denied: set[str]) -> Path:
    """A minimal importable ``kiro_crew.security`` under *root* that denies *denied*."""
    package = root / "src" / "kiro_crew" / "security"
    package.mkdir(parents=True, exist_ok=True)
    (root / "src" / "kiro_crew" / "__init__.py").write_text("", encoding="utf-8")
    (package / "__init__.py").write_text(
        _FAKE_CLASSIFIER.format(denied=sorted(denied)), encoding="utf-8"
    )
    return root


def _corpus(path: Path, rows: list[dict]) -> Path:
    path.write_text(json.dumps({"golden_paths": rows}), encoding="utf-8")
    return path


def _shell(command: str, platform: str = "any") -> dict:
    return {
        "kind": "shell",
        "command_or_flow": command,
        "platform": platform,
        "reason": f"golden path: {command}",
    }


@pytest.fixture()
def staged(tmp_path, monkeypatch):
    """Stage two classifier trees and point the resolver at them.

    Returns a callable taking the corpus rows and returning the report. The
    resolver is monkeypatched on the MODULE, which is the same seam production
    reads, so nothing about the child spawn, the environment scrub or the verdict
    parsing is bypassed.
    """
    runs = 0

    def run(
        rows: list[dict],
        *,
        base_denies: set[str],
        head_denies: set[str],
        platform: str = "posix",
    ):
        nonlocal runs
        runs += 1
        base_tree = _fake_tree(tmp_path / f"base-tree-{runs}", base_denies)
        head_tree = _fake_tree(tmp_path / f"head-tree-{runs}", head_denies)

        def resolver(repo_root: Path, ref: str, dest: Path) -> Path:
            return base_tree if ref == "BASE" else head_tree

        monkeypatch.setattr(deny_diff, "resolve_checkout", resolver)
        workdir = tmp_path / f"work-{runs}"
        workdir.mkdir()
        return deny_diff.differential(
            ROOT,
            "BASE",
            "HEAD",
            _corpus(workdir / "corpus.json", rows),
            platform=platform,
            workdir=workdir,
        )

    return run


def test_newly_refused_golden_path_is_a_regression(staged):
    """A row the base allows and the head refuses fails the gate (exit 1)."""
    push = "git push origin feat/x"
    report = staged(
        [_shell("gh pr view 1 --json state"), _shell(push)],
        base_denies=set(),
        head_denies={push},
    )

    assert report.exit_code == 1
    assert [row.command for row, _ in report.regressions] == [push]
    assert report.loosenings == []
    assert report.unchanged_allowed == 1

    text = deny_diff.render_text(report)
    assert "Regressions -- newly refused at head (1)" in text
    # The report has to carry WHY the row is legitimate, not just that it broke:
    # the reader's next action is to judge the rule against the reason.
    assert f"legitimate because: golden path: {push}" in text
    assert "fake rule" in text


def test_loosening_only_passes_and_is_reported(staged):
    """A row the base refuses and the head allows is informational, not a failure."""
    listing = "ls -la src"
    report = staged(
        [_shell(listing), _shell("git status --porcelain")],
        base_denies={listing},
        head_denies=set(),
    )

    assert report.exit_code == 0
    assert report.regressions == []
    assert [row.command for row, _ in report.loosenings] == [listing]

    text = deny_diff.render_text(report)
    assert "No regressions" in text
    assert "Loosenings -- newly allowed at head (1), informational" in text
    assert f"`{listing}`" in text


def test_unchanged_rows_are_counted_on_both_sides(staged):
    """Refused-at-both is not a regression, and is reported apart from allowed-at-both."""
    blocked = "rm -rf /"
    report = staged(
        [_shell(blocked), _shell("git log --oneline -5")],
        base_denies={blocked},
        head_denies={blocked},
    )

    assert report.exit_code == 0
    assert (report.unchanged_denied, report.unchanged_allowed) == (1, 1)
    assert "Unchanged: 1 allowed at both refs, 1 refused at both." in deny_diff.render_text(report)


def test_platform_filter_selects_only_matching_rows(staged):
    """A windows-only row is not classified on posix -- and cannot fail the gate there."""
    win_only = "Get-ChildItem -Path src"
    rows = [_shell(win_only, platform="windows"), _shell("ls -la src", platform="posix")]

    posix = staged(rows, base_denies=set(), head_denies={win_only}, platform="posix")
    assert posix.exit_code == 0
    assert posix.skipped_platform == 1
    assert posix.classified == 1

    windows = staged(rows, base_denies=set(), head_denies={win_only}, platform="windows")
    assert windows.exit_code == 1
    assert [row.command for row, _ in windows.regressions] == [win_only]
    assert windows.skipped_platform == 1


def test_non_shell_rows_are_skipped_not_dropped(staged):
    """Flow and cron rows are reported as skipped, so a corpus of them says so."""
    report = staged(
        [
            _shell("git fetch origin main"),
            {"kind": "flow", "command_or_flow": "chat start", "platform": "any", "reason": "r"},
            {"kind": "cron", "command_or_flow": "scanner", "platform": "any", "reason": "r"},
        ],
        base_denies=set(),
        head_denies=set(),
    )

    assert (report.skipped_kind, report.classified, report.total_rows) == (2, 1, 3)
    assert "2 non-shell" in deny_diff.render_text(report)


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ("{ not json", "not valid JSON"),
        ('{"unrelated": []}', "without a 'golden_paths' or 'rows' key"),
        ('{"golden_paths": []}', "holds no rows"),
        ('{"golden_paths": ["a string"]}', "row 0 is not an object"),
        ('{"golden_paths": [{"kind": "spell", "command_or_flow": "x"}]}', "has kind 'spell'"),
        ('{"golden_paths": [{"kind": "shell", "command_or_flow": "  "}]}', "no non-empty"),
        (
            '{"golden_paths": [{"kind": "shell", "command_or_flow": "x", "platform": "vms"}]}',
            "has platform 'vms'",
        ),
        ('{"golden_paths": 7}', "must hold a list of rows"),
    ],
)
def test_malformed_corpus_is_an_error_not_a_verdict(tmp_path, payload, expected):
    """Every corpus defect exits 2. Silently classifying a subset would be a false green."""
    corpus = tmp_path / "corpus.json"
    corpus.write_text(payload, encoding="utf-8")

    with pytest.raises(deny_diff.DenyDiffError) as caught:
        deny_diff.load_corpus(corpus)
    assert expected in str(caught.value)

    assert deny_diff.main(["--base", "HEAD", "--head", "HEAD", "--corpus", str(corpus)]) == 2


def test_missing_corpus_file_exits_two(tmp_path):
    missing = tmp_path / "absent.json"
    assert deny_diff.main(["--base", "HEAD", "--head", "HEAD", "--corpus", str(missing)]) == 2


def test_unresolvable_ref_exits_two(tmp_path):
    """A ref that cannot be archived is an environment error, never 'no regressions'."""
    corpus = _corpus(tmp_path / "corpus.json", [_shell("git status --porcelain")])
    code = deny_diff.main(
        ["--base", "refs/heads/no-such-ref-deny-diff", "--head", "HEAD", "--corpus", str(corpus)]
    )
    assert code == 2


def test_child_environment_is_scrubbed_of_crew_variables(tmp_path, monkeypatch):
    """The verdict must not be a function of the caller's environment."""
    monkeypatch.setenv("KIROCREW_SANDBOX_ACTIVE", "1")
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "real-home"))

    env = deny_diff._child_env(tmp_path / "checkout", tmp_path / "throwaway-home")

    assert "KIROCREW_SANDBOX_ACTIVE" not in env
    assert env["KIROCREW_HOME"] == str(tmp_path / "throwaway-home")
    assert env["PYTHONPATH"] == str(tmp_path / "checkout" / "src")


def test_worker_refuses_a_tree_it_was_not_pointed_at(tmp_path):
    """The shadowing guard: one tree answering for both refs is an error, not a green.

    Without this the differential's failure mode is invisible -- both sides would
    load the same installed package and every comparison would come back empty.
    """
    _fake_tree(tmp_path / "real", set())
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()

    request = {"commands": ["ls"], "expect_root": str((elsewhere / "src").resolve())}
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), deny_diff._WORKER_FLAG],
        input=json.dumps(request),
        capture_output=True,
        text=True,
        env=deny_diff._child_env(tmp_path / "real", tmp_path / "home"),
    )

    assert proc.returncode == 2
    assert "outside" in proc.stderr


def test_platform_auto_resolves_to_the_running_host(monkeypatch):
    monkeypatch.setattr(deny_diff.os, "name", "nt")
    assert deny_diff.resolve_platform("auto") == "windows"
    monkeypatch.setattr(deny_diff.os, "name", "posix")
    assert deny_diff.resolve_platform("auto") == "posix"
    # An explicit selector is never overridden by the host.
    assert deny_diff.resolve_platform("windows") == "windows"


def test_json_rendering_carries_the_rows_and_the_exit_code(staged):
    push = "git push origin feat/x"
    report = staged([_shell(push)], base_denies=set(), head_denies={push})

    payload = json.loads(deny_diff.render_json(report))

    assert payload["exit_code"] == 1
    assert payload["counts"]["regressions"] == 1
    assert payload["regressions"][0]["command"] == push
    assert payload["regressions"][0]["why_legitimate"] == f"golden path: {push}"
    assert "fake rule" in payload["regressions"][0]["head_refusal"]


def test_real_classifier_finds_no_regressions_between_head_and_itself():
    """The corpus names operations the SHIPPED rules allow.

    base == head means every verdict is identical by construction, so this cannot
    fail on a comparison bug -- it fails when a row of the corpus is not actually a
    golden path under the current classifier, or when the harness cannot materialize
    a ref and classify it at all. Both are things the fake trees never touch.
    """
    code = deny_diff.main(
        ["--base", "HEAD", "--head", "HEAD", "--corpus", str(FALLBACK_CORPUS), "--json"]
    )
    assert code == 0


def test_fallback_corpus_rows_are_all_allowed_by_the_shipped_classifier(tmp_path):
    """Stronger than the differential above: no row is refused at HEAD at all.

    A row refused at BOTH refs is 'unchanged' to the differential, so it would ride
    along green forever while claiming to be a golden path the product depends on.
    """
    rows = deny_diff.load_corpus(FALLBACK_CORPUS)
    shell_rows = [r for r in rows if r.kind == "shell" and r.applies_to("posix")]
    assert shell_rows, "fallback corpus has no posix-applicable shell rows"

    checkout = deny_diff.resolve_checkout(ROOT, "HEAD", tmp_path / "head")
    verdicts = deny_diff.classify(checkout, [r.command for r in shell_rows], home=tmp_path / "home")

    refused = [
        (row.command, verdict.reason)
        for row, verdict in zip(shell_rows, verdicts)
        if verdict.denied
    ]
    assert refused == []

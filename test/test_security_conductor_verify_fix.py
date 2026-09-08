"""``verify_fix.py`` — the two-step gate, and the verdict it must never reach.

The properties pinned here are the ones a prompt cannot hold. A fix is verified
only when the proof stops reproducing AND every legitimate operation still works,
so the interesting assertions are all about the verdict LADDER: a proof that still
reproduces outranks everything, a broken golden path is a rejection, and
``holds`` is unreachable while any golden path went unchecked.

The script is driven as a SUBPROCESS with its siblings staged beside it, because
that is the contract that matters: it finds ``verify_finding.py`` and ``ledger.py``
as files next to itself, so a property that holds only when the module is imported
into the test process would not be the property the harness relies on. Staging the
directory is also what makes the absent-verifier case testable at all.

The deny fence is reached through ``--classifier-cmd``, the declared testing seam:
a stub answering the probe protocol lets a refusal be arranged deliberately
instead of hoping the real fence refuses something. One class at the end does use
the REAL fence, and asserts the shipped corpus against it -- that is the corpus's
whole purpose, and a test that stubbed it would assert nothing about the rows.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from skill_script_helpers import load_skill_script

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = REPO_ROOT / "src" / "kiro_crew" / "builtin_skills" / "security-conductor"
SCRIPTS = SKILL_DIR / "scripts"
VERIFY_FIX = SCRIPTS / "verify_fix.py"
LEDGER = SCRIPTS / "ledger.py"
SEED = SKILL_DIR / "golden-paths.seed.json"

EXIT_HOLDS = 0
EXIT_REPRODUCES = 10
EXIT_UNVERIFIABLE = 20
EXIT_BROKEN = 30
EXIT_INVALID = 2

#: The verifier's own contract, as ``verify_fix.py`` reads it.
VERIFIER_CONFIRMED = 0
VERIFIER_REJECTED = 10
VERIFIER_NEEDS_HUMAN = 20

#: A stub verifier: it takes the flags the real one takes, ignores them, and exits
#: the status the test asked for. The real script's judgement is not what these
#: tests are about -- the fold over its exit code is.
STUB_VERIFIER = """import sys
sys.exit({code})
"""

#: A stub deny classifier answering the probe protocol on stdin/stdout. It refuses
#: any command containing a marker substring, so a test can arrange exactly one
#: broken golden path without depending on what the real fence happens to think.
STUB_CLASSIFIER = """import json
import sys

marker = sys.argv[1] if len(sys.argv) > 1 else None
request = json.loads(sys.stdin.read() or "{}")
results = []
for command in request.get("commands") or []:
    refuses = marker is not None and marker in command
    results.append(
        {"command": command, "reason": "stub refusal: %s" % marker if refuses else None}
    )
json.dump({"available": True, "results": results}, sys.stdout)
"""

#: A stub classifier that reports the fence as unreadable, which is what an
#: uninstallable package looks like to the probe.
STUB_CLASSIFIER_UNAVAILABLE = """import json
import sys

sys.stdin.read()
json.dump({"available": False, "error": "stub: not importable"}, sys.stdout)
"""


@pytest.fixture
def mod():
    return load_skill_script("security_conductor_verify_fix", VERIFY_FIX)


@pytest.fixture
def ledger_mod():
    return load_skill_script("security_conductor_ledger_for_fix_tests", LEDGER)


@pytest.fixture
def staged(tmp_path: Path) -> Path:
    """A scripts directory holding ``verify_fix.py`` and ``ledger.py`` and nothing else.

    The verifier is absent on purpose: every test that wants one installs it, so
    the absent case is the DEFAULT rather than a special setup nobody writes.
    """
    directory = tmp_path / "scripts"
    directory.mkdir()
    shutil.copy2(VERIFY_FIX, directory / "verify_fix.py")
    shutil.copy2(LEDGER, directory / "ledger.py")
    return directory


@pytest.fixture
def worktree(tmp_path: Path) -> Path:
    directory = tmp_path / "target"
    directory.mkdir()
    return directory


def install_verifier(staged: Path, code: int) -> None:
    (staged / "verify_finding.py").write_text(STUB_VERIFIER.format(code=code), encoding="utf-8")


def classifier(tmp_path: Path, marker: str | None = None, *, available: bool = True) -> list[str]:
    body = STUB_CLASSIFIER if available else STUB_CLASSIFIER_UNAVAILABLE
    path = tmp_path / f"stub_classifier_{'ok' if available else 'gone'}.py"
    path.write_text(body, encoding="utf-8")
    argv = [sys.executable, str(path)]
    if marker is not None:
        argv.append(marker)
    return argv


def a_golden_path(
    ledger_mod,
    db: Path,
    *,
    kind: str = "shell",
    command: str,
    platform: str = "any",
    active: bool = True,
) -> int:
    conn = ledger_mod.connect(db)
    try:
        ledger_mod.init_schema(conn)
        path_id, _ = ledger_mod.add_golden_path(
            conn,
            kind=kind,
            surface="test",
            command_or_flow=command,
            platform=platform,
            reason="a legitimate operation this fix must keep alive",
            source_finding_id=None,
            approved_by="tester",
            active=active,
        )
    finally:
        conn.close()
    return path_id


def run_fix(
    staged: Path,
    db: Path,
    worktree: Path,
    *,
    classifier_cmd: list[str] | None = None,
    platform: str = "posix",
    timeout: int = 30,
) -> subprocess.CompletedProcess[str]:
    argv = [
        sys.executable,
        str(staged / "verify_fix.py"),
        "--db",
        str(db),
        "--finding-id",
        "1",
        "--worktree",
        str(worktree),
        "--platform",
        platform,
        "--timeout",
        str(timeout),
    ]
    if classifier_cmd is not None:
        argv += ["--classifier-cmd", json.dumps(classifier_cmd)]
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", timeout=300)


def payload(result: subprocess.CompletedProcess[str]) -> dict:
    return json.loads(result.stdout.strip().splitlines()[-1])


class TestTheProofIsTheFirstGate:
    def test_a_reproducing_proof_is_ten_and_outranks_everything(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """A fix that did not land is not a fix whose golden paths are interesting.

        The refused golden path is present deliberately: the verdict must still be
        10, because reporting 30 would send the reviewer to fix a legitimate
        operation while the vulnerability is still open.
        """
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="gh pr view 1 --json state REFUSE-ME")
        install_verifier(staged, VERIFIER_CONFIRMED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path, "REFUSE-ME"))
        assert result.returncode == EXIT_REPRODUCES, result.stderr
        body = payload(result)
        assert body["verdict"] == "reproduces"
        # The broken row is still REPORTED, so one round of feedback carries both.
        assert [row["id"] for row in body["broken"]]

    def test_a_rejected_proof_with_intact_golden_paths_holds(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="gh pr view 1 --json state")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path, "REFUSE-ME"))
        assert result.returncode == EXIT_HOLDS, result.stderr
        body = payload(result)
        assert body["verdict"] == "holds"
        assert body["broken"] == []
        assert body["unverifiable"] == []

    def test_a_verifier_that_cannot_settle_it_is_twenty(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="git status --porcelain")
        install_verifier(staged, VERIFIER_NEEDS_HUMAN)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        assert payload(result)["poc"]["verdict"] == "unverifiable"

    def test_an_exit_status_outside_the_contract_is_twenty(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """An unrecognised status is not permission.

        The verifier's contract names 0, 10, 20 and 2. A 7 means this script is
        reading a version of it that it does not understand, and the only safe
        reading of that is that nothing was settled.
        """
        db = tmp_path / "findings.db"
        install_verifier(staged, 7)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        assert "not in its contract" in payload(result)["poc"]["reason"]


class TestAnAbsentVerifierIsNeverAPass:
    def test_a_missing_verifier_is_twenty_and_says_so(
        self, staged: Path, tmp_path: Path, worktree: Path
    ) -> None:
        """The scripts land one at a time, so "not installed" is a real state.

        This is the case the whole exit ladder exists for: with no verifier there
        is no evidence the fix landed, and a 0 here would report an unverified fix
        as verified.
        """
        db = tmp_path / "findings.db"
        assert not (staged / "verify_finding.py").exists()
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        body = payload(result)
        assert body["verdict"] == "unverifiable"
        assert "verify_finding.py is not installed" in body["poc"]["reason"]


class TestABrokenGoldenPathRejectsTheFix:
    def test_a_refused_shell_row_is_thirty_and_names_the_row(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """The "tool became unusable" rejection, with the row a reviewer must act on."""
        db = tmp_path / "findings.db"
        refused = "gh pr view 1 --json state REFUSE-ME"
        path_id = a_golden_path(ledger_mod, db, command=refused)
        a_golden_path(ledger_mod, db, command="git status --porcelain")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path, "REFUSE-ME"))
        assert result.returncode == EXIT_BROKEN, result.stderr
        body = payload(result)
        assert body["verdict"] == "broken"
        assert [row["id"] for row in body["broken"]] == [path_id]
        assert refused in body["broken"][0]["command_or_flow"]
        assert "stub refusal" in body["broken"][0]["why"]
        # The reason the human approved the row travels with the rejection: it is
        # what tells the reviewer whether to change the fix or retire the row.
        assert body["broken"][0]["reason"]

    def test_a_retired_row_is_not_checked(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="gh pr view 1 REFUSE-ME", active=False)
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path, "REFUSE-ME"))
        assert result.returncode == EXIT_HOLDS, result.stderr
        assert payload(result)["golden_paths_checked"] == 0

    def test_a_flow_that_stops_working_is_thirty(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """A flow row is RUN, so its rejection is an observed failure, not a shape."""
        db = tmp_path / "findings.db"
        failing = tmp_path / "failing_flow.py"
        failing.write_text("import sys\nsys.exit(3)\n", encoding="utf-8")
        a_golden_path(
            ledger_mod,
            db,
            kind="flow",
            command=f"{sys.executable} {failing}",
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_BROKEN, result.stderr
        assert "exited 3" in payload(result)["broken"][0]["why"]

    def test_a_flow_that_still_works_holds(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        passing = tmp_path / "passing_flow.py"
        passing.write_text("import sys\nsys.exit(0)\n", encoding="utf-8")
        a_golden_path(ledger_mod, db, kind="flow", command=f"{sys.executable} {passing}")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_HOLDS, result.stderr

    def test_an_unparseable_cron_pair_is_thirty(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, kind="cron", command="17 3 * * :: gh pr list")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_BROKEN, result.stderr
        assert "does not parse" in payload(result)["broken"][0]["why"]

    def test_a_cron_row_is_never_executed(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """Firing a schedule has effects no deadline bounds, so the pair is only parsed.

        The proof is a command that would leave a file behind: after a run that
        reports the row as holding, the file must be absent.
        """
        db = tmp_path / "findings.db"
        witness = tmp_path / "cron-fired"
        script = tmp_path / "cron_body.py"
        script.write_text(
            f"open({str(witness)!r}, 'w').write('fired')\n",
            encoding="utf-8",
        )
        a_golden_path(
            ledger_mod,
            db,
            kind="cron",
            command=f"17 3 * * * :: {sys.executable} {script}",
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_HOLDS, result.stderr
        assert not witness.exists()


class TestHoldsIsUnreachableWhileAnythingIsUnverifiable:
    def test_an_unreadable_deny_fence_makes_every_shell_row_unverifiable(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """A fence that cannot be read is not a fence that agreed.

        This is the case that silently ships a broken tool: the probe fails, the
        shell rows go unchecked, and a script that treated "no refusal found" as
        "permitted" would report 0 having classified nothing.
        """
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="gh pr view 1 --json state")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path, available=False))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        body = payload(result)
        assert body["verdict"] == "unverifiable"
        assert body["broken"] == []
        assert "not importable" in body["unverifiable"][0]["why"]

    def test_a_declared_flow_is_unverifiable_not_ignored(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """An MCP tool has no command line, and skipping it would fake a pass."""
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, kind="flow", command="mcp::monitor_start")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        body = payload(result)
        assert body["unverifiable"][0]["command_or_flow"] == "mcp::monitor_start"
        assert "a human has to exercise it" in body["unverifiable"][0]["why"]

    def test_a_flow_that_never_ran_is_unverifiable_not_broken(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """A missing program did not stop working -- it was never there.

        Reading a launch failure as a broken golden path would blame the fix for a
        typo in the corpus.
        """
        db = tmp_path / "findings.db"
        a_golden_path(
            ledger_mod, db, kind="flow", command=str(tmp_path / "definitely-not-a-program")
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        assert "could not be started" in payload(result)["unverifiable"][0]["why"]

    def test_a_broken_row_outranks_an_unverifiable_one(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """30 beats 20 because it is the actionable verdict, and both are reported."""
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, kind="flow", command="mcp::autonudge_stop")
        failing = tmp_path / "failing_flow.py"
        failing.write_text("import sys\nsys.exit(4)\n", encoding="utf-8")
        a_golden_path(ledger_mod, db, kind="flow", command=f"{sys.executable} {failing}")
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=classifier(tmp_path))
        assert result.returncode == EXIT_BROKEN, result.stderr
        body = payload(result)
        assert body["broken"] and body["unverifiable"]

    def test_a_probe_that_answers_about_only_some_commands_is_unverifiable(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """A partial answer is not a verdict about the rows it skipped."""
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="git status --porcelain")
        a_golden_path(ledger_mod, db, command="git rev-parse HEAD")
        partial = tmp_path / "partial_classifier.py"
        partial.write_text(
            "import json\nimport sys\n\n"
            'request = json.loads(sys.stdin.read() or "{}")\n'
            'first = (request.get("commands") or [])[:1]\n'
            'json.dump({"available": True, "results": '
            '[{"command": c, "reason": None} for c in first]}, sys.stdout)\n',
            encoding="utf-8",
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=[sys.executable, str(partial)])
        assert result.returncode == EXIT_UNVERIFIABLE, result.stderr
        assert "skipped" in payload(result)["unverifiable"][0]["why"]


class TestThePlatformFilterIsBothWays:
    def test_a_windows_row_is_not_checked_on_posix(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """Lock-in guard, half one. A Windows-only shape reported broken on Linux
        would reject a fix for a host it was never checked on."""
        db = tmp_path / "findings.db"
        a_golden_path(
            ledger_mod,
            db,
            command=".venv\\Scripts\\python.exe -m pytest REFUSE-ME",
            platform="windows",
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(
            staged, db, worktree, classifier_cmd=classifier(tmp_path, "REFUSE-ME"), platform="posix"
        )
        assert result.returncode == EXIT_HOLDS, result.stderr
        assert payload(result)["golden_paths_checked"] == 0

    def test_a_posix_row_is_not_checked_on_windows(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        """Lock-in guard, half two, and it is not symmetry for its own sake: the
        corpus is checked on both hosts, so each host must ignore the other's rows
        rather than only Linux ignoring Windows."""
        db = tmp_path / "findings.db"
        a_golden_path(
            ledger_mod, db, command=".venv/bin/python -m pytest REFUSE-ME", platform="posix"
        )
        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(
            staged,
            db,
            worktree,
            classifier_cmd=classifier(tmp_path, "REFUSE-ME"),
            platform="windows",
        )
        assert result.returncode == EXIT_HOLDS, result.stderr
        assert payload(result)["golden_paths_checked"] == 0

    def test_an_any_row_is_checked_on_both(
        self, staged: Path, ledger_mod, tmp_path: Path, worktree: Path
    ) -> None:
        db = tmp_path / "findings.db"
        a_golden_path(ledger_mod, db, command="gh pr view 1 REFUSE-ME", platform="any")
        install_verifier(staged, VERIFIER_REJECTED)
        for platform in ("posix", "windows"):
            result = run_fix(
                staged,
                db,
                worktree,
                classifier_cmd=classifier(tmp_path, "REFUSE-ME"),
                platform=platform,
            )
            assert result.returncode == EXIT_BROKEN, (platform, result.stderr)
            assert payload(result)["platform"] == platform

    def test_auto_never_resolves_to_any(self, mod) -> None:
        """``any`` is a property of a ROW, not a host. Resolving to it would select
        the ``any`` rows and silently drop every platform-specific one."""
        assert mod.resolve_platform("auto") in ("posix", "windows")
        assert mod.resolve_platform("posix") == "posix"
        assert mod.resolve_platform("windows") == "windows"


class TestTheSchemaMigratesUnderALiveLedger:
    def test_a_database_created_before_golden_paths_is_readable(
        self, staged: Path, tmp_path: Path, worktree: Path
    ) -> None:
        """A target audited before this table existed must keep working.

        Built the way a v1 ledger really exists -- the four original tables and a
        version row saying 1 -- then opened by the current code, which must add the
        table, bump the version, and answer a golden-path query rather than
        raising.
        """
        import sqlite3

        db = tmp_path / "legacy.db"
        conn = sqlite3.connect(str(db))
        conn.executescript("""
            CREATE TABLE schema_version (version INTEGER NOT NULL);
            INSERT INTO schema_version (version) VALUES (1);
            CREATE TABLE findings (
                id INTEGER PRIMARY KEY AUTOINCREMENT, surface TEXT NOT NULL,
                severity TEXT NOT NULL, title TEXT NOT NULL, paths TEXT NOT NULL,
                poc TEXT, auditor_verdict TEXT, verifier_verdict TEXT,
                final_verdict TEXT, status TEXT NOT NULL, created TEXT NOT NULL,
                round_id TEXT
            );
            INSERT INTO findings (surface, severity, title, paths, status, created)
                VALUES ('security', 'High', 'legacy', '[]', 'open', '2000-01-01T00:00:00+00:00');
            """)
        conn.commit()
        conn.close()

        install_verifier(staged, VERIFIER_REJECTED)
        result = run_fix(staged, db, worktree, classifier_cmd=[sys.executable, "-c", "pass"])
        assert result.returncode == EXIT_HOLDS, result.stderr
        assert payload(result)["golden_paths_checked"] == 0
        # The pre-existing row survived the migration: this is additive, not a
        # rebuild.
        conn = sqlite3.connect(str(db))
        try:
            assert conn.execute("SELECT COUNT(*) FROM findings").fetchone()[0] == 1
            assert conn.execute("SELECT version FROM schema_version").fetchone()[0] == 2
        finally:
            conn.close()


class TestInvalidInputIsTwoNotAVerdict:
    @pytest.mark.parametrize(
        "extra",
        [
            pytest.param(["--timeout", "0"], id="nonpositive-timeout"),
            pytest.param(["--classifier-cmd", "not-json"], id="unparseable-classifier"),
            pytest.param(["--classifier-cmd", "[]"], id="empty-classifier"),
        ],
    )
    def test_a_bad_argument_is_two(
        self, staged: Path, tmp_path: Path, worktree: Path, extra: list[str]
    ) -> None:
        install_verifier(staged, VERIFIER_REJECTED)
        result = subprocess.run(
            [
                sys.executable,
                str(staged / "verify_fix.py"),
                "--db",
                str(tmp_path / "findings.db"),
                "--finding-id",
                "1",
                "--worktree",
                str(worktree),
                *extra,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
        assert result.returncode == EXIT_INVALID, result.stdout

    def test_a_worktree_that_is_not_a_directory_is_two(self, staged: Path, tmp_path: Path) -> None:
        install_verifier(staged, VERIFIER_REJECTED)
        result = subprocess.run(
            [
                sys.executable,
                str(staged / "verify_fix.py"),
                "--finding-id",
                "1",
                "--worktree",
                str(tmp_path / "nowhere"),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
        )
        assert result.returncode == EXIT_INVALID
        assert "not a directory" in result.stderr


class TestTheCronValidatorParsesAndNeverRuns:
    @pytest.mark.parametrize(
        "text",
        [
            "17 3 * * * :: gh pr list",
            "0 9 * * 1-5 :: gh pr list --json number,title",
            "*/5 * * * * :: git fetch origin main",
            "every:300 :: rotation-check",
        ],
    )
    def test_a_valid_pair_parses(self, mod, text: str) -> None:
        assert mod.cron_problem(text) is None

    @pytest.mark.parametrize(
        "text, fragment",
        [
            pytest.param("17 3 * * * gh pr list", "separator", id="no-separator"),
            pytest.param(":: gh pr list", "empty schedule", id="no-schedule"),
            pytest.param("17 3 * * * ::   ", "empty command", id="no-command"),
            pytest.param("17 3 * * :: gh pr list", "5 schedule fields", id="four-fields"),
            pytest.param("17 3 * * $(x) :: gh pr list", "unparseable schedule", id="bad-field"),
            pytest.param("every:0 :: x", "5 schedule fields", id="zero-interval"),
            pytest.param('17 3 * * * :: gh pr list "', "unparseable command", id="bad-quoting"),
        ],
    )
    def test_a_malformed_pair_is_named(self, mod, text: str, fragment: str) -> None:
        problem = mod.cron_problem(text)
        assert problem is not None
        assert fragment in problem


class TestTheVerdictLadderIsDeclaredOnce:
    def test_the_fold_returns_the_strongest_verdict(self, mod) -> None:
        assert mod.fold_verdict("holds") == "holds"
        assert mod.fold_verdict("holds", "unverifiable") == "unverifiable"
        assert mod.fold_verdict("holds", "unverifiable", "broken") == "broken"
        assert mod.fold_verdict("holds", "unverifiable", "broken", "reproduces") == "reproduces"

    def test_every_verdict_has_an_exit_code_and_they_are_distinct(self, mod) -> None:
        assert set(mod.VERDICT_PRECEDENCE) == set(mod.EXIT_CODES)
        codes = list(mod.EXIT_CODES.values())
        assert sorted(codes) == sorted(set(codes))
        # The one code that must never be reachable from a non-holding verdict.
        assert mod.EXIT_CODES["holds"] == 0
        assert 0 not in [code for name, code in mod.EXIT_CODES.items() if name != "holds"]


class TestTheShippedCorpusIsALiveGate:
    """The corpus is only worth something if the real fence agrees with it.

    Every other class here stubs the classifier so a refusal can be arranged. This
    one does the opposite and asks the REAL ``is_denied`` about every shipped
    ``shell`` row, which is the assertion the corpus exists to make: a change to
    the deny fence that eats one of these operations fails here, at PR time,
    instead of in a maintainer's terminal a week later.
    """

    @pytest.fixture(scope="class")
    def rows(self, request) -> list[dict]:
        ledger_mod = load_skill_script("security_conductor_ledger_for_corpus", LEDGER)
        return ledger_mod.load_golden_path_corpus(SEED.read_text(encoding="utf-8"))

    def test_the_seed_carries_a_real_corpus(self, rows: list[dict]) -> None:
        assert 25 <= len(rows) <= 40, len(rows)
        assert all(row["reason"] for row in rows)
        kinds = {row["kind"] for row in rows}
        assert kinds == {"shell", "flow", "cron"}
        # Both halves of the lock-in guard are present, or the corpus asserts
        # nothing about the second failure mode it exists for.
        platforms = {row["platform"] for row in rows}
        assert {"posix", "windows"} <= platforms

    def test_every_shipped_shell_row_is_permitted_by_the_real_deny_fence(
        self, rows: list[dict]
    ) -> None:
        from kiro_crew.security import is_denied

        refused = {
            row["command_or_flow"]: is_denied(row["command_or_flow"])
            for row in rows
            if row["kind"] == "shell"
        }
        broken = {command: reason for command, reason in refused.items() if reason is not None}
        assert not broken, json.dumps(broken, indent=2, sort_keys=True)

    def test_every_shipped_cron_row_parses(self, mod, rows: list[dict]) -> None:
        problems = {
            row["command_or_flow"]: mod.cron_problem(row["command_or_flow"])
            for row in rows
            if row["kind"] == "cron"
        }
        assert not {k: v for k, v in problems.items() if v is not None}, problems

    def test_the_seed_imports_idempotently(self, ledger_mod, tmp_path: Path) -> None:
        db = tmp_path / "seeded.db"
        conn = ledger_mod.connect(db)
        try:
            ledger_mod.init_schema(conn)
            rows = ledger_mod.load_golden_path_corpus(SEED.read_text(encoding="utf-8"))
            first = ledger_mod.import_golden_paths(conn, rows, approved_by="tester")
            second = ledger_mod.import_golden_paths(conn, rows, approved_by="tester")
        finally:
            conn.close()
        assert first["imported"] == len(rows)
        assert second == {"imported": 0, "skipped": len(rows), "total": len(rows)}

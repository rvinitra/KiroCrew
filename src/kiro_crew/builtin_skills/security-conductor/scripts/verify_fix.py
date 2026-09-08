#!/usr/bin/env python3
"""Check that a security fix killed the finding and broke nothing legitimate.

A fix that makes the proof of concept stop reproducing has done only half a job.
The other half is the half a security change actually gets rejected for: the deny
fence grew a rule that also refuses ``gh pr view --json``, or a path guard now
rejects the operator's own worktree, and the tool the fix protected became one
nobody can use. The RFC's amendment names the two failure modes this script
exists to catch -- **the tool became unusable** and **platform lock-in** -- and
gives them a corpus: the ``golden_paths`` table, the legitimate operations every
security fix must keep alive.

So this is a two-step gate, and both steps must hold::

    python3 verify_fix.py [--db PATH] --finding-id N --worktree DIR \\
        [--platform auto|posix|windows] [--timeout SECONDS]

1. ``verify_finding.py`` re-runs the proof. The fix holds ONLY when that pass
   comes back ``rejected`` -- the proof does not reproduce any more. ``confirmed`` means
   the fix did not land, and anything else means the question was not settled.
2. Every ACTIVE golden path whose platform matches the host is re-checked, by a
   method that depends on its kind. All of them must hold.

Exit codes, which are the interface::

    0   holds        -- the proof is dead and every golden path still works
    10  reproduces   -- the proof still reproduces; the fix did not land
    30  broken       -- at least one golden path stopped working (the rows are
                        printed); this is the "tool became unusable" rejection
    20  unverifiable -- something could not be settled here: the verifier is
                        absent, the deny classifier is not importable, a flow
                        could not be run
    2   invalid input -- a bad argument, or a worktree that is not a checkout

Precedence when several apply is ``10 > 30 > 20 > 0``, and it is not arbitrary.
A proof that still reproduces means the fix does not exist yet, so what it did to
the golden paths is not yet a question. A broken golden path outranks an
unverifiable one because it is the actionable verdict: a named row, a named
reason, something to change. And **0 is unreachable while anything is
unverifiable** -- an unchecked golden path is not a passing one, and reporting it
as one is exactly how a fix that broke the tool ships green.

stdout is one JSON object. ``broken`` and ``unverifiable`` are lists of rows, so
the reviewer holding a 30 or a 20 gets the specific operations rather than a
count.

How each kind is checked
------------------------

``shell``
    Classified by the deny fence, **never executed**. The claim a shell row makes
    is "the fence must not refuse this", so running it would answer a different
    question and would run a command in a checkout for no reason. The
    classification is read from ``kiro_crew.security.is_denied``, which returns a
    refusal reason or ``None`` -- a pure read with no side effect on the decision.
    It is called in a CHILD process with the worktree's own ``src`` ahead of
    everything on ``PYTHONPATH``, because the point is to classify against the
    FIXED code: importing it in this process would bind whatever copy of the
    package the interpreter already loaded, which for a test runner inside the
    repository is the unfixed one. When the import fails, every shell row is
    ``unverifiable`` and the verdict is 20 -- a fence that cannot be read is not a
    fence that agreed.

``flow``
    Run as a command, under the same containment ``verify_finding.py`` gives a
    proof: no shell, a closed environment allowlist, ``HOME`` and the scratch
    directory pointed at the worktree, stdin and both output streams detached,
    and a deadline. Exit 0 holds. A launch failure, a 126/127, or a deadline is
    ``unverifiable`` -- the flow did not run, which is not evidence either way.
    Any other nonzero exit is BROKEN: the operation ran and stopped working.

    A flow whose text carries a ``<scheme>::`` prefix is a DECLARED flow this
    script cannot execute -- ``mcp::monitor_start`` names an MCP tool with no
    command line, and ``harness::`` names a CI harness whose run is measured in
    tens of minutes. Those are reported ``unverifiable`` and listed by name
    rather than being silently dropped, which is the whole reason the verdict
    ladder has a 20 in it: the reviewer is told exactly which operations a human
    still has to try.

``cron``
    Validated as a parseable ``SCHEDULE :: COMMAND`` pair and **never executed**,
    because firing a schedule has effects outside the worktree that no deadline
    bounds. A pair that stops parsing is BROKEN.

Trust boundary. Same as ``verify_finding.py``'s, and for the same reason: the
golden-path corpus is the OPERATOR'S, approved through ``ledger.py`` by a named
human, so it is trusted input, while the target checkout is the operator's own
code that they chose to run as themselves. The containment is the disposable
worktree plus the deadline, not a sandbox.

Reads one SQLite file through ``ledger.py`` and runs subprocesses. No network of
its own.
"""

from __future__ import annotations

import argparse
import importlib.machinery
import importlib.util
import json
import os
import re
import shlex
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

HOLDS = "holds"
REPRODUCES = "reproduces"
BROKEN = "broken"
UNVERIFIABLE = "unverifiable"

EXIT_CODES = {HOLDS: 0, REPRODUCES: 10, UNVERIFIABLE: 20, BROKEN: 30}
EXIT_INVALID = 2

#: Strongest verdict first. :func:`fold_verdict` walks this, so the precedence
#: documented in the module docstring lives in ONE place and cannot drift from a
#: chain of ``if`` statements that happen to be written in some order.
VERDICT_PRECEDENCE = (REPRODUCES, BROKEN, UNVERIFIABLE, HOLDS)

DEFAULT_TIMEOUT = 120
#: How long to wait for a killed flow to be reaped. Bounded for the reason
#: ``verify_finding.py`` bounds its own: the verdict is already decided, so the
#: only thing at stake is a leftover process, and blocking the conductor forever
#: on an unkillable child is worse than that.
REAP_SECONDS = 5

#: ``verify_finding.py``'s exit codes, which are its interface. Mapped rather than
#: re-derived: this script reads that contract and must not grow a second opinion
#: about what 10 means.
VERIFIER_CONFIRMED = 0
VERIFIER_REJECTED = 10
VERIFIER_NEEDS_HUMAN = 20
VERIFIER_INVALID = 2

#: A launch failure wearing an exit status. 127 is "command not found" and 126 is
#: "found but not executable" in every common shell and in CPython's own spawn
#: path, so neither can be read as the flow having run and failed.
LAUNCH_FAILURE_STATUSES = (126, 127)

#: A declared flow: a scheme, two colons, and a name. Anchored at the start so a
#: ``::`` inside a real command's argument (a pytest nodeid, a Windows drive-ish
#: path) is not mistaken for one.
_SCHEME_RE = re.compile(r"^([a-z][a-z0-9_-]*)::(.+)$", re.IGNORECASE)

#: One field of a 5-field cron expression. Deliberately a CHARSET check rather
#: than a grammar: the schedule dialect belongs to whatever fires the cron, and a
#: validator that re-implements it here would reject a valid expression the day
#: that dialect grows a form. What this rules out is the shape that cannot be a
#: schedule at all -- an empty field, a quote, a shell operator.
_CRON_FIELD_RE = re.compile(r"^[0-9*,/\-A-Za-z]+$")
#: The interval spelling ``cron_add`` accepts beside an expression.
_CRON_EVERY_RE = re.compile(r"^every:([1-9][0-9]*)$", re.IGNORECASE)
CRON_SEPARATOR = "::"


class _NoBytecodeSourceLoader(importlib.machinery.SourceFileLoader):
    """Load shipped source normally while suppressing cache writes."""

    def get_code(self, fullname: str) -> Any:
        path = self.get_filename(fullname)
        source = self.get_data(path)
        return self.source_to_code(source, path)

    def set_data(self, path: str, data: Any, *, _mode: int = 0o666) -> None:
        return None


def script_dir() -> Path:
    return Path(os.path.dirname(os.path.abspath(__file__)))


def load_ledger() -> Any:
    """Load the sibling ledger without cwd, sys.path, or bytecode side effects.

    Mirrors ``verify_finding.py``: a skill's scripts are synced out of the package
    tree and run as bare files, so ``ledger`` is a file beside this one rather
    than an importable module, and importing it the ordinary way would drop a
    ``__pycache__`` entry into the checked-out tree.
    """
    path = str(script_dir() / "ledger.py")
    name = "_security_conductor_ledger_for_fix"
    loader = _NoBytecodeSourceLoader(name, path)
    spec = importlib.util.spec_from_loader(name, loader)
    if spec is None:  # pragma: no cover - defensive
        raise RuntimeError("cannot import security conductor ledger: " + path)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def resolve_platform(requested: str) -> str:
    """The concrete host name a golden path's ``platform`` column is matched to.

    Never returns ``any``: ``any`` is a property of a ROW (it applies everywhere),
    not a host a check could run on, so accepting it as the filter would select
    the ``any`` rows and silently drop every platform-specific one.
    """
    if requested == "auto":
        return "windows" if os.name == "nt" else "posix"
    return requested


def child_env(worktree: Path, *, extra: dict[str, str] | None = None) -> dict[str, str]:
    """The closed environment a flow or the classifier probe runs in.

    Inherits nothing but ``PATH`` (a command needs an interpreter), the locale,
    and the names a Windows process needs to start at all. ``HOME`` and every
    scratch-directory spelling point AT the worktree, so a ``~``-relative path or
    a tool's cache lands inside the throwaway checkout instead of the operator's
    real home. Kept deliberately identical in shape to ``verify_finding.py``'s,
    because "the same containment as the proof" is the promise, and two
    almost-equal allowlists would be two things to keep aligned.
    """
    env = {
        "PATH": os.environ.get("PATH", os.defpath),
        "HOME": str(worktree),
        "TMPDIR": str(worktree),
        # Windows spells the scratch directory ``TEMP``/``TMP``, and that is what
        # ``tempfile`` reads there, so pinning ``TMPDIR`` alone would put a
        # child's scratch files outside the one place the blast radius is bounded.
        "TEMP": str(worktree),
        "TMP": str(worktree),
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        "LC_ALL": os.environ.get("LC_ALL", "C.UTF-8"),
    }
    # Three names Windows needs in order to start a process at all, and
    # withholding them hardens nothing: ``SYSTEMROOT`` is where CPython finds the
    # crypto provider it seeds ``os.urandom`` from, and ``PATHEXT``/``COMSPEC``
    # are how a bare program name resolves there. Forwarded only when the host
    # defines them, so on POSIX this loop adds nothing rather than branching.
    for name in ("SYSTEMROOT", "PATHEXT", "COMSPEC"):
        value = os.environ.get(name)
        if value is not None:
            env[name] = value
    if extra:
        env.update(extra)
    return env


def _new_group_kwargs() -> dict[str, Any]:
    """Put a child in its own process group, in whichever spelling the host has.

    Stricter than ``verify_finding.py``'s direct-child reap, and the difference is
    the input. A proof is one adversarial command whose grandchildren are the
    operator's own machine's problem; a golden-path flow is a LEGITIMATE developer
    operation, and the ones worth pinning are exactly the ones that start
    something (a server, a gateway, a test harness). A flow that hits the deadline
    while holding a port would then hold it for the rest of the audit and fail
    every later flow that needs it -- which reads as a broken golden path caused
    by the verifier rather than by the fix.
    """
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        return {"creationflags": flags} if flags else {}
    return {"start_new_session": True}


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    """Kill a flow's whole process group, then the flow, then wait once.

    The group kill is best effort: ``os.killpg`` is POSIX-only, and on either
    platform the group may already be gone, which raises rather than returning.
    The direct kill afterwards is what makes the outcome unconditional, so an
    unavailable group kill degrades to ``verify_finding.py``'s behaviour instead
    of leaving the child alive.
    """
    killpg = getattr(os, "killpg", None)
    if killpg is not None:
        try:
            killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (OSError, AttributeError):
            pass
    try:
        process.kill()
    except OSError:  # pragma: no cover - already reaped
        pass
    try:
        process.wait(timeout=REAP_SECONDS)
    except subprocess.TimeoutExpired:
        pass


def run_child(
    argv: list[str],
    worktree: Path,
    timeout: int,
    *,
    env_extra: dict[str, str] | None = None,
    stdin_text: str | None = None,
    capture: bool = False,
) -> tuple[str, int, str]:
    """Run one child. Returns ``(outcome, returncode, text)``.

    ``outcome`` is ``ran``, ``timeout`` or ``launch-failed``, so a caller never
    has to read a sentinel return code as one of three different things -- which
    is the mistake ``verify_finding.py`` documents at length for proofs and which
    matters here too: exit 1 from a flow is a real failure, not a launch error.

    Output is captured ONLY when the caller needs to parse it (the classifier
    probe). A flow's output is discarded through ``DEVNULL`` rather than a pipe,
    because nothing reads it and a flow that prints without stopping would
    otherwise buffer its whole stream in this process before any verdict is
    written.
    """
    pipe = subprocess.PIPE if capture else subprocess.DEVNULL
    try:
        process = subprocess.Popen(
            argv,
            cwd=str(worktree),
            env=child_env(worktree, extra=env_extra),
            stdout=pipe,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
            **_new_group_kwargs(),
        )
    except OSError as exc:
        # A missing interpreter or a mistyped program raises here rather than
        # returning a status, and letting it propagate would end the run outside
        # the documented exit contract with no verdict written at all.
        return "launch-failed", 0, str(exc)
    try:
        payload = None if stdin_text is None else stdin_text.encode("utf-8")
        out, _ = process.communicate(input=payload, timeout=timeout)
    except subprocess.TimeoutExpired:
        _terminate_group(process)
        return "timeout", 0, ""
    text = "" if not out else out.decode("utf-8", errors="replace")
    return "ran", int(process.returncode), text


# --------------------------------------------------------------------- step 1


def verifier_path() -> Path:
    return script_dir() / "verify_finding.py"


def run_verifier(
    *, db: Path | None, finding_id: int, worktree: Path, timeout: int
) -> tuple[str, str, int]:
    """Re-run the proof through ``verify_finding.py``. ``(verdict, reason, exit)``.

    The sibling is invoked BY PATH rather than imported, and its exit status is
    the whole contract this reads. That keeps one implementation of what
    ``confirmed`` means: copying its judgement here would give the harness two
    verifiers that can disagree about the same proof, and the one a reviewer reads
    would be whichever they happened to run.

    An ABSENT sibling is ``unverifiable``, not an error and never a pass. The
    scripts land one at a time, so "not installed yet" is a real state, and the
    only safe reading of it is that nothing was checked.
    """
    script = verifier_path()
    if not script.is_file():
        return (
            UNVERIFIABLE,
            f"verify_finding.py is not installed beside this script ({script});"
            " the proof was not re-run, so nothing about this fix is settled",
            0,
        )
    argv = [
        sys.executable,
        str(script),
        "--finding-id",
        str(finding_id),
        "--worktree",
        str(worktree),
        "--timeout",
        str(timeout),
    ]
    if db is not None:
        argv[2:2] = ["--db", str(db)]
    # The verifier's own deadline bounds the proof; this outer one only bounds the
    # verifier's own bookkeeping around it, so it gets room past the inner one
    # rather than racing it and reporting a timeout the proof did not cause.
    outcome, code, _ = run_child(argv, worktree, timeout + REAP_SECONDS + 30)
    if outcome != "ran":
        return UNVERIFIABLE, f"verify_finding.py did not complete ({outcome})", 0
    if code == VERIFIER_REJECTED:
        return HOLDS, "the proof no longer reproduces", code
    if code == VERIFIER_CONFIRMED:
        return REPRODUCES, "the proof still reproduces; the fix did not land", code
    if code == VERIFIER_INVALID:
        return "invalid", "verify_finding.py rejected its input", code
    if code == VERIFIER_NEEDS_HUMAN:
        return UNVERIFIABLE, "verify_finding.py could not settle the proof", code
    return UNVERIFIABLE, f"verify_finding.py exited {code}, which is not in its contract", code


# ------------------------------------------------------- step 2: shell rows


#: The program the classifier probe is, spelled as an argv rather than as source
#: text: the probe re-enters THIS script in ``--classify-stdin`` mode. An inline
#: ``-c`` program that imported the product would be the same import wearing a
#: less inspectable shape, and a re-entry keeps the probe's code in the file a
#: reviewer is already reading.
CLASSIFY_FLAG = "--classify-stdin"


def classifier_python(worktree: Path) -> str:
    """The interpreter the fence is read with: the worktree's own, when it has one.

    A checkout under review may pin dependencies the running interpreter does not
    have, and the fence has to be imported the way the fixed tree would import it.
    Falls back to this interpreter, which is correct whenever the package imports
    from source alone.
    """
    candidates = (
        worktree / ".venv" / "bin" / "python",
        worktree / ".venv" / "Scripts" / "python.exe",
    )
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return sys.executable


def classify_commands(
    commands: list[str], worktree: Path, timeout: int, *, override: list[str] | None
) -> tuple[bool, dict[str, str | None], str]:
    """Ask the deny fence about each command. ``(available, {cmd: reason}, note)``.

    ``reason`` is ``None`` for a command the fence permits, and a refusal string
    for one it denies -- which is ``is_denied``'s own return shape, carried
    through rather than reduced to a boolean, because the reason is what tells the
    reviewer WHICH rule ate their golden path.

    ``available`` false means the fence could not be read at all, which every
    caller must turn into ``unverifiable``.
    """
    if not commands:
        return True, {}, ""
    argv = list(override) if override else [classifier_python(worktree), __file__, CLASSIFY_FLAG]
    payload = json.dumps({"commands": commands})
    outcome, code, text = run_child(
        argv,
        worktree,
        timeout,
        env_extra={"PYTHONPATH": str(worktree / "src")},
        stdin_text=payload,
        capture=True,
    )
    if outcome != "ran":
        return False, {}, f"the deny classifier probe did not complete ({outcome})"
    if code != 0:
        return False, {}, f"the deny classifier probe exited {code}"
    try:
        parsed = json.loads(text.strip().splitlines()[-1]) if text.strip() else {}
    except (ValueError, IndexError):
        return False, {}, "the deny classifier probe printed no JSON verdict"
    if not parsed.get("available"):
        return False, {}, str(parsed.get("error") or "the deny classifier is not importable")
    results: dict[str, str | None] = {}
    for item in parsed.get("results") or []:
        results[str(item.get("command"))] = item.get("reason")
    missing = [command for command in commands if command not in results]
    if missing:
        # A probe that answered about only some commands is not a fence that
        # permitted the rest. Refusing the whole batch keeps the unanswered rows
        # out of the passing set.
        return False, {}, f"the deny classifier probe skipped {len(missing)} command(s)"
    return True, results, ""


def classify_stdin(stream: Any, out: Any) -> int:
    """The probe, running inside the child: classify stdin's commands, print JSON.

    Imports the product's fence HERE, in a process whose ``PYTHONPATH`` leads the
    worktree, and reports an unavailable import as data rather than as a crash --
    the parent has a verdict for "the fence cannot be read" and none for a
    traceback.
    """
    try:
        request = json.loads(stream.read() or "{}")
    except ValueError as exc:
        json.dump({"available": False, "error": f"unreadable request: {exc}"}, out)
        out.write("\n")
        return 0
    commands = [str(item) for item in (request.get("commands") or [])]
    try:
        from kiro_crew.security import is_denied  # type: ignore[import-not-found]
    except Exception as exc:  # noqa: BLE001 - any import failure is the same verdict
        json.dump({"available": False, "error": f"kiro_crew.security: {exc}"}, out)
        out.write("\n")
        return 0
    results = []
    for command in commands:
        try:
            reason = is_denied(command)
        except Exception as exc:  # noqa: BLE001 - a raising classifier is unreadable, not a pass
            json.dump({"available": False, "error": f"is_denied raised: {exc}"}, out)
            out.write("\n")
            return 0
        results.append({"command": command, "reason": None if reason is None else str(reason)})
    json.dump({"available": True, "results": results}, out)
    out.write("\n")
    return 0


# -------------------------------------------------------- step 2: cron rows


def cron_problem(text: str) -> str | None:
    """Why a ``SCHEDULE :: COMMAND`` pair does not parse, or ``None`` when it does.

    Never executed, and that is not a limitation to lift later: firing a schedule
    has effects outside the worktree that no deadline bounds, so what a cron row
    can honestly assert is that its pair is still a pair.
    """
    if CRON_SEPARATOR not in text:
        return f"missing the {CRON_SEPARATOR!r} separator between schedule and command"
    schedule, _, command = text.partition(CRON_SEPARATOR)
    schedule = schedule.strip()
    command = command.strip()
    if not schedule:
        return "empty schedule"
    if not command:
        return "empty command"
    if not _CRON_EVERY_RE.match(schedule):
        fields = schedule.split()
        if len(fields) != 5:
            return f"expected 5 schedule fields or 'every:SECONDS', got {len(fields)}"
        bad = [field for field in fields if not _CRON_FIELD_RE.match(field)]
        if bad:
            return f"unparseable schedule field(s): {', '.join(bad)}"
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        return f"unparseable command: {exc}"
    if not argv:
        return "command splits to nothing"
    return None


# -------------------------------------------------------- step 2: the check


def check_golden_paths(
    rows: list[Any], worktree: Path, timeout: int, *, classifier_override: list[str] | None
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    """Re-check every row. ``(broken, unverifiable, checked)``.

    Each list entry names the row and why, because a reviewer holding a 30 needs
    the command to fix, not a count of how many broke.
    """
    broken: list[dict[str, Any]] = []
    unsettled: list[dict[str, Any]] = []

    def describe(row: Any, why: str) -> dict[str, Any]:
        return {
            "id": int(row["id"]),
            "kind": str(row["kind"]),
            "surface": str(row["surface"]),
            "platform": str(row["platform"]),
            "command_or_flow": str(row["command_or_flow"]),
            "reason": str(row["reason"]),
            "why": why,
        }

    shell_rows = [row for row in rows if str(row["kind"]) == "shell"]
    commands = sorted({str(row["command_or_flow"]) for row in shell_rows})
    available, verdicts, note = classify_commands(
        commands, worktree, timeout, override=classifier_override
    )
    for row in shell_rows:
        if not available:
            unsettled.append(describe(row, note))
            continue
        refusal = verdicts.get(str(row["command_or_flow"]))
        if refusal is not None:
            broken.append(describe(row, f"the deny fence refuses it: {refusal}"))

    for row in rows:
        kind = str(row["kind"])
        text = str(row["command_or_flow"])
        if kind == "cron":
            problem = cron_problem(text)
            if problem is not None:
                broken.append(describe(row, f"the schedule/command pair does not parse: {problem}"))
            continue
        if kind != "flow":
            continue
        scheme = _SCHEME_RE.match(text)
        if scheme is not None:
            unsettled.append(
                describe(
                    row,
                    f"a declared {scheme.group(1).lower()} flow has no command line here;"
                    " a human has to exercise it",
                )
            )
            continue
        try:
            argv = shlex.split(text)
        except ValueError as exc:
            broken.append(describe(row, f"the flow does not parse as a command: {exc}"))
            continue
        if not argv:
            broken.append(describe(row, "the flow splits to nothing"))
            continue
        outcome, code, detail = run_child(argv, worktree, timeout)
        if outcome == "timeout":
            unsettled.append(describe(row, f"the flow hit the {timeout}s deadline"))
        elif outcome == "launch-failed":
            unsettled.append(describe(row, f"the flow could not be started: {detail}"))
        elif code in LAUNCH_FAILURE_STATUSES:
            unsettled.append(describe(row, f"the flow exited {code}, which means it did not run"))
        elif code != 0:
            broken.append(describe(row, f"the flow exited {code}"))

    return broken, unsettled, len(rows)


def fold_verdict(*candidates: str) -> str:
    """The strongest verdict present, per :data:`VERDICT_PRECEDENCE`.

    One walk over a declared order rather than a chain of ``if`` statements, so
    the ladder documented in the module docstring is the ladder that runs. The
    property that matters is the last one: ``holds`` is reachable only when no
    stronger verdict is present at all.
    """
    for verdict in VERDICT_PRECEDENCE:
        if verdict in candidates:
            return verdict
    return HOLDS  # pragma: no cover - every caller passes at least one candidate


# ---------------------------------------------------------------------- CLI


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify a security fix and its golden paths")
    parser.add_argument("--db", default=None, help="ledger path (default: data home)")
    parser.add_argument("--finding-id", type=int, default=None)
    parser.add_argument("--worktree", default=None)
    parser.add_argument("--platform", default="auto", choices=("auto", "posix", "windows"))
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    # The seam the tests drive the fence through, and the reason it is a flag
    # rather than an environment variable: a test that has to set the environment
    # can leak it into every later child, and a golden-path check reading a stray
    # override would report a fence nobody configured.
    parser.add_argument(
        "--classifier-cmd",
        default=None,
        help="JSON argv answering the classifier probe protocol (testing seam)",
    )
    parser.add_argument(CLASSIFY_FLAG, action="store_true", dest="classify_stdin")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.classify_stdin:
        return classify_stdin(sys.stdin, sys.stdout)

    if args.finding_id is None or args.worktree is None:
        print("--finding-id and --worktree are both required", file=sys.stderr)
        return EXIT_INVALID
    if args.timeout <= 0:
        print("--timeout must be a positive number of seconds", file=sys.stderr)
        return EXIT_INVALID
    worktree = Path(args.worktree)
    if not worktree.is_dir():
        print(f"--worktree is not a directory: {worktree}", file=sys.stderr)
        return EXIT_INVALID
    override: list[str] | None = None
    if args.classifier_cmd:
        try:
            parsed = json.loads(args.classifier_cmd)
        except ValueError as exc:
            print(f"--classifier-cmd is not JSON: {exc}", file=sys.stderr)
            return EXIT_INVALID
        if not isinstance(parsed, list) or not parsed:
            print("--classifier-cmd must be a non-empty JSON array", file=sys.stderr)
            return EXIT_INVALID
        override = [str(item) for item in parsed]

    db = Path(args.db) if args.db else None
    poc_verdict, poc_reason, poc_exit = run_verifier(
        db=db, finding_id=args.finding_id, worktree=worktree, timeout=args.timeout
    )
    if poc_verdict == "invalid":
        print(poc_reason, file=sys.stderr)
        return EXIT_INVALID

    platform = resolve_platform(args.platform)
    ledger = load_ledger()
    conn = ledger.connect(db if db is not None else ledger.default_db_path())
    try:
        ledger.init_schema(conn)
        rows = ledger.active_golden_paths(conn, platform=platform)
    finally:
        conn.close()

    # The golden paths are re-checked even when the proof still reproduces. The
    # verdict does not change -- ``reproduces`` outranks everything -- but a fix
    # that failed AND broke three legitimate operations is one round of feedback
    # instead of two, and the second round would only be reached after the first
    # was fixed.
    broken, unsettled, checked = check_golden_paths(
        list(rows), worktree, args.timeout, classifier_override=override
    )

    verdict = fold_verdict(
        poc_verdict,
        *([BROKEN] if broken else []),
        *([UNVERIFIABLE] if unsettled else []),
    )
    payload = {
        "finding_id": args.finding_id,
        "verdict": verdict,
        "platform": platform,
        "poc": {"verdict": poc_verdict, "reason": poc_reason, "exit": poc_exit},
        "golden_paths_checked": checked,
        "broken": broken,
        "unverifiable": unsettled,
    }
    print(json.dumps(payload, sort_keys=True))
    for row in broken:
        print(f"broken golden path #{row['id']} ({row['kind']}): {row['why']}", file=sys.stderr)
    for row in unsettled:
        print(
            f"unverifiable golden path #{row['id']} ({row['kind']}): {row['why']}", file=sys.stderr
        )
    return EXIT_CODES[verdict]


if __name__ == "__main__":
    sys.exit(main())

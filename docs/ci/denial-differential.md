# The denial-differential gate

`Denial Differential` (`.github/workflows/denial-differential.yml`) fails a PR
that makes a deny rule refuse an operation the product depends on.

## Why it exists

A security fix is almost always a rule made stricter, and "stricter" has no upper
bound a reviewer can see. The author reads the pattern and the attack it now
catches. Nobody reads the set of ordinary commands that pattern *also* newly
matches — a read-only `gh` query, a feature-branch push, a chat start, an
installed cron. So the failure mode of a security fix is not a missed
vulnerability: it is a gate that quietly starts refusing legitimate work, and the
symptom surfaces days later as an agent that stopped working, reporting a pattern
instead of a cause.

That question is a bad fit for a model review, which would have to simulate a
17,000-line matcher over a corpus of commands nobody wrote down. It is a good fit
for a deterministic before/after classification.

## How it answers

`scripts/deny_diff.py` takes a base ref, a head ref, and a corpus of golden
paths. For each `shell` row whose platform matches the runner, it classifies the
command **twice** — once with the deny classifier as it exists at the base ref,
once as it exists at the head ref — and diffs the two verdicts:

| Base | Head | Verdict |
|---|---|---|
| allowed | refused | **regression** — fails the job |
| refused | allowed | loosening — reported, informational |
| same | same | unchanged — counted only |

A loosening does not fail, because loosening is what a revert or a
false-positive fix looks like.

Both sides are the **real** classifier: each ref is materialized with
`git archive` into its own directory, and a child process classifies against it
with `PYTHONPATH` pointed there. Three properties keep that honest:

- **The parent never imports the product.** The classifier is the thing under
  test, so importing it in the harness would pin the comparison to one side.
- **Each child proves which tree answered.** It re-reports the file
  `kiro_crew.security` resolved to and exits 2 when that sits outside the
  checkout it was given. Without the check, an installed copy of the package
  shadowing the path would serve *both* refs from one tree and every differential
  would come back empty — a false green with no symptom.
- **Each child is hermetic.** Every `KIROCREW_*` variable is stripped and
  `KIROCREW_HOME` is repointed at a throwaway directory, so the verdict depends
  on the checkout alone and the classifier's best-effort audit writes never reach
  a real security log.

Exit codes: `0` no regressions, `1` regressions, `2` corpus or ref error. A `2`
fails the job — a differential that could not run is not a pass.

## The corpus

Rows come from the security-conductor's golden-paths seed
(`src/kiro_crew/builtin_skills/security-conductor/golden-paths.seed.json`), each
naming an operation that is legitimate **by decision** plus the reason it is:

```json
{ "kind": "shell", "command_or_flow": "gh pr view 8014 --json state",
  "platform": "any", "reason": "Read-only PR status query." }
```

`kind` is `shell`, `flow` or `cron`; `platform` is `any`, `posix` or `windows`.
Only `shell` rows are classified here — a flow and a cron have no single command
line to hand a matcher — and the other two are reported as skipped rather than
dropped, so a corpus that is mostly unclassifiable says so instead of reporting a
confident zero.

Until the seed lands, the workflow falls back to `scripts/deny_diff_fixture.json`
and names in its report which corpus answered. The reason a row belongs in the
corpus is the reason a reviewer needs when the gate goes red, so a row without
one is not much use.

## Why a three-platform matrix

The rules read argv **shape**, and the tokenizer, the path fence and the
self-protection floor all behave differently on Windows. A Linux-only gate would
pass a tightening that breaks every Windows operator. That is the same class of
defect the [Cross-Platform Portability](ci-and-reviews.md) gate exists for and
cannot see, because that one reads added lines rather than behaviour.

Legs do not `fail-fast`: one platform's regression is not evidence about
another's, and a cancelled leg hides rows only that runner can produce.

## When it goes red

Read the job summary. Each listed row is an operation the corpus records as
legitimate that this change newly refuses, with the reason it is legitimate and
the refusal text the head classifier produced. Then either narrow the rule, or —
if the refusal is the point of the change — apply the **`deny-diff-approved`**
label *and* leave a PR comment naming every row it excuses.

The label moves the exit code, never the visibility: the job still runs, still
reports every row, and prints which rows the label is excusing. A row that is not
in the reviewer's comment is not covered by the label. The label does not excuse
an exit-2 error.

## Running it locally

```
python3 scripts/deny_diff.py --base origin/main --head HEAD \
    --corpus scripts/deny_diff_fixture.json
```

Add `--json` for machine-readable rows, or `--platform posix|windows` to classify
another platform's rows than the host's. Stdlib only, no install required.

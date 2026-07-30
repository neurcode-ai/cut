# Context Compiler V0 decision

Verdict: `KILL`

This is a technical experiment decision, not a release decision. The human
product gate was not run and remains pending.

## Decision integrity

The corpus was sealed and committed before compiler implementation. The first
complete observation produced a kill result. One evaluation-harness accounting
correction was then made: failed compilations were restored to the independent
oracle denominator, while format compatibility and unreviewed-upload gates were
separated from archive-generation failures. The compiler and corpus were not
changed between those runs.

No candidate-channel correction was used because the first observed median
reduction, 0.628x, was already below the preregistered 2.0x kill boundary.

## Frozen outcome

| Gate | Target | Actual | Result |
| --- | --- | --- | --- |
| Changed-hunk enclosing-symbol coverage | 100% | 77.4% | Fail |
| Provisional required-context recall | at least 90% | 73.1% | Fail |
| Median token reduction versus arm B | at least 3.0x across 15 tasks | 0.628x across 10 produced Shares | Fail |
| Compilation p50 | below 2,000 ms across 15 tasks | 300.853 ms across 13 completed plans | Fail: incomplete |
| Compilation p95 | below 5,000 ms across 15 tasks | 914.905 ms across 13 completed plans | Fail: incomplete |
| Maximum individual phase | at most 1,000 ms across 15 tasks | 835.178 ms across 13 completed plans | Fail: incomplete |
| Unreviewed sensitive upload | zero | zero; three local Shares blocked | Pass |
| Share Format changes | zero; cut 1 | zero files changed; all 10 produced Shares were cut 1 | Pass |
| CLI selection expressibility | 100% of emitted plans | 13 of 13 | Pass |
| Existing validator success | 15 of 15 | 10 of 15 | Fail |
| Exact normalized replay | 15 of 15 | 13 of 15 | Fail |
| Runtime LLM, embedding, index, AST, or network dependency | zero | zero | Pass |

Two tasks failed closed because their mandatory changed-symbol selections
exceeded the frozen 25,000-token estimate budget. Three more reached the
existing scanner and were blocked before local archive creation. Ten archives
were produced; every one validated and round-tripped through the existing cut 1
reader.

## Robustness

| Group | Recall | Symbol coverage | Median reduction | Validator passes |
| --- | ---: | ---: | ---: | ---: |
| Hono | 74.5% | 80.7% | 0.573x | 4/6 |
| Prettier | 84.8% | 100% | 1.690x | 3/4 |
| ESLint | 85.2% | 100% | 0.628x | 3/3 |
| Vitest | 53.5% | 46.4% | not measurable | 0/2 |
| Multi-file feature/fix | 87.5% | 100% | 0.628x | 5/6 |
| Public interface | 94.2% | 100% | 1.179x | 3/3 |
| Configuration/persistence | 53.2% | 46.4% | 2.499x | 1/3 |
| Security-adjacent | 87.0% | 100% | 0.573x | 1/2 |
| Rename/deletion | 17.4% | 0% | not measurable | 0/1 |

The dominant over-selection was 27 dependency, 9 test, and 8 consumer
selections with no independent-oracle contribution. Complete symbol excerpts
plus separate context halos frequently cost more than the complete changed-file
baseline. The dominant missing context was 26 implementation obligations from
the two budget failures, followed by the 15 deliberately unsupplied operational
evidence obligations. Twenty-eight review-reference facts remained uncertain
because the frozen regex could not prove a post-image symbol boundary.

## Architecture result

The package remained deterministic and local, used graph depth one, added no
runtime dependency, made no product model or network call, and emitted only
existing `path:start-end` selections. The CLI reused the existing capture,
scanner, airlock, archive, and validator. No Share Format source file changed.

Those compatibility successes do not rescue the experiment: the bounded regex
analysis and binary complete-symbol selection cannot simultaneously satisfy the
frozen recall, budget, and disclosure-reduction requirements on this corpus.

## Recommendation

Terminate Context Compiler V0 and do not release or proceed to developer
acceptance testing with this implementation. Any future attempt should be a new
preregistered experiment, not a correction to this result. It would need to
address conservative symbol-boundary fallback, marginal disclosure accounting
for overlapping excerpts and halos, and scanner-safe handling of public test
fixtures before optional dependency, consumer, or test expansion.

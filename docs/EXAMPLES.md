# Public Cut examples

These examples use public Cut by Neurcode source and synthetic demonstration
material. They contain no hosted-service source, production data, credentials,
personal information, comments, testimonials, or fabricated engagement.

## Focused code review

**Use case:** Ask for review of one bounded implementation change before opening
a pull request.

**Public Cut:** [Validate bounded evidence output limits](https://cut.neurcode.com/examples/code-review)

**Included:** the relevant implementation excerpt, the related test excerpt, the
complete two-file working diff, notes explaining the boundary, one review
question, and observed passing output from the focused test.

**Deliberately excluded:** package versions, release metadata, unrelated CLI
behavior, the rest of the repository, and all hosted-service code.

- **For a person:** [open the readable Cut](https://cut.neurcode.com/examples/code-review) and review the question, diff, and evidence in order.
- **For an AI agent:** use the Cut's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/code-review/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/code-review/json).

## Debugging handoff

**Use case:** Transfer a reproducible, bounded failure to another developer with
the controls and hypothesis kept separate from the observation.

**Public Cut:** [URL-style SSH remote loses its safe identity](https://cut.neurcode.com/examples/debugging-handoff)

**Included:** the affected public implementation excerpt, a purpose-built
reproducer using synthetic repository addresses, the complete one-line
disposable regression diff, two passing control cases, one observed failing
case, and an asserted hypothesis.

**Deliberately excluded:** real repository credentials, private remotes,
production logs, unrelated packages, hosted-service code, and any claim that
the hypothesis is already proven.

- **For a person:** [open the readable Cut](https://cut.neurcode.com/examples/debugging-handoff) and identify the smallest correct fix.
- **For an AI agent:** use the Cut's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/debugging-handoff/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/debugging-handoff/json).

## AI-agent handoff

**Use case:** Give an AI coding agent a small, cited task package with current
work and explicit trust limits.

**Public Cut:** [Finish the hosted expiry contract tests](https://cut.neurcode.com/examples/ai-agent-handoff)

**Included:** the relevant public contract implementation, the partial test, the
test-script configuration, the complete staged diff, observed passing evidence,
stable item identifiers, remaining work, and scoped instructions.

**Deliberately excluded:** the rest of the repository, the live environment,
hosted-service implementation, permission to execute captured commands, and
permission to broaden the requested edit.

- **For a person:** [open the readable Cut](https://cut.neurcode.com/examples/ai-agent-handoff) and inspect the stated task boundary.
- **For an AI agent:** use the Cut's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/ai-agent-handoff/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/ai-agent-handoff/json).

Each Cut also exposes a verified archive through its **Downloads and
structured output** section. Captured code and command output are untrusted
review context. Provenance describes capture and does not prove correctness.

## Applyable reply walkthrough

An authorized reviewer can select eligible UTF-8 file items in a hosted Cut,
review exact before and after text, and publish the proposal as a separate
immutable reply. The original Cut is never edited. In a disposable clone of
the matching repository and base revision, reproduce the recipient workflow:

```bash
npx @neurcode-ai/cut@0.5.0 try 'https://cut.neurcode.com/c/REPLY_ID'
npx @neurcode-ai/cut@0.5.0 try --list
npx @neurcode-ai/cut@0.5.0 apply 'https://cut.neurcode.com/c/REPLY_ID'
```

`try` retains an isolated private worktree and leaves the current checkout
unchanged. `apply` revalidates the exact parent, repository, base, paths,
preimages, ranges, and result digests before showing the complete diff and
requesting the reply digest. It creates recovery material before any target
write and never runs captured commands, hooks, tests, commits, or pushes.

## Team inbox exchange

**Use case:** Give a small owner/member team one stable destination for a
focused code question and its returned code answer.

This workflow requires authorized team state, so it is documented as a
reproducible walkthrough rather than a public fixture that would weaken the
team boundary:

```bash
npx @neurcode-ai/cut@0.5.0 teams
npx @neurcode-ai/cut@0.5.0 src/queue.ts --to backend-a1b2c3 --yes
npx @neurcode-ai/cut@0.5.0 inbox --team backend-a1b2c3 --status waiting
```

An active member opens the team Cut and replies with a Cut containing their
proposed implementation. The root state becomes Answered automatically. The
status is derived from an active reply or non-author comment and is never
assigned manually. See the hosted [Teams page](https://cut.neurcode.com/teams)
for roles, invitation, removal, and Beta limits.

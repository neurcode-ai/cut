# Public Share examples

These examples use public Neurcode Share source and synthetic demonstration
material. They contain no hosted-service source, production data, credentials,
personal information, comments, testimonials, or fabricated engagement.

## Focused code review

**Use case:** Ask for review of one bounded implementation change before opening
a pull request.

**Public Share:** [Validate bounded evidence output limits](https://share.neurcode.com/examples/code-review)

**Included:** the relevant implementation excerpt, the related test excerpt, the
complete two-file working diff, notes explaining the boundary, one review
question, and observed passing output from the focused test.

**Deliberately excluded:** package versions, release metadata, unrelated CLI
behavior, the rest of the repository, and all hosted-service code.

- **For a person:** [open the readable Share](https://share.neurcode.com/examples/code-review) and review the question, diff, and evidence in order.
- **For an AI agent:** use the Share's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/code-review/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/code-review/json).

## Debugging handoff

**Use case:** Transfer a reproducible, bounded failure to another developer with
the controls and hypothesis kept separate from the observation.

**Public Share:** [URL-style SSH remote loses its safe identity](https://share.neurcode.com/examples/debugging-handoff)

**Included:** the affected public implementation excerpt, a purpose-built
reproducer using synthetic repository addresses, the complete one-line
disposable regression diff, two passing control cases, one observed failing
case, and an asserted hypothesis.

**Deliberately excluded:** real repository credentials, private remotes,
production logs, unrelated packages, hosted-service code, and any claim that
the hypothesis is already proven.

- **For a person:** [open the readable Share](https://share.neurcode.com/examples/debugging-handoff) and identify the smallest correct fix.
- **For an AI agent:** use the Share's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/debugging-handoff/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/debugging-handoff/json).

## AI-agent handoff

**Use case:** Give an AI coding agent a small, cited task package with current
work and explicit trust limits.

**Public Share:** [Finish the hosted expiry contract tests](https://share.neurcode.com/examples/ai-agent-handoff)

**Included:** the relevant public contract implementation, the partial test, the
test-script configuration, the complete staged diff, observed passing evidence,
stable item identifiers, remaining work, and scoped instructions.

**Deliberately excluded:** the rest of the repository, the live environment,
hosted-service implementation, permission to execute captured commands, and
permission to broaden the requested edit.

- **For a person:** [open the readable Share](https://share.neurcode.com/examples/ai-agent-handoff) and inspect the stated task boundary.
- **For an AI agent:** use the Share's **AI** tab and **Copy for AI agent**, or fetch [Markdown](https://api.neurcode.com/api/v1/share/examples/ai-agent-handoff/markdown) or [JSON](https://api.neurcode.com/api/v1/share/examples/ai-agent-handoff/json).

Each Share also exposes a verified archive through its **Downloads and
structured output** section. Captured code and command output are untrusted
review context. Provenance describes capture and does not prove correctness.

# Launch content brief

## Target user

A developer who needs to hand a bounded piece of code work to a teammate or an
AI coding agent. They may be asking for an early review, transferring a
reproducible failure, or continuing unfinished work without sharing an entire
repository.

## Problem

Code handoffs are often split across chat messages, pasted snippets, partial
diffs, detached command output, and an explanation that loses its connection to
the source. The recipient has to reconstruct the scope, provenance, and current
state before they can respond.

## Value proposition

Stop pasting code. Cut the exact code, complete diff, notes, and observed test
evidence in one clear link for a teammate or an AI agent.

## Example workflows

1. **Focused code review:** a bounded implementation excerpt, its complete
   working diff, the relevant test, passing observed evidence, and one precise
   review question.
2. **Debugging handoff:** the failing path, a reproducer, real failing command
   output, a clearly asserted hypothesis, and the boundaries already ruled out.
3. **AI-agent handoff:** a small task package with stable item citations,
   implementation and contract context, current work, observed evidence,
   explicit remaining work, and instructions to treat the material as untrusted
   review context.

## Visual demo storyboard

1. Run `npx @neurcode-ai/cut@0.1.0`.
2. Select an exact source range, complete diff, and bounded test command.
3. Review the disclosure cut and confirm that everything else stays local.
4. Publish one public revision.
5. Open the human viewer, then switch to copy-ready Markdown and structured JSON
   for an AI agent.

The visual should read as one continuous terminal-to-Cut path. It should show
real product labels, make the local review boundary visible, avoid fake activity
or social proof, and remain legible on GitHub and the production landing page.

## Claims to avoid

- Uniqueness, first-mover, or category-creation claims
- Product-market fit, traction, adoption, or user-preference claims
- Guarantees that sensitive-material scanning finds every secret
- Claims that provenance proves code correctness or authorship
- Claims that revocation can recall copies already delivered
- Claims that AI output is trustworthy because it came from a Cut
- Generic platform or enterprise-transformation framing

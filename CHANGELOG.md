# Changelog

## Cut 0.2.0 / compatible engine 0.5.0 / format 0.4.1 - 2026-08-07

- Publish viewer 0.2.1 solely to bind its packed format dependency to 0.4.1;
  viewer source and API contracts are otherwise unchanged.
- Add deterministic zero-argument `cut` working-set proposals from staged,
  modified, and untracked non-ignored Git state.
- Keep every proposed disclosure local and removable before export or publish,
  with strict traversal, item-count, byte, diff, archive, and output bounds.
- Stabilize disclosure finding acknowledgements across nondeterministic command
  output while keeping concrete credential findings fail-closed.
- Preserve the legacy `@neurcode-ai/share` engine and cut/1 archive contracts.

## Cut 0.1.0 / compatible engine 0.4.0 - 2026-08-06

- Introduce **Cut by Neurcode** as the product identity and “The universal link
  for code” as its single positioning line.
- Add the primary `@neurcode-ai/cut` package and `neurcode-cut` binary.
- Make `neurcode cut` the primary command while preserving `neurcode share`,
  `neurcode-share`, existing archives, package imports, and API contracts.
- Move public links to `cut.neurcode.com/c/...` while preserving legacy
  `share.neurcode.com/s/...` access.
- Add the bounded-frame Cut mark and update all public product documentation.

## 0.3.0 - 2026-08-01

- Make one immutable Cut the source for its HTML, Markdown, JSON, and
  archive representations, with stable item and line anchors in human-facing
  output.
- Add an agent-neutral Markdown handoff with explicit evidence boundaries,
  digest identity, and guidance to distinguish captured facts from sender
  assertions.
- Add Composer review tabs for the human HTML view and the exact AI Markdown
  handoff without bypassing the disclosure airlock.
- Update the focused CLI and generated commands to `@neurcode-ai/share@0.3.0`.
- Continue reading 0.1 and 0.2 archives and accepting the legacy
  `@neurcode-ai/cli share` invocation.
- Publish only the changed format and CLI packages; SDK and viewer public APIs
  are unchanged in this release.

## 0.2.0 - 2026-08-01

- Add `verify` for conservative exact-byte comparison against a local
  worktree, staged index, named commit, or authorized hosted Cut. Results are
  `current`, `moved`, `drifted`, `deleted`, `ambiguous`, or `unverifiable`.
- Add reviewed `refresh`, which requires an explicit decision for every
  non-current item, reruns the disclosure airlock, leaves the input unchanged,
  and writes a new immutable archive linked through the exact `revisionOf`
  digest.
- Add deterministic local verification receipts that an authenticated owner
  can submit for the exact hosted revision. The service displays these as
  creator-reported verification with an aged “Last checked” time.
- Add authenticated comment reading with revision-bound citation paths and
  line ranges.
- Preserve Cut Format cut 1 and compatibility with old archives. Verification
  compares exact cited bytes only: it is not server verification, continuous
  monitoring, proof of correctness, semantic equivalence, or fuzzy matching.
- Known limitations: diff and evidence items have no source citation pins;
  rename detection requires resolvable Git history; private repositories are
  not server-verified; and status remains last-check metadata until the creator
  runs and submits another local verification.

## 0.1.0

- Establish the clean Apache-2.0 open-core repository.
- Extract the deterministic Cut format and local-first Composer.
- Add the focused `@neurcode-ai/share` CLI, viewer helpers, and public SDK.
- Preserve compatibility with archives created by `@neurcode-ai/cli share`
  version 0.22.2 and `@neurcode-ai/share-format` version 0.1.0.

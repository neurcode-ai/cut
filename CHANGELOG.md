# Changelog

## 0.2.0 - 2026-08-01

- Add `verify` for conservative exact-byte comparison against a local
  worktree, staged index, named commit, or authorized hosted Share. Results are
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
- Preserve Share Format cut 1 and compatibility with old archives. Verification
  compares exact cited bytes only: it is not server verification, continuous
  monitoring, proof of correctness, semantic equivalence, or fuzzy matching.
- Known limitations: diff and evidence items have no source citation pins;
  rename detection requires resolvable Git history; private repositories are
  not server-verified; and status remains last-check metadata until the creator
  runs and submits another local verification.

## 0.1.0

- Establish the clean Apache-2.0 open-core repository.
- Extract the deterministic Share format and local-first Composer.
- Add the focused `@neurcode-ai/share` CLI, viewer helpers, and public SDK.
- Preserve compatibility with archives created by `@neurcode-ai/cli share`
  version 0.22.2 and `@neurcode-ai/share-format` version 0.1.0.

# Threat model

## Protected assets

- repository content not selected by the author;
- secrets and credential files;
- exact archive identity and provenance;
- local drafts and exports;
- hosted capability and agent-link secrets.

## Trust boundaries

Repository capture, the loopback Composer, archive verification, rendering, and
hosted publishing are distinct boundaries. Source content is always untrusted
data. The hosted service is external to this repository.

## Principal controls

- repository-relative path normalization and real-path checks;
- default-denied credential and environment paths;
- exact override plus disclosure review;
- aggregate, entry, per-blob, compressed, and expanded limits;
- deterministic hashes and content-addressed blobs;
- no archive extraction to disk during verification;
- traversal and link rejection;
- bounded commands with process-group termination;
- HTML escaping and restrictive static content policy;
- PKCE loopback publishing and header-only capability transport.
- applyable metadata bound to a complete immutable parent document, exact
  item/range/preimage/context/replacement digests, repository identity, base,
  author provenance, and a server-created attestation;
- strict portable paths that reject traversal, `.git`, links/submodules,
  normalization/case collisions, Windows-reserved names, controls, and bidi
  spoofing;
- retained sparse try worktrees containing only affected tracked paths, with
  Git environment/config isolation and no repository-defined filters or hooks;
- interactive apply with complete preview, pre/post-confirmation revalidation,
  same-directory atomic replacement, guarded rollback, and private recovery;
- source-free, authenticated, cursor-bounded inbox projection with terminal
  escaping and strict response validation.

## Residual risks

Heuristic scanners miss unknown secret shapes. A selected command can read data
the author is authorized to access. A malicious repository can contain
confusing Unicode or intentionally misleading text. Hosted availability and
authorization depend on the separately operated service.

Local apply cannot prevent another authorized process from changing a target
between filesystem operations. It detects that interference, avoids clobbering
the external result during rollback, and preserves recovery material, but the
user may need to reconcile that path manually. Shared local administrators can
also read application state despite its restrictive permissions.

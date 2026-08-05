# ADR 0001: Verifiable Living Cut V0

Status: accepted for experimental implementation

## Context

Cut Format cut 1 already contains the inputs needed for conservative local
verification:

- `manifest.origin.remote` is a sanitized repository identity and
  `manifest.origin.head` is the capture commit.
- A file or excerpt pin is
  `<origin>@<revision>:<percent-encoded-path>[#Lstart[-end]]!sha256:<bytes>`.
  It binds repository identity, capture state, safe relative path, optional
  inclusive line range, and the exact selected bytes.
- File and excerpt primary blobs retain those exact bytes. Excerpt context is
  supplementary and is not the pin identity. Diff and evidence items do not
  have citation pins and cannot be source-current in V0.
- `manifest.digest` is the immutable content identity. `createdAt` and evidence
  `startedAt` are descriptive and excluded from it. `manifest.revisionOf`
  already links a successor to the exact previous digest.
- Archives are bounded, parsed in memory, reject traversal and links, validate
  cut 1, recompute the document digest, verify every blob, reject unknown
  entries, and verify deterministic derived files.

The CLI can create local archives without an account. Hosted archives are
fetched through the existing public, unlisted-capability, restricted signed-in,
or scoped-agent authorization paths. The existing browser PKCE flow is the only
CLI user-authentication mechanism; it remains short lived and header-only.

Cut Cloud already stores immutable revisions, item/line comments restricted
to authorized email-restricted Cuts, and source-free access events including
`recipient_to_creator`. It has owner/recipient isolation but deliberately has
no organization or workspace tenancy model. Library and Cut viewer routes
are the focused UI surfaces.

## Decision

### Format and verification

Cut 1 is unchanged. Verification is a CLI behavior over a fully validated
archive, not a new Cut document field.

Statuses are:

- `current`: the exact bytes match at the cited path and range.
- `moved`: the exact bytes have one unique line-aligned location in the cited
  file or one Git-resolved renamed file.
- `drifted`: the cited or Git-resolved path exists but has no unique exact
  match.
- `deleted`: the cited path is absent and bounded Git rename resolution finds
  no replacement.
- `ambiguous`: multiple exact line-aligned matches exist.
- `unverifiable`: repository identity, archive item, base/target, path safety,
  or a bound cannot be resolved reliably.

The resolver checks the cited range, then exact matches in the same file, then
bounded Git rename output, then the resolved path. It never fuzzily matches and
never scans the repository. Files, Git output, process time, and match counts
are bounded.

Bytes are compared without line-ending or Unicode normalization. LF and CRLF
are different pin identities. A final newline is part of the selected bytes.
Line numbers are derived from LF byte boundaries only, matching existing cut 1
capture behavior.

Comparison targets are a named commit, the index, or the current worktree.
Dirty and staged state are explicit. Repository identity must match exactly
after the existing sanitizer; mismatch fails closed. Deterministic JSON omits
wall-clock and timing fields.

### Refresh

Refresh creates a new local archive only after explicit decisions and the
existing complete scanner/airlock. It never mutates or publishes the input.
Current items can carry forward. Moved items require review. Drifted, deleted,
ambiguous, unverifiable, diff, and evidence items require an explicit keep,
reviewed replacement, remove, or abort decision. The successor sets
`revisionOf` to the exact previous digest and therefore has a new digest.

### Receipts and trust

A verification receipt is separate source-free metadata bound to one Cut
digest. Its deterministic digest excludes the server submission time. A local
receipt is labelled `locally verified`; when an owner submits it, Cut Cloud
labels it `creator-reported verification` and shows `Last checked`. Cut Cloud
does not claim `server verified`, continuous monitoring, or code correctness:
it has not independently read repository bytes.

Only the Cut owner may submit a bounded receipt. The server verifies its
digest and exact revision binding, rejects absolute paths and unknown fields,
and stores no repository source.

### Comments and return path

The existing item/line anchor remains valid. A nullable citation pin is added
for new comments. The service accepts it only when it exactly equals the
current revision item pin; invented and cross-Cut pins fail. Authorized
comment reads may receive its safe path/range. A successful comment by a real
allowed recipient, but never the owner, records `recipient_to_creator`.

The CLI comments read path uses the existing short-lived browser identity and
server authorization. It prints repository-addressable `path:line` feedback
when the authorized response contains that metadata. It never applies a patch.

Returned patch artifacts, test evidence, and repository modification are
deferred. A future artifact must be immutable, separately authenticated,
explicitly reviewed, and never grant permission to execute or apply content.

### Future GitHub boundary

A future GitHub App would use installation authorization, repository allowlists,
and least privilege: repository metadata and read-only contents, commits, and
pull requests; no write, administration, workflow, secret, or organization
member scope. Public repositories may use unauthenticated or installation reads;
private repositories require an active installation for that exact owner.

Push and pull-request head/synchronize events may enqueue rechecks pinned to
full commit SHAs. Delivery IDs must be idempotent. The service should stream
only bounded cited files/ranges, hash and discard bytes, and store receipts
rather than repository source. It must enforce installation and API rate
limits, isolate installation/repository/organization keys, and fail closed on
installation removal, repository transfer, or access revocation.

Server verification would mean the server independently fetched the pinned
bytes using current installation authority. Creator-submitted local receipts
remain creator-reported. No GitHub App, OAuth application, webhook, secret, or
configuration is created in V0.

## Consequences

No Cut Format migration or package-major change is required. Cut Cloud
needs one additive migration for receipts and nullable comment pins. Private
repositories cannot be server verified without future repository access.
Worktree-only renames that Git cannot resolve remain deleted or unverifiable
rather than being guessed.

The killed Context Compiler branch is a read-only reference. No compiler,
automatic selection, expansion, or compiler packaging is reused. Its batched
`git check-ignore` change has no focused independent test and is not needed for
this capability, so nothing is salvaged.

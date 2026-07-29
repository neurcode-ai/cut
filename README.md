# Neurcode Share

Neurcode Share turns exact code, diffs, questions, and bounded command evidence
into a deterministic, reviewable package for people and AI agents.

## 15-second quick start

From any Git repository:

```sh
npx @neurcode-ai/share
```

The Composer binds only to loopback, inventories the exact disclosure, scans
for sensitive material, and creates nothing remotely unless you explicitly
choose Publish.

For a non-interactive local archive:

```sh
npx @neurcode-ai/share src/auth.ts:20-80 --diff --yes --out review.tar.gz
```

## Local-only usage

Local creation needs no account. Export a deterministic archive, inert HTML,
Markdown, or agent JSON:

```sh
npx @neurcode-ai/share src/queue.ts --yes --out queue-review.html
npx @neurcode-ai/share --staged --yes --out staged-review.md
npx @neurcode-ai/share --diff=main..HEAD --yes --out change.json
npx @neurcode-ai/share --run "pnpm test queue" --yes --out evidence.tar.gz
```

Commands are bounded by time and output limits. Sensitive paths are denied by
default. The disclosure airlock runs before any file is written or uploaded.

## Hosted publishing

Add `--publish` after reviewing the local cut. Publishing uses the existing
Neurcode identity and a loopback PKCE flow, so no hosted token is copied into
the terminal:

```sh
npx @neurcode-ai/share src/session.ts --publish --visibility unlisted
```

The hosted service at [share.neurcode.com](https://share.neurcode.com) is
proprietary and is not implemented in this repository. Its documented client
contract is available through `@neurcode-ai/share-sdk`.

## Recipient workflows

For a person, send the viewer link. They see the question, selected context,
provenance, and comments subject to the Share's access policy.

For an AI agent, create a short-lived, revision-pinned agent link in the hosted
library and fetch its scoped format:

```sh
npx @neurcode-ai/share fetch 'AGENT_LINK' --stdout md
```

Capability and agent secrets remain in URL fragments at rest and are sent in
request headers, not request paths.

## What is in a Share?

A Share archive contains canonical `cut.json`, narrative `story.json`,
provenance `pins.json`, and content-addressed blobs. The digest excludes
wall-clock capture time but includes the selected content, intent, evidence,
and provenance. Identical meaningful inputs therefore produce identical
identity.

The [source-free example](examples/source-free-handoff.json) demonstrates the
metadata a recipient can inspect without publishing real source.

## Privacy and security boundary

- Capture, selection, scanning, review, and export happen locally.
- No account is required until hosted publishing.
- Paths, archive sizes, expanded bytes, item counts, commands, and timeouts are
  bounded.
- Archives reject traversal, links, malformed records, digest mismatches, and
  expansion bombs.
- Renderers treat all captured material as inert text.
- Secret scanning reduces risk but cannot prove that content is safe; the human
  disclosure review remains authoritative.

See [privacy](docs/PRIVACY.md), the [threat model](docs/THREAT_MODEL.md), and
[format compatibility](docs/FORMAT_COMPATIBILITY.md).

## Compared with paste, Gist, and pull requests

| Tool | Exact provenance | Local disclosure review | Bounded evidence | Agent formats | Hosted collaboration |
| --- | --- | --- | --- | --- | --- |
| Chat paste | rarely | no | no | prose | chat-specific |
| Gist | commit-level | no | no | source | link and comments |
| Pull request | strong | diff review | CI-dependent | diff/API | repository workflow |
| Neurcode Share | content pins and digest | yes | yes | Markdown, JSON, archive | optional |

Share complements pull requests when the review context is smaller, unfinished,
cross-file, or intended for an external person or agent.

## Packages

- `@neurcode-ai/share-format`: schema, archive, verifier, renderers, scanner
- `@neurcode-ai/share`: focused CLI and local Composer
- `@neurcode-ai/share-viewer`: verified local/static rendering helpers
- `@neurcode-ai/share-sdk`: public hosted client contracts

## Current limitations

- Text/code files only; binary assets are not captured.
- A Share contains an explicit cut, not a live repository mirror.
- Secret scanning is heuristic.
- Hosted publishing depends on the separately operated Neurcode service.
- Browser-only hosted creation is available at
  [share.neurcode.com/new](https://share.neurcode.com/new), not in this
  open-core repository.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [GOVERNANCE.md](GOVERNANCE.md), and
the [release policy](docs/RELEASE_POLICY.md). Security reports should follow
[SECURITY.md](SECURITY.md).

Apache-2.0 covers Neurcode-owned source here. Trademarks remain reserved as
described in [TRADEMARKS.md](TRADEMARKS.md).

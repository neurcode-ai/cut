# `@neurcode-ai/share-format`

Apache-2.0 primitives for deterministic Neurcode Share archives, validation,
secret scanning, provenance pins, and inert HTML/Markdown/JSON rendering.

Pure, local primitives for Neurcode Share Public Alpha V0.

The package owns the immutable artifact model, sanitized source addresses,
canonical digest, bounded archive, secret scanning, and deterministic local
renderers. It has no Neurcode runtime, governance, authentication, network, or
hosted-service dependency.

The `sha256:` Share digest is the content-addressed identity of selected bytes,
their provenance-bearing repository state, author intent and notes, observed
evidence, and security decisions. `manifest.createdAt` and an evidence item's
`startedAt` remain visible descriptive metadata but are deliberately excluded
from identity: repeating the same capture later does not mint a different
content identity merely because the wall clock advanced.

## Guarantees

- strict, bounded archive parsing with traversal, symlink, expansion, entry,
  reference, UTF-8, and size checks
- deterministic content identity and reproducible archive verification
- provenance grades for Git-matched, worktree-captured, uploaded, and pasted
  content
- immutable `revisionOf` lineage without a second context-capsule format
- exact-field scanning for sensitive filenames, source, complete diffs, notes,
  argv, stdout, and stderr
- inert HTML, compact Markdown, and structured agent JSON renderers

The package performs no network access and has no runtime dependencies.

```ts
import {
  readShareArchive,
  renderAgentJson,
  renderMarkdown,
} from '@neurcode-ai/share-format';

const bundle = readShareArchive(archiveBytes);
console.log(bundle.cut.manifest.digest);
console.log(renderMarkdown(bundle));
console.log(renderAgentJson(bundle));
```

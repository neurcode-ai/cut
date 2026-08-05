# Format compatibility

`cut: 1` is the current canonical document version. Readers must reject unknown
major cut versions, malformed metadata, unsupported entry types, digest
mismatches, unsafe paths, links, duplicate entries, and size-limit violations.

Writers sort canonical object keys and archive entries and use deterministic
gzip metadata. Wall-clock `createdAt` is retained for display but excluded from
the meaningful Cut digest.

The `0.4.x` format package reads archives from `0.1.x`, `0.2.x`, and `0.3.x`. Additive optional fields
may appear within cut version 1 only when older readers can safely ignore them.
Required-field or semantic changes need a new cut version and compatibility
fixtures.

The legacy `@neurcode-ai/cli share`, `@neurcode-ai/share`, `neurcode-share`,
and `neurcode share` entry points remain supported compatibility paths. New
documentation and generated output use `@neurcode-ai/cut` and `neurcode-cut`.

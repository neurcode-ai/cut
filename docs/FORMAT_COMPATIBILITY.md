# Format compatibility

`cut: 1` is the current canonical document version. Readers must reject unknown
major cut versions, malformed metadata, unsupported entry types, digest
mismatches, unsafe paths, links, duplicate entries, and size-limit violations.

Writers sort canonical object keys and archive entries and use deterministic
gzip metadata. Wall-clock `createdAt` is retained for display but excluded from
the meaningful Cut digest.

The `0.5.x` format package reads archives from `0.1.x` through `0.4.x`. Additive optional fields
may appear within cut version 1 only when older readers can safely ignore them.
Required-field or semantic changes need a new cut version and compatibility
fixtures.

Applyable Replies V1 does not add a competing archive or change `cut: 1`. Its
canonical metadata is an ordinary uploaded JSON file item at
`CUT_APPLYABLE_REPLY_V1.json`. A 0.4.x or other unaware reader can display or
export that item as inert content; a 0.5.x reader recognizes it only after
strict schema, parent-digest, item, text-digest, range, context, path, and limit
validation. A malformed reserved item is rejected by aware readers rather than
downgraded to an automatic edit.

The legacy `@neurcode-ai/cli share`, `@neurcode-ai/share`, `neurcode-share`,
and `neurcode share` entry points remain supported compatibility paths. New
documentation and generated output use `@neurcode-ai/cut` and `neurcode-cut`.

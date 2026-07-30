# `@neurcode-ai/share`

Create and verify a Share locally:

```sh
npx @neurcode-ai/share
```

No account or upload is required for local creation and HTML, Markdown, JSON,
or archive export. Hosted publishing starts only after the local disclosure
review and uses loopback PKCE without token copying.

## Verify, refresh, and read feedback

Compare exact file and excerpt bytes from a local archive with the current
repository. Local archives need no account or network:

```sh
npx @neurcode-ai/share verify review.tar.gz
npx @neurcode-ai/share verify review.tar.gz --repo ../project --staged --json
npx @neurcode-ai/share verify review.tar.gz --repo ../project --against main --output report.json
```

Verification reports `current`, `moved`, `drifted`, `deleted`, `ambiguous`, or
`unverifiable`. It compares exact bytes without line-ending or Unicode
normalization; it does not prove code correctness. Hosted viewer URLs are also
accepted and preserve an explicit `?revision=`. Restricted reads use the
existing short-lived browser sign-in.

Prepare a new local archive with the exact old digest in `revisionOf`:

```sh
npx @neurcode-ai/share refresh review.tar.gz --decision i2=use --output refreshed.tar.gz
npx @neurcode-ai/share refresh review.tar.gz --decision i2=keep --decision i3=remove --yes
```

Every non-current item requires `keep`, `use`, `remove`, or `abort`. Using
drifted, deleted, or ambiguous material also requires an explicit
`--replacement i2=path/to/file.ts:10-20`. Refresh runs the complete scanner and
disclosure airlock, never changes the input, and never publishes automatically.

Authorized reviewers and owners can read restricted feedback in repository
address form:

```sh
npx @neurcode-ai/share comments 'https://share.neurcode.com/s/SHARE_ID'
```

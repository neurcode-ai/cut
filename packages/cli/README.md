# Cut CLI

Create and verify a Cut locally:

```sh
npx @neurcode-ai/cut@0.4.0
```

With no file arguments, Cut deterministically proposes the changed, staged,
and non-ignored untracked files in the current Git subtree, plus the relevant
bounded diff. No shell history, LLM, or remote inference is used. Every item is
removable before the existing disclosure review. Explicit files, line ranges,
staged diffs, and commit ranges remain available for focused captures.

For a noninteractive local-only export, supply the intent explicitly:

```sh
npx @neurcode-ai/cut@0.4.0 --message "What should we change here?" --yes --out review.tar.gz
```

No account or upload is required for local creation and HTML, Markdown, JSON,
or archive export. Hosted publishing starts only after the local disclosure
review and uses loopback PKCE without token copying.

## Verify, refresh, and read feedback

Compare exact file and excerpt bytes from a local archive with the current
repository. Local archives need no account or network:

```sh
npx @neurcode-ai/cut@0.4.0 verify review.tar.gz
npx @neurcode-ai/cut@0.4.0 verify review.tar.gz --repo ../project --staged --json
npx @neurcode-ai/cut@0.4.0 verify review.tar.gz --repo ../project --against main --output report.json
```

Verification reports `current`, `moved`, `drifted`, `deleted`, `ambiguous`, or
`unverifiable`. It compares exact bytes without line-ending or Unicode
normalization; it does not prove code correctness. Hosted viewer URLs are also
accepted and preserve an explicit `?revision=`. Restricted reads use the
existing short-lived browser sign-in.

Prepare a new local archive with the exact old digest in `revisionOf`:

```sh
npx @neurcode-ai/cut@0.4.0 refresh review.tar.gz --decision i2=use --output refreshed.tar.gz
npx @neurcode-ai/cut@0.4.0 refresh review.tar.gz --decision i2=keep --decision i3=remove --yes
```

Every non-current item requires `keep`, `use`, `remove`, or `abort`. Using
drifted, deleted, or ambiguous material also requires an explicit
`--replacement i2=path/to/file.ts:10-20`. Refresh runs the complete scanner and
disclosure airlock, never changes the input, and never publishes automatically.

Authorized reviewers and owners can read restricted feedback in repository
address form:

```sh
npx @neurcode-ai/cut@0.4.0 comments 'https://cut.neurcode.com/c/CUT_ID'
```

## Publish to a team

Use the existing browser authorization flow to list your active teams, then
publish the reviewed Cut with a server-resolved slug:

```sh
npx @neurcode-ai/cut@0.4.0 teams
npx @neurcode-ai/cut@0.4.0 src/queue.ts --to platform-engineering-a1b2c3 --yes
```

An installed `@neurcode-ai/cut` package also exposes the short `cut` command,
so the equivalent flow is `cut teams` and `cut src/queue.ts --to <team-slug> --yes`.

`--to` implies hosted publishing. Team Cuts are team-only during Beta, so
`--recipient` and `--visibility public` fail before upload. The destination and
active membership are checked again in the finalization transaction.

## Reply with a Cut

`--reply-to <cut-url-or-id>` links a hosted publication to the current parent
without copying its payload or access settings. The server rechecks parent
read authority during finalization. The reply remains independent: select its
own content, visibility, recipients, expiry, provenance, and review boundary.

```sh
npx @neurcode-ai/cut@0.4.0 src/reply.ts --reply-to shr_PARENT_ID --publish
printf '%s\n' "$CUT_REPLY_URL" | npx @neurcode-ai/cut@0.4.0 src/reply.ts --reply-to - --publish
```

Do not pass a capability-bearing URL directly on a shared shell: command
arguments may be retained in shell history or process inspection. Prefer the
stdin form. The capability is kept in process memory, is sent only as an access
header, and is not written to the Composer draft or archive. Local exports are
never represented as linked replies because the relation is hosted metadata.

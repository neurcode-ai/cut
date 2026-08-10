# Cut workflows

Cut is the universal link for code. Select the exact code, diff, notes, and
observed command evidence once. A person receives a focused reader; an AI agent
receives bounded Markdown, JSON, or a verified archive. A recipient can return
an actual code answer as a reply Cut.

## 60-second quick start

From a Git repository:

```sh
npx @neurcode-ai/cut@0.5.0
```

The local Composer proposes changed, staged, and non-ignored untracked files in
the current subtree. Remove anything irrelevant, state the question, review
the exact disclosure, then export locally or choose hosted publishing. No
account is required until hosted publishing.

## Create and share with a teammate

Use the browser at `https://cut.neurcode.com/new` for pasted or uploaded text.
Use the CLI when Git identity, exact ranges, a complete diff, or observed
command evidence matters.

Choose the least broad access that fits:

- Restricted: signed-in allowed emails only.
- Unlisted: anyone holding the secret capability until expiry or revocation.
- Public: anyone can read it. Do not include private material.

Revocation denies future reads. It cannot recall copies already downloaded,
cached, pasted, or screenshotted.

## Share with an AI agent

Use the same accessible Cut. The viewer exposes Markdown, structured JSON, and
a verified archive, plus generic copy-ready guidance. The representation
contains the included scope and trust limits; it does not silently include the
rest of the repository.

```sh
npx @neurcode-ai/cut@0.5.0 fetch 'CUT_URL' --stdout md
```

## Reply with a Cut

The reply is an independent Cut with its own content, provenance, lifecycle,
and access boundary. Hosted publication creates the relationship and rechecks
parent access inside finalization.

```sh
printf '%s\n' "$CUT_REPLY_URL" | npx @neurcode-ai/cut@0.5.0 src/reply.ts --reply-to - --publish
```

Use stdin for a capability-bearing URL so the secret does not enter shell
history. A local export with `--reply-to` remains an ordinary Cut archive.

## Try a reply locally

```sh
npx @neurcode-ai/cut@0.5.0 try 'https://cut.neurcode.com/c/REPLY_ID'
npx @neurcode-ai/cut@0.5.0 try --list
```

Try verifies the archive, embedded parent, repository, base, paths, exact
preimages, ranges, context, replacements, and result. It creates a retained
sparse worktree containing only affected tracked files. It does not change the
current worktree, run Cut content, commands, tests, or hooks, or commit or push.

## Apply a reply safely

```sh
npx @neurcode-ai/cut@0.5.0 apply 'https://cut.neurcode.com/c/REPLY_ID'
```

Apply repeats every check, shows the full diff, and asks for the complete reply
digest in an interactive terminal. There is no `--yes`, `--force`, or
non-interactive bypass. Private recovery material is created before the first
target write. V1 edits existing eligible UTF-8 file or excerpt items only; it
does not create, delete, rename, or change file modes.

## Create and use a team

Create the team and invite an exact email in the hosted Workspace. The creator
is the first owner. Roles are owner and member only. List active destinations,
then send to the exact slug:

```sh
npx @neurcode-ai/cut@0.5.0 teams
npx @neurcode-ai/cut@0.5.0 src/queue.ts --to backend-a1b2c3 --yes
npx @neurcode-ai/cut@0.5.0 inbox --team backend-a1b2c3 --status waiting
```

Team Cuts are team-only during Beta. Waiting means there is no active reply or
non-author comment. Answered means one exists. Removing a member ends future
server access on the next request but cannot recall previously downloaded
bytes. Teams Beta does not include SSO, SCIM, domain management, custom roles,
billing controls, approval chains, audit exports, or compliance certifications.

## Troubleshooting

- If publish fails, the local or browser draft remains available. Correct the
  actionable error and retry.
- If restricted access fails, sign in with the exact allowed email. The service
  intentionally does not reveal private Cut metadata to a different identity.
- If try/apply reports a mismatch, inspect the repository, base, path, range,
  or preimage difference. Do not bypass it; the reply remains readable.
- If a team is absent, run `cut teams` and confirm that the invitation was
  accepted with the exact invited email.
- If a Cut expired or was revoked, ask the creator for a current authorized
  Cut. Old capabilities and agent links remain invalid.

See [Cut Try and Apply](CUT_TRY.md), [Cut Inbox](CUT_INBOX.md),
[privacy](PRIVACY.md), and the [threat model](THREAT_MODEL.md) for the complete
contracts.

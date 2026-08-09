# Cut Try and Apply

Applyable replies are ordinary immutable Cut replies that also carry an exact,
bounded suggested edit. Read the reply in the browser first. Use `try` to
inspect it without touching the current worktree, and use `apply` only after
that review.

## Try in an isolated worktree

```sh
cut try 'https://cut.neurcode.com/c/REPLY_ID'
cut try ./applyable-reply.tar.gz --repo ../project
cut try --list
cut try --discard try_20260810T120000Z_012345abcdef
```

`cut try` verifies the Cut archive and digest, embedded immutable parent,
parent item, repository identity, base revision, exact preimage, line range,
bounded context, replacement, and path rules. It then creates a retained,
application-controlled sparse Git worktree containing only the affected
tracked files. Ignored, untracked, credential, and unrelated tracked working
files are not copied.

The command prints the complete proposed diff and affected paths. It never
changes the selected repository, executes carried content, runs commands,
tests, or hooks, or commits or pushes. A try remains until explicitly discarded.
At most 20 tries are retained; the source repository is also bounded to 200,000
entries and 2 GiB of tracked blob data before setup.

The default private state root is `~/.local/share/neurcode-cut`. Override it
with `NEURCODE_CUT_STATE_DIR` only to a private, real directory. Symlinked,
group-readable, world-readable, broad, or escaping state paths are rejected.

## Apply after review

```sh
cut apply 'https://cut.neurcode.com/c/REPLY_ID'
cut apply ./applyable-reply.tar.gz --repo ../project
```

`cut apply` repeats all checks, displays the full terminal-safe diff, and asks
for the complete verified reply digest in an interactive terminal. V1 has no
`--yes`, `--force`, or non-interactive bypass.

Every affected path and preimage is checked before any write and rechecked
after confirmation. Writes use same-directory temporary files, preserve the
existing mode, and roll earlier paths back if a later path changes. If another
process changes a path during rollback, Cut will not overwrite that external
change and reports the private recovery directory created before the first
write.

Apply never writes in `.git`, changes Git configuration or hooks, runs source,
tests, or commands, commits, or pushes. Unsupported files, stale code, a
mismatched repository/base, symlinks, submodules, ambiguous case, invalid
Unicode paths, binary text, and malformed metadata fail without automatic
fallback.

## Supported V1 changes

V1 changes existing valid UTF-8 `file` or `excerpt` items only, with one exact
edit per portable path and at most 20 paths. It does not create, delete, rename,
or change the mode of files and does not support links, submodules, or binary
content. A stale reply remains readable as a Cut even when automatic try/apply
is rejected.

See [Applyable Replies V1](APPLYABLE_REPLIES_V1.md) for the portable binding.

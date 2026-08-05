# Contributing

Discuss substantial format or compatibility changes in an issue before writing
code. Small fixes may go directly to a pull request.

1. Use Node.js 20 or newer and pnpm 10.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm release:local`.
4. Add tests for observable behavior and compatibility.
5. Never commit credentials, personal data, real Cut payloads, access links,
   or production configuration.

By submitting a contribution, you agree to license it under Apache License 2.0
and represent that you have the right to do so. You retain copyright in your
contribution. No contributor license agreement or copyright assignment is
required unless the project announces one before accepting the contribution.

Commit messages should explain the behavior changed. Pull requests must state
security, privacy, format-compatibility, and migration impact.

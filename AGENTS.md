# vivo-watch-hub contributor notes

## Project position

- NAS hub for AI quota, Token usage, and mobile/watch bridging.
- PC project synchronization has been removed. Do not restore snapshot APIs or development-sync plugins.
- The Windows usage reporter is token-only and must never gain project or conversation upload behavior.

## Commands

- Install: `npm install`
- Syntax check: `npm run check`
- Tests: `npm test`
- Local server: `npm start`
- Docker: `docker compose up -d`

## Boundaries

- Runtime: Node.js 20+, ES modules, no web framework.
- Server: `src/`; admin UI: `public/`; tests: `test/`.
- Token-only Windows reporter: `usage-reporter-windows/`.
- Protocol: `docs/protocol.md`.
- Keep existing encryption contexts, account identity hashes, client asset names and configuration paths compatible.
- Runtime state belongs in `.hub-data/` or `/data`; never commit it.

## Safety and release

- Preserve unrelated dirty worktree changes.
- Never delete local PC projects, historical NAS snapshots or NAS data during development or testing.
- When the user requests code changes in this repository, committing and pushing those changes to GitHub is authorized, including pushing to main after required checks pass. Do not force-push or delete branches unless explicitly requested.
- Operating the user's NAS, publishing release tags, or creating a GitHub Release requires explicit user authorization.
- Before release, run syntax checks and the full test suite, then verify README and protocol docs match behavior.

# Codex Workspace Hub contributor notes

## Project position

- CW is a private NAS hub for reviewed Codex development snapshots, quota display, and mobile/watch bridging.
- Project sync is plugin-driven. The retired Windows project collector must not be restored.
- The Windows usage reporter is token-only and must never gain project or conversation upload behavior.

## Commands

- Install: `npm install`
- Syntax check: `npm run check`
- Tests: `npm test`
- Local server: `npm start`
- Docker: `docker compose up -d`

## Stack and boundaries

- Runtime: Node.js 20+, ES modules, no web framework.
- Server code: `src/`; admin UI: `public/`; tests: `test/`.
- Codex plugin: `plugin/cw-development-sync/`.
- Token-only Windows reporter: `usage-reporter-windows/`.
- Protocol reference: `docs/protocol.md`.
- Runtime state belongs in `.hub-data/`, `/data`, or `cw-snapshots/`; never commit it.

## Current product truth

- Current release line is v1.0.x.
- CW Docker stores encrypted snapshot payloads and metadata; selection and encryption happen on the PC.
- Publishing and applying snapshots require a reviewed preview and user confirmation.
- Mobile/watch quota data and PC project sync are independent paths.

## Safety and release

- Preserve unrelated dirty worktree changes.
- Never delete local PC projects or NAS data as part of normal development or testing.
- Do not operate a user's NAS, push Git, publish Docker tags, or create a GitHub Release without explicit confirmation.
- Before release, run syntax checks and the full test suite, then verify README and protocol docs match behavior.

## Next step

- Improve reliability through small-project tests before broad snapshot transfers.

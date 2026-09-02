---
name: development-sync
description: Review, publish, preview, and apply the current project's active development changes through Codex Workspace Hub (CW). Use when the user asks to sync project progress between PCs, continue work from another PC, publish a development snapshot, inspect remote CW changes, or restore a CW snapshot.
---

# CW development sync

Use the `cw_development_sync` MCP tools. CW stores only encrypted snapshot packages and small version metadata. It does not decide which files belong to active development.

## Safety rules

- Never publish automatically merely because CW is connected. First call `cw_prepare_snapshot` and show the user the included and excluded paths.
- `cw_publish_snapshot` and `cw_apply_snapshot` are mutations. Call them only after the user explicitly approves the specific preview or directly asks to publish/apply.
- Never add a blocked secret, credential, dependency tree, compiler/toolchain, build output, cache, `.git`, Codex runtime data, or recovery/conflict directory. The MCP server enforces this again.
- Use incremental mode for normal work. Use baseline mode only for a new CW workspace after reviewing the candidate list, preferably on a small project first.
- Prefer the stable workspace ID suggested by `cw_prepare_snapshot`. It derives from the Git remote when available, so the same repository matches across PCs. Ask for a workspace ID only when there is no stable Git identity.
- A snapshot contains exact selected changes, not every historical version and not the entire Codex project index.
- Never silently overwrite conflicts. Preview before apply. The apply tool writes conflicting incoming files under `.cw-conflicts` and moves safe deletions to `.cw-recovery`.

## Publish workflow

1. Call `cw_status` and stop if local configuration is missing or the hub is unreachable.
2. Call `cw_prepare_snapshot` with `mode: "incremental"` unless a reviewed first baseline is requested.
3. Review candidate paths and exclusions. Select only files relevant to the completed or in-progress development change.
4. Tell the user the selected file count, deletions, and estimated plaintext bytes.
5. After approval, call `cw_publish_snapshot` with the exact selected path list and a short development summary.
6. Report the committed snapshot ID and remote head.

## Receive workflow

1. Call `cw_list_snapshots` for the matched workspace.
2. Call `cw_preview_snapshot` for the intended snapshot. If this PC has never received the workspace, start from the newest baseline and then preview/apply later snapshots in chronological order.
3. Explain creates, updates, safe deletions, no-ops, and conflicts.
4. After approval, call `cw_apply_snapshot`.
5. Report written, recovered, and conflicted paths. Do not delete `.cw-recovery` or `.cw-conflicts` automatically.

## Configuration

If `cw_status` reports `configured: false`, tell the user to run `scripts/configure.ps1` from this plugin directory in a local terminal. The script prompts for the CW address and device connection Key and stores the Key using Windows DPAPI. Never ask the user to paste the Key into chat or a tool argument.

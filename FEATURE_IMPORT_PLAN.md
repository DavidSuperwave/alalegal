# Ironclaw -> Superwave Agent Feature Import Plan

## Current Status (Updated 2026-03-04)

Phase 1 (Web UI selective import) is complete.

- Audited target surfaces in `apps/web` against `DenchHQ/ironclaw` (`FETCH_HEAD`).
- Imported missing behavior where needed: **none required**.
- Preserved intentional product branding differences (`Superwave` labels/links).

## Phase 1 Scope (Web UI Only)

The following target areas were compared for parity:

- Chat stream + reasoning UX
- Workspace shell + sidebar + tree navigation
- Object table / kanban / entry detail flows
- Reports / chart panels / report filters
- Markdown editor with embedded report blocks
- Media viewer for image/video/audio/PDF

## Exact Delta Checklist (Dench vs Local)

### Chat + Workspace

- `apps/web/app/components/chat-panel.tsx` -> `MATCH`
- `apps/web/app/components/chat-message.tsx` -> `MATCH`
- `apps/web/app/components/chain-of-thought.tsx` -> `MATCH`
- `apps/web/app/workspace/page.tsx` -> `MATCH`
- `apps/web/app/components/workspace/file-manager-tree.tsx` -> `MATCH`
- `apps/web/app/components/workspace/workspace-sidebar.tsx` -> `MATCH` except intentional branding text/links (`Ironclaw` -> `Superwave`, `ironclaw.sh` -> `superwave.ai`)

### Data / Reports / Media

- `apps/web/app/components/workspace/data-table.tsx` -> `MATCH`
- `apps/web/app/components/workspace/object-table.tsx` -> `MATCH`
- `apps/web/app/components/workspace/object-kanban.tsx` -> `MATCH`
- `apps/web/app/components/workspace/entry-detail-modal.tsx` -> `MATCH`
- `apps/web/app/components/charts/chart-panel.tsx` -> `MATCH`
- `apps/web/app/components/charts/report-card.tsx` -> `MATCH`
- `apps/web/app/components/charts/filter-bar.tsx` -> `MATCH`
- `apps/web/app/components/workspace/markdown-editor.tsx` -> `MATCH`
- `apps/web/app/components/workspace/report-block-node.tsx` -> `MATCH`
- `apps/web/app/components/workspace/media-viewer.tsx` -> `MATCH`

### Related API / Backend Support

- `apps/web/app/api/**` -> Local is a superset (adds auth routes `api/auth/login` and `api/auth/verify`)
- `apps/web/lib/**` -> Local is a superset (adds `lib/dashboard-auth.ts`)
- `apps/web/app/workspace/**` -> Local is a superset (adds `workspace/layout.tsx` and `workspace/pipeline/page.tsx`)

## Verification Run

Executed after audit:

- `npm test` in `apps/web` -> PASS (22 files passed, 1 skipped, 584 tests passed)
- `npm run build` in `apps/web` -> PASS

## True Remaining Gaps (Outside Phase 1)

Web UI parity is complete for the audited scope.

Still missing from top-level structure:

- `apps/ios`
- `apps/android`
- `apps/macos`

## Recommended Next Phases

1. Phase 2: Decide whether to port companion apps (`ios/android/macos`) or keep web-first strategy.
2. Phase 3: Extension/skill parity audit (`extensions/`, `skills/`) only if needed for your production roadmap.
3. Phase 4: Keep this file and `README.md` as the canonical parity status to avoid drift.

# WPR Planning / Timeline Overhaul — isolated preview

Development branch: `feature/timeline-overhaul-preview-20261028`.

## Scope
This folder is a self-contained, **sample-data-only** lookahead prototype. It does **not** import the live Command Center, call the Cloudflare Worker, write to D1, change Procore or Pulse, or change the deployed root/hosted UI.

Open `planning-preview/index.html` locally to evaluate:
- Two-week date grid grouped by unit/activity, with text search and status/unit filters
- Needs Attention panel and summary counts
- Separate `required by` and `follow up` dates
- Quick capture and sample status changes, both reset on refresh
- Inspection/task examples for Units 9 and 10 (illustrative, **not verified live work**)

## Existing code preserved
- `hosted-command-center/index.html` and root `index.html`: unchanged
- `worker/src/index.js`: unchanged
- Existing `tasks`, `timelines` and their Pulse/Procore source synchronization: unchanged
- Existing Procore observation review bucket and source freshness: unchanged
- No migrations, deployment workflows, production writes, or external notifications

## Technical findings
The active timeline is rendered by `renderTimeline()` / `renderTimelineRow()` in `hosted-command-center/index.html`; its phase bars consume `project.timelines` and use a fixed current/next-two-month range. The worker provides `taskList`, `timelines`, `milestones`, `attention`, and `control` from D1. Pulse updates some timeline rows through `syncPulseTimelines`. Procore/Pulse source task replacement means planning records should not be inserted as source-owned tasks.

## Next implementation slice (not yet built)
1. Add non-destructive `planning_items`, `planning_dependencies`, and `planning_events` tables using a separate migration.
2. Add validated, authenticated read/write API methods and regression tests (source-sync replacement must not delete manual planning items).
3. Read source-owned observations/to-dos as **linked records**, with no modifications to the current source viewers.
4. Place redesigned timeline behind a feature flag; existing timeline remains rollback.
5. Test authorization, date handling, evidence/verification, and stale source data before connecting live records.

**Do not merge, deploy, or change production without explicit review.**

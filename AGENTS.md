# Project Memory

## Product Direction

The Project Command Center is a minimalist bird's-eye view of active projects. It should act as a signal layer, not as a second project management system and not as a replacement for Pulse.

Pulse remains the source of truth for granular to-do management, project communication, notes, attachments, and day-to-day task handling. The Command Center should help Christen see pertinent project information from one place without opening each individual Pulse project one by one.

When adding features, prefer concise overview patterns:

- Project health, schedule, open task count, overdue count, and risk count.
- Section-level summaries before detailed task lists.
- Collapsed details by default, especially Pulse notes.
- Clear exception signals, such as overdue to-dos, high risks, missing dates, upcoming handoffs, and tasks with notes or attachments.
- Links or references back to Pulse when deeper action is needed.

Avoid turning the Command Center into a full task-management workspace. Do not add unnecessary task controls, communication features, or dense Pulse-like workflows unless explicitly requested. The interface should stay quiet, scannable, and focused on helping Christen decide where attention is needed.

## Pulse Sync Principles

Pulse-synced to-dos should be filtered to the ATI-relevant work Christen needs to oversee. Non-ATI department sections such as Solus, Linked, Sales, and Service should be excluded from the sync to prevent clutter.

Synced Pulse to-dos should preserve enough context to understand the signal:

- Pulse section/list prefix in the task title.
- Status.
- Due date when available.
- Assignee data when available.
- Pulse notes, collapsed by default in the UI.
- Stable source tracking using `source` plus `externalId`.

The default sync should update/create tasks but should not automatically complete missing tasks unless that behavior is intentionally enabled after review.

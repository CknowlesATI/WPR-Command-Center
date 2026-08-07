# Command Center Phase 3 - Outcome Control

Branch: `codex/phase-3-outcome-control`

## Purpose

This branch is a secluded working model for evolving Project Command Center into
an outcome-based project-control platform. It is intended for comparison against
the current internal Command Center and the separate online/shared version.

The goal is to let Christen test a different operating model without changing
the current platform until a deliberate merge or deployment decision is made.

## Isolation Rules

- Keep all outcome-control work on this branch until Christen approves merging.
- Preserve the current internal Google Apps Script app unless a phase 3 change
  explicitly needs it.
- Preserve the hosted/shared dashboard unless Christen asks to adapt phase 3 for
  a shared online view.
- Do not deploy Apps Script, publish a hosted site, send email, alter calendars,
  or change external systems without explicit approval.
- Use existing project data to demonstrate workflows. Do not invent project
  facts.

## Existing System Findings

The repository currently contains two Command Center versions:

- Original/internal app at the repository root:
  - `index.html` is the main browser UI.
  - `Code.gs` is the Google Apps Script API.
  - Google Sheets tabs currently model Projects, Timelines, Tasks, Risks, and
    Milestones.
  - The current app computes red/amber/green attention from risks, dates, task
    counts, and timeline gaps.

- Hosted/shared app in `hosted-command-center/`:
  - `index.html` is a read-focused static dashboard.
  - `data/projects.json` is the safe exported data file.
  - `DATA_CONTRACT.md` keeps the shared data shape smaller and safer.
  - Hosted data intentionally excludes owners, notes, source details, and other
    internal fields unless approved.

There are no formal automated tests in `package.json` yet. Existing verification
is mostly through hosted data validation and manual preview.

## How The Outcome-Control Model Fits

The requested outcome-control model belongs first in the original/internal app,
because it needs owners, evidence, notes, blocker reasons, escalation state, and
state-change history. Those fields are intentionally excluded from the current
hosted/shared data contract.

The hosted/shared dashboard can later receive a sanitized summary of phase 3
signals if useful, but it should not be the first implementation target.

## Required New Control Layer

Add one current-control record per active project, with these fields:

- Current next outcome.
- Owner of the next move.
- Operating state: Action Needed, Follow-Up Needed, Monitor, Stable.
- Blocked flag and blocker reason.
- Consequence of delay.
- Exact next action.
- Requested response, review, or escalation date.
- Last meaningful movement date.
- Evidence/source reference and optional notes.
- Escalation level or last escalation action.

Keep Blocked as a flag, not an operating state.

## Smallest Useful Phase 3 Scope

Recommended first implementation:

1. Add a `ProjectControls` sheet or equivalent current-control section keyed by
   project ID.
2. Add API read/write support for the control fields without replacing existing
   Projects, Timelines, Tasks, Risks, or Milestones data.
3. Add validation rules:
   - Monitor requires a review date or event trigger.
   - Follow-Up Needed, Action Needed, and Monitor require a next outcome and
     owner.
   - Vague next outcomes such as "Follow up", "Check status", and "Review
     email" are incomplete.
   - Blocked requires a blocker reason.
4. Add a calm Daily Direction view with no more than three recommendations:
   - One urgent field, schedule, or access outcome.
   - One approval, contract, procurement, payment, or financial outcome.
   - One quiet or aging project needing deliberate attention.
5. Add a Weekly Portfolio Control view that exposes every active project and
   highlights missing owner, missing outcome, missing review date, overdue
   review date, and long periods without movement.
6. Preserve a simple control-event history when state or core fields change, so
   the later personal traction log has reliable source events.

## Approval Gate Before Material Changes

Before changing platform behavior, show Christen:

- The existing architecture summary.
- The proposed data mapping.
- Any ambiguous product decisions.
- The first implementation slice.
- The verification approach for state transitions, missing review dates, and
  daily recommendation behavior.


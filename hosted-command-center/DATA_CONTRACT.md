# Hosted Data Contract

The hosted dashboard reads `data/projects.json`. This file is intentionally
smaller and safer than the current internal Command Center data.

## Top-Level Fields

- `lastUpdated`: ISO timestamp for the export.
- `source`: where the hosted data came from.
- `projects`: array of project summaries.

## Project Fields

- `id`: stable hosted identifier.
- `name`: project name visible to viewers.
- `area`: project area or segment.
- `team`: visible external team label.
- `health`: `green`, `amber`, `red`, or `pending`.
- `phase`: current project phase label.
- `startDate`: project start date, `YYYY-MM-DD` or `null`.
- `endDate`: project end date, `YYYY-MM-DD` or `null`.
- `openTasks`: count only.
- `overdueTasks`: count only.
- `highPriorityTasks`: count only.
- `risks`: count only.
- `nextHandoff`: next handoff date, `YYYY-MM-DD` or `null`.
- `approvalsPayments`: optional birdseye status object for contract,
  deposit, and change order status.
- `taskList`: optional sanitized open task rows for field review.
- `timelines`: sanitized phase schedule rows.
- `attention`: short list of sanitized attention signals.
- `links`: optional reviewed source links.

## Approvals & Payments Fields

- `contract`: short status label, or empty string if not set.
- `deposit`: short status label, or empty string if not set.
- `changeOrders`: short status label, or empty string if not set.

## Task Fields

- `name`: short visible task title.
- `status`: `todo`, `progress`, or `done`.
- `source`: visible source label such as `Pulse`, `Procore`, or
  `Command Center`.
- `externalUrl`: optional reviewed source URL, or empty string.

## Timeline Fields

- `key`: `prewire`, `trim`, `handover`, or `install`.
- `label`: visible phase label.
- `start`: phase start date, `YYYY-MM-DD` or `null`.
- `end`: phase end date, `YYYY-MM-DD` or `null`.
- `status`: `complete` or empty string.

## Attention Fields

- `severity`: `green`, `amber`, or `red`.
- `label`: short signal type.
- `detail`: short sanitized detail.
- `dueDate`: due date, `YYYY-MM-DD` or `null`.
- `source`: visible source label such as `Pulse`, `Procore`, or
  `Command Center`.

## Excluded From Hosted Data

- Pulse notes.
- Procore descriptions unless intentionally summarized.
- Raw external IDs.
- Internal project IDs beyond the hosted slug.
- Credentials, tokens, secrets, or sync settings.
- Assignee or owner names unless Christen approves broader visibility.
- Source links unless reviewed and intentionally enabled.

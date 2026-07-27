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
- `attention`: short list of sanitized attention signals.
- `links`: optional reviewed source links.

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

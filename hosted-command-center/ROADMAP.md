# Hosted Command Center Roadmap

This roadmap is for the online/shared Command Center branch. It should not
change the current Google Apps Script operating baseline unless Christen
explicitly asks for that later.

## Phase 1 - Static Shared Dashboard

Status: in progress

- Keep the hosted app in `hosted-command-center`.
- Use static JSON data so no subscription-based backend is required.
- Keep the viewer experience read-only.
- Validate hosted data before publishing.
- Publish through a free static-hosting path when approved.

## Phase 2 - Real Data Export

Status: started

- Export from the current Command Center API into `data/projects.json`.
- Sanitize the shared data shape.
- Exclude notes, raw external IDs, credentials, and private details.
- Exclude source links unless they are reviewed and intentionally enabled.

## Phase 3 - Automated Refresh

Status: scaffolded

- Use a free scheduled publishing workflow.
- Store the Command Center API URL as a private repository secret.
- Refresh on weekday mornings and on manual runs.

## Phase 4 - Field Team Refinement

Status: pending

- Tune the dashboard around WPR tech workflows.
- Improve mobile/tablet scanning.
- Add project grouping and area filters if real data volume needs them.
- Add source links only if they are safe and useful for the intended audience.

## Approval Gates

Christen should approve before:

- Publishing the hosted dashboard online.
- Adding real data to the hosted output.
- Turning on source links.
- Adding any login system.
- Adding any paid or subscription-based service.

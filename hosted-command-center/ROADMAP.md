# Hosted Command Center Roadmap

This roadmap is for the online Command Center. The hosted app is the foundation
for the field-facing product.

Operational default: ambiguous Command Center requests should be handled in
`hosted-command-center/`. Use the root app as a reference source, not a
separate destination.

## Phase 1 - Static Shared Dashboard

Status: in progress

- Keep the online app in `hosted-command-center`.
- Use the existing Apps Script API for live data and editing.
- Keep static JSON as a fallback so no subscription-based backend is required.
- Validate hosted data before publishing.
- Publish through a free static-hosting path when approved.

## Phase 2 - Real Data Export

Status: started

- Export from the current Command Center API into fallback `data/projects.json`.
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
- Continue migrating needed working features from the root app into the online
  app instead of maintaining two user experiences.

## Approval Gates

Christen should approve before:

- Publishing the hosted dashboard online.
- Adding real data to the hosted output.
- Turning on source links.
- Adding any login system.
- Adding any paid or subscription-based service.

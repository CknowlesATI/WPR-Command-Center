# Pulse Sync CLI

This local CLI refreshes Pulse to-dos in the online Command Center database.

## Commands

From the repository root:

```powershell
npm run pulse:login-test
npm run pulse:dry-run
npm run pulse:sync
npm run pulse:search-projects -- WPR
```

`dry-run` fetches Pulse and the online Command Center data, matches projects, and reports what would be replaced without changing the database.

`sync` deletes only existing Pulse task rows from Cloudflare D1 and inserts the current Pulse to-dos with Pulse links. Procore and Command Center-created rows are preserved.

The default Pulse link is the project's To-do page:

```text
https://www.pulsecentral.ai/c/ati-of-america/projects/{pulseProjectId}?card=todos
```

If Pulse returns a more specific task URL in its API response, the sync uses that instead.

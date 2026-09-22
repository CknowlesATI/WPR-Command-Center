import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const apiUrl = 'https://wpr-command-center-api.wpr-command-center.workers.dev';
export function isDue(source, now = Date.now()) {
  if (!source || source.status === 'requested') return true;
  const lastAttempt = Date.parse(source.lastAttemptAt);
  // A failing source retries at most once per hour, independently of the other source.
  if (['failed', 'skipped', 'unknown'].includes(source.status)) return !Number.isFinite(lastAttempt) || now - lastAttempt >= 3600000;
  const lastSuccess = Date.parse(source.lastSuccessAt);
  return !Number.isFinite(lastSuccess) || now - lastSuccess >= 6 * 3600000;
}

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

async function readLive() {
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok || !data.ok || !Array.isArray(data.data)) throw new Error('Command Center could not be read.');
  return data;
}

async function runChild(source, mode) {
  const args = source === 'pulse'
    ? ['pulse-sync/pulse-sync.js', mode === 'verify' ? 'dry-run' : 'sync', '--pulse-timeline-api']
    : ['procore-browser-sync/procore_browser_sync.js', 'sync-auto', '--headless', '--complete-missing', '--require-complete-list', '--detail-refresh', '--attempts', '2', ...(mode === 'verify' ? ['--dry-run'] : [])];
  // Source contents and page text never enter public Actions logs or artifacts.
  // Keep only bounded diagnostic output in memory and print count-only lines.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const timer = setTimeout(() => child.kill(), 45 * 60 * 1000);
    const collect = chunk => { output = (output + chunk.toString()).slice(-200000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); resolve({ ok: false, output: '' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, output }); });
  });
}

async function recordFailure(source) {
  if (!process.env.COMMAND_CENTER_SYNC_TOKEN) return;
  const response = await fetch(apiUrl, { method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'Content-Type': 'application/json', 'x-command-center-sync-token': process.env.COMMAND_CENTER_SYNC_TOKEN }, body: JSON.stringify({ action: 'recordSyncRun', source, status: 'failed', recordsSeen: 0, recordsWritten: 0, projectCount: 0, message: 'Hosted sync failed. Check the Cloud source sync workflow. Existing data may be stale.' }) });
  if (!response.ok) throw new Error('Failure status could not be recorded.');
}

export async function main() {
  const [source = 'check', mode = 'verify'] = process.argv.slice(2);
  const live = await readLive();
  if (source === 'check') {
    for (const name of ['pulse', 'procore']) {
      const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
      const selected = process.env.SELECTED_SOURCE || 'both';
      const enabled = manual || process.env.CLOUD_SYNC_ENABLED === 'true';
      const due = enabled && (manual ? selected === 'both' || selected === name : isDue(live.settings.sources.find(s => s.source === name)));
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${due}\n`);
      summary(`${name}: ${due ? 'selected for hosted run' : 'no run needed / automatic sync not enabled'}`);
    }
    return;
  }
  if (!['pulse', 'procore'].includes(source) || !['verify', 'sync'].includes(mode)) throw new Error('Invalid source or mode.');
  const required = source === 'pulse' ? ['PULSE_EMAIL', 'PULSE_PASSWORD'] : ['PROCORE_EMAIL', 'PROCORE_PASSWORD', 'PROCORE_COMPANY_ID', 'PROCORE_OBSERVATIONS_URLS'];
  if (mode === 'sync') required.push('COMMAND_CENTER_SYNC_TOKEN');
  if (required.some(key => !process.env[key])) throw new Error(`${source}: required cloud secrets are not configured.`);
  const startedAt = Date.now();
  summary(`${source}: ${mode === 'verify' ? 'read-only verification' : 'sync'} started on GitHub-hosted ${process.platform}.`);
  const result = await runChild(source, mode);
  if (!result.ok) {
    if (mode === 'sync') await recordFailure(source);
    const reasons = [
      ['Could not find an installed Chrome', 'Browser executable unavailable'],
      ['Chrome did not open a control port', 'Browser startup failed'],
      ['No debuggable Chrome page', 'Browser control unavailable'],
      ['Timed out waiting for Procore login', 'Unattended Procore login did not finish'],
      ['login did not complete', 'Unattended Procore login did not finish'],
      ['list completeness could not be verified', 'Observation list count could not be verified'],
      ['grid stopped before', 'Virtual grid extraction incomplete'],
      ['grid scroll container', 'Virtual grid scroll control unavailable'],
      ['missing or duplicate observation links', 'Observation links failed validation'],
      ['Timed out waiting for Procore observation detail', 'Observation detail did not finish loading'],
      ['Command Center', 'Command Center request or validation failed'],
    ].filter(([pattern]) => result.output.includes(pattern)).map(([,label]) => label);
    summary(`${source}: FAILED. ${[...new Set(reasons)].join('; ') || 'Source extraction did not complete'}. Raw source output was withheld from public logs.`);
    throw new Error('Hosted source run failed.');
  }
  const countLines = result.output.split(/\r?\n/).filter(line => /^(Verified complete Procore list: \d+\/\d+|Verified Procore extraction: \d+ open ATI observations; \d+ mapped; \d+ require review\.|pulse tasks: \d+ item\(s\), \d+ project scope\(s\)\.|Pulse PM Contracts dates: \d+ dashboard row\(s\) fetched\.|Pulse API to-dos: \d+ Pulse project\(s\), \d+ matched, \d+ to-do item\(s\)\.)$/.test(line));
  countLines.forEach(summary);
  if (mode === 'sync') {
    const after = await readLive();
    const status = after.settings.sources.find(s => s.source === source);
    if (status?.status !== 'success' || Date.parse(status.lastSuccessAt) < startedAt || status.updatedBy !== 'CLOUD') throw new Error('Live source freshness did not confirm this cloud run.');
    summary(`${source}: live backend confirmed ${status.recordsWritten} records written at ${status.lastSuccessAt}.`);
  }
  summary(`${source}: ${mode} passed.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });

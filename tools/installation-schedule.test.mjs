import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCsv, scheduleRows, getInstallationSchedule} from '../hosted-command-center/assets/installation-schedule.js';

const headers = ['Unit', 'Unit Type', 'Phase', 'Start Date', 'End Date', 'Duration (days)', 'Notes'];

test('CSV handles Google export quoting and multiline notes', () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi""\nnext"\r\nx,y,z'), [['a', 'b,c', 'say "hi"\nnext'], ['x', 'y', 'z']]);
  assert.throws(() => parseCsv('"unfinished'));
});

test('schedule preserves phases, cross-year dates and notes, and stops at project notes', () => {
  const rows = scheduleRows([headers,
    ['PH', 'Penthouse', 'Phase 2', '2026-12-30', '2027-01-13'],
    ['PH', 'Penthouse', 'Phase 1', '2026-12-09', '2026-12-16', '8', 'Excludes TVs'],
    [], ['PROJECT NOTES'], ['Phase 1 scope']]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].notes, 'Excludes TVs');
  assert.equal(rows[1].end, '2027-01-13');
});

test('invalid dates, changed headers and empty exports fail instead of clearing the schedule', () => {
  for (const values of [[], [headers], [['Changed']], [headers, ['TH1', 'Townhome', 'Phase 1', '2026-02-30', '2026-03-03']], [headers, ['TH1', 'Townhome', 'Phase 1', '2026-12-02', '2026-12-01']]]) assert.throws(() => scheduleRows(values));
});

test('upstream sign-in pages are rejected', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>'));
  await assert.rejects(getInstallationSchedule(), /requires sign-in/);
});

test('each refresh reads changed source dates', async t => {
  let start = '2026-11-12';
  t.mock.method(globalThis, 'fetch', async () => new Response(headers.join(',') + '\nTH1,Townhome,Phase 1,' + start + ',2026-11-16'));
  assert.equal((await getInstallationSchedule()).rows[0].start, '2026-11-12');
  start = '2026-11-13';
  assert.equal((await getInstallationSchedule()).rows[0].start, '2026-11-13');
});

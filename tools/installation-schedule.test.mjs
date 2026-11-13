import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseCsv, scheduleRows, getInstallationSchedule} from '../hosted-command-center/assets/installation-schedule.js';

const headers = ['Unit', 'Unit Type', 'Phase', 'Start Date', 'End Date', 'Duration (days)', 'Notes'];

test('daily refresh rolls over at 6 AM Denver time in winter and summer', () => {
  const script = readFileSync('index.html', 'utf8');
  const start = script.indexOf('function installationMorningKey(');
  const end = script.indexOf('async function refreshInstallationSchedule', start);
  const context = vm.createContext({});
  vm.runInContext(script.slice(start, end), context);
  for (const [time, expected] of [
    ['2026-11-13T12:59:00Z', '2026-11-12'],
    ['2026-11-13T13:00:00Z', '2026-11-13'],
    ['2026-07-13T11:59:00Z', '2026-07-12'],
    ['2026-07-13T12:00:00Z', '2026-07-13'],
    ['2027-01-01T08:00:00Z', '2026-12-31']
  ]) assert.equal(vm.runInContext(`installationMorningKey(new Date('${time}'))`, context), expected);
});

test('live numeric project IDs and offline IDs both show all 24 installation windows', () => {
  const html = readFileSync('hosted-command-center/index.html', 'utf8');
  assert.equal(html, readFileSync('index.html', 'utf8'));
  const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1];
  const extract = name => script.slice(script.indexOf('function ' + name + '('), script.indexOf('\nfunction ', script.indexOf('function ' + name + '(') + 1));
  const names = [...Array.from({length: 8}, (_, i) => 'WPR Unit ' + (i + 1)), ...['101', '102', '201', '202'].map(n => 'WPR Condo ' + n), 'WPR Condo Penthouse', 'Skier Services'];
  for (const numeric of [true, false]) {
    const context = {document: {getElementById: () => context.target}, target: {}, visibleProjects: () => names.map((name, i) => ({id: numeric ? String(i + 1) : 'offline-' + i, name})), escapeHtml: String, escapeAttribute: String, formatDateRange: (a, b) => a + ' – ' + b, formatDateTime: String};
    vm.createContext(context);
    vm.runInContext(script.slice(script.indexOf('const NORTH_VILLAGE_INSTALLATIONS'), script.indexOf('async function refreshInstallationSchedule')), context);
    for (const name of ['parseDate', 'timelineSegment', 'timelineCalendarTicks', 'renderDateGrid', 'renderMonthLabels', 'renderNorthVillageSchedule']) vm.runInContext(extract(name), context);
    vm.runInContext('renderNorthVillageSchedule()', context);
    assert.match(context.target.innerHTML, /24 installation windows/);
    assert.equal((context.target.innerHTML.match(/class="timeline-bar /g) || []).length, 24);
    assert.ok(!context.target.innerHTML.includes('NaN'));
  }
});

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

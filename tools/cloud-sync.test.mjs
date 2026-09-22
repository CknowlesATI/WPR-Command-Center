import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import worker from '../worker/src/index.js';
import { isDue } from './cloud-sync.mjs';
const require = createRequire(import.meta.url);
const { parseObservationPagination, readCompleteObservationList, buildProcoreTasks, extractObservationDetailFromDom, extractRowsFromCurrentObservationListDom } = require('../procore-browser-sync/procore_browser_sync.js');

function fixture() {
  const sql = new DatabaseSync(':memory:');
  for (const file of readdirSync('worker/migrations').sort().filter(f => f.endsWith('.sql') && !f.startsWith('0002'))) sql.exec(readFileSync(`worker/migrations/${file}`, 'utf8'));
  sql.exec("INSERT INTO projects (id, name) VALUES ('1', 'WPR Unit 1'), ('2', 'WPR Condo 101'); INSERT INTO tasks (id,project_id,name,status,source) VALUES ('manual-1','1','Keep manual','todo',''), ('pulse-old','1','Old pulse','todo','pulse'), ('procore-old','1','Old procore','todo','procore'); INSERT INTO sync_runs (source,status,last_success_at) VALUES ('pulse','success','2026-01-01T00:00:00Z');");
  const DB = {
    prepare(query) {
      let values = [];
      const statement = { bind(...args) { values = args; return statement; }, async all() { return { results: sql.prepare(query).all(...values) }; }, async first() { return sql.prepare(query).get(...values) || null; }, async run() { return sql.prepare(query).run(...values); } };
      return statement;
    },
    async batch(statements) { sql.exec('BEGIN'); try { const results = []; for (const s of statements) results.push(await s.run()); sql.exec('COMMIT'); return results; } catch (error) { sql.exec('ROLLBACK'); throw error; } }
  };
  const env = { DB, SYNC_TOKEN: 'test-only-token-with-more-than-32-characters', ACCESS_CODE: 'test-only-editor-code', SESSION_SECRET: 'test-session-secret' };
  async function post(body, headers = { 'x-command-center-sync-token': env.SYNC_TOKEN }) {
    const response = await worker.fetch(new Request('https://test.invalid/', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), env, {});
    return { status: response.status, body: await response.json() };
  }
  return { sql, env, post };
}

test('cloud credential cannot edit manual content, projects, settings, or authorize itself', async () => {
  const { post, sql } = fixture();
  for (const action of ['addTask', 'updateTask', 'deleteTask', 'addProject', 'closeProject', 'updateProjectControl', 'addNotificationRecipient', 'removeNotificationRecipient']) {
    assert.equal((await post({ action })).status, 403, action);
  }
  assert.equal((await post({ action: 'authorize' })).status, 401);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM tasks').get().n, 3);
});

test('invalid cloud credential fails closed', async () => {
  const { post } = fixture();
  assert.equal((await post({ action: 'recordSyncRun' }, { 'x-command-center-sync-token': 'wrong' })).status, 401);
  assert.equal((await post({ action: 'recordSyncRun' }, {})).status, 401);
});

test('complete snapshot replaces only its source; freshness advances only at final success', async () => {
  const { post, sql } = fixture();
  const result = await post({ action: 'syncSourceTasks', source: 'pulse', replaceProjectIds: ['1'], tasks: [{ id: 'pulse-new', projectId: '1', name: 'New pulse', status: 'todo' }] });
  assert.equal(result.status, 200);
  assert.equal(result.body.result.mutated, true);
  assert.equal(result.body.data, undefined, 'sync credential response does not return unrelated data/settings');
  assert.deepEqual(sql.prepare('SELECT id FROM tasks ORDER BY id').all().map(r => r.id), ['manual-1', 'procore-old', 'pulse-new']);
  assert.equal(sql.prepare("SELECT last_success_at t FROM sync_runs WHERE source='pulse'").get().t, '2026-01-01T00:00:00Z');
  await post({ action: 'recordSyncRun', source: 'pulse', status: 'success', recordsSeen: 1, recordsWritten: 1, projectCount: 1 });
  assert.equal(sql.prepare("SELECT updated_by v FROM sync_runs WHERE source='pulse'").get().v, 'CLOUD');
});

test('partial, empty, oversized, and invalid-project snapshots preserve existing tasks', async () => {
  const { post, sql } = fixture();
  const task = { id: 'pulse-new', projectId: '1', name: 'New pulse' };
  const base = { action: 'syncSourceTasks', source: 'pulse', replaceProjectIds: ['1'] };
  assert.equal((await post({ ...base, tasks: [], sourceOpStatus: 'success' })).body.result.mutated, false);
  assert.equal((await post({ ...base, tasks: [task], sourceOpStatus: 'failed' })).body.result.mutated, false);
  assert.equal((await post({ ...base, tasks: Array(1001).fill(task) })).body.ok, false);
  assert.equal((await post({ ...base, tasks: [{ ...task, projectId: 'missing' }] })).body.ok, false);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM tasks').get().n, 3);
  assert.equal(sql.prepare("SELECT last_success_at t FROM sync_runs WHERE source='pulse'").get().t, '2026-01-01T00:00:00Z');
});

test('review project is reusable and stays outside the public project list', async () => {
  const { post, env, sql } = fixture();
  const first = await post({ action: 'ensureProcoreReviewProject' });
  const second = await post({ action: 'ensureProcoreReviewProject' });
  assert.equal(first.body.result.id, second.body.result.id);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM projects WHERE name='Procore Observation Review'").get().n, 1);
  const response = await worker.fetch(new Request('https://test.invalid/'), env, {});
  const publicData = await response.json();
  assert.equal(publicData.data.some(p => p.name === 'Procore Observation Review'), false);
});

test('existing editor session still supports manual writes', async () => {
  const { post, env } = fixture();
  const auth = await post({ action: 'authorize', accessCode: env.ACCESS_CODE, initials: 'CK' }, {});
  assert.equal(auth.status, 200);
  const response = await post({ action: 'addTask', projectId: '1', name: 'Manual follow-up', status: 'todo' }, { 'x-command-center-session': auth.body.token });
  assert.equal(response.status, 200);
});

test('schedule retries failures hourly and polls requests without requiring a local host', () => {
  const now = Date.parse('2026-09-22T12:00:00Z');
  assert.equal(isDue({status:'requested'}, now), true);
  assert.equal(isDue({status:'success',lastSuccessAt:'2026-09-22T10:00:00Z'}, now), false);
  assert.equal(isDue({status:'success',lastSuccessAt:'2026-09-22T05:00:00Z'}, now), true);
  assert.equal(isDue({status:'failed',lastAttemptAt:'2026-09-22T11:30:00Z'}, now), false);
  assert.equal(isDue({status:'failed',lastAttemptAt:'2026-09-22T10:30:00Z'}, now), true);
});

test('observation pagination requires an explicit valid range', () => {
  assert.deepEqual(parseObservationPagination('1–43 of 43'), {start:1,end:43,total:43});
  assert.deepEqual(parseObservationPagination('101 - 200 of 1,202'), {start:101,end:200,total:1202});
  assert.equal(parseObservationPagination('Loading observations'), null);
  assert.equal(parseObservationPagination('1-44 of 43'), null);
  assert.deepEqual(parseObservationPagination('Observations\nRows: 43\nTerms'), {start:1,end:43,total:43,virtual:true});
});

test('project mapping preserves stable IDs and routes ambiguous observations to review', () => {
  const row = { project:'824117 - WPR NORTH VILLAGE', procoreProjectId:'2884198', number:'2678', title:'LV lights blinking', location:'Building>Unit 101/102>Kitchen A121', itemUrl:'https://app.procore.com/2884198/project/observations/items/23524948', status:'Not Accepted' };
  const result = buildProcoreTasks([row, { ...row, number:'2824', location:'', title:'Wires need shortening' }], [{id:'2',name:'WPR Condo 101'}]);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, 'procore-2884198-23524948');
  assert.equal(result.skipped.length, 1);
});

test('condo room letters do not move first-floor observations to second-floor condos', () => {
  const projects = [101,102,201,202].map(id => ({ id:String(id), name:`WPR Condo ${id}` }));
  for (const [location, expected] of [['Unit 101/102>Kitchen A121','101'],['Unit 101/102>Kitchen B121','102'],['Unit 201/202>Kitchen A221','201'],['Unit 201/202>Kitchen B221','202']]) {
    const result = buildProcoreTasks([{location,number:'1',title:'Repair',status:'Initiated'}], projects);
    assert.equal(result.tasks[0]?.projectId, expected);
  }
});

function listClient(pages) {
  let page = 0;
  return { async send(method, {expression}) {
    if (expression.includes('next[0].click')) { page++; return {result:{value:page < pages.length}}; }
    if (expression.includes('extractRowsFromCurrentObservationListDom')) return {result:{value:JSON.stringify(pages[page].rows)}};
    return {result:{value:{text:pages[page].text}}};
  }};
}
test('complete-list reader follows pages and rejects duplicate or partial rows', async () => {
  const row = id => ({detailUrl:`https://app.procore.com/details/${id}`,number:String(id)});
  const pages = [{text:'1-2 of 3',rows:[row(1),row(2)]},{text:'3-3 of 3',rows:[row(3)]}];
  assert.equal((await readCompleteObservationList(listClient(pages),{timeout:100})).length,3);
  await assert.rejects(readCompleteObservationList(listClient([{text:'1-2 of 2',rows:[row(1),row(1)]}]),{timeout:100}), /duplicate/);
  await assert.rejects(readCompleteObservationList(listClient([{text:'1-2 of 2',rows:[row(1)]}]),{timeout:1}), /completeness/);
  await assert.rejects(readCompleteObservationList(listClient([{text:'Loading',rows:[]}]),{timeout:1}), /completeness/);
});

test('virtual grid is scrolled and overlapping visible rows are deduplicated', async () => {
  const row = id => ({detailUrl:`https://app.procore.com/details/${id}`,number:String(id)});
  const pages = [[row(1),row(2)],[row(2),row(3)],[row(3),row(4)]];
  let page = 0;
  const client = { async send(method, {expression}) {
    if (expression.includes('element.scrollTop')) { page++; return {result:{value:page < pages.length}}; }
    if (expression.includes('extractRowsFromCurrentObservationListDom')) return {result:{value:JSON.stringify(pages[page])}};
    if (expression === 'document.body.innerText') return {result:{value:'Rows: 4'}};
    return {result:{value:{text:'Rows: 4'}}};
  }};
  const rows = await readCompleteObservationList(client,{timeout:100,'grid-wait-ms':1});
  assert.deepEqual(rows.map(r=>r.number),['1','2','3','4']);
});

test('source placeholders remain empty and multiline descriptions remain intact', () => {
  const context = { document:{body:{innerText:'No.\n2824\nTitle\nRepair\nStatus\nInitiated\nLocation\nNo Location selected\nDistribution\nDescription\n--\nAttachments'}}, location:{href:'https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality/details/23648272'} };
  const first = vm.runInNewContext(`(${extractObservationDetailFromDom.toString()})()`,context);
  assert.equal(first.location,'');
  assert.equal(first.description,'');
  context.document.body.innerText=context.document.body.innerText.replace('--','First sentence.\nSecond sentence.');
  const second=vm.runInNewContext(`(${extractObservationDetailFromDom.toString()})()`,context);
  assert.equal(second.description,'First sentence. Second sentence.');
});

test('custom observation types keep their own titles and stable links', () => {
  const lines=['2824','Pre-Punch','Repair wires','KH','Kody Huot','ATI OF AMERICA','9/18/2026','2774','Deficiency','Move TV','BU','Blessing','ATI OF AMERICA','9/16/2026'];
  const links=[{text:'Repair wires',href:'https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality/details/23648272'},{text:'Move TV',href:'https://app.procore.com/webclients/host/companies/9207/projects/2884198/tools/observations/quality/details/23605947'}];
  const rows=extractRowsFromCurrentObservationListDom(lines,links,[],'WPR');
  assert.equal(rows.length,2);
  assert.equal(rows[0].number,'2824');
  assert.equal(rows[1].detailUrl,links[1].href);
});

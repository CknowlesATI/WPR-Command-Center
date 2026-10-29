import test from 'node:test';import assert from 'node:assert/strict';
import {sourceTasksFromDashboard} from '../worker/src/planning-source-adapter.js';
test('retains source identity and separates open imported records',()=>{
const data=[{name:'Unit 9',taskList:[{id:'pulse-1',source:'pulse',name:'ATI To-Do',status:'todo',dueDate:'2026-10-30'},{id:'procore-2',source:'procore',name:'Observation',status:'progress'},{id:'manual-3',source:'Command Center',name:'Local',status:'todo'},{id:'pulse-4',source:'pulse',name:'Closed',status:'done'}]}];
const a=sourceTasksFromDashboard(data);assert.equal(a.length,2);assert.ok(a.every(x=>x.readOnly));assert.equal(a[0].unit,'Unit 9');
});

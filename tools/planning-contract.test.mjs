import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlanningItem,planningAttention} from '../worker/src/planning-contract.js';
const base={projectId:'9',title:'Seal penetrations',dueDate:'2026-10-28',followUpDate:'2026-10-26'};
test('normalizes valid manual planning item',()=>assert.equal(normalizePlanningItem(base).status,'open'));
test('requires project and title',()=>assert.throws(()=>normalizePlanningItem({projectId:'9'})));
test('rejects invalid date and inverted range',()=>{
  assert.throws(()=>normalizePlanningItem({...base,dueDate:'2026-02-30'}));
  assert.throws(()=>normalizePlanningItem({...base,startDate:'2026-11-01'}));
});
test('waiting requires follow-up date',()=>assert.throws(()=>normalizePlanningItem({...base,status:'waiting',followUpDate:''})));
test('due date and follow-up remain separate',()=>{const x=normalizePlanningItem(base);assert.equal(x.followUpDate,'2026-10-26');assert.equal(x.dueDate,'2026-10-28')});
test('open item resurfaces at review date; completion clears alert',()=>{
 const x=normalizePlanningItem({...base,owner:'ATI'});
 assert.equal(planningAttention(x,'2026-10-27'),'follow-up-due');
 assert.equal(planningAttention({...x,status:'done'},'2026-10-29'),null);
});
test('missing owner is visible',()=>assert.equal(planningAttention(normalizePlanningItem({...base,followUpDate:'2026-11-04'}),'2026-10-27'),'unassigned'));

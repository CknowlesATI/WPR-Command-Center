import test from 'node:test';import assert from 'node:assert/strict';
import {projectSourceItem,dedupeSourceItems,needsHumanReview} from '../worker/src/planning-sources.js';
const item={source:'pulse',externalId:'pulse-123',title:'Trim',dueDate:'2026-11-02',confidence:'confirmed'};
test('source items are read-only',()=>assert.equal(projectSourceItem(item).readOnly,true));
test('source identity mandatory',()=>assert.throws(()=>projectSourceItem({...item,externalId:''})));
test('reject unsafe URL and invalid date',()=>{assert.throws(()=>projectSourceItem({...item,sourceUrl:'javascript:alert(1)'}));assert.throws(()=>projectSourceItem({...item,dueDate:'2026-02-30'}));});
test('source+ID deduplicates by update timestamp',()=>{const out=dedupeSourceItems([{...item,sourceUpdatedAt:'2026-10-25'}, {...item,title:'Revised',sourceUpdatedAt:'2026-10-28'}]);assert.equal(out.length,1);assert.equal(out[0].title,'Revised');});
test('tentative requires attention',()=>assert.equal(needsHumanReview(projectSourceItem({...item,confidence:'tentative'})),true));

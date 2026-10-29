// Source-aware, read-only planning projection. Never updates imported systems.
export const SOURCES=Object.freeze(['procore','pulse','calendar','gmail','drive','wequote','otter','wren','manual']);
export const CONFIDENCE=Object.freeze(['confirmed','tentative','needs-review','stale']);
const date=s=>!s||(/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s);
export function projectSourceItem(raw) {
 if(!raw||typeof raw!=='object')throw new Error('Item required');
 const source=String(raw.source||'').toLowerCase();
 if(!SOURCES.includes(source))throw new Error('Unknown source');
 const externalId=String(raw.externalId||'').trim();
 if(source!=='manual'&&!externalId)throw new Error('Imported item requires stable source identity');
 const sourceUrl=String(raw.sourceUrl||'');
 if(sourceUrl&&!/^https:\/\//.test(sourceUrl))throw new Error('HTTPS source link required');
 const confidence=String(raw.confidence||'needs-review');
 if(!CONFIDENCE.includes(confidence))throw new Error('Invalid confidence');
 const dueDate=String(raw.dueDate||''),followUpDate=String(raw.followUpDate||'');
 if(!date(dueDate)||!date(followUpDate))throw new Error('Invalid date');
 const item={source,externalId,sourceUrl,confidence,dueDate,followUpDate,
  title:String(raw.title||'').trim().slice(0,300),unit:String(raw.unit||'').trim().slice(0,100),
  owner:String(raw.owner||'').trim().slice(0,100),
  sourceUpdatedAt:String(raw.sourceUpdatedAt||''),verifiedAt:String(raw.verifiedAt||''),
  status:String(raw.status||'open'),readOnly:source!=='manual'};
 if(!item.title)throw new Error('Title required');
 return item;
}
export function dedupeSourceItems(items) {
 const map=new Map();
 for(const raw of items){const x=projectSourceItem(raw),k=x.source+':'+(x.externalId||x.title);
  const prior=map.get(k);if(!prior||String(x.sourceUpdatedAt)>String(prior.sourceUpdatedAt))map.set(k,x);
 }
 return [...map.values()];
}
export function needsHumanReview(item) {
 return ['needs-review','stale','tentative'].includes(item.confidence);
}

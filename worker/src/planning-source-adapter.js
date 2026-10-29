import {dedupeSourceItems} from './planning-sources.js';
// This adapter only projects existing API data; no mutations or new network calls.
export function sourceTasksFromDashboard(projects) {
 const rows=[];
 for(const project of projects||[])for(const task of project.taskList||[]){
  const source=String(task.source||'').toLowerCase();
  if(!['pulse','procore','procore-review'].includes(source)||task.status==='done')continue;
  rows.push({
   source:source==='procore-review'?'procore':source,
   externalId:String(task.id||''),
   title:String(task.name||''),
   unit:String(project.name||''),
   owner:String(task.assignee||''),
   dueDate:task.dueDate||'',
   followUpDate:'',
   status:task.status,
   confidence:'needs-review',
   sourceUrl:task.externalUrl||'',
   sourceUpdatedAt:task.sourceUpdatedAt||'',
   verifiedAt:''
  });
 }
 return dedupeSourceItems(rows);
}

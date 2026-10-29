// Standalone planner contract. No live API connection is made by importing this module.
export const PLANNING_STATUSES = Object.freeze(['open','in_progress','waiting','verify','done','cancelled']);
export const PLANNING_TYPES = Object.freeze(['task','milestone','inspection','coordination']);
export const PLANNING_PRIORITIES = Object.freeze(['normal','high','critical']);
const validDate = s => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s+'T00:00:00Z').toISOString().slice(0,10) === s);
function clean(value, limit = 200) { return String(value ?? '').trim().slice(0, limit); }
export function normalizePlanningItem(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Planning item must be an object.');
  const out = {
    projectId:clean(input.projectId,100), unitLabel:clean(input.unitLabel),
    title:clean(input.title,300), description:clean(input.description,4000),
    itemType:clean(input.itemType || 'task'), status:clean(input.status || 'open'),
    priority:clean(input.priority || 'normal'), owner:clean(input.owner),
    startDate:clean(input.startDate,10), dueDate:clean(input.dueDate,10),
    followUpDate:clean(input.followUpDate,10), verificationNote:clean(input.verificationNote,1000),
    sourceTaskId:clean(input.sourceTaskId,150)
  };
  if (!out.projectId || !out.title) throw new Error('Project and title are required.');
  if (!PLANNING_TYPES.includes(out.itemType)) throw new Error('Invalid planning item type.');
  if (!PLANNING_STATUSES.includes(out.status)) throw new Error('Invalid planning status.');
  if (!PLANNING_PRIORITIES.includes(out.priority)) throw new Error('Invalid priority.');
  for (const key of ['startDate','dueDate','followUpDate']) if (!validDate(out[key])) throw new Error('Invalid '+key);
  if (out.startDate && out.dueDate && out.startDate > out.dueDate) throw new Error('Start cannot exceed due date.');
  if (['waiting','verify'].includes(out.status) && !out.followUpDate) throw new Error('Waiting and verification items require a follow-up date.');
  return out;
}
export function planningAttention(item,today) {
  if (['done','cancelled'].includes(item.status)) return null;
  if (item.dueDate && item.dueDate < today) return 'overdue';
  if (item.followUpDate && item.followUpDate <= today) return 'follow-up-due';
  if (!item.owner) return 'unassigned';
  if (item.dueDate && item.dueDate <= today) return 'due-today';
  return null;
}

import fs from "node:fs/promises";

const DEFAULT_API_URL = "https://script.google.com/macros/s/AKfycbwpmgVlqQUBd-T2tIwl-QynxBuPx8lut7LhRqZRnO6OO9JPEsi40E9AxOeZaMTGhVBSKw/exec";

const args = parseArgs(process.argv.slice(2));
const apiUrl = args.url || process.env.COMMAND_CENTER_API_URL || DEFAULT_API_URL;
const outPath = args.out || "worker/migrations/0002_seed_current_data.sql";

const response = await fetch(apiUrl, { cache: "no-store" });
if (!response.ok) throw new Error(`Could not load Command Center data (${response.status})`);

const raw = await response.json();
const projects = Array.isArray(raw) ? raw : raw.data;
if (!Array.isArray(projects)) throw new Error("Command Center API did not return a project list");

const statements = [
  "-- Generated from the current Command Center API.",
  "-- Safe to rerun: existing rows are replaced with the latest exported values.",
  "DELETE FROM milestones;",
  "DELETE FROM risks;",
  "DELETE FROM timelines;",
  "DELETE FROM tasks;",
  "DELETE FROM project_control_history;",
  "DELETE FROM project_controls;",
  "DELETE FROM projects;"
];

for (const project of projects) {
  statements.push(insert("projects", {
    id: project.id,
    name: project.name,
    project_group: project.projectGroup,
    segment: project.segment,
    external_team: project.externalTeam,
    percent: Number(project.percent) || 0,
    starts_at: project.startsAt || "",
    ends_at: project.endsAt || ""
  }));

  const control = project.control || {};
  statements.push(insert("project_controls", {
    project_id: project.id,
    next_outcome: control.nextOutcome,
    next_move_owner: control.nextMoveOwner,
    operating_state: control.operatingState || "Stable",
    blocked: bool(control.blocked),
    blocker_reason: control.blockerReason,
    delay_consequence: control.delayConsequence,
    next_action: control.nextAction,
    response_date: control.responseDate,
    review_date: control.reviewDate,
    escalation_date: control.escalationDate,
    last_movement_date: control.lastMovementDate,
    evidence: control.evidence,
    control_notes: control.controlNotes,
    escalation_level: control.escalationLevel,
    last_escalation_action: control.lastEscalationAction,
    event_trigger: control.eventTrigger,
    override_daily: bool(control.overrideDaily),
    contract_status: control.contractStatus,
    deposit_status: control.depositStatus,
    change_order_status: control.changeOrderStatus,
    updated_at: control.updatedAt
  }));

  for (const task of project.taskList || []) {
    statements.push(insert("tasks", {
      id: task.id,
      project_id: project.id,
      name: task.name,
      status: task.status || "todo",
      source: task.source,
      external_url: task.externalUrl || task.url || task.link || ""
    }));
  }

  for (const item of project.timelines || []) {
    statements.push(insert("timelines", {
      project_id: project.id,
      key: item.key,
      label: item.label,
      start: item.start || "",
      end: item.end || "",
      status: item.status || ""
    }));
  }

  for (const risk of project.risks || []) {
    statements.push(insert("risks", {
      id: risk.id,
      project_id: project.id,
      title: risk.title,
      severity: risk.severity,
      owner: risk.owner,
      note: risk.note,
      due: risk.due || ""
    }));
  }

  for (const milestone of project.milestones || []) {
    statements.push(insert("milestones", {
      id: milestone.id,
      project_id: project.id,
      name: milestone.name,
      date: milestone.date || "",
      state: milestone.state || "future"
    }));
  }
}

await fs.writeFile(outPath, `${statements.join("\n")}\n`, "utf8");
console.log(`Wrote ${outPath}`);
console.log(`Projects: ${projects.length}`);
console.log(`Tasks: ${projects.reduce((total, project) => total + (project.taskList || []).length, 0)}`);

function insert(table, values) {
  const entries = Object.entries(values);
  const columns = entries.map(([key]) => key).join(", ");
  const row = entries.map(([, value]) => sqlValue(value)).join(", ");
  return `INSERT INTO ${table} (${columns}) VALUES (${row});`;
}

function sqlValue(value) {
  if (value === undefined || value === null) return "''";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "0";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bool(value) {
  return value === true || value === 1 || value === "true" || value === "TRUE" ? 1 : 0;
}

function parseArgs(items) {
  const parsed = {};
  for (let i = 0; i < items.length; i += 1) {
    if (items[i] === "--url") parsed.url = items[++i];
    else if (items[i] === "--out") parsed.out = items[++i];
  }
  return parsed;
}

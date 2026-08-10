const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-command-center-token,x-command-center-session,x-command-center-initials"
};

const SESSION_DAYS = 30;

const CONTROL_FIELDS = new Map([
  ["nextOutcome", ["next_outcome", normalizeText]],
  ["nextMoveOwner", ["next_move_owner", normalizeText]],
  ["operatingState", ["operating_state", normalizeOperatingState]],
  ["blocked", ["blocked", value => truthy(value) ? 1 : 0]],
  ["blockerReason", ["blocker_reason", normalizeText]],
  ["delayConsequence", ["delay_consequence", normalizeText]],
  ["nextAction", ["next_action", normalizeText]],
  ["responseDate", ["response_date", normalizeOptionalDate]],
  ["reviewDate", ["review_date", normalizeOptionalDate]],
  ["escalationDate", ["escalation_date", normalizeOptionalDate]],
  ["lastMovementDate", ["last_movement_date", normalizeOptionalDate]],
  ["evidence", ["evidence", normalizeText]],
  ["controlNotes", ["control_notes", normalizeText]],
  ["escalationLevel", ["escalation_level", normalizeText]],
  ["lastEscalationAction", ["last_escalation_action", normalizeText]],
  ["eventTrigger", ["event_trigger", normalizeText]],
  ["overrideDaily", ["override_daily", value => truthy(value) ? 1 : 0]],
  ["contractStatus", ["contract_status", normalizeText]],
  ["depositStatus", ["deposit_status", normalizeText]],
  ["changeOrderStatus", ["change_order_status", normalizeText]]
]);

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    try {
      if (request.method === "GET") {
        return json(await getAllData(env.DB));
      }

      if (request.method === "POST") {
        const body = await request.json();
        if (body.action === "authorize") return json(await createSession(body, env));
        const actor = await authorizeWrite(request, env);
        await applyAction(env.DB, body, actor);
        return json({ ok: true, data: await getAllData(env.DB) });
      }

      return json({ ok: false, error: "Method not allowed" }, 405);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, error.status || 500);
    }
  }
};

async function applyAction(db, body, actor) {
  if (!body || typeof body !== "object") throw new Error("Missing request body");

  if (body.action === "updateProjectControl") return updateProjectControl(db, body, actor);
  if (body.action === "addTask") return addTask(db, body, actor);
  if (body.action === "updateTask") return updateTask(db, body, actor);
  if (body.action === "deleteTask") return deleteById(db, "tasks", body.taskId);

  throw new Error(`Unknown action: ${body.action}`);
}

async function getAllData(db) {
  const [projects, controls, tasks, timelines, risks, milestones] = await Promise.all([
    db.prepare("SELECT * FROM projects ORDER BY CAST(id AS INTEGER), name").all(),
    db.prepare("SELECT * FROM project_controls").all(),
    db.prepare("SELECT * FROM tasks ORDER BY CAST(id AS INTEGER), name").all(),
    db.prepare("SELECT * FROM timelines ORDER BY project_id, key").all(),
    db.prepare("SELECT * FROM risks ORDER BY CAST(id AS INTEGER), title").all(),
    db.prepare("SELECT * FROM milestones ORDER BY project_id, date").all()
  ]);

  const controlsByProject = mapBy(controls.results, "project_id");

  return projects.results.filter(isDashboardProject).map(project => {
    const projectTasks = tasks.results.filter(task => String(task.project_id) === String(project.id));
    return {
      id: project.id,
      name: project.name,
      projectGroup: project.project_group || "",
      segment: project.segment || "",
      externalTeam: project.external_team || "",
      percent: Number(project.percent) || 0,
      startsAt: project.starts_at || null,
      endsAt: project.ends_at || null,
      milestones: milestones.results
        .filter(item => String(item.project_id) === String(project.id))
        .map(item => ({ id: item.id, name: item.name, date: item.date, state: item.state })),
      tasks: {
        todo: projectTasks.filter(task => task.status === "todo").length,
        progress: projectTasks.filter(task => task.status === "progress").length,
        done: projectTasks.filter(task => task.status === "done").length
      },
      taskList: projectTasks.map(task => ({
        id: task.id,
        name: task.name,
        status: task.status,
        source: task.source || "",
        externalUrl: task.external_url || "",
        updatedBy: task.updated_by || "",
        updatedAt: task.updated_at || ""
      })),
      timelines: timelines.results
        .filter(item => String(item.project_id) === String(project.id))
        .map(item => ({ key: item.key, label: item.label, start: item.start || null, end: item.end || null, status: item.status || "" })),
      risks: risks.results
        .filter(item => String(item.project_id) === String(project.id))
        .map(item => ({ id: item.id, title: item.title, severity: item.severity, owner: item.owner, note: item.note, due: item.due || null })),
      control: toControl(project.id, controlsByProject.get(String(project.id)))
    };
  });
}

async function updateProjectControl(db, body, actor) {
  const projectId = required(body.projectId, "projectId");
  const field = required(body.field, "field");
  const config = CONTROL_FIELDS.get(field);
  if (!config) throw new Error(`Invalid control field: ${field}`);

  await ensureControlRow(db, projectId);
  const existing = await db.prepare("SELECT * FROM project_controls WHERE project_id = ?").bind(projectId).first();
  const [column, normalize] = config;
  const value = normalize(body.value);
  const updatedAt = currentIsoMinute();
  const updatedBy = actor.initials;

  validateControlField(field, value);

  await db.batch([
    db.prepare(`UPDATE project_controls SET ${column} = ?, updated_at = ?, updated_by = ? WHERE project_id = ?`).bind(value, updatedAt, updatedBy, projectId),
    db.prepare("INSERT INTO project_control_history (project_id, changed_at, field, old_value, new_value, changed_by) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(projectId, updatedAt, field, String(existing[column] ?? ""), String(value ?? ""), updatedBy)
  ]);
}

async function addTask(db, body, actor) {
  const projectId = required(body.projectId, "projectId");
  const name = normalizeText(required(body.name, "name"));
  if (!name) throw new Error("Task name is required");
  const status = normalizeTaskStatus(body.status || "todo");
  const source = normalizeText(body.source || "Command Center");
  const next = await db.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS id FROM tasks").first();
  await db.prepare("INSERT INTO tasks (id, project_id, name, status, source, external_url, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(String(next.id), projectId, name, status, source, normalizeText(body.externalUrl || ""), actor.initials, currentIsoMinute())
    .run();
}

async function updateTask(db, body, actor) {
  const taskId = required(body.taskId, "taskId");
  const field = required(body.field, "field");
  if (!["name", "status"].includes(field)) throw new Error(`Invalid task field: ${field}`);
  const column = field === "name" ? "name" : "status";
  const value = field === "status" ? normalizeTaskStatus(body.value) : normalizeText(body.value);
  if (field === "name" && !value) throw new Error("Task name is required");
  const result = await db.prepare(`UPDATE tasks SET ${column} = ?, updated_by = ?, updated_at = ? WHERE id = ?`).bind(value, actor.initials, currentIsoMinute(), taskId).run();
  if (!result.meta || result.meta.changes === 0) throw new Error(`Task row not found: ${taskId}`);
}

async function deleteById(db, table, id) {
  const result = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(required(id, "id")).run();
  if (!result.meta || result.meta.changes === 0) throw new Error(`${table} row not found: ${id}`);
}

async function ensureControlRow(db, projectId) {
  await db.prepare("INSERT OR IGNORE INTO project_controls (project_id, operating_state, blocked, override_daily) VALUES (?, 'Stable', 0, 0)")
    .bind(projectId)
    .run();
}

function toControl(projectId, row = {}) {
  return {
    projectId,
    nextOutcome: row.next_outcome || "",
    nextMoveOwner: row.next_move_owner || "",
    operatingState: row.operating_state || "Stable",
    blocked: truthy(row.blocked),
    blockerReason: row.blocker_reason || "",
    delayConsequence: row.delay_consequence || "",
    nextAction: row.next_action || "",
    responseDate: row.response_date || "",
    reviewDate: row.review_date || "",
    escalationDate: row.escalation_date || "",
    lastMovementDate: row.last_movement_date || "",
    evidence: row.evidence || "",
    controlNotes: row.control_notes || "",
    escalationLevel: row.escalation_level || "",
    lastEscalationAction: row.last_escalation_action || "",
    eventTrigger: row.event_trigger || "",
    overrideDaily: truthy(row.override_daily),
    contractStatus: row.contract_status || "",
    depositStatus: row.deposit_status || "",
    changeOrderStatus: row.change_order_status || "",
    updatedAt: row.updated_at || "",
    updatedBy: row.updated_by || ""
  };
}

async function createSession(body, env) {
  const code = normalizeText(body.accessCode);
  const expectedCode = normalizeText(env.ACCESS_CODE || env.WRITE_TOKEN || "");
  if (!expectedCode || code !== expectedCode) throw unauthorized("Access code was not accepted.");

  const initials = normalizeInitials(body.initials);
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = { initials, exp: expiresAt };
  const token = await signSession(payload, env);
  return { ok: true, token, initials, expiresAt };
}

async function authorizeWrite(request, env) {
  const expectedCode = normalizeText(env.ACCESS_CODE || env.WRITE_TOKEN || "");
  if (!expectedCode) return { initials: normalizeInitials(request.headers.get("x-command-center-initials") || "CC") };

  const session = request.headers.get("x-command-center-session") || "";
  const actor = await verifySession(session, env);
  if (!actor) throw unauthorized("Edit access has expired or is not authorized.");
  return actor;
}

async function signSession(payload, env) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(encodedPayload, sessionSecret(env));
  return `${encodedPayload}.${signature}`;
}

async function verifySession(token, env) {
  const [encodedPayload, signature] = String(token || "").split(".");
  if (!encodedPayload || !signature) return null;
  const expected = await hmac(encodedPayload, sessionSecret(env));
  if (signature !== expected) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload.exp || Number(payload.exp) < Date.now()) return null;
    return { initials: normalizeInitials(payload.initials) };
  } catch {
    return null;
  }
}

async function hmac(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

function sessionSecret(env) {
  return normalizeText(env.SESSION_SECRET || env.ACCESS_CODE || env.WRITE_TOKEN || "command-center-dev");
}

function normalizeInitials(value) {
  const initials = normalizeText(value).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  if (!initials) throw new Error("Initials are required");
  return initials;
}

function unauthorized(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

function base64UrlEncode(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(padded);
}

function mapBy(rows, key) {
  const map = new Map();
  rows.forEach(row => map.set(String(row[key]), row));
  return map;
}

function isDashboardProject(project) {
  const name = String(project.name || "").trim();
  const group = String(project.project_group || "").trim();
  const segment = String(project.segment || "").trim();
  const team = String(project.external_team || "").trim();
  return !(name === "Procore Observation Review" || group === "Unmapped Procore" || segment === "Unmapped Procore" || (team === "Procore" && (group === "Unmapped Procore" || segment === "Unmapped Procore")));
}

function validateControlField(field, value) {
  if (field === "operatingState" && !["Action Needed", "Follow-Up Needed", "Monitor", "Stable"].includes(value)) {
    throw new Error("Invalid operating state");
  }
}

function normalizeTaskStatus(value) {
  const status = normalizeText(value);
  return ["todo", "progress", "done"].includes(status) ? status : "todo";
}

function normalizeOperatingState(value) {
  const state = normalizeText(value);
  return ["Action Needed", "Follow-Up Needed", "Monitor", "Stable"].includes(state) ? state : "Stable";
}

function normalizeOptionalDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function required(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") throw new Error(`${label} is required`);
  return String(value).trim();
}

function truthy(value) {
  return value === true || value === 1 || value === "1" || value === "true" || value === "TRUE";
}

function currentIsoMinute() {
  return new Date().toISOString().slice(0, 16);
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

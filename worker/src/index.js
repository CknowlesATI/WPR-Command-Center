const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,x-command-center-token,x-command-center-session,x-command-center-initials"
};

const SESSION_DAYS = 183;
const WORK_PHASES = ["prewire", "trim", "install"];

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
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    try {
      if (request.method === "GET") {
        return json({ ok: true, data: await getAllData(env.DB), settings: await getSettings(env.DB, env) });
      }

      if (request.method === "POST") {
        const body = await request.json();
        if (body.action === "authorize") return json(await createSession(body, env));
        const actor = await authorizeWrite(request, env);
        await applyAction(env.DB, body, actor, env);
        return json({ ok: true, data: await getAllData(env.DB), settings: await getSettings(env.DB, env) });
      }

      return json({ ok: false, error: "Method not allowed" }, 405);
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, error.status || 500);
    }
  }
};

async function applyAction(db, body, actor, env) {
  if (!body || typeof body !== "object") throw new Error("Missing request body");

  if (body.action === "updateProjectControl") return updateProjectControl(db, body, actor);
  if (body.action === "updateTimeline") return updateTimeline(db, body);
  if (body.action === "syncPulseTimelines") return syncPulseTimelines(db, body);
  if (body.action === "setProjectPhase") return setProjectPhase(db, body);
  if (body.action === "addProject") return addProject(db, body, actor);
  if (body.action === "closeProject") return closeProject(db, body, actor);
  if (body.action === "addTask") return addTask(db, body, actor, env);
  if (body.action === "updateTask") return updateTask(db, body, actor);
  if (body.action === "syncSourceTasks") return syncSourceTasks(db, body);
  if (body.action === "deleteTask") return deleteById(db, "tasks", body.taskId);
  if (body.action === "addNotificationRecipient") return addNotificationRecipient(db, body, actor);
  if (body.action === "removeNotificationRecipient") return removeNotificationRecipient(db, body);

  throw new Error(`Unknown action: ${body.action}`);
}

async function getAllData(db) {
  const [projects, controls, tasks, timelines, risks, milestones] = await Promise.all([
    db.prepare("SELECT * FROM projects ORDER BY CAST(id AS INTEGER), name").all(),
    db.prepare("SELECT * FROM project_controls").all(),
    db.prepare("SELECT id, project_id, name, status, source, source_state, external_url, updated_by, updated_at FROM tasks ORDER BY CAST(id AS INTEGER), name").all(),
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
        sourceState: task.source_state || "",
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

async function getSettings(db, env) {
  const [recipients, notificationLog] = await Promise.all([
    db.prepare("SELECT email, created_by, created_at FROM notification_recipients ORDER BY email").all(),
    db.prepare("SELECT created_at, status, subject, recipient_count, provider_id, error FROM notification_log ORDER BY id DESC LIMIT 5").all()
  ]);
  return {
    notifications: {
      recipients: recipients.results.map(row => ({
        email: row.email,
        createdBy: row.created_by || "",
        createdAt: row.created_at || ""
      })),
      emailConfigured: notificationsConfigured(env),
      recent: notificationLog.results.map(row => ({
        createdAt: row.created_at || "",
        status: row.status || "",
        subject: row.subject || "",
        recipientCount: Number(row.recipient_count) || 0,
        providerId: row.provider_id || "",
        error: row.error || ""
      }))
    }
  };
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

async function updateTimeline(db, body) {
  const projectId = required(body.projectId, "projectId");
  const key = normalizeTimelineKey(required(body.key, "key"));
  const field = required(body.field, "field");
  if (!["start", "end", "status"].includes(field)) throw new Error(`Invalid timeline field: ${field}`);

  const existing = await db.prepare("SELECT start, end, status FROM timelines WHERE project_id = ? AND key = ?").bind(projectId, key).first();
  if (!existing) throw new Error(`Timeline row not found: ${projectId} / ${key}`);

  const value = field === "status" ? normalizeTimelineStatus(body.value) : normalizeStrictDate(body.value);
  const next = {
    start: field === "start" ? value : normalizeStrictDate(existing.start || ""),
    end: field === "end" ? value : normalizeStrictDate(existing.end || ""),
    status: field === "status" ? value : normalizeTimelineStatus(existing.status || "")
  };
  validateTimelineRange(next.start, next.end);

  const result = await db.prepare(`UPDATE timelines SET ${field} = ? WHERE project_id = ? AND key = ?`).bind(value, projectId, key).run();
  if (!result.meta || result.meta.changes === 0) throw new Error(`Timeline row not found: ${projectId} / ${key}`);
}

async function syncPulseTimelines(db, body) {
  const items = normalizePulseTimelineItems(body.items);
  if (!items.length) throw new Error("No Pulse timeline matches were provided.");

  const projectIds = [...new Set(items.map(item => item.projectId))];
  const placeholders = projectIds.map(() => "?").join(",");
  const existing = await db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).bind(...projectIds).all();
  const existingIds = new Set((existing.results || []).map(row => String(row.id)));
  const missing = projectIds.filter(id => !existingIds.has(id));
  if (missing.length) throw new Error(`Project not found for Pulse sync: ${missing.join(", ")}`);

  const statements = [];
  items.forEach(item => {
    item.timelines.forEach(timeline => {
      statements.push(
        db.prepare("UPDATE timelines SET start = ?, end = ? WHERE project_id = ? AND key = ?")
          .bind(timeline.date, timeline.date, item.projectId, timeline.key)
      );
    });
  });

  if (!statements.length) throw new Error("No valid Pulse dates were provided.");
  await db.batch(statements);
}

async function setProjectPhase(db, body) {
  const projectId = required(body.projectId, "projectId");
  const phase = normalizeProjectPhase(body.phase);
  const statements = WORK_PHASES.map((key, index) => {
    let status = "";
    if (phase !== "not-started") {
      const activeIndex = WORK_PHASES.indexOf(phase);
      if (index < activeIndex) status = "complete";
      else if (index === activeIndex) status = "active";
    }
    return db.prepare("UPDATE timelines SET status = ? WHERE project_id = ? AND key = ?").bind(status, projectId, key);
  });
  const results = await db.batch(statements);
  const changed = results.reduce((total, result) => total + (result.meta?.changes || 0), 0);
  if (changed === 0) throw new Error(`Timeline rows not found for project ${projectId}`);
}

function validateTimelineRange(start, end) {
  if (start && end && end < start) throw new Error("Schedule end date cannot be before the start date.");
}

async function addProject(db, body, actor) {
  const name = normalizeText(required(body.name, "name"));
  const projectGroup = normalizeText(body.projectGroup || "Other Projects");
  const segment = normalizeText(body.segment || "");
  const externalTeam = normalizeText(body.externalTeam || "");
  const startsAt = normalizeOptionalDate(body.startsAt || "");
  const endsAt = normalizeOptionalDate(body.endsAt || "");
  const next = await db.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS id FROM projects").first();
  const projectId = String(next.id);
  const updatedAt = currentIsoMinute();

  await db.batch([
    db.prepare("INSERT INTO projects (id, name, project_group, segment, external_team, percent, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)")
      .bind(projectId, name, projectGroup, segment, externalTeam, startsAt, endsAt),
    db.prepare("INSERT INTO project_controls (project_id, operating_state, blocked, override_daily, updated_at, updated_by) VALUES (?, 'Not Set', 0, 0, ?, ?)")
      .bind(projectId, updatedAt, actor.initials),
    db.prepare("INSERT INTO project_control_history (project_id, changed_at, field, old_value, new_value, changed_by) VALUES (?, ?, 'project', '', 'Created', ?)")
      .bind(projectId, updatedAt, actor.initials),
    db.prepare("INSERT INTO timelines (project_id, key, label, start, end, status) VALUES (?, 'prewire', 'Pre-Wire', '', '', '')")
      .bind(projectId),
    db.prepare("INSERT INTO timelines (project_id, key, label, start, end, status) VALUES (?, 'trim', 'Trim', '', '', '')")
      .bind(projectId),
    db.prepare("INSERT INTO timelines (project_id, key, label, start, end, status) VALUES (?, 'install', 'Install', '', '', '')")
      .bind(projectId)
  ]);
}

async function closeProject(db, body, actor) {
  const projectId = required(body.projectId, "projectId");
  const confirmed = body.confirmed === true;
  const acceptedMessage = normalizeText(body.confirmationMessage);
  const requiredMessage = "Are you sure you want to close this project? After this action you will no longer be able to access any data stored within the Command Center";
  if (!confirmed || acceptedMessage !== requiredMessage) throw new Error("Project close confirmation is required.");

  const project = await db.prepare("SELECT id, name FROM projects WHERE id = ?").bind(projectId).first();
  if (!project) throw new Error(`Project row not found: ${projectId}`);

  await db.batch([
    db.prepare("DELETE FROM tasks WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM timelines WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM risks WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM milestones WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM project_control_history WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM project_controls WHERE project_id = ?").bind(projectId),
    db.prepare("DELETE FROM projects WHERE id = ?").bind(projectId)
  ]);
}

async function addTask(db, body, actor, env) {
  const projectId = required(body.projectId, "projectId");
  const name = normalizeText(required(body.name, "name"));
  if (!name) throw new Error("Task name is required");
  const status = normalizeTaskStatus(body.status || "todo");
  const source = normalizeText(body.source || "Command Center");
  const next = await db.prepare("SELECT COALESCE(MAX(CAST(id AS INTEGER)), 0) + 1 AS id FROM tasks").first();
  const taskId = String(next.id);
  const updatedAt = currentIsoMinute();
  await db.prepare("INSERT INTO tasks (id, project_id, name, status, source, source_state, external_url, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(taskId, projectId, name, status, source, normalizeText(body.sourceState || ""), normalizeText(body.externalUrl || ""), actor.initials, updatedAt)
    .run();

  if (isManualTaskSource(source) && ["todo", "note"].includes(status)) {
    const project = await db.prepare("SELECT id, name FROM projects WHERE id = ?").bind(projectId).first();
    await sendTaskNotification(db, env, {
      projectId,
      projectName: project ? project.name : projectId,
      taskId,
      taskName: name,
      status,
      actorInitials: actor.initials,
      updatedAt
    });
  }
}

async function addNotificationRecipient(db, body, actor) {
  const email = normalizeEmail(required(body.email, "email"));
  await db.prepare("INSERT OR IGNORE INTO notification_recipients (email, created_by, created_at) VALUES (?, ?, ?)")
    .bind(email, actor.initials, currentIsoMinute())
    .run();
}

async function removeNotificationRecipient(db, body) {
  const email = normalizeEmail(required(body.email, "email"));
  await db.prepare("DELETE FROM notification_recipients WHERE email = ?").bind(email).run();
}

async function sendTaskNotification(db, env, task) {
  const fallbackSubject = `Command Center: New ${task.status === "note" ? "Note" : "To-Do"} - ${task.projectName}`;
  try {
    if (!notificationsConfigured(env)) {
      await recordNotification(db, {
        status: "skipped",
        subject: fallbackSubject,
        recipientCount: 0,
        error: "Email sending is not configured."
      });
      return;
    }
    const recipients = await db.prepare("SELECT email FROM notification_recipients ORDER BY email").all();
    const to = recipients.results.map(row => row.email).filter(Boolean);
    if (!to.length) {
      await recordNotification(db, {
        status: "skipped",
        subject: fallbackSubject,
        recipientCount: 0,
        error: "No notification recipients are configured."
      });
      return;
    }

    const typeLabel = task.status === "note" ? "Note" : "To-Do";
    const commandCenterUrl = normalizeText(env.COMMAND_CENTER_URL || "https://cknowlesati.github.io/WPR-Command-Center/");
    const subject = `Command Center: New ${typeLabel} - ${task.projectName}`;
    const text = [
      `A new ${typeLabel} was added in the WPR Command Center.`,
      "",
      `Project: ${task.projectName}`,
      `Added by: ${task.actorInitials}`,
      `Added: ${task.updatedAt}`,
      "",
      task.taskName,
      "",
      `Open Command Center: ${commandCenterUrl}`
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: env.NOTIFICATION_EMAIL_FROM,
        to,
        subject,
        text
      })
    });
    const responseText = await response.text();
    let responseData = {};
    try {
      responseData = JSON.parse(responseText || "{}");
    } catch {
      responseData = {};
    }
    if (!response.ok) {
      const message = responseData.message || responseText || `Resend returned ${response.status}`;
      await recordNotification(db, { status: "failed", subject, recipientCount: to.length, error: message });
      console.error("Task notification failed", response.status, responseText);
      return;
    }
    await recordNotification(db, { status: "sent", subject, recipientCount: to.length, providerId: responseData.id || "" });
  } catch (error) {
    await recordNotification(db, { status: "failed", subject: fallbackSubject, recipientCount: 0, error: error.message || String(error) });
    console.error("Task notification failed", error);
  }
}

async function recordNotification(db, event) {
  await db.prepare("INSERT INTO notification_log (created_at, status, subject, recipient_count, provider_id, error) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(currentIsoMinute(), event.status || "unknown", normalizeText(event.subject || ""), Number(event.recipientCount) || 0, normalizeText(event.providerId || ""), normalizeText(event.error || "").slice(0, 500))
    .run();
}

async function updateTask(db, body, actor) {
  const taskId = required(body.taskId, "taskId");
  const field = required(body.field, "field");
  if (!["name", "status"].includes(field)) throw new Error(`Invalid task field: ${field}`);
  const existing = await db.prepare("SELECT source FROM tasks WHERE id = ?").bind(taskId).first();
  if (!existing) throw new Error(`Task row not found: ${taskId}`);
  if (!isManualTaskSource(existing.source)) throw new Error("Synced Pulse and Procore items cannot be edited in Command Center.");
  const column = field === "name" ? "name" : "status";
  const value = field === "status" ? normalizeTaskStatus(body.value) : normalizeText(body.value);
  if (field === "name" && !value) throw new Error("Task name is required");
  const result = await db.prepare(`UPDATE tasks SET ${column} = ?, updated_by = ?, updated_at = ? WHERE id = ?`).bind(value, actor.initials, currentIsoMinute(), taskId).run();
  if (!result.meta || result.meta.changes === 0) throw new Error(`Task row not found: ${taskId}`);
}

async function syncSourceTasks(db, body) {
  const { source, tasks, replaceProjectIds } = normalizeSourceTaskSync(body);
  if (!tasks.length && !replaceProjectIds.length) throw new Error("No synced source tasks were provided.");

  const projectIds = [...new Set([...replaceProjectIds, ...tasks.map(task => task.projectId)])];
  const placeholders = projectIds.map(() => "?").join(",");
  const existing = await db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).bind(...projectIds).all();
  const existingIds = new Set((existing.results || []).map(row => String(row.id)));
  const missing = projectIds.filter(id => !existingIds.has(id));
  if (missing.length) throw new Error(`Project not found for source sync: ${missing.join(", ")}`);

  const now = currentIsoMinute();
  const sourcePlaceholders = source.values.map(() => "?").join(",");
  const statements = [];

  if (replaceProjectIds.length) {
    const projectPlaceholders = replaceProjectIds.map(() => "?").join(",");
    statements.push(
      db.prepare(`DELETE FROM tasks WHERE source IN (${sourcePlaceholders}) AND project_id IN (${projectPlaceholders})`)
        .bind(...source.values, ...replaceProjectIds)
    );
  }

  tasks.forEach(task => {
    statements.push(
      db.prepare(`
        INSERT INTO tasks (id, project_id, name, status, source, source_state, external_url, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'SYNC', ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          status = excluded.status,
          source = excluded.source,
          source_state = excluded.source_state,
          external_url = excluded.external_url,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).bind(task.id, task.projectId, task.name, task.status, source.primary, task.sourceState, task.externalUrl, now)
    );
  });

  await db.batch(statements);
}

async function deleteById(db, table, id) {
  const result = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(required(id, "id")).run();
  if (!result.meta || result.meta.changes === 0) throw new Error(`${table} row not found: ${id}`);
}

async function ensureControlRow(db, projectId) {
  await db.prepare("INSERT OR IGNORE INTO project_controls (project_id, operating_state, blocked, override_daily) VALUES (?, 'Not Set', 0, 0)")
    .bind(projectId)
    .run();
}

function toControl(projectId, row = {}) {
  return {
    projectId,
    nextOutcome: row.next_outcome || "",
    nextMoveOwner: row.next_move_owner || "",
    operatingState: row.operating_state || "Not Set",
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
  if (field === "operatingState" && !["Not Set", "Action Needed", "Follow-Up Needed", "Monitor", "Stable"].includes(value)) {
    throw new Error("Invalid operating state");
  }
}

function normalizeTaskStatus(value) {
  const status = normalizeText(value);
  return ["todo", "note", "done"].includes(status) ? status : "todo";
}

function normalizeTimelineKey(value) {
  const key = normalizeText(value);
  if (["prewire", "trim", "handover", "install"].includes(key)) return key;
  throw new Error(`Invalid timeline key: ${key}`);
}

function normalizeTimelineStatus(value) {
  const status = normalizeText(value);
  if (!status || status === "active" || status === "complete") return status;
  throw new Error(`Invalid timeline status: ${status}`);
}

function normalizePulseTimelineItems(items) {
  if (!Array.isArray(items)) throw new Error("Pulse sync items must be an array.");
  return items.slice(0, 100).map((item, index) => {
    const projectId = required(item && item.projectId, `items[${index}].projectId`);
    const timelines = Array.isArray(item && item.timelines) ? item.timelines : [];
    return {
      projectId,
      timelines: timelines.map((timeline, timelineIndex) => ({
        key: normalizeTimelineKey(required(timeline && timeline.key, `items[${index}].timelines[${timelineIndex}].key`)),
        date: normalizeStrictDate(timeline && timeline.date)
      })).filter(timeline => WORK_PHASES.includes(timeline.key))
    };
  }).filter(item => item.timelines.length);
}

function normalizeSourceTaskSync(body) {
  const source = normalizeSyncedTaskSource(body.source);
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 1000).map((task, index) => ({
    id: normalizeSyncedTaskId(source.primary, required(task && task.id, `tasks[${index}].id`)),
    projectId: required(task && task.projectId, `tasks[${index}].projectId`),
    name: normalizeText(required(task && task.name, `tasks[${index}].name`)).slice(0, 500),
    status: normalizeSyncedTaskStatus(task && task.status),
    sourceState: normalizeText(task && task.sourceState || "").slice(0, 120),
    externalUrl: normalizeText(task && task.externalUrl || "").slice(0, 1000)
  })) : [];
  const replaceProjectIds = Array.isArray(body.replaceProjectIds) ? [...new Set(body.replaceProjectIds.map(value => required(value, "replaceProjectIds[]")))] : [];
  return { source, tasks, replaceProjectIds };
}

function normalizeSyncedTaskSource(value) {
  const source = normalizeText(value).toLowerCase();
  if (source === "pulse") return { primary: "pulse", values: ["pulse", "Pulse"] };
  if (source === "procore" || source === "procore-review") return { primary: "procore", values: ["procore", "procore-review", "Procore"] };
  throw new Error(`Invalid synced task source: ${source}`);
}

function normalizeSyncedTaskId(source, value) {
  const id = normalizeText(value).replace(/\s+/g, "-").slice(0, 120);
  if (!id) throw new Error("Synced task id is required");
  return id.startsWith(`${source}-`) ? id : `${source}-${id}`;
}

function normalizeSyncedTaskStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (["done", "closed", "complete", "completed"].includes(status)) return "done";
  if (["progress", "in-progress", "in progress", "ready for review", "review"].includes(status)) return "progress";
  return "todo";
}

function normalizeProjectPhase(value) {
  const phase = normalizeText(value);
  if (phase === "not-started" || WORK_PHASES.includes(phase)) return phase;
  throw new Error(`Invalid project phase: ${phase}`);
}

function isManualTaskSource(source) {
  const text = normalizeText(source);
  return !text || text === "Command Center";
}

function notificationsConfigured(env) {
  return !!(normalizeText(env.RESEND_API_KEY) && normalizeText(env.NOTIFICATION_EMAIL_FROM));
}

function normalizeEmail(value) {
  const email = normalizeText(value).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("A valid email address is required.");
  return email;
}

function normalizeOperatingState(value) {
  const state = normalizeText(value);
  return ["Not Set", "Action Needed", "Follow-Up Needed", "Monitor", "Stable"].includes(state) ? state : "Not Set";
}

function normalizeOptionalDate(value) {
  const text = normalizeText(value);
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function normalizeStrictDate(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`Invalid date format: ${text}`);
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) throw new Error(`Invalid date: ${text}`);
  return text;
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

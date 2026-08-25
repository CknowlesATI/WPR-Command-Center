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
        return json({ ok: true, data: await getAllData(env.DB), settings: await getReadableSettings(request, env.DB, env) });
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
  if (body.action === "syncPulseTimelines") return syncPulseTimelines(db, body, actor);
  if (body.action === "syncPulseContractStatuses") return syncPulseContractStatuses(db, body, actor);
  if (body.action === "setProjectPhase") return setProjectPhase(db, body);
  if (body.action === "addProject") return addProject(db, body, actor);
  if (body.action === "closeProject") return closeProject(db, body, actor);
  if (body.action === "addTask") return addTask(db, body, actor, env);
  if (body.action === "updateTask") return updateTask(db, body, actor);
  if (body.action === "syncSourceTasks") return syncSourceTasks(db, body, actor);
  if (body.action === "deleteTask") return deleteTask(db, body.taskId);
  if (body.action === "recordSyncRun") return recordSyncRun(db, body, actor);
  if (body.action === "addNotificationRecipient") return addNotificationRecipient(db, body, actor);
  if (body.action === "removeNotificationRecipient") return removeNotificationRecipient(db, body);

  throw new Error(`Unknown action: ${body.action}`);
}

async function getAllData(db) {
  const [projects, controls, tasks, timelines, risks, milestones] = await Promise.all([
    db.prepare("SELECT * FROM projects ORDER BY CAST(id AS INTEGER), name").all(),
    db.prepare("SELECT * FROM project_controls").all(),
    db.prepare("SELECT id, project_id, name, status, source, source_state, external_url, due_date, priority, assignee, source_updated_at, updated_by, updated_at FROM tasks ORDER BY CAST(id AS INTEGER), name").all(),
    db.prepare("SELECT * FROM timelines ORDER BY project_id, key").all(),
    db.prepare("SELECT * FROM risks ORDER BY CAST(id AS INTEGER), title").all(),
    db.prepare("SELECT * FROM milestones ORDER BY project_id, date").all()
  ]);

  const controlsByProject = mapBy(controls.results, "project_id");

  return projects.results.filter(isDashboardProject).map(project => {
    const projectTasks = tasks.results.filter(task => String(task.project_id) === String(project.id));
    const taskSignals = buildTaskSignals(projectTasks);
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
      overdueTasks: taskSignals.overdueTasks,
      highPriorityTasks: taskSignals.highPriorityTasks,
      attention: taskSignals.attention,
      taskList: projectTasks.map(task => ({
        id: task.id,
        name: task.name,
        status: task.status,
        source: task.source || "",
        sourceState: task.source_state || "",
        externalUrl: task.external_url || "",
        dueDate: task.due_date || "",
        priority: task.priority || "",
        assignee: task.assignee || "",
        sourceUpdatedAt: task.source_updated_at || "",
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

function buildTaskSignals(tasks) {
  const activeTasks = tasks.filter(task => task.status !== "done");
  const overdueTasks = activeTasks.filter(task => isPastDate(task.due_date)).length;
  const highPriorityTasks = activeTasks.filter(task => isActionPriority(task.priority)).length;
  const attention = activeTasks
    .filter(task => isActionPriority(task.priority) || isPastDate(task.due_date))
    .map(task => ({
      severity: isPastDate(task.due_date) ? "red" : prioritySeverity(task.priority),
      label: isPastDate(task.due_date) ? "Overdue task" : taskPriorityLabel(task.priority),
      detail: task.name || "Task needs review",
      dueDate: task.due_date || "",
      source: sourceLabel(task.source)
    }))
    .sort((a, b) => severityScore(b.severity) - severityScore(a.severity) || String(a.dueDate || "9999-12-31").localeCompare(String(b.dueDate || "9999-12-31")))
    .slice(0, 20);
  return { overdueTasks, highPriorityTasks, attention };
}

function isActionPriority(value) {
  return ["high", "new", "due-soon", "needs-action", "critical-aging"].includes(normalizeTaskPriority(value));
}

function taskPriorityLabel(value) {
  const priority = normalizeTaskPriority(value);
  if (priority === "critical-aging") return "Critical aging";
  if (priority === "needs-action") return "Needs action";
  if (priority === "due-soon") return "Due soon";
  if (priority === "new") return "New";
  if (priority === "high") return "High priority";
  if (priority === "medium") return "Medium priority";
  if (priority === "low") return "Low priority";
  return "Attention";
}

function prioritySeverity(value) {
  const priority = normalizeTaskPriority(value);
  if (priority === "critical-aging" || priority === "high") return "red";
  if (priority === "needs-action" || priority === "due-soon") return "amber";
  return "green";
}

function isPastDate(value) {
  const date = parseDateOnly(value);
  if (!date) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return date < today;
}

function parseDateOnly(value) {
  const text = normalizeOptionalDate(value);
  if (!text) return null;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function severityScore(severity) {
  if (severity === "red") return 3;
  if (severity === "amber") return 2;
  return 1;
}

async function getSettings(db, env) {
  const [recipients, notificationLog, sources] = await Promise.all([
    db.prepare("SELECT email, created_by, created_at FROM notification_recipients ORDER BY email").all(),
    db.prepare("SELECT created_at, status, subject, recipient_count, provider_id, error FROM notification_log ORDER BY id DESC LIMIT 5").all(),
    getSourceStatus(db)
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
    },
    sources
  };
}

async function getPublicSettings(db, env) {
  return {
    notifications: {
      recipients: [],
      emailConfigured: notificationsConfigured(env),
      recent: []
    },
    sources: await getSourceStatus(db)
  };
}

async function getReadableSettings(request, db, env) {
  const expectedCode = normalizeText(env.ACCESS_CODE || env.WRITE_TOKEN || "");
  const session = request.headers.get("x-command-center-session") || "";
  if (expectedCode && session && await verifySession(session, env)) return getSettings(db, env);
  return getPublicSettings(db, env);
}

async function getSourceStatus(db) {
  const rows = await db.prepare(`
    SELECT source, label, status, last_attempt_at, last_success_at, records_seen, records_written, project_count, message, updated_at, updated_by
    FROM sync_runs
    ORDER BY CASE source WHEN 'pulse' THEN 1 WHEN 'procore' THEN 2 ELSE 3 END, source
  `).all();
  return (rows.results || []).map(row => ({
    source: row.source || "",
    label: row.label || sourceLabel(row.source),
    status: row.status || "unknown",
    lastAttemptAt: row.last_attempt_at || "",
    lastSuccessAt: row.last_success_at || "",
    recordsSeen: Number(row.records_seen) || 0,
    recordsWritten: Number(row.records_written) || 0,
    projectCount: Number(row.project_count) || 0,
    message: row.message || "",
    updatedAt: row.updated_at || "",
    updatedBy: row.updated_by || ""
  }));
}

async function recordSyncRun(db, body, actor) {
  return upsertSyncRun(db, normalizeSyncRun(body), actor);
}

async function upsertSyncRun(db, run, actor) {
  const now = new Date().toISOString();
  const attemptedAt = run.at || now;
  const successAt = run.status === "success" ? attemptedAt : "";
  await db.prepare(`
    INSERT INTO sync_runs (source, label, status, last_attempt_at, last_success_at, records_seen, records_written, project_count, message, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      label = excluded.label,
      status = excluded.status,
      last_attempt_at = excluded.last_attempt_at,
      last_success_at = CASE WHEN excluded.status = 'success' THEN excluded.last_success_at ELSE sync_runs.last_success_at END,
      records_seen = excluded.records_seen,
      records_written = excluded.records_written,
      project_count = excluded.project_count,
      message = excluded.message,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `).bind(
    run.source,
    run.label || sourceLabel(run.source),
    run.status,
    attemptedAt,
    successAt,
    run.recordsSeen,
    run.recordsWritten,
    run.projectCount,
    run.message,
    now,
    actor.initials
  ).run();
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

async function syncPulseTimelines(db, body, actor) {
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
  await upsertSyncRun(db, {
    source: "pulse",
    label: "Pulse",
    status: "success",
    recordsSeen: items.length,
    recordsWritten: statements.length,
    projectCount: projectIds.length,
    message: `Updated ${statements.length} timeline date(s).`
  }, actor);
}

async function syncPulseContractStatuses(db, body, actor) {
  const items = normalizePulseContractStatusItems(body.items);
  if (!items.length) throw new Error("No Pulse contract status matches were provided.");

  const projectIds = [...new Set(items.map(item => item.projectId))];
  const placeholders = projectIds.map(() => "?").join(",");
  const existing = await db.prepare(`SELECT project_id, contract_status FROM project_controls WHERE project_id IN (${placeholders})`).bind(...projectIds).all();
  const controlsByProject = mapBy(existing.results || [], "project_id");
  const projectRows = await db.prepare(`SELECT id FROM projects WHERE id IN (${placeholders})`).bind(...projectIds).all();
  const existingIds = new Set((projectRows.results || []).map(row => String(row.id)));
  const missing = projectIds.filter(id => !existingIds.has(id));
  if (missing.length) throw new Error(`Project not found for Pulse contract sync: ${missing.join(", ")}`);

  const updatedAt = currentIsoMinute();
  const statements = [];
  items.forEach(item => {
    const existingControl = controlsByProject.get(String(item.projectId)) || {};
    const oldValue = normalizeText(existingControl.contract_status || "");
    if (oldValue === item.contractStatus) return;

    statements.push(
      db.prepare("INSERT OR IGNORE INTO project_controls (project_id, operating_state, blocked, override_daily, updated_at, updated_by) VALUES (?, 'Not Set', 0, 0, ?, ?)")
        .bind(item.projectId, updatedAt, actor.initials),
      db.prepare("UPDATE project_controls SET contract_status = ?, updated_at = ?, updated_by = ? WHERE project_id = ?")
        .bind(item.contractStatus, updatedAt, actor.initials, item.projectId),
      db.prepare("INSERT INTO project_control_history (project_id, changed_at, field, old_value, new_value, changed_by) VALUES (?, ?, 'contractStatus', ?, ?, ?)")
        .bind(item.projectId, updatedAt, oldValue, item.contractStatus, actor.initials)
    );
  });

  if (!statements.length) return;
  await db.batch(statements);
  await upsertSyncRun(db, {
    source: "pulse",
    label: "Pulse",
    status: "success",
    recordsSeen: items.length,
    recordsWritten: statements.length / 3,
    projectCount: projectIds.length,
    message: `Updated ${statements.length / 3} contract status(es).`
  }, actor);
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

async function deleteTask(db, taskIdValue) {
  const taskId = required(taskIdValue, "taskId");
  const existing = await db.prepare("SELECT source FROM tasks WHERE id = ?").bind(taskId).first();
  if (!existing) throw new Error(`Task row not found: ${taskId}`);
  if (!isManualTaskSource(existing.source)) throw new Error("Synced Pulse and Procore items cannot be deleted in Command Center.");
  return deleteById(db, "tasks", taskId);
}

async function syncSourceTasks(db, body, actor) {
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
        INSERT INTO tasks (id, project_id, name, status, source, source_state, external_url, due_date, priority, assignee, source_updated_at, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SYNC', ?)
        ON CONFLICT(id) DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          status = excluded.status,
          source = excluded.source,
          source_state = excluded.source_state,
          external_url = excluded.external_url,
          due_date = excluded.due_date,
          priority = excluded.priority,
          assignee = excluded.assignee,
          source_updated_at = excluded.source_updated_at,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at
      `).bind(task.id, task.projectId, task.name, task.status, source.primary, task.sourceState, task.externalUrl, task.dueDate, task.priority, task.assignee, task.sourceUpdatedAt, now)
    );
  });

  await db.batch(statements);
  await upsertSyncRun(db, {
    source: source.primary,
    label: source.primary === "procore" ? "Procore" : "Pulse",
    status: "success",
    recordsSeen: tasks.length,
    recordsWritten: tasks.length,
    projectCount: projectIds.length,
    message: `Synced ${tasks.length} item(s) across ${projectIds.length} project scope(s).`
  }, actor);
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
  if (!expectedCode) throw unauthorized("Command Center write access is not configured.");

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

function normalizePulseContractStatusItems(items) {
  if (!Array.isArray(items)) throw new Error("Pulse contract status items must be an array.");
  return items.slice(0, 100).map((item, index) => {
    const projectId = required(item && item.projectId, `items[${index}].projectId`);
    const contractStatus = normalizeText(required(item && item.contractStatus, `items[${index}].contractStatus`));
    if (contractStatus !== "Accepted") throw new Error(`Invalid Pulse contract status: ${contractStatus}`);
    return { projectId, contractStatus };
  });
}

function normalizeSourceTaskSync(body) {
  const source = normalizeSyncedTaskSource(body.source);
  const tasks = Array.isArray(body.tasks) ? body.tasks.slice(0, 1000).map((task, index) => ({
    id: normalizeSyncedTaskId(source.primary, required(task && task.id, `tasks[${index}].id`)),
    projectId: required(task && task.projectId, `tasks[${index}].projectId`),
    name: normalizeText(required(task && task.name, `tasks[${index}].name`)).slice(0, 500),
    status: normalizeSyncedTaskStatus(task && task.status),
    sourceState: normalizeText(task && task.sourceState || "").slice(0, 120),
    externalUrl: normalizeText(task && task.externalUrl || "").slice(0, 1000),
    dueDate: normalizeOptionalDate(task && (task.dueDate || task.due_date) || ""),
    priority: normalizeTaskPriority(task && task.priority),
    assignee: normalizeText(task && task.assignee || "").slice(0, 160),
    sourceUpdatedAt: normalizeText(task && (task.sourceUpdatedAt || task.source_updated_at) || "").slice(0, 80)
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

function normalizeSyncRun(body) {
  const source = normalizeSyncRunSource(body.source);
  return {
    source,
    label: normalizeText(body.label || sourceLabel(source)).slice(0, 80),
    status: normalizeSyncRunStatus(body.status),
    at: normalizeIsoTimestamp(body.at || ""),
    recordsSeen: clampCount(body.recordsSeen),
    recordsWritten: clampCount(body.recordsWritten),
    projectCount: clampCount(body.projectCount),
    message: normalizeText(body.message || "").slice(0, 500)
  };
}

function normalizeSyncRunSource(value) {
  const source = normalizeText(value).toLowerCase();
  if (source === "pulse") return "pulse";
  if (source === "procore" || source === "procore-review") return "procore";
  throw new Error(`Invalid sync source: ${source}`);
}

function normalizeSyncRunStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (["success", "failed", "skipped", "requested"].includes(status)) return status;
  return "unknown";
}

function normalizeIsoTimestamp(value) {
  const text = normalizeText(value);
  if (!text) return "";
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${text}`);
  return date.toISOString();
}

function clampCount(value) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return Math.min(count, 1000000);
}

function sourceLabel(source) {
  if (source === "pulse") return "Pulse";
  if (source === "procore") return "Procore";
  return source || "Source";
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

function normalizeTaskPriority(value) {
  const text = normalizeText(value).toLowerCase();
  if (["new", "due-soon", "needs-action", "critical-aging"].includes(text)) return text;
  if (["urgent", "high"].includes(text)) return "high";
  if (["normal", "medium", "med"].includes(text)) return "medium";
  if (text === "low") return "low";
  return "";
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

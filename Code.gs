/*
  Project Command Center - Google Sheets backend (Google Apps Script)
  ------------------------------------------------------------------
  This file is NOT a standalone program you run on your computer. It's code
  that lives inside a Google Sheet and turns that Sheet into a tiny web API
  that the Project Command Center HTML app can read from and write to.

  SETUP (see CLASP_SETUP.md for the full walkthrough):
  1. Create a new Google Sheet, name it "Project Command Center Data".
  2. Extensions > Apps Script. Delete any starter code, paste this whole file in.
  3. In the function dropdown at the top, select "seedData", click Run once.
     This builds the 5 tabs and loads your 17 WPR projects.
  4. Deploy > New deployment > Web app.
       Execute as: Me
       Who has access: Anyone with the link
  5. Copy the URL it gives you - that's your API_URL for the HTML app.
*/

// ---------- Web API ----------

function doGet(e) {
  return respond(getAllData());
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (body.action === "updateTimeline") updateTimeline(body);
    else if (body.action === "updateRiskDue") updateRiskDue(body);
    else if (body.action === "updateProjectField") updateProjectField(body);
    else if (body.action === "addTask") addTask(body);
    else if (body.action === "updateTask") updateTask(body);
    else if (body.action === "deleteTask") deleteById("Tasks", body.taskId);
    else if (body.action === "addRisk") addRisk(body);
    else if (body.action === "updateRisk") updateRisk(body);
    else if (body.action === "deleteRisk") deleteById("Risks", body.riskId);
    else if (body.action === "addMilestone") addMilestone(body);
    else if (body.action === "updateMilestone") updateMilestone(body);
    else if (body.action === "deleteMilestone") deleteById("Milestones", body.milestoneId);
    else if (body.action === "addProject") addProject(body);
    else throw new Error("Unknown action: " + body.action);
    return respond({ ok: true, data: getAllData() });
  } catch (err) {
    return respond({ ok: false, error: err.message || String(err) });
  }
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------- Reading data ----------

function sheet(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error("Missing sheet tab: " + name);
  return sh;
}

function readRows(name) {
  const sh = sheet(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 1) return [];
  const headers = values[0];
  return values.slice(1)
    .filter(row => row[0] !== "" && row[0] !== null)
    .map(row => {
      const obj = {};
      headers.forEach((h, i) => obj[h] = normalizeCell(row[i]));
      return obj;
    });
}

function normalizeCell(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
  }
  return value;
}

function getAllData() {
  ensureProjectSchema();
  ensureTimelineSchema();
  ensureTaskSchema();
  ensureMilestoneSchema();
  const projects = readRows("Projects");
  const timelines = readRows("Timelines");
  const tasks = readRows("Tasks");
  const risks = readRows("Risks");
  const milestones = readRows("Milestones");

  return projects.map(p => ({
    id: p.id,
    name: p.name,
    projectGroup: p.projectGroup || defaultProjectMeta(p.name).projectGroup,
    segment: p.segment || defaultProjectMeta(p.name).segment,
    externalTeam: p.externalTeam || defaultProjectMeta(p.name).externalTeam,
    percent: Number(p.percent) || 0,
    startsAt: p.startsAt || null,
    endsAt: p.endsAt || null,
    milestones: milestones
      .filter(m => String(m.projectId) === String(p.id))
      .map(m => ({ id: m.id, name: m.name, date: m.date, state: m.state })),
    tasks: {
      todo: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "todo").length,
      progress: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "progress").length,
      done: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "done").length,
    },
    taskList: tasks
      .filter(t => String(t.projectId) === String(p.id))
      .map(t => ({ id: t.id, name: t.name, status: t.status })),
    timelines: timelines
      .filter(t => String(t.projectId) === String(p.id) && phaseKeysForGroup(p.projectGroup || defaultProjectMeta(p.name).projectGroup).indexOf(t.key) !== -1)
      .map(t => ({ key: t.key, label: t.label, start: t.start || null, end: t.end || null, status: t.status || "" })),
    risks: risks
      .filter(r => String(r.projectId) === String(p.id))
      .map(r => ({ id: r.id, title: r.title, severity: r.severity, owner: r.owner, note: r.note, due: r.due || null })),
  }));
}

// ---------- Writing data (only the fields the app can edit today) ----------

function updateProjectField(body) {
  ensureProjectSchema();
  const projectId = requireValue(body.projectId, "projectId");
  const field = requireValue(body.field, "field");
  const allowedFields = ["projectGroup", "segment", "externalTeam", "startsAt", "endsAt"];
  if (allowedFields.indexOf(field) === -1) throw new Error("Invalid project field: " + field);
  let value = body.value || "";
  if (field === "startsAt" || field === "endsAt") value = normalizeDateValue(value, false);
  else value = String(value).trim();

  const sh = sheet("Projects");
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = columnIndex(headers, "id");
  const writeCol = columnIndex(headers, field);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(projectId)) {
      sh.getRange(i + 1, writeCol + 1).setValue(value);
      return;
    }
  }
  throw new Error("Project row not found: " + projectId);
}

function updateTimeline(body) {
  ensureTimelineSchema();
  const projectId = requireValue(body.projectId, "projectId");
  const key = requireValue(body.key, "key");
  const field = requireValue(body.field, "field");
  if (["start", "end", "status"].indexOf(field) === -1) throw new Error("Invalid timeline field: " + field);
  const value = field === "status" ? normalizeTimelineStatus(body.value) : normalizeDateValue(body.value, false);
  const sh = sheet("Timelines");
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const projectCol = columnIndex(headers, "projectId");
  const keyCol = columnIndex(headers, "key");
  const writeCol = columnIndex(headers, field);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][projectCol]) === String(projectId) && String(values[i][keyCol]) === String(key)) {
      sh.getRange(i + 1, writeCol + 1).setValue(value);
      return;
    }
  }
  throw new Error("Timeline row not found for project " + projectId + " / " + key);
}

function updateRiskDue(body) {
  const riskId = requireValue(body.riskId, "riskId");
  const value = normalizeDateValue(body.value, true);
  const sh = sheet("Risks");
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = columnIndex(headers, "id");
  const dueCol = columnIndex(headers, "due");
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(riskId)) {
      sh.getRange(i + 1, dueCol + 1).setValue(value);
      return;
    }
  }
  throw new Error("Risk row not found: " + riskId);
}

function addTask(body) {
  ensureTaskSchema();
  const projectId = requireValue(body.projectId, "projectId");
  const name = String(requireValue(body.name, "name")).trim();
  const status = normalizeTaskStatus(body.status || "todo");
  appendRowByHeaders("Tasks", { id: nextId("Tasks"), projectId, name, status });
}

function updateTask(body) {
  ensureTaskSchema();
  const taskId = requireValue(body.taskId, "taskId");
  const field = requireValue(body.field, "field");
  if (["name", "status"].indexOf(field) === -1) throw new Error("Invalid task field: " + field);
  const value = field === "status" ? normalizeTaskStatus(body.value) : String(body.value || "").trim();
  if (field === "name" && !value) throw new Error("Task name is required");
  updateById("Tasks", taskId, field, value);
}

function addRisk(body) {
  const projectId = requireValue(body.projectId, "projectId");
  const title = String(requireValue(body.title, "title")).trim();
  appendRowByHeaders("Risks", {
    id: nextId("Risks"),
    projectId,
    title,
    severity: normalizeRiskSeverity(body.severity || "medium"),
    owner: String(body.owner || "").trim(),
    note: String(body.note || "").trim(),
    due: normalizeDateValue(body.due, true)
  });
}

function updateRisk(body) {
  const riskId = requireValue(body.riskId, "riskId");
  const field = requireValue(body.field, "field");
  if (["title", "severity", "owner", "note", "due"].indexOf(field) === -1) throw new Error("Invalid risk field: " + field);
  let value = body.value || "";
  if (field === "severity") value = normalizeRiskSeverity(value);
  else if (field === "due") value = normalizeDateValue(value, true);
  else value = String(value).trim();
  if (field === "title" && !value) throw new Error("Risk title is required");
  updateById("Risks", riskId, field, value);
}

function addMilestone(body) {
  ensureMilestoneSchema();
  const projectId = requireValue(body.projectId, "projectId");
  const name = String(requireValue(body.name, "name")).trim();
  appendRowByHeaders("Milestones", {
    projectId,
    name,
    date: normalizeDateValue(body.date, false),
    state: normalizeMilestoneState(body.state || "future"),
    id: nextId("Milestones")
  });
}

function updateMilestone(body) {
  ensureMilestoneSchema();
  const milestoneId = requireValue(body.milestoneId, "milestoneId");
  const field = requireValue(body.field, "field");
  if (["name", "date", "state"].indexOf(field) === -1) throw new Error("Invalid milestone field: " + field);
  let value = body.value || "";
  if (field === "date") value = normalizeDateValue(value, false);
  else if (field === "state") value = normalizeMilestoneState(value);
  else value = String(value).trim();
  if (field === "name" && !value) throw new Error("Milestone name is required");
  updateById("Milestones", milestoneId, field, value);
}

function addProject(body) {
  const name = (body.name || "").toString().trim();
  if (!name) throw new Error("Project name is required");
  const meta = defaultProjectMeta(name);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
  ensureProjectSchema();
  const projSheet = sheet("Projects");
  const values = projSheet.getDataRange().getValues();
  const headers = values[0];
  const row = headers.map(h => {
    if (h === "id") return "";
    if (h === "name") return name;
    if (h === "projectGroup") return meta.projectGroup;
    if (h === "segment") return meta.segment;
    if (h === "externalTeam") return meta.externalTeam;
    if (h === "percent") return 0;
    return "";
  });
  let maxId = 0;
  const idCol = columnIndex(headers, "id");
  for (let i = 1; i < values.length; i++) {
    const id = Number(values[i][idCol]);
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;
  row[idCol] = newId;
  projSheet.appendRow(row);

  ensureTimelineSchema();
  const tlSheet = sheet("Timelines");
  const phaseDefs = phaseDefsForGroup(meta.projectGroup);
  phaseDefs.forEach(([key, label]) => tlSheet.appendRow([newId, key, label, "", "", ""]));
  } finally {
    lock.releaseLock();
  }
}

function requireValue(value, name) {
  if (value === undefined || value === null || value === "") throw new Error("Missing required field: " + name);
  return value;
}

function columnIndex(headers, name) {
  const idx = headers.indexOf(name);
  if (idx === -1) throw new Error("Missing required column: " + name);
  return idx;
}

function normalizeDateValue(value, allowDateTime) {
  if (!value) return "";
  const text = String(value).trim();
  const pattern = allowDateTime ? /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/ : /^\d{4}-\d{2}-\d{2}$/;
  if (!pattern.test(text)) throw new Error("Invalid date format: " + text);
  return text;
}

function normalizeTimelineStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text === "complete") return text;
  throw new Error("Invalid timeline status: " + text);
}

function normalizeTaskStatus(value) {
  const text = String(value || "").trim();
  if (["todo", "progress", "done"].indexOf(text) === -1) throw new Error("Invalid task status: " + text);
  return text;
}

function normalizeRiskSeverity(value) {
  const text = String(value || "").trim();
  if (["low", "medium", "high"].indexOf(text) === -1) throw new Error("Invalid risk severity: " + text);
  return text;
}

function normalizeMilestoneState(value) {
  const text = String(value || "").trim();
  if (["done", "next", "future"].indexOf(text) === -1) throw new Error("Invalid milestone state: " + text);
  return text;
}

function appendRowByHeaders(sheetName, valuesByHeader) {
  const sh = sheet(sheetName);
  const headers = sh.getDataRange().getValues()[0];
  sh.appendRow(headers.map(h => valuesByHeader[h] === undefined ? "" : valuesByHeader[h]));
}

function updateById(sheetName, id, field, value) {
  const sh = sheet(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = columnIndex(headers, "id");
  const writeCol = columnIndex(headers, field);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(id)) {
      sh.getRange(i + 1, writeCol + 1).setValue(value);
      return;
    }
  }
  throw new Error(sheetName + " row not found: " + id);
}

function deleteById(sheetName, id) {
  id = requireValue(id, "id");
  const sh = sheet(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = columnIndex(headers, "id");
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(id)) {
      sh.deleteRow(i + 1);
      return;
    }
  }
  throw new Error(sheetName + " row not found: " + id);
}

function nextId(sheetName) {
  const sh = sheet(sheetName);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idCol = columnIndex(headers, "id");
  let maxId = 0;
  for (let i = 1; i < values.length; i++) {
    const id = Number(values[i][idCol]);
    if (id > maxId) maxId = id;
  }
  return maxId + 1;
}

function ensureProjectSchema() {
  const sh = sheet("Projects");
  const values = sh.getDataRange().getValues();
  if (!values.length) throw new Error("Projects sheet is empty");
  const required = ["projectGroup", "segment", "externalTeam"];
  let headers = values[0];
  required.forEach(name => {
    if (headers.indexOf(name) === -1) {
      sh.getRange(1, headers.length + 1).setValue(name);
      headers.push(name);
    }
  });
  values.slice(1).forEach((row, i) => {
    const name = row[columnIndex(headers, "name")];
    const meta = defaultProjectMeta(name);
    required.forEach(field => {
      const col = columnIndex(headers, field);
      if (!row[col]) sh.getRange(i + 2, col + 1).setValue(meta[field]);
    });
  });
}

function ensureTimelineSchema() {
  const sh = sheet("Timelines");
  const values = sh.getDataRange().getValues();
  if (!values.length) throw new Error("Timelines sheet is empty");
  const headers = values[0];
  if (headers.indexOf("status") === -1) {
    sh.getRange(1, headers.length + 1).setValue("status");
  }
}

function ensureTaskSchema() {
  ensureIdColumn("Tasks");
}

function ensureMilestoneSchema() {
  ensureIdColumn("Milestones");
}

function ensureIdColumn(sheetName) {
  const sh = sheet(sheetName);
  const values = sh.getDataRange().getValues();
  if (!values.length) throw new Error(sheetName + " sheet is empty");
  const headers = values[0];
  let idCol = headers.indexOf("id");
  if (idCol === -1) {
    idCol = headers.length;
    sh.getRange(1, idCol + 1).setValue("id");
    headers.push("id");
  }
  let maxId = 0;
  for (let i = 1; i < values.length; i++) {
    const id = Number(values[i][idCol]);
    if (id > maxId) maxId = id;
  }
  for (let i = 1; i < values.length; i++) {
    if (!values[i][idCol]) {
      maxId += 1;
      sh.getRange(i + 1, idCol + 1).setValue(maxId);
    }
  }
}

function defaultProjectMeta(name) {
  const text = String(name || "");
  const unitMatch = text.match(/WPR Unit\s+(\d+)/i);
  if (unitMatch) {
    const unit = Number(unitMatch[1]);
    if (unit >= 1 && unit <= 6) return { projectGroup: "WPR", segment: "Units 1-6", externalTeam: "Big-D Units 1-6" };
    if (unit >= 7 && unit <= 12) return { projectGroup: "WPR", segment: "Units 7-12", externalTeam: "Big-D Units 7-12" };
  }
  if (/WPR Condo|Penthouse/i.test(text)) {
    return { projectGroup: "WPR", segment: "Condos/Penthouse", externalTeam: "Big-D Condos/Penthouse" };
  }
  if (/Skier Services|WPR.*Skier|Skier.*WPR/i.test(text)) {
    return { projectGroup: "WPR", segment: "Skier Services", externalTeam: "Big-D Skier Services" };
  }
  if (/^WPR\b/i.test(text)) {
    return { projectGroup: "WPR", segment: "General", externalTeam: "" };
  }
  return { projectGroup: "Other Projects", segment: "", externalTeam: "" };
}

function phaseDefsForGroup(projectGroup) {
  const phases = [
    ["prewire", "Pre-Wire"],
    ["trim", "Trim"],
    ["handover", "WPR Handover (Big-D → WPR)"],
    ["install", "Install"],
  ];
  return projectGroup === "WPR" ? phases : phases.filter(p => p[0] !== "handover");
}

function phaseKeysForGroup(projectGroup) {
  return phaseDefsForGroup(projectGroup).map(p => p[0]);
}

// ---------- One-time setup: DELETES and rebuilds the tabs with 17 projects ----------

function seedData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const projectNames = [
    "WPR Unit 1", "WPR Unit 2", "WPR Unit 3", "WPR Unit 4", "WPR Unit 5", "WPR Unit 6",
    "WPR Unit 7", "WPR Unit 8", "WPR Unit 9", "WPR Unit 10", "WPR Unit 11", "WPR Unit 12",
    "WPR Condo 101", "WPR Condo 102", "WPR Condo 201", "WPR Condo 202", "WPR Condo Penthouse"
  ];

  setTab(ss, "Projects",
    ["id", "name", "projectGroup", "segment", "externalTeam", "percent", "startsAt", "endsAt"],
    projectNames.map((name, i) => {
      const meta = defaultProjectMeta(name);
      return [i + 1, name, meta.projectGroup, meta.segment, meta.externalTeam, 0, "", ""];
    }),
    [7, 8]); // startsAt, endsAt as plain text

  const phaseDefs = [
    ["prewire", "Pre-Wire"],
    ["trim", "Trim"],
    ["handover", "WPR Handover (Big-D → WPR)"],
    ["install", "Install"],
  ];
  const timelineRows = [];
  projectNames.forEach((_, i) => {
    phaseDefs.forEach(([key, label]) => timelineRows.push([i + 1, key, label, "", "", ""]));
  });
  setTab(ss, "Timelines", ["projectId", "key", "label", "start", "end", "status"], timelineRows, [4, 5]);

  setTab(ss, "Tasks", ["projectId", "name", "status", "id"], []);
  setTab(ss, "Risks", ["id", "projectId", "title", "severity", "owner", "note", "due"], [], [7]);
  setTab(ss, "Milestones", ["projectId", "name", "date", "state", "id"], [], [3]);

  SpreadsheetApp.getActiveSpreadsheet().toast("Done! 5 tabs created and 17 projects loaded.");
}

// Creates (or replaces) a tab, writes headers + rows, and forces given
// columns to Plain Text so Sheets doesn't silently reformat your dates.
function setTab(ss, name, headers, rows, textCols) {
  let sh = ss.getSheetByName(name);
  if (sh) ss.deleteSheet(sh);
  sh = ss.insertSheet(name);
  sh.appendRow(headers);
  sh.setFrozenRows(1);
  (textCols || []).forEach(col => sh.getRange(1, col, 1000, 1).setNumberFormat("@"));
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

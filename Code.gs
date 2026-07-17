/*
  WPR Command Center - Google Sheets backend (Google Apps Script)
  ------------------------------------------------------------------
  This file is NOT a standalone program you run on your computer. It's code
  that lives inside a Google Sheet and turns that Sheet into a tiny web API
  that the WPR Command Center HTML app can read from and write to.

  SETUP (see CLASP_SETUP.md for the full walkthrough):
  1. Create a new Google Sheet, name it "WPR Command Center Data".
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
  const projects = readRows("Projects");
  const timelines = readRows("Timelines");
  const tasks = readRows("Tasks");
  const risks = readRows("Risks");
  const milestones = readRows("Milestones");

  return projects.map(p => ({
    id: p.id,
    name: p.name,
    owner: p.owner || "Unassigned",
    team: p.team ? String(p.team).split(",").map(s => s.trim()).filter(Boolean) : [],
    percent: Number(p.percent) || 0,
    startsAt: p.startsAt || null,
    endsAt: p.endsAt || null,
    milestones: milestones
      .filter(m => String(m.projectId) === String(p.id))
      .map(m => ({ name: m.name, date: m.date, state: m.state })),
    tasks: {
      todo: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "todo").length,
      progress: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "progress").length,
      done: tasks.filter(t => String(t.projectId) === String(p.id) && t.status === "done").length,
    },
    taskList: tasks
      .filter(t => String(t.projectId) === String(p.id))
      .map(t => ({ name: t.name, status: t.status })),
    timelines: timelines
      .filter(t => String(t.projectId) === String(p.id))
      .map(t => ({ key: t.key, label: t.label, start: t.start || null, end: t.end || null })),
    risks: risks
      .filter(r => String(r.projectId) === String(p.id))
      .map(r => ({ id: r.id, title: r.title, severity: r.severity, owner: r.owner, note: r.note, due: r.due || null })),
  }));
}

// ---------- Writing data (only the fields the app can edit today) ----------

function updateProjectField(body) {
  const projectId = requireValue(body.projectId, "projectId");
  const field = requireValue(body.field, "field");
  const allowedFields = ["owner", "team", "startsAt", "endsAt"];
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
  const projectId = requireValue(body.projectId, "projectId");
  const key = requireValue(body.key, "key");
  const field = requireValue(body.field, "field");
  if (field !== "start" && field !== "end") throw new Error("Invalid timeline field: " + field);
  const value = normalizeDateValue(body.value, false);
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

function addProject(body) {
  const name = (body.name || "").toString().trim();
  if (!name) throw new Error("Project name is required");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
  const projSheet = sheet("Projects");
  const values = projSheet.getDataRange().getValues();
  let maxId = 0;
  for (let i = 1; i < values.length; i++) {
    const id = Number(values[i][0]);
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;
  projSheet.appendRow([newId, name, "Unassigned", "", 0, "", ""]);

  const tlSheet = sheet("Timelines");
  const phaseDefs = [
    ["handover", "WPR Handover (Big-D → WPR)"],
    ["prewire", "Pre-Wire"],
    ["trim", "Trim"],
    ["install", "Install"],
    ["client", "Client"],
  ];
  phaseDefs.forEach(([key, label]) => tlSheet.appendRow([newId, key, label, "", ""]));
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

// ---------- One-time setup: DELETES and rebuilds the tabs with 17 projects ----------

function seedData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const projectNames = [
    "WPR Unit 1", "WPR Unit 2", "WPR Unit 3", "WPR Unit 4", "WPR Unit 5", "WPR Unit 6",
    "WPR Unit 7", "WPR Unit 8", "WPR Unit 9", "WPR Unit 10", "WPR Unit 11", "WPR Unit 12",
    "WPR Condo 101", "WPR Condo 102", "WPR Condo 201", "WPR Condo 202", "WPR Condo Penthouse"
  ];

  setTab(ss, "Projects",
    ["id", "name", "owner", "team", "percent", "startsAt", "endsAt"],
    projectNames.map((name, i) => [i + 1, name, "Unassigned", "", 0, "", ""]),
    [6, 7]); // startsAt, endsAt as plain text

  const phaseDefs = [
    ["handover", "WPR Handover (Big-D → WPR)"],
    ["prewire", "Pre-Wire"],
    ["trim", "Trim"],
    ["install", "Install"],
    ["client", "Client"],
  ];
  const timelineRows = [];
  projectNames.forEach((_, i) => {
    phaseDefs.forEach(([key, label]) => timelineRows.push([i + 1, key, label, "", ""]));
  });
  setTab(ss, "Timelines", ["projectId", "key", "label", "start", "end"], timelineRows, [4, 5]);

  setTab(ss, "Tasks", ["projectId", "name", "status"], []);
  setTab(ss, "Risks", ["id", "projectId", "title", "severity", "owner", "note", "due"], [], [7]);
  setTab(ss, "Milestones", ["projectId", "name", "date", "state"], [], [3]);

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

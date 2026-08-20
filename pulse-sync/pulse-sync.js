#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_ENV_PATH = path.join(ROOT, "pulse-sync", ".env");
const ROOT_ENV_PATH = path.join(ROOT, ".env");
const PROJECT_MAP_PATH = path.join(ROOT, "pulse-sync", "project-map.json");
const SQL_OUTPUT_PATH = path.join(ROOT, "tmp", "source-sync.sql");
const WRANGLER_CONFIG = path.join(ROOT, "worker", "wrangler.toml");
const D1_DATABASE_NAME = "wpr-command-center";
const LIVE_COMMAND_CENTER_API_URL = "https://wpr-command-center-api.wpr-command-center.workers.dev";
const PULSE_DASHBOARD_URL = "https://www.pulsecentral.ai/c/ati-of-america/pm-contracts/ati/dashboard";
const EXCLUDED_TODO_SECTION_PATTERNS = [
  /\bsolus\b/i,
  /\blinked\b/i,
  /\bsales\b/i,
  /\bservice\b/i
];

const TIMELINE_COLUMNS = {
  customer: ["customer", "project", "name"],
  prewireSchedule: ["prewire schedule", "prewire schedule*"],
  prewireDate: ["prewire date"],
  trimSchedule: ["trim schedule", "trim schedule*"],
  trimDate: ["trim date"],
  installSchedule: ["install schedule"],
  installDate: ["install date"],
  addToAti: ["add to ati", "add to ati*"]
};

const TASK_COLUMNS = {
  id: ["id", "task id", "observation id", "number", "#"],
  project: ["project", "project name", "customer", "job", "name"],
  title: ["title", "task", "todo", "to-do", "observation", "description", "subject"],
  status: ["status", "state"],
  sourceState: ["source state", "source status", "pulse status", "procore status", "ball in court"],
  externalUrl: ["url", "link", "external url"],
  dueDate: ["due date", "due", "deadline", "target date"],
  priority: ["priority", "importance"],
  assignee: ["assignee", "assigned to", "owner", "responsible"],
  sourceUpdatedAt: ["updated at", "updated", "modified at", "last updated"]
};

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "dry-run";

loadEnvFile(ROOT_ENV_PATH);
loadEnvFile(LOCAL_ENV_PATH);

if (!["login-test", "dry-run", "sync", "search-projects"].includes(command)) {
  exitWithUsage(`Unknown command: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(`Pulse sync failed: ${error.message}`);
  if (command === "sync") {
    await reportSyncFailure(error).catch(reportError => {
      console.error(`Pulse sync failure could not be reported: ${reportError.message}`);
    });
  }
  process.exitCode = 1;
}

async function main() {
  const live = await readCommandCenter();

  if (command === "login-test") {
    const token = await loginToPulse();
    const me = await pulseGet(token, "/api/auth/me");
    const user = me && me.user ? me.user : me;
    console.log(`Pulse login ok: ${user.email || user.username || user.name || "current user"}`);
  } else if (command === "search-projects") {
    const query = args._.slice(1).join(" ").trim();
    if (query && pulseCredentialsAvailable()) {
      const token = await loginToPulse();
      const projects = await searchPulseProjects(token, query);
      console.log(`Pulse project search "${query}" found: ${projects.length}`);
      projects.slice(0, 50).forEach(project => {
        console.log(`${pulseProjectId(project)}\t${pulseProjectName(project) || "(unnamed)"}`);
      });
      if (projects.length > 50) console.log(`...and ${projects.length - 50} more.`);
    } else {
      live.projects.forEach(project => {
        console.log(`${project.id}\t${project.name}\t${project.segment || project.projectGroup || ""}`);
      });
    }
  } else {
    const plan = await buildSyncPlan(live.projects, args);
    printPlan(plan);

    if (command === "dry-run") {
      process.exitCode = plan.errors.length ? 1 : 0;
    } else {
      const auth = await getAuthIfConfigured();
      const stats = pulseSyncStats(plan);

      if (plan.errors.length) {
        if (auth) {
          await recordCommandCenterSyncRun("pulse", {
            status: "failed",
            ...stats,
            message: `Sync stopped with ${plan.errors.length} plan error(s).`
          }, auth);
        } else {
          applySyncRunToD1("pulse", {
            status: "failed",
            ...stats,
            message: `Sync stopped with ${plan.errors.length} plan error(s).`
          });
        }
        console.error("Sync stopped because the plan has errors.");
        process.exitCode = 1;
      } else if (!plan.timelineItems.length && !plan.taskSyncs.length) {
        if (auth) {
          await recordCommandCenterSyncRun("pulse", {
            status: "success",
            ...stats,
            message: "No source changes were ready to sync."
          }, auth);
        } else {
          applySyncRunToD1("pulse", {
            status: "success",
            ...stats,
            message: "No source changes were ready to sync."
          });
        }
        console.log("No date or source-task changes are ready to sync.");
      } else {
        if (auth) {
          if (plan.timelineItems.length) {
            await postUpdate("syncPulseTimelines", { items: plan.timelineItems }, auth);
            console.log(`Synced Pulse timeline dates for ${plan.timelineItems.length} project(s).`);
          }

          for (const taskSync of plan.taskSyncs) {
            await postUpdate("syncSourceTasks", taskSync, auth);
            console.log(`Synced ${taskSync.source} items: ${taskSync.tasks.length} task(s), ${taskSync.replaceProjectIds.length} project scope(s).`);
          }

          await recordCommandCenterSyncRun("pulse", {
            status: "success",
            ...stats,
            message: `Synced ${stats.recordsWritten} Pulse record(s).`
          }, auth);
        } else {
          applyPlanToD1(plan);
          applySyncRunToD1("pulse", {
            status: "success",
            ...stats,
            message: `Synced ${stats.recordsWritten} Pulse record(s).`
          });
        }

        console.log("Source sync complete.");
      }
    }
  }
}

async function buildSyncPlan(projects, options) {
  const plan = {
    timelineMatches: [],
    timelineItems: [],
    taskSyncs: [],
    unmatched: [],
    errors: []
  };

  let hasSourceInput = false;

  if (options.pulseTimelineFile) {
    hasSourceInput = true;
    const rows = parsePulseTimelineRows(await readText(options.pulseTimelineFile));
    const timelinePlan = buildTimelinePlan(projects, rows);
    plan.timelineMatches = timelinePlan.matches;
    plan.timelineItems = timelinePlan.items;
    plan.unmatched.push(...timelinePlan.unmatched);
  }

  if (options.pulseTimelineApi) {
    if (!pulseCredentialsAvailable()) {
      plan.errors.push("Pulse timeline API sync requires PULSE_EMAIL/PULSE_PASSWORD.");
    } else {
      hasSourceInput = true;
      const token = await loginToPulse();
      const rows = await fetchPulseTimelineRows(token);
      const timelinePlan = buildTimelinePlan(projects, rows);
      plan.timelineMatches = mergeTimelineMatches(plan.timelineMatches, timelinePlan.matches);
      plan.timelineItems = mergeTimelineItems(plan.timelineItems, timelinePlan.items);
      plan.unmatched.push(...timelinePlan.unmatched);
      plan.pulseTimelineApi = { rows: rows.length };
    }
  }

  for (const input of [
    { source: "pulse", file: options.pulseTodosFile },
    { source: "procore", file: options.procoreObservationsFile }
  ]) {
    if (!input.file) continue;
    hasSourceInput = true;
    const rows = parseTaskRows(await readText(input.file));
    const taskPlan = buildTaskPlan(projects, input.source, rows);
    if (taskPlan.sync.tasks.length || taskPlan.sync.replaceProjectIds.length) plan.taskSyncs.push(taskPlan.sync);
    plan.unmatched.push(...taskPlan.unmatched);
  }

  if (!options.pulseTodosFile && !options.noPulseTodos) {
    if (pulseCredentialsAvailable()) {
      hasSourceInput = true;
      const pulseTaskPlan = await buildPulseApiTaskPlan(projects);
      if (pulseTaskPlan.sync.tasks.length || pulseTaskPlan.sync.replaceProjectIds.length) plan.taskSyncs.push(pulseTaskPlan.sync);
      plan.unmatched.push(...pulseTaskPlan.unmatched);
      plan.pulseApi = pulseTaskPlan.summary;
    } else if (!hasSourceInput) {
      plan.errors.push("No source files were provided and Pulse credentials are not configured. Add PULSE_EMAIL/PULSE_PASSWORD or pass source files.");
    }
  }

  if (!hasSourceInput) {
    plan.errors.push([
      "No source files were provided.",
      "Use --pulse-timeline-file, --pulse-todos-file, or --procore-observations-file.",
      `Pulse dashboard: ${PULSE_DASHBOARD_URL}`
    ].join(" "));
  }

  return plan;
}

async function buildPulseApiTaskPlan(projects) {
  const token = await loginToPulse();
  const projectMap = readProjectMap();
  const pulseProjects = await fetchPulseProjects(token);
  const matchPulseProject = buildProjectMatcher(projects, projectMap);
  const unmatched = [];
  const matched = [];
  const tasks = [];

  for (const pulseProject of pulseProjects) {
    const commandProject = matchPulseProject(pulseProject);
    const pId = pulseProjectId(pulseProject);
    const pName = pulseProjectName(pulseProject);

    if (!commandProject) {
      unmatched.push({ source: "pulse-project", name: `${pName || "(unnamed)"} [${pId}]` });
      continue;
    }

    matched.push(commandProject.id);
    const lists = await fetchProjectTodoLists(token, pId);
    for (const list of lists) {
      const listId = cleanCell(list.id || list.todo_list_id);
      if (!listId) continue;
      const todoListTitle = cleanCell(list.title || list.name);
      if (isExcludedTodoSection(todoListTitle)) continue;
      const items = await fetchTodoItems(token, listId);
      for (const item of items) {
        const task = normalizePulseApiTodo(item, { commandProject, pulseProjectId: pId, todoListTitle });
        if (task) tasks.push(task);
      }
    }
  }

  return {
    unmatched,
    summary: {
      pulseProjects: pulseProjects.length,
      matchedProjects: new Set(matched).size,
      tasks: uniqueBy(tasks, task => task.id).length
    },
    sync: {
      source: "pulse",
      tasks: uniqueBy(tasks, task => task.id),
      replaceProjectIds: [...new Set(matched.map(String))]
    }
  };
}

async function fetchPulseTimelineRows(token) {
  const contracts = rowsFrom(await pulseGet(token, "/api/pm-contracts?pipeline=dashboard"));
  return contracts.map(contract => normalizePulseRow({
    customer: contract.customer_name,
    prewireSchedule: contract.ati_prewire_schedule,
    prewireDate: contract.ati_prewire_from,
    trimSchedule: contract.ati_trim_schedule,
    trimDate: contract.ati_trim_from,
    installSchedule: contract.ati_install_schedule,
    installDate: contract.ati_install_estimated_start,
    addToAti: contract.add_to_ati
  })).filter(row => row.customer);
}

function mergeTimelineMatches(first, second) {
  const byProject = new Map();
  [...first, ...second].forEach(item => {
    byProject.set(String(item.projectId), item);
  });
  return [...byProject.values()];
}

function mergeTimelineItems(first, second) {
  const byProject = new Map();
  [...first, ...second].forEach(item => {
    if (!byProject.has(String(item.projectId))) {
      byProject.set(String(item.projectId), { projectId: item.projectId, timelines: [] });
    }
    const target = byProject.get(String(item.projectId));
    const byKey = new Map(target.timelines.map(timeline => [timeline.key, timeline]));
    item.timelines.forEach(timeline => byKey.set(timeline.key, timeline));
    target.timelines = [...byKey.values()];
  });
  return [...byProject.values()];
}

function buildTimelinePlan(projects, rows) {
  const byProject = new Map();
  const unmatched = [];

  rows.forEach(row => {
    const project = matchProject(projects, row.customer);
    if (!project) {
      unmatched.push({ source: "pulse-timeline", name: row.customer });
      return;
    }

    if (!byProject.has(project.id)) {
      byProject.set(project.id, {
        project,
        pulseName: row.customer,
        dates: { prewire: null, trim: null, install: null }
      });
    }

    const target = byProject.get(project.id);
    for (const key of ["prewire", "trim", "install"]) {
      if (!row.phases[key]) continue;
      if (row.dates[key] || target.dates[key] === null) target.dates[key] = row.dates[key];
    }
  });

  const matches = [...byProject.values()].map(item => {
    const changes = ["prewire", "trim", "install"].flatMap(key => {
      const next = item.dates[key];
      if (next === null) return [];
      const timeline = (item.project.timelines || []).find(row => row.key === key) || {};
      const currentStart = timeline.start || "";
      const currentEnd = timeline.end || "";
      if (currentStart === next && currentEnd === next) return [];
      return [{ key, label: phaseLabel(key), current: currentStart === currentEnd ? currentStart : [currentStart, currentEnd].filter(Boolean).join(" to "), next }];
    });
    return { projectId: item.project.id, projectName: item.project.name, pulseName: item.pulseName, changes };
  });

  return {
    matches,
    unmatched,
    items: matches.filter(item => item.changes.length).map(item => ({
      projectId: item.projectId,
      timelines: item.changes.map(change => ({ key: change.key, date: change.next }))
    }))
  };
}

function buildTaskPlan(projects, source, rows) {
  const unmatched = [];
  const tasks = [];
  const replaceProjectIds = new Set();

  rows.forEach(row => {
    const project = matchProject(projects, row.project);
    if (!project) {
      unmatched.push({ source, name: row.project || row.title });
      return;
    }
    replaceProjectIds.add(project.id);
    const name = cleanCell(row.title);
    if (!name) return;
    tasks.push({
      id: row.id || stableTaskId(source, project.id, name),
      projectId: project.id,
      name,
      status: row.status || row.sourceState || "todo",
      sourceState: row.sourceState || row.status || "",
      externalUrl: row.externalUrl || "",
      dueDate: row.dueDate || "",
      priority: row.priority || "",
      assignee: row.assignee || "",
      sourceUpdatedAt: row.sourceUpdatedAt || ""
    });
  });

  return {
    unmatched,
    sync: { source, tasks, replaceProjectIds: [...replaceProjectIds] }
  };
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const index = trimmed.indexOf("=");
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

function pulseCredentialsAvailable() {
  return !!(process.env.PULSE_EMAIL && process.env.PULSE_PASSWORD);
}

function pulseBaseUrl() {
  return (process.env.PULSE_BASE_URL || "https://www.pulsecentral.ai").replace(/\/+$/, "");
}

function pulseWorkspaceSlug() {
  return (process.env.PULSE_WORKSPACE_SLUG || "ati-of-america").replace(/^\/+|\/+$/g, "");
}

function readProjectMap() {
  if (!existsSync(PROJECT_MAP_PATH)) return { pulseProjectIdToCommandCenterProjectId: {}, projectNameAliases: {} };
  return JSON.parse(readFileSync(PROJECT_MAP_PATH, "utf8"));
}

async function loginToPulse() {
  const email = process.env.PULSE_EMAIL || "";
  const password = process.env.PULSE_PASSWORD || "";
  if (!email || !password) throw new Error("Missing PULSE_EMAIL or PULSE_PASSWORD. Add them to pulse-sync/.env or pass source files instead.");
  const json = await requestJson(`${pulseBaseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const token = json && json.sessionToken;
  if (!token) throw new Error("Pulse login succeeded but did not return sessionToken.");
  return token;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Expected JSON from ${url}, got: ${text.slice(0, 200)}`);
    }
  }
  if (!response.ok) {
    const message = (json && (json.error || json.message)) || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }
  return json;
}

async function pulseGet(token, apiPath) {
  return requestJson(`${pulseBaseUrl()}${apiPath}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    }
  });
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.rows)) return value.rows;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && value.row) return [value.row];
  return [];
}

async function fetchPulseProjects(token) {
  const all = [];
  const limit = 100;
  for (let page = 1; page <= 50; page += 1) {
    const json = await pulseGet(token, `/api/pulse-projects?page=${page}&limit=${limit}`);
    const rows = rowsFrom(json);
    all.push(...rows);
    if (!rows.length) break;
    const total = Number(json && (json.total || json.count || json.totalRows || json.total_rows));
    if (total && all.length >= total) break;
    const totalPages = Number(json && (json.totalPages || json.total_pages || json.pages));
    if (totalPages && page >= totalPages) break;
  }
  return uniqueBy(all, project => String(project.id || project.project_id || ""));
}

async function fetchProjectTodoLists(token, pulseProjectId) {
  const json = await pulseGet(token, `/api/project-todos?project_id=${encodeURIComponent(String(pulseProjectId))}`);
  return rowsFrom(json);
}

async function fetchTodoItems(token, todoListId) {
  const json = await pulseGet(token, `/api/todo-items?todo_list_id=${encodeURIComponent(String(todoListId))}`);
  return rowsFrom(json);
}

async function searchPulseProjects(token, query) {
  const json = await pulseGet(token, `/api/pulse-projects/search?q=${encodeURIComponent(query)}`);
  return rowsFrom(json);
}

function buildProjectMatcher(commandProjects, projectMap) {
  const byId = new Map(commandProjects.map(project => [String(project.id), project]));
  const byName = new Map(commandProjects.map(project => [normalizeMatchText(project.name), project]));
  const idMap = projectMap.pulseProjectIdToCommandCenterProjectId || {};
  const aliases = projectMap.projectNameAliases || {};

  return pulseProject => {
    const pId = pulseProjectId(pulseProject);
    if (idMap[pId] && byId.has(String(idMap[pId]))) return byId.get(String(idMap[pId]));

    const rawName = pulseProjectName(pulseProject);
    const alias = aliases[rawName] || aliases[normalizeMatchText(rawName)];
    if (alias && byName.has(normalizeMatchText(alias))) return byName.get(normalizeMatchText(alias));

    return matchProject(commandProjects, rawName);
  };
}

function pulseProjectId(project) {
  return cleanCell(project.id || project.project_id);
}

function pulseProjectName(project) {
  return cleanCell(project.name || project.project_name || project.display_name || project.title);
}

function normalizePulseApiTodo(item, context) {
  const title = itemTitle(item);
  if (!title || isTitleOnly(item)) return null;
  const externalId = cleanCell(item.id || item.todo_item_id);
  if (!externalId) return null;

  return {
    id: `pulse-${externalId}`,
    projectId: String(context.commandProject.id),
    name: titleWithSection(title, context.todoListTitle || item.section),
    status: isCompleted(item) ? "done" : "todo",
    sourceState: taskStatusLabel(isCompleted(item) ? "done" : "todo"),
    externalUrl: normalizePulseUrl(item, context),
    dueDate: dateOnly(firstValue(item, ["due_date", "dueDate", "due", "deadline", "target_date", "targetDate"])),
    priority: normalizeTaskPriority(firstValue(item, ["priority", "importance"])),
    assignee: firstValue(item, ["assignee_name", "assigneeName", "assignee", "assigned_to", "assignedTo", "owner", "responsible"]),
    sourceUpdatedAt: firstValue(item, ["updated_at", "updatedAt", "modified_at", "modifiedAt", "last_updated", "lastUpdated"])
  };
}

function itemTitle(item) {
  return cleanCell(item.title || item.name || item.todo || item.description || item.body);
}

function titleWithSection(title, section) {
  const cleanTitle = cleanCell(title);
  const cleanSection = cleanCell(section);
  if (!cleanSection) return cleanTitle;
  if (cleanTitle.toLowerCase().startsWith(`${cleanSection.toLowerCase()}:`)) return cleanTitle;
  return `${cleanSection}: ${cleanTitle}`;
}

function isExcludedTodoSection(section) {
  const cleanSection = cleanCell(section);
  return EXCLUDED_TODO_SECTION_PATTERNS.some(pattern => pattern.test(cleanSection));
}

function isTitleOnly(item) {
  return cleanCell(item.kind).toLowerCase() === "title";
}

function isCompleted(item) {
  const status = cleanCell(item.status).toLowerCase();
  return item.completed === true || item.is_completed === true || ["done", "complete", "completed"].includes(status);
}

function normalizePulseUrl(item, context) {
  const direct = cleanCell(item.externalUrl || item.external_url || item.url || item.link || item.href);
  if (/^https:\/\/www\.pulsecentral\.ai\//i.test(direct)) return direct;
  return `${pulseBaseUrl()}/c/${pulseWorkspaceSlug()}/projects/${encodeURIComponent(String(context.pulseProjectId))}?card=todos`;
}

function taskStatusLabel(status) {
  if (status === "done") return "Closed";
  if (status === "note") return "Note";
  return "To-Do";
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePulseTimelineRows(text) {
  const rows = parseStructuredRows(text);
  return rows.map(row => normalizePulseRow({
    customer: pick(row, TIMELINE_COLUMNS.customer),
    prewireSchedule: pick(row, TIMELINE_COLUMNS.prewireSchedule),
    prewireDate: pick(row, TIMELINE_COLUMNS.prewireDate),
    trimSchedule: pick(row, TIMELINE_COLUMNS.trimSchedule),
    trimDate: pick(row, TIMELINE_COLUMNS.trimDate),
    installSchedule: pick(row, TIMELINE_COLUMNS.installSchedule),
    installDate: pick(row, TIMELINE_COLUMNS.installDate),
    addToAti: pick(row, TIMELINE_COLUMNS.addToAti)
  })).filter(row => row.customer);
}

function parseTaskRows(text) {
  return parseStructuredRows(text).map(row => ({
    id: pick(row, TASK_COLUMNS.id),
    project: pick(row, TASK_COLUMNS.project),
    title: pick(row, TASK_COLUMNS.title),
    status: pick(row, TASK_COLUMNS.status),
    sourceState: pick(row, TASK_COLUMNS.sourceState),
    externalUrl: pick(row, TASK_COLUMNS.externalUrl),
    dueDate: dateOnly(pick(row, TASK_COLUMNS.dueDate)),
    priority: normalizeTaskPriority(pick(row, TASK_COLUMNS.priority)),
    assignee: pick(row, TASK_COLUMNS.assignee),
    sourceUpdatedAt: pick(row, TASK_COLUMNS.sourceUpdatedAt)
  })).filter(row => row.project && row.title);
}

function parseStructuredRows(text) {
  const value = String(text || "").trim();
  if (!value) return [];

  if (/^[\[{]/.test(value)) {
    const parsed = JSON.parse(value);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : [];
    return rows.map(row => {
      if (Array.isArray(row)) return arrayToRow(row);
      return objectToRow(row);
    });
  }

  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines.some(line => line.includes("\t")) ? "\t" : ",";
  const table = lines.map(line => splitDelimited(line, delimiter));
  const headers = table[0].map(normalizeHeader);
  const hasHeader = headers.some(header => ["customer", "project", "project name", "title", "task", "observation"].includes(header));
  const dataRows = hasHeader ? table.slice(1) : table;
  const activeHeaders = hasHeader ? headers : [];
  return dataRows.map(cells => activeHeaders.length ? headersToRow(activeHeaders, cells) : arrayToRow(cells));
}

function arrayToRow(cells) {
  return headersToRow([
    "customer", "project manager", "prewire schedule", "prewire date",
    "trim schedule", "trim date", "install schedule", "install date",
    "racks due date", "integrations due date", "pm billing status",
    "estimated project completion date", "ati install completion date",
    "add to ati", "comments"
  ], cells);
}

function headersToRow(headers, cells) {
  const row = {};
  headers.forEach((header, index) => {
    row[normalizeHeader(header)] = cleanCell(cells[index] || "");
  });
  return row;
}

function objectToRow(value) {
  const row = {};
  Object.entries(value || {}).forEach(([key, cell]) => {
    row[normalizeHeader(key)] = cleanCell(cell);
  });
  return row;
}

function normalizePulseRow(row) {
  const addToAti = cleanCell(row.addToAti).toLowerCase();
  const phaseListed = key => addToAti ? addToAti.includes(key === "prewire" ? "prewire" : key) : false;
  const phasePresent = (key, schedule, date) => addToAti ? phaseListed(key) : !!cleanCell(schedule) || !!cleanCell(date);
  return {
    customer: cleanCell(row.customer),
    dates: {
      prewire: dateOnly(row.prewireDate),
      trim: dateOnly(row.trimDate),
      install: dateOnly(row.installDate)
    },
    phases: {
      prewire: phasePresent("prewire", row.prewireSchedule, row.prewireDate),
      trim: phasePresent("trim", row.trimSchedule, row.trimDate),
      install: phasePresent("install", row.installSchedule, row.installDate)
    }
  };
}

function pick(row, aliases) {
  const keys = Object.keys(row || {});
  const key = aliases.map(normalizeHeader).find(alias => keys.includes(alias)) ||
    aliases.map(normalizeHeader).find(alias => keys.some(key => key.includes(alias)));
  return key ? cleanCell(row[key]) : "";
}

function matchProject(projects, value) {
  const text = String(value || "").toLowerCase();
  if (!text) return null;
  if (text.includes("skier services")) return findProjectByName(projects, "Skier Services");
  if (text.includes("penthouse")) return findProjectByName(projects, "WPR Condo Penthouse");
  if (text.includes("condo")) {
    const unit = text.match(/unit\s*(\d+)/);
    if (unit) return findProjectByName(projects, `WPR Condo ${unit[1]}`);
  }
  const unit = text.match(/unit\s*(\d+)/);
  if (unit) return findProjectByName(projects, `WPR Unit ${unit[1]}`);
  if (/\bd4\b/.test(text)) return findProjectByName(projects, "D4");
  if (/\bd35\b/.test(text)) return findProjectByName(projects, "D35");

  const normalized = normalizeMatchText(value);
  return projects.find(project => normalizeMatchText(project.name) === normalized) || null;
}

function findProjectByName(projects, name) {
  const normalized = normalizeMatchText(name);
  return projects.find(project => normalizeMatchText(project.name) === normalized) || null;
}

function printPlan(plan) {
  if (plan.pulseApi) {
    console.log(`Pulse API to-dos: ${plan.pulseApi.pulseProjects} Pulse project(s), ${plan.pulseApi.matchedProjects} matched, ${plan.pulseApi.tasks} to-do item(s).`);
  }

  if (plan.pulseTimelineApi) {
    console.log(`Pulse PM Contracts dates: ${plan.pulseTimelineApi.rows} dashboard row(s) fetched.`);
  }

  if (plan.timelineMatches.length) {
    const changed = plan.timelineMatches.filter(item => item.changes.length);
    console.log(`Pulse dates: ${plan.timelineMatches.length} matched, ${changed.length} with date changes.`);
    changed.slice(0, 20).forEach(item => {
      console.log(`  ${item.projectName}: ${item.changes.map(change => `${change.label} ${change.current || "blank"} -> ${change.next || "blank"}`).join("; ")}`);
    });
  }

  plan.taskSyncs.forEach(sync => {
    console.log(`${sync.source} tasks: ${sync.tasks.length} item(s), ${sync.replaceProjectIds.length} project scope(s).`);
  });

  if (plan.unmatched.length) {
    console.log(`Unmatched rows: ${plan.unmatched.length}`);
    plan.unmatched.slice(0, 20).forEach(item => console.log(`  ${item.source}: ${item.name}`));
  }

  plan.errors.forEach(error => console.error(error));
}

async function readCommandCenter() {
  const response = await fetch(commandCenterApiUrl(), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Command Center read failed (${response.status})`);
  const data = await response.json();
  const projects = Array.isArray(data) ? data : data.data;
  if (!Array.isArray(projects)) throw new Error("Command Center response did not include projects.");
  return { projects };
}

async function postUpdate(action, payload, auth) {
  const response = await fetch(commandCenterApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-command-center-session": auth.token,
      "x-command-center-initials": auth.initials
    },
    body: JSON.stringify({ action, ...payload })
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!response.ok || data.ok === false) throw new Error(data.error || `Command Center update failed (${response.status})`);
  return data;
}

async function recordCommandCenterSyncRun(source, payload, auth) {
  return postUpdate("recordSyncRun", {
    source,
    label: source === "pulse" ? "Pulse" : source,
    ...payload
  }, auth);
}

async function reportSyncFailure(error) {
  const auth = await getAuthIfConfigured();
  if (!auth) return;
  await recordCommandCenterSyncRun("pulse", {
    status: "failed",
    recordsSeen: 0,
    recordsWritten: 0,
    projectCount: 0,
    message: error.message || "Pulse sync failed."
  }, auth);
}

function pulseSyncStats(plan) {
  const taskCount = plan.taskSyncs.reduce((total, sync) => total + sync.tasks.length, 0);
  const taskProjectCount = plan.taskSyncs.reduce((ids, sync) => {
    sync.replaceProjectIds.forEach(id => ids.add(String(id)));
    sync.tasks.forEach(task => ids.add(String(task.projectId)));
    return ids;
  }, new Set());
  plan.timelineItems.forEach(item => taskProjectCount.add(String(item.projectId)));
  const timelineCount = plan.timelineItems.reduce((total, item) => total + item.timelines.length, 0);
  const recordsSeen = taskCount + plan.timelineMatches.length + plan.unmatched.length;
  return {
    recordsSeen,
    recordsWritten: taskCount + timelineCount,
    projectCount: taskProjectCount.size
  };
}

async function getAuthIfConfigured() {
  const session = process.env.COMMAND_CENTER_SESSION || "";
  const initials = process.env.COMMAND_CENTER_INITIALS || "SYNC";
  if (session) return { token: session, initials };

  const accessCode = process.env.COMMAND_CENTER_ACCESS_CODE || "";
  if (!accessCode) return null;

  const response = await fetch(commandCenterApiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "authorize", accessCode, initials })
  });
  const data = await response.json();
  if (!response.ok || data.ok === false || !data.token) throw new Error(data.error || "Command Center authorization failed.");
  return { token: data.token, initials: data.initials || initials };
}

function applyPlanToD1(plan) {
  const lines = [];

  for (const item of plan.timelineItems) {
    for (const timeline of item.timelines) {
      lines.push(
        "UPDATE timelines SET start = " +
        `${sqlString(timeline.date)}, end = ${sqlString(timeline.date)} ` +
        `WHERE project_id = ${sqlString(item.projectId)} AND key = ${sqlString(timeline.key)};`
      );
    }
  }

  for (const sync of plan.taskSyncs) {
    appendSourceTaskSyncSql(lines, sync);
  }

  if (!lines.length) return;
  mkdirSync(path.dirname(SQL_OUTPUT_PATH), { recursive: true });
  writeFileSync(SQL_OUTPUT_PATH, lines.join("\n") + "\n", "utf8");
  applySqlFileToD1(SQL_OUTPUT_PATH);
}

function applySyncRunToD1(source, payload) {
  const now = new Date().toISOString();
  const status = ["success", "failed", "skipped"].includes(String(payload.status || "").toLowerCase()) ? String(payload.status).toLowerCase() : "unknown";
  const lastSuccessAt = status === "success" ? now : "";
  const message = cleanCell(payload.message || "").slice(0, 500);
  const line = "INSERT INTO sync_runs (source, label, status, last_attempt_at, last_success_at, records_seen, records_written, project_count, message, updated_at, updated_by) VALUES " +
    `(${sqlString(source)}, ${sqlString(source === "pulse" ? "Pulse" : source)}, ${sqlString(status)}, ${sqlString(now)}, ${sqlString(lastSuccessAt)}, ` +
    `${safeCount(payload.recordsSeen)}, ${safeCount(payload.recordsWritten)}, ${safeCount(payload.projectCount)}, ${sqlString(message)}, ${sqlString(now)}, 'SYNC') ` +
    "ON CONFLICT(source) DO UPDATE SET label = excluded.label, status = excluded.status, last_attempt_at = excluded.last_attempt_at, " +
    "last_success_at = CASE WHEN excluded.status = 'success' THEN excluded.last_success_at ELSE sync_runs.last_success_at END, " +
    "records_seen = excluded.records_seen, records_written = excluded.records_written, project_count = excluded.project_count, " +
    "message = excluded.message, updated_at = excluded.updated_at, updated_by = excluded.updated_by;";
  mkdirSync(path.dirname(SQL_OUTPUT_PATH), { recursive: true });
  writeFileSync(SQL_OUTPUT_PATH, `${line}\n`, "utf8");
  applySqlFileToD1(SQL_OUTPUT_PATH);
}

function appendSourceTaskSyncSql(lines, sync) {
  const source = syncedTaskSource(sync.source);
  const replaceProjectIds = [...new Set((sync.replaceProjectIds || []).map(String).filter(Boolean))];
  const sourceValues = source.values.map(sqlString).join(", ");
  const now = new Date().toISOString().slice(0, 16);

  if (replaceProjectIds.length) {
    lines.push(
      `DELETE FROM tasks WHERE source IN (${sourceValues}) AND project_id IN (${replaceProjectIds.map(sqlString).join(", ")});`
    );
  }

  for (const task of sync.tasks || []) {
    const id = normalizedSyncedTaskId(source.primary, task.id);
    lines.push(
      "INSERT INTO tasks (id, project_id, name, status, source, source_state, external_url, due_date, priority, assignee, source_updated_at, updated_by, updated_at) VALUES " +
      `(${sqlString(id)}, ${sqlString(task.projectId)}, ${sqlString(task.name)}, ${sqlString(syncedTaskStatus(task.status))}, ` +
      `${sqlString(source.primary)}, ${sqlString(task.sourceState || "")}, ${sqlString(task.externalUrl || "")}, ` +
      `${sqlString(dateOnly(task.dueDate))}, ${sqlString(normalizeTaskPriority(task.priority))}, ${sqlString(cleanCell(task.assignee).slice(0, 160))}, ` +
      `${sqlString(cleanCell(task.sourceUpdatedAt).slice(0, 80))}, 'SYNC', ${sqlString(now)}) ` +
      "ON CONFLICT(id) DO UPDATE SET " +
      "project_id = excluded.project_id, name = excluded.name, status = excluded.status, source = excluded.source, " +
      "source_state = excluded.source_state, external_url = excluded.external_url, due_date = excluded.due_date, " +
      "priority = excluded.priority, assignee = excluded.assignee, source_updated_at = excluded.source_updated_at, " +
      "updated_by = excluded.updated_by, updated_at = excluded.updated_at;"
    );
  }
}

function applySqlFileToD1(sqlPath) {
  const wranglerBin = process.platform === "win32"
    ? path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js")
    : path.join(ROOT, "node_modules", ".bin", "wrangler");
  const useLocalWrangler = existsSync(wranglerBin);
  const command = useLocalWrangler && process.platform === "win32" ? process.execPath : useLocalWrangler ? wranglerBin : "npx";

  console.log(`Applying source sync directly to Cloudflare D1: ${sqlPath}`);
  const statements = readFileSync(sqlPath, "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let batch = [];
  let batchLength = 0;
  let applied = 0;

  const runBatch = items => {
    if (!items.length) return;
    const sql = items.join("\n");
    const args = useLocalWrangler && process.platform === "win32"
      ? [wranglerBin, "d1", "execute", D1_DATABASE_NAME, "--remote", "--config", WRANGLER_CONFIG, "--command", sql]
      : useLocalWrangler
        ? ["d1", "execute", D1_DATABASE_NAME, "--remote", "--config", WRANGLER_CONFIG, "--command", sql]
        : ["wrangler", "d1", "execute", D1_DATABASE_NAME, "--remote", "--config", WRANGLER_CONFIG, "--command", sql];

    const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", shell: false });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`Wrangler D1 sync failed with exit code ${result.status}.`);
    applied += items.length;
    console.log(`Applied D1 statements: ${applied}/${statements.length}`);
  };

  for (const statement of statements) {
    if (batchLength + statement.length > 22000) {
      runBatch(batch);
      batch = [];
      batchLength = 0;
    }
    batch.push(statement);
    batchLength += statement.length + 1;
  }

  runBatch(batch);
}

function syncedTaskSource(value) {
  const source = cleanCell(value).toLowerCase();
  if (source === "pulse") return { primary: "pulse", values: ["pulse", "Pulse"] };
  if (source === "procore" || source === "procore-review") return { primary: source, values: ["procore", "procore-review", "Procore"] };
  throw new Error(`Invalid synced task source: ${source}`);
}

function normalizedSyncedTaskId(source, value) {
  const id = cleanCell(value).replace(/\s+/g, "-").slice(0, 120);
  if (!id) throw new Error("Synced task id is required");
  return id.startsWith(`${source}-`) ? id : `${source}-${id}`;
}

function syncedTaskStatus(value) {
  const status = cleanCell(value).toLowerCase();
  if (["done", "closed", "complete", "completed"].includes(status)) return "done";
  if (["progress", "in-progress", "in progress", "ready for review", "review"].includes(status)) return "progress";
  return "todo";
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function safeCount(value) {
  return Math.min(Math.max(0, Math.floor(Number(value) || 0)), 1000000);
}

function commandCenterApiUrl() {
  const configured = process.env.COMMAND_CENTER_API_URL || "";
  if (/^https:\/\/wpr-command-center-api\./.test(configured) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(configured)) return configured;
  return LIVE_COMMAND_CENTER_API_URL;
}

async function readText(filePath) {
  return readFile(path.resolve(filePath), "utf8");
}

function parseArgs(values) {
  const parsed = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") continue;
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = values[index + 1];
    if (!next || next.startsWith("--")) parsed[key] = true;
    else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function splitDelimited(line, delimiter) {
  if (delimiter === "\t") return line.split("\t").map(cleanCell);
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cleanCell(current));
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(cleanCell(current));
  return cells;
}

function dateOnly(value) {
  const text = cleanCell(value);
  if (!text || text === "-" || text === "—" || /^tbd$/i.test(text)) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return "";
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

function firstValue(item, keys) {
  for (const key of keys) {
    const value = cleanCell(item && item[key]);
    if (value) return value;
  }
  return "";
}

function normalizeTaskPriority(value) {
  const text = cleanCell(value).toLowerCase();
  if (["urgent", "high"].includes(text)) return "high";
  if (["normal", "medium", "med"].includes(text)) return "medium";
  if (text === "low") return "low";
  return "";
}

function cleanCell(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

function normalizeHeader(value) {
  return cleanCell(value).toLowerCase().replace(/[▲*]/g, "").replace(/\s+/g, " ").trim();
}

function normalizeMatchText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function phaseLabel(key) {
  if (key === "prewire") return "Pre-Wire";
  if (key === "trim") return "Trim";
  if (key === "install") return "Install";
  return key;
}

function stableTaskId(source, projectId, name) {
  const hash = createHash("sha1").update(`${source}:${projectId}:${name}`).digest("hex").slice(0, 12);
  return `${source}-${hash}`;
}

function exitWithUsage(message) {
  if (message) console.error(message);
  console.error(`
Usage:
  pnpm pulse:dry-run -- --pulse-timeline-file pulse-wpr.tsv
  pnpm pulse:sync -- --pulse-timeline-file pulse-wpr.tsv --pulse-todos-file pulse-todos.tsv --procore-observations-file procore.tsv
  pnpm pulse:login-test
  pnpm pulse:search-projects

Environment for sync:
  COMMAND_CENTER_ACCESS_CODE or COMMAND_CENTER_SESSION
  COMMAND_CENTER_INITIALS defaults to SYNC
  COMMAND_CENTER_API_URL defaults to the live Command Center API
`);
  process.exit(1);
}

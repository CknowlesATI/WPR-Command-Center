#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SYNC_SOURCE = "pulse";
const ROOT = path.resolve(__dirname, "..");
const LOCAL_ENV_PATH = path.join(__dirname, ".env");
const ROOT_ENV_PATH = path.join(ROOT, ".env");
const PROJECT_MAP_PATH = path.join(__dirname, "project-map.json");
const SQL_OUTPUT_PATH = path.join(ROOT, "tmp", "pulse-clean-sync.sql");
const WRANGLER_CONFIG = path.join(ROOT, "worker", "wrangler.toml");
const D1_DATABASE_NAME = "wpr-command-center";
const EXCLUDED_TODO_SECTION_PATTERNS = [
  /\bsolus\b/i,
  /\blinked\b/i,
  /\bsales\b/i,
  /\bservice\b/i
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const idx = trimmed.indexOf("=");
    if (idx === -1) return;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnvFile(ROOT_ENV_PATH);
loadEnvFile(LOCAL_ENV_PATH);

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}. Add it to pulse-sync/.env.`);
  return value;
}

function pulseBaseUrl() {
  return env("PULSE_BASE_URL", "https://www.pulsecentral.ai").replace(/\/+$/, "");
}

function pulseWorkspaceSlug() {
  return env("PULSE_WORKSPACE_SLUG", "ati-of-america").replace(/^\/+|\/+$/g, "");
}

function readProjectMap() {
  if (!fs.existsSync(PROJECT_MAP_PATH)) {
    return { pulseProjectIdToCommandCenterProjectId: {}, projectNameAliases: {} };
  }
  return JSON.parse(fs.readFileSync(PROJECT_MAP_PATH, "utf8"));
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

async function loginToPulse() {
  const email = requiredEnv("PULSE_EMAIL");
  const password = requiredEnv("PULSE_PASSWORD");
  const json = await requestJson(`${pulseBaseUrl()}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const token = json && json.sessionToken;
  if (!token) throw new Error("Pulse login succeeded but did not return sessionToken.");
  return token;
}

function authHeaders(token) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`
  };
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.rows)) return value.rows;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && value.row) return [value.row];
  return [];
}

async function pulseGet(token, apiPath) {
  return requestJson(`${pulseBaseUrl()}${apiPath}`, {
    method: "GET",
    headers: authHeaders(token)
  });
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

async function fetchCommandCenterProjects() {
  const apiUrl = requiredEnv("COMMAND_CENTER_API_URL");
  const json = await requestJson(apiUrl, { method: "GET" });
  return Array.isArray(json) ? json : rowsFrom(json.data || json);
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

function compact(value) {
  return String(value || "").trim();
}

function normName(value) {
  return compact(value).toLowerCase().replace(/\s+/g, " ");
}

function pulseProjectId(project) {
  return compact(project.id || project.project_id);
}

function pulseProjectName(project) {
  return compact(project.name || project.project_name || project.display_name || project.title);
}

function commandProjectName(project) {
  return compact(project.name);
}

function buildProjectMatcher(commandProjects, projectMap) {
  const byId = new Map(commandProjects.map(project => [String(project.id), project]));
  const byName = new Map(commandProjects.map(project => [normName(commandProjectName(project)), project]));
  const idMap = projectMap.pulseProjectIdToCommandCenterProjectId || {};
  const aliases = projectMap.projectNameAliases || {};

  return pulseProject => {
    const pId = pulseProjectId(pulseProject);
    if (idMap[pId] && byId.has(String(idMap[pId]))) return byId.get(String(idMap[pId]));

    const rawName = pulseProjectName(pulseProject);
    const alias = aliases[rawName] || aliases[normName(rawName)];
    if (alias && byName.has(normName(alias))) return byName.get(normName(alias));

    return byName.get(normName(rawName)) || null;
  };
}

function itemTitle(item) {
  return compact(item.title || item.name || item.todo || item.description || item.body);
}

function titleWithSection(title, section) {
  const cleanTitle = compact(title);
  const cleanSection = compact(section);
  if (!cleanSection) return cleanTitle;
  if (cleanTitle.toLowerCase().startsWith(`${cleanSection.toLowerCase()}:`)) return cleanTitle;
  return `${cleanSection}: ${cleanTitle}`;
}

function isExcludedTodoSection(section) {
  const cleanSection = compact(section);
  return EXCLUDED_TODO_SECTION_PATTERNS.some(pattern => pattern.test(cleanSection));
}

function isTitleOnly(item) {
  return compact(item.kind).toLowerCase() === "title";
}

function isCompleted(item) {
  const status = compact(item.status).toLowerCase();
  return item.completed === true || item.is_completed === true || ["done", "complete", "completed"].includes(status);
}

function normalizePulseUrl(item, context) {
  const direct = compact(item.externalUrl || item.external_url || item.url || item.link || item.href);
  if (/^https:\/\/www\.pulsecentral\.ai\//i.test(direct)) return direct;
  return `${pulseBaseUrl()}/c/${pulseWorkspaceSlug()}/projects/${encodeURIComponent(String(context.pulseProjectId))}?card=todos`;
}

function normalizePulseTodo(item, context) {
  const title = itemTitle(item);
  if (!title || isTitleOnly(item)) return null;
  const externalId = compact(item.id || item.todo_item_id);
  if (!externalId) return null;

  return {
    id: `pulse-${externalId}`,
    projectId: String(context.commandProject.id),
    name: titleWithSection(title, context.todoListTitle || item.section),
    status: isCompleted(item) ? "done" : "todo",
    source: SYNC_SOURCE,
    externalUrl: normalizePulseUrl(item, context)
  };
}

async function buildSyncPayload(token) {
  const projectMap = readProjectMap();
  const [pulseProjects, commandProjects] = await Promise.all([
    fetchPulseProjects(token),
    fetchCommandCenterProjects()
  ]);
  const matchProject = buildProjectMatcher(commandProjects, projectMap);
  const unmatchedProjects = [];
  const matchedProjects = [];
  const tasks = [];

  for (const pulseProject of pulseProjects) {
    const commandProject = matchProject(pulseProject);
    const pId = pulseProjectId(pulseProject);
    const pName = pulseProjectName(pulseProject);
    if (!commandProject) {
      unmatchedProjects.push({ id: pId, name: pName });
      continue;
    }

    matchedProjects.push({
      pulseId: pId,
      pulseName: pName,
      commandCenterId: commandProject.id,
      commandCenterName: commandProject.name
    });

    const lists = await fetchProjectTodoLists(token, pId);
    for (const list of lists) {
      const listId = compact(list.id || list.todo_list_id);
      if (!listId) continue;
      const todoListTitle = compact(list.title || list.name);
      if (isExcludedTodoSection(todoListTitle)) continue;
      const items = await fetchTodoItems(token, listId);
      for (const item of items) {
        const task = normalizePulseTodo(item, {
          commandProject,
          pulseProjectId: pId,
          pulseProjectName: pName,
          todoListTitle
        });
        if (task) tasks.push(task);
      }
    }
  }

  return {
    pulseProjects,
    commandProjects,
    matchedProjects,
    unmatchedProjects,
    tasks: uniqueBy(tasks, task => task.id)
  };
}

async function searchPulseProjects(token, query) {
  const json = await pulseGet(token, `/api/pulse-projects/search?q=${encodeURIComponent(query)}`);
  return rowsFrom(json);
}

function printSummary(payload) {
  const urls = payload.tasks.filter(task => task.externalUrl).length;
  console.log(`Pulse projects found: ${payload.pulseProjects.length}`);
  console.log(`Command Center projects found: ${payload.commandProjects.length}`);
  console.log(`Matched projects: ${payload.matchedProjects.length}`);
  console.log(`Unmatched Pulse projects: ${payload.unmatchedProjects.length}`);
  console.log(`Pulse to-dos ready to sync: ${payload.tasks.length}`);
  console.log(`Pulse to-dos with links: ${urls}`);

  if (payload.unmatchedProjects.length) {
    console.log("");
    console.log("Unmatched Pulse projects:");
    payload.unmatchedProjects.slice(0, 30).forEach(project => {
      console.log(`- ${project.name || "(unnamed)"} [${project.id}]`);
    });
    if (payload.unmatchedProjects.length > 30) {
      console.log(`...and ${payload.unmatchedProjects.length - 30} more.`);
    }
  }
}

function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function buildReplacementSql(tasks) {
  const now = new Date().toISOString().slice(0, 16);
  const lines = [
    "DELETE FROM tasks WHERE lower(source) = 'pulse';"
  ];

  for (const task of tasks) {
    lines.push(
      "INSERT INTO tasks (id, project_id, name, status, source, external_url, updated_by, updated_at) VALUES " +
      `(${sqlString(task.id)}, ${sqlString(task.projectId)}, ${sqlString(task.name)}, ${sqlString(task.status)}, 'pulse', ${sqlString(task.externalUrl)}, 'SYNC', ${sqlString(now)});`
    );
  }

  return `${lines.join("\n")}\n`;
}

function writeSqlFile(payload) {
  fs.mkdirSync(path.dirname(SQL_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(SQL_OUTPUT_PATH, buildReplacementSql(payload.tasks), "utf8");
  return SQL_OUTPUT_PATH;
}

function applyToD1(sqlPath) {
  const wranglerBin = process.platform === "win32"
    ? path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js")
    : path.join(ROOT, "node_modules", ".bin", "wrangler");
  const useLocalWindowsWrangler = fs.existsSync(wranglerBin) && process.platform === "win32";
  const command = useLocalWindowsWrangler ? process.execPath : "npx";
  const args = useLocalWindowsWrangler ? [
    wranglerBin,
    "d1",
    "execute",
    D1_DATABASE_NAME,
    "--remote",
    "--config",
    WRANGLER_CONFIG,
    "--file",
    sqlPath
  ] : [
    "wrangler",
    "d1",
    "execute",
    D1_DATABASE_NAME,
    "--remote",
    "--config",
    WRANGLER_CONFIG,
    "--file",
    sqlPath
  ];

  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: false
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`Cloudflare D1 update failed with exit code ${result.status}`);
}

async function main() {
  const command = process.argv[2] || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    console.log("Usage: node pulse-sync/pulse-sync.js <login-test|dry-run|sync|search-projects>");
    return;
  }

  const token = await loginToPulse();
  if (command === "login-test") {
    const me = await pulseGet(token, "/api/auth/me");
    const user = me && me.user ? me.user : me;
    console.log(`Pulse login ok: ${user.email || user.username || user.name || "current user"}`);
    return;
  }

  if (command === "search-projects") {
    const query = process.argv.slice(3).join(" ").trim();
    if (!query) throw new Error("Provide a search term, for example: search-projects WPR");
    const projects = await searchPulseProjects(token, query);
    console.log(`Pulse project search "${query}" found: ${projects.length}`);
    projects.slice(0, 50).forEach(project => {
      console.log(`- ${pulseProjectName(project) || "(unnamed)"} [${pulseProjectId(project)}]`);
    });
    if (projects.length > 50) console.log(`...and ${projects.length - 50} more.`);
    return;
  }

  const payload = await buildSyncPayload(token);
  printSummary(payload);

  if (!payload.tasks.length) {
    throw new Error("Pulse returned zero syncable tasks; refusing to sweep the live Pulse rows.");
  }

  const sqlPath = writeSqlFile(payload);
  console.log("");
  console.log(`Prepared clean Pulse replacement SQL: ${sqlPath}`);

  if (command === "dry-run") return;

  if (command === "sync") {
    applyToD1(sqlPath);
    console.log("");
    console.log("Online Pulse task sweep and clean sync complete.");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Pulse sync failed: ${error.message}`);
  process.exitCode = 1;
});

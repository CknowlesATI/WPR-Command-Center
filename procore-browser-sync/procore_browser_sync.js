#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const LOCAL_ENV_PATH = path.join(__dirname, ".env");
const ROOT_ENV_PATH = path.join(ROOT, ".env");
const PULSE_ENV_PATH = path.join(ROOT, "pulse-sync", ".env");
const SQL_OUTPUT_PATH = path.join(ROOT, "tmp", "procore-source-sync.sql");
const WRANGLER_CONFIG = path.join(ROOT, "worker", "wrangler.toml");
const D1_DATABASE_NAME = "wpr-command-center";
const LIVE_COMMAND_CENTER_API_URL = "https://wpr-command-center-api.wpr-command-center.workers.dev";
const DEFAULT_USER_DATA_DIR = path.join(__dirname, ".browser-profile");
const DEFAULT_START_URL = "https://app.procore.com/";
const DEFAULT_CDP_PORT = "9223";
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_TIMEOUT_MS = 60000;
const DEFAULT_AUTO_ATTEMPTS = 2;

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
loadEnvFile(PULSE_ENV_PATH);
loadEnvFile(LOCAL_ENV_PATH);

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}. Add it to procore-browser-sync/.env.`);
  return value;
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) {
      args._.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next === "true" ? true : next === "false" ? false : next;
      i += 1;
    }
  }
  return args;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return text;
  const [, month, day, year] = match;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeReviewFiles(rows, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "procore-browser-observations.json");
  const csvPath = path.join(outDir, "procore-browser-observations.csv");
  fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), "utf8");
  const headers = [
    "project",
    "number",
    "type",
    "title",
    "assignee",
    "assigneeCompany",
    "dateNotified",
    "createdBy",
    "dateCreated",
    "dueDate",
    "specSection",
    "status",
    "priority",
    "location",
    "description",
    "detailUrl",
    "itemUrl",
    "pdfUrl"
  ];
  const csv = [
    headers.join(","),
    ...rows.map(row => headers.map(header => csvEscape(row[header])).join(","))
  ].join("\n");
  fs.writeFileSync(csvPath, csv, "utf8");
  return { csvPath, jsonPath };
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

async function loadPlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    const bundledNodeModules = path.join(
      process.env.USERPROFILE || "",
      ".cache",
      "codex-runtimes",
      "codex-primary-runtime",
      "dependencies",
      "node",
      "node_modules"
    );
    const bundledPnpmNodeModules = path.join(bundledNodeModules, ".pnpm", "node_modules");
    require("module").Module._initPaths();
    process.env.NODE_PATH = [process.env.NODE_PATH, bundledNodeModules, bundledPnpmNodeModules].filter(Boolean).join(path.delimiter);
    require("module").Module._initPaths();
    return require("playwright");
  }
}

async function launchBrowser(args) {
  const { chromium } = await loadPlaywright();
  const userDataDir = path.resolve(env("PROCORE_BROWSER_PROFILE", args["profile-dir"] || DEFAULT_USER_DATA_DIR));
  const headed = args.headless !== true;
  const executablePath = env("PROCORE_BROWSER_EXECUTABLE", args["browser-executable"] || "");
  const launchOptions = {
    headless: !headed,
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true
  };
  if (executablePath) launchOptions.executablePath = executablePath;
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...launchOptions
  });
  const page = context.pages()[0] || await context.newPage();
  return { context, page, userDataDir };
}

function findInstalledBrowser() {
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate)) || "";
}

async function waitForProcoreAuth(page, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const title = await page.title().catch(() => "");
    const text = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (
      url.includes("app.procore.com") &&
      !url.includes("login") &&
      !/sign in|log in|password|verification code/i.test(text) &&
      (/Procore|Observations|Project Tools|Company/i.test(title + "\n" + text))
    ) {
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

async function commandLoginCheck(args) {
  const { context, page, userDataDir } = await launchBrowser(args);
  const startUrl = env("PROCORE_START_URL", args.url || DEFAULT_START_URL);
  await page.goto(startUrl, { waitUntil: "domcontentloaded" });

  const timeoutMs = Number(args.timeout || 120000);
  const ok = await waitForProcoreAuth(page, timeoutMs);
  const result = {
    authenticated: ok,
    title: await page.title().catch(() => ""),
    url: page.url(),
    profile: userDataDir
  };
  console.log(JSON.stringify(result, null, 2));

  if (!args["keep-open"]) await context.close();
  if (!ok) {
    console.log("");
    console.log("If Procore needs login or MFA, run open-login, complete login, close that browser window, then rerun login-check.");
    process.exitCode = 2;
  }
}

async function commandOpenLogin(args) {
  const profileDir = path.resolve(env("PROCORE_BROWSER_PROFILE", args["profile-dir"] || DEFAULT_USER_DATA_DIR));
  const startUrl = env("PROCORE_START_URL", args.url || DEFAULT_START_URL);
  const executablePath = env("PROCORE_BROWSER_EXECUTABLE", args["browser-executable"] || findInstalledBrowser());
  const port = String(env("PROCORE_CDP_PORT", args.port || DEFAULT_CDP_PORT));
  if (!executablePath) throw new Error("Could not find an installed Chrome or Edge browser.");
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executablePath, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    startUrl
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  console.log(`Opened Procore login window with profile: ${profileDir}`);
  console.log(`Chrome control port: ${port}`);
  console.log("Complete login there, then close that browser window before running login-check.");
}

async function commandEnvCheck(_args) {
  const values = {
    PROCORE_EMAIL: env("PROCORE_EMAIL") ? "set" : "missing",
    PROCORE_PASSWORD: env("PROCORE_PASSWORD") ? "set" : "missing",
    PROCORE_OBSERVATIONS_URL: env("PROCORE_OBSERVATIONS_URL") || "missing",
    PROCORE_OBSERVATIONS_URLS: env("PROCORE_OBSERVATIONS_URLS") || "missing",
    PROCORE_COMPANY_ID: env("PROCORE_COMPANY_ID") || "missing",
    PROCORE_CDP_PORT: env("PROCORE_CDP_PORT", DEFAULT_CDP_PORT),
    PROCORE_START_URL: env("PROCORE_START_URL", DEFAULT_START_URL)
  };
  console.log(JSON.stringify(values, null, 2));
  if (values.PROCORE_EMAIL === "missing" || values.PROCORE_PASSWORD === "missing") {
    process.exitCode = 2;
  }
}

async function commandExtractAuto(args) {
  const rows = await runAutoExtractionRows(args);
  const outDir = path.resolve(args["out-dir"] || path.join(__dirname, "output", "auto"));
  const files = writeReviewFiles(rows, outDir);
  console.log(`Rows extracted: ${rows.length}`);
  console.log(`Rows written: ${rows.length}`);
  console.log(`CSV review file: ${files.csvPath}`);
  console.log(`JSON review file: ${files.jsonPath}`);
}

async function commandSyncAuto(args) {
  const rows = await runAutoExtractionRows(args);
  const commandProjects = await fetchCommandCenterProjects();
  const { tasks, skipped } = buildProcoreTasks(rows, commandProjects);
  const reviewTasks = skipped.map(item => normalizeProcoreReviewTask(item.row, item.reason));
  const outDir = path.resolve(args["out-dir"] || path.join(__dirname, "output", "sync-auto"));
  const files = writeReviewFiles(rows, outDir);
  const auth = await getCommandCenterAuthIfConfigured();
  const replaceProjectIds = args["complete-missing"] === true
    ? [...new Set([...tasks.map(task => String(task.projectId)), ...currentSourceProjectIds(commandProjects, "procore")])]
    : [];
  const result = await syncToCommandCenter(tasks, replaceProjectIds, auth);
  const reviewResult = await syncProcoreReviewTasks(reviewTasks, auth, commandProjects);
  const recorded = (result && result.recorded && result.recorded !== "success") ? result.recorded : "success";
  const runPayload = {
    status: recorded,
    recordsSeen: rows.length,
    recordsWritten: recorded === "success" ? tasks.length + reviewTasks.length : 0,
    projectCount: new Set([...tasks.map(task => String(task.projectId)), ...reviewTasks.map(task => String(task.projectId))]).size,
    message: recorded === "success"
      ? `${tasks.length} mapped, ${reviewTasks.length} sent to review bucket.`
      : ((result && result.message) || "Empty extract; replace/wipe skipped.")
  };
  if (auth) {
    await recordCommandCenterSyncRun("procore", runPayload, auth);
  } else {
    applySyncRunToD1("procore", runPayload);
  }

  console.log(`Rows extracted: ${rows.length}`);
  console.log(`Rows mapped to Command Center: ${tasks.length}`);
  console.log(`Rows sent to review bucket: ${reviewTasks.length}`);
  console.log(`CSV review file: ${files.csvPath}`);
  console.log(`JSON review file: ${files.jsonPath}`);
  console.log("Command Center sync complete:");
  console.log(JSON.stringify(result, null, 2));
  console.log("Procore review bucket sync complete:");
  console.log(JSON.stringify(reviewResult, null, 2));
  if (reviewTasks.length) {
    console.log("");
    console.log("Review bucket observations:");
    skipped.forEach(item => console.log(`- #${item.number}: ${item.reason} - ${item.title}`));
  }
}

async function commandInspectAuto(args) {
  const email = requiredEnv("PROCORE_EMAIL");
  const password = requiredEnv("PROCORE_PASSWORD");
  const url = args.url || env("PROCORE_START_URL", DEFAULT_START_URL);
  const port = String(env("PROCORE_CDP_PORT", args.port || DEFAULT_CDP_PORT));
  const profileDir = path.resolve(env("PROCORE_BROWSER_PROFILE", args["profile-dir"] || DEFAULT_USER_DATA_DIR));
  await startDebugChrome({ ...args, port, "profile-dir": profileDir, url: env("PROCORE_START_URL", DEFAULT_START_URL) });
  const { client } = await cdpPage({ ...args, port });
  try {
    const loginState = await automateLoginCdp(client, { email, password, companyId: env("PROCORE_COMPANY_ID"), timeoutMs: Number(args["login-timeout"] || 90000) });
    if (!loginState.authenticated) {
      console.log(JSON.stringify(loginState, null, 2));
      throw new Error(loginState.reason || "Procore login did not complete.");
    }
    await client.send("Page.navigate", { url });
    await delay(Number(args.delay || 8000));
    const result = await client.send("Runtime.evaluate", {
      expression: `JSON.stringify((() => ({
        title: document.title,
        url: location.href,
        text: (document.body ? document.body.innerText : '').slice(0, 12000),
        links: [...document.querySelectorAll('a[href]')].slice(0, 300).map(a => ({ text: a.textContent.trim().replace(/\\s+/g, ' ').slice(0, 160), href: a.href }))
      }))())`,
      returnByValue: true
    });
    console.log(result.result.value || "{}");
  } finally {
    if (args["keep-open"]) client.close();
    else await closeBrowserCdp(client);
  }
}

async function runAutoExtractionRows(args) {
  const attempts = Number(args.attempts || env("PROCORE_SYNC_ATTEMPTS", DEFAULT_AUTO_ATTEMPTS));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!args.quiet) console.log(`Procore extraction attempt ${attempt}/${attempts} started.`);
      const rows = await runAutoExtractionRowsOnce(args);
      if (!args.quiet) console.log(`Procore extraction attempt ${attempt}/${attempts} completed with ${rows.length} row(s).`);
      return rows;
    } catch (error) {
      lastError = error;
      console.error(`Procore extraction attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await delay(Number(args["retry-delay"] || 5000));
    }
  }
  throw lastError || new Error("Procore extraction failed.");
}

async function runAutoExtractionRowsOnce(args) {
  const email = requiredEnv("PROCORE_EMAIL");
  const password = requiredEnv("PROCORE_PASSWORD");
  const urls = observationUrls(args);
  if (!urls.length) throw new Error("Provide --url or set PROCORE_OBSERVATIONS_URLS in procore-browser-sync/.env.");

  const port = String(env("PROCORE_CDP_PORT", args.port || DEFAULT_CDP_PORT));
  const profileDir = path.resolve(env("PROCORE_BROWSER_PROFILE", args["profile-dir"] || DEFAULT_USER_DATA_DIR));
  await startDebugChrome({ ...args, port, "profile-dir": profileDir, url: env("PROCORE_START_URL", DEFAULT_START_URL) });

  const { client } = await cdpPage({ ...args, port });
  try {
    await client.send("Page.enable").catch(() => {});
    const loginState = await automateLoginCdp(client, { email, password, companyId: env("PROCORE_COMPANY_ID"), timeoutMs: Number(args["login-timeout"] || 90000) });
    if (!loginState.authenticated) {
      console.log(JSON.stringify(loginState, null, 2));
      throw new Error(loginState.reason || "Procore login did not complete.");
    }

    const allRows = [];
    for (const url of urls) {
      if (!args.quiet) console.log(`Reading Procore observations: ${url}`);
      await client.send("Page.navigate", { url });
      await waitForPageReadyCdp(client, Number(args["page-timeout"] || DEFAULT_PAGE_TIMEOUT_MS)).catch(() => {});
      const projectId = procoreProjectIdFromUrl(url);
      let rows = await waitForRowsCdp(client, Number(args.timeout || DEFAULT_PAGE_TIMEOUT_MS));
      if (!args.quiet) console.log(`Rows found before detail check: ${rows.length}`);
      rows = await enrichRowsFromDetailsCdp(client, rows, { ...args, procoreProjectId: projectId });
      assertUsableProcoreRows(rows, args, url);
      if (!args.quiet) console.log(`Rows ready before filters: ${rows.length}`);
      rows.forEach(row => allRows.push({ ...row, procoreProjectId: row.procoreProjectId || projectId, observationsUrl: url }));
    }
    return allRows.filter(row => {
      if (args["ati-only"] !== false && row.assigneeCompany !== "ATI OF AMERICA") return false;
      if (args["open-only"] !== false && row.status === "Closed") return false;
      return true;
    }).map(row => ({
      ...row,
      dateNotified: normalizeDate(row.dateNotified),
      dateCreated: normalizeDate(row.dateCreated),
      dueDate: normalizeDate(row.dueDate)
    }));
  } finally {
    if (args["keep-open"]) client.close();
    else await closeBrowserCdp(client);
  }
}

function assertUsableProcoreRows(rows, args, url) {
  if (!rows.length && args["allow-empty"] !== true) {
    throw new Error(`Procore returned zero observation rows for ${url}. Use --allow-empty only after manually verifying this project has no observations.`);
  }
  const missingStatus = rows.filter(row => !String(row.status || "").trim());
  if (missingStatus.length && args["allow-missing-status"] !== true) {
    throw new Error(`Procore returned ${missingStatus.length} observation row(s) without status for ${url}: ${missingStatus.slice(0, 5).map(row => `#${row.number || "unknown"}`).join(", ")}`);
  }
}

function observationUrls(args) {
  if (args.url) return [args.url];
  const multiple = env("PROCORE_OBSERVATIONS_URLS");
  if (multiple) {
    return multiple.split(/[;\r\n,]+/).map(url => url.trim()).filter(Boolean);
  }
  return [env("PROCORE_OBSERVATIONS_URL")].filter(Boolean);
}

function procoreProjectIdFromUrl(url) {
  return (String(url || "").match(/projects\/(\d+)/) || [])[1] || "";
}

async function fetchCommandCenterProjects() {
  const apiUrl = commandCenterApiUrl();
  const json = await requestJson(apiUrl, { method: "GET" });
  return Array.isArray(json) ? json : rowsFrom(json.data || json);
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.rows)) return value.rows;
  if (value && Array.isArray(value.results)) return value.results;
  if (value && value.row) return [value.row];
  return [];
}

function buildProcoreTasks(rows, commandProjects) {
  const tasks = [];
  const skipped = [];
  rows.forEach(row => {
    const project = inferCommandProject(row, commandProjects);
    if (!project) {
      skipped.push({ number: row.number, title: row.title, reason: "No confident Command Center project match", row });
      return;
    }
    tasks.push(normalizeProcoreTask(row, project));
  });
  return { tasks, skipped };
}

function inferCommandProject(row, commandProjects) {
  const haystack = `${row.location || ""} ${row.title || ""} ${row.description || ""}`.toLowerCase();
  const byName = new Map(commandProjects.map(project => [String(project.name || "").toLowerCase(), project]));
  if (String(row.project || "").includes("825104")) return byName.get("skier services") || null;
  const unitNumber = inferUnitNumber(row);
  if (unitNumber >= 1 && unitNumber <= 12) return byName.get(`wpr unit ${unitNumber}`) || null;
  if (/penthouse|unit\s*#?300|level\s*03/.test(haystack)) return byName.get("wpr condo penthouse") || null;
  if (/unit\s+201\/202>[^>]*\bb\d{3}\b|>[^>]*\bb\d{3}\b|\bunit\s*#?202\b/.test(haystack)) return byName.get("wpr condo 202") || null;
  if (/unit\s+201\/202>[^>]*\ba\d{3}\b|>[^>]*\ba\d{3}\b|\bunit\s*#?201\b(?!\/)/.test(haystack)) return byName.get("wpr condo 201") || null;
  if (/unit\s+101\/102>[^>]*\bb\d{3}\b|>[^>]*\bb\d{3}\b|\bunit\s*#?102\b/.test(haystack)) return byName.get("wpr condo 102") || null;
  if (/unit\s+101\/102>[^>]*\ba\d{3}\b|>[^>]*\ba\d{3}\b|\bunit\s*#?101\b(?!\/)/.test(haystack)) return byName.get("wpr condo 101") || null;
  return null;
}

function inferUnitNumber(row) {
  const projectText = String(row.project || "");
  const text = `${row.location || ""} ${row.title || ""} ${row.description || ""}`;
  if (/\bunits?\s*#?\s*\d{1,2}\s*(?:[,/&-]|\band\b)/i.test(text)) return null;
  const matches = [...text.matchAll(/\bunit\s*#?\s*(\d{1,3})\b/gi)].map(match => Number(match[1]));
  const smallUnits = [...new Set(matches.filter(value => value >= 1 && value <= 12))];
  if (smallUnits.length === 1) return smallUnits[0];
  if (smallUnits.length > 1) return null;
  if (/823140/.test(projectText)) {
    const fromLocation = [...text.matchAll(/(?:^|[^0-9])([1-6])(?:[^0-9]|$)/g)].map(match => Number(match[1])).find(Boolean);
    return fromLocation || null;
  }
  if (/824124/.test(projectText)) {
    const fromLocation = [...text.matchAll(/(?:^|[^0-9])([78])(?:[^0-9]|$)/g)].map(match => Number(match[1])).find(Boolean);
    return fromLocation || null;
  }
  if (/825106/.test(projectText)) {
    const fromLocation = [...text.matchAll(/(?:^|[^0-9])(9|10|11|12)(?:[^0-9]|$)/g)].map(match => Number(match[1])).find(Boolean);
    return fromLocation || null;
  }
  return null;
}

function normalizeProcoreTask(row, project) {
  const itemId = (String(row.itemUrl || "").match(/items\/(\d+)/) || [])[1] || row.number;
  const procoreProjectId = row.procoreProjectId || (String(row.itemUrl || "").match(/app\.procore\.com\/(\d+)\/project/) || [])[1] || "unknown";
  return {
    id: `procore-${procoreProjectId}-${itemId}`,
    projectId: project.id,
    name: `Procore #${row.number}: ${row.title}`,
    status: normalizeProcoreStatus(row.status),
    sourceState: row.status || "",
    priority: commandCenterProcorePriority(row),
    externalId: `procore-${procoreProjectId}-${itemId}`,
    externalProjectId: `procore-${procoreProjectId}`,
    externalProjectName: row.project,
    externalUrl: row.detailUrl || row.itemUrl,
    assignee: row.assignee,
    dueDate: "",
    sourceUpdatedAt: row.dateNotified,
    notes: [
      `Type: ${row.type}`,
      `Procore Status: ${row.status}`,
      `Assignee: ${row.assignee} (${row.assigneeCompany})`,
      `Date Notified: ${row.dateNotified}`,
      `Created By: ${row.createdBy}`,
      row.location ? `Location: ${row.location}` : "",
      row.specSection ? `Spec Section: ${row.specSection}` : "",
      `Description: ${row.description}`,
      row.pdfUrl ? `PDF: ${row.pdfUrl}` : ""
    ].filter(Boolean).join("\n")
  };
}

function normalizeProcoreReviewTask(row, reason) {
  return {
    ...normalizeProcoreTask(row, { id: null }),
    name: `Review Procore #${row.number}: ${row.title}`,
    status: "todo",
    priority: "medium",
    notes: [
      `Review Reason: ${reason}`,
      `Procore Project: ${row.project || row.procoreProjectId || ""}`,
      `Type: ${row.type}`,
      `Procore Status: ${row.status}`,
      `Assignee: ${row.assignee} (${row.assigneeCompany})`,
      `Date Notified: ${row.dateNotified}`,
      `Created By: ${row.createdBy}`,
      row.location ? `Location: ${row.location}` : "",
      row.specSection ? `Spec Section: ${row.specSection}` : "",
      `Description: ${row.description}`,
      row.pdfUrl ? `PDF: ${row.pdfUrl}` : ""
    ].filter(Boolean).join("\n")
  };
}

function normalizeProcoreStatus(value) {
  const text = String(value || "").toLowerCase();
  if (text === "closed") return "done";
  if (text.includes("review")) return "progress";
  return "todo";
}

function commandCenterProcorePriority(row) {
  const status = String(row && row.status || "").trim().toLowerCase();
  if (status === "closed") return "";
  if (status.includes("ready") && status.includes("review")) return "";

  if (["initiated", "not accepted", "work required"].includes(status)) {
    const ageDays = businessDaysSince(row.dateNotified);
    if (ageDays >= 8) return "critical-aging";
    if (ageDays >= 4) return "needs-action";
    if (ageDays >= 2) return "due-soon";
    return "new";
  }

  return "";
}

function businessDaysSince(value) {
  const date = parseDateOnly(value);
  if (!date) return 4;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let count = 0;
  for (let cursor = new Date(date); cursor < today; cursor.setDate(cursor.getDate() + 1)) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function parseDateOnly(value) {
  const text = normalizeDate(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeProcorePriority(value) {
  const text = String(value || "").toLowerCase();
  if (["new", "due-soon", "needs-action", "critical-aging"].includes(text)) return text;
  if (["urgent", "high"].includes(text)) return "high";
  if (["normal", "medium", "med"].includes(text)) return "medium";
  if (text === "low") return "low";
  return "";
}

function currentSourceProjectIds(commandProjects, source) {
  const expected = syncedTaskSource(source);
  const values = new Set(expected.values.map(value => String(value).toLowerCase()));
  return commandProjects
    .filter(project => (project.taskList || []).some(task => values.has(String(task.source || "").toLowerCase())))
    .map(project => String(project.id));
}

async function syncToCommandCenter(tasks, replaceProjectIds, auth) {
  if (!auth) {
    return applySourceTasksToD1({
      source: "procore",
      tasks,
      replaceProjectIds
    });
  }

  const apiUrl = commandCenterApiUrl();
  const json = await requestJson(apiUrl, {
    method: "POST",
    headers: commandCenterHeaders(auth),
    body: JSON.stringify({
      action: "syncSourceTasks",
      source: "procore",
      replaceProjectIds,
      tasks
    })
  });
  if (json && json.ok === false) throw new Error(json.error || "Command Center sync failed");
  return json.result || {};
}

function dualWriteTaskSyncDecision(sync) {
  const tasks = Array.isArray(sync && sync.tasks) ? sync.tasks : [];
  const replaceProjectIds = [...new Set(((sync && sync.replaceProjectIds) || []).map(String).filter(Boolean))];
  const raw = String((sync && (sync.sourceOpStatus || sync.syncStatus)) || "").trim().toLowerCase();
  let sourceOpStatus = "";
  if (["success", "failed", "skipped", "requested"].includes(raw)) sourceOpStatus = raw;
  else if (raw) sourceOpStatus = "unknown";

  if (sourceOpStatus === "failed" || sourceOpStatus === "skipped" || sourceOpStatus === "unknown") {
    return {
      skipTaskWrite: true,
      recorded: sourceOpStatus,
      message: (sync && sync.message) || (
        sourceOpStatus === "skipped"
          ? "Source operation skipped; task rows not mutated."
          : "Source operation did not succeed; task rows not mutated."
      )
    };
  }

  if (tasks.length === 0 && replaceProjectIds.length > 0) {
    // Honesty (CC-WO-2026-004): empty extract + replace must not wipe+success.
    // Existing caller options on this path: --complete-missing sets replaceProjectIds
    // (that is the wipe *cause*, not an empty-wipe opt-in). --allow-empty is extract-time
    // (zero observation rows) and is not a D1 empty-replace opt-in. There is no existing
    // D1 empty-wipe flag. Do not invent a new production empty-replace flag. Default: skip wipe+success.
    return {
      skipTaskWrite: true,
      recorded: sourceOpStatus === "success" ? "skipped" : (sourceOpStatus || "skipped"),
      message: (sync && sync.message) || "Empty extract; replace/wipe skipped."
    };
  }

  return { skipTaskWrite: false, recorded: "success" };
}

function applySourceTasksToD1(sync) {
  const decision = dualWriteTaskSyncDecision(sync);
  if (decision.skipTaskWrite) {
    return {
      mutated: false,
      recorded: decision.recorded,
      appliedViaD1: false,
      tasks: 0,
      replaceProjectIds: Array.isArray(sync && sync.replaceProjectIds) ? sync.replaceProjectIds.length : 0,
      message: decision.message
    };
  }

  const lines = [];
  if (sync.ensureReviewProject) appendReviewProjectSql(lines, sync.ensureReviewProject);
  appendSourceTaskSyncSql(lines, sync);
  if (!lines.length) return { created: 0, updated: 0, skipped: 0, completedMissing: 0, mutated: false, recorded: "success" };

  fs.mkdirSync(path.dirname(SQL_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(SQL_OUTPUT_PATH, lines.join("\n") + "\n", "utf8");
  applySqlFileToD1(SQL_OUTPUT_PATH);
  return {
    appliedViaD1: true,
    mutated: true,
    recorded: "success",
    tasks: sync.tasks.length,
    replaceProjectIds: sync.replaceProjectIds.length
  };
}

function appendReviewProjectSql(lines, project) {
  lines.push(
    "INSERT INTO projects (id, name, project_group, segment, external_team, percent, starts_at, ends_at) " +
    `VALUES ('procore-observation-review', ${sqlString(project.name)}, ${sqlString(project.projectGroup)}, ${sqlString(project.segment)}, ${sqlString(project.externalTeam)}, 0, '', '') ` +
    "ON CONFLICT(id) DO UPDATE SET name = excluded.name, project_group = excluded.project_group, segment = excluded.segment, external_team = excluded.external_team;"
  );
}

function appendSourceTaskSyncSql(lines, sync) {
  const decision = dualWriteTaskSyncDecision(sync);
  if (decision.skipTaskWrite) return decision;

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
      `${sqlString(normalizeDate(task.dueDate || ""))}, ${sqlString(normalizeProcorePriority(task.priority))}, ${sqlString(String(task.assignee || "").trim().slice(0, 160))}, ` +
      `${sqlString(String(task.sourceUpdatedAt || "").trim().slice(0, 80))}, 'SYNC', ${sqlString(now)}) ` +
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
  const useLocalWrangler = fs.existsSync(wranglerBin);
  const command = useLocalWrangler && process.platform === "win32" ? process.execPath : useLocalWrangler ? wranglerBin : "npx";

  console.log(`Applying Procore sync directly to Cloudflare D1: ${sqlPath}`);
  const statements = fs.readFileSync(sqlPath, "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
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
  const source = String(value || "").trim().toLowerCase();
  if (source === "procore" || source === "procore-review") return { primary: source, values: ["procore", "procore-review", "Procore"] };
  throw new Error(`Invalid synced task source: ${source}`);
}

function normalizedSyncedTaskId(source, value) {
  const id = String(value || "").trim().replace(/\s+/g, "-").slice(0, 120);
  if (!id) throw new Error("Synced task id is required");
  return id.startsWith(`${source}-`) ? id : `${source}-${id}`;
}

function syncedTaskStatus(value) {
  const status = String(value || "").trim().toLowerCase();
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

async function syncProcoreReviewTasks(tasks, auth, commandProjects) {
  const reviewProjectFields = {
    name: "Procore Observation Review",
    projectGroup: "Review",
    segment: "Unmapped Procore",
    externalTeam: "Procore"
  };
  const reviewProject = auth
    ? await ensureCommandCenterProject(reviewProjectFields, auth)
    : commandProjects.find(project => String(project.name || "").trim().toLowerCase() === reviewProjectFields.name.toLowerCase());

  if (!reviewProject || !reviewProject.id) {
    return applySourceTasksToD1({
      source: "procore-review",
      tasks: tasks.map(task => ({ ...task, projectId: "procore-observation-review" })),
      replaceProjectIds: ["procore-observation-review"],
      ensureReviewProject: reviewProjectFields
    });
  }

  const reviewTasks = tasks.map(task => ({ ...task, projectId: reviewProject.id }));
  if (!auth) {
    return applySourceTasksToD1({
      source: "procore-review",
      tasks: reviewTasks,
      replaceProjectIds: [String(reviewProject.id)]
    });
  }

  const apiUrl = commandCenterApiUrl();
  const json = await requestJson(apiUrl, {
    method: "POST",
    headers: commandCenterHeaders(auth),
    body: JSON.stringify({
      action: "syncSourceTasks",
      source: "procore-review",
      replaceProjectIds: reviewProject.id ? [String(reviewProject.id)] : [],
      tasks: reviewTasks
    })
  });
  if (json && json.ok === false) throw new Error(json.error || "Command Center review sync failed");
  return json.result || {};
}

async function getCommandCenterAuthIfConfigured() {
  const session = env("COMMAND_CENTER_SESSION");
  const initials = env("COMMAND_CENTER_INITIALS", "SYNC");
  if (session) return { token: session, initials };

  const accessCode = env("COMMAND_CENTER_ACCESS_CODE");
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

async function recordCommandCenterSyncRun(source, payload, auth) {
  const json = await requestJson(commandCenterApiUrl(), {
    method: "POST",
    headers: commandCenterHeaders(auth),
    body: JSON.stringify({
      action: "recordSyncRun",
      source,
      label: source === "procore" ? "Procore" : source,
      ...payload
    })
  });
  if (json && json.ok === false) throw new Error(json.error || "Command Center sync status update failed");
  return json;
}

async function reportProcoreSyncFailure(error) {
  const auth = await getCommandCenterAuthIfConfigured();
  if (!auth) {
    applySyncRunToD1("procore", {
      status: "failed",
      recordsSeen: 0,
      recordsWritten: 0,
      projectCount: 0,
      message: error.message || "Procore sync failed."
    });
    return;
  }
  await recordCommandCenterSyncRun("procore", {
    status: "failed",
    recordsSeen: 0,
    recordsWritten: 0,
    projectCount: 0,
    message: error.message || "Procore sync failed."
  }, auth);
}

function applySyncRunToD1(source, payload) {
  const now = new Date().toISOString();
  const status = ["success", "failed", "skipped"].includes(String(payload.status || "").toLowerCase()) ? String(payload.status).toLowerCase() : "unknown";
  const lastSuccessAt = status === "success" ? now : "";
  const message = String(payload.message || "").trim().slice(0, 500);
  const line = "INSERT INTO sync_runs (source, label, status, last_attempt_at, last_success_at, records_seen, records_written, project_count, message, updated_at, updated_by) VALUES " +
    `(${sqlString(source)}, ${sqlString(source === "procore" ? "Procore" : source)}, ${sqlString(status)}, ${sqlString(now)}, ${sqlString(lastSuccessAt)}, ` +
    `${safeCount(payload.recordsSeen)}, ${safeCount(payload.recordsWritten)}, ${safeCount(payload.projectCount)}, ${sqlString(message)}, ${sqlString(now)}, 'SYNC') ` +
    "ON CONFLICT(source) DO UPDATE SET label = excluded.label, status = excluded.status, last_attempt_at = excluded.last_attempt_at, " +
    "last_success_at = CASE WHEN excluded.status = 'success' THEN excluded.last_success_at ELSE sync_runs.last_success_at END, " +
    "records_seen = excluded.records_seen, records_written = excluded.records_written, project_count = excluded.project_count, " +
    "message = excluded.message, updated_at = excluded.updated_at, updated_by = excluded.updated_by;";
  fs.mkdirSync(path.dirname(SQL_OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(SQL_OUTPUT_PATH, `${line}\n`, "utf8");
  applySqlFileToD1(SQL_OUTPUT_PATH);
}

function commandCenterHeaders(auth) {
  return {
    "Content-Type": "application/json",
    "x-command-center-session": auth.token,
    "x-command-center-initials": auth.initials
  };
}

function commandCenterApiUrl() {
  const configured = env("COMMAND_CENTER_API_URL");
  if (/^https:\/\/wpr-command-center-api\./.test(configured) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\b/.test(configured)) {
    return configured;
  }
  return LIVE_COMMAND_CENTER_API_URL;
}

async function ensureCommandCenterProject(project, auth) {
  const existing = (await fetchCommandCenterProjects()).find(item =>
    String(item.name || "").trim().toLowerCase() === project.name.toLowerCase()
  );
  if (existing) {
    await updateCommandCenterProjectMeta(existing.id, project, auth);
    return { id: existing.id, created: false };
  }

  const apiUrl = commandCenterApiUrl();
  const created = await requestJson(apiUrl, {
    method: "POST",
    headers: commandCenterHeaders(auth),
    body: JSON.stringify({ action: "addProject", name: project.name })
  });
  if (created && created.ok === false) throw new Error(created.error || "Command Center project create failed");

  const next = (await fetchCommandCenterProjects()).find(item =>
    String(item.name || "").trim().toLowerCase() === project.name.toLowerCase()
  );
  if (!next || !next.id) throw new Error("Command Center did not return a project id for " + project.name);
  await updateCommandCenterProjectMeta(next.id, project, auth);
  return { id: next.id, created: true };
}

async function updateCommandCenterProjectMeta(projectId, project, auth) {
  await Promise.all([
    updateCommandCenterProjectField(projectId, "projectGroup", project.projectGroup, auth),
    updateCommandCenterProjectField(projectId, "segment", project.segment, auth),
    updateCommandCenterProjectField(projectId, "externalTeam", project.externalTeam, auth)
  ]);
}

async function updateCommandCenterProjectField(projectId, field, value, auth) {
  const apiUrl = commandCenterApiUrl();
  const json = await requestJson(apiUrl, {
    method: "POST",
    headers: commandCenterHeaders(auth),
    body: JSON.stringify({ action: "updateProjectField", projectId, field, value })
  });
  if (json && json.ok === false) throw new Error(json.error || `Command Center project ${field} update failed`);
}

async function startDebugChrome(args) {
  const port = String(args.port || env("PROCORE_CDP_PORT", DEFAULT_CDP_PORT));
  try {
    await cdpJson(port, "/json/version");
    return;
  } catch {
    // No browser is listening yet.
  }

  const profileDir = path.resolve(env("PROCORE_BROWSER_PROFILE", args["profile-dir"] || DEFAULT_USER_DATA_DIR));
  const startUrl = args.url || env("PROCORE_START_URL", DEFAULT_START_URL);
  const executablePath = env("PROCORE_BROWSER_EXECUTABLE", args["browser-executable"] || findInstalledBrowser());
  if (!executablePath) throw new Error("Could not find an installed Chrome or Edge browser.");
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(executablePath, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    startUrl
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();

  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      await cdpJson(port, "/json/version");
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error(`Chrome did not open a control port on ${port}.`);
}

async function cdpPage(args) {
  const port = String(env("PROCORE_CDP_PORT", args.port || DEFAULT_CDP_PORT));
  const pages = await cdpJson(port, "/json/list");
  const pageInfo = pages.find(page => page.type === "page") || pages[0];
  if (!pageInfo || !pageInfo.webSocketDebuggerUrl) {
    throw new Error(`No debuggable Chrome page found on port ${port}. Run open-login first.`);
  }
  return { client: await createCdpClient(pageInfo.webSocketDebuggerUrl), pageInfo, port };
}

async function closeBrowserCdp(client) {
  try {
    await client.send("Browser.close");
  } catch {
    client.close();
  }
}

async function automateLoginCdp(client, { email, password, companyId, timeoutMs }) {
  await client.send("Page.navigate", { url: env("PROCORE_START_URL", DEFAULT_START_URL) });
  await delay(3000);

  let state = await waitForProcoreAuthCdp(client, 5000);
  if (state.authenticated) return state;

  const start = Date.now();
  let lastState = { title: "", url: "", text: "" };
  let lastFill = null;
  while (Date.now() - start < timeoutMs) {
    lastState = await pageStateCdp(client);
    const combined = `${lastState.title}\n${lastState.url}\n${lastState.text}`;
    if (/verification code|multi-factor|mfa|authenticator|two-factor|check your email|enter code/i.test(combined)) {
      return { authenticated: false, reason: "Procore requires MFA or verification, so credential-only automation is blocked.", title: lastState.title, url: lastState.url };
    }
    if (/invalid|incorrect|try again|unable to sign in/i.test(combined)) {
      return { authenticated: false, reason: "Procore rejected the supplied credentials.", title: lastState.title, url: lastState.url };
    }
    if (lastState.url.includes("/account/select_company") && companyId) {
      await client.send("Page.navigate", { url: `https://app.procore.com/set_company/${companyId}` });
      await delay(3000);
    }
    if (/login|password|sign in|log in|email/i.test(combined)) {
      const fillResult = await client.send("Runtime.evaluate", {
        expression: `(${fillLoginForm.toString()})(${JSON.stringify(email)}, ${JSON.stringify(password)})`,
        returnByValue: true,
        awaitPromise: true
      });
      lastFill = fillResult.result.value || {};
      if (lastFill.ok) await delay(2000);
    }
    state = await waitForProcoreAuthCdp(client, 1000);
    if (state.authenticated) return state;
    await delay(1000);
  }

  return { authenticated: false, reason: "Timed out waiting for Procore login to complete.", title: lastState.title, url: lastState.url, lastFill };
}

function fillLoginForm(email, password) {
  function visible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const emailInput = inputs.find(input => /email|username|login/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.autocomplete} ${input.type}`)) || inputs.find(input => input.type === "email") || inputs.find(input => input.type !== "password");
  const passwordInput = inputs.find(input => input.type === "password");
  if (!emailInput && !passwordInput) return { ok: false, reason: "Login input not found.", inputs: inputs.map(input => ({ type: input.type, name: input.name, id: input.id, placeholder: input.placeholder })) };
  if (emailInput) setValue(emailInput, email);
  if (passwordInput) setValue(passwordInput, password);
  const button = [...document.querySelectorAll("button,input[type=submit]")].filter(visible).find(el => /log in|sign in|continue|next/i.test(el.innerText || el.value || el.getAttribute("aria-label") || "")) || document.querySelector("button,input[type=submit]");
  if (!button) return { ok: false, reason: "Submit button not found." };
  button.click();
  return { ok: true, hasPasswordInput: Boolean(passwordInput), clicked: button.innerText || button.value || button.getAttribute("aria-label") || "submit" };
}

async function commandLoginCheckCdp(args) {
  const { client, pageInfo, port } = await cdpPage(args);
  const startUrl = env("PROCORE_START_URL", args.url || DEFAULT_START_URL);
  if (!pageInfo.url || pageInfo.url === "about:blank") {
    await client.send("Page.navigate", { url: startUrl });
    await delay(3000);
  }
  const timeoutMs = Number(args.timeout || 15000);
  const authState = await waitForProcoreAuthCdp(client, timeoutMs);
  const result = {
    authenticated: authState.authenticated,
    title: authState.title,
    url: authState.url,
    port
  };
  console.log(JSON.stringify(result, null, 2));
  client.close();
  if (!authState.authenticated) process.exitCode = 2;
}

async function commandExtractCdp(args) {
  const { client } = await cdpPage(args);
  const url = args.url || env("PROCORE_OBSERVATIONS_URL");
  if (!url) throw new Error("Provide --url or set PROCORE_OBSERVATIONS_URL in procore-browser-sync/.env.");
  await client.send("Page.navigate", { url });
  const rows = await waitForRowsCdp(client, Number(args.timeout || 45000));
  const filteredRows = rows.filter(row => {
    if (args["ati-only"] && row.assigneeCompany !== "ATI OF AMERICA") return false;
    if (args["open-only"] && row.status === "Closed") return false;
    return true;
  }).map(row => ({
    ...row,
    dateNotified: normalizeDate(row.dateNotified),
    dateCreated: normalizeDate(row.dateCreated),
    dueDate: normalizeDate(row.dueDate)
  }));
  const outDir = path.resolve(args["out-dir"] || path.join(__dirname, "output"));
  const files = writeReviewFiles(filteredRows, outDir);
  console.log(`Rows extracted: ${rows.length}`);
  console.log(`Rows written: ${filteredRows.length}`);
  console.log(`CSV review file: ${files.csvPath}`);
  console.log(`JSON review file: ${files.jsonPath}`);
  client.close();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cdpJson(port, pathName) {
  const response = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    signal: AbortSignal.timeout(DEFAULT_CDP_COMMAND_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`Chrome CDP request failed: ${response.status} ${response.statusText}`);
  return response.json();
}

function createCdpClient(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const socket = new WebSocket(wsUrl);

  function rejectPending(error) {
    for (const [id, item] of pending.entries()) {
      clearTimeout(item.timer);
      item.reject(error);
      pending.delete(id);
    }
  }

  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject, timer } = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
    else resolve(message.result);
  });
  socket.addEventListener("close", () => rejectPending(new Error("Chrome control connection closed.")));
  socket.addEventListener("error", () => rejectPending(new Error("Chrome control connection failed.")));

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    async send(method, params = {}, timeoutMs = DEFAULT_CDP_COMMAND_TIMEOUT_MS) {
      await opened;
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for Chrome command ${method}.`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() {
      socket.close();
    }
  };
}

async function pageStateCdp(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `(() => ({
      title: document.title,
      url: location.href,
      text: document.body ? document.body.innerText.slice(0, 5000) : ''
    }))()`,
    returnByValue: true
  });
  return result.result.value;
}

async function waitForPageReadyCdp(client, timeoutMs) {
  const start = Date.now();
  let lastState = { title: "", url: "", text: "" };
  while (Date.now() - start < timeoutMs) {
    lastState = await pageStateCdp(client);
    if (lastState.url && lastState.url !== "about:blank" && lastState.text) return lastState;
    await delay(1000);
  }
  return lastState;
}

async function waitForProcoreAuthCdp(client, timeoutMs) {
  const start = Date.now();
  let state = { title: "", url: "", text: "" };
  while (Date.now() - start < timeoutMs) {
    state = await pageStateCdp(client);
    if (
      state.url.includes("app.procore.com") &&
      !state.url.includes("login") &&
      !/sign in|log in|password|verification code/i.test(state.text) &&
      /Procore|Observations|Project Tools|Company/i.test(`${state.title}\n${state.text}`)
    ) {
      return { authenticated: true, title: state.title, url: state.url };
    }
    await delay(1000);
  }
  return { authenticated: false, title: state.title, url: state.url };
}

async function extractRowsFromCdp(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify((() => {
      const extractRowsFromCurrentObservationListDom = ${extractRowsFromCurrentObservationListDom.toString()};
      return (${extractRowsFromDom.toString()})();
    })())`,
    returnByValue: true
  });
  return JSON.parse(result.result.value || "[]");
}

async function enrichRowsFromDetailsCdp(client, rows, args = {}) {
  const needsDetails = rows.filter(row => row.detailUrl && (!row.status || !row.dueDate || !row.location || !row.description || args["detail-refresh"]));
  if (!needsDetails.length) return rows;

  const byKey = new Map(rows.map(row => [row.detailUrl || row.itemUrl || row.number, row]));
  const limit = Number(args["detail-limit"] || needsDetails.length);
  for (const row of needsDetails.slice(0, limit)) {
    if (!args.quiet) console.log(`Reading Procore detail #${row.number || "unknown"}`);
    const detail = await readObservationDetailWithRetry(client, row, args);
    delete detail.loading;
    const key = row.detailUrl || row.itemUrl || row.number;
    byKey.set(key, {
      ...row,
      ...Object.fromEntries(Object.entries(detail).filter(([, value]) => value !== "" && value !== null && value !== undefined)),
      detailUrl: row.detailUrl || detail.detailUrl,
      itemUrl: row.itemUrl || detail.itemUrl,
      pdfUrl: row.pdfUrl || detail.pdfUrl,
      procoreProjectId: row.procoreProjectId || args.procoreProjectId || detail.procoreProjectId
    });
  }
  return [...byKey.values()];
}

async function readObservationDetailWithRetry(client, row, args = {}) {
  const detailUrl = row.itemUrl || row.detailUrl;
  const attempts = Number(args["detail-attempts"] || 2);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await client.send("Page.navigate", { url: detailUrl });
      await waitForPageReadyCdp(client, Number(args["detail-page-timeout"] || DEFAULT_PAGE_TIMEOUT_MS)).catch(() => {});
      return await waitForObservationDetailCdp(client, Number(args["detail-timeout"] || DEFAULT_PAGE_TIMEOUT_MS));
    } catch (error) {
      lastError = error;
      console.error(`Procore detail #${row.number || "unknown"} attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await delay(Number(args["detail-retry-delay"] || 3000));
    }
  }
  throw lastError || new Error(`Could not read Procore detail #${row.number || "unknown"}.`);
}

async function waitForObservationDetailCdp(client, timeoutMs) {
  const start = Date.now();
  let detail = {};
  while (Date.now() - start < timeoutMs) {
    detail = await extractObservationDetailFromCdp(client);
    if (detail.status && !detail.loading) return detail;
    await delay(1000);
  }
  const state = await pageStateCdp(client).catch(() => ({ url: "", title: "", text: "" }));
  throw new Error(`Timed out waiting for Procore observation detail: ${state.url || state.title}`);
}

async function extractObservationDetailFromCdp(client) {
  const result = await client.send("Runtime.evaluate", {
    expression: `JSON.stringify((${extractObservationDetailFromDom.toString()})())`,
    returnByValue: true
  });
  return JSON.parse(result.result.value || "{}");
}

async function waitForRowsCdp(client, timeoutMs) {
  const start = Date.now();
  let rows = [];
  let lastState = { title: "", url: "", text: "" };
  while (Date.now() - start < timeoutMs) {
    rows = await extractRowsFromCdp(client);
    if (rows.length > 0) return rows;
    lastState = await pageStateCdp(client).catch(() => lastState);
    await delay(1000);
  }
  if (/sign in|log in|password|verification code|multi-factor|mfa/i.test(`${lastState.title}\n${lastState.url}\n${lastState.text}`)) {
    throw new Error(`Procore page is not authenticated while waiting for observation rows: ${lastState.url}`);
  }
  if (/access denied|not authorized|permission/i.test(lastState.text)) {
    throw new Error(`Procore page denied access while waiting for observation rows: ${lastState.url}`);
  }
  return rows;
}

function extractRowsFromDom() {
  const lines = (document.body.innerText || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
  const itemLinks = [...document.querySelectorAll('a[href*="/project/observations/items/"]:not([href$=".pdf"]),a[href*="/tools/observations/quality/details/"]')]
    .map(a => ({ href: a.href, text: a.textContent.trim().replace(/\s+/g, " ") }))
    .filter(a => a.text && !a.text.match(/^(Export|General|Related Items|Emails|Quality Observations)$/i));
  const pdfLinks = [...document.querySelectorAll('a[href*="/project/observations/items/"][href$=".pdf"]')].map(a => a.href);
  const detailLinks = [...document.querySelectorAll('a[href*="/tools/observations/quality/details/"]')].map(a => a.href);
  const statuses = new Set(["Closed", "Initiated", "Ready For Review", "Not Accepted", "Accepted", "Work Required"]);
  const priorities = new Set(["Low", "Medium", "High", "Urgent"]);
  const types = new Set(["QC Field Observation", "Architect/Engineer/Consultant", "Non-Conformance", "Deficiency", "Work to Complete", "Trade Damage", "Commissioning", "Commissioning - Commissioning"]);
  const companies = new Set(["ATI OF AMERICA", "BIG-D SIGNATURE - PC", "HELIX ELECTRIC OF UTAH LLC", "WALLBOARD SPECIALTIES", "IRON HORSE CONCRETE & CONSTRUCTION"]);
  const isDate = s => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s || "");
  const projectMatch = (document.body.innerText || "").match(/(\d+\s+-\s+WPR[^\n]+)/);

  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] === "View" && /^\d+$/.test(lines[i + 1] || "") && types.has(lines[i + 2] || "")) starts.push(i);
  }

  const oldRows = starts.map((start, idx) => {
    const end = starts[idx + 1] || lines.length;
    const seg = lines.slice(start, end);
    const row = { project: projectMatch?.[1] || "", number: seg[1], type: seg[2] };
    row.title = itemLinks[idx]?.text || "";
    row.itemUrl = itemLinks[idx]?.href || "";
    row.pdfUrl = pdfLinks[idx] || "";
    row.detailUrl = detailLinks[idx] || "";

    let cursor = 3;
    while (cursor < seg.length) {
      const candidate = seg.slice(3, cursor + 1).join(" ").replace(/\s+/g, " ");
      if (candidate === row.title) {
        cursor += 1;
        break;
      }
      if (isDate(seg[cursor])) break;
      cursor += 1;
    }
    if (cursor >= seg.length || !isDate(seg[cursor])) {
      const dateIdx = seg.findIndex((value, index) => index > 2 && isDate(value));
      cursor = dateIdx === -1 ? 3 : dateIdx;
    }

    const preDateLines = seg.slice(3, cursor).filter(value => value !== row.title);
    if (preDateLines.length && companies.has(preDateLines[preDateLines.length - 1])) {
      row.assigneeCompany = preDateLines.pop();
      row.assignee = preDateLines.join(" ");
    } else {
      row.assigneeCompany = "";
      row.assignee = preDateLines.join(" ");
    }

    row.dateNotified = seg[cursor++] || "";
    const createdByParts = [];
    while (cursor < seg.length && !isDate(seg[cursor])) createdByParts.push(seg[cursor++]);
    row.createdBy = createdByParts.join(" ");
    row.dateCreated = seg[cursor++] || "";
    row.dueDate = isDate(seg[cursor]) ? seg[cursor++] : "";

    const beforeStatus = [];
    while (cursor < seg.length && !statuses.has(seg[cursor])) beforeStatus.push(seg[cursor++]);
    row.specSection = beforeStatus.join(" ");
    row.status = statuses.has(seg[cursor]) ? seg[cursor++] : "";
    row.priority = priorities.has(seg[cursor]) ? seg[cursor++] : "";
    row.location = (seg[cursor] || "").startsWith("Building>") ? seg[cursor++] : "";
    row.description = seg.slice(cursor).join(" ");
    return row;
  });
  if (oldRows.length) return oldRows;
  return extractRowsFromCurrentObservationListDom(lines, itemLinks, pdfLinks, projectMatch?.[1] || "");
}

function extractRowsFromCurrentObservationListDom(lines, itemLinks, pdfLinks, project) {
  const types = new Set(["QC Field Observation", "Architect/Engineer/Consultant", "Non-Conformance", "Deficiency", "Work to Complete", "Trade Damage", "Commissioning", "Commissioning - Commissioning"]);
  const companies = new Set(["ATI OF AMERICA", "BIG-D SIGNATURE - PC", "HELIX ELECTRIC OF UTAH LLC", "WALLBOARD SPECIALTIES", "IRON HORSE CONCRETE & CONSTRUCTION"]);
  const isDate = s => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s || "");
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\d+$/.test(lines[i] || "") && types.has(lines[i + 1] || "")) starts.push(i);
  }

  return starts.map((start, idx) => {
    const end = starts[idx + 1] || lines.length;
    const seg = lines.slice(start, end);
    const link = itemLinks[idx] || {};
    const detailUrl = link.href || "";
    const itemId = (detailUrl.match(/details\/(\d+)/) || detailUrl.match(/items\/(\d+)/) || [])[1] || "";
    const procoreProjectId = (detailUrl.match(/projects\/(\d+)/) || [])[1] || "";
    const title = link.text || seg.find((value, index) => index > 1 && !companies.has(value) && !isDate(value)) || "";
    const titleIndex = seg.findIndex(value => value === title);
    const afterTitle = titleIndex === -1 ? seg.slice(2) : seg.slice(titleIndex + 1);
    const assigneeCompanyIndex = afterTitle.findIndex(value => companies.has(value));
    const assignee = assigneeCompanyIndex > 0 ? afterTitle.slice(0, assigneeCompanyIndex).filter(value => !/^[A-Z]{1,4}$/.test(value)).join(" ") : "";
    const dateNotified = afterTitle.find(isDate) || "";
    return {
      project,
      number: seg[0] || "",
      type: seg[1] || "",
      title,
      itemUrl: itemId && procoreProjectId ? `https://app.procore.com/${procoreProjectId}/project/observations/items/${itemId}` : "",
      pdfUrl: pdfLinks[idx] || "",
      detailUrl,
      assignee,
      assigneeCompany: assigneeCompanyIndex >= 0 ? afterTitle[assigneeCompanyIndex] : "",
      dateNotified,
      createdBy: "",
      dateCreated: "",
      dueDate: "",
      specSection: "",
      status: "",
      priority: "",
      location: "",
      description: "",
      procoreProjectId
    };
  });
}

function extractObservationDetailFromDom() {
  const text = document.body?.innerText || "";
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const statuses = new Set(["Closed", "Initiated", "Ready For Review", "Not Accepted", "Accepted", "Work Required"]);
  const labels = new Set([
    "Type", "No.", "Title", "Status", "Assignee", "Due Date", "Spec Section", "Priority",
    "Location", "Distribution", "Private", "Created By", "Date Created", "Notification Date",
    "Linked Drawings", "Description", "Attachments", "Activity Feed", "Trade", "Hazard",
    "Contributing Behavior", "Contributing Condition", "Select a status"
  ]);
  const valueAfter = label => {
    const index = lines.findIndex(line => line.toLowerCase() === label.toLowerCase());
    const value = index === -1 ? "" : lines[index + 1] || "";
    if (value === "--" || value === "Loading" || labels.has(value)) return "";
    return value;
  };
  const statusFromText = () => {
    const direct = valueAfter("Status");
    if (statuses.has(direct)) return direct;
    const sentence = text.match(/This Observation is ([A-Za-z ]+?) and is in/i) || text.match(/Observation (Ready for Review)/i);
    if (!sentence) return "";
    const value = sentence[1].replace(/\b\w/g, char => char.toUpperCase());
    return statuses.has(value) ? value : "";
  };
  const detailUrl = location.href;
  const procoreProjectId = (detailUrl.match(/projects\/(\d+)/) || [])[1] || (detailUrl.match(/app\.procore\.com\/(\d+)\/project/) || [])[1] || "";
  const number = valueAfter("No.") || (text.match(/Observation\s+(\d+):/) || [])[1] || "";
  const itemId = (detailUrl.match(/details\/(\d+)/) || [])[1] || (detailUrl.match(/items\/(\d+)/) || [])[1] || "";
  const assigneeRaw = valueAfter("Assignee");
  const assigneeMatch = assigneeRaw.match(/^(.*?)\s*\((.*?)\)$/);
  const locationIndex = lines.findIndex(line => line.toLowerCase() === "location");
  const locationRaw = locationIndex === -1 ? "" : lines[locationIndex + 1] || "";
  const locationLoaded = locationIndex !== -1 && locationRaw !== "Loading" && locationRaw !== "Distribution";
  const descriptionIndex = lines.findIndex(line => line.toLowerCase() === "description");
  const attachmentIndex = lines.findIndex((line, index) => index > descriptionIndex && /^(attachments|activity feed|related items|emails)$/i.test(line));
  const description = descriptionIndex === -1 ? "" : lines.slice(descriptionIndex + 1, attachmentIndex === -1 ? descriptionIndex + 1 : attachmentIndex).join(" ");
  return {
    project: (text.match(/(\d+\s+-\s+WPR[^\n]+)/) || [])[1] || "",
    number,
    type: valueAfter("Type").replace(/^Quality\s+-\s+/i, ""),
    title: valueAfter("Title"),
    itemUrl: itemId && procoreProjectId ? `https://app.procore.com/${procoreProjectId}/project/observations/items/${itemId}` : "",
    pdfUrl: itemId && procoreProjectId ? `https://app.procore.com/${procoreProjectId}/project/observations/items/${itemId}.pdf` : "",
    detailUrl,
    assignee: assigneeMatch ? assigneeMatch[1] : assigneeRaw,
    assigneeCompany: assigneeMatch ? assigneeMatch[2] : "",
    dateNotified: valueAfter("Notification Date"),
    createdBy: valueAfter("Created By"),
    dateCreated: valueAfter("Date Created"),
    dueDate: valueAfter("Due Date"),
    specSection: valueAfter("Spec Section"),
    status: statusFromText(),
    priority: valueAfter("Priority"),
    location: valueAfter("Location").replace(/\s+>\s+/g, ">"),
    description,
    procoreProjectId,
    loading: !locationLoaded || lines.some((line, index) => line === "Loading" && labels.has(lines[index - 1] || ""))
  };
}

async function extractRowsFromPage(page) {
  return page.evaluate(() => {
    const lines = (document.body.innerText || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
    const itemLinks = [...document.querySelectorAll('a[href*="/project/observations/items/"]:not([href$=".pdf"]),a[href*="/tools/observations/quality/details/"]')]
      .map(a => ({ href: a.href, text: a.textContent.trim().replace(/\s+/g, " ") }))
      .filter(a => a.text && !a.text.match(/^(Export|General|Related Items|Emails|Quality Observations)$/i));
    const pdfLinks = [...document.querySelectorAll('a[href*="/project/observations/items/"][href$=".pdf"]')].map(a => a.href);
    const detailLinks = [...document.querySelectorAll('a[href*="/tools/observations/quality/details/"]')].map(a => a.href);
    const statuses = new Set(["Closed", "Initiated", "Ready For Review", "Not Accepted", "Accepted", "Work Required"]);
    const priorities = new Set(["Low", "Medium", "High", "Urgent"]);
    const types = new Set(["QC Field Observation", "Architect/Engineer/Consultant", "Non-Conformance", "Deficiency", "Work to Complete", "Trade Damage", "Commissioning", "Commissioning - Commissioning"]);
    const companies = new Set(["ATI OF AMERICA", "BIG-D SIGNATURE - PC", "HELIX ELECTRIC OF UTAH LLC", "WALLBOARD SPECIALTIES", "IRON HORSE CONCRETE & CONSTRUCTION"]);
    const isDate = s => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s || "");
    const projectMatch = (document.body.innerText || "").match(/(\d+\s+-\s+WPR[^\n]+)/);

    const starts = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i] === "View" && /^\d+$/.test(lines[i + 1] || "") && types.has(lines[i + 2] || "")) starts.push(i);
    }

    return starts.map((start, idx) => {
      const end = starts[idx + 1] || lines.length;
      const seg = lines.slice(start, end);
      const row = { project: projectMatch?.[1] || "", number: seg[1], type: seg[2] };
      row.title = itemLinks[idx]?.text || "";
      row.itemUrl = itemLinks[idx]?.href || "";
      row.pdfUrl = pdfLinks[idx] || "";
      row.detailUrl = detailLinks[idx] || "";

      let cursor = 3;
      while (cursor < seg.length) {
        const candidate = seg.slice(3, cursor + 1).join(" ").replace(/\s+/g, " ");
        if (candidate === row.title) {
          cursor += 1;
          break;
        }
        if (isDate(seg[cursor])) break;
        cursor += 1;
      }
      if (cursor >= seg.length || !isDate(seg[cursor])) {
        const dateIdx = seg.findIndex((value, index) => index > 2 && isDate(value));
        cursor = dateIdx === -1 ? 3 : dateIdx;
      }

      const preDateLines = seg.slice(3, cursor).filter(value => value !== row.title);
      if (preDateLines.length && companies.has(preDateLines[preDateLines.length - 1])) {
        row.assigneeCompany = preDateLines.pop();
        row.assignee = preDateLines.join(" ");
      } else {
        row.assigneeCompany = "";
        row.assignee = preDateLines.join(" ");
      }

      row.dateNotified = seg[cursor++] || "";
      const createdByParts = [];
      while (cursor < seg.length && !isDate(seg[cursor])) createdByParts.push(seg[cursor++]);
      row.createdBy = createdByParts.join(" ");
      row.dateCreated = seg[cursor++] || "";
      row.dueDate = isDate(seg[cursor]) ? seg[cursor++] : "";

      const beforeStatus = [];
      while (cursor < seg.length && !statuses.has(seg[cursor])) beforeStatus.push(seg[cursor++]);
      row.specSection = beforeStatus.join(" ");
      row.status = statuses.has(seg[cursor]) ? seg[cursor++] : "";
      row.priority = priorities.has(seg[cursor]) ? seg[cursor++] : "";
      row.location = (seg[cursor] || "").startsWith("Building>") ? seg[cursor++] : "";
      row.description = seg.slice(cursor).join(" ");
      return row;
    });
  });
}

async function commandExtract(args) {
  const { context, page } = await launchBrowser(args);
  const url = args.url || env("PROCORE_OBSERVATIONS_URL");
  if (!url) throw new Error("Provide --url or set PROCORE_OBSERVATIONS_URL in procore-browser-sync/.env.");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const rows = await extractRowsFromPage(page);
  const filteredRows = rows.filter(row => {
    if (args["ati-only"] && row.assigneeCompany !== "ATI OF AMERICA") return false;
    if (args["open-only"] && row.status === "Closed") return false;
    return true;
  }).map(row => ({
    ...row,
    dateNotified: normalizeDate(row.dateNotified),
    dateCreated: normalizeDate(row.dateCreated),
    dueDate: normalizeDate(row.dueDate)
  }));

  const outDir = path.resolve(args["out-dir"] || path.join(__dirname, "output"));
  const files = writeReviewFiles(filteredRows, outDir);
  console.log(`Rows extracted: ${rows.length}`);
  console.log(`Rows written: ${filteredRows.length}`);
  console.log(`CSV review file: ${files.csvPath}`);
  console.log(`JSON review file: ${files.jsonPath}`);
  if (args.close) await context.close();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";
  if (command === "help" || command === "--help" || command === "-h") {
    console.log("Usage:");
    console.log("  node procore-browser-sync/procore_browser_sync.js env-check");
    console.log("  node procore-browser-sync/procore_browser_sync.js open-login");
    console.log("  node procore-browser-sync/procore_browser_sync.js login-check [--close]");
    console.log("  node procore-browser-sync/procore_browser_sync.js login-check-cdp");
    console.log("  node procore-browser-sync/procore_browser_sync.js extract --url <quality-observations-url> [--ati-only] [--open-only]");
    console.log("  node procore-browser-sync/procore_browser_sync.js extract-cdp --url <quality-observations-url> [--ati-only] [--open-only]");
    console.log("  node procore-browser-sync/procore_browser_sync.js extract-auto --url <quality-observations-url> [--ati-only] [--open-only]");
    console.log("  node procore-browser-sync/procore_browser_sync.js sync-auto [--complete-missing]");
    console.log("  node procore-browser-sync/procore_browser_sync.js inspect-auto --url <procore-url>");
    return;
  }
  if (command === "env-check") return commandEnvCheck(args);
  if (command === "open-login") return commandOpenLogin(args);
  if (command === "login-check") return commandLoginCheck(args);
  if (command === "login-check-cdp") return commandLoginCheckCdp(args);
  if (command === "extract") return commandExtract(args);
  if (command === "extract-cdp") return commandExtractCdp(args);
  if (command === "extract-auto") return commandExtractAuto(args);
  if (command === "sync-auto") return commandSyncAuto(args);
  if (command === "inspect-auto") return commandInspectAuto(args);
  throw new Error(`Unknown command: ${command}`);
}

main().catch(async error => {
  console.error(`Procore browser sync failed: ${error.message}`);
  const command = (process.argv.slice(2).find(value => !value.startsWith("--")) || "").trim();
  if (command === "sync-auto") {
    await reportProcoreSyncFailure(error).catch(reportError => {
      console.error(`Procore sync failure could not be reported: ${reportError.message}`);
    });
  }
  process.exitCode = 1;
});

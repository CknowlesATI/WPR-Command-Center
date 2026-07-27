#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PHASE_ORDER = ["prewire", "trim", "handover", "install"];
const PHASE_LABELS = {
  prewire: "Pre-Wire",
  trim: "Trim",
  handover: "WPR Handover",
  install: "Install"
};

const args = parseArgs(process.argv.slice(2));
const outputPath = path.resolve(args.output || "hosted-command-center/data/projects.json");
const apiUrl = args.url || process.env.COMMAND_CENTER_API_URL || "";
const inputPath = args.input ? path.resolve(args.input) : "";
const includeLinks = args.includeLinks === true;

if (!apiUrl && !inputPath) {
  exitWithUsage("Provide --url, COMMAND_CENTER_API_URL, or --input.");
}

const rawData = inputPath ? await readJsonFile(inputPath) : await readApiData(apiUrl);
const projects = Array.isArray(rawData) ? rawData : rawData.projects || rawData.data || [];
const hostedData = {
  lastUpdated: new Date().toISOString(),
  source: inputPath ? "local-export" : "command-center-api",
  projects: projects.map(project => toHostedProject(project, { includeLinks }))
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(hostedData, null, 2)}\n`, "utf8");
console.log(`Exported ${hostedData.projects.length} hosted projects to ${outputPath}`);

function toHostedProject(project, options) {
  const tasks = Array.isArray(project.taskList) ? project.taskList : [];
  const risks = Array.isArray(project.risks) ? project.risks : [];
  const timelines = Array.isArray(project.timelines) ? project.timelines : [];
  const openTasks = tasks.filter(task => task.status !== "done").length;
  const overdueTasks = tasks.filter(task => task.status !== "done" && isPast(task.dueDate)).length;
  const highPriorityTasks = tasks.filter(task => task.status !== "done" && task.priority === "high").length;
  const activePhase = currentPhase(timelines);
  const health = project.rag || computeHealth(project, tasks, risks, timelines);
  const attention = buildAttention(project, tasks, risks, timelines);

  return {
    id: slug(project.name),
    name: text(project.name, "Untitled project"),
    area: text(project.segment || project.projectGroup, "Unassigned"),
    team: text(project.externalTeam, "No team listed"),
    health,
    phase: activePhase,
    startDate: dateOnly(project.startsAt),
    endDate: dateOnly(project.endsAt),
    openTasks,
    overdueTasks,
    highPriorityTasks,
    risks: risks.length,
    nextHandoff: nextHandoffDate(timelines),
    attention,
    links: options.includeLinks ? buildLinks(tasks) : []
  };
}

function buildAttention(project, tasks, risks, timelines) {
  const items = [];

  tasks
    .filter(task => task.status !== "done" && (task.priority === "high" || isPast(task.dueDate)))
    .forEach(task => {
      items.push({
        severity: isPast(task.dueDate) ? "red" : "amber",
        label: isPast(task.dueDate) ? "Overdue task" : "High priority",
        detail: safeTaskTitle(task.name),
        dueDate: dateOnly(task.dueDate),
        source: sourceLabel(task.source)
      });
    });

  risks
    .filter(risk => risk.severity === "high" || isPast(risk.due))
    .forEach(risk => {
      items.push({
        severity: risk.severity === "high" || isPast(risk.due) ? "red" : "amber",
        label: risk.severity === "high" ? "High risk" : "Risk",
        detail: text(risk.title, "Risk needs review"),
        dueDate: dateOnly(risk.due),
        source: "Command Center"
      });
    });

  const nextHandoff = timelines.find(item => item.key === "handover" && item.start && !isComplete(item));
  if (nextHandoff && isWithinDays(nextHandoff.start, 21)) {
    items.push({
      severity: "amber",
      label: "Upcoming handoff",
      detail: `${text(project.name, "Project")} handoff is approaching`,
      dueDate: dateOnly(nextHandoff.start),
      source: "Command Center"
    });
  }

  return items
    .sort((a, b) => severityScore(b.severity) - severityScore(a.severity) || compareDates(a.dueDate, b.dueDate))
    .slice(0, 6);
}

function buildLinks(tasks) {
  const links = [];
  const bySource = new Map();
  tasks.forEach(task => {
    if (!task.externalUrl || !task.source || bySource.has(task.source)) return;
    bySource.set(task.source, task.externalUrl);
  });
  bySource.forEach((url, source) => links.push({ label: sourceLabel(source), url }));
  return links;
}

function currentPhase(timelines) {
  const open = PHASE_ORDER
    .map(key => timelines.find(item => item.key === key))
    .find(item => item && !isComplete(item));
  if (open) return PHASE_LABELS[open.key] || text(open.label, "Active phase");

  const lastDefined = [...PHASE_ORDER]
    .reverse()
    .map(key => timelines.find(item => item.key === key && item.end))
    .find(Boolean);
  return lastDefined ? PHASE_LABELS[lastDefined.key] || text(lastDefined.label, "Scheduled") : "Not scheduled";
}

function computeHealth(project, tasks, risks, timelines) {
  const activeTimelines = timelines.filter(item => !isComplete(item));
  if (!activeTimelines.some(item => item.start && item.end)) return "pending";
  if (risks.some(risk => risk.severity === "high" && isPast(risk.due))) return "red";
  if (tasks.some(task => task.status !== "done" && task.priority === "high" && isPast(task.dueDate))) return "red";
  const install = timelines.find(item => item.key === "install");
  if (install && !isComplete(install) && isPast(install.end) && tasks.some(task => task.status !== "done")) return "red";
  if (risks.some(risk => risk.severity === "medium" && isPast(risk.due))) return "amber";
  if (tasks.some(task => task.status !== "done" && task.priority === "high")) return "amber";
  return "green";
}

function nextHandoffDate(timelines) {
  const handoff = timelines.find(item => item.key === "handover" && item.start && !isComplete(item));
  return handoff ? dateOnly(handoff.start) : null;
}

function isComplete(item) {
  return item && item.status === "complete";
}

function isPast(value) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

function isWithinDays(value, days) {
  const date = parseDate(value);
  if (!date) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  return diff >= 0 && diff <= days;
}

function compareDates(a, b) {
  const aDate = parseDate(a);
  const bDate = parseDate(b);
  if (aDate && bDate) return aDate - bDate;
  if (aDate) return -1;
  if (bDate) return 1;
  return 0;
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(String(value).slice(0, 10) + "T00:00:00");
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateOnly(value) {
  if (!value) return null;
  const date = parseDate(value);
  if (!date) return null;
  return date.toISOString().slice(0, 10);
}

function safeTaskTitle(value) {
  return text(value, "Task needs review")
    .replace(/\s+/g, " ")
    .slice(0, 140);
}

function sourceLabel(source) {
  if (source === "pulse") return "Pulse";
  if (source === "procore" || source === "procore-review") return "Procore";
  return "Command Center";
}

function severityScore(severity) {
  if (severity === "red") return 3;
  if (severity === "amber") return 2;
  return 1;
}

function text(value, fallback) {
  const clean = String(value || "").trim();
  return clean || fallback;
}

function slug(value) {
  return text(value, "project")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

async function readJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function readApiData(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Command Center API returned ${response.status}`);
  return response.json();
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === "--include-links") {
      parsed.includeLinks = true;
    } else if (value.startsWith("--")) {
      const key = value.slice(2);
      parsed[key] = values[i + 1];
      i += 1;
    }
  }
  return parsed;
}

function exitWithUsage(message) {
  console.error(message);
  console.error("Usage: node hosted-command-center/tools/export-hosted-data.mjs --url <apps-script-url>");
  console.error("   or: node hosted-command-center/tools/export-hosted-data.mjs --input <command-center-json>");
  process.exit(1);
}

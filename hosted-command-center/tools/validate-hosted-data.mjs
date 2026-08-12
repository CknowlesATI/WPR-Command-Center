#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

const filePath = path.resolve(process.argv[2] || "hosted-command-center/data/projects.json");
const allowedProjectFields = new Set([
  "id",
  "name",
  "area",
  "team",
  "health",
  "phase",
  "startDate",
  "endDate",
  "openTasks",
  "overdueTasks",
  "highPriorityTasks",
  "risks",
  "nextHandoff",
  "approvalsPayments",
  "taskList",
  "timelines",
  "attention",
  "links"
]);
const allowedApprovalsPaymentsFields = new Set(["contract", "deposit", "changeOrders"]);
const allowedTaskFields = new Set(["name", "status", "source", "externalUrl"]);
const allowedAttentionFields = new Set(["severity", "label", "detail", "dueDate", "source"]);
const allowedLinkFields = new Set(["label", "url"]);
const allowedTimelineFields = new Set(["key", "label", "start", "end", "status"]);
const forbiddenFieldPattern = /(note|notes|externalId|externalProjectId|assignee|owner|credential|token|password|secret)/i;

const errors = [];
const data = JSON.parse(await readFile(filePath, "utf8"));

if (!data || typeof data !== "object") {
  errors.push("Data file must contain an object.");
} else {
  if (!data.lastUpdated) errors.push("Missing lastUpdated.");
  if (!Array.isArray(data.projects)) errors.push("projects must be an array.");
}

(data.projects || []).forEach((project, index) => {
  const prefix = `projects[${index}]`;
  requireText(project.name, `${prefix}.name`);
  requireText(project.id, `${prefix}.id`);
  requireHostedId(project.id, `${prefix}.id`);
  requireEnum(project.health, ["green", "amber", "red", "pending"], `${prefix}.health`);
  requireNumber(project.openTasks, `${prefix}.openTasks`);
  requireNumber(project.overdueTasks, `${prefix}.overdueTasks`);
  requireNumber(project.highPriorityTasks, `${prefix}.highPriorityTasks`);
  requireNumber(project.risks, `${prefix}.risks`);
  checkAllowedFields(project, allowedProjectFields, prefix);

  if (project.approvalsPayments !== undefined) {
    if (!project.approvalsPayments || typeof project.approvalsPayments !== "object" || Array.isArray(project.approvalsPayments)) {
      errors.push(`${prefix}.approvalsPayments must be an object.`);
    } else {
      checkAllowedFields(project.approvalsPayments, allowedApprovalsPaymentsFields, `${prefix}.approvalsPayments`);
    }
  }

  if (project.taskList !== undefined) {
    if (!Array.isArray(project.taskList)) errors.push(`${prefix}.taskList must be an array.`);
    (project.taskList || []).forEach((task, taskIndex) => {
      const taskPrefix = `${prefix}.taskList[${taskIndex}]`;
      requireText(task.name, `${taskPrefix}.name`);
      requireEnum(task.status, ["todo", "progress", "done"], `${taskPrefix}.status`);
      checkAllowedFields(task, allowedTaskFields, taskPrefix);
      if (task.externalUrl) requireSafeUrl(task.externalUrl, `${taskPrefix}.externalUrl`);
    });
  }

  if (!Array.isArray(project.timelines)) errors.push(`${prefix}.timelines must be an array.`);
  (project.timelines || []).forEach((item, itemIndex) => {
    const itemPrefix = `${prefix}.timelines[${itemIndex}]`;
    requireEnum(item.key, ["prewire", "trim", "handover", "install"], `${itemPrefix}.key`);
    requireText(item.label, `${itemPrefix}.label`);
    if (item.status) requireEnum(item.status, ["active", "complete"], `${itemPrefix}.status`);
    checkAllowedFields(item, allowedTimelineFields, itemPrefix);
  });

  if (!Array.isArray(project.attention)) errors.push(`${prefix}.attention must be an array.`);
  (project.attention || []).forEach((item, itemIndex) => {
    const itemPrefix = `${prefix}.attention[${itemIndex}]`;
    requireEnum(item.severity, ["green", "amber", "red"], `${itemPrefix}.severity`);
    requireText(item.label, `${itemPrefix}.label`);
    requireText(item.detail, `${itemPrefix}.detail`);
    checkAllowedFields(item, allowedAttentionFields, itemPrefix);
  });

  if (!Array.isArray(project.links)) errors.push(`${prefix}.links must be an array.`);
  (project.links || []).forEach((link, linkIndex) => {
    const linkPrefix = `${prefix}.links[${linkIndex}]`;
    requireText(link.label, `${linkPrefix}.label`);
    requireSafeUrl(link.url, `${linkPrefix}.url`);
    checkAllowedFields(link, allowedLinkFields, linkPrefix);
  });
});

if (errors.length) {
  console.error(`Hosted data validation failed for ${filePath}:`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Hosted data validation passed for ${filePath}`);

function checkAllowedFields(value, allowed, prefix) {
  Object.keys(value || {}).forEach(key => {
    if (!allowed.has(key)) errors.push(`${prefix}.${key} is not part of the hosted data contract.`);
    if (forbiddenFieldPattern.test(key)) errors.push(`${prefix}.${key} looks sensitive and should not be exported.`);
  });
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a non-empty string.`);
}

function requireHostedId(value, label) {
  if (typeof value !== "string") return;
  if (/^\d+$/.test(value.trim())) errors.push(`${label} must be a hosted slug, not a raw numeric internal ID.`);
}

function requireNumber(value, label) {
  if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${label} must be a number.`);
}

function requireEnum(value, allowed, label) {
  if (!allowed.includes(value)) errors.push(`${label} must be one of: ${allowed.join(", ")}.`);
}

function requireSafeUrl(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} must be a non-empty string.`);
    return;
  }
  try {
    const parsed = new URL(value);
    if (!["https:", "http:"].includes(parsed.protocol)) errors.push(`${label} must use http or https.`);
  } catch {
    errors.push(`${label} must be a valid URL.`);
  }
}

#!/usr/bin/env node

const states = ["Action Needed", "Follow-Up Needed", "Monitor", "Stable"];

const cases = [
  {
    name: "Monitor without review date or trigger is incomplete",
    control: { operatingState: "Monitor", nextOutcome: "Inspection date confirmed", nextMoveOwner: "Big-D" },
    includes: "Monitor needs a review date or event trigger"
  },
  {
    name: "Vague next outcome is incomplete",
    control: { operatingState: "Action Needed", nextOutcome: "Follow up", nextMoveOwner: "Christen" },
    includes: "Next outcome must name"
  },
  {
    name: "Blocked needs a blocker reason",
    control: { operatingState: "Follow-Up Needed", nextOutcome: "Access decision received", nextMoveOwner: "Big-D", blocked: true },
    includes: "Blocked needs a blocker reason"
  },
  {
    name: "Controlled monitor passes with a review date",
    control: { operatingState: "Monitor", nextOutcome: "Submittal approval returned", nextMoveOwner: "Architect", reviewDate: "2026-08-07" },
    valid: true
  },
  {
    name: "Daily direction is capped at three outcomes",
    daily: true
  }
];

let failures = 0;

for (const testCase of cases) {
  if (testCase.daily) {
    const recommendations = dailyRecommendations([
      project(1, "Field", "Action Needed", "Access date confirmed", "Big-D", "field access", "2026-08-01"),
      project(2, "Money", "Follow-Up Needed", "Approval returned", "Client", "approval payment", "2026-08-02"),
      project(3, "Quiet", "Monitor", "Schedule reply received", "Vendor", "quiet", "2026-07-01"),
      project(4, "Extra", "Action Needed", "Install date confirmed", "Christen", "field", "2026-08-03")
    ]);
    assert(testCase.name, recommendations.length <= 3);
    continue;
  }

  const errors = validateControl(testCase.control);
  if (testCase.valid) assert(testCase.name, errors.length === 0, errors.join("; "));
  else assert(testCase.name, errors.some(error => error.includes(testCase.includes)), errors.join("; "));
}

if (failures) {
  console.error(`Phase 3 control rule validation failed: ${failures} issue${failures === 1 ? "" : "s"}.`);
  process.exit(1);
}

console.log("Phase 3 control rule validation passed.");

function validateControl(control) {
  const state = states.includes(control.operatingState) ? control.operatingState : "Stable";
  const errors = [];
  const nextOutcome = String(control.nextOutcome || "").trim();
  const owner = String(control.nextMoveOwner || "").trim();
  if (state !== "Stable" && !nextOutcome) errors.push(`${state} needs a next outcome.`);
  if (state !== "Stable" && !owner) errors.push(`${state} needs an owner of the next move.`);
  if (state === "Monitor" && !control.reviewDate && !control.eventTrigger) errors.push("Monitor needs a review date or event trigger.");
  if (nextOutcome && isVagueOutcome(nextOutcome)) errors.push("Next outcome must name the answer, approval, decision, date, or changed condition being sought.");
  if (control.blocked && !String(control.blockerReason || "").trim()) errors.push("Blocked needs a blocker reason.");
  return errors;
}

function isVagueOutcome(value) {
  return /^(follow up|check status|review email|touch base|circle back|send email|call|email|review)$/i.test(String(value || "").trim());
}

function project(id, name, operatingState, nextOutcome, nextMoveOwner, delayConsequence, lastMovementDate) {
  return {
    id,
    name,
    rag: operatingState === "Action Needed" ? "red" : "amber",
    control: { operatingState, nextOutcome, nextMoveOwner, delayConsequence, lastMovementDate }
  };
}

function dailyRecommendations(projects) {
  const picked = [];
  const categories = [
    p => /(field|schedule|access|install|turnover|handoff|rework)/i.test(controlText(p)) || p.rag === "red",
    p => /(approval|approve|contract|procure|payment|invoice|lead.?time|financial|cost|change order)/i.test(controlText(p)),
    () => true
  ];
  for (const match of categories) {
    const candidate = projects
      .filter(p => !picked.some(item => item.id === p.id))
      .filter(match)
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))[0];
    if (candidate) picked.push(candidate);
  }
  return picked.slice(0, 3);
}

function controlText(p) {
  const c = p.control || {};
  return [c.nextOutcome, c.delayConsequence, c.nextAction, c.blockerReason].join(" ");
}

function score(p) {
  const c = p.control || {};
  let value = 0;
  if (c.operatingState === "Action Needed") value += 75;
  if (c.operatingState === "Follow-Up Needed") value += 65;
  if (c.operatingState === "Monitor") value += 15;
  if (p.rag === "red") value += 45;
  if (c.lastMovementDate && c.lastMovementDate < "2026-07-15") value += 25;
  return value;
}

function assert(name, condition, detail = "") {
  if (condition) return;
  failures += 1;
  console.error(`- ${name}${detail ? `: ${detail}` : ""}`);
}

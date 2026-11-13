const SHEET_ID = "1NQklo5qpcQ0nUpGWOEQC_S1F5e3eUGQgN_U7nfwIIZs";

// Google CSV exports quote embedded commas, quotes, and newlines.
export function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field.replace(/\r$/, "")); field = "";
      if (c === '\n') { rows.push(row); row = []; }
    } else field += c;
  }
  if (quoted) throw new Error("Incomplete schedule export");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

export function scheduleRows(values) {
  const headers = values[0]?.map(v => String(v).trim());
  if (!["Unit", "Unit Type", "Phase", "Start Date", "End Date"].every((v, i) => headers?.[i] === v)) throw new Error("Schedule column headings changed");
  const rows = [];
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  for (const row of values.slice(1)) {
    const unit = String(row[0] || "").trim();
    if (unit === "PROJECT NOTES") break;
    if (!unit) continue;
    const phase = /^Phase ([12])$/.exec(String(row[2] || "").trim());
    const start = String(row[3] || "").trim(), end = String(row[4] || "").trim();
    if (!/^(TH\d+|C\d+|SS|PH)$/.test(unit) || !phase || !validDate(start) || !validDate(end) || start > end) throw new Error("Invalid installation row for " + unit);
    rows.push({unit, phase: Number(phase[1]), start, end, notes: String(row[6] || "")});
  }
  if (!rows.length) throw new Error("Source schedule has no installation rows");
  return rows.sort((a, b) => a.start.localeCompare(b.start) || a.unit.localeCompare(b.unit, undefined, {numeric: true}));
}

export async function getInstallationSchedule() {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=Source%20Data`;
  const response = await fetch(url, {redirect: "follow", signal: AbortSignal.timeout(15000), headers: {"accept": "text/csv"}});
  if (!response.ok) throw new Error("Google Sheet is unavailable. Enable read access for the Command Center.");
  const text = await response.text();
  if (/^\s*</.test(text)) throw new Error("Google Sheet requires sign-in. Enable read access for the Command Center.");
  const values = parseCsv(text);
  const notesStart = values.findIndex(row => row[0]?.trim() === "PROJECT NOTES");
  const notes = notesStart < 0 ? [] : values.slice(notesStart + 1).map(row => row[0]?.trim()).filter(Boolean);
  return {ok: true, rows: scheduleRows(values), notes, syncedAt: new Date().toISOString()};
}

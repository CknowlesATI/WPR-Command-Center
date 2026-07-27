#!/usr/bin/env python
import argparse
import csv
import json
import re
from datetime import datetime
from pathlib import Path

import pdfplumber


FIELDNAMES = [
    "source",
    "sourceFile",
    "project",
    "jobNumber",
    "observationNumber",
    "title",
    "type",
    "status",
    "priority",
    "dateNotified",
    "dueDate",
    "assignee",
    "createdBy",
    "location",
    "specSection",
    "drawing",
    "description",
]


def compact(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def normalize_date(value):
    text = compact(value)
    if not text:
        return ""
    for fmt in ("%m/%d/%y", "%m/%d/%Y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return text


def read_pdf_text(pdf_path):
    pages = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or "")
    return "\n".join(pages)


def remove_report_noise(text):
    cleaned = []
    skip_patterns = [
        r"^Printed on ",
        r"^Page \d+ of \d+$",
        r"^BIG-D SIGNATURE, LLC$",
        r"^1389 CENTER DRIVE",
        r"^PARK CITY, Utah",
        r"^United States$",
        r"^\(435\) ",
    ]
    for line in text.splitlines():
        stripped = line.strip()
        if any(re.search(pattern, stripped) for pattern in skip_patterns):
            continue
        cleaned.append(stripped)
    return "\n".join(cleaned)


def project_meta(text):
    project = ""
    job_number = ""

    match = re.search(r"Observations For\s+(.+)", text)
    if match:
        project = compact(match.group(1))
        job_match = re.match(r"(\d+)\s*-\s*(.+)", project)
        if job_match:
            job_number = job_match.group(1)
            project = f"{job_number} - {compact(job_match.group(2))}"

    if not job_number:
        match = re.search(r"Job #:\s*(\d+)\s*(.+)", text)
        if match:
            job_number = match.group(1)
            if not project:
                project = f"{job_number} - {compact(match.group(2))}"

    return project, job_number


def split_observation_blocks(text):
    parts = re.split(r"(?m)^#(\d+):\s*", text)
    blocks = []
    for index in range(1, len(parts), 2):
        number = parts[index]
        body = parts[index + 1].strip()
        if body:
            blocks.append((number, body))
    return blocks


def section_between(block, start_label, end_label):
    pattern = re.compile(
        rf"{re.escape(start_label)}\s*(.*?)\s*{re.escape(end_label)}",
        re.S,
    )
    match = pattern.search(block)
    return match.group(1) if match else ""


def value_after_label(block, label):
    match = re.search(rf"{re.escape(label)}\s*\n([^\n]+)", block)
    return compact(match.group(1)) if match else ""


def extract_title(block):
    for line in block.splitlines():
        text = compact(line)
        if text:
            return text
    return ""


def extract_status(block):
    return value_after_label(block, "Status:")


def extract_notified_priority(block):
    match = re.search(
        r"Date Notified:\s*Priority:\s*\n(?:(\d{2}/\d{2}/\d{2,4})\s*)?([A-Za-z]+)?",
        block,
    )
    if not match:
        return "", ""
    return normalize_date(match.group(1) or ""), compact(match.group(2) or "")


def extract_due_date(block):
    match = re.search(r"Due Date:\s*Spec Section:\s*\n(\d{2}/\d{2}/\d{2,4})", block)
    if match:
        return normalize_date(match.group(1))
    match = re.search(r"Due Date:\s*\n(\d{2}/\d{2}/\d{2,4})", block)
    return normalize_date(match.group(1)) if match else ""


def extract_type_and_location(block):
    chunk = section_between(block, "Type: Location:", "Status:")
    joined = compact(chunk)
    obs_type = ""
    if "Quality > QC Field" in joined and "Observation" in joined:
        obs_type = "Quality > QC Field Observation"
    elif "Quality > Architect/Engineer/" in joined and "Consultant" in joined:
        obs_type = "Quality > Architect/Engineer/Consultant"
    elif "Quality > Non-Conformance" in joined:
        obs_type = "Quality > Non-Conformance"
    elif "Quality > Deficiency" in joined:
        obs_type = "Quality > Deficiency"
    elif "Work to Complete > Work to" in joined and "Complete" in joined:
        obs_type = "Work to Complete > Work to Complete"

    location = ""
    loc_match = re.search(r"(Building>.+)", joined)
    if loc_match:
        location = loc_match.group(1)
        if obs_type:
            location = compact(location.replace(obs_type, ""))
        location = re.split(r"\bStatus:\b", location)[0]

    return obs_type, compact(location)


def extract_spec_section(block):
    match = re.search(
        r"Due Date:\s*Spec Section:\s*\n(?:\d{2}/\d{2}/\d{2,4})?\s*\n?(.+?)(?:\nAssignee:|\nDrawing|\nCreated By:)",
        block,
        re.S,
    )
    if not match:
        return ""
    text = compact(match.group(1))
    if re.search(r"^\d{6}\s*-", text) or text in {"014000 - Quality Requirements"}:
        return text
    return ""


def extract_drawing(block):
    drawings = re.findall(r"Drawing\s+([A-Z0-9]+:\s*[^\n]+)", block)
    return "; ".join(compact(drawing) for drawing in drawings)


def extract_assignee(block):
    chunk = section_between(block, "Assignee: Description:", "Created By:")
    chunk = re.sub(r"Drawing\s+[A-Z0-9]+:\s*[^\n]+", " ", chunk)
    joined = compact(chunk)

    ati_match = re.search(r"([A-Za-z][A-Za-z .'\-]+?)\s*\(ATI OF\b.*?\bAMERICA\)", joined)
    if ati_match:
        return f"{compact(ati_match.group(1))} (ATI OF AMERICA)"

    bigd_match = re.search(r"([A-Za-z][A-Za-z .'\-]+?)\s*\(BIG-D\b.*?\bPC\)", joined)
    if bigd_match:
        return f"{compact(bigd_match.group(1))} (BIG-D SIGNATURE - PC)"

    wallboard_match = re.search(r"([A-Za-z][A-Za-z .'\-]+?)\s*\(WALLBOARD\b.*?\bSPECIALTIES\)", joined)
    if wallboard_match:
        return f"{compact(wallboard_match.group(1))} (WALLBOARD SPECIALTIES)"

    concrete_match = re.search(r"([A-Za-z][A-Za-z .'\-]+?)\s*\(IRON HORSE\b.*?\bCONSTRUCTION\s*\)", joined)
    if concrete_match:
        return f"{compact(concrete_match.group(1))} (IRON HORSE CONCRETE & CONSTRUCTION)"

    helix_match = re.search(r"([A-Za-z][A-Za-z .'\-]+?)\s*\(HELIX\b.*?\bLLC\)", joined)
    if helix_match:
        return f"{compact(helix_match.group(1))} (HELIX ELECTRIC OF UTAH LLC)"

    match = re.search(r"([A-Za-z][A-Za-z .'\-]+?\s*\([^)]+?\))", joined)
    return compact(match.group(1)) if match else ""


def extract_created_by(block):
    created_idx = block.find("Created By:")
    if created_idx == -1:
        return ""
    tail = block[created_idx + len("Created By:") :]
    candidates = []
    for line in tail.splitlines():
        line = compact(line)
        if not line:
            continue
        if re.match(r"^#\d+:", line):
            break
        if line.startswith(("Type:", "Status:", "Date Notified:", "Due Date:", "Assignee:")):
            break
        if len(line) <= 60 and re.search(r"[A-Za-z]", line):
            candidates.append(line)
    return candidates[-1] if candidates else ""


def extract_description(block, assignee):
    chunk = section_between(block, "Assignee: Description:", "Created By:")
    lines = []
    for raw in chunk.splitlines():
        line = compact(raw)
        if not line:
            continue
        if line.startswith("Drawing "):
            continue
        if assignee and line in assignee:
            continue
        if "(" in line and ")" in line and len(line) < 90:
            continue
        lines.append(line)
    text = compact(" ".join(lines))
    if assignee:
        text = compact(text.replace(assignee, ""))
    return text


def parse_observation(number, block, source_file, project, job_number):
    date_notified, priority = extract_notified_priority(block)
    obs_type, location = extract_type_and_location(block)
    assignee = extract_assignee(block)
    return {
        "source": "procore-pdf",
        "sourceFile": source_file,
        "project": project,
        "jobNumber": job_number,
        "observationNumber": number,
        "title": extract_title(block),
        "type": obs_type,
        "status": extract_status(block),
        "priority": priority,
        "dateNotified": date_notified,
        "dueDate": extract_due_date(block),
        "assignee": assignee,
        "createdBy": extract_created_by(block),
        "location": location,
        "specSection": extract_spec_section(block),
        "drawing": extract_drawing(block),
        "description": extract_description(block, assignee),
    }


def parse_pdf(pdf_path):
    raw_text = read_pdf_text(pdf_path)
    text = remove_report_noise(raw_text)
    project, job_number = project_meta(raw_text)
    return [
        parse_observation(number, block, pdf_path.name, project, job_number)
        for number, block in split_observation_blocks(text)
    ]


def write_outputs(rows, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = out_dir / "procore-observations-review.csv"
    json_path = out_dir / "procore-observations-review.json"

    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(rows)

    json_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")
    return csv_path, json_path


def print_summary(rows, csv_path, json_path):
    open_rows = [row for row in rows if row["status"].lower() != "closed"]
    ati_rows = [row for row in rows if "ATI OF AMERICA" in row["assignee"].upper()]
    quality_rows = [row for row in rows if row["type"].startswith("Quality")]

    print(f"Observations parsed: {len(rows)}")
    print(f"Quality observations: {len(quality_rows)}")
    print(f"Open observations: {len(open_rows)}")
    print(f"ATI-assigned observations: {len(ati_rows)}")
    print(f"CSV review file: {csv_path}")
    print(f"JSON review file: {json_path}")

    if open_rows:
        print("")
        print("Open observations:")
        for row in open_rows[:20]:
            assignee = row["assignee"] or "unassigned"
            print(f"- #{row['observationNumber']} {row['status']} {row['dueDate']} - {assignee} - {row['title']}")
        if len(open_rows) > 20:
            print(f"...and {len(open_rows) - 20} more")


def main():
    parser = argparse.ArgumentParser(description="Parse Procore observation PDF exports into review CSV/JSON files.")
    parser.add_argument("pdfs", nargs="+", type=Path, help="One or more Procore observation PDF files.")
    parser.add_argument("--out-dir", default="procore-pdf-sync/output", type=Path, help="Output directory.")
    parser.add_argument("--ati-only", action="store_true", help="Keep only ATI OF AMERICA assignee rows.")
    parser.add_argument("--open-only", action="store_true", help="Keep only non-closed rows.")
    args = parser.parse_args()

    rows = []
    for pdf_path in args.pdfs:
        if not pdf_path.exists():
            raise SystemExit(f"PDF not found: {pdf_path}")
        rows.extend(parse_pdf(pdf_path))

    if args.ati_only:
        rows = [row for row in rows if "ATI OF AMERICA" in row["assignee"].upper()]
    if args.open_only:
        rows = [row for row in rows if row["status"].lower() != "closed"]

    csv_path, json_path = write_outputs(rows, args.out_dir)
    print_summary(rows, csv_path, json_path)


if __name__ == "__main__":
    main()

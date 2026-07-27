#!/usr/bin/env python
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOCAL_ENV_PATH = Path(__file__).resolve().parent / ".env"
ROOT_ENV_PATH = ROOT / ".env"


def load_env_file(path):
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file(ROOT_ENV_PATH)
load_env_file(LOCAL_ENV_PATH)


def env(name, default=""):
    return os.environ.get(name, default)


def api_base_url():
    return env("PROCORE_API_BASE_URL", "https://api.procore.com").rstrip("/")


def login_base_url():
    return env("PROCORE_LOGIN_BASE_URL", "https://login.procore.com").rstrip("/")


def require(value, name):
    if not value:
        raise SystemExit(f"Missing {name}. Add it to procore-api-sync/.env or the environment.")
    return value


def request_json(method, url, token=None, headers=None, body=None):
    req_headers = {"Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if token:
        req_headers["Authorization"] = f"Bearer {token}"

    data = None
    if body is not None:
        if isinstance(body, dict):
            data = urllib.parse.urlencode(body).encode("utf-8")
            req_headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            data = body

    request = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            text = response.read().decode("utf-8")
            return json.loads(text) if text else None
    except urllib.error.HTTPError as error:
        text = error.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = text[:1000]
        raise RuntimeError(json.dumps({
            "status": error.code,
            "reason": error.reason,
            "url": url,
            "response": parsed,
        }, indent=2))


def get_access_token():
    direct_token = env("PROCORE_ACCESS_TOKEN")
    if direct_token:
        return direct_token

    client_id = require(env("PROCORE_CLIENT_ID"), "PROCORE_CLIENT_ID")
    client_secret = require(env("PROCORE_CLIENT_SECRET"), "PROCORE_CLIENT_SECRET")
    token_url = f"{login_base_url()}/oauth/token"
    payload = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    response = request_json("POST", token_url, body=payload)
    token = response.get("access_token") if isinstance(response, dict) else ""
    if not token:
        raise RuntimeError("Procore token response did not include access_token.")
    return token


def procore_get(path, token, params=None, company_id=None):
    query = f"?{urllib.parse.urlencode(params or {})}" if params else ""
    headers = {}
    if company_id:
        headers["Procore-Company-Id"] = str(company_id)
    return request_json("GET", f"{api_base_url()}{path}{query}", token=token, headers=headers)


def rows_from(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("data", "results", "rows", "projects", "companies", "items"):
            if isinstance(value.get(key), list):
                return value[key]
    return []


def write_json(data, output_path):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")


def command_env_check(_args):
    values = {
        "PROCORE_ACCESS_TOKEN": "set" if env("PROCORE_ACCESS_TOKEN") else "missing",
        "PROCORE_CLIENT_ID": "set" if env("PROCORE_CLIENT_ID") else "missing",
        "PROCORE_CLIENT_SECRET": "set" if env("PROCORE_CLIENT_SECRET") else "missing",
        "PROCORE_COMPANY_ID": env("PROCORE_COMPANY_ID") or "missing",
        "PROCORE_API_BASE_URL": api_base_url(),
        "PROCORE_LOGIN_BASE_URL": login_base_url(),
    }
    print(json.dumps(values, indent=2))
    if values["PROCORE_ACCESS_TOKEN"] == "missing" and (
        values["PROCORE_CLIENT_ID"] == "missing" or values["PROCORE_CLIENT_SECRET"] == "missing"
    ):
        raise SystemExit(
            "Path 1 is not testable yet: provide PROCORE_ACCESS_TOKEN, or PROCORE_CLIENT_ID plus PROCORE_CLIENT_SECRET."
        )


def command_auth_test(args):
    token = get_access_token()
    print("Procore API token acquired.")
    try:
        me = procore_get("/rest/v1.0/me", token)
        print("Current API identity:")
        print(json.dumps(me, indent=2)[:2000])
    except Exception as error:
        if args.allow_me_failure:
            print(f"Token worked, but /me probe failed: {error}")
            return
        raise


def command_companies(args):
    token = get_access_token()
    companies = procore_get("/rest/v1.0/companies", token)
    write_json(companies, Path(args.out))
    rows = rows_from(companies)
    print(f"Companies visible: {len(rows)}")
    for company in rows[:25]:
        print(f"- {company.get('id', '')}: {company.get('name', company.get('company_name', ''))}")


def command_projects(args):
    token = get_access_token()
    company_id = args.company_id or env("PROCORE_COMPANY_ID")
    require(company_id, "PROCORE_COMPANY_ID")
    projects = procore_get(
        "/rest/v1.1/projects",
        token,
        params={"company_id": company_id},
        company_id=company_id,
    )
    write_json(projects, Path(args.out))
    rows = rows_from(projects)
    print(f"Projects visible: {len(rows)}")
    for project in rows[:50]:
        print(f"- {project.get('id', '')}: {project.get('name', project.get('display_name', ''))}")


def command_observations(args):
    token = get_access_token()
    company_id = args.company_id or env("PROCORE_COMPANY_ID")
    require(company_id, "PROCORE_COMPANY_ID")
    require(args.project_id, "project_id")
    params = {
        "project_id": args.project_id,
        "page": args.page,
        "per_page": args.per_page,
    }
    observations = procore_get(
        "/rest/v1.0/observations/items",
        token,
        params=params,
        company_id=company_id,
    )
    write_json(observations, Path(args.out))
    rows = rows_from(observations)
    print(f"Observation items returned: {len(rows)}")
    for item in rows[:25]:
        number = item.get("number") or item.get("formatted_number") or item.get("id", "")
        title = item.get("name") or item.get("title") or item.get("description", "")
        status = item.get("status") or item.get("status_name") or ""
        print(f"- {number} {status}: {str(title)[:120]}")


def command_observation_pdf(args):
    token = get_access_token()
    company_id = args.company_id or env("PROCORE_COMPANY_ID")
    require(company_id, "PROCORE_COMPANY_ID")
    require(args.project_id, "project_id")
    require(args.observation_id, "observation_id")
    result = procore_get(
        f"/rest/v1.0/observations/items/{args.observation_id}/pdf",
        token,
        params={"project_id": args.project_id},
        company_id=company_id,
    )
    write_json(result, Path(args.out))
    print(json.dumps(result, indent=2))


def build_parser():
    parser = argparse.ArgumentParser(description="Probe Procore API access for Command Center observation imports.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    env_check = subparsers.add_parser("env-check", help="Check whether API credentials are available.")
    env_check.set_defaults(func=command_env_check)

    auth_test = subparsers.add_parser("auth-test", help="Acquire a token and call /me.")
    auth_test.add_argument("--allow-me-failure", action="store_true")
    auth_test.set_defaults(func=command_auth_test)

    companies = subparsers.add_parser("companies", help="List companies visible to the API identity.")
    companies.add_argument("--out", default="procore-api-sync/output/companies.json")
    companies.set_defaults(func=command_companies)

    projects = subparsers.add_parser("projects", help="List projects for a Procore company.")
    projects.add_argument("--company-id", default="")
    projects.add_argument("--out", default="procore-api-sync/output/projects.json")
    projects.set_defaults(func=command_projects)

    observations = subparsers.add_parser("observations", help="List observation items for one project.")
    observations.add_argument("--company-id", default="")
    observations.add_argument("--project-id", required=True)
    observations.add_argument("--page", default=1, type=int)
    observations.add_argument("--per-page", default=100, type=int)
    observations.add_argument("--out", default="procore-api-sync/output/observations.json")
    observations.set_defaults(func=command_observations)

    pdf = subparsers.add_parser("observation-pdf", help="Get the API-provided PDF URL for one observation item.")
    pdf.add_argument("--company-id", default="")
    pdf.add_argument("--project-id", required=True)
    pdf.add_argument("--observation-id", required=True)
    pdf.add_argument("--out", default="procore-api-sync/output/observation-pdf.json")
    pdf.set_defaults(func=command_observation_pdf)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
    except Exception as error:
        print(f"Procore API test failed: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

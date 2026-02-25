#!/usr/bin/env python3
"""
Import Top 100 Denver restaurants from an .xlsx file into Supabase restaurants.

Usage:
  python3 import_denver_restaurants.py \
    --xlsx "/Users/you/Downloads/Top_100_Denver_Restaurants.xlsx" \
    --profile-id 0001 \
    --status active

Required env vars:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY

Notes:
  - profile_id is required by schema and must exist in public.profiles.
  - shorthand numeric profile ids (e.g. 0001) are converted to UUID:
    00000000-0000-0000-0000-000000000001
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def to_uuid_profile_id(raw: str) -> str:
    token = raw.strip()
    if UUID_RE.match(token):
        return token.lower()
    if token.isdigit():
        tail = int(token)
        return f"00000000-0000-0000-0000-{tail:012d}"
    raise ValueError(
        f"profile_id '{raw}' is not a UUID or numeric shorthand (e.g. 0001)."
    )


def col_to_idx(col: str) -> int:
    idx = 0
    for ch in col:
        idx = idx * 26 + (ord(ch) - 64)
    return idx


def normalize_tag(s: str) -> str:
    cleaned = re.sub(r"[^a-z0-9\\-\\s]", " ", s.lower())
    cleaned = re.sub(r"\\s+", " ", cleaned).strip()
    return cleaned


def split_tags(vibes: str, cuisine: str) -> list[str]:
    out: list[str] = []

    def add_token(token: str) -> None:
        t = normalize_tag(token)
        if t and t not in out:
            out.append(t)

    for chunk in vibes.split(","):
        add_token(chunk)

    # Include coarse cuisine signals for recommendation matching
    # e.g. "Italian (Northern)" => ["italian", "northern"]
    for part in re.split(r"[()/,]", cuisine):
        add_token(part)

    return out


def parse_price_level(price: str) -> int | None:
    count = price.count("$")
    if 1 <= count <= 4:
        return count
    return None


def parse_google_rating(cell: str) -> float | None:
    m = re.search(r"([0-5](?:\\.\\d)?)\\s*$", cell)
    return float(m.group(1)) if m else None


def parse_xlsx_rows(xlsx_path: Path) -> list[dict[str, Any]]:
    with ZipFile(xlsx_path) as zf:
        wb = ET.fromstring(zf.read("xl/workbook.xml"))
        rels = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        rel_map = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels}

        sheet = wb.find("a:sheets/a:sheet", NS)
        if sheet is None:
            return []
        rid = sheet.attrib[
            "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
        ]
        target = rel_map[rid].lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        sheet_xml = ET.fromstring(zf.read(target))

        def cell_text(c: ET.Element) -> str:
            if c.attrib.get("t") == "inlineStr":
                return "".join((x.text or "") for x in c.findall(".//a:t", NS)).strip()
            v = c.find("a:v", NS)
            return (v.text or "").strip() if v is not None else ""

        rows: list[dict[str, Any]] = []
        for r in sheet_xml.findall("a:sheetData/a:row", NS):
            row_num = int(r.attrib.get("r", "0"))
            if row_num < 4:  # title + source + header rows
                continue

            vals: dict[int, str] = {}
            for c in r.findall("a:c", NS):
                ref = c.attrib.get("r", "")
                m = re.match(r"([A-Z]+)", ref)
                if not m:
                    continue
                vals[col_to_idx(m.group(1))] = cell_text(c)

            name = vals.get(2, "").strip()
            if not name:
                continue

            price = vals.get(3, "").strip()
            neighborhood = vals.get(4, "").strip()
            google = vals.get(5, "").strip()
            cuisine = vals.get(6, "").strip()
            vibes = vals.get(7, "").strip()
            sources = vals.get(8, "").strip()

            rows.append(
                {
                    "name": name,
                    "neighborhood": neighborhood or None,
                    "price_level": parse_price_level(price),
                    "vibe_tags": split_tags(vibes, cuisine),
                    "notes": " | ".join(
                        part
                        for part in [
                            f"Cuisine: {cuisine}" if cuisine else "",
                            f"Google rating: {parse_google_rating(google)}"
                            if parse_google_rating(google) is not None
                            else "",
                            f"Sources: {sources}" if sources else "",
                        ]
                        if part
                    )
                    or None,
                }
            )
        return rows


def supabase_request(
    method: str, url: str, key: str, body: list[dict[str, Any]] | None = None
) -> tuple[int, str]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def check_profile_exists(base_url: str, key: str, profile_id: str) -> bool:
    pid = urllib.parse.quote(profile_id, safe="")
    url = f"{base_url}/rest/v1/profiles?id=eq.{pid}&select=id&limit=1"
    status, text = supabase_request("GET", url, key)
    if status >= 300:
        print(f"profile check failed ({status}): {text}")
        return False
    try:
        rows = json.loads(text or "[]")
        return isinstance(rows, list) and len(rows) > 0
    except json.JSONDecodeError:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--xlsx",
        default="/Users/ccruickshank/Downloads/Top_100_Denver_Restaurants.xlsx",
        help="Path to source .xlsx file",
    )
    parser.add_argument("--profile-id", default="0001")
    parser.add_argument("--status", choices=["active", "backlog"], default="active")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    xlsx_path = Path(args.xlsx)
    if not xlsx_path.exists():
        print(f"File not found: {xlsx_path}")
        return 1

    profile_id = to_uuid_profile_id(args.profile_id)
    rows = parse_xlsx_rows(xlsx_path)
    if not rows:
        print("No rows parsed from workbook.")
        return 1

    payload = [
        {
            "profile_id": profile_id,
            "name": row["name"],
            "neighborhood": row["neighborhood"],
            "price_level": row["price_level"],
            "vibe_tags": row["vibe_tags"],
            "status": args.status,
            "notes": row["notes"],
        }
        for row in rows
    ]

    if args.dry_run:
        print(
            json.dumps(
                {
                    "profile_id": profile_id,
                    "status": args.status,
                    "rows": len(payload),
                    "sample": payload[:5],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    base_url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not base_url or not key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.")
        return 1

    if not check_profile_exists(base_url, key, profile_id):
        print(
            f"Profile {profile_id} not found in public.profiles. "
            "Create that profile first, or use an existing PROFILE_ID."
        )
        return 1

    # Upsert in chunks to keep payloads reasonable
    chunk_size = 50
    total = len(payload)
    for i in range(0, total, chunk_size):
        chunk = payload[i : i + chunk_size]
        url = (
            f"{base_url}/rest/v1/restaurants"
            "?on_conflict=profile_id,name"
        )
        status, text = supabase_request("POST", url, key, chunk)
        if status >= 300:
            print(f"Import failed at chunk {i // chunk_size + 1} ({status}): {text}")
            return 1
        print(f"Upserted {i + len(chunk)}/{total}")

    print(
        f"Done. Imported {total} restaurants to profile_id={profile_id} with status={args.status}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

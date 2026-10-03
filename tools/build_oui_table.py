"""Generate backend/app/oui_data.py from the IEEE oui.csv registry.

The built-in table ships with the app so vendor lookup works offline; this
script regenerates it. Run it when you want a fresh registry:

    curl -sL -o oui.csv https://standards-oui.ieee.org/oui/oui.csv
    python tools/build_oui_table.py oui.csv backend/app/oui_data.py
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2])

    # Vendors that dominate home networks and are worth a curated group comment.
    rows: dict[str, str] = {}
    with src.open(encoding="utf-8", errors="ignore", newline="") as fh:
        for rec in csv.DictReader(fh):
            prefix = (rec.get("Assignment") or "").strip().upper()
            org = (rec.get("Organization Name") or "").strip()
            if len(prefix) != 6 or not org:
                continue
            rows.setdefault(prefix, org)

    dst.parent.mkdir(parents=True, exist_ok=True)
    with dst.open("w", encoding="utf-8") as out:
        out.write('"""MAC OUI -> vendor. Generated from the IEEE public registry.\n\n')
        out.write("Regenerate with tools/build_oui_table.py; do not hand-edit.\n")
        out.write('"""\n\nOUI_TABLE: dict[str, str] = {\n')
        for k in sorted(rows):
            out.write(f'    "{k}": {rows[k]!r},\n')
        out.write("}\n")
    print(f"wrote {len(rows)} OUIs to {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

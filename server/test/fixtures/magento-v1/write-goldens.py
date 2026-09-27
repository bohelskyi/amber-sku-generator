"""Offline authoring tool: serialize reviewed expected cells, NEVER actual output.

Run explicitly from repository root. Not imported or executed by tests.
Uses Python's standard CSV writer, not the application's serializer.
Review expected-rows.js and the entire JSON diff before accepting changes.
"""
import csv
import io
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent
fixture = json.loads(subprocess.check_output(
    ["node", "-e", "process.stdout.write(JSON.stringify(require('./expected-rows.js')))"],
    cwd=ROOT, encoding="utf-8",
))
goldens = {}
for case in fixture["cases"]:
    headers = fixture["headers"][case["group"]]
    base, english = dict(case["base"]), dict(case["english"])
    if case["id"] == "SV-escaping":
        # Hand-specified CSV cells: these three strings need apostrophes.
        # No automatic formula classifier is used to construct this oracle.
        base["sku"] = "' =SKU"
        english["sku"] = "' =SKU"
        base["name"] = "'@Сова, \"ніч\"\r\n крило з бурштину. Арт:  =SKU"
        base["rozmir_suveniriv"] = "'=1,2 \"см\"\r\n далі"
    lines = []
    for row in [headers, [base.get(h, "") for h in headers],
                [english.get(h, "") for h in headers]]:
        stream = io.StringIO(newline="")
        # CRLF makes the standard writer quote both CR and LF inside cells.
        # Remove only its final record terminator; embedded bytes stay intact.
        csv.writer(stream, lineterminator="\r\n").writerow(row)
        lines.append(stream.getvalue()[:-2])
    goldens[case["id"]] = "\n".join(lines)
(ROOT / "goldens.json").write_text(
    json.dumps(goldens, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n",
)

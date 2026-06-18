#!/usr/bin/env bash
# run.sh — roda classify.sh contra classify-eval.json e valida cada caso.
# Exit 0 = todos passaram (gate de regressão). Exit 1 = alguma divergência.
# Falsificação (prova que o eval tem dente): rode com --falsify — ele inverte os
# esperados e DEVE acusar todas as divergências (exit 0 só se pegou todas).
set -euo pipefail
cd "$(dirname "$0")"
python3 - "$@" <<'PY'
import json, subprocess, sys
falsify = "--falsify" in sys.argv
cases = json.load(open("classify-eval.json"))
diverg = 0
for c in cases:
    out = subprocess.run(["bash", "classify.sh"],
                         input="\n".join(c["files"]) + "\n",
                         capture_output=True, text=True).stdout
    got = dict(l.split("=") for l in out.strip().splitlines())
    exp = dict(c["expect"])
    if falsify:  # sabota o gabarito: agora got==exp seria o ERRO
        exp = {k: ("SIM" if v == "não" else "não") for k, v in exp.items()}
    ok = (got == exp)
    if not ok:
        diverg += 1
    print(f"  [{'ok ' if ok else 'XX '}] {c['name']}")
n = len(cases)
if falsify:
    # esperamos que TODOS divirjam; se algum 'passou', o eval é cego
    print(f"--falsify: {diverg}/{n} divergiram (esperado: {n}/{n})")
    sys.exit(0 if diverg == n else 1)
print(f"{n - diverg}/{n} passaram")
sys.exit(1 if diverg else 0)
PY

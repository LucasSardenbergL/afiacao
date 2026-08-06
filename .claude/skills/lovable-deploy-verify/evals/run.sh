#!/usr/bin/env bash
# run.sh — GATE de regressão da skill lovable-deploy-verify. Roda os DOIS evals:
#   (1) classify        — classificação de diff do Passo 1 (classify.sh vs classify-eval.json)
#   (2) verify-frontend — enumeração + exit codes do Passo 4 (harness local determinístico)
# Exit 0 = tudo passou. Exit 1 = alguma divergência.
# Falsificação (prova que os evals têm dente): --falsify sabota AMBOS e exige vermelho
#   (classify inverte os esperados; verify-frontend sabota a enumeração). Exit 0 só se pegou tudo.
set -uo pipefail
cd "$(dirname "$0")" || exit 2

FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1
rc=0

echo "== (1) classify — Passo 1 =="
if python3 - "$@" <<'PY'
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
then :; else rc=1; fi

echo ""
echo "== (2) verify-frontend — Passo 4 =="
if [ "$FALSIFY" = 1 ]; then
  bash verify-frontend-eval.sh --falsify || rc=1
else
  bash verify-frontend-eval.sh || rc=1
fi

echo ""
if [ "$rc" -eq 0 ]; then echo "✅ evals lovable-deploy-verify: OK"; else echo "❌ evals lovable-deploy-verify: FALHOU"; fi
exit "$rc"

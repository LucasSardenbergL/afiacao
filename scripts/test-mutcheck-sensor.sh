#!/usr/bin/env bash
# test-mutcheck-sensor.sh — TDD do SENSOR do job `mutation-check` (#2316 → sensor).
#
# O que se prova aqui, e por que cada peça existe:
#   1. o resumo JSON do mutcheck-all classifica os QUATRO estados — honrado, DIVERGE (a suíte
#      perdeu poder), INVÁLIDA (o .mut envelheceu com o fonte) e baseline vermelho (o monitor
#      quebrou). Fundi-los é o que fazia o vermelho custar horas para ser lido (#2279/#2289).
#   2. o script do alerta, EXTRAÍDO do próprio ci.yml e executado, escreve o remédio CERTO para
#      cada causa. Testar só o JSON deixaria o consumidor fora da medição, e é o consumidor que
#      o founder lê.
#
# ⚠️ CASO VERDE obrigatório (docs/historico/guard-novo-sem-caso-verde.md): "tudo vermelho, como
# esperado" é compatível com o arnês quebrado. Se o cenário honrado não ficar verde, o teste
# ABORTA antes de afirmar qualquer coisa sobre os vermelhos.
set -u

raiz="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0

ok()   { echo "  ok    | $1"; }
bad()  { echo "  FAIL  | $1"; fail=1; }

# ─── fixture: um "helper" e um runner que o inspeciona (mesma mecânica do --selftest) ───
src="$tmp/alvo.ts"; runner="$tmp/runner.sh"; d="$tmp/contratos"; mkdir -p "$d"
printf 'export const pick = (xs) => Math.min(...xs); // marca\n' > "$src"
# passa só enquanto o SRC ainda tem Math.min  →  dá dente à mutação min->max e a nenhuma outra
printf '#!/usr/bin/env bash\ngrep -q "Math.min" "%s"\n' "$src" > "$runner"
chmod +x "$runner"
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/runner-vermelho.sh"; chmod +x "$tmp/runner-vermelho.sh"

contrato() { # <nome> <runner> <linhas do .mut...>
  local nome="$1" run="$2"; shift 2
  { echo "# @src: $src"; echo "# @test: $runner"; echo "# @test_cmd: bash $run"
    echo "# @compile_cmd: true"; printf '%s\n' "$@"; } > "$d/$nome.mut"
}

resumo() { # roda o mutcheck-all só sobre $d e ecoa o JSON
  MUTCHECK_DIR="$d" MUTCHECK_RESUMO="$tmp/r.json" bash "$raiz/scripts/mutcheck-all.sh" >/dev/null 2>&1
  cat "$tmp/r.json"
}
campo() { # <json> <campo do 1o contrato>
  bun -e "const r=JSON.parse(process.argv[1]);console.log(String(r.contratos[0][process.argv[2]]))" "$1" "$2" 2>/dev/null
}

# ─── CONTROLE VERDE (antes de qualquer cenário vermelho) ───
contrato honrado "$runner" 'PEGA      | min->max (coberta) | s/Math\.min/Math.max/'
j=$(resumo)
if [[ "$(campo "$j" exit)" == "0" && "$(bun -e 'console.log(JSON.parse(process.argv[1]).com_problema)' "$j")" == "0" ]]; then
  ok "CONTROLE: contrato honrado → exit 0, com_problema 0"
else
  echo "  ABORTANDO: o cenário honrado não ficou verde — arnês suspeito, nada a concluir dos vermelhos."
  echo "  json=$j"; exit 9
fi

# ─── DIVERGE: declara PEGA numa mutação INERTE (comentário) → a suíte não a mata ───
contrato honrado "$runner" 'PEGA      | min->max (controle) | s/Math\.min/Math.max/' \
                           'PEGA      | marca (inerte)      | s/marca/MARCA/'
j=$(resumo)
if [[ "$(campo "$j" divergencias)" == "1" ]]; then ok "DIVERGE contado (1)"; else bad "DIVERGE não contado: $(campo "$j" divergencias)"; fi
if [[ "$(campo "$j" invalidas)" == "0" ]]; then ok "DIVERGE não é confundido com inválida"; else bad "inválida contaminou o DIVERGE"; fi

# ─── INVÁLIDA: padrão que não casa mais o fonte (o .mut envelheceu) ───
contrato honrado "$runner" 'PEGA      | min->max (controle) | s/Math\.min/Math.max/' \
                           'PEGA      | padrao velho        | s/NAO_EXISTE_XYZ/z/'
j=$(resumo)
if [[ "$(campo "$j" invalidas)" == "1" ]]; then ok "INVÁLIDA contada (1)"; else bad "INVÁLIDA não contada: $(campo "$j" invalidas)"; fi
if [[ "$(campo "$j" divergencias)" == "0" ]]; then ok "INVÁLIDA não é confundida com DIVERGE"; else bad "DIVERGE contaminou a inválida"; fi

# ─── BASELINE VERMELHO: o monitor não conseguiu medir ───
contrato honrado "$tmp/runner-vermelho.sh" 'PEGA | min->max | s/Math\.min/Math.max/'
j=$(resumo)
if [[ "$(campo "$j" abortou)" == "true" ]]; then ok "baseline vermelho marcado como abortou"; else bad "abortou não marcado: $(campo "$j" abortou)"; fi

# ─── o CONSUMIDOR: o script do alerta, extraído do ci.yml e executado ───
bun "$raiz/scripts/mutcheck-sensor-corpo.mjs" "$raiz" || fail=1

if [[ $fail -eq 0 ]]; then echo "test-mutcheck-sensor: ok"; else echo "test-mutcheck-sensor: FALHOU"; fi
exit "$fail"

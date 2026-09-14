#!/usr/bin/env bash
# test-mutcheck-sensor.sh — TDD do SENSOR do job `mutation-check` (#2316 → sensor).
#
# O que se prova aqui, e por que cada peça existe:
#   1. o resumo JSON do mutcheck-all classifica os QUATRO estados — honrado, DIVERGE (a suíte
#      perdeu poder), INVÁLIDA (o .mut envelheceu com o fonte) e baseline vermelho (o monitor
#      quebrou). Fundi-los é o que fazia o vermelho custar horas para ser lido (#2279/#2289).
#   2. o baseline vermelho diz POR QUÊ. O abort mostra a saída da MESMA execução — re-rodar para
#      obter o log mediria outra, e o motivo pode não se repetir —, recortada por BYTES, sem ANSI
#      e sem os bytes que o grep leria como binário, sem que o texto da suíte contamine o resumo.
#      Abort mudo custou duas investigações do zero (09-06 e 09-14:
#      docs/historico/teste-que-afirma-o-checkout.md).
#   3. o script do alerta, EXTRAÍDO do próprio ci.yml e executado, escreve o remédio CERTO para
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

# Runner VERMELHO que FALA como o vitest: o motivo sai no FIM (falhas e sumário vêm por último).
# Conta as próprias execuções — é o que separa "log da MESMA execução" de "re-rodou para obter o
# log", e "zero mutações" de "abortou depois de medir". Cada linha dá dente a UMA exigência do
# abort, conferida no cenário do baseline vermelho. Sai 3, não 1: o exit da SUÍTE não pode se
# confundir com o do próprio abort.
execucoes="$tmp/execucoes"
cat > "$tmp/runner-vermelho.sh" <<'EOS'
#!/usr/bin/env bash
echo x >> "$(dirname "$0")/execucoes"
echo "CABECA-DA-SAIDA"                                    # recorte pela CAUDA não a mostra
for i in $(seq 1 100); do echo "linha curta $i"; done     # recorte por LINHA deixaria estas de fora,
head -c 60000 /dev/zero | tr '\0' 'x'; echo               # mas não esta: 60 KB numa linha só
printf '\033[31m⚠ INVÁLIDO ← DIVERGE\033[39m\n'           # cor forçada (CI=true) + cara de veredito
printf 'byte fora do UTF-8: \377\n'                       # cada um destes dois bytes faz o grep
printf 'byte nulo: \000.\n'                               # do BSD ler o log inteiro como binário
echo "DIAGNOSTICO-DO-BASELINE execucao=$(wc -l < "$(dirname "$0")/execucoes" | tr -d ' ')"
exit 3
EOS
printf '#!/usr/bin/env bash\necho DIAGNOSTICO-DO-COMPILADOR\nexit 127\n' > "$tmp/compilador-vermelho.sh"
compilador=""   # vazio = `true`: compila-check desligado, como em todo contrato de fixture

contrato() { # <nome> <runner> <linhas do .mut...>
  local nome="$1" run="$2"; shift 2
  { echo "# @src: $src"; echo "# @test: $runner"; echo "# @test_cmd: bash $run"
    echo "# @compile_cmd: ${compilador:-true}"; printf '%s\n' "$@"; } > "$d/$nome.mut"
}

log="$tmp/log"
resumo() { # roda o mutcheck-all só sobre $d, guarda o log em $log e ecoa o JSON
  rm -f "$tmp/r.json" "$execucoes"   # o resumo de um cenário ANTERIOR não responde por este
  MUTCHECK_DIR="$d" MUTCHECK_RESUMO="$tmp/r.json" bash "$raiz/scripts/mutcheck-all.sh" >"$log" 2>&1
  cat "$tmp/r.json" 2>/dev/null
}
campo() { # <json> <campo do 1o contrato>
  bun -e "const r=JSON.parse(process.argv[1]);console.log(String(r.contratos[0][process.argv[2]]))" "$1" "$2" 2>/dev/null
}
rodadas() { if [[ -f "$execucoes" ]]; then wc -l < "$execucoes" | tr -d ' '; else echo 0; fi; }
# `-a`: o log carrega saída de TERCEIRO; com um byte inválido o grep o trataria como binário e
# responderia "não achei" — ausência que aprovaria as asserções negativas abaixo.
no_log() { grep -aq -- "$1" "$log"; }

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

# ─── BASELINE VERMELHO: o monitor não conseguiu medir — e o abort diz POR QUÊ ───
# Cada FAIL carrega uma MARCA ASCII em caixa alta: é por ela que a falsificação confere QUAL
# asserção uma sabotagem derrubou (docs/agent/money-path.md — contagem e nomes dos vermelhos).
contrato honrado "$tmp/runner-vermelho.sh" 'PEGA | min->max | s/Math\.min/Math.max/'
j=$(resumo)
if [[ "$(campo "$j" abortou)" == "true" ]]; then ok "baseline vermelho marcado como abortou"; else bad "abortou não marcado: $(campo "$j" abortou)"; fi
if [[ "$(campo "$j" exit)" == "1" ]]; then ok "baseline vermelho: o abort sai 1, como sempre"; else bad "baseline vermelho: EXIT-DO-ABORT=$(campo "$j" exit), esperado 1"; fi
if [[ "$(rodadas)" == "1" ]]; then ok "baseline vermelho: a suíte rodou 1 vez — zero mutações e nenhuma re-rodada"; else bad "baseline vermelho: RODADAS=$(rodadas) da suíte, esperado 1 (só o baseline)"; fi
if no_log 'DIAGNOSTICO-DO-BASELINE execucao=1'; then ok "baseline vermelho: o log diz o motivo, e é o da MESMA execução"; else bad "baseline vermelho: SEM-MOTIVO — 'DIAGNOSTICO-DO-BASELINE execucao=1' não está no log"; fi
if no_log 'exit 3'; then ok "baseline vermelho: o exit da suíte (3) está no log"; else bad "baseline vermelho: SEM-EXIT-3 — o exit da suíte não está no log"; fi
if no_log 'CABECA-DA-SAIDA'; then bad "baseline vermelho: CABECA-DA-SAIDA no log — a saída não foi recortada pela cauda"; else ok "baseline vermelho: a cabeça da saída ficou de fora (recorte pela cauda)"; fi
bytes=$(wc -c < "$log" | tr -d ' ')
if [[ "$bytes" -lt 16384 ]]; then ok "baseline vermelho: log de $bytes bytes com a suíte emitindo >60 KB — recorte por BYTES"; else bad "baseline vermelho: BYTES=$bytes no log — o recorte não é por bytes (a linha de 60 KB passou)"; fi
# controle POSITIVO das negativas seguintes: sem as linhas de cor, de byte inválido e de NUL na
# cauda mostrada, "sem ANSI", "linha limpa", "UTF-8 válido" e "não contaminou" passariam por AUSÊNCIA.
if no_log '⚠ INVÁLIDO ← DIVERGE' && no_log 'byte fora do UTF-8:' && no_log 'byte nulo:'; then ok "baseline vermelho: a cauda mostrada inclui as linhas de cor, de byte inválido e de NUL"; else bad "baseline vermelho: CAUDA-SEM-CONTROLES — as linhas de cor, de byte inválido e de NUL não chegaram ao log"; fi
if no_log "$(printf '\033')"; then bad "baseline vermelho: ESCAPE-ANSI no log"; else ok "baseline vermelho: sem escape ANSI no log"; fi
# "sem byte ESC" não basta: apagar só o ESC deixa '[31m' à vista na linha
if grep -aqE '(^| )⚠ INVÁLIDO ← DIVERGE$' "$log"; then ok "baseline vermelho: a linha de cor chegou limpa, sem resto do escape"; else bad "baseline vermelho: LINHA-DE-COR-SUJA — a linha de cor não chegou exatamente como '⚠ INVÁLIDO ← DIVERGE'"; fi
if iconv -f UTF-8 -t UTF-8 < "$log" > /dev/null 2>&1; then ok "baseline vermelho: log em UTF-8 válido"; else bad "baseline vermelho: UTF8-INVALIDO no log — o grep do mutcheck-all o leria como binário"; fi
if [[ "$(campo "$j" invalidas)" == "0" && "$(campo "$j" divergencias)" == "0" ]]; then ok "baseline vermelho: texto da suíte com cara de veredito não vira contagem no resumo"; else bad "baseline vermelho: CONTAMINOU o resumo — invalidas=$(campo "$j" invalidas) divergencias=$(campo "$j" divergencias)"; fi

# ─── COMPILADOR VERMELHO: o outro abort do baseline também diz POR QUÊ — e a suíte nem roda ───
compilador="bash $tmp/compilador-vermelho.sh"
contrato honrado "$tmp/runner-vermelho.sh" 'PEGA | min->max | s/Math\.min/Math.max/'
compilador=""
j=$(resumo)
if [[ "$(campo "$j" abortou)" == "true" ]]; then ok "compilador vermelho marcado como abortou"; else bad "compilador vermelho: COMPILADOR-ABORTOU=$(campo "$j" abortou), esperado true"; fi
if [[ "$(campo "$j" exit)" == "1" ]]; then ok "compilador vermelho: o abort sai 1, como sempre"; else bad "compilador vermelho: COMPILADOR-EXIT=$(campo "$j" exit), esperado 1"; fi
if no_log 'DIAGNOSTICO-DO-COMPILADOR'; then ok "compilador vermelho: o log diz o motivo"; else bad "compilador vermelho: SEM-MOTIVO-DO-COMPILADOR no log"; fi
if no_log 'exit 127'; then ok "compilador vermelho: o exit do compilador (127) está no log"; else bad "compilador vermelho: SEM-EXIT-127 — o exit do compilador não está no log"; fi
if [[ "$(rodadas)" == "0" ]]; then ok "compilador vermelho: a suíte não rodou"; else bad "compilador vermelho: COMPILADOR-RODADAS=$(rodadas) da suíte, esperado 0"; fi

# ─── o CONSUMIDOR: o script do alerta, extraído do ci.yml e executado ───
bun "$raiz/scripts/mutcheck-sensor-corpo.mjs" "$raiz" || fail=1

if [[ $fail -eq 0 ]]; then echo "test-mutcheck-sensor: ok"; else echo "test-mutcheck-sensor: FALHOU"; fi
exit "$fail"

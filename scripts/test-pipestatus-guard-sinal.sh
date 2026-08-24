#!/usr/bin/env bash
# test-pipestatus-guard-sinal.sh — prova do sensor de campo do pipestatus-zsh-guard.
#
# Cobre os dois lados: o hook GRAVANDO e o scripts/pipestatus-guard-sinal.sh LENDO.
# Os invariantes que sustentam o desenho, e que quebram calados se alguém mexer:
#   - a linha cabe num append atômico (<400 bytes) -> ~30 worktrees escrevem sem lock nem picote;
#   - segredo que encoste na janela é REDIGIDO antes de tocar o disco;
#   - falha de log NÃO cala o aviso (o sensor é acessório, o guard é o produto);
#   - SEM-LOG e LOG-VAZIO são veredictos DIFERENTES — ausência de dado não é aprovação.
# shellcheck disable=SC2016  # os comandos de teste são strings LITERAIS: expandir destruiria o alvo
set -u

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$RAIZ/.claude/hooks/pipestatus-zsh-guard.sh"
QUERY="$RAIZ/scripts/pipestatus-guard-sinal.sh"
command -v jq >/dev/null || { echo "jq é necessário" >&2; exit 1; }
falhas=0
ok()    { printf '  ok   %s\n' "$1"; }
falha() { printf '  FALHA %s — %s\n' "$1" "$2"; falhas=$((falhas + 1)); }
# helpers com if/else de verdade: `A && ok || falha` roda o falha quando o ok devolve nao-zero
# (SC2015), e um teste que se auto-reprova por isso e pior que teste nenhum.
prova()  { if "${@:3}"; then ok "$1"; else falha "$1" "$2"; fi; }   # espera SUCESSO
nprova() { if "${@:3}"; then falha "$1" "$2"; else ok "$1"; fi; }   # espera FALHA

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
LOG="$TMP/sinal.jsonl"

dispara() { # <comando> [log]
  PIPESTATUS_GUARD_LOG="${2:-$LOG}" \
    jq -n -c --arg cmd "$1" '{tool_name:"Bash",tool_input:{command:$cmd}}' \
    | PIPESTATUS_GUARD_LOG="${2:-$LOG}" bash "$HOOK" 2>/dev/null
}

echo "== pipestatus-guard-sinal =="

# S1 grava quando dispara
dispara 'git push | tail -3; echo "EXIT=${PIPESTATUS[0]}"' >/dev/null
prova "S1 grava ao disparar" "nao gravou" [ "$(wc -l < "$LOG" 2>/dev/null || echo 0)" -eq 1 ]

# S2 NAO grava quando nao dispara (senao o denominador vira ruido)
dispara 'ls -la' >/dev/null
prova "S2 silencio nao grava" "gravou sem disparar" [ "$(wc -l < "$LOG")" -eq 1 ]

# S3/S4 redacao ANTES do disco
dispara 'curl -H "Authorization: Bearer sk-segredo-123" u | jq .; echo ${PIPESTATUS[0]}' >/dev/null
dispara 'export K=eyJhbGciOiJIUzI1NiJ9.zzzz; a | b; echo ${PIPESTATUS[0]}' >/dev/null
nprova "S3 Bearer redigido" "Bearer vazou para o disco" command grep -q "sk-segredo-123" "$LOG"
nprova "S4 JWT redigido" "JWT vazou para o disco" command grep -q "eyJhbGciOiJIUzI1NiJ9" "$LOG"

# S5 toda linha e JSON valido
prova "S5 JSONL valido" "JSON invalido" jq -e -s "length" "$LOG"

# S6 trecho preenchido (o bug do /regex/ virando 0|1 esvaziava isto em silencio)
if jq -es 'all(.trecho != "")' "$LOG" >/dev/null 2>&1; then ok "S6 trecho nunca vazio"
else falha "S6" "trecho vazio: $(jq -rs 'map(select(.trecho==""))|length' "$LOG") linha(s)"; fi

# S7 comando MULTI-LINHA continua UMA linha no log (heredoc nao pode picotar o JSONL)
multi="$(printf 'cat <<EOF\n${PIPESTATUS[0]}\nEOF\n')"
antes="$(wc -l < "$LOG")"; dispara "$multi" >/dev/null; depois="$(wc -l < "$LOG")"
prova "S7 multi-linha vira 1 linha" "gravou $((depois-antes)) linhas" [ $((depois - antes)) -eq 1 ]

# S8 INVARIANTE DE ATOMICIDADE: a linha PRONTA cabe no PIPE_BUF do macOS (512), que e menor que os
# 4096 do Linux. A versao anterior enchia o comando de `x` e media 176B — dado TIPICO, nao pior caso.
# O vetor real de estouro e a INFLACAO DO ESCAPE, que acontece DEPOIS do corte do campo: com `jq -a`
# cada acento vira \uXXXX (6 bytes), e o nome da worktree entra inteiro. Medido antes do teto: 1282B.
gigante="$(printf 'x%.0s' $(seq 1 900))"
dispara "echo \"$gigante \${PIPESTATUS[0]} $gigante\"" >/dev/null
# O vetor que realmente estoura NAO e "comando grande": e MATCH grande. A regex `\$\{[^}]*PIPESTATUS`
# nao tem limite, entao a janela do awk (RLENGTH+80) cresce junto, e so DEPOIS o escape infla — cada
# byte de controle vira \u00XX (6 bytes) no `jq -a`. Medido sem teto: 1010B; com teto: 290B.
# Acento nao serve de vetor: para com 414B por si so, e o teste passaria sem o teto (falso verde).
lixo="$(awk 'BEGIN { s = ""; for (i = 0; i < 300; i++) s = s "\001"; print s }')"
VETOR="echo \${${lixo}PIPESTATUS[0]}"
DIRLONGO="$TMP/$(printf "l%.0s" $(seq 1 200))"   # nome de worktree longo entra na mesma linha
mkdir -p "$DIRLONGO"
( cd "$DIRLONGO" && dispara "$VETOR" ) >/dev/null
maior="$(awk '{ if (length > m) m = length } END { print m+1 }' "$LOG")"
prova "S8 maior linha ${maior}B (<512 = PIPE_BUF do macOS, append atomico)" \
      "linha de ${maior}B pode picotar sob concorrencia entre worktrees" \
      [ "$maior" -lt 512 ]
prova "S8b linha inflada continua JSON valido (corte multibyte sanitizado)" "JSON quebrado" \
      jq -e -s 'length > 0' "$LOG"

# S8c PERMISSAO: o log guarda FRAGMENTO DE COMANDO. World-readable (0644) era o default herdado do
# umask, e ninguem tinha medido — o Codex mediu.
prova "S8c log nasce 0600" "log criado como $(stat -f '%Sp' "$LOG" 2>/dev/null) — legivel por outros" \
      [ "$(stat -f '%Sp' "$LOG" 2>/dev/null)" = "-rw-------" ]

# S9 FAIL-OPEN: log impossivel de escrever NAO pode calar o aviso
saida="$(dispara 'x | y; echo ${PIPESTATUS[0]}' "/dev/null/impossivel/x.jsonl")"
if printf '%s' "$saida" | jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1; then
  ok "S9 log quebrado nao cala o aviso"
else falha "S9" "o guard emudeceu porque o log falhou"; fi

# ── a QUERY ────────────────────────────────────────────────────────────────────────────────────
# S10 SEM-LOG: ausencia de dado NAO e aprovacao (exit 3, marcador proprio)
s="$(bash "$QUERY" "$TMP/nao-existe.jsonl" 2>&1)"; rc=$?
if [ "$rc" -eq 3 ] && printf '%s' "$s" | command grep -q "SEM-LOG"; then ok "S10 SEM-LOG (exit 3)"
else falha "S10" "rc=$rc / faltou marcador SEM-LOG"; fi
# e NAO pode sugerir que da para endurecer
if printf '%s' "$s" | command grep -q "não dá para decidir"; then ok "S10b SEM-LOG nao aprova endurecer"
else falha "S10b" "SEM-LOG nao desaconselha endurecer"; fi

# S11 LOG-VAZIO e um veredito DIFERENTE de SEM-LOG
: > "$TMP/vazio.jsonl"
s="$(bash "$QUERY" "$TMP/vazio.jsonl" 2>&1)"
if printf '%s' "$s" | command grep -q "LOG-VAZIO"; then ok "S11 LOG-VAZIO distinto de SEM-LOG"
else falha "S11" "nao distinguiu log vazio de log ausente"; fi

# S12 com dados: conta e agrupa
cat > "$TMP/cheio.jsonl" <<'JSONL'
{"ts":"2026-08-01T10:00:00Z","ramo":"BASHISM","trecho":"echo ${PIPESTATUS[0]}","wt":"wt-a"}
{"ts":"2026-08-02T10:00:00Z","ramo":"BASHISM","trecho":"echo ${PIPESTATUS[0]}","wt":"wt-a"}
{"ts":"2026-08-03T10:00:00Z","ramo":"INDICE-ZERO","trecho":"rc=${pipestatus[0]}","wt":"wt-b"}
JSONL
s="$(bash "$QUERY" "$TMP/cheio.jsonl" 2>&1)"
if printf '%s' "$s" | command grep -q "Disparos: 3"; then ok "S12 total correto"
else falha "S12" "total errado"; fi
if printf '%s' "$s" | command grep -q "BASHISM=2"; then ok "S12b agrupa por ramo"
else falha "S12b" "ramo errado"; fi
if printf '%s' "$s" | command grep -q "2x"; then ok "S12c agrupa padroes iguais"
else falha "S12c" "nao agrupou"; fi
if printf '%s' "$s" | command grep -q "insuficiente para endurecer"; then ok "S12d 3 disparos nao autorizam"
else falha "S12d" "aprovou endurecer com 3 disparos"; fi


# S13 SCHEMA vs PARSE: JSONL de linhas VALIDAS porem sem os campos do sensor produzia relatorio de
# "null" com exit 0 — ausencia de dado servida como medicao, o vicio que este sensor combate.
outro="$TMP/outro-log.jsonl"
printf '%s\n' '{"foo":1}' '{"bar":"x"}' > "$outro"
s="$(PIPESTATUS_GUARD_LOG="$outro" bash "$QUERY" 2>&1)"; rc=$?
prova "S13 schema estranho nao sai 0" "saiu rc=$rc — indistinguivel de relatorio bom" [ "$rc" -eq 65 ]
if printf '%s' "$s" | command grep -q "SCHEMA-ESTRANHO"; then ok "S13b nomeia o problema"
else falha "S13b" "nao explicou por que nao ha relatorio"; fi
nprova "S13c nao imprime null como se fosse dado" "vazou 'null' no relatorio" \
       sh -c 'printf "%s" "$1" | command grep -q null' _ "$s"

# S14 MISTO: linha estranha no meio nao pode contaminar a contagem — nem calar o relatorio.
misto="$TMP/misto.jsonl"
printf '%s\n' '{"ts":"2026-08-20T10:00:00Z","ramo":"BASHISM","trecho":"a","wt":"w1"}' '{"foo":1}' > "$misto"
s="$(PIPESTATUS_GUARD_LOG="$misto" bash "$QUERY" 2>&1)"
if printf '%s' "$s" | command grep -q "1 de 2 linha(s) ignorada"; then ok "S14 declara o que ignorou"
else falha "S14" "ignorou linha em silencio"; fi
if printf '%s' "$s" | command grep -q "Disparos: 1"; then ok "S14b conta so as validas"
else falha "S14b" "contagem incluiu linha invalida"; fi

# S15 ts INVALIDO: string, mas nao e data. Passa em checagem de TIPO e mata a agregacao la na frente.
datar="$TMP/data-ruim.jsonl"
printf '%s\n' '{"ts":"ontem","ramo":"BASHISM","trecho":"a","wt":"w1"}' > "$datar"
s="$(PIPESTATUS_GUARD_LOG="$datar" bash "$QUERY" 2>&1)"; rc=$?
prova "S15 ts nao-parseavel e linha invalida" "rc=$rc — a query aceitou data que quebra o agregado" \
      [ "$rc" -eq 65 ]

# ── FALSIFICAÇÃO ───────────────────────────────────────────────────────────────────────────────
# Sabota a redacao. Se S3 continuar verde, e porque nunca dependeu dela.
echo "-- falsificacao: remove a redacao de segredo --"
BKP="$(mktemp)"; cp "$HOOK" "$BKP"
restaura() { [ -f "$BKP" ] && cp "$BKP" "$HOOK"; rm -f "$BKP"; }   # idempotente: roda aqui E no trap
trap 'restaura; rm -rf "$TMP"' EXIT
perl -0pi -e 's/\[Bb\]earer/ZZnuncacasaZZ/' "$HOOK"
if cmp -s "$BKP" "$HOOK"; then falha "falsificacao" "a sabotagem NAO alterou o hook — seria teatro"
else
  LOGF="$TMP/falso.jsonl"
  dispara 'curl -H "Authorization: Bearer sk-segredo-123" u | jq .; echo ${PIPESTATUS[0]}' "$LOGF" >/dev/null
  if command grep -q "sk-segredo-123" "$LOGF" 2>/dev/null; then ok "sabotagem ficou VERMELHA (a redacao e mesmo o que protege)"
  else falha "falsificacao" "segredo continuou redigido sem a redacao — S3 nao prova nada"; fi
fi
restaura


# Sabota o TETO. Se S8 continuar verde, e porque o laco de encolhimento nunca foi o que o segurava
# — foi sorte do dado de teste, que era exatamente o erro da versao anterior.
echo "-- falsificacao 2: desliga o teto de bytes --"
BKP2="$(mktemp)"; cp "$HOOK" "$BKP2"
perl -0pi -e 's/^TETO_LINHA=511/TETO_LINHA=99999/m' "$HOOK"
if cmp -s "$BKP2" "$HOOK"; then falha "falsificacao2" "a sabotagem NAO alterou o hook — seria teatro"
else
  LOGT="$TMP/teto-falso.jsonl"
  DL2="$TMP/f2"; mkdir -p "$DL2"
  ( cd "$DL2" && dispara "$VETOR" "$LOGT" ) >/dev/null
  m2="$(awk '{ if (length > m) m = length } END { print m+1 }' "$LOGT")"
  if [ "${m2:-0}" -ge 512 ]; then ok "sabotagem ficou VERMELHA (${m2}B — o teto e mesmo o que segura)"
  else falha "falsificacao2" "linha ficou em ${m2}B sem teto — S8 nao prova nada"; fi
fi
cp "$BKP2" "$HOOK"; rm -f "$BKP2"

echo
if [ "$falhas" -eq 0 ]; then echo "PIPESTATUS-SINAL: TODOS OS TESTES PASSARAM"; exit 0; fi
echo "PIPESTATUS-SINAL: $falhas FALHA(S)"; exit 1

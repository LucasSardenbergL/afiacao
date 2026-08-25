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
dispara 'curl -H "Authorization: Bearer zzTOKENxx987654" u | jq .; echo ${PIPESTATUS[0]}' >/dev/null
dispara 'export K=eyJhbGciOiJIUzI1NiJ9.zzzz; a | b; echo ${PIPESTATUS[0]}' >/dev/null
nprova "S3 Bearer redigido" "Bearer vazou para o disco" command grep -q "zzTOKENxx987654" "$LOG"
nprova "S4 JWT redigido" "JWT vazou para o disco" command grep -q "eyJhbGciOiJIUzI1NiJ9" "$LOG"

# S5 toda linha e JSON valido
prova "S5 JSONL valido" "JSON invalido" jq -e -s "length" "$LOG"

# S6 trecho preenchido (o bug do /regex/ virando 0|1 esvaziava isto em silencio)
# `all(.trecho != "")` passa com o campo AUSENTE (`null != ""` e true em jq) — provava
# "nao e string vazia", nao "existe uma string". Exigir o TIPO e o que fecha.
if jq -es 'all((.trecho|type) == "string" and .trecho != "")' "$LOG" >/dev/null 2>&1; then ok "S6 trecho nunca vazio"
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
# shellcheck disable=SC2012  # SC2012 alerta sobre parsear NOME de arquivo; aqui so leio o modo
perm="$(ls -l "$LOG" 2>/dev/null | cut -c1-10)"   # stat -f e BSD; no GNU o -f e FILE SYSTEM, imprime outra coisa e sai 0
prova "S8c log termina 0600" "log ficou como ${perm:-?}" [ "$perm" = "-rw-------" ]
# ...e o legado tambem: arquivo que ja existia 0644 tem de ser corrigido no proximo disparo.
leg="$TMP/legado.jsonl"; : > "$leg"; chmod 644 "$leg"
dispara 'x | y; echo ${PIPESTATUS[0]}' "$leg" >/dev/null
# shellcheck disable=SC2012  # SC2012 alerta sobre parsear NOME de arquivo; aqui so leio o modo
permleg="$(ls -l "$leg" 2>/dev/null | cut -c1-10)"
prova "S8d log legado 0644 e corrigido para 0600" "ficou ${permleg:-?}" [ "$permleg" = "-rw-------" ]

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
# ancorado na LINHA de padrao (`Nx  [RAMO]  ...`): so "2x" casava tambem a secao de worktrees,
# entao a assercao ficava verde mesmo sem a secao de padroes existir.
if printf '%s' "$s" | command grep -qE '^  2x  \[[A-Z-]+\]'; then ok "S12c agrupa padroes iguais"
else falha "S12c" "nao agrupou"; fi
if printf '%s' "$s" | command grep -q "insuficiente para endurecer"; then ok "S12d 3 disparos nao autorizam"
else falha "S12d" "aprovou endurecer com 3 disparos"; fi


# S13 SCHEMA vs PARSE: JSONL de linhas VALIDAS porem sem os campos do sensor produzia relatorio de
# "null" com exit 0 — ausencia de dado servida como medicao, o vicio que este sensor combate.
outro="$TMP/outro-log.jsonl"
printf '%s\n' '{"foo":1}' '{"bar":"x"}' > "$outro"
s="$(PIPESTATUS_GUARD_LOG="$outro" bash "$QUERY" 2>&1)"; rc=$?
prova "S13 schema estranho nao sai 0" "saiu rc=$rc — indistinguivel de relatorio bom" [ "$rc" -eq 65 ]
if printf '%s' "$s" | command grep -q "LOG-ILEGIVEL"; then ok "S13b nomeia o problema"
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

# ── S16-S20: achados do /codex retroativo, cada um medido antes de virar codigo ───────────────

# S16 REDACAO: a versao anterior so cobria Bearer/JWT/`chave=valor`. Estas quatro formas iam para o
# disco em texto plano — e log e disco (CLAUDE.md: segredo nunca em texto plano).
sec="$TMP/segredos.jsonl"
dispara 'curl -H "Authorization: token ghp_AAAAAAAAAAAAAAAAAAAA" u | x; echo "EXIT=$?"' "$sec" >/dev/null
dispara 'curl -u admin:segredo123 https://x | y; echo "EXIT=$?"' "$sec" >/dev/null
dispara 'psql postgres://u:minhasenha123@h/db | x; echo "EXIT=$?"' "$sec" >/dev/null
dispara 'mysql --password segredoabc | x; echo "EXIT=$?"' "$sec" >/dev/null
nprova "S16 PAT do GitHub redigido" "ghp_ vazou para o disco" command grep -q "ghp_AAAA" "$sec"
nprova "S16b curl -u user:senha redigido" "senha de -u vazou" command grep -q "segredo123" "$sec"
nprova "S16c credencial na URL redigida" "senha da URL vazou" command grep -q "minhasenha123" "$sec"
nprova "S16d --password com ESPACO redigido" "senha de --password vazou" command grep -q "segredoabc" "$sec"

# S17 wt: `${PWD##*/}` gravava o basename do CWD — de `<worktree>/src/lib` saia `lib`, e o
# agrupamento por worktree da query virava ficcao.
sub="$TMP/raiz-git/src/lib"; mkdir -p "$sub" "$TMP/raiz-git/.git"
wtlog="$TMP/wt.jsonl"
( cd "$sub" && dispara 'x | y; echo "EXIT=$?"' "$wtlog" ) >/dev/null
prova "S17 wt vem da raiz do worktree, nao do subdiretorio" \
      "gravou '$(jq -r .wt "$wtlog" 2>/dev/null | tail -1)' em vez de raiz-git" \
      [ "$(jq -r '.wt' "$wtlog" 2>/dev/null | tail -1)" = "raiz-git" ]

# S18 PICOTE: uma unica linha truncada fazia `jq -s` abortar e o relatorio inteiro morria (exit 65)
# — 100% do sinal perdido por 1 linha, num log que ~30 worktrees escrevem em append.
pic="$TMP/picotado.jsonl"
jq -n -c '{ts:"2026-08-24T10:00:00Z",ramo:"BASHISM",trecho:"a",wt:"w1"}'  > "$pic"
jq -n -c '{ts:"2026-08-24T11:00:00Z",ramo:"BASHISM",trecho:"b",wt:"w1"}' >> "$pic"
printf '{"ts":"2026-08-24T12:00:00Z","ra\n' >> "$pic"
s18="$(PIPESTATUS_GUARD_LOG="$pic" bash "$QUERY" 2>&1)"; rc18=$?
prova "S18 linha picotada nao mata o relatorio" "rc=$rc18 — perdeu o sinal todo por 1 linha" \
      [ "$rc18" -eq 0 ]
if printf '%s' "$s18" | command grep -q "Disparos: 2"; then ok "S18b conta as 2 boas"
else falha "S18b" "contagem errada com linha picotada"; fi
if printf '%s' "$s18" | command grep -q "1 de 3 linha"; then ok "S18c declara a que ignorou"
else falha "S18c" "ignorou a linha picotada em silencio"; fi

# S19 PADRAO vs INSTANCIA: 3 disparos do mesmo erro, diferindo so no arquivo de log, contavam como
# 3 padroes distintos — e o veredito manda o humano classificar um por um.
inst="$TMP/instancias.jsonl"
for f in a b c; do
  jq -n -c --arg f "$f" '{ts:"2026-08-20T10:00:00Z",ramo:"ECO-DE-EXIT",trecho:"bun test > /tmp/\($f).log 2>&1; echo EXIT=$?",wt:"w1"}' >> "$inst"
done
s19="$(PIPESTATUS_GUARD_LOG="$inst" bash "$QUERY" 2>&1)"
if printf '%s' "$s19" | command grep -q "classificar os 1 padrão"; then ok "S19 agrupa instancias no MESMO padrao"
else falha "S19" "contou instancias como padroes distintos"; fi

# S20 CORTE DECLARADO: top-15 silencioso le-se como "e tudo o que existe" (CLAUDE.md, no silent caps)
mui="$TMP/muitos.jsonl"; : > "$mui"
for v in alfa beta gama delta epsilon zeta eta teta iota kapa lambda mu nu xi omicron pi rho sigma tau upsilon; do
  jq -n -c --arg v "$v" '{ts:"2026-08-05T10:00:00Z",ramo:"BASHISM",trecho:"comando \($v) distinto",wt:"w1"}' >> "$mui"
done
s20="$(PIPESTATUS_GUARD_LOG="$mui" bash "$QUERY" 2>&1)"
if printf '%s' "$s20" | command grep -q "e mais 5 padrão"; then ok "S20 declara os padroes cortados"
else falha "S20" "cortou em 15 sem dizer quantos ficaram de fora"; fi

# ── S21-S23: o ramo POSITIVO do veredito, que nunca tinha teste ────────────────────────────────
# Era por isso que o bug passava: toda fixture existente ficava ABAIXO do limiar, entao o caminho
# "Volume e janela OK" nunca era exercitado — e ele usava `total` (linhas BRUTAS) em vez de validas.

# S21 satisfaz o criterio de verdade: 20 disparos validos em 20 dias ATIVOS distintos.
bom="$TMP/limiar-bom.jsonl"; : > "$bom"
for d in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20; do
  jq -n -c --arg d "$d" '{ts:"2026-08-\($d)T10:00:00Z",ramo:"BASHISM",trecho:"padrao \($d) unico",wt:"w1"}' >> "$bom"
done
s21="$(PIPESTATUS_GUARD_LOG="$bom" bash "$QUERY" 2>&1)"
if printf '%s' "$s21" | command grep -q "Volume e janela OK"; then ok "S21 criterio atingido libera a analise"
else falha "S21" "20 validos em 20 dias ativos nao atingiram o criterio"; fi

# S22 O BUG: 2 eventos reais + 18 linhas de OUTRO schema imprimiam "Disparos: 2", "18 ignoradas" e
# "[x] >= 20 disparos" na mesma tela. Veredito fabricado pelo sensor antifabricacao.
fab="$TMP/limiar-fabricado.jsonl"; : > "$fab"
jq -n -c '{ts:"2026-08-01T10:00:00Z",ramo:"BASHISM",trecho:"real um",wt:"w"}'  >> "$fab"
jq -n -c '{ts:"2026-08-20T10:00:00Z",ramo:"BASHISM",trecho:"real dois",wt:"w"}' >> "$fab"
for i in $(seq 1 18); do jq -n -c --arg i "$i" '{foo:$i}' >> "$fab"; done
s22="$(PIPESTATUS_GUARD_LOG="$fab" bash "$QUERY" 2>&1)"
nprova "S22 linha invalida NAO conta como disparo" "18 linhas de outro schema viraram volume" \
       sh -c 'printf "%s" "$1" | command grep -q "Volume e janela OK"' _ "$s22"
if printf '%s' "$s22" | command grep -qE '\[ \] >= 20 disparos validos'; then ok "S22b marca o volume como NAO atingido"
else falha "S22b" "marcou volume atingido com 2 validas"; fi

# S23 DIAS ATIVOS vs calendario: 1 disparo em 01/08 + 19 no dia 20 sao DOIS dias ativos, nao 19.
ret="$TMP/retries.jsonl"; : > "$ret"
jq -n -c '{ts:"2026-08-01T10:00:00Z",ramo:"BASHISM",trecho:"unico do dia 1",wt:"w"}' >> "$ret"
for i in $(seq 1 19); do
  jq -n -c --arg i "$i" '{ts:"2026-08-20T10:00:0\($i|tonumber%10)Z",ramo:"BASHISM",trecho:"retry \($i)",wt:"w"}' >> "$ret"
done
s23="$(PIPESTATUS_GUARD_LOG="$ret" bash "$QUERY" 2>&1)"
nprova "S23 retries num dia so nao viram janela de observacao" "2 dias ativos passaram por 14" \
       sh -c 'printf "%s" "$1" | command grep -q "Volume e janela OK"' _ "$s23"

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
  dispara 'curl -H "Authorization: Bearer zzTOKENxx987654" u | jq .; echo ${PIPESTATUS[0]}' "$LOGF" >/dev/null
  if command grep -q "zzTOKENxx987654" "$LOGF" 2>/dev/null; then ok "sabotagem ficou VERMELHA (a redacao e mesmo o que protege)"
  else falha "falsificacao" "segredo continuou redigido sem a redacao — S3 nao prova nada"; fi
fi
restaura


# Sabota o TETO. Se S8 continuar verde, e porque o laco de encolhimento nunca foi o que o segurava
# — foi sorte do dado de teste, que era exatamente o erro da versao anterior.
echo "-- falsificacao 2: desliga o teto de bytes --"
BKP2="$(mktemp)"; cp "$HOOK" "$BKP2"
# o trap vigente restaura $BKP (falsificacao 1), NAO $BKP2 — uma interrupcao aqui deixaria o hook
# de verdade com TETO_LINHA=99999. Sabotagem tem de ser reversivel ate por Ctrl-C.
trap 'cp "$BKP2" "$HOOK"; rm -f "$BKP2"; rm -rf "$TMP"' EXIT
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
cp "$BKP2" "$HOOK"; rm -f "$BKP2"; trap 'rm -rf "$TMP"' EXIT

# FALSIFICAÇÃO 3 — a normalizacao do trecho e o que faz "padroes distintos" contar PADRAO e nao
# INSTANCIA, e e desse numero que o criterio de veredito depende ("classifique os N padroes").
# Desligue-a e S19 deve voltar a ver 3 padroes onde ha 1.
echo "-- falsificacao 3: desliga a normalizacao do trecho --"
BKPQ="$(mktemp)"; cp "$QUERY" "$BKPQ"
trap 'cp "$BKPQ" "$QUERY"; rm -f "$BKPQ"; rm -rf "$TMP"' EXIT
perl -0pi -e 's/\| norma\)/)/g' "$QUERY"
if cmp -s "$BKPQ" "$QUERY"; then
  falha "falsificacao3" "a sabotagem NAO alterou a query — seria teatro"
else
  sf="$(PIPESTATUS_GUARD_LOG="$inst" bash "$QUERY" 2>&1)"
  if printf '%s' "$sf" | command grep -q "classificar os 3 padrão"; then
    ok "sabotagem 3 ficou VERMELHA (a normalizacao e mesmo o que agrupa)"
  else
    falha "falsificacao3" "sem normalizacao a contagem nao mudou — S19 nao prova nada"
  fi
fi
cp "$BKPQ" "$QUERY"; rm -f "$BKPQ"; trap 'rm -rf "$TMP"' EXIT

# FALSIFICAÇÃO 4 — o criterio tem de contar linhas VALIDAS. Volte-o para `total` (linhas brutas) e
# S22 deve ficar vermelho: 2 eventos reais + 18 linhas de lixo voltariam a marcar volume atingido.
echo "-- falsificacao 4: criterio volta a contar linha bruta --"
BKPQ2="$(mktemp)"; cp "$QUERY" "$BKPQ2"
trap 'cp "$BKPQ2" "$QUERY"; rm -f "$BKPQ2"; rm -rf "$TMP"' EXIT
perl -0pi -e 's/marca "\$validas" 20/marca "\$total" 20/; s/\$\{validas:-0\}" -ge 20/\$\{total:-0\}" -ge 20/' "$QUERY"
if cmp -s "$BKPQ2" "$QUERY"; then
  falha "falsificacao4" "a sabotagem NAO alterou a query — seria teatro"
else
  # fixture ISOLANTE: tem de passar em TODAS as outras regras para que so a sabotada decida.
  # `$fab` nao serve — ele e barrado pelos DIAS ATIVOS (2 < 14) e ficaria calado de qualquer jeito,
  # dando verde a uma falsificacao que nao falsificou nada. Aqui: 15 validos em 15 dias distintos
  # (dias OK, volume 15 < 20) + 10 linhas de lixo, que so o criterio BRUTO contaria.
  iso="$TMP/isolante.jsonl"; : > "$iso"
  for d in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15; do
    jq -n -c --arg d "$d" '{ts:"2026-08-\($d)T10:00:00Z",ramo:"BASHISM",trecho:"padrao \($d) unico",wt:"w1"}' >> "$iso"
  done
  for i in $(seq 1 10); do jq -n -c --arg i "$i" '{foo:$i}' >> "$iso"; done
  s4="$(PIPESTATUS_GUARD_LOG="$iso" bash "$QUERY" 2>&1)"
  if printf '%s' "$s4" | command grep -q "Volume e janela OK"; then
    ok "sabotagem 4 ficou VERMELHA (contar bruto FABRICA o veredito — e o que S22 protege)"
  else
    falha "falsificacao4" "contando bruto o veredito nao mudou — S22 nao prova nada"
  fi
fi
cp "$BKPQ2" "$QUERY"; rm -f "$BKPQ2"; trap 'rm -rf "$TMP"' EXIT

echo
if [ "$falhas" -eq 0 ]; then echo "PIPESTATUS-SINAL: TODOS OS TESTES PASSARAM"; exit 0; fi
echo "PIPESTATUS-SINAL: $falhas FALHA(S)"; exit 1

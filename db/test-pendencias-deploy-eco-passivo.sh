#!/usr/bin/env bash
# test-pendencias-deploy-eco-passivo.sh — prova, EXECUTANDO, que a query de `pendencias:deploy`
# enxerga as DUAS vias pelas quais prod diz qual bundle está no ar: a sonda ATIVA (`probe:true`) e
# o ECO PASSIVO (`edge`+`versao` presentes, `probe` ausente).
#
# POR QUE EXISTE: o filtro só aceitava `probe:true`. A `analytics-outbox-drain` respondia 72 vezes
# por janela, com `fonte` idêntico ao mapa commitado, e saía classificada como "⚪ sem sonda na
# janela (ausência de dado)" — cobertura 7/40, abaixo do piso, e um chip inteiro de verificação de
# deploy sobre uma edge que já estava provada no ar. O #2103 nomeou o ponto cego em DOCS; o script
# não acompanhou. Doc não filtra linha: só teste que RODA a query prova que ela filtra.
#
# O SQL não é copiado — é IMPORTADO de `scripts/pendencias-deploy.ts`. Uma cópia aqui viraria uma
# segunda verdade, e a que não tem teste é a que decide errado.
#
# Uso:
#   bash db/test-pendencias-deploy-eco-passivo.sh              # verde = as 2 vias contam
#   bash db/test-pendencias-deploy-eco-passivo.sh --falsificar # sabota o SQL e EXIGE vermelho
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"; PORT=5439
export LC_ALL=C LANG=C  # sem isto o postmaster morre com "became multithreaded during startup"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-pend.XXXXXX")"
DATA="$TMP/data"; SOCK="$TMP"
# shellcheck disable=SC2329  # invocada pelo `trap` abaixo
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

# ------------------------------------------------------- o SQL REAL, não uma cópia ---
SQL_REAL="$TMP/real.sql"
if ! (cd "$RAIZ" && bun -e 'import("./scripts/pendencias-deploy.ts").then((m)=>process.stdout.write(m.SQL))') > "$SQL_REAL" 2>"$TMP/import.err"; then
  echo "VERMELHO — não importei o SQL de scripts/pendencias-deploy.ts:"; cut -c1-300 "$TMP/import.err"; exit 1
fi
# Sonda POSITIVA: import vazio/silencioso viraria suíte verde sobre query nenhuma.
grep -q 'net._http_response' "$SQL_REAL" || { echo "VERMELHO — SQL importado não menciona net._http_response (export sumiu?)"; exit 1; }

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=" -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres pend_verify
P() { "$PGBIN/psql" -p "$PORT" -h "$SOCK" -U postgres -d pend_verify "$@"; }

SHA_OK="b03bbf880f09d2f08d3320def1f7d617506869d063ca0023af65292511c9fded"

# ------------------------------------------------------------------- fixtures ---
# Só o que a query toca: `net._http_response` com status_code/content/created. O schema real do
# pg_net tem mais colunas, e nenhuma delas entra no predicado — arrastá-las aqui seria cenário
# maior sem asserção maior.
P -v ON_ERROR_STOP=1 -q <<SQL
CREATE SCHEMA net;
CREATE TABLE net._http_response (
  id bigserial PRIMARY KEY, status_code int, content text, created timestamptz NOT NULL
);
INSERT INTO net._http_response (status_code, content, created) VALUES
  -- (1) ECO PASSIVO: o caso que a query era cega. Sem 'probe', com edge+versao+fonte.
  (200, '{"ok":true,"drenados":3,"versao":"v1.1-guard","edge":"eco-passivo","fonte":"$SHA_OK"}', '2026-09-04 10:00:00+00'),
  -- (2) o MESMO eco, mais recente: 'julgar' pega a última, o SQL só precisa devolver as duas.
  (200, '{"ok":true,"drenados":0,"versao":"v1.1-guard","edge":"eco-passivo","fonte":"$SHA_OK"}', '2026-09-04 10:05:00+00'),
  -- (3) SONDA ATIVA: não pode regredir ao aceitar o eco.
  (200, '{"ok":true,"probe":true,"versao":"v1.1-cota","edge":"sonda-ativa","fonte":"$SHA_OK"}', '2026-09-04 09:00:00+00'),
  -- (4) eco SEM fonte: tem de CONTAR como observada e sair 'sem-campo' (vira DIVERGE na lib),
  --     nunca sumir — versao certo com fonte ausente é o deploy incompleto da ARMADILHA 2.
  (200, '{"ok":true,"versao":"v1.0","edge":"eco-sem-fonte"}', '2026-09-04 09:30:00+00'),
  -- (5) JSON TRUNCADO que começa com '{': o guard textual tem de barrá-lo ANTES do cast. Sem
  --     isso a query INTEIRA aborta e o cron devolve exit 2 por causa de uma linha alheia.
  (200, '{"edge":"truncada","versao":"v9","fonte":"aaa', '2026-09-04 09:40:00+00'),
  -- (6) não-200: resposta de erro não prova bundle no ar.
  (500, '{"erro":"boom","versao":"v1.0","edge":"caiu","fonte":"$SHA_OK"}', '2026-09-04 09:50:00+00'),
  -- (7) sem 'edge': 'versao' não identifica quem respondeu (o empate de 2026-08-18).
  (200, '{"ok":true,"versao":"v1.0","fonte":"$SHA_OK"}', '2026-09-04 09:55:00+00'),
  -- (8) 'probe' presente com valor que NÃO é true: shape que não emitimos → fica de fora.
  (200, '{"probe":"talvez","versao":"v1.0","edge":"ambigua","fonte":"$SHA_OK"}', '2026-09-04 09:56:00+00'),
  -- (9) corpo que nem começa com '{': o guard mais antigo, preservado.
  (200, 'texto solto com "edge" e "versao" dentro', '2026-09-04 09:57:00+00');
SQL

# Sonda POSITIVA de mecânica, ANTES de qualquer asserção: servidor morto, schema ausente ou
# fixture não semeada devolvem erro em TODA query — inclusive nas sabotadas. Sem este corte, a
# falsificação veria vermelho em tudo e se declararia OK sem ter provado nada: o vermelho seria
# do banco, não da sabotagem. Exige o NÚMERO, não "rodou sem erro" (ausência de dado != prova).
SEMEADAS="$(P -tA -c 'SELECT count(*) FROM net._http_response' 2>/dev/null)"
if [ "$SEMEADAS" != "9" ]; then
  printf 'VERMELHO — MECANICA: esperava 9 fixtures em net._http_response, li "%s".\n' "${SEMEADAS:-<nada>}"
  echo "  Isto nao e veredito sobre a query: e o banco de teste nao estar de pe."
  cut -c1-200 "$TMP/pg.log" 2>/dev/null | tail -5
  exit 2
fi

fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }

# ---------------------------------------------------------------------- suíte ---
# Roda o SQL em $ALVO no MESMO formato do script (`-A -F'|' -t`), então o que se assere é a saída
# que `parsearObservacoes` vai receber de verdade.
suite() {
  local saida rc
  # Mecânica de novo, agora POR RODADA: a suíte roda uma vez por sabotagem × locale, e um banco
  # que caísse no meio transformaria "sabotagem detectada" em "psql não conectou" — a falsificação
  # veria vermelho em tudo e se declararia OK sem ter provado nada.
  if [ "$(P -tA -c 'SELECT 1' 2>/dev/null)" != "1" ]; then
    printf 'MECANICA: psql nao respondeu SELECT 1 — abortando em vez de fabricar veredito\n' >&2
    exit 2
  fi

  saida="$(P -v ON_ERROR_STOP=1 -A -F'|' -t -f "$ALVO" 2>&1)"; rc=$?

  # (5) o guard: query que aborta não tem veredito nenhum, e é o modo de falha CARO.
  if [ "$rc" -ne 0 ]; then
    bad "a query ABORTOU (exit $rc) — corpo não-JSON derrubou a varredura inteira: $(printf '%s' "$saida" | head -1 | cut -c1-90)"
    return
  fi
  ok "a query sobreviveu ao corpo truncado que começa com '{' (guard textual antes do cast)"

  # A ASSERÇÃO CENTRAL. Sem ela o resto é decoração.
  if printf '%s' "$saida" | grep -Fq 'eco-passivo|v1.1-guard|'"$SHA_OK"; then
    ok "ECO PASSIVO conta como observada (edge+versao, 'probe' AUSENTE)"
  else
    bad "eco passivo NÃO voltou — é o bug do #2103: 72 respostas em prod lidas como 'ausência de dado'"
  fi

  if [ "$(printf '%s' "$saida" | grep -Fc 'eco-passivo|')" = "2" ]; then
    ok "as DUAS respostas do mesmo eco voltam (julgar escolhe a mais recente)"
  else
    bad "esperava 2 linhas de eco-passivo, veio $(printf '%s' "$saida" | grep -Fc 'eco-passivo|')"
  fi

  if printf '%s' "$saida" | grep -Fq 'sonda-ativa|v1.1-cota|'"$SHA_OK"
  then ok "SONDA ATIVA continua contando (aceitar o eco não regrediu a via antiga)"
  else bad "sonda ativa sumiu — o fix quebrou a via que já funcionava"; fi

  # O veredito julga o FONTE, não o versao: eco sem fingerprint precisa CHEGAR na lib marcado.
  if printf '%s' "$saida" | grep -Fq 'eco-sem-fonte|v1.0|sem-campo'
  then ok "eco sem 'fonte' volta como 'sem-campo' (vira DIVERGE, não some do relatório)"
  else bad "eco sem 'fonte' não voltou como 'sem-campo' — deploy incompleto sairia invisível"; fi

  # Contrato do parse: 4 campos não-vazios, senão `parsearObservacoes` conta como linha ignorada.
  if [ -z "$(printf '%s' "$saida" | grep -v '^$' | awk -F'|' 'NF!=4 || $1=="" || $2=="" || $3=="" || $4==""')" ]; then
    ok "toda linha tem os 4 campos não-vazios que parsearObservacoes exige"
  else
    bad "alguma linha não casa o contrato de 4 campos"
  fi

  local negativos=0
  for proibido in 'caiu|' 'ambigua|' 'truncada|'; do
    if printf '%s' "$saida" | grep -Fq "$proibido"; then
      bad "voltou o que NÃO devia: $proibido"; negativos=1
    fi
  done
  if [ "$negativos" -eq 0 ]; then ok "não-200, 'probe' ambíguo e corpo truncado ficam de fora"; fi
}

# ------------------------------------------------------------------- execução ---
if [ "${1:-}" != "--falsificar" ]; then
  printf '== pendencias:deploy — as 2 vias (sonda ativa + eco passivo) ==\n'
  ALVO="$SQL_REAL"; suite
  if [ "$fail" -eq 0 ]; then printf '\nECO PASSIVO OK\n'; exit 0; fi
  printf '\nVERMELHO\n'; exit 1
fi

# ---------------------------------------------------------------- falsificação ---
# Verde só vale se o vermelho for alcançável: cada sabotagem reintroduz um defeito REAL e exige
# que a suíte reprove. Sabotagem que não casa o padrão deixa o alvo intacto e a suíte verde —
# falsificação VAZIA, que é o teatro que este bloco existe para pegar; por isso o `cmp`.
printf '== falsificacao (sabota o SQL e EXIGE vermelho) ==\n'
falhou=0
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
[ -n "$utf8" ] || { printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 — metade da cobertura fingindo ser inteira\n'; exit 1; }

sabota() { # <descricao> <expressao-sed>
  local desc="$1" expr="$2" copia="$TMP/sabotado.sql" erro
  erro="$(sed -E "$expr" "$SQL_REAL" 2>&1 >"$copia")"
  if [ -n "$erro" ]; then
    printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:60}"; falhou=1; return
  fi
  if cmp -s "$SQL_REAL" "$copia"; then
    printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, SQL intacto — falsificacao vazia\n' "$desc"; falhou=1; return
  fi
  local viu_vermelho=0 loc
  for loc in C "$utf8"; do
    if ! ( export LC_ALL="$loc"; ALVO="$copia"; fail=0; suite >/dev/null 2>&1; [ "$fail" -eq 0 ] ); then
      viu_vermelho=$((viu_vermelho + 1))
    fi
  done
  if [ "$viu_vermelho" -eq 2 ]; then
    printf '  \033[32mok\033[0m   "%s" -> suite vermelha nos 2 locales\n' "$desc"
  else
    printf '  \033[31mFALHA\033[0m "%s": suite ficou VERDE (%d/2 vermelhos) — assercao frouxa\n' "$desc" "$viu_vermelho"; falhou=1
  fi
}

# (a) O BUG ORIGINAL, de volta: só a sonda ativa conta. É a sabotagem que dá sentido ao arquivo.
sabota "o filtro volta a exigir probe:true (o bug do #2103)" \
  "s/AND \(\(r\.c ->> 'probe'\) = 'true' OR NOT \(r\.c \? 'probe'\)\)/AND (r.c ->> 'probe') = 'true'/"
# (b) A troca NULL-blind: `<> 'true'` parece equivalente e volta a perder a chave AUSENTE.
sabota "eco aceito por <> 'true' (NULL-blind: chave ausente devolve NULL, nao TRUE)" \
  "s/NOT \(r\.c \? 'probe'\)/(r.c ->> 'probe') <> 'true'/"
# (c) O guard que EU adicionei precisa ser carga, não enfeite: sem ele o corpo truncado da linha
#     (5) chega ao cast e derruba a query inteira — o modo de falha que o comentário promete evitar.
sabota "sem o IS JSON OBJECT (corpo truncado chega ao cast)" \
  "/AND content IS JSON OBJECT/d"
# (d) O veredito tem de julgar o FONTE: sem o coalesce, eco sem fingerprint vira campo vazio e
#     `parsearObservacoes` o descarta como linha ignorada — deploy incompleto sai invisível.
sabota "sem o coalesce do fonte (eco sem fingerprint some do relatorio)" \
  "s/coalesce\(r\.c ->> 'fonte', 'sem-campo'\)/r.c ->> 'fonte'/"

if [ "$falhou" -eq 0 ]; then printf '\nFALSIFICACAO OK — todo verde tem vermelho alcancavel\n'; exit 0; fi
printf '\nVERMELHO\n'; exit 1

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
# porta LIVRE automatica: ~30 worktrees rodam harnesses em paralelo e uma porta fixa colide
if [ -n "${PGPORT_TEST:-}" ]; then PORT="$PGPORT_TEST"; else
  PORT=""; for c in $(seq 5471 5520); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/"$c") 2>/dev/null; then PORT=$c; break; else exec 3<&- 3>&-; fi
  done
  [ -n "$PORT" ] || { echo "sem porta livre em 5471-5520"; exit 1; }
fi
SLUG="products-vendas-aposentadoria"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }


# ═════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS  ·  ZONA 2 — MIGRATIONS REAIS (Lei #1)
# Aplica a migration do #1980 (a que criou o check) e DEPOIS a desta entrega.
# Guardar as duas separadas é o que permite a FALSIFICAÇÃO por re-apply: voltar
# à função ANTIGA e exigir que ela seja CEGA ao que a nova enxerga.
# ═════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/prereq-sync-state-saude-20260825.sql"
MIG_ANTIGA="$REPO_ROOT/supabase/migrations/20260824225107_data_health_sync_state_saude.sql"
MIG_NOVA="$REPO_ROOT/supabase/migrations/20260824234500_sync_state_products_vendas_aposenta_writer_truncado.sql"
for m in "$MIG_ANTIGA" "$MIG_NOVA"; do
  [ -f "$m" ] || { echo "migration ausente: $m"; exit 1; }
done
P -q -f "$MIG_ANTIGA"
P -q -f "$MIG_NOVA"
echo "═══ migrations REAIS aplicadas ($(basename "$MIG_NOVA")) ═══"

# ── leitores do check sob teste + asserts de substring (sentinela ASCII, caixa fixa) ──
ck()   { Pq -c "SELECT $1 FROM public._data_health_compute() WHERE source='sync_state_saude';"; }
st()   { ck status; }
msg()  { ck message; }
nlin() { Pq -c "SELECT count(*)::int FROM public._data_health_compute() WHERE source='sync_state_saude';"; }
has()   { case "$2" in *"$3"*) ok "$1";; *) bad "$1 — nao achei [$3] em [$2]";; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1 — achei [$3] e NAO devia";; *) ok "$1";; esac; }

# ── seed do MUNDO DEPOIS desta entrega ──
# products/vendas NAO existe (writer aposentado, linha apagada) e no lugar dele
# entram os marcadores do escritor real, `products_metadados` por empresa.
# ⚠️ `products_metadados` nasce com status 'complete' HARD-CODED na edge — ela
# nunca grava 'error'/'partial'/'running'. Por isso todo seed aqui usa
# 'complete': e o unico status que essa entidade sabe escrever, e e exatamente
# o que deixa o EIXO 1 cego a ela.
seed_base() { P -q <<'SQL'
TRUNCATE public.sync_state;
INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, updated_at, created_at) VALUES
  ('customers','vendas',            'complete', now()-interval '2 hours',    now()-interval '2 hours',    now()),
  ('customers','colacor_vendas',    'complete', now()-interval '2 hours',    now()-interval '2 hours',    now()),
  ('customers','servicos',          'complete', now()-interval '2 hours',    now()-interval '2 hours',    now()),
  ('products','colacor_vendas',     'complete', now()-interval '3 hours',    now()-interval '3 hours',    now()),
  ('products_metadados','oben',     'complete', now()-interval '18 hours',   now()-interval '18 hours',   now()),
  ('products_metadados','colacor',  'complete', now()-interval '18 hours',   now()-interval '18 hours',   now()),
  ('inventory','vendas',            'complete', now()-interval '20 minutes', now()-interval '20 minutes', now()),
  ('inventory','colacor_vendas',    'complete', now()-interval '40 minutes', now()-interval '40 minutes', now()),
  ('inventory','servicos',          'complete', now()-interval '40 minutes', now()-interval '40 minutes', now()),
  -- dormentes/orquestrados por outra via: velhissimos, mas 'complete' ⇒ nao acendem
  ('products','colacor',            'complete', now()-interval '140 days',   now()-interval '140 days',   now()),
  ('products','servicos',           'complete', now()-interval '150 days',   now()-interval '150 days',   now());
SQL
}

echo; echo "═══ A · mundo pos-entrega esta VERDE (products/vendas ausente NAO acende) ═══"
seed_base
eq  "A1 status ok"                    "$(st)"   "ok"
eq  "A2 CONTRATO: exatamente 1 linha" "$(nlin)" "1"
has "A3 message de verde"             "$(msg)"  "todos os marcadores saudaveis"
hasnt "A4 products/vendas nao e mais exigido" "$(msg)" "products/vendas"

echo; echo "═══ B · A COBERTURA NOVA: metadados estagnado (eixo 1 CEGO, so o eixo 2 ve) ═══"
# 40h > SLA de 30h. O status segue 'complete' — e o modo de falha REAL da edge:
# ela lanca no erro e simplesmente nao reescreve o marcador.
seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '40 hours', updated_at=now()-interval '40 hours'
         WHERE entity_type='products_metadados' AND account='oben';"
eq  "B1 broken"                        "$(st)"  "broken"
has "B2 nomeia products_metadados/oben" "$(msg)" "products_metadados/oben (sem sucesso desde"
eq  "B3 ainda 1 linha"                 "$(nlin)" "1"

echo; echo "═══ C · o gemeo colacor tambem e vigiado (nao cobri so metade) ═══"
seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '40 hours', updated_at=now()-interval '40 hours'
         WHERE entity_type='products_metadados' AND account='colacor';"
eq  "C1 broken"                           "$(st)"  "broken"
has "C2 nomeia products_metadados/colacor" "$(msg)" "products_metadados/colacor (sem sucesso desde"

echo; echo "═══ D · products/colacor_vendas segue vigiado (nao quebrei o vizinho) ═══"
seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '40 hours', updated_at=now()-interval '40 hours'
         WHERE entity_type='products' AND account='colacor_vendas';"
eq  "D1 broken"                        "$(st)"  "broken"
has "D2 nomeia products/colacor_vendas" "$(msg)" "products/colacor_vendas (sem sucesso desde"

echo; echo "═══ E · o DELETE da migration realmente apagou o marcador orfao ═══"
# a migration roda com a tabela ja populada pelo prereq; re-aplicar deve ser no-op
P -q -c "INSERT INTO public.sync_state (entity_type, account, status, updated_at, created_at)
         VALUES ('products','vendas','partial', now(), now());"
P -q -f "$MIG_NOVA"
eq "E1 re-apply idempotente apaga de novo" \
   "$(Pq -c "SELECT count(*)::int FROM public.sync_state WHERE entity_type='products' AND account='vendas';")" "0"

# ═════════════════════════════════════════════════════════════════════════════
# ZONA 3 — FALSIFICAÇÃO (Lei #3)
# Sem editar arquivo nenhum: volto a funcao ANTIGA (#1980) e exijo que ela
# ERRE nos dois pontos que esta entrega mudou. Se a antiga acertasse, minhas
# asserções B e A estariam passando por acaso — nao pela mudanca.
# ═════════════════════════════════════════════════════════════════════════════
echo; echo "═══ F · FALSIFICACAO: a funcao ANTIGA tem de ficar VERMELHA onde a nova acerta ═══"
P -q -f "$MIG_ANTIGA"

seed_base
# ISOLAR a variavel: a funcao antiga AINDA exige products/vendas, e sem essa linha
# ela ficaria 'broken' por marcador-ausente — mascarando o que quero medir. Devolvo
# a linha FRESCA, entao a unica anomalia do mundo passa a ser o metadados estagnado.
# (F1 reprovou na 1a rodada exatamente por isso: a assercao media duas coisas.)
P -q -c "INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, updated_at, created_at)
         VALUES ('products','vendas','complete', now()-interval '3 hours', now()-interval '3 hours', now());"
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '40 hours', updated_at=now()-interval '40 hours'
         WHERE entity_type='products_metadados' AND account='oben';"
eq    "F1 antiga e CEGA ao metadados estagnado" "$(st)" "ok"
hasnt "F2 antiga nao nomeia products_metadados" "$(msg)" "products_metadados"

seed_base
eq  "F3 antiga acusa AUSENTE o products/vendas que a nova ignora" "$(st)" "broken"
has "F4 antiga diz marcador AUSENTE" "$(msg)" "products/vendas (marcador AUSENTE"

# restaura a nova (o harness nao pode terminar com a funcao antiga instalada)
P -q -f "$MIG_NOVA"
seed_base
eq "F5 nova reinstalada volta ao verde" "$(st)" "ok"

echo
echo "═══ RESUMO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1

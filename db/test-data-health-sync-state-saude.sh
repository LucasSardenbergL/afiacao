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
PORT="${PGPORT_TEST:-5471}"
SLUG="sync-state-saude"
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

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS  ·  ZONA 2 — MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/prereq-sync-state-saude-20260825.sql"
MIG="$REPO_ROOT/supabase/migrations/20260824225107_data_health_sync_state_saude.sql"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
P -q -f "$MIG"
echo "═══ migration REAL aplicada ($(basename "$MIG")) ═══"

# ── leitores do check sob teste + asserts de substring (sentinela ASCII, caixa fixa) ──
CK="SELECT %s FROM public._data_health_compute() WHERE source='sync_state_saude';"
st()   { Pq -c "$(printf "$CK" status)"; }
msg()  { Pq -c "$(printf "$CK" message)"; }
sev()  { Pq -c "$(printf "$CK" severity)"; }
nlin() { Pq -c "SELECT count(*)::int FROM public._data_health_compute() WHERE source='sync_state_saude';"; }
has()   { case "$2" in *"$3"*) ok "$1";; *) bad "$1 — nao achei [$3] em [$2]";; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1 — achei [$3] e NAO devia";; *) ok "$1";; esac; }

# ── seed: os 8 pares vigiados FRESCOS + 6 dormentes/orquestrados fora da lista ──
seed_base() { P -q <<'SQL'
TRUNCATE public.sync_state;
INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, updated_at, created_at) VALUES
  -- vigiados pelo eixo 2 (SLA proprio), todos dentro do prazo
  ('customers','vendas',        'complete', now()-interval '2 hours',  now()-interval '2 hours',  now()),
  ('customers','colacor_vendas','complete', now()-interval '2 hours',  now()-interval '2 hours',  now()),
  ('customers','servicos',      'complete', now()-interval '2 hours',  now()-interval '2 hours',  now()),
  ('products','vendas',         'complete', now()-interval '3 hours',  now()-interval '3 hours',  now()),
  ('products','colacor_vendas', 'complete', now()-interval '3 hours',  now()-interval '3 hours',  now()),
  ('inventory','vendas',        'complete', now()-interval '20 minutes', now()-interval '20 minutes', now()),
  ('inventory','colacor_vendas','complete', now()-interval '40 minutes', now()-interval '40 minutes', now()),
  ('inventory','servicos',      'complete', now()-interval '40 minutes', now()-interval '40 minutes', now()),
  -- DORMENTES / orquestrados por outra via: fora da lista de estagnacao DE PROPOSITO.
  -- Sao o teste de falso-positivo: velhissimos, mas 'complete' ⇒ nao podem acender NADA.
  ('products','colacor',        'complete', now()-interval '140 days', now()-interval '140 days', now()),
  ('products','servicos',       'complete', now()-interval '150 days', now()-interval '150 days', now()),
  ('pedidos_compra','colacor',  'complete', now()-interval '38 days',  now()-interval '38 days',  now()),
  ('backfill_cadastro','all',   'complete', NULL,                      now()-interval '70 days',  now()),
  ('mapa_consolidacao','all',   'complete', NULL,                      now()-interval '70 days',  now()),
  ('tint_watchdog_corante','oben','complete', now()-interval '1 hour', now()-interval '1 hour',   now());
SQL
}

echo; echo "═══ A · tudo saudavel (inclui 6 dormentes antiquissimos) ═══"
seed_base
eq "A1 status ok"                "$(st)"   "ok"
eq "A2 CONTRATO: exatamente 1 linha" "$(nlin)" "1"
eq "A3 severity literal critical" "$(sev)"  "critical"
has "A4 message de verde"        "$(msg)"  "todos os marcadores saudaveis"
hasnt "A5 dormente 140d NAO acende (falso-positivo)" "$(msg)" "products/colacor"
hasnt "A6 dormente sem last_sync_at NAO acende"      "$(msg)" "backfill_cadastro"

echo; echo "═══ B · EIXO 1 universal: error em entidade FORA da lista ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='boom' WHERE entity_type='tint_watchdog_corante';"
eq  "B1 broken"                  "$(st)"  "broken"
has "B2 nomeia a entidade nao-listada" "$(msg)" "tint_watchdog_corante/oben (falhou)"
eq  "B3 ainda 1 linha"           "$(nlin)" "1"

echo; echo "═══ C · o INCIDENTE real: customers/servicos em error ha 37 dias ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='colisao de codigo na conta colacor_sc',
         last_sync_at=now()-interval '37 days', updated_at=now()-interval '5 minutes'
         WHERE entity_type='customers' AND account='servicos';"
eq  "C1 broken"                  "$(st)"  "broken"
has "C2 nomeia customers/servicos" "$(msg)" "customers/servicos (falhou)"
eq  "C3 1 linha (acende nos DOIS eixos, dedup por DISTINCT ON)" "$(nlin)" "1"
has "C4 last_error propagado"    "$(Pq -c "$(printf "$CK" last_error)")" "colisao de codigo"

echo; echo "═══ D · running orfao vs running fresco ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='running', updated_at=now()-interval '60 days', last_sync_at=NULL
         WHERE entity_type='mapa_consolidacao';"
eq  "D1 running orfao => broken" "$(st)"  "broken"
has "D2 motivo nomeia o preso"   "$(msg)" "mapa_consolidacao/all (preso em running"
seed_base
P -q -c "UPDATE public.sync_state SET status='running', updated_at=now()-interval '10 minutes'
         WHERE entity_type='inventory' AND account='vendas';"
eq  "D3 running FRESCO nao acende" "$(st)" "ok"

echo; echo "═══ E · EIXO 2: handler morre ANTES de gravar status (status limpo, last_sync_at parado) ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='complete', error_message=NULL, last_sync_at=now()-interval '40 hours'
         WHERE entity_type='customers' AND account='vendas';"
eq  "E1 estagnacao com status 'complete' => broken" "$(st)" "broken"
has "E2 motivo e a estagnacao" "$(msg)" "customers/vendas (sem sucesso desde"

echo; echo "═══ F · SLA e POR PAR (cadencias diferentes nao se contaminam) ═══"
seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '20 hours' WHERE entity_type='customers' AND account='vendas';"
eq "F1 customers/vendas 20h < SLA 30h => ok" "$(st)" "ok"
seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '5 hours' WHERE entity_type='inventory' AND account='vendas';"
eq  "F2 inventory/vendas 5h > SLA 3h => broken" "$(st)" "broken"
has "F3 so o inventory acende"  "$(msg)" "inventory/vendas"
hasnt "F4 customers/vendas (2h) fica fora" "$(msg)" "customers/vendas"

echo; echo "═══ G · partial => stale (degrada, nao alarma) · H · marcador ausente ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='partial' WHERE entity_type='products' AND account='vendas';"
eq  "G1 partial => stale"       "$(st)"  "stale"
has "G2 texto de degradado"     "$(msg)" "degradado"
seed_base
P -q -c "DELETE FROM public.sync_state WHERE entity_type='inventory' AND account='servicos';"
eq  "H1 marcador ausente => broken" "$(st)" "broken"
has "H2 motivo AUSENTE"         "$(msg)" "inventory/servicos (marcador AUSENTE"

echo; echo "═══ I · CONTRATO com o watchdog (o check tem de ser AVALIADO, nao so existir) ═══"
eq "I1 source registrado em v_sources" \
   "$(Pq -c "SELECT (position('''sync_state_saude''' in pg_get_functiondef(oid))>0)::int FROM pg_proc WHERE proname='data_health_watchdog';")" "1"
eq "I2 compute inteiro SEM source duplicado (senao o watchdog aborta o laco)" \
   "$(Pq -c "SELECT (count(*)=count(DISTINCT source))::int FROM public._data_health_compute();")" "1"
# cadeia inteira, EXECUTANDO (late-bound: plpgsql so falha em runtime)
seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='colisao de codigo' WHERE entity_type='customers' AND account='servicos';"
P -q -c "TRUNCATE public.fin_alertas; SELECT public.data_health_watchdog();"
eq "I3 watchdog gerou ALERTA ATIVO do check novo" \
   "$(Pq -c "SELECT count(*)::int FROM public.fin_alertas WHERE tipo='data_health_sync_state_saude' AND dismissed_at IS NULL;")" "1"
has "I4 mensagem do alerta nomeia o sync parado" \
    "$(Pq -c "SELECT mensagem FROM public.fin_alertas WHERE tipo='data_health_sync_state_saude' LIMIT 1;")" "customers/servicos"
# resolucao automatica: sync consertado ⇒ o alerta fecha sozinho
seed_base
P -q -c "SELECT public.data_health_watchdog();"
eq "I5 sync consertado => alerta RESOLVIDO automaticamente" \
   "$(Pq -c "SELECT count(*)::int FROM public.fin_alertas WHERE tipo='data_health_sync_state_saude' AND dismissed_at IS NULL;")" "0"

echo; echo "═══ J · FINGERPRINT ESTAVEL (o incidente durou 37 dias: 1 aviso, nao 37 e-mails) ═══"
seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='colisao', last_sync_at=now()-interval '37 days',
         updated_at=now()-interval '30 hours' WHERE entity_type='customers' AND account='servicos';"
J_ANTES="$(msg)"
# o cron roda de novo no dia seguinte e falha de novo: SO o heartbeat avanca
P -q -c "UPDATE public.sync_state SET updated_at=now()-interval '5 minutes' WHERE entity_type='customers' AND account='servicos';"
J_DEPOIS="$(msg)"
eq "J1 message NAO muda com o heartbeat avancando (nao re-emaila)" "$J_DEPOIS" "$J_ANTES"
# mas um SEGUNDO sync quebrando TEM de mudar a message (estabilidade != cegueira)
P -q -c "UPDATE public.sync_state SET status='error', error_message='outro' WHERE entity_type='products' AND account='vendas';"
J_NOVO="$(msg)"
if [ "$J_NOVO" != "$J_ANTES" ]; then ok "J2 problema NOVO muda a message (re-emite)"; else bad "J2 message nao mudou com 2o sync quebrado — alerta cego"; fi
has "J3 message lista os DOIS" "$J_NOVO" "products/vendas (falhou)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3): sabota, EXIGE vermelho, restaura
# ══════════════════════════════════════════════════════════════════════════════
echo; echo "═══ FALSIFICAÇÃO — cada assert tem de ficar VERMELHO com a sabotagem ═══"
SAB="$(mktemp -d)/sab.sql"
# roda um cenario com a migration SABOTADA e devolve o valor observado
sabota() { sed "$1" "$MIG" > "$SAB"; P -q -f "$SAB"; }
restaura() { P -q -f "$MIG"; }   # NAO usa 'git checkout' — o arquivo do repo nunca e tocado
falsifica() { # $1=rotulo $2=sed $3=comando_que_produz_valor $4=valor_verdadeiro
  sabota "$2" >/dev/null 2>&1
  local v; v="$(eval "$3")"
  if [ "$v" = "$4" ]; then bad "FALS $1 — sabotado e o assert SEGUIU VERDE (assert sem dente)"
  else ok "FALS $1 — sabotado => [$v] != [$4] (assert morde)"; fi
  restaura
}

seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='x' WHERE entity_type='tint_watchdog_corante';"
falsifica "eixo 1 (auto-declarado) cego" \
  "s/WHEN ss.status = 'error' THEN 'broken'/WHEN false THEN 'broken'/" 'st' "broken"

seed_base
P -q -c "UPDATE public.sync_state SET last_sync_at=now()-interval '40 hours' WHERE entity_type='customers' AND account='vendas';"
falsifica "eixo 2 (estagnacao) cego" \
  "s/make_interval(hours => req.sla_h)/make_interval(hours => 99999)/" 'st' "broken"

seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='x', last_sync_at=now()-interval '37 days'
         WHERE entity_type='customers' AND account='servicos';"
falsifica "dedup (par acende nos 2 eixos => 2 linhas quebram o watchdog)" \
  "s/SELECT DISTINCT ON (u.entity_type, u.account)/SELECT/" 'nlin' "1"

seed_base
P -q -c "UPDATE public.sync_state SET status='error', error_message='x', updated_at=now()-interval '30 hours'
         WHERE entity_type='customers' AND account='servicos';"
FP_REF="$(msg)"
falsifica "estabilidade do fingerprint (hora corrida na message)" \
  "s/WHEN ss.status = 'error' THEN 'falhou'/WHEN ss.status = 'error' THEN 'falhou ha '||round((EXTRACT(EPOCH FROM now()-ss.updated_at)\/3600.0)::numeric,4)::text||'h'/" \
  'msg' "$FP_REF"

echo; echo "═══ RESUMO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# PROVA — 20261029211738_tint_sync_runs_indices_conjunto_trabalho.sql
#
# Medido em 2026-10-29/30 (psql-ro): tint_promote_sync_run faz 1 seq scan dos 87 MB de
# tint_sync_runs por promoção (~30/h) no somatório do cap de limpezas em 24h — no micro foram
# 455 MB lidos do disco em 10 min. A migration só cria índices + ANALYZE. Esta prova sobe uma
# tint_sync_runs com o FORMATO da prod (132k linhas, ~650 B/linha, ~720 runs nas últimas 24h) e
# assevera, sobre a consulta do cap COPIADA do corpo vivo do promote, em plano GENÉRICO
# (é o que o plpgsql usa depois de 5 execuções):
#
#   CTRL_SEQ    antes da migration o plano é Seq Scan (controle: o assert de índice pode cair)
#   CAP_IDX     depois, o plano usa idx_tint_sync_runs_limpezas_24h e não varre a tabela
#   CAP_BUF     a consulta toca < 300 buffers (antes: a tabela inteira, ~11k)
#   CAP_IGUAL   o somatório é IDÊNTICO ao do seq scan (índice não muda resultado do cap)
#   FRONT_RUNS  TintSyncRuns/TintIntegrations (ORDER BY started_at DESC LIMIT) usam índice
#   FRONT_DASH  TintDashboard (account + sync_type + started_at) usa idx_..._conta_tipo_inicio
#   IDEMP       re-aplicar a migration é no-op (sem erro, 3 índices)
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), depois do controle verde
# NA MESMA invocação, cada uma com o assert que TEM de cair:
#   F1 idx_started_at sobre outra coluna → FRONT_RUNS cai (a postcondição só confere NOME e validade)
#   F2 predicado parcial outro           → a postcondição A2 aborta a migration
# (CAP_IDX já tem o seu controle vermelho: CTRL_SEQ, o mesmo assert sem a migration.)
#
# Uso: db/test-tint-sync-runs-indices.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5461}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-syncruns.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261029211738_tint_sync_runs_indices_conjunto_trabalho.sql"
export LC_ALL=C LANG=C

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

# ── template: tint_sync_runs com as colunas e os índices da prod (psql-ro, 2026-10-30) ──────────
PA -q -d postgres -c "CREATE DATABASE tpl" >/dev/null
PA -q -d tpl <<'SQL' >/dev/null
CREATE TABLE public.tint_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id uuid, account text, store_code text, sync_type text, status text,
  started_at timestamptz, completed_at timestamptz, duration_ms int, total_records int,
  inserts int, updates int, deletes int, errors int, source text, metadata jsonb,
  created_at timestamptz DEFAULT now(), idempotency_key text, idempotency_response jsonb,
  promocao_status text, promocao_tentativas int, promocao_erro text,
  promocao_proxima_em timestamptz, promovido_em timestamptz);
CREATE INDEX idx_tint_sync_runs_setting ON public.tint_sync_runs (setting_id);
CREATE INDEX idx_tint_sync_runs_status ON public.tint_sync_runs (status);
CREATE UNIQUE INDEX idx_tint_sync_runs_idempotency ON public.tint_sync_runs (setting_id, sync_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_tint_sync_runs_promocao_fila ON public.tint_sync_runs (account, store_code, completed_at, id)
  WHERE promocao_status = ANY (ARRAY['pendente','erro']);

-- 132k runs em ~180 dias (~720 nas últimas 24h, ritmo de ~30/h). 1 conta/loja dominante, como na
-- prod (oben/M01); 3% de runs de fórmula; quase todos promovidos com receitas_limpas no metadata.
INSERT INTO public.tint_sync_runs (setting_id, account, store_code, sync_type, status, started_at,
  completed_at, metadata, idempotency_key, idempotency_response, promocao_status, promovido_em)
SELECT '00000000-0000-0000-0000-000000000001', 'oben', 'M01',
       CASE WHEN g % 33 = 0 THEN 'formulas' ELSE 'catalogs' END, 'complete',
       now() - (g * interval '2 minutes'), now() - (g * interval '2 minutes') + interval '20 seconds',
       jsonb_build_object('receitas_limpas', (g % 7 = 0)::int, 'recalculadas', 0),
       md5(g::text), jsonb_build_object('pad', repeat('x', 380)),
       'promovido', now() - (g * interval '2 minutes') + interval '40 seconds'
FROM generate_series(1, 132000) g;
-- legado (antes da fila assíncrona): sem promovido_em e sem receitas_limpas
UPDATE public.tint_sync_runs SET promovido_em = NULL, metadata = '{}'::jsonb
 WHERE started_at < now() - interval '150 days';
VACUUM ANALYZE public.tint_sync_runs;
SQL

# A consulta do cap, COPIADA do corpo vivo de tint_promote_sync_run (pg_get_functiondef, prod
# 2026-10-30) — v_account/v_store viram parâmetros do PREPARE, como no plpgsql.
CAP_PREP="PREPARE cap(text, text) AS
  SELECT COALESCE(sum((tr.metadata->>'receitas_limpas')::int), 0)
  FROM tint_sync_runs tr
  WHERE tr.account = \$1 AND tr.store_code = \$2
    AND COALESCE(tr.promovido_em, tr.started_at) > now() - interval '24 hours'
    AND tr.metadata ? 'receitas_limpas';"

plano_cap() {  # $1 = db; imprime o plano GENÉRICO da consulta do cap
  PA -At -d "$1" -c "SET plan_cache_mode = force_generic_plan;" -c "$CAP_PREP" \
     -c "EXPLAIN (COSTS OFF) EXECUTE cap('oben', 'M01');"
}
buffers_cap() {  # $1 = db; total de buffers (hit+read) da execução
  PA -At -d "$1" -c "SET plan_cache_mode = force_generic_plan;" -c "$CAP_PREP" \
     -c "EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) EXECUTE cap('oben', 'M01');" \
   | grep -m1 'Buffers:' | grep -oE '(hit|read)=[0-9]+' | cut -d= -f2 | awk '{s+=$1} END {print s+0}'
}
soma_cap() {  # $1 = db, $2 = on|off (enable_seqscan); o somatório do cap
  PA -At -d "$1" -c "SET enable_seqscan = $2; SET enable_indexscan = $( [ "$2" = off ] && echo on || echo off ); SET enable_bitmapscan = $( [ "$2" = off ] && echo on || echo off );" \
     -c "$CAP_PREP" -c "EXECUTE cap('oben', 'M01');" | tail -1
}
plano_sql() {  # $1 = db, $2 = sql
  PA -At -d "$1" -c "EXPLAIN (COSTS OFF) $2"
}
aplica() {  # $1 = db, $2 = arquivo — numa transação, como o db:aplicar
  { printf 'BEGIN;\n'; cat "$2"; printf '\nCOMMIT;\n'; } | PA -q -d "$1" >/dev/null 2>"$TMP/aplica.err"
}

FALHOU=0
ok()   { echo "  ok   $1"; }
nok()  { echo "  FAIL $1 — $2"; FALHOU=1; }

# Suíte — $1 = db já com a migration (ou cópia) aplicada. Ecoa os nomes dos asserts que caíram.
suite() {
  local db="$1" p b s1 s2
  p="$(plano_cap "$db")"
  if printf '%s' "$p" | grep -q 'idx_tint_sync_runs_limpezas_24h' && ! printf '%s' "$p" | grep -q 'Seq Scan'; then
    ok CAP_IDX; else nok CAP_IDX "$(printf '%s' "$p" | tr '\n' ' ')"; fi
  b="$(buffers_cap "$db")"
  if [ "$b" -gt 0 ] && [ "$b" -lt 300 ]; then ok "CAP_BUF ($b buffers)"; else nok CAP_BUF "$b buffers"; fi
  s1="$(soma_cap "$db" on)"; s2="$(soma_cap "$db" off)"
  if [ -n "$s1" ] && [ "$s1" = "$s2" ] && [ "$s1" -gt 0 ]; then ok "CAP_IGUAL (soma $s1)"; else nok CAP_IGUAL "seq=$s1 idx=$s2"; fi
  p="$(plano_sql "$db" "SELECT * FROM tint_sync_runs ORDER BY started_at DESC LIMIT 200")"
  if printf '%s' "$p" | grep -q 'Index Scan Backward using idx_tint_sync_runs_started_at'; then
    ok FRONT_RUNS; else nok FRONT_RUNS "$(printf '%s' "$p" | tr '\n' ' ')"; fi
  p="$(plano_sql "$db" "SELECT id, errors FROM tint_sync_runs WHERE account = 'oben' AND sync_type = 'formulas'
                        AND started_at >= now() - interval '30 days' ORDER BY started_at DESC, id LIMIT 1000")"
  if printf '%s' "$p" | grep -q 'idx_tint_sync_runs_conta_tipo_inicio' && ! printf '%s' "$p" | grep -q 'Seq Scan'; then
    ok FRONT_DASH; else nok FRONT_DASH "$(printf '%s' "$p" | tr '\n' ' ')"; fi
}

echo "== controle: sem a migration"
PA -q -d postgres -c "CREATE DATABASE ctrl TEMPLATE tpl" >/dev/null
p="$(plano_cap ctrl)"
if printf '%s' "$p" | grep -q 'Seq Scan on tint_sync_runs'; then ok CTRL_SEQ; else nok CTRL_SEQ "$(printf '%s' "$p" | tr '\n' ' ')"; fi
b0="$(buffers_cap ctrl)"; echo "  info buffers sem índice: $b0"

echo "== migration real"
PA -q -d postgres -c "CREATE DATABASE real TEMPLATE tpl" >/dev/null
if aplica real "$MIG"; then ok APLICA; else nok APLICA "$(cat "$TMP/aplica.err")"; fi
suite real
if aplica real "$MIG" && [ "$(PA -At -d real -c "SELECT count(*) FROM pg_indexes WHERE tablename = 'tint_sync_runs' AND indexname IN ('idx_tint_sync_runs_limpezas_24h','idx_tint_sync_runs_started_at','idx_tint_sync_runs_conta_tipo_inicio')")" = 3 ]; then
  ok IDEMP; else nok IDEMP "$(cat "$TMP/aplica.err")"; fi

[ "$FALHOU" = 0 ] || { echo "RESULTADO: VERMELHO (suíte real) — falsificações não rodam sem controle verde"; exit 1; }

echo "== falsificações"
FALS_OK=1
# F1: idx_started_at sobre completed_at → FRONT_RUNS tem de cair
sed 's/ON public.tint_sync_runs (started_at);/ON public.tint_sync_runs (completed_at);/' "$MIG" > "$TMP/f1.sql"
if cmp -s "$MIG" "$TMP/f1.sql"; then echo "  F1 sabotagem não aplicou (sed sem efeito)"; FALS_OK=0; fi
PA -q -d postgres -c "CREATE DATABASE f1 TEMPLATE tpl" >/dev/null
aplica f1 "$TMP/f1.sql" || { echo "  F1 apply falhou: $(cat "$TMP/aplica.err")"; FALS_OK=0; }
saida="$(FALHOU=0; suite f1)"
if printf '%s\n' "$saida" | grep -q '^  FAIL FRONT_RUNS'; then echo "  ok   F1 (started_at trocado) derrubou FRONT_RUNS"; else echo "  F1 NÃO derrubou FRONT_RUNS"; FALS_OK=0; fi
# F2: predicado parcial diferente → A2 aborta
sed "s/WHERE metadata ? 'receitas_limpas';/WHERE metadata ? 'recalculadas';/" "$MIG" > "$TMP/f2.sql"
if cmp -s "$MIG" "$TMP/f2.sql"; then echo "  F2 sabotagem não aplicou (sed sem efeito)"; FALS_OK=0; fi
PA -q -d postgres -c "CREATE DATABASE f2 TEMPLATE tpl" >/dev/null
if aplica f2 "$TMP/f2.sql"; then echo "  F2 NÃO abortou"; FALS_OK=0
elif grep -q 'A2 FALHOU' "$TMP/aplica.err"; then echo "  ok   F2 (predicado outro) abortou em A2"
else echo "  F2 abortou por outro motivo: $(cat "$TMP/aplica.err")"; FALS_OK=0; fi

[ "$FALS_OK" = 1 ] || { echo "RESULTADO: VERMELHO (falsificação)"; exit 1; }
echo "RESULTADO: VERDE — suíte + 2 falsificações"

#!/usr/bin/env bash
# PROVA — 20261101222916_hot_carimbo_sync_sem_indice.sql (plano v4, lote 14 — B2/B9)
#
# Medido em 2026-11-02 (psql-ro): inventory_position, product_costs e omie_products têm 0 HOT update em
# ~480 k updates — cada uma tem btree NA coluna de carimbo que o sync reescreve em todo ciclo. A migration
# dropa os 3 índices e põe fillfactor 80. Esta prova sobe as 3 tabelas com o FORMATO da prod (colunas,
# índices, nº de linhas, largura de linha), aquece com o estado de HOJE (ff100 + índices), aplica o ARQUIVO
# REAL e continua o ciclo do sync: upsert de todas as linhas em chunks de 500, 1 transação por chunk (como o
# PostgREST), na ordem de chave, VACUUM entre ciclos (o autovacuum da prod roda a cada ciclo). Cenário
# favorável declarado: sem snapshot longo segurando versões mortas.
#
#   CTRL_HOT0   antes da migration, o HOT do ciclo é 0 nas 3 tabelas (controle: o assert de HOT pode cair)
#   DENOM       todo ciclo medido tem n_tup_upd = nº de linhas da tabela (estatística publicada e completa)
#   HOT         depois, o HOT do último ciclo é ≥ 90% nas 3 tabelas
#   WAL         o WAL do último ciclo cai para < 70% do ciclo de controle
#   LINHA       toda linha tem o carimbo do último ciclo e os valores de negócio intactos (md5);
#               um chunk NÃO confirmado mantém o carimbo anterior (a confirmação segue por linha)
#   MAX         max(carimbo) = carimbo do último ciclo
#   IDEMP       re-aplicar a migration é no-op (sem erro)
#   SQLEDITOR   o arquivo roda como 1 query multi-statement (transação implícita do SQL Editor)
#   NOWAIT      com uma tabela ocupada, a migration aborta com 55P03 e NADA muda (nem a 1ª tabela)
#
# Falsificações (cópias da migration em $TMP — o repo nunca é tocado), depois do controle verde NA MESMA
# invocação. GUARDA (pós-condição intacta, a migration TEM de abortar com a marca do ramo):
#   G1 sem o DROP de product_costs                → "POS: product_costs.updated_at ainda indexada"
#   G2 fillfactor 90 em omie_products             → "POS: omie_products sem fillfactor=80"
#   G3 índice parcial novo com WHERE updated_at   → "POS: omie_products.updated_at ainda indexada" (pg_depend)
# CAUSA (pós-condição removida, a medição TEM de cair):
#   C1 sem o DROP de omie_products                → HOT de omie_products < 10%
#   C2 sem fillfactor nenhum                      → HOT de omie_products < 50% (ping-pong)
#
# Uso: db/test-hot-carimbo-sync.sh  (PGPORT_TEST=<porta>)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-${PORT:-5474}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-hot.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261101222916_hot_carimbo_sync_sem_indice.sql"
export LC_ALL=C LANG=C PGTZ=UTC

[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -q -A -t -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

FALHAS=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FALHAS=$((FALHAS + 1)); }

N_INV=3346; N_PC=3805; N_OP=8075   # nº de linhas da prod (psql-ro, 2026-11-02)

# ── template: as 3 tabelas com colunas e índices da prod, ff100 ───────────────────────────────────────
PA -d postgres -c "CREATE DATABASE tpl"
PA -d tpl <<SQL >/dev/null
CREATE TABLE public.inventory_position (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, omie_codigo_produto bigint NOT NULL, product_id uuid,
  saldo numeric DEFAULT 0, cmc numeric DEFAULT 0, preco_medio numeric DEFAULT 0,
  account text DEFAULT 'vendas' NOT NULL, synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX idx_inventory_omie_account ON public.inventory_position (omie_codigo_produto, account);
CREATE UNIQUE INDEX inventory_position_produto_account_uq ON public.inventory_position (omie_codigo_produto, account);
CREATE INDEX idx_inventory_position_synced_at ON public.inventory_position (synced_at);

CREATE TABLE public.product_costs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, product_id uuid NOT NULL UNIQUE, cost_price numeric,
  updated_at timestamptz DEFAULT now() NOT NULL, cmc numeric, cost_source text DEFAULT 'UNKNOWN',
  cost_confidence numeric DEFAULT 0, family_category text, cost_final numeric DEFAULT 0,
  custo_producao numeric, custo_producao_source text, custo_producao_status text,
  custo_producao_computed_at timestamptz);
CREATE INDEX idx_product_costs_updated_at ON public.product_costs (updated_at);

CREATE TABLE public.omie_products (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY, omie_codigo_produto bigint NOT NULL,
  omie_codigo_produto_integracao text, codigo text NOT NULL, descricao text NOT NULL,
  unidade text DEFAULT 'UN' NOT NULL, ncm text, valor_unitario numeric DEFAULT 0 NOT NULL,
  estoque numeric DEFAULT 0, ativo boolean DEFAULT true NOT NULL, imagem_url text,
  metadata jsonb DEFAULT '{}', created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL, familia text, subfamilia text,
  account text DEFAULT 'oben' NOT NULL, is_tintometric boolean DEFAULT false, tint_type text,
  tipo_produto text);
CREATE UNIQUE INDEX omie_products_omie_codigo_produto_account_key ON public.omie_products (omie_codigo_produto, account);
CREATE INDEX idx_omie_products_account_tipo_produto ON public.omie_products (account, tipo_produto) WHERE tipo_produto IS NOT NULL;
CREATE INDEX idx_omie_products_codigo_text_account ON public.omie_products ((omie_codigo_produto::text), lower(account));
CREATE INDEX idx_omie_products_updated_at ON public.omie_products (updated_at);

-- linhas com a largura da prod (pg_stats: ~89 / ~132 / ~590 B)
INSERT INTO public.inventory_position (omie_codigo_produto, product_id, saldo, cmc, preco_medio, account, synced_at)
SELECT g, gen_random_uuid(), g % 300, (g % 977) / 7.0, (g % 977) / 6.0,
       CASE WHEN g % 3 = 0 THEN 'colacor' ELSE 'vendas' END, '2026-11-01 00:00+00'
  FROM generate_series(1, $N_INV) g;
INSERT INTO public.product_costs (product_id, cost_price, cmc, cost_source, cost_confidence, family_category, cost_final, updated_at)
SELECT gen_random_uuid(), (g % 977) / 7.0, (g % 977) / 7.0, 'CMC', 0.7, 'familia ' || (g % 40), (g % 977) / 7.0, '2026-11-01 00:00+00'
  FROM generate_series(1, $N_PC) g;
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, valor_unitario, metadata, account, tipo_produto, familia, updated_at)
SELECT g, 'C' || g, repeat('descricao produto ', 4) || g, g % 997,
       jsonb_build_object('marca', repeat('m', 380), 'g', g),
       CASE WHEN g % 2 = 0 THEN 'oben' ELSE 'colacor' END, CASE WHEN g % 3 = 0 THEN '04' END, 'fam' || (g % 40),
       '2026-11-01 00:00+00'
  FROM generate_series(1, $N_OP) g;
SQL

# Ciclo do sync: as 3 tabelas, chunks de 500 em ordem de chave, 1 statement autocommit por chunk; depois
# VACUUM. $3 = nº de linhas de inventory_position a PULAR no começo (chunk não confirmado; 0 = nenhum).
# Imprime, por tabela: <upd>|<hot> do ciclo e o WAL do ciclo em bytes.
ciclo() {
  local db="$1" stamp="$2" pula="${3:-0}" sql="" off
  sql+="SELECT pg_stat_reset();"$'\n'
  sql+="SELECT pg_current_wal_lsn() AS lsn0 \\gset"$'\n'
  for off in $(seq "$pula" 500 $((N_INV - 1))); do
    sql+="INSERT INTO public.inventory_position AS t (omie_codigo_produto, product_id, saldo, cmc, preco_medio, account, synced_at)
SELECT omie_codigo_produto, product_id, saldo, cmc, preco_medio, account, '$stamp' FROM public.inventory_position
 ORDER BY omie_codigo_produto, account OFFSET $off LIMIT 500
ON CONFLICT (omie_codigo_produto, account) DO UPDATE SET product_id = EXCLUDED.product_id, saldo = EXCLUDED.saldo,
  cmc = EXCLUDED.cmc, preco_medio = EXCLUDED.preco_medio, account = EXCLUDED.account, synced_at = EXCLUDED.synced_at;"$'\n'
  done
  for off in $(seq 0 500 $((N_PC - 1))); do
    sql+="INSERT INTO public.product_costs AS t (product_id, cmc, updated_at)
SELECT product_id, cmc, '$stamp' FROM public.product_costs ORDER BY product_id OFFSET $off LIMIT 500
ON CONFLICT (product_id) DO UPDATE SET cmc = EXCLUDED.cmc, updated_at = EXCLUDED.updated_at;"$'\n'
  done
  for off in $(seq 0 500 $((N_OP - 1))); do
    sql+="INSERT INTO public.omie_products AS t (omie_codigo_produto, omie_codigo_produto_integracao, codigo, descricao,
  unidade, ncm, valor_unitario, ativo, familia, imagem_url, metadata, account, updated_at)
SELECT omie_codigo_produto, omie_codigo_produto_integracao, codigo, descricao, unidade, ncm, valor_unitario, ativo,
       familia, imagem_url, metadata, account, '$stamp' FROM public.omie_products
 ORDER BY omie_codigo_produto, account OFFSET $off LIMIT 500
ON CONFLICT (omie_codigo_produto, account) DO UPDATE SET omie_codigo_produto_integracao = EXCLUDED.omie_codigo_produto_integracao,
  codigo = EXCLUDED.codigo, descricao = EXCLUDED.descricao, unidade = EXCLUDED.unidade, ncm = EXCLUDED.ncm,
  valor_unitario = EXCLUDED.valor_unitario, ativo = EXCLUDED.ativo, familia = EXCLUDED.familia,
  imagem_url = EXCLUDED.imagem_url, metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at;"$'\n'
  done
  sql+="SELECT pg_current_wal_lsn() - :'lsn0'::pg_lsn AS wal \\gset"$'\n'
  sql+="VACUUM public.inventory_position, public.product_costs, public.omie_products;"$'\n'
  sql+="SELECT pg_stat_force_next_flush();"$'\n'
  sql+="SELECT pg_stat_clear_snapshot();"$'\n'
  sql+="SELECT string_agg(relname || '=' || n_tup_upd || '|' || n_tup_hot_upd, ' ' ORDER BY relname) || ' wal=' || :'wal'
  FROM pg_stat_user_tables WHERE relname IN ('inventory_position', 'product_costs', 'omie_products');"$'\n'
  PA -d "$db" <<<"$sql" | tail -1
}

# extrai <upd>|<hot> de uma tabela da linha do ciclo
campo() { tr ' ' '\n' <<<"$1" | sed -n "s/^$2=//p"; }
pct_hot() { local par; par="$(campo "$1" "$2")"; echo $(( ${par#*|} * 100 / ${par%|*} )); }

# Aquecimento com o estado de HOJE (ff100 + índices): 4 ciclos, as linhas já fazem o ping-pong da prod.
for c in 1 2 3 4; do L="$(ciclo tpl "2026-11-01 0$c:00+00")"; done
L_CTRL="$L"
echo "controle (ciclo 4, antes): $L_CTRL"
PA -d postgres -c "ALTER DATABASE tpl IS_TEMPLATE true" >/dev/null

denominador_ok() {
  local linha="$1" esperado_inv="${2:-$N_INV}"
  [ "$(campo "$linha" inventory_position | cut -d'|' -f1)" = "$esperado_inv" ] &&
  [ "$(campo "$linha" product_costs | cut -d'|' -f1)" = "$N_PC" ] &&
  [ "$(campo "$linha" omie_products | cut -d'|' -f1)" = "$N_OP" ]
}

echo "== CONTROLE =="
if denominador_ok "$L_CTRL"; then ok "DENOM controle"; else fail "DENOM controle: $L_CTRL"; fi
for t in inventory_position product_costs omie_products; do
  if [ "$(campo "$L_CTRL" $t | cut -d'|' -f2)" = "0" ]; then ok "CTRL_HOT0 $t"; else fail "CTRL_HOT0 $t: $(campo "$L_CTRL" $t)"; fi
done
WAL_CTRL="$(sed -n 's/.*wal=//p' <<<"$L_CTRL")"

# roda N ciclos pós-migration num db; imprime a linha do último
ciclos_pos() {
  local db="$1" n="$2" c L=""
  for c in $(seq 1 "$n"); do L="$(ciclo "$db" "2026-11-02 $(printf %02d "$c"):00+00")"; echo "    pos c$c: $L" >&2; done
  echo "$L"
}

echo "== MIGRATION REAL (transação implícita, como o SQL Editor) =="
PA -d postgres -c "CREATE DATABASE m TEMPLATE tpl"
if PA -d m -c "$(cat "$MIG")" >"$TMP/apply.log" 2>&1; then ok "SQLEDITOR aplica como 1 query"; else fail "SQLEDITOR: $(cat "$TMP/apply.log")"; fi
if PA -d m -c "$(cat "$MIG")" >"$TMP/apply2.log" 2>&1; then ok "IDEMP re-aplicar"; else fail "IDEMP: $(cat "$TMP/apply2.log")"; fi
L="$(ciclos_pos m 8)"
if denominador_ok "$L"; then ok "DENOM pos"; else fail "DENOM pos: $L"; fi
for t in inventory_position product_costs omie_products; do
  p="$(pct_hot "$L" $t)"
  if [ "$p" -ge 90 ]; then ok "HOT $t = ${p}%"; else fail "HOT $t = ${p}% (< 90)"; fi
done
WAL_POS="$(sed -n 's/.*wal=//p' <<<"$L")"
if [ $((WAL_POS * 100)) -lt $((WAL_CTRL * 70)) ]; then ok "WAL ciclo: $WAL_CTRL -> $WAL_POS bytes"; else fail "WAL ciclo: $WAL_CTRL -> $WAL_POS"; fi
echo "    tamanho (tpl antes -> m depois): $(PA -d tpl -c "SELECT string_agg(relname||'='||pg_total_relation_size(oid), ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('inventory_position','product_costs','omie_products')") -> $(PA -d m -c "SELECT string_agg(relname||'='||pg_total_relation_size(oid), ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('inventory_position','product_costs','omie_products')")"

# LINHA / MAX: valores de negócio intactos e carimbo do último ciclo em TODA linha
NEG_INV="md5(string_agg(omie_codigo_produto||account||coalesce(product_id::text,'')||saldo||cmc||preco_medio, ',' ORDER BY omie_codigo_produto, account))"
NEG_OP="md5(string_agg(omie_codigo_produto||account||codigo||descricao||valor_unitario||metadata::text, ',' ORDER BY omie_codigo_produto, account))"
if [ "$(PA -d tpl -c "SELECT $NEG_INV FROM public.inventory_position")" = "$(PA -d m -c "SELECT $NEG_INV FROM public.inventory_position")" ] &&
   [ "$(PA -d tpl -c "SELECT $NEG_OP FROM public.omie_products")" = "$(PA -d m -c "SELECT $NEG_OP FROM public.omie_products")" ]; then
  ok "LINHA valores de negocio intactos"; else fail "LINHA valores de negocio mudaram"; fi
R="$(PA -d m -c "SELECT (SELECT count(*) FROM public.inventory_position WHERE synced_at = '2026-11-02 08:00+00')
  || '|' || (SELECT count(*) FROM public.product_costs WHERE updated_at = '2026-11-02 08:00+00')
  || '|' || (SELECT count(*) FROM public.omie_products WHERE updated_at = '2026-11-02 08:00+00')")"
if [ "$R" = "$N_INV|$N_PC|$N_OP" ]; then ok "LINHA carimbo do ultimo ciclo em toda linha"; else fail "LINHA carimbo: $R"; fi
L="$(ciclo m "2026-11-02 09:00+00" 500)"
R="$(PA -d m -c "SELECT count(*) FILTER (WHERE synced_at = '2026-11-02 08:00+00') || '|' || count(*) FILTER (WHERE synced_at = '2026-11-02 09:00+00') || '|' || max(synced_at) FROM public.inventory_position")"
if [ "$R" = "500|$((N_INV - 500))|2026-11-02 09:00:00+00" ]; then ok "LINHA chunk nao confirmado mantem o carimbo + MAX"; else fail "LINHA parcial/MAX: $R"; fi

echo "== NOWAIT: tabela ocupada aborta tudo =="
PA -d postgres -c "CREATE DATABASE l TEMPLATE tpl"
PA -d l -c "BEGIN; LOCK TABLE public.omie_products IN ACCESS SHARE MODE; SELECT pg_sleep(8); COMMIT;" >/dev/null 2>&1 &
SEGURA=$!
for _ in $(seq 1 50); do
  [ "$(PA -d l -c "SELECT count(*) FROM pg_locks WHERE relation = 'public.omie_products'::regclass AND granted AND pid <> pg_backend_pid()")" = "1" ] && break
  sleep 0.1
done
if PA -d l -v VERBOSITY=verbose -c "$(cat "$MIG")" >"$TMP/lock.log" 2>&1; then
  fail "NOWAIT: aplicou com a tabela ocupada"
elif grep -q '55P03' "$TMP/lock.log" &&
     [ "$(PA -d l -c "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_inventory_position_synced_at'")" = "1" ]; then
  ok "NOWAIT 55P03 e a 1a tabela intacta"
else fail "NOWAIT: $(cat "$TMP/lock.log")"; fi
wait "$SEGURA" || true

# ── Falsificações ─────────────────────────────────────────────────────────────────────────────────────
[ "$FALHAS" -eq 0 ] || { echo "CONTROLE VERMELHO ($FALHAS) — falsificacoes nao rodam"; exit 1; }

guarda() {   # $1 nome · $2 arquivo mutante · $3 marca esperada no erro
  PA -d postgres -c "CREATE DATABASE $1 TEMPLATE tpl"
  if PA -d "$1" -c "$(cat "$2")" >"$TMP/$1.log" 2>&1; then fail "$1: mutante APLICOU"
  elif grep -qF "$3" "$TMP/$1.log"; then ok "$1 abortou: $3"
  else fail "$1 abortou por outro motivo: $(cat "$TMP/$1.log")"; fi
}
sem_pos() { sed '/^DO \$post\$/,$d' "$1"; }

sed '/DROP INDEX IF EXISTS public.idx_product_costs_updated_at;/d' "$MIG" >"$TMP/g1.sql"
guarda g1 "$TMP/g1.sql" "POS: product_costs.updated_at ainda indexada"
sed 's/ALTER TABLE public.omie_products      SET (fillfactor = 80);/ALTER TABLE public.omie_products SET (fillfactor = 90);/' "$MIG" >"$TMP/g2.sql"
guarda g2 "$TMP/g2.sql" "POS: omie_products sem fillfactor=80"
awk '/^DO \$post\$$/ { print "CREATE INDEX idx_z ON public.omie_products (account) WHERE updated_at IS NOT NULL;" } { print }' "$MIG" >"$TMP/g3.sql"
guarda g3 "$TMP/g3.sql" "POS: omie_products.updated_at ainda indexada por idx_z"

echo "== CAUSA (sem pos-condicao) =="
sem_pos "$MIG" | sed '/DROP INDEX IF EXISTS public.idx_omie_products_updated_at;/d' >"$TMP/c1.sql"
PA -d postgres -c "CREATE DATABASE c1 TEMPLATE tpl"; PA -d c1 -c "$(cat "$TMP/c1.sql")" >/dev/null
L="$(ciclos_pos c1 8 2>/dev/null)"; p="$(pct_hot "$L" omie_products)"
if denominador_ok "$L" && [ "$p" -lt 10 ]; then ok "C1 sem DROP: HOT omie_products = ${p}%"; else fail "C1 nao caiu: $L"; fi
sem_pos "$MIG" | sed '/fillfactor = 80/d' >"$TMP/c2.sql"
PA -d postgres -c "CREATE DATABASE c2 TEMPLATE tpl"; PA -d c2 -c "$(cat "$TMP/c2.sql")" >/dev/null
L="$(ciclos_pos c2 8 2>/dev/null)"; p="$(pct_hot "$L" omie_products)"
if denominador_ok "$L" && [ "$p" -lt 50 ]; then ok "C2 sem fillfactor: HOT omie_products = ${p}% ($L)"; else fail "C2 nao caiu: $L"; fi

if [ "$FALHAS" -eq 0 ]; then echo "PROVA OK — test-hot-carimbo-sync"; else echo "PROVA FALHOU ($FALHAS)"; exit 1; fi

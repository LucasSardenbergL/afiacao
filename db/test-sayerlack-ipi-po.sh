#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261006120000_preco_exato_po_sayerlack_ipi.sql                      ║
# ║  ipi_aliquota_ncm (CHECKs + as 13 medidas), a decomposição em pedido_compra_item   ║
# ║  (CHECK as-4-ou-nenhuma), sayerlack_ipi_itens (NCM do cadastro × tabela, conta da  ║
# ║  empresa) e a RPC sayerlack_aplicar_custo_portal v3: payload = pedido inteiro      ║
# ║  {item_id, qtde_final, valor_mercadoria, valor_ipi}, IPI EXATO em centavos, prova  ║
# ║  contra o total cobrado, custo com IPI + decomposição, CP001–CP004/CP006/CP007,    ║
# ║  paridade com os 29 pedidos reais do arquivo-ouro, falsificação por camada.        ║
# ║      bash db/test-sayerlack-ipi-po.sh > /tmp/t.log 2>&1; echo $?                   ║
# ║  (NAO pipe pra tail — engole o exit!=0.) 2º locale (lição #1483):                 ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-ipi-po.sh                       ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5474}"
SLUG="sayerlack-ipi-po"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN por plataforma (macOS Homebrew / Linux PGDG), major conferida. Fail-closed: PG ausente é ERRO.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG_BASE1="$REPO_ROOT/supabase/migrations/20260905090000_sayerlack_custo_portal_cas.sql"
MIG_BASE2="$REPO_ROOT/supabase/migrations/20260906193522_valor_total_portal_provado.sql"
MIG="$REPO_ROOT/supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql"
OURO="$REPO_ROOT/db/fixtures/sayerlack-ipi-backtest-20261005.json"
for f in "$MIG_BASE1" "$MIG_BASE2" "$MIG" "$OURO"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
# 2º locale (lição #1483): o idioma das mensagens do SERVIDOR; o L0 prova que ele valeu de fato.
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
# -X: sem ~/.psqlrc; só ERROR chega ao cliente (NOTICE é o canal por onde se forja uma linha "ERROR:").
P()  { PGOPTIONS='-c client_min_messages=error' "$PGBIN/psql" -X -v VERBOSITY=default -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# Severidade em C (ERROR) ou pt_BR (ERRO): o 2º locale traduz só o prefixo; a mensagem é nossa e não muda.
linhas_error() { grep -E '^(psql:[^ ]*: )?(ERROR|ERRO|FATAL|PANIC):  |^psql: error: |server closed the connection|connection to server was lost' "$1" | sed -E 's/^psql:[^ ]*: //' | awk 'NR > 1 { printf " ;; " } { printf "%s", $0 }' || true; }

echo "═══ setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ═══"
eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$(Pq -c "SHOW lc_messages")" "$HARNESS_LC"

# ZONA 1 — pré-requisitos (colunas de prod que a migration lê/altera)
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL DEFAULT 'OBEN',
  omie_pedido_compra_numero text,
  status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  portal_protocolo text,
  valor_total numeric DEFAULT 0
);
CREATE TABLE IF NOT EXISTS public.pedido_compra_item (
  id bigint PRIMARY KEY,
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL,
  qtde_final numeric,
  preco_unitario numeric,
  valor_linha numeric
);
CREATE TABLE IF NOT EXISTS public.omie_products (
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL,
  ncm text,
  UNIQUE (omie_codigo_produto, account)
);
-- Em prod o service_role (admin do Supabase) lê estas tabelas; a função de alíquota é SECURITY INVOKER.
GRANT SELECT ON public.pedido_compra_sugerido, public.pedido_compra_item, public.omie_products TO service_role;
SQL

# ZONA 2 — o caminho REAL do SQL Editor: as duas versões anteriores da RPC e, por cima, a migration sob prova.
P -q -f "$MIG_BASE1"
P -q -f "$MIG_BASE2"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE1") + $(basename "$MIG_BASE2") + $(basename "$MIG")"

# ZONA 3 — seed (re-semeável). Números do #3091 (portal 2133415) no pedido 100.
seed() {
P -q <<'SQL'
TRUNCATE public.pedido_compra_item, public.pedido_compra_sugerido, public.omie_products;
INSERT INTO public.pedido_compra_sugerido (id, empresa, omie_pedido_compra_numero, status_envio_portal, portal_protocolo, valor_total) VALUES
  (100, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-100', 0),
  (200, 'OBEN',    '7788', 'sucesso_portal',  'PROTO-200', 0),
  (300, 'OBEN',    NULL,   'enviando_portal', NULL,        0),
  (400, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-400', 0),
  (450, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-450', 0),
  (500, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-500', 0),
  (600, 'OBEN',    NULL,   'sucesso_portal',  'PROTO-600', 0),
  (700, 'COLACOR', NULL,   'sucesso_portal',  'PROTO-700', 0);
INSERT INTO public.pedido_compra_item (id, pedido_id, sku_codigo_omie, qtde_final, preco_unitario, valor_linha) VALUES
  (101, 100, '8689962883', 2,   233.55, 467.10),  -- FC.6902L5, 3208.90.39 (6,5%)
  (102, 100, '8689743214', 1,   275.01, 275.01),  -- WJOI.7585GL, 3208.20.20 (3,25%)
  (201, 200, '8689962883', 1,   10, 10),
  (301, 300, '8689962883', 1,   10, 10),
  (401, 400, '9000000001', 1,   10, 10),          -- NCM 3204.19.20: fora da tabela
  (451, 450, '9000000002', 1,   10, 10),          -- sem produto no cadastro: NCM NULL
  (501, 500, '8689962883', 2.5, 10, 25),          -- quantidade FRACIONÁRIA
  (601, 600, '8690108598', 1,   20, 20),          -- YC.1401VP, 2922.19.19 (0% medido, #2662)
  (701, 700, '9000000003', 1,   10, 10);          -- NCM depende da CONTA: oben 3,25% × colacor 0%
INSERT INTO public.omie_products (omie_codigo_produto, account, ncm) VALUES
  (8689962883, 'oben',    '3208.90.39'),
  (8689962883, 'colacor', '9999.99.99'),          -- conta errada não pode vazar para pedido OBEN
  (8689743214, 'oben',    '3208.20.20'),
  (9000000001, 'oben',    '3204.19.20'),
  (8690108598, 'oben',    '2922.19.19'),
  (9000000003, 'oben',    '3208.10.10'),
  (9000000003, 'colacor', '3214.90.00');
SQL
}
seed
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('22222222-2222-2222-2222-222222222222', 'customer');
-- Sentinelas MINHAS (nunca texto que o código emite), com a SQLSTATE exata; o veredito é o stdout INTEIRO.
CREATE OR REPLACE FUNCTION public.tentar_rpc(p_pedido bigint, p_itens jsonb, p_total numeric)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
DECLARE n int;
BEGIN
  n := public.sayerlack_aplicar_custo_portal(p_pedido, p_itens, p_total);
  RETURN 'RPC_OK_' || n;
EXCEPTION WHEN OTHERS THEN
  RETURN 'RPC_ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.tentar_rpc(bigint, jsonb, numeric) TO PUBLIC;
CREATE OR REPLACE FUNCTION public.tentar_sql(p_cmd text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
BEGIN
  EXECUTE p_cmd;
  RETURN 'SQL_OK';
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQL_ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.tentar_sql(text) TO PUBLIC;
SQL
rpc() { # $1 = argumentos da chamada · $2 = preâmbulo opcional (SET ROLE / GUC)
  local out rc=0
  out="$(printf '%s\nSELECT public.tentar_rpc(%s);\n' "${2:-}" "$1" | P -q -tA 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; else printf 'RPC_SEM_MEDICAO_rc%s' "$rc"; fi
}
sql() { # $1 = comando (sem aspas simples externas) · $2 = preâmbulo opcional
  local out rc=0
  # shellcheck disable=SC2016  # $c$ é o dollar-quote do Postgres: literal de propósito, não expansão do shell
  out="$(printf '%s\nSELECT public.tentar_sql($c$%s$c$);\n' "${2:-}" "$1" | P -q -tA 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; else printf 'SQL_SEM_MEDICAO_rc%s' "$rc"; fi
}
# "id:preco_unitario/valor_linha/sem_ipi/ipi/aliquota/ncm,...|valor_total" — ø = NULL.
estado() { Pq -c "SELECT string_agg(i.id||':'||coalesce(trim_scale(round(i.preco_unitario,4))::text,'ø')||'/'||coalesce(trim_scale(round(i.valor_linha,4))::text,'ø')||'/'||coalesce(trim_scale(round(i.preco_unitario_sem_ipi_portal,4))::text,'ø')||'/'||coalesce(trim_scale(i.valor_ipi_portal)::text,'ø')||'/'||coalesce(trim_scale(i.aliquota_ipi_portal)::text,'ø')||'/'||coalesce(i.ncm_ipi_portal,'ø'), ',' ORDER BY i.id)||'|'||trim_scale(p.valor_total) FROM public.pedido_compra_sugerido p JOIN public.pedido_compra_item i ON i.pedido_id=p.id WHERE p.id=$1 GROUP BY p.valor_total;"; }
provado() { Pq -c "SELECT coalesce(trim_scale(valor_total_portal_provado)::text,'ø')||'|'||coalesce(valor_total_portal_provado_protocolo,'ø')||'|'||CASE WHEN valor_total_portal_provado_em IS NULL THEN 'sem-ts' ELSE 'com-ts' END FROM public.pedido_compra_sugerido WHERE id=$1"; }
aliq() { Pq -c "SELECT coalesce(string_agg(item_id||'|'||coalesce(ncm,'ø')||'|'||coalesce(trim_scale(aliquota_pct)::text,'ø'), ',' ORDER BY item_id), '') FROM public.sayerlack_ipi_itens($1)"; }
SEM_PROVA='ø|ø|sem-ts'
ITENS_100='[{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75},{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}]'
INTACTO_100='101:233.55/467.1/ø/ø/ø/ø,102:275.01/275.01/ø/ø/ø/ø|0'
GRAVADO_100='101:227.31/454.62/213.435/27.75/6.5/32089039,102:250.12/250.12/242.25/7.87/3.25/32082020|704.74'

echo "── asserts ──"
# T1 — as 13 alíquotas medidas, 4 confirmadas por NF.
eq "T1 seed: 13 linhas, 4 de NF, valores do backtest" "$(Pq -c "SELECT count(*)||'|'||count(*) FILTER (WHERE fonte='nf')||'|'||string_agg(ncm||'='||trim_scale(aliquota_pct), ',' ORDER BY ncm) FROM public.ipi_aliquota_ncm")" "13|4|29153999=0,29221919=0,32041210=0,32081010=3.25,32081020=3.25,32082019=3.25,32082020=3.25,32089039=6.5,32129090=6.5,32141020=1.3,32149000=0,38089219=0,38140090=6.5"

# T2 — CHECKs da tabela (SQLSTATE 23514), com controle positivo (CHECK que recusa tudo seria teatro).
for caso in \
  "ncm_pontuado|'3208.10.10', 3.25, 'nf', 'x'" \
  "ncm_7_digitos|'3208101', 3.25, 'nf', 'x'" \
  "aliquota_nan|'11111111', 'NaN', 'nf', 'x'" \
  "aliquota_inf|'11111112', 'Infinity', 'nf', 'x'" \
  "aliquota_negativa|'11111113', -1, 'nf', 'x'" \
  "aliquota_100|'11111114', 100, 'nf', 'x'" \
  "aliquota_3_casas|'11111115', 3.255, 'nf', 'x'" \
  "fonte_invalida|'11111116', 1, 'chute', 'x'" \
  "evidencia_branca|'11111117', 1, 'nf', '   '"; do
  nome="${caso%%|*}"; vals="${caso#*|}"
  eq "T2 tabela recusa $nome" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ($vals, '2026-10-05')")" "SQL_ERR_23514"
done
eq "T2 controle: alíquota válida de 2 casas entra" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ('11111118', 9.75, 'nf', 'NF teste', '2026-10-05')")" "SQL_OK"
P -q -c "DELETE FROM public.ipi_aliquota_ncm WHERE ncm = '11111118'"

# T3 — CHECK da decomposição no item (as 4 ou nenhuma; faixa de cada uma), com controle positivo.
seed
for caso in \
  "so_o_ipi|valor_ipi_portal = 1" \
  "ipi_negativo|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = -0.01, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "sem_ipi_zero|preco_unitario_sem_ipi_portal = 0, valor_ipi_portal = 1, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "ipi_nan|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 'NaN', aliquota_ipi_portal = 3.25, ncm_ipi_portal = '32082020'" \
  "ncm_pontuado|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 1, aliquota_ipi_portal = 3.25, ncm_ipi_portal = '3208.20.20'" \
  "aliquota_100|preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 1, aliquota_ipi_portal = 100, ncm_ipi_portal = '32082020'"; do
  nome="${caso%%|*}"; set_="${caso#*|}"
  eq "T3 item recusa $nome" "$(sql "UPDATE public.pedido_compra_item SET $set_ WHERE id = 101")" "SQL_ERR_23514"
done
eq "T3 controle: IPI 0 medido (as 4 preenchidas) entra" "$(sql "UPDATE public.pedido_compra_item SET preco_unitario_sem_ipi_portal = 1, valor_ipi_portal = 0, aliquota_ipi_portal = 0, ncm_ipi_portal = '32149000' WHERE id = 101")" "SQL_OK"

# L1 — sayerlack_ipi_itens: NCM só dígitos, conta da empresa, NULL quando não sabe.
seed
eq "L1 pedido 100: NCM normalizado e alíquota da tabela" "$(aliq 100)" "101|32089039|6.5,102|32082020|3.25"
eq "L1 NCM fora da tabela ⇒ alíquota NULL" "$(aliq 400)" "401|32041920|ø"
eq "L1 produto fora do cadastro ⇒ NCM e alíquota NULL" "$(aliq 450)" "451|ø|ø"
eq "L1 pedido COLACOR lê o NCM da conta colacor" "$(aliq 700)" "701|32149000|0"
eq "L1 pedido inexistente ⇒ nenhuma linha" "$(aliq 999)" ""

# A1 — caminho feliz (#3091): 426,87 × 6,5% = 27,75 e 242,25 × 3,25% = 7,87; Σ = 704,74 = cobrado.
seed
eq "A1 grava os 2 itens" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
eq "A1 custo com IPI + decomposição + valor_total = Σ valor_linha" "$(estado 100)" "$GRAVADO_100"
eq "A1 provado em coluna dedicada" "$(provado 100)" "704.74|PROTO-100|com-ts"
# A2 — re-captura antes do PO (reenvio): aceita e regrava igual.
eq "A2 re-chamada com omie ainda NULL é aceita" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
eq "A2 estado idêntico" "$(estado 100)" "$GRAVADO_100"
# A3 — 0% medido (#2662): IPI 0 explícito, não ausente.
seed
eq "A3 item a 0% grava" "$(rpc "600, '[{\"item_id\":601,\"qtde_final\":1,\"valor_mercadoria\":13.7103,\"valor_ipi\":0}]'::jsonb, 13.71")" "RPC_OK_1"
eq "A3 IPI 0 medido gravado com a alíquota 0 e o NCM" "$(estado 600)" "601:13.71/13.71/13.71/0/0/29221919|13.71"
# A4 — a alíquota é a da conta do PEDIDO: COLACOR ⇒ 0% (a OBEN seria 3,25%).
seed
eq "A4 COLACOR aceita IPI 0" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_OK_1"
seed
eq "A4 COLACOR recusa o IPI da conta OBEN (3,25)" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":3.25}]'::jsonb, 103.25")" "RPC_ERR_CP007"
# A5 — tolerância de 2 linhas = 0,0252: 2 centavos passam, 3 não.
seed
eq "A5 cobrado 704,76 (delta 0,02) passa" "$(rpc "100, '$ITENS_100'::jsonb, 704.76")" "RPC_OK_2"
seed
eq "A5 cobrado 704,77 (delta 0,03) reprova" "$(rpc "100, '$ITENS_100'::jsonb, 704.77")" "RPC_ERR_CP007"
eq "A5 nada gravado no reprovado" "$(estado 100)" "$INTACTO_100"
eq "A5 nem o provado" "$(provado 100)" "$SEM_PROVA"

# N1 CP002 — PO Omie já existe (payload VÁLIDO: só o CAS o barra).
seed
eq "N1 PO Omie existente → CP002" "$(rpc "200, '[{\"item_id\":201,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP002"
# N2 CP003 — status ≠ sucesso_portal e pedido inexistente.
eq "N2 enviando_portal → CP003" "$(rpc "300, '[{\"item_id\":301,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP003"
eq "N2 pedido inexistente → CP003" "$(rpc "999, '[{\"item_id\":1,\"qtde_final\":1,\"valor_mercadoria\":1,\"valor_ipi\":0}]'::jsonb, 1")" "RPC_ERR_CP003"
# N3 CP001 — payload. O "ipi_ausente" é o verde-por-ausência: jsonb_typeof(NULL) <> 'number' daria NULL.
I102='{"item_id":102,"qtde_final":1,"valor_mercadoria":242.247,"valor_ipi":7.87}'
for caso in \
  "vazio|100, '[]'::jsonb, 704.74" \
  "payload_antigo|100, '[{\"item_id\":101,\"preco_unitario\":227.31,\"valor_linha\":454.62},{\"item_id\":102,\"preco_unitario\":250.12,\"valor_linha\":250.12}]'::jsonb, 704.74" \
  "qtde_texto|100, '[{\"item_id\":101,\"qtde_final\":\"2\",\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "mercadoria_nan_texto|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":\"NaN\",\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "mercadoria_zero|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":0,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74" \
  "ipi_negativo|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":-0.01},$I102]'::jsonb, 704.74" \
  "ipi_ausente|100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652},$I102]'::jsonb, 704.74" \
  "nao_array|100, '{\"item_id\":101}'::jsonb, 704.74" \
  "total_nan|100, '$ITENS_100'::jsonb, 'NaN'::numeric" \
  "total_inf|100, '$ITENS_100'::jsonb, 'Infinity'::numeric" \
  "total_zero|100, '$ITENS_100'::jsonb, 0" \
  "id_texto|100, '[{\"item_id\":\"abc\",\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74"; do
  nome="${caso%%|*}"; args="${caso#*|}"
  eq "N3 payload $nome → CP001" "$(rpc "$args")" "RPC_ERR_CP001"
done
eq "N3 nada gravado em nenhum caso" "$(estado 100)" "$INTACTO_100"
# N4 CP004 — o pedido inteiro, nada alheio, quantidade ecoada e inteira.
I101='{"item_id":101,"qtde_final":2,"valor_mercadoria":426.8652,"valor_ipi":27.75}'
for caso in \
  "id_repetido|100, '[$I101,$I101]'::jsonb, 908.98" \
  "item_faltando|100, '[$I101]'::jsonb, 454.62" \
  "item_de_outro_pedido|100, '[$I101,{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":10,\"valor_ipi\":0}]'::jsonb, 464.62" \
  "id_inexistente|100, '[$I101,{\"item_id\":9999,\"qtde_final\":1,\"valor_mercadoria\":10,\"valor_ipi\":0}]'::jsonb, 464.62" \
  "qtde_ecoada_divergente|100, '[{\"item_id\":101,\"qtde_final\":3,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.75},$I102]'::jsonb, 704.74"; do
  nome="${caso%%|*}"; args="${caso#*|}"
  eq "N4 $nome → CP004" "$(rpc "$args")" "RPC_ERR_CP004"
done
eq "N4 nada gravado" "$(estado 100)" "$INTACTO_100"
eq "N4 qtde_final fracionária na linha → CP004" "$(rpc "500, '[{\"item_id\":501,\"qtde_final\":2.5,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_ERR_CP004"
eq "N4 fracionária: nada gravado" "$(estado 500)" "501:10/25/ø/ø/ø/ø|0"
# N5 CP006 — sem alíquota: NCM fora da tabela e produto fora do cadastro. Nada gravado, nem o provado.
eq "N5 NCM fora da tabela → CP006" "$(rpc "400, '[{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP006"
eq "N5 produto sem cadastro → CP006" "$(rpc "450, '[{\"item_id\":451,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP006"
eq "N5 ROLLBACK do provado" "$(provado 400)" "$SEM_PROVA"
# N6 CP007 — IPI 1 centavo a menos (o total ainda fecharia: só a igualdade EXATA pega).
eq "N6 IPI 27,74 ≠ 27,75 → CP007" "$(rpc "100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.74},$I102]'::jsonb, 704.73")" "RPC_ERR_CP007"
eq "N6 nada gravado" "$(estado 100)" "$INTACTO_100"

# P — privilégio da RPC e da função de alíquota.
eq "P1 authenticated sem EXECUTE na RPC → 42501" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE authenticated;")" "RPC_ERR_42501"
eq "P2 anon sem EXECUTE na RPC → 42501" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE anon;")" "RPC_ERR_42501"
eq "P3 service_role executa a RPC" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET ROLE service_role;")" "RPC_OK_2"
seed
eq "P4 uid customer → 42501 (gate no corpo)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "RPC_ERR_42501"
eq "P5 authenticated não lê as alíquotas → 42501" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE authenticated;")" "SQL_ERR_42501"
eq "P5 anon não lê as alíquotas → 42501" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE anon;")" "SQL_ERR_42501"
eq "P5 service_role lê as alíquotas" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE service_role;")" "SQL_OK"
# O 42501 acima tem DUAS camadas (EXECUTE da função e SELECT da tabela, porque a função é SECURITY INVOKER): cada uma
# segura o comportamento sozinha. Por isso cada camada tem a sua asserção de catálogo, e é ela que a falsificação morde.
eq "P5e anon/authenticated sem EXECUTE em sayerlack_ipi_itens (catálogo)" "$(Pq -c "SELECT has_function_privilege('anon', 'public.sayerlack_ipi_itens(bigint)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.sayerlack_ipi_itens(bigint)', 'EXECUTE')")" "f"
eq "P5t anon/authenticated sem SELECT em ipi_aliquota_ncm (catálogo)" "$(Pq -c "SELECT has_table_privilege('anon', 'public.ipi_aliquota_ncm', 'SELECT') OR has_table_privilege('authenticated', 'public.ipi_aliquota_ncm', 'SELECT')")" "f"

# C1 — corrida com o PO Omie (o CAS re-avalia o predicado depois do commit concorrente).
seed
P -q -c "BEGIN; UPDATE public.pedido_compra_sugerido SET omie_pedido_compra_numero='PO-CORRIDA' WHERE id=100; SELECT pg_sleep(1.5); COMMIT;" &
A_PID=$!
sleep 0.4
R=$(rpc "100, '$ITENS_100'::jsonb, 704.74"); wait "$A_PID"
eq "C1 corrida com o PO Omie → CP002" "$R" "RPC_ERR_CP002"

# G1 — paridade com o arquivo-ouro: os 29 pedidos reais gravam e o IPI do SQL = o do gerador (e o do TS, Task 3).
seed
P -q -v ouro="$(cat "$OURO")" <<'SQL'
CREATE TABLE IF NOT EXISTS public.prova_ouro_doc (doc jsonb);
TRUNCATE public.prova_ouro_doc;
INSERT INTO public.prova_ouro_doc VALUES (:'ouro'::jsonb);
CREATE OR REPLACE FUNCTION public.prova_ouro() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  d jsonb := (SELECT doc FROM public.prova_ouro_doc);
  ped jsonb; lin jsonb; v_payload jsonb; v_res text; v_item bigint; v_seq int;
  v_n int := 0; v_ok int := 0; v_ipi_div int := 0; v_vt_div int := 0; v_erros text := '';
BEGIN
  FOR ped IN SELECT * FROM jsonb_array_elements(d->'pedidos') LOOP
    v_n := v_n + 1; v_payload := '[]'::jsonb; v_seq := 0;
    INSERT INTO public.pedido_compra_sugerido (id, empresa, status_envio_portal, portal_protocolo, valor_total)
      VALUES ((ped->>'pedido_id')::bigint, 'OBEN', 'sucesso_portal', 'OURO-' || (ped->>'pedido_id'), 0);
    FOR lin IN SELECT * FROM jsonb_array_elements(ped->'linhas') LOOP
      v_seq := v_seq + 1;
      v_item := (ped->>'pedido_id')::bigint * 100 + v_seq;
      INSERT INTO public.pedido_compra_item (id, pedido_id, sku_codigo_omie, qtde_final, preco_unitario, valor_linha)
        VALUES (v_item, (ped->>'pedido_id')::bigint, lin->>'sku_codigo_omie', (lin->>'qtde_final')::numeric, 1, 1);
      INSERT INTO public.omie_products (omie_codigo_produto, account, ncm)
        VALUES ((lin->>'sku_codigo_omie')::bigint, 'oben', lin->>'ncm') ON CONFLICT DO NOTHING;
      v_payload := v_payload || jsonb_build_array(jsonb_build_object('item_id', v_item, 'qtde_final', lin->'qtde_final',
        'valor_mercadoria', lin->'preco_venda', 'valor_ipi', lin->'ipi'));
    END LOOP;
    v_res := public.tentar_rpc((ped->>'pedido_id')::bigint, v_payload, (ped->>'total_json')::numeric);
    IF v_res = 'RPC_OK_' || jsonb_array_length(ped->'linhas') THEN v_ok := v_ok + 1;
    ELSE v_erros := v_erros || (ped->>'pedido_id') || ':' || v_res || ' '; END IF;
    v_ipi_div := v_ipi_div + (SELECT count(*) FROM jsonb_array_elements(ped->'linhas') WITH ORDINALITY AS l(lin, ord)
      JOIN public.pedido_compra_item i ON i.id = (ped->>'pedido_id')::bigint * 100 + l.ord
     WHERE i.valor_ipi_portal IS DISTINCT FROM (l.lin->>'ipi')::numeric);
    v_vt_div := v_vt_div + (SELECT count(*) FROM public.pedido_compra_sugerido p
     WHERE p.id = (ped->>'pedido_id')::bigint AND p.valor_total IS DISTINCT FROM (ped->>'total_modelado')::numeric);
  END LOOP;
  RETURN format('pedidos=%s ok=%s ipi_divergente=%s vt_divergente=%s erros=[%s]', v_n, v_ok, v_ipi_div, v_vt_div, trim(v_erros));
END $f$;
SQL
eq "G1 os 29 pedidos reais: todos gravam, IPI e valor_total batem com o ouro" "$(Pq -c "SELECT public.prova_ouro()")" "pedidos=29 ok=29 ipi_divergente=0 vt_divergente=0 erros=[]"

# ZONA 5 — FALSIFICAÇÃO: uma camada por vez, o vermelho CERTO, restaura com a migration REAL.
echo "── falsificação ──"
SAB="$(dirname "$DATA")/sab.sql"
sabota() {
  sed -e "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then echo "  ❌ sabotagem NÃO casou o padrão ($1) — falsificação seria teatro"; FAIL=$((FAIL+1)); return 1; fi
  P -q -f "$SAB"
}
# seed ANTES de reaplicar: uma sabotagem de CHECK (F10) deixa linha que o CHECK real recusaria no ADD CONSTRAINT.
restaura() { seed; P -q -f "$MIG"; seed; }
dente() { if [ "$2" = "$3" ]; then ok "$1 (sabotado ⇒ $2)"; else bad "$1 — sabotado devia dar [$3], veio [$2]"; fi; }

seed; sabota 's/AND p\.omie_pedido_compra_numero IS NULL/AND true/'
dente "F1 sem o CAS de omie, grava com PO existente (N1)" "$(rpc "200, '[{\"item_id\":201,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_OK_1"
restaura
sabota 's/IF v_sem_aliquota IS NOT NULL THEN/IF false THEN/'
dente "F2 sem o CP006, a camada de baixo (prova) recusa como CP007 (N5)" "$(rpc "400, '[{\"item_id\":401,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP007"
restaura
sabota 's/count(\*) FILTER (WHERE c\.ipi_payload IS DISTINCT FROM c\.ipi)/0::bigint/'
dente "F3 sem a igualdade exata do IPI, 27,74 passa (N6)" "$(rpc "100, '[{\"item_id\":101,\"qtde_final\":2,\"valor_mercadoria\":426.8652,\"valor_ipi\":27.74},$I102]'::jsonb, 704.73")" "RPC_OK_2"
restaura
sabota 's/abs(v_total_modelado - p_valor_total) > v_tolerancia/false/'
dente "F4 sem a tolerância, 3 centavos passam (A5)" "$(rpc "100, '$ITENS_100'::jsonb, 704.77")" "RPC_OK_2"
restaura
sabota 's/IF v_n <> v_itens_total OR v_pertencem <> v_n THEN/IF false THEN/'
dente "F5 sem a cobertura, metade do pedido grava (N4 item_faltando)" "$(rpc "100, '[$I101]'::jsonb, 454.62")" "RPC_OK_1"
restaura
sabota 's/ AND i\.qtde_final = c\.qtde_eco AND i\.qtde_final = trunc(i\.qtde_final)//'
dente "F6 sem a conferência de quantidade, a fracionária grava (N4)" "$(rpc "500, '[{\"item_id\":501,\"qtde_final\":2.5,\"valor_mercadoria\":100,\"valor_ipi\":6.5}]'::jsonb, 106.5")" "RPC_OK_1"
restaura
sabota 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_ipi_itens(bigint) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO authenticated;/; /POST FALHOU: anon\/authenticated executam sayerlack_ipi_itens/s/RAISE EXCEPTION/RAISE NOTICE/'
dente "F7 com GRANT a authenticated, o EXECUTE da função de alíquota abre (P5e)" "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.sayerlack_ipi_itens(bigint)', 'EXECUTE')")" "t"
# A camada de baixo segura o comportamento sozinha: com o EXECUTE aberto, a leitura ainda cai no SELECT da tabela.
dente "F7 a camada da tabela segura sozinha (P5 continua 42501)" "$(sql "SELECT * FROM public.sayerlack_ipi_itens(100)" "SET ROLE authenticated;")" "SQL_ERR_42501"
restaura
sabota 's/REVOKE ALL ON public\.ipi_aliquota_ncm FROM anon, authenticated;/GRANT SELECT ON public.ipi_aliquota_ncm TO authenticated;/'
dente "F7t com GRANT SELECT a authenticated, a tabela de alíquotas abre (P5t)" "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.ipi_aliquota_ncm', 'SELECT')")" "t"
restaura
# F7b — a postcondição aborta o apply sabotado, e o aborto é DELA (a linha ERROR exata).
sed -e 's/REVOKE EXECUTE ON FUNCTION public\.sayerlack_ipi_itens(bigint) FROM anon, authenticated;/GRANT EXECUTE ON FUNCTION public.sayerlack_ipi_itens(bigint) TO authenticated;/' "$MIG" > "$SAB"
if cmp -s "$MIG" "$SAB"; then
  bad "F7b sabotagem NÃO casou o REVOKE — falsificação seria teatro"
elif P -q -f "$SAB" >/dev/null 2>"$SAB.err"; then
  bad "F7b postcondição NÃO abortou com authenticated executando sayerlack_ipi_itens"
else
  F7B="$(linhas_error "$SAB.err")"
  case "$F7B" in
    "ERROR:  POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou"|\
    "ERRO:  POST FALHOU: anon/authenticated executam sayerlack_ipi_itens — REVOKE por nome não pegou")
      ok "F7b postcondição aborta o apply com a função de alíquota aberta" ;;
    *) bad "F7b ERRO ALHEIO à postcondição — veio [${F7B:-<nenhuma linha ERROR>}]" ;;
  esac
fi
restaura
sabota 's/IF auth\.uid() IS NOT NULL$/IF false/'
dente "F8 sem o gate de papel, customer grava (P4)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "RPC_OK_2"
restaura
sabota 's/CHECK (aliquota_pct >= 0 AND aliquota_pct < 100 AND aliquota_pct = round(aliquota_pct, 2))/CHECK (true)/'
dente "F9 sem o CHECK de faixa, NaN entra na tabela (T2)" "$(sql "INSERT INTO public.ipi_aliquota_ncm (ncm, aliquota_pct, fonte, evidencia, medido_em) VALUES ('11111111', 'NaN', 'nf', 'x', '2026-10-05')")" "SQL_OK"
P -q -c "DELETE FROM public.ipi_aliquota_ncm WHERE ncm = '11111111'"
restaura
sabota 's/num_nulls(preco_unitario_sem_ipi_portal, valor_ipi_portal, aliquota_ipi_portal, ncm_ipi_portal) IN (0, 4)/true/'
dente "F10 sem o as-4-ou-nenhuma, o IPI sozinho entra (T3)" "$(sql "UPDATE public.pedido_compra_item SET valor_ipi_portal = 1 WHERE id = 101")" "SQL_OK"
restaura
sabota "s/AND op\.account = lower(s\.empresa)/AND op.account = 'oben'/"
dente "F11 conta fixa em oben: o COLACOR passa a exigir 3,25% (A4)" "$(rpc "700, '[{\"item_id\":701,\"qtde_final\":1,\"valor_mercadoria\":100,\"valor_ipi\":0}]'::jsonb, 100")" "RPC_ERR_CP007"
restaura
sabota 's/ AND op\.account = lower(s\.empresa)//'
dente "F12 sem filtro de conta, o NCM da colacor vaza no pedido OBEN (A1)" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_ERR_CP006"
restaura
# Controle: a migration REAL re-aplicada segue verde nos asserts centrais.
eq "FC controle: N4 volta a CP004" "$(rpc "100, '[$I101]'::jsonb, 454.62")" "RPC_ERR_CP004"
eq "FC controle: A1 volta a gravar" "$(rpc "100, '$ITENS_100'::jsonb, 704.74")" "RPC_OK_2"
rm -f "$SAB" "$SAB.err"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

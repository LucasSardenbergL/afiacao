#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261014120000_sayerlack_importar_pedido_portal.sql                  ║
# ║  Importar pedido digitado direto no portal Sayerlack: de-para inverso, quantidade  ║
# ║  inteira no Omie, custo pela MESMA prova do fluxo normal (IPI por NCM × total      ║
# ║  cobrado), idempotência por protocolo, tudo-ou-nada, authz, falsificação.          ║
# ║      bash db/test-sayerlack-importar-pedido-portal.sh > /tmp/t.log 2>&1; echo $?   ║
# ║  (NAO pipe pra tail — engole o exit!=0.) 2º locale (lição #1483):                 ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-importar-pedido-portal.sh       ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5475}"
SLUG="sayerlack-importar-pedido-portal"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG_BASE1="$REPO_ROOT/supabase/migrations/20260905090000_sayerlack_custo_portal_cas.sql"
MIG_BASE2="$REPO_ROOT/supabase/migrations/20260906193522_valor_total_portal_provado.sql"
MIG_BASE3="$REPO_ROOT/supabase/migrations/20261006120000_preco_exato_po_sayerlack_ipi.sql"
MIG0="$REPO_ROOT/supabase/migrations/20261014120000_sayerlack_importar_pedido_portal.sql"
# A RPC VIVA é a da 20261016013000 (UPDATE com WHERE, pg-safeupdate), aplicada por cima da 0120000.
MIG="$REPO_ROOT/supabase/migrations/20261016013000_sayerlack_importar_pedido_portal_safeupdate.sql"
for f in "$MIG_BASE1" "$MIG_BASE2" "$MIG_BASE3" "$MIG0" "$MIG"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
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
linhas_error() { grep -E '^(psql:[^ ]*: )?(ERROR|ERRO|FATAL|PANIC):  |^psql: error: |server closed the connection|connection to server was lost' "$1" | sed -E 's/^psql:[^ ]*: //' | awk 'NR > 1 { printf " ;; " } { printf "%s", $0 }' || true; }

echo "═══ setup pronto (PG17 :$PORT) lc_messages=$HARNESS_LC ═══"
eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$(Pq -c "SHOW lc_messages")" "$HARNESS_LC"

# ZONA 1 — pré-requisitos: as colunas de prod que a RPC escreve/lê (pré-voo psql-ro 2026-10-14).
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  fornecedor_nome text,
  data_ciclo date NOT NULL DEFAULT current_date,
  valor_total numeric NOT NULL DEFAULT 0,
  num_skus integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pendente_aprovacao',
  canal_usado text,
  resposta_canal jsonb,
  omie_pedido_compra_numero text,
  aprovado_por uuid,
  aprovado_em timestamptz,
  condicao_pagamento_codigo text,
  condicao_pagamento_descricao text,
  num_parcelas integer,
  condicao_origem text,
  status_envio_portal text NOT NULL DEFAULT 'nao_aplicavel',
  enviado_portal_em timestamptz,
  portal_protocolo text,
  portal_data_entrega date
);
CREATE TABLE IF NOT EXISTS public.pedido_compra_item (
  id bigserial PRIMARY KEY,
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text NOT NULL,
  sku_descricao text,
  qtde_sugerida numeric NOT NULL,
  qtde_final numeric,
  preco_unitario numeric,
  valor_linha numeric,
  teto_cobertura_aplicado boolean NOT NULL DEFAULT false,
  sku_portal_aprovado text,
  fator_portal_aprovado numeric
);
CREATE TABLE IF NOT EXISTS public.omie_products (
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL,
  ncm text,
  descricao text,
  UNIQUE (omie_codigo_produto, account)
);
CREATE TABLE IF NOT EXISTS public.sku_fornecedor_externo (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  fornecedor_nome text NOT NULL,
  sku_omie text NOT NULL,
  sku_portal text,
  unidade_portal text NOT NULL DEFAULT 'UN',
  fator_conversao numeric NOT NULL DEFAULT 1,
  ativo boolean NOT NULL DEFAULT true
);
-- Espelho dos POs do Omie (em prod `empresa` é enum; a RPC compara por ::text).
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  numero_pedido text,
  numero_contrato_fornecedor text
);
GRANT SELECT ON public.pedido_compra_sugerido, public.pedido_compra_item, public.omie_products TO service_role;
SQL

# ZONA 2 — o caminho REAL do SQL Editor: as versões da RPC de custo e, por cima, a migration sob prova.
for m in "$MIG_BASE1" "$MIG_BASE2" "$MIG_BASE3" "$MIG0" "$MIG"; do P -q -f "$m"; done
echo "migrations aplicadas: base1 + base2 + base3 + $(basename "$MIG0") + $(basename "$MIG")"
eq "M0 a migration é re-aplicável (idempotente, postcondição verde na 2ª colada)" "$(P -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"

# ZONA 3 — seed. DFA.4080LT = o pedido real 2140603 (16 LT, R$ 4.865,5584 + IPI 6,5% = R$ 5.181,82).
seed() {
P -q <<'SQL'
TRUNCATE public.pedido_compra_item, public.pedido_compra_sugerido, public.omie_products, public.sku_fornecedor_externo, public.purchase_orders_tracking RESTART IDENTITY CASCADE;
INSERT INTO public.purchase_orders_tracking (empresa, numero_pedido, numero_contrato_fornecedor) VALUES
  ('OBEN',    '1278', '7000001'),   -- PO lançado direto no Omie com o nº do portal no contrato
  ('COLACOR', '9999', '7000002');   -- outra empresa: não bloqueia a OBEN
INSERT INTO public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo) VALUES
  ('OBEN',    'RENNER SAYERLACK S/A', '12101724100', 'DFA.4080LT',  'LT', 1,   true),
  ('OBEN',    'RENNER SAYERLACK S/A', '8689743214',  'WJOI.7585GL', 'GL', 1,   true),
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000001',  'CX.DUPLO',    'CX', 1,   true),
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000002',  'CX.DUPLO',    'CX', 1,   true),   -- ambíguo
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000003',  'CX.CINCO',    'CX', 0.2, true),   -- 1 CX = 5 UN no Omie
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000004',  'CX.TERCO',    'CX', 0.3, true),   -- não converte em inteiro
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000005',  'INATIVO.LT',  'LT', 1,   false),
  ('OBEN',    'OUTRO FORNECEDOR',     '9100000006',  'ALHEIO.LT',   'LT', 1,   true),
  ('COLACOR', 'RENNER SAYERLACK S/A', '9100000007',  'SO.COLACOR',  'LT', 1,   true),
  ('OBEN',    'RENNER SAYERLACK S/A', '9100000008',  'SEM.NCM',     'LT', 1,   true);
INSERT INTO public.omie_products (omie_codigo_produto, account, ncm, descricao) VALUES
  (12101724100, 'oben', '3814.00.90', 'DILUENTE PU DFA.4080LT'),
  (8689743214,  'oben', '3208.20.20', 'VERNIZ WJOI.7585GL'),
  (9100000003,  'oben', '3208.90.39', 'ITEM EM CAIXA DE 5'),
  (9100000004,  'oben', '3208.90.39', 'ITEM EM CAIXA DE 3,33'),
  (9100000008,  'oben', '3204.19.20', 'NCM FORA DA TABELA');
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
TRUNCATE public.user_roles;
INSERT INTO public.user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111', 'employee'), ('22222222-2222-2222-2222-222222222222', 'customer');
SQL
}
seed
P -q <<'SQL'
-- Sentinelas MINHAS com a SQLSTATE exata; o veredito é o stdout INTEIRO.
CREATE OR REPLACE FUNCTION public.tentar_imp(p_proto text, p_entrega date, p_total numeric, p_itens jsonb)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER AS $f$
DECLARE r jsonb;
BEGIN
  r := public.sayerlack_importar_pedido_portal(p_proto, p_entrega, p_total, p_itens, '11111111-1111-1111-1111-111111111111');
  RETURN 'IMP_OK_' || CASE WHEN (r->>'ja_existia')::boolean THEN 'existente' ELSE 'novo' END
    || '_' || coalesce((SELECT portal_protocolo FROM public.pedido_compra_sugerido WHERE id = (r->>'pedido_id')::bigint), 'sem-pedido');
EXCEPTION WHEN OTHERS THEN
  RETURN 'IMP_ERR_' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public.tentar_imp(text, date, numeric, jsonb) TO PUBLIC;
SQL
imp() { # $1 = argumentos · $2 = preâmbulo opcional (SET ROLE / GUC)
  local out rc=0
  out="$(printf '%s\nSELECT public.tentar_imp(%s);\n' "${2:-}" "$1" | P -q -tA 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; else printf 'IMP_SEM_MEDICAO_rc%s' "$rc"; fi
}
contagem() { Pq -c "SELECT (SELECT count(*) FROM public.pedido_compra_sugerido)||'p/'||(SELECT count(*) FROM public.pedido_compra_item)||'i'"; }
DFA='[{"sku_portal":"DFA.4080LT","qtde_portal":16,"valor_mercadoria":4865.5584}]'
ENT="'2026-10-26'"

echo "── asserts ──"
# A1 — o pedido real 2140603: pedido com protocolo, item pelo de-para, custo COM IPI pela prova.
eq "A1 importa o 2140603 (novo)" "$(imp "'2140603', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_OK_novo_2140603"
eq "A1 cabeçalho: OBEN/Sayerlack, aprovado p/ disparo, sucesso_portal + protocolo + entrega, à vista, importado" \
  "$(Pq -c "SELECT empresa||'|'||fornecedor_nome||'|'||status||'|'||status_envio_portal||'|'||portal_protocolo||'|'||portal_data_entrega||'|'||condicao_pagamento_codigo||'|'||num_parcelas||'|'||canal_usado||'|'||(importado_portal_em IS NOT NULL)||'|'||importado_portal_por||'|'||aprovado_por||'|'||num_skus FROM public.pedido_compra_sugerido WHERE portal_protocolo='2140603'")" \
  "OBEN|RENNER SAYERLACK S/A|aprovado_aguardando_disparo|sucesso_portal|2140603|2026-10-26|000|1|portal_sayerlack|true|11111111-1111-1111-1111-111111111111|11111111-1111-1111-1111-111111111111|1"
eq "A1 item: sku Omie, descrição do cadastro, qtde 16, preço COM IPI (5181,82÷16), decomposição 6,5%" \
  "$(Pq -c "SELECT sku_codigo_omie||'|'||sku_descricao||'|'||trim_scale(qtde_final)||'|'||trim_scale(round(preco_unitario,6))||'|'||trim_scale(valor_linha)||'|'||trim_scale(valor_ipi_portal)||'|'||trim_scale(aliquota_ipi_portal)||'|'||sku_portal_aprovado||'|'||trim_scale(fator_portal_aprovado) FROM public.pedido_compra_item WHERE pedido_id=(SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo='2140603')")" \
  "12101724100|DILUENTE PU DFA.4080LT|16|323.86375|5181.82|316.26|6.5|DFA.4080LT|1"
eq "A1 valor_total = total cobrado, provado contra o protocolo" \
  "$(Pq -c "SELECT trim_scale(valor_total)||'|'||trim_scale(valor_total_portal_provado)||'|'||valor_total_portal_provado_protocolo FROM public.pedido_compra_sugerido WHERE portal_protocolo='2140603'")" "5181.82|5181.82|2140603"

# A2 — idempotência: reimportar devolve o MESMO pedido, sem gravar nada.
eq "A2 reimportar devolve o mesmo pedido (ja_existia)" "$(imp "'2140603', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_OK_existente_2140603"
eq "A2 nada duplicou" "$(contagem)" "1p/1i"
eq "A2 o índice UNIQUE recusa outro pedido com o mesmo protocolo (backstop do lock)" \
  "$(Pq -q -c "DO \$\$ BEGIN INSERT INTO public.pedido_compra_sugerido (empresa, portal_protocolo) VALUES ('OBEN', '2140603'); RAISE EXCEPTION 'SEM_RECUSA'; EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok'; END \$\$; SELECT 'UNIQUE_OK'")" "UNIQUE_OK"

# A3 — pedido do MOTOR com o protocolo: importar devolve ele (não cria 2º PO).
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, status_envio_portal, portal_protocolo) VALUES (500, 'OBEN', 'RENNER SAYERLACK S/A', 'disparado', 'sucesso_portal', '2140604')"
eq "A3 protocolo de pedido do motor devolve o pedido do motor" "$(imp "'2140604', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_OK_existente_2140604"

# A4 — multi-item com fator 0,2 (2 CX = 10 UN no Omie): 1×3,25% + 1×6,5% fecha com o total.
#   WJOI: 242,247 → 242,25 + 7,87 · CX.CINCO: 100,00 + 6,50 ⇒ 356,62
eq "A4 multi-item com fator ≠ 1" \
  "$(imp "'3000001', $ENT, 356.62, '[{\"sku_portal\":\"wjoi.7585gl\",\"qtde_portal\":1,\"valor_mercadoria\":242.247},{\"sku_portal\":\"CX.CINCO\",\"qtde_portal\":2,\"valor_mercadoria\":100}]'::jsonb")" "IMP_OK_novo_3000001"
eq "A4 qtde do Omie = qtde do portal ÷ fator (2 ÷ 0,2 = 10); sku_portal normalizado" \
  "$(Pq -c "SELECT string_agg(sku_portal_aprovado||'='||trim_scale(qtde_final)||'@'||trim_scale(round(preco_unitario,4)), ',' ORDER BY id) FROM public.pedido_compra_item WHERE pedido_id=(SELECT id FROM public.pedido_compra_sugerido WHERE portal_protocolo='3000001')")" "WJOI.7585GL=1@250.12,CX.CINCO=10@10.65"

# A5 — recusas: SQLSTATE exata e NADA gravado (tudo-ou-nada).
ANTES="$(contagem)"
r() { eq "$1" "$(imp "$2")" "$3"; }
r "A5 IP002 SKU sem de-para"                 "'4000001', $ENT, 100, '[{\"sku_portal\":\"NAO.EXISTE\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP002"
r "A5 IP002 de-para ambíguo (2 SKUs Omie)"   "'4000002', $ENT, 100, '[{\"sku_portal\":\"CX.DUPLO\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP002"
r "A5 IP002 de-para INATIVO não vale"         "'4000003', $ENT, 100, '[{\"sku_portal\":\"INATIVO.LT\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP002"
r "A5 IP002 de-para de OUTRA empresa não vale" "'4000004', $ENT, 100, '[{\"sku_portal\":\"SO.COLACOR\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP002"
r "A5 IP002 um item bom + um sem de-para: nada" "'4000005', $ENT, 5281.82, '[$(printf '%s' "$DFA" | sed 's/^\[//; s/\]$//'),{\"sku_portal\":\"NAO.EXISTE\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP002"
r "A5 IP003 quantidade não inteira (1 ÷ 0,3)" "'4000006', $ENT, 100, '[{\"sku_portal\":\"CX.TERCO\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP003"
r "A5 IP004 fornecedor não-Sayerlack"        "'4000007', $ENT, 100, '[{\"sku_portal\":\"ALHEIO.LT\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP004"
r "A5 IP005 SKU repetido"                    "'4000008', $ENT, 200, '[{\"sku_portal\":\"DFA.4080LT\",\"qtde_portal\":1,\"valor_mercadoria\":100},{\"sku_portal\":\"dfa.4080lt\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_IP005"
r "A5 CP006 NCM fora da tabela de IPI"       "'4000009', $ENT, 100, '[{\"sku_portal\":\"SEM.NCM\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb" "IMP_ERR_CP006"
r "A5 CP007 total 8 centavos acima do cobrado" "'4000010', $ENT, 5181.90, '$DFA'::jsonb" "IMP_ERR_CP007"
r "A5 CP007 total SEM o IPI (mercadoria pura)" "'4000011', $ENT, 4865.56, '$DFA'::jsonb" "IMP_ERR_CP007"
r "A5 IP006 já há PO OBEN no Omie com este nº no contrato" "'7000001', $ENT, 5181.82, '$DFA'::jsonb" "IMP_ERR_IP006"
r "A5 IP001 protocolo não numérico"          "'21406O3', $ENT, 5181.82, '$DFA'::jsonb" "IMP_ERR_IP001"
r "A5 IP001 sem data de entrega"             "'4000012', NULL, 5181.82, '$DFA'::jsonb" "IMP_ERR_IP001"
r "A5 IP001 total zero"                      "'4000013', $ENT, 0, '$DFA'::jsonb" "IMP_ERR_IP001"
r "A5 IP001 sem itens"                       "'4000014', $ENT, 5181.82, '[]'::jsonb" "IMP_ERR_IP001"
r "A5 IP001 qtde como string"                "'4000015', $ENT, 5181.82, '[{\"sku_portal\":\"DFA.4080LT\",\"qtde_portal\":\"16\",\"valor_mercadoria\":4865.5584}]'::jsonb" "IMP_ERR_IP001"
r "A5 IP001 qtde zero"                       "'4000016', $ENT, 5181.82, '[{\"sku_portal\":\"DFA.4080LT\",\"qtde_portal\":0,\"valor_mercadoria\":4865.5584}]'::jsonb" "IMP_ERR_IP001"
eq "A5 nenhuma recusa gravou nada" "$(contagem)" "$ANTES"
r "A5 controle IP006: contrato de OUTRA empresa não bloqueia" "'7000002', $ENT, 5181.82, '$DFA'::jsonb" "IMP_OK_novo_7000002"
r "A5 controle: o mesmo payload com o total certo grava" "'4000010', $ENT, 5181.82, '$DFA'::jsonb" "IMP_OK_novo_4000010"

# A6 — authz: só service_role executa; customer barrado pelo gate de papel mesmo com EXECUTE.
eq "A6 anon sem EXECUTE"          "$(Pq -c "SELECT has_function_privilege('anon', 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid)', 'EXECUTE')")" "f"
eq "A6 authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid)', 'EXECUTE')")" "f"
eq "A6 service_role com EXECUTE"  "$(Pq -c "SELECT has_function_privilege('service_role', 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid)', 'EXECUTE')")" "t"
eq "A6 authenticated chamando: 42501" "$(imp "'5000001', $ENT, 5181.82, '$DFA'::jsonb" "SET ROLE authenticated;")" "IMP_ERR_42501"
eq "A6 customer (uid) barrado pelo gate de papel" "$(imp "'5000002', $ENT, 5181.82, '$DFA'::jsonb" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "IMP_ERR_42501"
eq "A6 controle: staff (uid employee) importa" "$(imp "'5000003', $ENT, 5181.82, '$DFA'::jsonb" "SET test.uid='11111111-1111-1111-1111-111111111111';")" "IMP_OK_novo_5000003"

# ZONA 5 — FALSIFICAÇÃO: uma camada por vez, o vermelho CERTO, restaura com a migration REAL.
echo "── falsificação ──"
SAB="$(dirname "$DATA")/sab.sql"
sabota() {
  sed -e "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then echo "  ❌ sabotagem NÃO casou o padrão ($1) — falsificação seria teatro"; FAIL=$((FAIL+1)); return 1; fi
  P -q -f "$SAB"
}
restaura() { seed; P -q -f "$MIG0"; P -q -f "$MIG"; seed; }
dente() { if [ "$2" = "$3" ]; then ok "$1 (sabotado ⇒ $2)"; else bad "$1 — sabotado devia dar [$3], veio [$2]"; fi; }

seed; sabota 's/WHERE n_map <> 1;/WHERE n_map = 0;/'
dente "F1 sem a recusa do ambíguo, CX.DUPLO importa (A5)" "$(imp "'6000001', $ENT, 106.5, '[{\"sku_portal\":\"CX.DUPLO\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb")" "IMP_ERR_CP006"
restaura
sabota 's/ OR qtde_omie <> trunc(qtde_omie);/;/'
dente "F2 sem a exigência de inteiro, a RPC de custo (camada de baixo) segura como CP004" "$(imp "'6000002', $ENT, 106.5, '[{\"sku_portal\":\"CX.TERCO\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb")" "IMP_ERR_CP004"
restaura
sabota "s/OR v_fornecedor !~\* 'sayerlack' THEN/THEN/"
dente "F3 sem o filtro de fornecedor, ALHEIO.LT passa do IP004" "$(imp "'6000003', $ENT, 100, '[{\"sku_portal\":\"ALHEIO.LT\",\"qtde_portal\":1,\"valor_mercadoria\":100}]'::jsonb")" "IMP_ERR_CP006"
restaura
sabota 's/^  IF v_existente IS NOT NULL THEN$/  IF false THEN/'
P -q -c "INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, status_envio_portal, portal_protocolo) VALUES (500, 'OBEN', 'RENNER SAYERLACK S/A', 'disparado', 'sucesso_portal', '2140604')"
dente "F4 sem o 'já existe', o índice UNIQUE ainda barra o 2º pedido (23505)" "$(imp "'2140604', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_ERR_23505"
restaura
sabota 's/^  IF v_po_omie IS NOT NULL THEN$/  IF false THEN/'
dente "F8 sem o IP006, o PO lançado no Omie ganha um 2º PO" "$(imp "'7000001', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_OK_novo_7000001"
restaura
sabota 's/^  v_atualizados := public\.sayerlack_aplicar_custo_portal(v_pedido_id, v_payload, p_valor_total);$/  v_atualizados := v_n;/'
dente "F5 sem a prova de custo, total errado grava (A5 CP007)" "$(imp "'6000005', $ENT, 9999.99, '$DFA'::jsonb")" "IMP_OK_novo_6000005"
restaura
sabota 's/^  IF auth\.uid() IS NOT NULL AND NOT/  IF false AND NOT/'
dente "F6 sem o gate de papel, a RPC de custo (camada de baixo) barra o customer" "$(imp "'6000006', $ENT, 5181.82, '$DFA'::jsonb" "SET test.uid='22222222-2222-2222-2222-222222222222';")" "IMP_ERR_42501"
restaura
# F7 — a postcondição aborta o apply com a RPC aberta a authenticated, e o aborto é DELA.
# O REVOKE mora na migration de ORIGEM (a de REPLACE preserva o ACL e não o repete).
sed -e 's/^REVOKE ALL ON FUNCTION public\.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid) FROM authenticated;$/GRANT EXECUTE ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid) TO authenticated;/' "$MIG0" > "$SAB"
if cmp -s "$MIG0" "$SAB"; then
  bad "F7 sabotagem NÃO casou o REVOKE — falsificação seria teatro"
elif P -q -f "$SAB" >/dev/null 2>"$SAB.err"; then
  bad "F7 postcondição NÃO abortou com authenticated executando a RPC"
else
  F7="$(linhas_error "$SAB.err")"
  case "$F7" in
    "ERROR:  A4 FALHOU: RPC executável por anon/authenticated — SECURITY DEFINER aberta"|\
    "ERRO:  A4 FALHOU: RPC executável por anon/authenticated — SECURITY DEFINER aberta")
      ok "F7 postcondição aborta o apply com a RPC aberta" ;;
    *) bad "F7 ERRO ALHEIO à postcondição — veio [${F7:-<nenhuma linha ERROR>}]" ;;
  esac
fi
restaura
# F9 — pg-safeupdate: o Supabase recusa UPDATE sem WHERE vindo da API (1º uso real, 2141068). O PG17 local não carrega
# a extensão, então a régua é a postcondição: sem o WHERE, o apply aborta com a mensagem DELA.
eq "S1 nenhum UPDATE sem WHERE no corpo vivo da RPC" "$(Pq -c "SELECT count(*) FROM pg_proc p, regexp_matches(p.prosrc, '\mUPDATE\s[^;]*;', 'gi') AS m(x) WHERE p.oid = 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid)'::regprocedure AND m.x[1] !~* '\mWHERE\M'")" "0"
sed -e 's/^   WHERE qtde_omie IS NULL;  -- WHERE obrigatório.*$/   ;/' "$MIG" > "$SAB"
if cmp -s "$MIG" "$SAB"; then
  bad "F9 sabotagem NÃO casou o WHERE do UPDATE — falsificação seria teatro"
elif P -q -f "$SAB" >/dev/null 2>"$SAB.err"; then
  bad "F9 postcondição NÃO abortou com UPDATE sem WHERE"
else
  F9="$(linhas_error "$SAB.err")"
  case "$F9" in
    "ERROR:  A2 FALHOU: UPDATE sem WHERE no corpo — o pg-safeupdate do Supabase recusa a importação"|\
    "ERRO:  A2 FALHOU: UPDATE sem WHERE no corpo — o pg-safeupdate do Supabase recusa a importação")
      ok "F9 postcondição aborta o apply com UPDATE sem WHERE" ;;
    *) bad "F9 ERRO ALHEIO à postcondição — veio [${F9:-<nenhuma linha ERROR>}]" ;;
  esac
fi
restaura
# Controle: a migration REAL re-aplicada segue verde nos asserts centrais.
eq "FC controle: A1 volta a gravar" "$(imp "'2140603', $ENT, 5181.82, '$DFA'::jsonb")" "IMP_OK_novo_2140603"
eq "FC controle: CP007 volta a recusar" "$(imp "'6000099', $ENT, 9999.99, '$DFA'::jsonb")" "IMP_ERR_CP007"
rm -f "$SAB" "$SAB.err"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

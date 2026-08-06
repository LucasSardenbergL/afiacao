#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260716180000_leadtime_efetivo_dedup_nfe.sql                        ║
# ║      bash db/test-leadtime-efetivo-dedup-nfe.sh > /tmp/t.log 2>&1; echo $?     ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que se prova: a estatística de leadtime passa a contar NFe, não linha.      ║
# ║  O defeito real (prod OBEN 2026-07-16): 1 NFe que fatura N pedidos gera N      ║
# ║  cópias do mesmo item ⇒ o gate `lt_n_observacoes >= 3` da                      ║
# ║  v_sku_leadtime_estatisticas cruza com UMA observação replicada, e o desvio    ║
# ║  vira 0 (cópias idênticas). Confiança fabricada no caminho da compra.          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="ltefetivo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria) — fiéis à prod
# ══════════════════════════════════════════════════════════════════════════════
# Tipos/assinaturas conferidos na PROD via psql-ro (2026-07-16):
#   sku_leadtime_history.empresa :: empresa_reposicao ENUM ('OBEN','COLACOR')
#   has_role(_user_id uuid, _role app_role)
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');

CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_user_id AND ur.role=_role)
$f$;

CREATE TABLE public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint,
  numero_contrato_fornecedor text,
  nfe_chave_acesso text,
  fornecedor_codigo_omie bigint,
  raw_data jsonb
);

CREATE TABLE public.sku_leadtime_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id uuid REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  empresa public.empresa_reposicao NOT NULL,
  sku_codigo_omie bigint,
  sku_codigo text, sku_descricao text, sku_unidade text, sku_ncm text,
  fornecedor_codigo_omie bigint, fornecedor_nome text, grupo_leadtime text,
  quantidade_pedida numeric, quantidade_recebida numeric,
  valor_unitario numeric, valor_total numeric,
  t1_data_pedido timestamptz, t2_data_faturamento timestamptz,
  t3_data_cte timestamptz, t4_data_recebimento timestamptz,
  lt_bruto_dias_uteis integer, lt_faturamento_dias_uteis integer, lt_logistica_dias_uteis integer,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  origem_compra text DEFAULT 'normal',
  UNIQUE (tracking_id, sku_codigo_omie)
);

-- RLS igual à prod (staff-only + service_role), pra provar que a cadeia invoker=on
-- não abre buraco. anon NÃO tem policy → 0 linhas.
ALTER TABLE public.sku_leadtime_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_all_slh ON public.sku_leadtime_history FOR ALL TO service_role USING (true);
CREATE POLICY staff_slh ON public.sku_leadtime_history FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()),'master') OR public.has_role((SELECT auth.uid()),'employee')));
CREATE POLICY service_all_pot ON public.purchase_orders_tracking FOR ALL TO service_role USING (true);
CREATE POLICY staff_pot ON public.purchase_orders_tracking FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()),'master') OR public.has_role((SELECT auth.uid()),'employee')));

-- A view que a migração usa como fonte (existe em prod, invoker=on).
CREATE VIEW public.v_sku_leadtime_history_normal WITH (security_invoker = on) AS
  SELECT id, tracking_id, empresa, sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade,
         sku_ncm, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, quantidade_pedida,
         quantidade_recebida, valor_unitario, valor_total, t1_data_pedido, t2_data_faturamento,
         t3_data_cte, t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis,
         lt_logistica_dias_uteis, created_at, updated_at, origem_compra
  FROM public.sku_leadtime_history WHERE origem_compra = 'normal';
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260716180000_leadtime_efetivo_dedup_nfe.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: reproduz os 3 padrões medidos em prod
# ══════════════════════════════════════════════════════════════════════════════
# SKU 1001 "gate fabricado" — 1 NFe faturando 3 pedidos, cópias IDÊNTICAS (lt=5).
#            Hoje: n=3, desvio=0, fonte=SKU. Depois: n=1 → fonte=FORNECEDOR.
# SKU 1002 "observação real" — 3 NFes distintas (lt=4,6,8). n=3 antes E depois.
# SKU 1003 "divergente"      — 1 NFe, 2 pedidos, lt=3 vs 9 → lt vira NULL, n=0.
# SKU 1004 "preço"           — NFe-P1 (3 pedidos, valor 10) + NFe-P2 (1 pedido, valor 20).
#            Hoje AVG=(10+10+10+20)/4=12,5 (peso 3× na NFe-P1). Depois: (10+20)/2=15.
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');

-- 3 linhas de pedido dividindo a MESMA chave (o padrão que gera a duplicação)
INSERT INTO public.purchase_orders_tracking (id, empresa, omie_codigo_pedido, nfe_chave_acesso, fornecedor_codigo_omie) VALUES
  ('a0000000-0000-0000-0000-000000000001','OBEN', 11, 'CHAVE_MULTI_A', 100),
  ('a0000000-0000-0000-0000-000000000002','OBEN', 12, 'CHAVE_MULTI_A', 100),
  ('a0000000-0000-0000-0000-000000000003','OBEN', 13, 'CHAVE_MULTI_A', 100),
  ('b0000000-0000-0000-0000-000000000001','OBEN', 21, 'CHAVE_SOLO_B1', 100),
  ('b0000000-0000-0000-0000-000000000002','OBEN', 22, 'CHAVE_SOLO_B2', 100),
  ('b0000000-0000-0000-0000-000000000003','OBEN', 23, 'CHAVE_SOLO_B3', 100),
  ('c0000000-0000-0000-0000-000000000001','OBEN', 31, 'CHAVE_DIVERG_C', 100),
  ('c0000000-0000-0000-0000-000000000002','OBEN', 32, 'CHAVE_DIVERG_C', 100),
  ('d0000000-0000-0000-0000-000000000001','OBEN', 41, 'CHAVE_PRECO_P1', 100),
  ('d0000000-0000-0000-0000-000000000002','OBEN', 42, 'CHAVE_PRECO_P1', 100),
  ('d0000000-0000-0000-0000-000000000003','OBEN', 43, 'CHAVE_PRECO_P1', 100),
  ('d0000000-0000-0000-0000-000000000004','OBEN', 44, 'CHAVE_PRECO_P2', 100);

-- SKU 1001: 3 cópias IDÊNTICAS da mesma NFe
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('a0000000-0000-0000-0000-000000000001','OBEN',1001,'SKU FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100),
  ('a0000000-0000-0000-0000-000000000002','OBEN',1001,'SKU FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100),
  ('a0000000-0000-0000-0000-000000000003','OBEN',1001,'SKU FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100);

-- SKU 1002: 3 NFes DISTINTAS (observação legítima)
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('b0000000-0000-0000-0000-000000000001','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '30 days', now()-interval '26 days', 4, 1, 50),
  ('b0000000-0000-0000-0000-000000000002','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '20 days', now()-interval '14 days', 6, 1, 50),
  ('b0000000-0000-0000-0000-000000000003','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '12 days', now()-interval  '4 days', 8, 1, 50);

-- SKU 1003: mesma NFe, cópias DIVERGENTES (cada uma pegou o t1 de um pedido diferente)
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t1_data_pedido, t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('c0000000-0000-0000-0000-000000000001','OBEN',1003,'SKU DIVERGENTE',100,'FORN X', now()-interval '20 days', now()-interval '10 days', now()-interval '5 days', 3, 1, 70),
  ('c0000000-0000-0000-0000-000000000002','OBEN',1003,'SKU DIVERGENTE',100,'FORN X', now()-interval '26 days', now()-interval '10 days', now()-interval '5 days', 9, 1, 70);

-- SKU 1004: preço — NFe-P1 com 3 pedidos (peso 3× hoje) + NFe-P2 com 1
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('d0000000-0000-0000-0000-000000000001','OBEN',1004,'SKU PRECO',100,'FORN X', now()-interval '9 days', now()-interval '5 days', 4, 1, 10),
  ('d0000000-0000-0000-0000-000000000002','OBEN',1004,'SKU PRECO',100,'FORN X', now()-interval '9 days', now()-interval '5 days', 4, 1, 10),
  ('d0000000-0000-0000-0000-000000000003','OBEN',1004,'SKU PRECO',100,'FORN X', now()-interval '9 days', now()-interval '5 days', 4, 1, 10),
  ('d0000000-0000-0000-0000-000000000004','OBEN',1004,'SKU PRECO',100,'FORN X', now()-interval '8 days', now()-interval '4 days', 4, 1, 20);

-- Grants FIÉIS À PROD (conferidos via psql-ro em 2026-07-16): anon tem SELECT nas
-- tabelas-base E em v_sku_leadtime_history_normal (relacl `anon=arwdDxtm`). Só a RLS o
-- filtra (anon não tem policy → 0 linhas). Isto NÃO é decoração do harness: sem conceder
-- anon na view intermediária, a cadeia invoker=on o barra LÁ ATRÁS e o assert do REVOKE
-- passa pelo motivo errado — a falsificação F3 pegou exatamente isso.
GRANT SELECT ON public.sku_leadtime_history, public.purchase_orders_tracking, public.user_roles
  TO authenticated, anon;
GRANT SELECT ON public.v_sku_leadtime_history_normal TO authenticated, anon;
GRANT SELECT ON public.v_sku_leadtime_efetivo, public.v_sku_leadtime_estatisticas TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# --- baseline: o defeito EXISTE na fonte (senão o teste prova o vazio) ---
V=$(Pq -c "SELECT count(*) FROM public.sku_leadtime_history WHERE sku_codigo_omie=1001;")
eq "A0 baseline: SKU 1001 tem 3 linhas na tabela crua (a duplicação)" "$V" "3"

# --- A1: par com 1 cópia passa intacto ---
V=$(Pq -c "SELECT count(*) FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1002;")
eq "A1 3 NFes distintas continuam 3 linhas (não colapsa o legítimo)" "$V" "3"

# --- A2: 3 cópias idênticas colapsam em 1, valor preservado (lossless) ---
V=$(Pq -c "SELECT count(*) FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1001;")
eq "A2 3 cópias da mesma NFe colapsam em 1 linha" "$V" "1"
V=$(Pq -c "SELECT lt_bruto_dias_uteis FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1001;")
eq "A2b colapso é lossless: cópias idênticas preservam o valor" "$V" "5"
V=$(Pq -c "SELECT n_copias_origem FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1001;")
eq "A2c a view expõe de quantas cópias veio (auditoria)" "$V" "3"

# --- A3: cópias divergentes → NULL, JAMAIS um representante (ausente ≠ escolhido) ---
V=$(Pq -c "SELECT count(*) FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1003;")
eq "A3 divergente também colapsa em 1 linha" "$V" "1"
V=$(Pq -c "SELECT coalesce(lt_bruto_dias_uteis::text,'NULL') FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1003;")
eq "A3b cópias divergentes (3 vs 9) → lt_bruto NULL, não 3 nem 9" "$V" "NULL"
V=$(Pq -c "SELECT coalesce(t1_data_pedido::text,'NULL') FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1003;")
eq "A3c t1 divergente também vira NULL" "$V" "NULL"
# ausente ≠ zero: o campo NULO não pode ter virado 0 em lugar nenhum
V=$(Pq -c "SELECT count(*) FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1003 AND lt_bruto_dias_uteis=0;")
eq "A3d ausente ≠ zero: divergência NÃO vira 0" "$V" "0"

# --- A4: o gate. SKU com confiança fabricada CAI para o fallback do fornecedor ---
V=$(Pq -c "SELECT lt_n_observacoes FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1001;")
eq "A4 SKU 1001: n_observacoes = 1 (era 3 por duplicação)" "$V" "1"
V=$(Pq -c "SELECT fonte_leadtime FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1001;")
eq "A4b SKU 1001 perde o gate >=3 → usa média do FORNECEDOR" "$V" "FORNECEDOR"
V=$(Pq -c "SELECT fonte_leadtime FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1002;")
eq "A4c SKU 1002 (3 NFes REAIS) mantém o gate → fonte SKU" "$V" "SKU"

# --- A5: o desvio-padrão fabricado (0 por cópias idênticas) some ---
V=$(Pq -c "SELECT coalesce(stddev(lt_bruto_dias_uteis)::text,'NULL') FROM public.sku_leadtime_history WHERE sku_codigo_omie=1001;")
eq "A5 baseline: na tabela crua o desvio do SKU 1001 é 0 (fabricado)" "$V" "0"
V=$(Pq -c "SELECT coalesce(lt_desvio_padrao_dias::text,'NULL') FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1001;")
if [ "$V" = "0" ] || [ "$V" = "0.00" ]; then bad "A5b desvio fabricado 0 vazou pra estatística — veio [$V]"; else ok "A5b desvio 0 fabricado NÃO chega à estatística (=$V, do fornecedor)"; fi

# --- A6: preço — a NFe de 3 pedidos deixa de pesar 3× ---
V=$(Pq -c "SELECT round(avg(valor_total/nullif(quantidade_recebida,0)),2) FROM public.sku_leadtime_history WHERE sku_codigo_omie=1004;")
eq "A6 baseline: média crua = 12.50 (NFe-P1 pesa 3×)" "$V" "12.50"
V=$(Pq -c "SELECT round(avg(valor_total/nullif(quantidade_recebida,0)),2) FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1004;")
eq "A6b na view efetiva = 15.00 (1 voto por NFe)" "$V" "15.00"

# --- A7: nenhuma linha some (a view não pode engolir leadtime) ---
V=$(Pq -c "SELECT count(DISTINCT (coalesce(pot.nfe_chave_acesso,'tracking:'||h.tracking_id::text), h.sku_codigo_omie)) FROM public.sku_leadtime_history h LEFT JOIN public.purchase_orders_tracking pot ON pot.id=h.tracking_id WHERE h.origem_compra='normal';")
W=$(Pq -c "SELECT count(*) FROM public.v_sku_leadtime_efetivo;")
eq "A7 conservação: 1 linha por (NFe,SKU) distinto — nada some, nada duplica" "$W" "$V"

# --- A8: segurança — a cadeia invoker=on + REVOKE não vaza preço de compra ---
V=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.v_sku_leadtime_efetivo;" | tail -1)
if [ "$V" -gt 0 ]; then ok "A8 staff (employee) LÊ a view efetiva (=$V)"; else bad "A8 staff não conseguiu ler — a view quebrou o staff"; fi
if P -q -c "SET ROLE anon; SELECT count(*) FROM public.v_sku_leadtime_efetivo;" >/dev/null 2>&1; then
  bad "A8b anon conseguiu SELECT na view (o REVOKE não pegou) — vaza preço de compra"
else
  ok "A8b anon é barrado na view efetiva (REVOKE SELECT FROM anon)"
fi
V=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.v_sku_leadtime_efetivo;" | tail -1)
eq "A8c authenticated SEM role de staff vê 0 (RLS via cadeia invoker=on)" "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (os asserts têm dente?) ──"

# F1 — sabotagem: view SEM dedup (volta a contar linha). A4/A4b têm de ficar vermelhos.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo WITH (security_invoker = on) AS
  SELECT h.empresa, h.sku_codigo_omie,
         coalesce(pot.nfe_chave_acesso,'tracking:'||h.tracking_id::text) AS dedup_key,
         pot.nfe_chave_acesso, 1::bigint AS n_copias_origem, false AS veio_de_duplicata,
         h.sku_codigo, h.sku_descricao, h.sku_unidade, h.sku_ncm, h.fornecedor_nome,
         h.grupo_leadtime, h.origem_compra, h.fornecedor_codigo_omie,
         h.quantidade_pedida, h.quantidade_recebida, h.valor_unitario, h.valor_total,
         h.t1_data_pedido, h.t2_data_faturamento, h.t3_data_cte, h.t4_data_recebimento,
         h.lt_bruto_dias_uteis, h.lt_faturamento_dias_uteis, h.lt_logistica_dias_uteis
  FROM public.v_sku_leadtime_history_normal h
  LEFT JOIN public.purchase_orders_tracking pot ON pot.id = h.tracking_id;
SQL
V=$(Pq -c "SELECT fonte_leadtime FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1001;")
if [ "$V" = "SKU" ]; then ok "F1 sabotagem (view sem dedup) RESSUSCITA a confiança fabricada → A4b tinha dente"
else bad "F1 sabotei o dedup e o A4b seguiu verde (veio [$V]) — assert SEM dente"; fi

# F2 — sabotagem: divergência escolhe representante (min) em vez de NULL. A3b tem de ficar vermelho.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo WITH (security_invoker = on) AS
  SELECT h.empresa, h.sku_codigo_omie,
         coalesce(pot.nfe_chave_acesso,'tracking:'||h.tracking_id::text) AS dedup_key,
         max(pot.nfe_chave_acesso) AS nfe_chave_acesso, count(*) AS n_copias_origem,
         (count(*)>1) AS veio_de_duplicata,
         max(h.sku_codigo) AS sku_codigo, max(h.sku_descricao) AS sku_descricao,
         max(h.sku_unidade) AS sku_unidade, max(h.sku_ncm) AS sku_ncm,
         max(h.fornecedor_nome) AS fornecedor_nome, max(h.grupo_leadtime) AS grupo_leadtime,
         max(h.origem_compra) AS origem_compra, min(h.fornecedor_codigo_omie) AS fornecedor_codigo_omie,
         min(h.quantidade_pedida) AS quantidade_pedida, min(h.quantidade_recebida) AS quantidade_recebida,
         min(h.valor_unitario) AS valor_unitario, min(h.valor_total) AS valor_total,
         min(h.t1_data_pedido) AS t1_data_pedido, min(h.t2_data_faturamento) AS t2_data_faturamento,
         min(h.t3_data_cte) AS t3_data_cte, min(h.t4_data_recebimento) AS t4_data_recebimento,
         min(h.lt_bruto_dias_uteis) AS lt_bruto_dias_uteis,
         min(h.lt_faturamento_dias_uteis) AS lt_faturamento_dias_uteis,
         min(h.lt_logistica_dias_uteis) AS lt_logistica_dias_uteis
  FROM public.v_sku_leadtime_history_normal h
  LEFT JOIN public.purchase_orders_tracking pot ON pot.id = h.tracking_id
  GROUP BY h.empresa, dedup_key, h.sku_codigo_omie;
SQL
V=$(Pq -c "SELECT coalesce(lt_bruto_dias_uteis::text,'NULL') FROM public.v_sku_leadtime_efetivo WHERE sku_codigo_omie=1003;")
if [ "$V" = "3" ]; then ok "F2 sabotagem (min() em vez de NULL) fabrica o valor 3 → A3b tinha dente"
else bad "F2 sabotei pra escolher representante e o A3b não pegou (veio [$V]) — assert SEM dente"; fi

# F3 — sabotagem: sem o REVOKE, anon volta a poder SELECTar. A8b tem de ficar vermelho.
P -q -c "GRANT SELECT ON public.v_sku_leadtime_efetivo TO anon;"
if P -q -c "SET ROLE anon; SELECT count(*) FROM public.v_sku_leadtime_efetivo;" >/dev/null 2>&1; then
  ok "F3 sabotagem (GRANT a anon) reabre o SELECT → o REVOKE era o que barrava (A8b tem dente)"
  # 2ª camada: furado o REVOKE, a RLS da tabela-base ainda tem de entregar 0 linhas.
  # Se ISTO falhar, o REVOKE era a única proteção e a view vaza preço de compra.
  V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.v_sku_leadtime_efetivo;" | tail -1)
  eq "F3b defense-in-depth: mesmo com o GRANT, a RLS entrega 0 linhas a anon" "$V" "0"
else bad "F3 concedi SELECT a anon e ele seguiu barrado — A8b prova outra coisa"; fi

# restaura a versão verdadeira e re-confirma o verde
P -q -f "$MIG"
P -q -c "REVOKE SELECT ON public.v_sku_leadtime_efetivo FROM anon, PUBLIC;"
P -q -c "GRANT SELECT ON public.v_sku_leadtime_efetivo, public.v_sku_leadtime_estatisticas TO authenticated;"
V=$(Pq -c "SELECT fonte_leadtime FROM public.v_sku_leadtime_estatisticas WHERE sku_codigo_omie=1001;")
eq "F4 migration restaurada: o fix volta a valer" "$V" "FORNECEDOR"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

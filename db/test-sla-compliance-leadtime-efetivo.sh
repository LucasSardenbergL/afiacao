#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260716230000_sla_compliance_le_leadtime_efetivo.sql                ║
# ║      bash db/test-sla-compliance-leadtime-efetivo.sh > /tmp/t.log 2>&1; echo $? ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que se prova: o SLA de fornecedor passa a contar NFe, não linha.            ║
# ║  A Fase 0 (20260716180000) quarentenou v_sku_leadtime_estatisticas e PAROU     ║
# ║  ali; v_sku_sla_compliance seguiu lendo a tabela crua com o MESMO defeito —    ║
# ║  uma fração material dos SKUs cruza o gate `n_observacoes >= 3` do status_sla ║
# ║  com UMA observação replicada (auditado em prod, OBEN, 2026-07-16).           ║
# ║  Prova também o NULLS FIRST do Top-5 (achado do Codex xhigh): ORDER BY t4 DESC ║
# ║  põe NULL PRIMEIRO no Postgres, e a view efetiva emite t4 NULL quando as       ║
# ║  cópias divergem ⇒ sem o filtro, a data indeterminada vira "a mais recente".   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="slabis"
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
# ZONA 1 — PRÉ-REQUISITOS — tipos conferidos na PROD via psql-ro (2026-07-16)
# ══════════════════════════════════════════════════════════════════════════════
#   sku_leadtime_history.empresa :: empresa_reposicao ENUM ('OBEN','COLACOR')
#   sku_parametros.empresa       :: text  · .sku_codigo_omie :: bigint
#   sku_grupo_producao           :: text/text
#   v_sku_lt_teorico             :: text/text + lt_total_teorico_dias_uteis
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

ALTER TABLE public.sku_leadtime_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_orders_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY service_all_slh ON public.sku_leadtime_history FOR ALL TO service_role USING (true);
CREATE POLICY staff_slh ON public.sku_leadtime_history FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()),'master') OR public.has_role((SELECT auth.uid()),'employee')));
CREATE POLICY service_all_pot ON public.purchase_orders_tracking FOR ALL TO service_role USING (true);
CREATE POLICY staff_pot ON public.purchase_orders_tracking FOR ALL TO authenticated
  USING ((SELECT public.has_role((SELECT auth.uid()),'master') OR public.has_role((SELECT auth.uid()),'employee')));

CREATE VIEW public.v_sku_leadtime_history_normal WITH (security_invoker = on) AS
  SELECT id, tracking_id, empresa, sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade,
         sku_ncm, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, quantidade_pedida,
         quantidade_recebida, valor_unitario, valor_total, t1_data_pedido, t2_data_faturamento,
         t3_data_cte, t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis,
         lt_logistica_dias_uteis, created_at, updated_at, origem_compra
  FROM public.sku_leadtime_history WHERE origem_compra = 'normal';

-- Tabelas que a v_sku_sla_compliance lê (o SELECT externo). empresa=text em todas.
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text, ativo boolean DEFAULT true
);
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE VIEW public.v_sku_lt_teorico AS
  SELECT 'OBEN'::text AS empresa, ''::text AS sku_codigo_omie, ''::text AS grupo_codigo,
         0::integer AS lt_total_teorico_dias_uteis WHERE false;
SQL

# A v_sku_lt_teorico real é uma view composta; aqui ela é um stub que devolve o SLA
# teórico por SKU (é só o denominador do desvio/status — a lógica sob teste é a fonte).
P -q <<'SQL'
CREATE TABLE public.lt_teorico_seed (empresa text, sku_codigo_omie text, grupo_codigo text, lt_total_teorico_dias_uteis integer);
CREATE OR REPLACE VIEW public.v_sku_lt_teorico AS SELECT * FROM public.lt_teorico_seed;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
# A Fase 0 primeiro (cria v_sku_leadtime_efetivo, a fonte que a Fase 0-bis consome).
MIG0="$REPO_ROOT/supabase/migrations/20260716180000_leadtime_efetivo_dedup_nfe.sql"
MIG="$REPO_ROOT/supabase/migrations/20260716230000_sla_compliance_le_leadtime_efetivo.sql"

# A Fase 0 recria v_sku_leadtime_estatisticas, que lê sku_estoque_atual/sku_parametros.
# Criamos a v_sku_sla_compliance ORIGINAL (fonte crua) antes, pra o REPLACE da Fase 0-bis
# ter o que substituir E pra o baseline provar que o defeito existia.
P -q <<'SQL'
CREATE VIEW public.v_sku_sla_compliance AS
  WITH lt_observado AS (
    SELECT h.empresa::text AS empresa, h.sku_codigo_omie::text AS sku_codigo_omie,
           avg(h.lt_bruto_dias_uteis) AS lt_medio_observado,
           stddev_samp(h.lt_bruto_dias_uteis) AS lt_desvio_observado,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_mediana_observada,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_p95_observado,
           min(h.lt_bruto_dias_uteis) AS lt_min, max(h.lt_bruto_dias_uteis) AS lt_max,
           count(*) AS n_observacoes, max(h.t4_data_recebimento::date) AS ultimo_recebimento,
           avg(h.lt_faturamento_dias_uteis) AS lt_faturamento_medio,
           avg(h.lt_logistica_dias_uteis) AS lt_logistica_medio
    FROM sku_leadtime_history h WHERE h.lt_bruto_dias_uteis IS NOT NULL
    GROUP BY (h.empresa::text), (h.sku_codigo_omie::text)
  ), lt_recente AS (
    SELECT ranked.empresa::text AS empresa, ranked.sku_codigo_omie::text AS sku_codigo_omie,
           avg(ranked.lt_bruto_dias_uteis) AS lt_medio_recente, count(*) AS n_recentes
    FROM ( SELECT slh.empresa, slh.sku_codigo_omie, slh.lt_bruto_dias_uteis,
             row_number() OVER (PARTITION BY slh.empresa, slh.sku_codigo_omie ORDER BY slh.t4_data_recebimento DESC) AS rn
           FROM sku_leadtime_history slh WHERE slh.lt_bruto_dias_uteis IS NOT NULL) ranked
    WHERE ranked.rn <= 5 GROUP BY (ranked.empresa::text), (ranked.sku_codigo_omie::text)
  )
  SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
     sg.grupo_codigo, lts.lt_total_teorico_dias_uteis AS lt_teorico,
     round(lo.lt_medio_observado, 2) AS lt_observado_medio,
     round(lo.lt_desvio_observado, 2) AS lt_observado_desvio,
     round(lo.lt_mediana_observada::numeric, 1) AS lt_observado_mediana,
     round(lo.lt_p95_observado::numeric, 1) AS lt_observado_p95,
     lo.lt_min, lo.lt_max, lo.n_observacoes, lo.ultimo_recebimento,
     round(lo.lt_faturamento_medio, 2) AS lt_faturamento_medio,
     round(lo.lt_logistica_medio, 2) AS lt_logistica_medio,
     round(lr.lt_medio_recente, 2) AS lt_recente_medio, lr.n_recentes,
     round(lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric, 2) AS desvio_absoluto,
     round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1) AS desvio_perc,
     CASE WHEN lr.lt_medio_recente IS NULL OR lo.lt_medio_observado IS NULL THEN 'sem_dados'::text
          WHEN lr.lt_medio_recente < (lo.lt_medio_observado * 0.9) THEN 'melhorando'::text
          WHEN lr.lt_medio_recente > (lo.lt_medio_observado * 1.1) THEN 'piorando'::text
          ELSE 'estavel'::text END AS tendencia,
     CASE WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'sem_sla_teorico'::text
          WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 'poucos_dados'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 'cumprindo'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 'limite'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.50) THEN 'violando'::text
          ELSE 'critico'::text END AS status_sla
  FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN v_sku_lt_teorico lts ON lts.empresa = sp.empresa AND lts.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_observado lo ON lo.empresa = sp.empresa AND lo.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_recente lr ON lr.empresa = sp.empresa AND lr.sku_codigo_omie = sp.sku_codigo_omie::text;
SQL

P -q -f "$MIG0"
echo "migration aplicada: $(basename "$MIG0")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: reproduz os padrões medidos em prod
# ══════════════════════════════════════════════════════════════════════════════
# SKU 1001 "gate fabricado" — 1 NFe faturando 3 pedidos, cópias IDÊNTICAS (lt=5).
#            SLA teórico 5 ⇒ hoje n=3 e lt_medio=5 → status 'cumprindo'.
#            Depois: n=1 → 'poucos_dados'. É o caso dos SKUs de gate fabricado em prod.
# SKU 1002 "observação real" — 3 NFes distintas (lt=4,6,8). n=3 antes E depois.
# SKU 1004 "NULLS FIRST"     — 5 NFes com t4 conhecido (lt=10) + 1 NFe cujas 2 cópias
#            concordam em lt (=99) mas DIVERGEM em t4 ⇒ na view efetiva vira
#            lt_bruto=99 com t4 NULL (o padrão real de prod). Sem o filtro, o
#            `ORDER BY t4 DESC` (NULLS FIRST) a põe no topo do Top-5 e o lt_recente
#            salta de 10 para ~27,8 → tendencia vira 'piorando' FALSO.
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');

INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome) VALUES
  ('OBEN', 1001, 'SKU GATE FABRICADO', 'FORN X'),
  ('OBEN', 1002, 'SKU REAL',           'FORN X'),
  ('OBEN', 1004, 'SKU NULLS FIRST',    'FORN X');
INSERT INTO public.lt_teorico_seed (empresa, sku_codigo_omie, grupo_codigo, lt_total_teorico_dias_uteis) VALUES
  ('OBEN','1001','G1',5), ('OBEN','1002','G1',6), ('OBEN','1004','G1',10);

INSERT INTO public.purchase_orders_tracking (id, empresa, omie_codigo_pedido, nfe_chave_acesso, fornecedor_codigo_omie) VALUES
  ('a0000000-0000-0000-0000-000000000001','OBEN', 11, 'CHAVE_MULTI_A', 100),
  ('a0000000-0000-0000-0000-000000000002','OBEN', 12, 'CHAVE_MULTI_A', 100),
  ('a0000000-0000-0000-0000-000000000003','OBEN', 13, 'CHAVE_MULTI_A', 100),
  ('b0000000-0000-0000-0000-000000000001','OBEN', 21, 'CHAVE_SOLO_B1', 100),
  ('b0000000-0000-0000-0000-000000000002','OBEN', 22, 'CHAVE_SOLO_B2', 100),
  ('b0000000-0000-0000-0000-000000000003','OBEN', 23, 'CHAVE_SOLO_B3', 100),
  ('e0000000-0000-0000-0000-000000000001','OBEN', 51, 'CHAVE_E1', 100),
  ('e0000000-0000-0000-0000-000000000002','OBEN', 52, 'CHAVE_E2', 100),
  ('e0000000-0000-0000-0000-000000000003','OBEN', 53, 'CHAVE_E3', 100),
  ('e0000000-0000-0000-0000-000000000004','OBEN', 54, 'CHAVE_E4', 100),
  ('e0000000-0000-0000-0000-000000000005','OBEN', 55, 'CHAVE_E5', 100),
  ('f0000000-0000-0000-0000-000000000001','OBEN', 61, 'CHAVE_T4NULL', 100),
  ('f0000000-0000-0000-0000-000000000002','OBEN', 62, 'CHAVE_T4NULL', 100);

-- SKU 1001: 3 cópias IDÊNTICAS da mesma NFe (lt=5, SLA teórico 5 → 'cumprindo' hoje)
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('a0000000-0000-0000-0000-000000000001','OBEN',1001,'SKU GATE FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100),
  ('a0000000-0000-0000-0000-000000000002','OBEN',1001,'SKU GATE FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100),
  ('a0000000-0000-0000-0000-000000000003','OBEN',1001,'SKU GATE FABRICADO',100,'FORN X', now()-interval '10 days', now()-interval '5 days', 5, 1, 100);

-- SKU 1002: 3 NFes DISTINTAS (observação legítima — não pode ser colapsada)
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('b0000000-0000-0000-0000-000000000001','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '30 days', now()-interval '26 days', 4, 1, 50),
  ('b0000000-0000-0000-0000-000000000002','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '20 days', now()-interval '14 days', 6, 1, 50),
  ('b0000000-0000-0000-0000-000000000003','OBEN',1002,'SKU REAL',100,'FORN X', now()-interval '12 days', now()-interval  '4 days', 8, 1, 50);

-- SKU 1004: 5 observações reais (lt=10) — todas com t4 conhecido, mais ANTIGAS
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('e0000000-0000-0000-0000-000000000001','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '60 days', now()-interval '50 days', 10, 1, 30),
  ('e0000000-0000-0000-0000-000000000002','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '55 days', now()-interval '45 days', 10, 1, 30),
  ('e0000000-0000-0000-0000-000000000003','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '50 days', now()-interval '40 days', 10, 1, 30),
  ('e0000000-0000-0000-0000-000000000004','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '45 days', now()-interval '35 days', 10, 1, 30),
  ('e0000000-0000-0000-0000-000000000005','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '40 days', now()-interval '30 days', 10, 1, 30);

-- SKU 1004: a NFe venenosa — 2 cópias que CONCORDAM em lt (99) e DIVERGEM em t4.
-- Na view efetiva: lt_bruto=99 (concorda→passa), t4=NULL (diverge→NULL). É o padrão
-- do padrão de prod: lt válido com t4 indeterminado.
INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_descricao, fornecedor_codigo_omie, fornecedor_nome,
   t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total)
VALUES
  ('f0000000-0000-0000-0000-000000000001','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '20 days', now()-interval '10 days', 99, 1, 30),
  ('f0000000-0000-0000-0000-000000000002','OBEN',1004,'SKU NULLS FIRST',100,'FORN X', now()-interval '20 days', now()-interval  '3 days', 99, 1, 30);

GRANT SELECT ON public.sku_leadtime_history, public.purchase_orders_tracking, public.user_roles
  TO authenticated, anon;
GRANT SELECT ON public.v_sku_leadtime_history_normal TO authenticated, anon;
GRANT SELECT ON public.v_sku_leadtime_efetivo, public.v_sku_leadtime_estatisticas TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── baseline: o defeito EXISTE antes da migration (senão o teste prova o vazio) ──"

V=$(Pq -c "SELECT n_observacoes FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "B1 ANTES: SKU 1001 conta 3 observações (1 NFe replicada 3×)" "$V" "3"
V=$(Pq -c "SELECT status_sla FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "B2 ANTES: o gate >=3 cruza e o SLA vira veredito sobre dado fabricado" "$V" "cumprindo"
V=$(Pq -c "SELECT coalesce(lt_observado_desvio::text,'NULL') FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "B3 ANTES: desvio 0 fabricado (cópias idênticas ⇒ variância nula)" "$V" "0.00"
V=$(Pq -c "SELECT tendencia FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "B4 ANTES: SKU 1004 — o Top-5 cru já é contaminado pelas 2 cópias lt=99" "$V" "piorando"

# --- aplica a Fase 0-bis ---
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

echo "── asserts (depois) ──"

# --- A1: o gate deixa de ser cruzado por cópia ---
V=$(Pq -c "SELECT n_observacoes FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "A1 DEPOIS: SKU 1001 conta 1 observação (a NFe), não 3 linhas" "$V" "1"

# --- A2: o money-path — status_sla degrada honestamente ---
V=$(Pq -c "SELECT status_sla FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "A2 DEPOIS: sem 3 NFes reais, o SLA vira 'poucos_dados' (não um veredito inventado)" "$V" "poucos_dados"

# --- A3: o desvio fabricado some (ausente ≠ zero) ---
V=$(Pq -c "SELECT coalesce(lt_observado_desvio::text,'NULL') FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "A3 DEPOIS: desvio de 1 observação é NULL, não 0 (0 alegava precisão que não há)" "$V" "NULL"

# --- A4: o legítimo NÃO é destruído (a view não pode engolir observação real) ---
V=$(Pq -c "SELECT n_observacoes FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1002';")
eq "A4 3 NFes distintas continuam 3 observações (o fix não derruba o legítimo)" "$V" "3"
V=$(Pq -c "SELECT lt_observado_medio FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1002';")
eq "A4b média do legítimo intacta ((4+6+8)/3)" "$V" "6.00"
V=$(Pq -c "SELECT status_sla FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1002';")
eq "A4c o SKU com observação real MANTÉM veredito de SLA" "$V" "cumprindo"

# --- A5: NULLS FIRST — a observação de data indeterminada não vira "a mais recente" ---
V=$(Pq -c "SELECT n_recentes FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "A5 Top-5 do 1004 só conta observações com t4 conhecido" "$V" "5"
V=$(Pq -c "SELECT lt_recente_medio FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "A5b lt_recente = 10 (o lt=99 de t4 indeterminado ficou FORA do Top-5)" "$V" "10.00"
# A tendencia compara o Top-5 (recente) com a média histórica. Com o filtro, o Top-5 é
# [10×5] e a média histórica é (10×5+99)/6 = 24,83 ⇒ 'melhorando' é o veredito CORRETO
# (as datadas recentes são melhores que a média que inclui a NFe de lt=99). O que o fix
# muda é QUEM entra no Top-5 — F2b prova que sem o filtro isto vira 'piorando'.
# ⚠️ Não force 'estavel' aqui: a álgebra não permite. Para a sabotagem mudar o Top-5 o
# lt venenoso tem de ser extremo, e sendo extremo ele necessariamente puxa a média
# histórica para fora da banda de ±10% do 'estavel'. Exigir 'estavel' seria desenhar o
# assert para o valor bonito em vez do verdadeiro (foi o 1º erro deste harness).
V=$(Pq -c "SELECT tendencia FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "A5c tendencia sai do Top-5 SÓ com observação datada" "$V" "melhorando"

# --- A6: a observação de t4 NULL não SOME da base — ela só não concorre a recência ---
V=$(Pq -c "SELECT n_observacoes FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "A6 lt_observado ainda conta a NFe de t4 indeterminado (5 + 1 = 6)" "$V" "6"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (os asserts têm dente?) ──"

# F1 — sabotagem: lt_observado volta a ler a tabela CRUA. A1/A2 têm de ficar vermelhos.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS
  WITH lt_observado AS (
    SELECT h.empresa::text AS empresa, h.sku_codigo_omie::text AS sku_codigo_omie,
           avg(h.lt_bruto_dias_uteis) AS lt_medio_observado,
           stddev_samp(h.lt_bruto_dias_uteis) AS lt_desvio_observado,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_mediana_observada,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY (h.lt_bruto_dias_uteis::double precision)) AS lt_p95_observado,
           min(h.lt_bruto_dias_uteis) AS lt_min, max(h.lt_bruto_dias_uteis) AS lt_max,
           count(*) AS n_observacoes, max(h.t4_data_recebimento::date) AS ultimo_recebimento,
           avg(h.lt_faturamento_dias_uteis) AS lt_faturamento_medio,
           avg(h.lt_logistica_dias_uteis) AS lt_logistica_medio
    FROM sku_leadtime_history h WHERE h.lt_bruto_dias_uteis IS NOT NULL
    GROUP BY (h.empresa::text), (h.sku_codigo_omie::text)
  ), lt_recente AS (
    SELECT ranked.empresa::text AS empresa, ranked.sku_codigo_omie::text AS sku_codigo_omie,
           avg(ranked.lt_bruto_dias_uteis) AS lt_medio_recente, count(*) AS n_recentes
    FROM ( SELECT slh.empresa, slh.sku_codigo_omie, slh.lt_bruto_dias_uteis,
             row_number() OVER (PARTITION BY slh.empresa, slh.sku_codigo_omie ORDER BY slh.t4_data_recebimento DESC) AS rn
           FROM public.v_sku_leadtime_efetivo slh WHERE slh.lt_bruto_dias_uteis IS NOT NULL
             AND slh.t4_data_recebimento IS NOT NULL) ranked
    WHERE ranked.rn <= 5 GROUP BY (ranked.empresa::text), (ranked.sku_codigo_omie::text)
  )
  SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
     sg.grupo_codigo, lts.lt_total_teorico_dias_uteis AS lt_teorico,
     round(lo.lt_medio_observado, 2) AS lt_observado_medio,
     round(lo.lt_desvio_observado, 2) AS lt_observado_desvio,
     round(lo.lt_mediana_observada::numeric, 1) AS lt_observado_mediana,
     round(lo.lt_p95_observado::numeric, 1) AS lt_observado_p95,
     lo.lt_min, lo.lt_max, lo.n_observacoes, lo.ultimo_recebimento,
     round(lo.lt_faturamento_medio, 2) AS lt_faturamento_medio,
     round(lo.lt_logistica_medio, 2) AS lt_logistica_medio,
     round(lr.lt_medio_recente, 2) AS lt_recente_medio, lr.n_recentes,
     round(lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric, 2) AS desvio_absoluto,
     round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1) AS desvio_perc,
     CASE WHEN lr.lt_medio_recente IS NULL OR lo.lt_medio_observado IS NULL THEN 'sem_dados'::text
          WHEN lr.lt_medio_recente < (lo.lt_medio_observado * 0.9) THEN 'melhorando'::text
          WHEN lr.lt_medio_recente > (lo.lt_medio_observado * 1.1) THEN 'piorando'::text
          ELSE 'estavel'::text END AS tendencia,
     CASE WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'sem_sla_teorico'::text
          WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 'poucos_dados'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 'cumprindo'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 'limite'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.50) THEN 'violando'::text
          ELSE 'critico'::text END AS status_sla
  FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN v_sku_lt_teorico lts ON lts.empresa = sp.empresa AND lts.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_observado lo ON lo.empresa = sp.empresa AND lo.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_recente lr ON lr.empresa = sp.empresa AND lr.sku_codigo_omie = sp.sku_codigo_omie::text;
SQL
V=$(Pq -c "SELECT status_sla FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
if [ "$V" = "cumprindo" ]; then ok "F1 sabotagem (lt_observado volta à tabela crua) RESSUSCITA o veredito fabricado → A2 tinha dente"
else bad "F1 sabotei a fonte e o A2 seguiu verde (veio [$V]) — assert SEM dente"; fi

# F2 — sabotagem: tira SÓ o `t4 IS NOT NULL` do Top-5 (o resto do fix fica).
#      Isola a armadilha do NULLS FIRST: A5b/A5c têm de ficar vermelhos.
P -q -f "$MIG"
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_sku_sla_compliance AS
  WITH lt_observado AS (
    SELECT e.empresa::text AS empresa, e.sku_codigo_omie::text AS sku_codigo_omie,
           avg(e.lt_bruto_dias_uteis) AS lt_medio_observado,
           stddev_samp(e.lt_bruto_dias_uteis) AS lt_desvio_observado,
           percentile_cont(0.50) WITHIN GROUP (ORDER BY (e.lt_bruto_dias_uteis::double precision)) AS lt_mediana_observada,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY (e.lt_bruto_dias_uteis::double precision)) AS lt_p95_observado,
           min(e.lt_bruto_dias_uteis) AS lt_min, max(e.lt_bruto_dias_uteis) AS lt_max,
           count(*) AS n_observacoes, max(e.t4_data_recebimento::date) AS ultimo_recebimento,
           avg(e.lt_faturamento_dias_uteis) AS lt_faturamento_medio,
           avg(e.lt_logistica_dias_uteis) AS lt_logistica_medio
    FROM public.v_sku_leadtime_efetivo e WHERE e.lt_bruto_dias_uteis IS NOT NULL
    GROUP BY (e.empresa::text), (e.sku_codigo_omie::text)
  ), lt_recente AS (
    SELECT ranked.empresa::text AS empresa, ranked.sku_codigo_omie::text AS sku_codigo_omie,
           avg(ranked.lt_bruto_dias_uteis) AS lt_medio_recente, count(*) AS n_recentes
    FROM ( SELECT slh.empresa, slh.sku_codigo_omie, slh.lt_bruto_dias_uteis,
             row_number() OVER (PARTITION BY slh.empresa, slh.sku_codigo_omie ORDER BY slh.t4_data_recebimento DESC) AS rn
           FROM public.v_sku_leadtime_efetivo slh WHERE slh.lt_bruto_dias_uteis IS NOT NULL) ranked
    WHERE ranked.rn <= 5 GROUP BY (ranked.empresa::text), (ranked.sku_codigo_omie::text)
  )
  SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
     sg.grupo_codigo, lts.lt_total_teorico_dias_uteis AS lt_teorico,
     round(lo.lt_medio_observado, 2) AS lt_observado_medio,
     round(lo.lt_desvio_observado, 2) AS lt_observado_desvio,
     round(lo.lt_mediana_observada::numeric, 1) AS lt_observado_mediana,
     round(lo.lt_p95_observado::numeric, 1) AS lt_observado_p95,
     lo.lt_min, lo.lt_max, lo.n_observacoes, lo.ultimo_recebimento,
     round(lo.lt_faturamento_medio, 2) AS lt_faturamento_medio,
     round(lo.lt_logistica_medio, 2) AS lt_logistica_medio,
     round(lr.lt_medio_recente, 2) AS lt_recente_medio, lr.n_recentes,
     round(lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric, 2) AS desvio_absoluto,
     round((lo.lt_medio_observado - lts.lt_total_teorico_dias_uteis::numeric) / NULLIF(lts.lt_total_teorico_dias_uteis, 0)::numeric * 100::numeric, 1) AS desvio_perc,
     CASE WHEN lr.lt_medio_recente IS NULL OR lo.lt_medio_observado IS NULL THEN 'sem_dados'::text
          WHEN lr.lt_medio_recente < (lo.lt_medio_observado * 0.9) THEN 'melhorando'::text
          WHEN lr.lt_medio_recente > (lo.lt_medio_observado * 1.1) THEN 'piorando'::text
          ELSE 'estavel'::text END AS tendencia,
     CASE WHEN lts.lt_total_teorico_dias_uteis IS NULL THEN 'sem_sla_teorico'::text
          WHEN lo.n_observacoes IS NULL OR lo.n_observacoes < 3 THEN 'poucos_dados'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.05) THEN 'cumprindo'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.20) THEN 'limite'::text
          WHEN lo.lt_medio_observado <= (lts.lt_total_teorico_dias_uteis::numeric * 1.50) THEN 'violando'::text
          ELSE 'critico'::text END AS status_sla
  FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN v_sku_lt_teorico lts ON lts.empresa = sp.empresa AND lts.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_observado lo ON lo.empresa = sp.empresa AND lo.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN lt_recente lr ON lr.empresa = sp.empresa AND lr.sku_codigo_omie = sp.sku_codigo_omie::text;
SQL
V=$(Pq -c "SELECT lt_recente_medio FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
if [ "$V" != "10.00" ]; then ok "F2 sabotagem (sem 't4 IS NOT NULL') deixa a data indeterminada liderar o Top-5 → lt_recente vira [$V] em vez de 10 → A5b tinha dente"
else bad "F2 tirei o filtro de t4 e o A5b seguiu verde — assert SEM dente (o NULLS FIRST não estava sendo provado)"; fi
V=$(Pq -c "SELECT tendencia FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
if [ "$V" = "piorando" ]; then ok "F2b a sabotagem falseia a tendencia para 'piorando' → A5c tinha dente"
else bad "F2b tirei o filtro e a tendencia não mudou (veio [$V]) — A5c prova outra coisa"; fi

# restaura a versão verdadeira e re-confirma o verde
P -q -f "$MIG"
V=$(Pq -c "SELECT status_sla FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1001';")
eq "F3 migration restaurada: o fix volta a valer (gate)" "$V" "poucos_dados"
V=$(Pq -c "SELECT tendencia FROM public.v_sku_sla_compliance WHERE sku_codigo_omie='1004';")
eq "F3b migration restaurada: o fix volta a valer (NULLS FIRST)" "$V" "melhorando"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

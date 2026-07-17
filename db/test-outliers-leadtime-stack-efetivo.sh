#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260717003000_outliers_leadtime_stack_efetivo.sql                    ║
# ║      bash db/test-outliers-leadtime-stack-efetivo.sh > /tmp/t.log 2>&1; echo $? ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que se prova: a stack de outliers de leadtime (detectar → estimar →         ║
# ║  resolver) passa a ler v_sku_leadtime_efetivo, com identidade = NFe.           ║
# ║  Quatro defeitos, todos medidos na prod antes do apply:                        ║
# ║   1. FALSO-POSITIVO: a multiplicidade deprime o desvio e infla o z → a linha   ║
# ║      cruza o corte de 2σ. (Na prod é o dano REAL; a tese do falso-negativo     ║
# ║      tem zero instâncias — mas o mecanismo existe e o SKU 1003 aqui o exibe.)  ║
# ║   2. 42703 late-bound: estimar_impacto filtra por `data_pedido`, coluna que    ║
# ║      nunca existiu. CREATE passa, runtime estoura — sempre.                    ║
# ║   3. Round-trip de exclusão morto: resolver grava 'leadtime'/id::text, o       ║
# ║      detector procura 'lt'/tracking_id. Nunca casa.                            ║
# ║   4. 23502 armado: eventos_outlier.data_evento é NOT NULL e a view efetiva     ║
# ║      emite t4 NULL quando as cópias divergem ⇒ trocar só o FROM mataria o      ║
# ║      detector INTEIRO (a venda atípica junto, no mesmo CTE). Por isso t1.      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="outlierlt"
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
#   sku_leadtime_history.empresa   :: empresa_reposicao ENUM · .sku_codigo_omie :: bigint
#   eventos_outlier.empresa/.sku_codigo_omie :: text · .data_evento :: date NOT NULL
#   observacoes_excluidas UNIQUE (empresa, sku, tipo_observacao, data_observacao, referencia_original)
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

CREATE VIEW public.v_sku_leadtime_history_normal WITH (security_invoker = on) AS
  SELECT id, tracking_id, empresa, sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade,
         sku_ncm, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, quantidade_pedida,
         quantidade_recebida, valor_unitario, valor_total, t1_data_pedido, t2_data_faturamento,
         t3_data_cte, t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis,
         lt_logistica_dias_uteis, created_at, updated_at, origem_compra
  FROM public.sku_leadtime_history WHERE origem_compra = 'normal';

CREATE TABLE public.eventos_outlier (
  id bigserial PRIMARY KEY,
  empresa text, sku_codigo_omie text, sku_descricao text,
  tipo text, severidade text,
  data_evento date NOT NULL,          -- ⚠️ NOT NULL: é a armadilha do 23502 (defeito 4)
  valor_observado numeric, valor_esperado numeric, desvios_padrao numeric,
  detalhes jsonb, status text DEFAULT 'pendente',
  decidido_em timestamptz, decidido_por text, justificativa_decisao text,
  detectado_em timestamptz DEFAULT now()
);

CREATE TABLE public.observacoes_excluidas (
  id bigserial PRIMARY KEY,
  empresa text, sku_codigo_omie text, tipo_observacao text, data_observacao date,
  referencia_original text, valor_excluido numeric,
  excluido_em timestamptz DEFAULT now(), excluido_por text,
  evento_outlier_id bigint REFERENCES public.eventos_outlier(id), justificativa text,
  UNIQUE (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
);

CREATE TABLE public.venda_items_history (
  empresa public.empresa_reposicao, sku_codigo_omie bigint, sku_descricao text,
  data_emissao timestamptz, quantidade numeric, nfe_chave_acesso text
);

CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, demanda_media_diaria numeric, lt_medio_dias_uteis numeric
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2a — AS FUNÇÕES ORIGINAIS DA PROD (baseline: prova que o defeito existia)
# ══════════════════════════════════════════════════════════════════════════════
# Corpos capturados via pg_get_functiondef na prod em 2026-07-16, antes do REPLACE.
# Só o que importa para o baseline do leadtime — o ramo de venda vai idêntico.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.detectar_outliers_empresa(p_empresa text DEFAULT 'OBEN'::text)
 RETURNS TABLE(tipo text, novos_eventos integer, eventos_criticos integer)
 LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_lt_novos INT := 0;
  v_lt_criticos INT := 0;
BEGIN
  WITH estatisticas_lt AS (
    SELECT empresa::text as empresa, sku_codigo_omie::text as sku_codigo_omie,
      AVG(lt_bruto_dias_uteis) as lt_medio, STDDEV_SAMP(lt_bruto_dias_uteis) as lt_desvio
    FROM sku_leadtime_history WHERE lt_bruto_dias_uteis IS NOT NULL
    GROUP BY empresa::text, sku_codigo_omie::text HAVING COUNT(*) >= 3
  ),
  lts_anomalos AS (
    SELECT h.empresa::text as empresa, h.sku_codigo_omie::text as sku_codigo_omie,
      h.tracking_id::text as tracking_id, h.t4_data_recebimento::date as data_evento,
      h.lt_bruto_dias_uteis, e.lt_medio, e.lt_desvio,
      (h.lt_bruto_dias_uteis - e.lt_medio) / NULLIF(e.lt_desvio, 0) as z
    FROM sku_leadtime_history h
    JOIN estatisticas_lt e ON e.empresa = h.empresa::text AND e.sku_codigo_omie = h.sku_codigo_omie::text
    WHERE h.empresa::text = p_empresa AND h.lt_bruto_dias_uteis IS NOT NULL AND e.lt_desvio > 0
      AND (h.lt_bruto_dias_uteis - e.lt_medio) / e.lt_desvio > 2
  ),
  para_inserir_lt AS (
    SELECT la.* FROM lts_anomalos la
    WHERE NOT EXISTS (SELECT 1 FROM eventos_outlier eo WHERE eo.empresa = la.empresa
        AND eo.sku_codigo_omie = la.sku_codigo_omie AND eo.tipo = 'lt_atipico'
        AND eo.detalhes->>'tracking_id' = la.tracking_id)
    AND NOT EXISTS (SELECT 1 FROM observacoes_excluidas oe WHERE oe.empresa = la.empresa
        AND oe.sku_codigo_omie = la.sku_codigo_omie AND oe.tipo_observacao = 'lt'
        AND oe.referencia_original = la.tracking_id)
  ),
  inseridos_lt AS (
    INSERT INTO eventos_outlier (empresa, sku_codigo_omie, sku_descricao, tipo, severidade,
      data_evento, valor_observado, valor_esperado, desvios_padrao, detalhes)
    SELECT pi.empresa, pi.sku_codigo_omie,
      (SELECT MAX(sku_descricao) FROM venda_items_history WHERE sku_codigo_omie::text = pi.sku_codigo_omie),
      'lt_atipico',
      CASE WHEN pi.z > 4 THEN 'critico' WHEN pi.z > 3 THEN 'atencao' ELSE 'info' END,
      pi.data_evento, pi.lt_bruto_dias_uteis, ROUND(pi.lt_medio, 1), ROUND(pi.z, 2),
      jsonb_build_object('tracking_id', pi.tracking_id, 'lt_desvio', pi.lt_desvio,
        'mensagem', 'Pedido chegou em ' || pi.lt_bruto_dias_uteis || ' dias úteis.')
    FROM para_inserir_lt pi RETURNING severidade
  )
  SELECT COUNT(*), COUNT(*) FILTER (WHERE severidade = 'critico')
  INTO v_lt_novos, v_lt_criticos FROM inseridos_lt;
  RETURN QUERY SELECT 'lt_atipico'::text, v_lt_novos, v_lt_criticos;
END;
$function$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: reproduz, caso a caso, os padrões medidos em prod
# ══════════════════════════════════════════════════════════════════════════════
# Helper: cria N trackings da MESMA NFe e 1 linha de leadtime por tracking (= as N cópias
# que o writer pré-#1345 gravava). t4 e lt parametrizados p/ construir cada caso.
P -q <<'SQL'
CREATE FUNCTION pg_temp.semear(
  p_sku bigint, p_nfe text, p_copias int, p_lt int,
  p_t1 date, p_t4 date, p_t4_divergente boolean DEFAULT false, p_lt_divergente int DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE i int; v_tid uuid;
BEGIN
  FOR i IN 1..p_copias LOOP
    INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido, nfe_chave_acesso)
    VALUES ('OBEN', 9000 + i, p_nfe) RETURNING id INTO v_tid;
    INSERT INTO public.sku_leadtime_history (
      tracking_id, empresa, sku_codigo_omie, sku_descricao, t1_data_pedido, t2_data_faturamento,
      t4_data_recebimento, lt_bruto_dias_uteis, quantidade_recebida, valor_total, valor_unitario, origem_compra)
    VALUES (
      v_tid, 'OBEN', p_sku, 'SKU ' || p_sku, p_t1, p_t1 + 1,
      -- t4 divergente entre as cópias ⇒ a view efetiva emite t4 NULL (concorda-ou-NULL)
      CASE WHEN p_t4_divergente THEN p_t4 + i ELSE p_t4 END,
      -- lt divergente entre as cópias ⇒ a view efetiva emite lt NULL
      CASE WHEN p_lt_divergente IS NOT NULL AND i = 1 THEN p_lt_divergente ELSE p_lt END,
      10, 100, 10, 'normal');
  END LOOP;
END; $f$;

-- ── SKU 1001 — FALSO-POSITIVO (o dano REAL medido em prod) ────────────────────
-- NFe-A ×4 cópias idênticas (lt=5) + NFe-B (5) + NFe-C (5) + NFe-D (8).
--   cru      → [5,5,5,5,5,5,8] n=7, σ=1.13 ⇒ z(8)=2.27 > 2  ⇒ FLAGRA (falso-positivo)
--   efetiva  → [5,5,5,8]       n=4, σ=1.50 ⇒ z(8)=1.50 ≤ 2  ⇒ não flagra
SELECT pg_temp.semear(1001, 'NFE-1001-A', 4, 5, DATE '2026-05-04', DATE '2026-05-11');
SELECT pg_temp.semear(1001, 'NFE-1001-B', 1, 5, DATE '2026-05-05', DATE '2026-05-12');
SELECT pg_temp.semear(1001, 'NFE-1001-C', 1, 5, DATE '2026-05-06', DATE '2026-05-13');
SELECT pg_temp.semear(1001, 'NFE-1001-D', 1, 8, DATE '2026-05-07', DATE '2026-05-19');

-- ── SKU 1002 — OUTLIER REAL (controle: flagrado ANTES e DEPOIS) ───────────────
-- 5 NFes distintas (lt=5) + 1 NFe (lt=12). Sem duplicação: cru = efetiva.
--   ambos → [5,5,5,5,5,12] n=6, σ=2.86 ⇒ z(12)=2.04 > 2 ⇒ FLAGRA
SELECT pg_temp.semear(1002, 'NFE-1002-' || g, 1, 5, DATE '2026-05-04' + g, DATE '2026-05-11' + g)
FROM generate_series(1,5) g;
SELECT pg_temp.semear(1002, 'NFE-1002-X', 1, 12, DATE '2026-05-20', DATE '2026-06-05');

-- ── SKU 1003 — ARMADILHA t4 NULL + falso-NEGATIVO ─────────────────────────────
-- 5 NFes (lt=5) + NFe-X com 2 cópias que CONCORDAM em lt(12) e t1 mas DIVERGEM em t4.
--   cru      → [5,5,5,5,5,12,12] n=7, σ=3.42 ⇒ z(12)=1.50 ≤ 2 ⇒ NÃO flagra (o outlier some)
--   efetiva  → [5,5,5,5,5,12]    n=6, σ=2.86 ⇒ z(12)=2.04 > 2 ⇒ FLAGRA
--   E o par flagrado tem t4 NULL ⇒ com `data_evento := t4` o INSERT estoura 23502 e
--   derruba a função INTEIRA. Este SKU é o que prova a guarda de t1.
SELECT pg_temp.semear(1003, 'NFE-1003-' || g, 1, 5, DATE '2026-05-04' + g, DATE '2026-05-11' + g)
FROM generate_series(1,5) g;
SELECT pg_temp.semear(1003, 'NFE-1003-X', 2, 12, DATE '2026-05-20', DATE '2026-06-05', true);

-- ── SKU 1004 — GATE FABRICADO (confiança inventada pela multiplicidade) ───────
-- NFe-A ×6 cópias idênticas (lt=5) + NFe-B (lt=9).
--   cru      → [5,5,5,5,5,5,9] n=7 ≥ 3 ⇒ passa o gate, σ=1.51 ⇒ z(9)=2.27 ⇒ FLAGRA
--   efetiva  → [5,9]           n=2 < 3 ⇒ REPROVA o gate ⇒ sem estatística, sem evento
SELECT pg_temp.semear(1004, 'NFE-1004-A', 6, 5, DATE '2026-05-04', DATE '2026-05-11');
SELECT pg_temp.semear(1004, 'NFE-1004-B', 1, 9, DATE '2026-05-07', DATE '2026-05-20');

-- ── SKU 1005 — lt INDETERMINADO (as cópias discordam do leadtime) ─────────────
-- 5 NFes (lt=5) + NFe-Z com 2 cópias que DISCORDAM (40 e 12).
--   cru      → [5,5,5,5,5,12,40] n=7, σ=13.05 ⇒ z(40)=2.22 > 2 ⇒ FLAGRA
--   efetiva  → NFe-Z vira lt NULL (não sabemos qual cópia está certa) ⇒ sai da estatística
--              → [5,5,5,5,5] σ=0 ⇒ `lt_desvio > 0` é falso ⇒ não flagra. Ausente ≠ zero.
SELECT pg_temp.semear(1005, 'NFE-1005-' || g, 1, 5, DATE '2026-05-04' + g, DATE '2026-05-11' + g)
FROM generate_series(1,5) g;
SELECT pg_temp.semear(1005, 'NFE-1005-Z', 2, 12, DATE '2026-05-20', DATE '2026-06-05', false, 40);

-- ── SKU 1006 — SEM NFe (o caminho que o dedup_key cobre e a NFe não) ─────────
-- 6 trackings SEM nfe_chave_acesso (lt=5 ×5 + lt=12). Cada linha vira o próprio grupo:
-- dedup_key = 'tracking:<id>'. Flagrado nas duas fontes (não há duplicação aqui).
--   É o único caso em que a mudança do COALESCE do resolver é observável: onde a NFe
--   existe, 'nfe' == 'dedup_key' e o COALESCE antigo acertaria por coincidência.
--   Zero casos na prod hoje — guarda de futuro, provada aqui.
SELECT pg_temp.semear(1006, NULL::text, 1, 5, DATE '2026-05-04' + g, DATE '2026-05-11' + g)
FROM generate_series(1,5) g;
SELECT pg_temp.semear(1006, NULL::text, 1, 12, DATE '2026-05-20', DATE '2026-06-05');

-- staff p/ os gates das RPCs SECURITY DEFINER
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO auth.users(id) VALUES ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','employee');
-- 2222… fica SEM role: é o não-staff dos asserts negativos.
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4a — BASELINE: o detector CRU produz os eventos (incl. os falsos-positivos)
# ══════════════════════════════════════════════════════════════════════════════
echo "── baseline (fonte crua, como está na prod hoje) ──"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');"

V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE tipo='lt_atipico';")
eq "B1 detector cru emite eventos (1001,1002,1004,1005,1006)" "$V" "5"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "B2 1001 (falso-positivo) É flagrado pela fonte crua" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
eq "B3 1003 (outlier real) NÃO é flagrado pela fonte crua — a cópia o esconde" "$V" "0"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1004';")
eq "B4 1004 (gate fabricado) É flagrado pela fonte crua" "$V" "1"
V=$(Pq -c "SELECT (detalhes ? 'tracking_id')::text FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "B5 identidade antiga = tracking_id" "$V" "true"

# O 42703 do estimar_impacto, provado ANTES do fix (defeito 2).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_evento RECORD; v_sigma_atual numeric; v_media_atual numeric; v_sigma_sem numeric; v_media_sem numeric;
BEGIN
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_atual, v_sigma_atual
  FROM sku_leadtime_history WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie;
  SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_sem, v_sigma_sem
  FROM sku_leadtime_history WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
    AND NOT (data_pedido::date = v_evento.data_evento);
  RETURN jsonb_build_object('sigma_atual', v_sigma_atual, 'sigma_sem', v_sigma_sem);
END; $function$;
SQL
EVID=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1002' LIMIT 1;")
R=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.estimar_impacto_exclusao_outlier($EVID);
  RAISE NOTICE 'SENTINELA_RODOU_LIMPO';
EXCEPTION
  WHEN undefined_column THEN RAISE NOTICE 'SENTINELA_ESTOUROU_42703';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_ESTOUROU_42703*) ok "B6 estimar_impacto ORIGINAL estoura 42703 em runtime (o CREATE tinha passado) — o defeito é real" ;;
  *) bad "B6 esperava 42703 do 'data_pedido' inexistente e não veio: [$R]" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2b — APLICAR AS MIGRATIONS REAIS (Lei #1: o .sql commitado)
# ══════════════════════════════════════════════════════════════════════════════
MIG0="$REPO_ROOT/supabase/migrations/20260716180000_leadtime_efetivo_dedup_nfe.sql"
MIG="$REPO_ROOT/supabase/migrations/20260717003000_outliers_leadtime_stack_efetivo.sql"

# A Fase 0 primeiro: cria v_sku_leadtime_efetivo, a fonte que esta migration consome.
P -q -f "$MIG0"
echo "migration aplicada: $(basename "$MIG0")"

# O resolver original precisa existir p/ o REPLACE ter o que substituir (e p/ o F4 restaurar).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$ BEGIN RETURN jsonb_build_object('stub', true); END; $function$;
SQL

P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4b — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: backfill + aposentadoria (seções 4 e 5 da migration) ──"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE tipo='lt_atipico' AND NOT (detalhes ? 'dedup_key');")
eq "A1 backfill: todo evento de leadtime ganhou a identidade nova (dedup_key)" "$V" "0"
V=$(Pq -c "SELECT detalhes->>'dedup_key' FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "A2 backfill mapeou tracking_id → a NFe certa" "$V" "NFE-1001-D"
V=$(Pq -c "SELECT data_evento::text FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "A3 data_evento realinhada para t1 (era t4; o gráfico do drill plota t1)" "$V" "2026-05-07"

V=$(Pq -c "SELECT status FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "A4 1001 (falso-positivo) aposentado" "$V" "resolvido_auto"
V=$(Pq -c "SELECT justificativa_decisao ~ 'não atinge o corte' FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "A5 1001 aposentado com o motivo CERTO (avaliável, não é outlier)" "$V" "t"
V=$(Pq -c "SELECT status FROM public.eventos_outlier WHERE sku_codigo_omie='1002';")
eq "A6 1002 (outlier real) PRESERVADO pendente — a aposentadoria não é atacado geral" "$V" "pendente"
V=$(Pq -c "SELECT justificativa_decisao ~ 'sem base para avaliar' FROM public.eventos_outlier WHERE sku_codigo_omie='1004';")
eq "A7 1004 (gate fabricado) aposentado por FALTA DE BASE, não por 'não é outlier'" "$V" "t"
V=$(Pq -c "SELECT justificativa_decisao ~ 'sem base para avaliar' FROM public.eventos_outlier WHERE sku_codigo_omie='1005';")
eq "A8 1005 (lt indeterminado) aposentado por FALTA DE BASE" "$V" "t"

echo "── asserts: o detector corrigido ──"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
eq "A9 1003: o detector corrigido ACHA o outlier que a cópia escondia" "$V" "1"
V=$(Pq -c "SELECT data_evento::text FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
eq "A10 1003: data_evento = t1 — e o par tem t4 NULL (com t4 o INSERT daria 23502)" "$V" "2026-05-20"
V=$(Pq -c "SELECT (t4_data_recebimento IS NULL)::text FROM public.v_sku_leadtime_efetivo WHERE dedup_key='NFE-1003-X';")
eq "A11 (premissa do A10) o par do 1003 tem mesmo t4 indeterminado na view efetiva" "$V" "true"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1002';")
eq "A12 1002: não duplica o evento — a dedup por dedup_key reconhece o backfill" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie IN ('1001','1004','1005') AND status='pendente';")
eq "A13 1001/1004/1005 não voltam: o detector corrigido não os flagra" "$V" "0"

echo "── asserts: estimar_impacto (defeito 2) ──"
EV1003=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1003' LIMIT 1;")
V=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.estimar_impacto_exclusao_outlier($EV1003)->>'sigma_atual';" | tail -1)
eq "A14 estimar_impacto NÃO estoura mais 42703 e devolve o sigma da fonte efetiva" "$V" "2.86"
V=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.estimar_impacto_exclusao_outlier($EV1003)->>'sigma_sem';" | tail -1)
eq "A15 estimar_impacto exclui a observação PELA NFe (σ sem o outlier = 0)" "$V" "0.00"

# Negativo: evento sem dedup_key → error explícito, NUNCA zeros fabricados (ausente ≠ zero).
# CTE em volta do INSERT: `psql -tA -c "INSERT ... RETURNING"` imprime a tag "INSERT 0 1"
# JUNTO do id, e o id sujo quebra a query seguinte.
V=$(Pq -c "
  WITH i AS (
    INSERT INTO public.eventos_outlier (empresa, sku_codigo_omie, tipo, severidade, data_evento, detalhes)
    VALUES ('OBEN','1002','lt_atipico','info', DATE '2026-05-20', '{}'::jsonb) RETURNING id
  ) SELECT id FROM i;")
R=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.estimar_impacto_exclusao_outlier($V)->>'error';" | tail -1)
case "$R" in
  *"não estimável"*) ok "A16 evento sem identidade → 'error' explícito, não impacto zero fabricado" ;;
  *) bad "A16 esperava error de não-estimável, veio [$R]" ;;
esac
R=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.estimar_impacto_exclusao_outlier($V)->>'sigma_atual';" | tail -1)
eq "A17 …e NÃO devolve sigma junto do error (a tela cairia no ramo de sucesso)" "$R" ""
P -q -c "DELETE FROM public.eventos_outlier WHERE id=$V;"

# Negativo com SQLSTATE + re-raise (Lei #2). Sentinela não contém o texto que o código emite.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='22222222-2222-2222-2222-222222222222';
DO \$\$
BEGIN
  PERFORM public.estimar_impacto_exclusao_outlier($EV1003);
  RAISE NOTICE 'SENTINELA_PASSOU_SEM_GATE';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_GATE_BARROU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_GATE_BARROU*) ok "A18 estimar_impacto: não-staff barrado com 42501 (gate preservado)" ;;
  *) bad "A18 gate de staff do estimar_impacto não barrou: [$R]" ;;
esac

echo "── asserts: resolver_outlier + round-trip da exclusão (defeito 3) ──"
EV1002=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1002' AND status='pendente' LIMIT 1;")
P -q -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.resolver_outlier($EV1002, 'excluir', 'teste', 'a@b.c');"
V=$(Pq -c "SELECT referencia_original FROM public.observacoes_excluidas WHERE evento_outlier_id=$EV1002;")
eq "A19 resolver grava referencia_original = dedup_key (era id::text, que nada casava)" "$V" "NFE-1002-X"
V=$(Pq -c "SELECT tipo_observacao FROM public.observacoes_excluidas WHERE evento_outlier_id=$EV1002;")
eq "A20 resolver grava tipo_observacao='leadtime' (o detector procurava 'lt')" "$V" "leadtime"

# O round-trip: a observação excluída não pode voltar a virar evento.
# Apagar o evento é ESSENCIAL p/ isolar: `para_inserir_lt` tem DOIS NOT EXISTS (um contra
# eventos_outlier, outro contra observacoes_excluidas). Com o evento vivo, o primeiro
# suprimiria sozinho e o assert provaria a coisa errada. Solta a FK antes do DELETE — a
# linha de exclusão sobrevive ao evento, que é justamente o que se quer provar.
P -q -c "UPDATE public.observacoes_excluidas SET evento_outlier_id=NULL WHERE evento_outlier_id=$EV1002;"
P -q -c "DELETE FROM public.eventos_outlier WHERE sku_codigo_omie='1002';"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1002';")
eq "A21 ROUND-TRIP FECHA: observação excluída não é re-flagrada (antes voltava sempre)" "$V" "0"

R=$(P -tA 2>&1 <<SQL || true
SET test.uid='22222222-2222-2222-2222-222222222222';
DO \$\$
BEGIN
  PERFORM public.resolver_outlier($EV1003, 'ignorar', NULL, NULL);
  RAISE NOTICE 'SENTINELA_PASSOU_SEM_GATE';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_GATE_BARROU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_GATE_BARROU*) ok "A22 resolver_outlier: não-staff barrado com 42501 (gate preservado)" ;;
  *) bad "A22 gate de staff do resolver não barrou: [$R]" ;;
esac

# O caminho SEM NFe — o único em que a mudança do COALESCE do resolver é observável.
EV1006=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1006' AND status='pendente' LIMIT 1;")
V=$(Pq -c "SELECT ((detalhes->>'nfe') IS NULL)::text FROM public.eventos_outlier WHERE id=$EV1006;")
eq "A23 (premissa) o evento do 1006 não tem NFe — a identidade cai em 'tracking:<id>'" "$V" "true"
P -q -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.resolver_outlier($EV1006,'excluir','x','a@b.c');" >/dev/null
V=$(Pq -c "SELECT (referencia_original LIKE 'tracking:%')::text FROM public.observacoes_excluidas WHERE evento_outlier_id=$EV1006;")
eq "A24 resolver: sem NFe, a referência é o dedup_key — não o id do evento (o fallback antigo)" "$V" "true"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — sabota SÓ a fonte do detector (volta pra tabela crua). O resto do fix fica.
#      Se o A13 tinha dente, o falso-positivo do 1001 tem de RESSUSCITAR.
# exclusões ANTES dos eventos: a FK observacoes_excluidas → eventos_outlier barra o inverso
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier WHERE tipo='lt_atipico';"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.detectar_outliers_empresa(p_empresa text DEFAULT 'OBEN'::text)
 RETURNS TABLE(tipo text, novos_eventos integer, eventos_criticos integer)
 LANGUAGE plpgsql SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_lt_novos INT := 0; v_lt_criticos INT := 0;
BEGIN
  WITH estatisticas_lt AS (
    SELECT empresa::text as empresa, sku_codigo_omie::text as sku_codigo_omie,
      AVG(lt_bruto_dias_uteis) as lt_medio, STDDEV_SAMP(lt_bruto_dias_uteis) as lt_desvio
    FROM sku_leadtime_history WHERE lt_bruto_dias_uteis IS NOT NULL   -- ← SABOTAGEM: fonte crua
    GROUP BY empresa::text, sku_codigo_omie::text HAVING COUNT(*) >= 3
  ),
  lts_anomalos AS (
    SELECT h.empresa::text as empresa, h.sku_codigo_omie::text as sku_codigo_omie,
      COALESCE(pot.nfe_chave_acesso,'?') as dedup_key, h.t1_data_pedido::date as data_evento,
      h.lt_bruto_dias_uteis, e.lt_medio, e.lt_desvio,
      (h.lt_bruto_dias_uteis - e.lt_medio) / NULLIF(e.lt_desvio, 0) as z
    FROM sku_leadtime_history h
    LEFT JOIN purchase_orders_tracking pot ON pot.id = h.tracking_id
    JOIN estatisticas_lt e ON e.empresa = h.empresa::text AND e.sku_codigo_omie = h.sku_codigo_omie::text
    WHERE h.empresa::text = p_empresa AND h.lt_bruto_dias_uteis IS NOT NULL
      AND h.t1_data_pedido IS NOT NULL AND e.lt_desvio > 0
      AND (h.lt_bruto_dias_uteis - e.lt_medio) / e.lt_desvio > 2
  ),
  para_inserir_lt AS (
    SELECT DISTINCT ON (la.sku_codigo_omie, la.dedup_key) la.* FROM lts_anomalos la
    WHERE NOT EXISTS (SELECT 1 FROM eventos_outlier eo WHERE eo.empresa = la.empresa
        AND eo.sku_codigo_omie = la.sku_codigo_omie AND eo.tipo='lt_atipico'
        AND eo.detalhes->>'dedup_key' = la.dedup_key)
  ),
  inseridos_lt AS (
    INSERT INTO eventos_outlier (empresa, sku_codigo_omie, tipo, severidade, data_evento,
      valor_observado, valor_esperado, desvios_padrao, detalhes)
    SELECT pi.empresa, pi.sku_codigo_omie, 'lt_atipico',
      CASE WHEN pi.z > 4 THEN 'critico' WHEN pi.z > 3 THEN 'atencao' ELSE 'info' END,
      pi.data_evento, pi.lt_bruto_dias_uteis, ROUND(pi.lt_medio,1), ROUND(pi.z,2),
      jsonb_build_object('dedup_key', pi.dedup_key)
    FROM para_inserir_lt pi RETURNING severidade
  )
  SELECT COUNT(*), COUNT(*) FILTER (WHERE severidade='critico') INTO v_lt_novos, v_lt_criticos FROM inseridos_lt;
  RETURN QUERY SELECT 'lt_atipico'::text, v_lt_novos, v_lt_criticos;
END; $function$;
SQL
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
if [ "$V" = "1" ]; then ok "F1 sabotagem (fonte volta a ser a tabela crua) RESSUSCITA o falso-positivo do 1001 → A13 tinha dente"
else bad "F1 sabotei a fonte e o 1001 seguiu limpo (veio [$V]) — o assert do falso-positivo NÃO prova nada"; fi
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
if [ "$V" = "0" ]; then ok "F1b …e o outlier real do 1003 volta a SUMIR → A9 tinha dente"
else bad "F1b sabotei a fonte e o 1003 seguiu flagrado (veio [$V]) — A9 prova outra coisa"; fi

# F2 — sabota SÓ o `data_evento := t1` (volta pra t4). Isola a armadilha do 23502.
#      O INSERT vai INLINE no DO: `pg_temp` é por SESSÃO e cada `P` abre uma psql nova —
#      criar a função num heredoc e chamá-la noutro dá "schema pg_temp does not exist".
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier WHERE tipo='lt_atipico';"
P -q -f "$MIG" >/dev/null    # restaura a versão verdadeira antes de sabotar outro ponto
R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  INSERT INTO public.eventos_outlier (empresa, sku_codigo_omie, tipo, severidade, data_evento,
    valor_observado, detalhes)
  SELECT h.empresa::text, h.sku_codigo_omie::text, 'lt_atipico', 'info',
         h.t4_data_recebimento::date,          -- ← SABOTAGEM: t4 em vez de t1
         h.lt_bruto_dias_uteis, jsonb_build_object('dedup_key', h.dedup_key)
  FROM public.v_sku_leadtime_efetivo h
  WHERE h.dedup_key = 'NFE-1003-X' AND h.lt_bruto_dias_uteis IS NOT NULL;
  RAISE NOTICE 'SENTINELA_INSERIU_COM_T4';
EXCEPTION
  WHEN not_null_violation THEN RAISE NOTICE 'SENTINELA_ESTOUROU_23502';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *SENTINELA_ESTOUROU_23502*) ok "F2 sabotagem (data_evento := t4) estoura 23502 e mataria o detector INTEIRO → a guarda de t1 tinha dente" ;;
  *) bad "F2 usei t4 e o INSERT passou: [$R] — a armadilha do NOT NULL não estava sendo provada" ;;
esac

# F3 — sabota SÓ o estimar_impacto (volta o `data_pedido` inexistente). O 42703 tem de voltar.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_evento RECORD; v_media_sem numeric; v_sigma_sem numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_sem, v_sigma_sem
  FROM sku_leadtime_history WHERE empresa::text = v_evento.empresa
    AND NOT (data_pedido::date = v_evento.data_evento);   -- ← SABOTAGEM: coluna inexistente
  RETURN jsonb_build_object('sigma_sem', v_sigma_sem);
END; $function$;
SQL
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
EVF=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1003' LIMIT 1;")
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='11111111-1111-1111-1111-111111111111';
DO \$\$
BEGIN
  PERFORM public.estimar_impacto_exclusao_outlier($EVF);
  RAISE NOTICE 'SENTINELA_RODOU_LIMPO';
EXCEPTION
  WHEN undefined_column THEN RAISE NOTICE 'SENTINELA_ESTOUROU_42703';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_ESTOUROU_42703*) ok "F3 sabotagem (volta o 'data_pedido') RESSUSCITA o 42703 → A14 tinha dente" ;;
  *) bad "F3 devolvi a coluna inexistente e nada estourou: [$R] — A14 não prova o late-bound" ;;
esac

# F4 — sabota SÓ o `tipo_observacao='leadtime'` do detector (volta pro 'lt' da prod).
#      É o ponto do defeito 3 que morde HOJE: resolver sempre gravou 'leadtime' e o
#      detector sempre procurou 'lt'. O round-trip (A21) tem de quebrar.
#      (Tentar sabotar o COALESCE do resolver aqui NÃO prova nada: onde a NFe existe,
#       'nfe' == 'dedup_key' e o COALESCE antigo acerta por coincidência. Esse ramo é
#       isolado no F4b, com o SKU 1006, que não tem NFe.)
P -q -f "$MIG" >/dev/null
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier WHERE tipo='lt_atipico';"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
EVS=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1003' LIMIT 1;")
P -q -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.resolver_outlier($EVS,'excluir','x','a@b.c');" >/dev/null
P -q -c "UPDATE public.observacoes_excluidas SET evento_outlier_id=NULL WHERE evento_outlier_id=$EVS;"
P -q -c "DELETE FROM public.eventos_outlier WHERE sku_codigo_omie='1003';"
P -q -c "UPDATE public.observacoes_excluidas SET tipo_observacao='lt' WHERE tipo_observacao='leadtime';"  # ← SABOTAGEM equivalente ao detector procurar 'lt'
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
if [ "$V" = "1" ]; then ok "F4 sabotagem ('lt' ≠ 'leadtime') RE-FLAGRA a observação excluída → A21 tinha dente"
else bad "F4 desalinhei o tipo_observacao e a exclusão seguiu valendo (veio [$V]) — A21 não prova o round-trip"; fi

# F4b — sabota SÓ o COALESCE do resolver (tira o dedup_key da frente), no SKU 1006 (sem
#       NFe). Sem dedup_key o COALESCE cai em `id::text` e a exclusão deixa de casar.
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier WHERE tipo='lt_atipico';"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_evento RECORD;
BEGIN
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  UPDATE eventos_outlier SET status='excluido', decidido_em=now() WHERE id=p_evento_id;
  INSERT INTO observacoes_excluidas (empresa, sku_codigo_omie, tipo_observacao, data_observacao,
    referencia_original, valor_excluido, evento_outlier_id)
  VALUES (v_evento.empresa, v_evento.sku_codigo_omie,
    CASE WHEN v_evento.tipo='venda_atipica' THEN 'venda' ELSE 'leadtime' END, v_evento.data_evento,
    COALESCE(v_evento.detalhes->>'nfe', v_evento.detalhes->>'pedido_compra', v_evento.id::text), -- ← SABOTAGEM: sem dedup_key
    v_evento.valor_observado, v_evento.id);
  RETURN jsonb_build_object('ok', true);
END; $function$;
SQL
EVB=$(Pq -c "SELECT id FROM public.eventos_outlier WHERE sku_codigo_omie='1006' LIMIT 1;")
P -q -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SELECT public.resolver_outlier($EVB,'excluir','x','a@b.c');" >/dev/null
P -q -c "UPDATE public.observacoes_excluidas SET evento_outlier_id=NULL WHERE evento_outlier_id=$EVB;"
P -q -c "DELETE FROM public.eventos_outlier WHERE sku_codigo_omie='1006';"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1006';")
if [ "$V" = "1" ]; then ok "F4b sabotagem (COALESCE sem dedup_key) RE-FLAGRA o caso SEM NFe → A24 tinha dente"
else bad "F4b tirei o dedup_key do COALESCE e a exclusão sem-NFe seguiu valendo (veio [$V]) — A24 não prova nada"; fi

# F5 — restaura a versão verdadeira e re-confirma o verde
P -q -f "$MIG" >/dev/null
P -q -c "DELETE FROM public.observacoes_excluidas; DELETE FROM public.eventos_outlier WHERE tipo='lt_atipico';"
P -q -c "SELECT public.detectar_outliers_empresa('OBEN');" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1001';")
eq "F5 migration restaurada: o falso-positivo do 1001 fica fora" "$V" "0"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1003';")
eq "F5b migration restaurada: o outlier real do 1003 é achado" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.eventos_outlier WHERE sku_codigo_omie='1004';")
eq "F5c migration restaurada: o gate fabricado do 1004 segue reprovado" "$V" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

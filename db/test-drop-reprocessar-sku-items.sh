#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — DROP da public.reprocessar_sku_items_via_raw_data(text)                 ║
# ║  Migration: supabase/migrations/20260717010000_drop_reprocessar_sku_items_via_raw_data.sql
# ║                                                                                        ║
# ║  POR QUE ESTE HARNESS É "CARACTERIZADOR" e não o de sempre:                            ║
# ║  um DROP não introduz lógica nova — não há caminho feliz a provar. Encher de asserts   ║
# ║  seria teatro. O que PRECISA de prova aqui é a JUSTIFICATIVA: que a função, como está  ║
# ║  em prod HOJE, destrói dado. Então este harness cria a função REAL (corpo verbatim de  ║
# ║  pg_get_functiondef da prod, 2026-07-16), semeia o cenário real, RODA a função e mede  ║
# ║  o estrago — e só depois aplica a migration e prova que a arma sumiu.                  ║
# ║  A falsificação também é invertida: sabota CONSERTANDO os bugs, e exige que os asserts ║
# ║  de dano fiquem vermelhos. Se "consertar" não apagasse o vermelho, o assert não teria  ║
# ║  dente — estaria medindo outra coisa.                                                  ║
# ║                                                                                        ║
# ║  bash db/test-drop-reprocessar-sku-items.sh > /tmp/t.log 2>&1; echo "exit=$?"          ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                               ║
# ╚══════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="drop-reproc-sku"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: schema espelhado da PROD (não do design)
# Chaves conferidas via psql-ro em pg_indexes E pg_constraint (money-path.md: um
# CREATE UNIQUE INDEX não aparece em pg_constraint; olhar só um esconde metade).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN', 'COLACOR');

CREATE TABLE public.purchase_orders_tracking (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa                    public.empresa_reposicao NOT NULL,
  omie_codigo_pedido         bigint NOT NULL,
  fornecedor_codigo_omie     bigint,
  fornecedor_nome            text,
  grupo_leadtime             text,
  numero_contrato_fornecedor text,
  t1_data_pedido             timestamptz NOT NULL,
  t2_data_faturamento        timestamptz,
  t3_data_cte                timestamptz,
  t4_data_recebimento        timestamptz,
  raw_data                   jsonb
);

-- sku_leadtime_history: espelha a prod, inclusive a UNIQUE que o ON CONFLICT da função usa
-- (uq_sku_hist_tracking_sku) e o NOT NULL de t1_data_pedido.
CREATE TABLE public.sku_leadtime_history (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id               uuid NOT NULL REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  empresa                   public.empresa_reposicao NOT NULL,
  sku_codigo_omie           bigint NOT NULL,
  sku_codigo                text,
  sku_descricao             text,
  sku_unidade               text,
  sku_ncm                   text,
  fornecedor_codigo_omie    bigint,
  fornecedor_nome           text,
  grupo_leadtime            text,
  quantidade_pedida         numeric,
  quantidade_recebida       numeric,
  valor_unitario            numeric,
  valor_total               numeric,
  t1_data_pedido            timestamptz NOT NULL,
  t2_data_faturamento       timestamptz,
  t3_data_cte               timestamptz,
  t4_data_recebimento       timestamptz,
  lt_bruto_dias_uteis       integer,
  lt_faturamento_dias_uteis integer,
  lt_logistica_dias_uteis   integer,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  origem_compra             text NOT NULL DEFAULT 'normal',
  CONSTRAINT sku_leadtime_history_origem_compra_check
    CHECK (origem_compra = ANY (ARRAY['normal','oportunidade_promo','oportunidade_aumento','manual','desconhecida'])),
  CONSTRAINT uq_sku_hist_tracking_sku UNIQUE (tracking_id, sku_codigo_omie)
);
SQL

# dias_uteis_entre — corpo VERBATIM da prod (pg_get_functiondef, 2026-07-16)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.dias_uteis_entre(inicio timestamp with time zone, fim timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  total integer := 0;
  cursor_dia date;
  ultimo_dia date;
BEGIN
  IF inicio IS NULL OR fim IS NULL OR fim < inicio THEN
    RETURN NULL;
  END IF;
  cursor_dia := inicio::date;
  ultimo_dia := fim::date;
  WHILE cursor_dia <= ultimo_dia LOOP
    IF EXTRACT(DOW FROM cursor_dia) NOT IN (0, 6) THEN
      total := total + 1;
    END IF;
    cursor_dia := cursor_dia + interval '1 day';
  END LOOP;
  RETURN GREATEST(total - 1, 0);
END;
$function$;
SQL

# leadtime_t1_e_data_de_pedido — o gate do #1365, corpo VERBATIM da prod (pg_get_functiondef,
# 2026-07-17, DEPOIS do #1365 ter sido aplicado). Está aqui porque o argumento central do DROP
# depende dele: é ele que dá a `lt_bruto IS NULL` o segundo significado ("deliberadamente
# desconhecido") que o DELETE da função não sabe distinguir de "ainda não calculado".
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.leadtime_t1_e_data_de_pedido(
  p_hist_t1 timestamp with time zone, p_hist_t2 timestamp with time zone,
  p_tracking_t1 timestamp with time zone, p_omie_codigo_pedido bigint)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT NOT (
    COALESCE(p_omie_codigo_pedido, 0) < 0
    OR (p_hist_t1 = p_hist_t2 AND p_hist_t1 IS DISTINCT FROM p_tracking_t1)
  );
$function$;
SQL

# ── a FUNÇÃO SOB CARACTERIZAÇÃO: corpo VERBATIM da prod (pg_get_functiondef, 2026-07-16) ──
# Guardada em arquivo porque as falsificações a recriam CONSERTADA e depois restauram esta.
FUNC_REAL="$(mktemp "/tmp/func-real-${SLUG}.XXXXXX.sql")"
cat > "$FUNC_REAL" <<'SQL'
CREATE OR REPLACE FUNCTION public.reprocessar_sku_items_via_raw_data(p_empresa text)
 RETURNS TABLE(etapa text, valor bigint)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_itens_removidos bigint := 0;
  v_itens_totais bigint := 0;
  v_itens_com_match bigint := 0;
BEGIN
  DELETE FROM sku_leadtime_history
  WHERE empresa::text = p_empresa
    AND lt_bruto_dias_uteis IS NULL;

  GET DIAGNOSTICS v_itens_removidos = ROW_COUNT;
  etapa := 'linhas_antigas_removidas';
  valor := v_itens_removidos;
  RETURN NEXT;

  INSERT INTO sku_leadtime_history (
    tracking_id, empresa, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime,
    sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade, sku_ncm,
    quantidade_pedida, quantidade_recebida, valor_unitario, valor_total,
    t1_data_pedido, t2_data_faturamento, t3_data_cte, t4_data_recebimento,
    lt_bruto_dias_uteis, lt_faturamento_dias_uteis, lt_logistica_dias_uteis
  )
  WITH itens_extraidos AS (
    SELECT
      p.id as tracking_id, p.empresa, p.fornecedor_codigo_omie, p.fornecedor_nome, p.grupo_leadtime,
      p.t1_data_pedido, p.t2_data_faturamento, p.t3_data_cte, p.t4_data_recebimento,
      (item->'itensCabec'->>'nIdProduto')::bigint as sku_codigo_omie,
      item->'itensCabec'->>'cCodigoProduto' as sku_codigo,
      item->'itensCabec'->>'cDescricaoProduto' as sku_descricao,
      item->'itensCabec'->>'cUnidadeNfe' as sku_unidade,
      item->'itensCabec'->>'cNCM' as sku_ncm,
      COALESCE((item->'itensCabec'->>'nQtdeNFe')::numeric, (item->'itensAjustes'->>'nQtdeRecebida')::numeric, 0) as quantidade_pedida,
      (item->'itensAjustes'->>'nQtdeRecebida')::numeric as quantidade_recebida,
      (item->'itensCabec'->>'nPrecoUnit')::numeric as valor_unitario,
      (item->'itensCabec'->>'vTotalItem')::numeric as valor_total,
      item->'itensInfoAdic'->>'nNumPedCompra' as num_ped_sayerlack
    FROM purchase_orders_tracking p
    CROSS JOIN jsonb_array_elements(p.raw_data->'itensRecebimento') as item
    WHERE p.empresa::text = p_empresa
      AND p.fornecedor_codigo_omie = 8689681266
      AND p.raw_data IS NOT NULL
      AND p.raw_data->'cabec'->>'cModeloNFe' = '55'
      AND jsonb_typeof(p.raw_data->'itensRecebimento') = 'array'
  ),
  itens_agregados AS (
    SELECT
      tracking_id, empresa, fornecedor_codigo_omie,
      MAX(fornecedor_nome) as fornecedor_nome, MAX(grupo_leadtime) as grupo_leadtime,
      MAX(t1_data_pedido) as t1_data_pedido, MAX(t2_data_faturamento) as t2_data_faturamento,
      MAX(t3_data_cte) as t3_data_cte, MAX(t4_data_recebimento) as t4_data_recebimento,
      sku_codigo_omie, MAX(sku_codigo) as sku_codigo, MAX(sku_descricao) as sku_descricao,
      MAX(sku_unidade) as sku_unidade, MAX(sku_ncm) as sku_ncm,
      SUM(quantidade_pedida) as quantidade_pedida, SUM(quantidade_recebida) as quantidade_recebida,
      AVG(valor_unitario) as valor_unitario, SUM(valor_total) as valor_total,
      MIN(num_ped_sayerlack) as num_ped_sayerlack
    FROM itens_extraidos
    GROUP BY tracking_id, empresa, fornecedor_codigo_omie, sku_codigo_omie
  ),
  itens_com_pedido AS (
    SELECT i.*, pedido.t1_data_pedido as t1_real
    FROM itens_agregados i
    LEFT JOIN LATERAL (
      SELECT p2.t1_data_pedido
      FROM purchase_orders_tracking p2
      WHERE p2.empresa::text = p_empresa
        AND p2.fornecedor_codigo_omie = 8689681266
        AND p2.numero_contrato_fornecedor = i.num_ped_sayerlack
        AND i.num_ped_sayerlack IS NOT NULL
      ORDER BY p2.t1_data_pedido
      LIMIT 1
    ) as pedido ON true
  )
  SELECT
    tracking_id, empresa, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime,
    sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade, sku_ncm,
    quantidade_pedida, quantidade_recebida, valor_unitario, valor_total,
    COALESCE(t1_real, t1_data_pedido) as t1_data_pedido,
    t2_data_faturamento, t3_data_cte, t4_data_recebimento,
    CASE WHEN t1_real IS NOT NULL AND t4_data_recebimento IS NOT NULL
      THEN dias_uteis_entre(t1_real::date, t4_data_recebimento::date) ELSE NULL END as lt_bruto_dias_uteis,
    CASE WHEN t1_real IS NOT NULL AND t2_data_faturamento IS NOT NULL
      THEN dias_uteis_entre(t1_real::date, t2_data_faturamento::date) ELSE NULL END as lt_faturamento_dias_uteis,
    CASE WHEN t2_data_faturamento IS NOT NULL AND t4_data_recebimento IS NOT NULL
      THEN dias_uteis_entre(t2_data_faturamento::date, t4_data_recebimento::date) ELSE NULL END as lt_logistica_dias_uteis
  FROM itens_com_pedido
  ON CONFLICT (tracking_id, sku_codigo_omie)
  DO UPDATE SET
    quantidade_recebida = EXCLUDED.quantidade_recebida,
    valor_total = EXCLUDED.valor_total,
    t1_data_pedido = EXCLUDED.t1_data_pedido,
    t4_data_recebimento = EXCLUDED.t4_data_recebimento,
    lt_bruto_dias_uteis = EXCLUDED.lt_bruto_dias_uteis,
    lt_faturamento_dias_uteis = EXCLUDED.lt_faturamento_dias_uteis,
    lt_logistica_dias_uteis = EXCLUDED.lt_logistica_dias_uteis;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE t1_data_pedido != t2_data_faturamento)
  INTO v_itens_totais, v_itens_com_match
  FROM sku_leadtime_history WHERE empresa::text = p_empresa;

  etapa := 'itens_totais_no_banco'; valor := v_itens_totais; RETURN NEXT;
  etapa := 'itens_com_match_pedido_real'; valor := v_itens_com_match; RETURN NEXT;
  etapa := 'itens_com_fallback_t1_igual_t2'; valor := v_itens_totais - v_itens_com_match; RETURN NEXT;
  RETURN;
END;
$function$;
SQL
P -q -f "$FUNC_REAL"

# ══════════════════════════════════════════════════════════════════════════════
# SEED — o cenário de prod em miniatura. Re-semeável (cada falsificação re-semeia).
# ══════════════════════════════════════════════════════════════════════════════
SEED="$(mktemp "/tmp/seed-${SLUG}.XXXXXX.sql")"
cat > "$SEED" <<'SQL'
TRUNCATE public.sku_leadtime_history, public.purchase_orders_tracking CASCADE;

-- PEDIDO de compra Sayerlack que o LEFT JOIN LATERAL consegue casar (numero_contrato='PED-CASA')
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, numero_contrato_fornecedor, t1_data_pedido)
VALUES
  ('33333333-3333-3333-3333-333333333333','OBEN', 900001, 8689681266, 'SAYERLACK', 'PED-CASA', '2026-03-02T00:00:00Z');

-- NFe A — Sayerlack, raw_data na forma ANTIGA, mas nNumPedCompra NÃO casa nenhum pedido.
-- Espelha o fallback real da edge: t1 gravado no tracking == t2 (a data da NFe).
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, t1_data_pedido, t2_data_faturamento, t4_data_recebimento, raw_data)
VALUES
  ('11111111-1111-1111-1111-111111111111','OBEN', 900002, 8689681266, 'SAYERLACK', 'tintas', '2026-03-16T00:00:00Z', '2026-03-16T00:00:00Z', '2026-03-20T00:00:00Z',
   '{"cabec":{"cModeloNFe":"55","nNumeroNfe":"1001"},
     "itensRecebimento":[{"itensCabec":{"nIdProduto":111,"cCodigoProduto":"SKU-A","cDescricaoProduto":"Verniz A","cUnidadeNfe":"LT","cNCM":"3208","nQtdeNFe":10,"nPrecoUnit":50,"vTotalItem":500},
                          "itensAjustes":{"nQtdeRecebida":10},
                          "itensInfoAdic":{"nNumPedCompra":"PED-QUE-NAO-EXISTE"}}]}'::jsonb);

-- NFe D — Sayerlack, forma ANTIGA, nNumPedCompra CASA o pedido PED-CASA (caminho que funciona)
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, t1_data_pedido, t2_data_faturamento, t4_data_recebimento, raw_data)
VALUES
  ('22222222-2222-2222-2222-222222222222','OBEN', 900003, 8689681266, 'SAYERLACK', 'tintas', '2026-03-16T00:00:00Z', '2026-03-16T00:00:00Z', '2026-03-20T00:00:00Z',
   '{"cabec":{"cModeloNFe":"55","nNumeroNfe":"1002"},
     "itensRecebimento":[{"itensCabec":{"nIdProduto":222,"cCodigoProduto":"SKU-D","cDescricaoProduto":"Verniz D","cUnidadeNfe":"LT","cNCM":"3208","nQtdeNFe":5,"nPrecoUnit":80,"vTotalItem":400},
                          "itensAjustes":{"nQtdeRecebida":5},
                          "itensInfoAdic":{"nNumPedCompra":"PED-CASA"}}]}'::jsonb);

-- NFe B — Sayerlack, raw_data na forma NOVA (sem a chave 'cabec'): 532/612 das NFes de prod.
-- O INSERT da função é CEGO a ela. Tem 3 linhas na history aguardando t4 legitimamente.
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, t1_data_pedido, t2_data_faturamento, raw_data)
VALUES
  ('44444444-4444-4444-4444-444444444444','OBEN', 900004, 8689681266, 'SAYERLACK', 'tintas', '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z',
   '{"cabecalho_consulta":{"nCodPed":900004},"produtos_consulta":[{"cCodigo":"SKU-B1"}],"parcelas_consulta":[],"totais":{}}'::jsonb);

INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_codigo, fornecedor_codigo_omie, t1_data_pedido, t2_data_faturamento, lt_bruto_dias_uteis)
VALUES
  ('44444444-4444-4444-4444-444444444444','OBEN', 4401, 'SKU-B1', 8689681266, '2026-07-01T00:00:00Z','2026-07-02T00:00:00Z', NULL),
  ('44444444-4444-4444-4444-444444444444','OBEN', 4402, 'SKU-B2', 8689681266, '2026-07-01T00:00:00Z','2026-07-02T00:00:00Z', NULL),
  ('44444444-4444-4444-4444-444444444444','OBEN', 4403, 'SKU-B3', 8689681266, '2026-07-01T00:00:00Z','2026-07-02T00:00:00Z', NULL);

-- NFe C — OUTRO fornecedor (8689703094). O DELETE alcança; o INSERT (filtrado em 8689681266)
-- NUNCA recria. Em prod são 14 linhas assim, todas aguardando t4 legitimamente.
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, t1_data_pedido, t2_data_faturamento, raw_data)
VALUES
  ('55555555-5555-5555-5555-555555555555','OBEN', 900005, 8689703094, 'OUTRO FORNECEDOR', 'quimicos', '2026-07-05T00:00:00Z', '2026-07-06T00:00:00Z', NULL);

INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_codigo, fornecedor_codigo_omie, t1_data_pedido, t2_data_faturamento, lt_bruto_dias_uteis)
VALUES
  ('55555555-5555-5555-5555-555555555555','OBEN', 5501, 'SKU-C1', 8689703094, '2026-07-05T00:00:00Z','2026-07-06T00:00:00Z', NULL),
  ('55555555-5555-5555-5555-555555555555','OBEN', 5502, 'SKU-C2', 8689703094, '2026-07-05T00:00:00Z','2026-07-06T00:00:00Z', NULL);

-- NFe E — a linha que o #1365 protege DE PROPÓSITO. É ÓRFÃ (omie_codigo_pedido < 0: NFe sem
-- pedido de compra casado), logo o gate diz que o t1 dela NUNCA é data de pedido e o recompute
-- do #1365 ANULA o lt_bruto de propósito. Em prod são 415 linhas assim — e o DELETE por
-- `lt_bruto IS NULL` não sabe distingui-las de "ainda não calculado".
-- Cruel de propósito: o raw_data dela está na forma ANTIGA e o nNumPedCompra CASA o PED-CASA,
-- então o INSERT a recria com um lt_bruto PREENCHIDO — a mentira que o #1365 matou, de volta.
INSERT INTO public.purchase_orders_tracking
  (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, t1_data_pedido, t2_data_faturamento, t4_data_recebimento, raw_data)
VALUES
  ('66666666-6666-6666-6666-666666666666','OBEN', -1, 8689681266, 'SAYERLACK', 'tintas', '2026-03-16T00:00:00Z', '2026-03-16T00:00:00Z', '2026-03-20T00:00:00Z',
   '{"cabec":{"cModeloNFe":"55","nNumeroNfe":"1003"},
     "itensRecebimento":[{"itensCabec":{"nIdProduto":666,"cCodigoProduto":"SKU-E","cDescricaoProduto":"Verniz E","cUnidadeNfe":"LT","cNCM":"3208","nQtdeNFe":7,"nPrecoUnit":30,"vTotalItem":210},
                          "itensAjustes":{"nQtdeRecebida":7},
                          "itensInfoAdic":{"nNumPedCompra":"PED-CASA"}}]}'::jsonb);

INSERT INTO public.sku_leadtime_history
  (tracking_id, empresa, sku_codigo_omie, sku_codigo, fornecedor_codigo_omie, t1_data_pedido, t2_data_faturamento, t4_data_recebimento, lt_bruto_dias_uteis, lt_logistica_dias_uteis)
VALUES
  ('66666666-6666-6666-6666-666666666666','OBEN', 666, 'SKU-E', 8689681266, '2026-03-16T00:00:00Z','2026-03-16T00:00:00Z','2026-03-20T00:00:00Z', NULL, 4);
SQL

semear() { P -q -f "$SEED"; }
rodar()  { P -q -c "SELECT * FROM public.reprocessar_sku_items_via_raw_data('OBEN');" >/dev/null; }

# ══════════════════════════════════════════════════════════════════════════════
# FASE A — CARACTERIZAR O DANO (com a função REAL de prod)
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FASE A — o que a função REAL faz hoje ═══"
semear
ANTES_TOTAL="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE empresa='OBEN';")"
ANTES_OUTRO="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE fornecedor_codigo_omie=8689703094;")"
eq "A1 baseline: histórico semeado" "$ANTES_TOTAL" "6"
eq "A2 baseline: linhas de OUTRO fornecedor presentes" "$ANTES_OUTRO" "2"

# A NFe E é órfã ⇒ o gate do #1365 diz "o t1 desta linha NÃO é data de pedido" ⇒ lt_bruto NULL
# é DELIBERADO. Sem este baseline, o A9 não provaria que o DELETE apaga uma PROTEÇÃO.
PROTEGIDA="$(Pq -c "SELECT public.leadtime_t1_e_data_de_pedido(s.t1_data_pedido, s.t2_data_faturamento, p.t1_data_pedido, p.omie_codigo_pedido)::text FROM sku_leadtime_history s JOIN purchase_orders_tracking p ON p.id=s.tracking_id WHERE s.tracking_id='66666666-6666-6666-6666-666666666666';")"
eq "A8 baseline: o gate do #1365 marca a NFe órfã como 't1 NÃO é data de pedido' (lt_bruto NULL é deliberado, não pendência)" "$PROTEGIDA" "false"

rodar

DEPOIS_OUTRO="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE fornecedor_codigo_omie=8689703094;")"
eq "A3 PERDA PERMANENTE cross-fornecedor: DELETE amplo × INSERT estreito apagou o que nunca recria" "$DEPOIS_OUTRO" "0"

DEPOIS_B="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE tracking_id='44444444-4444-4444-4444-444444444444';")"
eq "A4 CEGUEIRA à forma nova do raw_data: linhas da NFe sem 'cabec' apagadas e não recriadas" "$DEPOIS_B" "0"

# Bug 2: t1 GRAVADO é válido, mas lt_bruto/lt_faturamento ficam NULL — com lt_logistica preenchido.
BUGB="$(Pq -c "SELECT (t1_data_pedido IS NOT NULL)::text || '/' || (lt_bruto_dias_uteis IS NULL)::text || '/' || (lt_faturamento_dias_uteis IS NULL)::text || '/' || (lt_logistica_dias_uteis IS NOT NULL)::text FROM sku_leadtime_history WHERE tracking_id='11111111-1111-1111-1111-111111111111';")"
eq "A5 BUG 2 reproduzido: t1 gravado válido + lt_bruto NULL + lt_faturamento NULL + lt_logistica OK (a assinatura das 328 de 2026-04-19)" "$BUGB" "true/true/true/true"

# Contraprova de que o harness não está viciado: quando o LATERAL CASA, a função funciona.
FELIZ="$(Pq -c "SELECT (lt_bruto_dias_uteis IS NOT NULL)::text FROM sku_leadtime_history WHERE tracking_id='22222222-2222-2222-2222-222222222222';")"
eq "A6 contraprova (anti-viés): com pedido casado a função PREENCHE lt_bruto — o dano é o LATERAL não casar, não o harness" "$FELIZ" "true"

DEPOIS_TOTAL="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE empresa='OBEN';")"
eq "A7 BALANÇO: apagou mais do que recriou (6 → 3; em prod: 514 apagadas × 222 recriadas = −292)" "$DEPOIS_TOTAL" "3"

# O ARGUMENTO CENTRAL depois do #1365: a linha protegida é apagada — e volta com a mentira.
# lt_bruto deixou de ser NULL (deliberado) e virou um número derivado de um pedido que esta NFe
# órfã nunca teve. É o lt_bruto que SUBESTIMA e faz pedir tarde, exatamente o que o #1365 matou.
MENTIRA="$(Pq -c "SELECT COALESCE(lt_bruto_dias_uteis::text,'AINDA_NULL') FROM sku_leadtime_history WHERE tracking_id='66666666-6666-6666-6666-666666666666';")"
if [ "$MENTIRA" != "AINDA_NULL" ] && [ -n "$MENTIRA" ]; then
  ok "A9 ANTAGONISMO ao #1365: a linha órfã protegida foi apagada e RECRIADA com lt_bruto=$MENTIRA — a mentira que o #1365 anulou, de volta (em prod: 415 linhas protegidas no raio do DELETE)"
else
  bad "A9 esperava a proteção do #1365 ser desfeita (lt_bruto preenchido com mentira), veio [$MENTIRA]"
fi

# ══════════════════════════════════════════════════════════════════════════════
# FASE B — FALSIFICAÇÃO INVERTIDA: "consertar" os bugs tem de APAGAR o vermelho.
# Prova que A3 e A5 medem o bug alegado, e não um artefato do seed.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FASE B — falsificação (sabota CONSERTANDO; asserts de dano têm de virar) ═══"

# F2 — conserta só o DELETE (escopa por fornecedor). A3 tem de deixar de valer.
P -q -c "$(sed -e 's/AND lt_bruto_dias_uteis IS NULL;/AND lt_bruto_dias_uteis IS NULL AND fornecedor_codigo_omie = 8689681266;/' "$FUNC_REAL")"
semear; rodar
F2="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE fornecedor_codigo_omie=8689703094;")"
if [ "$F2" = "2" ]; then ok "F2 dente de A3: com o DELETE escopado por fornecedor, as linhas de OUTRO fornecedor SOBREVIVEM (=2) — A3 mede a assimetria, não o seed"
else bad "F2 dente de A3: consertar o DELETE não mudou nada (veio [$F2], esperado 2) — A3 está medindo outra coisa"; fi

# F3 — conserta só o CASE (usa o t1 EFETIVO). A5 tem de deixar de valer.
P -q -c "$(sed -e 's/WHEN t1_real IS NOT NULL AND t4_data_recebimento IS NOT NULL/WHEN COALESCE(t1_real, t1_data_pedido) IS NOT NULL AND t4_data_recebimento IS NOT NULL/' \
               -e 's/THEN dias_uteis_entre(t1_real::date, t4_data_recebimento::date)/THEN dias_uteis_entre(COALESCE(t1_real, t1_data_pedido)::date, t4_data_recebimento::date)/' \
               -e 's/WHEN t1_real IS NOT NULL AND t2_data_faturamento IS NOT NULL/WHEN COALESCE(t1_real, t1_data_pedido) IS NOT NULL AND t2_data_faturamento IS NOT NULL/' \
               -e 's/THEN dias_uteis_entre(t1_real::date, t2_data_faturamento::date)/THEN dias_uteis_entre(COALESCE(t1_real, t1_data_pedido)::date, t2_data_faturamento::date)/' "$FUNC_REAL")"
semear; rodar
F3="$(Pq -c "SELECT (lt_bruto_dias_uteis IS NULL)::text FROM sku_leadtime_history WHERE tracking_id='11111111-1111-1111-1111-111111111111';")"
if [ "$F3" = "false" ]; then ok "F3 dente de A5: com o CASE usando o t1 EFETIVO, lt_bruto deixa de ser NULL — A5 mede o Bug 2 de verdade"
else bad "F3 dente de A5: consertar o CASE não mudou o lt_bruto (segue NULL) — A5 está medindo outra coisa"; fi

# restaura a função VERDADEIRA (cirúrgico — só o que foi sabotado)
P -q -f "$FUNC_REAL"
RESTAURADA="$(Pq -c "SELECT (pg_get_functiondef(p.oid) LIKE '%WHEN t1_real IS NOT NULL AND t4_data_recebimento IS NOT NULL%')::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
eq "B0 função verdadeira restaurada antes de aplicar a migration" "$RESTAURADA" "true"

# ══════════════════════════════════════════════════════════════════════════════
# FASE C — A MIGRATION REAL (Lei #1: psql -f no .sql commitado, não um DROP à mão)
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FASE C — aplica a migration REAL ═══"
MIG="$REPO_ROOT/supabase/migrations/20260717010000_drop_reprocessar_sku_items_via_raw_data.sql"
[ -f "$MIG" ] || { echo "❌ migration não encontrada: $MIG"; exit 1; }

semear
EXISTE_ANTES="$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
eq "C1 baseline: a função existe ANTES da migration (senão o C2 provaria o nada)" "$EXISTE_ANTES" "1"

P -q -f "$MIG"

EXISTE_DEPOIS="$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
eq "C2 a migration REMOVE a função" "$EXISTE_DEPOIS" "0"

# A arma some, o dado fica. O DROP não pode encostar em sku_leadtime_history.
SOBREVIVEU="$(Pq -c "SELECT count(*) FROM sku_leadtime_history WHERE empresa='OBEN';")"
eq "C3 o DROP não toca o dado: histórico intacto (as 6 linhas semeadas seguem lá)" "$SOBREVIVEU" "6"

# Chamar a função dropada tem de dar 42883 (undefined_function) — e não outro erro qualquer.
P -q <<'SQL' 2>/dev/null && ok "C4 chamar a função dropada levanta 42883 undefined_function (SQLSTATE esperada, resto re-lançado)" || bad "C4 a SQLSTATE de função inexistente não veio como esperado"
DO $$
BEGIN
  PERFORM public.reprocessar_sku_items_via_raw_data('OBEN');
  RAISE EXCEPTION 'FALHA_DO_TESTE: a função respondeu depois de dropada';
EXCEPTION
  WHEN undefined_function THEN NULL;  -- 42883: exatamente o esperado
  WHEN OTHERS THEN RAISE;             -- qualquer outro erro re-lançado (Lei #2)
END $$;
SQL

# Idempotência: o founder pode colar 2× no SQL Editor sem quebrar (o guard NOTICE e retorna).
P -q -f "$MIG" && ok "C5 migration idempotente: re-aplicar cai no NOTICE do guard, não em erro" || bad "C5 re-aplicar a migration quebrou"

# ══════════════════════════════════════════════════════════════════════════════
# FASE E — O GUARD DE DRIFT (achado do Codex: `DROP ... IF EXISTS` cru esconderia
# uma assinatura divergente e ainda reportaria sucesso — falha silenciosa).
# Prova por ESTADO (a função sobrevive), não por grep da mensagem: a sentinela não
# pode ser o texto que o próprio código emite (anti-teatro, money-path.md).
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FASE E — guard de drift de assinatura ═══"
P -q -f "$FUNC_REAL"
P -q <<'SQL'
CREATE FUNCTION public.reprocessar_sku_items_via_raw_data(p_empresa text, p_extra text)
RETURNS void LANGUAGE plpgsql AS $f$ BEGIN RETURN; END $f$;
SQL

if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "E1 guard de drift: a migration aplicou apesar do overload inesperado — drift passou batido"
else
  ok "E1 guard de drift: com um overload inesperado a migration ABORTA em vez de dropar às cegas"
fi
SOBREVIVERAM="$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
eq "E2 o abort é ATÔMICO: nenhuma das duas assinaturas foi dropada no meio do caminho" "$SOBREVIVERAM" "2"

# F4 — dente do E1: a versão INGÊNUA (o `DROP ... IF EXISTS` que o Codex vetou) dropa a (text)
# no mesmo cenário e reporta SUCESSO, deixando o overload intacto e o operador sem saber.
P -q -c "DROP FUNCTION IF EXISTS public.reprocessar_sku_items_via_raw_data(text);" >/dev/null 2>&1
INGENUA="$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
if [ "$INGENUA" = "1" ]; then ok "F4 dente do E1: a versão ingênua (DROP IF EXISTS) dropa silenciosamente no drift e diz sucesso — por isso o guard existe"
else bad "F4 dente do E1: esperava a versão ingênua dropar 1 das 2 assinaturas em silêncio, sobrou [$INGENUA]"; fi
P -q -c "DROP FUNCTION IF EXISTS public.reprocessar_sku_items_via_raw_data(text, text);" >/dev/null 2>&1

# ══════════════════════════════════════════════════════════════════════════════
# FASE D — FALSIFICAÇÃO do assert do DROP: migration no-op tem de deixar C2 VERMELHO
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FASE D — falsificação do C2 ═══"
P -q -f "$FUNC_REAL"   # ressuscita a função
NOOP="$(mktemp "/tmp/noop-${SLUG}.XXXXXX.sql")"
echo "COMMENT ON FUNCTION public.reprocessar_sku_items_via_raw_data(text) IS 'migration sabotada: nao dropa';" > "$NOOP"
P -q -f "$NOOP"
F1="$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reprocessar_sku_items_via_raw_data';")"
if [ "$F1" = "1" ]; then ok "F1 dente de C2: com a migration sabotada (no-op) a função SOBREVIVE (=1) — C2 prova o DROP, não o vácuo"
else bad "F1 dente de C2: a função sumiu mesmo sem o DROP (veio [$F1]) — C2 não prova nada"; fi
rm -f "$NOOP" "$FUNC_REAL" "$SEED"

echo
echo "══════════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1

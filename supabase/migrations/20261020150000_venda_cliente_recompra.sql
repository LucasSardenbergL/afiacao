-- 20261020150000_venda_cliente_recompra.sql
-- ============================================================
-- Venda por cliente — Task 2: recompra por comprador × SKU × empresa e situação do comprador.
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §7 Fase 1a/1b.
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md (Task 2).
-- Oráculo TS (paridade): src/lib/venda-cliente/recompra.ts. Prova: db/test-venda-recompra.sh.
--
-- O que cria (tudo novo — nenhum objeto vivo é recriado):
--   private.venda_mediana(numeric[])          mediana exata em numeric (percentile_cont é float8)
--   private.venda_linhas_pedido(p_ate date)   fonte única: order_items ⋈ sales_orders, alias → canônico,
--                                             universo de venda, só data < p_ate
--   public.venda_recompra_em(p_data date)     SKUs com ≥ 3 dias de pedido em 540 dias, vistos de p_data
--   public.venda_situacao_em(p_data date)     em_dia | atrasado | perdido | sem_base por comprador
--   public.venda_recompra / venda_situacao    snapshots do dia (RLS ligada, SEM policy: leitura só por
--                                             RPC SECURITY DEFINER das Tasks 4/6/8)
--   public.venda_recompra_atualizar()         recalcula os dois snapshots (cron 07:50 UTC)
--
-- Regras (iguais ao oráculo TS — mudou um, mude o outro; a paridade acusa):
--   comprador  = COALESCE(customer_canonical_alias.canonical_user_id [status='active'], customer_user_id)
--   empresa    = sales_orders.account; Oben e Colacor do mesmo comprador são linhas separadas
--   universo   = deleted_at IS NULL, status NOT IN ('cancelado','rascunho','pendente','orcamento')
--                (src/lib/farmer/universo-pedidos.ts; status NULL fica fora, como lá)
--   data       = COALESCE(order_date_kpi, (created_at AT TIME ZONE 'America/Sao_Paulo')::date)
--   sem futuro = só data < p_data; janela = data ≥ p_data − 540
--   preço      = unit_price − desconto_valor / quantity; desconto_valor NULL = NÃO APURADO → preço NULL
--                (ausente ≠ zero: nunca supor desconto 0). Linhas com quantity ≤ 0 ficam fora.
--   Gêmeos push/pull (20261001100001): a linha do app não tem order_items → o join já conta 1 vez.
--
-- Caminho de apply: `bun run db:aplicar` (o executor fornece a transação; este arquivo NÃO leva
-- BEGIN/COMMIT). Idempotente: CREATE … IF NOT EXISTS, CREATE OR REPLACE de objetos NOVOS,
-- cron.schedule por nome. Postcondição `DO $post$` no fim.
-- ============================================================

-- ── 1. Mediana exata ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.venda_mediana(p numeric[])
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  -- (s[(n+1)/2] + s[(n+2)/2]) / 2 com divisão inteira: n ímpar → o do meio; n par → média dos dois.
  -- Vazio/NULL → NULL (nunca 0).
  SELECT (q.s[(q.n + 1) / 2] + q.s[(q.n + 2) / 2]) / 2
    FROM (SELECT array_agg(x ORDER BY x) AS s, count(*)::int AS n
            FROM unnest(p) AS x
           WHERE x IS NOT NULL) q
   WHERE q.n > 0
$fn$;

REVOKE ALL ON FUNCTION private.venda_mediana(numeric[]) FROM PUBLIC, anon, authenticated;

-- ── 2. Fonte única das linhas de pedido ──────────────────────────────────────
CREATE OR REPLACE FUNCTION private.venda_linhas_pedido(p_ate date)
RETURNS TABLE (
  comprador_id uuid,
  empresa text,
  omie_codigo_produto bigint,
  product_id uuid,
  quantidade numeric,
  preco_unit_liquido numeric,
  data_pedido date,
  sales_order_id uuid
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT x.comprador_id, x.empresa, x.omie_codigo_produto, x.product_id,
         x.quantidade, x.preco_unit_liquido, x.data_pedido, x.sales_order_id
    FROM (
      SELECT COALESCE(a.canonical_user_id, so.customer_user_id) AS comprador_id,
             so.account AS empresa,
             oi.omie_codigo_produto,
             oi.product_id,
             oi.quantity AS quantidade,
             CASE WHEN oi.desconto_valor IS NULL OR oi.unit_price IS NULL THEN NULL
                  ELSE oi.unit_price - oi.desconto_valor / oi.quantity
             END AS preco_unit_liquido,
             COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
             so.id AS sales_order_id
        FROM public.order_items oi
        JOIN public.sales_orders so ON so.id = oi.sales_order_id
        LEFT JOIN public.customer_canonical_alias a
               ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
       WHERE so.deleted_at IS NULL
         AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
         AND so.customer_user_id IS NOT NULL
         AND so.account IN ('oben', 'colacor', 'colacor_sc')
         AND oi.omie_codigo_produto IS NOT NULL
         AND oi.quantity > 0
    ) x
   WHERE x.data_pedido < p_ate
$fn$;

REVOKE ALL ON FUNCTION private.venda_linhas_pedido(date) FROM PUBLIC, anon, authenticated;

-- ── 3. Recompra comprador × empresa × SKU vista de p_data ────────────────────
CREATE OR REPLACE FUNCTION public.venda_recompra_em(p_data date)
RETURNS TABLE (
  comprador_id uuid,
  empresa text,
  omie_codigo_produto bigint,
  product_id uuid,
  n_pedidos int,
  cadencia_dias numeric,
  qtd_sugerida numeric,
  ultima_compra date,
  ultimo_preco numeric,
  due_ratio numeric,
  atrasado boolean,
  valor_esperado numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH por_dia AS (
    SELECT l.comprador_id, l.empresa, l.omie_codigo_produto, l.data_pedido,
           sum(l.quantidade) AS qtd,
           sum(l.quantidade * l.preco_unit_liquido) FILTER (WHERE l.preco_unit_liquido IS NOT NULL)
             / NULLIF(sum(l.quantidade) FILTER (WHERE l.preco_unit_liquido IS NOT NULL), 0) AS preco_dia,
           (array_agg(l.product_id ORDER BY l.product_id) FILTER (WHERE l.product_id IS NOT NULL))[1] AS product_id
      FROM private.venda_linhas_pedido(p_data) l
     WHERE l.data_pedido >= p_data - 540
     GROUP BY l.comprador_id, l.empresa, l.omie_codigo_produto, l.data_pedido
  ),
  com_gap AS (
    SELECT d.*,
           d.data_pedido - lag(d.data_pedido) OVER w AS gap,
           row_number() OVER (PARTITION BY d.comprador_id, d.empresa, d.omie_codigo_produto
                              ORDER BY d.data_pedido DESC) AS rn_desc
      FROM por_dia d
    WINDOW w AS (PARTITION BY d.comprador_id, d.empresa, d.omie_codigo_produto ORDER BY d.data_pedido)
  ),
  agg AS (
    SELECT g.comprador_id, g.empresa, g.omie_codigo_produto,
           count(*)::int AS n,
           private.venda_mediana(array_agg(g.gap::numeric) FILTER (WHERE g.gap IS NOT NULL)) AS cad,
           private.venda_mediana(array_agg(g.qtd)) AS qtd,
           max(g.data_pedido) AS ultima,
           max(g.preco_dia) FILTER (WHERE g.rn_desc = 1) AS ultimo_preco,
           (array_agg(g.product_id ORDER BY g.data_pedido DESC) FILTER (WHERE g.product_id IS NOT NULL))[1] AS product_id
      FROM com_gap g
     GROUP BY g.comprador_id, g.empresa, g.omie_codigo_produto
    HAVING count(*) >= 3
  )
  SELECT a.comprador_id, a.empresa, a.omie_codigo_produto, a.product_id,
         a.n, a.cad, a.qtd, a.ultima, a.ultimo_preco,
         (p_data - a.ultima)::numeric / a.cad AS due_ratio,
         -- due_ratio ≥ 1,5 comparado em inteiros (igual ao oráculo TS: sem arredondamento divergente)
         2 * (p_data - a.ultima) >= 3 * a.cad AS atrasado,
         a.qtd * a.ultimo_preco AS valor_esperado
    FROM agg a
$fn$;

REVOKE ALL ON FUNCTION public.venda_recompra_em(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_recompra_em(date) TO service_role;

COMMENT ON FUNCTION public.venda_recompra_em(date) IS
  'Recompra comprador×empresa×SKU vista de p_data (só pedidos < p_data, janela 540d, ≥3 dias de pedido). '
  'Oráculo: src/lib/venda-cliente/recompra.ts. Sem grant a authenticated.';

-- ── 4. Situação do comprador vista de p_data ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_situacao_em(p_data date)
RETURNS TABLE (
  comprador_id uuid,
  situacao text,
  dias_sem_compra int,
  valor_atrasado numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH hist AS (
    SELECT l.comprador_id, max(l.data_pedido) AS ultima, count(DISTINCT l.data_pedido) AS n_dias
      FROM private.venda_linhas_pedido(p_data) l
     GROUP BY l.comprador_id
  ),
  sk AS (
    SELECT r.comprador_id,
           private.venda_mediana(array_agg(r.cadencia_dias)) AS cad_mediana,
           count(*) FILTER (WHERE r.atrasado) AS n_atrasados,
           sum(r.valor_esperado) FILTER (WHERE r.atrasado) AS valor_atrasados
      FROM public.venda_recompra_em(p_data) r
     GROUP BY r.comprador_id
  )
  SELECT h.comprador_id,
         CASE
           WHEN sk.comprador_id IS NULL AND h.n_dias < 3 THEN 'sem_base'
           WHEN (p_data - h.ultima) > GREATEST(3 * COALESCE(sk.cad_mediana, 0), 365) THEN 'perdido'
           WHEN COALESCE(sk.n_atrasados, 0) > 0 THEN 'atrasado'
           ELSE 'em_dia'
         END AS situacao,
         (p_data - h.ultima)::int AS dias_sem_compra,
         -- nenhum atrasado → 0 (zero de verdade); atrasados todos sem preço → NULL (ausente ≠ zero)
         CASE WHEN COALESCE(sk.n_atrasados, 0) = 0 THEN 0 ELSE sk.valor_atrasados END AS valor_atrasado
    FROM hist h
    LEFT JOIN sk ON sk.comprador_id = h.comprador_id
$fn$;

REVOKE ALL ON FUNCTION public.venda_situacao_em(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_situacao_em(date) TO service_role;

COMMENT ON FUNCTION public.venda_situacao_em(date) IS
  'Situação do comprador vista de p_data: sem_base (sem SKU e <3 dias de pedido) | perdido '
  '(> max(3×mediana das cadências, 365) dias sem compra) | atrasado | em_dia. Sem grant a authenticated.';

-- ── 5. Snapshots ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_recompra (
  comprador_id uuid NOT NULL,
  empresa text NOT NULL CHECK (empresa IN ('oben', 'colacor', 'colacor_sc')),
  omie_codigo_produto bigint NOT NULL,
  product_id uuid,
  n_pedidos int NOT NULL,
  cadencia_dias numeric NOT NULL,
  qtd_sugerida numeric NOT NULL,
  ultima_compra date NOT NULL,
  ultimo_preco numeric,
  due_ratio numeric NOT NULL,
  atrasado boolean NOT NULL,
  valor_esperado numeric,
  data_referencia date NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comprador_id, empresa, omie_codigo_produto)
);

CREATE INDEX IF NOT EXISTS idx_venda_recompra_atrasado
  ON public.venda_recompra (comprador_id) WHERE atrasado;

CREATE TABLE IF NOT EXISTS public.venda_situacao (
  comprador_id uuid PRIMARY KEY,
  situacao text NOT NULL CHECK (situacao IN ('em_dia', 'atrasado', 'perdido', 'sem_base')),
  dias_sem_compra int,
  valor_atrasado numeric,
  data_referencia date NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now()
);

-- RLS ligada e SEM policy: authenticated não lê nada direto; leitura só via RPC das Tasks 4/6/8.
ALTER TABLE public.venda_recompra ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_situacao ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.venda_recompra FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.venda_situacao FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.venda_recompra IS
  'Snapshot diário de venda_recompra_em(hoje SP) — venda_recompra_atualizar(), cron venda-recompra 07:50 UTC.';
COMMENT ON TABLE public.venda_situacao IS
  'Snapshot diário de venda_situacao_em(hoje SP) — venda_recompra_atualizar(), cron venda-recompra 07:50 UTC.';

-- ── 6. Recalcular snapshots ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_recompra_atualizar()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_n int;
BEGIN
  DELETE FROM public.venda_recompra;
  INSERT INTO public.venda_recompra (
    comprador_id, empresa, omie_codigo_produto, product_id, n_pedidos, cadencia_dias, qtd_sugerida,
    ultima_compra, ultimo_preco, due_ratio, atrasado, valor_esperado, data_referencia)
  SELECT r.comprador_id, r.empresa, r.omie_codigo_produto, r.product_id, r.n_pedidos, r.cadencia_dias,
         r.qtd_sugerida, r.ultima_compra, r.ultimo_preco, r.due_ratio, r.atrasado, r.valor_esperado, v_hoje
    FROM public.venda_recompra_em(v_hoje) r;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  DELETE FROM public.venda_situacao;
  INSERT INTO public.venda_situacao (comprador_id, situacao, dias_sem_compra, valor_atrasado, data_referencia)
  SELECT s.comprador_id, s.situacao, s.dias_sem_compra, s.valor_atrasado, v_hoje
    FROM public.venda_situacao_em(v_hoje) s;

  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.venda_recompra_atualizar() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_recompra_atualizar() TO service_role;

-- ── 7. Cron 07:50 UTC (depois de calculate-scores 06:00/06:25 e carteira-rebuild 07:30) ──
-- SQL direto, sem net.http_post (nada de timeout HTTP a configurar).
SELECT cron.schedule('venda-recompra', '50 7 * * *', $$SELECT public.venda_recompra_atualizar();$$);

-- 1ª carga, para o snapshot não nascer vazio até amanhã 07:50.
SELECT public.venda_recompra_atualizar();

-- ── 8. Postcondição ──────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_fn text;
  v_tab text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_snap bigint;
  v_vivo bigint;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'private.venda_mediana(numeric[])',
    'private.venda_linhas_pedido(date)',
    'public.venda_recompra_em(date)',
    'public.venda_situacao_em(date)',
    'public.venda_recompra_atualizar()'
  ] LOOP
    IF to_regprocedure(v_fn) IS NULL THEN
      RAISE EXCEPTION 'POS_FN_AUSENTE: % não existe', v_fn;
    END IF;
    -- REVOKE de PUBLIC: nenhuma entrada de ACL com grantee 0 (PUBLIC) — e ACL NULL = default = PUBLIC executa
    IF (SELECT p.proacl IS NULL FROM pg_proc p WHERE p.oid = to_regprocedure(v_fn))
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) e
                   WHERE p.oid = to_regprocedure(v_fn) AND e.grantee = 0 AND e.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_PUBLIC: % ainda executável por PUBLIC', v_fn;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_ANON: anon executa %', v_fn;
    END IF;
    IF has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS_ACL_AUTH: authenticated executa %', v_fn;
    END IF;
  END LOOP;

  FOREACH v_tab IN ARRAY ARRAY['public.venda_recompra', 'public.venda_situacao'] LOOP
    IF to_regclass(v_tab) IS NULL THEN
      RAISE EXCEPTION 'POS_TAB_AUSENTE: %', v_tab;
    END IF;
    IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = to_regclass(v_tab)) THEN
      RAISE EXCEPTION 'POS_RLS: % sem RLS ligada', v_tab;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy pol WHERE pol.polrelid = to_regclass(v_tab)) THEN
      RAISE EXCEPTION 'POS_POLICY: % tem policy (desenho é zero policy)', v_tab;
    END IF;
    IF has_table_privilege('authenticated', v_tab, 'SELECT') OR has_table_privilege('anon', v_tab, 'SELECT') THEN
      RAISE EXCEPTION 'POS_TAB_GRANT: % com SELECT para anon/authenticated', v_tab;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'venda-recompra' AND schedule = '50 7 * * *'
                    AND command = 'SELECT public.venda_recompra_atualizar();') THEN
    RAISE EXCEPTION 'POS_CRON: job venda-recompra ausente ou com schedule/comando errado';
  END IF;

  -- Execução (PL/pgSQL e SQL são late-bound): o snapshot bate com o cálculo vivo de hoje.
  SELECT count(*) INTO v_snap FROM public.venda_recompra WHERE data_referencia = v_hoje;
  SELECT count(*) INTO v_vivo FROM public.venda_recompra_em(v_hoje);
  IF v_snap <> v_vivo OR v_snap <> (SELECT count(*) FROM public.venda_recompra) THEN
    RAISE EXCEPTION 'POS_SNAP_RECOMPRA: snapshot % × vivo %', v_snap, v_vivo;
  END IF;
  SELECT count(*) INTO v_snap FROM public.venda_situacao WHERE data_referencia = v_hoje;
  SELECT count(*) INTO v_vivo FROM public.venda_situacao_em(v_hoje);
  IF v_snap <> v_vivo OR v_snap <> (SELECT count(*) FROM public.venda_situacao) THEN
    RAISE EXCEPTION 'POS_SNAP_SITUACAO: snapshot % × vivo %', v_snap, v_vivo;
  END IF;

  RAISE NOTICE 'venda-recompra OK: % compradores no snapshot de situação', v_snap;
END
$post$;

-- ============================================================================================
-- Venda por cliente — Task 4 (complemento): PROVA DE COMPLETUDE POR DADOS para a linha de base histórica
-- Decisão do orquestrador do programa (2026-10-20): a lacuna de prova de sync da Oben (2025-07-01 → 2026-01-21,
-- sem vendas_sync_cursor) contém a "mesma época do ano passado". O dado existe (volumes mensais normais, 100% dos
-- pedidos com itens); falta a PROVA. Para linhas fase='historico', um dia sem heartbeat/cursor passa a contar como
-- coberto quando o MÊS da empresa passa nas DUAS condições:
--   (i)  100% dos pedidos de venda do mês têm order_items;
--   (ii) volume do mês ≥ 70% da mediana mensal dos 12 meses anteriores da mesma empresa (mediana > 0).
-- Reprovado → nao_medivel / historico_incompleto (nunca nao_virou). Dias COM heartbeat/cursor seguem como antes
-- (o mês corrente, parcial, nunca reprova por volume). Linhas sombra/ativa: inalteradas (só heartbeat/cursor).
-- Prova PG17: db/test-venda-gerador.sh (casos H*, falsificados).
--
-- Recria objeto VIVO (venda_fechar_desfechos, da 20261020174221): TRAVA → PRE → CREATE → PÓS.
-- Caminho de apply: `bun run db:aplicar` (transação do executor; arquivo sem BEGIN/COMMIT). Idempotente.
-- ============================================================================================

-- ── 1. Prova por dados: o mês p_mes da empresa está completo no banco? ───────────────────────
CREATE OR REPLACE FUNCTION private.venda_mes_completo_por_dados(p_empresa text, p_mes date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH m AS (
    SELECT date_trunc('month', p_mes)::date AS ini
  ),
  ped AS (
    -- Universo de venda de src/lib/farmer/universo-pedidos.ts (o mesmo do casamento do desfecho).
    SELECT so.id,
           date_trunc('month', COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date))::date AS mes
      FROM public.sales_orders so, m
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
       AND so.account = p_empresa
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (m.ini - interval '12 months')::date
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <  (m.ini + interval '1 month')::date
  ),
  atual AS (
    SELECT count(*) AS n,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.sales_order_id = p.id)) AS sem_itens
      FROM ped p, m
     WHERE p.mes = m.ini
  ),
  anteriores AS (
    -- 12 meses anteriores, mês sem pedido conta como 0 (é volume medido, não ausente).
    SELECT g::date AS mes, (SELECT count(*) FROM ped p WHERE p.mes = g::date) AS n
      FROM m, generate_series(m.ini - interval '12 months', m.ini - interval '1 month', interval '1 month') g
  ),
  base AS (
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a.n) AS mediana FROM anteriores a
  )
  SELECT a.n > 0
         AND a.sem_itens = 0                       -- (i)
         AND b.mediana > 0                         -- sem histórico não há régua: reprova (ausente ≠ zero)
         AND a.n >= 0.7 * b.mediana                -- (ii)
    FROM atual a, base b
$fn$;
REVOKE ALL ON FUNCTION private.venda_mes_completo_por_dados(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.venda_mes_completo_por_dados(text, date) TO service_role;

-- ── 2. TRAVA (antes de ler): ALTER sem efeito na função que a PRE guarda e este arquivo recria ─
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_fechar_desfechos(date)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_fechar_desfechos(date) VOLATILE;
  END IF;
END
$trava$;

-- ── 3. PRE: o corpo vivo é o predecessor revisado (20261020174221) ou este ───────────────────
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.venda_fechar_desfechos(date)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('cacc8ddadcbab7eaa5bb95edca4aa399', 'd187360234689981761b1cdfac225b2e') THEN
    RAISE EXCEPTION 'PRE FALHOU: venda_fechar_desfechos vivo (md5 %) nao e o predecessor revisado nem este', v_vivo;
  END IF;
END
$pre$;

-- ── 4. Job de desfecho com a prova por dados para a linha de base ────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos(p_hoje date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_janela jsonb;
  v_n      integer;
BEGIN
  IF p_hoje IS NULL THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: p_hoje NULL' USING ERRCODE = '22023';
  END IF;

  SELECT valor INTO v_janela FROM public.venda_config WHERE chave = 'janela_dias';
  IF jsonb_typeof(v_janela -> 'recompra') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'complemento') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'preco') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: venda_config.janela_dias ausente ou incompleta' USING ERRCODE = '22023';
  END IF;

  -- Um fechamento por vez (cron + chamada manual da reconstrução histórica).
  PERFORM pg_advisory_xact_lock(hashtext('venda_fechar_desfechos'));

  WITH jan(tipo, dias) AS (
    VALUES ('recompra',    (v_janela ->> 'recompra')::int),
           ('complemento', (v_janela ->> 'complemento')::int),
           ('preco',       (v_janela ->> 'preco')::int)
  ),
  alvo AS (
    SELECT s.id, s.tipo, s.empresa, s.fase,
           COALESCE(ca.canonical_user_id, s.comprador_id) AS comprador,
           s.omie_codigo_produto, s.familia, s.preco_alvo,
           s.dia_referencia AS de,
           s.dia_referencia + j.dias AS ate                  -- exclusivo
      FROM public.venda_sugestao s
      JOIN jan j ON j.tipo = s.tipo
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = s.comprador_id AND ca.status = 'active'
     WHERE s.desfecho IS NULL
       AND s.dia_referencia + j.dias <= p_hoje
  ),
  pedido AS (
    -- Universo de venda de src/lib/farmer/universo-pedidos.ts (denylist; NULL não passa).
    SELECT so.id, so.account,
           COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido
      FROM public.sales_orders so
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
  ),
  item AS (
    SELECT a.id AS sug_id, a.tipo, a.preco_alvo, p.id AS so_id, p.data_pedido,
           oi.quantity * oi.unit_price - oi.desconto_valor                          AS valor_liq,
           (oi.quantity * oi.unit_price - oi.desconto_valor) / NULLIF(oi.quantity, 0) AS preco_liq,
           oi.unit_price                                                           AS preco_bruto
      FROM alvo a
      JOIN pedido p
        ON p.comprador = a.comprador
       AND p.account = a.empresa
       AND p.data_pedido >= a.de
       AND p.data_pedido <  a.ate
      JOIN public.order_items oi ON oi.sales_order_id = p.id
     WHERE (a.tipo IN ('recompra','preco') AND oi.omie_codigo_produto = a.omie_codigo_produto)
        OR (a.tipo = 'complemento' AND EXISTS (
              SELECT 1 FROM public.omie_products op
               WHERE op.omie_codigo_produto = oi.omie_codigo_produto
                 AND op.account = p.account
                 AND op.familia = a.familia))
  ),
  item_q AS (
    SELECT i.*,
           CASE WHEN i.tipo <> 'preco'                       THEN true
                WHEN i.preco_liq IS NOT NULL                 THEN i.preco_liq >= i.preco_alvo * 0.99
                WHEN i.preco_bruto < i.preco_alvo * 0.99     THEN false   -- desconto só abaixa
                ELSE NULL                                                -- desconto não apurado
           END AS qualifica
      FROM item i
  ),
  agg AS (
    SELECT sug_id,
           (array_agg(so_id ORDER BY data_pedido, so_id) FILTER (WHERE qualifica))[1] AS so_id,
           CASE WHEN bool_and(valor_liq IS NOT NULL) FILTER (WHERE qualifica)
                THEN sum(valor_liq) FILTER (WHERE qualifica) END                     AS valor,
           bool_or(qualifica IS NULL)                                                AS indeterminado
      FROM item_q
     GROUP BY sug_id
  ),
  faixa AS (
    SELECT empresa, min(de) AS de, max(ate) AS ate FROM alvo GROUP BY empresa
  ),
  descoberto AS (
    SELECT f.empresa, g.d::date AS dia
      FROM faixa f
      CROSS JOIN LATERAL generate_series(f.de, f.ate - 1, interval '1 day') AS g(d)
     WHERE NOT private.venda_sync_dia_coberto(f.empresa, g.d::date)
  ),
  -- Linha de base (fase='historico'): dia sem heartbeat/cursor ainda conta como coberto se o MÊS passar na
  -- prova por dados (private.venda_mes_completo_por_dados). Só os dias de mês reprovado seguem descobertos.
  mes_descoberto AS (
    SELECT DISTINCT x.empresa, date_trunc('month', x.dia)::date AS mes FROM descoberto x
  ),
  mes_reprovado AS (
    SELECT m.empresa, m.mes FROM mes_descoberto m
     WHERE NOT private.venda_mes_completo_por_dados(m.empresa, m.mes)
  ),
  descoberto_hist AS (
    SELECT x.empresa, x.dia
      FROM descoberto x
      JOIN mes_reprovado r ON r.empresa = x.empresa AND r.mes = date_trunc('month', x.dia)::date
  ),
  decisao AS (
    SELECT a.id, g.so_id, g.valor,
           CASE
             WHEN g.so_id IS NOT NULL THEN 'virou_pedido'
             WHEN g.indeterminado     THEN 'nao_medivel'
             WHEN a.fase = 'historico' THEN
               CASE
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                                 AND x.dia + 5 < p_hoje)       THEN 'nao_medivel'
                 WHEN EXISTS (SELECT 1 FROM descoberto_hist x
                               WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
                 ELSE 'nao_virou'
               END
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                             AND x.dia + 5 < p_hoje)           THEN 'nao_medivel'
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
             ELSE 'nao_virou'
           END AS desfecho,
           CASE
             WHEN g.so_id IS NOT NULL THEN NULL
             WHEN g.indeterminado     THEN 'desconto_nao_apurado'
             WHEN a.fase = 'historico' THEN 'historico_incompleto'
             ELSE 'sync_atrasado'
           END AS motivo
      FROM alvo a
      LEFT JOIN agg g ON g.sug_id = a.id
  )
  UPDATE public.venda_sugestao s
     SET desfecho        = d.desfecho,
         desfecho_motivo = CASE WHEN d.desfecho = 'nao_medivel' THEN d.motivo END,
         sales_order_id  = d.so_id,
         valor_realizado = CASE WHEN d.desfecho = 'virou_pedido' THEN d.valor END,
         avaliado_em     = now()
    FROM decisao d
   WHERE d.id = s.id
     AND d.desfecho IS NOT NULL
     AND s.desfecho IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.venda_fechar_desfechos(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_fechar_desfechos(date) TO service_role;

-- ── 5. PÓS ───────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.venda_fechar_desfechos(date)'));
  f text;
BEGIN
  IF v_vivo IS DISTINCT FROM 'd187360234689981761b1cdfac225b2e' THEN
    RAISE EXCEPTION 'POS FALHOU: venda_fechar_desfechos vivo md5 % (esperado este)', v_vivo;
  END IF;
  FOREACH f IN ARRAY ARRAY['public.venda_fechar_desfechos(date)','private.venda_mes_completo_por_dados(text,date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executavel por anon/PUBLIC/authenticated', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'venda_fechar_desfechos' AND p.prosecdef
                    AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'POS FALHOU: venda_fechar_desfechos sem SECURITY DEFINER/search_path fixo';
  END IF;
  RAISE NOTICE 'venda_cliente_historico_prova_dados OK';
END
$pos$;

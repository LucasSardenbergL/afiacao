-- 20261031200100_reposicao_ruptura_sensor_universo.sql
-- ============================================================================================
-- Correção da 20261031200000 (sensor de ruptura da Oben), apontada pelo gate `universo-pedidos`
-- do CI: TODA leitura de `sales_orders` leva o par canônico `<alias>.status NOT IN (não-venda)`
-- + `<alias>.deleted_at IS NULL` (autoridade: src/lib/farmer/universo-pedidos.ts, STATUS_NAO_VENDA).
-- A migration anterior já está aplicada em prod (imutável): esta RECRIA só o que muda —
--   • `reposicao_ruptura_registrar_item()` (trigger): PV cancelado/rascunho/pendente/orçamento ou
--     apagado NÃO registra (antes: cancelado registrava como `indeterminado` e a view o descartava);
--   • `v_reposicao_ruptura_pedidos_semana`: o denominador de cobertura (`itens_importados`) usa o
--     MESMO par — numerador e denominador no mesmo universo.
-- `CREATE OR REPLACE` preserva o ACL; o REVOKE/GRANT é reemitido mesmo assim (regra da casa), e o
-- `WITH (security_invoker=on)` repetido (omitir RESETA a opção).
-- Idempotente; postcondição P1–P4 falha alto; marcador positivo no fim.

CREATE OR REPLACE FUNCTION public.reposicao_ruptura_registrar_item()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_so      record;
  v_ip      record;
  v_leitura text;
  v_agora   timestamptz := clock_timestamp();
BEGIN
  -- Universo canônico de pedidos (gate universo-pedidos): o par status NOT IN (não-venda) + deleted_at IS NULL
  -- em TODA leitura de sales_orders. PV cancelado/rascunho/pendente/orçamento ou apagado NÃO entra no sensor
  -- (nem no numerador nem no denominador da cobertura — a view usa o mesmo par).
  SELECT so.account, so.status, so.order_date_kpi, so.omie_pedido_id, so.hash_payload
    INTO v_so
    FROM public.sales_orders so
   WHERE so.id = NEW.sales_order_id
     AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
     AND so.deleted_at IS NULL;
  -- Só PV importado do Omie da Oben (hash 'omie_%'); pedido do app tem gate próprio (ATP).
  IF NOT FOUND OR v_so.account IS DISTINCT FROM 'oben'
     OR v_so.hash_payload IS NULL OR v_so.hash_payload NOT LIKE 'omie\_%' THEN
    RETURN NEW;
  END IF;
  -- Quantidade ilegível não é leitura: pula (a cobertura semanal mostra o buraco).
  IF NEW.omie_codigo_produto IS NULL OR NEW.quantity IS NULL OR NEW.quantity = 'NaN'
     OR NEW.quantity <= 0 OR NEW.quantity >= 1000000 THEN
    RAISE WARNING 'reposicao_ruptura_registrar_item: item % sem quantidade/sku legivel (qtd=%)', NEW.id, NEW.quantity;
    RETURN NEW;
  END IF;

  -- Leitura fresca (≤ 48h) na união das duas posições; sem linha = sem leitura (nunca 0).
  SELECT saldo, lido_em, fonte INTO v_ip
    FROM public._reposicao_ruptura_saldo_oben(NEW.omie_codigo_produto, v_agora - interval '48 hours');

  IF v_so.status IN ('faturado', 'cancelado') THEN
    v_leitura := 'indeterminado';
  ELSIF NOT FOUND THEN
    v_leitura := 'sem_leitura';
  ELSIF v_ip.saldo >= NEW.quantity THEN
    v_leitura := 'atendivel';
  ELSE
    v_leitura := 'ruptura';
  END IF;

  INSERT INTO public.reposicao_ruptura_pedido_itens
    (empresa, sales_order_id, order_item_id, omie_pedido_id, omie_codigo_produto, omie_codigo_item,
     quantidade, status_pv, data_pedido, estoque_saldo, estoque_lido_em, estoque_fonte, leitura, registrado_em)
  VALUES
    ('oben', NEW.sales_order_id, NEW.id, v_so.omie_pedido_id, NEW.omie_codigo_produto, NEW.omie_codigo_item,
     NEW.quantity, v_so.status, v_so.order_date_kpi,
     CASE WHEN FOUND THEN v_ip.saldo END,
     CASE WHEN FOUND THEN v_ip.lido_em END,
     CASE WHEN FOUND THEN v_ip.fonte END,
     v_leitura, v_agora)
  ON CONFLICT (sales_order_id, omie_codigo_produto, COALESCE(omie_codigo_item, 0)) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Fail-OPEN por desenho: telemetria nunca trava a importação de pedido (money-path). A perda não é
  -- muda — vai ao log e à cobertura_pct da view semanal.
  RAISE WARNING 'reposicao_ruptura_registrar_item: % (item %)', SQLERRM, NEW.id;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE VIEW public.v_reposicao_ruptura_pedidos_semana WITH (security_invoker=on) AS
WITH s AS (
  SELECT empresa,
         (date_trunc('week', registrado_em AT TIME ZONE 'America/Sao_Paulo'))::date AS semana,
         count(*)::integer AS itens_registrados,
         count(DISTINCT sales_order_id)::integer AS pedidos,
         (count(*) FILTER (WHERE leitura = 'atendivel'))::integer AS itens_atendiveis,
         (count(*) FILTER (WHERE leitura = 'ruptura'))::integer AS itens_ruptura,
         (count(*) FILTER (WHERE leitura = 'indeterminado'))::integer AS itens_indeterminados,
         (count(*) FILTER (WHERE leitura = 'sem_leitura'))::integer AS itens_sem_leitura
    FROM public.reposicao_ruptura_pedido_itens
   -- (o filtro `status_pv <> 'cancelado'` da 20261031200000 saiu: PV cancelado não é mais registrado — a
   -- sabotagem dele ficava verde, i.e. camada inalcançada.)
   WHERE registrado_em >= now() - interval '200 days'
   GROUP BY 1, 2
), imp AS (
  -- Denominador de COBERTURA: itens de PV importado da Oben na mesma semana (o trigger é fail-open).
  SELECT (date_trunc('week', oi.created_at AT TIME ZONE 'America/Sao_Paulo'))::date AS semana,
         count(*)::integer AS itens_importados
    FROM public.order_items oi
    JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = 'oben' AND so.hash_payload LIKE 'omie\_%' AND oi.hash_payload LIKE 'omie\_%'
     AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
     AND so.deleted_at IS NULL
     AND oi.created_at >= now() - interval '200 days'
   GROUP BY 1
)
SELECT s.empresa, s.semana, s.itens_registrados, imp.itens_importados, s.pedidos,
       s.itens_atendiveis, s.itens_ruptura, s.itens_indeterminados, s.itens_sem_leitura,
       -- fill-rate = atendíveis / decididos; só com ≥ 20 decididos (senão null, nunca 100% de 3 itens)
       CASE WHEN s.itens_atendiveis + s.itens_ruptura >= 20
            THEN round(100.0 * s.itens_atendiveis / (s.itens_atendiveis + s.itens_ruptura), 1) END AS fill_rate_pct,
       CASE WHEN imp.itens_importados > 0
            THEN round(100.0 * s.itens_registrados / imp.itens_importados, 1) END AS cobertura_pct
  FROM s
  LEFT JOIN imp USING (semana);

-- ACL reemitido (REPLACE preserva, mas a regra é não depender disso).
REVOKE ALL ON FUNCTION public.reposicao_ruptura_registrar_item() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.v_reposicao_ruptura_pedidos_semana FROM PUBLIC, anon;
GRANT SELECT ON public.v_reposicao_ruptura_pedidos_semana TO authenticated, service_role;

DO $post$
DECLARE
  v_fn text := pg_get_functiondef('public.reposicao_ruptura_registrar_item()'::regprocedure);
  v_vw text := pg_get_viewdef('public.v_reposicao_ruptura_pedidos_semana'::regclass);
BEGIN
  IF v_fn NOT LIKE '%so.deleted_at IS NULL%' OR v_fn NOT LIKE '%so.status NOT IN (''cancelado'', ''rascunho'', ''pendente'', ''orcamento'')%' THEN
    RAISE EXCEPTION 'P1 FALHOU: trigger sem o par canônico do universo de pedidos';
  END IF;
  IF v_vw NOT ILIKE '%so.deleted_at IS NULL%' OR v_vw NOT ILIKE '%so.status <> ALL%' AND v_vw NOT ILIKE '%so.status NOT IN%' THEN
    RAISE EXCEPTION 'P2 FALHOU: view sem o par canônico do universo de pedidos';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_reposicao_ruptura_pedidos_semana'::regclass
                  AND 'security_invoker=on' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'P3 FALHOU: view sem security_invoker=on';
  END IF;
  IF has_function_privilege('anon', 'public.reposicao_ruptura_registrar_item()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reposicao_ruptura_registrar_item()', 'EXECUTE')
     OR has_table_privilege('anon', 'public.v_reposicao_ruptura_pedidos_semana', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.v_reposicao_ruptura_pedidos_semana', 'SELECT') THEN
    RAISE EXCEPTION 'P4 FALHOU: privilégios do trigger/view fora do contrato';
  END IF;
  RAISE NOTICE 'REPOSICAO-RUPTURA-SENSOR-UNIVERSO-OK';
END
$post$;

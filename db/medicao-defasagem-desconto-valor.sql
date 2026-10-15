-- Medição read-only (psql-ro) do delta da migration 20261014211500_defasagem_desconto_valor.sql.
-- Rodar: ~/.config/afiacao/psql-ro -A -F'|' -v ON_ERROR_STOP=1 -f db/medicao-defasagem-desconto-valor.sql
-- Resultado de 2026-10-14 no corpo do PR.
-- Delta do guard desconto_nao_provado: replica a âncora de get_defasagem_cliente para TODO par
-- (cliente, produto, grupo de conta) e a cascata de status até o ponto que depende do carrinho.
WITH linhas AS (
  SELECT oi.customer_user_id cu, oi.omie_codigo_produto cod,
    CASE WHEN so.account IN ('vendas','oben') THEN 'oben'
         WHEN so.account IN ('colacor_vendas','colacor') THEN 'colacor'
         WHEN so.account IN ('servicos','colacor_sc') THEN 'colacor_sc' ELSE so.account END grp,
    oi.unit_price, oi.quantity, oi.desconto_valor dv, so.discount dp,
    COALESCE(to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'), so.order_date_kpi) data_real,
    ((so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL OR so.order_date_kpi IS NOT NULL) data_ok
  FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.omie_pedido_id IS NOT NULL AND so.deleted_at IS NULL
    AND oi.customer_user_id IS NOT NULL AND oi.omie_codigo_produto IS NOT NULL
), md AS (
  SELECT cu,cod,grp, max(data_real) FILTER (WHERE data_ok AND data_real IS NOT NULL) d FROM linhas GROUP BY 1,2,3
), anc AS (
  SELECT l.cu,l.cod,l.grp, md.d,
    CASE WHEN sum(quantity) FILTER (WHERE unit_price>0)>0 THEN sum(unit_price*quantity) FILTER (WHERE unit_price>0)/sum(quantity) FILTER (WHERE unit_price>0) END p_last,
    bool_or(COALESCE(dp,0)>0) disc_capa,
    bool_or(dv>0) disc_pos,           -- algum item com desconto provado >0
    bool_or(dv IS NULL) disc_nulo,    -- algum item não apurado
    bool_and(dv = 0) disc_zero_todos  -- todos apurados = 0
  FROM linhas l JOIN md USING (cu,cod,grp) WHERE l.data_real = md.d GROUP BY 1,2,3,4
), acc AS (SELECT grp, CASE grp WHEN 'oben' THEN ARRAY['vendas','oben'] WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc'] ELSE ARRAY[grp] END accs FROM (SELECT DISTINCT grp FROM anc) g)
, full_ AS (
  SELECT a.*, cn.cmc c_now, cn.synced_at, cl.cmc c_last
  FROM anc a JOIN acc USING (grp)
  LEFT JOIN LATERAL (SELECT ip.cmc, ip.synced_at FROM inventory_position ip WHERE ip.omie_codigo_produto=a.cod AND ip.cmc>0 AND ip.cmc<>'NaN' AND ip.account=ANY(acc.accs) ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1) cn ON true
  LEFT JOIN LATERAL (SELECT cs.cmc FROM cmc_snapshot cs WHERE a.d IS NOT NULL AND cs.omie_codigo_produto=a.cod AND cs.account=ANY(acc.accs) AND cs.cmc>0 AND cs.cmc<>'NaN' AND abs(cs.data_posicao-a.d)<=7 ORDER BY abs(cs.data_posicao-a.d), cs.synced_at DESC LIMIT 1) cl ON true
), st AS (
  SELECT *, CASE
    WHEN d IS NULL THEN 'sem_data_confiavel'
    WHEN c_now IS NULL OR synced_at IS NULL OR synced_at < now()-interval '48 hours' THEN 'sem_custo_atual_fresco'
    WHEN c_last IS NULL THEN 'neutro:sem_custo_historico'
    WHEN p_last IS NULL OR p_last<=0 OR c_last<=0 OR c_now<=0 THEN 'neutro:sem_base'
    WHEN extract(epoch FROM now()-d::timestamptz)/(86400*30.4375) > 18 THEN 'neutro:ancora_antiga'
    WHEN c_now/c_last - 1 > 0.5 THEN 'revisar:quarentena_custo'
    WHEN p_last <= c_last THEN 'neutro:prejuizo_ancora'
    WHEN c_now <= c_last THEN 'sem_alta:custo_nao_subiu'
    WHEN c_now/c_last - 1 < 0.02 THEN 'sem_alta:alta_ruido'
    ELSE 'CALCULAVEL:em_dia|defasado(depende do carrinho)' END status_antigo
  FROM full_
)
SELECT status_antigo,
  count(*) pares,
  count(*) FILTER (WHERE disc_pos OR disc_capa) muda_A_so_positivo,
  count(*) FILTER (WHERE disc_pos OR disc_capa OR disc_nulo) muda_B_positivo_ou_nulo,
  count(*) FILTER (WHERE (disc_pos OR disc_capa OR disc_nulo) AND d >= current_date - interval '18 months') muda_B_ancora_18m,
  count(DISTINCT cu) FILTER (WHERE disc_pos OR disc_capa) clientes_A,
  count(DISTINCT cu) FILTER (WHERE disc_pos OR disc_capa OR disc_nulo) clientes_B
FROM st GROUP BY ROLLUP(status_antigo) ORDER BY 1 NULLS LAST;

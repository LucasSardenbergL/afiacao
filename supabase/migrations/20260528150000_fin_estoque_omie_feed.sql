-- ============================================================
-- Feed de estoque do Omie p/ NCG/CCC (money-path)
-- ------------------------------------------------------------
-- Problema: fin_estoque_valor (input MANUAL do balancete, Onda 1) está vazia
-- nas 3 empresas → fin-cashflow-engine cai em estoque=0 → NCG subestima o ACO
-- e PME/CCC degradam. A RPC de estimativa estava quebrada (lia sku_estoque_atual
-- com case-mismatch 'oben'≠'OBEN' + product_costs.cost_price proxy ~2×).
--
-- Parte 1 (Passo 2): reescreve fin_estimar_estoque_omie p/ derivar de
--   inventory_position(saldo×cmc) — cmc = Custo Médio Contábil do Omie. Mapeia
--   empresa→account CANÔNICO do analytics-sync (oben→vendas, colacor→colacor_vendas,
--   colacor_sc→servicos) e EXCLUI os labels crus 'oben'/'colacor' do sync-reprocess
--   (mesmo SKU em 2 convenções = double-count). Só saldo>0 entra no valor; cmc=0
--   fica fora do valor mas dentro da cobertura. plpgsql + lower(trim) + RAISE em
--   empresa inválida (sem 0 silencioso em money-path). Assinatura PRESERVADA.
--   NÃO grava em fin_estoque_valor — só estima; o master revisa e salva (gate da Onda 1).
--
-- Parte 2 (Passo 0): liga o sync de inventário p/ colacor_vendas + servicos.
--   Antes só 'vendas' (oben) tinha cron → a INDÚSTRIA (colacor, maior estoque) e
--   colacor_sc ficavam com 0 linhas em inventory_position. A função omie-analytics-sync
--   já suporta sync_inventory p/ esses accounts (credenciais existem) — faltava só cron.
--   SEM deploy de edge function.
--
-- Idempotente (CREATE OR REPLACE + cron.schedule upserta por nome).
-- ============================================================

-- Parte 1 — RPC de estimativa via inventory_position(saldo×cmc), canônica + guards.
CREATE OR REPLACE FUNCTION public.fin_estimar_estoque_omie(p_company text)
RETURNS TABLE (valor_estimado numeric, cobertura_pct numeric, skus_total int, skus_com_custo int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_account text;
BEGIN
  v_account := CASE lower(trim(p_company))
                 WHEN 'oben'       THEN 'vendas'
                 WHEN 'colacor'    THEN 'colacor_vendas'
                 WHEN 'colacor_sc' THEN 'servicos'
               END;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'fin_estimar_estoque_omie: empresa invalida %', p_company USING ERRCODE = 'P0001';
  END IF;
  RETURN QUERY
    WITH canon AS (
      SELECT ip.saldo, ip.cmc
        FROM public.inventory_position ip
       WHERE ip.account = v_account
         AND ip.saldo > 0
    )
    SELECT
      COALESCE(SUM(CASE WHEN cmc > 0 THEN saldo * cmc ELSE 0 END), 0)::numeric,
      CASE WHEN COUNT(*) = 0 THEN 0::numeric
           ELSE ROUND(100.0 * COUNT(*) FILTER (WHERE cmc > 0) / COUNT(*), 2) END,
      COUNT(*)::int,
      COUNT(*) FILTER (WHERE cmc > 0)::int
    FROM canon;
END;
$$;
GRANT EXECUTE ON FUNCTION public.fin_estimar_estoque_omie(text) TO authenticated, service_role;

-- Parte 2 — crons de sync de inventário p/ colacor_vendas + servicos (escalonados;
-- contas Omie distintas do 'vendas' → sem contenção de rate-limit; minutos :15/:25
-- não colidem com o vendas em :00/:30).
SELECT cron.schedule('sync-inventory-colacor-vendas-1h', '15 * * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action":"sync_inventory","account":"colacor_vendas"}'::jsonb,
    timeout_milliseconds:=60000);$cron$);

SELECT cron.schedule('sync-inventory-servicos-1h', '25 * * * *',
  $cron$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action":"sync_inventory","account":"servicos"}'::jsonb,
    timeout_milliseconds:=60000);$cron$);

-- Validação inline (mostra os números no Run).
SELECT 'fin_estoque_omie_feed OK' AS status,
  (SELECT valor_estimado FROM public.fin_estimar_estoque_omie('oben'))       AS estoque_oben,
  (SELECT valor_estimado FROM public.fin_estimar_estoque_omie('colacor'))    AS estoque_colacor,
  (SELECT valor_estimado FROM public.fin_estimar_estoque_omie('colacor_sc')) AS estoque_colacor_sc,
  (SELECT count(*) FROM cron.job WHERE jobname LIKE 'sync-inventory-%')       AS crons_inventario;

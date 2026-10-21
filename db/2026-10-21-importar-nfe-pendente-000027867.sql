-- ============================================================
-- Importação por chave da NF-e 000027867 (OB), pendente SEM itens desde a importação antiga — o mesmo
-- caminho do botão "Importar NF-e" de /recebimento: POST na omie-nfe-recebimento-sync (v1.6) com
-- { chave_acesso, warehouse_id }, autenticado pelo CRON_SECRET do vault. A edge consulta o Omie por
-- chave e chama a RPC transacional importar_nfe_recebimento (reparo do cabeçalho pendente sem itens
-- e sem sinais de uso, ou bloqueada/divergente, ou recusa do Omie se a nota já foi recebida lá).
-- Pedido do founder em 2026-10-21. Aplicar: bun run db:aplicar db/2026-10-21-importar-nfe-pendente-000027867.sql
-- A resposta da edge cai em net._http_response (request_id no NOTICE); leitura por psql-ro.
-- ============================================================
DO $disparo$
DECLARE
  v_id bigint;
BEGIN
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-nfe-recebimento-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := jsonb_build_object(
      'chave_acesso', '42260304340141000104550010000278671158395171',
      'warehouse_id', '850960ad-b527-43d7-ba3c-f4f20f9412d2'),
    timeout_milliseconds := 40000) INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'B1 FALHOU: net.http_post nao devolveu request_id — nada foi disparado';
  END IF;
  RAISE NOTICE 'IMPORTAR_NFE_000027867 request_id=%', v_id;
END
$disparo$;

-- ============================================================
-- afiacao_omie_oben_sku_items_2h — cron PRÓPRIO do omie-sync-sku-items, no minuto :35
-- Objetivo: tirar a `ConsultarRecebimento` do sku-items do MESMO ciclo do step NFe do
--           `omie-cron-diario` (jobid 52, :15), onde ela é REDUNDANT — a Omie responde "Consumo
--           redundante detectado. Aguarde ~50 segundos" porque o step NFe acabou de fazer a
--           chamada idêntica. Medido 2026-09-23: 46 runs `error` e 6 e-mails falsos em 30 dias,
--           todos no :15/:16; zero nos 30 runs das 07:00 (jobid 53, sem step NFe antes).
-- Contexto: docs/historico/sku-items-consumo-redundante-no-ciclo.md
-- Par:      o PR que tira o step `sku_items` do `omie-cron-diario`. Aquele deploy vem DEPOIS
--           deste cron existir e rodar uma vez `complete` — na ordem inversa a cadência de 2h
--           some e sobra só o diário das 07:00.
-- ============================================================
-- Por que :35: o step NFe do jobid 52 começa ~:15 e cede em até 130s (≤ ~:18, ou ~:19 com o
-- retry de 425 do orquestrador); a janela REDUNDANT da Omie é de ~60s. O :35 fica ~16 min depois
-- e está vazio no mapa de minutos dos 93 jobs (medido 2026-09-23/24: :40 =
-- omie-sync-estoque-intraday-oben, :45 = compute-costs-daily; nenhum job no :35).
-- `dias=3` = a mesma janela que o orquestrador passava ao step. O diário das 07:00 (dias=30) segue.
-- `timeout_milliseconds` explícito (docs/agent/sync.md): o default do pg_net (5s) mata em silêncio
-- uma edge de até ~50s; 120000 é o mesmo do jobid 53.
-- DONO: o pg_cron roda o job como QUEM O AGENDA. Cole como `postgres` (SQL Editor do Lovable) —
-- o job precisa ler o Vault. O `claude_rw` nem tem USAGE no schema `cron` (medido 2026-09-24).
-- Idempotente: re-colar remove e recria com o mesmo nome e a mesma configuração.

BEGIN;

SELECT cron.unschedule('afiacao_omie_oben_sku_items_2h')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'afiacao_omie_oben_sku_items_2h');

SELECT cron.schedule(
  'afiacao_omie_oben_sku_items_2h',
  '35 */2 * * *',
  $cmd$
  select net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sync-sku-items',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'CRON_SECRET' limit 1)
    ),
    body := jsonb_build_object('empresa', 'OBEN', 'dias', 3),
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- ------------------------------------------------------------
-- Postcondição — relê o catálogo; aborta o Run se o cron não pegou ou pegou errado
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_job cron.job%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM cron.job WHERE jobname = 'afiacao_omie_oben_sku_items_2h';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'A1 FALHOU: cron afiacao_omie_oben_sku_items_2h ausente — o sku-items ficaria so no diario das 07:00';
  END IF;
  IF v_job.schedule <> '35 */2 * * *' OR NOT v_job.active THEN
    RAISE EXCEPTION 'A2 FALHOU: schedule=% active=% — esperado 35 */2 * * * ativo', v_job.schedule, v_job.active;
  END IF;
  IF v_job.command NOT LIKE '%/functions/v1/omie-sync-sku-items''%'
     OR v_job.command NOT LIKE '%x-cron-secret%'
     OR v_job.command NOT LIKE '%''dias'', 3)%'
     OR v_job.command NOT LIKE '%timeout_milliseconds := 120000%' THEN
    RAISE EXCEPTION 'A3 FALHOU: o comando nao chama a edge com x-cron-secret, dias=3 e timeout de 120s';
  END IF;
  IF v_job.username <> 'postgres' THEN
    RAISE EXCEPTION 'A4 FALHOU: o job roda como % — tem de ser postgres, senao nao le o Vault e toda chamada volta 401', v_job.username;
  END IF;
  -- A5: nenhum OUTRO job ativo chama o sku-items no mesmo minuto (duas chamadas iguais no mesmo
  -- minuto recriariam o REDUNDANT que este cron existe para eliminar).
  IF EXISTS (
    SELECT 1 FROM cron.job j
    WHERE j.active AND j.jobname <> 'afiacao_omie_oben_sku_items_2h'
      AND j.command LIKE '%omie-sync-sku-items%'
      AND split_part(j.schedule, ' ', 1) = '35'
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: outro job ativo chama o omie-sync-sku-items no minuto 35';
  END IF;
  RAISE NOTICE 'cron afiacao_omie_oben_sku_items_2h agendado: 35 */2 * * *, dias=3, 120s, dono postgres';
END
$post$;

COMMIT;

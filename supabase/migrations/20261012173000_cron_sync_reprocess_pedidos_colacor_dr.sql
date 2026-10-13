-- DR do cron `sync-reprocess-pedidos-colacor-2h` (M-37 · Lote D)
--
-- POR QUE: o cron nasceu pelo script `db/2026-10-11-cron-reconciliar-pedidos-colacor.sql` (#2957),
-- aplicado via `db:aplicar` — nenhuma migration o cria, então um rebuild por replay de
-- `supabase/migrations/` o perderia. O gate `scripts/cron-jobs-snapshot-gate.ts` acusou
-- `sem-migration` na recaptura de `supabase/cron-jobs-snapshot.tsv` (2026-10-12).
--
-- O QUE: agenda o job SÓ SE ELE NÃO EXISTIR. Em prod o job já existe (jobid 198) → no-op; num
-- rebuild, recria com o comando GRAVADO em prod, byte a byte (md5 b8a85ce3584a68c70700f6646b721bd5,
-- extraído via psql-ro em 2026-10-12). O segredo vem do Vault no RUNTIME — nada literal aqui.
-- Fonte da verdade do comando continua sendo o script do #2957; este arquivo é a cópia de DR.
--
-- PÓS-CONDIÇÃO ($post$): o job existe com o schedule '40 */2 * * *' e ativo.

BEGIN;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-reprocess-pedidos-colacor-2h') THEN
    PERFORM cron.schedule('sync-reprocess-pedidos-colacor-2h', '40 */2 * * *', $cron$
SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/sync-reprocess',
  headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
  body:='{"action": "reprocess_operational_orders", "account": "colacor"}'::jsonb,timeout_milliseconds:=150000);$cron$);
  END IF;
END
$do$;

DO $post$
DECLARE
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM cron.job
   WHERE jobname = 'sync-reprocess-pedidos-colacor-2h' AND schedule = '40 */2 * * *' AND active;
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'POSCONDICAO_FALHOU: sync-reprocess-pedidos-colacor-2h ausente/inativo/schedule errado (n=%)', v_n;
  END IF;
END
$post$;

COMMIT;

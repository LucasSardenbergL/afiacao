-- ============================================================
-- Pausa o cron 'monthly-tool-report' (jobid 37 na prod em 2026-07-18)
--
-- POR QUÊ: o relatório mensal de ferramentas nunca esteve vivo. Medido em prod:
--   · `tool_events` = 0 linhas e SEM NENHUM WRITER — nada no repo (src/ ou
--     supabase/functions/) insere nela; a única referência em src é leitura
--     (useToolEvents) e a única função no banco é get_public_tool_history (leitura).
--     A ACL permite INSERT (anon=arwdDxtm) — não é bloqueio técnico, é feature
--     nunca ligada. Logo o relatório sairia "0 afiações / 0 anomalias" para sempre.
--   · `user_tools` = 4 linhas de 2 donos, ambos com profiles.email E profiles.phone
--     NULOS (aliases fiscais do import Omie, `last_sign_in_at` NULL). O gate de envio
--     da edge (`&& profile.email`) nunca pode ser satisfeito → ZERO e-mails, em
--     silêncio. O fallback WhatsApp também não existe para eles (phone NULL).
--   · Entorno igualmente vazio: orders = 0, recurring_schedules = 0,
--     order_price_history = 0. O negócio real roda por sales_orders (29.948).
--
-- O cadastro geral é saudável (4.949/5.296 profiles com e-mail), então isto NÃO é
-- um problema de contato: é adoção zero de uma feature que nunca foi ligada.
--
-- PAUSA, não remove: `active := false` preserva a definição (schedule + o lookup do
-- CRON_SECRET no Vault) para religar com um único `active := true` se o produto for
-- revivido. Os crons NÃO vivem no schema-snapshot.sql (só views que leem cron.job),
-- por isso a pausa precisa desta migration versionada para sobreviver a um restore.
--
-- PARA RELIGAR: ver a nota no fim deste arquivo.
--
-- Referência: decisão do founder em 2026-07-18 (sessão de diagnóstico do cron 37).
-- ============================================================

DO $$
DECLARE
  v_jobid  bigint;
  v_active boolean;
BEGIN
  -- Busca por NOME, não por jobid hardcoded: o jobid não é estável entre
  -- restores/DR, o nome é.
  SELECT jobid, active
    INTO v_jobid, v_active
    FROM cron.job
   WHERE jobname = 'monthly-tool-report';

  IF v_jobid IS NULL THEN
    RAISE NOTICE 'cron "monthly-tool-report" não existe — nada a fazer (idempotente).';
    RETURN;
  END IF;

  IF v_active IS FALSE THEN
    RAISE NOTICE 'cron "monthly-tool-report" (jobid %) já estava pausado — nada a fazer.', v_jobid;
    RETURN;
  END IF;

  -- alter_job só altera os parâmetros passados; schedule/command/database/username
  -- ficam intactos (default NULL = preserva).
  PERFORM cron.alter_job(v_jobid, active := false);

  RAISE NOTICE 'cron "monthly-tool-report" (jobid %) PAUSADO.', v_jobid;
END $$;

-- ------------------------------------------------------------
-- PARA RELIGAR (quando/se o relatório voltar a ser produto vivo):
--
--   SELECT cron.alter_job(
--     (SELECT jobid FROM cron.job WHERE jobname = 'monthly-tool-report'),
--     active := true
--   );
--
-- Mas religar o cron NÃO basta — sem estas duas coisas ele volta a entregar zero:
--   1. Um WRITER para `tool_events`, amarrado ao fluxo real de afiação
--      (hoje em sales_orders / Omie). Sem isso o relatório é "0 afiações" perpétuo.
--   2. Contato para os donos de ferramenta (decisão de 2026-07-18: vir do
--      cadastro Omie, com backfill em profiles.email — checar consentimento/LGPD
--      antes, não é backfill mecânico).
-- ------------------------------------------------------------

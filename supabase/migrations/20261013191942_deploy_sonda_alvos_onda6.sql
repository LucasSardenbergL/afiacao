-- ============================================================
-- deploy_sonda_alvos — onda 6 da F4: picking-fila-omie
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
--             20260909222423_deploy_sonda_alvos_onda5.sql      (16 alvos ativos)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) passou a declarar.
-- A tabela é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo`.
--
-- POR QUE ELA ENTRA: sem alvo de cron a edge não tem atestação passiva, e o ledger acusou o
-- deploy de 2026-10-13 como pendente por horas depois de o bundle novo já responder `v0.5` nos
-- crons `picking-fila-oben`/`picking-fila-colacor` — pendência falsa que custa sonda manual a cada
-- PR que toca a edge.
--
-- O QUE A PROVA MEDIU: `bun scripts/sonda-cron-prova.ts --backfill picking-fila-omie` — ver o
-- corpo do PR. O preflight `OPTIONS` passou a atender a sonda e sair ANTES do
-- `authorizeCronOrStaff`, do `createClient` e de qualquer chamada ao Omie (v0.6-sonda-cron).
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a PERGUNTAR, e quem responde é o bundle
-- SERVIDO. Até o deploy da v0.6, o bundle no ar responde o `"ok"` antigo — silêncio é fail-closed.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('picking-fila-omie', 'F4 onda 6: closures históricos com zero efeito ao OPTIONS e degrau de controle (x-cron-secret com {} cai no modo diagnostico, que chama o Omie); edge de ESCRITA — a sonda sai antes do gate, do createClient e do Omie')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição — aborta a transação se o estado final não bater
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_total int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a
    WHERE a.edge = 'picking-fila-omie' AND a.ativo
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: picking-fila-omie ausente ou inativa — o cron nao sondaria essa edge, e o ledger seguiria acusando deploy pendente';
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 17 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 17 alvos ativos (16 ate a onda 5 + 1 onda 6), achei % — banco e repo divergiram', v_total;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: alvo da onda 6 ativo — 17 no total';
END
$post$;

COMMIT;

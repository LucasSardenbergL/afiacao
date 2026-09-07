-- ============================================================
-- deploy_sonda_alvos — onda 1 da F4: mais quatro edges se atestam sozinhas
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md §11
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) já declara. A tabela
-- é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo` e acusa alvo que exista
-- aqui sem existir lá. Por isso a inserção é a ÚLTIMA etapa da onda — depois de `sonda:cron-prova`
-- ter EXECUTADO os 89 closures novos com zero efeito.
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a perguntar, e quem responde é o bundle em
-- produção. Enquanto o founder não deployar cada uma no Lovable, a resposta é o CORS de sempre e
-- a edge aparece como "não atestou" — que é o comportamento correto, não uma falha.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('sync-reprocess',                  'F4 onda 1: 44/44 closures com zero efeito ao OPTIONS; ficou fora da F1 por COLISAO com o PR #2224, nunca por risco'),
  ('reposicao-depara-sayerlack-auto', 'F4 onda 1: 17/17 closures; efeito nao-externo (so .rpc no proprio banco)'),
  ('carteira-positivacao-snapshot',   'F4 onda 1: 18/18 closures; efeito nao-externo (um upsert)'),
  ('process-recurring-orders',        'F4 onda 1: 10/10 closures; efeito nao-externo (insert/update, sem chamada a terceiro)')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_faltando text;
BEGIN
  SELECT string_agg(e, ', ') INTO v_faltando
  FROM unnest(ARRAY[
    'sync-reprocess', 'reposicao-depara-sayerlack-auto',
    'carteira-positivacao-snapshot', 'process-recurring-orders'
  ]) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a WHERE a.edge = e AND a.ativo
  );
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: alvo(s) ausente(s) ou inativo(s): % — o cron nao sondaria essas edges', v_faltando;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: 4 alvos da onda 1 ativos — o cron passa a perguntar a versao deles';
END
$post$;

COMMIT;

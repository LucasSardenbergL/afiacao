-- ============================================================
-- deploy_sonda_alvos — onda 2 da F4: mais quatro edges se atestam sozinhas
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md §11
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
--             20260907101349_deploy_sonda_alvos_onda1.sql      (os 4 alvos da onda 1)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) já declara. A tabela
-- é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo` e acusa alvo que exista
-- aqui sem existir lá. Por isso a inserção é a ÚLTIMA etapa da onda — depois de `sonda:cron-prova`
-- ter EXECUTADO os 126 closures novos com zero efeito.
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a PERGUNTAR, e quem responde é o bundle
-- servido. As 4 edges desta onda ganharam o bloco `atenderSondaOptions` nesta mesma fatia — até o
-- deploy delas, o cron pergunta e o bundle velho devolve o preflight de sempre, sem versão. O
-- silêncio é o comportamento certo (fail-closed), não um bug.
--
-- POR QUE ESTAS QUATRO, E NÃO "TODAS": a onda 2 pôs 11 candidatas na allowlist e deixou o
-- `sonda:cron-prova --backfill` julgar cada uma pela história inteira. Sete REPROVARAM, com o
-- contador de efeito subindo em closures que já estiveram no ar (`fin-cashflow-engine` 0/37,
-- `omie-cliente` 1/68, `omie-analytics-sync` 16/86, `omie-vendas-sync` 127/188,
-- `omie-sync-estoque` 28/29, `omie-sync-nfes-recebidas` 35/36, `generate-bundle-argument` 12/14).
-- 35/36 não é "quase seguro": o closure que falta executaria efeito ao receber o OPTIONS do cron.
-- Elas saíram da lista — o registro de por que está no comentário da allowlist, para a onda 3.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('copilot-analyze',        'F4 onda 2: 15/15 closures com zero efeito ao OPTIONS; controle positivo exigiu corpo com transcript real (com {} o 400 de transcricao curta tornava o controle inerte)'),
  ('fin-valor-cockpit',      'F4 onda 2: 40/40 closures; leitura financeira, efeito nao-externo'),
  ('recommend',              'F4 onda 2: 30/30 closures; efeito nao-externo'),
  ('generate-tactical-plan', 'F4 onda 2: 41/41 closures; efeito nao-externo')
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
    'copilot-analyze', 'fin-valor-cockpit', 'recommend', 'generate-tactical-plan'
  ]) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a WHERE a.edge = e AND a.ativo
  );
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: alvo(s) ausente(s) ou inativo(s): % — o cron nao sondaria essas edges', v_faltando;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: 4 alvos da onda 2 ativos — 11 no total';
END
$post$;

COMMIT;

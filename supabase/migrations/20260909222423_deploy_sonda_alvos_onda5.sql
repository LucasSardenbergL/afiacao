-- ============================================================
-- deploy_sonda_alvos — onda 5 da F4: a primeira edge de ESCRITA declarada
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md §11
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
--             20260907101349_deploy_sonda_alvos_onda1.sql      (4 alvos)
--             20260908070850_deploy_sonda_alvos_onda2.sql      (4 alvos)
--             20260908204421_deploy_sonda_alvos_onda3.sql      (3 alvos)
--             20260908223555_deploy_sonda_alvos_onda4.sql      (1 alvo)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) já declara. A tabela
-- é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo`.
--
-- POR QUE ELA ENTRA AGORA — o custo de ficar fora era RECORRENTE, não teórico. Sem alvo de cron
-- não há atestação passiva, então toda sessão que rodava o `/fecho` depois de um PR tocar esta
-- edge a via pendente e disparava sonda à mão. Em 2026-09-09 isso rendeu DUAS sondas manuais no
-- MESMO dia (#2447 e #2451), porque o #2448 mexeu no `index.ts` horas depois da 1ª atestação —
-- o padrão de trabalho duplicado por estado não compartilhado de
-- `docs/historico/chips-duplicados-por-estado-compartilhado.md`, aplicado a deploy.
--
-- O QUE A PROVA MEDIU (`bun run sonda:cron-prova --backfill omie-desconto-backfill`, 2026-09-09):
-- 2/2 closures PASSA — zero efeito ao OPTIONS do relé, com degrau de controle mostrando que o
-- contador enxerga o fluxo real daquele mesmo bundle. Não houve recorte de história: a edge nasceu
-- em 2026-09-08 (#2412) e tem exatamente esses dois `index.ts`.
--
-- ⚠️ POR QUE ESTA ENTRADA MERECE MAIS CUIDADO QUE AS ANTERIORES: esta é a primeira edge da
-- allowlist que declara ESCRITA no `EFEITO` do seu `versao.ts` — ela reescreve
-- `order_items.desconto_valor`, que é a base da receita líquida do `fin-valor-cockpit`. Um OPTIONS
-- que caísse no fluxo normal seria um backfill não pedido a cada 2h, consumindo quota do Omie e
-- carimbando desconto em milhares de linhas de venda. O que a torna segura não é a leitura do
-- handler, e sim a ORDEM provada por execução: `atenderSondaOptions` responde e SAI antes do
-- `authorizeCronOrStaff`, do `createClient` e de qualquer chamada ao Omie; e o `classificarSonda`
-- fail-closed manda `probe` malformado para um 400 explícito em vez de deixá-lo escorregar para o
-- caminho que escreve.
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a PERGUNTAR, e quem responde é o bundle
-- SERVIDO. O bloco `OPTIONS` mudou de forma nesta mesma fatia (a guarda passou para DENTRO dele,
-- que é a forma que o `gateG1` sabe medir) — até o deploy, o cron pergunta e o bundle no ar
-- responde com a fonte anterior. Silêncio ou fonte velha é fail-closed, não bug.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-desconto-backfill', 'F4 onda 5: 2/2 closures com zero efeito ao OPTIONS e degrau de controle; primeira edge de ESCRITA declarada — o probe sai antes do createClient e de qualquer chamada ao Omie')
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
    WHERE a.edge = 'omie-desconto-backfill' AND a.ativo
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: omie-desconto-backfill ausente ou inativa — o cron nao sondaria essa edge, e o /fecho seguiria pedindo sonda manual';
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 16 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 16 alvos ativos (7 base + 4 onda 2 + 3 onda 3 + 1 onda 4 + 1 onda 5), achei % — banco e repo divergiram', v_total;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: alvo da onda 5 ativo — 16 no total';
END
$post$;

COMMIT;

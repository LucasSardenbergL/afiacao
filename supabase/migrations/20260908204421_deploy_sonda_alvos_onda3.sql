-- ============================================================
-- deploy_sonda_alvos — onda 3 da F4: as três que a onda 2 barrou por CONTROLE INERTE
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md §11
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
--             20260907101349_deploy_sonda_alvos_onda1.sql      (4 alvos)
--             20260908070850_deploy_sonda_alvos_onda2.sql      (4 alvos)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) já declara. A tabela
-- é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo`.
--
-- POR QUE ELAS VOLTAM: a onda 2 as reprovou, e o comentário dela dizia que "o contador de efeito
-- subiu". Era FALSO — as sete candidatas somavam ZERO closures `FALHA`. Todo não-PASSA era
-- `INVERIFICAVEL`, que quer dizer o oposto: o CONTROLE POSITIVO não conseguiu fazer o contador
-- subir, então o zero da parte (a) não valia nada. Controle inerte aprova qualquer coisa.
--
-- O QUE MUDOU, E É MEDIÇÃO: uma sonda executou a história inteira de cada uma contra uma escada
-- de corpos candidatos e reportou em que degrau o contador sobe. O `{}` dos controles padrão
-- morria em 401/400/500 de validação ANTES do primeiro efeito; com o corpo certo, sobe. Depois
-- disso, `sonda:cron-prova --backfill`:
--
--     omie-vendas-sync           127/188  ->  189/189   corpo {"action":"sync_products"}
--     omie-analytics-sync         16/86   ->   86/86    corpo {"action":"get_sync_state"}
--     generate-bundle-argument    12/14   ->   14/14    corpo com bundle/customer/customerProfile
--
-- Nenhum bundle histórico mudou de comportamento — mudou o que a prova consegue enxergar.
--
-- CONTINUAM FORA (e o registro está no comentário da allowlist): `fin-cashflow-engine` (8
-- closures sem degrau), `omie-sync-estoque` (1) e `omie-sync-nfes-recebidas` (1, um commit cujo
-- `index.ts` nem PARSEIA — `deno fmt` acusa `SyntaxError`, com o HEAD do mesmo arquivo como
-- controle em 0). `omie-cliente` idem, por outra causa de import.
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a PERGUNTAR, e quem responde é o bundle
-- servido. As 3 ganharam o bloco `atenderSondaOptions` nesta mesma fatia — até o deploy delas, o
-- cron pergunta e o bundle velho devolve o preflight de sempre. Silêncio é fail-closed, não bug.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-vendas-sync',         'F4 onda 3: 189/189 closures com zero efeito ao OPTIONS; controle exigiu corpo {"action":"sync_products"} — com {} o roteador devolve 400/500 antes do 1o client.from'),
  ('omie-analytics-sync',      'F4 onda 3: 86/86 closures; controle {"action":"get_sync_state"} e a rota mais barata que ainda toca o banco (3 efeitos, zero fetch externo)'),
  ('generate-bundle-argument', 'F4 onda 3: 14/14 closures; controle com bundle/customer/customerProfile minimos, que chegam ao POST do gateway de IA')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_faltando text;
  v_total    int;
BEGIN
  SELECT string_agg(e, ', ') INTO v_faltando
  FROM unnest(ARRAY[
    'omie-vendas-sync', 'omie-analytics-sync', 'generate-bundle-argument'
  ]) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a WHERE a.edge = e AND a.ativo
  );
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: alvo(s) ausente(s) ou inativo(s): % — o cron nao sondaria essas edges', v_faltando;
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 14 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 14 alvos ativos (7 base + 4 onda 2 + 3 onda 3), achei % — banco e repo divergiram', v_total;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: 3 alvos da onda 3 ativos — 14 no total';
END
$post$;

COMMIT;

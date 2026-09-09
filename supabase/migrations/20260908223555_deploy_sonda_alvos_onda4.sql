-- ============================================================
-- deploy_sonda_alvos — onda 4 da F4: a edge destravada pela classe `NAO_COMPILA`
-- Objetivo: docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md
-- Contexto:  docs/historico/sonda-por-cron-fail-closed.md §11
-- Depende de: 20260906151204_deploy_sonda_cron_fail_closed.sql (tabela, dispatcher, cron)
--             20260907101349_deploy_sonda_alvos_onda1.sql      (4 alvos)
--             20260908070850_deploy_sonda_alvos_onda2.sql      (4 alvos)
--             20260908204421_deploy_sonda_alvos_onda3.sql      (3 alvos)
-- ============================================================
-- Espelha no banco o que a allowlist do repo (`_shared/sonda-cron-alvos.ts`) já declara. A tabela
-- é ESPELHO, não fonte: `bun run pendencias:deploy` exige `banco ⊆ repo`.
--
-- POR QUE ELA ENTRA AGORA: `omie-sync-nfes-recebidas` tinha 35/36 closures com zero efeito. O 36º
-- (`b880daeb1`, 2026-04-19) não era perigoso — era IMPOSSÍVEL: o `index.ts` daquele commit não
-- PARSEIA (`SyntaxError: Expected '}', got '<eof>'`), então o Deno recusa o módulo, a função não
-- boota, e um bundle que não boota nunca respondeu a request nenhum. A prova tratava isso como
-- "não consegui medir" (`INVERIFICAVEL`) e barrava a edge PARA SEMPRE por um commit-lixo.
--
-- A onda 4 nomeia a classe `NAO_COMPILA`, que DISPENSA esse closure — e a dispensa sai NOMEADA no
-- relatório, nunca em silêncio. O discriminador é lista POSITIVA e separa duas coisas que pareciam
-- a mesma: bundle que NÃO COMPILA (dispensa) de import que NÃO RESOLVE (falha do harness, que não
-- prova nada sobre prod e CONTINUA barrando). Dois sintéticos vigiam essa fronteira, e sabotar o
-- discriminador deixa o `--falsificar` vermelho.
--
-- CONTINUAM FORA: `fin-cashflow-engine` (8 closures sem degrau de controle em corpo nenhum),
-- `omie-sync-estoque` (1) e `omie-cliente` (2 dispensados por `NAO_COMPILA`, mas 65 ainda inertes
-- — ela precisa de CORPO medido, como as da onda 3, e não da classe nova).
--
-- ⚠️ Inserir aqui NÃO faz a edge atestar: o cron passa a PERGUNTAR, e quem responde é o bundle
-- servido. Ela ganhou o bloco `atenderSondaOptions` nesta mesma fatia — até o deploy, o cron
-- pergunta e o bundle velho devolve o preflight de sempre. Silêncio é fail-closed, não bug.

BEGIN;

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-sync-nfes-recebidas', 'F4 onda 4: 35/36 closures com zero efeito ao OPTIONS; o 36o (b880daeb1) e NAO_COMPILA — index.ts nao parseia, logo nunca bootou nem serviu trafego')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_total int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a
    WHERE a.edge = 'omie-sync-nfes-recebidas' AND a.ativo
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: omie-sync-nfes-recebidas ausente ou inativa — o cron nao sondaria essa edge';
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 15 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 15 alvos ativos (7 base + 4 onda 2 + 3 onda 3 + 1 onda 4), achei % — banco e repo divergiram', v_total;
  END IF;

  RAISE NOTICE 'deploy_sonda_alvos: alvo da onda 4 ativo — 15 no total';
END
$post$;

COMMIT;

-- FU4-F fase 3 — public.product_costs sai do gate `employee` e vai para private.cap_custo_ler
--
-- ESTE E O ULTIMO ATO DA CADEIA. Aplicar fora de ordem APAGA feature viva, nao so fecha custo:
-- os engines excluem SKU sem custo desde o #1466/#1471, entao um farmer sem leitura recebe
-- lista VAZIA em vez de lista degradada. Por isso a migration se RECUSA a aplicar enquanto os
-- consumidores nao tiverem migrado — ver o bloco de precondicoes abaixo.
--
-- ESTADO MEDIDO EM PROD (psql-ro, 2026-07-21):
--   · DUAS policies PERMISSIVAS, ambas `master OR employee`:
--       "Staff can manage product costs" (FOR ALL)  e  "Staff can view product costs" (FOR SELECT)
--     Permissivas combinam com OR — fechar UMA nao fecha NADA. As DUAS sao substituidas.
--   · relacl: authenticated=arwdDxtm E anon=arwdDxtm. O `D` e TRUNCATE, que NAO passa por RLS:
--     trocar policy nao revoga GRANT. Sem REVOKE, um portador da chave anon (que e publica, vai
--     no bundle do frontend) mantem TRUNCATE sobre a tabela de custo. Achado desta sessao —
--     o enunciado citava so `authenticated`.
--   · 3.642 linhas, 5 sem custo canonico, 0 com NaN.
--
-- WRITERS (enumerados no codigo, 2026-07-21): sync-reprocess e omie-analytics-sync, ambos edges
-- com SERVICE_ROLE_KEY. service_role bypassa RLS e tem grant proprio (service_role=arwdDxtm), entao
-- revogar de authenticated/anon NAO toca o sync. Nenhum writer roda como `authenticated`.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- PRECONDICOES — a ordem de aplicacao manual passa a ser garantida pelo BANCO.
--
-- O founder aplica migrations a mao, uma de cada vez, e uma esquecida falha em SILENCIO.
-- Aqui o silencio e impossivel: se um consumidor ainda le product_costs direto, esta migration
-- ABORTA com a mensagem dizendo qual falta. E o mesmo padrao do §4.1 do spec da E2.
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('private.cap_custo_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.cap_custo_ler(uuid) ausente (a matriz do #1434 nao esta aplicada)';
  END IF;

  -- consumidor 1 e 2: useCrossSellEngine + useBundleEngine (PR-B, migration 20260725120000)
  IF to_regprocedure('public.get_skus_margem_positiva()') IS NULL THEN
    RAISE EXCEPTION
      'precondicao FALHOU: public.get_skus_margem_positiva() ausente. Aplique 20260725120000 ANTES — sem ela, fechar product_costs deixa cross-sell e bundles com lista VAZIA (os engines excluem SKU sem custo).';
  END IF;

  -- consumidor 3: useFarmerScoring (frente irmã — spec 2026-07-20-fechamento-custo-farmer-scoring-design.md).
  -- Se o nome da RPC daquela entrega mudar, ESTA linha e o lugar de ajustar — e falhar fechado
  -- aqui e melhor que zerar o health score dos 2 farmers em producao.
  IF to_regprocedure('public.get_carteira_margem_faixa()') IS NULL THEN
    RAISE EXCEPTION
      'precondicao FALHOU: public.get_carteira_margem_faixa() ausente. O useFarmerScoring ainda le product_costs direto (:183) — fechar agora zera o componente de margem do health score.';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. GRANTS. Trocar policy NAO mexe em GRANT, e TRUNCATE/REFERENCES/TRIGGER/MAINTAIN nao passam
--    por RLS. REVOKE de PUBLIC e no-op aqui: o Supabase concede por NOME.
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE public.product_costs FROM PUBLIC;
REVOKE ALL ON TABLE public.product_costs FROM anon;
REVOKE ALL ON TABLE public.product_costs FROM authenticated;

-- SELECT volta para authenticated porque a RLS e que decide QUEM le (a policy abaixo).
-- Sem o grant, a negacao viria do privilegio e a policy nunca seria exercida — o assert de RLS
-- viraria tautologia, exatamente o P3 da rodada 2 do Codex no #1488.
GRANT SELECT ON TABLE public.product_costs TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. POLICIES. As duas permissivas saem; entra UMA de leitura gateada.
--    Escrita fica sem policy de propósito: os unicos writers sao edges com service_role, que
--    bypassa RLS. Nenhuma policy de escrita = nenhum caminho de escrita para `authenticated`.
-- ─────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can manage product costs" ON public.product_costs;
DROP POLICY IF EXISTS "Staff can view product costs"   ON public.product_costs;

DROP POLICY IF EXISTS product_costs_select_custo ON public.product_costs;
CREATE POLICY product_costs_select_custo ON public.product_costs
  FOR SELECT
  TO authenticated
  USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));

ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;

COMMENT ON POLICY product_costs_select_custo ON public.product_costs IS
  'FU4-F fase 3: leitura de custo exige private.cap_custo_ler (master + estrategico + super_admin). Substituiu "Staff can manage/view product costs" (master OR employee) — as duas, porque policies permissivas combinam com OR. Consumidores migraram para get_skus_margem_positiva / get_carteira_margem_faixa.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. ASSERTS DE APLICACAO — rodam DENTRO da transacao; qualquer um falha, tudo volta.
--    Nao substituem o harness (db/test-authz-custo-fu4f-fase3-ranking.sh); pegam o caso
--    em que a PROD divergiu do que este arquivo assumiu.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_n_policies int;
  v_antigas    int;
BEGIN
  SELECT count(*) INTO v_antigas
  FROM pg_policies
  WHERE schemaname='public' AND tablename='product_costs'
    AND policyname IN ('Staff can manage product costs','Staff can view product costs');
  IF v_antigas <> 0 THEN
    RAISE EXCEPTION 'A1 FALHOU: % policy(s) antiga(s) sobreviveram — permissivas combinam com OR, o gate nao fechou', v_antigas;
  END IF;

  SELECT count(*) INTO v_n_policies
  FROM pg_policies WHERE schemaname='public' AND tablename='product_costs';
  IF v_n_policies <> 1 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava exatamente 1 policy em product_costs, encontrei %', v_n_policies;
  END IF;

  -- privilegio residual: se authenticated/anon mantiverem qualquer coisa alem de SELECT,
  -- o TRUNCATE (que ignora RLS) continua aberto.
  IF has_table_privilege('authenticated','public.product_costs','TRUNCATE') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated ainda tem TRUNCATE (nao passa por RLS)';
  END IF;
  IF has_table_privilege('authenticated','public.product_costs','INSERT')
     OR has_table_privilege('authenticated','public.product_costs','UPDATE')
     OR has_table_privilege('authenticated','public.product_costs','DELETE') THEN
    RAISE EXCEPTION 'A4 FALHOU: authenticated ainda tem escrita em product_costs';
  END IF;
  IF has_table_privilege('anon','public.product_costs','SELECT')
     OR has_table_privilege('anon','public.product_costs','TRUNCATE') THEN
    RAISE EXCEPTION 'A5 FALHOU: anon ainda tem privilegio em product_costs';
  END IF;
  IF NOT has_table_privilege('authenticated','public.product_costs','SELECT') THEN
    RAISE EXCEPTION 'A6 FALHOU: authenticated perdeu SELECT — a policy nunca seria exercida e o gate viraria tautologia';
  END IF;

  -- o writer nao pode ter sido atingido
  IF NOT has_table_privilege('service_role','public.product_costs','INSERT') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role perdeu INSERT — o sync de custo (sync-reprocess/omie-analytics-sync) quebraria';
  END IF;

  RAISE NOTICE 'FU4-F fase 3: product_costs fechada (1 policy, SELECT-only p/ authenticated, anon zerado)';
END
$post$;

COMMIT;

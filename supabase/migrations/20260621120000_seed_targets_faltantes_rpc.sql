-- ============================================================================
-- seed_targets_faltantes() — alvos do auto-seed de farmer_client_scores, filtrados ATOMICAMENTE.
-- Money-path · anti-ressurreição (SEED). Fecha o furo ORTOGONAL ao #971 (que cobriu só o RECOMPUTE).
--
-- PROBLEMA (exposto por smoke 2026-06-20): o SEED do edge calculate-scores (=`n`) descobria os clientes
-- faltantes com TRÊS leituras PostgREST SEPARADAS — omie_clientes, farmer_client_scores e
-- cliente_classificacao (flaggeds, via .eq('excluir_da_carteira', true)) — e combinava em memória
-- (computeSeedTargets). Como são snapshots SEPARADOS, qualquer inconsistência entre eles (leitura de
-- flaggeds vazia/incompleta — quirk do PostgREST .eq, lag de réplica, ou janela de visibilidade) fazia
-- `missing = missingRaw − flaggeds` cair para `missingRaw` INTEIRO → o seed RE-INSERIA os fornecedores
-- excluídos (excluir_da_carteira=true) que o cleanup aplicar_exclusao_fornecedores() acabara de deletar.
-- É FAIL-OPEN (na dúvida, semeia) — o oposto do money-path (precisão > recall). Medido: o smoke semeou
-- EXATAMENTE os 509 fornecedores flagged (fcs 6400→6909, todos com excluir_da_carteira=true, 1:1). O
-- #971 só blindou o RECOMPUTE (apply_score_updates UPDATE-only); o SEED é a ÚNICA outra via de INSERT
-- em farmer_client_scores e ficou descoberta.
--
-- FIX (snapshot único, fail-closed): a descoberta vira UMA query atômica — omie_clientes que NÃO têm
-- linha em farmer_client_scores E NÃO estão flagged em cliente_classificacao. As 3 tabelas são lidas no
-- MESMO snapshot, então NUNCA ocorre a inconsistência "fcs sem o cliente + flaggeds sem o flag" que
-- causava a ressurreição. Por construção a RPC só retorna quem é SEGURO semear: se erra, erra para
-- MENOS (não semeia), JAMAIS ressuscita. O edge chama a RPC no lugar das 3 leituras + filtro em memória;
-- erro de RPC → o edge LANÇA (fail-closed — não semeia às cegas; idempotente, o próximo run converge).
--
-- DEDUP: omie_clientes tem 1 linha por (user_id, empresa_omie) → user_id repete p/ cliente presente em
-- +1 empresa. DISTINCT garante 1 alvo por cliente (espelha o dedup do computeSeedTargets). ORDER BY
-- user_id dá paginação ESTÁVEL no edge (.range()), sem pular/duplicar entre páginas (§5 do CLAUDE.md:
-- .range() exige .order estável).
--
-- SEGURANÇA: chamada SÓ pelo edge via service_role. SECURITY INVOKER (menor privilégio — se um dia
-- vazar grant a authenticated, a RLS das tabelas-fonte ainda limita; DEFINER seria leitura irrestrita)
-- + REVOKE de PUBLIC/anon/authenticated + GRANT EXECUTE só a service_role (espelha apply_score_updates).
--
-- Provada em PG17 local com falsificação: db/test-seed-targets-faltantes.sh.
-- Função NOVA (não recria objeto de prod → sem drift repo×prod).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT DISTINCT oc.user_id
  FROM public.omie_clientes oc
  WHERE oc.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.farmer_client_scores f
      WHERE f.customer_user_id = oc.user_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.cliente_classificacao cc
      WHERE cc.user_id = oc.user_id AND cc.excluir_da_carteira
    )
  ORDER BY oc.user_id
$$;

REVOKE ALL    ON FUNCTION public.seed_targets_faltantes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_targets_faltantes() TO service_role;

-- ============================================================
-- Validação (cole no SQL Editor; confira: existe=1, exec_service=t, exec_auth=f, exec_anon=f)
-- ============================================================
SELECT 'seed_targets_faltantes OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname = 'seed_targets_faltantes')                AS existe,
  has_function_privilege('service_role',  'public.seed_targets_faltantes()', 'EXECUTE')  AS exec_service,
  has_function_privilege('authenticated', 'public.seed_targets_faltantes()', 'EXECUTE')  AS exec_auth,
  has_function_privilege('anon',          'public.seed_targets_faltantes()', 'EXECUTE')  AS exec_anon;

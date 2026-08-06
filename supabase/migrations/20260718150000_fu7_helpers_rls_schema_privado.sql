-- FU7 — hardening de SECURITY DEFINER: fechar os oráculos de RLS expostos via PostgREST
-- Spec: docs/superpowers/specs/2026-07-17-carteira-rls-eligible-visibilidade-design.md §8-FU7
-- Prova: db/test-fu7-helpers-schema-privado.sh (PG17, com falsificação)
--
-- CONTEXTO (medido em prod via psql-ro 2026-07-18):
--   Helper SECDEF em schema EXPOSTO + EXECUTE p/ authenticated + parâmetro arbitrário = ORÁCULO.
--   Qualquer autenticado chama via POST /rest/v1/rpc/<f> e pergunta o que a RLS deveria proteger.
--
-- POR QUE DUAS TÉCNICAS DIFERENTES (provado em db/test-secdef-searchpath-oraculo.sh):
--   Uma policy RLS que chama um helper EXIGE o EXECUTE do CALLER — revogar dá 42501 e derruba
--   a policy junto. Logo:
--     · helper SEM policy  → REVOKE resolve (Fatia 0)
--     · helper COM policy  → REVOKE é proibido; move-se de SCHEMA, mantendo o EXECUTE (Fatia 1).
--   `ALTER FUNCTION ... SET SCHEMA` preserva o OID, e policies/views guardam árvore parseada
--   ligada ao OID → continuam funcionando sem reescrita. O ganho é que o PostgREST só publica
--   RPC do schema exposto: fora de `public`, o oráculo HTTP fecha e a RLS segue intacta.
--
-- ⚠️ Idempotente: os guards `to_regprocedure(...) IS NOT NULL` fazem o re-run ser no-op
--    (REVOKE em objeto inexistente ABORTA a migration inteira — ela é atômica).

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- FATIA 0 — oráculos de identidade SEM nenhuma dependência: REVOKE puro
--   get_user_role(uuid)       → devolve app_role de QUALQUER uuid (0 policies, 0 callers)
--   get_commercial_role(uuid) → devolve commercial_role (0 policies; único caller é
--                               pode_ver_carteira_completa, que é SECDEF → roda como postgres
--                               e NÃO depende do grant de authenticated)
--   `REVOKE FROM PUBLIC` não tira anon/authenticated no Supabase (grant explícito por default
--   privilege) → revogar POR NOME. service_role tem grant explícito e é preservado de propósito.
-- ════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regprocedure('public.get_user_role(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM authenticated, anon, PUBLIC;
  END IF;
  IF to_regprocedure('public.get_commercial_role(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.get_commercial_role(uuid) FROM authenticated, anon, PUBLIC;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- FATIA 1 — helpers COM policies: mover p/ schema não exposto ao PostgREST
--   carteira_visivel_para → 8 policies + 1 view (v_cliente_interacoes) + 1 função
--   is_super_admin        → 2 policies
--   O EXECUTE de authenticated é MANTIDO (as policies precisam dele — 42501 sem ele).
-- ════════════════════════════════════════════════════════════════════════════
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.carteira_visivel_para(uuid,uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.carteira_visivel_para(uuid, uuid) SET SCHEMA private;
  END IF;
  IF to_regprocedure('public.is_super_admin(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.is_super_admin(uuid) SET SCHEMA private;
  END IF;
END $$;

-- O único caller de resolução TARDIA (corpo em string + search_path=public) que chamava
-- `carteira_visivel_para` sem qualificar. Policies/views resolvem por OID e não precisam disto;
-- este precisa, senão quebra com 42883 ao EXECUTAR (late-bound — não falha no CREATE).
DO $$
BEGIN
  IF to_regprocedure('public.melhoria_clientes_por_produto(text)') IS NOT NULL THEN
    ALTER FUNCTION public.melhoria_clientes_por_produto(text) SET search_path TO 'public', 'private';
  END IF;
END $$;

COMMIT;

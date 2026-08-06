-- Identidade Omie por snapshot atômico server-side — PR-1 (achado A1)
-- Follow-up estrutural do #1288. Fecha a corrida de paginação não-atômica: em vez de os edges
-- omie-vendas-sync / omie-analytics-sync paginarem `profiles` (leitura multi-página onde um profile
-- que nasce/muda entre páginas escapa da detecção de doc-ambíguo), a identidade doc→user é resolvida
-- num ÚNICO snapshot MVCC. `LANGUAGE sql STABLE` garante que todas as sub-consultas usam o snapshot
-- da query chamadora; `BEGIN ATOMIC` é analisado no CREATE (pega 42P01/42703 já no deploy, não em
-- runtime como plpgsql late-bound). Prova positiva de doc: só docs com count(distinct user_id)=1
-- entram em doc_to_user; docs com 2+ users vão para ambiguous_docs (fail-closed, precisão>recall).
--
-- p_account é RESERVADO (não usado no PR-1) para o PR-2 preencher client_to_user por conta sem
-- mudar a assinatura (CREATE OR REPLACE puro, sem DROP). client_to_user fica '{}' até lá.
--
-- Segurança: SECURITY INVOKER (o edge é service_role e já lê profiles; DEFINER só aumentaria
-- privilégio) + search_path travado + REVOKE de PUBLIC/anon/authenticated (é PII: documento + user_id).
-- Só service_role executa.

CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document, '\D', '', 'g') AS doc, p.user_id
    FROM public.profiles p
    WHERE p.document IS NOT NULL
      AND length(regexp_replace(p.document, '\D', '', 'g')) >= 11
  ),
  doc_agg AS (
    SELECT doc,
           count(DISTINCT user_id) AS n_users,
           min(user_id::text)      AS user_id   -- único quando n_users = 1
    FROM doc_valid
    GROUP BY doc
  )
  SELECT jsonb_build_object(
    'doc_to_user',
      coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs',
      coalesce((SELECT jsonb_agg(doc ORDER BY doc)   FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user', '{}'::jsonb   -- PR-2: prova positiva por (account=p_account, evidence_document)
  );
END;

REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;

COMMENT ON FUNCTION public.omie_sync_identity_snapshot(text) IS
  'PR-1/A1: identidade doc→user num snapshot atômico (sql STABLE). Retorna {doc_to_user, ambiguous_docs, client_to_user}. doc ambíguo (2+ users) fica FORA de doc_to_user (fail-closed). client_to_user preenchido no PR-2. Só service_role executa.';

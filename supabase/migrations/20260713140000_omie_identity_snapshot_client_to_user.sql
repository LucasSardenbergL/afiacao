-- Identidade Omie por snapshot atômico — PR-2 (achado A2): prova positiva codigo→user
-- Follow-up estrutural do #1288, CONSECUTIVO ao PR-1 (20260711140000). Fecha o cache-first bypass do
-- syncPedidos: o clientCache (codigo_cliente→user) vinha da view fresca omie_customer_account_map_fresco
-- (TTL 7d) e era consultado ANTES do docToUserMap → um hit STALE retornava sem o fail-closed. Pior: a
-- proof-table NÃO registrava o DOCUMENTO da prova → filtrar "sem doc ambíguo" era AUSÊNCIA DE
-- CONTRAINDICAÇÃO (fail-open sutil, Codex xhigh 2026-07-11). Correção: prova POSITIVA no MESMO snapshot.
--
-- (1) Coluna evidence_document_normalized: provenance do vínculo document-first (o doc normalizado que
--     casou). Backfill = POLÍTICA fail-closed: linha antiga fica NULL → NÃO entra em client_to_user →
--     cai no fallback doc_to_user (prova positiva) durante a transição; o writer reescreve no próximo run
--     (~1 dia). Degrada para o status-quo, nunca fabrica dono. (design §4.2)
-- (2) client_to_user preenchido (era '{}' no PR-1): CREATE OR REPLACE PURO, MESMA assinatura (text), sem
--     DROP. Um vínculo (código→user) só entra com a conjunção POSITIVA: account=p_account E source=document
--     E evidence NOT NULL E o doc de evidência é ÚNICO (∈ doc_to_user via doc_agg.n_users=1) E ainda aponta
--     pro MESMO user do vínculo (da.user_id = m.user_id) E frescor 7d. Fecha o cenário A2 (vínculo cujo doc
--     migrou p/ outro user, ou virou ambíguo, ou o profile perdeu o doc). v1 só source='document' (§6).
--
-- ⚠️ ORDEM: ALTER ADD COLUMN ANTES do CREATE — o corpo BEGIN ATOMIC é analisado no CREATE (referencia a
-- coluna); sem ela dá 42703 já no deploy. Segurança inalterada do PR-1: SECURITY INVOKER + search_path
-- travado + REVOKE PUBLIC/anon/authenticated (é PII: documento + user_id). Só service_role executa.

ALTER TABLE public.omie_customer_account_map
  ADD COLUMN IF NOT EXISTS evidence_document_normalized text;

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
  ),
  -- PR-2: prova POSITIVA código→user. JOIN com a MESMA doc_agg (n_users=1) que alimenta doc_to_user, no
  -- MESMO snapshot MVCC. A evidência tem de continuar apontando pro user do vínculo: da.user_id = m.user_id.
  client_valid AS (
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m
    JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized
     AND da.n_users = 1
     AND da.user_id = m.user_id::text
    WHERE m.account = p_account
      AND m.source = 'document'
      AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'doc_to_user',
      coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs',
      coalesce((SELECT jsonb_agg(doc ORDER BY doc)   FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user',
      coalesce((SELECT jsonb_object_agg(codigo, user_id) FROM client_valid), '{}'::jsonb)
  );
END;

REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;

COMMENT ON FUNCTION public.omie_sync_identity_snapshot(text) IS
  'PR-1/A1 + PR-2/A2: identidade doc→user e codigo→user num snapshot atômico (sql STABLE). client_to_user = prova positiva por conta (source=document + evidence viva/única/consistente + frescor 7d); doc ambíguo (2+ users) fica FORA de doc_to_user e de client_to_user (fail-closed). Só service_role executa.';

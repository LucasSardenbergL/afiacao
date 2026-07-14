-- Identidade Omie por snapshot atômico — PR-2 (achado A2), CORREÇÃO pós-Codex xhigh (2026-07-12, P1-b).
-- Consecutiva à 20260713140000 (já committada quando o challenge rodou → correção = migration NOVA, não edição
-- do .sql imutável). NÃO re-adiciona a coluna (o ALTER da 140000 já a criou); só recria a função.
--
-- REGRESSÃO fechada: a 140000 preencheu client_to_user SÓ com source='document'. Mas a view fresca ANTIGA
-- (omie_customer_account_map_fresco) que alimentava o clientCache do syncPedidos incluía TODOS os source —
-- inclusive 'manual' (override HUMANO). Ao trocar a fonte do cache para client_to_user (só document), o PR-2
-- passava a PERDER o override: o código com vínculo manual saía do cache → MISS → fallback ConsultarCliente →
-- o documento do cadastro Omie podia apontar pra OUTRO user → pedido atribuído ao user ERRADO, contrariando a
-- decisão humana. (Codex: "definir semântica fail-closed para source='manual'".)
--
-- CORREÇÃO: client_to_user ganha um 2º ramo (UNION) para source='manual' como AUTORIDADE DURÁVEL — o vínculo
-- (codigo→user) É a prova, independe do documento E do TTL. SEM frescor de propósito: o writer
-- (omie-analytics-sync) NUNCA reescreve linhas manual (só refresca 'document'; o DELETE de ambíguo as
-- preserva) → aplicar 7d MATARIA todo override em ~7d. uq_ocam_codigo_account (1 linha por codigo,account)
-- garante que os ramos document/manual JAMAIS colidem no jsonb_object_agg. Fail-closed: humano errou → humano
-- edita/remove a linha. v1 segue excluindo source='code' (espelho poluído cross-account, design §6).
--
-- CREATE OR REPLACE PURO, MESMA assinatura (text) — sem DROP. Segurança inalterada: SECURITY INVOKER +
-- search_path travado + REVOKE PUBLIC/anon/authenticated (PII: documento + user_id). Só service_role executa.
-- ⚠️ Deploy: aplicar DEPOIS da 20260713140000 (esta é a última a recriar → vence). Idempotente.

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
  -- PR-2: prova POSITIVA código→user. Dois ramos disjuntos por source (uq_ocam_codigo_account garante 1
  -- linha por (codigo,account) → jamais colidem no jsonb_object_agg):
  --
  -- (a) DOCUMENT — prova positiva por documento. JOIN com a MESMA doc_agg (n_users=1) que alimenta
  --     doc_to_user, no MESMO snapshot MVCC. A evidência tem de continuar apontando pro user do vínculo
  --     (da.user_id = m.user_id) E o doc ser único E fresco (7d). O writer refresca 'document' ~1x/dia →
  --     o TTL só pega o cliente que SUMIU do Omie (parou de ser refrescado).
  --
  -- (b) MANUAL — override HUMANO é autoridade DURÁVEL: o vínculo É a prova, independe do documento E do TTL
  --     (writer nunca reescreve manual → 7d o mataria). Sem este ramo o PR-2 regrediria vs a view fresca.
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
    UNION
    SELECT m.omie_codigo_cliente::text AS codigo, m.user_id::text AS user_id
    FROM public.omie_customer_account_map m
    WHERE m.account = p_account
      AND m.source = 'manual'
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
  'PR-1/A1 + PR-2/A2: identidade doc→user e codigo→user num snapshot atômico (sql STABLE). client_to_user = prova positiva: (a) source=document com evidence viva/única/consistente + frescor 7d; (b) source=manual como autoridade humana durável (sem TTL). code e doc ambíguo ficam FORA (fail-closed). Só service_role executa.';

-- Identidade Omie por snapshot atômico server-side — PR-2 (achado A2): PROVA POSITIVA client_to_user
-- Design: docs/superpowers/specs/2026-07-11-omie-identidade-snapshot-atomico-design.md §4.2/§6.
--
-- O QUE FECHA. O omie-vendas-sync monta o clientCache (codigo Omie → user_id) a partir da view
-- omie_customer_account_map_fresco (TTL 7d) e resolve o DONO do pedido por ele. Isso é vínculo por
-- AUSÊNCIA DE CONTRAINDICAÇÃO — fail-open sutil: a proof-table não registrava QUAL documento provou o
-- vínculo, então um C→u1 criado com o doc X sobrevive depois de u1 migrar para Y e u2 receber X. Sem a
-- evidência, "não há contraindicação" era indistinguível de "há prova". Agora há prova: a coluna
-- evidence_document_normalized guarda o doc que casou, e client_to_user só devolve o vínculo cuja
-- evidência ainda é ÚNICA (∈ doc_to_user) e CONSISTENTE (aponta para o MESMO user do vínculo), no MESMO
-- snapshot MVCC de doc_to_user/ambiguous_docs.
--
-- NASCE INERTE (medido em 2026-08-21 via psql-ro): a tabela tem 16.118 linhas (source document=16.097,
-- rpc=21) e TODAS nascem com evidence NULL — o backfill é justamente NÃO backfillar (NULL = sem prova,
-- fail-closed). Logo client_to_user volta VAZIO até o omie-analytics-sync/syncCustomers repovoar, e o
-- leitor degrada para o comportamento de hoje. Não é flip: é cobertura crescente, medível antes/depois.

-- ── 1. Provenance da prova ────────────────────────────────────────────────────────────────────────
ALTER TABLE public.omie_customer_account_map
  ADD COLUMN IF NOT EXISTS evidence_document_normalized text;

-- O writer normaliza com replace(/\D/g,'') e só grava o doc que veio de doc_to_user (que já filtra
-- length>=11). O CHECK existe para que um writer que passe a gravar o doc FORMATADO ("12.345.678/0001-90")
-- falhe ALTO em vez de silenciosamente nunca casar o JOIN abaixo — a falha inerte é o risco real aqui.
-- NULL segue permitido: é exatamente o "sem prova" das linhas antigas.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.omie_customer_account_map'::regclass
      AND conname  = 'ocam_evidence_document_normalizado_chk'
  ) THEN
    ALTER TABLE public.omie_customer_account_map
      ADD CONSTRAINT ocam_evidence_document_normalizado_chk
      CHECK (evidence_document_normalized IS NULL OR evidence_document_normalized ~ '^[0-9]{11,}$');
  END IF;
END $$;

COMMENT ON COLUMN public.omie_customer_account_map.evidence_document_normalized IS
  'PR-2/A2: documento normalizado (só dígitos) que PROVOU este vínculo no casamento document-first do omie-analytics-sync/syncCustomers. NULL = sem prova (linhas anteriores ao PR-2, ou fontes rpc/manual) → NÃO entra em client_to_user do omie_sync_identity_snapshot. Fail-closed por construção.';

-- ── 2. RPC: client_to_user deixa de ser placeholder ───────────────────────────────────────────────
-- CREATE OR REPLACE (não DROP+CREATE): preserva o ACL e a assinatura reservada pelo PR-1. doc_valid /
-- doc_agg são IDÊNTICOS aos do PR-1 — o mesmo snapshot MVCC serve as três chaves, que é o ponto do
-- design (client_to_user validado contra o doc_to_user do MESMO instante, não de outra leitura).
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
  -- Prova positiva por conta. As 5 exigências do design §4.2/§6, nesta ordem:
  --   (a) account = p_account          → o código Omie é numerado POR CONTA; sem isto o mesmo número de
  --                                      outra conta traria o user errado (bug #4 do design).
  --   (b) source = 'document'          → v1 só documento. 'rpc'/'manual' não provam identidade por doc.
  --   (c) evidence IS NOT NULL         → sem evidência não há prova (o JOIN abaixo já o garante; o
  --                                      predicado fica explícito porque é a regra, não um efeito).
  --   (d) evidência ÚNICA              → JOIN com doc_agg WHERE n_users = 1 (doc ambíguo NÃO prova nada:
  --                                      o design §6 manda MATAR o vínculo histórico, não preservá-lo).
  --   (e) evidência CONSISTENTE        → o dono atual daquele doc é o MESMO user do vínculo. É esta linha
  --                                      que expira o vínculo quando o doc migra de dono. Como doc_agg
  --                                      nasce de profiles, (d)+(e) já implicam "o profile ainda carrega
  --                                      esse doc" — a 6ª exigência do design é redundante, não omitida.
  -- E o TTL de 7d espelha a view omie_customer_account_map_fresco, que é o que este mapa sobrepõe no
  -- leitor: fora da janela da view a prova não teria nada a corrigir.
  client_prova AS (
    SELECT m.omie_codigo_cliente::text AS codigo, d.user_id
    FROM public.omie_customer_account_map m
    JOIN doc_agg d
      ON d.doc     = m.evidence_document_normalized
     AND d.n_users = 1
     AND d.user_id = m.user_id::text
    WHERE m.account = p_account
      AND m.source  = 'document'
      AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days'
  )
  SELECT jsonb_build_object(
    'doc_to_user',
      coalesce((SELECT jsonb_object_agg(doc, user_id) FROM doc_agg WHERE n_users = 1), '{}'::jsonb),
    'ambiguous_docs',
      coalesce((SELECT jsonb_agg(doc ORDER BY doc)   FROM doc_agg WHERE n_users > 1), '[]'::jsonb),
    'client_to_user',
      coalesce((SELECT jsonb_object_agg(codigo, user_id) FROM client_prova), '{}'::jsonb)
  );
END;

-- CREATE OR REPLACE preserva o ACL, mas reemitir é idempotente e barato — e o custo de um ACL resetado
-- aqui é PII (documento + user_id) exposta a anon/authenticated. Nomeando as roles: REVOKE FROM PUBLIC
-- não tira grant explícito de anon/authenticated (CLAUDE.md).
REVOKE EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.omie_sync_identity_snapshot(text) TO service_role;

COMMENT ON FUNCTION public.omie_sync_identity_snapshot(text) IS
  'PR-1/A1 + PR-2/A2: identidade num snapshot atômico (sql STABLE). {doc_to_user, ambiguous_docs, client_to_user}. doc ambíguo (2+ users) fica FORA de doc_to_user. client_to_user = prova positiva codigo_omie→user por conta: source=document + evidence_document_normalized única (n_users=1) e consistente (mesmo user do vínculo) + TTL 7d. Só service_role executa.';

-- PostgREST cacheia o schema: sem isto a 1ª chamada pós-apply pode devolver PGRST202.
NOTIFY pgrst, 'reload schema';

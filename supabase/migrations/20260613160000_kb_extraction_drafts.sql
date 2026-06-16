-- Migration: kb_extraction_drafts
-- Persiste o resultado da extração de boletins técnicos (kb-extract-specs) para evitar
-- re-invocar Claude quando o founder fecha/reabre a aba durante a curadoria dos 297 boletins.
-- Cache-first: se draft status='ready' e não force → retorna o jsonb gravado, custo zero.
-- Claim atômico via ON CONFLICT ... DO UPDATE ... WHERE (não expressível via PostgREST .upsert()).
-- RPC é INVOKER + REVOKE → só service_role (a edge) consegue chamar; autenticados leem via RLS.

CREATE TABLE IF NOT EXISTS public.kb_extraction_drafts (
  document_id   uuid        PRIMARY KEY REFERENCES public.kb_documents(id) ON DELETE CASCADE,
  status        text        NOT NULL DEFAULT 'extracting'
                              CHECK (status IN ('extracting', 'ready', 'failed')),
  spec          jsonb,
  claim_token   uuid,
  started_at    timestamptz,
  extracted_at  timestamptz,
  last_error    text,
  model         text,
  usage         jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_kb_extraction_drafts_updated_at ON public.kb_extraction_drafts;
CREATE TRIGGER trg_kb_extraction_drafts_updated_at
  BEFORE UPDATE ON public.kb_extraction_drafts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.kb_extraction_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kb_extraction_drafts_select_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_select_master ON public.kb_extraction_drafts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::app_role));

DROP POLICY IF EXISTS kb_extraction_drafts_delete_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_delete_master ON public.kb_extraction_drafts
  FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'master'::app_role));

REVOKE ALL ON public.kb_extraction_drafts FROM anon;

-- RPC de claim atômico.
-- Semântica: garante que SÓ UM worker (a edge invocada com o p_claim_token gerado pelo front)
-- "dono" a extração. Retorna TRUE se este caller é o dono após o upsert.
-- Condição de claim/re-claim: status <> 'extracting' OU started_at velho (>5 min = travado/morto).
-- INVOKER (não DEFINER) + REVOKE FROM anon/authenticated/public:
--   - só service_role (a edge) executa; autenticados usam a RLS de SELECT acima.
CREATE OR REPLACE FUNCTION public.kb_extraction_draft_claim(
  p_document_id uuid,
  p_claim_token uuid
) RETURNS boolean
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_claimed uuid;
BEGIN
  INSERT INTO public.kb_extraction_drafts (document_id, status, claim_token, started_at, updated_at)
  VALUES (p_document_id, 'extracting', p_claim_token, now(), now())
  ON CONFLICT (document_id) DO UPDATE
    SET status      = 'extracting',
        claim_token = p_claim_token,
        started_at  = now(),
        last_error  = NULL,
        updated_at  = now()
    WHERE kb_extraction_drafts.status <> 'extracting'
       OR kb_extraction_drafts.started_at < now() - interval '5 minutes'
  RETURNING claim_token INTO v_claimed;

  RETURN v_claimed IS NOT DISTINCT FROM p_claim_token;
END;
$$;

REVOKE ALL ON FUNCTION public.kb_extraction_draft_claim(uuid, uuid) FROM anon, authenticated, public;

-- Validação inline (retorna na saída do apply manual no SQL Editor).
SELECT
  'kb_extraction_drafts OK'                                                       AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename = 'kb_extraction_drafts')     AS policies,
  (SELECT count(*) FROM pg_proc     WHERE proname   = 'kb_extraction_draft_claim') AS rpc;

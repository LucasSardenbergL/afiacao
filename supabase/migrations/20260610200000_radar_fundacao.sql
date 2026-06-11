-- =============================================================================
-- RADAR DE CLIENTES — FUNDAÇÃO (fatia 1)
-- Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- =============================================================================

-- 1) Universo prospectável -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_empresas (
  cnpj                      text PRIMARY KEY CHECK (cnpj ~ '^[0-9]{14}$'),
  razao_social              text,
  nome_fantasia             text,
  cnae_principal            text NOT NULL CHECK (cnae_principal ~ '^[0-9]{7}$'),
  cnae_descricao            text,
  cnaes_secundarios         text[] NOT NULL DEFAULT '{}',
  data_abertura             date,
  porte                     text,            -- '00'|'01'|'03'|'05' (RFB)
  capital_social            numeric,
  logradouro                text,
  numero                    text,
  complemento               text,
  bairro                    text,
  municipio_codigo          text,            -- código TOM (convenção RFB, ≠ IBGE)
  municipio_nome            text,
  uf                        text,
  cep                       text,
  telefone1                 text,
  telefone2                 text,
  email                     text,
  socios_nomes              text,
  -- operacionais
  primeira_vista_em         timestamptz NOT NULL DEFAULT now(),  -- só no INSERT
  ultimo_lote               text NOT NULL CHECK (ultimo_lote ~ '^[0-9]{4}-[0-9]{2}$'),  -- 'YYYY-MM'; ≠ lote vigente ⇒ saiu do dump
  ja_cliente                boolean NOT NULL DEFAULT false,
  prospeccao_status         text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN
      ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em  timestamptz,
  descarte_motivo           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_radar_empresas_fila
  ON public.radar_empresas (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX IF NOT EXISTS idx_radar_empresas_local
  ON public.radar_empresas (uf, municipio_nome);
CREATE INDEX IF NOT EXISTS idx_radar_empresas_cnae
  ON public.radar_empresas (cnae_principal);

-- 2) Histórico de prospecção (append-only; RPCs de escrita chegam na fatia 2) --
CREATE TABLE IF NOT EXISTS public.radar_contatos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj        text NOT NULL REFERENCES public.radar_empresas(cnpj) ON DELETE CASCADE,
  acao        text NOT NULL CHECK (acao IN
    ('contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar')),
  nota        text,
  criado_por  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_contatos_cnpj ON public.radar_contatos (cnpj, created_at DESC);

-- 3) Municípios (mapa agregado; carregado pelo pipeline, chunk 'municipios') ---
CREATE TABLE IF NOT EXISTS public.radar_municipios (
  codigo  text PRIMARY KEY,   -- código TOM (RFB)
  nome    text NOT NULL,
  uf      text NOT NULL,
  lat     double precision,
  lng     double precision
);

-- 4) Estado da ingestão (padrão omie_nao_vinculados_state) ---------------------
CREATE TABLE IF NOT EXISTS public.radar_ingest_state (
  mes_referencia  text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),  -- 'YYYY-MM'
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','error')),
  total_recebido  integer NOT NULL DEFAULT 0,
  novos           integer,
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  finalizado_em   timestamptz,
  erro            text
);

-- 5) RLS: leitura = gestor/master (pode_ver_carteira_completa, helper já em prod);
--    escrita = service_role (mutação humana virá por RPC na fatia 2) -----------
ALTER TABLE public.radar_empresas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_contatos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_municipios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_ingest_state  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "radar_empresas_select_gestor" ON public.radar_empresas;
CREATE POLICY "radar_empresas_select_gestor" ON public.radar_empresas
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_contatos_select_gestor" ON public.radar_contatos;
CREATE POLICY "radar_contatos_select_gestor" ON public.radar_contatos
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_municipios_select_gestor" ON public.radar_municipios;
CREATE POLICY "radar_municipios_select_gestor" ON public.radar_municipios
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_ingest_state_select_gestor" ON public.radar_ingest_state;
CREATE POLICY "radar_ingest_state_select_gestor" ON public.radar_ingest_state
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));
-- (sem policies de INSERT/UPDATE/DELETE para authenticated: service_role bypassa RLS)

-- 6) Recruza "já é cliente": profiles.document ∪ omie_clientes_nao_vinculados.cnpj_cpf
--    (⚠️ omie_clientes NÃO tem documento — só códigos). Chamada pela edge no finalize.
CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marcados integer;
BEGIN
  DROP TABLE IF EXISTS tmp_docs_clientes;
  CREATE TEMP TABLE tmp_docs_clientes ON COMMIT DROP AS
    SELECT DISTINCT regexp_replace(document, '[^0-9]', '', 'g') AS doc
    FROM public.profiles
    WHERE document IS NOT NULL
      AND length(regexp_replace(document, '[^0-9]', '', 'g')) = 14
    UNION
    SELECT DISTINCT regexp_replace(cnpj_cpf, '[^0-9]', '', 'g') AS doc
    FROM public.omie_clientes_nao_vinculados
    WHERE cnpj_cpf IS NOT NULL
      AND length(regexp_replace(cnpj_cpf, '[^0-9]', '', 'g')) = 14;

  UPDATE public.radar_empresas re
  SET ja_cliente = true, updated_at = now()
  WHERE re.ja_cliente = false
    AND EXISTS (SELECT 1 FROM tmp_docs_clientes d WHERE d.doc = re.cnpj);

  GET DIAGNOSTICS v_marcados = ROW_COUNT;
  RETURN v_marcados;
END;
$$;

-- trava a função: só service_role (a edge chama com service client)
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;

-- 7) Validação pós-apply (colar junto; esperar: tabelas=4, policies=4, funcao=1)
SELECT 'RADAR FUNDACAO OK' AS status,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN
      ('radar_empresas','radar_contatos','radar_municipios','radar_ingest_state')) AS tabelas_4,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
    AND tablename LIKE 'radar_%') AS policies_4,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='radar_recruzar_ja_cliente') AS funcao_1;

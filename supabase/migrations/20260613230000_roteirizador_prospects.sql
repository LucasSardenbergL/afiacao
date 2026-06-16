-- =============================================================================
-- ROTEIRIZADOR DO HUNTER — prospects do Radar no mapa de visitas (sub-PR A: fundação SQL)
-- Spec: docs/superpowers/specs/2026-06-13-roteirizador-prospects-radar-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
--
-- Traz os prospects do Radar pra dentro do Roteirizador (/admin/route-planner):
-- numa cidade, ver carteira + prospects no mesmo mapa, montar rota e fazer check-in.
-- Este bloco é a FUNDAÇÃO DE DADOS (colunas de geo + 2 RPCs). O client (sub-PR B) e
-- o check-in (sub-PR C) vêm depois.
--
-- Gate de todas as RPCs: gestor/master via pode_ver_carteira_completa (mesmo gate da
-- RLS de SELECT de radar_empresas e das RPCs da Fatia 3). As RPCs são SECURITY
-- DEFINER → bypassam a RLS de radar_empresas; o IF do topo é a ÚNICA fronteira de
-- leitura/escrita, avaliado 1× (não por-linha — lição #792 / Fatia 3).
-- =============================================================================

-- 1) Cache de geocodificação por empresa (1 geocode por CNPJ, reaproveitado entre
--    sessões). O client geocodifica sob-demanda (Nominatim) e persiste aqui.
ALTER TABLE public.radar_empresas
  ADD COLUMN IF NOT EXISTS lat            double precision,
  ADD COLUMN IF NOT EXISTS lng            double precision,
  ADD COLUMN IF NOT EXISTS geocoded_em    timestamptz,
  ADD COLUMN IF NOT EXISTS geocode_status text;  -- 'ok' | 'falhou' | NULL (nunca tentado)

-- CHECK do status (idempotente; só os valores que o client grava).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.radar_empresas'::regclass
      AND conname = 'radar_empresas_geocode_status_chk'
  ) THEN
    ALTER TABLE public.radar_empresas
      ADD CONSTRAINT radar_empresas_geocode_status_chk
      CHECK (geocode_status IS NULL OR geocode_status IN ('ok','falhou'));
  END IF;
END $$;

-- 2) Persistir geocode de um prospect (chamada pelo client após o Nominatim).
--    p_status='ok' exige lat/lng válidos; 'falhou' grava sem coords (não re-tentar).
CREATE OR REPLACE FUNCTION public.radar_salvar_geocode(
  p_cnpj   text,
  p_lat    double precision DEFAULT NULL,
  p_lng    double precision DEFAULT NULL,
  p_status text DEFAULT 'ok'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;
  IF p_status IS NULL OR p_status NOT IN ('ok','falhou') THEN RAISE EXCEPTION 'status inválido'; END IF;

  IF p_status = 'ok' THEN
    IF p_lat IS NULL OR p_lng IS NULL
       OR p_lat < -90 OR p_lat > 90 OR p_lng < -180 OR p_lng > 180 THEN
      RAISE EXCEPTION 'lat/lng inválidos para status ok';
    END IF;
  END IF;

  UPDATE public.radar_empresas SET
    lat            = CASE WHEN p_status = 'ok' THEN p_lat ELSE NULL END,
    lng            = CASE WHEN p_status = 'ok' THEN p_lng ELSE NULL END,
    geocoded_em    = now(),
    geocode_status = p_status,
    updated_at     = now()
  WHERE cnpj = p_cnpj;

  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;
  RETURN jsonb_build_object('ok', true, 'status', p_status);
END $$;

-- 3) Prospects de uma cidade prontos pra rota (lista enxuta, top-N, com geo cacheado).
--    Por municipio_codigo (TOM/RFB) — a mesma chave que radar_contagem_por_municipio
--    devolve pro seletor de cidade. Exclui já-clientes, descartados e quem já virou
--    cliente; a_contatar primeiro (o que ainda não foi tocado tem prioridade).
CREATE OR REPLACE FUNCTION public.radar_prospects_para_rota(
  p_municipio_codigo text,
  p_limit            integer DEFAULT 30
) RETURNS TABLE(
  cnpj text, razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text,
  prospeccao_status text,
  lat double precision, lng double precision, geocode_status text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_municipio_codigo IS NULL OR btrim(p_municipio_codigo) = '' THEN
    RAISE EXCEPTION 'municipio_codigo obrigatório';
  END IF;

  RETURN QUERY
  SELECT re.cnpj, re.razao_social, re.nome_fantasia,
         re.logradouro, re.numero, re.complemento, re.bairro,
         re.municipio_nome, re.uf, re.cep,
         re.telefone1, re.telefone2,
         re.prospeccao_status,
         re.lat, re.lng, re.geocode_status
    FROM public.radar_empresas re
   WHERE re.municipio_codigo = p_municipio_codigo
     AND re.ja_cliente = false
     AND re.prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa')
   ORDER BY (re.prospeccao_status = 'a_contatar') DESC,
            re.data_abertura DESC NULLS LAST,
            re.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 200));
END $$;

-- 4) Travas: só authenticated invoca; o gate interno confere gestor/master.
REVOKE ALL ON FUNCTION public.radar_salvar_geocode(text,double precision,double precision,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.radar_prospects_para_rota(text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_salvar_geocode(text,double precision,double precision,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.radar_prospects_para_rota(text,integer) TO authenticated;

-- 5) Validação pós-apply (colar junto; esperar colunas_4=4, funcoes_2=2, check_1=1)
SELECT 'ROTEIRIZADOR PROSPECTS A OK' AS status,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='radar_empresas'
      AND column_name IN ('lat','lng','geocoded_em','geocode_status')) AS colunas_4,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('radar_salvar_geocode','radar_prospects_para_rota')) AS funcoes_2,
  (SELECT count(*) FROM pg_constraint
    WHERE conrelid='public.radar_empresas'::regclass
      AND conname='radar_empresas_geocode_status_chk') AS check_1;

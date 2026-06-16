-- =============================================================================
-- REDESIGN "VISITAS EM CAMPO" — Sub-PR 1 (banco): carteira por município
-- normalizada (+ recência) e teto dos prospects 200→2000.
-- Spec: docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- Gate de ambas as RPCs: gestor/master via pode_ver_carteira_completa, avaliado
-- 1× no topo (não por-linha — lição #792). SECURITY DEFINER bypassa RLS.
-- =============================================================================

-- 1) Normalização de cidade: lower + trim + remove acentos PT por translate
--    (IMMUTABLE, sem depender da extensão unaccent). Os dois lados do cruzamento
--    (addresses.city texto-livre e radar_empresas.municipio_nome RFB) passam por aqui.
CREATE OR REPLACE FUNCTION public.norm_cidade(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(btrim(translate(
    COALESCE(t,''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ',
    'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'
  )));
$$;

-- 2) Carteira (clientes existentes) de um município, casada por nome normalizado +
--    UF, com a recência da última visita (route_visits.check_in_at de QUALQUER
--    vendedor = cobertura real do cliente). 1 endereço por cliente (is_default 1º).
CREATE OR REPLACE FUNCTION public.carteira_por_municipio(p_municipio_codigo text)
RETURNS TABLE(
  user_id uuid, name text, phone text,
  street text, number text, neighborhood text, city text, state text, zip_code text, complement text,
  business_hours_open text, business_hours_close text,
  ultima_visita timestamptz, dias_desde_visita integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_nome text;
  v_uf   text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_municipio_codigo IS NULL OR btrim(p_municipio_codigo) = '' THEN
    RAISE EXCEPTION 'municipio_codigo obrigatório';
  END IF;

  -- Resolve (nome, uf) RFB do código pela MESMA fonte dos prospects (radar_empresas,
  -- via índice em municipio_codigo). Município sem empresas no Radar → sem carteira.
  SELECT re.municipio_nome, re.uf INTO v_nome, v_uf
    FROM public.radar_empresas re
   WHERE re.municipio_codigo = p_municipio_codigo
   LIMIT 1;
  IF v_nome IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH alvo AS (
    SELECT a.user_id, a.street, a.number, a.neighborhood, a.city, a.state,
           a.zip_code, a.complement, a.is_default
      FROM public.addresses a
     WHERE public.norm_cidade(a.city) = public.norm_cidade(v_nome)
       AND upper(btrim(a.state)) = upper(btrim(v_uf))
  ),
  ende AS (
    SELECT DISTINCT ON (user_id)
           user_id, street, number, neighborhood, city, state, zip_code, complement
      FROM alvo
     ORDER BY user_id, is_default DESC NULLS LAST
  ),
  ult AS (
    SELECT rv.customer_user_id, max(rv.check_in_at) AS ultima
      FROM public.route_visits rv
     WHERE rv.customer_user_id IN (SELECT e.user_id FROM ende e)
       AND rv.check_in_at IS NOT NULL
     GROUP BY rv.customer_user_id
  )
  SELECT e.user_id, p.name, p.phone,
         e.street, e.number, e.neighborhood, e.city, e.state, e.zip_code, e.complement,
         p.business_hours_open, p.business_hours_close,
         u.ultima,
         CASE WHEN u.ultima IS NULL THEN NULL
              ELSE floor(extract(epoch FROM (now() - u.ultima)) / 86400)::int END
    FROM ende e
    JOIN public.profiles p ON p.user_id = e.user_id
    LEFT JOIN ult u ON u.customer_user_id = e.user_id
   WHERE COALESCE(p.is_employee, false) = false;
END $$;

-- 3) Teto dos prospects 200 → 2000 (mesmo corpo da 20260613230000, só o LIMIT muda).
--    ⚠️ Comparar a def VIVA de prod antes de aplicar (apply manual diverge).
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
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 2000));
END $$;

-- 4) Travas: só authenticated invoca; o gate interno confere gestor/master.
REVOKE ALL ON FUNCTION public.norm_cidade(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.norm_cidade(text) TO authenticated;
REVOKE ALL ON FUNCTION public.carteira_por_municipio(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.carteira_por_municipio(text) TO authenticated;
REVOKE ALL ON FUNCTION public.radar_prospects_para_rota(text,integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.radar_prospects_para_rota(text,integer) TO authenticated;

-- 5) Validação pós-apply (colar junto; esperar funcoes_3=3)
SELECT 'ROTEIRIZADOR CAMPO BANCO OK' AS status,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN
      ('norm_cidade','carteira_por_municipio','radar_prospects_para_rota')) AS funcoes_3;

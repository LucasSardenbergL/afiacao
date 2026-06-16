-- =============================================================================
-- Geocoding por CEP — fundação (Sub-PR 1, parte 1/3)
-- cep_geo (SoT de coordenada por CEP) + municipio_geo (centróides IBGE) +
-- normalizar_cep + RLS.
--
-- ⚠️ Apply MANUAL no SQL Editor do Lovable (migration custom NÃO auto-aplica —
-- falha silenciosa; merge na main ≠ produção). Nada funciona em prod até colar.
-- Spec:  docs/superpowers/specs/2026-06-15-geocoding-cep-escala-design.md
-- Prova: db/test-geocoding-cep.sh (PG17, executando — PL/pgSQL é late-bound).
-- =============================================================================

-- normalização canônica de CEP (imutável → usável em índice/JOIN/coluna gerada).
-- tira tudo que não é dígito; string vazia vira NULL (ausente ≠ fabricar número).
CREATE OR REPLACE FUNCTION normalizar_cep(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(COALESCE(p, ''), '\D', '', 'g'), '')
$$;

-- coordenada por CEP (fonte única de verdade). PK = CEP de 8 dígitos normalizado.
CREATE TABLE IF NOT EXISTS cep_geo (
  cep              text PRIMARY KEY CHECK (cep ~ '^[0-9]{8}$'),
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  source           text NOT NULL,
  precision        text NOT NULL CHECK (precision IN ('rooftop','street','postcode_centroid','city_centroid','unknown')),
  confidence       numeric,
  municipio_codigo text,
  uf               text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  raw              jsonb
);

-- centróide de município (fallback garantido por código IBGE de 7 dígitos).
CREATE TABLE IF NOT EXISTS municipio_geo (
  municipio_codigo text PRIMARY KEY,
  lat              double precision NOT NULL,
  lng              double precision NOT NULL,
  uf               text,
  nome             text,
  source           text NOT NULL DEFAULT 'ibge'
);

-- RLS: tabelas de referência → SELECT p/ authenticated; escrita SÓ via RPC
-- SECURITY DEFINER / service role (nenhuma policy de INSERT/UPDATE existe).
ALTER TABLE cep_geo       ENABLE ROW LEVEL SECURITY;
ALTER TABLE municipio_geo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cep_geo, municipio_geo FROM PUBLIC, anon;
GRANT SELECT ON cep_geo, municipio_geo TO authenticated;

DROP POLICY IF EXISTS cep_geo_sel ON cep_geo;
CREATE POLICY cep_geo_sel ON cep_geo
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS municipio_geo_sel ON municipio_geo;
CREATE POLICY municipio_geo_sel ON municipio_geo
  FOR SELECT TO authenticated USING (true);

-- =============================================================================
-- Parte 2/3 — cep_geo_upsert (idempotente + anti-downgrade + gate)
-- =============================================================================

-- ordem de precisão (maior = melhor). Usada no anti-downgrade do upsert.
CREATE OR REPLACE FUNCTION rank_precisao(p text)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'rooftop'           THEN 4
    WHEN 'street'            THEN 3
    WHEN 'postcode_centroid' THEN 2
    WHEN 'city_centroid'     THEN 1
    ELSE 0 END
$$;

-- upsert por CEP. Idempotente; NUNCA deixa uma fonte pior apagar uma melhor
-- (anti-downgrade). Gate = mesmo da carteira (gestor/master): quem vê a carteira
-- persiste o geocode dela. CEP lixo → no-op silencioso. Escrita só por aqui
-- (a tabela não tem policy de INSERT/UPDATE).
CREATE OR REPLACE FUNCTION cep_geo_upsert(
  p_cep text, p_lat double precision, p_lng double precision,
  p_source text, p_precision text, p_confidence numeric DEFAULT NULL,
  p_municipio_codigo text DEFAULT NULL, p_uf text DEFAULT NULL, p_raw jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cep text := normalizar_cep(p_cep);
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF v_cep IS NULL OR v_cep !~ '^[0-9]{8}$' THEN RETURN; END IF;  -- CEP inválido → no-op
  INSERT INTO cep_geo AS c (cep,lat,lng,source,precision,confidence,municipio_codigo,uf,raw,updated_at)
  VALUES (v_cep,p_lat,p_lng,p_source,p_precision,p_confidence,p_municipio_codigo,p_uf,p_raw, now())
  ON CONFLICT (cep) DO UPDATE
    SET lat=EXCLUDED.lat, lng=EXCLUDED.lng, source=EXCLUDED.source, precision=EXCLUDED.precision,
        confidence=EXCLUDED.confidence, municipio_codigo=EXCLUDED.municipio_codigo,
        uf=EXCLUDED.uf, raw=EXCLUDED.raw, updated_at=now()
    WHERE rank_precisao(EXCLUDED.precision) >= rank_precisao(c.precision);  -- anti-downgrade
END $$;

REVOKE ALL ON FUNCTION cep_geo_upsert(text,double precision,double precision,text,text,numeric,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cep_geo_upsert(text,double precision,double precision,text,text,numeric,text,text,jsonb) TO authenticated;

-- =============================================================================
-- Parte 3/3 — seed municipio_geo (de radar_municipios) + RPCs resolvem coord
-- DROP+CREATE: adicionar coluna ao RETURNS TABLE muda o tipo de retorno →
-- Postgres recusa CREATE OR REPLACE. Re-GRANT (authenticated, service_role)
-- após recriar (o DROP derruba os grants). sandbox_exec volta por default-priv.
-- =============================================================================

-- seed dos centróides reusando radar_municipios (já IBGE-matched: rm.codigo =
-- radar_empresas.municipio_codigo). Idempotente; decoupla do radar-ingest.
INSERT INTO municipio_geo (municipio_codigo, lat, lng, uf, nome, source)
SELECT codigo, lat, lng, uf, nome, 'radar_municipios'
  FROM radar_municipios
 WHERE lat IS NOT NULL AND lng IS NOT NULL
ON CONFLICT (municipio_codigo) DO NOTHING;

-- carteira_por_municipio: + lat/lng/precision no FIM. cep_geo por zip_code
-- normalizado; fallback = centróide do município (city_centroid). Corpo idêntico
-- ao vivo + 2 LEFT JOINs de geo (city-matching inalterado, já provado no redesign).
DROP FUNCTION IF EXISTS carteira_por_municipio(text);
CREATE FUNCTION carteira_por_municipio(p_municipio_codigo text)
RETURNS TABLE(user_id uuid, name text, phone text, street text, number text, neighborhood text, city text, state text, zip_code text, complement text, business_hours_open text, business_hours_close text, ultima_visita timestamp with time zone, dias_desde_visita integer, lat double precision, lng double precision, "precision" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
     WHERE public.norm_cidade(regexp_replace(a.city, '\s*\([^)]*\)\s*$', '')) = public.norm_cidade(v_nome)
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
              ELSE floor(extract(epoch FROM (now() - u.ultima)) / 86400)::int END,
         COALESCE(cg.lat, mg.lat),
         COALESCE(cg.lng, mg.lng),
         COALESCE(cg.precision, CASE WHEN mg.lat IS NOT NULL THEN 'city_centroid' END)
    FROM ende e
    JOIN public.profiles p ON p.user_id = e.user_id
    LEFT JOIN ult u ON u.customer_user_id = e.user_id
    LEFT JOIN cep_geo cg ON cg.cep = public.normalizar_cep(e.zip_code)
    LEFT JOIN municipio_geo mg ON mg.municipio_codigo = p_municipio_codigo
   WHERE COALESCE(p.is_employee, false) = false;
END $function$;
REVOKE ALL ON FUNCTION carteira_por_municipio(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION carteira_por_municipio(text) TO authenticated, service_role;

-- radar_prospects_para_rota: lat/lng resolvem por cep_geo (SoT) → re.lat legado
-- → centróide do município; + precision no FIM. Mantém re.lat na cadeia p/ não
-- regredir o front atual na janela Sub-PR1→Sub-PR2 (legado = 'street').
DROP FUNCTION IF EXISTS radar_prospects_para_rota(text, integer);
CREATE FUNCTION radar_prospects_para_rota(p_municipio_codigo text, p_limit integer DEFAULT 30)
RETURNS TABLE(cnpj text, razao_social text, nome_fantasia text, logradouro text, numero text, complemento text, bairro text, municipio_nome text, uf text, cep text, telefone1 text, telefone2 text, prospeccao_status text, lat double precision, lng double precision, geocode_status text, "precision" text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
         COALESCE(cg.lat, re.lat, mg.lat),
         COALESCE(cg.lng, re.lng, mg.lng),
         re.geocode_status,
         CASE WHEN cg.cep IS NOT NULL THEN cg.precision
              WHEN re.lat IS NOT NULL THEN 'street'
              WHEN mg.lat IS NOT NULL THEN 'city_centroid' END
    FROM public.radar_empresas re
    LEFT JOIN cep_geo cg ON cg.cep = public.normalizar_cep(re.cep)
    LEFT JOIN municipio_geo mg ON mg.municipio_codigo = re.municipio_codigo
   WHERE re.municipio_codigo = p_municipio_codigo
     AND re.ja_cliente = false
     AND re.prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa')
   ORDER BY (re.prospeccao_status = 'a_contatar') DESC,
            re.data_abertura DESC NULLS LAST,
            re.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 2000));
END $function$;
REVOKE ALL ON FUNCTION radar_prospects_para_rota(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION radar_prospects_para_rota(text, integer) TO authenticated, service_role;

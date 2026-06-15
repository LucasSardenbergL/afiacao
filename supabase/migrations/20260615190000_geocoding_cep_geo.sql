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

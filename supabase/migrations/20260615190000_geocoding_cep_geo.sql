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

#!/usr/bin/env bash
# PG17: prova a migration de geocoding (Sub-PR 1) EXECUTANDO de verdade —
# PL/pgSQL é late-bound, CREATE passa mas a verdade só aparece em runtime.
#
#   N1-N4 normalizar_cep: pontuação / espaço / vazio→NULL / null→NULL
#   C1/C2 cep_geo CHECK: CEP != 8 díg / precision fora do enum
#   R1-R3 RLS: authenticated lê cep_geo+municipio_geo / anon barrado
#   U     cep_geo_upsert: gate / idempotência / anti-downgrade / upgrade / no-op
#   G     RPCs resolvem coord: cep_geo (rooftop) > re.lat legado (street) >
#         centróide do município (city_centroid); seed de municipio_geo; gate
#
# Falha = vermelho (ON_ERROR_STOP + RAISE EXCEPTION). Falsificar: inverter o >=
# do anti-downgrade → U-DOWNGRADE vermelho; remover CHECK de precision → C2.
set -euo pipefail
export LC_ALL=C LANG=C
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ pg17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55491
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260615190000_geocoding_cep_geo.sql"

echo "=== schema + stubs + seed (Supabase/prod provê isto) ==="
"${P[@]}" <<'SQL'
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE ROLE service_role;
CREATE SCHEMA auth;
-- auth.uid() fixo (caller). pode_ver_carteira_completa: gate por GUC test.gate
-- ('on' libera; senão nega) — espelha o gate REAL gestor/master.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT current_setting('test.gate', true) IS NOT DISTINCT FROM 'on' $$;
-- stub de norm_cidade só p/ os alvos casarem (city-matching já provado no redesign;
-- seeds sem acento → não dependem do strip de acento aqui).
CREATE FUNCTION public.norm_cidade(p text) RETURNS text LANGUAGE sql IMMUTABLE
  AS $$ SELECT upper(btrim(coalesce(p,''))) $$;

CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_codigo text, municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text, data_abertura date,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  ja_cliente boolean NOT NULL DEFAULT false,
  lat double precision, lng double precision, geocode_status text);
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.addresses (
  user_id uuid NOT NULL, street text, number text, neighborhood text,
  city text NOT NULL, state text NOT NULL, zip_code text, complement text,
  is_default boolean DEFAULT false);
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY, name text, phone text, is_employee boolean,
  business_hours_open text, business_hours_close text);
CREATE TABLE public.route_visits (customer_user_id uuid NOT NULL, check_in_at timestamptz);

-- radar_municipios: Divinópolis com centróide + 1 SEM lat (testa o filtro do seed)
INSERT INTO public.radar_municipios(codigo,nome,uf,lat,lng) VALUES
  ('3122306','DIVINOPOLIS','MG',-20.13,-44.88),
  ('9999999','SEM CENTROIDE','MG',NULL,NULL);
-- prospects: p1 cep→cep_geo(rooftop) · p2 cep s/ cep_geo→município · p3 re.lat legado→street
INSERT INTO public.radar_empresas(cnpj,municipio_codigo,municipio_nome,uf,cep,prospeccao_status,ja_cliente,lat,lng,geocode_status,data_abertura) VALUES
  ('00000000000001','3122306','DIVINOPOLIS','MG','35500-001','a_contatar',false,NULL,NULL,NULL,'2020-01-01'),
  ('00000000000002','3122306','DIVINOPOLIS','MG','35500002','a_contatar',false,NULL,NULL,NULL,'2020-01-02'),
  ('00000000000003','3122306','DIVINOPOLIS','MG',NULL,'em_conversa',false,-20.20,-44.80,'ok','2020-01-03');
-- carteira: c1 zip→cep_geo(rooftop) · c2 zip s/ cep_geo→município(city_centroid)
INSERT INTO public.addresses(user_id,street,city,state,zip_code,is_default) VALUES
  ('00000000-0000-0000-0000-0000000000c1','Rua A','DIVINOPOLIS (MG)','MG','35500-001',true),
  ('00000000-0000-0000-0000-0000000000c2','Rua B','DIVINOPOLIS (MG)','MG','99999999',true);
INSERT INTO public.profiles(user_id,name,is_employee) VALUES
  ('00000000-0000-0000-0000-0000000000c1','Cliente C1',false),
  ('00000000-0000-0000-0000-0000000000c2','Cliente C2',false);
SQL

echo "=== aplica a migration REAL (cria geo, semeia municipio_geo, DROP+CREATE RPCs) ==="
"${P[@]}" -f "$MIG" >/dev/null

echo "=== seed cep_geo (superuser, bypassa gate/RLS) p/ R e G ==="
"${P[@]}" <<'SQL'
INSERT INTO cep_geo(cep,lat,lng,source,precision) VALUES
  ('35500000',-20.10,-44.90,'seed','postcode_centroid'),
  ('35500001',-20.1234,-44.9012,'nominatim','rooftop');
SQL

echo "=== N: normalizar_cep ==="
"${P[@]}" <<'SQL'
DO $$ BEGIN
  IF normalizar_cep('35.500-000') IS DISTINCT FROM '35500000' THEN
    RAISE EXCEPTION 'N1 FAIL: % (esperado 35500000)', normalizar_cep('35.500-000'); END IF;
  RAISE NOTICE 'N1 OK (pontuação tirada)';
  IF normalizar_cep('  35500000 ') IS DISTINCT FROM '35500000' THEN RAISE EXCEPTION 'N2 FAIL'; END IF;
  RAISE NOTICE 'N2 OK (espaços tirados)';
  IF normalizar_cep('') IS NOT NULL THEN RAISE EXCEPTION 'N3 FAIL: vazio deveria ser NULL'; END IF;
  RAISE NOTICE 'N3 OK (vazio → NULL)';
  IF normalizar_cep(NULL) IS NOT NULL THEN RAISE EXCEPTION 'N4 FAIL: null deveria ser NULL'; END IF;
  RAISE NOTICE 'N4 OK (null → NULL)';
END $$;
SQL

echo "=== C: CHECKs do cep_geo (negativos) ==="
"${P[@]}" <<'SQL'
DO $$ BEGIN
  BEGIN
    INSERT INTO cep_geo(cep,lat,lng,source,precision) VALUES ('3550000',-20,-44,'t','street');
    RAISE EXCEPTION 'C1 FAIL: CEP de 7 dígitos foi aceito';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'C1 OK (CEP != 8 díg rejeitado)';
  END;
  BEGIN
    INSERT INTO cep_geo(cep,lat,lng,source,precision) VALUES ('35509999',-20,-44,'t','bogus');
    RAISE EXCEPTION 'C2 FAIL: precision fora do enum foi aceita';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'C2 OK (precision inválida rejeitada)';
  END;
END $$;
SQL

echo "=== R: RLS/grants (positivo + negativo) ==="
"${P[@]}" <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  IF (SELECT count(*) FROM cep_geo) < 1 THEN RAISE EXCEPTION 'R1 FAIL'; END IF;
  RAISE NOTICE 'R1 OK (authenticated lê cep_geo)';
  IF (SELECT count(*) FROM municipio_geo) < 1 THEN RAISE EXCEPTION 'R3 FAIL'; END IF;
  RAISE NOTICE 'R3 OK (authenticated lê municipio_geo)';
END $$;
RESET ROLE;
SET ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM cep_geo;
  RAISE EXCEPTION 'R2 FAIL: anon conseguiu ler cep_geo';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'R2 OK (anon barrado)';
END $$;
RESET ROLE;
SQL

echo "=== U: cep_geo_upsert — gate / idempotência / anti-downgrade ==="
"${P[@]}" <<'SQL'
SET test.gate='off';
DO $$ BEGIN
  PERFORM cep_geo_upsert('30140071',-19.93,-43.93,'nom','street');
  RAISE EXCEPTION 'U-GATE FAIL: upsert passou sem permissão';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%forbidden%' THEN RAISE NOTICE 'U-GATE OK (forbidden sem gate)';
  ELSE RAISE; END IF;
END $$;

SET test.gate='on';
SELECT cep_geo_upsert('30140071',-19.93,-43.93,'nom','street');
SELECT cep_geo_upsert('30140071',-19.93,-43.93,'nom','street');
DO $$ DECLARE n int; p text; BEGIN
  SELECT count(*), max(precision) INTO n, p FROM cep_geo WHERE cep='30140071';
  IF n<>1 THEN RAISE EXCEPTION 'U-IDEMP FAIL: % linhas', n; END IF;
  IF p<>'street' THEN RAISE EXCEPTION 'U-IDEMP FAIL: precision=%', p; END IF;
  RAISE NOTICE 'U-IDEMP OK (1 linha, street)';
END $$;

SELECT cep_geo_upsert('30140071',-1,-1,'mun','city_centroid');
DO $$ DECLARE p text; la double precision; BEGIN
  SELECT precision, lat INTO p, la FROM cep_geo WHERE cep='30140071';
  IF p<>'street' OR la<>-19.93 THEN RAISE EXCEPTION 'U-DOWNGRADE FAIL: %/%', p, la; END IF;
  RAISE NOTICE 'U-DOWNGRADE OK (street preservado contra city_centroid)';
END $$;

DO $$ DECLARE t0 timestamptz; t1 timestamptz; p text; BEGIN
  SELECT updated_at INTO t0 FROM cep_geo WHERE cep='30140071';
  PERFORM cep_geo_upsert('30140071',-19.9,-43.9,'nom','rooftop');
  SELECT precision, updated_at INTO p, t1 FROM cep_geo WHERE cep='30140071';
  IF p<>'rooftop' THEN RAISE EXCEPTION 'U-UPGRADE FAIL: precision=%', p; END IF;
  IF t1<=t0 THEN RAISE EXCEPTION 'U-UPGRADE FAIL: updated_at não avançou'; END IF;
  RAISE NOTICE 'U-UPGRADE OK (rooftop sobrescreve + updated_at avança)';
END $$;

DO $$ DECLARE n0 int; n1 int; BEGIN
  SELECT count(*) INTO n0 FROM cep_geo;
  PERFORM cep_geo_upsert('abc',-1,-1,'x','street');
  PERFORM cep_geo_upsert('123',-1,-1,'x','street');
  SELECT count(*) INTO n1 FROM cep_geo;
  IF n1<>n0 THEN RAISE EXCEPTION 'U-LIXO FAIL: % -> %', n0, n1; END IF;
  RAISE NOTICE 'U-LIXO OK (CEP inválido = no-op)';
END $$;
SQL

echo "=== G: RPCs resolvem coord (cep_geo > re.lat > município) + seed + gate ==="
"${P[@]}" <<'SQL'
SET test.gate='on';
-- carteira: c1 (zip em cep_geo) rooftop · c2 (zip sem cep_geo) city_centroid
DO $$ DECLARE la double precision; pr text; BEGIN
  SELECT lat, precision INTO la, pr FROM carteira_por_municipio('3122306')
    WHERE user_id='00000000-0000-0000-0000-0000000000c1';
  IF pr IS DISTINCT FROM 'rooftop' OR la IS DISTINCT FROM -20.1234 THEN RAISE EXCEPTION 'G-CART1 FAIL: %/%', pr, la; END IF;
  RAISE NOTICE 'G-CART1 OK (cep_geo rooftop)';
  SELECT lat, precision INTO la, pr FROM carteira_por_municipio('3122306')
    WHERE user_id='00000000-0000-0000-0000-0000000000c2';
  IF pr IS DISTINCT FROM 'city_centroid' OR la IS DISTINCT FROM -20.13 THEN RAISE EXCEPTION 'G-CART2 FAIL: %/%', pr, la; END IF;
  RAISE NOTICE 'G-CART2 OK (fallback município = city_centroid)';
END $$;
-- prospects: p1 rooftop(cep_geo) · p2 city_centroid(município) · p3 street(re.lat legado)
DO $$ DECLARE la double precision; pr text; BEGIN
  SELECT lat, precision INTO la, pr FROM radar_prospects_para_rota('3122306',100) WHERE cnpj='00000000000001';
  IF pr IS DISTINCT FROM 'rooftop' OR la IS DISTINCT FROM -20.1234 THEN RAISE EXCEPTION 'G-PROS1 FAIL: %/%', pr, la; END IF;
  RAISE NOTICE 'G-PROS1 OK (cep_geo rooftop)';
  SELECT lat, precision INTO la, pr FROM radar_prospects_para_rota('3122306',100) WHERE cnpj='00000000000002';
  IF pr IS DISTINCT FROM 'city_centroid' OR la IS DISTINCT FROM -20.13 THEN RAISE EXCEPTION 'G-PROS2 FAIL: %/%', pr, la; END IF;
  RAISE NOTICE 'G-PROS2 OK (fallback município)';
  SELECT lat, precision INTO la, pr FROM radar_prospects_para_rota('3122306',100) WHERE cnpj='00000000000003';
  IF pr IS DISTINCT FROM 'street' OR la IS DISTINCT FROM -20.20 THEN RAISE EXCEPTION 'G-PROS3 FAIL: %/%', pr, la; END IF;
  RAISE NOTICE 'G-PROS3 OK (re.lat legado = street)';
END $$;
-- seed: municipio_geo veio de radar_municipios, filtrando lat NULL (9999999 fora)
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM municipio_geo;
  IF n<>1 THEN RAISE EXCEPTION 'G-SEED FAIL: municipio_geo=% (esperado 1)', n; END IF;
  RAISE NOTICE 'G-SEED OK (municipio_geo=1, sem-lat filtrado)';
END $$;
-- gate: RPC nega sem permissão
SET test.gate='off';
DO $$ BEGIN
  PERFORM * FROM carteira_por_municipio('3122306');
  RAISE EXCEPTION 'G-GATE FAIL: carteira passou sem gate';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE '%forbidden%' THEN RAISE NOTICE 'G-GATE OK (forbidden)'; ELSE RAISE; END IF;
END $$;
SQL

echo "✅ Sub-PR 1 banco verde (schema/CHECKs/RLS + upsert + RPCs resolvem coord)"

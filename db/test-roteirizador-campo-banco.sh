#!/usr/bin/env bash
# PG17: valida a migration 20260614160000 (carteira por município normalizada +
# recência; teto prospects 2000; gate). Executa de verdade (PL/pgSQL é late-bound).
#  A1 casa apesar do acento (DIVINOPOLIS sem acento vs DIVINÓPOLIS RFB)
#  A2 casa com caixa diferente
#  A3 NÃO casa homônimo de OUTRA uf
#  A4 NÃO traz staff (is_employee=true)
#  A5 recência: cliente visitado há ~10d => 10; nunca visitado => NULL
#  B1 teto: 250 prospects 'a_contatar' com p_limit alto => 250 (>200 antigo)
#  B2 p_limit pequeno respeitado (50 => 50)
#  G1 gate: pode_ver_carteira_completa=false => EXCEPTION 'forbidden'
set -euo pipefail
export LC_ALL=C LANG=C
PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ pg17 não encontrado"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55478
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
MIG="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260614160000_roteirizador_campo_banco.sql"

echo "=== schema mínimo + stubs + seed ==="
"${P[@]}" <<'SQL'
CREATE ROLE authenticated;
CREATE ROLE anon;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
-- gate por GUC: 'on' habilita; qualquer outra coisa (ou unset) nega.
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT current_setting('test.gate', true) IS NOT DISTINCT FROM 'on' $$;

CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text,
  logradouro text, numero text, complemento text, bairro text,
  municipio_codigo text, municipio_nome text, uf text, cep text,
  telefone1 text, telefone2 text, data_abertura date,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  ja_cliente boolean NOT NULL DEFAULT false,
  lat double precision, lng double precision, geocode_status text);
CREATE INDEX idx_re_muni ON public.radar_empresas (municipio_codigo);

CREATE TABLE public.addresses (
  user_id uuid NOT NULL, street text, number text, neighborhood text,
  city text NOT NULL, state text NOT NULL, zip_code text, complement text,
  is_default boolean DEFAULT false);
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY, name text, phone text, is_employee boolean,
  business_hours_open text, business_hours_close text);
CREATE TABLE public.route_visits (
  customer_user_id uuid NOT NULL, check_in_at timestamptz);

-- 250 prospects 'a_contatar' DIVINÓPOLIS/MG — servem de prospects (B1/B2) E
-- resolvem (nome, uf) do código 3122306 pra carteira_por_municipio.
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, prospeccao_status, ja_cliente, data_abertura)
  SELECT lpad((100+g)::text,14,'0'),'3122306','DIVINÓPOLIS','MG','a_contatar',false, date '2020-01-01'+g
  FROM generate_series(1,250) g;

-- clientes:
-- b1 city sem acento 'Divinopolis' MG (A1) + visita há 10d (A5)
-- b2 city caixa alta 'DIVINÓPOLIS' mg (A2) sem visita (A5 NULL)
-- b3 'Divinópolis' SP homônimo outra uf (A3) — NÃO casa
-- b4 'Divinopolis' MG mas is_employee=true (A4) — NÃO casa
INSERT INTO public.addresses (user_id, street, city, state, is_default) VALUES
  ('00000000-0000-0000-0000-0000000000b1'::uuid,'Rua A','Divinopolis','MG',true),
  ('00000000-0000-0000-0000-0000000000b2'::uuid,'Rua B','DIVINÓPOLIS','mg',true),
  ('00000000-0000-0000-0000-0000000000b3'::uuid,'Rua C','Divinópolis','SP',true),
  ('00000000-0000-0000-0000-0000000000b4'::uuid,'Rua D','Divinopolis','MG',true);
INSERT INTO public.profiles (user_id, name, is_employee) VALUES
  ('00000000-0000-0000-0000-0000000000b1'::uuid,'Cliente Um',false),
  ('00000000-0000-0000-0000-0000000000b2'::uuid,'Cliente Dois',false),
  ('00000000-0000-0000-0000-0000000000b3'::uuid,'Cliente Tres',false),
  ('00000000-0000-0000-0000-0000000000b4'::uuid,'Func Quatro',true);
INSERT INTO public.route_visits (customer_user_id, check_in_at) VALUES
  ('00000000-0000-0000-0000-0000000000b1'::uuid, now() - interval '10 days');
SQL

echo "=== aplica a migration ==="
"${P[@]}" -f "$MIG" | grep -E "ROTEIRIZADOR CAMPO BANCO|funcoes_3" || true

echo "=== asserts ==="
"${P[@]}" <<'SQL'
SET test.gate='on';
SELECT CASE WHEN count(*)=2 THEN 'A1A2A4 OK' ELSE 'A1A2A4 FAIL n='||count(*) END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE WHEN bool_and(user_id <> '00000000-0000-0000-0000-0000000000b3'::uuid) THEN 'A3 OK' ELSE 'A3 FAIL' END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE WHEN bool_and(user_id <> '00000000-0000-0000-0000-0000000000b4'::uuid) THEN 'A4b OK' ELSE 'A4b FAIL' END
  FROM public.carteira_por_municipio('3122306');
SELECT CASE
    WHEN (SELECT dias_desde_visita FROM public.carteira_por_municipio('3122306')
            WHERE user_id='00000000-0000-0000-0000-0000000000b1'::uuid) BETWEEN 9 AND 11
     AND (SELECT dias_desde_visita FROM public.carteira_por_municipio('3122306')
            WHERE user_id='00000000-0000-0000-0000-0000000000b2'::uuid) IS NULL
    THEN 'A5 OK' ELSE 'A5 FAIL' END;
SELECT CASE WHEN count(*)=250 THEN 'B1 OK' ELSE 'B1 FAIL n='||count(*) END
  FROM public.radar_prospects_para_rota('3122306', 1000);
SELECT CASE WHEN count(*)=50 THEN 'B2 OK' ELSE 'B2 FAIL n='||count(*) END
  FROM public.radar_prospects_para_rota('3122306', 50);
SQL

echo "=== G1 gate nega não-gestor ==="
"${P[@]}" <<'SQL'
SET test.gate='off';
DO $$ BEGIN
  PERFORM * FROM public.carteira_por_municipio('3122306');
  RAISE NOTICE 'G1 FAIL: deveria ter barrado';
EXCEPTION WHEN OTHERS THEN
  IF SQLERRM LIKE '%forbidden%' THEN RAISE NOTICE 'G1 OK';
  ELSE RAISE NOTICE 'G1 FAIL: %', SQLERRM; END IF;
END $$;
SQL

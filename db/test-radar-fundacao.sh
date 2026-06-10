#!/usr/bin/env bash
# Valida a migration 20260610200000_radar_fundacao.sql num PostgreSQL 17 local.
# Asserts: upsert preserva estado de prospecção; recruza marca ja_cliente pelos
# DOIS conjuntos; RLS nega não-gestor; CHECKs rejeitam lixo.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin)"
DB_DIR="$(mktemp -d)"; PORT=55436
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs mínimos (auth.uid override por GUC + tabelas/funções de prod que a migration referencia)
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, document text);
CREATE TABLE public.omie_clientes_nao_vinculados (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj_cpf text);
-- stub fiel ao contrato de prod: gestor/master ⇒ true (corpo real testado nos PRs #329/#340)
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260610200000_radar_fundacao.sql >/dev/null
"${PSQL[@]}" <<'SQL'
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

-- Seeds
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-00000000aaaa');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000001', '11.222.333/0001-44');
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('55666777000188');
INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
  ('11222333000144', '3101200', '2026-05', 'JA CLIENTE VIA PROFILE'),
  ('55666777000188', '3101200', '2026-05', 'JA CLIENTE VIA NAO VINCULADO'),
  ('99888777000166', '3101200', '2026-05', 'LEAD LIVRE');

-- A1: recruza marca pelos DOIS conjuntos e poupa o lead livre
SELECT public.radar_recruzar_ja_cliente() AS marcados \gset
SELECT CASE WHEN :marcados = 2 THEN 'A1 OK' ELSE 'A1 FALHOU: '||:marcados END;
SELECT CASE WHEN (SELECT ja_cliente FROM radar_empresas WHERE cnpj='99888777000166') = false
  THEN 'A2 OK' ELSE 'A2 FALHOU' END;

-- A3: upsert de lote novo preserva primeira_vista_em e prospeccao_status
UPDATE radar_empresas SET prospeccao_status='em_conversa', prospeccao_atualizado_em=now()
  WHERE cnpj='99888777000166';
SELECT primeira_vista_em AS pv0 FROM radar_empresas WHERE cnpj='99888777000166' \gset
INSERT INTO radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social)
VALUES ('99888777000166', '3101200', '2026-06', 'LEAD LIVRE RENOMEADO')
ON CONFLICT (cnpj) DO UPDATE SET
  razao_social=EXCLUDED.razao_social, ultimo_lote=EXCLUDED.ultimo_lote, updated_at=now();
SELECT CASE WHEN prospeccao_status='em_conversa' AND primeira_vista_em=:'pv0'
  AND ultimo_lote='2026-06' AND razao_social='LEAD LIVRE RENOMEADO'
  THEN 'A3 OK' ELSE 'A3 FALHOU' END FROM radar_empresas WHERE cnpj='99888777000166';

-- A4: RLS — gestor lê; não-gestor lê 0; CHECK rejeita cnpj inválido
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
SELECT CASE WHEN count(*)=3 THEN 'A4a OK' ELSE 'A4a FALHOU' END FROM radar_empresas;
SET test.uid = '00000000-0000-0000-0000-00000000bbbb';
SELECT CASE WHEN count(*)=0 THEN 'A4b OK' ELSE 'A4b FALHOU' END FROM radar_empresas;
RESET ROLE; SET test.uid = '';
DO $$ BEGIN
  INSERT INTO radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('abc', '3101200', '2026-06');
  RAISE EXCEPTION 'A5 FALHOU: CHECK não barrou';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'A5 OK'; END $$;
SQL
echo "✅ test-radar-fundacao: todos os asserts passaram"

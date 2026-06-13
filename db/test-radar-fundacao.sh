#!/usr/bin/env bash
# Valida a migration 20260610200000_radar_fundacao.sql num PostgreSQL 17 local.
# Asserts: upsert preserva estado de prospecção; recruza marca ja_cliente pelos
# DOIS conjuntos; RLS nega não-gestor; CHECKs rejeitam lixo.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
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
-- Simula default privileges de prod: gestor/authenticated lê; service_role bypassa RLS
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Seeds
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-00000000aaaa');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000001', '11.222.333/0001-44');
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('55666777000188');
INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
  ('11222333000144', '3101200', '2026-05', 'JA CLIENTE VIA PROFILE'),
  ('55666777000188', '3101200', '2026-05', 'JA CLIENTE VIA NAO VINCULADO'),
  ('99888777000166', '3101200', '2026-05', 'LEAD LIVRE');

-- A1: recruza marca pelos DOIS conjuntos e poupa o lead livre
DO $$
DECLARE v_marcados integer;
BEGIN
  SELECT public.radar_recruzar_ja_cliente() INTO v_marcados;
  IF v_marcados <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: marcados=%', v_marcados; END IF;
  RAISE NOTICE 'A1 OK';
END $$;

-- A2: lead livre permanece ja_cliente=false
DO $$
BEGIN
  IF (SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='99888777000166') <> false THEN
    RAISE EXCEPTION 'A2 FALHOU: lead livre foi marcado como ja_cliente';
  END IF;
  RAISE NOTICE 'A2 OK';
END $$;

-- A3 é o ORÁCULO do upsert da edge radar-ingest (Task 5): o ON CONFLICT só pode
-- atualizar campos cadastrais + ultimo_lote — NUNCA prospeccao_status /
-- primeira_vista_em / ja_cliente. Se a edge divergir disso, este assert é o contrato.
UPDATE public.radar_empresas SET prospeccao_status='em_conversa', prospeccao_atualizado_em=now()
  WHERE cnpj='99888777000166';
-- Captura primeira_vista_em antes do upsert (sem \gset — usa TEMP TABLE)
CREATE TEMP TABLE t_pv AS
  SELECT primeira_vista_em AS pv FROM public.radar_empresas WHERE cnpj='99888777000166';

INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social)
VALUES ('99888777000166', '3101200', '2026-06', 'LEAD LIVRE RENOMEADO')
ON CONFLICT (cnpj) DO UPDATE SET
  razao_social=EXCLUDED.razao_social, ultimo_lote=EXCLUDED.ultimo_lote, updated_at=now();

DO $$
DECLARE r public.radar_empresas%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.radar_empresas WHERE cnpj='99888777000166';
  IF r.prospeccao_status <> 'em_conversa' THEN
    RAISE EXCEPTION 'A3 FALHOU: prospeccao_status sobrescrito (=%)', r.prospeccao_status;
  END IF;
  IF r.primeira_vista_em <> (SELECT pv FROM t_pv) THEN
    RAISE EXCEPTION 'A3 FALHOU: primeira_vista_em alterada';
  END IF;
  IF r.ultimo_lote <> '2026-06' THEN
    RAISE EXCEPTION 'A3 FALHOU: ultimo_lote não atualizado (=%)', r.ultimo_lote;
  END IF;
  IF r.razao_social <> 'LEAD LIVRE RENOMEADO' THEN
    RAISE EXCEPTION 'A3 FALHOU: razao_social não atualizada (=%)', r.razao_social;
  END IF;
  RAISE NOTICE 'A3 OK';
END $$;

-- A4a: RLS — gestor vê todas as linhas
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.radar_empresas;
  IF v_count <> 3 THEN RAISE EXCEPTION 'A4a FALHOU: gestor viu % linhas (esperado 3)', v_count; END IF;
  RAISE NOTICE 'A4a OK';
END $$;

-- A4b: RLS — não-gestor vê 0 linhas
SET test.uid = '00000000-0000-0000-0000-00000000bbbb';
DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.radar_empresas;
  IF v_count <> 0 THEN RAISE EXCEPTION 'A4b FALHOU: não-gestor viu % linhas (esperado 0)', v_count; END IF;
  RAISE NOTICE 'A4b OK';
END $$;
RESET ROLE; SET test.uid = '';

-- A5: CHECK rejeita cnpj inválido
DO $$ BEGIN
  INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('abc', '3101200', '2026-06');
  RAISE EXCEPTION 'A5 FALHOU: CHECK não barrou';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'A5 OK'; END $$;

-- A6: escrita direta negada por RLS para authenticated (mesmo com GRANT ALL de cima)
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
DO $$
BEGIN
  INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('22333444000155','3101200','2026-06');
  RAISE EXCEPTION 'A6 FALHOU: escrita direta deveria ser negada por RLS';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A6 OK';
END $$;
RESET ROLE;

-- A7: EXECUTE da recruza negado a authenticated
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.radar_recruzar_ja_cliente();
  RAISE EXCEPTION 'A7 FALHOU: authenticated não deveria executar radar_recruzar_ja_cliente';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'A7 OK';
END $$;
RESET ROLE;
SQL
echo "✅ test-radar-fundacao: todos os asserts passaram"

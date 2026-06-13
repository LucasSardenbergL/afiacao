#!/usr/bin/env bash
# Valida a migration 20260613130000_radar_rls_initplan_perf:
# (1) aplica limpo; (2) semântica de segurança preservada (gestor lê / não-gestor nega);
# (3) o plano usa InitPlan (1×), não avaliação por-linha da função RLS.
set -euo pipefail
export LC_ALL=C LANG=C
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin 2>/dev/null || true)"
[ -n "$PGBIN" ] && [ -x "$PGBIN/initdb" ] || { echo "❌ postgresql@17 não encontrado — brew install postgresql@17"; exit 1; }
DB_DIR="$(mktemp -d)"; PORT=55444
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
P=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs: auth.uid, roles, função real (SECURITY DEFINER STABLE), 4 tabelas radar com RLS.
"${P[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN;
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = _uid) $$;
CREATE TABLE public.radar_empresas (cnpj text PRIMARY KEY, uf text, data_abertura date, ja_cliente boolean DEFAULT false, prospeccao_status text DEFAULT 'a_contatar');
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text);
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text);
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_municipios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_ingest_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${P[@]}" -f supabase/migrations/20260613130000_radar_rls_initplan_perf.sql >/dev/null

"${P[@]}" <<'SQL'
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_empresas (cnpj, uf) VALUES ('11111111000111','MG'),('22222222000122','SP');

-- A1: gestor lê as 2 linhas
SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000a1';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.radar_empresas) <> 2 THEN RAISE EXCEPTION 'A1 FALHOU: gestor não leu'; END IF;
  RAISE NOTICE 'A1 OK (gestor lê)';
END $$;

-- A2: não-gestor lê 0 (segurança preservada pelo fix)
SET test.uid='00000000-0000-0000-0000-0000000000b2';
DO $$ BEGIN
  IF (SELECT count(*) FROM public.radar_empresas) <> 0 THEN RAISE EXCEPTION 'A2 FALHOU: não-gestor leu'; END IF;
  RAISE NOTICE 'A2 OK (não-gestor nega)';
END $$;
RESET ROLE; SET test.uid='';
SQL

# A3: o plano usa InitPlan (a função NÃO está no per-row Filter junto com as colunas).
echo "--- A3: plano da query (deve ter pode_ver em InitPlan, não no Filter por-linha) ---"
PLAN="$("${P[@]}" -t <<'SQL'
SET ROLE authenticated; SET test.uid='00000000-0000-0000-0000-0000000000a1';
EXPLAIN SELECT * FROM public.radar_empresas WHERE uf='MG' ORDER BY data_abertura DESC NULLS LAST, cnpj LIMIT 50;
SQL
)"
echo "$PLAN" | grep -iE "InitPlan|Filter" || true
# o fix correto: 'pode_ver_carteira_completa' aparece numa linha InitPlan; o Filter
# referencia (InitPlan N).col1, NÃO a função chamada diretamente por linha.
if echo "$PLAN" | grep -iE "Filter:.*pode_ver_carteira_completa\(" >/dev/null; then
  echo "❌ A3 FALHOU: função ainda avaliada POR LINHA (no Filter)"; exit 1;
fi
if echo "$PLAN" | grep -i "InitPlan" >/dev/null; then
  echo "✅ A3 OK (função em InitPlan — avaliada 1×)";
else
  echo "⚠️ A3: sem InitPlan no plano — revisar (pode ser otimização diferente do planner)"; exit 1;
fi
echo "✅ test-radar-rls-perf: todos os asserts passaram"

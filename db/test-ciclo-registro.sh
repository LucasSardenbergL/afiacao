#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — registro de execução dentro de ciclo_oportunidade_do_dia        ║
# ║  migration: 20260722110000_ciclo_oportunidade_registra_execucao.sql           ║
# ║  Rode:  bash db/test-ciclo-registro.sh > /tmp/t.log 2>&1; echo $?             ║
# ║                                                                                ║
# ║  Prova: cron (auth.uid() NULL) grava 'automatica'; clique staff grava         ║
# ║  'manual'+nome; erro no gerador → ROLLBACK leva o registro junto (sem órfã);  ║
# ║  registro quebrado NÃO derruba o ciclo (fail-open); INVOKER+search_path       ║
# ║  preservados. Falsifica: repõe a função SEM registro → linha deixa de nascer. ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5476}"
SLUG="ciclo-registro"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos que a PROD já tem ──
P -q <<SQL
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS \$f\$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
\$f\$;
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text);
GRANT SELECT ON public.profiles TO authenticated;
-- Espelha o prod: authenticated/anon têm USAGE no schema auth (as RLS do PR1 avaliam
-- auth.uid() como authenticated em produção — evidência empírica de 2026-07-20).
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
INSERT INTO auth.users (id, email) VALUES ('$MASTER', 'master@t');
INSERT INTO public.user_roles (user_id, role) VALUES ('$MASTER', 'master');
INSERT INTO public.profiles (user_id, name) VALUES ('$MASTER', 'Lucas Sardenberg');

-- Tabelas de apoio do ciclo (colunas usadas; grants amplos — RLS delas não é o alvo da prova)
CREATE TABLE public.promocao_campanha (empresa text, estado text, data_corte_pedido date, permite_pedido_oportunidade boolean);
CREATE TABLE public.fornecedor_aumento_anunciado (empresa text, estado text, data_vigencia date);
CREATE TABLE public.fornecedor_alerta (id bigint GENERATED ALWAYS AS IDENTITY, empresa text, tipo text, severidade text, titulo text, mensagem text);
GRANT ALL ON public.promocao_campanha, public.fornecedor_aumento_anunciado, public.fornecedor_alerta TO authenticated;

-- Stub do gerador (assinatura real de prod); sabotável via GUC test.fail_gerar
CREATE OR REPLACE FUNCTION public.gerar_pedidos_oportunidade_ciclo(p_empresa text, p_data date)
RETURNS TABLE(pedidos_gerados int, skus_incluidos int, valor_total numeric, economia_bruta numeric, cenarios_cobertos text[])
LANGUAGE plpgsql AS \$f\$
BEGIN
  IF current_setting('test.fail_gerar', true) = '1' THEN
    RAISE EXCEPTION 'stub-explodiu';
  END IF;
  RETURN QUERY SELECT 7, 12, 3500.00::numeric, 420.00::numeric, ARRAY['promo']::text[];
END; \$f\$;
GRANT EXECUTE ON FUNCTION public.gerar_pedidos_oportunidade_ciclo(text, date) TO authenticated;
SQL

# ── ZONA 2: migrations REAIS (PR1: tabela · PR3: função com registro) ──
P -q -f "$REPO_ROOT/supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260722110000_ciclo_oportunidade_registra_execucao.sql"

echo "═══ asserts ═══"

# C1: caminho do CRON (postgres, auth.uid() NULL) sem eventos → linha automatica/sucesso
eq "C1 cron sem eventos -> automatica" "$(Pq <<'SQL'
SELECT executou::text FROM public.ciclo_oportunidade_do_dia('OBEN');
SELECT origem||'|'||status||'|'||coalesce(executado_por::text,'null')||'|'||(detalhes->>'executou')
FROM public.acoes_execucoes WHERE acao='reposicao.gerar_ciclo_oportunidade'
ORDER BY iniciado_em DESC LIMIT 1;
SQL
)" "false
automatica|sucesso|null|false"

# C2: clique MANUAL (staff via RPC INVOKER) com campanha ativa → manual + nome + detalhes do stub
eq "C2 manual staff com evento -> manual+nome" "$(Pq <<SQL
INSERT INTO public.promocao_campanha VALUES ('OBEN', 'ativa', CURRENT_DATE, true);
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
SELECT executou::text||'|'||motivo FROM public.ciclo_oportunidade_do_dia('OBEN');
RESET ROLE;
SELECT origem||'|'||executado_por_nome||'|'||(detalhes->>'pedidos_gerados')||'|'||(detalhes->>'motivo')
FROM public.acoes_execucoes WHERE acao='reposicao.gerar_ciclo_oportunidade'
ORDER BY iniciado_em DESC LIMIT 1;
SQL
)" "true|corte_promocao
manual|Lucas Sardenberg|7|corte_promocao"

# C4: erro no gerador → ROLLBACK leva o registro junto (nenhuma linha órfã 'executando')
eq "C4 erro no gerador -> rollback sem órfã" "$(Pq <<'SQL'
SELECT count(*) FROM public.acoes_execucoes \gset antes_
DO $$ BEGIN
  PERFORM set_config('test.fail_gerar', '1', false);
  PERFORM * FROM public.ciclo_oportunidade_do_dia('OBEN');
  RAISE EXCEPTION 'NAO-FALHOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM <> 'stub-explodiu' THEN RAISE; END IF;
END $$;
SELECT set_config('test.fail_gerar', '', false) \gset _
SELECT count(*) - :antes_count FROM public.acoes_execucoes;
SQL
)" "0"

# C5: INVOKER e search_path preservados no replace (armadilha do CLAUDE.md)
eq "C5 invoker+search_path preservados" "$(Pq <<'SQL'
SELECT prosecdef::text||'|'||(proconfig::text LIKE '%search_path=public, pg_temp%')::text
FROM pg_proc WHERE proname='ciclo_oportunidade_do_dia';
SQL
)" "false|true"

# C3: FAIL-OPEN — sem a tabela de registro, o ciclo AINDA roda (registro nunca derruba o ciclo)
eq "C3 fail-open sem tabela -> ciclo roda" "$(Pq <<SQL
DROP TABLE public.acoes_execucoes CASCADE;
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
SELECT executou::text||'|'||pedidos_gerados::text FROM public.ciclo_oportunidade_do_dia('OBEN');
SQL
)" "true|7"

echo "═══ FALSIFICAÇÃO (função SEM registro → linha deixa de nascer; o teste TEM que acusar) ═══"
# Recria a tabela (PR1) e repõe a função na versão ORIGINAL de prod (sem registro)
P -q -f "$REPO_ROOT/supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.ciclo_oportunidade_do_dia(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(executou boolean, motivo text, pedidos_gerados integer, skus_incluidos integer, economia_estimada numeric)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_campanhas_hoje int; v_aumentos_hoje int; v_result record; v_motivo text := '';
BEGIN
  SELECT COUNT(*) INTO v_campanhas_hoje FROM promocao_campanha
  WHERE empresa = p_empresa AND estado = 'ativa' AND data_corte_pedido = p_data_ciclo AND permite_pedido_oportunidade = true;
  SELECT COUNT(*) INTO v_aumentos_hoje FROM fornecedor_aumento_anunciado
  WHERE empresa = p_empresa AND estado IN ('ativo','vigente') AND data_vigencia = p_data_ciclo + INTERVAL '1 day';
  IF v_campanhas_hoje = 0 AND v_aumentos_hoje = 0 THEN
    RETURN QUERY SELECT false, 'sem_eventos_hoje'::text, 0, 0, 0::numeric; RETURN;
  END IF;
  v_motivo := CASE WHEN v_campanhas_hoje > 0 AND v_aumentos_hoje > 0 THEN 'promo_e_aumento'
    WHEN v_campanhas_hoje > 0 THEN 'corte_promocao' ELSE 'vespera_aumento' END;
  SELECT * INTO v_result FROM gerar_pedidos_oportunidade_ciclo(p_empresa, p_data_ciclo) LIMIT 1;
  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem)
  VALUES (p_empresa, 'oportunidade_calculada', 'atencao', 'x', 'x');
  RETURN QUERY SELECT true, v_motivo, v_result.pedidos_gerados, v_result.skus_incluidos, v_result.valor_total;
END;
$function$;
SQL
eq "F1 sabotagem detectável (sem registro -> 0 linhas)" "$(Pq <<'SQL'
SELECT executou::text FROM public.ciclo_oportunidade_do_dia('OBEN');
SELECT count(*) FROM public.acoes_execucoes WHERE acao='reposicao.gerar_ciclo_oportunidade';
SQL
)" "true
0"

echo ""
echo "═══ resultado: $PASS ✅ · $FAIL ❌ ═══"
[ "$FAIL" -eq 0 ]

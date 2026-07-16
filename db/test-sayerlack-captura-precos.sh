#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260716162000_sayerlack_captura_precos_fase1.sql                ║
# ║  Run-log da captura de preços Sayerlack (RLS staff-select / escrita só         ║
# ║  service-role) + cron mensal (comando EXECUTADO com stubs net/vault) +         ║
# ║  UPDATE guardado de embalagem_preco_stale_horas.                               ║
# ║  Rode: bash db/test-sayerlack-captura-precos.sh > /tmp/t.log 2>&1; echo $?     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="sayerlack-captura"
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
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- enum + user_roles + has_role (semântica de prod: EXISTS em user_roles; SECDEF)
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;

-- company_config (key/value) com o valor de prod pré-migration
CREATE TABLE IF NOT EXISTS public.company_config (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key        text UNIQUE NOT NULL,
  value      text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
INSERT INTO public.company_config (key, value) VALUES ('embalagem_preco_stale_horas', '24')
ON CONFLICT (key) DO UPDATE SET value = '24';

-- cron.schedule/unschedule funcionais sobre a tabela-stub cron.job (upsert por nome,
-- como o pg_cron real) — a migration os chama de verdade
CREATE SEQUENCE IF NOT EXISTS cron.jobid_seq;
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, sched text, cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_id bigint;
BEGIN
  UPDATE cron.job SET schedule = sched, command = cmd, active = true WHERE jobname = job_name RETURNING jobid INTO v_id;
  IF v_id IS NULL THEN
    v_id := nextval('cron.jobid_seq');
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, job_name, sched, cmd, true);
  END IF;
  RETURN v_id;
END $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', job_name; END IF;
  RETURN true;
END $f$;

-- vault + net stubados: o COMANDO do cron será EXECUTADO no assert (late-bound
-- do job: só executar prova que o SQL armazenado é válido). net.http_post grava
-- a chamada numa tabela-sonda em vez de fazer HTTP.
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'stub-secret');
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE IF NOT EXISTS net._stub_calls (
  id bigint GENERATED ALWAYS AS IDENTITY,
  url text, headers jsonb, body jsonb, timeout_ms integer
);
CREATE OR REPLACE FUNCTION net.http_post(url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_id bigint;
BEGIN
  INSERT INTO net._stub_calls (url, headers, body, timeout_ms) VALUES (url, headers, body, timeout_milliseconds) RETURNING id INTO v_id;
  RETURN v_id;
END $f$;
SQL
echo "pré-requisitos ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260716162000_sayerlack_captura_precos_fase1.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- staff (employee)
  ('22222222-2222-2222-2222-222222222222')   -- customer (sem role staff)
ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'employee'),
  ('22222222-2222-2222-2222-222222222222', 'customer');

-- run + item semeados como postgres (superuser ignora RLS e tem privilégio)
INSERT INTO public.sku_preco_captura_run (id, empresa, disparo, modo, status, total_alvo, criado_por)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'oben', 'manual', 'spike', 'ok', 2, 'teste');
INSERT INTO public.sku_preco_captura_run_item (run_id, empresa, sku_codigo_omie, sku_portal, resultado, preco, fonte)
VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'oben', '8689775044', 'WP01.3900QT', 'ok', 74.4348, 'portal_capturado_ok');

-- grants p/ os asserts de RLS (em prod vêm dos default privileges do Supabase);
-- a policy chama has_role (SECDEF) — user_roles legível pela própria função
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sku_preco_captura_run, public.sku_preco_captura_run_item TO authenticated, anon, service_role;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL
echo "seed ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# A1 objetos existem
V=$(Pq -c "SELECT (to_regclass('public.sku_preco_captura_run') IS NOT NULL AND to_regclass('public.sku_preco_captura_run_item') IS NOT NULL)::text;")
eq "A1 run-log criado (2 tabelas)" "$V" "true"

# A2 default de status é 'running' (-q: suprime a tag INSERT 0 1 do psql)
V=$(P -qtA -c "INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','cron','full') RETURNING status;")
eq "A2 status default running" "$V" "running"

# A3-A6 CHECKs rejeitam com 23514 (sentinela própria, nunca o texto do banco)
for caso in \
  "A3 disparo inválido|INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','banana','full')" \
  "A4 status inválido|INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo, status) VALUES ('oben','cron','full','done')" \
  "A5 resultado inválido|INSERT INTO public.sku_preco_captura_run_item (run_id, empresa, sku_codigo_omie, sku_portal, resultado) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','oben','x','X','skip')" \
  "A6 preço 0 no run-item|INSERT INTO public.sku_preco_captura_run_item (run_id, empresa, sku_codigo_omie, sku_portal, resultado, preco) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','oben','x','X','ok',0)" \
; do
  NOME="${caso%%|*}"; STMT="${caso#*|}"
  R=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  ${STMT};
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'BARRADO_CHECK_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in
    *BARRADO_CHECK_OK*) ok "$NOME (23514)";;
    *) bad "$NOME — não deu check_violation: $R";;
  esac
done

# A7 FK órfã → 23503
R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  INSERT INTO public.sku_preco_captura_run_item (run_id, empresa, sku_codigo_omie, sku_portal, resultado)
  VALUES ('99999999-9999-9999-9999-999999999999','oben','x','X','ok');
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION
  WHEN foreign_key_violation THEN RAISE NOTICE 'BARRADO_FK_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *BARRADO_FK_OK*) ok "A7 FK órfã (23503)";;
  *) bad "A7 FK órfã — não deu foreign_key_violation: $R";;
esac

# A8 RLS: staff (employee) vê o run e o item
V=$(Pq <<'SQL' | tail -1
SET test.uid = '11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT (SELECT count(*) FROM public.sku_preco_captura_run WHERE id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text
    || '/' ||
       (SELECT count(*) FROM public.sku_preco_captura_run_item WHERE run_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')::text;
SQL
)
eq "A8 RLS staff vê run/item" "$V" "1/1"

# A9 RLS: customer autenticado (sem role staff) vê 0
V=$(Pq <<'SQL' | tail -1
SET test.uid = '22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
SELECT ((SELECT count(*) FROM public.sku_preco_captura_run) + (SELECT count(*) FROM public.sku_preco_captura_run_item))::text;
SQL
)
eq "A9 RLS customer vê 0" "$V" "0"

# A10 RLS: anon vê 0
V=$(Pq <<'SQL' | tail -1
SET test.uid = '';
SET ROLE anon;
SELECT ((SELECT count(*) FROM public.sku_preco_captura_run) + (SELECT count(*) FROM public.sku_preco_captura_run_item))::text;
SQL
)
eq "A10 RLS anon vê 0" "$V" "0"

# A11 RLS: escrita negada até para staff autenticado (escrita é só service-role) → 42501
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid = '11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','manual','spike');
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'BARRADO_RLS_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *BARRADO_RLS_OK*) ok "A11 escrita staff negada (42501)";;
  *PASSOU_INDEVIDO*) bad "A11 escrita staff — INSERT passou (RLS furada)";;
  *) bad "A11 escrita staff — erro inesperado: $R";;
esac

# A12 service_role (BYPASSRLS) escreve (-q: suprime tags SET/INSERT do psql)
V=$(P -qtA <<'SQL' | tail -1
SET ROLE service_role;
INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','manual','spike') RETURNING 'GRAVOU';
SQL
)
eq "A12 service_role escreve" "$V" "GRAVOU"

# A13 cron agendado com schedule + timeout explícito no comando
V=$(Pq -c "SELECT schedule || '|' || (command LIKE '%timeout_milliseconds := 150000%')::text || '|' || (command LIKE '%sayerlack-captura-precos%')::text FROM cron.job WHERE jobname='sayerlack-captura-precos-mensal';")
eq "A13 cron mensal agendado" "$V" "0 9 10-12 * *|true|true"

# A14 o COMANDO do job é SQL executável (late-bound: só executar prova) e chama
#     a edge certa com timeout 150000 e body modo=full
P -q -c "$(Pq -c "SELECT command FROM cron.job WHERE jobname='sayerlack-captura-precos-mensal';")"
V=$(Pq -c "SELECT (url LIKE '%/functions/v1/sayerlack-captura-precos')::text || '|' || timeout_ms::text || '|' || (body->>'modo') || '|' || (headers->>'x-cron-secret') FROM net._stub_calls ORDER BY id DESC LIMIT 1;")
eq "A14 comando do job executa e chama a edge" "$V" "true|150000|full|stub-secret"

# A15 config subiu 24 → 960
V=$(Pq -c "SELECT value FROM public.company_config WHERE key='embalagem_preco_stale_horas';")
eq "A15 stale_horas 24→960" "$V" "960"

# A16 idempotência + guard do UPDATE: founder setou '30' manualmente; re-rodar a
#     migration INTEIRA não dá erro e NÃO sobrescreve o ajuste dele
P -q -c "UPDATE public.company_config SET value='30' WHERE key='embalagem_preco_stale_horas';"
P -q -f "$MIG"
V=$(Pq -c "SELECT value FROM public.company_config WHERE key='embalagem_preco_stale_horas';")
eq "A16 re-run idempotente preserva ajuste manual ('30')" "$V" "30"
P -q -c "UPDATE public.company_config SET value='960' WHERE key='embalagem_preco_stale_horas';"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: policy SELECT furada (USING true) → o assert do customer (A9) TEM de acusar
P -q <<'SQL'
DROP POLICY "sku_preco_captura_run_select_staff" ON public.sku_preco_captura_run;
CREATE POLICY "sku_preco_captura_run_select_staff" ON public.sku_preco_captura_run FOR SELECT TO authenticated USING (true);
SQL
V=$(Pq <<'SQL' | tail -1
SET test.uid = '22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
SELECT count(*)::text FROM public.sku_preco_captura_run;
SQL
)
if [ "$V" != "0" ]; then ok "F1 sabotagem da policy DETECTADA (customer passou a ver $V)"; else bad "F1 assert sem dente — policy furada e customer segue vendo 0"; fi
P -q <<'SQL'
DROP POLICY "sku_preco_captura_run_select_staff" ON public.sku_preco_captura_run;
CREATE POLICY "sku_preco_captura_run_select_staff"
  ON public.sku_preco_captura_run
  FOR SELECT TO authenticated
  USING (
    (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))
    OR (SELECT public.has_role((SELECT auth.uid()), 'employee'::public.app_role))
  );
SQL
V=$(Pq <<'SQL' | tail -1
SET test.uid = '22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
SELECT count(*)::text FROM public.sku_preco_captura_run;
SQL
)
eq "F1r policy restaurada (customer volta a ver 0)" "$V" "0"

# F2: dropar o CHECK de disparo → o INSERT inválido TEM de passar (assert A3 perderia o dente)
P -q -c "ALTER TABLE public.sku_preco_captura_run DROP CONSTRAINT sku_preco_captura_run_disparo_check;"
R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','banana','full');
  RAISE NOTICE 'INSERIU_SEM_CHECK';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'AINDA_BARRADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *INSERIU_SEM_CHECK*) ok "F2 sabotagem do CHECK DETECTADA (inválido entrou sem a constraint)";;
  *) bad "F2 assert sem dente — CHECK dropado e o inválido continua barrado: $R";;
esac
P -q <<'SQL'
DELETE FROM public.sku_preco_captura_run WHERE disparo = 'banana';
ALTER TABLE public.sku_preco_captura_run
  ADD CONSTRAINT sku_preco_captura_run_disparo_check CHECK (disparo IN ('cron','manual','reajuste'));
SQL
R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','banana','full');
  RAISE NOTICE 'PASSOU_INDEVIDO';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'BARRADO_CHECK_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *BARRADO_CHECK_OK*) ok "F2r CHECK restaurado";;
  *) bad "F2r CHECK não voltou: $R";;
esac

# F3: policy de INSERT permissiva p/ authenticated → a escrita staff TEM de passar
#     (provando que A11 depende mesmo da AUSÊNCIA de policy de escrita)
P -q -c "CREATE POLICY \"sabotagem_insert\" ON public.sku_preco_captura_run FOR INSERT TO authenticated WITH CHECK (true);"
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid = '11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.sku_preco_captura_run (empresa, disparo, modo) VALUES ('oben','manual','spike');
  RAISE NOTICE 'INSERIU_COM_POLICY';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *INSERIU_COM_POLICY*) ok "F3 sabotagem da escrita DETECTADA (policy permissiva abriu o INSERT)";;
  *) bad "F3 assert sem dente — policy permissiva e INSERT segue barrado: $R";;
esac
P -q <<'SQL'
DROP POLICY "sabotagem_insert" ON public.sku_preco_captura_run;
DELETE FROM public.sku_preco_captura_run WHERE criado_por IS NULL AND disparo='manual' AND modo='spike' AND status='running';
SQL

# F4: UPDATE de config SEM o guard "value='24'" → sobrescreveria o ajuste manual
#     do founder (prova de que o guard da migration importa)
P -q -c "UPDATE public.company_config SET value='30' WHERE key='embalagem_preco_stale_horas';"
# versão SABOTADA do UPDATE da migration (sem o guard "AND value='24'"):
P -q -c "UPDATE public.company_config SET value='960', updated_at=now() WHERE key='embalagem_preco_stale_horas';"
V=$(Pq -c "SELECT value FROM public.company_config WHERE key='embalagem_preco_stale_horas';")
if [ "$V" = "960" ]; then ok "F4 sabotagem do guard DETECTADA (sem guard, '30' virou '960')"; else bad "F4 sem dente — UPDATE sem guard não sobrescreveu ('$V')"; fi
P -q -c "UPDATE public.company_config SET value='960' WHERE key='embalagem_preco_stale_horas';"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

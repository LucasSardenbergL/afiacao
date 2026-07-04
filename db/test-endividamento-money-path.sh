#!/usr/bin/env bash
# Prova PG17 da migration 20260704160000_fin_dividas.sql (F1 endividamento).
# Constraints + CASCADE + trigger de autor + RLS master-only + falsificação.
#   bash db/test-endividamento-money-path.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5460}"
SLUG="endividamento"
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
-- Supabase real: authenticated/anon acessam auth.uid(). Sem isto, o trigger que chama
-- auth.uid() falha com 42501 no schema auth ANTES da RLS → falso positivo no assert de RLS.
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisitos: app_role enum + user_roles (a RLS lê) ──
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260704160000_fin_dividas.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed + grants ──
# master = 333..., não-master (employee) = 222...
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master') ON CONFLICT DO NOTHING;
-- dívida-semente (via postgres, ignora RLS)
INSERT INTO public.fin_dividas(id, company, credor, tipo, principal_contratado, data_contratacao, cp_inclusion_status)
VALUES ('aaaaaaaa-0000-0000-0000-000000000001','oben','Banco Seed','financiamento',100000,'2025-01-01','nao');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_dividas, public.fin_divida_parcelas, public.fin_divida_completude TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

echo "── asserts ──"

# POSITIVO: parcela válida insere; total de parcelas por dívida
P -q -c "INSERT INTO public.fin_divida_parcelas(divida_id, numero_parcela, data_vencimento, valor_amortizacao, valor_juros, valor_total) VALUES ('aaaaaaaa-0000-0000-0000-000000000001',1,'2026-08-01',900,100,1000);" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_divida_parcelas WHERE divida_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A1 parcela válida inserida" "$V" "1"

# TRIGGER: INSERT com updated_by forjado sob auth.uid setado → trigger sobrescreve
P -q -c "SET test.uid='33333333-3333-3333-3333-333333333333';
INSERT INTO public.fin_dividas(id,company,credor,tipo,principal_contratado,data_contratacao,updated_by)
VALUES ('cccccccc-0000-0000-0000-000000000003','colacor','Banco Trig','outro',5000,'2025-06-01','11111111-1111-1111-1111-111111111111');" >/dev/null
UB=$(Pq -c "SELECT updated_by FROM public.fin_dividas WHERE id='cccccccc-0000-0000-0000-000000000003';")
eq "A2 trigger força updated_by = auth.uid (ignora forjado)" "$UB" "33333333-3333-3333-3333-333333333333"

# CASCADE: deletar a dívida-semente apaga suas parcelas
P -q -c "DELETE FROM public.fin_dividas WHERE id='aaaaaaaa-0000-0000-0000-000000000001';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_divida_parcelas WHERE divida_id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A3 ON DELETE CASCADE apaga parcelas" "$V" "0"

# NEGATIVOS (CHECK/UNIQUE) — SQLSTATE esperada + re-raise
neg() { # $1 sql, $2 sqlstate_cond, $3 rótulo
  local R
  R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  $1
  RAISE EXCEPTION 'NAO_BARROU';
EXCEPTION
  WHEN $2 THEN RAISE NOTICE 'REJEITADO_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in *REJEITADO_OK*) ok "$3" ;; *) bad "$3 — veio: $R" ;; esac
}

neg "INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('oben','X','financiamento',0,'2025-01-01');" "check_violation" "A4 principal_contratado>0"
neg "INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('marte','X','financiamento',10,'2025-01-01');" "check_violation" "A5 company no enum"
neg "INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('oben','X','leasing',10,'2025-01-01');" "check_violation" "A6 tipo no enum"
neg "INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao,cp_inclusion_status) VALUES ('oben','X','outro',10,'2025-01-01','talvez');" "check_violation" "A7 cp_inclusion_status no enum"
neg "INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('oben','   ','outro',10,'2025-01-01');" "check_violation" "A8 credor não-vazio"

# parcela: valor_total>0 e UNIQUE
P -q -c "INSERT INTO public.fin_dividas(id,company,credor,tipo,principal_contratado,data_contratacao) VALUES ('bbbbbbbb-0000-0000-0000-000000000002','oben','Banco P','financiamento',1,'2025-01-01');" >/dev/null
neg "INSERT INTO public.fin_divida_parcelas(divida_id,numero_parcela,data_vencimento,valor_amortizacao,valor_total) VALUES ('bbbbbbbb-0000-0000-0000-000000000002',1,'2026-08-01',5,0);" "check_violation" "A9 valor_total>0"
neg "INSERT INTO public.fin_divida_parcelas(divida_id,numero_parcela,data_vencimento,valor_amortizacao,valor_total) VALUES ('bbbbbbbb-0000-0000-0000-000000000002',0,'2026-08-01',5,5);" "check_violation" "A10 numero_parcela>0"
P -q -c "INSERT INTO public.fin_divida_parcelas(divida_id,numero_parcela,data_vencimento,valor_amortizacao,valor_total) VALUES ('bbbbbbbb-0000-0000-0000-000000000002',7,'2026-08-01',5,5);" >/dev/null
neg "INSERT INTO public.fin_divida_parcelas(divida_id,numero_parcela,data_vencimento,valor_amortizacao,valor_total) VALUES ('bbbbbbbb-0000-0000-0000-000000000002',7,'2026-09-01',5,5);" "unique_violation" "A11 UNIQUE (divida_id,numero_parcela)"

# RLS (SET ROLE authenticated + GUC) — a dívida-semente foi apagada; usar a 'bbbb' existente
NM=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dividas;" | tail -1)
MS=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dividas;" | tail -1)
eq "A12 RLS: não-master SELECT vê 0" "$NM" "0"
if [ "$MS" -ge 1 ] 2>/dev/null; then ok "A13 RLS: master SELECT vê ($MS)"; else bad "A13 RLS: master devia ver >=1, veio $MS"; fi

# RLS INSERT: não-master → 42501; master → ok
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('oben','Hack','outro',9,'2025-01-01');
  RAISE EXCEPTION 'NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_INSERT_BARRADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *RLS_INSERT_BARRADO*) ok "A14 RLS: não-master INSERT → 42501" ;; *) bad "A14 RLS INSERT — veio: $R" ;; esac

P -q -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
INSERT INTO public.fin_dividas(id,company,credor,tipo,principal_contratado,data_contratacao) VALUES ('dddddddd-0000-0000-0000-000000000004','oben','Master OK','outro',9,'2025-01-01');" >/dev/null
MI=$(Pq -c "SELECT count(*) FROM public.fin_dividas WHERE id='dddddddd-0000-0000-0000-000000000004';")
eq "A15 RLS: master INSERT passa" "$MI" "1"

# ── ZONA 5 — FALSIFICAÇÃO ──
echo "── falsificação ──"

# F1: sabotar o CHECK valor_total>0 → o A9 (rejeição) deve parar de barrar
P -q -c "ALTER TABLE public.fin_divida_parcelas DROP CONSTRAINT fin_divida_parcelas_valor_total_check;" >/dev/null
if P -q -c "INSERT INTO public.fin_divida_parcelas(divida_id,numero_parcela,data_vencimento,valor_amortizacao,valor_total) VALUES ('bbbbbbbb-0000-0000-0000-000000000002',99,'2026-08-01',5,-5);" >/dev/null 2>&1; then
  ok "F1 sem o CHECK, valor_total=-5 entrou (A9 tinha dente)"
else
  bad "F1 droppei o CHECK e o INSERT AINDA falhou → A9 é fraco"
fi
# restaura: apaga a linha inválida ANTES de re-adicionar o constraint
P -q -c "DELETE FROM public.fin_divida_parcelas WHERE divida_id='bbbbbbbb-0000-0000-0000-000000000002' AND numero_parcela=99;" >/dev/null
P -q -c "ALTER TABLE public.fin_divida_parcelas ADD CONSTRAINT fin_divida_parcelas_valor_total_check CHECK (valor_total > 0);" >/dev/null

# F2: sabotar a RLS SELECT → não-master passa a ver
P -q <<'SQL'
DROP POLICY IF EXISTS fin_dividas_select_master ON public.fin_dividas;
CREATE POLICY fin_dividas_select_master ON public.fin_dividas FOR SELECT USING (true);
SQL
NM2=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dividas;" | tail -1)
if [ "$NM2" -ge 1 ] 2>/dev/null; then ok "F2 RLS furada: não-master passou a ver ($NM2) (A12 tinha dente)"; else bad "F2 furei a RLS e não-master ainda vê 0 → A12 é fraco"; fi
# restaura re-aplicando a migration (o DO block dropa+recria as policies — idempotente)
P -q -f "$MIG"
NM3=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_dividas;" | tail -1)
eq "F2b RLS restaurada: não-master volta a ver 0" "$NM3" "0"

# F3: furar a WITH CHECK da write policy → o INSERT do não-master (A14) deve passar
# (prova que A14 barrou pela RLS, não pelo permission-denied do trigger no schema auth)
P -q <<'SQL'
DROP POLICY IF EXISTS fin_dividas_write_master ON public.fin_dividas;
CREATE POLICY fin_dividas_write_master ON public.fin_dividas USING (true) WITH CHECK (true);
SQL
if P -q -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
INSERT INTO public.fin_dividas(company,credor,tipo,principal_contratado,data_contratacao) VALUES ('oben','Hack2','outro',9,'2025-01-01');" >/dev/null 2>&1; then
  ok "F3 write policy furada: não-master INSERT passou (A14 é a RLS, não o trigger)"
else
  bad "F3 furei a write policy e o INSERT do não-master AINDA falhou → A14 não prova a RLS"
fi
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

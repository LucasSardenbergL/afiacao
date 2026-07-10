#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: get_carteira_saude() v2                                 ║
# ║  Migration 20260710012337_carteira_saude_eligible_e_efeito_mensal.sql          ║
# ║  (1) sync/coverage medem só a carteira operacional (eligible=true)             ║
# ║  (2) cron mensal cai pro EFEITO (max created_at do snapshot) quando o purge    ║
# ║      do cron.job_run_details expurgou o run — sem vazar pros nightly           ║
# ║  (3) gate SECURITY DEFINER: NULL p/ anon e p/ não-staff                        ║
# ║                                                                                ║
# ║  Rode:  bash db/test-carteira-saude-eligible-efeito.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  Lei de Ferro: 1) migration REAL  2) negativo com condição esperada            ║
# ║                3) FALSIFICAÇÃO (sabota → exige vermelho → restaura).           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="carteira-saude-eligible"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "/tmp/fn-${SLUG}"-*.sql 2>/dev/null || true; }
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
# ZONA 1 — PRÉ-REQUISITOS: enum/role, has_role (semântica da prod), tabelas lidas
# (cron.job / cron.job_run_details já vêm do stubs-supabase.sql)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
$f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

CREATE TABLE public.carteira_assignments (
  customer_user_id uuid,
  eligible boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz
);
CREATE TABLE public.farmer_client_scores  (customer_user_id uuid);
CREATE TABLE public.customer_visit_scores (customer_user_id uuid);
CREATE TABLE public.carteira_positivacao_snapshot (created_at timestamptz);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260710012337_carteira_saude_eligible_e_efeito_mensal.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
#   staff aaaa… (employee) · cust bbbb… (customer)
#   elegíveis: c1(fcs+cvs) c2(fcs+cvs) c3(fcs, SEM cvs) — synced há 5h
#   não-elegíveis: c4 (last_synced_at NULL → stale se contasse)
#                  c5 (synced AGORA → seria o max se contasse)
#   fcs extra: c9 fora da carteira (não conta)
#   crons: 4 da lista + 1 fora; run só do rebuild (succeeded há 10h)
#   snapshot: efeito há 9d (≈216h) e há 40d — run do mensal NÃO existe (purgado)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.user_roles VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','employee'),
  ('bbbbbbbb-0000-0000-0000-000000000001','customer');

INSERT INTO public.carteira_assignments (customer_user_id, eligible, last_synced_at) VALUES
  ('00000000-0000-0000-0000-000000000001', true,  now() - interval '5 hours'),
  ('00000000-0000-0000-0000-000000000002', true,  now() - interval '5 hours'),
  ('00000000-0000-0000-0000-000000000003', true,  now() - interval '5 hours'),
  ('00000000-0000-0000-0000-000000000004', false, NULL),
  ('00000000-0000-0000-0000-000000000005', false, now());

INSERT INTO public.farmer_client_scores VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000009');

INSERT INTO public.customer_visit_scores VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');

INSERT INTO cron.job (jobid, jobname, active) VALUES
  (1, 'carteira-rebuild-nightly',             true),
  (2, 'scoring-recalc-batch-nightly',         true),
  (3, 'visit-score-recalc-batch-nightly',     true),
  (4, 'carteira-positivacao-snapshot-mensal', true),
  (5, 'fin-sync-cp-2x',                       true);

INSERT INTO cron.job_run_details (jobid, runid, status, return_message, start_time) VALUES
  (1, 101, 'succeeded', NULL, now() - interval '10 hours');

INSERT INTO public.carteira_positivacao_snapshot (created_at) VALUES
  (now() - interval '9 days'),
  (now() - interval '40 days');
SQL

# helper: campo do cron <jobname> a partir do resultado da RPC (como staff)
cron_field() { # $1 jobname  $2 expr jsonb sobre o elemento c
  Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001';
         SELECT coalesce(${2}, '(null)')
         FROM jsonb_array_elements(public.get_carteira_saude()->'crons') c
         WHERE c->>'jobname' = '${1}';" | tail -1
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── gate (SECURITY DEFINER) ──"
V=$(Pq -c "SELECT public.get_carteira_saude() IS NULL;" | tail -1)
eq "A1 anon (uid NULL) → NULL" "$V" "t"
V=$(Pq -c "SET test.uid='bbbbbbbb-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude() IS NULL;" | tail -1)
eq "A2 customer (não-staff) → NULL" "$V" "t"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude() IS NOT NULL;" | tail -1)
eq "A3 employee → resultado" "$V" "t"

echo "── score_coverage (eligible-only) ──"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'score_coverage'->>'carteira';" | tail -1)
eq "A4 carteira = só elegíveis" "$V" "3"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'score_coverage'->>'fcs_clientes';" | tail -1)
eq "A5 fcs_clientes = elegíveis com farmer score" "$V" "3"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'score_coverage'->>'cvs_clientes';" | tail -1)
eq "A6 cvs_clientes = elegíveis com visit score" "$V" "2"

echo "── sync (eligible-only) ──"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'sync'->>'stale_count';" | tail -1)
eq "A7 stale_count ignora não-elegível NULL" "$V" "0"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001';
           SELECT CASE WHEN (public.get_carteira_saude()->'sync'->>'age_hours')::numeric BETWEEN 4.9 AND 5.1
                       THEN 'ok' ELSE 'ERR:' || (public.get_carteira_saude()->'sync'->>'age_hours') END;" | tail -1)
eq "A8 max_last_synced_at ignora não-elegível de agora (age≈5h)" "$V" "ok"

echo "── crons (fallback por efeito só no mensal) ──"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT jsonb_array_length(public.get_carteira_saude()->'crons');" | tail -1)
eq "A9 só os 4 crons da lista" "$V" "4"
V=$(cron_field 'carteira-rebuild-nightly' "c->>'last_status'")
eq "A10 rebuild usa o run real (succeeded)" "$V" "succeeded"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_status'")
eq "A11 mensal sem run + efeito → succeeded (fallback)" "$V" "succeeded"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' \
  "CASE WHEN (c->>'age_hours')::numeric BETWEEN 215 AND 217 THEN 'ok' ELSE 'ERR:' || (c->>'age_hours') END")
eq "A12 mensal reporta idade do efeito MAIS RECENTE (≈216h, não 40d)" "$V" "ok"
V=$(cron_field 'scoring-recalc-batch-nightly' "c->>'last_status'")
eq "A13 nightly sem run NÃO herda o fallback (null)" "$V" "(null)"

# A14: run FAILED recente do mensal VENCE o efeito (falha real não é mascarada)
P -q -c "INSERT INTO cron.job_run_details (jobid, runid, status, return_message, start_time)
         VALUES (4, 401, 'failed', 'boom-mensal', now() - interval '1 hour');"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_status'")
eq "A14a mensal com run failed → failed (efeito não mascara)" "$V" "failed"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_error'")
eq "A14b last_error propagado" "$V" "boom-mensal"
P -q -c "DELETE FROM cron.job_run_details WHERE runid = 401;"

# A15: sem run E sem efeito → 'nunca rodou' verdadeiro (null/null)
P -q -c "TRUNCATE public.carteira_positivacao_snapshot;"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_status'")
eq "A15a sem efeito → last_status null" "$V" "(null)"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_run_at'")
eq "A15b sem efeito → last_run_at null" "$V" "(null)"
P -q -c "INSERT INTO public.carteira_positivacao_snapshot (created_at)
         VALUES (now() - interval '9 days'), (now() - interval '40 days');"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota a migration → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: remove o filtro eligible (regressão pra v1) → A4 tem que divergir de 3
SAB1="/tmp/fn-${SLUG}-f1.sql"
perl -0pe 's/WHERE ca\.eligible\s+AND /WHERE /g; s/\n\s*WHERE eligible\n/\n/g; s/carteira_assignments WHERE eligible\)/carteira_assignments)/g' "$MIG" > "$SAB1"
if grep -qE 'WHERE (ca\.)?eligible' "$SAB1"; then bad "F1 sabotagem não removeu o filtro (perl falhou)"; fi
P -q -f "$SAB1"
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'score_coverage'->>'carteira';" | tail -1)
if [ "$V" = "3" ]; then bad "F1 SEM DENTE — sabotei o eligible e A4 seguiu 3"; else ok "F1 sabotagem detectada (carteira=$V ≠ 3 → assert tem dente)"; fi
P -q -f "$MIG"   # restaura a versão verdadeira
V=$(Pq -c "SET test.uid='aaaaaaaa-0000-0000-0000-000000000001'; SELECT public.get_carteira_saude()->'score_coverage'->>'carteira';" | tail -1)
eq "F1-restore migration real de volta (carteira=3)" "$V" "3"

# F2: mata o fallback por efeito (effect_at ← NULL) → A11 tem que sair de 'succeeded'
SAB2="/tmp/fn-${SLUG}-f2.sql"
perl -0pe 's/max\(s\.created_at\) AS effect_at/NULL::timestamptz AS effect_at/' "$MIG" > "$SAB2"
if grep -q 'max(s.created_at)' "$SAB2"; then bad "F2 sabotagem não trocou o effect_at (perl falhou)"; fi
P -q -f "$SAB2"
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_status'")
if [ "$V" = "succeeded" ]; then bad "F2 SEM DENTE — matei o fallback e A11 seguiu succeeded"; else ok "F2 sabotagem detectada (mensal=$V → assert tem dente)"; fi
P -q -f "$MIG"   # restaura
V=$(cron_field 'carteira-positivacao-snapshot-mensal' "c->>'last_status'")
eq "F2-restore migration real de volta (mensal=succeeded)" "$V" "succeeded"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

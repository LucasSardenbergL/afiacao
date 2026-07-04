#!/usr/bin/env bash
# PROVA PG17 — gate da RPC claim_nfe_efetivacao_lock (REVOKE por nome vs só FROM PUBLIC).
# Replica o DEFAULT PRIVILEGE do Supabase (grant EXECUTE a anon/authenticated) — SEM isto o
# harness dá falso-verde no gate (foi o que aconteceu na 1ª prova).
# bash db/test-claim-nfe-efetivacao-lock-grants.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5464}"
SLUG="claim-nfe-grants"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

FN="public.claim_nfe_efetivacao_lock(uuid,timestamptz,timestamptz)"
haspriv() { Pq -c "SELECT has_function_privilege('$1','$FN','EXECUTE');"; }

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-req + DEFAULT PRIVILEGE do Supabase (a peça que faltava) ──
P -q <<'SQL'
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), efetivacao_lock_at timestamptz);
-- Supabase concede EXECUTE em TODA function nova de public a esses roles (default privilege).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL

# ── ZONA 2 — migration original (cria a fn + só REVOKE FROM PUBLIC) + corretiva (revoke por nome) ──
MIG_ORIG="$REPO_ROOT/supabase/migrations/20260704130000_claim_nfe_efetivacao_lock.sql"
MIG_FIX="$REPO_ROOT/supabase/migrations/20260704140000_claim_nfe_efetivacao_lock_revoke_grants.sql"
P -q -f "$MIG_ORIG"
P -q -f "$MIG_FIX"
echo "migrations aplicadas: 130000 (original) + 140000 (corretiva)"

echo "── asserts (gate) ──"
eq "A1 service_role EXECUTE (edge chama)" "$(haspriv service_role)" "t"
eq "N1 authenticated SEM EXECUTE"         "$(haspriv authenticated)" "f"
eq "N2 anon SEM EXECUTE"                  "$(haspriv anon)" "f"

# ── ZONA 5 — FALSIFICAÇÃO: só a original (REVOKE FROM PUBLIC) deixa o buraco aberto ──
echo "── falsificação ──"
P -q -c "DROP FUNCTION public.claim_nfe_efetivacao_lock(uuid,timestamptz,timestamptz);" >/dev/null
P -q -f "$MIG_ORIG"   # recria fresh → default privilege reconcede a anon/authenticated; original só tira PUBLIC
eq "F1 só FROM PUBLIC deixa authenticated com EXECUTE (o bug real que passou)" "$(haspriv authenticated)" "t"
P -q -f "$MIG_FIX"    # aplica o corretivo
eq "F2 corretivo (revoke por nome) barra authenticated" "$(haspriv authenticated)" "f"
eq "F2b e anon"                                          "$(haspriv anon)" "f"
eq "F2c service_role segue podendo"                      "$(haspriv service_role)" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# PROVA PG17 — RPC claim_nfe_efetivacao_lock (claim atômico do lock de efetivação de NF-e).
# bash db/test-claim-nfe-efetivacao-lock.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="claim-nfe-lock"
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

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-requisito: nfe_recebimentos (só o que a RPC toca) ──
P -q <<'SQL'
CREATE TABLE public.nfe_recebimentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status varchar DEFAULT 'pendente',
  efetivacao_lock_at timestamptz
);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260704130000_claim_nfe_efetivacao_lock.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed: 3 rows com estados de lock distintos ──
P -q <<'SQL'
INSERT INTO public.nfe_recebimentos(id, efetivacao_lock_at) VALUES
 ('11111111-1111-1111-1111-111111111111', NULL),                    -- livre
 ('22222222-2222-2222-2222-222222222222', now() - interval '6 min'),-- expirado (< cutoff 5min)
 ('33333333-3333-3333-3333-333333333333', now());                   -- ativo (>= cutoff)
GRANT EXECUTE ON FUNCTION public.claim_nfe_efetivacao_lock(uuid, timestamptz, timestamptz) TO service_role;
SQL

echo "── asserts ──"
# retorna o nº de linhas que a RPC devolveu (1 = claimou, 0 = barrado). cutoff = now()-5min.
claim() { Pq -c "SELECT count(*) FROM public.claim_nfe_efetivacao_lock('$1'::uuid, now(), now() - interval '5 minutes');"; }
locked() { Pq -c "SELECT efetivacao_lock_at IS NOT NULL FROM public.nfe_recebimentos WHERE id='$1';"; }

# A1 (livre → claima e grava o lock)
eq "A1 lock livre claima" "$(claim 11111111-1111-1111-1111-111111111111)" "1"
eq "A1 gravou o lock"     "$(locked 11111111-1111-1111-1111-111111111111)" "t"

# N1 (concorrência): a MESMA linha, agora travada (lock≈now > cutoff) → 2º concorrente NÃO claima
eq "N1 lock ativo barra (2º concorrente)" "$(claim 11111111-1111-1111-1111-111111111111)" "0"

# A2 (expirado → reclaim após TTL)
eq "A2 lock expirado reclaima" "$(claim 22222222-2222-2222-2222-222222222222)" "1"

# A3 (lock ativo pré-existente barra)
eq "A3 lock ativo barra" "$(claim 33333333-3333-3333-3333-333333333333)" "0"

# A4 (gate): authenticated NÃO pode EXECUTE a RPC (REVOKE de PUBLIC, só service_role)
GATE=$(P -tA 2>&1 <<'SQL' || true
SET ROLE authenticated;
SELECT count(*) FROM public.claim_nfe_efetivacao_lock('11111111-1111-1111-1111-111111111111'::uuid, now(), now());
SQL
)
case "$GATE" in
  *"permission denied"*) ok "A4 gate: authenticated barrado (permission denied)" ;;
  *) bad "A4 gate — esperava permission denied, veio [$GATE]" ;;
esac

# ── ZONA 5 — FALSIFICAÇÃO: RPC sem o predicado de cutoff → fura o lock (prova o dente do WHERE) ──
echo "── falsificação ──"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.claim_nfe_efetivacao_lock(p_nfe_id uuid, p_lock_ts timestamptz, p_cutoff timestamptz)
RETURNS TABLE (id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $f$
  UPDATE public.nfe_recebimentos AS n SET efetivacao_lock_at = p_lock_ts WHERE n.id = p_nfe_id RETURNING n.id;
$f$;
SQL
# row 33333333 está com lock ATIVO; a versão sabotada ignora o cutoff → claima (=1)
eq "F1 sem predicado de cutoff o lock é furado" "$(claim 33333333-3333-3333-3333-333333333333)" "1"
# restaura a versão verdadeira e reprova o bloqueio
P -q -f "$MIG" >/dev/null
P -q -c "UPDATE public.nfe_recebimentos SET efetivacao_lock_at=now() WHERE id='33333333-3333-3333-3333-333333333333';" >/dev/null
eq "F2 restaurada volta a barrar lock ativo" "$(claim 33333333-3333-3333-3333-333333333333)" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

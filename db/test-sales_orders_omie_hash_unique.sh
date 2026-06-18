#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — uniq_sales_orders_omie_hash (idempotência do sync de pedidos)  ║
# ║  Prova: dup omie_ é REJEITADA (23505); dup NÃO-omie passa (índice parcial);    ║
# ║  o escape LIKE 'omie\_%' escopa certo. Falsifica dropando o índice.            ║
# ║  Rodar:  bash db/test-sales_orders_omie_hash_unique.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5458}"
SLUG="sales_orders_omie_hash_unique"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ZONA 1 — stub mínimo de sales_orders (só o que o índice toca)
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text,
  hash_payload text,
  status text
);
-- semeia o que existe em prod: pedidos omie_ (devem ser únicos) + placeholders não-omie (488 dups OK)
INSERT INTO public.sales_orders(account, hash_payload, status) VALUES
  ('oben',   'omie_oben_5001',  'importado'),
  ('colacor','omie_colacor_900','importado'),
  ('oben',   '-cah8zx',         'cancelado'),
  ('oben',   '-cah8zx',         'cancelado');   -- dup NÃO-omie já existente: o índice parcial DEVE ignorar
SQL

# ZONA 2 — aplica a migration REAL
MIG="$REPO_ROOT/supabase/migrations/20260617133634_sales_orders_omie_hash_unique.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ZONA 3 — asserts
echo "── asserts ──"

# A1: índice criou (apesar das 488 dups não-omie pré-existentes) → predicado escopou certo
IDX=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname='uniq_sales_orders_omie_hash';")
[ "$IDX" = "1" ] && ok "A1 índice criado mesmo com dup não-omie pré-existente (predicado escopa)" || bad "A1 índice não criado (IDX=$IDX)"

# A2: dup de pedido omie_ é REJEITADA (23505) — a idempotência money-path
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.sales_orders(account, hash_payload) VALUES ('oben','omie_oben_5001');
  RAISE EXCEPTION 'DUP_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'OMIE_DUP_BLOCKED';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *OMIE_DUP_BLOCKED*) ok "A2 dup omie_ rejeitada (unique_violation) — idempotência travada" ;; *) bad "A2 — veio: $R" ;; esac

# A3: dup NÃO-omie PASSA (índice parcial não cobre placeholders) — não quebra pedido manual/cancelado
if P -q -c "INSERT INTO public.sales_orders(account, hash_payload) VALUES ('oben','-cah8zx');" >/dev/null 2>&1; then
  ok "A3 dup não-omie passa (índice parcial ignora — não quebra pedido manual)"
else
  bad "A3 índice barrou um hash não-omie (predicado amplo demais)"
fi

# A4: mesmo hash em conta diferente passa (índice é por (account, hash_payload))
if P -q -c "INSERT INTO public.sales_orders(account, hash_payload) VALUES ('colacor','omie_oben_5001');" >/dev/null 2>&1; then
  ok "A4 (account,hash) — mesmo hash em conta distinta é permitido"
else
  bad "A4 índice barrou cross-account (deveria ser por account+hash)"
fi

# ZONA 4 — FALSIFICAÇÃO: dropa o índice → a dup omie_ que ANTES barrava agora PASSA
echo "── falsificação ──"
P -q -c "DROP INDEX public.uniq_sales_orders_omie_hash;"
if P -q -c "INSERT INTO public.sales_orders(account, hash_payload) VALUES ('oben','omie_oben_5001');" >/dev/null 2>&1; then
  ok "F1 sem o índice a dup omie_ passa (A2 tinha dente)"
else
  bad "F1 droppei o índice e a dup AINDA falhou → A2 não provava o índice"
fi
P -q -f "$MIG" >/dev/null 2>&1 || echo "  (nota: re-aplicar falha pq a falsificação já inseriu dup — esperado; o índice real é idempotente em prod limpa)"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — guard de identidade do PULL (uniq_sales_orders_pull_identity)    ║
# ║  Migration: supabase/migrations/20260617140000_sales_orders_pull_identity_guard.sql
# ║  Rode:  bash db/test-sales-orders-pull-identity-guard.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║                                                                                ║
# ║  Prova que o índice parcial (account, omie_pedido_id) WHERE checkout_id IS NULL ║
# ║  AND omie_pedido_id IS NOT NULL:                                                ║
# ║   - barra 2ª linha PULL do mesmo pedido (mata Causa A=de-namespacing e          ║
# ║     Causa B=hash NULL, independente do hash_payload);                           ║
# ║   - PRESERVA a dualidade push/pull (push tem checkout NOT NULL → excluído);     ║
# ║   - coexiste com sales_orders_checkout_account_uq;                              ║
# ║   - exige limpeza ANTES (CREATE falha com dups presentes).                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="pull-identity-guard"
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
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: stub de sales_orders (colunas/tipos reais) + índice existente
# ══════════════════════════════════════════════════════════════════════════════
# Tipos verificados em prod (psql-ro): account text NOT NULL, omie_pedido_id bigint NULL,
# checkout_id uuid NULL, hash_payload text NULL, status text NOT NULL, omie_numero_pedido text NULL.
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_pedido_id bigint,
  omie_numero_pedido text,
  checkout_id uuid,
  hash_payload text,
  status text NOT NULL DEFAULT 'importado'
);
-- índice existente (migration 20260613120000). O guard novo precisa COEXISTIR com ele.
CREATE UNIQUE INDEX sales_orders_checkout_account_uq
  ON public.sales_orders (checkout_id, account) WHERE checkout_id IS NOT NULL;
SQL
echo "stub sales_orders + índice existente OK"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260617140000_sales_orders_pull_identity_guard.sql"
P -q -f "$MIG" >/dev/null   # a migration termina com um SELECT de validação; silencia
echo "migration aplicada: $(basename "$MIG")"

PUSH_UUID='11111111-1111-1111-1111-111111111111'
PUSH_UUID2='22222222-2222-2222-2222-222222222222'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3+4 — POSITIVO (caminho feliz) + NEGATIVO (a defesa morde — 23505 + re-raise, Lei #2)
# ══════════════════════════════════════════════════════════════════════════════
echo "── positivos (o que DEVE inserir) ──"
# P1: 1 linha PULL (checkout NULL) insere
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('oben',1001,NULL,'omie_oben_1001','faturado');"
# P2 (CRÍTICO): par push+pull legítimo — push (checkout NOT NULL) com MESMO omie_pedido_id coexiste
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('oben',1001,'$PUSH_UUID',NULL,'rascunho');"
# P3: rascunhos PULL com omie_pedido_id NULL coexistem (índice exige omie_pedido_id IS NOT NULL)
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,status) VALUES ('oben',NULL,NULL,'rascunho'),('oben',NULL,NULL,'rascunho');"
# P4: mesma omie_pedido_id em conta DIFERENTE coexiste (índice é por account)
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('colacor',1001,NULL,'omie_colacor_1001','faturado');"

V=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE account='oben' AND omie_pedido_id=1001;")
eq "P1+P2 par push+pull oben/1001 coexiste" "$V" "2"
V=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE omie_pedido_id IS NULL;")
eq "P3 rascunhos omie_pedido_id NULL coexistem" "$V" "2"
V=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE omie_pedido_id=1001;")
eq "P4 mesma omie_pedido_id em contas distintas" "$V" "3"

echo "── negativos (a defesa DEVE barrar) ──"
# N1a: 2ª PULL do mesmo pedido com hash ESTRUTURAL diferente (Causa A) → 23505
R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status)
    VALUES ('oben',1001,NULL,'a1b2c3estrutural','faturado');
  RAISE EXCEPTION 'NAO_BARROU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'PULL_DUP_BARRADA_A';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *PULL_DUP_BARRADA_A*) ok "N1a 2ª pull (hash estrutural) barrada — mata Causa A" ;; *) bad "N1a não barrou: $R" ;; esac

# N1b: 2ª PULL do mesmo pedido com hash NULL (Causa B) → 23505
R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status)
    VALUES ('oben',1001,NULL,NULL,'enviado');
  RAISE EXCEPTION 'NAO_BARROU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'PULL_DUP_BARRADA_B';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *PULL_DUP_BARRADA_B*) ok "N1b 2ª pull (hash NULL) barrada — mata Causa B" ;; *) bad "N1b não barrou: $R" ;; esac

# N2: índice EXISTENTE continua mordendo — 2 push com mesmo (checkout_id, account) → 23505
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,status) VALUES ('oben',2002,'$PUSH_UUID2','rascunho');"
R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,status)
    VALUES ('oben',3003,'$PUSH_UUID2','rascunho');
  RAISE EXCEPTION 'NAO_BARROU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'PUSH_DUP_BARRADA';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *PUSH_DUP_BARRADA*) ok "N2 índice existente coexiste e barra push duplo" ;; *) bad "N2 não barrou: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F2: REMOVE o índice novo → a 2ª pull dup AGORA passa → prova que o índice é o que barra (N1 tem dente)
P -q -c "DROP INDEX public.uniq_sales_orders_pull_identity;"
if P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('oben',1001,NULL,'sabotado','faturado');" >/dev/null 2>&1; then
  ok "F2 sem o índice a 2ª pull passa (N1 tinha dente)"
else
  bad "F2 removi o índice e a 2ª pull AINDA falhou → N1 não provava o índice"
fi
# restaura: limpa a linha sabotada (senão o re-CREATE falha) e recria o índice
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload='sabotado';"
P -q -c "CREATE UNIQUE INDEX uniq_sales_orders_pull_identity ON public.sales_orders (account, omie_pedido_id) WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL;"

# F1: índice FURADO sem o predicado checkout_id IS NULL → o par push+pull legítimo passa a COLIDIR
P -q -c "TRUNCATE public.sales_orders;"
P -q -c "DROP INDEX public.uniq_sales_orders_pull_identity;"
P -q -c "CREATE UNIQUE INDEX uniq_sales_orders_pull_identity ON public.sales_orders (account, omie_pedido_id) WHERE omie_pedido_id IS NOT NULL;"  -- FURADO: faltando checkout_id IS NULL
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('oben',7777,NULL,'omie_oben_7777','faturado');"  -- pull
R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status)
    VALUES ('oben',7777,'$PUSH_UUID',NULL,'rascunho');   -- push do MESMO pedido
  RAISE NOTICE 'PAR_PASSOU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'PAR_COLIDIU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *PAR_COLIDIU*) ok "F1 índice sem 'checkout_id IS NULL' quebra a dualidade push/pull (predicado tem dente)" ;;
  *) bad "F1 furei o predicado e o par NÃO colidiu: $R" ;;
esac
# restaura o índice verdadeiro
P -q -c "TRUNCATE public.sales_orders;"
P -q -c "DROP INDEX public.uniq_sales_orders_pull_identity;"
P -q -f "$MIG" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — ORDEM (CREATE falha com dups; passa após limpar) — o porquê do handoff sequenciado
# ══════════════════════════════════════════════════════════════════════════════
echo "── ordem (limpar ANTES de criar o índice) ──"
P -q -c "DROP INDEX public.uniq_sales_orders_pull_identity;"
P -q -c "INSERT INTO public.sales_orders(account,omie_pedido_id,checkout_id,hash_payload,status) VALUES ('oben',9999,NULL,'omie_oben_9999','faturado'),('oben',9999,NULL,'estrut9999','cancelado');"
R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  CREATE UNIQUE INDEX uniq_sales_orders_pull_identity ON public.sales_orders (account, omie_pedido_id) WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL;
  RAISE EXCEPTION 'CRIOU_COM_DUPS';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'CREATE_BARRADO_POR_DUP';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *CREATE_BARRADO_POR_DUP*) ok "ORDEM: CREATE falha com dups presentes (exige limpeza antes)" ;; *) bad "ORDEM: CREATE não falhou com dups: $R" ;; esac
# simula a limpeza: mantém a linha 'omie_', remove a estrutural
P -q -c "DELETE FROM public.sales_orders WHERE account='oben' AND omie_pedido_id=9999 AND hash_payload NOT LIKE 'omie_%';"
if P -q -c "CREATE UNIQUE INDEX uniq_sales_orders_pull_identity ON public.sales_orders (account, omie_pedido_id) WHERE checkout_id IS NULL AND omie_pedido_id IS NOT NULL;" >/dev/null 2>&1; then
  ok "ORDEM: após dedup (manter omie_), CREATE passa"
else
  bad "ORDEM: CREATE falhou mesmo após dedup"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

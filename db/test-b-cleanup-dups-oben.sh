#!/usr/bin/env bash
# HARNESS PG17 — prova do cleanup #B v2 (global, lock, sph DELETE, push-metadata, pid-null, postcondition).
#   bash db/test-b-cleanup-dups-oben.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Lei de Ferro: aplica a migration REAL; asserts negativos c/ SQLSTATE+re-raise; falsifica → vermelho.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5456}"
SLUG="b-cleanup-dups-oben"
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

echo "═══ setup PG17 :$PORT ═══"

# ══ ZONA 1 — schema stub + SEED do estado SUJO (cleanup é DML → dados ANTES da migration) ══
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  hash_payload text,
  omie_pedido_id text,
  omie_numero_pedido text,
  status text,
  total numeric,
  customer_user_id uuid,
  checkout_id uuid,
  origem text,
  atendimento_id uuid,
  created_at timestamptz DEFAULT now()
);
-- índice REAL de prod (sem ele o harness não pegaria o blocker do push-metadata):
CREATE UNIQUE INDEX sales_orders_checkout_account_uq ON public.sales_orders (checkout_id, account) WHERE checkout_id IS NOT NULL;
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE
);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL
);

-- A) dup do bug (oben): A1 omie_ canônica (faturado) + A2 de-namespaced + order_item em A2 + sph em A1 e A2
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','oben','omie_oben_1001','1001','faturado',100),
  ('aaaaaaaa-0000-0000-0000-000000000002','oben','-abc1','1001','cancelado',100);
INSERT INTO public.order_items (id, sales_order_id) VALUES
  ('aaaaaaaa-1111-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002');
INSERT INTO public.sales_price_history (id, sales_order_id) VALUES
  ('aaaaaaaa-2222-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001'),  -- canon (preserva)
  ('aaaaaaaa-2222-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002');  -- loser (deleta)
-- B) PUSH/SYNC legítimo (oben): B1 omie_ + B2 PUSH (hash NULL)
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001','oben','omie_oben_1002','1002','faturado',200),
  ('bbbbbbbb-0000-0000-0000-000000000002','oben',NULL,'1002','enviado',200);
-- C) limpo (oben): só 1 omie_
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('cccccccc-0000-0000-0000-000000000001','oben','omie_oben_1003','1003','faturado',300);
-- D) de-namespaced ÓRFÃ (oben, SEM par omie_) — NÃO deve ser deletada (precisão > recall)
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('dddddddd-0000-0000-0000-000000000001','oben','-xyz9','1004','cancelado',400);
-- E) colacor com a MESMA assinatura: cleanup GLOBAL limpa E2
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('eeeeeeee-0000-0000-0000-000000000001','colacor','omie_colacor_1005','1005','faturado',500),
  ('eeeeeeee-0000-0000-0000-000000000002','colacor','-cde5','1005','cancelado',500);
-- F) CROSS-ACCOUNT: F1 omie_ oben pid 2002 + F2 de-namespaced colacor pid 2002 (par só em outra conta) → F2 fica
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('ffffffff-0000-0000-0000-000000000001','oben','omie_oben_2002','2002','faturado',600),
  ('ffffffff-0000-0000-0000-000000000002','colacor','-fgh2','2002','cancelado',600);
-- G) PUSH-METADATA: G2 de-namespaced (web_staff, checkout_id) — canon G1 deve HERDAR checkout_id/origem antes de deletar G2
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total, checkout_id, origem, atendimento_id) VALUES
  ('11110000-0000-0000-0000-000000000001','oben','omie_oben_1006','1006','importado',700,NULL,NULL,NULL),
  ('11110000-0000-0000-0000-000000000002','oben','-cah8zx','1006','rascunho',700,'99990000-0000-0000-0000-000000000009','web_staff','88880000-0000-0000-0000-000000000008');
-- H) de-namespaced com omie_pedido_id NULL — NÃO é alvo (predicado exige pid not null) nem entra no índice
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('22220000-0000-0000-0000-000000000001','oben','-hhh9',NULL,'cancelado',800);
SQL
echo "seed sujo: $(Pq -c "SELECT count(*) FROM public.sales_orders;") linhas"

# ══ ZONA 2 — aplica a migration REAL (v2) sobre o estado sujo ══
MIG="$REPO_ROOT/supabase/migrations/20260618190000_b_cleanup_dups_oben.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══ ZONA 4 — asserts pós-cleanup ══
echo "── asserts ──"
eq "P1 de-namespaced A2 (oben) removida"   "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-000000000002';")" "0"
eq "P1b de-namespaced E2 (colacor) removida (global)" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='eeeeeeee-0000-0000-0000-000000000002';")" "0"
eq "P1c de-namespaced G2 removida"         "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='11110000-0000-0000-0000-000000000002';")" "0"
eq "N1 canônica A1 (oben omie_) intacta"   "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-000000000001';")" "1"
eq "N1b canônica E1 (colacor omie_) intacta" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='eeeeeeee-0000-0000-0000-000000000001';")" "1"
eq "P2 order_item de A2 cascateou"         "$(Pq -c "SELECT count(*) FROM public.order_items WHERE id='aaaaaaaa-1111-0000-0000-000000000002';")" "0"
eq "P3 sph do loser A2 DELETADO (não SET NULL)" "$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE id='aaaaaaaa-2222-0000-0000-000000000002';")" "0"
eq "P3b sph da canon A1 preservado"        "$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE id='aaaaaaaa-2222-0000-0000-000000000001';")" "1"
eq "A3 canon G1 herdou checkout_id"        "$(Pq -c "SELECT checkout_id FROM public.sales_orders WHERE id='11110000-0000-0000-0000-000000000001';")" "99990000-0000-0000-0000-000000000009"
eq "A3b canon G1 herdou origem"            "$(Pq -c "SELECT origem FROM public.sales_orders WHERE id='11110000-0000-0000-0000-000000000001';")" "web_staff"
eq "A3c canon G1 herdou atendimento_id"    "$(Pq -c "SELECT atendimento_id FROM public.sales_orders WHERE id='11110000-0000-0000-0000-000000000001';")" "88880000-0000-0000-0000-000000000008"
eq "A3d canon G1 ainda única no índice checkout (sem 23505)" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE checkout_id='99990000-0000-0000-0000-000000000009';")" "1"
eq "N2 PUSH(null)+omie_ B intactos"        "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE omie_pedido_id='1002' AND account='oben';")" "2"
eq "N4 órfã D preservada (sem par omie_)"  "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='dddddddd-0000-0000-0000-000000000001';")" "1"
eq "N-cross F2 preservada (par só em outra conta)" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='ffffffff-0000-0000-0000-000000000002';")" "1"
eq "N-pidnull H preservada (pid null, não é alvo)" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='22220000-0000-0000-0000-000000000001';")" "1"
eq "total pós-cleanup (13 seed - 3)"       "$(Pq -c "SELECT count(*) FROM public.sales_orders;")" "10"
eq "POST 0 dups residuais (account,pid hash-not-null)" "$(Pq -c "SELECT count(*) FROM (SELECT account,omie_pedido_id FROM public.sales_orders WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL GROUP BY 1,2 HAVING count(*)>1) x;")" "0"

# N6: índice barra 2ª linha hash-not-null no mesmo (account, omie_pedido_id) → unique_violation
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status)
  VALUES ('oben','omie_oben_1001_dup','1001','faturado');
  RAISE EXCEPTION 'INDICE_NAO_BARROU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'SENT_N6_BARROU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SENT_N6_BARROU*) ok "N6 índice barra recorrência (unique_violation)";; *) bad "N6 — veio: $R";; esac

# N7: índice PERMITE PUSH (hash NULL) coexistir com omie_ no mesmo pid
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status)
  VALUES ('oben',NULL,'1003','enviado');
  RAISE NOTICE 'SENT_N7_COEXISTE';
EXCEPTION WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SENT_N7_COEXISTE*) ok "N7 índice permite PUSH (hash NULL) coexistir";; *) bad "N7 — PUSH barrada indevidamente: $R";; esac

# ══ ZONA 5 — FALSIFICAÇÃO (sabota → exija VERMELHO → restaura) ══
echo "── falsificação ──"

# F-N1: o filtro "hash NOT LIKE 'omie\_%'" protege a canônica. (Dropa o índice p/ criar o estado sujo.)
P -q -c "DROP INDEX IF EXISTS public.uniq_sales_orders_omie_pedido_id;"
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('33330001-0000-0000-0000-000000000001','oben','omie_oben_3001','3001','faturado',100),
  ('33330001-0000-0000-0000-000000000002','oben','-fff1','3001','cancelado',100);
DELETE FROM public.sales_orders a
WHERE a.omie_pedido_id='3001'
  AND a.hash_payload IS NOT NULL          -- FURADO: faltou "AND a.hash_payload NOT LIKE 'omie\_%'"
  AND EXISTS (SELECT 1 FROM public.sales_orders b
              WHERE b.account=a.account AND b.omie_pedido_id=a.omie_pedido_id AND b.hash_payload LIKE 'omie\_%');
SQL
GONE=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='33330001-0000-0000-0000-000000000001';")
case "$GONE" in 0) ok "F-N1 sem o filtro hash a canônica omie_ é deletada (filtro tem dente)";; *) bad "F-N1 furei o filtro e a canônica sobreviveu → N1 fraco";; esac
P -q -c "DELETE FROM public.sales_orders WHERE omie_pedido_id='3001';" >/dev/null
P -q -f "$MIG" >/dev/null 2>&1 || true   # restaura o índice

# F-N6: dropa o índice unique → a 2ª linha hash-not-null passa (prova que o UNIQUE barrava)
P -q -c "DROP INDEX public.uniq_sales_orders_omie_pedido_id;"
if P -q -c "INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status) VALUES ('oben','omie_oben_1001_d2','1001','faturado');" >/dev/null 2>&1; then
  ok "F-N6 sem o índice a recorrência passa (o índice tinha dente)"
else
  bad "F-N6 droppei o índice e a inserção AINDA falhou → N6 não provava o índice"
fi
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload='omie_oben_1001_d2';" >/dev/null
P -q -f "$MIG" >/dev/null 2>&1 || true

# F-N7: a versão LITERAL do Codex (WHERE omie_pedido_id IS NOT NULL) FALHA por causa das PUSH (pid 1002,1003)
P -q -c "DROP INDEX IF EXISTS public.uniq_sales_orders_omie_pedido_id;"
if P -q -c "CREATE UNIQUE INDEX uniq_codex_literal ON public.sales_orders (account, omie_pedido_id) WHERE omie_pedido_id IS NOT NULL;" >/dev/null 2>&1; then
  bad "F-N7 a versão literal do Codex criou sem erro → meu refino seria desnecessário (reavaliar)"
  P -q -c "DROP INDEX IF EXISTS public.uniq_codex_literal;" >/dev/null
else
  ok "F-N7 versão literal do Codex falha (PUSH+omie_ no mesmo pid) → refino WHERE hash NOT NULL é necessário"
fi
P -q -f "$MIG" >/dev/null 2>&1 || true

# F-checkout: a ordem importa — copiar checkout_id p/ a canon ANTES de deletar o loser viola o
#             UNIQUE (checkout_id, account). Prova que delete-first é necessário (o blocker do re-challenge).
P -q -c "DROP INDEX IF EXISTS public.uniq_sales_orders_omie_pedido_id;"
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total, checkout_id, origem) VALUES
  ('44440000-0000-0000-0000-000000000001','oben','omie_oben_4001','4001','importado',100,NULL,NULL),
  ('44440000-0000-0000-0000-000000000002','oben','-cko1','4001','rascunho',100,'77770000-0000-0000-0000-000000000007','web_staff');
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  UPDATE public.sales_orders SET checkout_id='77770000-0000-0000-0000-000000000007'
  WHERE id='44440000-0000-0000-0000-000000000001';   -- copy ANTES de deletar o loser (ordem v2 errada)
  RAISE EXCEPTION 'COPY_ANTES_NAO_VIOLOU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'SENT_CKO_VIOLOU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SENT_CKO_VIOLOU*) ok "F-checkout copy-antes-de-deletar viola UNIQUE checkout (delete-first necessário)";; *) bad "F-checkout — veio: $R";; esac
P -q -c "DELETE FROM public.sales_orders WHERE omie_pedido_id='4001';" >/dev/null
P -q -f "$MIG" >/dev/null 2>&1 || true

# F-guard (N5): sem o índice, semeia 601 dups → guard aborta a migration inteira.
P -q -c "DROP INDEX IF EXISTS public.uniq_sales_orders_omie_pedido_id;"
P -q <<'SQL'
INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status, total)
SELECT 'oben','omie_oben_g'||g,'g'||g,'faturado',1 FROM generate_series(1,601) g;
INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status, total)
SELECT 'oben','-den'||g,'g'||g,'cancelado',1 FROM generate_series(1,601) g;
SQL
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F-guard 601 de-namespaced e a migration NÃO abortou → guard sem dente"
else
  ok "F-guard 601 de-namespaced → guard aborta a transação (protege contra deletar demais)"
fi

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

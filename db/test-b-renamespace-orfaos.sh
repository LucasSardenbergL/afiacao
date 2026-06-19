#!/usr/bin/env bash
# HARNESS PG17 — prova do RE-NAMESPACE #B (órfãs de-namespaced sem par 'omie_').
#   bash db/test-b-renamespace-orfaos.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Lei de Ferro: aplica a migration REAL; asserts negativos c/ SQLSTATE+re-raise; falsifica → vermelho.
# Mirror de prod: AMBOS os índices (uniq_sales_orders_omie_hash + uniq_sales_orders_omie_pedido_id).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="b-renamespace-orfaos"
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

# ══ ZONA 1 — schema stub + AMBOS os índices (mirror prod pós-cleanup) + SEED do estado ══
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  hash_payload text,
  omie_pedido_id bigint,
  status text,
  total numeric,
  created_at timestamptz DEFAULT now()
);
-- índices REAIS de prod (#929 + cleanup #B):
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;

-- O) 4 órfãs oben (de-namespaced, SEM par omie_, status cancelado mislabeled) → RE-NAMESPACE
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('00000000-0000-0000-0000-000000005001','oben','-aaa1',5001,'cancelado',123.60),
  ('00000000-0000-0000-0000-000000005002','oben','-aaa2',5002,'cancelado',152.85),
  ('00000000-0000-0000-0000-000000005003','oben','-aaa3',5003,'cancelado',107.70),
  ('00000000-0000-0000-0000-000000005004','oben','-aaa4',5004,'cancelado',189.00);
-- A) órfã colacor com o MESMO número de pid (5001) — re-namespace é account-aware (hash distinto)
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('00000000-0000-0000-0000-0000000c5001','colacor','-ccc1',5001,'cancelado',50.00);
-- K) omie_ legítima (oben) — INTACTA
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('00000000-0000-0000-0000-000000006001','oben','omie_oben_6001',6001,'faturado',600);
-- L) PUSH (hash NULL) no MESMO pid de K — coexiste e fica INTACTA
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('00000000-0000-0000-0000-0000000060f1','oben',NULL,6001,'enviado',600);
SQL
echo "seed: $(Pq -c "SELECT count(*) FROM public.sales_orders;") linhas"

# ══ ZONA 2 — aplica a migration REAL sobre o estado ══
MIG="$REPO_ROOT/supabase/migrations/20260618210000_b_renamespace_orfaos.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══ ZONA 4 — asserts ══
echo "── asserts ──"
eq "P1 órfã oben 5001 re-namespaced"  "$(Pq -c "SELECT hash_payload FROM public.sales_orders WHERE id='00000000-0000-0000-0000-000000005001';")" "omie_oben_5001"
eq "P1 órfã oben 5004 re-namespaced"  "$(Pq -c "SELECT hash_payload FROM public.sales_orders WHERE id='00000000-0000-0000-0000-000000005004';")" "omie_oben_5004"
eq "P1-acc órfã colacor 5001 (hash account-aware)" "$(Pq -c "SELECT hash_payload FROM public.sales_orders WHERE id='00000000-0000-0000-0000-0000000c5001';")" "omie_colacor_5001"
eq "P-status NÃO muda (correção é do reprocess)" "$(Pq -c "SELECT status FROM public.sales_orders WHERE id='00000000-0000-0000-0000-000000005001';")" "cancelado"
eq "N1 omie_ K intacta"               "$(Pq -c "SELECT hash_payload FROM public.sales_orders WHERE id='00000000-0000-0000-0000-000000006001';")" "omie_oben_6001"
eq "N2 PUSH L segue hash NULL"        "$(Pq -c "SELECT coalesce(hash_payload,'NULL') FROM public.sales_orders WHERE id='00000000-0000-0000-0000-0000000060f1';")" "NULL"
eq "P-naodestrutivo total inalterado" "$(Pq -c "SELECT count(*) FROM public.sales_orders;")" "7"
eq "POST 0 órfãs de-namespaced restantes" "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload IS NOT NULL AND hash_payload NOT LIKE 'omie\_%' AND omie_pedido_id IS NOT NULL;")" "0"

# P-idem: re-rodar a migration casa 0 (idempotente) e não erra
if P -q -f "$MIG" >/dev/null 2>&1; then ok "P-idem re-run idempotente (0 órfãs, sem erro)"; else bad "P-idem re-run FALHOU"; fi

# P-index: a órfã re-namespaced virou a canônica → 2ª 'omie_oben_5001' colide (unique_violation)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status)
  VALUES ('oben','omie_oben_5001',5001,'faturado');
  RAISE EXCEPTION 'INDICE_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'SENT_PIDX_BARROU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SENT_PIDX_BARROU*) ok "P-index re-namespaced é a canônica (hash dup barrado)";; *) bad "P-index — veio: $R";; esac

# ══ ZONA 5 — FALSIFICAÇÃO ══
echo "── falsificação ──"

# F1: o NOT EXISTS protege contra colisão. Semeia uma de-namespaced COM par omie_ (estado que o
# índice omie_pedido_id proíbe → dropa só ele p/ semear), roda a versão FURADA (sem NOT EXISTS):
# ela re-namespearia a com-par → hash idêntico ao par → COLISÃO no índice de hash (23505).
P -q -c "DROP INDEX public.uniq_sales_orders_omie_pedido_id;"
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account, hash_payload, omie_pedido_id, status, total) VALUES
  ('00000000-0000-0000-0000-000000007001','oben','omie_oben_7001',7001,'faturado',700),  -- par omie_
  ('00000000-0000-0000-0000-0000000070d1','oben','-den7',7001,'cancelado',700);          -- de-namespaced COM par
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  UPDATE public.sales_orders s SET hash_payload='omie_'||s.account||'_'||s.omie_pedido_id
  WHERE s.hash_payload IS NOT NULL AND s.hash_payload NOT LIKE 'omie\_%' AND s.omie_pedido_id IS NOT NULL
    AND s.omie_pedido_id = 7001;  -- FURADO: sem o NOT EXISTS → pega a de-namespaced COM par
  RAISE EXCEPTION 'FURADO_NAO_COLIDIU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'SENT_F1_COLIDIU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SENT_F1_COLIDIU*) ok "F1 sem NOT EXISTS a com-par colide no índice de hash (guard tem dente)";; *) bad "F1 — veio: $R";; esac
P -q -c "DELETE FROM public.sales_orders WHERE omie_pedido_id=7001;" >/dev/null
P -q -c "CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;" >/dev/null

# F2: guard "2+ órfãs no mesmo (account,pid)" aborta (estado que o índice proíbe → dropa p/ semear).
P -q -c "DROP INDEX public.uniq_sales_orders_omie_pedido_id;"
P -q <<'SQL'
INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status, total) VALUES
  ('oben','-dup1',8001,'cancelado',1),
  ('oben','-dup2',8001,'cancelado',1);  -- 2 órfãs, MESMO pid, SEM par omie_
SQL
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F2 2 órfãs no mesmo pid e a migration NÃO abortou → guard 2+ sem dente"
else
  ok "F2 2 órfãs no mesmo (account,pid) → migration aborta (guard 2+ tem dente)"
fi
P -q -c "DELETE FROM public.sales_orders WHERE omie_pedido_id=8001;" >/dev/null
P -q -c "CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id ON public.sales_orders (account, omie_pedido_id) WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;" >/dev/null

# F3: guard teto >50 aborta (semeia 51 órfãs).
P -q <<'SQL'
INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status, total)
SELECT 'oben','-big'||g,90000+g,'cancelado',1 FROM generate_series(1,51) g;
SQL
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F3 51 órfãs e a migration NÃO abortou → guard >50 sem dente"
else
  ok "F3 51 órfãs → migration aborta (guard >50 tem dente)"
fi

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

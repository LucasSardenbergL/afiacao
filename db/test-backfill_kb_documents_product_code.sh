#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — prova do backfill kb_documents.product_code (via document_id)  ║
# ║  Migration: supabase/migrations/20260701200017_backfill_kb_documents_product_code.sql
# ║  Prova: preenche o product_code do documento a partir da ficha APROVADA, pelo  ║
# ║  join document_id — sem vazar rascunho, sem cruzar doc, sem sobrescrever manual.║
# ║  Rodar: bash db/test-backfill_kb_documents_product_code.sh > /tmp/t.log 2>&1; echo $?
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="backfill_kb_documents_product_code"
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
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=[$2])"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — schema mínimo (só o que a migration toca) ──
P -q <<'SQL'
CREATE TABLE public.kb_documents (
  id uuid PRIMARY KEY,
  product_code text,
  status text,
  title text,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.kb_product_specs (
  id uuid PRIMARY KEY,
  document_id uuid,
  product_code text,
  approved_at timestamptz
);
SQL

# seed base reutilizável — 5 documentos cobrindo os casos:
#   D1 aprovada · D2 só-rascunho · D3 aprovada (code distinto) · D4 manual+aprovada · D5 sem ficha
seed_base() {
P -q <<'SQL'
TRUNCATE public.kb_documents, public.kb_product_specs;
INSERT INTO public.kb_documents (id, product_code, status, title) VALUES
  ('d1111111-0000-0000-0000-000000000001', NULL,        'ready', 'FL_6269_02'),
  ('d2222222-0000-0000-0000-000000000002', NULL,        'ready', 'FL_9999_00'),
  ('d3333333-0000-0000-0000-000000000003', NULL,        'ready', 'PC_2992_00'),
  ('d4444444-0000-0000-0000-000000000004', 'MANUAL.XX', 'ready', 'YC_1401_00'),
  ('d5555555-0000-0000-0000-000000000005', NULL,        'ready', 'SEM_FICHA');
INSERT INTO public.kb_product_specs (id, document_id, product_code, approved_at) VALUES
  ('50000001-0000-0000-0000-000000000001', 'd1111111-0000-0000-0000-000000000001', 'FL.6269.02', now()),  -- aprovada
  ('50000002-0000-0000-0000-000000000002', 'd2222222-0000-0000-0000-000000000002', 'FL.9999.00', NULL),   -- RASCUNHO (approved_at NULL)
  ('50000003-0000-0000-0000-000000000003', 'd3333333-0000-0000-0000-000000000003', 'PC.2992.00', now()),  -- aprovada
  ('50000004-0000-0000-0000-000000000004', 'd4444444-0000-0000-0000-000000000004', 'YC.1401.00', now());  -- aprovada, mas doc já tem product_code manual
SQL
}

MIG="$REPO_ROOT/supabase/migrations/20260701200017_backfill_kb_documents_product_code.sql"

# ── ZONA 2/3 — semeia e aplica a migration REAL ──
seed_base
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 4 — asserts positivos ──
echo "── asserts (positivo) ──"
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d1111111-0000-0000-0000-000000000001';"); eq "A1 doc-aprovado recebe o SEU product_code"        "$V" "FL.6269.02"
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d2222222-0000-0000-0000-000000000002';"); eq "A2 doc só-rascunho NAO vaza (segue vazio)"          "$V" ""
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d3333333-0000-0000-0000-000000000003';"); eq "A3 nao-cross: D3 recebe o SEU code (nao o de D1)"   "$V" "PC.2992.00"
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d4444444-0000-0000-0000-000000000004';"); eq "A4 guard: product_code manual preservado"           "$V" "MANUAL.XX"
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d5555555-0000-0000-0000-000000000005';"); eq "A5 doc sem ficha NAO e tocado (segue vazio)"        "$V" ""

# idempotência: reaplicar o ARQUIVO REAL não re-toca D1 (guard já não casa) → updated_at estável
TS1=$(Pq -c "SELECT updated_at FROM public.kb_documents WHERE id='d1111111-0000-0000-0000-000000000001';")
P -q -f "$MIG"
TS2=$(Pq -c "SELECT updated_at FROM public.kb_documents WHERE id='d1111111-0000-0000-0000-000000000001';")
eq "A6 idempotencia: 2a aplicacao nao re-toca D1 (updated_at estavel)" "$TS1" "$TS2"

# ── ZONA 5 — FALSIFICAÇÃO (sabota → exige que o assert correspondente ficaria VERMELHO) ──
echo "── falsificacao ──"

# F1 — sem o filtro approved_at: DEVE vazar p/ o rascunho (D2). Se D2 seguir vazio, A2 não tem dente.
seed_base
P -q <<'SQL'
UPDATE public.kb_documents AS d
SET product_code = s.product_code
FROM public.kb_product_specs AS s
WHERE s.document_id = d.id
  AND s.product_code IS NOT NULL AND btrim(s.product_code) <> ''
  AND (d.product_code IS NULL OR btrim(d.product_code) = '');   -- SABOTADO: removido AND s.approved_at IS NOT NULL
SQL
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d2222222-0000-0000-0000-000000000002';")
if [ "$V" = "" ]; then bad "F1 sem approved_at devia VAZAR p/ rascunho, mas D2 seguiu vazio → A2 sem dente"; else ok "F1 sem approved_at vaza p/ rascunho (D2=[$V]) → A2 tem dente"; fi

# F2 — sem o guard (d.product_code vazio): DEVE sobrescrever o manual (D4). Se D4 seguir MANUAL, A4 não tem dente.
seed_base
P -q <<'SQL'
UPDATE public.kb_documents AS d
SET product_code = s.product_code
FROM public.kb_product_specs AS s
WHERE s.document_id = d.id
  AND s.approved_at IS NOT NULL
  AND s.product_code IS NOT NULL AND btrim(s.product_code) <> '';   -- SABOTADO: removido o guard (d.product_code IS NULL OR vazio)
SQL
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d4444444-0000-0000-0000-000000000004';")
if [ "$V" = "MANUAL.XX" ]; then bad "F2 sem guard devia SOBRESCREVER o manual, mas D4 seguiu MANUAL.XX → A4 sem dente"; else ok "F2 sem guard sobrescreve o manual (D4=[$V]) → A4 tem dente"; fi

# F3 — join invertido (<>): com 2 docs, cada um casa a ficha do OUTRO → D1 recebe o code de D3.
P -q <<'SQL'
TRUNCATE public.kb_documents, public.kb_product_specs;
INSERT INTO public.kb_documents (id, product_code, status, title) VALUES
  ('d1111111-0000-0000-0000-000000000001', NULL, 'ready', 'A'),
  ('d3333333-0000-0000-0000-000000000003', NULL, 'ready', 'B');
INSERT INTO public.kb_product_specs (id, document_id, product_code, approved_at) VALUES
  ('50000001-0000-0000-0000-000000000001', 'd1111111-0000-0000-0000-000000000001', 'FL.6269.02', now()),
  ('50000003-0000-0000-0000-000000000003', 'd3333333-0000-0000-0000-000000000003', 'PC.2992.00', now());
UPDATE public.kb_documents AS d
SET product_code = s.product_code
FROM public.kb_product_specs AS s
WHERE s.document_id <> d.id                                        -- SABOTADO: join invertido (= vira <>)
  AND s.approved_at IS NOT NULL
  AND s.product_code IS NOT NULL AND btrim(s.product_code) <> ''
  AND (d.product_code IS NULL OR btrim(d.product_code) = '');
SQL
V=$(Pq -c "SELECT coalesce(product_code,'') FROM public.kb_documents WHERE id='d1111111-0000-0000-0000-000000000001';")
if [ "$V" = "FL.6269.02" ]; then bad "F3 join invertido devia CRUZAR, mas D1 manteve o seu → A1/A3 sem dente"; else ok "F3 join invertido cruza o code (D1=[$V], veio o de outro doc) → A1/A3 tem dente"; fi

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# PROVA PG17 — retenção do nIdReceb (coluna dedicada + backfill barato do jsonb).
#   bash db/test-pot-nid-receb.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   (NÃO pipe pra tail — engole o exit≠0.)
#
# O que se prova aqui:
#   1. O backfill barato tira o sinal do jsonb SEM chamar a Omie.
#   2. Ele só aceita nIdReceb NUMÉRICO — qualquer outra coisa fica NULL (ausente ≠ zero:
#      um sinal fabricado consultaria o recebimento ERRADO no ERP).
#   3. Reaplicar não sobrescreve um nid_receb já resolvido (o WHERE ... IS NULL).
#   4. O índice parcial do backfill existe e casa com o predicado do sync.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="nidreceb"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

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

# ── ZONA 1: pré-requisitos de schema (o que a migration ALTERA mas não cria) ──
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  nfe_chave_acesso text,
  raw_data jsonb
);
SQL

# ── ZONA 3 (antes da 2 de propósito): seed. O backfill barato só tem o que popular se o
#    jsonb já existir quando a migration roda — é exatamente a situação de produção. ──
P -q <<'SQL'
INSERT INTO public.purchase_orders_tracking (id, empresa, nfe_chave_acesso, raw_data) VALUES
  -- (a) sinal numérico no jsonb → DEVE virar coluna
  ('aaaaaaaa-0000-0000-0000-000000000001','OBEN','1', '{"cabec":{"nIdReceb":90001}}'),
  -- (b) numérico como STRING (a Omie devolve os dois) → DEVE virar coluna
  ('aaaaaaaa-0000-0000-0000-000000000002','OBEN','2', '{"cabec":{"nIdReceb":"90002"}}'),
  -- (c) NÃO-numérico → tem de ficar NULL (fabricar consultaria o recebimento errado)
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN','3', '{"cabec":{"nIdReceb":"90003abc"}}'),
  -- (d) string vazia → NULL
  ('bbbbbbbb-0000-0000-0000-000000000002','OBEN','4', '{"cabec":{"nIdReceb":""}}'),
  -- (e) payload do PEDIDO (o que o sync concorrente grava por cima) → NULL
  ('bbbbbbbb-0000-0000-0000-000000000003','OBEN','5', '{"cabecalho_consulta":{"nCodPed":7}}'),
  -- (f) raw_data ausente → NULL
  ('bbbbbbbb-0000-0000-0000-000000000004','OBEN','6', NULL);
SQL

# ── ZONA 2: aplica a migration REAL do repo (Lei #1) ──
MIG="$REPO_ROOT/supabase/migrations/20260718120000_pot_nid_receb_retencao.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

echo "═══ asserts ═══"

# A1 — o sinal numérico saiu do jsonb para a coluna (int e string)
eq "A1a nIdReceb numérico virou coluna" \
   "$(Pq -c "SELECT nid_receb FROM public.purchase_orders_tracking WHERE nfe_chave_acesso='1'")" "90001"
eq "A1b nIdReceb numérico-string virou coluna" \
   "$(Pq -c "SELECT nid_receb FROM public.purchase_orders_tracking WHERE nfe_chave_acesso='2'")" "90002"

# A2 — precisão > recall: nada de fabricar sinal a partir de lixo
eq "A2 lixo NÃO vira sinal (não-numérico, vazio, payload de pedido, raw_data nulo)" \
   "$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE nfe_chave_acesso IN ('3','4','5','6') AND nid_receb IS NOT NULL")" "0"

# A3 — o índice parcial do backfill existe e casa com o predicado do sync
eq "A3 índice parcial do backfill criado" \
   "$(Pq -c "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='idx_pot_backfill_nid_receb'")" "1"
eq "A3b índice cobre o predicado (NFe presente + sinal ausente)" \
   "$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname='idx_pot_backfill_nid_receb' AND indexdef LIKE '%nfe_chave_acesso IS NOT NULL%' AND indexdef LIKE '%nid_receb IS NULL%'")" "1"

# A4 — IDEMPOTÊNCIA REAL: um sinal já resolvido não é sobrescrito ao reaplicar.
# (Simula o sinal resolvido pela edge; o jsonb da linha (a) diz 90001, a coluna diz 99999.)
P -q -c "UPDATE public.purchase_orders_tracking SET nid_receb = 99999 WHERE nfe_chave_acesso='1'"
P -q -f "$MIG"
eq "A4 reaplicar NÃO sobrescreve sinal já resolvido" \
   "$(Pq -c "SELECT nid_receb FROM public.purchase_orders_tracking WHERE nfe_chave_acesso='1'")" "99999"
eq "A4b reaplicar não estraga os demais" \
   "$(Pq -c "SELECT nid_receb FROM public.purchase_orders_tracking WHERE nfe_chave_acesso='2'")" "90002"

echo "═══ RESULTADO: $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ] || exit 1

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — camada SQL da ponta 2/2 do incidente carteira-Hunter (P0-B-bis)  ║
# ║  A carteira lê o VENDEDOR da view fresca omie_customer_account_map_fresco       ║
# ║  (account=oben). Esta prova crava a SEMÂNTICA da view+query em que a correção   ║
# ║  se apoia — NÃO há migração nova (edge TS puro; a lógica é provada por vitest). ║
# ║  Recria a tabela base + a view com as DEFINIÇÕES REAIS (pg_get_viewdef +        ║
# ║  constraints conferidas via psql-ro 2026-07-11) e FALSIFICA cada invariante.    ║
# ║      bash db/test-carteira-vendedor-oben-account-safe.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"     # porta própria (evita colisão com outros harnesses em paralelo)
SLUG="carteira-vend-oben"
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
# ZONA 1+2 — SCHEMA REAL: tabela base (com as UNIQUE reais) + view fresca (def real)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- Estrutura REAL de omie_customer_account_map (information_schema + pg_constraint via psql-ro 2026-07-11).
CREATE TABLE public.omie_customer_account_map (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid   NOT NULL,
  account              text   NOT NULL,
  omie_codigo_cliente  bigint NOT NULL,
  omie_codigo_vendedor bigint,               -- nullable: o writer só popula quando recomendacoes traz
  source               text   NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account),
  CONSTRAINT uq_ocam_user_account   UNIQUE (user_id, account)
);
-- Definição REAL da view (pg_get_viewdef via psql-ro): TTL 7d sobre a base.
CREATE VIEW public.omie_customer_account_map_fresco AS
  SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
    FROM public.omie_customer_account_map
   WHERE updated_at >= (now() - '7 days'::interval);
SQL
echo "schema real recriado (tabela base + view fresca)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: casos de borda do money-path da carteira
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at) VALUES
 -- user1: MESMO cliente em 2 contas com vendedores DIFERENTES. A carteira (oben) deve pegar 100, nunca 200.
 ('11111111-1111-1111-1111-111111111111', 'oben',       9001, 100, 'document', now()),
 ('11111111-1111-1111-1111-111111111111', 'colacor_sc', 9002, 200, 'document', now()),
 -- user2: linha oben fresca mas vendedor NULL (estado transitório / recomendacoes sem vendedor) → órfão honesto.
 ('22222222-2222-2222-2222-222222222222', 'oben',       9003, NULL, 'document', now()),
 -- user3: linha oben com vendedor 300 mas STALE (>7d) → a view fresca deve OCULTAR (senão vendedor podre).
 ('33333333-3333-3333-3333-333333333333', 'oben',       9004, 300, 'document', now() - interval '8 days'),
 -- user4: só existe em colacor_sc (é o clone típico) → NÃO deve aparecer na carteira oben (sem herança).
 ('44444444-4444-4444-4444-444444444444', 'colacor_sc', 9005, 400, 'document', now());
SQL
echo "seed aplicado"

U1="11111111-1111-1111-1111-111111111111"
U2="22222222-2222-2222-2222-222222222222"
U3="33333333-3333-3333-3333-333333333333"
U4="44444444-4444-4444-4444-444444444444"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS POSITIVOS: a query REAL do edge é account-safe
# (a query do edge: FROM omie_customer_account_map_fresco WHERE account='oben')
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos (a query correta que o edge faz) ──"

V=$(Pq -c "SELECT omie_codigo_vendedor FROM omie_customer_account_map_fresco WHERE account='oben' AND user_id='$U1';")
eq "A1 vendedor da CONTA CERTA (oben=100, nunca o colacor_sc=200)" "$V" "100"

V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULL') FROM omie_customer_account_map_fresco WHERE account='oben' AND user_id='$U2';")
eq "A2 vendedor ausente preservado como NULL (órfão honesto, vira Hunter no rebuild)" "$V" "NULL"

V=$(Pq -c "SELECT count(*) FROM omie_customer_account_map_fresco WHERE account='oben' AND user_id='$U3';")
eq "A3 STALE (>7d) OCULTO pela view fresca (não injeta vendedor podre)" "$V" "0"

V=$(Pq -c "SELECT count(*) FROM omie_customer_account_map_fresco WHERE account='oben' AND user_id='$U4';")
eq "A4 clone só-colacor_sc AUSENTE na carteira oben (sem herança cross-account)" "$V" "0"

# nenhuma linha colacor_sc pode aparecer sob o filtro account='oben'
V=$(Pq -c "SELECT count(*) FROM omie_customer_account_map_fresco WHERE account='oben' AND omie_codigo_vendedor=200;")
eq "A5 isolamento de conta: o vendedor 200 (colacor_sc) NÃO aparece sob account=oben" "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: sabota cada proteção da query → exige VERMELHO
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (sabota o filtro → prova o dente) ──"

# F1 — SABOTA o filtro de CONTA (o bug do espelho poluído, que lia sem account): o mesmo user1 passa a
#      trazer 2 vendedores (100 oben E 200 colacor_sc). Se a query correta (A1) NÃO tivesse o filtro
#      account=oben, ela pegaria um vendedor arbitrário/errado. Provamos que SEM o filtro há ambiguidade.
FURADO=$(Pq -c "SELECT count(DISTINCT omie_codigo_vendedor) FROM omie_customer_account_map_fresco WHERE user_id='$U1';")
if [ "$FURADO" = "2" ]; then ok "F1 sem o filtro de conta → 2 vendedores p/ o mesmo user (vazamento que o account=oben mata)"; else bad "F1 falsificação fraca — sem filtro deu [$FURADO], esperava 2 (o filtro não estaria protegendo nada)"; fi
# e o valor arbitrário que vazaria inclui o colacor_sc:
LEAK=$(Pq -c "SELECT count(*) FROM omie_customer_account_map_fresco WHERE user_id='$U1' AND omie_codigo_vendedor=200;")
eq "F1b o vendedor colacor_sc (200) É alcançável sem o filtro de conta (por isso o filtro tem dente)" "$LEAK" "1"

# F2 — SABOTA a fonte fresca (ler a BASE em vez da view): o stale user3 (vendedor 300 podre) reaparece.
#      Prova que é a VIEW (TTL 7d) que protege — ler a base reabriria stale infinito (Codex P1).
STALE_NA_BASE=$(Pq -c "SELECT count(*) FROM omie_customer_account_map WHERE account='oben' AND user_id='$U3';")
eq "F2 a BASE traz o stale (300) — a view fresca é o que o oculta; ler a base seria fail-open" "$STALE_NA_BASE" "1"

# F3 — a UNIQUE(user_id, account) é o que garante ≤1 vendedor por (user, oben): tentar 2ª linha oben deve
#      violar unique_violation (SQLSTATE 23505). Falsifica a premissa do invariante-4 "ambíguo" na base.
ERR=$(P -v VERBOSITY=verbose -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source) VALUES ('$U1','oben', 9999, 999, 'document');" 2>&1 || true)
if echo "$ERR" | grep -qE "23505|uq_ocam_user_account"; then ok "F3 UNIQUE(user_id,account) impede 2ª linha oben → ambiguidade impossível NA BASE (SQLSTATE 23505)"; else bad "F3 esperava unique_violation (23505/uq_ocam_user_account), veio: $ERR"; fi

# F4 — prova que a UNIQUE é REAL (dropa a constraint → o insert duplicado agora PASSA → assert vira vermelho).
#      Restaura em seguida. Isto garante que F3 tem dente (não passou por acaso).
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT uq_ocam_user_account;"
if P -q -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source) VALUES ('$U1','oben', 9998, 998, 'document');" >/dev/null 2>&1; then
  ok "F4 sabotagem confirmada: SEM a UNIQUE o duplicado (user1,oben) entra → 2 vendedores oben (o cenário que o invariante-4 fail-closa)"
else
  bad "F4 falsificação fraca: o insert duplicado falhou mesmo sem a constraint"
fi
P -q -c "DELETE FROM public.omie_customer_account_map WHERE omie_codigo_cliente=9998; ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT uq_ocam_user_account UNIQUE (user_id, account);"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

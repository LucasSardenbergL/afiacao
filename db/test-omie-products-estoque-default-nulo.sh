#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# Prova PG17 da migration 20261121220100_omie_products_estoque_default_nulo.sql
#
#   bash db/test-omie-products-estoque-default-nulo.sh               → suíte (locale C)
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-omie-products-estoque-default-nulo.sh
#   bash db/test-omie-products-estoque-default-nulo.sh --falsificar  → controle verde + cada sabotagem,
#                                                                      nos DOIS locales (C e pt_BR.UTF-8)
#
# Fixture = o estado da PROD no pré-voo (psql-ro 2026-11-21): `estoque numeric NULL DEFAULT 0`.
#
#   A0  a migration REAL aplica (postcondição passa) com ON_ERROR_STOP
#   P1  INSERT do catálogo SEM `estoque` → NULL (não 0): o zero inventado morreu
#   P2  linhas pré-existentes intactas: 0 continua 0, 7.5 continua 7.5 (sem backfill cego)
#   P3  0 EXPLÍCITO (saldo medido pelo sync) continua aceito e gravado como 0
#   C1  catálogo: atthasdef=false e nenhuma linha em pg_attrdef; coluna nullable
#   I1  idempotente: re-aplicar passa e não muda nada
#   N1  postcondição morde: coluna NOT NULL → a migration aborta com A3 (SQLSTATE P0001)
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_REAL="$REPO_ROOT/supabase/migrations/20261121220100_omie_products_estoque_default_nulo.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="default_fica:A0 default_fica_sem_post:P1 backfill_cego:P2 post_sem_a3:N1"
  LOGDIR="$(mktemp -d "/tmp/falsifica-estoque-default-nulo.XXXXXX")"
  falhas=0; n_sab=0
  for loc in C pt_BR.UTF-8; do
    echo "== CONTROLE ($loc) =="
    if ! LOCALE_TESTE="$loc" SABOTAGEM="" bash "$0" > "$LOGDIR/controle-$loc.log" 2>&1; then
      echo "CONTROLE VERMELHO em $loc — falsificacao abortada (log: $LOGDIR/controle-$loc.log)"
      tail -15 "$LOGDIR/controle-$loc.log"; exit 1
    fi
    grep -q '^TESTE_ESTOQUE_DEFAULT_NULO_OK$' "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) sem marcador de fim"; exit 1; }
    grep -q "^LOCALE_ATIVO=$loc\$" "$LOGDIR/controle-$loc.log" || { echo "CONTROLE ($loc) nao rodou no locale pedido"; exit 1; }
    echo "controle verde em $loc ($(grep -c '^  OK ' "$LOGDIR/controle-$loc.log") OK)"
    for par in $SABOTAGENS; do
      s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
      log="$LOGDIR/$s-$loc.log"
      if LOCALE_TESTE="$loc" SABOTAGEM="$s" bash "$0" > "$log" 2>&1; then
        echo "XX $s ($loc): suite ficou VERDE"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "SABOTAGEM ATIVA: $s" "$log"; then
        echo "XX $s ($loc): sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "^  FAIL $a " "$log"; then
        echo "XX $s ($loc): vermelho, mas NAO no assert $a (log: $log)"; falhas=$((falhas+1)); continue
      fi
      echo "ok $s ($loc) -> vermelho em $a"
    done
  done
  echo "FALSIFICACAO: $((n_sab - falhas))/$n_sab sabotagens acusadas pelo assert certo"
  [ "$falhas" -eq 0 ] || exit 1
  echo "FALSIFICACAO_ESTOQUE_DEFAULT_NULO_OK"
  exit 0
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5531}"
SLUG="estoque-default-nulo-$$"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
# O postmaster precisa de LC_ALL válido; o locale sob teste vai no initdb (o do cluster é o que conta).
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# ── Cópia da migration (a sabotagem só mexe na cópia) ──
MIG="$TMPD/mig.sql"
cp "$MIG_REAL" "$MIG"
sab() { sed -i.bak "$1" "$MIG"; rm -f "$MIG.bak"; }
case "${SABOTAGEM:-}" in
  "") ;;
  default_fica)          sab 's/ALTER COLUMN estoque SET DEFAULT NULL;/ALTER COLUMN estoque SET DEFAULT 0;/' ;;
  default_fica_sem_post) sab 's/ALTER COLUMN estoque SET DEFAULT NULL;/ALTER COLUMN estoque SET DEFAULT 0;/'
                         sab 's/  IF v_hasdef OR EXISTS (/  IF false AND EXISTS (/' ;;
  backfill_cego)         printf '\nUPDATE public.omie_products SET estoque = NULL WHERE estoque = 0;\n' >> "$MIG" ;;
  post_sem_a3)           sab 's/  IF v_notnull THEN/  IF false THEN/' ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "sabotagem $SABOTAGEM nao alterou a copia"; exit 2; fi
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

P()  { "$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -At "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "LOCALE_ATIVO=$(Pq -c "SELECT datcollate FROM pg_database WHERE datname = current_database()")"

# ── ZONA 1: fixture = estado da PROD (estoque numeric NULL DEFAULT 0) ──
P <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL,
  descricao text,
  estoque numeric DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- pré-existentes: um 0 (pode ser saldo real) e um saldo positivo
INSERT INTO public.omie_products (omie_codigo_produto, account, descricao, estoque) VALUES
  (1, 'oben', 'zero-antigo', 0),
  (2, 'oben', 'saldo-antigo', 7.5);
SQL

# ── ZONA 2: aplica a migration REAL (cópia, talvez sabotada) — `-1` = transação única, como o db:aplicar ──
if P -1 -f "$MIG" > "$TMPD/apply.log" 2>&1; then ok "A0 migration aplica e a postcondicao passa"
else bad "A0 migration aplica — $(grep -m1 'ERROR' "$TMPD/apply.log" || echo sem-erro)"; fi

# ── ZONA 3/4: asserts ──
# P1 — o INSERT do catálogo, como as edges fazem: sem a coluna estoque
P -c "INSERT INTO public.omie_products (omie_codigo_produto, account, descricao) VALUES (3, 'oben', 'novo-sem-saldo')"
eq "P1 produto novo sem estoque nasce NULL" \
   "$(Pq -c "SELECT COALESCE(estoque::text, 'NULO') FROM public.omie_products WHERE omie_codigo_produto = 3")" "NULO"

eq "P2 pre-existentes intactos (0 e 7.5)" \
   "$(Pq -c "SELECT string_agg(omie_codigo_produto || '=' || COALESCE(estoque::text, 'NULO'), ',' ORDER BY omie_codigo_produto) FROM public.omie_products WHERE omie_codigo_produto IN (1, 2)")" "1=0,2=7.5"

P -c "INSERT INTO public.omie_products (omie_codigo_produto, account, descricao, estoque) VALUES (4, 'oben', 'zero-medido', 0)"
eq "P3 zero explicito (medido) gravado como 0" \
   "$(Pq -c "SELECT COALESCE(estoque::text, 'NULO') FROM public.omie_products WHERE omie_codigo_produto = 4")" "0"

eq "C1 catalogo: sem default, nullable" \
   "$(Pq -c "SELECT a.atthasdef::text || '/' || a.attnotnull::text || '/' || (SELECT count(*) FROM pg_attrdef d WHERE d.adrelid = a.attrelid AND d.adnum = a.attnum) FROM pg_attribute a WHERE a.attrelid = 'public.omie_products'::regclass AND a.attname = 'estoque'")" "false/false/0"

FOTO_ANTES="$(Pq -c "SELECT md5(string_agg(omie_codigo_produto || ':' || COALESCE(estoque::text, 'N'), '|' ORDER BY omie_codigo_produto)) FROM public.omie_products")"
if P -1 -f "$MIG" > "$TMPD/reapply.log" 2>&1; then
  eq "I1 re-aplicar passa e nao muda dados" \
     "$(Pq -c "SELECT md5(string_agg(omie_codigo_produto || ':' || COALESCE(estoque::text, 'N'), '|' ORDER BY omie_codigo_produto)) FROM public.omie_products")" "$FOTO_ANTES"
else bad "I1 re-aplicar — $(grep -m1 'ERROR' "$TMPD/reapply.log" || echo sem-erro)"; fi

# N1 — postcondição tem dente: coluna NOT NULL → a migration TEM de abortar com o A3 (P0001).
P -c "DELETE FROM public.omie_products WHERE estoque IS NULL; ALTER TABLE public.omie_products ALTER COLUMN estoque SET NOT NULL"
if P -1 -v VERBOSITY=verbose -f "$MIG" > "$TMPD/n1.log" 2>&1; then
  bad "N1 postcondicao morde NOT NULL — a migration PASSOU com a coluna NOT NULL"
elif grep -q '^psql:.*ERROR:  P0001: A3 FALHOU' "$TMPD/n1.log"; then
  ok "N1 postcondicao morde NOT NULL (P0001 A3)"
else
  bad "N1 postcondicao morde NOT NULL — erro diferente: $(grep -m1 'ERROR' "$TMPD/n1.log" || echo sem-erro)"
fi

echo "RESULTADO: $PASS OK / $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "TESTE_ESTOQUE_DEFAULT_NULO_OK"

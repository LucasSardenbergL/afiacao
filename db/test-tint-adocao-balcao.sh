#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════
# ║  PROVA PG17 — tint_adocao_balcao: o KPI de adoção do balcão conta certo, com FALSIFICAÇÃO
# ║      bash db/test-tint-adocao-balcao.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-tint-adocao-balcao.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-tint-adocao-balcao.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_tint_adocao_balcao.sql), com as policies de leitura de sales_orders
# ║  COPIADAS da prod (staff vê tudo; customer só os próprios). Os asserts rodam sob SET ROLE
# ║  authenticated — é a RLS real de quem chama, já que a função é SECURITY INVOKER.
# ║   · conta pelo VALOR: `"tint_formula_id": null` e `tint_nome_cor` vazio não contam;
# ║   · universo de VENDA canônico: cancelado/orçamento/apagado não contam;
# ║   · janela de dias (30 padrão, NULL/fora de 1..365 → 30); items não-array é ignorado;
# ║   · RLS: um customer só conta os próprios pedidos;
# ║   · a postcondição tem dente (sem o REVOKE do anon a migration aborta) e reaplicar é no-op.
# ╚═══════════════════════════════════════════════════════
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5591}"
SLUG="tint-adocao-balcao"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="like_texto:A1 janela_ignora:A1 clamp_zero:A4 sem_status:A1 sem_deleted:A1"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_tint_adocao_balcao.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration ausente: [$MIG] — a prova testaria o NADA"; exit 1; }

# ── sabotagem: copia a migration e troca UM trecho; o padrão tem de ocorrer (senão a prova mente) ──
MIG_USADA="$TMP/migration.sql"
cp "$MIG" "$MIG_USADA"
sabotar() {  # $1 = trecho original (literal), $2 = substituto
  local n; n="$(grep -cF -- "$1" "$MIG_USADA" || true)"
  [ "$n" -ge 1 ] || { echo "❌ padrão da sabotagem não ocorre na migration: [$1]"; exit 1; }
  ORIG="$1" NOVO="$2" perl -0pi -e 's/\Q$ENV{ORIG}\E/$ENV{NOVO}/g' "$MIG_USADA"
  echo "SABOTAGEM ATIVA em migration: ${SABOTAGEM:-} ($n ocorrência(s))"
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_status)    sabotar "AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')" "" ;;
  sem_deleted)   sabotar "AND so.deleted_at IS NULL" "" ;;
  like_texto)    sabotar "WHERE nullif(e->>'tint_formula_id', '') IS NOT NULL" "WHERE e ? 'tint_formula_id'" ;;
  janela_ignora) sabotar "WHEN p_dias BETWEEN 1 AND 365 THEN p_dias ELSE 30 END" "WHEN true THEN 36500 END" ;;
  clamp_zero)    sabotar "WHEN p_dias BETWEEN 1 AND 365" "WHEN p_dias BETWEEN 0 AND 365" ;;
  *) echo "❌ sabotagem desconhecida: ${SABOTAGEM:-}"; exit 1 ;;
esac

S=00000000-0000-0000-0000-0000000000a1   # staff (employee)
C1=00000000-0000-0000-0000-0000000000c1  # customer 1
C2=00000000-0000-0000-0000-0000000000c2  # customer 2

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<SQL
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;
-- Supabase concede EXECUTE de função nova a anon/authenticated/service_role por default privileges:
-- é por isso que a migration revoga o anon PELO NOME. Sem isto a prova não veria o grant a revogar.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (id serial PRIMARY KEY, user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$f\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$f\$;

CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, items jsonb, created_at timestamptz DEFAULT now(),
  status text NOT NULL DEFAULT 'enviado', deleted_at timestamptz);
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
-- policies de LEITURA copiadas da prod (2026-10-10)
CREATE POLICY sales_orders_select_customer ON public.sales_orders FOR SELECT
  USING ((SELECT auth.uid()) = customer_user_id);
CREATE POLICY sales_orders_select_staff ON public.sales_orders FOR SELECT
  USING ((SELECT has_role((SELECT auth.uid()), 'master'::app_role)) OR (SELECT has_role((SELECT auth.uid()), 'employee'::app_role)));
GRANT SELECT ON public.sales_orders TO authenticated;

INSERT INTO public.user_roles (user_id, role) VALUES ('$S','employee'), ('$C1','customer'), ('$C2','customer');
INSERT INTO public.sales_orders (customer_user_id, items, created_at) VALUES
  ('$C1', '[{"tint_nome_cor":"Azul","tint_formula_id":"f1"}]', now() - interval '1 day'),     -- cor + app
  ('$C1', '[{"produto":"lixa"},{"tint_nome_cor":"Verde"}]', now() - interval '2 days'),       -- cor (digitada)
  ('$C2', '[{"tint_nome_cor":"Rosa","tint_formula_id":null}]', now() - interval '3 days'),   -- cor; null NÃO é app
  ('$C2', '[{"produto":"verniz"}]', now() - interval '4 days'),                               -- sem cor
  ('$C2', '[{"tint_nome_cor":""}]', now() - interval '5 days'),                               -- cor vazia não conta
  ('$C1', '{"tint_nome_cor":"Objeto","tint_formula_id":"f9"}', now() - interval '1 day'),     -- items não-array: ignorado
  ('$C2', '[{"tint_nome_cor":"Velha","tint_formula_id":"f2"}]', now() - interval '60 days');  -- fora dos 30d
INSERT INTO public.sales_orders (customer_user_id, items, created_at, status, deleted_at) VALUES
  ('$C1', '[{"tint_nome_cor":"Cancelada","tint_formula_id":"f3"}]', now() - interval '1 day', 'cancelado', NULL),  -- não é venda
  ('$C1', '[{"tint_nome_cor":"Orcada","tint_formula_id":"f4"}]', now() - interval '1 day', 'orcamento', NULL),     -- não é venda
  ('$C2', '[{"tint_nome_cor":"Apagada","tint_formula_id":"f5"}]', now() - interval '1 day', 'enviado', now());     -- apagado
SQL

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
P -q -f "$MIG_USADA" > /dev/null
echo "  migration aplicada: $(basename "$MIG")"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# conta COMO o usuário $1 (authenticated + RLS real), com p_dias=$2. Saída: com_cor|pelo_app
como() {
  Pq -q -c "SET test.uid = '$1'; SET ROLE authenticated; SELECT pedidos_com_cor||'|'||pelo_app FROM public.tint_adocao_balcao($2);"
}

echo "── contagem (como staff, sob RLS) ──"
eq "A1 30d: 3 pedidos com cor, 1 pelo app (null, cancelado, orçamento e apagado não contam)" "$(como "$S" 30)" "3|1"
eq "A2 padrão sem argumento = 30d" "$(Pq -q -c "SET test.uid = '$S'; SET ROLE authenticated; SELECT pedidos_com_cor||'|'||pelo_app FROM public.tint_adocao_balcao();")" "3|1"
eq "A3 90d inclui o pedido de 60 dias atrás" "$(como "$S" 90)" "4|2"
eq "A4 p_dias=0 cai no padrão de 30d" "$(como "$S" 0)" "3|1"
eq "A5 p_dias NULL cai no padrão de 30d" "$(como "$S" NULL)" "3|1"

echo "── RLS de quem chama (SECURITY INVOKER) ──"
eq "A6 customer só conta os próprios pedidos" "$(como "$C1" 30)" "2|1"

echo "── postcondição e reaplicação ──"
eq "A7 anon não executa (revogado pelo nome)" \
  "$(Pq -c "SELECT has_function_privilege('anon', 'public.tint_adocao_balcao(integer)', 'EXECUTE')")" "f"
eq "A8 authenticated executa" \
  "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.tint_adocao_balcao(integer)', 'EXECUTE')")" "t"
# dente: a função recriada do zero SEM o REVOKE do anon tem de abortar na P5 (rollback no fim)
SEM_REVOKE="$TMP/sem-revoke.sql"
grep -vF "FROM anon;" "$MIG" > "$SEM_REVOKE"
if out="$(P -q -c "BEGIN;" -c "DROP FUNCTION public.tint_adocao_balcao(integer);" -f "$SEM_REVOKE" -c "ROLLBACK;" 2>&1)"; then
  bad "A9 postcondição tem dente — sem o REVOKE do anon a migration TERMINOU (deveria abortar na P5)"
elif printf '%s' "$out" | grep -q 'P5 FALHOU'; then
  ok "A9 postcondição tem dente — sem o REVOKE do anon a migration aborta na P5"
else
  bad "A9 postcondição — abortou, mas não na P5: $(printf '%s' "$out" | grep -o 'P[0-9] FALHOU' | head -1)"
fi
if P -q -f "$MIG_USADA" > /dev/null 2>&1; then ok "A10 reaplicar a migration é no-op (termina verde)"; else bad "A10 reaplicar a migration falhou"; fi
eq "A11 reaplicar não devolve o EXECUTE ao anon" \
  "$(Pq -c "SELECT has_function_privilege('anon', 'public.tint_adocao_balcao(integer)', 'EXECUTE')")" "f"

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1

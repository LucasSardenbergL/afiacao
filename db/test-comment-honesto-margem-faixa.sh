#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 de 20260813225057_fu4f_fase3_comment_honesto_margem_faixa.sql    ║
# ║    bash db/test-comment-honesto-margem-faixa.sh > log 2>&1; echo $?          ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                              ║
# ║  O que prova:                                                                ║
# ║   · o COMMENT novo entra e a frase FALSA ("byte a byte") sai                  ║
# ║   · `prosrc` NÃO muda ⇒ a impressão digital do #1543 segue válida e a         ║
# ║     validação pós-apply dele continua dando `t` nos 11 checks                 ║
# ║   · o guard `IF EXISTS` deixa a migration rodar num banco SEM a função        ║
# ║     (restore de DR anterior à 20260726170000) em vez de abortar               ║
# ║   · idempotência: re-aplicar não degrada                                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
# 5474: 5471 é do #1495, 5472 do helper compartilhado, 5473 do harness da RPC.
PORT="${PGPORT_TEST:-5474}"
SLUG="fu4f3comment"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

MIG_RPC="$REPO_ROOT/supabase/migrations/20260726170000_fu4f_fase3_carteira_margem_faixa.sql"
MIG_COM="$REPO_ROOT/supabase/migrations/20260813225057_fu4f_fase3_comment_honesto_margem_faixa.sql"

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
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "-- A. o guard, ANTES de a função existir (cenário de restore de DR) --"
# ⚠️ Este é o assert que justifica o DO/IF EXISTS. `COMMENT ON FUNCTION` de objeto ausente é
# ERRO, e um restore que reaplique as migrations em ordem pararia aqui. Roda ANTES de qualquer
# outra coisa, no banco ainda vazio.
if P -q -f "$MIG_COM" >/dev/null 2>&1; then
  ok "A1 a migration roda sem a função existir (guard IF EXISTS segura)"
else
  bad "A1 a migration ABORTOU num banco sem a função — o guard não está segurando"
fi

# ── setup mínimo para a RPC existir (espelha o harness da própria RPC) ───────
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE SCHEMA IF NOT EXISTS private;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;

CREATE TABLE public.carteira_teste (cid uuid, dono uuid);
CREATE TABLE public.farmer_algorithm_config (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, omie_codigo_produto bigint UNIQUE);
CREATE TABLE public.product_costs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                   product_id uuid UNIQUE, cost_final numeric, cost_price numeric);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, status text, deleted_at timestamptz);
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                                 sales_order_id uuid, customer_user_id uuid,
                                 omie_codigo_produto bigint, product_id uuid,
                                 quantity numeric, unit_price numeric);
CREATE TABLE public.cliente_classificacao (user_id uuid PRIMARY KEY, excluir_da_carteira boolean);

CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_carteira',true),'')::boolean,false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM public.carteira_teste c
                                             WHERE c.cid=_customer_user_id AND c.dono=_uid) $f$;
SQL

P -q -f "$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"
P -q -f "$MIG_RPC"

DIGITAL_ANTES="$(Pq -q -c "SELECT md5(regexp_replace(prosrc,'[[:space:]]+',' ','g')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")"

echo "-- B. o COMMENT muda, o corpo NÃO --"
eq "B1 baseline: o comentário da 170000 AFIRMA 'byte a byte'" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%byte a byte%')::text;")" "true"

P -q -f "$MIG_COM"

eq "B2 a frase FALSA saiu do catálogo" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%byte a byte%')::text;")" "false"
# Ancora no NÚMERO medido, não em palavra solta: um comentário que só trocasse "byte a byte" por
# "aproximadamente igual" passaria num assert de ausência, e continuaria mentindo por omissão.
eq "B3 o comentário novo carrega a medição (30.833 × 20.597)" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%30.833 pedidos contra 20.597%')::text;")" "true"
eq "B4 e diz explicitamente que o score MUDA" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%health score MUDA%')::text;")" "true"
# ⚠️ "muda" sozinho seria alarme sem tamanho. O #1721 mediu o delta sobre as personas REAIS de
# prod, e o comentário tem de carregar o número — senão troca uma imprecisão (equivalência falsa)
# por outra (pânico sem escala).
eq "B4b o comentário carrega o delta medido pelo #1721 (59,5% / 14,5)" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%59,5%' AND obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%14,5%')::text;")" "true"
# O #1721 REFUTOU o que o comentário do hook do #1543 afirmava ("a ordem da agenda pode mudar").
# Nenhuma quota lê o health score. Gravar isso no catálogo impede que a próxima pessoa reintroduza
# o medo — que foi meu, e estava errado.
eq "B4c e registra que a AGENDA NAO muda (refutado pelo #1721)" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%AGENDA NAO muda%')::text;")" "true"

# ⚠️ O assert que protege o #1543: se `prosrc` mudasse, a impressão digital gravada em
# db/valida-fu4f-fase3-carteira-margem-faixa.sql viraria mentira e o founder receberia `f` num
# banco correto — falso alarme que pararia um deploy.
eq "B5 o corpo (prosrc) NÃO mudou — a digital do #1543 segue válida" \
   "$(Pq -q -c "SELECT md5(regexp_replace(prosrc,'[[:space:]]+',' ','g')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")" \
   "$DIGITAL_ANTES"

echo "-- C. a validação pós-apply do #1543 continua verde --"
# ⚠️ A fase 3c (20260813234112) entra AQUI, e a posição é o ponto: depois do B5 — que prova que
# `COMMENT` não toca `prosrc`, e por isso tem de rodar com o corpo ainda intocado — e antes do C1,
# que roda o validador compartilhado. A 3c põe `motivo` sob cap_custo_ler e MUDA o corpo, então a
# impressão digital em db/valida-*.sql passou a ser a da CADEIA (169677fe…, era 075209b9…). Sem
# esta linha o validador acusaria `f` no c10 — vermelho por defasagem de estado, não por defeito
# desta migration, e a leitura natural desse vermelho mandaria a próxima pessoa para o lado errado.
P -q -f "$REPO_ROOT/supabase/migrations/20260813234112_carteira_margem_faixa_motivo_gate_custo.sql"
VAL="$(Pq -q -f "$REPO_ROOT/db/valida-fu4f-fase3-carteira-margem-faixa.sql")"
eq "C1 os 11 checks do #1543 seguem 't' depois desta migration" \
   "$(printf '%s' "$VAL" | tr '|' '\n' | sort -u | tr -d '\n')" "t"

echo "-- D. idempotência --"
# ⚠️ O baseline do D2 é capturado AQUI, e não é mais o `$DIGITAL_ANTES` do topo. A propriedade que
# este assert prova é "re-aplicar o COMMENT não mexe no corpo" — ela vale contra o corpo VIGENTE,
# qualquer que ele seja. Prendê-la à digital do #1543 fazia o assert medir, de quebra, "o corpo
# nunca mudou desde o #1543", que a fase 3c revoga de propósito: o vermelho apareceria aqui, longe
# da causa, dizendo "COMMENT mexeu no corpo" — uma acusação FALSA contra a migration errada.
DIGITAL_VIGENTE="$(Pq -q -c "SELECT md5(regexp_replace(prosrc,'[[:space:]]+',' ','g')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")"
P -q -f "$MIG_COM"
eq "D1 re-aplicar mantém o comentário novo" \
   "$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%health score MUDA%')::text;")" "true"
eq "D2 re-aplicar não mexe no corpo" \
   "$(Pq -q -c "SELECT md5(regexp_replace(prosrc,'[[:space:]]+',' ','g')) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_carteira_margem_faixa';")" \
   "$DIGITAL_VIGENTE"

echo "-- E. FALSIFICAÇÃO --"
# Sem isto, B2/B3/B4 seriam decorativos: um arquivo que não aplicasse NADA deixaria o comentário
# velho em pé, e só um assert com dente distingue "corrigi" de "não fiz nada".
SAB="/tmp/sabota-${SLUG}.sql"
sed 's/COMMENT ON FUNCTION public.get_carteira_margem_faixa() IS/RAISE NOTICE %sabotado%; -- COMMENT ON FUNCTION public.get_carteira_margem_faixa() IS/' "$MIG_COM" > "$SAB"
if cmp -s "$SAB" "$MIG_COM"; then
  bad "E0 SABOTAGEM NÃO APLICADA — o sed não casou nada"
else
  # restaura o comentário FALSO e tenta aplicar a versão sabotada (que não comenta nada)
  P -q -f "$MIG_RPC"
  P -q -f "$SAB" >/dev/null 2>&1 || true
  RES="$(Pq -q -c "SELECT (obj_description('public.get_carteira_margem_faixa()'::regprocedure) LIKE '%byte a byte%')::text;")"
  if [ "$RES" = "true" ]; then
    ok "E1 migration sabotada NÃO corrige o comentário → B2 ficaria vermelho (assert tem dente)"
    PASS=$((PASS))
  else
    bad "E1 ASSERT SEM DENTE: o comentário ficou correto mesmo com a migration sabotada"
  fi
  # restaura o estado bom
  P -q -f "$MIG_COM"
fi

echo "========================================"
echo "  $PASS verde(s), $FAIL vermelho(s)"
[ "$FAIL" -eq 0 ] || exit 1
echo "  TODOS OS ASSERTS PASSARAM"

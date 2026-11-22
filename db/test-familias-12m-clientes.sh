#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17                 # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5471}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="familias12m"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA de que a
# major é a esperada — `-x` sozinho aceita um initdb de outra versão. Fail-closed: PG ausente é
# ERRO, nunca skip; no macOS o helper também contorna o keg-only do brew. Hardcodar /opt/homebrew
# é o que mantinha a prova FORA do CI (runner ubuntu) — e portabilidade é pré-requisito para ela
# entrar no núcleo, o caminho obrigatório do merge: um fragmento PRÓPRIO `db/nucleo-ci.d/<prova>.txt`
# (nunca no fim do `db/nucleo-ci.txt` — conflitava com todo PR irmão).
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stub mínimo das 4 tabelas que a função lê)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.farmer_client_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid, customer_user_id uuid);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, status text, deleted_at timestamptz, order_date_kpi date, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, familia text);
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, sales_order_id uuid REFERENCES public.sales_orders(id), product_id uuid REFERENCES public.omie_products(id));
-- RLS de order_items como em prod (customer vê só os próprios) — é o que prova o SECURITY INVOKER.
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY oi_customer ON public.order_items FOR SELECT USING (auth.uid() = customer_user_id);
GRANT SELECT ON public.farmer_client_scores, public.sales_orders, public.omie_products, public.order_items TO authenticated, anon, service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20261121230000_familias_12m_clientes.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (vendedor A: c1..c4 + c6; vendedor B: c5)
# ══════════════════════════════════════════════════════════════════════════════
FA=aaaaaaaa-0000-0000-0000-000000000001; FB=bbbbbbbb-0000-0000-0000-000000000001
C1=c1000000-0000-0000-0000-000000000001  # 3 itens: famílias F1, F2, F2 → 2 (DISTINTAS, não itens)
C2=c2000000-0000-0000-0000-000000000002  # só item de 366 dias atrás → AUSENTE (fora da janela)
C3=c3000000-0000-0000-0000-000000000003  # só item de pedido cancelado → AUSENTE
C4=c4000000-0000-0000-0000-000000000004  # 2 itens SEM família → familias NULL, itens_sem_familia 2
C5=c5000000-0000-0000-0000-000000000005  # carteira do B, F1 → não aparece na chamada do A
C6=c6000000-0000-0000-0000-000000000006  # borda: item em hoje−365 (entra) + order_date_kpi NULL via created_at (F3)
P -q <<SQL
INSERT INTO public.farmer_client_scores (farmer_id, customer_user_id) VALUES
 ('$FA','$C1'),('$FA','$C2'),('$FA','$C3'),('$FA','$C4'),('$FA','$C6'),('$FB','$C5');
INSERT INTO public.omie_products VALUES
 ('11111111-0000-0000-0000-00000000000f','F1'),('22222222-0000-0000-0000-00000000000f','F2'),
 ('22222222-0000-0000-0000-0000000000ff','F2'),('33333333-0000-0000-0000-00000000000f','F3'),
 ('99999999-0000-0000-0000-00000000000f',NULL);
WITH h AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d)
INSERT INTO public.sales_orders (id, status, deleted_at, order_date_kpi, created_at)
SELECT v.id::uuid, v.st, NULL, v.dia, now() FROM h, LATERAL (VALUES
 ('00000000-0000-0000-0000-0000000000a1','faturado', h.d - 10),
 ('00000000-0000-0000-0000-0000000000a2','faturado', h.d - 366),
 ('00000000-0000-0000-0000-0000000000a3','cancelado', h.d - 5),
 ('00000000-0000-0000-0000-0000000000a4','faturado', h.d - 20),
 ('00000000-0000-0000-0000-0000000000a5','faturado', h.d - 3),
 ('00000000-0000-0000-0000-0000000000a6','faturado', h.d - 365),
 ('00000000-0000-0000-0000-0000000000a7','faturado', NULL::date)) AS v(id, st, dia);
INSERT INTO public.order_items (customer_user_id, sales_order_id, product_id) VALUES
 ('$C1','00000000-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-00000000000f'),
 ('$C1','00000000-0000-0000-0000-0000000000a1','22222222-0000-0000-0000-00000000000f'),
 ('$C1','00000000-0000-0000-0000-0000000000a1','22222222-0000-0000-0000-0000000000ff'),
 ('$C2','00000000-0000-0000-0000-0000000000a2','33333333-0000-0000-0000-00000000000f'),
 ('$C3','00000000-0000-0000-0000-0000000000a3','11111111-0000-0000-0000-00000000000f'),
 ('$C4','00000000-0000-0000-0000-0000000000a4','99999999-0000-0000-0000-00000000000f'),
 ('$C4','00000000-0000-0000-0000-0000000000a4',NULL),
 ('$C5','00000000-0000-0000-0000-0000000000a5','11111111-0000-0000-0000-00000000000f'),
 ('$C6','00000000-0000-0000-0000-0000000000a6','11111111-0000-0000-0000-00000000000f'),
 ('$C6','00000000-0000-0000-0000-0000000000a7','33333333-0000-0000-0000-00000000000f');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (uma suíte; roda no CONTROLE e em cada sabotagem, na MESMA invocação)
# ══════════════════════════════════════════════════════════════════════════════
# Sentinelas: valores do SEED (uuid|n|n|n), nunca texto emitido pela função.
SVC="SET test.role='service_role'; SET ROLE service_role;"
suite() {
  local V
  # A1 carteira do A como service_role (vê tudo): c1=2 distintas de 3 itens · c4=NULL/2 sem família · c6=2 (borda+created_at).
  #    AUSENTES: c2 (366d), c3 (cancelado), c5 (outra carteira). Ordem estável por customer_user_id.
  V=$(Pq -c "$SVC SELECT string_agg(customer_user_id||'|'||coalesce(familias_12m::text,'N')||'|'||itens_12m||'|'||itens_sem_familia, ',' ORDER BY ord) FROM (SELECT f.*, row_number() OVER () ord FROM public.familias_12m_clientes('$FA', NULL) f) x;" | tail -1)
  eq "A1 carteira do A (distintas, janela, status, sem família=NULL, outra carteira fora, ordem)" "$V" "$C1|2|3|0,$C4|N|2|2,$C6|2|2|0"
  # A2 filtro por cliente
  V=$(Pq -c "$SVC SELECT coalesce(string_agg(customer_user_id||'|'||familias_12m, ','),'vazio') FROM public.familias_12m_clientes(NULL, '$C1');" | tail -1)
  eq "A2 por cliente (c1)" "$V" "$C1|2"
  # A3 sem filtro → zero linhas (nunca a base inteira)
  V=$(Pq -c "$SVC SELECT count(*) FROM public.familias_12m_clientes(NULL, NULL);" | tail -1)
  eq "A3 sem filtro = 0 linhas" "$V" "0"
  # A4 INVOKER: customer c1 chamando a carteira do A só enxerga os próprios itens (RLS de order_items vale)
  V=$(Pq -c "SET test.uid='$C1'; SET ROLE authenticated; SELECT coalesce(string_agg(customer_user_id::text, ','),'vazio') FROM public.familias_12m_clientes('$FA', NULL);" | tail -1)
  eq "A4 SECURITY INVOKER (RLS do chamador)" "$V" "$C1"
  # A5 anon NÃO executa: SQLSTATE 42501 esperada; qualquer outro erro relança (Lei #2)
  V=$(Pq -c "SET ROLE anon; DO \$\$ BEGIN PERFORM public.familias_12m_clientes(NULL, NULL); RAISE EXCEPTION 'ANON-EXECUTOU' USING ERRCODE = 'P0001'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'negado'; WHEN OTHERS THEN RAISE; END \$\$; SELECT 'barrado';" 2>&1 | tail -1 || true)
  eq "A5 anon barrado por 42501" "$V" "barrado"
}

aplica_sabotada() {  # $1 = rótulo, $2 = expressão sed; corta a postcondição (a sabotagem a violaria de propósito)
  local tmp; tmp="$(mktemp)"
  sed -e "$2" "$MIG" | sed '/^DO \$post\$/,$d' > "$tmp"
  if cmp -s <(sed '/^DO \$post\$/,$d' "$MIG") "$tmp"; then rm -f "$tmp"; echo "  ⛔ sabotagem '$1' NÃO alterou o SQL (sed não casou)"; return 1; fi
  P -q -f "$tmp" >/dev/null; rm -f "$tmp"
}
restaura() { P -q -c "DROP FUNCTION public.familias_12m_clientes(uuid, uuid);" && P -q -f "$MIG" >/dev/null; }

echo "═══ CONTROLE (migration real) ═══"
suite
CONTROLE_FAIL=$FAIL
if [ "$CONTROLE_FAIL" -ne 0 ] || [ "$PASS" -lt 5 ]; then
  echo "CONTROLE NÃO ESTÁ VERDE (pass=$PASS fail=$FAIL) — abortando antes de sabotar"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — cada sabotagem precisa deixar a suíte VERMELHA; depois restaura a real.
# ══════════════════════════════════════════════════════════════════════════════
FALS_OK=0; FALS_BAD=0
sabota() {  # $1 rótulo, $2 sed
  local p0=$PASS f0=$FAIL
  echo "═══ SABOTAGEM: $1 ═══"
  if ! aplica_sabotada "$1" "$2"; then FALS_BAD=$((FALS_BAD+1)); restaura; return; fi
  suite
  local nf=$((FAIL - f0))
  PASS=$p0; FAIL=$f0   # a contagem das sabotagens não entra no placar do controle
  if [ "$nf" -gt 0 ]; then FALS_OK=$((FALS_OK+1)); echo "  🦷 vermelha como esperado ($nf assert(s) falharam)";
  else FALS_BAD=$((FALS_BAD+1)); echo "  ⛔ SUÍTE SEGUIU VERDE — assert sem dente"; fi
  restaura
}
sabota "sem filtro de status"          "s/AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')/AND true/"
sabota "itens em vez de distintas"     "s/ELSE count(DISTINCT i.familia)::int END/ELSE count(*)::int END/"
sabota "sem-família vira 0"            "s/CASE WHEN count(i.familia) = 0 THEN NULL/CASE WHEN false THEN NULL/"
sabota "janela de 366 dias"            "s/BETWEEN h.d - 365 AND h.d/BETWEEN h.d - 366 AND h.d/"
sabota "janela de 364 dias"            "s/BETWEEN h.d - 365 AND h.d/BETWEEN h.d - 364 AND h.d/"
sabota "sem filtro de carteira"        "s/AND fcs.farmer_id = p_farmer_id/AND true/"
sabota "sem guarda de filtro nulo"     "s/WHERE p_farmer_id IS NOT NULL/WHERE true OR p_farmer_id IS NOT NULL/; s/AND fcs.farmer_id = p_farmer_id/AND (p_farmer_id IS NULL OR fcs.farmer_id = p_farmer_id)/"
sabota "SECURITY DEFINER"              "s/^SECURITY INVOKER/SECURITY DEFINER/"
sabota "anon executa"                  "s/^REVOKE ALL ON FUNCTION public.familias_12m_clientes(uuid, uuid) FROM anon;/GRANT EXECUTE ON FUNCTION public.familias_12m_clientes(uuid, uuid) TO anon;/"
sabota "sem fallback created_at"       "s/COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America\/Sao_Paulo')::date)/so.order_date_kpi/"

# Pós-restauração: a real volta verde (prova que restaura() não deixou resíduo de sabotagem)
echo "═══ CONTROLE PÓS-RESTAURAÇÃO ═══"
suite

echo "═══ RESULTADO: controle pass=$PASS fail=$FAIL · falsificação dentes=$FALS_OK sem-dente=$FALS_BAD ═══"
if [ "$FAIL" -ne 0 ] || [ "$FALS_BAD" -ne 0 ] || [ "$FALS_OK" -ne 10 ]; then exit 1; fi
echo "PASS=$PASS  FAIL=$FAIL"
echo "PROVA-FAMILIAS-12M-OK"

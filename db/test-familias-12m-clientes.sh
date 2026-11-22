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
# ZONA 3 — SEED (vendedor A: c1..c4, c6..c10; vendedor B: c5)
# ══════════════════════════════════════════════════════════════════════════════
FA=aaaaaaaa-0000-0000-0000-000000000001; FB=bbbbbbbb-0000-0000-0000-000000000001
C1=c1000000-0000-0000-0000-000000000001  # 3 itens: F1, F2, F2 (2 produtos da F2) → 2 famílias DISTINTAS
C2=c2000000-0000-0000-0000-000000000002  # só item em hoje−365 → AUSENTE (fora das 365 datas)
C3=c3000000-0000-0000-0000-000000000003  # só item de pedido cancelado → AUSENTE
C4=c4000000-0000-0000-0000-000000000004  # 2 itens SEM família (produto sem família + product_id NULL) → NULL
C5=c5000000-0000-0000-0000-000000000005  # carteira do B (F1) → não aparece na chamada do A
C6=c6000000-0000-0000-0000-000000000006  # borda: item em hoje−364 (F1, entra) + order_date_kpi NULL → created_at (F3)
C7=c7000000-0000-0000-0000-000000000007  # só pedido soft-deleted → AUSENTE
C8=c8000000-0000-0000-0000-000000000008  # só pedido com data FUTURA (hoje+1) → AUSENTE
C9=c9000000-0000-0000-0000-000000000009  # família PARCIAL: F1 + item sem família → 1 conhecida, 1 sem família
P -q <<SQL
INSERT INTO public.farmer_client_scores (farmer_id, customer_user_id) VALUES
 ('$FA','$C1'),('$FA','$C2'),('$FA','$C3'),('$FA','$C4'),('$FA','$C6'),('$FA','$C7'),('$FA','$C8'),('$FA','$C9'),('$FB','$C5');
INSERT INTO public.omie_products VALUES
 ('11111111-0000-0000-0000-00000000000f','F1'),('22222222-0000-0000-0000-00000000000f','F2'),
 ('22222222-0000-0000-0000-0000000000ff','F2'),('33333333-0000-0000-0000-00000000000f','F3'),
 ('99999999-0000-0000-0000-00000000000f',NULL);
WITH h AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS d)
INSERT INTO public.sales_orders (id, status, deleted_at, order_date_kpi, created_at)
SELECT v.id::uuid, v.st, v.del, v.dia, now() FROM h, LATERAL (VALUES
 ('00000000-0000-0000-0000-0000000000a1','faturado',  NULL::timestamptz, h.d - 10),
 ('00000000-0000-0000-0000-0000000000a2','faturado',  NULL, h.d - 365),
 ('00000000-0000-0000-0000-0000000000a3','cancelado', NULL, h.d - 5),
 ('00000000-0000-0000-0000-0000000000a4','faturado',  NULL, h.d - 20),
 ('00000000-0000-0000-0000-0000000000a5','faturado',  NULL, h.d - 3),
 ('00000000-0000-0000-0000-0000000000a6','faturado',  NULL, h.d - 364),
 ('00000000-0000-0000-0000-0000000000a7','faturado',  NULL, NULL::date),
 ('00000000-0000-0000-0000-0000000000a8','faturado',  now(), h.d - 2),
 ('00000000-0000-0000-0000-0000000000a9','faturado',  NULL, h.d + 1),
 ('00000000-0000-0000-0000-0000000000b1','faturado',  NULL, h.d - 1)) AS v(id, st, del, dia);
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
 ('$C6','00000000-0000-0000-0000-0000000000a7','33333333-0000-0000-0000-00000000000f'),
 ('$C7','00000000-0000-0000-0000-0000000000a8','11111111-0000-0000-0000-00000000000f'),
 ('$C8','00000000-0000-0000-0000-0000000000a9','11111111-0000-0000-0000-00000000000f'),
 ('$C9','00000000-0000-0000-0000-0000000000b1','11111111-0000-0000-0000-00000000000f'),
 ('$C9','00000000-0000-0000-0000-0000000000b1','99999999-0000-0000-0000-00000000000f');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS. `suite` grava em FALHOU os IDs vermelhos; cada sabotagem exige o SEU ID vermelho.
# Sentinelas = valores do SEED (uuid|n|n|n), nunca texto emitido pela função.
# ══════════════════════════════════════════════════════════════════════════════
SVC="SET test.role='service_role'; SET ROLE service_role;"
FALHOU=""
chk() { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; FALHOU="$FALHOU ${1%% *}"; fi; }
tuplas() { Pq -c "$SVC SELECT coalesce(string_agg(customer_user_id||'|'||coalesce(familias_12m::text,'N')||'|'||itens_12m||'|'||itens_sem_familia, ',' ORDER BY customer_user_id),'vazio') FROM public.familias_12m_clientes($1);" 2>&1 | tail -1 || true; }
suite() {
  local V
  FALHOU=""
  # A1 carteira do A: c1 2 distintas de 3 · c4 NULL (2 sem família) · c6 2 (borda d−364 + created_at) · c9 parcial 1/2/1.
  #    AUSENTES: c2 (d−365), c3 (cancelado), c5 (carteira B), c7 (soft-delete), c8 (futuro).
  chk "A1 carteira do A" "$(tuplas "'$FA', NULL")" "$C1|2|3|0,$C4|N|2|2,$C6|2|2|0,$C9|1|2|1"
  # A2 por cliente: exatamente 1 linha, tupla inteira
  chk "A2 por cliente (c1)" "$(tuplas "NULL, '$C1'")" "$C1|2|3|0"
  # A3 sem filtro → 0 linhas · A3b os dois filtros → 0 linhas (modos exclusivos)
  chk "A3 sem filtro" "$(tuplas "NULL, NULL")" "vazio"
  chk "A3b filtro duplo" "$(tuplas "'$FA', '$C1'")" "vazio"
  # A4 INVOKER: customer c1 chamando a carteira do A só enxerga os PRÓPRIOS itens (RLS de order_items vale)
  V=$(Pq -c "SET test.uid='$C1'; SET ROLE authenticated; SELECT coalesce(string_agg(customer_user_id||'|'||familias_12m, ','),'vazio') FROM public.familias_12m_clientes('$FA', NULL);" 2>&1 | tail -1 || true)
  chk "A4 SECURITY INVOKER" "$V" "$C1|2"
  # A5 ACL efetiva: PUBLIC e anon sem EXECUTE; authenticated e service_role com
  V=$(Pq -c "SELECT has_function_privilege('public','public.familias_12m_clientes(uuid,uuid)','EXECUTE')::text||has_function_privilege('anon','public.familias_12m_clientes(uuid,uuid)','EXECUTE')::text||has_function_privilege('authenticated','public.familias_12m_clientes(uuid,uuid)','EXECUTE')::text||has_function_privilege('service_role','public.familias_12m_clientes(uuid,uuid)','EXECUTE')::text;" 2>&1 | tail -1 || true)
  chk "A5 ACL efetiva" "$V" "falsefalsetruetrue"
}

CORPO_REAL="$(sed '/^DO \$post\$/,$d' "$MIG")"
aplica_sabotada() {  # $1 = expressão sed; corta a postcondição (a sabotagem a violaria de propósito)
  local tmp; tmp="$(mktemp)"
  printf '%s\n' "$CORPO_REAL" | sed -e "$1" > "$tmp"
  if [ "$(cat "$tmp")" = "$CORPO_REAL" ]; then rm -f "$tmp"; echo "  ⛔ sed não casou — sabotagem não alterou o SQL"; return 1; fi
  P -q -c "DROP FUNCTION IF EXISTS public.familias_12m_clientes(uuid, uuid);" >/dev/null || { rm -f "$tmp"; echo "  ⛔ DROP falhou"; return 1; }
  P -q -f "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; echo "  ⛔ sabotada NÃO aplicou (psql falhou)"; return 1; }
  rm -f "$tmp"
}
restaura() { P -q -c "DROP FUNCTION IF EXISTS public.familias_12m_clientes(uuid, uuid);" >/dev/null; P -q -f "$MIG" >/dev/null; }

echo "═══ CONTROLE (migration real) ═══"
suite
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 6 ]; then
  echo "CONTROLE NÃO ESTÁ VERDE (pass=$PASS fail=$FAIL) — abortando antes de sabotar"; exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — na MESMA invocação do controle verde. Cada sabotagem exige o assert ESPERADO vermelho.
# ══════════════════════════════════════════════════════════════════════════════
FALS_OK=0; FALS_BAD=0; N_SAB=0
sabota() {  # $1 rótulo, $2 assert que DEVE ficar vermelho, $3 sed
  local p0=$PASS f0=$FAIL
  N_SAB=$((N_SAB+1))
  echo "═══ SABOTAGEM: $1 (exige $2 vermelho) ═══"
  if ! aplica_sabotada "$3"; then FALS_BAD=$((FALS_BAD+1)); restaura; return 0; fi
  suite
  PASS=$p0; FAIL=$f0   # a contagem das sabotagens não entra no placar do controle
  case " $FALHOU " in
    *" $2 "*) FALS_OK=$((FALS_OK+1)); echo "  🦷 $2 vermelho como esperado (vermelhos:$FALHOU)";;
    *) FALS_BAD=$((FALS_BAD+1)); echo "  ⛔ $2 SEGUIU VERDE (vermelhos:${FALHOU:- nenhum}) — assert sem dente";;
  esac
  restaura
}
sabota "sem filtro de status"        A1  "s/AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')/AND true/"
sabota "itens em vez de distintas"   A1  "s/ELSE count(DISTINCT i.familia)::int END/ELSE count(*)::int END/"
sabota "sem-família vira 0"          A1  "s/CASE WHEN count(i.familia) = 0 THEN NULL/CASE WHEN false THEN NULL/"
sabota "janela 366 datas"            A1  "s/BETWEEN h.d - 364 AND h.d/BETWEEN h.d - 365 AND h.d/"
sabota "janela 364 datas"            A1  "s/BETWEEN h.d - 364 AND h.d/BETWEEN h.d - 363 AND h.d/"
sabota "sem teto (pedido futuro)"    A1  "s/BETWEEN h.d - 364 AND h.d/>= h.d - 364/"
sabota "sem filtro de soft-delete"   A1  "s/AND so.deleted_at IS NULL/AND true/"
sabota "sem filtro de carteira"      A1  "s/AND fcs.farmer_id = p_farmer_id/AND true/"
sabota "sem fallback created_at"     A1  "s/COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America\/Sao_Paulo')::date)/so.order_date_kpi/"
sabota "sem guarda de filtro nulo"   A3  "s/WHERE p_farmer_id IS NOT NULL/WHERE true/; s/AND fcs.farmer_id = p_farmer_id/AND (p_farmer_id IS NULL OR fcs.farmer_id = p_farmer_id)/"
sabota "modos não exclusivos"        A3b "/AND p_customer_user_id IS NULL\$/d; /AND p_farmer_id IS NULL\$/d"
sabota "SECURITY DEFINER"            A4  "s/^SECURITY INVOKER/SECURITY DEFINER/"
sabota "anon executa"                A5  "s/^REVOKE ALL ON FUNCTION public.familias_12m_clientes(uuid, uuid) FROM anon;/GRANT EXECUTE ON FUNCTION public.familias_12m_clientes(uuid, uuid) TO anon;/"

echo "═══ CONTROLE PÓS-RESTAURAÇÃO ═══"
suite

echo "═══ RESULTADO: controle pass=$PASS fail=$FAIL · sabotagens=$N_SAB dentes=$FALS_OK sem-dente=$FALS_BAD ═══"
echo "PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -ne 0 ] || [ "$FALS_BAD" -ne 0 ] || [ "$FALS_OK" -ne "$N_SAB" ] || [ "$N_SAB" -lt 13 ]; then exit 1; fi
echo "PROVA-FAMILIAS-12M-OK"

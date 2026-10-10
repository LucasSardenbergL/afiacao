#!/usr/bin/env bash
# ╔═══════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — margem por cliente só sobre pedidos dos últimos 12 meses [money-path] ║
# ║ Migration: supabase/migrations/20261009220000_margem_cliente_janela_12m.sql         ║
# ║ Rode: bash db/test-margem-cliente-janela-12m.sh > /tmp/t.log 2>&1; echo "exit=$?"   ║
# ║ (NÃO pipe pra tail — engole o exit≠0.)                                              ║
# ║                                                                                     ║
# ║ Cada rodada aplica a migration (REAL ou uma CÓPIA sabotada) num banco limpo e roda  ║
# ║ a MESMA bateria. Na MESMA invocação: a real tem de dar 0 falhas (CONTROLE) e cada   ║
# ║ sabotagem tem de derrubar o assert que diz proteger. As sabotagens mantêm o texto   ║
# ║ `interval '12 months'` — a pós-condição da migration (que só procura o texto) passa ║
# ║ nelas de propósito: quem tem dente aqui são os asserts de VALOR, não o grep.        ║
# ╚═══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5491}"
SLUG="margem-cliente-janela-12m"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261009220000_margem_cliente_janela_12m.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

# Banco limpo por rodada: stubs + schema mínimo + seeds. A função sob teste vem SEMPRE do arquivo.
prepara() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q > /dev/null <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, omie_codigo_produto bigint UNIQUE);
CREATE TABLE public.product_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid UNIQUE,
  cost_final numeric, cost_price numeric);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, status text, deleted_at timestamptz, created_at timestamptz NOT NULL);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, customer_user_id uuid,
  omie_codigo_produto bigint, quantity numeric, unit_price numeric);
CREATE TABLE public.cliente_classificacao (user_id uuid PRIMARY KEY, excluir_da_carteira boolean);

-- Produtos: 1 = custo 60 · 2 = custo 90 · 3 = cost_final 0 (lixo) e cost_price 50 (fallback)
INSERT INTO public.omie_products VALUES
  ('00000000-0000-0000-0000-0000000000a1', 1),
  ('00000000-0000-0000-0000-0000000000a2', 2),
  ('00000000-0000-0000-0000-0000000000a3', 3);
INSERT INTO public.product_costs (product_id, cost_final, cost_price) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 60, NULL),
  ('00000000-0000-0000-0000-0000000000a2', 90, NULL),
  ('00000000-0000-0000-0000-0000000000a3', 0, 50);

-- ped(id_pedido, idade, status, deletado) — idade relativa a now(), para o teste não envelhecer.
CREATE FUNCTION pg_temp.ped(p uuid, idade interval, st text DEFAULT 'faturado', del boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sales_orders VALUES (p, st, CASE WHEN del THEN now() END, now() - idade);
$f$;
CREATE FUNCTION pg_temp.item(p uuid, c uuid, cod bigint, preco numeric)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
  VALUES (p, c, cod, 1, preco);
$f$;

-- A: 1 item recente (100 / custo 60) + 1 item de 3 anos (100 / custo 90).
--    12m → 40.00 · lifetime → 25.00. É o viés que a decisão corrige.
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000001', '30 days');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000001', 'aa000000-0000-0000-0000-000000000001', 1, 100);
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000002', '3 years');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000002', 'aa000000-0000-0000-0000-000000000001', 2, 100);
-- B: só compra de 13 meses atrás → FORA do resultado (ausente ≠ zero).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000003', '13 months');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000003', 'bb000000-0000-0000-0000-000000000002', 1, 100);
-- C: borda — 12 meses MENOS 1 dia (dentro, preço 100 → 40.00) e 12 meses MAIS 1 dia (fora, 100/90).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000004', '12 months' - interval '1 day');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000004', 'cc000000-0000-0000-0000-000000000003', 1, 100);
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000005', '12 months' + interval '1 day');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000005', 'cc000000-0000-0000-0000-000000000003', 2, 100);
-- D: recente mas excluir_da_carteira → fora (regra preexistente preservada).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000006', '10 days');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000006', 'dd000000-0000-0000-0000-000000000004', 1, 100);
INSERT INTO public.cliente_classificacao VALUES ('dd000000-0000-0000-0000-000000000004', true);
-- E: recente mas cancelado → fora (denylist preservada).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000007', '10 days', 'cancelado');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000007', 'ee000000-0000-0000-0000-000000000005', 1, 100);
-- F: recente mas deletado → fora (deleted_at preservado).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000008', '10 days', 'faturado', true);
SELECT pg_temp.item('10000000-0000-0000-0000-000000000008', 'ff000000-0000-0000-0000-000000000006', 1, 100);
-- G: recente com preço 0 → presente, margem NULL, itens_sem_preco 1 (3 pernas preservadas).
SELECT pg_temp.ped('10000000-0000-0000-0000-000000000009', '10 days');
SELECT pg_temp.item('10000000-0000-0000-0000-000000000009', '99000000-0000-0000-0000-000000000007', 1, 0);
-- H: recente, produto com cost_final 0 → cai no cost_price 50 → margem 50.00.
SELECT pg_temp.ped('10000000-0000-0000-0000-00000000000a', '10 days');
SELECT pg_temp.item('10000000-0000-0000-0000-00000000000a', '88000000-0000-0000-0000-000000000008', 3, 100);
SQL
}

FAIL=0; PASS=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHOU $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# Margem do cliente, ou AUSENTE se ele não está no resultado (≠ NULL, que é "presente sem margem").
m() { Pq -c "SELECT COALESCE((SELECT COALESCE(margem_pct::text,'NULL') FROM private.margem_cliente_agregada() WHERE customer_user_id='$1'),'AUSENTE');"; }

# Uma rodada = banco limpo + aplica $1 + bateria. Devolve (em FAIL) quantos asserts caíram.
rodada() {
  local arquivo="$1" log="$TMP/apply.log"
  FAIL=0; PASS=0
  prepara
  if ! P -f "$arquivo" > "$log" 2>&1; then
    bad "APPLY da migration falhou: $(tail -c 300 "$log")"; return 0
  fi
  if grep -q 'MARGEM_JANELA_12M_OK' "$log"; then ok "P0 pos-condicao da migration emitiu o marcador"; else bad "P0 marcador de fim ausente"; fi
  eq "J1 A: so o item recente entra (lifetime daria 25.00)" "$(m aa000000-0000-0000-0000-000000000001)" "40.00"
  eq "J2 A: 1 item computavel (o de 3 anos nao conta)" \
     "$(Pq -c "SELECT itens_computaveis FROM private.margem_cliente_agregada() WHERE customer_user_id='aa000000-0000-0000-0000-000000000001';")" "1"
  eq "J3 B: sem compra em 12m -> AUSENTE, nunca 0" "$(m bb000000-0000-0000-0000-000000000002)" "AUSENTE"
  eq "J4 C: borda (12m-1d entra, 12m+1d sai)" "$(m cc000000-0000-0000-0000-000000000003)" "40.00"
  eq "R1 D: excluir_da_carteira segue fora" "$(m dd000000-0000-0000-0000-000000000004)" "AUSENTE"
  eq "R2 E: cancelado segue fora" "$(m ee000000-0000-0000-0000-000000000005)" "AUSENTE"
  eq "R3 F: deletado segue fora" "$(m ff000000-0000-0000-0000-000000000006)" "AUSENTE"
  eq "R4 G: preco 0 -> margem NULL (nao 0)" "$(m 99000000-0000-0000-0000-000000000007)" "NULL"
  eq "R5 G: itens_sem_preco conta o preco 0" \
     "$(Pq -c "SELECT itens_sem_preco FROM private.margem_cliente_agregada() WHERE customer_user_id='99000000-0000-0000-0000-000000000007';")" "1"
  eq "R6 H: cost_final 0 cai no cost_price" "$(m 88000000-0000-0000-0000-000000000008)" "50.00"
  eq "L1 anon NAO executa" "$(Pq -c "SELECT has_function_privilege('anon','private.margem_cliente_agregada()','EXECUTE');")" "f"
  eq "L2 authenticated NAO executa" "$(Pq -c "SELECT has_function_privilege('authenticated','private.margem_cliente_agregada()','EXECUTE');")" "f"
  eq "L3 service_role executa" "$(Pq -c "SELECT has_function_privilege('service_role','private.margem_cliente_agregada()','EXECUTE');")" "t"
}

# sabota <nome> <assert que tem de cair> <expressão sed> — cópia em $TMP, o repo nunca é tocado.
SABOTAGENS_OK=0; SABOTAGENS_FRACAS=0
sabota() {
  local nome="$1" alvo="$2" expr="$3" copia="$TMP/sabotada.sql"
  sed "$expr" "$MIG" > "$copia"
  if cmp -s "$MIG" "$copia"; then echo "  ERRO sabotagem '$nome' nao alterou o arquivo (sed nao casou)"; exit 1; fi
  echo "--- sabotagem: $nome (espera $alvo VERMELHO) ---"
  local saida; saida="$(rodada "$copia")"; printf '%s\n' "$saida" | while IFS= read -r l; do echo "    $l"; done
  if echo "$saida" | grep -q "FALHOU $alvo "; then
    SABOTAGENS_OK=$((SABOTAGENS_OK+1)); echo "  OK   sabotagem '$nome' derrubou $alvo"
  else
    SABOTAGENS_FRACAS=$((SABOTAGENS_FRACAS+1)); echo "  FALHOU sabotagem '$nome' NAO derrubou $alvo (assert sem dente)"
  fi
}

echo "=== CONTROLE: migration REAL (PG17 :$PORT) ==="
rodada "$MIG"
CONTROLE_FAIL=$FAIL; CONTROLE_PASS=$PASS
if [ "$CONTROLE_FAIL" -ne 0 ]; then
  echo "PASS=$CONTROLE_PASS  FAIL=$CONTROLE_FAIL"
  echo "CONTROLE VERMELHO — falsificacao abortada"; exit 1
fi

echo "=== FALSIFICACAO (mesma invocacao, apos controle verde) ==="
# Sem janela de fato (o texto '12 months' fica, a pós-condição passa): volta ao lifetime.
sabota "janela neutralizada"   "J1" "s|now() - interval '12 months'$|now() - interval '12 months' - interval '100 years'|"
sabota "janela neutralizada/B" "J3" "s|now() - interval '12 months'$|now() - interval '12 months' - interval '100 years'|"
# Janela frouxa (13 meses): a borda externa entra.
sabota "janela de 13 meses"    "J4" "s|now() - interval '12 months'$|now() - interval '12 months' - interval '1 month'|"
# Janela apertada (11 meses): a borda interna sai.
sabota "janela de 11 meses"    "J4" "s|now() - interval '12 months'$|now() - interval '12 months' + interval '1 month'|"
# Regra preexistente perdida no replace.
sabota "sem deleted_at"        "R3" "s|^       AND so.deleted_at IS NULL$|       AND true|"

echo "=== FECHAMENTO ==="
echo "controle: $CONTROLE_PASS asserts verdes · sabotagens com dente: $SABOTAGENS_OK · sem dente: $SABOTAGENS_FRACAS"
# Contrato do db/roda-nucleo-ci.sh: UMA linha PASS=/FAIL=. PASS = asserts do controle + sabotagens com dente.
echo "PASS=$((CONTROLE_PASS + SABOTAGENS_OK))  FAIL=$SABOTAGENS_FRACAS"
if [ "$SABOTAGENS_FRACAS" -ne 0 ] || [ "$SABOTAGENS_OK" -ne 5 ]; then echo "VERMELHO"; exit 1; fi
echo "VERDE-REAL: controle verde + 5/5 sabotagens vermelhas"

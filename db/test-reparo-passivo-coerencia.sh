#!/usr/bin/env bash
# Prova do reparo do passivo de coerência (PR #2363) — PG17 descartável, dados
# REAIS de produção como fixture. Roda o reparo DE VERDADE (PL/pgSQL é
# late-bound: só falha em runtime) e falsifica os asserts no fim.
set -euo pipefail
export LC_ALL="${LC_ALL:-C}"

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE="${FIXTURE:-}"
[ -n "$FIXTURE" ] && [ -f "$FIXTURE" ] || { echo "FIXTURE=<caminho.sql> obrigatorio"; exit 1; }
REPARO="${REPARO:-$RAIZ/db/reparo-passivo-coerencia-pedido-venda.sql}"
MIGRACAO="${MIGRACAO:-}"

PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"; PORT="${PGPORT_TEST:-5479}"
SLUG="reparo-coerencia"; DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
Q() { "$PGBIN/psql" -h /tmp -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }
V() { Q -A -t -c "$1"; }

FALHAS=0
ok()  { echo "  ok   — $1"; }
bad() { echo "  FALHA— $1 (esperado='$2' obtido='$3')"; FALHAS=$((FALHAS+1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

echo "== esquema =="
Q -q <<'SQL'
CREATE TABLE omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint UNIQUE, descricao text);
CREATE TABLE sales_orders (id uuid PRIMARY KEY, omie_pedido_id bigint, account text NOT NULL,
  customer_user_id uuid NOT NULL, items jsonb, total numeric, subtotal numeric, status text,
  hash_payload text, created_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL, product_id uuid REFERENCES omie_products(id),
  omie_codigo_produto bigint, quantity numeric NOT NULL DEFAULT 1, unit_price numeric,
  discount numeric DEFAULT 0, created_at timestamptz DEFAULT now(),
  hash_payload text, omie_codigo_item bigint);

-- trigger real de prod: a linha herda a DATA DO PEDIDO, nunca now() da carga
CREATE FUNCTION order_items_herdar_created_at_omie() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $f$
DECLARE v_pai_created_at timestamptz; v_pai_hash text;
BEGIN
  SELECT created_at, hash_payload INTO v_pai_created_at, v_pai_hash
    FROM public.sales_orders WHERE id = NEW.sales_order_id;
  IF v_pai_hash LIKE 'omie\_%' AND v_pai_created_at IS NOT NULL THEN
    NEW.created_at := v_pai_created_at;
  END IF;
  RETURN NEW;
END $f$;
CREATE TRIGGER trg_order_items_created_at_omie BEFORE INSERT ON order_items
  FOR EACH ROW EXECUTE FUNCTION order_items_herdar_created_at_omie();
SQL

echo "== fixture (dados reais de prod) =="
Q -q -f "$FIXTURE"
eq "fixture: 15 pedidos"        15 "$(V "SELECT count(*) FROM sales_orders;")"
eq "fixture: 54 linhas"         54 "$(V "SELECT count(*) FROM order_items;")"

# predicado do EXCEPT ALL — o MESMO de pedido_venda_exigir_coerencia
DIVERGENTES="WITH rel AS (SELECT oi.sales_order_id id, oi.omie_codigo_produto prod, oi.quantity qtd,
   oi.unit_price preco, oi.discount d FROM order_items oi),
 js AS (SELECT so.id, (el->>'omie_codigo_produto')::bigint, (el->>'quantidade')::numeric,
   (el->>'valor_unitario')::numeric, (el->>'desconto')::numeric
   FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
   WHERE EXISTS (SELECT 1 FROM order_items o2 WHERE o2.sales_order_id=so.id)),
 dif AS (SELECT id FROM (TABLE rel EXCEPT ALL TABLE js) a UNION ALL SELECT id FROM (TABLE js EXCEPT ALL TABLE rel) b)
 SELECT count(DISTINCT id) FROM dif"

echo "== A · ANTES: o passivo existe =="
eq "A1 15 pedidos divergem"     15 "$(V "$DIVERGENTES;")"

# retrato do cabecalho ANTES — o reparo NAO pode mudar nenhum byte disto
ANTES_CAB="$(V "SELECT md5(string_agg(so.id::text||so.total||so.subtotal||so.items::text||so.status, '|' ORDER BY so.id)) FROM sales_orders so;")"
ANTES_OUTROS="$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE so.omie_pedido_id=12121128593;")"

if [ -n "$MIGRACAO" ]; then
  echo "== instalando a CONSTRAINT TRIGGER do PR #2363 (reparo tem de passar COM ela) =="
  Q -q -f "$MIGRACAO"
  eq "trigger instalada" 2 "$(V "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_pedido_venda_coerencia%';")"
fi

echo "== B · o REPARO (executado de verdade) =="
if Q -q -f "$REPARO" 2>/tmp/reparo-erro.log; then ok "B1 reparo commitou"
else bad "B1 reparo commitou" "exit 0" "$(head -c 300 /tmp/reparo-erro.log)"; fi

echo "== C · DEPOIS =="
eq "C1 so 12121128593 diverge (14 reparados)" 1 "$(V "$DIVERGENTES;")"
eq "C2 o que sobra é o 12121128593" 12121128593 \
   "$(V "WITH rel AS (SELECT oi.sales_order_id id, oi.omie_codigo_produto prod, oi.quantity qtd, oi.unit_price preco, oi.discount d FROM order_items oi),
        js AS (SELECT so.id, (el->>'omie_codigo_produto')::bigint, (el->>'quantidade')::numeric, (el->>'valor_unitario')::numeric, (el->>'desconto')::numeric
               FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
               WHERE EXISTS (SELECT 1 FROM order_items o2 WHERE o2.sales_order_id=so.id)),
        dif AS (SELECT id FROM (TABLE rel EXCEPT ALL TABLE js) a UNION ALL SELECT id FROM (TABLE js EXCEPT ALL TABLE rel) b)
        SELECT DISTINCT so.omie_pedido_id FROM dif JOIN sales_orders so ON so.id=dif.id;")"
eq "C3 77 linhas nos 14 alvos" 77 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE so.omie_pedido_id <> 12121128593;")"
eq "C4 CABECALHO intacto (md5)" "$ANTES_CAB" \
   "$(V "SELECT md5(string_agg(so.id::text||so.total||so.subtotal||so.items::text||so.status, '|' ORDER BY so.id)) FROM sales_orders so;")"
eq "C5 12121128593 NAO foi tocado" "$ANTES_OUTROS" \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE so.omie_pedido_id=12121128593;")"
eq "C6 created_at herdou a DATA DO PEDIDO (0 linhas com data de hoje)" 0 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE oi.created_at <> so.created_at;")"
eq "C7 nenhum product_id ficou nulo" 0 \
   "$(V "SELECT count(*) FROM order_items WHERE product_id IS NULL;")"
eq "C8 hash_payload no formato do escritor canonico" 0 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id
         WHERE oi.hash_payload <> 'omie_'||so.account||'_'||so.omie_pedido_id||'_'||oi.omie_codigo_produto;")"
eq "C9 valor visivel passou a bater com o cabecalho nos 14" 14 \
   "$(V "SELECT count(*) FROM sales_orders so WHERE so.omie_pedido_id <> 12121128593
         AND round((SELECT sum(oi.quantity*oi.unit_price-coalesce(oi.discount,0)) FROM order_items oi WHERE oi.sales_order_id=so.id),2) = round(so.total,2);")"

echo "== D · idempotencia: rodar de novo converge =="
if Q -q -f "$REPARO" >/dev/null 2>&1; then ok "D1 2a execucao commitou"; else bad "D1 2a execucao" "exit 0" "erro"; fi
eq "D2 continua 77 linhas" 77 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE so.omie_pedido_id <> 12121128593;")"

echo "== E · ausente != zero: chave 'desconto' faltando vira NULL, nao 0 =="
# Tira a chave `desconto` do jsonb de um dos alvos E zera as linhas dele na MESMA
# transacao (0 linhas = push do app, que a trigger aceita). Depois roda O REPARO:
# quem tem de produzir NULL e a expressao (el->>'desconto')::numeric do reparo —
# se ela cair para o DEFAULT 0 da coluna, este assert fica VERMELHO.
Q -q <<'SQL'
BEGIN;
UPDATE sales_orders so
   SET items = (SELECT jsonb_agg(el - 'desconto') FROM jsonb_array_elements(so.items) el)
 WHERE so.omie_pedido_id = 12137805363;
DELETE FROM order_items WHERE sales_order_id = (SELECT id FROM sales_orders WHERE omie_pedido_id = 12137805363);
COMMIT;
SQL
# `|| true`: se o reparo RECUSAR (postcondicao), E1 mede o estado e reprova —
# sem isso o set -e mataria o teste antes do assert falar.
Q -q -f "$REPARO" >/dev/null 2>&1 || true
eq "E1 discount NULL nas linhas sem a chave (nao virou 0 pelo DEFAULT)" 2 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id
         WHERE so.omie_pedido_id=12137805363 AND oi.discount IS NULL;")"
eq "E2 o total de linhas nao mudou" 77 \
   "$(V "SELECT count(*) FROM order_items oi JOIN sales_orders so ON so.id=oi.sales_order_id WHERE so.omie_pedido_id <> 12121128593;")"

echo
if [ "$FALHAS" -eq 0 ]; then echo "PROVA-REPARO-OK (0 falhas)"; else echo "PROVA-REPARO-FALHOU ($FALHAS)"; exit 1; fi

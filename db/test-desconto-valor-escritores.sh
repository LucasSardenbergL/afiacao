#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — desconto_valor atravessa os TRÊS escritores de order_items           ║
# ║ Rode: bash db/test-desconto-valor-escritores.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTA PROVA EXISTE PARA PEGAR: `desconto_valor` distingue NÃO APURADO (NULL) de "o Omie
# informou que não há desconto" (0). Essa distinção é a entrega inteira — e ela morre de três
# jeitos, nenhum deles ruidoso:
#
#   1. um `coalesce(..., 0)` em qualquer dos escritores carimba "sem desconto" no acervo;
#   2. `aplicar_edicao_pedido_omie` APAGA e reinsere as linhas — sem a coluna no INSERT, editar
#      um pedido zera para NULL um desconto já apurado;
#   3. `reconciliar_pedidos_omie` troca preço/quantidade — conservar o desconto antigo o deixaria
#      colado numa base que mudou, que é pior que perdê-lo: passa a afirmar errado.
#
# Nenhum desses três produz exceção, log ou divergência de total. Só um teste que EXECUTA as
# funções e lê a coluna depois os vê.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="desconto-valor-escritores"
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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

c1="11111111-1111-1111-1111-111111111111"
sys="33333333-3333-3333-3333-333333333333"
p1="aaaaaaaa-0000-0000-0000-000000000001"

# ── ZONA 1 — pré-requisitos de schema ────────────────────────────────────────────────────────
P -q <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text,
  customer_address text, customer_phone text, order_date_kpi date,
  omie_payload jsonb, omie_response jsonb, lido_em timestamptz, omie_reconciliado_em timestamptz);
-- `desconto_valor` como em produção (20260908072658): numeric, NULLABLE, SEM DEFAULT. Um DEFAULT 0
-- aqui faria TODO assert de NULL passar por acidente do stub, provando o oposto do que se quer.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric,
  omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
SQL

# ── ZONA 2 — aplica a migration REAL (Lei #1) ────────────────────────────────────────────────
# `find`, não `ls`: SC2012 — e aqui não é purismo, o gate `lint:shell` entra em ZERO.
# `sort` porque a ordem do find não é garantida, e o alvo é a migration mais RECENTE
# com este slug (se um dia houver uma correção posterior, é ela que vale).
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
[ -n "$MIG" ] || { echo "migration não encontrada — o harness testaria o NADA"; exit 1; }
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed ────────────────────────────────────────────────────────────────────────────
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$sys') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES ('$p1', 555, 'oben');
SQL

echo "═══ A · criar_pedidos_com_itens (ingestão) ═══"

# A1/A2/A3 num pedido só: os três estados da coluna têm de coexistir na MESMA escrita, senão o
# teste não distingue "grava o que veio" de "grava sempre a mesma coisa".
P -q <<SQL
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9001", "omie_pedido_id": 9001, "omie_numero_pedido": "9001",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [
    {"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10, "hash_payload": "omie_oben_9001_555"},
    {"omie_codigo_produto": 556, "quantity": 1, "unit_price": 50,  "desconto_valor": 0,  "hash_payload": "omie_oben_9001_556"},
    {"omie_codigo_produto": 557, "quantity": 3, "unit_price": 20,                        "hash_payload": "omie_oben_9001_557"}
  ]}]'::jsonb);
SQL
A1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE omie_codigo_produto=555;")
eq "A1 desconto informado chega inteiro na coluna" "$A1" "10"
A2=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE omie_codigo_produto=556;")
eq "A2 zero é DADO e é gravado como zero (não vira NULL)" "$A2" "0"
# O assert central da entrega. `IS NULL` explícito porque -tA devolve string vazia tanto para NULL
# quanto para '' — comparar com "" casaria os dois e o teste mentiria.
A3=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE omie_codigo_produto=557;")
eq "A3 ausente vira NULL, NUNCA 0 (o coalesce que a coluna existe para evitar)" "$A3" "t"
A4=$(Pq -c "SELECT discount FROM public.order_items WHERE omie_codigo_produto=557;")
eq "A4 a coluna LEGADO segue com seu default 0 (esta entrega não a toca)" "$A4" "0"

echo "═══ B · aplicar_edicao_pedido_omie (o desconto sobrevive ao DELETE+INSERT) ═══"

SOID=$(Pq -c "SELECT id FROM public.sales_orders WHERE hash_payload='omie_oben_9001';")
P -q <<SQL
SELECT public.aplicar_edicao_pedido_omie(
  '$SOID'::uuid,
  '[{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 100, "desconto": null}]'::jsonb,
  '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10}]'::jsonb,
  200, NULL, '{}'::jsonb, '{}'::jsonb, now());
SQL
B1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "B1 desconto apurado ATRAVESSA a edição (delete+insert não o come)" "$B1" "10"

P -q <<SQL
SELECT public.aplicar_edicao_pedido_omie(
  '$SOID'::uuid,
  '[{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 100, "desconto": null}]'::jsonb,
  '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100}]'::jsonb,
  200, NULL, '{}'::jsonb, '{}'::jsonb, now());
SQL
B2=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "B2 edição SEM desconto deixa NÃO APURADO, não fabrica 0" "$B2" "t"

echo "═══ C · reconciliar_pedidos_omie (invalida, não conserva) ═══"

P -q <<SQL
UPDATE public.order_items SET desconto_valor = 10
 WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;
SELECT public.reconciliar_pedidos_omie('[{
  "account": "oben", "hash_payload": "omie_oben_9001", "omie_pedido_id": 9001,
  "status": "importado", "total": 240,
  "items": [{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 120, "desconto": 0}],
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 120, "discount": 0, "hash_payload": "omie_oben_9001_555"}]
  }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now());
SQL
C0=$(Pq -c "SELECT unit_price FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "C0 (controle) a reconciliação de fato mudou a base — sem isto, C1 passa por inércia" "$C0" "120"
C1=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "C1 base mudou → desconto INVALIDADO (não colado na base nova)" "$C1" "t"

echo "═══ D · a migration se recusa a reverter outra sessão (pré-condição) ═══"

# O #2405 recria a MESMA função para gravar `omie_codigo_item`. Se ele for aplicado primeiro,
# re-aplicar este arquivo apagaria aquilo em silêncio. A pré-condição transforma isso em erro.
D1=$(P -q -v ON_ERROR_STOP=0 <<SQL 2>&1 | grep -c "ABORTADO" || true
CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens(p_pedidos jsonb)
RETURNS jsonb LANGUAGE plpgsql AS \$f\$
BEGIN
  -- simula a versão do #2405: menciona omie_codigo_item, não menciona desconto_valor
  PERFORM 1 FROM public.order_items WHERE omie_codigo_item IS NOT NULL;
  RETURN '{}'::jsonb;
END \$f\$;
\i $MIG
SQL
)
eq "D1 pré-condição ABORTA sobre a versão do #2405 (não reverte em silêncio)" "$D1" "1"
# Restaura a versão verdadeira para os asserts de falsificação abaixo.
P -q -c "DROP FUNCTION IF EXISTS public.criar_pedidos_com_itens(jsonb);" >/dev/null
P -q -f "$MIG"

echo "═══ E · FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura ═══"

# E1 — o coalesce(...,0) na ingestão. Se este assert não ficar vermelho, A3 não tem dente e todo
# o resto da prova é decoração: a coluna aceitaria "desconto zero" carimbado no acervo inteiro.
SAB="/tmp/sabotado-${SLUG}.sql"
sed "s/(it->>'desconto_valor')::numeric,/coalesce((it->>'desconto_valor')::numeric, 0),/" "$MIG" > "$SAB"
if ! grep -q "coalesce((it->>'desconto_valor')::numeric, 0)" "$SAB"; then
  bad "E0 a sabotagem NÃO alterou o arquivo — a falsificação abaixo seria teatro (sempre-verde)"
else
  ok "E0 (controle da sabotagem) o texto mudou de fato"
  P -q -c "DROP TABLE IF EXISTS public.order_items CASCADE;" >/dev/null 2>&1 || true
  P -q <<'SQL'
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL, product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint, quantity numeric NOT NULL DEFAULT 1, unit_price numeric,
  discount numeric DEFAULT 0, desconto_valor numeric, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
SQL
  # A postcondição da PRÓPRIA migration deve barrar o coalesce. Se ela deixar passar, o arquivo
  # sabotado aplica limpo — e é isso que este assert mede.
  E1=$(P -q -v ON_ERROR_STOP=0 -f "$SAB" 2>&1 | grep -c "coalesce(desconto_valor, 0)" || true)
  eq "E1 a POSTCONDIÇÃO pega o coalesce(...,0) sabotado" "$E1" "1"

  # E2 — mesmo com a postcondição, prove o EFEITO: com o coalesce, o ausente deixa de ser NULL.
  # Postcondição e efeito são camadas distintas; sabotar uma por vez é o que distingue as duas.
  P -q -c "DROP FUNCTION IF EXISTS public.criar_pedidos_com_itens(jsonb);" >/dev/null
  sed -n "/1\/3 · criar_pedidos_com_itens/,/^;$/p" "$SAB" | P -q -v ON_ERROR_STOP=1 >/dev/null 2>&1 || true
  P -q -c "DELETE FROM public.sales_orders;" >/dev/null
  P -q <<SQL >/dev/null 2>&1 || true
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9002", "omie_pedido_id": 9002, "omie_numero_pedido": "9002",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [{"omie_codigo_produto": 557, "quantity": 3, "unit_price": 20, "hash_payload": "omie_oben_9002_557"}]}]'::jsonb);
SQL
  E2=$(Pq -c "SELECT coalesce((SELECT desconto_valor::text FROM public.order_items WHERE omie_codigo_produto=557), 'sem-linha');")
  if [ "$E2" = "0" ]; then
    ok "E2 sabotado, o ausente VIRA 0 — A3 tem dente (é este número que ele barra)"
    PASS=$((PASS+1))
  else
    bad "E2 sabotado, o ausente NÃO virou 0 (veio [$E2]) — A3 pode estar passando por outro motivo"
  fi
fi

# E3 — a conservação na reconciliação. Sabota `desconto_valor = NULL` → o valor antigo fica
# colado na base nova. É o defeito que o Codex apontou, e ele não produz erro nenhum.
P -q -c "DROP FUNCTION IF EXISTS public.criar_pedidos_com_itens(jsonb);" >/dev/null
P -q -f "$MIG" >/dev/null
SAB3="/tmp/sabotado3-${SLUG}.sql"
sed "s/                 desconto_valor = NULL,/                 desconto_valor = coalesce(NULL, oi.desconto_valor),/" "$MIG" > "$SAB3"
if ! grep -q "coalesce(NULL, oi.desconto_valor)" "$SAB3"; then
  bad "E3.0 a sabotagem da reconciliação NÃO alterou o arquivo — assert seria teatro"
else
  ok "E3.0 (controle da sabotagem) o texto da reconciliação mudou de fato"
  sed -n "/3\/3 · reconciliar_pedidos_omie/,/^;$/p" "$SAB3" | P -q -v ON_ERROR_STOP=1 >/dev/null
  P -q -c "DELETE FROM public.sales_orders;" >/dev/null
  P -q <<SQL >/dev/null
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9003", "omie_pedido_id": 9003, "omie_numero_pedido": "9003",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10, "hash_payload": "omie_oben_9003_555"}]}]'::jsonb);
SQL
  SO3=$(Pq -c "SELECT id FROM public.sales_orders WHERE hash_payload='omie_oben_9003';")
  P -q <<SQL >/dev/null
SELECT public.reconciliar_pedidos_omie('[{
  "account": "oben", "hash_payload": "omie_oben_9003", "omie_pedido_id": 9003,
  "status": "importado", "total": 240,
  "items": [{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 120, "desconto": 0}],
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 120, "discount": 0, "hash_payload": "omie_oben_9003_555"}]
  }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now());
SQL
  E3=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE sales_order_id='$SO3' AND omie_codigo_produto=555;")
  if [ "$E3" = "10" ]; then
    ok "E3 sabotado, o desconto de 10 fica COLADO na base 120 — C1 tem dente"
    PASS=$((PASS+1))
  else
    bad "E3 sabotado, o desconto não se conservou (veio [$E3]) — C1 pode passar por inércia"
  fi
fi

echo "═══ RESULTADO: $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]

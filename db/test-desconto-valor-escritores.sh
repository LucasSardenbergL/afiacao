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
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5473}"
SLUG="desconto-valor-escritores"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da
# major — é o que deixa esta prova rodar no núcleo do CI (db/nucleo-ci.txt). O caminho fixo do
# Homebrew que morava aqui a prendia à máquina local, e a §F (o G5 intocado, 2026-09-10) só vale
# como gate se o CI a executar.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

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
# mktemp exige que o padrão TERMINE em X (macOS): um sufixo depois do XXXXXX faz mkstemp falhar,
# e com `set -e` o harness aborta antes do primeiro assert — barulhento, que é o certo.
TMPF="$(mktemp "${TMPDIR:-/tmp}/fn-sabotada.XXXXXX")"
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

echo "═══ D · a identidade de linha do #2405 sobrevive ao replace ═══"

# O #2405 mergeou em 2026-09-09 e a seção 1/3 foi REGENERADA sobre a versão dele. O risco deixou
# de ser "aplicar por cima e reverter" e passou a ser "regenerar de um snapshot velho e apagar" —
# mesmo dano, outra porta. A postcondição cobra os dois campos juntos; aqui prova-se que ela morde.
D0=$(Pq -c "SELECT position('omie_codigo_item' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens';")
eq "D0 a função aplicada carrega a identidade de linha do #2405" "$D0" "t"
D1=$(Pq -c "SELECT position('desconto_valor' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens';")
eq "D1 e o desconto canônico, na MESMA função (consolidada, não alternada)" "$D1" "t"

# Falsificação da cobrança: uma versão SEM omie_codigo_item tem de fazer a postcondição abortar.
SABD="/tmp/sabotado-identidade-${SLUG}.sql"
# Remove a coluna E o valor de forma CONSISTENTE. A primeira versão desta sabotagem comentava só
# o valor e deixava a vírgula de `v_created_at,` órfã: a migration morria de erro de SINTAXE, não
# na postcondição, e o assert lia "não abortou pela minha causa" como "não abortou". Sabotagem que
# quebra o arquivo por outro motivo não exercita o eixo que se quer medir.
perl -0pe 's/, omie_codigo_item\n/\n/; s/ *v_created_at,( *-- G6)\n *CASE WHEN \(SELECT ok FROM ga\) THEN c\.cid END\n/               v_created_at\1\n/' "$MIG" > "$SABD"
if grep -q "discount, desconto_valor, hash_payload, created_at, omie_codigo_item" "$SABD"; then
  bad "D2.0 a sabotagem da identidade NÃO removeu a coluna do INSERT — o assert seria teatro"
else
  ok "D2.0 (controle da sabotagem) a identidade foi removida do INSERT de fato"
  D2=$(P -q -v ON_ERROR_STOP=0 -f "$SABD" 2>&1 | grep -c "perdeu a coluna omie_codigo_item" || true)
  eq "D2 a postcondição ABORTA quando a identidade de linha some" "$D2" "1"
  P -q -f "$MIG" >/dev/null
fi

echo "═══ F · o total LÍQUIDO atravessa as RPCs INTOCADAS (2026-09-10) ═══"

# A entrega do subtotal líquido NÃO tem migration: a fórmula mudou na edge (`apurarSubtotalPedido`,
# _shared/omie-pedido.ts) e as RPCs seguem as mesmas. O que se prova aqui é que as RPCs, como estão
# em prod, fazem com o payload NOVO o que a decisão supõe — em especial o G5, que ficou intocado de
# propósito. Números do pedido real oben 12183048572: bruto 1629,25, desconto 139,91, líquido 1489,34.
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload LIKE 'omie\_oben\_91%';" >/dev/null
itens_desc() {  # $1 = número do pedido. As duas linhas do pedido real, com o desconto apurado.
  echo "[{\"omie_codigo_produto\": 555, \"quantity\": 1, \"unit_price\": 460.25, \"desconto_valor\": 23.01, \"hash_payload\": \"omie_oben_$1_555\"},
         {\"omie_codigo_produto\": 556, \"quantity\": 2, \"unit_price\": 584.5,  \"desconto_valor\": 116.9, \"hash_payload\": \"omie_oben_$1_556\"}]"
}
criar() {  # $1 = número, $2 = total do payload, $3 = itens → devolve o jsonb da RPC
  Pq -c "SELECT public.criar_pedidos_com_itens('[{
    \"customer_user_id\": \"$c1\", \"created_by\": \"$sys\", \"account\": \"oben\",
    \"hash_payload\": \"omie_oben_$1\", \"omie_pedido_id\": $1, \"omie_numero_pedido\": \"$1\",
    \"items\": [], \"subtotal\": $2, \"discount\": 0, \"total\": $2, \"status\": \"importado\",
    \"itens\": $3}]'::jsonb);"
}
orfao_legado() {  # $1 = número, $2 = total gravado no NASCIMENTO (semântica antiga = bruto)
  P -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, items, subtotal, total, status, omie_pedido_id, account, hash_payload)
           VALUES ('$c1', '$sys', '[]', $2, $2, 'importado', $1, 'oben', 'omie_oben_$1');" >/dev/null
}
n_itens() { Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload = 'omie_oben_$1';"; }

# F1 — pedido NOVO nasce com o total líquido, e o cabeçalho é a soma das linhas pela régua.
R=$(criar 9101 1489.34 "$(itens_desc 9101)")
eq "F1.0 (controle) o pedido novo entrou" "$(printf '%s' "$R" | grep -c '"inserted": 1')" "1"
F1=$(Pq -c "SELECT total FROM public.sales_orders WHERE hash_payload='omie_oben_9101';")
eq "F1 o cabeçalho guarda o LÍQUIDO que a edge mandou" "$F1" "1489.34"
F1b=$(Pq -c "SELECT so.total = sum(oi.quantity * oi.unit_price - oi.desconto_valor)
               FROM public.sales_orders so JOIN public.order_items oi ON oi.sales_order_id = so.id
              WHERE so.hash_payload='omie_oben_9101' GROUP BY so.total;")
eq "F1b cabeçalho == Σ (qtd·preço − desconto_valor) das linhas — a identidade que a passada no acervo vai usar" "$F1b" "t"

# F2 — a premissa do G5 intocado. Um órfão cujo pai nasceu com o total BRUTO (semântica antiga)
# recebe o payload LÍQUIDO: o G5 RECUSA e reporta, em vez de reparar com cabeçalho que não
# descreve as linhas. É fail-closed, e é o comportamento certo para a transição.
orfao_legado 9102 1629.25
R=$(criar 9102 1489.34 "$(itens_desc 9102)")
eq "F2 órfão legado BRUTO × payload LÍQUIDO → divergência reportada" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"
eq "F2a e NÃO reparado (nenhuma linha inserida)" "$(n_itens 9102)" "0"

# F2b — o formato do ÚNICO órfão de prod (total 0, items vazio). O veredito não depende da
# fórmula: com o bruto (1629,25) ele já divergia; com o líquido (1489,34) segue divergindo.
orfao_legado 9103 0
R=$(criar 9103 1629.25 "$(itens_desc 9103)")
eq "F2b.0 o formato do órfão real (total 0) já divergia com o payload BRUTO (a fórmula antiga)" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"
R=$(criar 9103 1489.34 "$(itens_desc 9103)")
eq "F2b e segue divergindo com o LÍQUIDO — a mudança de fórmula não muda o veredito dele" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"

# F2c — CONTROLE de F2: sem desconto, bruto == líquido e o reparo passa. Sem este, F2 seria
# indistinguível de um G5 que recusa tudo.
orfao_legado 9104 200
R=$(criar 9104 200 '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 0, "hash_payload": "omie_oben_9104_555"}]')
eq "F2c (controle) órfão SEM desconto é reparado normalmente" "$(printf '%s' "$R" | grep -c '"repaired": 1')" "1"

# F3 — o reprocess converge o legado: pedido COM linhas, gravado bruto, reconciliado com o payload
# líquido. O cabeçalho vira o líquido numa passada e a segunda leitura não reescreve mais nada.
R=$(criar 9105 1629.25 "$(itens_desc 9105)")
# O carimbo vai no PASSADO e cresce: a RPC recusa `p_lido_em` no futuro (guard do compare-and-set
# contra relógio envenenado do chamador), então "+N minutos" aqui seria teste instável ou vermelho.
reconc() {  # $1 = número, $2 = total, $3 = deslocamento do carimbo em minutos (negativo = passado)
  Pq -c "SELECT public.reconciliar_pedidos_omie('[{
    \"account\": \"oben\", \"hash_payload\": \"omie_oben_$1\", \"omie_pedido_id\": $1, \"total\": $2, \"items\": [],
    \"itens\": [{\"omie_codigo_produto\": 555, \"quantity\": 1, \"unit_price\": 460.25, \"discount\": 0, \"hash_payload\": \"omie_oben_$1_555\"},
                {\"omie_codigo_produto\": 556, \"quantity\": 2, \"unit_price\": 584.5,  \"discount\": 0, \"hash_payload\": \"omie_oben_$1_556\"}]
    }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now() + interval '$3 minutes') ->> 'divergences';"
}
eq "F3.0 a 1ª reconciliação conta a mudança de total" "$(reconc 9105 1489.34 -2)" "1"
F3=$(Pq -c "SELECT total || '/' || subtotal FROM public.sales_orders WHERE hash_payload='omie_oben_9105';")
eq "F3 total E subtotal convergem para o líquido numa passada" "$F3" "1489.34/1489.34"
F3b=$(Pq -c "SELECT string_agg(desconto_valor::text, ',' ORDER BY omie_codigo_produto) FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload='omie_oben_9105';")
eq "F3b as linhas (base inalterada) conservam o desconto apurado" "$F3b" "23.01,116.9"
eq "F3c a 2ª leitura igual não conta divergência — convergiu, não oscila" "$(reconc 9105 1489.34 -1)" "0"

# F4 — sem desconto, a fórmula nova dá o MESMO número: a reconciliação não reescreve o total.
R=$(criar 9106 200 '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 0, "hash_payload": "omie_oben_9106_555"}]')
eq "F4 pedido sem desconto: nenhuma divergência de total na reconciliação" "$(P -tA -c "SELECT public.reconciliar_pedidos_omie('[{\"account\": \"oben\", \"hash_payload\": \"omie_oben_9106\", \"omie_pedido_id\": 9106, \"total\": 200, \"items\": [], \"itens\": [{\"omie_codigo_produto\": 555, \"quantity\": 2, \"unit_price\": 100, \"discount\": 0, \"hash_payload\": \"omie_oben_9106_555\"}]}]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now() - interval '1 minute') ->> 'divergences';")" "0"

# F5 — FALSIFICAÇÃO de F2, com o conserto REJEITADO como sabotagem: aumentar a tolerância do G5.
# Com uma tolerância maior que o desconto, o mesmo órfão legado passa a ser REPARADO com o cabeçalho
# bruto sobre linhas líquidas — duas portas de aprovação, e a errada abre. Se F5 não ficar vermelho,
# F2 não tem dente. O controle é F2, na MESMA invocação e com a função verdadeira, logo acima.
SABG5="/tmp/sabotado-g5-${SLUG}.sql"
sed 's/v_pl_total) > 0\.01/v_pl_total) > 200/' "$MIG" > "$SABG5"
if ! grep -q "v_pl_total) > 200" "$SABG5"; then
  bad "F5.0 a sabotagem da tolerância NÃO alterou o G5 — a falsificação seria teatro"
else
  ok "F5.0 (controle da sabotagem) o G5 passou a tolerar R\$ 200"
  awk '/^CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens/{d=1} d{print} d&&/^;$/{exit}' "$SABG5" > "$TMPF"
  [ -s "$TMPF" ] || bad "F5.0b o recorte da função sabotada saiu VAZIO"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" >/dev/null
  orfao_legado 9107 1629.25
  R=$(criar 9107 1489.34 "$(itens_desc 9107)")
  if [ "$(n_itens 9107)" = "2" ]; then
    ok "F5 com tolerância, o órfão legado é REPARADO sob cabeçalho bruto — F2 tem dente"
  else
    bad "F5 sabotado, o órfão legado NÃO foi reparado (itens=$(n_itens 9107)) — F2 pode passar por outro motivo"
  fi
  P -q -f "$MIG" >/dev/null   # restaura a função verdadeira (a migration inteira é idempotente)
  R=$(criar 9108 1489.34 "$(itens_desc 9108)")
  eq "F5r (restauração) a função verdadeira voltou: pedido novo entra de novo" "$(printf '%s' "$R" | grep -c '"inserted": 1')" "1"
fi

echo "═══ E · FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura ═══"

# E1 — o coalesce(...,0) na ingestão. Se este assert não ficar vermelho, A3 não tem dente e todo
# o resto da prova é decoração: a coluna aceitaria "desconto zero" carimbado no acervo inteiro.
SAB="/tmp/sabotado-${SLUG}.sql"
sed "s/(\(c\.\)\{0,1\}it->>'desconto_valor')::numeric,/coalesce((\1it->>'desconto_valor')::numeric, 0),/g" "$MIG" > "$SAB"
if ! grep -q "coalesce((c.it->>'desconto_valor')::numeric, 0)" "$SAB"; then
  bad "E0 a sabotagem NÃO alterou a seção 1/3 (a que o assert observa) — a falsificação seria teatro"
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
  # Recorte da função sabotada. O `-s` é o CONTROLE: recorte vazio faria o assert abaixo medir um
  # pedido que nunca foi criado, e "não virou 0" leria-se como aprovação. E o erro do apply vai
  # para o log em vez de ser engolido — foi assim que a quebra do delimitador passou despercebida.
  awk '/^CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens/{d=1} d{print} d&&/^;$/{exit}' "$SAB" > "$TMPF"
  [ -s "$TMPF" ] || bad "E2.0 o recorte da função sabotada saiu VAZIO — o assert abaixo mediria o nada"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" > "$TMPF.log" 2>&1 || true
  P -q -c "DELETE FROM public.sales_orders;" >/dev/null
  P -q > "$TMPF.pedido.log" 2>&1 <<SQL || true
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9002", "omie_pedido_id": 9002, "omie_numero_pedido": "9002",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [{"omie_codigo_produto": 557, "quantity": 3, "unit_price": 20, "hash_payload": "omie_oben_9002_557"}]}]'::jsonb);
SQL
  if grep -qi "erro\|error" "$TMPF.pedido.log"; then
    bad "E2.1 a criação do pedido sabotado FALHOU — o assert abaixo mediria ausência, não efeito: $(cut -c1-160 "$TMPF.pedido.log" | head -2 | tr '\n' ' ')"
  fi
  E2N=$(Pq -c "SELECT count(*) FROM public.order_items WHERE omie_codigo_produto=557;")
  if [ "$E2N" != "1" ]; then
    bad "E2.2 esperava exatamente 1 linha do SKU 557, vieram [$E2N] — o assert abaixo mediria o nada"
  fi
  # `is_null` explícito: `-tA` devolve string vazia tanto para NULL quanto para '', e comparar com
  # "" casaria os dois. O que se quer saber é se o coalesce sabotado transformou NULL em 0.
  E2=$(Pq -c "SELECT coalesce(desconto_valor::text, 'NULO') FROM public.order_items WHERE omie_codigo_produto=557;")
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
  awk '/^CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie/{d=1} d{print} d&&/^;$/{exit}' "$SAB3" > "$TMPF"
  [ -s "$TMPF" ] || bad "E3.0b o recorte da reconciliação sabotada saiu VAZIO"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" >/dev/null
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

# Formato `N ok / N fail`: é o que o runner do núcleo (db/roda-nucleo-ci.sh) sabe contar. O
# `N ok · N falhas` que estava aqui não casava a regex dele — a prova sairia "exit 0 sem contagem".
echo "═══ RESULTADO: $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ]

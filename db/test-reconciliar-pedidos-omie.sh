#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — reconciliar_pedidos_omie (ATOMICIDADE LÓGICA DO PEDIDO)        ║
# ║      bash db/test-reconciliar-pedidos-omie.sh > /tmp/t.log 2>&1; echo "exit=$?"║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O caso central (T1) é o teste que a pendência do #2132 nomeou e que NENHUM    ║
# ║  teste do repo cobria: uma sessão reconcilia um pedido e PAUSA antes do commit ║
# ║  enquanto outra chama a RPC de snapshot REAL. Exige revisão ANTIGA completa ou ║
# ║  NOVA completa — nunca mistura. F1 prova que o cenário tem dente reproduzindo  ║
# ║  o writer de HOJE (statements soltas), que FALHA nele de propósito.            ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="reconciliar-pedidos"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")"
  rm -f "${SAB1:-}" "${SAB2:-}" "${SAB3:-}" "${SAB4:-}" "${BLOQ_OUT:-}" "${LEIT_OUT:-}"
}
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as tabelas que as migrations leem/escrevem; nenhuma cria)
# ══════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  created_by       uuid,
  status           text NOT NULL,
  items            jsonb,
  subtotal         numeric,
  discount         numeric,
  total            numeric,
  deleted_at       timestamptz,
  order_date_kpi   date,
  account          text NOT NULL,
  origem           text,
  checkout_id      uuid,
  hash_payload     text,
  omie_pedido_id   bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz
);
CREATE TABLE public.order_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id    uuid NOT NULL,
  product_id          uuid,
  omie_codigo_produto bigint,
  quantity            numeric NOT NULL,
  unit_price          numeric NOT NULL,
  discount            numeric,
  hash_payload        text,
  sales_order_id      uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  created_at          timestamptz DEFAULT now()
);
CREATE INDEX idx_order_items_sales_order ON public.order_items (sales_order_id);
CREATE INDEX idx_order_items_product     ON public.order_items (product_id);
-- Índice parcial REAL de prod: é o que dá unicidade a (account, hash_payload) para pedido Omie.
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';

-- Trigger REAL de prod (`order_items_herdar_created_at_omie`): o filho de pedido Omie nasce com a
-- data do PAI, nunca now() da carga. Está aqui porque a RPC INSERE itens e o snapshot do cockpit
-- filtra por `oi.created_at` — sem o trigger o harness divergiria de prod exatamente nessa coluna.
CREATE OR REPLACE FUNCTION public.order_items_herdar_created_at_omie() RETURNS trigger
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
CREATE TRIGGER trg_order_items_created_at_omie
  BEFORE INSERT ON public.order_items FOR EACH ROW
  EXECUTE FUNCTION public.order_items_herdar_created_at_omie();
SQL

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════════
# As DUAS: a do #2132 é o LEITOR sob o qual a atomicidade da escrita é observada. Testar a escrita
# contra um SELECT ad-hoc provaria a RPC contra um leitor que não existe em produção.
MIG_SNAP="$REPO_ROOT/supabase/migrations/20260830123820_snapshot_atomico_universo_itens.sql"
MIG="$REPO_ROOT/supabase/migrations/20260830190000_reconciliar_pedidos_omie.sql"
P -q -f "$MIG_SNAP"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_SNAP") + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: um pedido com uma REVISÃO ANTIGA COMPLETA
# ══════════════════════════════════════════════════════════════════════════════════
U=11111111-1111-1111-1111-111111111111
PA=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
PB=bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb   # pedido de controle: NUNCA deve ser tocado
P1=7d000000-0000-0000-0000-0000000000a1
P2=7d000000-0000-0000-0000-0000000000b1
P3=7d000000-0000-0000-0000-0000000000c1

seed() {
  P -q <<SQL
DELETE FROM public.sales_orders WHERE id IN ('$PA','$PB');
INSERT INTO public.sales_orders (id, customer_user_id, status, items, subtotal, total, account, hash_payload, omie_pedido_id, order_date_kpi, created_at) VALUES
  ('$PA','$U','separacao','[{"omie_codigo_produto":1},{"omie_codigo_produto":2}]'::jsonb, 80, 80, 'oben','omie_oben_777', 777, '2026-08-01','2026-08-01T12:00:00Z'),
  ('$PB','$U','faturado' ,'[{"omie_codigo_produto":9}]'::jsonb, 50, 50, 'oben','omie_oben_888', 888, '2026-08-01','2026-08-01T12:00:00Z');
-- REVISÃO ANTIGA COMPLETA do pedido alvo: dois itens (P1, P2).
INSERT INTO public.order_items (customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, hash_payload, sales_order_id) VALUES
  ('$U','$P1',1,2,10,0,'omie_oben_777_1','$PA'),
  ('$U','$P2',2,3,20,0,'omie_oben_777_2','$PA'),
  ('$U','7d000000-0000-0000-0000-0000000000d1',9,1,50,0,'omie_oben_888_9','$PB');
SQL
}
seed

DENY="ARRAY['cancelado','rascunho','pendente','orcamento']"
GERIDO="ARRAY['importado','separacao','enviado','faturado','cancelado']"

# A REVISÃO NOVA: P1 REMOVIDO, P2 ATUALIZADO (qty 3→9), P3 INSERIDO. del=1, upd=1, ins=1.
NOVA='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":330.00,
 "items":[{"omie_codigo_produto":2},{"omie_codigo_produto":3}],
 "itens":[{"omie_codigo_produto":2,"quantity":9,"unit_price":20,"discount":0,"product_id":"7d000000-0000-0000-0000-0000000000b1","hash_payload":"omie_oben_777_2"},
          {"omie_codigo_produto":3,"quantity":5,"unit_price":30,"discount":0,"product_id":"7d000000-0000-0000-0000-0000000000c1","hash_payload":"omie_oben_777_3"}]}]'

# Lê a cesta do pedido alvo PELO LEITOR REAL (a RPC de snapshot do #2132), como conjunto ordenado
# de product_id. É a forma em que "revisão completa" e "mistura" se distinguem.
CESTA="SELECT coalesce(string_agg(right(e->>'product_id',2), ',' ORDER BY e->>'product_id'), '(vazia)')
         FROM jsonb_array_elements(public.apriori_universo_snapshot($DENY)->'itens') e
        WHERE e->>'sales_order_id' = '$PA'"
ANTIGA_COMPLETA="a1,b1"
NOVA_COMPLETA="b1,c1"

echo "── asserts: contrato da reconciliação ──"
eq "A0 revisão ANTIGA completa no seed" "$(Pq -c "$CESTA")" "$ANTIGA_COMPLETA"

R=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO)::text;")
eq "A1 corrections = 1 delete + 1 update + 1 insert" \
   "$(printf '%s' "$R" | "$PGBIN/psql" -q -t -A -p "$PORT" -h /tmp -U postgres -d prove -c "SELECT ('$R'::jsonb)->>'corrections';")" "3"
eq "A2 upserts = 1 pedido tocado"     "$(Pq -c "SELECT ('$R'::jsonb)->>'upserts';")"     "1"
eq "A3 divergences = 1 (status E total mudaram)" "$(Pq -c "SELECT ('$R'::jsonb)->>'divergences';")" "1"
eq "A4 nenhuma falha"                 "$(Pq -c "SELECT jsonb_array_length(('$R'::jsonb)->'falhas');")" "0"
eq "A5 a cesta é a revisão NOVA COMPLETA" "$(Pq -c "$CESTA")" "$NOVA_COMPLETA"
eq "A6 cabeçalho: status reconciliado" "$(Pq -c "SELECT status FROM public.sales_orders WHERE id='$PA';")" "faturado"
eq "A7 cabeçalho: total E subtotal reconciliados" \
   "$(Pq -c "SELECT total||'/'||subtotal FROM public.sales_orders WHERE id='$PA';")" "330.00/330.00"
eq "A8 cabeçalho: items (retrato) reconciliado" \
   "$(Pq -c "SELECT jsonb_array_length(items) FROM public.sales_orders WHERE id='$PA';")" "2"
eq "A9 o item ATUALIZADO levou o conteúdo novo" \
   "$(Pq -c "SELECT quantity FROM public.order_items WHERE sales_order_id='$PA' AND omie_codigo_produto=2;")" "9"
eq "A10 o item INSERIDO herdou o created_at do PAI (trigger de prod, não now())" \
   "$(Pq -c "SELECT (created_at = '2026-08-01T12:00:00Z'::timestamptz)::text FROM public.order_items WHERE sales_order_id='$PA' AND omie_codigo_produto=3;")" "true"
eq "A11 hash_payload do PAI intacto (causa-raiz #B)" \
   "$(Pq -c "SELECT hash_payload FROM public.sales_orders WHERE id='$PA';")" "omie_oben_777"
eq "A12 o pedido de CONTROLE não foi tocado" \
   "$(Pq -c "SELECT count(*)||'/'||max(status) FROM public.sales_orders WHERE id='$PB' AND updated_at IS NULL;")" "1/faturado"

echo "── asserts: idempotência e no-op ──"
R2=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO)::text;")
eq "A13 2ª chamada com o MESMO payload: zero correções (converge)" "$(Pq -c "SELECT ('$R2'::jsonb)->>'corrections';")" "0"
eq "A14 2ª chamada: zero upserts (conteúdo igual ⇒ no-op, sem burst de reescrita inerte)" \
   "$(Pq -c "SELECT ('$R2'::jsonb)->>'upserts';")" "0"
eq "A15 a cesta seguiu a revisão NOVA COMPLETA" "$(Pq -c "$CESTA")" "$NOVA_COMPLETA"

# Espelho do teste Deno de `diffOrderItens` ("diferença de 2e-14 não é divergência"): a tolerância
# de 1e-6 tem de existir nos DOIS lados, senão o SQL reescreveria linha por ruído de ponto flutuante.
RUIDO=$(printf '%s' "$NOVA" | sed 's/"quantity":9,/"quantity":9.00000000000002,/')
R3=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$RUIDO'::jsonb, $GERIDO)::text;")
eq "A16 diferença de 2e-14 NÃO é divergência (tolerância 1e-6, espelho do TS)" \
   "$(Pq -c "SELECT ('$R3'::jsonb)->>'corrections';")" "0"

echo "── asserts: status só reconcilia quando o dono é o Omie ──"
P -q -c "UPDATE public.sales_orders SET status='entregue' WHERE id='$PA';"
R4=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO)::text;")
eq "A17 status app-avançado ('entregue') NÃO é clobberado pela reconciliação" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE id='$PA';")" "entregue"
eq "A18 e o pedido não conta como upsert por isso" "$(Pq -c "SELECT ('$R4'::jsonb)->>'upserts';")" "0"
P -q -c "UPDATE public.sales_orders SET status='separacao' WHERE id='$PA';"
NULLSTAT=$(printf '%s' "$NOVA" | sed 's/"status_omie":"faturado"/"status_omie":null/')
P -q -c "SELECT public.reconciliar_pedidos_omie('$NULLSTAT'::jsonb, $GERIDO);" >/dev/null
eq "A19 etapa DESCONHECIDA (status_omie null) mantém o status atual" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE id='$PA';")" "separacao"

echo "── asserts: fail-closed (SQLSTATE esperada, resto RE-LANÇADO) ──"
# Sentinela anti-teatro: 'SENTINELA_SEM_DENTE' NÃO aparece no corpo da migration.
neg() { # neg "<descrição>" "<chamada SQL>" "<sqlstate esperada>"
  if P -q -c "DO \$t\$ BEGIN PERFORM $2; RAISE EXCEPTION 'SENTINELA_SEM_DENTE: aceitou entrada inválida' USING ERRCODE='P0001'; EXCEPTION WHEN sqlstate '$3' THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$;" >/dev/null 2>&1
  then ok "$1 (rejeitado com $3)"; else bad "$1 — NÃO lançou $3"; fi
}
neg "B1 p_pedidos NULL"                    "public.reconciliar_pedidos_omie(NULL, $GERIDO)"          "22023"
neg "B2 p_pedidos não-array"               "public.reconciliar_pedidos_omie('{}'::jsonb, $GERIDO)"   "22023"
neg "B3 lista de status NULL"              "public.reconciliar_pedidos_omie('[]'::jsonb, NULL)"      "22023"
neg "B4 lista de status VAZIA"             "public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY[]::text[])" "22023"
# B5 é o buraco da classe do #2132: uma lista sintaticamente válida que ACRESCENTA um status
# app-avançado faria a reconciliação rebaixar pedido que o time já avançou à mão — sem erro nenhum.
neg "B5 lista com 'entregue' A MAIS (clobberaria status app-avançado)" \
    "public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado','entregue'])" "22023"
neg "B6 lista SEM 'importado' (congelaria pedido legítimo)" \
    "public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY['separacao','enviado','faturado','cancelado'])" "22023"
neg "B7 lote acima do teto de 500 (não trunca em silêncio)" \
    "public.reconciliar_pedidos_omie((SELECT jsonb_agg('{\"account\":\"x\",\"hash_payload\":\"y\"}'::jsonb) FROM generate_series(1,501)), $GERIDO)" "54000"
# B8 é o contrapeso de B5/B6: a validação é por CONJUNTO, não por sequência — senão vira armadilha
# que quebra a reconciliação quando alguém só reordena a lista no TS.
eq "B8 lista canônica fora de ordem e com repetição é ACEITA (conjunto, não sequência)" \
   "$(Pq -c "SELECT public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY['cancelado','faturado','importado','cancelado','enviado','separacao'])->>'upserts';")" "0"

echo "── asserts: ausente ≠ zero, e o pedido fica INTACTO ──"
ANTES="$(Pq -c "SELECT total||'|'||status||'|'||(SELECT count(*) FROM public.order_items WHERE sales_order_id='$PA') FROM public.sales_orders WHERE id='$PA';")"
SEM_TOTAL=$(printf '%s' "$NOVA" | sed 's/"total":330.00,//')
RT=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$SEM_TOTAL'::jsonb, $GERIDO)::text;")
eq "C1 'total' ausente: falha REGISTRADA (não engolida como sucesso)" \
   "$(Pq -c "SELECT jsonb_array_length(('$RT'::jsonb)->'falhas');")" "1"
eq "C1b e a falha carrega a SQLSTATE, não só uma mensagem" \
   "$(Pq -c "SELECT ('$RT'::jsonb)->'falhas'->0->>'sqlstate';")" "22023"
eq "C1c 'total' ausente NÃO virou zero — o pedido está INTACTO (ausente ≠ zero)" \
   "$(Pq -c "SELECT total||'|'||status||'|'||(SELECT count(*) FROM public.order_items WHERE sales_order_id='$PA') FROM public.sales_orders WHERE id='$PA';")" "$ANTES"
SEM_ITEMS=$(printf '%s' "$NOVA" | sed 's/"items":\[{"omie_codigo_produto":2},{"omie_codigo_produto":3}\],//')
RI=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$SEM_ITEMS'::jsonb, $GERIDO)::text;")
eq "C2 'items' ausente: falha registrada e retrato do pedido NÃO apagado" \
   "$(Pq -c "SELECT jsonb_array_length(('$RI'::jsonb)->'falhas')||'|'||(SELECT jsonb_array_length(items) FROM public.sales_orders WHERE id='$PA');")" "1|2"
STAT_LIXO=$(printf '%s' "$NOVA" | sed 's/"status_omie":"faturado"/"status_omie":"aprovadissimo"/')
RS=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$STAT_LIXO'::jsonb, $GERIDO)::text;")
eq "C3 status_omie desconhecido: falha registrada, status intacto" \
   "$(Pq -c "SELECT jsonb_array_length(('$RS'::jsonb)->'falhas')||'|'||(SELECT status FROM public.sales_orders WHERE id='$PA');")" "1|separacao"

echo "── asserts: guards de pedido (A4/A7 do writer) ──"
SEM_ITEM='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":330.00,"items":[{"omie_codigo_produto":2}],"itens":[]}]'
RV=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$SEM_ITEM'::jsonb, $GERIDO)::text;")
eq "C4 ListarPedidos degenerado (zero item válido): pedido NÃO reconciliado — nem itens nem cabeçalho" \
   "$(Pq -c "SELECT (('$RV'::jsonb)->>'sem_item')||'|'||(('$RV'::jsonb)->>'upserts')||'|'||(SELECT count(*) FROM public.order_items WHERE sales_order_id='$PA');")" "1|0|2"
SEM_PAI=$(printf '%s' "$NOVA" | sed 's/omie_oben_777"/omie_oben_999"/')
RP=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$SEM_PAI'::jsonb, $GERIDO)::text;")
eq "C5 pedido sem pai local: skip (quem INSERE é o omie-vendas-sync)" \
   "$(Pq -c "SELECT (('$RP'::jsonb)->>'sem_pai')||'|'||(('$RP'::jsonb)->>'corrections');")" "1|0"
# SKU repetido: a identidade do item dentro do pedido é o código; com repetição não dá para dizer
# qual linha local casa com qual → não reconcilia ITENS (não apaga linha legítima), mas o cabeçalho sim.
SKU_REP='[{"account":"oben","hash_payload":"omie_oben_777","omie_pedido_id":777,"status_omie":"faturado","total":999.00,
 "items":[{"omie_codigo_produto":2}],
 "itens":[{"omie_codigo_produto":2,"quantity":1,"unit_price":1,"discount":0,"product_id":"7d000000-0000-0000-0000-0000000000b1","hash_payload":"h"},
          {"omie_codigo_produto":2,"quantity":7,"unit_price":7,"discount":0,"product_id":"7d000000-0000-0000-0000-0000000000b1","hash_payload":"h"}]}]'
RK=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$SKU_REP'::jsonb, $GERIDO)::text;")
eq "C6 SKU repetido: itens NÃO reconciliados (nenhuma linha apagada), cabeçalho SIM" \
   "$(Pq -c "SELECT (('$RK'::jsonb)->>'sku_repetido')||'|'||(('$RK'::jsonb)->>'corrections')||'|'||(SELECT count(*) FROM public.order_items WHERE sales_order_id='$PA')||'|'||(SELECT total FROM public.sales_orders WHERE id='$PA');")" "1|0|2|999.00"

echo "── asserts: um pedido ruim no lote não derruba os outros (subtransação) ──"
seed
LOTE="[{\"account\":\"oben\",\"hash_payload\":\"omie_oben_777\",\"omie_pedido_id\":777},$(printf '%s' "$NOVA" | sed 's/^\[//; s/\]$//')]"
RL=$(Pq -c "SELECT public.reconciliar_pedidos_omie('$LOTE'::jsonb, $GERIDO)::text;")
eq "C7 lote com 1 pedido inválido + 1 válido: falha isolada, o válido reconciliou" \
   "$(Pq -c "SELECT jsonb_array_length(('$RL'::jsonb)->'falhas')||'|'||(('$RL'::jsonb)->>'upserts');")" "1|1"
eq "C8 e a cesta do válido é a revisão NOVA COMPLETA" "$(Pq -c "$CESTA")" "$NOVA_COMPLETA"

echo "── asserts: autorização (REVOKE nomeando as roles) ──"
# ⚠️ As tabelas recebem SELECT/DML para as três roles de propósito: sem isso `anon` seria barrado
# por não enxergar as tabelas, e o assert diria "o REVOKE funciona" sem exercitar o REVOKE.
P -q <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON public.order_items, public.sales_orders TO anon, authenticated, service_role;
SQL
for R in anon authenticated; do
  if P -q -c "SET ROLE $R; DO \$t\$ BEGIN PERFORM public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado']); RAISE EXCEPTION 'SENTINELA_SEM_DENTE: executou' USING ERRCODE='P0001'; EXCEPTION WHEN sqlstate '42501' THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$;" >/dev/null 2>&1
  then ok "C9 $R NÃO executa a RPC (42501, com SELECT nas tabelas concedido)"
  else bad "C9 $R — não foi barrado por permission denied"; fi
done
eq "C10 service_role executa" \
   "$(P -tA -q -c "SET ROLE service_role; SELECT public.reconciliar_pedidos_omie('[]'::jsonb, $GERIDO)->>'upserts';")" "0"

# ══════════════════════════════════════════════════════════════════════════════════
# T1 — O TESTE INDISPENSÁVEL: revisão ANTIGA completa OU NOVA completa, nunca mistura
# ══════════════════════════════════════════════════════════════════════════════════
# A sessão B reconcilia e PAUSA antes do COMMIT. A sessão A chama a RPC de snapshot REAL enquanto
# a transação de B está aberta. Antídoto de falso-verde: se a leitura de A não cair DENTRO da
# janela de B, o teste FALHA por "cenário sem dente" — nunca passa de graça.
echo "── T1: corrida REAL — leitura durante a reconciliação não-commitada ──"
seed
BLOQ_OUT="$(mktemp "/tmp/bloq-${SLUG}.XXXXXX")"
LEIT_OUT="$(mktemp "/tmp/leit-${SLUG}.XXXXXX")"
( P -tA >"$BLOQ_OUT" 2>&1 <<SQL
BEGIN;
SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO);
SELECT 'TB0=' || clock_timestamp()::text;
SELECT pg_sleep(2);
COMMIT;
SELECT 'TB1=' || clock_timestamp()::text;
SQL
) &
BPID=$!
P -tA >"$LEIT_OUT" 2>&1 <<SQL
SELECT pg_sleep(0.8);
SELECT 'CESTA=' || ($CESTA);
SELECT 'TA=' || clock_timestamp()::text;
SQL
wait "$BPID"
TB0=$(sed -n 's/^TB0=//p' "$BLOQ_OUT"); TB1=$(sed -n 's/^TB1=//p' "$BLOQ_OUT")
TA=$(sed -n 's/^TA=//p' "$LEIT_OUT");   CESTA_T1=$(sed -n 's/^CESTA=//p' "$LEIT_OUT")
if [ -z "$TB0" ] || [ -z "$TB1" ] || [ -z "$TA" ] || [ -z "$CESTA_T1" ]; then
  bad "T1 corrida não produziu os marcos (TB0=[$TB0] TA=[$TA] TB1=[$TB1] CESTA=[$CESTA_T1])"
else
  SOBREP=$(Pq -c "SELECT CASE WHEN '$TB0'::timestamptz < '$TA'::timestamptz AND '$TA'::timestamptz < '$TB1'::timestamptz THEN 'SIM' ELSE 'NAO' END;")
  echo "     [CESTA=$CESTA_T1 SOBREP=$SOBREP]"
  if [ "$SOBREP" = "SIM" ]; then
    ok "T1 cenário TEM dente: a leitura caiu DENTRO da reconciliação não-commitada"
  else
    bad "T1 cenário SEM dente: a leitura não caiu na janela de B (TB0=$TB0 TA=$TA TB1=$TB1)"
  fi
  case "$CESTA_T1" in
    "$ANTIGA_COMPLETA"|"$NOVA_COMPLETA") ok "T1 revisão COMPLETA sob reconciliação concorrente (veio [$CESTA_T1])" ;;
    *) bad "T1 MISTURA de revisões: veio [$CESTA_T1], esperado [$ANTIGA_COMPLETA] ou [$NOVA_COMPLETA]" ;;
  esac
  eq "T1b sob transação ABERTA o leitor vê a revisão ANTIGA (isolamento, não sorte)" "$CESTA_T1" "$ANTIGA_COMPLETA"
fi
eq "T1c depois do COMMIT o leitor vê a revisão NOVA COMPLETA" "$(Pq -c "$CESTA")" "$NOVA_COMPLETA"

# ══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3). Uma sabotagem por bloco: sabotagem que contamina o
# assert vizinho não prova o vizinho (lição do harness do #2132).
# ══════════════════════════════════════════════════════════════════════════════════
# ══════════════════════════════════════════════════════════════════════════════════
# T2 — O DIFF É DECLARATIVO: um item que NASCE durante a janela não sobrevive
# ══════════════════════════════════════════════════════════════════════════════════
# Este é o assert que separa esta entrega da alternativa barata (o TS mandar o diff pronto).
# Um diff computado FORA da transação não conhece o item que nasceu depois do SELECT: ele não
# estaria nem em `inserir` nem em `deletar`, e SOBREVIVERIA — revisão "nova + um estranho",
# aplicada atomicamente e errada. Aqui o intruso é inserido ANTES da RPC rodar, e a RPC tem de
# removê-lo, porque ela reconcilia contra o conjunto DESEJADO, não contra um diff de terceiros.
echo "── T2: item intruso commitado antes da RPC — o desejado é o pós-estado, sempre ──"
seed
P -q -c "INSERT INTO public.order_items (customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, hash_payload, sales_order_id)
         VALUES ('$U','7d000000-0000-0000-0000-0000000000e1',5,1,1,0,'intruso','$PA');"
eq "T2a o intruso está no banco antes da reconciliação" \
   "$(Pq -c "$CESTA")" "a1,b1,e1"
P -q -c "SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO);" >/dev/null
eq "T2b depois da RPC o pós-estado é EXATAMENTE o desejado (o intruso não sobrevive)" \
   "$(Pq -c "$CESTA")" "$NOVA_COMPLETA"

# ══════════════════════════════════════════════════════════════════════════════════
# T3 — DOIS LOTES CONCORRENTES no MESMO pedido: o FOR UPDATE serializa
# ══════════════════════════════════════════════════════════════════════════════════
# Duas sessões reconciliam o mesmo pedido para revisões DIFERENTES ao mesmo tempo. Sem o
# `FOR UPDATE` do pai, as duas leriam o mesmo estado e a segunda poderia aplicar um diff calculado
# sobre um estado que a primeira já mudou. Com ele, uma espera a outra e o pós-estado é UMA das
# duas revisões, inteira — nunca a soma.
echo "── T3: dois lotes concorrentes no mesmo pedido ──"
seed
OUTRA=$(printf '%s' "$NOVA" | sed 's/"omie_codigo_produto":3,/"omie_codigo_produto":4,/; s|0000000000c1|0000000000d1|; s/"total":330.00/"total":444.00/')
T3_A="$(mktemp "/tmp/t3a-${SLUG}.XXXXXX")"; T3_B="$(mktemp "/tmp/t3b-${SLUG}.XXXXXX")"
( P -tA >"$T3_A" 2>&1 -c "BEGIN; SELECT pg_sleep(0.3); SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO); COMMIT;" ) &
A3PID=$!
( P -tA >"$T3_B" 2>&1 -c "BEGIN; SELECT public.reconciliar_pedidos_omie('$OUTRA'::jsonb, $GERIDO); SELECT pg_sleep(0.6); COMMIT;" ) &
B3PID=$!
wait "$A3PID"; wait "$B3PID"
CESTA_T3="$(Pq -c "$CESTA")"
echo "     [CESTA=$CESTA_T3]"
case "$CESTA_T3" in
  "b1,c1"|"b1,d1") ok "T3 pós-estado é UMA revisão inteira sob dois lotes concorrentes (veio [$CESTA_T3])" ;;
  *) bad "T3 as duas reconciliações se misturaram: veio [$CESTA_T3], esperado [b1,c1] ou [b1,d1]" ;;
esac
eq "T3b nenhuma das duas sessões falhou (o FOR UPDATE fez esperar, não abortar)" \
   "$(grep -c 'ERROR' "$T3_A" "$T3_B" | awk -F: '{s+=$2} END {print s}')" "0"
# ⚠️ Antídoto de falso-verde: "uma revisão inteira" é o resultado esperado TAMBÉM quando uma das
# sessões não rodou. O cenário só tem dente se as DUAS executaram a RPC e as DUAS corrigiram.
eq "T3c cenário TEM dente: as DUAS sessões executaram a RPC e escreveram" \
   "$(grep -ch '"corrections": [1-9]' "$T3_A" "$T3_B" | awk '{s+=$1} END {print s}')" "2"
rm -f "$T3_A" "$T3_B"

echo "── F1: o writer de HOJE (statements soltas) no MESMO cenário — exija VERMELHO ──"
# Não é uma sabotagem da RPC: é a reprodução fiel do que `sync-reprocess` fazia ANTES desta
# entrega — insert do item novo numa transação, delete do velho e cabeçalho depois. É o cenário
# que a pendência do #2132 descreveu e que a entrega dele FALHA de propósito.
seed
P -q -c "INSERT INTO public.order_items (customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, hash_payload, sales_order_id)
         VALUES ('$U','$P3',3,5,30,0,'omie_oben_777_3','$PA');"   # transação 1: item novo COMMITADO
CESTA_F1=$(Pq -c "$CESTA")                                        # o leitor cai exatamente aqui
P -q -c "DELETE FROM public.order_items WHERE sales_order_id='$PA' AND omie_codigo_produto=1;"  # transação 2
P -q -c "UPDATE public.sales_orders SET status='faturado', total=330.00 WHERE id='$PA';"        # transação 3
case "$CESTA_F1" in
  "$ANTIGA_COMPLETA"|"$NOVA_COMPLETA") bad "F1 SEM DENTE: o writer velho devolveu revisão completa [$CESTA_F1] — o cenário não reproduz o defeito" ;;
  *) ok "F1 o writer de HOJE RASGA: veio [$CESTA_F1], que não é nem a antiga nem a nova (é a mistura que a RPC elimina)" ;;
esac
eq "F1b e a mistura é exatamente 'velho + novo convivendo'" "$CESTA_F1" "a1,b1,c1"

echo "── F6: sabota a CTE de DELETE — exija VERMELHO em T2b ──"
# Sem a remoção, o pós-estado vira "desejado + o que já estava lá": exatamente a revisão
# "nova mais um estranho" que o diff computado FORA da transação produziria.
SAB5="$(mktemp "/tmp/sab5-${SLUG}.XXXXXX.sql")"
sed "s/^             AND NOT EXISTS (SELECT 1 FROM desejado d WHERE d.cod = a.cod)$/             AND false/" "$MIG" > "$SAB5"
eq "F6 sabotagem aplicada (a CTE de delete não casa mais ninguém)" \
   "$(grep -c '^             AND false$' "$SAB5")" "1"
P -q -f "$SAB5"
seed
P -q -c "INSERT INTO public.order_items (customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, discount, hash_payload, sales_order_id)
         VALUES ('$U','7d000000-0000-0000-0000-0000000000e1',5,1,1,0,'intruso','$PA');"
P -q -c "SELECT public.reconciliar_pedidos_omie('$NOVA'::jsonb, $GERIDO);" >/dev/null
CESTA_F6="$(Pq -c "$CESTA")"
if [ "$CESTA_F6" = "$NOVA_COMPLETA" ]; then
  bad "F6 SEM DENTE: sem a CTE de delete o pós-estado seguiu correto [$CESTA_F6] — T2b não prova nada"
else
  ok "F6 T2b fica VERMELHO: sem a remoção o pós-estado vira 'nova + estranhos' [$CESTA_F6]"
fi
P -q -f "$MIG"
rm -f "$SAB5"

echo "── F2: sabota a igualdade de CONJUNTO da lista de status — exija VERMELHO em B5 ──"
SAB1="$(mktemp "/tmp/sab1-${SLUG}.XXXXXX.sql")"
# A sabotagem é o guard FRACO que o desenho recusou: "não-vazia e sem NULL" em vez de conjunto.
sed -e 's/^     OR (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_status_gerido_omie) x) IS DISTINCT FROM$/     OR cardinality(p_status_gerido_omie) = 0 OR false = (/' \
    -e 's/^        (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(c_status_omie) x)$/        SELECT true)/' \
    "$MIG" > "$SAB1"
eq "F2 sabotagem aplicada (guard vira 'não-vazia', o fraco que o desenho recusou)" \
   "$(grep -c 'cardinality(p_status_gerido_omie) = 0' "$SAB1")" "1"
P -q -f "$SAB1"
if P -q -c "DO \$t\$ BEGIN PERFORM public.reconciliar_pedidos_omie('[]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado','entregue']); RAISE EXCEPTION 'SENTINELA_SEM_DENTE' USING ERRCODE='P0001'; EXCEPTION WHEN sqlstate '22023' THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$;" >/dev/null 2>&1
then bad "F2 SEM DENTE: B5 seguiu barrando mesmo com o guard sabotado"
else ok "F2 B5 fica VERMELHO com o guard fraco — a igualdade de conjunto é o que morde"; fi
P -q -f "$MIG"   # restaura a versão verdadeira

echo "── F3: sabota 'ausente ≠ zero' do total — exija VERMELHO em C1c ──"
SAB2="$(mktemp "/tmp/sab2-${SLUG}.XXXXXX.sql")"
sed -e "s/^        RAISE EXCEPTION 'pedido % sem total — ausente não é zero', v_hash USING ERRCODE = '22023';$/        NULL;/" \
    -e "s/^      v_total_novo := (v_pedido->>'total')::numeric;$/      v_total_novo := coalesce((v_pedido->>'total')::numeric, 0);/" \
    "$MIG" > "$SAB2"
eq "F3 sabotagem aplicada (o total ausente volta a virar zero)" \
   "$(grep -c "coalesce((v_pedido->>'total')::numeric, 0)" "$SAB2")" "1"
P -q -f "$SAB2"
seed
P -q -c "SELECT public.reconciliar_pedidos_omie('$SEM_TOTAL'::jsonb, $GERIDO);" >/dev/null
TOT_SAB="$(Pq -c "SELECT total FROM public.sales_orders WHERE id='$PA';")"
if [ "$TOT_SAB" = "0" ]; then ok "F3 C1c fica VERMELHO: sem o guard o pedido é ZERADO (total=$TOT_SAB) — o assert morde"
else bad "F3 SEM DENTE: total ficou [$TOT_SAB], a sabotagem não produziu a fabricação de zero"; fi
P -q -f "$MIG"

echo "── F4: sabota o guard de SKU repetido — exija VERMELHO em C6 ──"
SAB3="$(mktemp "/tmp/sab3-${SLUG}.XXXXXX.sql")"
sed "s/^      IF v_n_distintos <> v_n_validos THEN$/      IF false THEN/" "$MIG" > "$SAB3"
eq "F4 sabotagem aplicada (o guard de ambiguidade some)" "$(grep -c '^      IF false THEN$' "$SAB3")" "1"
P -q -f "$SAB3"
seed
P -q -c "SELECT public.reconciliar_pedidos_omie('$SKU_REP'::jsonb, $GERIDO);" >/dev/null
N_SAB="$(Pq -c "SELECT count(*) FROM public.order_items WHERE sales_order_id='$PA';")"
if [ "$N_SAB" = "2" ]; then bad "F4 SEM DENTE: sem o guard os itens seguiram intactos ($N_SAB) — C6 não prova nada"
else ok "F4 C6 fica VERMELHO: sem o guard a reconciliação ambígua APAGA linha legítima (sobrou $N_SAB de 2)"; fi
P -q -f "$MIG"

echo "── F5: remove o REVOKE — exija VERMELHO em C9 ──"
SAB4="$(mktemp "/tmp/sab4-${SLUG}.XXXXXX.sql")"
grep -v '^REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie' "$MIG" > "$SAB4"
eq "F5 sabotagem aplicada (o REVOKE sai do arquivo)" "$(grep -c '^REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie' "$SAB4")" "0"
P -q -c "DROP FUNCTION public.reconciliar_pedidos_omie(jsonb, text[]);" >/dev/null   # DROP reseta o ACL
P -q -f "$SAB4"
if P -q -c "SET ROLE anon; SELECT public.reconciliar_pedidos_omie('[]'::jsonb, $GERIDO);" >/dev/null 2>&1
then ok "F5 C9 fica VERMELHO: sem o REVOKE nomeando as roles, anon EXECUTA a RPC de escrita"
else bad "F5 SEM DENTE: anon seguiu barrado sem o REVOKE — C9 passa pelo motivo errado"; fi
P -q -c "DROP FUNCTION public.reconciliar_pedidos_omie(jsonb, text[]);" >/dev/null
P -q -f "$MIG"
eq "F5b restaurado: anon volta a ser barrado" \
   "$(P -q -c "SET ROLE anon; SELECT public.reconciliar_pedidos_omie('[]'::jsonb, $GERIDO);" >/dev/null 2>&1 && echo executou || echo barrado)" "barrado"

echo
echo "═══ RESULTADO: $PASS pass · $FAIL fail ═══"
[ "$FAIL" -eq 0 ]

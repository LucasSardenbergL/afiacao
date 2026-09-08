#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — coerência do agregado PEDIDO DE VENDA                            ║
# ║   sales_orders (cabeçalho) + order_items (linhas) + sales_orders.items (jsonb)║
# ║                                                                                ║
# ║ INVARIANTE (tem dono no BANCO, não no escritor):                              ║
# ║   Se um pedido TEM linhas em order_items, então o conjunto dessas linhas e o   ║
# ║   items jsonb descrevem os MESMOS itens.                                       ║
# ║ Condicionada de propósito: o push do app cria pedido com jsonb e SEM linhas    ║
# ║ (9 dos 11 escritores de jsonb fazem isso e estão CERTOS). "Sempre coerente"    ║
# ║ quebraria o desenho legítimo; "coerente se publicou linhas" pega só o defeito. ║
# ║                                                                                ║
# ║ Rode: bash db/test-pedido-venda-coerencia.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="pedido-venda-coerencia"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHOU $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT ==="

# ══════════════════════════════════════════════════════════════════
# ZONA 1 — schema FIEL A PROD (medido via psql-ro em 2026-09-07)
# ══════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid,
  items jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0,
  total    numeric NOT NULL DEFAULT 0,
  status text,
  omie_pedido_id bigint,
  account text,
  hash_payload text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid,
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric,              -- NULLABLE desde 2026-09-05 (ausente != zero)
  discount numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  hash_payload text,
  omie_codigo_item bigint          -- identidade de linha (20260906180000)
);
-- identidade canônica: a ÚNICA invariante do agregado que já é estrutural hoje
CREATE UNIQUE INDEX uniq_sales_orders_omie_pedido_id
  ON sales_orders(account, omie_pedido_id)
  WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;
SQL
echo "-- schema pronto --"

SQL_SEED=$(cat <<'SQL'
-- P1: pedido CANÔNICO importado do Omie: jsonb + linhas coerentes (2 itens, R$100)
INSERT INTO sales_orders (id, customer_user_id, items, subtotal, total, status, omie_pedido_id, account, hash_payload)
VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
  '[{"omie_codigo_produto":10,"quantidade":2,"valor_unitario":30,"desconto":0,"descricao":"A"},
    {"omie_codigo_produto":20,"quantidade":1,"valor_unitario":40,"desconto":0,"descricao":"B"}]'::jsonb,
  100, 100, 'faturado', 555, 'oben', 'omie_oben_555');
INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, omie_codigo_item)
VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',10,2,30,0,901),
       ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',20,1,40,0,902);

-- P2: pedido PUSH do app (orçamento): jsonb SEM linhas -- DESENHO LEGÍTIMO, não é defeito
INSERT INTO sales_orders (id, customer_user_id, items, subtotal, total, status, account)
VALUES ('aaaa0000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',
  '[{"omie_codigo_produto":30,"quantidade":5,"valor_unitario":10,"desconto":0,"descricao":"C"}]'::jsonb,
  50, 50, 'orcamento', 'oben');
SQL
)
P -q -c "$SQL_SEED"
echo "-- seed pronto --"

# ══════════════════════════════════════════════════════════════════
# ZONA 2 — asserts ANTES (sem invariante: o defeito de PROD passa)
# ══════════════════════════════════════════════════════════════════
echo "-- A. ANTES: o escritor alternativo corrompe em silêncio --"

eq "A1 P1 nasce coerente (2 linhas)" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "2"

# Reprodução EXATA de supabase/functions/omie-vendas-sync/index.ts:3381
# (edição pós-Omie: grava items+subtotal+total e NUNCA toca order_items)
P -q -c "
UPDATE sales_orders SET
  items = '[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":30,\"desconto\":0,\"descricao\":\"A\"},
            {\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":40,\"desconto\":0,\"descricao\":\"B\"},
            {\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":25,\"desconto\":0,\"descricao\":\"D\"}]'::jsonb,
  subtotal = 175, total = 175, updated_at = now()
WHERE id='aaaa0000-0000-0000-0000-000000000001';"

eq "A2 ANTES: jsonb passou a 3 itens" \
   "$(Pq -c "SELECT jsonb_array_length(items) FROM sales_orders WHERE id='aaaa0000-0000-0000-0000-000000000001'")" "3"
eq "A3 ANTES: order_items ficou em 2 -- DIVERGENTE e o banco aceitou" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "2"
eq "A4 ANTES: quem le pelas LINHAS ve 100, cabecalho diz 175 (R\$75 invisiveis)" \
   "$(Pq -c "SELECT sum(quantity*unit_price)::int FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "100"


# ══════════════════════════════════════════════════════════════════
# ZONA 3 — instala a INVARIANTE e prova o DEPOIS
# ══════════════════════════════════════════════════════════════════
echo
echo "-- B. DEPOIS: a invariante passa a ter dono no BANCO --"

# restaura P1 ao estado coerente antes de instalar (o dano da ZONA 2 e proposital)
P -q -c "UPDATE sales_orders SET items='[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":30,\"desconto\":0,\"descricao\":\"A\"},{\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":40,\"desconto\":0,\"descricao\":\"B\"}]'::jsonb, subtotal=100, total=100 WHERE id='aaaa0000-0000-0000-0000-000000000001';"
P -f "$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
echo "-- invariante instalada --"

# B1: o MESMO update da ZONA 2 (o escritor alternativo real) agora e RECUSADO
set +e
ERR_B1="$(P -q -c "
UPDATE sales_orders SET
  items = '[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":30,\"desconto\":0,\"descricao\":\"A\"},
            {\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":40,\"desconto\":0,\"descricao\":\"B\"},
            {\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":25,\"desconto\":0,\"descricao\":\"D\"}]'::jsonb,
  subtotal = 175, total = 175
WHERE id='aaaa0000-0000-0000-0000-000000000001';" 2>&1)"
RC_B1=$?
set -e
if [ "$RC_B1" -ne 0 ] && printf '%s' "$ERR_B1" | grep -q 'incoerente'; then
  ok "B1 escritor alternativo (omie-vendas-sync:3381) RECUSADO no commit"
else
  bad "B1 escritor alternativo PASSOU -- invariante nao fechou (rc=$RC_B1)"
fi
eq "B2 estado preservado: order_items segue com 2" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "2"
eq "B3 cabecalho NAO ficou com o total novo (rollback total)" \
   "$(Pq -c "SELECT total::int FROM sales_orders WHERE id='aaaa0000-0000-0000-0000-000000000001'")" "100"

# B4: o caminho LEGITIMO (cabecalho + linhas na MESMA transacao) continua passando
set +e
OUT_B4="$(P -q -c "
BEGIN;
UPDATE sales_orders SET items = items || '[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":25,\"desconto\":0,\"descricao\":\"D\"}]'::jsonb,
       subtotal=175, total=175 WHERE id='aaaa0000-0000-0000-0000-000000000001';
INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, omie_codigo_item)
VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',40,3,25,0,903);
COMMIT;" 2>&1)"
RC_B4=$?
set -e
if [ "$RC_B4" -eq 0 ]; then ok "B4 escrita ATOMICA (cabecalho+linhas na mesma tx) PASSA"
else bad "B4 escrita legitima foi barrada -- invariante rigida demais: $OUT_B4"; fi
eq "B5 apos a escrita atomica: 3 linhas" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "3"

# B6: push do app (jsonb SEM linhas) continua legitimo -- nao pode ser barrado
set +e
OUT_B6="$(P -q -c "UPDATE sales_orders SET items='[{\"omie_codigo_produto\":30,\"quantidade\":9,\"valor_unitario\":10,\"desconto\":0,\"descricao\":\"C\"}]'::jsonb, subtotal=90,total=90 WHERE id='aaaa0000-0000-0000-0000-000000000002';" 2>&1)"
RC_B6=$?
set -e
if [ "$RC_B6" -eq 0 ]; then ok "B6 pedido PUSH do app (sem linhas) segue livre -- desenho legitimo preservado"
else bad "B6 invariante barrou o push do app: $OUT_B6"; fi

# ══════════════════════════════════════════════════════════════════
# ZONA 4 — ATAQUES POR FORA (o Codex: "escritor alternativo, retry
# concorrente ou dado ausente; se violar, a centralizacao nao fechou")
# ══════════════════════════════════════════════════════════════════
echo
echo "-- C. ATAQUES: tentar violar a invariante POR FORA do caminho coberto --"

atk() { # $1 rotulo | $2 SQL que TENTA violar
  set +e
  local out rc
  out="$(P -q -c "$2" 2>&1)"; rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then ok "C:$1 bloqueado"
  else bad "C:$1 PASSOU -- a invariante NAO cobre esta borda"; fi
}

# C1 DELETE de linha por fora (deixa jsonb com mais itens que a tabela).
# Ausencia de sinal NAO e aprovacao: um DELETE que casa 0 linhas "passa" sem
# atacar nada. Provar primeiro que a linha-alvo EXISTE.
eq "C0 pre-condicao do ataque C1: a linha-alvo existe" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10")" "1"
atk "delete-de-linha-solto" \
  "DELETE FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10;"

# C2 INSERT de linha fantasma que nao existe no jsonb
atk "insert-de-linha-fantasma" \
  "INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
   VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',99,1,5);"

# C3 UPDATE do PRECO so na linha (money-path: preco diverge do jsonb)
atk "update-de-preco-so-na-linha" \
  "UPDATE order_items SET unit_price=999 WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10;"

# C4 DADO AUSENTE: apagar o preco da linha (NULL) sem mexer no jsonb.
#    ausente != zero -- NULL nao pode "casar" com o 30 do jsonb.
atk "preco-da-linha-vira-NULL" \
  "UPDATE order_items SET unit_price=NULL WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10;"

# C5 DADO AUSENTE do outro lado: jsonb perde a chave de preco
atk "jsonb-perde-a-chave-de-preco" \
  "UPDATE sales_orders SET items = (SELECT jsonb_agg(el - 'valor_unitario') FROM jsonb_array_elements(items) el)
   WHERE id='aaaa0000-0000-0000-0000-000000000001';"

# C6 esvaziar o jsonb mantendo as linhas
atk "jsonb-esvaziado-com-linhas-vivas" \
  "UPDATE sales_orders SET items='[]'::jsonb WHERE id='aaaa0000-0000-0000-0000-000000000001';"

# C9 AUSENTE != ZERO no desconto: linha com discount NULL nao casa com "desconto":0
#    do jsonb. Rigidez DELIBERADA -- em prod discount e 0 em 100% das 70.860
#    linhas (nenhum NULL), entao isso barra escritor novo que omita o campo.
atk "discount-NULL-vs-desconto-0" \
  "UPDATE order_items SET discount=NULL WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10;"

# C7 SET CONSTRAINTS ALL IMMEDIATE nao pode virar bypass (so antecipa a checagem)
atk "set-constraints-immediate" \
  "BEGIN; SET CONSTRAINTS ALL IMMEDIATE;
   INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
   VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',77,1,1);
   COMMIT;"

# C8 COPY (caminho que NAO passa por INSERT normal)
atk "copy-de-linha-fantasma" \
  "COPY order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
   FROM STDIN WITH (FORMAT csv);
aaaa0000-0000-0000-0000-000000000001,11111111-1111-1111-1111-111111111111,88,1,7
\\."

echo
echo "-- D. BORDAS QUE A INVARIANTE NAO COBRE (declaradas, nao escondidas) --"
# D1 session_replication_role='replica' desliga TODA trigger nao-ALWAYS.
#    Nao e furo do desenho: e privilegio de superusuario/owner. O que NAO pode
#    acontecer e isso passar despercebido -- por isso vira assert explicito.
set +e
P -q -c "BEGIN; SET session_replication_role='replica';
  INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
  VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',66,1,3);
  COMMIT;" >/dev/null 2>&1
RC_D1=$?
set -e
if [ "$RC_D1" -eq 0 ]; then
  ok "D1 session_replication_role=replica CONTORNA (esperado: privilegio de superuser; documentado)"
  P -q -c "DELETE FROM order_items WHERE omie_codigo_produto=66;" >/dev/null 2>&1 || true
  P -q -c "SET session_replication_role='replica'; DELETE FROM order_items WHERE omie_codigo_produto=66;" >/dev/null 2>&1 || true
else
  ok "D1 session_replication_role=replica tambem bloqueado (mais forte que o esperado)"
fi

# ══════════════════════════════════════════════════════════════════
# ZONA 4b — RETRY CONCORRENTE (exigencia explicita do parecer)
# Dois escritores que dividem o agregado entre transacoes distintas:
# cada metade e "correta" sozinha. Se AMBAS commitarem, a centralizacao
# nao fechou -- o agregado ficaria incoerente com duas escritas validas.
# ══════════════════════════════════════════════════════════════════
echo
echo "-- F. CONCORRENCIA: duas metades de uma reconciliacao, em transacoes separadas --"

# leva P1 de volta ao estado coerente conhecido: jsonb=[10,20] e linhas=[10,20]
P -q -c "BEGIN;
  DELETE FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001';
  INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, omie_codigo_item)
  VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',10,2,30,0,901),
         ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',20,1,40,0,902);
  UPDATE sales_orders SET items='[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":30,\"desconto\":0,\"descricao\":\"A\"},{\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":40,\"desconto\":0,\"descricao\":\"B\"}]'::jsonb,
         subtotal=100, total=100 WHERE id='aaaa0000-0000-0000-0000-000000000001';
COMMIT;"
eq "F0 estado de partida coerente (2 linhas)" \
   "$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")" "2"

# Duas sessoes REAIS, intercaladas por FIFO (ordem deterministica, sem sleep-e-torcer)
F1=/tmp/pvc-fifo1.$$; F2=/tmp/pvc-fifo2.$$
mkfifo "$F1" "$F2"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=0 -q < "$F1" > /tmp/pvc-s1.$$ 2>&1 &
S1=$!
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=0 -q < "$F2" > /tmp/pvc-s2.$$ 2>&1 &
S2=$!
exec 8> "$F1"; exec 9> "$F2"

# T1 abre e escreve SO as linhas (metade A)
echo "BEGIN;" >&8
echo "INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount) VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',40,3,25,0);" >&8
# T2 abre e escreve SO o jsonb (metade B) -- nenhum lock em comum com T1
echo "BEGIN;" >&9
echo "UPDATE sales_orders SET items = items || '[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":25,\"desconto\":0,\"descricao\":\"D\"}]'::jsonb, subtotal=175, total=175 WHERE id='aaaa0000-0000-0000-0000-000000000001';" >&9
# ambas commitam: T1 primeiro, T2 depois
echo "COMMIT;" >&8
echo "COMMIT;" >&9
exec 8>&-; exec 9>&-
wait $S1 $S2 2>/dev/null || true
O1="$(cat /tmp/pvc-s1.$$)"; O2="$(cat /tmp/pvc-s2.$$)"
rm -f "$F1" "$F2" /tmp/pvc-s1.$$ /tmp/pvc-s2.$$

T1_OK=$(printf '%s' "$O1" | grep -c 'ROLLBACK\|ERROR' || true)
T2_OK=$(printf '%s' "$O2" | grep -c 'ROLLBACK\|ERROR' || true)
if [ "$T1_OK" -eq 0 ] && [ "$T2_OK" -eq 0 ]; then
  bad "F1 AMBAS as metades commitaram -- a invariante NAO resiste a concorrencia"
else
  ok "F1 ao menos uma das metades concorrentes foi RECUSADA (T1 err=$T1_OK, T2 err=$T2_OK)"
fi
# o que importa de verdade: o estado FINAL e coerente?
FINAL_REL="$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")"
FINAL_JSON="$(Pq -c "SELECT jsonb_array_length(items) FROM sales_orders WHERE id='aaaa0000-0000-0000-0000-000000000001'")"
eq "F2 estado FINAL coerente apos a corrida (linhas == itens do jsonb)" "$FINAL_REL" "$FINAL_JSON"

# ══════════════════════════════════════════════════════════════════
# ZONA 4c — REPEATABLE READ (furo apontado no parecer)
# "A funcao diferida apenas consulta; em REPEATABLE READ ela pode validar uma
#  visao desatualizada." Se isso for verdade, duas transacoes RR podem commitar
#  e deixar o agregado incoerente. Medir, nao argumentar.
# ══════════════════════════════════════════════════════════════════
echo
echo "-- G. REPEATABLE READ: a checagem diferida valida visao velha? --"

P -q -c "BEGIN;
  DELETE FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001';
  INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, omie_codigo_item)
  VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',10,2,30,0,901),
         ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',20,1,40,0,902);
  UPDATE sales_orders SET items='[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":30,\"desconto\":0,\"descricao\":\"A\"},{\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":40,\"desconto\":0,\"descricao\":\"B\"}]'::jsonb,
         subtotal=100,total=100 WHERE id='aaaa0000-0000-0000-0000-000000000001';
COMMIT;"

G1=/tmp/pvc-g1.$$; G2=/tmp/pvc-g2.$$
mkfifo "$G1" "$G2"
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q < "$G1" > /tmp/pvc-r1.$$ 2>&1 & R1=$!
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -q < "$G2" > /tmp/pvc-r2.$$ 2>&1 & R2=$!
exec 8> "$G1"; exec 9> "$G2"

# ambas em REPEATABLE READ; cada uma FIXA o snapshot com um SELECT antes de escrever
echo "BEGIN ISOLATION LEVEL REPEATABLE READ;" >&8
echo "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001';" >&8
echo "BEGIN ISOLATION LEVEL REPEATABLE READ;" >&9
echo "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001';" >&9
# T1 escreve SO a linha; T2 escreve SO o jsonb -- sem lock em comum
echo "INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount) VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',40,3,25,0);" >&8
echo "UPDATE sales_orders SET items = items || '[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":25,\"desconto\":0,\"descricao\":\"D\"}]'::jsonb, subtotal=175,total=175 WHERE id='aaaa0000-0000-0000-0000-000000000001';" >&9
echo "COMMIT;" >&8; echo "COMMIT;" >&9
exec 8>&-; exec 9>&-
wait $R1 $R2 2>/dev/null || true
rm -f "$G1" "$G2" /tmp/pvc-r1.$$ /tmp/pvc-r2.$$

# O QUE IMPORTA nao e quem falhou, e o ESTADO FINAL: coerente ou nao?
GR="$(Pq -c "SELECT count(*) FROM order_items WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001'")"
GJ="$(Pq -c "SELECT jsonb_array_length(items) FROM sales_orders WHERE id='aaaa0000-0000-0000-0000-000000000001'")"
if [ "$GR" = "$GJ" ]; then
  ok "G1 sob REPEATABLE READ o estado final ficou COERENTE (linhas=$GR json=$GJ)"
else
  bad "G1 REPEATABLE READ deixou o agregado INCOERENTE (linhas=$GR json=$GJ) -- falta serializacao no pai"
fi

# ══════════════════════════════════════════════════════════════════
# ZONA 4d — a POSTCONDICAO da migration tem dente?
# Roda a migration SABOTADA num database separado do MESMO cluster (o servidor
# ja esta de pe -- evita ler "servidor nao subiu" como se fosse veredito).
# ══════════════════════════════════════════════════════════════════
echo
echo "-- H. POSTCONDICAO: sabotar o ENABLE ALWAYS e exigir que o APPLY aborte --"
MIG="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres sab
Ps() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d sab -v ON_ERROR_STOP=1 "$@"; }
Ps -q -c "
CREATE TABLE sales_orders (id uuid PRIMARY KEY, items jsonb, subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0, status text,
  omie_pedido_id bigint, account text, hash_payload text);
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL, product_id uuid, omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric, omie_codigo_item bigint);"

# CONTROLE VERDE na MESMA invocacao: a migration INTEIRA precisa aplicar limpa aqui.
# Sem esse controle, uma sabotagem "sempre-vermelha" aprovaria qualquer coisa.
set +e
CTRL="$(Ps -f "$MIG" 2>&1)"; RC_CTRL=$?
set -e
if [ "$RC_CTRL" -eq 0 ] && printf '%s' "$CTRL" | grep -q 'POSTCOND-OK'; then
  ok "H0 CONTROLE: migration integra aplica limpa no db de teste"
else
  bad "H0 CONTROLE VERMELHO -- a sabotagem abaixo nao provaria nada (rc=$RC_CTRL)"
fi

# agora a sabotada, em db limpo
"$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres sab
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres sab
Ps -q -c "
CREATE TABLE sales_orders (id uuid PRIMARY KEY, items jsonb, subtotal numeric NOT NULL DEFAULT 0,
  discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0, status text,
  omie_pedido_id bigint, account text, hash_payload text);
CREATE TABLE order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL, product_id uuid, omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric, omie_codigo_item bigint);"
sed 's|^ALTER TABLE order_items  ENABLE ALWAYS TRIGGER.*|-- SABOTADO|' "$MIG" > /tmp/mig-sab-$$.sql
set +e
SAB="$(Ps -f /tmp/mig-sab-$$.sql 2>&1)"; RC_SAB=$?
set -e
rm -f /tmp/mig-sab-$$.sql
if [ "$RC_SAB" -ne 0 ] && printf '%s' "$SAB" | grep -q 'POSTCOND'; then
  ok "H1 sabotar ENABLE ALWAYS -> apply ABORTA na postcondicao (tem dente)"
else
  bad "H1 apply passou sabotado (rc=$RC_SAB) -- postcondicao e decoracao"
fi

# ══════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICACAO: cada assert tem dente?
# Sabotar a invariante e exigir que os asserts de bloqueio fiquem VERMELHOS.
# Sem isso, uma invariante sempre-verde "aprovaria" tudo.
# ══════════════════════════════════════════════════════════════════
echo
echo "-- E. FALSIFICACAO: derruba a invariante e exige que C1..C3 passem a PASSAR --"
P -q -c "DROP TRIGGER IF EXISTS trg_pedido_venda_coerencia_cab ON sales_orders;
         DROP TRIGGER IF EXISTS trg_pedido_venda_coerencia_lin ON order_items;" >/dev/null

falso() { # $1 rotulo | $2 SQL que era bloqueado
  set +e
  local out rc; out="$(P -q -c "$2" 2>&1)"; rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then ok "E:$1 SEM a invariante o ataque passa -> o assert tinha dente"
  else bad "E:$1 continuou bloqueado SEM a invariante -- o assert media OUTRA coisa: $out"; fi
}
falso "insert-de-linha-fantasma" \
  "INSERT INTO order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price)
   VALUES ('aaaa0000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',99,1,5);"
falso "update-de-preco-so-na-linha" \
  "UPDATE order_items SET unit_price=999 WHERE sales_order_id='aaaa0000-0000-0000-0000-000000000001' AND omie_codigo_produto=10;"
falso "jsonb-esvaziado-com-linhas-vivas" \
  "UPDATE sales_orders SET items='[]'::jsonb WHERE id='aaaa0000-0000-0000-0000-000000000001';"

echo
echo "=== TOTAL: $PASS ok, $FAIL falhas ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "PROVA-PEDIDO-VENDA-COERENCIA-OK"

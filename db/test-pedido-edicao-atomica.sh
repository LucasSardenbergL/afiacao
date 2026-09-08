#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — aplicar_edicao_pedido_omie (write-back ATÔMICO da edição)        ║
# ║ Ritual: .claude/skills/prove-sql-money-path                                   ║
# ║ Roda: bash db/test-pedido-edicao-atomica.sh    (NÃO pipe pra tail: engole o   ║
# ║ exit code). Modo falsificação vai junto — não é flag, é parte do laço.        ║
# ║                                                                               ║
# ║ O QUE ESTA PROVA COBRA                                                        ║
# ║   O escritor `alterar_pedido` (omie-vendas-sync) gravava items+total do pedido ║
# ║   e NUNCA tocava `order_items`. Em pedido canônico as linhas ficavam na        ║
# ║   revisão VELHA — 15 pedidos, R$ 27.795,25, R$ 10.676,56 invisíveis pro        ║
# ║   money-path. A ZONA 4/A REPRODUZ isso; o resto prova que a RPC fechou.        ║
# ║                                                                               ║
# ║   Nenhum assert casa string LOCALIZADA do Postgres: os negativos casam         ║
# ║   SQLSTATE e os de apply casam marcador ASCII próprio ([POSTCOND]). Por isso   ║
# ║   o LC_ALL=C do arranque não escolhe o resultado de nada.                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="pedido-edicao-atomica"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

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

PASS=0; FAIL=0; PEND=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20260907210000_pedido_edicao_omie_atomica.sql"
# A trigger irmã (PR #2363) é OPCIONAL aqui: ela é o deliverable do outro PR e esta migration
# precisa ir ANTES dela. Se o arquivo existir, a interação é provada; se não, o harness DIZ que
# não provou (ausência de dado nunca vira aprovação).
TRIG=""
for _t in "$REPO_ROOT"/supabase/migrations/*_pedido_venda_coerencia_agregado.sql; do
  [ -f "$_t" ] && TRIG="$_t" && break
done

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# `trg_order_items_created_at_omie` é STUB FIEL do que está em produção (lido por psql-ro em
# 2026-09-07 via pg_get_functiondef): ele só age quando o hash do pai casa 'omie\_%'. Está aqui
# porque a RPC sob teste é a que tem de preservar a recência MESMO FORA desse domínio.
PREREQ_SQL=$(cat <<'SQL'
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY,
  account text NOT NULL,
  hash_payload text,
  customer_user_id uuid NOT NULL,
  status text,
  omie_pedido_id bigint,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0,
  total numeric NOT NULL DEFAULT 0,
  notes text,
  omie_payload jsonb,
  omie_response jsonb,
  omie_reconciliado_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.omie_products (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  -- FK real da prod: product_id -> omie_products(id). Sem ela, "preservar o product_id" passaria
  -- com qualquer uuid e o assert nao mediria a restricao que existe no banco de verdade.
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric,
  discount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  hash_payload text,
  omie_codigo_item bigint
);
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
END; $f$;
DROP TRIGGER IF EXISTS trg_order_items_created_at_omie ON public.order_items;
CREATE TRIGGER trg_order_items_created_at_omie BEFORE INSERT ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_herdar_created_at_omie();
SQL
)
P -q -c "$PREREQ_SQL"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
# `VAR="$(cmd)"` sob `set -e` ABORTA o script quando o cmd falha, e o erro morre dentro da
# variável: o harness sairia sem dizer nada. Por isso o `set +e` cercando a captura.
set +e; APPLY_OUT="$(P -f "$MIG" 2>&1)"; RC_APPLY=$?; set -e
if [ "$RC_APPLY" -eq 0 ] && printf '%s' "$APPLY_OUT" | grep -q 'POSTCOND-OK'; then
  ok "Z2 migration real aplicou e a postcondicao do APPLY confirmou"
else
  bad "Z2 migration NAO aplicou limpa (rc=$RC_APPLY): $(printf '%s' "$APPLY_OUT" | grep -i 'erro\|error' | head -3)"
  echo "$APPLY_OUT" | tail -20
  exit 1
fi
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
CLI='11111111-1111-1111-1111-111111111111'
P1='aaaa0000-0000-0000-0000-000000000001'   # canonico COM linhas (o caso que corrompe)
P2='aaaa0000-0000-0000-0000-000000000002'   # push do app: SEM linhas (isento)
P3='aaaa0000-0000-0000-0000-000000000003'   # canonico COM linhas, para os negativos
INEX='aaaa0000-0000-0000-0000-0000000000ff'
PROD10='bbbb0000-0000-0000-0000-000000000010'   # product_id do SKU 10 (gravado, NAO vem no jsonb)
PROD20='bbbb0000-0000-0000-0000-000000000020'
PROD30='bbbb0000-0000-0000-0000-000000000030'   # so o payload conhece (item ACRESCENTADO)

seed() {  # semeia P1/P2/P3 no banco $1
  local db="$1"
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 -q -c "
INSERT INTO auth.users(id) VALUES ('$CLI') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id) VALUES ('$PROD10'),('$PROD20'),('$PROD30') ON CONFLICT DO NOTHING;
INSERT INTO public.sales_orders (id, account, hash_payload, customer_user_id, status, omie_pedido_id,
                                 items, subtotal, total, notes, created_at)
VALUES
 ('$P1','oben','omie_oben_777','$CLI','faturado',777,
  '[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":100,\"desconto\":0},
    {\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":50,\"desconto\":0}]'::jsonb,
  250, 250, 'obs antiga', '2026-01-15T12:00:00Z'),
 ('$P2','oben',NULL,'$CLI','rascunho',888,
  '[{\"omie_codigo_produto\":30,\"quantidade\":1,\"valor_unitario\":7}]'::jsonb, 7, 7, NULL, now()),
 ('$P3','oben','omie_oben_999','$CLI','separacao',999,
  '[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":10,\"desconto\":0}]'::jsonb,
  30, 30, NULL, '2026-02-20T12:00:00Z');
INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, hash_payload, omie_codigo_item)
VALUES ('$P1','$CLI',10,2,100,0,'omie_oben_777_10',5001),
       ('$P1','$CLI',20,1,50,0,'omie_oben_777_20',5002),
       ('$P3','$CLI',40,3,10,0,'omie_oben_999_40',6001);
UPDATE public.order_items SET product_id='$PROD10' WHERE sales_order_id='$P1' AND omie_codigo_produto=10;
UPDATE public.order_items SET product_id='$PROD20' WHERE sales_order_id='$P1' AND omie_codigo_produto=20;"
}
seed prove

# Predicado de coerencia do agregado — MESMO EXCEPT ALL da trigger irma. Serve de MEDIDOR aqui
# (o defeito e medido com a mesma regua com que a trigger vai medir).
COERENTE_SQL="
SELECT NOT EXISTS (
  (SELECT omie_codigo_produto, quantity, unit_price, discount FROM public.order_items WHERE sales_order_id = %L
   EXCEPT ALL
   SELECT (el->>'omie_codigo_produto')::bigint,(el->>'quantidade')::numeric,(el->>'valor_unitario')::numeric,(el->>'desconto')::numeric
     FROM public.sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el WHERE so.id = %L)
  UNION ALL
  (SELECT (el->>'omie_codigo_produto')::bigint,(el->>'quantidade')::numeric,(el->>'valor_unitario')::numeric,(el->>'desconto')::numeric
     FROM public.sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el WHERE so.id = %L
   EXCEPT ALL
   SELECT omie_codigo_produto, quantity, unit_price, discount FROM public.order_items WHERE sales_order_id = %L)
)"
coerente() { Pq -c "$(Pq -c "SELECT format(\$fmt\$$COERENTE_SQL\$fmt\$, '$1','$1','$1','$1')")"; }

# Payloads da edicao de P1: sai o produto 20, o 10 muda de qtd/preco, entra o 30.
# SKU 10 vem SEM product_id (é como o items-jsonb do pull chega ao front); SKU 30 vem COM, porque
# é item ACRESCENTADO pelo catálogo. Os dois caminhos são exercidos no mesmo payload.
ITENS_P1='[{"omie_codigo_produto":10,"product_id":null,"quantity":5,"unit_price":110,"discount":0,"omie_codigo_item":7001},
           {"omie_codigo_produto":30,"product_id":"bbbb0000-0000-0000-0000-000000000030","quantity":2,"unit_price":25,"discount":0,"omie_codigo_item":null}]'
ITEMS_P1='[{"omie_codigo_produto":10,"quantidade":5,"valor_unitario":110,"desconto":0,"valor_total":550},
           {"omie_codigo_produto":30,"quantidade":2,"valor_unitario":25,"desconto":0,"valor_total":50}]'
TOTAL_P1='600'
LIDO='2026-09-07T20:00:00Z'

rpc() { # $1 pedido | $2 itens | $3 items | $4 total | $5 lido_em | (opcional $6 = db)
  local db="${6:-prove}"
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 -tA -c \
    "SELECT public.aplicar_edicao_pedido_omie('$1'::uuid, '$3'::jsonb, '$2'::jsonb, $4::numeric,
        'obs nova', '{\"cabecalho\":1}'::jsonb, '{\"validated\":true}'::jsonb, '$5'::timestamptz);"
}

echo
echo "═══ ZONA 4 — ASSERTS ═══"

# ── A. REPRODUÇÃO DO DEFEITO: o escritor velho (só cabeçalho) deixa o agregado incoerente ──
echo "-- A. o escritor VELHO (update só do cabeçalho) --"
eq "A0 P1 nasce coerente" "$(coerente "$P1")" "t"
P -q -c "UPDATE public.sales_orders SET items='$ITEMS_P1'::jsonb, subtotal=$TOTAL_P1, total=$TOTAL_P1 WHERE id='$P1';"
eq "A1 update só-cabeçalho é ACEITO pelo banco (era o defeito)" \
   "$(Pq -c "SELECT total FROM public.sales_orders WHERE id='$P1'")" "600"
eq "A2 ...e o agregado fica INCOERENTE (linhas na revisão velha)" "$(coerente "$P1")" "f"
eq "A3 order_items segue com o conjunto VELHO — item não escrito vira VAZIO, não erro" \
   "$(Pq -c "SELECT string_agg(omie_codigo_produto||':'||quantity||':'||unit_price, '|' ORDER BY omie_codigo_produto) FROM public.order_items WHERE sales_order_id='$P1'")" \
   "10:2:100|20:1:50"
# restaura o estado pré-defeito para os asserts seguintes
P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":100,\"desconto\":0},{\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":50,\"desconto\":0}]'::jsonb, subtotal=250, total=250 WHERE id='$P1';"
eq "A4 estado restaurado (coerente de novo)" "$(coerente "$P1")" "t"

# ── B. CAMINHO FELIZ: pedido canônico COM linhas, editado no Omie ──
echo
echo "-- B. a RPC: pedido canônico com linhas, editado no Omie --"
RET="$(rpc "$P1" "$ITENS_P1" "$ITEMS_P1" "$TOTAL_P1" "$LIDO")"
eq "B1 retorno: tinha_linhas"     "$(printf '%s' "$RET" | "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA -c "SELECT ('$RET'::jsonb)->>'tinha_linhas'")" "true"
eq "B2 retorno: linhas_antes"     "$(Pq -c "SELECT ('$RET'::jsonb)->>'linhas_antes'")" "2"
eq "B3 retorno: linhas_removidas" "$(Pq -c "SELECT ('$RET'::jsonb)->>'linhas_removidas'")" "2"
eq "B4 retorno: linhas_inseridas" "$(Pq -c "SELECT ('$RET'::jsonb)->>'linhas_inseridas'")" "2"
eq "B5 order_items virou o conjunto NOVO (o que o defeito não fazia)" \
   "$(Pq -c "SELECT string_agg(omie_codigo_produto||':'||quantity||':'||unit_price, '|' ORDER BY omie_codigo_produto) FROM public.order_items WHERE sales_order_id='$P1'")" \
   "10:5:110|30:2:25"
eq "B6 agregado COERENTE pelo predicado da trigger" "$(coerente "$P1")" "t"
eq "B7 cabeçalho: total/subtotal" "$(Pq -c "SELECT total||'/'||subtotal FROM public.sales_orders WHERE id='$P1'")" "600/600"
eq "B8 cabeçalho: notes/omie_payload/omie_response gravados no MESMO write-back" \
   "$(Pq -c "SELECT notes||'|'||(omie_payload->>'cabecalho')||'|'||(omie_response->>'validated') FROM public.sales_orders WHERE id='$P1'")" \
   "obs nova|1|true"
eq "B9 recência preservada: created_at das linhas NOVAS = o das substituídas" \
   "$(Pq -c "SELECT count(DISTINCT created_at)||':'||to_char(min(created_at) AT TIME ZONE 'UTC','YYYY-MM-DD') FROM public.order_items WHERE sales_order_id='$P1'")" \
   "1:2026-01-15"
eq "B10 customer_user_id veio do PAI travado" \
   "$(Pq -c "SELECT count(*) FROM public.order_items WHERE sales_order_id='$P1' AND customer_user_id='$CLI'")" "2"
eq "B11 hash_payload da linha derivado do PAI (<hash>_<codigo>)" \
   "$(Pq -c "SELECT string_agg(hash_payload,'|' ORDER BY hash_payload) FROM public.order_items WHERE sales_order_id='$P1'")" \
   "omie_oben_777_10|omie_oben_777_30"
eq "B12 omie_codigo_item NOVO gravado; ausente vira NULL (nunca o código velho)" \
   "$(Pq -c "SELECT coalesce(omie_codigo_item::text,'NULL') FROM public.order_items WHERE sales_order_id='$P1' AND omie_codigo_produto=10")" "7001"
eq "B13 ...e o item sem identidade fica NULL, não 0" \
   "$(Pq -c "SELECT coalesce(omie_codigo_item::text,'NULL') FROM public.order_items WHERE sales_order_id='$P1' AND omie_codigo_produto=30")" "NULL"
eq "B14 omie_reconciliado_em carimbado com p_lido_em (fecha o pull atrasado)" \
   "$(Pq -c "SELECT to_char(omie_reconciliado_em AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI') FROM public.sales_orders WHERE id='$P1'")" \
   "2026-09-07 20:00"
eq "B15 product_id HERDADO por SKU quando o payload não sabe (o jsonb do pull não tem a chave)" \
   "$(Pq -c "SELECT coalesce(product_id::text,'NULL') FROM public.order_items WHERE sales_order_id='$P1' AND omie_codigo_produto=10")" \
   "$PROD10"
eq "B16 ...e o product_id do PAYLOAD vence no item acrescentado pelo catálogo" \
   "$(Pq -c "SELECT coalesce(product_id::text,'NULL') FROM public.order_items WHERE sales_order_id='$P1' AND omie_codigo_produto=30")" \
   "$PROD30"

# ── C. push do app (sem linhas) segue sem linhas ──
echo
echo "-- C. push do app: pedido SEM linhas continua sem linhas (isenção deliberada) --"
RETC="$(rpc "$P2" '[{"omie_codigo_produto":30,"quantity":4,"unit_price":7,"discount":0}]' \
                  '[{"omie_codigo_produto":30,"quantidade":4,"valor_unitario":7,"desconto":0}]' 28 "$LIDO")"
eq "C1 retorno diz que NÃO tinha linhas" "$(Pq -c "SELECT ('$RETC'::jsonb)->>'tinha_linhas'")" "false"
eq "C2 nenhuma linha foi criada (não muda QUAIS pedidos são canônicos)" \
   "$(Pq -c "SELECT count(*) FROM public.order_items WHERE sales_order_id='$P2'")" "0"
eq "C3 mas o cabeçalho foi gravado" "$(Pq -c "SELECT total FROM public.sales_orders WHERE id='$P2'")" "28"

# ── D. FAIL-CLOSED: cada recusa com a SQLSTATE ESPERADA, re-lançando o resto ──
echo
echo "-- D. fail-closed (SQLSTATE exata; WHEN OTHERS re-lança) --"
esperado() { # $1 rotulo | $2 sqlstate | $3 chamada (sem 'public.')
  local sql out rc
  sql="DO \$a\$ BEGIN PERFORM $3; RAISE EXCEPTION 'ASSERT_NAO_LANCOU'; EXCEPTION WHEN sqlstate '$2' THEN NULL; WHEN OTHERS THEN RAISE; END \$a\$;"
  set +e; out="$(P -q -c "$sql" 2>&1)"; rc=$?; set -e
  if [ "$rc" -eq 0 ]; then ok "$1 → SQLSTATE $2"; else bad "$1 — esperava SQLSTATE $2; veio: $(printf '%s' "$out" | head -2)"; fi
}
CH() { echo "public.aplicar_edicao_pedido_omie('$1'::uuid, '$3'::jsonb, '$2'::jsonb, $4, 'n', NULL, NULL, $5)"; }
IT_OK='[{"omie_codigo_produto":10,"quantity":1,"unit_price":10,"discount":0}]'
JS_OK='[{"omie_codigo_produto":10,"quantidade":1,"valor_unitario":10,"desconto":0}]'
LIDO_Q="'$LIDO'::timestamptz"

esperado "D1 p_items não-array"          22023 "$(CH "$P3" "$IT_OK" '{"a":1}' 10 "$LIDO_Q")"
esperado "D2 p_itens vazio"              22023 "$(CH "$P3" '[]' "$JS_OK" 10 "$LIDO_Q")"
esperado "D3 p_total ausente"            22023 "public.aplicar_edicao_pedido_omie('$P3'::uuid,'$JS_OK'::jsonb,'$IT_OK'::jsonb,NULL,'n',NULL,NULL,$LIDO_Q)"
esperado "D4 p_total negativo"           22023 "$(CH "$P3" "$IT_OK" "$JS_OK" "-1" "$LIDO_Q")"
esperado "D5 p_total NaN"                22023 "$(CH "$P3" "$IT_OK" "$JS_OK" "'NaN'::numeric" "$LIDO_Q")"
esperado "D6 item sem unit_price (ausente ≠ zero)" 22023 \
  "$(CH "$P3" '[{"omie_codigo_produto":10,"quantity":1,"discount":0}]' "$JS_OK" 10 "$LIDO_Q")"
esperado "D7 item com desconto ≠ 0 (fórmula do total sem decisão de produto)" 22023 \
  "$(CH "$P3" '[{"omie_codigo_produto":10,"quantity":1,"unit_price":10,"discount":5}]' "$JS_OK" 10 "$LIDO_Q")"
esperado "D8 total que NÃO bate com a soma dos itens" 22023 "$(CH "$P3" "$IT_OK" "$JS_OK" 999 "$LIDO_Q")"
esperado "D9 pedido inexistente"         P0002 "$(CH "$INEX" "$IT_OK" "$JS_OK" 10 "$LIDO_Q")"
esperado "D10 p_lido_em ausente"         22023 "$(CH "$P3" "$IT_OK" "$JS_OK" 10 "NULL")"
esperado "D11 p_lido_em no futuro"       22023 "$(CH "$P3" "$IT_OK" "$JS_OK" 10 "now()+interval '2 hours'")"
esperado "D12 espelhos DIVERGENTES (a postcondição da própria RPC)" 23514 \
  "$(CH "$P3" '[{"omie_codigo_produto":40,"quantity":3,"unit_price":10,"discount":0}]' \
              '[{"omie_codigo_produto":40,"quantidade":3,"valor_unitario":10}]' 30 "$LIDO_Q")"
esperado "D13 jsonb sem a chave desconto vs discount 0 (NULL ≠ 0)" 23514 \
  "$(CH "$P3" '[{"omie_codigo_produto":40,"quantity":3,"unit_price":10,"discount":0}]' \
              '[{"omie_codigo_produto":40,"quantidade":3,"valor_unitario":10,"desconto":null}]' 30 "$LIDO_Q")"

# compare-and-set: P1 já ficou com omie_reconciliado_em = LIDO
esperado "D14 leitura VELHA não sobrescreve revisão nova (compare-and-set)" 55000 \
  "$(CH "$P1" "$IT_OK" "$JS_OK" 10 "'2026-09-07T10:00:00Z'::timestamptz")"

# ── E. ATOMICIDADE: recusa não deixa META escrita ──
echo
echo "-- E. atomicidade: a recusa da postcondição não deixa nenhuma das metades gravada --"
eq "E0 P3 coerente antes"  "$(coerente "$P3")" "t"
eq "E1 P3 estado antes"    "$(Pq -c "SELECT count(*)||':'||max(unit_price) FROM public.order_items WHERE sales_order_id='$P3'")" "1:10"
set +e
P -q -c "SELECT public.aplicar_edicao_pedido_omie('$P3'::uuid,
   '[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":10}]'::jsonb,
   '[{\"omie_codigo_produto\":40,\"quantity\":3,\"unit_price\":10,\"discount\":0}]'::jsonb,
   30,'n',NULL,NULL,'$LIDO'::timestamptz);" >/dev/null 2>&1
set -e
eq "E2 linhas INTOCADAS após a recusa"    "$(Pq -c "SELECT count(*)||':'||max(unit_price) FROM public.order_items WHERE sales_order_id='$P3'")" "1:10"
eq "E3 cabeçalho INTOCADO após a recusa"  "$(Pq -c "SELECT coalesce(notes,'SEM')||':'||total FROM public.sales_orders WHERE id='$P3'")" "SEM:30"
eq "E4 P3 segue coerente"                 "$(coerente "$P3")" "t"

# ── F. INTERAÇÃO com a trigger irmã (PR #2363), se ela existir no repo ──
echo
echo "-- F. interação com a CONSTRAINT TRIGGER do agregado --"
if [ -n "$TRIG" ]; then
  P -q -f "$TRIG" >/dev/null
  set +e
  P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":99,\"quantidade\":1,\"valor_unitario\":1,\"desconto\":0}]'::jsonb WHERE id='$P3';" >/dev/null 2>&1
  RC_VELHO=$?
  set -e
  if [ "$RC_VELHO" -ne 0 ]; then ok "F1 com a trigger, o escritor VELHO (só cabeçalho) é RECUSADO"
  else bad "F1 escritor velho passou COM a trigger instalada"; fi
  RETF="$(rpc "$P3" '[{"omie_codigo_produto":40,"quantity":9,"unit_price":10,"discount":0}]' \
                    '[{"omie_codigo_produto":40,"quantidade":9,"valor_unitario":10,"desconto":0}]' 90 "$LIDO")"
  eq "F2 com a trigger, a RPC PASSA (escreve as duas metades)" "$(Pq -c "SELECT ('$RETF'::jsonb)->>'linhas_inseridas'")" "1"
  eq "F3 ...e o agregado fica coerente" "$(coerente "$P3")" "t"
else
  # A trigger é deliverable do PR #2363 e esta migration precisa ir ANTES dela: até aquele PR
  # mergear, o arquivo não existe aqui. Isso NÃO é um assert verde — é pendência DECLARADA, e o
  # marcador final do harness muda de nome para que nenhum grep confunda uma coisa com a outra.
  PEND=$((PEND+1))
  echo "  ⏳ F0 PENDENTE: migration da trigger irmã ausente do repo (chega com o #2363) — a interação NÃO foi verificada"
fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (cada assert tem dente?)
# Regra anti-teatro: CONTROLE VERDE na MESMA invocação antes de qualquer sabotagem.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ ZONA 5 — FALSIFICAÇÃO ═══"

montar() { # $1 = db, $2 = arquivo de migration
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists "$1"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$1"
  local Ps=("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$1" -v ON_ERROR_STOP=1)
  "${Ps[@]}" -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null 2>&1
  "${Ps[@]}" -q -c "$PREREQ_SQL" >/dev/null
  "${Ps[@]}" -f "$2" 2>&1
}

# --- G0 CONTROLE: a migration ÍNTEGRA aplica limpa e a RPC funciona neste db de sabotagem ---
CTRL_OUT="$(montar sab "$MIG")"; RC_CTRL=$?
if [ "$RC_CTRL" -eq 0 ] && printf '%s' "$CTRL_OUT" | grep -q 'POSTCOND-OK'; then
  seed sab
  RC_OK="$(rpc "$P1" "$ITENS_P1" "$ITEMS_P1" "$TOTAL_P1" "$LIDO" sab | head -c 20)"
  if [ -n "$RC_OK" ]; then ok "G0 CONTROLE VERDE: migration íntegra aplica e a RPC grava (a sabotagem abaixo vale)"
  else bad "G0 CONTROLE VERMELHO — a RPC não gravou no db de sabotagem"; fi
else
  bad "G0 CONTROLE VERMELHO (rc=$RC_CTRL) — nada abaixo prova coisa alguma"
fi

sabotar() { # $1 rotulo | $2 sed | $3 sqlstate que DEVE deixar de vir | $4 chamada
  local f out rc
  f="$(mktemp /tmp/mig-sab-XXXXXX.sql)"
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "$1 — o sed NÃO alterou nada (sabotagem inócua = teatro)"; rm -f "$f"; return; fi
  montar sab "$f" >/dev/null 2>&1
  seed sab
  set +e
  out="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d sab -v ON_ERROR_STOP=1 -q -c \
    "DO \$a\$ BEGIN PERFORM $4; RAISE EXCEPTION 'ASSERT_NAO_LANCOU'; EXCEPTION WHEN sqlstate '$3' THEN NULL; WHEN OTHERS THEN RAISE; END \$a\$;" 2>&1)"
  rc=$?
  set -e
  rm -f "$f"
  if [ "$rc" -ne 0 ]; then ok "$1 — sabotado, a recusa SUMIU (o assert tinha dente)"
  else bad "$1 — sabotado e a recusa CONTINUOU: o assert media outra coisa"; fi
}

CH_SAB_DIV="public.aplicar_edicao_pedido_omie('$P3'::uuid,'[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":10}]'::jsonb,'[{\"omie_codigo_produto\":40,\"quantity\":3,\"unit_price\":10,\"discount\":0}]'::jsonb,30,'n',NULL,NULL,'$LIDO'::timestamptz)"
sabotar "G1 postcondição de coerência (D12/E)" 's/IF v_divergiu THEN/IF false THEN/' 23514 "$CH_SAB_DIV"

CH_SAB_CAS="public.aplicar_edicao_pedido_omie('$P1'::uuid,'[{\"omie_codigo_produto\":10,\"quantidade\":2,\"valor_unitario\":100,\"desconto\":0},{\"omie_codigo_produto\":20,\"quantidade\":1,\"valor_unitario\":50,\"desconto\":0}]'::jsonb,'[{\"omie_codigo_produto\":10,\"quantity\":2,\"unit_price\":100,\"discount\":0},{\"omie_codigo_produto\":20,\"quantity\":1,\"unit_price\":50,\"discount\":0}]'::jsonb,250,'n',NULL,NULL,'2000-01-01T00:00:00Z'::timestamptz)"
sabotar "G2 compare-and-set de revisão (D14)" 's/IF v_lido_atual IS NOT NULL AND p_lido_em < v_lido_atual THEN/IF false THEN/' 55000 "$CH_SAB_CAS"

# G-pid: sem a herança, o product_id do item preexistente vira NULL — a FK de custo da margem
# some sem nenhum erro. O assert mede o VALOR, então a sabotagem tem de deixá-lo diferente.
FPID="$(mktemp /tmp/mig-sab-XXXXXX.sql)"
sed "s|(v_pid_por_sku->>(it->>'omie_codigo_produto'))::uuid|NULL::uuid|" "$MIG" > "$FPID"
if cmp -s "$FPID" "$MIG"; then bad "G6 sed inócuo (herança de product_id)"; else
  montar sab "$FPID" >/dev/null 2>&1
  seed sab
  rpc "$P1" "$ITENS_P1" "$ITEMS_P1" "$TOTAL_P1" "$LIDO" sab >/dev/null
  VPID="$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d sab -tA -c "SELECT coalesce(product_id::text,'NULL') FROM public.order_items WHERE sales_order_id='$P1' AND omie_codigo_produto=10")"
  if [ "$VPID" = "NULL" ]; then ok "G6 sem a herança, o product_id preexistente ZERA (o assert B15 tinha dente)"
  else bad "G6 sabotado e o product_id continuou [$VPID] — B15 media outra coisa"; fi
fi
rm -f "$FPID"

sabotar "G3 guard de desconto (D7)" "s/AND (it->>'discount')::numeric <> 0/AND false/" 22023 \
  "public.aplicar_edicao_pedido_omie('$P3'::uuid,'[{\"omie_codigo_produto\":40,\"quantidade\":3,\"valor_unitario\":10,\"desconto\":0}]'::jsonb,'[{\"omie_codigo_produto\":40,\"quantity\":3,\"unit_price\":10,\"discount\":5}]'::jsonb,30,'n',NULL,NULL,'$LIDO'::timestamptz)"

# --- G4/G5: sabotar a FRONTEIRA e exigir que o APPLY aborte na postcondição ---
# O sed tem de manter o SQL VÁLIDO: comentar só a 1ª linha de um GRANT/REVOKE de 2 linhas deixa
# um `TO service_role;` órfão, e o apply aborta por SINTAXE — vermelho pelo motivo errado, que é
# a forma mais fácil de uma falsificação virar teatro. Por isso troca-se a ROLE, não a linha.
apply_sabotado() { # $1 rotulo | $2 sed | $3 marcador que o erro DEVE conter
  local f out rc
  f="$(mktemp /tmp/mig-sab-XXXXXX.sql)"
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "$1 — o sed NÃO alterou nada (sabotagem inócua = teatro)"; rm -f "$f"; return; fi
  set +e; out="$(montar sab "$f")"; rc=$?; set -e
  rm -f "$f"
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q "$3"; then
    ok "$1 — o APPLY ABORTA na postcondição (ela não é decoração)"
  else
    bad "$1 — apply terminou rc=$rc sem [$3]: $(printf '%s' "$out" | grep -i 'error' | head -1)"
  fi
}
apply_sabotado "G4 GRANT para a role errada (service_role fica sem EXECUTE)" \
  's|TO service_role;|TO postgres;|' 'service_role nao executa'
apply_sabotado "G5 REVOKE que não tira PUBLIC (a função fica aberta)" \
  's|FROM PUBLIC, anon, authenticated;|FROM postgres;|' 'executavel por PUBLIC'

echo
echo "=== TOTAL: $PASS ok, $FAIL falhas, $PEND pendentes ==="
[ "$FAIL" -eq 0 ] || exit 1
# O marcador NOMEIA o que foi provado. Com a trigger irmã ausente ele é OUTRA string: um grep
# pelo marcador completo não casa, então "verde parcial" nunca se disfarça de verde inteiro.
if [ "$PEND" -eq 0 ]; then
  echo "PROVA-PEDIDO-EDICAO-ATOMICA-OK"
else
  echo "PROVA-PEDIDO-EDICAO-ATOMICA-OK-SEM-TRIGGER-IRMA ($PEND pendencia(s))"
fi

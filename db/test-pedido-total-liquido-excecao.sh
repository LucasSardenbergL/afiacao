#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — a exclusão NOMINAL do total líquido: os DOIS applies, EXECUTADOS              ║
# ║   bash db/test-pedido-total-liquido-excecao.sh               > "$LOG" 2>&1                 ║
# ║   bash db/test-pedido-total-liquido-excecao.sh --falsificar  > "$LOG" 2>&1                 ║
# ╚════════════════════════════════════════════════════════════════════════════════════════════╝
# POR QUE ESTE HARNESS EXISTE (e não bastava o ensaio em produção):
# o apply 2 (a conversão) NÃO PODE ser ensaiado em prod — `db:aplicar --ensaio` faz ROLLBACK, então
# no ensaio a tabela de exceção nem existe e o pré-voo do apply 2 recusa (corretamente). A única
# forma de ver o par inteiro rodar antes de valer dinheiro é aqui: PG17 local, migrations reais,
# os dois .sql EXECUTADOS na ordem. PL/pgSQL é late-bound — CREATE passa, o erro mora no runtime.
#
# O que este harness afirma, e o outro não podia:
#   · o pré-voo do apply 2 RECUSA sem o apply 1 (prova negativa, dentro do mesmo cluster);
#   · a substituição programática (pg_get_functiondef + replace ancorado) produz corpo que EXECUTA;
#   · a guarda de 48h mantém o pedido EM VOO fora da lista — e o mês dele continua BLOQUEADO
#     (fail-closed custa: é o lado certo de errar, e aqui o custo é VISÍVEL, não suposto);
#   · o apply 2 converte só o mês destravado, e nenhum excluído recebe número (`ausente ≠ zero`);
#   · reaplicar o apply 1 é idempotente; reaplicar o apply 2 FALHA em vez de escrever de novo.
#
# `--falsificar` sabota cópias em $TMPD (NUNCA os .sql de db/) e exige VERMELHO em cada item, com o
# CONTROLE verde na MESMA invocação — sempre-vermelha aprova tudo, e aí a suíte não teria dente.
set -euo pipefail

MODO="normal"
case "${1:-}" in
  "") ;;
  --falsificar) MODO="falsificar" ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5489}"
SLUG="pedido-total-liquido-excecao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/prova-${SLUG}.XXXXXX")"
# shellcheck disable=SC2329  # `cleanup` é invocada indiretamente, pelo `trap` (o shellcheck não vê).
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")" "$TMPD"
}
trap cleanup EXIT

MIG1="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_acervo.sql" | sort | tail -1)"
MIG2="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_acervo_mes_entre_contas.sql" | sort | tail -1)"
COER="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_venda_coerencia_agregado.sql" | sort | tail -1)"
DBF="$REPO_ROOT/db/aplicar-pedido-total-liquido-rpc.sql"
A1_SRC="$REPO_ROOT/db/2026-10-05-pedido-total-liquido-excecao.sql"
A2_SRC="$REPO_ROOT/db/2026-10-05-pedido-total-liquido-converter-acervo.sql"
for f in "$MIG1" "$MIG2" "$COER" "$DBF" "$A1_SRC" "$A2_SRC"; do
  if [ -z "$f" ] || [ ! -f "$f" ]; then
    echo "FALTA ARQUIVO [$f] — o harness testaria o NADA"; exit 1
  fi
done

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 [$2]"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# `vermelho` é o assert do modo --falsificar: passa quando a sabotagem QUEBRA algo.
vermelho() { if [ "$2" != "ok" ]; then ok "$1 (sabotagem pegou: $2)"; else bad "$1 — a sabotagem ficou VERDE: o assert não tem dente"; fi; }

SCHEMA="$TMPD/schema.sql"
cat > "$SCHEMA" <<'SQL'
ALTER ROLE service_role BYPASSRLS;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho',
  omie_pedido_id bigint, account text NOT NULL DEFAULT 'oben', hash_payload text,
  order_date_kpi date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- `desconto_valor` como em prod: numeric, NULLABLE, SEM DEFAULT — um DEFAULT 0 faria todo
-- "não apurado" passar por acidente do stub, e era justo o eixo desta prova.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric,
  created_at timestamptz DEFAULT now());
CREATE INDEX idx_order_items_sales_order ON public.order_items (sales_order_id);
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
SQL

# ── As fixtures. Dois meses, e o eixo de cada pedido no comentário ───────────────────────────
FIXT="$TMPD/fixtures.sql"
cat > "$FIXT" <<'SQL'
CREATE OR REPLACE FUNCTION public.t_pedido(
  p_id uuid, p_conta text, p_dia date, p_total numeric, p_linhas jsonb,
  p_atualizado timestamptz DEFAULT '2026-09-01 12:00:00+00')
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, discount, total,
                                   status, omie_pedido_id, account, hash_payload, order_date_kpi,
                                   created_at, updated_at)
  VALUES (p_id, '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'omie_codigo_produto', (l->>'sku')::bigint, 'quantidade', (l->>'q')::numeric,
                    'valor_unitario', (l->>'p')::numeric, 'desconto', 0)), '[]'::jsonb)
             FROM jsonb_array_elements(p_linhas) l),
          p_total, 0, p_total, 'importado', abs(hashtext(p_id::text))::bigint,
          p_conta, 'omie_' || p_conta || '_' || p_id::text, p_dia, p_atualizado, p_atualizado);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto,
                                  quantity, unit_price, discount, desconto_valor)
  SELECT p_id, '11111111-1111-1111-1111-111111111111', (l->>'sku')::bigint, (l->>'q')::numeric,
         (l->>'p')::numeric, 0, (l->>'d')::numeric   -- sem "d" na linha => desconto_valor NULL
    FROM jsonb_array_elements(p_linhas) l;
$f$;

-- JULHO/2026 — destrava pela exclusão: 1 convertível + 2 bloqueadores PARADOS
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d1', 'oben', '2026-07-05', 100,
  '[{"sku":1001,"q":1,"p":100,"d":10}]');                      -- convertível: líquido 90
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d2', 'oben', '2026-07-06', 50,
  '[{"sku":1002,"q":1,"p":50}]');                              -- sem_apuracao (toda linha NULL)
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d3', 'oben', '2026-07-07', 100,
  '[{"sku":1003,"q":1,"p":40,"d":4},{"sku":1004,"q":1,"p":60}]'); -- apuracao_parcial

-- JUNHO/2026 — NÃO destrava: o bloqueador está EM VOO (a guarda de 48h o deixa fora da lista)
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d4', 'oben', '2026-06-05', 200,
  '[{"sku":2001,"q":1,"p":200,"d":20}]');                      -- convertível, mas o mês fica preso
SELECT public.t_pedido('00000000-0000-0000-0000-00000000c0d5', 'oben', '2026-06-06', 30,
  '[{"sku":2002,"q":1,"p":30}]', now() - interval '1 hour');   -- EM VOO: churn de reprocesso
SQL

# ── sobe o banco do zero (usado 2×: controle e sabotagem) ────────────────────────────────────
semear() {
  "$PGBIN/dropdb"   -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q -f "$SCHEMA"
  P -q -f "$COER"
  P -q -f "$MIG1"
  P -q -f "$MIG2"
  P -q -1 -f "$DBF"
  P -q -f "$FIXT"
}
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

# Roda um apply como o envelope roda: UMA transação (-1) e marcador positivo de fim.
# Ecoa "ok" ou a 1ª linha de ERROR — o veredito é o marcador no banco+saída, nunca só o rc.
aplicar() {
  local sql="$1" out="$TMPD/apply.out" rc=0
  P -1 -f "$sql" > "$out" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ] && grep -q 'FIM_APLICACAO_OK' "$out"; then echo "ok"; return 0; fi
  local err; err="$(grep -m1 -o 'ERROR:.*' "$out" || true)"
  if [ -n "$err" ]; then printf '%s\n' "$err" | cut -c1-150
  else echo "rc=$rc sem ERROR e sem marcador — o apply saiu 0 calado"; fi
  return 1
}
# O sensor do cupom: a query que mede o que o CLIENTE vê (pedidos cujo cabeçalho segue bruto).
sensor() {
  Pq -c "SELECT count(*) FROM (SELECT oi.sales_order_id, sum(oi.quantity*oi.unit_price) bruto,
                                      sum(oi.desconto_valor) desc_
                                 FROM public.order_items oi GROUP BY 1
                                HAVING count(*) FILTER (WHERE oi.desconto_valor > 0) > 0) l
           JOIN public.sales_orders so ON so.id = l.sales_order_id
          WHERE round(l.bruto - l.desc_, 2) <> round(so.total, 2);"
}
elegiveis() {
  Pq -c "SELECT (public.pedido_total_liquido_converter(false, '2026-09-14 20:09:13+00', NULL,
                   '2025-09-01', '2026-10-01')->>'elegiveis')::int;"
}
total_de() { Pq -c "SELECT round(total,2)::text FROM public.sales_orders WHERE id = '$1';"; }

semear
echo "=== setup pronto (PG17 :$PORT) ==="

suite_normal() {
  echo "── A prova negativa: o apply 2 sem o apply 1 ──"
  local r; r="$(aplicar "$A2" || true)"
  if [ "$r" = "ok" ]; then bad "A1 pré-voo do apply 2 DEIXOU passar sem a tabela de exceção"
  else ok "A1 pré-voo do apply 2 recusa sem o apply 1 ($(printf '%s' "$r" | cut -c1-72)…)"; fi

  echo "── O estado ANTES: o gate prende os dois meses ──"
  eq "A2 elegíveis antes do apply 1" "$(elegiveis)" "0"
  eq "A3 sensor do cupom antes" "$(sensor)" "3"

  echo "── Apply 1: instala a exceção e patcheia o conversor ──"
  eq "A4 apply 1 roda inteiro" "$(aplicar "$A1" || true)" "ok"
  eq "A5 RLS ligada na tabela de exceção" \
     "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.pedido_total_liquido_excecao'::regclass;")" "t"
  eq "A6 a lista tem exatamente os 2 bloqueadores PARADOS" \
     "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao;")" "2"
  eq "A7 a guarda de 48h deixou o pedido EM VOO FORA da lista" \
     "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao
                WHERE sales_order_id='00000000-0000-0000-0000-00000000c0d5';")" "0"
  eq "A8 motivos classificados por medição local" \
     "$(Pq -c "SELECT string_agg(motivo, ',' ORDER BY motivo) FROM public.pedido_total_liquido_excecao;")" \
     "apuracao_parcial,sem_apuracao"
  eq "A9 o corpo vivo passou a ler a tabela (patch pegou, 1×)" \
     "$(Pq -c "SELECT (length(d)-length(replace(d,'pedido_total_liquido_excecao x',''))) /
                      length('pedido_total_liquido_excecao x')
                 FROM pg_get_functiondef('public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)'::regprocedure) d;")" "1"

  echo "── Idempotência: reaplicar o apply 1 não duplica nada ──"
  eq "A10 apply 1 de novo roda" "$(aplicar "$A1" || true)" "ok"
  eq "A11 a lista segue com 2" "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao;")" "2"

  echo "── O destravamento é NOMINAL: julho sai, junho fica ──"
  eq "A12 elegíveis depois do apply 1 (só o convertível de julho)" "$(elegiveis)" "1"

  echo "── Apply 2: a conversão ──"
  eq "A13 apply 2 roda inteiro" "$(aplicar "$A2" || true)" "ok"
  eq "A14 p1 convertido para o líquido" "$(total_de '00000000-0000-0000-0000-00000000c0d1')" "90.00"
  eq "A15 p4 intacto — junho segue preso pelo pedido em voo" \
     "$(total_de '00000000-0000-0000-0000-00000000c0d4')" "200.00"
  eq "A16 p2 excluído segue com cabeçalho BRUTO (ausente != zero)" \
     "$(total_de '00000000-0000-0000-0000-00000000c0d2')" "50.00"
  eq "A17 p3 excluído segue com cabeçalho BRUTO" \
     "$(total_de '00000000-0000-0000-0000-00000000c0d3')" "100.00"
  eq "A18 p5 em voo intocado" "$(total_de '00000000-0000-0000-0000-00000000c0d5')" "30.00"
  eq "A19 o sensor do cupom caiu exatamente 1" "$(sensor)" "2"

  echo "── Reaplicar o apply 2 FALHA em vez de escrever de novo ──"
  local r2; r2="$(aplicar "$A2" || true)"
  if [ "$r2" = "ok" ]; then bad "A20 apply 2 rodou DUAS vezes e não reclamou — dupla escrita silenciosa"
  else ok "A20 apply 2 recusa a 2ª passada ($(printf '%s' "$r2" | cut -c1-60)…)"; fi
}

A1="$A1_SRC"; A2="$A2_SRC"

if [ "$MODO" = "normal" ]; then
  suite_normal
else
  echo "=== modo --falsificar: o CONTROLE primeiro, senão a suíte aprova tudo ==="
  CTRL_PASS=0; CTRL_FAIL=0
  suite_normal
  CTRL_PASS=$PASS; CTRL_FAIL=$FAIL
  echo "--- controle: $CTRL_PASS ok / $CTRL_FAIL fail ---"
  if [ "$CTRL_FAIL" -ne 0 ]; then
    echo "ABORTANDO antes da 1ª sabotagem: o controle já está VERMELHO ($CTRL_FAIL) — sabotar daqui"
    echo "prova nada, porque sempre-vermelha aprova qualquer sabotagem."
    exit 1
  fi
  PASS=0; FAIL=0; VERM=0

  # F1 — a guarda de 48h do passo 2, SOZINHA (o `p.` casa só a linha que popula a lista; a
  #      postcondição (c) usa `so.` e fica de pé). Sabotar as duas de uma vez não provaria nada.
  sed "s/p\.updated_at < now() - interval '48 hours'/p.updated_at < now() - interval '0 hours'/" \
    "$A1_SRC" > "$TMPD/f1.sql"
  cmp -s "$A1_SRC" "$TMPD/f1.sql" && { echo "F1 não sabotou nada (âncora morta)"; exit 1; }
  semear; A1="$TMPD/f1.sql"
  vermelho "F1 guarda de 48h removida" "$(aplicar "$A1" || true)"; VERM=$((VERM+1))

  # F2 — a âncora do patch: se ela não casa exatamente 1×, o apply tem de ABORTAR, não adivinhar.
  sed "s/WITH c AS MATERIALIZED (/WITH c AS MATERIALIZED ( -- bagunçado/" "$A1_SRC" > "$TMPD/f2.sql"
  cmp -s "$A1_SRC" "$TMPD/f2.sql" && { echo "F2 não sabotou nada (âncora morta)"; exit 1; }
  semear; A1="$TMPD/f2.sql"
  vermelho "F2 âncora 2 adulterada" "$(aplicar "$A1" || true)"; VERM=$((VERM+1))

  # F3 — o filtro do patch: se o NOT EXISTS não exclui ninguém, (f) tem de pegar o gate ainda fechado.
  sed "s/WHERE x.sales_order_id = z.sales_order_id/WHERE x.sales_order_id = z.sales_order_id AND false/" \
    "$A1_SRC" > "$TMPD/f3.sql"
  cmp -s "$A1_SRC" "$TMPD/f3.sql" && { echo "F3 não sabotou nada (âncora morta)"; exit 1; }
  semear; A1="$TMPD/f3.sql"
  vermelho "F3 filtro da exceção neutralizado" "$(aplicar "$A1" || true)"; VERM=$((VERM+1))

  # F4 — o pré-voo do apply 2: sem ele, a postcondição `escritos > 0` é o segundo cinto.
  sed "s/to_regclass('public.pedido_total_liquido_excecao') IS NULL/false/" "$A2_SRC" > "$TMPD/f4.sql"
  cmp -s "$A2_SRC" "$TMPD/f4.sql" && { echo "F4 não sabotou nada (âncora morta)"; exit 1; }
  semear; A1="$A1_SRC"; A2="$TMPD/f4.sql"
  vermelho "F4 pré-voo do apply 2 cego, sem o apply 1" "$(aplicar "$A2" || true)"; VERM=$((VERM+1))

  # F5 — guarda E verificador fora: o apply PASSA e o pedido em voo entra na lista. Isto não é
  #      teste de dente, é a medição do que as duas camadas juntas compram: sem elas, um pedido
  #      recuperável é excluído para sempre, em silêncio, e nada no apply reclama.
  sed -e "s/p\.updated_at < now() - interval '48 hours'/p.updated_at < now() - interval '0 hours'/" \
      -e "s/so\.updated_at >= now() - interval '48 hours'/so.updated_at >= now() + interval '1 hour'/" \
      "$A1_SRC" > "$TMPD/f5.sql"
  semear; A1="$TMPD/f5.sql"; A2="$A2_SRC"
  if [ "$(aplicar "$A1" || true)" = "ok" ]; then
    eq "F5 sem as DUAS camadas o pedido EM VOO é excluído em silêncio" \
       "$(Pq -c "SELECT count(*) FROM public.pedido_total_liquido_excecao
                  WHERE sales_order_id='00000000-0000-0000-0000-00000000c0d5';")" "1"
  else
    bad "F5 o apply abortou — então alguma TERCEIRA camada pega, e eu não sei qual"
  fi
  VERM=$((VERM+1))

  echo "SABOTAGENS: $PASS vermelhas / $FAIL falhas (de $VERM)"
fi

echo "═══ $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ] && echo "FIM_PROVA_OK"
exit $(( FAIL > 0 ? 1 : 0 ))

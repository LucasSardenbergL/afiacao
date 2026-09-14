#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — pedido_total_liquido_acervo: o cabeçalho do acervo de BRUTO a LÍQUIDO        ║
# ║ Rode:  bash db/test-pedido-total-liquido-acervo.sh               > "$LOG" 2>&1            ║
# ║        bash db/test-pedido-total-liquido-acervo.sh --falsificar  > "$LOG" 2>&1            ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTA PROVA EXISTE PARA PEGAR. O modo normal afirma o comportamento; o `--falsificar`
# sabota a migration (num espelho em tmpdir, nunca em supabase/migrations/) e exige VERMELHO em
# cada item, com o verde de volta depois de restaurar — e só começa depois de uma linha de base
# VERDE na MESMA invocação:
#   · converter o que as linhas não provam: desconto não apurado, linha inválida, líquido negativo,
#     cabeçalho fora do padrão, total que já é o líquido ou que diverge dos dois;
#   · converter cabeçalho reescrito DEPOIS do corte — desconto vencido (achado da 2ª opinião);
#   · arredondar por linha em vez de uma vez no fim; perder a tolerância do float legado;
#   · converter meio mês (mês com apuração incompleta); truncar em vez de recusar acima do limite;
#   · o ensaio escrever;
#   · esperar o lock de um escritor (deadlock) em vez de pular; sobrescrever um total que mudou
#     entre a escolha do lote e o lock;
#   · um pedido incoerente derrubar o lote inteiro no COMMIT (23514 da trigger deferida);
#   · a postcondição do conversor e a da migration sem dente;
#   · o gêmeo do `db:aplicar` divergir da migration.
#
# Recibos para db/roda-nucleo-ci.sh: o normal fecha com `RESULTADO: <n> ok / <m> fail`; o
# `--falsificar` com `SABOTAGENS: <v> vermelhas / <f> falhas` — e nunca um no lugar do outro.
#
# Os vereditos não dependem de locale: o shell compara bytes exatos, e toda recusa é conferida
# pela SQLSTATE, no banco. O JSON devolvido pelo conversor também é lido no banco, não por jq.
set -euo pipefail

MODO="normal"
case "${1:-}" in
  "") ;;
  --falsificar) MODO="falsificar" ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5487}"
SLUG="pedido-total-liquido-acervo"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/prova-${SLUG}.XXXXXX")"
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$(dirname "$DATA")" "$TMPD"
}
trap cleanup EXIT

# `find | sort | tail`: a migration mais RECENTE com o slug é a que vale (SC2012 barra `ls`).
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_total_liquido_acervo.sql" | sort | tail -1)"
COER="$(find "$REPO_ROOT/supabase/migrations" -name "*_pedido_venda_coerencia_agregado.sql" | sort | tail -1)"
DBF="$REPO_ROOT/db/aplicar-pedido-total-liquido-rpc.sql"
if [ -z "$MIG" ] || [ -z "$COER" ] || [ ! -f "$DBF" ]; then
  echo "migration, coerência ou gêmeo não encontrados — o harness testaria o NADA"; exit 1
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# Passa quando o valor DIFERE do verde (usado no normal só pelo P3, a sabotagem do gêmeo).
vermelho() { if [ "$2" != "$3" ]; then ok "$1 (sabotado: [$2] ≠ verde [$3])"; else bad "$1 — a sabotagem ficou VERDE [$2]: o assert não tem dente"; fi; }

# ── ZONA 1 — pré-requisitos de schema (compartilhados com o banco do gêmeo, §P) ──────────────
SCHEMA="$TMPD/schema.sql"
cat > "$SCHEMA" <<'SQL'
ALTER ROLE service_role BYPASSRLS;
-- Os default privileges de PRODUÇÃO (pg_default_acl, medido 2026-09-14): objeto novo em public
-- nasce com tudo para anon/authenticated/service_role. Sem isto os REVOKE da migration seriam
-- no-op aqui, e a sabotagem de ACL (F13) não teria o que pegar.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

-- As colunas que a passada lê ou escreve, com os tipos de prod (information_schema, 2026-09-14).
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho',
  omie_pedido_id bigint, account text NOT NULL DEFAULT 'oben', hash_payload text,
  order_date_kpi date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
-- `desconto_valor` como em prod: numeric, NULLABLE, SEM DEFAULT — um DEFAULT 0 aqui faria todo
-- "não apurado" passar por acidente do stub.
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
-- A trigger de prod que carimba updated_at em todo UPDATE — é ela que torna o CORTE observável.
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END $f$;
CREATE TRIGGER update_sales_orders_updated_at BEFORE UPDATE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
SQL

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q -f "$SCHEMA"

# ── ZONA 2 — as migrations REAIS (Lei #1): a coerência de prod e a passada ────────────────────
P -q -f "$COER"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$COER") · $(basename "$MIG") · modo $MODO"

# ── ZONA 3 — seeds e helpers ──────────────────────────────────────────────────────────────────
P -q <<'SQL'
CREATE TABLE public.t_barreira  (sinal text PRIMARY KEY);
CREATE TABLE public.t_resultado (nome text PRIMARY KEY, r jsonb);

-- Um pedido Omie como a ingestão grava: items(jsonb) coerente com as linhas, subtotal = total.
-- Linha: {"sku", "q", "p", "d"} — "p" null = preço ausente; "d" ausente = desconto NÃO apurado.
CREATE OR REPLACE FUNCTION public.t_pedido(
  p_id uuid, p_conta text, p_dia date, p_total numeric, p_linhas jsonb,
  p_atualizado timestamptz DEFAULT '2026-09-01 12:00:00+00',
  p_omie boolean DEFAULT true, p_discount numeric DEFAULT 0, p_items jsonb DEFAULT NULL)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, discount, total, status,
                                   omie_pedido_id, account, hash_payload, order_date_kpi, created_at, updated_at)
  VALUES (p_id, '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
          coalesce(p_items, (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'omie_codigo_produto', (l->>'sku')::bigint, 'quantidade', (l->>'q')::numeric,
                     'valor_unitario', (l->>'p')::numeric, 'desconto', 0)), '[]'::jsonb)
                               FROM jsonb_array_elements(p_linhas) l)),
          p_total, p_discount, p_total, 'importado',
          CASE WHEN p_omie THEN abs(hashtext(p_id::text))::bigint END,
          p_conta, CASE WHEN p_omie THEN 'omie_' || p_conta || '_' || p_id::text END,
          p_dia, p_atualizado, p_atualizado);
  INSERT INTO public.order_items (sales_order_id, customer_user_id, omie_codigo_produto, quantity, unit_price, discount, desconto_valor)
  SELECT p_id, '11111111-1111-1111-1111-111111111111', (l->>'sku')::bigint, (l->>'q')::numeric,
         (l->>'p')::numeric, 0, (l->>'d')::numeric
    FROM jsonb_array_elements(p_linhas) l;
$f$;

CREATE OR REPLACE FUNCTION public.t_seed() RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  TRUNCATE public.order_items, public.sales_orders, public.pedido_total_liquido_conversoes RESTART IDENTITY;
  TRUNCATE public.t_resultado, public.t_barreira;
  -- oben/2026-07 — mês COMPLETO
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a1', 'oben', '2026-07-05', 1629.25,  -- o pedido real 12183048572
    '[{"sku":1001,"q":1,"p":460.25,"d":23.01},{"sku":1002,"q":2,"p":584.50,"d":116.90}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a2', 'oben', '2026-07-06', 100.00,   -- float legado, sem desconto
    '[{"sku":1003,"q":3,"p":33.33,"d":0}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a3', 'oben', '2026-07-07', 180,      -- já líquido
    '[{"sku":1004,"q":1,"p":200,"d":20}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a4', 'oben', '2026-07-08', 50,       -- ambíguo: desconto de 1 centavo
    '[{"sku":1005,"q":1,"p":50,"d":0.01}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a5', 'oben', '2026-07-09', 95,       -- nem bruto nem líquido
    '[{"sku":1006,"q":1,"p":100,"d":10}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a6', 'oben', '2026-07-10', 100,      -- discount no cabeçalho
    '[{"sku":1007,"q":1,"p":100,"d":10}]', p_discount => 5);
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a8', 'oben', '2026-07-11', 10.01,    -- 9,01 no fim × 9,02 por linha
    '[{"sku":1008,"q":0.5,"p":10.01,"d":0.50},{"sku":1009,"q":0.5,"p":10.01,"d":0.50}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000a9', 'oben', '2026-07-12', 99.99,    -- bruto a 1 centavo (float)
    '[{"sku":1010,"q":1,"p":100,"d":5}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-000000000a10', 'oben', '2026-07-13', 300,      -- cabeçalho reescrito DEPOIS do corte
    '[{"sku":1011,"q":1,"p":300,"d":30}]', p_atualizado => '2026-09-12 00:00:00+00');
  PERFORM public.t_pedido('00000000-0000-0000-0000-000000000a12', 'oben', '2026-07-14', 0, '[]');  -- pai sem linha
  PERFORM public.t_pedido('00000000-0000-0000-0000-000000000a13', 'oben', '2026-07-15', 100,      -- pedido do APP (sem omie_pedido_id)
    '[{"sku":1012,"q":1,"p":100,"d":10}]', p_omie => false);
  PERFORM public.t_pedido('00000000-0000-0000-0000-000000000a14', 'oben', '2026-07-16', 80,
    '[{"sku":1013,"q":1,"p":80,"d":8}]');
  -- oben/2026-06 — INCOMPLETO: b2 tem linha não apurada
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000b1', 'oben', '2026-06-05', 100,
    '[{"sku":2001,"q":1,"p":100,"d":10}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000b2', 'oben', '2026-06-06', 150,
    '[{"sku":2002,"q":1,"p":100,"d":10},{"sku":2003,"q":1,"p":50}]');
  -- colacor/2026-07
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000c1', 'colacor', '2026-07-05', 450,
    '[{"sku":3001,"q":1,"p":450,"d":13.5}]');
  -- oben/2026-05 — INCOMPLETO: linhas inválidas
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000d1', 'oben', '2026-05-05', 0.01,     -- líquido −0,01 no numeric
    '[{"sku":4001,"q":0.5,"p":0.01,"d":0.01}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000d2', 'oben', '2026-05-06', 0,        -- preço ausente
    '[{"sku":4002,"q":1,"p":null,"d":0}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000d3', 'oben', '2026-05-07', 100,      -- desconto NaN
    '[{"sku":4003,"q":1,"p":100,"d":"NaN"}]');
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000d4', 'oben', '2026-05-08', 60,
    '[{"sku":4004,"q":1,"p":60,"d":6}]');
  -- oben/2026-04 — e2 coerente; e1 (incoerente) entra fora desta transação, em semear()
  PERFORM public.t_pedido('00000000-0000-0000-0000-0000000000e2', 'oben', '2026-04-06', 40,
    '[{"sku":5002,"q":1,"p":40,"d":4}]');
END $f$;

-- SQLSTATE do comando, ou OK. Os eventos de trigger DEFERIDA disparam aqui dentro (SET CONSTRAINTS
-- ALL IMMEDIATE), senão o 23514 da coerência só apareceria no COMMIT, fora do handler. Não é o
-- `WHEN OTHERS THEN 'OK'` do teatro: o assert compara a SQLSTATE devolvida com a ESPERADA, e
-- qualquer outra reprova.
CREATE OR REPLACE FUNCTION public.t_sqlstate(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  SET CONSTRAINTS ALL IMMEDIATE;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $f$;

CREATE OR REPLACE FUNCTION public.t_violacao(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_c text;
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_c = CONSTRAINT_NAME;
  RETURN SQLSTATE || ':' || coalesce(v_c, '');
END $f$;

-- Retrato de tudo que a passada pode tocar: cabeçalhos (inclusive updated_at) e o registro.
CREATE OR REPLACE FUNCTION public.t_foto() RETURNS text LANGUAGE sql AS $f$
  SELECT md5(
    coalesce((SELECT string_agg(concat_ws(':', s.id, s.total, s.subtotal, s.discount, s.updated_at, s.items), '|' ORDER BY s.id)
                FROM public.sales_orders s), '')
    || '#' ||
    coalesce((SELECT string_agg(concat_ws(':', c.lote, c.sales_order_id, c.total_antes, c.total_depois), '|' ORDER BY c.id)
                FROM public.pedido_total_liquido_conversoes c), ''))
$f$;
SQL

CORTE="2026-09-10 00:00:00+00"
id() { printf '00000000-0000-0000-0000-%12s' "$1" | tr ' ' '0'; }
A1="$(id a1)"; A2="$(id a2)"; A3="$(id a3)"; A4="$(id a4)"; A5="$(id a5)"; A6="$(id a6)"; A8="$(id a8)"
A9="$(id a9)"; A10="$(id a10)"; A12="$(id a12)"; A13="$(id a13)"; A14="$(id a14)"
B1="$(id b1)"; B2="$(id b2)"; C1="$(id c1)"; D1="$(id d1)"; D2="$(id d2)"; D3="$(id d3)"; D4="$(id d4)"
E1="$(id e1)"; E2="$(id e2)"

semear() {
  P -q -c "SELECT public.t_seed();" >/dev/null
  # e1: incoerente como um pedido LEGADO anterior à trigger — as duas triggers de coerência
  # desligadas só para esta escrita, e religadas ALWAYS como em prod.
  P -q >/dev/null <<SQL
ALTER TABLE public.sales_orders DISABLE TRIGGER trg_pedido_venda_coerencia_cab;
ALTER TABLE public.order_items  DISABLE TRIGGER trg_pedido_venda_coerencia_lin;
SELECT public.t_pedido('$E1', 'oben', '2026-04-05', 70, '[{"sku":5001,"q":1,"p":70,"d":7}]',
  p_items => '[{"omie_codigo_produto":5001,"quantidade":2,"valor_unitario":70,"desconto":0}]');
ALTER TABLE public.sales_orders ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_cab;
ALTER TABLE public.order_items  ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_lin;
SQL
}
classe()  { Pq -c "SELECT classe FROM public.pedido_total_liquido_classificar('$CORTE', ARRAY['$1'::uuid])"; }
tot()     { Pq -c "SELECT total FROM public.sales_orders WHERE id = '$1'"; }
aplicar() { Pq -c "SELECT public.pedido_total_liquido_converter(p_aplicar => true, p_corte => '$CORTE'${1:+, $1})"; }
ensaiar() { Pq -c "SELECT public.pedido_total_liquido_converter(p_aplicar => false, p_corte => '$CORTE'${1:+, $1})"; }
estado()  { Pq -c "SELECT public.t_sqlstate(\$q\$SELECT public.pedido_total_liquido_converter(p_aplicar => true, p_corte => '$CORTE'${1:+, $1})\$q\$)"; }
foto()    { Pq -c "SELECT public.t_foto()"; }
# Campos de topo do JSON, lidos NO BANCO. Chave ausente sai '<ausente>', nunca some da string.
campos() {
  local j="$1" sel="" k; shift
  for k in "$@"; do sel="${sel:+$sel || '|' || }coalesce(j->>'$k', '<ausente>')"; done
  Pq -c "SELECT $sel FROM (SELECT \$j\$$j\$j\$::jsonb AS j) x"
}

# ── concorrência: sessões reais em background, com teto em toda espera ───────────────────────
XPID=""
espera() {  # $1 = SQL que devolve t/f; $2 = tentativas de 50ms. Ecoa sim|nao — nunca espera para sempre.
  local r
  for _ in $(seq 1 "${2:-200}"); do
    r="$(Pq -c "$1")"
    if [ "$r" = "t" ]; then echo sim; return 0; fi
    sleep 0.05
  done
  echo nao
}
sessao_x() {  # $1 = SQL que TRAVA algo; $2 = sinal que a solta. Sobe em background e espera chegar ao laço.
  cat > "$TMPD/x.sql" <<SQL
BEGIN;
$1
DO \$x\$ BEGIN
  FOR i IN 1..600 LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM public.t_barreira WHERE sinal = '$2');
    PERFORM pg_sleep(0.05);
  END LOOP;
END \$x\$;
COMMIT;
SQL
  P -q -f "$TMPD/x.sql" >"$TMPD/x.out" 2>&1 &
  XPID=$!
  [ "$(espera "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event = 'PgSleep' AND query LIKE '%t_barreira%')")" = sim ]
}
liberar_x() { P -q -c "INSERT INTO public.t_barreira VALUES ('$1') ON CONFLICT DO NOTHING" >/dev/null; wait "$XPID" || true; }
BLOQUEADO_Q="SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%pedido_total_liquido_converter%')"

cenario_k1() {  # ecoa "<terminou|bloqueou|nao_terminou>|<pulados_em_uso>|<escritos>|<total a1>"
  local st="nao_terminou" mpid r
  semear
  sessao_x "SELECT 1 FROM public.sales_orders WHERE id = '$A1' FOR UPDATE;" k1 || { echo "sessao_x_nao_travou"; return 0; }
  P -q -c "INSERT INTO public.t_resultado SELECT 'k1', public.pedido_total_liquido_converter(p_aplicar => true, p_corte => '$CORTE')" >"$TMPD/m.out" 2>&1 &
  mpid=$!
  for _ in $(seq 1 600); do
    if ! kill -0 "$mpid" 2>/dev/null; then st="terminou"; break; fi
    if [ "$(Pq -c "$BLOQUEADO_Q")" = t ]; then st="bloqueou"; break; fi
    sleep 0.05
  done
  liberar_x k1
  wait "$mpid" || true
  r="$(Pq -c "SELECT coalesce(r->>'pulados_em_uso', '-') || '|' || coalesce(r->>'escritos', '-') FROM public.t_resultado WHERE nome = 'k1'")"
  echo "$st|${r:--|-}|$(tot "$A1")"
}

cenario_k2() {  # ecoa "<M esperou o lock: sim|nao>|<elegiveis>|<mudaram_sob_lock>|<escritos>|<total a1>"
  local visto mpid r
  semear
  # X segura order_items: o SELECT que escolhe o lote PEGA o snapshot e só então trava, ao ler as
  # linhas (a classificação é função SQL não-inlinável, analisada dentro da execução). X reescreve
  # o total de a1 e comita enquanto o conversor espera — o total muda ENTRE a escolha e o lock.
  sessao_x "LOCK TABLE public.order_items IN ACCESS EXCLUSIVE MODE; UPDATE public.sales_orders SET total = 1600, subtotal = 1600 WHERE id = '$A1';" k2 \
    || { echo "sessao_x_nao_travou"; return 0; }
  P -q -c "INSERT INTO public.t_resultado SELECT 'k2', public.pedido_total_liquido_converter(p_aplicar => true, p_corte => '$CORTE')" >"$TMPD/m.out" 2>&1 &
  mpid=$!
  visto="$(espera "$BLOQUEADO_Q")"
  liberar_x k2
  wait "$mpid" || true
  r="$(Pq -c "SELECT coalesce(r->>'elegiveis', '-') || '|' || coalesce(r->>'mudaram_sob_lock', '-') || '|' || coalesce(r->>'escritos', '-') FROM public.t_resultado WHERE nome = 'k2'")"
  echo "$visto|${r:--|-|-}|$(tot "$A1")"
}
K1_VERDE="terminou|1|5|1629.25"
K2_VERDE="sim|7|1|5|1600"

echo "═══ setup pronto (PG17 :$PORT) ═══"
semear

if [ "$MODO" = normal ]; then

P -q -f "$MIG"
ok "M1 a migration re-aplica sem erro (idempotente; a postcondição roda de novo sobre os seeds)"

echo "═══ C · classificação — a decisão, pedido a pedido ═══"
eq "C1 o pedido real com desconto e total bruto é convertível"          "$(classe "$A1")"  "convertivel"
eq "C2 total a 1 centavo do bruto e SEM desconto: não há o que converter" "$(classe "$A2")"  "sem_desconto"
eq "C3 total que já é o líquido"                                          "$(classe "$A3")"  "ja_liquido"
eq "C4 desconto de 1 centavo cabe nas duas tolerâncias: ambíguo"          "$(classe "$A4")"  "ambiguo"
eq "C5 total que não é bruto nem líquido"                                 "$(classe "$A5")"  "divergente"
eq "C6 discount no cabeçalho: fora do padrão da ingestão"                 "$(classe "$A6")"  "cabecalho_fora_do_padrao"
eq "C7 arredonda UMA vez no fim (9,01; por linha daria 9,02)"             "$(Pq -c "SELECT classe || '|' || liquido FROM public.pedido_total_liquido_classificar('$CORTE', ARRAY['$A8'::uuid])")" "convertivel|9.01"
eq "C8 bruto a 1 centavo (float legado) COM desconto é convertível"      "$(classe "$A9")"  "convertivel"
eq "C9 cabeçalho reescrito depois do corte: não se confia no desconto"   "$(classe "$A10")" "tocado_pos_corte"
eq "C10 controle do C9: sem corte, o mesmo pedido seria convertível"     "$(Pq -c "SELECT classe FROM public.pedido_total_liquido_classificar(NULL, ARRAY['$A10'::uuid])")" "convertivel"
eq "C11 pai Omie sem linha"                                               "$(classe "$A12")" "sem_linha"
eq "C12 pedido do app (sem omie_pedido_id) nem entra na classificação"    "$(classe "$A13")" ""
eq "C13 uma linha com desconto NÃO apurado"                               "$(classe "$B2")"  "nao_apurado"
eq "C14 líquido −0,01 (desconto de ½ centavo sobre base de ½ centavo)"   "$(classe "$D1")"  "linha_invalida"
eq "C15 preço ausente"                                                    "$(classe "$D2")"  "linha_invalida"
eq "C16 desconto NaN (NaN ≥ 0 é TRUE em numeric)"                         "$(classe "$D3")"  "linha_invalida"

echo "═══ REL · relatório por conta×mês, com denominador ═══"
REL="$(Pq -c "SELECT m FROM jsonb_array_elements((public.pedido_total_liquido_relatorio('$CORTE'))->'por_conta_mes') m WHERE m->>'conta' = 'oben' AND m->>'mes' = '2026-07'")"
eq "REL1 oben/2026-07: pedidos|líquido provado|sem desconto|convertível|Σ mudança|não apurado|outros|completo" \
   "$(campos "$REL" pedidos liquido_provado sem_desconto convertivel soma_mudanca_convertivel nao_apurado sem_prova_outros apuracao_completa)" \
   "11|1|1|4|-153.90|0|5|true"
REL="$(Pq -c "SELECT m FROM jsonb_array_elements((public.pedido_total_liquido_relatorio('$CORTE'))->'por_conta_mes') m WHERE m->>'conta' = 'oben' AND m->>'mes' = '2026-06'")"
eq "REL2 oben/2026-06 com linha não apurada: apuração incompleta" "$(campos "$REL" pedidos convertivel nao_apurado apuracao_completa)" "2|1|1|false"

echo "═══ E · ensaio — relatório do lote, sem escrever ═══"
F0="$(foto)"
J="$(ensaiar)"
eq "E1 elegíveis|incoerentes|Σ mudança prevista|excede o limite" "$(campos "$J" modo elegiveis incoerentes soma_mudanca_prevista excede_limite)" "ensaio|7|1|-178.40|false"
eq "E2 o ensaio não escreveu nada (cabeçalhos, updated_at e registro)" "$(foto)" "$F0"
eq "E3 meses bloqueados por apuração incompleta" \
   "$(Pq -c "SELECT string_agg((b->>'conta') || '/' || (b->>'mes'), ',' ORDER BY b->>'mes' DESC) FROM jsonb_array_elements((\$j\$$J\$j\$::jsonb)->'meses_bloqueados') b")" \
   "oben/2026-06,oben/2026-05"

echo "═══ A · aplicar — escopo inteiro, mês completo exigido ═══"
J="$(aplicar)"
eq "A1 escritos|incoerentes|em uso|mudaram sob lock|Σ mudança" "$(campos "$J" modo escritos incoerentes pulados_em_uso mudaram_sob_lock soma_mudanca)" "aplicado|6|1|0|0|-171.40"
eq "A2 o pedido real: total|subtotal|discount = 1489,34 (o líquido que o #2469 mediu)" "$(Pq -c "SELECT total || '|' || subtotal || '|' || discount FROM public.sales_orders WHERE id = '$A1'")" "1489.34|1489.34|0"
eq "A3 convertidos: a8|a9|a14|c1|e2" "$(tot "$A8")|$(tot "$A9")|$(tot "$A14")|$(tot "$C1")|$(tot "$E2")" "9.01|95.00|72.00|436.50|36.00"
eq "A4 intocados: a2 a3 a4 a5 a6 a10 a13" "$(tot "$A2")|$(tot "$A3")|$(tot "$A4")|$(tot "$A5")|$(tot "$A6")|$(tot "$A10")|$(tot "$A13")" "100.00|180|50|95|100|300|100"
eq "A5 intocados: b1 b2 (mês incompleto) d1..d4 (linha inválida) e1 (incoerente)" \
   "$(tot "$B1")|$(tot "$B2")|$(tot "$D1")|$(tot "$D2")|$(tot "$D3")|$(tot "$D4")|$(tot "$E1")" "100|150|0.01|0|100|60|70"
eq "A6 nenhum pedido fora do lote teve updated_at mexido" \
   "$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE id NOT IN ('$A1','$A8','$A9','$A14','$C1','$E2') AND updated_at NOT IN ('2026-09-01 12:00:00+00', '2026-09-12 00:00:00+00')")" "0"
eq "A7 registro: linhas|lotes|Σ (depois − antes)|corte gravado" \
   "$(Pq -c "SELECT count(*) || '|' || count(DISTINCT lote) || '|' || sum(total_depois - total_antes) || '|' || bool_and(corte = '$CORTE') FROM public.pedido_total_liquido_conversoes")" "6|1|-171.40|true"
eq "A8 o convertido é líquido provado agora, e segue coerente" "$(classe "$A1")|$(Pq -c "SELECT public.t_sqlstate(\$q\$SELECT public.pedido_venda_exigir_coerencia('$A1')\$q\$)")" "ja_liquido|OK"
F1="$(foto)"
J="$(aplicar)"
eq "A9 idempotente: a 2ª rodada não escreve (sobra só o incoerente)" "$(campos "$J" escritos elegiveis incoerentes)" "0|1|1"
eq "A10 idempotente: nada mudou, nem updated_at" "$(foto)" "$F1"

echo "═══ G · mês completo — o gate é explícito ═══"
semear
J="$(aplicar "p_exigir_mes_completo => false")"
eq "G1 sem o gate: b1 e d4 também convertem" "$(campos "$J" escritos)|$(tot "$B1")|$(tot "$D4")" "8|90.00|54.00"
eq "G2 sem o gate, o que as linhas não provam continua intocado" "$(tot "$B2")|$(tot "$D1")|$(tot "$D2")|$(tot "$D3")" "150|0.01|0|100"

echo "═══ S · escopo ═══"
semear
J="$(aplicar "p_contas => ARRAY['colacor']")"
eq "S1 só colacor" "$(campos "$J" escritos)|$(tot "$C1")|$(tot "$A1")" "1|436.50|1629.25"
semear
J="$(aplicar "p_mes_de => '2026-07-01', p_mes_ate => '2026-07-31'")"
eq "S2 só julho: a1 a8 a9 a14 c1, e2 (abril) fica" "$(campos "$J" escritos)|$(tot "$E2")" "5|40"

echo "═══ L · limite que RECUSA (não trunca) ═══"
semear
F0="$(foto)"
eq "L1 escopo acima do limite recusa com TL002" "$(estado "p_limite => 3")" "TL002"
eq "L2 e não grava nada" "$(foto)" "$F0"
eq "L3 o ensaio acima do limite avisa, com o tamanho real" "$(campos "$(ensaiar "p_limite => 3")" excede_limite elegiveis)" "true|7"

echo "═══ V · parâmetros inválidos recusam com 22023 ═══"
F0="$(foto)"
eq "V1 p_corte NULL"         "$(Pq -c "SELECT public.t_sqlstate('SELECT public.pedido_total_liquido_converter(true, NULL)')")" "22023"
eq "V2 p_corte no futuro"    "$(Pq -c "SELECT public.t_sqlstate(\$q\$SELECT public.pedido_total_liquido_converter(true, now() + interval '1 hour')\$q\$)")" "22023"
eq "V3 p_contas vazio"       "$(estado "p_contas => ARRAY[]::text[]")" "22023"
eq "V4 conta desconhecida"   "$(estado "p_contas => ARRAY['xpto']")" "22023"
eq "V5 mês inicial depois do final" "$(estado "p_mes_de => '2026-08-01', p_mes_ate => '2026-07-01'")" "22023"
eq "V6 p_limite 0"           "$(estado "p_limite => 0")" "22023"
eq "V7 p_limite NULL (LIMIT NULL não limita)" "$(estado "p_limite => NULL")" "22023"
eq "V8 p_aplicar NULL"       "$(Pq -c "SELECT public.t_sqlstate(\$q\$SELECT public.pedido_total_liquido_converter(NULL, '$CORTE')\$q\$)")" "22023"
eq "V9 nenhuma recusa escreveu" "$(foto)" "$F0"

echo "═══ X · ACL das funções ═══"
eq "X1 PUBLIC/anon/authenticated sem EXECUTE; service_role com (as três)" \
   "$(Pq -c "SELECT string_agg(has_function_privilege('public', p.oid, 'EXECUTE') || ',' || has_function_privilege('anon', p.oid, 'EXECUTE') || ',' || has_function_privilege('authenticated', p.oid, 'EXECUTE') || ',' || has_function_privilege('service_role', p.oid, 'EXECUTE'), ' ' ORDER BY p.proname) FROM pg_proc p WHERE p.proname LIKE 'pedido\_total\_liquido\_%'")" \
   "false,false,false,true false,false,false,true false,false,false,true"
# `-q`: sem ele o psql ecoa a tag `SET` do SET ROLE na saída capturada.
eq "X2 authenticated chamando o relatório: 42501" "$(Pq -q -c "SET ROLE authenticated; SELECT public.t_sqlstate('SELECT public.pedido_total_liquido_relatorio(now())')")" "42501"
eq "X3 service_role (a edge) aplica de ponta a ponta — GRANTs suficientes" "$(Pq -q -c "SET ROLE service_role; SELECT (public.pedido_total_liquido_converter(p_aplicar => true, p_corte => '$CORTE'))->>'escritos'")" "6"

echo "═══ R · registro append-only ═══"
eq "R1 CHECK recusa total_depois ≥ total_antes" \
   "$(Pq -c "SELECT public.t_violacao(\$q\$INSERT INTO public.pedido_total_liquido_conversoes (lote, sales_order_id, account, mes, total_antes, total_depois, corte) VALUES (gen_random_uuid(), gen_random_uuid(), 'oben', '2026-07-01', 100, 100, now())\$q\$)")" \
   "23514:pedido_total_liquido_conversoes_valores"
eq "R2 CHECK recusa NaN (NaN ≥ 0 é TRUE; o < Infinity é que barra)" \
   "$(Pq -c "SELECT public.t_violacao(\$q\$INSERT INTO public.pedido_total_liquido_conversoes (lote, sales_order_id, account, mes, total_antes, total_depois, corte) VALUES (gen_random_uuid(), gen_random_uuid(), 'oben', '2026-07-01', 100, 'NaN', now())\$q\$)")" \
   "23514:pedido_total_liquido_conversoes_valores"
eq "R3 controle positivo: valor válido entra" \
   "$(Pq -c "SELECT public.t_violacao(\$q\$INSERT INTO public.pedido_total_liquido_conversoes (lote, sales_order_id, account, mes, total_antes, total_depois, corte) VALUES (gen_random_uuid(), gen_random_uuid(), 'oben', '2026-07-01', 100, 90, now())\$q\$)")" "OK"
eq "R4 authenticated não lê o registro" "$(Pq -q -c "SET ROLE authenticated; SELECT public.t_sqlstate('SELECT count(*) FROM public.pedido_total_liquido_conversoes')")" "42501"
eq "R5 service_role não apaga o registro" "$(Pq -q -c "SET ROLE service_role; SELECT public.t_sqlstate('DELETE FROM public.pedido_total_liquido_conversoes')")" "42501"
eq "R6 RLS ligada" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.pedido_total_liquido_conversoes'::regclass")" "t"

echo "═══ K · concorrência ═══"
eq "K1 escritor segurando o pai: o conversor não espera, pula e segue (SKIP LOCKED)" "$(cenario_k1)" "$K1_VERDE"
eq "K1b a rodada seguinte converte o que ficou" "$(campos "$(aplicar)" escritos)|$(tot "$A1")" "1|1489.34"
eq "K2 total reescrito entre a escolha e o lock NÃO é sobrescrito (M esperou; elegíveis 7; 1 mudou)" "$(cenario_k2)" "$K2_VERDE"
semear
sessao_x "SELECT pg_advisory_xact_lock(hashtext('pedido_total_liquido_converter'));" k3 || bad "K3 a sessão X não travou o advisory lock"
eq "K3 duas conversões ao mesmo tempo: a segunda recusa com 55P03" "$(estado)" "55P03"
liberar_x k3

echo "═══ P · paridade: o gêmeo do db:aplicar instala a MESMA coisa que a migration ═══"
if grep -qiE '^[[:space:]]*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)[[:space:]]*;' "$DBF"; then
  bad "P1 o gêmeo tem controle de transação — o db:aplicar o recusaria"
else
  ok "P1 o gêmeo não tem controle de transação"
fi
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres gemeo
PG() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d gemeo -v ON_ERROR_STOP=1 "$@"; }
PG -q -f "$REPO_ROOT/db/stubs-supabase.sql"
PG -q -f "$SCHEMA"
PG -q -f "$COER"
PG -q -1 -f "$DBF"
assinatura() {  # $1 = P | PG — funções (corpo, volatilidade, definer, config, ACL) + tabela (colunas, CHECK, índices, RLS, ACL)
  "$1" -tA -c "
    SELECT md5(
      coalesce((SELECT string_agg(concat_ws(':', p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc),
                                  p.provolatile, p.prosecdef, array_to_string(p.proconfig, ','), p.proacl::text), '|' ORDER BY p.proname)
                  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'pedido\_total\_liquido\_%'), '')
      || '#' || coalesce((SELECT string_agg(concat_ws(':', a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity,
                                  pg_get_expr(d.adbin, d.adrelid)), '|' ORDER BY a.attnum)
                  FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = 'public.pedido_total_liquido_conversoes'::regclass AND a.attnum > 0 AND NOT a.attisdropped), '')
      || '#' || coalesce((SELECT string_agg(k.conname || '=' || pg_get_constraintdef(k.oid), '|' ORDER BY k.conname)
                  FROM pg_constraint k WHERE k.conrelid = 'public.pedido_total_liquido_conversoes'::regclass), '')
      || '#' || coalesce((SELECT string_agg(i.indexdef, '|' ORDER BY i.indexname)
                  FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename = 'pedido_total_liquido_conversoes'), '')
      || '#' || (SELECT c.relrowsecurity::text || ':' || coalesce(c.relacl::text, '') FROM pg_class c
                  WHERE c.oid = 'public.pedido_total_liquido_conversoes'::regclass))"
}
eq "P2 o gêmeo instala as mesmas funções e a mesma tabela" "$(assinatura PG)" "$(assinatura P)"
# shellcheck disable=SC2016  # expressão perl: os $ são do perl, não do shell
perl -0pe 's/oi\.desconto_valor <= oi\.quantity \* oi\.unit_price \+ 0\.005/oi.desconto_valor <= oi.quantity * oi.unit_price + 0.006/' "$DBF" > "$TMPD/gemeo-sabotado.sql"
if cmp -s "$DBF" "$TMPD/gemeo-sabotado.sql"; then bad "P3 a sabotagem do gêmeo não mudou o texto (falsificação inválida)"; fi
PG -q -1 -f "$TMPD/gemeo-sabotado.sql" >/dev/null
vermelho "P3 gêmeo com UM caractere diferente no guard: a assinatura acusa" "$(assinatura PG)" "$(assinatura P)"
PG -q -1 -f "$DBF" >/dev/null
eq "P4 controle: o gêmeo real volta a bater" "$(assinatura PG)" "$(assinatura P)"

echo "═══ Z · lote padrão de ponta a ponta, depois de tudo ═══"
semear
eq "Z1 escritos|Σ mudança" "$(campos "$(aplicar)" escritos soma_mudanca)" "6|-171.40"

echo
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ]
exit 0
fi

# ════════════════════════════════════ modo --falsificar ═════════════════════════════════════
VERM=0; FALH=0
sab_verm()  { VERM=$((VERM+1)); echo "  🔴 $1"; }
sab_falha() { FALH=$((FALH+1)); echo "  ❌ $1"; }
# Vermelho = o valor sob sabotagem DIFERE do verde.
vermelha()  { if [ "$2" != "$3" ]; then sab_verm "$1 (sabotado: [$2] ≠ verde [$3])"; else sab_falha "$1 — a sabotagem ficou VERDE [$2]: o assert não tem dente"; fi; }
# Vermelho reconhecido pela ASSINATURA do ramo que deveria disparar (não por "falhou algo").
vermelha_por() { if [ "$2" = "$3" ]; then sab_verm "$1 (=$2)"; else sab_falha "$1 — esperado o ramo [$3], veio [$2]"; fi; }
controle()  { if [ "$2" = "$3" ]; then echo "  ✅ $1 (=$2)"; else sab_falha "$1 — restaurada, a migration NÃO voltou ao verde: esperado [$3], veio [$2]"; fi; }

echo "═══ F0 · linha de base VERDE, nesta invocação, antes da primeira sabotagem ═══"
BASE_OK=1
base() { if [ "$2" = "$3" ]; then echo "  ✅ $1 (=$2)"; else echo "  ❌ $1 — esperado [$3], veio [$2]"; BASE_OK=0; fi; }
base "F0a classes" "$(classe "$A10")|$(classe "$B2")|$(classe "$A9")|$(classe "$A4")|$(classe "$D1")" "tocado_pos_corte|nao_apurado|convertivel|ambiguo|linha_invalida"
F0="$(foto)"; ensaiar >/dev/null
base "F0b o ensaio não escreve" "$(Pq -c "SELECT public.t_foto() = '$F0'")" "t"
base "F0c o lote padrão aplica, e o gate segura o mês incompleto" "$(estado)|$(tot "$A8")|$(tot "$B1")|$(tot "$A1")" "OK|9.01|100|1489.34"
semear
base "F0d o limite recusa" "$(estado "p_limite => 3")" "TL002"
base "F0e K1" "$(cenario_k1)" "$K1_VERDE"
base "F0f K2" "$(cenario_k2)" "$K2_VERDE"
if [ "$BASE_OK" -ne 1 ]; then
  echo "linha de base NÃO é verde — sabotar agora aprovaria tudo; a falsificação não roda"
  exit 1
fi

echo "═══ F · cada sabotagem na migration exige VERMELHO; restaurada, o VERDE volta ═══"
TMPM="$TMPD/mig-sabotada.sql"
sabotar() {  # $1 = rótulo; $2 = expressão perl (-0: atravessa linhas). Só escreve o espelho e confere.
  perl -0pe "$2" "$MIG" > "$TMPM"
  if cmp -s "$MIG" "$TMPM"; then
    sab_falha "$1 — a sabotagem não alterou o texto da migration (falsificação inválida)"
    return 1
  fi
}
restaurar() { P -q -f "$MIG" >/dev/null; }

# shellcheck disable=SC2016  # todas as expressões perl abaixo usam $ do perl, não do shell
{
if sabotar F1 's/AND p_corte IS NOT NULL AND m\.atualizado_em >= p_corte/AND false/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F1 sem o corte, o cabeçalho reescrito depois dele vira convertível" "$(classe "$A10")" "tocado_pos_corte"
  restaurar; controle "F1 controle" "$(classe "$A10")" "tocado_pos_corte"
fi

if sabotar F2 's/count\(\*\) FILTER \(WHERE oi\.desconto_valor IS NULL\)(\s+)AS n_nao_apurada/0::bigint$1AS n_nao_apurada/; s/sum\(oi\.quantity \* oi\.unit_price - oi\.desconto_valor\)(\s+)AS liquido_cru/sum(oi.quantity * oi.unit_price - coalesce(oi.desconto_valor, 0))$1AS liquido_cru/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F2 coalesce(desconto_valor, 0): a linha não apurada vira desconto zero" "$(classe "$B2")" "nao_apurado"
  restaurar; controle "F2 controle" "$(classe "$B2")" "nao_apurado"
fi

if sabotar F3 's/sum\(oi\.quantity \* oi\.unit_price - oi\.desconto_valor\)(\s+)AS liquido_cru/sum(round(oi.quantity * oi.unit_price - oi.desconto_valor, 2))$1AS liquido_cru/'; then
  P -q -f "$TMPM" >/dev/null; semear; aplicar >/dev/null
  vermelha "F3 arredondar por linha muda o centavo do a8" "$(tot "$A8")" "9.01"
  restaurar; semear; aplicar >/dev/null; controle "F3 controle" "$(tot "$A8")" "9.01"
fi

if sabotar F4 's/abs\(m\.total_atual - m\.bruto_r\) <= 0\.01/m.total_atual = m.bruto_r/g'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F4 sem a tolerância do float, o bruto a 1 centavo não converte" "$(classe "$A9")" "convertivel"
  restaurar; controle "F4 controle" "$(classe "$A9")" "convertivel"
fi

if sabotar F5 's/THEN \x27ambiguo\x27/THEN \x27convertivel\x27/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F5 sem o ambíguo, o desconto de 1 centavo converte" "$(classe "$A4")" "ambiguo"
  restaurar; controle "F5 controle" "$(classe "$A4")" "ambiguo"
fi

if sabotar F6 's/WHEN m\.liquido_r < 0/WHEN false/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F6 sem o guard de líquido negativo, −0,01 vira convertível" "$(classe "$D1")" "linha_invalida"
  restaurar; controle "F6 controle" "$(classe "$D1")" "linha_invalida"
fi

if sabotar F7 's/ORDER BY so\.id(\s+)FOR UPDATE SKIP LOCKED\) t;/ORDER BY so.id$1FOR UPDATE) t;/'; then
  P -q -f "$TMPM" >/dev/null
  vermelha "F7 sem SKIP LOCKED, o conversor espera o escritor" "$(cenario_k1)" "$K1_VERDE"
  restaurar; controle "F7 controle" "$(cenario_k1)" "$K1_VERDE"
fi

if sabotar F8 's/v_coerentes\) c(\s+)WHERE c\.classe = \x27convertivel\x27/v_coerentes) c$1WHERE true/'; then
  P -q -f "$TMPM" >/dev/null
  vermelha "F8 sem re-classificar sob o lock, o total que mudou é sobrescrito" "$(cenario_k2)" "$K2_VERDE"
  restaurar; controle "F8 controle" "$(cenario_k2)" "$K2_VERDE"
fi

if sabotar F9 's/PERFORM public\.pedido_venda_exigir_coerencia\(v_id\);/NULL;/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha_por "F9 sem a checagem de coerência, o incoerente derruba o lote no COMMIT (23514)" "$(estado)" "23514"
  restaurar; semear; controle "F9 controle" "$(estado)" "OK"
fi

if sabotar F10 's/AND \(NOT p_exigir_mes_completo OR m\.n_nao_apurado \+ m\.n_linha_invalida = 0\)/AND true/'; then
  P -q -f "$TMPM" >/dev/null; semear; aplicar >/dev/null
  vermelha "F10 sem o gate, o mês incompleto converte pela metade" "$(tot "$B1")" "100"
  restaurar; semear; aplicar >/dev/null; controle "F10 controle" "$(tot "$B1")" "100"
fi

if sabotar F11 's/IF v_n_elegiveis > p_limite THEN/IF false THEN/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha "F11 sem a recusa, o escopo acima do limite grava" "$(estado "p_limite => 3")" "TL002"
  restaurar; semear; controle "F11 controle" "$(estado "p_limite => 3")" "TL002"
fi

if sabotar F12 's/IF NOT p_aplicar THEN(\s+RETURN jsonb_build_object\(\s+\x27modo\x27, \x27ensaio\x27, \x27corte\x27, p_corte, \x27escopo\x27, v_escopo, \x27limite\x27, p_limite,\s+\x27excede_limite\x27, false)/IF false THEN$1/'; then
  semear
  # Camada 1: a postcondição da MIGRATION executa o ensaio e vê `modo: aplicado` — recusa o apply.
  if P -q -f "$TMPM" >"$TMPD/f12.out" 2>&1; then f12="aplicou"
  elif grep -q 'POSTCONDICAO FALHOU' "$TMPD/f12.out"; then f12="postcondicao"
  else f12="outro_erro"; fi
  vermelha_por "F12a o ensaio que cai no caminho de escrita: a postcondição da migration recusa o apply" "$f12" "postcondicao"
  # Camada 2, uma de cada vez: instalada SEM a postcondição, a foto do harness também acusa.
  perl -0pe 's/DO \$post\$.*?\$post\$;//s' "$TMPM" > "$TMPD/mig-sem-post.sql"
  P -q -f "$TMPD/mig-sem-post.sql" >/dev/null; semear; F0="$(foto)"; ensaiar >/dev/null
  vermelha "F12b sem a postcondição, o ensaio grava — e a foto acusa" "$(Pq -c "SELECT public.t_foto() = '$F0'")" "t"
  restaurar; semear; F0="$(foto)"; ensaiar >/dev/null
  controle "F12 controle" "$(Pq -c "SELECT public.t_foto() = '$F0'")" "t"
fi

# F13: a postcondição da MIGRATION sobre a ACL. As funções saem antes — CREATE OR REPLACE preserva
# a ACL antiga, e só uma função NOVA recebe os default privileges que o REVOKE sabotado deixaria.
DROP_FNS="DROP FUNCTION IF EXISTS public.pedido_total_liquido_converter(boolean, timestamptz, text[], date, date, integer, boolean), public.pedido_total_liquido_relatorio(timestamptz), public.pedido_total_liquido_classificar(timestamptz, uuid[])"
if sabotar F13 's/(REVOKE ALL ON FUNCTION public\.pedido_total_liquido_converter\([^)]*\) FROM PUBLIC), anon, authenticated;/$1, authenticated;/'; then
  P -q -c "$DROP_FNS"
  if P -q -f "$TMPM" >"$TMPD/f13.out" 2>&1; then f13="aplicou"
  elif grep -q 'POSTCONDICAO FALHOU' "$TMPD/f13.out"; then f13="postcondicao"
  else f13="outro_erro"; fi
  vermelha_por "F13 anon com EXECUTE: a postcondição da migration aborta o apply" "$f13" "postcondicao"
  P -q -c "$DROP_FNS"
  if P -q -f "$MIG" >"$TMPD/f13.out" 2>&1; then f13="aplicou"; else f13="falhou"; fi
  controle "F13 controle: a migration real, em banco sem as funções, aplica" "$f13" "aplicou"
fi

if sabotar F14 's/SET total    = a\.liquido,/SET total    = a.liquido - 0.01,/'; then
  P -q -f "$TMPM" >/dev/null; semear
  vermelha_por "F14 escrita errada por 1 centavo: a postcondição do conversor devolve o lote (TL001)" "$(estado)" "TL001"
  controle "F14 e a sabotagem não gravou nada" "$(tot "$A1")" "1629.25"
  restaurar; semear; controle "F14 controle" "$(estado)" "OK"
fi
}

echo "═══ controle final: restaurada, o lote padrão de ponta a ponta ═══"
semear
controle "Z1 escritos|Σ mudança" "$(campos "$(aplicar)" escritos soma_mudanca)" "6|-171.40"

echo
echo "SABOTAGENS: $VERM vermelhas / $FALH falhas"
[ "$FALH" -eq 0 ]

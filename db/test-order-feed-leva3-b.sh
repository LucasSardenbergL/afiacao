#!/usr/bin/env bash
# test-order-feed-leva3-b.sh — prova PG17 da migration 20261127214433_order_feed_origem_fim_busca_exclusao.sql
# ================================================================================================
# /sales leva 3 PR B: origem_omie (#5), fim do período no valor do recorte (#31), busca pré-calculada
# (#35) e a recuperação server-side da exclusão (#19).
#
# Banco: stubs + schema-snapshot + 20261113120000 + 20261102160821 (corpo vivo da view na prod) +
# 20261123120000 (total/vendedor vivos na prod) + ACL de prod de sales_orders (por COLUNA, psql-ro
# 2026-11-27) + a migration REAL (cópia — a sabotagem age na cópia). O seed entra ANTES da migration:
# a `busca` antiga é fotografada e comparada com a nova (paridade de 14 colunas, nos dois sentidos).
#
#   MIG   aplica com a PÓS verde · MIG2 re-aplicar é seguro
#   I1    security_invoker segue true (pg_class.reloptions) · I2 origem_omie é a 15ª coluna
#   PB    paridade: as 14 colunas antigas iguais antes × depois (EXCEPT ALL nos dois sentidos)
#   B2    busca_base acompanha a escrita (itens trocados → a busca acha o item novo)
#   O1    origem_omie: omie_* = true · app (hash nulo) = false · 'omieX1' = false (o _ é literal) · afiação = false
#   R1    staff lê a view (sem 42501) · R2 customer só vê os próprios (SECURITY INVOKER)
#   T1    "Hoje" em SP com o fim: entram 00:00Z/12:00Z do dia e 02:59:59Z do dia seguinte; saem a data-pura
#         do dia seguinte (00:00Z), o instante exato do fim (03:00Z) e a véspera local
#   T2    paridade RPC × filtros da listagem (gte/eq puros + lt + neq) em 8 recortes
#   T3    chamada antiga (7 parâmetros nomeados) segue respondendo · T4 a de 7 args sumiu · T5 ramo vendedor
#   G1    anon sem EXECUTE no total (42501)
#   E1    authenticated marca → marca em curso · E2 service_role marca (reconciliador) → nenhuma marca
#   E3    authenticated desfaz → 'desfeito' · E4 recuperação: marca velha volta à lista, baixa do reconciliador NÃO
#   E5    marca recente (< 30 min) não é recuperada · E6 re-carimbo segue a marca · E7 DELETE físico leva a marca
#   E8    idade < 10 min → 22023 EXCLUSAO_RECUPERAR_PARAM · E9 app não lê a marca nem executa a recuperação (42501)
#   C1    cron agendado (*/10)
#
# Uso:  bash db/test-order-feed-leva3-b.sh > /tmp/t.log 2>&1; echo "exit=$?"
#       HARNESS_LC_ALL=pt_BR.UTF-8 bash db/test-order-feed-leva3-b.sh
#       bash db/test-order-feed-leva3-b.sh --falsificar
#       IMPRIMIR_MD5=1 bash db/test-order-feed-leva3-b.sh   (md5 do corpo novo da view, para a PRE/PÓS)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5861}"
SLUG="order-feed-leva3-b"
export LC_ALL="${HARNESS_LC_ALL:-C}" LANG="${HARNESS_LC_ALL:-C}"
MIG_ORIG="$REPO_ROOT/supabase/migrations/20261127214433_order_feed_origem_fim_busca_exclusao.sql"
MIG_VENDEDOR="$REPO_ROOT/supabase/migrations/20261113120000_vendedor_pedido_omie.sql"
MIG_VIEW="$REPO_ROOT/supabase/migrations/20261102160821_order_feed_sem_cte.sql"
MIG_TOTAL="$REPO_ROOT/supabase/migrations/20261123120000_order_feed_vendedor_total.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=27

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS:VERDES-de-controle   (ID!MARCA = vermelho de execução com a marca)
  SABOTAGENS="origem_sem_escape:O1:R1,T1
              busca_sem_base:MIG!POS_FALHOU
              busca_base_vazia:PB,B2:O1
              fim_sem_puros:T1,T2:O1
              fim_inclusivo:T1:O1,E1
              marca_qualquer_role:E2,E4:E1
              recupera_sem_idade:E5:E1,E3
              recupera_sem_carimbo:E6:E1
              sem_cascade:E7:E1
              sem_grant_busca:MIG!POS_FALHOU
              invoker_off:MIG!POS_FALHOU
              total_anon:MIG!POS_FALHOU
              definer_total:MIG!POS_FALHOU"
  falhas=0
  echo "═══ CONTROLE (sem sabotagem) ═══"
  if ! PGPORT_TEST="$PORT" bash "$0" > "/tmp/falsif-${SLUG}-controle.log" 2>&1; then
    echo "❌ CONTROLE VERMELHO — sem linha de base, a falsificação não prova nada"; tail -20 "/tmp/falsif-${SLUG}-controle.log"; exit 1
  fi
  n=$(grep -c '  ✅ ' "/tmp/falsif-${SLUG}-controle.log" || true)
  [ "$n" = "$TOTAL_ESPERADO" ] || { echo "❌ CONTROLE rodou $n asserts, esperado $TOTAL_ESPERADO"; exit 1; }
  echo "  ✅ controle verde ($n asserts)"
  i=0
  for linha in $SABOTAGENS; do
    i=$((i+1))
    nome="${linha%%:*}"; resto="${linha#*:}"; reds="${resto%%:*}"
    case "$resto" in *:*) greens="${resto#*:}" ;; *) greens="" ;; esac
    log="/tmp/falsif-${SLUG}-${nome}.log"
    if SABOTAGEM="$nome" PGPORT_TEST="$((PORT+i))" bash "$0" > "$log" 2>&1; then
      echo "❌ $nome: harness VERDE com a sabotagem — assert sem dente"; falhas=$((falhas+1)); continue
    fi
    grep -q '^INFRA' "$log" && { echo "❌ $nome: INFRA — $(grep -m1 '^INFRA' "$log")"; falhas=$((falhas+1)); continue; }
    antes=$falhas
    for a in ${reds//,/ }; do
      case "$a" in
        *!*) id="${a%%!*}"; marca="${a#*!}"
             grep -q "^  ❌ $id .*ERROR:  $marca:" "$log" || { echo "❌ $nome: $id devia falhar com a marca $marca"; falhas=$((falhas+1)); } ;;
        *)   grep -q "^  ❌ $a " "$log" || { echo "❌ $nome: $a devia estar VERMELHO"; falhas=$((falhas+1)); } ;;
      esac
    done
    for a in ${greens//,/ }; do
      [ -n "$a" ] || continue
      grep -q "^  ✅ $a " "$log" || { echo "❌ $nome: $a (controle) devia seguir VERDE"; falhas=$((falhas+1)); }
    done
    [ "$falhas" = "$antes" ] || continue
    echo "  ✅ $nome → vermelho em [$reds]${greens:+, verde em [$greens]}"
  done
  [ "$falhas" = 0 ] || { echo "❌ FALSIFICAÇÃO FALHOU ($falhas)"; exit 1; }
  echo "✅ FALSIFICAÇÃO OK — todas as sabotagens ficaram vermelhas onde deviam"
  exit 0
fi

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/ (resolve o PGBIN no Mac e no CI)
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c TimeZone=UTC" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1 $2 (=$3)"; else bad "$1 $2 — esperado [$4], veio [$3]"; fi; }
# Erro esperado: casa a SQLSTATE e a MARCA (ASCII, caixa fixa) — "lançou algo" não conta.
erro() { # $1 id, $2 descrição, $3 sqlstate, $4 marca, $5 sql
  local out; out="$(P -tA -c "\\set VERBOSITY verbose" -c "$5" 2>&1 || true)"
  if printf '%s' "$out" | grep -q "ERROR:  $3:" && printf '%s' "$out" | grep -q "$4"; then
    ok "$1 $2 ($3 $4)"
  else
    bad "$1 $2 — esperado $3/$4, veio: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
}

rr="$TMPD/snap.sql"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$SNAP" | grep -vE '^\\(un)?restrict ' > "$rr"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
DO $$ BEGIN CREATE ROLE claude_ro; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" >/dev/null
P --single-transaction -q -f "$rr" >/dev/null 2>"$TMPD/snap.err" || { echo "INFRA: snapshot não carregou"; tail -5 "$TMPD/snap.err"; exit 1; }
P -q -f "$MIG_VENDEDOR" >/dev/null 2>"$TMPD/pre.err" || { echo "INFRA: 20261113120000 não aplicou"; tail -5 "$TMPD/pre.err"; exit 1; }
perl -0pe 's/DO \$pre\$.*?\$pre\$;//s' "$MIG_VIEW" > "$TMPD/view.sql"
P -q -f "$TMPD/view.sql" >/dev/null 2>"$TMPD/view.err" || { echo "INFRA: 20261102160821 não aplicou"; tail -5 "$TMPD/view.err"; exit 1; }
# pg_cron não existe no PG17 local: schedule/unschedule de mentira sobre a cron.job dos stubs.
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION cron.schedule(p_nome text, p_agenda text, p_cmd text) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobid, schedule, command, jobname, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_agenda, p_cmd, p_nome, true) RETURNING jobid $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_nome text) RETURNS boolean LANGUAGE sql AS $f$
  DELETE FROM cron.job WHERE jobname = p_nome RETURNING true $f$;
SQL
# ACL de prod (psql-ro, 2026-11-27): sales_orders por COLUNA (S = SELECT, U = UPDATE).
P -q <<'SQL' >/dev/null
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
REVOKE SELECT, UPDATE, DELETE ON public.sales_orders FROM authenticated;
GRANT SELECT (id, customer_user_id, created_by, items, subtotal, discount, total, status, notes, omie_pedido_id,
              omie_numero_pedido, created_at, updated_at, account, hash_payload, deleted_at) ON public.sales_orders TO authenticated;
GRANT UPDATE (items, subtotal, total, status, notes, deleted_at) ON public.sales_orders TO authenticated;
GRANT SELECT ON public.orders, public.profiles, public.order_feed TO authenticated;
SQL
P -q -f "$MIG_TOTAL" >/dev/null 2>"$TMPD/tot.err" || { echo "INFRA: 20261123120000 não aplicou"; tail -5 "$TMPD/tot.err"; exit 1; }
MD5_ANTES="$(Pq -c "SELECT md5(pg_get_viewdef('public.order_feed'::regclass, true))")"
[ "$MD5_ANTES" = "dee24dde20ac343a81f9ebaa0e6df44f" ] || { echo "INFRA: corpo antigo local ($MD5_ANTES) ≠ o da prod — o md5 daqui não vale lá"; exit 1; }
echo "═══ setup pronto (PG17 :$PORT, LC_ALL=$LC_ALL${SABOTAGEM:+, SABOTAGEM=$SABOTAGEM}) ═══"

# ── seed (ANTES da migration: a busca antiga é fotografada) ─────────────────────────────────────
# F master · E employee · A1 vendedor · C1/C2/C3 clientes. t* = período (C3); o* = procedência.
P -q <<'SQL' >/dev/null
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000f1'), ('00000000-0000-0000-0000-0000000000e1'), ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000c1'), ('00000000-0000-0000-0000-0000000000c2'), ('00000000-0000-0000-0000-0000000000c3')
ON CONFLICT DO NOTHING;
DELETE FROM public.user_roles WHERE user_id::text LIKE '00000000-0000-0000-0000-0000000000%';
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000f1', 'master'), ('00000000-0000-0000-0000-0000000000e1', 'employee'),
  ('00000000-0000-0000-0000-0000000000a1', 'employee'), ('00000000-0000-0000-0000-0000000000c1', 'customer'),
  ('00000000-0000-0000-0000-0000000000c2', 'customer'), ('00000000-0000-0000-0000-0000000000c3', 'customer');
INSERT INTO public.profiles (id, user_id, name, document, is_approved) VALUES
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c1', 'ÁLVARO & CIA',      '11.111.111/0001-11', true),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c2', 'JOÃO &amp; FILHOS', '22.222.222/0001-22', true),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000000c3', 'Período Teste',     '33.333.333/0001-33', true);
INSERT INTO public.sales_orders (id, customer_user_id, created_by, items, subtotal, total, status, account, created_at,
                                 hash_payload, omie_numero_pedido, vendedor_user_id, vendedor_omie_codigo, vendedor_lido_em) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000f1',
   '[{"descricao":"Verniz PU Açaí","quantidade":2},{"descricao":"","quantidade":1}]', 100.005, 100.005, 'separacao', 'oben',
   '2026-11-01 12:00:00+00', NULL, '4821', '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1',
   '{"nao":"lista"}', 50, 50, 'rascunho', 'colacor', '2026-11-02 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000f1',
   '[{"descricao":"Seladora ÉPOXI","quantidade":1}]', 70, 70, 'cancelado', 'colacor', '2026-11-03 12:00:00+00',
   'omieX1', '9', NULL, NULL, NULL),
  -- período "Hoje" em São Paulo (2026-11-10): desde 03:00Z, puros {00:00Z}; fim 2026-11-11 03:00Z, puros_fim {00:00Z do dia 11}
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 1, 1, 'enviado', 'oben', '2026-11-10 00:00:00+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 2, 2, 'enviado', 'oben', '2026-11-11 02:59:59+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 4, 4, 'enviado', 'oben', '2026-11-11 00:00:00+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('30000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 8, 8, 'enviado', 'oben', '2026-11-11 03:00:00+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('30000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 16, 16, 'enviado', 'oben', '2026-11-10 02:59:59+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  ('30000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-0000000000c3', NULL, '[]', 32, 32, 'enviado', 'oben', '2026-11-10 12:00:00+00', NULL, NULL, '00000000-0000-0000-0000-0000000000a1', 841, now()),
  -- exclusão (#19): x1..x5 do app, x9 importado (o reconciliador do Omie é quem o baixa)
  ('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'rascunho', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'rascunho', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'rascunho', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'rascunho', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'rascunho', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL),
  ('40000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-0000000000c1', NULL, '[]', 1, 1, 'importado', 'oben', '2026-11-05 12:00:00+00', NULL, NULL, NULL, NULL, NULL);
UPDATE public.sales_orders SET omie_pedido_id = 111, order_date_kpi = '2026-11-01', hash_payload = 'omie_oben_111' WHERE id = '20000000-0000-0000-0000-000000000001';
UPDATE public.sales_orders SET omie_pedido_id = 999, order_date_kpi = '2026-11-05', hash_payload = 'omie_oben_999' WHERE id = '40000000-0000-0000-0000-000000000009';
INSERT INTO public.orders (id, user_id, items, subtotal, total, status, created_at, service_type, delivery_option)
VALUES ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000000c1',
        '[{"category":"Faca"},{"name":"Serra"},{}]', 10, 10, 'pedido_recebido', '2026-11-04 12:00:00+00', 'afiacao', 'retirada');
CREATE TABLE public.feed_antes AS
  SELECT origin, id, created_at, account, order_number, omie_pedido_id, customer_user_id, customer_name,
         item_names, item_quantity, status, subtotal, total, busca FROM public.order_feed;
SQL

MIG="$TMPD/mig.sql"
cp "$MIG_ORIG" "$MIG"
sabotar() { # $1 = expressão perl; exige que MUDE o arquivo (sabotagem que não casa = teatro)
  local antes depois
  antes="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  perl -0pi -e "$1" "$MIG"
  depois="$(md5 -q "$MIG" 2>/dev/null || md5sum "$MIG" | cut -d' ' -f1)"
  [ "$antes" != "$depois" ] || { echo "INFRA: sabotagem '$SABOTAGEM' não casou nada"; exit 2; }
}
if [ "${IMPRIMIR_MD5:-}" = "1" ]; then
  sabotar 's/IS DISTINCT FROM .__MD5_VIEW_NOVA__. THEN/IS DISTINCT FROM NULL AND false THEN/'
  P -q -f "$MIG" >/dev/null
  echo "MD5_VIEW_NOVA=$(Pq -c "SELECT md5(pg_get_viewdef('public.order_feed'::regclass, true))")"
  exit 0
fi
# A PÓS pega as sabotagens de catálogo; as de comportamento só os asserts de execução pegam.
# shellcheck disable=SC2016  # $1 nas expressões é do PERL (grupo capturado), não do shell
case "${SABOTAGEM:-}" in
  "") ;;
  origem_sem_escape)    sabotar "s/LIKE 'omie\\\\_%'/LIKE 'omie_%'/" ;;
  busca_sem_base)       sabotar 's/\) \|\| f\.busca_base\)::text AS busca/) || \x27\x27)::text AS busca/' ;;
  busca_base_vazia)     sabotar 's/so\.busca_base               AS busca_base,/(E\x27\\n\x27 || COALESCE(so.omie_numero_pedido, \x27\x27) || E\x27\\n\\n\x27 || round(COALESCE(so.total, 0), 2)::text || E\x27\\n\x27 || replace(round(COALESCE(so.total, 0), 2)::text, \x27.\x27, \x27,\x27)) AS busca_base,/; s/IF v_div <> 0 THEN/IF false THEN/' ;;
  fim_sem_puros)        sabotar 's/ AND NOT \(f\.created_at = ANY \(COALESCE\(p_puros_fim, .\{\}.::timestamptz\[\]\)\)\)//g' ;;
  fim_inclusivo)        sabotar 's/f\.created_at < p_ate/f.created_at <= p_ate/g' ;;
  marca_qualquer_role)  sabotar "s/IF coalesce\\(auth\\.role\\(\\), ''\\) = 'authenticated' THEN/IF true THEN/" ;;
  recupera_sem_idade)   sabotar 's/AND m\.marcado_em < now\(\) - p_idade/AND true/' ;;
  recupera_sem_carimbo) sabotar 's/SET carimbo = NEW\.deleted_at, marcado_em = now\(\)/SET marcado_em = marcado_em/' ;;
  sem_cascade)          sabotar 's/REFERENCES public\.sales_orders\(id\) ON DELETE CASCADE,/,/' ;;
  sem_grant_busca)      sabotar 's/^GRANT SELECT \(busca_base\) ON public\.sales_orders TO authenticated;$//m' ;;
  invoker_off)          sabotar 's/(CREATE OR REPLACE VIEW public\.order_feed\n)WITH \(security_invoker = true\)\n/$1/' ;;
  total_anon)           sabotar 's/(GRANT EXECUTE ON FUNCTION public\.order_feed_total\([^)]*\) TO authenticated, service_role);/$1, anon;/' ;;
  definer_total)        sabotar 's/(RETURNS TABLE \(pedidos bigint, soma numeric, sem_total bigint\)\nLANGUAGE plpgsql\nSTABLE\n)SECURITY INVOKER/${1}SECURITY DEFINER/' ;;
  *) echo "INFRA: sabotagem desconhecida '$SABOTAGEM'"; exit 2 ;;
esac

# ── MIG ──────────────────────────────────────────────────────────────────────────────────────────
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG migration aplica (POS verde)"; else bad "MIG migration falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi
if out="$(P -q -f "$MIG" 2>&1)"; then ok "MIG2 re-aplicar é seguro"; else bad "MIG2 re-aplicar falhou: $(printf '%s' "$out" | grep -m1 ERROR)"; fi

como() { # $1 uid, $2 sql → última linha
  Pq -c "SET ROLE authenticated; SET test.uid = '$1'; SET test.role = 'authenticated'; $2" 2>&1 | tail -1
}
F=00000000-0000-0000-0000-0000000000f1; A1=00000000-0000-0000-0000-0000000000a1
C1=00000000-0000-0000-0000-0000000000c1; C3=00000000-0000-0000-0000-0000000000c3

# ── catálogo ─────────────────────────────────────────────────────────────────────────────────────
eq I1 "security_invoker da view" "$(Pq -c "SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = 'public.order_feed'::regclass")" "security_invoker=true"
eq I2 "15ª coluna" "$(Pq -c "SELECT attname FROM pg_attribute WHERE attrelid = 'public.order_feed'::regclass AND attnum = 15")" "origem_omie"

# ── #35 busca ────────────────────────────────────────────────────────────────────────────────────
eq PB "14 colunas antigas iguais (antes−depois + depois−antes)" "$(Pq -c "
  SELECT (SELECT count(*) FROM (SELECT * FROM public.feed_antes EXCEPT ALL
            SELECT origin, id, created_at, account, order_number, omie_pedido_id, customer_user_id, customer_name,
                   item_names, item_quantity, status, subtotal, total, busca FROM public.order_feed) a)
       + (SELECT count(*) FROM (SELECT origin, id, created_at, account, order_number, omie_pedido_id, customer_user_id, customer_name,
                   item_names, item_quantity, status, subtotal, total, busca FROM public.order_feed EXCEPT ALL
            SELECT * FROM public.feed_antes) b)")" "0"
P -q -c "UPDATE public.sales_orders SET items = '[{\"descricao\":\"Catalisador Ômega\",\"quantidade\":1}]' WHERE id = '20000000-0000-0000-0000-000000000002'"
eq B2 "busca acha o item trocado" "$(como "$F" "SELECT count(*) FROM public.order_feed WHERE busca ILIKE '%catalisador omega%'")" "1"

# ── #5 procedência ───────────────────────────────────────────────────────────────────────────────
eq O1 "origem_omie por linha" "$(Pq -c "SELECT string_agg(id::text || '=' || origem_omie, ' ' ORDER BY id) FROM public.order_feed
  WHERE id IN ('20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000001')")" \
  "20000000-0000-0000-0000-000000000001=true 20000000-0000-0000-0000-000000000002=false 20000000-0000-0000-0000-000000000003=false 50000000-0000-0000-0000-000000000001=false"
eq R1 "staff lê a view (linhas)" "$(como "$F" "SELECT count(*) FROM public.order_feed")" "$(Pq -c "SELECT count(*) FROM public.order_feed")"
eq R2 "customer só vê os próprios" "$(como "$C3" "SELECT count(*) || '/' || count(*) FILTER (WHERE customer_user_id = '$C3') FROM public.order_feed")" "6/6"

# ── #31 fim do período ───────────────────────────────────────────────────────────────────────────
HOJE="p_desde => '2026-11-10 03:00:00+00', p_puros => ARRAY['2026-11-10 00:00:00+00']::timestamptz[], p_ate => '2026-11-11 03:00:00+00', p_puros_fim => ARRAY['2026-11-11 00:00:00+00']::timestamptz[]"
eq T1 "Hoje em SP (pedidos/soma: 1+2+32)" "$(como "$F" "SELECT pedidos || '/' || soma FROM public.order_feed_total($HOJE, p_customer => '$C3')")" "3/35.00"
T2="$(Pq -c "
  WITH dias AS (SELECT d::date AS dia FROM generate_series('2026-11-03'::date, '2026-11-10'::date, '1 day') d),
  corte AS (SELECT dia, (dia::timestamp + interval '3 hours') AT TIME ZONE 'UTC' AS desde,
                   ARRAY[dia::timestamp AT TIME ZONE 'UTC'] AS puros,
                   ((dia + 3)::timestamp + interval '3 hours') AT TIME ZONE 'UTC' AS ate,
                   ARRAY[(dia + 3)::timestamp AT TIME ZONE 'UTC'] AS puros_fim FROM dias)
  SELECT count(*) FILTER (WHERE rpc.pedidos IS DISTINCT FROM lista.n OR rpc.soma IS DISTINCT FROM lista.s)
  FROM corte c
  CROSS JOIN LATERAL public.order_feed_total(p_desde => c.desde, p_puros => c.puros, p_ate => c.ate, p_puros_fim => c.puros_fim) rpc
  CROSS JOIN LATERAL (SELECT count(*)::bigint AS n, round(sum(f.total), 2) AS s FROM public.order_feed f
                      WHERE (f.created_at >= c.desde OR f.created_at = ANY (c.puros))
                        AND f.created_at < c.ate AND f.created_at <> c.puros_fim[1]) lista")"
eq T2 "RPC = filtros da listagem em 8 recortes (divergentes)" "$T2" "0"
eq T3 "chamada antiga (7 parâmetros) responde" "$(como "$F" "SELECT pedidos FROM public.order_feed_total(p_account => NULL, p_status => NULL, p_desde => NULL, p_puros => NULL, p_customer => '$C3', p_busca => NULL, p_vendedor => NULL)")" "6"
eq T4 "assinatura de 7 args sumiu" "$(Pq -c "SELECT to_regprocedure('public.order_feed_total(text, text[], timestamptz, timestamptz[], uuid, text, uuid)') IS NULL")" "t"
eq T5 "ramo vendedor com o fim" "$(como "$F" "SELECT pedidos FROM public.order_feed_total($HOJE, p_vendedor => '$A1', p_customer => '$C3')")" "3"
erro G1 "anon sem EXECUTE no total" 42501 "permission denied for function order_feed_total" "SET ROLE anon; SELECT * FROM public.order_feed_total()"

# ── #19 marca e recuperação ──────────────────────────────────────────────────────────────────────
X1=40000000-0000-0000-0000-000000000001; X2=40000000-0000-0000-0000-000000000002; X3=40000000-0000-0000-0000-000000000003
X4=40000000-0000-0000-0000-000000000004; X5=40000000-0000-0000-0000-000000000005; X9=40000000-0000-0000-0000-000000000009
marca() { Pq -c "SELECT coalesce((SELECT coalesce(desfecho, 'em_curso') FROM public.sales_orders_exclusao_marca WHERE sales_order_id = '$1'), 'nenhuma')"; }
for x in $X1 $X2 $X3 $X4 $X5; do
  como "$F" "UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$x'" >/dev/null
done
eq E1 "authenticated marca → em curso" "$(marca "$X1")" "em_curso"
P -q -c "SET test.role = 'service_role'; UPDATE public.sales_orders SET deleted_at = now() WHERE id = '$X9'"
eq E2 "service_role (reconciliador) marca → nenhuma" "$(marca "$X9")" "nenhuma"
como "$F" "UPDATE public.sales_orders SET deleted_at = NULL WHERE id = '$X2'" >/dev/null
eq E3 "authenticated desfaz → desfeito" "$(marca "$X2")" "desfeito"
# x1/x4/x5 envelhecem 31 min; x3 fica recente. x4 é re-carimbado DEPOIS (o carimbo da marca precisa seguir).
P -q -c "UPDATE public.sales_orders_exclusao_marca SET marcado_em = now() - interval '31 minutes' WHERE sales_order_id IN ('$X1', '$X4', '$X5');
         UPDATE public.sales_orders_exclusao_marca SET marcado_em = now() - interval '31 minutes' WHERE sales_order_id = '$X9';"
como "$F" "UPDATE public.sales_orders SET deleted_at = now() + interval '1 second' WHERE id = '$X4'" >/dev/null
P -q -c "UPDATE public.sales_orders_exclusao_marca SET marcado_em = now() - interval '31 minutes' WHERE sales_order_id = '$X4'"
REC="$(Pq -c "SELECT private.sales_orders_exclusao_recuperar()")"
eq E4 "recupera x1/x4/x5, mantém a baixa do reconciliador (n · x1 · x9 oculto)" \
  "$REC·$(Pq -c "SELECT (deleted_at IS NULL) FROM public.sales_orders WHERE id = '$X1'")·$(Pq -c "SELECT (deleted_at IS NOT NULL) FROM public.sales_orders WHERE id = '$X9'")·$(marca "$X1")" "3·t·t·recuperado"
eq E5 "marca recente não é recuperada" "$(marca "$X3")·$(Pq -c "SELECT (deleted_at IS NOT NULL) FROM public.sales_orders WHERE id = '$X3'")" "em_curso·t"
eq E6 "re-carimbo segue a marca (x4 voltou)" "$(Pq -c "SELECT (deleted_at IS NULL) FROM public.sales_orders WHERE id = '$X4'")·$(marca "$X4")" "t·recuperado"
P -q -c "DELETE FROM public.sales_orders WHERE id = '$X3'" 2>"$TMPD/del.err" || true
eq E7 "DELETE físico leva a marca" "$(marca "$X3")" "nenhuma"
erro E8 "idade < 10 min" 22023 "EXCLUSAO_RECUPERAR_PARAM" "SELECT private.sales_orders_exclusao_recuperar(interval '5 minutes')"
erro E9a "app não lê a marca" 42501 "permission denied for table sales_orders_exclusao_marca" "SET ROLE authenticated; SELECT * FROM public.sales_orders_exclusao_marca"
erro E9b "app não executa a recuperação" 42501 "permission denied for function sales_orders_exclusao_recuperar" "SET ROLE authenticated; SELECT private.sales_orders_exclusao_recuperar()"
eq E10 "2ª recuperação não acha nada" "$(Pq -c "SELECT private.sales_orders_exclusao_recuperar()")" "0"
eq C1 "cron agendado" "$(Pq -c "SELECT schedule || ' ' || active FROM cron.job WHERE jobname = 'sales-orders-exclusao-recuperar'")" "*/10 * * * * true"

echo "═══ $PASS ✅ · $FAIL ❌ ═══"
[ "$FAIL" = 0 ] || exit 1
[ "$PASS" = "$TOTAL_ESPERADO" ] || { echo "❌ rodou $PASS asserts, esperado $TOTAL_ESPERADO"; exit 1; }
echo "FIM_OK"

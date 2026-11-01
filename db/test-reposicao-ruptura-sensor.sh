#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261031200000_reposicao_ruptura_sensor                      ║
# ║  trigger em order_items · prateleira diária · views semanais · RLS · cron  ║
# ║      bash db/test-reposicao-ruptura-sensor.sh > logs/t.log 2>&1; echo "exit=$?"
# ║  LOCALE=pt_BR.UTF-8 bash db/test-reposicao-ruptura-sensor.sh (2º ambiente) ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + 1 sabotagem por invariante de dinheiro, sobre CÓPIA da
# migration (o repo nunca é tocado). Asserções em ASCII, caixa fixa. Marcador positivo de fim.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5479}"
SLUG="reposicao-ruptura-sensor"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261031200000_reposicao_ruptura_sensor.sql"
# Correção do universo de pedidos (par canônico status/deleted_at): recria o trigger e a view semanal.
MIG2="$REPO_ROOT/supabase/migrations/20261031200100_reposicao_ruptura_sensor_universo.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
-- Default privilege do Supabase: o objeto NASCE aberto (senão o REVOKE da migration vira teatro).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(p_uid uuid, p_role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_uid AND role = p_role) $f$;

-- Colunas/tipos espelham a prod (medidos 2026-10-31 via psql-ro).
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, status text, order_date_kpi date,
  omie_pedido_id bigint, hash_payload text, created_at timestamptz DEFAULT now(), deleted_at timestamptz);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  omie_codigo_produto bigint, quantity numeric, hash_payload text, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now());
CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, account text, saldo numeric, synced_at timestamptz,
  UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.venda_items_history (
  empresa text, sku_codigo_omie bigint, data_emissao date, valor_total numeric, cfop text);
CREATE TABLE public.sku_estoque_atual (
  empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_disponivel numeric, ultima_sincronizacao timestamptz);

-- stub do pg_cron: grava username = current_user (postgres), como o db:aplicar faz em prod.
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active, username)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true, current_user)
  RETURNING jobid;
$f$;
-- A prod concede USAGE em auth; o stub nao (database.md §4: 42501 falso no harness).
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated;
SQL
  # Fixtures (relativas a hoje_sp, mesma expressão da migration).
  P <<'SQL'
DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  INSERT INTO public.user_roles VALUES ('11111111-1111-1111-1111-111111111111','master'),
                                       ('22222222-2222-2222-2222-222222222222','customer');
  -- inventory_position 'vendas': sku1 10, sku2 1, sku5 0 (frescos); sku3 5 (3 dias — velho); sku4/10/11 sem linha.
  INSERT INTO public.inventory_position VALUES
    (1,'vendas',10, now()), (2,'vendas',1, now()), (3,'vendas',5, now() - interval '3 days'), (5,'vendas',0, now()),
    (1,'colacor_vendas',0, now());
  -- sku_estoque_atual 'OBEN' (2ª fonte): sku4 ZERO explícito (fresco), sku10 3 (fresco), sku3 7 (velho),
  -- sku1 99 (fresco — a 1ª fonte vence), sku11 ausente; grafia 'oben' e código não-numérico ficam fora.
  INSERT INTO public.sku_estoque_atual VALUES
    ('OBEN','4',0,0, now()), ('OBEN','10',3,3, now()), ('OBEN','3',7,7, now() - interval '3 days'),
    ('OBEN','1',99,99, now()), ('oben','11',0,0, now()), ('OBEN','X11',0,0, now());
  -- Demanda OBEN 90d: sku1 100, sku2 50, sku3 10, sku4 30, sku5 20, sku10 15, sku11 5; devolução 6202 (sku6, fora);
  -- 120 dias atrás (sku7, fora); grafia 'oben' minúscula (sku8, fora); valor 0 (sku9, fora).
  INSERT INTO public.venda_items_history VALUES
    ('OBEN',1,h-60,100,'5102'), ('OBEN',2,h-30,50,'6102'), ('OBEN',3,h-10,10,'5102'),
    ('OBEN',4,h-45,30,'5102'), ('OBEN',5,h-5,20,'5102'), ('OBEN',10,h-5,15,'5102'), ('OBEN',11,h-5,5,'5102'),
    ('OBEN',6,h-20,999,'6202'), ('OBEN',7,h-120,500,'5102'), ('oben',8,h-20,500,'5102'), ('OBEN',9,h-20,0,'5102');
END
$f$;
SQL
}

falhas=0
ok() {
  local got; got="$(Pq -c "$1")"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

# Conta linhas da trilha como o uid dado, sob o role authenticated (RLS viva), numa transação descartada.
rls_count() { # $1 uid
  Pq <<SQL | tail -n 1
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '$1', true);
SELECT count(*) FROM public.reposicao_ruptura_pedido_itens;
ROLLBACK;
SQL
}

HOJE="(now() AT TIME ZONE 'America/Sao_Paulo')::date"
SEMANA="date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo'))::date"

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }
  P -f "$2" || { echo "APLICACAO FALHOU: $2"; return 99; }

  # ── Trigger: pedidos importados depois da migration ──
  P <<'SQL'
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, hash_payload) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','oben','importado', current_date, 9001, 'omie_a'),
  ('aaaaaaaa-0000-0000-0000-000000000002','oben','faturado',  current_date, 9002, 'omie_b'),
  ('aaaaaaaa-0000-0000-0000-000000000003','oben','enviado',   current_date, NULL, NULL),
  ('aaaaaaaa-0000-0000-0000-000000000004','colacor','importado', current_date, 9004, 'omie_d'),
  ('aaaaaaaa-0000-0000-0000-000000000005','oben','cancelado', current_date, 9005, 'omie_e'),
  ('aaaaaaaa-0000-0000-0000-000000000006','oben','importado', current_date, 9006, 'omie_f');
UPDATE public.sales_orders SET deleted_at = now() WHERE id = 'aaaaaaaa-0000-0000-0000-000000000006';
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, hash_payload, omie_codigo_item) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 1, 5, 'omie_a', 11),   -- saldo 10 >= 5  → atendivel
  ('aaaaaaaa-0000-0000-0000-000000000001', 2, 2, 'omie_a', 12),   -- saldo 1 < 2    → ruptura
  ('aaaaaaaa-0000-0000-0000-000000000001', 3, 1, 'omie_a', 13),   -- velha nas 2    → sem_leitura
  ('aaaaaaaa-0000-0000-0000-000000000001', 4, 1, 'omie_a', 14),   -- zero so na 2a  → ruptura
  ('aaaaaaaa-0000-0000-0000-000000000001', 5, 1, 'omie_a', NULL), -- saldo 0 < 1    → ruptura (item sem codigo)
  ('aaaaaaaa-0000-0000-0000-000000000001', 10, 2, 'omie_a', 16),  -- 3 so na 2a     → atendivel
  ('aaaaaaaa-0000-0000-0000-000000000001', 11, 1, 'omie_a', 17),  -- sem linha      → sem_leitura
  ('aaaaaaaa-0000-0000-0000-000000000002', 1, 1, 'omie_b', 21),   -- PV faturado    → indeterminado
  ('aaaaaaaa-0000-0000-0000-000000000003', 1, 1, NULL, NULL),     -- pedido do app  → nao registra
  ('aaaaaaaa-0000-0000-0000-000000000004', 1, 1, 'omie_d', 41),   -- colacor        → nao registra
  ('aaaaaaaa-0000-0000-0000-000000000005', 1, 1, 'omie_e', 51),   -- cancelado      → fora do universo, nao registra
  ('aaaaaaaa-0000-0000-0000-000000000006', 1, 1, 'omie_f', 61),   -- apagado        → fora do universo, nao registra
  ('aaaaaaaa-0000-0000-0000-000000000001', 1, 0, 'omie_a', 15),   -- quantidade 0   → pula (WARNING)
  ('aaaaaaaa-0000-0000-0000-000000000001', 1, 5, 'omie_a', 11);   -- repetido       → 1a leitura vence
SQL
  ok "SELECT count(*) FROM reposicao_ruptura_pedido_itens" "8" "so PV importado da oben no universo registra (8 itens)"
  ok "SELECT leitura||'|'||estoque_saldo||'|'||estoque_fonte FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=11" "atendivel|10|inventory_position" "saldo >= quantidade = atendivel (1a fonte vence)"
  ok "SELECT leitura||'|'||estoque_saldo FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=12" "ruptura|1" "saldo menor que quantidade = ruptura"
  ok "SELECT leitura||'|'||coalesce(estoque_saldo::text,'null')||'|'||coalesce(estoque_fonte,'null') FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=13" "sem_leitura|null|null" "leitura velha (48h) nas 2 fontes = sem_leitura"
  ok "SELECT leitura||'|'||estoque_saldo||'|'||estoque_fonte FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=14" "ruptura|0|sku_estoque_atual" "zero explicito so no sku_estoque_atual = ruptura"
  ok "SELECT leitura||'|'||estoque_saldo||'|'||estoque_fonte FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=16" "atendivel|3|sku_estoque_atual" "positivo so no sku_estoque_atual = atendivel"
  ok "SELECT leitura||'|'||coalesce(estoque_saldo::text,'null')||'|'||coalesce(estoque_lido_em::text,'null') FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=17" "sem_leitura|null|null" "sem linha de estoque = sem_leitura sem saldo fabricado"
  ok "SELECT leitura FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_produto=5 AND omie_codigo_item IS NULL" "ruptura" "saldo zero e sem codigo de item = ruptura"
  ok "SELECT leitura||'|'||status_pv FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=21" "indeterminado|faturado" "PV faturado = indeterminado"
  ok "SELECT count(*) FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=51" "0" "PV cancelado fora do universo = nao registra"
  ok "SELECT count(*) FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=61" "0" "PV apagado (deleted_at) fora do universo = nao registra"
  ok "SELECT count(*) FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=15" "0" "quantidade zero nao e leitura"
  ok "SELECT count(*) FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=11" "1" "item repetido nao regrava"
  ok "SELECT count(*) FROM order_items" "14" "o trigger nunca barra a importacao"
  ok "SELECT omie_pedido_id||'|'||data_pedido::text FROM reposicao_ruptura_pedido_itens WHERE omie_codigo_item=11" "9001|$(Pq -c "SELECT current_date::text")" "fatos do PV copiados"

  # ── View semanal de pedidos: 6 registradas fora o cancelado; 3 decididas (< 20) → fill_rate null ──
  ok "SELECT itens_registrados||'|'||itens_importados||'|'||pedidos||'|'||itens_atendiveis||'|'||itens_ruptura||'|'||itens_indeterminados||'|'||itens_sem_leitura FROM v_reposicao_ruptura_pedidos_semana WHERE semana=$SEMANA" "8|10|2|2|3|1|2" "semana: contagens por leitura"
  ok "SELECT coalesce(fill_rate_pct::text,'null') FROM v_reposicao_ruptura_pedidos_semana WHERE semana=$SEMANA" "null" "fill_rate null abaixo de 20 decididos"
  ok "SELECT cobertura_pct FROM v_reposicao_ruptura_pedidos_semana WHERE semana=$SEMANA" "80.0" "cobertura = registrados / itens importados do universo"
  # +20 itens atendíveis no PV 1 → 25 decididos, 22 atendíveis → 88.0
  P -c "INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, hash_payload, omie_codigo_item)
        SELECT 'aaaaaaaa-0000-0000-0000-000000000001', 1, 1, 'omie_a', 100 + g FROM generate_series(1, 20) g"
  ok "SELECT fill_rate_pct FROM v_reposicao_ruptura_pedidos_semana WHERE semana=$SEMANA" "88.0" "fill_rate = atendiveis / decididos"
  ok "SELECT count(*) FROM v_reposicao_ruptura_pedidos_semana WHERE semana=$SEMANA AND itens_registrados = 28" "1" "universo: 28 registrados na semana"

  # ── Prateleira: linha de base nasce com a migration (hoje) ──
  ok "SELECT skus_com_venda_90d||'|'||skus_sem_saldo||'|'||skus_sem_leitura||'|'||valor_venda_90d||'|'||valor_venda_90d_sem_saldo||'|'||valor_venda_90d_sem_leitura FROM reposicao_ruptura_prateleira_diaria WHERE dia=$HOJE" "7|2|2|230|50|15" "prateleira: skus com venda x saldo"
  ok "SELECT gravou FROM reposicao_ruptura_prateleira_registrar()" "f" "prateleira idempotente no mesmo dia"
  ok "SELECT count(*) FROM reposicao_ruptura_prateleira_diaria" "1" "prateleira: 1 linha por dia"
  ok "SELECT coalesce((SELECT count(*)::text FROM reposicao_ruptura_prateleira_registrar(($HOJE - 200))),'x')" "0" "prateleira sem venda nos 90d nao grava (ausente != zero)"
  ok "SELECT count(*) FROM reposicao_ruptura_prateleira_diaria" "1" "prateleira: dia sem demanda continua ausente"
  ok "SELECT pct_skus_sem_saldo||'|'||pct_valor_sem_saldo||'|'||pct_skus_sem_leitura||'|'||dias_lidos FROM v_reposicao_ruptura_prateleira_semana WHERE semana=date_trunc('week', $HOJE)::date" "40.0|23.3|28.6|1" "prateleira semanal: pct sobre quem tem leitura"

  # ── Segurança ──
  ok "SELECT bool_or(has_table_privilege('anon','public.'||relname,'SELECT')) FROM pg_class WHERE relname LIKE 'reposicao_ruptura_%' OR relname LIKE 'v_reposicao_ruptura_%'" "f" "anon sem select"
  ok "SELECT bool_or(has_table_privilege('authenticated','public.'||relname,'INSERT') OR has_table_privilege('service_role','public.'||relname,'INSERT')) FROM pg_class WHERE relname LIKE 'reposicao_ruptura_%' AND relkind='r'" "f" "ninguem escreve direto"
  ok "SELECT count(*) FROM pg_class WHERE relname LIKE 'v_reposicao_ruptura_%' AND NOT ('security_invoker=on' = ANY(coalesce(reloptions,'{}')))" "0" "security_invoker nas views"
  ok "SELECT has_function_privilege('authenticated','public.reposicao_ruptura_prateleira_registrar(date)','EXECUTE') OR has_function_privilege('anon','public.reposicao_ruptura_prateleira_registrar(date)','EXECUTE')" "f" "writer de prateleira owner-only"
  # RLS: master lê tudo; customer autenticado vê 0 linhas (policy), não erro. Mesmo role, mesma GUC da prod.
  local got_master got_customer
  got_master="$(rls_count '11111111-1111-1111-1111-111111111111')"
  if [ "$got_master" != "28" ]; then echo "FALHOU: master le a trilha | esperado=[28] obtido=[$got_master]"; falhas=$((falhas+1)); fi
  got_customer="$(rls_count '22222222-2222-2222-2222-222222222222')"
  if [ "$got_customer" != "0" ]; then echo "FALHOU: customer nao le a trilha | esperado=[0] obtido=[$got_customer]"; falhas=$((falhas+1)); fi
  ok "SELECT username||'|'||schedule||'|'||active FROM cron.job WHERE jobname='reposicao-ruptura-prateleira-diario'" "postgres|10 10 * * *|true" "cron diario do owner"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"; cp "$MIG2" "$TMPD/mig2.sql"
if ! suite "$TMPD/mig.sql" "$TMPD/mig2.sql"; then echo "CONTROLE VERMELHO — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — cada sabotagem TEM de ficar vermelha PELA asserção esperada: a cópia aplica (rc=0)
#    e a saída contém "FALHOU: <rótulo>" (ASCII, caixa fixa). Vermelho por erro de sintaxe reprova.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo da asserção esperada — o sed vale para as DUAS migrations
  sed "$2" "$MIG" > "$TMPD/sab.sql"; sed "$2" "$MIG2" > "$TMPD/sab2.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql" && cmp -s "$MIG2" "$TMPD/sab2.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local out rc=0
  out="$(suite "$TMPD/sab.sql" "$TMPD/sab2.sql" 2>&1)" || rc=$?
  if [ "$rc" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  # rc=99 só vale como vermelho se foi a POSTCONDIÇÃO da migration que barrou (rótulo "Pn FALHOU");
  # qualquer outro erro de aplicação não é prova.
  if [ "$rc" -eq 99 ] && ! grep -qF "$3" <<<"$out"; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; exit 1; fi
  if ! grep -qF "$3" <<<"$out"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava $3)"; exit 1
  fi
  echo "sabotagem vermelha ok: $1"
}
sabotar "leitura velha da 1a fonte vira decisao" "s/     AND ip.synced_at IS NOT NULL AND ip.synced_at >= p_corte//" "FALHOU: leitura velha (48h) nas 2 fontes = sem_leitura |"
sabotar "leitura velha da 2a fonte vira decisao" "s/     AND s.ultima_sincronizacao IS NOT NULL AND s.ultima_sincronizacao >= p_corte//" "FALHOU: leitura velha (48h) nas 2 fontes = sem_leitura |"
sabotar "2a fonte ignorada" "s/   WHERE s.empresa = 'OBEN' AND/   WHERE false AND/" "FALHOU: zero explicito so no sku_estoque_atual = ruptura |"
sabotar "2a fonte vence a 1a" "s/  ORDER BY 3 ASC  -- 'inventory_position' < 'sku_estoque_atual'/  ORDER BY 3 DESC/" "FALHOU: saldo >= quantidade = atendivel (1a fonte vence) |"
sabotar "saldo > 0 em vez de >= quantidade" "s/ELSIF v_ip.saldo >= NEW.quantity THEN/ELSIF v_ip.saldo > 0 THEN/" "FALHOU: saldo menor que quantidade = ruptura |"
sabotar "PV faturado decidido" "s/IF v_so.status IN ('faturado', 'cancelado') THEN/IF false THEN/" "FALHOU: PV faturado = indeterminado |"
# Pedido do app: DUAS camadas (WHEN do trigger + checagem do hash na função). Tirar só uma fica verde pela
# outra (defesa em profundidade real); a prova tira as duas e exige o furo. A camada de CONTA é uma só.
sabotar "pedido do app registrado (2 camadas)" "s/  WHEN (NEW.hash_payload IS NOT NULL AND NEW.hash_payload LIKE 'omie\\\\_%')//; s/OR v_so.hash_payload IS NULL OR v_so.hash_payload NOT LIKE 'omie\\\\_%' THEN/THEN/" "FALHOU: so PV importado da oben no universo registra (8 itens) |"
sabotar "pedido de outra empresa registrado" "s/OR v_so.account IS DISTINCT FROM 'oben'//" "FALHOU: so PV importado da oben no universo registra (8 itens) |"
# Universo de pedidos (20261031200100): o par status/deleted_at na leitura do trigger e no denominador da view.
# Duas camadas cada: o par E a postcondição que o vigia (P1/P2) — tirar só o par fica vermelho pela postcondição.
# shellcheck disable=SC2016  # o `$fn$` é o delimitador literal do corpo da função, não expansão
FN='/FUNCTION public.reposicao_ruptura_registrar_item/,/^\$fn\$;/'
VW='/VIEW public.v_reposicao_ruptura_pedidos_semana/,/LEFT JOIN imp USING/'
sabotar "PV cancelado registrado (2 camadas)" "$FN s/^     AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')\$//; s/IF v_fn NOT LIKE '%so.deleted_at IS NULL%' OR v_fn NOT LIKE/IF false AND v_fn NOT LIKE/" "FALHOU: so PV importado da oben no universo registra (8 itens) |"
sabotar "PV apagado registrado (2 camadas)" "$FN s/^     AND so.deleted_at IS NULL;\$/;/; s/IF v_fn NOT LIKE '%so.deleted_at IS NULL%' OR v_fn NOT LIKE/IF false AND v_fn NOT LIKE/" "FALHOU: so PV importado da oben no universo registra (8 itens) |"
sabotar "trigger sem o par: so a postcondicao" "$FN s/^     AND so.deleted_at IS NULL;\$/;/" "P1 FALHOU"
sabotar "denominador fora do universo (2 camadas)" "$VW s/^     AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')\$//; $VW s/^     AND so.deleted_at IS NULL\$//; s/IF v_vw NOT ILIKE '%so.deleted_at IS NULL%' OR/IF false AND/" "FALHOU: semana: contagens por leitura |"
sabotar "view sem o par: so a postcondicao" "$VW s/^     AND so.deleted_at IS NULL\$//" "P2 FALHOU"
# Quantidade zero: guard no WRITER + CHECK na TABELA (money-path: "o guard mora no writer; a invariante na
# tabela"). Tirar só o guard fica verde pelo CHECK (o fail-open engole o 23514); a prova tira os dois.
sabotar "quantidade zero como leitura (2 camadas)" "s/OR NEW.quantity <= 0 OR NEW.quantity >= 1000000 THEN/OR NEW.quantity >= 1000000 THEN/; s/CHECK (quantidade > 0 AND quantidade < 1000000)/CHECK (quantidade < 1000000)/" "FALHOU: quantidade zero nao e leitura |"
sabotar "fill_rate com 1 decidido" "s/WHEN s.itens_atendiveis + s.itens_ruptura >= 20/WHEN s.itens_atendiveis + s.itens_ruptura >= 1/" "FALHOU: fill_rate null abaixo de 20 decididos |"
sabotar "prateleira: saldo < 0" "s/WHERE e.saldo IS NOT NULL AND e.saldo <= 0))::integer/WHERE e.saldo IS NOT NULL AND e.saldo < 0))::integer/" "FALHOU: prateleira: skus com venda x saldo |"
sabotar "prateleira: zero da 2a fonte ignorado" "s/     AND s.estoque_fisico IS NOT NULL AND s.estoque_fisico <> 'NaN'/     AND s.estoque_fisico > 0/" "FALHOU: prateleira: skus com venda x saldo |"
sabotar "prateleira: devolucao na demanda" "s/AND coalesce(h.cfop, '') NOT IN ('1202', '2202', '5202', '6202')//" "FALHOU: prateleira: skus com venda x saldo |"
sabotar "prateleira: grafia oben minuscula" "s/WHERE h.empresa = 'OBEN'/WHERE upper(h.empresa) = 'OBEN'/" "FALHOU: prateleira: skus com venda x saldo |"
sabotar "prateleira: regrava no mesmo dia" "s/ON CONFLICT (empresa, dia) DO NOTHING;/ON CONFLICT (empresa, dia) DO UPDATE SET registrado_em = clock_timestamp();/" "FALHOU: prateleira idempotente no mesmo dia |"
sabotar "views sem security_invoker" "s/WITH (security_invoker=on) AS/AS/" "P3 FALHOU"
sabotar "writer aberto a authenticated" "s/REVOKE ALL ON FUNCTION public.reposicao_ruptura_prateleira_registrar(date) FROM PUBLIC, anon, authenticated, service_role;/REVOKE ALL ON FUNCTION public.reposicao_ruptura_prateleira_registrar(date) FROM anon;/" "P6 FALHOU"
sabotar "tabela aberta a anon" "s/  FROM PUBLIC, anon, authenticated, service_role;/  FROM PUBLIC, authenticated, service_role;/" "P2 FALHOU"
sabotar "policy sem has_role" "s/USING ((SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))/USING (true OR (SELECT public.has_role((SELECT auth.uid()), 'master'::public.app_role))/" "FALHOU: customer nao le a trilha |"

echo "PROVA-REPOSICAO-RUPTURA-SENSOR-OK"

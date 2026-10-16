#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261016120000_raio_x_estoque_parado (Task 2, money-path)    ║
# ║  raio_x_decidir / raio_x_contar / raio_x_classificar                       ║
# ║      bash db/test-raio-x-decidir.sh > logs/rx2.log 2>&1; echo "exit=$?"     ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-raio-x-decidir.sh  (2o ambiente)           ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocacao + sabotagens sobre COPIA da migration (o repo nunca e tocado).
# Asserções em ASCII, caixa fixa, sem -i. SQLSTATE capturada exata (re-lança o resto).
#
# Preparo: o mesmo esqueleto de db/test-raio-x-fatos.sh (roles, default privileges do Supabase,
# private.cap_custo_ler, has_role), com fixtures proprias desta prova. sku_parametros.empresa = 'OBEN'
# (maiusculo, como em prod). lc_messages=C no servidor.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5477}"
SLUG="raio-x-decidir"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_STAFF="22222222-2222-2222-2222-222222222222"  # employee SEM commercial_role (nao le custo)
U_MASTER="11111111-1111-1111-1111-111111111111"
U_CUST="44444444-4444-4444-4444-444444444444"
U_EST="55555555-5555-5555-5555-555555555555"    # employee COM commercial_role estrategico

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE FUNCTION public.has_role(_user_id uuid, _role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id AND r.role = _role) $$;
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master')
      OR (
        public.has_role(_uid, 'employee')
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                     WHERE cr.user_id = _uid AND cr.commercial_role IN ('estrategico','super_admin'))
      )
    ), false);
$$;
REVOKE ALL ON FUNCTION private.cap_custo_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_custo_ler(uuid) TO authenticated;

-- Tabelas-fonte que a migration referencia (fatos da Task 1 compila contra elas).
CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (
  omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc text, tipo_reposicao text,
  habilitado_reposicao_automatica boolean);
CREATE TABLE public.v_venda_items_history_efetivo (
  empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.warehouses (id uuid PRIMARY KEY, code text);
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY, razao_social_emitente text, data_emissao date, warehouse_id uuid);
CREATE TABLE public.nfe_recebimento_itens (id uuid DEFAULT gen_random_uuid(), nfe_recebimento_id uuid, produto_omie_id bigint);

-- Captura SO a SQLSTATE esperada (o resto propaga e derruba a prova). Roda como o chamador.
CREATE FUNCTION public.t_lanca(q text, st text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = st THEN RETURN SQLSTATE || '|' || SQLERRM; END IF;
  RAISE;
END $$;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('44444444-4444-4444-4444-444444444444','customer'),
  ('55555555-5555-5555-5555-555555555555','employee');
INSERT INTO public.commercial_roles VALUES ('55555555-5555-5555-5555-555555555555','estrategico');

INSERT INTO public.inventory_position VALUES
  (1, 5, 10, 10, 'oben', now() - interval '3 days'),
  (1, 9, 12, 12, 'oben', now() - interval '1 hour'),   -- a mais recente vence: foto 9 x 12 = 108
  (1, 99, 50, 50, 'vendas', now()),                    -- conta vendas: nunca lida
  (2, 4, 0, 0, 'oben', now()),                         -- cmc 0: foto_cmc/foto_valor NULL
  (3, 7, 7, 7, 'vendas', now()),                       -- sem linha oben: sem foto
  (4, 2, 3, 3, 'oben', now()),
  (5, 1, 1, 1, 'oben', now()),                         -- sem sku_parametros
  (6, 1, 1, 1, 'oben', now()),                         -- motor ja descontinuado/false
  (7, 3, 2, 2, 'colacor_vendas', now()),               -- colacor: foto 3 x 2 = 6
  (7, 50, 50, 50, 'oben', now()),
  (11, 5, 2, 2, 'oben', now() - interval '1 hour'),    -- corrida da 1a foto (R14)
  (12, 5, 1, 1, 'oben', now() - interval '2 days'),
  (12, NULL, 1, 1, 'oben', now()),                     -- linha mais recente com saldo NULL: sem foto
  (13, 8, 8, 8, 'oben', now());                        -- ja tem foto (fase A): nao pode mover

INSERT INTO public.sku_parametros VALUES
  ('OBEN', 1, NULL, 'A', 'automatico', true),
  ('OBEN', 4, NULL, 'B', 'automatico', true),
  ('OBEN', 6, NULL, 'C', 'descontinuado', false),
  ('OBEN', 7, NULL, 'A', 'automatico', true);          -- codigo 7 da OBEN: a colacor NAO pode tocar
SQL
}

# Sessão simulada: $1 = uuid ('' = sem claims), $2 = SQL (uma consulta). Roda como authenticated.
sess() {
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    if [ -n "$1" ]; then
      echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$1\",\"role\":\"authenticated\"}', true) AS c \\gset"
    fi
    echo "$2;"
    echo "COMMIT;"
  } | Pq
}

falhas=0
oks() { # $1 uuid, $2 SQL, $3 esperado, $4 rotulo. Erro de psql vira valor distinto (nunca mascara).
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}
# Chamada que precisa dar certo (como U_EST); o resultado e lido depois como postgres.
run() { # $1 SQL, $2 rotulo
  local got; got="$(sess "$U_EST" "$1" 2>&1)" || { echo "FALHOU: $2 | ERRO-PSQL: $got"; falhas=$((falhas+1)); }
}
# raio_x_decidir(empresa, sku, destino, categoria, obs, fornecedor, credito, tirar, restaurar)
dec() { echo "SELECT destino FROM public.raio_x_decidir($1)"; }
lanca() { # $1 args de decidir (aspas simples dobradas), $2 SQLSTATE
  echo "SELECT public.t_lanca('SELECT * FROM public.raio_x_decidir($1)', '$2')"
}
SP() { echo "SELECT tipo_reposicao || '|' || habilitado_reposicao_automatica FROM public.sku_parametros WHERE empresa = 'OBEN' AND sku_codigo_omie = $1"; }
FOTO() { echo "SELECT coalesce(foto_saldo::text,'N') || '|' || coalesce(foto_cmc::text,'N') || '|' || coalesce(foto_valor::text,'N') || '|' || coalesce(foto_categoria,'N') || '|' || (foto_em IS NOT NULL) FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }
COL() { echo "SELECT $3 FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }

# Corrida determinista: A via FIFO (transacao aberta ate mandarmos COMMIT), B em background; sincronizacao por
# pg_stat_activity (A 'idle in transaction', B esperando Lock). Nada de sleep fixo como prova.
espera() { # $1 SQL que deve devolver 1, $2 rotulo
  local _
  for _ in $(seq 1 200); do
    [ "$(Pq -c "$1" 2>/dev/null)" = "1" ] && return 0
    sleep 0.05
  done
  echo "FALHOU: corrida timeout $2 |"; falhas=$((falhas+1)); return 1
}
corrida() {
  local fifo="$TMPD/a.fifo" pa pb
  rm -f "$fifo"; mkfifo "$fifo"
  PGAPPNAME=rx_a "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -tA \
    < "$fifo" > "$TMPD/a.out" 2>&1 &
  pa=$!
  exec 3>"$fifo"
  {
    echo "BEGIN;"
    echo "SET LOCAL ROLE authenticated;"
    echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$U_EST\",\"role\":\"authenticated\"}', true);"
    echo "SELECT destino FROM public.raio_x_decidir('oben', 11, 'trocar', 'mercadoria', NULL, NULL, NULL, false, false);"
  } >&3
  if espera "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'rx_a' AND state = 'idle in transaction'" "A"; then
    P -c "INSERT INTO public.inventory_position VALUES (11, 1, 99, 99, 'oben', now())"
    ( export PGAPPNAME=rx_b
      sess "$U_EST" "SELECT destino FROM public.raio_x_decidir('oben', 11, 'liquidar', 'uso_consumo', NULL, NULL, NULL, false, false)" ) \
      > "$TMPD/b.out" 2>&1 &
    pb=$!
    espera "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'rx_b' AND wait_event_type = 'Lock'" "B" || true
  fi
  echo "COMMIT;" >&3
  exec 3>&-
  wait "$pa" || { echo "FALHOU: corrida sessao A | $(cat "$TMPD/a.out")"; falhas=$((falhas+1)); }
  if [ -n "${pb:-}" ]; then
    wait "$pb" || { echo "FALHOU: corrida sessao B | $(cat "$TMPD/b.out")"; falhas=$((falhas+1)); }
  fi
}

SIG_D="public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)"
SIG_C="public.raio_x_contar(text,bigint,numeric)"
SIG_K="public.raio_x_classificar(text,bigint,text,text)"

suite() {
  falhas=0
  preparar_banco
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }

  # ---------- (a) foto congelada + decidido_em muda com o destino ----------
  run "$(dec "'oben', 1, 'trocar', 'mercadoria', NULL, NULL, NULL, false, false")" "a 1a decisao"
  okp "$(FOTO oben 1)" "9|12|108|mercadoria|true" "a foto = saldo x cmc da linha mais recente da conta oben"
  okp "$(COL oben 1 "decidido_por::text || '|' || destino")" "$U_EST|trocar" "a decidido_por e destino"
  T1="$(Pq -c "SELECT decidido_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  F1="$(Pq -c "SELECT foto_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  P -c "INSERT INTO public.inventory_position VALUES (1, 1, 99, 99, 'oben', now())"
  run "$(dec "'oben', 1, 'venda_dirigida', 'uso_consumo', NULL, NULL, NULL, false, false")" "a 2a decisao"
  okp "$(FOTO oben 1)" "9|12|108|mercadoria|true" "a 2a decisao nao refaz a foto"
  okp "$(COL oben 1 "(foto_em = '$F1'::timestamptz) || '|' || (decidido_em > '$T1'::timestamptz) || '|' || destino")" "true|true|venda_dirigida" "a foto_em igual e decidido_em novo"

  # ---------- (b) mesmo destino: decidido_em inalterado, campos livres sobrescritos ----------
  T2="$(Pq -c "SELECT decidido_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  A2="$(Pq -c "SELECT atualizado_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  run "$(dec "'oben', 1, 'venda_dirigida', 'uso_consumo', 'nota', 'FORN X', 12.5, false, false")" "b mesmo destino"
  okp "$(COL oben 1 "(decidido_em = '$T2'::timestamptz) || '|' || (atualizado_em > '$A2'::timestamptz) || '|' || observacao || '|' || fornecedor_informado || '|' || credito_troca")" "true|true|nota|FORN X|12.5" "b mesmo destino nao muda decidido_em"

  # destino NULL (desfeita) zera quem/quando; foto fica
  run "$(dec "'oben', 1, NULL, NULL, NULL, NULL, NULL, false, false")" "b desfazer"
  okp "$(COL oben 1 "(decidido_por IS NULL AND decidido_em IS NULL AND destino IS NULL)::text")" "true" "b destino null zera decidido_por e decidido_em"
  okp "$(FOTO oben 1)" "9|12|108|mercadoria|true" "b desfazer mantem a foto"

  # ---------- R3: foto sem estoque / cmc 0 / nova tentativa ----------
  run "$(dec "'oben', 2, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "r3 sku2"
  okp "$(FOTO oben 2)" "4|N|N|mercadoria|true" "r3 cmc 0 grava saldo e deixa cmc e valor NULL"
  run "$(dec "'oben', 3, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "r3 sku3"
  okp "$(FOTO oben 3)" "N|N|N|N|false" "r3 sem linha oben (so vendas) foto toda NULL"
  P -c "INSERT INTO public.inventory_position VALUES (3, 5, 2, 2, 'oben', now())"
  run "$(dec "'oben', 3, 'trocar', 'uso_consumo', NULL, NULL, NULL, false, false")" "r3 sku3 de novo"
  okp "$(FOTO oben 3)" "5|2|10|uso_consumo|true" "r3 nova decisao tira a foto quando o estoque aparece"
  run "$(dec "'colacor', 7, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "r3 colacor sku7"
  okp "$(FOTO colacor 7)" "3|2|6|mercadoria|true" "r3 colacor fotografa colacor_vendas"

  # ---------- (c) liquidar + tirar ----------
  run "$(dec "'oben', 4, 'liquidar', 'mercadoria', NULL, NULL, NULL, true, false")" "c liquidar tirar"
  okp "$(SP 4)" "descontinuado|false" "c liquidar tira do motor (descontinuado/false)"
  okp "$(COL oben 4 "tirou_do_motor || '|' || (motor_antes = '{\"tipo_reposicao\":\"automatico\",\"habilitado\":true}'::jsonb)")" "true|true" "c motor_antes guarda o anterior"

  # ---------- (h) mudar destino depois de tirar nao religa ----------
  run "$(dec "'oben', 4, 'estrategico', 'mercadoria', NULL, NULL, NULL, false, false")" "h estrategico"
  okp "$(SP 4)" "descontinuado|false" "h estrategico depois de tirar mantem descontinuado"
  okp "$(COL oben 4 "tirou_do_motor || '|' || (motor_antes IS NOT NULL)")" "true|true" "h tirou_do_motor e motor_antes mantidos"

  # ---------- (d) manter_suspender_recompra + tirar; depois liquidar mantem o motor_antes original ----------
  run "$(dec "'oben', 1, 'manter_suspender_recompra', 'mercadoria', NULL, NULL, NULL, true, false")" "d manter tirar"
  okp "$(SP 1)" "sob_encomenda|false" "d manter_suspender_recompra vira sob_encomenda/false"
  run "$(dec "'oben', 1, 'liquidar', 'mercadoria', NULL, NULL, NULL, true, false")" "d liquidar depois"
  okp "$(SP 1)" "descontinuado|false" "d liquidar depois vira descontinuado"
  okp "$(COL oben 1 "motor_antes->>'tipo_reposicao' || '|' || (motor_antes->>'habilitado')")" "automatico|true" "d motor_antes so e gravado se ainda null"

  # ---------- (g) restaurar ----------
  run "$(dec "'oben', 4, 'estrategico', 'mercadoria', NULL, NULL, NULL, false, true")" "g restaurar 4"
  okp "$(SP 4)" "automatico|true" "g restaurar repoe o estado inicial"
  okp "$(COL oben 4 "(motor_antes IS NULL) || '|' || tirou_do_motor || '|' || destino")" "true|false|estrategico" "g restaurar zera motor_antes e tirou_do_motor"
  run "$(dec "'oben', 1, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, true")" "g restaurar 1"
  okp "$(SP 1)" "automatico|true" "g restaurar sku1 volta ao original (nao ao intermediario)"

  # ---------- motor ja no alvo: nao escreve ----------
  run "$(dec "'oben', 6, 'liquidar', 'mercadoria', NULL, NULL, NULL, true, false")" "idem sku6"
  okp "$(SP 6)" "descontinuado|false" "idem motor ja no alvo fica igual"
  okp "$(COL oben 6 "tirou_do_motor || '|' || (motor_antes IS NULL)")" "false|true" "idem motor ja no alvo nao marca tirou nem motor_antes"

  # ---------- (e) fail-closed RX001 ----------
  oks "$U_EST" "$(lanca "''oben'', 5, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, true, false" RX001)" "RX001|raio_x: sku sem sku_parametros (oben/5)" "e sku sem sku_parametros RX001"
  okp "SELECT count(*) FROM public.raio_x_decisao WHERE sku_codigo_omie = 5" "0" "e nada gravado pela metade"
  oks "$U_EST" "$(lanca "''colacor'', 9, ''trocar'', ''mercadoria'', NULL, NULL, NULL, true, false" RX001)" "RX001|raio_x: sku sem sku_parametros (colacor/9)" "e colacor tirar cai no RX001"
  okp "SELECT count(*) FROM public.raio_x_decisao WHERE sku_codigo_omie = 9" "0" "e colacor nada gravado"
  oks "$U_EST" "$(lanca "''colacor'', 7, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, true, false" RX001)" "RX001|raio_x: sku sem sku_parametros (colacor/7)" "e colacor sku7 RX001 mesmo com OBEN 7 no motor"
  okp "$(SP 7)" "automatico|true" "e colacor nao toca o sku_parametros da OBEN"
  okp "$(COL colacor 7 "destino || '|' || tirou_do_motor")" "liquidar|false" "e colacor linha anterior intacta"

  # ---------- (f) validacoes 22023 ----------
  oks "$U_EST" "$(lanca "''oben'', 4, ''venda_dirigida'', ''mercadoria'', NULL, NULL, NULL, true, false" 22023)" "22023|raio_x: tirar do motor exige destino trocar, liquidar ou manter_suspender_recompra" "f venda_dirigida + tirar 22023"
  okp "$(SP 4)" "automatico|true" "f venda_dirigida + tirar nao mexe no motor"
  okp "$(COL oben 4 "destino")" "estrategico" "f venda_dirigida + tirar nao grava a decisao"
  oks "$U_EST" "$(lanca "''oben'', 4, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, true, true" 22023)" "22023|raio_x: tirar e restaurar na mesma chamada" "f tirar e restaurar juntos 22023"
  oks "$U_EST" "$(lanca "''oben'', 6, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, true" 22023)" "22023|raio_x: nada a restaurar (oben/6)" "f restaurar sem motor_antes 22023"
  oks "$U_EST" "$(lanca "''oben'', 8, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, true" 22023)" "22023|raio_x: nada a restaurar (oben/8)" "f restaurar sem linha 22023"
  oks "$U_EST" "$(lanca "''oben'', 4, ''xpto'', ''mercadoria'', NULL, NULL, NULL, false, false" 22023)" "22023|raio_x: destino invalido: xpto" "f destino invalido 22023"
  oks "$U_EST" "$(lanca "''oben'', 4, ''liquidar'', ''xpto'', NULL, NULL, NULL, false, false" 22023)" "22023|raio_x: categoria invalida: xpto" "f categoria invalida 22023"
  oks "$U_EST" "$(lanca "''colacor_sc'', 4, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false" 22023)" "22023|raio_x: empresa invalida: colacor_sc" "f empresa invalida decidir 22023"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_contar(''vendas'', 4, 1)', '22023')" "22023|raio_x: empresa invalida: vendas" "f empresa invalida contar 22023"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_classificar(NULL, 4, ''uso_consumo'', ''m'')', '22023')" "22023|raio_x: empresa invalida: <null>" "f empresa invalida classificar 22023"

  # ---------- (i) gate cap_custo_ler + ACL ----------
  for u in "$U_CUST" "$U_STAFF" ""; do
    oks "$u" "$(lanca "''oben'', 4, ''liquidar'', ''mercadoria'', NULL, NULL, NULL, false, false" 42501)" "42501|RAIO_X_SO_CUSTO" "i decidir barrado 42501 [$u]"
    oks "$u" "SELECT public.t_lanca('SELECT * FROM public.raio_x_contar(''oben'', 4, 1)', '42501')" "42501|RAIO_X_SO_CUSTO" "i contar barrado 42501 [$u]"
    oks "$u" "SELECT public.t_lanca('SELECT * FROM public.raio_x_classificar(''oben'', 4, ''uso_consumo'', ''m'')', '42501')" "42501|RAIO_X_SO_CUSTO" "i classificar barrado 42501 [$u]"
  done
  okp "$(COL oben 4 "destino")" "estrategico" "i barrados nao gravaram"
  oks "$U_MASTER" "$(dec "'oben', 4, 'estrategico', 'mercadoria', NULL, NULL, NULL, false, false")" "estrategico" "i master passa"
  for s in "$SIG_D" "$SIG_C" "$SIG_K"; do
    okp "SELECT has_function_privilege('anon','$s','EXECUTE')" "f" "i anon sem EXECUTE $s"
    okp "SELECT has_function_privilege('public','$s','EXECUTE')" "f" "i public sem EXECUTE $s"
    okp "SELECT has_function_privilege('authenticated','$s','EXECUTE')" "t" "i authenticated com EXECUTE $s"
    okp "SELECT p.prosecdef FROM pg_proc p WHERE p.oid = '$s'::regprocedure" "t" "i SECURITY DEFINER $s"
  done

  # ---------- (j) classificar ----------
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_classificar(''oben'', 4, ''uso_consumo'', ''  '')', '23514')" \
    '23514|new row for relation "raio_x_classificacao_manual" violates check constraint "raio_x_classificacao_manual_motivo_check"' "j motivo em branco erro de CHECK"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_classificar(''oben'', 4, ''xpto'', ''m'')', '22023')" "22023|raio_x: categoria invalida: xpto" "j categoria invalida 22023"
  oks "$U_EST" "SELECT categoria || '|' || motivo || '|' || marcado_por FROM public.raio_x_classificar('oben', 4, 'uso_consumo', 'cola de bancada')" "uso_consumo|cola de bancada|$U_EST" "j classificar grava"
  oks "$U_EST" "SELECT categoria || '|' || motivo FROM public.raio_x_classificar('oben', 4, 'nao_mercadoria', 'brinde')" "nao_mercadoria|brinde" "j reclassificar sobrescreve"
  oks "$U_EST" "SELECT (public.raio_x_classificar('oben', 4, NULL, NULL) IS NULL)::text" "true" "j categoria null devolve NULL"
  okp "SELECT count(*) FROM public.raio_x_classificacao_manual WHERE sku_codigo_omie = 4" "0" "j categoria null apaga a marcacao"

  # ---------- Fix pos-Codex ----------
  # R14 (deterministico, sem concorrencia): linha pre-existente com foto_em preenchida -> nenhum campo de foto se move
  P -c "INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em, origem) VALUES ('oben', 13, 1, 1, 1, 'nao_mercadoria', '2026-01-01 00:00:00+00', 'artifact_fase_a')"
  run "$(dec "'oben', 13, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "r14 sku13 com foto previa"
  okp "$(COL oben 13 "foto_saldo || '|' || foto_cmc || '|' || foto_valor || '|' || foto_categoria || '|' || (foto_em = '2026-01-01 00:00:00+00'::timestamptz) || '|' || destino")" "1|1|1|nao_mercadoria|true|liquidar" "r14 foto previa nao se move"
  # R14 (corrida real, 2 sessoes): A decide e segura a transacao; o estoque muda; B decide o mesmo SKU e
  # fica esperando o lock; A commita; B nao pode refazer a foto com o estoque novo.
  corrida
  okp "$(FOTO oben 11)" "5|2|10|mercadoria|true" "r14 corrida: a 2a sessao nao refaz a foto"
  okp "$(COL oben 11 "destino")" "liquidar" "r14 corrida: a 2a sessao gravou o destino"
  # R13: tirar sem sku_parametros -> RX001 (o SELECT FOR UPDATE ja barra; ver tambem (e))
  # minors
  oks "$U_EST" "$(lanca "''oben'', 4, ''liquidar'', NULL, NULL, NULL, NULL, false, false" 22023)" "22023|raio_x: categoria obrigatoria com destino" "m destino com categoria NULL 22023"
  oks "$U_EST" "$(lanca "''oben'', 4, ''trocar'', ''mercadoria'', NULL, NULL, -1, false, false" 22023)" "22023|raio_x: credito_troca negativo: -1" "m credito_troca negativo 22023"
  okp "$(COL oben 4 "destino || '|' || coalesce(credito_troca::text, 'N')")" "estrategico|N" "m validacoes nao gravaram"
  run "$(dec "'oben', 12, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "m sku12 saldo NULL"
  okp "$(FOTO oben 12)" "N|N|N|N|false" "m saldo NULL na linha mais recente nao congela foto"

  # ---------- (k) contar ----------
  oks "$U_EST" "SELECT qtd_contada || '|' || contado_por || '|' || (contado_em IS NOT NULL) || '|' || (destino IS NULL) || '|' || (foto_em IS NULL) FROM public.raio_x_contar('oben', 10, 5)" "5|$U_EST|true|true|true" "k contar sem linha cria com destino NULL e sem foto"
  oks "$U_EST" "SELECT qtd_contada || '|' || destino FROM public.raio_x_contar('oben', 4, 3)" "3|estrategico" "k contar preserva a decisao"
  oks "$U_EST" "SELECT (qtd_contada IS NULL AND contado_por IS NULL AND contado_em IS NULL)::text FROM public.raio_x_contar('oben', 4, NULL)" "true" "k contar null limpa"
  oks "$U_EST" "SELECT public.t_lanca('SELECT * FROM public.raio_x_contar(''oben'', 4, -1)', '22023')" "22023|raio_x: quantidade negativa: -1" "k contar negativo 22023"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK (locale=$LOC)"

# 2) FALSIFICAÇÃO — uma sabotagem por vez sobre CÓPIA, vermelha PELA asserção esperada.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo esperado (FALHOU: <rotulo> |)
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -eq 99 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
sabotar "1 IS DISTINCT FROM vira true" \
  "s/v_mudou := (v_old.destino IS DISTINCT FROM p_destino);/v_mudou := true;/" \
  "b mesmo destino nao muda decidido_em"
sabotar "2 sem os dois RAISE RX001 do tirar (SELECT vazio e n=0)" \
  "s/IF NOT v_sp_achou THEN/IF false THEN/;s/IF v_n_tirar = 0 THEN/IF false THEN/" \
  "e sku sem sku_parametros RX001"
sabotar "3 motor (leitura e UPDATE) em blocos que engolem erro" \
  "s/-- \[motor:inicio\]/BEGIN/;s/-- \[motor:fim\]/EXCEPTION WHEN OTHERS THEN NULL; END;/;s/-- \[motor-sel:inicio\]/BEGIN/;s/-- \[motor-sel:fim\]/EXCEPTION WHEN OTHERS THEN NULL; END;/" \
  "e nada gravado pela metade"
sabotar "4 sem as duas guardas foto_em is null (derivacao e SET)" \
  "s/AND v_old.foto_em IS NULL/AND true/;s/AND r.foto_em IS NULL THEN/THEN/" \
  "a 2a decisao nao refaz a foto"
sabotar "5 sem gate cap_custo_ler no decidir" \
  "/FUNCTION public.raio_x_decidir/,/END IF;/{s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF false THEN/;}" \
  "i decidir barrado 42501 [$U_CUST]"
sabotar "6 gate volta para has_role(employee) no contar" \
  "/FUNCTION public.raio_x_contar/,/END IF;/{s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN/;}" \
  "i contar barrado 42501 [$U_STAFF]"
sabotar "7 sem 22023 de tirar com destino errado" \
  "s/IF v_tirar AND v_alvo IS NULL THEN/IF false THEN/" \
  "f venda_dirigida + tirar 22023"
sabotar "8 motor sem filtro de empresa" \
  "s/WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku/WHERE sp.sku_codigo_omie = p_sku/g" \
  "e colacor nao toca o sku_parametros da OBEN"
sabotar "9 foto le a conta vendas" \
  "s/WHEN 'oben'    THEN v_est := 'oben';    v_sp_emp := 'OBEN';/WHEN 'oben'    THEN v_est := 'vendas';  v_sp_emp := 'OBEN';/" \
  "a foto = saldo x cmc da linha mais recente da conta oben"
sabotar "10 foto_cmc sem guarda cmc > 0" \
  "s/v_cmc := CASE WHEN v_ip_cmc > 0 THEN v_ip_cmc END;/v_cmc := v_ip_cmc;/" \
  "r3 cmc 0 grava saldo e deixa cmc e valor NULL"
sabotar "11 motor_antes sobrescrito a cada tirada" \
  "s/motor_antes    = coalesce(r.motor_antes, EXCLUDED.motor_antes)/motor_antes    = EXCLUDED.motor_antes/" \
  "d motor_antes so e gravado se ainda null"

sabotar "13 sem linha-base travada e sem guarda no SET (corrida da 1a foto)" \
  "/VALUES (p_empresa, p_sku)\$/,/DO NOTHING;/d;s/AND r.foto_em IS NULL THEN/THEN/" \
  "r14 corrida: a 2a sessao nao refaz a foto"
sabotar "14 sem as duas guardas (pre-insercao com foto)" \
  "s/AND v_old.foto_em IS NULL/AND true/;s/AND r.foto_em IS NULL THEN/THEN/" \
  "r14 foto previa nao se move"
sabotar "15 sem categoria obrigatoria" \
  "s/IF p_destino IS NOT NULL AND p_categoria IS NULL THEN/IF false THEN/" \
  "m destino com categoria NULL 22023"
sabotar "16 sem credito_troca negativo" \
  "s/IF p_credito_troca < 0 THEN/IF false THEN/" \
  "m credito_troca negativo 22023"
sabotar "17 saldo NULL congela foto" \
  "s/IF FOUND AND v_ip_saldo IS NOT NULL THEN/IF FOUND THEN/" \
  "m saldo NULL na linha mais recente nao congela foto"

# Camadas redundantes (esperado VERDE, registrado): cada guarda sozinha basta.
camada_verde() { # $1 nome, $2 sed
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  echo "camada so (rc=$r, 0 = a outra camada segura): $1"
}
camada_verde "C1 sem RAISE do SELECT vazio (fica o n=0)" "s/IF NOT v_sp_achou THEN/IF false THEN/"
camada_verde "C2 sem RAISE do n=0 (fica o SELECT vazio)" "s/IF v_n_tirar = 0 THEN/IF false THEN/"
camada_verde "C3 sem guarda no SET (fica a linha-base travada)" "s/AND r.foto_em IS NULL THEN/THEN/"
camada_verde "C4 sem linha-base (fica a guarda no SET)" "/VALUES (p_empresa, p_sku)\$/,/DO NOTHING;/d"

# 12) anon fora do REVOKE: a postcondicao embutida aborta o apply (rc=99).
sed "s/REVOKE ALL ON FUNCTION public.raio_x_decidir(text, bigint, text, text, text, text, numeric, boolean, boolean) FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.raio_x_decidir(text, bigint, text, text, text, text, numeric, boolean, boolean) FROM PUBLIC;/" "$MIG" > "$TMPD/sab.sql"
if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: 12"; exit 1; fi
r=0; o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
if [ "$r" -ne 99 ] || ! grep -qF "postcondicao: anon executa raio_x_decidir" <<<"$o"; then
  echo "SABOTAGEM 12 NAO ABORTOU PELA POSTCONDICAO (rc=$r)"; echo "$o"; exit 1
fi
echo "sabotagem vermelha ok: 12 anon fora do REVOKE (postcondicao aborta o apply, rc=$r)"

echo "RAIOX-DECIDIR-OK"

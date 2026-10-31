#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261031180000_raio_x_plano_execucao (pacote 2, money-path)  ║
# ║  raio_x_planejar (piso/canal, responsável/prazo, executado) + colunas novas ║
# ║      bash db/test-raio-x-planejar.sh > logs/rx-plan.log 2>&1; echo "exit=$?"║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-raio-x-planejar.sh  (2o ambiente)          ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocacao + sabotagens sobre COPIA da migration (o repo nunca e tocado).
# Asserções em ASCII, caixa fixa, sem -i. SQLSTATE capturada exata (re-lança o resto).
#
# Aplica a ancora 20261016120000 (tabela + raio_x_decidir/contar) e por cima a migration desta prova, e prova
# EXECUTANDO que raio_x_decidir/raio_x_contar (RETURNS raio_x_decisao, %ROWTYPE) seguem de pe depois do ALTER
# TABLE (PL/pgSQL e late-bound) e nao apagam o plano. Esqueleto de roles/stubs = db/test-raio-x-decidir.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5479}"
SLUG="raio-x-planejar"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
ANCORA="$REPO_ROOT/supabase/migrations/20261016120000_raio_x_estoque_parado.sql"
MIG="$REPO_ROOT/supabase/migrations/20261031180000_raio_x_plano_execucao.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c lc_messages=C" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_STAFF="22222222-2222-2222-2222-222222222222"  # employee SEM commercial_role: nao le custo, mas e da equipe
U_MASTER="11111111-1111-1111-1111-111111111111"
U_CUST="44444444-4444-4444-4444-444444444444"
U_EST="55555555-5555-5555-5555-555555555555"    # employee COM commercial_role estrategico (chamador)
U_NADA="66666666-6666-6666-6666-666666666666"   # sem papel nenhum

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
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'), false);
$$;
REVOKE ALL ON FUNCTION private.cap_compras_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated;

CREATE TABLE public.inventory_position (
  omie_codigo_produto bigint, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamptz);
CREATE TABLE public.omie_products (
  omie_codigo_produto bigint, codigo text, descricao text, unidade text, ativo boolean, familia text,
  account text, tipo_produto text, metadata jsonb, created_at timestamptz);
CREATE TABLE public.sku_parametros (
  empresa text, sku_codigo_omie bigint, fornecedor_nome text, classe_abc character(1), tipo_reposicao text,
  habilitado_reposicao_automatica boolean);
CREATE TABLE public.v_venda_items_history_efetivo (
  empresa text, data_emissao date, cliente_codigo_omie bigint, cliente_razao_social text,
  sku_codigo_omie bigint, sku_unidade text, quantidade numeric, valor_total numeric, valor_unitario numeric);
CREATE TABLE public.warehouses (id uuid PRIMARY KEY, code text);
CREATE TABLE public.nfe_recebimentos (id uuid PRIMARY KEY, razao_social_emitente text, data_emissao date, warehouse_id uuid);
CREATE TABLE public.nfe_recebimento_itens (id uuid DEFAULT gen_random_uuid(), nfe_recebimento_id uuid, produto_omie_id bigint);

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
  (1, 9, 12, 12, 'oben', now()),
  (4, 2, 3, 3, 'oben', now()),
  (7, 3, 2, 2, 'colacor_vendas', now()),
  (7, 50, 50, 50, 'oben', now()),
  (9, 5, 1, 1, 'oben', now());
INSERT INTO public.sku_parametros VALUES
  ('OBEN', 1, NULL, 'A', 'automatico', true),
  ('OBEN', 4, NULL, 'B', 'automatico', true);
SQL
}

sess() { # $1 = uuid ('' = sem claims), $2 = SQL. Roda como authenticated.
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
oks() { # $1 uuid, $2 SQL, $3 esperado, $4 rotulo
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}
run() { # $1 SQL, $2 rotulo — precisa dar certo (como U_EST)
  local got; got="$(sess "$U_EST" "$1" 2>&1)" || { echo "FALHOU: $2 | ERRO-PSQL: $got"; falhas=$((falhas+1)); }
}
# raio_x_planejar(empresa, sku, piso, canal, responsavel, prazo, concluido)
plan() { echo "SELECT sku_codigo_omie FROM public.raio_x_planejar($1)"; }
lanca() { echo "SELECT public.t_lanca('SELECT * FROM public.raio_x_planejar($1)', '$2')"; }
dec() { echo "SELECT destino FROM public.raio_x_decidir($1)"; }
COL() { echo "SELECT $3 FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }
PLANO() { echo "SELECT coalesce(preco_piso::text,'N') || '|' || coalesce(canal_liquidacao,'N') || '|' || coalesce(responsavel::text,'N') || '|' || coalesce(prazo::text,'N') || '|' || (concluido_em IS NOT NULL) || '|' || coalesce(concluido_por::text,'N') FROM public.raio_x_decisao WHERE empresa = '$1' AND sku_codigo_omie = $2"; }

SIG="public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean)"

suite() {
  falhas=0
  preparar_banco
  P -f "$ANCORA" >/dev/null || { echo "ANCORA FALHOU"; return 98; }
  # decisoes de partida (antes da migration desta prova: o plano nasce sobre linhas existentes)
  run "$(dec "'oben', 1, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "z sku1 liquidar"
  P -f "$1" >/dev/null || { echo "APLICACAO FALHOU: $1"; return 99; }
  run "$(dec "'oben', 4, 'venda_dirigida', 'mercadoria', NULL, NULL, NULL, false, false")" "z sku4 venda_dirigida (apos o ALTER)"
  run "$(dec "'colacor', 7, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "z colacor sku7"
  run "$(dec "'oben', 7, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "z oben sku7 (mesmo codigo)"
  run "SELECT sku_codigo_omie FROM public.raio_x_contar('oben', 9, 5)" "z sku9 so contado (destino NULL)"

  # ---------- (a) plano completo em liquidar ----------
  A0="$(Pq -c "SELECT atualizado_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  run "$(plan "'oben', 1, 12.5, 'outlet_queima', '$U_STAFF', '2026-11-20', false")" "a plano liquidar"
  okp "$(PLANO oben 1)" "12.5|outlet_queima|$U_STAFF|2026-11-20|false|N" "a grava piso canal responsavel prazo"
  okp "$(COL oben 1 "(atualizado_em > '$A0'::timestamptz)::text")" "true" "a planejar move atualizado_em"
  okp "$(COL oben 1 "destino || '|' || tirou_do_motor")" "liquidar|false" "a planejar nao toca destino nem motor"
  run "$(plan "'colacor', 7, 3, 'cliente_especifico', '$U_MASTER', NULL, false")" "a colacor"
  okp "$(PLANO colacor 7)" "3|cliente_especifico|$U_MASTER|N|false|N" "a colacor grava na linha colacor"
  okp "$(PLANO oben 7)" "N|N|N|N|false|N" "a colacor nao toca a linha oben"

  # ---------- (b) executado: grava uma vez, re-salvar nao move, false limpa ----------
  run "$(plan "'oben', 1, 12.5, 'outlet_queima', '$U_STAFF', '2026-11-20', true")" "b executado"
  okp "$(PLANO oben 1)" "12.5|outlet_queima|$U_STAFF|2026-11-20|true|$U_EST" "b executado grava concluido_em e concluido_por"
  C1="$(Pq -c "SELECT concluido_em FROM public.raio_x_decisao WHERE empresa='oben' AND sku_codigo_omie=1")"
  oks "$U_MASTER" "$(plan "'oben', 1, 10, 'outlet_queima', '$U_STAFF', '2026-11-21', true")" "1" "b re-salvar como master"
  okp "$(COL oben 1 "(concluido_em = '$C1'::timestamptz) || '|' || concluido_por || '|' || preco_piso")" "true|$U_EST|10" "b re-salvar executado nao move data"
  run "$(plan "'oben', 1, 10, 'outlet_queima', '$U_STAFF', '2026-11-21', false")" "b desmarcar"
  okp "$(COL oben 1 "(concluido_em IS NULL AND concluido_por IS NULL)::text")" "true" "b concluido false limpa"
  # estado completo: omitido = limpo
  run "$(plan "'oben', 1, NULL, NULL, NULL, NULL, false")" "b limpar tudo"
  okp "$(PLANO oben 1)" "N|N|N|N|false|N" "b estado completo limpa campos omitidos"

  # ---------- (c) decidir/contar seguem de pe apos o ALTER e preservam o plano ----------
  run "$(plan "'oben', 1, 8, 'promocao_carteira', '$U_STAFF', '2026-11-25', false")" "c plano de novo"
  oks "$U_EST" "SELECT destino || '|' || coalesce(responsavel::text,'N') || '|' || coalesce(preco_piso::text,'N') FROM public.raio_x_decidir('oben', 1, 'liquidar', 'mercadoria', 'obs', NULL, NULL, false, false)" "liquidar|$U_STAFF|8" "c decidir devolve as colunas novas e preserva o plano"
  oks "$U_EST" "SELECT coalesce(prazo::text,'N') FROM public.raio_x_contar('oben', 1, 7)" "2026-11-25" "c contar devolve as colunas novas"
  run "$(dec "'oben', 1, 'venda_dirigida', 'mercadoria', NULL, NULL, NULL, false, false")" "c trocar destino"
  okp "$(PLANO oben 1)" "8|promocao_carteira|$U_STAFF|2026-11-25|false|N" "c re-decidir nao apaga o plano (leitura TS filtra)"

  # ---------- (d) piso/canal so em liquidar ----------
  oks "$U_EST" "$(lanca "''oben'', 4, 5, NULL, NULL, NULL, false" 22023)" "22023|raio_x: piso e canal so no destino liquidar (destino venda_dirigida)" "d piso em venda_dirigida 22023"
  oks "$U_EST" "$(lanca "''oben'', 4, NULL, ''outro'', NULL, NULL, false" 22023)" "22023|raio_x: piso e canal so no destino liquidar (destino venda_dirigida)" "d canal em venda_dirigida 22023"
  run "$(plan "'oben', 4, NULL, NULL, '$U_EST', '2026-11-10', false")" "d venda_dirigida aceita responsavel e prazo"
  okp "$(PLANO oben 4)" "N|N|$U_EST|2026-11-10|false|N" "d venda_dirigida grava responsavel e prazo"

  # ---------- (e) sem decisao: RX002 ----------
  oks "$U_EST" "$(lanca "''oben'', 99, NULL, NULL, NULL, NULL, false" RX002)" "RX002|raio_x: sem decisao para planejar (sku 99)" "e sem linha RX002"
  oks "$U_EST" "$(lanca "''oben'', 9, NULL, NULL, NULL, NULL, false" RX002)" "RX002|raio_x: sem decisao para planejar (sku 9)" "e destino nulo RX002"
  okp "SELECT count(*) FROM public.raio_x_decisao WHERE sku_codigo_omie = 99" "0" "e RX002 nao cria linha"

  # ---------- (f) validacoes ----------
  oks "$U_EST" "$(lanca "''x'', 1, NULL, NULL, NULL, NULL, false" 22023)" "22023|raio_x: empresa invalida: x" "f empresa invalida 22023"
  oks "$U_EST" "$(lanca "''oben'', NULL, NULL, NULL, NULL, NULL, false" 22023)" "22023|raio_x: sku obrigatorio" "f sku nulo 22023"
  oks "$U_EST" "$(lanca "''oben'', 1, NULL, NULL, NULL, NULL, NULL" 22023)" "22023|raio_x: concluido obrigatorio" "f concluido nulo 22023"
  run "$(dec "'oben', 1, 'liquidar', 'mercadoria', NULL, NULL, NULL, false, false")" "f volta a liquidar"
  oks "$U_EST" "$(lanca "''oben'', 1, -1, NULL, NULL, NULL, false" 22023)" "22023|raio_x: preco_piso negativo: -1" "f piso negativo 22023"
  oks "$U_EST" "$(lanca "''oben'', 1, ''NaN''::numeric, NULL, NULL, NULL, false" 22023)" "22023|raio_x: preco_piso invalido: NaN" "f piso NaN 22023"
  oks "$U_EST" "$(lanca "''oben'', 1, NULL, ''xyz'', NULL, NULL, false" 22023)" "22023|raio_x: canal invalido: xyz" "f canal invalido 22023"
  oks "$U_EST" "$(lanca "''oben'', 1, NULL, NULL, ''$U_CUST'', NULL, false" 22023)" "22023|raio_x: responsavel nao e da equipe" "f responsavel customer 22023"
  oks "$U_EST" "$(lanca "''oben'', 1, NULL, NULL, ''$U_NADA'', NULL, false" 22023)" "22023|raio_x: responsavel nao e da equipe" "f responsavel sem papel 22023"
  run "$(plan "'oben', 1, 0, NULL, '$U_MASTER', NULL, false")" "f piso zero e master como responsavel"
  okp "$(COL oben 1 "preco_piso || '|' || responsavel")" "0|$U_MASTER" "f piso zero aceito e master e da equipe"
  # CHECK da tabela (defesa em profundidade, alem da RPC)
  okp "SELECT public.t_lanca('UPDATE public.raio_x_decisao SET preco_piso = ''NaN''::numeric WHERE sku_codigo_omie = 1', '23514')" "23514|new row for relation \"raio_x_decisao\" violates check constraint \"raio_x_decisao_preco_piso_check\"" "f check da tabela barra NaN"
  okp "SELECT public.t_lanca('UPDATE public.raio_x_decisao SET canal_liquidacao = ''zz'' WHERE sku_codigo_omie = 1', '23514')" "23514|new row for relation \"raio_x_decisao\" violates check constraint \"raio_x_decisao_canal_liquidacao_check\"" "f check da tabela barra canal"

  # ---------- (g) gate e ACL ----------
  oks "$U_STAFF" "$(lanca "''oben'', 1, NULL, NULL, NULL, NULL, false" 42501)" "42501|RAIO_X_SO_CUSTO" "g planejar barrado 42501 [$U_STAFF]"
  oks "$U_CUST" "$(lanca "''oben'', 1, NULL, NULL, NULL, NULL, false" 42501)" "42501|RAIO_X_SO_CUSTO" "g planejar barrado 42501 [$U_CUST]"
  oks "" "$(lanca "''oben'', 1, NULL, NULL, NULL, NULL, false" 42501)" "42501|RAIO_X_SO_CUSTO" "g planejar sem claims 42501"
  okp "SELECT has_function_privilege('anon','$SIG','EXECUTE')" "f" "g anon sem EXECUTE"
  okp "SELECT has_function_privilege('public','$SIG','EXECUTE')" "f" "g public sem EXECUTE"
  okp "SELECT has_function_privilege('authenticated','$SIG','EXECUTE')" "t" "g authenticated com EXECUTE"
  okp "SELECT prosecdef FROM pg_proc WHERE oid = '$SIG'::regprocedure" "t" "g security definer"

  # ---------- (h) idempotencia: reaplicar a migration ----------
  P -f "$1" >/dev/null || { echo "FALHOU: h reaplicar | erro"; falhas=$((falhas+1)); }
  okp "$(COL oben 1 "preco_piso || '|' || responsavel")" "0|$U_MASTER" "h reaplicar preserva dados"
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
  if [ "$r" -ge 98 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; echo "$o"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (FALHOU: $3)"
}
sabotar "1 sem gate cap_custo_ler" \
  "s/IF NOT private.cap_custo_ler(auth.uid()) THEN/IF false THEN/" \
  "g planejar barrado 42501 [$U_STAFF]"
sabotar "2 sem RX002 (sem linha)" \
  "s/IF NOT FOUND OR v_old.destino IS NULL THEN/IF false THEN/" \
  "e sem linha RX002"
sabotar "3 RX002 so para linha ausente (destino nulo passa)" \
  "s/IF NOT FOUND OR v_old.destino IS NULL THEN/IF NOT FOUND THEN/" \
  "e destino nulo RX002"
sabotar "4 piso e canal fora de liquidar aceitos" \
  "s/IF v_old.destino <> 'liquidar' AND/IF false AND/" \
  "d piso em venda_dirigida 22023"
sabotar "5 sem 22023 do NaN na RPC (o CHECK da tabela daria 23514)" \
  "s/IF p_preco_piso = 'NaN'::numeric THEN/IF false THEN/" \
  "f piso NaN 22023"
sabotar "6 sem 22023 do piso negativo na RPC" \
  "s/IF p_preco_piso < 0 THEN/IF false THEN/" \
  "f piso negativo 22023"
sabotar "7 sem 22023 do canal na RPC" \
  "s/IF p_canal IS NOT NULL AND p_canal NOT IN/IF false AND p_canal NOT IN/" \
  "f canal invalido 22023"
sabotar "8 responsavel sem checagem de papel" \
  "s/IF p_responsavel IS NOT NULL\$/IF false/" \
  "f responsavel customer 22023"
sabotar "9 executado re-salvo move a data" \
  "s/THEN coalesce(d.concluido_em, now()) END,/THEN now() END,/" \
  "b re-salvar executado nao move data"
sabotar "10 executado re-salvo troca o autor" \
  "s/THEN CASE WHEN d.concluido_em IS NULL THEN auth.uid() ELSE d.concluido_por END END,/THEN auth.uid() END,/" \
  "b re-salvar executado nao move data"
sabotar "11 CHECK da tabela sem o NaN" \
  "s/(preco_piso >= 0 AND preco_piso <> 'NaN'::numeric)/preco_piso >= 0/" \
  "f check da tabela barra NaN"
sabotar "12 update sem filtro de empresa" \
  "s/   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku\$/   WHERE d.sku_codigo_omie = p_sku/" \
  "a colacor grava na linha colacor"

# Postcondições: a sabotagem tem de ABORTAR o apply (rc=99) pela mensagem da postcondição.
sabotar_pos() { # $1 nome, $2 sed, $3 mensagem esperada
  sed "$2" "$MIG" > "$TMPD/sab.sql"
  if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
  if [ "$r" -ne 99 ] || ! grep -qF "$3" <<<"$o"; then
    echo "SABOTAGEM $1 NAO ABORTOU PELA POSTCONDICAO (rc=$r)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1 (postcondicao aborta o apply, rc=$r)"
}
sabotar_pos "13 anon fora do REVOKE" \
  "s/date, boolean) FROM PUBLIC, anon;/date, boolean) FROM PUBLIC;/" \
  "postcondicao: anon executa raio_x_planejar"
sabotar_pos "14 SECURITY INVOKER" \
  "s/^SECURITY DEFINER\$/SECURITY INVOKER/" \
  "postcondicao: raio_x_planejar nao e SECURITY DEFINER"

echo "RAIOX-PLANEJAR-OK"

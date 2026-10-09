#!/usr/bin/env bash
# ============================================================================
# test-universo-pedidos-classe.sh — prova PG17 das 4 migrations que alinham ao universo CANÔNICO de
# pedidos de venda os 13 objetos SQL que liam public.sales_orders com outro universo.
# ============================================================================
# A autoridade: status NOT IN ('cancelado','rascunho','pendente','orcamento') junto com
# deleted_at IS NULL (src/lib/farmer/universo-pedidos.ts). Migrations (uma por domínio; a proposta sozinha):
#   20261001014000_universo_pedidos_caca.sql      v_caca_compradores, v_caca_candidatos (+ data só kpi)
#   20261001014100_universo_pedidos_recencia.sql  private.customer_metrics_mv (+ view-gate), melhoria,
#                                                 classificar_clientes_fornecedores, v_grupo_comercial
#   20261001014210_universo_pedidos_preco.sql     régua, régua 360, últimos preços, abaixo do piso,
#                                                 defasagem, tint
#   20261001014220_universo_pedidos_proposta_whatsapp.sql  a proposta de WhatsApp (sozinha: a prova do
#                                                 canal a exercita pela cadeia viva de db/lib/corpo-vivo.sh)
# Diário: docs/historico/universo-pedidos-classe-sql.md.
#
# O banco: schema-snapshot da prod + os predecessores EXATOS da fixture
# (db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql, H01–H15 conferem o md5 e o ACL de
# prod) + a semente + as 4 migrations, cada uma na sua transação e sob o search_path do executor
# do db:aplicar (aplicar_sql: pg_catalog, public, pg_temp).
#
# BLOCO U (o coração): para cada objeto e cada predicado do universo há um cliente-sonda com UM
# pedido válido (R$ 1) e UM pedido excluído SÓ por aquele predicado — status cancelado, rascunho,
# pendente, orcamento, ou faturado APAGADO —, de valor 10^k (k = 1..5) e com a data DENTRO da janela
# do objeto (sem isso ele sairia pela data e o assert passaria por vacuidade). Vazamento aparece
# como linha a mais, contagem a mais ou valor com a potência de 10 que nomeia o predicado. Mais:
# admissão dos 4 status de venda (uma allowlist derruba algum), o gêmeo push/pull onde a data
# virou só-kpi, o status DESCONHECIDO onde a forma antiga era allowlist (é onde as formas divergem),
# a view-gate sob `authenticated`, o REFRESH do cron e o bloco M (PRE aborta e preserva).
#
# Uso:  bash db/test-universo-pedidos-classe.sh                (suíte)
#       bash db/test-universo-pedidos-classe.sh --falsificar   (controle verde + sabotagens)
#       HARNESS_LC=pt_BR.UTF-8 bash db/test-universo-pedidos-classe.sh --falsificar
# ============================================================================
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5760}"   # o laço --falsificar sobe 1 PG por sabotagem, cada um na sua porta
SLUG="universo-pedidos-classe"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG_CACA="$REPO_ROOT/supabase/migrations/20261001014000_universo_pedidos_caca.sql"
MIG_REC="$REPO_ROOT/supabase/migrations/20261001014100_universo_pedidos_recencia.sql"
MIG_PRECO="$REPO_ROOT/supabase/migrations/20261001014210_universo_pedidos_preco.sql"
MIG_PROPOSTA="$REPO_ROOT/supabase/migrations/20261001014220_universo_pedidos_proposta_whatsapp.sql"
FIXTURE="$REPO_ROOT/db/fixtures/universo-pedidos-predecessoras-prod-20261001.sql"
SNAP="$REPO_ROOT/supabase/schema-snapshot.sql"
TOTAL_ESPERADO=118

# ── Falsificação ─────────────────────────────────────────────────────────────────────────────
# Formato: nome:vermelhos[:verdes]. Vermelho = o assert FALHOU (ou ERRO_DE_EXECUCAO com a marca
# depois do `!`); verde = o assert seguiu OK. Sabotagem "de corpo" desliga a POS da migration
# (RAISE EXCEPTION 'POS → RAISE NOTICE 'POS) para o corpo sabotado chegar ao banco: o dente que se
# prova é o do ASSERT, não o da POS. As sabotagens "_pos" mantêm a POS e provam o dente DELA.
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_cancelado:CC1,CD1,RM1,MM1,CL1,GG1,RG1,RC1,R31,R3S,WP1,UP1,MP1,DF1,TP1:CC2,RM2,RG2,UP2,A1,A2,A3,A4
              sem_rascunho:CC2,CD2,RM2,MM2,CL2,GG2,RG2,RC2,R32,WP2,UP2,MP2,DF2,TP2:CC1,RM1,RG1,UP1
              sem_pendente:CC3,CD3,RM3,MM3,CL3,GG3,RG3,RC3,R33,WP3,UP3,MP3,DF3,TP3:CC1,RM1,RG1,UP1
              sem_orcamento:CC4,CD4,RM4,MM4,CL4,GG4,RG4,RC4,R34,WP4,UP4,MP4,DF4,TP4:CC1,RM1,RG1,UP1
              sem_deleted_at:CC5,CD5,RM5,MM5,CL5,GG5,RG5,RC5,R35,WP5,UP5,MP5,DF5,TP5:CC1,RM1,RG1,UP1
              sem_kpi_not_null:CCG,RMC,GGG:RMG,MMG,CC1,RM1,GG1
              melhoria_coalesce:MMG:MM1,MMA
              regua_so_cliente:RC1,RC2,RC3,RC4:RC5,RG1,RG2,RG3,RG4,RG5,RGA
              regua_so_comparaveis:RG1,RG2,RG3,RG4:RG5,RC1,RC2,RC3,RC4,RC5,RCA
              r360_so_preco:R3S:R31,R32,R33,R34,R35,R3A
              corpo_antigo_caca:CC3,CC4,CD3,CD4,CCG:CC1,CC2,CC5,CD1,CD2,CD5,CCA,CDA
              corpo_antigo_recencia:RM3,RM4,RM5,RMG,RMC,MM4,MMG,CL5,GGG,GGN:RM1,RM2,MM1,CL1,GG1,GG5
              corpo_antigo_preco:RG1,RG4,RC1,RC4,R31,R34,R3S,WP1,WP5,UP2,UP3,MP2,MP3,DFN,TP2,TP5:RG5,RC5,R35,UP1,UP4,UP5,MP1,DF1,DF5,TP1
              pre_cega:M2,M3,M4:M1
              data_coalesce_pos:A1:A2,A3,A4
              mv_sem_acl_pos:A2:A1,A3,A4
              gate_sem_with_pos:A2:A1,A3,A4"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  # o filho rodou até o fim, com TODOS os asserts? (senão o vermelho pode ser de um aborto)
  completo() {
    local l ok_n fail_n
    l="$(grep -E '^RESULTADO: [0-9]+ ok / [0-9]+ fail$' "$1" | tail -1 || true)"
    [ -n "$l" ] || return 1
    ok_n="$(printf '%s' "$l" | awk '{print $2}')"; fail_n="$(printf '%s' "$l" | awk '{print $5}')"
    [ $((ok_n + fail_n)) -eq "$TOTAL_ESPERADO" ]
  }
  echo "══ CONTROLE (migrations reais, sem sabotagem) — tem de ficar VERDE, com os $TOTAL_ESPERADO asserts ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 && completo "$LOGDIR/controle.log"; then
    echo "  ✅ controle VERDE ($(grep -c ' OK — ' "$LOGDIR/controle.log" || true) asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO ou incompleto — abortando ANTES de sabotar (uma suíte que já falha aprovaria tudo)"
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"; verm="${resto%%:*}"; verdes=""
    [ "$resto" != "$verm" ] && verdes="${resto#*:}"
    porta=$((porta+1))
    log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ativa: $sab\$" "$log"; then
      echo "  ❌ $sab — vermelha, mas a sabotagem NÃO chegou a aplicar: quebrou outra coisa"
      { grep -E 'FALHOU|ERRO|ERROR|APLICAVEL|INFRA' "$log" || true; } | head -3 | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    if ! completo "$log"; then
      echo "  ❌ $sab — o filho NÃO chegou ao fim com os $TOTAL_ESPERADO asserts: o vermelho pode ser de um aborto"
      tail -5 "$log" | sed 's/^/       /'
      falhas=$((falhas+1)); continue
    fi
    faltou=""; sobrou=""; nao_declarado=""
    for x in ${verm//,/ }; do
      case "$x" in
        *!*) id="${x%%!*}"; marca="${x#*!}"
             grep -Eq "(^|[^A-Za-z0-9])${id} ERRO_DE_EXECUCAO .*${marca}" "$log" || faltou="$faltou $x" ;;
        *)   grep -Eq "(^|[^A-Za-z0-9])${x} FALHOU" "$log" || faltou="$faltou $x" ;;
      esac
    done
    for id in ${verdes//,/ }; do
      if ! grep -Eq "(^|[^A-Za-z0-9])${id} OK" "$log" || grep -Eq "(^|[^A-Za-z0-9])${id} (FALHOU|ERRO_DE_EXECUCAO)" "$log"; then
        sobrou="$sobrou $id"
      fi
    done
    while IFS= read -r id_err; do
      [ -n "$id_err" ] || continue
      case ",${verm}," in *",${id_err}!"*) ;; *) nao_declarado="$nao_declarado $id_err" ;; esac
    done < <(grep -oE '[A-Za-z0-9]+ ERRO_DE_EXECUCAO' "$log" | awk '{print $1}' || true)
    if [ -z "$faltou" ] && [ -z "$sobrou" ] && [ -z "$nao_declarado" ]; then
      echo "  ✅ $sab — vermelha em [${verm}]${verdes:+, verde em [${verdes}]}"
    else
      [ -n "$faltou" ] && echo "  ❌ $sab — devia ficar vermelha (por resultado) em:${faltou}"
      [ -n "$sobrou" ] && echo "  ❌ $sab — devia continuar verde (rodando) em:${sobrou}"
      [ -n "$nao_declarado" ] && { echo "  ❌ $sab — ERRO DE EXECUÇÃO não declarado em:${nao_declarado} (vermelho que não é do assert não mata mutante)"
                                   { grep 'ERRO_DE_EXECUCAO' "$log" || true; } | head -2 | sed 's/^/       /'; }
      falhas=$((falhas+1))
    fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert certo ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem dente (logs em $LOGDIR) ═══"
  exit 1
fi

SABOTAGEM="${SABOTAGEM:-}"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponivel neste servidor"; exit 1; }
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

PASS=0; FAIL=0
ok()       { PASS=$((PASS+1)); echo "  ✅ $1 OK — $2"; }
bad()      { FAIL=$((FAIL+1)); echo "  ❌ $1 FALHOU — $2"; }
erro_exec(){ FAIL=$((FAIL+1)); echo "  ❌ $1 ERRO_DE_EXECUCAO — $2"; }
eq() {
  case "$3" in
    ""|*ERROR:*|*ERRO:*|*FATAL:*|*psql:*)
      erro_exec "$1" "$2 — sem resultado válido: [$(printf '%s' "$3" | tr '\n' ' ' | head -c 200)]" ;;
    *) if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi ;;
  esac
}
# consulta como STAFF (master): auth.uid() lê a GUC test.uid
STAFF_UID="$(Pq -c "SELECT md5('universo:STAFF')::uuid")"
Qs() { Pq -c "SET test.uid = '$STAFF_UID'" -c "$1" 2>&1 || true; }
Q()  { Pq -c "$1" 2>&1 || true; }

# ══════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema de prod: stubs + prelude + snapshot (transação única)
# ══════════════════════════════════════════════════════════════════════════════════════════════
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
P -q -c "GRANT USAGE ON SCHEMA auth TO authenticated, anon;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════════════════════
# OS PREDECESSORES — o que a prod tinha em 2026-10-01 (fixture verbatim) + o ACL de prod
# ══════════════════════════════════════════════════════════════════════════════════════════════
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIXTURE" >/dev/null 2>"$TMPD/fix.err" \
  || { echo "INFRA: fixture não carregou"; tail -5 "$TMPD/fix.err"; exit 1; }
echo "═══ setup pronto (PG17 :$PORT, servidor TimeZone=$(Pq -c 'SHOW TimeZone'), lc_messages=$HARNESS_LC) ═══"

echo "── H: o banco de prova parte EXATAMENTE do que a PRE vai encontrar na prod ──"
hf() { Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
hv() { Q "SELECT md5(pg_get_viewdef(to_regclass('$1'), true))"; }
eq H01 "get_regua_preco = prod"               "$(hf 'public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])')" 846b8d591627674ff59b904b53222ff1
eq H02 "get_regua_preco_customer360 = prod"   "$(hf 'public.get_regua_preco_customer360(uuid,bigint[])')" 92362d82b03f36e594664e16a334297c
eq H03 "get_whatsapp_proposta_cotacao = prod" "$(hf 'public.get_whatsapp_proposta_cotacao(uuid,text,bigint[])')" d73ff1824d15ec00b9e0c85091b9e3e7
eq H04 "get_ultimos_precos_cliente = prod"    "$(hf 'public.get_ultimos_precos_cliente(uuid)')" 77a6962c6f62b1d82d1d31b43b38c5fc
eq H05 "medir_abaixo_piso_tier = prod"        "$(hf 'public.medir_abaixo_piso_tier(integer)')" 9fc343369c69aeeb510f67ec22037a12
eq H06 "get_defasagem_cliente = prod"         "$(hf 'public.get_defasagem_cliente(jsonb,uuid)')" 4ad3e130bdf9fda5546ced1450e7b6af
eq H07 "tint_ultimo_preco_cliente = prod"     "$(hf 'public.tint_ultimo_preco_cliente(uuid,uuid,text,uuid)')" 712b5761381bb0118c968e9ca56f282d
eq H08 "melhoria_clientes_por_produto = prod" "$(hf 'public.melhoria_clientes_por_produto(text)')" fb00b17ac45b38e31a08fe4531c51618
eq H09 "classificar_clientes_fornecedores = prod" "$(hf 'public.classificar_clientes_fornecedores()')" 7168163f53b1f515ec0e77ee87018b2d
eq H10 "v_caca_compradores = prod"            "$(hv public.v_caca_compradores)" 41cce289721d3631b1bd518e55dc048f
eq H11 "v_caca_candidatos = prod"             "$(hv public.v_caca_candidatos)" 24af34211e33745ac90b36c559561dbe
eq H12 "v_grupo_comercial = prod"             "$(hv public.v_grupo_comercial)" 73de52bd7737a62d2828589f97661e9a
eq H13 "private.customer_metrics_mv = prod"   "$(hv private.customer_metrics_mv)" f47c2fd0fca117f97dc197bbae30670b
eq H14 "view-gate public.customer_metrics_mv = prod" "$(hv public.customer_metrics_mv)" d1967849771139100c7ef200e0accfe9
eq H15 "ACL da MV = o de prod (o snapshot vem sem privilégios)" \
  "$(Q "SELECT string_agg(a::text, ',' ORDER BY a::text) FROM pg_class c, unnest(c.relacl) a WHERE c.oid = 'private.customer_metrics_mv'::regclass")" \
  "claude_ro=r/postgres,postgres=arwdDxtm/postgres,sandbox_exec=ar/postgres,sandbox_exec_fzvklzpomgnyikkfkzai=ar/postgres,service_role=arwdDxtm/postgres"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# SEMENTE — `session_replication_role = replica`: sem gatilhos nem FKs (a semente não é o objeto sob
# prova). Datas relativas ao hoje de SP, longe das bordas: o que se prova é o universo, não a janela.
# ══════════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL' >/dev/null
CREATE SCHEMA teste;
CREATE TABLE teste.rotulo (rotulo text PRIMARY KEY, id uuid NOT NULL, doc text);
CREATE SEQUENCE teste.seq_doc START 1;
CREATE SEQUENCE teste.seq_omie START 880000;
CREATE FUNCTION teste.hoje() RETURNS date LANGUAGE sql STABLE AS $f$ SELECT (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date $f$;
CREATE FUNCTION teste.uid(p text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $f$ SELECT md5('universo:' || p)::uuid $f$;
CREATE FUNCTION teste.doc(p text) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT doc FROM teste.rotulo WHERE rotulo = p $f$;
CREATE FUNCTION teste.cliente(p text) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid := teste.uid(p); d text := '7' || lpad(nextval('teste.seq_doc')::text, 13, '0');
BEGIN
  INSERT INTO public.profiles (user_id, name, document, cnpj, is_employee) VALUES (v, p, d, d, false);
  INSERT INTO teste.rotulo VALUES (p, v, d);
  RETURN v;
END $f$;
CREATE FUNCTION teste.produto(p text, p_conta text, p_codigo bigint) RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid := teste.uid('produto:' || p);
BEGIN
  INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, valor_unitario, familia, unidade, estoque)
  VALUES (v, p_codigo, p, p, p_conta, true, 0, 'FAM_' || p, 'UN', 0);
  RETURN v;
END $f$;
CREATE FUNCTION teste.tint(p uuid, preco numeric) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $f$
  SELECT jsonb_build_array(jsonb_build_object('product_id', p::text, 'tint_cor_id', 'COR1', 'valor_unitario', preco)) $f$;
CREATE FUNCTION teste.pedido(p_cli uuid, p_conta text, p_status text, p_kpi date, p_criado date, p_total numeric,
                             p_apagado boolean DEFAULT false, p_omie bigint DEFAULT NULL, p_items jsonb DEFAULT '[]'::jsonb)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid(); o bigint := coalesce(p_omie, nextval('teste.seq_omie'));
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, order_date_kpi, created_at, total,
                                   deleted_at, omie_pedido_id, omie_numero_pedido, items)
  VALUES (v, p_cli, p_cli, p_conta, p_status, p_kpi, (p_criado + time '12:00') AT TIME ZONE 'America/Sao_Paulo', p_total,
          CASE WHEN p_apagado THEN pg_catalog.now() END, o, o::text, p_items);
  RETURN v;
END $f$;
CREATE FUNCTION teste.item(p_pedido uuid, p_cli uuid, p_prod uuid, p_codigo bigint, p_qtd numeric, p_preco numeric, p_criado date)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.order_items (sales_order_id, customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, created_at)
  VALUES (p_pedido, p_cli, p_prod, p_codigo, p_qtd, p_preco, (p_criado + time '12:00') AT TIME ZONE 'America/Sao_Paulo') $f$;
-- os 5 predicados do universo: k nomeia o predicado pela potência de 10 do valor que vaza
CREATE TABLE teste.pred (k int PRIMARY KEY, nome text NOT NULL, status text NOT NULL, apagado boolean NOT NULL);
INSERT INTO teste.pred VALUES (1,'cancelado','cancelado',false),(2,'rascunho','rascunho',false),
  (3,'pendente','pendente',false),(4,'orcamento','orcamento',false),(5,'apagado','faturado',true);
-- os 4 status de venda medidos na prod (admissão)
CREATE TABLE teste.adm (n int PRIMARY KEY, status text NOT NULL);
INSERT INTO teste.adm VALUES (1,'faturado'),(2,'importado'),(3,'separacao'),(4,'enviado');

-- `replica` desliga gatilho comum, mas NÃO os `ENABLE ALWAYS` — e os dois de coerência pedido × itens
-- (`trg_pedido_venda_coerencia_cab/_lin`, constraint triggers DEFERRED) são ALWAYS em prod. Eles entraram
-- no snapshot no re-dump de 2026-10-08 e passaram a recusar esta semente (`order_items e items(jsonb)
-- descrevem conjuntos diferentes`): a semente monta itens sem espelhar o jsonb, de propósito. Desligá-los
-- AQUI é cumprir a intenção declarada acima (a semente não é o objeto sob teste), e só durante ela.
ALTER TABLE public.sales_orders DISABLE TRIGGER trg_pedido_venda_coerencia_cab;
ALTER TABLE public.order_items  DISABLE TRIGGER trg_pedido_venda_coerencia_lin;
SET session_replication_role = replica;
DO $seed$
DECLARE r record; c uuid; p uuid; v uuid; h date := teste.hoje(); s uuid := teste.uid('STAFF'); m numeric;
        pm uuid; padm uuid; pnovo uuid; pso uuid;
BEGIN
  INSERT INTO public.profiles (user_id, name, is_employee) VALUES (s, 'STAFF', true);
  INSERT INTO public.user_roles (user_id, role) VALUES (s, 'master');
  PERFORM teste.cliente('VIEWER');
  pm    := teste.produto('SONDAMELHORIA', 'oben', 4001);
  padm  := teste.produto('PR_ADM', 'oben', 3100);
  pnovo := teste.produto('PR_NOVO', 'oben', 3200);
  pso   := teste.produto('PR_SO', 'oben', 3300);
  INSERT INTO public.inventory_position (omie_codigo_produto, product_id, cmc, account, synced_at)
    VALUES (3100, padm, 0.5, 'oben', pg_catalog.now()), (3200, pnovo, 0.5, 'oben', pg_catalog.now());
  INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at) VALUES (5100, 0.5, 'colacor', pg_catalog.now());

  FOR r IN SELECT * FROM teste.pred ORDER BY k LOOP
    m := 10::numeric ^ r.k;
    -- CAÇA: válido na colacor; o excluído só por r na oben
    c := teste.cliente('CA_' || r.nome);
    PERFORM teste.pedido(c, 'colacor', 'faturado', h - 20, h - 20, 1);
    PERFORM teste.pedido(c, 'oben', r.status, h - 15, h - 15, m, r.apagado);
    -- RECÊNCIA (MV): válido há 60 d; o excluído há 10 d
    c := teste.cliente('RE_' || r.nome);
    PERFORM teste.pedido(c, 'oben', 'faturado', h - 60, h - 60, 1);
    PERFORM teste.pedido(c, 'oben', r.status, h - 10, h - 10, m, r.apagado);
    -- MELHORIA: item do produto-sonda nos dois
    c := teste.cliente('ME_' || r.nome);
    v := teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 1);       PERFORM teste.item(v, c, pm, 4001, 1, 1, h - 30);
    v := teste.pedido(c, 'oben', r.status, h - 20, h - 20, m, r.apagado); PERFORM teste.item(v, c, pm, 4001, 1, m, h - 20);
    -- CLASSIFICAR: fornecedor cujo ÚNICO pedido é o excluído
    c := teste.cliente('CL_' || r.nome);
    INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES (c, ARRAY['fornecedor']);
    PERFORM teste.pedido(c, 'oben', r.status, h - 10, h - 10, 1, r.apagado);
    -- GRUPO COMERCIAL
    c := teste.cliente('GR_' || r.nome);
    INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (teste.uid('G_' || r.nome), teste.doc('GR_' || r.nome));
    PERFORM teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 1);
    PERFORM teste.pedido(c, 'oben', r.status, h - 20, h - 20, m, r.apagado);
    -- PREÇO: produto próprio por predicado (comparáveis não se misturam), tier próprio, cmc
    c := teste.cliente('PC_' || r.nome);
    p := teste.produto('PR_' || r.nome, 'oben', 3000 + r.k);
    INSERT INTO public.inventory_position (omie_codigo_produto, product_id, cmc, account, synced_at)
      VALUES (3000 + r.k, p, 0.5, 'oben', pg_catalog.now());
    v := teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 10, false, NULL, teste.tint(p, 1));
    PERFORM teste.item(v, c, p, 3000 + r.k, 10, 1, h - 30);
    v := teste.pedido(c, 'oben', r.status, h - 20, h - 20, 10 * m, r.apagado, NULL, teste.tint(p, m));
    PERFORM teste.item(v, c, p, 3000 + r.k, 10, m, h - 20);
    -- ABAIXO DO PISO: agrega por (empresa, tier) e o tier só aceita A/B/C — um par por predicado
    c := teste.cliente('PM_' || r.nome);
    INSERT INTO public.cliente_tier_preco (company, customer_user_id, tier, definido_por)
      VALUES ((ARRAY['oben','oben','oben','colacor','colacor'])[r.k], c, (ARRAY['A','B','C','A','B'])[r.k], s);
    INSERT INTO public.inventory_position (omie_codigo_produto, cmc, account, synced_at)
      VALUES (5000 + r.k, 0.5, (ARRAY['oben','oben','oben','colacor','colacor'])[r.k], pg_catalog.now());
    v := teste.pedido(c, (ARRAY['oben','oben','oben','colacor','colacor'])[r.k], 'faturado', h - 30, h - 30, 1);
    PERFORM teste.item(v, c, NULL, 5000 + r.k, 1, 1, h - 30);
    v := teste.pedido(c, (ARRAY['oben','oben','oben','colacor','colacor'])[r.k], r.status, h - 20, h - 20, m, r.apagado);
    PERFORM teste.item(v, c, NULL, 5000 + r.k, 1, m, h - 20);
  END LOOP;

  FOR r IN SELECT * FROM teste.adm ORDER BY n LOOP
    c := teste.cliente('CA_adm_' || r.status);  PERFORM teste.pedido(c, 'oben', r.status, h - 15, h - 15, 1);
    c := teste.cliente('RE_adm_' || r.status);  PERFORM teste.pedido(c, 'oben', r.status, h - 10, h - 10, 1);
    c := teste.cliente('ME_adm_' || r.status);  v := teste.pedido(c, 'oben', r.status, h - 20, h - 20, 1);
                                                PERFORM teste.item(v, c, pm, 4001, 1, 1, h - 20);
    c := teste.cliente('CL_adm_' || r.status);
    INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES (c, ARRAY['fornecedor']);
    PERFORM teste.pedido(c, 'oben', r.status, h - 10, h - 10, 1);
    c := teste.cliente('GR_adm_' || r.status);
    INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (teste.uid('G_adm_' || r.status), teste.doc('GR_adm_' || r.status));
    PERFORM teste.pedido(c, 'oben', r.status, h - 20, h - 20, 1);
    c := teste.cliente('PM_adm_' || r.status);
    INSERT INTO public.cliente_tier_preco (company, customer_user_id, tier, definido_por) VALUES ('colacor', c, 'C', s);
    v := teste.pedido(c, 'colacor', r.status, h - 20, h - 20, 1); PERFORM teste.item(v, c, NULL, 5100, 1, 1, h - 20);
    c := teste.cliente('PC_adm_' || r.status);
    v := teste.pedido(c, 'oben', r.status, h - 20, h - 20, 10, false, NULL, teste.tint(padm, 1));
    PERFORM teste.item(v, c, padm, 3100, 10, 1, h - 20);
  END LOOP;

  -- GÊMEOS push/pull: a linha do app (sem kpi) e a importada (com kpi), mesmo (conta, omie_pedido_id)
  c := teste.cliente('CA_gemeo');
  PERFORM teste.pedido(c, 'oben', 'enviado', NULL, h - 5, 100, false, 777001);
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 5, h - 5, 100, false, 777001);
  c := teste.cliente('RE_gemeo');
  PERFORM teste.pedido(c, 'oben', 'enviado', NULL, h - 5, 100, false, 777002);
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 5, h - 5, 100, false, 777002);
  c := teste.cliente('RE_cad');   -- cadência: 3 com kpi (60/30/0 d) + 1 do app sem kpi
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 60, h - 60, 1);
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 1);
  PERFORM teste.pedido(c, 'oben', 'faturado', h, h, 1);
  PERFORM teste.pedido(c, 'oben', 'enviado', NULL, h - 45, 1);
  c := teste.cliente('ME_gemeo');
  v := teste.pedido(c, 'oben', 'enviado', NULL, h - 5, 100, false, 777003);  PERFORM teste.item(v, c, pm, 4001, 1, 100, h - 5);
  v := teste.pedido(c, 'oben', 'faturado', h - 5, h - 5, 100, false, 777003); PERFORM teste.item(v, c, pm, 4001, 1, 100, h - 5);
  c := teste.cliente('GR_gemeo');
  INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (teste.uid('G_gemeo'), teste.doc('GR_gemeo'));
  PERFORM teste.pedido(c, 'oben', 'enviado', NULL, h - 5, 100, false, 777004);
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 5, h - 5, 100, false, 777004);
  -- STATUS DESCONHECIDO (onde allowlist e denylist divergem): entra no universo pela denylist
  c := teste.cliente('GR_novo');
  INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES (teste.uid('G_novo'), teste.doc('GR_novo'));
  PERFORM teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 1);
  PERFORM teste.pedido(c, 'oben', 'novo_status', h - 20, h - 20, 1);
  c := teste.cliente('PC_novo');
  v := teste.pedido(c, 'oben', 'faturado', h - 30, h - 30, 10);    PERFORM teste.item(v, c, pnovo, 3200, 10, 1, h - 30);
  v := teste.pedido(c, 'oben', 'novo_status', h - 20, h - 20, 70); PERFORM teste.item(v, c, pnovo, 3200, 10, 7, h - 20);
  -- 360 com o ÚNICO pedido do código cancelado: não há produto a resolver
  c := teste.cliente('PC_so');
  v := teste.pedido(c, 'oben', 'cancelado', h - 20, h - 20, 100); PERFORM teste.item(v, c, pso, 3300, 10, 10, h - 20);
END $seed$;
SET session_replication_role = origin;
-- religa no modo de PROD (ALWAYS), não com ENABLE simples — que mudaria o modo e afastaria a prova de prod
ALTER TABLE public.sales_orders ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_cab;
ALTER TABLE public.order_items  ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_lin;
-- a MV predecessora populada, como na prod (o REFRESH ... CONCURRENTLY do cron exige)
REFRESH MATERIALIZED VIEW private.customer_metrics_mv;
SQL

# ══════════════════════════════════════════════════════════════════════════════════════════════
# AS MIGRATIONS (cópias; a sabotagem age na cópia — supabase/migrations/ é DR e não se toca)
# ══════════════════════════════════════════════════════════════════════════════════════════════
cp "$MIG_CACA" "$TMPD/m1.sql"; cp "$MIG_REC" "$TMPD/m2.sql"; cp "$MIG_PRECO" "$TMPD/m3.sql"; cp "$MIG_PROPOSTA" "$TMPD/m4.sql"
sub() {  # sub <arquivo> <perl-s///> — aborta se não trocou nada (sabotagem que não aplica não prova)
  local antes; antes="$(md5sum < "$1" 2>/dev/null || md5 -q "$1")"
  perl -0pi -e "$2" "$1"
  [ "$(md5sum < "$1" 2>/dev/null || md5 -q "$1")" != "$antes" ] || { echo "SABOTAGEM NÃO APLICAVEL: $2 em $(basename "$1")"; exit 9; }
}
pos_off() { local f; for f in "$@"; do sub "$f" "s/RAISE EXCEPTION 'POS/RAISE NOTICE 'POS/g"; done; }
LISTA="'cancelado','rascunho','pendente','orcamento'"
case "$SABOTAGEM" in
  "") ;;
  sem_cancelado)  pos_off "$TMPD/m1.sql" "$TMPD/m2.sql" "$TMPD/m3.sql" "$TMPD/m4.sql"
                  for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/'cancelado','rascunho','pendente','orcamento'/'rascunho','pendente','orcamento'/g"; done ;;
  sem_rascunho)   pos_off "$TMPD/m1.sql" "$TMPD/m2.sql" "$TMPD/m3.sql" "$TMPD/m4.sql"
                  for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/'cancelado','rascunho','pendente','orcamento'/'cancelado','pendente','orcamento'/g"; done ;;
  sem_pendente)   pos_off "$TMPD/m1.sql" "$TMPD/m2.sql" "$TMPD/m3.sql" "$TMPD/m4.sql"
                  for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/'cancelado','rascunho','pendente','orcamento'/'cancelado','rascunho','orcamento'/g"; done ;;
  sem_orcamento)  pos_off "$TMPD/m1.sql" "$TMPD/m2.sql" "$TMPD/m3.sql" "$TMPD/m4.sql"
                  for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/'cancelado','rascunho','pendente','orcamento'/'cancelado','rascunho','pendente'/g"; done ;;
  sem_deleted_at) pos_off "$TMPD/m1.sql" "$TMPD/m2.sql" "$TMPD/m3.sql" "$TMPD/m4.sql"
                  for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/so\.deleted_at (IS|is) (NULL|null)/true/g"; done ;;
  sem_kpi_not_null) pos_off "$TMPD/m1.sql" "$TMPD/m2.sql"
                  for f in m1 m2; do sub "$TMPD/$f.sql" "s/ AND so\.order_date_kpi IS NOT NULL//g"; done ;;
  melhoria_coalesce) pos_off "$TMPD/m2.sql"
                  sub "$TMPD/m2.sql" "s/max\(so\.order_date_kpi\) as ultima_compra/max(coalesce(so.order_date_kpi, (so.created_at at time zone 'America\/Sao_Paulo')::date)) as ultima_compra/"
                  sub "$TMPD/m2.sql" "s/      and so\.order_date_kpi >= \(now\(\)/      and coalesce(so.order_date_kpi, (so.created_at at time zone 'America\/Sao_Paulo')::date) >= (now()/" ;;
  regua_so_cliente) pos_off "$TMPD/m3.sql"   # o universo só na 1ª leitura da régua (precos_cliente)
                  sub "$TMPD/m3.sql" "s/(-- public\.get_regua_preco\n(?:(?!-- public\.).)*?AND so\.status NOT IN \($LISTA\)(?:(?!-- public\.).)*?)so\.account = v_account AND so\.deleted_at IS NULL AND so\.status NOT IN \($LISTA\)/\${1}so.account = v_account AND so.deleted_at IS NULL/s" ;;
  regua_so_comparaveis) pos_off "$TMPD/m3.sql"   # o universo só na 2ª leitura (comparaveis)
                  sub "$TMPD/m3.sql" "s/(-- public\.get_regua_preco\n(?:(?!-- public\.).)*?)so\.account = v_account AND so\.deleted_at IS NULL AND so\.status NOT IN \($LISTA\)/\${1}so.account = v_account AND so.deleted_at IS NULL/s" ;;
  r360_so_preco)  pos_off "$TMPD/m3.sql"   # no 360, o universo só no preco_atual, não na resolução do produto
                  sub "$TMPD/m3.sql" "s/(-- public\.get_regua_preco_customer360\n(?:(?!-- public\.).)*?)so\.account = v_account AND so\.deleted_at IS NULL AND so\.status NOT IN \($LISTA\)/\${1}so.account = v_account AND so.deleted_at IS NULL/s" ;;
  corpo_antigo_caca)     : > "$TMPD/m1.sql" ;;
  corpo_antigo_recencia) : > "$TMPD/m2.sql" ;;
  corpo_antigo_preco)    : > "$TMPD/m3.sql"; : > "$TMPD/m4.sql" ;;
  pre_cega)       for f in m1 m2 m3 m4; do sub "$TMPD/$f.sql" "s/RAISE EXCEPTION 'PRE: % deriva/RAISE NOTICE 'PRE: % deriva/g"; done
                  sub "$TMPD/m2.sql" "s/RAISE EXCEPTION 'PRE: private\.customer_metrics_mv deriva/RAISE NOTICE 'PRE: private.customer_metrics_mv deriva/" ;;
  data_coalesce_pos) sub "$TMPD/m1.sql" "s/            so\.order_date_kpi AS dt,/            COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America\/Sao_Paulo'::text)::date) AS dt,/" ;;
  mv_sem_acl_pos) sub "$TMPD/m2.sql" "s/    EXECUTE format\('GRANT %s ON private\.customer_metrics_mv TO %s%s'/    PERFORM format('GRANT %s ON private.customer_metrics_mv TO %s%s'/" ;;
  gate_sem_with_pos) sub "$TMPD/m2.sql" "s/CREATE OR REPLACE VIEW public\.customer_metrics_mv WITH \([^)]*\) AS/CREATE OR REPLACE VIEW public.customer_metrics_mv AS/" ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "$SABOTAGEM" ] && echo "SABOTAGEM ativa: $SABOTAGEM"
# SO_MD5=1: o md5 do DEPARSE das views/MV novas só existe depois de criá-las (é o que a POS confere);
# este modo aplica com a POS desligada, imprime os 4 e sai — é como o md5 entra nas migrations.
if [ -n "${SO_MD5:-}" ]; then
  pos_off "$TMPD/m1.sql" "$TMPD/m2.sql"
  for f in m1 m2; do PGOPTIONS="-c search_path=pg_catalog,public,pg_temp" P -q --single-transaction -f "$TMPD/$f.sql" >"$TMPD/$f.out" 2>&1 || { echo "SO_MD5: $f não aplicou"; grep -E "ERRO|ERROR|LINE|LINHA|CONTEXT|CONTEXTO" "$TMPD/$f.out" | head -6; exit 1; }; done
  for v in public.v_caca_compradores public.v_caca_candidatos public.v_grupo_comercial private.customer_metrics_mv; do echo "MD5 $v $(hv "$v")"; done
  exit 0
fi

# cada migration na SUA transação, sob o search_path do executor (aplicar_sql: pg_catalog, public, pg_temp)
aplica() { PGOPTIONS="-c search_path=pg_catalog,public,pg_temp" P -q --single-transaction -f "$1" 2>&1 || echo "APLICACAO_FALHOU"; }
saida1="$(aplica "$TMPD/m1.sql")"; saida2="$(aplica "$TMPD/m2.sql")"; saida3="$(aplica "$TMPD/m3.sql")"; saida4="$(aplica "$TMPD/m4.sql")"
aplicada() { case "$1" in *APLICACAO_FALHOU*) printf 'falhou: %s' "$(printf '%s' "$1" | { grep -E 'ERRO|ERROR' || true; } | head -1 | sed -E 's/.*(ERRO|ERROR):[[:space:]]*//' | head -c 160)";; *"POS OK"*) echo aplicada;; *) echo "sem POS OK";; esac; }
echo "── A: as 4 migrations aplicam e a POS de cada uma passa ──"
eq A1 "caça aplicada (POS OK)"     "$(aplicada "$saida1")" aplicada
eq A2 "recência aplicada (POS OK)" "$(aplicada "$saida2")" aplicada
eq A3 "preço aplicada (POS OK)"    "$(aplicada "$saida3")" aplicada
eq A4 "proposta aplicada (POS OK)" "$(aplicada "$saida4")" aplicada

# ══════════════════════════════════════════════════════════════════════════════════════════════
# BLOCO U — CAÇA
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── U/caça: v_caca_compradores e v_caca_candidatos ──"
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "CC$k" "compradores: o pedido $nome não conta (n:volume)" \
    "$(Q "SELECT count(*) || ':' || coalesce(sum(volume)::text, '-') FROM public.v_caca_compradores WHERE documento = teste.doc('CA_$nome')")" "1:1"
  eq "CD$k" "candidatos: sem o $nome, é candidato na oben com ticket do grupo = 1" \
    "$(Q "SELECT coalesce(string_agg(empresa_alvo || ':' || coalesce(ticket_faixa::text, '-'), ',' ORDER BY empresa_alvo), '-') FROM public.v_caca_candidatos WHERE documento = teste.doc('CA_$nome')")" "oben:1.00"
done
eq CCA "compradores: os 4 status de venda entram" \
  "$(Q "SELECT string_agg(c.n_pedidos || ':' || c.volume, ',' ORDER BY a.n) FROM teste.adm a LEFT JOIN public.v_caca_compradores c ON c.documento = teste.doc('CA_adm_' || a.status)")" "1:1,1:1,1:1,1:1"
eq CDA "candidatos: ativo na oben pelos 4 status → candidato só na colacor" \
  "$(Q "SELECT string_agg(coalesce((SELECT string_agg(empresa_alvo, '+') FROM public.v_caca_candidatos v WHERE v.documento = teste.doc('CA_adm_' || a.status)), '-'), ',' ORDER BY a.n) FROM teste.adm a")" "colacor,colacor,colacor,colacor"
eq CCG "compradores: o gêmeo push/pull conta 1x (n:volume)" \
  "$(Q "SELECT count(*) || ':' || coalesce(sum(n_pedidos)::text, '-') || ':' || coalesce(sum(volume)::text, '-') FROM public.v_caca_compradores WHERE documento = teste.doc('CA_gemeo')")" "1:1:100"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# BLOCO U — RECÊNCIA
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── U/recência: private.customer_metrics_mv ──"
met() { Q "SELECT coalesce((SELECT pedidos_90d || ':' || faturamento_90d || ':' || dias_desde_ultima_compra FROM private.customer_metrics_mv WHERE customer_user_id = teste.uid('$1')), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "RM$k" "MV: o pedido $nome não conta (pedidos_90d:fat_90d:dias)" "$(met "RE_$nome")" "1:1:60"
done
eq RMA "MV: os 4 status de venda entram" \
  "$(Q "SELECT string_agg(coalesce(m.pedidos_90d || ':' || m.faturamento_90d, '-'), ',' ORDER BY a.n) FROM teste.adm a LEFT JOIN private.customer_metrics_mv m ON m.customer_user_id = teste.uid('RE_adm_' || a.status)")" "1:1,1:1,1:1,1:1"
eq RMG "MV: o gêmeo push/pull conta 1x" "$(met RE_gemeo)" "1:100:5"
eq RMC "MV: a cadência conta só pedido com kpi (3 em 60 d → 30 d; o do app sem kpi não entra)" \
  "$(Q "SELECT pedidos_90d || ':' || round(intervalo_medio_dias, 2) FROM private.customer_metrics_mv WHERE customer_user_id = teste.uid('RE_cad')")" "3:30.00"

echo "── U/recência: melhoria_clientes_por_produto ──"
MEL="$TMPD/melhoria.json"
Qs "SELECT public.melhoria_clientes_por_produto('SONDAMELHORIA')" > "$MEL"
mel() { Q "SELECT coalesce((SELECT (e->>'n_pedidos') || ':' || (e->>'valor_12m') FROM jsonb_array_elements(\$j\$$(cat "$MEL")\$j\$::jsonb->'clientes') e WHERE e->>'cliente' = '$1'), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "MM$k" "melhoria: o pedido $nome não conta (n:valor_12m)" "$(mel "ME_$nome")" "1:1.00"
done
eq MMA "melhoria: os 4 status de venda entram" "$(mel ME_adm_faturado),$(mel ME_adm_importado),$(mel ME_adm_separacao),$(mel ME_adm_enviado)" "1:1.00,1:1.00,1:1.00,1:1.00"
eq MMG "melhoria: o gêmeo push/pull conta 1x" "$(mel ME_gemeo)" "1:100.00"

echo "── U/recência: classificar_clientes_fornecedores ──"
Qs "SELECT public.classificar_clientes_fornecedores()" >/dev/null
cl() { Q "SELECT coalesce((SELECT tem_venda_real || ':' || excluir_da_carteira FROM public.cliente_classificacao WHERE user_id = teste.uid('$1')), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "CL$k" "classificar: fornecedor cujo único pedido é $nome não tem venda real (tem_venda:excluir)" "$(cl "CL_$nome")" "false:true"
done
eq CLA "classificar: os 4 status de venda são venda real" "$(cl CL_adm_faturado),$(cl CL_adm_importado),$(cl CL_adm_separacao),$(cl CL_adm_enviado)" "true:false,true:false,true:false,true:false"

echo "── U/recência: v_grupo_comercial ──"
gr() { Q "SELECT coalesce((SELECT qtd_pedidos || ':' || faturamento_total FROM public.v_grupo_comercial WHERE grupo_id = teste.uid('$1')), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "GG$k" "grupo: o pedido $nome não conta (qtd:faturamento)" "$(gr "G_$nome")" "1:1"
done
eq GGA "grupo: os 4 status de venda entram" "$(gr G_adm_faturado),$(gr G_adm_importado),$(gr G_adm_separacao),$(gr G_adm_enviado)" "1:1,1:1,1:1,1:1"
eq GGG "grupo: o gêmeo push/pull conta 1x" "$(gr G_gemeo)" "1:100"
eq GGN "grupo: status desconhecido ENTRA (denylist; a allowlist antiga o perdia)" "$(gr G_novo)" "2:2"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# BLOCO U — PREÇO
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── U/preço: get_regua_preco (precos_cliente e comparaveis) ──"
VIEWER="$(Q "SELECT teste.uid('VIEWER')")"
rg()  { Qs "SELECT (public.get_regua_preco(teste.uid('$1'), teste.uid('produto:$2'), 10, 5, NULL))->>'precos_cliente'"; }
rc()  { Qs "SELECT jsonb_array_length(r->'comparaveis') || ':' || coalesce((SELECT sum((e->>'preco')::numeric) FROM jsonb_array_elements(r->'comparaveis') e)::text, '-') FROM (SELECT public.get_regua_preco('$VIEWER'::uuid, teste.uid('produto:$1'), 10, 5, NULL) r) x"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "RG$k" "régua precos_cliente: sem o preço do $nome" "$(rg "PC_$nome" "PR_$nome")" "[1]"
  eq "RC$k" "régua comparaveis: sem o preço do $nome (n:soma)" "$(rc "PR_$nome")" "1:1"
done
eq RGA "régua precos_cliente: os 4 status de venda entram" \
  "$(rg PC_adm_faturado PR_ADM)|$(rg PC_adm_importado PR_ADM)|$(rg PC_adm_separacao PR_ADM)|$(rg PC_adm_enviado PR_ADM)" "[1]|[1]|[1]|[1]"
eq RCA "régua comparaveis: os 4 status de venda entram (n:soma)" "$(rc PR_ADM)" "4:4"

echo "── U/preço: get_regua_preco_customer360 ──"
r3() { Qs "SELECT coalesce((public.get_regua_preco_customer360(teste.uid('$1'), ARRAY[$2]::bigint[]))->0->>'preco_atual', '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "R3$k" "360: o preco_atual não vem do $nome (que é o MAIS RECENTE)" "$(r3 "PC_$nome" $((3000 + k)))" "1"
done
eq R3A "360: os 4 status de venda dão preco_atual" "$(r3 PC_adm_faturado 3100),$(r3 PC_adm_importado 3100),$(r3 PC_adm_separacao 3100),$(r3 PC_adm_enviado 3100)" "1,1,1,1"
eq R3S "360: código cujo ÚNICO pedido é cancelado não resolve produto" \
  "$(Qs "SELECT coalesce((public.get_regua_preco_customer360(teste.uid('PC_so'), ARRAY[3300]::bigint[]))->0->>'hide_reason', '-')")" "sem_produto"

echo "── U/preço: get_whatsapp_proposta_cotacao ──"
wp() { Q "SELECT coalesce((SELECT preco || ':' || fonte_preco FROM public.get_whatsapp_proposta_cotacao(teste.uid('$1'), 'oben', ARRAY[$2]::bigint[])), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "WP$k" "proposta: o praticado não vem do $nome (preco:fonte)" "$(wp "PC_$nome" $((3000 + k)))" "1:praticado"
done
eq WPA "proposta: os 4 status de venda dão praticado" "$(wp PC_adm_faturado 3100),$(wp PC_adm_importado 3100),$(wp PC_adm_separacao 3100),$(wp PC_adm_enviado 3100)" "1:praticado,1:praticado,1:praticado,1:praticado"

echo "── U/preço: get_ultimos_precos_cliente ──"
up() { Qs "SELECT coalesce((SELECT unit_price::text FROM public.get_ultimos_precos_cliente(teste.uid('$1')) WHERE product_id = teste.uid('produto:$2')), '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "UP$k" "últimos preços: não vem do $nome" "$(up "PC_$nome" "PR_$nome")" "1"
done
eq UPA "últimos preços: os 4 status de venda entram" "$(up PC_adm_faturado PR_ADM),$(up PC_adm_importado PR_ADM),$(up PC_adm_separacao PR_ADM),$(up PC_adm_enviado PR_ADM)" "1,1,1,1"

echo "── U/preço: medir_abaixo_piso_tier ──"
# agrega por (empresa, tier) e o tier só aceita A/B/C: cada predicado tem o SEU par (ver a semente)
mp() { Qs "SELECT coalesce((SELECT total_itens::text FROM public.medir_abaixo_piso_tier(90) WHERE company = '$1' AND tier = '$2'), '-')"; }
MP_PAR=("" "oben A" "oben B" "oben C" "colacor A" "colacor B")
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  # shellcheck disable=SC2086
  eq "MP$k" "abaixo do piso: o item do $nome não conta (total_itens de ${MP_PAR[$k]})" "$(mp ${MP_PAR[$k]})" "1"
done
eq MPA "abaixo do piso: os 4 status de venda entram (total_itens de colacor C)" "$(mp colacor C)" "4"

echo "── U/preço: get_defasagem_cliente ──"
df() { Qs "SELECT coalesce(trim_scale(((public.get_defasagem_cliente(jsonb_build_array(jsonb_build_object('empresa','oben','codigo',$2,'preco',5)), teste.uid('$1')))->0->>'p_last')::numeric)::text, '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "DF$k" "defasagem: a âncora não é o $nome (p_last)" "$(df "PC_$nome" $((3000 + k)))" "1"
done
eq DFA "defasagem: os 4 status de venda ancoram" "$(df PC_adm_faturado 3100),$(df PC_adm_importado 3100),$(df PC_adm_separacao 3100),$(df PC_adm_enviado 3100)" "1,1,1,1"
eq DFN "defasagem: status desconhecido ANCORA (denylist; a allowlist antiga o perdia)" "$(df PC_novo 3200)" "7"

echo "── U/preço: tint_ultimo_preco_cliente ──"
tp() { Q "SELECT coalesce((public.tint_ultimo_preco_cliente(teste.uid('$1'), teste.uid('produto:$2'), 'COR1', NULL))->>'price', '-')"; }
for k in 1 2 3 4 5; do
  nome="$(Q "SELECT nome FROM teste.pred WHERE k = $k")"
  eq "TP$k" "tint: o último preço não vem do $nome" "$(tp "PC_$nome" "PR_$nome")" "1"
done
eq TPA "tint: os 4 status de venda entram" "$(tp PC_adm_faturado PR_ADM),$(tp PC_adm_importado PR_ADM),$(tp PC_adm_separacao PR_ADM),$(tp PC_adm_enviado PR_ADM)" "1,1,1,1"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# A VIEW-GATE e o REFRESH do cron
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── G: a view-gate segue filtrando por papel, e o refresh do cron segue funcionando ──"
gate() { Pq -c "SET test.uid = '$1'" -c "SET ROLE authenticated" -c "SELECT count(*) FROM public.customer_metrics_mv WHERE customer_user_id IN (SELECT teste.uid('RE_adm_' || status) FROM teste.adm)" 2>&1 || true; }
P -q -c "GRANT USAGE ON SCHEMA teste TO authenticated; GRANT SELECT ON ALL TABLES IN SCHEMA teste TO authenticated; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA teste TO authenticated;" >/dev/null
eq GT1 "view-gate: staff (master) lê" "$(gate "$STAFF_UID")" "4"
eq GT2 "view-gate: cliente comum lê 0" "$(gate "$VIEWER")" "0"
eq RF1 "refresh_customer_metrics() (CONCURRENTLY, cron) roda e o MV segue canônico" \
  "$(Q "SELECT public.refresh_customer_metrics()" >/dev/null; met RE_cancelado; met RE_gemeo)" "$(printf '1:1:60\n1:100:5')"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# BLOCO M — a PRE das migrations (re-aplicar é no-op; corpo estranho aborta e preserva TUDO)
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── M: robustez da PRE ──"
# (o case fica numa função: dentro de $( … ) o `)` do padrão fecha a substituição no bash 3.2 do macOS)
desfecho() { case "$1" in *APLICACAO_FALHOU*) echo abortou;; *) echo aplicou;; esac; }
retrato() { Q "SELECT md5(string_agg(x, '|' ORDER BY x)) FROM (
    SELECT md5(prosrc) x FROM pg_proc WHERE oid IN ('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])'::regprocedure, 'public.get_ultimos_precos_cliente(uuid)'::regprocedure, 'public.melhoria_clientes_por_produto(text)'::regprocedure)
    UNION ALL SELECT md5(pg_get_viewdef(c.oid, true)) || coalesce(array_to_string(c.reloptions, ','), '')
                     || coalesce((SELECT string_agg(a::text, ',' ORDER BY a::text) FROM unnest(c.relacl) a), '') FROM pg_class c
     WHERE c.oid IN ('public.v_caca_compradores'::regclass, 'public.v_caca_candidatos'::regclass, 'private.customer_metrics_mv'::regclass, 'public.customer_metrics_mv'::regclass)) s"; }
antes="$(retrato)"
r1="$(aplica "$TMPD/m1.sql")$(aplica "$TMPD/m2.sql")$(aplica "$TMPD/m3.sql")$(aplica "$TMPD/m4.sql")"
case "$r1" in *APLICACAO_FALHOU*) m1="falhou";; *) [ "$(retrato)" = "$antes" ] && m1="no-op" || m1="mudou";; esac
eq M1 "re-aplicar as 4 é no-op (passa e o retrato não muda)" "$m1" "no-op"
# corpo ESTRANHO numa função (comentário a mais): a PRE aborta, e o rollback preserva o estranho E a vizinha.
# Os predecessores voltam primeiro (fixture), para a vizinha ter o que perder se a transação vazasse.
PGOPTIONS="-c search_path=public,pg_catalog" P -q -f "$FIXTURE" >/dev/null 2>&1 || true
P -q <<'SQL' >/dev/null
DO $x$ DECLARE d text := pg_get_functiondef('public.get_ultimos_precos_cliente(uuid)'::regprocedure);
BEGIN EXECUTE replace(d, 'BEGIN', 'BEGIN -- corpo estranho'); END $x$;
SQL
est="$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure")"
reg="$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])'::regprocedure")"
r2="$(aplica "$TMPD/m3.sql")"
m2="$(desfecho "$r2")"
[ "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_ultimos_precos_cliente(uuid)'::regprocedure")" = "$est" ] && m2="$m2+estranho_preservado"
[ "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])'::regprocedure")" = "$reg" ] && m2="$m2+vizinha_intacta"
eq M2 "função com corpo estranho: a PRE aborta, preserva o estranho e a vizinha" "$m2" "abortou+estranho_preservado+vizinha_intacta"
# view estranha (predecessor + um predicado inócuo): idem
P -q <<'SQL' >/dev/null
DO $x$ DECLARE d text := pg_get_viewdef('public.v_caca_candidatos'::regclass, true);
BEGIN EXECUTE 'CREATE OR REPLACE VIEW public.v_caca_candidatos WITH (security_invoker = on) AS ' || replace(d, 'WHERE NOT (EXISTS ( SELECT 1', 'WHERE true AND NOT (EXISTS ( SELECT 1'); END $x$;
SQL
est="$(hv public.v_caca_candidatos)"; viz="$(hv public.v_caca_compradores)"
r3="$(aplica "$TMPD/m1.sql")"
m3="$(desfecho "$r3")"
[ "$(hv public.v_caca_candidatos)" = "$est" ] && m3="$m3+estranho_preservado"
[ "$(hv public.v_caca_compradores)" = "$viz" ] && m3="$m3+vizinha_intacta"
eq M3 "view com corpo estranho: a PRE aborta, preserva a estranha e a vizinha" "$m3" "abortou+estranho_preservado+vizinha_intacta"
# MV estranha: a PRE aborta e o RENAME volta (a MV segue com o nome, a gate segue lendo-a)
P -q <<'SQL' >/dev/null
DO $x$ DECLARE d text := pg_get_viewdef('private.customer_metrics_mv'::regclass, true);
                g text := pg_get_viewdef('public.customer_metrics_mv'::regclass, true);
BEGIN
  -- só a MV fica estranha: a gate volta com o MESMO texto, senão a PRE da gate abortaria antes e
  -- mascararia a da MV (a sabotagem pre_cega ficaria sem dente aqui)
  EXECUTE 'DROP VIEW public.customer_metrics_mv';
  EXECUTE 'DROP MATERIALIZED VIEW private.customer_metrics_mv';
  EXECUTE 'CREATE MATERIALIZED VIEW private.customer_metrics_mv AS ' || replace(rtrim(d, '; '), 'WHERE p.is_employee = false', 'WHERE true AND p.is_employee = false') || ' WITH DATA';
  EXECUTE 'CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON private.customer_metrics_mv (customer_user_id)';
  EXECUTE 'CREATE VIEW public.customer_metrics_mv WITH (security_invoker = off, security_barrier = true) AS ' || g;
END $x$;
SQL
est="$(hv private.customer_metrics_mv)"
r4="$(aplica "$TMPD/m2.sql")"
m4="$(desfecho "$r4")"
[ "$(hv private.customer_metrics_mv)" = "$est" ] && m4="$m4+estranha_preservada"
[ "$(Q "SELECT to_regclass('private.customer_metrics_mv_antiga') IS NULL")" = "t" ] && m4="$m4+sem_antiga"
eq M4 "MV estranha: a PRE aborta, o RENAME volta e nada sobra" "$m4" "abortou+estranha_preservada+sem_antiga"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
if [ $((PASS + FAIL)) -ne "$TOTAL_ESPERADO" ]; then
  echo "❌ HARNESS INCOMPLETO: rodaram $((PASS + FAIL)) asserts, esperado $TOTAL_ESPERADO"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

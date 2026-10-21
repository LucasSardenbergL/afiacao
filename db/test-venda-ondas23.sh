#!/usr/bin/env bash
# Prova PG17 das Ondas 2 (complemento) e 3 (preço) da venda por cliente (Task 9).
# Migration: supabase/migrations/20261021031000_venda_cliente_ondas23.sql (a REAL), aplicada sobre as REAIS
# de route_city_norm, recompra, espinha, gerador e prova por dados. Os helpers das Tasks 5 e 6
# (_mixgap_gaps_compradores, _venda_repasse_base, _venda_repasse_sku_ok, regua_num_finito) entram como
# STUBS com a assinatura EXATA medida na prod (pg_get_function_result, psql-ro 2026-10-20): o gerador os
# consome como caixa-preta, e a regra deles tem prova própria (test-venda-complemento/-repasse).
#
#   C0  ondas 2/3 desligadas → a lista ativa só tem recompra
#   C1  onda_complemento=true → até 3 famílias por comprador da lista (confidence × lift, desempate
#       evidência e família), com `familia`, empresa da linha mais forte, sem SKU/valor; C1b o feedback que
#       suprime é o da farmer; C1c comprador fora da lista não ganha complemento
#   C2  gerar 2× no mesmo dia não duplica; C2b família nova no meio do dia não vira a 4ª
#   C3  janela do complemento = 30 dias (aberta no dia 29, fechada no 30)
#   C4  sombra, histórico e ativa de outro dia não geram complemento/preço
#   P0  onda_preco=true → `preco` só para repasse vigente de comprador da lista (revogado, vencido, tinta,
#       último ≥ alvo, último ausente, 2 donos e comprador fora da lista ficam fora); preco_anterior =
#       maior entre o da aprovação e o ao vivo; P1 2× não duplica
#   P0c a farmer da linha tem de ser o dono único ATUAL (carteira transferida no meio do dia → sem preço)
#   P2  desfecho de preço exige alta sobre o anterior (alvo a < 1% do último: pagar o preço velho = nao_virou)
#       e bruto ≤ anterior com desconto não apurado = nao_virou; acima do anterior = nao_medivel; P2e o pedido
#       é a unidade (90 + 110 sobre 100 não "subiu"); P2f/C3 complemento/preço NÃO exibidos = nao_medivel
#   O1  a lista de recompra continua idêntica a venda_lista_calc (a comparação da Onda 1)
#   M   venda_minhas_sugestoes: ondas do servidor, total/motivo só da recompra, cadência; farmer nunca
#       recebe custo/markup/piso/preco_anterior; não vê a lista de outra farmer
#   A   ACL (has_function_privilege + chamada real 42501)
#   MIG re-aplicar passa; PRE recusa corpo estranho; db/validar-venda-ondas23.sql dá ✅
#
#   bash db/test-venda-ondas23.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-ondas23.sh      # o outro locale (rode os dois)
#   SABOTAGEM=<nome> bash db/test-venda-ondas23.sh               # tem de ficar VERMELHA
#   bash db/test-venda-ondas23.sh --falsificar                   # controle verde + cada sabotagem vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021031000_venda_cliente_ondas23.sql"
MIG_ESPINHA="$REPO_ROOT/supabase/migrations/20261020174221_venda_cliente_espinha.sql"
MIG_RECOMPRA="$REPO_ROOT/supabase/migrations/20261020150000_venda_cliente_recompra.sql"
MIG_CITY_NORM="$REPO_ROOT/supabase/migrations/20260611150000_route_city_norm.sql"
MIG_GERADOR="$REPO_ROOT/supabase/migrations/20261020181743_venda_cliente_gerador.sql"
MIG_PROVA="$REPO_ROOT/supabase/migrations/20261020194332_venda_cliente_historico_prova_dados.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> (`!MARCA` = a postcondição da própria migration aborta com MARCA).
  SABOTAGENS="sem_gate_complemento:C0 sem_gate_preco:C0 top4:C1 vendedor_errado:C1b dup_familia:C2b complemento_qualquer_dia:C4b preco_revogado:P0 preco_vencido:P0 preco_ultimo_acima:P0 preco_dois_donos:P0 preco_dono_farmer:P0c preco_anterior_aprovacao:P0b desfecho_sem_alta:P2a desfecho_bruto:P2c preco_item_isolado:P2e sem_exibicao:P2f total_misturado:M2 motivo_misturado:M3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-ondas23.XXXXXX")"
  echo "══ CONTROLE (mesma invocação, locale ${LOCALE_TESTE:-C}) ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 || ! grep -q "FIM-OK venda-ondas23" "$LOGDIR/controle.log"; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) padrao="${a#*!}"; padrao="${padrao//_/ }" ;;
      *)  padrao="FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-ondas23.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate_complemento) sabotar "WHERE chave = 'onda_complemento' AND valor = 'true'::jsonb) THEN" "WHERE chave = 'onda_complemento') THEN" ;;
  sem_gate_preco)       sabotar "WHERE chave = 'onda_preco' AND valor = 'true'::jsonb) THEN" "WHERE chave = 'onda_preco') THEN" ;;
  top4)                 sabotar "WHERE t.rn <= 3" "WHERE t.rn <= 4" ;;
  vendedor_errado)      sabotar "private._mixgap_gaps_compradores(pf.compradores, ARRAY[pf.farmer_user_id])" \
                                "private._mixgap_gaps_compradores(pf.compradores, '{}'::uuid[])" ;;
  dup_familia)          sabotar "       WHERE NOT EXISTS (SELECT 1 FROM public.venda_sugestao s
                          WHERE s.dia_referencia = p_dia AND s.fase = p_fase AND s.tipo = 'complemento'
                            AND s.farmer_user_id = c.farmer_user_id AND s.comprador_id = c.comprador_id)
" "" ;;
  complemento_qualquer_dia) sabotar "IF p_fase = 'ativa' AND p_dia = (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN" "IF p_fase = 'ativa' THEN" ;;
  preco_revogado)       sabotar "       AND ra.revogado_em IS NULL
       AND ra.valido_ate >= p_dia" "       AND ra.valido_ate >= p_dia" ;;
  preco_vencido)        sabotar "       AND ra.valido_ate >= p_dia
" "
" ;;
  preco_ultimo_acima)   sabotar "     AND b.ultimo_preco < r.preco_alvo" "" ;;
  preco_dois_donos)     sabotar " AND d.n = 1 AND d.dono = r.farmer_user_id" "" ;;
  preco_dono_farmer)    sabotar " AND d.n = 1 AND d.dono = r.farmer_user_id" " AND d.n = 1" ;;
  preco_anterior_aprovacao) sabotar "GREATEST(r.ultimo_preco_na_aprovacao, b.ultimo_preco)" "r.ultimo_preco_na_aprovacao" ;;
  desfecho_sem_alta)    sabotar "AND pp.preco_medio_liq > pp.preco_anterior" "" ;;
  desfecho_bruto)       sabotar "OR pp.preco_medio_bruto <= pp.preco_anterior" "" ;;
  preco_item_isolado)   sabotar "sum(i.valor_liq) FILTER (WHERE i.preco_liq > 0)" "max(i.preco_liq) * sum(i.qtd) FILTER (WHERE i.preco_liq > 0)" ;;
  sem_exibicao)         sabotar "             WHEN a.tipo <> 'recompra' AND a.mostrada_em IS NULL THEN 'nao_medivel'   -- a farmer não viu
" "" ;;
  total_misturado)      sabotar "CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')" \
                                "CASE WHEN bool_and(s.valor_ref IS NOT NULL)" ;;
  motivo_misturado)     sabotar "min(s.motivo_entrada) FILTER (WHERE s.tipo = 'recompra') AS motivo_entrada" "min(s.motivo_entrada) AS motivo_entrada" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# Corpo sabotado = corpo NOVO: reassina o md5 "este" do PRE/PÓS (como faria quem mudasse a função e o
# arquivo juntos). Sem isso o P1 da PÓS aborta o apply e o vermelho não chega ao assert de comportamento.
reassinar() {
  python3 -I - "$MIG_USADA" <<'PY2'
import hashlib, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
for sig, tag, velho in (
    ("CREATE OR REPLACE FUNCTION public.venda_gerar_lista", "$fn$", "5abe897dbcaaf3b70351da896e35b566"),
    ("CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes", "$$", "e38baeb57b7e19c815e45baa77a23810"),
    ("CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos", "$$", "6c962e84f9b821d5612b555e10489616"),
):
    i = s.index(sig); j = s.index("AS " + tag + "\n", i) + len("AS " + tag); k = s.index(tag + ";", j)
    s = s.replace(velho, hashlib.md5(s[j:k].encode()).hexdigest())
open(p, "w", encoding="utf-8").write(s)
PY2
}
if [ -n "${SABOTAGEM:-}" ]; then reassinar; echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"; fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { # $1 = uid, $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}
PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2
M=00000000-0000-0000-0000-0000000000ee;  D2=00000000-0000-0000-0000-0000000000d2
C1=00000000-0000-0000-0000-000000000c01; C2=00000000-0000-0000-0000-000000000c02
C3=00000000-0000-0000-0000-000000000c03; C4=00000000-0000-0000-0000-000000000c04
A4=00000000-0000-0000-0000-000000000a04; C5=00000000-0000-0000-0000-000000000c05
C6=00000000-0000-0000-0000-000000000c06; C7=00000000-0000-0000-0000-000000000c07
C8=00000000-0000-0000-0000-000000000c08; C9=00000000-0000-0000-0000-000000000c09
C10=00000000-0000-0000-0000-000000000c10; C11=00000000-0000-0000-0000-000000000c11

# ── Esquema mínimo com as colunas de prod usadas (o do test-venda-gerador.sh) + stubs das Tasks 5/6 ──
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;   -- como em prod
-- Default privileges do Supabase: relação e função novas NASCEM abertas (a migration tem de REVOGAR).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', p_jobname; END IF;
  RETURN true;
END $$;

CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TABLE public.commercial_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, phone text,
  razao_social text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true);
CREATE TABLE public.customer_visit_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL,
  farmer_id uuid, city text, state text);
CREATE TABLE public.route_schedule (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), weekday smallint NOT NULL, city text NOT NULL,
  uf text NOT NULL, is_daily boolean NOT NULL, ativo boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.route_calendar_override (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), data date NOT NULL,
  cancela_rota boolean NOT NULL, motivo text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, status text,
  account text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, order_date_kpi date);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, descricao text,
  familia text, account text, UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE, customer_user_id uuid,
  product_id uuid, omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric);
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, companies text[],
  status text, started_at timestamptz, completed_at timestamptz);
CREATE TABLE public.vendas_sync_cursor (account text, date_from date, date_to date, completed_at timestamptz, falhou_em timestamptz);

-- venda_repasse_aprovado: DDL REAL da 20261020233000 (colunas e CHECKs que o gerador e o desfecho leem).
CREATE TABLE public.venda_repasse_aprovado (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comprador_id               uuid NOT NULL,
  empresa                    text NOT NULL CHECK (empresa = 'oben'),
  omie_codigo_produto        bigint NOT NULL,
  preco_alvo                 numeric NOT NULL CHECK (preco_alvo > 0 AND preco_alvo < 1e9 AND preco_alvo = round(preco_alvo, 2)),
  ultimo_preco_na_aprovacao  numeric NOT NULL CHECK (ultimo_preco_na_aprovacao > 0 AND ultimo_preco_na_aprovacao < 1e9),
  valido_ate                 date NOT NULL,
  aprovado_por               uuid NOT NULL,
  aprovado_em                timestamptz NOT NULL DEFAULT clock_timestamp(),
  revogado_em                timestamptz NULL,
  revogado_por               uuid NULL,
  substitui_id               uuid NULL REFERENCES public.venda_repasse_aprovado(id),
  CONSTRAINT venda_repasse_alvo_acima_ultimo CHECK (preco_alvo > ultimo_preco_na_aprovacao),
  CONSTRAINT venda_repasse_revogacao_par CHECK ((revogado_em IS NULL) = (revogado_por IS NULL))
);
CREATE UNIQUE INDEX venda_repasse_aprovado_vigente_uq ON public.venda_repasse_aprovado (comprador_id, empresa, omie_codigo_produto)
  WHERE revogado_em IS NULL;

-- Stubs das Tasks 5/6 — assinatura EXATA da prod; o comportamento vem das tabelas t_* abaixo.
CREATE TABLE public.t_gap (comprador uuid, familia text, empresa text, confidence numeric, lift numeric,
  evidence_count bigint, suprimido_por uuid);
CREATE TABLE public.t_base (comprador uuid, sku bigint, ultimo numeric);
CREATE TABLE public.t_tinta (sku bigint);
CREATE FUNCTION private._mixgap_gaps_compradores(p_compradores uuid[], p_vendedores uuid[])
RETURNS TABLE (customer_user_id uuid, familia text, empresa text, confidence numeric, lift numeric,
               evidence_count bigint, feedback_status text, regras uuid[])
LANGUAGE sql STABLE SET search_path = public AS $f$
  SELECT g.comprador, g.familia, g.empresa, g.confidence, g.lift, g.evidence_count, NULL::text, '{}'::uuid[]
    FROM public.t_gap g
   WHERE g.comprador = ANY (p_compradores)
     AND (g.suprimido_por IS NULL OR NOT (g.suprimido_por = ANY (p_vendedores)))
$f$;
CREATE FUNCTION private._venda_repasse_base(p_comprador uuid)
RETURNS TABLE (comprador_id uuid, omie_codigo_produto bigint, data_ancora date, ultimo_preco numeric,
               qtd_ancora numeric, c_last numeric, c_now numeric, c_now_fresco boolean,
               status_defasagem text, motivo text, p_req numeric, alta_custo_perc numeric)
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $f$
  SELECT b.comprador, b.sku, current_date, b.ultimo, 1::numeric, 5::numeric, 6::numeric, true,
         'defasado', NULL::text, NULL::numeric, NULL::numeric
    FROM public.t_base b
   WHERE p_comprador IS NULL OR b.comprador = p_comprador
$f$;
CREATE FUNCTION private._venda_repasse_sku_ok(p_codigo bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $f$
  SELECT NOT EXISTS (SELECT 1 FROM public.t_tinta t WHERE t.sku = p_codigo)
$f$;
CREATE FUNCTION private.regua_num_finito(p numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$ SELECT p IS NOT NULL AND p <> 'NaN'::numeric AND p > -1e15 AND p < 1e15 $f$;

CREATE TABLE t_cfg AS SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje;
CREATE FUNCTION t_ped(p_cli uuid, p_dia date, p_cod bigint, p_qtd numeric DEFAULT 10, p_preco numeric DEFAULT 10,
                      p_desc numeric DEFAULT 0, p_conta text DEFAULT 'oben')
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, account, status, order_date_kpi, created_at)
  VALUES (v, p_cli, p_conta, 'faturado', p_dia, (p_dia + time '15:00') AT TIME ZONE 'UTC');
  INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
  VALUES (v, p_cod, p_qtd, p_preco, p_desc);
END $f$;
-- 3 compras a cada 30 dias terminando em hoje−90 → atrasado hoje (due_ratio 3), não perdido.
CREATE FUNCTION t_atrasado(p_cli uuid, p_cod bigint, p_preco numeric DEFAULT 10, p_conta text DEFAULT 'oben')
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d date := (SELECT t.hoje FROM t_cfg t);
BEGIN
  PERFORM t_ped(p_cli, d - 150, p_cod, 10, p_preco, 0, p_conta);
  PERFORM t_ped(p_cli, d - 120, p_cod, 10, p_preco, 0, p_conta);
  PERFORM t_ped(p_cli, d - 90,  p_cod, 10, p_preco, 0, p_conta);
END $f$;
SQL

echo "── migrations reais: route_city_norm → recompra → espinha → gerador → prova → ondas23 ──"
P -q -f "$MIG_CITY_NORM" >/dev/null
P -q -1 -f "$MIG_RECOMPRA"
P -q -1 -f "$MIG_ESPINHA"
P -q -1 -f "$MIG_GERADOR"
P -q -1 -f "$MIG_PROVA"

# Os predecessores do repo têm de ser os corpos da PROD (o PRE da migration só aceita esses md5).
eq "MIG0 corpos do repo = predecessores medidos na prod" "$(Pq -c "
  SELECT string_agg(md5(prosrc), ',' ORDER BY proname) FROM pg_proc
   WHERE proname IN ('venda_gerar_lista','venda_minhas_sugestoes','venda_fechar_desfechos')")" \
   "d187360234689981761b1cdfac225b2e,0548cd63c19a2f87db94ada259f7657f,75f7d766c2989ee97813b53942a278f1"

P -q -1 -f "$MIG_USADA"

# ── Mundo: F1 e F2 farmers; D2 hunter (2º dono do grupo de C4); M master ────────────────────────────
P -q -v F1="$F1" -v F2="$F2" -v M="$M" -v D2="$D2" -v C1="$C1" -v C2="$C2" -v C3="$C3" -v C4="$C4" -v A4="$A4" \
     -v C5="$C5" -v C6="$C6" -v C7="$C7" -v C8="$C8" -v C9="$C9" -v C10="$C10" -v C11="$C11" <<'SQL'
INSERT INTO public.user_roles VALUES (:'F1','employee'), (:'F2','employee'), (:'M','master'), (:'D2','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'F1','farmer'), (:'F2','farmer'), (:'D2','hunter');
INSERT INTO public.customer_canonical_alias VALUES (:'A4', :'C4', 'active');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES
  (:'C1', :'F1'), (:'C2', :'F1'), (:'C3', :'F1'), (:'C4', :'F1'), (:'A4', :'D2'),
  (:'C5', :'F2'), (:'C6', :'F1'), (:'C7', :'F1'), (:'C8', :'F1'), (:'C9', :'F1'), (:'C10', :'F1'), (:'C11', :'F1');
INSERT INTO public.profiles (user_id, name, phone) VALUES (:'C1', 'Cliente Um', '3199990001');
INSERT INTO public.omie_products (omie_codigo_produto, descricao, familia, account) VALUES
  (101, 'Lixa 101', 'LIXA', 'oben'), (501, 'Verniz A', 'FAM_A', 'oben'), (502, 'Selador B', 'FAM_B', 'colacor');
SELECT t_atrasado(:'C1', 101); SELECT t_atrasado(:'C2', 102, 20); SELECT t_atrasado(:'C3', 103);
SELECT t_atrasado(:'C4', 112); SELECT t_atrasado(:'C6', 108); SELECT t_atrasado(:'C7', 109);
SELECT t_atrasado(:'C8', 110); SELECT t_atrasado(:'C9', 111);
SELECT t_atrasado(:'C10', 114, 100); SELECT t_atrasado(:'C11', 116);

-- Gaps do Mix/Gap. C1: T(4,0) > A(1,5) > B(1,0; ev 9) = C(1,0; ev 9, perde por família) > D(0,6);
-- S (5,0) suprimido pelo feedback da F1; T suprimido só pela F2 (não vale para a F1).
-- A tem uma linha colacor mais fraca: a empresa da família é a da linha mais forte (oben).
INSERT INTO public.t_gap VALUES
  (:'C1','FAM_T','oben',   2.0, 2.0, 3, :'F2'),
  (:'C1','FAM_A','oben',   0.5, 3.0, 5, NULL),
  (:'C1','FAM_A','colacor',0.2, 2.0, 7, NULL),
  (:'C1','FAM_B','colacor',0.5, 2.0, 9, NULL),
  (:'C1','FAM_C','oben',   0.4, 2.5, 9, NULL),
  (:'C1','FAM_D','oben',   0.3, 2.0, 9, NULL),
  (:'C1','FAM_S','oben',   2.5, 2.0, 9, :'F1'),
  (:'C5','FAM_A','oben',   0.9, 3.0, 9, NULL);

-- Último preço AO VIVO (stub de _venda_repasse_base) e SKU de tinta.
INSERT INTO public.t_base VALUES
  (:'C2',102,20), (:'C3',103,25), (:'C3',104,25), (:'C3',105,25), (:'C3',106,30), (:'C3',107,NULL),
  (:'C4',112,10), (:'C5',113,10), (:'C6',108,10), (:'C7',109,10), (:'C8',110,10), (:'C9',111,10),
  (:'C10',114,100), (:'C11',116,10);
INSERT INTO public.t_tinta VALUES (105);

-- Repasses. Vigentes de comprador da lista: C2/102, C6/108, C7/109, C8/110, C9/111 (C2 vale até HOJE).
INSERT INTO public.venda_repasse_aprovado
  (comprador_id, empresa, omie_codigo_produto, preco_alvo, ultimo_preco_na_aprovacao, valido_ate, aprovado_por, revogado_em, revogado_por)
SELECT x.c::uuid, 'oben', x.sku, x.alvo, x.ap, (SELECT hoje FROM t_cfg) + x.dias, :'M'::uuid,
       CASE WHEN x.rev THEN now() END, CASE WHEN x.rev THEN :'M'::uuid END
  FROM (VALUES
    (:'C2', 102, 21.00, 19.00, 0,  false),
    (:'C3', 103, 30.00, 24.00, 30, true),     -- revogado
    (:'C3', 104, 30.00, 24.00, -1, false),    -- vencido ontem
    (:'C3', 105, 30.00, 24.00, 30, false),    -- tinta
    (:'C3', 106, 30.00, 29.00, 30, false),    -- último ao vivo (30) já ≥ alvo
    (:'C3', 107, 30.00, 24.00, 30, false),    -- último ao vivo ausente
    (:'C4', 112, 11.00,  9.00, 30, false),    -- grupo canônico com 2 donos
    (:'C5', 113, 11.00,  9.00, 30, false),    -- comprador fora da lista
    (:'C6', 108, 10.05,  9.90, 30, false),    -- alvo a < 1% do último
    (:'C7', 109, 10.05,  9.90, 30, false),
    (:'C8', 110, 10.05,  9.90, 30, false),
    (:'C9', 111, 11.00,  9.00, 30, false),
    (:'C10', 114, 105.00, 99.00, 30, false),  -- base = média ponderada do dia (100)
    (:'C11', 116, 11.00,  9.00, 30, false)    -- a farmer nunca vê este alvo
  ) AS x(c, sku, alvo, ap, dias, rev);

-- Sync de vendas completo todos os dias (desfecho medível).
INSERT INTO public.fin_sync_log (action, companies, status, started_at)
SELECT 'sync_pedidos', ARRAY[e], 'complete', ((SELECT hoje FROM t_cfg) + g + time '12:00') AT TIME ZONE 'America/Sao_Paulo'
  FROM generate_series(-10, 45) g, unnest(ARRAY['oben','colacor']) e;

UPDATE public.venda_config SET valor = 'true'::jsonb WHERE chave = 'onda_recompra';
SELECT public.venda_recompra_atualizar();
SQL

HOJE="$(Pq -c "SELECT hoje FROM t_cfg")"
conta() { Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE dia_referencia = '$HOJE' AND fase = 'ativa' AND tipo = '$1'"; }
gerar() { Pq -c "SELECT public.venda_gerar_lista('${2:-$HOJE}', '${1:-ativa}')"; }

# ── C0 ondas 2/3 desligadas ────────────────────────────────────────────────────────────────────────
eq "C0 lista ativa com ondas 2/3 desligadas: 10 recompra" "$(gerar)" "10"
eq "C0 nenhum complemento nem preço com as ondas desligadas" "$(conta complemento)|$(conta preco)" "0|0"

P -q -c "UPDATE public.venda_config SET valor = 'true'::jsonb WHERE chave IN ('onda_complemento','onda_preco')"

# ── C1/P0 ondas ligadas ────────────────────────────────────────────────────────────────────────────
eq "C1 2ª rodada com ondas ligadas insere 3 complementos + 7 preços (recompra não duplica)" "$(gerar)" "10"
eq "C1 complemento de C1: top-3 por confidence × lift, empresa da linha mais forte" "$(Pq -c "
  SELECT string_agg(familia || ':' || empresa, ',' ORDER BY familia) FROM public.venda_sugestao
   WHERE tipo = 'complemento' AND comprador_id = '$C1' AND dia_referencia = '$HOJE'")" "FAM_A:oben,FAM_B:colacor,FAM_T:oben"
eq "C1 linha de complemento: família, sem SKU, sem valor, farmer dona, motivo" "$(Pq -c "
  SELECT count(*) FROM public.venda_sugestao
   WHERE tipo = 'complemento' AND familia IS NOT NULL AND omie_codigo_produto IS NULL AND valor_ref IS NULL
     AND qtd_ref IS NULL AND preco_alvo IS NULL AND farmer_user_id = '$F1'
     AND motivo_entrada = 'clientes parecidos compram'")" "3"
eq "C1b feedback que suprime é o da farmer (FAM_S fora; FAM_T, suprimida pela F2, fica)" "$(Pq -c "
  SELECT count(*) FILTER (WHERE familia = 'FAM_S') || '|' || count(*) FILTER (WHERE familia = 'FAM_T')
    FROM public.venda_sugestao WHERE tipo = 'complemento'")" "0|1"
eq "C1c comprador fora da lista (C5, F2) não ganha complemento" "$(Pq -c "
  SELECT count(*) FROM public.venda_sugestao WHERE tipo = 'complemento' AND comprador_id = '$C5'")" "0"

eq "P0 preço só para repasse vigente de comprador da lista" "$(Pq -c "
  SELECT string_agg(omie_codigo_produto || ':' || preco_alvo, ',' ORDER BY omie_codigo_produto)
    FROM public.venda_sugestao WHERE tipo = 'preco' AND dia_referencia = '$HOJE'")" "102:21.00,108:10.05,109:10.05,110:10.05,111:11.00,114:105.00,116:11.00"
eq "P0b preco_anterior = maior entre aprovação e último ao vivo; empresa oben; farmer dona" "$(Pq -c "
  SELECT string_agg(omie_codigo_produto || ':' || preco_anterior::numeric(10,2) || ':' || empresa, ',' ORDER BY omie_codigo_produto)
    FROM public.venda_sugestao WHERE tipo = 'preco' AND farmer_user_id = '$F1'")" "102:20.00:oben,108:10.00:oben,109:10.00:oben,110:10.00:oben,111:10.00:oben,114:100.00:oben,116:10.00:oben"

# ── C2/P1 idempotência ─────────────────────────────────────────────────────────────────────────────
eq "C2 3ª rodada não insere nada" "$(gerar)" "0"
eq "C2 contagens estáveis (recompra|complemento|preço)" "$(conta recompra)|$(conta complemento)|$(conta preco)" "10|3|7"
P -q -c "INSERT INTO public.t_gap VALUES ('$C1','FAM_Z','oben', 3.0, 3.0, 9, NULL)"
gerar >/dev/null
eq "C2b família nova no meio do dia não vira a 4ª de quem já tem complemento" "$(Pq -c "
  SELECT count(*) FROM public.venda_sugestao WHERE tipo = 'complemento' AND comprador_id = '$C1'")" "3"

# ── O1 Onda 1 intacta ──────────────────────────────────────────────────────────────────────────────
eq "O1 recompra da lista ativa = venda_lista_calc (diferença simétrica)" "$(Pq -c "
  SELECT count(*) FROM (
    (SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto FROM public.venda_sugestao
      WHERE dia_referencia = '$HOJE' AND fase = 'ativa' AND tipo = 'recompra'
     EXCEPT SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto FROM private.venda_lista_calc('$HOJE'))
    UNION ALL
    (SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto FROM private.venda_lista_calc('$HOJE')
     EXCEPT SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto FROM public.venda_sugestao
      WHERE dia_referencia = '$HOJE' AND fase = 'ativa' AND tipo = 'recompra')) x")" "0"

# ── C4 só a lista ativa de HOJE ────────────────────────────────────────────────────────────────────
gerar sombra >/dev/null
ONTEM="$(Pq -c "SELECT hoje - 1 FROM t_cfg")"
gerar historico "$ONTEM" >/dev/null
eq "C4 sombra e histórico com ondas ligadas: só recompra" "$(Pq -c "
  SELECT count(*) FILTER (WHERE tipo <> 'recompra') || '|' || (count(*) > 0)::text
    FROM public.venda_sugestao WHERE fase IN ('sombra','historico')")" "0|true"
gerar ativa "$ONTEM" >/dev/null
eq "C4b ativa de outro dia (ontem) não gera complemento/preço" "$(Pq -c "
  SELECT count(*) FILTER (WHERE tipo <> 'recompra') || '|' || (count(*) > 0)::text
    FROM public.venda_sugestao WHERE fase = 'ativa' AND dia_referencia = '$ONTEM'")" "0|true"

# ── P0c carteira transferida no meio do dia: a linha de recompra é da F1, o dono único agora é a F2 ──
P -q -c "UPDATE public.carteira_assignments SET owner_user_id = '$F2' WHERE customer_user_id = '$C2'"
eq "P0c dono único ≠ farmer da linha → sem preço (a ficha dela recusaria)" "$(Pq -c "
  SELECT count(*) FROM private.venda_lista_preco('$HOJE') WHERE comprador_id = '$C2'")" "0"
P -q -c "UPDATE public.carteira_assignments SET owner_user_id = '$F1' WHERE customer_user_id = '$C2'"
eq "P0c controle: com a carteira de volta, o preço de C2 volta" "$(Pq -c "
  SELECT count(*) FROM private.venda_lista_preco('$HOJE') WHERE comprador_id = '$C2'")" "1"

# ── M a lista da farmer ────────────────────────────────────────────────────────────────────────────
MINHAS="$(Pq -c "$(como "$F1" "SELECT public.venda_minhas_sugestoes('$HOJE')")")"
j() { Pq -c "SELECT $1 FROM (SELECT '$MINHAS'::jsonb AS r) x"; }
eq "M1 ondas do servidor expostas" "$(j "r->'ondas'")" '{"preco": true, "recompra": true, "complemento": true}'
eq "M2 total de C1 só da recompra (complemento sem valor não anula o total)" "$(j "(SELECT ((c->>'valor_ref_total')::numeric = 100)::text FROM jsonb_array_elements(r->'compradores') c WHERE c->>'comprador_id' = '$C1')")" "true"
eq "M3 motivo de C1 é o da recompra" "$(j "(SELECT c->>'motivo_entrada' FROM jsonb_array_elements(r->'compradores') c WHERE c->>'comprador_id' = '$C1')")" "maior atraso da carteira"
eq "M4 C1: 3 complementos + 1 recompra com cadência de 30 dias" "$(j "(SELECT string_agg(s->>'tipo' || ':' || COALESCE(s->>'familia', s->>'cadencia_dias'), ',' ORDER BY s->>'tipo', s->>'familia')
     FROM jsonb_array_elements(r->'compradores') c, jsonb_array_elements(c->'sugestoes') s WHERE c->>'comprador_id' = '$C1')")" \
   "complemento:FAM_A,complemento:FAM_B,complemento:FAM_T,recompra:30"
eq "M5 C2: preço com alvo + recompra" "$(j "(SELECT string_agg(s->>'tipo' || ':' || COALESCE(s->>'preco_alvo', '-'), ',' ORDER BY s->>'tipo')
     FROM jsonb_array_elements(r->'compradores') c, jsonb_array_elements(c->'sugestoes') s WHERE c->>'comprador_id' = '$C2')")" "preco:21.00,recompra:-"
eq "M6 farmer nunca recebe custo/markup/piso/preço anterior" "$(j "(lower(r::text) ~ '(cmc|custo|markup|piso|c_now|c_last|preco_anterior|ultimo_preco_na_aprovacao)')::text")" "false"
eq "M7 F2 não vê a lista da F1" "$(Pq -c "$(como "$F2" "SELECT jsonb_array_length(public.venda_minhas_sugestoes('$HOJE')->'compradores')")")" "0"

# ── C3/P2 desfechos ────────────────────────────────────────────────────────────────────────────────
# A farmer VÊ tudo de complemento/preço, menos FAM_T e o preço do SKU 116 (nunca exibidos).
eq "C3 marca exibidas (8 = 2 complementos + 6 preços)" "$(Pq -c "$(como "$F1" "SELECT public.venda_marcar_mostrada(ARRAY(
  SELECT id FROM public.venda_sugestao WHERE dia_referencia = '$HOJE' AND fase = 'ativa' AND tipo <> 'recompra'
     AND familia IS DISTINCT FROM 'FAM_T' AND omie_codigo_produto IS DISTINCT FROM 116))")")" "8"
P -q -v C1="$C1" -v C2="$C2" -v C6="$C6" -v C7="$C7" -v C8="$C8" -v C9="$C9" -v C10="$C10" -v C11="$C11" <<'SQL'
SELECT t_ped(:'C1', (SELECT hoje FROM t_cfg) + 20, 501, 1, 50);              -- família FAM_A no dia 20
SELECT t_ped(:'C2', (SELECT hoje FROM t_cfg) + 3, 102, 10, 20.95);            -- ≥ alvo×0,99 e > anterior
SELECT t_ped(:'C6', (SELECT hoje FROM t_cfg) + 3, 108, 10, 10.00);            -- o preço VELHO
SELECT t_ped(:'C7', (SELECT hoje FROM t_cfg) + 3, 109, 10, 10.02);            -- subiu, a < 1% do alvo
SELECT t_ped(:'C8', (SELECT hoje FROM t_cfg) + 3, 110, 10, 10.00, NULL);      -- bruto = anterior, desconto ?
SELECT t_ped(:'C9', (SELECT hoje FROM t_cfg) + 3, 111, 10, 11.50, NULL);      -- bruto acima, desconto ?
SELECT t_ped(:'C10', (SELECT hoje FROM t_cfg) + 3, 114, 10, 90);              -- 2 linhas: 90 e 110 → média 100
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
SELECT so.id, 114, 10, 110, 0 FROM public.sales_orders so
 WHERE so.customer_user_id = :'C10' AND so.order_date_kpi = (SELECT hoje FROM t_cfg) + 3;
SELECT t_ped(:'C11', (SELECT hoje FROM t_cfg) + 3, 116, 10, 11.50);           -- subiu, mas nunca exibido
SQL
P -q -c "SELECT public.venda_fechar_desfechos('$HOJE'::date + 29)"
eq "C3 dia 29: complemento e preço ainda abertos (janela 30)" "$(Pq -c "
  SELECT count(*) FILTER (WHERE desfecho IS NOT NULL) FROM public.venda_sugestao
   WHERE dia_referencia = '$HOJE' AND fase = 'ativa' AND tipo IN ('complemento','preco')")" "0"
P -q -c "SELECT public.venda_fechar_desfechos('$HOJE'::date + 30)"
eq "C3 dia 30: complemento fecha — FAM_A virou, as outras não" "$(Pq -c "
  SELECT string_agg(familia || ':' || desfecho || COALESCE('/' || desfecho_motivo, ''), ',' ORDER BY familia) FROM public.venda_sugestao
   WHERE tipo = 'complemento' AND dia_referencia = '$HOJE'")" "FAM_A:virou_pedido,FAM_B:nao_virou,FAM_T:nao_medivel/nao_exibida"
desf() { Pq -c "SELECT desfecho || COALESCE('/' || desfecho_motivo, '') FROM public.venda_sugestao
                 WHERE tipo = 'preco' AND dia_referencia = '$HOJE' AND omie_codigo_produto = $1"; }
eq "P2 acima do anterior e do alvo×0,99 → virou_pedido" "$(desf 102)" "virou_pedido"
eq "P2a alvo a < 1%: pagar o preço velho → nao_virou" "$(desf 108)" "nao_virou"
eq "P2b alvo a < 1%: preço subiu acima do anterior → virou_pedido" "$(desf 109)" "virou_pedido"
eq "P2c desconto não apurado com bruto ≤ anterior → nao_virou (desconto só abaixa)" "$(desf 110)" "nao_virou"
eq "P2d desconto não apurado com bruto acima → nao_medivel" "$(desf 111)" "nao_medivel/desconto_nao_apurado"
eq "P2e pedido com 90 e 110 sobre anterior 100 → nao_virou (a média do pedido não subiu)" "$(desf 114)" "nao_virou"
eq "P2f preço nunca exibido, mesmo com venda acima do alvo → nao_medivel/nao_exibida" "$(desf 116)" "nao_medivel/nao_exibida"

# ── A ACL ──────────────────────────────────────────────────────────────────────────────────────────
eq "A funções fechadas a anon/authenticated/PUBLIC" "$(Pq -c "
  SELECT count(*) FROM unnest(ARRAY['public.venda_gerar_lista(date,text)','public.venda_fechar_desfechos(date)',
       'private.venda_lista_complemento(date)','private.venda_lista_preco(date)']) f,
       unnest(ARRAY['anon','authenticated','public']) r
   WHERE has_function_privilege(r, f, 'EXECUTE')")" "0"
eq "A venda_minhas_sugestoes: anon/PUBLIC sem, authenticated com" "$(Pq -c "
  SELECT has_function_privilege('anon','public.venda_minhas_sugestoes(date)','EXECUTE')::text || '|' ||
         has_function_privilege('public','public.venda_minhas_sugestoes(date)','EXECUTE')::text || '|' ||
         has_function_privilege('authenticated','public.venda_minhas_sugestoes(date)','EXECUTE')::text")" "false|false|true"
eq "A farmer chamando a lista privada de preço → 42501" "$(estado "$(como "$F1" "SELECT count(*) FROM private.venda_lista_preco('$HOJE')")")" "42501"
eq "A farmer chamando o gerador → 42501" "$(estado "$(como "$F1" "SELECT public.venda_gerar_lista('$HOJE', 'ativa')")")" "42501"
eq "A farmer não escreve preco_anterior direto" "$(estado "$(como "$F1" "UPDATE public.venda_sugestao SET preco_anterior = 1")")" "42501"
eq "A CHECK: preço sem preco_anterior é recusado (23514)" "$(estado "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, preco_alvo, motivo_entrada) VALUES ('preco','ativa','$HOJE','$F1','$C1','oben',999,10,'x')")" "23514"

# ── MIG re-aplicar e PRE ───────────────────────────────────────────────────────────────────────────
eq "MIG1 re-aplicar a migration passa (PRE aceita este corpo)" "$(estado "$(cat "$MIG_USADA")")" "verde"
DEF_MINHAS="$(Pq -c "SELECT pg_get_functiondef('public.venda_minhas_sugestoes(date)'::regprocedure)")"
P -q -c "CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT current_date) RETURNS jsonb
         LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS \$\$ SELECT '{}'::jsonb \$\$"
SAIDA_PRE="$(P -q -1 -f "$MIG_USADA" 2>&1 || true)"
case "$SAIDA_PRE" in *"PRE FALHOU: public.venda_minhas_sugestoes(date)"*) PRE_OK=ok ;; *) PRE_OK="$SAIDA_PRE" ;; esac
eq "MIG2 PRE recusa corpo estranho da RPC da farmer" "$PRE_OK" "ok"
P -q -c "$DEF_MINHAS"   # devolve o corpo deste arquivo (pg_get_functiondef preserva o prosrc byte a byte)
P -q -1 -f "$MIG_USADA" >/dev/null
VALIDA="$(Pq -f "$REPO_ROOT/db/validar-venda-ondas23.sql")"
case "$VALIDA" in ✅*) VALIDA_OK=ok ;; *) VALIDA_OK="$VALIDA" ;; esac
eq "MIG3 validar-venda-ondas23.sql dá ✅" "$VALIDA_OK" "ok"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-ondas23 (locale $LOC)"

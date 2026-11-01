#!/usr/bin/env bash
# Prova PG17 do AVISO + DECISÃO DE PRAZO NO PEDIDO — migration 20261031200000_venda_prazo_decisao
# (plano Oben PME/PMR, Frente B, PR1; spec docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §2).
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  A1  venda_prazo_aviso: sem sessão, anon e customer → 42501; staff passa
#  A2  universo = regra `vencida_aberta` da view do Ciclo: ATRASADO e A VENCER já passado contam; VENCE HOJE,
#      RECEBIDO, datas inválidas e Infinity NÃO; ABERTO/VENCIDO/PARCIAL (fallback do ingest) só CONTADOS; atraso
#      médio ponderado por saldo; dias e vencimento mais antigo
#  A3  cliente só com RECEBIDO → disponivel com vencido 0 (zero REAL, distinto de indisponível)
#  A4  isolamento por empresa; frescor do sync É da empresa (colacor defasado, colacor_sc sem_sync)
#  A5  sem código → disponivel=false (nunca "cliente OK")
#  A6  PARIDADE executada com v_ciclo_cr_titulos (migration real 20261014120000): mesmo n e mesma soma
#  A7  registrar: grava a leitura do SERVIDOR (o `vencido` do payload é ignorado), total do pedido, autor
#  A8  retry = mesma decisão, criada=false, 1 linha, 1 evento (sem 23505)
#  A9  pedido de OUTRO vendedor → 42501; master registra pedido alheio
#  A10 conta ≠ do pedido → 22023; código Omie que não é do cliente do pedido nesta conta → 22023
#  A11 domínio: recusa sem motivo, decisao inválida, sem_sugestao com sugerida → 22023
#  A12 evento `venda.prazo_sugerido` no outbox: chave = id da decisão, faixa do atraso, sem nome nem R$
#  A13 RLS: vendedora não lê decisão de outra; master lê tudo; anon 42501; INSERT direto 42501
#  A14 ACL das RPCs (anon/PUBLIC fechadas, authenticated aberta)
#  A15 customer no registrar → 42501
#  A16 re-apply idempotente preserva as linhas
#
#   bash db/test-venda-prazo-decisao.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-prazo-decisao.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-prazo-decisao.sh             # tem de ficar VERMELHA
#   bash db/test-venda-prazo-decisao.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261031200000_venda_prazo_decisao.sql"
MIG_VIEWS="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="gate_aviso:A1c recebido_conta:A2a datas_invalidas:A2a ambiguo_somado:A2a infinity_conta:A2a dono_pedido:A9a cliente_pedido:A10b conta_pedido:A10a sem_dedupe:A8a coerencia_aceite:A11f revoke_registrar:POST!P3_FALHOU rls_aberta:A13a tabela_insert_auth:POST!P6_FALHOU vencido_do_cliente:A7b sync_outra_empresa:A4c"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-prazo-decisao.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-prazo-decisao" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  grep -E "^PASS=[0-9]+ FAIL=0$" "$LOGDIR/controle.log" || { echo "❌ controle sem recibo PASS/FAIL"; exit 1; }
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
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [$marca]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5671}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-prazo-decisao.XXXXXX")"
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
  '') ;;
  gate_aviso)        sabotar "RAISE EXCEPTION 'venda_prazo_aviso: exige staff' USING ERRCODE = '42501';" "NULL;" ;;
  recebido_conta)    sabotar "AND r.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')" \
                             "AND r.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL', 'RECEBIDO')"
                     sabotar "(r.status_titulo = 'ATRASADO'" "(r.status_titulo IN ('ATRASADO', 'RECEBIDO')" ;;
  datas_invalidas)   sabotar "AND r.data_vencimento >= r.data_emissao" "" ;;
  ambiguo_somado)    sabotar "(r.status_titulo = 'ATRASADO'" "(r.status_titulo IN ('ATRASADO', 'VENCIDO')" ;;
  infinity_conta)    sabotar "AND r.saldo IS NOT NULL AND r.saldo <> 'NaN' AND r.saldo < 'Infinity' AND r.saldo > 0 AS vencido" \
                             "AND r.saldo IS NOT NULL AND r.saldo <> 'NaN' AND r.saldo > 0 AS vencido" ;;
  dono_pedido)       sabotar "RAISE EXCEPTION 'venda_prazo_decisao_registrar: pedido de outro vendedor' USING ERRCODE = '42501';" "NULL;" ;;
  cliente_pedido)    sabotar "RAISE EXCEPTION 'venda_prazo_decisao_registrar: cliente nao corresponde ao pedido' USING ERRCODE = '22023';" "NULL;" ;;
  conta_pedido)      sabotar "RAISE EXCEPTION 'venda_prazo_decisao_registrar: conta nao corresponde ao pedido' USING ERRCODE = '22023';" "NULL;" ;;
  sem_dedupe)        sabotar "ON CONFLICT (sales_order_id, company) DO NOTHING" "" ;;
  coerencia_aceite)  sabotar "  IF v_decisao = 'aceitou' AND v_escolhida <> v_sugerida AND NOT v_cobre THEN" "  IF false THEN"
                     sabotar "    CHECK (decisao <> 'aceitou' OR parcela_escolhida = parcela_sugerida OR escolhida_cobre)," "    CHECK (true)," ;;
  revoke_registrar)  sabotar "REVOKE ALL ON FUNCTION public.venda_prazo_decisao_registrar(jsonb) FROM PUBLIC, anon;" "" ;;
  rls_aberta)        sabotar "decidido_por = (SELECT auth.uid())" "true" ;;
  tabela_insert_auth) sabotar "REVOKE ALL ON TABLE public.venda_prazo_decisao FROM PUBLIC, anon, authenticated;" "" ;;
  vencido_do_cliente) sabotar "(v_aviso ->> 'vencido')::numeric, (v_aviso ->> 'n_titulos')::int, v_dias," \
                              "coalesce((p ->> 'vencido')::numeric, 0), (v_aviso ->> 'n_titulos')::int, v_dias," ;;
  sync_outra_empresa) sabotar "AND p_company = ANY (l.companies)" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

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

V1=00000000-0000-0000-0000-0000000000a1; V2=00000000-0000-0000-0000-0000000000a2
M=00000000-0000-0000-0000-0000000000ee; CUST=00000000-0000-0000-0000-0000000000cc
CU10=00000000-0000-0000-0000-000000000c10; CU13=00000000-0000-0000-0000-000000000c13
SO1=00000000-0000-0000-0000-00000000f001; SO2=00000000-0000-0000-0000-00000000f002; SO3=00000000-0000-0000-0000-00000000f003
SO4=00000000-0000-0000-0000-00000000f004
como() { # $1 = uid ('' = sem sessão), $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}
aviso() { Pq -c "$(como "$1" "SELECT public.venda_prazo_aviso('$2', $3)::text")"; }
campo() { Pq -c "SELECT (\$j\$$1\$j\$::jsonb ->> '$2')"; }

# ── Esquema mínimo com as MESMAS colunas/ACLs de prod (medido via psql-ro em 2026-10-31) ──────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: função E tabela novas em public NASCEM abertas (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') \$\$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
-- Como em prod (hardening 20260718180000): a implementacao vive em private (SECDEF, EXECUTE p/ authenticated);
-- o wrapper public NAO e executavel por authenticated — policy que o chamasse daria 42501 ao staff.
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
CREATE FUNCTION private.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = 'master') \$\$;
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = private
  AS \$\$ SELECT private.pode_ver_carteira_completa(_uid) \$\$;
REVOKE ALL ON FUNCTION public.pode_ver_carteira_completa(uuid) FROM PUBLIC, anon, authenticated;

CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, omie_codigo_cliente bigint, nome_cliente text,
  omie_codigo_lancamento bigint, numero_documento text, numero_documento_fiscal text,
  data_emissao date, data_vencimento date, valor_documento numeric, saldo numeric, status_titulo text);
ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;   -- staff NÃO lê direto aqui: só pela RPC SECDEF
-- v_titulo_baixas é VIEW em prod; aqui uma tabela com as mesmas colunas/tipos (como em test-fin-ciclo-cliente.sh).
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text, companies text[],
  status text, completed_at timestamptz);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, created_by uuid, account text, customer_user_id uuid, total numeric);
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.omie_customer_account_map (user_id uuid, account text, omie_codigo_cliente bigint);
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
-- analytics_outbox com as constraints REAIS de prod (medidas 2026-10-31).
CREATE TABLE public.analytics_outbox (
  id bigserial PRIMARY KEY, event_id uuid NOT NULL DEFAULT gen_random_uuid(), evento text NOT NULL,
  distinct_id text NOT NULL, user_id uuid, props jsonb NOT NULL DEFAULT '{}'::jsonb, chave_dedup text NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_outbox_chave_dedup_key UNIQUE (chave_dedup),
  CONSTRAINT analytics_outbox_chave_teto CHECK (length(chave_dedup) <= 200),
  CONSTRAINT analytics_outbox_evento_formato CHECK (evento ~ '^[a-z0-9_]+\.[a-z0-9_]+\$'),
  CONSTRAINT analytics_outbox_props_teto CHECK (pg_column_size(props) <= 4096));
ALTER TABLE public.analytics_outbox ENABLE ROW LEVEL SECURITY;

INSERT INTO public.user_roles VALUES ('$M','master'), ('$V1','employee'), ('$V2','employee'), ('$CUST','customer');
INSERT INTO public.omie_customer_account_map VALUES ('$CU10','oben',10), ('$CU10','colacor',12), ('$CU13','oben',13);
INSERT INTO public.sales_orders VALUES
  ('$SO1','$V1','oben','$CU10',1234.5),
  ('$SO2','$V2','oben','$CU10',500),
  ('$SO3','$V1','colacor','$CU10',80),
  ('$SO4','$V1','oben','$CU13',10);
SQL

H="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
P -q <<SQL
DO \$f\$
DECLARE h date := '$H'::date;
BEGIN
  -- Cliente 10 (oben): o universo inteiro num cliente só.
  INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES
    ('oben',10,'CLI DEZ',1001,'D1',h-50,h-20,100,100,'ATRASADO'),      -- vencido 20 d
    ('oben',10,'CLI DEZ',1002,'D2',h-35,h-5, 50, 50,'A VENCER'),       -- lag de sync: vencido 5 d
    ('oben',10,'CLI DEZ',1003,'D3',h-30,h,   30, 30,'VENCE HOJE'),     -- NÃO vencido
    ('oben',10,'CLI DEZ',1004,'D4',h-60,h-30,200,200,'RECEBIDO'),      -- pago (saldo bogus do #396): NÃO conta
    ('oben',10,'CLI DEZ',1005,'D5',h-10,h-40,999,999,'ATRASADO'),      -- vencimento < emissão: inválido
    ('oben',10,'CLI DEZ',1006,'D6',h-40,h-10, 70, 70,'VENCIDO'),       -- fallback do ingest: ambíguo, só contado
    ('oben',10,'CLI DEZ',1007,'D7',h-40,h-10, 10,'Infinity','ATRASADO'), -- saldo infinito: inválido
    ('oben',10,'CLI DEZ',1008,'D8',h-100,h-70,10, 10,'ATRASADO');      -- vencido 70 d (faixa 46-90d)
  INSERT INTO public.v_titulo_baixas VALUES ('oben',1004,'CR',h-28,200,1,32,'titulo');
  -- Cliente 11 (oben): só recebido → vencido 0 real.
  INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES
    ('oben',11,'CLI ONZE',1101,'E1',h-60,h-30,300,300,'RECEBIDO');
  -- Cliente 12 (colacor): vencido 500 — isolamento por empresa.
  INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES
    ('colacor',12,'CLI DOZE',1201,'F1',h-40,h-10,500,500,'ATRASADO');
  INSERT INTO public.fin_sync_log (action, companies, status, completed_at) VALUES
    ('sync_contas_receber', ARRAY['oben'],    'complete', now() - interval '2 hours'),
    ('sync_contas_receber', ARRAY['colacor'], 'complete', now() - interval '30 hours'),
    ('sync_contas_receber', ARRAY['oben'],    'error',    now());
END
\$f\$;
SQL

# Migration REAL das views do Ciclo (paridade executada) e depois a desta prova.
P -q -f "$MIG_VIEWS"
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then
  cat "$WORK/apply.log"; echo "APLICACAO FALHOU"; exit 1
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# A1 gate
eq "A1a sem sessão -> 42501" "$(estado "$(como "" "SELECT public.venda_prazo_aviso('oben', 10);")")" "42501"
eq "A1b anon -> 42501" "$(estado "SET ROLE anon; SELECT public.venda_prazo_aviso('oben', 10);")" "42501"
eq "A1c customer -> 42501" "$(estado "$(como "$CUST" "SELECT public.venda_prazo_aviso('oben', 10);")")" "42501"

# A2 universo do cliente 10
J10="$(aviso "$V1" oben 10)"
eq "A2a vencido = 100+50+10 (ATRASADO, A VENCER passado, 70 d)" "$(campo "$J10" vencido)" "160"
eq "A2b n_titulos = 3" "$(campo "$J10" n_titulos)" "3"
eq "A2c dias_vencido_max = 70" "$(campo "$J10" dias_vencido_max)" "70"
eq "A2d vencimento mais antigo = h-70" "$(campo "$J10" vencimento_mais_antigo)" "$(Pq -c "SELECT '$H'::date - 70")"
eq "A2e atraso medio ponderado = (100*20+50*5+10*70)/160 = 18.4" "$(campo "$J10" atraso_medio_vencido_dias)" "18.4"
eq "A2f ambiguos = 1 (VENCIDO do ingest)" "$(campo "$J10" n_ambiguos)" "1"
eq "A2g invalidos = 2 (datas, Infinity)" "$(campo "$J10" n_invalidos)" "2"
eq "A2h disponivel" "$(campo "$J10" disponivel)" "true"
eq "A2i qualidade oben = ok (sync 2 h)" "$(campo "$J10" qualidade)" "ok"

# A3 zero real
J11="$(aviso "$V1" oben 11)"
eq "A3a só recebido -> disponivel true" "$(campo "$J11" disponivel)" "true"
eq "A3b só recebido -> vencido 0" "$(campo "$J11" vencido)" "0"
eq "A3c só recebido -> dias null" "$(Pq -c "SELECT coalesce(\$j\$$J11\$j\$::jsonb ->> 'dias_vencido_max', 'NULO')")" "NULO"

# A4 isolamento por empresa + frescor por empresa
eq "A4a cliente 12 na oben -> 0" "$(campo "$(aviso "$V1" oben 12)" vencido)" "0"
J12="$(aviso "$V1" colacor 12)"
eq "A4b cliente 12 na colacor -> 500" "$(campo "$J12" vencido)" "500"
eq "A4c qualidade colacor = defasado (30 h)" "$(campo "$J12" qualidade)" "defasado"
eq "A4d colacor_sc sem log -> sem_sync" "$(campo "$(aviso "$V1" colacor_sc 12)" qualidade)" "sem_sync"

# A5 sem código
eq "A5a codigo 0 -> indisponivel" "$(campo "$(aviso "$V1" oben 0)" disponivel)" "false"
eq "A5b codigo null -> motivo sem_codigo" "$(campo "$(aviso "$V1" oben NULL)" motivo)" "sem_codigo"

# A6 paridade com a view do Ciclo (owner lê a view; a RPC SECDEF lê como owner)
eq "A6a n_titulos = view vencida_aberta" "$(campo "$J10" n_titulos)" \
   "$(Pq -c "SELECT count(*) FROM public.v_ciclo_cr_titulos WHERE company='oben' AND omie_codigo_cliente=10 AND situacao='vencida_aberta'")"
eq "A6b soma = view vencida_aberta" "$(campo "$J10" vencido)" \
   "$(Pq -c "SELECT sum(saldo) FROM public.v_ciclo_cr_titulos WHERE company='oben' AND omie_codigo_cliente=10 AND situacao='vencida_aberta'")"
eq "A6c a view não é trivial (tem paga e status_ambiguo no mesmo cliente)" \
   "$(Pq -c "SELECT string_agg(situacao, ',' ORDER BY situacao) FROM (SELECT DISTINCT situacao FROM public.v_ciclo_cr_titulos WHERE company='oben' AND omie_codigo_cliente=10) s")" \
   "paga,status_ambiguo,vencida_aberta"

# A7 registrar — payload manda vencido=999 (ignorado) e as condições
PAY1="{\"sales_order_id\":\"$SO1\",\"company\":\"oben\",\"omie_codigo_cliente\":10,\"nome_cliente\":\"CLI DEZ\",\"vencido\":999,\"parcela_habitual\":\"003\",\"parcela_sugerida\":\"002\",\"parcela_escolhida\":\"002\",\"decisao\":\"aceitou\",\"desfecho_envio\":\"enviado\"}"
R1="$(Pq -c "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY1\$p\$::jsonb)::text")")"
eq "A7a registrar -> criada=true" "$(campo "$R1" criada)" "true"
ID1="$(campo "$R1" id)"
eq "A7b vencido gravado é o do SERVIDOR (160), não o do payload (999)" "$(Pq -c "SELECT vencido_no_momento FROM public.venda_prazo_decisao WHERE id='$ID1'")" "160"
eq "A7c n_titulos/dias gravados" "$(Pq -c "SELECT n_titulos || '/' || dias_vencido_max FROM public.venda_prazo_decisao WHERE id='$ID1'")" "3/70"
eq "A7d total do pedido vem de sales_orders" "$(Pq -c "SELECT total_pedido FROM public.venda_prazo_decisao WHERE id='$ID1'")" "1234.5"
eq "A7e decidido_por = auth.uid()" "$(Pq -c "SELECT decidido_por FROM public.venda_prazo_decisao WHERE id='$ID1'")" "$V1"
eq "A7f decisao/sugerida/escolhida" "$(Pq -c "SELECT decisao||'|'||parcela_sugerida||'|'||parcela_escolhida FROM public.venda_prazo_decisao WHERE id='$ID1'")" "aceitou|002|002"

# A8 retry
# `|| echo` segura o set -e: se o retry LANÇAR (23505 sem o ON CONFLICT), o assert A8a é quem acusa.
R1b="$(Pq -c "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY1\$p\$::jsonb)::text")" 2>/dev/null || echo '{"criada":"LANCOU"}')"
eq "A8a retry -> criada=false e mesmo id" "$(campo "$R1b" criada)|$(campo "$R1b" id)" "false|$ID1"
eq "A8b retry -> 1 linha" "$(Pq -c "SELECT count(*) FROM public.venda_prazo_decisao WHERE sales_order_id='$SO1'")" "1"
eq "A8c retry -> 1 evento" "$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='venda.prazo_sugerido'")" "1"

# A9 dono do pedido
PAY2="{\"sales_order_id\":\"$SO1\",\"company\":\"oben\",\"omie_codigo_cliente\":10,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A9a outro vendedor no pedido de V1 -> 42501" "$(estado "$(como "$V2" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY2\$p\$::jsonb);")")" "42501"
PAY3="{\"sales_order_id\":\"$SO2\",\"company\":\"oben\",\"omie_codigo_cliente\":10,\"parcela_sugerida\":\"999\",\"parcela_escolhida\":\"003\",\"decisao\":\"recusou\",\"motivo\":\"cliente_combinou_pagamento\",\"desfecho_envio\":\"bloqueado_credito\"}"
eq "A9b master registra pedido alheio" "$(campo "$(Pq -c "$(como "$M" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY3\$p\$::jsonb)::text")")" criada)" "true"

# A10 conta e cliente têm de corresponder ao pedido
PAY4="{\"sales_order_id\":\"$SO1\",\"company\":\"colacor\",\"omie_codigo_cliente\":12,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A10a conta colacor num pedido oben -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY4\$p\$::jsonb);")")" "22023"
PAY5="{\"sales_order_id\":\"$SO3\",\"company\":\"colacor\",\"omie_codigo_cliente\":10,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A10b codigo 10 nao e do cliente na colacor (mapa diz 12) -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY5\$p\$::jsonb);")")" "22023"
PAY6="{\"sales_order_id\":\"$SO3\",\"company\":\"colacor\",\"omie_codigo_cliente\":12,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"erro\"}"
eq "A10c codigo 12 na colacor (mapa confere) -> criada" "$(campo "$(Pq -c "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY6\$p\$::jsonb)::text")")" criada)" "true"
PAY6b="{\"sales_order_id\":\"00000000-0000-0000-0000-00000000ffff\",\"company\":\"oben\",\"omie_codigo_cliente\":10,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A10d pedido inexistente -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY6b\$p\$::jsonb);")")" "22023"

# A11 domínio
PAY7="{\"sales_order_id\":\"$SO4\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":\"999\",\"parcela_escolhida\":\"003\",\"decisao\":\"recusou\",\"desfecho_envio\":\"enviado\"}"
eq "A11a recusou sem motivo -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY7\$p\$::jsonb);")")" "22023"
PAY8="{\"sales_order_id\":\"$SO4\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":\"999\",\"parcela_escolhida\":\"003\",\"decisao\":\"talvez\",\"desfecho_envio\":\"enviado\"}"
eq "A11b decisao fora do dominio -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY8\$p\$::jsonb);")")" "22023"
PAY9="{\"sales_order_id\":\"$SO4\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":\"999\",\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A11c sem_sugestao com parcela_sugerida -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY9\$p\$::jsonb);")")" "22023"
PAY10="{\"sales_order_id\":\"nao-e-uuid\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":null,\"parcela_escolhida\":\"003\",\"decisao\":\"sem_sugestao\",\"desfecho_envio\":\"enviado\"}"
eq "A11d uuid invalido -> 22023 (nao 22P02 cru)" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY10\$p\$::jsonb);")")" "22023"
PAY11="{\"sales_order_id\":\"$SO4\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":\"002\",\"parcela_escolhida\":\"003\",\"decisao\":\"aceitou\",\"desfecho_envio\":\"enviado\"}"
eq "A11f aceitou com escolhida <> sugerida e sem escolhida_cobre -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY11\$p\$::jsonb);")")" "22023"
PAY12="{\"sales_order_id\":\"$SO4\",\"company\":\"oben\",\"omie_codigo_cliente\":13,\"parcela_sugerida\":\"002\",\"parcela_escolhida\":\"002\",\"decisao\":\"ignorou\",\"desfecho_envio\":\"enviado\"}"
eq "A11g ignorou com escolhida = sugerida -> 22023" "$(estado "$(como "$V1" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY12\$p\$::jsonb);")")" "22023"
eq "A11e nada gravado para o pedido 4" "$(Pq -c "SELECT count(*) FROM public.venda_prazo_decisao WHERE sales_order_id='$SO4'")" "0"

# A12 evento no outbox
eq "A12a chave = ledger:venda.prazo_sugerido:<id>" "$(Pq -c "SELECT chave_dedup FROM public.analytics_outbox WHERE user_id='$V1' AND props->>'company'='oben'")" "ledger:venda.prazo_sugerido:$ID1"
eq "A12b faixa 46-90d, decisao, sem nome e sem R$" \
   "$(Pq -c "SELECT (props->>'faixa_vencido')||'|'||(props->>'decisao')||'|'||(props ? 'nome_cliente')||'|'||(props ? 'vencido') FROM public.analytics_outbox WHERE chave_dedup='ledger:venda.prazo_sugerido:$ID1'")" \
   "46-90d|aceitou|false|false"
eq "A12c 3 decisoes = 3 eventos (uma por fato)" "$(Pq -c "SELECT (SELECT count(*) FROM public.venda_prazo_decisao) || '/' || (SELECT count(*) FROM public.analytics_outbox WHERE evento='venda.prazo_sugerido')")" "3/3"

# A13 RLS da tabela
eq "A13a V2 nao le a decisao de V1 (ve só a sua: nenhuma)" "$(Pq -c "$(como "$V2" "SELECT count(*) FROM public.venda_prazo_decisao")")" "0"
eq "A13b V1 le as suas (2)" "$(Pq -c "$(como "$V1" "SELECT count(*) FROM public.venda_prazo_decisao")")" "2"
eq "A13c master le tudo (3)" "$(Pq -c "$(como "$M" "SELECT count(*) FROM public.venda_prazo_decisao")")" "3"
eq "A13d anon SELECT -> 42501" "$(estado "SET ROLE anon; SELECT count(*) FROM public.venda_prazo_decisao;")" "42501"
eq "A13e INSERT direto por staff -> 42501 (1 writer = RPC)" "$(estado "$(como "$V1" "INSERT INTO public.venda_prazo_decisao (sales_order_id, company, omie_codigo_cliente, vencido_no_momento, n_titulos, parcela_escolhida, decisao, desfecho_envio, decidido_por) VALUES ('$SO4','oben',13,0,0,'003','sem_sugestao','enviado','$V1');")")" "42501"
eq "A13f UPDATE direto por staff -> 42501" "$(estado "$(como "$V1" "UPDATE public.venda_prazo_decisao SET motivo='x' WHERE id='$ID1';")")" "42501"

# A14 ACL das RPCs
eq "A14a anon sem EXECUTE nas 2 RPCs" "$(Pq -c "SELECT has_function_privilege('anon','public.venda_prazo_aviso(text,bigint)','EXECUTE')::text || has_function_privilege('anon','public.venda_prazo_decisao_registrar(jsonb)','EXECUTE')::text")" "falsefalse"
eq "A14b authenticated com EXECUTE nas 2 RPCs" "$(Pq -c "SELECT has_function_privilege('authenticated','public.venda_prazo_aviso(text,bigint)','EXECUTE')::text || has_function_privilege('authenticated','public.venda_prazo_decisao_registrar(jsonb)','EXECUTE')::text")" "truetrue"

# A15 customer no registrar
eq "A15 customer -> 42501" "$(estado "$(como "$CUST" "SELECT public.venda_prazo_decisao_registrar(\$p\$$PAY1\$p\$::jsonb);")")" "42501"

# A16 re-apply idempotente
FOTO="$(Pq -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.venda_prazo_decisao")"
eq "A16a re-apply idempotente" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then echo verde; else echo vermelho; fi)" "verde"
eq "A16b re-apply preserva as decisoes" "$(Pq -c "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.venda_prazo_decisao")" "$FOTO"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-prazo-decisao"

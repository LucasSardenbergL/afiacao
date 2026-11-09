#!/usr/bin/env bash
# Prova PG17 da FILA DE COBRANÇA COM ESTADO E DONA + COORTE CONGELADA — migration 20261031210000_cobranca_fila
# (plano Oben PME/PMR, Frente B, PR2; spec docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §3/§7).
#
# O que prova EXECUTANDO:
#  C1  coorte selada por TÍTULO a partir da view real (migration 20261014120000): cabeçalho = detalhe; só títulos
#      `vencida_aberta`; reaplicar NÃO acrescenta nem reabre (mesmo com vencido novo no dia seguinte)
#  C2  fila: gestão vê tudo; a dona vê só os seus; vendedora sem carteira vê nada; customer/anon 42501; ordem por
#      faixa e saldo; cliente sem mapa/carteira → dona NULL (só gestão); estado default a_contatar
#  C3  registrar: cria o caso UMA vez (2 chamadas = 1 caso, 1 abertura); dona não dona → 42501; gestão pode
#  C4  máquina de estados: contato/nota/whatsapp NÃO mudam estado (promessa/disputa não somem); estado igual → 22023;
#      sair de disputa exige nota; para_estado=promessa pela ação errada → 22023
#  C5  promessa: identidade própria, substitui a anterior, situação DERIVADA (aberta/vencida/cumprida pelo saldo)
#  C6  fechar quitado só com saldo 0 na view (23514 enquanto houver vencido); cancelado só gestão com nota;
#      caso fechado não renasce o mesmo: a fila volta a `a_contatar` SÓ se a view ainda tem vencido (novo caso)
#  C7  sensor `cobranca.estado_mudou`: 1 evento por mudança de ESTADO (contato não emite), chave = id do evento,
#      props sem nome/R$
#  C8  régua do dia: D−2 só a vencer; D+1/D+7 pela régua vencida; telefone do mapa; dona/gestão
#  C9  RLS/ACL: tabelas sem escrita para authenticated; dona lê o seu caso, outra não; helpers de dona fechados
#  C10 re-apply idempotente preserva casos/eventos
#
#   bash db/test-cobranca-fila.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-cobranca-fila.sh
#   bash db/test-cobranca-fila.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261031210000_cobranca_fila.sql"
MIG_VIEWS="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"
# Régua com nome pela fonte da fila (QA pós-Publish 2026-11-01): aplicada ANTES do C8d (o C1d re-aplica a MIG original).
MIG_NOME="$REPO_ROOT/supabase/migrations/20261101120000_cobranca_regua_nome_cliente.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="gate_fila:C2e dona_ve_tudo:C2b sela_duas_vezes:C1d contato_muda_estado:C4a quitado_sem_conciliar:C6a cancelar_sem_gestao:C6c coorte_so_vencida:POST!P6_FALHOU pode_agir_aberto:C3c dona_nula_fail_open:C3d evento_em_contato:C7a regua_d2_vencido:C8b regua_nome_fonte:C8d revoke_dona:POST!P2_FALHOU tabela_insert_auth:POST!P3_FALHOU dona_de_abertura:C11a disputa_por_promessa:C12"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-cobranca-fila.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK cobranca-fila" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5673}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-cobranca-fila.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
MIG_NOME_USADA="$WORK/mig-nome.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cp "$MIG" "$MIG_USADA"
cp "$MIG_NOME" "$MIG_NOME_USADA"

sabotar() {
  python3 -I - "${ALVO:-$MIG_USADA}" "$1" "$2" <<'PY'
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
  gate_fila)            sabotar "RAISE EXCEPTION 'cobranca_fila: exige staff' USING ERRCODE = '42501';" "NULL;" ;;
  dona_ve_tudo)         sabotar "   WHERE v_gestao OR d.dona = v_uid
   ORDER BY CASE WHEN d.dias_vencido_max IS NULL" "   WHERE true
   ORDER BY CASE WHEN d.dias_vencido_max IS NULL" ;;
  sela_duas_vezes)      sabotar "    IF EXISTS (SELECT 1 FROM public.cobranca_coorte c WHERE c.company = v_company) THEN
      CONTINUE;
    END IF;" "" ;;
  contato_muda_estado)  sabotar "    UPDATE public.cobranca_caso SET nota_atual = coalesce(v_nota, nota_atual),
           proximo_contato_em = coalesce(v_prox, proximo_contato_em), atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, canal, nota, autor)" "    UPDATE public.cobranca_caso SET estado = 'contatado', nota_atual = coalesce(v_nota, nota_atual),
           proximo_contato_em = coalesce(v_prox, proximo_contato_em), atualizado_em = now(), atualizado_por = v_uid
     WHERE id = v_caso.id;
    INSERT INTO public.cobranca_evento (caso_id, tipo, canal, nota, autor)" ;;
  quitado_sem_conciliar) sabotar "      IF NOT coalesce(public.cobranca_quitacao_ok(v_company, v_codigo), false) THEN" "      IF false THEN" ;;
  cancelar_sem_gestao)  sabotar "    ELSIF NOT v_gestao OR v_nota IS NULL THEN" "    ELSIF v_nota IS NULL THEN" ;;
  coorte_so_vencida)    sabotar "     WHERE t.company = v_company AND t.situacao = 'vencida_aberta';
  END LOOP;" "     WHERE t.company = v_company AND t.situacao IN ('vencida_aberta', 'paga');
  END LOOP;" ;;
  pode_agir_aberto)     sabotar "    OR coalesce(public.cobranca_dona(p_company, p_codigo) = p_uid, false)" "    OR true" ;;
  # Duas defesas independentes contra o NULL da dona ausente (helper e chamador): a falsificação tira AS DUAS.
  dona_nula_fail_open)  sabotar "    OR coalesce(public.cobranca_dona(p_company, p_codigo) = p_uid, false)" "    OR public.cobranca_dona(p_company, p_codigo) = p_uid"
                        sabotar "  IF NOT coalesce(public.cobranca_pode_agir(v_uid, v_company, v_codigo), false) THEN" "  IF NOT public.cobranca_pode_agir(v_uid, v_company, v_codigo) THEN" ;;
  evento_em_contato)    sabotar "  IF v_acao IN ('estado', 'promessa', 'fechar') THEN
    SELECT v.dias_vencido_max INTO v_dias" "  IF v_acao IN ('estado', 'promessa', 'fechar', 'contato') THEN
    SELECT v.dias_vencido_max INTO v_dias" ;;
  regua_d2_vencido)     sabotar "(r.data_vencimento = v_hoje + 2 AND r.status_titulo IN ('A VENCER', 'VENCE HOJE'))" "(r.data_vencimento = v_hoje + 2)" ;;
  regua_nome_fonte)     ALVO="$MIG_NOME_USADA" sabotar "(SELECT max(nullif(btrim(p.name), '')) FROM public.omie_customer_account_map m" "(SELECT NULL::text FROM public.omie_customer_account_map m" ;;
  revoke_dona)          sabotar "REVOKE ALL ON FUNCTION public.cobranca_dona(text, bigint) FROM PUBLIC, anon;" "" ;;
  dona_de_abertura)     sabotar "    SELECT p.*, public.cobranca_dona(p.company, p.omie_codigo_cliente) AS dona" "    SELECT p.*, coalesce((SELECT c.dona_user_id FROM public.cobranca_caso c WHERE c.id = p.caso_id), public.cobranca_dona(p.company, p.omie_codigo_cliente)) AS dona"
                        sabotar "  UPDATE public.cobranca_caso SET dona_user_id = public.cobranca_dona(v_company, v_codigo) WHERE id = v_caso.id;" "" ;;
  disputa_por_promessa) sabotar "  IF v_de = 'disputa' AND v_acao IN ('estado', 'promessa', 'fechar') AND v_nota IS NULL THEN" "  IF v_de = 'disputa' AND v_acao IN ('estado', 'fechar') AND v_nota IS NULL THEN" ;;
  tabela_insert_auth)   sabotar "REVOKE ALL ON TABLE public.cobranca_caso, public.cobranca_promessa, public.cobranca_evento FROM PUBLIC, anon, authenticated;" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
V1=00000000-0000-0000-0000-0000000000a1; V2=00000000-0000-0000-0000-0000000000a2; V3=00000000-0000-0000-0000-0000000000a3
M=00000000-0000-0000-0000-0000000000ee; CUST=00000000-0000-0000-0000-0000000000cc
CU10=00000000-0000-0000-0000-000000000c10; CU20=00000000-0000-0000-0000-000000000c20; CU30=00000000-0000-0000-0000-000000000c30
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }
reg() { Pq -c "$(como "$1" "SELECT public.cobranca_caso_registrar(\$p\$$2\$p\$::jsonb)::text")"; }
reg_estado() { estado "$(como "$1" "SELECT public.cobranca_caso_registrar(\$p\$$2\$p\$::jsonb);")"; }
fila() { Pq -c "$(como "$1" "SELECT string_agg(omie_codigo_cliente || ':' || estado || ':' || coalesce(faixa,'-') || ':' || coalesce(dona_user_id::text,'sem-dona'), ' ' ORDER BY omie_codigo_cliente) FROM public.cobranca_fila('oben')")"; }
fila_ordem() { Pq -c "$(como "$1" "SELECT string_agg(omie_codigo_cliente::text, ' ') FROM (SELECT omie_codigo_cliente FROM public.cobranca_fila('oben')) f")"; }

P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') \$\$;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
-- Como em prod (20260718180000): implementacao em private (SECDEF, EXECUTE p/ authenticated); wrapper public FECHADO.
CREATE SCHEMA private; GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
CREATE FUNCTION private.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = 'master') \$\$;
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = private
  AS \$\$ SELECT private.pode_ver_carteira_completa(_uid) \$\$;
REVOKE ALL ON FUNCTION public.pode_ver_carteira_completa(uuid) FROM PUBLIC, anon, authenticated;
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text, companies text[], status text, completed_at timestamptz);
INSERT INTO public.fin_sync_log (action, companies, status, completed_at) VALUES ('sync_contas_receber', ARRAY['oben'], 'complete', now() - interval '1 hour');
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, phone text, updated_at timestamptz DEFAULT now());
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, omie_codigo_cliente bigint, nome_cliente text,
  omie_codigo_lancamento bigint, numero_documento text, numero_documento_fiscal text,
  data_emissao date, data_vencimento date, valor_documento numeric, saldo numeric, status_titulo text);
ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.v_titulo_baixas (company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
CREATE TABLE public.omie_customer_account_map (user_id uuid, account text, omie_codigo_cliente bigint);
CREATE TABLE public.omie_clientes_nao_vinculados (empresa text, omie_codigo_cliente bigint, razao_social text, nome_fantasia text);
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.carteira_assignments (customer_user_id uuid, owner_user_id uuid, eligible boolean, updated_at timestamptz DEFAULT now());
ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.analytics_outbox (
  id bigserial PRIMARY KEY, event_id uuid NOT NULL DEFAULT gen_random_uuid(), evento text NOT NULL,
  distinct_id text NOT NULL, user_id uuid, props jsonb NOT NULL DEFAULT '{}'::jsonb, chave_dedup text NOT NULL,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_outbox_chave_dedup_key UNIQUE (chave_dedup),
  CONSTRAINT analytics_outbox_evento_formato CHECK (evento ~ '^[a-z0-9_]+\.[a-z0-9_]+\$'),
  CONSTRAINT analytics_outbox_props_teto CHECK (pg_column_size(props) <= 4096));
ALTER TABLE public.analytics_outbox ENABLE ROW LEVEL SECURITY;

INSERT INTO public.user_roles VALUES ('$M','master'), ('$V1','employee'), ('$V2','employee'), ('$V3','employee'), ('$CUST','customer');
INSERT INTO public.profiles (user_id, name, phone) VALUES ('$V1','Regina',NULL), ('$V2','Tatyana',NULL), ('$CU10','Marcenaria Dez','48999990010'), ('$CU20','Moveis Vinte','');
-- cliente 10 e 20 → V1; cliente 30 → V2; cliente 40 sem mapa (sem dona)
INSERT INTO public.omie_customer_account_map VALUES ('$CU10','oben',10), ('$CU20','oben',20), ('$CU30','oben',30);
INSERT INTO public.carteira_assignments VALUES ('$CU10','$V1',true,now()), ('$CU20','$V1',true,now()), ('$CU30','$V2',true,now());
SQL

H="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
P -q <<SQL
DO \$f\$
DECLARE h date := '$H'::date;
BEGIN
  INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES
    ('oben',10,'CLI DEZ',1001,'D1',h-50,h-20,100,100,'ATRASADO'),    -- 20 d  (<=45d)
    ('oben',10,'CLI DEZ',1002,'D2',h-90,h-60,200,200,'ATRASADO'),    -- 60 d  (46-90d) → cliente 10 faixa 46-90d, saldo 300
    ('oben',10,'CLI DEZ',1003,'D3',h-60,h-30,500,500,'RECEBIDO'),    -- pago sem baixa: NÃO entra na coorte
    ('oben',20,'CLI VINTE',2001,'E1',h-30,h-10, 50, 50,'A VENCER'),  -- lag de sync: 10 d (<=45d), saldo 50
    ('oben',30,'CLI TRINTA',3001,'F1',h-200,h-120,800,800,'ATRASADO'), -- >90d, saldo 800, dona V2
    ('oben',40,'CLI QUARENTA',4001,'G1',h-40,h-5, 30, 30,'ATRASADO'),  -- sem mapa → sem dona
    ('oben',50,'CLI D2',5001,'H1',h-28,h+2, 70, 70,'A VENCER'),      -- régua D-2 (a vencer)
    ('oben',51,'CLI D2V',5101,'H2',h-28,h+2, 70, 70,'ATRASADO'),     -- ATRASADO com venc. futuro: a VIEW conta como vencida_aberta (regra dela); nao e lembrete D-2
    ('oben',52,'CLI D1',5201,'H3',h-31,h-1, 90, 90,'A VENCER'),      -- D+1
    ('oben',53,'CLI D7',5301,'H4',h-37,h-7, 40, 40,'ATRASADO'),      -- D+7
    ('colacor',12,'CLI DOZE',1201,'I1',h-40,h-10,500,500,'ATRASADO'); -- outra empresa
  INSERT INTO public.v_titulo_baixas VALUES ('oben',1003,'CR',h-28,500,1,32,'titulo');
  INSERT INTO public.omie_customer_account_map VALUES ('$CU10','oben',52), ('$CU20','oben',50);
END
\$f\$;
SQL

P -q -f "$MIG_VIEWS"
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then cat "$WORK/apply.log"; echo "APLICACAO FALHOU"; exit 1; fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# C1 coorte
eq "C1a cabecalho oben: 8 titulos / 7 clientes / 1380" "$(Pq -c "SELECT n_titulos||'/'||n_clientes||'/'||saldo_total FROM public.cobranca_coorte WHERE company='oben'")" "8/7/1380"
eq "C1b so vencida_aberta: o RECEBIDO (1003) e o D-2 a vencer (5001) nao entram; ATRASADO entra (regra da view)" "$(Pq -c "SELECT string_agg(omie_codigo_lancamento::text, ',' ORDER BY omie_codigo_lancamento) FROM public.cobranca_coorte_titulo")" "1001,1002,2001,3001,4001,5101,5201,5301"
eq "C1c detalhe = cabecalho" "$(Pq -c "SELECT count(*)||'/'||count(DISTINCT omie_codigo_cliente)||'/'||sum(saldo_inicial) FROM public.cobranca_coorte_titulo")" "8/7/1380"
# vencido novo e re-apply: a coorte não cresce
P -q -c "INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES ('oben',10,'CLI DEZ',1009,'D9','$H'::date-40,'$H'::date-3,999,999,'ATRASADO');"
eq "C1d re-apply com vencido novo: coorte inalterada (1 cabecalho, 8 titulos)" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then Pq -c "SELECT (SELECT count(*) FROM public.cobranca_coorte)||'/'||(SELECT count(*) FROM public.cobranca_coorte_titulo)"; else echo "re-apply falhou"; fi)" "1/8"

# C2 fila
eq "C2a master ve tudo; 40/51/53 sem dona; 50 (a vencer) fora" "$(fila "$M")" "10:a_contatar:46-90d:$V1 20:a_contatar:<=45d:$V1 30:a_contatar:>90d:$V2 40:a_contatar:<=45d:sem-dona 51:a_contatar:<=45d:sem-dona 52:a_contatar:<=45d:$V1 53:a_contatar:<=45d:sem-dona"
eq "C2a2 ordem = faixa (recentes primeiro) e saldo DESC dentro da faixa" "$(fila_ordem "$M")" "52 51 20 53 40 10 30"
eq "C2b V1 ve so os seus (10, 20, 52)" "$(fila "$V1")" "10:a_contatar:46-90d:$V1 20:a_contatar:<=45d:$V1 52:a_contatar:<=45d:$V1"
eq "C2c V2 ve so o 30" "$(fila "$V2")" "30:a_contatar:>90d:$V2"
eq "C2d V3 (sem carteira) ve nada" "$(Pq -c "$(como "$V3" "SELECT count(*) FROM public.cobranca_fila('oben')")")" "0"
eq "C2e customer -> 42501" "$(estado "$(como "$CUST" "SELECT count(*) FROM public.cobranca_fila('oben');")")" "42501"
eq "C2f anon -> 42501" "$(estado "SET ROLE anon; SELECT count(*) FROM public.cobranca_fila('oben');")" "42501"
eq "C2g empresa invalida -> 22023" "$(estado "$(como "$M" "SELECT count(*) FROM public.cobranca_fila('acme');")")" "22023"
eq "C2h saldo_inicial_coorte do cliente 10 = 300 e n_titulos 2" "$(Pq -c "$(como "$M" "SELECT saldo_inicial_coorte||'/'||n_titulos_coorte FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "300/2"

# C3 registrar — criação única e autorização
R1="$(reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"nome_cliente":"CLI DEZ","acao":"contato","canal":"telefone","nota":"ligou, retorna sexta"}')"
eq "C3a 1a acao cria o caso (caso_novo=true), estado segue a_contatar" "$(Pq -c "SELECT (\$j\$$R1\$j\$::jsonb->>'caso_novo')||'/'||(\$j\$$R1\$j\$::jsonb->>'estado')")" "true/a_contatar"
R2="$(reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"nota","nota":"segunda nota"}')"
eq "C3b 2a acao reusa o caso" "$(Pq -c "SELECT (\$j\$$R2\$j\$::jsonb->>'caso_novo')||'/'||(SELECT count(*) FROM public.cobranca_caso)||'/'||(SELECT count(*) FROM public.cobranca_evento WHERE tipo='abertura')")" "false/1/1"
eq "C3c V2 (nao dona do 10) -> 42501" "$(reg_estado "$V2" '{"company":"oben","omie_codigo_cliente":10,"acao":"nota","nota":"x"}')" "42501"
eq "C3d V3 (sem carteira) no 40 (sem dona) -> 42501; master pode" "$(reg_estado "$V3" '{"company":"oben","omie_codigo_cliente":40,"acao":"nota","nota":"x"}')|$(reg_estado "$M" '{"company":"oben","omie_codigo_cliente":40,"acao":"nota","nota":"x"}')" "42501|verde"
eq "C3e customer -> 42501" "$(reg_estado "$CUST" '{"company":"oben","omie_codigo_cliente":10,"acao":"nota","nota":"x"}')" "42501"
eq "C3f payload fora do dominio -> 22023" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"voar"}')|$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"pago"}')" "22023|22023"

# C4 máquina de estados
eq "C4a contato NAO mudou o estado" "$(Pq -c "SELECT estado FROM public.cobranca_caso WHERE omie_codigo_cliente=10")" "a_contatar"
R4B="$(reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"contatado","canal":"whatsapp"}')"
eq "C4b estado -> contatado" "$(Pq -c "SELECT \$j\$$R4B\$j\$::jsonb->>'estado'")" "contatado"
eq "C4c mesmo estado -> 22023" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"contatado"}')" "22023"
eq "C4d para_estado=promessa pela acao estado -> 22023" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"promessa"}')" "22023"
eq "C4e disputa; sair sem nota -> 22023; com nota ok" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"disputa","nota":"NF errada"}')|$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"contatado"}')|$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"contatado","nota":"NF corrigida"}')" "verde|22023|verde"
reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"whatsapp_aberto"}' >/dev/null
eq "C4f whatsapp_aberto registra evento com canal whatsapp e nao muda estado" "$(Pq -c "SELECT (SELECT estado FROM public.cobranca_caso WHERE omie_codigo_cliente=10)||'/'||(SELECT canal FROM public.cobranca_evento WHERE tipo='whatsapp_aberto')")" "contatado/whatsapp"

# C5 promessa
AMANHA="$(Pq -c "SELECT ('$H'::date + 5)::text")"
eq "C5a promessa sem valor -> 22023; data passada -> 22023" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"promessa","promessa_data":"'"$AMANHA"'"}')|$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"promessa","promessa_data":"2020-01-01","promessa_valor":100}')" "22023|22023"
RP="$(reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"promessa","promessa_data":"'"$AMANHA"'","promessa_valor":300}')"
eq "C5b promessa -> estado promessa, saldo_na_criacao = 1299 (300 + 999 novo)" "$(Pq -c "SELECT (\$j\$$RP\$j\$::jsonb->>'estado')||'/'||(SELECT saldo_na_criacao FROM public.cobranca_promessa WHERE substituida_em IS NULL)")" "promessa/1299"
eq "C5c fila: promessa aberta (data futura, saldo igual)" "$(Pq -c "$(como "$V1" "SELECT promessa_situacao||'/'||promessa_valor FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "aberta/300"
# contato depois da promessa NÃO apaga a promessa
reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"contato","canal":"telefone"}' >/dev/null
eq "C5d contato apos promessa mantem estado promessa e a promessa viva" "$(Pq -c "$(como "$V1" "SELECT estado||'/'||promessa_situacao FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "promessa/aberta"
# 2ª promessa substitui a 1ª
reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"promessa","promessa_data":"'"$AMANHA"'","promessa_valor":1000}' >/dev/null
eq "C5e 2a promessa substitui a 1a (1 viva, 1 substituida)" "$(Pq -c "SELECT (SELECT count(*) FROM public.cobranca_promessa WHERE substituida_em IS NULL)||'/'||(SELECT count(*) FROM public.cobranca_promessa WHERE substituida_em IS NOT NULL)")" "1/1"
# cumprimento derivado: o título novo (999) é RECEBIDO → saldo 300 ≤ 1299−1000=299? não (300 > 299) → ainda aberta; depois 1001 recebido → 200 ≤ 299 → cumprida
P -q -c "UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=1009;"
eq "C5f saldo caiu 999 (< 1000 prometido) -> ainda aberta" "$(Pq -c "$(como "$V1" "SELECT promessa_situacao FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "aberta"
P -q -c "UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=1001;"
eq "C5g saldo caiu 1099 (>= 1000) -> saldo_caiu (nao 'cumprida': sem baixa nao se afirma recebimento)" "$(Pq -c "$(como "$V1" "SELECT promessa_situacao FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "saldo_caiu"

# C6 fechar
eq "C6a quitado com vencido em aberto (200) -> 23514 (sem evidencia de quitacao)" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"fechar","fechado_motivo":"quitado"}')" "23514"
R6B="$(reg "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"estado","para_estado":"pago_informado"}')"
eq "C6b pago_informado e permitido (nao fecha)" "$(Pq -c "SELECT \$j\$$R6B\$j\$::jsonb->>'estado'")" "pago_informado"
eq "C6c cancelar: dona -> 42501; gestao sem nota -> 42501; gestao com nota -> fecha" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":20,"acao":"fechar","fechado_motivo":"cancelado_gestao","nota":"x"}')|$(reg_estado "$M" '{"company":"oben","omie_codigo_cliente":20,"acao":"fechar","fechado_motivo":"cancelado_gestao"}')|$(reg_estado "$M" '{"company":"oben","omie_codigo_cliente":20,"acao":"fechar","fechado_motivo":"cancelado_gestao","nota":"duplicidade"}')" "42501|42501|verde"
eq "C6d caso 20 cancelado pela gestao: a fila mostra 'cancelado_gestao' sem caso aberto (nao volta a a_contatar)" "$(Pq -c "$(como "$V1" "SELECT estado||'/'||coalesce(caso_id::text,'sem-caso')||'/'||coalesce(fechado_motivo,'-') FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=20")")" "cancelado_gestao/sem-caso/cancelado_gestao"
P -q -c "UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=1002;"
eq "C6e0 fila expõe pode_quitar=true para o 10 (sem aberto, sync fresco, recebidos)" "$(Pq -c "$(como "$V1" "SELECT pode_quitar FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "t"
P -q -c "UPDATE public.fin_sync_log SET completed_at = now() - interval '30 hours';"
eq "C6e1 sync velho (30 h) -> quitado barra (23514) mesmo sem aberto" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"fechar","fechado_motivo":"quitado"}')" "23514"
P -q -c "UPDATE public.fin_sync_log SET completed_at = now() - interval '1 hour';"
P -q -c "UPDATE public.fin_contas_receber SET status_titulo='VENCIDO' WHERE omie_codigo_lancamento=1002;"
eq "C6e2 titulo ambiguo (status do ingest) -> quitado barra (23514)" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"fechar","fechado_motivo":"quitado"}')" "23514"
P -q -c "UPDATE public.fin_contas_receber SET status_titulo='RECEBIDO' WHERE omie_codigo_lancamento=1002;"
eq "C6e saldo 0 na view -> quitado fecha; cliente 10 sai da fila" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":10,"acao":"fechar","fechado_motivo":"quitado"}')|$(Pq -c "$(como "$V1" "SELECT count(*) FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=10")")" "verde|0"
R6F="$(reg "$M" '{"company":"oben","omie_codigo_cliente":20,"acao":"nota","nota":"novo episodio"}')"
eq "C6f acao em caso fechado abre caso NOVO (nao ressuscita o fechado)" "$(Pq -c "SELECT \$j\$$R6F\$j\$::jsonb->>'caso_novo'")" "true"

# C7 sensor
eq "C7a eventos de estado no outbox = mudancas de estado (contatado, disputa, contatado, promessa x2, pago_informado, fechar 20, fechar 10) = 8" "$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='cobranca.estado_mudou'")" "8"
eq "C7b contato/nota/whatsapp nao emitem (6 eventos desses, nenhum no outbox)" "$(Pq -c "SELECT (SELECT count(*) FROM public.cobranca_evento WHERE tipo IN ('contato','nota','whatsapp_aberto'))||'/'||(SELECT count(*) FROM public.analytics_outbox WHERE props->>'de' IS NULL AND evento='cobranca.estado_mudou')")" "6/0"
eq "C7c chave = ledger:cobranca.estado_mudou:<evento_id>; props sem nome e sem R$" "$(Pq -c "SELECT bool_and(chave_dedup = 'ledger:cobranca.estado_mudou:' || e.id::text) AND bool_and(NOT (o.props ? 'nome_cliente') AND NOT (o.props ? 'saldo')) FROM public.analytics_outbox o JOIN public.cobranca_evento e ON o.chave_dedup = 'ledger:cobranca.estado_mudou:' || e.id::text")" "t"

# C8 régua
eq "C8a V1 ve D+1 (52) e D-2 (50, mapa→CU20→V1); nao o D+7 (53, sem dona)" "$(Pq -c "$(como "$V1" "SELECT string_agg(marco||':'||omie_codigo_cliente, ' ' ORDER BY omie_codigo_cliente) FROM public.cobranca_regua_hoje('oben')")")" "D-2:50 D+1:52"
eq "C8b master ve D-2 so a vencer (50), nao o 51 (ATRASADO com venc. futuro); D+1 e D+7" "$(Pq -c "$(como "$M" "SELECT string_agg(marco||':'||omie_codigo_cliente, ' ' ORDER BY omie_codigo_cliente) FROM public.cobranca_regua_hoje('oben')")")" "D-2:50 D+1:52 D+7:53"
eq "C8c telefone vem do mapa (50 → CU20 sem telefone → NULL; 52 → CU10 com telefone)" "$(Pq -c "$(como "$M" "SELECT coalesce(telefone,'NULO') FROM public.cobranca_regua_hoje('oben') WHERE omie_codigo_cliente=50")")|$(Pq -c "$(como "$M" "SELECT telefone FROM public.cobranca_regua_hoje('oben') WHERE omie_codigo_cliente=52")")" "NULO|48999990010"

# C8d nome pela fonte da fila (migration 20261101120000): título sem nome → profiles.name pelo mapa → não-vinculados; título com nome vence
P -q -c "INSERT INTO public.fin_contas_receber (company,omie_codigo_cliente,nome_cliente,omie_codigo_lancamento,numero_documento,data_emissao,data_vencimento,valor_documento,saldo,status_titulo) VALUES ('oben',54,NULL,5401,'H5','$H'::date-31,'$H'::date-1,10,10,'A VENCER'), ('oben',55,NULL,5501,'H6','$H'::date-37,'$H'::date-7,20,20,'ATRASADO'); INSERT INTO public.omie_customer_account_map VALUES ('$CU10','oben',54); INSERT INTO public.omie_clientes_nao_vinculados VALUES ('oben',55,'RAZAO 55','Fantasia 55');"
if ! P -q -f "$MIG_NOME_USADA" > "$WORK/apply-nome.log" 2>&1; then cat "$WORK/apply-nome.log"; echo "APLICACAO FALHOU (nome)"; exit 1; fi
grep -q "cobranca_regua_hoje recriada com nome_resolvido" "$WORK/apply-nome.log" || { echo "FAIL C8d postcondicao da migration do nome sem NOTICE"; FAIL=$((FAIL+1)); }
eq "C8d regua: 52 nome do titulo; 54 (titulo NULL) via profiles.name; 55 (sem mapa) via nao_vinculados" "$(Pq -c "$(como "$M" "SELECT string_agg(omie_codigo_cliente||':'||coalesce(nome_cliente,'NULO'), ' ' ORDER BY omie_codigo_cliente) FROM public.cobranca_regua_hoje('oben') WHERE omie_codigo_cliente IN (52,54,55)")")" "52:CLI D1 54:Marcenaria Dez 55:Fantasia 55"
eq "C8e re-apply da migration do nome e idempotente (PRE aceita a propria versao)" "$(if P -q -f "$MIG_NOME_USADA" >/dev/null 2>&1; then echo ok; else echo falhou; fi)" "ok"

# C9 RLS/ACL
eq "C9a V2 nao le caso do 10/20 (le 0); V1 le os seus" "$(Pq -c "$(como "$V2" "SELECT count(*) FROM public.cobranca_caso")")|$(Pq -c "$(como "$V1" "SELECT count(*) FROM public.cobranca_caso")")" "0|3"
eq "C9b master le tudo (4 casos)" "$(Pq -c "$(como "$M" "SELECT count(*) FROM public.cobranca_caso")")" "4"
eq "C9c INSERT/UPDATE direto por staff -> 42501" "$(estado "$(como "$V1" "INSERT INTO public.cobranca_caso (company, omie_codigo_cliente, aberto_por, atualizado_por) VALUES ('oben', 99, '$V1', '$V1');")")|$(estado "$(como "$V1" "UPDATE public.cobranca_caso SET estado='disputa';")")" "42501|42501"
eq "C9d vendedora nao le a coorte crua; master le" "$(Pq -c "$(como "$V1" "SELECT count(*) FROM public.cobranca_coorte_titulo")")|$(Pq -c "$(como "$M" "SELECT count(*) FROM public.cobranca_coorte_titulo")")" "0|8"
eq "C9e ACL: cobranca_dona aberta a authenticated (policies), pode_agir/quitacao fechados, anon fora" "$(Pq -c "SELECT has_function_privilege('authenticated','public.cobranca_dona(text,bigint)','EXECUTE')::text||has_function_privilege('authenticated','public.cobranca_pode_agir(uuid,text,bigint)','EXECUTE')::text||has_function_privilege('authenticated','public.cobranca_quitacao_ok(text,bigint)','EXECUTE')::text||has_function_privilege('anon','public.cobranca_dona(text,bigint)','EXECUTE')::text||has_function_privilege('anon','public.cobranca_caso_registrar(jsonb)','EXECUTE')::text")" "truefalsefalsefalsefalse"
# C11 ex-dona: V2 (dona de hoje) abre o caso do 30; a carteira passa para V1 — V2 deixa de ver o 30 (fila E tabela), V1 passa a ver
reg "$V2" '{"company":"oben","omie_codigo_cliente":30,"acao":"nota","nota":"abertura pela dona antiga"}' >/dev/null
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$V1' WHERE customer_user_id='$CU30';"
eq "C11a ex-dona (V2) nao ve mais o 30 na fila; V1 ve" "$(Pq -c "$(como "$V2" "SELECT count(*) FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=30")")|$(Pq -c "$(como "$V1" "SELECT count(*) FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=30")")" "0|1"
reg "$V1" '{"company":"oben","omie_codigo_cliente":30,"acao":"nota","nota":"nova dona"}' >/dev/null
eq "C11b caso do 30: dona refrescada para V1; V2 nao le a linha pela RLS" "$(Pq -c "SELECT dona_user_id FROM public.cobranca_caso WHERE omie_codigo_cliente=30")|$(Pq -c "$(como "$V2" "SELECT count(*) FROM public.cobranca_caso WHERE omie_codigo_cliente=30")")" "$V1|0"
eq "C11c ex-dona nao age no 30 -> 42501" "$(reg_estado "$V2" '{"company":"oben","omie_codigo_cliente":30,"acao":"nota","nota":"x"}')" "42501"
# C12 saida de disputa por PROMESSA tambem exige nota
reg "$V1" '{"company":"oben","omie_codigo_cliente":30,"acao":"estado","para_estado":"disputa","nota":"NF"}' >/dev/null
eq "C12 disputa -> promessa sem nota -> 22023" "$(reg_estado "$V1" '{"company":"oben","omie_codigo_cliente":30,"acao":"promessa","promessa_data":"'"$AMANHA"'","promessa_valor":10}')" "22023"
# C13 coorte: atual pelos titulos congelados (cliente 30: 3001 ainda aberto 800 → 800→800; cliente 10: tudo recebido → 300→0)
eq "C13 coorte atual pelos congelados: 30 = 800->800; corte_em = hoje" "$(Pq -c "$(como "$M" "SELECT saldo_inicial_coorte||'->'||saldo_atual_coorte||'/'||(coorte_corte_em = '$H'::date) FROM public.cobranca_fila('oben') WHERE omie_codigo_cliente=30")")" "800->800/true"

# C10 re-apply
FOTO="$(Pq -c "SELECT (SELECT count(*) FROM public.cobranca_caso)||'/'||(SELECT count(*) FROM public.cobranca_evento)||'/'||(SELECT count(*) FROM public.cobranca_promessa)")"
eq "C10 re-apply idempotente preserva casos/eventos/promessas" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then Pq -c "SELECT (SELECT count(*) FROM public.cobranca_caso)||'/'||(SELECT count(*) FROM public.cobranca_evento)||'/'||(SELECT count(*) FROM public.cobranca_promessa)"; else echo "re-apply falhou"; fi)" "$FOTO"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK cobranca-fila"

#!/usr/bin/env bash
# Prova PG17 — calendário de operação (Etapa 1, Task 1): esquema, RLS, log por trigger e as 3 funções de data
# (calendario_proximo_dia_recebimento · calendario_somar_dias_uteis_fornecedor · calendario_dias_sem_nf).
# Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §6.1.
#
# Rodar:  bash db/test-calendario-operacao.sh > log 2>&1; echo "exit=$?"   (NÃO pipe pra tail — engole o exit)
#         LOCALE_TESTE=pt_BR.UTF-8 bash db/test-calendario-operacao.sh       (o 2º idioma — money-path.md)
#         bash db/test-calendario-operacao.sh --falsificar                   (controle verde + 1 camada por vez)
#
# Lei de Ferro: aplica a MIGRATION REAL (2×: idempotência), asserts por valor exato, negativos casando a
# SQLSTATE, RLS sob SET ROLE authenticated + request.jwt.claims. Sentinelas ASCII, caixa fixa.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261119100000_calendario_operacao.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca.
  SABOTAGENS="sem_lower_btrim:AFORN2 sem_corte_d3:ASEMNF_CORTE sem_revoke_anon:POST!anon_executa
    sem_revoke_anon_sem_post:AANON1 sem_revoke_public:POST!PUBLIC_executa
    sem_revoke_public_sem_post:APUBLIC1 teto_60_off:AREC7 fechado_peso_off:ANEG2 escrita_employee:ARLS3
    leitura_aberta:ARLS1 gate_customer_off:AGATE1 log_trigger_off:ALOG1 recebimento_sem_empresa:AREC9
    nf_sem_empresa:ASEMNF1 colacor_nao_vazio:ASEMNF_COLACOR fornecedor_sem_empresa:AFORN5"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-calendario-operacao.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK calendario-operacao" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "FALHA $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "FALHA $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "OK $s: vermelha em [$marca]"
    else
      echo "FALHA $s: vermelha, mas NAO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5661}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-calendario-operacao.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
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
REV_ANON="REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM PUBLIC, anon;"
POST_ANON="IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN"
POST_PUBLIC="IF has_function_privilege('public', v_fn, 'EXECUTE') THEN"
case "${SABOTAGEM:-}" in
  "") ;;
  sem_lower_btrim)       sabotar "lower(btrim(f.fornecedor_nome)) = lower(btrim(p_fornecedor))" "f.fornecedor_nome = p_fornecedor" ;;
  sem_corte_d3)          sabotar "AND g.d::date <= v_corte" "AND true" ;;
  sem_revoke_anon)       sabotar "$REV_ANON" "REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM PUBLIC;" ;;
  sem_revoke_anon_sem_post)
                         sabotar "$REV_ANON" "REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM PUBLIC;"
                         sabotar "$POST_ANON" "IF false THEN" ;;
  sem_revoke_public)     sabotar "$REV_ANON" "REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM anon;" ;;
  sem_revoke_public_sem_post)
                         sabotar "$REV_ANON" "REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM anon;"
                         sabotar "$POST_PUBLIC" "IF false THEN" ;;
  teto_60_off)           sabotar "(p_data + 59)::timestamp" "(p_data + 400)::timestamp" ;;
  fechado_peso_off)      sabotar "CHECK (status <> 'fechado' OR peso = 0)" "CHECK (true)" ;;
  escrita_employee)      sabotar "WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));" \
                                 "WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));" ;;
  leitura_aberta)        sabotar "CREATE POLICY calendario_operacao_empresa_sel ON public.calendario_operacao_empresa
  FOR SELECT TO authenticated
  USING (" "CREATE POLICY calendario_operacao_empresa_sel ON public.calendario_operacao_empresa
  FOR SELECT TO authenticated
  USING (true OR " ;;
  gate_customer_off)     sabotar "IF v_uid IS NOT NULL AND NOT (" "IF false AND NOT (" ;;
  log_trigger_off)       sabotar "AFTER INSERT OR UPDATE OR DELETE ON public.calendario_operacao_empresa" \
                                 "AFTER UPDATE OR DELETE ON public.calendario_operacao_empresa" ;;
  recebimento_sem_empresa) sabotar "ON c.data = g.d::date AND c.empresa = p_empresa" "ON c.data = g.d::date" ;;
  nf_sem_empresa)        sabotar "WHERE v.empresa = p_empresa AND v.data_emissao = g.d::date" "WHERE v.data_emissao = g.d::date" ;;
  colacor_nao_vazio)     sabotar "IF p_empresa IS DISTINCT FROM 'OBEN'" "IF p_empresa IS NULL" ;;
  fornecedor_sem_empresa) sabotar "WHERE f.data = v_d AND f.empresa = p_empresa" "WHERE f.data = v_d" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { # $1 = uid ('' = sem sessão: JWT sem sub), $2 = SQL — executa como authenticated com o sub do JWT
  if [ -z "$1" ]; then printf "SET ROLE authenticated; SET request.jwt.claims = '{}'; %s" "$2"; return; fi
  printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\":\"%s\"}'; %s" "$1" "$2"
}
PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

M=00000000-0000-0000-0000-0000000000ee   # master
E=00000000-0000-0000-0000-0000000000e5   # employee
C=00000000-0000-0000-0000-0000000000c9   # customer

# ── Esquema mínimo com os MESMOS tipos de prod (psql-ro, 2026-11-18) ─────────────────────────────────────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE sem_grant NOLOGIN;   -- só herda PUBLIC: é como se mede o grant a PUBLIC
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: tabela e função nova em public NASCEM abertas (database.md §4).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub', true), ''),
                  (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid \$\$;
-- app_role e has_role: enum e assinatura de PROD ({master,employee,customer}; has_role(uuid,app_role) SECDEF).
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
INSERT INTO public.user_roles VALUES ('$M','master'), ('$E','employee'), ('$C','customer');
-- Alvos que a migration ALTERA / LÊ (tipos de prod).
CREATE TABLE public.pedido_compra_sugerido (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), empresa text, fornecedor_nome text);
-- Em prod é VIEW security_invoker sobre venda_items_history (RLS staff); aqui uma tabela com as colunas lidas.
CREATE TABLE public.v_venda_items_history_efetivo (empresa text, data_emissao date, nfe_numero text);
SQL

# ── Migration REAL, duas vezes (idempotência: IF NOT EXISTS / OR REPLACE / ADD COLUMN IF NOT EXISTS) ────────
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_USADA" >/dev/null
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_USADA" >/dev/null
eq "AIDEMP migration aplicada 2x sem erro" "ok" "ok"

eq "ACOL1 pedido_compra_sugerido.data_recebimento_prevista date NULL" \
   "$(Pq -c "SELECT data_type||'/'||is_nullable FROM information_schema.columns WHERE table_name='pedido_compra_sugerido' AND column_name='data_recebimento_prevista'")" "date/YES"
eq "ACOL2 pedido_compra_sugerido.recebimento_ajustado_calendario boolean NULL" \
   "$(Pq -c "SELECT data_type||'/'||is_nullable FROM information_schema.columns WHERE table_name='pedido_compra_sugerido' AND column_name='recebimento_ajustado_calendario'")" "boolean/YES"

# ── Carga (sessão sem JWT = SQL Editor) ─────────────────────────────────────────────────────────────────────
P -q <<'SQL'
-- Recesso OBEN 18/12/2026–03/01/2027 (inclui 25/12 e 01/01).
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
SELECT g::date, 'OBEN', 'fechado', 0, 'recesso', 'manual' FROM generate_series('2026-12-18'::date, '2027-01-03'::date, '1 day') g;
-- 07/12 emenda, 08/12 feriado municipal.
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem) VALUES
  ('2026-12-07', 'OBEN', 'fechado', 0, 'emenda', 'emenda'),
  ('2026-12-08', 'OBEN', 'fechado', 0, 'feriado municipal', 'feriado');
-- COLACOR: sábado ABERTO por exceção, meia equipe, pendente_dado, e 76 dias fechados (teto de busca de 60).
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem) VALUES
  ('2026-11-28', 'COLACOR', 'aberto', 1, 'sabado de inventario', 'manual'),
  ('2026-11-30', 'COLACOR', 'meia_equipe', 1, 'escala', 'escala'),
  ('2026-12-01', 'COLACOR', 'pendente_dado', 0, 'dia sem NF', 'deteccao');
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem)
SELECT g::date, 'COLACOR', 'fechado', 0, 'parada longa', 'manual' FROM generate_series('2027-03-01'::date, '2027-05-15'::date, '1 day') g;
-- Fornecedor X fechado 21/12–03/01; Sayerlack só 25/12 e 01/01 (gravada com caixa/espaço "de cadastro").
INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem)
SELECT g::date, 'OBEN', 'Fornecedor X', 'ferias coletivas', 'manual' FROM generate_series('2026-12-21'::date, '2027-01-03'::date, '1 day') g;
INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem) VALUES
  ('2026-12-25', 'OBEN', 'Sayerlack', 'natal', 'feriado'),
  ('2027-01-01', 'OBEN', 'Sayerlack', 'ano novo', 'feriado');
SQL

# ── calendario_proximo_dia_recebimento ────────────────────────────────────────────────────────────────────────
r() { Pq -c "SELECT COALESCE(public.calendario_proximo_dia_recebimento($1)::text, 'NULL')"; }
eq "AREC1 recesso: sab 19/12 -> seg 04/01"                 "$(r "'OBEN','2026-12-19'")" "2027-01-04"
eq "AREC2 emenda 07/12 + feriado 08/12 -> 09/12"           "$(r "'OBEN','2026-12-07'")" "2026-12-09"
eq "AREC3 dia util aberto devolve o proprio dia"           "$(r "'OBEN','2026-12-09'")" "2026-12-09"
eq "AREC4 sabado sem linha -> segunda"                     "$(r "'OBEN','2026-11-21'")" "2026-11-23"
eq "AREC5 sabado com linha 'aberto' devolve o sabado"      "$(r "'COLACOR','2026-11-28'")" "2026-11-28"
eq "AREC6a meia_equipe conta como aberto"                  "$(r "'COLACOR','2026-11-30'")" "2026-11-30"
eq "AREC6b pendente_dado NAO conta como aberto"            "$(r "'COLACOR','2026-12-01'")" "2026-12-02"
eq "AREC7 76 dias fechados -> NULL (teto 60, nunca data inventada)" "$(r "'COLACOR','2027-03-01'")" "NULL"
eq "AREC8 dia aberto a 58 dias ainda e encontrado"         "$(r "'COLACOR','2027-03-20'")" "2027-05-17"
eq "AREC9 recesso da OBEN nao fecha a COLACOR"             "$(r "'COLACOR','2026-12-21'")" "2026-12-21"
eq "AREC10 data NULL -> NULL"                              "$(r "'OBEN',NULL")" "NULL"

# ── calendario_somar_dias_uteis_fornecedor ────────────────────────────────────────────────────────────────────
s() { Pq -c "SELECT COALESCE(public.calendario_somar_dias_uteis_fornecedor($1)::text, 'NULL')"; }
eq "AFORN1 X fechado 21/12-03/01: 17/12 + 3 uteis -> 05/01" "$(s "'OBEN','Fornecedor X','2026-12-17',3")" "2027-01-05"
eq "AFORN2 '  SAYERLACK ' casa 'Sayerlack': 23/12 + 2 -> 28/12" "$(s "'OBEN','  SAYERLACK ','2026-12-23',2")" "2026-12-28"
eq "AFORN3 p_n=0 num sabado devolve o sabado"              "$(s "'OBEN','Sayerlack','2026-12-19',0")" "2026-12-19"
eq "AFORN4 p_n negativo devolve p_de"                      "$(s "'OBEN','Sayerlack','2026-12-19',-2")" "2026-12-19"
eq "AFORN5 fechamento da Sayerlack na OBEN nao vale na COLACOR" "$(s "'COLACOR','Sayerlack','2026-12-23',2")" "2026-12-25"
eq "AFORN6 fornecedor NULL -> NULL (ausente != sem fechamento)" "$(s "'OBEN',NULL,'2026-12-23',2")" "NULL"
eq "AFORN7 fornecedor sem linha = somarDiasUteis puro"     "$(s "'OBEN','Outro','2026-12-17',3")" "2026-12-22"

# ── calendario_dias_sem_nf (relativo ao HOJE de SP) ───────────────────────────────────────────────────────────
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
read -r W1 W2 W3 <<<"$(Pq -c "SELECT string_agg(d::text, ' ' ORDER BY d DESC) FROM (
  SELECT g::date d FROM generate_series('$HOJE'::date - 30, '$HOJE'::date - 3, '1 day') g
   WHERE extract(isodow FROM g) < 6 ORDER BY g DESC LIMIT 3) x")"
P -q <<SQL
INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem) VALUES
  ('$W2', 'OBEN', 'pendente_dado', 0, 'dia sem NF', 'deteccao'),
  ('$W3', 'OBEN', 'fechado', 0, 'ponte', 'emenda');
-- NF em todo dia útil da janela até hoje-3, MENOS W1/W2/W3; nenhuma em (hoje-3, hoje].
INSERT INTO public.v_venda_items_history_efetivo (empresa, data_emissao, nfe_numero)
SELECT 'OBEN', g::date, '1' FROM generate_series('$HOJE'::date - 30, '$HOJE'::date - 3, '1 day') g
 WHERE extract(isodow FROM g) < 6 AND g::date NOT IN ('$W1', '$W2', '$W3');
-- NF da COLACOR em W1: não pode "cobrir" o dia da OBEN.
INSERT INTO public.v_venda_items_history_efetivo VALUES ('COLACOR', '$W1', '9');
SQL
nf() { Pq -c "SELECT COALESCE(string_agg(d::text, ',' ORDER BY d), '') FROM public.calendario_dias_sem_nf($1) d"; }
eq "APRECOND ha dia util sem NF em (hoje-3, hoje] (o corte tem dente)" \
   "$(Pq -c "SELECT count(*) > 0 FROM generate_series('$HOJE'::date - 2, '$HOJE'::date, '1 day') g WHERE extract(isodow FROM g) < 6")" "t"
eq "ASEMNF1 so o dia util sem NF e sem linha (nem pendente_dado, nem fechado, nem fds)" \
   "$(nf "'OBEN','$HOJE'::date - 30, '$HOJE'::date")" "$W1"
eq "ASEMNF_CORTE nada depois de hoje-3 (inclui hoje-1)" \
   "$(Pq -c "SELECT count(*) FROM public.calendario_dias_sem_nf('OBEN', '$HOJE'::date - 30, '$HOJE'::date) d WHERE d > '$HOJE'::date - 3")" "0"
eq "ASEMNF_COLACOR empresa != OBEN -> vazio" "$(nf "'COLACOR','$HOJE'::date - 30, '$HOJE'::date")" ""

# ── Negativos (SQLSTATE exata) ───────────────────────────────────────────────────────────────────────────────
ins() { echo "INSERT INTO public.calendario_operacao_empresa (data, empresa, status, peso, motivo, origem) VALUES ($1)"; }
eq "ANEG1 peso 1.5 -> 23514"              "$(estado "$(ins "'2027-06-01','OBEN','aberto',1.5,'x','manual'")")" "23514"
eq "ANEG2 fechado com peso 0.5 -> 23514"  "$(estado "$(ins "'2027-06-01','OBEN','fechado',0.5,'x','manual'")")" "23514"
eq "ANEG3 empresa XPTO -> 23514"          "$(estado "$(ins "'2027-06-01','XPTO','aberto',1,'x','manual'")")" "23514"
eq "ANEG4 status invalido -> 23514"       "$(estado "$(ins "'2027-06-01','OBEN','talvez',1,'x','manual'")")" "23514"
eq "ANEG5 origem invalida -> 23514"       "$(estado "$(ins "'2027-06-01','OBEN','aberto',1,'x','chute'")")" "23514"
eq "ANEG6 fornecedor com empresa XPTO -> 23514" \
   "$(estado "INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem) VALUES ('2027-06-01','XPTO','F','x','manual')")" "23514"
eq "ANEG7 fornecedor_nome em branco -> 23514" \
   "$(estado "INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem) VALUES ('2027-06-01','OBEN','   ','x','manual')")" "23514"
eq "ANEG_CTRL controle: linha valida (meia_equipe, peso 1) passa" \
   "$(estado "$(ins "'2027-06-01','OBEN','meia_equipe',1,'x','escala'")")" "verde"

# ── RLS sob SET ROLE authenticated + claims ──────────────────────────────────────────────────────────────────
TOTAL="$(Pq -c "SELECT count(*) FROM public.calendario_operacao_empresa")"
eq "ARLS1 customer nao le o calendario da empresa (0 linhas)" \
   "$(Pq -c "$(como "$C" "SELECT count(*) FROM public.calendario_operacao_empresa")" | tail -1)" "0"
eq "ARLS1b customer nao le fornecedor nem log" \
   "$(Pq -c "$(como "$C" "SELECT (SELECT count(*) FROM public.calendario_operacao_fornecedor) + (SELECT count(*) FROM public.calendario_operacao_log)")" | tail -1)" "0"
eq "ARLS2 employee le tudo" \
   "$(Pq -c "$(como "$E" "SELECT count(*) FROM public.calendario_operacao_empresa")" | tail -1)" "$TOTAL"
eq "ARLS3 employee nao insere (42501)" \
   "$(estado "$(como "$E" "$(ins "'2027-06-02','OBEN','fechado',0,'x','manual'")")")" "42501"
eq "ARLS3b employee nao insere em fornecedor (42501)" \
   "$(estado "$(como "$E" "INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem) VALUES ('2027-06-02','OBEN','F','x','manual')")")" "42501"
Pq -c "$(como "$E" "UPDATE public.calendario_operacao_empresa SET motivo='hack' WHERE data='2026-12-07' AND empresa='OBEN'; DELETE FROM public.calendario_operacao_empresa WHERE data='2026-12-08' AND empresa='OBEN'")" >/dev/null
eq "ARLS4 employee UPDATE/DELETE nao tocam nada" \
   "$(Pq -c "SELECT (SELECT motivo FROM public.calendario_operacao_empresa WHERE data='2026-12-07' AND empresa='OBEN') || '/' || (SELECT count(*) FROM public.calendario_operacao_empresa WHERE data='2026-12-08' AND empresa='OBEN')")" "emenda/1"
eq "ARLS5 employee nao escreve no log (42501)" \
   "$(estado "$(como "$E" "INSERT INTO public.calendario_operacao_log (tabela, operacao) VALUES ('x','INSERT')")")" "42501"
LOG0="$(Pq -c "SELECT count(*) FROM public.calendario_operacao_log")"
eq "ARLS6 master insere" "$(estado "$(como "$M" "$(ins "'2027-06-02','OBEN','fechado',0,'decisao do founder','manual'")")")" "verde"
eq "ALOG1 trigger gravou exatamente 1 linha do INSERT do master" \
   "$(Pq -c "SELECT count(*) FROM public.calendario_operacao_log WHERE id > 0 AND tabela='calendario_operacao_empresa' AND operacao='INSERT' AND por='$M' AND antes IS NULL AND depois->>'data'='2027-06-02'")" "1"
eq "ALOG2 decidido_por default = auth.uid() do master" \
   "$(Pq -c "SELECT decidido_por FROM public.calendario_operacao_empresa WHERE data='2027-06-02' AND empresa='OBEN'")" "$M"
eq "ARLS7 master atualiza e o log guarda antes/depois" \
   "$(estado "$(como "$M" "UPDATE public.calendario_operacao_empresa SET status='aberto', peso=1 WHERE data='2027-06-02' AND empresa='OBEN'")")" "verde"
eq "ALOG3 UPDATE logado com antes=fechado e depois=aberto" \
   "$(Pq -c "SELECT antes->>'status' || '>' || (depois->>'status') FROM public.calendario_operacao_log WHERE operacao='UPDATE' AND por='$M'")" "fechado>aberto"
eq "ARLS8 master apaga fornecedor e o log registra o DELETE" \
   "$(estado "$(como "$M" "DELETE FROM public.calendario_operacao_fornecedor WHERE data='2027-01-01' AND fornecedor_nome='Sayerlack'")")" "verde"
eq "ALOG4 DELETE logado na tabela de fornecedor" \
   "$(Pq -c "SELECT count(*) FROM public.calendario_operacao_log WHERE tabela='calendario_operacao_fornecedor' AND operacao='DELETE' AND depois IS NULL AND antes->>'fornecedor_nome'='Sayerlack'")" "1"
eq "ALOG5 log cresceu exatamente 3 (insert/update/delete do master)" \
   "$(Pq -c "SELECT count(*) - $LOG0 FROM public.calendario_operacao_log")" "3"
eq "ALOG6 employee le o log" \
   "$(Pq -c "$(como "$E" "SELECT count(*) > 0 FROM public.calendario_operacao_log")" | tail -1)" "t"

# ── Gate nas funções (fronteira) ──────────────────────────────────────────────────────────────────────────────
eq "AGATE1 customer chamando proximo_dia_recebimento -> 42501" \
   "$(estado "$(como "$C" "SELECT public.calendario_proximo_dia_recebimento('OBEN','2026-12-19')")")" "42501"
eq "AGATE2 customer chamando somar_dias_uteis_fornecedor -> 42501" \
   "$(estado "$(como "$C" "SELECT public.calendario_somar_dias_uteis_fornecedor('OBEN','X','2026-12-19',1)")")" "42501"
eq "AGATE3 customer chamando dias_sem_nf -> 42501" \
   "$(estado "$(como "$C" "SELECT * FROM public.calendario_dias_sem_nf('OBEN','2026-01-05','2026-01-09')")")" "42501"
eq "AGATE4 employee le a mesma resposta do SQL Editor" \
   "$(Pq -c "$(como "$E" "SELECT public.calendario_proximo_dia_recebimento('OBEN','2026-12-19')")" | tail -1)" "2027-01-04"
eq "AGATE5 service_role (edge, JWT sem sub) chama e enxerga o calendario" \
   "$(Pq -c "SET ROLE service_role; SELECT public.calendario_somar_dias_uteis_fornecedor('OBEN','Fornecedor X','2026-12-17',3)" | tail -1)" "2027-01-05"

# ── ACL: REVOKE nas DUAS pontas (PUBLIC e anon), EXECUTE para authenticated e service_role ────────────────────
for fn in "calendario_proximo_dia_recebimento(text,date)" "calendario_somar_dias_uteis_fornecedor(text,text,date,integer)" "calendario_dias_sem_nf(text,date,date)"; do
  tag="${fn%%(*}"
  eq "AANON1 anon NAO executa $tag"        "$(Pq -c "SELECT has_function_privilege('anon', 'public.$fn', 'EXECUTE')")" "f"
  eq "APUBLIC1 PUBLIC NAO executa $tag"    "$(Pq -c "SELECT has_function_privilege('sem_grant', 'public.$fn', 'EXECUTE')")" "f"
  eq "AAUTH authenticated e service_role executam $tag" \
     "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.$fn', 'EXECUTE') AND has_function_privilege('service_role', 'public.$fn', 'EXECUTE')")" "t"
done
eq "ATAB anon sem nenhum privilegio nas 3 tabelas" \
   "$(Pq -c "SELECT bool_or(has_table_privilege('anon', 'public.'||t, 'SELECT,INSERT,UPDATE,DELETE')) FROM unnest(ARRAY['calendario_operacao_empresa','calendario_operacao_fornecedor','calendario_operacao_log']) t")" "f"
eq "ATAB_LOG authenticated so le o log (nada de escrita por privilegio)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.calendario_operacao_log', 'SELECT') AND NOT has_table_privilege('authenticated', 'public.calendario_operacao_log', 'INSERT,UPDATE,DELETE')")" "t"
eq "ATRG trigger de log nao e executavel por PUBLIC/anon/authenticated" \
   "$(Pq -c "SELECT bool_or(has_function_privilege(r, 'public.calendario_operacao__registrar_log()', 'EXECUTE')) FROM unnest(ARRAY['sem_grant','anon','authenticated']) r")" "f"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK calendario-operacao"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: `radar_registrar_cadastro_omie` com o VÍNCULO como trava                 ║
# ║  (migration 20261021120500 — Codex ALTO 3 do bloco 5, empilhada sobre a 20261021120000)         ║
# ║   bash db/test-radar-cadastro-omie-idempotente.sh               (controle)                      ║
# ║   bash db/test-radar-cadastro-omie-idempotente.sh --falsificar  (controle + sabotagens)         ║
# ║                                                                                                ║
# ║  Mundo: stubs de prod (radar_*, tarefas, gate de gestor, default privileges de prod) →          ║
# ║  predecessoras reais até a 20261019225545 (md5 = PROD) → a 20261021120000 INTACTA (ledger de    ║
# ║  confirmação) → esta migration.                                                                ║
# ║   A0  PRE recusa o corpo de PROD sem a 20261021120000 · aplica · no-op · atributos · índice     ║
# ║   A1  vínculo IGUAL → no-op: data, status e histórico intocados (inclusive status mudado depois)║
# ║   A2  vínculo DIFERENTE → SQLSTATE RD001, nada regravado                                        ║
# ║   A3  código já vinculado a OUTRO CNPJ → SQLSTATE RD002 (UNIQUE parcial), nada gravado          ║
# ║   A4  semântica da 20261021120000 preservada (sem confirmação / código vazio → recusa)          ║
# ║   A5  DUAS SESSÕES concorrentes, com o bloqueio OBSERVADO em pg_stat_activity antes de soltar A:║
# ║       X/X (1 escrita + 1 no-op) · X/Y e Y/X (RD001 para quem chega depois) · A faz ROLLBACK     ║
# ║       (B grava o dele) · (A,K) × (B,K) em CNPJs diferentes (RD002)                              ║
# ║   A6  anti-deriva: ACL/volatilidade do predecessor e índice homônimo de outra forma ABORTAM     ║
# ║  FALSIFICAÇÃO: uma camada por vez; a régua de md5 "este" é neutralizada nas sabotagens          ║
# ║  SEMÂNTICAS (senão todo mutante morreria na PÓS sem exercitar o assert funcional).              ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021120500_radar_cadastro_omie_idempotente.sql"
CONF="$REPO_ROOT/supabase/migrations/20261021120000_radar_cadastro_omie_confirmacao_servidor.sql"
ALNUM="$REPO_ROOT/supabase/migrations/20261019225545_radar_rpcs_cnpj_alfanumerico.sql"
CONTATO="$REPO_ROOT/supabase/migrations/20260612130000_radar_rpcs_contato.sql"
FATIA3="$REPO_ROOT/supabase/migrations/20260613190000_radar_fatia3.sql"
HOJE_SP="$REPO_ROOT/supabase/migrations/20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql"
MD5_PROD_CADASTRO="46717b268a9c44abaf09024de816c72b"   # psql-ro 2026-10-21 (= "este" da 20261019225545)
MD5_CONF="b537f95a00b83aab6bac3a5019ba380a"            # "este" da 20261021120000 (o único predecessor aceito)

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="sem_noop:A1b sem_fence:A2a sem_trava:A5b sem_mapa_rd002:A3a sem_indice:A3a pre_aceita_prod:A0r corpo_sabotado_md5:A0a pre_sem_acl:A6b trava_sem_volatilidade:A6c pos_sem_indice:A6d"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-cadastro-idem.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
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
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5514}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-cadastro-idem.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
TAREFA_VIVA="$TMPD/tarefa-viva.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

for f in "$MIG" "$CONF" "$ALNUM" "$CONTATO" "$FATIA3" "$HOJE_SP"; do [ -f "$f" ] || { echo "migration nao encontrada: $f"; exit 1; }; done
cp "$MIG" "$MIG_USADA"
python3 -I - "$HOJE_SP" "$TAREFA_VIVA" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(")
fim = s.index("$function$;", ini) + len("$function$;")
open(dst, "w", encoding="utf-8").write(s[ini:fim] + "\n")
PY

# sabotar ARQ DE PARA: troca literal (o padrão TEM de existir).
sabotar() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
s = s.replace(de, para)
open(p, "w", encoding="utf-8").write(s)
PY
}
ESTE="$(grep -oE "'[0-9a-f]{32}' /\* este:radar_registrar_cadastro_omie \*/" "$MIG" | grep -oE '[0-9a-f]{32}' | grep -v "$MD5_CONF" | head -1)"
# Régua "este" → md5 do corpo SABOTADO (calculado do arquivo, como o PG o guardará). Trocar por uma subconsulta
# do vivo faria a PRE aceitar QUALQUER predecessor — e o A0r deixaria de medir a PRE.
neutralizar() {
  local novo
  novo="$(python3 -I - "$MIG_USADA" <<'PY2'
import hashlib, sys
s = open(sys.argv[1], encoding="utf-8").read()
ini = s.index("AS $function$") + len("AS $function$")
print(hashlib.md5(s[ini:s.index("$function$;", ini)].encode("utf-8")).hexdigest())
PY2
)"
  sabotar "$MIG_USADA" "'$ESTE' /* este:radar_registrar_cadastro_omie */" "'$novo' /* este:radar_registrar_cadastro_omie */"
}
POS_INDICE="  IF v_idx IS NULL OR NOT EXISTS ("
case "${SABOTAGEM:-}" in
  "") ;;
  sem_noop)               sabotar "$MIG_USADA" "    IF v_codigo_atual = v_codigo THEN" "    IF false THEN"; neutralizar ;;
  sem_fence)              sabotar "$MIG_USADA" "  IF v_codigo_atual IS NOT NULL THEN" "  IF false THEN"; neutralizar ;;
  sem_trava)              sabotar "$MIG_USADA" "WHERE cnpj = p_cnpj FOR UPDATE;" "WHERE cnpj = p_cnpj;"; neutralizar ;;
  sem_mapa_rd002)         sabotar "$MIG_USADA" "    IF v_restricao = 'radar_empresas_omie_codigo_cliente_uniq' THEN" "    IF false THEN"; neutralizar ;;
  sem_indice)             sabotar "$MIG_USADA" "CREATE UNIQUE INDEX IF NOT EXISTS radar_empresas_omie_codigo_cliente_uniq
  ON public.radar_empresas (omie_codigo_cliente) WHERE omie_codigo_cliente IS NOT NULL;" "SELECT 1;"
                          sabotar "$MIG_USADA" "$POS_INDICE" "  IF false AND NOT EXISTS (" ;;
  pre_aceita_prod)        sabotar "$MIG_USADA" "r.vivo NOT IN ('$MD5_CONF'," "r.vivo NOT IN ('$MD5_PROD_CADASTRO', '$MD5_CONF'," ;;
  corpo_sabotado_md5)     sabotar "$MIG_USADA" "'empresa não encontrada: %', p_cnpj; END IF;" "'empresa nao encontrada: %', p_cnpj; END IF;" ;;
  pre_sem_acl)            sabotar "$MIG_USADA" "    RAISE EXCEPTION 'PRE FALHOU: radar_registrar_cadastro_omie vivo tem ACL divergente do predecessor revisado';" "    NULL;" ;;
  trava_sem_volatilidade) sabotar "$MIG_USADA" "  IF v_vol <> 'v' THEN" "  IF false THEN" ;;
  pos_sem_indice)         sabotar "$MIG_USADA" "$POS_INDICE" "  IF false AND NOT EXISTS (" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"
ESTE_USADO="$(grep -oE "'[0-9a-f]{32}' /\* este:radar_registrar_cadastro_omie \*/" "$MIG_USADA" | grep -oE '[0-9a-f]{32}' | head -1)"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prova
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1 $2"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1 $2"; }
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
GESTOR='00000000-0000-0000-0000-0000000000a1'
# Bloco que classifica o desfecho da RPC num MARCADOR. RD001/RD002/23505 casam pela SQLSTATE (nunca pela
# mensagem); os RAISE da 20261021120000 (P0001) pelo prefixo da mensagem. Qualquer OUTRO erro relança —
# `WHEN OTHERS THEN 'OK'` é teatro.
classifica() { # $1 = chamada SQL
  cat <<SQL
DO \$x\$ DECLARE r jsonb; BEGIN
  r := $1;
  INSERT INTO pg_temp.res VALUES ('OK:' || COALESCE(r->>'deduped', '?'));
EXCEPTION
  WHEN SQLSTATE 'RD001' THEN INSERT INTO pg_temp.res VALUES ('RD001');
  WHEN SQLSTATE 'RD002' THEN INSERT INTO pg_temp.res VALUES ('RD002');
  WHEN unique_violation THEN INSERT INTO pg_temp.res VALUES ('UNIQUE_CRU');
  WHEN raise_exception THEN
    IF SQLERRM LIKE 'RADAR_SEM_CONFIRMACAO_OMIE:%' THEN INSERT INTO pg_temp.res VALUES ('SEM_CONFIRMACAO');
    ELSE RAISE; END IF;
END \$x\$;
SQL
}
# chamada CNPJ CODIGO → marcador (sessão própria, autocommit).
chamada() {
  Pq <<SQL
SET test.uid = '$GESTOR';
CREATE TEMP TABLE res (k text);
$(classifica "public.radar_registrar_cadastro_omie('$1', '$2', false)")
SELECT k FROM pg_temp.res;
SQL
}
# em_sessao NOME CNPJ CODIGO FIM SEGUNDOS — chama a RPC numa transação que fica ABERTA por SEGUNDOS e termina
# em COMMIT ou ROLLBACK (FIM). Roda em background; o marcador sai em $TMPD/NOME.out.
em_sessao() {
  "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -qtA > "$TMPD/$1.out" 2> "$TMPD/$1.err" <<SQL &
SET application_name = 'idem_$1';
SET test.uid = '$GESTOR';
CREATE TEMP TABLE res (k text);
BEGIN;
$(classifica "public.radar_registrar_cadastro_omie('$2', '$3', false)")
SELECT k FROM pg_temp.res;
SELECT pg_sleep($5);
$4;
SQL
}
# espera_estado NOME PREDICADO — até 10s pela sessão NOME em pg_stat_activity satisfazendo o predicado.
espera_estado() {
  local i
  for i in $(seq 1 100); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'idem_$1' AND ($2)")" = "1" ] && return 0
    sleep 0.1
  done
  return 1
}
EM_SLEEP="query LIKE '%pg_sleep%' AND wait_event = 'PgSleep'"
EM_LOCK="wait_event_type = 'Lock'"
md5_de() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.$1')"; }
# vínculo/status/ja_cliente/histórico/data — o retrato inteiro, não só a contagem (Codex 2026-10-21).
empresa() { Pq -c "SELECT ja_cliente||'/'||COALESCE(omie_codigo_cliente,'∅')||'/'||prospeccao_status||'/'||(SELECT count(*) FROM public.radar_contatos k WHERE k.cnpj=e.cnpj AND k.acao='virou_cliente')||'/'||COALESCE(omie_cadastrado_em::text,'∅')||'/'||updated_at FROM public.radar_empresas e WHERE cnpj='$1'"; }
confirma() { # documento codigo origem — grava como o service_role (o escritor de prod, a edge)
  Pq -c "SET ROLE service_role; INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$1','$2','$3'); RESET ROLE;" >/dev/null
}

P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec') THEN CREATE ROLE sandbox_exec NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_ro') THEN CREATE ROLE claude_ro NOLOGIN; END IF;
END $$;
-- Default privileges de PROD (pg_default_acl do postgres em public, psql-ro 2026-10-21).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO sandbox_exec;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text, nome_fantasia text,
  cnae_principal text NOT NULL,
  data_abertura date,
  municipio_codigo text, municipio_nome text, uf text,
  telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  prospeccao_atualizado_em timestamptz, descarte_motivo text,
  ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL,
  omie_codigo_cliente text, omie_cadastrado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (
  codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL,
  lat double precision, lng double precision);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'), acao text NOT NULL, nota text,
  criado_por uuid NOT NULL, status_anterior text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL, novos integer);
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao text NOT NULL, categoria text NOT NULL, customer_user_id uuid,
  assigned_to uuid NOT NULL, created_by uuid NOT NULL, empresa text NOT NULL,
  modo text NOT NULL, due_date date, interacao_tipo text,
  auto_satisfy_mode text NOT NULL DEFAULT 'off', status text NOT NULL DEFAULT 'aberta',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role, sandbox_exec, claude_ro;
SQL
P -f "$CONTATO" >/dev/null
P -f "$FATIA3" >/dev/null
P -f "$TAREFA_VIVA" >/dev/null
P <<'SQL'
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO service_role;
SQL
P -f "$ALNUM" >/dev/null
P <<'SQL'
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-0000000000a1');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, prospeccao_status) VALUES
  ('12ABC34501DE35', 'ALFANUMERICA LTDA', '3101200', '2026-10', 'em_conversa'),
  ('11111111000111', 'NUMERICA LTDA', '3101200', '2026-10', 'a_contatar'),
  ('22222222000122', 'CONCORRENTE XX', '3101200', '2026-10', 'em_conversa'),
  ('33333333000133', 'CONCORRENTE XY', '3101200', '2026-10', 'em_conversa'),
  ('44444444000144', 'CONCORRENTE YX', '3101200', '2026-10', 'em_conversa'),
  ('55555555000155', 'CONCORRENTE ROLLBACK', '3101200', '2026-10', 'em_conversa'),
  ('66666666000166', 'MESMO CODIGO A', '3101200', '2026-10', 'em_conversa'),
  ('77777777000177', 'MESMO CODIGO B', '3101200', '2026-10', 'em_conversa');
SQL

echo "── A0 aplicação"
eq A0p "predecessor vivo = PROD (20261019225545), ainda sem a 20261021120000" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_PROD_CADASTRO"
if P -f "$MIG_USADA" > "$TMPD/pre.log" 2>&1; then bad A0r "PRE aceitou o corpo de PROD sem a 20261021120000 (esta versão lê o ledger)";
elif grep -q "PRE FALHOU: radar_registrar_cadastro_omie vivo (md5 $MD5_PROD_CADASTRO) não é o da 20261021120000" "$TMPD/pre.log"; then ok A0r "PRE recusa o corpo de PROD sem a 20261021120000";
else bad A0r "abortou fora do esperado: $(grep -m1 ERROR "$TMPD/pre.log" | cut -c1-160)"; fi
eq A0r2 "o aborto não deixou o índice nem mexeu na RPC" "$(Pq -c "SELECT (to_regclass('public.radar_empresas_omie_codigo_cliente_uniq') IS NULL)::text||'/'||md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")" "true/$MD5_PROD_CADASTRO"
P -f "$CONF" >/dev/null
eq A0p2 "predecessor = 'este' da 20261021120000" "$(md5_de 'radar_registrar_cadastro_omie(text,text,boolean)')" "$MD5_CONF"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok A0a "migration aplica (TRAVA → PRE → índice → CREATE → PÓS)"; else bad A0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-200)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok A0b "re-aplicar é no-op (PRE aceita 'este')"; else bad A0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-200)"; fi
eq A0c "RPC = 'este', SECURITY DEFINER + search_path=public + VOLATILE" \
  "$(Pq -c "SELECT md5(prosrc)||':'||prosecdef||':'||proconfig[1]||':'||provolatile::text FROM pg_proc WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")" "$ESTE_USADO:true:search_path=public:v"
eq A0d "ACL: anon/PUBLIC sem EXECUTE; authenticated/service_role com" \
  "$(Pq -c "SELECT has_function_privilege('anon',p.oid,'EXECUTE')||'/'||has_function_privilege('public',p.oid,'EXECUTE')||'/'||has_function_privilege('authenticated',p.oid,'EXECUTE')||'/'||has_function_privilege('service_role',p.oid,'EXECUTE') FROM pg_proc p WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")" "false/false/true/true"

echo "── A1 vínculo IGUAL → no-op"
confirma 12ABC34501DE35 4242 incluir
eq A1a "1ª gravação vincula e grava 1 linha de histórico" "$(chamada 12ABC34501DE35 4242)" "OK:false"
DEPOIS_1="$(empresa 12ABC34501DE35)"
eq A1a2 "retrato após a 1ª" "$(cut -d/ -f1-4 <<<"$DEPOIS_1")" "true/4242/virou_cliente/1"
eq A1b "2ª gravação com o MESMO código → no-op (deduped)" "$(chamada 12ABC34501DE35 4242)" "OK:true"
eq A1c "nada regravado: vínculo, status, histórico, omie_cadastrado_em e updated_at idênticos" "$(empresa 12ABC34501DE35)" "$DEPOIS_1"
eq A1d "código com espaços em volta é o MESMO vínculo (btrim) → no-op" "$(chamada 12ABC34501DE35 ' 4242 ')" "OK:true"
Pq -c "SET test.uid='$GESTOR'; SELECT public.registrar_contato_radar('12ABC34501DE35','em_conversa','voltou a negociar')" >/dev/null
ANTES_E="$(empresa 12ABC34501DE35)"
eq A1e "status mudado DEPOIS (registrar_contato_radar) + retentativa → no-op que NÃO repara o status" "$(chamada 12ABC34501DE35 4242)/$(empresa 12ABC34501DE35)" "OK:true/$ANTES_E"
eq A1e2 "(o status de fato era em_conversa)" "$(cut -d/ -f3 <<<"$ANTES_E")" "em_conversa"

echo "── A2 vínculo DIFERENTE → RD001"
confirma 12ABC34501DE35 5555 lookup
eq A2a "código confirmado mas ≠ do vínculo → SQLSTATE RD001" "$(chamada 12ABC34501DE35 5555)" "RD001"
eq A2b "nada regravado (vínculo 4242, histórico, datas)" "$(empresa 12ABC34501DE35)" "$ANTES_E"
eq A2c "a mensagem nomeia o vínculo atual e o recebido" \
  "$(Pq -c "SET test.uid='$GESTOR'; DO \$x\$ BEGIN PERFORM public.radar_registrar_cadastro_omie('12ABC34501DE35','5555',false); EXCEPTION WHEN SQLSTATE 'RD001' THEN RAISE NOTICE '%', SQLERRM; END \$x\$;" 2>&1 | grep -c 'RADAR_VINCULO_DIVERGENTE: CNPJ 12ABC34501DE35 já vinculado ao cliente Omie 4242, recebido 5555')" "1"

echo "── A3 código de OUTRO CNPJ → RD002"
confirma 11111111000111 4242 lookup
ANTES_N="$(empresa 11111111000111)"
eq A3a "(11111111000111, 4242) com 4242 já vinculado a 12ABC34501DE35 → SQLSTATE RD002" "$(chamada 11111111000111 4242)" "RD002"
eq A3b "nada gravado no CNPJ recusado" "$(empresa 11111111000111)" "$ANTES_N"

echo "── A4 semântica da 20261021120000 preservada"
eq A4a "sem confirmação no ledger → RADAR_SEM_CONFIRMACAO_OMIE" "$(chamada 11111111000111 9999)" "SEM_CONFIRMACAO"
eq A4b "código vazio → RADAR_SEM_CONFIRMACAO_OMIE (nada de virou_cliente sem vínculo)" "$(chamada 11111111000111 '')" "SEM_CONFIRMACAO"
eq A4c "nota vem do ledger: 'incluir' → 'Cadastrado…'" "$(Pq -c "SELECT nota FROM public.radar_contatos WHERE cnpj='12ABC34501DE35' AND acao='virou_cliente'")" "Cadastrado no Omie/Oben (cód. 4242)"

echo "── A5 duas sessões concorrentes (o bloqueio é OBSERVADO antes de soltar A)"
# concorrente ID CNPJ_A COD_A FIM_A CNPJ_B COD_B → "marcadorA|marcadorB|B_esperou"
concorrente() {
  em_sessao "${1}A" "$2" "$3" "$4" 2
  if ! espera_estado "${1}A" "$EM_SLEEP"; then echo "A_NAO_CHEGOU"; wait; return; fi
  em_sessao "${1}B" "$5" "$6" COMMIT 0
  local esperou=nao
  espera_estado "${1}B" "$EM_LOCK" && esperou=sim
  wait
  echo "$(head -1 "$TMPD/${1}A.out")|$(head -1 "$TMPD/${1}B.out")|$esperou"
}
confirma 22222222000122 700 incluir
eq A5a "X/X: A grava, B (mesmo CNPJ e código) ESPERA a trava e vira no-op" "$(concorrente xx 22222222000122 700 COMMIT 22222222000122 700)" "OK:false|OK:true|sim"
eq A5b "X/X: exatamente 1 linha de histórico e o vínculo 700" "$(cut -d/ -f1-4 <<<"$(empresa 22222222000122)")" "true/700/virou_cliente/1"
confirma 33333333000133 801 incluir; confirma 33333333000133 802 lookup
eq A5c "X/Y: B (outro código) ESPERA e recebe RD001" "$(concorrente xy 33333333000133 801 COMMIT 33333333000133 802)" "OK:false|RD001|sim"
eq A5c2 "X/Y: vence quem vinculou primeiro (801), 1 linha" "$(cut -d/ -f1-4 <<<"$(empresa 33333333000133)")" "true/801/virou_cliente/1"
confirma 44444444000144 901 incluir; confirma 44444444000144 902 lookup
eq A5d "Y/X (ordem inversa): B recebe RD001" "$(concorrente yx 44444444000144 902 COMMIT 44444444000144 901)" "OK:false|RD001|sim"
eq A5d2 "Y/X: vínculo 902, 1 linha" "$(cut -d/ -f1-4 <<<"$(empresa 44444444000144)")" "true/902/virou_cliente/1"
confirma 55555555000155 1001 incluir; confirma 55555555000155 1002 lookup
eq A5e "A faz ROLLBACK: B (outro código) espera e GRAVA o dele" "$(concorrente rb 55555555000155 1001 ROLLBACK 55555555000155 1002)" "OK:false|OK:false|sim"
eq A5e2 "ROLLBACK de A não deixa rastro: vínculo 1002, 1 linha" "$(cut -d/ -f1-4 <<<"$(empresa 55555555000155)")" "true/1002/virou_cliente/1"
confirma 66666666000166 1100 incluir; confirma 77777777000177 1100 lookup
eq A5f "(A,K) × (B,K) em CNPJs diferentes: B espera o índice e recebe RD002" "$(concorrente kk 66666666000166 1100 COMMIT 77777777000177 1100)" "OK:false|RD002|sim"
eq A5f2 "só A ficou com K" "$(Pq -c "SELECT string_agg(cnpj, ',' ORDER BY cnpj) FROM public.radar_empresas WHERE omie_codigo_cliente = '1100'")/$(cut -d/ -f1-4 <<<"$(empresa 77777777000177)")" "66666666000166/false/∅/em_conversa/0"

echo "── A6 anti-deriva (re-aplicar com o predecessor/índice mexido ABORTA e nada muda)"
aborta_em() {
  if P -f "$MIG_USADA" > "$TMPD/re.log" 2>&1; then bad "$1" "$2 — re-aplicar PASSOU";
  elif grep -q "$3" "$TMPD/re.log"; then ok "$1" "$2";
  else bad "$1" "$2 — abortou fora do esperado: $(grep -m1 ERROR "$TMPD/re.log" | cut -c1-140)"; fi
}
P -c "GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO anon"
aborta_em A6b "EXECUTE para anon no vivo → PRE FALHOU (o REVOKE abaixo desfaria em silêncio)" "PRE FALHOU: radar_registrar_cadastro_omie vivo tem ACL divergente"
P -c "REVOKE EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) FROM anon"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) STABLE"
aborta_em A6c "STABLE no vivo → TRAVA FALHOU (volatilidade conferida ANTES do ALTER)" "TRAVA FALHOU: radar_registrar_cadastro_omie(text,text,boolean) não é VOLATILE"
P -c "ALTER FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) VOLATILE"
P -c "DROP INDEX public.radar_empresas_omie_codigo_cliente_uniq; CREATE INDEX radar_empresas_omie_codigo_cliente_uniq ON public.radar_empresas (omie_codigo_cliente)"
aborta_em A6d "índice homônimo NÃO-unique (o IF NOT EXISTS pula) → PÓS FALHOU" "POS FALHOU: índice UNIQUE parcial radar_empresas_omie_codigo_cliente_uniq"
P -c "DROP INDEX public.radar_empresas_omie_codigo_cliente_uniq"
if P -f "$MIG_USADA" >"$TMPD/apply3.log" 2>&1; then ok A6e "sem o homônimo, re-aplicar recria o índice"; else bad A6e "re-aplicar abortou: $(grep -m1 ERROR "$TMPD/apply3.log" | cut -c1-160)"; fi
eq A6f "estado final: RPC 'este' + índice UNIQUE parcial válido" \
  "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.radar_registrar_cadastro_omie(text,text,boolean)')")/$(Pq -c "SELECT indisunique::text||indisvalid::text FROM pg_index WHERE indexrelid = 'public.radar_empresas_omie_codigo_cliente_uniq'::regclass")" "$ESTE_USADO/truetrue"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-cadastro-omie-idempotente: todos os asserts passaram"
[ "$FAIL" -eq 0 ]

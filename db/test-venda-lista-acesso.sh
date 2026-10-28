#!/usr/bin/env bash
# Prova PG17 do SENSOR DE ABERTURA DA LISTA DO MEU DIA — migration 20261028220003_venda_lista_acesso:
# `venda_minhas_sugestoes` passa a gravar em `venda_lista_acesso` (1 linha por farmer × dia) cada leitura
# feita pela PRÓPRIA farmer, com a saída inalterada.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T0  o predecessor montado aqui é o vivo em prod (md5 9c70ff55…, PR #3290)
#  T2  farmer lendo grava; 2 leituras no mesmo dia = 1 linha com n_leituras 2; n_compradores = a ÚLTIMA leitura
#  T3  master (a própria lista e a lente get_venda_sugestoes_for), customer e uid sem papel NÃO gravam
#  T4  dia = p_dia (lista de ontem → linha de ontem); lista vazia → linha com n_compradores 0 (≠ sem linha)
#  T5  transação READ ONLY: a lista sai igual e o acesso só não é registrado (só 25006 é engolido)
#  T6  outro erro do upsert (23514) SOBE — o sensor não mede em silêncio
#  T7  RLS: farmer não lê a tabela, master lê tudo; authenticated não escreve; anon nada
#  T8  ACL da RPC e da tabela (PUBLIC e anon fechadas)
#  T1  saída byte-idêntica ao oráculo (corpo das Ondas 2–3), por usuário × dia
#  T9  re-apply idempotente e preserva as linhas; corpo vivo divergente → PRE aborta
#
#   bash db/test-venda-lista-acesso.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-lista-acesso.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-lista-acesso.sh             # tem de ficar VERMELHA
#   bash db/test-venda-lista-acesso.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261028220003_venda_lista_acesso.sql"
MIG_LENTE="$REPO_ROOT/supabase/migrations/20261021070000_venda_lista_lente.sql"
MIG_ONDAS="$REPO_ROOT/supabase/migrations/20261021031000_venda_cliente_ondas23.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="grava_master:POST!P5_FALHOU grava_customer:POST!P4_FALHOU sem_contador:T2b engole_tudo:T6 n_da_primeira:T2c stable:POST!P3_FALHOU rls_off:POST!P3_FALHOU acl_anon:POST!P2_FALHOU tabela_insert_auth:POST!P2_FALHOU saida_mudou:POST!P4_FALHOU dia_do_servidor:T4"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-lista-acesso.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-lista-acesso" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5664}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-lista-acesso.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
PRED_SQL="$WORK/pred.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# Cadeia viva: o corpo das Ondas 2–3 (recortado do arquivo aplicado em prod) e uma cópia renomeada (`_v0`)
# que fica como ORÁCULO independente; depois a migration da lente (#3290) por cima — é ela o predecessor.
python3 -I - "$MIG_ONDAS" "$PRED_SQL" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes")
fim_marca = "GRANT EXECUTE ON FUNCTION public.venda_minhas_sugestoes(date) TO authenticated, service_role;\n"
fim = s.index(fim_marca, ini) + len(fim_marca)
bloco = s[ini:fim]
oraculo = bloco.replace("public.venda_minhas_sugestoes", "public.venda_minhas_sugestoes_v0")
open(dst, "w", encoding="utf-8").write(bloco + "\n" + oraculo)
PY

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
  grava_master)       sabotar "  IF public.has_role(v_uid, 'employee'::public.app_role)
     AND NOT public.has_role(v_uid, 'master'::public.app_role) THEN" "  IF public.has_role(v_uid, 'employee'::public.app_role) OR true THEN" ;;
  grava_customer)     sabotar "  IF public.has_role(v_uid, 'employee'::public.app_role)
     AND NOT" "  IF NOT" ;;
  sem_contador)       sabotar "n_leituras    = a.n_leituras + 1," "n_leituras    = a.n_leituras," ;;
  engole_tudo)        sabotar "EXCEPTION WHEN read_only_sql_transaction THEN" "EXCEPTION WHEN OTHERS THEN" ;;
  n_da_primeira)      sabotar "n_compradores = EXCLUDED.n_compradores;" "n_compradores = a.n_compradores;" ;;
  stable)             sabotar "LANGUAGE plpgsql
VOLATILE" "LANGUAGE plpgsql
STABLE" ;;
  rls_off)            sabotar "ALTER TABLE public.venda_lista_acesso ENABLE ROW LEVEL SECURITY;" "" ;;
  acl_anon)           sabotar "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;" \
                              "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC;" ;;
  tabela_insert_auth) sabotar "GRANT SELECT ON public.venda_lista_acesso TO authenticated;" \
                              "GRANT SELECT, INSERT ON public.venda_lista_acesso TO authenticated;" ;;
  saida_mudou)        sabotar "  RETURN v_out;" "  RETURN v_out || '{\"sensor\": true}'::jsonb;" ;;
  dia_do_servidor)    sabotar "VALUES (v_uid, p_dia, jsonb_array_length" "VALUES (v_uid, (now() AT TIME ZONE 'America/Sao_Paulo')::date, jsonb_array_length" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
# Corpo sabotado = corpo NOVO: reassina o md5 "este" do PRE/PÓS (como faria quem mudasse a função e o
# arquivo juntos). Sem isso o P1 da PÓS aborta o apply e o vermelho não chega ao assert de comportamento.
reassinar() {
  python3 -I - "$MIG_USADA" <<'PY2'
import hashlib, sys
p = sys.argv[1]
s = open(p, encoding="utf-8").read()
i = s.index("CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes"); j = s.index("AS $$\n", i) + len("AS $$"); k = s.index("$$;", j)
s = s.replace("ca1ece0e8e887d2b3e66d9fc757f1b3f", hashlib.md5(s[j:k].encode()).hexdigest())
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

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; F3=00000000-0000-0000-0000-0000000000f3
M=00000000-0000-0000-0000-0000000000ee; CUST=00000000-0000-0000-0000-0000000000cc
C1=00000000-0000-0000-0000-0000000000c1; C2=00000000-0000-0000-0000-0000000000c2; C3=00000000-0000-0000-0000-0000000000c3
NINGUEM=00000000-0000-0000-0000-000000000099
como() { # $1 = uid ('' = sem sessão), $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}
ler() { Pq -c "$(como "$1" "SELECT public.venda_minhas_sugestoes('$2')::text")"; }
linha() { # $1 farmer, $2 dia → "n_leituras n_compradores" ou "sem-linha"
  local v; v="$(Pq -c "SELECT n_leituras || ' ' || n_compradores FROM public.venda_lista_acesso WHERE farmer_user_id = '$1' AND dia = '$2'")"
  echo "${v:-sem-linha}"
}
total() { Pq -c "SELECT count(*) FROM public.venda_lista_acesso"; }

# ── Esquema mínimo com as MESMAS colunas/ACLs de prod (medido via psql-ro em 2026-10-21/28) ──────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: função E tabela novas em public NASCEM abertas (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, razao_social text,
  phone text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text, descricao text);
CREATE TABLE public.venda_recompra (comprador_id uuid NOT NULL, empresa text NOT NULL, omie_codigo_produto bigint NOT NULL,
  cadencia_dias numeric);
CREATE TABLE public.venda_config (chave text PRIMARY KEY, valor jsonb NOT NULL, atualizado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.venda_sugestao (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL CHECK (tipo IN ('recompra','complemento','preco')),
  fase text NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  dia_referencia date NOT NULL, gerada_em timestamptz NOT NULL DEFAULT now(),
  farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL, empresa text NOT NULL,
  omie_codigo_produto bigint, familia text, qtd_ref numeric, valor_ref numeric, preco_alvo numeric,
  motivo_entrada text NOT NULL DEFAULT 'teste', mostrada_em timestamptz,
  desfecho text, desfecho_motivo text, sales_order_id uuid, valor_realizado numeric, avaliado_em timestamptz);

INSERT INTO public.venda_config VALUES
  ('onda_recompra','true'), ('onda_complemento','true'), ('onda_preco','false'), ('teto_maiores_atrasos','10');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee'), ('$F2','employee'), ('$F3','employee'), ('$CUST','customer');
INSERT INTO public.profiles (user_id, name, razao_social, phone) VALUES
  ('$F1','Regina',NULL,NULL), ('$F2','Tatyana',NULL,NULL), ('$M','Lucas',NULL,NULL),
  ('$C1','Marcenaria Um',NULL,'4899990001'), ('$C2',NULL,'Moveis Dois Ltda','4899990002');
SQL

# Ondas 2–3 + oráculo, depois a lente (#3290) = o predecessor vivo
P -q -f "$PRED_SQL"
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
ONTEM="$(Pq -c "SELECT '$HOJE'::date - 1")"
# Lote A (antes do apply): a PÓS das duas migrations compara a saída antes/depois — e a desta prova a
# escrita do sensor para F1 (employee) e a não-escrita para o uid sem papel.
P -q <<SQL
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada) VALUES
 ('recompra','ativa','$HOJE','$F1','$C1','oben',111, 2, 150, 'atraso');
SQL
P -q -f "$MIG_LENTE"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

eq "T0 predecessor montado = o vivo em prod (md5)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.venda_minhas_sugestoes(date)'::regprocedure")" \
   "9c70ff552bd324d8ecde698ef5127f66"

# ── Apply (TRAVA → PRE → CREATE → PÓS) ─────────────────────────────────────────────────────────
P -q -f "$MIG_USADA"

# Lote B (depois do apply): o que exercita cada ramo do JSON.
P -q <<SQL
INSERT INTO public.omie_products (omie_codigo_produto, account, descricao) VALUES
 (111,'oben','Seladora PU 3,6L'), (222,'colacor','Verniz Nitro 18L'), (333,'oben','Thinner 5L');
INSERT INTO public.venda_recompra VALUES ('$C1','oben',111, 27.6), ('$C2','colacor',222, NULL);
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, familia, qtd_ref, valor_ref, preco_alvo, motivo_entrada) VALUES
 ('recompra',   'ativa','$HOJE','$F1','$C1','oben',   333, NULL,        1,   80,   NULL, 'atraso'),
 ('complemento','ativa','$HOJE','$F1','$C1','oben',   NULL,'Seladora',  NULL,NULL, NULL, 'mixgap'),
 ('recompra',   'ativa','$HOJE','$F1','$C2','colacor',222, NULL,        3,   NULL, NULL, 'rota'),
 ('preco',      'ativa','$HOJE','$F1','$C2','oben',   333, NULL,        NULL,NULL, 42.5, 'repasse'),
 ('recompra',   'sombra','$HOJE','$F1','$C3','oben',  111, NULL,        1,   999,  NULL, 'atraso'),
 ('recompra',   'ativa','$ONTEM','$F1','$C3','oben',  111, NULL,        1,   10,   NULL, 'atraso'),
 ('recompra',   'ativa','$HOJE','$F2','$C3','oben',   111, NULL,        5,   500,  NULL, 'atraso');
SQL

# T2 a farmer lendo grava; a 2ª leitura do dia incrementa a MESMA linha
eq "T2a a PÓS não deixou linha de sonda" "$(total)" "0"
ler "$F1" "$HOJE" >/dev/null
eq "T2 F1 leu hoje: 1 linha, 1 leitura, 2 compradores" "$(linha "$F1" "$HOJE")" "1 2"
ler "$F1" "$HOJE" >/dev/null
eq "T2b 2 leituras no mesmo dia = 1 linha com n_leituras 2" "$(linha "$F1" "$HOJE") $(total)" "2 2 1"
eq "T2b' primeira_em fica, ultima_em anda" \
   "$(Pq -c "SELECT primeira_em < ultima_em FROM public.venda_lista_acesso WHERE farmer_user_id = '$F1' AND dia = '$HOJE'")" "t"
ler "$F2" "$HOJE" >/dev/null
P -q -c "INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref)
         VALUES ('recompra','ativa','$HOJE','$F2','$C1','oben',111, 1, 20)"
ler "$F2" "$HOJE" >/dev/null
eq "T2c n_compradores = a ÚLTIMA leitura (F2: 1 → 2 compradores)" "$(linha "$F2" "$HOJE")" "2 2"

# T3 master (própria lista e lente), customer e sem papel não gravam
ANTES="$(total)"
ler "$M" "$HOJE" >/dev/null
Pq -c "$(como "$M" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE')")" >/dev/null
Pq -c "$(como "$M" "SELECT public.get_venda_sugestoes_for('$F2')")" >/dev/null
ler "$CUST" "$HOJE" >/dev/null
ler "$NINGUEM" "$HOJE" >/dev/null
eq "T3 master/lente/customer/sem papel: nenhuma linha nova" "$(total)" "$ANTES"
eq "T3b F1 intocada pela lente" "$(linha "$F1" "$HOJE")" "2 2"

# T4 dia = p_dia; lista vazia grava 0 (≠ sem linha)
ler "$F1" "$ONTEM" >/dev/null
eq "T4 lista de ontem → linha de ontem (1 comprador); hoje intocado" "$(linha "$F1" "$ONTEM") | $(linha "$F1" "$HOJE")" "1 1 | 2 2"
ler "$F3" "$HOJE" >/dev/null
eq "T4b employee sem lista: linha com 0 compradores" "$(linha "$F3" "$HOJE")" "1 0"

# T5 transação READ ONLY: a lista sai igual, o acesso não é registrado
RO="$(P -qAt <<SQL 2>/dev/null
SET ROLE authenticated; SET request.jwt.claim.sub = '$F1';
BEGIN READ ONLY;
SELECT md5(public.venda_minhas_sugestoes('$HOJE')::text);
COMMIT;
SQL
)"
eq "T5 READ ONLY: lista = oráculo e n_leituras não anda" "$RO | $(linha "$F1" "$HOJE")" \
   "$(Pq -c "$(como "$F1" "SELECT md5(public.venda_minhas_sugestoes_v0('$HOJE')::text)")") | 2 2"

# T6 outro erro do upsert sobe (não é engolido)
P -q -c "ALTER TABLE public.venda_lista_acesso ADD CONSTRAINT _t6_sabota CHECK (n_compradores < 0) NOT VALID"
eq "T6 erro do upsert que não é 25006 sobe (23514)" "$(estado "$(como "$F2" "SELECT public.venda_minhas_sugestoes('$HOJE');")")" "23514"
P -q -c "ALTER TABLE public.venda_lista_acesso DROP CONSTRAINT _t6_sabota"

# T7 RLS e privilégio de tabela
eq "T7 farmer não lê a tabela (RLS: só master)" "$(Pq -c "$(como "$F1" "SELECT count(*) FROM public.venda_lista_acesso")")" "0"
eq "T7b master lê todas" "$(Pq -c "$(como "$M" "SELECT count(*) FROM public.venda_lista_acesso")")" "$(total)"
eq "T7c authenticated INSERT direto -> 42501" \
   "$(estado "$(como "$F1" "INSERT INTO public.venda_lista_acesso (farmer_user_id, dia, n_compradores) VALUES ('$F1', '$ONTEM'::date - 5, 9);")")" "42501"
eq "T7d anon SELECT -> 42501" "$(estado "SET ROLE anon; SELECT count(*) FROM public.venda_lista_acesso;")" "42501"

# T8 ACL
eq "T8 ACL da RPC anon|public|authenticated" "$(Pq -c "
  SELECT has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')::text || '|' ||
         has_function_privilege('public', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')::text || '|' ||
         has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')::text")" "false|false|true"
eq "T8b privilégios da tabela: anon nenhum, authenticated só SELECT" "$(Pq -c "
  SELECT has_table_privilege('anon', 'public.venda_lista_acesso', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')::text || '|' ||
         has_table_privilege('authenticated', 'public.venda_lista_acesso', 'INSERT,UPDATE,DELETE,TRUNCATE')::text || '|' ||
         has_table_privilege('authenticated', 'public.venda_lista_acesso', 'SELECT')::text")" "false|false|true"

# T1 saída byte-idêntica ao oráculo (Ondas 2–3), como cada usuário e em cada dia
for u in "$F1" "$F2" "$F3" "$M" "$CUST" "$NINGUEM"; do
  for d in "$HOJE" "$ONTEM"; do
    eq "T1 venda_minhas_sugestoes = oráculo (uid ${u: -2}, dia $d)" "$(ler "$u" "$d")" \
       "$(Pq -c "$(como "$u" "SELECT public.venda_minhas_sugestoes_v0('$d')::text")")"
  done
done
eq "T1b o oráculo não é trivial: F1 hoje tem 2 compradores e 5 sugestões" \
   "$(Pq -c "$(como "$F1" "SELECT jsonb_array_length(j->'compradores') || ' ' || (SELECT sum(jsonb_array_length(c->'sugestoes')) FROM jsonb_array_elements(j->'compradores') c) FROM (SELECT public.venda_minhas_sugestoes_v0('$HOJE') j) x")")" "2 5"
eq "T1c sem sessão segue 42501" "$(estado "$(como "" "SELECT public.venda_minhas_sugestoes('$HOJE');")")" "42501"
eq "T1d master lê F1 pela lente = o que F1 lê" \
   "$(Pq -c "$(como "$M" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE')::text")")" "$(ler "$F1" "$HOJE")"

# T9 re-apply idempotente e preserva as linhas; deriva do corpo vivo → PRE aborta
FOTO="$(Pq -c "SELECT string_agg(concat_ws('|', farmer_user_id, dia, n_leituras, n_compradores, primeira_em, ultima_em), ',' ORDER BY farmer_user_id, dia) FROM public.venda_lista_acesso")"
eq "T9 re-apply idempotente" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then echo verde; else echo vermelho; fi)" "verde"
eq "T9b re-apply preserva as linhas do sensor" \
   "$(Pq -c "SELECT string_agg(concat_ws('|', farmer_user_id, dia, n_leituras, n_compradores, primeira_em, ultima_em), ',' ORDER BY farmer_user_id, dia) FROM public.venda_lista_acesso")" "$FOTO"
P -q -c "CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT current_date) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS \$\$ BEGIN RETURN '{}'::jsonb; END \$\$;"
SAIDA_PRE="$(P -q -f "$MIG_USADA" 2>&1 || true)"
case "$SAIDA_PRE" in *"PRE FALHOU: public.venda_minhas_sugestoes(date)"*) PRE_OK=ok ;; *) PRE_OK="$SAIDA_PRE" ;; esac
eq "T9c corpo vivo divergente -> PRE aborta" "$PRE_OK" "ok"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-lista-acesso"

#!/usr/bin/env bash
# Prova PG17 da LISTA DA FARMER NA LENTE "Ver como" — migration 20261021070000_venda_lista_lente:
# o corpo de `venda_minhas_sugestoes` vira o helper `private._venda_sugestoes_json(p_farmer, p_dia)` e
# `get_venda_sugestoes_for(p_farmer, p_dia)` (master-only) devolve a lista de OUTRA farmer pelo mesmo helper.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T0  o predecessor montado aqui é o vivo em prod (md5 e38baeb5…) — o oráculo é o código certo
#  T1  venda_minhas_sugestoes byte-idêntica ao predecessor (texto do JSON), por farmer × dia, com
#      sombra/histórico, valor_ref ausente, complemento/preço, nome por razão social, cadência
#  T2  master lê a lista da farmer = a lista que a própria farmer lê (texto idêntico); só fase ativa
#  T3  farmer chamando para outra farmer → 42501; farmer para si mesma → 42501 (só master); sem sessão → 42501
#  T4  anon → 42501 (ACL); helper direto como authenticated/anon → 42501
#  T5  o JSON não tem chave de custo (cmc/custo/markup/piso), recursivo
#  T6  p_farmer NULL → 22023
#  T7  ACL por has_function_privilege (as duas pontas: PUBLIC e anon)
#  T8  re-apply idempotente; corpo vivo divergente → PRE aborta
#
#   bash db/test-venda-lista-lente.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-lista-lente.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-lista-lente.sh             # tem de ficar VERMELHA
#   bash db/test-venda-lista-lente.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021070000_venda_lista_lente.sql"
MIG_PRED="$REPO_ROOT/supabase/migrations/20261021031000_venda_cliente_ondas23.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="sem_filtro_fase:T1 total_ausente_vira_valor:T1 nome_sem_razao:T1 gate_aberto:POST!P5_FALHOU for_usa_uid:POST!P5_FALHOU acl_anon:POST!P2_FALHOU helper_aberto:POST!P2_FALHOU custo_no_json:POST!P4_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-lista-lente.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-lista-lente" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5663}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-lista-lente.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
PRED_SQL="$WORK/pred.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# O predecessor VIVO (Task 9): o bloco de venda_minhas_sugestoes recortado do arquivo aplicado em prod, mais
# uma cópia renomeada (`_v0`) que fica como ORÁCULO depois que a migration troca a função.
python3 -I - "$MIG_PRED" "$PRED_SQL" <<'PY'
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
  sem_filtro_fase)   sabotar "     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = p_farmer" "     WHERE s.farmer_user_id = p_farmer" ;;
  total_ausente_vira_valor) sabotar "CASE WHEN bool_and(s.valor_ref IS NOT NULL) FILTER (WHERE s.tipo = 'recompra')
                THEN" "CASE WHEN true THEN" ;;
  nome_sem_razao)    sabotar "SELECT COALESCE(p.name, p.razao_social) AS nome" "SELECT p.name AS nome" ;;
  gate_aberto)       sabotar "IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN" "IF v_uid IS NULL THEN" ;;
  for_usa_uid)       sabotar "  RETURN private._venda_sugestoes_json(p_farmer, p_dia);" "  RETURN private._venda_sugestoes_json(v_uid, p_dia);" ;;
  acl_anon)          sabotar "REVOKE ALL ON FUNCTION public.get_venda_sugestoes_for(uuid, date) FROM PUBLIC, anon;" \
                             "REVOKE ALL ON FUNCTION public.get_venda_sugestoes_for(uuid, date) FROM PUBLIC;" ;;
  helper_aberto)     sabotar "REVOKE ALL ON FUNCTION private._venda_sugestoes_json(uuid, date) FROM PUBLIC, anon, authenticated;" \
                             "REVOKE ALL ON FUNCTION private._venda_sugestoes_json(uuid, date) FROM anon, authenticated;" ;;
  custo_no_json)     sabotar "'preco_alvo', s.preco_alvo, 'cadencia_dias'" "'preco_alvo', s.preco_alvo, 'custo_ref', s.qtd_ref, 'cadencia_dias'" ;;
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
    ("CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes", "$$", "9c70ff552bd324d8ecde698ef5127f66"),
    ("CREATE OR REPLACE FUNCTION private._venda_sugestoes_json", "$fn$", "288ace38a44f0a70bffe5426a0ba44a3"),
    ("CREATE OR REPLACE FUNCTION public.get_venda_sugestoes_for", "$$", "2cd5333ed0750a7f0b4afae29a97e650"),
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

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; M=00000000-0000-0000-0000-0000000000ee
C1=00000000-0000-0000-0000-0000000000c1; C2=00000000-0000-0000-0000-0000000000c2; C3=00000000-0000-0000-0000-0000000000c3
NINGUEM=00000000-0000-0000-0000-000000000099
como() { # $1 = uid ('' = sem sessão), $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}

# ── Esquema mínimo com as MESMAS colunas/ACLs de prod (medido via psql-ro em 2026-10-21) ─────────
P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Default privileges do Supabase: função nova em public NASCE aberta (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- private: USAGE para anon/authenticated (prod); função nova nasce com EXECUTE para PUBLIC (default do PG).
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
INSERT INTO public.user_roles VALUES ('$M','master'), ('$F1','employee'), ('$F2','employee');
INSERT INTO public.profiles (user_id, name, razao_social, phone) VALUES
  ('$F1','Regina',NULL,NULL), ('$F2','Tatyana',NULL,NULL), ('$M','Lucas',NULL,NULL),
  ('$C1','Marcenaria Um',NULL,'4899990001'), ('$C2',NULL,'Moveis Dois Ltda','4899990002');
SQL

# Predecessor vivo + oráculo
P -q -f "$PRED_SQL"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

eq "T0 predecessor montado = o vivo em prod (md5)" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.venda_minhas_sugestoes(date)'::regprocedure")" \
   "e38baeb57b7e19c815e45baa77a23810"

HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"

# Lote A (antes do apply): pouco, mas não vazio — a PÓS da migration compara a saída antes/depois sobre ele.
P -q <<SQL
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, qtd_ref, valor_ref, motivo_entrada) VALUES
 ('recompra','ativa','$HOJE','$F1','$C1','oben',111, 2, 150, 'atraso');
SQL

# ── Apply (TRAVA → PRE → CREATE → PÓS) ─────────────────────────────────────────────────────────
P -q -f "$MIG_USADA"

# Lote B (depois do apply): o que exercita cada ramo do JSON. A PÓS não viu este lote — quem o prova é o oráculo.
P -q <<SQL
INSERT INTO public.omie_products (omie_codigo_produto, account, descricao) VALUES
 (111,'oben','Seladora PU 3,6L'), (222,'colacor','Verniz Nitro 18L'), (333,'oben','Thinner 5L');
INSERT INTO public.venda_recompra VALUES ('$C1','oben',111, 27.6), ('$C2','colacor',222, NULL);
INSERT INTO public.venda_sugestao (tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, familia, qtd_ref, valor_ref, preco_alvo, motivo_entrada) VALUES
 -- F1 hoje: C1 com 2 recompras + complemento; C2 com uma recompra SEM valor_ref e outra com (total ausente ≠ zero) + preço
 ('recompra',   'ativa','$HOJE','$F1','$C1','oben',   333, NULL,        1,   80,   NULL, 'atraso'),
 ('complemento','ativa','$HOJE','$F1','$C1','oben',   NULL,'Seladora',  NULL,NULL, NULL, 'mixgap'),
 ('recompra',   'ativa','$HOJE','$F1','$C2','colacor',222, NULL,        3,   NULL, NULL, 'rota'),
 ('recompra',   'ativa','$HOJE','$F1','$C2','oben',   111, NULL,        2,   70,   NULL, 'rota'),
 ('preco',      'ativa','$HOJE','$F1','$C2','oben',   333, NULL,        NULL,NULL, 42.5, 'repasse'),
 -- F1 hoje em sombra/histórico: NUNCA na lista
 ('recompra',   'sombra',   '$HOJE','$F1','$C3','oben',111, NULL,      1,   999,  NULL, 'atraso'),
 ('recompra',   'historico','$HOJE','$F1','$C3','oben',111, NULL,      1,   999,  NULL, 'atraso'),
 -- F1 ontem (outro dia) e F2 hoje
 ('recompra',   'ativa','$HOJE'::date - 1,'$F1','$C3','oben',111, NULL, 1,  10,   NULL, 'atraso'),
 ('recompra',   'ativa','$HOJE','$F2','$C3','oben',   111, NULL,        5,   500,  NULL, 'atraso');
SQL

# T1 byte-idêntica ao oráculo (predecessor), como cada usuário e em cada dia
for u in "$F1" "$F2" "$M" "$NINGUEM"; do
  for d in "$HOJE" "$(Pq -c "SELECT '$HOJE'::date - 1")"; do
    novo="$(Pq -c "$(como "$u" "SELECT public.venda_minhas_sugestoes('$d')::text")")"
    velho="$(Pq -c "$(como "$u" "SELECT public.venda_minhas_sugestoes_v0('$d')::text")")"
    eq "T1 venda_minhas_sugestoes = predecessor (uid ${u: -2}, dia $d)" "$novo" "$velho"
  done
done
eq "T1b o oráculo não é trivial: F1 hoje tem 2 compradores e 6 sugestões" \
   "$(Pq -c "$(como "$F1" "SELECT jsonb_array_length(j->'compradores') || ' ' || (SELECT sum(jsonb_array_length(c->'sugestoes')) FROM jsonb_array_elements(j->'compradores') c) FROM (SELECT public.venda_minhas_sugestoes('$HOJE') j) x")")" "2 6"
eq "T1c sem sessão segue 42501 na lista da farmer" "$(estado "$(como "" "SELECT public.venda_minhas_sugestoes('$HOJE');")")" "42501"

# T2 master lê a lista da farmer
eq "T2 master lê F1 = o que F1 lê (texto idêntico)" \
   "$(Pq -c "$(como "$M" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE')::text")")" \
   "$(Pq -c "$(como "$F1" "SELECT public.venda_minhas_sugestoes('$HOJE')::text")")"
eq "T2b master lê F2 = o que F2 lê (default p_dia = hoje SP)" \
   "$(Pq -c "$(como "$M" "SELECT public.get_venda_sugestoes_for('$F2')::text")")" \
   "$(Pq -c "$(como "$F2" "SELECT public.venda_minhas_sugestoes()::text")")"
eq "T2c só fase ativa: o comprador da sombra/histórico (C3) não aparece em F1 hoje" \
   "$(Pq -c "$(como "$M" "SELECT count(*) FROM jsonb_array_elements(public.get_venda_sugestoes_for('$F1', '$HOJE')->'compradores') c WHERE c->>'comprador_id' = '$C3'")")" "0"
eq "T2d ausente ≠ zero: total de C2 (uma recompra sem valor_ref, outra com) é null" \
   "$(Pq -c "$(como "$M" "SELECT jsonb_typeof(c->'valor_ref_total') FROM jsonb_array_elements(public.get_venda_sugestoes_for('$F1', '$HOJE')->'compradores') c WHERE c->>'comprador_id' = '$C2'")")" "null"

# T3 só master
eq "T3 farmer F2 lendo F1 -> 42501"   "$(estado "$(como "$F2" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE');")")" "42501"
eq "T3b farmer F1 lendo a si -> 42501" "$(estado "$(como "$F1" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE');")")" "42501"
eq "T3c sem sessao -> 42501"          "$(estado "$(como "" "SELECT public.get_venda_sugestoes_for('$F1', '$HOJE');")")" "42501"

# T4 anon e helper direto
eq "T4 anon -> 42501" "$(estado "SET ROLE anon; SELECT public.get_venda_sugestoes_for('$F1', '$HOJE');")" "42501"
eq "T4b helper direto como authenticated (master) -> 42501" \
   "$(estado "$(como "$M" "SELECT private._venda_sugestoes_json('$F1', '$HOJE');")")" "42501"
eq "T4c helper direto como anon -> 42501" "$(estado "SET ROLE anon; SELECT private._venda_sugestoes_json('$F1', '$HOJE');")" "42501"

# T5 sem chave de custo em nenhum nível
T5_SQL="WITH RECURSIVE t(v) AS (
  SELECT public.get_venda_sugestoes_for('$F1', '$HOJE')
  UNION ALL
  SELECT e.value FROM t, LATERAL (
    SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}' END)
    UNION ALL
    SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.v) = 'array' THEN t.v ELSE '[]' END)) e)
SELECT count(*) FILTER (WHERE k ~ '(cmc|custo|markup|piso)') || ' de ' || count(*)
  FROM t, jsonb_object_keys(CASE WHEN jsonb_typeof(t.v) = 'object' THEN t.v ELSE '{}' END) k;"
eq "T5 nenhuma chave de custo no JSON (recursivo, sobre 78 chaves)" "$(Pq -c "$(como "$M" "$T5_SQL")")" "0 de 78"

# T6 entrada inválida
eq "T6 p_farmer NULL -> 22023" "$(estado "$(como "$M" "SELECT public.get_venda_sugestoes_for(NULL, '$HOJE');")")" "22023"

# T7 ACL
eq "T7 ACL anon|public|authenticated: minhas, for, helper" "$(Pq -c "
  SELECT string_agg(has_function_privilege('anon', f, 'EXECUTE')::text || '|' ||
                    has_function_privilege('public', f, 'EXECUTE')::text || '|' ||
                    has_function_privilege('authenticated', f, 'EXECUTE')::text, ' ' ORDER BY o)
    FROM (VALUES (1,'public.venda_minhas_sugestoes(date)'), (2,'public.get_venda_sugestoes_for(uuid,date)'),
                 (3,'private._venda_sugestoes_json(uuid,date)')) x(o, f)")" "false|false|true false|false|true false|false|false"

# T8 re-apply idempotente; deriva do corpo vivo → PRE aborta
eq "T8 re-apply idempotente" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then echo verde; else echo vermelho; fi)" "verde"
P -q -c "CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT current_date) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS \$\$ BEGIN RETURN '{}'::jsonb; END \$\$;"
SAIDA_PRE="$(P -q -f "$MIG_USADA" 2>&1 || true)"
case "$SAIDA_PRE" in *"PRE FALHOU: public.venda_minhas_sugestoes(date)"*) PRE_OK=ok ;; *) PRE_OK="$SAIDA_PRE" ;; esac
eq "T8b corpo vivo divergente -> PRE aborta" "$PRE_OK" "ok"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-lista-lente"

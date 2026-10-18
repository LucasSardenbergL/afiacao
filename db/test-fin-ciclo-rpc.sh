#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261015003200_fin_ciclo_rpcs_gate                           ║
# ║  fin_ciclo_cliente_resumo / fin_ciclo_empresa_coorte / fin_ciclo_titulos_cliente ║
# ║      bash db/test-fin-ciclo-rpc.sh > logs/t.log 2>&1; echo "exit=$?"        ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-rpc.sh  (2º ambiente)             ║
# ╚══════════════════════════════════════════════════════════════════════════╝
# Controle verde na MESMA invocação + 1 sabotagem por camada do gate, sobre CÓPIA da migration de
# RPCs (o repo nunca é tocado). Asserções em ASCII, caixa fixa, sem -i.
#
# Escolhas do preparo (espelham prod só no que a prova exige):
#  - public.user_roles.role é o enum app_role em prod; a migration compara com o literal 'master',
#    então `text` basta aqui.
#  - fin_user_can_access (stub, SECURITY DEFINER): true se o usuário está em fin_permissoes_stub com a
#    empresa pedida, OU se é master/employee em user_roles E NÃO tem linha em fin_permissoes_stub.
#    Ou seja, "master sem linha no stub" = acesso total; "master COM linha" = só as empresas listadas
#    (é isso que permite provar o gate 2: master que não enxerga colacor). Outros usuários: só o array.
#  - ALTER DEFAULT PRIVILEGES concede EXECUTE a anon/authenticated/service_role, como o Supabase faz;
#    sem isso a sabotagem "tirar anon do REVOKE" ficaria verde-falsa (anon nunca teria o EXECUTE).
#  - A sessão é simulada com SET LOCAL ROLE authenticated + request.jwt.claims (auth.uid() do stub).
#
# Sabotagem 5 (tirar anon do REVOKE do resumo): a postcondição embutida da migration aborta o apply
# com 'postcondicao: anon executa' — isso já é vermelho, pelo motivo certo; o laço exige só rc!=0 +
# essa mensagem. A 5b neutraliza a postcondição E tira o anon do REVOKE: aí a asserção (d) é que
# precisa ficar vermelha (prova que a asserção em si não é cega).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5474}"
SLUG="fin-ciclo-rpc"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG_VIEWS="$REPO_ROOT/supabase/migrations/20261014120000_fin_ciclo_cliente_views.sql"
MIG="$REPO_ROOT/supabase/migrations/20261015003200_fin_ciclo_rpcs_gate.sql"
MIG_NOME="$REPO_ROOT/supabase/migrations/20261018120000_fin_ciclo_nome_cliente.sql"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

U_MASTER="11111111-1111-1111-1111-111111111111"
U_EMPLOYEE="22222222-2222-2222-2222-222222222222"
U_MASTER_SO_OBEN="33333333-3333-3333-3333-333333333333"

preparar_banco() {
  "$PGBIN/dropdb" -p "$PORT" -h /tmp -U postgres --if-exists prove
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
  P -f "$REPO_ROOT/db/stubs-supabase.sql"
  P <<'SQL'
CREATE TABLE public.fin_contas_receber (
  company text, omie_codigo_cliente bigint, nome_cliente text, omie_codigo_lancamento bigint,
  numero_documento text, data_emissao date, data_vencimento date, valor_documento numeric,
  saldo numeric, status_titulo text, numero_documento_fiscal text);
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.fin_permissoes_stub (user_id uuid, empresas text[]);
-- Fontes de nome da 20261018120000 (so as colunas que a view le).
CREATE TABLE public.profiles (user_id uuid, name text);
CREATE TABLE public.omie_customer_account_map (account text, omie_codigo_cliente bigint, user_id uuid);
CREATE TABLE public.omie_clientes_nao_vinculados (empresa text, omie_codigo_cliente bigint, razao_social text, nome_fantasia text);

CREATE FUNCTION public.fin_user_can_access(check_company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p
                  WHERE p.user_id = auth.uid() AND check_company = ANY (p.empresas))
      OR (EXISTS (SELECT 1 FROM public.user_roles r
                   WHERE r.user_id = auth.uid() AND r.role IN ('master','employee'))
          AND NOT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid()))
$$;

-- Captura SO a SQLSTATE 42501 (o resto propaga e derruba a prova). Roda como o chamador (INVOKER).
CREATE FUNCTION public.t_lanca(q text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN SQLSTATE '42501' THEN
  RETURN '42501|' || SQLERRM;
END $$;

-- Como o Supabase: EXECUTE por default para as 3 roles (a migration precisa fechar as duas pontas).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT SELECT ON public.fin_contas_receber, public.v_titulo_baixas, public.user_roles,
                public.fin_permissoes_stub, public.profiles, public.omie_customer_account_map,
                public.omie_clientes_nao_vinculados TO authenticated;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.fin_permissoes_stub VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['oben']);

DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- oben cliente 1: 2 pagos (101,102). oben cliente 2: so vencidas abertas.
  INSERT INTO fin_contas_receber VALUES
    ('oben',1,'CLI UM',101,'D1',h-60,h-30,100,0,'RECEBIDO'),
    ('oben',1,'CLI UM',102,'D2',h-50,h-20,300,0,'RECEBIDO'),
    ('oben',2,'CLI DOIS',201,'E1',h-40,h-10,40,40,'ATRASADO'),
    ('oben',2,'CLI DOIS',202,'E2',h-150,h-120,60,60,'ATRASADO');
  INSERT INTO v_titulo_baixas VALUES
    ('oben',101,'CR',h-35,100,1,25,'titulo'),
    ('oben',102,'CR',h-10,300,1,40,'titulo');
  -- colacor cliente 3 (vencido) e cliente 8 (coorte de mes fechado).
  INSERT INTO fin_contas_receber VALUES
    ('colacor',3,'CLI TRES',301,'F1',h-40,h-10,80,80,'ATRASADO'),
    ('colacor',8,'CLI OITO',801,'J1',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,100,0,'RECEBIDO'),
    ('colacor',8,'CLI OITO',802,'J2',date_trunc('month',h-200)::date+5-30,date_trunc('month',h-200)::date+5,300,0,'RECEBIDO');
  INSERT INTO v_titulo_baixas VALUES
    ('colacor',801,'CR',h-150,100,1,40,'titulo'),
    ('colacor',802,'CR',h-150,300,1,20,'titulo');
  -- nomes (oben): 11 vinculo->perfil; 12 so nao-vinculados (fantasia); 13 fantasia vazia (razao); 14 nenhum.
  -- nome_cliente de fin_contas_receber vazio ('' e NULL), como em prod.
  INSERT INTO fin_contas_receber VALUES
    ('oben',11,'',1101,'N1',h-40,h-10,10,10,'ATRASADO'),
    ('oben',12,NULL,1201,'N2',h-40,h-10,10,10,'ATRASADO'),
    ('oben',13,'  ',1301,'N3',h-40,h-10,10,10,'ATRASADO'),
    ('oben',14,NULL,1401,'N4',h-40,h-10,10,10,'ATRASADO');
  INSERT INTO profiles VALUES ('44444444-4444-4444-4444-444444444444','PERFIL ONZE');
  INSERT INTO omie_customer_account_map VALUES ('oben',11,'44444444-4444-4444-4444-444444444444');
  INSERT INTO omie_clientes_nao_vinculados VALUES
    ('oben',11,'RAZAO ONZE NAO USADA','FANTASIA ONZE NAO USADA'),
    ('oben',12,'RAZAO DOZE','FANTASIA DOZE'),
    ('oben',13,'RAZAO TREZE','   ');
END $f$;
SQL
  P -f "$MIG_VIEWS"
}

# Migration de nome (aplicada depois das views e das RPCs): $1 = caminho.
aplicar_nome() { P -f "$1"; }

# Sessão simulada: $1 = uuid do usuário ('' = sem claims), $2 = SQL (uma consulta). Roda como authenticated.
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
# $1 = uuid, $2 = SQL, $3 = esperado, $4 = rótulo. Erro de psql vira valor distinto (nunca mascara).
oks() {
  local got; got="$(sess "$1" "$2" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$3" ]; then echo "FALHOU: $4 | esperado=[$3] obtido=[$got]"; falhas=$((falhas+1)); fi
}
okp() { # como postgres
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

RES="public.fin_ciclo_cliente_resumo()"
COO="public.fin_ciclo_empresa_coorte()"
TIT="public.fin_ciclo_titulos_cliente('oben', 1)"
BARRADO="42501|CICLO_SO_MASTER"

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }
  local nome_mig="${2:-$MIG_NOME}"
  aplicar_nome "$nome_mig" || { echo "APLICACAO FALHOU: $nome_mig"; return 99; }

  local n_res n_coo n_res_o n_coo_o n_tit
  n_res="$(Pq -c "SELECT count(*) FROM public.v_ciclo_cliente_resumo")"
  n_coo="$(Pq -c "SELECT count(*) FROM public.v_ciclo_empresa_coorte")"
  n_res_o="$(Pq -c "SELECT count(*) FROM public.v_ciclo_cliente_resumo WHERE company='oben'")"
  n_coo_o="$(Pq -c "SELECT count(*) FROM public.v_ciclo_empresa_coorte WHERE company='oben'")"
  n_tit="$(Pq -c "SELECT count(*) FROM public.v_ciclo_cr_titulos WHERE company='oben' AND omie_codigo_cliente=1")"
  # Fixture nao pode ser vacua: se a view vier vazia, a igualdade abaixo provaria nada.
  okp "SELECT ($n_res >= 4 AND $n_coo >= 2 AND $n_tit = 2 AND $n_res_o < $n_res AND $n_coo_o < $n_coo)" "t" "fixture nao vacua"

  # (a) master ve as 2 empresas, igual a view lida como postgres
  oks "$U_MASTER" "SELECT count(*) FROM $RES" "$n_res" "a master resumo count = view"
  oks "$U_MASTER" "SELECT string_agg(DISTINCT company, ',' ORDER BY company) FROM $RES" "colacor,oben" "a master resumo 2 empresas"
  oks "$U_MASTER" "SELECT count(*) FROM $COO" "$n_coo" "a master coorte count = view"
  oks "$U_MASTER" "SELECT string_agg(DISTINCT company, ',' ORDER BY company) FROM $COO" "colacor,oben" "a master coorte 2 empresas"
  oks "$U_MASTER" "SELECT string_agg(omie_codigo_lancamento::text, ',' ORDER BY omie_codigo_lancamento) FROM $TIT" "101,102" "a master titulos do cliente"
  oks "$U_MASTER" "SELECT count(*) FROM $TIT" "$n_tit" "a master titulos count = view"

  # (b) employee: gate 1 barra as 3
  oks "$U_EMPLOYEE" "SELECT public.t_lanca('SELECT * FROM $RES')" "$BARRADO" "b employee barrado no resumo"
  oks "$U_EMPLOYEE" "SELECT public.t_lanca('SELECT * FROM $COO')" "$BARRADO" "b employee barrado na coorte"
  oks "$U_EMPLOYEE" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_titulos_cliente(''oben'', 1)')" "$BARRADO" "b employee barrado nos titulos"

  # (c) sem claims (auth.uid() NULL)
  oks "" "SELECT public.t_lanca('SELECT * FROM $RES')" "$BARRADO" "c sem claims barrado no resumo"
  oks "" "SELECT public.t_lanca('SELECT * FROM $COO')" "$BARRADO" "c sem claims barrado na coorte"
  oks "" "SELECT public.t_lanca('SELECT * FROM public.fin_ciclo_titulos_cliente(''oben'', 1)')" "$BARRADO" "c sem claims barrado nos titulos"

  # (d) ACL
  okp "SELECT has_function_privilege('anon','$RES','EXECUTE')" "f" "d anon sem EXECUTE resumo"
  okp "SELECT has_function_privilege('anon','$COO','EXECUTE')" "f" "d anon sem EXECUTE coorte"
  okp "SELECT has_function_privilege('anon','public.fin_ciclo_titulos_cliente(text,bigint)','EXECUTE')" "f" "d anon sem EXECUTE titulos"
  okp "SELECT has_function_privilege('authenticated','public._fin_ciclo_gate_master()','EXECUTE')" "f" "d authenticated sem EXECUTE no gate"
  okp "SELECT has_function_privilege('authenticated','$RES','EXECUTE')" "t" "d authenticated com EXECUTE resumo"

  # (e) gate 2: master sem acesso a colacor so recebe oben
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) || '|' || string_agg(DISTINCT company, ',') FROM $RES" "$n_res_o|oben" "e gate2 resumo so oben"
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) || '|' || string_agg(DISTINCT company, ',') FROM $COO" "$n_coo_o|oben" "e gate2 coorte so oben"

  # (f) titulos de cliente de empresa sem acesso -> 0 linhas (e com acesso, as do cliente)
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) FROM public.fin_ciclo_titulos_cliente('colacor', 3)" "0" "f titulos de empresa sem acesso = 0"
  oks "$U_MASTER" "SELECT count(*) FROM public.fin_ciclo_titulos_cliente('colacor', 3)" "1" "f controle: master ve titulos de colacor"
  oks "$U_MASTER_SO_OBEN" "SELECT count(*) FROM $TIT" "$n_tit" "f master so-oben ve titulos de oben"

  # (g) nome do cliente (20261018120000), lido como master pela RPC. NULL imprime vazio (UI mostra #codigo).
  local NM="SELECT nome_cliente FROM $RES WHERE company='oben' AND omie_codigo_cliente"
  oks "$U_MASTER" "$NM = 1" "CLI UM" "g nome da propria fin_contas_receber segue valendo"
  oks "$U_MASTER" "$NM = 11" "PERFIL ONZE" "g nome vinculo -> perfil"
  oks "$U_MASTER" "$NM = 12" "FANTASIA DOZE" "g nome so nao-vinculados -> fantasia"
  oks "$U_MASTER" "$NM = 13" "RAZAO TREZE" "g nome fantasia vazia -> razao social"
  oks "$U_MASTER" "SELECT (nome_cliente IS NULL)::text FROM $RES WHERE company='oben' AND omie_codigo_cliente = 14" "true" "g nome sem nenhuma fonte -> NULL"
  oks "$U_MASTER" "SELECT count(*) FROM $RES WHERE company='oben' AND omie_codigo_cliente IN (11,12,13,14)" "4" "g nome nao duplica linhas"
  okp "SELECT has_table_privilege('anon','public.v_ciclo_cliente_resumo','SELECT')" "f" "g anon sem SELECT na view"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

# 2) FALSIFICAÇÃO — uma sabotagem por vez, vermelha PELA asserção esperada.
sabotar() { # $1 nome, $2 expressão sed, $3 rótulo esperado (FALHOU: <rotulo> |), $4 (opcional) "nome" = sabota a migration de nome
  local alvo="$MIG" a1="$TMPD/sab.sql" a2="$MIG_NOME"
  if [ "${4:-}" = "nome" ]; then alvo="$MIG_NOME"; a1="$MIG"; a2="$TMPD/sab.sql"; fi
  sed "$2" "$alvo" > "$TMPD/sab.sql"
  if cmp -s "$alvo" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: $1"; exit 1; fi
  local o r=0
  o="$(suite "$a1" "$a2" 2>&1)" || r=$?
  if [ "$r" -eq 0 ]; then echo "SABOTAGEM PASSOU (teste cego): $1"; exit 1; fi
  if [ "$r" -eq 99 ]; then echo "SABOTAGEM NAO APLICOU (erro de SQL, nao e prova): $1"; exit 1; fi
  if ! grep -qF "FALHOU: $3 |" <<<"$o"; then
    echo "SABOTAGEM VERMELHA PELO MOTIVO ERRADO: $1 (esperava FALHOU: $3)"; echo "$o"; exit 1
  fi
  echo "sabotagem vermelha ok: $1"
}
sabotar "1 sem gate master no resumo" \
  "/^CREATE OR REPLACE FUNCTION public.fin_ciclo_cliente_resumo/,/^\\\$\\\$;/{/PERFORM public._fin_ciclo_gate_master();/d;}" \
  "b employee barrado no resumo"
sabotar "2 sem fin_user_can_access no resumo" \
  "/^CREATE OR REPLACE FUNCTION public.fin_ciclo_cliente_resumo/,/^\\\$\\\$;/{s/WHERE public.fin_user_can_access(v.company)//;}" \
  "e gate2 resumo so oben"
sabotar "3 sem fin_user_can_access nos titulos" \
  "s/IF NOT public.fin_user_can_access(p_company) THEN/IF false THEN/" \
  "f titulos de empresa sem acesso = 0"
sabotar "4 gate aceita employee" \
  "s/role = 'master'/role IN ('master','employee')/" \
  "b employee barrado no resumo"

# 5) tirar anon do REVOKE: a postcondicao embutida aborta o apply (rc=99 da suite) — vermelho pelo motivo certo.
sed "s/REVOKE ALL ON FUNCTION public.fin_ciclo_cliente_resumo() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_cliente_resumo() FROM PUBLIC;/" "$MIG" > "$TMPD/sab.sql"
if cmp -s "$MIG" "$TMPD/sab.sql"; then echo "SABOTAGEM NAO ALTEROU O ARQUIVO: 5"; exit 1; fi
r=0; o="$(suite "$TMPD/sab.sql" 2>&1)" || r=$?
if [ "$r" -ne 99 ] || ! grep -qF "postcondicao: anon executa" <<<"$o"; then
  echo "SABOTAGEM 5 NAO ABORTOU PELA POSTCONDICAO (rc=$r)"; echo "$o"; exit 1
fi
echo "sabotagem vermelha ok: 5 anon fora do REVOKE (postcondicao aborta o apply, rc=$r)"

# 5b) idem + postcondicao neutralizada: a asserção (d) é que precisa ficar vermelha.
sabotar "5b anon fora do REVOKE sem postcondicao" \
  "s/REVOKE ALL ON FUNCTION public.fin_ciclo_cliente_resumo() FROM PUBLIC, anon;/REVOKE ALL ON FUNCTION public.fin_ciclo_cliente_resumo() FROM PUBLIC;/;s/IF has_function_privilege('anon', f, 'EXECUTE') THEN/IF false THEN/" \
  "d anon sem EXECUTE resumo"

# 6) nome: so a fonte da fin_contas_receber (cascata cortada) — vinculo e nao-vinculados somem.
sabotar "6 nome sem cascata (so nt.nome)" \
  "s/coalesce(nt.nome, nm.nome, nv.nome)/nt.nome/" \
  "g nome vinculo -> perfil" nome

echo "PROVA-CICLO-RPC-OK"

#!/usr/bin/env bash
# test-radar-acesso-vendedor.sh — prova EXECUTADA (PG17) da 20261029201200_radar_acesso_vendedor.sql: o gate
# PRÓPRIO do Radar (`private.cap_radar_prospectar`) inclui o vendedor sem afrouxar o da carteira, o dono temporário
# do lead ("em atendimento por X", 7 dias) e o aviso de telefone compartilhado.
#
# Monta o schema que PRODUÇÃO executa: snapshot + ACL medido (db/lib/corpo-vivo.sh) + o RETRATO de prod de
# 2026-10-29 (db/fixtures/radar-acesso-vendedor-prod-20261029.sql: colunas, tabelas, policies e o corpo vivo das RPCs
# cujo gate muda — conferido pelo md5 de prod ANTES da migration). A cadeia viva pega só a migration desta entrega
# (os objetos guardados são os novos), e é ela — o arquivo REAL — que roda sobre o retrato.
#
# Limite declarado: as RPCs antigas do radar NÃO estão em CV_FUNCOES (guardá-las puxaria a cadeia radar de outubro,
# que aborta sobre o snapshot de 15/10 na pós-condição da 20261020143000). Uma migration FUTURA que recrie uma delas
# não é exercitada aqui; quem a escreve parte do corpo vivo (regra do lovable-db-operator) e preserva o gate.
#
# Uso:
#   bash db/test-radar-acesso-vendedor.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-radar-acesso-vendedor.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5493}"
TMPD="$(mktemp -d /tmp/pgtest-radar-acesso.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
MIG="$REPO_ROOT/supabase/migrations/20261029201200_radar_acesso_vendedor.sql"
[ -f "$FIXTURE" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }

# Os objetos NOVOS desta entrega: a cadeia dinâmica seleciona a migration que os cria (e a próxima que os tocar).
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar radar_atendimento_expira_em radar_definir_atendimento radar_atendimentos_ativos
            radar_telefone_compartilhado)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(radar_atendimentos)
# O retrato de prod ANTES da cadeia, com o md5 de cada corpo vivo conferido: fixture que derivar de prod (ou
# colagem que perdeu 1 byte) aborta aqui, antes de a PRE da migration medir qualquer coisa.
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  # O snapshot de 15/10 ainda tem a assinatura de 8 parâmetros da contagem; em prod (psql-ro, 29/10) só existe a de 10.
  # Com as duas, a chamada sem argumentos é AMBÍGUA (42725) — artefato do harness, não de prod.
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
  P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $md5$
DECLARE r record; v text; n int;
BEGIN
  -- Overloads: como em prod, exatamente 1 assinatura por RPC sob prova.
  FOR r IN SELECT x.nome FROM (VALUES ('radar_kpis'),('radar_contagem_por_municipio'),('radar_estado_cadastro_omie'),
      ('radar_irmaos_por_raiz'),('radar_prospects_para_rota'),('radar_registrar_cadastro_omie'),
      ('radar_registrar_cadastro_omie_v2'),('registrar_contato_radar')) AS x(nome)
  LOOP
    SELECT count(*) INTO n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.nome;
    IF n <> 1 THEN RAISE EXCEPTION 'OVERLOAD FORA DE PROD: % tem % assinaturas (prod: 1)', r.nome, n; END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('public.radar_kpis()', '19d4b2c33d5c6749b522147aae09c969'),
    ('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamp with time zone)', '321d07f0c0003cc0fc9cf269ba944883'),
    ('public.radar_estado_cadastro_omie(text)', '79dea3224bbf32ad725a83d22b29aaac'),
    ('public.radar_irmaos_por_raiz(text[])', '15d1e7035c3deb7c44ffc6430f03021e'),
    ('public.radar_prospects_para_rota(text,integer)', '096e5379e5903f1b36c4a869445e34af'),
    ('public.radar_registrar_cadastro_omie(text,text,boolean)', '2b3dbe0da01ac37b07b1cb5b76be139c'),
    ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', 'b07c1a878e9930cb1a1a3c175be691d6'),
    ('public.registrar_contato_radar(text,text,text)', 'c84e25c9e0926410a08775d8574d6734')) AS x(sig, md5)
  LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'FIXTURE DIVERGE DE PROD: % (md5 %, prod %)', r.sig, v, r.md5; END IF;
  END LOOP;
END $md5$;
SQL
  echo "    · fixture = prod (8 corpos vivos pelo md5)"
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + ACL de prod + retrato de 29/10 + migration…"
cv_montar

MASTER='00000000-0000-0000-0000-00000000a001'
GER='00000000-0000-0000-0000-00000000a002'     # employee + gerencial
FARM='00000000-0000-0000-0000-00000000a003'    # employee + farmer ("Vendedor Um")
FARM2='00000000-0000-0000-0000-00000000a004'   # employee + farmer ("Vendedor Dois")
FARM3='00000000-0000-0000-0000-00000000a005'   # employee + hunter (teto de 100)
FARM4='00000000-0000-0000-0000-00000000a00a'   # employee + closer (teto sob corrida: 99 posses)
OPER='00000000-0000-0000-0000-00000000a006'    # employee + operacional: fora
EMP0='00000000-0000-0000-0000-00000000a007'    # employee sem cargo: fora
CLI='00000000-0000-0000-0000-00000000a008'     # customer
CLICR='00000000-0000-0000-0000-00000000a009'   # customer com cargo comercial residual 'farmer': fora
# Leads: L1/L2/L3 de raízes diferentes com o MESMO telefone; L6 é filial de L1 (mesma raiz, mesmo telefone);
# L4 já é cliente; L7 é irmã (mesma raiz) de L4; L5 tem raiz de um cliente que só existe no Omie.
L1='11111111000101'; L6='11111111000292'; L2='22222222000102'; L3='33333333000103'
L4='44444444000104'; L7='44444444000295'; L5='55555555000105'; L8='88888888000108'; L9='99999999000109'
SOOMIE='55555555000296'
LA='12121212000112'; LB='13131313000113'; LC='14141414000114'   # cadastro do vendedor, do gestor; renovação
LD="$(printf '%08d000199' 70000201)"; LE="$(printf '%08d000199' 70000202)"   # teto sob corrida
TEL='(31) 11111111'

echo "→ seed-base: papéis, leads, contatos, situação, conflito, cliente só-Omie…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$FARM2'),('$FARM3'),('$OPER'),('$EMP0'),('$CLI'),('$CLICR'),('$FARM4');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER','master'),('$GER','employee'),('$FARM','employee'),('$FARM2','employee'),('$FARM3','employee'),
  ('$OPER','employee'),('$EMP0','employee'),('$CLI','customer'),('$CLICR','customer'),('$FARM4','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer'),('$FARM2','farmer'),('$FARM3','hunter'),
  ('$OPER','operacional'),('$CLICR','farmer'),('$FARM4','closer');
INSERT INTO public.profiles (user_id, name) VALUES
  ('$FARM','Vendedor Um'),('$FARM2','Vendedor Dois'),('$FARM3','Vendedor Tres'),('$GER','Gestor');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, municipio_codigo, municipio_nome, uf,
                                   telefone1, telefone2, ja_cliente) VALUES
  ('$L1','LEAD UM','4744005','2026-10','3106200','BELO HORIZONTE','MG','$TEL',NULL,false),
  ('$L6','LEAD UM FILIAL','4744005','2026-10','3106200','BELO HORIZONTE','MG','$TEL',NULL,false),
  ('$L2','LEAD DOIS','4744005','2026-10','3106200','BELO HORIZONTE','MG',NULL,'$TEL',false),
  ('$L3','LEAD TRES','4744005','2026-10','3106200','BELO HORIZONTE','MG','$TEL',NULL,false),
  ('$L4','CLIENTE QUATRO','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 44444444',NULL,true),
  ('$L7','LEAD SETE','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 77777777',NULL,false),
  ('$L5','LEAD CINCO','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 55555555',NULL,false),
  ('$L8','LEAD OITO','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 88888888',NULL,false),
  ('$L9','LEAD NOVE','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 99999999',NULL,false),
  ('$LA','LEAD A','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 12121212',NULL,false),
  ('$LB','LEAD B','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 13131313',NULL,false),
  ('$LC','LEAD C','4744005','2026-10','3106200','BELO HORIZONTE','MG','(31) 14141414',NULL,false);
-- O Omie confirmou (ledger do servidor) os clientes criados para LA e LB: sem isso a v1 recusa o vínculo.
INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES
  ('oben','$LA','555','incluir'), ('oben','$LB','556','incluir');
-- Leads extras para o teto por dono: 1..100 do hunter, 102..200 (99) do closer, 101/201/202 livres.
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente)
SELECT lpad((70000000 + g)::text, 8, '0') || '000199', 'EXTRA ' || g, '4744005', '2026-10', false
  FROM generate_series(1, 202) g;
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao) VALUES ('$L1', '2026-10', '08');
INSERT INTO public.radar_cadastro_conflitos (cnpj, motivo, detalhe, criado_por, ultimo_por)
  VALUES ('$L9', 'lookup_ambiguo', 'seed', '$GER', '$GER');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('$L9', 'contatado_sem_resposta', '$GER');
INSERT INTO public.omie_clientes_nao_vinculados (empresa, omie_codigo_cliente, cnpj_cpf, razao_social, synced_at)
  VALUES ('oben', 900001, '$SOOMIE', 'CLIENTE SO OMIE', now());
COMMIT;
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — a leitura COMO o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
# st_como <papel> <uid> <sql> — 'OK' ou a SQLSTATE (com a camada quando é 42501), via prova.sqlstate.
st_como() { q_como "$1" "$2" "SELECT prova.sqlstate(\$cmd\$$3\$cmd\$);"; }
# gate_como <uid> <sql> — 'NEGADO' se a recusa foi o gate do Radar/gestor; 'PASSOU' se a chamada terminou ou parou num
# erro de DOMÍNIO depois do gate (validação 22023, não-encontrado P0002, RAISE de regra P0001 e os RD00x do cadastro).
# Qualquer outro erro (42P01 tabela ausente, 42702 ambiguidade, 42501 de ACL interno) é 'TECNICO:<sqlstate>' — VERMELHO:
# falha técnica não prova que o gate deixou passar (achado 6 do Codex no código).
gate_como() {
  local out
  out="$(q_como authenticated "$1" "DO \$g\$ BEGIN PERFORM $2; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'forbidden: %' THEN RAISE EXCEPTION 'GATE_NEGOU'; END IF;
    IF SQLSTATE NOT IN ('22023','P0002','P0001','RD001','RD002','RD003','RD004') THEN
      RAISE EXCEPTION 'TECNICO:%:%', SQLSTATE, left(SQLERRM, 80);
    END IF; END \$g\$; SELECT 'PASSOU';")"
  case "$out" in *GATE_NEGOU*) printf 'NEGADO' ;; PASSOU) printf 'PASSOU' ;; *TECNICO:*) printf 'TECNICO:%s' "${out##*TECNICO:}" ;; *) printf '%s' "$out" ;; esac
}
cap() { P -tA -q -c "SELECT private.cap_radar_prospectar($1)"; }
# corrida <uidA> <cnpjA> <uidB> <cnpjB> <campo de B> — A assume e segura a transação por 1,5 s; B assume no meio.
# Devolve CORRIDA_A (o `ok` de A) e CORRIDA_B (o <campo> de B, ou o erro).
corrida() {
  local claimsA claimsB pidA
  claimsA="{\"sub\":\"$1\",\"role\":\"authenticated\"}"; claimsB="{\"sub\":\"$3\",\"role\":\"authenticated\"}"
  P -v ON_ERROR_STOP=1 -tA -q -c "BEGIN" -c "SET LOCAL ROLE authenticated" -c "SET LOCAL request.jwt.claims = '$claimsA'" \
    -c "SELECT public.radar_definir_atendimento('$2','assumir')->>'ok'" -c "SELECT pg_sleep(1.5)" -c "COMMIT" > "$TMPD/corridaA.out" 2>&1 &
  pidA=$!
  sleep 0.5
  CORRIDA_B="$(P -tA -q -c "SET ROLE authenticated" -c "SET request.jwt.claims = '$claimsB'" \
    -c "SELECT public.radar_definir_atendimento('$4','assumir')->>'$5'" 2>&1 | tr '\n' ' ' | sed 's/ *$//' | cut -c1-120)"
  wait "$pidA" || true
  CORRIDA_A="$(tr -d '\n ' < "$TMPD/corridaA.out")"
}
definir() { q_como authenticated "$1" "SELECT public.radar_definir_atendimento('$2','$3')->>'$4'"; }

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "── A. capability ──"
  chk A1 "master passa"                         "$(cap "'$MASTER'")" "t"
  chk A2 "gerencial passa"                      "$(cap "'$GER'")"    "t"
  chk A3 "farmer passa"                         "$(cap "'$FARM'")"   "t"
  chk A4 "hunter passa"                         "$(cap "'$FARM3'")"  "t"
  chk A5 "operacional NÃO passa"                "$(cap "'$OPER'")"   "f"
  chk A6 "employee sem cargo NÃO passa"         "$(cap "'$EMP0'")"   "f"
  chk A7 "customer NÃO passa"                   "$(cap "'$CLI'")"    "f"
  chk A8 "customer com cargo residual NÃO passa" "$(cap "'$CLICR'")" "f"
  chk A9 "uid nulo é false (não NULL)"          "$(cap "NULL")"      "f"
  chk A10 "pode_ver_carteira_completa NÃO mudou para o farmer" \
    "$(P -tA -q -c "SELECT public.pode_ver_carteira_completa('$FARM')")" "f"

  echo "── B. gate das RPCs (authenticated + JWT) ──"
  chk B1 "farmer: radar_kpis passa"             "$(gate_como "$FARM" "public.radar_kpis()")" "PASSOU"
  chk B2 "operacional: radar_kpis negado"       "$(gate_como "$OPER" "public.radar_kpis()")" "NEGADO"
  chk B3 "customer: radar_kpis negado"          "$(gate_como "$CLI" "public.radar_kpis()")"  "NEGADO"
  chk B4 "farmer: contagem por município passa" "$(gate_como "$FARM" "public.radar_contagem_por_municipio()")" "PASSOU"
  chk B5 "farmer: estado do cadastro passa"     "$(gate_como "$FARM" "public.radar_estado_cadastro_omie('$L1')")" "PASSOU"
  chk B6 "farmer: prospects da rota passa"      "$(gate_como "$FARM" "public.radar_prospects_para_rota('3106200', 5)")" "PASSOU"
  chk B7 "farmer: registrar contato passa"      "$(gate_como "$FARM" "public.registrar_contato_radar('$L8','em_conversa',NULL)")" "PASSOU"
  chk B8 "operacional: registrar contato negado" "$(gate_como "$OPER" "public.registrar_contato_radar('$L8','em_conversa',NULL)")" "NEGADO"
  chk B9 "farmer: cadastro v2 COMPLETA (v1 por dentro)" "$(q_como authenticated "$FARM" "SELECT public.radar_registrar_cadastro_omie_v2('$LA','555',false)->>'ok'")" "true"
  chk B9b "…e vincula o lead"                   "$(P -tA -q -c "SELECT omie_codigo_cliente || '|' || ja_cliente FROM public.radar_empresas WHERE cnpj='$LA'")" "555|true"
  chk B9c "gerencial: cadastro v2 COMPLETA"     "$(q_como authenticated "$GER" "SELECT public.radar_registrar_cadastro_omie_v2('$LB','556',false)->>'ok'")" "true"
  chk B9d "farmer: v2 sem confirmação do Omie recusa (domínio, não gate)" "$(gate_como "$FARM" "public.radar_registrar_cadastro_omie_v2('$L7','999',false)")" "PASSOU"
  chk B10 "operacional: cadastro v2 negado"     "$(gate_como "$OPER" "public.radar_registrar_cadastro_omie_v2('$L7','123',false)")" "NEGADO"
  chk B11 "farmer: v1 DIRETA sem EXECUTE"       "$(st_como authenticated "$FARM" "SELECT public.radar_registrar_cadastro_omie('$L7','123',false)")" "42501/acl-funcao:radar_registrar_cadastro_omie"
  chk B12 "master: v1 DIRETA sem EXECUTE"       "$(st_como authenticated "$MASTER" "SELECT public.radar_registrar_cadastro_omie('$L7','123',false)")" "42501/acl-funcao:radar_registrar_cadastro_omie"
  chk B13 "farmer: resolver conflito segue negado" "$(gate_como "$FARM" "public.radar_resolver_conflito_cadastro(1, 1, 'x')")" "NEGADO"
  chk B14 "gerencial: resolver conflito passa"  "$(gate_como "$GER" "public.radar_resolver_conflito_cadastro(999, 1, 'conferido')")" "PASSOU"
  chk B15 "farmer: registrar conflito segue negado" "$(gate_como "$FARM" "public.radar_registrar_conflito_cadastro('$L7','lookup_ambiguo',NULL,'inventado')")" "NEGADO"
  chk B16 "farmer: salvar geocode segue negado" "$(gate_como "$FARM" "public.radar_salvar_geocode('$L7', 1, 1, 'ok')")" "NEGADO"
  chk B17 "farmer: atribuir tarefa segue negado" "$(gate_como "$FARM" "public.radar_atribuir_tarefa('$L7', 7)")" "NEGADO"
  chk B18 "anon: radar_kpis sem EXECUTE"        "$(st_como anon "" "SELECT public.radar_kpis()")" "42501/acl-funcao:radar_kpis"
  chk B19 "authenticated sem sub: radar_kpis negado" "$(gate_como "" "public.radar_kpis()")" "NEGADO"

  echo "── C. RLS de leitura ──"
  chk C1 "farmer lê radar_empresas"             "$(q_como authenticated "$FARM" "SELECT count(*) FROM public.radar_empresas")" "214"
  chk C2 "operacional lê 0 em radar_empresas"   "$(q_como authenticated "$OPER" "SELECT count(*) FROM public.radar_empresas")" "0"
  chk C3 "customer lê 0 em radar_empresas"      "$(q_como authenticated "$CLI" "SELECT count(*) FROM public.radar_empresas")" "0"
  chk C4 "farmer lê radar_contatos"             "$(q_como authenticated "$FARM" "SELECT count(*) > 0 FROM public.radar_contatos")" "t"
  chk C5 "farmer lê 0 em radar_situacao_cadastral (segue gestor)" "$(q_como authenticated "$FARM" "SELECT count(*) FROM public.radar_situacao_cadastral")" "0"
  chk C6 "gerencial lê radar_situacao_cadastral" "$(q_como authenticated "$GER" "SELECT count(*) FROM public.radar_situacao_cadastral")" "1"
  chk C7 "farmer lê 0 em radar_cadastro_conflitos (segue gestor)" "$(q_como authenticated "$FARM" "SELECT count(*) FROM public.radar_cadastro_conflitos")" "0"
  chk C8 "farmer vê o conflito do LEAD pela RPC" \
    "$(q_como authenticated "$FARM" "SELECT jsonb_array_length(public.radar_estado_cadastro_omie('$L9')->'conflitos')")" "1"
  chk C9 "farmer não lê radar_atendimentos direto" "$(st_como authenticated "$FARM" "SELECT count(*) FROM public.radar_atendimentos")" "42501/acl-tabela:radar_atendimentos"
  chk C10 "farmer não escreve radar_atendimentos direto" \
    "$(st_como authenticated "$FARM" "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L8', '$FARM', now())")" "42501/acl-tabela:radar_atendimentos"

  echo "── D. irmãos: projeção dos clientes só-Omie ──"
  chk D1 "farmer: cliente só-Omie NÃO aparece" \
    "$(q_como authenticated "$FARM" "SELECT irmaos_clientes || '|' || coalesce(cliente_nome,'-') FROM public.radar_irmaos_por_raiz(ARRAY['$L5'])")" "0|-"
  chk D2 "gerencial: cliente só-Omie aparece" \
    "$(q_como authenticated "$GER" "SELECT irmaos_clientes || '|' || coalesce(cliente_nome,'-') FROM public.radar_irmaos_por_raiz(ARRAY['$L5'])")" "1|CLIENTE SO OMIE"
  chk D3 "farmer: irmão já-cliente DO RADAR aparece" \
    "$(q_como authenticated "$FARM" "SELECT irmaos_clientes || '|' || coalesce(cliente_nome,'-') FROM public.radar_irmaos_por_raiz(ARRAY['$L7'])")" "1|CLIENTE QUATRO"

  echo "── E. dono temporário ──"
  chk E1 "farmer assume L1"                     "$(definir "$FARM" "$L1" assumir ok)" "true"
  chk E2 "outro farmer recebe em_atendimento"   "$(definir "$FARM2" "$L1" assumir motivo)" "em_atendimento"
  chk E3 "…com o nome do dono"                  "$(definir "$FARM2" "$L1" assumir dono_nome)" "Vendedor Um"
  chk E4 "o dono renova"                        "$(definir "$FARM" "$L1" assumir renovado)" "true"
  chk E5 "ativos: o dono vê eh_meu"             "$(q_como authenticated "$FARM" "SELECT eh_meu FROM public.radar_atendimentos_ativos() WHERE cnpj='$L1'")" "t"
  chk E6 "ativos: o outro vê o dono"            "$(q_como authenticated "$FARM2" "SELECT dono_nome || '|' || eh_meu FROM public.radar_atendimentos_ativos() WHERE cnpj='$L1'")" "Vendedor Um|false"
  chk E7 "outro farmer NÃO libera"              "$(definir "$FARM2" "$L1" liberar motivo)" "nao_e_dono"
  chk E8 "gestor libera o de outro"             "$(definir "$GER" "$L1" liberar ok)" "true"
  chk E9 "…e encerra como gestor_liberou"       "$(P -tA -q -c "SELECT motivo_encerramento FROM public.radar_atendimentos WHERE cnpj='$L1' ORDER BY id DESC LIMIT 1")" "gestor_liberou"
  chk E10 "livre depois de liberado"            "$(q_como authenticated "$FARM2" "SELECT count(*) FROM public.radar_atendimentos_ativos() WHERE cnpj='$L1'")" "0"
  chk E11 "já cliente não se assume"            "$(definir "$FARM" "$L4" assumir motivo)" "ja_cliente"
  chk E12 "operacional: definir negado"         "$(st_como authenticated "$OPER" "SELECT public.radar_definir_atendimento('$L2','assumir')")" "42501/?"
  chk E13 "ação NULL recusada"                  "$(st_como authenticated "$FARM" "SELECT public.radar_definir_atendimento('$L2',NULL)")" "22023"
  # Expiração: posse de 8 dias sem toque é LIVRE e o próximo assumir a encerra como 'expirado'.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L2','$FARM', now() - interval '8 days')"
  chk E14 "posse vencida não aparece nos ativos" "$(q_como authenticated "$FARM2" "SELECT count(*) FROM public.radar_atendimentos_ativos() WHERE cnpj='$L2'")" "0"
  chk E15 "outro assume a vencida"              "$(definir "$FARM2" "$L2" assumir ok)" "true"
  chk E16 "…e a antiga fecha como expirado no prazo" \
    "$(P -tA -q -c "SELECT motivo_encerramento || '|' || (encerrado_em = assumido_em + interval '7 days') FROM public.radar_atendimentos WHERE cnpj='$L2' AND dono_user_id='$FARM'")" "expirado|true"
  # Contato do dono DENTRO do prazo renova: assumido há 6 dias, contato há 1 dia ⇒ ativo por mais 6.
  P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L6','$FARM', now() - interval '6 days');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at) VALUES ('$L6','em_conversa','$FARM', now() - interval '1 day');
SQL
  chk E17 "contato do dono no prazo renova"      "$(definir "$FARM2" "$L6" assumir motivo)" "em_atendimento"
  # Cadeia: assumido há 10 dias, toque há 9 (vence há 2), toque há 1 = DEPOIS de vencer ⇒ não ressuscita.
  P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L3','$FARM', now() - interval '10 days');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at) VALUES
  ('$L3','em_conversa','$FARM', now() - interval '9 days'), ('$L3','em_conversa','$FARM', now() - interval '1 day');
SQL
  chk E18 "contato tardio NÃO ressuscita a posse" "$(q_como authenticated "$FARM2" "SELECT count(*) FROM public.radar_atendimentos_ativos() WHERE cnpj='$L3'")" "0"
  chk E19 "…a expiração é a do toque válido (há 2 dias)" \
    "$(P -tA -q -c "SELECT private.radar_atendimento_expira_em('$L3','$FARM', a.assumido_em, NULL) = (SELECT min(created_at) FROM public.radar_contatos WHERE cnpj='$L3') + interval '7 days' FROM public.radar_atendimentos a WHERE a.cnpj='$L3'")" "t"
  # Teto: 100 posses ativas do hunter ⇒ a 101ª é recusada.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em)
    SELECT lpad((70000000 + g)::text, 8, '0') || '000199', '$FARM3', now() FROM generate_series(1, 100) g"
  chk E20 "teto de 100 por dono"                 "$(definir "$FARM3" "$(printf '%08d000199' 70000101)" assumir motivo)" "limite"
  # Dono que perde a capability some dos ativos.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('$L5','$OPER', now())"
  chk E21 "posse de quem perdeu a capability não aparece" "$(q_como authenticated "$FARM" "SELECT count(*) FROM public.radar_atendimentos_ativos() WHERE cnpj='$L5'")" "0"
  chk E21b "…e não bloqueia: outro assume"       "$(definir "$FARM" "$L5" assumir ok)" "true"
  chk E21c "…fechando a antiga como dono_sem_acesso" "$(P -tA -q -c "SELECT motivo_encerramento FROM public.radar_atendimentos WHERE cnpj='$L5' AND dono_user_id='$OPER'")" "dono_sem_acesso"
  # Renovação NÃO encurta: assumido há 12 dias, renovado há 6 (ativo até amanhã). Renovar de novo agora tem de dar
  # 7 dias a partir de agora — antes, a cadeia partia do assumido+7, batia na renovação nova e vencia retroativamente.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, renovado_em) VALUES ('$LC','$FARM', now() - interval '12 days', now() - interval '6 days')"
  chk E27 "renovar posse antiga"                 "$(definir "$FARM" "$LC" assumir renovado)" "true"
  chk E28 "…segue ativa para os outros"          "$(definir "$FARM2" "$LC" assumir motivo)" "em_atendimento"
  # Teto sob corrida: o closer tem 99 posses; duas sessões dele assumem CNPJs DIFERENTES ao mesmo tempo. Com a trava
  # por dono, a 2ª espera e recebe 'limite'; sem ela, as duas contam 99 e ele fica com 101.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em)
    SELECT lpad((70000000 + g)::text, 8, '0') || '000199', '$FARM4', now() FROM generate_series(102, 200) g"
  corrida "$FARM4" "$LD" "$FARM4" "$LE" motivo
  chk E25 "teto sob corrida: a 1ª assume"        "$CORRIDA_A" "true"
  chk E26 "teto sob corrida: a 2ª recebe limite" "$CORRIDA_B" "limite"
  # Corrida no MESMO CNPJ: com a trava, B espera e recebe em_atendimento; sem ela, B bate no índice único (23505).
  corrida "$FARM" "$L8" "$FARM2" "$L8" motivo
  chk E22 "corrida: o 1º assume"                 "$CORRIDA_A" "true"
  chk E23 "corrida: o 2º espera e recebe em_atendimento" "$CORRIDA_B" "em_atendimento"
  chk E24 "corrida: 1 aberto só"                 "$(P -tA -q -c "SELECT count(*) FROM public.radar_atendimentos WHERE cnpj='$L8' AND encerrado_em IS NULL")" "1"

  echo "── F. telefone compartilhado ──"
  chk F1 "L1: o número aparece em 2 outras raízes (a filial não conta)" \
    "$(q_como authenticated "$FARM" "SELECT telefone || '=' || outras_raizes FROM public.radar_telefone_compartilhado('$L1')")" "$TEL=2"
  chk F2 "número exclusivo: 0"                   "$(q_como authenticated "$FARM" "SELECT outras_raizes FROM public.radar_telefone_compartilhado('$L8')")" "0"
  chk F3 "operacional: negado"                   "$(st_como authenticated "$OPER" "SELECT * FROM public.radar_telefone_compartilhado('$L1')")" "42501/?"

  echo "── G. catálogo ──"
  chk G1 "re-aplicar a migration é no-op"        "$(P -v ON_ERROR_STOP=1 -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk G2 "cap: anon sem EXECUTE"                 "$(P -tA -q -c "SELECT has_function_privilege('anon','private.cap_radar_prospectar(uuid)','EXECUTE')")" "f"
  chk G3 "definir: anon sem EXECUTE"             "$(P -tA -q -c "SELECT has_function_privilege('anon','public.radar_definir_atendimento(text,text)','EXECUTE')")" "f"
}

# sabotagem <nome> — muda UMA camada no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
sabotagem() {
  case "$1" in
    cap_aceita_operacional) cv_sabotar 'private.cap_radar_prospectar(uuid)' "'farmer','hunter','closer')" "'farmer','hunter','closer','operacional')" ;;
    policy_empresas_gestor) P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY radar_empresas_select_gestor ON public.radar_empresas USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))))" ;;
    situacao_aberta)        P -v ON_ERROR_STOP=1 -q -c "ALTER POLICY radar_situacao_cadastral_select_gestor ON public.radar_situacao_cadastral USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))))" ;;
    v1_reaberta)            P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION public.radar_registrar_cadastro_omie(text,text,boolean) TO authenticated" ;;
    irmaos_sem_projecao)    cv_sabotar 'public.radar_irmaos_por_raiz(text[])' "WHERE (SELECT COALESCE(private.cap_carteira_ler(auth.uid()), false)) AND left(d.doc, 8)" "WHERE left(d.doc, 8)" ;;
    expira_ressuscita)      cv_sabotar 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)' "EXIT WHEN v_toque >= v_expira;" "" ;;
    sem_trava)              cv_sabotar 'public.radar_definir_atendimento(text,text)' "PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || p_cnpj, 0));" "" ;;
    liberar_qualquer)       cv_sabotar 'public.radar_definir_atendimento(text,text)' "ELSIF COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN" "ELSIF true THEN" ;;
    definir_sem_gate)       cv_sabotar 'public.radar_definir_atendimento(text,text)' "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN" "IF false THEN" ;;
    ja_cliente_assume)      cv_sabotar 'public.radar_definir_atendimento(text,text)' "IF COALESCE(v_ja_cliente, false) THEN" "IF false THEN" ;;
    telefone_mesma_raiz)    cv_sabotar 'public.radar_telefone_compartilhado(text)' "AND left(o.cnpj, 8) <> left(p_cnpj, 8))" ")" ;;
    sem_trava_dono)         cv_sabotar 'public.radar_definir_atendimento(text,text)' "PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento_dono:' || v_uid::text, 0));" "" ;;
    escrita_ignora_cap_dono) cv_sabotar 'public.radar_definir_atendimento(text,text)' "ELSIF NOT (COALESCE(private.cap_radar_prospectar(v_aberto.dono_user_id), false)) THEN" "ELSIF false THEN" ;;
    renovacao_curta)        cv_sabotar 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)' "v_inicio timestamptz := GREATEST(p_assumido_em, p_renovado_em);" "v_inicio timestamptz := p_assumido_em;" ;;
    ativos_sem_cap_dono)    cv_sabotar 'public.radar_atendimentos_ativos()' "AND private.cap_radar_prospectar(a.dono_user_id)" "" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelho>[:<ids que têm de seguir verdes>]
SABOTAGENS="cap_aceita_operacional:A5,B2,B8,C2:A3,B1
policy_empresas_gestor:C1:C2,C4
situacao_aberta:C5:C6
v1_reaberta:B11,B12:B9
irmaos_sem_projecao:D1:D2,D3
expira_ressuscita:E18,E19:E17
sem_trava:E23:E22
liberar_qualquer:E7:E8
definir_sem_gate:E12:E1
ja_cliente_assume:E11:E1
telefone_mesma_raiz:F1,F2:F3
ativos_sem_cap_dono:E21:E5
sem_trava_dono:E26:E25
escrita_ignora_cap_dono:E21b,E21c:E21
renovacao_curta:E28:E27"

rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
  DB=rodada
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ───────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: o controle roda primeiro e, vermelho, aborta antes
# da primeira sabotagem.
echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_|SABOTAGEM' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]

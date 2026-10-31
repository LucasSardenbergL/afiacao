#!/usr/bin/env bash
# test-radar-contato-integridade.sh — prova EXECUTADA (PG17) da 20261031111000_radar_contato_integridade.sql:
#   · 'virou_cliente' só com o cliente confirmado no ledger do servidor (RD005), na RPC (porta) e no trigger (classe —
#     inclusive o corpo ANTIGO da RPC em voo e o INSERT direto); re-marcar é no-op; cliente confirmado só sai pelo
#     gestor (RD007); a conversão não se desfaz (RD006);
#   · desfazer_contato_radar restaura só o DONO do status (autoria explícita), com o retrato do estado substituído
#     (status, motivo, carimbo, dono anterior) e tirando o contato da cadeia — inclusive o traço do Codex
#     (A descarta, B conversa, o cron da RFB descarta, B desfaz, A conversa e desfaz duas vezes: o descarte da RFB fica);
#   · duas corridas com o bloqueio OBSERVADO em pg_stat_activity (registrar × desfazer; dois desfazer do mesmo contato).
#
# Monta o schema de PRODUÇÃO como a db/test-radar-acesso-vendedor.sh: snapshot + ACL medido + retrato de 2026-10-29 +
# a 20261029201200 (cadeia viva), e por cima o corpo vivo do desfazer (db/fixtures/radar-contato-integridade-prod-
# 20261031.sql). Os 3 corpos que a migration lê ou exercita têm o md5 de prod conferido ANTES dela.
#
# Limites declarados: o cron radar_aplicar_situacao e as triggers de radar_eventos (frente 3) não estão no harness — o
# cron é simulado pelos seus dois comandos (INSERT do contato do sistema com p_agora + UPDATE do status), e as
# triggers de evento são fail-open (não mudam status nem contato).
#
# Uso:
#   bash db/test-radar-contato-integridade.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-radar-contato-integridade.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5494}"
TMPD="$(mktemp -d /tmp/pgtest-radar-contato.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
FIXTURE_DESFAZER="$REPO_ROOT/db/fixtures/radar-contato-integridade-prod-20261031.sql"
MIG="$REPO_ROOT/supabase/migrations/20261031111000_radar_contato_integridade.sql"
[ -f "$FIXTURE" ] && [ -f "$FIXTURE_DESFAZER" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }

# A mesma cadeia da db/test-radar-acesso-vendedor.sh: os objetos da frente 2 puxam a 20261029201200, que leva
# registrar_contato_radar e o cadastro (v1/v2) ao corpo de prod. A 20261031111000 NÃO entra pela cadeia (não faz DDL
# nesses objetos): é aplicada abaixo, explicitamente, depois de conferido o predecessor.
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar radar_atendimento_expira_em radar_definir_atendimento radar_atendimentos_ativos
            radar_telefone_compartilhado)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(radar_atendimentos)
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: snapshot + ACL de prod + retrato de 29/10 + 20261029201200 + desfazer vivo + esta migration…"
cv_montar
P -v ON_ERROR_STOP=1 -q -f "$FIXTURE_DESFAZER" > /dev/null
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $md5$
DECLARE r record; v text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.registrar_contato_radar(text,text,text)',            '658d383c7f34f97427aacb053714ea3e'),
    ('public.desfazer_contato_radar(uuid)',                       'f695b1e6ca8fd9dac19f7b0ea08897e7'),
    ('public.radar_registrar_cadastro_omie(text,text,boolean)',   '0cd48f99a8683fa14c05a744372eb030'),
    ('public.radar_registrar_cadastro_omie_v2(text,text,boolean)', 'bda54cdc691c0682bb0e8b39a0fd7b0d')) AS x(sig, md5)
  LOOP
    SELECT md5(p.prosrc) INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'HARNESS DIVERGE DE PROD: % (md5 %, prod %)', r.sig, v, r.md5; END IF;
  END LOOP;
  -- O corpo ANTIGO de registrar, com outro nome: a chamada que estava em voo quando a migration commitou.
  EXECUTE replace(pg_get_functiondef('public.registrar_contato_radar(text,text,text)'::regprocedure),
                  'FUNCTION public.registrar_contato_radar(', 'FUNCTION public.registrar_contato_radar_antigo(');
END $md5$;
GRANT EXECUTE ON FUNCTION public.registrar_contato_radar_antigo(text,text,text) TO authenticated;
SQL
echo "    · predecessores = prod (4 corpos pelo md5); corpo antigo guardado como registrar_contato_radar_antigo"
# A transação é do executor (db:aplicar); aqui, a do psql -1.
P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" > /dev/null
echo "    · 20261031111000 aplicada (TRAVA → PRE → DDL → CREATE → PÓS)"

MASTER='00000000-0000-0000-0000-00000000a001'
GER='00000000-0000-0000-0000-00000000a002'     # employee + gerencial (gestor)
FARM='00000000-0000-0000-0000-00000000a003'    # employee + farmer ("vendedor A")
FARM2='00000000-0000-0000-0000-00000000a004'   # employee + farmer ("vendedor B")
OPER='00000000-0000-0000-0000-00000000a006'    # employee + operacional: fora do Radar
SIS='00000000-0000-0000-0000-00000000ad0f'     # usuário-sistema do cron da RFB
LV='21212121000121'   # sem vínculo
LS='23232323000123'   # vínculo sem a linha do ledger
LA='24242424000124'   # cadastrado pela v2 (ledger 555)
LG='25252525000125'   # legado: virou_cliente sem confirmação (de antes da invariante)
L1='31313131000131'; L2='32323232000132'; L3='33333333000133'; L4='34343434000134'
L5='35353535000135'; L6='36363636000136'; L7='37373737000137'; L8='38383838000138'
L9='39393939000139'; L10='40404040000140'   # janelas atravessadas durante a espera pela trava
LI='41414141000141'   # INSERT direto em virou_cliente

echo "→ seed: papéis, leads, ledger, legado…"
P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
INSERT INTO auth.users (id) VALUES ('$MASTER'),('$GER'),('$FARM'),('$FARM2'),('$OPER'),('$SIS');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER','master'),('$GER','employee'),('$FARM','employee'),('$FARM2','employee'),('$OPER','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('$MASTER','master'),('$GER','gerencial'),('$FARM','farmer'),('$FARM2','farmer'),('$OPER','operacional');
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente)
SELECT c, 'LEAD ' || c, '4744005', '2026-10', false
  FROM unnest(ARRAY['$LV','$LS','$LA','$L1','$L2','$L3','$L4','$L5','$L6','$L7','$L8','$L9','$L10']) AS c;
UPDATE public.radar_empresas SET omie_codigo_cliente = '777' WHERE cnpj = '$LS';
INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$LA','555','incluir');
COMMIT;
-- O legado nasce sem a guarda (como uma linha de antes da migration).
SET session_replication_role = replica;
INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente, prospeccao_status)
  VALUES ('$LG', 'LEGADO', '4744005', '2026-10', false, 'virou_cliente');
SQL

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# q_como <papel> <uid ou ''> <sql> — como o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local claims ctx out
  if [ -n "$2" ]; then claims="{\"sub\":\"$2\",\"role\":\"$1\"}"; else claims="{\"role\":\"$1\"}"; fi
  ctx=(-c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
st_como() { q_como authenticated "$1" "SELECT prova.sqlstate(\$cmd\$$2\$cmd\$);"; }
# msg_como <uid> <sql> — a SQLSTATE e a CAMADA que recusou: 'porta' (a RPC) ou 'guarda' (o trigger).
msg_como() {
  q_como authenticated "$1" "DO \$m\$ BEGIN PERFORM $2; RAISE EXCEPTION 'SEM_ERRO'; EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'MSG[%|%]', SQLSTATE, CASE WHEN SQLERRM LIKE '%vem do cadastro pelo Radar%' OR SQLERRM LIKE '%só o gestor muda o status%' THEN 'porta' ELSE 'guarda' END; END \$m\$;" \
    | sed -n 's/.*MSG\[\([^]]*\)\].*/\1/p'
}
gate_como() {
  local out
  out="$(q_como authenticated "$1" "DO \$g\$ BEGIN PERFORM $2; EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'forbidden: %' THEN RAISE EXCEPTION 'GATE_NEGOU'; END IF;
    IF SQLSTATE NOT IN ('22023','P0002','P0001','RD005','RD006','RD007') THEN
      RAISE EXCEPTION 'TECNICO:%:%', SQLSTATE, left(SQLERRM, 80);
    END IF; END \$g\$; SELECT 'PASSOU';")"
  case "$out" in *GATE_NEGOU*) printf 'NEGADO' ;; PASSOU) printf 'PASSOU' ;; *TECNICO:*) printf 'TECNICO:%s' "${out##*TECNICO:}" ;; *) printf '%s' "$out" ;; esac
}
reg()    { q_como authenticated "$1" "SELECT public.registrar_contato_radar('$2','$3',${4:-NULL})->>'${5:-deduped}'"; }
desf()   { q_como authenticated "$1" "SELECT d->>'deleted' || '|' || (d->>'status_restaurado') FROM public.desfazer_contato_radar('$2') d"; }
estado() { P -tA -q -c "SELECT prospeccao_status || '|' || COALESCE(descarte_motivo, '∅') FROM public.radar_empresas WHERE cnpj = '$1'"; }
ultimo() { P -tA -q -c "SELECT id FROM public.radar_contatos WHERE cnpj = '$1' AND criado_por = '$2' ORDER BY created_at DESC, id DESC LIMIT 1"; }
dono()   { P -tA -q -c "SELECT COALESCE(prospeccao_contato_id::text, '∅') FROM public.radar_empresas WHERE cnpj = '$1'"; }
contatos() { P -tA -q -c "SELECT count(*) FROM public.radar_contatos WHERE cnpj = '$1'"; }
# esperar_bloqueio <n> <trecho da query> — até <n> sessões esperando LOCK com aquela chamada (máx. 4 s).
esperar_bloqueio() {
  local i n=0
  for i in $(seq 1 40); do
    n="$(P -tA -q -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%$2%' AND pid <> pg_backend_pid()")"
    [ "$n" -ge "$1" ] && break
    sleep 0.1; : "$i"
  done
  printf '%s' "$n"
}
em_fundo() {  # <arquivo de saída> <uid ou '' = postgres> <-c sql…> — uma sessão em background
  local out="$1" uid="$2"; shift 2
  if [ -n "$uid" ]; then
    P -v ON_ERROR_STOP=1 -tA -q -c "SET ROLE authenticated" \
      -c "SET request.jwt.claims = '{\"sub\":\"$uid\",\"role\":\"authenticated\"}'" "$@" > "$out" 2>&1 &
  else
    P -v ON_ERROR_STOP=1 -tA -q "$@" > "$out" 2>&1 &
  fi
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "── A. 'virou_cliente' só com o cliente confirmado ──"
  chk A0a "farmer: registrar passa no gate"        "$(gate_como "$FARM" "public.registrar_contato_radar('$L7','contatado_sem_resposta',NULL)")" "PASSOU"
  chk A0b "operacional: registrar negado"          "$(gate_como "$OPER" "public.registrar_contato_radar('$L7','em_conversa',NULL)")" "NEGADO"
  chk A1 "sem vínculo: recusa RD005 pela porta"    "$(msg_como "$FARM" "public.registrar_contato_radar('$LV','virou_cliente',NULL)")" "RD005|porta"
  chk A2 "…e nada muda (status, contatos)"         "$(estado "$LV")/$(contatos "$LV")" "a_contatar|∅/0"
  chk A3 "vínculo sem a linha do ledger: RD005"    "$(st_como "$FARM" "SELECT public.registrar_contato_radar('$LS','virou_cliente',NULL)")" "RD005"
  chk A4 "cadastro pela v2 (ledger 555) converte"  "$(q_como authenticated "$FARM" "SELECT public.radar_registrar_cadastro_omie_v2('$LA','555',false)->>'ok'")|$(estado "$LA")" "true|virou_cliente|∅"
  local v1id; v1id="$(ultimo "$LA" "$FARM")"
  chk A5 "re-marcar cliente confirmado é no-op"    "$(reg "$FARM" "$LA" virou_cliente NULL id)|$(contatos "$LA")" "$v1id|1"
  chk A6 "farmer tira cliente confirmado: RD007 na porta" "$(msg_como "$FARM" "public.registrar_contato_radar('$LA','descartado','x')")|$(estado "$LA")" "RD007|porta|virou_cliente|∅"
  # O corpo ANTIGO em voo (Codex, código): sem RD007 nem no-op próprios — quem recusa/preserva é o trigger.
  chk A15 "corpo antigo tira cliente confirmado: RD007 na guarda" "$(msg_como "$FARM2" "public.registrar_contato_radar_antigo('$LA','descartado','x')")|$(estado "$LA")" "RD007|guarda|virou_cliente|∅"
  local carimbo; carimbo="$(P -tA -q -c "SELECT prospeccao_atualizado_em FROM public.radar_empresas WHERE cnpj = '$LA'")"
  chk A16 "corpo antigo re-marca: a data da conversão não muda" \
    "$(q_como authenticated "$FARM2" "SELECT public.registrar_contato_radar_antigo('$LA','virou_cliente',NULL)->>'deduped'")|$(P -tA -q -c "SELECT prospeccao_atualizado_em = '$carimbo' FROM public.radar_empresas WHERE cnpj = '$LA'")" "false|t"
  chk A7 "gestor tira cliente confirmado"          "$(reg "$GER" "$LA" em_conversa)|$(estado "$LA")" "false|em_conversa|∅"
  chk A8 "farmer re-converte o confirmado"         "$(reg "$FARM" "$LA" virou_cliente)|$(estado "$LA")" "false|virou_cliente|∅"
  chk A9 "corpo ANTIGO em voo: o trigger recusa"   "$(st_como "$FARM" "SELECT public.registrar_contato_radar_antigo('$LV','virou_cliente',NULL)")|$(estado "$LV")" "RD005|a_contatar|∅"
  chk A10 "INSERT direto em virou_cliente: RD005"  "$(P -tA -q -c "SELECT prova.sqlstate(\$s\$INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente, prospeccao_status) VALUES ('$LI','X','4744005','2026-10',false,'virou_cliente')\$s\$)")" "RD005"
  chk A11 "legado sem confirmação: re-marcar recusa" "$(st_como "$FARM" "SELECT public.registrar_contato_radar('$LG','virou_cliente',NULL)")" "RD005"
  chk A12 "legado sem confirmação: farmer pode tirar" "$(reg "$FARM" "$LG" em_conversa)|$(estado "$LG")" "false|em_conversa|∅"
  chk A13 "ação NULL recusada"                     "$(st_como "$FARM" "SELECT public.registrar_contato_radar('$L7',NULL,NULL)")" "P0001"
  chk A14 "clique duplo (ainda dono) deduplica"    "$(reg "$FARM" "$L8" em_conversa)/$(reg "$FARM" "$L8" em_conversa)/$(contatos "$L8")" "false/true/1"

  echo "── B. desfazer restaura só o DONO do status ──"
  reg "$FARM" "$L1" em_conversa >/dev/null; local x; x="$(ultimo "$L1" "$FARM")"
  reg "$FARM2" "$L1" em_conversa >/dev/null; local y; y="$(ultimo "$L1" "$FARM2")"
  chk B1 "A e B mesma ação, A desfaz: status fica" "$(desf "$FARM" "$x")|$(estado "$L1")" "true|false|em_conversa|∅"
  chk B2 "…o dono segue sendo o contato de B"      "$(dono "$L1")" "$y"
  chk B3 "B desfaz: volta ao estado ANTES de A"     "$(desf "$FARM2" "$y")|$(estado "$L1")|$(dono "$L1")" "true|true|a_contatar|∅|∅"

  # Traço do Codex: A descarta (X), B conversa (R), o cron da RFB descarta (C, carimbo do INÍCIO da transação dele),
  # B desfaz R, A conversa (Y), A desfaz Y e X.
  reg "$FARM" "$L2" descartado "'motivo A'" >/dev/null; local tx; tx="$(ultimo "$L2" "$FARM")"
  reg "$FARM2" "$L2" em_conversa >/dev/null; local tr; tr="$(ultimo "$L2" "$FARM2")"
  P -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;  -- como o cron: os dois comandos na MESMA transação (p_agora único)
INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior, created_at)
  SELECT cnpj, 'descartado', 'RFB', '$SIS', prospeccao_status, now() - interval '1 minute'
    FROM public.radar_empresas WHERE cnpj = '$L2' AND prospeccao_status NOT IN ('descartado','virou_cliente');
UPDATE public.radar_empresas SET prospeccao_status = 'descartado', descarte_motivo = 'RFB',
       prospeccao_atualizado_em = now() - interval '1 minute', updated_at = now()
 WHERE cnpj = '$L2' AND prospeccao_status NOT IN ('descartado','virou_cliente');
COMMIT;
SQL
  chk B4 "B desfaz depois do cron: o descarte da RFB fica" "$(desf "$FARM2" "$tr")|$(estado "$L2")" "true|false|descartado|RFB"
  reg "$FARM" "$L2" em_conversa >/dev/null; local ty; ty="$(ultimo "$L2" "$FARM")"
  chk B5 "A desfaz Y: volta o descarte da RFB, com o carimbo dele" \
    "$(desf "$FARM" "$ty")|$(estado "$L2")|$(P -tA -q -c "SELECT e.prospeccao_atualizado_em = c.created_at FROM public.radar_empresas e JOIN public.radar_contatos c ON c.cnpj = e.cnpj AND c.criado_por = '$SIS' WHERE e.cnpj = '$L2'")" \
    "true|true|descartado|RFB|t"
  chk B6 "A desfaz X: não é dono, o descarte da RFB fica" "$(desf "$FARM" "$tx")|$(estado "$L2")" "true|false|descartado|RFB"

  reg "$FARM" "$L4" em_conversa >/dev/null; local cx; cx="$(ultimo "$L4" "$FARM")"
  reg "$FARM" "$L4" contatado_sem_resposta >/dev/null; local cy; cy="$(ultimo "$L4" "$FARM")"
  chk B7 "encadeado: desfaz Y e depois X"          "$(desf "$FARM" "$cy")|$(estado "$L4")/$(desf "$FARM" "$cx")|$(estado "$L4")" \
    "true|true|em_conversa|∅/true|true|a_contatar|∅"
  reg "$FARM" "$L7" descartado "'motivo 1'" >/dev/null
  reg "$FARM" "$L7" em_conversa >/dev/null; local m; m="$(ultimo "$L7" "$FARM")"
  chk B8 "desfazer devolve o motivo do descarte"   "$(desf "$FARM" "$m")|$(estado "$L7")" "true|true|descartado|motivo 1"
  local cv; cv="$(P -tA -q -c "SELECT id FROM public.radar_contatos WHERE cnpj = '$LA' AND criado_por = '$FARM' AND acao = 'virou_cliente' ORDER BY created_at DESC LIMIT 1")"
  chk B9 "a conversão não se desfaz (RD006)"       "$(st_como "$FARM" "SELECT public.desfazer_contato_radar('$cv')")|$(P -tA -q -c "SELECT count(*) FROM public.radar_contatos WHERE id = '$cv'")" "RD006|1"
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por, status_anterior, created_at) VALUES ('$L5','em_conversa','$FARM','a_contatar', now() - interval '6 minutes')" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = (SELECT id FROM public.radar_contatos WHERE cnpj = '$L5'), prospeccao_atualizado_em = now() - interval '6 minutes' WHERE cnpj = '$L5'"
  local velho; velho="$(ultimo "$L5" "$FARM")"
  chk B10 "fora da janela de 5 min: não desfaz"    "$(desf "$FARM" "$velho")|$(estado "$L5")|$(contatos "$L5")" "false|false|em_conversa|∅|1"
  chk B11 "operacional: desfazer negado"           "$(gate_como "$OPER" "public.desfazer_contato_radar('$velho')")" "NEGADO"
  reg "$FARM" "$L6" em_conversa >/dev/null; local alheio; alheio="$(ultimo "$L6" "$FARM")"
  chk B12 "contato de outro usuário: não desfaz"   "$(desf "$FARM2" "$alheio")|$(estado "$L6")" "false|false|em_conversa|∅"

  echo "── C. corridas (bloqueio observado) ──"
  reg "$FARM" "$L3" em_conversa >/dev/null; local c3; c3="$(ultimo "$L3" "$FARM")"
  em_fundo "$TMPD/c-reg.out" "$FARM2" -c "BEGIN" -c "SELECT public.registrar_contato_radar('$L3','contatado_sem_resposta',NULL)->>'deduped'" -c "SELECT pg_sleep(1.5)" -c "COMMIT"
  local pid_reg=$!
  sleep 0.4
  em_fundo "$TMPD/c-desf.out" "$FARM" -c "SELECT d->>'deleted' || '|' || (d->>'status_restaurado') FROM public.desfazer_contato_radar('$c3') d"
  local pid_desf=$!
  chk C1 "o desfazer de A espera a trava de B"     "$(esperar_bloqueio 1 desfazer_contato_radar)" "1"
  wait "$pid_reg" || true; wait "$pid_desf" || true
  chk C2 "A desfaz depois de B: status de B fica"  "$(tr -d '\n ' < "$TMPD/c-desf.out")|$(estado "$L3")" "true|false|contatado_sem_resposta|∅"
  chk C3 "…e o contato de B herda o retrato de A"  "$(P -tA -q -c "SELECT status_anterior || '|' || COALESCE(contato_anterior_id::text, '∅') FROM public.radar_contatos WHERE cnpj = '$L3' AND criado_por = '$FARM2'")" "a_contatar|∅"

  local c6; c6="$(ultimo "$L6" "$FARM")"
  em_fundo "$TMPD/c-trava.out" "" -c "BEGIN" -c "SELECT 1 FROM public.radar_empresas WHERE cnpj = '$L6' FOR UPDATE" -c "SELECT pg_sleep(1.5)" -c "COMMIT"
  local pid_trava=$!
  sleep 0.3
  em_fundo "$TMPD/c-d1.out" "$FARM" -c "SELECT public.desfazer_contato_radar('$c6')->>'deleted'"
  local pid_d1=$!
  em_fundo "$TMPD/c-d2.out" "$FARM" -c "SELECT public.desfazer_contato_radar('$c6')->>'deleted'"
  local pid_d2=$!
  chk C4 "os dois desfazer esperam a trava"        "$(esperar_bloqueio 2 desfazer_contato_radar)" "2"
  wait "$pid_trava" || true; wait "$pid_d1" || true; wait "$pid_d2" || true
  chk C5 "só UM dos dois apaga"                     "$(cat "$TMPD/c-d1.out" "$TMPD/c-d2.out" | tr -d ' ' | sort | tr '\n' ',')" "false,true,"
  chk C6 "…e o status volta uma vez só"             "$(estado "$L6")|$(contatos "$L6")" "a_contatar|∅|0"

  echo "── D. janelas medidas DEPOIS da espera pela trava ──"
  # Contato com 4m59s; a linha fica presa 2,5 s; o desfazer só lê o relógio depois → já passou de 5 min.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por, status_anterior, created_at) VALUES ('$L9','em_conversa','$FARM','a_contatar', clock_timestamp() - interval '299 seconds')" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = (SELECT id FROM public.radar_contatos WHERE cnpj = '$L9') WHERE cnpj = '$L9'"
  local j9; j9="$(ultimo "$L9" "$FARM")"
  em_fundo "$TMPD/d-trava9.out" "" -c "BEGIN" -c "SELECT 1 FROM public.radar_empresas WHERE cnpj = '$L9' FOR UPDATE" -c "SELECT pg_sleep(2.5)" -c "COMMIT"
  local pt9=$!
  sleep 0.3
  em_fundo "$TMPD/d-desf9.out" "$FARM" -c "SELECT d->>'deleted' || '|' || (d->>'status_restaurado') FROM public.desfazer_contato_radar('$j9') d"
  local pd9=$!
  chk D1 "o desfazer espera a trava"               "$(esperar_bloqueio 1 desfazer_contato_radar)" "1"
  wait "$pt9" || true; wait "$pd9" || true
  chk D2 "a janela de 5 min venceu na espera: não desfaz" "$(tr -d '\n ' < "$TMPD/d-desf9.out")|$(estado "$L9")" "false|false|em_conversa|∅"
  # Dono com 1m59s; mesma espera; o dedupe mede a janela depois dela → registro novo.
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por, status_anterior, created_at) VALUES ('$L10','em_conversa','$FARM','a_contatar', clock_timestamp() - interval '119 seconds')" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = (SELECT id FROM public.radar_contatos WHERE cnpj = '$L10') WHERE cnpj = '$L10'"
  em_fundo "$TMPD/d-trava10.out" "" -c "BEGIN" -c "SELECT 1 FROM public.radar_empresas WHERE cnpj = '$L10' FOR UPDATE" -c "SELECT pg_sleep(2.5)" -c "COMMIT"
  local pt10=$!
  sleep 0.3
  em_fundo "$TMPD/d-reg10.out" "$FARM" -c "SELECT public.registrar_contato_radar('$L10','em_conversa',NULL)->>'deduped'"
  local pr10=$!
  chk D3 "o registrar espera a trava"              "$(esperar_bloqueio 1 registrar_contato_radar)" "1"
  wait "$pt10" || true; wait "$pr10" || true
  chk D4 "a janela de 2 min venceu na espera: registro novo" "$(tr -d '\n ' < "$TMPD/d-reg10.out")|$(contatos "$L10")" "false|2"

  echo "── G. catálogo ──"
  chk G1 "re-aplicar a migration é no-op"           "$(P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk G2 "anon sem EXECUTE nas 2 RPCs"              "$(P -tA -q -c "SELECT has_function_privilege('anon','public.registrar_contato_radar(text,text,text)','EXECUTE') OR has_function_privilege('anon','public.desfazer_contato_radar(uuid)','EXECUTE')")" "f"
  chk G3 "a guarda não é chamável pelo JWT"         "$(P -tA -q -c "SELECT has_function_privilege('authenticated','private.radar_empresas_status_guard()','EXECUTE')")" "f"
}

# sabotagem <nome> — muda UMA camada no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
sabotagem() {
  local R='public.registrar_contato_radar(text,text,text)' D='public.desfazer_contato_radar(uuid)' G='private.radar_empresas_status_guard()'
  case "$1" in
    porta_sem_rd005)    cv_sabotar "$R" "IF p_acao = 'virou_cliente' AND NOT v_confirmado THEN" "IF false THEN" ;;
    classe_sem_rd005)   cv_sabotar "$G" "AND (TG_OP = 'INSERT' OR OLD.prospeccao_status IS DISTINCT FROM 'virou_cliente')" "AND false" ;;
    autoria_mantida)    cv_sabotar "$G" "NEW.prospeccao_contato_id := NULL;" "NULL;" ;;
    regra_antiga)       cv_sabotar "$D" "IF v_dono IS NOT DISTINCT FROM p_id THEN" "IF (SELECT e.prospeccao_status FROM public.radar_empresas e WHERE e.cnpj = v_cnpj) = v_acao THEN" ;;
    sem_tirar_da_cadeia) cv_sabotar "$D" "WHERE contato_anterior_id = p_id;" "WHERE false;" ;;
    cadeia_sem_dono)    cv_sabotar "$D" "prospeccao_contato_id = (SELECT o.id FROM public.radar_contatos o WHERE o.id = v_dono_anterior AND o.cnpj = v_cnpj)," "prospeccao_contato_id = NULL," ;;
    sem_motivo)         cv_sabotar "$D" "descarte_motivo = v_motivo_anterior," "descarte_motivo = descarte_motivo," ;;
    sem_releitura)      cv_sabotar "$D" "IF NOT FOUND THEN  -- apagado por um desfazer concorrente, ou fora da janela" "IF false THEN" ;;
    janela_larga)       cv_sabotar "$D" "created_at > v_agora - interval '5 minutes'" "created_at > v_agora - interval '60 minutes'" ;;
    desfaz_conversao)   cv_sabotar "$D" "IF v_acao = 'virou_cliente' THEN" "IF false THEN" ;;
    vendedor_tira)      cv_sabotar "$R" "ELSIF NOT COALESCE(private.cap_carteira_ler(v_uid), false) THEN" "ELSIF false THEN" ;;
    remarca_conta)      cv_sabotar "$R" "WHERE cnpj = p_cnpj AND acao = 'virou_cliente' ORDER BY created_at DESC, id DESC LIMIT 1;" "WHERE false;" ;;
    dedupe_sem_dono)    cv_sabotar "$R" "WHERE id = v_dono_atual AND criado_por = v_uid" "WHERE criado_por = v_uid" ;;
    desfazer_sem_gate)  cv_sabotar "$D" "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN" "IF false THEN" ;;
    guarda_tira)        cv_sabotar "$G" "ELSIF auth.uid() IS NOT NULL" "ELSIF false AND auth.uid() IS NOT NULL" ;;
    guarda_recarimbo)   cv_sabotar "$G" "NEW.prospeccao_atualizado_em := OLD.prospeccao_atualizado_em;" "NULL;" ;;
    relogio_desfazer)   cv_sabotar "$D" "v_agora := clock_timestamp();" "v_agora := now();" ;;
    relogio_dedupe)     cv_sabotar "$R" "v_agora := clock_timestamp();" "v_agora := now();" ;;
    registrar_sem_gate) cv_sabotar "$R" "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN" "IF false THEN" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelho>[:<ids que têm de seguir verdes>]
SABOTAGENS="porta_sem_rd005:A1,A11:A3,A9
classe_sem_rd005:A9,A10:A1,A4
autoria_mantida:B4:B1
regra_antiga:B1:B7
sem_tirar_da_cadeia:B3,C3:B1
cadeia_sem_dono:B7:B8
sem_motivo:B5,B8:B1
sem_releitura:C5,B10:C2
janela_larga:B10:B11
desfaz_conversao:B9:B8
vendedor_tira:A6:A7,A15
guarda_tira:A15:A6
guarda_recarimbo:A16:A5
relogio_desfazer:D2:D1
relogio_dedupe:D4:D3
remarca_conta:A5:A6
dedupe_sem_dono:A8:A14
desfazer_sem_gate:B11:B12
registrar_sem_gate:A0b:A0a"

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

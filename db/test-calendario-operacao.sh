#!/usr/bin/env bash
# Prova PG17 — calendário de operação (Etapa 1, Task 1): esquema, RLS, log por trigger e as 3 funções de data
# (calendario_proximo_dia_recebimento · calendario_somar_dias_uteis_fornecedor · calendario_dias_sem_nf).
# Task 4b: calendario_itens_antecipar (migration 20261119120000), bloco AANT* com hoje fixado em 2026-12-01.
# Relógio do sync: 20261119140000 (trânsito do app = em_transito do motor 20261118120000), bloco ARELOGIO*.
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
MIG_ANT="$REPO_ROOT/supabase/migrations/20261119120000_calendario_antecipar_recesso.sql"   # Task 4b
MIG_REL="$REPO_ROOT/supabase/migrations/20261119140000_calendario_antecipar_relogio_do_sync.sql"   # relógio do sync

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca.
  SABOTAGENS="sem_lower_btrim:AFORN2b sem_corte_d3:ASEMNF_CORTE sem_revoke_anon:POST!anon_executa
    sem_revoke_anon_sem_post:AANON1 sem_revoke_public:POST!PUBLIC_executa
    sem_revoke_public_sem_post:APUBLIC1 teto_60_off:AREC7 fechado_peso_off:ANEG2 escrita_employee:ARLS3
    leitura_aberta:ARLS1 gate_customer_off:AGATE1 log_trigger_off:ALOG1 recebimento_sem_empresa:AREC9
    nf_sem_empresa:ASEMNF1 colacor_nao_vazio:ASEMNF_COLACOR fornecedor_sem_empresa:AFORN5
    feriado_nacional_off:AFERIADO_NAC feriado_municipal_fecha:AFERIADO_MUNI feriados_rls_so_master:AFERIADO_EMP
    carga_sem_linha_empresa:POST!carga_calendario carga_sem_linha_fornecedor:POST!carga_calendario
    carga_sem_nacional_2030:POST!carga_calendario
    ant_sem_pendente:AANT1 ant_pendente_null_vira_zero:AANT1 ant_lt_null_vira_zero:AANT1 ant_lt_floor:AANT1
    ant_demanda_zero_entra:AANT1 ant_chegada_null_fabricada:AANT_COLACOR ant_fornecedor_fechado_off:AANT1
    ant_janela_off:AANT_JANELA ant_sem_lower_btrim:AANT1 ant_sem_empresa:AANT1 ant_nao_estrito:AANT1
    ant_ativo_off:AANT1 ant_gate_off:AANT_GATE ant_revoke_anon:POST!anon_executa_a_RPC_de_antecipar
    ant_revoke_anon_sem_post:AANT_ANON ant_revoke_public_sem_post:AANT_PUBLIC
    ant_sem_transito_app:AANT1 ant_transito_janela_off:AANT1 ant_transito_erro_terminal_off:AANT1
    ant_transito_null_blind:AANT1 ant_transito_sem_portal:AANT1 ant_transito_sem_empresa:AANT_COLACOR
    ant_grupo_off:AANT1 ant_compras_gate_off:AANT_COMPRAS ant_svc_revoke:POST!EXECUTE_ausente_para
    res_conta_cobre:ARES1 prev_portal_off:APREV1 prev_lt_default:APREV_LT_NULL prev_receb_null:APREV_NULL
    svc_revoke_100000:POST!EXECUTE_ausente_para
    rel_sem_conserto:ARELOGIOD1 rel_corte_velho:POST!nao_corta_pelo_relogio_do_retrato
    rel_corte_velho_sem_post:ARELOGIOD1 rel_sem_folga_sem_post:ARELOGIOFOLGA rel_utc_sem_post:ARELOGIOFOLGA
    rel_sem_least_sem_post:ARELOGIOLEAST rel_null_alarga_sem_post:ARELOGIONULL rel_pre_deriva:POST!PRE_FALHOU
    rel_acl_anon:POST!anon_executa_calendario_antecipar_avaliacao rel_acl_estranho:POST!EXECUTE_concedido_fora"
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
MIG_ANT_USADA="$(dirname "$DATA")/mig-ant.sql"
MIG_REL_USADA="$(dirname "$DATA")/mig-rel.sql"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
cp "$MIG_ANT" "$MIG_ANT_USADA"
cp "$MIG_REL" "$MIG_REL_USADA"
sabotar() { sabotar_em "$MIG_USADA" "$@"; }
sabotar_ant() { sabotar_em "$MIG_ANT_USADA" "$@"; }   # sabota a migration da Task 4b
sabotar_rel() { sabotar_em "$MIG_REL_USADA" "$@"; }   # sabota a migration do relógio do sync
# Desliga PRE e PÓS do relógio (viram NOTICE): a sabotagem do CORPO chega viva aos asserts — o "_sem_post".
rel_sem_guardas() {
  sabotar_rel "RAISE EXCEPTION 'PRE FALHOU: calendario_antecipar_avaliacao" "RAISE NOTICE 'SABOTADO: calendario_antecipar_avaliacao"
  sabotar_rel "RAISE EXCEPTION 'POS FALHOU: antecipar nao corta" "RAISE NOTICE 'SABOTADO: antecipar nao corta"
  sabotar_rel "RAISE EXCEPTION 'POS FALHOU: corpo vivo" "RAISE NOTICE 'SABOTADO: corpo vivo"
}
# Só o predicado do CORPO (o prefixo não existe na PÓS).
REL_PRED="'concluido_recebido') AND pcs2.data_ciclo >= (LEAST(p_hoje, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date) - 7)"
REL_PRED_VELHO="'concluido_recebido') AND pcs2.data_ciclo >= (p_hoje - INTERVAL '7 days')"
APLICA_REL=1
sabotar_em() { # $1 = arquivo, $2 = de, $3 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$1" "$2" "$3" <<'PY'
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
CARGA_SABOTAR=""
FERIADOS_ROLE_EXTRA="employee"   # 4º termo da policy de prod de calendario_feriados
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
                         sabotar "$POST_PUBLIC" "IF false THEN"
                         sabotar "$POST_ANON" "IF false THEN" ;;   # anon herda de PUBLIC: os dois checks acusariam
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
  feriado_nacional_off)  sabotar "AND NOT EXISTS (SELECT 1 FROM public.calendario_feriados fe
                        WHERE fe.data = v_d AND fe.tipo = 'nacional')
" "" ;;
  feriado_municipal_fecha) sabotar "WHERE fe.data = v_d AND fe.tipo = 'nacional')" "WHERE fe.data = v_d)" ;;
  # Sabota a FIXTURE (a policy de prod de calendario_feriados), não a migration: prova que o AFERIADO_EMP pega uma
  # RLS que esconda os feriados do employee — a função INVOKER os ignoraria em silêncio.
  feriados_rls_so_master) FERIADOS_ROLE_EXTRA="master" ;;
  # Sabotam a CARGA (cópia do arquivo gerado): uma linha some do VALUES; a postcondição `POST carga calendario` TEM de abortar.
  carga_sem_linha_empresa) CARGA_SABOTAR="  ('2027-02-09', 'OBEN', 'meia_equipe'" ;;
  carga_sem_linha_fornecedor) CARGA_SABOTAR="  ('2026-12-22', 'OBEN', 'MASTERCOL" ;;
  carga_sem_nacional_2030) CARGA_SABOTAR="  ('2030-11-02', 'Finados'" ;;
  # Task 4b (calendario_itens_antecipar). Camadas redundantes (filtro IS NOT NULL + aritmética NULL) só ficam
  # vermelhas sabotadas JUNTAS — sabotar uma só deixaria verde por construção (NULL < x é NULL).
  ant_sem_pendente)      sabotar_ant "(sea.estoque_fisico + sea.estoque_pendente_entrada + " "(sea.estoque_fisico + " ;;
  ant_pendente_null_vira_zero)
                         sabotar_ant "(sea.estoque_fisico + sea.estoque_pendente_entrada + " "(sea.estoque_fisico + COALESCE(sea.estoque_pendente_entrada, 0) + "
                         sabotar_ant "WHEN b.fisico IS NULL OR b.pendente IS NULL THEN" "WHEN b.fisico IS NULL THEN" ;;
  ant_lt_null_vira_zero) sabotar_ant "ceil(sp.lt_medio_dias_uteis)::int" "COALESCE(ceil(sp.lt_medio_dias_uteis)::int, 0)"
                         sabotar_ant "CASE WHEN sp.lt_medio_dias_uteis IS NOT NULL THEN" "CASE WHEN true THEN"
                         sabotar_ant "WHEN b.lt IS NULL THEN 'sem_lt'" "WHEN false THEN 'sem_lt'" ;;
  ant_lt_floor)          sabotar_ant "ceil(sp.lt_medio_dias_uteis)::int" "floor(sp.lt_medio_dias_uteis)::int" ;;
  ant_demanda_zero_entra) sabotar_ant "WHEN b.demanda IS NULL OR b.demanda <= 0 THEN" "WHEN b.demanda IS NULL OR b.demanda < 0 THEN"
                         sabotar_ant "CASE WHEN sp.demanda_media_diaria > 0 THEN" "CASE WHEN sp.demanda_media_diaria >= 0 THEN" ;;
  ant_chegada_null_fabricada)
                         sabotar_ant "(b.chegada - p_hoje)" "(COALESCE(b.chegada, p_fim_recesso + 60) - p_hoje)"
                         sabotar_ant "WHEN b.chegada IS NULL THEN 'sem_chegada'" "WHEN false THEN 'sem_chegada'" ;;
  ant_fornecedor_fechado_off) sabotar_ant "AND EXISTS (SELECT 1 FROM public.calendario_operacao_fornecedor f" \
                                         "AND true OR EXISTS (SELECT 1 FROM public.calendario_operacao_fornecedor f" ;;
  ant_janela_off)        sabotar_ant "AND f.data BETWEEN p_hoje AND p_fim_recesso" "AND true" ;;
  ant_sem_lower_btrim)   sabotar_ant "lower(btrim(f.fornecedor_nome)) = lower(btrim(sp.fornecedor_nome))" "f.fornecedor_nome = sp.fornecedor_nome" ;;
  ant_sem_empresa)       sabotar_ant "WHERE sp.empresa = p_empresa" "WHERE true" ;;
  ant_nao_estrito)       sabotar_ant "WHEN b.cobertura < (b.chegada - p_hoje) THEN 'listado'" "WHEN b.cobertura <= (b.chegada - p_hoje) THEN 'listado'" ;;
  ant_ativo_off)         sabotar_ant "AND sp.ativo IS TRUE" "AND true" ;;
  ant_gate_off)          sabotar_ant "IF v_uid IS NOT NULL AND NOT (" "IF false AND NOT (" ;;
  ant_revoke_anon)       sabotar_ant "FROM PUBLIC, anon;" "FROM PUBLIC;" ;;
  ant_revoke_anon_sem_post)
                         sabotar_ant "FROM PUBLIC, anon;" "FROM PUBLIC;"
                         sabotar_ant "IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN" "IF false THEN" ;;
  ant_revoke_public_sem_post)
                         sabotar_ant "FROM PUBLIC, anon;" "FROM anon;"
                         sabotar_ant "IF has_function_privilege('public', v_fn, 'EXECUTE') THEN" "IF false THEN"
                         sabotar_ant "IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN" "IF false THEN" ;;
  # Onda final (P1a): trânsito do app = em_transito do motor, uma regra por vez.
  ant_sem_transito_app)  sabotar_ant " + COALESCE(et.qtde, 0))" ")" ;;
  ant_transito_janela_off) sabotar_ant " AND pcs2.data_ciclo >= (p_hoje - INTERVAL '7 days')" "" ;;
  ant_transito_erro_terminal_off) sabotar_ant "AND pcs2.status_envio_portal IS NOT DISTINCT FROM 'erro_nao_retentavel'" "AND false" ;;
  ant_transito_null_blind) sabotar_ant "IS NOT DISTINCT FROM 'erro_nao_retentavel'" "= 'erro_nao_retentavel'" ;;
  ant_transito_sem_portal) sabotar_ant "OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal')" "OR (false" ;;
  ant_transito_sem_empresa) sabotar_ant "WHERE pcs2.empresa = p_empresa" "WHERE true" ;;
  ant_grupo_off)         sabotar_ant "WHEN b.tem_grupo THEN 'grupo_equivalencia'" "WHEN false THEN 'grupo_equivalencia'" ;;
  ant_compras_gate_off)  sabotar_ant "IF v_uid IS NOT NULL AND NOT private.cap_compras_ler(v_uid) THEN" "IF false THEN" ;;
  ant_svc_revoke)        sabotar_ant "REVOKE ALL ON FUNCTION public.calendario_previsao_pedido(text, text, date, int, date) FROM PUBLIC, anon;" \
                                     "REVOKE ALL ON FUNCTION public.calendario_previsao_pedido(text, text, date, int, date) FROM PUBLIC, anon, service_role;"
                         sabotar_ant "calendario_previsao_pedido(text, text, date, int, date) TO authenticated, service_role;" \
                                     "calendario_previsao_pedido(text, text, date, int, date) TO authenticated;" ;;
  # P2a: o resumo conta sem_dado = tudo que não é listado NEM cobre.
  res_conta_cobre)       sabotar_ant "FILTER (WHERE a.motivo NOT IN ('listado', 'cobre'))" "FILTER (WHERE a.motivo <> 'listado')" ;;
  # P1c: a prévia segue a edge (portal primeiro; LT NULL não vira 7; nunca promessa sem recebimento).
  prev_portal_off)       sabotar_ant "IF p_portal_data IS NOT NULL THEN" "IF false THEN" ;;
  prev_lt_default)       sabotar_ant "ELSIF p_lt IS NOT NULL AND p_hoje IS NOT NULL THEN" "ELSIF p_hoje IS NOT NULL THEN"
                         sabotar_ant "p_fornecedor, p_hoje, p_lt);" "p_fornecedor, p_hoje, COALESCE(p_lt, 7));" ;;
  prev_receb_null)       sabotar_ant "IF v_promessa IS NULL OR v_receb IS NULL THEN" "IF v_promessa IS NULL THEN" ;;
  # Minor da T1: a postcondição da 100000 confere o EXECUTE do service_role (a edge cairia no legado para sempre).
  svc_revoke_100000)     sabotar "$REV_ANON" "REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM PUBLIC, anon, service_role;"
                         sabotar "GRANT EXECUTE ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) TO authenticated, service_role;" \
                                 "GRANT EXECUTE ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) TO authenticated;" ;;
  # Relógio do sync (20261119140000): o corte do trânsito do app = o do motor 20261118120000, uma regra por vez.
  rel_sem_conserto)      APLICA_REL=0 ;;   # a versão ANTERIOR (só a 20261119120000): o caso D-1/D-8 fica vermelho
  rel_corte_velho)       sabotar_rel "$REL_PRED" "$REL_PRED_VELHO" ;;
  rel_corte_velho_sem_post) sabotar_rel "$REL_PRED" "$REL_PRED_VELHO"; rel_sem_guardas ;;
  rel_sem_folga_sem_post) sabotar_rel "$REL_PRED" "'concluido_recebido') AND pcs2.data_ciclo >= (LEAST(p_hoje, ((sea_c.ultima_sincronizacao) AT TIME ZONE 'America/Sao_Paulo')::date) - 7)"
                         rel_sem_guardas ;;
  rel_utc_sem_post)      sabotar_rel "$REL_PRED" "'concluido_recebido') AND pcs2.data_ciclo >= (LEAST(p_hoje, ((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'UTC')::date) - 7)"
                         rel_sem_guardas ;;
  rel_sem_least_sem_post) sabotar_rel "$REL_PRED" "'concluido_recebido') AND pcs2.data_ciclo >= (COALESCE(((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date, p_hoje) - 7)"
                         rel_sem_guardas ;;
  rel_null_alarga_sem_post) sabotar_rel "$REL_PRED" "'concluido_recebido') AND pcs2.data_ciclo >= (LEAST(p_hoje, COALESCE(((sea_c.ultima_sincronizacao - INTERVAL '1 hour') AT TIME ZONE 'America/Sao_Paulo')::date, p_hoje - 30)) - 7)"
                         rel_sem_guardas ;;
  rel_pre_deriva)        sabotar_rel "v_vivo NOT IN ('aed4c41f86f6c2c1795a6619f7bd480c'" "v_vivo NOT IN ('00000000000000000000000000000000'" ;;
  rel_acl_anon)          sabotar_rel "-- PÓS: o corte novo no CÓDIGO" "GRANT EXECUTE ON FUNCTION public.calendario_antecipar_avaliacao(text, date, date) TO anon;
-- PÓS: o corte novo no CÓDIGO" ;;
  rel_acl_estranho)      sabotar_rel "-- PÓS: o corte novo no CÓDIGO" "GRANT EXECUTE ON FUNCTION public.calendario_antecipar_avaliacao(text, date, date) TO sem_grant;
-- PÓS: o corte novo no CÓDIGO" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"
# HOJE_TESTE=AAAA-MM-DD simula o "hoje" de SP (na cópia da migration e no teste) — prova a janela móvel do
# calendario_dias_sem_nf contra as datas fixas da carga (revisão I2). Sem a variável, usa o relógio real.
if [ -n "${HOJE_TESTE:-}" ]; then
  sabotar "(now() AT TIME ZONE 'America/Sao_Paulo')::date - 3" "'$HOJE_TESTE'::date - 3"
  echo "HOJE SIMULADO: $HOJE_TESTE"
fi

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
-- pedido_compra_sugerido/_item: colunas que o em_transito do motor lê, tipos de PROD (psql-ro, 2026-11-18: id/pedido_id
-- bigint, sku text). RLS de PROD: pedido staff; ITEM só com private.cap_compras_ler (= master) — o trânsito some
-- para o employee, e é isso que o gate [CALENDARIO-ANTECIPAR-SEM-COMPRAS] cobre.
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text NOT NULL, fornecedor_nome text,
  status text NOT NULL DEFAULT 'pendente_aprovacao', data_ciclo date NOT NULL DEFAULT '2026-12-01',
  status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, portal_data_entrega date);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id),
  sku_codigo_omie text NOT NULL, qtde_final numeric);
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;
CREATE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$\$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false) \$\$;
ALTER TABLE public.pedido_compra_sugerido ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedido_compra_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_pedido_compra_sugerido_select ON public.pedido_compra_sugerido FOR SELECT TO authenticated
  USING (( SELECT has_role(auth.uid(), 'master'::app_role)) OR ( SELECT has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY staff_pedido_compra_item_select ON public.pedido_compra_item FOR SELECT TO authenticated
  USING (( SELECT private.cap_compras_ler(( SELECT auth.uid()))));
-- sku_embalagem_equivalencia: empresa em minúsculas (prod: só 'oben'), RLS staff.
CREATE TABLE public.sku_embalagem_equivalencia (id bigserial PRIMARY KEY, grupo_id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa text NOT NULL, sku_codigo_omie text NOT NULL, fator_para_base numeric NOT NULL, ativo boolean NOT NULL DEFAULT true);
ALTER TABLE public.sku_embalagem_equivalencia ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sku_emb_equiv_select ON public.sku_embalagem_equivalencia FOR SELECT TO authenticated
  USING (( SELECT has_role(auth.uid(), 'master'::app_role)) OR ( SELECT has_role(auth.uid(), 'employee'::app_role)));
-- Em prod é VIEW security_invoker sobre venda_items_history (RLS staff); aqui uma tabela com as colunas lidas.
CREATE TABLE public.v_venda_items_history_efetivo (empresa text, data_emissao date, nfe_numero text);
GRANT SELECT ON public.v_venda_items_history_efetivo TO authenticated;
-- calendario_feriados (módulo de tarefas): colunas, PK e policy de PROD (pg_get_expr, psql-ro 2026-11-18).
CREATE TABLE public.calendario_feriados (data date PRIMARY KEY, nome text NOT NULL, tipo text NOT NULL DEFAULT 'nacional',
  observacoes text);
ALTER TABLE public.calendario_feriados ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_calendario_feriados_select ON public.calendario_feriados FOR SELECT TO authenticated
  USING (( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role)
      OR ( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), '$FERIADOS_ROLE_EXTRA'::app_role) AS has_role));
-- Lidas por calendario_itens_antecipar (Task 4b): colunas e tipos de PROD (psql-ro, 2026-11-18) — sea.sku_codigo_omie
-- é TEXT, sp.sku_codigo_omie é BIGINT; RLS de leitura staff (master|employee) como em prod.
CREATE TABLE public.sku_parametros (id bigserial PRIMARY KEY, empresa text NOT NULL, sku_codigo_omie bigint NOT NULL,
  sku_descricao text, fornecedor_nome text, demanda_media_diaria numeric, lt_medio_dias_uteis numeric, ativo boolean);
CREATE TABLE public.sku_estoque_atual (empresa text NOT NULL, sku_codigo_omie text NOT NULL, estoque_fisico numeric NOT NULL,
  estoque_pendente_entrada numeric, ultima_sincronizacao timestamptz, PRIMARY KEY (empresa, sku_codigo_omie));
ALTER TABLE public.sku_parametros ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sku_estoque_atual ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_sku_parametros_select ON public.sku_parametros FOR SELECT TO authenticated
  USING (( SELECT (has_role(( SELECT auth.uid()), 'master'::app_role) OR has_role(( SELECT auth.uid()), 'employee'::app_role))));
CREATE POLICY staff_sku_estoque_atual_select ON public.sku_estoque_atual FOR SELECT TO authenticated
  USING (( SELECT has_role(auth.uid(), 'master'::app_role)) OR ( SELECT has_role(auth.uid(), 'employee'::app_role)));
SQL

# ── Migration REAL, duas vezes (idempotência: IF NOT EXISTS / OR REPLACE / ADD COLUMN IF NOT EXISTS) ────────
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_USADA" >/dev/null
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_USADA" >/dev/null
# Task 4b: a migration do sinal "antecipar", também 2× (depende das funções de data acima).
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_ANT_USADA" >/dev/null
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG_ANT_USADA" >/dev/null
# Relógio do sync: SEM BEGIN/COMMIT (vai pelo db:aplicar, que dá a transação) — aqui `-1` faz o papel do executor; 2×.
if [ "$APLICA_REL" -eq 1 ]; then
  PGOPTIONS="-c client_min_messages=warning" P -q -1 -f "$MIG_REL_USADA" >/dev/null
  PGOPTIONS="-c client_min_messages=warning" P -q -1 -f "$MIG_REL_USADA" >/dev/null
fi
eq "AIDEMP migration aplicada 2x sem erro" "ok" "ok"

eq "ACOL1 pedido_compra_sugerido.data_recebimento_prevista date NULL" \
   "$(Pq -c "SELECT data_type||'/'||is_nullable FROM information_schema.columns WHERE table_name='pedido_compra_sugerido' AND column_name='data_recebimento_prevista'")" "date/YES"
eq "ACOL2 pedido_compra_sugerido.recebimento_ajustado_calendario boolean NULL" \
   "$(Pq -c "SELECT data_type||'/'||is_nullable FROM information_schema.columns WHERE table_name='pedido_compra_sugerido' AND column_name='recebimento_ajustado_calendario'")" "boolean/YES"

# Roda ANTES das fixtures de data FIXA (recesso 18/12–03/01, 07–08/12): a janela móvel [hoje-30, hoje] nunca
# encontra linha da OBEN que não seja dela, seja qual for o hoje do CI (bomba-relógio da revisão, I2). Ao fim, as
# linhas W2/W3 saem para não colidir com a carga fixa. O NOT EXISTS na escolha dos W é cinto-e-suspensório.
# ── calendario_dias_sem_nf (relativo ao HOJE de SP) — ANTES da carga fixa ───────────────────────────────────────────────────────────
HOJE="${HOJE_TESTE:-$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")}"
read -r W1 W2 W3 <<<"$(Pq -c "SELECT string_agg(d::text, ' ' ORDER BY d DESC) FROM (
  SELECT g::date d FROM generate_series('$HOJE'::date - 30, '$HOJE'::date - 3, '1 day') g
   WHERE extract(isodow FROM g) < 6
     AND NOT EXISTS (SELECT 1 FROM public.calendario_operacao_empresa c WHERE c.data = g::date AND c.empresa = 'OBEN')
   ORDER BY g DESC LIMIT 3) x")"
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

P -q -c "DELETE FROM public.calendario_operacao_empresa WHERE empresa = 'OBEN' AND data IN ('$W2', '$W3')"
eq "ASEMNF_LIMPO sem linha da OBEN antes da carga fixa" "$(Pq -c "SELECT count(*) FROM public.calendario_operacao_empresa")" "0"

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
  ('2027-01-01', 'OBEN', 'Sayerlack', 'ano novo', 'feriado'),
  ('2027-01-04', 'OBEN', 'Sayerlack', 'inventario', 'manual');   -- fechamento PRÓPRIO, fora de feriado (AFORN2b)
-- Feriados: 25/12 e 01/01 nacionais; 24/12 municipal (não fecha fornecedor).
INSERT INTO public.calendario_feriados (data, nome, tipo) VALUES
  ('2026-12-25', 'Natal', 'nacional'), ('2027-01-01', 'Confraternizacao', 'nacional'),
  ('2026-12-24', 'Vespera municipal', 'municipal');
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
eq "AFORN2b lower(btrim) num fechamento proprio (04/01, nao feriado): 01/01 + 1 -> 05/01" "$(s "'OBEN',' sayerlack  ','2027-01-01',1")" "2027-01-05"
eq "AFORN5 fechamento do X na OBEN nao vale na COLACOR"     "$(s "'COLACOR','Fornecedor X','2026-12-17',3")" "2026-12-22"
eq "AFERIADO_NAC fornecedor sem linha pula 25/12 nacional: 23/12 + 2 -> 28/12" "$(s "'OBEN','Outro','2026-12-23',2")" "2026-12-28"
eq "AFERIADO_MUNI feriado municipal (24/12) NAO fecha fornecedor: 23/12 + 1 -> 24/12" "$(s "'OBEN','Outro','2026-12-23',1")" "2026-12-24"
eq "AFERIADO_EMP employee (INVOKER sob RLS de calendario_feriados) ve o feriado nacional" \
   "$(Pq -c "$(como "$E" "SELECT public.calendario_somar_dias_uteis_fornecedor('OBEN','Outro','2026-12-23',2)")" | tail -1)" "2026-12-28"
eq "AFORN6 fornecedor NULL -> NULL (ausente != sem fechamento)" "$(s "'OBEN',NULL,'2026-12-23',2")" "NULL"
eq "AFORN7 fornecedor sem linha = somarDiasUteis puro"     "$(s "'OBEN','Outro','2026-12-17',3")" "2026-12-22"

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

# ── calendario_itens_antecipar (Task 4b) — hoje FIXADO em 2026-12-01 via p_hoje; fim do recesso 03/01/2027 ──────
# Fornecedor X (OBEN) fechado 21/12–03/01 (carga acima). 03/01 (dom) + 10 uteis do X = sex 15/01, dia aberto da
# OBEN -> chegada 15/01 = 45 dias corridos desde 01/12. Entra se (fisico + pendente) / demanda < 45.
P -q <<'SQL'
INSERT INTO public.calendario_operacao_fornecedor (data, empresa, fornecedor_nome, motivo, origem) VALUES
  ('2026-12-24', 'COLACOR', 'Fornecedor Y', 'ferias', 'manual');
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, demanda_media_diaria, lt_medio_dias_uteis, ativo) VALUES
  ('OBEN', 1001, 'cob 20 (15 fis + 5 pend)', 'Fornecedor X',    1,    10,   true),
  ('OBEN', 1002, 'cob 80',                   'Fornecedor X',    1,    10,   true),
  ('OBEN', 1003, 'demanda NULL',             'Fornecedor X',    NULL, 10,   true),
  ('OBEN', 1004, 'demanda 0',                'Fornecedor X',    0,    10,   true),
  ('OBEN', 1005, 'LT NULL',                  'Fornecedor X',    1,    NULL, true),
  ('OBEN', 1006, 'pendente NULL',            'Fornecedor X',    1,    10,   true),
  ('OBEN', 1007, 'sem linha de estoque',     'Fornecedor X',    1,    10,   true),
  ('OBEN', 1008, 'fornecedor sem recesso',   'Outro',           1,    10,   true),
  ('OBEN', 1009, 'inativo',                  'Fornecedor X',    1,    10,   false),
  ('OBEN', 1010, 'cob 45 = borda',           'Fornecedor X',    2,    10,   true),
  ('OBEN', 1011, 'caixa/espaco, LT 9.2',     ' FORNECEDOR X ',  1,    9.2,  true),
  ('OBEN', 1012, 'cob 44.5',                 'Fornecedor X',    2,    10,   true),
  ('OBEN', 1013, 'fis 1 + app recente 4',    'Fornecedor X',    0.1,  10,   true),
  ('OBEN', 1014, 'app velho (>7d) nao conta', 'Fornecedor X',   0.1,  10,   true),
  ('OBEN', 1015, 'app erro terminal nao conta', 'Fornecedor X', 0.1,  10,   true),
  ('OBEN', 1016, 'portal sem no Omie conta', 'Fornecedor X',    0.1,  10,   true),
  ('OBEN', 1017, 'grupo de equivalencia',    'Fornecedor X',    1,    10,   true),
  ('COLACOR', 2001, 'Y LT 10 cob 1',         'Fornecedor Y',    1,    10,   true),
  ('COLACOR', 2002, 'Y LT 41 -> chegada NULL', 'Fornecedor Y',  1,    41,   true),
  ('COLACOR', 2003, 'X sem recesso na COLACOR', 'Fornecedor X', 1,    10,   true);
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
  ('OBEN', '1001', 15, 5), ('OBEN', '1002', 80, 0), ('OBEN', '1003', 1, 0), ('OBEN', '1004', 1, 0),
  ('OBEN', '1005', 1, 0),  ('OBEN', '1006', 1, NULL), ('OBEN', '1008', 1, 0), ('OBEN', '1009', 1, 0),
  ('OBEN', '1010', 90, 0), ('OBEN', '1011', 10, 0), ('OBEN', '1012', 89, 0),
  ('OBEN', '1013', 1, 0), ('OBEN', '1014', 1, 0), ('OBEN', '1015', 1, 0), ('OBEN', '1016', 1, 0), ('OBEN', '1017', 1, 0),
  ('COLACOR', '2001', 1, 0), ('COLACOR', '2002', 1, 0), ('COLACOR', '2003', 1, 0);
-- Trânsito do app (em_transito do motor, hoje 01/12 ⇒ janela data_ciclo ≥ 24/11). Ids fixos para casar os itens.
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, data_ciclo, status_envio_portal, portal_protocolo, omie_pedido_compra_numero) VALUES
  (1, 'OBEN', 'Fornecedor X', 'aprovado_aguardando_disparo', '2026-11-30', NULL, NULL, NULL),                    -- conta (envio NULL)
  (2, 'OBEN', 'Fornecedor X', 'disparado', '2026-11-20', NULL, NULL, '555'),                                     -- fora da janela de 7 dias
  (3, 'OBEN', 'Fornecedor X', 'aprovado_aguardando_disparo', '2026-11-30', 'erro_nao_retentavel', NULL, NULL),   -- erro terminal: não conta
  (4, 'OBEN', 'Fornecedor X', 'disparado', '2026-11-01', 'sucesso_portal', 'PRT-1', NULL),                       -- ramo do portal: conta
  (5, 'OBEN', 'Fornecedor X', 'cancelado', '2026-11-30', NULL, NULL, NULL);                                      -- cancelado: não conta
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_final) VALUES
  (1, '1013', 4), (1, '2001', 100),   -- 2001 é SKU da COLACOR num pedido da OBEN: não pode cobrir a COLACOR
  (2, '1014', 4), (3, '1015', 4), (4, '1016', 4), (5, '1014', 100);
-- 1017 em grupo ativo (sai por unidade); 1012 em grupo INATIVO (não sai).
INSERT INTO public.sku_embalagem_equivalencia (empresa, sku_codigo_omie, fator_para_base, ativo) VALUES
  ('oben', '1017', 1, true), ('oben', '1012', 1, false);
SQL
# Prefixo "L=" : lista vazia vira "L=", erro da query vira "" — vazio por ERRO nunca casa com vazio esperado.
ant() { Pq -c "SELECT 'L=' || COALESCE(string_agg(sku_codigo_omie||':'||cobertura_dias::numeric(10,2)||':'||dias_ate_chegada_pos_recesso, ',' ORDER BY cobertura_dias, sku_codigo_omie), '') FROM public.calendario_itens_antecipar($1)"; }
ANT_OBEN="L=1011:10.00:45,1014:10.00:45,1015:10.00:45,1001:20.00:45,1012:44.50:45"
eq "APRE_ANT X: 03/01 + 10 uteis -> 15/01 e recebimento OBEN 15/01" \
   "$(Pq -c "SELECT public.calendario_proximo_dia_recebimento('OBEN', public.calendario_somar_dias_uteis_fornecedor('OBEN','Fornecedor X','2027-01-03',10))")" "2027-01-15"
eq "AANT1 OBEN: cob 10 (lower/btrim, ceil LT; app velho; erro terminal), 20 (fis+pend) e 44.5 < 45; fora: 80, borda 45, NULLs, inativo, Outro, app recente, portal, grupo" \
   "$(ant "'OBEN','2027-01-03','2026-12-01'")" "$ANT_OBEN"
eq "AANT_EXCL OBEN: 17 SKUs na fixture, 5 listados (12 excluidos — contagem visivel)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.sku_parametros WHERE empresa='OBEN')||'/'||(SELECT count(*) FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01'))")" "17/5"
eq "AANT_COLACOR so o Y de LT 10; LT 41 -> chegada NULL (teto 60) fica FORA; X sem recesso na COLACOR fora" \
   "$(ant "'COLACOR','2027-01-03','2026-12-01'")" "L=2001:1.00:45"
eq "AANT_JANELA hoje 04/01, fim 10/01: X sem dia fechado na janela -> vazio" \
   "$(ant "'OBEN','2027-01-10','2027-01-04'")" "L="
eq "AANT_NULL empresa NULL -> vazio" "$(ant "NULL,'2027-01-03','2026-12-01'")" "L="
eq "AANT_DEFAULT p_hoje default = hoje de Sao Paulo" \
   "$(Pq -c "SELECT pg_get_function_arguments('public.calendario_itens_antecipar(text,date,date)'::regprocedure) LIKE '%p_hoje date DEFAULT ((now() AT TIME ZONE ''America/Sao_Paulo''::text))::date%'")" "t"
eq "AANT_MASTER master via JWT (INVOKER sob RLS de sku_* e pedido_compra_item) ve a mesma lista" \
   "$(Pq -c "$(como "$M" "SELECT string_agg(sku_codigo_omie::text, ',' ORDER BY cobertura_dias, sku_codigo_omie) FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")" | tail -1)" "1011,1014,1015,1001,1012"
eq "AANT_MOTIVOS OBEN: motivo de cada SKU avaliado (1008 Outro e 1009 inativo fora do universo)" \
   "$(Pq -c "SELECT string_agg(sku_codigo_omie||':'||motivo, ',' ORDER BY sku_codigo_omie) FROM public.calendario_antecipar_avaliacao('OBEN','2027-01-03','2026-12-01')")" \
   "1001:listado,1002:cobre,1003:sem_demanda,1004:sem_demanda,1005:sem_lt,1006:sem_estoque,1007:sem_estoque,1010:cobre,1011:listado,1012:listado,1013:cobre,1014:listado,1015:listado,1016:cobre,1017:grupo_equivalencia"
# Marca [CALENDARIO-...] do erro (o SQLSTATE sozinho não separa "não é staff" de "não lê compras": os dois são 42501).
marca() { P -qAt -c "$1" 2>&1 | grep -oE '\[CALENDARIO-[A-Z-]+\]' | sed -n 1p || true; }
eq "AANT_GATE customer chamando itens_antecipar -> 42501 [CALENDARIO-SEM-PERMISSAO]" \
   "$(estado "$(como "$C" "SELECT * FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")")/$(marca "$(como "$C" "SELECT * FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")")" "42501/[CALENDARIO-SEM-PERMISSAO]"
eq "AANT_COMPRAS employee (RLS de pedido_compra_item zera o transito) -> 42501 [CALENDARIO-ANTECIPAR-SEM-COMPRAS], nunca lista inflada" \
   "$(estado "$(como "$E" "SELECT * FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")")/$(marca "$(como "$E" "SELECT * FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")")" "42501/[CALENDARIO-ANTECIPAR-SEM-COMPRAS]"
eq "AANT_SVC service_role (JWT sem sub) ve a mesma lista" \
   "$(Pq -c "SET ROLE service_role; SELECT string_agg(sku_codigo_omie::text, ',' ORDER BY cobertura_dias, sku_codigo_omie) FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')" | tail -1)" "1011,1014,1015,1001,1012"

# ── calendario_itens_antecipar_resumo (P2a): MESMO universo da lista ───────────────────────────────────────────
res() { Pq -c "SELECT 'R=' || avaliados||'/'||listados||'/'||sem_dado FROM public.calendario_itens_antecipar_resumo($1)"; }
eq "ARES1 OBEN: 15 avaliados, 5 listados, 6 sem dado (2 demanda, LT, 2 estoque, grupo)" "$(res "'OBEN','2027-01-03','2026-12-01'")" "R=15/5/6"
eq "ARES2 COLACOR: 2 avaliados (Y), 1 listado, 1 sem chegada" "$(res "'COLACOR','2027-01-03','2026-12-01'")" "R=2/1/1"
eq "ARES3 resumo listados = linhas da lista (mesma logica)" \
   "$(Pq -c "SELECT (SELECT listados FROM public.calendario_itens_antecipar_resumo('OBEN','2027-01-03','2026-12-01')) = (SELECT count(*) FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01'))")" "t"
eq "ARES_JANELA sem fechamento na janela -> 0/0/0 (universo vazio, nao 'sem dado')" "$(res "'OBEN','2027-01-10','2027-01-04'")" "R=0/0/0"
eq "ARES_GATE employee sem compras -> 42501 tambem no resumo" \
   "$(estado "$(como "$E" "SELECT * FROM public.calendario_itens_antecipar_resumo('OBEN','2027-01-03','2026-12-01')")")" "42501"

# ── Relógio do sync (20261119140000): o corte do trânsito do app = o do motor 20261118120000 ───────────────────────
# Motor em D = 01/12 (p_hoje). Cada SKU: Fornecedor X, demanda 0.1, fisico 1 (cob 10 < 45 = listado); +4 do app = cob
# 50 (cobre). O corte é POR SKU: LEAST(D, dia SP de (ultima_sincronizacao - 1 h)) - 7.
#   1018 retrato D-1 (30/11 12:00 SP), pedido D-8 (23/11): motor conta (corte 23/11) -> cobre; versão anterior: listado.
#   1019 retrato 01/12 00:30 SP: a folga de 1 h o leva a 30/11 (corte 23/11) -> conta. Sem folga ou em UTC: 01/12, não conta.
#   1020 retrato DEPOIS de D (05/12), pedido 25/11: LEAST segura o corte em 24/11 -> conta. Sem LEAST: 28/11, não conta.
#   1021 retrato NULL, pedido 23/11: corte de antes (24/11) -> NÃO conta, listado (NULL nunca alarga a janela).
P -q <<'SQL'
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, demanda_media_diaria, lt_medio_dias_uteis, ativo) VALUES
  ('OBEN', 1018, 'retrato D-1, app D-8',       'Fornecedor X', 0.1, 10, true),
  ('OBEN', 1019, 'retrato 00:30 SP, folga 1h', 'Fornecedor X', 0.1, 10, true),
  ('OBEN', 1020, 'retrato depois de D (LEAST)', 'Fornecedor X', 0.1, 10, true),
  ('OBEN', 1021, 'retrato NULL, app D-8',      'Fornecedor X', 0.1, 10, true);
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, ultima_sincronizacao) VALUES
  ('OBEN', '1018', 1, 0, '2026-11-30 12:00:00-03'), ('OBEN', '1019', 1, 0, '2026-12-01 00:30:00-03'),
  ('OBEN', '1020', 1, 0, '2026-12-05 12:00:00-03'), ('OBEN', '1021', 1, 0, NULL);
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, data_ciclo, status_envio_portal, portal_protocolo, omie_pedido_compra_numero) VALUES
  (6, 'OBEN', 'Fornecedor X', 'disparado', '2026-11-23', NULL, NULL, '777'),   -- D-8
  (7, 'OBEN', 'Fornecedor X', 'disparado', '2026-11-25', NULL, NULL, '778');   -- D-6
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_final) VALUES
  (6, '1018', 4), (6, '1019', 4), (7, '1020', 4), (6, '1021', 4);
SQL
mot() { Pq -c "SELECT COALESCE(string_agg(sku_codigo_omie||':'||motivo||':'||cobertura_dias::numeric(10,2), ','), 'AUSENTE') FROM public.calendario_antecipar_avaliacao('OBEN','2027-01-03','2026-12-01') WHERE sku_codigo_omie = $1"; }
eq "ARELOGIOD1 retrato D-1 + pedido D-8: conta o pedido como o motor (cobre, cob 50)" "$(mot 1018)" "1018:cobre:50.00"
eq "ARELOGIOFOLGA retrato 00:30 SP: folga de 1 h no fuso de SP -> conta (cobre)" "$(mot 1019)" "1019:cobre:50.00"
eq "ARELOGIOLEAST retrato depois de D: LEAST segura o corte em D-7 -> conta (cobre)" "$(mot 1020)" "1020:cobre:50.00"
eq "ARELOGIONULL retrato NULL: corte de antes, pedido D-8 NAO conta (listado, cob 10)" "$(mot 1021)" "1021:listado:10.00"
eq "ARELOGIOLISTA a lista OBEN ganha so o 1021 (1018/1019/1020 cobertos pelo trânsito)" \
   "$(ant "'OBEN','2027-01-03','2026-12-01'")" "L=1011:10.00:45,1014:10.00:45,1015:10.00:45,1021:10.00:45,1001:20.00:45,1012:44.50:45"
eq "ARELOGIORES resumo: 19 avaliados, 6 listados, 6 sem dado" "$(res "'OBEN','2027-01-03','2026-12-01'")" "R=19/6/6"
eq "ARELOGIOACL avaliacao: EXECUTE so authenticated/service_role (REPLACE preservou a ACL)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.calendario_antecipar_avaliacao(text,date,date)', 'EXECUTE') AND has_function_privilege('service_role', 'public.calendario_antecipar_avaliacao(text,date,date)', 'EXECUTE') AND NOT has_function_privilege('anon', 'public.calendario_antecipar_avaliacao(text,date,date)', 'EXECUTE') AND NOT has_function_privilege('sem_grant', 'public.calendario_antecipar_avaliacao(text,date,date)', 'EXECUTE')")" "t"

# ── calendario_previsao_pedido (P1c): a MESMA regra da edge v1.17, antes do disparo ─────────────────────────────
prev() { Pq -c "SELECT 'P=' || COALESCE(promessa::text,'NULL')||'/'||COALESCE(recebimento::text,'NULL') FROM public.calendario_previsao_pedido($1)"; }
eq "APREV1 portal 21/12 + 2 uteis (Outro) -> promessa 23/12, recebimento 04/01 (recesso OBEN)" \
   "$(prev "'OBEN','Outro','2026-12-21',NULL,'2026-12-01'")" "P=2026-12-23/2027-01-04"
eq "APREV2 sem portal: hoje 17/12 + 3 uteis do Fornecedor X (fechado 21/12-03/01) -> 05/01 e recebe 05/01" \
   "$(prev "'OBEN','Fornecedor X',NULL,3,'2026-12-17'")" "P=2027-01-05/2027-01-05"
eq "APREV3 sem portal e sem recesso: hoje 01/12 + 3 uteis -> 04/12, recebe 04/12" \
   "$(prev "'OBEN','Outro',NULL,3,'2026-12-01'")" "P=2026-12-04/2026-12-04"
eq "APREV_LT_NULL sem portal e LT NULL -> NULL/NULL (sem ?? 7 inventado)" "$(prev "'OBEN','Outro',NULL,NULL,'2026-12-01'")" "P=NULL/NULL"
eq "APREV_NULL recebimento NULL (COLACOR 76 dias fechada) -> NULL/NULL, nunca promessa sem recebimento" \
   "$(prev "'COLACOR','Outro',NULL,1,'2027-02-26'")" "P=NULL/NULL"
eq "APREV_FORN fornecedor NULL -> NULL/NULL" "$(prev "'OBEN',NULL,'2026-12-21',NULL,'2026-12-01'")" "P=NULL/NULL"
eq "APREV_1LINHA sempre exatamente 1 linha" "$(Pq -c "SELECT count(*) FROM public.calendario_previsao_pedido(NULL,NULL,NULL,NULL,NULL)")" "1"
eq "APREV_EMP employee le a previsao" \
   "$(Pq -c "$(como "$E" "SELECT recebimento FROM public.calendario_previsao_pedido('OBEN','Outro','2026-12-21',NULL,'2026-12-01')")" | tail -1)" "2027-01-04"
eq "APREV_GATE customer -> 42501" \
   "$(estado "$(como "$C" "SELECT * FROM public.calendario_previsao_pedido('OBEN','Outro','2026-12-21',NULL,'2026-12-01')")")" "42501"
eq "AANT_ANON anon NAO executa calendario_itens_antecipar" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.calendario_itens_antecipar(text,date,date)', 'EXECUTE')")" "f"
eq "AANT_PUBLIC PUBLIC NAO executa calendario_itens_antecipar" \
   "$(Pq -c "SELECT has_function_privilege('sem_grant', 'public.calendario_itens_antecipar(text,date,date)', 'EXECUTE')")" "f"
eq "AANT_AUTH authenticated e service_role executam calendario_itens_antecipar" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', 'public.calendario_itens_antecipar(text,date,date)', 'EXECUTE') AND has_function_privilege('service_role', 'public.calendario_itens_antecipar(text,date,date)', 'EXECUTE')")" "t"
eq "AANT_ANON_EXEC anon chamando de fato -> 42501 (sem EXECUTE)" \
   "$(estado "SET ROLE anon; SELECT * FROM public.calendario_itens_antecipar('OBEN','2027-01-03','2026-12-01')")" "42501"

# ── ACL: REVOKE nas DUAS pontas (PUBLIC e anon), EXECUTE para authenticated e service_role ────────────────────
for fn in "calendario_proximo_dia_recebimento(text,date)" "calendario_somar_dias_uteis_fornecedor(text,text,date,integer)" "calendario_dias_sem_nf(text,date,date)" \
          "calendario_antecipar_avaliacao(text,date,date)" "calendario_itens_antecipar_resumo(text,date,date)" "calendario_previsao_pedido(text,text,date,integer,date)"; do
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

# ── Carga inicial 2025–2030 (Task 2): arquivo REAL, 2× (idempotência), contagens exatas ──────────────────────
CARGA="$(dirname "$DATA")/carga.sql"
cp "$REPO_ROOT/db/carga-calendario-operacao-2025-2030.sql" "$CARGA"
if [ -n "$CARGA_SABOTAR" ]; then
  [ "$(grep -cF -- "$CARGA_SABOTAR" "$CARGA")" -ge 1 ] || { echo "padrao ausente na carga: $CARGA_SABOTAR"; exit 2; }
  grep -vF -- "$CARGA_SABOTAR" "$CARGA" > "$CARGA.tmp"; mv "$CARGA.tmp" "$CARGA"
fi
P -q -c "TRUNCATE public.calendario_operacao_empresa, public.calendario_operacao_fornecedor; DELETE FROM public.calendario_feriados WHERE data >= '2027-01-01'" >/dev/null
LOGC0="$(Pq -c "SELECT count(*) FROM public.calendario_operacao_log")"
PGOPTIONS="-c client_min_messages=warning" P -q -f "$CARGA" >/dev/null
eq "ACARGA1 empresa: linhas por origem/empresa" \
   "$(Pq -c "SELECT string_agg(origem||'/'||empresa||'='||n, ' ' ORDER BY origem, empresa) FROM (SELECT origem, empresa, count(*) n FROM public.calendario_operacao_empresa GROUP BY 1,2) x")" \
   "emenda/COLACOR=16 emenda/OBEN=16 escala/COLACOR=148 escala/OBEN=148 feriado/COLACOR=34 feriado/OBEN=34 historico/COLACOR=26 historico/OBEN=33 manual/COLACOR=12 manual/OBEN=12"
eq "ACARGA2 fornecedor: total e fornecedores distintos" \
   "$(Pq -c "SELECT count(*)||'/'||count(DISTINCT fornecedor_nome) FROM public.calendario_operacao_fornecedor")" "616/7"
eq "ACARGA3 feriados nacionais 2027 = 10 e Corpus 2027 fora da calendario_feriados" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.calendario_feriados WHERE data BETWEEN '2027-01-01' AND '2027-12-31' AND tipo='nacional')||'/'||(SELECT count(*) FROM public.calendario_feriados WHERE data='2027-05-27')")" "10/0"
eq "ACARGA4 1 linha de log por linha carregada" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.calendario_operacao_log) - $LOGC0 - (SELECT count(*) FROM public.calendario_operacao_empresa) - (SELECT count(*) FROM public.calendario_operacao_fornecedor)")" "0"
eq "ACARGA5 fechado => peso 0 e meia_equipe/pendente_dado => peso 1" \
   "$(Pq -c "SELECT count(*) FROM public.calendario_operacao_empresa WHERE (status='fechado') <> (peso=0)")" "0"
eq "ACARGA6 dia de volta 04/01/2027 aberto (sem linha) e recesso 18/12/2026 fechado" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.calendario_operacao_empresa WHERE data='2027-01-04')||'/'||(SELECT status FROM public.calendario_operacao_empresa WHERE data='2026-12-18' AND empresa='OBEN')")" "0/fechado"
LOGC1="$(Pq -c "SELECT count(*) FROM public.calendario_operacao_log")"
P -q -c "UPDATE public.calendario_operacao_empresa SET motivo='edicao do founder' WHERE data='2026-12-18' AND empresa='OBEN'" >/dev/null
PGOPTIONS="-c client_min_messages=warning" P -q -f "$CARGA" >/dev/null
eq "ACARGA7 re-rodar nao insere nem sobrescreve edicao (log so +1 do UPDATE)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.calendario_operacao_log) - $LOGC1 || '/' || (SELECT motivo FROM public.calendario_operacao_empresa WHERE data='2026-12-18' AND empresa='OBEN')")" "1/edicao do founder"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK calendario-operacao"

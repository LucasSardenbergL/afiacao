#!/usr/bin/env bash
# Prova PG17 — F1 Task 9: movimento Omie REALIZADO por dia (regra v1) + calibracao + gate fail-closed por lado.
# Plano: docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md (Task 9 + apendice "Task 9, Step 1").
# Migration sob prova: supabase/migrations/20261121232454_banco_extrato_omie_dia.sql (aplicada 2x).
# Dependencia (aplicada antes, INTACTA): 20261121123119_banco_extrato_f1.sql, com os stubs da prova dela
# (funcao stubs() extraida de db/test-banco-extrato-f1.sh — a F1 e o predecessor real; se os stubs dela mudarem,
# esta prova os segue).
#
# Fixtures: NENHUM numero real de agencia/conta (agencia '0000'). Valores inventados. Datas de out/2026, um
# comportamento por dia (para cada sabotagem pintar UM assert nomeado):
#   D01 10-05 soma Pix Itau (2001+2002) + otica CONTA_A_RECEBER duplicada (mais nova) + 1 BAXP
#   D02 10-06 so uma baixa de valor 0                   D03 10-07 duas versoes da mesma baixa (nCodBaixa)
#   D04 10-08 transferencia ENTRE as 2 contas da mesma conta bancaria
#   D05 10-09 data_credito (D05) x data_pagamento (D06) + linha so com data_movimento
#   D07 10-11 sem nenhuma linha                         D08 10-12 so PREVISAO_PEDIDO_VENDA com valor > 0
#   D09 10-13 so MANR (fora da lista positiva)          D10 10-14 so baixa de titulo CANCELADO (receber)
#   D11 10-15 so baixa de titulo PAGTO PARCIAL          D12 10-16 so BAXP de titulo ATRASADO (pagar)
#   D13 10-17 TRAR de conta Omie de OUTRO banco (transferencia externa entra)
#
# Rodar:  bash db/test-banco-extrato-omie-dia.sh > log 2>&1; echo "exit=$?"   (NAO pipe pra tail — engole o exit)
#         LOCALE_TESTE=pt_BR.UTF-8 bash db/test-banco-extrato-omie-dia.sh      (o 2o idioma — money-path.md)
#         bash db/test-banco-extrato-omie-dia.sh --falsificar                  (controle verde + 1 camada por vez)
# Sentinelas ASCII, caixa fixa. Negativos casam a SQLSTATE EXATA (qualquer outra = FAIL).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_F1="$REPO_ROOT/supabase/migrations/20261121123119_banco_extrato_f1.sql"
MIG="$REPO_ROOT/supabase/migrations/20261121232454_banco_extrato_omie_dia.sql"
TESTE_F1="$REPO_ROOT/db/test-banco-extrato-f1.sh"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<VERMELHOS> (idioma do gate falsificar-exige-assert): IDs unidos por "," = E -- TODOS tem de
  # aparecer como "FAIL <id> " no log da rodada sabotada. Nenhuma entrada declara :VERDES.
  SABOTAGENS="sem_grupo:t9_otica_conta_corrente_nao_dobra,t9_previsao_valor_positivo_nao_e_realizado
    lista_aberta:t9_natureza_fora_da_lista_nao_entra
    sem_valor_positivo:t9_omie_dia_ignora_previsao_valor_zero
    data_movimento:t9_data_efetiva_nao_e_data_movimento
    pagamento_antes:t9_data_credito_prevalece
    sem_dedup:t9_dedup_versao_da_baixa
    dedup_antiga:t9_dedup_versao_da_baixa
    cancelada_rec_entra:t9_ignora_baixa_cancelada
    cancelada_pag_entra:t9_ignora_baixa_cancelada_pagar
    parcial_sai:t9_pagto_parcial_entra
    transf_interna_entra:t9_transferencia_mesma_conta_bancaria_sai
    transf_externa_sai:t9_transferencia_externa_entra
    sem_pix:t9_omie_dia_soma_pix_itau
    gate_c_aberto:t9_gate_sem_calibracao_null
    gate_d_aberto:t9_gate_sem_calibracao_null
    gate_lados_juntos:t9_creditos_e_debitos_calibrados_separadamente
    gate_bool_or:t9_gate_reprovada_fecha
    gate_sem_coalesce:t9_gate_sem_calibracao_null
    gate_zero_dias:t9_gate_zero_dias_fecha
    gate_qualquer_versao:t9_outra_versao_nao_calibra
    gate_sem_movimento:t9_gate_so_zero_igual_zero_fecha
    periodo_ignorado:t9_gate_fora_do_periodo_medido
    janela_antes_do_dedup:t9_dedup_antes_da_janela
    sentido_coalesce_zero:t9_sentido_sem_linha_null
    service_role_escreve:t9_calibracao_escrita_negada,t9_migration_aplica
    policy_aberta_sem_pos:t9_calibracao_rls
    pre_sem_ambiguo:t9_pre_seed_ambiguo_aborta
    dia_sem_linha_zero:t9_dia_sem_linha_null
    definer:t9_rls_sem_acesso,t9_migration_aplica
    anon_exec:t9_rpc_acl,t9_migration_aplica
    tabela_sem_rls:t9_calibracao_rls,t9_migration_aplica
    policy_aberta:t9_calibracao_rls,t9_migration_aplica
    grant_aberto:t9_calibracao_escrita_negada,t9_migration_aplica
    seed_errado:t9_seed_calibracao_oben,t9_migration_aplica
    seed_errado_sem_pos:t9_seed_calibracao_oben,t9_gate_oben_seed_fechado
    tabela_sem_if_not_exists:t9_idempotente
    seed_sem_on_conflict:t9_idempotente"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-banco-omie-dia.XXXXXX")"
  echo "== CONTROLE (locale=${LOCALE_TESTE:-C}) =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK banco-extrato-omie-dia" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
  echo "OK controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") asserts)"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; alvos="${par#*:}"; verm="${alvos%%:*}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "FALHA $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "FALHA $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    faltou=""
    for a in ${verm//,/ }; do
      grep -qF -- "FAIL $a " "$LOGDIR/$s.log" || faltou="$faltou $a"
    done
    if [ -z "$faltou" ]; then
      echo "OK $s: vermelha em [${verm//,/, }]"
    else
      echo "FALHA $s: vermelha, mas NAO em [$faltou ] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5813}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-banco-omie-dia.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

for f in "$MIG" "$MIG_F1" "$TESTE_F1"; do
  [ -f "$f" ] || { echo "FAIL t9_migration_aplica — arquivo ausente: $f"; echo "PASS=0 FAIL=1"; exit 1; }
done
cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrencias; padrao ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY' || exit 2
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
  # regra v1 — uma camada por vez
  sem_grupo)            sabotar "WHERE m.categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')" "WHERE true" ;;
  lista_aberta)         sabotar "'BAXP', 'APEP', 'TRAP', 'EXTP')" "'BAXP', 'APEP', 'TRAP', 'EXTP', 'MANR')" ;;
  sem_valor_positivo)   sabotar "AND m.valor > 0" "AND m.valor >= 0" ;;
  data_movimento)       sabotar "COALESCE(m.data_credito_omie, m.data_pagamento_omie)" "COALESCE(m.data_credito_omie, m.data_pagamento_omie, m.data_movimento)" ;;
  pagamento_antes)      sabotar "COALESCE(m.data_credito_omie, m.data_pagamento_omie)" "COALESCE(m.data_pagamento_omie, m.data_credito_omie)" ;;
  sem_dedup)            sabotar "SELECT DISTINCT ON (l.company, l.omie_codigo_lancamento, l.omie_ncodbaixa) l.*" "SELECT l.*" ;;
  dedup_antiga)         sabotar "l.updated_at DESC NULLS LAST" "l.updated_at ASC NULLS LAST" ;;
  cancelada_rec_entra)  sabotar "NOT (a.natureza IN ('BAXR', 'APBR') AND EXISTS (" "NOT (false AND EXISTS (" ;;
  cancelada_pag_entra)  sabotar "NOT (a.natureza = 'BAXP' AND EXISTS (" "NOT (false AND EXISTS (" ;;
  parcial_sai)          sabotar "r.status_titulo NOT IN ('RECEBIDO', 'PAGTO PARCIAL')" "r.status_titulo NOT IN ('RECEBIDO')" ;;
  transf_interna_entra) sabotar "NOT (a.natureza IN ('TRAP', 'TRAR') AND EXISTS (" "NOT (false AND EXISTS (" ;;
  transf_externa_sai)   sabotar "JOIN contas c2 ON c2.company = o.company" "JOIN public.fin_contas_correntes c2 ON c2.company = o.company" ;;
  sem_pix)              sabotar "WHERE bco.banco_conta_id = p_banco_conta_id" \
                          "WHERE bco.banco_conta_id = p_banco_conta_id AND bco.omie_ncodcc = (SELECT min(x.omie_ncodcc) FROM public.banco_conta_omie x WHERE x.banco_conta_id = p_banco_conta_id)" ;;
  # gate
  gate_c_aberto)        sabotar "CASE WHEN v_conta_c AND medido.dentro THEN agg.cred END" "CASE WHEN true THEN agg.cred END" ;;
  gate_d_aberto)        sabotar "CASE WHEN v_conta_d AND medido.dentro THEN agg.deb END" "CASE WHEN true THEN agg.deb END" ;;
  gate_lados_juntos)    sabotar "AND k.dias_batem_debitos + k.divergencias_explicadas_debitos = k.dias_conferidos" \
                          "AND k.dias_batem_creditos + k.divergencias_explicadas_creditos = k.dias_conferidos" ;;
  gate_bool_or)         sabotar "coalesce(bool_and(" "coalesce(bool_or(" ;;
  gate_sem_coalesce)    sabotar "coalesce(bool_and(" "(bool_and("
                        sabotar "k.dias_conferidos), false)" "k.dias_conferidos))" ;;
  gate_zero_dias)       sabotar "k.dias_conferidos > 0" "k.dias_conferidos >= 0" ;;
  gate_qualquer_versao) sabotar "AND k.regra_versao = c_versao" "" ;;
  gate_sem_movimento)   sabotar "k.dias_conferidos > 0 AND k.dias_com_movimento_creditos > 0" "k.dias_conferidos > 0" ;;
  periodo_ignorado)     sabotar "AND dias.d BETWEEN k.de AND k.ate" "" ;;
  janela_antes_do_dedup) sabotar "-- SEM filtro de periodo aqui: o dedup abaixo precisa ver todas as versoes da baixa (o periodo vai no agg)" \
                          "AND COALESCE(m.data_credito_omie, m.data_pagamento_omie) BETWEEN p_de AND p_ate" ;;
  sentido_coalesce_zero) sabotar "sum((v.valor * 100)::bigint) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_PAG')::bigint AS deb" \
                          "COALESCE(sum((v.valor * 100)::bigint) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_PAG'), 0)::bigint AS deb" ;;
  dia_sem_linha_zero)   sabotar "CASE WHEN v_conta_c AND medido.dentro THEN agg.cred END" "CASE WHEN v_conta_c AND medido.dentro THEN coalesce(agg.cred, 0) END" ;;
  # seguranca / ACL
  definer)              sabotar "SECURITY INVOKER" "SECURITY DEFINER" ;;
  anon_exec)            sabotar "REVOKE ALL ON FUNCTION public.banco_extrato_omie_dia(uuid, date, date) FROM PUBLIC, anon;" "" ;;
  tabela_sem_rls)       sabotar "ALTER TABLE public.banco_regra_calibracao ENABLE ROW LEVEL SECURITY;" "" ;;
  policy_aberta)        sabotar "TO authenticated USING (public.fin_user_can_access(company));" "TO authenticated USING (true);" ;;
  service_role_escreve) sabotar "FROM PUBLIC, anon, authenticated, service_role;" "FROM PUBLIC, anon, authenticated;" ;;
  policy_aberta_sem_pos) sabotar "TO authenticated USING (public.fin_user_can_access(company));" "TO authenticated USING (true);"
                        sabotar "AND qual = 'fin_user_can_access(company)') THEN" ") THEN" ;;
  pre_sem_ambiguo)      sabotar "WHERE company = 'oben' AND banco_codigo = '341') > 1 THEN" "WHERE company = 'oben' AND banco_codigo = '341') > 99 THEN" ;;
  grant_aberto)         sabotar "GRANT SELECT ON TABLE public.banco_regra_calibracao TO authenticated;" "GRANT ALL ON TABLE public.banco_regra_calibracao TO authenticated;" ;;
  # seed e re-apply
  seed_errado)          sabotar "       7, 7, 0, 0," "       31, 31, 0, 0," ;;
  seed_errado_sem_pos)  sabotar "       7, 7, 0, 0," "       31, 31, 0, 0,"
                        sabotar "AND k.dias_batem_creditos = 7 AND k.dias_batem_debitos = 7" "AND k.dias_batem_creditos = 31 AND k.dias_batem_debitos = 31" ;;
  tabela_sem_if_not_exists) sabotar "CREATE TABLE IF NOT EXISTS public.banco_regra_calibracao" "CREATE TABLE public.banco_regra_calibracao" ;;
  seed_sem_on_conflict) sabotar "ON CONFLICT (banco_conta_id, regra_versao, de, ate) DO NOTHING;" ";" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null || { echo "initdb falhou"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null || { echo "pg_ctl falhou"; exit 1; }
DB=prove
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$DB" "$@"; }
Pq() { P -qAt "$@"; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# estado <uid|''> <role> <sql> -> SQLSTATE do comando (00000 = executou); comparada EXATA no eq.
estado() {
  local out
  out=$(P -qAt 2>&1 <<SQL
SET test.uid = '$1';
SET ROLE $2;
DO \$t\$ BEGIN
  EXECUTE \$q\$$3\$q\$;
  RAISE NOTICE 'ESTADO=00000';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'ESTADO=%', SQLSTATE;
END \$t\$;
SQL
)
  printf '%s\n' "$out" | grep -oE 'ESTADO=[0-9A-Z]{5}' | tail -1 | cut -d= -f2
}
como() { Pq -c "SET test.uid = '$1'; SET ROLE authenticated; $2" | tail -1; }

U_SEM=00000000-0000-0000-0000-0000000000a1     # autenticado sem permissao financeira
U_OBEN=00000000-0000-0000-0000-0000000000a2    # fin_permissoes: so oben
U_STAFF=00000000-0000-0000-0000-0000000000a3   # employee: ve todas

echo "=== setup PG17 :$PORT locale=$LOC ==="
# os stubs da F1 (fin_user_can_access identico a prod, fin_contas_correntes, ledger predecessor, cron, storage)
STUBS_F1="$(awk '/^stubs\(\) \{/{f=1} f{print} f&&/^}$/{exit}' "$TESTE_F1")"
case "$STUBS_F1" in
  "stubs() {"*"SQL"*"}") ;;
  *) echo "FAIL t9_migration_aplica — nao extraiu stubs() de $TESTE_F1"; echo "PASS=0 FAIL=1"; exit 1 ;;
esac
eval "$STUBS_F1"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove || { echo "createdb falhou"; exit 1; }
stubs prove || { echo "stubs falharam"; exit 1; }
echo "LOCALE_INITDB prove=$(Pq -c "SELECT datcollate||'/'||datctype FROM pg_database WHERE datname='prove'" 2>&1)"

# o que a regra v1 LE e a F1 nao cria: tipos medidos em prod (information_schema, 2026-11-21); RLS = a de prod
# (fin_mov_select / fin_cr_select / fin_cp_select: SELECT authenticated USING fin_user_can_access(company)).
P -q <<'SQL' || { echo "fixture de esquema falhou"; exit 1; }
CREATE TABLE public.fin_movimentacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text NOT NULL, omie_ncodcc bigint, natureza text,
  valor numeric(15,2), omie_codigo_lancamento bigint, omie_ncodbaixa bigint, categoria_descricao text,
  data_credito_omie date, data_pagamento_omie date, data_movimento date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.fin_contas_receber (company text NOT NULL, omie_codigo_lancamento bigint NOT NULL, status_titulo text);
CREATE TABLE public.fin_contas_pagar   (company text NOT NULL, omie_codigo_lancamento bigint NOT NULL, status_titulo text);
ALTER TABLE public.fin_movimentacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_contas_pagar ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_mov_select ON public.fin_movimentacoes FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
CREATE POLICY fin_cr_select ON public.fin_contas_receber FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
CREATE POLICY fin_cp_select ON public.fin_contas_pagar FOR SELECT TO authenticated USING (public.fin_user_can_access(company));

-- contas Omie (as da prova da F1): colacor = principal 2001 + Pix Itau 2002 (+ inativa 2003, outro banco 2004)
INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, banco, agencia, numero_conta, tipo, ativo) VALUES
  ('colacor',    2001, 'Itau Colacor', '341', '0000', '00000-0', 'CC', true),
  ('colacor',    2002, 'Pix Itau',     '341', NULL,   NULL,      'CC', true),
  ('colacor',    2003, 'Pix Itau',     '341', NULL,   NULL,      'CC', false),
  ('colacor',    2004, 'Outro banco',  '756', '0000', '00000-0', 'CC', true),
  ('oben',       1001, 'Itau Oben',    '341', '0000', '00000-1', 'CC', true),
  ('colacor_sc', 3001, 'Outro banco',  '756', '0000', '00000-1', 'CC', true);
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000000a3', 'employee');
INSERT INTO public.fin_permissoes (user_id, empresas) VALUES ('00000000-0000-0000-0000-0000000000a2', '{oben}');
SQL

echo "=== aplica a F1 (dependencia, intacta) ==="
P -q -f "$MIG_F1" > "$(dirname "$DATA")/f1.log" 2>&1 || { echo "FAIL t9_migration_aplica — F1 nao aplicou: $(head -c 400 "$(dirname "$DATA")/f1.log")"; echo "PASS=0 FAIL=1"; exit 1; }

echo "=== aplica a migration (1a vez) ==="
if P -q -1 -f "$MIG_USADA" > "$(dirname "$DATA")/mig1.log" 2>&1; then
  echo "PASS t9_migration_aplica"; PASS=$((PASS+1))
else
  echo "FAIL t9_migration_aplica — $(head -c 400 "$(dirname "$DATA")/mig1.log")"; FAIL=$((FAIL+1))
fi

ID_OBEN=$(Pq -c "SELECT id FROM public.banco_conta WHERE company='oben'")
ID_COL=$(Pq -c "SELECT id FROM public.banco_conta WHERE company='colacor'")

echo "=== seed ==="
eq t9_seed_calibracao_oben \
  "$(Pq -c "SELECT format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos) FROM public.banco_regra_calibracao WHERE banco_conta_id = '$ID_OBEN'")" \
  "v1|2026-10-01|2026-10-31|31|24|24|7|7|0|0"

echo "=== re-apply ==="
N_ANTES=$(Pq -c "SELECT count(*) FROM public.banco_regra_calibracao")
if P -q -1 -f "$MIG_USADA" > "$(dirname "$DATA")/mig2.log" 2>&1; then RC2=0; else RC2=1; fi
eq t9_idempotente "$RC2|$(Pq -c "SELECT count(*) FROM public.banco_regra_calibracao")" "0|$N_ANTES"

# ── fixture de movimento ──
P -q <<'SQL' || { echo "fixture de movimento falhou"; exit 1; }
-- titulos: 11,12,13,15 liquidados/parcial; 14 cancelado (receber). 21 pago; 22 atrasado (pagar).
INSERT INTO public.fin_contas_receber VALUES ('colacor',11,'RECEBIDO'),('colacor',12,'RECEBIDO'),('colacor',13,'RECEBIDO'),
  ('colacor',14,'CANCELADO'),('colacor',15,'PAGTO PARCIAL'),('oben',91,'RECEBIDO');
INSERT INTO public.fin_contas_pagar VALUES ('colacor',21,'PAGO'),('colacor',22,'ATRASADO');
INSERT INTO public.fin_movimentacoes (company, omie_ncodcc, natureza, valor, omie_codigo_lancamento, omie_ncodbaixa,
                                      categoria_descricao, data_credito_omie, data_pagamento_omie, data_movimento, updated_at) VALUES
  -- D01: 100,00 na principal + 50,00 na Pix; a mesma baixa 1 de novo na otica CONTA_A_RECEBER (mais nova); 30,00 de debito
  ('colacor',2001,'BAXR',100.00,11,1,'CONTA_CORRENTE_REC','2026-10-05','2026-10-05',NULL,'2026-10-05 10:00+00'),
  ('colacor',2002,'APBR', 50.00,12,2,'CONTA_CORRENTE_REC','2026-10-05','2026-10-05',NULL,'2026-10-05 10:00+00'),
  ('colacor',2001,'BAXR',100.00,11,1,'CONTA_A_RECEBER',  '2026-10-05','2026-10-05',NULL,'2026-10-20 10:00+00'),
  ('colacor',2001,'BAXP', 30.00,21,5,'CONTA_CORRENTE_PAG','2026-10-05','2026-10-05',NULL,'2026-10-05 10:00+00'),
  -- D02: so uma baixa de valor 0
  ('colacor',2001,'BAXR',  0.00,11,3,'CONTA_CORRENTE_REC','2026-10-06','2026-10-06',NULL,'2026-10-06 10:00+00'),
  -- D03: duas versoes da baixa 4 do titulo 13 — vale a ultima (45,00)
  ('colacor',2001,'BAXR', 40.00,13,4,'CONTA_CORRENTE_REC','2026-10-07','2026-10-07',NULL,'2026-10-08 10:00+00'),
  ('colacor',2001,'BAXR', 45.00,13,4,'CONTA_CORRENTE_REC','2026-10-07','2026-10-07',NULL,'2026-10-09 10:00+00'),
  -- D04: transferencia Pix <-> principal (mesma conta bancaria)
  ('colacor',2001,'TRAP',200.00,NULL,NULL,'CONTA_CORRENTE_PAG',NULL,'2026-10-08',NULL,'2026-10-08 10:00+00'),
  ('colacor',2002,'TRAR',200.00,NULL,NULL,'CONTA_CORRENTE_REC',NULL,'2026-10-08',NULL,'2026-10-08 10:00+00'),
  -- D05: credito em D05, pagamento em D06 (vale o credito); e uma linha so com data_movimento
  ('colacor',2001,'BAXR', 80.00,11,9,'CONTA_CORRENTE_REC','2026-10-09','2026-10-10',NULL,'2026-10-09 10:00+00'),
  ('colacor',2001,'BAXR', 70.00,11,8,'CONTA_CORRENTE_REC',NULL,NULL,'2026-10-09','2026-10-09 10:00+00'),
  -- D08: previsao com valor positivo e data
  ('colacor',2001,'BAXR',999.00,11,10,'PREVISAO_PEDIDO_VENDA','2026-10-12','2026-10-12',NULL,'2026-10-12 10:00+00'),
  -- D09: natureza fora da lista positiva
  ('colacor',2001,'MANR', 77.00,NULL,NULL,'CONTA_CORRENTE_REC','2026-10-13','2026-10-13',NULL,'2026-10-13 10:00+00'),
  -- D10: baixa de titulo cancelado (receber)
  ('colacor',2001,'BAXR', 60.00,14,11,'CONTA_CORRENTE_REC','2026-10-14','2026-10-14',NULL,'2026-10-14 10:00+00'),
  -- D11: baixa parcial legitima
  ('colacor',2001,'BAXR', 10.00,15,12,'CONTA_CORRENTE_REC','2026-10-15','2026-10-15',NULL,'2026-10-15 10:00+00'),
  -- D12: BAXP de titulo atrasado (pagar)
  ('colacor',2001,'BAXP', 25.00,22,13,'CONTA_CORRENTE_PAG','2026-10-16','2026-10-16',NULL,'2026-10-16 10:00+00'),
  -- D13: TRAR na principal vinda de conta Omie de OUTRO banco (2004 nao e desta conta bancaria)
  ('colacor',2001,'TRAR',300.00,NULL,NULL,'CONTA_CORRENTE_REC',NULL,'2026-10-17',NULL,'2026-10-17 10:00+00'),
  ('colacor',2004,'TRAP',300.00,NULL,NULL,'CONTA_CORRENTE_PAG',NULL,'2026-10-17',NULL,'2026-10-17 10:00+00'),
  -- D31/N01: baixa 30 do titulo 13 corrigida de 31/10 (velha) para 01/11 (nova) — 31/10 nao pode ressuscitar a velha
  ('colacor',2001,'BAXR', 20.00,13,30,'CONTA_CORRENTE_REC','2026-10-31','2026-10-31',NULL,'2026-10-31 10:00+00'),
  ('colacor',2001,'BAXR', 20.00,13,30,'CONTA_CORRENTE_REC','2026-11-01','2026-11-01',NULL,'2026-11-02 10:00+00'),
  -- N05: dado fora do periodo de qualquer calibracao
  ('colacor',2001,'BAXR', 12.00,11,31,'CONTA_CORRENTE_REC','2026-11-05','2026-11-05',NULL,'2026-11-05 10:00+00'),
  -- oben D01: tem dado, mas a calibracao da oben (seed) reprovou
  ('oben',1001,'BAXR',100.00,91,1,'CONTA_CORRENTE_REC','2026-10-05','2026-10-05',NULL,'2026-10-05 10:00+00');
SQL
# calibracao da colacor que APROVA os dois lados (todo dia bate ou explicado), escrita como o envelope faria (postgres)
P -q -c "INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos,
  dias_com_movimento_creditos, dias_com_movimento_debitos,
  dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas)
  VALUES ('colacor', '$ID_COL', 'v1', '2026-10-01', '2026-10-31', 31, 20, 18, 28, 27, 3, 4, 'fixture: aprovada')" \
  || { echo "fixture de calibracao falhou"; exit 1; }

SEL="format('%s|%s|%s|%s', creditos_centavos, debitos_centavos, creditos_calibrado, debitos_calibrado)"
dia() { # <uid> <conta> <data> -> "cred|deb|cal_c|cal_d" (NULL = vazio)
  como "$1" "SELECT $SEL FROM public.banco_extrato_omie_dia('$2', '$3', '$3')"
}
# variacao de calibracao numa transacao desfeita: <sql como postgres> <data>
dia_tx() {
  Pq -c "BEGIN; $1; SET LOCAL test.uid = '$U_STAFF'; SET LOCAL ROLE authenticated;
         SELECT $SEL FROM public.banco_extrato_omie_dia('$ID_COL', '$2', '$2'); ROLLBACK;" | tail -1
}

echo "=== regra v1 ==="
eq t9_omie_dia_soma_pix_itau                 "$(dia "$U_STAFF" "$ID_COL" 2026-10-05)" "15000|3000|t|t"
eq t9_otica_conta_corrente_nao_dobra         "$(dia "$U_STAFF" "$ID_COL" 2026-10-05)" "15000|3000|t|t"
eq t9_omie_dia_ignora_previsao_valor_zero    "$(dia "$U_STAFF" "$ID_COL" 2026-10-06)" "||t|t"
eq t9_dedup_versao_da_baixa                  "$(dia "$U_STAFF" "$ID_COL" 2026-10-07)" "4500||t|t"
eq t9_transferencia_mesma_conta_bancaria_sai "$(dia "$U_STAFF" "$ID_COL" 2026-10-08)" "||t|t"
eq t9_data_efetiva_nao_e_data_movimento      "$(dia "$U_STAFF" "$ID_COL" 2026-10-09)" "8000||t|t"
eq t9_data_credito_prevalece                 "$(dia "$U_STAFF" "$ID_COL" 2026-10-09)/$(dia "$U_STAFF" "$ID_COL" 2026-10-10)" "8000||t|t/||t|t"
eq t9_dia_sem_linha_null                     "$(dia "$U_STAFF" "$ID_COL" 2026-10-11)" "||t|t"
eq t9_previsao_valor_positivo_nao_e_realizado "$(dia "$U_STAFF" "$ID_COL" 2026-10-12)" "||t|t"
eq t9_natureza_fora_da_lista_nao_entra       "$(dia "$U_STAFF" "$ID_COL" 2026-10-13)" "||t|t"
eq t9_ignora_baixa_cancelada                 "$(dia "$U_STAFF" "$ID_COL" 2026-10-14)" "||t|t"
eq t9_pagto_parcial_entra                    "$(dia "$U_STAFF" "$ID_COL" 2026-10-15)" "1000||t|t"
eq t9_ignora_baixa_cancelada_pagar           "$(dia "$U_STAFF" "$ID_COL" 2026-10-16)" "||t|t"
eq t9_transferencia_externa_entra            "$(dia "$U_STAFF" "$ID_COL" 2026-10-17)" "30000||t|t"
eq t9_sentido_sem_linha_null                 "$(dia "$U_STAFF" "$ID_COL" 2026-10-07)" "4500||t|t"
eq t9_dedup_antes_da_janela                  "$(dia "$U_STAFF" "$ID_COL" 2026-10-31)" "||t|t"
eq t9_gate_fora_do_periodo_medido            "$(dia "$U_STAFF" "$ID_COL" 2026-11-05)" "||f|f"
eq t9_serie_densa_uma_linha_por_dia \
  "$(como "$U_STAFF" "SELECT count(*) || '|' || count(DISTINCT data) || '|' || min(data) || '|' || max(data) FROM public.banco_extrato_omie_dia('$ID_COL', '2026-10-01', '2026-10-31')")" \
  "31|31|2026-10-01|2026-10-31"

echo "=== gate ==="
eq t9_gate_sem_calibracao_null \
  "$(dia_tx "DELETE FROM public.banco_regra_calibracao WHERE banco_conta_id = '$ID_COL'" 2026-10-05)" "||f|f"
eq t9_creditos_e_debitos_calibrados_separadamente \
  "$(dia_tx "DELETE FROM public.banco_regra_calibracao WHERE banco_conta_id = '$ID_COL'; INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas) VALUES ('colacor', '$ID_COL', 'v1', '2026-10-01', '2026-10-31', 31, 20, 20, 31, 20, 0, 0, 'so creditos')" 2026-10-05)" \
  "15000||t|f"
eq t9_gate_reprovada_fecha \
  "$(dia_tx "INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas) VALUES ('colacor', '$ID_COL', 'v1', '2026-10-05', '2026-10-05', 1, 1, 1, 0, 0, 0, 0, 'reprovada')" 2026-10-05)" \
  "||f|f"
eq t9_gate_zero_dias_fecha \
  "$(dia_tx "DELETE FROM public.banco_regra_calibracao WHERE banco_conta_id = '$ID_COL'; INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas) VALUES ('colacor', '$ID_COL', 'v1', '2026-10-01', '2026-10-31', 0, 0, 0, 0, 0, 0, 0, 'vazia')" 2026-10-05)" \
  "||f|f"
eq t9_gate_so_zero_igual_zero_fecha \
  "$(dia_tx "DELETE FROM public.banco_regra_calibracao WHERE banco_conta_id = '$ID_COL'; INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas) VALUES ('colacor', '$ID_COL', 'v1', '2026-10-01', '2026-10-31', 31, 0, 0, 31, 31, 0, 0, 'so domingos')" 2026-10-05)" \
  "||f|f"
eq t9_outra_versao_nao_calibra \
  "$(dia_tx "UPDATE public.banco_regra_calibracao SET regra_versao = 'v2' WHERE banco_conta_id = '$ID_COL'" 2026-10-05)" \
  "||f|f"
eq t9_gate_oben_seed_fechado "$(dia "$U_STAFF" "$ID_OBEN" 2026-10-05)" "||f|f"

echo "=== RLS / ACL ==="
eq t9_rls_sem_acesso "$(dia "$U_SEM" "$ID_COL" 2026-10-05)/$(dia "$U_OBEN" "$ID_COL" 2026-10-05)" "||f|f/||f|f"
eq t9_rpc_acl \
  "$(Pq -c "SELECT format('%s|%s|%s|%s', p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'), has_function_privilege('public', p.oid, 'EXECUTE'), has_function_privilege('authenticated', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid = to_regprocedure('public.banco_extrato_omie_dia(uuid,date,date)')")/$(estado "" anon "SELECT * FROM public.banco_extrato_omie_dia('$ID_COL', '2026-10-05', '2026-10-05')")" \
  "f|f|f|t/42501"
eq t9_calibracao_rls \
  "$(como "$U_OBEN" "SELECT count(*) FROM public.banco_regra_calibracao")/$(como "$U_SEM" "SELECT count(*) FROM public.banco_regra_calibracao")/$(como "$U_STAFF" "SELECT count(*) FROM public.banco_regra_calibracao")" \
  "1/0/2"
eq t9_calibracao_escrita_negada \
  "$(estado "$U_STAFF" authenticated "INSERT INTO public.banco_regra_calibracao (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas) VALUES ('colacor', '$ID_COL', 'v1', '2026-08-01', '2026-08-31', 31, 20, 20, 31, 31, 0, 0, 'forjada')")/$(estado "$U_STAFF" authenticated "UPDATE public.banco_regra_calibracao SET dias_batem_creditos = 31")/$(estado "$U_STAFF" authenticated "TRUNCATE public.banco_regra_calibracao")/$(estado "" service_role "UPDATE public.banco_regra_calibracao SET dias_batem_creditos = 31")/$(estado "" service_role "TRUNCATE public.banco_regra_calibracao")" \
  "42501/42501/42501/42501/42501"

echo "=== entradas invalidas ==="
eq t9_intervalo_invalido \
  "$(estado "$U_STAFF" authenticated "SELECT * FROM public.banco_extrato_omie_dia('$ID_COL', '2026-10-05', '2026-10-01')")/$(estado "$U_STAFF" authenticated "SELECT * FROM public.banco_extrato_omie_dia('$ID_COL', '2025-01-01', '2026-10-01')")/$(estado "$U_STAFF" authenticated "SELECT * FROM public.banco_extrato_omie_dia(NULL, '2026-10-01', '2026-10-01')")" \
  "22023/22023/22004"

echo "=== PRE: seed ambiguo ==="
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove_pre || { echo "createdb prove_pre falhou"; exit 1; }
stubs prove_pre || { echo "stubs prove_pre falharam"; exit 1; }
DB=prove_pre P -q -c "CREATE TABLE public.fin_movimentacoes (id uuid, company text, omie_ncodcc bigint, natureza text, valor numeric(15,2), omie_codigo_lancamento bigint, omie_ncodbaixa bigint, categoria_descricao text, data_credito_omie date, data_pagamento_omie date, created_at timestamptz, updated_at timestamptz);
  CREATE TABLE public.fin_contas_receber (company text, omie_codigo_lancamento bigint, status_titulo text);
  CREATE TABLE public.fin_contas_pagar (company text, omie_codigo_lancamento bigint, status_titulo text);
  INSERT INTO public.fin_contas_correntes (company, omie_ncodcc, descricao, banco, agencia, numero_conta, tipo, ativo) VALUES ('oben', 1001, 'Itau Oben', '341', '0000', '00000-1', 'CC', true);" \
  && DB=prove_pre P -q -f "$MIG_F1" > "$(dirname "$DATA")/pre-f1.log" 2>&1 \
  && DB=prove_pre P -q -c "INSERT INTO public.banco_conta (company, banco_codigo, agencia_digitos, conta_digitos) VALUES ('oben', '341', '0000', '000002')" \
  || { echo "fixture prove_pre falhou: $(head -c 300 "$(dirname "$DATA")/pre-f1.log")"; exit 1; }
if DB=prove_pre P -q -1 -f "$MIG_USADA" > "$(dirname "$DATA")/pre.log" 2>&1; then PRE_RC=0; else PRE_RC=1; fi
eq t9_pre_seed_ambiguo_aborta \
  "$PRE_RC/$(grep -c 'PRE FALHOU seed_ambiguo' "$(dirname "$DATA")/pre.log")/$(DB=prove_pre Pq -c "SELECT to_regclass('public.banco_regra_calibracao') IS NULL")" \
  "1/1/t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK banco-extrato-omie-dia"

#!/usr/bin/env bash
# PROVA PG17 — Entrega A da fila "PO a baixar no Omie" (20261120100000_reposicao_po_a_baixar_pares_e_decisao.sql)
#
#   I  a migration aplica com a postcondição OK (I0) e re-aplicar é seguro (I1)
#   P  pares/proposta (v2): associavel fresca traz o par com o item do PO resolvido no espelho (P1); ambigua não traz
#      par (P2); associavel VELHA não traz par (P3); fornecedor da NF = nome do PO mais recente do mesmo código (P4);
#      proposta_versao não muda quando só o instante da leitura muda (P5) e muda quando a proposta muda (P6)
#   V  a v2 devolve o mesmo conjunto de itens que a v1 (V1)
#   G  gate da v2: authenticated sem capacidade → 42501 (G1); anon → 42501 (G2)
#   E  episódios: 1ª execução marca carga_inicial (E1); item novo depois abre como cron (E2); saída fecha o episódio
#      com os FATOS da releitura (E3); reentrada abre OUTRO episódio (E4); writer não executável por authenticated (E5)
#   D  decisão: registra no episódio aberto (D1); retry da mesma intenção depois de o item sair da fila é reconhecido
#      (D2); tipo×decisão incoerente → 22023 (D3); proposta velha → PB002 (D4); item fora da fila → PB001 (D5); sem
#      capacidade → 42501 (D6); sem uid (cron/serviço) → 42501 (D7); INSERT direto → 42501 (D8); a v2 mostra a decisão
#      vigente (D9); a decisão do episódio anterior NÃO aparece no episódio reaberto (D10)
#   S  a query do sensor (db/sensor-po-a-baixar.sql) conta elegíveis/decididos/confirmados do cenário (S1)
#
# NÃO falsificado aqui (declarado): o advisory lock entre as duas portas — exigiria duas sessões concorrentes.
#
# Uso: bash db/test-reposicao-po-a-baixar-decisao.sh               # suíte
#      bash db/test-reposicao-po-a-baixar-decisao.sh --falsificar  # controle + cada sabotagem tem de ficar vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5891}"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261120100000_reposicao_po_a_baixar_pares_e_decisao.sql"
MIG_V1="$REPO_ROOT/supabase/migrations/20261118150731_reposicao_po_a_baixar.sql"
MIG_OBS="$REPO_ROOT/supabase/migrations/20261005131331_reposicao_po_observado_pelo_motor.sql"
MIG_SOMBRA="$REPO_ROOT/supabase/migrations/20261017040000_recebimento_associacao_sombra.sql"
SENSOR="$REPO_ROOT/db/sensor-po-a-baixar.sql"
TOTAL_ESPERADO=27

# ── --falsificar: controle VERDE na mesma invocação, depois cada sabotagem (uma camada por vez) tem de acusar.
# Formato <nome>:<VERMELHOS>[:<VERDES>]; `ID!MARCA` exige a marca do motivo no vermelho.
SABOTAGENS="pares_sem_frescor:P3:P1 pares_item_errado:P1:P2 fornecedor_qualquer:P4:P1
            versao_com_instante:P5:P6 versao_cega:P6:P5 gate_v2_aberto:G1:G2
            carga_sempre_cron:E1:E2 sem_fechar:E3:E1 reentrada_herda:D10:D9
            decisao_sem_versao:D4:D1 decisao_sem_fila:D5:D1 decisao_cron_decide:D7:D6 retry_sem_atalho:D2:D1
            sensor_confirma_parcial:S1:E3
            pc_writer_publico:I0!writer pc_sem_rls:I0!RLS pc_cron_ausente:I0!cron"
if [ "${1:-}" = "--falsificar" ]; then
  falhas=0
  rodar() {  # <nome> <porta> → as linhas de veredito do filho
    PGPORT_TEST="$2" SABOTAGEM="$1" bash "$0" 2>&1 | grep -E '^(RESUMO|VERDE|VERMELHO|ERRO)' || true
  }
  ctl="$(rodar "" 5892)"
  if ! grep -q "^RESUMO verdes=$TOTAL_ESPERADO vermelhos=0$" <<<"$ctl"; then
    echo "CONTROLE NÃO VERDE — falsificação inválida:"; printf '%s\n' "$ctl"; exit 1
  fi
  echo "controle: $TOTAL_ESPERADO/$TOTAL_ESPERADO verdes"
  porta=5893
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    out="$(rodar "$sab" "$porta")"; porta=$((porta + 1))
    motivo=""
    grep -q '^RESUMO ' <<<"$out" || motivo="$motivo o filho não chegou ao RESUMO (abortou antes de provar);"
    for decl in ${verm//,/ }; do
      id="${decl%%!*}"; marca=""
      [ "$id" = "$decl" ] || marca="${decl#*!}"
      linha_v="$(printf '%s\n' "$out" | grep -m1 "^VERMELHO $id " || true)"
      if [ -z "$linha_v" ]; then motivo="$motivo $id deveria ficar VERMELHO;"
      elif [ -n "$marca" ] && ! grep -qF "$marca" <<<"$linha_v"; then motivo="$motivo $id vermelho sem a marca [$marca];"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -q "^VERDE $id\$" <<<"$out" || motivo="$motivo $id deveria seguir VERDE (linha VERDE ausente);"
    done
    if [ -z "$motivo" ]; then echo "sabotagem $sab: tem dente ($verm)"; else falhas=$((falhas + 1)); echo "sabotagem $sab:$motivo"; printf '%s\n' "$out"; fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "FALSIFICACAO-OK"; exit 0; fi
  echo "FALSIFICACAO REPROVOU: $falhas sabotagem(ns) sem dente"; exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-po-a-baixar-decisao.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q() { Pdb -At -q -c "$1" 2>&1 | tail -n 1; }

trocar() {  # <entrada> <saída> <de> <para> — o padrão tem de ocorrer EXATAMENTE 1x (troca que não pegou é erro)
  python3 - "$@" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(de) != 1:
    sys.exit('padrao ocorre %dx (esperado 1): %r' % (s.count(de), de))
open(dst, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';"
Pdb -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
-- stub da capacidade: em prod é a matriz de autorização; aqui, "tem papel employee"
CREATE OR REPLACE FUNCTION private.cap_compras_ler(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = p_uid AND role = 'employee') $$;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated;
-- pg_cron: cron.schedule por NOME é upsert (1.6.4 em prod); o stub imita isso sobre o cron.job dos stubs
CREATE OR REPLACE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_nome;
  SELECT coalesce(max(jobid), 0) + 1 INTO v FROM cron.job;
  INSERT INTO cron.job (jobid, schedule, command, username, active, jobname) VALUES (v, p_sched, p_cmd, current_user, true, p_nome);
  RETURN v;
END $f$;
-- espelho de POs: só as colunas que as RPCs leem (o pré-voo psql-ro confere os nomes na PROD)
CREATE TABLE IF NOT EXISTS public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  numero_pedido text,
  fornecedor_nome text,
  fornecedor_codigo_omie bigint,
  t4_data_recebimento timestamptz,
  nfe_numero text,
  nid_receb bigint,
  numero_contrato_fornecedor text,
  encerrado_omie_em timestamptz,
  raw_data jsonb
);
CREATE OR REPLACE FUNCTION public._prova(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, 'NULL');
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public._prova(text) TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
INSERT INTO public.user_roles (user_id, role) VALUES ('a0000000-0000-4000-8000-000000000001', 'employee');
SQL
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER ROLE service_role BYPASSRLS;"
# as tabelas-fonte vêm das migrations REAIS (não de cópia), e a v1 também (a v2 convive com ela)
Pdb -q -f "$MIG_OBS" >/dev/null 2>&1
Pdb -q -f "$MIG_SOMBRA" >/dev/null 2>&1
Pdb -q -f "$MIG_V1" >/dev/null 2>&1

verdes=0; vermelhos=0
ok() {  # <id> <esperado> <obtido>
  if [ "$2" = "$3" ]; then verdes=$((verdes + 1)); echo "VERDE $1"; else vermelhos=$((vermelhos + 1)); echo "VERMELHO $1 esperado=[$2] obtido=[$3]"; fi
}

# ── I — a migration (real ou sabotada) aplica e re-aplica ──
MIG_USADA="$MIG"
case "$SABOTAGEM" in
  pc_writer_publico) trocar "$MIG" "$TMPD/m.sql" 'REVOKE ALL ON FUNCTION private.reposicao_po_a_baixar_registrar_episodios(text, text) FROM PUBLIC, anon, authenticated;' 'GRANT EXECUTE ON FUNCTION private.reposicao_po_a_baixar_registrar_episodios(text, text) TO authenticated;' ;;
  pc_sem_rls) trocar "$MIG" "$TMPD/m.sql" 'ALTER TABLE public.reposicao_po_a_baixar_decisao ENABLE ROW LEVEL SECURITY;' '' ;;
  pc_cron_ausente) trocar "$MIG" "$TMPD/m.sql" "SELECT cron.schedule('reposicao-po-a-baixar-episodios', '17 * * * *'," "SELECT cron.schedule('reposicao-po-a-baixar-episodios', '18 * * * *'," ;;
esac
[ -f "$TMPD/m.sql" ] && MIG_USADA="$TMPD/m.sql"
if Pdb -q -f "$MIG_USADA" >"$TMPD/i0.log" 2>&1 && grep -q "POSTCONDICAO OK" "$TMPD/i0.log"; then ok I0 aplicou aplicou; else ok I0 aplicou "falhou: $(grep -m1 -E 'ERRO|EXCEPTION' "$TMPD/i0.log" | cut -c1-400)"; fi
if [ "$MIG_USADA" != "$MIG" ]; then  # sabotagem de postcondição: só o I0 importa
  echo "RESUMO verdes=$verdes vermelhos=$vermelhos"; exit 0
fi
if Pdb -q -f "$MIG" >"$TMPD/i1.log" 2>&1; then ok I1 reaplicou reaplicou; else ok I1 reaplicou falhou; fi

# ── sabotagens de COMPORTAMENTO, aplicadas no banco depois da migration real ──
fn_sabotada() {  # <cabeçalho da função> <de> <para> — recria UMA função com UMA troca
  python3 - "$MIG" "$TMPD/fn.sql" "$1" <<'PY'
import sys
src, dst, cab = sys.argv[1:4]
s = open(src, encoding='utf-8').read()
i = s.index('CREATE OR REPLACE FUNCTION ' + cab)
j = s.index('\n$fn$;', i) + len('\n$fn$;')
open(dst, 'w', encoding='utf-8').write(s[i:j] + '\n')
PY
  trocar "$TMPD/fn.sql" "$TMPD/fn2.sql" "$2" "$3"
  Pdb -q -f "$TMPD/fn2.sql"
}
FILA=private._po_a_baixar_fila
EPI=private.reposicao_po_a_baixar_registrar_episodios
DEC=public.reposicao_po_a_baixar_registrar_decisao
V2=public.reposicao_po_a_baixar_v2
case "$SABOTAGEM" in
  pares_sem_frescor) fn_sabotada "$FILA" "CASE WHEN s.classe = 'associavel' AND s.observado_em >= now() - interval '36 hours' THEN (" "CASE WHEN s.classe IN ('associavel') THEN (" ;;
  pares_item_errado) fn_sabotada "$FILA" "WHERE e.elem ->> 'nCodItem' = pr.par ->> 'nIdItPedido'" 'WHERE true' ;;
  fornecedor_qualquer) fn_sabotada "$FILA" 'ORDER BY pf.omie_codigo_pedido DESC' 'ORDER BY pf.omie_codigo_pedido ASC' ;;
  versao_com_instante) fn_sabotada "$FILA" 'f.f_pares, f.f_unidades, f.f_nfe, f.f_velha)::text)' 'f.f_pares, f.f_unidades, f.f_nfe, f.f_velha, f.f_evid)::text)' ;;
  versao_cega) fn_sabotada "$FILA" 'to_jsonb(f.f_motivos), to_jsonb(f.f_sugeridos),' 'to_jsonb(f.f_sugeridos),' ;;
  gate_v2_aberto) fn_sabotada "$V2" '(SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE' 'false' ;;
  carga_sempre_cron) fn_sabotada "$EPI" "CASE WHEN v_primeira THEN 'carga_inicial' ELSE p_origem END" 'p_origem' ;;
  sem_fechar) fn_sabotada "$EPI" '     SET fechado_em = v_agora' '     SET fechado_em = NULL' ;;
  reentrada_herda) fn_sabotada "$V2" 'AND ep.chave = q.chave AND ep.fechado_em IS NULL' 'AND ep.chave = q.chave' ;;
  decisao_sem_versao) fn_sabotada "$DEC" 'IF v_ep.proposta_versao_atual IS DISTINCT FROM p_proposta_versao THEN' 'IF false THEN' ;;
  decisao_sem_fila) fn_sabotada "$DEC" 'WHERE e.empresa = v_empresa AND e.tipo = p_tipo AND e.chave = p_chave AND e.fechado_em IS NULL;' 'WHERE e.empresa = v_empresa AND e.tipo = p_tipo AND e.chave = p_chave;' ;;
  decisao_cron_decide) fn_sabotada "$DEC" 'IF v_uid IS NULL OR (SELECT private.cap_compras_ler(v_uid)) IS NOT TRUE THEN' 'IF v_uid IS NOT NULL AND (SELECT private.cap_compras_ler(v_uid)) IS NOT TRUE THEN' ;;
  retry_sem_atalho) fn_sabotada "$DEC" 'WHERE d.intencao = p_intencao;
  IF FOUND THEN' 'WHERE d.intencao = p_intencao AND false;
  IF FOUND THEN' ;;
esac
SENSOR_USADO="$SENSOR"
if [ "$SABOTAGEM" = sensor_confirma_parcial ]; then
  trocar "$SENSOR" "$TMPD/sensor.sql" "(ep.decisao_vigente = 'associei' AND ep.desfecho = 'nf_vinculada_completa')" "(ep.decisao_vigente = 'associei' AND ep.desfecho = 'nf_vinculada_parcial')"
  SENSOR_USADO="$TMPD/sensor.sql"
fi

# ── fixtures ──
Pdb -q <<'SQL'
INSERT INTO public.reposicao_po_observado_run (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate, filtros,
  varredura_completa, pendente_aplicado, skus_divergentes, pedidos_lidos, versao_edge) VALUES
 ('00000000-0000-4000-8000-0000000000a2', 'OBEN', now() - interval '1 hour', now() - interval '1 hour', '2026-01-01', '2027-01-01', '{}', true, true, 0, 2, 'v');
INSERT INTO public.reposicao_po_observado_item (run_id, omie_codigo_pedido, seq_item, numero_pedido, etapa, sku_codigo_omie, quantidade, quantidade_recebida, contribuicao, exclusao) VALUES
 ('00000000-0000-4000-8000-0000000000a2', 10, 1, '1010', '15', 1, 3, 0, 3, NULL);
INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido, numero_pedido, fornecedor_nome, fornecedor_codigo_omie, t4_data_recebimento, nfe_numero, nid_receb, numero_contrato_fornecedor, encerrado_omie_em, raw_data) VALUES
 ('OBEN', 10, '1010', 'Sayerlack', 77, now() - interval '3 days', '000111', 7001, 'C10', NULL, NULL),
 ('OBEN', 21, '1021', 'Sayerlack Antiga', 77, NULL, NULL, NULL, 'C21', NULL,
  '{"produtos_consulta":[{"nCodItem":2100,"cProduto":"PRD1","cDescricao":"A"},{"nCodItem":2101,"cProduto":"PRD9","cDescricao":"BASE X"}]}'),
 ('OBEN', 22, '1022', 'RENNER SAYERLACK', 77, NULL, NULL, NULL, 'C22', NULL, NULL),
 ('COLACOR', 99, '9999', 'Outro', 88, NULL, NULL, NULL, 'C21', NULL, NULL);
INSERT INTO public.recebimento_associacao_sombra (empresa, nid_receb, numero_nfe, fornecedor_codigo_omie, estado_nf, vinculo, classe, motivos, contratos, pares, pedidos, versao_classificador, observado_em) VALUES
 ('OBEN', 8001, '000801', 77, 'pendente', 'nenhum', 'ambigua', ARRAY['quantidade_menor_que_saldo'], ARRAY['C21'], '[]', '[]', 'v', now() - interval '2 hours'),
 ('OBEN', 8003, '000803', 77, 'pendente', 'nenhum', 'orfa', ARRAY['item_sem_contrato'], ARRAY[]::text[], '[]', '[]', 'v', now() - interval '5 days'),
 ('OBEN', 8005, '000805', 77, 'pendente', 'nenhum', 'associavel', ARRAY[]::text[], ARRAY['C21'],
  '[{"nSequencia":1,"nIdPedido":21,"nIdItPedido":2101,"quantidade":2,"unidade":"UN"}]',
  '[{"nIdPedido":21,"numero_pedido":"1021","cobertura":"parcial"}]', 'v', now() - interval '30 minutes'),
 ('OBEN', 8006, '000806', 77, 'pendente', 'nenhum', 'associavel', ARRAY[]::text[], ARRAY['C21'],
  '[{"nSequencia":1,"nIdPedido":21,"nIdItPedido":2101,"quantidade":1,"unidade":"UN"}]',
  '[{"nIdPedido":21,"numero_pedido":"1021","cobertura":"parcial"}]', 'v', now() - interval '3 days');
SQL

V2Q="SET ROLE service_role; SELECT public._prova(\$q\$SELECT string_agg(%s, ';' ORDER BY 1) FROM public.reposicao_po_a_baixar_v2('OBEN') %s\$q\$);"
# shellcheck disable=SC2059  # V2Q é o molde de propósito
v2() { Q "$(printf "$V2Q" "$1" "$2")"; }
A="a0000000-0000-4000-8000-000000000001"   # tem cap_compras_ler
B="a0000000-0000-4000-8000-0000000000ff"   # não tem
decidir() {  # <uid|vazio> <tipo> <chave> <decisao> <proposta_versao> <intencao>
  local papel="SET ROLE authenticated; SET test.uid = '$1';"
  [ -n "$1" ] || papel="SET ROLE service_role;"
  Q "$papel SELECT public._prova(\$q\$SELECT (public.reposicao_po_a_baixar_registrar_decisao('OBEN', '$2', '$3', '$4', '$5', '$6'::uuid) ->> 'ja_registrada')\$q\$);"
}
episodios() { Q "SELECT private.reposicao_po_a_baixar_registrar_episodios('OBEN', 'cron')::text;" >/dev/null; }

# ── P — pares e proposta ──
ok P1 "1|1021|2|PRD9|BASE X|2|UN|parcial" "$(v2 "(pares->0->>'seq_nf')||'|'||(pares->0->>'numero_pedido')||'|'||(pares->0->>'item_po')||'|'||(pares->0->>'codigo_produto')||'|'||(pares->0->>'descricao')||'|'||(pares->0->>'quantidade')||'|'||(pares->0->>'unidade')||'|'||(pares->0->>'cobertura')" "WHERE chave='8005'")"
ok P2 "ERA_NULL" "$(v2 "coalesce(pares::text, 'ERA_NULL')" "WHERE chave='8001'")"
ok P3 "ERA_NULL" "$(v2 "coalesce(pares::text, 'ERA_NULL')" "WHERE chave='8006'")"
ok P4 "RENNER SAYERLACK" "$(v2 "fornecedor_nome" "WHERE chave='8005'")"
antes="$(v2 "proposta_versao" "WHERE chave='8005'")"
Pdb -q -c "UPDATE public.recebimento_associacao_sombra SET observado_em = now() - interval '10 minutes' WHERE nid_receb = 8005;"
depois="$(v2 "proposta_versao" "WHERE chave='8005'")"
ok P5 igual "$([ -n "$antes" ] && [ "$antes" = "$depois" ] && echo igual || echo "mudou:$antes/$depois")"
antes="$(v2 "proposta_versao" "WHERE chave='8001'")"
Pdb -q -c "UPDATE public.recebimento_associacao_sombra SET motivos = ARRAY['quantidade_menor_que_saldo','item_sem_par'] WHERE nid_receb = 8001;"
depois="$(v2 "proposta_versao" "WHERE chave='8001'")"
ok P6 mudou "$([ -n "$antes" ] && [ "$antes" != "$depois" ] && echo mudou || echo "igual:$antes")"

# ── V — a v2 cobre o mesmo conjunto da v1 ──
k1="$(Q "SET ROLE service_role; SELECT string_agg(tipo||':'||coalesce(omie_codigo_pedido::text,'')||':'||coalesce(nid_receb::text,''), ',' ORDER BY 1) FROM public.reposicao_po_a_baixar('OBEN');")"
k2="$(Q "SET ROLE service_role; SELECT string_agg(tipo||':'||coalesce(omie_codigo_pedido::text,'')||':'||coalesce(nid_receb::text,''), ',' ORDER BY 1) FROM public.reposicao_po_a_baixar_v2('OBEN');")"
ok V1 "$k1" "$([ -n "$k2" ] && echo "$k2" || echo VAZIO)"

# ── G — gate da v2 ──
ok G1 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SET test.uid = '$B'; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar_v2('OBEN')\$q\$);")"
ok G2 SQLSTATE:42501 "$(Q "SET ROLE anon; SELECT public._prova(\$q\$SELECT count(*)::text FROM public.reposicao_po_a_baixar_v2('OBEN')\$q\$);")"

# ── E — 1ª execução: tudo o que está na fila vira carga_inicial ──
episodios
ok E1 "5|5" "$(Q "SELECT (SELECT count(*) FROM public.reposicao_po_a_baixar_episodio WHERE origem = 'carga_inicial' AND fechado_em IS NULL)||'|'||(SELECT count(*) FROM public.reposicao_po_a_baixar_v2('OBEN'));")"
ok E5 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SET test.uid = '$A'; SELECT public._prova(\$q\$SELECT private.reposicao_po_a_baixar_registrar_episodios('OBEN', 'cron')::text\$q\$);")"

# ── D — decisões ──
pv8005="$(v2 "proposta_versao" "WHERE chave='8005'")"
ok D1 false "$(decidir "$A" nf_pendente 8005 associei "$pv8005" '11111111-1111-4111-8111-111111111111')"
ok D3 SQLSTATE:22023 "$(decidir "$A" nf_pendente 8005 encerrei "$pv8005" '22222222-2222-4222-8222-222222222222')"
ok D4 SQLSTATE:PB002 "$(decidir "$A" nf_pendente 8005 associei "deadbeef" '33333333-3333-4333-8333-333333333333')"
ok D6 SQLSTATE:42501 "$(decidir "$B" nf_pendente 8005 associei "$pv8005" '44444444-4444-4444-8444-444444444444')"
ok D7 SQLSTATE:42501 "$(decidir "" nf_pendente 8005 associei "$pv8005" '55555555-5555-4555-8555-555555555555')"
ok D8 SQLSTATE:42501 "$(Q "SET ROLE authenticated; SET test.uid = '$A'; SELECT public._prova(\$q\$INSERT INTO public.reposicao_po_a_baixar_decisao (intencao, episodio_id, empresa, tipo, chave, decisao, operador, proposta_versao, evidencia_desatualizada) SELECT gen_random_uuid(), id, empresa, tipo, chave, 'associei', '$A', 'x', false FROM public.reposicao_po_a_baixar_episodio LIMIT 1 RETURNING 'inseriu'\$q\$);")"
ok D9 associei "$(v2 "coalesce(decisao_vigente, 'ERA_NULL')" "WHERE chave='8005'")"

# ── a NF 8005 é concluída no Omie com vínculo completo; uma NF nova (8007) entra na fila ──
Pdb -q <<'SQL'
UPDATE public.recebimento_associacao_sombra
   SET estado_nf = 'concluida', vinculo = 'completo', classe = 'fora_de_alcance', motivos = ARRAY['ja_vinculada_no_omie'], pares = '[]', pedidos = '[]', observado_em = now()
 WHERE nid_receb = 8005;
INSERT INTO public.recebimento_associacao_sombra (empresa, nid_receb, numero_nfe, fornecedor_codigo_omie, estado_nf, vinculo, classe, motivos, contratos, pares, pedidos, versao_classificador, observado_em)
VALUES ('OBEN', 8007, '000807', 77, 'pendente', 'nenhum', 'orfa', ARRAY['item_sem_contrato'], ARRAY[]::text[], '[]', '[]', 'v', now());
SQL
episodios
ok E2 cron "$(Q "SELECT string_agg(origem, ',') FROM public.reposicao_po_a_baixar_episodio WHERE chave = '8007';")"
ok E3 "fechado|concluida|completo|fora_de_alcance" "$(Q "SELECT CASE WHEN fechado_em IS NOT NULL THEN 'fechado' ELSE 'aberto' END||'|'||coalesce(desfecho_estado_nf,'ERA_NULL')||'|'||coalesce(desfecho_vinculo,'ERA_NULL')||'|'||coalesce(desfecho_classe,'ERA_NULL') FROM public.reposicao_po_a_baixar_episodio WHERE chave = '8005';")"
ok D5 SQLSTATE:PB001 "$(decidir "$A" nf_pendente 8005 nao_se_aplica "$pv8005" '66666666-6666-4666-8666-666666666666')"
ok D2 true "$(decidir "$A" nf_pendente 8005 associei "$pv8005" '11111111-1111-4111-8111-111111111111')"

# ── S — a query do sensor sobre este cenário ──
# carga_inicial das NFs: 8001 (fresca), 8003 (velha), 8005 (fresca, decidida e confirmada), 8006 (velha) → 4 elegíveis,
# 2 frescas, 3 em aberto, 1 decidida, 1 declarada resolvida, 1 verificável, 1 confirmada, concordância 1.000
if Pdb -At -F '|' -f "$SENSOR_USADO" >"$TMPD/sensor.out" 2>&1 && grep -q '^SENSOR-PO-A-BAIXAR-EXECUTOU$' "$TMPD/sensor.out"; then
  ok S1 "OBEN|nf_pendente|carga_inicial|4|2|3|1|1|1|1|1.000" "$(grep -m1 '^OBEN|nf_pendente|carga_inicial|' "$TMPD/sensor.out" | cut -d'|' -f1-11)"
else
  ok S1 executou "falhou: $(grep -m1 -E 'ERRO|ERROR' "$TMPD/sensor.out" | cut -c1-300)"
fi

# ── a NF 8005 volta a pendente (reentrada) ──
Pdb -q -c "UPDATE public.recebimento_associacao_sombra SET estado_nf = 'pendente', vinculo = 'nenhum', classe = 'associavel', motivos = ARRAY[]::text[], pares = '[{\"nSequencia\":1,\"nIdPedido\":21,\"nIdItPedido\":2101,\"quantidade\":2,\"unidade\":\"UN\"}]', pedidos = '[{\"nIdPedido\":21,\"numero_pedido\":\"1021\",\"cobertura\":\"parcial\"}]', observado_em = now() WHERE nid_receb = 8005;"
episodios
ok E4 "2|1" "$(Q "SELECT count(*)||'|'||count(*) FILTER (WHERE fechado_em IS NULL) FROM public.reposicao_po_a_baixar_episodio WHERE chave = '8005';")"
ok D10 ERA_NULL "$(v2 "coalesce(decisao_vigente, 'ERA_NULL')" "WHERE chave='8005'")"

total=$((verdes + vermelhos))
if [ "$total" -ne "$TOTAL_ESPERADO" ]; then echo "ERRO asserts=$total esperado=$TOTAL_ESPERADO"; vermelhos=$((vermelhos + 1)); fi
echo "RESUMO verdes=$verdes vermelhos=$vermelhos"
echo "PASS=$verdes  FAIL=$vermelhos"
[ "$vermelhos" -eq 0 ] && echo "PROVA-PO-A-BAIXAR-DECISAO-OK"
[ "$vermelhos" -eq 0 ]

#!/usr/bin/env bash
# Prova PG17 — calendário de operação (Etapa 1, Task 4): o RECESSO (empresa fechada 18/12/2026 → 03/01/2027, sem
# receber mercadoria) NÃO faz o motor recomprar um pedido que já está a caminho.
# Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §6.3 item 2.
#
# O "a caminho" do motor (gerar_pedidos_sugeridos_ciclo, viva em 20261101090000) tem DUAS parcelas:
#   · CTE em_transito — pedido do app; o 1º ramo corta em data_ciclo >= p_data_ciclo − 7 dias;
#   · sku_estoque_atual.estoque_pendente_entrada — o PO ABERTO no Omie (omie-sync-estoque, PesquisarPedCompra,
#     etapa 15, nQtde − nQtdeRec, janela de PREVISÃO hoje−365..hoje+120). O sync DE-DUPA o pedido do app com
#     data_ciclo >= hoje−7 (o em_transito já o conta) — depois de 7 dias, o pedido passa do em_transito para o pendente.
# Pedido disparado em 10/12/2026 e ciclo em 04/01/2027 (1º dia de volta): o em_transito já o largou; quem segura a
# recompra é o pendente Omie (PO aberto persiste — medido em prod, ver o relatório da Task 4).
#
# Casos (1 SKU por caso, idênticos EXCETO o pendente Omie):
#   C1  9701 pendente Omie = 4 (o PO aberto)        → ciclo 04/01: NENHUMA sugestão (não recompra).
#   C2  9702 pendente Omie = 0 (o sync falhou)      → ciclo 04/01: SUGERE 4 — recompra CONHECIDA (documenta o hoje;
#       se alguém mudar o motor — p.ex. tirar o corte de 7 dias — este assert acusa e a decisão volta à mesa).
#   B1  9702 no ciclo 17/12 (D+7): ainda no em_transito → AUSENTE.  B2  9702 no ciclo 18/12 (D+8): saiu → SUGERE 4.
#
# Rodar:  bash db/test-calendario-acaminho-recesso.sh > log 2>&1; echo "exit=$?"   (NÃO pipe pra tail — engole o exit)
#         LOCALE_TESTE=pt_BR.UTF-8 bash db/test-calendario-acaminho-recesso.sh       (o 2º idioma — money-path.md)
#         bash db/test-calendario-acaminho-recesso.sh --falsificar                   (controle verde + 1 camada por vez)
# Lei de Ferro: aplica a MIGRATION REAL do motor; asserts por valor; RPC que não retorna sucesso é RED (sem isso o
# AUSENTE do C1 ficaria verde com o motor morto). Sentinelas ASCII, caixa fixa.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261101090000_reposicao_compra_suspensa.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="pendente_zero_fixture:C1_COM_PENDENTE_NAO_RECOMPRA motor_ignora_pendente:C1_COM_PENDENTE_NAO_RECOMPRA
    janela_sem_corte:C2_SEM_PENDENTE_RECOMPRA_CONHECIDA janela_6_dias:B1_D7_AINDA_EM_TRANSITO
    janela_8_dias:B2_D8_SAI_DO_EM_TRANSITO sem_disparado_na_lista:B1_D7_AINDA_EM_TRANSITO
    rpc_aborta:RPC_CICLO_OK"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-calendario-acaminho-recesso.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "controle VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK calendario-acaminho-recesso" "$LOGDIR/controle.log" || { echo "controle sem marcador de fim"; exit 1; }
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
    if grep -qF -- "FAIL $a " "$LOGDIR/$s.log"; then
      echo "OK $s: vermelha em [FAIL $a]"
    else
      echo "FALHA $s: vermelha, mas NAO no assert esperado [FAIL $a] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5662}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-calendario-acaminho-recesso.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
RPC_ERR="$(dirname "$DATA")/rpc.err"
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY' || exit 2
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
PEND_C1=4             # o PO aberto no Omie, refletido pelo sync (C1)
RPC_PGOPTIONS=""
JANELA="AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days')"
case "${SABOTAGEM:-}" in
  "") ;;
  # fixture: o pendente Omie do C1 some (= o C2) → o C1 TEM de recomprar
  pendente_zero_fixture)  PEND_C1=0 ;;
  # motor: deixa de somar o pendente Omie em TODO caminho (grupo e avulso)
  motor_ignora_pendente)  sabotar "COALESCE(sea.estoque_pendente_entrada, 0)" "0" ;;
  # motor: em_transito sem corte de data → o C2 deixa de recomprar (a mudança que o C2 tem de acusar)
  janela_sem_corte)       sabotar "$JANELA" "AND true" ;;
  janela_6_dias)          sabotar "$JANELA" "AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '6 days')" ;;
  janela_8_dias)          sabotar "$JANELA" "AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '8 days')" ;;
  sem_disparado_na_lista) sabotar "('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo" \
                                  "('aprovado_aguardando_disparo','disparado_simulado','concluido_recebido') AND pcs2.data_ciclo" ;;
  # a RPC aborta (sessão read-only → 25006 no 1º UPDATE): o guard do run_ciclo TEM de pintar RED
  rpc_aborta)             RPC_PGOPTIONS="-c default_transaction_read_only=on" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null || { echo "initdb falhou"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null || { echo "pg_ctl falhou"; exit 1; }
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

echo "=== setup PG17 :$PORT locale=$LOC ==="
# ── ZONA 1: roles/schemas + stubs que a MIGRATION exige (espelho do db/test-compra-suspensa-motor.sh) ──
P -q <<'SQL' || { echo "stubs falharam"; exit 1; }
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE ROLE authenticator LOGIN NOINHERIT; GRANT authenticated TO authenticator; GRANT anon TO authenticator;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE SCHEMA private;
CREATE FUNCTION private.cap_compras_ler(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT true $$;
CREATE FUNCTION private.cap_compras_escrever(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid), private.cap_compras_escrever(uuid) TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
CREATE FUNCTION public._fin_estoque_account(p_company text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE v text; BEGIN
  v := CASE lower(trim(p_company)) WHEN 'oben' THEN 'vendas' WHEN 'colacor' THEN 'colacor_vendas' WHEN 'colacor_sc' THEN 'servicos' END;
  IF v IS NULL THEN RAISE EXCEPTION 'empresa invalida: %', p_company USING ERRCODE = 'P0001'; END IF;
  RETURN v; END $$;
CREATE FUNCTION public._fin_estoque_classe(p_tipo text, p_familia text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN lower(trim(p_familia)) IN ('uso e consumo','imobilizado') THEN 'fora_giro'
              WHEN nullif(trim(p_tipo), '') IS NULL THEN 'sem_classificacao'
              WHEN trim(p_tipo) IN ('07','08','09','99') THEN 'fora_giro' ELSE 'giro' END $$;

CREATE TABLE public.sku_parametros (empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_nome text,
  ponto_pedido numeric, estoque_maximo numeric, minimo_forcado_manual numeric,
  habilitado_reposicao_automatica boolean, tipo_reposicao text,
  demanda_media_diaria numeric, classe_abc character(1), classe_forcada text, valor_vendido_90d numeric);
CREATE TABLE public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_pendente_entrada numeric, fonte_sync text);
CREATE TABLE public.sku_embalagem_equivalencia (empresa text, grupo_id uuid, sku_codigo_omie text, fator_para_base numeric, ativo boolean,
  unidades_omie_por_embalagem numeric);
CREATE TABLE public.sku_preco_fornecedor_capturado (empresa text, sku_codigo_omie text, preco numeric, status text, capturado_em timestamptz);
CREATE TABLE public.sku_fornecedor_externo (empresa text, fornecedor_nome text, sku_omie text, sku_portal text, ativo boolean,
  fator_conversao numeric NOT NULL DEFAULT 1);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, saldo numeric DEFAULT 0, cmc numeric, synced_at timestamptz);
CREATE TABLE public.company_config (key text UNIQUE, value text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), items jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'rascunho', account text NOT NULL DEFAULT 'oben', hash_payload text, omie_numero_pedido text,
  omie_reconciliado_em timestamptz, deleted_at timestamptz);
CREATE TABLE public.omie_products (omie_codigo_produto bigint, account text, descricao text, familia text, ativo boolean, tipo_produto text, metadata jsonb DEFAULT '{}');
CREATE TABLE public.sku_grupo_producao (empresa text, sku_codigo_omie text, grupo_codigo text);
CREATE TABLE public.sku_leadtime_history (empresa text, sku_codigo_omie text, quantidade_recebida numeric, valor_total numeric);
CREATE VIEW public.v_sku_leadtime_efetivo AS
  SELECT empresa, sku_codigo_omie, quantidade_recebida, valor_total FROM public.sku_leadtime_history;
CREATE TABLE public.reposicao_motor_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL, empresa text NOT NULL, data_ciclo date NOT NULL,
  pedidos_gerados integer NOT NULL DEFAULT 0, skus_incluidos integer NOT NULL DEFAULT 0,
  suprimidos_n integer NOT NULL DEFAULT 0, capados_n integer NOT NULL DEFAULT 0, criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, horario_corte_pedido interval, valor_maximo_mensal numeric, delta_max_perc numeric, lt_logistica_dias int);
CREATE TABLE public.familia_nao_comprada (id bigserial PRIMARY KEY, empresa text, familia text);
CREATE TABLE public.sku_status_omie (empresa text, sku_codigo_omie text, ativo_no_omie boolean);
CREATE TABLE public.pedido_compra_sugerido (id bigserial PRIMARY KEY, empresa text, fornecedor_nome text, grupo_codigo text,
  data_ciclo date, horario_corte_planejado timestamptz, valor_total numeric NOT NULL DEFAULT 0, num_skus int, status text,
  condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas int, dias_parcelas text, condicao_origem text,
  tipo_ciclo text, status_envio_portal text, portal_protocolo text, omie_pedido_compra_numero text, atualizado_em timestamptz);
CREATE TABLE public.pedido_compra_item (id bigserial PRIMARY KEY, pedido_id bigint REFERENCES pedido_compra_sugerido(id) ON DELETE CASCADE,
  sku_codigo_omie text, sku_descricao text, estoque_atual numeric, ponto_pedido numeric, estoque_maximo numeric,
  qtde_sugerida numeric, qtde_final numeric, preco_unitario numeric, valor_linha numeric, primeira_compra boolean,
  estoque_fisico numeric, estoque_a_caminho numeric, fator_embalagem_portal numeric, qtde_sem_teto numeric,
  teto_cobertura_aplicado boolean, estoque_comprometido numeric);
CREATE TABLE public.reposicao_estoque_nao_confirmado_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, motivo text, estoque_efetivo numeric, ponto_pedido numeric, fonte_sync text);
CREATE TABLE public.reposicao_teto_cobertura_log (id uuid DEFAULT gen_random_uuid(), run_id uuid, criado_em timestamptz DEFAULT now(),
  empresa text, sku_codigo_omie text, sku_descricao text, grupo_codigo text, classe_abc text, teto_dias numeric, demanda_diaria numeric,
  estoque_efetivo numeric, ponto_pedido numeric, estoque_maximo numeric, cap_teto_ancora numeric, qtde_sem_teto numeric, qtde_final numeric, motivo text);
CREATE TABLE public.venda_items_history (empresa text, data_emissao date);
CREATE TABLE public.v_sku_demanda_efetiva (empresa text, sku_codigo_omie bigint, quantidade numeric, data_emissao date);
CREATE TABLE public.sku_substituicao (id bigserial, empresa text, sku_codigo_antigo text, sku_codigo_novo text, acao_parametros text, status text);
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
SQL

# ── ZONA 2: a MIGRATION REAL do motor (cópia; sabotada só sob SABOTAGEM) ──
P -q -f "$MIG_USADA" >/dev/null || { echo "migration do motor falhou"; exit 1; }
eq "AMIG motor instalado" "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='gerar_pedidos_sugeridos_ciclo'")" "1"

# ── ZONA 3: seeds — 2 SKUs Sayerlack idênticos EXCETO o pendente Omie ──
# Desenho: pp=3, max=5, físico=1, pedido disparado em 10/12 com qtde_final=4 e nº Omie.
#   a caminho conta → efetivo 1+4=5 > pp 3 → AUSENTE;  não conta → efetivo 1 <= 3 → SUGERE ceil(5−1)=4.
# Classe A: fora do teto de cobertura (isola a variável testada). fonte_sync confirmada.
P -q <<SQL || { echo "seeds falharam"; exit 1; }
INSERT INTO omie_products (omie_codigo_produto, account, descricao, familia, ativo, tipo_produto) VALUES
 (9701,'oben','C1 COM PENDENTE OMIE','Tintas',true,'00'),
 (9702,'oben','C2 SEM PENDENTE OMIE','Tintas',true,'00');
INSERT INTO fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido, lt_logistica_dias) VALUES
 ('OBEN','Sayerlack', interval '18:00:00', 7);
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
                            minimo_forcado_manual, habilitado_reposicao_automatica, tipo_reposicao,
                            demanda_media_diaria, classe_abc, classe_forcada, valor_vendido_90d)
SELECT 'OBEN', g, 'S'||g, 'Sayerlack', 3, 5, NULL, true, 'automatica', 0.5, 'A', NULL, NULL FROM generate_series(9701,9702) g;
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync) VALUES
 ('OBEN','9701',1,${PEND_C1},'ListarPosEstoque'),
 ('OBEN','9702',1,0,'ListarPosEstoque');
-- o pedido do recesso: disparado em 10/12/2026 (antes do recesso), aceito no portal e com nº no Omie, ainda não recebido
INSERT INTO pedido_compra_sugerido (id, empresa, fornecedor_nome, data_ciclo, status, status_envio_portal, portal_protocolo,
                                    omie_pedido_compra_numero, tipo_ciclo) VALUES
 (1,'OBEN','Sayerlack','2026-12-10','disparado','sucesso_portal','PROTO-REC','1400','normal');
SELECT setval(pg_get_serial_sequence('pedido_compra_sugerido','id'), 100);
INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_final) VALUES (1,'9701','C1',4),(1,'9702','C2',4);
SQL
echo "seeds ok (pendente Omie do C1 = $PEND_C1)"

# Roda o ciclo e FALHA o assert se a RPC não retornou sucesso (rc 0 E um inteiro no stdout) — sem isto um motor que
# aborta deixa todo qf em AUSENTE e o C1 VERDE por omissão.
run_ciclo() {
  local out rc
  out="$(PGOPTIONS="$RPC_PGOPTIONS" Pq -c "SELECT (gerar_pedidos_sugeridos_ciclo('OBEN','$1')).skus_incluidos" 2>"$RPC_ERR")"; rc=$?
  if [ "$rc" -ne 0 ] || ! [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "FAIL RPC_CICLO_OK ciclo=$1 — rc=$rc out=[$out]: $(head -c 200 "$RPC_ERR")"; FAIL=$((FAIL+1)); return 1
  fi
  echo "PASS RPC_CICLO_OK ciclo=$1 (skus_incluidos=$out)"; PASS=$((PASS+1))
}
# qtde_final sugerida para o SKU no ciclo (pedido recém-gerado = pendente_aprovacao), ou AUSENTE
qf() { Pq -c "SELECT COALESCE((SELECT pci.qtde_final::text FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id WHERE pcs.empresa='OBEN' AND pcs.data_ciclo='$1' AND pci.sku_codigo_omie='$2' AND pcs.status='pendente_aprovacao'), 'AUSENTE')"; }

echo "=== B: a fronteira dos 7 dias do em_transito (C2 = sem pendente Omie: só o em_transito segura) ==="
run_ciclo 2026-12-17
eq "B1_D7_AINDA_EM_TRANSITO 17/12 (D+7): o pedido de 10/12 ainda segura o 9702" "$(qf 2026-12-17 9702)" "AUSENTE"
run_ciclo 2026-12-18
eq "B2_D8_SAI_DO_EM_TRANSITO 18/12 (D+8, 1o dia do recesso): sem pendente Omie o 9702 e recomprado" "$(qf 2026-12-18 9702)" "4"

echo "=== C: ciclo de 04/01/2027 (volta do recesso), pedido disparado em 10/12 ainda nao recebido ==="
run_ciclo 2027-01-04
eq "C1_COM_PENDENTE_NAO_RECOMPRA 9701 (PO aberto no Omie -> pendente 4): nenhuma sugestao" "$(qf 2027-01-04 9701)" "AUSENTE"
eq "C2_SEM_PENDENTE_RECOMPRA_CONHECIDA 9702 (sync sem o PO): recompra 4 — comportamento atual documentado" "$(qf 2027-01-04 9702)" "4"
eq "C3_PEDIDO_ORIGINAL_INTACTO o pedido de 10/12 segue disparado (o ciclo nao o expira)" \
   "$(Pq -c "SELECT status FROM pedido_compra_sugerido WHERE id=1")" "disparado"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK calendario-acaminho-recesso"

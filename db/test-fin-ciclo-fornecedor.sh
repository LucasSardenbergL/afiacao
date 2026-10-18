#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261018150000_fin_ciclo_fornecedor (frente 4 do ciclo)         ║
# ║  v_titulo_encargos_cp · v_ciclo_cp_titulos · v_ciclo_fornecedor_resumo · RPCs ║
# ║      bash db/test-fin-ciclo-fornecedor.sh > logs/t.log 2>&1; echo "exit=$?"   ║
# ║  LOCALE=pt_BR.UTF-8 bash db/test-fin-ciclo-fornecedor.sh  (2º ambiente)       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# Spec: docs/superpowers/specs/2026-10-18-ciclo-pmp-fornecedor-design.md (§9 prevalece).
# Controle verde na MESMA invocação + 1 sabotagem por camada, sobre CÓPIA da migration (o repo nunca
# é tocado). Asserções em ASCII, caixa fixa, sem -i.
#
# Escolhas do preparo (espelham prod só no que a prova exige):
#  - fin_movimentacoes com as colunas resumo_* da 20261013094000 (só as que as views leem).
#  - v_titulo_baixas é TABELA stub: a frente 4 só a lê no controle do engine (fórmula do
#    v_capital_giro_prazos); o PMP de compras NÃO a usa (spec §9 #6).
#  - purchase_orders_tracking.empresa é o enum empresa_reposicao em MAIÚSCULAS, como em prod.
#  - fin_user_can_access / user_roles / sessão simulada: idênticos ao db/test-fin-ciclo-rpc.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5476}"
SLUG="fin-ciclo-fornecedor"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
LOC="${LOCALE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
MIG="$REPO_ROOT/supabase/migrations/20261018150000_fin_ciclo_fornecedor.sql"

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
CREATE TABLE public.fin_contas_pagar (
  company text, omie_codigo_lancamento bigint, omie_codigo_cliente_fornecedor bigint,
  nome_fornecedor text, numero_documento text, numero_documento_fiscal text,
  data_emissao date, data_vencimento date, valor_documento numeric, saldo numeric,
  status_titulo text, categoria_codigo text);
CREATE TABLE public.fin_movimentacoes (
  id uuid DEFAULT gen_random_uuid(), company text, omie_ncodcc bigint, data_movimento date,
  tipo text, valor numeric, categoria_descricao text, natureza text, omie_codigo_lancamento bigint,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  resumo_val_pago numeric(15,2), resumo_val_liquido numeric(15,2), resumo_desconto numeric(15,2),
  resumo_juros numeric(15,2), resumo_multa numeric(15,2), resumo_val_aberto numeric(15,2),
  resumo_liquidado boolean, valor_titulo numeric(15,2), tipo_documento text, omie_ncodbaixa bigint,
  data_pagamento_omie date, data_credito_omie date, resumo_lido_em timestamptz);
CREATE TABLE public.v_titulo_baixas (
  company text, omie_codigo_lancamento bigint, tipo text, data_baixa_final date,
  valor_baixado numeric, n_movimentos integer, prazo_ponderado_dias numeric, origem_baixa text);
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.purchase_orders_tracking (empresa public.empresa_reposicao, fornecedor_codigo_omie bigint, fornecedor_nome text);
CREATE TABLE public.omie_clientes_nao_vinculados (empresa text, omie_codigo_cliente bigint, razao_social text, nome_fantasia text);
CREATE TABLE public.fornecedor_omie_cache (empresa text, omie_codigo_cliente_fornecedor bigint, razao_social_omie text);
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.fin_permissoes_stub (user_id uuid, empresas text[]);

CREATE FUNCTION public.fin_user_can_access(check_company text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p
                  WHERE p.user_id = auth.uid() AND check_company = ANY (p.empresas))
      OR (EXISTS (SELECT 1 FROM public.user_roles r
                   WHERE r.user_id = auth.uid() AND r.role IN ('master','employee'))
          AND NOT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid()))
$$;

-- Gate da 20261015003200 (já em prod; a frente 4 o REUSA, não o recria).
CREATE FUNCTION public._fin_ciclo_gate_master() RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'CICLO_SO_MASTER' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._fin_ciclo_gate_master() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.t_lanca(q text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE q;
  RETURN 'NAO-LANCOU';
EXCEPTION WHEN SQLSTATE '42501' THEN
  RETURN '42501|' || SQLERRM;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- Como o Supabase: tabelas legíveis por authenticated (a RLS real fica fora da prova).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.fin_permissoes_stub VALUES ('33333333-3333-3333-3333-333333333333', ARRAY['oben']);

DO $f$
DECLARE h date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  -- ── T1: encargos por título (oben, fornecedor 900, compras 2.01.01) ─────────────────────
  -- 1001: o 12182935508 sintético — versão velha da baixa SEM nCodBaixa (cheia) + atual COM
  --       nCodBaixa (98%). Conteúdos diferentes → nenhuma elimina a outra → divergente.
  INSERT INTO fin_contas_pagar VALUES
    ('oben',1001,900,'','000949673/1','000949673',h-41,h-30,17261.40,17261.40,'PAGO','2.01.01'),
    ('oben',1002,900,'','000950001/1','000950001',h-51,h-40,5958.04,5958.04,'PAGO','2.01.01'),
    ('oben',1003,900,'','000950002/1','000950002',h-61,h-50,1000,1000,'PAGO','2.01.01'),
    ('oben',1004,900,'','000950003/1','000950003',h-21,h-10,500,500,'ATRASADO','2.01.01');
  INSERT INTO fin_movimentacoes (company, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, natureza,
      omie_codigo_lancamento, updated_at, resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros,
      resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, omie_ncodbaixa, data_pagamento_omie, resumo_lido_em) VALUES
    ('oben',77,h-41,'S',0,'CONTA_A_PAGAR','COMP',1001,now()-interval '9 day',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('oben',77,h-30,'S',17261.40,'CONTA_A_PAGAR','COMP',1001,now()-interval '1 day',17261.40,16916.17,345.23,0,0,0,true,17261.40,NULL,h-30,now()),
    ('oben',77,h-31,'S',17261.40,'CONTA_CORRENTE_PAG','BAXP',1001,now()-interval '5 day',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('oben',77,h-30,'S',16916.17,'CONTA_CORRENTE_PAG','BAXP',1001,now()-interval '1 day',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,555,NULL,now()),
    -- 1002: em dia, 98%, caixa batendo → alta. Liquidação CC em D+1 (não decide atraso).
    ('oben',77,h-40,'S',5958.04,'CONTA_A_PAGAR','COMP',1002,now(),5958.04,5838.88,119.16,0,0,0,true,5958.04,NULL,h-40,now()),
    ('oben',77,h-39,'S',5838.88,'CONTA_CORRENTE_PAG','BAXP',1002,now(),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,556,NULL,now()),
    -- 1003: resumo NUNCA lido (NULL) → desconto NULL, nunca 0.
    ('oben',77,h-50,'S',1000,'CONTA_A_PAGAR','COMP',1003,now(),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
    ('oben',77,h-50,'S',1000,'CONTA_CORRENTE_PAG','BAXP',1003,now(),NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,557,NULL,now()),
    -- 1004: ATRASADO com resumo lido: nada pago, 500 em aberto.
    ('oben',77,h-21,'S',0,'CONTA_A_PAGAR','COMP',1004,now(),0,0,0,0,0,500,false,500,NULL,NULL,now());

  -- ── T2: fatos de compras ──────────────────────────────────────────────────────────────
  -- 1005: PAGO só com data_movimento do título (sem dDtPagamento) → data incerta.
  -- 1006: PAGO só com a liquidação CC → data incerta.
  -- 1007: prazo concedido NEGATIVO (vencimento antes da emissão), pago no vencimento.
  -- 1010/1011: ATRASADO com BAXP parcial (400 de 1000): a vencer (h+5) e vencido (h-5).
  -- 1012: A VENCER puro. 1013: status fora do vocabulário.
  INSERT INTO fin_contas_pagar VALUES
    ('oben',1005,900,'','D5','',h-80,h-70,2000,2000,'PAGO','2.01.01'),
    ('oben',1006,900,'','D6','',h-90,h-80,3000,3000,'PAGO','2.01.01'),
    ('oben',1007,900,'','D7','',h-60,h-65,800,800,'PAGO','2.01.01'),
    ('oben',1010,900,'','D10','',h-20,h+5,1000,1000,'ATRASADO','2.01.01'),
    ('oben',1011,900,'','D11','',h-35,h-5,1000,1000,'ATRASADO','2.01.01'),
    ('oben',1012,900,'','D12','',h-2,h+10,700,700,'A VENCER','2.01.01'),
    ('oben',1013,900,'','D13','',h-30,h-20,90,90,'XPTO','2.01.01');
  INSERT INTO fin_movimentacoes (company, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, natureza,
      omie_codigo_lancamento, resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros,
      resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, omie_ncodbaixa, data_pagamento_omie, resumo_lido_em) VALUES
    ('oben',77,h-70,'S',2000,'CONTA_A_PAGAR','COMP',1005,2000,2000,0,0,0,0,true,2000,NULL,NULL,now()),
    ('oben',77,h-72,'S',2000,'CONTA_CORRENTE_PAG','BAXP',1005,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,558,NULL,now()),
    ('oben',77,h-79,'S',3000,'CONTA_CORRENTE_PAG','BAXP',1006,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,559,NULL,now()),
    ('oben',77,h-65,'S',800,'CONTA_A_PAGAR','COMP',1007,800,800,0,0,0,0,true,800,NULL,h-65,now()),
    ('oben',77,h-65,'S',800,'CONTA_CORRENTE_PAG','BAXP',1007,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,560,NULL,now()),
    ('oben',77,h-3,'S',400,'CONTA_A_PAGAR','COMP',1010,400,400,0,0,0,600,false,1000,NULL,h-3,now()),
    ('oben',77,h-3,'S',400,'CONTA_CORRENTE_PAG','BAXP',1010,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,561,NULL,now()),
    ('oben',77,h-8,'S',400,'CONTA_A_PAGAR','COMP',1011,400,400,0,0,0,600,false,1000,NULL,h-8,now()),
    ('oben',77,h-8,'S',400,'CONTA_CORRENTE_PAG','BAXP',1011,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,562,NULL,now());
  -- Universo: códigos que mudam de significado entre empresas + sem categoria.
  INSERT INTO fin_contas_pagar VALUES
    ('colacor',2001,950,'','C1','',h-40,h-10,1000,1000,'A VENCER','2.01.99'),  -- imobilizado na colacor: FORA
    ('colacor',2002,951,'','C2','',h-40,h+10,2500,2500,'A VENCER','2.01.97'),  -- MP importada: DENTRO
    ('oben',2003,952,'','O3','',h-40,h+10,4000,4000,'A VENCER','2.01.97'),     -- 2.01.97 na oben: FORA
    ('oben',2004,953,'','O4','',h-40,h+10,300,300,'A VENCER',''),              -- sem categoria
    ('oben',2005,954,'','O5','',h-40,h+10,5000,5000,'A VENCER','2.05.03');     -- empréstimo: FORA (e fora do sensor 2.01)
  -- Nomes: 900 = pedidos de compra (10 pedidos — não pode multiplicar); 901 = cadastro Omie (fantasia
  -- vazia → razão); 902 = só o cache; 903 = nenhum.
  INSERT INTO purchase_orders_tracking SELECT 'OBEN', 900, 'RENNER SAYERLACK S/A' FROM generate_series(1,10);
  INSERT INTO purchase_orders_tracking VALUES ('OBEN', 901, '  ');
  INSERT INTO fin_contas_pagar VALUES
    ('oben',3001,901,'','N1','',h-40,h+10,100,100,'A VENCER','2.01.02'),
    ('oben',3002,902,'','N2','',h-40,h+10,100,100,'A VENCER','2.01.03'),
    ('oben',3003,903,'','N3','',h-40,h+10,100,100,'A VENCER','2.01.04');
  INSERT INTO omie_clientes_nao_vinculados VALUES ('oben',901,'RAZAO NOVECENTOS E UM','   '), ('colacor',902,'OUTRA EMPRESA','X');
  INSERT INTO fornecedor_omie_cache VALUES ('oben',902,'CACHE NOVECENTOS E DOIS'), ('oben',902,'CACHE NOVECENTOS E DOIS');
END $f$;
SQL
}

falhas=0
okp() { # como postgres. $1 SQL, $2 esperado, $3 rótulo. Erro de psql vira valor distinto (nunca mascara).
  local got; got="$(Pq -c "$1" 2>&1)" || got="ERRO-PSQL: $got"
  if [ "$got" != "$2" ]; then echo "FALHOU: $3 | esperado=[$2] obtido=[$got]"; falhas=$((falhas+1)); fi
}

ENC="public.v_titulo_encargos_cp"

suite() {
  falhas=0
  preparar_banco
  # A migration (ou a sabotagem) TEM de aplicar: erro de SQL nao pode passar por "vermelho".
  P -f "$1" || { echo "APLICACAO FALHOU: $1"; return 99; }

  # ── encargos_cp (T1) ──────────────────────────────────────────────────────────────────
  okp "SELECT n_baixas||'|'||confianca||'|'||coalesce(desconto_obtido::text,'NULL')||'|'||desconto_informado_omie FROM $ENC WHERE omie_codigo_lancamento=1001" \
      "2|divergente|NULL|345.23" "encargos versao velha sem nCodBaixa -> divergente, desconto so informado"
  okp "SELECT confianca||'|'||desconto_obtido||'|'||fonte_data_baixa||'|'||dias_atraso FROM $ENC WHERE omie_codigo_lancamento=1002" \
      "alta|119.16|omie_data_pagamento|0" "encargos em dia com desconto -> alta"
  okp "SELECT coalesce(desconto_obtido::text,'NULL')||'|'||coalesce(desconto_informado_omie::text,'NULL')||'|'||identidade_ok FROM $ENC WHERE omie_codigo_lancamento=1003" \
      "NULL|NULL|false" "encargos resumo NULL -> desconto NULL"
  okp "SELECT valor_aberto_informado||'|'||status_titulo FROM $ENC WHERE omie_codigo_lancamento=1004" \
      "500.00|ATRASADO" "encargos aberto informado em titulo ATRASADO"
  okp "SELECT has_table_privilege('authenticated','$ENC','SELECT')::text||has_table_privilege('anon','$ENC','SELECT')::text" \
      "falsefalse" "encargos sem SELECT direto para authenticated e anon"

  # ── fatos (T2) ────────────────────────────────────────────────────────────────────────
  local TIT="public.v_ciclo_cp_titulos" RES="public.v_ciclo_fornecedor_resumo"
  local H; H="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
  # Fixture nao vacua: as views tem de ter linhas, senao toda igualdade abaixo prova nada.
  okp "SELECT (SELECT count(*) FROM $TIT) >= 12 AND (SELECT count(*) FROM $RES) >= 5" "t" "fatos fixture nao vacua"
  okp "SELECT string_agg(omie_codigo_lancamento::text, ',' ORDER BY omie_codigo_lancamento) FROM $TIT WHERE company='colacor' OR omie_codigo_lancamento IN (2003,2004,2005)" \
      "2002" "fatos universo por (empresa, codigo): 2.01.99 colacor fora, 2.01.97 so colacor"
  okp "SELECT situacao||'|'||dias_atraso_baixa||'|'||prazo_real_dias||'|'||data_baixa_confiavel||'|'||coalesce(valor_aberto::text,'NULL') FROM $TIT WHERE omie_codigo_lancamento=1002" \
      "paga|0|11|true|NULL" "fatos CC D+1 nao e atraso; PAGO com saldo cheio nao vira aberto"
  okp "SELECT string_agg(omie_codigo_lancamento||':'||data_baixa_confiavel||':'||coalesce(dias_atraso_baixa::text,'NULL')||':'||coalesce(prazo_real_dias::text,'NULL'), ',' ORDER BY omie_codigo_lancamento) FROM $TIT WHERE omie_codigo_lancamento IN (1005,1006)" \
      "1005:false:NULL:NULL,1006:false:NULL:NULL" "fatos so titulo_data_movimento ou so CC = data incerta"
  okp "SELECT prazo_concedido_dias||'|'||situacao FROM $TIT WHERE omie_codigo_lancamento=1007" "-5|paga" "fatos prazo negativo entra"
  okp "SELECT string_agg(omie_codigo_lancamento||':'||situacao||':'||coalesce(valor_aberto::text,'')||':'||coalesce(fonte_valor_aberto,''), ',' ORDER BY omie_codigo_lancamento) FROM $TIT WHERE omie_codigo_lancamento IN (1004,1010,1011,1012,1013)" \
      "1004:vencida_aberta:500.00:omie_resumo,1010:paga_parcial:600.00:omie_resumo,1011:paga_parcial:600.00:omie_resumo,1012:a_vencer:700:valor_titulo,1013:status_ambiguo::" \
      "fatos situacoes de aberto, parcial e ambiguo"
  local R900="FROM $RES WHERE company='oben' AND omie_codigo_fornecedor=900"
  okp "SELECT nome_fornecedor||'|'||fonte_nome $R900" "RENNER SAYERLACK S/A|pedido_compra" "fatos nome por pedido de compra"
  okp "SELECT compras_12m = (SELECT sum(valor_documento) FROM fin_contas_pagar WHERE company='oben' AND omie_codigo_cliente_fornecedor=900 AND status_titulo <> 'CANCELADO' AND data_emissao >= '$H'::date-365 AND data_emissao < '$H'::date) $R900" \
      "t" "fatos nome nao multiplica compras_12m (10 pedidos)"
  okp "SELECT count(*) FROM $RES WHERE company='oben' AND omie_codigo_fornecedor=900" "1" "fatos uma linha por fornecedor"
  # Pagas de 900: 1001 (17261.40, divergente), 1002 (5958.04, alta), 1003 (1000, sem resumo),
  # 1005 (2000, data incerta), 1006 (3000, data incerta), 1007 (800). 1003 tem so a data do titulo → incerta.
  okp "SELECT valor_pago||'|'||valor_pago_em_dia||'|'||valor_pago_atrasado||'|'||valor_pago_data_incerta||'|'||n_prazo_negativo $R900" \
      "30019.44|24019.44|0|6000|1" "fatos denominadores de pontualidade"
  okp "SELECT valor_pago_conf_decisao||'|'||desconto_obtido_12m||'|'||n_titulos_com_desconto $R900" \
      "8758.04|119.16|2" "fatos resumo NULL e divergente fora da decisao; evidencia conta os 2"
  okp "SELECT valor_vencido_aberto||'|'||n_vencidas||'|'||valor_a_vencer||'|'||n_status_ambiguo $R900" \
      "1100.00|2|1300.00|1" "fatos remanescente do parcial pelo vencimento"
  okp "SELECT string_agg(omie_codigo_fornecedor||':'||coalesce(nome_fornecedor,'NULL')||':'||coalesce(fonte_nome,'NULL'), ',' ORDER BY omie_codigo_fornecedor) FROM $RES WHERE company='oben' AND omie_codigo_fornecedor IN (901,902,903)" \
      "901:RAZAO NOVECENTOS E UM:cadastro_omie,902:CACHE NOVECENTOS E DOIS:cache_fornecedor,903:NULL:NULL" "fatos cascata de nome sem fabricar"
  okp "SELECT has_table_privilege('authenticated','$TIT','SELECT')::text||has_table_privilege('authenticated','$RES','SELECT')::text" \
      "falsefalse" "fatos views sem SELECT direto para authenticated"
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

echo "PROVA-CICLO-FORNECEDOR-OK"

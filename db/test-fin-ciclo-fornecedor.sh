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
  return "$falhas"
}

# 1) CONTROLE VERDE — a migration real precisa passar inteira.
cp "$MIG" "$TMPD/mig.sql"
rc=0; out="$(suite "$TMPD/mig.sql" 2>&1)" || rc=$?
if [ "$rc" -ne 0 ]; then echo "$out"; echo "CONTROLE VERMELHO (rc=$rc) — abortando antes de falsificar"; exit 1; fi
echo "CONTROLE OK"

echo "PROVA-CICLO-FORNECEDOR-OK"

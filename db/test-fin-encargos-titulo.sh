#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261013094000_fin_movimentacoes_resumo_encargos               ║
# ║  Colunas tipadas do resumo do Omie + v_titulo_encargos_cr, com FALSIFICAÇÃO   ║
# ║      bash db/test-fin-encargos-titulo.sh > logs/t.log 2>&1; echo "exit=$?"    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# Os cenários reproduzem o que foi MEDIDO em prod (2026-10-13): versões do título (12067405417),
# baixa CC zerada de inclusão (12053202824), baixa duplicada por versão, baixa cancelada que sobra
# no espelho (12097272930), boleto com juros+multa somados em nJuros (165,00 → 6,05), parcial e
# título sem movimento. Cada invariante que decide dinheiro tem uma sabotagem que TEM de ficar
# vermelha; a sabotagem roda sobre uma CÓPIA da migration (o repo nunca é tocado).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5471}"
SLUG="fin-encargos-titulo"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -q -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -f "$REPO_ROOT/db/stubs-supabase.sql"
P <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
-- Espelha o Supabase: todo objeto novo em public nasce com ALL para anon/authenticated/service_role.
-- Sem isto o REVOKE de anon da migration seria inerte e o assert dele, tautologia.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — stubs com a FORMA DE PROD (\d medido via psql-ro em 2026-10-13)
# ══════════════════════════════════════════════════════════════════════════════
P <<'SQL'
CREATE TABLE public.user_roles (user_id uuid, role text);
CREATE TABLE public.fin_permissoes (user_id uuid PRIMARY KEY, pode_ver_todas_empresas boolean DEFAULT false, empresas text[]);
-- Corpo de prod (pg_get_functiondef 2026-10-13).
CREATE OR REPLACE FUNCTION public.fin_user_can_access(check_company text DEFAULT NULL::text)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_perm RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid() AND role IN ('master','employee')) THEN
    RETURN true;
  END IF;
  SELECT * INTO v_perm FROM fin_permissoes WHERE user_id = auth.uid();
  IF v_perm IS NULL THEN RETURN false; END IF;
  IF check_company IS NULL THEN RETURN true; END IF;
  RETURN v_perm.pode_ver_todas_empresas OR check_company = ANY(v_perm.empresas);
END;
$function$;

CREATE TABLE public.fin_movimentacoes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  omie_ncodmov bigint NOT NULL,
  omie_ncodcc bigint,
  data_movimento date NOT NULL,
  tipo text CHECK (tipo = ANY (ARRAY['E','S'])),
  valor numeric(15,2) NOT NULL,
  descricao text,
  categoria_codigo text,
  categoria_descricao text,
  conciliado boolean DEFAULT false,
  omie_codigo_lancamento bigint,
  natureza text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (company, omie_ncodmov)
);
ALTER TABLE public.fin_movimentacoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_mov_select ON public.fin_movimentacoes FOR SELECT TO authenticated USING (fin_user_can_access(company));
CREATE POLICY fin_mov_service ON public.fin_movimentacoes USING (auth.role() = 'service_role');

CREATE TABLE public.fin_contas_receber (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  company text NOT NULL CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  omie_codigo_lancamento bigint NOT NULL,
  cnpj_cpf text,
  numero_documento text,
  data_emissao date,
  data_vencimento date,
  valor_documento numeric(15,2) NOT NULL DEFAULT 0,
  valor_recebido numeric(15,2) DEFAULT 0,
  valor_desconto numeric(15,2),
  valor_juros numeric(15,2),
  valor_multa numeric(15,2),
  status_titulo text DEFAULT 'ABERTO',
  tipo_documento text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (company, omie_codigo_lancamento)
);
ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_cr_select ON public.fin_contas_receber FOR SELECT TO authenticated USING (fin_user_can_access(company));
CREATE POLICY fin_cr_service ON public.fin_contas_receber USING (auth.role() = 'service_role');
GRANT SELECT ON public.user_roles, public.fin_permissoes TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migration REAL (duas vezes: idempotência)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20261013094000_fin_movimentacoes_resumo_encargos.sql"
if P -f "$MIG" 2>"$TMPD/apply1.err"; then ok "M1 migration aplica"; else bad "M1 migration aplica: $(cat "$TMPD/apply1.err")"; exit 1; fi
if P -f "$MIG" 2>"$TMPD/apply2.err"; then ok "M2 migration re-aplica (idempotente)"; else bad "M2 re-apply: $(cat "$TMPD/apply2.err")"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (cenários medidos em prod). h() = hash sintético qualquer, único.
# ══════════════════════════════════════════════════════════════════════════════
P <<'SQL'
CREATE SEQUENCE pg_temp_hash START 1000;
CREATE FUNCTION h() RETURNS bigint LANGUAGE sql AS $$ SELECT nextval('pg_temp_hash') $$;

-- títulos (fin_contas_receber)
INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, valor_documento, data_vencimento, status_titulo) VALUES
 ('colacor', 1, 165.00,   '2026-02-20', 'RECEBIDO'),   -- T1 boleto atrasado 5d, juros+multa em nJuros
 ('oben',    2, 13697.86, '2026-04-27', 'RECEBIDO'),   -- T2 versões (12067405417)
 ('oben',    3, 500.00,   '2026-05-10', 'RECEBIDO'),   -- T3 baixa CC duplicada por versão
 ('oben',    4, 1000.00,  '2026-05-10', 'RECEBIDO'),   -- T4 duas baixas iguais LEGÍTIMAS (nCodBaixa ≠)
 ('oben',    5, 1000.00,  '2026-03-01', 'RECEBIDO'),   -- T5 parcial: 2 baixas
 ('oben',    6, 700.00,   '2026-03-01', 'RECEBIDO'),   -- T6 título SEM movimento
 ('oben',    7, 800.00,   '2026-03-01', 'RECEBIDO'),   -- T7 pré-backfill: só CC, sem resumo
 ('oben',    8, 1000.00,  '2026-03-01', 'RECEBIDO'),   -- T8 baixa cancelada sobrando (12097272930)
 ('oben',    9, 300.00,   '2026-03-01', 'RECEBIDO'),   -- T9 identidade quebrada
 ('oben',   10, 400.00,   '2026-03-01', 'RECEBIDO'),   -- T10 resumo sem nJuros (ausente)
 ('oben',   11, 250.00,   '2026-03-01', 'RECEBIDO'),   -- T11 ERP sem caixa
 ('oben',   12, 999.00,   '2026-03-01', 'ATRASADO'),   -- T12 não recebido: fora da view
 ('colacor_sc', 13, 100.00, '2026-03-01', 'RECEBIDO'); -- T13 RLS por empresa

-- T1: CR com resumo real; CC BAXR liquidado D+1; CC de INCLUSÃO zerado (MANR 0,00) que NÃO é caixa.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, tipo_documento, data_pagamento_omie, resumo_lido_em) VALUES
 ('colacor', h(), 10, '2026-02-25', 'E', 165.00, 'CONTA_A_RECEBER', 1, 'VENR', 165, 171.05, 0, 6.05, 0, 0, true, 165, 'BOL', '2026-02-25', now());
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza, omie_ncodbaixa) VALUES
 ('colacor', h(), 10, '2026-02-26', 'E', 171.05, 'CONTA_CORRENTE_REC', 1, 'BAXR', 501),
 ('colacor', h(), 10, '2026-02-20', 'E', 0.00,   'CONTA_CORRENTE_REC', 1, 'MANR', NULL);

-- T2: duas versões do título. A VELHA (desconto 3344,27) parou de ser vista em 05-25; a ATUAL segue.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie, created_at, updated_at) VALUES
 ('oben', h(), 20, '2026-04-27', 'E', 13697.86, 'CONTA_A_RECEBER', 2, 'MANR', 13697.86, 10353.59, 3344.27, 0, 0, 0, true, 13697.86, '2026-04-27', '2026-05-25 09:40', '2026-05-25 16:10'),
 ('oben', h(), 21, '2026-05-12', 'E', 13697.86, 'CONTA_A_RECEBER', 2, 'MANR', 13697.86, 13697.86, 0,       0, 0, 0, true, 13697.86, '2026-05-12', '2026-05-26 09:31', '2026-08-12 15:40');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza, created_at, updated_at) VALUES
 ('oben', h(), 20, '2026-04-27', 'E', 9800.00, 'CONTA_CORRENTE_REC', 2, 'BAXR', '2026-05-25', '2026-07-27'),
 ('oben', h(), 20, '2026-04-07', 'E', 553.59,  'CONTA_CORRENTE_REC', 2, 'BAXR', '2026-05-25', '2026-07-07'),
 ('oben', h(), 21, '2026-05-12', 'E', 3344.27, 'CONTA_CORRENTE_REC', 2, 'BAXR', '2026-05-26', '2026-08-12'),
 ('oben', h(), 20, '2026-04-27', 'E', 0.00,    'CONTA_CORRENTE_REC', 2, 'MANR', '2026-05-25', '2026-05-25');

-- T3: a MESMA baixa em duas versões (sem nCodBaixa, pré-backfill): só a mais nova conta.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 30, '2026-05-10', 'E', 500, 'CONTA_A_RECEBER', 3, 'VENR', 500, 500, 0, 0, 0, 0, true, 500, '2026-05-10');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza, created_at, updated_at) VALUES
 ('oben', h(), 30, '2026-05-11', 'E', 500, 'CONTA_CORRENTE_REC', 3, 'BAXR', '2026-05-11', '2026-06-16'),
 ('oben', h(), 30, '2026-05-11', 'E', 500, 'CONTA_CORRENTE_REC', 3, 'BAXR', '2026-06-16', '2026-09-11');

-- T4: duas baixas de 500 no MESMO dia/conta com nCodBaixa DISTINTOS — as duas contam.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 40, '2026-05-10', 'E', 1000, 'CONTA_A_RECEBER', 4, 'VENR', 1000, 1000, 0, 0, 0, 0, true, 1000, '2026-05-10');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza, omie_ncodbaixa, updated_at) VALUES
 ('oben', h(), 40, '2026-05-11', 'E', 500, 'CONTA_CORRENTE_REC', 4, 'BAXR', 401, '2026-06-01'),
 ('oben', h(), 40, '2026-05-11', 'E', 500, 'CONTA_CORRENTE_REC', 4, 'BAXR', 402, '2026-06-02');

-- T5: parcial — 600 no vencimento, 400 + 16 de encargo 30 dias depois.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 50, '2026-03-31', 'E', 1000, 'CONTA_A_RECEBER', 5, 'VENR', 1000, 1016, 0, 16, 0, 0, true, 1000, '2026-03-31');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza, omie_ncodbaixa) VALUES
 ('oben', h(), 50, '2026-03-02', 'E', 600, 'CONTA_CORRENTE_REC', 5, 'BAXR', 501),
 ('oben', h(), 50, '2026-04-01', 'E', 416, 'CONTA_CORRENTE_REC', 5, 'BAXR', 502);

-- T6: nada. T7: só CC (sem resumo).
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza) VALUES
 ('oben', h(), 70, '2026-03-10', 'E', 820, 'CONTA_CORRENTE_REC', 7, 'BAXR');

-- T8: baixa cancelada (900, outra data) sobrou; a vigente é 1000.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 80, '2026-03-20', 'E', 1000, 'CONTA_A_RECEBER', 8, 'VENR', 1000, 1000, 0, 0, 0, 0, true, 1000, '2026-03-20');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza) VALUES
 ('oben', h(), 80, '2026-03-05', 'E', 900,  'CONTA_CORRENTE_REC', 8, 'BAXR'),
 ('oben', h(), 80, '2026-03-21', 'E', 1000, 'CONTA_CORRENTE_REC', 8, 'BAXR');

-- T9: identidade quebrada (líquido 999 ≠ 300 − 0 + 10 + 0).
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 90, '2026-03-20', 'E', 300, 'CONTA_A_RECEBER', 9, 'VENR', 300, 999, 0, 10, 0, 0, true, 300, '2026-03-20');

-- T10: resumo SEM nJuros (ausente ≠ 0) + CC.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 100, '2026-03-20', 'E', 400, 'CONTA_A_RECEBER', 10, 'VENR', 400, 412, 0, NULL, 0, 0, true, 400, '2026-03-20');
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza) VALUES
 ('oben', h(), 100, '2026-03-21', 'E', 412, 'CONTA_CORRENTE_REC', 10, 'BAXR');

-- T11: ERP informa juros 5 e não há baixa em caixa.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza,
  resumo_val_pago, resumo_val_liquido, resumo_desconto, resumo_juros, resumo_multa, resumo_val_aberto, resumo_liquidado, valor_titulo, data_pagamento_omie) VALUES
 ('oben', h(), 110, '2026-03-10', 'E', 250, 'CONTA_A_RECEBER', 11, 'VENR', 250, 255, 0, 5, 0, 0, true, 250, '2026-03-10');

-- T12: título ATRASADO com resumo e CC: não entra.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza) VALUES
 ('oben', h(), 120, '2026-03-10', 'E', 999, 'CONTA_CORRENTE_REC', 12, 'BAXR');

-- T13: colacor_sc, só CC.
INSERT INTO fin_movimentacoes (company, omie_ncodmov, omie_ncodcc, data_movimento, tipo, valor, categoria_descricao, omie_codigo_lancamento, natureza) VALUES
 ('colacor_sc', h(), 130, '2026-03-02', 'E', 100, 'CONTA_CORRENTE_REC', 13, 'BAXR');

INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222'), ('33333333-3333-3333-3333-333333333333');
INSERT INTO user_roles VALUES ('11111111-1111-1111-1111-111111111111', 'employee');
INSERT INTO fin_permissoes VALUES ('22222222-2222-2222-2222-222222222222', false, ARRAY['colacor_sc']);
-- 333… : sem papel e sem permissão financeira.
SQL

# v(cod, coluna) — lê UMA célula da view (texto; NULL vira "<null>").
v() { Pq -c "SELECT COALESCE($2::text, '<null>') FROM v_titulo_encargos_cr WHERE omie_codigo_lancamento = $1"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
asserts_logica() {
  eq "A1 boleto atrasado: confianca"                  "$(v 1 confianca)"            "alta"
  eq "A1 encargo = juros+multa do resumo"             "$(v 1 encargo_recebido)"     "6.05"
  eq "A1 atraso pela BAIXA (dDtPagamento), nao pela liquidacao CC" "$(v 1 dias_atraso)" "5"
  eq "A1 fonte da data"                               "$(v 1 fonte_data_baixa)"     "omie_data_pagamento"
  eq "A1 CC de inclusao zerado NAO e baixa"           "$(v 1 n_baixas)"             "1"
  eq "A1 tipo de documento"                           "$(v 1 tipo_documento)"       "BOL"
  eq "A2 versao ATUAL vence: desconto"                "$(v 2 desconto_concedido)"   "0.00"
  eq "A2 versoes contadas"                            "$(v 2 versoes_titulo)"       "2"
  eq "A2 caixa 9800+553,59+3344,27 = liquido atual"   "$(v 2 confianca)"            "alta"
  eq "A3 baixa duplicada por versao conta uma vez"    "$(v 3 soma_baixas)"          "500.00"
  eq "A3 confianca"                                   "$(v 3 confianca)"            "alta"
  eq "A4 duas baixas iguais legitimas (nCodBaixa diferente) contam as duas" "$(v 4 soma_baixas)" "1000.00"
  eq "A5 parcial: n_baixas"                           "$(v 5 n_baixas)"             "2"
  eq "A5 parcial: encargo"                            "$(v 5 encargo_recebido)"     "16.00"
  eq "A5 parcial: data = baixa final do titulo"       "$(v 5 data_baixa)"           "2026-03-31"
  eq "A6 titulo sem movimento: confianca"             "$(v 6 confianca)"            "sem_dado"
  eq "A6 titulo sem movimento: encargo NULL, nao 0"   "$(v 6 encargo_recebido)"     "<null>"
  eq "A6 titulo sem movimento: desconto NULL"         "$(v 6 desconto_concedido)"   "<null>"
  eq "A6 titulo sem movimento: dias_atraso NULL"      "$(v 6 dias_atraso)"          "<null>"
  eq "A7 so CC: confianca"                            "$(v 7 confianca)"            "so_diferenca_caixa"
  eq "A7 so CC: encargo NULL (diferenca nao e encargo)" "$(v 7 encargo_recebido)"   "<null>"
  eq "A7 so CC: diferenca bruta exposta"              "$(v 7 diferenca_caixa_documento)" "20.00"
  eq "A7 so CC: data cai na liquidacao, e diz"        "$(v 7 fonte_data_baixa)"     "conta_corrente_liquidacao"
  eq "A8 baixa cancelada sobrando: divergente"        "$(v 8 confianca)"            "divergente"
  eq "A8 divergente nao vira encargo efetivo"         "$(v 8 encargo_recebido)"     "<null>"
  eq "A8 mas o informado pelo Omie fica auditavel"    "$(v 8 juros_informado_omie)" "0.00"
  eq "A9 identidade quebrada: inconsistente"          "$(v 9 confianca)"            "inconsistente"
  eq "A9 inconsistente bloqueia o informado"          "$(v 9 juros_informado_omie)" "<null>"
  eq "A10 nJuros ausente: nao e resumo completo"      "$(v 10 confianca)"           "so_diferenca_caixa"
  eq "A10 nJuros ausente: encargo NULL"               "$(v 10 encargo_recebido)"    "<null>"
  eq "A11 ERP sem caixa"                              "$(v 11 confianca)"           "erp_sem_caixa"
  eq "A11 ERP sem caixa: encargo do resumo"           "$(v 11 encargo_recebido)"    "5.00"
  eq "A12 titulo ATRASADO fora da view"               "$(Pq -c "SELECT count(*) FROM v_titulo_encargos_cr WHERE omie_codigo_lancamento = 12")" "0"
}

asserts_rls() {
  # Guard: o SET ROLE tem de pegar (SET LOCAL num psql autocommit não pega — money-path.md).
  eq "R0 guard: current_user sob SET ROLE" "$(Pq -c "SET ROLE authenticated; SELECT current_user;")" "authenticated"
  eq "R1 staff ve as 3 empresas" \
     "$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(DISTINCT company) FROM v_titulo_encargos_cr;")" "3"
  eq "R2 permissao so colacor_sc ve so ela" \
     "$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT string_agg(DISTINCT company, ',') FROM v_titulo_encargos_cr;")" "colacor_sc"
  eq "R3 autenticado sem permissao financeira ve 0" \
     "$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM v_titulo_encargos_cr;")" "0"
}

asserts_acl() {
  # Privilégio se prova por CATÁLOGO (o 42501 da RLS não distingue quem barrou — money-path.md).
  eq "G1 anon sem SELECT na view" "$(Pq -c "SELECT has_table_privilege('anon','public.v_titulo_encargos_cr','SELECT')")" "f"
  eq "G2 authenticated com SELECT" "$(Pq -c "SELECT has_table_privilege('authenticated','public.v_titulo_encargos_cr','SELECT')")" "t"
}

asserts_validador() {
  eq "V1 validador pos-apply verde no banco bom" \
     "$(Pq -F'|' -f "$REPO_ROOT/db/validacao-fin-encargos-titulo.sql")" "13|t|t|f"
}

asserts_check() {
  R=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  UPDATE fin_movimentacoes SET resumo_juros = 'NaN' WHERE omie_codigo_lancamento = 1 AND categoria_descricao = 'CONTA_A_RECEBER';
  RAISE NOTICE 'SENTINELA_CHECK_ACEITOU';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'SENTINELA_CHECK_RECUSOU';
WHEN OTHERS THEN RAISE;
END $$;
SQL
)
  case "$R" in *SENTINELA_CHECK_RECUSOU*) ok "C1 CHECK recusa NaN (23514)";; *) bad "C1 CHECK recusa NaN -- veio [$R]";; esac
}

echo "-- asserts (migration real) --"
PRE=$PASS
asserts_logica
asserts_rls
asserts_acl
asserts_validador
asserts_check
BASE_PASS=$((PASS-PRE)); BASE_FAIL=$FAIL
echo "baseline: $BASE_PASS ok / $BASE_FAIL fail"
[ "$BASE_FAIL" = "0" ] || { echo "HARNESS VERMELHO NO BASELINE -- falsificacao nao roda sobre base vermelha"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO. Cada sabotagem: cópia da migration com UMA troca (âncora única, senão
# ABORTA), aplica, exige que o assert-alvo fique VERMELHO, restaura com a migration real.
# ══════════════════════════════════════════════════════════════════════════════
SAB="$TMPD/sabotada.sql"
sabotar() { # $1=de $2=para
  python3 - "$MIG" "$SAB" "$1" "$2" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
n = s.count(de)
if n != 1:
    print(f"ANCORA NAO UNICA ({n}): {de!r}"); sys.exit(3)
open(dst, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
restaurar() { P -c "DROP VIEW IF EXISTS v_titulo_encargos_cr" >/dev/null; P -f "$MIG" >/dev/null 2>&1; }

FALS_OK=0; FALS_RUIM=0
# falsifica <nome> <de> <para> <funcao_de_asserts> <padrao-do-assert-que-tem-de-cair>
falsifica() {
  local nome="$1" de="$2" para="$3" fn="$4" alvo="$5" out
  if ! sabotar "$de" "$para"; then echo "  INVALIDA $nome (ancora)"; FALS_RUIM=$((FALS_RUIM+1)); return; fi
  P -c "DROP VIEW IF EXISTS v_titulo_encargos_cr" >/dev/null
  if ! P -f "$SAB" >"$TMPD/sab.log" 2>&1; then
    echo "  INVALIDA $nome (sabotagem nao aplicou: $(tail -1 "$TMPD/sab.log"))"; FALS_RUIM=$((FALS_RUIM+1)); restaurar; return
  fi
  out=$(PASS=0; FAIL=0; $fn)
  if printf '%s\n' "$out" | grep -F "FAIL $alvo" >/dev/null; then
    echo "  DENTE  $nome -> vermelho em [$alvo] (vermelhos: $(printf '%s\n' "$out" | grep -c '  FAIL ') -> $(printf '%s\n' "$out" | grep '  FAIL ' | sed -E 's/^  FAIL ([A-Z][0-9]+).*/\1/' | sort -u | tr '\n' ' '))"; FALS_OK=$((FALS_OK+1))
  else
    echo "  SEM-DENTE $nome -> [$alvo] seguiu verde"; FALS_RUIM=$((FALS_RUIM+1))
  fi
  restaurar
}
# A sabotagem tem de ABORTAR a migration (prova a postcondição).
falsifica_post() {
  local nome="$1" de="$2" para="$3" esperado="$4"
  if ! sabotar "$de" "$para"; then echo "  INVALIDA $nome (ancora)"; FALS_RUIM=$((FALS_RUIM+1)); return; fi
  P -c "DROP VIEW IF EXISTS v_titulo_encargos_cr" >/dev/null
  if P -f "$SAB" >"$TMPD/sab.log" 2>&1; then
    echo "  SEM-DENTE $nome -> migration sabotada APLICOU"; FALS_RUIM=$((FALS_RUIM+1))
  elif grep -F "$esperado" "$TMPD/sab.log" >/dev/null; then
    echo "  DENTE  $nome -> postcondicao abortou ($esperado)"; FALS_OK=$((FALS_OK+1))
  else
    echo "  INVALIDA $nome -> abortou por OUTRO motivo: $(grep -m1 ERROR "$TMPD/sab.log")"; FALS_RUIM=$((FALS_RUIM+1))
  fi
  restaurar
}

echo "-- falsificacao --"
falsifica "S1 versao mais VELHA vence" \
  "c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST" "c.updated_at ASC NULLS LAST, c.created_at ASC NULLS LAST" \
  asserts_logica "A2 versao ATUAL vence: desconto"
falsifica "S2 sem dedup de versao da baixa" \
  $'FROM baixa_linhas b\n   WHERE NOT EXISTS (' $'FROM baixa_linhas b\n   WHERE true OR NOT EXISTS (' \
  asserts_logica "A3 baixa duplicada por versao conta uma vez"
falsifica "S3 dedup ignora nCodBaixa" \
  "AND (b.omie_ncodbaixa IS NULL OR n.omie_ncodbaixa IS NULL OR n.omie_ncodbaixa = b.omie_ncodbaixa)" "AND true" \
  asserts_logica "A4 duas baixas iguais legitimas"
falsifica "S4 CC de inclusao conta como baixa" \
  "AND m.natureza IN ('BAXR', 'APBR')" "AND m.natureza IS NOT NULL" \
  asserts_logica "A1 CC de inclusao zerado NAO e baixa"
falsifica "S5 atraso pela liquidacao CC" \
  "COALESCE(ca.data_pagamento_omie, ca.data_movimento, bt.data_ultima_liquidacao)" "COALESCE(bt.data_ultima_liquidacao, ca.data_pagamento_omie, ca.data_movimento)" \
  asserts_logica "A1 atraso pela BAIXA"
falsifica "S6 divergente promovido a efetivo" \
  "AND NOT a.caixa_bate " "AND NOT a.caixa_bate AND false " \
  asserts_logica "A8 divergente nao vira encargo efetivo"
falsifica "S7 ausente vira 0 no encargo" \
  "THEN c.resumo_juros + c.resumo_multa END        AS encargo_recebido" "THEN c.resumo_juros + c.resumo_multa ELSE 0 END AS encargo_recebido" \
  asserts_logica "A6 titulo sem movimento: encargo NULL"
falsifica "S8 nJuros ausente aceito como resumo completo" \
  "AND ca.resumo_desconto IS NOT NULL AND ca.resumo_juros IS NOT NULL" "AND ca.resumo_desconto IS NOT NULL" \
  asserts_logica "A10 nJuros ausente: nao e resumo completo"
falsifica "S9 identidade nao verificada" \
  "                   - (b.resumo_val_pago - b.resumo_desconto + b.resumo_juros + b.resumo_multa)) <= 0.01," \
  "                   - (b.resumo_val_pago - b.resumo_desconto + b.resumo_juros + b.resumo_multa)) <= 1e9," \
  asserts_logica "A9 identidade quebrada"
falsifica_post "S10 view sem security_invoker" \
  "WITH (security_invoker = on) AS" "WITH (security_invoker = off) AS" "sem security_invoker=on"
falsifica_post "S11 sem REVOKE de anon" \
  "REVOKE ALL ON public.v_titulo_encargos_cr FROM anon;" "-- (sabotado)" "anon le v_titulo_encargos_cr"

# S12: RLS de verdade (fora da migration): view lendo como owner → o sem-permissão passa a ver.
P -c "ALTER VIEW v_titulo_encargos_cr SET (security_invoker = off)" >/dev/null
out=$(PASS=0; FAIL=0; asserts_rls; asserts_validador)
if printf '%s\n' "$out" | grep -F "FAIL R3 autenticado sem permissao financeira ve 0" >/dev/null; then
  echo "  DENTE  S12 security_invoker off -> vermelho em [R3]"; FALS_OK=$((FALS_OK+1))
else echo "  SEM-DENTE S12 -> R3 seguiu verde"; FALS_RUIM=$((FALS_RUIM+1)); fi
if printf '%s\n' "$out" | grep -F "FAIL V1 validador" >/dev/null; then
  echo "  DENTE  S12b validador acusa security_invoker off -> vermelho em [V1]"; FALS_OK=$((FALS_OK+1))
else echo "  SEM-DENTE S12b -> validador seguiu verde com a view lendo como owner"; FALS_RUIM=$((FALS_RUIM+1)); fi
restaurar

# S13: sem o CHECK, NaN entra.
P -c "ALTER TABLE fin_movimentacoes DROP CONSTRAINT fin_movimentacoes_resumo_finito" >/dev/null
out=$(PASS=0; FAIL=0; asserts_check)
if printf '%s\n' "$out" | grep -F "FAIL C1 CHECK recusa NaN" >/dev/null; then
  echo "  DENTE  S13 sem CHECK -> vermelho em [C1]"; FALS_OK=$((FALS_OK+1))
else echo "  SEM-DENTE S13 -> C1 seguiu verde"; FALS_RUIM=$((FALS_RUIM+1)); fi
P -c "UPDATE fin_movimentacoes SET resumo_juros = 6.05 WHERE omie_codigo_lancamento = 1 AND categoria_descricao = 'CONTA_A_RECEBER'" >/dev/null
restaurar

# S14: DEFAULT 0 numa coluna de valor → a postcondição tem de abortar.
P -c "ALTER TABLE fin_movimentacoes ALTER COLUMN resumo_juros SET DEFAULT 0" >/dev/null
if P -f "$MIG" >"$TMPD/sab.log" 2>&1; then echo "  SEM-DENTE S14 DEFAULT 0 aplicou"; FALS_RUIM=$((FALS_RUIM+1))
elif grep -F "com DEFAULT" "$TMPD/sab.log" >/dev/null; then echo "  DENTE  S14 DEFAULT 0 -> postcondicao abortou"; FALS_OK=$((FALS_OK+1))
else echo "  INVALIDA S14 -> $(grep -m1 ERROR "$TMPD/sab.log")"; FALS_RUIM=$((FALS_RUIM+1)); fi
P -c "ALTER TABLE fin_movimentacoes ALTER COLUMN resumo_juros DROP DEFAULT" >/dev/null

# Depois de restaurar tudo, o baseline tem de voltar INTEIRO (a falsificação não pode deixar sujeira).
PASS=0; FAIL=0
restaurar
asserts_logica >/dev/null; asserts_rls >/dev/null; asserts_acl >/dev/null; asserts_validador >/dev/null; asserts_check >/dev/null
eq "Z1 baseline intacto apos a falsificacao (total)" "$PASS/$FAIL" "$BASE_PASS/0"

echo "------------------------------"
echo "ASSERTS: $BASE_PASS ok no baseline  |  FALSIFICACAO: $FALS_OK com dente / $FALS_RUIM sem dente ou invalidas (esperado 15/0)"
if [ "$FAIL" != "0" ] || [ "$FALS_RUIM" != "0" ] || [ "$FALS_OK" != "15" ]; then echo "HARNESS VERMELHO"; exit 1; fi
echo "HARNESS VERDE"

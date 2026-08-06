#!/usr/bin/env bash
# Prova PG17 — PCP Fase 2A: custo-padrão de material (lixa) + fila de exceções classificada.
# Propriedades: Σ buckets = total [1] · outros não some [2] · ausente→NULL nunca 0 [3] · guard unidade [4] ·
#   multi-componente soma [5] · data fora da grade ABORTA [6] · jsonb não-array→ambiguo (não aborta) [7] ·
#   fila inclui incompleto [8] e sem-nCMC [9,12] · classe PROVADA cruza a 1A [10] · tingidor fora [11] ·
#   view não vaza [13] · RLS + cmc INVOKER não vaza [14] · versão não sobrescreve [15] · idempotência [16].
# HARDENING (painel tri-modelo): FIX1 fila inclui unidade_divergente/estrutura_ambigua · FIX2 cmc sem omie_products→incompleto ·
#   FIX3 qtd<=0→incompleto · FIX4 idProdMalha decimal/gigante NÃO aborta (SKU→incompleto) · FIX5 excecoes valida config · FIX6 advisory lock ·
#   FIX7 estrutura Omie vazia (itens=[] array vazio)→sem_estrutura: custo NULL (não 0), entra na fila como sem_estrutura (impacto=nCMC).
#
# FALSIFICAÇÃO (Step 17): re-rode com FALSIFY=<x> — cada sabotagem deve virar FAIL>0 (vermelho), depois reverte:
#   FALSIFY=coalesce (→#3) · guard (→#4) · sumfirst (→#5) · dataval (→#6) · defaultclasse (→#10) ·
#   invoker (→#13) · cmcdefiner (→#14) · filaclasse (→FIX1: unidade_divergente/ambiguo somem da fila) ·
#   semestrutura (→FIX7: array vazio vira ok/custo 0 → sem_estrutura some do motor e da fila).
#   A migration REAL fica intacta (sabotagem age numa CÓPIA temporária).
# Rodar (verde):    heavy bash db/test-pcp-f2a-custo.sh > /tmp/t-2a.log 2>&1; echo "exit=$?"
# Rodar (vermelho): FALSIFY=coalesce bash db/test-pcp-f2a-custo.sh > /tmp/f-2a.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5476}"
SLUG="pcp-f2a"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

# ── Migration REAL (ou CÓPIA sabotada quando FALSIFY setado) ──
MIG="$REPO_ROOT/db/pcp-f2a-custo.sql"
if [ -n "${FALSIFY:-}" ]; then
  MIG="$(mktemp "/tmp/f2a-sab.XXXXXX").sql"
  cp "$REPO_ROOT/db/pcp-f2a-custo.sql" "$MIG"
  case "$FALSIFY" in
    coalesce)     sed -i '' "s#(e.cmc IS NULL OR e.qtd IS NULL OR e.qtd <= 0 OR (e.cmc IS NOT NULL AND e.uom_estoque IS NULL)) AS falta#false AS falta#" "$MIG";;
    guard)        sed -i '' "s#(e.uom_estoque IS NOT NULL AND e.uom IS NOT NULL AND e.uom <> e.uom_estoque) AS unidade_diverge#false AS unidade_diverge#" "$MIG";;
    sumfirst)     sed -i '' "s#sum(custo) FILTER (WHERE papel = 'abrasivo_base')#max(custo) FILTER (WHERE papel = 'abrasivo_base')#" "$MIG";;
    dataval)      sed -i '' "s#NOT EXISTS (SELECT 1 FROM cmc_snapshot WHERE account = v_account AND data_posicao = p_data_posicao)#false#" "$MIG";;
    defaultclasse) sed -i '' "s#ELSE 'causa_indeterminada'#ELSE 'possivel_erro_receita'#" "$MIG";;
    invoker)      sed -i '' "s#security_invoker = true#security_invoker = false#g" "$MIG";;
    cmcdefiner)   sed -i '' "s#RETURNS numeric LANGUAGE sql STABLE SECURITY INVOKER#RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER#" "$MIG";;
    filaclasse)   sed -i '' "s#WHEN c.custo_status = 'unidade_divergente' THEN 'unidade_divergente'#WHEN c.custo_status = 'unidade_divergente' THEN NULL::text#" "$MIG"
                  sed -i '' "s#WHEN c.custo_status = 'ambiguo' THEN 'estrutura_ambigua'#WHEN c.custo_status = 'ambiguo' THEN NULL::text#" "$MIG";;
    semestrutura) sed -i '' "s#WHEN a.pai_cod IS NULL THEN 'sem_estrutura'#WHEN false THEN 'sem_estrutura'#" "$MIG"
                  sed -i '' "s#= 'array' AND a.pai_cod IS NOT NULL AND coalesce(a.n_div, 0) = 0#= 'array' AND coalesce(a.n_div, 0) = 0#" "$MIG";;
    *) echo "FALSIFY desconhecido: $FALSIFY"; exit 2;;
  esac
  echo "### FALSIFY=$FALSIFY — migration sabotada em $MIG (esperado: FAIL>0)"
fi

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; [ -n "${FALSIFY:-}" ] && rm -f "$MIG" || true; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos (roles, auth, has_role, staff aaaa / não-staff bbbb) + helpers/tabelas da 1A (stub) ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');  -- staff; bbbb sem role (fail-closed)

-- Helpers REAIS da 1A (fn_pcp_num parser tolerante; fn_pcp_papel_componente) — copiados verbatim de db/pcp-f1a-m2-nucleo.sql
CREATE OR REPLACE FUNCTION public.fn_pcp_num(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
SELECT CASE WHEN v ~ '^-?\d+(\.\d+)?$' THEN v::numeric END
FROM (SELECT replace(trim(coalesce(p_raw,'')), ',', '.') AS v) t $$;
CREATE OR REPLACE FUNCTION public.fn_pcp_papel_componente(p_descricao text, p_familia text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
  WHEN upper(coalesce(p_descricao,'')) ~ '^(ROLO|JUMBO)\s'                      THEN 'abrasivo_base'
  WHEN upper(coalesce(p_descricao,'')) ~ 'DESMODUR|CATALISADOR'
    OR coalesce(p_familia,'') ILIKE '%catalisador%'                             THEN 'catalisador'
  WHEN upper(coalesce(p_descricao,'')) ~ '\mFITA\M|MYLAR'                       THEN 'fita'
  WHEN upper(coalesce(p_descricao,'')) ~ 'A455|ADESIVO|\mCOLA\M'
    OR coalesce(p_familia,'') ILIKE '%cola%' OR coalesce(p_familia,'') ILIKE '%adesivo%' THEN 'cola'
  ELSE 'outro'
END $$;

-- pcp_config (shape REAL key/value jsonb) com RLS staff-only (a 2A insere as chaves via ON CONFLICT).
CREATE TABLE public.pcp_config (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.pcp_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY pcp_config_sel ON public.pcp_config FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
GRANT SELECT ON public.pcp_config TO authenticated;

-- cmc_snapshot (colunas REAIS da sonda) com policy staff-only.
CREATE TABLE public.cmc_snapshot (
  id bigserial PRIMARY KEY, account text NOT NULL, omie_codigo_produto bigint NOT NULL,
  data_posicao date NOT NULL, cmc numeric, synced_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.cmc_snapshot ENABLE ROW LEVEL SECURITY;
CREATE POLICY cmc_sel_staff ON public.cmc_snapshot FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
GRANT SELECT ON public.cmc_snapshot TO authenticated;

CREATE TABLE public.omie_products (
  omie_codigo_produto bigint NOT NULL, account text NOT NULL, codigo text, descricao text,
  familia text, unidade text, PRIMARY KEY (omie_codigo_produto, account));

CREATE TABLE public.pcp_malha_staging (omie_codigo_produto bigint PRIMARY KEY, payload jsonb NOT NULL);
ALTER TABLE public.pcp_malha_staging ENABLE ROW LEVEL SECURITY;
CREATE POLICY mstg_sel_staff ON public.pcp_malha_staging FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
GRANT SELECT ON public.pcp_malha_staging TO authenticated;

CREATE TABLE public.pcp_itens (
  omie_codigo_produto bigint PRIMARY KEY, tipo_item text NOT NULL, linha_modelo text);
ALTER TABLE public.pcp_itens ENABLE ROW LEVEL SECURITY;
CREATE POLICY itens_sel_staff ON public.pcp_itens FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
GRANT SELECT ON public.pcp_itens TO authenticated;

CREATE TABLE public.pcp_bom_excecoes (
  pai_codigo bigint NOT NULL, componente_codigo bigint NOT NULL DEFAULT 0, papel text NOT NULL,
  status text NOT NULL, disposicao text, PRIMARY KEY (pai_codigo, papel, componente_codigo));
ALTER TABLE public.pcp_bom_excecoes ENABLE ROW LEVEL SECURITY;
CREATE POLICY be_sel_staff ON public.pcp_bom_excecoes FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
GRANT SELECT ON public.pcp_bom_excecoes TO authenticated;
SQL

echo "═══ ZONA 2: aplica a migration 2A ($([ -n "${FALSIFY:-}" ] && echo SABOTADA || echo real)) 2× — idempotável ═══"
P -q -f "$MIG"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "migration re-aplicável (2ª colagem no-op)"; else bad "2ª aplicação QUEBROU"; fi

echo "═══ ZONA 3: seed (componentes, CMC grade 2026-06-15 [+05-15 drift do 202], malhas, itens, exceção 1A) ═══"
P -q <<'SQL'
-- Componentes (account colacor). Papel deriva do descrProdMalha da malha (abrasivo=^ROLO/JUMBO; cola=COLA A455; cat=DESMODUR; fita=FITA).
INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, familia, unidade) VALUES
 (101,'colacor','R101','ROLO LIXA A','Abrasivos','M2'),
 (102,'colacor','C102','COLA A455','Cola','G'),
 (103,'colacor','P103','PARAFUSO','Diversos','UN'),
 (104,'colacor','K104','DESMODUR','Catalisador','G'),
 (105,'colacor','F105','FITA ADESIVA','Fita','CM'),
 (201,'colacor','J201','JUMBO X','Abrasivos','M2'),
 (202,'colacor','J202','JUMBO Y','Abrasivos','M2'),
 (301,'colacor','R301','ROLO LIXA B','Abrasivos','M2'),   -- estoque M2 (malha manda KG → guard)
 (999,'colacor','R999','ROLO SEMCMC','Abrasivos','M2');   -- SEM cmc → incompleto

-- CMC dos componentes (2026-06-15). 202 tem 2ª data (05-15, cmc 6) → drift 0.67 > 0.10.
INSERT INTO cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
 ('colacor_vendas',101,'2026-06-15',10),('colacor_vendas',102,'2026-06-15',5),
 ('colacor_vendas',103,'2026-06-15',7), ('colacor_vendas',104,'2026-06-15',3),
 ('colacor_vendas',105,'2026-06-15',2), ('colacor_vendas',201,'2026-06-15',4),
 ('colacor_vendas',202,'2026-06-15',10),('colacor_vendas',202,'2026-05-15',6),
 ('colacor_vendas',301,'2026-06-15',8),
 ('colacor_vendas',998,'2026-06-15',9),   -- FIX 2: tem CMC mas SEM linha em omie_products (unidade de estoque não confirmada)
-- nCMC dos acabados (só quem deve ter): divergem do custo-padrão p/ testar as classes.
 ('colacor_vendas',1010,'2026-06-15',20),('colacor_vendas',1011,'2026-06-15',20),
 ('colacor_vendas',1012,'2026-06-15',20),('colacor_vendas',1013,'2026-06-15',10),
 ('colacor_vendas',2000,'2026-06-15',10),
 ('colacor_vendas',1040,'2026-06-15',12);   -- FIX 7: acabado SEM estrutura (itens=[]) mas COM nCMC → impacto_r = nCMC

INSERT INTO pcp_itens (omie_codigo_produto, tipo_item) VALUES
 (1000,'cinta'),(1001,'cinta'),(1002,'cinta'),(1003,'cinta'),(1004,'cinta'),(1005,'cinta'),
 (1010,'cinta'),(1011,'cinta'),(1012,'cinta'),(1013,'cinta'),(1020,'cinta'),(2000,'tingidor'),
 (1006,'cinta'),(1007,'cinta'),(1030,'cinta'),(1031,'cinta'),  -- lixa com dado problemático (FIX 3/2/4)
 (1040,'folha');  -- FIX 7: acabado (lixa) com estrutura Omie vazia (itens=[])

INSERT INTO pcp_malha_staging (omie_codigo_produto, payload) VALUES
 (1000,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"},{"ident":{"idProdMalha":"102","descrProdMalha":"COLA A455"},"quantProdMalha":"3","unidProdMalha":"G"}]}'),
 (1001,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"1","unidProdMalha":"M2"},{"ident":{"idProdMalha":"103","descrProdMalha":"PARAFUSO"},"quantProdMalha":"2","unidProdMalha":"UN"}]}'),
 (1002,'{"itens":[{"ident":{"idProdMalha":"999","descrProdMalha":"ROLO SEMCMC"},"quantProdMalha":"2","unidProdMalha":"M2"}]}'),
 (1003,'{"itens":[{"ident":{"idProdMalha":"301","descrProdMalha":"ROLO LIXA B"},"quantProdMalha":"2","unidProdMalha":"KG"}]}'),
 (1004,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"},{"ident":{"idProdMalha":"201","descrProdMalha":"JUMBO X"},"quantProdMalha":"3","unidProdMalha":"M2"}]}'),
 (1005,'{"itens":{"foo":1}}'),
 (1020,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"1","unidProdMalha":"M2"},{"ident":{"idProdMalha":"102","descrProdMalha":"COLA A455"},"quantProdMalha":"1","unidProdMalha":"G"},{"ident":{"idProdMalha":"104","descrProdMalha":"DESMODUR"},"quantProdMalha":"1","unidProdMalha":"G"},{"ident":{"idProdMalha":"105","descrProdMalha":"FITA ADESIVA"},"quantProdMalha":"1","unidProdMalha":"CM"},{"ident":{"idProdMalha":"103","descrProdMalha":"PARAFUSO"},"quantProdMalha":"1","unidProdMalha":"UN"}]}'),
 (1010,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"},{"ident":{"idProdMalha":"102","descrProdMalha":"COLA A455"},"quantProdMalha":"2","unidProdMalha":"G"}]}'),
 (1011,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"},{"ident":{"idProdMalha":"102","descrProdMalha":"COLA A455"},"quantProdMalha":"2","unidProdMalha":"G"}]}'),
 (1012,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"},{"ident":{"idProdMalha":"103","descrProdMalha":"PARAFUSO"},"quantProdMalha":"2","unidProdMalha":"UN"}]}'),
 (1013,'{"itens":[{"ident":{"idProdMalha":"202","descrProdMalha":"JUMBO Y"},"quantProdMalha":"2","unidProdMalha":"M2"}]}'),
 (2000,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"2","unidProdMalha":"M2"}]}'),
 -- FIX 3: quantProdMalha='0' (fn_pcp_num→0) NÃO pode custear 0 → SKU incompleto, total NULL.
 (1006,'{"itens":[{"ident":{"idProdMalha":"101","descrProdMalha":"ROLO LIXA A"},"quantProdMalha":"0","unidProdMalha":"M2"}]}'),
 -- FIX 2: componente 998 tem CMC mas SEM omie_products (unidade não confirmada) → falta → SKU incompleto.
 (1007,'{"itens":[{"ident":{"idProdMalha":"998","descrProdMalha":"ROLO SEM PRODUTO"},"quantProdMalha":"1","unidProdMalha":"M2"}]}'),
 -- FIX 4: idProdMalha decimal ('1.5') e gigante (fora do range de bigint) → comp_cod NULL → incompleto, SEM abortar o recompute.
 (1030,'{"itens":[{"ident":{"idProdMalha":"1.5","descrProdMalha":"ROLO DECIMAL"},"quantProdMalha":"1","unidProdMalha":"M2"}]}'),
 (1031,'{"itens":[{"ident":{"idProdMalha":"99999999999999999999999","descrProdMalha":"ROLO GIGANTE"},"quantProdMalha":"1","unidProdMalha":"M2"}]}'),
 -- FIX 7: estrutura Omie VAZIA (itens=[] array vazio, 0 componentes) → sem_estrutura (custo NULL, nunca 0).
 (1040,'{"itens":[]}');

-- Oráculo da 1A: 1010 tem exceção de receita VIVA → possivel_erro_receita PROVADO. 1011 NÃO tem.
INSERT INTO pcp_bom_excecoes (pai_codigo, componente_codigo, papel, status, disposicao)
  VALUES (1010, 0, 'abrasivo_base', 'excecao', NULL);
SQL

echo "═══ ZONA 4: recompute (postgres = owner do DEFINER; auth.uid() NULL como no SQL Editor) ═══"
eq "recompute_custo_padrao processa 17 SKUs (FIX 4: id inválido/gigante NÃO aborta; FIX 7: estrutura vazia)" "$(Pq -c "SELECT fn_pcp_recompute_custo_padrao('2026-06-15')")" "17"
eq "recompute_excecoes retorna >0"           "$(Pq -c "SELECT fn_pcp_recompute_excecoes('2026-06-15')>0")" "t"

echo "═══ ZONA 5: custo-padrão (Σ buckets = total; outros conta; multi-componente soma; ambiguo) ═══"
eq "#1 custo simples: abrasivo 2×10 = 20"  "$(Pq -c "SELECT custo_abrasivo FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1000 AND versao_regra='1'")" "20"
eq "#1 custo simples: cola 3×5 = 15"       "$(Pq -c "SELECT custo_cola FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1000 AND versao_regra='1'")" "15"
eq "#1 total = Σ buckets = 35"             "$(Pq -c "SELECT custo_total FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1000 AND versao_regra='1'")" "35"
eq "#2 outro → custo_outros = 14"          "$(Pq -c "SELECT custo_outros FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1001 AND versao_regra='1'")" "14"
eq "#2 total inclui outros = 24 (não some)" "$(Pq -c "SELECT custo_total FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1001 AND versao_regra='1'")" "24"
eq "#5 multi-componente abrasivo 20+12 = 32 (não canônico)" "$(Pq -c "SELECT custo_abrasivo FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1004 AND versao_regra='1'")" "32"
eq "#5 n_componentes = 2"                  "$(Pq -c "SELECT n_componentes FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1004 AND versao_regra='1'")" "2"
eq "bucket-sep: 1020 cat=3"                "$(Pq -c "SELECT custo_catalisador FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1020 AND versao_regra='1'")" "3"
eq "bucket-sep: 1020 fita=2"               "$(Pq -c "SELECT custo_fita FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1020 AND versao_regra='1'")" "2"
eq "bucket-sep: 1020 total=27"             "$(Pq -c "SELECT custo_total FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1020 AND versao_regra='1'")" "27"
eq "#7 jsonb não-array → ambiguo"          "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1005 AND versao_regra='1'")" "ambiguo"
eq "#7 ambiguo → total NULL"               "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1005 AND versao_regra='1'")" "t"

echo "═══ ZONA 6: ausente→NULL (nunca 0) + guard de unidade ═══"
eq "#3 sem CMC → status incompleto"        "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1002 AND versao_regra='1'")" "incompleto"
eq "#3 incompleto → total NULL (não 0)"    "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1002 AND versao_regra='1'")" "t"
eq "#4 unidade malha≠estoque → unidade_divergente" "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1003 AND versao_regra='1'")" "unidade_divergente"
eq "#4 unidade_divergente → total NULL"    "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1003 AND versao_regra='1'")" "t"
eq "FIX3 qtd='0' → status incompleto"      "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1006 AND versao_regra='1'")" "incompleto"
eq "FIX3 qtd='0' → total NULL (não custeia 0)" "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1006 AND versao_regra='1'")" "t"
eq "FIX2 cmc SEM omie_products → incompleto" "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1007 AND versao_regra='1'")" "incompleto"
eq "FIX2 sem unidade confirmada → total NULL" "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1007 AND versao_regra='1'")" "t"
eq "FIX4 idProdMalha='1.5' → incompleto (não aborta)"   "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1030 AND versao_regra='1'")" "incompleto"
eq "FIX4 idProdMalha gigante → incompleto (não aborta)" "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1031 AND versao_regra='1'")" "incompleto"
eq "FIX4 id inválido → comp_cod NULL no detalhe (1030)"  "$(Pq -c "SELECT (detalhe->0->>'cod') IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1030 AND versao_regra='1'")" "t"
eq "FIX7 estrutura Omie vazia (itens=[]) → sem_estrutura"      "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "sem_estrutura"
eq "FIX7 sem_estrutura → total NULL (não 0)"                  "$(Pq -c "SELECT custo_total IS NULL FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "t"
eq "FIX7 n_componentes=0 em sem_estrutura"                    "$(Pq -c "SELECT n_componentes FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "0"
eq "FIX7 distinção: ambiguo (objeto, 1005) NÃO vira sem_estrutura" "$(Pq -c "SELECT custo_status FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1005 AND versao_regra='1'")" "ambiguo"

echo "═══ ZONA 7: data-posição fora da grade ABORTA (não zera custo em massa) ═══"
ERR=$(P -tA -c "SELECT fn_pcp_recompute_custo_padrao('2020-01-01')" 2>&1 || true)
case "$ERR" in *"inexistente na grade"*) ok "#6 data fora da grade → RAISE";; *) bad "#6 data inválida NÃO abortou: $ERR";; esac

echo "═══ ZONA 8: fila de exceções — inclusiva, temporal-coerente, classe PROVADA ═══"
eq "#8 fila INCLUI incompleto (1002 → cmc_incompleto)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1002 AND versao_regra='1'")" "cmc_incompleto"
eq "#8 cmc_incompleto: total NULL na fila"  "$(Pq -c "SELECT custo_padrao_total IS NULL FROM pcp_custo_excecoes WHERE omie_codigo_produto=1002 AND versao_regra='1'")" "t"
eq "FIX1 lixa unidade_divergente ENTRA na fila (1003)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1003 AND versao_regra='1'")" "unidade_divergente"
eq "FIX1 lixa ambiguo ENTRA na fila (1005 → estrutura_ambigua)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1005 AND versao_regra='1'")" "estrutura_ambigua"
eq "FIX7 lixa sem_estrutura ENTRA na fila (1040 → sem_estrutura)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "sem_estrutura"
eq "FIX7 sem_estrutura: impacto_r = nCMC do acabado = 12" "$(Pq -c "SELECT impacto_r FROM pcp_custo_excecoes WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "12"
eq "FIX7 sem_estrutura: custo_padrao_total NULL na fila (não 0)" "$(Pq -c "SELECT custo_padrao_total IS NULL FROM pcp_custo_excecoes WHERE omie_codigo_produto=1040 AND versao_regra='1'")" "t"
eq "#9/#12 ok sem nCMC (1000 → ncmc_ausente)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1000 AND versao_regra='1'")" "ncmc_ausente"
eq "#9 ncmc_ausente: impacto_r = custo_total = 35" "$(Pq -c "SELECT impacto_r FROM pcp_custo_excecoes WHERE omie_codigo_produto=1000 AND versao_regra='1'")" "35"
eq "#10 diverge COM exceção 1A → possivel_erro_receita" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1010 AND versao_regra='1'")" "possivel_erro_receita"
eq "#10 diverge SEM exceção 1A e SEM drift → causa_indeterminada (não acusa receita)" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1011 AND versao_regra='1'")" "causa_indeterminada"
eq "extra: custo_outros>0 → material_fora_bucket" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1012 AND versao_regra='1'")" "material_fora_bucket"
eq "extra: 2 datas CMC Δ>drift → drift_preco_provavel" "$(Pq -c "SELECT classe_causa FROM pcp_custo_excecoes WHERE omie_codigo_produto=1013 AND versao_regra='1'")" "drift_preco_provavel"
eq "#11 tingidor FORA da fila (2000 ausente)" "$(Pq -c "SELECT count(*) FROM pcp_custo_excecoes WHERE omie_codigo_produto=2000")" "0"
eq "impacto_r NOT NULL em toda a fila"      "$(Pq -c "SELECT count(*) FROM pcp_custo_excecoes WHERE impacto_r IS NULL")" "0"
eq "fila ordenável por impacto (top = 1000/35)" "$(Pq -c "SELECT omie_codigo_produto FROM pcp_custo_excecoes WHERE versao_regra='1' ORDER BY impacto_r DESC LIMIT 1")" "1000"

echo "═══ ZONA 9: idempotência (re-recompute mesma data/versão ⇒ mesmos valores, excl. derivado_em) ═══"
HR1=$(Pq -c "SELECT md5(coalesce(string_agg(omie_codigo_produto||'|'||coalesce(tipo_item,'')||'|'||custo_status||'|'||coalesce(custo_total::text,'x')||'|'||coalesce(custo_abrasivo::text,'x')||'|'||coalesce(custo_outros::text,'x')||'|'||n_componentes||'|'||n_incompletos,',' ORDER BY omie_codigo_produto),'')) FROM pcp_custo_padrao_resultados WHERE versao_regra='1'")
HE1=$(Pq -c "SELECT md5(coalesce(string_agg(omie_codigo_produto||'|'||classe_causa||'|'||impacto_r::text||'|'||coalesce(divergencia_abs::text,'x'),',' ORDER BY omie_codigo_produto),'')) FROM pcp_custo_excecoes WHERE versao_regra='1'")
Pq -c "SELECT fn_pcp_recompute_custo_padrao('2026-06-15')" >/dev/null
Pq -c "SELECT fn_pcp_recompute_excecoes('2026-06-15')" >/dev/null
HR2=$(Pq -c "SELECT md5(coalesce(string_agg(omie_codigo_produto||'|'||coalesce(tipo_item,'')||'|'||custo_status||'|'||coalesce(custo_total::text,'x')||'|'||coalesce(custo_abrasivo::text,'x')||'|'||coalesce(custo_outros::text,'x')||'|'||n_componentes||'|'||n_incompletos,',' ORDER BY omie_codigo_produto),'')) FROM pcp_custo_padrao_resultados WHERE versao_regra='1'")
HE2=$(Pq -c "SELECT md5(coalesce(string_agg(omie_codigo_produto||'|'||classe_causa||'|'||impacto_r::text||'|'||coalesce(divergencia_abs::text,'x'),',' ORDER BY omie_codigo_produto),'')) FROM pcp_custo_excecoes WHERE versao_regra='1'")
eq "#16 resultados idempotente" "$HR1" "$HR2"
eq "#16 fila idempotente"       "$HE1" "$HE2"

echo "═══ ZONA 10: versão na chave — regra nova NÃO sobrescreve a antiga ═══"
Pq -c "UPDATE pcp_config SET value=to_jsonb('2'::text) WHERE key='custo_versao_regra'" >/dev/null
Pq -c "SELECT fn_pcp_recompute_custo_padrao('2026-06-15')" >/dev/null
eq "#15 versões 1 e 2 coexistem p/ o mesmo SKU" "$(Pq -c "SELECT count(DISTINCT versao_regra) FROM pcp_custo_padrao_resultados WHERE omie_codigo_produto=1000")" "2"
Pq -c "UPDATE pcp_config SET value=to_jsonb('1'::text) WHERE key='custo_versao_regra'" >/dev/null

echo "═══ ZONA 11: RLS + view não vaza + cmc INVOKER (custo não escapa p/ não-staff) ═══"
eq "2 tabelas 2A com RLS" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pcp_custo_padrao_resultados','pcp_custo_excecoes') AND c.relrowsecurity")" "2"
eq "#14 staff lê resultados" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_custo_padrao_resultados")" "t"
eq "#14 não-staff vê 0 resultados (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_custo_padrao_resultados")" "0"
eq "#14 não-staff vê 0 na fila" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_custo_excecoes")" "0"
NS=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_recompute_custo_padrao('2026-06-15');" 2>&1 || true)
case "$NS" in *"permission denied"*|*"denied"*) ok "#14 recompute não-staff barrado (sem EXECUTE)";; *) bad "#14 recompute não-staff NÃO barrado: $NS";; esac
eq "#14 cmc INVOKER: staff vê CMC via fn" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT coalesce(fn_pcp_cmc_vigente(101,'2026-06-15'),0)>0")" "t"
eq "#14 cmc INVOKER: não-staff NÃO vê CMC (RLS barra → NULL)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_cmc_vigente(101,'2026-06-15') IS NULL")" "t"
eq "#13 view: staff vê cobertura (>0 grupos)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM vw_pcp_cmc_cobertura")" "t"
eq "#13 view NÃO vaza p/ não-staff (0 grupos)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM vw_pcp_cmc_cobertura")" "0"

echo "═══ ZONA 12: FIX 5 (excecoes valida config → RAISE) + FIX 6 (advisory lock nas 2 RPC) ═══"
Pq -c "DELETE FROM pcp_config WHERE key='custo_tolerancia_pct'" >/dev/null
ERR5=$(P -tA -c "SELECT fn_pcp_recompute_excecoes('2026-06-15')" 2>&1 || true)
case "$ERR5" in *"ausente"*) ok "FIX5 tolerância ausente → RAISE (não zera a fila em silêncio)";; *) bad "FIX5 config ausente NÃO abortou: $ERR5";; esac
Pq -c "INSERT INTO pcp_config(key,value) VALUES('custo_tolerancia_pct','0.05'::jsonb) ON CONFLICT (key) DO NOTHING" >/dev/null
eq "FIX6 advisory lock em fn_pcp_recompute_custo_padrao" "$(Pq -c "SELECT pg_get_functiondef('fn_pcp_recompute_custo_padrao(date)'::regprocedure) ~ 'pg_advisory_xact_lock'")" "t"
eq "FIX6 advisory lock em fn_pcp_recompute_excecoes"     "$(Pq -c "SELECT pg_get_functiondef('fn_pcp_recompute_excecoes(date)'::regprocedure) ~ 'pg_advisory_xact_lock'")" "t"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]

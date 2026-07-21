#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — get_customer_margin_summary (FU4-F fase 3, PR 3-zero)           ║
# ║      bash db/test-farmer-margem-server-side.sh > log 2>&1; echo "exit=$?"      ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  O que prova:                                                                  ║
# ║   · a margem sai com o VALOR EXATO, item a item (não "não explodiu")            ║
# ║   · ausente≠zero: sem custo conhecido → NULL, JAMAIS 0                          ║
# ║   · custo 0/negativo/NaN é AUSENTE, não custo válido                            ║
# ║   · a receita do item SEM custo não entra no denominador (o erro clássico)      ║
# ║   · authenticated/anon NÃO executam (42501); service_role executa               ║
# ║   · idempotência: aplicar 2× não muda nada                                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"     # 5471: fora da faixa usada pelos outros harnesses (40 worktrees)
SLUG="farmer-margem"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# usado só na falsificação: exige que o valor MUDE (o assert verdadeiro tem de ficar vermelho)
ne()  { if [ "$2" != "$3" ]; then ok "$1 (veio [$2], ≠ [$3] como esperado)"; else bad "$1 — a sabotagem NÃO mudou o resultado: assert sem dente"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stub espelhando a PROD, medido via psql-ro em 2026-07-20)
# ══════════════════════════════════════════════════════════════════════════════
# order_items/sales_orders/product_costs: só as colunas que a função lê. `quantity` e `unit_price`
# são numeric (money-path: nunca int, pra não truncar). product_id/customer_user_id são uuid.
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  status text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id),
  customer_user_id uuid,
  product_id uuid,
  omie_codigo_produto bigint,   -- reconciliação: é por aqui que o custo passa a ser encontrado
  unit_price numeric,
  quantity numeric
);
CREATE TABLE public.product_costs (
  product_id uuid PRIMARY KEY,
  cost_price numeric,
  cost_final numeric
);
-- Acrescentadas na RECONCILIAÇÃO (2026-07-21): get_customer_margin_summary passou a ser projeção
-- de private.margem_cliente_agregada(), que junta custo por `omie_codigo_produto` em vez de
-- `product_id` (product_id é NULO em 2,67% dos itens da prod, escondendo R$ 247.482,10 de custo
-- conhecido). O mapeamento abaixo é 1:1 com os product_id já semeados, então TODOS os valores
-- esperados deste harness permanecem idênticos — é essa invariância que prova que a delegação
-- preservou a intenção dos asserts originais.
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY,
  omie_codigo_produto bigint UNIQUE
);
CREATE TABLE public.cliente_classificacao (
  user_id uuid PRIMARY KEY,
  excluir_da_carteira boolean
);
-- farmer_client_scores: alvo de apply_score_updates. Nulabilidade E DEFAULTS espelham a PROD
-- (medido 2026-07-20/21: m_score/g_score/gross_margin_pct/health_score todos is_nullable=YES,
-- todos com column_default = 0). O DEFAULT 0 tem de estar aqui ou o assert do DROP DEFAULT passa
-- trivialmente — o stub precisa reproduzir a PROD, não o desenho que se quer provar.
CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  health_score numeric DEFAULT 0, health_class text, churn_risk numeric, priority_score numeric,
  rf_score numeric DEFAULT 0, m_score numeric DEFAULT 0, g_score numeric DEFAULT 0,
  gross_margin_pct numeric DEFAULT 0,
  days_since_last_purchase integer, avg_monthly_spend_180d numeric, category_count integer,
  sales_history_status text, calculated_at timestamptz, updated_at timestamptz
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723150000_farmer_margem_server_side.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# 160000 = correções de review (DROP DEFAULT + sentinela de presença de chave). Aplicada NA ORDEM,
# como o founder vai colar no SQL Editor: o teste prova a sequência real, não uma delas isolada.
MIG2="$REPO_ROOT/supabase/migrations/20260723160000_farmer_margem_correcoes_review.sql"
P -q -f "$MIG2"
echo "migration aplicada: $(basename "$MIG2")"
# 150000/160000 (helper + reconciliação): get_customer_margin_summary deixa de ter cálculo próprio
# e vira PROJEÇÃO de private.margem_cliente_agregada(). Aplicadas na ordem em que o founder vai
# colar. ⚠️ Toda restauração de falsificação abaixo tem de reaplicar as TRÊS — restaurar só a $MIG
# ressuscita o cálculo antigo e os asserts seguintes passariam a medir o objeto errado.
MIG3="$REPO_ROOT/supabase/migrations/20260726150000_margem_cliente_helper_compartilhado.sql"
MIG4="$REPO_ROOT/supabase/migrations/20260726160000_margem_reconciliacao_universo_unico.sql"
P -q -f "$MIG3"; P -q -f "$MIG4"
echo "migration aplicada: $(basename "$MIG3") + $(basename "$MIG4")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: cenários com margem EXATA, conferível à mão
# ══════════════════════════════════════════════════════════════════════════════
# C1 confirmado: (100*2 + 50*1)=250 receita, (40*2 + 30*1)=110 custo → (250-110)/250 = 56.00%
# C2 MISTURA — o cenário que separa certo de errado: item sem custo tem preço ALTO (200).
#    Correto  = (100-60)/100          = 40.00  (receita do item sem custo IGNORADA)
#    Errado   = (100+200-60)/(100+200)= 80.00  (denominador contaminado)
#    Um assert que só checasse "não é nulo" passaria nos dois. Este exige 40.00.
# C3 sem custo algum → NULL (JAMAIS 0). C4 margem negativa preservada.
# C5 cost_final=0 → tratado como AUSENTE (0 não é custo válido).
# C6 precedência: cost_final=20 vence cost_price=90 → 80.00 (se lesse cost_price daria 10.00).
# C7 fallback: cost_final NULL → usa cost_price=25 → 75.00.
# C8 pedido cancelado e C9 deleted_at → cliente NÃO aparece no resultado.
P -q <<'SQL'
INSERT INTO public.sales_orders(id, status, deleted_at) VALUES
  ('0a000000-0000-0000-0000-000000000001','confirmado',NULL),
  ('0a000000-0000-0000-0000-000000000002','cancelado', NULL),
  ('0a000000-0000-0000-0000-000000000003','confirmado','2026-01-01T00:00:00Z');

-- produtos: p1..p6 com custo; pX SEM linha em product_costs
INSERT INTO public.product_costs(product_id, cost_price, cost_final) VALUES
  ('0b000000-0000-0000-0000-000000000001', NULL, 40),   -- C1 item A
  ('0b000000-0000-0000-0000-000000000002', NULL, 30),   -- C1 item B
  ('0b000000-0000-0000-0000-000000000003', NULL, 60),   -- C2 item com custo
  ('0b000000-0000-0000-0000-000000000004', NULL, 80),   -- C4 custo > preço
  ('0b000000-0000-0000-0000-000000000005', NULL, 0),    -- C5 custo ZERO → ausente
  ('0b000000-0000-0000-0000-000000000006', 90,   20),   -- C6 precedência cost_final
  ('0b000000-0000-0000-0000-000000000007', 25,   NULL); -- C7 fallback cost_price

INSERT INTO public.order_items(sales_order_id, customer_user_id, product_id, unit_price, quantity) VALUES
  -- C1 (margem 56.00)
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000001','0b000000-0000-0000-0000-000000000001',100,2),
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000001','0b000000-0000-0000-0000-000000000002',50,1),
  -- C2 mistura (margem 40.00; item sem custo tem preço 200)
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000002','0b000000-0000-0000-0000-000000000003',100,1),
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000002','0bff0000-0000-0000-0000-0000000000ff',200,1),
  -- C3 nenhum custo (→ NULL)
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000003','0bff0000-0000-0000-0000-0000000000ff',100,1),
  -- C4 margem negativa (50-80)/50 = -60.00
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000004','0b000000-0000-0000-0000-000000000004',50,1),
  -- C5 cost_final=0 → ausente → NULL
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000005','0b000000-0000-0000-0000-000000000005',100,1),
  -- C6 precedência cost_final=20 → 80.00
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000006','0b000000-0000-0000-0000-000000000006',100,1),
  -- C7 fallback cost_price=25 → 75.00
  ('0a000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000007','0b000000-0000-0000-0000-000000000007',100,1),
  -- C8 pedido CANCELADO → cliente some
  ('0a000000-0000-0000-0000-000000000002','0c000000-0000-0000-0000-000000000008','0b000000-0000-0000-0000-000000000001',100,1),
  -- C9 pedido com deleted_at → cliente some
  ('0a000000-0000-0000-0000-000000000003','0c000000-0000-0000-0000-000000000009','0b000000-0000-0000-0000-000000000001',100,1);

-- RECONCILIAÇÃO: mapeia cada product_id semeado para um código Omie 1:1 e propaga aos itens.
-- Feito por UPDATE derivado (e não reescrevendo as 11 linhas acima) de propósito: os dados do
-- seed original ficam INTOCADOS, então qualquer mudança nos valores esperados seria da lógica
-- nova, nunca de um seed reescrito à mão.
INSERT INTO public.omie_products(id, omie_codigo_produto)
SELECT product_id, (9000 + row_number() OVER (ORDER BY product_id))::bigint
  FROM public.product_costs;
-- O SKU sem custo (0bff…ff) também ganha código: ele TEM código e NÃO tem custo — que é
-- exatamente o caso que o assert da mistura (P2) e o do "sem custo algum" (N1) exercitam.
INSERT INTO public.omie_products(id, omie_codigo_produto)
VALUES ('0bff0000-0000-0000-0000-0000000000ff', 9999);

UPDATE public.order_items oi
   SET omie_codigo_produto = op.omie_codigo_produto
  FROM public.omie_products op
 WHERE op.id = oi.product_id;
SQL

M() { Pq -c "SELECT COALESCE(gross_margin_pct::text,'NULL') FROM public.get_customer_margin_summary() WHERE customer_user_id='0c000000-0000-0000-0000-00000000000$1';"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: valor exato ──"
eq "P1 margem com custo completo"          "$(M 1)" "56.00"
eq "P2 MISTURA ignora receita sem custo"   "$(M 2)" "40.00"
eq "P4 margem NEGATIVA preservada"         "$(M 4)" "-60.00"
eq "P6 cost_final tem precedencia"         "$(M 6)" "80.00"
eq "P7 fallback p/ cost_price"             "$(M 7)" "75.00"

echo "── asserts: ausente≠zero (money-path) ──"
eq "N1 sem custo algum → NULL (nao 0)"     "$(M 3)" "NULL"
eq "N2 cost_final=0 e AUSENTE → NULL"      "$(M 5)" "NULL"

C2COM=$(Pq -c "SELECT itens_com_custo||'/'||itens_sem_custo FROM public.get_customer_margin_summary() WHERE customer_user_id='0c000000-0000-0000-0000-000000000002';")
eq "N3 contagem com/sem custo da mistura"  "$C2COM" "1/1"

echo "── asserts: filtro de pedido ──"
CANC=$(Pq -c "SELECT count(*) FROM public.get_customer_margin_summary() WHERE customer_user_id IN ('0c000000-0000-0000-0000-000000000008','0c000000-0000-0000-0000-000000000009');")
eq "N4 cancelado + deleted_at excluidos"   "$CANC" "0"

echo "── asserts: autorizacao (SECDEF fechada por privilegio) ──"
# Guard: se o SET ROLE não pegar, tudo abaixo roda como superuser e a zona vira teatro (§39 money-path).
WHO=$(Pq -c "SET ROLE authenticated; SELECT current_user;" | tail -1)
eq "guard SET ROLE pegou"                  "$WHO" "authenticated"

# Negativo com SQLSTATE explícita + re-raise. Sentinela NEGOU_42501 nunca é emitida pelo Postgres.
AUTHN=$(P -tA 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'EXECUTOU_QUANDO_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$AUTHN" | grep -q 'NEGOU_42501'; then ok "A1 authenticated NEGADO (42501)"; else bad "A1 authenticated devia ser negado — veio: $AUTHN"; fi

ANONN=$(P -tA 2>&1 <<'SQL' || true
SET ROLE anon;
DO $$
BEGIN
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'EXECUTOU_QUANDO_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$ANONN" | grep -q 'NEGOU_42501'; then ok "A2 anon NEGADO (42501)"; else bad "A2 anon devia ser negado — veio: $ANONN"; fi

SVC=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.get_customer_margin_summary();" | tail -1)
eq "A3 service_role EXECUTA"               "$SVC" "7"

echo "── asserts: apply_score_updates persiste a margem ──"
# Semeia 2 linhas de score com a margem no estado ATUAL de prod (0 fabricado).
P -q <<'SQL'
INSERT INTO public.farmer_client_scores
  (id, customer_user_id, farmer_id, health_score, health_class, churn_risk, priority_score,
   rf_score, m_score, g_score, gross_margin_pct, days_since_last_purchase,
   avg_monthly_spend_180d, category_count, calculated_at, updated_at)
VALUES
  ('0d000000-0000-0000-0000-000000000001','0c000000-0000-0000-0000-000000000001','0e000000-0000-0000-0000-00000000000f',
   1,'critico',99,1, 0,0,0, 0, 999,0,0, now(), now()),
  ('0d000000-0000-0000-0000-000000000002','0c000000-0000-0000-0000-000000000003','0e000000-0000-0000-0000-00000000000f',
   1,'critico',99,1, 0,0,0, 0, 999,0,0, now(), now());
SQL

APPLY() { Pq -c "SELECT public.apply_score_updates('$1'::jsonb);"; }
GMP() { Pq -c "SELECT COALESCE(gross_margin_pct::text,'NULL') FROM public.farmer_client_scores WHERE id='0d000000-0000-0000-0000-00000000000$1';"; }
MSC() { Pq -c "SELECT COALESCE(m_score::text,'NULL') FROM public.farmer_client_scores WHERE id='0d000000-0000-0000-0000-00000000000$1';"; }

# AP1: payload completo com margem conhecida → persiste o número.
N=$(APPLY '[{"id":"0d000000-0000-0000-0000-000000000001","health_score":50,"health_class":"estavel","churn_risk":50,"priority_score":10,"rf_score":10,"m_score":56,"g_score":10,"gross_margin_pct":56.00,"days_since_last_purchase":10,"avg_monthly_spend_180d":100,"category_count":2,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]')
eq "AP1 apply retornou 1 linha"             "$N" "1"
eq "AP1 gross_margin_pct persistido"        "$(GMP 1)" "56.00"
eq "AP1 m_score persistido"                 "$(MSC 1)" "56"

# AP2: margem DESCONHECIDA → m_score e gross_margin_pct null NÃO estouram o guard, e o null
# SOBRESCREVE o 0 antigo (é o ponto: sem isso a fabricação sobrevive ao conserto).
N2=$(APPLY '[{"id":"0d000000-0000-0000-0000-000000000002","health_score":40,"health_class":"atencao","churn_risk":60,"priority_score":5,"rf_score":8,"m_score":null,"g_score":9,"gross_margin_pct":null,"days_since_last_purchase":20,"avg_monthly_spend_180d":50,"category_count":1,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]')
eq "AP2 apply aceitou m_score null"         "$N2" "1"
eq "AP2 gross_margin_pct virou NULL"        "$(GMP 2)" "NULL"
eq "AP2 m_score virou NULL (nao 0)"         "$(MSC 2)" "NULL"

# AP3: o guard AINDA morde o que importa — health_score ausente → check_violation (23514).
GUARD=$(P -tA 2>&1 <<'SQL' || true
DO $$
BEGIN
  PERFORM public.apply_score_updates('[{"id":"0d000000-0000-0000-0000-000000000001","health_class":"x","churn_risk":1,"priority_score":1,"rf_score":1,"g_score":1,"days_since_last_purchase":1,"avg_monthly_spend_180d":1,"category_count":1,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]'::jsonb);
  RAISE EXCEPTION 'GUARD_NAO_MORDEU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'GUARD_OK_23514';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$GUARD" | grep -q 'GUARD_OK_23514'; then ok "AP3 guard barra health_score ausente (23514)"; else bad "AP3 guard NAO barrou — veio: $GUARD"; fi

echo "── asserts: chave AUSENTE ≠ chave null (sentinela de presença) ──"
# O ponto do P1.4: jsonb_to_recordset colapsa os dois casos. A distinção é o que impede um typo na
# edge ('m_scor') de NULLar a coluna inteira, E o que mantém a edge ANTIGA (sem a chave) segura
# durante a janela entre os dois deploys manuais do Lovable.
# Estado de partida: id=1 está com 56.00/56 (do AP1).
# AP4: payload SEM as chaves m_score e gross_margin_pct → tem de PRESERVAR, não zerar nem NULLar.
N4=$(APPLY '[{"id":"0d000000-0000-0000-0000-000000000001","health_score":51,"health_class":"estavel","churn_risk":49,"priority_score":11,"rf_score":11,"g_score":11,"days_since_last_purchase":11,"avg_monthly_spend_180d":101,"category_count":2,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]')
eq "AP4 apply aceitou payload sem as chaves" "$N4" "1"
eq "AP4 gross_margin_pct PRESERVADO (56.00)" "$(GMP 1)" "56.00"
eq "AP4 m_score PRESERVADO (56)"             "$(MSC 1)" "56"
HS4=$(Pq -c "SELECT health_score::text FROM public.farmer_client_scores WHERE id='0d000000-0000-0000-0000-000000000001';")
eq "AP4 o resto do payload FOI aplicado"     "$HS4" "51"

# AP5: mesma linha, agora COM a chave e valor null → tem de SOBRESCREVER para NULL.
# Contraste direto com AP4: mesmo id, mesma coluna, diferença é só a chave existir no jsonb.
N5=$(APPLY '[{"id":"0d000000-0000-0000-0000-000000000001","health_score":52,"health_class":"estavel","churn_risk":48,"priority_score":12,"rf_score":12,"m_score":null,"g_score":12,"gross_margin_pct":null,"days_since_last_purchase":12,"avg_monthly_spend_180d":102,"category_count":2,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]')
eq "AP5 apply aceitou chave com null"        "$N5" "1"
eq "AP5 gross_margin_pct virou NULL"         "$(GMP 1)" "NULL"
eq "AP5 m_score virou NULL"                  "$(MSC 1)" "NULL"

echo "── asserts: DEFAULT 0 removido (INSERT que OMITE nao fabrica 0) ──"
# O trigger reconcile_score_owner_from_carteira insere só (customer_user_id, farmer_id): com o
# DEFAULT 0 vivo, toda troca de carteira afirmava margem 0% para cliente nunca medido.
P -q -c "INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id) VALUES ('0d000000-0000-0000-0000-000000000009','0c000000-0000-0000-0000-000000000009','0e000000-0000-0000-0000-00000000000f');"
eq "D1 gross_margin_pct omitido → NULL"      "$(GMP 9)" "NULL"
eq "D2 m_score omitido → NULL"               "$(MSC 9)" "NULL"
# E o contraste: uma coluna FORA do escopo deste PR segue com o default (não mexemos onde não devia).
HS9=$(Pq -c "SELECT COALESCE(health_score::text,'NULL') FROM public.farmer_client_scores WHERE id='0d000000-0000-0000-0000-000000000009';")
eq "D3 health_score mantem DEFAULT 0"        "$HS9" "0"

echo "── assert: idempotencia (aplicar 2x) ──"
# As DUAS, na mesma ordem — inclui reaplicar o ALTER TABLE ... DROP DEFAULT (que é idempotente por
# natureza, mas isso tem de ser PROVADO, não presumido: o founder pode colar o bloco duas vezes).
P -q -f "$MIG"; P -q -f "$MIG2"; P -q -f "$MIG3"; P -q -f "$MIG4"
eq "I1 margem intacta apos 2o apply"       "$(M 1)" "56.00"
eq "I3 DROP DEFAULT idempotente"           "$(Pq -c "SELECT COALESCE(column_default,'NULL') FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='gross_margin_pct';")" "NULL"
SVC2=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.get_customer_margin_summary();" | tail -1)
eq "I2 grant intacto apos 2o apply"        "$SVC2" "7"
AUTHN2=$(P -tA 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'EXECUTOU_QUANDO_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$AUTHN2" | grep -q 'NEGOU_42501'; then ok "I3 revoke sobrevive ao 2o apply"; else bad "I3 revoke NAO sobreviveu ao 2o apply — veio: $AUTHN2"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificacao F1: ELSE NULL vira ELSE 0 (ausente≠zero perde o dente) ──"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_margin_summary()
RETURNS TABLE(customer_user_id uuid, itens_com_custo bigint, itens_sem_custo bigint,
              receita_com_custo numeric, custo_conhecido numeric, gross_margin_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  WITH itens AS (
    SELECT oi.customer_user_id, COALESCE(NULLIF(oi.quantity,0),1) AS qtd, COALESCE(oi.unit_price,0) AS preco_unit,
           CASE WHEN pc.cost_final IS NOT NULL AND pc.cost_final > 0 AND pc.cost_final <> 'NaN'::numeric THEN pc.cost_final
                WHEN pc.cost_price IS NOT NULL AND pc.cost_price > 0 AND pc.cost_price <> 'NaN'::numeric THEN pc.cost_price
                ELSE NULL END AS custo_unit
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.product_costs pc ON pc.product_id = oi.product_id
    WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL)
  SELECT i.customer_user_id,
    count(*) FILTER (WHERE i.custo_unit IS NOT NULL), count(*) FILTER (WHERE i.custo_unit IS NULL),
    COALESCE(sum(i.preco_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL),0),
    COALESCE(sum(i.custo_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL),0),
    CASE WHEN COALESCE(sum(i.preco_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL),0) > 0
      THEN round(((sum(i.preco_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL)
                 - sum(i.custo_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL))
                 / sum(i.preco_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL))*100, 2)
      ELSE 0 END                                             -- ← SABOTAGEM: fabrica 0
  FROM itens i GROUP BY i.customer_user_id;
$f$;
SQL
ne "F1 N1 fica vermelho (NULL viraria 0)"  "$(M 3)" "NULL"
ne "F1 N2 fica vermelho (custo 0)"         "$(M 5)" "NULL"

echo "── falsificacao F2: receita do item SEM custo entra no denominador ──"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_margin_summary()
RETURNS TABLE(customer_user_id uuid, itens_com_custo bigint, itens_sem_custo bigint,
              receita_com_custo numeric, custo_conhecido numeric, gross_margin_pct numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  WITH itens AS (
    SELECT oi.customer_user_id, COALESCE(NULLIF(oi.quantity,0),1) AS qtd, COALESCE(oi.unit_price,0) AS preco_unit,
           CASE WHEN pc.cost_final IS NOT NULL AND pc.cost_final > 0 AND pc.cost_final <> 'NaN'::numeric THEN pc.cost_final
                WHEN pc.cost_price IS NOT NULL AND pc.cost_price > 0 AND pc.cost_price <> 'NaN'::numeric THEN pc.cost_price
                ELSE NULL END AS custo_unit
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
    LEFT JOIN public.product_costs pc ON pc.product_id = oi.product_id
    WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
      AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL)
  SELECT i.customer_user_id,
    count(*) FILTER (WHERE i.custo_unit IS NOT NULL), count(*) FILTER (WHERE i.custo_unit IS NULL),
    COALESCE(sum(i.preco_unit*i.qtd),0),                     -- ← SABOTAGEM: sem FILTER
    COALESCE(sum(i.custo_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL),0),
    CASE WHEN COALESCE(sum(i.preco_unit*i.qtd),0) > 0
      THEN round(((sum(i.preco_unit*i.qtd)                   -- ← SABOTAGEM: denominador contaminado
                 - sum(i.custo_unit*i.qtd) FILTER (WHERE i.custo_unit IS NOT NULL))
                 / sum(i.preco_unit*i.qtd))*100, 2)
      ELSE NULL END
  FROM itens i GROUP BY i.customer_user_id;
$f$;
SQL
ne "F2 P2 fica vermelho (40.00 viraria 80.00)" "$(M 2)" "40.00"

echo "── falsificacao F3: GRANT p/ authenticated (o REVOKE perde o dente) ──"
P -q -f "$MIG"; P -q -f "$MIG2"; P -q -f "$MIG3"; P -q -f "$MIG4"                                                  # restaura a versão verdadeira
P -q -c "GRANT EXECUTE ON FUNCTION public.get_customer_margin_summary() TO authenticated;"
AUTHF=$(P -tA 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'EXECUTOU_QUANDO_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$AUTHF" | grep -q 'NEGOU_42501'; then bad "F3 sabotagem NAO teve efeito: o assert A1 nao tem dente"; else ok "F3 A1 fica vermelho com o GRANT (assert tem dente)"; fi

echo "── falsificacao F4: COALESCE em gross_margin_pct (o NULL honesto seria engolido) ──"
# Reseta a linha 2 para um valor velho plausível e tenta NULLá-la com a função SABOTADA.
P -q -c "UPDATE public.farmer_client_scores SET gross_margin_pct=42, m_score=42 WHERE id='0d000000-0000-0000-0000-000000000002';"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score = u.health_score, health_class = u.health_class, churn_risk = u.churn_risk,
    priority_score = u.priority_score, rf_score = u.rf_score, m_score = u.m_score, g_score = u.g_score,
    gross_margin_pct = COALESCE(u.gross_margin_pct, f.gross_margin_pct),   -- ← SABOTAGEM
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d = u.avg_monthly_spend_180d, category_count = u.category_count,
    calculated_at = u.calculated_at, updated_at = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id uuid, health_score numeric, health_class text, churn_risk numeric, priority_score numeric,
    rf_score numeric, m_score numeric, g_score numeric, gross_margin_pct numeric,
    days_since_last_purchase integer, avg_monthly_spend_180d numeric, category_count integer,
    calculated_at timestamptz, updated_at timestamptz)
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $f$;
SQL
APPLY '[{"id":"0d000000-0000-0000-0000-000000000002","health_score":40,"health_class":"atencao","churn_risk":60,"priority_score":5,"rf_score":8,"m_score":null,"g_score":9,"gross_margin_pct":null,"days_since_last_purchase":20,"avg_monthly_spend_180d":50,"category_count":1,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]' >/dev/null
ne "F4 AP2 fica vermelho (42 sobreviveria ao NULL)" "$(GMP 2)" "NULL"

echo "── falsificacao F5: sentinela removida (chave ausente volta a NULLar a coluna) ──"
# Sabota trocando a sentinela pelo jsonb_to_recordset cru — exatamente a versão da 150000, que é o
# que existiria se a correção do P1.4 não tivesse sido feita. Se AP4 (payload SEM as chaves) ainda
# preservar 56.00 depois disso, o assert AP4 não tem dente e não prova nada.
P -q -c "UPDATE public.farmer_client_scores SET gross_margin_pct=56.00, m_score=56 WHERE id='0d000000-0000-0000-0000-000000000001';"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $f$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score = u.health_score, health_class = u.health_class, churn_risk = u.churn_risk,
    priority_score = u.priority_score, rf_score = u.rf_score,
    m_score = u.m_score,                      -- ← SABOTAGEM: sem sentinela de presença
    g_score = u.g_score,
    gross_margin_pct = u.gross_margin_pct,    -- ← SABOTAGEM: idem
    days_since_last_purchase = u.days_since_last_purchase,
    avg_monthly_spend_180d = u.avg_monthly_spend_180d, category_count = u.category_count,
    calculated_at = u.calculated_at, updated_at = u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id uuid, health_score numeric, health_class text, churn_risk numeric, priority_score numeric,
    rf_score numeric, m_score numeric, g_score numeric, gross_margin_pct numeric,
    days_since_last_purchase integer, avg_monthly_spend_180d numeric, category_count integer,
    calculated_at timestamptz, updated_at timestamptz)
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $f$;
SQL
APPLY '[{"id":"0d000000-0000-0000-0000-000000000001","health_score":51,"health_class":"estavel","churn_risk":49,"priority_score":11,"rf_score":11,"g_score":11,"days_since_last_purchase":11,"avg_monthly_spend_180d":101,"category_count":2,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]' >/dev/null
ne "F5 AP4 fica vermelho (56.00 seria NULLado)" "$(GMP 1)" "56.00"
ne "F5 m_score idem"                            "$(MSC 1)" "56"

echo "── restauro final: migrations verdadeiras + reconferencia ──"
P -q -f "$MIG"; P -q -f "$MIG2"; P -q -f "$MIG3"; P -q -f "$MIG4"
P -q -c "REVOKE ALL ON FUNCTION public.get_customer_margin_summary() FROM authenticated;"
# R6: com a sentinela de volta, o MESMO payload sem as chaves volta a PRESERVAR (fecha o ciclo do F5).
P -q -c "UPDATE public.farmer_client_scores SET gross_margin_pct=56.00, m_score=56 WHERE id='0d000000-0000-0000-0000-000000000001';"
APPLY '[{"id":"0d000000-0000-0000-0000-000000000001","health_score":51,"health_class":"estavel","churn_risk":49,"priority_score":11,"rf_score":11,"g_score":11,"days_since_last_purchase":11,"avg_monthly_spend_180d":101,"category_count":2,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]' >/dev/null
eq "R6 sentinela restaurada (preserva de novo)" "$(GMP 1)" "56.00"
eq "R1 margem restaurada"                  "$(M 1)" "56.00"
eq "R2 mistura restaurada"                 "$(M 2)" "40.00"
eq "R3 NULL restaurado"                    "$(M 3)" "NULL"
AUTHR=$(P -tA 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.get_customer_margin_summary();
  RAISE EXCEPTION 'EXECUTOU_QUANDO_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
if echo "$AUTHR" | grep -q 'NEGOU_42501'; then ok "R4 revoke restaurado"; else bad "R4 revoke NAO restaurado — veio: $AUTHR"; fi
# R5: com a função VERDADEIRA de volta, o NULL honesto tem de sobrescrever o 42 da falsificação.
APPLY '[{"id":"0d000000-0000-0000-0000-000000000002","health_score":40,"health_class":"atencao","churn_risk":60,"priority_score":5,"rf_score":8,"m_score":null,"g_score":9,"gross_margin_pct":null,"days_since_last_purchase":20,"avg_monthly_spend_180d":50,"category_count":1,"calculated_at":"2026-07-20T00:00:00Z","updated_at":"2026-07-20T00:00:00Z"}]' >/dev/null
eq "R5 NULL sobrescreve apos restauro"      "$(GMP 2)" "NULL"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

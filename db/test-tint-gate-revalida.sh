#!/usr/bin/env bash
# Teste PG17 do GATE DE REVALIDAÇÃO tintométrica no submit (Fase 3).
# Aplica schema-snapshot + migrations 20260718213000 + 20260718233000 (canônica
# Fase 2/2b) + 20260722100001_tint_gate_revalida_submit.sql NA ORDEM de prod,
# semeia fórmulas/pedidos controlados e prova (com falsificação):
#   G0  pré-condição do seed
#   G1  item de produto COMUM (não-base-tint) sem cor fica fora do gate
#   G2  fonte 'calculado' com preço atual (ceil10) passa — sem e com desconto
#   G3  fonte 'tabela' (CSV legado) passa MESMO menor que o calc (escolha 2b)
#   G4  fonte 'cliente' com último praticado qualificado passa
#   G5  item LEGADO (lastro persistido SEM fonte) ≥ min(calc,tab) passa; sobrepreço passa
#   G6  fórmula DESATIVADA → bloqueia formula_morta (o caso do plano)
#   G7  cor inexistente → formula_morta
#   G8  receita MUDOU → preço velho na fonte 'calculado' bloqueia (caso central)
#   G9  motor NULL (corante quebrado) bloqueia TODAS as fontes (mesmo 'tabela'
#       com CSV presente — paridade selectTintPrice regra 1)
#   G10 fonte 'tabela' escolhida mas chave sem CSV → bloqueia
#   G11 fonte 'cliente' com preço de pedido NÃO-qualificado → bloqueia
#   G12 legado ABAIXO do piso min(calc,tab) → preco_obsoleto
#   G13 desconto fora de range → bloqueia; G26 d=100 → bloqueia (0 ≤ d < 100)
#   G14 tint_formula_id divergente da canônica → warning, NÃO bloqueia
#   G15 tint_ultimo_preco_cliente: qualificado mais recente vence (ignora
#       cancelado mais novo, rascunho e >180d); exclude tira o pedido corrente
#   G16 autorização: authenticated NÃO executa o gate (42501); service_role sim
#   G17 RLS/INVOKER: customer B não extrai histórico do cliente A
#   G18 paridade ceil10/round2 float8 SQL × node (Math.ceil/Math.round)
#   G19 payload misto: só o item ruim bloqueia, com index certo
#   G20 criação: base tintométrica SEM tint_cor_id → bloqueia (classificação
#       server-side pelo PRODUTO — omitir o marcador não desliga o gate, Codex P1)
#   G21 edição: base-sem-cor IDÊNTICA ao baseline (inbound) passa; alterada bloqueia
#   G22 edição: item tint IDÊNTICO ao baseline passa com warning tint_intocado
#       (mesmo abaixo do piso atual — o valor já está no Omie)
#   G23 edição: item tint ALTERADO sem metadados → revalida pelo piso → bloqueia
#   G24 edição: fonte 'cliente' NÃO se autovalida com o próprio pedido (exclude)
#   G25 metadados ausentes SEM lastro legado no persistido → bloqueia (o
#       fallback de piso não é controlável pelo caller, Codex P1)
#   G27 contexto desconhecido → payload_invalido (fail-closed)
#   F1  sabotagem: gate always-ok → bloco central cai
#   F2  sabotagem: formula_morta vira passe → G6 cai
#   F3  sabotagem: fonte 'tabela' pula o gate do motor → G9 cai
#   F4  sabotagem: último-preço sem filtros → G15 cai
#   F5  sabotagem: REVOKE só FROM PUBLIC (default privileges replicados!) → G16 cai
#   F6  sabotagem: ultimo_preco vira SECURITY DEFINER → G17 cai
#   F7  sabotagem: sem o exclude anti-autovalidação → G24 cai
#   F8  sabotagem: item sem cor ignorado sem classificar → G20 cai
#   R   restauração: migration real de volta ⇒ tudo verde
# Base estrutural: db/test-tint-canonica.sh. Pré-req: brew install postgresql@17 pgvector.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_F2="$REPO_ROOT/supabase/migrations/20260718213000_tint_formula_canonica.sql"
MIG_F2B="$REPO_ROOT/supabase/migrations/20260718233000_tint_canonica_preco_csv_legado.sql"
MIGRATION="$REPO_ROOT/supabase/migrations/20260722100001_tint_gate_revalida_submit.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5449
DATA="$(mktemp -d /tmp/pgtest-tintgate.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
for f in "$MIG_F2" "$MIG_F2B" "$MIGRATION"; do
  [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }
done

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-tintgate.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres gate_verify
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d gate_verify -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-tintgate.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -q -f "$REPO_ROOT/db/stubs-supabase.sql" || { echo "FALHA no setup: stubs"; exit 1; }
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql" || { echo "FALHA no setup: prelude"; exit 1; }
P --single-transaction -q -f "$RR" >/dev/null || { echo "FALHA no setup: snapshot"; exit 1; }
rm -f "$RR"

# Default privileges do Supabase: função NOVA nasce com EXECUTE p/ todos.
# Sem replicar isto, o REVOKE por nome da migration não tem o que morder e a
# falsificação F5 dá falso-verde (lição database.md — mordida em prod).
P -q -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;"

echo "→ migrations Fase 2 + 2b + Fase 3 na ordem de prod…"
P -q -f "$MIG_F2"  >/dev/null || { echo "FALHA: migration Fase 2 não aplicou"; exit 1; }
P -q -f "$MIG_F2B" >/dev/null || { echo "FALHA: migration Fase 2b não aplicou"; exit 1; }
P -q -f "$MIGRATION" >/dev/null || { echo "FALHA: migration Fase 3 (gate) não aplicou"; exit 1; }

restore_gate() {
  P -q -f "$MIGRATION" >/dev/null || { echo "FALHA: restore_gate não re-aplicou a migration"; exit 1; }
}

# ══════════════════════════════════════════════════════════════════════════════
# SEEDS — malha da canônica (K1/K9/K16) + pedidos p/ histórico e baselines.
#   K1 AZUL: SL válida (canônica; calc 100 + 10ml×200/810 = 102.469→ceil10 102.5)
#            × SAYERLACK csv 150 (⇒ preco_csv_legado 150, ceil10 150)
#   K9 BRANCO: só SL válida, SEM CSV (fonte tabela indisponível)
#   K16 TESTEMOTOR: só SAYERLACK, receita c/ corante-zero (motor NULL) + CSV 300
#   900001 = BASE-OK (is_tintometric base!) · 900010 = produto comum
# Pedidos do cliente A (3333…):
#   SO-A  …0a qualificado 10d R$95   ← último-preço legítimo
#   SO-B  …0b CANCELADO 2d R$50      ← não conta
#   SO-C  …0c sem omie_pedido_id 1d R$40 ← não conta
#   SO-D  …0d qualificado 200d R$60  ← fora da janela
#   SO-E  …0e qualificado 30d R$97   ← 2º mais recente qualificado
#   SO-NEW …0f rascunho, items COM metadados (fonte calculado 102.5)
#   SO-LEG …10 rascunho, items SEM metadados (valor 120) — lastro legado
#   SO-EDIT …11 faturado omie 555, 1d: [tint K1 90 SEM metadados; base s/ cor 88×2]
#   SO-EMPTY …12 rascunho items=[]
# ══════════════════════════════════════════════════════════════════════════════
echo "→ seeds…"
P -q <<'SQL' || { echo "FALHA no seed"; exit 1; }
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333'),
  ('66666666-6666-6666-6666-666666666666') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('33333333-3333-3333-3333-333333333333','customer'),
  ('66666666-6666-6666-6666-666666666666','customer') ON CONFLICT DO NOTHING;

INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem, descricao) VALUES
  ('5c000000-0000-0000-0000-000000000001','oben','SL','SL'),
  ('0d000000-0000-0000-0000-000000000001','oben','1','SAYERLACK');

INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account, is_tintometric, tint_type) VALUES
  ('0b000000-0000-0000-0000-00000000ba5e', 900001,'BASE-OK','Base OK',      100, true , 'oben', true , 'base'),
  ('0c000000-0000-0000-0000-0000000c0c01', 900003,'COR-OK','Corante OK',    200, true , 'oben', true , 'corante'),
  ('0c000000-0000-0000-0000-0000000c0c02', 900004,'COR-Z','Corante zero',     0, true , 'oben', true , 'corante'),
  ('0e000000-0000-0000-0000-000000000001', 900010,'COMUM','Produto comum',   50, true , 'oben', false, NULL);

INSERT INTO public.tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','oben','WPOK','Corante OK',   810, '0c000000-0000-0000-0000-0000000c0c01'),
  ('c0000000-0000-0000-0000-000000000002','oben','WPRU','Corante RUIM', 810, '0c000000-0000-0000-0000-0000000c0c02');

INSERT INTO public.tint_produtos  (id, account, cod_produto, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000001','oben','P1','Produto 1');
INSERT INTO public.tint_bases     (id, account, id_base_sayersystem, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000002','oben','B1','Base 1');
INSERT INTO public.tint_embalagens(id, account, id_embalagem_sayersystem, descricao, volume_ml) VALUES
  ('a0000000-0000-0000-0000-0000000000e1','oben','E900A','Galao 900A',900);

INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-00000000000a','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e');

INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  ('f1000000-0000-0000-0000-00000000005a','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f1000000-0000-0000-0000-000000000019','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',150),
  ('f9000000-0000-0000-0000-00000000005a','oben','K9','BRANCO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0160000-0000-0000-0000-000000000019','oben','K16','TESTEMOTOR','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',300);

INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f1000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f1000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f9000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0160000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000002',1, 5);

INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, omie_pedido_id, created_at, subtotal, total, items) VALUES
  ('a5000000-0000-0000-0000-00000000000a','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','faturado', 111, now() - interval '10 days', 95, 95,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":95,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-00000000000b','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','cancelado', 112, now() - interval '2 days', 50, 50,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":50,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-00000000000c','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','rascunho', NULL, now() - interval '1 day', 40, 40,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":40,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-00000000000d','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','faturado', 113, now() - interval '200 days', 60, 60,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":60,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-00000000000e','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','faturado', 114, now() - interval '30 days', 97, 97,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":97,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-00000000000f','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','rascunho', NULL, now(), 102.5, 102.5,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":102.5,"tint_cor_id":"K1","tint_nome_cor":"AZUL","tint_price_source":"calculado","tint_discount_pct":0,"tint_preco_sem_desconto":102.5}]'::jsonb),
  ('a5000000-0000-0000-0000-000000000010','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','rascunho', NULL, now(), 120, 120,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":120,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]'::jsonb),
  ('a5000000-0000-0000-0000-000000000011','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','faturado', 555, now() - interval '1 day', 266, 266,
   '[{"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":90,"tint_cor_id":"K1","tint_nome_cor":"AZUL"},
     {"omie_codigo_produto":900001,"quantidade":2,"valor_unitario":88}]'::jsonb),
  ('a5000000-0000-0000-0000-000000000012','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','rascunho', NULL, now(), 0, 0, '[]'::jsonb);

-- grants de tabela (o dump não os traz; em prod o Supabase concede e a RLS filtra)
GRANT SELECT ON public.tint_formulas, public.tint_formula_itens, public.tint_corantes,
                public.tint_subcolecoes, public.tint_skus, public.omie_products,
                public.sales_orders
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
SQL

gq() { Pq -c "$1" | tail -1; }

echo ""
echo "════════ G0 — pré-condição do seed ════════"
eq "G0a fórmulas semeadas" "$(gq 'SELECT count(*) FROM public.tint_formulas;')" "4"
eq "G0b pedidos semeados"  "$(gq 'SELECT count(*) FROM public.sales_orders;')" "9"
eq "G0c canônica de K1 é a SL" "$(gq "SELECT id::text FROM public.v_tint_formula_canonica WHERE cor_id='K1';")" "f1000000-0000-0000-0000-00000000005a"
eq "G0d calc de K1 (ceil10 via float8) = 102.5" "$(gq "SELECT (ceil(((public.get_tint_price('f1000000-0000-0000-0000-00000000005a'))->>'precoFinal')::float8 * 10) / 10)::text;")" "102.5"

# ══════════════════════════════════════════════════════════════════════════════
# Bloco central (service_role, payloads controlados — G1-G14, G19-G27)
# ══════════════════════════════════════════════════════════════════════════════
run_central() {
  P -tA 2>&1 <<'SQL'
SET ROLE service_role;
DO $$
DECLARE r jsonb; b jsonb; w jsonb;
  cliente  CONSTANT uuid := '33333333-3333-3333-3333-333333333333';
  so_empty CONSTANT uuid := 'a5000000-0000-0000-0000-000000000012';
  so_new   CONSTANT uuid := 'a5000000-0000-0000-0000-00000000000f';
  so_leg   CONSTANT uuid := 'a5000000-0000-0000-0000-000000000010';
  so_edit  CONSTANT uuid := 'a5000000-0000-0000-0000-000000000011';
BEGIN
  -- G1 produto comum sem cor → fora do gate (classificado pelo PRODUTO)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900010,"quantidade":1,"valor_unitario":1.23}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G1 FALHOU: item comum deveria passar sem gate: %', r; END IF;

  -- G2 fonte calculado exata (102.5) passa; com desconto 10% (92.25) passa
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":102.5,"tint_price_source":"calculado","tint_discount_pct":0}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G2a FALHOU: calculado exato deveria passar: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":92.25,"tint_price_source":"calculado","tint_discount_pct":10}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G2b FALHOU: calculado com desconto 10%% deveria passar: %', r; END IF;

  -- G3 fonte tabela (CSV 150) passa MESMO com calc 102.5 ≠ 150 (escolha 2b)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":150,"tint_price_source":"tabela"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G3 FALHOU: fonte tabela legítima deveria passar: %', r; END IF;

  -- G4 fonte cliente: último qualificado = 90 (SO-EDIT, 1d, real no Omie) passa
  -- na CRIAÇÃO (o exclude só tira o pedido em validação — so_empty)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":90,"tint_price_source":"cliente"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G4 FALHOU: fonte cliente com 90 (SO-EDIT qualificado) deveria passar: %', r; END IF;

  -- G5 legado COM lastro (SO-LEG sem fonte): 120 ≥ min(102.5,150) passa; 999 passa
  r := public.tint_gate_revalida('oben', cliente, so_leg, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":120}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G5a FALHOU: legado com lastro 120 >= piso deveria passar: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_leg, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":999}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G5b FALHOU: sobrepreço legado deveria passar: %', r; END IF;

  -- G7 cor inexistente → formula_morta (sem fonte: a resolução da célula vem
  -- antes do switch de fonte — com fonte declarada cairia em payload_invalido
  -- pela coerência de fórmula, que exige fórmula existente da cor)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K99","valor_unitario":100}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'formula_morta' THEN
    RAISE EXCEPTION 'G7 FALHOU: cor inexistente deveria dar formula_morta: %', r; END IF;

  -- G8 preço divergente: 90 ≠ 102.5 na fonte calculado → bloqueia
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":90,"tint_price_source":"calculado"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_divergente' THEN
    RAISE EXCEPTION 'G8 FALHOU: 90 vs calc 102.5 deveria dar preco_divergente: %', r; END IF;

  -- G9 motor NULL (K16) bloqueia MESMO fonte tabela com CSV 300 presente
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K16","tint_formula_id":"f0160000-0000-0000-0000-000000000019","valor_unitario":300,"tint_price_source":"tabela"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'sem_preco_motor' THEN
    RAISE EXCEPTION 'G9 FALHOU: motor NULL deveria barrar TODAS as fontes: %', r; END IF;

  -- G10 fonte tabela sem CSV (K9) → fonte_tabela_indisponivel
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K9","tint_formula_id":"f9000000-0000-0000-0000-00000000005a","valor_unitario":150,"tint_price_source":"tabela"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'fonte_tabela_indisponivel' THEN
    RAISE EXCEPTION 'G10 FALHOU: tabela sem CSV deveria bloquear: %', r; END IF;

  -- G11 fonte cliente com valor que SÓ existe em pedidos não-qualificados
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":50,"tint_price_source":"cliente"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_divergente' THEN
    RAISE EXCEPTION 'G11 FALHOU: preço do pedido CANCELADO não pode validar a fonte cliente: %', r; END IF;

  -- G12 legado abaixo do piso: 80 < min(102.5,150) → preco_obsoleto (lastro SO-LEG)
  r := public.tint_gate_revalida('oben', cliente, so_leg, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":80}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_obsoleto' THEN
    RAISE EXCEPTION 'G12 FALHOU: legado 80 < piso deveria dar preco_obsoleto: %', r; END IF;

  -- G13 desconto inválido (150); G26 d=100 também bloqueia (0 ≤ d < 100)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":10,"tint_price_source":"calculado","tint_discount_pct":150}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'desconto_invalido' THEN
    RAISE EXCEPTION 'G13 FALHOU: desconto 150 deveria bloquear: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":0.01,"tint_price_source":"calculado","tint_discount_pct":100}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'desconto_invalido' THEN
    RAISE EXCEPTION 'G26 FALHOU: desconto 100 deveria bloquear (0<=d<100): %', r; END IF;

  -- G14 formula_id divergente (declara a SAYERLACK, canônica é a SL): warning, passa
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-000000000019","valor_unitario":102.5,"tint_price_source":"calculado"}]');
  w := r->'warnings'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM true OR w->>'aviso' IS DISTINCT FROM 'formula_recanonizada' THEN
    RAISE EXCEPTION 'G14 FALHOU: formula divergente deveria passar COM warning: %', r; END IF;

  -- G19 payload misto: item bom + item ruim → ok=false, 1 bloqueio, index=1
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":102.5,"tint_price_source":"calculado"},
      {"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":90,"tint_price_source":"calculado"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM false
     OR jsonb_array_length(r->'bloqueios') <> 1
     OR (r->'bloqueios'->0->>'index')::int <> 1 THEN
    RAISE EXCEPTION 'G19 FALHOU: só o item 1 deveria bloquear: %', r; END IF;

  -- G20 criação: BASE tint sem cor → bloqueia (classificação pelo produto)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"quantidade":1,"valor_unitario":1}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'base_sem_cor' THEN
    RAISE EXCEPTION 'G20 FALHOU: base tint sem cor na criação deveria bloquear: %', r; END IF;

  -- G21 edição: base-sem-cor IDÊNTICA ao baseline (88×2) passa; alterada bloqueia
  r := public.tint_gate_revalida('oben', cliente, so_edit, 'edicao',
    '[{"omie_codigo_produto":900001,"quantidade":2,"valor_unitario":88},
      {"product_id":"0b000000-0000-0000-0000-00000000ba5e","omie_codigo_produto":900001,"quantidade":1,"valor_unitario":90,"tint_cor_id":"K1","tint_nome_cor":"AZUL"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G21a FALHOU: edição intocada (inbound + tint idêntico) deveria passar: %', r; END IF;
  -- G22: o tint 90 do payload acima é IDÊNTICO ao baseline → warning tint_intocado
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(r->'warnings') x
                 WHERE x.value->>'aviso' = 'tint_intocado') THEN
    RAISE EXCEPTION 'G22 FALHOU: tint idêntico deveria passar com warning tint_intocado: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_edit, 'edicao',
    '[{"omie_codigo_produto":900001,"quantidade":2,"valor_unitario":10}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'base_sem_cor_alterada' THEN
    RAISE EXCEPTION 'G21b FALHOU: base sem cor ALTERADA na edição deveria bloquear: %', r; END IF;

  -- G23 edição: tint ALTERADO (91≠90) sem metadados → piso legado → bloqueia
  r := public.tint_gate_revalida('oben', cliente, so_edit, 'edicao',
    '[{"omie_codigo_produto":900001,"quantidade":1,"valor_unitario":91,"tint_cor_id":"K1"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_obsoleto' THEN
    RAISE EXCEPTION 'G23 FALHOU: tint alterado 91 < piso deveria dar preco_obsoleto: %', r; END IF;

  -- G24 edição: fonte cliente NÃO se autovalida — exclude tira SO-EDIT (90 é o
  -- valor do PRÓPRIO pedido; o histórico legítimo é 95 do SO-A) → diverge
  r := public.tint_gate_revalida('oben', cliente, so_edit, 'edicao',
    '[{"omie_codigo_produto":900001,"quantidade":1,"valor_unitario":90,"tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","tint_price_source":"cliente"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_divergente'
     OR (b->>'esperado')::float8 IS DISTINCT FROM 95::float8 THEN
    RAISE EXCEPTION 'G24 FALHOU: fonte cliente deveria excluir o próprio pedido (esperado 95): %', r; END IF;

  -- G25 metadados ausentes SEM lastro legado → bloqueia (a: pedido sem itens;
  -- b: pedido cujo item persistido TEM fonte — payload que a omite é suspeito)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":120}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'metadados_ausentes' THEN
    RAISE EXCEPTION 'G25a FALHOU: sem metadados e sem lastro deveria bloquear: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_new, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":120}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'metadados_ausentes' THEN
    RAISE EXCEPTION 'G25b FALHOU: payload que OMITE metadados presentes no persistido deveria bloquear: %', r; END IF;

  -- G27 contexto desconhecido → payload_invalido (fail-closed)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'qualquer',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":102.5,"tint_price_source":"calculado"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'payload_invalido' THEN
    RAISE EXCEPTION 'G27 FALHOU: contexto desconhecido deveria bloquear: %', r; END IF;

  -- G28 código do produto como STRING (o edge trafega os dois — Codex P1):
  -- (a) com cor + fonte válida → resolve e passa; (b) base sem cor → bloqueia
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":"900001","tint_cor_id":"K1","tint_formula_id":"f1000000-0000-0000-0000-00000000005a","valor_unitario":102.5,"tint_price_source":"calculado"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G28a FALHOU: código string "900001" deveria resolver e passar: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":"900001","quantidade":1,"valor_unitario":1}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'base_sem_cor' THEN
    RAISE EXCEPTION 'G28b FALHOU: base sem cor com código STRING deveria bloquear (classificação não pode depender do tipo JSON): %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":"90x1","tint_cor_id":"K1","valor_unitario":102.5}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'payload_invalido' THEN
    RAISE EXCEPTION 'G28c FALHOU: código ilegível deveria ser payload_invalido, nunca "não-tint": %', r; END IF;

  -- G29 fonte 'manual' (edição humana do preço): subir é livre; abaixo do piso bloqueia
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":150,"tint_price_source":"manual"}]');
  IF (r->>'ok')::boolean IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'G29a FALHOU: manual 150 >= piso 102.5 deveria passar: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":80,"tint_price_source":"manual"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'preco_obsoleto' THEN
    RAISE EXCEPTION 'G29b FALHOU: manual 80 < piso deveria dar preco_obsoleto: %', r; END IF;

  -- G30 fonte do picker SEM/COM fórmula alheia → payload_invalido (anti-adulteração)
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","valor_unitario":102.5,"tint_price_source":"calculado"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'payload_invalido' THEN
    RAISE EXCEPTION 'G30a FALHOU: fonte declarada SEM tint_formula_id deveria bloquear: %', r; END IF;
  r := public.tint_gate_revalida('oben', cliente, so_empty, 'criacao',
    '[{"omie_codigo_produto":900001,"tint_cor_id":"K1","tint_formula_id":"f9000000-0000-0000-0000-00000000005a","valor_unitario":102.5,"tint_price_source":"calculado"}]');
  b := r->'bloqueios'->0;
  IF (r->>'ok')::boolean IS DISTINCT FROM false OR b->>'motivo' IS DISTINCT FROM 'payload_invalido' THEN
    RAISE EXCEPTION 'G30b FALHOU: fórmula de OUTRA cor (K9 num item K1) deveria bloquear: %', r; END IF;

  RAISE NOTICE 'CENTRAL_OK';
END $$;
RESET ROLE;
SQL
}

echo ""
echo "════════ G1–G27 — bloco central (baseline) ════════"
OUT="$(run_central)"
case "$OUT" in
  *CENTRAL_OK*) ok "G1–G27 baseline verde (fontes, legado-com-lastro, bloqueios, base-sem-cor, intocado, exclude, contexto)" ;;
  *) bad "baseline central NÃO passou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac

CALL_K1_CALC="SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"tint_cor_id\":\"K1\",\"tint_formula_id\":\"f1000000-0000-0000-0000-00000000005a\",\"valor_unitario\":102.5,\"tint_price_source\":\"calculado\"}]'::jsonb))"

echo ""
echo "════════ G6 — fórmula DESATIVADA bloqueia (o caso do plano) ════════"
P -q -c "UPDATE public.tint_formulas SET desativada_em = now() WHERE cor_id='K1';"
OUT="$(gq "SET ROLE service_role; $CALL_K1_CALC->'bloqueios'->0->>'motivo';")"
eq "G6a fórmula desativada → formula_morta" "$OUT" "formula_morta"
P -q -c "UPDATE public.tint_formulas SET desativada_em = NULL WHERE cor_id='K1';"
OUT="$(gq "SET ROLE service_role; $CALL_K1_CALC->>'ok';")"
eq "G6b reativada → volta a passar" "$OUT" "true"

echo ""
echo "════════ G8b — receita MUDOU: preço velho barra (caso central do plano) ════════"
P -q -c "UPDATE public.tint_formula_itens SET qtd_ml = 20 WHERE formula_id='f1000000-0000-0000-0000-00000000005a';"
OUT="$(gq "SET ROLE service_role; $CALL_K1_CALC->'bloqueios'->0->>'motivo';")"
eq "G8b receita mudada → preço velho bloqueia (preco_divergente)" "$OUT" "preco_divergente"
P -q -c "UPDATE public.tint_formula_itens SET qtd_ml = 10 WHERE formula_id='f1000000-0000-0000-0000-00000000005a';"
OUT="$(gq "SET ROLE service_role; $CALL_K1_CALC->>'ok';")"
eq "G8c receita restaurada → 102.5 volta a passar" "$OUT" "true"

echo ""
echo "════════ G15 — tint_ultimo_preco_cliente (filtros endurecidos + exclude) ════════"
# SO-EDIT (90, 1d, faturado+omie) é QUALIFICADO e o mais recente — sem exclude
# ele vence legitimamente (pedido real no Omie). Cancelado (50, 2d), rascunho
# (40, 1d) e o velho (60, 200d) NUNCA vencem — é isso que o filtro prova.
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1'))->>'price';")"
eq "G15a mais recente QUALIFICADO vence (SO-EDIT 90 — nunca o cancelado 50 nem o rascunho 40)" "$OUT" "90"
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1','a5000000-0000-0000-0000-000000000011'))->>'price';")"
eq "G15b com exclude do SO-EDIT → 95 (SO-A volta a ser o mais recente)" "$OUT" "95"
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K99')) IS NULL;")"
eq "G15c cor sem histórico → NULL" "$OUT" "t"
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('66666666-6666-6666-6666-666666666666','0b000000-0000-0000-0000-00000000ba5e','K1')) IS NULL;")"
eq "G15d cliente sem pedidos → NULL" "$OUT" "t"

echo ""
echo "════════ G16 — autorização (gate é service_role-only) ════════"
AUTH_OUT=$(P -tA 2>&1 -c "SET ROLE authenticated; SELECT public.tint_gate_revalida('oben',NULL,NULL,'criacao','[]'::jsonb);" || true)
case "$AUTH_OUT" in
  *"permission denied"*) ok "G16a authenticated NÃO executa o gate (permission denied)" ;;
  *) bad "G16a authenticated deveria tomar permission denied, veio: $(printf '%s' "$AUTH_OUT" | head -1)" ;;
esac
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben',NULL,'a5000000-0000-0000-0000-000000000012','criacao','[]'::jsonb))->>'ok';")"
eq "G16b service_role executa (payload vazio ok)" "$OUT" "true"
OUT="$(gq "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1','a5000000-0000-0000-0000-000000000011'))->>'price';")"
eq "G16c authenticated (staff) executa tint_ultimo_preco_cliente" "$OUT" "95"
ANON_OUT=$(P -tA 2>&1 -c "SET ROLE anon; SELECT public.tint_ultimo_preco_cliente(NULL,NULL,NULL,NULL);" || true)
case "$ANON_OUT" in
  *"permission denied"*) ok "G16d anon NÃO executa tint_ultimo_preco_cliente" ;;
  *) bad "G16d anon deveria tomar permission denied, veio: $(printf '%s' "$ANON_OUT" | head -1)" ;;
esac

echo ""
echo "════════ G17 — INVOKER: customer B não lê o histórico do cliente A ════════"
OUT="$(gq "SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated; SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1')) IS NULL;")"
eq "G17 customer B (RLS) → NULL para pedidos do cliente A" "$OUT" "t"

echo ""
echo "════════ G31 — multi-SKU: célula ambígua bloqueia; declarada resolve ════════"
# semeia um 2º SKU do MESMO produto Omie com fórmula K1 válida → 2 canônicas
P -q <<'SQL'
INSERT INTO public.tint_produtos  (id, account, cod_produto, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000009','oben','P2','Produto 2') ON CONFLICT DO NOTHING;
INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-00000000000b','oben','a0000000-0000-0000-0000-000000000009','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e');
INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  ('f1b00000-0000-0000-0000-00000000005a','oben','K1','AZUL','a0000000-0000-0000-0000-000000000009','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000b',NULL);
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f1b00000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10);
SQL
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"quantidade\":1,\"valor_unitario\":120,\"tint_cor_id\":\"K1\",\"tint_price_source\":\"manual\"}]'::jsonb))->'bloqueios'->0->>'motivo';")"
eq "G31a manual sem fórmula com 2 SKUs candidatos → formula_ambigua (nunca desempatar por UUID)" "$OUT" "formula_ambigua"
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"tint_cor_id\":\"K1\",\"tint_formula_id\":\"f1b00000-0000-0000-0000-00000000005a\",\"valor_unitario\":102.5,\"tint_price_source\":\"calculado\"}]'::jsonb))->>'ok';")"
eq "G31b fórmula declarada do 2º SKU resolve a célula e passa" "$OUT" "true"
P -q -c "DELETE FROM public.tint_formula_itens WHERE formula_id='f1b00000-0000-0000-0000-00000000005a';
DELETE FROM public.tint_formulas WHERE id='f1b00000-0000-0000-0000-00000000005a';
DELETE FROM public.tint_skus WHERE id='50000000-0000-0000-0000-00000000000b';"

echo ""
echo "════════ G32 — jsonb malformado no histórico não derruba a RPC ════════"
P -q -c "INSERT INTO public.sales_orders (id, customer_user_id, created_by, account, status, omie_pedido_id, created_at, subtotal, total, items) VALUES
  ('a5000000-0000-0000-0000-000000000013','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111','oben','faturado', 556, now() - interval '3 hours', 0, 0, '{\"nao\":\"array\"}'::jsonb);"
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1'))->>'price';")"
eq "G32 linha com items-objeto no meio do histórico → RPC segue funcionando (90)" "$OUT" "90"

echo ""
echo "════════ G18 — paridade float8 SQL × JS (ceil10 e round2) ════════"
SAMPLE="12.3 32.61 9.99 41.7 123.45 7.07 102.46913580246913 0.05 199.999"
SQL_OUT="$(gq "SELECT string_agg((ceil(v*10)/10)::text || ':' || (floor(v*0.9*100+0.5)/100)::text, ',' ORDER BY o)
  FROM unnest(ARRAY[${SAMPLE// /,}]::float8[]) WITH ORDINALITY AS t(v,o);")"
JS_OUT="$(node -e "
const vs=[${SAMPLE// /,}];
console.log(vs.map(v=>{
  const c=Math.ceil(v*10)/10;
  const r=Math.round(v*0.9*100)/100;
  return c+':'+r;
}).join(','));" 2>/dev/null)"
eq "G18 ceil10+round2(desc.10%) idênticos SQL float8 × node" "$SQL_OUT" "$JS_OUT"

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÕES — sabota, exige o vermelho CERTO, restaura.
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════ F1 — sabotagem: gate always-ok (aceita qualquer coisa) ════════"
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.tint_gate_revalida(p_account text, p_customer_user_id uuid, p_sales_order_id uuid, p_contexto text, p_items jsonb)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS
$$ SELECT jsonb_build_object('ok', true, 'bloqueios', '[]'::jsonb, 'warnings', '[]'::jsonb) $$;
SQL
OUT="$(run_central)"
case "$OUT" in
  *"G7 FALHOU"*|*"G8 FALHOU"*|*"G20 FALHOU"*) ok "F1 pegou a sabotagem: gate always-ok derrubou os asserts de bloqueio" ;;
  *CENTRAL_OK*) bad "F1 NÃO pegou: bloco central verde com o gate sabotado (asserts sem dente)" ;;
  *) bad "F1 caiu de forma inesperada: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac
restore_gate

echo ""
echo "════════ F2 — sabotagem: formula_morta vira passe silencioso ════════"
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f2.XXXXXX.sql")"
# migration real com o bloqueio de canônica-ausente trocado por CONTINUE
sed "s/'motivo', 'formula_morta',/'motivo', 'formula_morta_DESLIGADA',/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
P -q -c "UPDATE public.tint_formulas SET desativada_em = now() WHERE cor_id='K1';"
OUT="$(gq "SET ROLE service_role; $CALL_K1_CALC->'bloqueios'->0->>'motivo';")"
if [ "$OUT" = "formula_morta" ]; then
  bad "F2 NÃO pegou: gate sabotado ainda emitiu formula_morta (sabotagem inócua?)"
else
  ok "F2 pegou a sabotagem: motivo mudou (veio ${OUT:-vazio}) — G6a ficaria vermelho"
fi
P -q -c "UPDATE public.tint_formulas SET desativada_em = NULL WHERE cor_id='K1';"
restore_gate

echo ""
echo "════════ F3 — sabotagem: fonte 'tabela' pula o gate do motor ════════"
# migration real com o check do motor condicionado a fonte ≠ tabela
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f3.XXXXXX.sql")"
sed "s/IF v_calc_raw IS NULL THEN/IF v_calc_raw IS NULL AND COALESCE(v_item->>'tint_price_source','') <> 'tabela' THEN/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"tint_cor_id\":\"K16\",\"tint_formula_id\":\"f0160000-0000-0000-0000-000000000019\",\"valor_unitario\":300,\"tint_price_source\":\"tabela\"}]'::jsonb))->>'ok';")"
if [ "$OUT" = "true" ]; then
  ok "F3 pegou a sabotagem: K16 (motor NULL) passou pela fonte tabela (G9 ficaria vermelho)"
else
  bad "F3 NÃO provou o dente: gate sabotado ainda bloqueou K16 (veio ok=$OUT)"
fi
restore_gate

echo ""
echo "════════ F4 — sabotagem: último-preço sem filtros (inferência crua) ════════"
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.tint_ultimo_preco_cliente(p_customer_user_id uuid, p_product_id uuid, p_cor_id text, p_exclude_sales_order_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('price', (it.item->>'valor_unitario')::float8, 'date', so.created_at)
  FROM public.sales_orders so
  CROSS JOIN LATERAL jsonb_array_elements(so.items) AS it(item)
  WHERE so.customer_user_id = p_customer_user_id
    AND so.account = 'oben'
    -- SABOTADO: sem omie_pedido_id / status / janela
    AND it.item->>'product_id' = p_product_id::text
    AND it.item->>'tint_cor_id' = p_cor_id
  ORDER BY so.created_at DESC
  LIMIT 1
$$;
SQL
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1','a5000000-0000-0000-0000-000000000011'))->>'price';")"
if [ "$OUT" = "95" ]; then
  bad "F4 NÃO pegou: sem filtros ainda devolveu 95 (G15b sem dente)"
else
  ok "F4 pegou a sabotagem: sem filtros o não-qualificado venceu (veio $OUT — G15b ficaria vermelho)"
fi
restore_gate

echo ""
echo "════════ F5 — sabotagem: REVOKE só FROM PUBLIC (grant explícito sobra) ════════"
P -q -c "GRANT EXECUTE ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) TO authenticated;" >/dev/null
AUTH_OUT=$(P -tA 2>&1 -c "SET ROLE authenticated; SELECT (public.tint_gate_revalida('oben',NULL,'a5000000-0000-0000-0000-000000000012','criacao','[]'::jsonb))->>'ok';" || true)
case "$AUTH_OUT" in
  *"permission denied"*) bad "F5 NÃO provou o dente: authenticated seguiu barrado com o grant re-aberto" ;;
  *true*) ok "F5 pegou a sabotagem: com grant explícito o authenticated executa (G16a ficaria vermelho)" ;;
  *) bad "F5 resultado inesperado: $(printf '%s' "$AUTH_OUT" | head -1)" ;;
esac
restore_gate

echo ""
echo "════════ F6 — sabotagem: ultimo_preco vira SECURITY DEFINER (fura a RLS) ════════"
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f6.XXXXXX.sql")"
sed "s/^STABLE$/STABLE SECURITY DEFINER/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
OUT="$(gq "SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated; SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1')) IS NULL;")"
if [ "$OUT" = "t" ]; then
  bad "F6 NÃO provou o dente: DEFINER ainda devolveu NULL ao customer B (RLS do harness inerte?)"
else
  ok "F6 pegou a sabotagem: DEFINER vazou o histórico do cliente A ao customer B (G17 ficaria vermelho)"
fi
restore_gate

echo ""
echo "════════ F7 — sabotagem: sem o exclude anti-autovalidação ════════"
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f7.XXXXXX.sql")"
sed "s/AND (p_exclude_sales_order_id IS NULL OR so.id <> p_exclude_sales_order_id)/AND true/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000011','edicao',
  '[{\"omie_codigo_produto\":900001,\"quantidade\":1,\"valor_unitario\":90,\"tint_cor_id\":\"K1\",\"tint_formula_id\":\"f1000000-0000-0000-0000-00000000005a\",\"tint_price_source\":\"cliente\"}]'::jsonb))->>'ok';")"
if [ "$OUT" = "true" ]; then
  ok "F7 pegou a sabotagem: sem exclude o pedido validou-se com o PRÓPRIO preço (G24 ficaria vermelho)"
else
  bad "F7 NÃO provou o dente: gate sabotado ainda bloqueou a autovalidação (veio ok=$OUT)"
fi
restore_gate

echo ""
echo "════════ F8 — sabotagem: item sem cor ignorado SEM classificar o produto ════════"
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f8.XXXXXX.sql")"
sed "s/CONTINUE WHEN NOT v_is_base_tint;/CONTINUE;/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"quantidade\":1,\"valor_unitario\":1}]'::jsonb))->>'ok';")"
if [ "$OUT" = "true" ]; then
  ok "F8 pegou a sabotagem: base sem cor passou sem classificação (G20 ficaria vermelho)"
else
  bad "F8 NÃO provou o dente: gate sabotado ainda bloqueou a base sem cor (veio ok=$OUT)"
fi
restore_gate

echo ""
echo "════════ F9 — sabotagem: coerência de fórmula sempre-true (anti-adulteração morre) ════════"
TMP_SAB="$(mktemp "${TMPDIR:-/tmp}/sab-f9.XXXXXX.sql")"
sed "s/v_declarada_coerente := false;/v_declarada_coerente := true;/" "$MIGRATION" > "$TMP_SAB"
P -q -f "$TMP_SAB" >/dev/null
rm -f "$TMP_SAB"
OUT="$(gq "SET ROLE service_role; SELECT (public.tint_gate_revalida('oben','33333333-3333-3333-3333-333333333333','a5000000-0000-0000-0000-000000000012','criacao',
  '[{\"omie_codigo_produto\":900001,\"tint_cor_id\":\"K1\",\"valor_unitario\":102.5,\"tint_price_source\":\"calculado\"}]'::jsonb))->>'ok';")"
if [ "$OUT" = "true" ]; then
  ok "F9 pegou a sabotagem: fonte sem formula_id passou com a coerência desligada (G30a ficaria vermelho)"
else
  bad "F9 NÃO provou o dente: gate sabotado ainda bloqueou fonte sem formula_id (veio ok=$OUT)"
fi
restore_gate

echo ""
echo "════════ R — restauração: migration real ⇒ baseline verde de novo ════════"
OUT="$(run_central)"
case "$OUT" in
  *CENTRAL_OK*) ok "R bloco central verde com a migration real re-aplicada" ;;
  *) bad "R restauração falhou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac
OUT="$(gq "SELECT (public.tint_ultimo_preco_cliente('33333333-3333-3333-3333-333333333333','0b000000-0000-0000-0000-00000000ba5e','K1','a5000000-0000-0000-0000-000000000011'))->>'price';")"
eq "R2 ultimo_preco restaurado (95 com exclude do SO-EDIT)" "$OUT" "95"

echo ""
echo "═══════════════════════════════════════════"
echo "RESULTADO: $PASS ✅ · $FAIL ❌"
[ "$FAIL" -eq 0 ] || exit 1
echo "test-tint-gate-revalida: OK"

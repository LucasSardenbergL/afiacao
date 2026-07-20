#!/usr/bin/env bash
# Teste PG17 da FÓRMULA CANÔNICA tintométrica (Fase 2 + 2b + fix semântico —
# v_tint_formula_canonica). Aplica schema-snapshot + as migrations
# 20260718213000_tint_formula_canonica.sql, 20260718233000_tint_canonica_preco_
# csv_legado.sql E 20260722100002_tint_canonica_csv_legado_semantico.sql NA
# ORDEM (prova a cadeia de REPLACEs que prod executa),
# semeia gêmeas SL×SAYERLACK controladas e prova (com falsificação):
#   C1  preferência: SL válida vence SAYERLACK válida na mesma chave
#   C2  fallback: SL SEM receita → SAYERLACK válida vence
#   C3  não-desaparecimento das "12": só-SAYERLACK em SKU órfão segue servida
#   C4  personalizada (subcolecao NULL) aparece
#   C5  ambas inválidas → SL (linha viva) vence a congelada
#   C6  fallback por corante quebrado/órfão: SL inválida → SAYERLACK vence
#   C7  base indisponível NÃO muda a preferência (validade é POR FÓRMULA)
#   C8  não-desaparecimento GLOBAL: 1 linha por chave ativa-com-sku, sem sobra
#   C9  determinismo: duas leituras idênticas
#   C10 paridade do espelho: receita_valida ∧ base_disponivel ⟺ precoFinal da
#       RPC get_tint_prices REAL (aplicada do snapshot) não-nulo
#   C11 RLS/invoker: staff vê; customer/sem-role 0 linhas; anon 42501; service_role vê
#   F1  falsificação: rank invertido → C1 cai (vermelho CERTO, e só ele)
#   F2  falsificação: espelho de corantes frouxo (>=0) → C6 cai (1º RAISE; C10 cobriria se C6 não existisse)
#   F3  falsificação: sem o anti-join → C8 cai (2 linhas por chave)
#   F4  falsificação: tie-break invertido → C12 cai (empate resolve pro uuid errado)
#   C13 (2b) preco_csv_legado: SL canônica expõe o CSV da gêmea antiga; fallback
#       expõe o próprio; chave sem CSV → NULL (a fonte "Tabela" da vendedora)
#   F5  falsificação: preco_csv_legado lendo só a própria linha → C13 cai
#   C14 (fix semântico) FUTURE-PROOF: SL canônica com CSV PRÓPRIO populado →
#       o max IGNORA o próprio e segue devolvendo o da gêmea não-SL
#   C15 (fix semântico) ramo não-SL intacto: canônica não-SL segue com o max
#       de TODAS as ativas (inclusive uma SL com CSV — comportamento da 2b)
#   F6  falsificação: expressão da 2b de volta (max sem filtro não-SL) → C14 cai
#   F7  falsificação: exclui SL SEMPRE (sem o condicional is_sl) → C15 cai
#   R   restauração: re-aplica a migration REAL → tudo verde de novo
# Base estrutural: db/test-tint-promote.sh + db/test-tint-formulas-rls-initplan.sh.
# Pré-req: brew install postgresql@17 pgvector.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="$REPO_ROOT/supabase/migrations/20260718213000_tint_formula_canonica.sql"
MIGRATION2="$REPO_ROOT/supabase/migrations/20260718233000_tint_canonica_preco_csv_legado.sql"
MIGRATION3="$REPO_ROOT/supabase/migrations/20260722100002_tint_canonica_csv_legado_semantico.sql"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447
DATA="$(mktemp -d /tmp/pgtest-tintcanonica.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIGRATION" ] || { echo "migration ausente: $MIGRATION"; exit 1; }
[ -f "$MIGRATION2" ] || { echo "migration ausente: $MIGRATION2"; exit 1; }
[ -f "$MIGRATION3" ] || { echo "migration ausente: $MIGRATION3"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-tintcanonica.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres canonica_verify
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d canonica_verify -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-tintcanonica.XXXXXX")"
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

echo "→ migrations 20260718213000 + 20260718233000 + 20260722100002 na ordem de prod (cadeia de REPLACEs)…"
P -q -f "$MIGRATION" >/dev/null  || { echo "FALHA: migration Fase 2 não aplicou"; exit 1; }
P -q -f "$MIGRATION2" >/dev/null || { echo "FALHA: migration Fase 2b não aplicou"; exit 1; }
P -q -f "$MIGRATION3" >/dev/null || { echo "FALHA: migration fix semântico não aplicou"; exit 1; }

# Restaura a view REAL (3 migrations na ordem). DROP antes: as views sabotadas
# das falsificações têm shape divergente e REPLACE não remove/reordena coluna.
restore_view() {
  if ! P -q -c "DROP VIEW IF EXISTS public.v_tint_formula_canonica;" >/dev/null \
     || ! P -q -f "$MIGRATION" >/dev/null \
     || ! P -q -f "$MIGRATION2" >/dev/null \
     || ! P -q -f "$MIGRATION3" >/dev/null; then
    echo "FALHA: restore_view não re-aplicou as migrations"; exit 1
  fi
}

# ══════════════════════════════════════════════════════════════════════════════
# SEEDS — gêmeas controladas. UUIDs determinísticos (sufixo = papel).
#   Subcoleções: SL / '1' (SAYERLACK). Corantes: OK (200, ativo), RUIM (valor 0),
#   SEM_OMIE. SKUs: OK (omie ativo 100), ORFAO (sem omie), INATIVO (omie inativo).
# ══════════════════════════════════════════════════════════════════════════════
echo "→ seeds…"
P -q <<'SQL' || { echo "FALHA no seed"; exit 1; }
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('33333333-3333-3333-3333-333333333333','customer') ON CONFLICT DO NOTHING;

INSERT INTO public.tint_subcolecoes (id, account, id_subcolecao_sayersystem, descricao) VALUES
  ('5c000000-0000-0000-0000-000000000001','oben','SL','SL'),
  ('0d000000-0000-0000-0000-000000000001','oben','1','SAYERLACK');

INSERT INTO public.omie_products (id, omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account) VALUES
  ('0b000000-0000-0000-0000-00000000ba5e', 900001,'BASE-OK','Base OK',      100, true , 'oben'),
  ('0b000000-0000-0000-0000-00000000ba5f', 900002,'BASE-IN','Base inativa', 100, false, 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c01', 900003,'COR-OK','Corante OK',    200, true , 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c02', 900004,'COR-Z','Corante zero',     0, true , 'oben'),
  ('0c000000-0000-0000-0000-0000000c0c03', 900005,'COR-IN','Corante inativo',200, false, 'oben');

INSERT INTO public.tint_corantes (id, account, id_corante_sayersystem, descricao, volume_total_ml, omie_product_id) VALUES
  ('c0000000-0000-0000-0000-000000000001','oben','WPOK','Corante OK',   810, '0c000000-0000-0000-0000-0000000c0c01'),
  ('c0000000-0000-0000-0000-000000000002','oben','WPRU','Corante RUIM', 810, '0c000000-0000-0000-0000-0000000c0c02'),
  ('c0000000-0000-0000-0000-000000000003','oben','WPSO','Sem omie',     810, NULL),
  ('c0000000-0000-0000-0000-000000000004','oben','WPIN','Omie inativo', 810, '0c000000-0000-0000-0000-0000000c0c03'),
  ('c0000000-0000-0000-0000-000000000005','oben','WPV0','Volume zero',    0, '0c000000-0000-0000-0000-0000000c0c01');

INSERT INTO public.tint_produtos  (id, account, cod_produto, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000001','oben','P1','Produto 1');
INSERT INTO public.tint_bases     (id, account, id_base_sayersystem, descricao) VALUES
  ('a0000000-0000-0000-0000-000000000002','oben','B1','Base 1');
-- 3 embalagens: a UNIQUE de tint_skus é (account, produto, base, embalagem) —
-- cada SKU do seed precisa da sua.
INSERT INTO public.tint_embalagens(id, account, id_embalagem_sayersystem, descricao, volume_ml) VALUES
  ('a0000000-0000-0000-0000-0000000000e1','oben','E900A','Galao 900A',900),
  ('a0000000-0000-0000-0000-0000000000e2','oben','E900B','Galao 900B',900),
  ('a0000000-0000-0000-0000-0000000000e3','oben','E900C','Galao 900C',900);

INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('50000000-0000-0000-0000-00000000000a','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0b000000-0000-0000-0000-00000000ba5e'),
  ('50000000-0000-0000-0000-00000000000b','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL),
  ('50000000-0000-0000-0000-00000000000c','oben','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0b000000-0000-0000-0000-00000000ba5f');

-- Fórmulas: id sufixo f1SL/f1SA etc. Todas mesmo produto/base/embalagem (a unique
-- key diferencia por cor_id+subcoleção — como em prod). sku define a CHAVE da view.
INSERT INTO public.tint_formulas (id, account, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, preco_final_sayersystem) VALUES
  -- K1 AZUL @SKU_OK: SL válida × SAYERLACK válida → SL vence
  ('f1000000-0000-0000-0000-00000000005a','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f1000000-0000-0000-0000-000000000019','oben','K1','AZUL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',150),
  -- K2 VERDE @SKU_OK: SL SEM receita × SAYERLACK válida → SAYERLACK vence
  ('f2000000-0000-0000-0000-00000000005a','oben','K2','VERDE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f2000000-0000-0000-0000-000000000019','oben','K2','VERDE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',160),
  -- K3 DOURADO @SKU_ORFAO: só SAYERLACK com receita (as "12"/ACR MAX) → servida
  ('f3000000-0000-0000-0000-000000000019','oben','K3','DOURADO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000b',170),
  -- K4 PERS @SKU_OK: personalizada (subcolecao NULL) com receita → servida
  ('f4000000-0000-0000-0000-0000000000e0','oben','K4','PERS','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1',NULL,'50000000-0000-0000-0000-00000000000a',NULL),
  -- K5 CINZA @SKU_OK: SL sem receita × SAYERLACK sem receita → SL (viva) vence
  ('f5000000-0000-0000-0000-00000000005a','oben','K5','CINZA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f5000000-0000-0000-0000-000000000019','oben','K5','CINZA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',180),
  -- K6 ROXO @SKU_OK: SL com corante RUIM (inválida) × SAYERLACK válida → SAYERLACK
  ('f6000000-0000-0000-0000-00000000005a','oben','K6','ROXO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f6000000-0000-0000-0000-000000000019','oben','K6','ROXO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',190),
  -- K7 LARANJA @SKU_INATIVO: SL válida × SAYERLACK válida → SL (base fora do rank)
  ('f7000000-0000-0000-0000-00000000005a','oben','K7','LARANJA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',NULL),
  ('f7000000-0000-0000-0000-000000000019','oben','K7','LARANJA','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e3','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000c',200),
  -- K8 PRETO @SKU_OK: SL com corante SEM OMIE (inválida) × SAYERLACK válida → SAYERLACK
  ('f8000000-0000-0000-0000-00000000005a','oben','K8','PRETO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f8000000-0000-0000-0000-000000000019','oben','K8','PRETO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',210),
  -- K9 BRANCO @SKU_OK: só SL válida (sem gêmea) → servida
  ('f9000000-0000-0000-0000-00000000005a','oben','K9','BRANCO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  -- K10 MARROM @SKU_OK: só SL com corante RUIM → canônica INVÁLIDA (paridade: RPC nula)
  ('fa000000-0000-0000-0000-00000000005a','oben','K10','MARROM','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  -- K11 DESAT @SKU_OK: SL DESATIVADA × SAYERLACK ativa válida → SAYERLACK (desativada fora do jogo)
  ('fb000000-0000-0000-0000-00000000005a','oben','K11','DESAT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('fb000000-0000-0000-0000-000000000019','oben','K11','DESAT','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',220),
  -- K12 EMPATE @SKU_OK: SAYERLACK válida (uuid MAIOR, inserida ANTES) × personalizada
  -- válida (uuid MENOR, inserida DEPOIS) → mesmo rank 1 → menor uuid (fc…) vence.
  -- Prova que o desempate é id ASC, não ordem física nem semântica não-decidida.
  ('fd000000-0000-0000-0000-000000000019','oben','K12','EMPATE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',230),
  ('fc000000-0000-0000-0000-0000000000e0','oben','K12','EMPATE','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e2',NULL,'50000000-0000-0000-0000-00000000000a',NULL),
  -- K13/K14: cada condição do espelho de corantes com o próprio cenário — omie
  -- INATIVO (K13) e volume_total_ml=0 (K14) invalidam a SL → SAYERLACK vence.
  ('f0130000-0000-0000-0000-00000000005a','oben','K13','OMIEINATIVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0130000-0000-0000-0000-000000000019','oben','K13','OMIEINATIVO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',240),
  ('f0140000-0000-0000-0000-00000000005a','oben','K14','VOLZERO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',NULL),
  ('f0140000-0000-0000-0000-000000000019','oben','K14','VOLZERO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',250),
  -- K15 FUTURO @SKU_OK (fix semântico): SL VÁLIDA com CSV PRÓPRIO 999 (o cenário
  -- future-proof — sync populando preco_final_sayersystem na SL) × SAYERLACK
  -- válida com CSV 260 → canônica = SL; preco_csv_legado = 260 (NUNCA o próprio 999)
  ('f0150000-0000-0000-0000-00000000005a','oben','K15','FUTURO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',999),
  ('f0150000-0000-0000-0000-000000000019','oben','K15','FUTURO','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',260),
  -- K16 NAOSL @SKU_OK (fix semântico): SL SEM receita com CSV 400 (rank 2) ×
  -- SAYERLACK válida com CSV 270 (rank 1) → canônica = SAYERLACK (não-SL);
  -- preco_csv_legado = 400 (o max segue incluindo a SL — ramo não-SL intacto)
  ('f0160000-0000-0000-0000-00000000005a','oben','K16','NAOSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','5c000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',400),
  ('f0160000-0000-0000-0000-000000000019','oben','K16','NAOSL','a0000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-0000000000e1','0d000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-00000000000a',270);
UPDATE public.tint_formulas SET desativada_em = now() WHERE id='fb000000-0000-0000-0000-00000000005a';

-- Receitas (ordem NOT NULL): OK = corante bom 10ml; RUIM inclui corante zero; SEM_OMIE órfão.
INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml) VALUES
  ('f1000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f1000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f2000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f3000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f4000000-0000-0000-0000-0000000000e0','c0000000-0000-0000-0000-000000000001',1,10),
  ('f6000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f6000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000002',2, 5),
  ('f6000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f7000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f7000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f8000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000003',1,10),
  ('f8000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f9000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('fa000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000002',1, 5),
  ('fb000000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('fb000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('fd000000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('fc000000-0000-0000-0000-0000000000e0','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0130000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000004',1,10),
  ('f0130000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0140000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000005',1,10),
  ('f0140000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0150000-0000-0000-0000-00000000005a','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0150000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10),
  ('f0160000-0000-0000-0000-000000000019','c0000000-0000-0000-0000-000000000001',1,10);

-- O dump do snapshot NÃO traz os GRANTs de tabela; em prod o Supabase concede a
-- authenticated/anon (RLS filtra). security_invoker exige privilégio do CALLER
-- nas relações subjacentes — espelha o estado de prod:
GRANT SELECT ON public.tint_formulas, public.tint_formula_itens, public.tint_corantes,
                public.tint_subcolecoes, public.tint_skus, public.omie_products
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ASSERT CENTRAL (reutilizado no baseline, nas falsificações e na restauração).
# Emite 'TODOS_OK' no fim; qualquer cenário quebrado RAISE com o nome (Cn).
# ══════════════════════════════════════════════════════════════════════════════
run_asserts() {
  P -tA 2>&1 <<'SQL'
DO $$
DECLARE r record; n int; nf int; ni int; a text; b text;
BEGIN
  -- C0 pré-condição do SEED: sem isto, view vazia deixa os asserts por-cor
  -- passarem em NULL (teatro — foi exatamente o modo de falha do run 1).
  SELECT count(*) INTO nf FROM public.tint_formulas;
  SELECT count(*) INTO ni FROM public.tint_formula_itens;
  IF nf <> 28 OR ni <> 25 THEN
    RAISE EXCEPTION 'C0 FALHOU: seed incompleto (formulas=% esperado 28, itens=% esperado 25)', nf, ni; END IF;

  -- C8 não-desaparecimento GLOBAL primeiro (cardinalidade pega duplicata E omissão
  -- antes de qualquer SELECT por-cor devolver linha a mais/menos)
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.tint_formulas
    WHERE desativada_em IS NULL AND sku_id IS NOT NULL
    EXCEPT
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica) x;
  IF n <> 0 THEN RAISE EXCEPTION 'C8 FALHOU: % chaves ativas AUSENTES da view', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica
    EXCEPT
    SELECT account, sku_id, cor_id FROM public.tint_formulas
    WHERE desativada_em IS NULL AND sku_id IS NOT NULL) x;
  IF n <> 0 THEN RAISE EXCEPTION 'C8 FALHOU: % chaves na view SEM lastro na tabela', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT account, sku_id, cor_id FROM public.v_tint_formula_canonica
    GROUP BY 1,2,3 HAVING count(*) <> 1) x;
  IF n <> 0 THEN RAISE EXCEPTION 'C8 FALHOU: % chaves com != 1 linha na view (duplicata)', n; END IF;

  -- C1 preferência: canônica de K1 = a SL (IS DISTINCT FROM: linha ausente = vermelho)
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K1';
  IF r.id IS DISTINCT FROM 'f1000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'C1 FALHOU: canonica de K1 = % (is_sl=%, valida=%) — esperado a SL valida', r.id, r.is_sl, r.receita_valida; END IF;

  -- C2 fallback: SL sem receita → SAYERLACK vence
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K2';
  IF r.id IS DISTINCT FROM 'f2000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C2 FALHOU: canonica de K2 = % (esperado a SAYERLACK — SL sem receita)', r.id; END IF;

  -- C3 as "12": só-SAYERLACK em SKU órfão segue servida, válida POR FÓRMULA
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K3';
  IF r.id IS DISTINCT FROM 'f3000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false OR r.receita_valida IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'C3 FALHOU: K3 (ACR-MAX-like) = % is_sl=% valida=%', r.id, r.is_sl, r.receita_valida; END IF;

  -- C4 personalizada aparece
  SELECT id::text, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K4';
  IF r.id IS DISTINCT FROM 'f4000000-0000-0000-0000-0000000000e0' OR r.receita_valida IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'C4 FALHOU: personalizada K4 = % valida=%', r.id, r.receita_valida; END IF;

  -- C5 ambas inválidas → SL (viva) vence
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K5';
  IF r.id IS DISTINCT FROM 'f5000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C5 FALHOU: K5 (ambas sem receita) = % is_sl=% valida=%', r.id, r.is_sl, r.receita_valida; END IF;

  -- C6 corante quebrado (valor 0) invalida a SL → SAYERLACK vence
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K6';
  IF r.id IS DISTINCT FROM 'f6000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C6 FALHOU: K6 (SL c/ corante zero) = % — esperado a SAYERLACK', r.id; END IF;
  -- C6b corante órfão de omie idem
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K8';
  IF r.id IS DISTINCT FROM 'f8000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C6b FALHOU: K8 (SL c/ corante sem omie) = % — esperado a SAYERLACK', r.id; END IF;
  -- C6c corante com omie INATIVO invalida (a condição op.ativo do espelho tem dente)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K13';
  IF r.id IS DISTINCT FROM 'f0130000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C6c FALHOU: K13 (SL c/ corante de omie inativo) = % — esperado a SAYERLACK', r.id; END IF;
  -- C6d corante com volume_total_ml=0 invalida (a condição volume>0 tem dente)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K14';
  IF r.id IS DISTINCT FROM 'f0140000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C6d FALHOU: K14 (SL c/ corante volume 0) = % — esperado a SAYERLACK', r.id; END IF;

  -- C7 base indisponível não muda a preferência (validade é por-fórmula)
  SELECT id::text, is_sl, receita_valida INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K7';
  IF r.id IS DISTINCT FROM 'f7000000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true OR r.receita_valida IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'C7 FALHOU: K7 (sku inativo) = % is_sl=% — SL valida devia vencer mesmo sem base', r.id, r.is_sl; END IF;

  -- C7b desativada fora do jogo: K11 canônica = SAYERLACK (a SL está desativada)
  SELECT id::text, is_sl INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K11';
  IF r.id IS DISTINCT FROM 'fb000000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false
    THEN RAISE EXCEPTION 'C7b FALHOU: K11 (SL desativada) = % — esperado a SAYERLACK ativa', r.id; END IF;

  -- C12 empate de rank (personalizada×SAYERLACK, ambas válidas): menor uuid vence,
  -- independente da ordem de inserção (a SAYERLACK fd… foi inserida primeiro).
  SELECT id::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K12';
  IF r.id IS DISTINCT FROM 'fc000000-0000-0000-0000-0000000000e0'
    THEN RAISE EXCEPTION 'C12 FALHOU: K12 (empate rank 1) = % — esperado o menor uuid (fc…)', r.id; END IF;

  -- C13 (2b) preco_csv_legado — a fonte "Tabela (versão anterior)" da vendedora:
  -- SL canônica → CSV da gêmea antiga; fallback → o próprio; sem CSV na chave → NULL;
  -- SL desativada não participa mas a SAYERLACK ativa mantém o seu.
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K1';
  IF r.preco_csv_legado IS DISTINCT FROM '150' THEN
    RAISE EXCEPTION 'C13 FALHOU: K1 (SL canônica) preco_csv_legado=% — esperado 150 (CSV da gêmea)', r.preco_csv_legado; END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K2';
  IF r.preco_csv_legado IS DISTINCT FROM '160' THEN
    RAISE EXCEPTION 'C13 FALHOU: K2 (fallback SAYERLACK) preco_csv_legado=% — esperado 160 (próprio)', r.preco_csv_legado; END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K9';
  IF r.preco_csv_legado IS NOT NULL THEN
    RAISE EXCEPTION 'C13 FALHOU: K9 (só SL, sem CSV na chave) preco_csv_legado=% — esperado NULL', r.preco_csv_legado; END IF;
  SELECT preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K11';
  IF r.preco_csv_legado IS DISTINCT FROM '220' THEN
    RAISE EXCEPTION 'C13 FALHOU: K11 preco_csv_legado=% — esperado 220', r.preco_csv_legado; END IF;

  -- C14 (fix semântico) FUTURE-PROOF: K15 = SL canônica COM CSV PRÓPRIO (999).
  -- O max IGNORA o próprio (e qualquer SL) e devolve o da gêmea SAYERLACK (260).
  -- É o cenário que a 2b crua erraria (max incluiria o 999 da própria SL).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K15';
  IF r.id IS DISTINCT FROM 'f0150000-0000-0000-0000-00000000005a' OR r.is_sl IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'C14 FALHOU (pre-condicao): canonica de K15 = % (is_sl=%) — esperado a SL valida', r.id, r.is_sl; END IF;
  IF r.preco_csv_legado IS DISTINCT FROM '260' THEN
    RAISE EXCEPTION 'C14 FALHOU: K15 (SL canonica com CSV proprio 999) preco_csv_legado=% — esperado 260 (da gemea nao-SL; o proprio NUNCA entra)', r.preco_csv_legado; END IF;

  -- C15 (fix semântico) ramo NÃO-SL intacto: K16 = canônica SAYERLACK; o max
  -- segue o comportamento da 2b (todas as ativas, INCLUSIVE a SL com CSV 400).
  -- Pega implementação over-eager que excluísse SL sempre (daria 270).
  SELECT id::text, is_sl, preco_csv_legado::text INTO r FROM public.v_tint_formula_canonica WHERE cor_id='K16';
  IF r.id IS DISTINCT FROM 'f0160000-0000-0000-0000-000000000019' OR r.is_sl IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'C15 FALHOU (pre-condicao): canonica de K16 = % (is_sl=%) — esperado a SAYERLACK', r.id, r.is_sl; END IF;
  IF r.preco_csv_legado IS DISTINCT FROM '400' THEN
    RAISE EXCEPTION 'C15 FALHOU: K16 (canonica nao-SL) preco_csv_legado=% — esperado 400 (max inclui a SL; ramo nao-SL intacto)', r.preco_csv_legado; END IF;

  -- C9 determinismo: duas leituras idênticas (ids ordenados)
  SELECT string_agg(id::text, ',' ORDER BY id) INTO a FROM public.v_tint_formula_canonica;
  SELECT string_agg(id::text, ',' ORDER BY id) INTO b FROM public.v_tint_formula_canonica;
  IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'C9 FALHOU: leituras divergem'; END IF;

  -- C10 paridade do espelho: p/ cada canônica, receita_valida ∧ base_disponivel
  --     ⟺ precoFinal da RPC REAL (get_tint_prices) não-nulo
  FOR r IN
    SELECT v.id, v.cor_id, v.receita_valida,
           EXISTS (SELECT 1 FROM public.tint_skus s JOIN public.omie_products op ON op.id=s.omie_product_id
                   WHERE s.id=v.sku_id AND op.valor_unitario>0 AND COALESCE(op.ativo,false)) AS base_ok,
           ((public.get_tint_prices(ARRAY[v.id]) -> v.id::text ->> 'precoFinal') IS NOT NULL) AS rpc_tem_preco,
           ((public.get_tint_price(v.id) ->> 'precoFinal') IS NOT NULL) AS rpc_single_tem_preco,
           round(((public.get_tint_price(v.id) ->> 'precoFinal'))::numeric, 6) AS rpc_single_valor,
           round(((public.get_tint_prices(ARRAY[v.id]) -> v.id::text ->> 'precoFinal'))::numeric, 6) AS rpc_batch_valor
    FROM public.v_tint_formula_canonica v
  LOOP
    IF (r.receita_valida AND r.base_ok) IS DISTINCT FROM r.rpc_tem_preco THEN
      RAISE EXCEPTION 'C10 FALHOU: paridade quebrou em % (%): valida=% base=% rpc=%',
        r.cor_id, r.id, r.receita_valida, r.base_ok, r.rpc_tem_preco;
    END IF;
    IF r.rpc_single_tem_preco IS DISTINCT FROM r.rpc_tem_preco
       OR r.rpc_single_valor IS DISTINCT FROM r.rpc_batch_valor THEN
      RAISE EXCEPTION 'C10b FALHOU: singular×batch divergem em % (%): single=% batch=%',
        r.cor_id, r.id, r.rpc_single_valor, r.rpc_batch_valor;
    END IF;
  END LOOP;

  RAISE NOTICE 'TODOS_OK';
END $$;
SQL
}

echo ""
echo "════════ BASELINE (migration real) ════════"
OUT="$(run_asserts)"
case "$OUT" in
  *TODOS_OK*) ok "C1–C15 baseline verde (preferência, fallback, 12, personalizada, csv legado semântico, determinismo, paridade RPC)" ;;
  *) bad "baseline NÃO passou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac

echo ""
echo "════════ C11 — RLS/security_invoker (staff vê · customer/anon não) ════════"
# count sob um papel; qualquer erro/permissão vira string não-numérica → bad
vcnt() { Pq -c "$1 SELECT count(*) FROM public.v_tint_formula_canonica;" 2>&1 | tail -1; }
is_num() { case "$1" in ''|*[!0-9]*) return 1;; *) return 0;; esac; }
N_STAFF=$(vcnt "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;")
if is_num "$N_STAFF" && [ "$N_STAFF" -eq 16 ]; then ok "C11a staff (master) vê a view ($N_STAFF chaves)"; else bad "C11a staff: esperado 16, veio [$N_STAFF]"; fi
N_CUST=$(vcnt "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;")
eq "C11b customer autenticado NÃO vê (RLS herdada)" "$N_CUST" "0"
N_NOROLE=$(vcnt "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;")
eq "C11c authenticated sem role NÃO vê" "$N_NOROLE" "0"
ANON_OUT=$(P -tA 2>&1 -c "SET ROLE anon; SELECT count(*) FROM public.v_tint_formula_canonica;" || true)
case "$ANON_OUT" in
  *"permission denied"*) ok "C11d anon: permission denied (grant revogado)" ;;
  *) bad "C11d anon deveria tomar permission denied, veio: $(printf '%s' "$ANON_OUT" | head -1)" ;;
esac
ANON_PRIV=$(Pq -c "SELECT has_table_privilege('anon','public.v_tint_formula_canonica','SELECT');" | tail -1)
eq "C11d2 anon SEM privilégio direto na VIEW (has_table_privilege=f)" "$ANON_PRIV" "f"
N_SRV=$(vcnt "SET ROLE service_role;")
if is_num "$N_SRV" && [ "$N_SRV" -eq 16 ]; then ok "C11e service_role vê ($N_SRV chaves)"; else bad "C11e service_role: esperado 16, veio [$N_SRV]"; fi
Pq -c "RESET ROLE;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÕES — sabotar a view e exigir o vermelho CERTO (e só ele).
# Regra do repo: baseline verde ANTES (feito acima) + conferir o NOME do assert
# que cai. Depois de cada uma, a migration REAL é re-aplicada (restauração).
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "════════ F1 — sabotagem: rank invertido (SAYERLACK vence SL válida) ════════"
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 1  -- SABOTADO: 0↔1
              WHEN v.tem_receita AND v.corantes_ok             THEN 0
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 1  -- SABOTADO: 0↔1
                  WHEN w.tem_receita AND w.corantes_ok             THEN 0
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C1 FALHOU"*) ok "F1 pegou a sabotagem: C1 caiu (SAYERLACK venceu a SL válida)" ;;
  *TODOS_OK*)    bad "F1 NÃO pegou: asserts verdes com rank invertido (teste sem dente)" ;;
  *)             bad "F1 caiu no assert ERRADO: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F2 — sabotagem: espelho de corantes frouxo (>=0 aceita corante zero) ════════"
restore_view   # restaura antes de sabotar de novo
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>=0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok  -- SABOTADO: >0 → >=0
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>=0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok  -- SABOTADO
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C6 FALHOU"*) ok "F2 pegou a sabotagem: C6 caiu (SL com corante-zero virou 'válida' e venceu)" ;;
  *TODOS_OK*)    bad "F2 NÃO pegou: asserts verdes com espelho frouxo (paridade sem dente)" ;;
  *)             bad "F2 caiu no assert errado (esperado C6): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F3 — sabotagem: sem o anti-join (duplicata volta) ════════"
restore_view
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at,
       EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.id_subcolecao_sayersystem='SL') AS is_sl,
       EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
       (EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id)
        AND NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
          LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
          LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
          WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0))) AS receita_valida
FROM public.tint_formulas f
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL;  -- SABOTADO: sem NOT EXISTS
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C8 FALHOU"*) ok "F3 pegou a sabotagem: C8 caiu (duplicata voltou)" ;;
  *TODOS_OK*) bad "F3 NÃO pegou: asserts verdes sem o anti-join (não-desaparecimento sem dente)" ;;
  *)          bad "F3 caiu em assert inesperado: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F4 — sabotagem: tie-break invertido (maior uuid vence) ════════"
restore_view
# idêntica à migration real, exceto o desempate: g.id > f.id (SABOTADO)
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id > f.id)));  -- SABOTADO: < → >
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C12 FALHOU"*) ok "F4 pegou a sabotagem: C12 caiu (tie-break invertido — maior uuid venceu)" ;;
  *TODOS_OK*)     bad "F4 NÃO pegou: asserts verdes com tie-break invertido (C12 sem dente)" ;;
  *)              bad "F4 caiu no assert errado (esperado C12): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F5 — sabotagem: preco_csv_legado só da própria linha (perde a gêmea) ════════"
restore_view
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL AND g2.id = f.id) AS preco_csv_legado  -- SABOTADO: só a própria linha
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C13 FALHOU"*) ok "F5 pegou a sabotagem: C13 caiu (CSV legado perdeu a gêmea antiga)" ;;
  *TODOS_OK*)     bad "F5 NÃO pegou: asserts verdes sem o CSV da gêmea (C13 sem dente)" ;;
  *)              bad "F5 caiu no assert errado (esperado C13): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F6 — sabotagem: expressão da 2b de volta (max SEM o filtro não-SL) ════════"
restore_view
# Idêntica à migration real, exceto preco_csv_legado: a expressão CRUA da
# 20260718233000 (max de todas as ativas, incluindo a própria SL) — é a
# regressão exata que o fix semântico fecha. Só C14 (K15) deve cair: 999≠260.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL) AS preco_csv_legado  -- SABOTADO: sem o filtro não-SL (expressão da 2b)
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C14 FALHOU: K15"*) ok "F6 pegou a sabotagem: C14 caiu (max voltou a incluir o CSV próprio da SL)" ;;
  *TODOS_OK*)          bad "F6 NÃO pegou: asserts verdes com a expressão da 2b (C14 sem dente)" ;;
  *)                   bad "F6 caiu no assert errado (esperado C14/K15): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ F7 — sabotagem: exclui SL SEMPRE (sem o condicional is_sl) ════════"
restore_view
# Idêntica à migration real, exceto preco_csv_legado: o filtro não-SL aplicado
# INCONDICIONALMENTE (implementação over-eager) — muda o ramo não-SL, que o fix
# promete preservar. Só C15 (K16) deve cair: 270≠400.
P -q <<'SQL' >/dev/null
DROP VIEW IF EXISTS public.v_tint_formula_canonica;
CREATE VIEW public.v_tint_formula_canonica WITH (security_invoker = on) AS
SELECT f.id, f.account, f.sku_id, f.cor_id, f.nome_cor, f.preco_final_sayersystem,
       f.subcolecao_id, f.personalizada, f.updated_at, rf.is_sl, rf.tem_receita, rf.receita_valida,
       (SELECT max(g2.preco_final_sayersystem) FROM public.tint_formulas g2
         WHERE g2.account=f.account AND g2.sku_id=f.sku_id AND g2.cor_id=f.cor_id
           AND g2.desativada_em IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                           WHERE s2.id=g2.subcolecao_id AND s2.account=g2.account
                             AND s2.id_subcolecao_sayersystem='SL')) AS preco_csv_legado  -- SABOTADO: exclui SL SEMPRE (perdeu o NOT rf.is_sl OR)
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  SELECT v.is_sl, v.tem_receita, (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=f.subcolecao_id AND s.account=f.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=f.id) AS tem_receita,
      NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
        LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
        WHERE fi.formula_id=f.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
  ) v
) rf
WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s WHERE s.id=g.subcolecao_id AND s.account=g.account AND s.id_subcolecao_sayersystem='SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi WHERE fi.formula_id=g.id) AS tem_receita,
          NOT EXISTS (SELECT 1 FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c ON c.id=fi.corante_id
            LEFT JOIN public.omie_products op ON op.id=c.omie_product_id
            WHERE fi.formula_id=g.id AND NOT (COALESCE(op.valor_unitario,0)>0 AND COALESCE(op.ativo,false) AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml>0)) AS corantes_ok
      ) w
    ) rg
    WHERE g.account=f.account AND g.sku_id=f.sku_id AND g.cor_id=f.cor_id
      AND g.desativada_em IS NULL AND g.id<>f.id
      AND (rg.rank_pref < rf.rank_pref OR (rg.rank_pref = rf.rank_pref AND g.id < f.id)));
SQL
OUT="$(run_asserts)"
case "$OUT" in
  *"C15 FALHOU: K16"*) ok "F7 pegou a sabotagem: C15 caiu (ramo não-SL perdeu a SL do max)" ;;
  *TODOS_OK*)          bad "F7 NÃO pegou: asserts verdes excluindo SL sempre (C15 sem dente)" ;;
  *)                   bad "F7 caiu no assert errado (esperado C15/K16): $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-200)" ;;
esac

echo ""
echo "════════ R — restauração: migrations reais de volta ⇒ tudo verde ════════"
restore_view
OUT="$(run_asserts)"
case "$OUT" in
  *TODOS_OK*) ok "R restauração: C1–C15 verdes com a migration real re-aplicada" ;;
  *) bad "R restauração falhou: $(printf '%s' "$OUT" | tr '\n' ' ' | cut -c1-300)" ;;
esac

echo ""
echo "═══════════════════════════════════════════"
echo "RESULTADO: $PASS ✅ · $FAIL ❌"
[ "$FAIL" -eq 0 ] || exit 1
echo "test-tint-canonica: OK"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA da migration 20260725125000 — scrub do histórico de recomendações       ║
# ║  + guarda anti-recontaminação (FU4-F fase 3 / PR-B).                           ║
# ║                                                                                ║
# ║      bash db/test-authz-custo-fu4f-fase3-scrub.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  POR QUE ESTE HARNESS EXISTE: a migration cria DOIS triggers plpgsql, e        ║
# ║  plpgsql é late-bound — `CREATE` passa com SQL inválido e só quebra ao         ║
# ║  EXECUTAR. Um trigger BEFORE INSERT quebrado derruba TODA escrita nas duas     ║
# ║  tabelas do farmer, e o writer é best-effort: falharia calado.                 ║
# ║                                                                                ║
# ║  O assert mais importante é o A12: o trigger NÃO pode nulificar `lie`. No      ║
# ║  desenho novo essa coluna guarda o score de AFINIDADE (legítimo) — um trigger  ║
# ║  agressivo demais apagaria o ranking inteiro em vez de proteger o custo.       ║
# ║  Sabotagem S3 existe só pra provar que esse assert tem dente.                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="fu4f-scrub"
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
ne()  { if [ "$2" != "$3" ]; then ok "$1 (=$2, != $3)"; else bad "$1 — NÃO devia ser [$3], mas veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid,
  customer_user_id uuid,
  recommendation_type text,
  product_id uuid,
  current_product_id uuid,
  p_ij numeric,
  m_ij numeric,
  lie numeric,
  complexity_factor numeric,
  cluster_volume_estimate numeric,
  status text,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid,
  customer_user_id uuid,
  bundle_products jsonb NOT NULL,
  support numeric,
  confidence numeric,
  lift numeric,
  p_bundle numeric,
  m_bundle numeric,
  lie_bundle numeric,
  complexity_factor numeric,
  status text,
  created_at timestamptz DEFAULT now()
);
SQL

# ── SEED SUJO: o mundo ANTES da migration (espelha prod, medido 2026-07-21) ──
# farmer_recommendations: m_ij ÷ cluster_volume_estimate = margem unitária (134,26/2 = 67,13)
# bundle_products: "cost" literal por SKU em 24/24 elementos
P -q <<'SQL'
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, p_ij, m_ij, lie, complexity_factor, cluster_volume_estimate, status)
VALUES
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','cross_sell', 9.4, 134.26, 12.62, 1.0, 2, 'pendente'),
  ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','up_sell',    5.1,  88.00,  4.49, 1.0, 4, 'ofertado');

INSERT INTO public.farmer_bundle_recommendations
  (farmer_id, customer_user_id, bundle_products, support, confidence, lift, p_bundle, m_bundle, lie_bundle, complexity_factor, status)
VALUES
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222',
   '[{"id":"aaa","name":"Produto A","price":200,"cost":133,"margin":67},
     {"id":"bbb","name":"Produto B","price":300,"cost":210,"margin":90}]'::jsonb,
   0.25, 0.5, 1.8, 28.9, 157.0, 45.37, 1.0, 'pendente');
SQL

# ── B: CONTROLE POSITIVO — o cenário é REAL antes da migration ──────────────
# Sem isto, "tudo NULL depois" passaria trivialmente num banco que nunca teve dado.
echo "── B: controle positivo (o oráculo EXISTE antes) ──"
B1=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE m_ij IS NOT NULL;")
eq "B1 m_ij preenchido antes" "$B1" "2"
B2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE lie IS NOT NULL;")
eq "B2 lie preenchido antes" "$B2" "2"
B3=$(Pq -c "SELECT round(m_ij / cluster_volume_estimate, 2)::text FROM public.farmer_recommendations WHERE cluster_volume_estimate = 2;")
eq "B3 m_ij÷volume DEVOLVE a margem unitária (o oráculo)" "$B3" "67.13"
B4=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost';")
eq "B4 custo literal no jsonb antes" "$B4" "2"
B5=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE m_bundle IS NOT NULL;")
eq "B5 m_bundle preenchido antes" "$B5" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260725125000_authz_custo_fu4f_fase3_scrub_recomendacoes.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A: scrub do histórico ──"
A1=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE m_ij IS NOT NULL;")
eq "A1 m_ij zerado" "$A1" "0"
A2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE lie IS NOT NULL;")
eq "A2 lie MONETÁRIO zerado (invertia sozinho: m_ij ≈ lie/((p_ij/100)*cf))" "$A2" "0"
A3=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE m_bundle IS NOT NULL;")
eq "A3 m_bundle zerado" "$A3" "0"
A4=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE lie_bundle IS NOT NULL;")
eq "A4 lie_bundle zerado" "$A4" "0"
A5=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost' OR e ? 'margin';")
eq "A5 nenhuma chave cost/margin no jsonb" "$A5" "0"

# O scrub não pode ser um DELETE disfarçado: preserva o resto do jsonb e as linhas.
A6=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'id' AND e ? 'name' AND e ? 'price';")
eq "A6 id/name/price SOBREVIVERAM (não destruiu o jsonb)" "$A6" "2"
A7=$(Pq -c "SELECT string_agg(e->>'id', ',' ORDER BY ord) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) WITH ORDINALITY t(e, ord);")
eq "A7 ORDEM do array preservada" "$A7" "aaa,bbb"
A8=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations;")
eq "A8 linhas PRESERVADAS (zerei colunas, não apaguei histórico de outcome)" "$A8" "2"
A8b=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status = 'ofertado';")
eq "A8b status de outcome intacto" "$A8b" "1"
# cluster_volume_estimate FICA: é contagem de compradores, não custo — e sem m_ij não há divisão.
A9=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE cluster_volume_estimate IS NOT NULL;")
eq "A9 cluster_volume_estimate preservado (contagem, não custo)" "$A9" "2"

echo "── T: guarda anti-recontaminação (trigger plpgsql — LATE-BOUND, só falha executando) ──"
# A aba antiga (bundle JS pré-Publish) continua mandando m_ij/cost. Sem o trigger, ela
# regravaria custo em linhas FRESCAS — pior que o dado velho.
# CTE p/ o comando EXTERNO ser um SELECT: `INSERT ... RETURNING` no psql -tA devolve o valor
# E a command tag ("INSERT 0 1") na linha seguinte, o que quebrava a comparação exata.
T1=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_recommendations (farmer_id, p_ij, m_ij, status) VALUES ('11111111-1111-1111-1111-111111111111', 9.4, 99.99, 'pendente') RETURNING m_ij) SELECT coalesce(m_ij::text,'NULL') FROM ins;")
eq "T1 INSERT com m_ij=99.99 → gravou NULL" "$T1" "NULL"

P -q -c "UPDATE public.farmer_recommendations SET m_ij = 77.77 WHERE status = 'ofertado';"
T2=$(Pq -c "SELECT coalesce(m_ij::text,'NULL') FROM public.farmer_recommendations WHERE status = 'ofertado';")
eq "T2 UPDATE tentando m_ij=77.77 → NULL" "$T2" "NULL"

T3=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_bundle_recommendations (farmer_id, bundle_products, m_bundle, status) VALUES ('11111111-1111-1111-1111-111111111111', '[{\"id\":\"ccc\",\"name\":\"C\",\"price\":50,\"cost\":30,\"margin\":20}]'::jsonb, 500, 'pendente') RETURNING bundle_products) SELECT (bundle_products->0) ? 'cost' FROM ins;")
eq "T3 INSERT com cost no jsonb → chave removida" "$T3" "f"
T3b=$(Pq -c "SELECT coalesce(m_bundle::text,'NULL') FROM public.farmer_bundle_recommendations WHERE (bundle_products->0->>'id') = 'ccc';")
eq "T3b m_bundle do INSERT novo → NULL" "$T3b" "NULL"
T3c=$(Pq -c "SELECT (bundle_products->0->>'price') FROM public.farmer_bundle_recommendations WHERE (bundle_products->0->>'id') = 'ccc';")
eq "T3c price preservado no INSERT (trigger cirúrgico, não destrutivo)" "$T3c" "50"

# ⚠️ O ASSERT MAIS IMPORTANTE. `lie` passou a guardar o score de AFINIDADE (adimensional,
# legítimo). Um trigger que nulificasse `lie` junto apagaria o ranking do motor NOVO — trocaria
# um vazamento de custo por uma feature morta. Falsificado em S3.
T4=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_recommendations (farmer_id, p_ij, lie, status) VALUES ('11111111-1111-1111-1111-111111111111', 9.4, 0.0094, 'pendente') RETURNING lie) SELECT coalesce(lie::text,'NULL') FROM ins;")
eq "T4 lie (AFINIDADE) SOBREVIVE ao trigger — senão o ranking novo morre" "$T4" "0.0094"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── S: falsificação (cada assert tem de MORDER) ──"

# S1 — trigger sem o NEW.m_ij := NULL → T1 tem de virar vermelho
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.frec_sem_margem() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', pg_temp
AS $fn$ BEGIN RETURN NEW; END $fn$;
SQL
S1=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_recommendations (farmer_id, p_ij, m_ij, status) VALUES ('11111111-1111-1111-1111-111111111111', 1, 42.42, 'pendente') RETURNING m_ij) SELECT coalesce(m_ij::text,'NULL') FROM ins;")
ne "S1 sabotagem do trigger m_ij faz T1 MORDER" "$S1" "NULL"
P -q -f "$MIG" >/dev/null   # restaura a versão verdadeira

# S2 — scrub que limpa só m_ij (a versão que eu ia escrever antes do Codex) → A2 morde
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, p_ij, lie, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', 9.4, 12.62, 1.0, 'pendente');"
P -q -c "UPDATE public.farmer_recommendations SET m_ij = NULL WHERE m_ij IS NOT NULL;"  -- scrub PARCIAL
S2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE lie IS NOT NULL;")
ne "S2 scrub só-de-m_ij deixa lie vivo → A2 MORDE (lie inverte sozinho)" "$S2" "0"
P -q -c "UPDATE public.farmer_recommendations SET lie = NULL;"   # restaura

# S3 — trigger AGRESSIVO que também nulifica lie → T4 tem de virar vermelho.
# Prova que T4 não é decorativo: sem ele, um trigger "mais seguro" mataria o ranking.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.frec_sem_margem() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', pg_temp
AS $fn$ BEGIN NEW.m_ij := NULL; NEW.lie := NULL; RETURN NEW; END $fn$;
SQL
S3=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_recommendations (farmer_id, p_ij, lie, status) VALUES ('11111111-1111-1111-1111-111111111111', 9.4, 0.0094, 'pendente') RETURNING lie) SELECT coalesce(lie::text,'NULL') FROM ins;")
eq "S3 trigger agressivo MATA o lie de afinidade → T4 MORDE" "$S3" "NULL"
P -q -f "$MIG" >/dev/null   # restaura

# S4 — scrub que não limpa o jsonb → A5 morde
P -q -c "INSERT INTO public.farmer_bundle_recommendations (farmer_id, bundle_products, status) VALUES ('11111111-1111-1111-1111-111111111111', '[{\"id\":\"zzz\",\"name\":\"Z\",\"price\":10}]'::jsonb, 'pendente');"
# injeta o custo por baixo do trigger (o trigger é BEFORE; aqui simulamos o dado legado já gravado)
P -q -c "ALTER TABLE public.farmer_bundle_recommendations DISABLE TRIGGER trg_fbrec_sem_margem;"
P -q -c "UPDATE public.farmer_bundle_recommendations SET bundle_products = '[{\"id\":\"zzz\",\"name\":\"Z\",\"price\":10,\"cost\":6}]'::jsonb WHERE (bundle_products->0->>'id') = 'zzz';"
S4=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost';")
ne "S4 sem a limpeza do jsonb o custo literal fica → A5 MORDE" "$S4" "0"
P -q -c "ALTER TABLE public.farmer_bundle_recommendations ENABLE TRIGGER trg_fbrec_sem_margem;"
P -q -f "$MIG" >/dev/null   # restaura (re-roda o scrub, que limpa o que injetamos)

# ── pós-restauro: a migration é IDEMPOTENTE e o mundo voltou ao estado limpo ──
echo "── R: pós-restauro (a migration re-roda sem estragar) ──"
R1=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost' OR e ? 'margin';")
eq "R1 jsonb limpo após re-aplicar" "$R1" "0"
R2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE m_ij IS NOT NULL OR lie IS NOT NULL;")
eq "R2 m_ij/lie limpos após re-aplicar (idempotente)" "$R2" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

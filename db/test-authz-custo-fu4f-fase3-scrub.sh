#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA da CADEIA 20260725121000 → 125000 → 126000 (FU4-F fase 3 / PR-B):       ║
# ║  colunas de afinidade → scrub do histórico → guarda anti-recontaminação.       ║
# ║                                                                                ║
# ║      bash db/test-authz-custo-fu4f-fase3-scrub.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                                ║
# ║  POR QUE ESTE HARNESS EXISTE: a migration cria DOIS triggers plpgsql, e        ║
# ║  plpgsql é late-bound — `CREATE` passa com SQL inválido e só quebra ao         ║
# ║  EXECUTAR. Um trigger BEFORE INSERT quebrado derruba TODA escrita nas duas     ║
# ║  tabelas do farmer, e o writer é best-effort: falharia calado.                 ║
# ║                                                                                ║
# ║  O par de asserts que carrega o desenho é T4/T5, e ele INVERTEU: o trigger     ║
# ║  agora nulifica `lie` SEMPRE (é dinheiro, inverte para margem) e NÃO toca      ║
# ║  `affinity_score` (adimensional, é o ranking). Até a 125000 valia o oposto —   ║
# ║  `lie` guardava a afinidade, e o resíduo estava DECLARADO na própria migration.║
# ║  As duas metades precisam de sabotagem própria: S3 (trigger que preserva o     ║
# ║  lie, = a 125000 sozinha) e S5 (trigger que mata a afinidade).                 ║
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
MIG121="$REPO_ROOT/supabase/migrations/20260725121000_authz_custo_fu4f_fase3_afinidade_colunas.sql"
MIG="$REPO_ROOT/supabase/migrations/20260725125000_authz_custo_fu4f_fase3_scrub_recomendacoes.sql"
MIG126="$REPO_ROOT/supabase/migrations/20260725126000_authz_custo_fu4f_fase3_trigger_nulifica_lie.sql"

# ── P: as PRECONDIÇÕES da 126000 abortam fora de ordem ──────────────────────
# O founder cola uma migration de cada vez, à mão. Fora de ordem a 126000 nulificaria `lie`
# sem que a afinidade tivesse para onde ir — ranking morto em silêncio. O banco tem de recusar.
# Assert negativo com sentinela ANTI-TEATRO: a sentinela ('affinity_score/affinity_bundle
# ausentes') é o texto da mensagem ESPERADA e não aparece em nenhuma outra RAISE do arquivo.
echo "── P: precondições de ORDEM (fail-closed) ──"
if P -q -f "$MIG126" > /tmp/p0-${SLUG}.log 2>&1; then
  bad "P0 126000 aplicou SEM as colunas de afinidade — precondição não existe"
else
  if command grep -q "affinity_score/affinity_bundle ausentes" "/tmp/p0-${SLUG}.log"; then
    ok "P0 126000 ABORTA sem as colunas (nulificar lie sem substituto mataria o ranking)"
  else
    bad "P0 126000 falhou, mas por OUTRO motivo: $(command grep -m1 ERROR "/tmp/p0-${SLUG}.log" || echo '(sem ERROR no log)')"
  fi
fi

P -q -f "$MIG121"
echo "migration aplicada: $(basename "$MIG121")"

if P -q -f "$MIG126" > /tmp/p1-${SLUG}.log 2>&1; then
  bad "P1 126000 aplicou SEM a 125000 — o scrub do histórico e a limpeza do jsonb ficariam de fora"
else
  if command grep -q "frec_sem_margem/fbrec_sem_margem ausentes" "/tmp/p1-${SLUG}.log"; then
    ok "P1 126000 ABORTA sem a 125000 (ela é quem faz o scrub que esta endurece)"
  else
    bad "P1 126000 falhou, mas por OUTRO motivo: $(command grep -m1 ERROR "/tmp/p1-${SLUG}.log" || echo '(sem ERROR no log)')"
  fi
fi

# C: a 121000 é ADITIVA — cria as colunas e não toca o dado que o seed sujo plantou.
C1=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='farmer_recommendations' AND column_name='affinity_score') OR (table_name='farmer_bundle_recommendations' AND column_name='affinity_bundle'));")
eq "C1 as duas colunas de afinidade existem após a 121000" "$C1" "2"
C2=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('affinity_score','affinity_bundle') AND column_default IS NOT NULL;")
eq "C2 nascem SEM default (default constante viraria 'afinidade 0 medida' no histórico)" "$C2" "0"
C3=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE m_ij IS NOT NULL;")
eq "C3 a 121000 NÃO scrubou nada — é aditiva (m_ij segue sujo até a 125000)" "$C3" "2"

P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
P -q -f "$MIG126"
echo "migration aplicada: $(basename "$MIG126")"

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

# ⚠️ O PAR QUE CARREGA O DESENHO (T4/T5, e T6/T7 no bundle). Um único INSERT da "aba antiga"
# manda as DUAS coisas, e o trigger tem de separá-las: `lie` é DINHEIRO e inverte para margem
# (m_ij ≈ lie/((p_ij/100)×cf)) ⇒ morre; `affinity_score` é adimensional e é o ranking ⇒ vive.
# Até a 125000 o assert era o OPOSTO — `lie` guardava a afinidade, e a própria migration
# declarava o resíduo ("uma aba antiga ainda consegue gravar lie monetário"). A coluna dedicada
# (20260725121000) é o que permite fechá-lo. Falsificados em S3 (preserva o lie) e S5 (mata a
# afinidade): as duas metades erram em direções opostas e precisam de sabotagem cada uma.
UUID_T='44444444-4444-4444-4444-444444444444'
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, p_ij, lie, affinity_score, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', '$UUID_T', 9.4, 12.62, 0.0094, 1.0, 'pendente');"
T4=$(Pq -c "SELECT coalesce(lie::text,'NULL') FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';")
eq "T4 lie MONETÁRIO (12.62) nulificado pelo trigger — a aba antiga não recontamina" "$T4" "NULL"
T5=$(Pq -c "SELECT coalesce(affinity_score::text,'NULL') FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';")
eq "T5 affinity_score SOBREVIVE ao trigger — senão o ranking novo morre" "$T5" "0.0094"

UUID_B='55555555-5555-5555-5555-555555555555'
P -q -c "INSERT INTO public.farmer_bundle_recommendations (farmer_id, customer_user_id, bundle_products, p_bundle, lie_bundle, affinity_bundle, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', '$UUID_B', '[{\"id\":\"ddd\",\"name\":\"D\",\"price\":80}]'::jsonb, 28.9, 45.37, 0.0031, 1.0, 'pendente');"
T6=$(Pq -c "SELECT coalesce(lie_bundle::text,'NULL') FROM public.farmer_bundle_recommendations WHERE customer_user_id = '$UUID_B';")
eq "T6 lie_bundle MONETÁRIO (45.37) nulificado — era o que virava 'R\$ 0,01' no PlanCard" "$T6" "NULL"
T7=$(Pq -c "SELECT coalesce(affinity_bundle::text,'NULL') FROM public.farmer_bundle_recommendations WHERE customer_user_id = '$UUID_B';")
eq "T7 affinity_bundle SOBREVIVE — é ele que ordena a oferta crua e o plano tático" "$T7" "0.0031"

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
P -q -f "$MIG126" >/dev/null   # restaura a versão verdadeira (a 126000 recria as DUAS funções)

# S2 — scrub que limpa só m_ij (a versão que eu ia escrever antes do Codex) → A2 morde.
# O INSERT vai POR BAIXO do trigger (DISABLE): com a guarda viva o `lie` já nasceria NULL e a
# sabotagem mediria a guarda, não o scrub — ficaria verde por acidente e "provaria" o nada.
P -q -c "ALTER TABLE public.farmer_recommendations DISABLE TRIGGER trg_frec_sem_margem;"
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, p_ij, lie, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', 9.4, 12.62, 1.0, 'pendente');"
P -q -c "UPDATE public.farmer_recommendations SET m_ij = NULL WHERE m_ij IS NOT NULL;"  -- scrub PARCIAL
S2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE lie IS NOT NULL;")
ne "S2 scrub só-de-m_ij deixa lie vivo → A2 MORDE (lie inverte sozinho)" "$S2" "0"
P -q -c "ALTER TABLE public.farmer_recommendations ENABLE TRIGGER trg_frec_sem_margem;"
P -q -f "$MIG126" >/dev/null   # restaura (o re-scrub da 126000 limpa o lie que injetamos)

# S3 — trigger que PRESERVA o lie (= exatamente a 125000 sozinha, sem o endurecimento) →
# T4 tem de virar vermelho. Prova que T4 não é decorativo: sem ele, a versão anterior do
# desenho — que a própria 125000 documenta como resíduo — passaria despercebida.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.frec_sem_margem() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', pg_temp
AS $fn$ BEGIN NEW.m_ij := NULL; RETURN NEW; END $fn$;
SQL
P -q -c "DELETE FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';"
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, p_ij, lie, affinity_score, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', '$UUID_T', 9.4, 12.62, 0.0094, 1.0, 'pendente');"
S3=$(Pq -c "SELECT coalesce(lie::text,'NULL') FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';")
ne "S3 trigger que PRESERVA o lie monetário → T4 MORDE" "$S3" "NULL"
P -q -f "$MIG126" >/dev/null   # restaura

# S5 — trigger AGRESSIVO que nulifica a AFINIDADE junto → T5 tem de virar vermelho.
# A metade oposta do S3: trocar um vazamento de custo por uma feature morta também é falha.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.frec_sem_margem() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', pg_temp
AS $fn$ BEGIN NEW.m_ij := NULL; NEW.lie := NULL; NEW.affinity_score := NULL; RETURN NEW; END $fn$;
SQL
P -q -c "DELETE FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';"
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, p_ij, lie, affinity_score, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', '$UUID_T', 9.4, 12.62, 0.0094, 1.0, 'pendente');"
S5=$(Pq -c "SELECT coalesce(affinity_score::text,'NULL') FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';")
eq "S5 trigger que mata a afinidade → T5 MORDE (ranking morto é falha, não segurança)" "$S5" "NULL"
P -q -f "$MIG126" >/dev/null   # restaura a FUNÇÃO
# ...e a LINHA: restaurar o trigger não reescreve o que já foi gravado sob a sabotagem. Sem este
# re-insert, R4 mediria a linha mutilada e acusaria a cadeia verdadeira de matar a afinidade —
# falso VERMELHO com aparência de achado (o harness já pegou isso uma vez, aqui mesmo).
P -q -c "DELETE FROM public.farmer_recommendations WHERE customer_user_id = '$UUID_T';"
P -q -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, p_ij, lie, affinity_score, complexity_factor, status) VALUES ('11111111-1111-1111-1111-111111111111', '$UUID_T', 9.4, 12.62, 0.0094, 1.0, 'pendente');"

# S4 — scrub que não limpa o jsonb → A5 morde
P -q -c "INSERT INTO public.farmer_bundle_recommendations (farmer_id, bundle_products, status) VALUES ('11111111-1111-1111-1111-111111111111', '[{\"id\":\"zzz\",\"name\":\"Z\",\"price\":10}]'::jsonb, 'pendente');"
# injeta o custo por baixo do trigger (o trigger é BEFORE; aqui simulamos o dado legado já gravado)
P -q -c "ALTER TABLE public.farmer_bundle_recommendations DISABLE TRIGGER trg_fbrec_sem_margem;"
P -q -c "UPDATE public.farmer_bundle_recommendations SET bundle_products = '[{\"id\":\"zzz\",\"name\":\"Z\",\"price\":10,\"cost\":6}]'::jsonb WHERE (bundle_products->0->>'id') = 'zzz';"
S4=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost';")
ne "S4 sem a limpeza do jsonb o custo literal fica → A5 MORDE" "$S4" "0"
P -q -c "ALTER TABLE public.farmer_bundle_recommendations ENABLE TRIGGER trg_fbrec_sem_margem;"
# ⚠️ A ORDEM da restauração importa: re-aplicar a 125000 recria as funções na versão FRACA (a que
# preserva o lie). Sem a 126000 em seguida, todo assert R abaixo passaria a medir o trigger errado.
P -q -f "$MIG" >/dev/null    # re-roda o scrub, que limpa o jsonb que injetamos
P -q -f "$MIG126" >/dev/null # e re-endurece as guardas

# ── pós-restauro: a cadeia é IDEMPOTENTE e o mundo voltou ao estado limpo ──
echo "── R: pós-restauro (a cadeia re-roda sem estragar) ──"
R1=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations, jsonb_array_elements(bundle_products) e WHERE e ? 'cost' OR e ? 'margin';")
eq "R1 jsonb limpo após re-aplicar" "$R1" "0"
R2=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE m_ij IS NOT NULL OR lie IS NOT NULL;")
eq "R2 m_ij/lie limpos após re-aplicar (idempotente)" "$R2" "0"
R3=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE m_bundle IS NOT NULL OR lie_bundle IS NOT NULL;")
eq "R3 m_bundle/lie_bundle limpos após re-aplicar" "$R3" "0"
# A re-aplicação NÃO pode levar a afinidade junto — é o dado que o motor novo grava.
R4=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE affinity_score IS NOT NULL;")
eq "R4 affinity_score SOBREVIVEU à cadeia inteira (re-aplicada)" "$R4" "1"
R5=$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE affinity_bundle IS NOT NULL;")
eq "R5 affinity_bundle SOBREVIVEU à cadeia inteira" "$R5" "1"
# A 121000 re-aplicada não pode duplicar coluna nem introduzir default.
P -q -f "$MIG121" >/dev/null
R6=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('affinity_score','affinity_bundle');")
eq "R6 121000 é idempotente (ADD COLUMN IF NOT EXISTS re-rodado)" "$R6" "2"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

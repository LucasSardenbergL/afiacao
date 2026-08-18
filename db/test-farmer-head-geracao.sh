#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260815181500_farmer_geracao_head_sensor.sql                       ║
# ║      bash db/test-farmer-head-geracao.sh > /tmp/t.log 2>&1; echo "exit=$?"   ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  O que se prova: o head de geração AVANÇA mesmo quando a geração é VAZIA —   ║
# ║  o caso que o #1756 deixou de fora — sem expirar nada, e distinguindo         ║
# ║  "nunca rodou" de "rodou e deu vazio". Mais a REGRESSÃO do #1756: as duas     ║
# ║  RPCs de substituição foram RECRIADAS (aridade nova) e não podem ter perdido  ║
# ║  nenhuma das defesas que aquela migration provou.                             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="farmer-head"
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
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
SQL

# Os asserts POSITIVOS rodam pelo caminho de servidor (service_role), como o cron/edge.
"$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET test.role = 'service_role';"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# usado SÓ na falsificação: espelha eq() mas com o veredito INVERTIDO (queremos vermelho).
eq_esperando_vermelho() {
  if [ "$2" = "$3" ]; then bad "FALSIFICAÇÃO SEM DENTE: $1 continuou [$2] com a migration sabotada"
  else ok "falsificação mordeu: $1 virou [$2] (íntegro seria [$3])"; fi
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (espelham o schema REAL de prod, medido via psql-ro)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.caps (user_id uuid PRIMARY KEY, escrever boolean DEFAULT false, ler boolean DEFAULT false);
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'private','pg_temp'
  AS $f$ SELECT coalesce((SELECT escrever FROM private.caps WHERE user_id = p_uid), false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'private','pg_temp'
  AS $f$ SELECT coalesce((SELECT ler FROM private.caps WHERE user_id = p_uid), false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(p_cliente uuid, p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;

CREATE TABLE IF NOT EXISTS public.omie_products (id uuid PRIMARY KEY, descricao text);

CREATE TABLE IF NOT EXISTS public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  recommendation_type text NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  current_product_id uuid REFERENCES public.omie_products(id),
  p_ij numeric DEFAULT 0, m_ij numeric DEFAULT 0, lie numeric DEFAULT 0,
  complexity_factor numeric DEFAULT 1, cluster_volume_estimate numeric DEFAULT 1,
  offered_at timestamptz, accepted_at timestamptz, rejected_at timestamptz,
  actual_margin numeric, time_spent_seconds integer,
  status text DEFAULT 'pendente',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  affinity_score numeric,
  CONSTRAINT farmer_recommendations_recommendation_type_check
    CHECK (recommendation_type = ANY (ARRAY['cross_sell'::text,'up_sell'::text])),
  CONSTRAINT farmer_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente'::text,'ofertado'::text,'aceito'::text,'rejeitado'::text,'expirado'::text]))
);

CREATE TABLE IF NOT EXISTS public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_products jsonb NOT NULL DEFAULT '[]'::jsonb,
  bundle_type text NOT NULL DEFAULT 'cross_sell',
  support numeric DEFAULT 0, confidence numeric DEFAULT 0, lift numeric DEFAULT 0,
  p_bundle numeric DEFAULT 0, m_bundle numeric DEFAULT 0, lie_bundle numeric DEFAULT 0,
  complexity_factor numeric DEFAULT 1,
  status text DEFAULT 'pendente',
  offered_at timestamptz, accepted_at timestamptz, rejected_at timestamptz,
  actual_margin numeric, time_spent_seconds integer, accepted_products jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  affinity_bundle numeric,
  CONSTRAINT farmer_bundle_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente'::text,'ofertado'::text,'aceito_total'::text,'aceito_parcial'::text,'rejeitado'::text]))
);

ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_bundle_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY frec_select_carteira ON public.farmer_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid()))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));
CREATE POLICY frec_insert_own_or_gestor ON public.farmer_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY frec_update_own_or_gestor ON public.farmer_recommendations FOR UPDATE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));

CREATE POLICY fbrec_select_carteira ON public.farmer_bundle_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY fbrec_insert_own_or_gestor ON public.farmer_bundle_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY fbrec_update_own_or_gestor ON public.farmer_bundle_recommendations FOR UPDATE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
SQL

FARMER_A='aaaaaaaa-1111-1111-1111-111111111111'
FARMER_B='bbbbbbbb-2222-2222-2222-222222222222'
FARMER_C='cccccccc-3333-3333-3333-333333333333'   # nunca roda o motor: prova o head AUSENTE
CLI_1='ccccccc1-1111-1111-1111-111111111111'
CLI_2='ccccccc2-2222-2222-2222-222222222222'
PROD_1='dddddddd-1111-1111-1111-111111111111'
PROD_2='dddddddd-2222-2222-2222-222222222222'

# Seed do LEGADO ANTES da migration do #1756 — a trigger trg_frec_exige_run_id rejeita
# pendente sem run_id, então esta ordem é a única que reproduz a realidade de prod.
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$FARMER_A'),('$FARMER_B'),('$FARMER_C'),('$CLI_1'),('$CLI_2') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, descricao) VALUES ('$PROD_1','Lixa 120'),('$PROD_2','Verniz PU') ON CONFLICT DO NOTHING;

INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status, created_at)
VALUES
  ('$FARMER_A','$CLI_1','cross_sell','$PROD_1', 9.9, 0.99, 'pendente', now() - interval '70 days'),
  ('$FARMER_A','$CLI_2','up_sell',   '$PROD_1', 3.0, 0.30, 'pendente', now() - interval '70 days');

-- Linha com DESFECHO: histórico, tem de sobreviver a todo recálculo (regressão do #1756).
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status, offered_at, accepted_at)
VALUES ('$FARMER_A','$CLI_1','cross_sell','$PROD_1', 7.0, 0.70, 'aceito', now() - interval '60 days', now() - interval '59 days');

INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status)
VALUES ('$FARMER_B','$CLI_2','cross_sell','$PROD_1', 8.0, 0.80, 'pendente');

INSERT INTO public.farmer_bundle_recommendations
  (farmer_id, customer_user_id, bundle_products, affinity_bundle, status, created_at)
VALUES ('$FARMER_A','$CLI_1','[{"id":"x","name":"velho","price":10}]'::jsonb, 0.88, 'pendente', now() - interval '70 days');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1b — GUARD DE ORDEM DE APPLY (a migration NOVA aborta sem a do #1756)
# ══════════════════════════════════════════════════════════════════════════════
echo "── guard de dependência (pré-apply) ──"
MIG_BASE="$REPO_ROOT/supabase/migrations/20260814223445_farmer_recomendacoes_geracao_vigente.sql"
MIG="$REPO_ROOT/supabase/migrations/20260815181500_farmer_geracao_head_sensor.sql"

# Aplicada numa base SEM a 20260814223445, tem de recusar nomeando-a — e não morrer
# com um 42883 críptico ao tentar dropar uma função que não existe.
DEP=$(P -tA -f "$MIG" 2>&1 || true)
case "$DEP" in
  *"DEPENDENCIA FALTANDO"*) ok "D1 migration aborta sem a 20260814223445, nomeando-a" ;;
  *) bad "D1 migration NAO abortou sem a dependência — veio: $(printf '%s' "$DEP" | head -c 200)" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS DUAS MIGRATIONS REAIS, na ordem (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") + $(basename "$MIG")"
P -q -f "$MIG"
ok "I1 migration nova é idempotente (aplicada 2x sem erro)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — GRANTS + payloads
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid), private.cap_carteira_ler(uuid),
                           private.carteira_visivel_para(uuid,uuid) TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.farmer_recommendations, public.farmer_bundle_recommendations TO authenticated;
GRANT SELECT ON public.omie_products TO authenticated;
SQL

LOTE_OK=$(cat <<JSON
[{"customer_user_id":"$CLI_1","recommendation_type":"cross_sell","product_id":"$PROD_2","p_ij":4.4,"affinity_score":0.44,"complexity_factor":1,"cluster_volume_estimate":3},
 {"customer_user_id":"$CLI_2","recommendation_type":"up_sell","product_id":"$PROD_1","p_ij":2.2,"affinity_score":0.22,"complexity_factor":1,"cluster_volume_estimate":1}]
JSON
)
INSUMOS='{"scores":{"ok":true,"n":3858},"catalogo":{"ok":true,"n":3108},"vendaveis":{"ok":true,"n":1200},"pedidos":{"ok":true,"n":861}}'
RUN_1='11111111-aaaa-aaaa-aaaa-111111111111'
RUN_2='22222222-aaaa-aaaa-aaaa-222222222222'
RUN_3='33333333-aaaa-aaaa-aaaa-333333333333'
RUN_B='bbbbbbbb-aaaa-aaaa-aaaa-bbbbbbbbbbbb'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── head: o caminho COM linhas ──"

# H1 — a substituição move o head na MESMA transação, com resultado='linhas'.
Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1',NULL,'$LOTE_OK'::jsonb,'completo',NULL,'$INSUMOS'::jsonb);" >/dev/null
eq "H1 head criado pela substituição (motor cross_sell)" \
   "$(Pq -c "SELECT run_id||'|'||resultado||'|'||linhas_geradas||'|'||completude FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" \
   "$RUN_1|linhas|2|completo"

# H2 — os `insumos` (a EVIDÊNCIA por trás do rótulo) chegam íntegros.
eq "H2 insumos preservados (n de scores)" \
   "$(Pq -c "SELECT insumos->'scores'->>'n' FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "3858"

# H3 — o head AVANÇA (upsert), não empilha: 2ª execução deixa 1 linha só, com o run novo.
GER=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
HEAD_H3=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_2','$GER'::uuid,'$LOTE_OK'::jsonb,'completo',NULL,'$INSUMOS'::jsonb,'$HEAD_H3'::uuid);" >/dev/null
eq "H3 head AVANÇA em vez de empilhar (1 linha por motor+farmer)" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "1"
eq "H4 head aponta para a geração NOVA" \
   "$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "$RUN_2"

# H5 — a assinatura de 4 ARGS ainda funciona (bundle velho em cache, Publish não-instantâneo)
# e grava `desconhecido` — NUNCA `completo`. Ausente ≠ completo (§2), aplicado à instrumentação.
GER=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_3','$GER'::uuid,'$LOTE_OK'::jsonb);" >/dev/null
eq "H5 chamada de 4 args funciona E grava 'desconhecido' (não 'completo')" \
   "$(Pq -c "SELECT completude FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "desconhecido"

# H6 — bundle tem head PRÓPRIO, na mesma tabela, sem colidir com o do cross_sell.
Pq -c "SELECT public.farmer_bundle_recomendacoes_substituir('$FARMER_A','$RUN_B',NULL,'[{\"customer_user_id\":\"$CLI_1\",\"bundle_products\":[{\"id\":\"y\",\"name\":\"novo\",\"price\":20}],\"affinity_bundle\":0.42,\"support\":0.1,\"confidence\":0.5,\"lift\":1.5,\"p_bundle\":3.3}]'::jsonb,'completo',NULL,'$INSUMOS'::jsonb);" >/dev/null
eq "H6 bundle tem head próprio (motor='bundle')" \
   "$(Pq -c "SELECT run_id||'|'||linhas_geradas FROM public.farmer_geracao_vigente WHERE motor='bundle' AND farmer_id='$FARMER_A';")" "$RUN_B|1"
eq "H7 os dois motores coexistem para o mesmo farmer" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_A';")" "2"

echo "── head: a geração VAZIA (o caso que o #1756 deixou de fora) ──"

# H8 — O PONTO DA ENTREGA: geração legitimamente vazia MOVE o head.
# Sem isto, um cálculo que conclui "não deve haver recomendação nenhuma" não deixa
# rastro nenhum, e a geração anterior sobrevive indefinidamente.
HEAD_VISTO=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
VAZIO_1='e0000000-aaaa-aaaa-aaaa-000000000001'
Pq -c "SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_A','$VAZIO_1','vazio',0,'completo',NULL,'$INSUMOS'::jsonb,'$HEAD_VISTO'::uuid);" >/dev/null
eq "H8 geração VAZIA move o head (resultado='vazio', completude='completo')" \
   "$(Pq -c "SELECT run_id||'|'||resultado||'|'||linhas_geradas||'|'||completude FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" \
   "$VAZIO_1|vazio|0|completo"

# H9 — e NÃO expira/toca linha nenhuma (o escopo desta fase é SENSOR, não expiração).
eq "H9 o registro vazio NÃO expirou nenhuma pendente" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente';")" "2"

# H10 — "NUNCA RODOU" ≠ "RODOU E DEU VAZIO". Em prod (2026-08-15) esses dois estados eram
# indistinguíveis: os dois eram ausência de linha. É o que o head resolve já nesta fase.
eq "H10a farmer que nunca rodou: head AUSENTE" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_C';")" "0"
eq "H10b farmer que rodou e deu vazio: head PRESENTE com resultado='vazio'" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_A' AND motor='cross_sell' AND resultado='vazio';")" "1"

# H11 — o vazio DEGRADADO (dado faltando a montante) é distinguível do vazio completo.
# É exatamente esta distinção que a fase 2 precisa para poder expirar sem zerar carteira.
VAZIO_2='e0000000-aaaa-aaaa-aaaa-000000000002'
Pq -c "SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_B','$VAZIO_2','vazio',0,'degradado','sem farmer_client_scores para este farmer','{\"scores\":{\"ok\":true,\"n\":0}}'::jsonb,NULL);" >/dev/null
eq "H11 vazio DEGRADADO carrega o motivo (≠ vazio completo)" \
   "$(Pq -c "SELECT completude||'|'||motivo FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_B';")" \
   "degradado|sem farmer_client_scores para este farmer"

# H12 — A QUERY DE DECISÃO da fase 2: só conta o vazio+completo. O degradado do FARMER_B
# NÃO pode entrar no numerador — se entrasse, a fase 2 ligaria a expiração com base em
# falha a montante, que é precisamente o desfecho que o desenho existe para evitar.
eq "H12 a query de decisão separa vazio-completo de vazio-degradado" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE resultado='vazio' AND completude='completo';")" "1"

echo "── log append-only: o head NÃO mede frequência, o log mede ──"

# Sobrescreve o head com um run de LINHAS, logo depois do vazio de H8. É o cenário exato
# em que o head perde o evento — e o log tem de guardá-lo.
GER_L=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
HEAD_L=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
RUN_L='e0000000-aaaa-aaaa-aaaa-0000000000cc'
Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_L','$GER_L'::uuid,'$LOTE_OK'::jsonb,'completo',NULL,'$INSUMOS'::jsonb,'$HEAD_L'::uuid);" >/dev/null

# L1 — o log guarda TODAS as execuções, enquanto o head guarda 1 por par.
# Achado do challenge Codex: um vazio+completo pode acontecer e SUMIR do head no run
# seguinte. Se a medição saísse do head, a resposta seria "nunca aconteceu".
eq "L1 log tem mais execuções que o head tem linhas (histórico ≠ estado)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.farmer_geracao_execucoes) > (SELECT count(*) FROM public.farmer_geracao_vigente);")" "t"

# L2 — O TESTE QUE JUSTIFICA O LOG: sobrescreve o head com um run de LINHAS e prova que
# o vazio+completo anterior CONTINUA no log. Sem o log, este evento estaria perdido.
eq "L2 o vazio+completo sobrevive no log depois do head ser sobrescrito" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_execucoes WHERE resultado='vazio' AND completude='completo' AND farmer_id='$FARMER_A';")" "1"
eq "L2b e o head já NÃO mostra mais esse vazio (é por isso que ele não serve de medição)" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE resultado='vazio' AND farmer_id='$FARMER_A' AND motor='cross_sell';")" "0"

# L3 — idempotência: retry do MESMO run não vira 2 execuções (senão a frequência mede retry).
HL=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
N_ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_geracao_execucoes;")
Pq -c "SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_A','$HL','linhas',(SELECT count(*)::int FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND run_id='$HL' AND status='pendente'),'completo',NULL,NULL,'$HL'::uuid);" >/dev/null 2>&1 || true
eq "L3 retry do mesmo run NÃO duplica a execução no log" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_execucoes;")" "$N_ANTES"

echo "── escrita: as tabelas do sensor NÃO aceitam DML direto de authenticated ──"

# W1/W2 — O FURO QUE O CHALLENGE ACHOU: com GRANT INSERT/UPDATE, o browser fazia
# `UPDATE ... SET resultado='vazio', completude='completo'` DIRETO e pulava FG105/106/107
# inteiros. Guard que se contorna pela porta ao lado não é guard.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
UPDATE public.farmer_geracao_vigente SET resultado='vazio', linhas_geradas=0, completude='completo'
WHERE farmer_id='$FARMER_A' AND motor='cross_sell';
SQL
)
case "$R" in
  *"permission denied"*) ok "W1 UPDATE direto no head é negado (o guard não tem porta ao lado)" ;;
  *) bad "W1 UPDATE direto PASSOU — o browser forja o head sem passar pelas RPCs: $(printf '%s' "$R" | head -c 200)" ;;
esac
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
INSERT INTO public.farmer_geracao_execucoes (motor,farmer_id,run_id,resultado,linhas_geradas,completude)
VALUES ('cross_sell','$FARMER_A','e0000000-aaaa-aaaa-aaaa-0000000000ff','vazio',0,'completo');
SQL
)
case "$R" in
  *"permission denied"*) ok "W2 INSERT direto no log é negado (a série da medição é imutável de fora)" ;;
  *) bad "W2 INSERT direto no log PASSOU — a medição é forjável: $(printf '%s' "$R" | head -c 200)" ;;
esac

# W3 — mas LER continua permitido (o farmer precisa enxergar o próprio head/execuções).
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT count(*) FROM public.farmer_geracao_execucoes WHERE farmer_id='$FARMER_A';
SQL
)
eq "W3 o farmer LÊ as próprias execuções (a revogação é só de escrita)" \
   "$(printf '%s' "$R" | tail -1 | tr -d '[:space:]' | command grep -qE '^[0-9]+$' && echo ok || echo nao)" "ok"

echo "── regressão do #1756 (as RPCs foram RECRIADAS: nada pode ter se perdido) ──"

# R1 — a linha com DESFECHO continua intocável (o invariante mais caro do #1756).
eq "R1 linha 'aceito' sobreviveu a todos os recálculos" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status='aceito' AND accepted_at IS NOT NULL AND expired_at IS NULL;")" "1"
# R2 — expirar não deleta.
eq "R2 a carteira do farmer B segue intacta" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_B' AND status='pendente';")" "1"
# R3 — m_ij/lie continuam fixados em NULL (dinheiro não volta pelo browser).
eq "R3 m_ij/lie seguem NULL nas linhas novas" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='$RUN_3' AND m_ij IS NULL AND lie IS NULL;")" "2"
# R4 — as expiradas seguem carimbando quem as matou.
eq "R4 expiradas carimbam expired_by_run" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status='expirado' AND expired_by_run IS NULL;")" "0"

echo "── asserts negativos (SQLSTATE esperada + re-raise) ──"

espera_sqlstate() { # $1=nome  $2=sqlstate  $3=chamada SQL
  local OUT
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM $3;
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION
  WHEN SQLSTATE '$2' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_BARROU_CERTO*) ok "$1 (SQLSTATE $2)" ;;
    *SENTINELA_NAO_BARROU*)   bad "$1 — NAO barrou (esperava $2)" ;;
    *)                        bad "$1 — erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
}

HV=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")

# N1/N2 — COERÊNCIA resultado × contagem. O head mentiroso ("linhas com 0 linhas") é como
# uma medição se corrompe sem ninguém ver — e a medição é o produto inteiro desta entrega.
espera_sqlstate "N1 resultado='linhas' com 0 linhas recusado" "FG103" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','linhas',0,'completo',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N2 resultado='vazio' com linhas>0 recusado" "FG103" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',5,'completo',NULL,NULL,'$HV'::uuid)"

# N3 — degradado SEM motivo: rótulo sem conteúdo, e o motivo é justamente o que a fase 2
# usa para separar "zero de verdade" de "zero por dado faltando".
espera_sqlstate "N3 degradado sem motivo recusado" "FG104" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'degradado',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N3b degradado com motivo em branco recusado" "FG104" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'degradado','   ',NULL,'$HV'::uuid)"

espera_sqlstate "N4 motor inválido recusado" "FG102" \
  "public.farmer_geracao_registrar('foo','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N5 completude inválida recusada" "FG103" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'quase',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N6 resultado inválido recusado" "FG103" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','talvez',0,'completo',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N7 run_id nulo recusado" "FG101" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A',NULL,'vazio',0,'completo',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N8 insumos não-objeto recusado" "FG103" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,'[1,2]'::jsonb,'$HV'::uuid)"

# N9 — CAS DO HEAD. Sem ele, um run VAZIO lento sobrescreve o head de um run COM LINHAS
# que terminou antes — e a medição registra `vazio` para um estado que é `linhas`.
espera_sqlstate "N9 CAS: head_visto ≠ vigente recusado" "FG106" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,NULL,'99999999-9999-9999-9999-999999999999'::uuid)"
# N9b — o caso simétrico e mais fácil de errar: head JÁ EXISTE e o chamador manda NULL
# ("achei que era a primeira execução"). NULL casa NULL só quando o head é de fato ausente.
espera_sqlstate "N9b CAS: head existente com head_visto NULL recusado" "FG106" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,NULL,NULL)"

# N9e — O CAS ASSIMÉTRICO, fechado. A substituição COM LINHAS agora compara o head que o
# CHAMADOR viu, não o que ela lê sob o lock. Antes, um run vazio mais NOVO era sobrescrito
# por um run com linhas que leu snapshot mais velho: o CAS da etapa 5 compara LINHAS, e o
# vazio não mexe em linha nenhuma, então passava despercebido (achado Codex xhigh).
GER_N9=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
espera_sqlstate "N9e substituição com head_visto DEFASADO é recusada (CAS simétrico)" "FG106" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','e0000000-aaaa-aaaa-aaaa-0000000000aa',$([ -z "$GER_N9" ] && echo NULL || echo "'$GER_N9'::uuid"),'$LOTE_OK'::jsonb,'completo',NULL,NULL,'99999999-9999-9999-9999-999999999999'::uuid)"

# N9f — e a recusa é ATÔMICA: nenhuma linha entrou, nenhuma foi expirada.
eq "N9f a recusa do CAS do head não deixou linha do run recusado" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='e0000000-aaaa-aaaa-aaaa-0000000000aa';")" "0"

# N9g — contagem DECLARADA ≠ contagem REAL é recusada (o `EXISTS` sozinho aceitava
# "1 linha real, 999 declaradas", e `linhas_geradas` é o que a fase 2 leria).
espera_sqlstate "N9g linhas_geradas divergente da contagem real recusado" "FG107" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$GER_N9','linhas',999,'completo',NULL,NULL,'$HV'::uuid)"

# N9h — declarar 'vazio' num run que TEM linhas é um head que contradiz a própria tabela.
espera_sqlstate "N9h resultado='vazio' com linhas gravadas naquele run recusado" "FG107" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','$GER_N9','vazio',0,'completo',NULL,NULL,'$HV'::uuid)"

# N9c — ANTI-FORJA: `resultado` vem do browser, e o head é MEDIÇÃO. Sem ancorar em linha
# real, um cliente grava um head afirmando "linhas" sem existir nenhuma — e é sobre essa
# medição que a fase 2 decidiria ligar a expiração.
espera_sqlstate "N9c resultado='linhas' sem linha real recusado" "FG107" \
  "public.farmer_geracao_registrar('cross_sell','$FARMER_A','e0000000-aaaa-aaaa-aaaa-00000000dead','linhas',7,'completo',NULL,NULL,'$HV'::uuid)"
espera_sqlstate "N9d anti-forja vale para o bundle também" "FG107" \
  "public.farmer_geracao_registrar('bundle','$FARMER_A','e0000000-aaaa-aaaa-aaaa-00000000beef','linhas',3,'completo',NULL,NULL,'$RUN_B'::uuid)"

# N10 — TODAS as recusas acima deixaram o head onde estava.
eq "N10 nenhuma recusa moveu o head" \
   "$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "$HV"

# N11/N12 — as invariantes moram na TABELA, não só no writer: um writer futuro que
# insira direto tem de esbarrar no CHECK.
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_geracao_vigente (motor,farmer_id,run_id,resultado,linhas_geradas,completude) VALUES ('cross_sell','$FARMER_C','$RUN_1','linhas',0,'completo');" || true)
case "$R" in
  *farmer_geracao_vigente_linhas_coerente*) ok "N11 CHECK barra 'linhas' com 0 linhas (23514)" ;;
  *) bad "N11 CHECK NAO barrou — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_geracao_vigente (motor,farmer_id,run_id,resultado,linhas_geradas,completude) VALUES ('cross_sell','$FARMER_C','$RUN_1','vazio',0,'degradado');" || true)
case "$R" in
  *farmer_geracao_vigente_motivo_coerente*) ok "N12 CHECK barra 'degradado' sem motivo (23514)" ;;
  *) bad "N12 CHECK NAO barrou — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_geracao_vigente (motor,farmer_id,run_id,resultado,linhas_geradas,completude) VALUES ('outro','$FARMER_C','$RUN_1','vazio',0,'completo');" || true)
case "$R" in
  *farmer_geracao_vigente_motor_check*) ok "N13 CHECK barra motor desconhecido (23514)" ;;
  *) bad "N13 CHECK NAO barrou — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# N14 — a UNIQUE que faz o head ser HEAD (e não um log que empilha).
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_geracao_vigente (motor,farmer_id,run_id,resultado,linhas_geradas,completude) VALUES ('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo');" || true)
case "$R" in
  *farmer_geracao_vigente_motor_farmer_uk*) ok "N14 UNIQUE(motor,farmer) barra 2ª linha para o mesmo par (23505)" ;;
  *) bad "N14 UNIQUE NAO barrou — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

echo "── asserts de autorização (RLS + gate) ──"

# A1 — farmer B (sem cap) NÃO registra geração de A.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_B'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,NULL,'$HV'::uuid);
SQL
)
case "$R" in
  *"Acesso negado"*) ok "A1 farmer B barrado ao registrar geração de A (42501)" ;;
  *) bad "A1 farmer B NAO foi barrado — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A2 — o próprio farmer A CONSEGUE (a autorização não é fail-closed demais).
A2_RUN='e0000000-aaaa-aaaa-aaaa-00000000000a'
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_A','$A2_RUN','vazio',0,'completo',NULL,NULL,'$HV'::uuid);
SQL
)
case "$R" in
  *resultado*) ok "A2 o próprio farmer A registra a geração dele" ;;
  *) bad "A2 farmer A NAO conseguiu registrar — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A3 — SESSÃO SEM IDENTIDADE NENHUMA é barrada (regressão do three-valued logic).
# `IF NOT (a OR b OR c)` NÃO barra aqui: sem JWT a disjunção vira NULL e `IF NOT NULL`
# não dispara em PL/pgSQL — o guard devolveria nulo em vez de negar.
HV2=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
R=$(P -tA 2>&1 <<SQL || true
SET test.role=''; SET test.uid='';
DO \$\$
BEGIN
  PERFORM public.farmer_geracao_registrar('cross_sell','$FARMER_A','$RUN_1','vazio',0,'completo',NULL,NULL,'$HV2'::uuid);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_BARROU_CERTO*) ok "A3 sessão sem identidade barrada (o gate fecha em TRUE, não em NOT-NULL)" ;;
  *SENTINELA_NAO_BARROU*)   bad "A3 sessão SEM identidade PASSOU — o gate está em three-valued logic" ;;
  *)                        bad "A3 erro inesperado: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A4 — RLS de LEITURA: farmer B não enxerga o head de A.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_B'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT count(*) FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_A';
SQL
)
# `tail -1`: o psql ecoa um "SET" por comando de sessão antes do resultado — sem isolar a
# última linha o assert compara "SETSETSET0" com "0" e fica vermelho por ruído do harness,
# não por defeito da migration (que é o vermelho que não se pode confundir com o de verdade).
eq "A4 RLS: farmer B não lê o head de A" "$(printf '%s' "$R" | tail -1 | tr -d '[:space:]')" "0"

# A5 — quem ESCREVE precisa LER (senão o CAS fica cego). Gestor com cap_carteira_escrever
# e SEM cap_carteira_ler tem de enxergar o head, ou passaria o CAS trivialmente.
GESTOR='eeeeeeee-4444-4444-4444-444444444444'
P -q -c "INSERT INTO auth.users(id) VALUES ('$GESTOR') ON CONFLICT DO NOTHING;
         INSERT INTO private.caps(user_id, escrever, ler) VALUES ('$GESTOR', true, false)
         ON CONFLICT (user_id) DO UPDATE SET escrever=true, ler=false;"
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$GESTOR'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT count(*) FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_A' AND motor='cross_sell';
SQL
)
eq "A5 gestor com escrever-mas-não-ler ENXERGA o head (CAS cego não é CAS)" "$(printf '%s' "$R" | tail -1 | tr -d '[:space:]')" "1"

# A6 — anon não executa a RPC (REVOKE por nome; REVOKE FROM PUBLIC não tiraria anon).
eq "A6 anon NÃO executa farmer_geracao_registrar" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.farmer_geracao_registrar(text,uuid,uuid,text,integer,text,text,jsonb,uuid)','EXECUTE');")" "f"

echo "── falsificação ──"

SAB="/tmp/farmer-head-sabotado-$$.sql"
restaura() { P -q -f "$MIG"; }

sabota() { # $1=nome  $2=expressão perl  $3=marca que TEM de aparecer no resultado
  perl -0777 -pe "$2" "$MIG" > "$SAB"
  if ! command grep -q -- "$3" "$SAB"; then
    bad "SABOTAGEM $1 NAO APLICOU (padrão não casou) — falsificação INVÁLIDA"
    return 1
  fi
  P -q -f "$SAB"
  return 0
}

# F1 — `coalesce(p_completude,'desconhecido')` vira `'completo'`: a janela de Publish
#      passaria a gravar falsos `completo`, envenenando exatamente a medição sobre a qual
#      a fase 2 decidiria ligar a expiração. H5 tem de ficar VERMELHO.
if sabota "F1" "s/v_completude := coalesce\(p_completude, 'desconhecido'\);/v_completude := coalesce(p_completude, 'completo');/" "coalesce(p_completude, 'completo')"; then
  GER=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','f1000000-aaaa-aaaa-aaaa-000000000001',$([ -z "$GER" ] && echo NULL || echo "'$GER'"),'$LOTE_OK'::jsonb);" >/dev/null 2>&1 || true
  eq_esperando_vermelho "H5 chamada de 4 args grava 'desconhecido'" \
    "$(Pq -c "SELECT completude FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "desconhecido"
  restaura
fi

# F2 — desligar o CAS do head. N9 deixa de barrar, e um run vazio lento passa a
#      sobrescrever o head de um run com linhas que terminou antes.
if sabota "F2" "s/  IF v_head_atual IS DISTINCT FROM p_head_visto THEN/  IF false THEN/" "IF false THEN"; then
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_geracao_registrar('cross_sell','$FARMER_A','f2000000-aaaa-aaaa-aaaa-000000000002','vazio',0,'completo',NULL,NULL,'99999999-9999-9999-9999-999999999999'::uuid);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE 'FG106' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: sem o CAS, o head de outro run é sobrescrito (N9 seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: N9 barrou mesmo com o CAS do head desligado" ;;
    *) bad "F2 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F3 — remover o CHECK de coerência resultado×linhas da TABELA. N11 tem de ficar vermelho:
#      sem ele, "resultado=linhas com 0 linhas" entra e a medição mente em silêncio.
if sabota "F3" "s/      CHECK \(linhas_geradas >= 0 AND \(resultado = 'linhas'\) = \(linhas_geradas > 0\)\);/      CHECK (linhas_geradas >= 0);/" "CHECK (linhas_geradas >= 0);"; then
  P -q -c "ALTER TABLE public.farmer_geracao_vigente DROP CONSTRAINT IF EXISTS farmer_geracao_vigente_linhas_coerente;" >/dev/null
  P -q -f "$SAB" >/dev/null
  R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_geracao_vigente (motor,farmer_id,run_id,resultado,linhas_geradas,completude) VALUES ('bundle','$FARMER_C','f3000000-aaaa-aaaa-aaaa-000000000003','linhas',0,'completo');" || true)
  case "$R" in
    *farmer_geracao_vigente_linhas_coerente*) bad "FALSIFICAÇÃO SEM DENTE: N11 barrou mesmo sem o CHECK de coerência" ;;
    *ERROR*) bad "F3 erro inesperado: $(printf '%s' "$R" | head -c 200)" ;;
    *) ok "falsificação mordeu: sem o CHECK, 'linhas' com 0 linhas ENTRA (N11 seria falso-verde)" ;;
  esac
  P -q -c "DELETE FROM public.farmer_geracao_vigente WHERE farmer_id='$FARMER_C';" >/dev/null
  restaura
fi

# F4 — a substituição para de mover o head (remove o PERFORM). H1 tem de ficar vermelho:
#      sem isso o head e as linhas divergem, e head divergente é MEDIÇÃO CORROMPIDA.
if sabota "F4" "s/  PERFORM public\.farmer_geracao_registrar\(\n    'cross_sell', p_farmer_id, p_run_id, 'linhas', v_inseridas,\n    p_completude, p_motivo, p_insumos, v_head_atual\n  \);/  NULL;/" "  NULL;"; then
  P -q -c "DELETE FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';" >/dev/null
  GER=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  F4_RUN='f4000000-aaaa-aaaa-aaaa-000000000004'
  Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$F4_RUN',$([ -z "$GER" ] && echo NULL || echo "'$GER'"),'$LOTE_OK'::jsonb,'completo',NULL,'$INSUMOS'::jsonb);" >/dev/null 2>&1 || true
  eq_esperando_vermelho "H1 a substituição move o head" \
    "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")" "1"
  restaura
fi

# F5 — o gate volta à forma "óbvia" `IF NOT (...)`. A3 tem de ficar VERMELHO: com NULL na
# disjunção o RAISE nunca acontece e uma sessão sem identidade passa direto.
# A checagem é feita à mão nos DOIS sentidos (a forma antiga apareceu E a nova sumiu):
# sabotagem parcial mediria a função ainda íntegra e devolveria verde de código sabotado.
perl -0777 -pe "s/  IF \(\n    coalesce\(auth\.role\(\), ''\) = 'service_role'\n    OR p_farmer_id = auth\.uid\(\)\n    OR coalesce\(private\.cap_carteira_escrever\(auth\.uid\(\)\), false\)\n  \) IS NOT TRUE THEN/  IF NOT (\n    coalesce(auth.role(), '') = 'service_role'\n    OR p_farmer_id = auth.uid()\n    OR private.cap_carteira_escrever(auth.uid())\n  ) THEN/g" "$MIG" > "$SAB"
if ! command grep -q "IF NOT (" "$SAB"; then
  bad "SABOTAGEM F5 NAO APLICOU (padrão não casou) — falsificação INVÁLIDA"
elif command grep -q "IS NOT TRUE THEN" "$SAB"; then
  bad "SABOTAGEM F5 PARCIAL (sobrou IS NOT TRUE) — falsificação INVÁLIDA"
else
  P -q -f "$SAB"
  # O head vigente REAL: sem ele o CAS recusaria com FG106 e o `WHEN OTHERS THEN RAISE`
  # relançaria — o vermelho seria do harness, não da sabotagem. O alvo aqui é o gate de
  # AUTORIZAÇÃO, então todo o resto tem de estar coerente para o fluxo chegar até ele.
  HV3=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
  OUT=$(P -tA 2>&1 <<SQL || true
SET test.role=''; SET test.uid='';
DO \$\$
BEGIN
  PERFORM public.farmer_geracao_registrar('cross_sell','$FARMER_A','f5000000-aaaa-aaaa-aaaa-000000000005','vazio',0,'completo',NULL,NULL,$([ -z "$HV3" ] && echo NULL || echo "'$HV3'::uuid"));
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: com 'IF NOT (...)' a sessão sem identidade PASSA (A3 seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: A3 barrou mesmo com o gate em three-valued logic" ;;
    *) bad "F5 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F6 — desligar o guard ANTI-FORJA. N9c tem de ficar vermelho: o head volta a aceitar
#      "linhas" na palavra do browser, sem nenhuma linha por trás.
if sabota "F6" "s/  IF p_resultado = 'linhas' THEN\n    IF p_motor = 'cross_sell' THEN/  IF false THEN\n    IF p_motor = 'cross_sell' THEN/" "IF false THEN"; then
  HV4=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_A';")
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_geracao_registrar('cross_sell','$FARMER_A','f6000000-aaaa-aaaa-aaaa-000000000006','linhas',7,'completo',NULL,NULL,$([ -z "$HV4" ] && echo NULL || echo "'$HV4'::uuid"));
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE 'FG107' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: sem o anti-forja, o head aceita 'linhas' sem linha (N9c seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: N9c barrou mesmo com o anti-forja desligado" ;;
    *) bad "F6 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F7 — devolver o GRANT de escrita a `authenticated` (a 1ª versão desta migration). W1 tem
#      de ficar vermelho: o browser volta a forjar o head por UPDATE direto, pulando
#      FG105/FG106/FG107 inteiros. É o furo que o challenge Codex encontrou.
if sabota "F7" "s/GRANT SELECT ON TABLE public\.farmer_geracao_vigente   TO authenticated;/GRANT SELECT, INSERT, UPDATE ON TABLE public.farmer_geracao_vigente TO authenticated;/" "GRANT SELECT, INSERT, UPDATE ON TABLE public.farmer_geracao_vigente"; then
  # A policy de UPDATE também precisa existir para o teste medir o GRANT, e não a RLS:
  # sem ela o vermelho viria da policy ausente e não provaria nada sobre o grant.
  P -q -c "CREATE POLICY fgv_update_sabotada ON public.farmer_geracao_vigente FOR UPDATE TO authenticated
           USING (farmer_id = (SELECT auth.uid())) WITH CHECK (farmer_id = (SELECT auth.uid()));" >/dev/null
  R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
UPDATE public.farmer_geracao_vigente SET resultado='vazio', linhas_geradas=0, completude='completo'
WHERE farmer_id='$FARMER_A' AND motor='cross_sell';
SQL
)
  case "$R" in
    *"permission denied"*) bad "FALSIFICAÇÃO SEM DENTE: W1 barrou mesmo com o GRANT de escrita devolvido" ;;
    *ERROR*) bad "F7 erro inesperado: $(printf '%s' "$R" | head -c 200)" ;;
    *) ok "falsificação mordeu: com GRANT de escrita, o head é forjado por UPDATE direto (W1 seria falso-verde)" ;;
  esac
  P -q -c "DROP POLICY IF EXISTS fgv_update_sabotada ON public.farmer_geracao_vigente;" >/dev/null
  restaura
fi

# F8 — a substituição volta a ler o head DENTRO do lock em vez de usar o do chamador.
#      N9e tem de ficar vermelho: o CAS passa por construção e o run antigo com linhas
#      volta a poder sobrescrever um vazio mais novo.
if sabota "F8" "s/  IF p_completude IS NULL THEN\n    SELECT run_id INTO v_head_atual\n    FROM public\.farmer_geracao_vigente\n    WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;\n  ELSE\n    v_head_atual := p_head_visto;\n  END IF;/  SELECT run_id INTO v_head_atual FROM public.farmer_geracao_vigente WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;/" "SELECT run_id INTO v_head_atual FROM public.farmer_geracao_vigente WHERE motor = 'cross_sell'"; then
  GER_F8=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$FARMER_A','f8000000-aaaa-aaaa-aaaa-000000000008',$([ -z "$GER_F8" ] && echo NULL || echo "'$GER_F8'::uuid"),'$LOTE_OK'::jsonb,'completo',NULL,NULL,'99999999-9999-9999-9999-999999999999'::uuid);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE 'FG106' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: lendo o head sob o lock, o CAS passa por construção (N9e seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: N9e barrou mesmo com o head lido internamente" ;;
    *) bad "F8 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F9 — tirar o INSERT no log append-only. L2 tem de ficar vermelho: o vazio+completo
#      volta a existir só no head, e some no run seguinte — a medição de FREQUÊNCIA morre.
if sabota "F9" "s/  ON CONFLICT \(motor, farmer_id, run_id\) DO NOTHING;/  ON CONFLICT (motor, farmer_id, run_id) DO NOTHING;\n  DELETE FROM public.farmer_geracao_execucoes WHERE run_id = p_run_id;/" "DELETE FROM public.farmer_geracao_execucoes WHERE run_id = p_run_id;"; then
  P -q -c "DELETE FROM public.farmer_geracao_execucoes WHERE farmer_id='$FARMER_B';" >/dev/null
  HV_F9=$(Pq -c "SELECT run_id FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$FARMER_B';")
  Pq -c "SELECT public.farmer_geracao_registrar('cross_sell','$FARMER_B','f9000000-aaaa-aaaa-aaaa-000000000009','vazio',0,'completo',NULL,NULL,$([ -z "$HV_F9" ] && echo NULL || echo "'$HV_F9'::uuid"));" >/dev/null 2>&1 || true
  eq_esperando_vermelho "L2 o vazio+completo sobrevive no log" \
    "$(Pq -c "SELECT count(*) FROM public.farmer_geracao_execucoes WHERE farmer_id='$FARMER_B' AND resultado='vazio';")" "1"
  restaura
fi

rm -f "$SAB"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

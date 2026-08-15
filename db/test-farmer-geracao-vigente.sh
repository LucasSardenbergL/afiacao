#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — 20260814223445_farmer_recomendacoes_geracao_vigente.sql              ║
# ║      bash db/test-farmer-geracao-vigente.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  O que se prova: o recálculo do farmer APOSENTA a geração anterior em vez de  ║
# ║  empilhar, atomicamente, sem NUNCA deletar linha com desfecho registrado.     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="farmer-geracao"
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
-- O Supabase real concede isto; sem ele uma RPC SECURITY INVOKER que chama
-- auth.uid()/auth.role() morre com "permission denied for schema auth" e o teste
-- acusaria a migration por um furo do STUB. Conferido na PROD via psql-ro:
--   has_schema_privilege('authenticated','auth','USAGE')      = true
--   has_function_privilege('authenticated','auth.uid()',…)    = true
--   has_function_privilege('authenticated','auth.role()',…)   = true
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon;
SQL

# Os asserts POSITIVOS rodam pelo caminho de servidor (service_role), como o cron/edge.
# Sem isto eles rodariam sem JWT nenhum e o gate os barraria — corretamente, desde que o
# gate fecha em `IS NOT TRUE` (ver A4). Os asserts de autorização sobrescrevem este GUC
# na própria sessão, então o default global não os enfraquece.
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
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Espelha o schema REAL de prod (medido 2026-08-14 via psql-ro), incluindo as
# colunas affinity_* da 20260725121000 — dependência que a migration exige.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

-- cap_carteira_escrever: a capability de gestor. Aqui é tabela-backed pra o teste
-- poder conceder/revogar sem tocar a função.
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
  p_ij numeric DEFAULT 0,
  m_ij numeric DEFAULT 0,
  lie numeric DEFAULT 0,
  complexity_factor numeric DEFAULT 1,
  cluster_volume_estimate numeric DEFAULT 1,
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
  -- versão PRÉ-migration de propósito: sem 'expirado'. Se a migration não alargar
  -- este CHECK, a RPC do bundle morre em runtime com 23514 (não no CREATE).
  CONSTRAINT farmer_bundle_recommendations_status_check
    CHECK (status = ANY (ARRAY['pendente'::text,'ofertado'::text,'aceito_total'::text,'aceito_parcial'::text,'rejeitado'::text]))
);

ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_bundle_recommendations ENABLE ROW LEVEL SECURITY;

-- Policies transcritas do pg_policies da PROD (não um resumo delas).
CREATE POLICY frec_select_carteira ON public.farmer_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid()))
         OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid())));
CREATE POLICY frec_insert_own_or_gestor ON public.farmer_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY frec_update_own_or_gestor ON public.farmer_recommendations FOR UPDATE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY frec_delete_own_or_gestor ON public.farmer_recommendations FOR DELETE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));

CREATE POLICY fbrec_select_carteira ON public.farmer_bundle_recommendations FOR SELECT TO authenticated
  USING ((SELECT private.cap_carteira_ler((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY fbrec_insert_own_or_gestor ON public.farmer_bundle_recommendations FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
CREATE POLICY fbrec_update_own_or_gestor ON public.farmer_bundle_recommendations FOR UPDATE TO authenticated
  USING ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())))
  WITH CHECK ((SELECT private.cap_carteira_escrever((SELECT auth.uid()))) OR (farmer_id = (SELECT auth.uid())));
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1a — SEED do LEGADO, aplicado ANTES da migration (como na realidade)
# ══════════════════════════════════════════════════════════════════════════════
# As 6.015 linhas pendentes de prod nasceram sem `run_id`, antes desta migration existir.
# Semear isso DEPOIS da migration é impossível — e é impossível de propósito: a trigger
# `trg_frec_exige_run_id` rejeita pendente sem run_id, que é justamente a invariante nova.
# (Este seed já rodou depois uma vez e o harness morreu com FG008: a trigger provou-se
# viva antes mesmo do assert A5 existir.) Semear aqui reproduz a ordem real dos fatos.
FARMER_A='aaaaaaaa-1111-1111-1111-111111111111'
FARMER_B='bbbbbbbb-2222-2222-2222-222222222222'
CLI_1='ccccccc1-1111-1111-1111-111111111111'
CLI_2='ccccccc2-2222-2222-2222-222222222222'
PROD_1='dddddddd-1111-1111-1111-111111111111'
PROD_2='dddddddd-2222-2222-2222-222222222222'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$FARMER_A'),('$FARMER_B'),('$CLI_1'),('$CLI_2') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, descricao) VALUES ('$PROD_1','Lixa 120'),('$PROD_2','Verniz PU') ON CONFLICT DO NOTHING;

-- Geração LEGADA (run_id ainda nem existe como coluna aqui).
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status, created_at)
VALUES
  ('$FARMER_A','$CLI_1','cross_sell','$PROD_1', 9.9, 0.99, 'pendente', now() - interval '70 days'),
  ('$FARMER_A','$CLI_1','cross_sell','$PROD_2', 5.0, 0.50, 'pendente', now() - interval '70 days'),
  ('$FARMER_A','$CLI_2','up_sell',   '$PROD_1', 3.0, 0.30, 'pendente', now() - interval '70 days');

-- Linha com DESFECHO registrado: histórico, tem de sobreviver a todo recálculo.
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status, offered_at, accepted_at)
VALUES ('$FARMER_A','$CLI_1','cross_sell','$PROD_1', 7.0, 0.70, 'aceito', now() - interval '60 days', now() - interval '59 days');

-- Carteira de OUTRO farmer: nenhum recálculo de A pode tocá-la.
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, p_ij, affinity_score, status)
VALUES ('$FARMER_B','$CLI_2','cross_sell','$PROD_1', 8.0, 0.80, 'pendente');

INSERT INTO public.farmer_bundle_recommendations
  (farmer_id, customer_user_id, bundle_products, affinity_bundle, status, created_at)
VALUES ('$FARMER_A','$CLI_1','[{"id":"x","name":"velho","price":10}]'::jsonb, 0.88, 'pendente', now() - interval '70 days');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1b — O GUARD DE ORDEM DE APPLY (a migration aborta sem a dependência)
# ══════════════════════════════════════════════════════════════════════════════
# Provado ANTES de aplicar de verdade: numa base sem affinity_score, a migration
# tem de recusar com instrução legível, não morrer com um 42703 críptico.
echo "── guard de dependência (pré-apply) ──"
P -q -c "ALTER TABLE public.farmer_recommendations DROP COLUMN affinity_score;"
DEP=$(P -tA -f "$REPO_ROOT/supabase/migrations/20260814223445_farmer_recomendacoes_geracao_vigente.sql" 2>&1 || true)
case "$DEP" in
  *"DEPENDENCIA FALTANDO"*) ok "D1 migration aborta sem a 20260725121000, nomeando-a" ;;
  *) bad "D1 migration NAO abortou sem affinity_score — veio: $(printf '%s' "$DEP" | head -c 160)" ;;
esac
P -q -c "ALTER TABLE public.farmer_recommendations ADD COLUMN affinity_score numeric;"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260814223445_farmer_recomendacoes_geracao_vigente.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# Idempotência: o founder pode re-colar (re-apply após falha parcial).
P -q -f "$MIG"
ok "I1 migration é idempotente (aplicada 2x sem erro)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid), private.cap_carteira_ler(uuid),
                           private.carteira_visivel_para(uuid,uuid) TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.farmer_recommendations, public.farmer_bundle_recommendations TO authenticated;
GRANT SELECT ON public.omie_products TO authenticated;
SQL

# payload de 2 linhas válidas para o FARMER_A
LOTE_OK=$(cat <<JSON
[{"customer_user_id":"$CLI_1","recommendation_type":"cross_sell","product_id":"$PROD_2","p_ij":4.4,"affinity_score":0.44,"complexity_factor":1,"cluster_volume_estimate":3},
 {"customer_user_id":"$CLI_2","recommendation_type":"up_sell","product_id":"$PROD_1","p_ij":2.2,"affinity_score":0.22,"complexity_factor":1,"cluster_volume_estimate":1}]
JSON
)
RUN_1='11111111-aaaa-aaaa-aaaa-111111111111'
RUN_2='22222222-aaaa-aaaa-aaaa-222222222222'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos ──"

TOT_ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations;")

# P1 — a substituição roda e devolve o balanço (3 pendentes de A expiram, 2 entram).
R=$(Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1',NULL,'$LOTE_OK'::jsonb);")
echo "$R" > /tmp/farmer-r1.json
eq "P1 expiradas" "$(printf '%s' "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["expiradas"])')" "3"
eq "P2 inseridas" "$(printf '%s' "$R" | python3 -c 'import json,sys; print(json.load(sys.stdin)["inseridas"])')" "2"

# P3 — EXPIRAR NÃO DELETA: o total só cresce (money-path: deleção exige prova positiva).
TOT_DEPOIS=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations;")
eq "P3 nada foi deletado (total antes+2)" "$TOT_DEPOIS" "$((TOT_ANTES + 2))"

# P4 — as expiradas carimbam expired_at E expired_by_run (rastreabilidade de "quem matou").
eq "P4 expiradas carimbadas com o run que as aposentou" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status='expirado' AND expired_at IS NOT NULL AND expired_by_run='$RUN_1';")" "3"

# P5 — A LINHA COM DESFECHO É INTOCÁVEL (o invariante mais caro desta migration).
eq "P5 linha 'aceito' sobreviveu intacta" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status='aceito' AND accepted_at IS NOT NULL AND expired_at IS NULL;")" "1"

# P6 — a carteira do OUTRO farmer não foi tocada.
eq "P6 carteira do farmer B intacta" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_B' AND status='pendente';")" "1"

# P7 — as novas linhas carregam o run_id da execução.
eq "P7 novas linhas com run_id" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='$RUN_1' AND status='pendente';")" "2"

# P8 — m_ij/lie ficam NULL mesmo com o payload tentando mandá-los (dinheiro não volta pelo browser).
LOTE_DINHEIRO="[{\"customer_user_id\":\"$CLI_1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD_1\",\"p_ij\":1,\"affinity_score\":0.11,\"m_ij\":999,\"lie\":888}]"
Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_2','$RUN_1','$LOTE_DINHEIRO'::jsonb);" >/dev/null
eq "P8 m_ij/lie ignorados do payload (ficam NULL)" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='$RUN_2' AND m_ij IS NULL AND lie IS NULL;")" "1"

# P9 — o BUG ORIGINAL: depois de 2 recálculos, o topo por afinidade é da geração NOVA.
# Sem a migration, a legada (affinity 0.99) continuaria vencendo a nova (0.11) para sempre.
eq "P9 topo do cliente = geração vigente, não a de 70 dias" \
   "$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND customer_user_id='$CLI_1' AND status='pendente' ORDER BY affinity_score DESC NULLS LAST, created_at DESC LIMIT 1;")" "$RUN_2"

# P10 — bundle: o CHECK alargado deixa 'expirado' entrar (sem a migration seria 23514 em runtime).
RB=$(Pq -c "SELECT public.farmer_bundle_recomendacoes_substituir('$FARMER_A','$RUN_1',NULL,'[{\"customer_user_id\":\"$CLI_1\",\"bundle_products\":[{\"id\":\"y\",\"name\":\"novo\",\"price\":20}],\"affinity_bundle\":0.42,\"support\":0.1,\"confidence\":0.5,\"lift\":1.5,\"p_bundle\":3.3}]'::jsonb);")
eq "P10 bundle expirou a geração anterior" "$(printf '%s' "$RB" | python3 -c 'import json,sys; print(json.load(sys.stdin)["expiradas"])')" "1"
eq "P11 bundle 'expirado' aceito pelo CHECK" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_bundle_recommendations WHERE status='expirado' AND expired_at IS NOT NULL;")" "1"

echo "── asserts negativos (SQLSTATE esperada + re-raise) ──"

# helper: roda um bloco DO que espera uma SQLSTATE; imprime OK_<code> ou relança.
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

PEND_ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente';")

# N1 — lote vazio RECUSA (não "expira tudo e deixa o farmer sem oferta").
espera_sqlstate "N1 lote vazio recusado" "FG003" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','[]'::jsonb)"

# N2 — GUARD CAUSAL: geração vista ≠ vigente (dois recálculos sobrepostos) → recusa.
espera_sqlstate "N2 corrida barrada pelo compare-and-swap" "FG006" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_1'::uuid,'$LOTE_OK'::jsonb)"

# N3/N4/N5/N6 — validação do lote ANTES de expirar nada.
espera_sqlstate "N3 afinidade NaN recusada" "FG007" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','[{\"customer_user_id\":\"$CLI_1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD_1\",\"affinity_score\":\"NaN\"}]'::jsonb)"
espera_sqlstate "N4 afinidade Infinity recusada" "FG007" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','[{\"customer_user_id\":\"$CLI_1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD_1\",\"affinity_score\":\"Infinity\"}]'::jsonb)"
espera_sqlstate "N5 afinidade negativa recusada" "FG007" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','[{\"customer_user_id\":\"$CLI_1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD_1\",\"affinity_score\":-1}]'::jsonb)"
espera_sqlstate "N6 tipo de recomendação inválido recusado" "FG007" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','[{\"customer_user_id\":\"$CLI_1\",\"recommendation_type\":\"foo\",\"product_id\":\"$PROD_1\",\"affinity_score\":0.5}]'::jsonb)"
espera_sqlstate "N7 farmer_id nulo recusado" "FG001" \
  "public.farmer_recomendacoes_substituir(NULL,'$RUN_1','$RUN_2','$LOTE_OK'::jsonb)"
espera_sqlstate "N8 payload não-array recusado" "FG002" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','{\"a\":1}'::jsonb)"

# N9 — teto defensivo (o lote não pode ser ilimitado).
espera_sqlstate "N9 teto de 50000 linhas" "FG004" \
  "public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2',(SELECT jsonb_agg(jsonb_build_object('customer_user_id','$CLI_1','recommendation_type','cross_sell','product_id','$PROD_1','affinity_score',0.5)) FROM generate_series(1,50001)))"

# N10 — TODAS as recusas acima deixaram as pendentes INTACTAS (nada foi expirado "no meio").
eq "N10 nenhuma recusa expirou linha (pendentes intactas)" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente';")" "$PEND_ANTES"

# N11 — CHECK de coerência na TABELA: 'expirado' sem expired_at é rejeitado (23514).
# A invariante mora na TABELA, não só no writer: o próximo writer que marcar
# 'expirado' sem carimbar a data some dos leitores sem deixar rastro de quando.
R=$(P -tA 2>&1 -c "UPDATE public.farmer_recommendations SET status='expirado', expired_at=NULL WHERE farmer_id='$FARMER_B';" || true)
case "$R" in
  *farmer_recommendations_expirado_coerente*) ok "N11 CHECK barra 'expirado' sem expired_at (23514)" ;;
  *) bad "N11 CHECK NAO barrou — veio: $(printf '%s' "$R" | head -c 160)" ;;
esac

echo "── asserts de autorização (RLS + gate) ──"

# A1 — farmer B (sem cap) NÃO substitui a carteira de A.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_B'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1','$RUN_2','$LOTE_OK'::jsonb);
SQL
)
case "$R" in
  *"Acesso negado"*) ok "A1 farmer B barrado ao mexer na carteira de A (42501)" ;;
  *) bad "A1 farmer B NAO foi barrado — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A2 — o próprio farmer A CONSEGUE (a autorização não é fail-closed demais).
GER_ATUAL=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$FARMER_A'; SET test.role='authenticated'; SET ROLE authenticated;
SELECT public.farmer_recomendacoes_substituir('$FARMER_A','33333333-aaaa-aaaa-aaaa-333333333333','$GER_ATUAL'::uuid,'$LOTE_OK'::jsonb);
SQL
)
case "$R" in
  *inseridas*) ok "A2 o próprio farmer A substitui a carteira dele" ;;
  *) bad "A2 farmer A NAO conseguiu substituir — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A4 — SESSÃO SEM IDENTIDADE NENHUMA é barrada (regressão do three-valued logic).
# A forma "óbvia" do gate, `IF NOT (a OR b OR c)`, NÃO barra aqui: sem JWT `auth.uid()` é
# NULL, `p_farmer_id = auth.uid()` é NULL, a disjunção inteira vira NULL, e `IF NOT NULL`
# não dispara em PL/pgSQL — o guard devolve nulo em vez de negar. Medido em prod:
#   NOT (false OR NULL OR false)         => NULL
#   (false OR NULL OR false) IS NOT TRUE => true
# Este assert existe porque o harness inteiro rodava VERDE exatamente por esse buraco:
# os positivos passavam sem identidade, e ninguém percebia que o gate não barrava.
R=$(P -tA 2>&1 <<SQL || true
SET test.role=''; SET test.uid='';
DO \$\$
BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$FARMER_A','88888888-aaaa-aaaa-aaaa-888888888888',NULL,'$LOTE_OK'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in
  *SENTINELA_BARROU_CERTO*) ok "A4 sessão sem identidade barrada (o gate fecha em TRUE, não em NOT-NULL)" ;;
  *SENTINELA_NAO_BARROU*)   bad "A4 sessão SEM identidade PASSOU — o gate está em three-valued logic" ;;
  *)                        bad "A4 erro inesperado: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A5 — INSERT direto de linha pendente sem run_id é REJEITADO pela trigger.
# O compare-and-swap é convenção dos hooks; esta é a invariante da TABELA. Sem ela, uma
# aba com o JS antigo grava pendente com run_id NULL, escapa da substituição e volta a
# competir no topo — o bug original de volta por um writer que a RPC nem vê.
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, recommendation_type, product_id, status) VALUES ('$FARMER_A','$CLI_1','cross_sell','$PROD_1','pendente');" || true)
case "$R" in
  *"exige run_id"*) ok "A5 trigger barra INSERT direto de pendente sem run_id (FG008)" ;;
  *) bad "A5 INSERT direto NAO foi barrado — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# A6 — mas a trigger NÃO atrapalha o histórico: linha com desfecho entra sem run_id.
R=$(P -tA 2>&1 -c "INSERT INTO public.farmer_recommendations (farmer_id, customer_user_id, recommendation_type, product_id, status, offered_at) VALUES ('$FARMER_A','$CLI_1','cross_sell','$PROD_1','ofertado', now());" || true)
case "$R" in
  *ERROR*) bad "A6 trigger barrou linha de HISTÓRICO (ofertado) — cedo demais: $(printf '%s' "$R" | head -c 160)" ;;
  *) ok "A6 trigger só mira 'pendente' — linha de desfecho passa" ;;
esac

# A3 — anon não executa (REVOKE da migration).
R=$(P -tA 2>&1 <<SQL || true
SET ROLE anon;
SELECT public.farmer_recomendacoes_substituir('$FARMER_A','$RUN_1',NULL,'$LOTE_OK'::jsonb);
SQL
)
case "$R" in
  *"permission denied"*|*"permissão negada"*) ok "A3 anon sem EXECUTE na RPC" ;;
  *) bad "A3 anon NAO foi barrado — veio: $(printf '%s' "$R" | head -c 200)" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
# Sabotagem em MEMÓRIA (CREATE OR REPLACE derivado do .sql por perl), nunca no
# arquivo do repo — árvore suja + `git checkout --` já destruiu fix uncommitted
# aqui antes (money-path §9). Cada sabotagem PROVA que aplicou antes de julgar:
# sabotagem que não casa nada devolve verde de código íntegro, que se lê como
# "o assert não tem dente" e convida a enfraquecê-lo.
echo "── falsificação ──"

SAB="/tmp/farmer-sabotado-$$.sql"
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

# F1 — remover o guard `AND status='pendente'` do UPDATE de expiração.
#      Deve arrastar a linha com DESFECHO junto (P5 fica vermelho).
if sabota "F1" "s/     AND status = 'pendente';\n  GET DIAGNOSTICS v_expiradas/     AND true;\n  GET DIAGNOSTICS v_expiradas/" "AND true;"; then
  P -q -c "UPDATE public.farmer_recommendations SET status='aceito', expired_at=NULL, accepted_at=now() WHERE farmer_id='$FARMER_A' AND status='expirado' AND id=(SELECT id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='expirado' LIMIT 1);"
  ACEITO_ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='aceito';")
  G=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','44444444-aaaa-aaaa-aaaa-444444444444',$([ -z "$G" ] && echo NULL || echo "'$G'"),'$LOTE_OK'::jsonb);" >/dev/null 2>&1 || true
  eq_esperando_vermelho "P5 linha com desfecho preservada" \
    "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='aceito';")" "$ACEITO_ANTES"
  restaura
fi

# F2 — desligar o guard causal. A corrida (N2) deixa de ser barrada.
if sabota "F2" "s/IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN/IF false THEN/g" "IF false THEN"; then
  G=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$FARMER_A','55555555-aaaa-aaaa-aaaa-555555555555','99999999-9999-9999-9999-999999999999'::uuid,'$LOTE_OK'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE 'FG006' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: sem o guard causal, a corrida PASSA (N2 seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: N2 barrou mesmo com o guard causal desligado" ;;
    *) bad "F2 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F3 — enfraquecer a finitude para só o sinal (`>= 0`), a forma que o money-path
#      documenta como falso-saneamento: NaN e Infinity passam.
if sabota "F3" "s/     OR NOT \(\n          r\.affinity_score >= 0\n          AND r\.affinity_score < 'Infinity'::numeric\n          AND r\.affinity_score <> 'NaN'::numeric\n        \);/     OR r.affinity_score < 0;/" "OR r.affinity_score < 0;"; then
  G=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  OUT=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$FARMER_A','66666666-aaaa-aaaa-aaaa-666666666666',$([ -z "$G" ] && echo NULL || echo "'$G'"),
    '[{"customer_user_id":"$CLI_1","recommendation_type":"cross_sell","product_id":"$PROD_1","affinity_score":"NaN"}]'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE 'FG007' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: com só '>= 0', NaN entra no ranking (N3 seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: N3 barrou NaN mesmo com o guard reduzido a sinal" ;;
    *) bad "F3 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

# F4 — trocar a expiração por DELETE. P3 (nada é deletado) tem de ficar vermelho.
if sabota "F4" "s/  UPDATE public\.farmer_recommendations\n     SET status         = 'expirado',\n         expired_at     = clock_timestamp\(\),\n         expired_by_run = p_run_id,\n         updated_at     = clock_timestamp\(\)\n   WHERE farmer_id = p_farmer_id\n     AND status = 'pendente';/  DELETE FROM public.farmer_recommendations WHERE farmer_id = p_farmer_id AND status = 'pendente';/" "DELETE FROM public.farmer_recommendations WHERE farmer_id"; then
  G=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  T_ANTES=$(Pq -c "SELECT count(*) FROM public.farmer_recommendations;")
  N_LOTE=2
  Pq -c "SELECT public.farmer_recomendacoes_substituir('$FARMER_A','77777777-aaaa-aaaa-aaaa-777777777777',$([ -z "$G" ] && echo NULL || echo "'$G'"),'$LOTE_OK'::jsonb);" >/dev/null 2>&1 || true
  eq_esperando_vermelho "P3 nada foi deletado (total antes+2)" \
    "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations;")" "$((T_ANTES + N_LOTE))"
  restaura
fi

# F5 — o gate volta à forma "óbvia" `IF NOT (...)`. A4 tem de ficar VERMELHO: com NULL na
# disjunção o RAISE nunca acontece, e uma sessão sem identidade nenhuma passa direto.
# Sabota AS DUAS RPCs (/g). O helper `sabota` valida por marca PRESENTE, e aqui o que
# prova a aplicação é a forma NOVA estar AUSENTE — por isso a checagem é feita à mão,
# nos dois sentidos (a antiga apareceu E a nova sumiu). Sabotagem parcial seria pior que
# nenhuma: mediria a RPC ainda íntegra e devolveria verde de código sabotado.
perl -0777 -pe "s/  IF \(\n    coalesce\(auth\.role\(\), ''\) = 'service_role'\n    OR p_farmer_id = auth\.uid\(\)\n    OR coalesce\(private\.cap_carteira_escrever\(auth\.uid\(\)\), false\)\n  \) IS NOT TRUE THEN/  IF NOT (\n    coalesce(auth.role(), '') = 'service_role'\n    OR p_farmer_id = auth.uid()\n    OR private.cap_carteira_escrever(auth.uid())\n  ) THEN/g" "$MIG" > "$SAB"
if ! command grep -q "IF NOT (" "$SAB"; then
  bad "SABOTAGEM F5 NAO APLICOU (padrão não casou) — falsificação INVÁLIDA"
elif command grep -q "IS NOT TRUE THEN" "$SAB"; then
  bad "SABOTAGEM F5 PARCIAL (sobrou IS NOT TRUE) — falsificação INVÁLIDA"
else
  P -q -f "$SAB"
  # A geração vigente REAL: sem ela o CAS recusaria com FG006 e o `WHEN OTHERS THEN RAISE`
  # relançaria — o assert leria "erro inesperado" e o vermelho seria do harness, não da
  # sabotagem. O objetivo aqui é o gate de AUTORIZAÇÃO, então todo o resto tem de estar
  # coerente para o fluxo chegar até ele e passar.
  G=$(Pq -c "SELECT run_id FROM public.farmer_recommendations WHERE farmer_id='$FARMER_A' AND status='pendente' ORDER BY created_at DESC, id DESC LIMIT 1;")
  OUT=$(P -tA 2>&1 <<SQL || true
SET test.role=''; SET test.uid='';
DO \$\$
BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$FARMER_A','99999999-aaaa-aaaa-aaaa-999999999999',$([ -z "$G" ] && echo NULL || echo "'$G'"),'$LOTE_OK'::jsonb);
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN SQLSTATE '42501' THEN RAISE NOTICE 'SENTINELA_BARROU_CERTO';
          WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in
    *SENTINELA_NAO_BARROU*) ok "falsificação mordeu: com 'IF NOT (...)' a sessão sem identidade PASSA (A4 seria falso-verde)" ;;
    *SENTINELA_BARROU_CERTO*) bad "FALSIFICAÇÃO SEM DENTE: A4 barrou mesmo com o gate em three-valued logic" ;;
    *) bad "F5 erro inesperado: $(printf '%s' "$OUT" | head -c 200)" ;;
  esac
  restaura
fi

rm -f "$SAB"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

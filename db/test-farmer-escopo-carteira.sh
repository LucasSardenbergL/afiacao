#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="farmer-escopo-carteira"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos: o que as RPCs LEEM/ESCREVEM mas não criam.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

-- UNIQUE (customer_user_id) é o que torna "o dono do cliente" uma FUNÇÃO — a premissa
-- inteira do gate. Sem ele o LEFT JOIN multiplicaria linhas e o count() mentiria.
CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id uuid NOT NULL
);

CREATE TABLE public.farmer_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  recommendation_type text,
  product_id uuid,
  current_product_id uuid,
  p_ij numeric, m_ij numeric, lie numeric,
  affinity_score numeric, complexity_factor numeric, cluster_volume_estimate numeric,
  status text NOT NULL DEFAULT 'pendente',
  run_id uuid, expired_at timestamptz, expired_by_run uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.farmer_bundle_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_products jsonb, bundle_type text,
  support numeric, confidence numeric, lift numeric,
  p_bundle numeric, m_bundle numeric, lie_bundle numeric,
  complexity_factor numeric, affinity_bundle numeric,
  approach_type text, argument_phone text, argument_whatsapp text,
  argument_technical text, customer_profile text, argument_effectiveness numeric,
  status text NOT NULL DEFAULT 'pendente',
  run_id uuid, expired_at timestamptz, expired_by_run uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE public.farmer_geracao_vigente (
  motor text NOT NULL, farmer_id uuid NOT NULL, run_id uuid,
  PRIMARY KEY (motor, farmer_id)
);

-- Stubs de dependência. NÃO são o objeto sob teste — existem para a RPC real rodar.
CREATE FUNCTION private.cap_carteira_escrever(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT false $f$;

CREATE FUNCTION public.farmer_geracao_registrar(
  p_motor text, p_farmer_id uuid, p_run_id uuid, p_tipo text, p_n integer,
  p_completude text, p_motivo text, p_insumos jsonb, p_head uuid)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.farmer_geracao_vigente (motor, farmer_id, run_id)
  VALUES (p_motor, p_farmer_id, p_run_id)
  ON CONFLICT (motor, farmer_id) DO UPDATE SET run_id = EXCLUDED.run_id;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migração REAL (Lei #1): o mesmo arquivo que o founder cola no SQL Editor.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/db/farmer-escopo-carteira-fg009.sql"
[ -f "$MIG" ] || { echo "migração ausente: $MIG"; exit 1; }
P -q -f "$MIG"
echo "═══ migração aplicada ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds
# ══════════════════════════════════════════════════════════════════════════════
A="aaaaaaaa-0000-4000-8000-000000000001"   # farmer DONO
B="bbbbbbbb-0000-4000-8000-000000000002"   # o OUTRO farmer
C1="cccccccc-0000-4000-8000-000000000001"  # cliente de A
C2="cccccccc-0000-4000-8000-000000000002"  # cliente de A
C3="cccccccc-0000-4000-8000-000000000003"  # cliente de B  ← o eixo do gate
C4="cccccccc-0000-4000-8000-000000000004"  # SEM linha de score (dono desconhecido)
RUN0="99999999-0000-4000-8000-000000000000"
PROD="dddddddd-0000-4000-8000-000000000001"

P -q <<SQL
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES
  ('$C1','$A'), ('$C2','$A'), ('$C3','$B');
-- A geração ANTERIOR de A: é ela que precisa SOBREVIVER a um lote recusado.
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score, status, run_id)
VALUES ('$A','$C1','cross_sell','$PROD',0.5,'pendente','$RUN0');
INSERT INTO public.farmer_bundle_recommendations
  (farmer_id, customer_user_id, bundle_products, affinity_bundle, status, run_id)
VALUES ('$A','$C1','[{"id":"x"},{"id":"y"}]'::jsonb,0.5,'pendente','$RUN0');
SQL

# Chamador = o farmer A, autenticado (não service_role): é o caminho real do browser.
COMO_A="SET test.uid='$A'; SET test.role='authenticated';"

linha()  { echo "[{\"customer_user_id\":\"$1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD\",\"affinity_score\":0.7}]"; }
bundle() { echo "[{\"customer_user_id\":\"$1\",\"bundle_products\":[{\"id\":\"x\"},{\"id\":\"y\"}],\"affinity_bundle\":0.7}]"; }

# Roda a RPC e ecoa a SQLSTATE (vazio = sucesso). O bloco captura FG009 e RE-LANÇA o resto
# (Lei #2): um erro de digitação no seed não pode pintar verde de "gate mordeu".
chamar() { # $1=fn $2=json $3=geracao_vista
  Pq -c "$COMO_A
  DO \$t\$ BEGIN
    PERFORM public.$1('$A'::uuid, gen_random_uuid(), $3, '$2'::jsonb, 'completa', NULL, NULL, NULL);
    RAISE NOTICE 'SEM_ERRO';
  EXCEPTION
    WHEN SQLSTATE 'FG009' THEN RAISE NOTICE 'FG009';
    WHEN OTHERS THEN RAISE;
  END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  \(.*\)$/\1/p;s/^ERRO[^:]*:  \(.*\)$/ERRO: \1/p;s/^ERROR:  \(.*\)$/ERRO: \1/p' | tail -1 || true
}

pendentes() { Pq -c "SELECT count(*) FROM public.$1 WHERE farmer_id='$A' AND status='pendente';"; }

# O compare-and-swap (FG006) roda ANTES da validação de linhas, então todo lote precisa
# declarar a geração que está substituindo — senão o teste mede o CAS, não o gate de escopo.
geracao_atual() {
  Pq -c "SELECT coalesce((SELECT quote_literal(run_id::text) FROM public.$1
           WHERE farmer_id='$A' AND status='pendente'
           ORDER BY created_at DESC, id DESC LIMIT 1), 'NULL');"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "─── cross-sell ───"
# N1: cliente de OUTRO farmer. O caso que produziu as 2.676 linhas de prod.
eq "N1 lote com cliente de outro farmer → FG009" "$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "'$RUN0'")" "FG009"
# N2: cliente SEM dono conhecido. `IS DISTINCT FROM` é o que o põe do mesmo lado de N1;
# com `<>` o NULL sumiria no WHERE e este lote PASSARIA.
eq "N2 lote com cliente sem score → FG009" "$(chamar farmer_recomendacoes_substituir "$(linha "$C4")" "'$RUN0'")" "FG009"
# N3: o gate roda ANTES do UPDATE — a promessa "nada foi expirado" precisa ser verdade,
# senão a recusa deixa o farmer sem oferta nenhuma (pior que o bug).
eq "N3 recusa NÃO expira a geração anterior" "$(pendentes farmer_recommendations)" "1"
# P1: o caminho feliz segue vivo. Sem ele o gate poderia estar recusando TUDO e os
# negativos passariam de graça.
eq "P1 lote da própria carteira → sucesso" "$(chamar farmer_recomendacoes_substituir "$(linha "$C1")" "'$RUN0'")" "SEM_ERRO"
eq "P1b a geração nova substituiu a anterior" "$(pendentes farmer_recommendations)" "1"
eq "P1c a anterior foi EXPIRADA, não apagada" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE status='expirado' AND run_id='$RUN0';")" "1"

echo "─── bundle ───"
eq "N4 bundle com cliente de outro farmer → FG009" "$(chamar farmer_bundle_recomendacoes_substituir "$(bundle "$C3")" "'$RUN0'")" "FG009"
eq "N5 bundle com cliente sem score → FG009" "$(chamar farmer_bundle_recomendacoes_substituir "$(bundle "$C4")" "'$RUN0'")" "FG009"
eq "N6 recusa NÃO expira o bundle anterior" "$(pendentes farmer_bundle_recommendations)" "1"
eq "P2 bundle da própria carteira → sucesso" "$(chamar farmer_bundle_recomendacoes_substituir "$(bundle "$C1")" "'$RUN0'")" "SEM_ERRO"

echo "─── fail-closed sob RLS (a cegueira precisa RECUSAR, não passar) ───"
# A RPC é SECURITY INVOKER e em prod `farmer_client_scores` tem RLS
# (`cap_carteira_ler OR carteira_visivel_para`). Aqui a policy espelha o farmer comum:
# ele só ENXERGA a própria carteira. O cliente alheio some da leitura, o LEFT JOIN devolve
# NULL — e o gate precisa ler NULL como RECUSA. Se lesse como "sem divergência", a RLS
# viraria a porta de trás do gate.
P -q <<SQL
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcs_so_a_minha ON public.farmer_client_scores FOR SELECT
  USING (farmer_id = auth.uid());
GRANT SELECT ON public.farmer_client_scores TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.farmer_recommendations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.farmer_bundle_recommendations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.farmer_geracao_vigente TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;   -- o Supabase já concede em prod
SQL
G_REC="$(geracao_atual farmer_recommendations)"
CEGO=$(Pq -c "$COMO_A SET ROLE authenticated;
DO \$t\$ BEGIN
  PERFORM public.farmer_recomendacoes_substituir('$A'::uuid, gen_random_uuid(), $G_REC, '$(linha "$C3")'::jsonb, 'completa', NULL, NULL, NULL);
  RAISE NOTICE 'SEM_ERRO';
EXCEPTION
  WHEN SQLSTATE 'FG009' THEN RAISE NOTICE 'FG009';
  WHEN OTHERS THEN RAISE;
END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  \(.*\)$/\1/p;s/^ERROR:  \(.*\)$/ERRO: \1/p' | tail -1 || true)
eq "R1 cliente invisível pela RLS → FG009 (fail-closed)" "$CEGO" "FG009"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota o gate e EXIGE vermelho.
# ══════════════════════════════════════════════════════════════════════════════
echo "─── falsificação ───"
P -q <<SQL
ALTER TABLE public.farmer_client_scores DISABLE ROW LEVEL SECURITY;
SQL
# Sabotagem cirúrgica: só o predicado do gate. `WHERE false` zera a contagem, então
# `v_fora_escopo` é sempre 0 e o RAISE nunca dispara — o gate vira decoração.
SABOTADO="$(mktemp /tmp/sabota-escopo.XXXXXX)"
sed 's/WHERE s\.farmer_id IS DISTINCT FROM p_farmer_id;/WHERE false;/' "$MIG" > "$SABOTADO"
if ! command grep -q "WHERE false;" "$SABOTADO"; then
  bad "falsificação NÃO aplicou a sabotagem (padrão não casou) — asserts abaixo seriam teatro"
else
  P -q -f "$SABOTADO"
  # A sentinela é a SQLSTATE 'FG009', que o código NÃO emite quando sabotado — e "SEM_ERRO"
  # é NOSSO texto, não do Postgres, então nenhum casamento acidental pinta verde.
  V1="$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "$(geracao_atual farmer_recommendations)")"
  V2="$(chamar farmer_bundle_recomendacoes_substituir "$(bundle "$C3")" "$(geracao_atual farmer_bundle_recommendations)")"
  if [ "$V1" = "FG009" ] || [ "$V2" = "FG009" ]; then
    bad "FALSIFICAÇÃO: com o gate zerado o lote alheio AINDA foi recusado — o assert não tem dente (cross=[$V1] bundle=[$V2])"
  else
    ok "falsificação: gate zerado ⇒ o lote alheio PASSA (cross=[$V1] bundle=[$V2]) — os asserts têm dente"
  fi
  # Restaura a versão verdadeira e reconfirma, para o harness não terminar com o corpo furado.
  P -q -f "$MIG"
  eq "restaurado: o gate volta a morder" "$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "$(geracao_atual farmer_recommendations)")" "FG009"
fi
rm -f "$SABOTADO"

echo
echo "═══ $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1

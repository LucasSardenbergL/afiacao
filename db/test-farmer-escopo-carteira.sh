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

CREATE TABLE public._insumos_vistos (run_id uuid PRIMARY KEY, insumos jsonb);
-- O writer e SECURITY INVOKER, entao este INSERT roda com os privilegios de QUEM chamou
-- — e o harness chama sob `authenticated`. Sem o GRANT, o caminho feliz reprovaria por
-- permissao de uma tabela que so existe no stub: assert vermelho pelo motivo ERRADO.
GRANT SELECT, INSERT, UPDATE ON public._insumos_vistos TO PUBLIC;

CREATE FUNCTION public.farmer_geracao_registrar(
  p_motor text, p_farmer_id uuid, p_run_id uuid, p_tipo text, p_n integer,
  p_completude text, p_motivo text, p_insumos jsonb, p_head uuid)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.farmer_geracao_vigente (motor, farmer_id, run_id)
  VALUES (p_motor, p_farmer_id, p_run_id)
  ON CONFLICT (motor, farmer_id) DO UPDATE SET run_id = EXCLUDED.run_id;
  -- O stub GUARDA os insumos: o sensor da distribuicao sai por este parametro, e descarta-lo
  -- faria o assert dele passar por vacuidade — verde sobre um numero que ninguem emitiu.
  INSERT INTO public._insumos_vistos (run_id, insumos) VALUES (p_run_id, p_insumos)
  ON CONFLICT (run_id) DO UPDATE SET insumos = EXCLUDED.insumos;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migração REAL (Lei #1): o mesmo arquivo que o founder cola no SQL Editor.
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260906164002_captura_authz_escopo_carteira_farmer.sql"
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
-- 'FOR SHARE' (lock causal do lote, só existe no corpo VIVO) exige UPDATE ALÉM de
-- SELECT — só-SELECT derruba a RPC com 42501 em RUNTIME. Em prod a relacl desta tabela é
-- 'authenticated=arwdDxtm' (medido via psql-ro 2026-08-30), então este GRANT é FIDELIDADE
-- ao ambiente real, não afrouxamento. O assert PRIV1 abaixo prova que a dependência existe.
GRANT SELECT, UPDATE ON public.farmer_client_scores TO authenticated;
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

# ── PRIV1 — a dependência de PRIVILÉGIO que o FOR SHARE cria (só existe no corpo VIVO) ──
# O guard de escopo trava as linhas do lote com SELECT ... FOR SHARE, e o Postgres exige
# UPDATE (não basta SELECT; e DELETE sozinho TAMBÉM não basta — medido em PG17 2026-09-06)
# para travar linha. Basta UPDATE de UMA coluna, e nesse caso has_table_privilege devolve f
# enquanto has_any_column_privilege devolve t. A RPC é SECURITY INVOKER: quem trava é o
# authenticated do farmer, não o owner. Logo um endurecimento futuro perfeitamente plausível
# -- "authenticated não escreve em farmer_client_scores, revoga UPDATE" -- derruba a RPC em
# RUNTIME, no CAMINHO FELIZ, com 42501. Este assert torna esse requisito invisível uma
# invariante testada.
# ⚠️ Tem de rodar com SET ROLE authenticated DE VERDADE: o helper chamar() só seta o GUC que
# auth.uid()/auth.role() leem e permanece como superuser, para quem nenhum REVOKE morde --
# sem o SET ROLE este assert passaria por cegueira, que é o teatro que a Lei #3 mata.
# Sentinela: "permission denied", texto do POSTGRES, não nosso.
priv_c1() { # roda o CAMINHO FELIZ (cliente da própria carteira) como authenticated de verdade
  Pq -c "$COMO_A SET ROLE authenticated;
  DO \$t\$ BEGIN
    PERFORM public.farmer_recomendacoes_substituir('$A'::uuid, gen_random_uuid(), $(geracao_atual farmer_recommendations), '$(linha "$C1")'::jsonb, 'completa', NULL, NULL, NULL);
    RAISE NOTICE 'SEM_ERRO';
  EXCEPTION
    WHEN SQLSTATE 'FG009' THEN RAISE NOTICE 'FG009';
    WHEN OTHERS THEN RAISE;
  END \$t\$;" 2>&1 | sed -n 's/^NOTICE:  \(.*\)$/\1/p;s/^ERROR:  \(.*\)$/ERRO: \1/p' | tail -1 || true
}
P -q <<SQL
REVOKE UPDATE ON public.farmer_client_scores FROM authenticated;
SQL
PRIV="$(priv_c1)"
case "$PRIV" in
  *"permission denied"*) ok "PRIV1 sem UPDATE o FOR SHARE derruba a RPC no caminho feliz (=$PRIV)" ;;
  SEM_ERRO)              bad "PRIV1 a RPC passou sem privilégio de lock — o FOR SHARE não está no corpo aplicado" ;;
  *)                     bad "PRIV1 erro inesperado — esperado permission denied, veio [$PRIV]" ;;
esac
P -q <<SQL
GRANT UPDATE ON public.farmer_client_scores TO authenticated;
SQL
eq "PRIV1b com o GRANT de volta, o caminho feliz volta" "$(priv_c1)" "SEM_ERRO"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota o gate e EXIGE vermelho.
# ══════════════════════════════════════════════════════════════════════════════
# O guard de VALIDADE (DO $validade$) recusa reescrever um corpo que não é o capturado — que é
# de propósito o estado que a sabotagem cria. É defesa DIFERENTE do gate de escopo, com assert
# próprio (V1); nas sabotagens ele sai, senão o harness testaria o guard querendo testar o gate.
# shellcheck disable=SC2016  # o literal `$validade$` é o dollar-quote do SQL: expandir seria o bug
sem_guard() { sed '/^DO \$validade\$/,/^\$validade\$;/d' "$1"; }

echo "─── V1: o guard de validade morde quando o corpo vivo divergiu ───"
# Cenário: o founder cola isto dias depois. Se alguém recriou a função no intervalo, aplicar às
# cegas reverteria produção para a versão capturada — em silêncio, que é a classe toda.
DIVERG="$(mktemp /tmp/diverg-farmer.XXXXXX)"
sem_guard "$MIG" | sed "s/USING ERRCODE = 'FG009'/USING ERRCODE = 'FG010'/" > "$DIVERG"
P -q -f "$DIVERG"
V1="$(P -f "$MIG" 2>&1 | sed -n 's/.*ERROR:  \(ABORTADO[^(]*\).*/\1/p' | tail -1 || true)"
case "$V1" in
  ABORTADO*) ok "V1 aplicar sobre corpo divergente ABORTA (=$(echo "$V1" | cut -c1-52)…)" ;;
  *)         bad "V1 o guard de validade NÃO mordeu — a migration reescreveria produção às cegas [$V1]" ;;
esac
P -q -f <(sem_guard "$MIG")
eq "V1b restaurado: o gate de escopo volta a morder" "$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "$(geracao_atual farmer_recommendations)")" "FG009"
rm -f "$DIVERG"

# ═══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — A ORDEM DO MELHOR INDIVIDUAL (20260907230000)
#
# Esta migration sucede a 20260906164002 no MESMO writer (`CREATE OR REPLACE`, a
# última a recriar vence), então é aqui que ela se prova — e não no harness de
# head, cuja cadeia para na 20260815181500 e produz um writer que produção já não
# tem (sem o gate de escopo). ⚠️ Dívida PREEXISTENTE, declarada: o
# `db/test-farmer-head-geracao.sh` testa uma versão do writer anterior à de ontem.
# ═══════════════════════════════════════════════════════════════════════════════
echo "─── ordem do melhor individual ───"

MIG_ORDEM="$REPO_ROOT/supabase/migrations/20260907230000_farmer_ordem_e_referencia_ambigua.sql"
[ -f "$MIG_ORDEM" ] || { echo "migração ausente: $MIG_ORDEM"; exit 1; }
P -q -f "$MIG_ORDEM"
P -q -f "$MIG_ORDEM"
ok "O0 migration da ordem é idempotente (aplicada 2x sem erro)"

D="dddddddd-0000-4000-8000-00000000000d"      # farmer só desta zona
VAZIO="eeeeeeee-0000-4000-8000-00000000000e"  # farmer sem NENHUMA linha
CE="cccccccc-0000-4000-8000-0000000000e1"     # eleito
CT="cccccccc-0000-4000-8000-0000000000a1"     # empatado com 3º candidato fora do topo
CU="cccccccc-0000-4000-8000-0000000000b1"     # singleton SEM ordem
CS="cccccccc-0000-4000-8000-0000000000c1"     # singleton COM ordem
CP="cccccccc-0000-4000-8000-0000000000d1"     # ordenação parcial [1,2,NULL]
CM="cccccccc-0000-4000-8000-0000000000f1"     # referência ambígua declarada
CN="cccccccc-0000-4000-8000-0000000000e2"     # flag NULA com ordem preenchida
P2="dddddddd-0000-4000-8000-000000000002"
P3="dddddddd-0000-4000-8000-000000000003"
RUND="99999999-0000-4000-8000-00000000000d"

P -q <<SQL
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES
  ('$CE','$D'),('$CT','$D'),('$CU','$D'),('$CS','$D'),('$CP','$D'),('$CM','$D'),('$CN','$D');

INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score,
   status, run_id, ordem, referencia_ambigua)
VALUES
  ('$D','$CE','cross_sell','$PROD',0.1,'pendente','$RUND',1,false),
  ('$D','$CE','cross_sell','$P2'  ,0.1,'pendente','$RUND',2,false),

  ('$D','$CT','cross_sell','$PROD',0.1,'pendente','$RUND',1,false),
  ('$D','$CT','cross_sell','$P2'  ,0.1,'pendente','$RUND',1,false),
  ('$D','$CT','cross_sell','$P3'  ,0.1,'pendente','$RUND',2,false),

  ('$D','$CU','up_sell'   ,'$PROD',0.1,'pendente','$RUND',NULL,false),
  ('$D','$CS','cross_sell','$PROD',0.1,'pendente','$RUND',1,false),

  ('$D','$CP','cross_sell','$PROD',0.1,'pendente','$RUND',1,false),
  ('$D','$CP','cross_sell','$P2'  ,0.1,'pendente','$RUND',2,false),
  ('$D','$CP','cross_sell','$P3'  ,0.1,'pendente','$RUND',NULL,false),

  ('$D','$CM','up_sell'   ,'$PROD',0.1,'pendente','$RUND',1,true),
  ('$D','$CM','up_sell'   ,'$P2'  ,0.1,'pendente','$RUND',2,true),

  ('$D','$CN','up_sell'   ,'$PROD',0.1,'pendente','$RUND',1,NULL),
  ('$D','$CN','up_sell'   ,'$P2'  ,0.1,'pendente','$RUND',2,NULL);
SQL

campo() { # <cliente> <campo>
  Pq -c "SELECT j->>'$2' FROM jsonb_array_elements(
           public.farmer_melhores_individuais_por_cliente('$D')) j
          WHERE j->>'customer_user_id'='$1';"
}
nprod() { # <cliente> — quantos SKUs a tela vai NOMEAR
  Pq -c "SELECT jsonb_array_length(j->'produtos') FROM jsonb_array_elements(
           public.farmer_melhores_individuais_por_cliente('$D')) j
          WHERE j->>'customer_user_id'='$1';"
}

# ── os cinco estados, e a PRECEDÊNCIA entre eles ────────────────────────────────
eq "O1 topo único com ordem conhecida = eleito"         "$(campo "$CE" situacao)" "eleito"
eq "O2 dois no rank mínimo = empatado"                  "$(campo "$CT" situacao)" "empatado"
eq "O3 singleton SEM ordem = unico_registrado"          "$(campo "$CU" situacao)" "unico_registrado"
# ⚠️ o assert que prende a precedência: sem ela este caso satisfaz 'unico_registrado'
#    E 'topo único' ao mesmo tempo, e a versão anterior da spec exigia os DOIS.
eq "O4 singleton COM ordem NÃO vira eleito"             "$(campo "$CS" situacao)" "unico_registrado"
eq "O5 [1,2,NULL] = ordem_indisponivel (incompleta)"    "$(campo "$CP" situacao)" "ordem_indisponivel"
eq "O6 flag=true vence topo único"                      "$(campo "$CM" situacao)" "referencia_ambigua"
eq "O7 flag NULA com ordem preenchida é fail-closed"    "$(campo "$CN" situacao)" "referencia_ambigua"

# ── identidade separada da eleição ──────────────────────────────────────────────
eq "O8 empate nomeia só o TOPO"                         "$(nprod "$CT")" "2"
eq "O9 candidatos conta o GRUPO, não o topo"            "$(campo "$CT" candidatos)" "3"
eq "O10 ordem_indisponivel nomeia o grupo INTEIRO"      "$(nprod "$CP")" "3"
eq "O11 eleito nomeia UM"                               "$(nprod "$CE")" "1"
eq "O12 produto_eleito é o do rank mínimo"              "$(campo "$CE" produto_eleito)" "$PROD"
eq "O13 produto_eleito não-nulo ⟺ eleito, na carteira inteira" \
   "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(
               public.farmer_melhores_individuais_por_cliente('$D')) j
              WHERE (j->>'produto_eleito' IS NOT NULL) <> (j->>'situacao'='eleito');")" "0"
eq "O14 produtos NUNCA é vazio ou nulo" \
   "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(
               public.farmer_melhores_individuais_por_cliente('$D')) j
              WHERE coalesce(jsonb_array_length(j->'produtos'),0) < 1;")" "0"
eq "O15 um objeto por (cliente,tipo) — 7 clientes, 7 objetos" \
   "$(Pq -c "SELECT jsonb_array_length(public.farmer_melhores_individuais_por_cliente('$D'));")" "7"
eq "O16 carteira vazia devolve [] e não NULL" \
   "$(Pq -c "SELECT public.farmer_melhores_individuais_por_cliente('$VAZIO')::text;")" "[]"

# ── o writer: as chaves novas ATRAVESSAM jsonb_to_recordset ─────────────────────
# Sem as listas de colunas atualizadas nos DOIS blocos, a chave é ignorada em
# SILÊNCIO — nada persiste e nada falha, que é o pior desfecho possível.
LOTE_ORDEM="[{\"customer_user_id\":\"$C1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD\",\"affinity_score\":0.5,\"ordem\":1,\"referencia_ambigua\":false},
             {\"customer_user_id\":\"$C1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$P2\",\"affinity_score\":0.5,\"ordem\":1,\"referencia_ambigua\":true}]"
RUNW="99999999-0000-4000-8000-000000000012"
# `$COMO_A` porque o writer é gateado por authz (FG-acesso): sem a identidade, o assert
# reprovaria por motivo ERRADO e a falsificação viraria teatro.
GERACAO_A=$(Pq -c "SELECT coalesce(quote_literal(run_id::text)||'::uuid','NULL')
                     FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$A';")
[ -n "$GERACAO_A" ] || GERACAO_A=NULL
P -q -c "$COMO_A SELECT public.farmer_recomendacoes_substituir('$A','$RUNW',$GERACAO_A,
           '$LOTE_ORDEM'::jsonb,'completa',NULL,NULL,NULL);" >/dev/null
eq "O17 o writer PERSISTE a ordem densa" \
   "$(Pq -c "SELECT string_agg(ordem::text,',' ORDER BY product_id) FROM public.farmer_recommendations
              WHERE run_id='$RUNW';")" "1,1"
eq "O18 o writer PERSISTE a flag, sem coalescer" \
   "$(Pq -c "SELECT string_agg(referencia_ambigua::text,',' ORDER BY product_id) FROM public.farmer_recommendations
              WHERE run_id='$RUNW';")" "false,true"

# ── negativos: a SQLSTATE ESPERADA, re-lançando o resto ─────────────────────────
neg_ordem() { # <json> <sqlstate> <rótulo>
  local saida
  local vista
  # A geração vigente é lida A CADA chamada: com a capturada lá em cima o lote morreria no
  # CAS — reprovaria pelo motivo ERRADO, sem nunca alcançar a validação sob teste.
  vista=$(Pq -c "SELECT coalesce(quote_literal(run_id::text)||'::uuid','NULL')
                   FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$A';")
  [ -n "$vista" ] || vista=NULL
  saida=$(P -tA -c "$COMO_A DO \$t\$ BEGIN
      PERFORM public.farmer_recomendacoes_substituir('$A','99999999-0000-4000-8000-0000000000ff',
                $vista,'$1'::jsonb,'completa',NULL,NULL,NULL);
      RAISE NOTICE 'NAO-RECUSOU';
    EXCEPTION WHEN SQLSTATE '$2' THEN RAISE NOTICE 'RECUSOU-COMO-ESPERADO';
    END \$t\$;" 2>&1 || true)
  case "$saida" in
    *RECUSOU-COMO-ESPERADO*) ok "$3" ;;
    *) bad "$3 — veio: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-170)" ;;
  esac
}
neg_ordem_valor() { # como neg_ordem, mas DEVOLVE o veredito em vez de contar assert
  local vista saida
  vista=$(Pq -c "SELECT coalesce(quote_literal(run_id::text)||'::uuid','NULL')
                   FROM public.farmer_geracao_vigente WHERE motor='cross_sell' AND farmer_id='$A';")
  [ -n "$vista" ] || vista=NULL
  saida=$(P -tA -c "$COMO_A DO \$t\$ BEGIN
      PERFORM public.farmer_recomendacoes_substituir('$A','99999999-0000-4000-8000-0000000000fe',
                $vista,'$1'::jsonb,'completa',NULL,NULL,NULL);
      RAISE NOTICE 'PASSOU';
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'RECUSOU:%', SQLSTATE;
    END \$t\$;" 2>&1 || true)
  case "$saida" in
    *PASSOU*)       echo "PASSOU" ;;
    *RECUSOU:FG007*) echo "RECUSOU" ;;
    *RECUSOU:*)     echo "RECUSOU-OUTRO-MOTIVO:$(printf '%s' "$saida" | sed -n 's/.*RECUSOU:\([A-Z0-9]*\).*/\1/p' | head -1)" ;;
    *)              echo "ERRO" ;;
  esac
  [ -n "${DEBUG_NEG:-}" ] && printf 'DEBUG_NEG[%s] vista=[%s] saida=[%s]\n' "$1" "$vista" "$(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-300)" >&2
}
LB="\"customer_user_id\":\"$C1\",\"recommendation_type\":\"cross_sell\",\"product_id\":\"$PROD\",\"affinity_score\":0.5"
neg_ordem "[{$LB,\"ordem\":0}]"                       FG007 "O19 ordem 0 recusada (0 não é posição)"
neg_ordem "[{$LB,\"ordem\":-1}]"                      FG007 "O20 ordem negativa recusada"
neg_ordem "[{$LB,\"referencia_ambigua\":\"talvez\"}]" FG007 "O21 flag não-booleana recusada por TIPO, antes do cast"
eq "O22 lote recusado NÃO expirou a geração vigente" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='$RUNW' AND status='pendente';")" "2"

# ── a fronteira ────────────────────────────────────────────────────────────────
# A RLS não é provada aqui (este harness não carrega a policy `frec_select_carteira`,
# e provar contra uma policy stub provaria o stub). O que se prova é a afirmação do
# DESENHO: a RPC não bypassa RLS — se virasse DEFINER, leria como owner.
eq "O23 a RPC é SECURITY INVOKER (não bypassa RLS)" \
   "$(Pq -c "SELECT prosecdef FROM pg_proc WHERE oid='public.farmer_melhores_individuais_por_cliente(uuid)'::regprocedure;")" "f"
eq "O24 anon NÃO executa a RPC nova" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.farmer_melhores_individuais_por_cliente(uuid)','EXECUTE');")" "f"
eq "O25 authenticated executa" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.farmer_melhores_individuais_por_cliente(uuid)','EXECUTE');")" "t"


# ── achados da rodada 4 do challenge ───────────────────────────────────────────
CG="cccccccc-0000-4000-8000-0000000000c2"   # duas gerações pendentes no mesmo grupo
P -q <<SQL
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('$CG','$D');
INSERT INTO public.farmer_recommendations
  (farmer_id, customer_user_id, recommendation_type, product_id, affinity_score,
   status, run_id, ordem, referencia_ambigua)
VALUES
  ('$D','$CG','cross_sell','$PROD',0.1,'pendente','$RUND',1,false),
  ('$D','$CG','cross_sell','$P2'  ,0.1,'pendente','99999999-0000-4000-8000-0000000000dd',2,false);
SQL
# Rank de G1 contra rank de G2 são universos diferentes: `ordem 1` não venceu de ninguém.
eq "O26 geração MISTURADA no grupo não elege"      "$(campo "$CG" situacao)" "ordem_indisponivel"
eq "O27 grupo incoerente não transporta run_id"    "$(campo "$CG" run_id)"   ""
eq "O28 grupo coerente TRANSPORTA o run_id"        "$(campo "$CE" run_id)"   "$RUND"

# O cast NÃO recusa representação textual — `boolean_in` aceita "false"/"off"/"0" e `int2in`
# aceita "3". Sem a checagem de jsonb_typeof, um produtor defeituoso gravaria uma NEGATIVA
# explícita de ambiguidade, e o teste com "talvez" ficaria verde sem provar nada.
neg_ordem "[{$LB,\"referencia_ambigua\":\"false\"}]" FG007 "O29 flag \"false\" (string) é RECUSADA, não convertida"
neg_ordem "[{$LB,\"referencia_ambigua\":0}]"         FG007 "O30 flag 0 é RECUSADA, não convertida"
neg_ordem "[{$LB,\"ordem\":\"2\"}]"                  FG007 "O31 ordem \"2\" (string) é RECUSADA"
# E o controle do outro lado: o tipo CERTO continua passando (a checagem não fecha demais).
eq "O32 ordem numérica e flag booleana continuam aceitas" \
   "$(Pq -c "SELECT count(*) FROM public.farmer_recommendations WHERE run_id='$RUNW';")" "2"

# RLS: `prosecdef` diz que a RPC não bypassa; falta que ela LEIA de verdade sob a identidade.
# Sem o assert positivo, uma resposta sempre-vazia aprovaria o negativo (achado do challenge).
eq "O33 sob a identidade do DONO a carteira volta NÃO-vazia" \
   "$(Pq -c "SET test.uid='$D'; SET test.role='authenticated';
             SELECT jsonb_array_length(public.farmer_melhores_individuais_por_cliente('$D'));" | tail -1)" "8"


# ── O SENSOR DA DISTRIBUIÇÃO (§6.1) ────────────────────────────────────────────
# A distribuicao por situacao nao e derivavel do banco ANTES da entrega: D3 muda quais SKUs
# sao persistidos, entao "empate entre os persistidos" nao demonstra ausencia de vencedor
# entre os candidatos. Ela e MEDIDA no writer, sobre o que acabou de ser gravado.
#
# O writer do assert O17 gravou 2 linhas para $C1 com ordem 1,1 e uma delas com a flag ligada
# — o grupo cai em `referencia_ambigua`, que e o estado de maior precedencia.
eq "O34 o sensor grava a eleicao com DENOMINADOR" \
   "$(Pq -c "SELECT (insumos->'individuais_eleicao'->>'n') || '/' ||
                    (insumos->'individuais_eleicao'->>'esperado')
             FROM public._insumos_vistos WHERE run_id='$RUNW';")" "0/1"
eq "O35 a distribuicao nomeia TIPO e SITUACAO" \
   "$(Pq -c "SELECT insumos->'individuais_eleicao'->'distribuicao'->>'cross_sell:referencia_ambigua'
             FROM public._insumos_vistos WHERE run_id='$RUNW';")" "1"
# Inerte por construcao: `ok:true` e sem piso. Uma evidencia que DEGRADA o head travaria a
# fase 2 para sempre, porque `degradado` nunca autoriza expirar (money-path §13).
eq "O36 o sensor e INERTE — mede sem julgar" \
   "$(Pq -c "SELECT (insumos->'individuais_eleicao'->>'ok') || ':' ||
                    coalesce(insumos->'individuais_eleicao'->>'pisoCobertura','sem-piso')
             FROM public._insumos_vistos WHERE run_id='$RUNW';")" "true:sem-piso"

# ═══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO DA ORDEM — uma camada por vez
#
# ⚠️ LINHA DE BASE NA MESMA INVOCAÇÃO. Uma suíte sempre-vermelha aprova TODA
# sabotagem, e rodar o controle noutra execução não prova nada sobre esta. Os
# valores íntegros são re-lidos aqui e conferidos ANTES do primeiro `sed`; se
# algum divergir, aborta em vez de "falsificar".
# ═══════════════════════════════════════════════════════════════════════════════
echo "─── falsificação: a ordem ───"

BASE_OK=1
base_confere() { # $1=rótulo $2=obtido $3=esperado
  if [ "$2" = "$3" ]; then ok "base íntegra: $1 (=$2)"; else BASE_OK=0; bad "BASE JÁ VERMELHA em $1 — esperado [$3], veio [$2]; falsificar aqui seria teatro"; fi
}
base_confere "O6 ambígua"      "$(campo "$CM" situacao)" "referencia_ambigua"
base_confere "O7 flag nula"    "$(campo "$CN" situacao)" "referencia_ambigua"
base_confere "O26 mistura"     "$(campo "$CG" situacao)" "ordem_indisponivel"
base_confere "O8 topo"         "$(nprod "$CT")"          "2"
base_confere "O3 singleton"    "$(campo "$CU" situacao)" "unico_registrado"

if [ "$BASE_OK" -ne 1 ]; then
  bad "falsificação ABORTADA: a linha de base não está verde nesta invocação"
else
  SABO="$(mktemp /tmp/sabota-ordem.XXXXXX)"
  restaura_ordem() { P -q -f "$MIG_ORDEM" >/dev/null 2>&1; }
  sabota_ordem() { # $1=rótulo  $2=expressão sed  $3=marca obrigatória no sabotado
    sed "$2" "$MIG_ORDEM" > "$SABO"
    if ! command grep -q "$3" "$SABO"; then
      bad "SABOTAGEM '$1' NÃO casou o padrão — o assert abaixo seria teatro"
      return 1
    fi
    if ! P -q -f "$SABO" >/dev/null 2>&1; then
      bad "SABOTAGEM '$1' casou o padrão mas NÃO APLICOU — o assert abaixo seria teatro"
      return 1
    fi
    return 0
  }
  vermelho() { # $1=rótulo $2=obtido $3=o valor ÍNTEGRO, que NÃO pode sobreviver
    if [ "$2" = "$3" ]; then bad "FALSIFICAÇÃO SEM DENTE: $1 continuou [$2] com a migration sabotada"
    else ok "mordeu: $1 virou [$2] (íntegro: [$3])"; fi
  }

  # F1 — o fail-closed da flag nula vira fail-OPEN.
  if sabota_ordem "flag nula fail-open" \
       's/coalesce(b\.referencia_ambigua, b\.ordem IS NOT NULL)/coalesce(b.referencia_ambigua, false)/' \
       'coalesce(b.referencia_ambigua, false)'; then
    vermelho "F1 flag NULA com ordem" "$(campo "$CN" situacao)" "referencia_ambigua"
  fi
  restaura_ordem

  # F2 — a precedência deixa de barrar geração misturada.
  if sabota_ordem "mistura ignorada" \
       's/WHEN g\.geracoes > 1/WHEN false/' 'WHEN false'; then
    vermelho "F2 geração misturada" "$(campo "$CG" situacao)" "ordem_indisponivel"
  fi
  restaura_ordem

  # F3 — `produtos` deixa de recortar o topo e nomeia o grupo inteiro no empate.
  # O padrão seguiu a reescrita que tirou o quadrático (achado R5/1): `produtos` deixou de sair
  # de subquery correlacionada e passa a escolher entre dois arrays montados uma vez só. O guard
  # de "não casou o padrão" pegou a defasagem — sem ele este assert teria virado teatro.
  if sabota_ordem "produtos sem recorte de topo" \
       "s/CASE WHEN f\.situacao IN ('eleito', 'empatado') THEN f\.topo_ids ELSE f\.todos_ids END/f.todos_ids/" \
       'f.todos_ids$'; then
    vermelho "F3 empate nomeia só o topo" "$(nprod "$CT")" "2"
  fi
  restaura_ordem

  # F4 — a precedência do singleton some, e ele passa a ser eleito por "topo único".
  if sabota_ordem "singleton sem precedência" \
       's/WHEN g\.candidatos = 1  *THEN/WHEN false THEN/' 'WHEN false THEN'; then
    vermelho "F4 singleton COM ordem" "$(campo "$CS" situacao)" "unico_registrado"
  fi
  restaura_ordem

  # F5 — a validação de ordem < 1 vira decoração.
  if sabota_ordem "ordem < 1 desligada" \
       's/AND r\.ordem < 1)/AND r.ordem < -32000)/' 'AND r.ordem < -32000)'; then
    # ⚠️ o JSON sai para uma variável ANTES da chamada: dentro de `$( )` o bash faz BRACE
    # EXPANSION em `{a,b}` e parte o payload em duas palavras — a função recebia `["ordem":0]`
    # e o erro virava 22P02, um vermelho pelo motivo ERRADO.
    J5="[{$LB,\"ordem\":0}]"
    vermelho "F5 ordem 0 recusada" "$(neg_ordem_valor "$J5")" "RECUSOU"
  fi
  restaura_ordem

  # F6 — a checagem de TIPO JSON some. Este é o que prova o achado: sem ela o cast
  # CONVERTE "false" em false e grava uma negativa explícita de ambiguidade.
  if sabota_ordem "tipo JSON não checado" \
       's/IF v_tipo_errado > 0 THEN/IF v_tipo_errado > 999999 THEN/' 'v_tipo_errado > 999999'; then
    J6="[{$LB,\"referencia_ambigua\":\"false\"}]"
    vermelho "F6 flag \"false\" recusada" "$(neg_ordem_valor "$J6")" "RECUSOU"
  fi
  restaura_ordem

  rm -f "$SABO"
  # E o CONTROLE de saída: restaurada, a base volta a ficar verde na MESMA invocação.
  eq "F7 restaurada, a migration volta a barrar a geração misturada" "$(campo "$CG" situacao)" "ordem_indisponivel"
  eq "F8 restaurada, o fail-closed da flag volta"                    "$(campo "$CN" situacao)" "referencia_ambigua"
fi

echo "─── falsificação ───"
P -q <<SQL
ALTER TABLE public.farmer_client_scores DISABLE ROW LEVEL SECURITY;
SQL
# Sabotagem cirúrgica: só o predicado do gate. `WHERE false` zera a contagem, então
# `v_fora_escopo` é sempre 0 e o RAISE nunca dispara — o gate vira decoração.
SABOTADO="$(mktemp /tmp/sabota-escopo.XXXXXX)"
sem_guard "$MIG" | sed 's/WHERE s\.farmer_id IS DISTINCT FROM p_farmer_id;/WHERE false;/' > "$SABOTADO"
if ! command grep -q "WHERE false;" "$SABOTADO"; then
  bad "falsificação NÃO aplicou a sabotagem (padrão não casou) — asserts abaixo seriam teatro"
else
  P -q -f "$SABOTADO"
  # A sentinela é a SQLSTATE 'FG009', que o código NÃO emite quando sabotado — e "SEM_ERRO"
  # é NOSSO texto, não do Postgres, então nenhum casamento acidental pinta verde.
  V1="$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "$(geracao_atual farmer_recommendations)")"
  V2="$(chamar farmer_bundle_recomendacoes_substituir "$(bundle "$C3")" "$(geracao_atual farmer_bundle_recommendations)")"
  # ⚠️ Exigir SEM_ERRO nos DOIS, não "qualquer coisa que não seja FG009". A versão anterior
  # testava `!= FG009` e caía no ramo verde também quando a RPC EXPLODIA — uma sabotagem que
  # quebrasse a função (coluna inexistente, erro de sintaxe) era lida como "o gate deixou passar".
  # Erro não é passagem: a falsificação só prova dente se o lote alheio for GRAVADO com sucesso.
  # (achado do Codex no fecho de 2026-09-06)
  if [ "$V1" = "SEM_ERRO" ] && [ "$V2" = "SEM_ERRO" ]; then
    ok "falsificação: gate zerado ⇒ o lote alheio PASSA (cross=[$V1] bundle=[$V2]) — os asserts têm dente"
  elif [ "$V1" = "FG009" ] || [ "$V2" = "FG009" ]; then
    bad "FALSIFICAÇÃO: com o gate zerado o lote alheio AINDA foi recusado — o assert não tem dente (cross=[$V1] bundle=[$V2])"
  else
    bad "FALSIFICAÇÃO INCONCLUSIVA: a sabotagem quebrou a RPC em vez de abrir o gate — nada foi provado (cross=[$V1] bundle=[$V2])"
  fi
  # Restaura a versão verdadeira e reconfirma, para o harness não terminar com o corpo furado.
  # Sem o guard: o corpo vivo está sabotado, e o guard — corretamente — recusaria reescrevê-lo.
  P -q -f <(sem_guard "$MIG")
  eq "restaurado: o gate volta a morder" "$(chamar farmer_recomendacoes_substituir "$(linha "$C3")" "$(geracao_atual farmer_recommendations)")" "FG009"
fi
rm -f "$SABOTADO"

echo
echo "═══ $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1

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
SLUG="melhor-individual-bulk"   # nomeia tmp/log deste harness
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
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════

# A migration só CRIA a função; tudo que ela LÊ tem de existir aqui. Stub mínimo e FIEL ao
# que a PROD tem (colunas conferidas por psql-ro em 20/08/2026), incluindo a policy REAL de
# SELECT — sem ela o assert de INVOKER não teria o que provar.
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS public.farmer_recommendations (
  id                  uuid PRIMARY KEY,
  farmer_id           uuid NOT NULL,
  customer_user_id    uuid NOT NULL,
  recommendation_type text NOT NULL,
  product_id          uuid,
  status              text,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz,
  affinity_score      numeric,
  run_id              uuid
);

-- Índice parcial idêntico ao de prod (idx_frec_farmer_status_pendente): o plano do DISTINCT ON
-- em prod é Incremental Sort sobre ele, e testar sem o índice testaria outro plano.
CREATE INDEX IF NOT EXISTS idx_frec_farmer_status_pendente
  ON public.farmer_recommendations (farmer_id, customer_user_id) WHERE (status = 'pendente');

-- Os dois ramos de capacidade da policy real. Stubados em FALSE de propósito: o que este
-- harness prova é o ramo `farmer_id = auth.uid()`, e deixá-los verdadeiros abriria tudo para
-- todo mundo — o assert de vazamento passaria por vacuidade.
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(p_uid uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT false $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(p_customer uuid, p_uid uuid)
  RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT false $f$;

ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS frec_select_carteira ON public.farmer_recommendations;
-- VERBATIM da prod (pg_policy, 20/08/2026).
CREATE POLICY frec_select_carteira ON public.farmer_recommendations
  FOR SELECT USING (
    (SELECT private.cap_carteira_ler((SELECT auth.uid())))
    OR (farmer_id = (SELECT auth.uid()))
    OR private.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
  );
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
# As DUAS, na ordem: a 1a nunca foi aplicada em prod, mas o harness prova o caminho REAL do
# founder — se ele colar as duas, a 2a tem de substituir a 1a (DROP + CREATE, ACL reemitido).
MIG_V1="$REPO_ROOT/supabase/migrations/20260820124611_farmer_melhor_individual_bulk.sql"
MIG="$REPO_ROOT/supabase/migrations/20260820133119_farmer_melhor_individual_atomico.sql"
P -q -f "$MIG_V1"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
# Cada recomendação tem um `product_id` ÚNICO — é ele que identifica QUAL linha venceu o
# desempate. Com produtos repetidos, dois vencedores diferentes dariam a mesma resposta e o
# assert de paridade passaria por acidente.
FA='aaaa0000-0000-4000-8000-00000000000a'   # farmer sob teste
FB='bbbb0000-0000-4000-8000-00000000000b'   # o OUTRO farmer (prova de não-vazamento)
C1='cccc0001-0000-4000-8000-000000000001'   # 3 scores distintos  -> vence o maior
C2='cccc0002-0000-4000-8000-000000000002'   # empate de score     -> vence updated_at mais novo
C3='cccc0003-0000-4000-8000-000000000003'   # empate score+data   -> vence o id maior
C4='cccc0004-0000-4000-8000-000000000004'   # SÓ score NULL       -> AUSENTE (fail-closed #1800)
C5='cccc0005-0000-4000-8000-000000000005'   # SÓ status != pendente -> AUSENTE
C6='cccc0006-0000-4000-8000-000000000006'   # empate score, um updated_at NULL -> NULLS FIRST
C7='cccc0007-0000-4000-8000-000000000007'   # carteira do FB      -> não aparece p/ FA

P -q <<SQL
INSERT INTO public.farmer_recommendations
  (id, farmer_id, customer_user_id, recommendation_type, product_id, status, updated_at, affinity_score, run_id) VALUES
  -- C1: o maior score vence, e a linha de score NULL (a MAIS RECENTE) não pode vencer.
  ('11110001-0000-4000-8000-000000000001','$FA','$C1','cross_sell','9991aaaa-0000-4000-8000-000000000001','pendente','2026-01-01', 0.10,'abcd0000-0000-4000-8000-000000000001'),
  ('11110002-0000-4000-8000-000000000002','$FA','$C1','cross_sell','9992aaaa-0000-4000-8000-000000000002','pendente','2026-01-02', 0.90,'abcd0000-0000-4000-8000-000000000001'),
  ('11110003-0000-4000-8000-000000000003','$FA','$C1','up_sell'  ,'9993aaaa-0000-4000-8000-000000000003','pendente','2026-01-03', 0.50,'abcd0000-0000-4000-8000-000000000001'),
  ('11110004-0000-4000-8000-000000000004','$FA','$C1','cross_sell','9994aaaa-0000-4000-8000-000000000004','pendente','2026-01-09', NULL,'abcd0000-0000-4000-8000-000000000001'),
  -- C2: MESMO score, datas diferentes.
  ('22220001-0000-4000-8000-000000000001','$FA','$C2','cross_sell','9995aaaa-0000-4000-8000-000000000005','pendente','2026-01-01', 0.70,'abcd0000-0000-4000-8000-000000000001'),
  ('22220002-0000-4000-8000-000000000002','$FA','$C2','cross_sell','9996aaaa-0000-4000-8000-000000000006','pendente','2026-06-01', 0.70,'abcd0000-0000-4000-8000-000000000001'),
  -- C3: MESMO score e MESMA data — só o id DESC decide. É o caso que created_at NÃO
  -- resolvia (a geração inteira é um INSERT só, now() é o instante da transação).
  ('33330001-0000-4000-8000-000000000001','$FA','$C3','cross_sell','9997aaaa-0000-4000-8000-000000000007','pendente','2026-03-03', 0.60,'abcd0000-0000-4000-8000-000000000001'),
  ('3333ffff-0000-4000-8000-00000000ffff','$FA','$C3','cross_sell','9998aaaa-0000-4000-8000-000000000008','pendente','2026-03-03', 0.60,'abcd0000-0000-4000-8000-000000000001'),
  -- C4: TODAS sem score. Sem o WHERE, ordenar por coluna toda-nula elege um vencedor ARBITRÁRIO.
  ('44440001-0000-4000-8000-000000000001','$FA','$C4','cross_sell','9999aaaa-0000-4000-8000-000000000009','pendente','2026-04-04', NULL,'abcd0000-0000-4000-8000-000000000001'),
  ('44440002-0000-4000-8000-000000000002','$FA','$C4','up_sell'  ,'999aaaaa-0000-4000-8000-00000000000a','pendente','2026-04-05', NULL,'abcd0000-0000-4000-8000-000000000001'),
  -- C5: score alto, mas já ofertada/aceita — não é candidata.
  ('55550001-0000-4000-8000-000000000001','$FA','$C5','cross_sell','999baaaa-0000-4000-8000-00000000000b','aceita'  ,'2026-05-05', 0.99,'abcd0000-0000-4000-8000-000000000001'),
  ('55550002-0000-4000-8000-000000000002','$FA','$C5','cross_sell','999caaaa-0000-4000-8000-00000000000c','expirada','2026-05-06', 0.98,'abcd0000-0000-4000-8000-000000000001'),
  -- C6: empate de score com um updated_at NULL. DESC sem NULLS explícito = NULLS FIRST no
  -- Postgres, e é isso que o postgrest-js emitia — o NULL VENCE. Herdado, não escolhido.
  ('66660001-0000-4000-8000-000000000001','$FA','$C6','cross_sell','999daaaa-0000-4000-8000-00000000000d','pendente','2026-06-06', 0.40,'abcd0000-0000-4000-8000-000000000001'),
  ('66660002-0000-4000-8000-000000000002','$FA','$C6','cross_sell','999eaaaa-0000-4000-8000-00000000000e','pendente', NULL      , 0.40,'abcd0000-0000-4000-8000-000000000001'),
  -- C7: carteira do OUTRO farmer.
  ('77770001-0000-4000-8000-000000000001','$FB','$C7','cross_sell','999faaaa-0000-4000-8000-00000000000f','pendente','2026-07-07', 0.95,'abcd0000-0000-4000-8000-000000000002');

GRANT SELECT ON public.farmer_recommendations TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON FUNCTION private.cap_carteira_ler(uuid), private.carteira_visivel_para(uuid,uuid) TO authenticated, anon;
SQL
echo "seed: 15 recomendações, 7 clientes, 2 farmers"

# ══════════════════════════════════════════════════════════════════════════════
# MEDIÇÕES (reusadas pelos asserts E pela falsificação — o assert falsificado tem de ser
# LITERALMENTE o mesmo, senão a sabotagem prova outra coisa)
# ══════════════════════════════════════════════════════════════════════════════
# A RPC devolve UMA tupla jsonb (um array de objetos). `jsonb_array_elements` reabre para os
# asserts sem mudar o que esta sob teste.
elems()     { echo "jsonb_array_elements(public.farmer_melhor_individual_por_cliente('$FA'))"; }
vencedor()  { Pq -c "SELECT coalesce(max(e->>'product_id'),'AUSENTE') FROM $(elems) e WHERE e->>'customer_user_id'='$1';"; }
linhas_de() { Pq -c "SELECT count(*) FROM $(elems) e WHERE e->>'customer_user_id'='$1';"; }
todos()     { Pq -c "SELECT count(*) FROM $(elems) e;"; }

# PARIDADE — o assert central: para CADA cliente, a linha que a RPC elege é a MESMA que a
# consulta por-cliente do PostgREST elegia. `CROSS JOIN LATERAL ... LIMIT 1` reproduz o
# `.limit(1)`, inclusive o "não veio linha nenhuma"; o FULL OUTER JOIN pega divergência de
# PRESENÇA (cliente que só um dos dois lados devolve), não só de conteúdo.
paridade() {
  Pq <<SQL
WITH clientes AS (
  SELECT DISTINCT customer_user_id AS cid FROM public.farmer_recommendations WHERE farmer_id='$FA'
), antiga AS (
  SELECT c.cid, r.product_id
  FROM clientes c
  CROSS JOIN LATERAL (
    SELECT r.product_id
    FROM public.farmer_recommendations r
    WHERE r.farmer_id='$FA' AND r.customer_user_id=c.cid
      AND r.status='pendente' AND r.affinity_score IS NOT NULL
    ORDER BY r.affinity_score DESC NULLS LAST, r.updated_at DESC, r.id DESC
    LIMIT 1
  ) r
), nova AS (
  SELECT (e->>'customer_user_id')::uuid AS cid, (e->>'product_id')::uuid AS product_id
  FROM jsonb_array_elements(public.farmer_melhor_individual_por_cliente('$FA')) e
)
SELECT count(*) FROM antiga a FULL OUTER JOIN nova n USING (cid)
WHERE a.cid IS NULL OR n.cid IS NULL OR a.product_id IS DISTINCT FROM n.product_id;
SQL
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

eq "P1 uma linha por cliente (DISTINCT ON)" "$(linhas_de "$C1")" "1"
eq "P2 elege o MAIOR affinity_score"        "$(vencedor "$C1")" "9992aaaa-0000-4000-8000-000000000002"
eq "P3 empate de score -> updated_at mais NOVO" "$(vencedor "$C2")" "9996aaaa-0000-4000-8000-000000000006"
eq "P4 empate score+data -> id DESC"        "$(vencedor "$C3")" "9998aaaa-0000-4000-8000-000000000008"
eq "P5 empate de score, updated_at NULL VENCE (NULLS FIRST herdado)" "$(vencedor "$C6")" "999eaaaa-0000-4000-8000-00000000000e"

eq "N1 cliente só com score NULL fica AUSENTE (fail-closed #1800)" "$(vencedor "$C4")" "AUSENTE"
eq "N2 status != pendente fica AUSENTE"     "$(vencedor "$C5")" "AUSENTE"
eq "N3 carteira do OUTRO farmer não vaza pelo filtro" "$(linhas_de "$C7")" "0"

eq "O1 um cliente aparece UMA vez no array" \
   "$(Pq -c "SELECT (count(*) = count(DISTINCT e->>'customer_user_id'))::text FROM $(elems) e;")" "true"
eq "O2 run_id vem no payload (canário de gerações entre os VENCEDORES — não invariante da tabela)" \
   "$(Pq -c "SELECT count(DISTINCT e->>'run_id') FROM $(elems) e;")" "1"

# ── ATOMICIDADE — o achado ALTO do challenge Codex ──────────────────────────────────────────
# A versão anterior era `RETURNS TABLE` + `fetchAllPages`: K requests, K snapshots. Uma
# substituição concorrente entre a página 0 e a 1 fazia a cauda virar `nenhum` — um VEREDICTO
# na tela — sem o canário de run_id notar. Uma tupla só torna isso impossível por construção.
eq "A1 a resposta INTEIRA é uma tupla jsonb (1 request = 1 snapshot MVCC)" \
   "$(Pq -c "SELECT jsonb_typeof(public.farmer_melhor_individual_por_cliente('$FA'));")" "array"
eq "A2 e traz TODOS os clientes de uma vez (sem cap de linhas para a cauda perder)" "$(todos)" "4"

# ── O par `[]` vs NULL — §6 do money-path: o contrato tem de EXPOR a falha ──────────────────
# Sem o `coalesce`, carteira vazia devolve NULL, e NULL é indistinguível de "a leitura falhou".
# O caller trata NULL como FALHA; se o SQL puder devolvê-lo por um caminho legítimo, o caller
# passa a gritar por um vazio honesto — e a defesa vira ruído que alguém desliga.
FVAZIO='eeee0000-0000-4000-8000-00000000000e'
eq "A3 carteira VAZIA devolve [] e nunca NULL (senão vazio e falha ficam iguais)" \
   "$(Pq -c "SELECT public.farmer_melhor_individual_por_cliente('$FVAZIO')::text;")" "[]"

eq "★ PARIDADE: divergências vs. o desempate que o PostgREST emitia" "$(paridade)" "0"

# ── RLS: `p_farmer_id` é FILTRO, não autorização. SECURITY INVOKER é o que garante isso. ──
# 4, não 6: dos 6 clientes de FA, C4 (só score NULL) e C5 (nada pendente) são filtrados —
# o próprio número é evidência de que N1/N2 valem também sob a RLS, não só como superuser.
eq "R1 o dono da carteira LÊ as suas (controle positivo — sem ele R2 passa por vacuidade)" \
   "$(Pq -c "SET test.uid='$FA'; SET ROLE authenticated; SELECT jsonb_array_length(public.farmer_melhor_individual_por_cliente('$FA'));" | tail -1)" "4"
eq "R2 OUTRO farmer pedindo a carteira alheia recebe ZERO (a RLS decide, não o parâmetro)" \
   "$(Pq -c "SET test.uid='$FB'; SET ROLE authenticated; SELECT jsonb_array_length(public.farmer_melhor_individual_por_cliente('$FA'));" | tail -1)" "0"

# ── R3 negativo com SQLSTATE + re-raise (Lei #2). Sentinela NÃO contém o texto do erro do
#    Postgres ("permission denied for function"), senão um match casaria a própria sentinela. ──
R3=$(P -tA 2>&1 <<SQL || true
SET ROLE anon;
DO \$\$
BEGIN
  PERFORM public.farmer_melhor_individual_por_cliente('$FA');
  RAISE NOTICE 'ZZANONEXECUTOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ZZANONBARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R3" in
  *ZZANONBARRADO*) ok "R3 anon sem EXECUTE é barrado com 42501 (REVOKE tem dente)" ;;
  *ZZANONEXECUTOU*) bad "R3 anon EXECUTOU a RPC — o REVOKE não pegou" ;;
  *) bad "R3 nem barrou nem executou — saída inesperada: $R3" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem tem de deixar VERMELHO o assert que ela mira) ──"
SAB_PASS=0; SAB_FAIL=0
# `red` inverte a expectativa: aqui VERMELHO é o resultado desejado.
red() { if [ "$2" != "$3" ]; then SAB_PASS=$((SAB_PASS+1)); echo "  🔴 $1 — assert caiu como devia (veio [$2], o verde era [$3])";
        else SAB_FAIL=$((SAB_FAIL+1)); echo "  ⚠️  $1 — SABOTADO E AINDA VERDE: o assert não tem dente"; fi; }

# $1 = corpo da subquery interna; $2 = SECURITY …; $3 (opcional) = agregação, p/ falsificar o coalesce
sabota() {
  P -q <<SQL
DROP FUNCTION IF EXISTS public.farmer_melhor_individual_por_cliente(uuid);
CREATE FUNCTION public.farmer_melhor_individual_por_cliente(p_farmer_id uuid)
RETURNS jsonb LANGUAGE sql STABLE $2 SET search_path TO 'public', pg_temp AS \$fn\$
  SELECT ${3:-coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.customer_user_id), '[]'::jsonb)}
  FROM (
$1
  ) m
\$fn\$;
GRANT EXECUTE ON FUNCTION public.farmer_melhor_individual_por_cliente(uuid) TO authenticated;
SQL
}
restaura() { P -q -f "$MIG"; }

SEL_BASE="    SELECT DISTINCT ON (r.customer_user_id) r.customer_user_id, r.product_id, r.affinity_score, r.recommendation_type, r.run_id
    FROM public.farmer_recommendations r
    WHERE r.farmer_id = p_farmer_id AND r.status = 'pendente'"

# F1 — tira o WHERE do score: o cliente que só tem NULL passa a ganhar um vencedor ARBITRÁRIO.
sabota "$SEL_BASE
  ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id DESC" "SECURITY INVOKER"
red "F1 sem 'affinity_score IS NOT NULL' -> N1" "$(vencedor "$C4")" "AUSENTE"
restaura

# F2 — tira o WHERE **e** o NULLS LAST. O NULLS LAST sozinho é inalcançável (o WHERE já filtra):
# é defesa em profundidade, e a única falsificação honesta dele é remover a primeira camada.
sabota "$SEL_BASE
  ORDER BY r.customer_user_id, r.affinity_score DESC, r.updated_at DESC NULLS FIRST, r.id DESC" "SECURITY INVOKER"
red "F2 sem WHERE e sem NULLS LAST -> P2 (a linha SEM score vence a de 0.90)" "$(vencedor "$C1")" "9992aaaa-0000-4000-8000-000000000002"
restaura

# F3 — inverte o desempate de data.
sabota "$SEL_BASE AND r.affinity_score IS NOT NULL
  ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at ASC, r.id DESC" "SECURITY INVOKER"
red "F3 updated_at ASC -> P3" "$(vencedor "$C2")" "9996aaaa-0000-4000-8000-000000000006"
restaura

# F4 — inverte o desempate final. `id ASC` em vez de remover: sem NENHUM desempate a escolha
# fica a critério do plano, e um teste que depende do plano é flaky, não é prova.
sabota "$SEL_BASE AND r.affinity_score IS NOT NULL
  ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id ASC" "SECURITY INVOKER"
red "F4 id ASC -> P4" "$(vencedor "$C3")" "9998aaaa-0000-4000-8000-000000000008"
restaura

# F5 — tira o filtro de status: oferta já aceita/expirada volta a ser "a melhor pendente".
sabota "    SELECT DISTINCT ON (r.customer_user_id) r.customer_user_id, r.product_id, r.affinity_score, r.recommendation_type, r.run_id
    FROM public.farmer_recommendations r
    WHERE r.farmer_id = p_farmer_id AND r.affinity_score IS NOT NULL
    ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id DESC" "SECURITY INVOKER"
red "F5 sem status='pendente' -> N2" "$(vencedor "$C5")" "AUSENTE"
restaura

# F6 — sem DISTINCT ON: volta a ser a lista inteira, e paginar sobre ela repete cliente.
sabota "    SELECT r.customer_user_id, r.product_id, r.affinity_score, r.recommendation_type, r.run_id
    FROM public.farmer_recommendations r
    WHERE r.farmer_id = p_farmer_id AND r.status = 'pendente' AND r.affinity_score IS NOT NULL
    ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id DESC" "SECURITY INVOKER"
red "F6 sem DISTINCT ON -> P1" "$(linhas_de "$C1")" "1"
restaura

# F7 — a que mais importa: DEFINER em vez de INVOKER. O owner aqui é superuser, então a RLS
# deixa de filtrar e `p_farmer_id` — um parâmetro escolhido pelo CALLER — vira autorização:
# qualquer authenticated lê a carteira de qualquer farmer.
sabota "$SEL_BASE AND r.affinity_score IS NOT NULL
  ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id DESC" "SECURITY DEFINER"
red "F7 SECURITY DEFINER -> R2 (a carteira alheia vaza)" \
    "$(Pq -c "SET test.uid='$FB'; SET ROLE authenticated; SELECT jsonb_array_length(public.farmer_melhor_individual_por_cliente('$FA'));" | tail -1)" "0"
restaura

# F8 — o assert de PARIDADE precisa de dente próprio: se ele só contasse linhas, qualquer
# sabotagem de ORDEM passaria. Sabota a data e exija que a PARIDADE (não o P3) caia.
sabota "$SEL_BASE AND r.affinity_score IS NOT NULL
  ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at ASC, r.id DESC" "SECURITY INVOKER"
red "F8 updated_at ASC -> ★PARIDADE" "$(paridade)" "0"
restaura

# F9 — o `coalesce` do §6: sem ele, carteira vazia devolve NULL, e NULL é o que o caller
# trata como FALHA. Vazio honesto passaria a gritar, e a defesa viraria ruído que alguém desliga.
sabota "$SEL_BASE AND r.affinity_score IS NOT NULL
    ORDER BY r.customer_user_id, r.affinity_score DESC NULLS LAST, r.updated_at DESC NULLS FIRST, r.id DESC" \
  "SECURITY INVOKER" "jsonb_agg(to_jsonb(m) ORDER BY m.customer_user_id)"
red "F9 sem o coalesce -> A3 (vazio vira NULL)" \
    "$(Pq -c "SELECT coalesce(public.farmer_melhor_individual_por_cliente('eeee0000-0000-4000-8000-00000000000e')::text,'NULO');")" "[]"
restaura

# CONTROLE DA RESTAURAÇÃO: se `restaura` não funcionasse, os vermelhos acima seriam do
# comando quebrado e não da sabotagem. Re-mede o assert central com a função verdadeira.
eq "Z1 restauração conferida — PARIDADE volta a zero com a migration real" "$(paridade)" "0"

echo "  sabotagens que derrubaram o assert: $SAB_PASS / falharam em derrubar: $SAB_FAIL"
[ "$SAB_FAIL" = "0" ] || FAIL=$((FAIL+1))

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

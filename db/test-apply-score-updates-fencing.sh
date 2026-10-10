#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════════
# PROVA — FENCING REAL do lease em apply_score_updates (a escrita passa a ser cercada)
# Migration: supabase/migrations/20261010120000_apply_score_updates_fencing_lease.sql
# Roda:  bash db/test-apply-score-updates-fencing.sh > /tmp/t.log 2>&1; echo "exit=$?"
#        (NUNCA `| tail` — o pipe engole o exit code, §2 do CLAUDE.md)
#
# O FURO (follow-up do #1578, achado do challenge /codex gpt-5.6-sol): o lease row-based protege o
# INÍCIO e a FINALIZAÇÃO, mas não a ESCRITA. Se o TTL expira e outro run assume, o run antigo — se
# ainda estiver vivo — grava o payload montado do snapshot DELE. O finalizar devolve false, mas é
# detecção TARDIA: a escrita já aconteceu.
#
# ── ZONA D — DEPLOY / ASSINATURA (o cuidado nº 2: a janela entre as publicações manuais) ──
#   D1  SOBRECARGA É FATAL: com apply_score_updates(jsonb) E (jsonb,text) vivas, a chamada de 1 arg
#       (a edge ANTIGA) dá 42725 'function is not unique'. É a PROVA de que o DROP+CREATE não é
#       preferência de estilo — CREATE OR REPLACE quebraria a edge no instante do apply.
#   D2  RETROCOMPAT: chamada SEM p_run_id escreve exatamente como hoje (a edge antiga não quebra).
#   D3  exatamente 1 sobrecarga após a migration (se virar 2, o DROP não pegou).
#   D4  GRANTS: anon/authenticated BARRADOS, service_role executa. Obrigatório aqui e não defesa de
#       DR: o DROP levou os grants junto, então a função nasce com EXECUTE p/ PUBLIC.
#
# ── ZONA P — POSITIVOS DO FENCING ──
#   P1  p_run_id = dono corrente do lease → escreve normalmente (o gate não estorva o caminho feliz).
#   P2  p_run_id NULL → escreve sem consultar o lease (retrocompat; e é o que torna a defesa INERTE
#       até a edge passar o parâmetro — declarado no PR).
#
# ── ZONA N — NEGATIVOS (SQLSTATE esperada + re-raise; nunca WHEN OTHERS THEN 'OK') ──
#   N1  run que PERDEU o lease (outro run_id) → 55000 e ZERO escrita.
#   N2  status='complete' (eu já finalizei) → 55000.
#   N3  p_run_id = '' → 22004. String vazia NÃO é "sem fencing" — seria bypass trivial do gate.
#   N4  p_run_id = '   ' (só espaços) → 22004 (o btrim cobre a variante).
#   N5  linha de lease AUSENTE → 55000 (fail-closed: sem lease não se escreve com token).
#
# ── ZONA H — HERDADOS, RE-EXERCIDOS SOB ESTA VERSÃO (lição #1515) ──
# A função é recriada INTEIRA: a cobertura das 6 migrations anteriores vale para as versões DELAS,
# não para a que vai a produção. VERSÃO COBERTA ≠ VERSÃO ENTREGUE. Um invariante que eu quebrasse na
# transcrição passaria verde em db/test-apply-score-updates{,-shs}.sh e db/test-farmer-cobertura-custo.sh,
# porque esses aplicam as migrations DELES. Aqui cada um é re-exercido contra a MINHA versão.
#   H1  guard das 12 chaves CORE (check_violation) + linha intocada.
#   H2  chave AUSENTE preserva o valor (jsonb_exists — a retrocompat da cobertura de custo).
#   H3  chave presente com null GRAVA NULL (sobrescreve o velho).
#   H4  anti-ressurreição #971: id deletado mid-run → retorno 0, NÃO re-insere.
#   H5  sales_history_status COALESCE (null preserva o valor velho).
#   H6  m_score / gross_margin_pct pelo mesmo jsonb_exists.
#
# ── ZONA C — CONCORRÊNCIA REAL (o coração: o perdedor TENTA e NÃO CONSEGUE) ──
# O harness do #1578 provava que o perdedor era PULADO no claim. Aqui o cenário é outro e é o que
# ficou aberto: o perdedor JÁ TINHA o lease, perdeu por TTL, e continua vivo.
#   C1  COM fencing: A claima → TTL expira → B assume e grava o novo → A (vivo) TENTA o apply com o
#       snapshot velho → 55000, dado fica com o valor de B. A TRILHA DE EVENTOS exige o par
#       'apply_tentado' + 'apply_barrado_55000': sem ela, o verde também sairia se A não tivesse
#       tentado nada — provaria "não rodou" em vez de "rodou e foi barrado".
#   C2  BASELINE DO BUG (mesma sequência, p_run_id NULL = o mundo de hoje): A RESTAURA margem e
#       cobertura velhas sobre o run saudável. É o par que prova que a corrida é real e que C1 tem
#       o que fechar.
#   C3  O `FOR SHARE` SERIALIZA DE VERDADE (duas sessões psql reais): enquanto A segura a transação
#       do chunk, o claim de B BLOQUEIA até o COMMIT de A. Ordem medida por sequence (determinística),
#       não por relógio. Sem isto a checagem de ownership seria decorativa: em READ COMMITTED o claim
#       rival commitaria ENTRE o IF e o UPDATE e a escrita velha passaria assim mesmo.
#       O lease de A está EXPIRADO: o claim de B é tomada legítima e B termina dono. O bloqueio é
#       OBSERVADO em `pg_blocking_pids` antes de liberar A — nenhum pg_sleep decide a corrida.
#   C4  O sentido INVERSO (EPQ): B toma o lease e segura a transação; o apply de A ESPERA e, no
#       COMMIT de B, o READ COMMITTED reavalia o predicado na versão nova → 55000 sem escrita.
#
# ── ZONA F — FALSIFICAÇÃO (baseline verde antes + contagem de vermelhos conferida) ──
#   F1  remove o bloco de fencing → N1 tem de virar ESCRITA (o run alheio grava). Prova o dente de N1.
#   F2  troca `FOR SHARE` por SELECT simples → C3 deixa de bloquear E C4 deixa A escrever.
#       Prova que quem faz o fencing é o LOCK, não o IF. É a sabotagem que mais importa: sem ela eu
#       teria "o assert passa" sem saber se passa pelo motivo certo (lição #1549: enumere os
#       mecanismos que sustentam o invariante antes de escrever a falsificação).
#   F3  trata '' como NULL (o bypass) → N3 tem de virar ESCRITA. Prova o dente de N3.
# Cada sabotagem PROVA QUE APLICOU (confere o corpo em pg_get_functiondef) antes de medir — sem
# isso, "não casou nada" se lê como "o assert não tem dente" (lição do money-path.md).
#
# Nota: todos os ids são literais dentro do SQL (nada de interpolação do shell), então os heredocs
# ficam <<'SQL' aspados e o $$ do plpgsql não vira o PID do bash.
# ════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5491}"
SLUG="apply-score-updates-fencing"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "${C3TMP:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# Ps = setup: executa e DESCARTA a saída. `-q` suprime a tag de comando, não o resultado do SELECT —
# um `SELECT public.reseed()` continua imprimindo a tabelinha. Dentro de `$(...)` isso ENTRA na
# captura e o assert passa a medir o ruído em vez da propriedade (foi o que quebrou C3/F2 na 1ª
# rodada: o veredito real era 't', mas vinha grudado em " reseed |---|(1 row)"). Toda linha de
# preparo usa Ps; só o SELECT do veredito usa Pq.
Ps() { P -q "$@" >/dev/null; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (espelham a PROD, conferidos por psql-ro 2026-07-23)
# ════════════════════════════════════════════════════════════════════════════════════════════════
# sync_state com os DOIS unique indexes redundantes que a prod tem (idx_sync_state_entity_account e
# sync_state_entity_account_uq) e NENHUMA constraint em pg_constraint — olhar só um dos dois
# esconderia metade das chaves (armadilha do CLAUDE.md). O ON CONFLICT por colunas casa com qualquer
# um dos dois; o stub reproduz o mundo real, não o desenho.
P -q <<'SQL'
CREATE TABLE public.sync_state (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  entity_type text NOT NULL,
  account text DEFAULT 'vendas'::text NOT NULL,
  last_sync_at timestamptz,
  last_page integer DEFAULT 0,
  last_cursor text,
  total_synced integer DEFAULT 0,
  status text DEFAULT 'idle'::text,
  error_message text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX idx_sync_state_entity_account ON public.sync_state (entity_type, account);
CREATE UNIQUE INDEX sync_state_entity_account_uq  ON public.sync_state (entity_type, account);

CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0,
  m_score numeric,
  g_score numeric DEFAULT 0,
  x_score numeric DEFAULT 0,
  s_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0,
  health_class text DEFAULT 'critico',
  churn_risk numeric DEFAULT 0,
  recover_score numeric DEFAULT 0,
  expansion_score numeric DEFAULT 0,
  eff_score numeric DEFAULT 0,
  priority_score numeric DEFAULT 0,
  days_since_last_purchase integer DEFAULT 0,
  avg_repurchase_interval numeric DEFAULT 0,
  avg_monthly_spend_180d numeric DEFAULT 0,
  gross_margin_pct numeric,
  category_count integer DEFAULT 0,
  answer_rate_60d numeric DEFAULT 0,
  whatsapp_reply_rate_60d numeric DEFAULT 0,
  revenue_potential numeric DEFAULT 0,
  calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  last_signal_recalc_at timestamptz,
  sales_history_status text,
  itens_com_custo bigint,
  itens_sem_custo bigint,
  CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id)
);
-- grants como em prod (service_role tem arwdDxtm em sync_state; o `w` é o que FOR SHARE exige)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sync_state          TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_client_scores TO service_role;

-- trilha de eventos da ZONA C (sequence é não-transacional → ordem sobrevive a rollback)
CREATE TABLE public.trilha (seq bigserial PRIMARY KEY, run text, evento text);
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ════════════════════════════════════════════════════════════════════════════════════════════════
# A migration do lease (20260728120001, PR #1578) NÃO é aplicada aqui de propósito: o contrato desta
# RPC é com a LINHA de sync_state, não com a função claim_calculate_scores. O harness monta a linha
# direto (é o efeito do claim) e transcreve o statement do claim só onde precisa de um rival REAL
# (C3). A prova do claim em si é db/test-calculate-scores-lease.sh, no #1578.
MIG="$REPO_ROOT/supabase/migrations/20261010120000_apply_score_updates_fencing_lease.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS + helpers
# ════════════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- payload CORE (as 12 chaves obrigatórias) numa função, p/ não repetir 12 chaves em cada assert.
CREATE FUNCTION public.core_payload() RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object(
    'id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,
    'rf_score',90,'g_score',70,'days_since_last_purchase',7,'avg_monthly_spend_180d',2500,
    'category_count',4,'calculated_at','2026-07-30T12:00:00Z','updated_at','2026-07-30T12:00:00Z')
$f$;

-- reseed: volta a linha ao estado VELHO distinguível (gm=99, itens 77/88, recência 42)
CREATE FUNCTION public.reseed() RETURNS void LANGUAGE sql AS $f$
  DELETE FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  INSERT INTO public.farmer_client_scores
    (id, customer_user_id, farmer_id, health_score, days_since_last_purchase,
     avg_monthly_spend_180d, category_count, gross_margin_pct, m_score,
     itens_com_custo, itens_sem_custo, sales_history_status)
  VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b0000000-0000-4000-8000-000000000002',
          'f0000000-0000-4000-8000-000000000003', 10, 42, 111, 9, 99, 66, 77, 88, 'ok_velho');
$f$;

-- põe o lease num estado arbitrário (modela o EFEITO do claim, sem depender da migration do #1578)
CREATE FUNCTION public.set_lease(p_run text, p_status text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('calculate_scores','global', p_status, now(), 0,
          jsonb_build_object('run_id', p_run, 'fase','inicio'), now())
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status = p_status, last_sync_at = now(),
        metadata = jsonb_build_object('run_id', p_run, 'fase','inicio'), updated_at = now();
$f$;
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA D — DEPLOY / ASSINATURA
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- ZONA D: assinatura e ordem de deploy --"

eq "D3 exatamente 1 sobrecarga de apply_score_updates" \
   "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='apply_score_updates';")" "1"
eq "D3b assinatura NOVA (jsonb,text) existe" \
   "$(Pq -c "SELECT to_regprocedure('public.apply_score_updates(jsonb, text)') IS NOT NULL;")" "t"
eq "D3c assinatura ANTIGA (jsonb) sumiu"     \
   "$(Pq -c "SELECT to_regprocedure('public.apply_score_updates(jsonb)') IS NULL;")" "t"

# D2 — RETROCOMPAT: a edge ANTIGA chama com 1 argumento posicional. Tem de funcionar igual.
Ps -c "SELECT public.reseed();"
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() || jsonb_build_object('gross_margin_pct', 53)));")
eq "D2a chamada de 1 arg (edge ANTIGA) funciona"  "$R" "1"
eq "D2b e escreveu de fato (gm 99 -> 53)" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "53"

# D1 — SOBRECARGA É FATAL. Recrio a assinatura antiga ao lado da nova e exijo 42725 na chamada de 1
# arg. É a prova de que CREATE OR REPLACE (que deixaria as duas vivas) quebraria a edge antiga no
# instante do apply — a janela que a migration se esforça para manter segura.
P -q <<'SQL'
CREATE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql AS $fn$ BEGIN RETURN 0; END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb);
  RAISE NOTICE 'SOBRECARGA_RESOLVEU';
EXCEPTION
  WHEN ambiguous_function THEN RAISE NOTICE 'SOBRECARGA_AMBIGUA_42725';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
case "$R" in
  *SOBRECARGA_AMBIGUA_42725*) ok "D1 duas assinaturas vivas => chamada de 1 arg da 42725 (o DROP e obrigatorio)";;
  *) bad "D1 — esperava 42725 com as 2 assinaturas, veio: $R";;
esac
P -q -c "DROP FUNCTION public.apply_score_updates(jsonb);"   # restaura o mundo da migration
eq "D1b restaurado: 1 sobrecarga" "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='apply_score_updates';")" "1"

# D4 — GRANTS. Obrigatório aqui: o DROP levou os grants, a função nasce com EXECUTE p/ PUBLIC.
for ROLE in anon authenticated; do
  R=$(P -tA 2>&1 <<SQL
SET ROLE $ROLE;
DO \$\$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb, NULL);
  RAISE NOTICE 'EXEC_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'EXEC_BARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
  ) || true
  case "$R" in
    *EXEC_BARRADO*) ok "D4 $ROLE BARRADO (insufficient_privilege)";;
    *) bad "D4 $ROLE — esperava barrado, veio: $R";;
  esac
done
R=$(P -tAq -c "SET ROLE service_role; SELECT public.apply_score_updates('[]'::jsonb, NULL);" 2>&1) || true
eq "D4 service_role EXECUTA (lista vazia -> 0)" "$R" "0"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA P — POSITIVOS DO FENCING
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- ZONA P: o gate nao estorva o caminho feliz --"

Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('gross_margin_pct', 53, 'itens_com_custo', 3, 'itens_sem_custo', 37)), 'run-A');")
eq "P1a dono corrente escreve (retorno 1)" "$R" "1"
eq "P1b gross_margin_pct 99 -> 53" "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "53"
eq "P1c itens_com_custo 77 -> 3"   "$(Pq -c "SELECT itens_com_custo  FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "3"

Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-OUTRO','syncing');"
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('gross_margin_pct', 53)), NULL);")
eq "P2a p_run_id NULL escreve mesmo com lease de OUTRO run (sem fencing = hoje)" "$R" "1"
eq "P2b gm virou 53 (a defesa e INERTE ate a edge passar o parametro)" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "53"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA N — NEGATIVOS (SQLSTATE esperada + re-raise)
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- ZONA N: a defesa morde --"

# helper: roda o apply com p_run_id e devolve a sentinela do desfecho. A sentinela NUNCA contém o
# texto que a função emite (anti-teatro): 'BARRADO_55000' / 'BARRADO_22004' / 'NAO_BARROU'.
neg() { # $1 = expressão SQL para p_run_id, $2 = sqlstate esperada, $3 = rótulo
  local SENT
  SENT=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  PERFORM public.apply_score_updates(jsonb_build_array(
    public.core_payload() || jsonb_build_object('gross_margin_pct', 53, 'itens_com_custo', 3, 'itens_sem_custo', 37)), $1);
  RAISE NOTICE 'NAO_BARROU';
EXCEPTION
  WHEN SQLSTATE '$2' THEN RAISE NOTICE 'BARRADO_$2';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
  ) || true
  case "$SENT" in
    *"BARRADO_$2"*) ok "$3 (SQLSTATE $2)";;
    *) bad "$3 — esperava SQLSTATE $2, veio: $SENT";;
  esac
}

Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-B','syncing');"
neg "'run-A'" "55000" "N1a run que PERDEU o lease e recusado"
eq  "N1b ZERO escrita: gm continua 99"           "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"
eq  "N1c ZERO escrita: itens_com_custo continua 77" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "77"
eq  "N1d ZERO escrita: recencia continua 42"     "$(Pq -c "SELECT days_since_last_purchase FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "42"

Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','complete');"
neg "'run-A'" "55000" "N2a status='complete' (eu ja finalizei) e recusado"
eq  "N2b ZERO escrita: gm continua 99" "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"

Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
neg "''"    "22004" "N3a p_run_id='' e 22004, NAO bypass do gate"
eq  "N3b ZERO escrita: gm continua 99" "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"
neg "'   '" "22004" "N4a p_run_id so-espacos e 22004 (btrim)"

Ps -c "SELECT public.reseed(); DELETE FROM public.sync_state WHERE entity_type='calculate_scores';"
neg "'run-A'" "55000" "N5a lease AUSENTE => recusa (fail-closed)"
eq  "N5b ZERO escrita: gm continua 99" "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA H — HERDADOS, RE-EXERCIDOS SOB ESTA VERSÃO (lição #1515)
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- ZONA H: invariantes herdados, medidos na versao que VAI A PRODUCAO --"

# H1 — guard das 12 chaves CORE
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  PERFORM public.apply_score_updates(jsonb_build_array(
    (public.core_payload() - 'health_score') || jsonb_build_object('itens_com_custo', 5)), 'run-A');
  RAISE NOTICE 'GUARD_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'GUARD_BARROU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
case "$R" in *GUARD_BARROU*) ok "H1a payload sem health_score REJEITADO (check_violation)";; *) bad "H1a — esperava check_violation, veio: $R";; esac
eq "H1b linha INTOCADA (itens_com_custo segue 77)" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "77"

# H2 — chave AUSENTE preserva (jsonb_exists)
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload()), 'run-A');" >/dev/null
eq "H2a itens_com_custo PRESERVADO em 77 (chave ausente)" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "77"
eq "H2b itens_sem_custo PRESERVADO em 88"                 "$(Pq -c "SELECT itens_sem_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "88"
eq "H6a gross_margin_pct PRESERVADO em 99 (chave ausente)" "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"
eq "H6b m_score PRESERVADO em 66 (chave ausente)"          "$(Pq -c "SELECT m_score FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "66"

# H3 — chave presente com null GRAVA NULL
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() ||
  jsonb_build_object('itens_com_custo', null, 'gross_margin_pct', null, 'm_score', null)), 'run-A');" >/dev/null
eq "H3a itens_com_custo virou NULL (era 77)"  "$(Pq -c "SELECT itens_com_custo  IS NULL FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "t"
eq "H3b gross_margin_pct virou NULL (era 99)" "$(Pq -c "SELECT gross_margin_pct IS NULL FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "t"
eq "H3c m_score virou NULL (era 66)"          "$(Pq -c "SELECT m_score          IS NULL FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "t"

# H4 — anti-ressurreição #971
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');
         DELETE FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';"
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload()), 'run-A');")
eq "H4a id deletado mid-run: retorno 0"            "$R" "0"
eq "H4b NAO ressuscitou a linha (UPDATE-only)"     "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "0"

# H5 — sales_history_status COALESCE
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload()), 'run-A');" >/dev/null
eq "H5a sales_history_status PRESERVADO (COALESCE, chave ausente)" "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "ok_velho"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() ||
  jsonb_build_object('sales_history_status','ok_novo')), 'run-A');" >/dev/null
eq "H5b sales_history_status ATUALIZADO quando presente" "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "ok_novo"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA C — CONCORRÊNCIA REAL
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- ZONA C: o perdedor TENTA escrever e NAO CONSEGUE --"

# `corrida(p_com_fencing)` modela a sequência EXATA do furo, com trilha de eventos:
#   1. A claima e LÊ o snapshot velho (gm=99, itens 77/88)
#   2. o TTL de A expira (backdate) e B ASSUME legitimamente
#   3. B grava o valor novo (gm=53, itens 3/37)
#   4. A — AINDA VIVO — tenta o apply com o payload do snapshot velho
# A trilha registra 'apply_tentado' ANTES da chamada: sem ela, o assert do dado ficaria verde também
# se A não tivesse tentado nada — provaria "nao rodou" em vez de "rodou e foi barrado".
P -q <<'SQL'
CREATE FUNCTION public.corrida(p_com_fencing boolean) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_snap_gm numeric; v_snap_com bigint; v_snap_sem bigint;
BEGIN
  DELETE FROM public.trilha;
  PERFORM public.reseed();

  -- 1. A claima e lê o snapshot
  PERFORM public.set_lease('run-A','syncing');
  INSERT INTO public.trilha(run,evento) VALUES ('A','claim_ok');
  SELECT gross_margin_pct, itens_com_custo, itens_sem_custo
    INTO v_snap_gm, v_snap_com, v_snap_sem
    FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  INSERT INTO public.trilha(run,evento) VALUES ('A','snapshot');

  -- 2. TTL de A expira; B assume (o claim real reivindica porque last_sync_at ficou velho)
  UPDATE public.sync_state SET last_sync_at = now() - interval '20 minutes'
   WHERE entity_type='calculate_scores' AND account='global';
  PERFORM public.set_lease('run-B','syncing');
  INSERT INTO public.trilha(run,evento) VALUES ('B','claim_ok_apos_ttl');

  -- 3. B grava o valor NOVO (run saudável)
  PERFORM public.apply_score_updates(jsonb_build_array(public.core_payload() ||
    jsonb_build_object('gross_margin_pct', 53, 'itens_com_custo', 3, 'itens_sem_custo', 37)),
    CASE WHEN p_com_fencing THEN 'run-B' ELSE NULL END);
  INSERT INTO public.trilha(run,evento) VALUES ('B','apply_ok');

  -- 4. A, ainda vivo, tenta escrever o snapshot VELHO
  INSERT INTO public.trilha(run,evento) VALUES ('A','apply_tentado');
  BEGIN
    PERFORM public.apply_score_updates(jsonb_build_array(public.core_payload() ||
      jsonb_build_object('gross_margin_pct', v_snap_gm,
                         'itens_com_custo', v_snap_com, 'itens_sem_custo', v_snap_sem)),
      CASE WHEN p_com_fencing THEN 'run-A' ELSE NULL END);
    INSERT INTO public.trilha(run,evento) VALUES ('A','apply_ok');
  EXCEPTION WHEN SQLSTATE '55000' THEN
    -- o handler roda APÓS o rollback ao savepoint, então este INSERT persiste
    INSERT INTO public.trilha(run,evento) VALUES ('A','apply_barrado_55000');
  END;
END $f$;
SQL

echo "   C2 (baseline do bug: SEM fencing, = o mundo de hoje)"
Ps -c "SELECT public.corrida(false);"
eq "C2a A escreveu (nao ha nada que o barre)" "$(Pq -c "SELECT count(*) FROM public.trilha WHERE run='A' AND evento='apply_ok';")" "1"
eq "C2b BUG REAL: gm RESTAUROU o velho 99 sobre o 53 de B" \
   "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "99"
eq "C2c BUG REAL: itens_com_custo RESTAUROU 77 sobre o 3 de B" \
   "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "77"

echo "   C1 (COM fencing)"
Ps -c "SELECT public.corrida(true);"
eq "C1a A TENTOU o apply (trilha prova que nao foi 'nao rodou')" "$(Pq -c "SELECT count(*) FROM public.trilha WHERE run='A' AND evento='apply_tentado';")" "1"
eq "C1b A foi BARRADO com 55000"                                "$(Pq -c "SELECT count(*) FROM public.trilha WHERE run='A' AND evento='apply_barrado_55000';")" "1"
eq "C1c A NAO registrou apply_ok"                               "$(Pq -c "SELECT count(*) FROM public.trilha WHERE run='A' AND evento='apply_ok';")" "0"
eq "C1d B escreveu normalmente"                                 "$(Pq -c "SELECT count(*) FROM public.trilha WHERE run='B' AND evento='apply_ok';")" "1"
eq "C1e dado FICOU com o valor de B: gm=53"        "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "53"
eq "C1f dado FICOU com o valor de B: itens 3"      "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "3"
eq "C1g dado FICOU com o valor de B: itens_sem 37" "$(Pq -c "SELECT itens_sem_custo FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" "37"

# ── C3/C4: o FOR SHARE serializa de verdade (DUAS SESSÕES psql REAIS, nos DOIS sentidos) ──
# C3 (A trava primeiro): A abre a transação e aplica um chunk com token (toma FOR SHARE na linha do
#   lease); B roda o CLAIM REAL — o INSERT..ON CONFLICT DO UPDATE transcrito da 20260728120001 —
#   sobre um lease EXPIRADO (tomada legítima, não um claim que o WHERE recusaria). Com o lock, B
#   ESPERA o COMMIT de A, e depois vira o dono.
# C4 (B trava primeiro, o sentido inverso — EPQ): B toma o lease expirado e segura a transação
#   aberta; A tenta o apply com o token antigo. Com o lock, A ESPERA; quando B commita, o READ
#   COMMITTED reavalia o predicado sobre a versão NOVA da linha (run_id=run-B) e A recebe 55000 sem
#   escrever. Sem o lock, A leria a versão velha (ainda run-A) e escreveria.
#
# O BLOQUEIO É OBSERVADO, NÃO INFERIDO: o shell espera `pg_blocking_pids` apontar a sessão que tem de
# esperar, e só então libera a outra. Nenhum `pg_sleep` decide a corrida — a v1 do C3 dependia de
# `pg_sleep(1.5)` e de B chegar dentro dele (achado do challenge Codex 2026-10-10: verde por
# escalonamento não prova sobreposição), e o claim de B caía no WHERE (lease fresco) sem tomar nada.
#
# ⚠️ A LARGADA NÃO PODE SER OBSERVADA POR DENTRO DO BANCO — este harness já errou aqui, e o erro
# passava por VERDE. A 1ª versão esperava A aparecer na trilha (`SELECT count(*) ... 'A_apply'`),
# mas esse INSERT está DENTRO da transação ABERTA de A: nenhuma outra sessão o enxerga antes do
# COMMIT. O laço batia no timeout, e só então B largava — com A já commitado. C3 ficava 't' SEMPRE,
# inclusive sem lock nenhum: media "B começou tarde", não "B bloqueou". Quem denunciou foi a
# falsificação F2 (assert verde sob sabotagem = a sabotagem não alcança o que o assert mede, lição
# #1549). ⇒ os sinais saem do banco por ARQUIVO: `\!` do psql roda SHELL, fora da transação. Todo
# laço de espera tem teto e devolve a sentinela TIMEOUT em vez de um veredito, para não confundir
# "não consegui medir" com "medi e é falso".
C3TMP="$(mktemp -d "/tmp/c3-${SLUG}.XXXXXX")"
# espera um arquivo aparecer (teto 10s); usado DE DENTRO das sessões psql via `\!`
cat > "$C3TMP/espera.sh" <<'SH'
#!/bin/sh
i=0
while [ ! -f "$1" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i+1)); done
SH
chmod +x "$C3TMP/espera.sh"

# t = a sessão $1 (application_name) está BLOQUEADA por outra ; f = o cliente dela terminou sem
# bloquear (arquivo $2 apareceu) ; TIMEOUT = nem um nem outro em 10s
esperar_bloqueio() {
  local i=0
  while [ $i -lt 200 ]; do
    if [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='$1' AND cardinality(pg_blocking_pids(pid)) > 0;")" = "1" ]; then
      echo t; return
    fi
    if [ -f "$2" ]; then echo f; return; fi
    sleep 0.05; i=$((i+1))
  done
  echo TIMEOUT
}

# prepara o lease de run-A EXPIRADO (20 min > TTL de 15): o claim de B é tomada LEGÍTIMA
lease_a_expirado() {
  Ps -c "DELETE FROM public.trilha; SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');
         UPDATE public.sync_state SET last_sync_at = now() - interval '20 minutes'
          WHERE entity_type='calculate_scores' AND account='global';"
}

# o claim REAL de B (transcrito da 20260728120001), seguido da leitura de quem ficou dono
CLAIM_B="INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
VALUES ('calculate_scores','global','syncing', now(), 0, jsonb_build_object('run_id','run-B','fase','inicio'), now())
ON CONFLICT (entity_type, account) DO UPDATE
  SET status='syncing', last_sync_at=now(), total_synced=0,
      metadata=jsonb_build_object('run_id','run-B','fase','inicio'), updated_at=now()
  WHERE sync_state.status IS DISTINCT FROM 'syncing'
     OR sync_state.last_sync_at IS NULL
     OR sync_state.last_sync_at < now() - interval '15 minutes'
     OR (sync_state.metadata->>'run_id') = 'run-B';"

# C3 — devolve "<B bloqueou>|<B_claim depois de A_pre_commit>|<dono final>"
c3_run() {
  local D="$C3TMP/c3"; rm -rf "$D"; mkdir -p "$D"
  lease_a_expirado
  PGAPPNAME=c3_A "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<SQL &
BEGIN;
SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() ||
  jsonb_build_object('gross_margin_pct', 53)), 'run-A');
\! touch $D/a_dentro
\! $C3TMP/espera.sh $D/go_a
INSERT INTO public.trilha(run,evento) VALUES ('A','A_pre_commit');
COMMIT;
SQL
  local PID_A=$!
  "$C3TMP/espera.sh" "$D/a_dentro"
  if [ ! -f "$D/a_dentro" ]; then touch "$D/go_a"; wait "$PID_A" || true; echo "TIMEOUT"; return; fi
  PGAPPNAME=c3_B "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<SQL &
$CLAIM_B
INSERT INTO public.trilha(run,evento) VALUES ('B','B_claim');
\! touch $D/b_fim
SQL
  local PID_B=$!
  local BLOQ; BLOQ="$(esperar_bloqueio c3_B "$D/b_fim")"
  touch "$D/go_a"
  wait "$PID_A" || true; wait "$PID_B" || true
  local ORDEM DONO
  ORDEM="$(Pq -c "SELECT (SELECT seq FROM public.trilha WHERE evento='B_claim')
                       > (SELECT seq FROM public.trilha WHERE evento='A_pre_commit');")"
  DONO="$(Pq -c "SELECT metadata->>'run_id' FROM public.sync_state WHERE entity_type='calculate_scores' AND account='global';")"
  echo "${BLOQ}|${ORDEM}|${DONO}"
}

# C4 — devolve "<A bloqueou>|<desfecho de A na trilha>|<gross_margin_pct>"
c4_run() {
  local D="$C3TMP/c4"; rm -rf "$D"; mkdir -p "$D"
  lease_a_expirado
  PGAPPNAME=c4_B "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<SQL &
BEGIN;
$CLAIM_B
\! touch $D/b_dentro
\! $C3TMP/espera.sh $D/go_b
COMMIT;
SQL
  local PID_B=$!
  "$C3TMP/espera.sh" "$D/b_dentro"
  if [ ! -f "$D/b_dentro" ]; then touch "$D/go_b"; wait "$PID_B" || true; echo "TIMEOUT"; return; fi
  # A captura SÓ a 55000 (o desfecho esperado) e registra; qualquer outra SQLSTATE re-lança e o
  # psql sai sem registrar — a trilha fica sem desfecho e o assert falha (sem WHEN OTHERS teatral).
  # Heredoc: o corpo DO precisa de $$, então o SQL vai aspado e o sinal de fim sai num 2º comando.
  PGAPPNAME=c4_A "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 \
    -f - -c "\\! touch $D/a_fim" <<'SQL' &
DO $$
BEGIN
  PERFORM public.apply_score_updates(jsonb_build_array(public.core_payload() ||
    jsonb_build_object('gross_margin_pct', 53)), 'run-A');
  INSERT INTO public.trilha(run,evento) VALUES ('A','A_escreveu');
EXCEPTION WHEN SQLSTATE '55000' THEN
  INSERT INTO public.trilha(run,evento) VALUES ('A','A_barrado_55000');
END $$;
SQL
  local PID_A=$!
  local BLOQ; BLOQ="$(esperar_bloqueio c4_A "$D/a_fim")"
  touch "$D/go_b"
  wait "$PID_B" || true; wait "$PID_A" || true
  local DESF GM
  DESF="$(Pq -c "SELECT coalesce(string_agg(evento, ',' ORDER BY seq), '<nenhum>') FROM public.trilha WHERE run='A';")"
  GM="$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")"
  echo "${BLOQ}|${DESF}|${GM}"
}
eq "C3 A trava primeiro: o claim (tomada legitima de lease expirado) ESPERA o COMMIT do chunk e depois vira dono" \
   "$(c3_run)" "t|t|run-B"
eq "C4 B trava primeiro: o apply de A ESPERA, e no COMMIT de B recebe 55000 sem escrever (gm segue 99)" \
   "$(c4_run)" "t|A_barrado_55000|99"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA F — FALSIFICAÇÃO
# ════════════════════════════════════════════════════════════════════════════════════════════════
# Baseline: o harness chegou aqui com os asserts acima VERDES sob a migration REAL — é o "baseline
# verde antes" exigido pelo money-path.md. Cada sabotagem PROVA QUE APLICOU antes de medir.
echo "-- ZONA F: falsificacao --"
FALSIF_OK=0

prova_sabotagem() { # $1 = trecho ASCII que TEM de aparecer no corpo sabotado, $2 = rótulo
  if [ "$(Pq -c "SELECT pg_get_functiondef(to_regprocedure('public.apply_score_updates(jsonb, text)')::oid) LIKE '%$1%';")" = "t" ]; then
    echo "     (sabotagem $2 aplicada e conferida no corpo)"
  else
    bad "$2 — a SABOTAGEM NAO APLICOU (falsificacao INVALIDA, nao leia como 'assert sem dente')"
  fi
}

# F1 — remove o bloco de fencing inteiro. N1 (run alheio) tem de virar ESCRITA.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_count int;
BEGIN
  -- SABOTAGEM F1: bloco de fencing REMOVIDO (marcador SABOTAGEM_F1_SEM_FENCING)
  UPDATE public.farmer_client_scores f SET
    gross_margin_pct = CASE WHEN u.tem_gm THEN u.gm ELSE f.gross_margin_pct END,
    itens_com_custo  = CASE WHEN u.tem_ic THEN u.ic ELSE f.itens_com_custo  END
  FROM (
    SELECT (e.elem->>'id')::uuid AS id,
           (e.elem->>'gross_margin_pct')::numeric AS gm, (e.elem->>'itens_com_custo')::bigint AS ic,
           jsonb_exists(e.elem,'gross_margin_pct') AS tem_gm, jsonb_exists(e.elem,'itens_com_custo') AS tem_ic
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $fn$;
SQL
prova_sabotagem "SABOTAGEM_F1_SEM_FENCING" "F1"
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-B','syncing');"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() ||
  jsonb_build_object('gross_margin_pct', 53, 'itens_com_custo', 3)), 'run-A');" >/dev/null 2>&1 || true
case "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" in
  53) ok "F1 sem o fencing o run ALHEIO ESCREVE (gm 99->53) => N1 tem dente"; FALSIF_OK=$((FALSIF_OK+1));;
  *)  bad "F1 removi o fencing e o run alheio ainda NAO escreveu => N1 e teatro (passa por outro motivo)";;
esac
P -q -f "$MIG" >/dev/null

# F3 — trata '' como NULL (o bypass). N3 tem de virar ESCRITA.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_count int;
BEGIN
  -- SABOTAGEM F3: '' tratado como "sem fencing" (marcador SABOTAGEM_F3_VAZIO_VIRA_NULL)
  IF p_run_id IS NOT NULL AND btrim(p_run_id) <> '' THEN
    PERFORM 1 FROM public.sync_state
     WHERE entity_type='calculate_scores' AND account='global' AND status='syncing'
       AND (metadata->>'run_id') = p_run_id FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'nao e dono' USING ERRCODE = '55000';
    END IF;
  END IF;
  UPDATE public.farmer_client_scores f SET
    gross_margin_pct = CASE WHEN u.tem_gm THEN u.gm ELSE f.gross_margin_pct END
  FROM (
    SELECT (e.elem->>'id')::uuid AS id, (e.elem->>'gross_margin_pct')::numeric AS gm,
           jsonb_exists(e.elem,'gross_margin_pct') AS tem_gm
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $fn$;
SQL
prova_sabotagem "SABOTAGEM_F3_VAZIO_VIRA_NULL" "F3"
Ps -c "SELECT public.reseed(); SELECT public.set_lease('run-A','syncing');"
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(public.core_payload() ||
  jsonb_build_object('gross_margin_pct', 53)), '');" >/dev/null 2>&1 || true
case "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';")" in
  53) ok "F3 com '' tratado como NULL o gate e BYPASSADO (gm 99->53) => N3 tem dente"; FALSIF_OK=$((FALSIF_OK+1));;
  *)  bad "F3 tratei '' como NULL e a escrita NAO passou => N3 e teatro";;
esac
P -q -f "$MIG" >/dev/null

# F2 — troca FOR SHARE por SELECT simples. C3 tem de deixar de bloquear.
# É a sabotagem que mais importa: o invariante "o perdedor nao escreve" tem DOIS mecanismos (o IF de
# ownership e o LOCK). F1 mede o IF; sem F2 eu nao saberia se o LOCK faz algo — e "a checagem existe"
# nao e "a checagem e atomica" (licao #1549: enumere os mecanismos antes de falsificar).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_count int;
BEGIN
  -- SABOTAGEM F2: FOR SHARE removido (marcador SABOTAGEM_F2_SEM_LOCK)
  IF p_run_id IS NOT NULL THEN
    IF btrim(p_run_id) = '' THEN RAISE EXCEPTION 'vazio' USING ERRCODE = '22004'; END IF;
    PERFORM 1 FROM public.sync_state
     WHERE entity_type='calculate_scores' AND account='global' AND status='syncing'
       AND (metadata->>'run_id') = p_run_id;   -- SEM FOR SHARE
    IF NOT FOUND THEN RAISE EXCEPTION 'nao e dono' USING ERRCODE = '55000'; END IF;
  END IF;
  UPDATE public.farmer_client_scores f SET
    gross_margin_pct = CASE WHEN u.tem_gm THEN u.gm ELSE f.gross_margin_pct END
  FROM (
    SELECT (e.elem->>'id')::uuid AS id, (e.elem->>'gross_margin_pct')::numeric AS gm,
           jsonb_exists(e.elem,'gross_margin_pct') AS tem_gm
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $fn$;
SQL
prova_sabotagem "SABOTAGEM_F2_SEM_LOCK" "F2"
# Os DOIS sentidos têm de cair: C3 (o claim não espera mais) e C4 (A lê a versão velha e escreve).
F2_C3="$(c3_run)"; F2_C4="$(c4_run)"
if [ "$F2_C3" = "f|f|run-B" ] && [ "$F2_C4" = "f|A_escreveu|53" ]; then
  ok "F2 sem FOR SHARE: o claim PASSA NA FRENTE (C3=$F2_C3) e o perdedor ESCREVE (C4=$F2_C4) => C3/C4 tem dente (o LOCK e o fencing)"
  FALSIF_OK=$((FALSIF_OK+1))
else
  bad "F2 removi o FOR SHARE e C3/C4 nao cairam como esperado (C3=[$F2_C3] C4=[$F2_C4]) => teatro ou medida quebrada"
fi
P -q -f "$MIG" >/dev/null

# a restauração tem de valer: sem isto, um harness verde poderia estar medindo a última sabotagem
eq "F0 migration REAL restaurada ao fim (sem marcador de sabotagem no corpo)" \
   "$(Pq -c "SELECT pg_get_functiondef(to_regprocedure('public.apply_score_updates(jsonb, text)')::oid) LIKE '%SABOTAGEM%';")" "f"
eq "F0b as 3 sabotagens produziram o vermelho esperado" "$FALSIF_OK" "3"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

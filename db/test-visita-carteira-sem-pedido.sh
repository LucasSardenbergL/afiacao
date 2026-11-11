#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — db/2026-11-11-visita-carteira-sem-pedido-backfill.sql (v8, D13)    ║
# ║  Quem nunca comprou e não é lead sai com 10/prospecção; comprador, lead,          ║
# ║  excluído, expansão medida e qualquer sales_orders ficam intocados; TRAVA pelo    ║
# ║  ledger de deploy; idempotente; PÓS pega predicado furado; falsificação inline.   ║
# ║      bash db/test-visita-carteira-sem-pedido.sh > /tmp/t.log 2>&1; echo $?        ║
# ║  2º locale (lição #1483):                                                       ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-visita-carteira-sem-pedido.sh            ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5481}"
SLUG="visita-carteira-sem-pedido"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
SAB="$TMPD/sabotada.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

SCRIPT="$REPO_ROOT/db/2026-11-11-visita-carteira-sem-pedido-backfill.sql"
[ -f "$SCRIPT" ] || { echo "INFRA: ausente: $SCRIPT"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
P()  { PGOPTIONS='-c client_min_messages=error' "$PGBIN/psql" -X -v VERBOSITY=default -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

eq "L0 lc_messages do servidor é o pedido (prova que o 2º locale rodou de fato)" "$(Pq -c "SHOW lc_messages")" "$HARNESS_LC"

# Roda um arquivo SQL inteiro numa transação (como o executor do db:aplicar) e devolve OK ou o
# marcador ASCII da exceção (TRAVA/POST), que não muda com o locale.
roda() { # $1 = arquivo
  local saida
  if saida="$(P -q -1 -f "$1" 2>&1)"; then echo "OK"; return 0; fi
  case "$saida" in
    *"TRAVA:"*) echo "TRAVA" ;;
    *"POST: "*"comprador ou lead"*) echo "POST_COMPRADOR" ;;
    *"POST: "*"score velho"*) echo "POST_RESTA" ;;
    *) echo "OUTRO: $saida" ;;
  esac
}

# ZONA 1 — só as colunas que o script lê/grava, com os tipos de prod.
P -q <<'SQL'
CREATE TYPE public.visit_mission AS ENUM ('recuperacao', 'expansao', 'relacionamento', 'prospeccao');
CREATE TABLE public.customer_visit_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE, farmer_id uuid NOT NULL,
  recuperacao_score numeric, expansao_score numeric, relacionamento_score numeric, prospeccao_score numeric,
  visit_score numeric, primary_mission public.visit_mission, score_breakdown jsonb,
  calculated_at timestamptz, updated_at timestamptz);
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid PRIMARY KEY, sales_history_status text, expansion_score numeric, revenue_potential numeric);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_prospect boolean, prospect_source text);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, status text, deleted_at timestamptz);
CREATE TABLE public.cliente_classificacao (user_id uuid PRIMARY KEY, excluir_da_carteira boolean NOT NULL DEFAULT false);
CREATE TABLE public.deploy_atestacoes (
  request_id bigint NOT NULL, observado_em timestamptz NOT NULL, edge text NOT NULL, versao text NOT NULL,
  fonte text NOT NULL, via text NOT NULL, registrado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, observado_em));
SQL

# Clientes (último dígito = caso):
#  a1 importado nunca comprou (o caso da onda de 02/11)      → alvo
#  b2 alias fiscal sem profile, sem_historico                → alvo
#  c3 comprador stale com pedido                             → intocado
#  d4 histórico ativo sem pedido no app                      → intocado (a edge trata como comprador)
#  e5 lead declarado (is_prospect)                           → intocado (base 70 é da edge)
#  f6 só um sales_orders APAGADO                             → intocado (conservador: qualquer linha pula)
#  a7 excluído da carteira                                   → intocado (a edge não grava para ele)
#  b8 expansão medida em fcs                                 → intocado (a expansão poderia vencer)
#  c9 sem linha em farmer_client_scores e sem profile        → alvo
#  da sales_history_status nulo (não computado)              → alvo
seed() {
  P -q <<'SQL'
TRUNCATE public.customer_visit_scores, public.farmer_client_scores, public.profiles, public.sales_orders,
         public.cliente_classificacao, public.deploy_atestacoes;
INSERT INTO public.customer_visit_scores
  (customer_user_id, farmer_id, recuperacao_score, expansao_score, relacionamento_score, prospeccao_score,
   visit_score, primary_mission, score_breakdown, calculated_at, updated_at)
SELECT c::uuid, '00000000-0000-0000-0000-0000000000ff', 50, NULL, 0, 90, 90, 'prospeccao',
       '{"inputs":{"sales_orders_count":0,"churn_risk":100},"mission_scores":{"expansao":{"score":null,"insumosAusentes":["expansion_score","revenue_potential"]},"prospeccao":{"score":90,"insumosAusentes":[]},"recuperacao":{"score":50,"insumosAusentes":["recover_score"]},"relacionamento":{"score":0,"insumosAusentes":[]}},"insumos_ausentes":[]}',
       '2026-11-02 07:00+00', '2026-11-02 07:00+00'
  FROM unnest(ARRAY['00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2',
                    '00000000-0000-0000-0000-0000000000d4','00000000-0000-0000-0000-0000000000e5',
                    '00000000-0000-0000-0000-0000000000f6','00000000-0000-0000-0000-0000000000a7',
                    '00000000-0000-0000-0000-0000000000b8','00000000-0000-0000-0000-0000000000c9',
                    '00000000-0000-0000-0000-0000000000da']) c;
INSERT INTO public.customer_visit_scores
  (customer_user_id, farmer_id, recuperacao_score, expansao_score, relacionamento_score, prospeccao_score,
   visit_score, primary_mission, score_breakdown, calculated_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000ff', 49.5, NULL, 20, 0, 49.5,
        'recuperacao', '{"inputs":{"sales_orders_count":3}}', '2026-11-02 07:00+00', '2026-11-02 07:00+00');
INSERT INTO public.farmer_client_scores (customer_user_id, sales_history_status, expansion_score, revenue_potential) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'sem_historico', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000b2', 'sem_historico', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000c3', 'stale', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000d4', 'ativo', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000e5', 'sem_historico', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000f6', 'sem_historico', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000a7', 'sem_historico', NULL, NULL),
  ('00000000-0000-0000-0000-0000000000b8', 'sem_historico', 40, NULL),
  ('00000000-0000-0000-0000-0000000000da', NULL, NULL, NULL);
INSERT INTO public.profiles (user_id, is_prospect, prospect_source) VALUES
  ('00000000-0000-0000-0000-0000000000a1', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000c3', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000d4', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000e5', true,  NULL),
  ('00000000-0000-0000-0000-0000000000f6', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000a7', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000b8', false, 'omie_import'),
  ('00000000-0000-0000-0000-0000000000da', false, 'omie_import');
INSERT INTO public.sales_orders (customer_user_id, status, deleted_at) VALUES
  ('00000000-0000-0000-0000-0000000000c3', 'faturado', NULL),
  ('00000000-0000-0000-0000-0000000000f6', 'faturado', '2026-10-01');
INSERT INTO public.cliente_classificacao (user_id, excluir_da_carteira) VALUES
  ('00000000-0000-0000-0000-0000000000a7', true);
SQL
}
atesta() { # $1 = versão
  P -q -c "INSERT INTO public.deploy_atestacoes (request_id, observado_em, edge, versao, fonte, via)
           VALUES ((SELECT coalesce(max(request_id), 0) + 1 FROM public.deploy_atestacoes), now(),
                   'visit-score-recalc-client', '$1', 'f', 'sonda')"
}
linha() { # $1 = sufixo do uuid → visit/missão/rec/rel/prosp
  Pq -c "SELECT visit_score::int || '/' || primary_mission || '/' || recuperacao_score::int || '/' ||
                relacionamento_score::int || '/' || prospeccao_score::int
           FROM public.customer_visit_scores WHERE customer_user_id = '00000000-0000-0000-0000-0000000000$1'"
}
alvos_ok() { # os 4 alvos corrigidos, em uma string
  echo "$(linha a1) $(linha b2) $(linha c9) $(linha da)"
}
intocados() { # os 6 de fora, com o updated_at original
  Pq -c "SELECT count(*) FROM public.customer_visit_scores
          WHERE customer_user_id::text ~ '(c3|d4|e5|f6|a7|b8)$'
            AND updated_at = '2026-11-02 07:00+00' AND NOT score_breakdown ? 'backfill'"
}
NOVO="10/prospeccao/0/0/10"

echo "── TRAVA: sem a v1.1 atestada, nada muda ──"
seed
eq "T1 sem atestação nenhuma → TRAVA" "$(roda "$SCRIPT")" "TRAVA"
atesta "v1.0-sonda"
eq "T2 atestada na v1.0 (edge velha) → TRAVA" "$(roda "$SCRIPT")" "TRAVA"
eq "T3 TRAVA não deixou meio-aplicado (a1 segue 90)" "$(linha a1)" "90/prospeccao/50/0/90"
atesta "v1.1-carteira-sem-pedido"
atesta "v1.0-sonda"
eq "T4 vale a ÚLTIMA atestação (v1.1 seguida de rollback para v1.0) → TRAVA" "$(roda "$SCRIPT")" "TRAVA"

echo "── aplicação com a v1.1 no ar ──"
seed
atesta "v1.1-carteira-sem-pedido"
eq "A1 roda inteiro" "$(roda "$SCRIPT")" "OK"
eq "A2 os 4 alvos (importado, alias sem profile, sem fcs, status nulo) → 10/prospecção" "$(alvos_ok)" "$NOVO $NOVO $NOVO $NOVO"
eq "A3 os 6 de fora intocados (comprador, ativo sem pedido, lead, pedido apagado, excluído, expansão)" "$(intocados)" "6"
eq "A4 breakdown: missões novas, insumos vazios, marca do backfill, inputs preservados" \
  "$(Pq -c "SELECT (score_breakdown->'mission_scores'->'prospeccao'->>'score') || '|' ||
                  (score_breakdown->'mission_scores'->'recuperacao'->>'score') || '|' ||
                  (score_breakdown->'mission_scores'->'relacionamento'->>'score') || '|' ||
                  (score_breakdown->'mission_scores'->'expansao'->>'score' IS NULL) || '|' ||
                  (score_breakdown->'insumos_ausentes')::text || '|' ||
                  (score_breakdown->'backfill'->>'regra') || '|' ||
                  (score_breakdown->'inputs'->>'churn_risk')
             FROM public.customer_visit_scores WHERE customer_user_id = '00000000-0000-0000-0000-0000000000a1'")" \
  "10|0|0|true|[]|d13-carteira-sem-pedido|100"
eq "A5 calculated_at preservado (não é recálculo da edge), updated_at andou" \
  "$(Pq -c "SELECT (calculated_at = '2026-11-02 07:00+00') || '/' || (updated_at > '2026-11-02 07:00+00')
             FROM public.customer_visit_scores WHERE customer_user_id = '00000000-0000-0000-0000-0000000000a1'")" "true/true"
eq "A6 ordem da cidade: o comprador c3 (49,5) fica acima de TODO nunca comprou" \
  "$(Pq -c "SELECT string_agg(right(customer_user_id::text, 2), ',' ORDER BY visit_score DESC, customer_user_id)
             FROM public.customer_visit_scores WHERE visit_score < 50 OR customer_user_id::text LIKE '%c3'")" "c3,a1,b2,c9,da"

echo "── idempotência ──"
P -q -c "UPDATE public.customer_visit_scores SET updated_at = '2026-11-11 00:00+00' WHERE score_breakdown ? 'backfill'"
eq "I1 2ª rodada passa" "$(roda "$SCRIPT")" "OK"
eq "I2 2ª rodada não regrava ninguém (updated_at dos 4 alvos parado)" \
  "$(Pq -c "SELECT count(*) FROM public.customer_visit_scores WHERE score_breakdown ? 'backfill' AND updated_at = '2026-11-11 00:00+00'")" "4"

echo "── falsificação (uma camada por vez; controle verde antes e depois) ──"
sabota() { # $1 = expressão sed · $2 = rótulo
  sed -e "$1" "$SCRIPT" > "$SAB"
  if cmp -s "$SCRIPT" "$SAB"; then bad "$2: sabotagem NÃO casou — falsificação seria teatro"; return 1; fi
  seed; atesta "v1.1-carteira-sem-pedido"
}
seed; atesta "v1.1-carteira-sem-pedido"
eq "FC0 controle antes: o script íntegro passa e corrige os 4 alvos" "$(roda "$SCRIPT") $(alvos_ok)" "OK $NOVO $NOVO $NOVO $NOVO"
# As cláusulas do UPDATE têm 3 espaços de recuo; as do PÓS têm 5 — o sed só casa a do UPDATE.
if sabota "s/^   AND p.is_prospect IS NOT TRUE$/   AND true/" "F1"; then
  eq "F1 UPDATE sem o filtro de lead → o PÓS 2 pega o lead marcado" "$(roda "$SAB")" "POST_COMPRADOR"
fi
if sabota "s/^   AND NOT EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.customer_user_id = alvo.customer_user_id)$/   AND true/" "F2"; then
  eq "F2 UPDATE sem o filtro de pedido → o PÓS 2 pega o comprador marcado" "$(roda "$SAB")" "POST_COMPRADOR"
fi
if sabota "s/^       visit_score          = 10,$/       visit_score          = 11,/" "F3"; then
  eq "F3 UPDATE grava o score errado → o PÓS 1 pega o alvo que restou" "$(roda "$SAB")" "POST_RESTA"
fi
if sabota "s/^  IF v_versao IS DISTINCT FROM 'v1.1-carteira-sem-pedido' THEN$/  IF false THEN/" "F4"; then
  P -q -c "DELETE FROM public.deploy_atestacoes"; atesta "v1.0-sonda"
  eq "F4 sem a TRAVA, a edge velha no ar não segura o backfill (o T2 pega: ali é TRAVA)" "$(roda "$SAB")" "OK"
fi
# A linha de continuação tem 20 espaços no UPDATE e 22 no PÓS; o ^ + 20 espaços + W só casa a do UPDATE.
if sabota "s/^                    WHERE cc.user_id = alvo.customer_user_id AND cc.excluir_da_carteira)$/                    WHERE false)/" "F5"; then
  roda "$SAB" >/dev/null
  eq "F5 UPDATE sem o filtro de excluído → o excluído a7 é regravado (o A3 pega: 5 intocados, não 6)" "$(intocados)" "5"
fi
if sabota "s/^   AND fcs.expansion_score IS NULL$/   AND true/" "F6"; then
  roda "$SAB" >/dev/null
  eq "F6 UPDATE sem o filtro de expansão → b8 é regravado (o A3 pega: 5 intocados)" "$(intocados)" "5"
fi
seed; atesta "v1.1-carteira-sem-pedido"
eq "FC1 controle depois: o script íntegro volta a passar e corrigir" "$(roda "$SCRIPT") $(alvos_ok) $(intocados)" "OK $NOVO $NOVO $NOVO $NOVO 6"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

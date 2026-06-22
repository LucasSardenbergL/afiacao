#!/usr/bin/env bash
# PROVA PG17 — fix do enum em tarefas_matcher_tick() (numero_errado -> numero_invalido).
# Lei de Ferro: aplica a migration REAL; assert negativo de comportamento; falsificação obrigatória.
#   bash db/test-tarefas-matcher-enum.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="tarefas-matcher-enum"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${BUGGY:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-requisitos (enum + tabelas que a função toca) ──
P -q <<'SQL'
CREATE TYPE public.farmer_call_result AS ENUM
  ('contato_sucesso','sem_resposta','ocupado','caixa_postal','numero_invalido','reagendado');

CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text, auto_satisfy_mode text, interacao_tipo text,
  customer_user_id uuid, created_at timestamptz, assigned_to uuid,
  concluida_em timestamptz, conclusao_origem text, updated_at timestamptz, target_texto text
);
CREATE TABLE public.farmer_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, created_at timestamptz,
  call_result public.farmer_call_result, farmer_id uuid, entities_extracted jsonb
);
CREATE TABLE public.route_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, check_in_at timestamptz, visit_type text, visited_by uuid
);
CREATE TABLE public.carteira_coverage (
  covered_user_id uuid, covering_user_id uuid, active boolean,
  valid_from timestamptz, valid_until timestamptz
);
CREATE TABLE public.tarefa_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarefa_id uuid, tipo_evento text, ator uuid, payload jsonb, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.tarefa_satisfacao_candidatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tarefa_id uuid, source_type text, source_id uuid, mode text, confidence numeric,
  motivo text, matched_payload jsonb, status text,
  created_at timestamptz DEFAULT now(), resolved_at timestamptz,
  UNIQUE (tarefa_id, source_type, source_id)
);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260615194500_fix_tarefas_matcher_enum.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed: 1 tarefa que DEVE fechar (contato_sucesso), 1 que NÃO (numero_invalido) ──
P -q <<'SQL'
INSERT INTO public.tarefas (id, status, auto_satisfy_mode, interacao_tipo, customer_user_id, created_at, assigned_to) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','aberta','interacao','ligacao','c0000000-0000-0000-0000-000000000001', now()-interval '2 hours','f0000000-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000001','aberta','interacao','ligacao','c0000000-0000-0000-0000-000000000002', now()-interval '2 hours','f0000000-0000-0000-0000-000000000001');
INSERT INTO public.farmer_calls (id, customer_user_id, created_at, call_result, farmer_id) VALUES
  (gen_random_uuid(),'c0000000-0000-0000-0000-000000000001', now()-interval '1 hour','contato_sucesso','f0000000-0000-0000-0000-000000000001'),
  (gen_random_uuid(),'c0000000-0000-0000-0000-000000000002', now()-interval '1 hour','numero_invalido','f0000000-0000-0000-0000-000000000001');
SQL

# ── ZONA 4 — asserts ──
echo "── asserts ──"
# A1 — a função CORRIGIDA executa sem erro (o que destrava o cron; a buggy abortava)
if P -q -c "SELECT public.tarefas_matcher_tick();" >/dev/null 2>&1; then
  ok "A1 tick executa sem erro (fix destrava o cron)"
else
  bad "A1 tick FALHOU com o fix aplicado (não deveria)"
fi
# A2 — contato_sucesso (NÃO está no not-in) fecha a tarefa
VA=$(Pq -c "SELECT status FROM public.tarefas WHERE id='aaaaaaaa-0000-0000-0000-000000000001';")
eq "A2 contato_sucesso fecha a tarefa" "$VA" "concluida"
# A3 — numero_invalido (ESTÁ no not-in) NÃO fecha a tarefa
VB=$(Pq -c "SELECT status FROM public.tarefas WHERE id='bbbbbbbb-0000-0000-0000-000000000001';")
eq "A3 numero_invalido NAO fecha a tarefa" "$VB" "aberta"

# ── ZONA 5 — falsificação: a versão com 'numero_errado' DEVE abortar (era o bug real) ──
echo "── falsificação ──"
BUGGY=$(mktemp "${TMPDIR:-/tmp}/buggy-matcher.XXXXXX")
sed 's/numero_invalido/numero_errado/g' "$MIG" > "$BUGGY"
P -q -f "$BUGGY" >/dev/null 2>&1 || true   # CREATE passa (late-bound); valida só ao executar
if P -q -c "SELECT public.tarefas_matcher_tick();" >/dev/null 2>&1; then
  bad "FALSIFICAÇÃO: tick buggy PASSOU (devia abortar por enum inválido) — A1 sem dente"
else
  ok "FALSIFICAÇÃO: tick buggy aborta (confirma 'numero_errado' como o bug)"
fi
rm -f "$BUGGY"
P -q -f "$MIG" >/dev/null   # restaura a versão verdadeira

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

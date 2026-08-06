#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — FU3: filas de recompute de score viram master-only              ║
# ║  migration: supabase/migrations/20260718100000_filas_recalc_rls_master_only.sql║
# ║                                                                                ║
# ║  Prova que: (1) o furo EXISTIA (employee lia o vínculo mascarado ANTES);       ║
# ║  (2) depois do fix o employee NÃO lê nem a tabela nem a VIEW *_pending;        ║
# ║  (3) master e service_role (batch) SEGUEM lendo;                               ║
# ║  (4) o enqueue por trigger SECURITY DEFINER continua funcionando mesmo com a    ║
# ║      policy INSERT estreitada — e F3 prova que é o SECDEF que o sustenta.      ║
# ║                                                                                ║
# ║  rode: bash db/test-filas-recalc-rls-master-only.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="filas-recalc-rls"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: espelho FIEL da prod (não do design)
#   Conferido via psql-ro: pg_indexes E pg_constraint (o único PARCIAL não aparece
#   em pg_constraint — e é dele que o ON CONFLICT do trigger depende).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

-- has_role REAL da prod (pg_get_functiondef): SQL/STABLE/SECURITY DEFINER.
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.carteira_assignments (
  customer_user_id uuid NOT NULL,
  owner_user_id    uuid NOT NULL,
  eligible         boolean NOT NULL DEFAULT true
);

CREATE TABLE public.route_visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid,
  visited_by       uuid,
  visit_date       date DEFAULT current_date
);

-- ── as 2 filas, com os índices REAIS da prod ──────────────────────────────────
CREATE TABLE public.score_recalc_queue (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id        uuid NOT NULL,
  reason           text NOT NULL,
  source_call_id   uuid,
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  error            text
);
CREATE UNIQUE INDEX uniq_score_recalc_queue_pending
  ON public.score_recalc_queue (customer_user_id) WHERE (processed_at IS NULL);

CREATE TABLE public.visit_score_recalc_queue (
  id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id        uuid NOT NULL,
  reason           text NOT NULL,
  source_event_id  uuid,
  enqueued_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  error            text
);
CREATE UNIQUE INDEX uniq_visit_score_queue_pending
  ON public.visit_score_recalc_queue (customer_user_id) WHERE (processed_at IS NULL);

ALTER TABLE public.score_recalc_queue       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visit_score_recalc_queue ENABLE ROW LEVEL SECURITY;

-- ── policies BROAD-STAFF: o estado de PROD ANTES do fix (é o furo a fechar) ────
CREATE POLICY "Staff can view recalc queue" ON public.score_recalc_queue
  FOR SELECT USING (has_role(auth.uid(), 'master'::public.app_role) OR has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY "Staff can insert recalc queue" ON public.score_recalc_queue
  FOR INSERT WITH CHECK (has_role(auth.uid(), 'master'::public.app_role) OR has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY "Staff can view visit recalc queue" ON public.visit_score_recalc_queue
  FOR SELECT USING (has_role(auth.uid(), 'master'::public.app_role) OR has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY "Staff can insert visit recalc queue" ON public.visit_score_recalc_queue
  FOR INSERT WITH CHECK (has_role(auth.uid(), 'master'::public.app_role) OR has_role(auth.uid(), 'employee'::public.app_role));

-- ── as views *_pending: security_invoker=on (como em prod) ────────────────────
CREATE VIEW public.score_recalc_pending WITH (security_invoker=on) AS
  SELECT id, customer_user_id, farmer_id, reason, source_call_id, enqueued_at, processed_at, error
  FROM public.score_recalc_queue q WHERE processed_at IS NULL ORDER BY enqueued_at;
CREATE VIEW public.visit_score_recalc_pending WITH (security_invoker=on) AS
  SELECT id, customer_user_id, farmer_id, reason, source_event_id, enqueued_at, processed_at, error
  FROM public.visit_score_recalc_queue q WHERE processed_at IS NULL ORDER BY enqueued_at;

-- ── writer REAL (SECURITY DEFINER) — pg_get_functiondef da prod ───────────────
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_owner uuid;
BEGIN
  IF NEW.customer_user_id IS NOT NULL AND NEW.visited_by IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason, source_event_id)
    VALUES
      (NEW.customer_user_id, COALESCE(v_owner, NEW.visited_by), 'visit_completed', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_route_visits_enqueue_visit_recalc
  AFTER INSERT ON public.route_visits FOR EACH ROW
  EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_visit();
SQL

# ── seeds + grants ────────────────────────────────────────────────────────────
# MASTER=3333 · EMPLOYEE/vendedor=2222 (é o owner) · cliente MASCARADO=aaaa (eligible=false)
# · cliente elegível=bbbb · cliente do teste de enqueue=cccc
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),
  ('22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc') ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('22222222-2222-2222-2222-222222222222','employee');

-- o vendedor 2222 é dono dos 3; aaaa está MASCARADO (eligible=false)
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222', false),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222', true),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', true);

INSERT INTO public.score_recalc_queue(customer_user_id, farmer_id, reason) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','call_ended'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','call_ended');
INSERT INTO public.visit_score_recalc_queue(customer_user_id, farmer_id, reason) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','22222222-2222-2222-2222-222222222222','visit_completed'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','22222222-2222-2222-2222-222222222222','visit_completed');

-- Espelha o DEFAULT PRIVILEGE do Supabase medido no relacl da prod:
--   anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm
-- (o objeto NASCE aberto — lição #1380). É justamente por isso que a RLS é a única
-- defesa aqui, e é ela que este harness prova. Conceder menos que a prod tornaria o
-- teste otimista; conceder a service_role é obrigatório: BYPASSRLS ignora a RLS mas
-- NÃO substitui o GRANT.
GRANT ALL ON public.score_recalc_queue, public.visit_score_recalc_queue TO authenticated, anon, service_role;
GRANT ALL ON public.score_recalc_pending, public.visit_score_recalc_pending TO authenticated, anon, service_role;
GRANT ALL ON public.route_visits TO authenticated, anon, service_role;
SQL

M_UID="33333333-3333-3333-3333-333333333333"
E_UID="22222222-2222-2222-2222-222222222222"

# ══════════════════════════════════════════════════════════════════════════════
# ANTES DO FIX — prova que o furo EXISTIA (sem isto, o teste não distingue
# "fechou o furo" de "nunca houve furo": o assert nasceria verde por acidente).
# ══════════════════════════════════════════════════════════════════════════════
echo "── ANTES do fix (estado de prod: broad-staff) ──"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.score_recalc_queue;" | tail -1)
eq "B1 employee LIA a fila de score (o furo)"        "$V" "2"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_queue;" | tail -1)
eq "B2 employee LIA a fila de visita (o furo)"       "$V" "2"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';" | tail -1)
eq "B3 employee LIA o vínculo MASCARADO (eligible=false)" "$V" "1"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_pending;" | tail -1)
eq "B4 employee LIA pela VIEW *_pending"             "$V" "2"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718100000_filas_recalc_rls_master_only.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── DEPOIS do fix ──"

# — o vendedor perde a leitura (o objetivo do FU3) —
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.score_recalc_queue;" | tail -1)
eq "A1 employee NÃO lê a fila de score"              "$V" "0"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_queue;" | tail -1)
eq "A2 employee NÃO lê a fila de visita"             "$V" "0"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';" | tail -1)
eq "A3 employee NÃO lê o vínculo MASCARADO"          "$V" "0"

# — a VIEW invoker=on herda a RLS: fechar a tabela fecha a view (#1246) —
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.score_recalc_pending;" | tail -1)
eq "A4 employee NÃO lê a VIEW score_recalc_pending"  "$V" "0"
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_pending;" | tail -1)
eq "A5 employee NÃO lê a VIEW visit_score_recalc_pending" "$V" "0"

# — anon nunca leu e segue sem ler —
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.visit_score_recalc_queue;" | tail -1)
eq "A6 anon NÃO lê"                                  "$V" "0"

# — master (auditor) e service_role (batch) SEGUEM lendo: o fix não cega a operação —
V=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT count(*) FROM public.score_recalc_queue;" | tail -1)
eq "A7 master SEGUE lendo a fila de score"           "$V" "2"
V=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_queue;" | tail -1)
eq "A8 master SEGUE lendo a fila de visita"          "$V" "2"
V=$(Pq -c "SET test.uid='$M_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_pending;" | tail -1)
eq "A9 master SEGUE lendo a VIEW"                    "$V" "2"
V=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.visit_score_recalc_queue;" | tail -1)
eq "A10 service_role (batch) SEGUE lendo"            "$V" "2"

# — o batch drena por UPDATE de processed_at: service_role tem de conseguir —
# mede o EFEITO (a linha ficou marcada), não o command tag: `| tail -1` num UPDATE captura
# "UPDATE 1", não o valor — um assert escrito contra o tag passaria sem provar o efeito.
Pq -c "SET ROLE service_role; UPDATE public.visit_score_recalc_queue SET processed_at=now() WHERE customer_user_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND processed_at IS NOT NULL;")
eq "A11 service_role DRENA (marca processed_at)"     "$V" "1"

# — o enqueue por trigger SECDEF sobrevive à policy INSERT estreitada (premissa (c)) —
P -q -c "SET test.uid='$E_UID'; SET ROLE authenticated; INSERT INTO public.route_visits(customer_user_id, visited_by) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','$E_UID');"
V=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';")
eq "A12 enqueue por trigger SECDEF CONTINUA funcionando" "$V" "1"

# — mas o employee não injeta linha na fila à mão (BFLA de escrita fechado) —
R=$(P -tA 2>&1 <<SQL
SET test.uid='$E_UID';
SET ROLE authenticated;
DO \$\$
BEGIN
  INSERT INTO public.score_recalc_queue(customer_user_id, farmer_id, reason)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','$E_UID','injetado_a_mao');
  RAISE EXCEPTION 'INSERT_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'INSERT_BARRADO_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *INSERT_BARRADO_OK*) ok "A13 employee NÃO injeta linha na fila (42501)" ;; *) bad "A13 — veio: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — devolve a policy BROAD-STAFF: A1/A3 têm de voltar a ler (senão não provavam nada)
P -q <<'SQL'
DROP POLICY IF EXISTS "Master can view recalc queue" ON public.score_recalc_queue;
CREATE POLICY "Staff can view recalc queue" ON public.score_recalc_queue
  FOR SELECT USING (has_role(auth.uid(), 'master'::public.app_role) OR has_role(auth.uid(), 'employee'::public.app_role));
SQL
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.score_recalc_queue;" | tail -1)
if [ "$V" = "2" ]; then ok "F1 broad-staff restaurada → employee LÊ de novo (A1 tem dente)"
else bad "F1 sabotei a policy e o employee AINDA não lê ($V) → A1 é fraco"; fi
P -q -f "$MIG"   # restaura

# F2 — desliga o security_invoker da VIEW: ela passa a ler como OWNER e VAZA apesar do fix
#      (prova que o invoker=on é o elo — lição #1246/#1375: a folha é quem fecha)
P -q <<'SQL'
ALTER VIEW public.visit_score_recalc_pending SET (security_invoker=off);
SQL
V=$(Pq -c "SET test.uid='$E_UID'; SET ROLE authenticated; SELECT count(*) FROM public.visit_score_recalc_pending;" | tail -1)
if [ "$V" != "0" ]; then ok "F2 view invoker=off VAZA ($V) → A5 depende mesmo do invoker=on"
else bad "F2 desliguei o invoker e a view seguiu fechada → A5 não prova o invoker"; fi
P -q -c "ALTER VIEW public.visit_score_recalc_pending SET (security_invoker=on);"

# F3 — tira o SECURITY DEFINER do trigger: o enqueue passa a rodar como o employee e a
#      policy INSERT master-only o barra. Prova que A12 só é verde POR CAUSA do SECDEF —
#      é esta a premissa que autoriza estreitar o INSERT.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_visit()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'   -- SEM SECURITY DEFINER
AS $function$
DECLARE v_owner uuid;
BEGIN
  IF NEW.customer_user_id IS NOT NULL AND NEW.visited_by IS NOT NULL THEN
    SELECT owner_user_id INTO v_owner
      FROM public.carteira_assignments WHERE customer_user_id = NEW.customer_user_id;
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason, source_event_id)
    VALUES
      (NEW.customer_user_id, COALESCE(v_owner, NEW.visited_by), 'visit_completed', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
SQL
if P -q -c "SET test.uid='$E_UID'; SET ROLE authenticated; INSERT INTO public.route_visits(customer_user_id, visited_by) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','$E_UID');" >/dev/null 2>&1; then
  bad "F3 tirei o SECDEF e o enqueue AINDA passou → A12 não prova a premissa (c)"
else
  ok "F3 sem SECDEF o enqueue é barrado → A12 depende mesmo do SECURITY DEFINER"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

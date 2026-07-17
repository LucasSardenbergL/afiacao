#!/usr/bin/env bash
# Teste PG17 do LEASE do carteira-rebuild (fecha o mosaico rebuild × rebuild) + hardening do Codex challenge.
# Migration: supabase/migrations/20260713160000_carteira_rebuild_lease.sql
#   D1  lease ausente → claim = true (cria 'syncing')
#   D2/D2b claim enquanto 'syncing' recente/6min → false (serializa 2 writers = o furo fechado)
#   D3  claim 'syncing' STALE (>15min) → true (auto-libera; prova comparação via now() do BANCO)
#   D4  claim 'complete' → true (reivindica)
#   D6  finalize run_id DONO → true + status='complete'
#   D7  finalize run_id ALHEIO → false + status fica 'syncing' (ownership)
#   D7b finalize sobre 'complete' posto POR FORA (fase='inicio') → false (não re-finaliza estado alheio)
#   D8  IDEMPOTÊNCIA (Codex P1): finalize repetido do MESMO run → true, true; alheio sobre complete → false
#   D9  VALIDAÇÃO (Codex): status ∉ {complete,error} → 22023; run_id vazio → 22004
#   D5  REVOKE: anon E authenticated NÃO executam; service_role executa (claim + finalize)
#   RLS (Codex P1): employee NÃO adultera a linha carteira_rebuild (policy RESTRICTIVE); toca outras entity_type
#   C1  CONCORRÊNCIA REAL robusta: 8 claims simultâneos → 0 workers falham, EXATAMENTE 1 't' e 7 'f'
#   F1/F2/F3 falsificação: WHERE do claim / ownership do finalize / policy RESTRICTIVE
# Base: db/test-claim-full-sync.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="carteira-rebuild-lease"
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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
# auth.uid() lê o GUC test.uid (impersonação de RLS); service_role BYPASSRLS (espelha o admin do Supabase).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1: ambiente Supabase real p/ sync_state — RLS on, policy permissiva "Staff can manage", GRANTs,
#            app_role/has_role/user_roles (a policy os usa). A migration ADICIONA as policies RESTRICTIVE. ──
EMP='22222222-2222-2222-2222-222222222222'
P -q <<SQL
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(uid uuid, r public.app_role) RETURNS boolean LANGUAGE sql STABLE AS \$\$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=uid AND role=r) \$\$;
INSERT INTO public.user_roles(user_id, role) VALUES ('$EMP','employee');

CREATE TABLE public.sync_state (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entity_type text NOT NULL,
  account text DEFAULT 'vendas'::text NOT NULL,
  last_sync_at timestamptz, last_page integer DEFAULT 0, last_cursor text,
  total_synced integer DEFAULT 0, status text DEFAULT 'idle'::text, error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage sync state" ON public.sync_state FOR ALL
  USING (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'));
-- concede TRUNCATE (como em prod: authenticated TEM) → a migration REVOGA → o assert D5 TRUNCATE prova o dente
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.sync_state TO authenticated, anon, service_role;
-- a policy permissiva avalia has_role() = SELECT em user_roles com os privilégios do CALLER → conceda tb (assert-patterns.md)
GRANT SELECT ON public.user_roles TO authenticated, anon, service_role;
SQL

# ── ZONA 2: aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260713160000_carteira_rebuild_lease.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

CLEAR() { P -q -c "DELETE FROM public.sync_state WHERE entity_type='carteira_rebuild';" >/dev/null; }
STATUS() { Pq -c "SELECT status FROM public.sync_state WHERE entity_type='carteira_rebuild' AND account='global';"; }

echo "── asserts: lease ──"
CLEAR
eq "D1 claim livre"            "$(Pq -c "SELECT public.claim_carteira_rebuild('run-A');")" "t"
eq "D1 status vira syncing (RPC escreve a chave APESAR da policy RESTRICTIVE)" "$(STATUS)" "syncing"
eq "D2 claim fresco negado"    "$(Pq -c "SELECT public.claim_carteira_rebuild('run-B');")" "f"
P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '6 minutes' WHERE entity_type='carteira_rebuild';" >/dev/null
eq "D2b claim 6min (<TTL) negado" "$(Pq -c "SELECT public.claim_carteira_rebuild('run-B');")" "f"
P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '16 minutes' WHERE entity_type='carteira_rebuild';" >/dev/null
eq "D3 claim stale>15min auto-libera" "$(Pq -c "SELECT public.claim_carteira_rebuild('run-C');")" "t"
P -q -c "UPDATE public.sync_state SET status='complete', last_sync_at=now() WHERE entity_type='carteira_rebuild';" >/dev/null
eq "D4 claim reivindica complete" "$(Pq -c "SELECT public.claim_carteira_rebuild('run-D');")" "t"

echo "── asserts: finalize (ownership + idempotência + validação) ──"
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('run-E');" >/dev/null
eq "D6 finalize dono"          "$(Pq -c "SELECT public.finalizar_carteira_rebuild('run-E','complete');")" "t"
eq "D6 status complete"        "$(STATUS)" "complete"
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('run-F');" >/dev/null
eq "D7 finalize alheio negado" "$(Pq -c "SELECT public.finalizar_carteira_rebuild('run-ALHEIO','complete');")" "f"
eq "D7 status fica syncing"    "$(STATUS)" "syncing"
P -q -c "UPDATE public.sync_state SET status='complete' WHERE entity_type='carteira_rebuild';" >/dev/null   # 'complete' por FORA (fase segue 'inicio')
eq "D7b finalize sobre complete-alheio negado" "$(Pq -c "SELECT public.finalizar_carteira_rebuild('run-F','complete');")" "f"
# D8 idempotência
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('idem-1');" >/dev/null
eq "D8 finalize 1a vez"        "$(Pq -c "SELECT public.finalizar_carteira_rebuild('idem-1','complete');")" "t"
eq "D8 finalize IDEMPOTENTE (2a vez, mesmo run)" "$(Pq -c "SELECT public.finalizar_carteira_rebuild('idem-1','complete');")" "t"
eq "D8 status segue complete"  "$(STATUS)" "complete"
eq "D8 alheio sobre complete → false" "$(Pq -c "SELECT public.finalizar_carteira_rebuild('OUTRO','complete');")" "f"
# D9 validação (SQLSTATE + re-raise)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN PERFORM public.finalizar_carteira_rebuild('x','LIXO'); RAISE EXCEPTION 'NAO_VALIDOU';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'VALIDOU_STATUS'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *VALIDOU_STATUS*) ok "D9 finalize rejeita status invalido (22023)" ;; *) bad "D9 status — veio: $R" ;; esac
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN PERFORM public.claim_carteira_rebuild(''); RAISE EXCEPTION 'NAO_VALIDOU';
EXCEPTION WHEN null_value_not_allowed THEN RAISE NOTICE 'VALIDOU_RUNID'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *VALIDOU_RUNID*) ok "D9 claim rejeita run_id vazio (22004)" ;; *) bad "D9 runid — veio: $R" ;; esac
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN PERFORM public.finalizar_carteira_rebuild('x', NULL); RAISE EXCEPTION 'NAO_VALIDOU';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'VALIDOU_NULL'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *VALIDOU_NULL*) ok "D9 finalize rejeita status NULL (22023 — NULL NOT IN e' NULL)" ;; *) bad "D9 NULL — veio: $R" ;; esac

echo "── asserts: REVOKE (anon + authenticated barrados; service_role ok) ──"
eq "D5 claim anon revogado"          "$(Pq -c "SELECT has_function_privilege('anon','public.claim_carteira_rebuild(text)','EXECUTE');")" "f"
eq "D5 claim authenticated revogado" "$(Pq -c "SELECT has_function_privilege('authenticated','public.claim_carteira_rebuild(text)','EXECUTE');")" "f"
eq "D5 claim service_role ok"        "$(Pq -c "SELECT has_function_privilege('service_role','public.claim_carteira_rebuild(text)','EXECUTE');")" "t"
eq "D5 finalize authenticated revogado" "$(Pq -c "SELECT has_function_privilege('authenticated','public.finalizar_carteira_rebuild(text,text)','EXECUTE');")" "f"
eq "D5 finalize service_role ok"     "$(Pq -c "SELECT has_function_privilege('service_role','public.finalizar_carteira_rebuild(text,text)','EXECUTE');")" "t"
eq "D5 TRUNCATE authenticated revogado" "$(Pq -c "SELECT has_table_privilege('authenticated','public.sync_state','TRUNCATE');")" "f"
eq "D5 TRUNCATE anon revogado"          "$(Pq -c "SELECT has_table_privilege('anon','public.sync_state','TRUNCATE');")" "f"

echo "── asserts: RLS (employee NÃO adultera o lease; policy é cirúrgica) ──"
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('rls-seed');" >/dev/null
R=$(P -tA 2>&1 -v emp="$EMP" <<'SQL'
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  UPDATE public.sync_state SET status='hacked' WHERE entity_type='carteira_rebuild';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=0 THEN RAISE NOTICE 'RLS_BLOQUEOU'; ELSE RAISE NOTICE 'RLS_FUROU_%', n; END IF;
END $$;
SQL
); case "$R" in *RLS_BLOQUEOU*) ok "RLS: employee NAO adultera lease carteira_rebuild (0 linhas)" ;; *) bad "RLS FUROU — veio: $R" ;; esac
eq "RLS status intacto após tentativa" "$(STATUS)" "syncing"
# INSERT direto da chave por employee → WITH CHECK viola (42501 insufficient_privilege)
R=$(P -tA 2>&1 -v emp="$EMP" <<'SQL'
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.sync_state(entity_type, account, status) VALUES ('carteira_rebuild','g2','syncing');
  RAISE NOTICE 'INSERT_FUROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INSERT_BLOQUEOU'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *INSERT_BLOQUEOU*) ok "RLS: employee NAO faz INSERT da chave (WITH CHECK)" ;; *) bad "RLS INSERT — veio: $R" ;; esac
# DELETE da linha carteira_rebuild por employee → USING filtra (0 linhas)
R=$(P -tA 2>&1 -v emp="$EMP" <<'SQL'
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  DELETE FROM public.sync_state WHERE entity_type='carteira_rebuild';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=0 THEN RAISE NOTICE 'DELETE_BLOQUEOU'; ELSE RAISE NOTICE 'DELETE_FUROU_%', n; END IF;
END $$;
SQL
); case "$R" in *DELETE_BLOQUEOU*) ok "RLS: employee NAO faz DELETE da chave (USING)" ;; *) bad "RLS DELETE — veio: $R" ;; esac
R=$(P -tA 2>&1 -v emp="$EMP" <<'SQL'
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  INSERT INTO public.sync_state(entity_type, account, status) VALUES ('outra_entidade','x','idle');
  UPDATE public.sync_state SET status='ok2' WHERE entity_type='outra_entidade';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RAISE NOTICE 'RLS_PERMITIU_OUTRA'; ELSE RAISE NOTICE 'RLS_BLOQUEOU_OUTRA_%', n; END IF;
END $$;
SQL
); case "$R" in *RLS_PERMITIU_OUTRA*) ok "RLS: employee toca OUTRAS entity_type (policy cirurgica)" ;; *) bad "RLS bloqueou demais — veio: $R" ;; esac

echo "── asserts: concorrência real robusta (Codex P2) ──"
CLEAR
CDIR="$(mktemp -d /tmp/claim-conc.XXXXXX)"; pids=()
for i in $(seq 1 8); do
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA \
    -c "SELECT public.claim_carteira_rebuild('conc-$i');" > "$CDIR/c$i.out" 2>"$CDIR/c$i.err" &
  pids+=($!)
done
fail_workers=0; for pid in "${pids[@]}"; do wait "$pid" || fail_workers=$((fail_workers+1)); done
TRUES="$(cat "$CDIR"/c*.out | grep -c '^t$' || true)"
FALSES="$(cat "$CDIR"/c*.out | grep -c '^f$' || true)"
eq "C1 nenhum worker falhou"   "$fail_workers" "0"
eq "C1 exatamente 1 vence"     "$TRUES" "1"
eq "C1 os outros 7 perdem (f)" "$FALSES" "7"
rm -rf "$CDIR"

# ── ZONA 5: FALSIFICAÇÃO ──
echo "── falsificação ──"
# F1: WHERE do claim removido → 2º claim no lease fresco PASSA (D2 tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.claim_carteira_rebuild(p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_claimed boolean := false; BEGIN
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('carteira_rebuild','global','syncing',now(),0,jsonb_build_object('run_id',p_run_id,'fase','inicio'),now())
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status='syncing', last_sync_at=now(), metadata=jsonb_build_object('run_id',p_run_id,'fase','inicio'), updated_at=now()
  RETURNING true INTO v_claimed;   -- WHERE REMOVIDO
  RETURN COALESCE(v_claimed,false); END $$;
SQL
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('sab-1');" >/dev/null
case "$(Pq -c "SELECT public.claim_carteira_rebuild('sab-2');")" in
  t) ok "F1 sem o WHERE o 2º claim fresco PASSOU (D2 tem dente)" ;; *) bad "F1 D2 fraco" ;; esac
P -q -f "$MIG" >/dev/null

# F2: ownership do finalize removido → finalize alheio PASSA (D7 tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.finalizar_carteira_rebuild(p_run_id text, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_done boolean := false; BEGIN
  UPDATE public.sync_state SET status=p_status, last_sync_at=now(), updated_at=now()
   WHERE entity_type='carteira_rebuild' AND account='global' AND status='syncing'
  RETURNING true INTO v_done;   -- OWNERSHIP (run_id) REMOVIDO
  RETURN COALESCE(v_done,false); END $$;
SQL
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('owner-1');" >/dev/null
case "$(Pq -c "SELECT public.finalizar_carteira_rebuild('ALHEIO','complete');")" in
  t) ok "F2 sem ownership o finalize alheio PASSOU (D7 tem dente)" ;; *) bad "F2 D7 fraco" ;; esac
P -q -f "$MIG" >/dev/null

# F3: policy RESTRICTIVE de UPDATE removida → employee ADULTERA o lease (o assert RLS tem dente)
P -q -c "DROP POLICY carteira_rebuild_lease_no_update ON public.sync_state;"
CLEAR; Pq -c "SELECT public.claim_carteira_rebuild('f3');" >/dev/null
R=$(P -tA 2>&1 -v emp="$EMP" <<'SQL'
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  UPDATE public.sync_state SET status='hacked' WHERE entity_type='carteira_rebuild';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n>0 THEN RAISE NOTICE 'SABOTAGEM_FUROU_%', n; ELSE RAISE NOTICE 'AINDA_BLOQUEIA'; END IF;
END $$;
SQL
); case "$R" in *SABOTAGEM_FUROU*) ok "F3 sem a policy o employee adultera o lease (RLS tem dente)" ;; *) bad "F3 RLS assert fraco — veio: $R" ;; esac
P -q -f "$MIG" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE ($PASS asserts)"

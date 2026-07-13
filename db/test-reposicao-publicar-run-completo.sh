#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — reposicao_publicar_run_completo (publicação diferida atômica)    ║
# ║  Migration: supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql║
# ║  Rode: bash db/test-reposicao-publicar-run-completo.sh > /tmp/t.log 2>&1; echo $?
# ║        (NÃO pipe pra tail — engole o exit code)                                 ║
# ║                                                                                ║
# ║  Fecha os 6 P1 do Codex (design §3b) + o re-challenge xhigh 2026-07-12:         ║
# ║   A  volume_ok robusto (P1#5): bootstrap→null, exclui truncados/degenerados.    ║
# ║   B  last_seen SÓ em run VÁLIDO (P1#1) + anti-regressão temporal (P1#4) +        ║
# ║      atomicidade marcador+last_seen (falha no UPDATE reverte o INSERT).          ║
# ║   C  lock por empresa presente (P1#4).                                          ║
# ║   D  base NÃO-forjável (P1#6): RPC service_role-only, RLS sem policy de escrita. ║
# ║  Falsifica (Lei de Ferro #3): sabota cada guard → exige VAZAMENTO (dente).       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5476}"
SLUG="reposicao-publicar-run"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260712193000_reposicao_pedidos_compra_run.sql"

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

# ── base Supabase: roles, schema auth, auth.uid()/role() via GUC ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
-- O Supabase concede grants AMPLOS a authenticated/anon em tabelas do schema public (default privileges do
-- bootstrap, fora do snapshot); a RLS + o REVOKE da migration são a REAL camada de controle. Replicar aqui
-- (afeta tabelas criadas DEPOIS, i.e. a da migration) p/ a RLS/REVOKE serem o que decide — não a ausência de
-- grant. Isto fortalece o P1 #6: prova que a escrita é barrada MESMO com o grant amplo do Supabase.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migration referencia mas não existe no PG17 vazio)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id uuid DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  status text DEFAULT 'CRIADO',
  updated_at timestamptz DEFAULT now(),
  UNIQUE (empresa, omie_codigo_pedido)
);
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT commercial_role FROM public.commercial_roles WHERE user_id=_user_id LIMIT 1 $fn$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
  SELECT public.has_role(_uid,'master')
    OR (public.has_role(_uid,'employee')
        AND public.get_commercial_role(_uid) IN ('gerencial','estrategico','super_admin'));
$fn$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei de Ferro #1)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS (POs de acompanhamento + usuários de teste)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- âncora do design: 1073 latente, 1115 tratado, 9999 nunca visto, 5000 COLACOR isolado
INSERT INTO public.purchase_orders_tracking (empresa, omie_codigo_pedido) VALUES
  ('OBEN', 1073), ('OBEN', 1115), ('OBEN', 9999), ('COLACOR', 5000);
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master (staff)
  ('44444444-4444-4444-4444-444444444444');  -- customer sem role (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master');
SQL

# helper: limpa marcadores + last_seen e semeia N runs OBEN volume_ok=true com ids=$1 (baseline saudável)
seed_oben() { # $1 = ids_distintos do baseline
  P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
UPDATE public.purchase_orders_tracking SET last_seen_pedidos_full_run_id=NULL, last_seen_pedidos_full_at=NULL;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',$1,true,'ok', now()-interval '3h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',$1,true,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',$1,true,'ok', now()-interval '1h');
SQL
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── Bloco A: volume_ok robusto (Codex P1 #5) ──"
# A1 — BOOTSTRAP: 3 runs DEGENERADOS (ids=0) EXCLUÍDOS do baseline → volume_ok NULL (NUNCA true).
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '3h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[], now()) IS NULL;" | tail -1)
eq "A1 bootstrap (baseline degenerado) → volume_ok NULL" "$V" "t"

# A2 — BASELINE saudável (3 runs ids=100) + run ids=100 (>= 0.9*100=90) → true.
P -q <<'SQL'
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '3h'),
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '2h'),
 (gen_random_uuid(),'COLACOR','2025-07-01','2026-11-01',100,true,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g), now());" | tail -1)
eq "A2 baseline 100, run 100 → volume_ok true" "$V" "t"

# A3 — VOLUME BAIXO: baseline 100, run 50 (< 90) → false.
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,50) g), now());" | tail -1)
eq "A3 baseline 100, run 50 → volume_ok false" "$V" "f"

# A4 — EXCLUI volume_ok=false do baseline: 1 false(10)+1 true(100), run 60 → baseline=100 → 60<90 → false.
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id, empresa, janela_de, janela_ate, ids_distintos, volume_ok, status, finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g), now());" | tail -1)
eq "A4 baseline exclui volume_ok=false (100, não 55) → false" "$V" "f"

echo "── Bloco B: last_seen só em run VÁLIDO + anti-regressão + atomicidade (Codex P1 #1/#4) ──"
# B1 — run VÁLIDO (baseline 2, ids 2) carimba last_seen dos POs vistos; PO não-visto (9999) fica NULL.
seed_oben 2
RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
VOK=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID','2025-07-01','2026-11-01',ARRAY[1073,1115]::bigint[], now());" | tail -1)
eq "B1a run baseline 2 / ids 2 → volume_ok true" "$VOK" "t"
SEEN=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE omie_codigo_pedido IN (1073,1115) AND last_seen_pedidos_full_run_id='$RID';" | tail -1)
eq "B1b run válido carimba os POs vistos" "$SEEN" "2"
UNSEEN=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=9999 AND last_seen_pedidos_full_run_id IS NULL;" | tail -1)
eq "B1c PO não-visto continua sem last_seen" "$UNSEEN" "1"

# Bg — run INVÁLIDO (volume_ok=false, baseline 100 / ids 1) NÃO carimba last_seen (Codex P1 #1).
seed_oben 100
RIDF=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
VOK=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RIDF','2025-07-01','2026-11-01',ARRAY[1073]::bigint[], now());" | tail -1)
eq "Bg baseline 100 / ids 1 → volume_ok false" "$VOK" "f"
NC=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=1073 AND last_seen_pedidos_full_run_id IS NULL;" | tail -1)
eq "Bg run truncado (volume_ok=false) NÃO carimba last_seen" "$NC" "1"

# Bgn — bootstrap (volume_ok=null, sem baseline) NÃO carimba last_seen.
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run;
UPDATE public.purchase_orders_tracking SET last_seen_pedidos_full_run_id=NULL, last_seen_pedidos_full_at=NULL;
SQL
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[], now());" >/dev/null
NC=$(Pq -c "SELECT count(*) FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=1073 AND last_seen_pedidos_full_run_id IS NULL;" | tail -1)
eq "Bgn bootstrap (volume_ok=null) NÃO carimba last_seen" "$NC" "1"

# Bt — ANTI-REGRESSÃO (Codex P1 #4): run VÁLIDO mais VELHO (iniciado_em menor) NÃO sobrescreve last_seen novo.
seed_oben 2
RID_NEW=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
RID_OLD=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID_NEW','2025-07-01','2026-11-01',ARRAY[1073,1115]::bigint[], '2026-07-12T10:00:00+00:00'::timestamptz);" >/dev/null
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID_OLD','2025-07-01','2026-11-01',ARRAY[1073,1115]::bigint[], '2026-07-12T09:00:00+00:00'::timestamptz);" >/dev/null
KEPT=$(Pq -c "SELECT last_seen_pedidos_full_run_id='$RID_NEW' FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=1073;" | tail -1)
eq "Bt run velho NÃO sobrescreve last_seen mais novo (anti-regressão)" "$KEPT" "t"

# B2 — ATOMICIDADE: se o UPDATE do last_seen falhar, o INSERT do marcador REVERTE (mesmo commit). Precisa run
#      VÁLIDO (senão o UPDATE nem roda). Trigger sabotador com SQLSTATE própria (ZZ999); a RPC deve levantá-la.
seed_oben 2
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.sabota_update_teste() RETURNS trigger LANGUAGE plpgsql AS
  $t$ BEGIN RAISE EXCEPTION 'sabotagem no UPDATE' USING ERRCODE='ZZ999'; END $t$;
CREATE TRIGGER trg_sabota BEFORE UPDATE ON public.purchase_orders_tracking
  FOR EACH ROW EXECUTE FUNCTION public.sabota_update_teste();
SQL
NB=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)  # baseline = 3
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[], now());
  RAISE EXCEPTION 'RPC_NAO_FALHOU';
EXCEPTION
  WHEN sqlstate 'ZZ999' THEN RAISE NOTICE 'SABOTA_ESPERADA';  -- só a falha do trigger é aceita
  WHEN OTHERS THEN RAISE;                                     -- qualquer outra propaga (anti-teatro)
END $$;
SQL
)
case "$R" in *SABOTA_ESPERADA*) ok "B2a a RPC levanta a SQLSTATE esperada (ZZ999) do UPDATE";; *) bad "B2a — veio: $R";; esac
NA=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "B2b falha no UPDATE reverte o INSERT do marcador (atômico)" "$NA" "$NB"
P -q <<'SQL'
DROP TRIGGER trg_sabota ON public.purchase_orders_tracking;
DROP FUNCTION public.sabota_update_teste();
SQL

echo "── Bloco C: lock presente (Codex P1 #4) ──"
HASLOCK=$(Pq -c "SELECT pg_get_functiondef('public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[],timestamptz)'::regprocedure) LIKE '%pg_advisory_xact_lock%';" | tail -1)
eq "C1 RPC adquire advisory lock por empresa" "$HASLOCK" "t"

echo "── Bloco D: base NÃO-forjável / service_role-only (Codex P1 #6) ──"
# D1 — authenticated NEM INVOCA a RPC (42501 no privilégio EXECUTE, antes do corpo).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[], now());
  RAISE EXCEPTION 'INVOCOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RPC_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *RPC_DENY_OK*) ok "D1 authenticated não invoca a RPC (42501)";; *) bad "D1 — veio: $R";; esac

# D2 — service_role INVOCA (prova pelo EFEITO: marcador inserido). NÃO usar `rpc() IS NOT NULL OR true`
#      (constant-fold X OR true → true não chamaria a RPC volátil = teatro).
P -q -c "DELETE FROM public.reposicao_pedidos_compra_run;" >/dev/null
Pq -c "SET ROLE service_role; SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[], now());" >/dev/null
D2N=$(Pq -tAc "SELECT count(*) FROM public.reposicao_pedidos_compra_run;")
eq "D2 service_role invoca a RPC (marcador inserido pelo definer)" "$D2N" "1"

# D3 — authenticated NÃO faz INSERT direto (RLS nega, sem policy de escrita).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',999,true,'ok');
  RAISE EXCEPTION 'INSERIU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INSERT_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *INSERT_DENY_OK*) ok "D3 authenticated não forja marcador (RLS nega INSERT)";; *) bad "D3 — veio: $R";; esac

# D4 — SELECT: staff vê, não-staff não vê. (D2 deixou 1 marcador OBEN na tabela.)
SS=$(Pq -c "SET test.role='authenticated'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
case "$SS" in 0) bad "D4a staff deveria ver linhas, veio 0";; *) ok "D4a staff vê o marcador ($SS)";; esac
NS=$(Pq -c "SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "D4b customer (não-staff) não vê nada (RLS SELECT)" "$NS" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei de Ferro #3: sabota → exige VAZAMENTO)
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"
# recria a RPC com um corpo sabotado (só o miolo muda; assinatura/segurança iguais). $1 = variação.
saboto_rpc() { # $1 = 'sem_exclui_false' | 'canario' | 'sem_gate_volume' | 'sem_guard_temporal'
  local baseline_where update_gate update_guard volok
  baseline_where="AND ids_distintos>0 AND volume_ok IS NOT FALSE"
  volok="IF v_base IS NULL OR v_base<=0 THEN v_ok:=NULL; ELSE v_ok:=(v_ids::numeric>=0.9*v_base); END IF;"
  update_gate="v_ok IS TRUE"
  update_guard="AND (last_seen_pedidos_full_at IS NULL OR last_seen_pedidos_full_at < p_iniciado_em)"
  case "$1" in
    sem_exclui_false)  baseline_where="AND ids_distintos>0" ;;                                   # P1#5
    canario)           baseline_where=""; volok="v_ok:=(v_ids::numeric>=0.9*COALESCE(v_base,0));" ;; # P1#5
    sem_gate_volume)   update_gate="v_ids>0" ;;                                                  # P1#1
    sem_guard_temporal) update_guard="" ;;                                                       # P1#4
  esac
  P -q <<SQL
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(p_empresa text,p_run_id uuid,p_janela_de date,p_janela_ate date,p_ids bigint[],p_iniciado_em timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS \$\$
DECLARE v_empresa public.empresa_reposicao:=upper(btrim(p_empresa))::public.empresa_reposicao; v_ids int; v_base numeric; v_ok boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:'||lower(btrim(p_empresa))));
  SELECT count(DISTINCT x) INTO v_ids FROM unnest(COALESCE(p_ids,ARRAY[]::bigint[])) x WHERE x>0;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos) INTO v_base FROM (
    SELECT ids_distintos FROM public.reposicao_pedidos_compra_run
    WHERE empresa=v_empresa AND status='ok' $baseline_where
    ORDER BY finalizado_em DESC LIMIT 5) r;
  $volok
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,iniciado_em)
    VALUES (p_run_id,v_empresa,p_janela_de,p_janela_ate,v_ids,v_ok,'ok',p_iniciado_em);
  IF $update_gate THEN
    UPDATE public.purchase_orders_tracking SET last_seen_pedidos_full_run_id=p_run_id, last_seen_pedidos_full_at=p_iniciado_em
     WHERE empresa=v_empresa AND omie_codigo_pedido = ANY(p_ids) AND omie_codigo_pedido>0 $update_guard;
  END IF;
  RETURN v_ok; END \$\$;
SQL
}

# F1 (P1#5) — baseline SEM excluir volume_ok=false → A4 vaza (dá true onde esperava false).
saboto_rpc sem_exclui_false
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g), now());" | tail -1)
case "$V" in t) ok "F1 sem excluir volume_ok=false o baseline afunda p/ 55 e A4 VAZA (true) — A4 tem dente";; *) bad "F1 sabotei o baseline e A4 não vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# F2 (P1#5) — canário: incluir ids=0 + baseline 0 → 0>=0 → true.
saboto_rpc canario
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073,1115]::bigint[], now());" | tail -1)
case "$V" in t) ok "F2 canário [0,0]→true reaparece com a RPC sabotada — A1 tem dente";; *) bad "F2 sabotei o bootstrap e A1 não vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# Fg (P1#1) — gate SEM "volume_ok IS TRUE" (carimba se ids>0) → run truncado carimba → Bg vaza.
saboto_rpc sem_gate_volume
seed_oben 100
RIDF=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RIDF','2025-07-01','2026-11-01',ARRAY[1073]::bigint[], now());" >/dev/null
LEAK=$(Pq -c "SELECT last_seen_pedidos_full_run_id='$RIDF' FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=1073;" | tail -1)
case "$LEAK" in t) ok "Fg sem o gate volume_ok o run truncado CARIMBA last_seen — Bg tem dente";; *) bad "Fg removi o gate e Bg não vazou ($LEAK)";; esac
P -q -f "$MIG" >/dev/null

# Ft (P1#4) — UPDATE SEM o guard "< p_iniciado_em" → run velho sobrescreve o novo → Bt vaza.
saboto_rpc sem_guard_temporal
seed_oben 2
RID_NEW=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
RID_OLD=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID_NEW','2025-07-01','2026-11-01',ARRAY[1073,1115]::bigint[], '2026-07-12T10:00:00+00:00'::timestamptz);" >/dev/null
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID_OLD','2025-07-01','2026-11-01',ARRAY[1073,1115]::bigint[], '2026-07-12T09:00:00+00:00'::timestamptz);" >/dev/null
LEAK=$(Pq -c "SELECT last_seen_pedidos_full_run_id='$RID_OLD' FROM public.purchase_orders_tracking WHERE omie_codigo_pedido=1073;" | tail -1)
case "$LEAK" in t) ok "Ft sem o guard temporal o run VELHO sobrescreve o novo — Bt tem dente";; *) bad "Ft removi o guard e Bt não vazou ($LEAK)";; esac
P -q -f "$MIG" >/dev/null

# F3 (P1#6) — GRANT EXECUTE a authenticated → D1 deixa de barrar.
P -q -c "GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[],timestamptz) TO authenticated;" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-11-01', ARRAY[1073]::bigint[], now());
  RAISE NOTICE 'INVOCOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *INVOCOU_VAZOU*) ok "F3 com GRANT a authenticated a RPC é invocável — D1 tem dente";; *) bad "F3 dei GRANT e D1 não vazou ($R)";; esac
P -q -f "$MIG" >/dev/null

# F4 (P1#6) — policy INSERT authenticated + grant → D3 deixa de barrar.
P -q <<'SQL'
GRANT INSERT ON public.reposicao_pedidos_compra_run TO authenticated;
CREATE POLICY forja_ins ON public.reposicao_pedidos_compra_run FOR INSERT TO authenticated WITH CHECK (true);
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (gen_random_uuid(),'OBEN','2025-07-01','2026-11-01',999,true,'ok');
  RAISE NOTICE 'FORJOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *FORJOU_VAZOU*) ok "F4 com policy INSERT authenticated a base vira forjável — D3 tem dente";; *) bad "F4 abri INSERT e D3 não vazou ($R)";; esac
P -q <<'SQL'
DROP POLICY IF EXISTS forja_ins ON public.reposicao_pedidos_compra_run;
REVOKE INSERT ON public.reposicao_pedidos_compra_run FROM authenticated;
SQL

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — reposicao_publicar_run_completo (publicação diferida atômica)    ║
# ║  Migration: supabase/migrations/20260713040000_reposicao_pedidos_compra_run.sql║
# ║  Rode: bash db/test-reposicao-publicar-run-completo.sh > /tmp/t.log 2>&1; echo $?
# ║        (NÃO pipe pra tail — engole o exit code)                                 ║
# ║                                                                                ║
# ║  Fecha os 6 P1 do design + 3 Codex challenge xhigh (2026-07-12/13):              ║
# ║   A  volume_ok robusto: bootstrap→null, exclui truncados/degenerados, baseline  ║
# ║      por MESMA largura de janela (Aw) + últimos 10d (Ai); ids=0 em run LIMPO =   ║
# ║      empresa vazia → VÁLIDO (Az) — anti-latch/anti-starvation.                   ║
# ║   B  last_seen em tabela DEDICADA service_role-only, SÓ em run VÁLIDO (P1#1),    ║
# ║      anti-regressão por SEQ lógica (Bt, não wall-clock), atomicidade.            ║
# ║   C  lock EFETIVO em RUNTIME: bloqueia OBEN sob lock tomado (C2), COLACOR passa  ║
# ║      (C3, serializa POR EMPRESA) — não é só grep.                                ║
# ║   D  base NÃO-forjável: RPC service_role-only, RLS sem policy de escrita; nem    ║
# ║      INSERT nem UPDATE forjam o last_seen (D5/D6).                               ║
# ║  Falsifica: sabota cada guard → exige VAZAMENTO (dente). 37 asserts.             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5476}"
SLUG="reposicao-publicar-run"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260713040000_reposicao_pedidos_compra_run.sql"

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
-- Supabase concede grants amplos a authenticated/anon em tabelas do schema public (default privileges do
-- bootstrap, fora do snapshot); a RLS + o REVOKE são a REAL camada. Replicar → a RLS/REVOKE é quem decide.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos (a RPC v3.2 NÃO toca purchase_orders_tracking — last_seen é tabela dedicada) ──
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
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

# ── ZONA 2: migration REAL ──
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3: seeds (usuários de teste; POs são só valores de omie_codigo_pedido) ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master (staff)
  ('44444444-4444-4444-4444-444444444444');  -- customer (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master');
SQL

# janela PADRÃO usada nos cenários (largura 485d ~ o completo real). Aw/Ai usam larguras/datas diferentes.
JDE="2025-07-01"; JATE="2026-10-29"   # 485 dias
# helper: limpa e semeia N runs OBEN volume_ok=true, largura PADRÃO, recentes, ids=$1
seed_oben() {
  P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',$1,true,'ok', now()-interval '3h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',$1,true,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',$1,true,'ok', now()-interval '1h');
SQL
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── Bloco A: volume_ok robusto (baseline por largura de janela + idade) ──"
# A1 — BOOTSTRAP: 3 runs ids=0 EXCLUÍDOS → volume_ok NULL (nunca true).
P -q <<SQL
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[1073,1115]::bigint[]) IS NULL;" | tail -1)
eq "A1 bootstrap → volume_ok NULL" "$V" "t"

# A2 — baseline 100 (mesma largura) + run 100 → true.
P -q <<SQL
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'COLACOR','$JDE','$JATE',100,true,'ok', now()-interval '3h'),
 (gen_random_uuid(),'COLACOR','$JDE','$JATE',100,true,'ok', now()-interval '2h'),
 (gen_random_uuid(),'COLACOR','$JDE','$JATE',100,true,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g));" | tail -1)
eq "A2 baseline 100, run 100 → volume_ok true" "$V" "t"

# A3 — volume baixo → false.
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,50) g));" | tail -1)
eq "A3 baseline 100, run 50 → volume_ok false" "$V" "f"

# A4 — exclui volume_ok=false do baseline (1 false(10)+1 true(100), run 60 → baseline 100 → false).
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g));" | tail -1)
eq "A4 baseline exclui volume_ok=false → false" "$V" "f"

# Aw — anti-latch por LARGURA: um backfill ampliado (janela LARGA, 1000 IDs) NÃO entra no baseline do
#      completo NORMAL (largura padrão). Run normal com 100 → sem baseline comparável → volume_ok NULL (não false).
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
-- backfill ampliado: janela de 3 anos (largura != padrão)
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2023-01-01','2026-10-29',1000,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g)) IS NULL;" | tail -1)
eq "Aw backfill de largura diferente NÃO envenena o baseline do normal → NULL" "$V" "t"

# Ai — anti-latch por IDADE: um run BOM porém VELHO (>10d) não conta no baseline.
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',1000,true,'ok', now()-interval '20 days');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g)) IS NULL;" | tail -1)
eq "Ai run bom porém >10d NÃO conta no baseline → NULL (quebra latch)" "$V" "t"

# Az — EMPRESA VAZIA: um completo LIMPO com ids=[] (todos os POs sumiram do Omie) é VÁLIDO (volume_ok=true),
#      NÃO truncamento — senão a empresa esvaziada nunca produziria marcador válido e os fantasmas jamais
#      viravam candidatos (Codex v3.2 P1). A edge só chama a RPC em varredura_completa, então ids=0 aqui = fim
#      limpo sem POs. Baseline positivo presente (não pode "cair no bootstrap"): prova que o ids=0 vence.
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',100,true,'ok', now()-interval '1h');
SQL
VZ=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[]::bigint[]);" | tail -1)
eq "Az empresa vazia (ids=0) em run LIMPO → volume_ok TRUE (marcador válido; não é truncamento)" "$VZ" "t"

echo "── Bloco B: last_seen tabela DEDICADA — só run VÁLIDO + anti-regressão + atomicidade ──"
# B1 — run VÁLIDO carimba os POs vistos em reposicao_po_last_seen; PO não-visto ausente.
seed_oben 2
RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
VOK=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RID','$JDE','$JATE',ARRAY[1073,1115]::bigint[]);" | tail -1)
eq "B1a run baseline 2 / ids 2 → volume_ok true" "$VOK" "t"
SEEN=$(Pq -c "SELECT count(*) FROM public.reposicao_po_last_seen WHERE empresa='OBEN' AND omie_codigo_pedido IN (1073,1115) AND run_id='$RID';" | tail -1)
eq "B1b run válido carimba os POs vistos (tabela dedicada)" "$SEEN" "2"
UNSEEN=$(Pq -c "SELECT count(*) FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=9999;" | tail -1)
eq "B1c PO não-visto não entra na tabela de last_seen" "$UNSEEN" "0"

# Bg — run INVÁLIDO (volume_ok=false) NÃO carimba.
seed_oben 100
RIDF=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
VOK=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RIDF','$JDE','$JATE',ARRAY[1073]::bigint[]);" | tail -1)
eq "Bg baseline 100 / ids 1 → volume_ok false" "$VOK" "f"
NC=$(Pq -c "SELECT count(*) FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1073;" | tail -1)
eq "Bg run truncado NÃO carimba last_seen" "$NC" "0"

# Bgn — bootstrap (volume_ok=null) NÃO carimba.
P -q <<'SQL'
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
SQL
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[1073]::bigint[]);" >/dev/null
NC=$(Pq -c "SELECT count(*) FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1073;" | tail -1)
eq "Bgn bootstrap (volume_ok=null) NÃO carimba last_seen" "$NC" "0"

# Bt — ANTI-REGRESSÃO por SEQ (ordem total lógica, não wall-clock): seed um visto_seq ALTÍSSIMO p/ 1073; o run
#      atual (seq da sequence << 9999999) NÃO sobrescreve 1073, mas carimba 1115 (novo). Guard: visto_seq < EXCLUDED.
seed_oben 2
FUT_RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
P -q -c "INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id,visto_seq,visto_em) VALUES ('OBEN',1073,'$FUT_RID', 9999999, now());"
NOW_RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$NOW_RID','$JDE','$JATE',ARRAY[1073,1115]::bigint[]);" >/dev/null
KEPT=$(Pq -c "SELECT run_id='$FUT_RID' FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1073;" | tail -1)
eq "Bt run atual (seq baixo) NÃO sobrescreve last_seen de visto_seq alto (anti-regressão por seq)" "$KEPT" "t"
GOT=$(Pq -c "SELECT run_id='$NOW_RID' FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1115;" | tail -1)
eq "Bt o mesmo run VÁLIDO carimba o PO sem conflito (1115)" "$GOT" "t"

# B2 — ATOMICIDADE: se o INSERT do last_seen falhar, o INSERT do marcador REVERTE (mesmo commit). Trigger
#      sabotador com SQLSTATE própria (ZZ999) no INSERT de reposicao_po_last_seen. Precisa run VÁLIDO.
seed_oben 2
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.sabota_ls() RETURNS trigger LANGUAGE plpgsql AS
  $t$ BEGIN RAISE EXCEPTION 'sabotagem no last_seen' USING ERRCODE='ZZ999'; END $t$;
CREATE TRIGGER trg_sabota_ls BEFORE INSERT ON public.reposicao_po_last_seen
  FOR EACH ROW EXECUTE FUNCTION public.sabota_ls();
SQL
NB=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-10-29', ARRAY[1073,1115]::bigint[]);
  RAISE EXCEPTION 'RPC_NAO_FALHOU';
EXCEPTION
  WHEN sqlstate 'ZZ999' THEN RAISE NOTICE 'SABOTA_ESPERADA';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *SABOTA_ESPERADA*) ok "B2a a RPC levanta a SQLSTATE esperada (ZZ999) do INSERT last_seen";; *) bad "B2a — veio: $R";; esac
NA=$(Pq -c "SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "B2b falha no last_seen reverte o INSERT do marcador (atômico)" "$NA" "$NB"
P -q <<'SQL'
DROP TRIGGER trg_sabota_ls ON public.reposicao_po_last_seen;
DROP FUNCTION public.sabota_ls();
SQL

echo "── Bloco C: lock EFETIVO — serializa a publicação POR EMPRESA em RUNTIME (não é só grep) ──"
# C1 (estático): o advisory lock está na definição da RPC.
HASLOCK=$(Pq -c "SELECT pg_get_functiondef('public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[])'::regprocedure) LIKE '%pg_advisory_xact_lock%';" | tail -1)
eq "C1 RPC adquire advisory lock por empresa (presente na definição)" "$HASLOCK" "t"
# C2 (EFEITO runtime — o que o grep do C1 NÃO prova; Codex acusou C1 de teatro): uma 2ª sessão SEGURA o lock
# da OBEN por 6s; a RPC p/ OBEN trava na 1ª instrução (o lock) e o statement_timeout (1.5s ≪ 6s) a cancela
# ANTES de qualquer INSERT (rollback → não contamina). Prova que o lock não está em ramo morto e serializa.
P -q >/dev/null 2>&1 <<'SQL' &
BEGIN; SELECT pg_advisory_xact_lock(hashtext('reposicao_run:oben')); SELECT pg_sleep(6); ROLLBACK;
SQL
LOCKER=$!
sleep 1.5  # deixa a 2ª sessão adquirir o lock antes de a RPC tentar
RB=$(P -tA 2>&1 <<'SQL'
SET statement_timeout='1500';
SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), DATE '2025-07-01', DATE '2026-10-29', ARRAY[9099]::bigint[]);
SQL
) || true
case "$RB" in
  *timeout*|*canceling*) ok "C2 RPC p/ OBEN BLOQUEIA sob lock tomado (serializa em RUNTIME — lock não é ramo morto)";;
  *) bad "C2 — a RPC NÃO bloqueou sob o lock da OBEN tomado (lock inócuo em runtime?): $RB";;
esac
# C3 (POR EMPRESA — falsificação, Codex v3.2 P2#5): a OBEN segue tomada por vários segundos; a RPC p/ COLACOR
# COMPLETA em <100ms com timeout CURTO (1.5s ≪ 6s do locker). Se o key fosse GLOBAL, COLACOR esperaria os ~4.5s
# restantes → timeout (o timeout curto GARANTE que "esperar o lock global" seria pego). Qualquer ERROR também
# reprova (não basta "não deu timeout" — antes o ramo ok engolia erros).
RC=$(P -tA 2>&1 <<'SQL'
SET statement_timeout='1500';
SELECT public.reposicao_publicar_run_completo('COLACOR', gen_random_uuid(), DATE '2025-07-01', DATE '2026-10-29', ARRAY[2099]::bigint[]);
SQL
) || true
case "$RC" in
  *timeout*|*canceling*) bad "C3 — RPC p/ COLACOR travou com OBEN tomado (lock NÃO é por empresa): $RC";;
  *ERROR*|*erro*|*ERRO*) bad "C3 — RPC p/ COLACOR deu erro em vez de completar: $RC";;
  *) ok "C3 RPC p/ COLACOR completa (<timeout, sem erro) com OBEN tomado (serializa POR EMPRESA, não global)";;
esac
wait "$LOCKER" 2>/dev/null || true
P -q -c "DELETE FROM public.reposicao_pedidos_compra_run; DELETE FROM public.reposicao_po_last_seen;" >/dev/null

echo "── Bloco D: base NÃO-forjável / service_role-only (as 2 tabelas) ──"
# D1 — authenticated não invoca a RPC.
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-10-29', ARRAY[1073]::bigint[]);
  RAISE EXCEPTION 'INVOCOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RPC_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *RPC_DENY_OK*) ok "D1 authenticated não invoca a RPC (42501)";; *) bad "D1 — veio: $R";; esac

# D2 — service_role invoca (efeito: marcador inserido).
P -q -c "DELETE FROM public.reposicao_pedidos_compra_run;" >/dev/null
Pq -c "SET ROLE service_role; SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-10-29', ARRAY[1073]::bigint[]);" >/dev/null
D2N=$(Pq -tAc "SELECT count(*) FROM public.reposicao_pedidos_compra_run;")
eq "D2 service_role invoca a RPC (marcador inserido pelo definer)" "$D2N" "1"

# D3 — authenticated não faz INSERT direto no MARCADOR (RLS nega).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status)
    VALUES (gen_random_uuid(),'OBEN','2025-07-01','2026-10-29',999,true,'ok');
  RAISE EXCEPTION 'INSERIU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'INSERT_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *INSERT_DENY_OK*) ok "D3 authenticated não forja marcador (RLS nega INSERT)";; *) bad "D3 — veio: $R";; esac

# D5 — authenticated não faz INSERT direto no LAST_SEEN (Codex: staff forjaria "visto" e suprimiria a prova).
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id,visto_seq,visto_em)
    VALUES ('OBEN',1073,gen_random_uuid(),1,now());
  RAISE EXCEPTION 'FORJOU_VISTO';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'LS_DENY_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *LS_DENY_OK*) ok "D5 authenticated não forja last_seen (single-writer REAL — fecha o furo do Codex)";; *) bad "D5 — veio: $R";; esac

# D4 — SELECT: staff vê o marcador, customer não.
SS=$(Pq -c "SET test.role='authenticated'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
case "$SS" in 0) bad "D4a staff deveria ver linhas, veio 0";; *) ok "D4a staff vê o marcador ($SS)";; esac
NS=$(Pq -c "SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.reposicao_pedidos_compra_run;" | tail -1)
eq "D4b customer (não-staff) não vê nada (RLS SELECT)" "$NS" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"
saboto_rpc() { # $1 = sem_exclui_false | canario | sem_gate_volume | sem_guard_temporal | sem_filtro_largura | sem_filtro_idade | sem_ids0_valido
  local base_where volok update_gate on_conflict_guard
  base_where="AND ids_distintos>0 AND volume_ok IS NOT FALSE AND (janela_ate - janela_de) = (p_janela_ate - p_janela_de) AND finalizado_em > now() - interval '10 days'"
  volok="IF v_ids=0 THEN v_ok:=TRUE; ELSIF v_base IS NULL OR v_base<=0 THEN v_ok:=NULL; ELSE v_ok:=(v_ids::numeric>=0.9*v_base); END IF;"
  update_gate="v_ok IS TRUE"
  on_conflict_guard="WHERE public.reposicao_po_last_seen.visto_seq < EXCLUDED.visto_seq"
  case "$1" in
    sem_exclui_false)   base_where="AND ids_distintos>0 AND (janela_ate - janela_de) = (p_janela_ate - p_janela_de) AND finalizado_em > now() - interval '10 days'" ;;
    canario)            base_where=""; volok="v_ok:=(v_ids::numeric>=0.9*COALESCE(v_base,0));" ;;
    sem_gate_volume)    update_gate="v_ids>0" ;;
    sem_guard_temporal) on_conflict_guard="" ;;
    sem_filtro_largura) base_where="AND ids_distintos>0 AND volume_ok IS NOT FALSE AND finalizado_em > now() - interval '10 days'" ;;
    sem_filtro_idade)   base_where="AND ids_distintos>0 AND volume_ok IS NOT FALSE AND (janela_ate - janela_de) = (p_janela_ate - p_janela_de)" ;;
    sem_ids0_valido)    volok="IF v_base IS NULL OR v_base<=0 THEN v_ok:=NULL; ELSE v_ok:=(v_ids::numeric>=0.9*v_base); END IF;" ;;
  esac
  P -q <<SQL
CREATE OR REPLACE FUNCTION public.reposicao_publicar_run_completo(p_empresa text,p_run_id uuid,p_janela_de date,p_janela_ate date,p_ids bigint[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS \$\$
DECLARE v_empresa public.empresa_reposicao:=upper(btrim(p_empresa))::public.empresa_reposicao; v_ids int; v_base numeric; v_ok boolean; v_agora timestamptz; v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_run:'||lower(btrim(p_empresa))));
  v_agora := clock_timestamp();
  SELECT count(DISTINCT x) INTO v_ids FROM unnest(COALESCE(p_ids,ARRAY[]::bigint[])) x WHERE x>0;
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY r.ids_distintos) INTO v_base FROM (
    SELECT ids_distintos FROM public.reposicao_pedidos_compra_run
    WHERE empresa=v_empresa AND status='ok' $base_where
    ORDER BY seq DESC LIMIT 5) r;
  $volok
  INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em)
    VALUES (p_run_id,v_empresa,p_janela_de,p_janela_ate,v_ids,v_ok,'ok',v_agora) RETURNING seq INTO v_seq;
  IF $update_gate THEN
    INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id,visto_seq,visto_em)
    SELECT v_empresa,x,p_run_id,v_seq,v_agora FROM unnest(p_ids) x WHERE x>0
    ON CONFLICT (empresa,omie_codigo_pedido) DO UPDATE SET run_id=EXCLUDED.run_id, visto_seq=EXCLUDED.visto_seq, visto_em=EXCLUDED.visto_em $on_conflict_guard;
  END IF;
  RETURN v_ok; END \$\$;
SQL
}

# F1 (P1#5) — baseline sem excluir volume_ok=false → A4 vaza.
saboto_rpc sem_exclui_false
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run WHERE empresa='OBEN';
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE', 10,false,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',100,true, 'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,60) g));" | tail -1)
case "$V" in t) ok "F1 sem excluir volume_ok=false o A4 VAZA (true) — A4 tem dente";; *) bad "F1 não vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# F2 (P1#5) — canário [0,0]→true.
saboto_rpc canario
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',0,NULL,'ok', now()-interval '2h'),
 (gen_random_uuid(),'OBEN','$JDE','$JATE',0,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[1073,1115]::bigint[]);" | tail -1)
case "$V" in t) ok "F2 canário [0,0]→true reaparece — A1 tem dente";; *) bad "F2 não vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# Fw (latch) — sem o filtro de largura, o backfill ampliado envenena → Aw vaza (baseline 1000, run 100 → false, não NULL).
saboto_rpc sem_filtro_largura
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','2023-01-01','2026-10-29',1000,NULL,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g));" | tail -1)
case "$V" in f) ok "Fw sem o filtro de largura o backfill ENVENENA (100 vira false) — Aw tem dente";; *) bad "Fw não vazou ($V; esperava false)";; esac
P -q -f "$MIG" >/dev/null

# Fi (latch por IDADE) — sem o filtro de 10d, um run BOM porém VELHO (>10d, 1000 IDs) REENTRA no baseline →
# o run normal 100 vira FALSE (não NULL) → a cadência trava e nenhum marcador válido nasce (o latch permanente
# do Codex). Prova que o filtro de idade (Ai) tem dente.
saboto_rpc sem_filtro_idade
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',1000,true,'ok', now()-interval '20 days');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', (SELECT array_agg(g)::bigint[] FROM generate_series(1,100) g));" | tail -1)
case "$V" in f) ok "Fi sem o filtro de idade o bootstrap velho REENVENENA (100 vira false, latch) — Ai tem dente";; *) bad "Fi não vazou ($V; esperava false)";; esac
P -q -f "$MIG" >/dev/null

# Fg (P1#1) — gate sem volume_ok IS TRUE → run truncado carimba → Bg vaza.
saboto_rpc sem_gate_volume
seed_oben 100
RIDF=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$RIDF','$JDE','$JATE',ARRAY[1073]::bigint[]);" >/dev/null
LEAK=$(Pq -c "SELECT count(*) FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1073 AND run_id='$RIDF';" | tail -1)
case "$LEAK" in 1) ok "Fg sem o gate volume_ok o run truncado CARIMBA — Bg tem dente";; *) bad "Fg não vazou ($LEAK)";; esac
P -q -f "$MIG" >/dev/null

# Ft (P1#4) — ON CONFLICT sem o guard → o run atual (seq baixo) SOBRESCREVE o visto_seq alto → Bt vaza.
saboto_rpc sem_guard_temporal
seed_oben 2
FUT_RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
P -q -c "INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id,visto_seq,visto_em) VALUES ('OBEN',1073,'$FUT_RID', 9999999, now());"
NOW_RID=$(Pq -c "SELECT gen_random_uuid();" | tail -1)
# ids=2 (1073,1115) → baseline 2 → volume_ok=true → o UPDATE roda (o gate volume não barra) e exercita o guard
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN','$NOW_RID','$JDE','$JATE',ARRAY[1073,1115]::bigint[]);" >/dev/null
LEAK=$(Pq -c "SELECT run_id='$NOW_RID' FROM public.reposicao_po_last_seen WHERE omie_codigo_pedido=1073;" | tail -1)
case "$LEAK" in t) ok "Ft sem o guard o run atual SOBRESCREVE o visto_seq alto — Bt tem dente";; *) bad "Ft não vazou ($LEAK)";; esac
P -q -f "$MIG" >/dev/null

# Fz (empresa vazia) — sem o ramo ids=0→TRUE, uma empresa vazia (ids=0) com baseline positivo vira volume_ok
# FALSE → marcador não-válido → o starvation do Codex v3.2 P1 volta. Prova que o Az tem dente.
saboto_rpc sem_ids0_valido
P -q <<SQL
DELETE FROM public.reposicao_pedidos_compra_run;
DELETE FROM public.reposicao_po_last_seen;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,empresa,janela_de,janela_ate,ids_distintos,volume_ok,status,finalizado_em) VALUES
 (gen_random_uuid(),'OBEN','$JDE','$JATE',100,true,'ok', now()-interval '1h');
SQL
V=$(Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[]::bigint[]);" | tail -1)
case "$V" in f) ok "Fz sem o ramo ids=0 a empresa vazia vira FALSE (starvation) — Az tem dente";; *) bad "Fz não vazou ($V; esperava false)";; esac
P -q -f "$MIG" >/dev/null

# F3 (P1#6) — GRANT a authenticated → D1 deixa de barrar.
P -q -c "GRANT EXECUTE ON FUNCTION public.reposicao_publicar_run_completo(text,uuid,date,date,bigint[]) TO authenticated;" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '2025-07-01','2026-10-29', ARRAY[1073]::bigint[]);
  RAISE NOTICE 'INVOCOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *INVOCOU_VAZOU*) ok "F3 com GRANT a authenticated a RPC é invocável — D1 tem dente";; *) bad "F3 não vazou ($R)";; esac
P -q -f "$MIG" >/dev/null

# F4 (P1#6) — policy INSERT authenticated no last_seen → D5 deixa de barrar.
P -q <<'SQL'
DELETE FROM public.reposicao_po_last_seen;  -- limpa (senão o INSERT de 1073 colidiria na PK antes de testar a policy)
GRANT INSERT ON public.reposicao_po_last_seen TO authenticated;
CREATE POLICY forja_ls ON public.reposicao_po_last_seen FOR INSERT TO authenticated WITH CHECK (true);
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id,visto_seq,visto_em) VALUES ('OBEN',1073,gen_random_uuid(),1,now());
  RAISE NOTICE 'FORJOU_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *FORJOU_VAZOU*) ok "F4 com policy INSERT o last_seen vira forjável — D5 tem dente";; *) bad "F4 não vazou ($R)";; esac
P -q <<'SQL'
DROP POLICY IF EXISTS forja_ls ON public.reposicao_po_last_seen;
REVOKE INSERT ON public.reposicao_po_last_seen FROM authenticated;
SQL
P -q -f "$MIG" >/dev/null

# D6/F5 (v3.2 P2#4) — o single-writer não pode falsificar só INSERT: um staff com GRANT UPDATE + policy
# FOR UPDATE poderia COPIAR o run_id atual p/ um last_seen EXISTENTE (suprimindo a prova por ID de um PO
# excluído — mais perigoso que um falso-ausente). D6: o REVOKE UPDATE da migration barra. F5: re-concede
# UPDATE+policy → o forge via UPDATE passa → prova que o REVOKE UPDATE tem dente.
seed_oben 2
Pq -c "SELECT public.reposicao_publicar_run_completo('OBEN', gen_random_uuid(), '$JDE','$JATE', ARRAY[1073]::bigint[]);" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  UPDATE public.reposicao_po_last_seen SET run_id=gen_random_uuid() WHERE omie_codigo_pedido=1073;
  RAISE NOTICE 'UPDATE_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'UPDATE_BARRADO'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *UPDATE_BARRADO*) ok "D6 authenticated não FORJA via UPDATE (REVOKE UPDATE barra o copy-run_id — Codex v3.2 P2#4)";; *) bad "D6 — UPDATE não barrado: $R";; esac
P -q <<'SQL'
GRANT UPDATE ON public.reposicao_po_last_seen TO authenticated;
CREATE POLICY forja_ls_upd ON public.reposicao_po_last_seen FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.role='authenticated'; SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;
DO $$ BEGIN
  UPDATE public.reposicao_po_last_seen SET run_id=gen_random_uuid() WHERE omie_codigo_pedido=1073;
  RAISE NOTICE 'UPDATE_VAZOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'UPDATE_BARRADO'; WHEN OTHERS THEN RAISE NOTICE 'OUTRO'; END $$;
SQL
)
case "$R" in *UPDATE_VAZOU*) ok "F5 com GRANT UPDATE+policy o forge via UPDATE passa — D6 tem dente";; *) bad "F5 não vazou ($R)";; esac
P -q <<'SQL'
DROP POLICY IF EXISTS forja_ls_upd ON public.reposicao_po_last_seen;
REVOKE UPDATE ON public.reposicao_po_last_seen FROM authenticated;
SQL

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

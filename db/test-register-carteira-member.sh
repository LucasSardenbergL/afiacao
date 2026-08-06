#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — register_carteira_member (P0-B-bis Fatia 4, money-path)         ║
# ║      bash db/test-register-carteira-member.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que esta prova protege (a RPC é a via de admissão de membro na carteira     ║
# ║  depois que a Fatia 5 dropar omie_clientes e o trigger AFTER INSERT cair):     ║
# ║   · não ressuscita quarantinado (ambiguous não volta a verified = comissão)    ║
# ║   · não rouba vínculo cross-user (UNIQUE codigo,account fail-closed)           ║
# ║   · não aceita o slug INTERNO do sync ('vendas') como account da proof         ║
# ║   · SECURITY INVOKER: customer segue barrado como a RLS de hoje o barra        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="regcartmember"
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
# ZONA 1 — PRÉ-REQUISITOS: as 2 tabelas-destino FIÉIS à prod (constraints + RLS
#          medidas por psql-ro em 2026-07-18) + o espelho, p/ provar que a RPC
#          NÃO o toca.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');

CREATE TABLE public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;

-- carteira_membership_ledger (Fatia 0). CHECK de source SEM 'sync' — a migration sob teste é quem o amplia.
CREATE TABLE public.carteira_membership_ledger (
  user_id        uuid NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_state text NOT NULL DEFAULT 'verified'
    CONSTRAINT carteira_membership_ledger_identity_state_check
    CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at  timestamptz NOT NULL,
  source         text NOT NULL DEFAULT 'trigger'
    CONSTRAINT carteira_membership_ledger_source_check
    CHECK (source IN ('backfill','trigger','rpc')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.carteira_membership_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage carteira membership ledger" ON public.carteira_membership_ledger
  FOR ALL TO public
  USING      (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Users can view their own membership" ON public.carteira_membership_ledger
  FOR SELECT TO public USING (auth.uid() = user_id);

-- omie_customer_account_map (a proof). DUAS uniques — a de código é a defesa anti-roubo de vínculo.
CREATE TABLE public.omie_customer_account_map (
  id                   uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account              text NOT NULL CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente  bigint NOT NULL,
  omie_codigo_vendedor bigint,
  source               text NOT NULL DEFAULT 'document'
    CONSTRAINT chk_ocam_source CHECK (source IN ('document','code','manual')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ocam_user_account   UNIQUE (user_id, account),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account)
);
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage account map" ON public.omie_customer_account_map
  FOR ALL TO authenticated
  USING      (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
CREATE POLICY "Users can view their own account map" ON public.omie_customer_account_map
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- o espelho que a Fatia 4 abandona: existe aqui SÓ p/ provar que a RPC não escreve nele (A11).
CREATE TABLE public.omie_clientes (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  omie_codigo_cliente bigint,
  omie_codigo_vendedor bigint,
  empresa_omie text DEFAULT 'colacor'
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718170000_register_carteira_member.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# HOTFIX do achado A do /codex retroativo: source='rpc' em vez de 'manual' (ver cabeçalho da migration).
# Aplicada na sequência REAL de produção — a 170000 rodou primeiro e a 200000 a corrige.
MIG_HOTFIX="$REPO_ROOT/supabase/migrations/20260718200000_register_carteira_member_source_rpc.sql"
P -q -f "$MIG_HOTFIX"
echo "hotfix aplicado: $(basename "$MIG_HOTFIX")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (espelha prod: authenticated TEM grant de tabela; quem
#          barra o customer é a RLS, não a falta de privilégio)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- customer comum (não-staff)
  ('22222222-2222-2222-2222-222222222222'),  -- staff (employee)
  ('33333333-3333-3333-3333-333333333333'),  -- membro NOVO
  ('44444444-4444-4444-4444-444444444444'),  -- membro JÁ quarantinado (ambiguous)
  ('55555555-5555-5555-5555-555555555555'),  -- dono legítimo de um código oben
  ('66666666-6666-6666-6666-666666666666')   -- cenário do hotfix A (imunidade do source)
  ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles(user_id, role) VALUES
  ('22222222-2222-2222-2222-222222222222','employee');

-- membro já quarantinado pela Fatia 2, com first_seen_at ANTIGO (a data real do vínculo)
INSERT INTO public.carteira_membership_ledger(user_id, identity_state, first_seen_at, source)
VALUES ('44444444-4444-4444-4444-444444444444','ambiguous','2026-03-01 10:00:00+00','backfill');

-- vínculo legítimo pré-existente: o código 90001 já é do user 5 na conta oben
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente, source)
VALUES ('55555555-5555-5555-5555-555555555555','oben',90001,'document');

-- Espelha os GRANTs medidos em prod (pg_class.relacl): anon/authenticated/service_role têm privilégio
-- de tabela; quem barra o customer é a RLS, não a falta de GRANT. Sem isto o A9 ficaria verde pelo
-- motivo ERRADO (permission denied da tabela, não a policy) e não provaria nada sobre a RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carteira_membership_ledger, public.omie_customer_account_map TO authenticated, anon, service_role;
GRANT SELECT ON public.user_roles TO authenticated, anon, service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: positivos ──"

# A1 — caminho feliz: membro novo entra nas DUAS pontas, com as procedências certas.
P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','colacor_sc',70123,4501);" >/dev/null
V=$(Pq -c "SELECT identity_state||'/'||source FROM public.carteira_membership_ledger WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A1a ledger recebe o membro (verified/rpc)" "$V" "verified/rpc"
V=$(Pq -c "SELECT account||'/'||omie_codigo_cliente||'/'||omie_codigo_vendedor||'/'||source FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A1b proof recebe o vínculo account-correto (source=rpc)" "$V" "colacor_sc/70123/4501/rpc"

# A2 — money-path: vendedor AUSENTE fica NULL, nunca fabricado como 0 (Number(null)===0 é o bug irmão).
P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','oben',80456,NULL);" >/dev/null
V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULO') FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333' AND account='oben';")
eq "A2 vendedor ausente vira NULL, não 0" "$V" "NULO"

# A3 — idempotência: re-chamar não duplica nem no ledger nem na proof.
P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','colacor_sc',70123,4501);" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A3a ledger idempotente" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333' AND account='colacor_sc';")
eq "A3b proof idempotente por (user,account)" "$V" "1"

# A4 — vendedor conhecido NÃO é apagado por uma re-chamada sem vendedor (COALESCE).
P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','colacor_sc',70123,NULL);" >/dev/null
V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULO') FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333' AND account='colacor_sc';")
eq "A4 re-chamada sem vendedor preserva o vendedor conhecido" "$V" "4501"

echo "── asserts: money-path (o invariante central) ──"

# A5 — O MAIS IMPORTANTE: a RPC NÃO ressuscita quarantinado. Um membro 'ambiguous' re-registrado
# continua 'ambiguous' (senão o rebuild devolveria vendedor e comissão a um cliente cuja identidade
# não sabemos) e o first_seen_at ORIGINAL é preservado (analytics-sync:1566 consome essa data).
P -q -c "SELECT public.register_carteira_member('44444444-4444-4444-4444-444444444444','oben',91234,7777);" >/dev/null
V=$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
eq "A5a quarantinado NÃO volta a verified" "$V" "ambiguous"
V=$(Pq -c "SELECT first_seen_at::date::text FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
eq "A5b first_seen_at original preservado (não vira now())" "$V" "2026-03-01"
V=$(Pq -c "SELECT source FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
eq "A5c procedência original preservada" "$V" "backfill"

# A11 — a RPC desacoplou do espelho: nenhuma escrita em omie_clientes após 5 chamadas.
V=$(Pq -c "SELECT count(*) FROM public.omie_clientes;")
eq "A11 a RPC NÃO escreve no espelho omie_clientes" "$V" "0"

echo "── asserts: hotfix do /codex retroativo (achado A — imunidade indevida) ──"

# A15 — O DEFEITO: a RPC gravava source='manual', e o delete de ambiguidade do sync escopa fontes
# AUTOMATIZADAS para preservar override HUMANO. Resultado: todo vínculo criado pela RPC ficava IMUNE ao
# fail-closed — vendedor possivelmente errado sobrevivendo à detecção, com comissão em cima.
# Aqui simulamos o delete do sync exatamente como ele é (`.in("source", ["document","rpc"])`) e exigimos
# que a linha da RPC seja alcançada.
P -q -c "SELECT public.register_carteira_member('66666666-6666-6666-6666-666666666666','colacor',61234,9);" >/dev/null
V=$(Pq -c "SELECT source FROM public.omie_customer_account_map WHERE user_id='66666666-6666-6666-6666-666666666666' AND account='colacor';")
eq "A15a a RPC grava source='rpc', não 'manual'" "$V" "rpc"
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='colacor' AND source IN ('document','rpc') AND user_id='66666666-6666-6666-6666-666666666666';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='66666666-6666-6666-6666-666666666666' AND account='colacor';")
eq "A15b o delete de ambiguidade ALCANÇA a linha da RPC (fail-closed restaurado)" "$V" "0"

# A16 — a contrapartida: override HUMANO ('manual') continua IMUNE. Se a correção tivesse ido longe
# demais (tratar tudo como automatizado), o sync passaria a apagar decisão humana.
P -q -c "INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente,source) VALUES ('22222222-2222-2222-2222-222222222222','colacor',62222,'manual');" >/dev/null
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='colacor' AND source IN ('document','rpc') AND user_id='22222222-2222-2222-2222-222222222222';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='22222222-2222-2222-2222-222222222222' AND account='colacor';")
eq "A16 override HUMANO (manual) segue imune ao delete" "$V" "1"

# A17 — a RPC NÃO rebaixa um override humano a 'rpc' numa re-chamada (o CASE do ON CONFLICT).
P -q -c "SELECT public.register_carteira_member('22222222-2222-2222-2222-222222222222','colacor',62222,77);" >/dev/null
V=$(Pq -c "SELECT source FROM public.omie_customer_account_map WHERE user_id='22222222-2222-2222-2222-222222222222' AND account='colacor';")
eq "A17 re-chamada da RPC preserva o 'manual' de um override humano" "$V" "manual"

echo "── asserts: negativos (SQLSTATE esperada + re-raise) ──"

# A6 — o slug INTERNO do sync ('vendas') não é account da proof. Passá-lo deve EXPLODIR (23514),
# nunca gravar conta errada — vendedor de outra conta = comissão para o vendedor errado.
R=$(P -tA 2>&1 <<'SQL'
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.register_carteira_member('33333333-3333-3333-3333-333333333333','vendas',70999,1);
    v_passou := true;
  EXCEPTION
    WHEN check_violation THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'SLUG_ACEITO_BUG'; ELSE RAISE NOTICE 'SLUG_BARRADO_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *SLUG_BARRADO_OK*) ok  "A6 slug interno 'vendas' rejeitado pelo CHECK (23514)" ;;
  *SLUG_ACEITO_BUG*) bad "A6 slug interno 'vendas' foi ACEITO — conta errada gravada" ;;
  *)                 bad "A6 resultado inesperado: $R" ;;
esac

# A7 — user inexistente → FK morde (23503). Membro fantasma no ledger viraria carteira órfã.
R=$(P -tA 2>&1 <<'SQL'
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.register_carteira_member('99999999-9999-9999-9999-999999999999','oben',70998,1);
    v_passou := true;
  EXCEPTION
    WHEN foreign_key_violation THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'FANTASMA_ACEITO_BUG'; ELSE RAISE NOTICE 'FANTASMA_BARRADO_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *FANTASMA_BARRADO_OK*) ok  "A7 user inexistente rejeitado pela FK (23503)" ;;
  *FANTASMA_ACEITO_BUG*) bad "A7 membro fantasma entrou no ledger" ;;
  *)                     bad "A7 resultado inesperado: $R" ;;
esac

# A8 — MONEY-PATH: código que já é de OUTRO user na MESMA conta não pode ser roubado. O ON CONFLICT
# cobre (user_id,account) e DELIBERADAMENTE não cobre (codigo,account) → 23505. Se passasse, o pedido
# iria para o cliente errado.
R=$(P -tA 2>&1 <<'SQL'
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    -- 90001/oben já é do user 5
    PERFORM public.register_carteira_member('33333333-3333-3333-3333-333333333333','oben',90001,1);
    v_passou := true;
  EXCEPTION
    WHEN unique_violation THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'ROUBO_ACEITO_BUG'; ELSE RAISE NOTICE 'ROUBO_BARRADO_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *ROUBO_BARRADO_OK*) ok  "A8 código de outro user na mesma conta rejeitado (23505, fail-closed)" ;;
  *ROUBO_ACEITO_BUG*) bad "A8 ROUBO DE VÍNCULO passou — pedido iria p/ o cliente errado" ;;
  *)                  bad "A8 resultado inesperado: $R" ;;
esac

V=$(Pq -c "SELECT user_id::text FROM public.omie_customer_account_map WHERE omie_codigo_cliente=90001 AND account='oben';")
eq "A8b o dono legítimo do código 90001 permanece" "$V" "55555555-5555-5555-5555-555555555555"

echo "── asserts: autorização (SECURITY INVOKER — a RLS é o gate) ──"

# A9 — customer comum NÃO registra ninguém (nem a si mesmo). É o writer morto do Auth.tsx: hoje a RLS
# já barra; a RPC não pode ter aberto essa porta.
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.register_carteira_member('11111111-1111-1111-1111-111111111111','oben',70997,1);
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'CUSTOMER_ESCREVEU_BUG'; ELSE RAISE NOTICE 'CUSTOMER_BARRADO_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *CUSTOMER_BARRADO_OK*) ok  "A9 customer comum barrado pela RLS (42501) — INVOKER preserva o fail-closed" ;;
  *CUSTOMER_ESCREVEU_BUG*) bad "A9 FALHA ABERTA: customer registrou membro — a RPC abriu o que a RLS fechava" ;;
  *)                     bad "A9 resultado inesperado: $R" ;;
esac

# A10 — staff (employee) CONSEGUE: é o caminho do AdminApprovals. Sem isto a fatia quebraria a aprovação.
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
DO $$
DECLARE v_ok boolean := false;
BEGIN
  PERFORM public.register_carteira_member('11111111-1111-1111-1111-111111111111','colacor',60111,300);
  v_ok := true;
  IF v_ok THEN RAISE NOTICE 'STAFF_ESCREVEU_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *STAFF_ESCREVEU_OK*) ok "A10 staff registra membro (caminho do AdminApprovals vivo)" ;;
  *)                   bad "A10 staff NÃO conseguiu registrar — a fatia quebraria a aprovação: $R" ;;
esac
V=$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A10b o membro do staff entrou de fato" "$V" "1"

# A12 — anon não executa a função (REVOKE explícito, defesa em profundidade sobre a RLS).
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.register_carteira_member('33333333-3333-3333-3333-333333333333','oben',70996,1);
    v_passou := true;
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
    WHEN OTHERS THEN RAISE;
  END;
  IF v_passou THEN RAISE NOTICE 'ANON_EXECUTOU_BUG'; ELSE RAISE NOTICE 'ANON_BARRADO_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *ANON_BARRADO_OK*)  ok  "A12 anon não executa a RPC (REVOKE por nome)" ;;
  *ANON_EXECUTOU_BUG*) bad "A12 anon executou a RPC" ;;
  *)                  bad "A12 resultado inesperado: $R" ;;
esac

# A14 — service_role EXECUTA. É o caminho de 4 dos 5 writers (as 3 chamadas do omie-cliente + a do
# omie-sync rodam com a service key). Provar staff e customer e SUPOR o service_role deixaria de fora
# justamente a maioria das chamadas: BYPASSRLS ignora a RLS mas NÃO concede GRANT — se faltasse o
# GRANT EXECUTE (ou o das tabelas), as edges quebrariam em produção com o harness verde.
# [achado do Caminho B: o Codex estava sem cota e esta lacuna saiu da auto-revisão adversária]
R=$(P -tA 2>&1 <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  PERFORM public.register_carteira_member('33333333-3333-3333-3333-333333333333','colacor',60777,42);
  RAISE NOTICE 'SERVICE_ROLE_ESCREVEU_OK';
END $$;
SQL
)
case "$R" in
  *SERVICE_ROLE_ESCREVEU_OK*) ok "A14 service_role executa a RPC (caminho das edges)" ;;
  *) bad "A14 service_role NÃO conseguiu executar — as 4 chamadas das edges quebrariam em prod: $R" ;;
esac
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE omie_codigo_cliente=60777;")
eq "A14b o vínculo escrito pelo service_role existe" "$V" "1"

# A13 — o CHECK ampliado aceita 'sync' (o bulk escreve o ledger direto, em massa, sem N+1).
R=$(P -tA 2>&1 <<'SQL'
INSERT INTO public.carteira_membership_ledger(user_id, identity_state, first_seen_at, source)
VALUES ('55555555-5555-5555-5555-555555555555','verified',now(),'sync');
SQL
)
V=$(Pq -c "SELECT source FROM public.carteira_membership_ledger WHERE user_id='55555555-5555-5555-5555-555555555555';")
eq "A13 CHECK ampliado aceita source='sync' (bulk)" "$V" "sync"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada assert que guarda dinheiro/autorização tem a sua) ──"

# ── F1 aponta para A5: troca o DO NOTHING do ledger por um DO UPDATE que "normaliza" o estado.
# É o erro plausível que um dev faria querendo "atualizar o membro". Se A5 tiver dente, aqui o
# quarantinado ressuscita.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.register_carteira_member(
  p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_omie_codigo_vendedor bigint DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now())
  ON CONFLICT (user_id) DO UPDATE SET          -- SABOTADO: era DO NOTHING
    identity_state = 'verified', first_seen_at = now(), source = 'rpc', updated_at = now();
  INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at)
  VALUES (p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'manual', now())
  ON CONFLICT (user_id, account) DO UPDATE SET
    omie_codigo_cliente = EXCLUDED.omie_codigo_cliente, source='manual', updated_at = now();
END $fn$;
SQL
P -q -c "SELECT public.register_carteira_member('44444444-4444-4444-4444-444444444444','oben',91234,7777);" >/dev/null
V=$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
if [ "$V" = "verified" ]; then
  ok "F1 sabotagem ressuscitou o quarantinado (A5 tem dente)"
else
  bad "F1 sabotei o ON CONFLICT e A5 NÃO mudou → A5 é fraco, conserte o assert"
fi
# restaura a versão verdadeira + o estado semeado
P -q -f "$MIG"
P -q -c "UPDATE public.carteira_membership_ledger SET identity_state='ambiguous', first_seen_at='2026-03-01 10:00:00+00', source='backfill' WHERE user_id='44444444-4444-4444-4444-444444444444';" >/dev/null
V=$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='44444444-4444-4444-4444-444444444444';")
eq "F1r restaurada a versão verdadeira (quarantinado de volta)" "$V" "ambiguous"

# ── F2 aponta para A9: SECURITY DEFINER é exatamente o desenho que a migration REJEITA. Se A9 tiver
# dente, com DEFINER o customer comum passa a escrever — a falha aberta que o CLAUDE.md descreve
# ("muda autorização e não comportamento — o CI não vê").
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.register_carteira_member(
  p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_omie_codigo_vendedor bigint DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now()) ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at)
  VALUES (p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'manual', now())
  ON CONFLICT (user_id, account) DO UPDATE SET omie_codigo_cliente = EXCLUDED.omie_codigo_cliente, updated_at = now();
END $fn$;
GRANT EXECUTE ON FUNCTION public.register_carteira_member(uuid,text,bigint,bigint) TO authenticated;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.register_carteira_member('11111111-1111-1111-1111-111111111111','colacor_sc',70995,1);
  RAISE NOTICE 'DEFINER_DEIXOU_PASSAR';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *DEFINER_DEIXOU_PASSAR*) ok  "F2 SECURITY DEFINER abriu a escrita ao customer (A9 tem dente)" ;;
  *) bad "F2 troquei p/ DEFINER e A9 NÃO mudou → A9 é fraco, conserte o assert" ;;
esac
P -q -f "$MIG"
P -q -c "DELETE FROM public.omie_customer_account_map WHERE omie_codigo_cliente=70995;" >/dev/null 2>&1 || true

# ── F3 aponta para A8: sem a UNIQUE(codigo,account), o roubo de vínculo cross-user passa.
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT uq_ocam_codigo_account;"
if P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','oben',90001,1);" >/dev/null 2>&1; then
  ok "F3 sem a UNIQUE(codigo,account) o roubo de vínculo passa (A8 tem dente)"
else
  bad "F3 droppei a UNIQUE e o roubo AINDA falhou → A8 não provava a constraint"
fi
P -q -c "DELETE FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333' AND account='oben';" >/dev/null
P -q -c "ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account);"

# ── F4 aponta para A6: sem o CHECK de account, o slug interno do sync é gravado como conta.
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT chk_ocam_account;"
if P -q -c "SELECT public.register_carteira_member('33333333-3333-3333-3333-333333333333','vendas',70994,1);" >/dev/null 2>&1; then
  ok "F4 sem o CHECK o slug 'vendas' vira conta gravada (A6 tem dente)"
else
  bad "F4 droppei o CHECK e 'vendas' AINDA falhou → A6 não provava a constraint"
fi
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='vendas';" >/dev/null
P -q -c "ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc'));"

# ── F5 aponta para A15: restaura o defeito ORIGINAL (source='manual') e exige que a imunidade volte.
# É a prova de que A15 pega o bug que esteve em produção — sem ela, A15 seria só um assert de rótulo.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.register_carteira_member(
  p_user_id uuid, p_account text, p_omie_codigo_cliente bigint, p_omie_codigo_vendedor bigint DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now()) ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at)
  VALUES (p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'manual', now())  -- DEFEITO ORIGINAL
  ON CONFLICT (user_id, account) DO UPDATE SET omie_codigo_cliente = EXCLUDED.omie_codigo_cliente, source='manual', updated_at = now();
END $fn$;
SQL
P -q -c "SELECT public.register_carteira_member('44444444-4444-4444-4444-444444444444','colacor',63333,5);" >/dev/null
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='colacor' AND source IN ('document','rpc') AND user_id='44444444-4444-4444-4444-444444444444';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='44444444-4444-4444-4444-444444444444' AND account='colacor';")
if [ "$V" = "1" ]; then
  ok "F5 com source='manual' a linha SOBREVIVE ao delete de ambiguidade (A15 tem dente — era o bug em prod)"
else
  bad "F5 restaurei o defeito e A15 não mudou → A15 não prova a imunidade"
fi
P -q -f "$MIG"; P -q -f "$MIG_HOTFIX"
P -q -c "DELETE FROM public.omie_customer_account_map WHERE omie_codigo_cliente IN (63333,62222);" >/dev/null 2>&1 || true

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

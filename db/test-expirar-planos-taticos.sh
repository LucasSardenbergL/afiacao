#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260807210912_expirar_planos_taticos.sql                        ║
# ║      bash db/test-expirar-planos-taticos.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  O que prova: a fila do Plano Tático ganha SAÍDA sem destruir desfecho.        ║
# ║   · expira `gerado` fora da janela, preserva o de dentro                       ║
# ║   · NUNCA toca plano `concluido` (o desfecho registrado é o dado escasso)      ║
# ║   · `_dias` inválido é fail-closed (não expira a fila inteira)                 ║
# ║   · REVOKE barra anon/authenticated (SECURITY DEFINER bypassa RLS)             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="expirar-planos-taticos"
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
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ O `ALTER DEFAULT PRIVILEGES` abaixo NÃO é decoração: sem ele o `authenticated`
# do stub nasceria SEM execute em qualquer função nova, e os asserts A12/A13
# (REVOKE) passariam por acidente de ambiente — FALSO-VERDE. É a réplica do
# default-privilege real do Supabase, e é o que dá dente à falsificação F3.
# (Armadilha documentada em docs/agent/database.md.)
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- pg_cron não existe no PG17 limpo. `db/stubs-supabase.sql` já cria a TABELA
-- cron.job (jobid bigint sem default) — aqui só faltam as FUNÇÕES, para que a
-- migration REAL rode sem ser editada (Lei #1) e o A14 leia o que foi agendado.
CREATE OR REPLACE FUNCTION cron.unschedule(_name text) RETURNS boolean
  LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = _name; SELECT true; $f$;
CREATE OR REPLACE FUNCTION cron.schedule(_name text, _sched text, _cmd text) RETURNS bigint
  LANGUAGE sql AS $f$
    INSERT INTO cron.job(jobid, jobname, schedule, command, active)
    VALUES (coalesce((SELECT max(jobid) FROM cron.job), 0) + 1, _name, _sched, _cmd, true)
    RETURNING jobid; $f$;

-- Stub da tabela-alvo, só com as colunas que a migration toca.
CREATE TABLE IF NOT EXISTS public.farmer_tactical_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id    uuid,
  status       text NOT NULL DEFAULT 'gerado',
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260807210912_expirar_planos_taticos.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
# Um plano por caso de borda. As idades são relativas a now() para o teste não
# apodrecer com o calendário.
P -q <<'SQL'
INSERT INTO public.farmer_tactical_plans (id, status, generated_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'gerado',    now() - interval '10 days'),  -- expira
  ('22222222-2222-2222-2222-222222222222', 'gerado',    now() - interval '3 days'),   -- fica
  ('33333333-3333-3333-3333-333333333333', 'concluido', now() - interval '30 days'),  -- INTOCÁVEL
  ('44444444-4444-4444-4444-444444444444', 'gerado',    now() - interval '7 days 1 hour'), -- borda: expira
  ('55555555-5555-5555-5555-555555555555', 'gerado',    now() - interval '6 days 23 hours'); -- borda: fica
UPDATE public.farmer_tactical_plans SET updated_at = now() - interval '90 days';
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

st() { Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$1';"; }

# A1 — a função roda de verdade (late-bound) e devolve a contagem correta.
N=$(Pq -c "SELECT public.expirar_planos_taticos(7);")
eq "A1 retorno = nº de expirados" "$N" "2"

eq "A2 antigo (10d) expirou"            "$(st 11111111-1111-1111-1111-111111111111)" "expirado"
eq "A3 dentro da janela (3d) intacto"   "$(st 22222222-2222-2222-2222-222222222222)" "gerado"
eq "A4 CONCLUIDO preservado"            "$(st 33333333-3333-3333-3333-333333333333)" "concluido"
eq "A5 borda 7d+1h expirou"             "$(st 44444444-4444-4444-4444-444444444444)" "expirado"
eq "A6 borda 6d23h intacto"             "$(st 55555555-5555-5555-5555-555555555555)" "gerado"

# A7 — updated_at é tocado só em quem expirou (seed pôs 90 dias atrás em todos).
UPD=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE updated_at > now() - interval '1 minute';")
eq "A7 updated_at tocado só nos 2 expirados" "$UPD" "2"

# A8 — idempotência: a 2ª passada não re-expira nem conta de novo.
N2=$(Pq -c "SELECT public.expirar_planos_taticos(7);")
eq "A8 idempotente (2a passada = 0)" "$N2" "0"

# ── negativos: capturam a SQLSTATE esperada e RE-LANÇAM o resto (Lei #2) ──
# Sentinelas ASCII, caixa fixa, exclusivas do ramo — e AUSENTES do texto que a
# migration emite (a mensagem dela fala "_dias deve ser >= 1").
guard_barra() { # $1 = literal SQL do argumento
  R=$(P -tA 2>&1 <<SQL || true
DO \$t\$
BEGIN
  PERFORM public.expirar_planos_taticos($1);
  RAISE NOTICE 'GUARDA_PASSOU_DIRETO';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'GUARDA_BARROU_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
  case "$R" in *GUARDA_BARROU_OK*) echo "OK" ;; *) echo "FALHOU" ;; esac
}
eq "A9  _dias=0 rejeitado (22023)"    "$(guard_barra 0)"                "OK"
eq "A10 _dias=-1 rejeitado (22023)"   "$(guard_barra -1)"               "OK"
eq "A11 _dias=NULL rejeitado (22023)" "$(guard_barra 'NULL::integer')"  "OK"

# A11b — o guard não é só cosmético: com _dias=0 a fila NÃO foi tocada.
VIVOS=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE status='gerado';")
eq "A11b fila intacta após guard" "$VIVOS" "2"

# ── REVOKE: SECURITY DEFINER bypassa RLS, então só cron/service_role executa ──
exec_negado() { # $1 = role
  R=$(P -tA 2>&1 <<SQL || true
SET ROLE $1;
DO \$t\$
BEGIN
  PERFORM public.expirar_planos_taticos(7);
  RAISE NOTICE 'ROLE_CONSEGUIU_EXECUTAR';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ROLE_FOI_NEGADA_OK';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
)
  case "$R" in *ROLE_FOI_NEGADA_OK*) echo "OK" ;; *) echo "FALHOU" ;; esac
}
eq "A12 authenticated NÃO executa (42501)" "$(exec_negado authenticated)" "OK"
eq "A13 anon NÃO executa (42501)"          "$(exec_negado anon)"          "OK"

# A14 — o cron ficou agendado apontando para a função nomeada (não SQL inline).
CMD=$(Pq -c "SELECT schedule||' :: '||command FROM cron.job WHERE jobname='expirar-planos-taticos';")
eq "A14 cron agendado" "$CMD" "30 8 * * * ::  SELECT public.expirar_planos_taticos(7); "

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem TEM de virar vermelho) ──"
fals() { if [ "$2" = "FALHOU" ]; then ok "F$1 sabotagem detectada"; else bad "F$1 SEM DENTE — sabotei e o assert seguiu verde"; fi; }

# F1 — guard de _dias trocado por no-op. A9/A10/A11 devem morrer.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.expirar_planos_taticos(_dias integer DEFAULT 7)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.farmer_tactical_plans SET status='expirado', updated_at=now()
   WHERE status='gerado' AND generated_at < now() - make_interval(days => _dias);
  GET DIAGNOSTICS _n = ROW_COUNT; RETURN _n;
END; $$;
SQL
fals 1 "$(guard_barra 0)"

# F2 — filtro de status removido: `concluido` viraria `expirado` (destrói desfecho).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.expirar_planos_taticos(_dias integer DEFAULT 7)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _n integer;
BEGIN
  UPDATE public.farmer_tactical_plans SET status='expirado', updated_at=now()
   WHERE generated_at < now() - make_interval(days => _dias);
  GET DIAGNOSTICS _n = ROW_COUNT; RETURN _n;
END; $$;
SQL
P -q -c "SELECT public.expirar_planos_taticos(7);"
F2=$([ "$(st 33333333-3333-3333-3333-333333333333)" = "concluido" ] && echo "OK" || echo "FALHOU")
fals 2 "$F2"

# restaura a migration verdadeira antes de F3
P -q -f "$MIG"
P -q -c "UPDATE public.farmer_tactical_plans SET status='concluido' WHERE id='33333333-3333-3333-3333-333333333333';"

# F3 — REVOKE desfeito: `authenticated` volta a executar.
# É esta sabotagem que prova que A12 não passou por acidente de ambiente
# (ver o ALTER DEFAULT PRIVILEGES na ZONA 1).
P -q -c "GRANT EXECUTE ON FUNCTION public.expirar_planos_taticos(integer) TO authenticated;"
fals 3 "$(exec_negado authenticated)"
P -q -c "REVOKE ALL ON FUNCTION public.expirar_planos_taticos(integer) FROM authenticated;"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"

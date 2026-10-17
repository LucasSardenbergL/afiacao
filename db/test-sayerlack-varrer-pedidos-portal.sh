#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261016150000_sayerlack_varrer_pedidos_portal_cron.sql              ║
# ║  Tabela de falhas da varredura (RLS fechada, 1 escritor) + job do cron com timeout ║
# ║  explícito; idempotência; falsificação (cada sabotagem tem que dar o vermelho DELA).║
# ║      bash db/test-sayerlack-varrer-pedidos-portal.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NAO pipe pra tail — engole o exit!=0.) 2º locale (lição #1483):                 ║
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-varrer-pedidos-portal.sh        ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5476}"
SLUG="sayerlack-varrer-pedidos-portal"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG="$REPO_ROOT/supabase/migrations/20261016150000_sayerlack_varrer_pedidos_portal_cron.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261017120000_sayerlack_varredura_visto.sql"
for f in "$MIG" "$MIG2"; do [ -f "$f" ] || { echo "INFRA: ausente: $f"; exit 1; }; done

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER SYSTEM SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -w reload >/dev/null

# Banco novo por cenário: o mesmo esqueleto do Supabase (roles + stub do pg_cron que faz upsert por nome).
novo_banco() {
  local db="$1"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$db"
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
-- O GRANT padrão do Supabase em tabela nova do public (a migration tem que FECHÁ-lo).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobname, schedule, command) VALUES (p_nome, p_sched, p_cmd)
  ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
  RETURNING jobid;
$f$;
SQL
}

aplicar() { # $1 banco, $2 arquivo → stdout+stderr; exit do psql
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -1 -p "$PORT" -h /tmp -U postgres -d "$1" -f "$2" 2>&1
}
Q() { "$PGBIN/psql" -X -At -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$1" -c "$2"; }

FALHOU=0
ok()   { echo "OK   $1"; }
nok()  { echo "FAIL $1"; FALHOU=1; }

# ── Cenário principal ────────────────────────────────────────────────────────────────
novo_banco prova
if out="$(aplicar prova "$MIG")"; then ok "A1 migration aplica (postcondição passou)"; else nok "A1 migration não aplicou: $out"; fi
case "$out" in *"tabela com RLS fechada + 1 job ativo"*) ok "A2 NOTICE positivo de fim";; *) nok "A2 sem o NOTICE de fim: $out";; esac
if out2="$(aplicar prova "$MIG")"; then ok "A3 re-aplicar é idempotente"; else nok "A3 re-aplicar falhou: $out2"; fi
igual() { # $1 rótulo, $2 obtido, $3 esperado
  if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (veio '$2', esperado '$3')"; fi
}
igual "A4 exatamente 1 job" "$(Q prova "SELECT count(*) FROM cron.job WHERE jobname='sayerlack-varrer-pedidos-portal'")" "1"
igual "A5 horário UTC 01:30/15:30/20:30 (= 22:30/12:30/17:30 SP)" \
  "$(Q prova "SELECT schedule FROM cron.job WHERE jobname='sayerlack-varrer-pedidos-portal'")" "30 1,15,20 * * *"
igual "A6 anon/authenticated sem acesso" \
  "$(Q prova "SELECT has_table_privilege('authenticated','public.sayerlack_varredura_falha','SELECT')::text || has_table_privilege('anon','public.sayerlack_varredura_falha','INSERT')::text")" "falsefalse"
igual "A7 service_role escreve" \
  "$(Q prova "SELECT has_table_privilege('service_role','public.sayerlack_varredura_falha','UPDATE')::text")" "true"
# O escritor (edge) só faz UPDATE com WHERE (pg-safeupdate do Supabase): os 2 UPDATEs dela, aqui em SQL.
if Q prova "INSERT INTO public.sayerlack_varredura_falha(protocolo, mensagem) VALUES ('2141068','sem de-para');
            UPDATE public.sayerlack_varredura_falha SET tentativas = tentativas + 1, resolvido_em = NULL WHERE protocolo = '2141068';
            UPDATE public.sayerlack_varredura_falha SET resolvido_em = now() WHERE protocolo = '2141068' AND resolvido_em IS NULL;" >/dev/null; then
  ok "A8 escrita do escritor (UPDATE com WHERE) funciona"
else nok "A8 escrita"; fi
if out="$(Q prova "INSERT INTO public.sayerlack_varredura_falha(protocolo, mensagem) VALUES ('12a','x')" 2>&1)"; then
  nok "A9 protocolo não numérico foi aceito"
else case "$out" in *"sayerlack_varredura_falha_protocolo_check"*) ok "A9 protocolo não numérico recusado pelo CHECK";; *) nok "A9 erro inesperado: $out";; esac; fi

# ── 20261017120000: 1ª vista (carência) ─────────────────────────────────────────────
if out="$(aplicar prova "$MIG2")"; then ok "B1 migration da 1ª vista aplica"; else nok "B1 não aplicou: $out"; fi
case "$out" in *"service_role só SELECT/INSERT"*) ok "B2 NOTICE positivo de fim";; *) nok "B2 sem o NOTICE de fim: $out";; esac
if out2="$(aplicar prova "$MIG2")"; then ok "B3 re-aplicar é idempotente"; else nok "B3 re-aplicar falhou: $out2"; fi
# O escritor: INSERT ... ON CONFLICT DO NOTHING — a 1ª vista não muda numa 2ª rodada.
Q prova "INSERT INTO public.sayerlack_varredura_visto(protocolo, primeira_vez_em) VALUES ('2140762','2026-10-16T12:00:00Z')" >/dev/null
Q prova "INSERT INTO public.sayerlack_varredura_visto(protocolo) VALUES ('2140762') ON CONFLICT (protocolo) DO NOTHING" >/dev/null
igual "B4 2ª vista não mexe na 1ª" "$(Q prova "SELECT primeira_vez_em = '2026-10-16T12:00:00Z' FROM public.sayerlack_varredura_visto WHERE protocolo='2140762'")" "t"
igual "B5 service_role sem UPDATE (vista imutável)" \
  "$(Q prova "SELECT has_table_privilege('service_role','public.sayerlack_varredura_visto','UPDATE')::text")" "false"

# ── Falsificação: cada sabotagem tem que dar o vermelho DA SUA postcondição ──────────────
sabotar() { # $1 rótulo, $2 marcador esperado, $3.. expressão sed
  local rot="$1" marca="$2"; shift 2
  local f="$TMPD/sab-$rot.sql" db="sab_$rot"
  sed "$@" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then nok "F-$rot sed não mudou nada (sabotagem inerte)"; return; fi
  novo_banco "$db"
  if out="$(aplicar "$db" "$f")"; then nok "F-$rot sabotada e passou: $out"
  else case "$out" in *"$marca"*) ok "F-$rot vermelho certo ($marca)";; *) nok "F-$rot vermelho errado: $out";; esac; fi
}
sabotar sem_rls     "P2 FALHOU" -e '/ENABLE ROW LEVEL SECURITY/d'
sabotar sem_revoke  "P3 FALHOU" -e '/^REVOKE ALL ON TABLE/d'
sabotar horario     "P5 FALHOU" -e "/^  '30 1,15,20/s/'30 1,15,20/'30 15,20/"
sabotar sem_timeout "P6 FALHOU" -e 's/, timeout_milliseconds:=150000//'

sabotar2() { # mesma ideia, sobre a 2ª migration
  local rot="$1" marca="$2"; shift 2
  local f="$TMPD/sab2-$rot.sql" db="sab2_$rot"
  sed "$@" "$MIG2" > "$f"
  if cmp -s "$f" "$MIG2"; then nok "F2-$rot sed não mudou nada (sabotagem inerte)"; return; fi
  novo_banco "$db"
  if out="$(aplicar "$db" "$f")"; then nok "F2-$rot sabotada e passou: $out"
  else case "$out" in *"$marca"*) ok "F2-$rot vermelho certo ($marca)";; *) nok "F2-$rot vermelho errado: $out";; esac; fi
}
sabotar2 sem_rls    "V2 FALHOU" -e '/ENABLE ROW LEVEL SECURITY/d'
sabotar2 sem_revoke "V3 FALHOU" -e '/^REVOKE ALL ON TABLE/d'
sabotar2 com_update "V4 FALHOU" -e 's/GRANT SELECT, INSERT ON TABLE public.sayerlack_varredura_visto/GRANT SELECT, INSERT, UPDATE ON TABLE public.sayerlack_varredura_visto/'

if [ "$FALHOU" -ne 0 ]; then echo "RESULTADO: VERMELHO"; exit 1; fi
echo "RESULTADO: VERDE — test-sayerlack-varrer-pedidos-portal (LC=$HARNESS_LC)"

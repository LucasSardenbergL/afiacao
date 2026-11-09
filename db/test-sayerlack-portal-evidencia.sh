#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261111090000_sayerlack_portal_evidencia.sql (7.2, revisão 2 do portal Sayerlack)
# ║  Evidência de cada leitura do portal: INSERT-only (UPDATE/DELETE/TRUNCATE = 42501, até para o dono), 1 escritor
# ║  (service_role), staff lê pela RLS, customer/anon não; CHECKs de protocolo/intervalo/tamanho; idempotente.
# ║      bash db/test-sayerlack-portal-evidencia.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      HARNESS_LC=pt_BR.UTF-8 bash db/test-sayerlack-portal-evidencia.sh      (2º idioma do servidor, lição #1483)
# ║  (NÃO pipe pra tail — engole o exit≠0.) A falsificação roda SEMPRE, depois do controle verde, na mesma invocação.
# ╚══════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5793}"
SLUG="sayerlack-portal-evidencia"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

MIG="$REPO_ROOT/supabase/migrations/20261111090000_sayerlack_portal_evidencia.sql"
[ -f "$MIG" ] || { echo "INFRA: ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
HARNESS_LC="${HARNESS_LC:-C}"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER SYSTEM SET lc_messages='$HARNESS_LC';" >/dev/null \
  || { echo "INFRA: lc_messages='$HARNESS_LC' indisponível neste servidor"; exit 1; }
"$PGBIN/pg_ctl" -D "$DATA" -w reload >/dev/null
echo "lc_messages do servidor: $("$PGBIN/psql" -X -At -p "$PORT" -h /tmp -U postgres -d postgres -c 'SHOW lc_messages')"

# Esqueleto do Supabase: roles, GRANT padrão em tabela nova (a migration tem de FECHÁ-lo), auth.uid() por GUC, has_role.
novo_banco() {
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$1"
  "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$1" -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon, authenticated, service_role;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000000e', 'employee'),
                                     ('00000000-0000-0000-0000-00000000000c', 'customer');
SQL
}

aplicar() { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -1 -p "$PORT" -h /tmp -U postgres -d "$1" -f "$2" 2>&1; }
Q() { "$PGBIN/psql" -X -At -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$1" -c "$2"; }
# SQLSTATE de um comando que DEVE falhar (VERBOSITY verbose põe o código na mensagem, em qualquer idioma).
SQLSTATE() {
  local out
  if out="$("$PGBIN/psql" -X -At -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -p "$PORT" -h /tmp -U postgres -d "$1" -c "$2" 2>&1)"; then
    echo "PASSOU"
  else
    printf '%s\n' "$out" | sed -n 's/.*ERROR: *\([0-9A-Z]\{5\}\):.*/\1/p;s/.*ERRO: *\([0-9A-Z]\{5\}\):.*/\1/p' | head -1
  fi
}

FALHOU=0
ok()  { echo "OK   $1"; }
nok() { echo "FAIL $1"; FALHOU=1; }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (veio '$2', esperado '$3')"; fi; }

INS="INSERT INTO public.sayerlack_portal_evidencia(execucao_id, protocolo, pedido_id, origem, lido_de, lido_ate, http_status,
       leitura_ok, consulta_headers, consulta_linhas, itens_brutos, condicao, condicoes_opcoes)
     VALUES ('11111111-1111-1111-1111-111111111111', '2140603', 777, 'manual', '2026-11-11T13:00:00Z', '2026-11-11T13:01:10Z', 200,
       true, '[\"Pedido\",\"Situação\"]', '[{\"Pedido\":\"2140603\",\"Situação\":\"5 - Suspenso\"}]',
       '{\"success\":true,\"itens\":[[10,\"DFA.4080LT\"]]}', '70 - 7 DIAS', '[\"70 - 7 DIAS\"]')"

# ── Controle (cenário principal) ──────────────────────────────────────────────────────────
novo_banco prova
if out="$(aplicar prova "$MIG")"; then ok "A1 migration aplica (postcondição passou)"; else nok "A1 migration não aplicou: $out"; fi
case "$out" in *"EVIDENCIA_PORTAL_OK"*) ok "A2 marcador positivo de fim";; *) nok "A2 sem o marcador de fim: $out";; esac
if out2="$(aplicar prova "$MIG")"; then ok "A3 re-aplicar é idempotente"; else nok "A3 re-aplicar falhou: $out2"; fi

# O escritor (service_role) insere.
if Q prova "SET ROLE service_role; $INS" >/dev/null 2>&1; then ok "B1 service_role insere"; else nok "B1 service_role não inseriu"; fi
igual "B2 a linha gravada tem o que o portal mostrou" \
  "$(Q prova "SELECT protocolo || '|' || pedido_id || '|' || (itens_brutos->'itens'->0->>1) || '|' || condicao || '|' || execucao_id FROM public.sayerlack_portal_evidencia")" \
  "2140603|777|DFA.4080LT|70 - 7 DIAS|11111111-1111-1111-1111-111111111111"

# Imutável: até o dono (postgres, superusuário) recebe 42501.
igual "C1 UPDATE pelo escritor = 42501" "$(SQLSTATE prova "SET ROLE service_role; UPDATE public.sayerlack_portal_evidencia SET condicao='x' WHERE id=1")" "42501"
igual "C2 UPDATE pelo dono = 42501 (trigger, não só GRANT)" "$(SQLSTATE prova "UPDATE public.sayerlack_portal_evidencia SET condicao='x' WHERE id=1")" "42501"
igual "C3 DELETE pelo dono = 42501" "$(SQLSTATE prova "DELETE FROM public.sayerlack_portal_evidencia WHERE id=1")" "42501"
igual "C4 TRUNCATE pelo dono = 42501" "$(SQLSTATE prova "TRUNCATE public.sayerlack_portal_evidencia")" "42501"
# Codex P2: `session_replication_role = replica` pula trigger comum; o ALWAYS dispara mesmo assim.
igual "C6 UPDATE em modo replica = 42501 (trigger ALWAYS)" "$(SQLSTATE prova "SET session_replication_role = replica; UPDATE public.sayerlack_portal_evidencia SET condicao='x' WHERE id=1")" "42501"
igual "C7 DELETE em modo replica = 42501" "$(SQLSTATE prova "SET session_replication_role = replica; DELETE FROM public.sayerlack_portal_evidencia WHERE id=1")" "42501"
igual "C5 a linha segue intacta" "$(Q prova "SELECT count(*) || ':' || condicao FROM public.sayerlack_portal_evidencia GROUP BY condicao")" "1:70 - 7 DIAS"

# Ninguém além do escritor escreve.
igual "D1 authenticated (staff) não insere = 42501" "$(SQLSTATE prova "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000000e'; $INS")" "42501"
igual "D2 anon não lê = 42501" "$(SQLSTATE prova "SET ROLE anon; SELECT count(*) FROM public.sayerlack_portal_evidencia")" "42501"

# RLS de leitura: staff vê, customer não (0 linhas, sem erro).
igual "E1 staff (employee) lê" \
  "$(Q prova "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000000e'; SELECT count(*) FROM public.sayerlack_portal_evidencia" | tail -1)" "1"
igual "E2 customer lê 0 linhas" \
  "$(Q prova "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000000c'; SELECT count(*) FROM public.sayerlack_portal_evidencia" | tail -1)" "0"

# CHECKs (SQLSTATE 23514).
# Troca a 1ª ocorrência de $1 por $2 no INSERT (perl: o `${s/a/b}` do bash 3.2 do macOS mantém as aspas do $2).
troca() { printf '%s' "$INS" | DE="$1" PARA="$2" perl -pe 's/\Q$ENV{DE}\E/$ENV{PARA}/'; }
igual "F1 protocolo não numérico = 23514" "$(SQLSTATE prova "SET ROLE service_role; $(troca "'2140603'" "'21406a3'")")" "23514"
igual "F2 intervalo invertido = 23514" "$(SQLSTATE prova "SET ROLE service_role; $(troca "'2026-11-11T13:01:10Z'" "'2026-11-11T12:00:00Z'")")" "23514"
igual "F3 origem fora da lista = 23514" "$(SQLSTATE prova "SET ROLE service_role; $(troca "'manual'" "'cron'")")" "23514"
igual "F4 evidência acima de 512 KB = 23514" \
  "$(SQLSTATE prova "SET ROLE service_role; INSERT INTO public.sayerlack_portal_evidencia(protocolo, origem, lido_de, lido_ate, leitura_ok, erro) VALUES ('2140603','manual',now(),now(),false, repeat('x', 600000))")" "23514"

# Codex P3: o teto cobre também condicao e erro_tipo.
igual "F5 condicao acima de 512 KB = 23514" \
  "$(SQLSTATE prova "SET ROLE service_role; INSERT INTO public.sayerlack_portal_evidencia(protocolo, origem, lido_de, lido_ate, leitura_ok, condicao) VALUES ('2140603','manual',now(),now(),false, repeat('x', 600000))")" "23514"
igual "F6 erro_tipo acima de 512 KB = 23514" \
  "$(SQLSTATE prova "SET ROLE service_role; INSERT INTO public.sayerlack_portal_evidencia(protocolo, origem, lido_de, lido_ate, leitura_ok, erro_tipo) VALUES ('2140603','manual',now(),now(),false, repeat('x', 600000))")" "23514"

# ── Falsificação: cada sabotagem tem de dar o vermelho DA SUA postcondição (controle verde acima) ─────
sabotar() { # $1 rótulo, $2 marcador esperado, $3.. expressão sed
  local rot="$1" marca="$2"; shift 2
  local f="$TMPD/sab-$rot.sql" db="sab_$rot"
  sed "$@" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then nok "S-$rot sed não mudou nada (sabotagem inerte)"; return; fi
  novo_banco "$db"
  if out="$(aplicar "$db" "$f")"; then nok "S-$rot sabotada e passou: $out"
  else case "$out" in *"$marca"*) ok "S-$rot vermelho certo ($marca)";; *) nok "S-$rot vermelho errado: $out";; esac; fi
}
sabotar sem_rls        "E1 FALHOU" -e '/ENABLE ROW LEVEL SECURITY/d'
sabotar sem_revoke_aut "E2 FALHOU" -e '/^REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM authenticated;/d'
sabotar sem_revoke_srv "E2 FALHOU" -e '/^REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM service_role;/d'
sabotar sem_insert     "E3 FALHOU" -e 's/^GRANT SELECT, INSERT ON TABLE public.sayerlack_portal_evidencia TO service_role;/GRANT SELECT ON TABLE public.sayerlack_portal_evidencia TO service_role;/'
sabotar sem_trava      "E4 FALHOU" -e '/^CREATE TRIGGER trg_evidencia_imutavel$/,/EXECUTE FUNCTION/d' -e '/ENABLE ALWAYS TRIGGER trg_evidencia_imutavel;/d'
sabotar sem_trava_trunc "E4 FALHOU" -e '/^CREATE TRIGGER trg_evidencia_imutavel_truncate$/,/EXECUTE FUNCTION/d' -e '/ENABLE ALWAYS TRIGGER trg_evidencia_imutavel_truncate;/d'
sabotar sem_always     "E4 FALHOU" -e '/ENABLE ALWAYS TRIGGER trg_evidencia_imutavel;/d'
sabotar sem_select_srv "E3 FALHOU" -e 's/^GRANT SELECT, INSERT ON TABLE public.sayerlack_portal_evidencia TO service_role;/GRANT INSERT ON TABLE public.sayerlack_portal_evidencia TO service_role;/'

echo "---"
if [ "$FALHOU" -eq 0 ]; then echo "PROVA_OK $SLUG (lc=$HARNESS_LC)"; else echo "PROVA_FALHOU $SLUG (lc=$HARNESS_LC)"; exit 1; fi

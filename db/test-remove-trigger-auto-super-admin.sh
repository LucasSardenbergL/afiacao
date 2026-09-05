#!/usr/bin/env bash
# HARNESS PG17 — prova de 20260830122702_remove_trigger_auto_super_admin.sql, com falsificação.
#   bash db/test-remove-trigger-auto-super-admin.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Prova DUAS coisas: (1) a migration desarma o escritor automatico de 'super_admin';
# (2) o controle do #802-P1 — o gate is_employee=true e o que tornava o trigger inalcancavel
#     pelo self-insert. Sem (2) a remocao pareceria resposta a um furo aberto, e nao e.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="remove-trg-super-admin"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260830122702_remove_trigger_auto_super_admin.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@17 ausente"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

CELLAR="$(brew --prefix postgresql@17)"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@17/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@17"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@17/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 - esperado [$3], veio [$2]"; fi; }

CPF='01363383647'   # mesmo literal ja commitado em 20260228163826; nao e segredo novo

# ── esquema minimo fiel a prod ─────────────────────────────────────────────
P -q <<SQL
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TABLE public.company_config (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE, document text, is_employee boolean NOT NULL DEFAULT false);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL DEFAULT 'operacional',
  updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.company_config(key,value) VALUES ('master_cpf','$CPF');
SQL

# corpo VIVO medido em prod (identico ao de 20260228163826)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.auto_assign_commercial_super_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE master_cpf_value TEXT; profile_doc TEXT;
BEGIN
  IF TG_OP != 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.is_employee != true THEN RETURN NEW; END IF;
  SELECT value INTO master_cpf_value FROM public.company_config WHERE key = 'master_cpf';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  IF profile_doc = master_cpf_value THEN
    INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (NEW.user_id, 'super_admin')
    ON CONFLICT (user_id) DO UPDATE SET commercial_role = 'super_admin', updated_at = now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_auto_commercial_super_admin ON public.profiles;
CREATE TRIGGER trg_auto_commercial_super_admin AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.auto_assign_commercial_super_admin();
SQL

papel() { Pq -c "SELECT coalesce((SELECT commercial_role::text FROM public.commercial_roles WHERE user_id='$1'),'NENHUM');"; }
trg_existe() { Pq -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname='trg_auto_commercial_super_admin';"; }
fn_existe()  { Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='auto_assign_commercial_super_admin';"; }

A='aaaaaaaa-0000-0000-0000-000000000001'
B='bbbbbbbb-0000-0000-0000-000000000002'
C='cccccccc-0000-0000-0000-000000000003'
D='dddddddd-0000-0000-0000-000000000004'

echo "-- ZONA 1: a CARGA existe hoje (por que a remocao se justifica) --"
P -q -c "INSERT INTO public.profiles(user_id,document,is_employee) VALUES ('$A','$CPF',true);"
eq "A0 insert de EMPLOYEE com o CPF-alvo concede super_admin automaticamente" "$(papel $A)" "super_admin"

echo "-- ZONA 2: o controle do #802-P1 (por que NAO era furo aberto) --"
# A unica policy de INSERT em profiles e "Users can insert own profile", cujo WITH CHECK exige
# is_employee=false. Este assert prova que, com is_employee=false, o trigger NAO concede nada —
# ou seja, o self-insert de um autenticado jamais o alcanca.
P -q -c "INSERT INTO public.profiles(user_id,document,is_employee) VALUES ('$B','$CPF',false);"
eq "A1 self-insert (is_employee=false) com o MESMO CPF nao concede NADA" "$(papel $B)" "NENHUM"
# e UPDATE tambem nao: o corpo early-returns quando TG_OP != 'INSERT'
P -q -c "UPDATE public.profiles SET is_employee=true WHERE user_id='$B';"
eq "A2 promover depois via UPDATE tampouco dispara (early-return de TG_OP)" "$(papel $B)" "NENHUM"

echo "-- ZONA 3: aplica a migration REAL --"
P -q -f "$MIG" >/dev/null
eq "A3 trigger removido" "$(trg_existe)" "0"
eq "A4 funcao removida" "$(fn_existe)" "0"
P -q -c "INSERT INTO public.profiles(user_id,document,is_employee) VALUES ('$C','$CPF',true);"
eq "A5 insert de EMPLOYEE com o CPF-alvo NAO concede mais nada" "$(papel $C)" "NENHUM"
eq "A6 quem ja tinha o papel NAO e afetado (a migration nao mexe em dado)" "$(papel $A)" "super_admin"

echo "-- ZONA 4: idempotencia (o founder pode re-colar) --"
P -q -f "$MIG" >/dev/null
eq "A7 re-aplicar nao quebra" "$(trg_existe)" "0"

echo "-- ZONA 5: FALSIFICACAO (sabota -> exige VERMELHO -> restaura) --"
falsificou() { if [ "$1" = "$2" ]; then bad "F$3 sabotagem NAO foi pega - o assert e teatro"; else ok "F$3 $4"; fi; }

# F1 - recria trigger+funcao (o estado de ORIGEM, que e como este banco regride de verdade:
# alguem recolando a migration velha, ou um restore). A5 tem de mudar de valor.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.auto_assign_commercial_super_admin() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE master_cpf_value TEXT; profile_doc TEXT;
BEGIN
  IF TG_OP != 'INSERT' THEN RETURN NEW; END IF;
  IF NEW.is_employee != true THEN RETURN NEW; END IF;
  SELECT value INTO master_cpf_value FROM public.company_config WHERE key = 'master_cpf';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  IF profile_doc = master_cpf_value THEN
    INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (NEW.user_id, 'super_admin')
    ON CONFLICT (user_id) DO UPDATE SET commercial_role = 'super_admin', updated_at = now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_auto_commercial_super_admin AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.auto_assign_commercial_super_admin();
SQL
P -q -c "INSERT INTO public.profiles(user_id,document,is_employee) VALUES ('$D','$CPF',true);"
falsificou "$(papel $D)" "NENHUM" 1 "restaurar trigger+funcao volta a conceder super_admin sozinho"
P -q -f "$MIG" >/dev/null
eq "F1b restaurado: trigger fora de novo" "$(trg_existe)" "0"

# F2 - sentinela anti-teatro: sabotagem inocua nao pode ficar vermelha.
P -q -c "COMMENT ON TABLE public.profiles IS 'inocuo';"
eq "F2 controle inocuo (COMMENT) mantem o veredito" "$(trg_existe)" "0"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

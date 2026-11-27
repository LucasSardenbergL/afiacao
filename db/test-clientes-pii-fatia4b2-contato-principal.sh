#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 4b-2 — contato principal atômico (contato_cliente_definir_principal)
# ║    bash db/test-clientes-pii-fatia4b2-contato-principal.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-fatia4b2-contato-principal.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Base: stubs do Supabase + o que a RPC toca, com as colunas/índices/ACL de PROD (psql-ro, 2026-11-26):
# ║  app_role, user_roles, has_role (corpo de prod), customer_contacts com o UNIQUE parcial de principal.
# ║  Negativos casam a SQLSTATE pelo NOME e re-lançam o resto. FALSIFICAÇÃO na MESMA invocação: suíte
# ║  verde antes, uma sabotagem POR CAMADA com o seu vermelho EXATO, suíte verde de novo depois.
# ╚══════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5498}"
SLUG="piifatia4b2"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261127000000_clientes_pii_fatia4b2_contato_principal.sql"

STAFF=00000000-0000-0000-0000-0000000000a1
MASTER=00000000-0000-0000-0000-0000000000a2
CLI=00000000-0000-0000-0000-0000000000c1   # um customer comum (sem papel de staff)
DONO_X=00000000-0000-0000-0000-0000000000d1
DONO_Y=00000000-0000-0000-0000-0000000000d2
X1=10000000-0000-0000-0000-000000000001; X2=10000000-0000-0000-0000-000000000002
X3=10000000-0000-0000-0000-000000000003; Y1=20000000-0000-0000-0000-000000000001
NADA=99999999-9999-9999-9999-999999999999

# ── ZONA 1: o que a RPC toca, espelhando a PROD ──
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE TABLE public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL, phone text NOT NULL,
  nome text, cargo text, email text, is_decision_maker boolean DEFAULT false, is_primary boolean DEFAULT false,
  whatsapp_only boolean DEFAULT false, birthday date, notas text, source text DEFAULT 'manual',
  created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE UNIQUE INDEX idx_customer_contacts_one_primary ON public.customer_contacts USING btree (customer_user_id) WHERE (is_primary = true);
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.customer_contacts TO authenticated;
GRANT ALL ON public.customer_contacts TO service_role;
SQL

semear() {
  P -q -c "TRUNCATE public.user_roles, public.customer_contacts;
    INSERT INTO public.user_roles (user_id, role) VALUES ('$STAFF','employee'), ('$MASTER','master'), ('$CLI','customer');
    INSERT INTO public.customer_contacts (id, customer_user_id, phone, is_primary) VALUES
      ('$X1','$DONO_X','(47) 1111-1111', true), ('$X2','$DONO_X','(47) 2222-2222', false),
      ('$X3','$DONO_X','(47) 3333-3333', false), ('$Y1','$DONO_Y','(47) 9999-9999', true);"
}

# como <uid|""> <sql> — authenticated com o JWT pela GUC REAL.
como() {
  local claims=''
  [ -n "$1" ] && claims="{\"sub\":\"$1\",\"role\":\"authenticated\"}"
  P -tA -q -c "SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false); SET ROLE authenticated; $2" 2>&1 | tail -n +2
}
# nega <role> <uid|""> <sqlstate-nome> <sql> — MARCA_BARRADO só na condição esperada; outro erro
# RE-LANÇADO (vira "outro:"); sucesso = MARCA_VAZOU.
nega() {
  local claims=''
  [ -n "$2" ] && claims="{\"sub\":\"$2\",\"role\":\"$1\"}"
  P -tA -q 2>&1 <<SQL || true
SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false);
SET ROLE $1;
DO \$neg\$
BEGIN
  BEGIN
    EXECUTE \$q\$ $4 \$q\$;
    RAISE NOTICE 'MARCA_VAZOU_7Q';
  EXCEPTION
    WHEN $3 THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
SQL
}
veredito() { case "$1" in *MARCA_BARRADO_7Q*) echo barrado ;; *MARCA_VAZOU_7Q*) echo vazou ;; *) echo "outro" ;; esac; }

principais() { P -tA -q -c "SELECT coalesce(string_agg(id::text, ',' ORDER BY id), '(nenhum)') FROM public.customer_contacts WHERE customer_user_id='$1' AND is_primary;"; }
definir() { como "$1" "SELECT public.contato_cliente_definir_principal('$2');" || true; }  # erro esperado nas sabotagens não derruba o set -e
acl_anon() { P -tA -q -c "SELECT has_function_privilege('anon', 'public.contato_cliente_definir_principal(uuid)', 'EXECUTE');"; }
acl_public() { P -tA -q -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'public.contato_cliente_definir_principal(uuid)'::regprocedure AND a.grantee = 0;"; }

# Resultados por assert (R_<nome>). Cada sabotagem olha o SEU. (Sem array associativo: bash 3.2 do macOS.)
rodar() {
  semear
  R_troca_ret="$(definir "$STAFF" "$X2" 2>&1 | tr -d '\n')"
  R_troca_x="$(principais "$DONO_X")"
  R_outro_dono="$(principais "$DONO_Y")"
  R_idempotente="$(definir "$MASTER" "$X2" >/dev/null 2>&1; principais "$DONO_X")"
  R_cliente="$(veredito "$(nega authenticated "$CLI" insufficient_privilege "SELECT public.contato_cliente_definir_principal('$X3')")")"
  R_cliente_efeito="$(principais "$DONO_X")"
  R_sem_jwt="$(veredito "$(nega authenticated "" insufficient_privilege "SELECT public.contato_cliente_definir_principal('$X3')")")"
  R_inexistente="$(veredito "$(nega authenticated "$STAFF" no_data_found "SELECT public.contato_cliente_definir_principal('$NADA')")")"
  R_nulo="$(veredito "$(nega authenticated "$STAFF" invalid_parameter_value "SELECT public.contato_cliente_definir_principal(NULL)")")"
  R_acl_anon="$(acl_anon)"
  R_acl_public="$(acl_public)"
}
suite() {
  rodar
  eq "staff troca o principal: devolve o dono da linha" "${R_troca_ret}" "$DONO_X"
  eq "dono X fica com UM principal, o novo" "${R_troca_x}" "$X2"
  eq "o principal do dono Y não é tocado" "${R_outro_dono}" "$Y1"
  eq "idempotente (master repete no mesmo contato)" "${R_idempotente}" "$X2"
  eq "customer sem papel de staff → 42501" "${R_cliente}" "barrado"
  eq "a recusa do customer não muda nada" "${R_cliente_efeito}" "$X2"
  eq "sem JWT → 42501" "${R_sem_jwt}" "barrado"
  eq "contato inexistente → P0002" "${R_inexistente}" "barrado"
  eq "contato nulo → 22023" "${R_nulo}" "barrado"
  eq "anon não executa" "${R_acl_anon}" "f"
  eq "PUBLIC não executa" "${R_acl_public}" "0"
}

echo "-- aplica a migration (com a postcondição) --"
if P -q -f "$MIG" 2>&1 | grep -c "fatia 4b-2 ok" | grep -qx 1; then ok "postcondição da migration passou"; else bad "postcondição não passou"; fi

echo "-- SUÍTE (verde) --"
suite

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; a suíte verde acima já rodou) ═════════
echo "-- FALSIFICAÇÃO: uma sabotagem por camada, cada uma com o SEU vermelho --"
exige_vermelho() { # <rótulo> <obtido> <correto> <vermelho-esperado>
  if [ "$2" = "$3" ]; then bad "$1 — sabotado ficou VERDE (assert não pega a camada) [$2]"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — vermelho ALHEIO ao mutante: esperado [$4], veio [$2]"; fi
}
# sabota <perl expr> — recria a função a partir da migration sabotada, sem a postcondição
sabota() {
  perl -0pe "$1" "$MIG" > "$RODADA/sabotada.sql"
  if cmp -s "$MIG" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a migration ($1)"; fi
  perl -0pi -e 's/DO \$post\$.*?\$post\$;//s' "$RODADA/sabotada.sql"
  P -q -c "DROP FUNCTION IF EXISTS public.contato_cliente_definir_principal(uuid);"
  P -q -f "$RODADA/sabotada.sql"
  rodar
}

sabota 's/IF v_uid IS NULL\n\s+OR NOT \(.*?\) THEN/IF false THEN/s'
exige_vermelho "S1 sem gate de staff" "${R_cliente}" "barrado" "vazou"

sabota 's/UPDATE public\.customer_contacts c SET is_primary = false\n.*?;\n//s'
exige_vermelho "S2 sem desligar o anterior" "${R_troca_x}" "$X2" "$X1"

sabota 's/WHERE c\.customer_user_id = v_dono AND c\.is_primary IS TRUE/WHERE c.is_primary IS TRUE/'
exige_vermelho "S3 desliga fora do dono" "${R_outro_dono}" "$Y1" "(nenhum)"

sabota 's/REVOKE ALL ON FUNCTION public\.contato_cliente_definir_principal\(uuid\) FROM PUBLIC, anon;\n//'
exige_vermelho "S4 sem REVOKE (anon)" "${R_acl_anon}" "f" "t"
exige_vermelho "S4 sem REVOKE (PUBLIC)" "${R_acl_public}" "0" "1"

sabota 's/IF NOT FOUND THEN\n\s+RAISE EXCEPTION .contato_cliente_definir_principal: contato inexistente. USING ERRCODE = .P0002.;\n\s+END IF;\n//'
exige_vermelho "S5 sem recusar contato inexistente" "${R_inexistente}" "barrado" "outro"

echo "-- CONTROLE: a migration real de novo, suíte verde --"
P -q -c "DROP FUNCTION IF EXISTS public.contato_cliente_definir_principal(uuid);"
P -q -f "$MIG" >/dev/null 2>&1
suite

echo "== $PASS OK · $FAIL XX (locale $LOCALE_TESTE) =="
[ "$FAIL" -eq 0 ] && echo "PROVA-4B2-VERDE"
[ "$FAIL" -eq 0 ]

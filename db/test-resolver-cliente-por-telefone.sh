#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — resolver_cliente_por_telefone: o discador reconhece o cliente, com FALSIFICAÇÃO
# ║      bash db/test-resolver-cliente-por-telefone.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-resolver-cliente-por-telefone.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-resolver-cliente-por-telefone.sh   (2º idioma do servidor)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Sobre a migration REAL (*_resolver_cliente_por_telefone.sql), com as policies de leitura COPIADAS
# ║  da prod (profiles, user_roles, customer_contacts; carteira_assignments simplificada para "dono ou
# ║  master", o recorte que importa aqui). Os asserts de busca rodam COMO A VENDEDORA, sob
# ║  SET ROLE authenticated — é a RLS real de quem chama, já que a função é SECURITY INVOKER.
# ║   · o caso que motivou: telefone gravado com hífen casa com o número discado (a busca antiga não);
# ║   · contato antes de perfil, com nome/cargo; perfil de staff não é cliente;
# ║   · ambiguidade: sem desempate → dono NULL com candidatos; desempate pela carteira de quem liga;
# ║   · telefone curto / sem dono → zero linhas;
# ║   · RLS: um customer não descobre o dono de outro telefone (invoker, não definer);
# ║   · a postcondição tem dente (sem o REVOKE do anon a migration aborta) e reaplicar é no-op.
# ╚══════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5581}"
SLUG="resolver-telefone"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C (o postmaster aborta sem isso); o idioma do SERVIDOR vem de $LOC

# ══════════════════════════════════════════════════════════════════════════════════════════════
# MODO --falsificar — o método de db/test-gemeos-push-pull-contagem-unica.sh: controle VERDE primeiro
# na MESMA invocação (vermelho aborta antes de sabotar), e cada sabotagem só conta se (1) aplicou,
# (2) a suíte rodou INTEIRA (mesmo PASS+FAIL do controle), (3) CADA assert declarado estava verde no
# controle e virou vermelho aqui, (4) sem ERRO de SQL que o controle não tem.
# ══════════════════════════════════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="ilike_cru:A1,A9 staff_vira_cliente:A3 sem_desempate:A5 ambiguo_escolhe:A4 aceita_placeholder:A15"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar (uma suíte que já falha sozinha aprovaria"
    echo "     todas as sabotagens por vermelhidão constante, não por dente)."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando antes de sabotar."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ A[0-9]+ ' "$log" | grep -Eo 'A[0-9]+' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  echo
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_resolver_cliente_por_telefone.sql" | sort | tail -1)"
[ -n "$MIG" ] && [ -f "$MIG" ] || { echo "❌ migration ausente: [$MIG] — a prova testaria o NADA"; exit 1; }

# ── sabotagem: copia a migration e troca UM trecho; o padrão tem de ocorrer (senão a prova mente) ──
MIG_USADA="$TMP/migration.sql"
cp "$MIG" "$MIG_USADA"
sabotar() {  # $1 = trecho original (literal), $2 = substituto
  local n; n="$(grep -cF -- "$1" "$MIG_USADA" || true)"
  [ "$n" -ge 1 ] || { echo "❌ padrão da sabotagem não ocorre na migration: [$1]"; exit 1; }
  ORIG="$1" NOVO="$2" perl -0pi -e 's/\Q$ENV{ORIG}\E/$ENV{NOVO}/g' "$MIG_USADA"
  echo "SABOTAGEM ATIVA em migration: ${SABOTAGEM} ($n ocorrência(s))"
}
case "${SABOTAGEM:-}" in
  "") ;;
  ilike_cru)          sabotar "right(regexp_replace(coalesce(pr.phone, ''), '\D', '', 'g'), 8) = v_sufixo" "pr.phone ILIKE '%' || v_sufixo || '%'" ;;
  staff_vira_cliente) sabotar "r.role IN ('employee'::public.app_role, 'master'::public.app_role)" "false" ;;
  sem_desempate)      sabotar "a.owner_user_id = auth.uid()" "false" ;;
  ambiguo_escolhe)    sabotar "IF cardinality(v_ids) = 1 THEN" "IF cardinality(v_ids) >= 1 THEN" ;;
  aceita_placeholder) sabotar "IF v_sufixo ~ '^(\\d)\\1{7}$' THEN" "IF false THEN" ;;
  *) echo "❌ sabotagem desconhecida: ${SABOTAGEM}"; exit 1 ;;
esac

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
-- Supabase concede EXECUTE de função nova a anon/authenticated/service_role por default privileges:
-- é por isso que a migration revoga o anon PELO NOME. Sem isto a prova não veria o grant a revogar.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (id serial PRIMARY KEY, user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text, phone text);
CREATE TABLE public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, phone text, nome text, cargo text,
  is_primary boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE public.carteira_assignments (id serial PRIMARY KEY, customer_user_id uuid, owner_user_id uuid, eligible boolean);

-- has_role como na prod (SECURITY DEFINER: as policies de user_roles o chamam sem recursão)
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
-- policies de LEITURA copiadas da prod (2026-10-10)
CREATE POLICY "Admins and employees can view all roles" ON public.user_roles FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Employees can view all profiles" ON public.profiles FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY customer_contacts_select_staff ON public.customer_contacts FOR SELECT
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));
-- prod: private.carteira_visivel_para(customer, uid) = master OU dono elegível OU cobertura. O recorte
-- que esta prova usa é o do dono — o desempate só olha a carteira do PRÓPRIO chamador.
CREATE POLICY carteira_visivel ON public.carteira_assignments FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR owner_user_id = auth.uid());
GRANT SELECT ON public.user_roles, public.profiles, public.customer_contacts, public.carteira_assignments TO authenticated;
SQL

# ── atores e dados ──
V="11111111-0000-0000-0000-000000000001"    # vendedora (employee) — quem liga
V2="11111111-0000-0000-0000-000000000002"   # outra vendedora (dona de carteira concorrente)
S="11111111-0000-0000-0000-000000000003"    # staff com telefone
C1="22222222-0000-0000-0000-000000000001"   # cliente com telefone COM HÍFEN (o caso real)
C2="22222222-0000-0000-0000-000000000002"   # cliente com contato cadastrado
C3="22222222-0000-0000-0000-000000000003"   # perfil com o MESMO telefone do contato de C2
C4="22222222-0000-0000-0000-000000000004"   # ambíguo, fora da carteira
C5="22222222-0000-0000-0000-000000000005"   # ambíguo, fora da carteira
C6="22222222-0000-0000-0000-000000000006"   # ambíguo, NA carteira de V
C7="22222222-0000-0000-0000-000000000007"   # ambíguo, na carteira de V2
P -q <<SQL
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$V','employee'), ('$V2','employee'), ('$S','employee'),
  ('$C1','customer'), ('$C2','customer'), ('$C3','customer'), ('$C4','customer'),
  ('$C5','customer'), ('$C6','customer'), ('$C7','customer');
INSERT INTO public.profiles (user_id, name, phone) VALUES
  ('$V','Vendedora',NULL), ('$V2','Vendedora 2',NULL), ('$S','Staff','(27) 98888-7777'),
  ('$C1','Cliente Hifen','99999-1234'),
  ('$C2','Cliente Contato',NULL), ('$C3','Perfil Mesmo Fone','27 3333-4444'),
  ('$C4','Amb A','98765-4321'), ('$C5','Amb B','(11) 98765-4321'),
  ('$C6','Amb Carteira','91234-5678'), ('$C7','Amb Outra','(27) 9 1234-5678');
INSERT INTO public.user_roles (user_id, role) VALUES ('22222222-0000-0000-0000-000000000008','customer');
INSERT INTO public.profiles (user_id, name, phone) VALUES ('22222222-0000-0000-0000-000000000008','Placeholder','99999-9999');
INSERT INTO public.customer_contacts (customer_user_id, phone, nome, cargo, is_primary) VALUES
  ('$C2','(27) 3333-4444','Joana','compras',true);
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES
  ('$C6','$V',true), ('$C7','$V2',true), ('$C4','$V',false);
SQL

echo "═══ setup PG17 :$PORT · locale do servidor=$LOC ═══"
P -q -f "$MIG_USADA" > /dev/null
echo "  migration aplicada: $(basename "$MIG")"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# resolve COMO o usuário $1 (authenticated + RLS real). Saída: id|nome|cargo|fonte|candidatos, ou VAZIO.
como() {
  local r
  # SET (não SELECT set_config): comando sem tupla, então a única linha impressa é a da busca
  r="$(Pq -q -c "SET test.uid = '$1'; SET ROLE authenticated; SELECT coalesce(customer_user_id::text,'NULL')||'|'||coalesce(contato_nome,'')||'|'||coalesce(contato_cargo,'')||'|'||fonte||'|'||candidatos FROM public.resolver_cliente_por_telefone('$2');")"
  printf '%s' "${r:-VAZIO}"
}

echo "── busca (como a vendedora, sob RLS) ──"
eq "A1 telefone com hífen casa com o discado formatado"      "$(como "$V" '(31) 99999-1234')" "$C1|||perfil|1"
eq "A2 contato antes de perfil, com nome e cargo"            "$(como "$V" '+55 27 3333-4444')" "$C2|Joana|compras|contato|1"
eq "A3 perfil de staff não é cliente"                         "$(como "$V" '27988887777')" "VAZIO"
eq "A4 ambíguo fora da carteira: dono NULL, 2 candidatos"     "$(como "$V" '98765-4321')" "NULL|||perfil|2"
eq "A6 telefone com menos de 8 dígitos: zero linhas"          "$(como "$V" '1234')" "VAZIO"
eq "A7 número sem dono: zero linhas"                          "$(como "$V" '(11) 90000-0001')" "VAZIO"
eq "A15 placeholder de dígito repetido não identifica ninguém" "$(como "$V" '(27) 99999-9999')" "VAZIO"
eq "A5 ambíguo: desempata pelo único candidato na carteira de quem liga" "$(como "$V" '(27) 91234-5678')" "$C6|||perfil|2"

echo "── RLS de quem chama (SECURITY INVOKER) ──"
eq "A8 customer não descobre o dono de outro telefone"        "$(como "$C4" '(31) 99999-1234')" "VAZIO"
eq "A9 customer só enxerga o próprio perfil (ambiguidade some)" "$(como "$C4" '98765-4321')" "$C4|||perfil|1"

echo "── postcondição e reaplicação ──"
anon_exec="$(Pq -c "SELECT has_function_privilege('anon', 'public.resolver_cliente_por_telefone(text)', 'EXECUTE')")"
eq "A10 anon não executa (revogado pelo nome)" "$anon_exec" "f"
auth_exec="$(Pq -c "SELECT has_function_privilege('authenticated', 'public.resolver_cliente_por_telefone(text)', 'EXECUTE')")"
eq "A11 authenticated executa" "$auth_exec" "t"
# dente: a função recriada do zero SEM o REVOKE do anon tem de abortar na P5 (rollback no fim)
SEM_REVOKE="$TMP/sem-revoke.sql"
grep -vF "FROM anon;" "$MIG" > "$SEM_REVOKE"
if out="$(P -q -c "BEGIN;" -c "DROP FUNCTION public.resolver_cliente_por_telefone(text);" -f "$SEM_REVOKE" -c "ROLLBACK;" 2>&1)"; then
  bad "A12 postcondição tem dente — sem o REVOKE do anon a migration TERMINOU (deveria abortar na P5)"
elif printf '%s' "$out" | grep -q 'P5 FALHOU'; then
  ok "A12 postcondição tem dente — sem o REVOKE do anon a migration aborta na P5"
else
  bad "A12 postcondição — abortou, mas não na P5: $(printf '%s' "$out" | grep -o 'P[0-9] FALHOU' | head -1)"
fi
if P -q -f "$MIG_USADA" > /dev/null 2>&1; then ok "A13 reaplicar a migration é no-op (termina verde)"; else bad "A13 reaplicar a migration falhou"; fi
eq "A14 reaplicar não devolve o EXECUTE ao anon" \
  "$(Pq -c "SELECT has_function_privilege('anon', 'public.resolver_cliente_por_telefone(text)', 'EXECUTE')")" "f"

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "═══ PROVA OK: resolver_cliente_por_telefone (locale do servidor=$LOC) ═══"

#!/usr/bin/env bash
# Prova PG17 — RPC listar_clientes_base (migration 20261121120001): ordenação por prioridade e
# filtro de saúde NO SERVIDOR, antes da paginação, sob a RLS de quem chama (SECURITY INVOKER).
# Rodar: bash db/test-listar-clientes-base.sh > log 2>&1; echo "exit=$?"   (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica a MIGRATION REAL; RLS provada sob SET ROLE authenticated + GUC; FALSIFICA
# com CONTROLE verde na MESMA invocação (a suíte roda 1x sobre a migration real e exige 0 RED,
# depois 1x por sabotagem e exige ≥1 RED — sempre-vermelha não aprova nada).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5481}"
SLUG="listar-clientes-base"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261121120001_listar_clientes_base.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
# shellcheck disable=SC2329  # invocada via trap
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -qc \
  "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;" || exit 1

DB=""
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -qtA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  RED $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER=aaaaaaaa-0000-0000-0000-000000000001
EMPREG=aaaaaaaa-0000-0000-0000-000000000002
CLI_A=cccccccc-0000-0000-0000-00000000000a
CLI_B=cccccccc-0000-0000-0000-00000000000b
CLI_C=cccccccc-0000-0000-0000-00000000000c
CLI_D=cccccccc-0000-0000-0000-00000000000d
CLI_E=cccccccc-0000-0000-0000-000000000001  # uid MENOR que o do Bravo: o empate de prioridade 30 só sai Bravo,Eco se o desempate for por NOME
CLI_F=cccccccc-0000-0000-0000-00000000000f

# helper: roda SQL sob authenticated com uid setado; imprime resultado ou o erro
como() { Pq -c "SET ROLE authenticated; SET test.uid = '$1'; $2" 2>&1; }
# lista os nomes na ordem devolvida, separados por vírgula
nomes() { como "$1" "SELECT string_agg(name, ',' ORDER BY ord) FROM (SELECT name, row_number() OVER () ord FROM public.listar_clientes_base($2)) t;" | tail -1; }

suite() { # $1 = arquivo de migration a provar
  local mig="$1"
  PASS=0; FAIL=0
  DB="prove_$RANDOM$RANDOM"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$DB" || { bad "createdb"; return; }

  # ── ZONA 1: stubs espelhando a PROD (conferido 2026-11-20 via psql-ro) ──
  P -q <<'SQL' || { bad "stubs"; return; }
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
-- helper REAL (corpo copiado de 20260929000234_padrao_like_contem_escapa_curinga.sql = PROD 2026-11-20)
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO authenticated;
CREATE FUNCTION private.padrao_like_contem(p_termo text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path TO '' AS $f$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END $f$;
GRANT EXECUTE ON FUNCTION private.padrao_like_contem(text) TO authenticated;
-- Supabase dá EXECUTE DIRETO a anon/authenticated em função nova (default privileges): sem isto o
-- REVOKE de PUBLIC sozinho pareceria fechar o anon — e a sabotagem "sem REVOKE anon" passava verde.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE, name text NOT NULL,
  email text, phone text, document text, customer_type text,
  created_at timestamptz NOT NULL DEFAULT now(), requires_po boolean NOT NULL DEFAULT false,
  is_employee boolean);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.profiles TO authenticated;
-- as 2 policies SELECT da prod
CREATE POLICY "Employees can view all profiles" ON public.profiles FOR SELECT
  USING ((SELECT has_role(auth.uid(), 'master'::app_role)) OR (SELECT has_role(auth.uid(), 'employee'::app_role)));
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);

CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE,
  priority_score numeric, health_class text, sales_history_status text);
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.farmer_client_scores TO authenticated;
-- stub da fcs_select_carteira: master vê tudo; o resto, só a própria carteira
CREATE TABLE public.carteira_stub (viewer uuid, customer uuid);
GRANT SELECT ON public.carteira_stub TO authenticated;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((SELECT has_role(auth.uid(), 'master'::app_role))
         OR customer_user_id IN (SELECT customer FROM public.carteira_stub WHERE viewer = auth.uid()));
SQL

  # ── ZONA 2: migration sob prova ──
  if ! P -q -f "$mig" >"$TMPD/apply.log" 2>&1; then
    bad "migration aplica — $(tail -c 300 "$TMPD/apply.log")"; return
  fi
  ok "migration aplica (postcondição A1-A4 passou)"

  # ── ZONA 3: seeds ──
  P -q <<SQL || { bad "seeds"; return; }
INSERT INTO public.user_roles VALUES ('$MASTER','master'), ('$EMPREG','employee'), ('$CLI_A','customer');
INSERT INTO public.profiles (user_id, name, email, phone, document, is_employee) VALUES
 ('$CLI_A', 'Alfa',     'alfa@x.com',  '111', '00000000000101', false),
 ('$CLI_B', 'Bravo',    'bravo@x.com', '222', '00000000000202', false),
 ('$CLI_C', 'Charlie',  'c@x.com',     '333', '00000000000303', false),
 ('$CLI_D', 'Delta',    'd@x.com',     '444', '00000000000404', false),
 ('$CLI_E', 'Eco 100%', 'e@x.com',     '555', '00000000000505', false),
 ('$CLI_F', 'Foxtrot',  'f@x.com',     '666', '00000000000606', false),
 ('$MASTER','Zulu Funcionario', 'z@x.com', '999', NULL, true);
-- Alfa=nunca comprou (sem_historico) mas com 67 cravado (o legado da edge) → tem de ir pro FIM.
-- Charlie = crítico ATIVO. Foxtrot = crítico mas sem_historico → NÃO entra no filtro "critico".
-- Delta = sem linha de score. Eco = estável, prioridade 30 (empata com Bravo: desempate por nome).
INSERT INTO public.farmer_client_scores (customer_user_id, priority_score, health_class, sales_history_status) VALUES
 ('$CLI_A', 67, 'critico',  'sem_historico'),
 ('$CLI_B', 30, 'saudavel', 'ativo'),
 ('$CLI_C', 60, 'critico',  'ativo'),
 ('$CLI_E', 30, 'estavel',  'stale'),
 ('$CLI_F', NULL, 'critico','sem_historico');
INSERT INTO public.carteira_stub VALUES ('$EMPREG', '$CLI_B');
SQL

  eq "guard: SET ROLE vale na sessão" "$(Pq -c "SET ROLE authenticated; SELECT current_user;")" "authenticated"

  # ordenação padrão: prioridade DESC NULLS LAST (sem_historico = NULL), desempate nome
  eq "master · prioridade: compradores no topo, sem_historico/sem score no fim" \
    "$(nomes $MASTER "")" "Charlie,Bravo,Eco 100%,Alfa,Delta,Foxtrot"
  eq "master · prioridade_ordenacao de sem_historico é NULL (67 cravado não vaza)" \
    "$(como $MASTER "SELECT coalesce(prioridade_ordenacao::text,'NULL') FROM public.listar_clientes_base() WHERE name='Alfa';" | tail -1)" "NULL"
  eq "master · ordem nome (A–Z, a de antes)" \
    "$(nomes $MASTER "p_ordem => 'nome'")" "Alfa,Bravo,Charlie,Delta,Eco 100%,Foxtrot"
  eq "funcionário is_employee fora da lista" \
    "$(como $MASTER "SELECT count(*) FROM public.listar_clientes_base() WHERE name LIKE 'Zulu%';" | tail -1)" "0"

  # total = recorte filtrado, antes da paginação; paginação estável e completa
  eq "total em toda linha = 6" \
    "$(como $MASTER "SELECT string_agg(DISTINCT total::text, ',') FROM public.listar_clientes_base();" | tail -1)" "6"
  eq "página 2 (limite 2, offset 2) continua a ordem, total ainda 6" \
    "$(como $MASTER "SELECT string_agg(name || ':' || total, ',' ORDER BY o) FROM (SELECT name, total, row_number() OVER () o FROM public.listar_clientes_base(p_limite => 2, p_offset => 2)) t;" | tail -1)" "Eco 100%:6,Alfa:6"
  eq "paginar de 1 em 1 cobre os 6 sem repetir" \
    "$(como $MASTER "SELECT count(DISTINCT x.user_id) FROM generate_series(0,5) g, LATERAL public.listar_clientes_base(p_limite => 1, p_offset => g) x;" | tail -1)" "6"

  # filtro de saúde NO SERVIDOR
  eq "saude=critico: só o crítico ATIVO (sem_historico fora)" "$(nomes $MASTER "p_saude => 'critico'")" "Charlie"
  eq "saude=critico: total do recorte = 1" \
    "$(como $MASTER "SELECT max(total) FROM public.listar_clientes_base(p_saude => 'critico');" | tail -1)" "1"
  eq "saude=sem_historico: os dois nunca-compradores" "$(nomes $MASTER "p_saude => 'sem_historico'")" "Alfa,Foxtrot"
  eq "saude=all = sem filtro" "$(como $MASTER "SELECT max(total) FROM public.listar_clientes_base(p_saude => 'all');" | tail -1)" "6"
  eq "saude + ordem nome combinam" "$(nomes $MASTER "p_saude => 'sem_historico', p_ordem => 'nome'")" "Alfa,Foxtrot"

  # busca: ILIKE nas 4 colunas, wildcard do usuário é literal
  eq "busca por nome (caixa)" "$(nomes $MASTER "p_busca => 'BRAV'")" "Bravo"
  eq "busca por documento" "$(nomes $MASTER "p_busca => '0303'")" "Charlie"
  eq "busca '%' é literal (não casa tudo)" "$(nomes $MASTER "p_busca => '100%'")" "Eco 100%"
  eq "busca '_' (sem conteúdo útil) não casa nada" "$(como $MASTER "SELECT count(*) FROM public.listar_clientes_base(p_busca => '_');" | tail -1)" "0"
  eq "busca 'o_1' é literal (o '_' não é curinga)" "$(como $MASTER "SELECT count(*) FROM public.listar_clientes_base(p_busca => 'o_1');" | tail -1)" "0"
  eq "busca + filtro" "$(nomes $MASTER "p_busca => 'x.com', p_saude => 'critico'")" "Charlie"

  # RLS do chamador (INVOKER): funcionário vê os profiles, mas só o score da própria carteira
  eq "funcionário: só Bravo tem prioridade visível → Bravo no topo" \
    "$(nomes $EMPREG "")" "Bravo,Alfa,Charlie,Delta,Eco 100%,Foxtrot"
  eq "funcionário · saude=critico: score fora da carteira é invisível → 0" \
    "$(como $EMPREG "SELECT count(*) FROM public.listar_clientes_base(p_saude => 'critico');" | tail -1)" "0"
  eq "customer: só o próprio profile" "$(nomes $CLI_A "")" "Alfa"

  # ACL: anon fechado
  R=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.listar_clientes_base();" 2>&1 | tail -1)
  case "$R" in *"permission denied"*) ok "anon sem EXECUTE";; *) bad "anon deveria ser negado — veio [$R]";; esac

  # parâmetros inválidos → 22023 (marca do ramo, não "lançou algo")
  for arg in "p_ordem => 'xyz'" "p_saude => 'otimo'" "p_limite => 501" "p_limite => 0" "p_offset => -1"; do
    R=$(Pq -v VERBOSITY=verbose -c "SET ROLE authenticated; SET test.uid='$MASTER'; SELECT 1 FROM public.listar_clientes_base($arg);" 2>&1 | tr -d '\n')
    case "$R" in *"22023"*"listar_clientes_base: p_"*) ok "inválido ($arg) → 22023";; *) bad "inválido ($arg) — veio [$R]";; esac
  done
}

echo "=== CONTROLE: migration real (exige 0 RED) ==="
suite "$MIG"
echo "controle: PASS=$PASS FAIL=$FAIL"
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 20 ]; then echo "CONTROLE VERMELHO — nada a falsificar"; exit 1; fi
CTRL_PASS=$PASS

echo "=== FALSIFICAÇÃO (cada sabotagem exige o RED do SEU assert, não um vermelho qualquer) ==="
FALS_OK=0; FALS_TOTAL=0
sabota() { # $1 rótulo  $2 expressão sed  $3 início do assert que TEM de acusar
  FALS_TOTAL=$((FALS_TOTAL+1))
  local cp="$TMPD/sab_$FALS_TOTAL.sql" log="$TMPD/sab_$FALS_TOTAL.log"
  sed -E "$2" "$MIG" > "$cp"
  if cmp -s "$cp" "$MIG"; then echo "  RED sabotagem '$1' não alterou o arquivo (sed não casou)"; return; fi
  suite "$cp" >"$log" 2>&1
  if grep -qF "  RED $3" "$log"; then FALS_OK=$((FALS_OK+1)); echo "  OK  '$1' pego por «$3» ($FAIL RED)";
  else echo "  RED '$1' NÃO acusado por «$3» (FAIL=$FAIL): $(grep '  RED' "$log" | head -2 | tr '\n' ' ')"; fi
}
sabota "NULLS FIRST"                          's/DESC NULLS LAST/DESC NULLS FIRST/' "master · prioridade: compradores"
sabota "prioridade de sem_historico vaza"     "s/CASE WHEN s.sales_history_status = 'sem_historico' THEN NULL ELSE s.priority_score END/s.priority_score/" "master · prioridade_ordenacao de sem_historico"
sabota "filtro de classe aceita sem_historico" "s/AND s.sales_history_status IS DISTINCT FROM 'sem_historico'\)\)/))/" "saude=critico: só o crítico ATIVO"
sabota "SECURITY DEFINER"                     's/^SECURITY INVOKER$/SECURITY DEFINER/' "migration aplica"
sabota "sem REVOKE anon"                      '/FROM anon;/d' "migration aplica"
sabota "desempate por uid, não por nome"      's/^    r\.nome,$/    r.uid,/' "master · prioridade: compradores"
sabota "curinga do usuário vira curinga"      "s/private\.padrao_like_contem\(v_busca\)/('%' || v_busca || '%')/g" "busca 'o_1' é literal"
sabota "termo sem conteúdo vira sem filtro"   's/AND \(v_busca IS NULL/AND (private.padrao_like_contem(v_busca) IS NULL/' "busca '_' (sem conteúdo útil)"
sabota "total depois da paginação"            's/count\(\*\) OVER \(\)/1::bigint/' "total em toda linha"

echo "falsificação: $FALS_OK/$FALS_TOTAL sabotagens pegas"
if [ "$FALS_OK" -ne "$FALS_TOTAL" ]; then echo "FALSIFICAÇÃO INCOMPLETA"; exit 1; fi
echo "PROVA_LISTAR_CLIENTES_BASE_OK controle=$CTRL_PASS falsificacao=$FALS_OK/$FALS_TOTAL"

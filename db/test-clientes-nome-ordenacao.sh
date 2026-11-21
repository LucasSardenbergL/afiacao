#!/usr/bin/env bash
# Prova PG17 — migration 20261121132032 (clientes_nome_ordenacao): a RPC listar_clientes_base passa a
# ordenar A–Z por private.nome_ordenacao(name) (nome do Omie normalizado: prefixo MEI, entidade HTML,
# símbolo inicial, acento, caixa, espaço) e a devolver a chave em `nome_ordenacao`. Re-prova TODO o
# comportamento da predecessora (20261121120001, aplicada ANTES — o estado da PROD) + idempotência,
# PRE anti-deriva e a ordem do `.order()` do cliente por cima. Roda em DOIS collations: C e ICU en-US
# (a PROD é en_US.UTF-8 glibc; o libc do macOS ordena por byte, então o "en_US" do Mac não simula).
# Rodar: bash db/test-clientes-nome-ordenacao.sh > log 2>&1; echo "exit=$?"   (NAO pipe pra tail — engole exit)
# Lei de Ferro: aplica a MIGRATION REAL; RLS provada sob SET ROLE authenticated + GUC; FALSIFICA
# com CONTROLE verde na MESMA invocação (a suíte roda 1x sobre a migration real e exige 0 RED,
# depois 1x por sabotagem e exige ≥1 RED — sempre-vermelha não aprova nada).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5483}"
SLUG="clientes-nome-ordenacao"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
BASE="$REPO_ROOT/supabase/migrations/20261121120001_listar_clientes_base.sql"
MIG="$REPO_ROOT/supabase/migrations/20261121132032_clientes_nome_ordenacao.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
for f in "$BASE" "$MIG"; do [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }; done
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
  # shellcheck disable=SC2086  # COLL_ARGS é lista de flags, split intencional
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T template0 $COLL_ARGS "$DB" || { bad "createdb ($COLL_ARGS)"; return; }

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
GRANT USAGE ON SCHEMA private TO authenticated, anon;  -- PROD: anon TEM usage em private (psql-ro 2026-11-21)
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

  # ── ZONA 2: predecessora (= PROD) e depois a migration sob prova ──
  if ! P -q -f "$BASE" >"$TMPD/base.log" 2>&1; then
    bad "predecessora aplica — $(tail -c 300 "$TMPD/base.log")"; return
  fi
  if ! P -q -f "$mig" >"$TMPD/apply.log" 2>&1; then
    bad "migration aplica — $(tail -c 300 "$TMPD/apply.log")"; return
  fi
  ok "migration aplica (PRE + postcondição A1-A7 passaram)"
  if P -q -f "$mig" >"$TMPD/apply2.log" 2>&1; then ok "re-aplicar é idempotente (PRE aceita esta versão)"
  else bad "re-aplicar é idempotente — $(tail -c 300 "$TMPD/apply2.log")"; fi

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
  eq "master · ordem nome: prioridade_ordenacao toda NULL (o .order do cliente não re-ordena)" \
    "$(como $MASTER "SELECT count(prioridade_ordenacao) FROM public.listar_clientes_base(p_ordem => 'nome');" | tail -1)" "0"
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

  # ── A–Z NORMALIZADO: nomes sujos do Omie (casos reais do diagnóstico 2026-11-21) ──
  # entram DEPOIS dos asserts acima (que contam 6 linhas) e só no A–Z.
  P -q <<'SQL' || { bad "seeds sujos"; return; }
INSERT INTO public.profiles (user_id, name, is_employee) VALUES
 ('dddddddd-0000-0000-0000-000000000001', '04.763.245 BRUNO  SILVA', false),
 ('dddddddd-0000-0000-0000-000000000002', '&apos;CHARLES&apos;', false),
 ('dddddddd-0000-0000-0000-000000000003', '. ÁGUIA AZUL', false),
 ('dddddddd-0000-0000-0000-000000000004', '3M DO BRASIL', false),
 ('dddddddd-0000-0000-0000-000000000005', '+++', false),
 ('dddddddd-0000-0000-0000-000000000006', 'S &amp; A GRANITOS', false);
SQL
  eq "A–Z normalizado: dígito real, lixo inicial/MEI/entidade ignorados, só-lixo no fim" \
    "$(nomes $MASTER "p_ordem => 'nome'")" \
    "3M DO BRASIL,. ÁGUIA AZUL,Alfa,Bravo,04.763.245 BRUNO  SILVA,&apos;CHARLES&apos;,Charlie,Delta,Eco 100%,Foxtrot,S &amp; A GRANITOS,+++"
  eq "nome exibido intacto e chave devolvida" \
    "$(como $MASTER "SELECT name || '=' || nome_ordenacao FROM public.listar_clientes_base(p_ordem => 'nome') WHERE user_id = 'dddddddd-0000-0000-0000-000000000001';" | tail -1)" \
    "04.763.245 BRUNO  SILVA=bruno silva"
  # o .order() do cliente (prioridade_ordenacao desc nullslast, nome_ordenacao nullslast, name, user_id)
  # por cima da página tem de dar a MESMA sequência — nas duas ordens
  for o in nome prioridade; do
    eq "ordem $o: .order() do cliente por cima não re-ordena" \
      "$(como $MASTER "SELECT string_agg(name, ',' ORDER BY prioridade_ordenacao DESC NULLS LAST, nome_ordenacao NULLS LAST, name, user_id) = (SELECT string_agg(name, ',' ORDER BY ord) FROM (SELECT name, row_number() OVER () ord FROM public.listar_clientes_base(p_ordem => '$o')) t) FROM public.listar_clientes_base(p_ordem => '$o');" | tail -1)" "t"
  done
  eq "A–Z: paginar de 1 em 1 cobre as 12 sem repetir" \
    "$(como $MASTER "SELECT count(DISTINCT x.user_id) FROM generate_series(0,11) g, LATERAL public.listar_clientes_base(p_ordem => 'nome', p_limite => 1, p_offset => g) x;" | tail -1)" "12"
  eq "busca continua no nome CRU" "$(nomes $MASTER "p_busca => 'amp;'")" "S &amp; A GRANITOS"
  eq "md5 do corpo vivo = o 'este' da PRE" \
    "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.listar_clientes_base(text,text,text,integer,integer)'::regprocedure;")" \
    "$(grep -oE "'46eb4a002af03433488b875823ed3c74', '[0-9a-f]{32}'" "$mig" | grep -oE "[0-9a-f]{32}'$" | tr -d "'")"
  R=$(Pq -c "SET ROLE anon; SELECT private.nome_ordenacao('x');" 2>&1 | tr -d '\n')
  case "$R" in *"permission denied for function nome_ordenacao"*) ok "anon sem EXECUTE em nome_ordenacao";; *) bad "anon deveria ser negado em nome_ordenacao — veio [$R]";; esac

  # ACL: anon fechado
  R=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.listar_clientes_base();" 2>&1 | tail -1)
  case "$R" in *"permission denied"*) ok "anon sem EXECUTE";; *) bad "anon deveria ser negado — veio [$R]";; esac

  # parâmetros inválidos → 22023 (marca do ramo, não "lançou algo")
  for arg in "p_ordem => 'xyz'" "p_saude => 'otimo'" "p_limite => 501" "p_limite => 0" "p_offset => -1"; do
    R=$(Pq -v VERBOSITY=verbose -c "SET ROLE authenticated; SET test.uid='$MASTER'; SELECT 1 FROM public.listar_clientes_base($arg);" 2>&1 | tr -d '\n')
    case "$R" in *"22023"*"listar_clientes_base: p_"*) ok "inválido ($arg) → 22023";; *) bad "inválido ($arg) — veio [$R]";; esac
  done
}

COLL_C="--locale=C"
COLL_ICU="--locale-provider=icu --icu-locale=en-US --locale=C"
CTRL_PASS=0
for COLL_ARGS in "$COLL_ICU" "$COLL_C"; do
  echo "=== CONTROLE [$COLL_ARGS]: migration real (exige 0 RED) ==="
  suite "$MIG"
  echo "controle [$COLL_ARGS]: PASS=$PASS FAIL=$FAIL"
  if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 30 ]; then echo "CONTROLE VERMELHO — nada a falsificar"; exit 1; fi
  CTRL_PASS=$((CTRL_PASS+PASS))
done
COLL_ARGS="$COLL_ICU"   # falsificação no collation que espelha a PROD

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
sabota "desempate por uid, não por nome"      's/^    r\.nome_ord NULLS LAST,$/    r.uid,/' "master · prioridade: compradores"
sabota "curinga do usuário vira curinga"      "s/private\.padrao_like_contem\(v_busca\)/('%' || v_busca || '%')/g" "busca 'o_1' é literal"
sabota "termo sem conteúdo vira sem filtro"   's/AND \(v_busca IS NULL/AND (private.padrao_like_contem(v_busca) IS NULL/' "busca '_' (sem conteúdo útil)"
sabota "nome expõe a prioridade"            "s/CASE WHEN p_ordem = 'prioridade' THEN r.prio END, count/r.prio, count/" "master · ordem nome: prioridade_ordenacao"
sabota "total depois da paginação"            's/count\(\*\) OVER \(\)/1::bigint/' "total em toda linha"
sabota "A–Z pelo nome cru"                    's/^    r\.nome_ord NULLS LAST,$/    r.nome,/' "A–Z normalizado"
sabota "só-lixo (NULL) no topo"               's/^    r\.nome_ord NULLS LAST,$/    r.nome_ord NULLS FIRST,/' "A–Z normalizado"
sabota "chave devolvida ≠ chave ordenada"     's/count\(\*\) OVER \(\), r\.nome_ord$/count(*) OVER (), lower(r.nome)/' "ordem nome: .order() do cliente"
sabota "prefixo MEI não sai"                  's/\[0-9\]\{2\}\\\.\[0-9\]\{3\}\\\.\[0-9\]\{3\}/XX-MEI-XX/' "migration aplica"
sabota "entidade HTML não sai"                "s/'&\(#\[0-9\]\+\|#x\[0-9a-f\]\+\|\[a-z\]\+\);'/'\&nada;'/" "migration aplica"
sabota "nome_ordenacao aberta a PUBLIC"       '/nome_ordenacao\(text\) FROM PUBLIC;/d' "migration aplica"
sabota "PRE não reconhece o predecessor"      's/46eb4a002af03433488b875823ed3c74/00000000000000000000000000000000/' "migration aplica"

echo "falsificação: $FALS_OK/$FALS_TOTAL sabotagens pegas"
if [ "$FALS_OK" -ne "$FALS_TOTAL" ]; then echo "FALSIFICAÇÃO INCOMPLETA"; exit 1; fi
echo "PROVA_CLIENTES_NOME_ORDENACAO_OK controle=$CTRL_PASS falsificacao=$FALS_OK/$FALS_TOTAL"

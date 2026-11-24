#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 da onda D / fatia 1 — contrato "pode agir" + "contato visível"     ║
# ║    bash db/test-clientes-pii-contrato-carteira.sh > log 2>&1; echo $?          ║
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-contrato-carteira.sh     ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                               ║
# ║  Migration real: 20261124120000_clientes_pii_contrato_carteira.sql            ║
# ║  Personas: farmer F (dona), outra dona O, cobertura K (vigente) e K2 (vencida),║
# ║  gestor G, master M, back-office B (sem carteira), ex-employee X, customer C1. ║
# ║  Casos: alias fiscal (raiz + clone), raiz AMBÍGUA, fornecedor (eligible=false).║
# ║  JWT pela GUC real request.jwt.claims (auth.uid() do stub espelha a prod).     ║
# ║  FALSIFICAÇÃO na MESMA invocação: controle verde antes, 9 sabotagens, cada uma ║
# ║  exige o SEU vermelho exato, restauração exige verde de novo.                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5493}"
SLUG="clientespii"
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

MIG="$REPO_ROOT/supabase/migrations/20261124120000_clientes_pii_contrato_carteira.sql"

# ── ZONA 1: stubs espelhando a PROD (psql-ro, 2026-11-24) ─────────────────────
P -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA public  TO authenticated, anon, service_role;
-- DEFAULT PRIVILEGES do Supabase: objeto novo em public NASCE ABERTO (sem isto o harness nasce fechado
-- por acidente e os asserts de ACL ficariam verdes de graça).
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TYPE public.commercial_role AS ENUM ('farmer', 'hunter', 'gerencial', 'estrategico', 'super_admin', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.commercial_roles (user_id uuid UNIQUE, commercial_role public.commercial_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_uid uuid)
 RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _uid $f$;
-- corpo de prod de private.pode_ver_carteira_completa
CREATE OR REPLACE FUNCTION private.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT has_role(_uid, 'master'::app_role)
      OR (has_role(_uid, 'employee'::app_role)
          AND get_commercial_role(_uid) IN ('gerencial'::commercial_role, 'estrategico'::commercial_role, 'super_admin'::commercial_role));
$f$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, name text, email text, phone text,
  document text, cnpj text, razao_social text, is_employee boolean DEFAULT false
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Employees can view all profiles" ON public.profiles FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role) OR ( SELECT has_role(auth.uid(), 'employee'::app_role) AS has_role)));
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING ((auth.uid() = user_id));

CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, owner_user_id uuid, eligible boolean
);
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid PRIMARY KEY, canonical_user_id uuid, status text);
CREATE TABLE public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), covering_user_id uuid, covered_user_id uuid,
  valid_until timestamptz, active boolean
);
CREATE TABLE public.venda_contato (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_user_id uuid, comprador_id uuid, dia date,
  resultado text, motivo text, criado_em timestamptz DEFAULT now(), atualizado_em timestamptz DEFAULT now(),
  UNIQUE (farmer_user_id, comprador_id, dia)
);
SQL

# ── seed ──────────────────────────────────────────────────────────────────────
F=f0000000-0000-0000-0000-00000000000f   # farmer (dona)
O=0b000000-0000-0000-0000-00000000000b   # outra dona
K=c0000000-0000-0000-0000-0000000000c1   # cobre O (vigente)
K2=c0000000-0000-0000-0000-0000000000c2  # cobre O (vencida)
G=9e000000-0000-0000-0000-000000000009   # gestor (employee + gerencial)
M=3a000000-0000-0000-0000-000000000003   # master
B=b0000000-0000-0000-0000-0000000000b0   # back-office sem carteira
X=e0000000-0000-0000-0000-0000000000e0   # ex-employee (atribuição residual, sem papel)
E=e1000000-0000-0000-0000-0000000000e1   # employee com profile (não pode aparecer como cliente)
C1=10000000-0000-0000-0000-000000000001  # cliente da F (também é o customer self)
CR=20000000-0000-0000-0000-000000000002  # raiz fiscal da F
CA=21000000-0000-0000-0000-000000000021  # alias (clone eligible=false, sem profiles) → CR
C3=30000000-0000-0000-0000-000000000003  # cliente de O
CF=40000000-0000-0000-0000-000000000004  # fornecedor: atribuição da F eligible=false
AR=50000000-0000-0000-0000-000000000005  # raiz AMBÍGUA (dona O)
AA=51000000-0000-0000-0000-000000000051  # alias de AR com atribuição elegível da F
C5=60000000-0000-0000-0000-000000000006  # atribuição do ex-employee X

P -q <<SQL
INSERT INTO public.user_roles VALUES
 ('$F','employee'),('$O','employee'),('$K','employee'),('$K2','employee'),('$G','employee'),
 ('$M','master'),('$B','employee'),('$E','employee'),('$C1','customer');
INSERT INTO public.commercial_roles VALUES ('$F','farmer'),('$G','gerencial');
INSERT INTO public.profiles(user_id,name,email,phone,document,cnpj,razao_social,is_employee) VALUES
 ('$C1','Cliente Um','um@x.test','fone-c1','doc-c1',NULL,'Um Ltda',false),
 ('$CR','Cliente Raiz','raiz@x.test','fone-cr','doc-cr','cnpj-cr','Raiz SA',false),
 ('$C3','Cliente Tres','tres@x.test','fone-c3','doc-c3','cnpj-c3','Tres Ltda',false),
 ('$CF','Fornecedor Quatro','forn@x.test','fone-cf','doc-cf',NULL,'Forn',false),
 ('$AR','Grupo Ambiguo','amb@x.test','fone-ar','doc-ar',NULL,'Amb',false),
 ('$AA','Grupo Ambiguo Filial','ambf@x.test','fone-aa','doc-aa',NULL,'AmbF',false),
 ('$C5','Cliente Cinco','cinco@x.test','fone-c5','doc-c5',NULL,'Cinco',false),
 ('$E','Funcionaria Cliente','func@x.test','fone-e','doc-e',NULL,NULL,true);
INSERT INTO public.carteira_assignments(customer_user_id,owner_user_id,eligible) VALUES
 ('$C1','$F',true),('$CR','$F',true),('$CA','$F',false),('$C3','$O',true),('$CF','$F',false),
 ('$AR','$O',true),('$AA','$F',true),('$C5','$X',true);
INSERT INTO public.customer_canonical_alias VALUES ('$CA','$CR','active'),('$AA','$AR','active');
INSERT INTO public.carteira_coverage(covering_user_id,covered_user_id,valid_until,active) VALUES
 ('$K','$O',NULL,true),('$K2','$O',now() - interval '1 day',true);
SQL

# como <uid|""> <sql> — authenticated com o JWT pela GUC REAL (pg_catalog.set_config qualificado).
como() {
  local claims=''
  [ -n "$1" ] && claims="{\"sub\":\"$1\",\"role\":\"authenticated\"}"
  P -tA -q -c "SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false); SET ROLE authenticated; $2" 2>&1 | tail -n +2
}
# nega <role> <uid|""> <sql> — MARCA_BARRADO só em 42501; outro erro RE-LANÇADO; sucesso = MARCA_VAZOU.
nega() {
  local claims=''
  [ -n "$2" ] && claims="{\"sub\":\"$2\",\"role\":\"$1\"}"
  P -tA -q 2>&1 <<SQL || true
SELECT pg_catalog.set_config('request.jwt.claims', '$claims', false);
SET ROLE $1;
DO \$neg\$
BEGIN
  BEGIN
    EXECUTE \$q\$ $3 \$q\$;
    RAISE NOTICE 'MARCA_VAZOU_7Q';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_7Q';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
SQL
}
veredito() { case "$1" in *MARCA_BARRADO_7Q*) echo barrado ;; *MARCA_VAZOU_7Q*) echo vazou ;; *) echo "outro: $1" ;; esac; }
agir() { como "$1" "SELECT public.pode_agir_no_cliente('$2')::text;"; }
fone() { como "$1" "SELECT coalesce(contato_visivel::text,'(sem-linha)')||'|'||coalesce(phone,'(null)') FROM public.v_perfil_contato WHERE user_id='$2' UNION ALL SELECT '(sem-linha)' WHERE NOT EXISTS (SELECT 1 FROM public.v_perfil_contato WHERE user_id='$2');"; }
busca() { como "$1" "SELECT coalesce(string_agg(name||':'||contato_visivel||':'||coalesce(documento,'(null)'), ',' ORDER BY name),'(vazio)') FROM public.buscar_clientes_global('$2');"; }

echo "-- L. linha de base: a fatia 1 NÃO fecha a tabela (lacuna declarada → fatia 3) --"
eq "L1 farmer lê o telefone do cliente alheio DIRETO de profiles (furo que a fatia 3 fecha)" \
   "$(como $F "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "fone-c3"

P -q -f "$MIG"
echo "migration aplicada"

asserts() {
  echo "-- A. pode_agir_no_cliente --"
  eq "A1 farmer no cliente dela" "$(agir $F $C1)" "true"
  eq "A2 farmer na raiz fiscal dela" "$(agir $F $CR)" "true"
  eq "A3 farmer no ALIAS (clone eligible=false) da raiz dela" "$(agir $F $CA)" "true"
  eq "A4 farmer fora da carteira" "$(agir $F $C3)" "false"
  eq "A5 fornecedor (atribuição eligible=false) não concede" "$(agir $F $CF)" "false"
  eq "A6 raiz AMBÍGUA: farmer age no alias atribuído direto" "$(agir $F $AA)" "true"
  eq "A7 raiz AMBÍGUA não expande para a raiz" "$(agir $F $AR)" "false"
  eq "A8 cobertura LÊ mas não age" "$(agir $K $C3)" "false"
  eq "A9 ex-employee com atribuição residual não age" "$(agir $X $C5)" "false"
  eq "A10 sem uid → false" "$(como "" "SELECT public.pode_agir_no_cliente('$C1')::text;")" "false"
  eq "A11 anon não executa (42501)" "$(veredito "$(nega anon "" "SELECT public.pode_agir_no_cliente('$C1')")")" "barrado"

  echo "-- V. v_perfil_contato --"
  eq "V1 farmer: contato do cliente dela" "$(fone $F $C1)" "true|fone-c1"
  eq "V2 farmer: cliente alheio = linha presente, mascarado" "$(fone $F $C3)" "false|(null)"
  eq "V3 farmer: alias/raiz visível" "$(fone $F $CR)" "true|fone-cr"
  eq "V3b fora da carteira: PJ/PF segue (identidade), número não" \
     "$(como $F "SELECT eh_pj::text||'|'||coalesce(document,'(null)') FROM public.v_perfil_contato WHERE user_id='$C3';")" "false|(null)"
  eq "V4 oráculo por FILTRO no valor oculto → 0 linhas" \
     "$(como $F "SELECT count(*) FROM public.v_perfil_contato WHERE phone='fone-c3';")" "0"
  eq "V5 cobertura vigente vê" "$(fone $K $C3)" "true|fone-c3"
  eq "V6 cobertura VENCIDA não vê" "$(fone $K2 $C3)" "false|(null)"
  eq "V7 gestor vê" "$(fone $G $C3)" "true|fone-c3"
  eq "V8 master vê" "$(fone $M $C3)" "true|fone-c3"
  eq "V9 back-office sem carteira: mascarado" "$(fone $B $C3)" "false|(null)"
  eq "V10 customer vê o PRÓPRIO contato" "$(fone $C1 $C1)" "true|fone-c1"
  eq "V11 customer não recebe linha alheia" "$(fone $C1 $C3)" "(sem-linha)"
  eq "V12 sem uid → 0 linhas" "$(como "" "SELECT count(*) FROM public.v_perfil_contato;")" "0"
  eq "V13 anon não lê a view (42501)" "$(veredito "$(nega anon "" "SELECT 1 FROM public.v_perfil_contato")")" "barrado"
  # A view não é auto-atualizável (LATERAL) E não tem privilégio de escrita: o assert é o de CATÁLOGO
  # (o ACL é o que sobraria se alguém a simplificasse), por isso K10 sabota o GRANT.
  eq "V14 authenticated sem INSERT/UPDATE/DELETE na view" \
     "$(P -tA -q -c "SELECT has_table_privilege('authenticated','public.v_perfil_contato','INSERT,UPDATE,DELETE')::text;")" "false"

  echo "-- W. venda_registrar_contato (escritor do desfecho) --"
  P -q -c "DELETE FROM public.venda_contato;" >/dev/null
  como $F "SELECT public.venda_registrar_contato('$CA','vendeu') IS NOT NULL;" >/dev/null
  eq "W1 farmer registra no ALIAS → grava na raiz" \
     "$(P -tA -q -c "SELECT string_agg(comprador_id::text, ',') FROM public.venda_contato;")" "$CR"
  eq "W2 fornecedor (eligible=false) → 42501" \
     "$(veredito "$(nega authenticated $F "SELECT public.venda_registrar_contato('$CF','vendeu')")")" "barrado"
  eq "W3 cobertura → 42501" \
     "$(veredito "$(nega authenticated $K "SELECT public.venda_registrar_contato('$C3','vendeu')")")" "barrado"
  eq "W4 fora da carteira → 42501" \
     "$(veredito "$(nega authenticated $F "SELECT public.venda_registrar_contato('$C3','vendeu')")")" "barrado"

  echo "-- S. buscar_clientes_global (Cmd-K) --"
  eq "S1 nome de cliente alheio acha, mascarado" "$(busca $F "Tres")" "Cliente Tres:false:(null)"
  eq "S2 documento de cliente alheio = igual a termo ausente" "$(busca $F "doc-c3")" "(vazio)"
  eq "S3 documento de cliente da carteira acha, com documento" "$(busca $F "doc-c1")" "Cliente Um:true:doc-c1"
  eq "S4 funcionária nunca aparece como cliente" "$(busca $F "Funcionaria")" "(vazio)"
  eq "S5 termo só-curinga = vazio" "$(busca $F "%%")" "(vazio)"
  eq "S6 gestor acha pelo documento alheio (devolve CNPJ||documento)" "$(busca $G "doc-c3")" "Cliente Tres:true:cnpj-c3"
  eq "S7 e-mail alheio = vazio" "$(busca $F "tres@x")" "(vazio)"
  eq "S8 customer → 42501" "$(veredito "$(nega authenticated $C1 "SELECT * FROM public.buscar_clientes_global('Tres')")")" "barrado"
  eq "S9 anon → 42501" "$(veredito "$(nega anon "" "SELECT * FROM public.buscar_clientes_global('Tres')")")" "barrado"
}
asserts

echo "-- I. idempotência --"
P -q -f "$MIG"
eq "I1 re-apply não reabre" "$(fone $F $C3)" "false|(null)"

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; o controle verde acima já rodou) ═════════
echo "-- K. falsificação --"
exige_vermelho() { # <rótulo> <obtido> <verde> <vermelho esperado>
  if [ "$2" = "$3" ]; then bad "$1 — SABOTADO e seguiu verde [$2]: assert sem dente"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — resultado inesperado [$2], esperava o vermelho [$4]"; fi
}
sabota() { # <perl expr> — aplica a migration com o corpo sabotado (sem a postcondição)
  perl -0pe "$1" "$MIG" > "$RODADA/sabotada.sql"
  if cmp -s "$MIG" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a migration ($1)"; fi
  perl -0pi -e 's/DO \$pos\$.*?\$pos\$;//s' "$RODADA/sabotada.sql"
  P -q -f "$RODADA/sabotada.sql"
}
restaura() { P -q -f "$MIG"; }

sabota 's/AND a\.eligible IS TRUE\n  \), raizes/\n  ), raizes/'
exige_vermelho "K1 sem eligible → A5 fornecedor" "$(agir $F $CF)" "false" "true"; restaura

sabota 's/SELECT r FROM raizes WHERE r NOT IN \(SELECT r FROM ambiguas\)/SELECT r FROM raizes/'
exige_vermelho "K2 sem guarda de raiz ambígua → A7" "$(agir $F $AR)" "false" "true"; restaura

sabota 's/CASE WHEN v\.visivel THEN p\.phone    END AS phone/p.phone AS phone/'
exige_vermelho "K3 telefone sem máscara → V2" "$(fone $F $C3)" "false|(null)" "false|fone-c3"; restaura

sabota 's/OR \(s\.vis AND \(p\.document ILIKE/OR (true AND (p.document ILIKE/'
exige_vermelho "K4 busca casando documento oculto → S2" "$(busca $F "doc-c3")" "(vazio)" "Cliente Tres:false:(null)"; restaura

sabota 's/IF NOT \(COALESCE\(private\.cliente_pode_agir\(p_comprador, v_uid\), false\)\) THEN/IF false THEN/'
exige_vermelho "K5 escritor sem gate → W4" \
  "$(veredito "$(nega authenticated $F "SELECT public.venda_registrar_contato('$C3','vendeu')")")" "barrado" "vazou"; restaura

sabota 's/AND \(p\.user_id = \(SELECT auth\.uid\(\)\)\n        OR COALESCE/AND (true\n        OR COALESCE/'
exige_vermelho "K6 view sem fronteira de LINHA → V11 customer" "$(fone $C1 $C3)" "(sem-linha)" "false|(null)"; restaura

P -q -c "GRANT EXECUTE ON FUNCTION public.pode_agir_no_cliente(uuid) TO anon;"
exige_vermelho "K7 anon com EXECUTE → A11" "$(veredito "$(nega anon "" "SELECT public.pode_agir_no_cliente('$C1')")")" "barrado" "vazou"; restaura

sabota 's/WHERE ur\.user_id = p\.user_id/WHERE false AND ur.user_id = p.user_id/'
P -q -c "UPDATE public.profiles SET is_employee=false WHERE user_id='$E';"
exige_vermelho "K8 Cmd-K sem exclusão de staff → S4" "$(busca $F "Funcionaria")" "(vazio)" "Funcionaria Cliente:false:(null)"
P -q -c "UPDATE public.profiles SET is_employee=true WHERE user_id='$E';"; restaura

sabota 's/AND \(c\.valid_until IS NULL OR c\.valid_until > now\(\)\)/AND true/'
exige_vermelho "K9 cobertura sem validade → V6" "$(fone $K2 $C3)" "false|(null)" "true|fone-c3"; restaura

P -q -c "GRANT UPDATE ON public.v_perfil_contato TO authenticated;"
exige_vermelho "K10 GRANT de escrita na view → V14" \
  "$(P -tA -q -c "SELECT has_table_privilege('authenticated','public.v_perfil_contato','INSERT,UPDATE,DELETE')::text;")" "false" "true"; restaura

echo "-- pós-falsificação: tudo restaurado volta verde --"
asserts

echo "──────────────────────────────"
echo "LOCALE: $LOCALE_TESTE"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

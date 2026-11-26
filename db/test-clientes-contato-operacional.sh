#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 2 — RPC operacional por OBJETO + ledger + views mascaradas
# ║    bash db/test-clientes-contato-operacional.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-contato-operacional.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Migrations reais: 20261124120000 + 20261124130000 (fatia 1) e 20261124180000 (fatia 2).
# ║  Personas da fatia 1 (farmer F, outra dona O, cobertura K/K2, gestor G, master M, back-office B,
# ║  ex-employee X, customer C1) + cadastro pendente PN. Objetos: pedido SO1 (de C3) e SO2 (de C1),
# ║  OS OS1, tarefa de picking PT1 (→ SO1), visita RV1.
# ║  JWT pela GUC real request.jwt.claims. FALSIFICAÇÃO na MESMA invocação: controle verde antes,
# ║  uma sabotagem POR CAMADA com o SEU vermelho exato, e a suíte inteira verde de novo depois.
# ╚══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5494}"
SLUG="contatoop"
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

MIG1="$REPO_ROOT/supabase/migrations/20261124120000_clientes_pii_contrato_carteira.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261124130000_clientes_busca_global_like_escapado.sql"
MIG="$REPO_ROOT/supabase/migrations/20261124180000_clientes_contato_operacional_ledger.sql"

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

-- corpo de prod de private.padrao_like_contem (20260929000234)
CREATE OR REPLACE FUNCTION private.padrao_like_contem(p_termo text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path TO ''
AS $f$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END
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
F=f0000000-0000-0000-0000-00000000000f   # farmer (dona de C1, CR)
O=0b000000-0000-0000-0000-00000000000b   # outra dona (C3)
K=c0000000-0000-0000-0000-0000000000c1   # cobre O (vigente)
K2=c0000000-0000-0000-0000-0000000000c2  # cobre O (vencida)
G=9e000000-0000-0000-0000-000000000009   # gestor (employee + gerencial)
M=3a000000-0000-0000-0000-000000000003   # master
B=b0000000-0000-0000-0000-0000000000b0   # back-office sem carteira
X=e0000000-0000-0000-0000-0000000000e0   # ex-employee (sem papel)
E=e1000000-0000-0000-0000-0000000000e1   # employee com profile pendente (nunca é "cliente")
C1=10000000-0000-0000-0000-000000000001  # cliente da F (também é o customer self)
CR=20000000-0000-0000-0000-000000000002  # raiz fiscal da F
CA=21000000-0000-0000-0000-000000000021  # alias (clone eligible=false, sem profiles) → CR
C3=30000000-0000-0000-0000-000000000003  # cliente de O
PN=70000000-0000-0000-0000-000000000007  # cadastro pendente (is_approved=false)
SO1=a1000000-0000-0000-0000-0000000000a1 # pedido de C3
SO2=a2000000-0000-0000-0000-0000000000a2 # pedido de C1
OS1=a3000000-0000-0000-0000-0000000000a3 # OS de afiação de C3
PT1=a4000000-0000-0000-0000-0000000000a4 # tarefa de picking do SO1
RV1=a5000000-0000-0000-0000-0000000000a5 # visita agendada (pela F) a C3
NADA=a9000000-0000-0000-0000-0000000000a9 # objeto inexistente
E2=e2000000-0000-0000-0000-0000000000e2  # employee por PAPEL, sem a flag is_employee
EX2=e3000000-0000-0000-0000-0000000000e3 # flag is_employee sem papel
SO3=a6000000-0000-0000-0000-0000000000a6 # pedido do ALIAS CA

# ── ZONA 1b: tabelas dos OBJETOS operacionais (colunas de prod, psql-ro 2026-11-24) ──
P -q <<'SQL'
ALTER TABLE public.profiles ADD COLUMN is_approved boolean DEFAULT true;
CREATE TABLE public.addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, label text, street text, number text,
  complement text, neighborhood text, city text, state text, zip_code text, is_default boolean,
  created_at timestamptz DEFAULT now(), is_from_omie boolean DEFAULT false
);
ALTER TABLE public.addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Employees can view all addresses" ON public.addresses FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'master'::app_role)) OR ( SELECT has_role(auth.uid(), 'employee'::app_role))));
CREATE POLICY "Users can view their own addresses" ON public.addresses FOR SELECT USING (auth.uid() = user_id);
CREATE TABLE public.customer_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, phone text, nome text, cargo text,
  email text, is_decision_maker boolean, is_primary boolean, whatsapp_only boolean, birthday date,
  notas text, source text, created_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.customer_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_contacts_select_staff ON public.customer_contacts FOR SELECT
  USING ((( SELECT has_role(auth.uid(), 'employee'::app_role)) OR ( SELECT has_role(auth.uid(), 'master'::app_role))));
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, customer_user_id uuid, customer_document text, customer_address text, customer_phone text
);
CREATE TABLE public.orders (id uuid PRIMARY KEY, user_id uuid, address jsonb);
CREATE TABLE public.picking_tasks (id uuid PRIMARY KEY, sales_order_id uuid);
CREATE TABLE public.visitas_agendadas (id uuid PRIMARY KEY, customer_user_id uuid, scheduled_by uuid);
SQL

P -q <<SQL
INSERT INTO public.user_roles VALUES
 ('$F','employee'),('$O','employee'),('$K','employee'),('$K2','employee'),('$G','employee'),
 ('$M','master'),('$B','employee'),('$E','employee'),('$E2','employee'),('$C1','customer'),('$PN','customer');
INSERT INTO public.commercial_roles VALUES ('$F','farmer'),('$G','gerencial');
INSERT INTO public.profiles(user_id,name,email,phone,document,cnpj,razao_social,is_employee,is_approved) VALUES
 ('$C1','Cliente Um','um@x.test','fone-c1','doc-c1',NULL,'Um Ltda',false,true),
 ('$CR','Cliente Raiz','raiz@x.test','fone-cr','doc-cr','cnpj-cr','Raiz SA',false,true),
 ('$C3','Cliente Tres','tres@x.test','fone-c3','doc-c3','cnpj-c3','Tres Ltda',false,true),
 ('$PN','Cadastro Pendente','pend@x.test','fone-pn','doc-pn',NULL,NULL,false,false),
 ('$E','Funcionaria Cliente','func@x.test','fone-e','doc-e',NULL,NULL,true,false),
 ('$E2','Funcionario Sem Flag','e2@x.test','fone-e2','doc-e2',NULL,NULL,false,true),
 ('$EX2','Flag Sem Papel','ex2@x.test','fone-ex2','doc-ex2',NULL,NULL,true,true);
INSERT INTO public.carteira_assignments(customer_user_id,owner_user_id,eligible) VALUES
 ('$C1','$F',true),('$CR','$F',true),('$CA','$F',false),('$C3','$O',true),
 (NULL,'$F',true);  -- Codex P1: NULL no conjunto visível não pode apagar a exceção
INSERT INTO public.customer_canonical_alias VALUES ('$CA','$CR','active');
INSERT INTO public.carteira_coverage(covering_user_id,covered_user_id,valid_until,active) VALUES
 ('$K','$O',NULL,true),('$K2','$O',now() - interval '1 day',true);
INSERT INTO public.addresses(user_id,label,street,number,neighborhood,city,state,zip_code,is_default) VALUES
 ('$C1','Sede','rua-c1','1','bairro-c1','Curitiba','PR','cep-c1',true),
 ('$C3','Sede','rua-c3','3','bairro-c3','Joinville','SC','cep-c3',true);
INSERT INTO public.customer_contacts(customer_user_id,phone,nome,cargo) VALUES
 ('$C1','cc-fone-c1','Ana','compras'),('$C3','cc-fone-c3','Beto','dono');
INSERT INTO public.sales_orders VALUES
 ('$SO1','$C3','snap-doc-c3','snap-end-c3','snap-fone-c3'),
 ('$SO2','$C1','snap-doc-c1','snap-end-c1','snap-fone-c1'),
 ('$SO3','$CA','snap-doc-ca','snap-end-ca','snap-fone-ca');  -- pedido no ALIAS (clone sem profiles)
INSERT INTO public.orders VALUES ('$OS1','$C3',NULL);
INSERT INTO public.picking_tasks VALUES ('$PT1','$SO1');
INSERT INTO public.visitas_agendadas VALUES ('$RV1','$C3','$F'),
 ('$SO2','$C3','$B');  -- MESMO uuid do pedido SO2 (de C1), noutra tabela e noutro cliente
SQL

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
veredito() { case "$1" in *MARCA_BARRADO_7Q*) echo barrado ;; *MARCA_VAZOU_7Q*) echo vazou ;; *) echo "outro: $1" ;; esac; }
# op <uid> <tipo> <ids-csv> [motivo] → "cliente:via_excecao:phone:pedido_telefone:rua" por objeto
motivo_de() { case "$1" in pedido) echo detalhe_pedido ;; ordem_servico) echo detalhe_os ;; expedicao) echo separacao ;;
  rota) echo visita_agendada ;; aprovacao) echo aprovar_cadastro ;; *) echo novo_pedido ;; esac; }
op() {
  local mot="${4:-$(motivo_de "$2")}"
  como "$1" "SELECT coalesce(string_agg(customer_user_id::text||':'||coalesce(via_excecao::text,'NULO')||':'||coalesce(phone,'(null)')||':'||coalesce(pedido_telefone,'-')||':'||coalesce(enderecos->0->>'street','-'), ',' ORDER BY customer_user_id),'(vazio)') FROM public.contato_cliente_operacional('$2', '{$3}'::uuid[], '$mot');"
}
campo() { como "$1" "SELECT coalesce(string_agg(coalesce($4,'(null)'), ','),'(vazio)') FROM public.contato_cliente_operacional('$2', '{$3}'::uuid[], '$(motivo_de "$2")');"; }
ledger() { P -tA -q -c "SELECT count(*) FROM public.contato_acesso_operacional $1;"; }
fone() { como "$1" "SELECT coalesce(contato_visivel::text,'(sem-linha)')||'|'||coalesce(phone,'(null)') FROM public.v_perfil_contato WHERE user_id='$2' UNION ALL SELECT '(sem-linha)' WHERE NOT EXISTS (SELECT 1 FROM public.v_perfil_contato WHERE user_id='$2');"; }
ender() { como "$1" "SELECT coalesce(string_agg(city||'/'||coalesce(contato_visivel::text,'NULO')||'/'||coalesce(label,'(null)')||'/'||coalesce(street,'(null)')||'/'||coalesce(zip_code,'(null)'), ','),'(sem-linha)') FROM public.v_endereco_contato WHERE user_id='$2';"; }
contatos() { como "$1" "SELECT coalesce(string_agg(nome||'/'||phone, ','),'(sem-linha)') FROM public.v_cliente_contatos WHERE customer_user_id='$2';"; }

P -q -f "$MIG1"; P -q -f "$MIG2"
echo "-- L0. linha de base (fatias 1+2 NÃO fecham a tabela — fatia 3) --"
eq "L0 back-office lê o telefone alheio DIRETO de profiles (furo que a fatia 3 fecha)" \
   "$(como $B "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "fone-c3"
P -q -f "$MIG"
echo "migration da fatia 2 aplicada (postcondição embutida passou)"

asserts() {
  P -q -c "DELETE FROM public.contato_acesso_operacional;" >/dev/null
  echo "-- O. RPC operacional por objeto --"
  eq "O1 back-office SEM carteira lê o pedido alheio (exceção, com snapshot e endereço)" \
     "$(op $B pedido $SO1)" "$C3:true:fone-c3:snap-fone-c3:rua-c3"
  eq "O2 a exceção gravou 1 linha no ledger (só referência)" \
     "$(ledger "WHERE staff_user_id='$B' AND customer_user_id='$C3' AND objeto_tipo='pedido' AND objeto_id='$SO1' AND motivo='detalhe_pedido'")" "1"
  op $B pedido $SO1 >/dev/null
  eq "O3 refetch em 10 min não duplica (dedupe)" "$(ledger "WHERE staff_user_id='$B'")" "1"
  op $B pedido $SO1 impressao_pedido >/dev/null
  eq "O3b motivo diferente grava outra linha" "$(ledger "WHERE staff_user_id='$B'")" "2"
  eq "O4 farmer no pedido do PRÓPRIO cliente: não é exceção" "$(op $F pedido $SO2)" "$C1:false:fone-c1:snap-fone-c1:rua-c1"
  eq "O4b ... e não grava ledger" "$(ledger "WHERE staff_user_id='$F'")" "0"
  eq "O5 gestor: não é exceção" "$(op $G pedido $SO1)" "$C3:false:fone-c3:snap-fone-c3:rua-c3"
  eq "O5b cobertura vigente: não é exceção" "$(op $K pedido $SO1)" "$C3:false:fone-c3:snap-fone-c3:rua-c3"
  eq "O5c cobertura VENCIDA: é exceção" "$(op $K2 pedido $SO1)" "$C3:true:fone-c3:snap-fone-c3:rua-c3"
  eq "O5e master: não é exceção" "$(op $M pedido $SO1)" "$C3:false:fone-c3:snap-fone-c3:rua-c3"
  eq "O5d gestor/master/cobertura não gravam ledger" "$(ledger "WHERE staff_user_id IN ('$G','$K','$M')")" "0"
  eq "O6 expedição deriva o cliente do pedido da tarefa" "$(op $F expedicao $PT1)" "$C3:true:fone-c3:-:rua-c3"
  eq "O7 rota (visita agendada pela própria farmer)" "$(op $F rota $RV1)" "$C3:true:fone-c3:-:rua-c3"
  eq "O7b visita agendada por OUTRO staff = sem linha" "$(op $B rota $RV1)" "(vazio)"
  eq "O8 ordem de serviço" "$(op $F ordem_servico $OS1)" "$C3:true:fone-c3:-:rua-c3"
  eq "O9 aprovação de cadastro PENDENTE" "$(op $B aprovacao $PN)" "$PN:true:fone-pn:-:-"
  eq "O9b aprovação de cliente JÁ aprovado = sem linha" "$(op $B aprovacao $C3)" "(vazio)"
  eq "O10 aprovação de staff = sem linha" "$(op $B aprovacao $E)" "(vazio)"
  eq "O10b novo_pedido de staff (papel, sem flag) = sem linha" "$(op $B novo_pedido $E2)" "(vazio)"
  eq "O10d novo_pedido de perfil com flag is_employee (sem papel) = sem linha" "$(op $B novo_pedido $EX2)" "(vazio)"
  eq "O10c novo_pedido de cliente existente" "$(op $B novo_pedido $C3)" "$C3:true:fone-c3:-:rua-c3"
  eq "O11 objeto inexistente = sem linha" "$(op $B pedido $NADA)" "(vazio)"
  eq "O11b ... e sem ledger" "$(ledger "WHERE objeto_id='$NADA'")" "0"
  eq "O12 id de pedido passado como rota = sem linha (tipo amarra a tabela)" "$(op $B rota $SO1)" "(vazio)"
  eq "O12b o cliente sai do OBJETO: pedido do C1 nunca devolve o C3" "$(op $B pedido $SO2)" "$C1:true:fone-c1:snap-fone-c1:rua-c1"
  eq "O13 lote: 2 pedidos, 2 linhas" "$(como $B "SELECT count(*) FROM public.contato_cliente_operacional('pedido', ARRAY['$SO1','$SO2','$SO1']::uuid[], 'impressao_pedido');")" "2"
  eq "O14 array vazio = sem linha" "$(op $B pedido "")" "(vazio)"
  eq "O15 customer → 42501" "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO2']::uuid[], 'detalhe_pedido')")")" "barrado"
  eq "O16 ex-employee → 42501" "$(veredito "$(nega authenticated $X insufficient_privilege "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO1']::uuid[], 'detalhe_pedido')")")" "barrado"
  eq "O17 anon → 42501" "$(veredito "$(nega anon "" insufficient_privilege "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO1']::uuid[], 'detalhe_pedido')")")" "barrado"
  eq "O18 tipo inválido → 22023" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('cliente', ARRAY['$C3']::uuid[], 'detalhe_pedido')")")" "barrado"
  eq "O19 motivo vazio → 22023" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO1']::uuid[], '')")")" "barrado"
  eq "O20 201 objetos → 22023 (teto estrutural)" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY(SELECT gen_random_uuid() FROM generate_series(1,201)), 'detalhe_pedido')")")" "barrado"
  eq "O21 200 objetos passa" "$(como $B "SELECT count(*) FROM public.contato_cliente_operacional('pedido', ARRAY(SELECT gen_random_uuid() FROM generate_series(1,200)), 'detalhe_pedido');")" "0"

  echo "-- N. NULL, alias, uuid repetido, minimização, motivo, teto --"
  eq "N1 NULL no conjunto da farmer: alheio segue EXCEÇÃO" "$(op $F expedicao $PT1)" "$C3:true:fone-c3:-:rua-c3"
  eq "N2 ... e gravou ledger" "$(ledger "WHERE staff_user_id='$F' AND objeto_id='$PT1'")" "1"
  eq "N3 pedido no ALIAS da raiz da farmer: não é exceção" "$(op $F pedido $SO3)" "$CA:false:(null):snap-fone-ca:-"
  eq "N4 mesmo uuid como rota → cliente da VISITA" "$(op $B rota $SO2)" "$C3:true:fone-c3:-:rua-c3"
  eq "N5 mesmo uuid como pedido → cliente do PEDIDO" "$(op $B pedido $SO2)" "$C1:true:fone-c1:snap-fone-c1:rua-c1"
  eq "N6 rota não devolve documento" "$(campo $F rota $RV1 document)" "(null)"
  eq "N7 expedição não devolve documento" "$(campo $B expedicao $PT1 document)" "(null)"
  eq "N8 pedido devolve documento" "$(campo $B pedido $SO1 document)" "doc-c3"
  eq "N9 pedido não devolve e-mail" "$(campo $B pedido $SO1 email)" "(null)"
  eq "N10 aprovação devolve e-mail" "$(campo $B aprovacao $PN email)" "pend@x.test"
  eq "N11 aprovação não devolve endereços" "$(campo $B aprovacao $PN "enderecos::text")" "[]"
  eq "N12 motivo de outro tipo → 22023" "$(veredito "$(nega authenticated $F invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO2']::uuid[], 'separacao')")")" "barrado"
  eq "N13 novo_pedido com 2 clientes → 22023" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('novo_pedido', ARRAY['$C3','$C1']::uuid[], 'novo_pedido')")")" "barrado"
  P -q -c "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) SELECT '$B', g, 'novo_pedido', g, 'novo_pedido' FROM (SELECT gen_random_uuid() g FROM generate_series(1,79)) z;" >/dev/null
  eq "N14 79 clientes hoje + 1 = 80: passa" "$(op $B novo_pedido $C3)" "$C3:true:fone-c3:-:rua-c3"
  eq "N15 81º cliente distinto fora da carteira → 54000" "$(veredito "$(nega authenticated $B program_limit_exceeded "SELECT * FROM public.contato_cliente_operacional('novo_pedido', ARRAY['$C1']::uuid[], 'novo_pedido')")")" "barrado"
  eq "N16 o teto não grava a linha barrada" "$(ledger "WHERE staff_user_id='$B' AND objeto_tipo='novo_pedido' AND customer_user_id='$C1'")" "0"
  eq "N17 releitura de cliente já lido hoje não conta de novo" "$(op $B novo_pedido $C3)" "$C3:true:fone-c3:-:rua-c3"
  eq "N18 teto não vale para a carteira própria (farmer no C1)" "$(op $F novo_pedido $C1)" "$C1:false:fone-c1:-:rua-c1"
  P -q -c "DELETE FROM public.contato_acesso_operacional WHERE objeto_tipo='novo_pedido';" >/dev/null
  P -q -c "UPDATE public.contato_acesso_operacional SET acessado_em = acessado_em - interval '11 minutes' WHERE staff_user_id='$B' AND objeto_id='$SO1';" >/dev/null
  op $B pedido $SO1 >/dev/null
  eq "N19 depois de 10 min a mesma leitura grava de novo" "$(ledger "WHERE staff_user_id='$B' AND objeto_id='$SO1' AND motivo='detalhe_pedido'")" "2"

  echo "-- R. ledger: RLS e 1 writer --"
  eq "R1 staff vê só as PRÓPRIAS leituras" "$(como $F "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id<>'$F';")" "0"
  eq "R2 o próprio vê as suas" "$(como $B "SELECT (count(*)>0)::text FROM public.contato_acesso_operacional;")" "true"
  eq "R3 gestor vê as de todos" "$(como $G "SELECT (count(*) FILTER (WHERE staff_user_id='$B')>0)::text FROM public.contato_acesso_operacional;")" "true"
  eq "R4 customer não vê nada" "$(como $C1 "SELECT count(*) FROM public.contato_acesso_operacional;")" "0"
  eq "R5 INSERT direto de authenticated → 42501" "$(veredito "$(nega authenticated $B insufficient_privilege "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$B','$C3','pedido','$SO1','detalhe_pedido')")")" "barrado"
  eq "R6 DELETE direto de authenticated → 42501" "$(veredito "$(nega authenticated $G insufficient_privilege "DELETE FROM public.contato_acesso_operacional")")" "barrado"
  P -q -c "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$X','$C3','pedido','$SO1','detalhe_pedido');" >/dev/null
  eq "R8 ex-employee não vê o próprio histórico" "$(como $X "SELECT count(*) FROM public.contato_acesso_operacional;")" "0"
  eq "R9 service_role não escreve no ledger → 42501" "$(veredito "$(nega service_role "" insufficient_privilege "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$B','$C3','pedido','$SO1','detalhe_pedido')")")" "barrado"
  eq "R10 par tipo/motivo fora do vocabulário é recusado pelo próprio ledger (CHECK)" \
     "$(P -tA -q -c "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$B','$C3','pedido','$SO1','separacao');" 2>&1 | grep -c 'contato_acesso_operacional_motivo_chk')" "1"
  eq "R7 anon não lê → 42501" "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.contato_acesso_operacional")")" "barrado"

  echo "-- V. v_perfil_contato (forma de conjunto, mesma regra da fatia 1) --"
  eq "V1 farmer: contato do cliente dela" "$(fone $F $C1)" "true|fone-c1"
  eq "V2 farmer: alheio presente e mascarado" "$(fone $F $C3)" "false|(null)"
  eq "V3 farmer: raiz fiscal visível" "$(fone $F $CR)" "true|fone-cr"
  eq "V4 filtro pelo valor oculto → 0" "$(como $F "SELECT count(*) FROM public.v_perfil_contato WHERE phone='fone-c3';")" "0"
  eq "V5 cobertura vigente vê" "$(fone $K $C3)" "true|fone-c3"
  eq "V6 cobertura vencida não vê" "$(fone $K2 $C3)" "false|(null)"
  eq "V7 gestor vê" "$(fone $G $C3)" "true|fone-c3"
  eq "V8 master vê" "$(fone $M $C3)" "true|fone-c3"
  eq "V9 back-office: mascarado" "$(fone $B $C3)" "false|(null)"
  eq "V10 customer vê o próprio" "$(fone $C1 $C1)" "true|fone-c1"
  eq "V11 customer não recebe linha alheia" "$(fone $C1 $C3)" "(sem-linha)"
  eq "V12 ex-employee não recebe linha alheia" "$(fone $X $C3)" "(sem-linha)"
  eq "V13 sem uid → 0" "$(como "" "SELECT count(*) FROM public.v_perfil_contato;")" "0"
  eq "V14 farmer: total visível = carteira (C1, CR) sobre 7 perfis" \
     "$(como $F "SELECT count(*)||'/'||count(*) FILTER (WHERE contato_visivel) FROM public.v_perfil_contato;")" "7/2"

  echo "-- E. v_endereco_contato --"
  eq "E1 farmer: endereço do cliente dela" "$(ender $F $C1)" "Curitiba/true/Sede/rua-c1/cep-c1"
  eq "E2 farmer: alheio = cidade sim, rua e CEP não" "$(ender $F $C3)" "Joinville/false/(null)/(null)/(null)"
  eq "E3 cobertura vigente vê a rua" "$(ender $K $C3)" "Joinville/true/Sede/rua-c3/cep-c3"
  eq "E4 gestor vê a rua" "$(ender $G $C3)" "Joinville/true/Sede/rua-c3/cep-c3"
  eq "E5 customer vê o próprio" "$(ender $C1 $C1)" "Curitiba/true/Sede/rua-c1/cep-c1"
  eq "E6 customer não recebe endereço alheio" "$(ender $C1 $C3)" "(sem-linha)"
  eq "E7 filtro pela rua oculta → 0" "$(como $F "SELECT count(*) FROM public.v_endereco_contato WHERE street='rua-c3';")" "0"
  eq "E8 anon → 42501" "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.v_endereco_contato")")" "barrado"

  echo "-- C. v_cliente_contatos --"
  eq "C1 farmer: contatos do cliente dela" "$(contatos $F $C1)" "Ana/cc-fone-c1"
  eq "C2 farmer: contatos alheios = sem linha" "$(contatos $F $C3)" "(sem-linha)"
  eq "C3 cobertura vigente vê" "$(contatos $K $C3)" "Beto/cc-fone-c3"
  eq "C4 master vê" "$(contatos $M $C3)" "Beto/cc-fone-c3"
  eq "C5 customer não lê contatos (nem os próprios, como hoje)" "$(contatos $C1 $C1)" "(sem-linha)"
  eq "C6 anon → 42501" "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.v_cliente_contatos")")" "barrado"
  eq "C7 authenticated sem escrita nas 3 views" \
     "$(P -tA -q -c "SELECT bool_or(has_table_privilege('authenticated', v, 'INSERT,UPDATE,DELETE'))::text FROM unnest(ARRAY['public.v_perfil_contato','public.v_endereco_contato','public.v_cliente_contatos']) v;")" "false"
}
asserts

echo "-- I. idempotência --"
P -q -f "$MIG"
eq "I1 re-apply não reabre" "$(ender $F $C3)" "Joinville/false/(null)/(null)/(null)"
eq "I2 re-apply mantém o ledger com RLS" "$(P -tA -q -c "SELECT relrowsecurity::text FROM pg_class WHERE oid='public.contato_acesso_operacional'::regclass;")" "true"

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; o controle verde acima já rodou) ═════════
echo "-- K. falsificação --"
exige_vermelho() { # <rótulo> <obtido> <verde> <vermelho esperado>
  if [ "$2" = "$3" ]; then bad "$1 — SABOTADO e seguiu verde [$2]: assert sem dente"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — resultado inesperado [$2], esperava o vermelho [$4]"; fi
}
sabota() { # <perl expr> — aplica a migration da fatia 2 com o corpo sabotado (sem a postcondição)
  perl -0pe "$1" "$MIG" > "$RODADA/sabotada.sql"
  if cmp -s "$MIG" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a migration ($1)"; fi
  perl -0pi -e 's/DO \$pos\$.*?\$pos\$;//s' "$RODADA/sabotada.sql"
  P -q -f "$RODADA/sabotada.sql"
}
restaura() { P -q -c "DELETE FROM public.contato_acesso_operacional;" >/dev/null; P -q -f "$MIG"; }

sabota 's/IF v_uid IS NULL\n     OR NOT \(COALESCE/IF v_uid IS NULL\n     OR false AND NOT (COALESCE/'
exige_vermelho "K1 RPC sem gate de staff → O15 customer" \
  "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO2']::uuid[], 'detalhe_pedido')")")" "barrado" "vazou"; restaura

sabota 's/NOT COALESCE\(a\.cid = v_uid OR v_gestao OR EXISTS \(SELECT 1 FROM vis WHERE vis\.c = a\.cid\), false\) AS exc/false AS exc/'
P -q -c "DELETE FROM public.contato_acesso_operacional;" >/dev/null; op $B pedido $SO1 >/dev/null
exige_vermelho "K2 exceção nunca marcada → O2 ledger" "$(ledger "WHERE staff_user_id='$B'")" "1" "0"; restaura

sabota "s/AND l\.acessado_em > now\(\) - interval '10 minutes'/AND false/"
op $B pedido $SO1 >/dev/null; op $B pedido $SO1 >/dev/null
exige_vermelho "K3 sem dedupe → O3" "$(ledger "WHERE staff_user_id='$B'")" "1" "2"; restaura

sabota 's/AND \(p_objeto_tipo = .novo_pedido. OR p\.is_approved IS NOT TRUE\)/AND true/'
exige_vermelho "K4 aprovação sem filtro de pendente → O9b" "$(op $B aprovacao $C3)" "(vazio)" "$C3:true:fone-c3:-:-"; restaura

sabota 's/CASE WHEN v\.visivel THEN a\.street       END AS street/a.street AS street/'
exige_vermelho "K5 rua sem máscara → E2" "$(ender $F $C3)" "Joinville/false/(null)/(null)/(null)" "Joinville/false/(null)/rua-c3/(null)"; restaura

sabota 's/   AND \(ctx\.gestao\n        OR cc\.customer_user_id IN/   AND (true\n        OR cc.customer_user_id IN/'
exige_vermelho "K6 contatos sem filtro de carteira → C2" "$(contatos $F $C3)" "(sem-linha)" "Beto/cc-fone-c3"; restaura

# shellcheck disable=SC2016  # \$1 é do perl, não do shell
sabota 's/\(ctx\.staff AND \(ctx\.gestao(\s+OR p\.user_id IN)/(ctx.staff AND (false$1/'
exige_vermelho "K7 perfil sem ramo de gestão → V7" "$(fone $G $C3)" "true|fone-c3" "false|(null)"; restaura

sabota 's/ WHERE p\.user_id = ctx\.uid OR ctx\.staff;/ WHERE true;/'
exige_vermelho "K8 perfil sem fronteira de LINHA → V11" "$(fone $C1 $C3)" "(sem-linha)" "false|(null)"; restaura

sabota 's/USING \(\n    COALESCE\(\(SELECT private\.pode_ver_carteira_completa\(\(SELECT auth\.uid\(\)\)\)\), false\)/USING (\n    true/'
op $B pedido $SO1 >/dev/null
exige_vermelho "K9 policy do ledger aberta → R1" "$(como $F "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id<>'$F';")" "0" "1"; restaura

P -q -c "GRANT INSERT ON public.contato_acesso_operacional TO authenticated; CREATE POLICY forja ON public.contato_acesso_operacional FOR INSERT TO authenticated WITH CHECK (true);"
exige_vermelho "K10 2º writer (grant+policy) → R5" "$(veredito "$(nega authenticated $B insufficient_privilege "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$B','$C3','pedido','$SO1','detalhe_pedido')")")" "barrado" "vazou"
P -q -c "DROP POLICY forja ON public.contato_acesso_operacional;"; restaura

sabota 's/IF cardinality\(p_objeto_ids\) > 200 THEN/IF false THEN/'
exige_vermelho "K11 sem teto → O20" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY(SELECT gen_random_uuid() FROM generate_series(1,201)), 'detalhe_pedido')")")" "barrado" "vazou"; restaura

sabota "s/AND ur\.role IN \('employee'::public\.app_role, 'master'::public\.app_role\)\)/AND false)/"
exige_vermelho "K12 sem exclusão por PAPEL → O10b" "$(op $B novo_pedido $E2)" "(vazio)" "$E2:true:fone-e2:-:-"; restaura

sabota 's/       AND p\.is_employee IS NOT TRUE\n//'
exige_vermelho "K12b sem exclusão por FLAG is_employee → O10d" "$(op $B novo_pedido $EX2)" "(vazio)" "$EX2:true:fone-ex2:-:-"; restaura

sabota 's/CASE WHEN v\.visivel THEN a\.label        END AS label/a.label AS label/'
exige_vermelho "K5b rótulo sem máscara → E2" "$(ender $F $C3)" "Joinville/false/(null)/(null)/(null)" "Joinville/false/Sede/(null)/(null)"; restaura

sabota 's/WHERE x\.c IS NOT NULL AND NOT v_gestao/WHERE NOT v_gestao/; s/NOT COALESCE\(a\.cid = v_uid OR v_gestao OR EXISTS \(SELECT 1 FROM vis WHERE vis\.c = a\.cid\), false\) AS exc/NOT (a.cid = v_uid OR v_gestao OR a.cid IN (SELECT vis.c FROM vis)) AS exc/'
P -q -c "DELETE FROM public.contato_acesso_operacional;" >/dev/null; op $F expedicao $PT1 >/dev/null
exige_vermelho "K14 RPC sem NULL-safety → N2 (PII sai sem ledger)" "$(ledger "WHERE staff_user_id='$F' AND objeto_id='$PT1'")" "1" "0"; restaura

# shellcheck disable=SC2016  # \$1 é do perl, não do shell
sabota 's/(OR p\.user_id IN \(SELECT x\.c FROM private\.clientes_contato_visiveis\(\(SELECT auth\.uid\(\)\)\) x\(c\)\s+)WHERE x\.c IS NOT NULL\)/$1)/'
exige_vermelho "K15 view sem NULL-safety → V2" "$(fone $F $C3)" "false|(null)" "(sem-linha)|(null)"; restaura

sabota 's/IF p_objeto_tipo = .novo_pedido. AND cardinality\(v_ids\) > 1 THEN/IF false THEN/'
exige_vermelho "K16 novo_pedido em lote → N13" "$(veredito "$(nega authenticated $B invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('novo_pedido', ARRAY['$C3','$C1']::uuid[], 'novo_pedido')")")" "barrado" "vazou"; restaura

sabota 's/WHEN \(SELECT n FROM teto\) > 80/WHEN (SELECT n FROM teto) > 100000/'
P -q -c "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) SELECT '$B', g, 'novo_pedido', g, 'novo_pedido' FROM (SELECT gen_random_uuid() g FROM generate_series(1,80)) z;" >/dev/null
exige_vermelho "K17 sem teto diário → N15" "$(veredito "$(nega authenticated $B program_limit_exceeded "SELECT * FROM public.contato_cliente_operacional('novo_pedido', ARRAY['$C1']::uuid[], 'novo_pedido')")")" "barrado" "vazou"; restaura

sabota "s/CASE WHEN p_objeto_tipo IN \('pedido', 'ordem_servico', 'aprovacao', 'novo_pedido'\) THEN pr\.document END/pr.document/"
exige_vermelho "K18 sem minimização → N6" "$(campo $F rota $RV1 document)" "(null)" "doc-c3"; restaura

sabota "s/OR \(p_objeto_tipo, p_motivo\) NOT IN \(/OR false AND (p_objeto_tipo, p_motivo) NOT IN (/"
exige_vermelho "K19 motivo sem amarra ao tipo → N12" "$(veredito "$(nega authenticated $F invalid_parameter_value "SELECT * FROM public.contato_cliente_operacional('pedido', ARRAY['$SO2']::uuid[], 'separacao')")")" "barrado" "vazou"; restaura

sabota 's/AND \(COALESCE\(\(SELECT public\.has_role\(\(SELECT auth\.uid\(\)\), .employee.::public\.app_role\)\), false\)/AND (true OR COALESCE((SELECT public.has_role((SELECT auth.uid()), \x27employee\x27::public.app_role)), false)/'
P -q -c "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$X','$C3','pedido','$SO1','detalhe_pedido');" >/dev/null
exige_vermelho "K20 policy sem staff atual → R8" "$(como $X "SELECT count(*) FROM public.contato_acesso_operacional;")" "0" "1"; restaura

P -q -c "GRANT INSERT ON public.contato_acesso_operacional TO service_role;"
exige_vermelho "K21 service_role como 2º writer → R9" "$(veredito "$(nega service_role "" insufficient_privilege "INSERT INTO public.contato_acesso_operacional(staff_user_id,customer_user_id,objeto_tipo,objeto_id,motivo) VALUES ('$B','$C3','pedido','$SO1','detalhe_pedido')")")" "barrado" "vazou"; restaura

sabota "s/AND va\.scheduled_by = v_uid/AND va.scheduled_by = v_uid\n    UNION ALL SELECT so2.id, so2.customer_user_id, NULL, NULL, NULL FROM public.sales_orders so2 WHERE p_objeto_tipo = 'rota' AND so2.id = ANY (v_ids)/"
exige_vermelho "K13 tipo não amarra a tabela → O12" "$(op $B rota $SO1)" "(vazio)" "$C3:true:fone-c3:-:rua-c3"; restaura

sabota 's/\n       AND va\.scheduled_by = v_uid//'
exige_vermelho "K22 rota sem amarra a quem agendou → O7b" "$(op $B rota $RV1)" "(vazio)" "$C3:true:fone-c3:-:rua-c3"; restaura

echo "-- pós-falsificação: tudo restaurado volta verde --"
asserts

echo "──────────────────────────────"
echo "LOCALE: $LOCALE_TESTE"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

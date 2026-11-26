#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 4b-1 — L6, anon fora, grupo mascarado, equipe por papel
# ║    bash db/test-clientes-pii-fatia4b1-servidor.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-fatia4b1-servidor.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Base: o setup INTEIRO de db/test-clientes-pii-fatia4a-corte.sh (fatias 1–3 reais + 4a-1 + 4a-2) +
# ║  ACL de PROD (psql-ro, 2026-11-26) de addresses/grupos/customer_contacts → 20261126230000 (4b-1).
# ║  Negativos casam a SQLSTATE pelo NOME e re-lançam o resto. FALSIFICAÇÃO na MESMA invocação: suíte
# ║  verde antes, uma sabotagem POR CAMADA com o seu vermelho EXATO, suíte verde de novo depois.
# ╚══════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5497}"
SLUG="piifatia4b1"
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
MIGF2="$REPO_ROOT/supabase/migrations/20261124180000_clientes_contato_operacional_ledger.sql"
ANTES="$REPO_ROOT/db/fixtures/clientes-pii-fatia3-prod-antes.sql"
MIGA="$REPO_ROOT/supabase/migrations/20261125120000_clientes_pii_fatia3_leitores_servidor.sql"
MIGB="$REPO_ROOT/supabase/migrations/20261125130000_clientes_pii_fatia3_corte_profiles.sql"

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
# shellcheck disable=SC2034  # persona do setup herdado da fatia 3 (seed de papéis); a 4a não a consulta
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

# ── ZONA 2: o que os 6 objetos de prod leem (colunas de prod, psql-ro 2026-11-25) ──
P -q <<'SQL'
-- profiles com TODAS as colunas de prod: a postcondição da 3b confere coluna a coluna o grant.
ALTER TABLE public.profiles
  ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now(),
  ADD COLUMN customer_type text, ADD COLUMN cnae text, ADD COLUMN avatar_url text, ADD COLUMN employee_code text,
  ADD COLUMN business_hours_open text, ADD COLUMN business_hours_close text, ADD COLUMN lunch_start text,
  ADD COLUMN lunch_end text, ADD COLUMN preferred_delivery_time text, ADD COLUMN requires_po boolean DEFAULT false,
  ADD COLUMN is_prospect boolean DEFAULT false, ADD COLUMN prospect_source text, ADD COLUMN prospect_origin_call_id uuid;
-- policies de escrita de prod (pg_policy, 2026-11-25)
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE OR REPLACE FUNCTION public.normalizar_documento(t text) RETURNS text LANGUAGE sql IMMUTABLE
AS $f$ SELECT regexp_replace(upper(coalesce(t, '')), '[^0-9A-Z]', '', 'g') $f$;
CREATE OR REPLACE FUNCTION private.nome_ordenacao(t text) RETURNS text LANGUAGE sql IMMUTABLE
AS $f$ SELECT lower(t) $f$;
ALTER TABLE public.sales_orders
  ADD COLUMN status text DEFAULT 'faturado', ADD COLUMN deleted_at timestamptz,
  ADD COLUMN order_date_kpi date DEFAULT (current_date - 10), ADD COLUMN total numeric DEFAULT 100,
  ADD COLUMN items jsonb DEFAULT '[]'::jsonb, ADD COLUMN account text DEFAULT 'oben';
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, product_id uuid,
  omie_codigo_produto text, quantity numeric, unit_price numeric);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, account text, familia text);
CREATE TABLE public.product_costs (product_id uuid, cmc numeric, custo_producao numeric, custo_producao_status text);
CREATE TABLE public.whatsapp_conversations (customer_user_id uuid, opt_in_status text, phone_e164 text, phone_key text);
CREATE TABLE public.cliente_grupo_membros (grupo_id uuid, documento text);
CREATE TABLE public.omie_customer_account_map_fresco (user_id uuid, account text, omie_codigo_vendedor bigint);
CREATE TABLE public.farmer_client_scores (customer_user_id uuid, priority_score numeric, sales_history_status text, health_class text);
SQL

GR=6a000000-0000-0000-0000-0000000000a6  # grupo comercial com C3 (fora da carteira da F) e C1 (dentro)
PR1=6b000000-0000-0000-0000-0000000000b6
P -q <<SQL
-- documentos com 14 dígitos (a Caça só aceita 11/14) e telefones com ≥ 10 dígitos
UPDATE public.profiles SET document='12345678000199', cnpj=NULL, phone='4733330003' WHERE user_id='$C3';
UPDATE public.profiles SET document='98765432000111', cnpj=NULL, phone='4133330001' WHERE user_id='$C1';
UPDATE public.profiles SET requires_po=true WHERE user_id='$C3';
-- CR: 14 dígitos (entra na Caça) mas com opt-out SÓ pelo telefone — a chave crua do telefone decide a fila
UPDATE public.profiles SET document='11222333000144', cnpj=NULL, phone='48933330002' WHERE user_id='$CR';
INSERT INTO public.whatsapp_conversations VALUES (NULL,'opt_out','+5548933330002',NULL);
UPDATE public.profiles SET created_at = now() - interval '1 day' WHERE user_id='$C1';
INSERT INTO public.omie_products VALUES ('$PR1','oben','lixas');
INSERT INTO public.order_items(sales_order_id,product_id,quantity,unit_price) VALUES ('$SO1','$PR1',2,50),('$SO2','$PR1',1,30);
INSERT INTO public.product_costs VALUES ('$PR1',20,NULL,NULL);
INSERT INTO public.cliente_grupo_membros VALUES ('$GR','12345678000199'),('$GR','98765432000111');
INSERT INTO public.farmer_client_scores VALUES ('$C1',50,'ativo','saudavel'),('$C3',90,'ativo','critico');
SQL

P -q -f "$MIG1"; P -q -f "$MIG2"; P -q -f "$MIGF2"
P -q -f "$ANTES"
# ACL de PROD das duas RPCs (pg_proc.proacl, 2026-11-25): sem PUBLIC e sem anon.
P -q -c "REVOKE ALL ON FUNCTION public.listar_clientes_base(text,text,text,integer,integer), public.resolver_cliente_por_telefone(text) FROM PUBLIC, anon;"
echo "base: fatias 1+2 reais + corpos de PROD de antes da fatia 3"

# ── leituras ──
como_srv() { P -tA -q -c "SELECT pg_catalog.set_config('request.jwt.claims', '{\"role\":\"service_role\"}', false); SET ROLE service_role; $1" 2>&1 | tail -n +2; }
fat()    { como "$1" "SELECT coalesce(faturamento_total::text,'(null)') FROM public.v_grupo_comercial WHERE grupo_id='$GR';"; }
cacafone() { como "$1" "SELECT coalesce(telefone,'(null)')||'|'||contato_visivel FROM public.v_caca_candidatos WHERE cliente_user_id='$2' LIMIT 1;"; }
cacadoc() { como "$1" "SELECT count(*) FROM public.v_caca_candidatos WHERE cliente_user_id='$2';"; }
compr()  { $1 "SELECT count(*)||'|'||coalesce(sum(volume)::text,'(null)') FROM public.v_caca_compradores;"; }
# digests linha a linha (Codex P2: contagem/soma deixam passar troca de documento/empresa/lucro)
dig_compr() { como_srv "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),'')) FROM public.v_caca_compradores t;"; }
dig_cand()  { como "$1" "SELECT md5(coalesce(string_agg(concat_ws('|',documento,empresa_alvo,cidade_uf,ramo,ticket_faixa,familias::text,compra_em_outra_empresa,ultima_compra_grupo_dias,nome,cliente_user_id), '§' ORDER BY documento, empresa_alvo),'')) FROM public.v_caca_candidatos;"; }
dig_grupo() { como "$1" "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),'')) FROM public.v_grupo_comercial t;"; }
# v_perfil_contato é RECRIADA pela 3a (só o plano: ctx/visíveis MATERIALIZED) — a linha inteira, por persona.
dig_vpc()   { como "$1" "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),''))||':'||count(*) FROM public.v_perfil_contato t;"; }
dig_lista() { como "$1" "SELECT md5(coalesce(string_agg(user_id::text||':'||total||':'||coalesce(prioridade_ordenacao::text,'-')||':'||coalesce(nome_ordenacao,'-'), ','),'')) FROM public.listar_clientes_base(NULL, NULL, '$2', 100, 0);"; }
gcont()  { como "$1" "SELECT coalesce(phone,'(null)')||'|'||coalesce(email,'(null)')||'|'||contato_visivel||'|'||nome FROM public.v_grupo_contatos WHERE user_id='$2';"; }
lista()  { como "$1" "SELECT coalesce(string_agg(user_id::text||':'||coalesce(email,'(null)'), ',' ORDER BY user_id),'(vazio)') FROM public.listar_clientes_base('$2', NULL, 'nome', 100, 0);"; }
resolve() { como "$1" "SELECT coalesce(customer_user_id::text,'(null)')||'|'||fonte FROM public.resolver_cliente_por_telefone('$2');"; }
pordoc() { como "$1" "SELECT coalesce(public.cliente_por_documento($2)::text,'(null)');"; }
equipe() { como "$1" "SELECT coalesce(string_agg(user_id::text||':'||coalesce(email,'(null)'), ',' ORDER BY user_id),'(vazio)') FROM public.v_perfil_equipe;"; }

# linha de base com os corpos de PROD (antes): o que a 3a NÃO pode mudar
BASE_FAT_F="$(fat $F)"; BASE_COMPR_SRV="$(compr como_srv)"; BASE_CACA_F="$(cacadoc $F $C3)"
echo "linha de base: fat(F)=$BASE_FAT_F compradores(service_role)=$BASE_COMPR_SRV caca(F,C3)=$BASE_CACA_F"
[ "$BASE_FAT_F" = "200" ] || bad "L0 fixture: faturamento do grupo (C1+C3) não é 200 (veio $BASE_FAT_F) — a prova abaixo seria de graça"
[ "${BASE_COMPR_SRV%%|*}" != "0" ] || bad "L0 fixture: service_role não vê compradores — o assert A1 seria de graça"
[ "$BASE_CACA_F" != "0" ] || bad "L0 fixture: F não vê C3 na Caça — o assert A3 seria de graça"
eq "L0b fixture: opt-out SÓ por telefone tira CR da Caça já nos corpos de PROD" "$(cacadoc $F $CR)" "0"
eq "L1 antes do corte: back-office lê o telefone alheio DIRETO de profiles (furo que a 3b fecha)" \
   "$(como $B "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "4733330003"


P -q -f "$MIGA"; P -q -f "$MIGB"
echo "fatia 3 (3a+3b) aplicada — estado de PROD de 2026-11-26"

M4A="$REPO_ROOT/supabase/migrations/20261126160000_clientes_pii_fatia4a_fontes.sql"
M4B="$REPO_ROOT/supabase/migrations/20261126170000_clientes_pii_fatia4a_corte.sql"

# ── ZONA 3: ACL/policies de PROD das 3 superfícies (psql-ro, 2026-11-26) ──────────
P -q <<'SQL'
-- auth.role() lendo o JWT (o stub devolve NULL): a customer_metrics_mv de prod abre a service_role por ele.
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $f$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $f$;
CREATE OR REPLACE FUNCTION private.cap_pedido_escrever(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $f$ SELECT has_role(_uid, 'employee'::app_role) OR has_role(_uid, 'master'::app_role) $f$;

-- sales_orders: RLS + policies de prod (pg_policies) e ACL de prod (relacl authenticated=a; attacl r/rw)
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_orders_select_customer ON public.sales_orders FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = customer_user_id);
CREATE POLICY sales_orders_select_staff ON public.sales_orders FOR SELECT TO authenticated
  USING ((SELECT has_role((SELECT auth.uid()), 'master'::app_role)) OR (SELECT has_role((SELECT auth.uid()), 'employee'::app_role)));
CREATE POLICY sales_orders_insert_staff ON public.sales_orders FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));
CREATE POLICY sales_orders_update_staff ON public.sales_orders FOR UPDATE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))))
  WITH CHECK ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))));
REVOKE ALL ON public.sales_orders FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.sales_orders TO authenticated;
GRANT SELECT (id, customer_user_id, items, total, status, account, deleted_at, order_date_kpi) ON public.sales_orders TO authenticated;
GRANT UPDATE (items, total, status, deleted_at) ON public.sales_orders TO authenticated;
GRANT SELECT (customer_address, customer_phone, customer_document), UPDATE (customer_address, customer_phone, customer_document) ON public.sales_orders TO authenticated;

-- customer_metrics_mv: matview em private (aqui tabela, mesmas colunas) + a view-gate de PROD (pg_get_viewdef)
CREATE TABLE private.customer_metrics_mv (
  customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamptz,
  dias_desde_ultima_compra integer, pedidos_90d bigint, faturamento_90d numeric, ticket_medio_90d numeric,
  faturamento_prev_90d numeric, intervalo_medio_dias numeric, atraso_relativo numeric, is_cold_start boolean,
  calculated_at timestamptz);
REVOKE ALL ON private.customer_metrics_mv FROM PUBLIC, anon, authenticated, service_role;
CREATE VIEW public.customer_metrics_mv WITH (security_invoker = off, security_barrier = true) AS
 SELECT customer_user_id, razao_social, document, ultima_compra_data, dias_desde_ultima_compra, pedidos_90d,
    faturamento_90d, ticket_medio_90d, faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start, calculated_at
   FROM private.customer_metrics_mv
  WHERE (( SELECT auth.role() AS role)) = 'service_role'::text
     OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'master'::app_role) AS has_role), false)
     OR COALESCE(( SELECT has_role(( SELECT auth.uid() AS uid), 'employee'::app_role) AS has_role), false);
REVOKE ALL ON public.customer_metrics_mv FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;

-- customer_contacts: policies de escrita de prod (a de SELECT já veio do setup) e ACL aberto como em prod
CREATE POLICY customer_contacts_insert_staff ON public.customer_contacts FOR INSERT
  WITH CHECK ((SELECT has_role(auth.uid(), 'employee'::app_role)) OR (SELECT has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY customer_contacts_update_staff ON public.customer_contacts FOR UPDATE
  USING ((SELECT has_role(auth.uid(), 'employee'::app_role)) OR (SELECT has_role(auth.uid(), 'master'::app_role)));
CREATE POLICY customer_contacts_delete_master ON public.customer_contacts FOR DELETE
  USING ((SELECT has_role(auth.uid(), 'master'::app_role)));
GRANT ALL ON public.customer_contacts TO anon, authenticated;
UPDATE public.customer_contacts SET is_primary = false WHERE is_primary IS NULL;
ALTER TABLE public.customer_contacts ALTER COLUMN is_primary SET DEFAULT false, ALTER COLUMN is_primary SET NOT NULL;
CREATE UNIQUE INDEX idx_customer_contacts_one_primary ON public.customer_contacts (customer_user_id) WHERE is_primary = true;
SQL
# estado de PROD das 3 superfícies (para restaurar entre sabotagens)
prod_acl() {
  P -q <<'SQL'
GRANT SELECT (customer_address, customer_phone, customer_document), UPDATE (customer_address, customer_phone, customer_document) ON public.sales_orders TO authenticated;
GRANT SELECT ON public.customer_metrics_mv TO authenticated;
GRANT ALL ON public.customer_contacts TO anon, authenticated;
SQL
}
SO4=a7000000-0000-0000-0000-0000000000a7  # titular = a farmer F (papel staff), snapshot do comprador C3
SO5=a8000000-0000-0000-0000-0000000000a8  # titular = EX2 (só a flag is_employee, sem papel)
P -q <<SQL
INSERT INTO public.sales_orders(id,customer_user_id,customer_document,customer_address,customer_phone) VALUES
 ('$SO4','$F','snap-doc-c3b','snap-end-c3b','snap-fone-c3b'),
 ('$SO5','$EX2','snap-doc-c3c','snap-end-c3c','snap-fone-c3c');
INSERT INTO private.customer_metrics_mv VALUES
 ('$C1','Um Ltda','98765432000111',now() - interval '10 days',10,3,300,100,200,30,0.3,false,now()),
 ('$C3','Tres Ltda','12345678000199',now() - interval '40 days',40,1,90,90,120,20,2.0,false,now());
SQL

# ── leituras ──
SNAP="SELECT coalesce(customer_address,'(null)')||'|'||coalesce(customer_phone,'(null)')||'|'||coalesce(customer_document,'(null)')"
snap_self() { como "$1" "$SNAP FROM public.v_pedido_snapshot_proprio WHERE id='$2';"; }
snap_cru()  { como "$1" "$SNAP FROM public.sales_orders WHERE id='$2';"; }
n_snap()    { como "$1" "SELECT count(*) FROM public.v_pedido_snapshot_proprio;"; }
METR="customer_user_id, razao_social, ultima_compra_data, dias_desde_ultima_compra, pedidos_90d, faturamento_90d, ticket_medio_90d, faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start, calculated_at"
dig_metr()  { como "$1" "SELECT md5(coalesce(string_agg(concat_ws('|',$METR), '§' ORDER BY customer_user_id),''))||':'||count(*) FROM public.customer_metrics_mv;"; }
dig_metr_srv() { como_srv "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),''))||':'||count(*) FROM public.customer_metrics_mv t;"; }
dig_so()    { como "$1" "SELECT md5(coalesce(string_agg(concat_ws('|',id,customer_user_id,items,total,status,account,deleted_at,order_date_kpi), '§' ORDER BY id),''))||':'||count(*) FROM public.sales_orders;"; }
dig_cc_view() { como "$1" "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),''))||':'||count(*) FROM public.v_cliente_contatos t;"; }
cc_view()   { como "$1" "SELECT coalesce(string_agg(phone, ',' ORDER BY phone),'(vazio)') FROM public.v_cliente_contatos WHERE customer_user_id='$2';"; }

# linha de base: estado de PROD de hoje (antes da 4a)
BASE_DIG_COMPR4="$(dig_compr)"; BASE_DIG_CAND4_F="$(dig_cand $F)"; BASE_DIG_GRUPO4_F="$(dig_grupo $F)"
BASE_DIG_METR_SRV="$(dig_metr_srv)"
for _q in F B G M C1; do
  printf -v "BASE_METR_$_q" '%s' "$(dig_metr "${!_q}")"
  printf -v "BASE_SO_$_q" '%s' "$(dig_so "${!_q}")"
  printf -v "BASE_CCV_$_q" '%s' "$(dig_cc_view "${!_q}")"
done
# shellcheck disable=SC2153  # BASE_CCV_* nascem por printf -v no laço acima
echo "linha de base 4a: metr(B)=$BASE_METR_B so(B)=$BASE_SO_B so(C1)=$BASE_SO_C1 ccv(F)=$BASE_CCV_F"
[ "${BASE_METR_B##*:}" = "2" ] || bad "L0 fixture: back-office não vê as 2 métricas (veio $BASE_METR_B) — S7 seria de graça"
[ "${BASE_METR_C1##*:}" = "0" ] || bad "L0 fixture: customer vê métrica (veio $BASE_METR_C1) — a view de prod não é esta"
[ "${BASE_SO_C1##*:}" = "1" ] || bad "L0 fixture: o customer C1 não vê o próprio pedido (veio $BASE_SO_C1)"
[ "${BASE_DIG_METR_SRV##*:}" = "2" ] || bad "L0 fixture: service_role não vê as métricas (veio $BASE_DIG_METR_SRV) — S8 seria de graça"
eq "L2 antes: back-office lê o snapshot de telefone de pedido ALHEIO direto de sales_orders (furo)" \
   "$(como $B "SELECT customer_phone FROM public.sales_orders WHERE id='$SO1';")" "snap-fone-c3"
eq "L3 antes: back-office lê customer_metrics_mv.document de qualquer cliente (furo)" \
   "$(como $B "SELECT document FROM public.customer_metrics_mv WHERE customer_user_id='$C3';")" "12345678000199"
eq "L4 antes: farmer lê o telefone do contato de cliente FORA da carteira direto da tabela (furo)" \
   "$(como $F "SELECT phone FROM public.customer_contacts WHERE customer_user_id='$C3';")" "cc-fone-c3"
P -q -c "DELETE FROM public.contato_acesso_operacional;"
eq "L6 lacuna declarada (4b): a RPC trata pedido com titular=staff como leitura PRÓPRIA — entrega sem ledger" \
   "$(como $F "SELECT pedido_telefone FROM public.contato_cliente_operacional('pedido', '{$SO4}'::uuid[], 'detalhe_pedido');")|$(P -tA -q -c "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id='$F';")" \
   "snap-fone-c3b|0"
eq "L5 antes: o cliente lê o próprio snapshot cru (o caminho que a 4a-1 substitui)" "$(snap_cru $C1 $SO2)" "snap-end-c1|snap-fone-c1|snap-doc-c1"

P -q -f "$M4A"
echo "4a-1 aplicada (postcondição embutida passou)"
P -q -f "$M4B"
echo "4a-2 aplicada — estado de PROD de 2026-11-26 (antes da 4b-1)"

M4B1="$REPO_ROOT/supabase/migrations/20261126230000_clientes_pii_fatia4b1_servidor.sql"

# ── ZONA 4: o resto do estado de PROD que a 4b-1 toca (psql-ro, 2026-11-26) ──────────────────────────
# cliente_grupos (RLS fin_user_can_access — aqui: staff), a view de CR por documento (invoker) e o ACL
# herdado do default privileges (anon=arwdDxtm; customer_contacts anon=adDxtm depois do corte da 4a).
P -q <<'SQL'
CREATE TABLE public.cliente_grupos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), nome text);
ALTER TABLE public.cliente_grupos ENABLE ROW LEVEL SECURITY;
CREATE POLICY cliente_grupos_fin ON public.cliente_grupos FOR ALL
  USING ((SELECT has_role(auth.uid(), 'employee'::app_role)) OR (SELECT has_role(auth.uid(), 'master'::app_role)));
ALTER TABLE public.cliente_grupo_membros ENABLE ROW LEVEL SECURITY;
CREATE POLICY cliente_grupo_membros_fin ON public.cliente_grupo_membros FOR ALL
  USING ((SELECT has_role(auth.uid(), 'employee'::app_role)) OR (SELECT has_role(auth.uid(), 'master'::app_role)));
CREATE VIEW public.v_grupo_contas_receber_por_doc WITH (security_invoker = true) AS
  SELECT m.grupo_id, m.documento FROM public.cliente_grupo_membros m;
SQL
acl_prod_4b() {
  P -q <<'SQL'
GRANT ALL ON public.addresses, public.cliente_grupos, public.cliente_grupo_membros, public.v_grupo_contas_receber_por_doc TO anon, authenticated;
GRANT INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.customer_contacts TO anon;
SQL
}
acl_prod_4b
SO6=a9000000-0000-0000-0000-0000000000a9  # titular = a gestora G (papel staff + gestão), snapshot de C3
P -q -c "INSERT INTO public.sales_orders(id,customer_user_id,customer_document,customer_address,customer_phone) VALUES ('$SO6','$G','snap-doc-g','snap-end-g','snap-fone-g');"

# ── leituras ──
n_ledger() { P -tA -q -c "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id='$1' AND objeto_id='$2';"; }
l6() { # <staff> <pedido> → telefone|via_excecao|linhas no ledger
  P -q -c "DELETE FROM public.contato_acesso_operacional;"
  local r; r="$(como "$1" "SELECT coalesce(pedido_telefone,'(null)')||'|'||via_excecao FROM public.contato_cliente_operacional('pedido', '{$2}'::uuid[], 'detalhe_pedido');")"
  echo "$r|$(n_ledger "$1" "$2")"
}
gend() { como "$1" "SELECT coalesce(endereco,'(null)')||'|'||coalesce(cidade,'(null)')||'|'||coalesce(uf,'(null)') FROM public.v_grupo_contatos WHERE user_id='$2';"; }
GC_COLS="grupo_id, documento, user_id, nome, phone, email, cidade, uf, omie_codigo_vendedor, empresa_omie, contato_visivel"
dig_gc() { como "$1" "SELECT md5(coalesce(string_agg(concat_ws('|',$GC_COLS), '§' ORDER BY user_id),''))||':'||count(*) FROM public.v_grupo_contatos;"; }
cco_dig() { # payload inteiro (fora o ledger) de um tipo — o resto da RPC não pode mudar
  como "$1" "SELECT md5(coalesce(string_agg(t::text, '§' ORDER BY t::text),''))||':'||count(*) FROM public.contato_cliente_operacional('$2', '{$3}'::uuid[], '$4') t;"
}
acl_anon_cr() { P -tA -q -c "SELECT has_table_privilege('anon', 'public.v_grupo_contas_receber_por_doc', 'SELECT');"; }
anon_nega() { veredito "$(nega anon "" insufficient_privilege "$1")"; }

# linha de base 4b-1 (estado de prod)
P -q -c "DELETE FROM public.contato_acesso_operacional;"
for _q in F G M B; do
  printf -v "BASE_GC_$_q" '%s' "$(dig_gc "${!_q}")"
  printf -v "BASE_OS_$_q" '%s' "$(cco_dig "${!_q}" ordem_servico "$OS1" detalhe_os)"
  printf -v "BASE_PC1_$_q" '%s' "$(cco_dig "${!_q}" pedido "$SO2" detalhe_pedido)"
done
P -q -c "DELETE FROM public.contato_acesso_operacional;"
# shellcheck disable=SC2153  # BASE_* nascem por printf -v no laço acima
echo "linha de base 4b-1: gc(F)=$BASE_GC_F gc(G)=$BASE_GC_G os(F)=$BASE_OS_F"
[ "${BASE_GC_F##*:}" = "2" ] || bad "L0 fixture: a farmer não vê os 2 membros do grupo (veio $BASE_GC_F) — G2 seria de graça"
eq "L10 antes: L6 — farmer lê o snapshot do pedido em que ELA é a titular, sem ledger" "$(l6 "$F" "$SO4")" "snap-fone-c3b|false|0"
eq "L11 antes: anon apaga de customer_contacts sem barreira de privilégio (só a RLS segura)" \
   "$(anon_nega "DELETE FROM public.customer_contacts WHERE false")" "vazou"
eq "L12 antes: anon passa do privilégio em addresses" "$(anon_nega "SELECT 1 FROM public.addresses WHERE false")" "vazou"
eq "L13 antes: a farmer lê a RUA do membro do grupo fora da carteira (v_grupo_contatos lê addresses crua)" \
   "$(gend "$F" "$C3")" "rua-c3 3|Joinville|SC"
eq "L14 antes: ex-funcionário (flag sem papel) segue no diretório de equipe" \
   "$(equipe "$F" | tr ',' '\n' | grep -c "^$EX2:")" "1"

P -q -f "$M4B1"
echo "4b-1 aplicada (postcondição embutida passou)"

suite_u() {
  echo "-- U. fatia 4b-1 --"
  eq "U1 L6: titular = a própria farmer (fora da carteira) agora vai para o ledger como exceção" "$(l6 "$F" "$SO4")" "snap-fone-c3b|true|1"
  eq "U1b titular = gestora: gestão segue sem exceção e sem ledger" "$(l6 "$G" "$SO6")" "snap-fone-g|false|0"
  eq "U1c pedido de cliente da carteira segue sem exceção" "$(l6 "$F" "$SO2")" "snap-fone-c1|false|0"
  eq "U1d pedido alheio fora da carteira segue exceção com ledger" "$(l6 "$F" "$SO1")" "snap-fone-c3|true|1"
  P -q -c "DELETE FROM public.contato_acesso_operacional;"
  for _q in F G M B; do
    local b_os="BASE_OS_$_q" b_pc="BASE_PC1_$_q"
    eq "U2 $_q: payload de OS idêntico ao de antes" "$(cco_dig "${!_q}" ordem_servico "$OS1" detalhe_os)" "${!b_os}"
    eq "U2b $_q: payload do pedido de C1 idêntico ao de antes" "$(cco_dig "${!_q}" pedido "$SO2" detalhe_pedido)" "${!b_pc}"
  done
  P -q -c "DELETE FROM public.contato_acesso_operacional;"
  eq "U3 anon sem DELETE em customer_contacts" "$(anon_nega "DELETE FROM public.customer_contacts WHERE false")" "barrado"
  eq "U3b anon sem INSERT em customer_contacts" "$(anon_nega "INSERT INTO public.customer_contacts(nome) SELECT 'x' WHERE false")" "barrado"
  eq "U3c anon sem SELECT em addresses" "$(anon_nega "SELECT 1 FROM public.addresses WHERE false")" "barrado"
  eq "U3d anon sem INSERT em addresses" "$(anon_nega "INSERT INTO public.addresses(city) SELECT 'x' WHERE false")" "barrado"
  eq "U3e anon sem SELECT em cliente_grupos" "$(anon_nega "SELECT 1 FROM public.cliente_grupos WHERE false")" "barrado"
  eq "U3f anon sem SELECT em cliente_grupo_membros" "$(anon_nega "SELECT 1 FROM public.cliente_grupo_membros WHERE false")" "barrado"
  # a view de CR é invoker: a tabela base já barra o anon (defesa em profundidade) — mede o ACL da PRÓPRIA view
  eq "U3g anon sem SELECT no ACL de v_grupo_contas_receber_por_doc" "$(acl_anon_cr)" "f"
  eq "U4 farmer: membro do grupo FORA da carteira sai sem rua (cidade/UF seguem)" "$(gend "$F" "$C3")" "(null)|Joinville|SC"
  eq "U4b farmer: membro DENTRO da carteira segue com a rua" "$(gend "$F" "$C1")" "rua-c1 1|Curitiba|PR"
  eq "U4c gestora vê a rua dos dois" "$(gend "$G" "$C3")" "rua-c3 3|Joinville|SC"
  eq "U4d master vê a rua dos dois" "$(gend "$M" "$C3")" "rua-c3 3|Joinville|SC"
  eq "U4e back-office (sem carteira) não vê rua de ninguém" "$(gend "$B" "$C1")|$(gend "$B" "$C3")" "(null)|Curitiba|PR|(null)|Joinville|SC"
  for _q in F G M B; do
    local b_gc="BASE_GC_$_q"
    eq "U5 $_q: o resto da linha do grupo (documento incluso — decisão do founder) idêntico" "$(dig_gc "${!_q}")" "${!b_gc}"
  done
  eq "U5b customer segue sem linha no grupo" "$(dig_gc "$C1")" "$(como "$C1" "SELECT md5('')||':0';")"
  eq "U6 ex-funcionário (flag sem papel) sai do diretório de equipe" "$(equipe "$F" | tr ',' '\n' | grep -c "^$EX2:" || true)" "0"
  eq "U6b equipe por papel: E (papel+flag) e E2 (só papel) seguem; C1, C3, PN fora (só eles têm profiles no seed)" \
     "$(equipe "$F" | tr ',' '\n' | cut -d: -f1 | sort | tr '\n' ' ')" \
     "$(printf '%s\n' "$E" "$E2" | sort | tr '\n' ' ')"
  eq "U6c customer não vê o diretório" "$(equipe "$C1")" "(vazio)"
  eq "U7 service_role segue lendo addresses" "$(como_srv "SELECT street FROM public.addresses WHERE user_id='$C3';")" "rua-c3"
  eq "U7b o customer segue lendo o próprio endereço cru" "$(como "$C1" "SELECT street FROM public.addresses WHERE user_id='$C1';")" "rua-c1"
}
suite_u

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; a suíte verde acima já rodou) ═════════
echo "-- FALSIFICAÇÃO: uma sabotagem por camada, cada uma com o SEU vermelho --"
exige_vermelho() { # <rótulo> <obtido> <correto> <vermelho-esperado>
  if [ "$2" = "$3" ]; then bad "$1 — sabotado ficou VERDE (assert não pega a camada) [$2]"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — vermelho ALHEIO ao mutante: esperado [$4], veio [$2]"; fi
}
# sabota <perl expr> — reaplica sobre o ACL de PROD a 4b-1 sabotada, sem a postcondição
sabota() {
  perl -0pe "$1" "$M4B1" > "$RODADA/sabotada.sql"
  if cmp -s "$M4B1" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a 4b-1 ($1)"; fi
  perl -0pi -e 's/DO \$post\$.*?\$post\$;//s' "$RODADA/sabotada.sql"
  acl_prod_4b
  P -q -f "$RODADA/sabotada.sql"
}
# sabota_post <perl expr> <marca> <rótulo> — a postcondição TEM de abortar com a sua marca
sabota_post() {
  perl -0pe "$1" "$M4B1" > "$RODADA/sabotada.sql"
  if cmp -s "$M4B1" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a 4b-1 ($1)"; fi
  acl_prod_4b
  if P -q -f "$RODADA/sabotada.sql" >/dev/null 2>"$RODADA/post.err"; then bad "$3 — a postcondição NÃO abortou"
  elif grep -q "$2" "$RODADA/post.err"; then ok "$3 → postcondição aborta ($2)"
  else bad "$3 — abortou por outro motivo: $(head -c 300 "$RODADA/post.err")"; fi
}
restaura() { acl_prod_4b; P -q -f "$M4B1"; }

sabota 's/NOT COALESCE\(v_gestao OR EXISTS/NOT COALESCE(a.cid = v_uid OR v_gestao OR EXISTS/'
exige_vermelho "K1 RPC com o ramo próprio de volta → U1" "$(l6 "$F" "$SO4")" "snap-fone-c3b|true|1" "snap-fone-c3b|false|0"; restaura

sabota 's/REVOKE ALL ON public\.customer_contacts FROM PUBLIC, anon;\n//'
exige_vermelho "K2 sem o REVOKE de anon em customer_contacts → U3" "$(anon_nega "DELETE FROM public.customer_contacts WHERE false")" "barrado" "vazou"; restaura

sabota 's/REVOKE ALL ON public\.addresses FROM PUBLIC, anon;\n//'
exige_vermelho "K3 sem o REVOKE de anon em addresses → U3c" "$(anon_nega "SELECT 1 FROM public.addresses WHERE false")" "barrado" "vazou"; restaura

sabota 's/REVOKE ALL ON public\.cliente_grupo_membros FROM PUBLIC, anon;\n//'
exige_vermelho "K4 sem o REVOKE de anon nos membros do grupo → U3f" "$(anon_nega "SELECT 1 FROM public.cliente_grupo_membros WHERE false")" "barrado" "vazou"; restaura

sabota 's/REVOKE ALL ON public\.v_grupo_contas_receber_por_doc FROM PUBLIC, anon;\n//'
exige_vermelho "K5 sem o REVOKE de anon no CR por documento → U3g" "$(acl_anon_cr)" "f" "t"; restaura

sabota 's/LEFT JOIN public\.v_endereco_contato a ON/LEFT JOIN public.addresses a ON/'
exige_vermelho "K6 grupo lendo addresses crua → U4" "$(gend "$F" "$C3")" "(null)|Joinville|SC" "rua-c3 3|Joinville|SC"; restaura

sabota 's/WHERE ctx\.staff AND p\.user_id IS NOT NULL AND \(p\.user_id IN/WHERE ctx.staff AND p.user_id IS NOT NULL AND (COALESCE(p.is_employee, false) OR p.user_id IN/'
exige_vermelho "K7 equipe aceitando a flag → U6" "$(equipe "$F" | tr ',' '\n' | grep -c "^$EX2:" || true)" "0" "1"; restaura

# postcondições: cada uma aborta a migration sabotada com a SUA marca
sabota_post 's/NOT COALESCE\(v_gestao OR EXISTS/NOT COALESCE(a.cid = v_uid OR v_gestao OR EXISTS/' 'C1 FALHOU' "K8 4b-1 com o ramo próprio"; restaura
sabota_post 's/REVOKE ALL ON FUNCTION public\.contato_cliente_operacional\(text, uuid\[\], text\) FROM PUBLIC, anon;/GRANT EXECUTE ON FUNCTION public.contato_cliente_operacional(text, uuid[], text) TO anon;/' 'C1 FALHOU' "K9 4b-1 abrindo a RPC para anon"; restaura
sabota_post 's/REVOKE ALL ON public\.cliente_grupos FROM PUBLIC, anon;\n//' 'C2 FALHOU' "K10 4b-1 sem o REVOKE em cliente_grupos"; restaura
sabota_post 's/REVOKE ALL ON public\.addresses FROM PUBLIC, anon;/REVOKE ALL ON public.addresses FROM PUBLIC, anon, authenticated;/' 'C3 FALHOU' "K11 4b-1 levando authenticated junto em addresses"; restaura
sabota_post 's/CREATE OR REPLACE VIEW public\.v_grupo_contatos WITH \(security_invoker = true\) AS/CREATE OR REPLACE VIEW public.v_grupo_contatos AS/' 'C4 FALHOU' "K12 4b-1 sem repetir security_invoker no grupo"
P -q -c "ALTER VIEW public.v_grupo_contatos SET (security_invoker = true);"; restaura
sabota_post 's/LEFT JOIN public\.v_endereco_contato a ON/LEFT JOIN public.addresses a ON/' 'C4 FALHOU' "K13 4b-1 com o grupo lendo addresses crua"; restaura
sabota_post 's/WITH \(security_invoker = off, security_barrier = true\) AS\n WITH ctx AS/WITH (security_invoker = on, security_barrier = true) AS\n WITH ctx AS/' 'C5 FALHOU' "K14 4b-1 com a equipe invoker=on"
P -q -c "ALTER VIEW public.v_perfil_equipe SET (security_invoker = off);"; restaura
sabota_post 's/WHERE ctx\.staff AND p\.user_id IS NOT NULL AND \(p\.user_id IN/WHERE ctx.staff AND p.user_id IS NOT NULL AND (COALESCE(p.is_employee, false) OR p.user_id IN/' 'C5 FALHOU' "K15 4b-1 com a equipe aceitando a flag"; restaura

echo "-- pós-falsificação: tudo restaurado volta verde --"
suite_u

echo "──────────────────────────────"
echo "LOCALE: $LOCALE_TESTE"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

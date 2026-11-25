#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 3 — leitores de servidor (3a) + CORTE de profiles (3b)
# ║    bash db/test-clientes-pii-fatia3-corte.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-fatia3-corte.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Base: fatias 1+2 reais (20261124120000/130000/180000) + os corpos de PROD de antes
# ║  (db/fixtures/clientes-pii-fatia3-prod-antes.sql) → 20261125120000 (3a) → 20261125130000 (3b).
# ║  Setup e personas copiados de db/test-clientes-contato-operacional.sh (farmer F, outra dona O,
# ║  cobertura K, gestor G, master M, back-office B, customer C1…).
# ║  JWT pela GUC real request.jwt.claims. Negativos casam a SQLSTATE pelo NOME e re-lançam o resto.
# ║  FALSIFICAÇÃO na MESMA invocação: suíte verde antes, uma sabotagem POR CAMADA com o seu vermelho,
# ║  suíte verde de novo depois.
# ╚═════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5495}"
SLUG="piifatia3"
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
dig_lista() { como "$1" "SELECT md5(coalesce(string_agg(user_id::text||':'||total||':'||coalesce(prioridade_ordenacao::text,'-')||':'||coalesce(nome_ordenacao,'-'), ','),'')) FROM public.listar_clientes_base(NULL, NULL, '$2', 100, 0);"; }
gcont()  { como "$1" "SELECT coalesce(phone,'(null)')||'|'||coalesce(email,'(null)')||'|'||contato_visivel||'|'||nome FROM public.v_grupo_contatos WHERE user_id='$2';"; }
lista()  { como "$1" "SELECT coalesce(string_agg(user_id::text||':'||coalesce(email,'(null)'), ',' ORDER BY user_id),'(vazio)') FROM public.listar_clientes_base('$2', NULL, 'nome', 100, 0);"; }
resolve() { como "$1" "SELECT coalesce(customer_user_id::text,'(null)')||'|'||fonte FROM public.resolver_cliente_por_telefone('$2');"; }
pordoc() { como "$1" "SELECT coalesce(public.cliente_por_documento($2)::text,'(null)');"; }
equipe() { como "$1" "SELECT coalesce(string_agg(user_id::text||':'||coalesce(email,'(null)'), ',' ORDER BY user_id),'(vazio)') FROM public.v_perfil_equipe;"; }

# linha de base com os corpos de PROD (antes): o que a 3a NÃO pode mudar
BASE_FAT_F="$(fat $F)"; BASE_COMPR_SRV="$(compr como_srv)"; BASE_CACA_F="$(cacadoc $F $C3)"
BASE_DIG_COMPR="$(dig_compr)"; BASE_DIG_CAND_F="$(dig_cand $F)"; BASE_DIG_CAND_B="$(dig_cand $B)"; BASE_DIG_GRUPO_F="$(dig_grupo $F)"
BASE_DIG_LISTA_F="$(dig_lista $F prioridade)"; BASE_DIG_LISTA_B="$(dig_lista $B nome)"
echo "linha de base: fat(F)=$BASE_FAT_F compradores(service_role)=$BASE_COMPR_SRV caca(F,C3)=$BASE_CACA_F"
[ "$BASE_FAT_F" = "200" ] || bad "L0 fixture: faturamento do grupo (C1+C3) não é 200 (veio $BASE_FAT_F) — a prova abaixo seria de graça"
[ "${BASE_COMPR_SRV%%|*}" != "0" ] || bad "L0 fixture: service_role não vê compradores — o assert A1 seria de graça"
[ "$BASE_CACA_F" != "0" ] || bad "L0 fixture: F não vê C3 na Caça — o assert A3 seria de graça"
eq "L0b fixture: opt-out SÓ por telefone tira CR da Caça já nos corpos de PROD" "$(cacadoc $F $CR)" "0"
eq "L1 antes do corte: back-office lê o telefone alheio DIRETO de profiles (furo que a 3b fecha)" \
   "$(como $B "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "4733330003"

P -q -f "$MIGA"
echo "3a aplicada (postcondição embutida passou)"

suite_a() {
  echo "-- A. leitores de servidor (3a) --"
  eq "A1 service_role (edge de custo) vê os MESMOS compradores de antes" "$(compr como_srv)" "$BASE_COMPR_SRV"
  eq "A1b ... linha a linha (documento, empresa, volume, lucro)" "$(dig_compr)" "$BASE_DIG_COMPR"
  eq "A1c Caça (farmer): mesma fila linha a linha, fora telefone" "$(dig_cand $F)" "$BASE_DIG_CAND_F"
  eq "A1d Caça (back-office): idem" "$(dig_cand $B)" "$BASE_DIG_CAND_B"
  eq "A1e Caça: opt-out SÓ por telefone continua tirando CR (a chave crua decide)" "$(cacadoc $F $CR)" "0"
  eq "A1f grupo comercial (farmer): mesma linha inteira" "$(dig_grupo $F)" "$BASE_DIG_GRUPO_F"
  eq "A1g lista (farmer, prioridade): mesmos ids, total e ordem" "$(dig_lista $F prioridade)" "$BASE_DIG_LISTA_F"
  eq "A1h lista (back-office, nome): idem" "$(dig_lista $B nome)" "$BASE_DIG_LISTA_B"
  eq "A2 grupo: faturamento do grupo NÃO zera para quem está fora da carteira de parte dele" "$(fat $F)" "$BASE_FAT_F"
  eq "A3 Caça: cliente fora da carteira continua na fila (documento é a chave)" "$(cacadoc $F $C3)" "$BASE_CACA_F"
  eq "A4 Caça: telefone fora da carteira vem mascarado" "$(cacafone $F $C3)" "(null)|false"
  eq "A5 Caça: telefone da própria carteira aparece" "$(cacafone $F $C1)" "4133330001|true"
  eq "A6 Caça: gestor vê o telefone de todos" "$(cacafone $G $C3)" "4733330003|true"
  eq "A6b Caça: cobertura vigente vê" "$(cacafone $K $C3)" "4733330003|true"
  eq "A7 grupo/contatos: fora da carteira = identidade sem contato" "$(gcont $F $C3)" "(null)|(null)|false|Tres Ltda"
  eq "A8 grupo/contatos: master vê" "$(gcont $M $C3)" "4733330003|tres@x.test|true|Tres Ltda"
  eq "A9 lista: busca por e-mail OCULTO responde como termo ausente" "$(lista $F 'tres@x')" "(vazio)"
  eq "A9b lista: busca por documento OCULTO idem" "$(lista $F '12345678')" "(vazio)"
  eq "A9c lista: busca por telefone OCULTO idem" "$(lista $F '33330003')" "(vazio)"
  eq "A10 lista: e-mail da própria carteira acha" "$(lista $F 'um@x')" "$C1:um@x.test"
  eq "A11 lista: gestor acha pelo e-mail de qualquer um" "$(lista $G 'tres@x')" "$C3:tres@x.test"
  eq "A12 lista: sem busca, cliente fora da carteira aparece SEM e-mail" \
     "$(como $F "SELECT coalesce(email,'(null)') FROM public.listar_clientes_base(NULL,NULL,'nome',100,0) WHERE user_id='$C3';")" "(null)"
  eq "A13 telefonia: resolve fora da carteira (ring-all, só identidade)" "$(resolve $F '(47) 3333-0003')" "$C3|perfil"
  eq "A13b telefonia: back-office também" "$(resolve $B '4733330003')" "$C3|perfil"
  eq "A14 telefonia: customer barrado com 42501" \
     "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT * FROM public.resolver_cliente_por_telefone('4733330003')")")" "barrado"
  eq "A14b telefonia: anon sem EXECUTE" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT * FROM public.resolver_cliente_por_telefone('4733330003')")")" "barrado"
  eq "A15 documento → identidade (variante limpa)" "$(pordoc $F "ARRAY['12345678000199']")" "$C3"
  eq "A15b documento → identidade (variante crua + limpa, nulo e vazio ignorados)" "$(pordoc $B "ARRAY['12.345.678/0001-99','12345678000199','',NULL]")" "$C3"
  eq "A15c documento desconhecido → null" "$(pordoc $F "ARRAY['00000000000000']")" "(null)"
  eq "A16 documento: customer barrado com 42501" \
     "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT public.cliente_por_documento(ARRAY['12345678000199'])")")" "barrado"
  eq "A16b documento: anon sem EXECUTE" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT public.cliente_por_documento(ARRAY['12345678000199'])")")" "barrado"
  eq "A16c documento: mais de 4 variantes → 22023" \
     "$(veredito "$(nega authenticated $F invalid_parameter_value "SELECT public.cliente_por_documento(ARRAY['a','b','c','d','e'])")")" "barrado"
  eq "A17 equipe: staff vê e-mail de quem é staff (papel OU flag), e só deles" "$(equipe $B)" "$E:func@x.test,$E2:e2@x.test,$EX2:ex2@x.test"
  eq "A17b equipe: customer não vê ninguém" "$(equipe $C1)" "(vazio)"
  eq "A17c equipe: anon sem SELECT" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT * FROM public.v_perfil_equipe")")" "barrado"
  eq "A18 chave interna: anon sem SELECT" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT * FROM private.v_perfil_chaves_internas")")" "barrado"
  eq "A18b chave interna: customer só vê a própria linha" "$(como $C1 "SELECT count(*) FROM private.v_perfil_chaves_internas;")" "1"
  eq "A19 views de Caça/Grupo: anon sem SELECT" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.v_grupo_contatos")")" "barrado"
}
suite_a

echo "-- C0. antes do corte, o upsert do signup (como o PostgREST gera) funciona --"
upsert_self() { # <uid> <email> — a forma NOVA do Auth.tsx: insert … ON CONFLICT DO NOTHING + UPDATE … WHERE user_id
  como "$1" "INSERT INTO public.profiles(user_id,name,email,phone,document) VALUES ('$1','Cliente Um','$2','4133330001','98765432000111')
             ON CONFLICT (user_id) DO NOTHING;
             UPDATE public.profiles SET name='Cliente Um', email='$2', phone='4133330001', document='98765432000111' WHERE user_id='$1';
             SELECT email FROM public.v_perfil_contato WHERE user_id='$1';"
}
eq "C0 signup (forma nova) antes do corte, e persiste" "$(upsert_self $C1 c0@x.test)" "c0@x.test"
upsert_self $C1 um@x.test >/dev/null

P -q -f "$MIGB"
echo "3b aplicada (postcondição embutida passou)"

suite_b() {
  echo "-- B. o corte (3b) pela API: authenticated/anon --"
  local c
  for c in email phone document cnpj; do
    eq "B1 back-office NÃO lê profiles.$c (42501)" \
       "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT $c FROM public.profiles WHERE user_id='$C3'")")" "barrado"
    eq "B1b farmer NÃO filtra por profiles.$c (42501, sem oráculo)" \
       "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT user_id FROM public.profiles WHERE $c = 'x'")")" "barrado"
  done
  eq "B2 SELECT * em profiles quebra ALTO (42501)" \
     "$(veredito "$(nega authenticated $G insufficient_privilege "SELECT * FROM public.profiles LIMIT 1")")" "barrado"
  eq "B3 master também não lê a coluna direto (contato só pela view)" \
     "$(veredito "$(nega authenticated $M insufficient_privilege "SELECT email FROM public.profiles LIMIT 1")")" "barrado"
  eq "B4 self NÃO lê o próprio e-mail direto (vai pela view)" \
     "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT email FROM public.profiles WHERE user_id='$C1'")")" "barrado"
  eq "B5 anon NÃO filtra por documento (signup morto)" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT id FROM public.profiles WHERE document = '12345678000199'")")" "barrado"
  eq "B6 identidade continua aberta a staff" \
     "$(como $B "SELECT name||'|'||razao_social||'|'||requires_po FROM public.profiles WHERE user_id='$C3';")" "Cliente Tres|Tres Ltda|true"
  eq "B6b anon lê identidade sem erro (RLS dá 0 linhas, como antes)" "$(P -tA -q -c "SET ROLE anon; SELECT count(*) FROM public.profiles;" 2>&1 | tail -n +1)" "0"
  eq "B7 self pela view vê o próprio contato" \
     "$(como $C1 "SELECT email FROM public.v_perfil_contato WHERE user_id='$C1';")" "um@x.test"
  eq "B8 gestor pela view vê o de fora" "$(como $G "SELECT phone FROM public.v_perfil_contato WHERE user_id='$C3';")" "4733330003"
  eq "B8b farmer pela view: fora da carteira mascarado" \
     "$(como $F "SELECT coalesce(phone,'(null)')||'|'||contato_visivel FROM public.v_perfil_contato WHERE user_id='$C3';")" "(null)|false"
  eq "B9 signup na forma nova (DO NOTHING + UPDATE) segue funcionando e PERSISTE" "$(upsert_self $C1 b9@x.test)" "b9@x.test"
  eq "B9c perfil NOVO nasce pela forma nova (caminho do INSERT, não do UPDATE)" "$(upsert_self $X x@x.test)" "x@x.test"
  P -q -c "DELETE FROM public.profiles WHERE user_id='$X';"; upsert_self $C1 um@x.test >/dev/null
  eq "B9b a forma ANTIGA do Auth.tsx (ON CONFLICT DO UPDATE … EXCLUDED.email) quebra — por isso o front mudou" \
     "$(veredito "$(nega authenticated $C1 insufficient_privilege "INSERT INTO public.profiles(user_id,email) VALUES ('$C1','um@x.test') ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email")")" "barrado"
  eq "B10 update self do documento (Profile.tsx) segue funcionando" \
     "$(como $C1 "UPDATE public.profiles SET document='98765432000222' WHERE user_id='$C1'; SELECT document FROM public.v_perfil_contato WHERE user_id='$C1';")" "98765432000222"
  P -q -c "UPDATE public.profiles SET document='98765432000111' WHERE user_id='$C1';"
  eq "B11 service_role (edges) segue lendo tudo" "$(como_srv "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "4733330003"
  P -q -c "DELETE FROM public.contato_acesso_operacional;"
  eq "B12 RPC operacional da fatia 2 segue entregando (exceção no pedido)" \
     "$(como $B "SELECT phone FROM public.contato_cliente_operacional('pedido', '{$SO1}'::uuid[], 'detalhe_pedido');")" "4733330003"
  eq "B12b ... e grava a exceção no ledger" \
     "$(P -tA -q -c "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id='$B' AND customer_user_id='$C3';")" "1"
}
suite_a
suite_b

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; as suítes verdes acima já rodaram) ═════════
echo "-- FALSIFICAÇÃO: uma sabotagem por camada, cada uma com o SEU vermelho --"
exige_vermelho() { # <rótulo> <obtido> <correto> <vermelho-esperado> — o vermelho tem de ser O DO MUTANTE
  if [ "$2" = "$3" ]; then bad "$1 — sabotado ficou VERDE (assert não pega a camada) [$2]"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — vermelho ALHEIO ao mutante: esperado [$4], veio [$2]"; fi
}
sabota_a() { # <perl expr> — reaplica a 3a com o corpo sabotado (sem a postcondição)
  perl -0pe "$1" "$MIGA" > "$RODADA/sabotada.sql"
  if cmp -s "$MIGA" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou a 3a ($1)"; fi
  perl -0pi -e 's/DO \$post\$.*?\$post\$;//s' "$RODADA/sabotada.sql"
  P -q -f "$RODADA/sabotada.sql"
}
restaura() { P -q -f "$MIGA"; P -q -f "$MIGB"; }

P -q -c "GRANT SELECT ON public.profiles TO authenticated;"
exige_vermelho "K1 sem o REVOKE → B1" "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT phone FROM public.profiles WHERE user_id='$C3'")")" "barrado" "vazou"; restaura

P -q -c "GRANT SELECT (document) ON public.profiles TO anon;"
exige_vermelho "K2 grant de coluna de contato ao anon → B5" "$(veredito "$(nega anon "" insufficient_privilege "SELECT id FROM public.profiles WHERE document = 'x'")")" "barrado" "vazou"
P -q -c "REVOKE SELECT (document) ON public.profiles FROM anon;"

perl -0pe 's/prospect_origin_call_id\n\) ON public\.profiles/prospect_source\n) ON public.profiles/; s/  prospect_origin_call_id\n//' "$MIGB" > "$RODADA/b-sabotada.sql"
cmp -s "$MIGB" "$RODADA/b-sabotada.sql" && bad "sabotagem K3 não alterou a 3b"
P -q -c "REVOKE SELECT ON public.profiles FROM anon, authenticated;"
if P -q -f "$RODADA/b-sabotada.sql" >/dev/null 2>"$RODADA/k3.err"; then bad "K3 grant sem uma coluna de identidade — a postcondição NÃO abortou"
elif grep -q 'perdeu colunas de identidade' "$RODADA/k3.err"; then ok "K3 grant sem uma coluna de identidade → postcondição aborta"
else bad "K3 abortou por outro motivo: $(head -c 300 "$RODADA/k3.err")"; fi
restaura

sabota_a 's/ WHERE ctx\.servico\n    OR /  WHERE /'
exige_vermelho "K4 chave interna sem o ramo service_role → A1 (edge de custo ficaria vazia)" "$(compr como_srv)" "$BASE_COMPR_SRV" "0|(null)"; restaura

sabota_a 's/    vpc\.phone AS telefone,/    cand.phone AS telefone,/'
exige_vermelho "K5 Caça projeta o telefone cru → A4" "$(cacafone $F $C3)" "(null)|false" "4733330003|false"; restaura

sabota_a 's/    vpc\.phone,\n    vpc\.email,/    k.phone,\n    vpc.email,/'
exige_vermelho "K6 grupo/contatos projeta o telefone cru → A7" "$(gcont $F $C3)" "(null)|(null)|false|Tres Ltda" "4733330003|(null)|false|Tres Ltda"; restaura

sabota_a 's/OR vpc\.email    ILIKE/OR (SELECT k.document FROM private.v_perfil_chaves_internas k WHERE k.user_id = p.user_id) ILIKE/'
exige_vermelho "K7 lista busca no contato CRU → A9b (oráculo)" "$(lista $F '12345678')" "(vazio)" "$C3:(null)"; restaura

sabota_a 's/  IF NOT \(COALESCE\(public\.has_role\(auth\.uid\(\), .employee.::public\.app_role\), false\)\n          OR COALESCE\(public\.has_role\(auth\.uid\(\), .master.::public\.app_role\), false\)\) THEN\n    RAISE EXCEPTION .resolver_cliente_por_telefone/  IF false THEN\n    RAISE EXCEPTION '"'"'resolver_cliente_por_telefone/'
exige_vermelho "K8 telefonia sem gate de staff → A14" "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT * FROM public.resolver_cliente_por_telefone('4733330003')")")" "barrado" "vazou"; restaura

sabota_a 's/  IF NOT \(COALESCE\(public\.has_role\(auth\.uid\(\), .employee.::public\.app_role\), false\)\n          OR COALESCE\(public\.has_role\(auth\.uid\(\), .master.::public\.app_role\), false\)\) THEN\n    RAISE EXCEPTION .cliente_por_documento/  IF false THEN\n    RAISE EXCEPTION '"'"'cliente_por_documento/'
exige_vermelho "K9 documento sem gate de staff → A16" "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT public.cliente_por_documento(ARRAY['12345678000199'])")")" "barrado" "vazou"; restaura

sabota_a 's/ WHERE ctx\.staff\n   AND p\.user_id IS NOT NULL/ WHERE p.user_id IS NOT NULL/'
exige_vermelho "K10 equipe sem exigir leitor staff → A17b" "$(equipe $C1)" "(vazio)" "$E:func@x.test,$E2:e2@x.test,$EX2:ex2@x.test"; restaura

sabota_a 's/   AND \(COALESCE\(p\.is_employee, false\)\n        OR p\.user_id IN/   AND (true\n        OR p.user_id IN/'
exige_vermelho "K11 equipe sem exigir ALVO staff (vazaria e-mail de cliente) → A17" "$(equipe $B)" "$E:func@x.test,$E2:e2@x.test,$EX2:ex2@x.test" "$(P -tA -q -c "SELECT string_agg(user_id::text||':'||coalesce(email,'(null)'), ',' ORDER BY user_id) FROM public.profiles WHERE user_id IS NOT NULL")"; restaura

sabota_a 's/    OR \(ctx\.uid IS NOT NULL AND \(p\.user_id = ctx\.uid OR ctx\.staff\)\);/    OR (ctx.uid IS NOT NULL);/'
exige_vermelho "K12 chave interna sem fronteira de linha → A18b" "$(como $C1 "SELECT count(*) FROM private.v_perfil_chaves_internas;")" "1" "7"; restaura

# K13: anon é barrado nas 4 views por TRÊS camadas (o REVOKE na view, a chave interna e a v_perfil_contato,
# ambas sem anon) — sabotar uma só fica verde, então nenhuma é falsificável sozinha pelo A19. O que se
# falsifica é a POSTCONDIÇÃO: sem o REVOKE de anon na view, a migration tem de abortar.
P -q -c "GRANT SELECT ON public.v_grupo_contatos TO anon;"
perl -0pe 's/\nREVOKE ALL ON public\.v_grupo_contatos FROM anon;\n/\n/' "$MIGA" > "$RODADA/a-k13.sql"
cmp -s "$MIGA" "$RODADA/a-k13.sql" && bad "sabotagem K13 não alterou a 3a"
if P -q -f "$RODADA/a-k13.sql" >/dev/null 2>"$RODADA/k13.err"; then bad "K13 view de grupo aberta ao anon — a postcondição NÃO abortou"
elif grep -q 'anon le public.v_grupo_contatos' "$RODADA/k13.err"; then ok "K13 view de grupo aberta ao anon → postcondição aborta"
else bad "K13 abortou por outro motivo: $(head -c 300 "$RODADA/k13.err")"; fi
restaura

sabota_a 's/SELECT p\.user_id, p\.document, p\.cnpj, p\.phone\n  FROM public\.profiles p/SELECT p.user_id, p.document, p.cnpj, NULL::text AS phone\n  FROM public.profiles p/'
exige_vermelho "K14 chave interna sem o telefone cru → A1e (opt-out por telefone some)" "$(cacadoc $F $CR)" "0" "2"; restaura

echo "-- pós-falsificação: tudo restaurado volta verde --"
suite_a
suite_b

echo "──────────────────────────────"
echo "LOCALE: $LOCALE_TESTE"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

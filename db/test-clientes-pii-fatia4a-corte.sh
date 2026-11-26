#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════
# ║  Prova PG17 da onda D / fatia 4a — snapshot de pedido, métrica e contatos do cliente
# ║    bash db/test-clientes-pii-fatia4a-corte.sh > log 2>&1; echo $?
# ║    LOCALE_TESTE=pt_BR.UTF-8 bash db/test-clientes-pii-fatia4a-corte.sh
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║  Base: o setup INTEIRO de db/test-clientes-pii-fatia3-corte.sh (fatias 1+2 reais, corpos de PROD de
# ║  antes da 3, 3a e 3b reais) + o ACL/policies de PROD (psql-ro, 2026-11-26) de sales_orders,
# ║  customer_metrics_mv e customer_contacts → 20261126130000 (4a-1) → 20261126140000 (4a-2).
# ║  Negativos casam a SQLSTATE pelo NOME e re-lançam o resto. Digests linha a linha por persona antes
# ║  e depois. FALSIFICAÇÃO na MESMA invocação: suíte verde antes, uma sabotagem POR CAMADA com o seu
# ║  vermelho EXATO, suíte verde de novo depois.
# ╚═════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5496}"
SLUG="piifatia4a"
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
BASE_DIG_COMPR="$(dig_compr)"; BASE_DIG_CAND_F="$(dig_cand $F)"; BASE_DIG_CAND_B="$(dig_cand $B)"; BASE_DIG_GRUPO_F="$(dig_grupo $F)"
BASE_DIG_LISTA_F="$(dig_lista $F prioridade)"; BASE_DIG_LISTA_B="$(dig_lista $B nome)"
for _q in F O K G M B X C1; do printf -v "BASE_DIG_VPC_$_q" '%s' "$(dig_vpc "${!_q}")"; done
echo "linha de base: fat(F)=$BASE_FAT_F compradores(service_role)=$BASE_COMPR_SRV caca(F,C3)=$BASE_CACA_F"
[ "$BASE_FAT_F" = "200" ] || bad "L0 fixture: faturamento do grupo (C1+C3) não é 200 (veio $BASE_FAT_F) — a prova abaixo seria de graça"
[ "${BASE_COMPR_SRV%%|*}" != "0" ] || bad "L0 fixture: service_role não vê compradores — o assert A1 seria de graça"
[ "$BASE_CACA_F" != "0" ] || bad "L0 fixture: F não vê C3 na Caça — o assert A3 seria de graça"
eq "L0b fixture: opt-out SÓ por telefone tira CR da Caça já nos corpos de PROD" "$(cacadoc $F $CR)" "0"
eq "L1 antes do corte: back-office lê o telefone alheio DIRETO de profiles (furo que a 3b fecha)" \
   "$(como $B "SELECT phone FROM public.profiles WHERE user_id='$C3';")" "4733330003"


P -q -f "$MIGA"; P -q -f "$MIGB"
echo "fatia 3 (3a+3b) aplicada — estado de PROD de 2026-11-26"

M4A="$REPO_ROOT/supabase/migrations/20261126130000_clientes_pii_fatia4a_fontes.sql"
M4B="$REPO_ROOT/supabase/migrations/20261126140000_clientes_pii_fatia4a_corte.sql"

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
SQL
# estado de PROD das 3 superfícies (para restaurar entre sabotagens)
prod_acl() {
  P -q <<'SQL'
GRANT SELECT (customer_address, customer_phone, customer_document), UPDATE (customer_address, customer_phone, customer_document) ON public.sales_orders TO authenticated;
GRANT SELECT ON public.customer_metrics_mv TO authenticated;
GRANT ALL ON public.customer_contacts TO anon, authenticated;
SQL
}
P -q <<SQL
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
eq "L5 antes: o cliente lê o próprio snapshot cru (o caminho que a 4a-1 substitui)" "$(snap_cru $C1 $SO2)" "snap-end-c1|snap-fone-c1|snap-doc-c1"

P -q -f "$M4A"
echo "4a-1 aplicada (postcondição embutida passou)"

suite_s() {
  echo "-- S. fontes (4a-1) --"
  eq "S1 cliente lê o snapshot do PRÓPRIO pedido pela view" "$(snap_self $C1 $SO2)" "snap-end-c1|snap-fone-c1|snap-doc-c1"
  eq "S2 cliente não vê pedido alheio pela view" "$(como $C1 "SELECT count(*) FROM public.v_pedido_snapshot_proprio WHERE id='$SO1';")" "0"
  eq "S2b cliente vê só os seus (1 pedido)" "$(n_snap $C1)" "1"
  eq "S3 staff não é cliente: a view não lhe entrega pedido algum (staff vai pela RPC com ledger)" "$(n_snap $B)" "0"
  eq "S3b nem o master" "$(n_snap $M)" "0"
  eq "S3c JWT sem sub: 0 linhas" "$(como "" "SELECT count(*) FROM public.v_pedido_snapshot_proprio;")" "0"
  eq "S4 anon sem SELECT na view" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.v_pedido_snapshot_proprio")")" "barrado"
  eq "S5 cliente NÃO escreve pela view (OWNER furaria a RLS de escrita)" \
     "$(veredito "$(nega authenticated $C1 insufficient_privilege "UPDATE public.v_pedido_snapshot_proprio SET customer_phone='x' WHERE id='$SO2'")")" "barrado"
  eq "S6 back-office NÃO lê customer_metrics_mv.document (42501)" \
     "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT document FROM public.customer_metrics_mv")")" "barrado"
  eq "S6b nem filtra por ele (sem oráculo)" \
     "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT customer_user_id FROM public.customer_metrics_mv WHERE document = 'x'")")" "barrado"
  eq "S6c SELECT * na métrica quebra ALTO (42501)" \
     "$(veredito "$(nega authenticated $G insufficient_privilege "SELECT * FROM public.customer_metrics_mv")")" "barrado"
  eq "S6d anon segue sem a métrica" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT customer_user_id FROM public.customer_metrics_mv")")" "barrado"
  local _q _b
  for _q in F B G M C1; do
    _b="BASE_METR_$_q"; eq "S7 métrica ($_q): mesmas linhas e colunas de métrica de antes" "$(dig_metr "${!_q}")" "${!_b}"
  done
  eq "S8 service_role (ai-ops-agent, select *) segue com a view INTEIRA, documento incluso" "$(dig_metr_srv)" "$BASE_DIG_METR_SRV"
}
suite_s

P -q -f "$M4B"
echo "4a-2 aplicada (postcondição embutida passou)"

suite_t() {
  echo "-- T. o corte (4a-2) --"
  local c _q _b
  for c in customer_document customer_address customer_phone; do
    for _q in B F G M; do
      eq "T1 $_q NÃO lê sales_orders.$c (42501)" \
         "$(veredito "$(nega authenticated "${!_q}" insufficient_privilege "SELECT $c FROM public.sales_orders WHERE id='$SO1'")")" "barrado"
    done
    eq "T1b farmer NÃO filtra por sales_orders.$c (sem oráculo)" \
       "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT id FROM public.sales_orders WHERE $c = 'x'")")" "barrado"
    eq "T1c o cliente NÃO lê o próprio $c cru (vai pela view)" \
       "$(veredito "$(nega authenticated $C1 insufficient_privilege "SELECT $c FROM public.sales_orders WHERE id='$SO2'")")" "barrado"
  done
  eq "T2 o cliente segue lendo o próprio snapshot pela view" "$(snap_self $C1 $SO2)" "snap-end-c1|snap-fone-c1|snap-doc-c1"
  for _q in F B G M C1; do
    _b="BASE_SO_$_q"; eq "T3 sales_orders ($_q): mesmas linhas e colunas sem contato de antes" "$(dig_so "${!_q}")" "${!_b}"
  done
  eq "T3b Caça/compradores (service_role): mesma linha inteira" "$(dig_compr)" "$BASE_DIG_COMPR4"
  eq "T3c Caça (farmer): mesma fila" "$(dig_cand $F)" "$BASE_DIG_CAND4_F"
  eq "T3d grupo comercial (farmer): mesma linha" "$(dig_grupo $F)" "$BASE_DIG_GRUPO4_F"
  P -q -c "DELETE FROM public.sales_orders WHERE id='a9000000-0000-0000-0000-0000000000a9';"
  eq "T4 staff segue GRAVANDO o snapshot (insert como o front, RETURNING id) e PERSISTE" \
     "$(como $F "INSERT INTO public.sales_orders(id,customer_user_id,customer_document,customer_address,customer_phone) VALUES ('a9000000-0000-0000-0000-0000000000a9','$C1','d9','e9','f9') RETURNING id;")|$(P -tA -q -c "SELECT customer_document||customer_address||customer_phone FROM public.sales_orders WHERE id='a9000000-0000-0000-0000-0000000000a9';")" \
     "a9000000-0000-0000-0000-0000000000a9|d9e9f9"
  eq "T4b staff segue ATUALIZANDO o snapshot (idempotência: UPDATE … WHERE id) e PERSISTE" \
     "$(como $F "UPDATE public.sales_orders SET customer_phone='f10', customer_address='e10', customer_document='d10' WHERE id='a9000000-0000-0000-0000-0000000000a9';")$(P -tA -q -c "SELECT customer_document||customer_address||customer_phone FROM public.sales_orders WHERE id='a9000000-0000-0000-0000-0000000000a9';")" \
     "d10e10f10"
  P -q -c "DELETE FROM public.sales_orders WHERE id='a9000000-0000-0000-0000-0000000000a9';"
  P -q -c "DELETE FROM public.contato_acesso_operacional;"
  eq "T5 staff lê o snapshot pela RPC operacional (exceção no pedido)" \
     "$(como $B "SELECT pedido_telefone FROM public.contato_cliente_operacional('pedido', '{$SO1}'::uuid[], 'detalhe_pedido');")" "snap-fone-c3"
  eq "T5b ... e a leitura fica no ledger" \
     "$(P -tA -q -c "SELECT count(*) FROM public.contato_acesso_operacional WHERE staff_user_id='$B' AND customer_user_id='$C3';")" "1"
  eq "T5c service_role (edges) segue lendo o snapshot" "$(como_srv "SELECT customer_phone FROM public.sales_orders WHERE id='$SO1';")" "snap-fone-c3"

  echo "-- T. contatos do cliente --"
  for c in phone email nome cargo birthday notas; do
    eq "T6 farmer NÃO lê customer_contacts.$c (42501)" \
       "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT $c FROM public.customer_contacts")")" "barrado"
  done
  eq "T6b gestor também não lê a tabela crua (contato só pela view)" \
     "$(veredito "$(nega authenticated $G insufficient_privilege "SELECT phone FROM public.customer_contacts")")" "barrado"
  eq "T6c SELECT * nos contatos quebra ALTO" \
     "$(veredito "$(nega authenticated $M insufficient_privilege "SELECT * FROM public.customer_contacts")")" "barrado"
  eq "T6d sem oráculo por telefone" \
     "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT id FROM public.customer_contacts WHERE phone = 'cc-fone-c3'")")" "barrado"
  eq "T6e anon sem SELECT nos contatos" \
     "$(veredito "$(nega anon "" insufficient_privilege "SELECT id FROM public.customer_contacts")")" "barrado"
  for _q in F B G M C1; do
    _b="BASE_CCV_$_q"; eq "T7 v_cliente_contatos ($_q): mesma linha inteira de antes" "$(dig_cc_view "${!_q}")" "${!_b}"
  done
  eq "T7b farmer vê pela view o contato da carteira" "$(cc_view $F $C1)" "cc-fone-c1"
  eq "T7c farmer NÃO vê pela view o contato de fora" "$(cc_view $F $C3)" "(vazio)"
  eq "T7d gestor vê pela view o de fora" "$(cc_view $G $C3)" "cc-fone-c3"
  local NC=c9000000-0000-0000-0000-0000000000c9
  P -q -c "DELETE FROM public.customer_contacts WHERE id='$NC';"
  eq "T8 staff cria contato como o front novo (RETURNING id, customer_user_id) e PERSISTE" \
     "$(como $F "INSERT INTO public.customer_contacts(id,customer_user_id,phone,nome,created_by) VALUES ('$NC','$C3','fone-novo','Caio','$F') RETURNING id, customer_user_id;")|$(P -tA -q -c "SELECT phone FROM public.customer_contacts WHERE id='$NC';")" \
     "$NC|$C3|fone-novo"
  eq "T8b staff edita como o front novo (UPDATE … WHERE id RETURNING id, customer_user_id) e PERSISTE" \
     "$(como $F "UPDATE public.customer_contacts SET phone='fone-editado', email='e@x.test' WHERE id='$NC' RETURNING id, customer_user_id;")|$(P -tA -q -c "SELECT phone||'/'||email FROM public.customer_contacts WHERE id='$NC';")" \
     "$NC|$C3|fone-editado/e@x.test"
  eq "T8c desligar o primário dos outros (UPDATE … WHERE customer_user_id) segue funcionando" \
     "$(como $F "UPDATE public.customer_contacts SET is_primary=false WHERE customer_user_id='$C3';")$(P -tA -q -c "SELECT count(*) FROM public.customer_contacts WHERE customer_user_id='$C3' AND is_primary IS NOT false;")" "0"
  P -q -c "UPDATE public.customer_contacts SET is_primary=NULL WHERE customer_user_id='$C3' AND id<>'$NC';"  # devolve o seed
  eq "T8d a forma ANTIGA do front (RETURNING *) quebra — por isso o .select() mudou" \
     "$(veredito "$(nega authenticated $F insufficient_privilege "UPDATE public.customer_contacts SET nome='Caio' WHERE id='$NC' RETURNING *")")" "barrado"
  eq "T8e master apaga como o front (DELETE … WHERE id) e some" \
     "$(como $M "DELETE FROM public.customer_contacts WHERE id='$NC';")$(P -tA -q -c "SELECT count(*) FROM public.customer_contacts WHERE id='$NC';")" "0"
  eq "T9 service_role segue lendo os contatos" "$(como_srv "SELECT phone FROM public.customer_contacts WHERE customer_user_id='$C3';")" "cc-fone-c3"
}
suite_s
suite_t

# ═════════════════════════ FALSIFICAÇÃO (mesma invocação; as suítes verdes acima já rodaram) ═════════
echo "-- FALSIFICAÇÃO: uma sabotagem por camada, cada uma com o SEU vermelho --"
exige_vermelho() { # <rótulo> <obtido> <correto> <vermelho-esperado>
  if [ "$2" = "$3" ]; then bad "$1 — sabotado ficou VERDE (assert não pega a camada) [$2]"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — vermelho ALHEIO ao mutante: esperado [$4], veio [$2]"; fi
}
# sabota <arquivo> <perl expr> — reaplica sobre o estado de PROD (antes da 4a) o arquivo sabotado, sem a postcondição
sabota() {
  perl -0pe "$2" "$1" > "$RODADA/sabotada.sql"
  if cmp -s "$1" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou $(basename "$1") ($2)"; fi
  perl -0pi -e 's/DO \$post\$.*?\$post\$;//s' "$RODADA/sabotada.sql"
  prod_acl
  if [ "$1" = "$M4B" ]; then P -q -f "$M4A"; fi
  # a view da 4a-1 nasce NOVA em prod (default privileges = ALL): sem o DROP, o REPLACE herdaria o ACL bom
  if [ "$1" = "$M4A" ]; then P -q -c "DROP VIEW IF EXISTS public.v_pedido_snapshot_proprio;"; fi
  P -q -f "$RODADA/sabotada.sql"
}
# sabota_post <arquivo> <perl expr> <marca> — a postcondição TEM de abortar com a sua marca
sabota_post() {
  perl -0pe "$2" "$1" > "$RODADA/sabotada.sql"
  if cmp -s "$1" "$RODADA/sabotada.sql"; then bad "sabotagem não alterou $(basename "$1") ($2)"; fi
  prod_acl
  if [ "$1" = "$M4B" ]; then P -q -f "$M4A"; fi
  # a view da 4a-1 nasce NOVA em prod (default privileges = ALL): sem o DROP, o REPLACE herdaria o ACL bom
  if [ "$1" = "$M4A" ]; then P -q -c "DROP VIEW IF EXISTS public.v_pedido_snapshot_proprio;"; fi
  if P -q -f "$RODADA/sabotada.sql" >/dev/null 2>"$RODADA/post.err"; then bad "$4 — a postcondição NÃO abortou"
  elif grep -q "$3" "$RODADA/post.err"; then ok "$4 → postcondição aborta ($3)"
  else bad "$4 — abortou por outro motivo: $(head -c 300 "$RODADA/post.err")"; fi
}
restaura() { prod_acl; P -q -f "$M4A"; P -q -f "$M4B"; }

sabota "$M4B" 's/REVOKE SELECT \(customer_document, customer_address, customer_phone\) ON public\.sales_orders FROM PUBLIC, anon, authenticated;//'
exige_vermelho "K1 sem o REVOKE do snapshot → T1" "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT customer_phone FROM public.sales_orders WHERE id='$SO1'")")" "barrado" "vazou"; restaura

sabota "$M4B" 's/REVOKE SELECT \(customer_document, customer_address, customer_phone\)/REVOKE SELECT (customer_document, customer_address)/'
exige_vermelho "K2 REVOKE sem o telefone → T1 (customer_phone)" "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT id FROM public.sales_orders WHERE customer_phone = 'x'")")" "barrado" "vazou"; restaura

sabota "$M4B" 's/REVOKE SELECT ON public\.customer_contacts FROM PUBLIC, anon, authenticated;//'
exige_vermelho "K3 contatos sem o REVOKE de tabela → T6" "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT phone FROM public.customer_contacts")")" "barrado" "vazou"; restaura

sabota "$M4B" 's/  id, customer_user_id, is_decision_maker,/  id, customer_user_id, phone, is_decision_maker,/'
exige_vermelho "K4 grant de contatos com o telefone → T6d (oráculo)" "$(veredito "$(nega authenticated $F insufficient_privilege "SELECT id FROM public.customer_contacts WHERE phone = 'cc-fone-c3'")")" "barrado" "vazou"; restaura

sabota "$M4B" 's/  id, customer_user_id, is_decision_maker,/  id, is_decision_maker,/'
exige_vermelho "K5 grant de contatos sem o dono → T8c (desligar primário por cliente quebra)" \
  "$(veredito "$(nega authenticated $F insufficient_privilege "UPDATE public.customer_contacts SET is_primary=false WHERE customer_user_id='$C3'")")" "vazou" "barrado"; restaura
P -q -c "UPDATE public.customer_contacts SET is_primary=NULL WHERE customer_user_id='$C3';"

sabota "$M4A" 's/   AND so\.customer_user_id = \(SELECT auth\.uid\(\)\);/;/'
exige_vermelho "K6 view sem a fronteira de linha → S2b (cliente veria pedido alheio)" "$(n_snap $C1)" "1" "3"; restaura

sabota "$M4A" 's/REVOKE ALL ON public\.v_pedido_snapshot_proprio FROM PUBLIC, anon, authenticated, service_role;/REVOKE ALL ON public.v_pedido_snapshot_proprio FROM PUBLIC, anon, service_role;/'
exige_vermelho "K7 view sem o REVOKE de authenticated (nasce ALL) → S5" "$(veredito "$(nega authenticated $C1 insufficient_privilege "UPDATE public.v_pedido_snapshot_proprio SET customer_phone='x' WHERE id='$SO2'")")" "barrado" "vazou"; restaura
P -q -c "UPDATE public.sales_orders SET customer_phone='snap-fone-c1' WHERE id='$SO2';"  # o mutante GRAVOU (prova do furo)

sabota "$M4A" 's/REVOKE ALL ON public\.v_pedido_snapshot_proprio FROM PUBLIC, anon, authenticated, service_role;/REVOKE ALL ON public.v_pedido_snapshot_proprio FROM PUBLIC, authenticated, service_role;/'
exige_vermelho "K8 view sem o REVOKE de anon → S4" "$(veredito "$(nega anon "" insufficient_privilege "SELECT 1 FROM public.v_pedido_snapshot_proprio")")" "barrado" "vazou"; restaura

sabota "$M4A" 's/  customer_user_id, razao_social, ultima_compra_data,/  customer_user_id, razao_social, document, ultima_compra_data,/'
exige_vermelho "K9 grant da métrica com o documento → S6" "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT document FROM public.customer_metrics_mv")")" "barrado" "vazou"; restaura

sabota "$M4A" 's/REVOKE SELECT ON public\.customer_metrics_mv FROM PUBLIC, anon, authenticated;//'
exige_vermelho "K10 métrica sem o REVOKE de tabela → S6" "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT document FROM public.customer_metrics_mv")")" "barrado" "vazou"; restaura

sabota "$M4A" 's/  is_cold_start, calculated_at\n\) ON public\.customer_metrics_mv/  is_cold_start\n) ON public.customer_metrics_mv/'
exige_vermelho "K11 grant da métrica sem calculated_at → S7 (a 360 quebraria)" \
  "$(veredito "$(nega authenticated $B insufficient_privilege "SELECT calculated_at FROM public.customer_metrics_mv")")" "vazou" "barrado"; restaura

# postcondições: cada uma aborta a migration sabotada com a SUA marca
sabota_post "$M4B" 's/REVOKE SELECT \(customer_document, customer_address, customer_phone\) ON public\.sales_orders FROM PUBLIC, anon, authenticated;//' 'B1 FALHOU' "K12 4a-2 sem o REVOKE do snapshot"; restaura
sabota_post "$M4B" 's/REVOKE SELECT \(customer_document, customer_address, customer_phone\)/REVOKE ALL (customer_document, customer_address, customer_phone)/' 'B3 FALHOU' "K13 4a-2 levando o UPDATE do snapshot junto"; restaura
sabota_post "$M4A" 's/  customer_user_id, razao_social, ultima_compra_data,/  customer_user_id, razao_social, document, ultima_compra_data,/' 'A5 FALHOU' "K14 4a-1 com o documento no grant"; restaura
sabota_post "$M4A" 's/WITH \(security_invoker = off, security_barrier = true\) AS\nSELECT so\./WITH (security_invoker = on, security_barrier = true) AS\nSELECT so./' 'A1 FALHOU' "K15 4a-1 com a view invoker=on"
P -q -c "ALTER VIEW public.v_pedido_snapshot_proprio SET (security_invoker = off);"; restaura
sabota_post "$M4A" 's/REVOKE ALL ON public\.v_pedido_snapshot_proprio FROM PUBLIC, anon, authenticated, service_role;/REVOKE ALL ON public.v_pedido_snapshot_proprio FROM PUBLIC, anon, service_role;/' 'A4 FALHOU' "K16 4a-1 com escrita pela view"; restaura

echo "-- pós-falsificação: tudo restaurado volta verde --"
suite_s
suite_t

echo "──────────────────────────────"
echo "LOCALE: $LOCALE_TESTE"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"

#!/usr/bin/env bash
# PROVA PG17 — 20261020143511_venda_cliente_complemento.sql (Venda por cliente, Task 5)
#
#   C1 comprador sem a família e regra acima dos pisos       → a família aparece (com até 3 SKUs)
#   C2 regra com lift 1,4                                    → a família NÃO aparece
#   C3 `recusado` há 30 dias → some; há 100 dias → volta
#   C4 no máximo 3 famílias (havia 4 gaps)
#   C5 farmer F2 pedindo comprador de F1 → 42501 (+ customer, staff sem carteira, sem login → 42501;
#      gerencial e master leem; anon/PUBLIC sem EXECUTE)
#   C6 REGRESSÃO: get_meu_mixgap_for(F1) e get_meu_mixgap() devolvem o MESMO texto JSON antes e
#      depois da extração do núcleo (o "antes" é o corpo VIVO da prod, db/fixtures/…)
#   C7 SKUs: universo de venda (cancelado/apagado fora), só de quem tem o antecedente, ordem por
#      nº de compradores; família sem comprador parecido → skus [] (nunca inventado)
#   C8 alias: compra feita no cadastro alias conta para o canônico; pedir pelo alias = pedir pelo canônico
#   M  PRE recusa corpo estranho; re-aplicar a migration passa (idempotente)
#
# Locale: roda no LC_ALL do ambiente (default C). Rode nos dois:
#   bash db/test-venda-complemento.sh && LC_ALL=pt_BR.UTF-8 bash db/test-venda-complemento.sh
# Override da migration (falsificação): MIG=/caminho/sabotado.sql bash db/test-venda-complemento.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5471}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-complemento.XXXXXX")"
DATA="$TMP/data"
MIG="${MIG:-$REPO_ROOT/supabase/migrations/20261020143511_venda_cliente_complemento.sql}"
PRED="$REPO_ROOT/db/fixtures/mixgap-predecessor-prod-20261020.sql"
LOCALE_DB="${LC_ALL:-C}"
export LC_ALL="$LOCALE_DB" LANG="$LOCALE_DB"
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }
[ -f "$PRED" ] || { echo "fixture ausente: $PRED"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_DB" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$TMP" -U postgres prove
PA() { "$PGBIN/psql" -X -q -p "$PORT" -h "$TMP" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q()  { PA -tA -c "$1"; }
# como <uid> <sql>: roda como `authenticated`, com auth.uid() = uid (vazio = sem login)
como() { PA -tA -c "SET request.jwt.claim.sub = '$1'" -c "SET ROLE authenticated" -c "$2"; }

PASSOU=0; FALHAS=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }
igual() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "== locale: $LOCALE_DB · migration: $(basename "$MIG")"

# ---------------------------------------------------------------- esquema mínimo (espelha a prod)
PA <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA test;
GRANT USAGE ON SCHEMA public, private, auth, test TO anon, authenticated, service_role;
-- Supabase concede EXECUTE a anon/authenticated por default: o REVOKE da migration tem de ser real
ALTER DEFAULT PRIVILEGES IN SCHEMA public, private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT COALESCE(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$f$;

CREATE TYPE public.app_role AS ENUM ('admin', 'employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid UNIQUE, commercial_role text);
CREATE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
$function$;

CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text, razao_social text);
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid UNIQUE, owner_user_id uuid,
  eligible boolean NOT NULL DEFAULT true);
CREATE TABLE public.customer_canonical_alias (
  alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY, omie_codigo_produto bigint, descricao text, familia text, account text,
  ativo boolean, UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, customer_user_id uuid, status text, account text, deleted_at timestamptz,
  order_date_kpi date, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, customer_user_id uuid,
  product_id uuid, omie_codigo_produto bigint, quantity numeric, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.farmer_association_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), antecedent_product_ids text[], consequent_product_ids text[],
  confidence numeric, lift numeric, sample_size integer);
CREATE TABLE public.farmer_mixgap_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seller_user_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  familia text NOT NULL, status text NOT NULL CHECK (status IN ('ofertado','convertido','recusado')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (seller_user_id, customer_user_id, familia));

-- captura de erro para os negativos: devolve SQLSTATE|mensagem (o teste case os dois), nunca 'OK'
CREATE FUNCTION test.erro(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE p_sql;
  RETURN 'SEM_ERRO';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE || '|' || SQLERRM;
END $f$;
GRANT EXECUTE ON FUNCTION test.erro(text) TO authenticated;

CREATE FUNCTION test.pedido(p_cli uuid, p_prods uuid[], p_dias int DEFAULT 10,
                            p_status text DEFAULT 'faturado', p_apagado boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, status, account, deleted_at, order_date_kpi, created_at)
  VALUES (v, p_cli, p_status, 'colacor', CASE WHEN p_apagado THEN now() END,
          (now() - make_interval(days => p_dias))::date, now() - make_interval(days => p_dias));
  INSERT INTO public.order_items (sales_order_id, customer_user_id, product_id, omie_codigo_produto, quantity, created_at)
  SELECT v, p_cli, op.id, op.omie_codigo_produto, 1, now() - make_interval(days => p_dias)
    FROM public.omie_products op WHERE op.id = ANY (p_prods);
END $f$;
SQL

# predecessor = corpo VIVO da prod; ACL como a prod
PA -f "$PRED"
PA <<'SQL'
REVOKE ALL ON FUNCTION public._carteira_mixgap_for_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_meu_mixgap() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_meu_mixgap_for(uuid) FROM PUBLIC, anon;
SQL
igual "fixture do predecessor = md5 que a PRE da migration aceita" \
  "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public._carteira_mixgap_for_owner(uuid)'::regprocedure")" \
  "$(grep -oE "'e35e2e5afd6095496154af13b9ad0a29'" "$MIG" | head -1 | tr -d "'")"

# ---------------------------------------------------------------- dados
# pessoas: M master · F1 F2 farmers · E3 staff sem carteira · G gerencial · CU customer
# clientes: X V (F1) · Y1..Y4 (F2) · Z (sem carteira) · W + alias WA (F1; entram depois do C6)
PA >/dev/null <<'SQL'
INSERT INTO user_roles VALUES
 ('00000000-0000-0000-0000-000000000001','master'),
 ('00000000-0000-0000-0000-000000000011','employee'), ('00000000-0000-0000-0000-000000000012','employee'),
 ('00000000-0000-0000-0000-000000000013','employee'), ('00000000-0000-0000-0000-000000000014','employee'),
 ('00000000-0000-0000-0000-000000000021','customer');
INSERT INTO commercial_roles VALUES
 ('00000000-0000-0000-0000-000000000011','farmer'), ('00000000-0000-0000-0000-000000000012','farmer'),
 ('00000000-0000-0000-0000-000000000014','gerencial');
INSERT INTO profiles VALUES
 ('00000000-0000-0000-0000-000000000101','Cliente X','X Ltda'), ('00000000-0000-0000-0000-000000000102','Cliente V',NULL);
INSERT INTO carteira_assignments (customer_user_id, owner_user_id) VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000011'),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000011'),
 ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-000000000012'),
 ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-000000000012'),
 ('00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-000000000012'),
 ('00000000-0000-0000-0000-000000000114','00000000-0000-0000-0000-000000000012');
INSERT INTO omie_products VALUES
 ('a0000000-0000-0000-0000-000000000001',1001,'LIXA FOLHA 120','LIXA','colacor',true),
 ('b0000000-0000-0000-0000-000000000001',2001,'DISCO 115 GRAO 36','ABRASIVO','colacor',true),
 ('b0000000-0000-0000-0000-000000000002',2002,'DISCO 115 GRAO 60','ABRASIVO','colacor',true),
 ('b0000000-0000-0000-0000-000000000003',2003,'DISCO 180 GRAO 24','ABRASIVO','colacor',true),
 ('b0000000-0000-0000-0000-000000000004',2004,'DISCO 180 GRAO 80','ABRASIVO','colacor',true),
 ('c0000000-0000-0000-0000-000000000001',3001,'COLA PVA 1KG','COLA','colacor',true),
 ('d0000000-0000-0000-0000-000000000001',4001,'FITA CREPE 48','FITA','colacor',true),
 ('e0000000-0000-0000-0000-000000000001',5001,'MASSA ACRILICA','MASSA','colacor',true),
 ('f0000000-0000-0000-0000-000000000001',6001,'PINCEL 2 POL','PINCEL','colacor',true);
-- regras (antecedente LIXA): ABRASIVO 3,0 · COLA 2,0 · FITA 1,2 · MASSA 0,6 · PINCEL lift 1,4 (abaixo do piso)
INSERT INTO farmer_association_rules (antecedent_product_ids, consequent_product_ids, confidence, lift, sample_size) VALUES
 ('{a0000000-0000-0000-0000-000000000001}','{b0000000-0000-0000-0000-000000000001}',0.6,5,100),
 ('{a0000000-0000-0000-0000-000000000001}','{c0000000-0000-0000-0000-000000000001}',0.5,4,100),
 ('{a0000000-0000-0000-0000-000000000001}','{d0000000-0000-0000-0000-000000000001}',0.4,3,100),
 ('{a0000000-0000-0000-0000-000000000001}','{e0000000-0000-0000-0000-000000000001}',0.3,2,100),
 ('{a0000000-0000-0000-0000-000000000001}','{f0000000-0000-0000-0000-000000000001}',0.9,1.4,100);
-- X: só LIXA → 4 gaps. V: LIXA + ABRASIVO → COLA, FITA, MASSA.
SELECT test.pedido('00000000-0000-0000-0000-000000000101','{a0000000-0000-0000-0000-000000000001}');
SELECT test.pedido('00000000-0000-0000-0000-000000000102','{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001}');
-- parecidos (têm o antecedente LIXA): B1 em 4 · B2 em 2 · B4 em 1 (2 pedidos) · B3 em 1 válido
SELECT test.pedido('00000000-0000-0000-0000-000000000111','{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000002}');
SELECT test.pedido('00000000-0000-0000-0000-000000000112','{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000002,b0000000-0000-0000-0000-000000000003,c0000000-0000-0000-0000-000000000001}');
SELECT test.pedido('00000000-0000-0000-0000-000000000113','{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000004}');
SELECT test.pedido('00000000-0000-0000-0000-000000000113','{b0000000-0000-0000-0000-000000000004}', 20);
SELECT test.pedido('00000000-0000-0000-0000-000000000114','{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001}');
-- B3 fora do universo: cancelado (Y1), apagado (Y4), e Z (comprou muito, mas não tem o antecedente)
SELECT test.pedido('00000000-0000-0000-0000-000000000111','{b0000000-0000-0000-0000-000000000003}', 5, 'cancelado');
SELECT test.pedido('00000000-0000-0000-0000-000000000114','{b0000000-0000-0000-0000-000000000003}', 5, 'faturado', true);
SELECT test.pedido('00000000-0000-0000-0000-000000000121','{b0000000-0000-0000-0000-000000000003}', 3);
SELECT test.pedido('00000000-0000-0000-0000-000000000121','{b0000000-0000-0000-0000-000000000003}', 4);
-- feedback: F1 ofertou ABRASIVO a X; F1 ouviu recusa de COLA de V há 30d; F2 (não é dono) marcou X convertido
INSERT INTO farmer_mixgap_feedback (seller_user_id, customer_user_id, familia, status, updated_at) VALUES
 ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000101','ABRASIVO','ofertado', now() - interval '5 days'),
 ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000102','COLA','recusado', now() - interval '30 days'),
 ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000101','ABRASIVO','convertido', now() - interval '1 day');
SQL

M=00000000-0000-0000-0000-000000000001; F1=00000000-0000-0000-0000-000000000011; F2=00000000-0000-0000-0000-000000000012
E3=00000000-0000-0000-0000-000000000013; G=00000000-0000-0000-0000-000000000014; CU=00000000-0000-0000-0000-000000000021
X=00000000-0000-0000-0000-000000000101; Y1=00000000-0000-0000-0000-000000000111
W=00000000-0000-0000-0000-000000000131; WA=00000000-0000-0000-0000-000000000132

# ---------------------------------------------------------------- C6: retrato ANTES (corpo da prod)
ANTES_F1="$(como "$M" "SELECT public.get_meu_mixgap_for('$F1')::text")"
ANTES_F2="$(como "$M" "SELECT public.get_meu_mixgap_for('$F2')::text")"
ANTES_MEU="$(como "$F1" "SELECT public.get_meu_mixgap()::text")"
# o retrato tem de ter conteúdo, senão a comparação passaria por vacuidade
igual "C6 retrato antes: F1 tem X (ABRASIVO, ofertado) e V (FITA, COLA suprimida)" \
  "$(Q "SELECT string_agg((e->>'nome') || ':' || (e->>'familia_faltante') || ':' || COALESCE(e->>'feedback_status','-'), ',' ORDER BY o)
          FROM jsonb_array_elements('$ANTES_F1'::jsonb->'lista') WITH ORDINALITY t(e, o)")" \
  "X Ltda:ABRASIVO:ofertado,Cliente V:FITA:-"

# ---------------------------------------------------------------- apply (transação única, como o db:aplicar)
if PA -1 -f "$MIG" >"$TMP/apply.log" 2>&1; then ok "migration aplicada (PRE, PÓS e execução da RPC como master)"
else bad "migration falhou: $(tr '\n' ' ' < "$TMP/apply.log" | cut -c1-400)"; fi

igual "C6 get_meu_mixgap_for(F1): texto JSON idêntico" "$(como "$M" "SELECT public.get_meu_mixgap_for('$F1')::text")" "$ANTES_F1"
igual "C6 get_meu_mixgap() como F1: texto JSON idêntico" "$(como "$F1" "SELECT public.get_meu_mixgap()::text")" "$ANTES_MEU"
# F2 tem empates de ordem (4 clientes com o mesmo top-1): compara o conjunto, ordenado por cliente
NORM="SELECT jsonb_build_object('t', j->'total_com_gap', 'l', (SELECT jsonb_agg(e ORDER BY e->>'customer_user_id') FROM jsonb_array_elements(j->'lista') e))::text FROM (SELECT %s::jsonb AS j) s"
# shellcheck disable=SC2059  # NORM é o formato, de propósito
igual "C6 get_meu_mixgap_for(F2): mesmo conteúdo" \
  "$(como "$M" "$(printf "$NORM" "public.get_meu_mixgap_for('$F2')")")" \
  "$(Q "$(printf "$NORM" "'$ANTES_F2'")")"

# ---------------------------------------------------------------- C1/C2/C4/C7
FAMS="SELECT string_agg(f->>'familia', ',' ORDER BY o) FROM jsonb_array_elements(public.venda_complemento_comprador('%s')->'familias') WITH ORDINALITY t(f, o)"
# shellcheck disable=SC2059
igual "C1+C2+C4 X como F1: ABRASIVO,COLA,FITA (PINCEL lift 1,4 fora; MASSA cortada no teto de 3)" \
  "$(como "$F1" "$(printf "$FAMS" "$X")")" "ABRASIVO,COLA,FITA"
igual "C2 PINCEL (lift 1,4) não aparece nem no Mix/Gap da carteira" \
  "$(como "$M" "SELECT count(*) FROM jsonb_array_elements(public.get_meu_mixgap_for('$F1')->'lista') e WHERE e->>'familia_faltante' = 'PINCEL'")" "0"
igual "C1 contrato da 1ª família (convertido de F2 NÃO suprime: F2 não é dona de X)" \
  "$(como "$F1" "SELECT f->>'familia' || '|' || (f->>'empresa') || '|' || (f->>'confidence') || '|' || (f->>'lift') || '|' || (f->>'evidence_count') || '|' || (f->>'feedback_status')
                   FROM jsonb_array_elements(public.venda_complemento_comprador('$X')->'familias') f LIMIT 1")" \
  "ABRASIVO|colacor|0.6|5|1|ofertado"
SKUS="SELECT f->>'familia' || '=' || COALESCE((SELECT string_agg(s->>'omie_codigo_produto', ',' ORDER BY o) FROM jsonb_array_elements(f->'skus') WITH ORDINALITY u(s, o)), '') FROM jsonb_array_elements(public.venda_complemento_comprador('%s')->'familias') WITH ORDINALITY t(f, ord) ORDER BY ord"
# shellcheck disable=SC2059
igual "C7 SKUs: B1(4 compradores) B2(2) B4(2 pedidos) — B3 cancelado/apagado/sem antecedente fora; FITA sem parecido → vazio" \
  "$(como "$F1" "$(printf "$SKUS" "$X")" | tr '\n' ' ')" "ABRASIVO=2001,2002,2004 COLA=3001 FITA= "
igual "C7 sem custo/preço/estoque no payload" \
  "$(como "$F1" "SELECT count(*) FROM jsonb_array_elements(public.venda_complemento_comprador('$X')->'familias') f, jsonb_object_keys(f) k WHERE k NOT IN ('familia','empresa','confidence','lift','evidence_count','feedback_status','skus')")" "0"
igual "C7 SKU só tem código e descrição" \
  "$(como "$F1" "SELECT string_agg(DISTINCT k, ',') FROM jsonb_array_elements(public.venda_complemento_comprador('$X')->'familias') f, jsonb_array_elements(f->'skus') s, jsonb_object_keys(s) k")" "descricao,omie_codigo_produto"

# ---------------------------------------------------------------- C3 supressão por recusa
Q "INSERT INTO farmer_mixgap_feedback (seller_user_id, customer_user_id, familia, status, updated_at) VALUES ('$F1','$X','COLA','recusado', now() - interval '30 days')" >/dev/null
# shellcheck disable=SC2059
igual "C3 COLA recusada há 30d some (MASSA entra)" "$(como "$F1" "$(printf "$FAMS" "$X")")" "ABRASIVO,FITA,MASSA"
Q "UPDATE farmer_mixgap_feedback SET updated_at = now() - interval '100 days' WHERE seller_user_id = '$F1' AND customer_user_id = '$X' AND familia = 'COLA'" >/dev/null
# shellcheck disable=SC2059
igual "C3 COLA recusada há 100d volta, com o status" "$(como "$F1" "$(printf "$FAMS" "$X")")" "ABRASIVO,COLA,FITA"
igual "C3 feedback_status da COLA = recusado" \
  "$(como "$F1" "SELECT f->>'feedback_status' FROM jsonb_array_elements(public.venda_complemento_comprador('$X')->'familias') f WHERE f->>'familia' = 'COLA'")" "recusado"
Q "UPDATE farmer_mixgap_feedback SET status = 'convertido' WHERE seller_user_id = '$F1' AND customer_user_id = '$X' AND familia = 'COLA'" >/dev/null
# shellcheck disable=SC2059
igual "C3 convertido suprime sempre" "$(como "$F1" "$(printf "$FAMS" "$X")")" "ABRASIVO,FITA,MASSA"
Q "DELETE FROM farmer_mixgap_feedback WHERE seller_user_id = '$F1' AND customer_user_id = '$X' AND familia = 'COLA'" >/dev/null

# ---------------------------------------------------------------- C5 autorização
ERR="SELECT test.erro('SELECT public.venda_complemento_comprador(''%s'')')"
# shellcheck disable=SC2059
igual "C5 F2 pede comprador de F1 → 42501 (fora da carteira)" "$(como "$F2" "$(printf "$ERR" "$X")")" \
  "42501|venda_complemento_comprador: comprador fora da sua carteira"
# shellcheck disable=SC2059
igual "C5 staff sem carteira nem cap → 42501 (fora da carteira)" "$(como "$E3" "$(printf "$ERR" "$X")")" \
  "42501|venda_complemento_comprador: comprador fora da sua carteira"
# shellcheck disable=SC2059
igual "C5 customer → 42501 (não é staff)" "$(como "$CU" "$(printf "$ERR" "$X")")" \
  "42501|venda_complemento_comprador: requer perfil staff"
# shellcheck disable=SC2059
igual "C5 sem login → 42501 (não é staff)" "$(como "" "$(printf "$ERR" "$X")")" \
  "42501|venda_complemento_comprador: requer perfil staff"
# shellcheck disable=SC2059
igual "C5 F2 lê o próprio comprador Y1" "$(como "$F2" "$(printf "$FAMS" "$Y1")")" "COLA,FITA,MASSA"
# shellcheck disable=SC2059
igual "C5 gerencial lê X" "$(como "$G" "$(printf "$FAMS" "$X")")" "ABRASIVO,COLA,FITA"
# shellcheck disable=SC2059
igual "C5 master lê X" "$(como "$M" "$(printf "$FAMS" "$X")")" "ABRASIVO,COLA,FITA"
igual "C5 ACL: anon sem EXECUTE na RPC e no núcleo; authenticated só na RPC; ninguém via PUBLIC" \
  "$(Q "SELECT has_function_privilege('anon','public.venda_complemento_comprador(uuid)','EXECUTE')
            || ',' || has_function_privilege('anon','private._mixgap_gaps_compradores(uuid[],uuid[])','EXECUTE')
            || ',' || has_function_privilege('authenticated','private._mixgap_gaps_compradores(uuid[],uuid[])','EXECUTE')
            || ',' || has_function_privilege('authenticated','public._carteira_mixgap_for_owner(uuid)','EXECUTE')
            || ',' || has_function_privilege('authenticated','public.venda_complemento_comprador(uuid)','EXECUTE')
            || ',' || (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
                        WHERE p.proname IN ('venda_complemento_comprador','_mixgap_gaps_compradores','_carteira_mixgap_for_owner')
                          AND a.grantee = 0)")" \
  "false,false,false,false,true,0"

# ---------------------------------------------------------------- C8 alias (depois do C6: muda o Mix/Gap de propósito)
PA >/dev/null <<SQL
INSERT INTO customer_canonical_alias VALUES ('$WA', '$W', 'active');
INSERT INTO carteira_assignments (customer_user_id, owner_user_id) VALUES ('$W', '$F1');
SELECT test.pedido('$WA', '{a0000000-0000-0000-0000-000000000001,b0000000-0000-0000-0000-000000000001}');
SQL
# shellcheck disable=SC2059
igual "C8 compra no alias conta para o canônico W" "$(como "$F1" "$(printf "$FAMS" "$W")")" "COLA,FITA,MASSA"
igual "C8 pedir pelo alias = pedir pelo canônico" \
  "$(como "$F1" "SELECT public.venda_complemento_comprador('$WA')::text = public.venda_complemento_comprador('$W')::text")" "t"
# shellcheck disable=SC2059
igual "C8 alias inativo não conta" \
  "$(Q "UPDATE customer_canonical_alias SET status = 'revoked' WHERE alias_user_id = '$WA'" >/dev/null; como "$F1" "SELECT jsonb_array_length(public.venda_complemento_comprador('$W')->'familias')")" "0"

# ---------------------------------------------------------------- M: re-aplicar e PRE
if PA -1 -f "$MIG" >"$TMP/reapply.log" 2>&1; then ok "M re-aplicar a migration passa (idempotente)"
else bad "M re-aplicação falhou: $(tr '\n' ' ' < "$TMP/reapply.log" | cut -c1-300)"; fi
PA -c "CREATE OR REPLACE FUNCTION public._carteira_mixgap_for_owner(p_owner uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$x\$ BEGIN RETURN '{}'::jsonb; END \$x\$"
if PA -1 -f "$MIG" >"$TMP/pre.log" 2>&1; then bad "M PRE deixou passar corpo estranho"
elif grep -q "PRE FALHOU: public._carteira_mixgap_for_owner" "$TMP/pre.log"; then ok "M PRE recusa corpo estranho (e nada é aplicado)"
else bad "M falhou por outro motivo: $(tr '\n' ' ' < "$TMP/pre.log" | cut -c1-300)"; fi

echo "== $PASSOU ok · $FALHAS falha(s)"
[ "$FALHAS" -eq 0 ] || exit 1
echo "FIM-OK venda-complemento"

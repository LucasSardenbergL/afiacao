#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU4-G: o bypass SECDEF da matriz de LEITURA de compras            ║
# ║   bash db/test-authz-cap-compras-ler-pos-candidatos.sh > "$S/t.log" 2>&1; echo $? ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20260720120000 e prova que `reposicao_pos_candidatos`     ║
# ║  passou do gate `pode_ver_carteira_completa` para `private.cap_compras_ler`        ║
# ║  SEM matar o cron e SEM mudar o que a RPC devolve.                                ║
# ║                                                                                    ║
# ║  ⚠️ O ASSERT QUE MAIS IMPORTA é o do CRON (uid NULL): o gate é cron-or-staff       ║
# ║  NULL-aware, e uma troca desatenta o mataria em SILÊNCIO — a fila de atenção       ║
# ║  pararia de ser alimentada sem erro visível (reposicao.md: mordido 2×).            ║
# ║                                                                                    ║
# ║  Lei #1: plpgsql é late-bound — a RPC é CHAMADA e as LINHAS são conferidas.        ║
# ║  Lei #2: negativo por SQLSTATE (42501) + re-raise, sem casar o texto.              ║
# ║  Lei #3: ZONA 5 sabota e EXIGE vermelho.                                          ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5493}"
SLUG="poscandidatos"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260720120000_authz_cap_compras_ler_pos_candidatos_fu4g.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER="10000000-0000-0000-0000-000000000001"
GERENCIAL="20000000-0000-0000-0000-000000000002"
FARMER="40000000-0000-0000-0000-000000000004"
EMPL_SEM_CR="50000000-0000-0000-0000-000000000005"   # employee SEM linha em commercial_roles (o tri-state)
RUN_ID="99999999-0000-0000-0000-00000000aaaa"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stubs espelhando PROD, medido 2026-07-20)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 1: pré-requisitos ──"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth    TO authenticated, anon, service_role;

CREATE TYPE public.app_role           AS ENUM ('customer','employee','master','admin');
CREATE TYPE public.commercial_role    AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TYPE public.empresa_reposicao  AS ENUM ('OBEN','COLACOR');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- get_commercial_role: cópia verbatim de prod (pg_get_functiondef). É a FONTE do tri-state —
-- sem linha em commercial_roles a subquery escalar devolve NULL, não false.
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT commercial_role
  FROM public.commercial_roles
  WHERE user_id = _user_id
  LIMIT 1
$f$;

-- ⚠️ TRI-STATE — `get_commercial_role(...) IN (...)`, VERBATIM de prod, e NÃO um `EXISTS(...)`.
-- Para um `employee` SEM linha em commercial_roles:
--   ·  com get_commercial_role:  false OR (true AND (NULL IN (...)))  =  false OR NULL  =  NULL
--   ·  com EXISTS (o que estava aqui): false OR (true AND false)      =  false
-- Aqui o veredito FINAL não muda — o `IS NOT TRUE` do corpo trata NULL e false igualmente, e é
-- por isso que esta RPC de LEITURA nunca teve o bypass que as 3 de ESCRITA tinham. O que o EXISTS
-- escondia era outra coisa: a NECESSIDADE do `IS NOT TRUE`. Com stub bi-state, trocá-lo por
-- `NOT(...)` seguia verde; com o tri-state real, a falsificação F3 fica VERMELHA. O assert que não
-- distingue os dois mundos não estava provando a defesa, só acompanhando-a.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND public.get_commercial_role(_uid) IN (
            'gerencial'::public.commercial_role,
            'estrategico'::public.commercial_role,
            'super_admin'::public.commercial_role
          ));
$f$;
GRANT EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO authenticated, service_role;

-- a capability do #1434 (dependência REAL desta migration — a §0 aborta sem ela)
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
REVOKE ALL ON FUNCTION private.cap_compras_ler(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_ler(uuid) TO authenticated, service_role;

-- ── tabelas de compras (tipos ESPELHANDO prod) ──
-- ⚠️ `pedido_compra_sugerido.empresa` é TEXT enquanto as outras usam o ENUM. A assimetria é REAL
-- e é o que o corpo da RPC compara com `v_empresa::text`. Igualar no stub esconderia o bug de
-- tipo que o comentário da própria função documenta (late-bound: quebra ao EXECUTAR).
CREATE TABLE public.reposicao_pedidos_compra_run (
  run_id uuid NOT NULL, seq bigint GENERATED ALWAYS AS IDENTITY,
  empresa public.empresa_reposicao NOT NULL, status text NOT NULL, volume_ok boolean);
CREATE TABLE public.pedido_compra_sugerido (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa text NOT NULL, status text NOT NULL, omie_pedido_compra_id text,
  data_ciclo date, fornecedor_nome text, canal_usado text, portal_protocolo text,
  status_envio_portal text, resposta_canal jsonb);
CREATE TABLE public.pedido_compra_item (pedido_id bigint NOT NULL, valor_linha numeric);
CREATE TABLE public.purchase_orders_tracking (
  empresa public.empresa_reposicao NOT NULL, omie_codigo_pedido bigint NOT NULL);
CREATE TABLE public.reposicao_po_last_seen (
  empresa public.empresa_reposicao NOT NULL, omie_codigo_pedido bigint NOT NULL, run_id uuid);

-- funções auxiliares: corpo VERBATIM de prod
CREATE OR REPLACE FUNCTION public.reposicao__po_id(p text)
 RETURNS bigint LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE t text; b text := '[[:space:]   -​    　﻿]';
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  t := regexp_replace(regexp_replace(p, '^' || b || '+', ''), b || '+$', '');
  IF t !~ '^[0-9]+$' THEN RETURN NULL; END IF;
  t := ltrim(t, '0');
  IF t = '' THEN RETURN 0; END IF;
  IF length(t) > 19 OR (length(t) = 19 AND t > '9223372036854775807') THEN RETURN NULL; END IF;
  RETURN t::bigint;
END $function$;

CREATE OR REPLACE FUNCTION public.reposicao__trim(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $function$ SELECT COALESCE(regexp_replace(regexp_replace(p,
       '^[[:space:]   -​    　﻿]+', ''),
       '[[:space:]   -​    　﻿]+$', ''), '') $function$;
SQL

# ── a RPC alvo: corpo VERBATIM de prod (pg_get_functiondef, psql-ro 2026-07-20) ──
# É o corpo real que a migration vai reescrever — inclusive o COMENTÁRIO que menciona o gate
# antigo, que é o que distingue este caso do FU4-E.
P -q -f /dev/stdin <<'SQL'
CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
 RETURNS TABLE(pedido_id bigint, omie_codigo_pedido text, data_ciclo date, idade_dias integer, na_janela_7d boolean, valor_total numeric, itens_sem_valor integer, visto_status text, po_no_espelho boolean, fornecedor_nome text, canal_usado text, portal_protocolo text, status_envio_portal text, resposta_canal jsonb, tem_protocolo boolean, tem_status_portal boolean, tem_resposta_canal boolean, tem_canal boolean, algum_sinal_de_canal boolean, marcador_run_id uuid, marcador_seq bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     -- ⚠️ IS NOT TRUE, não NOT(...): pode_ver_carteira_completa() é TRI-STATE. Para um `employee` SEM linha
     -- em commercial_roles ela retorna NULL, e `NOT NULL` = NULL — o IF não entrava e a SECURITY DEFINER
     -- ENTREGAVA TUDO (protocolo, fornecedor, JSON cru). Bypass real (Codex v11), e viola o fail-closed do
     -- CLAUDE.md ("query de role falha → role null, approval false"). IS NOT TRUE trata NULL como negado e
     -- preserva o uid NULL do cron, que é barrado antes pelo primeiro AND.
     AND (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    SELECT r.run_id, r.seq
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      p.resposta_canal,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      (SELECT CASE WHEN count(*) FILTER (WHERE i.valor_linha IS NULL) = 0
                   THEN sum(i.valor_linha) END
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      (SELECT count(*) FILTER (WHERE i.valor_linha IS NULL)
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id)::integer AS itens_sem_valor,
      CASE WHEN public.reposicao__po_id(p.omie_pedido_compra_id) IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) END AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
  )
  SELECT
    b.pedido_id, b.omie_codigo_pedido, b.data_ciclo, b.idade_dias,
    (b.idade_dias BETWEEN 0 AND 7) AS na_janela_7d,
    b.valor_total, b.itens_sem_valor,
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      WHEN b.visto_run_id IS NULL                                THEN 'sem_registro_last_seen'
      ELSE 'visto_em_outro_run'
    END AS visto_status,
    b.po_no_espelho, b.fornecedor_nome, b.canal_usado,
    b.portal_protocolo, b.status_envio_portal, b.resposta_canal,
    (public.reposicao__trim(b.portal_protocolo) <> '')    AS tem_protocolo,
    (public.reposicao__trim(b.status_envio_portal) <> '') AS tem_status_portal,
    (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null') AS tem_resposta_canal,
    (public.reposicao__trim(b.canal_usado) <> '')         AS tem_canal,
    (public.reposicao__trim(b.portal_protocolo) <> ''
      OR public.reposicao__trim(b.status_envio_portal) <> ''
      OR (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null')
      OR public.reposicao__trim(b.canal_usado) <> '')     AS algum_sinal_de_canal,
    b.marcador_run_id, b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;
SQL
echo "  pré-requisitos criados"

# guard do stub: sem o gate antigo NO CÓDIGO **e** no COMENTÁRIO, a prova seria vacuosa.
eq "S1 stub nasce com a CHAMADA do gate antigo" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'public\.pode_ver_carteira_completa\s*\(\s*\(\s*SELECT';")" "t"
eq "S2 stub nasce com a MENÇÃO no comentário (o caso que o FU4-E não tinha)" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'pode_ver_carteira_completa\(\) é TRI-STATE';")" "t"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 2: aplicar migration real ──"
P -q -f "$MIG"
echo "  migration aplicada: $(basename "$MIG")"

if P -q -f "$MIG" >/dev/null 2>&1; then
  ok "P0a migration é IDEMPOTENTE (2ª aplicação passa)"
else
  bad "P0a re-aplicar a migration falhou — não é idempotente"
fi
eq "P0b segue com o gate novo após re-aplicar" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT';")" "t"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 3: seeds ──"
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'), ('$GERENCIAL','employee'), ('$FARMER','employee'), ('$EMPL_SEM_CR','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$GERENCIAL','gerencial'), ('$FARMER','farmer');
-- EMPL_SEM_CR fica SEM linha: é o caso tri-state que motivou o IS NOT TRUE.

INSERT INTO public.reposicao_pedidos_compra_run(run_id, empresa, status, volume_ok)
  VALUES ('$RUN_ID','OBEN','ok', true);
INSERT INTO public.pedido_compra_sugerido(empresa, status, omie_pedido_compra_id, data_ciclo,
                                          fornecedor_nome, canal_usado, portal_protocolo,
                                          status_envio_portal, resposta_canal)
  VALUES ('OBEN','disparado','00101', now()::date - 2, 'Sayerlack', 'portal', 'PROTO-9', 'enviado', '{"ok":true}'::jsonb);
INSERT INTO public.pedido_compra_item(pedido_id, valor_linha)
  SELECT id, 1500.00 FROM public.pedido_compra_sugerido;
SQL
echo "  seeds inseridos"

as_user() { P -tA -q <<SQL
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
}
GUARD=$(as_user "$MASTER" "SELECT current_user;")
[ "$GUARD" = "authenticated" ] || { echo "❌ HARNESS INVÁLIDO: SET ROLE não pegou (current_user=$GUARD)"; exit 1; }
echo "  guard: asserts rodam como '$GUARD' (não superuser) ✅"

# ── sanidade do STUB: ele reproduz mesmo o tri-state de prod? ──
# Uma regressão do stub para `EXISTS(...)` (bi-state) deixaria a falsificação F3 impossível de
# ficar vermelha — foi o defeito deste arquivo até 2026-07-20.
eq "T1 gate ANTIGO é TRI-STATE: employee sem commercial_role ⇒ NULL (não false)" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$EMPL_SEM_CR') IS NULL;")" "t"
eq "T1b ...e devolve false (não NULL) p/ papel comercial comum" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$FARMER') IS FALSE;")" "t"
eq "T2 capability NOVA é BI-STATE p/ o mesmo uid (COALESCE ⇒ false, nunca NULL)" \
   "$(Pq -c "SELECT private.cap_compras_ler('$EMPL_SEM_CR') IS FALSE;")" "t"

# nega classificando pela SQLSTATE 42501 — nunca pelo texto da mensagem (anti-teatro de ILIKE).
call_rpc() { # $1=uid ('' = cron/uid NULL)
  local out setuid=""
  [ -n "$1" ] && setuid="SET test.uid = '$1';"
  if out=$(P -tA -q <<SQL 2>&1
$setuid
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM * FROM public.reposicao_pos_candidatos('OBEN');
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_NEGOU_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
  ); then
    case "$out" in *SENTINELA_NEGOU_42501*) echo "DENIED" ;; *) echo "OK" ;; esac
  else echo "ERRO_INESPERADO: $out"; fi
}
linhas() { as_user "$1" "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');"; }

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 4a: o CRON não pode morrer (o risco #1 desta troca) ──"
# uid NULL = pg_cron/service_role SQL-local. O 1º AND do gate deixa passar ANTES de consultar a
# capability. Se esta troca matasse o cron, a fila de atenção pararia em SILÊNCIO.
eq "X1 cron (uid NULL) NÃO é negado" "$(call_rpc "")" "OK"
eq "X2 cron (uid NULL) LÊ as linhas (não só 'não deu erro')" \
   "$(P -tA -q -c "SET ROLE authenticated;" -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');")" "1"

echo "── ZONA 4b: o furo que o FU4-G fecha ──"
eq "N1 gerencial é NEGADO (era o bypass da matriz)" "$(call_rpc "$GERENCIAL")" "DENIED"
eq "N2 farmer é negado"                              "$(call_rpc "$FARMER")"    "DENIED"
eq "N3 employee SEM commercial_role é negado (tri-state)" "$(call_rpc "$EMPL_SEM_CR")" "DENIED"

echo "── ZONA 4c: master preserva TUDO (ninguém perdeu acesso) ──"
eq "M1 master não é negado"        "$(call_rpc "$MASTER")" "OK"
eq "M2 master LÊ a linha candidata" "$(linhas "$MASTER")"   "1"
eq "M3 e o conteúdo sensível chega íntegro (valor+protocolo)" \
   "$(as_user "$MASTER" "SELECT valor_total::int||'|'||portal_protocolo||'|'||visto_status FROM public.reposicao_pos_candidatos('OBEN');")" \
   "1500|PROTO-9|sem_registro_last_seen"

echo "── ZONA 4d: a troca não mexeu na semântica da RPC ──"
eq "C1 empresa sem run marcador devolve VAZIO (fail-closed preservado)" \
   "$(as_user "$MASTER" "SELECT count(*) FROM public.reposicao_pos_candidatos('COLACOR');")" "0"
eq "C2 identidade ilegível segue classificada, não omitida" \
   "$(P -tA -q -c "INSERT INTO public.pedido_compra_sugerido(empresa,status,omie_pedido_compra_id,data_ciclo) VALUES ('OBEN','disparado','1 0 1', now()::date);" \
       -c "SET test.uid='$MASTER';" -c "SET ROLE authenticated;" \
       -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE visto_status='identidade_nao_interpretavel';")" "1"

echo "── ZONA 4e: catálogo — a reescrita preservou atributos e corrigiu o comentário ──"
eq "K1 segue SECURITY DEFINER e STABLE" \
   "$(Pq -c "SELECT (prosecdef AND provolatile='s') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reposicao_pos_candidatos';")" "t"
eq "K2 segue com search_path pinado" \
   "$(Pq -c "SELECT array_to_string(proconfig,',') LIKE '%search_path%' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='reposicao_pos_candidatos';")" "t"
eq "K3 NÃO sobrou CHAMADA ao gate antigo" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ '(public\.|private\.)?pode_ver_carteira_completa\s*\(\s*\(\s*SELECT';")" "f"
# ⚠️ ANCORADO NA CHAMADA, não em `cap_compras_ler.*IS NOT TRUE`. A 1ª versão usava esse regex
# solto e era TEATRO: o comentário que a própria migration escreve contém
# "private.cap_compras_ler faz COALESCE … IS NOT TRUE fica como defesa em profundidade", então o
# `.*` casava DENTRO do comentário e o assert ficava verde mesmo com o `IS NOT TRUE` removido do
# CÓDIGO. Apanhado pela falsificação C (sabotar → seguia verde). É a armadilha "a sentinela contém
# o texto que o código emite", aqui na forma "a migration satisfaz o assert que a fiscaliza".
eq "K4 o IS NOT TRUE foi PRESERVADO na CHAMADA (defesa em profundidade)" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'cap_compras_ler\(\(SELECT auth\.uid\(\)\)\)\)\s+IS NOT TRUE';")" "t"
# o comentário tinha de mudar: afirmar 'é TRI-STATE' sobre cap_compras_ler seria FALSO.
eq "K5 o comentário FALSO foi corrigido" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'era TRI-STATE';")" "t"
eq "K6 ...e a história do porquê foi preservada (menção ao gate antigo continua)" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'pode_ver_carteira_completa';")" "t"
eq "K7 authenticated mantém EXECUTE (ACL preservado)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.reposicao_pos_candidatos(text)','EXECUTE');")" "t"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 5: falsificação (sabotar → exigir vermelho) ──"

# F1 — a capability passa a aceitar o gate antigo. N1 deve QUEBRAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.pode_ver_carteira_completa(_uid), false) $f$;  -- SABOTADO
SQL
if [ "$(call_rpc "$GERENCIAL")" = "OK" ]; then
  ok "F1 sabotagem REABRIU o bypass p/ gerencial → N1 tem dente"
else
  bad "F1 sabotei a capability e N1 seguiu negando — assert FRACO"
fi
eq "F1e sabotado, o gerencial LÊ o conteúdo sensível (efeito, não só ausência de erro)" \
   "$(as_user "$GERENCIAL" "SELECT portal_protocolo FROM public.reposicao_pos_candidatos('OBEN') WHERE portal_protocolo IS NOT NULL;")" "PROTO-9"

P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_ler(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) $f$;
SQL
eq "F1r restaurado: gerencial volta a ser negado" "$(call_rpc "$GERENCIAL")" "DENIED"

# ── F3 — O `IS NOT TRUE` É NECESSÁRIO? (a falsificação que o stub bi-state tornava impossível) ──
# Volta o corpo ao gate ANTIGO **e** troca `IS NOT TRUE` por `NOT (...)`. Com o gate antigo sendo
# TRI-STATE, o employee sem commercial_role produz `NOT NULL` = NULL ⇒ o IF não entra ⇒ a SECDEF
# ENTREGA TUDO. É o bypass que o `IS NOT TRUE` existe para fechar.
# Enquanto o stub era `EXISTS(...)` (bi-state) esta sabotagem NÃO conseguia vazar — o assert que
# fiscaliza o `IS NOT TRUE` acompanhava a defesa sem nunca prová-la.
# ⚠️ A sabotagem tem GUARD próprio: se o regex não casar, `EXECUTE` recriaria a função IDÊNTICA e
# o "não vazou" seria falso verde — exatamente o teatro que esta zona existe para matar.
P -q <<'SQL'
DO $$
DECLARE v_def text; v_sab text;
BEGIN
  v_def := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
  v_sab := regexp_replace(v_def,
    'AND \(SELECT private\.cap_compras_ler\(\(SELECT auth\.uid\(\)\)\)\)\s+IS NOT TRUE THEN',
    'AND NOT (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) THEN');
  IF v_sab = v_def THEN
    RAISE EXCEPTION 'F3 INVÁLIDA: a sabotagem não casou — o teste seria vacuoso';
  END IF;
  EXECUTE v_sab;
END $$;
SQL
if [ "$(call_rpc "$EMPL_SEM_CR")" = "OK" ]; then
  ok "F3 gate antigo + NOT(...) VAZA p/ employee sem commercial_role → o IS NOT TRUE tem função"
else
  bad "F3 sabotei o IS NOT TRUE e nada vazou — o stub NÃO é tri-state (regressão para EXISTS?), o K4 é cego"
fi
eq "F3e ...e o vazamento entrega o conteúdo sensível (efeito, não só ausência de erro)" \
   "$(as_user "$EMPL_SEM_CR" "SELECT portal_protocolo FROM public.reposicao_pos_candidatos('OBEN') WHERE portal_protocolo IS NOT NULL;")" "PROTO-9"
# contraste: o farmer (papel comercial comum ⇒ false, não NULL) segue negado no MESMO corpo
# sabotado. Prova que o vazamento vem do NULL, e não de o gate antigo liberar geral.
eq "F3c ...mas o farmer segue negado no mesmo corpo (o furo é o NULL, não o gate inteiro)" \
   "$(call_rpc "$FARMER")" "DENIED"

# restaura o corpo verdadeiro (gate novo + IS NOT TRUE) e exige que o furo feche
P -q -f "$MIG" >/dev/null 2>&1 || true
P -q <<'SQL'
DO $$
DECLARE v_def text; v_ok text;
BEGIN
  v_def := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
  v_ok := regexp_replace(v_def,
    'AND NOT \(SELECT public\.pode_ver_carteira_completa\(\(SELECT auth\.uid\(\)\)\)\) THEN',
    'AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN');
  IF v_ok <> v_def THEN EXECUTE v_ok; END IF;
END $$;
SQL
eq "F3r restaurado: employee sem commercial_role volta a ser negado" "$(call_rpc "$EMPL_SEM_CR")" "DENIED"
eq "F3rk ...e o IS NOT TRUE está de volta na CHAMADA" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure) ~ 'cap_compras_ler\(\(SELECT auth\.uid\(\)\)\)\)\s+IS NOT TRUE';")" "t"

# F2 — a precondição de dependência tem dente? Sem cap_compras_ler, a migration DEVE abortar.
# (é a diferença de desenho em relação ao FU4-E, que era autônomo de propósito)
P -q -c "DROP FUNCTION private.cap_compras_ler(uuid);"
P -q -c "CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text) RETURNS boolean LANGUAGE sql AS \$f\$ SELECT true \$f\$;" >/dev/null 2>&1 || true
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F2 precondição: migration aplicou SEM private.cap_compras_ler (deveria abortar)"
else
  ok "F2 precondição aborta sem cap_compras_ler → sem caller órfão"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1

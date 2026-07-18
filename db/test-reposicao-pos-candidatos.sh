#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — reposicao_pos_candidatos (detector de PO excluído, NÃO-MUTANTE)  ║
# ║  Migration: supabase/migrations/20260718194500_reposicao_pos_candidatos.sql    ║
# ║  Rode: bash db/test-reposicao-pos-candidatos.sh > /tmp/t.log 2>&1; echo $?     ║
# ║        (NÃO pipe pra tail — engole o exit code)                                 ║
# ║                                                                                ║
# ║  A  marcador fail-closed: sem run VÁLIDO → VAZIO (não classifica ninguém).      ║
# ║  B  quem é candidato: não-visto no marcador (nunca carimbado OU run anterior).  ║
# ║  C  ROTA — o guard que mudou o design: compromisso com o fornecedor NUNCA       ║
# ║     auto-cancela (o portal é acionado ANTES do Omie; prod: 281/286 protocolados).║
# ║  D  gate cron-or-staff NULL-aware (auth.role() mataria o cron SQL-local).        ║
# ║  E  TIPO: pedido_compra_sugerido.empresa é TEXT, as outras são ENUM — comparar  ║
# ║     direto quebra em RUNTIME (PL/pgSQL late-bound). Só EXECUTAR pega.            ║
# ║  Falsifica: sabota cada guard → exige VAZAMENTO (dente).                         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5477}"
SLUG="reposicao-pos-candidatos"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260718194500_reposicao_pos_candidatos.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: schema — TIPOS FIÉIS À PROD (conferidos via psql-ro 18/07) ──
# pedido_compra_sugerido.empresa = TEXT ('OBEN'); as demais = ENUM empresa_reposicao. Essa divergência é o
# ponto E: a RPC compara as duas e text=enum quebra em runtime.
P -q <<'SQL'
CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TABLE public.user_roles       (user_id uuid, role text);
CREATE TABLE public.commercial_roles (user_id uuid, commercial_role text);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $fn$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT commercial_role FROM public.commercial_roles WHERE user_id=_user_id LIMIT 1 $fn$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$ SELECT public.has_role(_uid,'master')
     OR (public.has_role(_uid,'employee') AND public.get_commercial_role(_uid) IN ('gerencial','estrategico','super_admin')) $fn$;

CREATE TABLE public.pedido_compra_sugerido (
  id bigint PRIMARY KEY,
  empresa text NOT NULL,                       -- ⚠️ TEXT em prod (não enum)
  status text NOT NULL,
  omie_pedido_compra_id text,
  data_ciclo date NOT NULL,
  fornecedor_nome text,
  canal_usado text,
  portal_protocolo text,
  status_envio_portal text,
  resposta_canal jsonb
);
CREATE TABLE public.pedido_compra_item (pedido_id bigint, sku_codigo_omie text, valor_linha numeric);
CREATE TABLE public.purchase_orders_tracking (
  empresa public.empresa_reposicao NOT NULL,   -- ⚠️ ENUM
  omie_codigo_pedido bigint NOT NULL
);
CREATE TABLE public.reposicao_pedidos_compra_run (
  run_id uuid PRIMARY KEY, seq bigint NOT NULL UNIQUE,
  empresa public.empresa_reposicao NOT NULL,
  status text NOT NULL DEFAULT 'ok', volume_ok boolean
);
CREATE TABLE public.reposicao_po_last_seen (
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  run_id uuid NOT NULL,
  PRIMARY KEY (empresa, omie_codigo_pedido)
);
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master (staff)
  ('44444444-4444-4444-4444-444444444444');  -- customer (não-staff)
INSERT INTO public.user_roles(user_id, role) VALUES ('33333333-3333-3333-3333-333333333333','master');
SQL

# ── ZONA 2: migration REAL ──
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# UUIDs DESALINHADOS de proposito: o marcador correto (maior seq) tem o MAIOR uuid, e o velho o menor.
# Com eles alinhados, o mutante `ORDER BY r.run_id ASC` passava VERDE sem provar o fencing (Codex v2 #3).
RID_ATUAL='ffffffff-ffff-ffff-ffff-ffffffffffff'
RID_VELHO='00000000-0000-0000-0000-000000000001'

# seed: 1 run VÁLIDO (marcador) + 1 run velho. Pedidos cobrindo cada combinação.
seed() {
  P -q <<SQL
TRUNCATE public.reposicao_pedidos_compra_run, public.reposicao_po_last_seen,
         public.pedido_compra_sugerido, public.pedido_compra_item, public.purchase_orders_tracking;
INSERT INTO public.reposicao_pedidos_compra_run (run_id,seq,empresa,status,volume_ok) VALUES
 ('$RID_VELHO', 10,'OBEN','ok',true),
 ('$RID_ATUAL', 20,'OBEN','ok',true),
 -- Codex PR2 #3 mutante 1: sem um run status<>'ok' de seq MAIOR, remover r.status='ok' passava VERDE.
 ('44444444-4444-4444-4444-444444444444', 30,'OBEN','erro',true),
 -- Codex PR2 #3 mutante 2: sem run de OUTRA empresa com seq MAIOR, remover r.empresa=v_empresa passava VERDE.
 ('55555555-5555-5555-5555-555555555555', 40,'COLACOR','ok',true);
-- 100 visto NO marcador (NÃO é candidato) · 101 visto em run ANTERIOR · 102 NUNCA carimbado
INSERT INTO public.reposicao_po_last_seen (empresa,omie_codigo_pedido,run_id) VALUES
 ('OBEN', 100, '$RID_ATUAL'),
 ('OBEN', 101, '$RID_VELHO');
INSERT INTO public.pedido_compra_sugerido
 (id,empresa,status,omie_pedido_compra_id,data_ciclo,fornecedor_nome,canal_usado,portal_protocolo,status_envio_portal,resposta_canal) VALUES
 (100,'OBEN','disparado','100', now()::date-2,'F','omie',NULL,NULL,NULL),                        -- visto: fora
 (101,'OBEN','disparado','101', now()::date-2,'F','omie',NULL,NULL,NULL),                        -- candidato (run anterior), SEM compromisso
 (102,'OBEN','disparado','102', now()::date-50,'F','omie',NULL,NULL,NULL),                       -- candidato (nunca), SEM compromisso
 (103,'OBEN','disparado','103', now()::date-50,'SAYERLACK','portal_sayerlack','2097501','sucesso_portal','{"fornecedor_notificado":true}'::jsonb), -- protocolado
 (104,'OBEN','disparado','104', now()::date-50,'SAYERLACK','portal_sayerlack',NULL,'sucesso_portal',NULL),                                          -- enviado_portal
 (105,'OBEN','disparado','105', now()::date-50,'F','email',NULL,NULL,'{"fornecedor_notificado":true}'::jsonb),                                      -- notificado
 (106,'OBEN','concluido_recebido','106', now()::date-2,'F','omie',NULL,NULL,NULL),               -- status fora do alvo
 (107,'OBEN','disparado',NULL, now()::date-2,'F','omie',NULL,NULL,NULL),                         -- sem PO
 (108,'OBEN','disparado','', now()::date-2,'F','omie',NULL,NULL,NULL),                           -- PO vazio
 (109,'COLACOR','disparado','109', now()::date-2,'F','omie',NULL,NULL,NULL),                    -- outra empresa
 -- ▼ os shapes que ESCAPAVAM na v1 (Codex PR2 #1) — todos DEVEM ir p/ reconciliacao_humana
 (110,'OBEN','disparado','110', now()::date-50,'F','portal_sayerlack',NULL,' sucesso_portal ',NULL),
 (111,'OBEN','disparado','111', now()::date-50,'F','portal_sayerlack',NULL,'SUCESSO_PORTAL',NULL),
 (112,'OBEN','disparado','112', now()::date-50,'F','omie',NULL,NULL,'{"portal":{"fornecedor_notificado":true}}'::jsonb),
 (113,'OBEN','disparado','113', now()::date-50,'F','omie',NULL,NULL,'[{"fornecedor_notificado":true}]'::jsonb),
 (114,'OBEN','disparado','114', now()::date-50,'F','omie',NULL,NULL,'{"fornecedor_notificado":" true "}'::jsonb),
 (115,'OBEN','disparado','115', now()::date-50,'F','canal_novo_desconhecido',NULL,NULL,NULL),
 (116,'OBEN','disparado','116', now()::date-50,'F',NULL,NULL,NULL,'{"portal_protocolo":"999123"}'::jsonb),
 -- ▼ escapes de PAYLOAD (Codex v2 #1): canal na allowlist, mas resposta_canal NAO reconhecida
 (117,'OBEN','disparado','117', now()::date-50,'F','omie',NULL,NULL, to_jsonb('{"fornecedor_notificado":true}'::text)), -- JSON duplamente escapado
 (118,'OBEN','disparado','118', now()::date-50,'F','omie',NULL,NULL,'{"fornecedorNotificado":true}'::jsonb),            -- camelCase
 (119,'OBEN','disparado','119', now()::date-50,'F','omie',NULL,NULL,'{"portal":{"status":"ok"}}'::jsonb),               -- aninhado desconhecido
 (120,'OBEN','disparado','120', now()::date-50,'F','omie',NULL,NULL,'{"chave_nova_do_futuro":"x"}'::jsonb),             -- vocabulario novo
 (121,'OBEN','disparado','121', now()::date-50,'F',E'\tomie\t',NULL,NULL,NULL),                                        -- canal com TAB
 (122,'OBEN','disparado','122', now()::date-50,'F','email',NULL,NULL,NULL),                                            -- mutante allowlist: email SEM payload
 (123,'OBEN','disparado','123', now()::date-50,'F','omie',NULL,'insucesso_portal',NULL);                               -- 'insucesso' NAO e sucesso
INSERT INTO public.pedido_compra_item (pedido_id,sku_codigo_omie,valor_linha) VALUES
 (101,'A',10.00),(102,'B',1808.59),(103,'C',1251.89),(104,'D',5.00),(105,'E',7.00);
INSERT INTO public.purchase_orders_tracking (empresa,omie_codigo_pedido) VALUES ('OBEN',101);
SQL
}
seed

cand() { Pq -c "SELECT string_agg(pedido_id::text, ',' ORDER BY pedido_id) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1; }
campo() { Pq -c "SELECT $2 FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=$1;" | tail -1; }

echo "── Bloco E: TIPO (text × enum) — só EXECUTAR pega (PL/pgSQL é late-bound) ──"
R=$(P -tA 2>&1 <<'SQL' || true
SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');
SQL
)
case "$R" in
  *"operator does not exist"*|*"does not exist"*|*ERROR*) bad "E1 a RPC QUEBROU em runtime: $R";;
  *) ok "E1 a RPC EXECUTA com empresa TEXT × ENUM (comparação com cast explícito)";;
esac
eq "E2 aceita a empresa em caixa/espaço divergentes (upper+btrim)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('  oben ');" | tail -1)" "19"

echo "── Bloco B: quem é candidato ──"
eq "B1 candidatos = todos os não-vistos no marcador" "$(cand)" "101,102,103,104,105,110,111,112,113,114,115,116,117,118,119,120,121,122,123"
eq "B2 PO visto NO marcador NÃO é candidato (100 fora)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=100;" | tail -1)" "0"
eq "B3 visto em run ANTERIOR é candidato, marcado como tal" "$(campo 101 visto_status)" "visto_em_run_anterior"
eq "B4 NUNCA carimbado é candidato, marcado como tal" "$(campo 102 visto_status)" "nunca_carimbado"
eq "B5 status fora do alvo (concluido_recebido) não entra" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=106;" | tail -1)" "0"
eq "B6 pedido sem PO / PO vazio não entra" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id IN (107,108);" | tail -1)" "0"
eq "B7 outra EMPRESA não vaza (109 é COLACOR)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN') WHERE pedido_id=109;" | tail -1)" "0"
eq "B8 dano_ativo = janela 7d do em_transito (101 recente)" "$(campo 101 dano_ativo)" "t"
eq "B9 dano_ativo falso fora da janela (102, 50d)" "$(campo 102 dano_ativo)" "f"
eq "B10 po_no_espelho reflete o tracking (101 tem linha)" "$(campo 101 po_no_espelho)" "t"
eq "B11 po_no_espelho falso quando o PO sumiu do espelho (102)" "$(campo 102 po_no_espelho)" "f"

echo "── Bloco C: ROTA — compromisso com o fornecedor NUNCA auto-cancela (o guard que mudou o design) ──"
eq "C1 protocolo do portal → reconciliacao_humana (o caso 281/286 de PROD)" "$(campo 103 rota)" "reconciliacao_humana"
eq "C2 sucesso_portal sem protocolo → reconciliacao_humana" "$(campo 104 rota)" "reconciliacao_humana"
eq "C3 fornecedor_notificado=true → reconciliacao_humana" "$(campo 105 rota)" "reconciliacao_humana"
eq "C4 SEM compromisso → elegivel_prova_id (o único caminho p/ o PR3)" "$(campo 102 rota)" "elegivel_prova_id"
eq "C5 classificação do compromisso (103 = protocolado)" "$(campo 103 compromisso_fornecedor)" "protocolado"
eq "C6 nenhum compromisso é rotulado como tal" "$(campo 102 compromisso_fornecedor)" "nenhum"

echo "── Bloco G: FAIL-CLOSED por shape (Codex PR2 #1 — a v1 vazava p/ o caminho do cancelamento) ──"
for pid in 110 111 112 113 114 115 116; do
  eq "G$pid shape de escape -> reconciliacao_humana (nunca elegivel)" "$(campo $pid rota)" "reconciliacao_humana"
done
eq "G-ok canal na allowlist E sem sinal -> elegivel_prova_id (o caminho existe)" "$(campo 102 rota)" "elegivel_prova_id"
eq "G-ind canal desconhecido sem sinal -> indeterminado_canal" "$(campo 115 compromisso_fornecedor)" "indeterminado_canal"

echo "── Bloco H: marcador ignora run NAO-ok e de OUTRA empresa (mutantes que passavam verdes) ──"
eq "H1 marcador = seq 20 (ignora seq 30 status=erro e seq 40 COLACOR)" "$(campo 101 marcador_seq)" "20"

echo "── Bloco I: PAYLOAD nao-reconhecido NAO prova ausencia (Codex v2 #1) ──"
for pid in 117 118 119 120; do
  eq "I$pid payload nao-reconhecido -> reconciliacao_humana" "$(campo $pid rota)" "reconciliacao_humana"
done
eq "I117 JSON duplo-escapado: a regex pega o SINAL no texto (rota ja estava certa)" "$(campo 117 compromisso_fornecedor)" "notificado"
eq "I120 vocabulario novo SEM sinal algum -> indeterminado_payload (so o gate de payload pega)" "$(campo 120 compromisso_fornecedor)" "indeterminado_payload"
eq "I121 canal com TAB normaliza p/ a allowlist (nao vira falso-positivo)" "$(campo 121 rota)" "elegivel_prova_id"
eq "I122 canal 'email' FORA da allowlist -> humano (mata o mutante que o adicionava)" "$(campo 122 rota)" "reconciliacao_humana"
eq "I123 'insucesso_portal' NAO conta como sucesso" "$(campo 123 compromisso_fornecedor)" "nenhum"

echo "── Bloco A: marcador FAIL-CLOSED ──"
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false;" >/dev/null
eq "A1 sem run VÁLIDO (todos truncados) → VAZIO (não classifica ninguém)" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=NULL;" >/dev/null
eq "A2 só bootstrap (volume_ok NULL) → VAZIO" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
P -q -c "TRUNCATE public.reposicao_pedidos_compra_run;" >/dev/null
eq "A3 nenhum run → VAZIO" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "0"
seed
eq "A4 o marcador é o de MAIOR seq (fencing), não o mais antigo" "$(campo 101 marcador_seq)" "20"

echo "── Bloco D: gate cron-or-staff NULL-aware ──"
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='44444444-4444-4444-4444-444444444444';
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE EXCEPTION 'PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'DENY_OK'; END $$;
SQL
)
case "$R" in *DENY_OK*) ok "D1 authenticated NÃO-staff é barrado (42501)";; *) bad "D1 — veio: $R";; esac
eq "D2 staff (master) enxerga" "$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "19"
eq "D3 uid NULL (service_role / cron SQL-local) passa — auth.role() aqui MATARIA o cron" "$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)" "19"

# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"
# Sabota a MIGRATION REAL (sed no arquivo), nao uma copia manual — a copia nao cobria os predicados do
# marcador (Codex PR2 #3: 2 mutantes passavam verdes).
saboto_real() { sed "$1" "$MIG" | P -q -f - ; }

saboto_real "s/AND r.status = 'ok' AND r.volume_ok IS TRUE/AND r.volume_ok IS TRUE/"
V=$(campo 101 marcador_seq)
case "$V" in 30) ok "F4 sem status='ok' o run com ERRO vira marcador — H1 tem dente";; *) bad "F4 nao vazou (marcador=$V)";; esac
P -q -f "$MIG" >/dev/null

saboto_real "s/WHERE r.empresa = v_empresa AND r.status/WHERE r.status/"
V=$(campo 101 marcador_seq)
case "$V" in 40) ok "F5 sem filtro de empresa o run COLACOR vira marcador da OBEN — H1 tem dente";; *) bad "F5 nao vazou (marcador=$V)";; esac
P -q -f "$MIG" >/dev/null

saboto() { # $1 = sem_guard_compromisso | marcador_frouxo | gate_por_role
  local rota_expr="CASE WHEN (b.portal_protocolo IS NOT NULL AND btrim(b.portal_protocolo) <> '') OR b.status_envio_portal='sucesso_portal' OR lower(COALESCE(b.notificado_flag,''))='true' THEN 'reconciliacao_humana' ELSE 'elegivel_prova_id' END"
  local marcador_where="AND r.status='ok' AND r.volume_ok IS TRUE"
  local gate="IF (SELECT auth.uid()) IS NOT NULL AND NOT (SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))) THEN RAISE EXCEPTION 'negado' USING ERRCODE='42501'; END IF;"
  case "$1" in
    sem_guard_compromisso) rota_expr="'elegivel_prova_id'" ;;
    marcador_frouxo)       marcador_where="AND r.status='ok'" ;;
    gate_por_role)         gate="IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'negado' USING ERRCODE='42501'; END IF;" ;;
  esac
  P -q <<SQL
CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE (pedido_id bigint, omie_codigo_pedido text, data_ciclo date, idade_dias integer, dano_ativo boolean,
               valor_total numeric, visto_status text, po_no_espelho boolean, fornecedor_nome text, canal_usado text,
               compromisso_fornecedor text, rota text, marcador_run_id uuid, marcador_seq bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS \$fn\$
DECLARE v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  $gate
  RETURN QUERY
  WITH marcador AS (SELECT r.run_id, r.seq FROM public.reposicao_pedidos_compra_run r
                    WHERE r.empresa=v_empresa $marcador_where ORDER BY r.seq DESC LIMIT 1),
  base AS (
    SELECT p.id AS pedido_id, p.omie_pedido_compra_id AS omie_codigo_pedido, p.data_ciclo::date AS data_ciclo,
           (now()::date - p.data_ciclo::date)::integer AS idade_dias, p.fornecedor_nome, p.canal_usado,
           p.portal_protocolo, p.status_envio_portal, (p.resposta_canal ->> 'fornecedor_notificado') AS notificado_flag,
           m.run_id AS marcador_run_id, m.seq AS marcador_seq, ls.run_id AS visto_run_id,
           (SELECT sum(i.valor_linha) FROM public.pedido_compra_item i WHERE i.pedido_id=p.id) AS valor_total,
           EXISTS (SELECT 1 FROM public.purchase_orders_tracking t WHERE t.empresa=v_empresa AND t.omie_codigo_pedido::text=p.omie_pedido_compra_id) AS po_no_espelho
    FROM public.pedido_compra_sugerido p CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls ON ls.empresa=v_empresa AND ls.omie_codigo_pedido::text=p.omie_pedido_compra_id
    WHERE upper(btrim(p.empresa))=v_empresa::text AND p.status IN ('disparado','aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL AND btrim(p.omie_pedido_compra_id) <> ''
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id))
  SELECT b.pedido_id, b.omie_codigo_pedido, b.data_ciclo, b.idade_dias, (b.idade_dias<=7),
         b.valor_total, CASE WHEN b.visto_run_id IS NULL THEN 'nunca_carimbado' ELSE 'visto_em_run_anterior' END,
         b.po_no_espelho, b.fornecedor_nome, b.canal_usado,
         CASE WHEN b.portal_protocolo IS NOT NULL AND btrim(b.portal_protocolo)<>'' THEN 'protocolado'
              WHEN b.status_envio_portal='sucesso_portal' THEN 'enviado_portal'
              WHEN lower(COALESCE(b.notificado_flag,''))='true' THEN 'notificado' ELSE 'nenhum' END,
         $rota_expr, b.marcador_run_id, b.marcador_seq
  FROM base b;
END; \$fn\$;
SQL
}

# F1 — SEM o guard de compromisso, os 281/286-like caem no caminho do CANCELAMENTO (o pedido duplicado).
saboto sem_guard_compromisso
V=$(campo 103 rota)
case "$V" in elegivel_prova_id) ok "F1 sem o guard, o PROTOCOLADO vira elegivel_prova_id (=recompra R\$3k) — C1 tem dente";; *) bad "F1 não vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# F2 — marcador frouxo (aceita run truncado) → volta a classificar com base inválida.
saboto marcador_frouxo
P -q -c "UPDATE public.reposicao_pedidos_compra_run SET volume_ok=false;" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.reposicao_pos_candidatos('OBEN');" | tail -1)
case "$V" in 0) bad "F2 não vazou (esperava >0 com marcador frouxo)";; *) ok "F2 sem exigir volume_ok, run TRUNCADO vira base ($V candidatos) — A1 tem dente";; esac
P -q -f "$MIG" >/dev/null; seed

# F3 — gate por auth.role() (em vez de uid NULL-aware) MATA o cron SQL-local.
saboto gate_por_role
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN PERFORM * FROM public.reposicao_pos_candidatos('OBEN'); RAISE NOTICE 'CRON_OK';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'CRON_MORREU'; END $$;
SQL
)
case "$R" in *CRON_MORREU*) ok "F3 gate por auth.role() MATA o cron (uid NULL) — D3 tem dente";; *) bad "F3 não vazou ($R)";; esac
P -q -f "$MIG" >/dev/null

# F6 — ordenar o marcador por run_id em vez de seq (o mutante que passava verde com UUIDs alinhados).
# usa o 102 (NUNCA carimbado => candidato sob QUALQUER marcador) p/ a evidencia ser DIRETA: o seq muda.
saboto_real "s/ORDER BY r.seq DESC/ORDER BY r.run_id ASC/"
V=$(campo 102 marcador_seq)
case "$V" in 20) bad "F6 nao vazou (marcador ainda seq=20)";; "") bad "F6 inconclusivo (sem linha)";; *) ok "F6 ordenar por run_id escolhe o marcador ERRADO (seq=$V, nao 20) — o fencing por seq tem dente";; esac
P -q -f "$MIG" >/dev/null

# F7 — afrouxar a allowlist de canal deixa 'email' sem payload virar elegivel (recompra se o email
# tiver acionado o fornecedor).
saboto_real "s/IN ('omie', 'manual', 'interno')/IN ('omie', 'manual', 'interno', 'email')/"
V=$(campo 122 rota)
case "$V" in elegivel_prova_id) ok "F7 allowlist frouxa deixa 'email' virar elegivel — I122 tem dente";; *) bad "F7 nao vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

# F8 — voltar a tratar payload NAO-reconhecido como ausencia provada (o furo do v2).
# 120 e o unico caso que SO o gate de payload pega (118/119 ja casam nas regexes de sinal positivo).
saboto_real "s/AND b.payload_reconhecido//"
V=$(campo 120 rota)
case "$V" in elegivel_prova_id) ok "F8 sem o gate de payload, vocabulario NOVO vira elegivel — I120 tem dente";; *) bad "F8 nao vazou ($V)";; esac
P -q -f "$MIG" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ] && echo "✅ HARNESS VERDE" || { echo "❌ HARNESS VERMELHO"; exit 1; }

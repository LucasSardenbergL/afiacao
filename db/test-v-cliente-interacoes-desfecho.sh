#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — v_cliente_interacoes ganha o desfecho manual (venda_contato)   ║
# ║  Migration: supabase/migrations/20261124150000_v_cliente_interacoes_desfecho_  ║
# ║             manual.sql (onda B da tela de Clientes, item 8)                    ║
# ║                                                                                ║
# ║  Rode:   bash db/test-v-cliente-interacoes-desfecho.sh > /tmp/t.log 2>&1;      ║
# ║          echo "exit=$?"   (NÃO pipe pra tail — engole o exit≠0)                ║
# ║                                                                                ║
# ║  Cada cenário roda num banco PRÓPRIO, que nasce com a view EXATAMENTE como     ║
# ║  está em prod (pg_get_viewdef + {security_invoker=true}, 2026-11-24):          ║
# ║   C0 CONTROLE  — migration real: todos os asserts VERDES.                      ║
# ║   S1 sem invoker (WITH e pós-condição removidos): A5 tem de ficar VERMELHO.    ║
# ║   S2 gate do ramo removido + RLS da tabela alargada: A4b VERMELHO.             ║
# ║   G  guarda: prod sem security_invoker → a migration ABORTA na GUARDA.         ║
# ║  As sabotagens editam um ESPELHO em tmpdir — supabase/migrations/ é DR.        ║
# ║  Aplica com `psql -1` = a transação única do `bun run db:aplicar`.             ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5471}"
SLUG="v-cli-interacoes-desfecho"
TMP="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMP/data"
export LC_ALL=C LANG=C
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

# shellcheck disable=SC2329  # invocada pelo trap EXIT
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMP/pg.log" -w start >/dev/null

MIG="$REPO_ROOT/supabase/migrations/20261124150000_v_cliente_interacoes_desfecho_manual.sql"
[ -f "$MIG" ] || { echo "ERRO: migration ausente: $MIG"; exit 2; }

DB=""
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

# UUIDs fixos
CLI=c0000000-0000-0000-0000-000000000001
V1=a1000000-0000-0000-0000-000000000001   # vendedora dona da carteira do CLI, autora do desfecho
V2=a2000000-0000-0000-0000-000000000002   # vendedora SEM carteira do CLI
GE=a3000000-0000-0000-0000-000000000003   # gestor (carteira completa) NÃO-master
MA=a4000000-0000-0000-0000-000000000004   # master

# Banco novo com o estado de PROD (antes da migration).
novo_banco() {
  DB="$1"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres "$DB"
  P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
  P -q <<SQL
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$f\$ SELECT nullif(current_setting('test.uid', true), '')::uuid \$f\$;
ALTER ROLE service_role BYPASSRLS;

-- Tipos e tabelas: só as colunas que a view toca (tipos medidos em prod, 2026-11-24).
CREATE TYPE public.farmer_call_type AS ENUM ('reativacao','cross_sell','up_sell','follow_up');
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_uid uuid, _r public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS \$f\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _r) \$f\$;

CREATE TABLE public.farmer_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, started_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(), is_whatsapp boolean, call_type public.farmer_call_type NOT NULL DEFAULT 'follow_up',
  notes text, farmer_id uuid NOT NULL, revenue_generated numeric);
CREATE TABLE public.route_visits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL, check_in_at timestamptz,
  visit_date date NOT NULL DEFAULT current_date, created_at timestamptz NOT NULL DEFAULT now(), visit_type text NOT NULL DEFAULT 'Visita',
  notes text, visited_by uuid NOT NULL, revenue_generated numeric);
CREATE TABLE public.tarefas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, concluida_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), categoria text NOT NULL, nota_conclusao text, descricao text NOT NULL, assigned_to uuid NOT NULL);
CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL);
CREATE TABLE public.order_messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  is_staff boolean NOT NULL, message text NOT NULL, sender_id uuid NOT NULL);
-- venda_contato: constraints e policy de SELECT COPIADAS de prod.
CREATE TABLE public.venda_contato (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_user_id uuid NOT NULL, comprador_id uuid NOT NULL,
  dia date NOT NULL DEFAULT current_date, resultado text NOT NULL, motivo text, criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (resultado = ANY (ARRAY['vendeu','vai_pedir','sem_interesse','nao_atendeu'])),
  CHECK (motivo IS NULL OR resultado = 'sem_interesse'),
  UNIQUE (farmer_user_id, comprador_id, dia));
ALTER TABLE public.venda_contato ENABLE ROW LEVEL SECURITY;
CREATE POLICY venda_contato_select ON public.venda_contato FOR SELECT
  USING ((farmer_user_id = auth.uid()) OR (SELECT public.has_role(auth.uid(), 'master'::public.app_role)));

-- Helpers do gate (SECURITY DEFINER em prod). Stub fiel à SEMÂNTICA: carteira completa = master ou
-- gestor marcado; carteira visível = par (cliente, usuário) na tabela de carteira.
CREATE SCHEMA private;
CREATE TABLE public.t_gestor (uid uuid);
CREATE TABLE public.t_carteira (cli uuid, uid uuid);
CREATE FUNCTION private.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$f\$ SELECT public.has_role(_uid, 'master') OR EXISTS (SELECT 1 FROM public.t_gestor WHERE uid = _uid) \$f\$;
CREATE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS \$f\$ SELECT EXISTS (SELECT 1 FROM public.t_carteira WHERE cli = _customer_user_id AND uid = _uid) \$f\$;
GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA private TO authenticated, anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated, anon;

-- Seed
INSERT INTO public.user_roles VALUES ('$MA', 'master'), ('$GE', 'employee'), ('$V1', 'employee'), ('$V2', 'employee');
INSERT INTO public.t_gestor VALUES ('$GE');
INSERT INTO public.t_carteira VALUES ('$CLI', '$V1');
INSERT INTO public.farmer_calls (customer_user_id, farmer_id, notes) VALUES ('$CLI', '$V1', 'ligou');
INSERT INTO public.route_visits (customer_user_id, visited_by) VALUES ('$CLI', '$V1');
INSERT INTO public.tarefas (customer_user_id, categoria, descricao, assigned_to) VALUES ('$CLI', 'ligar', 'retornar', '$V1');
INSERT INTO public.orders (id, user_id) VALUES ('0d000000-0000-0000-0000-000000000001', '$CLI');
INSERT INTO public.order_messages (order_id, is_staff, message, sender_id) VALUES ('0d000000-0000-0000-0000-000000000001', true, 'oi', '$V1');
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, resultado, motivo, atualizado_em)
  VALUES ('$V1', '$CLI', 'sem_interesse', 'estoque cheio', '2026-11-24 15:00:00+00');
SQL
  # A view EXATAMENTE como está em prod (pg_get_viewdef, 2026-11-24) — o ponto de partida do replace.
  P -q <<'SQL'
CREATE VIEW public.v_cliente_interacoes WITH (security_invoker = true) AS
 SELECT fc.customer_user_id, COALESCE(fc.started_at, fc.created_at) AS at,
   CASE WHEN fc.is_whatsapp THEN 'whatsapp'::text ELSE 'ligacao'::text END AS canal,
   CASE fc.call_type WHEN 'reativacao'::farmer_call_type THEN 'Reativação'::text WHEN 'cross_sell'::farmer_call_type THEN 'Cross-sell'::text
     WHEN 'up_sell'::farmer_call_type THEN 'Up-sell'::text WHEN 'follow_up'::farmer_call_type THEN 'Follow-up'::text ELSE 'Contato'::text END AS titulo,
   NULLIF(fc.notes, ''::text) AS resumo, 'farmer_calls'::text AS ref_tabela, fc.id AS ref_id, fc.farmer_id AS autor_id, fc.revenue_generated AS revenue
   FROM farmer_calls fc
  WHERE fc.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR fc.farmer_id = auth.uid() OR private.carteira_visivel_para(fc.customer_user_id, auth.uid()))
UNION ALL
 SELECT rv.customer_user_id, COALESCE(rv.check_in_at, rv.visit_date::timestamp with time zone, rv.created_at) AS at, 'visita'::text AS canal,
   COALESCE(NULLIF(rv.visit_type, ''::text), 'Visita'::text) AS titulo, NULLIF(rv.notes, ''::text) AS resumo, 'route_visits'::text AS ref_tabela,
   rv.id AS ref_id, rv.visited_by AS autor_id, rv.revenue_generated AS revenue
   FROM route_visits rv
  WHERE rv.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR rv.visited_by = auth.uid() OR private.carteira_visivel_para(rv.customer_user_id, auth.uid()))
UNION ALL
 SELECT t.customer_user_id, COALESCE(t.concluida_em, t.created_at) AS at, 'tarefa'::text AS canal, COALESCE(NULLIF(t.categoria, ''::text), 'Tarefa'::text) AS titulo,
   COALESCE(NULLIF(t.nota_conclusao, ''::text), NULLIF(t.descricao, ''::text)) AS resumo, 'tarefas'::text AS ref_tabela, t.id AS ref_id,
   t.assigned_to AS autor_id, NULL::numeric AS revenue
   FROM tarefas t
  WHERE t.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR private.carteira_visivel_para(t.customer_user_id, auth.uid()))
UNION ALL
 SELECT o.user_id AS customer_user_id, om.created_at AS at, 'mensagem_pedido'::text AS canal,
   CASE WHEN om.is_staff THEN 'Mensagem da equipe'::text ELSE 'Mensagem do cliente'::text END AS titulo, NULLIF(om.message, ''::text) AS resumo,
   'order_messages'::text AS ref_tabela, om.id AS ref_id, om.sender_id AS autor_id, NULL::numeric AS revenue
   FROM order_messages om JOIN orders o ON o.id = om.order_id
  WHERE o.user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR private.carteira_visivel_para(o.user_id, auth.uid()));
GRANT SELECT ON public.v_cliente_interacoes TO authenticated, anon;
SQL
}

# Linhas visíveis de um canal para um usuário, sob SET ROLE authenticated (RLS + gate valendo).
ve() { Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT count(*) FROM public.v_cliente_interacoes WHERE canal = '$2';" | tail -1; }
colunas() { Pq -c "SELECT string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid = 'public.v_cliente_interacoes'::regclass AND attnum > 0 AND NOT attisdropped;"; }

# Asserts do cenário. Cada um grava "nome=0|1" em $RES (1 = passou), para a falsificação ler.
RES=""
QUIETO=0   # 1 = cenário sabotado: só registra em $RES, não conta PASS/FAIL (quem julga é o chamador)
reg() {
  RES="$RES $1=$2"
  [ "$QUIETO" = 1 ] && return 0
  if [ "$2" = 1 ]; then ok "$1 — $3"; else bad "$1 — $3"; fi
}
asserts() {
  RES=""
  local antes="$1" depois
  depois="$(colunas)"
  if [ "$antes" = "$depois" ]; then reg A1 1 "colunas idênticas (nomes/tipos/ordem)"; else reg A1 0 "colunas mudaram: [$antes] → [$depois]"; fi
  local opts; opts="$(Pq -c "SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_cliente_interacoes'::regclass;")"
  if [ "$opts" = "{security_invoker=true}" ]; then reg A2 1 "reloptions {security_invoker=true}"; else reg A2 0 "reloptions [$opts]"; fi
  local lin; lin="$(Pq -c "SET test.uid='$V1'; SET ROLE authenticated; SELECT titulo || '|' || coalesce(resumo,'∅') || '|' || ref_tabela || '|' || autor_id FROM public.v_cliente_interacoes WHERE canal = 'desfecho';" | tail -1)"
  if [ "$lin" = "Desfecho: sem interesse|estoque cheio|venda_contato|$V1" ]; then reg A3 1 "autora vê o desfecho com título/motivo/ref"; else reg A3 0 "autora viu [$lin]"; fi
  local n; n="$(ve "$V2" desfecho)"
  if [ "$n" = 0 ]; then reg A4 1 "vendedora sem carteira não vê o desfecho"; else reg A4 0 "vendedora sem carteira viu $n"; fi
  n="$(ve "$GE" desfecho)"; local nl; nl="$(ve "$GE" ligacao)"
  if [ "$n" = 0 ] && [ "$nl" = 1 ]; then reg A5 1 "gestor não-master: vê a ligação, NÃO o desfecho alheio (RLS da tabela vale: invoker)"; else reg A5 0 "gestor viu desfecho=$n ligacao=$nl"; fi
  n="$(ve "$MA" desfecho)"
  if [ "$n" = 1 ]; then reg A6 1 "master vê o desfecho"; else reg A6 0 "master viu $n"; fi
  n="$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.v_cliente_interacoes;" | tail -1)"
  if [ "$n" = 0 ]; then reg A7 1 "anon não vê nada"; else reg A7 0 "anon viu $n"; fi
  local ramos; ramos="$(Pq -c "SET test.uid='$MA'; SET ROLE authenticated; SELECT string_agg(canal || ':' || c, ',' ORDER BY canal) FROM (SELECT canal, count(*) c FROM public.v_cliente_interacoes GROUP BY 1) x;" | tail -1)"
  if [ "$ramos" = "desfecho:1,ligacao:1,mensagem_pedido:1,tarefa:1,visita:1" ]; then reg A8 1 "os 4 ramos de antes seguem intactos + o novo"; else reg A8 0 "ramos [$ramos]"; fi
  # A4b: se a RLS de venda_contato um dia ALARGAR, o gate do ramo ainda segura a vendedora sem carteira.
  P -q -c "DROP POLICY venda_contato_select ON public.venda_contato; CREATE POLICY venda_contato_select ON public.venda_contato FOR SELECT USING (true);"
  n="$(ve "$V2" desfecho)"
  if [ "$n" = 0 ]; then reg A4b 1 "RLS alargada: o gate do ramo ainda barra a vendedora sem carteira"; else reg A4b 0 "RLS alargada: vendedora sem carteira viu $n"; fi
  P -q -c "DROP POLICY venda_contato_select ON public.venda_contato; CREATE POLICY venda_contato_select ON public.venda_contato FOR SELECT USING ((farmer_user_id = auth.uid()) OR (SELECT public.has_role(auth.uid(), 'master'::public.app_role)));"
}
passou() { case " $RES " in *" $1=1 "*) return 0 ;; *) return 1 ;; esac; }

# ── C0: CONTROLE (migration real) ───────────────────────────────────────────────
echo "═══ C0 controle: migration REAL ═══"
novo_banco c0
ANTES="$(colunas)"
if P -q -1 -f "$MIG" >"$TMP/c0.log" 2>&1; then ok "C0 migration real aplicou (guarda e pós-condição passaram)"; else bad "C0 migration real FALHOU: $(head -c 400 "$TMP/c0.log")"; fi
asserts "$ANTES"
C0_OK=1; for a in A1 A2 A3 A4 A5 A6 A7 A8 A4b; do passou "$a" || C0_OK=0; done
[ "$C0_OK" = 1 ] || { echo "CONTROLE VERMELHO — falsificação abortada (sem linha de base verde não há prova)"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }

# ── S1: sem security_invoker (o erro clássico do CREATE OR REPLACE) → A5 VERMELHO ──
echo "═══ S1 sabotagem: replace sem WITH (security_invoker) ═══"
# shellcheck disable=SC2016  # o $pos$ é literal do SQL, não expansão do shell
sed -e 's/^WITH (security_invoker = true) AS$/AS/' -e '/^DO \$pos\$/,/^\$pos\$;/d' "$MIG" > "$TMP/s1.sql"
if grep -q 'security_invoker = true) AS' "$TMP/s1.sql" || grep -q 'POSCONDICAO' "$TMP/s1.sql"; then bad "S1 sabotagem não pegou no espelho"; fi
novo_banco s1; ANTES="$(colunas)"
P -q -1 -f "$TMP/s1.sql" >/dev/null 2>&1 || bad "S1 espelho sabotado não aplicou"
QUIETO=1; asserts "$ANTES"; QUIETO=0
if passou A5; then bad "S1: A5 seguiu VERDE sem invoker — o assert não tem dente"; else ok "S1: sem invoker, A5 ficou VERMELHO (gestor passou a ver o desfecho alheio)"; fi

# ── S2: gate do ramo removido → A4b VERMELHO (com RLS alargada) ─────────────────
echo "═══ S2 sabotagem: ramo venda_contato sem o gate de carteira ═══"
sed -e 's/^  WHERE vc.comprador_id IS NOT NULL AND (private.pode_ver_carteira_completa.*$/  WHERE vc.comprador_id IS NOT NULL;/' "$MIG" > "$TMP/s2.sql"
grep -q 'vc.comprador_id IS NOT NULL;' "$TMP/s2.sql" || bad "S2 sabotagem não pegou no espelho"
novo_banco s2; ANTES="$(colunas)"
P -q -1 -f "$TMP/s2.sql" >/dev/null 2>&1 || bad "S2 espelho sabotado não aplicou"
QUIETO=1; asserts "$ANTES"; QUIETO=0
if passou A4b; then bad "S2: A4b seguiu VERDE sem o gate — o assert não tem dente"; else ok "S2: sem o gate, A4b ficou VERMELHO"; fi
# Com a RLS de PROD, a tabela já barra a vendedora sem carteira: A4 fica verde mesmo sem o gate
# (camada redundante HOJE — registrado; o gate existe para a RLS não ser a única defesa).
if passou A4; then ok "S2: A4 verde sem o gate = a RLS de prod já barra (defesa em profundidade, registrado)"; else bad "S2: A4 vermelho inesperado"; fi

# ── G: guarda contra drift — prod sem security_invoker faz a migration ABORTAR ──
echo "═══ G guarda: view de prod sem security_invoker ═══"
novo_banco g
P -q -c "ALTER VIEW public.v_cliente_interacoes RESET (security_invoker);"
if P -q -1 -f "$MIG" >"$TMP/g.log" 2>&1; then bad "G: migration aplicou sobre view em drift (guarda sem dente)"
elif grep -q 'ERROR:  GUARDA v_cliente_interacoes: reloptions' "$TMP/g.log"; then ok "G: migration abortou na GUARDA (drift de reloptions)"
else bad "G: falhou por OUTRO motivo: $(head -c 300 "$TMP/g.log")"; fi
DB=g
OPT="$(Pq -c "SELECT coalesce(reloptions::text, 'null') FROM pg_class WHERE oid = 'public.v_cliente_interacoes'::regclass;")"
if [ "$OPT" = "null" ]; then ok "G: transação revertida (view intacta)"; else bad "G: view mudou após abortar [$OPT]"; fi

echo "═══ PASS=$PASS FAIL=$FAIL ═══"
[ "$FAIL" = 0 ] && echo "PROVA-V-CLIENTE-INTERACOES-DESFECHO-OK" && exit 0
exit 1

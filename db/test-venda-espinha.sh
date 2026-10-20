#!/usr/bin/env bash
# Prova PG17 da ESPINHA do programa Venda por cliente — migration 20261020174221_venda_cliente_espinha:
# `venda_sugestao` (sugestão com identidade) · `venda_contato` (desfecho manual, 1 escritor) · `venda_config`
# (ondas desligadas, teto, janelas) · RPCs da farmer (`venda_minhas_sugestoes`, `venda_marcar_mostrada`,
# `venda_registrar_contato`) · job `venda_fechar_desfechos` + cron 09:30 UTC · plano tático desligado.
#
# O que prova EXECUTANDO (PL/pgSQL é late-bound):
#  T1  pedido feito no cadastro ALIAS fecha a recompra do comprador canônico (virou_pedido + pedido + valor líquido)
#  T2  pedido cancelado e pedido apagado não contam → nao_virou
#  T3  sync de vendas com buraco que nenhum sync futuro cobre → nao_medivel/sync_atrasado (nunca nao_virou)
#  T3b buraco ainda cobrível → linha fica ABERTA; o sync chega → nao_virou
#  T3c dia antigo coberto só pelo cursor de backfill → mensurável
#  T4  janela aberta continua NULL; pedido ANTES da janela não conta; complemento casa por família no fuso SP;
#      preço: desconto não apurado → nao_medivel, bruto abaixo do alvo → nao_virou, líquido ≥ alvo×0,99 → virou
#  T4d re-rodar não muda nada
#  T5  farmer F2 não vê comprador de F1      T6  F1 não vê linhas sombra/historico; total NULL se falta valor
#  T7  marcar mostrada 2×: a 1ª vence; linha alheia/sombra não é marcada
#  T8  contato fora da carteira → 42501; alias na carteira resolve; último toque do dia vence; entrada inválida → 22023
#  T9  ACL (anon/PUBLIC sem EXECUTE; job sem authenticated)   T10 RLS direto na tabela
#  T11 cron e re-apply (não duplica, não reseta onda ligada)  T12 janela ausente → 22023
#
#   bash db/test-venda-espinha.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-espinha.sh     # mesma prova no outro locale (marcas ASCII)
#   SABOTAGEM=<nome> bash db/test-venda-espinha.sh             # tem de ficar VERMELHA
#   bash db/test-venda-espinha.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020174221_venda_cliente_espinha.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="alias_pedido:T1 sync_vira_nao_virou:T3 fecha_cobrivel:T3b cursor_ignorado:T3c desconto_como_zero:T4c minhas_sem_fase:T6 mostrada_sobrescreve:T7 carteira_sem_alias:T8b rls_sombra_visivel:T10 acl_aberta:POST!A3_FALHOU acl_aberta_sem_post:T9 cron_tatico_fica:POST!A6_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-espinha.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK venda-espinha" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }"; modo="-qF" ;;
      *)   marca="FAIL $a "; modo="-qF" ;;
    esac
    if grep "$modo" -- "$marca" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-espinha.XXXXXX")/data"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  alias_pedido)        sabotar "COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador," "so.customer_user_id AS comprador," ;;
  sync_vira_nao_virou) sabotar "AND x.dia + 5 < p_hoje)           THEN 'nao_medivel'" "AND x.dia + 5 < p_hoje)           THEN 'nao_virou'" ;;
  fecha_cobrivel)      sabotar "THEN NULL   -- ainda cobrível" "THEN 'nao_virou'   -- sabotado" ;;
  cursor_ignorado)     sabotar "AND c.falhou_em IS NULL" "AND false" ;;
  desconto_como_zero)  sabotar "- oi.desconto_valor" "- COALESCE(oi.desconto_valor, 0)" ;;
  minhas_sem_fase)     sabotar "     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = v_uid" "     WHERE s.farmer_user_id = v_uid" ;;
  mostrada_sobrescreve) sabotar "     AND fase = 'ativa'
     AND mostrada_em IS NULL;" "     AND fase = 'ativa';" ;;
  carteira_sem_alias)  sabotar "AND COALESCE(ca.canonical_user_id, c.customer_user_id) = v_comprador" "AND c.customer_user_id = v_comprador" ;;
  rls_sombra_visivel)  sabotar "USING ((farmer_user_id = auth.uid() AND fase = 'ativa')" "USING ((farmer_user_id = auth.uid())" ;;
  acl_aberta)          sabotar "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC;" ;;
  acl_aberta_sem_post) sabotar "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC;"
                       sabotar "    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN" "    IF false THEN" ;;
  cron_tatico_fica)    sabotar "SELECT cron.unschedule('tactical-plans-batch-nightly')" "SELECT 'sabotado'" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
# Casa "<SEVERIDADE>:  <CÓDIGO>:" — a severidade pode vir localizada (ERRO/ERROR), o código nunca.
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; M=00000000-0000-0000-0000-0000000000ee
C=00000000-0000-0000-0000-0000000000c1;  A=00000000-0000-0000-0000-0000000000a1
C2=00000000-0000-0000-0000-0000000000c2; C3=00000000-0000-0000-0000-0000000000c3; CX=00000000-0000-0000-0000-0000000000c9
como() { # $1 = uid ('' = sem sessão), $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}

# ── Esquema mínimo com as MESMAS colunas/CHECKs de prod (medido via psql-ro em 2026-10-20) ─────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;   -- como em prod (medido)
-- Default privileges do Supabase: relação e função novas NASCEM abertas (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text DEFAULT 'postgres', database text DEFAULT current_database());
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
-- pg_cron real: unschedule de nome inexistente é ERRO — o stub também, para provar o guard idempotente.
CREATE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', p_jobname; END IF;
  RETURN true;
END $$;
INSERT INTO cron.job (jobid, jobname, schedule, command) VALUES
  (165, 'tactical-plans-batch-nightly', '0 8 * * *', 'SELECT net.http_post(url := ''x/tactical-plans-batch'')');

CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, phone text,
  razao_social text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, status text,
  account text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, order_date_kpi date);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, descricao text,
  familia text, account text, UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE, customer_user_id uuid,
  product_id uuid REFERENCES public.omie_products(id), omie_codigo_produto bigint, quantity numeric, unit_price numeric,
  desconto_valor numeric);
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, companies text[],
  status text, started_at timestamptz, completed_at timestamptz);
CREATE TABLE public.vendas_sync_cursor (account text, date_from date, date_to date, completed_at timestamptz, falhou_em timestamptz);
SQL

# ── Seed de mundo (antes do apply) ───────────────────────────────────────────────────────────────
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$F1','employee'), ('$F2','employee'), ('$M','master');
INSERT INTO public.profiles (user_id, name, phone) VALUES ('$C', 'Marcenaria Canonica', '3133330001'), ('$C2', 'Moveis Dois', '3133330002'),
  ('$C3', 'Cliente da F2', '3133330003');
-- Alias fiscal A (cadastro Colacor/placeholder) → comprador canônico C. Carteira de F1 está no id do ALIAS (como 1.633 em prod).
INSERT INTO public.customer_canonical_alias VALUES ('$A', '$C', 'active');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$A', '$F1'), ('$C2', '$F1'), ('$C3', '$F2');
INSERT INTO public.omie_products (omie_codigo_produto, descricao, familia, account) VALUES
  (111, 'FUNDO PU 3,6L', 'Fundo', 'oben'), (222, 'VERNIZ PU', 'Verniz', 'oben'), (333, 'SELADORA NC', 'Seladora', 'oben'),
  (444, 'CATALISADOR', 'Catalisador', 'oben'), (555, 'THINNER', 'Thinner', 'oben'), (111, 'LIXA 120', 'Lixa', 'colacor');
-- Pedidos (d = 2026-09-01):
--  o1 ALIAS A, faturado, 09-06: SKU 111 · 2 × 50 − desc 10 → líquido 90 (45/un)
--  o2 ALIAS A, CANCELADO, 09-04: SKU 222      o5 C, apagado, 09-03: SKU 555
--  o3 C, faturado, 09-08: SKU 444 · 100/un, desconto NÃO APURADO (NULL)
--  o4 C, faturado, sem order_date_kpi, created_at 2026-09-21 02:00 UTC = 09-20 23:00 SP: SKU 333 (família Seladora) 3 × 20 − 0
INSERT INTO public.sales_orders (id, customer_user_id, status, account, order_date_kpi, created_at, deleted_at) VALUES
  ('00000000-0000-0000-0000-00000000a001', '$A', 'faturado',  'oben', '2026-09-06', '2026-09-06 12:00+00', NULL),
  ('00000000-0000-0000-0000-00000000a002', '$A', 'cancelado', 'oben', '2026-09-04', '2026-09-04 12:00+00', NULL),
  ('00000000-0000-0000-0000-00000000a003', '$C', 'faturado',  'oben', '2026-09-08', '2026-09-08 12:00+00', NULL),
  ('00000000-0000-0000-0000-00000000a004', '$C', 'importado', 'oben', NULL,         '2026-09-21 02:00+00', NULL),
  ('00000000-0000-0000-0000-00000000a005', '$C', 'faturado',  'oben', '2026-09-03', '2026-09-03 12:00+00', '2026-09-05 00:00+00');
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor) VALUES
  ('00000000-0000-0000-0000-00000000a001', 111, 2, 50, 10),
  ('00000000-0000-0000-0000-00000000a002', 222, 1, 100, 0),
  ('00000000-0000-0000-0000-00000000a003', 444, 1, 100, NULL),
  ('00000000-0000-0000-0000-00000000a004', 333, 3, 20, 0),
  ('00000000-0000-0000-0000-00000000a005', 555, 1, 30, 0);
-- Sync de vendas: oben todo dia 10:00 SP; colacor com BURACO 09-03..09-13 e parado depois de 10-02.
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at)
SELECT 'sync_pedidos', ARRAY['oben'], 'complete', (g::date + time '13:00') AT TIME ZONE 'UTC', (g::date + time '13:05') AT TIME ZONE 'UTC'
  FROM generate_series(date '2026-08-20', date '2026-11-15', interval '1 day') g;
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at)
SELECT 'sync_pedidos', ARRAY['colacor'], 'complete', (g::date + time '13:00') AT TIME ZONE 'UTC', (g::date + time '13:05') AT TIME ZONE 'UTC'
  FROM generate_series(date '2026-08-20', date '2026-10-02', interval '1 day') g
 WHERE g::date NOT BETWEEN date '2026-09-03' AND date '2026-09-13';
-- Ruído que NÃO pode contar como cobertura: sync de outra ação e sync de pedidos com erro no buraco.
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_contas_receber', ARRAY['colacor'], 'complete', '2026-09-06 13:00+00', '2026-09-06 13:05+00'),
  ('sync_pedidos',        ARRAY['colacor'], 'error',    '2026-09-07 13:00+00', '2026-09-07 13:05+00');
-- Backfill antigo da colacor (cobre junho, sem fin_sync_log) + uma janela que FALHOU (não cobre nada).
INSERT INTO public.vendas_sync_cursor VALUES
  ('colacor', '2026-01-01', '2026-07-21', '2026-07-22 03:00+00', NULL),
  ('oben',    '2026-01-01', '2026-07-21', '2026-07-22 03:00+00', '2026-07-22 03:00+00');
SQL

# ── Apply (postcondição DO \$post\$ roda aqui) ────────────────────────────────────────────────────
P -q -f "$MIG_USADA"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# ── Sugestões (como o gerador da Task 4 gravaria) ────────────────────────────────────────────────
P -q <<SQL
INSERT INTO public.venda_sugestao (id, tipo, fase, dia_referencia, farmer_user_id, comprador_id, empresa, omie_codigo_produto, familia,
                                   qtd_ref, valor_ref, preco_alvo, motivo_entrada) VALUES
 ('00000000-0000-0000-0000-0000000005a1','recompra',   'ativa',    '2026-09-01','$F1','$C', 'oben',   111, NULL,       2, 100, NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a2','recompra',   'ativa',    '2026-09-01','$F1','$C', 'oben',   222, NULL,       1, NULL,NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a3','recompra',   'ativa',    '2026-09-01','$F1','$C2','colacor',111, NULL,       1, 50,  NULL, 'maior atraso da carteira'),
 ('00000000-0000-0000-0000-0000000005b3','recompra',   'ativa',    '2026-09-21','$F1','$C2','colacor',111, NULL,       1, 50,  NULL, 'maior atraso da carteira'),
 ('00000000-0000-0000-0000-0000000005a4','recompra',   'ativa',    '2026-09-11','$F1','$C', 'oben',   111, NULL,       2, 100, NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a5','complemento','ativa',    '2026-09-01','$F1','$C', 'oben',   NULL,'Seladora', NULL,NULL,NULL,'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a6','preco',      'ativa',    '2026-09-01','$F1','$C', 'oben',   444, NULL,       1, 100, 100,  'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a7','preco',      'ativa',    '2026-09-01','$F1','$C', 'oben',   111, NULL,       2, 100, 100,  'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a8','preco',      'ativa',    '2026-09-02','$F1','$C', 'oben',   111, NULL,       2, 80,  40,   'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005a9','recompra',   'historico','2026-06-01','$F1','$C2','colacor',111, NULL,       1, 50,  NULL, 'maior atraso da carteira'),
 ('00000000-0000-0000-0000-0000000005aa','recompra',   'ativa',    '2026-09-01','$F1','$C', 'oben',   555, NULL,       1, 30,  NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005ab','recompra',   'sombra',   '2026-09-01','$F1','$C', 'oben',   111, NULL,       2, 100, NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005ac','recompra',   'historico','2026-09-01','$F1','$C', 'oben',   111, NULL,       2, 100, NULL, 'entrega amanha em Claudio'),
 ('00000000-0000-0000-0000-0000000005f2','recompra',   'ativa',    '2026-09-01','$F2','$C3','oben',   111, NULL,       1, 70,  NULL, 'maior atraso da carteira');
SQL
s() { echo "00000000-0000-0000-0000-0000000005$1"; }
estado_de() { Pq -c "SELECT COALESCE(desfecho,'ABERTA')||'|'||COALESCE(desfecho_motivo,'-')||'|'||COALESCE(right(sales_order_id::text,4),'-')||'|'||COALESCE(valor_realizado::text,'-') FROM public.venda_sugestao WHERE id='$(s "$1")';"; }

# ── RPCs e RLS (antes de fechar desfecho: o que a farmer vê no dia) ───────────────────────────────
R5="$(Pq -c "$(como "$F2" "SELECT public.venda_minhas_sugestoes('2026-09-01');")")" || true
eq "T5 F2 só vê o comprador dela (nenhum de F1)" \
   "$(printf '%s' "$R5" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['dia'], ','.join(c['comprador_id'][-2:] for c in d['compradores']), sum(len(c['sugestoes']) for c in d['compradores']))")" \
   "2026-09-01 c3 1"
R6="$(Pq -c "$(como "$F1" "SELECT public.venda_minhas_sugestoes('2026-09-01');")")" || true
eq "T6 F1: 2 compradores (C2 com total 50 antes de C com total NULL), 7 sugestões ativas, nenhuma sombra/historico" \
   "$(printf '%s' "$R6" | python3 -I -c "
import json,sys; d=json.load(sys.stdin); cs=d['compradores']; ids=[x['id'][-2:] for c in cs for x in c['sugestoes']]
print(','.join(c['comprador_id'][-2:] for c in cs), cs[0]['valor_ref_total'], cs[1]['valor_ref_total'], len(ids), 'ab' in ids or 'ac' in ids or 'a9' in ids)")" \
   "c2,c1 50 None 7 False"
eq "T6b ficha: nome/telefone do canônico, motivo, descrição do SKU na empresa certa, preço alvo só no tipo preço" \
   "$(printf '%s' "$R6" | python3 -I -c "
import json,sys; d=json.load(sys.stdin); c=[x for x in d['compradores'] if x['comprador_id'].endswith('c1')][0]; sg={x['id'][-2:]:x for x in c['sugestoes']}
c2=[x for x in d['compradores'] if x['comprador_id'].endswith('c2')][0]
print(c['nome'], c['telefone'], c['motivo_entrada'], sg['a1']['descricao'], sg['a1']['preco_alvo'], sg['a6']['preco_alvo'], c2['sugestoes'][0]['descricao'])")" \
   "Marcenaria Canonica 3133330001 entrega amanha em Claudio FUNDO PU 3,6L None 100 LIXA 120"
eq "T6c sem sessão → 42501" "$(estado "$(como "" "SELECT public.venda_minhas_sugestoes('2026-09-01');")")" "42501"

eq "T7 marcar mostrada: só a linha ativa da própria farmer (sombra e de F2 ignoradas)" \
   "$(Pq -c "$(como "$F1" "SELECT public.venda_marcar_mostrada(ARRAY['$(s a1)','$(s ab)','$(s f2)']::uuid[]);")")" "1"
M1="$(Pq -c "SELECT mostrada_em FROM public.venda_sugestao WHERE id='$(s a1)';")" || true
sleep 1
eq "T7 2ª marcação: 0 linhas e mostrada_em intacto; F2 não marca linha de F1" \
   "$(Pq -c "$(como "$F1" "SELECT public.venda_marcar_mostrada(ARRAY['$(s a1)']::uuid[]);")") $(Pq -c "$(como "$F2" "SELECT public.venda_marcar_mostrada(ARRAY['$(s a3)']::uuid[]);")") $(Pq -c "SELECT (mostrada_em = '$M1')::text || ':' || (SELECT count(*) FROM public.venda_sugestao WHERE mostrada_em IS NOT NULL) FROM public.venda_sugestao WHERE id='$(s a1)';")" \
   "0 0 true:1"

eq "T8 contato com comprador fora da carteira → 42501" \
   "$(estado "$(como "$F1" "SELECT public.venda_registrar_contato('$CX', 'nao_atendeu');")")" "42501"
eq "T8 F2 registrando comprador de F1 → 42501" \
   "$(estado "$(como "$F2" "SELECT public.venda_registrar_contato('$C', 'nao_atendeu');")")" "42501"
ID1="$(Pq -c "$(como "$F1" "SELECT public.venda_registrar_contato('$C', 'nao_atendeu');")")" || true
ID2="$(Pq -c "$(como "$F1" "SELECT public.venda_registrar_contato('$A', 'sem_interesse', '  preco alto ');")")" || true
eq "T8b carteira no id do ALIAS aceita o canônico; alias e canônico são a MESMA linha do dia; último toque vence" \
   "$([ -n "$ID1" ] && [ "$ID1" = "$ID2" ] && echo mesma || echo "difere:$ID1/$ID2") $(Pq -c "SELECT count(*)||' '||string_agg(right(comprador_id::text,2)||':'||resultado||':'||COALESCE(motivo,'-'), ',') FROM public.venda_contato;")" \
   "mesma 1 c1:sem_interesse:preco alto"
eq "T8c resultado inválido → 22023; motivo fora de sem_interesse → 22023" \
   "$(estado "$(como "$F1" "SELECT public.venda_registrar_contato('$C', 'xpto');")") $(estado "$(como "$F1" "SELECT public.venda_registrar_contato('$C', 'nao_atendeu', 'motivo');")")" \
   "22023 22023"

ACL="$(Pq -c "SELECT string_agg(r||':'||f||'='||has_function_privilege(r, f, 'EXECUTE')::text, ' ' ORDER BY f COLLATE \"C\", r COLLATE \"C\")
  FROM unnest(ARRAY['anon','public','authenticated']) r,
       unnest(ARRAY['public.venda_minhas_sugestoes(date)','public.venda_marcar_mostrada(uuid[])','public.venda_registrar_contato(uuid,text,text)',
                    'public.venda_fechar_desfechos(date)','private.venda_sync_dia_coberto(text,date)']) f;")"
eq "T9 ACL: RPCs da farmer só authenticated; job e helper fechados a todos" \
   "$(printf '%s' "$ACL" | tr ' ' '\n' | sed -E 's/^([a-z]+):[a-z]+\.venda_([a-z_]+)\(.*=(true|false)$/\1:\2=\3/' | tr '\n' ' ')" \
   "anon:sync_dia_coberto=false authenticated:sync_dia_coberto=false public:sync_dia_coberto=false anon:fechar_desfechos=false authenticated:fechar_desfechos=false public:fechar_desfechos=false anon:marcar_mostrada=false authenticated:marcar_mostrada=true public:marcar_mostrada=false anon:minhas_sugestoes=false authenticated:minhas_sugestoes=true public:minhas_sugestoes=false anon:registrar_contato=false authenticated:registrar_contato=true public:registrar_contato=false"
eq "T9b authenticated chamando o job → 42501; anon chamando RPC da farmer → 42501" \
   "$(estado "$(como "$F1" "SELECT public.venda_fechar_desfechos('2026-09-15');")") $(estado "SET ROLE anon; SELECT public.venda_minhas_sugestoes('2026-09-01');")" \
   "42501 42501"

eq "T10 RLS: F1 lê só as próprias ATIVAS (10); F2 só a dela (1); master lê tudo (14)" \
   "$(Pq -c "$(como "$F1" "SELECT count(*)||':'||bool_and(fase='ativa' AND farmer_user_id='$F1') FROM public.venda_sugestao;")") $(Pq -c "$(como "$F2" "SELECT count(*) FROM public.venda_sugestao;")") $(Pq -c "$(como "$M" "SELECT count(*) FROM public.venda_sugestao;")")" \
   "10:true 1 14"
eq "T10b escrita direta como authenticated → 42501; anon não lê config; F2 não vê contato de F1; F1 lê config" \
   "$(estado "$(como "$F1" "UPDATE public.venda_sugestao SET desfecho='virou_pedido' WHERE true;")") $(estado "SET ROLE anon; SELECT count(*) FROM public.venda_config;") $(Pq -c "$(como "$F2" "SELECT count(*) FROM public.venda_contato;")") $(Pq -c "$(como "$F1" "SELECT count(*) FROM public.venda_config;")")" \
   "42501 42501 0 5"

# ── Desfecho automático ──────────────────────────────────────────────────────────────────────────
N1="$(Pq -c "SELECT public.venda_fechar_desfechos('2026-09-15');")" || true
eq "T1 recompra fechada por pedido do ALIAS: virou_pedido, pedido a001, líquido 90" "$(estado_de a1)" "virou_pedido|-|a001|90"
eq "T1b sombra e histórico do mesmo SKU fecham igual (linha de base)" "$(estado_de ab) $(estado_de ac)" "virou_pedido|-|a001|90 virou_pedido|-|a001|90"
eq "T2 pedido cancelado não conta → nao_virou; pedido apagado não conta → nao_virou" "$(estado_de a2) $(estado_de aa)" "nao_virou|-|-|- nao_virou|-|-|-"
eq "T3 buraco de sync que nada mais cobre → nao_medivel/sync_atrasado" "$(estado_de a3)" "nao_medivel|sync_atrasado|-|-"
eq "T3c junho coberto só pelo cursor de backfill (sem fin_sync_log) → mensurável: nao_virou" "$(estado_de a9)" "nao_virou|-|-|-"
eq "T4 janelas abertas continuam NULL (recompra 09-11, complemento, preço, colacor 09-21)" \
   "$(estado_de a4) $(estado_de a5) $(estado_de a6) $(estado_de b3)" "ABERTA|-|-|- ABERTA|-|-|- ABERTA|-|-|- ABERTA|-|-|-"
eq "T4a contagem devolvida = linhas fechadas (a1 a2 a3 a9 aa ab ac f2 = 8)" "$N1" "8"
eq "T4a comprador de F2 sem pedido → nao_virou" "$(estado_de f2)" "nao_virou|-|-|-"

N2="$(Pq -c "SELECT public.venda_fechar_desfechos('2026-10-02');")" || true
eq "T4b pedido ANTES da janela não conta; complemento casa pela família no dia SP (created_at 02:00 UTC = 09-20)" \
   "$(estado_de a4) $(estado_de a5)" "nao_virou|-|-|- virou_pedido|-|a004|60"
eq "T4c preço: desconto não apurado → nao_medivel; bruto < alvo → nao_virou; líquido 45 ≥ 40×0,99 → virou" \
   "$(estado_de a6) $(estado_de a7) $(estado_de a8)" "nao_medivel|desconto_nao_apurado|-|- nao_virou|-|-|- virou_pedido|-|a001|90"
AV="$(Pq -c "SELECT avaliado_em FROM public.venda_sugestao WHERE id='$(s a1)';")" || true
eq "T4d re-rodar no mesmo dia: 0 fechadas, avaliado_em intacto" \
   "$N2:$(Pq -c "SELECT public.venda_fechar_desfechos('2026-10-02');"):$(Pq -c "SELECT (avaliado_em = '$AV')::text FROM public.venda_sugestao WHERE id='$(s a1)';")" \
   "5:0:true"

eq "T3b colacor parada desde 10-02, janela 09-21..10-04: em 10-05 ainda cobrível → ABERTA" \
   "$(Pq -c "SELECT public.venda_fechar_desfechos('2026-10-05');") $(estado_de b3)" "0 ABERTA|-|-|-"
Pq -c "INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES ('sync_pedidos', ARRAY['colacor'], 'complete', '2026-10-06 13:00+00', '2026-10-06 13:05+00');" >/dev/null
eq "T3b o sync volta em 10-06 (cobre 10-01..10-05) → mensurável: nao_virou" \
   "$(Pq -c "SELECT public.venda_fechar_desfechos('2026-10-06');") $(estado_de b3)" "1 nao_virou|-|-|-"

# ── Entrada inválida e configuração ──────────────────────────────────────────────────────────────
eq "T12 janela_dias ausente → 22023 (sem fechar nada); p_hoje NULL → 22023" \
   "$(estado "BEGIN; DELETE FROM public.venda_config WHERE chave='janela_dias'; SELECT public.venda_fechar_desfechos('2026-12-01');") $(estado "SELECT public.venda_fechar_desfechos(NULL);")" \
   "22023 22023"

# ── Cron e re-apply ──────────────────────────────────────────────────────────────────────────────
eq "T11 cron do plano tático removido; venda-fechar-desfechos 30 9 * * * chamando o job" \
   "$(Pq -c "SELECT (SELECT count(*) FROM cron.job WHERE jobname='tactical-plans-batch-nightly')||' '||string_agg(schedule||' '||command, ',') FROM cron.job WHERE jobname='venda-fechar-desfechos';")" \
   "0 30 9 * * * SELECT public.venda_fechar_desfechos();"
Pq -c "UPDATE public.venda_config SET valor='true'::jsonb WHERE chave='onda_recompra';" >/dev/null
eq "T11b re-apply: não duplica cron, não reseta onda ligada, não apaga desfecho, unschedule idempotente" \
   "$(P -q -f "$MIG_USADA" >/dev/null 2>&1 && echo reaplicou || echo FALHOU) $(Pq -c "SELECT (SELECT count(*) FROM cron.job WHERE jobname='venda-fechar-desfechos')||' '||(SELECT valor::text FROM public.venda_config WHERE chave='onda_recompra')||' '||(SELECT count(*) FROM public.venda_config)||' '||(SELECT count(*) FROM public.venda_sugestao WHERE desfecho IS NOT NULL);")" \
   "reaplicou 1 true 5 14"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-espinha"

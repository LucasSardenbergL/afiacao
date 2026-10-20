#!/usr/bin/env bash
# Prova PG17 do gerador D-1 da venda por cliente (Task 4): lista do dia, reconstrução histórica e ondas.
# Migration: supabase/migrations/20261020181743_venda_cliente_gerador.sql (a REAL), aplicada sobre as
# REAIS da espinha (20261020174221), da recompra (20261020150000) e de route_city_norm (20260611150000).
# Oráculo da paridade de cidades: src/lib/whatsapp/route-schedule.ts + route-city.ts
# (via scripts/venda-cidades-alvo-esperado.ts sobre db/fixtures/venda-cidades-alvo.json).
#
#   8   paridade venda_cidades_alvo × resolvePrepForWorkday (sex→sáb sem rota, dom→seg, feriado
#       cancelado, override sem cancelamento, inativa, diária deduplicada) e UF do cadastro × normalizeCityKey
#   1   atrasado em cidade de amanhã entra com "entrega amanhã em <Cidade>"; UF divergente não casa;
#       carteira no id do ALIAS conta para o comprador canônico
#   2   atrasado fora da rota entra só entre os `teto` maiores (valor ausente vai para o fim)
#   3   comprador perdido não entra          4   dono não-farmer (founder) e carteira inelegível não geram
#   5   rodar 2× o mesmo dia → mesma contagem, 2ª rodada insere 0
#   6   cron: onda_recompra=false → sombra; true → ativa; guards 22023
#   6b  Onda 1: 2 dias idênticos não ligam; dia divergente no meio não liga; sombra gravada a posteriori
#       não conta; 364 dias de histórico não bastam; 3 dias + 365 ligam e gravam o log; nunca desliga.
#       Onda 2 (≥80% contatados por farmer nas 2 semanas) e Onda 3 (repasse vigente, tabela ausente/
#       com outra forma = falso sem erro)
#   7   reconstrução de um dia passado usa só pedidos anteriores (pedido posterior não muda a lista) e
#       fecha o desfecho como virou_pedido
#   A   ACL/RLS: funções fechadas a anon/authenticated (has_function_privilege + chamada real 42501),
#       tabelas novas só master lê
#
#   bash db/test-venda-gerador.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-venda-gerador.sh      # o outro locale (rode os dois)
#   SABOTAGEM=<nome> bash db/test-venda-gerador.sh               # tem de ficar VERMELHA
#   bash db/test-venda-gerador.sh --falsificar                   # controle verde + cada sabotagem vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020181743_venda_cliente_gerador.sql"
MIG_ESPINHA="$REPO_ROOT/supabase/migrations/20261020174221_venda_cliente_espinha.sql"
MIG_RECOMPRA="$REPO_ROOT/supabase/migrations/20261020150000_venda_cliente_recompra.sql"
MIG_CITY_NORM="$REPO_ROOT/supabase/migrations/20260611150000_route_city_norm.sql"
FIXTURE="$REPO_ROOT/db/fixtures/venda-cidades-alvo.json"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> (`!MARCA` = a postcondição da própria migration aborta com MARCA).
  SABOTAGENS="sem_perdido:3 sem_teto:2 sem_papel_farmer:4 uf_ignorada:1b carteira_sem_alias:1c sem_override:8a rota_dia_errado:8a uf_sem_parenteses:8b duplica:5 onda1_dois_dias:6b.a onda1_ignora_divergencia:6b.b onda1_sombra_tardia:6b.c onda1_sem_historico:6b.d onda2_sem_taxa:6b.g onda3_sem_captura:6b.j acl_aberta:!G2_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-venda-gerador.XXXXXX")"
  echo "══ CONTROLE (mesma invocação, locale ${LOCALE_TESTE:-C}) ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1 || ! grep -q "FIM-OK venda-gerador" "$LOGDIR/controle.log"; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
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
      !*) padrao="${a#!}"; padrao="${padrao//_/ }" ;;
      *)  padrao="FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5498}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-venda-gerador.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
ESPERADO="$WORK/esperado.json"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
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
  sem_perdido)        sabotar "     WHERE r.atrasado
       AND s.situacao <> 'perdido'" "     WHERE r.atrasado" ;;
  sem_teto)           sabotar "WHERE r.pos <= (v_teto #>> '{}')::int" "WHERE true" ;;
  sem_papel_farmer)   sabotar "AND cr.commercial_role = 'farmer'" "" ;;
  uf_ignorada)        sabotar "WHERE al.uf = '' OR private.venda_city_uf(v.city) = '' OR private.venda_city_uf(v.city) = al.uf" "WHERE true" ;;
  carteira_sem_alias) sabotar "SELECT DISTINCT c.owner_user_id AS farmer, COALESCE(ca.canonical_user_id, c.customer_user_id) AS comprador" \
                              "SELECT DISTINCT c.owner_user_id AS farmer, c.customer_user_id AS comprador" ;;
  sem_override)       sabotar "WHERE o.data = p_dia + 1 AND o.cancela_rota" "WHERE false" ;;
  rota_dia_errado)    sabotar "extract(dow FROM p_dia + 1)" "extract(dow FROM p_dia)" ;;
  uf_sem_parenteses)  sabotar "RETURN substring(s FROM '\(([A-Z]{2})\)\s*\$');" "RETURN '';" ;;
  duplica)            sabotar "  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;" "  ;
  GET DIAGNOSTICS v_n = ROW_COUNT;" ;;
  onda1_dois_dias)    sabotar "FOR i IN 1..3 LOOP" "FOR i IN 1..2 LOOP" ;;
  onda1_ignora_divergencia) sabotar "v_c1 := v_c1 AND v_rodou AND v_diverg = 0;" "v_c1 := v_c1 AND v_rodou;" ;;
  onda1_sombra_tardia) sabotar "AND (e.primeira_em AT TIME ZONE 'America/Sao_Paulo')::date = v_d)" ")" ;;
  onda1_sem_historico) sabotar "v_c1 := v_hist_dias >= 365;" "v_c1 := true;" ;;
  onda2_sem_taxa)     sabotar "v_sem_ok := v_n_farmers > 0 AND v_min_taxa >= 0.8;" "v_sem_ok := v_n_farmers > 0;" ;;
  onda3_sem_captura)  sabotar "      EXCEPTION WHEN undefined_column OR undefined_table THEN
        v_repasse := false;
        v_repasse_erro := SQLSTATE;
      END;" "      END;" ;;
  acl_aberta)         sabotar "REVOKE ALL ON FUNCTION public.venda_gerar_lista(date, text) FROM PUBLIC, anon, authenticated;" "SELECT 1;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

# Esperado pelo oráculo TS — ANTES de subir o banco (falha aqui não deixa postgres órfão).
( cd "$REPO_ROOT" && bun scripts/venda-cidades-alvo-esperado.ts "$FIXTURE" "$ESPERADO" )

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como() { # $1 = uid, $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}
PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

F1=00000000-0000-0000-0000-0000000000f1; F2=00000000-0000-0000-0000-0000000000f2; M=00000000-0000-0000-0000-0000000000ee
R1=00000000-0000-0000-0000-000000000c01; C=00000000-0000-0000-0000-000000000c02; A=00000000-0000-0000-0000-000000000a02
RTO=00000000-0000-0000-0000-000000000c03; O2=00000000-0000-0000-0000-000000000c04; O3=00000000-0000-0000-0000-000000000c05
O4=00000000-0000-0000-0000-000000000c06; PD=00000000-0000-0000-0000-000000000c07; MX=00000000-0000-0000-0000-000000000c08
R2=00000000-0000-0000-0000-000000000c09; NE=00000000-0000-0000-0000-000000000c0a

# ── Esquema mínimo com as colunas de prod usadas (medido via psql-ro em 2026-10-20) ─────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA private;
GRANT USAGE ON SCHEMA private TO anon, authenticated, service_role;   -- como em prod
-- Default privileges do Supabase: relação e função novas NASCEM abertas (a migration tem de REVOGAR).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
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
CREATE FUNCTION cron.unschedule(p_jobname text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job ''%''', p_jobname; END IF;
  RETURN true;
END $$;

CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
CREATE TABLE public.commercial_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, phone text,
  razao_social text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.customer_canonical_alias (alias_user_id uuid PRIMARY KEY, canonical_user_id uuid NOT NULL, status text NOT NULL);
CREATE TABLE public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true);
CREATE TABLE public.customer_visit_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL,
  farmer_id uuid, city text, state text);
CREATE TABLE public.route_schedule (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), weekday smallint NOT NULL, city text NOT NULL,
  uf text NOT NULL, is_daily boolean NOT NULL, ativo boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.route_calendar_override (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), data date NOT NULL,
  cancela_rota boolean NOT NULL, motivo text, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, status text,
  account text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, order_date_kpi date);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, descricao text,
  familia text, account text, UNIQUE (omie_codigo_produto, account));
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE CASCADE, customer_user_id uuid,
  product_id uuid, omie_codigo_produto bigint, quantity numeric, unit_price numeric, desconto_valor numeric);
CREATE TABLE public.fin_sync_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, companies text[],
  status text, started_at timestamptz, completed_at timestamptz);
CREATE TABLE public.vendas_sync_cursor (account text, date_from date, date_to date, completed_at timestamptz, falhou_em timestamptz);

-- Âncora: D = hoje(SP) − 20 (a reconstrução exige dia passado; as janelas de 14 dias já venceram).
CREATE TABLE t_cfg AS SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 20) AS d,
                             (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje;
CREATE FUNCTION t_ped(p_cli uuid, p_dia date, p_cod bigint, p_qtd numeric DEFAULT 10, p_preco numeric DEFAULT 10,
                      p_desc numeric DEFAULT 0, p_conta text DEFAULT 'oben')
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE v uuid := gen_random_uuid();
BEGIN
  INSERT INTO public.sales_orders (id, customer_user_id, account, status, order_date_kpi, created_at)
  VALUES (v, p_cli, p_conta, 'faturado', p_dia, (p_dia + time '15:00') AT TIME ZONE 'UTC');
  INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price, desconto_valor)
  VALUES (v, p_cod, p_qtd, p_preco, p_desc);
END $f$;
-- 3 compras a cada 30 dias terminando em D−90 → due_ratio 3 em D (atrasado), não perdido.
CREATE FUNCTION t_atrasado(p_cli uuid, p_cod bigint, p_preco numeric, p_desc numeric DEFAULT 0, p_fim int DEFAULT 90)
RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d date := (SELECT t.d FROM t_cfg t);
BEGIN
  PERFORM t_ped(p_cli, d - p_fim - 60, p_cod, 10, p_preco, p_desc);
  PERFORM t_ped(p_cli, d - p_fim - 30, p_cod, 10, p_preco, p_desc);
  PERFORM t_ped(p_cli, d - p_fim,      p_cod, 10, p_preco, p_desc);
END $f$;
SQL

echo "── migrations reais: route_city_norm → recompra → espinha (pré-requisitos) ──"
P -q -f "$MIG_CITY_NORM" >/dev/null
P -q -1 -f "$MIG_RECOMPRA"
P -q -1 -f "$MIG_ESPINHA"

# ── 8. Paridade de cidades e UF × TS (antes do mundo do gerador) ────────────────────────────────────
echo "── 8: paridade SQL × TS ──"
P -q -f "$MIG_USADA"   # 1º apply (só para a paridade; o mundo do gerador vem depois e re-aplica)
P -q -v esperado="$ESPERADO" -v fixture="$FIXTURE" <<'SQL'
CREATE TABLE t_esp AS SELECT pg_read_file(:'esperado')::jsonb AS j;
CREATE TABLE t_fx  AS SELECT pg_read_file(:'fixture')::jsonb AS j;
INSERT INTO public.route_schedule (weekday, city, uf, is_daily, ativo)
SELECT (e->>'weekday')::smallint, e->>'city', e->>'uf', (e->>'is_daily')::boolean, (e->>'ativo')::boolean
  FROM t_fx, jsonb_array_elements(j->'schedule') e;
INSERT INTO public.route_calendar_override (data, cancela_rota)
SELECT (e->>'data')::date, (e->>'cancela_rota')::boolean FROM t_fx, jsonb_array_elements(j->'overrides') e;
CREATE TABLE t_par_alvo AS
  SELECT w::date AS workday, a.city_norm AS city, a.uf
    FROM t_fx, jsonb_array_elements_text(j->'workdays') w, public.venda_cidades_alvo(w::date) a;
CREATE TABLE t_par_alvo_esp AS
  SELECT (e->>'workday')::date AS workday, e->>'city' AS city, e->>'uf' AS uf
    FROM t_esp, jsonb_array_elements(j->'alvo') e;
CREATE TABLE t_par_cad AS
  SELECT e->>'raw' AS raw, e->>'city' AS city_esp, e->>'uf' AS uf_esp,
         public.route_city_norm(e->>'raw') AS city_sql, private.venda_city_uf(e->>'raw') AS uf_sql
    FROM t_esp, jsonb_array_elements(j->'cadastro') e;
SQL
eq "8a cidades-alvo SQL = TS (diferença simétrica)" "$(Pq -c "
  SELECT count(*) FROM ((SELECT * FROM t_par_alvo EXCEPT ALL SELECT * FROM t_par_alvo_esp)
                  UNION ALL (SELECT * FROM t_par_alvo_esp EXCEPT ALL SELECT * FROM t_par_alvo)) x")" "0"
eq "8a paridade não-vazia (22 cidades-alvo)" "$(Pq -c "SELECT count(*) FROM t_par_alvo")" "22"
eq "8a sex→sáb: só diárias (rota de segunda não é preparada na sexta)" \
   "$(Pq -c "SELECT string_agg(city, ',' ORDER BY city) FROM t_par_alvo WHERE workday = '2026-09-04'")" "CARMO DO CAJURU,DIVINOPOLIS"
eq "8a dom→seg: rota de segunda" \
   "$(Pq -c "SELECT string_agg(city, ',' ORDER BY city) FROM t_par_alvo WHERE workday = '2026-09-06'")" "BETIM,CARMO DO CAJURU,DIVINOPOLIS"
eq "8a feriado (override cancela terça): só diárias" \
   "$(Pq -c "SELECT string_agg(city, ',' ORDER BY city) FROM t_par_alvo WHERE workday = '2026-09-07'")" "CARMO DO CAJURU,DIVINOPOLIS"
eq "8a override sem cancelamento mantém a rota de sexta" \
   "$(Pq -c "SELECT count(*) FROM t_par_alvo WHERE workday = '2026-09-10' AND city IN ('OLIVEIRA','PALMAS','SANTA CRUZ DE MINAS')")" "3"
eq "8b cidade e UF do cadastro SQL = normalizeCityKey" "$(Pq -c "
  SELECT count(*) FROM t_par_cad
   WHERE city_sql IS DISTINCT FROM city_esp OR (city_esp IS NOT NULL AND uf_sql IS DISTINCT FROM uf_esp)")" "0"
eq "8b paridade de cadastro com UF dos 3 formatos" "$(Pq -c "
  SELECT count(*) FROM t_par_cad WHERE uf_esp IN ('MG','TO')")" "7"

# ── Mundo do gerador ────────────────────────────────────────────────────────────────────────────────
P -q <<SQL
TRUNCATE public.route_schedule, public.route_calendar_override;
-- Rota de D+1: CLÁUDIO/MG; diária: DIVINÓPOLIS/MG.
INSERT INTO public.route_schedule (weekday, city, uf, is_daily, ativo)
SELECT extract(dow FROM d + 1)::smallint, 'CLAUDIO', 'MG', false, true FROM t_cfg
UNION ALL SELECT 0, 'DIVINOPOLIS', 'MG', true, true;
INSERT INTO public.user_roles VALUES ('$F1','employee'), ('$F2','employee'), ('$M','master');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('$F1','farmer'), ('$F2','farmer'), ('$M','master');
INSERT INTO public.customer_canonical_alias VALUES ('$A', '$C', 'active');
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES
  ('$R1','$F1',true), ('$A','$F1',true), ('$RTO','$F1',true), ('$O2','$F1',true), ('$O3','$F1',true), ('$O4','$F1',true),
  ('$PD','$F1',true), ('$NE','$F1',false), ('$MX','$M',true), ('$R2','$F2',true);
INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id, city) VALUES
  ('$R1','$F1','Cláudio/MG'), ('$A','$F1','CLAUDIO MG'), ('$RTO','$F1','Divinópolis (TO)'), ('$O2','$F1','Betim/MG'),
  ('$PD','$F1','Cláudio'), ('$NE','$F1','Cláudio/MG'), ('$MX','$M','Cláudio/MG'), ('$R2','$F2','Claudio (MG)');
-- R1: SKU 100 atrasado (100) + SKU 101 em dia. C: comprou pelo ALIAS A (200). RTO: 1000, fora da rota (UF TO).
SELECT t_atrasado('$R1', 100, 10);
SELECT t_ped('$R1', d - 40, 101), t_ped('$R1', d - 25, 101), t_ped('$R1', d - 10, 101) FROM t_cfg;
SELECT t_atrasado('$A', 200, 20);
SELECT t_atrasado('$RTO', 300, 100);
SELECT t_atrasado('$O2', 310, 50);
SELECT t_atrasado('$O3', 320, 10);
SELECT t_atrasado('$O4', 330, 10, NULL);      -- desconto não apurado → valor ausente (NULL), vai para o fim
SELECT t_atrasado('$PD', 400, 10, 0, 470);    -- última compra há 470 dias → perdido
SELECT t_atrasado('$NE', 410, 10);            -- carteira inelegível
SELECT t_atrasado('$MX', 500, 10);            -- carteira do founder (papel comercial master)
SELECT t_atrasado('$R2', 600, 10);            -- farmer 2, na rota
-- Sync de vendas coberto todo dia (oben), para o desfecho poder fechar.
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at)
SELECT 'sync_pedidos', ARRAY['oben'], 'complete', (g::date + time '13:00') AT TIME ZONE 'UTC', (g::date + time '13:05') AT TIME ZONE 'UTC'
  FROM t_cfg, generate_series(d - 700, hoje + 1, interval '1 day') g;
UPDATE public.venda_config SET valor = '2'::jsonb WHERE chave = 'teto_maiores_atrasos';
SQL

echo "── migration de novo (idempotência, com dados) ──"
P -q -f "$MIG_USADA"
eq "idempotência: re-apply não liga onda" "$(Pq -c "SELECT count(*) FROM public.venda_config WHERE chave LIKE 'onda_%' AND valor = 'true'::jsonb")" "0"

D="$(Pq -c "SELECT d FROM t_cfg")"
HOJE="$(Pq -c "SELECT hoje FROM t_cfg")"
echo "D=$D hoje=$HOJE"

# ── 7. Reconstrução de D: só pedidos anteriores; pedido posterior fecha virou_pedido ────────────────
P -q -c "CREATE TABLE t_snap AS SELECT * FROM private.venda_lista_calc('$D')"
P -q -c "SELECT t_ped('$R1', '$D'::date + 2, 100, 10, 10)"   # pedido DEPOIS de D do SKU atrasado
eq "7 reconstrução devolve linhas inseridas" "$(Pq -c "SELECT public.venda_reconstruir_historico('$D', '$D')")" "5"
eq "7 pedido posterior não muda a lista (historico = calculado antes do pedido)" "$(Pq -c "
  SELECT count(*) FROM ((SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, motivo_entrada FROM t_snap
                         EXCEPT SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, motivo_entrada
                                  FROM public.venda_sugestao WHERE fase = 'historico' AND dia_referencia = '$D')
                  UNION ALL
                        (SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, motivo_entrada
                           FROM public.venda_sugestao WHERE fase = 'historico' AND dia_referencia = '$D'
                         EXCEPT SELECT farmer_user_id, comprador_id, empresa, omie_codigo_produto, motivo_entrada FROM t_snap)) x")" "0"
eq "7 pedido posterior fecha virou_pedido" "$(Pq -c "
  SELECT desfecho FROM public.venda_sugestao WHERE fase = 'historico' AND dia_referencia = '$D' AND comprador_id = '$R1'")" "virou_pedido"
eq "7 demais fecham nao_virou (sync coberto)" "$(Pq -c "
  SELECT string_agg(DISTINCT desfecho, ',') FROM public.venda_sugestao
   WHERE fase = 'historico' AND dia_referencia = '$D' AND comprador_id <> '$R1'")" "nao_virou"
eq "7 execução registrada" "$(Pq -c "SELECT linhas FROM public.venda_gerador_execucao WHERE dia_referencia = '$D' AND fase = 'historico'")" "5"

H="fase = 'historico' AND dia_referencia = '$D'"
# ── 1. Cidade de amanhã ─────────────────────────────────────────────────────────────────────────────
eq "1 atrasado na cidade de amanhã entra com o motivo" \
   "$(Pq -c "SELECT motivo_entrada FROM public.venda_sugestao WHERE $H AND comprador_id = '$R1'")" "entrega amanhã em Claudio"
eq "1 só o SKU atrasado vira linha (101 em dia não)" \
   "$(Pq -c "SELECT string_agg(omie_codigo_produto::text, ',') FROM public.venda_sugestao WHERE $H AND comprador_id = '$R1'")" "100"
eq "1 valor e quantidade de referência" \
   "$(Pq -c "SELECT qtd_ref::numeric(10,2) || '|' || valor_ref::numeric(10,2) FROM public.venda_sugestao WHERE $H AND comprador_id = '$R1'")" "10.00|100.00"
eq "1b UF divergente (Divinópolis/TO × rota MG) não casa a cidade" \
   "$(Pq -c "SELECT motivo_entrada FROM public.venda_sugestao WHERE $H AND comprador_id = '$RTO'")" "maior atraso da carteira"
eq "1c carteira no ALIAS conta para o canônico, na rota" \
   "$(Pq -c "SELECT farmer_user_id || '|' || motivo_entrada FROM public.venda_sugestao WHERE $H AND comprador_id = '$C'")" "$F1|entrega amanhã em Claudio"
eq "1c nenhuma linha no id do alias" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE comprador_id = '$A'")" "0"
eq "1 farmer 2 recebe o seu comprador da rota" \
   "$(Pq -c "SELECT farmer_user_id FROM public.venda_sugestao WHERE $H AND comprador_id = '$R2'")" "$F2"

# ── 2. Teto dos maiores atrasos (só fora da rota) ──────────────────────────────────────────────────
eq "2 fora da rota entram só os 2 maiores" "$(Pq -c "
  SELECT string_agg(comprador_id::text, ',' ORDER BY valor_ref DESC) FROM public.venda_sugestao
   WHERE $H AND motivo_entrada = 'maior atraso da carteira'")" "$RTO,$O2"
eq "2 o 3º maior e o sem preço ficam fora" "$(Pq -c "
  SELECT count(*) FROM public.venda_sugestao WHERE $H AND comprador_id IN ('$O3','$O4')")" "0"
P -q -c "UPDATE public.venda_config SET valor = '4'::jsonb WHERE chave = 'teto_maiores_atrasos'"
eq "2 sem preço vai para o FIM do ranking (ausente ≠ zero), nunca some" "$(Pq -c "
  SELECT string_agg(comprador_id::text || ':' || COALESCE(valor_ref::numeric(12,2)::text, 'null'), ',' ORDER BY comprador_id)
    FROM private.venda_lista_calc('$D') WHERE motivo_entrada = 'maior atraso da carteira' AND comprador_id IN ('$O3','$O4')")" \
   "$O3:100.00,$O4:null"
P -q -c "UPDATE public.venda_config SET valor = '1'::jsonb WHERE chave = 'teto_maiores_atrasos'"
eq "2 teto 1 → só o maior; a rota não é cortada pelo teto" "$(Pq -c "
  SELECT count(*) FILTER (WHERE motivo_entrada = 'maior atraso da carteira') || '|' ||
         count(*) FILTER (WHERE motivo_entrada LIKE 'entrega%') FROM private.venda_lista_calc('$D')")" "1|3"
P -q -c "UPDATE public.venda_config SET valor = '2'::jsonb WHERE chave = 'teto_maiores_atrasos'"

# ── 3/4. Perdido, founder e inelegível fora ─────────────────────────────────────────────────────────
eq "3 comprador perdido não entra (mesmo atrasado e na rota)" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE comprador_id = '$PD'")" "0"
eq "4 dono não-farmer (founder) não gera linhas" "$(Pq -c "
  SELECT count(*) FROM public.venda_sugestao WHERE farmer_user_id = '$M' OR comprador_id = '$MX'")" "0"
eq "4 carteira inelegível não entra" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE comprador_id = '$NE'")" "0"

# ── 5. Rodar 2× o mesmo dia ─────────────────────────────────────────────────────────────────────────
eq "5 2ª rodada sem erro" "$(estado "SELECT public.venda_gerar_lista('$D', 'historico')")" "verde"
eq "5 2ª rodada insere 0" "$(Pq -c "SELECT public.venda_gerar_lista('$D', 'historico')")" "0"
eq "5 mesma contagem" "$(Pq -c "SELECT count(*) FROM public.venda_sugestao WHERE $H")" "5"

# ── 6. Guards + cron sombra → ativa ─────────────────────────────────────────────────────────────────
eq "6 ativa com onda desligada → 22023" "$(estado "SELECT public.venda_gerar_lista('$HOJE', 'ativa')")" "22023"
eq "6 historico de hoje → 22023" "$(estado "SELECT public.venda_gerar_lista('$HOJE', 'historico')")" "22023"
eq "6 fase inválida → 22023" "$(estado "SELECT public.venda_gerar_lista('$D', 'xyz')")" "22023"
eq "6 reconstrução até hoje → 22023" "$(estado "SELECT public.venda_reconstruir_historico('$D', '$HOJE')")" "22023"
P -q -c "UPDATE public.venda_config SET valor = '\"dez\"'::jsonb WHERE chave = 'teto_maiores_atrasos'"
eq "6 teto inválido → 22023 (não vira 0 nem ilimitado)" "$(estado "SELECT public.venda_gerar_lista('$D', 'sombra')")" "22023"
P -q -c "UPDATE public.venda_config SET valor = '2'::jsonb WHERE chave = 'teto_maiores_atrasos'"
CRON_CMD="$(Pq -c "SELECT command FROM cron.job WHERE jobname = 'venda-gerador' AND schedule = '15 8 * * *' AND active")"
eq "6 cron venda-gerador 08:15 UTC" "$([ -n "$CRON_CMD" ] && echo ok)" "ok"
P -q -c "$CRON_CMD" >/dev/null
eq "6 onda_recompra=false → sombra" "$(Pq -c "
  SELECT (count(*) FILTER (WHERE fase = 'sombra') > 0) || '|' || count(*) FILTER (WHERE fase = 'ativa')
    FROM public.venda_sugestao WHERE dia_referencia = '$HOJE'")" "true|0"
P -q -c "UPDATE public.venda_config SET valor = 'true'::jsonb WHERE chave = 'onda_recompra'"
P -q -c "$CRON_CMD" >/dev/null
eq "6 onda_recompra=true → ativa (mesma lista)" "$(Pq -c "
  SELECT (count(*) FILTER (WHERE fase = 'ativa') > 0 AND count(*) FILTER (WHERE fase = 'ativa') = count(*) FILTER (WHERE fase = 'sombra'))
    FROM public.venda_sugestao WHERE dia_referencia = '$HOJE'")" "t"
# Limpa o "hoje" e volta a onda — o 6b começa do zero.
P -q <<SQL
DELETE FROM public.venda_sugestao WHERE dia_referencia = '$HOJE';
DELETE FROM public.venda_gerador_execucao WHERE dia_referencia = '$HOJE';
UPDATE public.venda_config SET valor = 'false'::jsonb WHERE chave = 'onda_recompra';
DELETE FROM public.venda_onda_log;
SQL

# ── 6b. Ondas ───────────────────────────────────────────────────────────────────────────────────────
ondas() { Pq -c "SELECT public.venda_avaliar_ondas('$D')" >/dev/null; }
onda() { Pq -c "SELECT valor FROM public.venda_config WHERE chave = '$1'"; }
logs() { Pq -c "SELECT count(*) FROM public.venda_onda_log WHERE onda = '$1'"; }
sombra_ao_vivo() { # $1 = dia: gera a sombra e carimba a 1ª execução às 05:15 SP DAQUELE dia (como o cron)
  Pq -c "SELECT public.venda_gerar_lista('$1', 'sombra')" >/dev/null
  P -q -c "UPDATE public.venda_gerador_execucao SET primeira_em = ('$1'::date + time '05:15') AT TIME ZONE 'America/Sao_Paulo'
            WHERE dia_referencia = '$1' AND fase = 'sombra'"
}
DM1="$(Pq -c "SELECT d - 1 FROM t_cfg")"; DM2="$(Pq -c "SELECT d - 2 FROM t_cfg")"; DM3="$(Pq -c "SELECT d - 3 FROM t_cfg")"
# Reconstrução de 365 dias "carregada" (as linhas são do registro de execução — o gerador já foi provado acima).
P -q -c "INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas)
         SELECT g::date, 'historico', 1 FROM t_cfg, generate_series(d - 365, d - 1, interval '1 day') g
         ON CONFLICT DO NOTHING"
sombra_ao_vivo "$DM1"; sombra_ao_vivo "$DM2"
ondas
eq "6b.a 2 dias idênticos → Onda 1 continua desligada" "$(onda onda_recompra)|$(logs onda_recompra)" "false|0"
sombra_ao_vivo "$DM3"
P -q -c "DELETE FROM public.venda_sugestao WHERE ctid = (SELECT ctid FROM public.venda_sugestao
          WHERE fase = 'sombra' AND dia_referencia = '$DM2' ORDER BY comprador_id LIMIT 1)"
eq "6b.b dia divergente no meio → não liga" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_recompra,condicao,dias,1,divergencias}'")|$(onda onda_recompra)" "1|false"
Pq -c "SELECT public.venda_gerar_lista('$DM2', 'sombra')" >/dev/null            # repõe a linha; primeira_em fica
P -q -c "UPDATE public.venda_gerador_execucao SET primeira_em = ('$D'::date + time '05:15') AT TIME ZONE 'America/Sao_Paulo'
          WHERE dia_referencia = '$DM1' AND fase = 'sombra'"
ondas
eq "6b.c sombra gravada a posteriori não conta como lista ao vivo" "$(onda onda_recompra)" "false"
sombra_ao_vivo "$DM1"
P -q -c "DELETE FROM public.venda_gerador_execucao WHERE fase = 'historico' AND dia_referencia = '$D'::date - 365"
eq "6b.d 364 dias de histórico não bastam" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_recompra,condicao,historico_dias}'")|$(onda onda_recompra)" "364|false"
P -q -c "INSERT INTO public.venda_gerador_execucao (dia_referencia, fase, linhas) VALUES ('$D'::date - 365, 'historico', 1)"
eq "6b.e 3 dias idênticos + 365 de histórico → liga" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_recompra,ligou_agora}'")|$(onda onda_recompra)|$(logs onda_recompra)" "true|true|1"
eq "6b.e log guarda a condição atendida" "$(Pq -c "SELECT condicao->>'historico_dias' || '|' || jsonb_array_length(condicao->'dias') FROM public.venda_onda_log WHERE onda = 'onda_recompra'")" "365|3"
P -q -c "DELETE FROM public.venda_sugestao WHERE fase = 'sombra' AND dia_referencia = '$DM1'"
ondas
eq "6b.f nunca desliga (divergência depois de ligada)" "$(onda onda_recompra)|$(logs onda_recompra)" "true|1"

# Onda 2: listas ATIVAS nas 2 semanas completas antes de D, e contatos.
P -q <<SQL
SELECT public.venda_gerar_lista(g::date, 'ativa')
  FROM t_cfg, generate_series(date_trunc('week', d)::date - 14, date_trunc('week', d)::date - 1, interval '1 day') g;
INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado)
SELECT DISTINCT s.farmer_user_id, s.comprador_id, date_trunc('week', s.dia_referencia)::date, 'nao_atendeu'
  FROM public.venda_sugestao s, t_cfg
 WHERE s.fase = 'ativa' AND s.dia_referencia >= date_trunc('week', d)::date - 14 AND s.dia_referencia < date_trunc('week', d)::date;
-- F1 deixa de contatar 2 compradores na semana mais antiga → < 80% naquela semana.
DELETE FROM public.venda_contato c USING t_cfg
 WHERE c.farmer_user_id = '$F1' AND c.dia = date_trunc('week', d)::date - 14 AND c.comprador_id IN ('$RTO','$O2');
SQL
eq "6b.g Onda 2: semana com farmer abaixo de 80% → não liga" \
   "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_complemento,ligada}'")|$(onda onda_complemento)" "false|false"
P -q -c "INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado)
         SELECT '$F1', x, date_trunc('week', d)::date - 14, 'vai_pedir' FROM t_cfg, unnest(ARRAY['$RTO','$O2']::uuid[]) x"
eq "6b.h Onda 2: ≥ 80% por farmer nas 2 semanas → liga" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_complemento,ligou_agora}'")|$(onda onda_complemento)|$(logs onda_complemento)" "true|true|1"

# Onda 3: tabela da Task 6 ausente / com outra forma / vencida / vigente.
eq "6b.i Onda 3 sem a tabela de repasse → falso, sem erro" \
   "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_preco,condicao,repasse_indisponivel}'")|$(onda onda_preco)" "tabela_ausente|false"
P -q -c "CREATE TABLE public.venda_repasse_aprovado (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), outra_coisa int)"
eq "6b.j Onda 3 com tabela de outra forma → falso, sem erro (cron segue)" \
   "$(estado "SELECT public.venda_avaliar_ondas('$D')")|$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_preco,condicao,repasse_indisponivel}'" 2>/dev/null || true)|$(onda onda_preco)" "verde|42703|false"
P -q <<SQL
DROP TABLE public.venda_repasse_aprovado;
CREATE TABLE public.venda_repasse_aprovado (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comprador_id uuid, empresa text,
  omie_codigo_produto bigint, preco_alvo numeric NOT NULL, valido_ate date NOT NULL, revogado_em timestamptz);
INSERT INTO public.venda_repasse_aprovado (comprador_id, empresa, omie_codigo_produto, preco_alvo, valido_ate, revogado_em) VALUES
  ('$R1', 'oben', 100, 11, '$D'::date - 1, NULL),       -- vencido
  ('$R1', 'oben', 100, 11, '$D'::date + 30, now());     -- revogado
SQL
eq "6b.k Onda 3: repasse vencido ou revogado não conta" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_preco,condicao,repasse_vigente}'")|$(onda onda_preco)" "false|false"
P -q -c "INSERT INTO public.venda_repasse_aprovado (comprador_id, empresa, omie_codigo_produto, preco_alvo, valido_ate)
         VALUES ('$R1', 'oben', 100, 11, '$D'::date + 30)"
eq "6b.l Onda 3: repasse vigente + Onda 2 ligada → liga" "$(Pq -c "SELECT public.venda_avaliar_ondas('$D') #>> '{onda_preco,ligou_agora}'")|$(onda onda_preco)|$(logs onda_preco)" "true|true|1"

# ── A. ACL e RLS ────────────────────────────────────────────────────────────────────────────────────
eq "A funções fechadas a anon/authenticated/PUBLIC" "$(Pq -c "
  SELECT count(*) FROM unnest(ARRAY['public.venda_cidades_alvo(date)','public.venda_gerar_lista(date,text)',
       'public.venda_reconstruir_historico(date,date)','public.venda_avaliar_ondas(date)',
       'private.venda_lista_calc(date)','private.venda_city_uf(text)']) f, unnest(ARRAY['anon','authenticated','public']) r
   WHERE has_function_privilege(r, f, 'EXECUTE')")" "0"
eq "A farmer chamando o gerador → 42501" "$(estado "$(como "$F1" "SELECT public.venda_gerar_lista('$D', 'historico')")")" "42501"
eq "A farmer chamando avaliar_ondas → 42501" "$(estado "$(como "$F1" "SELECT public.venda_avaliar_ondas('$D')")")" "42501"
eq "A farmer não lê execuções nem log de ondas" "$(Pq -c "$(como "$F1" "SELECT (SELECT count(*) FROM public.venda_gerador_execucao) + (SELECT count(*) FROM public.venda_onda_log)")")" "0"
eq "A master lê o log das ondas" "$(Pq -c "$(como "$M" "SELECT count(*) FROM public.venda_onda_log")")" "3"
eq "A farmer não escreve no log" "$(estado "$(como "$F1" "INSERT INTO public.venda_onda_log (onda, condicao) VALUES ('onda_preco', '{}')")")" "42501"

echo "PASS=$PASS FAIL=$FAIL"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK venda-gerador (locale $LOC)"

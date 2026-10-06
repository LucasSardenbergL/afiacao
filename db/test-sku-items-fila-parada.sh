#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — sensor POR FORA da fila do omie-sync-sku-items                     ║
# ║  (v_sku_items_fila + sku_items_fila_parada_check + cron :52 — 20261006004500)     ║
# ║  bash db/test-sku-items-fila-parada.sh > "$TMPDIR/t.log" 2>&1; echo "exit=$?"    ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)  LOCALE_PROVA=C (default) | pt_BR.UTF-8  ║
# ║                                                                                  ║
# ║  A MIGRATION É A REAL, aplicada em UMA transação (-1, como o db:aplicar): a      ║
# ║  postcondição dela roda aqui também, inclusive a sonda que EXECUTA o sensor.     ║
# ║  As tabelas são stubs com a forma MEDIDA em prod (2026-10-05/06, psql-ro):       ║
# ║  colunas usadas, NOT NULL, os CHECKs de fin_alertas/fornecedor_alerta e o índice ║
# ║  único parcial — o ramo que ABRE o alerta só roda em prod quando houver fila     ║
# ║  parada, então é aqui que ele é exercido contra as constraints de lá.            ║
# ║                                                                                  ║
# ║  O QUE PROVA:                                                                    ║
# ║   C0  CONTROLE do verde falso (§7 do histórico do #2539), com o                  ║
# ║       fin_sync_watchdog_check REAL: pagina 2 `error` seguidos (C0a — o harness   ║
# ║       enxerga positivo), NÃO pagina [07:00 error "fila não anda", 08:35          ║
# ║       complete] (C0b) — e no MESMO estado o sensor novo abre o alerta (C0c)      ║
# ║   B1–B12 o predicado: limiar estrito de 48h, backoff 6/24/72h, piso             ║
# ║       GREATEST(created_at,t2), por RECEBIMENTO com a irmã mais antiga, CT-e     ║
# ║       fora (parser estrito), recebimento com linha fora, janela de 30d, só OBEN, ║
# ║       nIdReceb pela coluna OU pelo raw_data (dual-read da edge)                  ║
# ║   B13 o #2801 (itens_pendentes) lido por to_jsonb: a coluna ADICIONADA depois    ║
# ║       da view passa a valer sem recriá-la (k=0 sai, k>0 conta)                   ║
# ║   E1–E6 o episódio: abre 1× com 1 e-mail, não reenvia, resolve sozinho          ║
# ║       (dismissed_at+resolvido_em), reabre com e-mail novo, silenciado não        ║
# ║       reenvia, encerrado à mão reabre, não toca alerta de outro tipo             ║
# ║   K1–K4 catálogo: view invoker, EXECUTE fechado, claude_ro lê, cron :52         ║
# ║  FALSIFICAÇÕES: F1–F17 sabotam o comportamento (cada uma derruba um CONJUNTO      ║
# ║  EXATO); P1–P7 sabotam o que a POSTCONDIÇÃO vigia (cada uma tem de ABORTAR a     ║
# ║  migration pelo código certo, sem deixar meio-objeto).                           ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5491}"
SLUG="skufila"
LOCALE_PROVA="${LOCALE_PROVA:-C}"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"   # dir ÚNICO desta rodada (o trap apaga)
export LC_ALL="$LOCALE_PROVA" LANG="$LOCALE_PROVA"

MIG="$REPO_ROOT/supabase/migrations/20261006004500_sku_items_fila_parada_sensor.sql"
WD_MIG="$REPO_ROOT/supabase/migrations/20260704160000_fin_sync_watchdog_retry_sem_efeito.sql"
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }
[ -f "$WD_MIG" ] || { echo "migration do watchdog nao encontrada: $WD_MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_PROVA" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c autovacuum=off" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0; FALHAS=()
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); FALHAS+=("$1"); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup PG17 :$PORT (locale $LOCALE_PROVA) ==="

# ══ ZONA 1 — pré-requisitos: o que a migration LÊ mas não cria (forma medida em prod) ══
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')          THEN CREATE ROLE anon;          END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role')  THEN CREATE ROLE service_role;  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro')     THEN CREATE ROLE claude_ro;     END IF;
END $$;
-- O DEFAULT PRIVILEGES de prod para o postgres em public (pg_default_acl, medido 2026-10-05): ALL em
-- relação e EXECUTE em função para anon/authenticated/service_role, SELECT para o claude_ro. O EXECUTE
-- de PUBLIC vem do default de fábrica do PG. Sem isto o REVOKE da migration não teria o que revogar e
-- a A4/A5 passariam por vacuidade.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- pg_cron 1.6: schedule faz upsert por (nome, dono) mantendo o jobid; o dono é quem agenda.
CREATE SCHEMA cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY, jobname text, schedule text, command text,
  active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user);
CREATE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  UPDATE cron.job SET schedule = p_sched, command = p_cmd, active = true
   WHERE jobname = p_name AND username = current_user
  RETURNING jobid INTO v;
  IF v IS NULL THEN
    INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_sched, p_cmd) RETURNING jobid INTO v;
  END IF;
  RETURN v;
END $f$;

CREATE TYPE public.empresa_reposicao AS ENUM ('OBEN', 'COLACOR');
CREATE TABLE public.purchase_orders_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa public.empresa_reposicao NOT NULL,
  omie_codigo_pedido bigint NOT NULL,
  nfe_chave_acesso text,
  t2_data_faturamento timestamptz,
  nid_receb bigint,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.sku_leadtime_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id uuid NOT NULL REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  empresa public.empresa_reposicao NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_sku_hist_tracking_sku UNIQUE (tracking_id, sku_codigo_omie));
CREATE TABLE public.sku_items_sync_controle (
  tracking_id uuid PRIMARY KEY REFERENCES public.purchase_orders_tracking(id) ON DELETE CASCADE,
  tentativas integer NOT NULL CONSTRAINT sku_items_sync_controle_tentativas_check CHECK (tentativas >= 0),
  ultima_tentativa timestamptz NOT NULL,
  motivo text,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL, mensagem text NOT NULL,
  valor numeric, threshold numeric, contexto jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz, dismissed_by uuid, dismissed_until timestamptz,
  email_enfileirado_em timestamptz, acknowledged_at timestamptz, acknowledged_by uuid,
  resolvido_em timestamptz,
  CONSTRAINT fin_alertas_company_check CHECK (company = ANY (ARRAY['oben','colacor','colacor_sc'])),
  CONSTRAINT fin_alertas_severidade_check CHECK (severidade = ANY (ARRAY['info','aviso','critico'])));
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL, fornecedor_nome text, tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info', titulo text NOT NULL, mensagem text,
  status text DEFAULT 'pendente_notificacao', criado_em timestamptz DEFAULT now(),
  CONSTRAINT fornecedor_alerta_severidade_check CHECK (severidade = ANY (ARRAY['info','atencao','urgente'])),
  CONSTRAINT fornecedor_alerta_status_check CHECK (status = ANY (ARRAY['pendente_notificacao','notificado','falha_notificacao','ignorado'])),
  CONSTRAINT fornecedor_alerta_tipo_check CHECK (tipo = ANY (ARRAY['promocao_suspensa','aumento_anunciado','promocao_nova',
    'polling_erro','mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro',
    'param_auto_resumo','reposicao_pedido_minimo'])));
-- o que o fin_sync_watchdog_check REAL lê (controle C0)
CREATE TABLE public.fin_sync_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL, companies text[],
  status text DEFAULT 'running', results jsonb DEFAULT '{}'::jsonb, error_message text,
  started_at timestamptz DEFAULT now(), completed_at timestamptz);
CREATE TABLE public.fin_sync_cursor (
  company text NOT NULL, resource text NOT NULL, next_page integer, updated_at timestamptz NOT NULL DEFAULT now());

-- seeds: uma linha de tracking por chamada; o tempo é relativo ao now() da transação
CREATE FUNCTION public._id(p_n int) RETURNS uuid LANGUAGE sql IMMUTABLE AS
  $$ SELECT ('70000000-0000-0000-0000-' || lpad(p_n::text, 12, '0'))::uuid $$;
-- chave de acesso de 44 dígitos no layout SEFAZ: UF(2) AAMM(4) CNPJ(14) MODELO(2) série(3) nº(9) tpEmis(1) código(8) DV(1)
CREATE FUNCTION public._chave(p_n int, p_modelo text) RETURNS text LANGUAGE sql IMMUTABLE AS
  $$ SELECT '35' || '2609' || '12345678000199' || p_modelo || '001' || lpad(p_n::text, 9, '0') || '1' || '12345678' || '9' $$;
CREATE FUNCTION public._trk(p_n int, p_nid bigint, p_t2 interval, p_criado interval,
                            p_modelo text DEFAULT '55', p_empresa text DEFAULT 'OBEN',
                            p_raw jsonb DEFAULT NULL, p_chave text DEFAULT NULL, p_sem_chave boolean DEFAULT false)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.purchase_orders_tracking
    (id, empresa, omie_codigo_pedido, nfe_chave_acesso, t2_data_faturamento, nid_receb, raw_data, created_at)
  VALUES (public._id(p_n), p_empresa::public.empresa_reposicao, 1000 + p_n,
          CASE WHEN p_sem_chave THEN NULL ELSE coalesce(p_chave, public._chave(p_n, p_modelo)) END,
          now() + p_t2, p_nid, p_raw, now() + p_criado)
$$;
CREATE FUNCTION public._ctl(p_n int, p_tent int, p_ultima interval) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.sku_items_sync_controle (tracking_id, tentativas, ultima_tentativa, motivo)
  VALUES (public._id(p_n), p_tent, now() + p_ultima, 'ok_0_itens')
$$;
-- late-bound de propósito: só roda com a coluna do #2801 presente (cenário B13)
CREATE FUNCTION public._ctl_k(p_n int, p_tent int, p_ultima interval, p_k int) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.sku_items_sync_controle (tracking_id, tentativas, ultima_tentativa, motivo, itens_pendentes)
  VALUES (public._id(p_n), p_tent, now() + p_ultima, 'pendente', p_k);
END $$;
CREATE FUNCTION public._linha(p_n int) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.sku_leadtime_history (tracking_id, empresa, sku_codigo_omie) VALUES (public._id(p_n), 'OBEN', 4242)
$$;
SQL

# ══ ZONA 2 — o fin_sync_watchdog_check REAL (só para o controle C0) e a migration REAL ══
# Extraído da última migration que o define (repo == prod, conferido em 2026-10-05 por psql-ro).
awk '/^CREATE OR REPLACE FUNCTION public\.fin_sync_watchdog_check\(\)/{f=1} f{print} f && /^\$function\$;/{exit}' \
  "$WD_MIG" > "$RODADA/watchdog.sql"
command grep -q 'v_errs' "$RODADA/watchdog.sql" || { echo "nao extrai o fin_sync_watchdog_check de $WD_MIG"; exit 1; }
P -q -f "$RODADA/watchdog.sql"

zera() {
  P -q -c "TRUNCATE public.purchase_orders_tracking CASCADE;
           TRUNCATE public.fin_alertas, public.fornecedor_alerta, public.fin_sync_log, public.fin_sync_cursor;"
}
derruba() {
  P -q -c "DROP FUNCTION IF EXISTS public.sku_items_fila_parada_check();
           DROP VIEW IF EXISTS public.v_sku_items_fila;
           DELETE FROM cron.job WHERE jobname = 'afiacao_sku_items_fila_parada_1h';"
}
# Aplica um .sql da migration num banco SEM os objetos dela e com as tabelas vazias (a sonda A7 roda
# o ramo de fila vazia, como em prod hoje), numa transação só. Devolve o status do psql.
aplica() { derruba; zera; P -1 -q -f "$1" > "$RODADA/aplica.log" 2>&1; }
restaura() {
  aplica "$MIG" || { echo "RESTAURACAO FALHOU — a migration real nao aplica:"; head -20 "$RODADA/aplica.log"; exit 1; }
  command grep -F -q 'postcondicao OK' "$RODADA/aplica.log" \
    || { echo "RESTAURACAO SEM MARCADOR de fim da postcondicao"; head -20 "$RODADA/aplica.log"; exit 1; }
}

restaura
echo "=== migration real aplicada (postcondicao com marcador positivo de fim) ==="

roda() { P -q -c "SELECT public.sku_items_fila_parada_check();" >/dev/null 2>&1; }
ativos() { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company = 'oben' AND tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;"; }
emails() { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo = '[Sync fila] OBEN' AND status = 'pendente_notificacao';"; }
# estado de um recebimento na view: t/f (parado ou não), várias linhas viram "f,t", ausente = 'ausente'
estado() {
  Pq -c "SELECT coalesce((SELECT string_agg(CASE WHEN parado THEN 't' ELSE 'f' END, ',' ORDER BY parado)
                          FROM public.v_sku_items_fila WHERE nid_receb = '$1'), 'ausente');"
}

# ══ ZONA 3 — a suíte ══
roda_suite() {
  PASS=0; FAIL=0; FALHAS=()

  # ── K: catálogo, por fora da postcondição
  eq "K1 view lê como quem chama (invoker)" \
     "$(Pq -c "SELECT ('security_invoker=on' = ANY (coalesce(reloptions, '{}')))::text FROM pg_class WHERE oid = to_regclass('public.v_sku_items_fila');")" "true"
  eq "K2 PUBLIC/anon/authenticated nao executam o sensor" \
     "$(Pq -c "SELECT has_function_privilege('public', 'public.sku_items_fila_parada_check()', 'EXECUTE')::text || ','
                   || has_function_privilege('anon', 'public.sku_items_fila_parada_check()', 'EXECUTE')::text || ','
                   || has_function_privilege('authenticated', 'public.sku_items_fila_parada_check()', 'EXECUTE')::text;")" "false,false,false"
  eq "K3 view: anon/authenticated nao leem, claude_ro le" \
     "$(Pq -c "SELECT has_table_privilege('anon', 'public.v_sku_items_fila', 'SELECT')::text || ','
                   || has_table_privilege('authenticated', 'public.v_sku_items_fila', 'SELECT')::text || ','
                   || has_table_privilege('claude_ro', 'public.v_sku_items_fila', 'SELECT')::text;")" "false,false,true"
  eq "K4 cron :52, ativo, como postgres, chamando o sensor" \
     "$(Pq -c "SELECT schedule || '|' || active || '|' || username || '|' || command FROM cron.job WHERE jobname = 'afiacao_sku_items_fila_parada_1h';")" \
     "52 * * * *|true|postgres|SELECT public.sku_items_fila_parada_check();"

  # ── C0: o verde falso do §7, com o watchdog REAL
  zera
  P -q >/dev/null <<'SQL'
INSERT INTO public.fin_sync_log (action, companies, status, error_message, started_at, completed_at) VALUES
 ('sync_sku_items', ARRAY['oben'], 'error', 'x', now() - interval '50 minutes', now() - interval '49 minutes'),
 ('sync_sku_items', ARRAY['oben'], 'error', 'x', now() - interval '20 minutes', now() - interval '19 minutes');
SELECT public.fin_sync_watchdog_check();
SQL
  eq "C0a controle positivo: o watchdog pagina 2 error seguidos" \
     "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company = 'oben' AND tipo = 'sync_error' AND dismissed_at IS NULL;")" "1"
  zera
  P -q >/dev/null <<'SQL'
SELECT public._trk(1, 111, interval '-4 days', interval '-4 days');
INSERT INTO public.fin_sync_log (action, companies, status, error_message, results, started_at, completed_at) VALUES
 ('sync_sku_items', ARRAY['oben'], 'error',
  'fila não anda: 1 NFes elegíveis há >48h ficaram sem consulta neste run (adiadas por limite ou não alcançadas pelo guard)',
  '{"fila_parada_48h": 1}', now() - interval '95 minutes', now() - interval '94 minutes'),
 ('sync_sku_items', ARRAY['oben'], 'complete', NULL, '{"fila_parada_48h": 0}',
  now() - interval '5 minutes', now() - interval '4 minutes');
SELECT public.fin_sync_watchdog_check();
SQL
  eq "C0b verde falso: [07:00 error 'fila nao anda', 08:35 complete] NAO pagina" \
     "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company = 'oben' AND tipo = 'sync_error' AND dismissed_at IS NULL;")" "0"
  roda || true
  eq "C0c no MESMO estado o sensor novo abre o alerta" "$(ativos)" "1"

  # ── B: o predicado, num estado só (um recebimento por caso)
  zera
  P -q >/dev/null <<'SQL'
-- B1/B2: nunca tentada, piso = created_at = t2
SELECT public._trk(1, 101, interval '-3 days', interval '-3 days');
SELECT public._trk(2, 102, interval '-47 hours', interval '-47 hours');
-- B4: backoff 6/24/72h — faturada e nascida há 10 dias (o piso diria "parado" para todas)
SELECT public._trk(41, 401, interval '-10 days', interval '-10 days'); SELECT public._ctl(41, 1, interval '-53 hours');
SELECT public._trk(42, 402, interval '-10 days', interval '-10 days'); SELECT public._ctl(42, 1, interval '-55 hours');
SELECT public._trk(43, 403, interval '-10 days', interval '-10 days'); SELECT public._ctl(43, 2, interval '-71 hours');
SELECT public._trk(44, 404, interval '-10 days', interval '-10 days'); SELECT public._ctl(44, 2, interval '-73 hours');
SELECT public._trk(45, 405, interval '-10 days', interval '-10 days'); SELECT public._ctl(45, 5, interval '-119 hours');
SELECT public._trk(46, 406, interval '-10 days', interval '-10 days'); SELECT public._ctl(46, 5, interval '-121 hours');
-- B5: em backoff (tentada há 1h, 3ª tentativa)
SELECT public._trk(50, 500, interval '-10 days', interval '-10 days'); SELECT public._ctl(50, 3, interval '-1 hour');
-- B6: o piso é o MAIOR entre nascimento e faturamento
SELECT public._trk(61, 601, interval '-1 day', interval '-10 days');
SELECT public._trk(62, 602, interval '-10 days', interval '-1 day');
-- B7: irmãs do mesmo recebimento: a mais antiga decide
SELECT public._trk(71, 700, interval '-60 hours', interval '-60 hours');
SELECT public._trk(72, 700, interval '-10 hours', interval '-10 hours');
-- B8: CT-e (modelo 57) sai; chave malformada (43 dígitos) com 57 nas posições 21-22 FICA
SELECT public._trk(81, 810, interval '-3 days', interval '-3 days', '57');
SELECT public._trk(82, 820, interval '-3 days', interval '-3 days', '55', 'OBEN', NULL, left(public._chave(82, '57'), 43));
-- B9: com linha de leadtime sai; irmã sem linha de um recebimento que JÁ gravou também
SELECT public._trk(91, 910, interval '-3 days', interval '-3 days'); SELECT public._linha(91);
SELECT public._trk(92, 920, interval '-3 days', interval '-3 days'); SELECT public._linha(92);
SELECT public._trk(93, 920, interval '-3 days', interval '-3 days');
-- B10: fora da janela de 30 dias, t2 nulo, chave nula
SELECT public._trk(101, 1010, interval '-31 days', interval '-31 days');
SELECT public._trk(102, 1020, NULL, interval '-3 days');
SELECT public._trk(103, 1030, interval '-3 days', interval '-3 days', '55', 'OBEN', NULL, NULL, true);
-- B11: COLACOR não tem cron do sku-items
SELECT public._trk(111, 1110, interval '-3 days', interval '-3 days', '55', 'COLACOR');
-- B12: nIdReceb só no raw_data (dual-read); vazio e ausente não contam
SELECT public._trk(121, NULL, interval '-3 days', interval '-3 days', '55', 'OBEN', '{"cabec": {"nIdReceb": 1210}}');
SELECT public._trk(122, NULL, interval '-3 days', interval '-3 days', '55', 'OBEN', '{"cabec": {"nIdReceb": ""}}');
SELECT public._trk(123, NULL, interval '-3 days', interval '-3 days');
SQL
  eq "B1a nunca tentada, elegivel ha 72h: parado"             "$(estado 101)" "t"
  eq "B2a nunca tentada, elegivel ha 47h: nao parado"         "$(estado 102)" "f"
  eq "B4a 1a tentativa ha 53h (6h de backoff = 47h): nao"     "$(estado 401)" "f"
  eq "B4b 1a tentativa ha 55h (6h de backoff = 49h): parado"  "$(estado 402)" "t"
  eq "B4c 2a tentativa ha 71h (24h = 47h): nao"               "$(estado 403)" "f"
  eq "B4d 2a tentativa ha 73h (24h = 49h): parado"            "$(estado 404)" "t"
  eq "B4e 5a tentativa ha 119h (72h = 47h): nao"              "$(estado 405)" "f"
  eq "B4f 5a tentativa ha 121h (72h = 49h): parado"           "$(estado 406)" "t"
  eq "B5a em backoff: nao parado"                             "$(estado 500)" "f"
  eq "B5b em backoff: elegivel_desde no futuro" \
     "$(Pq -c "SELECT (elegivel_desde > now())::text FROM public.v_sku_items_fila WHERE nid_receb = '500';")" "true"
  eq "B6a criada ha 10d, faturada ha 1d: piso = 1d, nao parado" "$(estado 601)" "f"
  eq "B6b faturada ha 10d, criada ha 1d: piso = 1d, nao parado" "$(estado 602)" "f"
  eq "B7a irmas = 1 recebimento" \
     "$(Pq -c "SELECT count(*) FROM public.v_sku_items_fila WHERE nid_receb = '700';")" "1"
  eq "B7b irmas: a mais antiga (60h) decide"                  "$(estado 700)" "t"
  eq "B7c irmas: 2 linhas pendentes" \
     "$(Pq -c "SELECT string_agg(linhas_pendentes::text, ',') FROM public.v_sku_items_fila WHERE nid_receb = '700';")" "2"
  eq "B8a CT-e (modelo 57) fora da fila"                      "$(estado 810)" "ausente"
  eq "B8b chave malformada com 57 fica (parser estrito)"     "$(estado 820)" "t"
  eq "B9a com linha de leadtime: fora"                        "$(estado 910)" "ausente"
  eq "B9b recebimento que ja gravou: irma sem linha fora"    "$(estado 920)" "ausente"
  eq "B10a faturada ha 31 dias: fora da janela"               "$(estado 1010)" "ausente"
  eq "B10b t2 nulo: fora"                                     "$(estado 1020)" "ausente"
  eq "B10c chave nula: fora"                                  "$(estado 1030)" "ausente"
  eq "B11a COLACOR: fora"                                     "$(estado 1110)" "ausente"
  eq "B12a nIdReceb so no raw_data: conta"                    "$(estado 1210)" "t"
  eq "B12b nIdReceb vazio/ausente nao vira recebimento" \
     "$(Pq -c "SELECT count(*) FROM public.v_sku_items_fila WHERE nid_receb IS NULL OR nid_receb = '';")" "0"

  # ── B3: o limiar é ESTRITO — 48h exatas (o now() da MESMA transação) não contam
  zera
  eq "B3a 48h exatas nao conta, 48h01s conta" "$(P -tA -q <<'SQL'
BEGIN;
DO $$ BEGIN
  PERFORM public._trk(31, 310, interval '-48 hours', interval '-48 hours');
  PERFORM public._trk(32, 320, interval '-48 hours -1 second', interval '-48 hours -1 second');
END $$;
SELECT string_agg(nid_receb || '=' || CASE WHEN parado THEN 't' ELSE 'f' END, ',' ORDER BY nid_receb)
  FROM public.v_sku_items_fila;
COMMIT;
SQL
)" "310=f,320=t"

  # ── B13: o #2801 (itens_pendentes) chega DEPOIS da view; lida por to_jsonb, passa a valer sozinha
  zera
  P -q -c "ALTER TABLE public.sku_items_sync_controle ADD COLUMN itens_pendentes integer;"
  P -q >/dev/null <<'SQL'
SELECT public._trk(131, 1310, interval '-10 days', interval '-10 days'); SELECT public._ctl_k(131, 3, interval '-6 days', 0);
SELECT public._trk(132, 1320, interval '-10 days', interval '-10 days'); SELECT public._ctl_k(132, 3, interval '-6 days', 2);
SELECT public._trk(133, 1330, interval '-10 days', interval '-10 days'); SELECT public._ctl_k(133, 3, interval '-6 days', NULL);
SELECT public._trk(134, 1340, interval '-10 days', interval '-10 days'); SELECT public._ctl_k(134, 3, interval '-6 days', 3);
SELECT public._linha(134);
SELECT public._trk(135, 1350, interval '-10 days', interval '-10 days');
SELECT public._trk(136, 1350, interval '-10 days', interval '-10 days'); SELECT public._ctl_k(136, 3, interval '-6 days', 0);
SQL
  eq "B13a k=0 sem linha (medido completo): fora"             "$(estado 1310)" "ausente"
  eq "B13b k=2 sem linha: conta"                              "$(estado 1320)" "t"
  eq "B13c k nulo (nao medido): regra legada, conta"          "$(estado 1330)" "t"
  eq "B13d k=3 COM linha (incompleto): nao e fila parada"    "$(estado 1340)" "ausente"
  eq "B13e irma k=0 nao esconde a irma pendente"              "$(estado 1350)" "t"
  zera
  P -q -c "ALTER TABLE public.sku_items_sync_controle DROP COLUMN itens_pendentes;"

  # ── E: o episódio
  zera
  P -q -c "SELECT public._trk(201, 2010, interval '-3 days', interval '-3 days');" >/dev/null
  if roda; then ok "E1g 1a rodada sem erro"; else bad "E1g 1a rodada sem erro"; fi
  eq "E1a abre 1 alerta"                                      "$(ativos)" "1"
  eq "E1b severidade aviso, empresa oben" \
     "$(Pq -c "SELECT severidade || '|' || company FROM public.fin_alertas WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;")" "aviso|oben"
  eq "E1c 1 e-mail enfileirado"                               "$(emails)" "1"
  eq "E1d a mensagem diz o recebimento" \
     "$(Pq -c "SELECT (mensagem LIKE '%nIdReceb 2010,%')::text FROM public.fin_alertas WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;")" "true"
  eq "E1e contexto: parados e o denominador" \
     "$(Pq -c "SELECT (contexto->>'recebimentos_parados') || '|' || (contexto->>'recebimentos_na_fila') FROM public.fin_alertas WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;")" "1|1"
  eq "E1f carimbo do e-mail" \
     "$(Pq -c "SELECT (email_enfileirado_em IS NOT NULL)::text FROM public.fin_alertas WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;")" "true"
  if roda; then ok "E2c 2a rodada sem erro"; else bad "E2c 2a rodada sem erro"; fi
  eq "E2a segue 1 alerta"                                     "$(ativos)" "1"
  eq "E2b nao reenvia o e-mail"                               "$(emails)" "1"
  P -q -c "SELECT public._linha(201);" >/dev/null
  roda || true
  eq "E3a resolvido: nenhum ativo"                            "$(ativos)" "0"
  eq "E3b resolucao da MAQUINA (resolvido_em + dismissed_at)" \
     "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo = 'sync_sku_items_fila_parada' AND resolvido_em IS NOT NULL AND dismissed_at IS NOT NULL;")" "1"
  P -q -c "SELECT public._trk(202, 2020, interval '-3 days', interval '-3 days');" >/dev/null
  roda || true
  eq "E4a reabre"                                             "$(ativos)" "1"
  eq "E4b com e-mail novo"                                    "$(emails)" "2"
  P -q -c "UPDATE public.fin_alertas SET dismissed_until = now() + interval '7 days' WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;"
  if roda; then ok "E5d rodada com alerta silenciado sem erro"; else bad "E5d rodada com alerta silenciado sem erro"; fi
  eq "E5a silenciado: nao reenvia"                            "$(emails)" "2"
  eq "E5b silenciado: segue 1 ativo"                          "$(ativos)" "1"
  P -q -c "UPDATE public.fin_alertas SET dismissed_at = now() WHERE tipo = 'sync_sku_items_fila_parada' AND dismissed_at IS NULL;"
  roda || true
  eq "E5c encerrado a mao com a fila ainda parada: reabre com e-mail" "$(emails)" "3"
  P -q -c "INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem) VALUES ('oben', 'sync_error', 'critico', 'outro tipo');
           SELECT public._linha(202);" >/dev/null
  roda || true
  eq "E6a a resolucao nao toca alerta de outro tipo" \
     "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo = 'sync_error' AND dismissed_at IS NULL;")" "1"
  eq "E6b o proprio tipo fecha"                               "$(ativos)" "0"
}

echo "=== BASELINE (migration real) ==="
roda_suite
BASE_PASS=$PASS; BASE_FAIL=$FAIL
echo "--- baseline: $BASE_PASS ok / $BASE_FAIL falhas ---"
if [ "$BASE_FAIL" -ne 0 ]; then
  echo "BASELINE VERMELHO — a migration real nao passa. Falhas: ${FALHAS[*]}"
  echo "PASS=$BASE_PASS  FAIL=$BASE_FAIL"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — sabota UMA âncora da migration e exige o conjunto EXATO de asserts vermelhos.
# A sabotagem prova que APLICOU (âncora única, texto novo presente, postcondição verde) antes de
# medir: "não casou nada" lido como "o assert não tem dente" é o teatro que isto evita.
# ══════════════════════════════════════════════════════════════════════════════
FALSIF_ERR=0

gera_sabotada() {   # $1=destino $2=busca $3=troca — âncora tem de ser ÚNICA
  python3 - "$MIG" "$1" "$2" "$3" <<'PY'
import sys
src, dst, busca, troca = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(src, encoding="utf-8").read()
n = s.count(busca)
if n != 1:
    sys.stderr.write("ANCORA NAO UNICA (%d ocorrencias)\n" % n); sys.exit(3)
open(dst, "w", encoding="utf-8").write(s.replace(busca, troca))
PY
}

sabota_e_mede() {   # $1=rótulo $2=busca $3=troca $4..=asserts esperados
  local rot="$1" busca="$2" troca="$3"; shift 3
  local esperado="$*" sab="$RODADA/sab_${rot}.sql"
  if ! gera_sabotada "$sab" "$busca" "$troca"; then
    echo "  FALSIF XX  $rot: ancora nao casou — INVALIDA, nao leia como 'sem dente'"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi
  if ! aplica "$sab"; then
    echo "  FALSIF XX  $rot: a migration sabotada NAO APLICOU — INVALIDA:"; head -5 "$RODADA/aplica.log"
    FALSIF_ERR=$((FALSIF_ERR+1)); restaura; return
  fi
  roda_suite > "$RODADA/suite_${rot}.log" 2>&1 || true
  local caidos="" esp
  if [ "${#FALHAS[@]}" -gt 0 ]; then
    for f in "${FALHAS[@]}"; do caidos="$caidos $(printf '%s' "$f" | awk '{print $1}')"; done
  fi
  # `|| true`: lista vazia faz o grep devolver 1, e vazio é resultado LEGÍTIMO a reportar
  caidos="$(printf '%s' "$caidos" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')" || true
  esp="$(printf '%s' "$esperado" | tr ' ' '\n' | command grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')" || true
  if [ -n "$caidos" ] && [ "$caidos" = "$esp" ]; then
    echo "  FALSIF OK  $rot derrubou EXATAMENTE [$caidos]"
  else
    echo "  FALSIF XX  $rot: esperado [$esp], veio [$caidos]"
    FALSIF_ERR=$((FALSIF_ERR+1))
  fi
  restaura
}

# A postcondição: a migration sabotada TEM de abortar pelo assert certo, e não deixar nada para trás.
sabota_pos() {   # $1=rótulo $2=busca $3=troca $4=marcador ASCII esperado na saída do erro
  local rot="$1" busca="$2" troca="$3" marca="$4" sab="$RODADA/sabpos_${1}.sql" sobra
  if ! gera_sabotada "$sab" "$busca" "$troca"; then
    echo "  FALSIF XX  $rot: ancora nao casou — INVALIDA"
    FALSIF_ERR=$((FALSIF_ERR+1)); return
  fi
  if aplica "$sab"; then
    echo "  FALSIF XX  $rot: a migration sabotada APLICOU — a postcondicao nao mordeu"
    FALSIF_ERR=$((FALSIF_ERR+1))
  elif command grep -F -q -- "$marca" "$RODADA/aplica.log"; then
    sobra="$(Pq -c "SELECT (to_regclass('public.v_sku_items_fila') IS NOT NULL
                       OR to_regprocedure('public.sku_items_fila_parada_check()') IS NOT NULL
                       OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'afiacao_sku_items_fila_parada_1h'))::text;")"
    if [ "$sobra" = "false" ]; then
      echo "  FALSIF OK  $rot abortou com [$marca] e nao deixou meio-objeto"
    else
      echo "  FALSIF XX  $rot: abortou, mas sobrou objeto da migration"
      FALSIF_ERR=$((FALSIF_ERR+1))
    fi
  else
    echo "  FALSIF XX  $rot: abortou por OUTRO motivo (esperado [$marca]):"; head -5 "$RODADA/aplica.log"
    FALSIF_ERR=$((FALSIF_ERR+1))
  fi
  restaura
}

echo "=== FALSIFICACOES (comportamento) ==="
sabota_e_mede F1 "c.ultima_tentativa + CASE c.tentativas" "c.ultima_tentativa + 0 * CASE c.tentativas" \
  B4a B4c B4e B5b
sabota_e_mede F2 "WHEN COALESCE(c.tentativas, 0) > 0 THEN" "WHEN false THEN" \
  B4a B4c B4e B5a B5b
sabota_e_mede F3 "ELSE GREATEST(j.created_at, j.t2_data_faturamento)" "ELSE j.created_at" \
  B6a
sabota_e_mede F4 "ELSE GREATEST(j.created_at, j.t2_data_faturamento)" "ELSE j.t2_data_faturamento" \
  B6b
sabota_e_mede F5 "(now() - min(p.elegivel_desde) > interval '48 hours')" "(now() - min(p.elegivel_desde) >= interval '48 hours')" \
  B3a
sabota_e_mede F6 "WHERE NOT (j.nfe_chave_acesso ~ '^[0-9]{44}\$' AND substr(j.nfe_chave_acesso, 21, 2) = '57')" "WHERE true" \
  B8a
sabota_e_mede F7 "WHERE t.empresa = 'OBEN'" "WHERE true" \
  B11a
sabota_e_mede F8 "AND t.t2_data_faturamento >= now() - interval '30 days'" "AND t.t2_data_faturamento IS NOT NULL" \
  B10a
sabota_e_mede F9 "GROUP BY p.nid_receb;" "GROUP BY p.nid_receb, p.t2_data_faturamento;" \
  B7a B7b B7c
sabota_e_mede F10 "(now() - min(p.elegivel_desde) > interval '48 hours')" "(now() - max(p.elegivel_desde) > interval '48 hours')" \
  B7b
sabota_e_mede F11 "AND NOT EXISTS (SELECT 1 FROM janela j2 WHERE j2.nid_receb = p.nid_receb AND j2.tem_linha)" "AND true" \
  B9b B13d
sabota_e_mede F12 "AND CASE WHEN m.itens_pendentes IS NOT NULL THEN m.itens_pendentes > 0 ELSE NOT j.tem_linha END" "AND NOT j.tem_linha" \
  B13a
sabota_e_mede F13 "SET dismissed_at = now(), resolvido_em = now()" "SET mensagem = mensagem" \
  E3a E3b E4b E5a E5c E6b
sabota_e_mede F14 "ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;" ";" \
  E2c E5d
sabota_e_mede F15 "COALESCE(t.nid_receb::text, NULLIF(t.raw_data -> 'cabec' ->> 'nIdReceb', ''))" "t.nid_receb::text" \
  B12a
sabota_e_mede F16 "j.nfe_chave_acesso ~ '^[0-9]{44}\$' AND " "" \
  B8b
sabota_e_mede F17 "IF FOUND THEN" "IF false THEN" \
  E1c E2b E4b E5a E5c

echo "=== FALSIFICACOES (postcondicao) ==="
sabota_pos P1 "WITH (security_invoker = on)" "WITH (security_invoker = off)" "A1 FALHOU"
sabota_pos P2 "REVOKE ALL ON FUNCTION public.sku_items_fila_parada_check() FROM PUBLIC, anon, authenticated;" \
  "-- (sabotado: sem o REVOKE da funcao)" "A4 FALHOU"
sabota_pos P3 "'52 * * * *'," "'*/30 * * * *'," "A6 FALHOU"
sabota_pos P4 "UPDATE public.fin_alertas" "UPDATE public.fin_alertas_sabotada" "fin_alertas_sabotada"
sabota_pos P5 "LANGUAGE plpgsql
SECURITY DEFINER" "LANGUAGE plpgsql
SECURITY INVOKER" "A3 FALHOU"
sabota_pos P6 "REVOKE ALL ON TABLE public.v_sku_items_fila FROM PUBLIC, anon, authenticated;" \
  "REVOKE ALL ON TABLE public.v_sku_items_fila FROM PUBLIC, anon, authenticated, claude_ro;" "A5 FALHOU"
sabota_pos P7 "min(p.t2_data_faturamento) AS t2_min" "min(p.t2_data_faturamento) AS t2_mais_antigo" "A2 FALHOU"

# ══ fecho: re-roda a suíte na versão REAL e exige verde ══
echo "=== VERIFICACAO FINAL (migration real restaurada) ==="
roda_suite
echo "--- final: $PASS ok / $FAIL falhas | falsificacoes invalidas/erradas: $FALSIF_ERR ---"
# Recibo lido pelo db/roda-nucleo-ci.sh. Falsificação inválida entra no FAIL de propósito: prova sem
# dente não pode sair com FAIL=0.
echo "PASS=$PASS  FAIL=$((FAIL + FALSIF_ERR))"
if [ "$FAIL" -ne 0 ] || [ "$FALSIF_ERR" -ne 0 ] || [ "$PASS" -ne "$BASE_PASS" ]; then
  echo "RESULTADO: VERMELHO"
  exit 1
fi
echo "RESULTADO: VERDE — $PASS asserts + 17 falsificacoes de comportamento + 7 de postcondicao"

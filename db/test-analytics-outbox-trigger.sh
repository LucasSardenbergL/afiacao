#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260829041500_analytics_outbox_trigger_sensor.sql                   ║
# ║      bash db/test-analytics-outbox-trigger.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                       ║
# ║                                                                                ║
# ║  O que esta prova existe para pegar, em ordem de gravidade:                     ║
# ║   1. O SENSOR LER O EIXO ERRADO. O incidente de 2026-08-26 deixou 105/105       ║
# ║      linhas com tentativas=0, ultimo_erro=NULL, quarentena_em=NULL por 32h —    ║
# ║      qualquer check que leia a máquina de retry fica VERDE no apagão inteiro.   ║
# ║      A falsificação F1 troca o eixo por `tentativas>=8` e EXIGE vermelho.       ║
# ║   2. AS DUAS METADES DO SENTINELA SE DESCOLAREM. Check no compute sem entrada   ║
# ║      em `v_sources` = alerta que nunca dispara; o inverso = rodada incompleta.  ║
# ║      B1 roda o watchdog REAL e cobra o marcador de sucesso; F5 sabota o compute.║
# ║   3. A LÁPIDE NÃO SER ATÔMICA COM O DELETE, ou contar o caminho feliz.          ║
# ║   4. plpgsql late-bound: `analytics_outbox_purgar` e `data_health_watchdog`     ║
# ║      passam no CREATE com SQL inválido e só quebram EXECUTANDO — atrás de um    ║
# ║      cron cujo `job_run_details=succeeded` esconderia o erro para sempre.       ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="analytics-outbox-trigger"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

MAE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
PERDA="$REPO_ROOT/supabase/migrations/20260829012000_analytics_outbox_perda_visivel.sql"
MIG="$REPO_ROOT/supabase/migrations/20260829041500_analytics_outbox_trigger_sensor.sql"
for f in "$MAE" "$PERDA" "$MIG"; do [ -f "$f" ] || { echo "migration ausente: $f"; exit 1; }; done

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ O ALTER DEFAULT PRIVILEGES reproduz o que o Supabase faz no schema public, e é
# o que dá TRABALHO REAL ao `REVOKE ... FROM authenticated`. Sem ele, o assert do
# REVOKE passaria por VACUIDADE — verde por ausência de grant, não por defesa.
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL
);

CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES ((SELECT coalesce(max(jobid), 0) + 1 FROM cron.job), p_name, p_sched, p_cmd, true)
  RETURNING jobid;
$f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE sql AS $f$ DELETE FROM cron.job WHERE jobname = p_name RETURNING true; $f$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
SQL

# ── As tabelas que `_data_health_compute` LÊ ──────────────────────────────────
# ⚠️ DDL GERADA DA PROD (pg_attribute/format_type via psql-ro, 2026-08-29), não
# escrita à mão e não tirada do `schema-snapshot.sql`. O snapshot tem drift
# conhecido — 5 dos 8 harnesses data-health do repo já estão vermelhos por causa
# dele (nota no cabeçalho de db/test-data-health-watchdog-reemissao.sh) — e
# amarrar esta prova a ele herdaria a podridão. Enums viram `text`: nenhum check
# compara enum, e criar os tipos só para isso é superfície sem assert.
#
# ⚠️ Elas existem para o compute REAL poder ser criado e EXECUTADO. `LANGUAGE sql`
# é validada no CREATE: sem estas 19, a função nem nasce — e é justamente isso que
# prova que o meu `UNION ALL` está bem enxertado (aridade e tipos das 11 colunas).
P -q <<'SQL'
-- ⚠️ `private` nao vem do db/stubs-supabase.sql: o compute le a MV de metricas
-- de cliente de la, e sem o schema a funcao nem e criada (LANGUAGE sql valida no CREATE).
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.customer_metrics_mv (customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamp with time zone, dias_desde_ultima_compra integer, pedidos_90d bigint, faturamento_90d numeric, ticket_medio_90d numeric, faturamento_prev_90d numeric, intervalo_medio_dias numeric, atraso_relativo numeric, is_cold_start boolean, calculated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.carteira_assignments (id uuid, customer_user_id uuid, owner_user_id uuid, source text, omie_account text, omie_codigo_vendedor bigint, eligible boolean, valid_from timestamp with time zone, updated_at timestamp with time zone, last_synced_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger (user_id uuid, identity_state text, first_seen_at timestamp with time zone, source text, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.data_health_watchdog_estado (id boolean, last_run_at timestamp with time zone, last_success_at timestamp with time zone, checks_avaliados integer, checks_falhos integer, ultimo_erro text, atualizado_em timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.farmer_client_scores (id uuid, customer_user_id uuid, farmer_id uuid, rf_score numeric, m_score numeric, g_score numeric, x_score numeric, s_score numeric, health_score numeric, health_class text, churn_risk numeric, recover_score numeric, expansion_score numeric, eff_score numeric, priority_score numeric, days_since_last_purchase integer, avg_repurchase_interval numeric, avg_monthly_spend_180d numeric, gross_margin_pct numeric, category_count integer, answer_rate_60d numeric, whatsapp_reply_rate_60d numeric, revenue_potential numeric, calculated_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, signal_modifiers jsonb, last_signal_recalc_at timestamp with time zone, sales_history_status text, itens_com_custo bigint, itens_sem_custo bigint);
CREATE TABLE IF NOT EXISTS public.fin_alertas (id uuid, company text, tipo text, severidade text, mensagem text, valor numeric(15,2), threshold numeric(15,2), contexto jsonb, criado_em timestamp with time zone, dismissed_at timestamp with time zone, dismissed_by uuid, dismissed_until timestamp with time zone, email_enfileirado_em timestamp with time zone, acknowledged_at timestamp with time zone, acknowledged_by uuid, resolvido_em timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.fin_contas_correntes (id uuid, company text, omie_ncodcc bigint, descricao text, banco text, agencia text, numero_conta text, tipo text, saldo_data date, saldo_atual numeric(15,2), ativo boolean, created_at timestamp with time zone, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.fin_contas_pagar (id uuid, company text, omie_codigo_lancamento bigint, omie_codigo_cliente_fornecedor bigint, nome_fornecedor text, cnpj_cpf text, numero_documento text, numero_documento_fiscal text, data_emissao date, data_vencimento date, data_pagamento date, data_previsao date, valor_documento numeric(15,2), valor_pago numeric(15,2), valor_desconto numeric(15,2), valor_juros numeric(15,2), valor_multa numeric(15,2), saldo numeric(15,2), status_titulo text, categoria_codigo text, categoria_descricao text, departamento text, centro_custo text, observacao text, omie_ncodcc bigint, codigo_barras text, tipo_documento text, id_origem text, metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.fin_contas_receber (id uuid, company text, omie_codigo_lancamento bigint, omie_codigo_cliente bigint, nome_cliente text, cnpj_cpf text, numero_documento text, numero_documento_fiscal text, numero_pedido text, data_emissao date, data_vencimento date, data_recebimento date, data_previsao date, valor_documento numeric(15,2), valor_recebido numeric(15,2), valor_desconto numeric(15,2), valor_juros numeric(15,2), valor_multa numeric(15,2), saldo numeric(15,2), status_titulo text, categoria_codigo text, categoria_descricao text, departamento text, centro_custo text, observacao text, omie_ncodcc bigint, vendedor_id bigint, tipo_documento text, id_origem text, metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.fin_sync_log (id uuid, action text, companies text[], status text, results jsonb, error_message text, triggered_by text, started_at timestamp with time zone, completed_at timestamp with time zone, duracao_ms integer, entidades_por_empresa jsonb, api_calls integer, rate_limits_hit integer);
CREATE TABLE IF NOT EXISTS public.fornecedor_alerta (id bigint, empresa text, fornecedor_nome text, tipo text, severidade text, titulo text, mensagem text, campanha_id bigint, aumento_id bigint, email_origem_id text, visualizado boolean, visualizado_em timestamp with time zone, resolvido boolean, resolvido_em timestamp with time zone, resolvido_por text, email_enviado boolean, email_enviado_em timestamp with time zone, calendar_evento_id text, criado_em timestamp with time zone, tipo_alerta text, fornecedor_id uuid, data_evento timestamp with time zone, duracao_minutos integer, status text, gmail_message_id text, erro_notificacao text, tentativas integer, notificado_em timestamp with time zone, metadata jsonb);
CREATE TABLE IF NOT EXISTS public.inventory_position (id uuid, omie_codigo_produto bigint, product_id uuid, saldo numeric, cmc numeric, preco_medio numeric, account text, synced_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.omie_customer_account_map (id uuid, user_id uuid, account text, omie_codigo_cliente bigint, omie_codigo_vendedor bigint, source text, created_at timestamp with time zone, updated_at timestamp with time zone, evidence_document_normalized text);
CREATE TABLE IF NOT EXISTS public.omie_products (id uuid, omie_codigo_produto bigint, omie_codigo_produto_integracao text, codigo text, descricao text, unidade text, ncm text, valor_unitario numeric, estoque numeric, ativo boolean, imagem_url text, metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, familia text, subfamilia text, account text, is_tintometric boolean, tint_type text, tipo_produto text);
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (id bigint, empresa text, fornecedor_nome text, grupo_codigo text, data_ciclo date, horario_geracao timestamp with time zone, horario_corte_planejado timestamp with time zone, horario_disparo_real timestamp with time zone, valor_total numeric, num_skus integer, valor_mes_ate_agora numeric, pedido_anterior_valor numeric, delta_vs_anterior_perc numeric, status text, mensagem_bloqueio text, canal_usado text, resposta_canal jsonb, omie_pedido_compra_id text, omie_pedido_compra_numero text, omie_registrado_em timestamp with time zone, aprovado_por text, aprovado_em timestamp with time zone, cancelado_por text, cancelado_em timestamp with time zone, justificativa_cancelamento text, criado_em timestamp with time zone, atualizado_em timestamp with time zone, condicao_pagamento_codigo text, condicao_pagamento_descricao text, num_parcelas integer, dias_parcelas text, condicao_origem text, tipo_ciclo text, origem_evento_id bigint, origem_evento_tipo text, status_envio_portal text, enviado_portal_em timestamp with time zone, portal_protocolo text, portal_resposta jsonb, portal_screenshot_url text, portal_tentativas integer, portal_proximo_retry_em timestamp with time zone, portal_erro text, portal_data_entrega date, split_parent_id bigint, split_lote integer, split_total integer, omie_po_inexistente_antes_de timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.product_costs (id uuid, product_id uuid, cost_price numeric, updated_at timestamp with time zone, cmc numeric, cost_source text, cost_confidence numeric, family_category text, cost_final numeric, custo_producao numeric, custo_producao_source text, custo_producao_status text, custo_producao_computed_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.sku_estoque_atual (empresa text, sku_codigo_omie text, estoque_fisico numeric, estoque_disponivel numeric, estoque_pendente_entrada numeric, ultima_sincronizacao timestamp with time zone, fonte_sync text);
CREATE TABLE IF NOT EXISTS public.sku_parametros (id uuid, empresa text, sku_codigo_omie bigint, sku_descricao text, fornecedor_codigo_omie bigint, fornecedor_nome text, classe_abc character(1), classe_xyz character(1), classe_consolidada text, classe_forcada text, motivo_classe_forcada text, classe_proposta_pendente text, meses_consecutivos_nova_classe integer, data_ultima_mudanca_classe date, demanda_media_diaria numeric, demanda_desvio_padrao numeric, demanda_coef_variacao numeric, demanda_dias_com_movimento integer, demanda_total_90d numeric, valor_vendido_90d numeric, lt_medio_dias_uteis numeric, lt_desvio_padrao_dias numeric, lt_p95_dias numeric, lt_n_observacoes integer, fonte_leadtime text, z_score numeric, estoque_seguranca numeric, ponto_pedido numeric, estoque_minimo numeric, cobertura_alvo_dias integer, estoque_maximo numeric, lote_minimo_fornecedor numeric, ativo boolean, aplicar_no_omie boolean, ultima_aplicacao_omie timestamp with time zone, ultima_atualizacao_calculo timestamp with time zone, estoque_minimo_omie numeric, ponto_pedido_omie numeric, estoque_maximo_omie numeric, omie_ultima_sincronizacao timestamp with time zone, aprovado_em timestamp with time zone, aprovado_por text, justificativa_aprovacao text, demanda_multiplicador_override numeric, motivo_override text, override_validade_ate date, override_criado_em timestamp with time zone, override_criado_por text, habilitado_reposicao_automatica boolean, tipo_reposicao text, minimo_forcado_manual numeric, parametro_cold_start boolean);
CREATE TABLE IF NOT EXISTS public.sync_state (id uuid, entity_type text, account text, last_sync_at timestamp with time zone, last_page integer, last_cursor text, total_synced integer, status text, error_message text, metadata jsonb, created_at timestamp with time zone, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.tint_skus (id uuid, account text, produto_id uuid, base_id uuid, embalagem_id uuid, omie_product_id uuid, imposto_pct numeric, margem_pct numeric, codigo_etiqueta text, ativo boolean, created_at timestamp with time zone, updated_at timestamp with time zone);
SQL

P -q <<'SQL'
ALTER TABLE public.pedido_compra_sugerido ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.pedido_compra_sugerido ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY;
ALTER TABLE public.data_health_watchdog_estado ALTER COLUMN id SET NOT NULL;
ALTER TABLE public.data_health_watchdog_estado ALTER COLUMN id SET DEFAULT true;
ALTER TABLE public.data_health_watchdog_estado ADD PRIMARY KEY (id);
INSERT INTO public.data_health_watchdog_estado (id, last_run_at, last_success_at)
VALUES (true, now() - interval '1 hour', now() - interval '1 hour');

-- Stub das DUAS funções auxiliares que o compute cita em texto de e-mail.
CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(p_limite int)
RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'LISTA-FAMILIA'::text $f$;
CREATE OR REPLACE FUNCTION public._tint_cobertura_bases_lista_email(p_limite int)
RETURNS text LANGUAGE sql STABLE AS $f$ SELECT 'LISTA-TINT'::text $f$;

-- Stub de `_data_health_episodio`: é PRÉ-REQUISITO, não objeto sob teste (a
-- migration não o toca). Grava em fin_alertas o suficiente para B2 provar que o
-- alerta do check novo CHEGA — que é a pergunta, e não como ele é despachado.
CREATE OR REPLACE FUNCTION public._data_health_episodio(
  p_company text, p_tipo text, p_status text, p_sev_fin text, p_titulo text,
  p_msg text, p_msg_email text, p_ctx jsonb, p_fingerprint text)
RETURNS void LANGUAGE sql AS $f$
  INSERT INTO public.fin_alertas (id, company, tipo, severidade, mensagem, contexto, criado_em)
  VALUES (gen_random_uuid(), p_company, p_tipo, p_sev_fin, p_msg,
          coalesce(p_ctx,'{}'::jsonb) || jsonb_build_object('_fp', p_fingerprint), now());
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION-MÃE + MIGRATION REAL (Lei #1: nada de stub da lógica)
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ A CADEIA inteira, na ordem real. Aplicar só a desta prova recriaria o compute a
# partir de uma base que em prod NÃO existe mais — e o assert de "rodada completa"
# passaria por vacuidade, com 20 fontes em vez de 21.
for f in "$MAE" "$PERDA" "$MIG"; do
  P -q -f "$f" >/dev/null
  echo "migration aplicada: $(basename "$f")"
done

# Idempotência: re-aplicar não pode quebrar (o founder cola no SQL Editor e pode
# colar duas vezes; e `CREATE TABLE IF NOT EXISTS` sozinho não prova o resto).
if P -q -f "$MIG" >/dev/null 2>&1; then ok "Z0 migration e' idempotente (re-aplicar passa)"
else bad "Z0 re-aplicar a migration falhou"; fi

# ⚠️ Os helpers de fila/lápide do harness do #2098 NÃO são reaproveitados aqui: esta
# prova aprova pelo caminho REAL (UPDATE que dispara o trigger), não semeando a outbox
# à mão. Semear puxaria o teste para longe do que ele existe para provar.

# Lê UM campo do check do TRIGGER.
sensor() { Pq -c "SELECT coalesce(${1}::text, '<null>') FROM public._data_health_compute()
                   WHERE source = 'analytics_outbox_trigger';"; }
sensor_fp() { Pq -c "SELECT md5(source || '|' || status || '|' || severity || '|' || coalesce(message,''))
                       FROM public._data_health_compute() WHERE source='analytics_outbox_trigger';"; }

# Aprova um pedido PELO CAMINHO REAL (UPDATE), que é o que dispara o trigger.
aprovar() { # $1=id  $2=horas_atras
  P -q -c "INSERT INTO public.pedido_compra_sugerido(id, status, criado_em)
           VALUES ($1, 'pendente_aprovacao', now() - (interval '1 hour' * ($2 + 1)));
           UPDATE public.pedido_compra_sugerido
              SET aprovado_em = now() - (interval '1 hour' * $2), aprovado_por='x@y.com'
            WHERE id = $1;" >/dev/null
}
limpar() { P -q -c "TRUNCATE public.analytics_outbox; DELETE FROM public.pedido_compra_sugerido;" >/dev/null; }

echo "── assert: O CHECK RECONCILIA LINHA A LINHA ──"
limpar
eq "T1a sem aprovacao nenhuma => ok"        "$(sensor status)"      "ok"
eq "T1b e age_seconds NULL (caso saudavel)" "$(sensor age_seconds)" "<null>"

# Caminho feliz: o trigger emite, o check nao acusa.
limpar; aprovar 9001 2; aprovar 9002 5
eq "T2a trigger emitiu as 2 linhas" \
   "$(Pq -c "SELECT count(*) FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada';")" "2"
eq "T2b check verde com o trigger sadio"   "$(sensor status)"      "ok"

# ⚠️ O ASSERT CENTRAL. Simula o fail-open: o trigger emitiu, mas a linha SUMIU
# (equivalente ao INSERT ter sido engolido pelo EXCEPTION WHEN OTHERS).
P -q -c "DELETE FROM public.analytics_outbox
          WHERE chave_dedup = 'pcs:9001:reposicao.sugestao_aprovada';" >/dev/null
eq "T3a fail-open (1 aprovacao orfa) => broken" "$(sensor status)" "broken"
eq "T3b a idade e' a do orfao, nao a da aprovacao mais nova" \
   "$(Pq -c "SELECT (age_seconds BETWEEN 7000 AND 7400)::text FROM public._data_health_compute()
              WHERE source='analytics_outbox_trigger';")" "true"

# ⚠️ A JANELA. Órfão FORA das 48h não pode acender: naquela idade a linha pode ter
# sido legitimamente PURGADA (aceita expira em 7 dias), e acusar seria déficit falso.
limpar; aprovar 9003 60
P -q -c "DELETE FROM public.analytics_outbox WHERE chave_dedup='pcs:9003:reposicao.sugestao_aprovada';" >/dev/null
eq "T4 orfao de 60h fica FORA da janela (purga fabricaria falso)" "$(sensor status)" "ok"

# A linha 'expirada' é INDICATIVA e está deliberadamente fora do check.
limpar; aprovar 9004 2
P -q -c "UPDATE public.pedido_compra_sugerido SET status='expirado_sem_aprovacao' WHERE id=9004;" >/dev/null
P -q -c "DELETE FROM public.analytics_outbox WHERE evento='reposicao.sugestao_expirada';" >/dev/null
eq "T5 perda de 'expirada' NAO acende (fora do escopo, por precisao)" "$(sensor status)" "ok"

# Mensagem estável: dois órfãos e depois cinco dão o MESMO fingerprint.
limpar; aprovar 9010 1; aprovar 9011 1
P -q -c "DELETE FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada';" >/dev/null
FP1="$(sensor_fp)"
aprovar 9012 1; aprovar 9013 1; aprovar 9014 1
P -q -c "DELETE FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada';" >/dev/null
FP2="$(sensor_fp)"
eq "T6 fingerprint estavel com mais orfaos" "$FP1" "$FP2"
eq "T6b (e o cenario mudou mesmo: 5 orfaos)" \
   "$(Pq -c "SELECT count(*) FROM public.pedido_compra_sugerido WHERE aprovado_em IS NOT NULL;")" "5"

eq "T7 status e severity dentro do contrato" \
   "$(Pq -c "SELECT count(*) FROM public._data_health_compute()
              WHERE source='analytics_outbox_trigger'
                AND status IN ('ok','stale','broken','unknown')
                AND severity IN ('critical','warning','info');")" "1"

echo "── assert: O WATCHDOG AVALIA (agora 21 fontes) ──"
limpar
P -q -c "UPDATE public.data_health_watchdog_estado SET last_success_at = now() - interval '1 hour';" >/dev/null
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
eq "W1 rodada COMPLETA (marcador avancou)" \
   "$(Pq -c "SELECT (last_success_at > now() - interval '2 minutes')::text FROM public.data_health_watchdog_estado;")" "true"
eq "W1b 21 fontes avaliadas (20 + a nova)" \
   "$(Pq -c "SELECT checks_avaliados::text FROM public.data_health_watchdog_estado;")" "21"

limpar; aprovar 9020 2
P -q -c "DELETE FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada';" >/dev/null
P -q -c "DELETE FROM public.fin_alertas; SELECT public.data_health_watchdog();" >/dev/null
eq "W2 alerta do check novo chegou em fin_alertas" \
   "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_analytics_outbox_trigger';")" "1"

P -q -c "SELECT public.fin_sync_heartbeat();" >/dev/null
eq "W3 resumo do heartbeat lista a fonte nova" \
   "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE mensagem LIKE '%analytics_outbox_trigger%';")" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO (baseline: $PASS verdes, $FAIL vermelhos) ──"
[ "$FAIL" -eq 0 ] || { echo "ABORTA: a falsificacao so vale sobre baseline VERDE ($FAIL falhas)"; exit 1; }

FALSIF_OK=0; FALSIF_BAD=0
# shellcheck disable=SC2016  # literal de proposito (padrao de sed / leitura diferida)
so_compute() { sed -n '/^CREATE OR REPLACE FUNCTION public._data_health_compute/,/^\$function\$;$/p'; }
sabota() { # $1=nome  $2=sql_sabotado  $3=leitura  $4=valor_real_que_NAO_pode_mais_vir
  P -q -c "$2" >/dev/null 2>&1 || { echo "  ⚠️  $1 — o SQL sabotado nem aplicou"; FALSIF_BAD=$((FALSIF_BAD+1)); return; }
  local got; got="$(eval "$3")"
  if [ "$got" != "$4" ]; then FALSIF_OK=$((FALSIF_OK+1)); echo "  🔴 $1 — VERMELHO como esperado (veio [$got], real e' [$4])"
  else FALSIF_BAD=$((FALSIF_BAD+1)); echo "  ⚠️  $1 — SEGUIU VERDE com a sabotagem: nao tem dente"; fi
  P -q -f "$MIG" >/dev/null
}

# G1 — o check volta a ser CONTAGEM (a view), em vez de reconciliar linha a linha.
# Com 1 aprovacao e 1 linha na outbox (de OUTRO pedido), a contagem bate e o orfao some.
limpar; aprovar 9101 2
P -q -c "DELETE FROM public.analytics_outbox WHERE chave_dedup='pcs:9101:reposicao.sugestao_aprovada';
         INSERT INTO public.analytics_outbox(evento,distinct_id,props,chave_dedup,ocorrido_em)
         VALUES ('reposicao.sugestao_aprovada','sistema:reposicao','{}'::jsonb,'pcs:9999:reposicao.sugestao_aprovada', now());" >/dev/null
sabota "G1 reconciliacao por CONTAGEM (a view) em vez de linha a linha" \
  "$(perl -0pe "s/ON o\.chave_dedup = 'pcs:' \|\| p\.id::text \|\| ':reposicao\.sugestao_aprovada'/ON o.evento = 'reposicao.sugestao_aprovada'/s" "$MIG" | so_compute)" \
  'sensor status' "broken"

# G2 — janela esticada para 7 dias: a purga de linha ACEITA passa a fabricar orfao.
limpar; aprovar 9102 60
P -q -c "DELETE FROM public.analytics_outbox WHERE chave_dedup='pcs:9102:reposicao.sugestao_aprovada';" >/dev/null
sabota "G2 janela de 7d (a purga fabrica deficit falso)" \
  "$(perl -0pe "s/WHERE p\.aprovado_em > now\(\) - interval '48 hours'/WHERE p.aprovado_em > now() - interval '7 days'/s" "$MIG" | so_compute)" \
  'sensor status' "ok"

# G3 — piso ancorado em min(ocorrido_em) da outbox: o piso ANDA com a purga e, quando
# ultrapassa a janela, o check fica verde por construcao. Fail-open disfarcado.
limpar; aprovar 9103 2
P -q -c "DELETE FROM public.analytics_outbox WHERE chave_dedup='pcs:9103:reposicao.sugestao_aprovada';
         INSERT INTO public.analytics_outbox(evento,distinct_id,props,chave_dedup,ocorrido_em)
         VALUES ('reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'piso', now());" >/dev/null
sabota "G3 piso movel em min(ocorrido_em) (a purga cega o check)" \
  "$(perl -0pe "s/WHERE p\.aprovado_em > now\(\) - interval '48 hours'/WHERE p.aprovado_em > greatest(now() - interval '48 hours', (SELECT min(ocorrido_em) FROM public.analytics_outbox))/s" "$MIG" | so_compute)" \
  'sensor status' "broken"

# G4 — mensagem volatil: o fingerprint nunca se repete e o watchdog nunca escala.
limpar; aprovar 9104 1; aprovar 9105 1
P -q -c "DELETE FROM public.analytics_outbox WHERE evento='reposicao.sugestao_aprovada';" >/dev/null
# shellcheck disable=SC2016  # literal de proposito (leitura diferida, avaliada em sabota())
sabota "G4 message com a contagem (fingerprint nunca confirma)" \
  "$(perl -0pe "s/THEN 'Trigger da outbox PERDEU evento: aprovacao de compra sem linha na fila'/THEN 'Trigger perdeu ' || tg.orfaos || ' evento\(s\)'/s" "$MIG" | so_compute)" \
  'FPA="$(sensor_fp)"; aprovar 9106 1; P -q -c "DELETE FROM public.analytics_outbox WHERE evento='"'"'reposicao.sugestao_aprovada'"'"';" >/dev/null; FPB="$(sensor_fp)"; [ "$FPA" = "$FPB" ] && echo estavel || echo volatil' \
  "estavel"

echo
echo "═══════════════════════════════════════════"
echo "  asserts:      $PASS verdes, $FAIL vermelhos"
echo "  falsificacao: $FALSIF_OK com dente, $FALSIF_BAD sem dente"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && [ "$FALSIF_BAD" -eq 0 ]

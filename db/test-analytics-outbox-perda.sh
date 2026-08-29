#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260829012000_analytics_outbox_perda_visivel.sql                ║
# ║      bash db/test-analytics-outbox-perda.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
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
PORT="${PGPORT_TEST:-5473}"
SLUG="analytics-outbox-perda"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

MAE="$REPO_ROOT/supabase/migrations/20260825214545_analytics_outbox.sql"
MIG="$REPO_ROOT/supabase/migrations/20260829012000_analytics_outbox_perda_visivel.sql"
[ -f "$MAE" ] || { echo "migration-mãe ausente: $MAE"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

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
P -q -f "$MAE" >/dev/null
echo "migration aplicada: $(basename "$MAE")"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# Idempotência: re-aplicar não pode quebrar (o founder cola no SQL Editor e pode
# colar duas vezes; e `CREATE TABLE IF NOT EXISTS` sozinho não prova o resto).
if P -q -f "$MIG" >/dev/null 2>&1; then ok "Z0 migration e' idempotente (re-aplicar passa)"
else bad "Z0 re-aplicar a migration falhou"; fi

# Extratores para a ZONA 4 (falsificação) — recriam UM objeto por vez.
# shellcheck disable=SC2016  # padroes de sed e leitura diferida sao literais de proposito
so_purgar()  { sed -n '/^CREATE OR REPLACE FUNCTION public.analytics_outbox_purgar/,/^\$fn\$;$/p'; }
# shellcheck disable=SC2016  # literal de proposito (padrao de sed / leitura diferida)
so_compute() { sed -n '/^CREATE OR REPLACE FUNCTION public._data_health_compute/,/^\$function\$;$/p'; }

# ── Mesa de controle da fila ─────────────────────────────────────────────────
# Semeia a outbox DIRETO (não pelo trigger): o objetivo é controlar idade,
# aceite, quarentena e prazo de purga — não re-testar o trigger, que é da
# migration-mãe e já tem prova própria em db/test-analytics-outbox.sh.
semear() { # $1=n  $2=idade_horas  $3=aceita(t/f)  $4=quarentena(t/f)  $5=dias_ate_purgar
  P -q -c "INSERT INTO public.analytics_outbox
             (evento, distinct_id, props, chave_dedup, ocorrido_em, aceito_em, quarentena_em, purgar_em)
           SELECT 'reposicao.sugestao_criada', 'sistema:reposicao', '{}'::jsonb,
                  'k-' || gen_random_uuid()::text,
                  now() - (interval '1 hour' * $2),
                  CASE WHEN $3 THEN now() ELSE NULL END,
                  CASE WHEN $4 THEN now() ELSE NULL END,
                  now() + (interval '1 day' * $5)
             FROM generate_series(1, $1);" >/dev/null
}
limpar() { P -q -c "TRUNCATE public.analytics_outbox; TRUNCATE public.analytics_outbox_perda;" >/dev/null; }

# Lê UM campo do check novo. `-tA` + coalesce: NULL vira '<null>' explícito, para
# não confundir "veio nulo" com "a query não devolveu linha".
sensor() { Pq -c "SELECT coalesce(${1}::text, '<null>') FROM public._data_health_compute()
                   WHERE source = 'analytics_outbox_transporte';"; }
# Fingerprint EXATAMENTE como o watchdog o calcula (source|status|severity|message).
sensor_fp() { Pq -c "SELECT md5(source || '|' || status || '|' || severity || '|' || coalesce(message,''))
                       FROM public._data_health_compute() WHERE source='analytics_outbox_transporte';"; }

echo "── assert: O SENSOR LÊ O EIXO CERTO ──"
limpar
eq "A1a fila vazia => status ok"            "$(sensor status)"      "ok"
eq "A1b fila vazia => age_seconds NULL"     "$(sensor age_seconds)" "<null>"

limpar; semear 3 0.5 false false 30
eq "A2 fila de 30min => ok"                 "$(sensor status)"      "ok"

limpar; semear 3 3 false false 30
eq "A3 fila de 3h => stale"                 "$(sensor status)"      "stale"

# ⚠️ O ASSERT CENTRAL. Reproduz a assinatura EXATA do apagão de 2026-08-26:
# linhas velhas com tentativas=0, ultimo_erro=NULL, quarentena_em=NULL. Todas as
# colunas de diagnóstico impecáveis; só a IDADE denuncia.
limpar; semear 105 8 false false 30
eq "A4a apagao (8h, tentativas=0) => broken" "$(sensor status)"     "broken"
eq "A4b e as colunas de retry estao mesmo impecaveis" \
   "$(Pq -c "SELECT count(*) FROM public.analytics_outbox
              WHERE tentativas=0 AND ultimo_erro IS NULL AND quarentena_em IS NULL;")" "105"

# Backstop: fila JOVEM (1 min) mas a 3 dias de ser apagada sem aceite.
limpar; semear 2 0.01 false false 3
eq "A5 backstop: <7d da purga sem aceite => broken" "$(sensor status)" "broken"

# Quarentena não entra no eixo de idade (senão pinta vermelho por 30 dias),
# mas não pode virar 'ok': é perda pendente.
limpar; semear 1 200 false true 30
eq "A6 quarentena longe da purga => stale"  "$(sensor status)"      "stale"

# ⚠️ Estabilidade da mensagem. O watchdog só ESCALA quando o fingerprint se
# REPETE em duas avaliações (`v_material`). Mensagem que carrega contagem/idade
# muda a cada tick, nunca se confirma, e o sensor avisa uma vez e emudece.
limpar; semear 5 8 false false 30
FP1="$(sensor_fp)"
semear 40 9 false false 30   # a fila CRESCE e ENVELHECE entre as duas leituras
FP2="$(sensor_fp)"
eq "A7 fingerprint estavel com a fila crescendo" "$FP1" "$FP2"
eq "A7b (e o cenario mudou mesmo: 45 linhas)" \
   "$(Pq -c "SELECT count(*) FROM public.analytics_outbox;")" "45"

# Contrato que o watchdog RAISE-eia se violado (20260815153218).
eq "A8 status e severity dentro do contrato" \
   "$(Pq -c "SELECT count(*) FROM public._data_health_compute()
              WHERE source='analytics_outbox_transporte'
                AND status IN ('ok','stale','broken','unknown')
                AND severity IN ('critical','warning','info');")" "1"

echo "── assert: O WATCHDOG AVALIA O CHECK (as duas metades) ──"
# ⚠️ B1 é a prova de que compute e `v_sources` estão em SINCRONIA: o watchdog só
# avança `last_success_at` em rodada COMPLETA (v_n = array_length(v_sources,1)).
# Meia-migration (check sem source, ou source sem check) reprova aqui.
limpar
P -q -c "UPDATE public.data_health_watchdog_estado SET last_success_at = now() - interval '1 hour';" >/dev/null
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
eq "B1 rodada COMPLETA (marcador de sucesso avancou)" \
   "$(Pq -c "SELECT (last_success_at > now() - interval '2 minutes')::text FROM public.data_health_watchdog_estado;")" "true"
eq "B1b 20 fontes avaliadas (19 + a nova)" \
   "$(Pq -c "SELECT checks_avaliados::text FROM public.data_health_watchdog_estado;")" "20"

# B2: end-to-end — fila em apagão, watchdog roda, alerta do check novo aparece.
limpar; semear 10 8 false false 30
P -q -c "DELETE FROM public.fin_alertas; SELECT public.data_health_watchdog();" >/dev/null
eq "B2 alerta do check novo chegou em fin_alertas" \
   "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_analytics_outbox_transporte';")" "1"

# B3: o resumo diário LISTA a fonte (é o corpo do e-mail, não a contagem).
P -q -c "SELECT public.fin_sync_heartbeat();" >/dev/null
eq "B3 resumo do heartbeat lista a fonte nova" \
   "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta
              WHERE mensagem LIKE '%analytics_outbox_transporte%';")" "1"
eq "B3b e o sync_state_saude que faltava desde 24/08" \
   "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE mensagem LIKE '%sync_state_saude%';")" "1"

echo "── assert: A LÁPIDE (o denominador que sobrevive) ──"
limpar
# 4 não-aceitas do dia D, já vencidas; 2 aceitas vencidas; 1 em quarentena vencida.
P -q <<'SQL' >/dev/null
INSERT INTO public.analytics_outbox
  (evento, distinct_id, props, chave_dedup, ocorrido_em, aceito_em, quarentena_em, purgar_em)
SELECT 'reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'p1-'||g,
       timestamptz '2026-07-10 09:00:00Z' + (interval '1 hour' * g), NULL, NULL, now() - interval '1 day'
  FROM generate_series(1,4) g;
INSERT INTO public.analytics_outbox
  (evento, distinct_id, props, chave_dedup, ocorrido_em, aceito_em, quarentena_em, purgar_em)
SELECT 'reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'p2-'||g,
       timestamptz '2026-07-10 09:00:00Z', now(), NULL, now() - interval '1 day'
  FROM generate_series(1,2) g;
INSERT INTO public.analytics_outbox
  (evento, distinct_id, props, chave_dedup, ocorrido_em, aceito_em, quarentena_em, purgar_em)
VALUES ('reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'p3',
        timestamptz '2026-07-10 09:00:00Z', NULL, now(), now() - interval '1 day');
SQL
REM="$(Pq -c "SELECT public.analytics_outbox_purgar();")"
eq "C7 retorno = linhas DELETADAS (comportamento preservado)" "$REM" "7"
eq "C1a lapide: motivo sem_aceite com a contagem certa" \
   "$(Pq -c "SELECT quantidade::text FROM public.analytics_outbox_perda
              WHERE motivo='sem_aceite' AND dia = date '2026-07-10';")" "4"
eq "C1b lapide: o dia e' o do FATO, nao o da purga" \
   "$(Pq -c "SELECT count(*) FROM public.analytics_outbox_perda WHERE dia = date '2026-07-10';")" "2"
eq "C2 quarentena vai para BALDE separado" \
   "$(Pq -c "SELECT quantidade::text FROM public.analytics_outbox_perda WHERE motivo='quarentena';")" "1"
# ⚠️ C3 é o assert que impede a lápide de contar o CAMINHO FELIZ. Um denominador
# que soma sucesso é pior que nenhum: parece medido e mente para cima.
eq "C3 linha ACEITA purgada NAO vira lapide" \
   "$(Pq -c "SELECT coalesce(sum(quantidade),0)::text FROM public.analytics_outbox_perda
              WHERE quantidade > 4;")" "0"
eq "C5 mais_antigo = o menor ocorrido_em do balde" \
   "$(Pq -c "SELECT to_char(mais_antigo AT TIME ZONE 'UTC','HH24:MI') FROM public.analytics_outbox_perda
              WHERE motivo='sem_aceite';")" "10:00"

# ⚠️ C4: eventos do MESMO dia nascem com purgar_em diferentes, então o mesmo balde
# é purgado em execuções DIFERENTES. Upsert não-aditivo perderia a 1ª leva calado.
P -q <<'SQL' >/dev/null
INSERT INTO public.analytics_outbox
  (evento, distinct_id, props, chave_dedup, ocorrido_em, aceito_em, quarentena_em, purgar_em)
SELECT 'reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'p4-'||g,
       timestamptz '2026-07-10 08:00:00Z', NULL, NULL, now() - interval '1 day'
  FROM generate_series(1,3) g;
SQL
P -q -c "SELECT public.analytics_outbox_purgar();" >/dev/null
eq "C4a upsert e' ADITIVO (4 + 3 = 7)" \
   "$(Pq -c "SELECT quantidade::text FROM public.analytics_outbox_perda
              WHERE motivo='sem_aceite' AND dia = date '2026-07-10';")" "7"
eq "C4b e mais_antigo recuou para o menor (least)" \
   "$(Pq -c "SELECT to_char(mais_antigo AT TIME ZONE 'UTC','HH24:MI') FROM public.analytics_outbox_perda
              WHERE motivo='sem_aceite' AND dia = date '2026-07-10';")" "08:00"

eq "C6 a lapide nao tem NENHUMA coluna de titular" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns
              WHERE table_schema='public' AND table_name='analytics_outbox_perda'
                AND column_name IN ('user_id','distinct_id','props','ultimo_erro','event_id');")" "0"

echo "── assert: NEGATIVOS (a defesa morde) ──"
# ⚠️ SQLSTATE esperada capturada, resto RE-LANÇADO. `WHEN OTHERS THEN 'OK'` seria
# teatro: engoliria até um erro de digitação deste próprio teste.
neg() { # $1=nome  $2=sqlstate  $3=sql
  R=$(P -tA 2>&1 <<SQL
DO \$t\$ BEGIN
  $3
  RAISE EXCEPTION 'SENT_NAO_BARROU' USING ERRCODE = 'P0001';
EXCEPTION
  WHEN SQLSTATE '$2' THEN RAISE NOTICE 'SENT_BARROU_CERTO';
  WHEN OTHERS THEN RAISE;
END \$t\$;
SQL
) || true
  case "$R" in *SENT_BARROU_CERTO*) ok "$1" ;; *) bad "$1 — veio: $(printf '%s' "$R" | tr '\n' ' ' | cut -c1-140)" ;; esac
}
neg "D1 CHECK rejeita motivo fora do dominio (23514)" "23514" \
  "INSERT INTO public.analytics_outbox_perda(dia,evento,motivo,quantidade,mais_antigo)
     VALUES (current_date,'x.y','inventado',1,now());"
neg "D2 CHECK rejeita quantidade zero (23514)" "23514" \
  "INSERT INTO public.analytics_outbox_perda(dia,evento,motivo,quantidade,mais_antigo)
     VALUES (current_date,'x.y','sem_aceite',0,now());"

eq "D3 authenticated NAO executa analytics_outbox_purgar" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.analytics_outbox_purgar()','EXECUTE')::text;")" "false"
eq "D3b anon tambem nao" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.analytics_outbox_purgar()','EXECUTE')::text;")" "false"
eq "D4 authenticated NAO tem SELECT na lapide (grant)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.analytics_outbox_perda','SELECT')::text;")" "false"
eq "D5 RLS ligada na lapide" \
   "$(Pq -c "SELECT relrowsecurity::text FROM pg_class WHERE oid='public.analytics_outbox_perda'::regclass;")" "true"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ Baseline VERDE explícito ANTES: exit≠0 não distingue "pegou o bug" de "o
# comando nem rodou". Cada sabotagem tem de produzir vermelho no assert que ELA
# mira — e só nele.
echo "── FALSIFICAÇÃO (baseline: $PASS verdes, $FAIL vermelhos) ──"
[ "$FAIL" -eq 0 ] || { echo "ABORTA: a falsificacao so vale sobre baseline VERDE ($FAIL falhas)"; exit 1; }

FALSIF_OK=0; FALSIF_BAD=0
# roda um SQL sabotado, reavalia UM predicado, exige que ele MUDE, e restaura.
sabota() { # $1=nome  $2=sql_sabotado  $3=comando_de_leitura  $4=valor_que_NAO_pode_mais_vir
  P -q -c "$2" >/dev/null 2>&1 || { echo "  ⚠️  $1 — o SQL sabotado nem aplicou"; FALSIF_BAD=$((FALSIF_BAD+1)); return; }
  local got; got="$(eval "$3")"
  if [ "$got" != "$4" ]; then FALSIF_OK=$((FALSIF_OK+1)); echo "  🔴 $1 — assert VERMELHO como esperado (veio [$got], real e' [$4])"
  else FALSIF_BAD=$((FALSIF_BAD+1)); echo "  ⚠️  $1 — assert SEGUIU VERDE com a sabotagem: nao tem dente"; fi
  P -q -f "$MIG" >/dev/null   # restaura TUDO a partir da migration real
}

# F1 — O EIXO. Troca idade por `tentativas>=8`: é exatamente o check que teria
# ficado verde nas 32h do apagão (105/105 em tentativas=0).
limpar; semear 105 8 false false 30
# ⚠️ A sabotagem troca AS DUAS condicoes de idade por leituras da maquina de
# retry — que e' o check que alguem escreveria por instinto. Com a assinatura do
# apagao (105 linhas de 8h, tentativas=0, sem erro, sem quarentena) ele responde
# 'ok': verde durante as 32h inteiras. E' a prova de que o eixo NAO e' cosmetico.
sabota "F1 eixo trocado para a maquina de retry (o check cego do apagao)" \
  "$(perl -0pe "s/WHEN ob\.idade_s > 6\*3600\s+THEN 'broken'\n(\s+)WHEN ob\.idade_s > 2\*3600 OR ob\.quarentena > 0\s+THEN 'stale'/WHEN (SELECT max(tentativas) FROM public.analytics_outbox WHERE aceito_em IS NULL) >= 8 THEN 'broken'\n\$1WHEN ob.quarentena > 0 THEN 'stale'/s" "$MIG" | so_compute)" \
  'sensor status' "broken"

# F2 — a purga volta a ser DELETE cru: a lápide para de nascer.
limpar
P -q -c "INSERT INTO public.analytics_outbox(evento,distinct_id,props,chave_dedup,ocorrido_em,purgar_em)
         VALUES ('reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'f2',
                 timestamptz '2026-07-11 09:00:00Z', now() - interval '1 day');" >/dev/null
sabota "F2 purga sem a lapide (DELETE cru)" \
  "CREATE OR REPLACE FUNCTION public.analytics_outbox_purgar() RETURNS integer LANGUAGE plpgsql
   SECURITY DEFINER SET search_path='' AS \$f\$ DECLARE n integer; BEGIN
     DELETE FROM public.analytics_outbox WHERE purgar_em < now();
     GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END \$f\$;" \
  'P -q -c "SELECT public.analytics_outbox_purgar();" >/dev/null; Pq -c "SELECT coalesce(sum(quantidade),0)::text FROM public.analytics_outbox_perda;"' \
  "1"

# F3 — upsert não-aditivo: a 1ª leva do mesmo balde some.
limpar
P -q -c "INSERT INTO public.analytics_outbox_perda(dia,evento,motivo,quantidade,mais_antigo)
         VALUES (date '2026-07-12','reposicao.sugestao_criada','sem_aceite',5, now());" >/dev/null
P -q -c "INSERT INTO public.analytics_outbox(evento,distinct_id,props,chave_dedup,ocorrido_em,purgar_em)
         SELECT 'reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'f3-'||g,
                timestamptz '2026-07-12 09:00:00Z', now() - interval '1 day' FROM generate_series(1,3) g;" >/dev/null
sabota "F3 upsert nao-aditivo (perde a leva anterior)" \
  "$(perl -0pe 's/SET quantidade    = p\.quantidade \+ EXCLUDED\.quantidade,/SET quantidade    = EXCLUDED.quantidade,/s' "$MIG" | so_purgar)" \
  'P -q -c "SELECT public.analytics_outbox_purgar();" >/dev/null; Pq -c "SELECT quantidade::text FROM public.analytics_outbox_perda WHERE dia=date '"'"'2026-07-12'"'"';"' \
  "8"

# F4 — mensagem VOLÁTIL: o fingerprint deixa de se repetir e o watchdog nunca escala.
limpar; semear 5 8 false false 30
# shellcheck disable=SC2016  # literal de proposito (padrao de sed / leitura diferida)
sabota "F4 message com a contagem (fingerprint nunca confirma)" \
  "$(perl -0pe "s/THEN 'Outbox de analytics PARADA: a fila nao drena ha mais de 6h'/THEN 'Outbox PARADA: ' || ob.na_fila || ' na fila'/s" "$MIG" | so_compute)" \
  'FPA="$(sensor_fp)"; semear 40 9 false false 30; FPB="$(sensor_fp)"; [ "$FPA" = "$FPB" ] && echo estavel || echo volatil' \
  "estavel"

# F5 — o check sai do compute mas fica em v_sources: rodada INCOMPLETA.
limpar
sabota "F5 check removido do compute (v_sources orfao => rodada incompleta)" \
  "$(perl -0pe "s/'analytics_outbox_transporte'::text, 'analytics'::text,/'analytics_outbox_transporte_RENOMEADO'::text, 'analytics'::text,/s" "$MIG" | so_compute)" \
  'P -q -c "UPDATE public.data_health_watchdog_estado SET last_success_at = now() - interval '"'"'1 hour'"'"';" >/dev/null; P -q -c "SELECT public.data_health_watchdog();" >/dev/null; Pq -c "SELECT (last_success_at > now() - interval '"'"'2 minutes'"'"')::text FROM public.data_health_watchdog_estado;"' \
  "true"

# F6 — a lápide passa a contar o caminho feliz (linha ACEITA vira "perda").
limpar
P -q -c "INSERT INTO public.analytics_outbox(evento,distinct_id,props,chave_dedup,ocorrido_em,aceito_em,purgar_em)
         VALUES ('reposicao.sugestao_criada','sistema:reposicao','{}'::jsonb,'f6',
                 timestamptz '2026-07-13 09:00:00Z', now(), now() - interval '1 day');" >/dev/null
sabota "F6 lapide conta o caminho feliz (aceita vira perda)" \
  "$(perl -0pe 's/     WHERE r\.aceito_em IS NULL\n//s' "$MIG" | so_purgar)" \
  'P -q -c "SELECT public.analytics_outbox_purgar();" >/dev/null; Pq -c "SELECT coalesce(sum(quantidade),0)::text FROM public.analytics_outbox_perda;"' \
  "0"

# F7 — backstop removido: a linha a 3 dias da purga volta a passar por saudável.
limpar; semear 2 0.01 false false 3
sabota "F7 backstop removido (<7d da purga deixa de acender)" \
  "$(perl -0pe "s/WHEN ob\.quase_perdidas > 0\s+THEN 'broken'/WHEN false THEN 'broken'/s" "$MIG" | so_compute)" \
  'sensor status' "broken"

echo
echo "═══════════════════════════════════════════"
echo "  asserts:      $PASS verdes, $FAIL vermelhos"
echo "  falsificacao: $FALSIF_OK com dente, $FALSIF_BAD sem dente"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] && [ "$FALSIF_BAD" -eq 0 ]

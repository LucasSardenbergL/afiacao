-- Pré-requisitos PG17 para db/test-data-health-sync-state-saude.sh
-- Stubs das relações que _data_health_compute()/data_health_watchdog() LEEM mas não criam.
-- Gerado do catálogo da PROD (psql-ro) em 2026-08-25 — colunas e tipos reais; enums viram text.
CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE IF NOT EXISTS private.customer_metrics_mv (customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamp with time zone, dias_desde_ultima_compra integer, pedidos_90d bigint, faturamento_90d numeric, ticket_medio_90d numeric, faturamento_prev_90d numeric, intervalo_medio_dias numeric, atraso_relativo numeric, is_cold_start boolean, calculated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.carteira_assignments (id uuid, customer_user_id uuid, owner_user_id uuid, source text, omie_account text, omie_codigo_vendedor bigint, eligible boolean, valid_from timestamp with time zone, updated_at timestamp with time zone, last_synced_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger (user_id uuid, identity_state text, first_seen_at timestamp with time zone, source text, updated_at timestamp with time zone);
CREATE TABLE IF NOT EXISTS public.farmer_client_scores (id uuid, customer_user_id uuid, farmer_id uuid, rf_score numeric, m_score numeric, g_score numeric, x_score numeric, s_score numeric, health_score numeric, health_class text, churn_risk numeric, recover_score numeric, expansion_score numeric, eff_score numeric, priority_score numeric, days_since_last_purchase integer, avg_repurchase_interval numeric, avg_monthly_spend_180d numeric, gross_margin_pct numeric, category_count integer, answer_rate_60d numeric, whatsapp_reply_rate_60d numeric, revenue_potential numeric, calculated_at timestamp with time zone, created_at timestamp with time zone, updated_at timestamp with time zone, signal_modifiers jsonb, last_signal_recalc_at timestamp with time zone, sales_history_status text, itens_com_custo bigint, itens_sem_custo bigint);
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

CREATE TABLE IF NOT EXISTS public.data_health_watchdog_estado (id boolean NOT NULL, last_run_at timestamp with time zone, last_success_at timestamp with time zone, checks_avaliados integer, checks_falhos integer, ultimo_erro text, atualizado_em timestamp with time zone NOT NULL);
CREATE TABLE IF NOT EXISTS public.fin_alertas (id uuid NOT NULL, company text NOT NULL, tipo text NOT NULL, severidade text NOT NULL, mensagem text NOT NULL, valor numeric(15,2), threshold numeric(15,2), contexto jsonb, criado_em timestamp with time zone NOT NULL, dismissed_at timestamp with time zone, dismissed_by uuid, dismissed_until timestamp with time zone, email_enfileirado_em timestamp with time zone, acknowledged_at timestamp with time zone, acknowledged_by uuid, resolvido_em timestamp with time zone);

-- defaults/constraints que os INSERTs das funções exigem (o catálogo-dump não os traz)
DO $prereq$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS ty
             FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
            WHERE n.nspname='public' AND c.relkind='r'
  LOOP
    IF r.attname='id' AND r.ty='uuid' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN id SET DEFAULT gen_random_uuid()', r.relname);
    ELSIF r.attname IN ('criado_em','created_at','atualizado_em','updated_at') AND r.ty LIKE 'timestamp%' THEN
      EXECUTE format('ALTER TABLE public.%I ALTER COLUMN %I SET DEFAULT now()', r.relname, r.attname);
    END IF;
  END LOOP;
END $prereq$;

ALTER TABLE public.data_health_watchdog_estado ADD PRIMARY KEY (id);
-- índice do ON CONFLICT de _data_health_episodio: 1 alerta ATIVO por (company,tipo)
CREATE UNIQUE INDEX IF NOT EXISTS fin_alertas_company_tipo_ativo
  ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;

-- funções auxiliares chamadas pelo watchdog (definições REAIS da PROD)
CREATE OR REPLACE FUNCTION public._data_health_episodio(p_company text, p_tipo text, p_status text, p_sev_fin text, p_titulo text, p_msg text, p_msg_email text, p_ctx jsonb, p_fingerprint text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- data_health reemissao v1 (mig 20260814222000) — MARCADOR do guard anti-rollback.
-- Uma versão SUCESSORA que recrie esta máquina DEVE trocar o marcador (v2, v3…), para que
-- re-aplicar a migration ANTIGA sobre ela ABORTE em vez de revertê-la em silêncio.
DECLARE
  v_sev_forn   text;
  v_grav       int;
  v_intervalo  interval;
  v_row        public.fin_alertas%ROWTYPE;
  v_fp_ant     text;
  v_fp_email   text;
  v_grav_email int;
  v_ult_email  timestamptz;
  v_ult_grav   int;
  v_flap       boolean;
  -- 2h = 4 ticks do cron */30. Abaixo disso é oscilação; acima, recorrência.
  v_janela_flap interval := interval '2 hours';
  -- Teto de e-mails por MATERIALIDADE (ver v_material). 4h ⇒ ≤6/dia no pior caso.
  v_min_material interval := interval '4 hours';
  v_prox       timestamptz;
  v_ack        boolean;
  v_snooze     boolean;
  v_escalou    boolean;
  v_nunca      boolean;
  v_material   boolean;
  v_lembrete   boolean;
  v_deve       boolean;
  v_motivo     text;
  v_upd        int;
BEGIN
  -- Contrato fail-closed do vocabulário. NULL/typo ABORTA — nunca degrada para 'aviso'
  -- (o CASE … ELSE do corpo antigo transformava severidade desconhecida em 'aviso' calado).
  IF p_sev_fin IS NULL OR p_sev_fin NOT IN ('info','aviso','critico') THEN
    RAISE EXCEPTION 'severidade de fin_alertas inválida: %', COALESCE(p_sev_fin,'<NULL>')
      USING ERRCODE = '22023';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('stale','broken','unknown') THEN
    RAISE EXCEPTION 'status de episódio inválido: %', COALESCE(p_status,'<NULL>')
      USING ERRCODE = '22023';
  END IF;

  -- fornecedor_alerta tem CHECK próprio e vocabulário DIFERENTE de fin_alertas
  -- (info/atencao/urgente vs info/aviso/critico) — derivar aqui elimina o modo de falha
  -- "severidade inválida derruba o cron".
  v_sev_forn := CASE p_sev_fin WHEN 'critico' THEN 'urgente'
                               WHEN 'aviso'   THEN 'atencao'
                               ELSE 'info' END;

  -- GRAVIDADE = severidade × status. É o que pega stale→broken num check cuja severity é
  -- literal 'warning' (reposicao_disparo): sem o eixo de status, a piora seria muda.
  v_grav := (CASE p_sev_fin WHEN 'critico' THEN 3 WHEN 'aviso' THEN 2 ELSE 1 END) * 10
          + (CASE p_status  WHEN 'broken'  THEN 3 WHEN 'stale' THEN 2 ELSE 1 END);

  v_intervalo := CASE WHEN p_sev_fin = 'critico' THEN interval '24 hours'
                                                 ELSE interval '72 hours' END;

  -- ── 1) episódio NOVO ──────────────────────────────────────────────────────────────────────
  -- ⚠️ ANTI-FLAP — a cadência de e-mail é por (company,tipo), NÃO por episódio. Sem isto o
  -- desenho tem o furo ESPELHO do que corrige: um check que oscila ok↔degradado a cada tick
  -- resolve e reabre o episódio 48×/dia, e "episódio novo ⇒ e-mail" vira tempestade. O mesmo
  -- vale para o "dispensar" da UI, que tira a linha do índice parcial e faz o próximo tick
  -- abrir episódio novo. Consultamos o último ENQUEUE deste tipo ATRAVESSANDO episódios
  -- encerrados: a garantia passa a ser "no máximo 1 e-mail por cadência por tipo", com duas
  -- saídas legítimas — nunca notificado, ou pior do que o que já foi notificado.
  SELECT a.email_enfileirado_em, (a.contexto->>'_grav_email')::int
    INTO v_ult_email, v_ult_grav
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.email_enfileirado_em IS NOT NULL
   ORDER BY a.email_enfileirado_em DESC
   LIMIT 1;

  -- ⚠️ O anti-flap NÃO pode calar RECORRÊNCIA LEGÍTIMA. O que distingue os dois casos é o
  -- INTERVALO SAUDÁVEL: flapping fecha e reabre dentro de poucos ticks; um incidente que volta
  -- depois de horas de saúde é notícia nova e merece e-mail na hora. Sem este recorte, um
  -- pedido novo travando 2h depois de outro ser resolvido ficaria mudo até o lembrete de 72h —
  -- exatamente o tipo de silêncio que esta migration existe para acabar.
  SELECT (max(a.dismissed_at) > clock_timestamp() - v_janela_flap)
    INTO v_flap
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.dismissed_at IS NOT NULL;

  v_deve := v_ult_email IS NULL                                    -- nunca avisou este tipo
            OR (v_ult_grav IS NOT NULL AND v_grav > v_ult_grav)    -- voltou PIOR do que o avisado
            OR NOT COALESCE(v_flap, false)                         -- reabertura NÃO é oscilação
            OR clock_timestamp() >= v_ult_email + v_intervalo;     -- venceu a cadência

  -- clock_timestamp() (não now()): now() é o instante do BEGIN e a transação pode ter esperado
  -- lock/fila; um prazo relativo medido do BEGIN nasce vencido (money-path.md §2).
  INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto, email_enfileirado_em)
  VALUES (p_company, p_tipo, p_sev_fin, p_msg,
          COALESCE(p_ctx, '{}'::jsonb) || jsonb_build_object(
            '_fp',            p_fingerprint,
            '_fp_email',      CASE WHEN v_deve THEN p_fingerprint ELSE NULL END,
            '_grav_email',    CASE WHEN v_deve THEN v_grav        ELSE v_ult_grav END,
            '_sev_email',     CASE WHEN v_deve THEN p_sev_fin     ELSE NULL END,
            -- Silenciado pelo anti-flap: o lembrete herda o prazo do último e-mail REAL, para
            -- que o teto de silêncio siga sendo a cadência (24h/72h) e não o infinito.
            '_prox_email_em', to_jsonb(CASE WHEN v_deve THEN clock_timestamp() + v_intervalo
                                            ELSE v_ult_email + v_intervalo END),
            '_n_emails',      CASE WHEN v_deve THEN 1 ELSE 0 END,
            '_motivo_email',  CASE WHEN v_deve THEN 'episodio_novo' ELSE NULL END,
            'avaliado_em',    to_jsonb(clock_timestamp())),
          CASE WHEN v_deve THEN clock_timestamp() END)
  ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;

  IF FOUND THEN
    IF v_deve THEN
      INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
      VALUES (p_company, 'outro', v_sev_forn, p_titulo, COALESCE(p_msg_email, p_msg), 'pendente_notificacao');
      -- ⚠️ INSERT que "tem sucesso" com ZERO linhas (um BEFORE INSERT devolvendo NULL) deixaria
      -- o claim carimbado SEM e-mail — a "escrita que falha calada" do money-path.md §11.
      GET DIAGNOSTICS v_upd = ROW_COUNT;
      IF v_upd <> 1 THEN
        RAISE EXCEPTION 'outbox nao materializou a linha (% gravadas) para %', v_upd, p_tipo
          USING ERRCODE = '25000';
      END IF;
    END IF;
    RETURN v_deve;
  END IF;

  -- ── 2) episódio ABERTO ────────────────────────────────────────────────────────────────────
  -- FOR UPDATE trava a linha ANTES de decidir: uma 2ª sessão bloqueia aqui e, ao destravar,
  -- relê a linha JÁ carimbada (READ COMMITTED) ⇒ deve_notificar = false ⇒ 1 e-mail, não 2.
  SELECT * INTO v_row
    FROM public.fin_alertas
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL
   FOR UPDATE;

  -- Dispensa CONCORRENTE entre o INSERT e o SELECT: sem alerta aberto por trás, não se
  -- enfileira e-mail fantasma. ⚠️ LANÇA em vez de devolver `false` (achado Codex E2): o caller
  -- usa PERFORM e não lê o retorno, então um `false` aqui deixaria a fonte DEGRADADA terminar a
  -- rodada SEM episódio ativo e ainda assim carimbar `last_success_at`. Lançando, o isolamento
  -- por check conta a falha e o marcador de sucesso não avança — fail-closed.
  IF NOT FOUND THEN
    -- P0002 (no_data_found) de propósito: é falha LOCAL do check, e a classe 40 seria relançada
    -- como sistêmica pelo isolamento do watchdog, derrubando os outros 16 por uma corrida benigna.
    RAISE EXCEPTION 'episodio de % sumiu entre o INSERT e o lock (dispensa concorrente)', p_tipo
      USING ERRCODE = 'P0002';
  END IF;

  -- ⚠️ RE-LEITURA DEPOIS DO LOCK. A consulta lá em cima rodou ANTES de travar a linha, então
  -- numa corrida ela traz o valor PRÉ-concorrente: a sessão B veria v_ult_email NULL, concluiria
  -- "nunca avisou" e enfileiraria um 2º e-mail. Sob READ COMMITTED, reler após o FOR UPDATE
  -- devolve o que a sessão A commitou — é isto que faz o claim ser de fato atômico.
  SELECT a.email_enfileirado_em, (a.contexto->>'_grav_email')::int
    INTO v_ult_email, v_ult_grav
    FROM public.fin_alertas a
   WHERE a.company = p_company AND a.tipo = p_tipo AND a.email_enfileirado_em IS NOT NULL
   ORDER BY a.email_enfileirado_em DESC
   LIMIT 1;

  v_fp_ant     := v_row.contexto->>'_fp';
  v_fp_email   := v_row.contexto->>'_fp_email';
  -- ⚠️ SEM COALESCE(...,0) de propósito: gravidade AUSENTE é desconhecida, não zero — o
  -- `ausente ≠ zero` do money-path. Com o zero, toda linha HISTÓRICA (contexto sem as âncoras
  -- novas, como os 3 alertas presos de prod) entraria como "escalada" e passaria por cima de
  -- reconhecimento e soneca. Quem nunca notificou não escalou nada: quem trata esse caso é o
  -- ramo `nunca_enfileirou`, que respeita ack/soneca.
  v_grav_email := (v_row.contexto->>'_grav_email')::int;
  v_prox       := CASE WHEN jsonb_typeof(v_row.contexto->'_prox_email_em') = 'string'
                       THEN (v_row.contexto->>'_prox_email_em')::timestamptz END;

  v_ack    := v_row.acknowledged_at IS NOT NULL;
  v_snooze := v_row.dismissed_until IS NOT NULL AND v_row.dismissed_until > clock_timestamp();

  -- ⚠️ REARME NA RECUPERAÇÃO (padrão do tint; a 1ª versão desta migration ESQUECEU de portá-lo e
  -- o Codex pegou). A âncora é o PICO notificado, então sem rearme: broken(23) avisa → melhora
  -- para stale(22) → humano reconhece → volta a broken(23) e `23 > 23` é FALSO ⇒ o ack bloqueia
  -- materialidade e lembrete, e o retorno ao mesmo patamar fica MUDO PARA SEMPRE. Fazendo a
  -- âncora DESCER junto com a melhora, o retorno volta a ser escalada — e escalada supera ack.
  IF v_grav_email IS NOT NULL AND v_grav < v_grav_email THEN
    v_grav_email := v_grav;
  END IF;

  v_escalou := v_grav_email IS NOT NULL AND v_grav > v_grav_email;

  -- ⚠️ "nunca enfileirou" é por TIPO, não por EPISÓDIO (v_ult_email vem da consulta acima, que
  -- atravessa episódios encerrados). Ancorar no episódio faria o anti-flap durar UMA rodada: o
  -- episódio reaberto e silenciado teria email_enfileirado_em NULL e emitiria no tick seguinte,
  -- devolvendo a tempestade pela porta dos fundos.
  v_nunca   := v_ult_email IS NULL;

  -- MATERIALIDADE com confirmação em DUAS avaliações: só conta violação nova cujo fingerprint
  -- se REPETIU (p_fingerprint = _fp da avaliação anterior) e que difere do último NOTIFICADO.
  -- É o que torna a máquina imune a um `message` volátil sem precisar auditar os 17 checks:
  -- fingerprint que muda toda rodada nunca se confirma ⇒ nunca vira e-mail.
  -- `v_fp_email IS NOT NULL` é o par do bullet acima: sem ele, o episódio silenciado pelo
  -- anti-flap (que grava _fp_email NULL) veria "IS DISTINCT FROM NULL" = true e emitiria.
  -- ⚠️ COOLDOWN (achado Codex): a confirmação em 2 avaliações mata `A,B,A,B`, mas NÃO mata
  -- `A,A,B,B,A,A…` — cada par confirma e emite, ~24 e-mails/dia. A confirmação prova repetição
  -- textual, não estabilidade temporal, então o teto tem de ser um RELÓGIO. 4h limita a ~6/dia
  -- no pior caso patológico e ainda reporta violação nova MUITO antes do lembrete (24h/72h).
  v_material := p_fingerprint IS NOT NULL
                AND v_fp_ant IS NOT NULL
                AND v_fp_email IS NOT NULL
                AND p_fingerprint = v_fp_ant
                AND p_fingerprint IS DISTINCT FROM v_fp_email
                AND (v_ult_email IS NULL OR clock_timestamp() >= v_ult_email + v_min_material);

  -- `v_prox IS NULL` = linha SEM as âncoras novas (histórica, ou escrita por versão anterior)
  -- que JÁ tem carimbo de e-mail: sem este bootstrap ela cai em nunca=false, escalou=false,
  -- material=false e lembrete=false — muda para sempre (achado Codex A1). Tratar como lembrete
  -- DEVIDO dá exatamente um e-mail; depois dele as âncoras existem e a cadência assume.
  v_lembrete := v_prox IS NULL OR clock_timestamp() >= v_prox;

  -- Escalada SUPERA reconhecimento e soneca: quem reconheceu um 'aviso' não reconheceu o
  -- 'critico' que veio depois.
  v_deve := v_escalou
            OR ((NOT v_ack) AND (NOT v_snooze) AND (v_nunca OR v_material OR v_lembrete));

  v_motivo := CASE WHEN NOT v_deve   THEN NULL
                   WHEN v_escalou    THEN 'escalada'
                   WHEN v_nunca      THEN 'nunca_enfileirou'
                   WHEN v_material   THEN 'nova_violacao'
                   ELSE                   'lembrete' END;

  -- UPDATE INCONDICIONAL do estado (padrão do tint): o banco reflete SEMPRE o ciclo atual —
  -- uma MELHORA parcial que não atualizasse nada deixaria o alerta mostrando o pico para sempre.
  -- O que a histerese governa é só o E-MAIL.
  UPDATE public.fin_alertas SET
      severidade           = p_sev_fin,
      mensagem             = p_msg,
      acknowledged_at      = CASE WHEN v_escalou THEN NULL ELSE acknowledged_at END,
      acknowledged_by      = CASE WHEN v_escalou THEN NULL ELSE acknowledged_by END,
      email_enfileirado_em = CASE WHEN v_deve THEN clock_timestamp() ELSE email_enfileirado_em END,
      contexto = COALESCE(p_ctx, '{}'::jsonb) || jsonb_build_object(
          '_fp',            p_fingerprint,
          '_fp_ant',        v_fp_ant,
          '_fp_email',      CASE WHEN v_deve THEN p_fingerprint ELSE v_fp_email END,
          '_grav_email',    CASE WHEN v_deve THEN v_grav        ELSE v_grav_email END,
          '_sev_email',     CASE WHEN v_deve THEN p_sev_fin     ELSE v_row.contexto->>'_sev_email' END,
          -- COALESCE no ELSE: sem ele uma linha sem âncora que NÃO emitiu (ack/soneca) ficaria
          -- com _prox_email_em NULL para sempre, e o bootstrap do lembrete nunca se resolveria.
          '_prox_email_em', CASE WHEN v_deve THEN to_jsonb(clock_timestamp() + v_intervalo)
                                 ELSE COALESCE(v_row.contexto->'_prox_email_em',
                                               to_jsonb(clock_timestamp() + v_intervalo)) END,
          '_n_emails',      COALESCE((v_row.contexto->>'_n_emails')::int, 0)
                            + CASE WHEN v_deve THEN 1 ELSE 0 END,
          '_motivo_email',  v_motivo,
          'avaliado_em',    to_jsonb(clock_timestamp()))
   WHERE company = p_company AND tipo = p_tipo AND dismissed_at IS NULL;

  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd = 0 THEN
    RETURN false;
  END IF;

  IF v_deve THEN
    -- MESMA transação do carimbo: se o outbox falhar, o claim cai junto — nunca
    -- "email_enfileirado_em preenchido sem e-mail correspondente".
    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
    VALUES (p_company, 'outro', v_sev_forn,
            CASE WHEN v_escalou THEN 'AGRAVOU: ' || p_titulo ELSE p_titulo END,
            COALESCE(p_msg_email, p_msg), 'pendente_notificacao');
    GET DIAGNOSTICS v_upd = ROW_COUNT;
    IF v_upd <> 1 THEN
      RAISE EXCEPTION 'outbox nao materializou a linha (% gravadas) para %', v_upd, p_tipo
        USING ERRCODE = '25000';
    END IF;
    RETURN true;
  END IF;

  RETURN false;
END;
$function$
;
CREATE OR REPLACE FUNCTION public._tint_cobertura_bases_lista_email(p_limit integer DEFAULT 50)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH itens AS (
    SELECT op.codigo, op.descricao,
           CASE WHEN op.is_tintometric IS NOT TRUE
                THEN 'sem is_tintometric (some do mapeamento)'
                ELSE 'tint_type "' || COALESCE(op.tint_type, '∅') || '" deveria ser "'
                     || CASE lower(btrim(op.familia))
                          WHEN 'bases mixmachine' THEN 'base'
                          WHEN 'concentrados mixmachine' THEN 'concentrado' END
                     || '" (aba trocada)'
           END AS motivo,
           row_number() OVER (ORDER BY op.familia, op.descricao, op.codigo) AS rn
    FROM public.omie_products op
    WHERE op.account = 'oben' AND op.ativo = true
      AND lower(btrim(op.familia)) IN ('bases mixmachine','concentrados mixmachine')
      AND op.created_at < now() - interval '30 hours'
      AND ( op.is_tintometric IS NOT TRUE
         OR op.tint_type IS DISTINCT FROM CASE lower(btrim(op.familia))
              WHEN 'bases mixmachine' THEN 'base'
              WHEN 'concentrados mixmachine' THEN 'concentrado' END )
  ),
  agg AS (
    SELECT
      count(*)::int AS n_total,
      count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados,
      string_agg(
        CASE WHEN rn <= GREATEST(p_limit, 0)
             THEN '• ' || descricao || ' (cód. ' || codigo || ') — ' || motivo
             ELSE NULL END,
        E'\n' ORDER BY rn) AS corpo
    FROM itens
  )
  SELECT CASE
    WHEN n_total = 0 THEN NULL
    ELSE 'Bases/concentrados MixMachine divergentes (corrija no Omie ou rode tint_marcar_bases_mixmachine):'
         || E'\n' || corpo
         || CASE WHEN n_total > n_mostrados
                 THEN E'\n… e mais ' || (n_total - n_mostrados)::text || ' item(ns) — veja no painel Saúde de Dados.'
                 ELSE '' END
  END
  FROM agg;
$function$
;
CREATE OR REPLACE FUNCTION public._vendas_familia_ausente_lista_email(p_limit integer DEFAULT 50)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH itens AS (
    SELECT account, codigo, descricao,
           row_number() OVER (ORDER BY account, descricao, codigo) AS rn
    FROM public.omie_products
    WHERE NULLIF(btrim(familia), '') IS NULL
      AND COALESCE(ativo, false)
      AND account IN ('oben','colacor')
  ),
  agg AS (
    SELECT
      count(*)::int AS n_total,
      count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados,
      string_agg(
        CASE WHEN rn <= GREATEST(p_limit, 0)
             THEN '• [' || account || '] ' || descricao || ' (cód. ' || codigo || ')'
             ELSE NULL END,
        E'\n' ORDER BY rn) AS corpo
    FROM itens
  )
  SELECT CASE
    WHEN n_total = 0 THEN NULL
    ELSE 'Produtos sem família (classifique no Omie):' || E'\n' || corpo
         || CASE WHEN n_total > n_mostrados
                 THEN E'\n… e mais ' || (n_total - n_mostrados)::text
                      || ' produto(s) — veja no painel Saúde de Dados ou filtre no Omie por família vazia.'
                 ELSE '' END
  END
  FROM agg;
$function$
;

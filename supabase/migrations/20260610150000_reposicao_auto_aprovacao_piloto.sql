-- Reposição N3 — auto-aprovação Sayerlack com piloto de veto
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md
--
-- Estende o tick do alerta R$3k (20260609150000) com um braço de AUTO-APROVAÇÃO:
-- pedido Sayerlack pendente >= régua que passa no estrato de segurança é aprovado
-- pela máquina (aprovado_por = 'auto:sayerlack-v1') e o e-mail vira INFORMATIVO
-- ("aprovei; pra vetar, cancele até o corte"). Pedido inelegível segue o fluxo
-- atual (e-mail "vá aprovar"). O DISPARO não muda nesta fase: o pedido aprovado
-- espera o cron de corte em lote — essa espera É a janela de veto do piloto.
--
-- Estrato (spec §4.2): ciclo normal · sem split · >= R$3k (mesma régua do alerta/
-- gate) · itens sãos · sem ajuste humano · sem falha recente de auto-aprovado do
-- fornecedor (cooldown) · delta <= 30% vs último disparo REAL do mesmo
-- (fornecedor, grupo) nos últimos 90d — computado AO VIVO (pedido_anterior_valor
-- nunca foi populado pela RPC; classificador do Cockpit é inerte — spec §3).
--
-- Guard-rails: fusível company_config (nasce OFF) · auto-suspensão se o Sentinela
-- tem alerta ATIVO de reposição · janela de horário (>=45min antes do corte; pedido
-- da tarde espera a regeneração da manhã seguinte — zumbis expiram, [INTRADAY 2/4])
-- · claim condicional (corrida com humano: quem chegar primeiro) · log de auditoria.
--
-- ⚠️ Migration MANUAL (Lovable): colar no SQL Editor → Run. Validação no fim.
-- ⚠️ Tick = corpo VERBATIM da 20260609150000 + marcas [AUTO 1/4..4/4].

BEGIN;

-- ── A) Configs do piloto (text key/value, cast com guard+CLAMP na leitura) ───
-- ativa nasce 'false': o founder liga com o BLOCO B do rollout, quando quiser.
-- ⚠️ Codex P1.5: o parsing no tick CLAMPA cada config (delta_max ∈ (0, 0.30];
-- cooldown >= 1; corte 00:00–23:59) — fora da faixa = braço OFF (fail-safe). Um typo
-- '30' (=3000%) ou '0' (cooldown nulo) NÃO liga a automação com parâmetro perigoso.
INSERT INTO public.company_config (key, value) VALUES
  ('reposicao_auto_aprovacao_ativa', 'false'),
  ('reposicao_auto_aprovacao_delta_max', '0.30'),
  ('reposicao_auto_aprovacao_cooldown_falha_horas', '48'),
  ('reposicao_auto_aprovacao_corte_utc', '13:00')
ON CONFLICT (key) DO NOTHING;

-- ── B) Log de auditoria (append-only, SEM FK — snapshot desacoplado) ─────────
CREATE TABLE IF NOT EXISTS public.reposicao_auto_aprovacao_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id bigint NOT NULL,
  empresa text NOT NULL,
  fornecedor_nome text NOT NULL,
  grupo_codigo text NOT NULL DEFAULT '',
  valor_total numeric NOT NULL,
  valor_anterior numeric,
  delta_pct numeric,
  regua numeric NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reposicao_auto_aprovacao_log_criado_em
  ON public.reposicao_auto_aprovacao_log (criado_em DESC);

ALTER TABLE public.reposicao_auto_aprovacao_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff lê log de auto-aprovação" ON public.reposicao_auto_aprovacao_log;
CREATE POLICY "Staff lê log de auto-aprovação" ON public.reposicao_auto_aprovacao_log
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('employee','master')
  ));
-- Escrita: só o tick (SECURITY DEFINER) / service_role (bypassa RLS). Sem policy de INSERT.

-- ── C) Elegibilidade (função separada = testável isoladamente no PG17) ───────
-- Retorna jsonb {elegivel, motivo?, valor_anterior?, delta_pct?, valor_itens?}.
-- VOLATILE (não STABLE): trava o pedido FOR UPDATE p/ fechar o TOCTOU (Codex P1.2) —
-- o lock persiste na transação do tick até o claim, então nada muda valor/itens entre
-- a validação e a aprovação. O motivo não é consumido pelo tick (inelegível segue o
-- fluxo humano), mas é ouro pra teste/debug via SELECT direto.
--
-- Codex folds: P1.1 OBEN-only · P1.2 FOR UPDATE + valor recalculado dos ITENS (não do
-- cabeçalho — o disparo manda os itens [edge:748], cabeçalho pode divergir) · P1.3
-- rejeita item em promoção · P1.4 referência AGREGADA por grupo×data_ciclo (colapsa o
-- pré-split em filhos) · P1.6 no máx. 1 auto-aprovado não-disparado por grupo · P2.7
-- cooldown enxerga falha de PORTAL · P2.11 guard de item rejeita NaN/Infinity.
CREATE OR REPLACE FUNCTION public.reposicao_pedido_auto_aprovavel(
  p_pedido_id bigint,
  p_threshold numeric,
  p_delta_max numeric,
  p_cooldown_horas numeric
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  p RECORD;
  v_grupo text;
  v_valor numeric;     -- valor REAL (soma dos itens) — fonte de verdade do disparo
  v_ant numeric;       -- referência agregada do grupo (última compra)
  v_delta numeric;
BEGIN
  -- P1.2: trava a linha. Qualquer promo/regeneração/aprovação concorrente espera este
  -- lock; o claim do tick (mesma transação) vê o estado que esta função validou.
  SELECT * INTO p FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'pedido inexistente');
  END IF;

  -- P1.1: piloto é OBEN-only (spec §1). Sayerlack de outra empresa fica humano.
  IF p.empresa <> 'OBEN' THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'fora do escopo do piloto (só OBEN)');
  END IF;

  IF p.status <> 'pendente_aprovacao' OR p.aprovado_em IS NOT NULL OR p.cancelado_em IS NOT NULL THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'não está pendente');
  END IF;

  IF COALESCE(p.tipo_ciclo, 'normal') <> 'normal' THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'ciclo não-normal (oportunidade/promoção é decisão humana)');
  END IF;

  IF p.split_parent_id IS NOT NULL THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'pedido-filho de split');
  END IF;

  IF COALESCE(p.num_skus, 0) <= 0 THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'sem SKUs');
  END IF;

  v_grupo := COALESCE(p.grupo_codigo, '');

  -- P1.3: promoção (forward_buying mantém tipo_ciclo='normal' → não pega no filtro acima)
  -- é decisão humana no piloto. Qualquer item com modo_promocao veta.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id AND i.modo_promocao IS NOT NULL
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'item em promoção (decisão humana)');
  END IF;

  -- P2.11: guard de item que o disparo (#422/#433) barraria. Forma POSITIVA (> 0 AND <
  -- Infinity) p/ rejeitar também NaN/Infinity — "preco<=0" é FALSE p/ NaN e não pegaria.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id
      AND NOT (i.preco_unitario > 0 AND i.preco_unitario < 'Infinity'::numeric
               AND i.qtde_final > 0 AND i.qtde_final < 'Infinity'::numeric)
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'item com preço/qtde inválido');
  END IF;

  -- P1.2: o VALOR que importa é o que será comprado = soma dos itens, NÃO o cabeçalho
  -- (valor_total pode divergir; o disparo manda os itens). A régua vale sobre ele.
  SELECT SUM(i.qtde_final * i.preco_unitario) INTO v_valor
  FROM public.pedido_compra_item i WHERE i.pedido_id = p.id;
  IF v_valor IS NULL OR NOT (v_valor > 0 AND v_valor < 'Infinity'::numeric) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'sem itens válidos para somar');
  END IF;
  IF v_valor < p_threshold THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'abaixo da régua (soma dos itens)');
  END IF;

  -- Humano já mexeu → a decisão é dele (trade-off "ajustou → aprova" do #711).
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id AND i.ajustado_humano IS TRUE
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'itens ajustados por humano');
  END IF;

  -- P2.7: cooldown enxerga falha de DISPARO (status='falha_envio') E de PORTAL
  -- (status_envio_portal terminal/ambíguo — SKU sem de-para vira 'erro_nao_retentavel'
  -- sem mexer no status principal). Auto-aprovado do fornecedor que falhou há pouco →
  -- exceção humana resolve antes de a automação voltar ao fornecedor.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_sugerido f
    WHERE f.empresa = p.empresa
      AND f.fornecedor_nome = p.fornecedor_nome
      AND f.aprovado_por LIKE 'auto:%'
      AND (f.status = 'falha_envio'
           OR f.status_envio_portal IN ('erro_nao_retentavel', 'falha_envio_portal', 'indeterminado_requer_conciliacao'))
      AND f.atualizado_em > now() - (p_cooldown_horas * interval '1 hour')
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'cooldown: auto-aprovação recente do fornecedor falhou (disparo/portal)');
  END IF;

  -- P1.6: raio cumulativo — no MÁXIMO 1 auto-aprovado não-disparado por grupo. Sem isto,
  -- N pedidos de SKUs novos do grupo passam cada um contra a mesma referência antiga e a
  -- exposição antes do corte vira ilimitada. O 2º espera o 1º disparar (e virar referência).
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_sugerido q
    WHERE q.empresa = p.empresa
      AND q.fornecedor_nome = p.fornecedor_nome
      AND COALESCE(q.grupo_codigo, '') = v_grupo
      AND q.aprovado_por LIKE 'auto:%'
      AND q.status = 'aprovado_aguardando_disparo'
      AND q.id <> p.id
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'já há auto-aprovado do grupo aguardando disparo');
  END IF;

  -- P1.4: referência de delta = AGREGADO do grupo na data_ciclo de compra MAIS RECENTE
  -- (<90d). Soma por data_ciclo colapsa o pré-split (pai R$8k → 2 filhos R$4k disparados
  -- na mesma data): senão o delta compararia contra UM filho de R$4k e passaria onde o
  -- agregado R$8k deveria bloquear. A condição de compra-real exclui o pai split_em_filhos
  -- (sem omie_numero) e soma só os filhos disparados.
  SELECT SUM(r.valor_total) INTO v_ant
  FROM public.pedido_compra_sugerido r
  WHERE r.empresa = p.empresa
    AND r.fornecedor_nome = p.fornecedor_nome
    AND COALESCE(r.grupo_codigo, '') = v_grupo
    AND r.id <> p.id
    AND r.criado_em > now() - interval '90 days'
    AND (r.omie_pedido_compra_numero IS NOT NULL OR r.status IN ('disparado', 'concluido_recebido'))
    AND r.data_ciclo = (
      SELECT MAX(r2.data_ciclo)
      FROM public.pedido_compra_sugerido r2
      WHERE r2.empresa = p.empresa
        AND r2.fornecedor_nome = p.fornecedor_nome
        AND COALESCE(r2.grupo_codigo, '') = v_grupo
        AND r2.id <> p.id
        AND r2.criado_em > now() - interval '90 days'
        AND (r2.omie_pedido_compra_numero IS NOT NULL OR r2.status IN ('disparado', 'concluido_recebido'))
    );

  IF v_ant IS NULL OR NOT (v_ant > 0 AND v_ant < 'Infinity'::numeric) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'sem disparo de referência do grupo em 90d');
  END IF;

  v_delta := abs(v_valor - v_ant) / v_ant;   -- candidato pela soma dos itens
  IF v_delta > p_delta_max THEN
    RETURN jsonb_build_object('elegivel', false,
      'motivo', 'delta ' || round(v_delta * 100, 1)::text || '% > máx ' || round(p_delta_max * 100)::text || '%',
      'valor_anterior', v_ant,
      'delta_pct', round(v_delta * 100, 1));
  END IF;

  RETURN jsonb_build_object('elegivel', true,
    'valor_anterior', v_ant,
    'delta_pct', round(v_delta * 100, 1),
    'valor_itens', v_valor);
END;
$$;

REVOKE ALL ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric, numeric) TO service_role;

-- ── D) Tick estendido (corpo VERBATIM da 20260609150000 + marcas [AUTO]) ─────
CREATE OR REPLACE FUNCTION public.reposicao_alerta_pedido_minimo_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_threshold numeric;
  v_fornecedor text;
  r RECORD;
  -- [AUTO 1/4] estado do braço de auto-aprovação
  v_txt text;
  v_auto_on boolean := false;
  v_delta_max numeric;
  v_cooldown numeric;
  v_corte time;
  v_suspenso boolean := false;
  v_dentro_janela boolean := false;
  v_min_agora int;
  v_min_corte int;
  v_elig jsonb;
  v_auto_ok boolean;
  v_valor_auto numeric;  -- [AUTO] valor REAL (soma dos itens) do pedido auto-aprovado
BEGIN
  -- [AUTO 1/4] Codex P2.9: serializa execuções do tick (cron */30 + hook pós-geração).
  -- Sem isto, dois ticks concorrentes não duplicam compra/log (o claim condicional cobre),
  -- mas o perdedor pode re-inserir estado ativo e mandar CTA "pronto pra aprovar" pra um
  -- pedido que o vencedor já auto-aprovou. xact-lock libera no COMMIT. Benigno pro alerta.
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_alerta_pedido_minimo_tick'));

  SELECT value::numeric INTO v_threshold
  FROM public.company_config WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  SELECT value INTO v_fornecedor
  FROM public.company_config WHERE key = 'reposicao_alerta_pedido_fornecedor_ilike';

  -- Config ausente/inválida = alerta DESLIGADO (régua comercial, não segurança). Sem alerta
  -- fabricado com régua 0.
  IF v_threshold IS NULL OR v_threshold <= 0
     OR v_fornecedor IS NULL OR btrim(v_fornecedor) = '' THEN
    RETURN;
  END IF;

  -- [AUTO 1/4] configs do braço de auto-aprovação. Config quebrada → braço OFF
  -- (fail-safe: o alerta call-to-action continua; nunca aprova com parâmetro inválido).
  SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_ativa';
  v_auto_on := (v_txt = 'true');
  IF v_auto_on THEN
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_delta_max';
    IF v_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN v_delta_max := v_txt::numeric; END IF;
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_cooldown_falha_horas';
    IF v_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN v_cooldown := v_txt::numeric; END IF;
    -- Codex P1.5/P2.8: regex de range ESTRITO 00:00–23:59. '24:00'::time é ACEITO pelo
    -- PostgreSQL (=24:00:00) e aprovaria depois do cron real → órfão; o regex frouxo
    -- '[0-9]{1,2}:[0-9]{2}' deixava passar. '25:00'/'99:99' não casam → v_corte NULL → OFF.
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_corte_utc';
    IF v_txt ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN v_corte := v_txt::time; END IF;
    -- Codex P1.5: CLAMP de faixa segura. delta_max fora de (0, 0.30], cooldown < 1, ou
    -- corte inválido → braço OFF. Um typo '30' (=3000%) ou '0' não liga a automação.
    IF v_delta_max IS NULL OR v_delta_max <= 0 OR v_delta_max > 0.30
       OR v_cooldown IS NULL OR v_cooldown < 1
       OR v_corte IS NULL THEN
      v_auto_on := false;
    END IF;
  END IF;

  IF v_auto_on THEN
    -- Auto-suspensão: autonomia NÃO roda com o vigia acusando problema no domínio
    -- (spec §4.5). O tipo 'reposicao_pedido_minimo' (este próprio fluxo) NÃO suspende.
    v_suspenso := EXISTS (
      SELECT 1 FROM public.fin_alertas fa
      WHERE fa.dismissed_at IS NULL
        AND fa.tipo IN ('data_health_reposicao_disparo',
                        'data_health_reposicao_portal_pipeline',
                        'data_health_reposicao_portal_humano',
                        'data_health_reposicao_sugestoes')
    );

    -- Janela de horário: só aprova com >= 45min até o corte de disparo (a espera
    -- até o corte É a janela de veto). Aritmética em minutos UTC — sem wrap de time.
    -- Pedido que cruzar a régua DEPOIS do corte espera a regeneração da manhã
    -- ([INTRADAY 2/4] expira o zumbi e recria) e é avaliado no tick seguinte.
    v_min_agora := EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int * 60
                 + EXTRACT(MINUTE FROM (now() AT TIME ZONE 'UTC'))::int;
    v_min_corte := EXTRACT(HOUR FROM v_corte)::int * 60 + EXTRACT(MINUTE FROM v_corte)::int;
    v_dentro_janela := v_min_agora <= (v_min_corte - 45);
  END IF;

  -- 1) NOVOS: pedido pendente ≥ régua do fornecedor configurado, sem alerta ativo → grava
  -- estado + enfileira e-mail (só na transição). Agrupo por (empresa, fornecedor, grupo)
  -- por defesa (a identidade pode ter 2 linhas transitórias: zumbi de ontem + hoje, pré-PR2).
  FOR r IN
    SELECT pcs.empresa, pcs.fornecedor_nome,
           COALESCE(pcs.grupo_codigo, '') AS grupo_codigo,
           MAX(pcs.valor_total) AS valor,
           SUM(COALESCE(pcs.num_skus, 0)) AS num_skus,
           MAX(pcs.id) AS pedido_id,
           COUNT(*) AS qtd_pendentes  -- [AUTO 2/4] >1 = estado anômalo (zumbi) → humano
    FROM public.pedido_compra_sugerido pcs
    WHERE pcs.status = 'pendente_aprovacao'
      AND pcs.fornecedor_nome ILIKE v_fornecedor
      AND pcs.valor_total >= v_threshold
    GROUP BY 1, 2, 3
  LOOP
    -- [AUTO 3/4] tenta a auto-aprovação ANTES de decidir qual e-mail sai. Claim
    -- condicional: corrida com aprovação humana → quem chegar primeiro vence; o
    -- perdedor não loga nem manda e-mail duplicado (FOUND = false).
    v_auto_ok := false;
    v_valor_auto := NULL;
    IF v_auto_on AND NOT v_suspenso AND v_dentro_janela AND r.qtd_pendentes = 1 THEN
      -- passa a régua (threshold) — a função valida a soma dos ITENS contra ela (P1.2).
      v_elig := public.reposicao_pedido_auto_aprovavel(r.pedido_id, v_threshold, v_delta_max, v_cooldown);
      IF COALESCE((v_elig->>'elegivel')::boolean, false) THEN
        UPDATE public.pedido_compra_sugerido
        SET aprovado_em = now(),
            aprovado_por = 'auto:sayerlack-v1',
            status = 'aprovado_aguardando_disparo'
        WHERE id = r.pedido_id
          AND status = 'pendente_aprovacao'
          AND aprovado_em IS NULL
          AND cancelado_em IS NULL;
        IF FOUND THEN
          v_auto_ok := true;
          -- valor REAL = soma dos itens (P1.2), não o cabeçalho r.valor que pode divergir.
          v_valor_auto := COALESCE((v_elig->>'valor_itens')::numeric, r.valor);
          INSERT INTO public.reposicao_auto_aprovacao_log
            (pedido_id, empresa, fornecedor_nome, grupo_codigo, valor_total,
             valor_anterior, delta_pct, regua)
          VALUES
            (r.pedido_id, r.empresa, r.fornecedor_nome, r.grupo_codigo, v_valor_auto,
             (v_elig->>'valor_anterior')::numeric, (v_elig->>'delta_pct')::numeric, v_threshold);
        END IF;
      END IF;
    END IF;

    INSERT INTO public.reposicao_alerta_pedido_minimo
      (empresa, fornecedor_nome, grupo_codigo, pedido_id, valor_alertado, valor_ultimo)
    VALUES (r.empresa, r.fornecedor_nome, r.grupo_codigo, r.pedido_id, r.valor, r.valor)
    ON CONFLICT (empresa, fornecedor_nome, grupo_codigo) WHERE resolvido_em IS NULL
    DO NOTHING;

    IF FOUND THEN
      -- [AUTO 4/4] transição: informativo (máquina aprovou) OU call-to-action (fluxo atual).
      IF v_auto_ok THEN
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Auto-aprovado: pedido ' || r.fornecedor_nome || ' de R$ ' || round(COALESCE(v_valor_auto, r.valor))::text,
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' atingiu R$ ' || round(COALESCE(v_valor_auto, r.valor))::text
            || ' (' || r.num_skus::text || ' SKUs) e foi APROVADO AUTOMATICAMENTE — piloto: delta '
            || COALESCE((v_elig->>'delta_pct')::text, '?') || '% vs último disparo do grupo (R$ '
            || COALESCE(round((v_elig->>'valor_anterior')::numeric)::text, '?')
            || '), dentro do limite. Dispara no próximo corte automático. Para VETAR, cancele em '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos) antes do corte. '
            || 'Fusível: company_config → reposicao_auto_aprovacao_ativa = false desliga o piloto.',
          'pendente_notificacao'
        );
      ELSE
        -- Transição: 1 e-mail. Link GENÉRICO pra tela (deep-link ?id= morreria na regeneração).
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Pedido ' || r.fornecedor_nome || ' atingiu R$ ' || round(r.valor)::text
            || ' — pronto pra aprovar',
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' acumulou R$ ' || round(r.valor)::text
            || ' (' || r.num_skus::text || ' SKUs) — acima do mínimo de faturamento (R$ '
            || round(v_threshold)::text || '). Aprovar dispara na hora: '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos). '
            || 'Quando você aprovar (ou o pedido sair da régua), este aviso re-arma sozinho.',
          'pendente_notificacao'
        );
      END IF;
    ELSE
      IF v_auto_ok THEN
        -- [AUTO 4/4] alerta call-to-action já estava ativo e a máquina aprovou AGORA
        -- (ex.: fusível ligado depois do alerta) → informativo é transição real.
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Auto-aprovado: pedido ' || r.fornecedor_nome || ' de R$ ' || round(COALESCE(v_valor_auto, r.valor))::text,
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' (R$ ' || round(COALESCE(v_valor_auto, r.valor))::text || ', ' || r.num_skus::text
            || ' SKUs) foi APROVADO AUTOMATICAMENTE — piloto: delta '
            || COALESCE((v_elig->>'delta_pct')::text, '?') || '% vs último disparo do grupo (R$ '
            || COALESCE(round((v_elig->>'valor_anterior')::numeric)::text, '?')
            || '). Dispara no próximo corte automático. Para VETAR, cancele em '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos) antes do corte. '
            || 'Fusível: company_config → reposicao_auto_aprovacao_ativa = false desliga o piloto.',
          'pendente_notificacao'
        );
      ELSE
        -- Alerta já ativo: só atualiza o último valor visto (3.2k→10k NÃO re-spamma; o valor
        -- vivo está no cockpit).
        UPDATE public.reposicao_alerta_pedido_minimo a
        SET valor_ultimo = r.valor, pedido_id = r.pedido_id
        WHERE a.empresa = r.empresa AND a.fornecedor_nome = r.fornecedor_nome
          AND a.grupo_codigo = r.grupo_codigo AND a.resolvido_em IS NULL;
      END IF;
    END IF;
  END LOOP;

  -- 2) RESOLVE (re-arma): alerta ativo sem pedido pendente ≥ régua correspondente — o founder
  -- aprovou/cancelou, o corte expirou, ou o valor caiu. O próximo pedido do grupo que cruzar a
  -- régua gera e-mail NOVO. (Sem filtro de fornecedor aqui de propósito: se o pattern da config
  -- mudar, alertas órfãos do pattern antigo resolvem sozinhos.)
  -- [AUTO] nota: pedido auto-aprovado sai de pendente NESTA execução → o estado da identidade
  -- resolve aqui embaixo no mesmo tick (vida curta, consistente; o informativo já saiu acima).
  UPDATE public.reposicao_alerta_pedido_minimo a
  SET resolvido_em = now()
  WHERE a.resolvido_em IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.pedido_compra_sugerido pcs
      WHERE pcs.empresa = a.empresa
        AND pcs.fornecedor_nome = a.fornecedor_nome
        AND COALESCE(pcs.grupo_codigo, '') = a.grupo_codigo
        AND pcs.status = 'pendente_aprovacao'
        AND pcs.valor_total >= v_threshold
    );
END;
$$;

-- Trava de execução (mesma da 20260609150000 — recriar função NÃO preserva grants implícitos
-- de versões antigas, mas re-declarar é idempotente e auto-documenta).
REVOKE ALL ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() TO service_role;

COMMIT;

-- Validação (rodar após o COMMIT):
-- SELECT 'AUTO-APROVACAO PILOTO OK' AS status,
--   (SELECT count(*) FROM company_config WHERE key LIKE 'reposicao_auto_aprovacao%') AS configs_4,
--   (SELECT count(*) FROM pg_tables WHERE tablename='reposicao_auto_aprovacao_log') AS tabela_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_pedido_auto_aprovavel') AS elegibilidade_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick') AS tick_1,
--   (SELECT CASE WHEN prosrc LIKE '%AUTO 3/4%' THEN 1 ELSE 0 END
--      FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick') AS tick_tem_braco_auto,
--   (SELECT value FROM company_config WHERE key='reposicao_auto_aprovacao_ativa') AS fusivel_off;

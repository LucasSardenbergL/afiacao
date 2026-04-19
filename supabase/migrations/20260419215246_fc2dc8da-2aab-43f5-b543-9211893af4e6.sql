-- Função para resolver outliers (aceitar/excluir/ignorar)
CREATE OR REPLACE FUNCTION public.resolver_outlier(
  p_evento_id bigint,
  p_decisao text,
  p_justificativa text DEFAULT NULL,
  p_usuario_email text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evento RECORD;
  v_novo_status text;
BEGIN
  IF p_decisao NOT IN ('aceitar', 'excluir', 'ignorar') THEN
    RAISE EXCEPTION 'Decisão inválida: %. Use aceitar/excluir/ignorar', p_decisao;
  END IF;

  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id;
  END IF;

  IF v_evento.status != 'pendente' THEN
    RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status;
  END IF;

  v_novo_status := CASE p_decisao
    WHEN 'aceitar' THEN 'aceito'
    WHEN 'excluir' THEN 'excluido'
    WHEN 'ignorar' THEN 'ignorado'
  END;

  UPDATE eventos_outlier
  SET status = v_novo_status,
      decidido_em = now(),
      decidido_por = p_usuario_email,
      justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;

  -- Se for excluir, registrar em observacoes_excluidas para que o cálculo estatístico ignore
  IF p_decisao = 'excluir' THEN
    INSERT INTO observacoes_excluidas (
      empresa, sku_codigo_omie, tipo_observacao, data_observacao,
      referencia_original, valor_excluido, excluido_por,
      evento_outlier_id, justificativa
    ) VALUES (
      v_evento.empresa,
      v_evento.sku_codigo_omie,
      CASE WHEN v_evento.tipo = 'venda_atipica' THEN 'venda' ELSE 'leadtime' END,
      v_evento.data_evento,
      COALESCE(v_evento.detalhes->>'nfe', v_evento.detalhes->>'pedido_compra', v_evento.id::text),
      v_evento.valor_observado,
      p_usuario_email,
      v_evento.id,
      p_justificativa
    )
    ON CONFLICT (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
    DO UPDATE SET
      valor_excluido = EXCLUDED.valor_excluido,
      excluido_por = EXCLUDED.excluido_por,
      justificativa = EXCLUDED.justificativa,
      excluido_em = now();
  END IF;

  RETURN jsonb_build_object(
    'evento_id', p_evento_id,
    'novo_status', v_novo_status,
    'decisao', p_decisao
  );
END;
$$;

-- Função para estimar impacto da exclusão de um outlier de venda
CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_evento RECORD;
  v_sigma_atual numeric;
  v_media_atual numeric;
  v_sigma_sem numeric;
  v_media_sem numeric;
  v_d numeric;
  v_lt numeric;
  v_z numeric := 1.65;
  v_em_atual numeric;
  v_em_sem numeric;
BEGIN
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Evento não encontrado');
  END IF;

  IF v_evento.tipo = 'venda_atipica' THEN
    -- σ atual (incluindo outlier)
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade)
    INTO v_media_atual, v_sigma_atual
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa
      AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days'
      AND quantidade > 0;

    -- σ sem o outlier
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade)
    INTO v_media_sem, v_sigma_sem
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa
      AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days'
      AND quantidade > 0
      AND NOT (data_emissao::date = v_evento.data_evento
               AND nfe_chave_acesso::text = COALESCE(v_evento.detalhes->>'nfe', ''));

    -- Pegar D e LT atuais
    SELECT demanda_media_diaria, lt_medio_dias_uteis
    INTO v_d, v_lt
    FROM sku_parametros
    WHERE empresa = v_evento.empresa
      AND sku_codigo_omie::text = v_evento.sku_codigo_omie
    LIMIT 1;

    v_d := COALESCE(v_d, v_media_atual);
    v_lt := COALESCE(v_lt, 10);

    -- Estoque mínimo simplificado: Z * σ * sqrt(LT)
    v_em_atual := CEIL(v_z * COALESCE(v_sigma_atual, 0) * SQRT(v_lt));
    v_em_sem := CEIL(v_z * COALESCE(v_sigma_sem, 0) * SQRT(v_lt));

    RETURN jsonb_build_object(
      'tipo', 'venda_atipica',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2),
      'em_atual', v_em_atual,
      'em_sem', v_em_sem,
      'delta_em', v_em_sem - v_em_atual,
      'd', v_d,
      'lt', v_lt
    );
  ELSE
    -- Lead time atípico
    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis)
    INTO v_media_atual, v_sigma_atual
    FROM sku_leadtime_history
    WHERE empresa::text = v_evento.empresa
      AND sku_codigo_omie::text = v_evento.sku_codigo_omie;

    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis)
    INTO v_media_sem, v_sigma_sem
    FROM sku_leadtime_history
    WHERE empresa::text = v_evento.empresa
      AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND NOT (data_pedido::date = v_evento.data_evento);

    RETURN jsonb_build_object(
      'tipo', 'lt_atipico',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2)
    );
  END IF;
END;
$$;

-- Permitir staff (admin/manager/employee) executar
REVOKE ALL ON FUNCTION public.resolver_outlier(bigint, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.estimar_impacto_exclusao_outlier(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolver_outlier(bigint, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.estimar_impacto_exclusao_outlier(bigint) TO authenticated;

-- RLS em eventos_outlier para staff visualizarem e atualizarem
ALTER TABLE public.eventos_outlier ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff pode ver outliers" ON public.eventos_outlier;
CREATE POLICY "Staff pode ver outliers"
ON public.eventos_outlier FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
);

DROP POLICY IF EXISTS "Staff pode atualizar outliers" ON public.eventos_outlier;
CREATE POLICY "Staff pode atualizar outliers"
ON public.eventos_outlier FOR UPDATE
TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
);

ALTER TABLE public.observacoes_excluidas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff pode ver observacoes excluidas" ON public.observacoes_excluidas;
CREATE POLICY "Staff pode ver observacoes excluidas"
ON public.observacoes_excluidas FOR SELECT
TO authenticated
USING (
  has_role(auth.uid(), 'admin'::app_role)
  OR has_role(auth.uid(), 'manager'::app_role)
  OR has_role(auth.uid(), 'employee'::app_role)
);
CREATE OR REPLACE FUNCTION public.simular_puxar_volume_trimestre(p_empresa text DEFAULT 'OBEN'::text, p_ano integer DEFAULT NULL::integer, p_trimestre integer DEFAULT NULL::integer, p_valor_extra numeric DEFAULT 0, p_prazo_pagamento_codigo text DEFAULT 'antecipado'::text, p_dias_estoque_extra integer DEFAULT 60)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ano int;
  v_trimestre int;
  v_posicao_atual numeric;
  v_posicao_com_extra numeric;
  v_faixa_atual record;
  v_faixa_nova record;
  v_desc_atual_total numeric;
  v_desc_novo_total numeric;
  v_delta_percentual numeric;
  v_projecao_proximo_trimestre numeric;
  v_ganho_proximo_trimestre numeric;
  v_perda_antecipado numeric;
  v_encargo_prazo numeric;
  v_custo_frete numeric;
  v_custo_capital numeric;
  v_cm_anual numeric;
  v_perda_total numeric;
  v_saldo_liquido numeric;
  v_prazo_atual record;
  v_prazo_novo record;
  v_checkin record;
  v_fator_inflacao_nominal numeric;
  v_nominal_adicional_na_nf numeric;
BEGIN
  -- Defaults: trimestre atual se não especificado
  v_ano := COALESCE(p_ano, EXTRACT(YEAR FROM CURRENT_DATE)::int);
  v_trimestre := COALESCE(p_trimestre, EXTRACT(QUARTER FROM CURRENT_DATE)::int);
  
  -- Posição atual
  SELECT posicao_ao_vivo_conservadora INTO v_posicao_atual
  FROM v_des_posicao_trimestre_ao_vivo
  WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre;
  
  IF v_posicao_atual IS NULL THEN v_posicao_atual := 0; END IF;
  
  -- Prazo de pagamento escolhido
  SELECT * INTO v_prazo_novo
  FROM fornecedor_prazo_pagamento_config
  WHERE empresa = p_empresa 
    AND fornecedor_nome = 'RENNER SAYERLACK S/A'
    AND codigo = p_prazo_pagamento_codigo;
  
  -- Prazo padrão (antecipado default)
  SELECT * INTO v_prazo_atual
  FROM fornecedor_prazo_pagamento_config
  WHERE empresa = p_empresa 
    AND fornecedor_nome = 'RENNER SAYERLACK S/A'
    AND padrao = true;
  
  -- Fator de inflação da NF: 
  -- - se prazo escolhido é antecipado, NF = valor pedido
  -- - se prazo é 28/42/56, NF = valor pedido × (1 + encargo_abs)
  -- encargo_abs = abs(desconto_ou_encargo_perc) / 100 se valor negativo
  v_fator_inflacao_nominal := 1.0;
  IF v_prazo_novo.desconto_ou_encargo_perc < 0 THEN
    v_fator_inflacao_nominal := 1.0 + (ABS(v_prazo_novo.desconto_ou_encargo_perc) / 100.0);
  END IF;
  
  -- Valor adicional na NF (o que conta para DES)
  v_nominal_adicional_na_nf := p_valor_extra * v_fator_inflacao_nominal;
  
  -- Nova posição
  v_posicao_com_extra := v_posicao_atual + v_nominal_adicional_na_nf;
  
  -- Faixas: atual e nova
  SELECT * INTO v_faixa_atual FROM des_determinar_faixa(v_posicao_atual);
  SELECT * INTO v_faixa_nova FROM des_determinar_faixa(v_posicao_com_extra);
  
  -- Checkin mais recente para saber quais qualitativos estão ativos
  SELECT * INTO v_checkin 
  FROM v_des_desconto_por_checkin
  WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre
  LIMIT 1;
  
  -- Desconto total atual (sem puxar)
  v_desc_atual_total := COALESCE(
    (SELECT desconto_total_projetado FROM v_des_desconto_por_checkin
     WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre),
    COALESCE(v_faixa_atual.desconto_padrao_perc, 0)
  );
  
  -- Desconto total na nova faixa (reaplica qualitativos do checkin)
  IF v_faixa_nova.faixa_id IS NOT NULL THEN
    v_desc_novo_total := v_faixa_nova.desconto_padrao_perc +
      COALESCE((
        SELECT SUM(cp.percentual)
        FROM des_checkin_qualitativo_resposta qr
        JOIN des_checkin_qualitativo ck ON ck.id = qr.checkin_id
        JOIN des_criterio_percentual cp 
          ON cp.criterio_id = qr.criterio_id 
         AND cp.faixa_id = v_faixa_nova.faixa_id
        WHERE qr.atingido = true
          AND ck.empresa = p_empresa 
          AND ck.ano = v_ano 
          AND ck.trimestre = v_trimestre
          AND ck.id = (SELECT MAX(id) FROM des_checkin_qualitativo 
                       WHERE empresa = p_empresa 
                         AND ano = v_ano 
                         AND trimestre = v_trimestre)
      ), 0);
  ELSE
    v_desc_novo_total := v_desc_atual_total;
  END IF;
  
  v_delta_percentual := v_desc_novo_total - v_desc_atual_total;
  
  -- Projeção de faturamento do próximo trimestre (meta pessoal)
  SELECT meta_faturamento INTO v_projecao_proximo_trimestre
  FROM des_meta_empresa
  WHERE empresa = p_empresa 
    AND ano = v_ano 
    AND trimestre = CASE WHEN v_trimestre = 4 THEN 1 ELSE v_trimestre + 1 END;
  
  IF v_projecao_proximo_trimestre IS NULL THEN
    -- Fallback: usa meta do trimestre corrente
    v_projecao_proximo_trimestre := COALESCE(
      (SELECT meta_faturamento FROM des_meta_empresa 
       WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre),
      400000
    );
  END IF;
  
  -- Ganho no próximo trimestre = delta_perc × projeção_próximo
  v_ganho_proximo_trimestre := (v_delta_percentual / 100.0) * v_projecao_proximo_trimestre;
  
  -- Perdas no pedido atual
  -- 1. Perda de antecipado (se mudou para prazo)
  v_perda_antecipado := 0;
  IF v_prazo_atual.codigo <> v_prazo_novo.codigo 
     AND v_prazo_atual.desconto_ou_encargo_perc > 0 THEN
    v_perda_antecipado := p_valor_extra * (v_prazo_atual.desconto_ou_encargo_perc / 100.0);
  END IF;
  
  -- 2. Encargo do prazo (se negativo)
  v_encargo_prazo := 0;
  IF v_prazo_novo.desconto_ou_encargo_perc < 0 THEN
    v_encargo_prazo := p_valor_extra * (ABS(v_prazo_novo.desconto_ou_encargo_perc) / 100.0);
  END IF;
  
  -- 3. Frete adicional sobre o valor extra
  v_custo_frete := p_valor_extra * (COALESCE(
    (SELECT valor FROM fornecedor_custo_adicional_config 
     WHERE empresa = p_empresa 
       AND fornecedor_nome = 'RENNER SAYERLACK S/A' 
       AND tipo = 'frete_perc_valor' 
       AND ativo = true LIMIT 1), 
    2.5
  ) / 100.0);
  
  -- 4. Custo de capital do estoque extra
  v_cm_anual := COALESCE(
    (SELECT (selic_anual + spread_oportunidade + armazenagem_fisica) / 100.0 
     FROM empresa_configuracao_custos WHERE empresa = p_empresa LIMIT 1),
    0.20
  );
  v_custo_capital := p_valor_extra * v_cm_anual * (p_dias_estoque_extra::numeric / 365.0);
  
  -- Perda total no pedido
  v_perda_total := v_perda_antecipado + v_encargo_prazo + v_custo_frete + v_custo_capital;
  
  -- Saldo líquido
  v_saldo_liquido := v_ganho_proximo_trimestre - v_perda_total;
  
  -- Retorno estruturado
  RETURN jsonb_build_object(
    'parametros', jsonb_build_object(
      'empresa', p_empresa,
      'ano', v_ano,
      'trimestre', v_trimestre,
      'valor_extra', p_valor_extra,
      'prazo_pagamento', p_prazo_pagamento_codigo,
      'dias_estoque_extra', p_dias_estoque_extra
    ),
    'posicao', jsonb_build_object(
      'atual', v_posicao_atual,
      'com_extra', v_posicao_com_extra,
      'nominal_adicional_na_nf', v_nominal_adicional_na_nf,
      'fator_inflacao', v_fator_inflacao_nominal
    ),
    'faixas', jsonb_build_object(
      'atual', row_to_json(v_faixa_atual),
      'nova', row_to_json(v_faixa_nova),
      'mudou_faixa', (COALESCE(v_faixa_atual.faixa_numero, 0) <> COALESCE(v_faixa_nova.faixa_numero, 0))
    ),
    'descontos', jsonb_build_object(
      'atual_total_perc', v_desc_atual_total,
      'novo_total_perc', v_desc_novo_total,
      'delta_perc', v_delta_percentual
    ),
    'projecao', jsonb_build_object(
      'proximo_trimestre_projetado', v_projecao_proximo_trimestre,
      'ganho_futuro_rs', ROUND(v_ganho_proximo_trimestre, 2)
    ),
    'perdas_pedido_atual', jsonb_build_object(
      'antecipado_rs', ROUND(v_perda_antecipado, 2),
      'encargo_prazo_rs', ROUND(v_encargo_prazo, 2),
      'frete_rs', ROUND(v_custo_frete, 2),
      'custo_capital_rs', ROUND(v_custo_capital, 2),
      'total_rs', ROUND(v_perda_total, 2)
    ),
    'saldo_liquido_rs', ROUND(v_saldo_liquido, 2),
    'recomendacao', CASE 
      WHEN v_saldo_liquido > 1000 THEN 'compensa'
      WHEN v_saldo_liquido > 0 THEN 'compensa_marginalmente'
      WHEN v_saldo_liquido > -1000 THEN 'indiferente'
      ELSE 'nao_compensa'
    END
  );
END;
$function$


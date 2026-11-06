-- DES: o simulador de "puxar volume" recusa quando a posição ou a meta do trimestre é desconhecida
-- (plano v6, lote 3c — follow-up do #3634).
--
-- simular_puxar_volume_trimestre lia posicao_ao_vivo_conservadora e fazia `IF NULL THEN 0`. Desde a
-- 20261105091216 a view devolve NULL quando não há faturado confirmado do GoodData no trimestre, e a RPC
-- transformava esse NULL em posição 0 — de onde saíam a faixa atual, o desconto, o ganho do próximo
-- trimestre e a recomendação ("compensa"/"não compensa"). Regra do repo (docs/agent/money-path.md §2):
-- ausente ≠ zero. Agora:
--   * sem faturado confirmado (ou sem linha na view) → P0001 'DES sem posicao confirmada'. Faturado 0 é
--     fato: a posição é o trânsito e a simulação segue;
--   * o "próximo trimestre" de T4 lia a meta de T1 do MESMO ano (um trimestre passado) → T1 do ano seguinte;
--   * sem meta do próximo trimestre nem do corrente, a projeção caía num 400000 fixo → P0001 'DES sem meta
--     para projetar'.
-- Medido na prod (psql-ro, 2026-11-05): metas OBEN 2026 T1..T4 = 400.840,02, nenhuma de 2027; só T2/26 tem
-- faturado. Com posição, o número de hoje não muda. O único chamador (SimulationPanel) já não chama sem
-- posição (#3634) e mostra o erro da RPC num toast.
--
-- Fora deste arquivo (follow-up): os fallbacks de custo 2,5% (frete) e 0,20 (capital) quando a configuração
-- não existe, e a escolha do check-in (a RPC usa MAX(id); a v_des_desconto_por_checkin, a data).
--
-- Mesma assinatura, defaults, retorno, search_path, SECURITY INVOKER e STABLE; CREATE OR REPLACE preserva
-- dono e ACL (a PÓS confere tudo contra o lido na PRE). Molde TRAVA → PRE → CREATE → PÓS
-- (.claude/skills/lovable-db-operator/references/sql-house-style.md). Sem BEGIN/COMMIT: aplica por
-- `bun run db:aplicar` (a transação é do executor). Pelo SQL Editor/MCP, envolver em BEGIN; … COMMIT;.

-- TRAVA: um ALTER prende a linha da função até o COMMIT. É COST 100 — o da prod e o que o CREATE OR REPLACE
-- abaixo reaplica (default de plpgsql) — porque a PRE NÃO o confere. Uma trava que reescrevesse um atributo
-- conferido (volatilidade, search_path) apagaria a deriva que outra sessão commitou entre a leitura e o ALTER,
-- e a PRE a aprovaria (2ª opinião Codex, estágio 2; K7 do teste).
DO $trava$
BEGIN
  IF to_regprocedure('public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)') IS NULL THEN
    RAISE EXCEPTION 'TRAVA: public.simular_puxar_volume_trimestre ausente — esta migration recria a função, não a cria';
  END IF;
  ALTER FUNCTION public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer) COST 100;
END
$trava$;

-- PRE: o corpo vivo é o da prod de 2026-11-05 (md5 do prosrc via psql-ro) ou já é este, e segue INVOKER,
-- STABLE, com o search_path da prod. Guarda ACL/config/dono/assinatura para a PÓS (GUC local à transação).
DO $pre$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)');
  IF p.oid IS NULL OR md5(p.prosrc) NOT IN ('50d0f4eaf68eb2aa1616296d3980efed', 'b41e1d3b7cfebcf3f02ddd9edec705d6') THEN
    RAISE EXCEPTION 'PRE FALHOU: simular_puxar_volume_trimestre viva (md5 %) não é a da prod de 2026-11-05 nem esta — outra sessão mudou a função; confira antes de recriar', md5(p.prosrc);
  END IF;
  IF p.prosecdef OR p.provolatile <> 's' OR p.proconfig::text IS DISTINCT FROM '{"search_path=public, pg_temp"}' THEN
    RAISE EXCEPTION 'PRE FALHOU: atributos da função mudaram (secdef %, volatilidade %, config %)', p.prosecdef, p.provolatile, p.proconfig;
  END IF;
  PERFORM set_config('afiacao.simular_puxar_antes',
    COALESCE(p.proacl::text, 'NULO') || '|' || COALESCE(p.proconfig::text, 'NULO') || '|' ||
           pg_catalog.pg_get_userbyid(p.proowner) || '|' || pg_catalog.pg_get_function_arguments(p.oid) || '|' ||
           pg_catalog.pg_get_function_result(p.oid), true);
END
$pre$;

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
  v_fat_confirmado numeric;
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
  
  -- Posição atual. Sem faturado confirmado do GoodData ela é DESCONHECIDA (a view devolve NULL desde
  -- 20261105091216; sem linha na view, idem): simular a partir de 0 inventaria a faixa, o ganho e a
  -- recomendação. Recusa. Faturado 0 é fato (início de trimestre): a posição é o trânsito, e simula.
  SELECT fat_bruto_confirmado, posicao_ao_vivo_conservadora
    INTO v_fat_confirmado, v_posicao_atual
  FROM v_des_posicao_trimestre_ao_vivo
  WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre;

  IF v_fat_confirmado IS NULL THEN
    RAISE EXCEPTION 'DES sem posicao confirmada: % T%/% sem faturado confirmado do GoodData — a simulação partiria de uma posição inventada', p_empresa, v_trimestre, v_ano;
  END IF;
  
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
  
  -- Projeção de faturamento do próximo trimestre (meta pessoal). Depois de T4 vem T1 do ano SEGUINTE.
  SELECT meta_faturamento INTO v_projecao_proximo_trimestre
  FROM des_meta_empresa
  WHERE empresa = p_empresa
    AND ano = CASE WHEN v_trimestre = 4 THEN v_ano + 1 ELSE v_ano END
    AND trimestre = CASE WHEN v_trimestre = 4 THEN 1 ELSE v_trimestre + 1 END;
  
  IF v_projecao_proximo_trimestre IS NULL THEN
    -- Fallback: usa meta do trimestre corrente. Sem nenhuma das duas, recusa (antes: 400000 inventado).
    v_projecao_proximo_trimestre :=
      (SELECT meta_faturamento FROM des_meta_empresa
       WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre);
    IF v_projecao_proximo_trimestre IS NULL THEN
      RAISE EXCEPTION 'DES sem meta para projetar: % sem meta em T%/% nem no trimestre seguinte — o ganho sairia de uma meta inventada', p_empresa, v_trimestre, v_ano;
    END IF;
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
$function$;

-- PÓS: o corpo vivo é ESTE; ACL, config, dono e assinatura iguais aos lidos na PRE; INVOKER e STABLE.
DO $pos$
DECLARE
  p record;
  v_agora text;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)');
  IF md5(p.prosrc) IS DISTINCT FROM 'b41e1d3b7cfebcf3f02ddd9edec705d6' THEN
    RAISE EXCEPTION 'POS1 FALHOU: simular_puxar_volume_trimestre viva (md5 %) não é a desta migration', md5(p.prosrc);
  END IF;
  v_agora := COALESCE(p.proacl::text, 'NULO') || '|' || COALESCE(p.proconfig::text, 'NULO') || '|' ||
           pg_catalog.pg_get_userbyid(p.proowner) || '|' || pg_catalog.pg_get_function_arguments(p.oid) || '|' ||
           pg_catalog.pg_get_function_result(p.oid);
  IF v_agora IS DISTINCT FROM current_setting('afiacao.simular_puxar_antes', true) THEN
    RAISE EXCEPTION 'POS2 FALHOU: ACL/config/dono/assinatura mudou (antes %, agora %)',
      current_setting('afiacao.simular_puxar_antes', true), v_agora;
  END IF;
  IF p.prosecdef OR p.provolatile <> 's' THEN
    RAISE EXCEPTION 'POS3 FALHOU: a função deixou de ser SECURITY INVOKER/STABLE';
  END IF;
END
$pos$;

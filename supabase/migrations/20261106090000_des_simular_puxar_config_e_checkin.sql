-- DES: o simulador de "puxar volume" recusa quando falta configuração de custo e lê o check-in VIGENTE
-- (plano v6, lote 3d — follow-ups do lote 3c, #3644).
--
-- simular_puxar_volume_trimestre ainda inventava parâmetros quando a configuração não existia:
--   * prazo escolhido ou prazo padrão ausentes → fator da NF 1,0, encargo e perda do antecipado 0;
--   * frete ativo ausente → 2,5%; empresa_configuracao_custos ausente → 20% de custo de capital.
-- Regra do repo (docs/agent/money-path.md §2): ausente ≠ número. Agora cada um levanta P0001 com a marca
-- 'DES sem configuracao de custo'. Medido na prod (psql-ro, 2026-11-06): a OBEN tem os dois prazos
-- (antecipado padrão e 28_42_56), frete ativo 2,5 e a configuração de custos — o número de hoje não muda.
--
-- E o check-in: o desconto ATUAL vem da v_des_desconto_por_checkin, que lê o check-in vigente da
-- v_des_checkin_atual (data de avaliação DESC, criação DESC); o desconto NOVO usava MAX(id). Com um
-- check-in lançado retroativo, o delta comparava descontos de check-ins diferentes. Agora os dois lados
-- usam o checkin_id da v_des_checkin_atual. Na prod não há check-in cadastrado ainda.
--
-- Ambiguidade e lacunas que mudariam dinheiro (2ª opinião Codex) também recusam: prazo escolhido ou padrão
-- INATIVO; mais de um prazo padrão ativo; mais de um frete ativo; check-in gravado que a v_des_checkin_atual
-- não mostra; critério atingido sem percentual cadastrado para a faixa ('DES sem configuracao de desconto').
-- E a v_des_checkin_atual ganha o desempate único (id DESC) no DISTINCT ON: com data e criação empatadas,
-- o vigente era arbitrário. Medido na prod: 1 padrão ativo, 1 frete ativo, 54/54 percentuais (9 critérios ×
-- 6 faixas) — nada disso dispara hoje.
--
-- Mesma assinatura, defaults, retorno, search_path, SECURITY INVOKER e STABLE; CREATE OR REPLACE preserva
-- dono e ACL (a PÓS confere tudo contra o lido na PRE). Molde TRAVA → PRE → CREATE → PÓS. Sem BEGIN/COMMIT:
-- aplica por `bun run db:aplicar`. Pelo SQL Editor/MCP, envolver em BEGIN; … COMMIT;.

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
  -- A view do check-in vigente, que este arquivo também recria: o valor VIVO (on) prende a view até o COMMIT.
  IF to_regclass('public.v_des_checkin_atual') IS NULL THEN
    RAISE EXCEPTION 'TRAVA: public.v_des_checkin_atual ausente — esta migration recria a view, não a cria';
  END IF;
  ALTER VIEW public.v_des_checkin_atual SET (security_invoker = on);
END
$trava$;

-- PRE: o corpo vivo é o da prod de 2026-11-06 (md5 do prosrc via psql-ro) ou já é este, e segue INVOKER,
-- STABLE, com o search_path da prod. Guarda ACL/config/dono/assinatura para a PÓS (GUC local à transação).
DO $pre$
DECLARE
  p record;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)');
  IF p.oid IS NULL OR md5(p.prosrc) NOT IN ('fea04a3887c8d0ac809e5588f5b6ee97', '61c51d0feb94f03f4574b116a2730420') THEN
    RAISE EXCEPTION 'PRE FALHOU: simular_puxar_volume_trimestre viva (md5 %) não é a da prod de 2026-11-06 nem esta — outra sessão mudou a função; confira antes de recriar', md5(p.prosrc);
  END IF;
  IF (SELECT md5(pg_catalog.pg_get_viewdef('public.v_des_checkin_atual'::regclass, true))) NOT IN ('cd1c2b4f0b815e35c0ae5540f54443e5', 'cfe9a0e161ceaff70cf710fbc6dbd17d') THEN
    RAISE EXCEPTION 'PRE FALHOU: v_des_checkin_atual viva (md5 %) não é a da prod de 2026-11-06 nem esta', (SELECT md5(pg_catalog.pg_get_viewdef('public.v_des_checkin_atual'::regclass, true)));
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
  v_checkin_id bigint;
  v_frete_perc numeric;
  v_fator_inflacao_nominal numeric;
  v_nominal_adicional_na_nf numeric;
BEGIN
  -- Defaults: trimestre atual (de São Paulo) se não especificado. A sessão da prod é UTC: CURRENT_DATE
  -- das 21h às 24h BRT já é o dia seguinte — e, na virada, o trimestre seguinte.
  v_ano := COALESCE(p_ano, EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::int);
  v_trimestre := COALESCE(p_trimestre, EXTRACT(QUARTER FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::int);
  
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
  
  -- Prazo de pagamento escolhido. Sem ele, o fator da NF e o encargo saíam 1,0 e 0 (inventados).
  SELECT * INTO v_prazo_novo
  FROM fornecedor_prazo_pagamento_config
  WHERE empresa = p_empresa 
    AND fornecedor_nome = 'RENNER SAYERLACK S/A'
    AND codigo = p_prazo_pagamento_codigo
    AND ativo = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % sem o prazo de pagamento % cadastrado e ativo', p_empresa, p_prazo_pagamento_codigo;
  END IF;
  
  -- Prazo padrão (antecipado default). Sem ele, a perda do antecipado saía 0 (inventada); com dois, um
  -- arbitrário decidia a perda — recusa a ambiguidade.
  IF (SELECT count(*) FROM fornecedor_prazo_pagamento_config
       WHERE empresa = p_empresa AND fornecedor_nome = 'RENNER SAYERLACK S/A'
         AND padrao = true AND ativo = true) > 1 THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % com mais de um prazo de pagamento padrão ativo', p_empresa;
  END IF;
  SELECT * INTO v_prazo_atual
  FROM fornecedor_prazo_pagamento_config
  WHERE empresa = p_empresa 
    AND fornecedor_nome = 'RENNER SAYERLACK S/A'
    AND padrao = true
    AND ativo = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % sem prazo de pagamento padrão cadastrado', p_empresa;
  END IF;
  
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
  
  -- Desconto total na nova faixa (reaplica qualitativos do checkin). O check-in é o VIGENTE da
  -- v_des_checkin_atual (data de avaliação, depois criação) — o mesmo de onde sai o desconto atual
  -- (v_des_desconto_por_checkin). Antes era MAX(id): um check-in lançado retroativo comparava o desconto
  -- novo de um check-in com o atual de outro.
  v_checkin_id := (SELECT checkin_id FROM v_des_checkin_atual
                   WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre LIMIT 1);
  -- View vazia não prova "sem check-in": com check-in gravado e a view sem ele (contrato/critérios
  -- ausentes), os qualitativos virariam 0 inventado.
  IF v_checkin_id IS NULL AND EXISTS (SELECT 1 FROM des_checkin_qualitativo
       WHERE empresa = p_empresa AND ano = v_ano AND trimestre = v_trimestre) THEN
    RAISE EXCEPTION 'DES sem configuracao de desconto: o check-in de % T%/% não aparece na v_des_checkin_atual (contrato ou critérios ausentes)', p_empresa, v_trimestre, v_ano;
  END IF;
  -- Critério atingido (do contrato 2026, o universo da v_des_checkin_atual) sem percentual cadastrado para
  -- a faixa sumiria da soma (0 inventado): recusa.
  IF v_checkin_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM des_checkin_qualitativo_resposta qr
        JOIN des_criterio_qualitativo cq ON cq.id = qr.criterio_id
         AND cq.contrato_versao_id = (SELECT id FROM des_contrato_versao WHERE versao = '2026')
        CROSS JOIN (VALUES (v_faixa_atual.faixa_id), (v_faixa_nova.faixa_id)) f(faixa_id)
        WHERE qr.checkin_id = v_checkin_id AND qr.atingido AND f.faixa_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM des_criterio_percentual cp
                           WHERE cp.criterio_id = qr.criterio_id AND cp.faixa_id = f.faixa_id)) THEN
    RAISE EXCEPTION 'DES sem configuracao de desconto: critério atingido no check-in % sem percentual cadastrado para a faixa', v_checkin_id;
  END IF;
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
          AND ck.id = v_checkin_id
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
  
  -- 3. Frete adicional sobre o valor extra. Sem frete ativo cadastrado, recusa (antes: 2,5% inventado);
  -- com dois ativos, um arbitrário decidiria o custo — recusa a ambiguidade.
  IF (SELECT count(*) FROM fornecedor_custo_adicional_config
       WHERE empresa = p_empresa AND fornecedor_nome = 'RENNER SAYERLACK S/A'
         AND tipo = 'frete_perc_valor' AND ativo = true) > 1 THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % com mais de um frete ativo (frete_perc_valor)', p_empresa;
  END IF;
  v_frete_perc :=
    (SELECT valor FROM fornecedor_custo_adicional_config 
     WHERE empresa = p_empresa 
       AND fornecedor_nome = 'RENNER SAYERLACK S/A' 
       AND tipo = 'frete_perc_valor' 
       AND ativo = true LIMIT 1);
  IF v_frete_perc IS NULL THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % sem frete ativo cadastrado (frete_perc_valor)', p_empresa;
  END IF;
  v_custo_frete := p_valor_extra * (v_frete_perc / 100.0);
  
  -- 4. Custo de capital do estoque extra. Sem a configuração da empresa, recusa (antes: 20% inventado).
  v_cm_anual :=
    (SELECT (selic_anual + spread_oportunidade + armazenagem_fisica) / 100.0 
     FROM empresa_configuracao_custos WHERE empresa = p_empresa LIMIT 1);
  IF v_cm_anual IS NULL THEN
    RAISE EXCEPTION 'DES sem configuracao de custo: % sem empresa_configuracao_custos (custo de capital)', p_empresa;
  END IF;
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

CREATE OR REPLACE VIEW public.v_des_checkin_atual
WITH (security_invoker = on)
AS
 WITH checkin_mais_recente AS (
         SELECT DISTINCT ON (des_checkin_qualitativo.empresa, des_checkin_qualitativo.ano, des_checkin_qualitativo.trimestre) des_checkin_qualitativo.id,
            des_checkin_qualitativo.empresa,
            des_checkin_qualitativo.ano,
            des_checkin_qualitativo.trimestre,
            des_checkin_qualitativo.data_avaliacao,
            des_checkin_qualitativo.tipo,
            des_checkin_qualitativo.avaliado_com,
            des_checkin_qualitativo.avaliado_por,
            des_checkin_qualitativo.observacoes_gerais
           FROM des_checkin_qualitativo
          ORDER BY des_checkin_qualitativo.empresa, des_checkin_qualitativo.ano, des_checkin_qualitativo.trimestre, des_checkin_qualitativo.data_avaliacao DESC, des_checkin_qualitativo.criado_em DESC, des_checkin_qualitativo.id DESC
        )
 SELECT cr.empresa,
    cr.ano,
    cr.trimestre,
    cr.id AS checkin_id,
    cr.data_avaliacao,
    cr.tipo,
    cr.avaliado_com,
    cr.avaliado_por,
    cq.codigo,
    cq.nome,
    cq.tipo AS criterio_tipo,
    COALESCE(cr_resp.atingido, false) AS atingido,
    cr_resp.observacao AS observacao_criterio
   FROM checkin_mais_recente cr
     CROSS JOIN des_criterio_qualitativo cq
     LEFT JOIN des_checkin_qualitativo_resposta cr_resp ON cr_resp.checkin_id = cr.id AND cr_resp.criterio_id = cq.id
  WHERE cq.contrato_versao_id = (( SELECT des_contrato_versao.id
           FROM des_contrato_versao
          WHERE des_contrato_versao.versao = '2026'::text));

-- PÓS: o corpo vivo é ESTE; ACL, config, dono e assinatura iguais aos lidos na PRE; INVOKER e STABLE.
DO $pos$
DECLARE
  p record;
  v_agora text;
BEGIN
  SELECT * INTO p FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.simular_puxar_volume_trimestre(text,integer,integer,numeric,text,integer)');
  IF md5(p.prosrc) IS DISTINCT FROM '61c51d0feb94f03f4574b116a2730420' THEN
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
  IF (SELECT md5(pg_catalog.pg_get_viewdef('public.v_des_checkin_atual'::regclass, true))) IS DISTINCT FROM 'cfe9a0e161ceaff70cf710fbc6dbd17d' THEN
    RAISE EXCEPTION 'POS4 FALHOU: v_des_checkin_atual viva não é a desta migration';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
                  WHERE c.oid = 'public.v_des_checkin_atual'::regclass
                    AND lower(o) IN ('security_invoker=on', 'security_invoker=true')) THEN
    RAISE EXCEPTION 'POS5 FALHOU: v_des_checkin_atual sem security_invoker (leria como dono, sem RLS)';
  END IF;
END
$pos$;

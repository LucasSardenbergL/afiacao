-- Fixture: os 7 PREDECESSORES de 20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql, VERBATIM da
-- prod (pg_get_functiondef via psql-ro, 2026-09-29). Não é migration: é o que a PRE da migration
-- espera encontrar (md5 exato do prosrc), e o que db/test-hoje-sp-sete-funcoes.sh instala antes de
-- aplicá-la. Serve também de receita de reversão.
--
-- Por que fixture e não as migrations do repo: trg_campanha_gera_alerta e
-- sincronizar_ativo_omie_para_reposicao não têm CREATE no repo (vivem só na prod), e
-- fin_period_lock_trigger / radar_atribuir_tarefa diferem da última definição do repo em linhas de
-- comentário (o caminho de apply as tirou). A prova confere as duas coisas: cada bloco daqui tem o
-- md5 medido na prod, e, onde há CREATE no repo, é igual a ele módulo comentário.

CREATE OR REPLACE FUNCTION public.fin_period_lock_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_target_date date;
  v_target_company text;
  v_last_closed_year int;
  v_last_closed_month int;
  v_last_closed_date date;
  v_has_override boolean;
  v_bypass text := current_setting('fin.bypass_lock', true);
  v_rec jsonb := CASE TG_OP WHEN 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
BEGIN
  IF v_bypass = 'true' THEN RETURN COALESCE(NEW, OLD); END IF;
  IF auth.role() = 'service_role' THEN RETURN COALESCE(NEW, OLD); END IF;

  v_target_company := v_rec->>'company';

  v_target_date := CASE TG_TABLE_NAME
    WHEN 'fin_contas_receber'        THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_contas_pagar'          THEN (v_rec->>'data_emissao')::date
    WHEN 'fin_movimentacoes'         THEN (v_rec->>'data_movimento')::date
    WHEN 'fin_categoria_dre_mapping' THEN current_date
    WHEN 'fin_orcamento'             THEN make_date((v_rec->>'ano')::int, (v_rec->>'mes')::int, 1)
    WHEN 'fin_eventos_recorrentes'   THEN (v_rec->>'inicio')::date
    WHEN 'fin_eventos_eventuais'     THEN (v_rec->>'data_prevista')::date
    WHEN 'fin_estoque_valor'         THEN (v_rec->>'data_ref')::date
  END;

  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN (
    'fin_categoria_dre_mapping','fin_eventos_recorrentes','fin_eventos_eventuais','fin_estoque_valor'
  ) THEN RETURN NEW; END IF;

  IF v_target_date IS NULL OR v_target_company IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT ano, mes
    INTO v_last_closed_year, v_last_closed_month
    FROM fin_fechamentos
   WHERE company = v_target_company AND status = 'fechado' AND aprovado_em IS NOT NULL
   ORDER BY ano DESC, mes DESC
   LIMIT 1;

  IF v_last_closed_year IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  v_last_closed_date := (make_date(v_last_closed_year, v_last_closed_month, 1)
                         + interval '1 month - 1 day')::date;

  IF v_target_date > v_last_closed_date THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT EXISTS(
    SELECT 1 FROM fin_period_overrides
     WHERE company = v_target_company
       AND ano = EXTRACT(YEAR FROM v_target_date)::int
       AND mes = EXTRACT(MONTH FROM v_target_date)::int
       AND expires_at > now()
       AND closed_at IS NULL
       AND opened_by = auth.uid()
  ) INTO v_has_override;

  IF v_has_override THEN RETURN COALESCE(NEW, OLD); END IF;

  RAISE EXCEPTION 'PERIOD_LOCKED: Período %/% da empresa % está fechado em %. Use override de emergência.',
    LPAD(EXTRACT(MONTH FROM v_target_date)::text, 2, '0'),
    EXTRACT(YEAR FROM v_target_date),
    v_target_company,
    v_last_closed_date
    USING ERRCODE = 'P0001';
END $function$;

CREATE OR REPLACE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric, p_preco_atual numeric, p_prazo_dias numeric[] DEFAULT NULL::numeric[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account      text := 'oben';
  v_cmc          numeric;
  v_aliquota     numeric;
  v_taxa         numeric;
  v_piso         numeric;   -- ÍNTEGRO: é o que decide `abaixo_piso`
  v_piso_exib    numeric;   -- APLICÁVEL: o mesmo piso arredondado p/ CIMA (ver abaixo)
  v_prazo_ok     boolean;
  v_abaixo       boolean;
  v_pode_num     boolean;
  v_precos_cli   numeric[];
  v_comparaveis  jsonb;
  -- p_qty não persiste, mas define a banda de comparáveis: não-finito faria BETWEEN sem sentido.
  v_qty_lo       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 0.5;
  v_qty_hi       numeric := CASE WHEN private.regua_num_finito(p_qty) THEN p_qty ELSE 0 END * 2;
BEGIN
  -- gate de ENTRADA: somente staff (inalterado — a vendedora precisa do sinal)
  IF NOT (public.has_role((SELECT auth.uid()), 'employee') OR public.has_role((SELECT auth.uid()), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;

  -- gate do NÚMERO: mesmo padrão de v_pode_num do get_preco_cockpit
  v_pode_num := private.cap_custo_ler((SELECT auth.uid()));

  -- CMC: account 'oben' preferido, fallback 'vendas' (espelhos)
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id = p_product AND ip.account IN ('oben', 'vendas')
     AND private.regua_num_finito(ip.cmc) AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC LIMIT 1;

  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliquota;

  -- taxa do custo de capital: REUSA a RPC já provada (db/test-regua-custo-capital-money-path.sh)
  -- em vez de reimplementar o unit gate. Só é consultada quando há prazo a aplicar.
  IF p_prazo_dias IS NOT NULL AND array_length(p_prazo_dias, 1) IS NOT NULL THEN
    v_taxa := public.fin_regua_custo_capital(v_account);
  END IF;

  SELECT piso, prazo_aplicado INTO v_piso, v_prazo_ok
    FROM private.regua_piso_calc(v_cmc, v_aliquota, p_prazo_dias, v_taxa);

  -- ⚠️ CEIL, não ROUND (regressão introduzida pela correção de arredondamento da rodada 1 e pega
  -- na rodada 2). O número exposto vira `precoReferencia` e o botão "Aplicar piso" o joga no
  -- carrinho. Com round(), 13.449023861… vira 13.4490 — que continua ABAIXO do piso íntegro, então
  -- aplicar a sugestão mantém o vermelho e a vendedora fica num laço. Arredondar para CIMA na
  -- mesma escala garante que o valor devolvido, se aplicado, LIMPA o piso. Verificado no PG17.
  -- o round(,4) externo NÃO muda o valor (já está em 4 casas): normaliza a ESCALA, que a
  -- divisão infla para 16+ e vazaria como "13.4491000000000000" no jsonb.
  v_piso_exib := CASE WHEN v_piso IS NOT NULL THEN round(ceil(v_piso * 10000) / 10000, 4) END;

  -- A COMPARAÇÃO acontece AQUI. É o ponto inteiro desta migration: no cliente, ela viraria busca
  -- binária pelo piso. Sem preço ou sem piso → false (não fabrica sinal).
  v_abaixo := (private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
               AND v_piso IS NOT NULL AND p_preco_atual < v_piso);

  SELECT array_agg(oi.unit_price ORDER BY so.order_date_kpi DESC) INTO v_precos_cli
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = v_account AND so.deleted_at IS NULL
     AND oi.product_id = p_product AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0 AND so.order_date_kpi >= current_date - interval '180 days';

  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.product_id = p_product AND oi.customer_user_id <> p_customer
       AND oi.unit_price > 0 AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi
       AND so.order_date_kpi >= current_date - interval '180 days'
  )
  SELECT jsonb_agg(jsonb_build_object('preco', unit_price, 'c', c_ord)) INTO v_comparaveis FROM base;

  RETURN jsonb_build_object(
    -- SINAL (todo mundo que passa no gate de staff)
    'abaixo_piso',     v_abaixo,
    'piso_disponivel', v_piso IS NOT NULL,
    'cmc_confiavel',   v_cmc IS NOT NULL,
    'prazo_aplicado',  COALESCE(v_prazo_ok, false),
    -- NÚMERO (só cap_custo_ler). piso_gap_pct é invertível para o piso → mesmo gate.
    -- o piso APLICÁVEL (ceil) é o que sai; a decisão acima usou o íntegro. O gap sai do mesmo
    -- valor exposto, senão gap×preço reconstruiria um número que o botão não aplica.
    'piso_mc',         CASE WHEN v_pode_num THEN to_jsonb(v_piso_exib) ELSE 'null'::jsonb END,
    'piso_gap_pct',    CASE WHEN v_pode_num AND v_piso_exib IS NOT NULL
                             AND private.regua_num_finito(p_preco_atual) AND p_preco_atual > 0
                            THEN to_jsonb(round(v_piso_exib / p_preco_atual - 1, 6)) ELSE 'null'::jsonb END,
    -- MERCADO (preço de venda, não custo — aberto de propósito)
    'precos_cliente',  COALESCE(to_jsonb(v_precos_cli), '[]'::jsonb),
    'comparaveis',     COALESCE(v_comparaveis, '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.listar_pedidos_a_separar(p_account text)
 RETURNS TABLE(id uuid, customer_user_id uuid, total numeric, status text, data date, items jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  RETURN QUERY
    SELECT so.id, so.customer_user_id, so.total, so.status,
           COALESCE(so.order_date_kpi, so.created_at::date) AS data, so.items
    FROM sales_orders so
    WHERE lower(so.account) = lower(p_account)
      AND so.deleted_at IS NULL
      AND so.status NOT IN ('cancelado','rascunho','orcamento')
      AND COALESCE(so.order_date_kpi, so.created_at::date) >= current_date - 60
      AND NOT EXISTS (SELECT 1 FROM picking_tasks pt WHERE pt.sales_order_id = so.id)
    ORDER BY COALESCE(so.order_date_kpi, so.created_at::date) DESC
    LIMIT 100;
END $function$;

CREATE OR REPLACE FUNCTION public.radar_atribuir_tarefa(p_cnpj text, p_dias_retomada integer DEFAULT 7)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_razao text; v_fantasia text; v_municipio text; v_uf text; v_tel text;
  v_existing uuid; v_id uuid; v_desc text;
  v_dias integer := GREATEST(1, LEAST(COALESCE(p_dias_retomada, 7), 90));
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9]{14}$' THEN RAISE EXCEPTION 'cnpj inválido'; END IF;

  SELECT razao_social, nome_fantasia, municipio_nome, uf, telefone1
    INTO v_razao, v_fantasia, v_municipio, v_uf, v_tel
    FROM public.radar_empresas WHERE cnpj = p_cnpj;
  IF NOT FOUND THEN RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text||':'||p_cnpj||':tarefa:radar', 0));
  SELECT id INTO v_existing FROM public.tarefas
   WHERE created_by = v_uid AND empresa = 'oben' AND customer_user_id IS NULL
     AND status = 'aberta' AND descricao LIKE '%CNPJ '||p_cnpj||'%'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;

  v_desc := 'Prospecção: ' || COALESCE(NULLIF(v_fantasia,''), NULLIF(v_razao,''), p_cnpj)
            || ' · ' || COALESCE(v_municipio,'?') || '/' || COALESCE(v_uf,'?')
            || COALESCE(' · tel ' || NULLIF(v_tel,''), '')
            || ' · CNPJ ' || p_cnpj;

  INSERT INTO public.tarefas (
    descricao, categoria, customer_user_id, assigned_to, created_by, empresa,
    modo, due_date, interacao_tipo, auto_satisfy_mode, status
  ) VALUES (
    v_desc, 'ligar', NULL, v_uid, v_uid, 'oben',
    'data', (current_date + v_dias), NULL, 'off', 'aberta'
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $function$;

CREATE OR REPLACE FUNCTION public.sincronizar_ativo_omie_para_reposicao()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Se virou inativo, desabilita reposição + gera alerta
  IF NEW.ativo = false AND (OLD.ativo IS NULL OR OLD.ativo = true) THEN
    UPDATE sku_parametros sp
    SET habilitado_reposicao_automatica = FALSE
    WHERE sp.sku_codigo_omie::text = NEW.omie_codigo_produto::text
      AND sp.habilitado_reposicao_automatica = TRUE;
    
    -- Registra evento pra Lucas decidir merge
    INSERT INTO eventos_outlier (
      empresa, sku_codigo_omie, sku_descricao,
      tipo, severidade, data_evento, detalhes
    )
    SELECT 
      sp.empresa, sp.sku_codigo_omie::text, sp.sku_descricao,
      'sku_inativado_omie', 'atencao', CURRENT_DATE,
      jsonb_build_object(
        'mensagem', 'SKU foi inativado no Omie. Reposição automática desligada. Decida: (1) merge histórico com outro SKU, (2) manter desabilitado, (3) reativar no Omie.',
        'familia', NEW.familia,
        'valor_unitario', NEW.valor_unitario
      )
    FROM sku_parametros sp
    WHERE sp.sku_codigo_omie::text = NEW.omie_codigo_produto::text
      AND NOT EXISTS (
        SELECT 1 FROM eventos_outlier eo
        WHERE eo.empresa = sp.empresa
          AND eo.sku_codigo_omie = sp.sku_codigo_omie::text
          AND eo.tipo = 'sku_inativado_omie'
          AND eo.status = 'pendente'
      );
  END IF;
  
  -- Se voltou a ser ativo, regrava observação (mas não reabilita automático)
  IF NEW.ativo = true AND OLD.ativo = false THEN
    INSERT INTO eventos_outlier (
      empresa, sku_codigo_omie, sku_descricao,
      tipo, severidade, data_evento, detalhes
    )
    SELECT 
      sp.empresa, sp.sku_codigo_omie::text, sp.sku_descricao,
      'sku_reativado_omie', 'info', CURRENT_DATE,
      jsonb_build_object(
        'mensagem', 'SKU foi reativado no Omie. Revisar se deseja habilitar reposição automática novamente.'
      )
    FROM sku_parametros sp
    WHERE sp.sku_codigo_omie::text = NEW.omie_codigo_produto::text;
  END IF;
  
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trg_campanha_gera_alerta()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Campanha ativada (transição para 'ativa')
  IF NEW.estado = 'ativa' AND (OLD IS NULL OR OLD.estado != 'ativa') THEN
    INSERT INTO fornecedor_alerta (
      empresa, fornecedor_nome, tipo, severidade,
      titulo, mensagem, campanha_id
    ) VALUES (
      NEW.empresa, NEW.fornecedor_nome, 'promocao_nova', 'info',
      'Nova promoção ativa: ' || NEW.nome,
      'Campanha vigente de ' || NEW.data_inicio::text || ' a ' || NEW.data_fim::text || 
      '. Corte de pedido: ' || COALESCE(NEW.data_corte_pedido::text, NEW.data_fim::text) || '.',
      NEW.id
    );
  END IF;

  -- Campanha suspensa/cancelada durante vigência
  IF NEW.estado = 'cancelada' 
     AND (OLD IS NULL OR OLD.estado IN ('ativa', 'negociando'))
     AND OLD.data_fim >= CURRENT_DATE THEN
    INSERT INTO fornecedor_alerta (
      empresa, fornecedor_nome, tipo, severidade,
      titulo, mensagem, campanha_id
    ) VALUES (
      NEW.empresa, NEW.fornecedor_nome, 'promocao_suspensa', 'urgente',
      'PROMOÇÃO SUSPENSA: ' || NEW.nome,
      'Campanha foi cancelada durante vigência. Reavalie pedidos de oportunidade pendentes.',
      NEW.id
    );
  END IF;
  
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(p_date_from date, p_date_to date, p_accounts text[] DEFAULT ARRAY['oben'::text, 'colacor'::text])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_account     text;
  v_contas      jsonb := '[]'::jsonb;
  v_desfecho    text;
  v_next        integer;
  v_done        timestamptz;
  v_aberta_from date;
  v_aberta_to   date;
BEGIN
  -- Gate staff/master na fronteira (fail-closed: uid nulo NUNCA passa) —
  -- mesmo gate de public.request_customer_metrics_refresh.
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- Validação de janela (money-path: melhor recusar do que semear lixo).
  IF p_accounts IS NULL OR array_length(p_accounts, 1) IS NULL THEN
    RAISE EXCEPTION 'p_accounts vazio' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) deve ser <= date_to (%)', p_date_from, p_date_to
      USING ERRCODE = '22023';
  END IF;
  IF p_date_to > current_date THEN
    RAISE EXCEPTION 'janela invalida: date_to (%) no futuro', p_date_to
      USING ERRCODE = '22023';
  END IF;
  IF p_date_from < DATE '2015-01-01' THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) anterior a 2015-01-01', p_date_from
      USING ERRCODE = '22023';
  END IF;

  -- Contas em ordem determinística → advisory locks sempre na mesma ordem (anti-deadlock).
  FOR v_account IN SELECT DISTINCT a FROM unnest(p_accounts) AS a ORDER BY a
  LOOP
    IF v_account IS NULL OR v_account NOT IN ('oben', 'colacor') THEN
      RAISE EXCEPTION 'conta invalida: % (esperado oben|colacor)', COALESCE(v_account, 'NULL')
        USING ERRCODE = '22023';
    END IF;

    -- Serializa semeadores concorrentes da MESMA conta (xact-lock: solta sozinho no fim/abort).
    PERFORM pg_advisory_xact_lock(hashtext('vendas_sync_semear_' || v_account));

    SELECT c.date_from, c.date_to
      INTO v_aberta_from, v_aberta_to
      FROM public.vendas_sync_cursor c
     WHERE c.account = v_account
       AND c.completed_at IS NULL
       AND NOT (c.date_from = p_date_from AND c.date_to = p_date_to)
     ORDER BY c.date_from
     LIMIT 1;

    IF FOUND THEN
      v_desfecho := 'ja_pendente_outra';
      v_next := NULL;
      v_done := NULL;
    ELSE
      INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
      VALUES (v_account, p_date_from, p_date_to)
      ON CONFLICT (account, date_from, date_to) DO NOTHING;
      IF FOUND THEN
        v_desfecho := 'semeada';
      END IF;
      SELECT c.next_page, c.completed_at
        INTO v_next, v_done
        FROM public.vendas_sync_cursor c
       WHERE c.account = v_account AND c.date_from = p_date_from AND c.date_to = p_date_to;
      IF v_desfecho IS NULL THEN
        v_desfecho := CASE WHEN v_done IS NOT NULL THEN 'ja_concluida' ELSE 'ja_pendente' END;
      END IF;
    END IF;

    v_contas := v_contas || jsonb_build_object(
      'account',           v_account,
      'desfecho',          v_desfecho,
      'next_page',         v_next,
      'completed_at',      v_done,
      'janela_aberta_de',  v_aberta_from,
      'janela_aberta_ate', v_aberta_to
    );

    v_desfecho := NULL; v_next := NULL; v_done := NULL;
    v_aberta_from := NULL; v_aberta_to := NULL;
  END LOOP;

  RETURN jsonb_build_object('date_from', p_date_from, 'date_to', p_date_to, 'contas', v_contas);
END;
$function$;

-- 20260929001651_hoje_sp_sessao_utc_sete_funcoes.sql
-- ============================================================
-- O "hoje" de 7 funções passa a ser o de SÃO PAULO, seja qual for o TimeZone da sessão.
-- ============================================================
-- A classe (ii) (docs/historico/hoje-da-sessao-nu-funcoes-e-skills.md): o dia da SESSÃO lido fora
-- de date_trunc — `current_date`, e o instante que vira data por `::date` — em corpos que não
-- mencionam America/Sao_Paulo (fora do alcance de scripts/fuso-da-sessao-gate.ts). A prod roda
-- sessões em UTC (TimeZone=UTC do arquivo de configuração, 0 overrides em pg_db_role_setting —
-- psql-ro, 2026-09-28); o PostgREST e o pg_cron herdam. Das 21:00 às 23:59 BRT o dia da sessão já
-- é o seguinte. Os 7 corpos abaixo são os AFETADOS da varredura da prod (398 funções). Dos outros
-- dois afetados: melhoria_clientes_por_produto vai com a 20260929000234 (a sessão do LIKE, que a
-- recria no mesmo voo — combinado para não disputarmos a "última a rodar vence"); e
-- converter_sugestao_em_campanha_flat está QUEBRADA na prod por outro defeito — o INSERT em
-- promocao_item usa 4 colunas que a tabela não tem (42703 a qualquer hora; 0 conversões em 325
-- sugestões) —, e o relógio dela entra no reparo, não aqui:
--   · fin_period_lock_trigger (money-path, trava contábil): para fin_categoria_dre_mapping o alvo é
--     o hoje — no último dia de um mês já fechado, a trava LIBERAVA o UPDATE/DELETE que em SP é
--     PERIOD_LOCKED (falha ABERTA; a tela FinanceiroMapping grava a qualquer hora);
--   · radar_atribuir_tarefa: a tarefa de retomada vencia D+8 em vez de D+7 (due_date é data de SP:
--     v_tarefas_estado julga o atraso pelo hoje de SP);
--   · vendas_sync_semear_janela: a guarda anti-futuro aceitava date_to = amanhã de SP;
--   · trg_campanha_gera_alerta: a campanha cancelada no seu último dia, de noite, não gerava o
--     alerta 'promocao_suspensa' (OLD.data_fim >= hoje dava falso);
--   · sincronizar_ativo_omie_para_reposicao: eventos_outlier.data_evento — data de SP, comparada
--     com data_emissao no drill-down — nascia amanhã no sync MANUAL de produtos feito à noite;
--   · listar_pedidos_a_separar (picking): o pedido nativo do app (sem order_date_kpi) criado das
--     21:00 às 23:59 BRT aparecia na tela com a data de AMANHÃ (created_at::date), e a janela de
--     60 dias perdia o dia mais antigo;
--   · get_regua_preco (preço): a janela de 180 dias do histórico do cliente e dos comparáveis
--     perdia o dia mais antigo.
--
-- Conserto: o mesmo instante — now() e current_date leem os dois o início da transação — levado à
-- data de SP, `(now() AT TIME ZONE 'America/Sao_Paulo')::date` (a forma da 20260927172443), e o
-- instante do pedido idem, `(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date`. É a ÚNICA
-- mudança em cada corpo: o resto é o texto VIVO da prod (pg_get_functiondef, 2026-09-29), gerado
-- por troca exata com contagem conferida — mesmas assinaturas, retornos, volatilidade, SECURITY
-- DEFINER, search_path e dono. trg_campanha_gera_alerta e sincronizar_ativo_omie_para_reposicao
-- não tinham CREATE no repo; fin_period_lock_trigger e radar_atribuir_tarefa diferiam da prod só
-- em linhas de comentário (o caminho de apply as tirou).
--
-- Fora, medidos (os vereditos por sítio estão no diário): os leitores de pedido_compra_sugerido
-- .data_ciclo (escrita em UTC pela edge gerar-pedidos-diario) e os sensores que releem o próprio
-- carimbo são UTC-consistentes — mexer só num lado criaria a divergência; as funções só de cron
-- fora da janela, as órfãs e os carimbos sem leitor são latentes; views, matviews e DEFAULTs são a
-- fase seguinte da classe.
--
-- Prova: db/test-hoje-sp-sete-funcoes.sh (PG17, relógio controlado cruzando 21:00 e 00:00 BRT sob
-- TimeZone=UTC E America/Sao_Paulo) e o mesmo script com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova com os corpos antigos (a fixture
-- db/fixtures/hoje-sp-sete-funcoes-predecessoras-prod-20260929.sql os guarda verbatim).
--
-- Identidade (PRE e POS): md5 EXATO do `prosrc`, medido na prod. Um md5 normalizado igualaria
-- literais com espaço duplo (achado do Codex na 20260927202603).

-- Trava ANTES da pré-condição (o modelo é a 20260927202603): um ALTER sem efeito prende a linha do
-- catálogo de cada função até o fim desta transação — quem chegar depois espera e falha alto; quem
-- chegou antes aparece na pré-condição.
DO $trava$
BEGIN
  IF to_regprocedure('public.fin_period_lock_trigger()') IS NOT NULL THEN
    ALTER FUNCTION public.fin_period_lock_trigger() VOLATILE;
  END IF;
  IF to_regprocedure('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])') IS NOT NULL THEN
    ALTER FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) VOLATILE;
  END IF;
  IF to_regprocedure('public.listar_pedidos_a_separar(text)') IS NOT NULL THEN
    ALTER FUNCTION public.listar_pedidos_a_separar(text) VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_atribuir_tarefa(text,integer)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_atribuir_tarefa(text, integer) VOLATILE;
  END IF;
  IF to_regprocedure('public.sincronizar_ativo_omie_para_reposicao()') IS NOT NULL THEN
    ALTER FUNCTION public.sincronizar_ativo_omie_para_reposicao() VOLATILE;
  END IF;
  IF to_regprocedure('public.trg_campanha_gera_alerta()') IS NOT NULL THEN
    ALTER FUNCTION public.trg_campanha_gera_alerta() VOLATILE;
  END IF;
  IF to_regprocedure('public.vendas_sync_semear_janela(date,date,text[])') IS NOT NULL THEN
    ALTER FUNCTION public.vendas_sync_semear_janela(date, date, text[]) VOLATILE;
  END IF;
END
$trava$;

-- Pré-condição: cada corpo vivo tem de ser o PREDECESSOR revisado (o da prod em 2026-09-29, md5
-- EXATO do prosrc) ou JÁ este (re-aplicar é seguro). Qualquer outro é mudança concorrente que o
-- CREATE OR REPLACE apagaria em silêncio — aborta. Função ausente (ambiente novo) segue.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('fin_period_lock_trigger()', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.fin_period_lock_trigger()')),
         '34996f6165e69db0e65fbce70b0862fa', '7f6c4514233587a46a324a58fae085ca'),
        ('get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])')),
         'a125d14b19197bac9c98e2b8f33d2422', '846b8d591627674ff59b904b53222ff1'),
        ('listar_pedidos_a_separar(text)', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.listar_pedidos_a_separar(text)')),
         'a0e5ef170f650b7ebe51b96eba32f0e6', '4b5c0219af92b966ea2a58d3fc05f1fa'),
        ('radar_atribuir_tarefa(text,integer)', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_atribuir_tarefa(text,integer)')),
         '24799f0029fac5792ab2798e8fed1c93', '2cec8056bf553b87d6329394c1f30779'),
        ('sincronizar_ativo_omie_para_reposicao()', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.sincronizar_ativo_omie_para_reposicao()')),
         '041603ce75f1122d483073d5a1187bf8', '5823a7c4b5963d5d7dbb001f51a507b6'),
        ('trg_campanha_gera_alerta()', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.trg_campanha_gera_alerta()')),
         '8b4deafcc3a9dee8971e04f30f2dc831', 'b2911e17e242be16497329ffbb6185da'),
        ('vendas_sync_semear_janela(date,date,text[])', (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.vendas_sync_semear_janela(date,date,text[])')),
         '4954c2eb57b40dcf3030b023aad959ba', '16b561c0b9cc362e01b9d41d354805be')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NOT NULL AND r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de public.% (md5 %) não é o predecessor revisado nem este — outra mudança chegou antes; reconcilie antes de aplicar', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

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
    WHEN 'fin_categoria_dre_mapping' THEN (now() AT TIME ZONE 'America/Sao_Paulo')::date
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
     AND oi.unit_price > 0 AND so.order_date_kpi >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '180 days';

  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.product_id = p_product AND oi.customer_user_id <> p_customer
       AND oi.unit_price > 0 AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi
       AND so.order_date_kpi >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '180 days'
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
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data, so.items
    FROM sales_orders so
    WHERE lower(so.account) = lower(p_account)
      AND so.deleted_at IS NULL
      AND so.status NOT IN ('cancelado','rascunho','orcamento')
      AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 60
      AND NOT EXISTS (SELECT 1 FROM picking_tasks pt WHERE pt.sales_order_id = so.id)
    ORDER BY COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC
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
    'data', ((now() AT TIME ZONE 'America/Sao_Paulo')::date + v_dias), NULL, 'off', 'aberta'
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
      'sku_inativado_omie', 'atencao', (now() AT TIME ZONE 'America/Sao_Paulo')::date,
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
      'sku_reativado_omie', 'info', (now() AT TIME ZONE 'America/Sao_Paulo')::date,
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
     AND OLD.data_fim >= (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
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
  IF p_date_to > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
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

-- O fecho das 4 RPCs (contrato PORTA_GATE de scripts/authz-funcoes-fechadas.ts): no-op na prod, onde
-- o CREATE OR REPLACE preserva o ACL; vale onde a função NASCE aqui (a PRE admite ausente). `anon`
-- NOMEADO: com o default privilege do Supabase a função nasce com EXECUTE direto a anon, que um
-- REVOKE de PUBLIC não tira. As 3 de gatilho não são chamáveis fora de um trigger: ACL intocado.
REVOKE EXECUTE ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid, uuid, numeric, numeric, numeric[]) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.listar_pedidos_a_separar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.listar_pedidos_a_separar(text) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_tarefa(text, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.vendas_sync_semear_janela(date, date, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendas_sync_semear_janela(date, date, text[]) TO authenticated, service_role;

-- Pós-condição: o corpo instalado é ESTE (md5 exato), não lê mais o relógio da sessão, e cada
-- atributo segue o de prod — volatilidade, SECURITY DEFINER (4 RPCs e a trava contábil; os 2
-- gatilhos de reposição/campanha não são), search_path e dono. As RPCs, com a porta PORTA_GATE.
DO $post$
DECLARE
  r record;
  v_oid oid;
  v_src text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.fin_period_lock_trigger()', '7f6c4514233587a46a324a58fae085ca', 'v'::"char", 'search_path=public', false),
      ('public.get_regua_preco(uuid,uuid,numeric,numeric,numeric[])', '846b8d591627674ff59b904b53222ff1', 'v'::"char", 'search_path=public', true),
      ('public.listar_pedidos_a_separar(text)', '4b5c0219af92b966ea2a58d3fc05f1fa', 'v'::"char", 'search_path=public', true),
      ('public.radar_atribuir_tarefa(text,integer)', '2cec8056bf553b87d6329394c1f30779', 'v'::"char", 'search_path=public', true),
      ('public.sincronizar_ativo_omie_para_reposicao()', '5823a7c4b5963d5d7dbb001f51a507b6', 'v'::"char", 'search_path=public, pg_temp', false),
      ('public.trg_campanha_gera_alerta()', 'b2911e17e242be16497329ffbb6185da', 'v'::"char", 'search_path=public, pg_temp', false),
      ('public.vendas_sync_semear_janela(date,date,text[])', '16b561c0b9cc362e01b9d41d354805be', 'v'::"char", 'search_path=""', true)
    ) AS x(alvo, este, volatilidade, config, rpc)
  LOOP
    v_oid := to_regprocedure(r.alvo);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS1 FALHOU: % não existe — quem a chama quebraria', r.alvo;
    END IF;
    SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    IF md5(v_src) <> r.este THEN
      RAISE EXCEPTION 'POS2 FALHOU: o corpo instalado de % (md5 %) não é o desta migration', r.alvo, md5(v_src);
    END IF;
    IF v_src ~* '\mcurrent_date\M|\mlocaltimestamp\M' OR v_src ~* ('created' || '_at::date')
       OR position('America/Sao_Paulo' IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS3 FALHOU: % ainda lê o relógio da sessão, ou perdeu o fuso de SP', r.alvo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid = v_oid AND p.provolatile = r.volatilidade
                      AND p.prosecdef = (r.alvo NOT IN ('public.sincronizar_ativo_omie_para_reposicao()',
                                                        'public.trg_campanha_gera_alerta()'))
                      AND array_to_string(p.proconfig, ';') = r.config
                      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
      RAISE EXCEPTION 'POS4 FALHOU: % mudou de atributo — esperado volatilidade %, config [%], dono postgres', r.alvo, r.volatilidade, r.config;
    END IF;
    IF r.rpc AND (pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
                  OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
                  OR NOT pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'POS5 FALHOU: ACL de % — tem de ser fechada para PUBLIC/anon e aberta para authenticated', r.alvo;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK: 7 funções no hoje de SP, corpos e atributos conferidos';
END
$post$;

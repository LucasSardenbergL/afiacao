-- ============================================================================
-- Reposição (money-path) — custo AUSENTE vira NULL, não R$0 fabricado.
--
-- ⚠️  APLICAR MANUALMENTE no SQL Editor do Lovable. O Lovable NÃO auto-aplica migration de
--     nome custom (CLAUDE.md §5 / database.md §2). São CREATE OR REPLACE de 2 funções existentes.
--
-- BUG (provado em prod, 49 itens/30d, 100% primeira_compra): o motor seta preco_unitario da
--     linha-âncora via COALESCE(cmc>0, preço_médio_histórico, 0). SKU de PRIMEIRA COMPRA (sem cmc,
--     sem histórico de recebimento, sem troca p/ galão com preço-app fresco) caía no literal 0 —
--     zero fabricado, viola "ausente≠zero" (financeiro/cockpit veem R$0 de custo).
--
-- FIX (2 funções, atômico — Codex challenge 019f146d):
--   MOTOR  gerar_pedidos_sugeridos_ciclo: âncora COALESCE(...,0) -> COALESCE(...) = NULL quando
--          custo desconhecido; valor_total do pedido vira COALESCE(SUM(...),0) (a coluna é NOT NULL;
--          item.valor_linha segue NULL = honesto). Numericamente valor_total é IGUAL a hoje.
--   GATE   reposicao_pedido_auto_aprovavel: o guard de item inválido era NOT(preco>0 AND ...).
--          Com preco NULL, NOT(NULL AND ...)=NULL → a linha ESCAPA do EXISTS → pedido de custo
--          desconhecido poderia AUTO-APROVAR. Endurecido p/ NOT COALESCE(<predicado>, false)
--          (pega NULL/NaN/Infinity/negativo/0). É a parte que CARREGA a segurança da troca 0→NULL.
--
-- ORDEM (segurança): GATE primeiro, MOTOR por último. Se o motor falhar no apply, fica
--     gate-NOVO + motor-VELHO (motor velho grava 0; o gate já barra 0 e NULL) = seguro. O inverso
--     (motor-novo NULL + gate-velho) deixaria NULL escapar → por isso o gate vem ANTES.
--
-- ⚠️  PARIDADE: o MOTOR é a ÚLTIMA coisa do arquivo. Do CREATE do motor até EOF é BYTE-IDÊNTICO a
--     db/embalagem-motor-rpc.sql (guard src/lib/reposicao/__tests__/embalagem-motor-paridade.test.ts).
--     NÃO acrescente COMMIT/GRANT/qualquer coisa DEPOIS do motor.
--
-- Prova PG17: db/test-embalagem-motor.sh (motor: NULL não 0; valor_total não-nulo) +
--             db/test-auto-aprovacao-v2.sh (gate: all-NULL e parcial-NULL REJEITADOS; falsificado).
--
-- VALIDAÇÃO pós-apply (rodar no SQL Editor após colar):
--   -- 1) gate endurecido tem o COALESCE:
--   SELECT (pg_get_functiondef('public.reposicao_pedido_auto_aprovavel(bigint,numeric,numeric,numeric)'::regprocedure)
--           ILIKE '%NOT COALESCE(i.preco_unitario%') AS gate_null_safe;             -- espera: true
--   -- 2) motor sem o fallback 0 na âncora:
--   SELECT (pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure)
--           ILIKE '%pm.preco_unitario) AS preco_unitario_ancora%') AS motor_sem_zero; -- espera: true
-- ============================================================================

-- ===== 1) GATE: reposicao_pedido_auto_aprovavel (guard de item invalido NULL-safe) =====
CREATE OR REPLACE FUNCTION public.reposicao_pedido_auto_aprovavel(p_pedido_id bigint, p_threshold numeric, p_delta_max numeric, p_cooldown_horas numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  p RECORD;
  v_grupo text;
  v_valor numeric;     -- valor REAL (soma dos itens) — fonte de verdade do disparo
  v_ref numeric;       -- v2: MEDIANA dos últimos N eventos de compra do grupo
  v_n int;             -- v2: nº de eventos de referência (mínimo 3)
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

  -- v2 (Codex): veta só 'forward_buying' (infla qtde = aposta de estoque adiantada, decisão
  -- humana; tem o próprio guardrail de delta na geração). LIBERA 'flat' (só desconto de preço,
  -- qtde inalterada — benigno; era a causa de parte da inatividade da v1, que vetava qualquer
  -- modo_promocao). O delta assimétrico abaixo já protege o VALOR final.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id AND i.modo_promocao = 'forward_buying'
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'item em forward_buying (aposta de estoque — decisão humana)');
  END IF;

  -- P2.11: guard de item que o disparo (#422/#433) barraria. Forma POSITIVA (> 0 AND <
  -- Infinity) p/ rejeitar também NaN/Infinity — "preco<=0" é FALSE p/ NaN e não pegaria.
  -- [PRECO-AUSENTE] NOT COALESCE(..., false): NULL (custo desconhecido vindo do motor) colapsa
  -- p/ false → flagueia como inválido. Sem o COALESCE, NOT(NULL AND ...)=NULL e a linha ESCAPA
  -- do EXISTS → um pedido com item de custo desconhecido poderia AUTO-APROVAR (Codex challenge).
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id
      AND NOT COALESCE(i.preco_unitario > 0 AND i.preco_unitario < 'Infinity'::numeric
               AND i.qtde_final > 0 AND i.qtde_final < 'Infinity'::numeric, false)
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

  -- v2: referência = MEDIANA dos últimos 5 EVENTOS de compra do grupo. Cada evento = SUM por
  -- data_ciclo (<90d, compra real) — colapsa o pré-split (pai → filhos na mesma data) como na v1,
  -- mas agora a mediana de VÁRIOS eventos, não o último solto (ruidoso: normal teve R$1031 e
  -- R$7377). MÍNIMO 3 eventos (Codex: percentile_cont com 2 valores interpola a média = falsa
  -- mediana; com [1000,16000] daria 8500).
  -- ⚠️ Codex P2.2 (teórico, sem caminho atual): a referência soma valor_total do CABEÇALHO dos
  -- históricos; o candidato (v_valor) usa a soma dos ITENS. Nos disparados o cabeçalho = itens (a
  -- geração seta valor_total = SUM dos itens e o disparo não muda). Se um dia divergirem (cabeçalho
  -- inflado), o teto poderia subir. Monitorado no piloto; fix futuro = somar itens nos históricos.
  WITH eventos AS (
    SELECT r.data_ciclo, SUM(r.valor_total) AS valor
    FROM public.pedido_compra_sugerido r
    WHERE r.empresa = p.empresa
      AND r.fornecedor_nome = p.fornecedor_nome
      AND COALESCE(r.grupo_codigo, '') = v_grupo
      AND r.id <> p.id
      AND r.criado_em > now() - interval '90 days'
      AND (r.omie_pedido_compra_numero IS NOT NULL OR r.status IN ('disparado', 'concluido_recebido'))
    GROUP BY r.data_ciclo
    ORDER BY r.data_ciclo DESC
    LIMIT 5
  )
  SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY valor), count(*)
    INTO v_ref, v_n FROM eventos;

  IF v_n < 3 THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'menos de 3 compras de referência do grupo em 90d');
  END IF;
  IF v_ref IS NULL OR NOT (v_ref > 0 AND v_ref < 'Infinity'::numeric) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'mediana de referência inválida');
  END IF;

  -- v2: delta ASSIMÉTRICO — só trava comprar MAIS que mediana×(1+delta_max). Comprar <= mediana
  -- SEMPRE passa (conservador: menos capital; a régua R$3k já é o piso). O risco money-path da
  -- auto-aprovação é comprar DEMAIS; pedido muito menor que o típico é seguro (Codex: humano
  -- semeia a mediana, a automação alcança depois). delta_pct negativo = comprou menos (ok).
  IF v_valor > v_ref * (1 + p_delta_max) THEN
    RETURN jsonb_build_object('elegivel', false,
      'motivo', 'acima do típico: ' || round(v_valor)::text || ' > mediana ' || round(v_ref)::text
        || ' × ' || round((1 + p_delta_max), 2)::text,
      'valor_anterior', v_ref,
      'delta_pct', round(100.0 * (v_valor - v_ref) / v_ref, 1));
  END IF;

  RETURN jsonb_build_object('elegivel', true,
    'valor_anterior', v_ref,
    'delta_pct', round(100.0 * (v_valor - v_ref) / v_ref, 1),
    'valor_itens', v_valor);
END;
$function$;


REVOKE ALL ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric, numeric) TO service_role;

-- ===== 2) MOTOR: gerar_pedidos_sugeridos_ciclo (custo ancora NULL + valor_total COALESCE) =====
-- corpo BYTE-IDENTICO a db/embalagem-motor-rpc.sql do inicio do CREATE ate EOF (guard de paridade)
CREATE OR REPLACE FUNCTION public.gerar_pedidos_sugeridos_ciclo(p_empresa text DEFAULT 'OBEN'::text, p_data_ciclo date DEFAULT CURRENT_DATE)
 RETURNS TABLE(pedidos_gerados integer, skus_incluidos integer, valor_total_ciclo numeric, bloqueados integer)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '120s'
AS $function$
DECLARE
  v_pedidos INT := 0;
  v_skus INT := 0;
  v_valor NUMERIC := 0;
  v_bloqueados INT := 0;
  v_stale_dias INT := 45;  -- motor confia no preço-app por N dias (painel usa 24h; manual precisa folga). Config abaixo.
  v_run_id uuid := gen_random_uuid();  -- [GATE estoque-não-confirmado] carimba os suprimidos desta execução no log
BEGIN
  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- Janela de frescor do preço-app que o motor aceita p/ trocar a embalagem (decisão B da spec). Global.
  SELECT COALESCE((SELECT NULLIF(btrim(value), '')::int
                   FROM company_config WHERE key = 'embalagem_preco_motor_stale_dias' LIMIT 1), 45)
    INTO v_stale_dias;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte).
  UPDATE pedido_compra_sugerido
  SET status = 'expirado_sem_aprovacao', atualizado_em = now()
  WHERE empresa = p_empresa
    AND data_ciclo < p_data_ciclo
    AND status = 'pendente_aprovacao'
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  -- [INTRADAY 3/4] limpeza do dia: só ciclo NORMAL (preserva oportunidade/promoção pendentes) e
  -- INCLUI bloqueado_guardrail do dia (re-avaliado a cada rodada; anti compra dupla).
  DELETE FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo
    AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
    AND COALESCE(tipo_ciclo, 'normal') = 'normal';

  WITH em_transito AS (
    SELECT pcs2.empresa, pci.sku_codigo_omie::text AS sku_codigo_omie, SUM(pci.qtde_final) AS qtde
    FROM pedido_compra_item pci
    JOIN pedido_compra_sugerido pcs2 ON pcs2.id = pci.pedido_id
    WHERE pcs2.empresa = p_empresa
      AND (
        (pcs2.status IN ('aprovado_aguardando_disparo','disparado','concluido_recebido') AND pcs2.data_ciclo >= (p_data_ciclo - INTERVAL '7 days'))
        OR (pcs2.status_envio_portal IN ('sucesso_portal','enviado_portal') AND pcs2.portal_protocolo IS NOT NULL AND pcs2.omie_pedido_compra_numero IS NULL AND pcs2.status NOT IN ('cancelado','expirado_sem_aprovacao'))
      )
    GROUP BY pcs2.empresa, pci.sku_codigo_omie
  ),
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0)) AS preco_unitario, COUNT(*) AS n
    FROM sku_leadtime_history slh
    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  -- ── EMBALAGEM (novo) ─────────────────────────────────────────────────────────────────────
  -- Membros ativos dos grupos de equivalência (empresa = lower).
  equiv AS (
    SELECT grupo_id, sku_codigo_omie::text AS sku, fator_para_base
    FROM sku_embalagem_equivalencia
    WHERE empresa = lower(p_empresa) AND ativo = TRUE AND fator_para_base > 0
  ),
  -- Só grupos com >= 2 membros têm decisão de embalagem.
  equiv_grupos AS (
    SELECT grupo_id FROM equiv GROUP BY grupo_id HAVING count(*) >= 2
  ),
  -- Preço-app mais recente por SKU (empresa = lower), líquido e > 0.
  preco_app AS (
    SELECT DISTINCT ON (sku_codigo_omie) sku_codigo_omie::text AS sku, preco, capturado_em
    FROM sku_preco_fornecedor_capturado
    WHERE empresa = lower(p_empresa) AND status = 'ok' AND preco > 0
    ORDER BY sku_codigo_omie, capturado_em DESC
  ),
  -- Portal-map ativo por SKU (empresa = upper). Sem map → não dá pra emitir ao portal → inelegível.
  portal_map AS (
    SELECT DISTINCT sku_omie::text AS sku
    FROM sku_fornecedor_externo
    WHERE empresa = p_empresa AND ativo = TRUE AND sku_portal IS NOT NULL AND btrim(sku_portal) <> ''
  ),
  -- [P0-a] Saldo físico do Omie por SKU (account-aware; 1 linha/SKU, a mais recente). As 2 fontes de estoque
  -- DIVERGEM: inventory_position tem alguns galões (WP87/WP04), sku_estoque_atual tem outros (WP01). GREATEST
  -- (adiante) pega o galão real de onde estiver.
  inv_saldo AS (
    SELECT DISTINCT ON (omie_codigo_produto) omie_codigo_produto::text AS sku, saldo
    FROM inventory_position
    WHERE account = ANY (CASE lower(p_empresa)
            WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
            WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
            WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
            ELSE ARRAY[lower(p_empresa)] END)
    ORDER BY omie_codigo_produto, synced_at DESC NULLS LAST
  ),
  -- [P1-f] Membro ELEGÍVEL p/ a decisão: preço-app FRESCO + portal-map + CATÁLOGO OK (ativo, tipo≠04, família
  -- comprável, ativo_no_omie) — os MESMOS filtros que protegem a âncora, agora também no SKU que pode ser escolhido.
  membro_elegivel AS (
    SELECT e.grupo_id, e.sku, e.fator_para_base, pa.preco,
           (pa.preco / e.fator_para_base) AS custo_base
    FROM equiv e
    JOIN equiv_grupos eg ON eg.grupo_id = e.grupo_id
    JOIN preco_app pa ON pa.sku = e.sku AND pa.capturado_em >= now() - make_interval(days => v_stale_dias)
    JOIN portal_map pm ON pm.sku = e.sku
    JOIN omie_products opm ON opm.omie_codigo_produto::text = e.sku AND opm.account = lower(p_empresa)
    LEFT JOIN sku_status_omie ssom ON ssom.empresa = p_empresa AND ssom.sku_codigo_omie = e.sku
    LEFT JOIN familia_nao_comprada fncm ON fncm.empresa = p_empresa AND fncm.familia = opm.familia
    WHERE COALESCE(opm.ativo, TRUE) = TRUE
      AND COALESCE(ssom.ativo_no_omie, TRUE) = TRUE
      AND fncm.id IS NULL
      AND COALESCE(opm.tipo_produto, opm.metadata->>'tipo_produto', '') <> '04'
      AND COALESCE(opm.descricao, '') NOT ILIKE '%450ML'   -- [P1-f] os MESMOS filtros de catálogo da âncora
      AND COALESCE(opm.descricao, '') NOT ILIKE '%405ML'
  ),
  -- Melhor embalagem do grupo (menor custo_base; empate → embalagem maior).
  embalagem_escolhida AS (
    SELECT DISTINCT ON (grupo_id)
           grupo_id, sku AS sku_escolhido, fator_para_base AS fator_escolhido,
           preco AS preco_escolhido, custo_base AS custo_base_escolhido
    FROM membro_elegivel
    ORDER BY grupo_id, custo_base ASC, fator_para_base DESC
  ),
  -- [P0-a/P0-b] Estoque consolidado por grupo (escala unidades-âncora):
  --   físico = Σ GREATEST(inv.saldo, sea.estoque_fisico)   ← pega o galão real de onde estiver
  --   a caminho = Σ [pendente(sea) + em_transito × fator]  ← galão em voo conta em unidades-base (2 GL = 8), não cru
  grupo_estoque AS (
    SELECT e.grupo_id,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0)))                              AS fisico_grupo,
           SUM(COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)           AS acaminho_grupo,
           SUM(GREATEST(COALESCE(inv.saldo, 0), COALESCE(sea.estoque_fisico, 0))
               + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0) * e.fator_para_base)         AS estoque_grupo,
           -- [GATE estoque-não-confirmado] grupo NÃO-CONFIRMADO se QUALQUER membro ATIVO tem seed (cold_start_seed)
           -- sem inventory_position — pode ter saldo real que mudaria a decisão. NÃO conta "sem linha de sea" (galão
           -- legitimamente vive sem sea próprio; o estoque vem de outro membro — só a LINHA isolada gateia sea ausente).
           -- inv por PRESENÇA da linha (não saldo, que pode ser NULL — Codex P1, casa a LINHA); membro INATIVO no Omie
           -- NÃO vota — senão um galão descontinuado seed-only envenenaria o grupo ativo p/ sempre (Codex P1).
           bool_or(COALESCE(sea.fonte_sync, '') = 'cold_start_seed'
                   AND inv.sku IS NULL
                   AND COALESCE(ssg.ativo_no_omie, true) = true)                                               AS grupo_nao_confirmado
    FROM equiv e
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = p_empresa AND sea.sku_codigo_omie = e.sku
    LEFT JOIN inv_saldo inv        ON inv.sku = e.sku
    LEFT JOIN em_transito et       ON et.sku_codigo_omie = e.sku
    LEFT JOIN sku_status_omie ssg  ON ssg.empresa = p_empresa AND ssg.sku_codigo_omie = e.sku  -- [GATE] inativo não vota
    GROUP BY e.grupo_id
  ),
  -- ── BASE: 1 linha por ÂNCORA (SKU com sku_parametros, i.e. o quartinho) que dispara ──────────
  sku_base AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS ancora_sku, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo, sp.minimo_forcado_manual,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico_proprio,
           (COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS acaminho_proprio,
           ea.grupo_id AS equiv_grupo,
           ge.estoque_grupo, ge.fisico_grupo, ge.acaminho_grupo,
           -- estoque efetivo: do GRUPO quando a âncora pertence a um grupo; senão o próprio (no-op p/ a maioria).
           COALESCE(ge.estoque_grupo,
                    COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) AS estoque_efetivo,
           ee.sku_escolhido, ee.fator_escolhido, ee.preco_escolhido, ee.custo_base_escolhido,
           me_anc.custo_base AS ancora_custo_base,  -- NULL = âncora não-elegível → estrito (não troca)
           -- custo da linha p/ a ÂNCORA: cmc account-aware, senão preço médio histórico, senão NULL.
           -- [PRECO-AUSENTE] ausente≠zero — NÃO fabrica R$0 (o gate de auto-aprovação e o disparo já barram custo desconhecido).
           COALESCE(
             ( SELECT ipc.cmc FROM inventory_position ipc
               WHERE ipc.omie_codigo_produto::text = sp.sku_codigo_omie::text
                 AND ipc.account = ANY (CASE lower(p_empresa)
                       WHEN 'oben' THEN ARRAY['vendas'::text,'oben'::text]
                       WHEN 'colacor' THEN ARRAY['colacor_vendas'::text,'colacor'::text]
                       WHEN 'colacor_sc' THEN ARRAY['servicos'::text,'colacor_sc'::text]
                       ELSE ARRAY[lower(p_empresa)] END)
                 AND ipc.cmc > 0
               ORDER BY ipc.synced_at DESC NULLS LAST
               LIMIT 1 ),
             pm.preco_unitario) AS preco_unitario_ancora,   -- [PRECO-AUSENTE] sem fallback 0
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc,
           -- [GATE estoque-não-confirmado] confirmação por LINHA (SKU isolado): seed-only OU sem linha de estoque
           -- (Codex P1: sea AUSENTE é estoque desconhecido, não zero confirmado), sem inventory_position.
           -- inv via isl = inv_saldo (account-aware ['vendas','oben']), NÃO o ip órfão (account=lower(empresa) só):
           -- o estoque da OBEN vive em 'vendas'; PRESENÇA da linha de inv (isl.sku), p/ casar o gate de grupo.
           ((sea.sku_codigo_omie IS NULL OR COALESCE(sea.fonte_sync, '') = 'cold_start_seed') AND isl.sku IS NULL) AS linha_nao_confirmada,
           ge.grupo_nao_confirmado,
           sea.fonte_sync AS linha_fonte_sync
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN em_transito et ON et.empresa = sp.empresa AND et.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN inv_saldo isl ON isl.sku = sp.sku_codigo_omie::text   -- [GATE] confirmação por inventory_position (account-aware)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
    -- equivalência da âncora + estoque consolidado + escolha de embalagem (NULL p/ SKU sem grupo).
    LEFT JOIN equiv ea ON ea.sku = sp.sku_codigo_omie::text
    LEFT JOIN grupo_estoque ge ON ge.grupo_id = ea.grupo_id
    LEFT JOIN embalagem_escolhida ee ON ee.grupo_id = ea.grupo_id
    LEFT JOIN membro_elegivel me_anc ON me_anc.grupo_id = ea.grupo_id AND me_anc.sku = sp.sku_codigo_omie::text
    WHERE sp.empresa = p_empresa
      AND sp.habilitado_reposicao_automatica = TRUE
      AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
      AND sp.fornecedor_nome IS NOT NULL
      AND btrim(sp.fornecedor_nome) <> ''
      AND fnc.id IS NULL
      AND COALESCE(op.ativo, true) = true
      AND COALESCE(sso.ativo_no_omie, true) = true
      AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'
      AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
      AND COALESCE((
            SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
            FROM omie_products op04
            WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
              AND op04.account = lower(p_empresa)
            LIMIT 1
          ), '') <> '04'
      -- [P1-c] A âncora NÃO pode ser um galão (membro fator>1 de um grupo): senão um GL com ponto/max viraria
      -- âncora E seria escolhido por outro membro → 2 linhas do mesmo GL (uma com custo CMC/0). A âncora é
      -- sempre a unidade-base (fator 1). (Hoje no-op: galões têm ponto/max NULL; isto blinda o futuro.)
      AND NOT EXISTS (
            SELECT 1 FROM equiv eg2
            WHERE eg2.sku = sp.sku_codigo_omie::text AND eg2.fator_para_base > 1
          )
      -- [INTRADAY 4/4] o anti-dup de oportunidade foi MOVIDO p/ depois da decisão (skus_necessitando), porque
      -- precisa olhar o SKU FINAL (âncora OU galão escolhido), não o candidato — senão bloquearia o quartinho
      -- mantido por causa de uma oportunidade do galão que nem vai ser comprado. [P1-d, refinado pós-re-Codex]
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      -- GATILHO consolidado: estoque do GRUPO (ou próprio) <= ponto_pedido da âncora.
      AND COALESCE(ge.estoque_grupo,
                   COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0) + COALESCE(et.qtde, 0)) <= sp.ponto_pedido
  ),
  -- ── DECISÃO: troca p/ galão só se ESTRITAMENTE mais barato/base e a âncora também é elegível ──
  skus_necessitando AS (
    SELECT b.empresa,
           CASE WHEN trocou THEN b.sku_escolhido ELSE b.ancora_sku END AS sku_codigo_omie,
           CASE WHEN trocou
                THEN COALESCE((SELECT op2.descricao FROM omie_products op2
                               WHERE op2.omie_codigo_produto::text = b.sku_escolhido
                                 AND op2.account = lower(p_empresa) LIMIT 1), b.sku_descricao)
                ELSE b.sku_descricao END AS sku_descricao,
           b.fornecedor_nome, b.grupo_codigo, b.ponto_pedido, b.estoque_maximo,
           COALESCE(b.fisico_grupo, b.estoque_fisico_proprio)  AS estoque_fisico,
           COALESCE(b.acaminho_grupo, b.acaminho_proprio)      AS estoque_a_caminho,
           b.estoque_efetivo,
           ceil(b.estoque_maximo - b.estoque_efetivo) AS qtde_sugerida,  -- gate >0 (unidades-âncora)
           -- nº de embalagens do SKU escolhido: galão = ceil(necessidade / fator); quartinho = lógica atual.
           -- [P1-e] minimo_forcado_manual (unidades-âncora) aplicado como piso ANTES de dividir pelo fator.
           CASE
             WHEN trocou THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo,
                                            COALESCE(b.minimo_forcado_manual, 0)) / b.fator_escolhido)
             WHEN b.minimo_forcado_manual IS NOT NULL AND b.minimo_forcado_manual > 0
                  THEN ceil(GREATEST(b.estoque_maximo - b.estoque_efetivo, b.minimo_forcado_manual))
             ELSE ceil(b.estoque_maximo - b.estoque_efetivo)
           END AS qtde_final,
           -- custo da linha: galão → preço-app (R$/embalagem, nunca 0); quartinho → cmc atual.
           CASE WHEN trocou THEN b.preco_escolhido ELSE b.preco_unitario_ancora END AS preco_unitario,
           b.primeira_compra, b.horario_corte_pedido, b.valor_maximo_mensal, b.delta_max_perc,
           -- [GATE estoque-não-confirmado] espelha estoque_efetivo=COALESCE(grupo,linha): decisão pelo grupo usa a
           -- confirmação do grupo; pela linha, a da linha. Suprime quando a fonte é só seed (ausente≠zero, precisão>recall).
           COALESCE(b.grupo_nao_confirmado, b.linha_nao_confirmada) AS suprimido,
           CASE WHEN b.grupo_nao_confirmado THEN 'grupo_membro_seed_only'
                WHEN b.linha_nao_confirmada THEN 'linha_seed_only'
                ELSE NULL END AS motivo,
           b.linha_fonte_sync
    FROM (
      SELECT b0.*,
             ( b0.sku_escolhido IS NOT NULL
               AND b0.sku_escolhido <> b0.ancora_sku
               AND b0.ancora_custo_base IS NOT NULL                 -- âncora elegível (comparável)
               AND b0.custo_base_escolhido < b0.ancora_custo_base   -- galão estritamente mais barato/base
             ) AS trocou
      FROM sku_base b0
    ) b
    -- [P1-d] [INTRADAY 4/4] anti-dup de oportunidade sobre o SKU FINAL (o que SERÁ gravado: âncora ou galão).
    -- Aqui já se sabe "trocou", então não bloqueia o quartinho mantido por uma oportunidade do galão não-usado.
    WHERE NOT EXISTS (
      SELECT 1
      FROM pedido_compra_item pci9
      JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
      WHERE pcs9.empresa = b.empresa
        AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
        AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
        AND pci9.sku_codigo_omie = CASE WHEN b.trocou THEN b.sku_escolhido ELSE b.ancora_sku END
    )
  ),
  -- [GATE estoque-não-confirmado] LOG dos suprimidos ANTES de inserir o pedido — senão vira subcompra silenciosa.
  log_ins AS (
    INSERT INTO public.reposicao_estoque_nao_confirmado_log
      (run_id, empresa, sku_codigo_omie, sku_descricao, grupo_codigo, motivo, estoque_efetivo, ponto_pedido, fonte_sync)
    SELECT v_run_id, sn.empresa, sn.sku_codigo_omie, sn.sku_descricao, sn.grupo_codigo, sn.motivo,
           sn.estoque_efetivo, sn.ponto_pedido, sn.linha_fonte_sync
    FROM skus_necessitando sn
    WHERE sn.suprimido AND sn.qtde_sugerida > 0
    RETURNING 1
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
           COALESCE(SUM(sn.qtde_final * sn.preco_unitario), 0), COUNT(*),   -- [PRECO-AUSENTE] valor_total é NOT NULL; item.valor_linha segue NULL (honesto)
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0 AND NOT sn.suprimido   -- [GATE] não gera pedido com estoque não-confirmado
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra,
    estoque_fisico, estoque_a_caminho
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra,
         sn.estoque_fisico, sn.estoque_a_caminho
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'')
  WHERE sn.qtde_sugerida > 0 AND NOT sn.suprimido;   -- [GATE] espelha o filtro do pedido

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- Reposição — motor gerar_pedidos_sugeridos_ciclo: "a caminho" via FONTE ÚNICA + BARREIRA fail-closed.
-- =====================================================================================================
-- PASSO 3 do rework (spec docs/superpowers/specs/2026-06-11-reposicao-fonte-unica-on-order.md, "Opção A
-- endurecida"). O "a caminho" (estoque_pendente_entrada) passou a ser FONTE ÚNICA = snapshot das POs
-- abertas APROVADAS do Omie, gravado atomicamente pela RPC aplicar_snapshot_pendente (passo 1) a partir
-- da edge omie-sync-estoque (passo 2). Esta migration ajusta o MOTOR:
--   (A) [P1-C] REMOVE o `em_transito` POR COMPLETO (CTE + projeções + JOIN + termo do estoque_efetivo + WHERE),
--       p/ AMBAS as empresas. Para OBEN ele já contava 0 (fonte única + barreira). Para COLACOR ele DUPLICAVA o
--       estoque_pendente_entrada (ListarSaldoPendente) e somava 'concluido_recebido' por 7 dias sobre o físico
--       já recebido → double-count → ruptura (adversarial Codex). O motor não roda p/ COLACOR (CTE sobre 0 linhas).
--       estoque_efetivo = estoque_fisico + estoque_pendente_entrada (ambas as empresas).
--   (B) ADICIONA a BARREIRA fail-closed (OBEN-only): antes de gerar, ABORTA se não puder garantir que o
--       snapshot reflete TUDO em voo. Mata o double-buy (latência) sem 2 fontes de quantidade. [P1-F] a janela
--       da (3a) é 6h (não 30min): cobre lag de aprovação SEM cEmailAprovador + cCodIntPed transitoriamente ilegível.
--
-- ⚠️ ANTI-CASCATA (multi-sessão): esta def PARTE da 20260609160000_reposicao_ciclo_intraday.sql (confirmada
--   a de MAIOR timestamp que define gerar_pedidos_sugeridos_ciclo — o #743/20260611120000 tocou só a
--   gerar_pedidos_OPORTUNIDADE_ciclo, NÃO esta). TODAS as marcas da base preservadas VERBATIM: INTRADAY 1-4,
--   MIN-FORCADO 1/3, A2-CMC-PEDIDO/ACCOUNT, QTDE-INTEIRA. Só o em_transito sai e a barreira entra.
--   Ao re-tocar esta função numa sessão futura, PARTA da migration de MAIOR timestamp (esta) e faça
--   PREFLIGHT `pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure)` de prod
--   antes do CREATE OR REPLACE (o repo pode divergir de prod no apply manual).
--
-- ⚠️ ORDEM DE DEPLOY (fail-closed → não gera sem snapshot): aplicar SÓ DEPOIS de a edge omie-sync-estoque
--   (passo 2) ter rodado ao menos 1× e populado o marcador sync_state(reposicao_pendente_po, status=complete).
--   Senão a barreira (condição 4) aborta TODA a geração até o 1º sync. Sequência: deploy edge → forçar sync
--   OBEN → confirmar marcador complete → aplicar esta migration.
--
-- ⚠️ MONEY-PATH — validado em PG17 (db/test-motor-fonte-unica.sh). Codex adversarial xhigh é GATE antes do deploy.

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
BEGIN
  -- [P2 estrutural round3] geração SÓ p/ OBEN — RECUSA no MOTOR (não só na edge): a UI (AdminReposicaoPedidos)
  -- chama esta RPC DIRETO (não só via gerar-pedidos-diario), então um guard só na edge não cobre. Só OBEN tem o
  -- "a caminho" FONTE ÚNICA + a barreira fail-closed abaixo; com o em_transito removido, outra empresa rodaria SEM
  -- proteção contra re-sugerir recém-disparado → double-buy se o pendente zerar/atrasar. RAISE antes de qualquer
  -- escrita. (REPOSICAO_EMPRESA='OBEN'; nenhum SKU não-OBEN habilitado na esteira → recusar é zero-impacto hoje.)
  IF lower(p_empresa) <> 'oben' THEN
    RAISE EXCEPTION 'reposicao_motor: geração só habilitada p/ OBEN (fonte-única + barreira fail-closed); % sem on-order próprio protegido — habilite a fonte-única/barreira p/ essa empresa antes de gerar', p_empresa;
  END IF;

  -- [INTRADAY 1/4] serializa execuções concorrentes (cron 2/2h × botão "Recalcular" × retry).
  -- xact-lock: solta sozinho no fim da transação. Por empresa (a expiração 2/4 cruza datas).
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(p_empresa)));

  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL) FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%) — recusando gerar compras p/ não tratar Produto Acabado como comprável', lower(p_empresa);
  END IF;

  -- [FONTE-ÚNICA] BARREIRA fail-closed (OBEN-only): o "a caminho" é FONTE ÚNICA (snapshot das POs do Omie,
  -- via aplicar_snapshot_pendente). Sem o em_transito interno, o motor SÓ pode gerar se o snapshot reflete
  -- TUDO em voo — senão re-sugeriria o que já está pedido (double-buy). ABORTA (RAISE → rollback) em vez de
  -- chutar. Backstop do bump only_pending do disparo (passo 4): se o bump falhar, a condição (3) pega.
  IF lower(p_empresa) = 'oben' THEN
    DECLARE
      v_snap_at        timestamptz;
      v_snap_status    text;
      v_codints         jsonb;
      v_codints_emaprov jsonb;
      v_full_at         timestamptz;
      v_full_status     text;
      v_pend_aprovado   int;
      v_portal_sem_po   int;
      v_disp_ausente    int;
      v_disp_emaprov    int;
    BEGIN
      SELECT ss.last_sync_at, ss.status,
             COALESCE(ss.metadata->'codints_aprovados', '[]'::jsonb),
             COALESCE(ss.metadata->'codints_em_aprovacao', '[]'::jsonb)
        INTO v_snap_at, v_snap_status, v_codints, v_codints_emaprov
      FROM public.sync_state ss
      WHERE ss.entity_type = 'reposicao_pendente_po' AND ss.account = 'oben';

      SELECT ss.last_sync_at, ss.status INTO v_full_at, v_full_status
      FROM public.sync_state ss
      WHERE ss.entity_type = 'reposicao_estoque_full' AND ss.account = 'oben';

      -- (4) snapshot do A-CAMINHO ausente / não-complete / stale (>6h): não gerar com dado velho.
      IF v_snap_at IS NULL OR v_snap_status IS DISTINCT FROM 'complete' OR (now() - v_snap_at) > INTERVAL '6 hours' THEN
        RAISE EXCEPTION 'barreira_fonte_unica: snapshot de a-caminho ausente/incompleto/stale (last=% status=%) — recusando gerar com dado velho; rode omie-sync-estoque', v_snap_at, v_snap_status;
      END IF;

      -- [P1.6] (4b) snapshot do FÍSICO (reposicao_estoque_full) ausente/incompleto/stale: o motor lê físico +
      -- a-caminho; físico PARCIAL (upsert com erro grava status<>'complete') ou velho → recusa gerar.
      IF v_full_at IS NULL OR v_full_status IS DISTINCT FROM 'complete' OR (now() - v_full_at) > INTERVAL '6 hours' THEN
        RAISE EXCEPTION 'barreira_fonte_unica: snapshot do FÍSICO ausente/incompleto/stale (last=% status=%) — recusando gerar; rode omie-sync-estoque', v_full_at, v_full_status;
      END IF;

      -- (1) pedido aprovado_aguardando_disparo: aprovado mas ainda NÃO virou PO no Omie → fora do snapshot.
      SELECT count(*) INTO v_pend_aprovado FROM public.pedido_compra_sugerido
       WHERE empresa = p_empresa AND status = 'aprovado_aguardando_disparo';
      IF v_pend_aprovado > 0 THEN
        RAISE EXCEPTION 'barreira_fonte_unica: % pedido(s) aprovado_aguardando_disparo (ainda não viraram PO no Omie) — dispare ou cancele antes de gerar', v_pend_aprovado;
      END IF;

      -- (2) portal-confirmado sem PO no Omie: foi ao Sayerlack (protocolo) mas sem omie_numero → fora do snapshot.
      SELECT count(*) INTO v_portal_sem_po FROM public.pedido_compra_sugerido
       WHERE empresa = p_empresa
         AND status_envio_portal IN ('sucesso_portal', 'enviado_portal')
         AND portal_protocolo IS NOT NULL
         AND omie_pedido_compra_numero IS NULL
         AND status NOT IN ('cancelado', 'expirado_sem_aprovacao');
      IF v_portal_sem_po > 0 THEN
        RAISE EXCEPTION 'barreira_fonte_unica: % pedido(s) confirmado(s) no portal sem PO no Omie — aguarde a conciliação antes de gerar', v_portal_sem_po;
      END IF;

      -- (3a) pedido disparado (status=disparado, atualizado <6h) cujo AFI-<id> NÃO consta em NENHUM conjunto do
      -- snapshot (nem aprovados nem em-aprovação) → o bump falhou / o sync não pegou a PO ainda / a PO está
      -- etapa-10 com cCodIntPed transitoriamente ilegível no PesquisarPedCompra. Fecha o caso de borda do run_id
      -- (full-sync de dados velhos sobrescreve o bump). [P1-F] janela 30min→6h.
      -- ⚠️ POR QUE JANELA (e não window-less): 'concluido_recebido' NUNCA é setado no app (grep vazio) → um pedido
      --   'disparado' NÃO termina de status. Uma barreira window-less ('disparado' + AFI ausente) bloquearia PARA
      --   SEMPRE um pedido já RECEBIDO (PO fechada → sai de codints_aprovados) mas ainda 'disparado' → travaria a
      --   reposição do SKU indefinidamente = RUPTURA. A janela 6h limita esse falso-bloqueio (raro: lead time=dias).
      -- ⚠️ RESIDUAL (codint etapa-10 ilegível >6h): a (3a) deixa de cobrir e o motor pode RE-SUGERIR o SKU. É
      --   direção SUPERCOMPRA (o app pediu + o motor sugere → founder aprova os 2 → excesso), NÃO ruptura — o lado
      --   SEGURO (contar etapa-10 ou bloquear por SKU arriscaria ruptura se a PO for rejeitada → pior). Mitigação:
      --   (i) cEmailAprovador SETADO (OMIE_OBEN_EMAIL_APROVADOR, #609) → PO nasce etapa-15 → AFI em codints_aprovados
      --   na hora → etapa-10 nunca acontece p/ PO do app → residual MOOT; (ii) o smoke do deploy confirma que o
      --   cCodIntPed é legível no PesquisarPedCompra (o #628/#592 já dependem disso no ConsultarPedCompra).
      SELECT count(*) INTO v_disp_ausente FROM public.pedido_compra_sugerido pcs
       WHERE pcs.empresa = p_empresa
         AND pcs.status = 'disparado'
         AND pcs.atualizado_em > now() - INTERVAL '6 hours'
         AND NOT (v_codints ? ('AFI-' || pcs.id::text))
         AND NOT (v_codints_emaprov ? ('AFI-' || pcs.id::text));
      IF v_disp_ausente > 0 THEN
        RAISE EXCEPTION 'barreira_fonte_unica: % pedido(s) disparado(s) ainda não refletido(s) no snapshot de a-caminho (PO não apareceu/etapa-10 sem codint legível) — aguarde o próximo sync de estoque ou aprove/cancele a PO no Omie', v_disp_ausente;
      END IF;

      -- [P1.2] (3b) pedido do app DISPARADO cuja PO está EM APROVAÇÃO no Omie (etapa-10): não conta no a-caminho
      -- (só etapa-15 conta), mas o app JÁ pediu → re-sugerir seria double-buy. Aborta SEM janela de tempo
      -- (enquanto a PO não virar etapa-15). Cobre o que escapava da janela de 30min da (3a) — cEmailAprovador
      -- ausente / lag de auto-aprovação fazem a PO ficar etapa-10 por mais de 30min.
      SELECT count(*) INTO v_disp_emaprov FROM public.pedido_compra_sugerido pcs
       WHERE pcs.empresa = p_empresa
         AND pcs.status = 'disparado'
         AND (v_codints_emaprov ? ('AFI-' || pcs.id::text));
      IF v_disp_emaprov > 0 THEN
        RAISE EXCEPTION 'barreira_fonte_unica: % pedido(s) disparado(s) com PO ainda EM APROVAÇÃO no Omie (etapa-10) — aprove a PO no Omie (ou configure OMIE_OBEN_EMAIL_APROVADOR) ou cancele antes de gerar', v_disp_emaprov;
      END IF;
    END;
  END IF;

  -- [INTRADAY 2/4] expira pendentes NORMAIS de ciclos anteriores (zumbis pós-corte). Oportunidade
  -- fica fora (território do ciclo_oportunidade_do_dia); bloqueado_guardrail antigo fica (status
  -- quo: chip "precisam de atenção").
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

  -- [FONTE-ÚNICA / P1.5 / P1-C] em_transito REMOVIDO por completo (era CONDICIONAL: 0 p/ OBEN, cheio p/ COLACOR).
  -- OBEN: o "a caminho" é FONTE ÚNICA (snapshot das POs do Omie) + barreira fail-closed → em_transito já contava 0.
  -- COLACOR: o em_transito DUPLICAVA o estoque_pendente_entrada (ListarSaldoPendente já é o on-order do COLACOR) E
  --   somava qtde_final de 'concluido_recebido' por 7 dias SOBRE o físico já recebido → double-count → RUPTURA
  --   (P1-C do adversarial). E o motor NÃO roda para COLACOR (não há cron COLACOR; nenhum SKU COLACOR habilitado
  --   na esteira → skus_necessitando vazio), então a CTE operava sobre ZERO linhas (remoção = zero mudança real
  --   para COLACOR, elimina o bug latente). estoque_efetivo = estoque_fisico + estoque_pendente_entrada (ambas
  --   as empresas). ⚠️ Se COLACOR vier a entrar na esteira no futuro: validar a latência do ListarSaldoPendente
  --   vs. recém-disparado (COLACOR hoje não tem fluxo de disparo pelo app — disparar-pedidos-aprovados é OBEN).
  WITH preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0)) AS preco_unitario, COUNT(*) AS n
    FROM sku_leadtime_history slh
    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0
    GROUP BY slh.empresa, slh.sku_codigo_omie
  ),
  skus_necessitando AS (
    SELECT sp.empresa, sp.sku_codigo_omie::text AS sku_codigo_omie, sp.sku_descricao, sp.fornecedor_nome,
           sg.grupo_codigo, sp.ponto_pedido, sp.estoque_maximo,
           COALESCE(sea.estoque_fisico, 0) AS estoque_fisico,
           COALESCE(sea.estoque_pendente_entrada, 0) AS estoque_pendente,
           (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) AS estoque_efetivo,
           -- [QTDE-INTEIRA] arredonda pra cima: o estoque vem do Omie com poeira decimal → max − estoque
           -- seria fracionário (3,99996). Arredondar pra cima preserva o sinal >0, então o filtro de
           -- necessidade abaixo fica idêntico (inclusão inalterada; só o valor muda).
           ceil(sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0))) AS qtde_sugerida,
           -- [MIN-FORCADO 1/3] qtde_final = piso(natural, mínimo forçado). Espelha o helper puro
           -- aplicarMinimoForcado: CASE WHEN min>0 THEN GREATEST(natural, min) ELSE natural END.
           -- Sem piso-0 fantasma (ELSE devolve o natural intocado). A guarda "só item que precisa
           -- repor" é o filtro qtde_sugerida > 0 abaixo (sobre o NATURAL), inalterado.
           -- [QTDE-INTEIRA] ceil envolve o piso E o natural: nenhuma quantidade fracionária (do
           -- estoque com poeira decimal OU de um mínimo forçado fracionário) chega ao pedido.
           CASE WHEN sp.minimo_forcado_manual IS NOT NULL AND sp.minimo_forcado_manual > 0
                THEN ceil(GREATEST(
                       (sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0))),
                       sp.minimo_forcado_manual))
                ELSE ceil(sp.estoque_maximo - (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)))
           END AS qtde_final,
           -- [A2-CMC-PEDIDO] cmc-PRIMEIRO (>0), senão média, senão 0. Espelha a view (preco_item_eoq):
           -- cmc=0/negativo/null não vira preço 0 (CASE devolve NULL → COALESCE cai pra média).
           -- [A2-CMC-ACCOUNT] cmc das 2 convenções de account (espelha a view precos_cmc): pra OBEN
           -- olha 'vendas' E 'oben' (o feed canônico grava 'vendas'); cmc>0 mais fresco; senão média; senão 0.
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
             pm.preco_unitario, 0) AS preco_unitario,
           (pm.n IS NULL) AS primeira_compra,
           fh.horario_corte_pedido, fh.valor_maximo_mensal, fh.delta_max_perc
    FROM sku_parametros sp
    LEFT JOIN sku_grupo_producao sg ON sg.empresa = sp.empresa AND sg.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN sku_estoque_atual sea ON sea.empresa = sp.empresa AND sea.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN fornecedor_habilitado_reposicao fh ON fh.empresa = sp.empresa AND fh.fornecedor_nome = sp.fornecedor_nome
    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text AND op.account = lower(p_empresa)
    LEFT JOIN familia_nao_comprada fnc ON fnc.empresa = sp.empresa AND fnc.familia = op.familia
    LEFT JOIN preco_medio pm ON pm.empresa = sp.empresa AND pm.sku_codigo_omie = sp.sku_codigo_omie::text
    LEFT JOIN inventory_position ip ON ip.omie_codigo_produto::text = sp.sku_codigo_omie::text AND ip.account = lower(p_empresa)
    LEFT JOIN sku_status_omie sso ON sso.empresa = sp.empresa AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
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
      -- [INTRADAY 4/4] não re-sugerir SKU presente em pedido pendente/bloqueado de OPORTUNIDADE/
      -- promoção (a limpeza 3/4 os preserva; sem esta guarda o mesmo SKU nasceria também no
      -- pedido normal → aprovar os dois = compra dupla).
      AND NOT EXISTS (
            SELECT 1
            FROM pedido_compra_item pci9
            JOIN pedido_compra_sugerido pcs9 ON pcs9.id = pci9.pedido_id
            WHERE pcs9.empresa = p_empresa
              AND pcs9.status IN ('pendente_aprovacao', 'bloqueado_guardrail')
              AND COALESCE(pcs9.tipo_ciclo, 'normal') <> 'normal'
              AND pci9.sku_codigo_omie = sp.sku_codigo_omie::text
          )
      AND sp.ponto_pedido IS NOT NULL
      AND sp.estoque_maximo IS NOT NULL
      AND (COALESCE(sea.estoque_fisico, 0) + COALESCE(sea.estoque_pendente_entrada, 0)) <= sp.ponto_pedido
  ),
  pedidos_por_fornecedor_grupo AS (
    INSERT INTO pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo, horario_corte_planejado,
      valor_total, num_skus, status, condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem
    )
    SELECT sn.empresa, sn.fornecedor_nome, sn.grupo_codigo, p_data_ciclo,
           (p_data_ciclo + MAX(sn.horario_corte_pedido))::timestamptz,
           SUM(sn.qtde_final * sn.preco_unitario), COUNT(*),
           'pendente_aprovacao', '000', 'À Vista', 1, NULL, 'default_a_vista'
    FROM skus_necessitando sn
    WHERE sn.qtde_sugerida > 0
    GROUP BY sn.empresa, sn.fornecedor_nome, sn.grupo_codigo
    RETURNING id, fornecedor_nome, grupo_codigo
  )
  INSERT INTO pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, estoque_atual, ponto_pedido, estoque_maximo,
    qtde_sugerida, qtde_final, preco_unitario, valor_linha, primeira_compra
  )
  SELECT pfg.id, sn.sku_codigo_omie, sn.sku_descricao, sn.estoque_efetivo, sn.ponto_pedido, sn.estoque_maximo,
         sn.qtde_sugerida, sn.qtde_final, sn.preco_unitario, sn.qtde_final * sn.preco_unitario, sn.primeira_compra
  FROM skus_necessitando sn
  JOIN pedidos_por_fornecedor_grupo pfg
    ON pfg.fornecedor_nome = sn.fornecedor_nome AND COALESCE(pfg.grupo_codigo,'') = COALESCE(sn.grupo_codigo,'')
  WHERE sn.qtde_sugerida > 0;

  SELECT COUNT(*), COALESCE(SUM(num_skus),0), COALESCE(SUM(valor_total),0)
  INTO v_pedidos, v_skus, v_valor
  FROM pedido_compra_sugerido
  WHERE empresa = p_empresa AND data_ciclo = p_data_ciclo AND status = 'pendente_aprovacao';

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

-- Validação (rodar após o COMMIT, no SQL Editor):
-- SELECT 'MOTOR FONTE-ÚNICA OK' AS status,
--   (SELECT count(*) FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
--     AND pg_get_functiondef(p.oid) LIKE '%FONTE-ÚNICA%') AS rpc_com_barreira,
--   (SELECT count(*) FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
--     AND pg_get_functiondef(p.oid) NOT LIKE '%em_transito%') AS sem_em_transito,
--   (SELECT count(*) FROM pg_proc p WHERE p.proname='gerar_pedidos_sugeridos_ciclo'
--     AND pg_get_functiondef(p.oid) LIKE '%INTRADAY 4/4%') AS marcas_intraday_preservadas;

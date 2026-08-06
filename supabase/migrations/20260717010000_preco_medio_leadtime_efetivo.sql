-- Fase 0-quater — a CTE de PREÇO do motor de compra passa a ler a fonte deduplicada por NFe.
--
-- CONTEXTO: uma NFe que fatura N pedidos gera N cópias do mesmo item em
-- sku_leadtime_history (writer corrigido em #1345; o passivo é resíduo finito que não
-- cresce). Quem agrega sobre as LINHAS pondera a estatística pela multiplicidade. A
-- leitura vem sendo quarentenada consumidor a consumidor via v_sku_leadtime_efetivo
-- (1 linha por (empresa, NFe, SKU)): #1343 cobriu v_sku_leadtime_estatisticas, #1354
-- cobriu v_sku_sla_compliance + os leitores React, #1357 cobriu a stack de outliers.
-- Esta migration cobre a CTE `preco_medio` do motor de pedidos.
--
-- O defeito: AVG(valor_total / qtde_recebida) sobre as LINHAS. A NFe duplicada N× pesa
-- N× na média, então o "preço médio de compra" tende à NFe mais fatiada, não à média das
-- compras. Corrigido trocando a fonte da CTE — e SÓ isso: o corpo restante desta função é
-- byte-a-byte o da prod (conferido via pg_get_functiondef antes do REPLACE). A tabela crua
-- aparecia exatamente UMA vez na função.
--
-- ─── HONESTIDADE SOBRE O GANHO: o delta em produção HOJE é ZERO ───────────────────────
-- Medido na prod antes do apply, por dois ângulos independentes:
--   • Partindo dos SKUs ATIVOS de reposição: a esmagadora maioria tem cmc, e a âncora é
--     COALESCE(cmc do inventory_position, preço do leadtime) — cmc-first. Dos poucos que
--     caem no fallback, NENHUM muda de preço.
--   • Partindo dos SKUs cujo preço DIVERGE entre a fonte crua e a efetiva: todos têm cmc.
--     Nenhum deles chega a usar o preço do leadtime.
-- Ou seja: o viés é real e no pior SKU chega à casa das dezenas de por cento, mas está
-- inteiramente atrás da cortina do cmc-first. Esta migration NÃO conserta um número errado
-- que o app mostra hoje; ela remove a dependência de uma única cortina e fecha a
-- quarentena. Vale porque o motor é quente (roda várias vezes por semana) e porque o
-- fallback é justamente a população SEM cmc — SKU novo, pouca observação, onde uma
-- duplicata distorce a média com mais força. Não inflar o ganho é parte do conserto.
--
-- ─── REGRA DE COLAPSO: repontar NÃO é trocar o FROM ───────────────────────────────────
-- A view efetiva emite NULL onde as cópias divergem ("concorda-ou-NULL"). Decidido campo a
-- campo, MEDINDO — só os 4 campos que esta CTE lê importam:
--   • valor_total → as cópias SEMPRE concordam (medido: nenhum par perde o campo). Era a
--     suspeita principal antes de medir; não se confirmou.
--   • quantidade_recebida → um punhado de pares perde o campo (cópias divergem na
--     quantidade mas concordam no valor). Esses pares saem do FILTER de PREÇO (NULL > 0 é
--     NULL) — mas NÃO da CTE: seguem contando em `n`, logo o SKU continua "já comprado".
--     É a única leitura honesta: sabemos o valor mas não a quantidade ⇒ o preço unitário
--     daquela NFe é genuinamente incognoscível, e escolher um representante fabricaria
--     precisão. Ausente ≠ zero. (Ver o bloco [2 CONSUMIDORES] na CTE: é exatamente aqui que
--     mandar o par p/ fora da CTE INTEIRA — e não só do preço — faria o badge mentir.)
--   • empresa / sku_codigo_omie → chaves do GROUP BY, nunca nulas na view (dedup_key é
--     garantidamente não-nulo). Tipos idênticos aos da tabela crua (empresa segue o enum
--     empresa_reposicao; o ::text de saída é preservado p/ casar com sku_parametros.empresa,
--     que é text). A repontagem não introduz cast novo.
--
-- ─── OS DOIS CONSUMIDORES DA CTE (o segundo é fácil de esquecer — e foi o que mordeu) ──
--   1. preco_unitario_ancora = COALESCE(cmc, pm.preco_unitario) — protegido por cmc-first.
--   2. primeira_compra = (pm.n IS NULL) — SEM proteção nenhuma. Era o risco real: se o
--      colapso derrubasse um SKU INTEIRO da CTE, o badge passaria a mentir "primeira compra"
--      num SKU já comprado.
--
-- ⚠️ ESTA É A PARTE QUE UMA MEDIÇÃO SÓ NÃO PEGARIA — E QUASE NÃO PEGOU.
--    No pré-flight, ZERO SKUs sumiam da CTE ⇒ zero viradas ⇒ a conclusão foi "risco latente,
--    não vale guarda". Poucas HORAS depois, na mesma sessão, a re-medição deu DOIS — ambos
--    ativos. O sync grava (a fonte crua cresceu no intervalo) e o resíduo se move. A regra
--    "meça" tem um corolário: **uma medição é um RETRATO, e um invariante que depende de
--    resíduo vivo não se prova com um retrato.** Quando o custo da guarda é uma linha e o
--    custo do erro é o app mentir, guarde — não aposte no retrato.
--    Por isso o filtro de preço virou FILTER (ver o comentário na CTE): `n` passa a contar
--    EXISTÊNCIA (que o dedup preserva por construção), e o preço agrega só o precificável.
--    Medido nos dois sentidos: o conjunto de primeira_compra fica IDÊNTICO ao de hoje —
--    nenhum SKU entra, nenhum sai. A magnitude de `n` muda (conta NFes, não linhas) e é
--    imaterial: `n` só é lido como IS NULL, nunca comparado.
--
-- ─── EFEITO COLATERAL DE ESCOPO: o filtro origem_compra='normal' vem de brinde ─────────
-- v_sku_leadtime_efetivo lê v_sku_leadtime_history_normal (WHERE origem_compra='normal'),
-- não a tabela crua. A CTE antiga não tinha esse filtro. Hoje é NO-OP (medido: a tabela
-- inteira é 'normal' — nenhuma linha de outra origem existe). Registrado porque é uma
-- mudança silenciosa de semântica: se um dia nascer linha não-'normal', ela deixará de
-- compor o preço médio — o que é provavelmente o comportamento DESEJADO (origem anormal
-- não deve formar preço de compra), mas passaria a valer sem ninguém decidir. Fica o aviso.
--
-- ⚠️ NÃO corrige (fora de escopo, medido e registrado): v_sku_parametros_sugeridos tem uma
--    CTE GÊMEA com o mesmo defeito — calcula `preco_compra_real` com o mesmo
--    AVG(valor_total/qtde) sobre v_sku_leadtime_history_normal (tem o filtro 'normal', não
--    tem o dedup). Ela NÃO estava na lista de consumidores crus do sync-registry (a lista
--    estava incompleta; corrigida neste PR). É objeto diferente (VIEW), read-only (nenhuma
--    função persiste esse número) e com dependentes próprios ⇒ merece PR e baseline
--    próprios. Chip aberto.
--
-- Prova: db/test-preco-medio-leadtime-efetivo.sh (PG17, asserts + falsificação).
-- Baseline pré-apply (prova de não-colateral, esperado delta ZERO nos dois — esta migration
-- não toca a view): distribuição de `fonte_lt` e soma-controle de `preco_compra_real` em
-- v_sku_parametros_sugeridos. Ver a nota do PR.

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
  -- [DEDUP-NFE] 1 obs por (empresa, NFe, SKU); antes: 1 por LINHA de sku_leadtime_history, o que
  -- ponderava o AVG pela multiplicidade (NFe que fatura N pedidos regravava o item N×).
  -- [2 CONSUMIDORES] O filtro de preço saiu do WHERE e virou FILTER na agregação — de propósito.
  -- Esta CTE serve a DOIS consumidores, que fazem perguntas DIFERENTES:
  --   · preco_unitario → "quanto custou?"  ⇒ agrega só a obs precificável (FILTER). Sem nenhuma
  --     ⇒ NULL, e o COALESCE(cmc, …) decide. Ausente ≠ zero.
  --   · n (lido SÓ como `pm.n IS NULL` ⇒ primeira_compra) → "já foi comprado?" ⇒ conta TODA obs.
  --     COMPRAR ≠ SABER QUANTO CUSTOU. Com o filtro no WHERE, a obs cuja quantidade a view NULLa
  --     (cópias divergem) derrubaria o SKU INTEIRO da CTE ⇒ o badge mentiria "primeira compra"
  --     num SKU já comprado. Não é hipótese: medido ZERO no pré-flight e DOIS poucas horas
  --     depois, na MESMA sessão — o resíduo se move (o sync grava). Com o FILTER, o conjunto de
  --     primeira_compra fica IDÊNTICO ao de hoje (medido nos dois sentidos: nenhum SKU entra,
  --     nenhum sai), enquanto o preço passa a ser o deduplicado. É o único ponto em que esta
  --     migration se afasta do "trocar só o FROM" — e é o que a impede de trocar viés por mentira.
  preco_medio AS (
    SELECT slh.empresa::text AS empresa, slh.sku_codigo_omie::text AS sku_codigo_omie,
           AVG(slh.valor_total / NULLIF(slh.quantidade_recebida, 0))
             FILTER (WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0) AS preco_unitario,
           COUNT(*) AS n
    FROM v_sku_leadtime_efetivo slh
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

  -- [FILA estoque-não-confirmado] carimba ESTE run (limpo OU com supressão) em reposicao_motor_run, p/ a fila da
  -- tela ancorar no ÚLTIMO recálculo — não no último recálculo QUE TEVE supressão. Um run limpo não grava no log de
  -- suprimidos → sem este marcador a mensagem "N fora da compra" grudava por até 24h após o sync já ter confirmado o
  -- estoque (Codex 2026-07-08: é bug de FONTE-DE-VERDADE, não de render). Aditivo, FORA dos CTEs de decisão; mesmo
  -- role/caminho do INSERT no log acima (authenticated já escreve lá, RLS INSERT WITH CHECK true) → NÃO aborta a compra.
  INSERT INTO public.reposicao_motor_run (run_id, empresa, data_ciclo, pedidos_gerados, skus_incluidos, suprimidos_n)
  VALUES (v_run_id, p_empresa, p_data_ciclo, v_pedidos, v_skus,
          (SELECT count(*) FROM public.reposicao_estoque_nao_confirmado_log WHERE run_id = v_run_id));

  RETURN QUERY SELECT v_pedidos, v_skus, v_valor, v_bloqueados;
END;
$function$;

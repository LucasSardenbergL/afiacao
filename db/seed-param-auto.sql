-- Seed dos cenários p/ db/test-param-auto.sh (prova PG17 da auto-aplicação de parâmetros).
-- Roda DEPOIS de aplicar o snapshot + foundation + migrations A/B/C/D.
--
-- A view real v_sku_parametros_sugeridos computa EOQ/safety-stock/ABC-XYZ de dezenas de tabelas-base
-- (impossível dirigir a valores-alvo exatos). Aqui a SUBSTITUÍMOS por uma view controlada apoiada numa
-- tabela de cenário, expondo EXATAMENTE as colunas que a core lê. A core (plpgsql, late-binding)
-- resolve a view por nome em tempo de chamada → vê a controlada. Os 2 dependentes da view real
-- (v_oportunidade_economica_hoje / v_promocao_avaliacao_hoje) não são usados pela feature nem pelos
-- asserts → DROP CASCADE é seguro neste cluster descartável.
--
-- ⚠️ CALIBRAÇÃO PÓS-PROD (BLOCO D): o fusível agora é SÓ multiplicador (material + upward-only). O
-- gatilho de cobertura-absoluto FOI REMOVIDO (segurava 33/33 itens de giro lento — viés sistemático).
-- Os cenários abaixo provam: no-op NÃO vira falso segurado; giro lento inalterado = sem_mudanca;
-- salto 3× ainda segura; QUEDA do máximo aplica (assimétrico); base NULL bloqueia (cold-start manual).
--
-- sku_codigo_omie é BIGINT na saída da view real (raiz venda_items_history.sku_codigo_omie bigint) e
-- na sku_parametros → a controlada também expõe bigint p/ casar o JOIN da core (v=sp).

DROP VIEW IF EXISTS public.v_sku_parametros_sugeridos CASCADE;

CREATE TABLE public._param_sug_test (
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  sku_descricao text,
  fornecedor_nome text,
  estoque_minimo_sugerido numeric,
  ponto_pedido_sugerido numeric,
  estoque_maximo_sugerido numeric,
  estoque_seguranca_sugerido numeric,
  cobertura_alvo_dias integer,
  demanda_media_diaria numeric,
  demanda_sigma_diario numeric,
  coef_variacao_ordem numeric,
  num_ordens integer,
  valor_total_90d numeric,
  lead_time_medio numeric,
  lead_time_desvio numeric,
  lt_p95_dias numeric,
  fonte_leadtime text,
  z_aplicado numeric,
  classe_consolidada text,
  PRIMARY KEY (empresa, sku_codigo_omie)
);

CREATE VIEW public.v_sku_parametros_sugeridos AS SELECT * FROM public._param_sug_test;

-- ── sku_parametros: estado ANTES (todos OBEN, habilitados, automatica salvo I/J) ──
-- A normal→aplica · B salto>3x→segura · C giro-lento-no-op→sem_mudanca (prova cobertura morta)
-- D máx<pp→bloqueia · E pin igual→pina · F pin diferente→aplica+limpa pin · G igual ao atual→sem_mudanca
-- H fusível>pin→segura · I desabilitado→aplica sem logar · J prod_acabado→aplica sem logar
-- K base NULL→bloqueia (cold-start) · L queda do máximo→aplica (assimétrico)
INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
   ponto_pedido, estoque_minimo, estoque_maximo, estoque_seguranca, cobertura_alvo_dias,
   habilitado_reposicao_automatica, tipo_reposicao, ativo)
VALUES
  ('OBEN', 1001, 'SKU-A normal',         'FORN-A', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 1002, 'SKU-B salto>3x',       'FORN-B', 50, 20, 100, 15, 25, true, 'automatica', true),
  ('OBEN', 1003, 'SKU-C giro-lento no-op','FORN-C', 30, 20, 200, 15, 25, true, 'automatica', true),
  ('OBEN', 1004, 'SKU-D max<pp',         'FORN-D', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 1005, 'SKU-E pin igual',      'FORN-E', 40, 18, 100, 12, 28, true, 'automatica', true),
  ('OBEN', 1006, 'SKU-F pin diferente',  'FORN-F', 40, 18, 100, 12, 28, true, 'automatica', true),
  ('OBEN', 1007, 'SKU-G igual ao atual', 'FORN-G', 50, 20, 120, 15, 30, true, 'automatica', true),
  ('OBEN', 1008, 'SKU-H fusivel>pin',    'FORN-H', 50, 20, 100, 15, 25, true, 'automatica', true),
  ('OBEN', 1009, 'SKU-I desabilitado',   'FORN-I', 50, 20, 120, 15, 30, false,'automatica', true),
  ('OBEN', 1010, 'SKU-J prod_acabado',   'FORN-J', 50, 20, 120, 15, 30, true, 'produto_acabado', true),
  ('OBEN', 1011, 'SKU-K base NULL',      'FORN-K', NULL, NULL, NULL, NULL, NULL, true, 'automatica', true),
  ('OBEN', 1012, 'SKU-L queda do máximo','FORN-L', 50, 20, 120, 15, 30, true, 'automatica', true);

-- ── Sugestões da view controlada (status já implícito: todos OK = não-NULL) ──
INSERT INTO public._param_sug_test
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
   estoque_minimo_sugerido, ponto_pedido_sugerido, estoque_maximo_sugerido, estoque_seguranca_sugerido,
   cobertura_alvo_dias, demanda_media_diaria, demanda_sigma_diario, coef_variacao_ordem, num_ordens,
   valor_total_90d, lead_time_medio, lead_time_desvio, lt_p95_dias, fonte_leadtime, z_aplicado, classe_consolidada)
VALUES
  -- A: pp 50→60, máx 120→140 (≤3×120) → APLICADO
  ('OBEN',1001,'SKU-A normal','FORN-A',       20, 60, 140, 15, 35, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- B: máx 100→400 (>3×100=300) → SEGURADO (isola o multiplicador, upward)
  ('OBEN',1002,'SKU-B salto>3x','FORN-B',      20, 50, 400, 15, 25, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- C: GIRO LENTO. demanda 1/dia, máx 200 INALTERADO (200/1=200d de cobertura). Antes seguraria por
  --    cobertura (>120d); agora máx==antes e ≤3× → SEM_MUDANCA. Prova que o gatilho de cobertura morreu.
  ('OBEN',1003,'SKU-C giro-lento no-op','FORN-C', 20, 30, 200, 15, 25, 1, 0.5, 0.30, 12, 3000, 7, 2, 9, 'historico', 1.64, 'CZ'),
  -- D: máx 40 < pp 60 → BLOQUEADO_VALIDACAO (validação vence base/fusível/pin)
  ('OBEN',1004,'SKU-D max<pp','FORN-D',         20, 60, 40, 15, 30, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- E: sug pp 50/máx 120 == pin rejeitado (50/120) → PINADO (antes 40/100 difere, mas o pin segura)
  ('OBEN',1005,'SKU-E pin igual','FORN-E',      20, 50, 120, 15, 30, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- F: sug pp 70/máx 150 != pin rejeitado (50/120) e != antes (40/100) → APLICADO + pin limpo
  ('OBEN',1006,'SKU-F pin diferente','FORN-F',  18, 70, 150, 12, 30, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- G: sug pp 50/máx 120 == antes (50/120) → SEM_MUDANCA (não loga)
  ('OBEN',1007,'SKU-G igual ao atual','FORN-G', 20, 50, 120, 15, 30, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- H: máx 100→400 (>3×100) E pin bate (50/400) → pin VENCE o fusível (precedência nova) → PINADO
  ('OBEN',1008,'SKU-H fusivel>pin','FORN-H',     20, 50, 400, 15, 25, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- I: aplica config (sug != antes) MAS habilitado=false → NÃO loga (escopo do log = elegível ao motor)
  ('OBEN',1009,'SKU-I desabilitado','FORN-I',    20, 65, 145, 15, 35, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- J: aplica config MAS tipo_reposicao=produto_acabado → NÃO loga
  ('OBEN',1010,'SKU-J prod_acabado','FORN-J',    20, 65, 145, 15, 35, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- K: base NULL (primeira parametrização). Sugestão coerente → BLOQUEADO_VALIDACAO (cold-start manual).
  ('OBEN',1011,'SKU-K base NULL','FORN-K',       20, 60, 140, 15, 35, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX'),
  -- L: QUEDA do máximo 120→4 (pp 50→2). Fusível é upward-only → não segura → APLICADO (assimétrico).
  ('OBEN',1012,'SKU-L queda do máximo','FORN-L',  1,  2,   4,  1, 30, 4, 1.0, 0.25, 12, 5000, 7, 2, 9, 'historico', 1.64, 'AX');

-- ── Pins para E (igual), F (diferente) e H (bate, mas pin agora vence o fusível) ──
INSERT INTO public.reposicao_param_pin (empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado)
VALUES
  ('OBEN', '1005', 50, 120),   -- E: bate com a sugestão → pina
  ('OBEN', '1006', 50, 120),   -- F: NÃO bate (sug 70/150) → aplica e este pin é apagado
  ('OBEN', '1008', 50, 400);   -- H: bate (50/400) e o pin decide ANTES do fusível → pinado (pin fica)

-- ── Posição de estoque + custo p/ o impacto (best-effort). account canônico OBEN = 'oben'. ──
-- A: posição 30 (<= pp_antes 50 e pp_depois 60) → qtde_antes=120-30=90, qtde_depois=140-30=110, Δ20×cmc10=200
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
VALUES
  ('OBEN','1001', 30, 0),
  ('OBEN','1002', 30, 0),
  ('OBEN','1006', 30, 0);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, preco_medio)
VALUES
  (1001,'oben', 10, 8),   -- A: cmc=10 → impacto 200
  (1002,'oben', 10, 8),   -- B segurado: Δ0 → impacto 0
  (1006,'oben', 10, 8);   -- F: custo presente

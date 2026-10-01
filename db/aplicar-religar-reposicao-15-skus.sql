-- ============================================================
-- Religa a reposição automática de 15 SKUs Sayerlack (OBEN), pelo `db:aplicar` (SEM envelope)
-- Decisão do founder em 2026-09-29 (sessão fca-wp01-cockpit-demanda).
-- ============================================================
-- Sintoma: FCA.7090QT e WP01.3900QT nunca apareciam no cockpit (/admin/reposicao/sessao), mesmo
-- com saldo <= ponto de pedido e pedido de venda em aberto (FCA.7090QT: 6 un, saldo 1).
--
-- Causa: os 15 abaixo estavam em `sku_parametros` com tipo_reposicao='automatica' mas
-- habilitado_reposicao_automatica=false, e o motor `gerar_pedidos_sugeridos_ciclo` só lê SKU com o
-- flag TRUE. O cockpit só mostra o que o motor gera. Nenhum dos 15 chegou aí por decisão humana
-- (as ações da UI gravam 'descontinuado'/'sob_encomenda', nunca 'automatica'+false):
--   1. inativação no Omie: o trigger `sincronizar_ativo_omie_para_reposicao` desliga o flag e, na
--      reativação, NÃO religa. Só abre evento 'sku_reativado_omie' de severidade info, fora do
--      badge; o alerta de atenção da inativação é fechado sozinho como 'resolvido_auto'.
--   2. nascimento: a linha criada pelo job de classificação (`atualizar_classificacao_skus`) herda o
--      default false da coluna; o cold start, que cria ligado, só atua em SKU SEM linha.
--
-- Fora de propósito: o 405ML 8689781893 (WJOI.7585 405ML) estava na mesma situação, mas 405ML/450ML
-- são fracionados — vendidos, nunca comprados — e ficam desligados DE PROPÓSITO (20260515000202 e
-- 20260530143818). A postcondição P3 garante que nenhum fracionado entrou nesta lista.
--
-- Efeito: o SKU volta a ser SUGERIDO. Comprar continua exigindo aprovação humana — a auto-aprovação
-- está desligada (company_config.reposicao_auto_aprovacao_ativa = false, medido em 2026-09-29).
--
-- Os eventos 'sku_reativado_omie' pendentes desses SKUs perguntavam exatamente isto ("Revisar se
-- deseja habilitar reposição automática novamente") e são fechados como 'aceito', espelhando o UPDATE
-- do RPC `resolver_outlier` — que exige auth.uid() de staff e por isso não roda por este canal.
--
-- Pré-voo (psql-ro, 2026-09-29): 15 alvos, 15 com linha, 15 em ('automatica', false), 0 já ligados,
-- 16 eventos 'sku_reativado_omie' pendentes, 390 SKUs OBEN ligados antes.
--
-- Idempotente: os WHERE só pegam o que ainda está desligado/pendente; re-rodar não muda nada.

-- A lista existe UMA vez: os dois UPDATEs e a postcondição leem daqui (sem cópia para divergir).
CREATE TEMP TABLE _religar (sku bigint PRIMARY KEY) ON COMMIT DROP;
INSERT INTO pg_temp._religar (sku) VALUES
  (12034226322),  -- CATALISADOR FCA.7090QT (6 un em pedido de venda aberto, saldo 1, ponto 3)
  (8689775044),   -- WP01.3900QT CONCENTRADO PRETO INTENSO (desligado na inativação Omie de 04/07)
  (12067285434),  -- CATALISADOR FCA.7090LT
  (8689736464),   -- CATALISADOR FC.6902LT
  (8689733082),   -- VERNIZ PU FOSCO FO5.6717.00BH
  (8689960103),   -- VERNIZ PU FOSCO FO10.6717.00BH
  (8689774769),   -- VERNIZ PU FOSCO FO10.6717.00GL
  (8689783623),   -- VERNIZ PU FOSCO FO20.6717.00BH
  (8689717555),   -- VERNIZ PU FOSCO FO20.6717.00GL
  (8689731064),   -- FUNDO ACRILICO JL.7705.00BH
  (8689791550),   -- F ACAB FL20.6480.00LT
  (8689718356),   -- F ACAB BASE AGUA YLO1.1118.00QT
  (8689723427),   -- WP02.3900QT CONCENTRADO BRANCO
  (8689744108),   -- TINGIDOR CONCENTRADO NEGRO TE.3550.01FG
  (8689723623);   -- THINNER DR.4403QT

UPDATE public.sku_parametros sp
   SET habilitado_reposicao_automatica = true
  FROM pg_temp._religar r
 WHERE sp.empresa = 'OBEN'
   AND sp.sku_codigo_omie = r.sku
   AND sp.tipo_reposicao = 'automatica'
   AND sp.habilitado_reposicao_automatica = false;

UPDATE public.eventos_outlier e
   SET status = 'aceito',
       decidido_em = now(),
       decidido_por = 'lucascoelhosardenberg@gmail.com',
       justificativa_decisao = 'Reposição automática religada por db/aplicar-religar-reposicao-15-skus.sql (aplicado pela sessão Claude, decisão do founder em 2026-09-29).'
  FROM pg_temp._religar r
 WHERE e.empresa = 'OBEN'
   AND e.sku_codigo_omie = r.sku::text
   AND e.tipo = 'sku_reativado_omie'
   AND e.status = 'pendente';

-- ------------------------------------------------------------
-- Postcondição — aborta a transação do `db:aplicar` se o estado final não bater
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_alvos    int;
  v_ligados  int;
  v_pend     int;
  v_frac     int;
BEGIN
  SELECT count(*) INTO v_alvos FROM pg_temp._religar;
  IF v_alvos <> 15 THEN
    RAISE EXCEPTION 'P0 FALHOU: a lista tem % SKUs, esperava 15', v_alvos;
  END IF;

  SELECT count(*) INTO v_ligados
    FROM public.sku_parametros sp JOIN pg_temp._religar r ON r.sku = sp.sku_codigo_omie
   WHERE sp.empresa = 'OBEN'
     AND sp.tipo_reposicao = 'automatica'
     AND sp.habilitado_reposicao_automatica;
  IF v_ligados <> 15 THEN
    RAISE EXCEPTION 'P1 FALHOU: esperava os 15 SKUs ligados como automatica, achei %', v_ligados;
  END IF;

  SELECT count(*) INTO v_pend
    FROM public.eventos_outlier e JOIN pg_temp._religar r ON e.sku_codigo_omie = r.sku::text
   WHERE e.empresa = 'OBEN'
     AND e.tipo = 'sku_reativado_omie'
     AND e.status = 'pendente';
  IF v_pend <> 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: ainda ha % eventos sku_reativado_omie pendentes para os 15', v_pend;
  END IF;

  -- P3: nenhum fracionado (405ML/450ML, desligados de proposito) entrou na lista.
  SELECT count(*) INTO v_frac
    FROM public.omie_products op JOIN pg_temp._religar r ON op.omie_codigo_produto = r.sku
   WHERE op.account = 'oben'
     AND (op.descricao ILIKE '%405ML' OR op.descricao ILIKE '%450ML');
  IF v_frac <> 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: % SKU(s) fracionado(s) 405ML/450ML na lista — esses ficam desligados de proposito', v_frac;
  END IF;
END
$post$;

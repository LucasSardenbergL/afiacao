-- Venda por cliente, rodada 2, Entrega 3: demonstrativo de CONTRIBUIÇÃO por cliente/pedido/SKU. [money-path]
-- Só o founder (gate private.cap_custo_ler E has_role master). Spec da rodada:
-- docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md. Medições e decisões:
-- docs/historico/venda-contribuicao-cliente.md. Prova: db/test-venda-contribuicao.sh.
--
-- Contribuição da linha = receita líquida do desconto do item − custo − custo financeiro do prazo.
--   * receita líquida = unit_price × quantity − desconto_valor (R$ da LINHA). Desconto NÃO apurado (NULL) ou
--     inválido (negativo, NaN, maior que o bruto) ⇒ receita NULL, NUNCA a receita cheia. Preço exige > 0 (a
--     mesma régua do helper de margem: unit_price foi NOT NULL DEFAULT 0).
--   * custo = "CMC estimado pela posição anterior": o cmc_snapshot (grade mensal) mais recente com
--     data_posicao ≤ dia do pedido e idade < 45 dias — senão o custo ATUAL de product_costs, MARCADO
--     (`custo_fonte = 'atual'`) — senão NULL. O cmc_ledger fica FORA de propósito: ele registra mudança
--     OBSERVADA, não vigência, e misturá-lo com o snapshot não dá série homogênea (Codex, desenho).
--   * custo do prazo = receita líquida × (1 − S), S = Σ vᵢ·(1+r)^(−dᵢ/365) / Σ vᵢ, dᵢ = vencimento − emissão
--     da parcela (pesos por VALOR), r = taxa de capital VIGENTE da empresa aplicada ao passado. É o custo
--     ESTIMADO do prazo vigente dos títulos, desde a emissão, à taxa atual — renegociação reescreve vencimento.
--   * NÃO deduz imposto sobre venda, frete nem devoluções/estornos: "contribuição antes de impostos, frete e
--     devoluções".
--
-- Casamento pedido → títulos (medido em prod 2026-11-12): (company = account, btrim(numero_pedido) =
-- btrim(omie_numero_pedido), status ≠ CANCELADO, emissão ∈ [dia − 3, dia + 60]); o título só vale se casar com
-- UM pedido entre TODOS os pedidos de venda (não só os da janela — a colacor reusa o número), se o cliente do
-- título for o cadastro Omie do pedido (omie_customer_account_map) e se |Σ valor_documento − total| ≤
-- max(1, 0,5%·total). Qualquer falha ⇒ prazo NULL com motivo. Nunca se procura subconjunto de parcelas.
--
-- Não toca a margem que a carteira mostra (private.margem_cliente_agregada). Só cria 2 funções novas.
-- Sem BEGIN/COMMIT: o db:aplicar fornece a transação (no SQL Editor o script é uma transação implícita).

SET LOCAL lock_timeout = '5s';

-- ── 1. Linhas valoradas (o motor, sem gate de JWT; só o owner executa) ─────────────────────────────────────
CREATE OR REPLACE FUNCTION private.venda_contribuicao_linhas(p_desde date, p_ate date)
 RETURNS TABLE(
   order_item_id uuid, empresa text, comprador_id uuid, sales_order_id uuid, omie_numero_pedido text,
   data_pedido date, omie_codigo_produto bigint, descricao text, familia text, quantidade numeric,
   receita_bruta numeric, desconto_status text, desconto numeric, receita_liquida numeric,
   custo_unit numeric, custo_fonte text, custo_posicao date, custo_total numeric,
   piso_markup numeric, abaixo_piso boolean, gap_piso numeric,
   prazo_status text, prazo_medio_dias numeric, fator_pv numeric, custo_prazo numeric,
   contribuicao numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
  WITH base AS MATERIALIZED (
    -- Universo = o de private.venda_linhas_pedido (denylist de status, comprador canônico por alias ATIVO, dia
    -- do pedido em SP), recortado pela janela. Uma linha por order_items.id (a prova cobra a cardinalidade).
    SELECT oi.id                                                         AS order_item_id,
           so.account                                                    AS empresa,
           COALESCE(a.canonical_user_id, so.customer_user_id)            AS comprador_id,
           so.customer_user_id                                           AS cliente_cadastro,
           so.id                                                         AS sales_order_id,
           nullif(btrim(so.omie_numero_pedido), '')                      AS np,
           so.total                                                      AS total_pedido,
           COALESCE(so.order_date_kpi,
                    (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido,
           oi.omie_codigo_produto                                        AS sku,
           oi.quantity                                                   AS qtd,
           oi.unit_price                                                 AS preco,
           oi.desconto_valor                                             AS dv
      FROM public.order_items oi
      JOIN public.sales_orders so ON so.id = oi.sales_order_id
      LEFT JOIN public.customer_canonical_alias a           -- PK alias_user_id: não multiplica
             ON a.alias_user_id = so.customer_user_id AND a.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
       AND so.customer_user_id IS NOT NULL
       AND so.account IN ('oben', 'colacor', 'colacor_sc')
       AND oi.omie_codigo_produto IS NOT NULL
       -- `< 'Infinity'` também reprova NaN (o PG ordena NaN acima de tudo, inclusive de Infinity).
       AND oi.quantity > 0 AND oi.quantity < 'Infinity'::numeric
       AND COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
           BETWEEN p_desde AND p_ate
  ),
  valor AS (
    SELECT b.*,
           CASE WHEN b.preco > 0 AND b.preco < 'Infinity'::numeric THEN b.preco * b.qtd END AS rb,
           CASE WHEN NOT (b.preco > 0 AND b.preco < 'Infinity'::numeric)               THEN 'sem_preco'
                WHEN b.dv IS NULL                                                       THEN 'nao_apurado'
                WHEN b.dv >= 0 AND b.dv < 'Infinity'::numeric AND b.dv <= b.preco * b.qtd THEN 'apurado'
                ELSE 'invalido'
           END AS ds
      FROM base b
  ),
  custo AS (
    SELECT v.*,
           cd.cmc          AS cmc_data,
           cd.data_posicao AS cmc_posicao,
           ca.custo_atual,
           ca.familia,
           ca.descricao
      FROM valor v
      LEFT JOIN LATERAL (
        SELECT s.cmc, s.data_posicao
          FROM public.cmc_snapshot s
         WHERE s.account = ANY (CASE v.empresa WHEN 'oben'    THEN ARRAY['vendas', 'oben']
                                               WHEN 'colacor' THEN ARRAY['colacor_vendas']
                                               ELSE ARRAY['servicos'] END)
           AND s.omie_codigo_produto = v.sku
           AND s.data_posicao <= v.data_pedido
           AND s.data_posicao >  v.data_pedido - 45
           AND s.cmc > 0 AND s.cmc < 'Infinity'::numeric
         ORDER BY s.data_posicao DESC, s.account, s.cmc
         LIMIT 1
      ) cd ON true
      LEFT JOIN LATERAL (
        -- Custo ATUAL: a mesma régua do helper de margem da carteira (cost_final, senão cost_price; > 0 e finito).
        SELECT COALESCE(
                 CASE WHEN pc.cost_final > 0 AND pc.cost_final < 'Infinity'::numeric THEN pc.cost_final END,
                 CASE WHEN pc.cost_price > 0 AND pc.cost_price < 'Infinity'::numeric THEN pc.cost_price END
               ) AS custo_atual,
               op.familia,
               op.descricao
          FROM public.omie_products op
          LEFT JOIN public.product_costs pc ON pc.product_id = op.id   -- product_id é UNIQUE
         WHERE op.omie_codigo_produto = v.sku
         ORDER BY (op.account = v.empresa) DESC, op.id
         LIMIT 1
      ) ca ON true
  ),
  linha AS (
    SELECT c.*,
           CASE WHEN c.ds = 'apurado' THEN c.rb - c.dv END                  AS rl,
           COALESCE(c.cmc_data, c.custo_atual)                              AS cu,
           CASE WHEN c.cmc_data IS NOT NULL THEN 'cmc_data'
                WHEN c.custo_atual IS NOT NULL THEN 'atual' END             AS cf,
           rp.piso_markup                                                   AS piso
      FROM custo c
      LEFT JOIN public.cliente_tier_preco t                  -- PK (company, customer_user_id): não multiplica
             ON t.company = c.empresa AND t.customer_user_id = c.cliente_cadastro
      -- LEFT: o resolver devolve ZERO linhas quando não há política; um JOIN interno apagaria o item.
      LEFT JOIN LATERAL public.resolve_markup_policy(c.empresa, c.sku, c.familia, t.tier) rp ON true
  ),
  pedido AS MATERIALIZED (
    SELECT DISTINCT l.sales_order_id, l.empresa, l.cliente_cadastro, l.np, l.total_pedido, l.data_pedido
      FROM linha l
  ),
  -- Exclusividade contra TODOS os pedidos de venda com aquele número, não só os da janela: um título no limite
  -- da janela de outro pedido de mesmo número (a colacor reusa) não pode financiar os dois.
  pedido_todos AS MATERIALIZED (
    SELECT so.id, so.account, btrim(so.omie_numero_pedido) AS np,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS d
      FROM public.sales_orders so
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
       AND nullif(btrim(so.omie_numero_pedido), '') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pedido p
                    WHERE p.empresa = so.account AND p.np = btrim(so.omie_numero_pedido))
  ),
  cand AS MATERIALIZED (
    SELECT c.id AS titulo_id, pt.id AS pedido_id
      FROM public.fin_contas_receber c
      JOIN pedido_todos pt
        ON c.company = pt.account
       AND btrim(c.numero_pedido) = pt.np
       AND c.data_emissao BETWEEN pt.d - 3 AND pt.d + 60
     WHERE c.status_titulo IS DISTINCT FROM 'CANCELADO'
  ),
  excl AS (
    SELECT ca.titulo_id, count(DISTINCT ca.pedido_id) > 1 AS multi FROM cand ca GROUP BY ca.titulo_id
  ),
  tit AS (
    SELECT p.sales_order_id,
           c.valor_documento                                          AS v,
           (c.data_vencimento - c.data_emissao)                       AS d,
           e.multi,
           (m.omie_codigo_cliente IS NOT NULL
            AND m.omie_codigo_cliente = c.omie_codigo_cliente)        AS cliente_ok
      FROM pedido p
      JOIN cand ca ON ca.pedido_id = p.sales_order_id
      JOIN public.fin_contas_receber c ON c.id = ca.titulo_id
      JOIN excl e ON e.titulo_id = ca.titulo_id
      LEFT JOIN public.omie_customer_account_map m            -- UNIQUE (user_id, account): não multiplica
             ON m.user_id = p.cliente_cadastro AND m.account = p.empresa
  ),
  taxa AS MATERIALIZED (
    -- A MESMA régua de public.fin_regua_custo_capital (20260704190000): (selic + spread)/100, componentes em
    -- [0,100], taxa em (0,1), match case-insensitive, sem armazenagem. Lida direto porque aquela função tem gate
    -- de staff por auth.uid() — o motor roda também na pós-condição, sem JWT. A prova cobra a PARIDADE.
    SELECT e.empresa,
           CASE WHEN cfg.selic_anual >= 0 AND cfg.selic_anual <= 100
                 AND cfg.spread_oportunidade >= 0 AND cfg.spread_oportunidade <= 100
                 AND (cfg.selic_anual + cfg.spread_oportunidade) / 100.0 > 0
                 AND (cfg.selic_anual + cfg.spread_oportunidade) / 100.0 < 1
                THEN (cfg.selic_anual + cfg.spread_oportunidade) / 100.0 END AS r
      FROM (SELECT DISTINCT p.empresa FROM pedido p) e
      LEFT JOIN LATERAL (
        SELECT c.selic_anual, c.spread_oportunidade
          FROM public.empresa_configuracao_custos c
         WHERE upper(c.empresa) = upper(e.empresa)
         LIMIT 1
      ) cfg ON true
  ),
  prazo AS (
    SELECT p.sales_order_id,
           CASE
             WHEN count(t.sales_order_id) = 0                                    THEN 'sem_titulo'
             WHEN bool_or(t.multi)                                               THEN 'ambiguo'
             WHEN bool_or(NOT t.cliente_ok)                                      THEN 'cliente_nao_confere'
             WHEN bool_or(t.v IS NULL OR NOT (t.v > 0 AND t.v < 'Infinity'::numeric))
               OR bool_or(t.d IS NULL)                                           THEN 'titulo_invalido'
             WHEN NOT (p.total_pedido > 0 AND p.total_pedido < 'Infinity'::numeric)
               OR abs(sum(t.v) - p.total_pedido) > greatest(1, 0.005 * p.total_pedido) THEN 'valor_nao_bate'
             WHEN bool_or(t.d < 0 OR t.d > 180)                                  THEN 'prazo_fora_faixa'
             WHEN max(tx.r) IS NULL                                              THEN 'taxa_ausente'
             ELSE 'ok'
           END AS status,
           sum(t.v * t.d) / nullif(sum(t.v), 0)                                AS pm,
           sum(t.v * power(1 + tx.r, -t.d / 365.0)) / nullif(sum(t.v), 0)      AS fator
      FROM pedido p
      LEFT JOIN tit  t  ON t.sales_order_id = p.sales_order_id
      LEFT JOIN taxa tx ON tx.empresa = p.empresa
     GROUP BY p.sales_order_id, p.total_pedido
  )
  SELECT l.order_item_id,
         l.empresa,
         l.comprador_id,
         l.sales_order_id,
         l.np,
         l.data_pedido,
         l.sku,
         l.descricao,
         l.familia,
         l.qtd,
         l.rb,
         l.ds,
         CASE WHEN l.ds = 'apurado' THEN l.dv END,
         l.rl,
         l.cu,
         l.cf,
         l.cmc_posicao,
         CASE WHEN l.cu IS NOT NULL THEN l.cu * l.qtd END,
         l.piso,
         CASE WHEN l.rl IS NOT NULL AND l.cu IS NOT NULL AND l.piso IS NOT NULL
              THEN l.rl / l.qtd < l.cu * (1 + l.piso / 100) END,
         -- GREATEST(0, NULL) é 0 no PG: o CASE de fora é o que mantém o ausente ausente.
         CASE WHEN l.rl IS NOT NULL AND l.cu IS NOT NULL AND l.piso IS NOT NULL
              THEN greatest(0, l.cu * (1 + l.piso / 100) * l.qtd - l.rl) END,
         pz.status,
         CASE WHEN pz.status IN ('ok', 'taxa_ausente') THEN pz.pm END,
         CASE WHEN pz.status = 'ok' THEN pz.fator END,
         CASE WHEN pz.status = 'ok' AND l.rl IS NOT NULL THEN l.rl * (1 - pz.fator) END,
         CASE WHEN pz.status = 'ok' AND l.rl IS NOT NULL AND l.cu IS NOT NULL
              THEN l.rl - l.cu * l.qtd - l.rl * (1 - pz.fator) END
    FROM linha l
    JOIN prazo pz ON pz.sales_order_id = l.sales_order_id;
$function$;

COMMENT ON FUNCTION private.venda_contribuicao_linhas(date, date) IS
  'Contribuicao por LINHA de item (venda por cliente, rodada 2, entrega 3): receita liquida do desconto, CMC '
  'estimado pela posicao anterior (cmc_snapshot ate 45d) senao custo atual MARCADO, custo estimado do prazo '
  'vigente dos titulos casados ao pedido, a valor presente e a taxa atual. Toda perna ausente = NULL, nunca 0. '
  'Antes de impostos, frete e devolucoes. So o owner executa; a porta e public.venda_contribuicao.';

REVOKE ALL ON FUNCTION private.venda_contribuicao_linhas(date, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.venda_contribuicao_linhas(date, date) FROM anon, authenticated;

-- ── 2. A porta: agrega por eixo, com coberturas por linha, numa tupla só ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_contribuicao(
  p_janela  text DEFAULT '12m',
  p_eixo    text DEFAULT 'cliente',
  p_empresa text DEFAULT NULL,
  p_ordem   text DEFAULT 'contribuicao_asc',
  p_limite  integer DEFAULT 50,
  p_offset  integer DEFAULT 0
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_ate   date;
  v_desde date;
  v_out   jsonb;
BEGIN
  -- Dois gates: a capability de custo (a fronteira de custo do repo) E master — cap_custo_ler sozinha admite
  -- employee com papel comercial estratégico, e este demonstrativo é só do founder.
  IF NOT private.cap_custo_ler((SELECT auth.uid())) THEN
    RAISE EXCEPTION 'forbidden: contribuicao exige leitura de custo' USING ERRCODE = '42501';
  END IF;
  IF NOT public.has_role((SELECT auth.uid()), 'master'::public.app_role) THEN
    RAISE EXCEPTION 'forbidden: contribuicao e so do master' USING ERRCODE = '42501';
  END IF;

  IF p_janela IS NULL OR p_janela NOT IN ('12m', '90d') THEN
    RAISE EXCEPTION 'p_janela invalida: use 12m ou 90d' USING ERRCODE = '22023';
  END IF;
  IF p_eixo IS NULL OR p_eixo NOT IN ('empresa', 'cliente', 'pedido', 'sku', 'familia', 'vendedor') THEN
    RAISE EXCEPTION 'p_eixo invalido' USING ERRCODE = '22023';
  END IF;
  IF p_ordem IS NULL OR p_ordem NOT IN ('contribuicao_asc', 'desconto_desc', 'custo_prazo_desc',
                                        'gap_piso_desc', 'receita_desc') THEN
    RAISE EXCEPTION 'p_ordem invalida' USING ERRCODE = '22023';
  END IF;
  IF p_empresa IS NOT NULL AND p_empresa NOT IN ('oben', 'colacor', 'colacor_sc') THEN
    RAISE EXCEPTION 'p_empresa invalida' USING ERRCODE = '22023';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 200 OR p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'paginacao invalida: 1 <= p_limite <= 200, p_offset >= 0' USING ERRCODE = '22023';
  END IF;

  -- Janela por dia do pedido em SP, inclusiva dos dois lados: 12m = 365 datas, 90d = 90 datas.
  v_ate   := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_desde := v_ate - CASE p_janela WHEN '12m' THEN 364 ELSE 89 END;

  -- Eixo de vendedor: "quem vendeu" é a Entrega 2 e ainda não existe — o eixo diz que está indisponível em vez
  -- de inventar um dono (o created_by do importado é carimbo técnico, não autoria — database.md §4).
  IF p_eixo = 'vendedor' THEN
    RETURN jsonb_build_object(
      'janela', p_janela, 'desde', v_desde, 'ate', v_ate, 'eixo', p_eixo,
      'indisponivel', true,
      'motivo', 'a atribuicao de vendedor por pedido ainda nao existe (Entrega 2 da rodada 2)');
  END IF;

  WITH l AS MATERIALIZED (
    SELECT x.*
      FROM private.venda_contribuicao_linhas(v_desde, v_ate) x
     WHERE p_empresa IS NULL OR x.empresa = p_empresa
  ),
  k AS (
    SELECT l.*,
           CASE p_eixo
             WHEN 'empresa' THEN l.empresa
             WHEN 'cliente' THEN l.comprador_id::text
             WHEN 'pedido'  THEN l.sales_order_id::text           -- ID interno: o número é reutilizado
             WHEN 'sku'     THEN l.omie_codigo_produto::text
             WHEN 'familia' THEN COALESCE(l.familia, '(sem familia)')
           END AS chave
      FROM l
  ),
  g AS (
    SELECT CASE WHEN GROUPING(k.chave) = 0 THEN 'eixo'
                WHEN GROUPING(k.empresa) = 0 THEN 'empresa'
                ELSE 'total' END                                                     AS nivel,
           CASE WHEN GROUPING(k.chave) = 0 THEN k.chave
                WHEN GROUPING(k.empresa) = 0 THEN k.empresa END                      AS chave,
           count(*)                                                                  AS itens,
           count(*) FILTER (WHERE k.desconto_status = 'sem_preco')                   AS itens_sem_preco,
           count(*) FILTER (WHERE k.desconto_status = 'nao_apurado')                 AS itens_desconto_nao_apurado,
           count(*) FILTER (WHERE k.desconto_status = 'invalido')                    AS itens_desconto_invalido,
           sum(k.receita_bruta) FILTER (WHERE k.receita_liquida IS NULL)             AS receita_bruta_sem_liquida,
           count(*) FILTER (WHERE k.custo_fonte = 'cmc_data')                        AS itens_custo_data,
           count(*) FILTER (WHERE k.custo_fonte = 'atual')                           AS itens_custo_atual,
           count(*) FILTER (WHERE k.custo_fonte IS NULL)                             AS itens_sem_custo,
           sum(k.receita_bruta)                                                      AS receita_bruta,
           sum(k.desconto)                                                           AS desconto,
           sum(k.receita_liquida)                                                    AS receita_liquida,
           sum(k.receita_liquida) FILTER (WHERE k.custo_total IS NOT NULL)           AS receita_com_custo,
           sum(k.receita_liquida) FILTER (WHERE k.custo_fonte = 'atual')             AS receita_custo_atual,
           sum(k.custo_total) FILTER (WHERE k.receita_liquida IS NOT NULL)           AS custo,
           count(DISTINCT k.sales_order_id)                                          AS pedidos,
           count(DISTINCT k.sales_order_id) FILTER (WHERE k.prazo_status = 'ok')     AS pedidos_prazo_ok,
           count(DISTINCT k.sales_order_id) FILTER (WHERE k.prazo_status = 'sem_titulo')   AS pedidos_sem_titulo,
           count(DISTINCT k.sales_order_id) FILTER (WHERE k.prazo_status = 'taxa_ausente') AS pedidos_taxa_ausente,
           count(DISTINCT k.sales_order_id)
             FILTER (WHERE k.prazo_status NOT IN ('ok', 'sem_titulo', 'taxa_ausente'))       AS pedidos_prazo_rejeitado,
           sum(k.receita_liquida) FILTER (WHERE k.custo_prazo IS NOT NULL)           AS receita_com_prazo,
           sum(k.custo_prazo)                                                        AS custo_prazo,
           sum(k.prazo_medio_dias * k.receita_liquida)
             / nullif(sum(k.receita_liquida) FILTER (WHERE k.prazo_medio_dias IS NOT NULL), 0) AS prazo_medio_dias,
           -- A INTERSEÇÃO das três pernas: a ponte receita − custo − prazo = contribuição fecha só aqui.
           sum(k.receita_liquida) FILTER (WHERE k.contribuicao IS NOT NULL)          AS receita_contribuicao,
           sum(k.custo_total)     FILTER (WHERE k.contribuicao IS NOT NULL)          AS custo_contribuicao,
           sum(k.custo_prazo)     FILTER (WHERE k.contribuicao IS NOT NULL)          AS custo_prazo_contribuicao,
           sum(k.contribuicao)                                                       AS contribuicao,
           count(*) FILTER (WHERE k.abaixo_piso IS NOT NULL)                         AS itens_com_piso,
           count(*) FILTER (WHERE k.abaixo_piso)                                     AS itens_abaixo_piso,
           sum(k.gap_piso)                                                           AS gap_piso,
           min(k.empresa)                                                            AS empresa_min,
           count(DISTINCT k.empresa)                                                 AS n_empresas,
           min(k.omie_numero_pedido)                                                 AS np_min,
           min(k.data_pedido)                                                        AS data_min,
           min(k.comprador_id::text)                                                 AS comprador_min,
           min(k.descricao)                                                          AS descricao_min,
           min(k.familia)                                                            AS familia_min
      FROM k
     GROUP BY GROUPING SETS ((k.chave), (k.empresa), ())
  ),
  m AS (
    SELECT g.*,
           jsonb_build_object(
             'itens', g.itens,
             'itens_sem_preco', g.itens_sem_preco,
             'itens_desconto_nao_apurado', g.itens_desconto_nao_apurado,
             'itens_desconto_invalido', g.itens_desconto_invalido,
             'receita_bruta_sem_liquida', round(g.receita_bruta_sem_liquida, 2),
             'itens_custo_data', g.itens_custo_data,
             'itens_custo_atual', g.itens_custo_atual,
             'itens_sem_custo', g.itens_sem_custo,
             'receita_bruta', round(g.receita_bruta, 2),
             'desconto', round(g.desconto, 2),
             'receita_liquida', round(g.receita_liquida, 2),
             'receita_com_custo', round(g.receita_com_custo, 2),
             'receita_custo_atual', round(g.receita_custo_atual, 2),
             'custo', round(g.custo, 2),
             'margem_bruta', round(g.receita_com_custo - g.custo, 2),
             'margem_bruta_pct', CASE WHEN g.receita_com_custo > 0
                                      THEN round((g.receita_com_custo - g.custo) / g.receita_com_custo * 100, 2) END,
             'pedidos', g.pedidos,
             'pedidos_prazo_ok', g.pedidos_prazo_ok,
             'pedidos_sem_titulo', g.pedidos_sem_titulo,
             'pedidos_taxa_ausente', g.pedidos_taxa_ausente,
             'pedidos_prazo_rejeitado', g.pedidos_prazo_rejeitado,
             'receita_com_prazo', round(g.receita_com_prazo, 2),
             'custo_prazo', round(g.custo_prazo, 2),
             'custo_prazo_pct', CASE WHEN g.receita_com_prazo > 0
                                     THEN round(g.custo_prazo / g.receita_com_prazo * 100, 2) END,
             'prazo_medio_dias', round(g.prazo_medio_dias, 1),
             'receita_contribuicao', round(g.receita_contribuicao, 2),
             'custo_contribuicao', round(g.custo_contribuicao, 2),
             'custo_prazo_contribuicao', round(g.custo_prazo_contribuicao, 2),
             'contribuicao', round(g.contribuicao, 2),
             'contribuicao_pct', CASE WHEN g.receita_contribuicao > 0
                                      THEN round(g.contribuicao / g.receita_contribuicao * 100, 2) END,
             'itens_com_piso', g.itens_com_piso,
             'itens_abaixo_piso', g.itens_abaixo_piso,
             'gap_piso', round(g.gap_piso, 2)
           ) AS metricas
      FROM g
  ),
  eixo AS (
    SELECT m.*,
           CASE p_eixo
             WHEN 'cliente' THEN COALESCE(nullif(btrim(pr.razao_social), ''), pr.name, '(sem nome)')
             WHEN 'pedido'  THEN m.empresa_min || ' #' || COALESCE(m.np_min, '?')
             WHEN 'sku'     THEN COALESCE(m.descricao_min, m.chave)
             ELSE m.chave
           END AS rotulo,
           CASE p_eixo
             WHEN 'pedido'  THEN jsonb_build_object('empresa', m.empresa_min, 'numero', m.np_min,
                                                    'data', m.data_min, 'comprador_id', m.comprador_min,
                                                    'comprador', COALESCE(nullif(btrim(pc.razao_social), ''), pc.name))
             WHEN 'sku'     THEN jsonb_build_object('empresa', m.empresa_min, 'familia', m.familia_min)
             WHEN 'cliente' THEN jsonb_build_object('empresas', m.n_empresas)
             ELSE '{}'::jsonb
           END AS detalhe,
           CASE p_ordem
             WHEN 'contribuicao_asc' THEN m.contribuicao
             WHEN 'desconto_desc'    THEN -m.desconto
             WHEN 'custo_prazo_desc' THEN -m.custo_prazo
             WHEN 'gap_piso_desc'    THEN -m.gap_piso
             WHEN 'receita_desc'     THEN -m.receita_liquida
           END AS ordem_valor
      FROM m
      LEFT JOIN public.profiles pr ON p_eixo = 'cliente' AND pr.user_id::text = m.chave
      LEFT JOIN public.profiles pc ON p_eixo = 'pedido'  AND pc.user_id::text = m.comprador_min
     WHERE m.nivel = 'eixo'
  )
  SELECT jsonb_build_object(
           'janela', p_janela,
           'desde', v_desde,
           'ate', v_ate,
           'eixo', p_eixo,
           'empresa', p_empresa,
           'ordem', p_ordem,
           'limite', p_limite,
           'offset', p_offset,
           'indisponivel', false,
           'taxa_capital', jsonb_build_object(
                             'oben', public.fin_regua_custo_capital('oben'),
                             'colacor', public.fin_regua_custo_capital('colacor')),
           'total', (SELECT m.metricas FROM m WHERE m.nivel = 'total'),
           'por_empresa', COALESCE((SELECT jsonb_object_agg(m.chave, m.metricas) FROM m WHERE m.nivel = 'empresa'),
                                   '{}'::jsonb),
           'total_linhas', (SELECT count(*) FROM eixo),
           'linhas', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('chave', e.chave, 'rotulo', e.rotulo, 'detalhe', e.detalhe)
                              || e.metricas
                              ORDER BY e.ordem_valor ASC NULLS LAST, e.chave)
               FROM (SELECT * FROM eixo
                      ORDER BY ordem_valor ASC NULLS LAST, chave
                      LIMIT p_limite OFFSET p_offset) e
           ), '[]'::jsonb))
    INTO v_out;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.venda_contribuicao(text, text, text, text, integer, integer) IS
  'Demonstrativo de contribuicao (founder): por empresa/cliente/pedido/sku/familia, janelas 12m/90d, com '
  'coberturas por linha e por camada (custo na data x atual x ausente; prazo casado x sem titulo x taxa '
  'ausente) e a intersecao das tres pernas. Uma tupla jsonb (sem capa de 1.000), pagina estavel (metrica, '
  'chave). Gate cap_custo_ler E master. Eixo vendedor responde indisponivel ate a Entrega 2.';

REVOKE ALL ON FUNCTION public.venda_contribuicao(text, text, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.venda_contribuicao(text, text, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.venda_contribuicao(text, text, text, text, integer, integer) TO authenticated;

-- ── 3. Pós-condição: catálogo + EXECUÇÃO (plpgsql é late-bound) ─────────────────────────────────────────────
DO $post$
DECLARE
  v_linhas regprocedure := to_regprocedure('private.venda_contribuicao_linhas(date,date)');
  v_rpc    regprocedure := to_regprocedure('public.venda_contribuicao(text,text,text,text,integer,integer)');
BEGIN
  IF v_linhas IS NULL OR v_rpc IS NULL THEN
    RAISE EXCEPTION 'POS 1: funcoes da contribuicao ausentes (linhas=%, rpc=%)', v_linhas, v_rpc;
  END IF;
  IF has_function_privilege('anon', v_linhas, 'EXECUTE')
  OR has_function_privilege('authenticated', v_linhas, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS 2: private.venda_contribuicao_linhas executavel pelo browser';
  END IF;
  IF has_function_privilege('anon', v_rpc, 'EXECUTE')
  OR NOT has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS 3: ACL de public.venda_contribuicao fora do desenho (anon nao, authenticated sim)';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_rpc) THEN
    RAISE EXCEPTION 'POS 4: public.venda_contribuicao precisa ser SECURITY DEFINER';
  END IF;
  -- late-bound: EXECUTA o motor numa janela curta (o motor não tem gate de JWT; a porta é que tem).
  PERFORM count(*) FROM private.venda_contribuicao_linhas(
    (now() AT TIME ZONE 'America/Sao_Paulo')::date - 6, (now() AT TIME ZONE 'America/Sao_Paulo')::date);
  RAISE NOTICE 'VENDA_CONTRIBUICAO_OK';
END
$post$;

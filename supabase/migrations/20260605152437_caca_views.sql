-- ============================================================
-- Caça (Frente B) — views da fila de look-alike dos melhores → Hunter
-- Objetivo: entregar os FATOS por (documento × empresa) pro motor de caça
--   que roda no CLIENT (helper TS: perfilPorLift + selecionarMelhores + rankearCaca).
--   A view NÃO calcula índice/percentil/lift — só agrega fatos brutos.
-- Escopo v1 (decisões pós-diagnóstico Fase 0 + Codex design + Codex adversarial):
--   - só clientes COM conta (profiles, não-employee); não-vinculados ficam fora (sem venda rastreável).
--   - empresas-alvo: oben, colacor (colacor_sc não tem venda em sales_orders → fora da v1).
--   - fonte de compra = sales_orders.account (venda_items_history só cobre Oben → descartada).
--   - grão = (documento_normalizado × empresa); CNPJ e CPF (marceneiro/MEI é cliente real).
--   - LGPD: candidatos com opt_out (WhatsApp, por documento OU telefone) são EXCLUÍDOS na fonte.
-- Correções do passe adversário (Codex):
--   P1 order_date_kpi é DATE (COALESCE direto, sem cast de texto); P1 cli_valid (todos os user_ids do documento) alimenta
--   as compras; P1 opt-out por documento + telefone; P1 dedup de order_items.
--   P2 lucro = margem bruta SEM desconto (semântica de order_items.discount incerta).
--   P3 documento por validade (11/14); cidade exige city E state.
-- Follow-ups (v2): item sem product_id (descartado); confirmar semântica do discount;
--   status lista-positiva; materializar/índice parcial se a tela ficar lenta ou multiusuário.
-- NÃO é money-path (inteligência comercial, staff-readable). security_invoker=on.
-- ============================================================

-- ------------------------------------------------------------
-- v_caca_compradores — base + insumo de "melhores" (1 linha por documento×empresa que COMPRA)
--   Fatos brutos por empresa: volume, nº pedidos, recência, lucro-proxy (+cobertura),
--   ticket, famílias, cidade/UF, ramo (cnae). O client deriva o índice ponderado e os melhores.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_caca_compradores
WITH (security_invoker = on) AS
WITH cli AS (
  SELECT
    p.user_id, p.name, p.phone, p.cnae,
    CASE
      WHEN length(regexp_replace(COALESCE(p.document, ''), '\D', '', 'g')) IN (11, 14)
        THEN regexp_replace(COALESCE(p.document, ''), '\D', '', 'g')
      WHEN length(regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g')) IN (11, 14)
        THEN regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g')
      ELSE NULL
    END AS documento
  FROM public.profiles p
  WHERE COALESCE(p.is_employee, false) = false
),
cli_valid AS (  -- 1 linha por user_id com documento VÁLIDO (todos os users entram → não perde compras)
  SELECT DISTINCT ON (user_id) user_id, documento, name, phone, cnae
  FROM cli
  WHERE documento IS NOT NULL
  ORDER BY user_id, documento
),
cli_doc AS (  -- representante por documento (display: nome/telefone/cnae/user_id)
  SELECT DISTINCT ON (documento) documento, user_id, name, phone, cnae
  FROM cli_valid
  ORDER BY documento, user_id
),
so_ok AS (  -- pedidos válidos, datados por order_date_kpi (date) com fallback created_at
  SELECT
    so.id, so.account, so.total,
    COALESCE(so.order_date_kpi, so.created_at::date) AS dt,
    cv.documento
  FROM public.sales_orders so
  JOIN cli_valid cv ON cv.user_id = so.customer_user_id
  WHERE so.deleted_at IS NULL
    AND so.status NOT IN ('cancelado', 'rascunho')
    AND so.account IN ('oben', 'colacor')
),
compras AS (
  SELECT documento, account,
         count(*)   AS n_pedidos,
         sum(total) AS volume,
         max(dt)    AS ultima
  FROM so_ok
  GROUP BY documento, account
),
oi_dedup AS (  -- 1 item por (pedido, SKU) → evita inflar lucro/receita por duplicata de resync
  SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto)
         oi.sales_order_id, oi.product_id, oi.quantity, oi.unit_price
  FROM public.order_items oi
  ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
),
itens AS (  -- itens dos pedidos válidos, com família e custo (cmc) do produto na MESMA account
  SELECT s.documento, s.account, d.quantity, d.unit_price, op.familia, pc.cmc
  FROM so_ok s
  JOIN oi_dedup d ON d.sales_order_id = s.id
  JOIN public.omie_products op ON op.id = d.product_id AND op.account = s.account
  LEFT JOIN public.product_costs pc ON pc.product_id = op.id
),
fam AS (
  SELECT documento, account,
         array_agg(DISTINCT familia) FILTER (WHERE familia IS NOT NULL AND familia <> '') AS familias
  FROM itens
  GROUP BY documento, account
),
luc AS (  -- lucro = margem bruta (receita s/ desconto − custo) só dos itens com cmc>0; ausente NÃO vira zero
  SELECT documento, account,
         sum((quantity * unit_price) - (quantity * cmc)) FILTER (WHERE cmc > 0) AS lucro_com_custo,
         sum(quantity * unit_price)                       AS receita,
         sum(quantity * unit_price) FILTER (WHERE cmc > 0) AS receita_com_custo
  FROM itens
  GROUP BY documento, account
),
cid AS (  -- 1 cidade/UF por usuário: exige city E state (anti-homônimo); prefere default, depois recente
  SELECT DISTINCT ON (user_id) user_id, (city || '-' || state) AS cidade_uf
  FROM public.addresses
  WHERE COALESCE(city, '') <> '' AND COALESCE(state, '') <> ''
  ORDER BY user_id, is_default DESC NULLS LAST, created_at DESC NULLS LAST
)
SELECT
  c.documento,
  c.account AS empresa,
  cid.cidade_uf,
  cd.cnae AS ramo,
  CASE WHEN c.n_pedidos > 0 THEN round(c.volume / c.n_pedidos, 2) END AS ticket_faixa,
  COALESCE(f.familias, ARRAY[]::text[]) AS familias,
  c.volume,
  c.n_pedidos,
  (now()::date - c.ultima) AS recencia_dias,
  CASE WHEN l.lucro_com_custo IS NOT NULL THEN round(l.lucro_com_custo, 2) END AS lucro_proxy,
  CASE WHEN COALESCE(l.receita, 0) > 0 THEN round(COALESCE(l.receita_com_custo, 0) / l.receita, 2) ELSE 0 END AS lucro_cobertura
FROM compras c
JOIN cli_doc cd ON cd.documento = c.documento
LEFT JOIN fam f ON f.documento = c.documento AND f.account = c.account
LEFT JOIN luc l ON l.documento = c.documento AND l.account = c.account
LEFT JOIN cid    ON cid.user_id = cd.user_id;

-- ------------------------------------------------------------
-- v_caca_candidatos — alvos da caça (1 linha por documento×empresa-alvo NÃO-ativo na alvo)
--   "ativo na empresa" = tem compra válida nos últimos 6 meses naquela account.
--   Features vêm do GRUPO (todas as empresas) — é o sinal de look-alike do cliente.
--   Sabor (cross/dormente/frio) é derivado no CLIENT pelo helper a partir destas flags.
--   opt_out (WhatsApp, por documento OU telefone) é EXCLUÍDO aqui (LGPD na fonte).
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.v_caca_candidatos
WITH (security_invoker = on) AS
WITH cli AS (
  SELECT
    p.user_id, p.name, p.phone, p.cnae,
    CASE
      WHEN length(regexp_replace(COALESCE(p.document, ''), '\D', '', 'g')) IN (11, 14)
        THEN regexp_replace(COALESCE(p.document, ''), '\D', '', 'g')
      WHEN length(regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g')) IN (11, 14)
        THEN regexp_replace(COALESCE(p.cnpj, ''), '\D', '', 'g')
      ELSE NULL
    END AS documento
  FROM public.profiles p
  WHERE COALESCE(p.is_employee, false) = false
),
cli_valid AS (
  SELECT DISTINCT ON (user_id) user_id, documento, name, phone, cnae
  FROM cli
  WHERE documento IS NOT NULL
  ORDER BY user_id, documento
),
cli_doc AS (
  SELECT DISTINCT ON (documento) documento, user_id, name, phone, cnae
  FROM cli_valid
  ORDER BY documento, user_id
),
so_ok AS (
  SELECT
    so.id, so.account, so.total,
    COALESCE(so.order_date_kpi, so.created_at::date) AS dt,
    cv.documento
  FROM public.sales_orders so
  JOIN cli_valid cv ON cv.user_id = so.customer_user_id
  WHERE so.deleted_at IS NULL
    AND so.status NOT IN ('cancelado', 'rascunho')
    AND so.account IN ('oben', 'colacor')
),
ativ AS (  -- atividade por (documento, account): comprou nos últimos 6 meses?
  SELECT documento, account, (max(dt) >= (now() - interval '6 months')::date) AS ativo_6m
  FROM so_ok
  GROUP BY documento, account
),
grupo AS (  -- features agregadas do GRUPO por documento
  SELECT documento,
         max(dt)    AS ultima_grupo,
         sum(total) AS volume_grupo,
         count(*)   AS pedidos_grupo
  FROM so_ok
  GROUP BY documento
),
oi_dedup AS (
  SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto)
         oi.sales_order_id, oi.product_id
  FROM public.order_items oi
  ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
),
fam_grupo AS (
  SELECT s.documento,
         array_agg(DISTINCT op.familia) FILTER (WHERE op.familia IS NOT NULL AND op.familia <> '') AS familias
  FROM so_ok s
  JOIN oi_dedup d ON d.sales_order_id = s.id
  JOIN public.omie_products op ON op.id = d.product_id AND op.account = s.account
  GROUP BY s.documento
),
cid AS (
  SELECT DISTINCT ON (user_id) user_id, (city || '-' || state) AS cidade_uf
  FROM public.addresses
  WHERE COALESCE(city, '') <> '' AND COALESCE(state, '') <> ''
  ORDER BY user_id, is_default DESC NULLS LAST, created_at DESC NULLS LAST
),
optout_doc AS (  -- opt-out por documento (qualquer user) OU por telefone normalizado (últimos 11 dígitos)
  SELECT DISTINCT cv.documento
  FROM public.whatsapp_conversations wc
  JOIN cli_valid cv ON cv.user_id = wc.customer_user_id
  WHERE wc.opt_in_status = 'opt_out'
  UNION
  SELECT DISTINCT cv.documento
  FROM public.whatsapp_conversations wc
  JOIN cli_valid cv
    ON right(regexp_replace(COALESCE(cv.phone, ''), '\D', '', 'g'), 11)
     = right(regexp_replace(COALESCE(wc.phone_e164, wc.phone_key, ''), '\D', '', 'g'), 11)
  WHERE wc.opt_in_status = 'opt_out'
    AND length(regexp_replace(COALESCE(cv.phone, ''), '\D', '', 'g')) >= 10
),
alvos AS (SELECT unnest(ARRAY['oben', 'colacor']) AS empresa_alvo),
cand AS (
  SELECT cd.documento, a.empresa_alvo, cd.user_id, cd.name, cd.phone, cd.cnae
  FROM cli_doc cd
  CROSS JOIN alvos a
  WHERE NOT EXISTS (  -- exclui quem JÁ é ativo (comprou <6m) na empresa-alvo
    SELECT 1 FROM ativ av
    WHERE av.documento = cd.documento AND av.account = a.empresa_alvo AND av.ativo_6m
  )
  AND NOT EXISTS (    -- LGPD: exclui opt-out
    SELECT 1 FROM optout_doc oo WHERE oo.documento = cd.documento
  )
)
SELECT
  cand.documento,
  cand.empresa_alvo,
  cid.cidade_uf,
  cand.cnae AS ramo,
  CASE WHEN g.pedidos_grupo > 0 THEN round(g.volume_grupo / g.pedidos_grupo, 2) END AS ticket_faixa,
  COALESCE(fg.familias, ARRAY[]::text[]) AS familias,
  EXISTS (  -- ativo (<6m) em alguma empresa DIFERENTE da alvo → sinal de cross
    SELECT 1 FROM ativ av2
    WHERE av2.documento = cand.documento AND av2.account <> cand.empresa_alvo AND av2.ativo_6m
  ) AS compra_em_outra_empresa,
  CASE WHEN g.ultima_grupo IS NOT NULL THEN (now()::date - g.ultima_grupo) END AS ultima_compra_grupo_dias,
  cand.name      AS nome,
  cand.phone     AS telefone,
  cand.user_id   AS cliente_user_id
FROM cand
LEFT JOIN grupo     g  ON g.documento  = cand.documento
LEFT JOIN fam_grupo fg ON fg.documento = cand.documento
LEFT JOIN cid          ON cid.user_id  = cand.user_id;

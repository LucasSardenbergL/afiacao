-- 20260624010000_caca_custo_efetivo_fallback.sql
-- Corrige o custo efetivo da v_caca_compradores: o cmc do FABRICADO é LEGÍTIMO (custo de produção
-- que o Omie calcula via Ordem de Produção) — provado em prod 2026-06-24: nos fabricados com ambos,
-- cmc ≈ custo_producao recomposto (razão mediana 1,00). A view do #1014 (CASE tipo_produto, seguindo
-- o P1#2 do Codex que supôs "cmc de fabricado é espúrio" SEM dados) descartava esse cmc → cobertura
-- Colacor caiu de 60,1% p/ ~50%. Medição das 3 lógicas (psql-ro):
--   só cmc = 60,1% · só recomposto = ~16% · COALESCE(recomposto, cmc) = 72,0%.
--
-- Custo efetivo = COALESCE(custo_producao quando status='ok', NULLIF(cmc,0)):
--   - fabricado recomposto (status='ok')           → custo_producao (recomposto; bate com o cmc)
--   - fabricado sem recompor mas com cmc legítimo  → cmc (recupera; +OP do Omie)
--   - comprado (custo_producao_status NULL)         → cmc (inalterado)
--   - sem nenhum custo                              → NULL (degrada honesto)
-- MANTÉM o gate de status (P1#1 do Codex): custo_producao só entra quando status='ok' (nunca stale).
-- NÃO precisa de tipo_produto (status='ok' só existe p/ fabricado que a edge recompôs).
-- viewdef preservado (ordem das colunas de saída idêntica — database.md §5).
CREATE OR REPLACE VIEW public.v_caca_compradores AS
 WITH cli AS (
         SELECT p.user_id,
            p.name,
            p.phone,
            p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p
          WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id,
            cli.documento,
            cli.name,
            cli.phone,
            cli.cnae
           FROM cli
          WHERE cli.documento IS NOT NULL
          ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento,
            cli_valid.user_id,
            cli_valid.name,
            cli_valid.phone,
            cli_valid.cnae
           FROM cli_valid
          ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id,
            so.account,
            so.total,
            COALESCE(so.order_date_kpi, so.created_at::date) AS dt,
            cv.documento
           FROM sales_orders so
             JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), compras AS (
         SELECT so_ok.documento,
            so_ok.account,
            count(*) AS n_pedidos,
            sum(so_ok.total) AS volume,
            max(so_ok.dt) AS ultima
           FROM so_ok
          GROUP BY so_ok.documento, so_ok.account
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id,
            oi.product_id,
            oi.quantity,
            oi.unit_price
           FROM order_items oi
          ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), itens AS (
         SELECT s.documento,
            s.account,
            d.quantity,
            d.unit_price,
            op.familia,
            COALESCE(
                CASE WHEN pc.custo_producao_status = 'ok'::text THEN pc.custo_producao ELSE NULL::numeric END,
                NULLIF(pc.cmc, 0::numeric)
            ) AS custo_efetivo
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
             LEFT JOIN product_costs pc ON pc.product_id = op.id
        ), fam AS (
         SELECT itens.documento,
            itens.account,
            array_agg(DISTINCT itens.familia) FILTER (WHERE itens.familia IS NOT NULL AND itens.familia <> ''::text) AS familias
           FROM itens
          GROUP BY itens.documento, itens.account
        ), luc AS (
         SELECT itens.documento,
            itens.account,
            sum(itens.quantity * itens.unit_price - itens.quantity * itens.custo_efetivo) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS lucro_com_custo,
            sum(itens.quantity * itens.unit_price) AS receita,
            sum(itens.quantity * itens.unit_price) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS receita_com_custo
           FROM itens
          GROUP BY itens.documento, itens.account
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id,
            (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses
          WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        )
 SELECT c.documento,
    c.account AS empresa,
    cid.cidade_uf,
    cd.cnae AS ramo,
        CASE
            WHEN c.n_pedidos > 0 THEN round(c.volume / c.n_pedidos::numeric, 2)
            ELSE NULL::numeric
        END AS ticket_faixa,
    COALESCE(f.familias, ARRAY[]::text[]) AS familias,
    c.volume,
    c.n_pedidos,
    now()::date - c.ultima AS recencia_dias,
        CASE
            WHEN l.lucro_com_custo IS NOT NULL THEN round(l.lucro_com_custo, 2)
            ELSE NULL::numeric
        END AS lucro_proxy,
        CASE
            WHEN COALESCE(l.receita, 0::numeric) > 0::numeric THEN round(COALESCE(l.receita_com_custo, 0::numeric) / l.receita, 2)
            ELSE 0::numeric
        END AS lucro_cobertura
   FROM compras c
     JOIN cli_doc cd ON cd.documento = c.documento
     LEFT JOIN fam f ON f.documento = c.documento AND f.account = c.account
     LEFT JOIN luc l ON l.documento = c.documento AND l.account = c.account
     LEFT JOIN cid ON cid.user_id = cd.user_id;

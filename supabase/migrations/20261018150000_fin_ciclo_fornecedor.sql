-- ============================================================
-- Ciclo financeiro — frente 4: PMP por fornecedor e o custo do prazo (desconto de pontualidade).
-- Spec: docs/superpowers/specs/2026-10-18-ciclo-pmp-fornecedor-design.md (§9 = calibração Codex,
-- prevalece). Prova: db/test-fin-ciclo-fornecedor.sh (PG17, controle verde + falsificação, 2 locales).
--
-- Por quê: o founder NÃO quer esticar prazo de fornecedor (prazo maior = preço maior). Quer pagar no
-- ponto da condição que dá o menor preço — a Sayerlack dá 2% de desconto no boleto pago até o
-- vencimento. A aba mostra o PMP de COMPRAS e quanto o prazo custa (desconto obtido, desconto
-- perdido como cenário, juros+multa pagos).
--
-- Medido em prod (psql-ro, 2026-10-18):
--   - fin_contas_pagar.nome_fornecedor/cnpj_cpf vazios em 100%; saldo = valor_documento ATÉ em PAGO;
--     valor_desconto/juros/multa = 0 sempre → a fonte é fin_movimentacoes.resumo_* (ótica CONTA_A_PAGAR).
--   - data_pagamento_omie em 100% dos PAGO de compras com baixa (falta em 3 de 5.125) → só ela decide
--     pontualidade; a liquidação CC (D+1) e titulo_data_movimento (pode ser registro/previsão) não.
--   - 16 títulos de CP com 2+ BAXP (versões de baixa, ex. 12182935508) → dedup idêntico ao do CR.
--   - códigos de categoria variam por empresa (2.01.99 = imobilizado na colacor) → lista explícita.
--
-- Views de FATOS (a regra — taxa, regime, cenário, fila — vive em
-- src/lib/financeiro/ciclo-fornecedor-helpers.ts). Views SEM SELECT para authenticated/anon: só as
-- RPCs (SECURITY DEFINER, gate master) as leem (spec §9 #9).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Por título a pagar: encargo, desconto, data da baixa, fonte e confiança
-- ------------------------------------------------------------
-- Espelho de v_titulo_encargos_cr (20261013094000), com 4 diferenças (spec §4.2 item 1 e §9):
--   a) óticas CP: título CONTA_A_PAGAR; baixa CONTA_CORRENTE_PAG natureza BAXP/APBP, tipo 'S';
--   b) a base cobre TODO título não CANCELADO (abertos e parciais entram); `quitado` exige PAGO/LIQUIDADO;
--   c) evidência bruta separada da decisão: identidade_ok, desconto_informado_omie (só identidade) e
--      desconto_obtido (só confiança de decisão) — a taxa usa a evidência, o R$ apurado usa a decisão;
--   d) valor_aberto_informado: resumo_val_aberto quando a identidade fecha e pago+aberto = título.
CREATE OR REPLACE VIEW public.v_titulo_encargos_cp
WITH (security_invoker = on) AS
WITH cp_linhas AS (
  SELECT m.*
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao = 'CONTA_A_PAGAR'
     AND m.omie_codigo_lancamento IS NOT NULL
),
-- Versão ATUAL do título = a linha CONTA_A_PAGAR observada por último (mesma regra do CR).
cp_atual AS (
  SELECT DISTINCT ON (c.company, c.omie_codigo_lancamento)
         c.company,
         c.omie_codigo_lancamento AS cod,
         c.data_movimento,
         c.data_pagamento_omie,
         c.tipo_documento,
         c.valor_titulo,
         c.resumo_val_pago,
         c.resumo_val_liquido,
         c.resumo_desconto,
         c.resumo_juros,
         c.resumo_multa,
         c.resumo_val_aberto,
         c.resumo_liquidado,
         c.resumo_lido_em
    FROM cp_linhas c
   ORDER BY c.company, c.omie_codigo_lancamento,
            c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST, c.id DESC
),
cp_versoes AS (
  SELECT company, omie_codigo_lancamento AS cod, count(*)::int AS versoes
    FROM cp_linhas
   GROUP BY company, omie_codigo_lancamento
),
-- Baixas em CAIXA (BAXP/APBP). As naturezas de inclusão (COMP/MANP/RPTP/CTEP/DEVP) na CC são sempre
-- 0 e ficam fora; TRAP/EXTP não têm título.
baixa_linhas AS (
  SELECT m.id, m.company, m.omie_codigo_lancamento AS cod, m.omie_ncodcc, m.data_movimento,
         m.valor, m.omie_ncodbaixa, m.updated_at, m.created_at
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao = 'CONTA_CORRENTE_PAG'
     AND m.natureza IN ('BAXP', 'APBP')
     AND m.tipo = 'S'
     AND m.omie_codigo_lancamento IS NOT NULL
),
-- Dedup de VERSÕES da mesma baixa, em 2 camadas (idêntico ao CR):
--  (a) com nCodBaixa a identidade manda — uma linha por (título, nCodBaixa), a observada por último;
--  (b) sem nCodBaixa cede a linha do MESMO conteúdo com nCodBaixa, ou sem ID e mais nova. Linha sem ID
--      nunca elimina linha com ID. Versão velha com OUTRO conteúdo sobra → confiança `divergente`.
baixa_com_id AS (
  SELECT DISTINCT ON (b.company, b.cod, b.omie_ncodbaixa) b.*
    FROM baixa_linhas b
   WHERE b.omie_ncodbaixa IS NOT NULL
   ORDER BY b.company, b.cod, b.omie_ncodbaixa,
            b.updated_at DESC NULLS LAST, b.created_at DESC NULLS LAST, b.id DESC
),
baixa_sem_id AS (
  SELECT b.*
    FROM baixa_linhas b
   WHERE b.omie_ncodbaixa IS NULL
     AND NOT EXISTS (
       SELECT 1
         FROM baixa_linhas n
        WHERE n.company = b.company
          AND n.cod = b.cod
          AND n.omie_ncodcc IS NOT DISTINCT FROM b.omie_ncodcc
          AND n.data_movimento = b.data_movimento
          AND n.valor = b.valor
          AND n.id <> b.id
          AND (n.omie_ncodbaixa IS NOT NULL
               OR (COALESCE(n.updated_at, '-infinity'), COALESCE(n.created_at, '-infinity'), n.id)
                > (COALESCE(b.updated_at, '-infinity'), COALESCE(b.created_at, '-infinity'), b.id))
     )
),
baixa_atual AS (
  SELECT * FROM baixa_com_id
  UNION ALL
  SELECT * FROM baixa_sem_id
),
baixa_titulo AS (
  SELECT company, cod,
         count(*)::int        AS n_baixas,
         sum(valor)           AS soma_baixas,
         max(data_movimento)  AS data_ultima_liquidacao
    FROM baixa_atual
   GROUP BY company, cod
),
base AS (
  SELECT t.company,
         t.omie_codigo_lancamento,
         t.omie_codigo_cliente_fornecedor,
         coalesce(nullif(btrim(t.numero_documento_fiscal), ''), nullif(btrim(t.numero_documento), ''))
                                                            AS numero_documento,
         t.data_emissao,
         t.data_vencimento,
         t.valor_documento,
         t.status_titulo,
         ca.tipo_documento,
         cv.versoes                                         AS versoes_titulo,
         bt.n_baixas,
         bt.soma_baixas,
         -- Mesma cascata do CR, com a fonte exposta: a PONTUALIDADE só aceita omie_data_pagamento
         -- (spec §9 #4) — a decisão fica nas views de cima, que leem fonte_data_baixa.
         COALESCE(ca.data_pagamento_omie, ca.data_movimento, bt.data_ultima_liquidacao)
                                                            AS data_baixa,
         CASE WHEN ca.data_pagamento_omie    IS NOT NULL THEN 'omie_data_pagamento'
              WHEN ca.data_movimento         IS NOT NULL THEN 'titulo_data_movimento'
              WHEN bt.data_ultima_liquidacao IS NOT NULL THEN 'conta_corrente_liquidacao'
         END                                                AS fonte_data_baixa,
         ca.valor_titulo,
         ca.resumo_val_pago,
         ca.resumo_val_liquido,
         ca.resumo_desconto,
         ca.resumo_juros,
         ca.resumo_multa,
         ca.resumo_val_aberto,
         ca.resumo_liquidado,
         ca.resumo_lido_em,
         (ca.resumo_val_pago IS NOT NULL AND ca.resumo_val_liquido IS NOT NULL
          AND ca.resumo_desconto IS NOT NULL AND ca.resumo_juros IS NOT NULL
          AND ca.resumo_multa IS NOT NULL)                  AS resumo_completo
    FROM public.fin_contas_pagar t
    LEFT JOIN cp_atual     ca ON ca.company = t.company AND ca.cod = t.omie_codigo_lancamento
    LEFT JOIN cp_versoes   cv ON cv.company = t.company AND cv.cod = t.omie_codigo_lancamento
    LEFT JOIN baixa_titulo bt ON bt.company = t.company AND bt.cod = t.omie_codigo_lancamento
   WHERE t.omie_codigo_lancamento IS NOT NULL
     AND t.status_titulo IS DISTINCT FROM 'CANCELADO'
),
avaliado AS (
  SELECT b.*,
         -- Componente negativo = inconsistente (achado Codex do CR: a aritmética sozinha não valida).
         COALESCE(b.resumo_completo
           AND b.resumo_val_pago >= 0 AND b.resumo_val_liquido >= 0 AND b.resumo_desconto >= 0
           AND b.resumo_juros >= 0 AND b.resumo_multa >= 0
           AND abs(b.resumo_val_liquido
                   - (b.resumo_val_pago - b.resumo_desconto + b.resumo_juros + b.resumo_multa)) <= 0.01,
           false)                                           AS identidade_ok,
         COALESCE(b.status_titulo IN ('PAGO', 'LIQUIDADO')
           AND b.resumo_liquidado IS TRUE
           AND b.resumo_val_aberto = 0
           AND abs(b.resumo_val_pago - b.valor_documento) <= 0.01
           AND (b.valor_titulo IS NULL
                OR abs(b.resumo_val_pago + b.resumo_val_aberto - b.valor_titulo) <= 0.01),
           false)                                           AS quitado,
         (b.soma_baixas IS NOT NULL AND b.resumo_val_liquido IS NOT NULL
          AND abs(b.soma_baixas - b.resumo_val_liquido) <= 0.01)
                                                            AS caixa_bate
    FROM base b
),
classificado AS (
  SELECT a.*,
         CASE WHEN a.resumo_completo AND NOT a.identidade_ok             THEN 'inconsistente'
              WHEN a.identidade_ok AND a.soma_baixas IS NOT NULL
                   AND NOT a.caixa_bate                                  THEN 'divergente'
              WHEN a.identidade_ok AND a.soma_baixas IS NULL             THEN 'erp_sem_caixa'
              WHEN a.identidade_ok AND a.quitado                         THEN 'alta'
              WHEN a.identidade_ok                                       THEN 'erp_nao_quitado'
              WHEN a.soma_baixas IS NOT NULL                             THEN 'so_diferenca_caixa'
              ELSE 'sem_dado'
         END AS confianca
    FROM avaliado a
)
SELECT c.company,
       c.omie_codigo_lancamento,
       c.omie_codigo_cliente_fornecedor,
       c.numero_documento,
       c.data_emissao,
       c.data_vencimento,
       c.valor_documento,
       c.status_titulo,
       c.tipo_documento,
       c.versoes_titulo,
       c.n_baixas,
       c.soma_baixas,
       c.data_baixa,
       c.fonte_data_baixa,
       (c.data_baixa - c.data_vencimento)                   AS dias_atraso,
       c.identidade_ok,
       CASE WHEN c.identidade_ok THEN c.resumo_val_pago    END AS valor_pago_principal,
       CASE WHEN c.identidade_ok THEN c.resumo_val_liquido END AS valor_liquido_pago,
       -- EVIDÊNCIA (taxa observada): o que o Omie informou, com a identidade interna fechando — inclui
       -- `divergente` (versão velha de baixa não apaga a evidência da condição; spec §8/§9 #3).
       CASE WHEN c.identidade_ok THEN c.resumo_desconto    END AS desconto_informado_omie,
       CASE WHEN c.identidade_ok
             AND (c.valor_titulo IS NULL
                  OR abs(c.resumo_val_pago + c.resumo_val_aberto - c.valor_titulo) <= 0.01)
            THEN c.resumo_val_aberto END                    AS valor_aberto_informado,
       -- DECISÃO (R$ apurado): só quando nenhuma outra evidência contradiz.
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado')
            THEN c.resumo_juros + c.resumo_multa END        AS encargo_pago,
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado')
            THEN c.resumo_desconto END                       AS desconto_obtido,
       (c.soma_baixas - c.valor_documento)                  AS diferenca_caixa_documento,
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado') THEN 'omie_resumo'
            WHEN c.confianca = 'so_diferenca_caixa'                          THEN 'diferenca_caixa'
       END                                                  AS fonte,
       c.confianca,
       c.resumo_lido_em
  FROM classificado c;

COMMENT ON VIEW public.v_titulo_encargos_cp IS
  'Por título a pagar não cancelado: encargo pago (juros+multa) e desconto obtido do resumo do Omie, com '
  'evidência (desconto_informado_omie, identidade_ok) separada da decisão (desconto_obtido/encargo_pago), '
  'data e fonte da baixa e confiança. NULL = ausente, nunca 0. Espelho CP do v_titulo_encargos_cr.';

REVOKE ALL ON public.v_titulo_encargos_cp FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_titulo_encargos_cp TO service_role;

-- ------------------------------------------------------------
-- 2. Compras: universo, fatos por título e por fornecedor
-- ------------------------------------------------------------
-- Universo (decisão do founder, 2026-10-18): mercadoria p/ revenda, matéria-prima, frete e serviço de
-- compra. Fora: imposto, empréstimo, folha, imobilizado, uso e consumo. Lista (empresa, código)
-- EXPLÍCITA — o mesmo código muda de significado entre empresas (fin_categorias, medido 2026-10-18).
CREATE OR REPLACE VIEW public.v_ciclo_cp_compras_categorias
WITH (security_invoker = on) AS
SELECT company, categoria_codigo
  FROM (VALUES
    ('colacor',    '2.01.01'), ('colacor',    '2.01.02'), ('colacor',    '2.01.03'),
    ('colacor',    '2.01.04'), ('colacor',    '2.01.97'),
    ('colacor_sc', '2.01.01'), ('colacor_sc', '2.01.02'), ('colacor_sc', '2.01.03'), ('colacor_sc', '2.01.04'),
    ('oben',       '2.01.01'), ('oben',       '2.01.02'), ('oben',       '2.01.03'), ('oben',       '2.01.04')
  ) AS l(company, categoria_codigo);

-- Por parcela de compra (espelho do v_ciclo_cr_titulos). Situações:
--   paga           : PAGO/LIQUIDADO com baixa (BAXP ou dDtPagamento), vencimento em [hoje_sp−365, hoje_sp);
--   paga_sem_baixa : PAGO/LIQUIDADO na janela sem baixa nenhuma — só cobertura;
--   paga_parcial   : aberto (ATRASADO/A VENCER/VENCE HOJE) com baixa ou principal pago > 0, qualquer idade —
--                    o remanescente é vencido ou a vencer pelo VENCIMENTO;
--   vencida_aberta : aberto sem baixa e (ATRASADO, ou vencimento < hoje_sp = lag de sync);
--   a_vencer       : aberto sem baixa com vencimento ≥ hoje_sp;
--   status_ambiguo : status fora do vocabulário Omie do CP — só contado.
-- Pontualidade e prazo real SÓ com data da baixa = dDtPagamento (spec §9 #4/#6); NÃO usa v_titulo_baixas.
-- Prazo concedido pode ser NEGATIVO (lançado depois de pago/adiantamento): entra e é contado.
CREATE OR REPLACE VIEW public.v_ciclo_cp_titulos
WITH (security_invoker = on) AS
WITH base AS (
  SELECT e.company, e.omie_codigo_cliente_fornecedor AS omie_codigo_fornecedor, e.omie_codigo_lancamento,
         e.numero_documento, p.categoria_codigo, e.data_emissao, e.data_vencimento,
         e.data_baixa, e.fonte_data_baixa, e.valor_documento, e.status_titulo,
         -- coalesce: sem baixa e sem fonte de data, `false OR NULL` = NULL apagaria o PAGO (nem paga, nem paga_sem_baixa).
         coalesce(e.n_baixas, 0) > 0 OR coalesce(e.fonte_data_baixa = 'omie_data_pagamento', false) AS tem_baixa,
         e.valor_aberto_informado, e.valor_pago_principal, e.desconto_obtido, e.desconto_informado_omie,
         e.encargo_pago, e.confianca AS confianca_encargo,
         coalesce(e.fonte_data_baixa = 'omie_data_pagamento', false) AS data_baixa_confiavel,
         (now() AT TIME ZONE 'America/Sao_Paulo')::date AS hoje_sp
    FROM public.v_titulo_encargos_cp e
    JOIN public.fin_contas_pagar p
      ON p.company = e.company AND p.omie_codigo_lancamento = e.omie_codigo_lancamento
    JOIN public.v_ciclo_cp_compras_categorias l
      ON l.company = p.company AND l.categoria_codigo = p.categoria_codigo
   WHERE e.valor_documento IS NOT NULL AND e.valor_documento <> 'NaN'
     AND e.valor_documento < 'Infinity' AND e.valor_documento > 0
     AND e.data_emissao IS NOT NULL AND e.data_vencimento IS NOT NULL
     AND e.omie_codigo_cliente_fornecedor IS NOT NULL
), classif AS (
  SELECT base.*,
    CASE
      WHEN status_titulo IS NULL
        OR status_titulo NOT IN ('PAGO','LIQUIDADO','A VENCER','VENCE HOJE','ATRASADO') THEN 'status_ambiguo'
      WHEN status_titulo IN ('PAGO','LIQUIDADO') AND tem_baixa
        AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga'
      WHEN status_titulo IN ('PAGO','LIQUIDADO') AND NOT tem_baixa
        AND data_vencimento >= hoje_sp - 365 AND data_vencimento < hoje_sp THEN 'paga_sem_baixa'
      WHEN status_titulo IN ('PAGO','LIQUIDADO') THEN NULL  -- fora da janela de 12m
      WHEN tem_baixa OR coalesce(valor_pago_principal, 0) > 0 THEN 'paga_parcial'
      WHEN status_titulo = 'ATRASADO' OR data_vencimento < hoje_sp THEN 'vencida_aberta'
      ELSE 'a_vencer'
    END AS situacao
  FROM base
)
SELECT company, omie_codigo_fornecedor, omie_codigo_lancamento, numero_documento, categoria_codigo,
       data_emissao, data_vencimento,
       CASE WHEN situacao IN ('paga','paga_parcial') THEN data_baixa END AS data_baixa,
       fonte_data_baixa,
       (situacao = 'paga' AND data_baixa_confiavel) AS data_baixa_confiavel,
       valor_documento,
       CASE WHEN situacao IN ('paga_parcial','vencida_aberta','a_vencer')
            THEN coalesce(valor_aberto_informado, valor_documento) END AS valor_aberto,
       CASE WHEN situacao IN ('paga_parcial','vencida_aberta','a_vencer')
            THEN CASE WHEN valor_aberto_informado IS NOT NULL THEN 'omie_resumo' ELSE 'valor_titulo' END
       END AS fonte_valor_aberto,
       situacao,
       (data_vencimento - data_emissao) AS prazo_concedido_dias,
       CASE WHEN situacao = 'paga' AND data_baixa_confiavel THEN data_baixa - data_emissao END AS prazo_real_dias,
       CASE WHEN situacao = 'paga' AND data_baixa_confiavel THEN data_baixa - data_vencimento END AS dias_atraso_baixa,
       CASE WHEN situacao = 'paga' THEN desconto_obtido END          AS desconto_obtido,
       CASE WHEN situacao = 'paga' THEN desconto_informado_omie END  AS desconto_informado_omie,
       CASE WHEN situacao = 'paga' THEN valor_pago_principal END     AS valor_pago_principal,
       CASE WHEN situacao = 'paga' THEN encargo_pago END             AS encargo_pago,
       confianca_encargo,
       CASE WHEN situacao IN ('vencida_aberta','paga_parcial') AND data_vencimento < hoje_sp
            THEN hoje_sp - data_vencimento END AS dias_vencido
  FROM classif
 WHERE situacao IS NOT NULL;

-- Por (empresa, fornecedor). Somas de R$ ignoram NULL → são SUBTOTAIS: a cobertura
-- (valor_pago_conf_decisao / valor_pago) vai junto e a UI nunca apresenta o subtotal como total.
CREATE OR REPLACE VIEW public.v_ciclo_fornecedor_resumo
WITH (security_invoker = on) AS
WITH t AS (SELECT * FROM public.v_ciclo_cp_titulos),
hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
pagas AS (
  SELECT company, omie_codigo_fornecedor,
         count(DISTINCT coalesce('d:' || numero_documento, 'l:' || omie_codigo_lancamento::text))::int AS n_documentos_pagos,
         sum(valor_documento) AS valor_pago,
         sum(valor_documento * prazo_concedido_dias) / sum(valor_documento) AS prazo_concedido_pond,
         sum(valor_documento * prazo_real_dias) FILTER (WHERE data_baixa_confiavel)
           / nullif(sum(valor_documento) FILTER (WHERE data_baixa_confiavel), 0) AS prazo_real_pond,
         sum(valor_documento * dias_atraso_baixa) FILTER (WHERE data_baixa_confiavel)
           / nullif(sum(valor_documento) FILTER (WHERE data_baixa_confiavel), 0) AS atraso_pond_sinal,
         sum(valor_documento * greatest(dias_atraso_baixa, 0)) FILTER (WHERE data_baixa_confiavel)
           / nullif(sum(valor_documento) FILTER (WHERE data_baixa_confiavel), 0) AS atraso_pond_pos,
         count(*) FILTER (WHERE prazo_concedido_dias < 0)::int AS n_prazo_negativo,
         coalesce(sum(valor_documento) FILTER (WHERE data_baixa_confiavel AND dias_atraso_baixa <= 0), 0) AS valor_pago_em_dia,
         coalesce(sum(valor_documento) FILTER (WHERE data_baixa_confiavel AND dias_atraso_baixa > 0), 0) AS valor_pago_atrasado,
         coalesce(sum(valor_documento) FILTER (WHERE NOT data_baixa_confiavel), 0) AS valor_pago_data_incerta,
         coalesce(sum(valor_documento) FILTER (WHERE confianca_encargo IN ('alta','erp_sem_caixa','erp_nao_quitado')), 0)
           AS valor_pago_conf_decisao,
         sum(desconto_obtido) AS desconto_obtido_12m,
         sum(encargo_pago) AS encargo_pago_12m,
         count(*) FILTER (WHERE desconto_informado_omie > 0)::int AS n_titulos_com_desconto
    FROM t WHERE situacao = 'paga'
   GROUP BY 1, 2
),
abertos AS (
  SELECT t.company, t.omie_codigo_fornecedor,
         coalesce(sum(t.valor_aberto) FILTER (WHERE t.data_vencimento <  hoje.h), 0) AS valor_vencido_aberto,
         count(*) FILTER (WHERE t.data_vencimento < hoje.h)::int AS n_vencidas,
         max(t.dias_vencido) AS dias_vencido_max,
         coalesce(sum(t.valor_aberto) FILTER (WHERE t.data_vencimento >= hoje.h), 0) AS valor_a_vencer
    FROM t, hoje
   WHERE t.situacao IN ('vencida_aberta', 'paga_parcial', 'a_vencer')
   GROUP BY 1, 2
),
ambiguos AS (
  SELECT company, omie_codigo_fornecedor, count(*)::int AS n_status_ambiguo
    FROM t WHERE situacao = 'status_ambiguo' GROUP BY 1, 2
),
volume AS ( -- competência por EMISSÃO, mesma base válida e mesmo universo do v_ciclo_cp_titulos
  SELECT p.company, p.omie_codigo_cliente_fornecedor AS omie_codigo_fornecedor,
         sum(p.valor_documento) AS compras_12m, count(*)::int AS n_titulos_12m
    FROM public.fin_contas_pagar p
    JOIN public.v_ciclo_cp_compras_categorias l
      ON l.company = p.company AND l.categoria_codigo = p.categoria_codigo, hoje
   WHERE p.status_titulo IS DISTINCT FROM 'CANCELADO'
     AND p.valor_documento IS NOT NULL AND p.valor_documento <> 'NaN'
     AND p.valor_documento < 'Infinity' AND p.valor_documento > 0
     AND p.data_emissao IS NOT NULL AND p.data_vencimento IS NOT NULL
     AND p.omie_codigo_cliente_fornecedor IS NOT NULL
     AND p.data_emissao >= hoje.h - 365 AND p.data_emissao < hoje.h
   GROUP BY 1, 2
),
chaves AS (
  SELECT company, omie_codigo_fornecedor FROM pagas
  UNION SELECT company, omie_codigo_fornecedor FROM abertos
  UNION SELECT company, omie_codigo_fornecedor FROM ambiguos
  UNION SELECT company, omie_codigo_fornecedor FROM volume
),
-- Nome: UMA linha por (empresa, fornecedor) por fonte, agregada ANTES do join (10 pedidos não
-- multiplicam compras — spec §9 #8). Cascata: pedido de compra → cadastro Omie → cache → NULL.
po AS (
  SELECT lower(empresa::text) AS company, fornecedor_codigo_omie AS omie_codigo_fornecedor,
         max(nullif(btrim(fornecedor_nome), '')) AS nome
    FROM public.purchase_orders_tracking GROUP BY 1, 2
),
nv AS (
  SELECT empresa AS company, omie_codigo_cliente AS omie_codigo_fornecedor,
         max(coalesce(nullif(btrim(nome_fantasia), ''), nullif(btrim(razao_social), ''))) AS nome
    FROM public.omie_clientes_nao_vinculados GROUP BY 1, 2
),
fc AS (
  SELECT empresa AS company, omie_codigo_cliente_fornecedor AS omie_codigo_fornecedor,
         max(nullif(btrim(razao_social_omie), '')) AS nome
    FROM public.fornecedor_omie_cache GROUP BY 1, 2
),
nomes AS (
  SELECT k.company, k.omie_codigo_fornecedor,
         coalesce(po.nome, nv.nome, fc.nome) AS nome_fornecedor,
         CASE WHEN po.nome IS NOT NULL THEN 'pedido_compra'
              WHEN nv.nome IS NOT NULL THEN 'cadastro_omie'
              WHEN fc.nome IS NOT NULL THEN 'cache_fornecedor' END AS fonte_nome
    FROM chaves k
    LEFT JOIN po USING (company, omie_codigo_fornecedor)
    LEFT JOIN nv USING (company, omie_codigo_fornecedor)
    LEFT JOIN fc USING (company, omie_codigo_fornecedor)
)
SELECT k.company, k.omie_codigo_fornecedor, n.nome_fornecedor, n.fonte_nome,
       vol.compras_12m, vol.n_titulos_12m,
       p.n_documentos_pagos, p.valor_pago, p.prazo_concedido_pond, p.prazo_real_pond,
       p.atraso_pond_sinal, p.atraso_pond_pos, p.n_prazo_negativo,
       p.valor_pago_em_dia, p.valor_pago_atrasado, p.valor_pago_data_incerta, p.valor_pago_conf_decisao,
       p.desconto_obtido_12m, p.encargo_pago_12m, p.n_titulos_com_desconto,
       -- Sem título aberto/ambíguo = zero real (a chave existe por compra ou paga), não dado ausente.
       coalesce(a.valor_vencido_aberto, 0) AS valor_vencido_aberto, coalesce(a.n_vencidas, 0) AS n_vencidas,
       a.dias_vencido_max, coalesce(a.valor_a_vencer, 0) AS valor_a_vencer,
       coalesce(amb.n_status_ambiguo, 0) AS n_status_ambiguo
  FROM chaves k
  LEFT JOIN nomes n    USING (company, omie_codigo_fornecedor)
  LEFT JOIN pagas p    USING (company, omie_codigo_fornecedor)
  LEFT JOIN abertos a  USING (company, omie_codigo_fornecedor)
  LEFT JOIN ambiguos amb USING (company, omie_codigo_fornecedor)
  LEFT JOIN volume vol USING (company, omie_codigo_fornecedor);

REVOKE ALL ON public.v_ciclo_cp_compras_categorias, public.v_ciclo_cp_titulos, public.v_ciclo_fornecedor_resumo
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_ciclo_cp_compras_categorias, public.v_ciclo_cp_titulos, public.v_ciclo_fornecedor_resumo
  TO service_role;

-- ------------------------------------------------------------
-- 3. RPCs com gate na fronteira (padrão 20261015003200)
-- ------------------------------------------------------------
-- gate 1 — só master (_fin_ciclo_gate_master, já em prod; REUSADO, não recriado);
-- gate 2 — fin_user_can_access(company) sobre as linhas JÁ agregadas.
CREATE OR REPLACE FUNCTION public.fin_ciclo_cp_titulos()
RETURNS SETOF public.v_ciclo_cp_titulos
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_cp_titulos v
    WHERE public.fin_user_can_access(v.company);
END
$$;

CREATE OR REPLACE FUNCTION public.fin_ciclo_fornecedor_resumo()
RETURNS SETOF public.v_ciclo_fornecedor_resumo
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
    SELECT v.* FROM public.v_ciclo_fornecedor_resumo v
    WHERE public.fin_user_can_access(v.company);
END
$$;

-- Uma linha por empresa: PMP de compras (prazo real dDtPagamento − emissão, ponderado por valor do
-- documento, só data confiável), compras 12m por emissão e R$/dia; o CONTROLE do engine (fórmula do
-- v_capital_giro_prazos: v_titulo_baixas CP inteiro, sem janela, peso valor_baixado) para a ponte
-- engine → compras; e o sensor de deriva do universo (2.01.* fora da lista e sem categoria, mesma
-- janela de emissão das compras).
CREATE OR REPLACE FUNCTION public.fin_ciclo_cp_empresa()
RETURNS TABLE(company text, pmp_compras_pond numeric, compras_12m numeric, rs_por_dia numeric,
              pmp_engine_controle numeric, n_fora_lista int, valor_fora_lista numeric,
              n_sem_categoria int, valor_sem_categoria numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._fin_ciclo_gate_master();
  RETURN QUERY
  WITH hoje AS (SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date AS h),
  empresas AS (
    SELECT DISTINCT p.company FROM public.fin_contas_pagar p
    UNION SELECT DISTINCT b.company FROM public.v_titulo_baixas b WHERE b.tipo = 'CP'
  ),
  pmp AS (
    SELECT t.company,
           sum(t.valor_documento * t.prazo_real_dias) / nullif(sum(t.valor_documento), 0) AS pmp_compras_pond
      FROM public.v_ciclo_cp_titulos t
     WHERE t.situacao = 'paga' AND t.data_baixa_confiavel
     GROUP BY t.company
  ),
  vol AS (
    SELECT r.company, sum(r.compras_12m) AS compras_12m
      FROM public.v_ciclo_fornecedor_resumo r GROUP BY r.company
  ),
  eng AS (
    SELECT b.company,
           round(sum(b.prazo_ponderado_dias * b.valor_baixado) / nullif(sum(b.valor_baixado), 0)) AS pmp_engine_controle
      FROM public.v_titulo_baixas b
     WHERE b.tipo = 'CP' AND b.prazo_ponderado_dias IS NOT NULL
     GROUP BY b.company
  ),
  sensor AS (
    SELECT p.company,
           count(*) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL)::int AS n_fora_lista,
           -- Título com valor NULL no conjunto → soma desconhecida (NULL), nunca R$ 0; conjunto vazio → 0.
           CASE WHEN bool_or(p.valor_documento IS NULL) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL) THEN NULL
                ELSE coalesce(sum(p.valor_documento) FILTER (WHERE p.categoria_codigo LIKE '2.01.%' AND l.categoria_codigo IS NULL), 0) END AS valor_fora_lista,
           count(*) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL)::int AS n_sem_categoria,
           CASE WHEN bool_or(p.valor_documento IS NULL) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL) THEN NULL
                ELSE coalesce(sum(p.valor_documento) FILTER (WHERE nullif(btrim(p.categoria_codigo), '') IS NULL), 0) END AS valor_sem_categoria
      FROM public.fin_contas_pagar p
      LEFT JOIN public.v_ciclo_cp_compras_categorias l
        ON l.company = p.company AND l.categoria_codigo = p.categoria_codigo
      CROSS JOIN hoje
     WHERE p.status_titulo IS DISTINCT FROM 'CANCELADO'
       AND p.data_emissao >= hoje.h - 365 AND p.data_emissao < hoje.h
     GROUP BY p.company
  )
  SELECT e.company, pmp.pmp_compras_pond, vol.compras_12m,
         CASE WHEN vol.compras_12m > 0 THEN vol.compras_12m / 365 END,
         eng.pmp_engine_controle,
         -- sem linha no sensor = nenhum título em 12 m → 0 legítimo; com linha, o NULL do sensor é preservado.
         coalesce(s.n_fora_lista, 0), CASE WHEN s.company IS NULL THEN 0 ELSE s.valor_fora_lista END,
         coalesce(s.n_sem_categoria, 0), CASE WHEN s.company IS NULL THEN 0 ELSE s.valor_sem_categoria END
    FROM empresas e
    LEFT JOIN pmp    ON pmp.company = e.company
    LEFT JOIN vol    ON vol.company = e.company
    LEFT JOIN eng    ON eng.company = e.company
    LEFT JOIN sensor s ON s.company = e.company
   WHERE public.fin_user_can_access(e.company);
END
$$;

-- ACL: a 1ª criação herda EXECUTE de PUBLIC → fechar as DUAS pontas (PUBLIC e anon).
REVOKE ALL ON FUNCTION public.fin_ciclo_cp_titulos() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_ciclo_fornecedor_resumo() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_ciclo_cp_empresa() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_cp_titulos() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_fornecedor_resumo() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_ciclo_cp_empresa() TO authenticated, service_role;

-- ------------------------------------------------------------
-- 4. Postcondição embutida
-- ------------------------------------------------------------
DO $post$
DECLARE v text; f text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_titulo_encargos_cp','v_ciclo_cp_compras_categorias','v_ciclo_cp_titulos',
                           'v_ciclo_fornecedor_resumo'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relname = v AND c.relkind = 'v'
                     AND 'security_invoker=on' = ANY(coalesce(c.reloptions, '{}'))) THEN
      RAISE EXCEPTION 'postcondicao: view % sem security_invoker', v;
    END IF;
    IF has_table_privilege('anon', 'public.' || v, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || v, 'SELECT') THEN
      RAISE EXCEPTION 'postcondicao: leitura direta de % aberta', v;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.fin_ciclo_cp_titulos()', 'public.fin_ciclo_fornecedor_resumo()',
                           'public.fin_ciclo_cp_empresa()'] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f::regprocedure) THEN
      RAISE EXCEPTION 'postcondicao: % sem SECURITY DEFINER', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: anon executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._fin_ciclo_gate_master()', 'EXECUTE') THEN
    RAISE EXCEPTION 'postcondicao: gate interno exposto';
  END IF;
  RAISE NOTICE 'CICLO-FORNECEDOR-OK';
END
$post$;

COMMIT;

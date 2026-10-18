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

COMMIT;

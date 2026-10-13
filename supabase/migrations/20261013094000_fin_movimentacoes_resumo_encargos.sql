-- ============================================================
-- fin_movimentacoes ganha o RESUMO do Omie em colunas tipadas + view de encargos por título
--
-- POR QUÊ: o grupo cobra 2% de multa + 10% a.m. de juros nos boletos das 3 empresas e não há como
-- medir quanto disso entra. `fin_contas_receber.valor_juros/multa/desconto` são 0 nos ~45k títulos
-- (o ListarContasReceber não traz), e o `resumo` do ListarMovimentos — onde o Omie põe nValPago,
-- nValLiquido, nDesconto, nJuros, nMulta — era lido pela edge e descartado ("peso morto").
--
-- O QUE FOI MEDIDO EM PROD (psql-ro, 2026-10-13) e decide o desenho da view:
--   1. VERSÕES, não recebimentos duplicados. `omie_ncodmov` é HASH sintético de ~22 campos,
--      incluindo campos MUTÁVEIS (cStatus, dDtPagamento, nº da NF, valores do resumo). Quando o
--      título muda no Omie o hash muda, o upsert cria linha NOVA e a antiga nunca mais é vista.
--      2.591 de 16.443 títulos têm >1 linha CONTA_A_RECEBER (5.234 pares versão-velha × atual);
--      em 5.231 a velha NUNCA foi tocada depois que a atual nasceu — inclusive 2.362 velhas DENTRO
--      da janela incremental de 3 meses, que seriam revisitadas se o Omie ainda as devolvesse. As
--      3 exceções são baixa CANCELADA e refeita (o título volta a ATRASADO por dias e depois a
--      RECEBIDO com o mesmo hash): "a última observação vence" acerta nas três. Somar por título
--      somava versões (o "recebimento duplicado" de 12067405417).
--   2. CONTA_CORRENTE_REC com cOrigem de INCLUSÃO (APIR/MANR/VENR/DEVR/RPTR/'') é valor 0 em
--      3.146/3.146 linhas: marcador do título na conta corrente, não caixa (o "CC 0,00" de
--      12053202824). Baixa em caixa = CONTA_CORRENTE_REC com cOrigem BAXR/APBR (nunca 0).
--   3. Identidade do resumo, 172/172 linhas com payload bruto: nValLiquido = nValPago − nDesconto
--      + nJuros + nMulta, e nValPago + nValAberto = nValorTitulo. Soma das baixas BAXR/APBR =
--      nValLiquido em 15/15 títulos liquidados.
--   4. O banco devolve multa+juros SOMADOS em nJuros (nMulta=0): 165,00 com 5 dias de atraso →
--      nJuros 6,05 = 2%·165 + 10%·165·5/30. Por isso o número de decisão é `encargo_recebido`
--      (juros+multa); `juros/multa_informado_omie` são o que o Omie disse, não a decomposição real.
--   5. Baixa CANCELADA fica no espelho: 12097272930 está ATRASADO e a BAXR de 1.195,75 continua em
--      fin_movimentacoes. E as BAXR também têm versões (4 pares iguais com `updated_at` congelado).
--      Logo a soma das baixas pode SOBRAR — a view expõe a divergência, não a esconde.
--   6. Data: a ótica do TÍTULO carrega a data da BAIXA (dDtPagamento); a CC carrega a liquidação
--      bancária, próximo dia útil (lag 1d em 5.795 e 3d sexta→segunda em 1.004 de 13.693 títulos —
--      20260909074613). Atraso medido pela CC infla o atraso e cobraria encargo indevido.
--
-- ⚠️ `updated_at` NÃO prova que a linha é atual: o sync incremental só revisita os últimos 3
-- meses, então linha atual antiga também tem `updated_at` parado. A view só usa "mais nova vence"
-- DENTRO de um grupo que já é o mesmo objeto (o título; a mesma baixa) — e é última OBSERVAÇÃO,
-- não prova de vigência: uma versão nova fora da janela só entra no próximo backfill.
--
-- ⚠️ Limite conhecido (fora deste PR): o hash não inclui nCodBaixa, então duas baixas LEGÍTIMAS
-- com todos os campos do hash iguais colapsam numa linha antes de chegar ao banco. Efeito na view:
-- caixa < líquido → confiança `divergente`, nunca `alta`. Trocar a chave recriaria ~60k linhas e
-- dobraria as somas de v_titulo_baixas/fluxo realizado/conciliação — decisão própria.
--
-- AUSENTE ≠ ZERO: coluna NULL = o Omie não mandou ou a linha ainda não foi relida pela edge nova
-- (`resumo_lido_em` separa os dois). Nenhuma coluna nova tem DEFAULT. A view nunca transforma
-- NULL em 0; a política de cobrança (2% + 10% a.m.) fica FORA dela.
--
-- ORDEM DE DEPLOY: esta migration ANTES do deploy da edge `omie-financeiro` (a edge nova grava as
-- colunas; sem elas o upsert recebe PGRST204 e o sync de movimentos LANÇA). Depois do deploy,
-- backfill pelo motor de cursor existente (ver PR).
-- Prova: db/test-fin-encargos-titulo.sh (PG17, com falsificação).
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Colunas tipadas (aditivas, nullable, sem DEFAULT — metadata-only no ALTER)
-- ------------------------------------------------------------
ALTER TABLE public.fin_movimentacoes
  ADD COLUMN IF NOT EXISTS resumo_val_pago     numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_val_liquido  numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_desconto     numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_juros        numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_multa        numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_val_aberto   numeric(15,2),
  ADD COLUMN IF NOT EXISTS resumo_liquidado    boolean,
  ADD COLUMN IF NOT EXISTS valor_titulo        numeric(15,2),
  ADD COLUMN IF NOT EXISTS tipo_documento      text,
  ADD COLUMN IF NOT EXISTS omie_ncodbaixa      bigint,
  ADD COLUMN IF NOT EXISTS data_pagamento_omie date,
  ADD COLUMN IF NOT EXISTS data_credito_omie   date,
  ADD COLUMN IF NOT EXISTS resumo_lido_em      timestamptz;

COMMENT ON COLUMN public.fin_movimentacoes.resumo_val_pago IS
  'Omie resumo.nValPago: PRINCIPAL do título baixado (sem encargo, antes do desconto). NULL = ausente, nunca 0 fabricado.';
COMMENT ON COLUMN public.fin_movimentacoes.resumo_val_liquido IS
  'Omie resumo.nValLiquido: o que entrou em caixa = nValPago − nDesconto + nJuros + nMulta (identidade medida 172/172).';
COMMENT ON COLUMN public.fin_movimentacoes.resumo_juros IS
  'Omie resumo.nJuros. ⚠️ O retorno bancário de boleto vem com a MULTA SOMADA aqui (nMulta=0) — use juros+multa juntos.';
COMMENT ON COLUMN public.fin_movimentacoes.data_pagamento_omie IS
  'Omie detalhes.dDtPagamento. Na ótica do título (CONTA_A_RECEBER) é a data da BAIXA — a que decide atraso.';
COMMENT ON COLUMN public.fin_movimentacoes.data_credito_omie IS
  'Omie detalhes.dDtCredito (ótica conta corrente): liquidação bancária, em geral o próximo dia útil após a baixa.';
COMMENT ON COLUMN public.fin_movimentacoes.resumo_lido_em IS
  'Quando a edge que persiste o resumo gravou esta linha. NULL = linha nunca relida (versão antiga ou pré-backfill), NÃO "sem encargo". Não prova vigência.';
COMMENT ON COLUMN public.fin_movimentacoes.omie_ncodbaixa IS
  'Omie detalhes.nCodBaixa: chave natural da baixa (ótica conta corrente). Distingue duas baixas iguais legítimas de duas versões da mesma.';

-- Finitude (docs/agent/money-path.md §2: `numeric` aceita NaN, e `NaN > 0` é TRUE — CHECK de sinal
-- não é guard). numeric(15,2) já recusa ±Infinity pelo typmod; os três lados ficam explícitos para o
-- dia em que alguém tirar o typmod. Só finitude: CHECK de sinal derrubaria a página do sync inteira
-- por um valor estranho do Omie, e a view já degrada a confiança quando a identidade não fecha.
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_movimentacoes'::regclass
                    AND conname = 'fin_movimentacoes_resumo_finito') THEN
    ALTER TABLE public.fin_movimentacoes ADD CONSTRAINT fin_movimentacoes_resumo_finito CHECK (
          (resumo_val_pago    IS NULL OR (resumo_val_pago    <> 'NaN' AND resumo_val_pago    < 'Infinity' AND resumo_val_pago    > '-Infinity'))
      AND (resumo_val_liquido IS NULL OR (resumo_val_liquido <> 'NaN' AND resumo_val_liquido < 'Infinity' AND resumo_val_liquido > '-Infinity'))
      AND (resumo_desconto    IS NULL OR (resumo_desconto    <> 'NaN' AND resumo_desconto    < 'Infinity' AND resumo_desconto    > '-Infinity'))
      AND (resumo_juros       IS NULL OR (resumo_juros       <> 'NaN' AND resumo_juros       < 'Infinity' AND resumo_juros       > '-Infinity'))
      AND (resumo_multa       IS NULL OR (resumo_multa       <> 'NaN' AND resumo_multa       < 'Infinity' AND resumo_multa       > '-Infinity'))
      AND (resumo_val_aberto  IS NULL OR (resumo_val_aberto  <> 'NaN' AND resumo_val_aberto  < 'Infinity' AND resumo_val_aberto  > '-Infinity'))
      AND (valor_titulo       IS NULL OR (valor_titulo       <> 'NaN' AND valor_titulo       < 'Infinity' AND valor_titulo       > '-Infinity'))
    );
  END IF;
END
$chk$;

-- ------------------------------------------------------------
-- 2. View por título recebido: encargo, desconto, fonte e confiança
-- ------------------------------------------------------------
-- Irmã da v_titulo_baixas (que segue intacta: ela escolhe a versão por `valor DESC` e serve à
-- DATA de baixa do DSO, não a encargo).
CREATE OR REPLACE VIEW public.v_titulo_encargos_cr
WITH (security_invoker = on) AS
WITH cr_linhas AS (
  SELECT m.*
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao = 'CONTA_A_RECEBER'
     AND m.omie_codigo_lancamento IS NOT NULL
),
-- Versão ATUAL do título = a linha CONTA_A_RECEBER observada por último. O Omie devolve uma linha
-- CONTA_A_RECEBER por título por vez (medido: 5.231/5.234 versões velhas nunca mais tocadas).
cr_atual AS (
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
    FROM cr_linhas c
   ORDER BY c.company, c.omie_codigo_lancamento,
            c.updated_at DESC NULLS LAST, c.created_at DESC NULLS LAST, c.id DESC
),
cr_versoes AS (
  SELECT company, omie_codigo_lancamento AS cod, count(*)::int AS versoes
    FROM cr_linhas
   GROUP BY company, omie_codigo_lancamento
),
-- Baixas em CAIXA. As de cOrigem de inclusão (APIR/MANR/VENR/DEVR/RPTR) são sempre 0 e ficam
-- fora; TRAR/EXTR não têm título.
baixa_linhas AS (
  SELECT m.id, m.company, m.omie_codigo_lancamento AS cod, m.omie_ncodcc, m.data_movimento,
         m.valor, m.omie_ncodbaixa, m.updated_at, m.created_at
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao = 'CONTA_CORRENTE_REC'
     AND m.natureza IN ('BAXR', 'APBR')
     AND m.tipo = 'E'
     AND m.omie_codigo_lancamento IS NOT NULL
),
-- Uma baixa é VERSÃO VELHA de outra quando existe linha do MESMO título, conta, data e valor,
-- observada depois — salvo se as duas têm nCodBaixa conhecido e DIFERENTE (duas baixas iguais
-- legítimas). Linha sem nCodBaixa (pré-backfill) cede à mais nova do grupo. Baixa cancelada com
-- outro conteúdo NÃO é detectável aqui: ela sobra na soma e a confiança vira `divergente`.
baixa_atual AS (
  SELECT b.*
    FROM baixa_linhas b
   WHERE NOT EXISTS (
     SELECT 1
       FROM baixa_linhas n
      WHERE n.company = b.company
        AND n.cod = b.cod
        AND n.omie_ncodcc IS NOT DISTINCT FROM b.omie_ncodcc
        AND n.data_movimento = b.data_movimento
        AND n.valor = b.valor
        AND n.id <> b.id
        AND (COALESCE(n.updated_at, '-infinity'), COALESCE(n.created_at, '-infinity'), n.id)
          > (COALESCE(b.updated_at, '-infinity'), COALESCE(b.created_at, '-infinity'), b.id)
        AND (b.omie_ncodbaixa IS NULL OR n.omie_ncodbaixa IS NULL OR n.omie_ncodbaixa = b.omie_ncodbaixa)
   )
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
         t.cnpj_cpf,
         t.numero_documento,
         t.data_emissao,
         t.data_vencimento,
         t.valor_documento,
         t.status_titulo,
         ca.tipo_documento,
         cv.versoes                                         AS versoes_titulo,
         bt.n_baixas,
         bt.soma_baixas,
         -- Data da BAIXA, em ordem de fidelidade: dDtPagamento do título > data do movimento do
         -- título (= dDtPagamento quando há, senão registro/previsão) > liquidação CC (+1 dia útil).
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
    FROM public.fin_contas_receber t
    LEFT JOIN cr_atual     ca ON ca.company = t.company AND ca.cod = t.omie_codigo_lancamento
    LEFT JOIN cr_versoes   cv ON cv.company = t.company AND cv.cod = t.omie_codigo_lancamento
    LEFT JOIN baixa_titulo bt ON bt.company = t.company AND bt.cod = t.omie_codigo_lancamento
   WHERE t.omie_codigo_lancamento IS NOT NULL
     AND t.status_titulo IN ('RECEBIDO', 'LIQUIDADO')
),
avaliado AS (
  SELECT b.*,
         COALESCE(b.resumo_completo
           AND abs(b.resumo_val_liquido
                   - (b.resumo_val_pago - b.resumo_desconto + b.resumo_juros + b.resumo_multa)) <= 0.01,
           false)                                           AS identidade_ok,
         -- Quitação PROVADA pelo próprio título: liquidado, nada em aberto, principal = documento
         -- e (quando o Omie manda) pago + aberto = valor do título.
         COALESCE(b.resumo_liquidado IS TRUE
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
       c.cnpj_cpf,
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
       -- O que o Omie INFORMOU (auditoria): só com a identidade interna fechando; inclui `divergente`.
       CASE WHEN c.identidade_ok THEN c.resumo_val_pago    END AS valor_pago_principal,
       CASE WHEN c.identidade_ok THEN c.resumo_val_liquido END AS valor_liquido_recebido,
       CASE WHEN c.identidade_ok THEN c.resumo_juros       END AS juros_informado_omie,
       CASE WHEN c.identidade_ok THEN c.resumo_multa       END AS multa_informada_omie,
       -- O número de DECISÃO: só quando nenhuma outra evidência o contradiz.
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado')
            THEN c.resumo_juros + c.resumo_multa END        AS encargo_recebido,
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado')
            THEN c.resumo_desconto END                       AS desconto_concedido,
       -- Diferença bruta caixa − documento. NÃO é encargo: adiantamento, baixa fora do caixa ou
       -- baixa cancelada que sobrou mudam o número, e juros 50 com desconto 50 dão 0.
       (c.soma_baixas - c.valor_documento)                  AS diferenca_caixa_documento,
       CASE WHEN c.confianca IN ('alta', 'erp_sem_caixa', 'erp_nao_quitado') THEN 'omie_resumo'
            WHEN c.confianca = 'so_diferenca_caixa'                          THEN 'diferenca_caixa'
       END                                                  AS fonte,
       c.confianca,
       c.resumo_lido_em
  FROM classificado c;

COMMENT ON VIEW public.v_titulo_encargos_cr IS
  'Por título a receber RECEBIDO/LIQUIDADO: encargo (juros+multa) e desconto efetivos do resumo do Omie, '
  'com fonte e confiança (alta | erp_sem_caixa | erp_nao_quitado | divergente | inconsistente | '
  'so_diferenca_caixa | sem_dado). Ausente = NULL, nunca 0. encargo_recebido só sai quando nenhuma '
  'evidência o contradiz. Política de cobrança (2% + 10% a.m.) fica FORA — a view expõe dias_atraso.';

-- Leitura de staff via RLS das tabelas-base (security_invoker). anon fora pelo nome (CLAUDE.md:
-- FROM PUBLIC não tira anon).
REVOKE ALL ON public.v_titulo_encargos_cr FROM PUBLIC;
REVOKE ALL ON public.v_titulo_encargos_cr FROM anon;
REVOKE ALL ON public.v_titulo_encargos_cr FROM authenticated;
GRANT SELECT ON public.v_titulo_encargos_cr TO authenticated;
GRANT SELECT ON public.v_titulo_encargos_cr TO service_role;

-- ------------------------------------------------------------
-- Postcondição embutida — migration que não pegou NÃO termina em silêncio
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_faltando text;
BEGIN
  SELECT string_agg(c, ', ') INTO v_faltando
    FROM unnest(ARRAY['resumo_val_pago','resumo_val_liquido','resumo_desconto','resumo_juros',
                      'resumo_multa','resumo_val_aberto','resumo_liquidado','valor_titulo',
                      'tipo_documento','omie_ncodbaixa','data_pagamento_omie','data_credito_omie',
                      'resumo_lido_em']) c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'fin_movimentacoes'
                        AND column_name = c);
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: fin_movimentacoes sem %: a edge nova recebe PGRST204 e o sync de movimentos LANCA', v_faltando;
  END IF;

  -- Coluna com DEFAULT fabricaria o zero que esta migration existe para não fabricar.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'fin_movimentacoes'
                AND column_name IN ('resumo_val_pago','resumo_val_liquido','resumo_desconto',
                                    'resumo_juros','resumo_multa','resumo_val_aberto','valor_titulo')
                AND column_default IS NOT NULL) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: coluna de valor do resumo com DEFAULT — ausente viraria numero';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.fin_movimentacoes'::regclass
                    AND conname = 'fin_movimentacoes_resumo_finito'
                    AND convalidated
                    AND pg_get_constraintdef(oid) LIKE '%NaN%') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: CHECK de finitude ausente ou nao validado';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = to_regclass('public.v_titulo_encargos_cr')
                    AND relkind = 'v'
                    AND 'security_invoker=on' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: v_titulo_encargos_cr ausente ou sem security_invoker=on — leria como owner e furaria a RLS';
  END IF;

  IF has_table_privilege('anon', 'public.v_titulo_encargos_cr', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon le v_titulo_encargos_cr';
  END IF;

  RAISE NOTICE 'fin_movimentacoes: 13 colunas de resumo + CHECK de finitude; v_titulo_encargos_cr criada (security_invoker=on, sem anon)';
END
$post$;

COMMIT;

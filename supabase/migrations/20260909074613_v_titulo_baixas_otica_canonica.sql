-- ============================================================
-- v_titulo_baixas — uma ótica por título (o Omie devolve o mesmo pagamento DUAS vezes)
-- Base: docs/historico/valor-pag-nao-e-valor-pago-e-a-baixa-ja-chega-em-mf.md (#2409)
-- ============================================================
-- O `financas/mf/ListarMovimentos` devolve o MESMO pagamento sob duas óticas,
-- distinguidas por `cGrupo` (persistido em fin_movimentacoes.categoria_descricao):
--
--   CONTA_A_RECEBER / CONTA_A_PAGAR          -> o lançamento do TÍTULO
--   CONTA_CORRENTE_REC / CONTA_CORRENTE_PAG  -> o lançamento na CONTA CORRENTE
--
-- O `omie_ncodmov` é um hash FNV do payload e inclui cGrupo (+ ~20 campos que só
-- existem em UMA das óticas) => IDs diferentes => AMBAS persistem => sum(valor)
-- DOBRAVA. Medido na PROD 2026-09-09: soma da view R$ 43,82 M contra R$ 23,74 M
-- de soma dos valor_documento dos MESMOS títulos (+84,6%); só 14,7% dos títulos
-- tinham valor_baixado == valor_documento.
--
-- QUAL ÓTICA É A BAIXA — prova de CALENDÁRIO (13.693 títulos CR com as duas):
--   lag = data_CONTA_CORRENTE - data_CONTA_A:  0d 6690 | 1d 5795 | 2d 100 | 3d 1004
--   dos lag=3, 98,5% caem numa SEXTA (sexta+3 = segunda); dos lag=1, 0,0% em sexta
--   (sexta+1 = sábado); crédito em fim de semana: 6 em 13.637 (0,04%).
--   => data_CONTA_CORRENTE = próximo dia ÚTIL após data_CONTA_A. A ótica do TÍTULO
--   é a BAIXA; a de conta corrente é a LIQUIDAÇÃO bancária (compensação).
--   Confirmam: (a) payload cru — a ótica CC tem nCodBaixa/nCodMovCC/dDtCredito/
--   dDtConcilia e NÃO tem dDtRegistro/nValorTitulo/cNumTitulo; a do título tem
--   nValAberto/cLiquidado/cNumParcela; (b) status — CONTA_A_RECEBER lista também
--   A VENCER/ATRASADO/CANCELADO (lista o título ABERTO), CONTA_CORRENTE_REC só
--   existe quando houve baixa.
--
-- POR QUE NA VIEW E NÃO NA INGESTÃO: tirar cGrupo do hash seria INERTE — nos
-- 14.410 pares, só 34,5% colidiriam mesmo sem ele (e isso é LIMITE SUPERIOR: só
-- 3 dos ~20 campos do hash estão persistidos pra medir), então reescreveria a
-- identidade de 56.658 linhas sem remover duplicata. E a ótica CONTA_CORRENTE é a
-- ÚNICA com movimento SEM título (3.747 PAG + 2.304 REC, R$ 6,0 M de extrato puro:
-- transferência, tarifa) — descartá-la na ingestão apagaria o extrato bancário do
-- banco de dados, e ela é a ótica CERTA pro caixa realizado (é dinheiro na conta,
-- não baixa de título). (Correção da revisão Codex: esses R$ 6,0 M NÃO chegam hoje
-- ao fluxo realizado — `agregarRealizadoPorDia` descarta movimento sem título de
-- propósito. O argumento que sustenta a decisão é o da inércia do hash, acima.)
--
-- POR QUE NÃO O FILTRO CEGO `LIKE 'CONTA_A_%'`: perderia 3.225 títulos, TODOS do
-- colacor, cuja ótica de título só existe a partir de 2026-02-25 enquanto a de
-- conta corrente vai até 2020-04-17. É perda de JANELA, não semântica. Por isso a
-- escolha é POR TÍTULO: usa a ótica do título quando ela existe; senão cai para a
-- de conta corrente e DECLARA isso em `origem_baixa` (degradação honesta — o
-- consumidor vê que aquela data é de crédito, não de baixa). Cobertura: 21.577
-- títulos, os mesmos de hoje, zero perda; e 97,1% passam a bater exato com o
-- valor_documento (hoje 14,7%), soma R$ 23,73 M contra R$ 23,74 M de documento.
--
-- ⚠️ O QUE ESTA VIEW **NÃO** RESOLVE (levantado pela revisão Codex, medido):
--   1. `origem_baixa` só vira honestidade se o CONSUMIDOR a ler. Hoje nenhum lê:
--      `resolverDataCaixa` marca a data do proxy como `usou_fallback:false` e o
--      cockpit conta qualquer data preenchida como `v_real`. Enquanto isso não
--      mudar, os 3.225 títulos do colacor seguem entrando como baixa observada.
--   2. Uma ótica canônica não serve a perguntas diferentes: PMR/aging querem a
--      QUITAÇÃO (ótica do título); projeção de caixa e DRE-caixa querem a
--      DISPONIBILIDADE bancária (ótica de conta corrente). Esta view passa a
--      responder a primeira; a segunda é decisão de produto, ainda aberta.
--   3. O fluxo de caixa REALIZADO tem a MESMA dobra e não passa por esta view:
--      lê fin_movimentacoes direto e soma as duas óticas — medido, R$ 22,39 M de
--      entradas contra R$ 11,43 M da ótica de banco sozinha.
--
-- ALLOWLIST POSITIVA de grupos: existem SEIS valores de cGrupo, não quatro —
-- PREVISAO_PEDIDO_VENDA (461) e PREVISAO_ORDEM_SERVICO (112) são tipo 'E' com
-- valor>0. Medido: hoje ZERO deles casa com título da view, mas um filtro por
-- negação (`NOT LIKE 'CONTA_CORRENTE%'`) os deixaria entrar como se fossem baixa.
--
-- Mantém tudo o que a versão anterior garantia: só títulos liquidados, type-match
-- E<->CR / S<->CP, valor>0, data_baixa_final = MAX, prazo ponderado por valor,
-- security_invoker (RLS das base-tables). Idempotente. Coluna nova NO FIM.

BEGIN;

CREATE OR REPLACE VIEW public.v_titulo_baixas
WITH (security_invoker = on) AS
WITH mov AS (
  SELECT company, omie_codigo_lancamento AS cod, tipo,
         data_movimento, valor, categoria_descricao AS grupo
  FROM public.fin_movimentacoes
  WHERE omie_codigo_lancamento IS NOT NULL
    AND data_movimento IS NOT NULL
    AND tipo IN ('E', 'S')
    AND valor > 0
    AND categoria_descricao IN (
      'CONTA_A_RECEBER', 'CONTA_A_PAGAR',
      'CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG'
    )
),
canon AS (
  -- Por título+lado: a ótica do TÍTULO existe? Ela vence. Senão, fallback declarado.
  SELECT company, cod, tipo,
         bool_or(grupo IN ('CONTA_A_RECEBER', 'CONTA_A_PAGAR')) AS tem_otica_titulo
  FROM mov
  GROUP BY company, cod, tipo
),
base AS (
  SELECT m.company, m.cod, m.tipo, m.data_movimento, m.valor,
         CASE WHEN c.tem_otica_titulo THEN 'titulo' ELSE 'conta_corrente' END AS origem
  FROM mov m
  JOIN canon c
    ON c.company = m.company AND c.cod = m.cod AND c.tipo = m.tipo
  WHERE (c.tem_otica_titulo AND m.grupo IN ('CONTA_A_RECEBER', 'CONTA_A_PAGAR'))
     OR NOT c.tem_otica_titulo
),
mov_canon AS (
  -- Ótica do TÍTULO: as linhas são RESUMOS CUMULATIVOS, não eventos — `nValPago`
  -- é o total pago DO TÍTULO, e uma mudança de estado gera outra identidade (o
  -- hash inclui valor/status/datas) sem remover a anterior. Somá-las conta o mesmo
  -- dinheiro de novo: medido, 96 títulos com 2-3 resumos excediam o documento em
  -- R$ 85.828,86 (achado da revisão Codex, verificado na PROD). Fica só o resumo
  -- mais completo — maior valor, desempate pela data mais recente.
  -- ⚠️ Limitação aceita: com resumo cumulativo o prazo é o do ÚLTIMO evento
  -- (R$400 aos 9d + R$1.000 aos 30d vira 30d, não os 22d ponderados dos eventos).
  -- São 97 títulos em 21.577 (0,45%) e hoje esses mesmos estão piores (somando).
  (SELECT DISTINCT ON (company, cod, tipo)
          company, cod, tipo, data_movimento, valor, origem
   FROM base WHERE origem = 'titulo'
   ORDER BY company, cod, tipo, valor DESC, data_movimento DESC)
  UNION ALL
  -- Ótica de CONTA CORRENTE: cada linha é uma BAIXA distinta (tem `nCodBaixa`
  -- próprio no payload) — aqui somar é o certo, é o que reconstrói o total pago.
  (SELECT company, cod, tipo, data_movimento, valor, origem
   FROM base WHERE origem = 'conta_corrente')
)
SELECT
  cr.company,
  cr.omie_codigo_lancamento,
  'CR'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final,
  sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cr.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cr.data_emissao)) / sum(m.valor))
       ELSE NULL END AS prazo_ponderado_dias,
  max(m.origem) AS origem_baixa
FROM public.fin_contas_receber cr
JOIN mov_canon m
  ON m.company = cr.company
 AND m.cod = cr.omie_codigo_lancamento
 AND m.tipo = 'E'
WHERE cr.omie_codigo_lancamento IS NOT NULL
  AND cr.status_titulo IN ('RECEBIDO', 'LIQUIDADO')
GROUP BY cr.company, cr.omie_codigo_lancamento, cr.data_emissao
UNION ALL
SELECT
  cp.company,
  cp.omie_codigo_lancamento,
  'CP'::text AS tipo,
  max(m.data_movimento) AS data_baixa_final,
  sum(m.valor) AS valor_baixado,
  count(*)::int AS n_movimentos,
  CASE WHEN cp.data_emissao IS NOT NULL AND sum(m.valor) > 0
       THEN round(sum(m.valor * (m.data_movimento - cp.data_emissao)) / sum(m.valor))
       ELSE NULL END AS prazo_ponderado_dias,
  max(m.origem) AS origem_baixa
FROM public.fin_contas_pagar cp
JOIN mov_canon m
  ON m.company = cp.company
 AND m.cod = cp.omie_codigo_lancamento
 AND m.tipo = 'S'
WHERE cp.omie_codigo_lancamento IS NOT NULL
  AND cp.status_titulo IN ('PAGO', 'LIQUIDADO')
GROUP BY cp.company, cp.omie_codigo_lancamento, cp.data_emissao;

GRANT SELECT ON public.v_titulo_baixas TO authenticated, service_role;

-- ── Postcondição: aborta o Run se a view não ficou no estado que se quer ──────
DO $post$
DECLARE
  v_razao numeric;
  v_titulos bigint;
BEGIN
  -- (a) security_invoker: omitir o WITH no replace RESETA a opção e a view passa a
  --     ler como OWNER, bypassando RLS — falha ABERTA que o CI não vê.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.v_titulo_baixas'::regclass
      AND reloptions @> ARRAY['security_invoker=on']
  ) THEN
    RAISE EXCEPTION 'v_titulo_baixas FALHOU: security_invoker NÃO está on — a view leria como OWNER e bypassaria RLS';
  END IF;

  -- (b) a coluna nova existe (é o que declara o fallback ao consumidor)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'v_titulo_baixas'
      AND column_name = 'origem_baixa'
  ) THEN
    RAISE EXCEPTION 'v_titulo_baixas FALHOU: coluna origem_baixa ausente — o consumidor não saberia distinguir baixa de crédito bancário';
  END IF;

  -- (c) EIXO POR FORA: a soma da view contra valor_documento do TÍTULO — fonte que
  --     não passa por fin_movimentacoes. Dobrada, a razão era 1,85; corrigida, 1,003.
  --     Pulado em banco sem dados (PG17 de teste / ambiente novo): sem denominador
  --     não há veredito, e ausência de dado não é aprovação.
  SELECT count(*), sum(b.valor_baixado) / nullif(sum(t.valor_documento), 0)
    INTO v_titulos, v_razao
  FROM public.v_titulo_baixas b
  JOIN (
    SELECT company, omie_codigo_lancamento, valor_documento FROM public.fin_contas_receber
    UNION ALL
    SELECT company, omie_codigo_lancamento, valor_documento FROM public.fin_contas_pagar
  ) t ON t.company = b.company AND t.omie_codigo_lancamento = b.omie_codigo_lancamento;

  IF v_titulos > 1000 AND v_razao IS NOT NULL AND v_razao > 1.10 THEN
    RAISE EXCEPTION 'v_titulo_baixas FALHOU: soma/valor_documento = % (limite 1.10) em % títulos — a dobra das duas óticas continua', round(v_razao, 4), v_titulos;
  END IF;

  RAISE NOTICE 'v_titulo_baixas OK: security_invoker=on, origem_baixa presente, razao=% em % titulos', round(coalesce(v_razao, 0), 4), v_titulos;
END
$post$;

COMMIT;

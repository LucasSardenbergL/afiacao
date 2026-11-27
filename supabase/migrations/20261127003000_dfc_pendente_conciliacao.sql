-- ============================================================
-- DFC realizado: baixa que o título vigente NÃO sustenta sai das atividades para o balde VISÍVEL
-- `pendente_conciliacao` (nunca some em silêncio).
--
-- Defeito (pendência de docs/historico/dfc-realizado-mapa-proprio.md, caso 12097272930 de
-- encargos-recebidos-por-titulo.md): a BAXR de 1.195,75 (2026-07-08, sem nCodBaixa, nunca relida)
-- segue no espelho, mas a última leitura do título (2026-10-13) diz nValPago 0 / aberto 1.343,30.
-- Sem baixa identificada no título, a view a contava como caixa.
--
-- Regra (Codex desenho 2026-11-26: a evidência NÃO prova cancelamento ⇒ um balde só, de pendência):
-- concilia só o evento de BAIXA (BAXR/BAXP/APBR) com título, ainda não segregado em pendente_*.
-- Título vigente = última linha RELIDA (resumo_lido_em) da ótica do título, mesmo sentido.
-- Soma = baixas conciliáveis do título no histórico inteiro, DEPOIS da dedup e dos pendente_*.
--   • título vigente com nValPago = 0            ⇒ pendente_conciliacao (contradição com a CC)
--   • ≥ 2 baixas e soma > líquido vigente + 0,01 ⇒ pendente_conciliacao (TODAS: qual sobra é arbitrário)
--   • sem título vigente/líquido e CC nunca relida ⇒ pendente_conciliacao
--   • 1 baixa > líquido ⇒ CONTA: diferença de base (juros/multa no CP), medido em 9 títulos.
--   • soma < líquido ⇒ CONTA (caixa observado; falta = colapso de chave, migration 20261127000000).
-- Vencedora por nCodBaixa: a de chave NEGATIVA (identidade da edge v1.16) antes do updated_at
-- (revisão Codex: versão congelada mais nova não pode vencer a viva).
-- CREATE OR REPLACE: mesmas colunas, mesma ordem; security_invoker REPETIDO; master-only dentro.
-- Prova: db/test-fin-dfc-realizado.sh (PG17, falsificação, C e pt_BR).
-- ============================================================
CREATE OR REPLACE VIEW public.v_fin_fluxo_caixa_realizado
WITH (security_invoker = on) AS
WITH cc AS (
  -- SEM filtro de valor aqui: a versão vencedora é escolhida ANTES (uma baixa corrigida para 0 não pode
  -- ressuscitar o valor da versão anterior — Codex). Master-only DENTRO da view: a RLS de
  -- fin_movimentacoes (fin_user_can_access) libera também funcionário, e o invoker sozinho vazaria o DFC.
  SELECT m.id, m.company, m.natureza, m.categoria_codigo, m.categoria_descricao, m.valor, m.data_movimento,
         m.omie_ncodbaixa, m.omie_codigo_lancamento, m.resumo_lido_em,
         row_number() OVER (PARTITION BY m.company, m.omie_ncodbaixa
                            ORDER BY (m.omie_ncodmov < 0) DESC, m.updated_at DESC, m.created_at DESC, m.id DESC) AS rn
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')
     AND public.has_role(auth.uid(), 'master'::public.app_role)
),
vencedoras AS (
  SELECT * FROM cc WHERE cc.omie_ncodbaixa IS NOT NULL AND cc.rn = 1
),
eventos_base AS (
  SELECT v.company, v.natureza, v.categoria_codigo, v.categoria_descricao, v.valor, v.data_movimento,
         v.omie_codigo_lancamento, v.resumo_lido_em, NULL::text AS linha_forcada
    FROM vencedoras v
   WHERE v.valor > 0
  UNION ALL
  SELECT n.company, n.natureza, n.categoria_codigo, n.categoria_descricao, n.valor, n.data_movimento,
         n.omie_codigo_lancamento, n.resumo_lido_em,
         CASE
           WHEN n.natureza IN ('BAXR', 'BAXP', 'APBR') AND EXISTS (
                  SELECT 1 FROM vencedoras w
                   WHERE w.company = n.company AND w.omie_codigo_lancamento = n.omie_codigo_lancamento
                     AND w.categoria_descricao = n.categoria_descricao AND w.valor = n.valor)
             THEN 'pendente_identidade'   -- mesma baixa vista antes do identificador (provável versão)
           WHEN n.natureza IN ('BAXR', 'BAXP', 'APBR') AND EXISTS (
                  SELECT 1 FROM vencedoras w
                   WHERE w.company = n.company AND w.omie_codigo_lancamento = n.omie_codigo_lancamento
                     AND w.categoria_descricao = n.categoria_descricao)
             THEN 'pendente_revisao'      -- só o título coincide: pode ser parcela legítima — revisar
         END
    FROM cc n
   WHERE n.omie_ncodbaixa IS NULL AND n.valor > 0
),
titulo_vigente AS (
  -- última leitura RELIDA do título (ótica CONTA_A_*), por sentido. Master-only como a CC.
  SELECT DISTINCT ON (t.company, t.omie_codigo_lancamento, t.categoria_descricao)
         t.company, t.omie_codigo_lancamento,
         CASE t.categoria_descricao WHEN 'CONTA_A_RECEBER' THEN 'CONTA_CORRENTE_REC'
                                    ELSE 'CONTA_CORRENTE_PAG' END AS cc_categoria,
         t.resumo_val_pago AS pago, t.resumo_val_liquido AS liquido
    FROM public.fin_movimentacoes t
   WHERE t.categoria_descricao IN ('CONTA_A_RECEBER', 'CONTA_A_PAGAR')
     AND t.resumo_lido_em IS NOT NULL
     AND t.omie_codigo_lancamento IS NOT NULL
     AND public.has_role(auth.uid(), 'master'::public.app_role)
   ORDER BY t.company, t.omie_codigo_lancamento, t.categoria_descricao,
            t.resumo_lido_em DESC, t.updated_at DESC, t.created_at DESC, t.id DESC  -- a RELEITURA mais recente
),
marcados AS (
  SELECT e.*,
         -- coalesce: natureza NULL (Omie omitiu cOrigem) NÃO concilia — e nunca vira NULL na guarda.
         coalesce(e.linha_forcada IS NULL AND e.natureza IN ('BAXR', 'BAXP', 'APBR')
                  AND e.omie_codigo_lancamento IS NOT NULL, false) AS concilia
    FROM eventos_base e
),
somados AS (
  SELECT k.*,
         sum(k.valor) FILTER (WHERE k.concilia)
           OVER (PARTITION BY k.company, k.omie_codigo_lancamento, k.categoria_descricao) AS soma_titulo,
         count(*) FILTER (WHERE k.concilia)
           OVER (PARTITION BY k.company, k.omie_codigo_lancamento, k.categoria_descricao) AS n_baixas_titulo
    FROM marcados k
),
eventos AS (
  SELECT s.company, s.natureza, s.categoria_codigo, s.categoria_descricao, s.valor, s.data_movimento,
         CASE
           WHEN s.concilia IS NOT TRUE THEN s.linha_forcada
           WHEN tv.pago = 0 THEN 'pendente_conciliacao'
           WHEN s.n_baixas_titulo >= 2 AND tv.liquido IS NOT NULL AND s.soma_titulo > tv.liquido + 0.01
             THEN 'pendente_conciliacao'
           WHEN tv.liquido IS NULL AND s.resumo_lido_em IS NULL THEN 'pendente_conciliacao'
         END AS linha_forcada
    FROM somados s
    LEFT JOIN titulo_vigente tv
      ON tv.company = s.company AND tv.omie_codigo_lancamento = s.omie_codigo_lancamento
     AND tv.cc_categoria = s.categoria_descricao
),
classificados AS (
  SELECT e.company, date_trunc('month', e.data_movimento)::date AS mes,
         CASE WHEN e.natureza IN ('TRAP', 'TRAR') THEN 'transferencia_interna'
              ELSE coalesce(e.linha_forcada, fm.fluxo_linha, 'nao_classificado') END AS fluxo_linha,
         CASE WHEN e.categoria_descricao = 'CONTA_CORRENTE_REC' THEN e.valor ELSE 0 END AS entrada,
         CASE WHEN e.categoria_descricao = 'CONTA_CORRENTE_PAG' THEN e.valor ELSE 0 END AS saida
    FROM eventos e
    LEFT JOIN public.fin_categoria_fluxo_mapping fm
      ON fm.company = e.company AND fm.omie_codigo = e.categoria_codigo
)
SELECT company, mes, fluxo_linha,
       CASE
         WHEN fluxo_linha LIKE 'op\_%' THEN 'operacional'
         WHEN fluxo_linha LIKE 'inv\_%' THEN 'investimento'
         WHEN fluxo_linha LIKE 'fin\_%' THEN 'financiamento'
         ELSE fluxo_linha  -- transferencia_interna · equivalente_caixa · pendente_* · nao_classificado
       END AS atividade,
       round(sum(entrada), 2) AS entradas,
       round(sum(saida), 2) AS saidas,
       round(sum(entrada) - sum(saida), 2) AS liquido,
       count(*)::int AS lancamentos
  FROM classificados
 GROUP BY company, mes, fluxo_linha;

COMMENT ON VIEW public.v_fin_fluxo_caixa_realizado IS
  'DFC realizado (método direto) por empresa/mês/linha: ótica bancária deduplicada por baixa; transferência pela origem; baixa não sustentada pelo título vigente em pendente_conciliacao; pendente_* e nao_classificado visíveis. security_invoker.';
REVOKE ALL ON public.v_fin_fluxo_caixa_realizado FROM anon;
GRANT SELECT ON public.v_fin_fluxo_caixa_realizado TO authenticated;

-- ── postcondição ──
DO $post$
DECLARE v_def text; v_opts text[];
BEGIN
  SELECT reloptions INTO v_opts FROM pg_class WHERE oid = 'public.v_fin_fluxo_caixa_realizado'::regclass;
  IF v_opts IS NULL OR NOT ('security_invoker=on' = ANY (v_opts) OR 'security_invoker=true' = ANY (v_opts)) THEN
    RAISE EXCEPTION 'postcondicao: v_fin_fluxo_caixa_realizado sem security_invoker (%)', v_opts;
  END IF;
  v_def := pg_get_viewdef('public.v_fin_fluxo_caixa_realizado'::regclass);
  IF v_def NOT LIKE '%pendente_conciliacao%' OR v_def NOT LIKE '%has_role(auth.uid()%' THEN
    RAISE EXCEPTION 'postcondicao: view sem pendente_conciliacao ou sem predicado master';
  END IF;
  IF has_table_privilege('anon', 'public.v_fin_fluxo_caixa_realizado', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le v_fin_fluxo_caixa_realizado';
  END IF;
END
$post$;

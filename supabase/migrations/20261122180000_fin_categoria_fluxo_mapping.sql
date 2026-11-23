BEGIN;
-- ============================================================
-- DFC (fluxo de caixa, método direto) — mapa PRÓPRIO de categorias Omie → linha do fluxo.
--
-- Por que tabela própria (e não coluna em fin_categoria_dre_mapping): DRE e DFC respondem perguntas
-- diferentes e a decisão de uma não deve forçar a outra. Ex.: colacor 2.01.01 tem uso MISTO CR/CP e
-- ficou SEM decisão de DRE de propósito (#4129), mas tem R$ 121k de caixa; transferências (0.01.*) e
-- tarifas que só vêm do extrato não têm o que fazer na DRE.
--
-- Política (IFRS 18 / revisão do CPC 03, adotada já para não migrar em 2027):
--   operacional  op_*  — inclui tarifas bancárias e o parcelamento de tributo (acompanha o tributo de origem)
--   investimento inv_* — inclui juros/rendimentos e dividendos RECEBIDOS
--   financiamento fin_* — inclui juros PAGOS e a parcela de empréstimo (principal+juros não separados)
--   transferencia_interna — entre contas da MESMA empresa: fora do fluxo (a origem TRAP/TRAR também decide)
-- Sem `_default`: código Omie NÃO é global entre as empresas (1.04.04 = aporte na oben, empréstimo na SC).
-- Desenho: docs/superpowers/specs/2026-11-22-dre-fluxo-caixa-mapa-proprio-design.md §4
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fin_categoria_fluxo_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company = ANY (ARRAY['oben', 'colacor', 'colacor_sc'])),
  omie_codigo text NOT NULL,
  fluxo_linha text NOT NULL CONSTRAINT fin_categoria_fluxo_mapping_linha_check CHECK (fluxo_linha = ANY (ARRAY[
    'op_recebimento_clientes', 'op_outros_recebimentos', 'op_fornecedores', 'op_pessoal', 'op_impostos',
    'op_impostos_parcelamento', 'op_despesas', 'op_tarifas_bancarias', 'op_adiantamentos',
    'inv_imobilizado', 'inv_venda_ativo', 'inv_aplicacoes', 'inv_rendimentos',
    'fin_captacao', 'fin_amortizacao', 'fin_juros', 'fin_aporte', 'fin_distribuicao', 'fin_intercompany',
    'transferencia_interna'
  ]::text[])),
  notas text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fin_categoria_fluxo_mapping_company_codigo_key UNIQUE (company, omie_codigo)
);

COMMENT ON TABLE public.fin_categoria_fluxo_mapping IS
  'DFC: (empresa, código Omie) → linha do fluxo de caixa (op_/inv_/fin_ = atividade; transferencia_interna fora do fluxo). Independente do mapa da DRE. Sem _default.';

-- RLS: espelho do fin_categoria_dre_mapping (master lê e escreve; service_role para edges/cron).
ALTER TABLE public.fin_categoria_fluxo_mapping ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fin_cat_fluxo_master_all ON public.fin_categoria_fluxo_mapping;
CREATE POLICY fin_cat_fluxo_master_all ON public.fin_categoria_fluxo_mapping
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'::public.app_role))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'::public.app_role));
DROP POLICY IF EXISTS fin_cat_fluxo_service_all ON public.fin_categoria_fluxo_mapping;
CREATE POLICY fin_cat_fluxo_service_all ON public.fin_categoria_fluxo_mapping
  FOR ALL USING (auth.role() = 'service_role');
REVOKE ALL ON public.fin_categoria_fluxo_mapping FROM anon;
-- explícito (não depender do default privilege do projeto): quem guarda é o RLS acima. A view é
-- security_invoker, então o authenticated PRECISA ler esta tabela para o join funcionar.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fin_categoria_fluxo_mapping TO authenticated;

-- ============================================================
-- v_fin_fluxo_caixa_realizado — DFC realizado por (empresa, mês, linha), método direto.
-- Fonte: fin_movimentacoes na ótica BANCÁRIA (CONTA_CORRENTE_REC/PAG, valor > 0) — cada linha é um
-- evento de caixa; a ótica CONTA_A_* é resumo cumulativo por título e dobraria. Data = data_movimento
-- (= data de crédito em 100% das baixas medidas, 2026-11-22).
-- Identidade (medida em prod, histórico inteiro):
--   • baixa identificada: ÚLTIMA observação por (empresa, omie_ncodbaixa) — 4 grupos tinham versão
--     congelada (hash de ncodmov mudou; mesmo valor, data e conta).
--   • baixa SEM omie_ncodbaixa em título que JÁ tem baixa identificada: versão anterior à captura do
--     identificador (nenhuma atualizada depois de 2026-10-09) ⇒ linha `pendente_identidade`, FORA das
--     atividades mas visível. Órfã (título sem baixa identificada) entra no fluxo — é a única evidência.
--   • extrato/transferência não têm identificador; chaves naturais repetidas são lançamentos distintos
--     (descrições diferentes, nenhuma versão congelada) ⇒ entram todas.
--   • TRAP/TRAR ⇒ `transferencia_interna` pela ORIGEM, qualquer que seja a categoria (pareamento medido:
--     100% dentro da própria empresa em 12m).
--   • categoria sem decisão em fin_categoria_fluxo_mapping ⇒ `nao_classificado` (visível, nunca some).
-- Saldo das contas é o CONTÁBIL do Omie, não conciliado com o banco — a tela diz isso.
-- ============================================================
CREATE OR REPLACE VIEW public.v_fin_fluxo_caixa_realizado
WITH (security_invoker = on) AS
WITH cc AS (
  SELECT m.id, m.company, m.natureza, m.categoria_codigo, m.categoria_descricao, m.valor, m.data_movimento,
         m.omie_ncodbaixa, m.omie_codigo_lancamento,
         row_number() OVER (PARTITION BY m.company, m.omie_ncodbaixa
                            ORDER BY m.updated_at DESC, m.created_at DESC, m.id DESC) AS rn
    FROM public.fin_movimentacoes m
   WHERE m.categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')
     AND m.valor > 0
),
eventos AS (
  SELECT cc.*,
         CASE
           WHEN cc.natureza IN ('TRAP', 'TRAR') THEN 'transferencia_interna'
           WHEN cc.omie_ncodbaixa IS NULL AND cc.natureza IN ('BAXR', 'BAXP', 'APBR')
                AND EXISTS (SELECT 1 FROM cc c2
                             WHERE c2.company = cc.company
                               AND c2.omie_codigo_lancamento = cc.omie_codigo_lancamento
                               AND c2.omie_ncodbaixa IS NOT NULL)
             THEN 'pendente_identidade'
         END AS linha_forcada
    FROM cc
   WHERE cc.omie_ncodbaixa IS NULL OR cc.rn = 1
),
classificados AS (
  SELECT e.company, date_trunc('month', e.data_movimento)::date AS mes,
         coalesce(e.linha_forcada, fm.fluxo_linha, 'nao_classificado') AS fluxo_linha,
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
         ELSE fluxo_linha  -- transferencia_interna · pendente_identidade · nao_classificado
       END AS atividade,
       round(sum(entrada), 2) AS entradas,
       round(sum(saida), 2) AS saidas,
       round(sum(entrada) - sum(saida), 2) AS liquido,
       count(*)::int AS lancamentos
  FROM classificados
 GROUP BY company, mes, fluxo_linha;

COMMENT ON VIEW public.v_fin_fluxo_caixa_realizado IS
  'DFC realizado (método direto) por empresa/mês/linha: ótica bancária deduplicada por baixa; transferência pela origem; pendente_identidade e nao_classificado visíveis. security_invoker.';
REVOKE ALL ON public.v_fin_fluxo_caixa_realizado FROM anon;
GRANT SELECT ON public.v_fin_fluxo_caixa_realizado TO authenticated;

-- ── postcondição ──
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.fin_categoria_fluxo_mapping'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'postcondicao: fin_categoria_fluxo_mapping sem RLS';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'fin_categoria_fluxo_mapping'
        AND policyname IN ('fin_cat_fluxo_master_all', 'fin_cat_fluxo_service_all')) <> 2 THEN
    RAISE EXCEPTION 'postcondicao: policies do fluxo ausentes';
  END IF;
  IF has_table_privilege('anon', 'public.fin_categoria_fluxo_mapping', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le fin_categoria_fluxo_mapping';
  END IF;
  -- comportamento: linha válida entra (e é desfeita); linha inválida e _default são recusados.
  BEGIN
    INSERT INTO public.fin_categoria_fluxo_mapping (company, omie_codigo, fluxo_linha) VALUES ('oben', '__postcondicao__', 'fin_juros');
    RAISE EXCEPTION 'desfaz linha de prova' USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_categoria_fluxo_mapping (company, omie_codigo, fluxo_linha) VALUES ('oben', '__postcondicao__', 'linha_inexistente');
    RAISE EXCEPTION 'postcondicao: CHECK aceitou linha inexistente';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.fin_categoria_fluxo_mapping (company, omie_codigo, fluxo_linha) VALUES ('_default', '__postcondicao__', 'op_despesas');
    RAISE EXCEPTION 'postcondicao: aceitou _default';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.fin_categoria_fluxo_mapping WHERE omie_codigo = '__postcondicao__') THEN
    RAISE EXCEPTION 'postcondicao: linha de prova sobrou';
  END IF;
  -- view: security_invoker LIGADO (omitir no replace reseta e a view leria como OWNER, bypassando RLS)
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.v_fin_fluxo_caixa_realizado'::regclass
                    AND 'security_invoker=on' = ANY (coalesce(reloptions, '{}'))) THEN
    RAISE EXCEPTION 'postcondicao: v_fin_fluxo_caixa_realizado sem security_invoker=on';
  END IF;
  IF has_table_privilege('anon', 'public.v_fin_fluxo_caixa_realizado', 'SELECT') THEN
    RAISE EXCEPTION 'postcondicao: anon le v_fin_fluxo_caixa_realizado';
  END IF;
END
$post$;
COMMIT;

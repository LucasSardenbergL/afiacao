-- ============================================================================================
-- APLICAÇÃO via `bun run db:aplicar` — DRE fase 2: mapa colacor (fora_dre + impostos + 2.09)
--
-- SÓ DEPOIS de: (1) migration 20261013230000_fin_dre_fora_dre_fase2.sql aplicada; (2) edge
-- omie-financeiro v1.5 SERVIDA em prod e atestada (sonda). A PRECONDIÇÃO abaixo confere (2)
-- dentro da MESMA transação do INSERT: se o motor servido não for o que conhece `fora_dre`,
-- nada é inserido. Motor velho + mapa novo = valor fora_dre caindo em despesas_operacionais
-- COM selo de mapeado (o fallback antigo), exatamente a fabricação que esta fase remove.
--
-- Escopo: company='colacor', código EXATO (as linhas novas são não-herdáveis no motor; 2.07 e
-- 2.09 pais NÃO entram por prefixo). Nenhuma linha existente é alterada (ON CONFLICT DO NOTHING
-- + postcondição dos pares exatos: se um código já tiver outro mapa, aborta em vez de conviver).
--
-- Ficam SEM mapa (decisão registrada no PR): 2.03.78 adiantamento de salário, 2.08.01 adiantamento
-- a fornecedor, 2.05.99 devolução de cheques, 2.06.06 contribuição social, 2.06.94 ICMS ST,
-- 2.06.95 ICMS DIFAL, e os ambíguos 2.11.85/88/90, 2.12.87/89/92, 2.05.01, 2.05.02, 2.04.13.
--
-- ⚠️ `v_fonte_esperada` = hash de `omie-financeiro` em supabase/functions/_shared/sonda-fingerprints.ts
--    no commit que vai para prod. Mudou a edge → regrave o fingerprint E este literal.
-- ============================================================================================

-- ── precondição: motor que conhece fora_dre está servido ──
DO $pre$
DECLARE
  v_versao_esperada constant text := 'v1.5-dre-fora-dre-composicao';
  v_fonte_esperada  constant text := '91be8f2edb70b7c8cb9114747ecd9543d92cf13c76ea868b47d55bb12aa86d48';
  v record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'fin_dre_snapshots' AND column_name = 'resultado_provisorio') THEN
    RAISE EXCEPTION 'precondicao: migration 20261013230000 (fora_dre/resultado_provisorio) nao aplicada';
  END IF;
  SELECT t.versao, t.fonte, t.via, t.observado_em INTO v
    FROM (
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes WHERE edge = 'omie-financeiro'
      UNION ALL
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes_janela_viva() WHERE edge = 'omie-financeiro'
    ) t
   ORDER BY t.observado_em DESC, t.request_id DESC
   LIMIT 1;
  -- a observação MAIS RECENTE (qualquer via) tem de ser a esperada: uma mais nova divergente
  -- (rollback, redeploy de outro bundle) derruba a precondição.
  IF v.versao IS DISTINCT FROM v_versao_esperada OR v.fonte IS DISTINCT FROM v_fonte_esperada THEN
    RAISE EXCEPTION 'precondicao: omie-financeiro servida = % / % (via %, %) — esperado % / %',
      v.versao, v.fonte, v.via, v.observado_em, v_versao_esperada, v_fonte_esperada;
  END IF;
END
$pre$;

INSERT INTO public.fin_categoria_dre_mapping (company, omie_codigo, dre_linha, notas) VALUES
  -- fora do DRE (composição pendente): financiamento, parcelamento, investimento, distribuição
  ('colacor', '2.05.03', 'fora_dre', 'DRE fase 2: pagamento de empréstimos — principal + juros sem separação'),
  ('colacor', '2.06.90', 'fora_dre', 'DRE fase 2: parcelamento de impostos federais — principal + Selic/multa'),
  ('colacor', '2.06.96', 'fora_dre', 'DRE fase 2: Simples Nacional parcelado — principal + encargos'),
  ('colacor', '2.06.97', 'fora_dre', 'DRE fase 2: ICMS parcelado — principal + encargos'),
  ('colacor', '2.01.99', 'fora_dre', 'DRE fase 2: compra de ativo imobilizado — investimento (depreciação pendente)'),
  ('colacor', '2.07',    'fora_dre', 'DRE fase 2: CAPEX (código exato; filhos não herdam)'),
  ('colacor', '2.07.01', 'fora_dre', 'DRE fase 2: CAPEX máquinas e equipamentos'),
  ('colacor', '2.07.02', 'fora_dre', 'DRE fase 2: CAPEX veículos'),
  ('colacor', '2.07.03', 'fora_dre', 'DRE fase 2: CAPEX instalações'),
  ('colacor', '2.07.04', 'fora_dre', 'DRE fase 2: CAPEX equipamentos de informática'),
  ('colacor', '2.07.05', 'fora_dre', 'DRE fase 2: CAPEX móveis e utensílios'),
  ('colacor', '2.07.06', 'fora_dre', 'DRE fase 2: CAPEX comunicação'),
  ('colacor', '2.07.99', 'fora_dre', 'DRE fase 2: CAPEX ativo imobilizado'),
  ('colacor', '2.03.76', 'fora_dre', 'DRE fase 2: distribuição de lucros — não é despesa do período'),
  -- imposto em linha própria (presumido)
  ('colacor', '2.06.01', 'ded_icms',   'DRE fase 2: ICMS'),
  ('colacor', '2.06.02', 'ded_ipi',    'DRE fase 2: IPI'),
  ('colacor', '2.06.03', 'ded_pis',    'DRE fase 2: PIS'),
  ('colacor', '2.06.04', 'ded_cofins', 'DRE fase 2: COFINS'),
  ('colacor', '2.06.07', 'ded_iss',    'DRE fase 2: ISS'),
  ('colacor', '2.06.05', 'irpj',       'DRE fase 2: IRPJ'),
  ('colacor', '2.06.91', 'csll',       'DRE fase 2: CSLL'),
  -- cancelamento/devolução (lado CP) → deduções
  ('colacor', '2.09.01', 'deducoes', 'DRE fase 2: cancelamento de vendas de mercadoria'),
  ('colacor', '2.09.02', 'deducoes', 'DRE fase 2: cancelamento de vendas de serviços'),
  ('colacor', '2.09.05', 'deducoes', 'DRE fase 2: devolução de clientes')
ON CONFLICT (company, omie_codigo) DO NOTHING;

-- ── postcondição: os 24 pares EXATOS existem e nada fora_dre vazou para outra empresa ──
DO $post$
DECLARE
  v_ok int;
  v_vazou int;
BEGIN
  SELECT count(*) INTO v_ok FROM public.fin_categoria_dre_mapping m
    JOIN (VALUES
      ('2.05.03','fora_dre'),('2.06.90','fora_dre'),('2.06.96','fora_dre'),('2.06.97','fora_dre'),
      ('2.01.99','fora_dre'),('2.07','fora_dre'),('2.07.01','fora_dre'),('2.07.02','fora_dre'),
      ('2.07.03','fora_dre'),('2.07.04','fora_dre'),('2.07.05','fora_dre'),('2.07.06','fora_dre'),
      ('2.07.99','fora_dre'),('2.03.76','fora_dre'),
      ('2.06.01','ded_icms'),('2.06.02','ded_ipi'),('2.06.03','ded_pis'),('2.06.04','ded_cofins'),
      ('2.06.07','ded_iss'),('2.06.05','irpj'),('2.06.91','csll'),
      ('2.09.01','deducoes'),('2.09.02','deducoes'),('2.09.05','deducoes')
    ) e(cod, linha) ON m.omie_codigo = e.cod AND m.dre_linha = e.linha
   WHERE m.company = 'colacor';
  IF v_ok IS DISTINCT FROM 24 THEN RAISE EXCEPTION 'postcondicao: % de 24 pares colacor (codigo ja mapeado para outra linha?)', v_ok; END IF;
  SELECT count(*) INTO v_vazou FROM public.fin_categoria_dre_mapping WHERE dre_linha = 'fora_dre' AND company <> 'colacor';
  IF v_vazou IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'postcondicao: % mapa(s) fora_dre fora da colacor', v_vazou; END IF;
END
$post$;

-- Validação pós-apply de 20261013230000_fin_dre_fora_dre_fase2.sql (read-only).
-- Esperado depois do Run: t | t | 2 | 0. Antes do apply: ERRO "column fora_dre does not exist" (pré-voo 2026-10-13).
SELECT
  (SELECT position('''fora_dre''' IN pg_get_constraintdef(oid)) > 0 AND position('''csll''' IN pg_get_constraintdef(oid)) > 0
     FROM pg_constraint WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
      AND conname = 'fin_categoria_dre_mapping_dre_linha_check')                        AS check_ampliado,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fin_categoria_dre_mapping'::regclass
           AND conname = 'fin_categoria_dre_mapping_fora_dre_por_empresa_check' AND convalidated) AS check_por_empresa,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fin_dre_snapshots'
     AND column_name IN ('fora_dre','resultado_provisorio') AND is_nullable = 'YES' AND column_default IS NULL) AS colunas_2,
  (SELECT count(*) FROM public.fin_dre_snapshots WHERE fora_dre IS NOT NULL OR resultado_provisorio IS NOT NULL) AS snaps_com_valor_0;

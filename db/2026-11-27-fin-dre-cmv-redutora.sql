-- ============================================================================================
-- APLICAÇÃO via `bun run db:aplicar` — DRE v1.17: devolução de compra REDUZ o CMV (linha redutora)
--
-- SÓ DEPOIS de a edge omie-financeiro v1.17 (sinal por natureza) estar SERVIDA e atestada. Com o
-- motor ≤ v1.16 o motor soma SEM sinal: 1.03.01 (título CR) em `cmv` AUMENTARIA o CMV — o erro
-- oposto ao pretendido. Por isso a precondição confere versão E fingerprint na MESMA transação.
--
-- Escopo: só 1.03.01 "Devoluções de Compra de Mercadoria de Revenda" (colacor e oben — as duas com
-- uso; medido 2026-11-27: colacor 43 títulos R$ 191.260,94, oben 15 títulos R$ 23.059,68). Sai de
-- `outras_receitas` (abaixo do operacional) e passa a reduzir o CMV: resultado antes dos impostos
-- INALTERADO; lucro bruto e operacional sobem pelo mesmo valor. 1.03.02/03/04/26 (material de
-- consumo, matéria-prima, ativo, serviços) sem uso em títulos — ficam sem decisão nova.
-- Diário: docs/historico/dre-mapa-proprio-nao-resultado.md.
--
-- DEPOIS do script: RECALCULAR a DRE (calcular_dre_year) de colacor 2023–2026 e oben 2024–2026, nos DOIS
-- regimes — snapshot antigo segue com 1.03.01 em outras_receitas até ser recalculado (série misturada:
-- YoY, margemAnterior, TTM, forecast). Conferir: todo mês com 1.03.01 tem detalhamento.composicao_cmv.
-- ⚠️ ROLLBACK: reverter este MAPA (1.03.01 → outras_receitas) ANTES de qualquer volta da edge para ≤ v1.16
-- (inclusive reversão pelo sync do Lovable): motor sem sinal + mapa em cmv SOMA a devolução no CMV (~2× o erro).
--
-- Anti-deriva: UPDATE só onde a linha vigente é `outras_receitas` (a decisão de 2026-11-22); a
-- POSTCONDIÇÃO exige os 2 pares em `cmv` E a descrição do Omie igual à da decisão.
-- ⚠️ `v_fonte_esperada` = hash de `omie-financeiro` em supabase/functions/_shared/sonda-fingerprints.ts
--    no commit que vai para prod. Mudou a edge → regrave o fingerprint E o literal.
-- ============================================================================================

DO $pre$
DECLARE
  v_versao_esperada constant text := 'v1.17-sinal-natureza-cmv-redutora';
  v_fonte_esperada  constant text := 'ddbbae4e3ea80fdd74923092ccf3a5e7210cd21eb575c55f906d67d71a37f317';
  v record;
BEGIN
  SELECT t.versao, t.fonte, t.via, t.observado_em INTO v
    FROM (
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes WHERE edge = 'omie-financeiro'
      UNION ALL
      SELECT request_id, observado_em, versao, fonte, via FROM public.deploy_atestacoes_janela_viva() WHERE edge = 'omie-financeiro'
    ) t
   ORDER BY t.observado_em DESC, t.request_id DESC
   LIMIT 1;
  IF v.versao IS DISTINCT FROM v_versao_esperada OR v.fonte IS DISTINCT FROM v_fonte_esperada THEN
    RAISE EXCEPTION 'precondicao: omie-financeiro servida = % / % (via %, %) — esperado % / %',
      v.versao, v.fonte, v.via, v.observado_em, v_versao_esperada, v_fonte_esperada;
  END IF;
END
$pre$;

UPDATE public.fin_categoria_dre_mapping m
   SET dre_linha = 'cmv',
       notas = 'cmv-redutora 2026-11-27 · desc=Devoluções de Compra de Mercadoria de Revenda · CR reduz o CMV (sinal por natureza, edge v1.17)',
       updated_at = now()
 WHERE m.company IN ('colacor', 'oben') AND m.omie_codigo = '1.03.01' AND m.dre_linha = 'outras_receitas';

DO $post$
DECLARE
  v_ok int;
  v_desc int;
BEGIN
  SELECT count(*) INTO v_ok FROM public.fin_categoria_dre_mapping
   WHERE company IN ('colacor', 'oben') AND omie_codigo = '1.03.01' AND dre_linha = 'cmv';
  IF v_ok IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'postcondicao: % de 2 pares 1.03.01 em cmv (linha vigente mudou por outra mao?)', v_ok;
  END IF;
  SELECT count(*) INTO v_desc FROM public.fin_categorias
   WHERE company IN ('colacor', 'oben') AND omie_codigo = '1.03.01'
     AND descricao = 'Devoluções de Compra de Mercadoria de Revenda';
  IF v_desc IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'postcondicao: descricao do Omie de 1.03.01 mudou desde a decisao (% de 2 conferem)', v_desc;
  END IF;
END
$post$;


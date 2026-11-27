-- ============================================================
-- fin_movimentacoes: a chave da BAIXA passa a ser o nCodBaixa do Omie.
--
-- Defeito (pendência de docs/historico/dfc-realizado-mapa-proprio.md): `omie_ncodmov` era SEMPRE o
-- hash FNV (>= 0) de ~22 campos do payload, sem nCodBaixa. Duas baixas legítimas do mesmo título,
-- conta, dia e valor davam o mesmo hash e colapsavam numa linha. Medido em prod (psql-ro,
-- 2026-11-26): 3 títulos com caixa < líquido, R$ 18.562,47 sumido (10 baixas de 2.000 viraram 1).
--
-- Desenho (Codex, 2026-11-26): linha com nCodBaixa ⇒ omie_ncodmov = -omie_ncodbaixa (espaço
-- negativo, disjunto do hash). A edge `omie-financeiro` v1.16 grava assim (chave-movimento.ts).
-- Esta migration NÃO apaga nada:
--   1. RENOMEIA, por (company, nCodBaixa), UMA linha para omie_ncodmov = -omie_ncodbaixa: a que já
--      tem a chave negativa; senão a mais nova (updated_at, created_at, id). O UUID fica.
--      Versões velhas da mesma baixa (4 linhas na oben hoje, hash diferente por campo mutável)
--      ficam como estão, congeladas — exatamente o estado de hoje (os consumidores já as tratam).
--      Arquivar/remover essas 4 é decisão do founder, fora desta migration.
--   2. CHECK `NOT VALID` com os DOIS estados válidos — vale para TODA escrita nova (INSERT/UPDATE),
--      sem reprovar as 4 versões congeladas. Com o UNIQUE(company, omie_ncodmov) existente garante
--      1 linha NEGATIVA por baixa. É também a GUARDA da janela de deploy: a edge VELHA (hash) que
--      reler uma baixa com nCodBaixa depois desta migration é RECUSADA (o sync lança) em vez de
--      recriar a duplicata.
--
-- ORDEM DE DEPLOY: sem disparo de movimentos em voo (cron fin-sync-mov-2x 08:40/14:40 UTC e a
-- continuação de 10 min só com cursor pendente) → ESTA migration → deploy da edge omie-financeiro
-- v1.16 → backfill de movimentos desde 2020 (sem cursor pendente) → medir.
-- Period lock: nenhum período fechado hoje; se houver, o trigger recusa e a migration ABORTA inteira.
-- Prova: db/test-fin-mov-chave-ncodbaixa.sh (PG17, falsificação, C e pt_BR).
-- ============================================================

-- Nenhum escritor concorrente durante a troca (o sync espera o fim da transação).
LOCK TABLE public.fin_movimentacoes IN SHARE ROW EXCLUSIVE MODE;

-- Guarda: id legado <= 0 não tem chave negativa válida ((0,0) passaria pela pós-condição — Codex).
DO $guarda$
DECLARE v_ruim int;
BEGIN
  SELECT count(*) INTO v_ruim FROM public.fin_movimentacoes WHERE omie_ncodbaixa IS NOT NULL AND omie_ncodbaixa <= 0;
  IF v_ruim > 0 THEN
    RAISE EXCEPTION 'fin_mov_chave_ncodbaixa: % linha(s) com omie_ncodbaixa <= 0 — abortando sem re-chavear', v_ruim;
  END IF;
END
$guarda$;

WITH rank AS (
  SELECT m.id,
         row_number() OVER (
           PARTITION BY m.company, m.omie_ncodbaixa
           ORDER BY (m.omie_ncodmov = -m.omie_ncodbaixa) DESC,
                    m.updated_at DESC NULLS LAST, m.created_at DESC NULLS LAST, m.id DESC
         ) AS rn
    FROM public.fin_movimentacoes m
   WHERE m.omie_ncodbaixa IS NOT NULL
)
UPDATE public.fin_movimentacoes m
   SET omie_ncodmov = -m.omie_ncodbaixa
  FROM rank r
 WHERE r.id = m.id AND r.rn = 1 AND m.omie_ncodmov <> -m.omie_ncodbaixa;

ALTER TABLE public.fin_movimentacoes DROP CONSTRAINT IF EXISTS fin_movimentacoes_chave_baixa;
ALTER TABLE public.fin_movimentacoes ADD CONSTRAINT fin_movimentacoes_chave_baixa CHECK (
  (omie_ncodbaixa IS NULL AND omie_ncodmov >= 0)
  OR (omie_ncodbaixa IS NOT NULL AND omie_ncodbaixa > 0 AND omie_ncodmov = -omie_ncodbaixa)
) NOT VALID;
COMMENT ON CONSTRAINT fin_movimentacoes_chave_baixa ON public.fin_movimentacoes IS
  'Baixa identificada (nCodBaixa) tem chave -nCodBaixa; sem id, chave = hash FNV >= 0. NOT VALID: versões velhas congeladas de 20261127000000 não são revalidadas; toda escrita nova é.';

-- Postcondição EMBUTIDA: relê o estado e aborta a transação se insuficiente.
DO $post$
DECLARE
  v_sem_negativa int; v_neg_dup int; v_check text; v_fora int;
BEGIN
  -- toda baixa identificada tem exatamente uma linha com a chave negativa
  SELECT count(*) INTO v_sem_negativa FROM (
    SELECT 1 FROM public.fin_movimentacoes WHERE omie_ncodbaixa IS NOT NULL
     GROUP BY company, omie_ncodbaixa
    HAVING count(*) FILTER (WHERE omie_ncodmov = -omie_ncodbaixa) <> 1) g;
  SELECT count(*) INTO v_neg_dup FROM (
    SELECT 1 FROM public.fin_movimentacoes WHERE omie_ncodmov < 0
     GROUP BY company, omie_ncodmov HAVING count(*) > 1) d;
  -- chave negativa sem nCodBaixa correspondente seria estado impossível
  SELECT count(*) INTO v_fora FROM public.fin_movimentacoes
   WHERE omie_ncodmov < 0 AND (omie_ncodbaixa IS NULL OR omie_ncodmov <> -omie_ncodbaixa);
  SELECT pg_get_constraintdef(oid) INTO v_check FROM pg_constraint
   WHERE conrelid = 'public.fin_movimentacoes'::regclass AND conname = 'fin_movimentacoes_chave_baixa';
  IF v_sem_negativa <> 0 OR v_neg_dup <> 0 OR v_fora <> 0
     OR v_check IS NULL OR v_check NOT LIKE '%omie_ncodmov = (- omie_ncodbaixa)%' THEN
    RAISE EXCEPTION 'fin_mov_chave_ncodbaixa POSTCONDICAO: sem_negativa=% neg_dup=% fora=% check=%',
      v_sem_negativa, v_neg_dup, v_fora, v_check;
  END IF;
END
$post$;

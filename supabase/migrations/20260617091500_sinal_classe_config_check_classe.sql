-- ============================================================
-- sinal_classe_config — CHECK de domínio na coluna `classe`
-- Fase 2 / Fatia 2 (shadow-mode do visit-scoring).
--
-- POR QUÊ (money-path): tanto o edge `visit-score-recalc-client/index.ts`
-- quanto o canônico `src/lib/visit-scoring/missions.ts` filtram modifiers por
-- `classesAtivas.has(m.class)`, onde `classesAtivas` = linhas de
-- public.sinal_classe_config com ativado=true. Sem domínio na coluna, ativar
-- uma linha com `classe` digitada errada (ex.: 'lixo', ou 'marca ' com espaço)
-- que casasse com um `class` sujo no JSONB faria o boost contar nas DUAS
-- camadas — furo SILENCIOSO do gate. O domínio válido é exatamente o union de
-- SignalModifier.class: 'preco' | 'marca' | 'demanda'.
--
-- Idempotente e NÃO-destrutivo: bloco DO com guarda IF NOT EXISTS (não DROP+ADD). Re-colar
-- no SQL Editor é esperado no fluxo Lovable; com IF NOT EXISTS um re-run nunca dropa uma
-- constraint mais nova (ex.: futura 4ª classe de mesmo nome) nem abre janela sem-guarda.
-- Pré-requisito: a tabela sinal_classe_config (migration 20260616140941_fatia2_sinais_ligacao)
-- precisa já estar aplicada — esta migration apenas a blinda.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'sinal_classe_config'
      AND con.conname = 'sinal_classe_config_classe_check'
  ) THEN
    ALTER TABLE public.sinal_classe_config
      ADD CONSTRAINT sinal_classe_config_classe_check
      CHECK (classe IN ('preco', 'marca', 'demanda'));
  END IF;
END $$;

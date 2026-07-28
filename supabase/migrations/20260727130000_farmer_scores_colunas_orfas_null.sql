-- Farmer scoring — desarmar o DEFAULT 0 das 6 colunas de score SEM produtor ("colunas órfãs")
--
-- PROBLEMA (medido em prod 2026-07-22 via psql-ro): seis colunas de farmer_client_scores estão
-- 0 para toda a base porque NENHUM writer as calcula. O compute persiste por apply_score_updates,
-- cuja lista de colunas é FIXA e não as inclui; o único ponto que as escreve é o SEED
-- (calculate-scores/index.ts), com 0 literal. Distribuição (6.633 linhas):
--     recover_score      6633 zeros / 0 positivos      DEFAULT 0
--     revenue_potential  6633 zeros / 0 positivos      DEFAULT 0
--     x_score            6633 zeros / 0 positivos      DEFAULT 0
--     s_score            6633 zeros / 0 positivos      DEFAULT 0
--     eff_score          6633 zeros / 0 positivos      DEFAULT 0
--     expansion_score    6330 zeros / 303 = 60         DEFAULT 0   (os 303 são FÓSSEIS de mai/2026,
--                            de um writer despromovido em 20260520010000_scoring_visit_p1_fixes.sql:
--                            "o scoring-recalc passou a gravar SÓ signal_modifiers")
-- É a assinatura EXATA do gross_margin_pct antes do #1495 (rótulo com DEFAULT constante que nenhum
-- writer setou — money-path.md §2). O DEFAULT 0 é uma arma carregada: no dia em que um consumidor
-- ler a coluna sem coagir, o 0 fabrica um número no caminho que dirige a agenda do vendedor.
--
-- EFEITO ATIVO desta migration (fabricação que HOJE chega a uma decisão):
--   • expansion_score: as 303 linhas fósseis (=60) fazem scoreExpansao = 60*0,6 = 36 e vencem a
--     missão de 169 clientes em customer_visit_scores (visit_score = 36,00, sem variância). Nulá-las
--     + enfileirar SÓ esses 303 no visit_score_recalc_queue re-scora e derruba a missão fóssil.
--   • revenue_potential: customer360 (nova) mostra "R$ 0,00" fabricado → "—" (já trata null); o KPI
--     "Concentração Top 20%" deixa de exibir 0% enganoso.
--
-- EFEITO PREPARATÓRIO (inerte HOJE, pré-requisito estrutural do produtor futuro):
--   recover_score, x_score, s_score, eff_score — os consumidores já coagem `|| 0`, então 0→null
--   não muda comportamento agora. Mas SEM o null o produtor futuro não consegue distinguir "não
--   medido" de "medido zero" (a lição do gross_margin_pct/#1495). Desarmar o DEFAULT agora é a
--   metade "consumidor" do par consumidor+produtor (mesma ordem segura do #1498 → #1495).
--
-- O QUE ESTA MIGRATION NÃO RESOLVE (produtor server-side + displays que coagem null→0, follow-up):
--   o dano SISTÊMICO de valor-ausente (health_score deprimido, 35% do priority_score morto,
--   recoverBoost nulo) e os displays que ainda mostram 0 fabricado (plano tático→LLM, Customer360
--   administrativa via escopo-clientes `?? 0`). Nullar NÃO conserta isso; só um produtor conserta.
--
-- ⚠️ ORDEM DE DEPLOY — deploye a EDGE calculate-scores ANTES desta migration (achado Codex xhigh):
--   • Edge primeiro: o seed novo grava null; linhas novas nascem null (DEFAULT 0 NÃO sobrescreve
--     null explícito). Depois a migration remove o DEFAULT e backfilla as existentes. Sem janela.
--   • Migration primeiro (NÃO recomendado): entre o apply e o deploy da edge, o cron diário roda o
--     seed ANTIGO, que grava 0 explícito em novos faltantes — e como apply_score_updates não toca
--     essas colunas, esse 0 fica PERMANENTE. Salvaguarda: re-rode o backfill (é idempotente) DEPOIS
--     de deployar a edge nova.
--
-- BASELINE medido em prod ANTES do apply (reconstruível: as colunas sobrevivem ao apply como null):
--   recover/revenue_potential/x/s/eff = 0 em 6633/6633 · expansion = 60 em 303, 0 em 6330 · 0 nulos.
--   customer_visit_scores: 169 com primary_mission='expansao', visit_score=36,00 (min=max=36).
-- Pós-apply: as 6 colunas → 6633 NULLs, 0 positivos; visit_score_recalc_queue ganha ~303 pendências
--   (NÃO 6633 — ver nota do backfill); após o dreno, os 169 'expansao' migram para outra missão.

BEGIN;

-- (1) Desarmar o DEFAULT constante. DROP DEFAULT é idempotente (no-op se já não há default).
ALTER TABLE public.farmer_client_scores ALTER COLUMN recover_score     DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN expansion_score   DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN revenue_potential DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN x_score           DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN s_score           DROP DEFAULT;
ALTER TABLE public.farmer_client_scores ALTER COLUMN eff_score         DROP DEFAULT;

-- (2) Capturar os FÓSSEIS (expansion_score não-nulo e <> 0 → os 303 com 60) ANTES de nular. São os
--     únicos cujo visit_score MUDA (60→null vira scoreExpansao 0, deixando a missão EXPANSÃO cair).
--     Os 6330 com expansion=0 já dão scoreExpansao 0 e não precisam de recálculo.
CREATE TEMP TABLE _fcs_fosseis_expansion ON COMMIT DROP AS
  SELECT customer_user_id, farmer_id
  FROM public.farmer_client_scores
  WHERE expansion_score IS NOT NULL AND expansion_score <> 0
    AND customer_user_id IS NOT NULL AND farmer_id IS NOT NULL;

-- (3) Backfill: trocar o 0 fabricado (e o fóssil expansion=60) por NULL honesto.
--     session_replication_role=replica SUPRIME o trigger de enqueue durante o UPDATE em massa. Sem
--     isso, nular expansion_score enfileira as 6.633 linhas (0→null e 60→null são ambos DISTINCT de
--     null) — e a fila drena só 500/noite (visit-score-recalc-batch max_drain:500) = ~14 noites,
--     enterrando os 303 que importam atrás de 6.330 recálculos inúteis; pior, recalcOne marca
--     processed_at MESMO em erro, sem retry, então um fóssil pode se perder (achado Codex xhigh).
--     O WHERE mantém o UPDATE idempotente (2ª execução afeta 0 linhas).
SET LOCAL session_replication_role = replica;

UPDATE public.farmer_client_scores
SET recover_score     = NULL,
    expansion_score   = NULL,
    revenue_potential = NULL,
    x_score           = NULL,
    s_score           = NULL,
    eff_score         = NULL
WHERE recover_score     IS NOT NULL
   OR expansion_score   IS NOT NULL
   OR revenue_potential IS NOT NULL
   OR x_score           IS NOT NULL
   OR s_score           IS NOT NULL
   OR eff_score         IS NOT NULL;

SET LOCAL session_replication_role = origin;

-- (4) Enfileirar SÓ os fósseis capturados (os que mudam de missão), imitando o trigger real
--     (mesmo índice único parcial do ON CONFLICT). Drena em 1 noite (303 < 500), sem atrasar
--     eventos normais nem re-recalcular 6.330 clientes cujo visit_score não muda.
INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
SELECT customer_user_id, farmer_id, 'expansion_orfa_backfill'
FROM _fcs_fosseis_expansion
ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;

COMMIT;

-- ============================================================
-- ia_uso_limite — semeia a cota de `elevenlabs-transcribe`
--
-- PRÉ-REQUISITO do PR fix/ia-cota-elevenlabs-transcribe. A edge passa a chamar
-- `ia_consumir_cota`, que é FAIL-CLOSED por desenho: função sem linha aqui
-- devolve `sem_limite` → a edge responde HTTP 503. Sem este seed, a transcrição
-- de voz PARA em produção assim que a edge for deployada.
-- ORDEM: rodar este SQL ANTES do deploy da edge.
--
-- Limites: transcrição é método de ENTRADA (ditado), não ação deliberada como
-- identify-tool (20/60). 60/hora ≈ uma transcrição por minuto sustentada, bem
-- acima da cadência real de ditado; 300/dia. Folgado de propósito — a edge nunca
-- foi instrumentada, então não há série histórica para calibrar (ia_uso_evento
-- tem 0 eventos em 30 dias, mas só das 3 funções JÁ medidas). O objetivo aqui é
-- LIMITAR o ilimitado sem arriscar quebrar fluxo real; aperte depois de uma
-- semana de dado em ia_uso_evento.
-- ============================================================

INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia)
VALUES ('elevenlabs-transcribe', 60, 300)
ON CONFLICT (funcao) DO NOTHING;

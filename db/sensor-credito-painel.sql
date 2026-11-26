-- Sensor de uso do painel de crédito (crédito-IA PR 8) — ledger, não PostHog (fase-sem-sinal.md).
-- Fonte: `navegacao.rota_servida` do PageViewTracker (1 linha por titular × rota × dia), em
-- analytics_outbox. Denominador: quem PODE abrir (predicado de pode_ver_carteira_completa).
-- ⚠️ analytics_outbox tem `purgar_em`: a janela é a de retenção do outbox, não o histórico inteiro.
-- Rode: ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-credito-painel.sql
SELECT count(DISTINCT o.user_id)                    AS titulares_que_abriram,
       count(*)                                     AS dias_titular_servidos,
       min(o.ocorrido_em)::date                     AS primeiro,
       max(o.ocorrido_em)::date                     AS ultimo,
       -- = corpo de pode_ver_carteira_completa (claude_ro não executa a função)
       (SELECT count(DISTINCT r.user_id) FROM public.user_roles r
         WHERE r.role = 'master'
            OR (r.role = 'employee' AND EXISTS (SELECT 1 FROM public.commercial_roles c
                 WHERE c.user_id = r.user_id
                   AND c.commercial_role IN ('gerencial','estrategico','super_admin')))) AS podem_abrir
  FROM public.analytics_outbox o
 WHERE o.evento = 'navegacao.rota_servida'
   AND o.props ->> 'rota' = '/credito/painel';
SELECT 'SENSOR-CREDITO-PAINEL-OK' AS fim;

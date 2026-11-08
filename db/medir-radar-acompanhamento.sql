-- Medição do pacote G do Radar (acompanhamento depois da ligação). Só leitura, só tabelas: roda no psql-ro (o claude_ro
-- não executa private.*). Provada no PG17 por db/test-radar-acompanhamento-g.sh (G5g).
--
--   ~/.config/afiacao/psql-ro -X -At -v ON_ERROR_STOP=1 -v desde="'2026-11-11'" -f db/medir-radar-acompanhamento.sql
--
-- Sem linha no período = "sem base" (nunca 100% nem 0%): o denominador é a 1ª coluna numérica de cada linha.
--
-- RETORNOS — cada contato com retorno_em é um compromisso. Quem o encerra é o PRÓXIMO contato no mesmo CNPJ (de
-- qualquer autor: a posse pode ter mudado de mão). Regras:
--   reagendado   = o próximo é outro "em conversa" feito ANTES do dia marcado (novo compromisso, não cumprimento);
--   no_prazo     = o próximo veio até o dia marcado + 1 (antecipado conta);
--   atrasado     = o próximo veio depois disso;
--   pendente     = sem próximo e ainda dentro do dia marcado + 1;
--   vencido      = sem próximo e já passou do dia marcado + 1.
-- Desfeito (apagado em ≤ 5 min pelo autor) não aparece: não houve compromisso.
--
-- POSSES — vencida = fechada como 'expirado' no período (o tick diário fecha; a aberta já vencida espera ≤ 1 dia).
-- Avisada por e-mail = um envio ENTREGUE (notificado) ao dono listou ESTE vencimento (mesmo atendimento_id e mesmo
-- expira_em: aviso de um prazo antigo, prorrogado depois, não cobre o novo). Com ≥ 24 h de antecedência é a meta; menos
-- que isso conta à parte. O aviso do card não tem registro server-side (track 'radar.posse_aviso_exibido', censurável).
WITH c AS (
  SELECT c.id, c.cnpj, c.acao, c.retorno_em, c.retorno_origem,
         (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
         (SELECT n.acao FROM public.radar_contatos n
           WHERE n.cnpj = c.cnpj AND n.created_at > c.created_at ORDER BY n.created_at, n.id LIMIT 1) AS prox_acao,
         (SELECT (n.created_at AT TIME ZONE 'America/Sao_Paulo')::date FROM public.radar_contatos n
           WHERE n.cnpj = c.cnpj AND n.created_at > c.created_at ORDER BY n.created_at, n.id LIMIT 1) AS prox_dia
    FROM public.radar_contatos c
   WHERE c.retorno_em IS NOT NULL AND c.created_at >= :desde::timestamptz
), cat AS (
  SELECT c.*,
         CASE WHEN c.prox_dia IS NOT NULL AND c.prox_acao = 'em_conversa' AND c.prox_dia < c.retorno_em THEN 'reagendado'
              WHEN c.prox_dia IS NOT NULL AND c.prox_dia <= c.retorno_em + 1 THEN 'no_prazo'
              WHEN c.prox_dia IS NOT NULL THEN 'atrasado'
              WHEN (now() AT TIME ZONE 'America/Sao_Paulo')::date <= c.retorno_em + 1 THEN 'pendente'
              ELSE 'vencido' END AS situacao
    FROM c
)
SELECT 'retornos', count(*) AS agendados,
       count(*) FILTER (WHERE acao = 'em_conversa') AS em_conversa,
       count(*) FILTER (WHERE acao = 'contatado_sem_resposta') AS nao_atendeu,
       count(*) FILTER (WHERE acao = 'em_conversa' AND retorno_origem = 'vendedor') AS data_do_vendedor,
       count(*) FILTER (WHERE acao = 'em_conversa' AND retorno_origem = 'padrao') AS data_padrao,
       count(*) FILTER (WHERE situacao = 'no_prazo') AS no_prazo,
       count(*) FILTER (WHERE situacao = 'atrasado') AS atrasado,
       count(*) FILTER (WHERE situacao = 'reagendado') AS reagendado,
       count(*) FILTER (WHERE situacao = 'pendente') AS pendente,
       count(*) FILTER (WHERE situacao = 'vencido') AS vencido
  FROM cat;

WITH v AS (
  SELECT a.id, a.cnpj, a.dono_user_id, a.encerrado_em AS expira,
         (SELECT min(e.criado_em) FROM public.radar_email_vendedor_envios e
            JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
           WHERE e.vendedor_user_id = a.dono_user_id AND e.eh_teste = false AND fa.status = 'notificado'
             AND e.criado_em < a.encerrado_em
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.acompanhamento->'posses_vencendo', '[]'::jsonb)) x
                          WHERE (x->>'atendimento_id')::bigint = a.id AND (x->>'expira_em')::timestamptz = a.encerrado_em)
         ) AS avisado_em,
         EXISTS (SELECT 1 FROM public.radar_email_vendedor_config cfg
                  WHERE cfg.vendedor_user_id = a.dono_user_id AND cfg.ativo) AS email_ativo
    FROM public.radar_atendimentos a
   WHERE a.motivo_encerramento = 'expirado' AND a.encerrado_em >= :desde::timestamptz
)
SELECT 'posses', count(*) AS vencidas,
       count(*) FILTER (WHERE avisado_em <= expira - interval '24 hours') AS avisadas_24h,
       count(*) FILTER (WHERE avisado_em > expira - interval '24 hours') AS avisadas_menos_24h,
       count(*) FILTER (WHERE avisado_em IS NULL) AS sem_aviso_email,
       count(*) FILTER (WHERE avisado_em IS NULL AND NOT email_ativo) AS sem_aviso_email_desligado
  FROM v;

-- Sensor da fila "PO a baixar no Omie" (20261120100000_reposicao_po_a_baixar_pares_e_decisao.sql) — READ-ONLY.
--
-- A PERGUNTA que ele responde (fase-sem-sinal: sinal POSITIVO com DENOMINADOR antes de qualquer piloto de escrita):
--   das ocorrências que ENTRARAM na fila (episódios = denominador, com ou sem decisão), quantas a equipe declarou,
--   quantas declarações a RELEITURA confirmou (sombra concluída com vínculo / PO encerrado no Omie), e em quanto tempo
--   o item saiu da fila.
--
-- A interpretação mora AQUI, não no banco: a tabela guarda FATOS da releitura (desfecho_*); mudar a régua de
-- "confirmado" é mudar este arquivo, sem migration.
--   · associei  ↔ confirmado só por NF concluída com vínculo COMPLETO (vínculo parcial NÃO confirma "associei")
--   · encerrei  ↔ confirmado só por PO com encerrado_omie_em (PO que só "deixou de contar" NÃO confirma)
--   · parcial_aguardo_saldo / nao_se_aplica não entram na concordância (não afirmam resolução)
--   · origem 'carga_inicial' = já estava na fila quando o sensor nasceu: idade desconhecida, as durações dela não
--     significam tempo até resolução — o GROUP BY por origem as separa, não as some.
--   · concordância com 0 declarações sai NULL (indefinida), nunca 0% nem 100%.
--
-- Uso: ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-po-a-baixar.sql

WITH ep AS (
  SELECT e.*,
         dv.decisao AS decisao_vigente,
         dv.decidido_em AS decisao_vigente_em,
         d1.primeira_decisao_em,
         CASE
           WHEN e.fechado_em IS NULL THEN 'em_aberto'
           WHEN e.desfecho_lido_em IS NULL THEN 'sem_releitura'
           WHEN e.tipo = 'nf_pendente' AND e.desfecho_estado_nf = 'concluida' AND e.desfecho_vinculo = 'completo' THEN 'nf_vinculada_completa'
           WHEN e.tipo = 'nf_pendente' AND e.desfecho_estado_nf = 'concluida' AND e.desfecho_vinculo = 'parcial' THEN 'nf_vinculada_parcial'
           WHEN e.tipo = 'nf_pendente' AND e.desfecho_estado_nf = 'concluida' THEN 'nf_concluida_sem_vinculo'
           WHEN e.tipo = 'nf_pendente' AND e.desfecho_estado_nf = 'cancelada' THEN 'nf_cancelada'
           WHEN e.tipo = 'nf_pendente' AND e.desfecho_nf_casada_espelho IS TRUE THEN 'nf_casada_no_espelho'
           WHEN e.tipo = 'po_contado_com_nf' AND e.desfecho_po_encerrado_em IS NOT NULL THEN 'po_encerrado_no_omie'
           WHEN e.tipo = 'po_contado_com_nf' THEN 'po_deixou_de_contar_sem_encerrar'
           ELSE 'saiu_sem_desfecho_lido'
         END AS desfecho
    FROM public.reposicao_po_a_baixar_episodio e
    LEFT JOIN LATERAL (
      SELECT d.decisao, d.decidido_em FROM public.reposicao_po_a_baixar_decisao d
       WHERE d.episodio_id = e.id ORDER BY d.id DESC LIMIT 1) dv ON true
    LEFT JOIN LATERAL (
      SELECT min(d.decidido_em) AS primeira_decisao_em FROM public.reposicao_po_a_baixar_decisao d
       WHERE d.episodio_id = e.id) d1 ON true
), juizo AS (
  SELECT ep.*,
         (ep.decisao_vigente IN ('associei', 'encerrei')) IS TRUE AS declarou_resolvido,
         ((ep.decisao_vigente = 'associei' AND ep.desfecho = 'nf_vinculada_completa')
          OR (ep.decisao_vigente = 'encerrei' AND ep.desfecho = 'po_encerrado_no_omie')) IS TRUE AS confirmado
    FROM ep
)
SELECT empresa, tipo, origem,
       count(*) AS elegiveis,
       count(*) FILTER (WHERE desatualizada_na_entrada IS NOT TRUE) AS frescos_na_entrada,
       count(*) FILTER (WHERE fechado_em IS NULL) AS em_aberto,
       count(*) FILTER (WHERE decisao_vigente IS NOT NULL) AS decididos,
       count(*) FILTER (WHERE declarou_resolvido) AS declarados_resolvidos,
       count(*) FILTER (WHERE declarou_resolvido AND desfecho NOT IN ('em_aberto', 'sem_releitura')) AS declarados_verificaveis,
       count(*) FILTER (WHERE confirmado) AS declarados_confirmados,
       round(count(*) FILTER (WHERE confirmado)::numeric
             / nullif(count(*) FILTER (WHERE declarou_resolvido), 0), 3) AS concordancia,
       -- declaração "resolvida" há > 7 d sem confirmação: declaração falsa OU sombra/motor parados (o desfecho diz qual)
       count(*) FILTER (WHERE declarou_resolvido AND NOT confirmado
                          AND decisao_vigente_em < now() - interval '7 days') AS declarados_sem_confirmacao_7d,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM fechado_em - aberto_em) / 3600)
              FILTER (WHERE fechado_em IS NOT NULL))::numeric, 1) AS mediana_h_ate_sair,
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM fechado_em - aberto_em) / 3600)
              FILTER (WHERE fechado_em IS NOT NULL))::numeric, 1) AS p90_h_ate_sair,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM primeira_decisao_em - aberto_em) / 3600)
              FILTER (WHERE primeira_decisao_em IS NOT NULL))::numeric, 1) AS mediana_h_ate_decidir
  FROM juizo
 GROUP BY empresa, tipo, origem
 ORDER BY empresa, tipo, origem;

-- distribuição do desfecho × decisão vigente (de onde vem a discordância)
SELECT e.empresa, e.tipo, e.desfecho, coalesce(e.decisao_vigente, '(sem decisao)') AS decisao_vigente, count(*) AS n
  FROM (
    SELECT x.empresa, x.tipo,
           CASE
             WHEN x.fechado_em IS NULL THEN 'em_aberto'
             WHEN x.desfecho_lido_em IS NULL THEN 'sem_releitura'
             WHEN x.tipo = 'nf_pendente' THEN coalesce(x.desfecho_estado_nf, '?') || '/' || coalesce(x.desfecho_vinculo, '?')
             WHEN x.desfecho_po_encerrado_em IS NOT NULL THEN 'po_encerrado_no_omie'
             ELSE 'po_deixou_de_contar_sem_encerrar'
           END AS desfecho,
           (SELECT d.decisao FROM public.reposicao_po_a_baixar_decisao d WHERE d.episodio_id = x.id ORDER BY d.id DESC LIMIT 1) AS decisao_vigente
      FROM public.reposicao_po_a_baixar_episodio x) e
 GROUP BY 1, 2, 3, 4
 ORDER BY 1, 2, 3, 4;

SELECT 'SENSOR-PO-A-BAIXAR-EXECUTOU' AS marcador;

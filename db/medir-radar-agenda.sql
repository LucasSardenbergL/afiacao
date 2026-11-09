-- Medição do pacote L do Radar (migration 20261111130000): a agenda "Hoje" do /radar e a posse que nasce do contato.
-- Somente leitura. Rode pelo psql-ro:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -v desde="'2026-11-09'" -f db/medir-radar-agenda.sql
-- Saída em linhas `bloco|...` (uma por semana BRT), para ler sem o PostHog (cego para o founder):
--   agenda|semana|vendedores_com_agenda|dias_com_agenda|dias_com_abertura|aberturas|contatos_apos_abertura
--     dias_com_agenda = denominador (o bloco apareceu com algo a fazer); contatos_apos_abertura = contato do MESMO
--     vendedor no CNPJ aberto pela agenda, no mesmo dia, depois da abertura.
--   posses|semana|posses_novas|pelo_contato|pelo_botao_ou_gestor|vendedores_com_posse
--     pelo_contato = criadas pelo auto-assumir de registrar_contato_radar (contato_origem_id, que sobrevive ao contato).
\set ON_ERROR_STOP 1

WITH semanas AS (
  SELECT u.*, date_trunc('week', u.dia)::date AS semana FROM public.radar_agenda_uso u WHERE u.dia >= :desde::date
), abertas AS (
  SELECT s.* FROM semanas s WHERE s.evento = 'aberta'
)
SELECT 'agenda|' || s.semana || '|' ||
       count(DISTINCT s.user_id) FILTER (WHERE s.evento = 'vista') || '|' ||
       count(*) FILTER (WHERE s.evento = 'vista') || '|' ||
       count(DISTINCT (s.user_id, s.dia)) FILTER (WHERE s.evento = 'aberta') || '|' ||
       count(*) FILTER (WHERE s.evento = 'aberta') || '|' ||
       (SELECT count(*) FROM abertas a
         WHERE a.semana = s.semana AND EXISTS (
           SELECT 1 FROM public.radar_contatos c
            WHERE c.cnpj = a.cnpj AND c.criado_por = a.user_id AND c.created_at >= a.criado_em
              AND (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date = a.dia))
  FROM semanas s
 GROUP BY s.semana
 ORDER BY s.semana;

SELECT 'posses|' || date_trunc('week', a.assumido_em AT TIME ZONE 'America/Sao_Paulo')::date || '|' ||
       count(*) || '|' ||
       count(*) FILTER (WHERE a.contato_origem_id IS NOT NULL) || '|' ||
       count(*) FILTER (WHERE a.contato_origem_id IS NULL) || '|' ||
       count(DISTINCT a.dono_user_id)
  FROM public.radar_atendimentos a
 WHERE a.assumido_em >= (:desde::date)::timestamp AT TIME ZONE 'America/Sao_Paulo'
 GROUP BY date_trunc('week', a.assumido_em AT TIME ZONE 'America/Sao_Paulo')
 ORDER BY date_trunc('week', a.assumido_em AT TIME ZONE 'America/Sao_Paulo');

SELECT 'FIM_MEDICAO';

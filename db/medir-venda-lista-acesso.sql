-- Medição do sensor de abertura da lista do Meu Dia (20261028220003) — read-only.
--   ~/.config/afiacao/psql-ro -X -A -v ON_ERROR_STOP=1 -v desde="'2026-10-29'" -f db/medir-venda-lista-acesso.sql
-- Uma linha por farmer × dia: a lista que o gerador montou (fase ativa) × o que a farmer LEU.
--   nao_leu      = havia lista e nenhuma leitura da própria farmer (sem linha no sensor)
--   leu          = leu; compradores_vistos = o que a ÚLTIMA leitura do dia devolveu
--   leu_vazia    = leu e a RPC devolveu 0 compradores
--   leu_sem_lista= employee leu num dia em que o gerador não montou lista para ela
-- claude_ro tem BYPASSRLS: 0 linhas no sensor é 0 de verdade, não RLS escondendo.
WITH lista AS (
  SELECT s.farmer_user_id, s.dia_referencia AS dia, count(DISTINCT s.comprador_id) AS compradores_na_lista
    FROM public.venda_sugestao s
   WHERE s.fase = 'ativa' AND s.dia_referencia >= :desde::date
   GROUP BY 1, 2
), acesso AS (
  SELECT * FROM public.venda_lista_acesso a WHERE a.dia >= :desde::date
)
SELECT COALESCE(l.dia, a.dia) AS dia,
       COALESCE(pr.nome, COALESCE(l.farmer_user_id, a.farmer_user_id)::text) AS farmer,
       CASE WHEN a.farmer_user_id IS NULL THEN 'nao_leu'
            WHEN l.farmer_user_id IS NULL THEN 'leu_sem_lista'
            WHEN a.n_compradores = 0      THEN 'leu_vazia'
            ELSE 'leu' END AS estado,
       l.compradores_na_lista,
       a.n_compradores AS compradores_vistos,
       a.n_leituras,
       to_char(a.primeira_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS primeira_brt,
       to_char(a.ultima_em   AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') AS ultima_brt
  FROM lista l
  FULL JOIN acesso a ON a.farmer_user_id = l.farmer_user_id AND a.dia = l.dia
  LEFT JOIN LATERAL (
    SELECT COALESCE(p.name, p.razao_social) AS nome FROM public.profiles p
     WHERE p.user_id = COALESCE(l.farmer_user_id, a.farmer_user_id) ORDER BY p.created_at LIMIT 1) pr ON true
 ORDER BY 1, 2;

-- censo-like-cru-prod.sql — a classe pattern-like-cru nas funções VIVAS da prod (docs/historico/like-cru-camada-sql.md).
--
--   ~/.config/afiacao/psql-ro -q -A -v ON_ERROR_STOP=1 -f db/censo-like-cru-prod.sql
--
-- O gate scripts/like-cru-em-migrations-gate.ts lê as migrations e não vê função criada só em prod
-- (pelo SQL Editor ou pelo builder do Lovable, sem CREATE no repo) — foi assim que listar_skus e os dois
-- expandir_promocao_item viveram até 20260929000234. Este censo cobre esse limite, sob demanda.
--
-- O que lista: toda função de schema não-sistema com LIKE/ILIKE/~~/SIMILAR TO cujo lado direito NÃO é
-- literal e NÃO é o idioma (`private.padrao_like_contem(…) ESCAPE '\'`). A assinatura é o LADO DIREITO,
-- não "tem || perto do LIKE": a de 2026-09-27 perdia `ILIKE v_fornecedor` e casava o já-correto.
-- É regex sobre prosrc: LIKE em comentário ou literal também aparece (o _data_health_compute). O gate
-- tem o lexer; aqui a triagem é humana.
--
-- Esperado depois da 20260929000234 (medido em 2026-09-29): os 3 vivos permitidos do gate
-- (radar_atribuir_tarefa, radar_contagem_por_municipio, reposicao_alerta_pedido_minimo_tick), o texto do
-- _data_health_compute, e código da plataforma (storage.*, realtime.*). Qualquer outra linha é sítio novo.
WITH f AS (
  SELECT n.nspname, p.proname, p.prosrc
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
     AND p.prokind IN ('f', 'p')
     AND p.prosrc ~* '(\mi?like\M|~~|\msimilar\s+to\M)'
), sitios AS (
  SELECT f.nspname, f.proname, lower(m[1]) AS op, regexp_replace(m[2], '\s+', ' ', 'g') AS rhs
    FROM f
   CROSS JOIN LATERAL regexp_matches(f.prosrc, '(\mi?like\M|~~\*?|\msimilar\s+to\M)\s*((?:any|all)?\s*\(?[^;]{0,120})', 'gi') AS m
), classe AS (
  SELECT *, CASE
      WHEN rhs ~* '^\(?\s*private\.padrao_like_contem\s*\((?:[^()]|\([^()]*\))*\)\)?\s+escape\s+''\\''' THEN 'idioma'
      WHEN rhs ~ '^\(?\s*''[^'']*''\s*(::\s*[a-z ]+)?\)?\s*\|\|' THEN 'concatenação'
      WHEN rhs ~ '^\(?\s*''' THEN 'literal'
      ELSE 'valor'
    END AS veredito
    FROM sitios
)
SELECT nspname || '.' || proname AS funcao, veredito, op, left(rhs, 90) AS lado_direito
  FROM classe
 WHERE veredito IN ('concatenação', 'valor')
 ORDER BY 1, 3;
SELECT 'FIM_CENSO_LIKE_CRU_OK' AS marcador;

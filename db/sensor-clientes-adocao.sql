-- ============================================================================================
-- SENSOR — adoção da tela Clientes (lista, 360 e Cadastro), COM denominador. Read-only.
--
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql
--
-- Pergunta: dos que ABRIRAM cada superfície (denominador, por papel comercial), quantos usaram cada ação,
-- em quantos dias úteis, e quantas tentativas viraram sucesso? É a régua da fase seguinte —
-- docs/historico/fase-sem-sinal.md.
--
-- Onda C (2026-11-24) corrigiu o denominador: antes TODA ação (inclusive as da 360) era dividida por
-- "abriu /admin/customers%", um saco que misturava lista, Cadastro e 360 — e a 360 também abre de Meu
-- dia, agenda e telefonia. Agora cada superfície tem o PRÓPRIO denominador (a rota canônica servida),
-- o papel é o COMERCIAL (farmer/hunter/closer/master — commercial_roles; o app_role junto) e a régua é
-- "usou em N de M dias úteis", que separa hábito de curiosidade de um dia.
--
-- Fonte: public.analytics_outbox (ledger; eventos `clientes.*` e `navegacao.rota_servida`). O ledger
-- DEDUPA por titular × evento × chave × dia UTC: as contagens são USUÁRIOS e USUÁRIO-DIAS, nunca cliques.
-- ⚠️ Retenção curta: linha drenada é purgada ~7 dias depois (purgar_em). Ausente ≠ não usou — fora da
-- janela não há dado. Rode dentro da janela e guarde o resultado no PR/histórico se precisar de série.
-- ⚠️ Sob a lente "Ver como" o front não grava (isLensActive): inspeção não infla o denominador.
-- ⚠️ `ficha_acao` antes da onda C não tinha `fase` (era só o toque) nem a superfície `lista`: sem `fase`
-- conta como 'tentativa'. Desfecho da 360 antes da onda C era o TOQUE; depois, só a gravação confirmada.
-- ⚠️ Rota canônica da 360: a máscara de `analytics-rota-canonica.ts` trata segmento só de dígitos como
-- identificador, então "/admin/customers/<uuid>/360" chega como '/admin/customers/:id/:id'. As duas formas
-- são aceitas (se um dia o "360" entrar no alfabeto estático, nada quebra aqui).
-- Dia útil = segunda a sexta no fuso de São Paulo (sem calendário de feriado: feriado conta como útil,
-- o que só pode SUBESTIMAR a régua — nunca inflá-la).
-- ============================================================================================

-- 0) JANELA observada no ledger (M = dias úteis dela). Sem dado, o resto sai vazio — não "zero uso".
SELECT 'janela' AS secao,
       min((o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date) AS desde,
       max((o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date) AS ate,
       (SELECT count(*) FROM generate_series(
          min((o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date),
          max((o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date), interval '1 day') d
        WHERE extract(isodow FROM d) < 6) AS dias_uteis
FROM public.analytics_outbox o
WHERE o.evento LIKE 'clientes.%' OR o.evento = 'navegacao.rota_servida';

-- 1) DENOMINADOR — quem abriu CADA superfície, por papel comercial.
WITH papel AS (
  SELECT u.user_id,
         (array_agg(u.role::text ORDER BY CASE u.role::text WHEN 'master' THEN 1 WHEN 'employee' THEN 2 ELSE 3 END))[1] AS app_role
  FROM public.user_roles u GROUP BY u.user_id
), comercial AS (
  SELECT user_id, commercial_role::text AS papel_comercial FROM public.commercial_roles
), abriu AS (
  SELECT DISTINCT o.user_id,
         CASE WHEN o.evento = 'clientes.lista_aberta' THEN 'lista'
              WHEN o.props->>'rota' = '/admin/customers' THEN 'lista'
              WHEN o.props->>'rota' IN ('/admin/customers/:id/:id', '/admin/customers/:id/360') THEN '360'
              WHEN o.props->>'rota' = '/admin/customers/:id' THEN 'cadastro'
         END AS superficie,
         (o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL
    AND (o.evento = 'clientes.lista_aberta'
         OR (o.evento = 'navegacao.rota_servida'
             AND o.props->>'rota' IN ('/admin/customers', '/admin/customers/:id', '/admin/customers/:id/:id', '/admin/customers/:id/360')))
)
SELECT 'denominador' AS secao, a.superficie,
       coalesce(c.papel_comercial, 'sem_papel_comercial') AS papel_comercial,
       coalesce(p.app_role, 'sem_papel') AS app_role,
       count(DISTINCT a.user_id) AS usuarios,
       count(DISTINCT (a.user_id, a.dia)) AS usuario_dias,
       min(a.dia) AS desde, max(a.dia) AS ate
FROM abriu a LEFT JOIN papel p USING (user_id) LEFT JOIN comercial c USING (user_id)
GROUP BY 2, 3, 4 ORDER BY 2, 3, 4;

-- 2) ADOÇÃO por superfície × ação × fase: usuários que fizeram ÷ usuários que ABRIRAM aquela superfície
--    (mesmo papel comercial). A lista também conta `cliente_aberto` (abrir a 360 a partir dela).
WITH comercial AS (
  SELECT user_id, commercial_role::text AS papel_comercial FROM public.commercial_roles
), abriu AS (
  SELECT DISTINCT o.user_id,
         CASE WHEN o.evento = 'clientes.lista_aberta' OR o.props->>'rota' = '/admin/customers' THEN 'lista'
              WHEN o.props->>'rota' IN ('/admin/customers/:id/:id', '/admin/customers/:id/360') THEN '360'
              ELSE 'cadastro' END AS superficie
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL
    AND (o.evento = 'clientes.lista_aberta'
         OR (o.evento = 'navegacao.rota_servida'
             AND o.props->>'rota' IN ('/admin/customers', '/admin/customers/:id', '/admin/customers/:id/:id', '/admin/customers/:id/360')))
), den AS (
  SELECT a.superficie, coalesce(c.papel_comercial, 'sem_papel_comercial') AS papel_comercial, count(DISTINCT a.user_id) AS n
  FROM abriu a LEFT JOIN comercial c USING (user_id) GROUP BY 1, 2
), acoes AS (
  SELECT o.user_id,
         CASE WHEN o.evento = 'clientes.ficha_acao' THEN o.props->>'ficha' ELSE 'lista' END AS superficie,
         CASE WHEN o.evento = 'clientes.ficha_acao' THEN o.props->>'tipo' ELSE 'abrir_360' END AS tipo,
         CASE WHEN o.evento = 'clientes.ficha_acao' THEN coalesce(o.props->>'fase', 'tentativa') ELSE 'tentativa' END AS fase,
         (o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL AND o.evento IN ('clientes.ficha_acao', 'clientes.cliente_aberto')
), uso AS (
  SELECT x.superficie, x.tipo, x.fase, coalesce(c.papel_comercial, 'sem_papel_comercial') AS papel_comercial,
         count(DISTINCT x.user_id) AS usuarios, count(DISTINCT (x.user_id, x.dia)) AS usuario_dias
  FROM acoes x LEFT JOIN comercial c USING (user_id) GROUP BY 1, 2, 3, 4
)
SELECT 'adocao' AS secao, u.superficie, u.tipo, u.fase, u.papel_comercial,
       u.usuarios, d.n AS denominador, u.usuario_dias,
       -- Sem denominador (ação de quem nunca teve a rota servida na janela): NULL, nunca um % inventado.
       CASE WHEN d.n > 0 THEN round(100.0 * u.usuarios / d.n, 0) END AS pct_usuarios
FROM uso u LEFT JOIN den d ON d.superficie = u.superficie AND d.papel_comercial = u.papel_comercial
ORDER BY u.superficie, u.papel_comercial, u.tipo, u.fase;

-- 3) FUNIL tentativa → sucesso (ligar = atendida; novo_pedido = pedido enviado; ver_pedidos = feed do
--    cliente lido). Em USUÁRIO-DIAS: dia com sucesso sem tentativa registrada é possível (dedup por dia)
--    e aparece como está — não se força o sucesso ≤ tentativa.
WITH x AS (
  SELECT o.user_id, o.props->>'ficha' AS superficie, o.props->>'tipo' AS tipo,
         coalesce(o.props->>'fase', 'tentativa') AS fase,
         (o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
  FROM public.analytics_outbox o
  WHERE o.evento = 'clientes.ficha_acao' AND o.user_id IS NOT NULL
)
SELECT 'funil' AS secao, superficie, tipo,
       count(DISTINCT (user_id, dia)) FILTER (WHERE fase = 'tentativa') AS dias_tentativa,
       count(DISTINCT (user_id, dia)) FILTER (WHERE fase = 'sucesso') AS dias_sucesso
FROM x WHERE tipo IN ('ligar', 'novo_pedido', 'ver_pedidos', 'registrar_desfecho')
GROUP BY 2, 3 ORDER BY 2, 3;

-- 4) RÉGUA "usou em N de M dias úteis" — por usuário (id pseudonimizado) × superfície.
--    N = dias úteis com alguma AÇÃO naquela superfície; M = dias úteis da janela observada.
WITH comercial AS (
  SELECT user_id, commercial_role::text AS papel_comercial FROM public.commercial_roles
), janela AS (
  SELECT min((ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date) AS ini,
         max((ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date) AS fim
  FROM public.analytics_outbox WHERE evento LIKE 'clientes.%' OR evento = 'navegacao.rota_servida'
), m AS (
  SELECT count(*) AS dias_uteis FROM janela j, generate_series(j.ini, j.fim, interval '1 day') d
  WHERE extract(isodow FROM d) < 6
), acoes AS (
  SELECT o.user_id,
         CASE WHEN o.evento = 'clientes.ficha_acao' THEN o.props->>'ficha' ELSE 'lista' END AS superficie,
         (o.ocorrido_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL AND o.evento IN ('clientes.ficha_acao', 'clientes.cliente_aberto')
)
SELECT 'regua_dias_uteis' AS secao, a.superficie,
       coalesce(c.papel_comercial, 'sem_papel_comercial') AS papel_comercial,
       left(md5(a.user_id::text), 8) AS usuario,
       count(DISTINCT a.dia) FILTER (WHERE extract(isodow FROM a.dia) < 6) AS n_dias_uteis_com_uso,
       (SELECT dias_uteis FROM m) AS m_dias_uteis
FROM acoes a LEFT JOIN comercial c USING (user_id)
GROUP BY 2, 3, 4 ORDER BY 2, 3, 5 DESC;

-- 5) DETALHE da LISTA — com qual valor: modo de abertura, troca de modo, filtro, posição do clique, páginas.
SELECT 'detalhe_lista' AS secao, o.evento,
       CASE o.evento
         WHEN 'clientes.lista_aberta'     THEN o.props->>'modo'
         WHEN 'clientes.busca_usada'      THEN o.props->>'modo'
         WHEN 'clientes.modo_trocado'     THEN (o.props->>'de') || '>' || (o.props->>'para') || ' (' || coalesce(o.props->>'origem', '?') || ')'
         WHEN 'clientes.filtro_saude'     THEN (o.props->>'modo') || ':' || (o.props->>'valor')
         WHEN 'clientes.cliente_aberto'   THEN (o.props->>'modo') || ':' ||
              CASE WHEN coalesce(o.props->>'posicao', '') !~ '^[0-9]{1,6}$' THEN 'pos_ausente'
                   WHEN (o.props->>'posicao')::int <= 10 THEN 'pos_01_10'
                   WHEN (o.props->>'posicao')::int <= 50 THEN 'pos_11_50'
                   ELSE 'pos_51_mais' END
         WHEN 'clientes.pagina_carregada' THEN (o.props->>'modo') || ':pag_' || (o.props->>'pagina')
         -- `carteira_prioridade` em lista_aberta/cliente_aberto é a VENDEDORA usando a priorização.
       END AS valor,
       count(DISTINCT o.user_id) AS usuarios,
       count(*) AS linhas
FROM public.analytics_outbox o
WHERE o.evento LIKE 'clientes.%' AND o.evento <> 'clientes.ficha_acao'
GROUP BY 2, 3 ORDER BY 2, 3;

SELECT 'FIM_ADOCAO_OK' AS fim;

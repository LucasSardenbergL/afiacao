-- ============================================================================================
-- SENSOR — adoção da tela Clientes (/admin/customers), COM denominador. Read-only.
--
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/sensor-clientes-adocao.sql
--
-- Pergunta: dos que ABRIRAM a tela (denominador, por papel), quantos usaram cada coisa entregue no
-- programa #4027…#4065 (Priorizar contatos × A–Z, filtro de saúde, busca, abrir cliente, carregar mais)?
-- É a régua da fase seguinte (atalhos "Em risco" / "Primeira compra") — docs/historico/fase-sem-sinal.md.
--
-- Fonte: public.analytics_outbox (ledger; eventos `clientes.*` e `navegacao.rota_servida`). O ledger
-- DEDUPA por titular × evento × chave × dia UTC: as contagens são USUÁRIOS e USUÁRIO-DIAS, nunca cliques.
-- ⚠️ Retenção curta: linha drenada é purgada ~7 dias depois (purgar_em). Ausente ≠ não usou — fora da
-- janela não há dado. Rode dentro da janela e guarde o resultado no PR/histórico se precisar de série.
-- ⚠️ Sob a lente "Ver como" o front não grava (isLensActive): inspeção não infla o denominador.
-- Papel: o mais alto em user_roles (master > employee > customer); sem linha = 'sem_papel'.
-- ============================================================================================

-- 1) DENOMINADOR — quem abriu a tela, por papel (rota servida OU lista montada).
WITH papel AS (
  SELECT user_id,
         (array_agg(role::text ORDER BY CASE role::text WHEN 'master' THEN 1 WHEN 'employee' THEN 2 ELSE 3 END))[1] AS papel
  FROM public.user_roles GROUP BY user_id
), abriu AS (
  SELECT DISTINCT o.user_id, (o.ocorrido_em AT TIME ZONE 'UTC')::date AS dia
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL
    AND ((o.evento = 'navegacao.rota_servida' AND o.props->>'rota' LIKE '/admin/customers%')
         OR o.evento = 'clientes.lista_aberta')
)
SELECT 'denominador' AS secao,
       coalesce(p.papel, 'sem_papel') AS papel,
       count(DISTINCT a.user_id) AS usuarios,
       count(*) AS usuario_dias,
       min(a.dia) AS desde,
       max(a.dia) AS ate
FROM abriu a LEFT JOIN papel p USING (user_id)
GROUP BY 2 ORDER BY 2;

-- 2) ADOÇÃO por evento e papel: usuários que usaram ÷ usuários que abriram (mesmo papel).
WITH papel AS (
  SELECT user_id,
         (array_agg(role::text ORDER BY CASE role::text WHEN 'master' THEN 1 WHEN 'employee' THEN 2 ELSE 3 END))[1] AS papel
  FROM public.user_roles GROUP BY user_id
), abriu AS (
  SELECT DISTINCT o.user_id
  FROM public.analytics_outbox o
  WHERE o.user_id IS NOT NULL
    AND ((o.evento = 'navegacao.rota_servida' AND o.props->>'rota' LIKE '/admin/customers%')
         OR o.evento = 'clientes.lista_aberta')
), den AS (
  SELECT coalesce(p.papel, 'sem_papel') AS papel, count(*) AS n
  FROM abriu a LEFT JOIN papel p USING (user_id) GROUP BY 1
), eventos(evento) AS (
  VALUES ('clientes.lista_aberta'), ('clientes.modo_trocado'), ('clientes.filtro_saude'),
         ('clientes.busca_usada'), ('clientes.cliente_aberto'), ('clientes.pagina_carregada'),
         ('clientes.ficha_acao')
), uso AS (
  SELECT o.evento, coalesce(p.papel, 'sem_papel') AS papel,
         count(DISTINCT o.user_id) AS usuarios,
         count(DISTINCT (o.user_id, (o.ocorrido_em AT TIME ZONE 'UTC')::date)) AS usuario_dias
  FROM public.analytics_outbox o LEFT JOIN papel p USING (user_id)
  WHERE o.evento LIKE 'clientes.%' AND o.user_id IS NOT NULL
  GROUP BY 1, 2
)
SELECT e.evento, d.papel,
       coalesce(u.usuarios, 0) AS usuarios,
       d.n AS denominador,
       coalesce(u.usuario_dias, 0) AS usuario_dias,
       round(100.0 * coalesce(u.usuarios, 0) / d.n, 0) AS pct_usuarios
FROM eventos e CROSS JOIN den d
LEFT JOIN uso u ON u.evento = e.evento AND u.papel = d.papel
ORDER BY d.papel, e.evento;

-- 3) DETALHE — com qual valor: modo de abertura, troca de modo, filtro de saúde, posição do clique, páginas.
SELECT o.evento,
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
         -- Onda 1: ação a partir da ficha (ficha:tipo). `carteira_prioridade` em lista_aberta/cliente_aberto
         -- é a VENDEDORA usando a priorização; `carteira` (sem sufixo) é o A–Z de antes da onda 1.
         WHEN 'clientes.ficha_acao'       THEN (o.props->>'ficha') || ':' || (o.props->>'tipo')
       END AS valor,
       count(DISTINCT o.user_id) AS usuarios,
       count(*) AS linhas
FROM public.analytics_outbox o
WHERE o.evento LIKE 'clientes.%'
GROUP BY 1, 2 ORDER BY 1, 2;

SELECT 'FIM_ADOCAO_OK' AS fim;

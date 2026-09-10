-- PASSO 1 — dispara as 1 edge(s) baratas da leva. É o bloco do FOUNDER: lê o
--          vault e faz INSERT, e o wrapper read-only recusa os dois.
-- Ele DEVOLVE o passo 2 já escrito, com o mapa edge→id dentro: copie a célula inteira.
WITH alvos(edge) AS (VALUES
  ('omie-desconto-backfill')
),
disparos AS (
  SELECT a.edge,
         net.http_post(
           url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/' || a.edge,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                               WHERE name = 'CRON_SECRET' LIMIT 1)),
           body := jsonb_build_object('probe', true),
           timeout_milliseconds := 20000) AS request_id
  FROM alvos a
),
mapa AS (
  -- O par (edge, id) é agregado na MESMA execução que disparou: o request_id nunca existe
  -- solto, e por isso não há como colá-lo na linha da edge errada.
  SELECT jsonb_object_agg(edge, request_id)::text AS ids FROM disparos
)
-- O PASSO 2 sai ESCRITO na célula abaixo, com o mapa já dentro. Copie a célula
-- INTEIRA e rode/entregue como está: não há número a anotar nem campo a preencher.
SELECT format($sonda$
-- PASSO 2 — lê e julga. O mapa edge→id já está EMBUTIDO aqui, escrito pelo passo
--          1: nada a colar. Espere ~10s pela resposta HTTP. É SELECT puro —
--          roda no read-only: cole no chat, ou em ~/.config/afiacao/psql-ro
WITH esperado(edge, versao_esperada, fonte_esperada) AS (VALUES
  ('omie-desconto-backfill', 'v1.1-unicidade-no-universo-completo', 'e6fefcf6e87b93f2dc054580bbeea645760d76f765345d6d49bbe05f1a18d368')
),
recentes AS (
  -- A JANELA. O filtro textual roda ANTES do cast de propósito: um corpo não-JSON no meio da
  -- janela abortaria a consulta inteira (mesma defesa da irmã passiva, pendencias-deploy.ts).
  SELECT r.id, r.created, r.status_code,
         COALESCE(r.content::jsonb -> 'data', r.content::jsonb) AS corpo
  FROM net._http_response r
  WHERE r.created > now() - interval '20 minutes'
    AND r.status_code IS NOT NULL
    AND r.content IS NOT NULL
    AND left(ltrim(r.content), 1) = '{'
),
ids AS (
  -- EMBUTIDO pelo passo 1 — o mapa `edge → request_id` foi escrito pelo próprio banco
  -- no disparo (format()), então aqui não há nada a colar nem a redigitar. É ele que separa a
  -- causa (c) do INDETERMINADO: PRE-SENSOR e recusa HTTP respondem SEM eco do slug, mas TÊM id.
  SELECT chave AS edge, valor::bigint AS request_id
  FROM jsonb_each_text(%1$L::jsonb) AS t(chave, valor)
),
controle_credencial AS (
  -- Controle de CREDENCIAL: o 401 acima é ambíguo (bundle velho × CRON_SECRET inválido) e só
  -- vira veredito determinado se ESTE bloco provar que o secret do vault está sendo ACEITO
  -- agora. Lê a MESMA tabela do LEFT JOIN de cima de propósito: não acrescenta superfície de
  -- permissão nova (se desse 'permission denied' o bloco inteiro já teria falhado), e um
  -- controle que exige privilégio a mais viraria INDETERMINADO por acidente de ACL.
  SELECT count(*) FILTER (WHERE r.status_code BETWEEN 200 AND 299) AS ok_recentes,
         count(*) FILTER (WHERE r.status_code = 401)               AS recusas_recentes
  FROM net._http_response r
  WHERE r.created > now() - interval '6 hours'
    -- A própria leva não pode se avalizar: sem isto, o 401 que estamos julgando entra na
    -- contagem de recusas e o controle se auto-envenena (nenhum 401 seria explicável nunca).
    -- NOT EXISTS, não NOT IN: a trava fechada do bloco caro devolve request_id NULL, e
    -- `NOT IN` com NULL é NULL-blind — zeraria o controle inteiro em silêncio.
    -- ⚠️ Com o mapa EMBUTIDO o `ids` nunca está vazio, e é isso que faz esta exclusão valer: o
    --    401 desta leva não entra na contagem de recusas contra si mesmo, e o veredito do 401
    --    pode sair DETERMINADO — o que com o `ids` vazio era impossível.
    AND NOT EXISTS (SELECT 1 FROM ids id_leva WHERE id_leva.request_id = r.id)
    -- ⚠️ O que este controle NAO fecha: ele é HISTORICO. Prova que ALGUM trafego recente
    --    passou, nao que ESTA leva mandou a credencial certa — e nao diz qual credencial
    --    autenticou os 2xx que ele contou. Duas manifestacoes da mesma limitacao:
    --    (a) CRON_SECRET trocado ha poucos minutos E nenhum cron rodado desde a troca — o
    --        trafego 2xx da janela usou o secret ANTIGO e avaliza indevidamente;
    --    (b) o proprio disparo mandando header errado — a leva toma 401, os ids dela ficam
    --        FORA da contagem, e o controle segue verde avalizando um transporte quebrado.
    --    Nos dois casos o veredito determinado abaixo sai CONFIANTE e errado. Na proxima
    --    execucao dos crons (a) vira 401 e o controle se desqualifica sozinho; (b) nao se
    --    corrige sozinho — e por isso os headers sao vigiados no gerador, pela suite.
    --    Se voce ACABOU de mexer no vault, trate o veredito determinado como INDETERMINADO.
),
lidas AS (
  SELECT e.edge, e.versao_esperada, e.fonte_esperada,
         COALESCE(s.id, i.request_id) AS request_id,
         COALESCE(s.status_code, x.status_code) AS status_code,
         COALESCE(s.corpo,
                  CASE WHEN x.content IS NOT NULL AND left(ltrim(x.content), 1) = '{'
                       THEN COALESCE(x.content::jsonb -> 'data', x.content::jsonb)
                  END) AS corpo
  FROM esperado e
  LEFT JOIN LATERAL (
    SELECT rr.id, rr.status_code, rr.corpo
    FROM recentes rr
    WHERE rr.corpo ->> 'edge' = e.edge
      AND rr.corpo ->> 'probe' = 'true'
    ORDER BY rr.created DESC, rr.id DESC
    LIMIT 1
  ) s ON true
  LEFT JOIN ids i ON i.edge = e.edge
  LEFT JOIN net._http_response x ON x.id = i.request_id
)
SELECT l.edge,
       l.request_id,
       l.status_code,
       l.corpo ->> 'edge'   AS edge_respondida,
       l.corpo ->> 'versao' AS versao_respondida,
       l.versao_esperada,
       l.corpo ->> 'fonte'  AS fonte_respondida,
       CASE
         WHEN l.request_id IS NULL
           THEN 'INDETERMINADO — esta edge não tem request_id no mapa embutido NEM eco de sonda na janela de 20 min. Isto é ausência de dado, não veredito negativo: ou a trava do passo 1 ficou FECHADA e nada foi disparado, ou a célula veio de OUTRA leva — confira se os nomes das edges batem'
         WHEN l.status_code IS NULL
           THEN 'AGUARDE — o request_id embutido pelo passo 1 ainda não tem resposta HTTP (leva ~10s); rode este passo de novo'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
              AND c.ok_recentes >= 10 AND c.recusas_recentes = 0
           THEN 'BUNDLE VELHO (pre-sonda) — 401, e o CRON_SECRET esta PROVADO bom agora (' ||
                c.ok_recentes || ' resposta(s) 2xx e ZERO 401 fora desta leva em 6h), ' ||
                'logo a recusa e da EDGE: nada executou'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
           THEN 'INDETERMINADO — 401 nao separa bundle velho de CRON_SECRET invalido, e o ' ||
                'controle de credencial NAO foi observado (2xx fora da leva em 6h: ' ||
                c.ok_recentes || ', recusas 401: ' || c.recusas_recentes || '). Confira o ' ||
                'CRON_SECRET no vault ANTES de redeployar — nao ha prova de bundle velho aqui. ' ||
                'O mapa embutido ja exclui esta leva do controle, entao o que falta e ' ||
                'TRAFEGO de fundo: 2xx fora da leva abaixo do piso de 10 em 6h'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400
           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'
         WHEN l.corpo ->> 'versao' IS NULL
           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'
         WHEN l.corpo ->> 'probe' IS DISTINCT FROM 'true'
           THEN 'NAO E RESPOSTA DE SONDA — o corpo tem versao mas NAO tem probe:true, entao ' ||
                'e a execucao REAL desta edge (cron), nao a sonda: nao ha veredito de deploy ' ||
                'aqui. ' || 'O mapa veio embutido, logo o id e do disparo desta celula: ou a celula e de OUTRA leva/sessao, ou esta edge respondeu o fluxo real.' || ' Respondeu versao=' ||
                COALESCE(l.corpo ->> 'versao', '?') || ' (esperado ' || l.versao_esperada || ')'
         WHEN NOT (l.corpo ? 'fonte')
           THEN 'PRE_SONDA_FONTE — respondeu a sonda (200 + probe) e o corpo NAO TEM o campo ' ||
                'fonte: o bundle no ar e ANTERIOR ao #1998, que criou o campo. E deploy ANTIGO ' ||
                'INTEIRO, nao parcial — nao procure prompt que nomeou poucos arquivos. ' ||
                'Respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||
                ' (esperado ' || l.versao_esperada || '). PRECISA DEPLOY'
         WHEN l.corpo ->> 'fonte' = 'nao-mapeada'
           THEN 'DEPLOY PARCIAL — subiu index.ts+versao.ts, mas _shared/sonda-fingerprints.ts NAO'
         WHEN l.corpo ->> 'versao' = l.versao_esperada
              AND l.corpo ->> 'fonte' = l.fonte_esperada
              AND l.corpo ->> 'probe' = 'true'
              AND l.corpo ->> 'edge' = l.edge
           THEN 'DEPLOY CONFIRMADO'
         ELSE 'BUNDLE VELHO — respondeu versao=' || COALESCE(l.corpo ->> 'versao', '?') ||
              ', fonte=' || COALESCE(l.corpo ->> 'fonte', '?') ||
              ', edge=' || COALESCE(l.corpo ->> 'edge', '?') ||
              ' (esperado ' || l.versao_esperada || ' / ' || l.fonte_esperada || ')'
       END AS veredito
FROM lidas l CROSS JOIN controle_credencial c
ORDER BY l.edge;
$sonda$, m.ids) AS passo_2_copie_esta_celula
FROM mapa m;

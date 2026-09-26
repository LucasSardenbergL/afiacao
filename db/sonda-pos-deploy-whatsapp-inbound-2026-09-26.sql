-- PASSO 1 — dispara as 1 edge(s) baratas da leva. Exige ESCRITA: lê o vault e
--          faz INSERT, e o wrapper read-only recusa os dois — o que NÃO é o mesmo que
--          "só o founder consegue". Caminho da SESSÃO: commite este .sql em db/ e rode
--          `bun run db:aplicar db/<arquivo>.sql` (`--ensaio` antes) — o envelope, com
--          sha256, ledger e marcador de fim. Colar no SQL Editor do Lovable é o
--          FALLBACK: de quem só tem o psql-ro (docs/agent/database.md §"o ENVELOPE").
-- Ele DEVOLVE o passo 2 já escrito, com o mapa edge→id dentro: copie a saída inteira — a
-- célula do SQL Editor, ou o log que o db:aplicar aponta no fim.
WITH alvos(edge) AS (VALUES
  ('whatsapp-inbound')
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
  ('whatsapp-inbound', 'v1.0-sensor-inicial', 'e2386801525315a52f0c06fae2c6055f846f4a877b157a9627e19f7811acb315')
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
    --    401 desta leva não entra na contagem de recusas contra si mesmo. Quem DETERMINA o
    --    veredito do 401, porém, é o `controle_ativo` abaixo — este aqui só dá contexto.
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
         i.request_id,
         x.status_code,
         x.created,
         x.error_msg AS erro_transporte,
         CASE WHEN x.content IS NOT NULL AND left(ltrim(x.content), 1) = '{'
              THEN COALESCE(x.content::jsonb -> 'data', x.content::jsonb)
         END AS corpo
  FROM esperado e
  LEFT JOIN ids i ON i.edge = e.edge
  LEFT JOIN net._http_response x ON x.id = i.request_id
),
controle_ativo AS (
  -- Controle ATIVO: a prova de credencial ATRIBUÍDA a ESTA leva. O histórico acima conta
  -- tráfego de FORA e não sabe qual credencial autenticou os 2xx que contou; este conta as
  -- respostas DESTES request_ids. Testemunha é IDENTIDADE, não status: exige o eco da sonda
  -- com `versao` E `fonte` ESPERADAS — aí o bundle no ar é VERBATIM o do repo, e no repo o
  -- gate autentica antes de responder. Um 200 anônimo (bundle histórico que ignora a
  -- credencial e roda o fluxo real) NÃO é testemunha, e é por isso que 2xx não basta.
  SELECT count(*)                                            AS disparos_na_leva,
         count(*) FILTER (WHERE l.status_code BETWEEN 200 AND 299
                            AND l.created > now() - interval '20 minutes'
                            AND l.corpo ->> 'probe'  = 'true'
                            AND l.corpo ->> 'edge'   = l.edge
                            AND l.corpo ->> 'versao' = l.versao_esperada
                            AND l.corpo ->> 'fonte'  = l.fonte_esperada)  AS aceitas_na_leva,
         count(*) FILTER (WHERE l.status_code = 401)           AS recusadas_na_leva,
         count(*) FILTER (WHERE l.status_code IS NULL
                            AND l.erro_transporte IS NULL)     AS pendentes_na_leva,
         count(*) FILTER (WHERE l.erro_transporte IS NOT NULL) AS falhas_na_leva
  FROM lidas l
  WHERE l.request_id IS NOT NULL
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
         WHEN l.erro_transporte IS NOT NULL
           THEN 'FALHA DE TRANSPORTE — a requisicao nao chegou a ter resposta HTTP: ' ||
                l.erro_transporte || '. Isto NAO e veredito de deploy e NAO adianta repetir ' ||
                'sem antes resolver a causa (DNS, timeout, rede do pg_net)'
         WHEN l.status_code IS NULL
           THEN 'AGUARDE — o request_id embutido pelo passo 1 ainda não tem resposta HTTP (leva ~10s); rode este passo de novo'
         WHEN l.created <= now() - interval '20 minutes'
           THEN 'INDETERMINADO — a resposta e de ' || l.created || ', FORA da janela de 20 min: esta celula e de OUTRA sessao e o veredito seria de um deploy anterior. Redispare o passo 1'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
              AND a.aceitas_na_leva >= 1
           THEN 'BUNDLE VELHO (pre-sonda) — 401, e a credencial DESTE disparo esta PROVADA ' ||
                'ATIVAMENTE: ' || a.aceitas_na_leva || ' de ' || a.disparos_na_leva ||
                ' request(s) desta leva voltou com IDENTIDADE VERIFICADA (probe + versao + ' ||
                'fonte esperadas), logo o x-cron-secret foi ACEITO neste instante e a recusa ' ||
                'e da EDGE: nada executou'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
           THEN 'INDETERMINADO — 401 nao separa bundle velho de CRON_SECRET invalido, e ' ||
                'NENHUMA aceitacao foi OBSERVADA nesta leva (0 testemunha de ' ||
                a.disparos_na_leva || ' disparo(s); 401: ' || a.recusadas_na_leva ||
                ', sem resposta ainda: ' || a.pendentes_na_leva || ', falha de transporte: ' ||
                a.falhas_na_leva || '). Isto e ausencia de prova, nao prova de que o secret ' ||
                'esta ruim. Confira o CRON_SECRET no vault ANTES de redeployar. ' ||
                'Acrescente a leva uma edge que voce SABE no ar: a testemunha dela DETERMINA ' ||
                'este 401. '
                || ' Trafego de fundo (6h, fora desta leva, NAO decide o veredito): ' || c.ok_recentes ||
                ' resposta(s) 2xx e ' || c.recusas_recentes || ' recusa(s) 401' ||
                CASE WHEN c.ok_recentes < 10
                     THEN ' — fundo ANORMALMENTE QUIETO (abaixo do piso de 10 em 6h): nem como contexto ele informa.'
                     ELSE '.' END
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
FROM lidas l CROSS JOIN controle_credencial c CROSS JOIN controle_ativo a
ORDER BY l.edge;
$sonda$, m.ids) AS passo_2_copie_esta_celula
FROM mapa m;

-- PASSO 2 — lê e julga SEM mapa nenhum: a resposta da sonda ecoa o próprio slug, e o bloco
--          a encontra na janela de 20 min. É SELECT puro — roda no read-only:
--          bun run sonda:sql --so-leitura <edge>… | ~/.config/afiacao/psql-ro
-- ⚠️ Esta é a versão do ECO. A que o passo 1 devolve é ESTRITAMENTE melhor: com o mapa
--    embutido, PRE-SENSOR e recusa HTTP (que não ecoam) saem determinados, e o 401 também.
WITH esperado(edge, versao_esperada, fonte_esperada) AS (VALUES
  ('whatsapp-inbound', 'v1.0-sensor-inicial', 'e2386801525315a52f0c06fae2c6055f846f4a877b157a9627e19f7811acb315')
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
  -- OPCIONAL — deixe o {} como está. O eco do slug acha a linha sozinho; colar aqui o JSON do
  -- disparo só serve para separar a causa (c) do INDETERMINADO (PRE-SENSOR / recusa HTTP).
  SELECT chave AS edge, valor::bigint AS request_id
  FROM jsonb_each_text('{}'::jsonb) AS t(chave, valor)
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
    -- ⚠️ Com o `ids` VAZIO (o padrão do --so-leitura), esta exclusão não exclui nada: um 401
    --    desta leva conta como recusa e o controle se auto-desqualifica. É fail-CLOSED, mas
    --    hoje isso é secundário: o veredito do 401 exige TESTEMUNHA ATIVA, e sem o mapa não
    --    há request_id desta leva para testemunhar. Rode o bloco de DISPARO.
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
         COALESCE(s.created, x.created) AS created,
         x.error_msg AS erro_transporte,
         COALESCE(s.corpo,
                  CASE WHEN x.content IS NOT NULL AND left(ltrim(x.content), 1) = '{'
                       THEN COALESCE(x.content::jsonb -> 'data', x.content::jsonb)
                  END) AS corpo
  FROM esperado e
  LEFT JOIN LATERAL (
    SELECT rr.id, rr.status_code, rr.created, rr.corpo
    FROM recentes rr
    WHERE rr.corpo ->> 'edge' = e.edge
      AND rr.corpo ->> 'probe' = 'true'
    ORDER BY rr.created DESC, rr.id DESC
    LIMIT 1
  ) s ON true
  LEFT JOIN ids i ON i.edge = e.edge
  LEFT JOIN net._http_response x ON x.id = i.request_id
),
controle_ativo AS (
  -- Controle ATIVO: a prova de credencial ATRIBUÍDA a ESTA leva. O histórico acima conta
  -- tráfego de FORA e não sabe qual credencial autenticou os 2xx que contou; este conta as
  -- respostas DESTES request_ids. Testemunha é IDENTIDADE, não status: exige o eco da sonda
  -- com `versao` E `fonte` ESPERADAS — aí o bundle no ar é VERBATIM o do repo, e no repo o
  -- gate autentica antes de responder. Um 200 anônimo (bundle histórico que ignora a
  -- credencial e roda o fluxo real) NÃO é testemunha, e é por isso que 2xx não basta.
  SELECT count(*)                                            AS disparos_na_leva,
         count(*) FILTER (WHERE l.status_code BETWEEN 200 AND 299
                            AND l.created > now() - interval '20 minutes'
                            AND l.corpo ->> 'probe'  = 'true'
                            AND l.corpo ->> 'edge'   = l.edge
                            AND l.corpo ->> 'versao' = l.versao_esperada
                            AND l.corpo ->> 'fonte'  = l.fonte_esperada)  AS aceitas_na_leva,
         count(*) FILTER (WHERE l.status_code = 401)           AS recusadas_na_leva,
         count(*) FILTER (WHERE l.status_code IS NULL
                            AND l.erro_transporte IS NULL)     AS pendentes_na_leva,
         count(*) FILTER (WHERE l.erro_transporte IS NOT NULL) AS falhas_na_leva
  FROM lidas l
  WHERE l.request_id IS NOT NULL
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
           THEN 'INDETERMINADO — nenhuma resposta de sonda desta edge na janela de 20 min. Isto é ausência de dado, não veredito negativo: pode ser (a) o disparo não ter rodado, (b) a resposta ainda a caminho (leva ~10s) — rode este passo de novo, ou (c) bundle PRE-SENSOR / recusa HTTP, que responde SEM eco do slug e é invisível aqui; para separar (c), cole o request_id do disparo no ids acima'
         WHEN l.erro_transporte IS NOT NULL
           THEN 'FALHA DE TRANSPORTE — a requisicao nao chegou a ter resposta HTTP: ' ||
                l.erro_transporte || '. Isto NAO e veredito de deploy e NAO adianta repetir ' ||
                'sem antes resolver a causa (DNS, timeout, rede do pg_net)'
         WHEN l.status_code IS NULL
           THEN 'AGUARDE — o request_id colado ainda não tem resposta HTTP (leva ~10s); rode este passo de novo'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
              AND a.aceitas_na_leva >= 1
           THEN 'BUNDLE VELHO (pre-sonda) — 401, e a credencial DESTE disparo esta PROVADA ' ||
                'ATIVAMENTE: ' || a.aceitas_na_leva || ' de ' || a.disparos_na_leva ||
                ' request(s) desta leva voltou com IDENTIDADE VERIFICADA (probe + versao + ' ||
                'fonte esperadas), logo o x-cron-secret foi ACEITO neste instante e a recusa ' ||
                'e da EDGE: nada executou'
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code = 401
           THEN 'INDETERMINADO — 401 nao separa bundle velho de CRON_SECRET invalido, e ' ||
                'NENHUMA aceitacao foi OBSERVADA nesta leva (0 testemunha de ' ||
                a.disparos_na_leva || ' disparo(s); 401: ' || a.recusadas_na_leva ||
                ', sem resposta ainda: ' || a.pendentes_na_leva || ', falha de transporte: ' ||
                a.falhas_na_leva || '). Isto e ausencia de prova, nao prova de que o secret ' ||
                'esta ruim. Confira o CRON_SECRET no vault ANTES de redeployar. ' ||
                'Este modo nao embute o mapa, entao nao ha request_id desta leva para ' ||
                'testemunhar: rode o bloco de DISPARO, que emite o passo de leitura com o ' ||
                'mapa dentro. '
                || ' Trafego de fundo (6h, fora desta leva, NAO decide o veredito): ' || c.ok_recentes ||
                ' resposta(s) 2xx e ' || c.recusas_recentes || ' recusa(s) 401' ||
                CASE WHEN c.ok_recentes < 10
                     THEN ' — fundo ANORMALMENTE QUIETO (abaixo do piso de 10 em 6h): nem como contexto ele informa.'
                     ELSE '.' END
         WHEN l.corpo ->> 'versao' IS NULL AND l.status_code >= 400
           THEN 'BUNDLE VELHO — recusou o request (HTTP ' || l.status_code || '), NADA executou'
         WHEN l.corpo ->> 'versao' IS NULL
           THEN 'PRE-SENSOR — HTTP 200 sem versao: ignorou o probe e RODOU O FLUXO REAL'
         WHEN l.corpo ->> 'probe' IS DISTINCT FROM 'true'
           THEN 'NAO E RESPOSTA DE SONDA — o corpo tem versao mas NAO tem probe:true, entao ' ||
                'e a execucao REAL desta edge (cron), nao a sonda: nao ha veredito de deploy ' ||
                'aqui. ' || 'O id colado no ids aponta para outra execucao — foi ele que trocou o alvo.' || ' Respondeu versao=' ||
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
FROM lidas l CROSS JOIN controle_credencial c CROSS JOIN controle_ativo a
ORDER BY l.edge;

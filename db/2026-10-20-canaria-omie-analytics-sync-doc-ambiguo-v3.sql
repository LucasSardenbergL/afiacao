-- PASSO 1 — dispara as 1 canária(s) cujo bundle velho NÃO cai em efeito caro.
--          Exige ESCRITA: lê o vault e faz INSERT, e o read-only recusa os dois — o que
--          NÃO é o mesmo que "só o founder consegue". Caminho da SESSÃO: commite este
--          .sql em db/ e rode `bun run db:aplicar db/<arquivo>.sql` (`--ensaio` antes) —
--          o envelope, com sha256, ledger e marcador de fim. Colar no SQL Editor é o
--          FALLBACK: de quem só tem o psql-ro (docs/agent/database.md §"o ENVELOPE").
-- Ele DEVOLVE o passo 2 já escrito, com o mapa dentro — por um canal em cada via:
--   · SQL Editor: a CÉLULA `passo_2_copie_esta_celula`. Copie-a inteira (NOTICE ali não aparece).
--   · db:aplicar: a célula NÃO volta — o aplicar_sql() roda o arquivo por EXECUTE, que descarta o
--     resultado do SELECT. O passo 2 vem por NOTICE, no log que ele aponta no fim (`log: …`),
--     entre SONDA_PASSO_2_INICIO e SONDA_PASSO_2_FIM. Leia direto do log, no read-only:
--       awk '/^SONDA_PASSO_2_FIM$/{if(f){ok=1;f=0}} f{b=b $0 "\n"} /SONDA_PASSO_2_INICIO$/{f=1;b="";ok=0} END{if(!ok){print "sonda: o PASSO 2 NAO veio inteiro neste log" > "/dev/stderr"; exit 3} printf "%s", b}' <log> | ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1
--     Só o log do apply de VERDADE (✅ APLICADO) serve: no do --ensaio o ROLLBACK desfez o disparo,
--     e o passo 2 dele fica em AGUARDE para sempre.
-- Por que esta função: o db:aplicar roda este arquivo DENTRO do aplicar_sql(), por EXECUTE, e o
-- EXECUTE descarta o resultado do SELECT — a célula não chega ao log. NOTICE chega. Ela devolve o
-- texto INTACTO (é ele a célula) e o repete num NOTICE entre marcadores. Temporária: some com a
-- sessão e não deixa nada no banco.
CREATE OR REPLACE FUNCTION pg_temp.sonda_passo_tambem_por_notice(p_inicio text, p_fim text, p_texto text)
RETURNS text LANGUAGE plpgsql AS $notice$ BEGIN
  RAISE NOTICE '%', p_inicio || E'\n' || p_texto || CASE WHEN right(p_texto, 1) = E'\n' THEN '' ELSE E'\n' END || p_fim;
  RETURN p_texto;
END $notice$;
WITH alvos(nome, edge, corpo, sufixo) AS (VALUES
  ('omie-analytics-sync:doc_ambiguo_probe', 'omie-analytics-sync', '{"action": "doc_ambiguo_probe"}'::jsonb, '')
),
disparos AS (
  SELECT a.nome,
         net.http_post(
           url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/' || a.edge || a.sufixo,
           headers := jsonb_build_object(
             'Content-Type', 'application/json',
             'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                               WHERE name = 'CRON_SECRET' LIMIT 1)),
           body := a.corpo,
           timeout_milliseconds := 20000) AS request_id
  FROM alvos a
),
mapa AS (
  -- O par (nome, id) é agregado na MESMA execução que disparou: o request_id nunca existe
  -- solto, e por isso não há como colá-lo na linha da canária errada.
  SELECT jsonb_object_agg(nome, request_id)::text AS ids FROM disparos
)
-- O PASSO 2 sai ESCRITO na célula abaixo — e, pela função do topo, também num
-- NOTICE com o MESMO texto. Copie a célula (ou o trecho do log) INTEIRA e rode/entregue como
-- está: não há número a anotar nem campo a preencher.
SELECT pg_temp.sonda_passo_tambem_por_notice('SONDA_PASSO_2_INICIO', 'SONDA_PASSO_2_FIM', (
SELECT format($sonda$
-- PASSO 2 — lê e julga a CANÁRIA. O mapa nome→id já está EMBUTIDO aqui, escrito
--          pelo passo 1: nada a colar. Espere ~10s pela resposta HTTP. É SELECT
--          puro — roda no read-only: cole no chat, ou em ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1
WITH esperado(nome, campo_marcador, marcador_esperado, efeito) AS (VALUES
  ('omie-analytics-sync:doc_ambiguo_probe', 'contrato', 'doc-ambiguo-mutilacao-nao-e-ambiguidade-v3', 'action desconhecida devolve 400 antes de qualquer escrita')
),
ids AS (
  -- EMBUTIDO pelo passo 1 — o mapa `nome → request_id` foi escrito pelo próprio
  -- banco no disparo (format()). A canária NÃO ecoa o slug, então este mapa não é atalho: é a
  -- ÚNICA via de atribuir a resposta à canária certa. Trava fechada ⇒ id nulo ⇒ INDETERMINADO.
  SELECT chave AS nome, valor::bigint AS request_id
  FROM jsonb_each_text(%1$L::jsonb) AS t(chave, valor)
),
controle_credencial AS (
  -- Mesma mecânica da sonda (é a MESMA função que emite este CTE): o 401 é ambíguo aqui
  -- também, mas o par que ele separa é OUTRO — bundle sem a canária × CRON_SECRET
  -- inválido — e por isso o veredito que o consome fica no bloco, não aqui.
  SELECT count(*) FILTER (WHERE r.status_code BETWEEN 200 AND 299) AS ok_recentes,
         count(*) FILTER (WHERE r.status_code = 401)               AS recusas_recentes
  FROM net._http_response r
  WHERE r.created > now() - interval '6 hours'
    -- A própria leva não pode se avalizar: sem isto, o 401 que estamos julgando entra na
    -- contagem de recusas e o controle se auto-envenena (nenhum 401 seria explicável nunca).
    -- NOT EXISTS, não NOT IN: a trava fechada do bloco caro devolve request_id NULL, e
    -- `NOT IN` com NULL é NULL-blind — zeraria o controle inteiro em silêncio.
    -- Aqui o mapa `ids` é SEMPRE embutido pelo disparo, então esta exclusão sempre vale:
    -- o 401 desta leva não conta como recusa contra si mesmo.
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
  -- Parte de `esperado`: zero linhas não pode virar "nada a reportar". O envelope `data` é
  -- descido aqui porque a omie-analytics-sync responde `{success, data:{...}}` e as outras no
  -- topo — sem o COALESCE as DUAS canárias dela sairiam como "sem eco".
  SELECT esp.nome, esp.campo_marcador, esp.marcador_esperado, esp.efeito,
         mp.request_id, resp.status_code, resp.created,
         resp.error_msg AS erro_transporte,
         CASE WHEN resp.content IS NOT NULL AND left(ltrim(resp.content), 1) = '{'
              THEN COALESCE(resp.content::jsonb -> 'data', resp.content::jsonb)
         END AS corpo
  FROM esperado esp
  LEFT JOIN ids mp ON mp.nome = esp.nome
  LEFT JOIN net._http_response resp ON resp.id = mp.request_id
),
controle_ativo AS (
  -- Mesma mecânica da sonda (é a MESMA função que emite este CTE), com a testemunha do
  -- OUTRO eco: aqui o que identifica o bundle é `canary:true` + o MARCADOR esperado.
  -- ⚠️ E aqui a testemunha NÃO exige 2xx: a generate-tactical-plan responde HTTP 500 quando
  --    a canária dela REPROVA, e isso é regressão de NEGÓCIO — o request já tinha passado
  --    pelo gate para chegar a executar a fixture. Exigir 2xx descartaria justamente a
  --    resposta que mais prova a credencial.
  SELECT count(*)                                            AS disparos_na_leva,
         count(*) FILTER (WHERE ca.corpo ->> 'canary' = 'true'
                            AND ca.created > now() - interval '20 minutes'
                            AND ca.corpo ->> ca.campo_marcador = ca.marcador_esperado)  AS aceitas_na_leva,
         count(*) FILTER (WHERE ca.status_code = 401)           AS recusadas_na_leva,
         count(*) FILTER (WHERE ca.status_code IS NULL
                            AND ca.erro_transporte IS NULL)     AS pendentes_na_leva,
         count(*) FILTER (WHERE ca.erro_transporte IS NOT NULL) AS falhas_na_leva
  FROM lidas ca
  WHERE ca.request_id IS NOT NULL
)
SELECT ca.nome,
       ca.request_id,
       ca.status_code,
       ca.corpo ->> 'canary' AS canary_respondido,
       ca.corpo ->> ca.campo_marcador AS marcador_respondido,
       ca.marcador_esperado,
       ca.corpo ->> 'ok' AS ok_respondido,
       CASE
         WHEN ca.request_id IS NULL
           THEN 'INDETERMINADO — esta canaria nao tem request_id no mapa embutido pelo passo 1. Isto e ausencia de dado, nao veredito: ou a trava ficou FECHADA e nada foi disparado, ou a celula veio de OUTRA leva'
         WHEN ca.erro_transporte IS NOT NULL
           THEN 'FALHA DE TRANSPORTE — a requisicao nao chegou a ter resposta HTTP: ' ||
                ca.erro_transporte || '. Isto NAO e veredito de canaria e NAO adianta repetir sem antes resolver a causa (DNS, timeout, rede do pg_net)'
         WHEN ca.status_code IS NULL
           THEN 'AGUARDE — o request_id embutido pelo passo 1 ainda nao tem resposta HTTP (leva ~10s); rode este passo de novo'
         WHEN ca.created <= now() - interval '20 minutes'
           THEN 'INDETERMINADO — a resposta e de ' || ca.created || ', FORA da janela de 20 min: esta celula e de outra sessao e o veredito seria de um deploy anterior. Redispare o passo 1'
         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code = 401
              AND ativo.aceitas_na_leva >= 1
           THEN 'SEM CANARIA NO AR — 401, e a credencial DESTE disparo esta PROVADA ATIVAMENTE: ' || ativo.aceitas_na_leva || ' de ' || ativo.disparos_na_leva || ' request(s) desta leva voltou com o MARCADOR esperado, logo o x-cron-secret foi ACEITO neste instante e a recusa e da EDGE: o bundle no ar e anterior a canaria, ela NAO rodou e NADA executou. Isto NAO e canaria vermelha — o desfecho e DEPLOY'
         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code = 401
           THEN 'INDETERMINADO — 401 nao separa bundle sem canaria de CRON_SECRET invalido, e NENHUMA aceitacao foi OBSERVADA nesta leva (0 testemunha de ' || ativo.disparos_na_leva ||
                ' disparo(s); 401: ' || ativo.recusadas_na_leva || ', sem resposta ainda: ' ||
                ativo.pendentes_na_leva || ', falha de transporte: ' || ativo.falhas_na_leva ||
                '). Isto e ausencia de prova, nao prova de secret ruim. Confira o CRON_SECRET no vault ANTES de redeployar.' || ' Trafego de fundo (6h, fora desta leva, NAO decide o veredito): ' || cred.ok_recentes ||
                ' resposta(s) 2xx e ' || cred.recusas_recentes || ' recusa(s) 401' ||
                CASE WHEN cred.ok_recentes < 10
                     THEN ' — fundo ANORMALMENTE QUIETO (abaixo do piso de 10 em 6h): nem como contexto ele informa.'
                     ELSE '.' END
         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca.status_code >= 400
           THEN 'SEM CANARIA NO AR — o bundle recusou o request (HTTP ' || ca.status_code ||
                '), NADA executou. Isto NAO e canaria vermelha: nao ha canaria no ar para ficar vermelha'
         WHEN ca.corpo ->> 'canary' IS DISTINCT FROM 'true'
           THEN 'SEM CANARIA NO AR — HTTP ' || ca.status_code || ' SEM eco canary: o bundle ignorou a flag e RODOU O FLUXO REAL (' || ca.efeito || '). Isto NAO e canaria vermelha, e canaria AUSENTE — e o efeito ja aconteceu'
         WHEN ca.corpo ->> ca.campo_marcador IS NULL
           THEN 'CANARIA SEM MARCADOR — respondeu canary:true e o corpo NAO TEM o campo ' ||
                ca.campo_marcador || ': o bundle e anterior ao versionamento da canaria. O ok sozinho NAO discrimina reversao de fatia (armadilha 2 do deploy.md). PRECISA DEPLOY'
         WHEN ca.corpo ->> ca.campo_marcador IS DISTINCT FROM ca.marcador_esperado
           THEN 'CANARIA DE OUTRA FATIA — respondeu ' || ca.campo_marcador || '=' ||
                COALESCE(ca.corpo ->> ca.campo_marcador, '?') || ' (esperado ' ||
                ca.marcador_esperado || '). O bundle velho carrega o expected VELHO e compara velho x velho, entao o ok dele nao vale — e assim que uma reversao MENTE VERDE. PRECISA DEPLOY'
         WHEN ca.corpo ->> 'ok' IS NULL
           THEN 'CANARIA SEM VEREDITO — canary:true e marcador batendo, mas o corpo nao traz ok. Fail-closed: sem os TRES campos nao ha confirmacao'
         WHEN ca.corpo ->> 'ok' = 'false'
           THEN 'CANARIA VERMELHA — o bundle no ar E o esperado (' || ca.marcador_esperado ||
                ') e a fixture REPROVOU: o comportamento regrediu. NAO e deploy pendente — leia os casos do corpo para saber QUAL lado caiu'
         WHEN ca.corpo ->> 'canary' = 'true'
              AND ca.corpo ->> ca.campo_marcador = ca.marcador_esperado
              AND ca.corpo ->> 'ok' = 'true'
           THEN 'CANARIA VERDE'
         ELSE 'INDETERMINADO — combinacao nao prevista: canary=' ||
              COALESCE(ca.corpo ->> 'canary', '?') || ', ' || ca.campo_marcador || '=' ||
              COALESCE(ca.corpo ->> ca.campo_marcador, '?') || ', ok=' ||
              COALESCE(ca.corpo ->> 'ok', '?')
       END AS veredito
FROM lidas ca CROSS JOIN controle_credencial cred CROSS JOIN controle_ativo ativo
ORDER BY ca.nome;
$sonda$, m.ids)
)) AS passo_2_copie_esta_celula
FROM mapa m;

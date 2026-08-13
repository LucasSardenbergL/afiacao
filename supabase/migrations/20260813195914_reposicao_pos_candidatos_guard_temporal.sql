-- Reposição — o detector de PO excluído para de acusar PO que ainda NEM EXISTIA (money-path)
-- ============================================================================
-- SINTOMA (13/08/2026, prod): o card "pedido sem PO no Omie" mostrou 4 pedidos Sayerlack do MESMO dia
-- (protocolos 2119991/2120199/2120226 + 1, até R$21.621,84) instruindo o comprador a ligar para o
-- fornecedor e conferir o Omie à mão. Os 4 POs existem. Dois deles já estavam no espelho
-- (`purchase_orders_tracking`) no instante do alerta.
--
-- CAUSA — o detector compara com um retrato que é ANTERIOR ao próprio PO:
--   `reposicao_po_last_seen` só é carimbado no run COMPLETO e LIMPO (`reposicao_publicar_run_completo`,
--   1×/dia; as varreduras incrementais de 2h NÃO carimbam). O marcador de 13/08 fechou 12:17Z; os 4 POs
--   nasceram 14:07Z, 20:09Z, 21:15Z e 21:51Z. Um run que TERMINOU antes de o PO existir não pode
--   testemunhar a ausência dele — mas o predicado lia esse silêncio como "não apareceu".
--   Medido em prod (30d): 42 pedidos disparados, cada um passando em MÉDIA 11,0h dentro do alerta
--   (máx 50,4h). Não é o azar de um dia: é a latência do detector virando alarme, para TODO pedido.
--
-- POR QUE ISSO IMPORTA MAIS QUE O RUÍDO: o card existe por um caso REAL (pedidos 281/286, ~R$3.060,
-- PO excluído no Omie com o pedido vivo no fornecedor) e sua instrução central — "não cancele, recrie" —
-- está certa, porque cancelar faz o motor re-sugerir e a compra sai DUAS vezes. Um detector que grita
-- todo dia treina o comprador a passar o olho e seguir; quando o caso verdadeiro chegar, ele estará na
-- mesma fila dos falsos. Ruído em alerta de money-path não é incômodo, é perda de sensibilidade.
--
-- O QUE MUDA — uma linha no predicado: PO cujo `omie_registrado_em` é POSTERIOR ao `finalizado_em` do
-- marcador deixa de ser candidato. Só isso. O que NÃO muda importa tanto quanto:
--   • Não afirma que o PO existe — apenas se recusa a afirmar AUSÊNCIA sem base para tal. A RPC segue
--     LISTANDO e EVIDENCIANDO, sem decidir (o desenho do PR2 fica intacto).
--   • Ambiguidade continua alertando: PO registrado ANTES do `finalizado_em` mas durante a coleta (a
--     varredura leva ~3min) pode legitimamente não ter sido visto ⇒ segue candidato. Suprimo apenas o
--     caso logicamente IMPOSSÍVEL, nunca o duvidoso.
--   • `omie_registrado_em IS NULL` segue candidato (fail-closed). Hoje são 0 de 94 linhas, mas a coluna
--     é nullable e "hoje é zero" não é garantia estrutural — comparação com NULL daria NULL, e o
--     `AND` engoliria a linha em silêncio, que é o oposto do que se quer.
--   • O espelho `purchase_orders_tracking` continua NÃO sendo usado como supressor: o sync é
--     upsert-only (nunca remove), então presença lá não prova existência ATUAL do PO no Omie.
--
-- ⚠️ PRÉ-FLIGHT (CLAUDE.md — `CREATE OR REPLACE` diverge repo×prod, a última a recriar VENCE):
-- a definição VIVA em prod não é a da migration 20260721190000. A 20260720120000 (FU4-G) chegou depois
-- e trocou o gate por `private.cap_compras_ler` via regexp sobre `pg_get_functiondef`. O corpo abaixo é
-- o da PROD (capturado por psql-ro em 13/08) — partir do arquivo do repo teria REGREDIDO a autorização
-- de volta para `pode_ver_carteira_completa`. O bloco de pré-condição barra esse acidente.
--
-- Prova PG17: db/test-pos-candidatos-guard-temporal.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- ── PRÉ-CONDIÇÃO: o gate de authz atual precisa existir ANTES de recriarmos a função ──────────
-- Sem isto, aplicar esta migration num banco onde o FU4-G ainda não passou criaria uma RPC SECURITY
-- DEFINER chamando uma função inexistente: `CREATE` passa (plpgsql é late-bound) e a falha só apareceria
-- ao EXECUTAR — com o card de compras morto em silêncio.
DO $pre$
BEGIN
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'guard-temporal: private.cap_compras_ler(uuid) ausente — aplique o FU4-G (20260720120000) antes'
      USING ERRCODE = '42883';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE (
  pedido_id              bigint,
  omie_codigo_pedido     text,
  data_ciclo             date,
  idade_dias             integer,
  na_janela_7d           boolean,
  valor_total            numeric,
  itens_sem_valor        integer,
  visto_status           text,
  po_no_espelho          boolean,
  fornecedor_nome        text,
  canal_usado            text,
  portal_protocolo       text,
  status_envio_portal    text,
  resposta_canal         jsonb,
  tem_protocolo          boolean,
  tem_status_portal      boolean,
  tem_resposta_canal     boolean,
  tem_canal              boolean,
  algum_sinal_de_canal   boolean,
  marcador_run_id        uuid,
  marcador_seq           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate cron-or-staff NULL-aware: uid presente exige staff; uid NULL (service_role/cron SQL-local) passa.
  -- ⚠️ NUNCA gatear por auth.role()='service_role' — o pg_cron roda como postgres SEM JWT (auth.role()=NULL)
  -- e o gate mataria o cron em SILÊNCIO (reposicao.md: mordido 2x, migrations 20260627130000/20260627200000).
  IF (SELECT auth.uid()) IS NOT NULL
     -- ⚠️ IS NOT TRUE, não NOT(...): pode_ver_carteira_completa() era TRI-STATE (o gate ANTERIOR;
     -- private.cap_compras_ler faz COALESCE e nunca devolve NULL, entao IS NOT TRUE fica como defesa em
     -- profundidade). Para um `employee` SEM linha em commercial_roles ela retornava NULL, e `NOT NULL` =
     -- NULL — o IF não entrava e a SECURITY DEFINER ENTREGAVA TUDO (protocolo, fornecedor, JSON cru).
     -- Bypass real (Codex v11), e viola o fail-closed do CLAUDE.md. IS NOT TRUE trata NULL como negado e
     -- preserva o uid NULL do cron, que é barrado antes pelo primeiro AND.
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_pos_candidatos: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH marcador AS (
    -- "último completo válido" = maior fencing seq com volume_ok TRUE. Sem marcador → CROSS JOIN vazio →
    -- retorna VAZIO. Fail-closed: sem base de verdade não se classifica ninguém como ausente.
    -- `finalizado_em` entra aqui para o guard temporal do WHERE (ver abaixo).
    SELECT r.run_id, r.seq, r.finalizado_em
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ),
  base AS (
    SELECT
      p.id AS pedido_id,
      p.omie_pedido_compra_id AS omie_codigo_pedido,
      p.data_ciclo::date AS data_ciclo,
      (now()::date - p.data_ciclo::date)::integer AS idade_dias,
      p.fornecedor_nome,
      p.canal_usado,
      p.portal_protocolo,
      p.status_envio_portal,
      p.resposta_canal,
      m.run_id AS marcador_run_id,
      m.seq AS marcador_seq,
      ls.run_id AS visto_run_id,
      -- ⚠️ sum() IGNORA NULL: itens (100.00, NULL) davam 100.00, apresentando SUBTOTAL como total apurado —
      -- fabricação de número, o que o money-path.md proíbe ("ausente ≠ zero"). Agora o total só existe se
      -- TODOS os itens têm valor; senão NULL, e itens_sem_valor diz por quê (Codex v8).
      (SELECT CASE WHEN count(*) FILTER (WHERE i.valor_linha IS NULL) = 0
                   THEN sum(i.valor_linha) END
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id) AS valor_total,
      (SELECT count(*) FILTER (WHERE i.valor_linha IS NULL)
         FROM public.pedido_compra_item i WHERE i.pedido_id = p.id)::integer AS itens_sem_valor,
      -- ⚠️ NULL (não FALSE) quando a identidade é ILEGÍVEL: `EXISTS(... = NULL)` retorna false, e a RPC
      -- estaria AFIRMANDO ausência no espelho sem sequer conseguir identificar o PO (Codex v7).
      -- "Não apurei" ≠ "não há" — a mesma distinção de visto_status='identidade_nao_interpretavel'.
      CASE WHEN public.reposicao__po_id(p.omie_pedido_compra_id) IS NULL THEN NULL ELSE EXISTS (
        SELECT 1 FROM public.purchase_orders_tracking t
        WHERE t.empresa = v_empresa
          -- identidade NUMÉRICA canônica (reposicao__po_id): '00101' e '101' são o MESMO PO; whitespace de
          -- borda tolerado, interno invalida; fora do range de bigint → NULL em vez de derrubar a RPC.
          AND t.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
      ) END AS po_no_espelho
    FROM public.pedido_compra_sugerido p
    CROSS JOIN marcador m
    LEFT JOIN public.reposicao_po_last_seen ls
           ON ls.empresa = v_empresa
          AND ls.omie_codigo_pedido = public.reposicao__po_id(p.omie_pedido_compra_id)
    -- ⚠️ `pedido_compra_sugerido.empresa` é **text** ('OBEN'); as outras tabelas usam o ENUM empresa_reposicao.
    -- text = enum direto é erro de TIPO em runtime (PL/pgSQL late-bound: o CREATE passa, quebra ao EXECUTAR).
    WHERE upper(btrim(p.empresa)) = v_empresa::text
      AND p.status IN ('disparado', 'aprovado_aguardando_disparo')
      AND p.omie_pedido_compra_id IS NOT NULL
      AND btrim(p.omie_pedido_compra_id) <> ''
      -- CANDIDATO = o PO não foi visto no marcador atual (carimbado por run ANTERIOR ou NUNCA carimbado).
      AND (ls.run_id IS NULL OR ls.run_id <> m.run_id)
      -- ⚠️ GUARD TEMPORAL: um run que TERMINOU antes de o PO existir não testemunha NADA sobre ele.
      -- O carimbo de `last_seen` só sai no run COMPLETO (1×/dia); todo PO criado depois dele ficava
      -- "não visto" por até ~22h e virava alerta de conferência manual (prod 13/08: 4 de 4 candidatos,
      -- média histórica de 11,0h por pedido). Sem este guard o detector acusa o próprio atraso.
      --
      -- Deliberadamente CONSERVADOR nos dois lados:
      --   • `IS NULL` → segue candidato: sem data de registro não dá para provar impossibilidade, e a
      --     comparação devolveria NULL, que o AND descartaria em SILÊNCIO (supressão acidental).
      --   • `<=` (não `<`) mantém candidato o PO registrado DURANTE a coleta — ele pode legitimamente
      --     não ter entrado na varredura. Suprime-se o impossível, nunca o duvidoso.
      AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)
  )
  SELECT
    b.pedido_id,
    b.omie_codigo_pedido,
    b.data_ciclo,
    b.idade_dias,
    -- DANO ATIVO = a CTE em_transito só soma disparados dos últimos 7d. Idade = PRIORIDADE, não verdade.
    -- NOME FACTUAL: a RPC apura a JANELA, nao o dano (um aprovado_aguardando_disparo de 3 dias sem canal
    -- nenhum recebia dano_ativo=true so pela idade — Codex v9). Quem decide se ha dano e o consumidor.
    (b.idade_dias BETWEEN 0 AND 7) AS na_janela_7d,
    b.valor_total,
    b.itens_sem_valor,
    -- ⚠️ identidade ILEGÍVEL não é "nunca visto": o LEFT JOIN não pôde nem comparar. Afirmar ausência aqui
    -- era falha ABERTA (Codex v6 P1) — e o assert J3 chegava a FIXAR esse falso-positivo como esperado.
    CASE
      WHEN public.reposicao__po_id(b.omie_codigo_pedido) IS NULL THEN 'identidade_nao_interpretavel'
      -- 'sem_registro_last_seen', não 'nunca_carimbado': a RPC prova a ausência ATUAL da linha, não que o PO
      -- nunca foi visto — a linha pode ter sido apagada/reconstruída (Codex v10). "Nunca" é afirmação de
      -- histórico, e histórico esta RPC não consulta.
      WHEN b.visto_run_id IS NULL                                THEN 'sem_registro_last_seen'
      -- 'outro_run', não 'anterior': a RPC só prova `run_id <> marcador`. O outro run pode ser POSTERIOR
      -- (seq maior, ainda não promovido a marcador) ou um UUID sem linha na tabela de runs (Codex v11).
      -- Afirmar "anterior" seria temporalidade não apurada.
      ELSE 'visto_em_outro_run'
    END AS visto_status,
    -- SINAL FRACO: o sync do tracking é upsert-only (nunca remove) → ausência do espelho NÃO prova exclusão.
    b.po_no_espelho,
    b.fornecedor_nome,
    b.canal_usado,
    -- 🔑 SEM REGEX SEMÂNTICA (Codex v9). Quatro rodadas seguidas acharam um valor que enganava o rótulo:
    -- 'su cesso' virava sucesso por coerção de whitespace; 'sem sucesso' casava a regex; e a guarda de
    -- negação criou falso-NEGATIVO ('login: sucesso' — o `in` casa no fim de "log-IN") e falso-POSITIVO
    -- ('não houve sucesso' — o [^a-z]* não atravessa "houve"). Interpretar texto LIVRE de terceiro por regex
    -- não converge, e o rótulo não decide nada desde que a coluna `rota` morreu na v4.
    -- Ficam só FATOS BINÁRIOS incontestáveis. O humano/PR3 lê os campos crus (portal_protocolo,
    -- status_envio_portal, resposta_canal, canal_usado) e interpreta com o contexto que a RPC não tem.
    b.portal_protocolo,
    b.status_envio_portal,
    b.resposta_canal,
    (public.reposicao__trim(b.portal_protocolo) <> '')    AS tem_protocolo,
    (public.reposicao__trim(b.status_envio_portal) <> '') AS tem_status_portal,
    -- ⚠️ JSON null ('null'::jsonb) NÃO é SQL NULL: `IS NOT NULL` dava true e a RPC afirmava resposta
    -- existente onde não há nenhuma (Codex v10).
    (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null') AS tem_resposta_canal,
    (public.reposicao__trim(b.canal_usado) <> '')         AS tem_canal,
    -- "há algum indício de que o fornecedor foi acionado?" — OR simples, sem inferência.
    (public.reposicao__trim(b.portal_protocolo) <> ''
      OR public.reposicao__trim(b.status_envio_portal) <> ''
      OR (b.resposta_canal IS NOT NULL AND jsonb_typeof(b.resposta_canal) <> 'null')
      OR public.reposicao__trim(b.canal_usado) <> '')     AS algum_sinal_de_canal,
    b.marcador_run_id,
    b.marcador_seq
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. LISTA e EVIDENCIA — NÃO decide. GUARD TEMPORAL (13/08/2026): PO com omie_registrado_em POSTERIOR ao finalizado_em do marcador NÃO é candidato — o carimbo de last_seen só sai no run completo (1x/dia) e um run que terminou antes de o PO existir não testemunha a ausência dele (prod: 4/4 candidatos falsos, média de 11h de alerta indevido por pedido disparado). Suprime só o IMPOSSÍVEL: registro NULL e registro durante a coleta seguem candidatos (fail-closed). Deliberadamente SEM rota automática: em prod 59/59 dos disparados acionaram portal do fornecedor, então "elegível a auto-cancelamento" é logicamente vazio; e canal/status/resposta são text/jsonb livres onde regex prova presença, nunca ausência. Todo candidato exige decisão humana (provável: RECRIAR o PO, não cancelar). Sem marcador válido retorna VAZIO (fail-closed).';

REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

-- ── PÓS-CONDIÇÃO: a função recriada tem o gate NOVO e o guard NOVO ────────────────────────────
-- O acidente que esta migration quase cometeu (partir do corpo do repo e regredir o gate FU4-G) é o
-- mesmo que a PRÓXIMA pode cometer. Aqui ele falha ALTO, dentro da transação, em vez de virar bypass
-- silencioso de autorização em produção.
-- ⚠️ Casar a CHAMADA, nunca a MENÇÃO. A 1ª versão testava `position('cap_compras_ler' in v_def) > 0`
-- e a falsificação F4 provou que ela NÃO tinha dente: os comentários do próprio corpo citam
-- `private.cap_compras_ler`, então a migration com o gate REGREDIDO para pode_ver_carteira_completa
-- aplicava verde. Sentinela que casa comentário mente. Os regexes de chamada abaixo (mesmo padrão da
-- 20260720120000) exigem o `(( SELECT` da invocação real — e o 2º barra a regressão mesmo que alguém
-- deixe as duas chamadas no corpo.
DO $pos$
DECLARE
  v_def   text := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
  c_novo  constant text := 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT';
  c_velho constant text := 'pode_ver_carteira_completa\s*\(\s*\(\s*SELECT';
  c_guard constant text := 'AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)';
BEGIN
  IF v_def !~ c_novo THEN
    RAISE EXCEPTION 'guard-temporal: gate de authz REGREDIU — sem CHAMADA a private.cap_compras_ler' USING ERRCODE = '42501';
  END IF;
  IF v_def ~ c_velho THEN
    RAISE EXCEPTION 'guard-temporal: gate ANTIGO (pode_ver_carteira_completa) ainda é CHAMADO — FU4-G regrediu' USING ERRCODE = '42501';
  END IF;
  IF v_def !~ c_guard THEN
    RAISE EXCEPTION 'guard-temporal: o guard temporal NAO entrou na definição final' USING ERRCODE = '22000';
  END IF;
END $pos$;

COMMIT;

-- Reposição — o detector de PO excluído passa a DIZER quando ele próprio está cego (money-path)
-- ============================================================================================
-- ORIGEM: revisão independente do #1718 por `/codex challenge` (gpt-5.6-sol/xhigh), registrada em
-- docs/historico/bugs-resolvidos.md (2026-08-13) e no PR #1729. Achado P1, não hipótese.
--
-- O QUE O #1718 TROCOU. O guard temporal (`omie_registrado_em <= m.finalizado_em`) matou 11,0h/pedido
-- de alerta indevido — ganho líquido, e ele FICA. Mas o marcador é escolhido sem NENHUM limite de
-- frescor (maior `seq` com `volume_ok`), então se o run completo parar de produzir run VÁLIDO o
-- marcador CONGELA e todo PO nascido depois dele fica invisível PARA SEMPRE. O #1718 trocou uma falha
-- ALTA (card inundado de falso-positivo) por uma SILENCIOSA (card vazio).
--
-- E card vazio hoje significa DUAS coisas indistinguíveis: "está tudo bem" e "o detector parou".
-- É o §2 do money-path (ausente ≠ zero) aplicado a uma LISTA em vez de a um número: a lista vazia
-- está sendo lida como afirmação de ausência quando é ausência de apuração.
--
-- AGRAVANTE MEDIDO: a cadência do run completo avança por SUCESSO DA PUBLICAÇÃO, não por `volume_ok`
-- (trade-off deliberado da v3.2 — supabase/functions/omie-sync-pedidos-compra/index.ts ~L1097). Logo
-- `volume_ok=false` em série congela o marcador SEM acelerar a retentativa. O congelamento é estável,
-- não transitório.
--
-- ESTADO HOJE (psql-ro, 14/08): OBEN tem 31 runs válidos entre 17/07 e 13/08 e os 30 gaps entre eles
-- são TODOS de 22,0h (máx = média = p95 = 22,0h — cadência rígida). A operação está saudável: esta
-- migration é estrutural, não incêndio. É por isso que dá para ancorar um limiar com folga real.
--
-- O QUE MUDA — a RPC passa a EXPOR a idade da própria base de comparação, e nada mais:
--   • `reposicao_pos_candidatos` ganha 2 colunas NO FIM: `marcador_finalizado_em` e `apurado_em`.
--   • nasce `reposicao_pos_marcador(text)`, que devolve SEMPRE 1 linha com o marcador atual.
-- Nenhum predicado muda. Nenhum candidato entra ou sai por causa desta migration.
--
-- ⚠️ POR QUE A RPC IRMÃ EXISTE (e por que a coluna sozinha NÃO resolveria): coluna é POR LINHA. Com
-- zero candidatos a RPC devolve zero linhas — e portanto carimbo nenhum. Mas o caso "zero candidatos"
-- é EXATAMENTE o silêncio que este PR existe para quebrar. A coluna cobre a lista não-vazia ("esta
-- lista saiu de um marcador de Xh atrás, pode estar incompleta"); a irmã cobre a vazia ("não há
-- candidatos, mas o detector está cego há Xh — o vazio não é notícia boa").
--
-- ⚠️ POR QUE `apurado_em` (o `now()` do BANCO) E NÃO o relógio do cliente: a idade é uma SUBTRAÇÃO, e
-- ancorar um dos lados no relógio do navegador entrega o número ao skew da máquina do usuário —
-- laptop com relógio errado renderiza "desatualizado há 87h" num sistema saudável, ou "há -3h". Num
-- alerta que existe para dizer a verdade sobre frescor, isso é fabricação de número. Os dois lados
-- vêm do mesmo relógio. (`now()` é STABLE — legítimo em função STABLE; a RPC já o usa em `idade_dias`.)
--
-- ⚠️ POR QUE CARIMBO CRU E NÃO "horas": a RPC LISTA e EVIDENCIA, não decide (desenho do PR2). O
-- LIMIAR de frescor é julgamento de produto e vive no consumidor (src/.../po-sumido.ts), onde é
-- testável e revisável sem tocar o banco.
--
-- ⚠️ ISTO EXIGE DROP+CREATE, NÃO `CREATE OR REPLACE`. Acrescentar coluna ao `RETURNS TABLE` muda o
-- tipo de retorno, e o PG recusa (42P13 'cannot change return type of existing function'). Duas
-- consequências que o DROP arrasta e que a pós-condição abaixo vigia:
--   1. O DROP APAGA O ACL. E há `DEFAULT ACL` de funções do owner `postgres` neste projeto
--      concedendo `anon=X` (pg_default_acl, conferido por psql-ro em 14/08) — ou seja, a função
--      RENASCE EXECUTÁVEL POR ANÔNIMO se o REVOKE não vier junto. Falha ABERTA, que muda autorização
--      e não comportamento: nenhum teste de produto a veria. É a mesma classe do `security_invoker`
--      resetado em replace de VIEW (CLAUDE.md). O `sandbox_exec_*` do Lovable, esse, volta sozinho
--      pelo mesmo DEFAULT ACL — não precisa (nem deve) ser concedido à mão.
--   2. `proacl` NULL também é falha aberta: em função, o padrão embutido do PG é EXECUTE TO PUBLIC.
--
-- ⚠️ PRÉ-FLIGHT (CLAUDE.md — `CREATE OR REPLACE` diverge repo×prod, a última a recriar VENCE): o
-- corpo abaixo é o da PROD (`pg_get_functiondef` por psql-ro, 14/08), não o do repo. Partir do repo
-- REGREDIRIA o gate de authz para `pode_ver_carteira_completa` (a 20260720120000/FU4-G reescreveu
-- esta função por regexp_replace depois da 20260721190000). O bloco de pré-condição barra o acidente.

BEGIN;

-- ── PRÉ-CONDIÇÃO: a definição VIVA é a que este arquivo assume ────────────────────────────────
-- Não basta a função existir: se o corpo em produção já não for o pós-#1718, o CREATE abaixo
-- ATROPELA silenciosamente o que estiver lá (a última a recriar vence). Falhar aqui custa um erro
-- no SQL Editor; não falhar custa uma regressão de autorização em produção.
DO $pre$
DECLARE
  v_def text;
  v_md5 text;
BEGIN
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'frescor-marcador: private.cap_compras_ler(uuid) não existe — gate impossível'
      USING ERRCODE = '42883';
  END IF;
  IF to_regprocedure('public.reposicao_pos_candidatos(text)') IS NULL THEN
    RAISE EXCEPTION 'frescor-marcador: reposicao_pos_candidatos(text) não existe — aplique a 20260721190000 e a 20260813195914 antes'
      USING ERRCODE = '42883';
  END IF;

  v_def := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);

  -- Mesmas sentinelas da 20260813195914: casam a CHAMADA (`(( SELECT`), nunca a MENÇÃO — os
  -- comentários do próprio corpo citam os dois nomes, e uma sentinela que casa comentário mente
  -- (foi o que a falsificação F4 do #1718 provou).
  IF v_def !~ 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT' THEN
    RAISE EXCEPTION 'frescor-marcador: a definição VIVA não CHAMA private.cap_compras_ler — corpo divergente, NÃO sobrescreva'
      USING ERRCODE = '42501';
  END IF;
  IF v_def ~ 'pode_ver_carteira_completa\s*\(\s*\(\s*SELECT' THEN
    RAISE EXCEPTION 'frescor-marcador: a definição VIVA ainda CHAMA o gate ANTIGO — investigue antes de recriar'
      USING ERRCODE = '42501';
  END IF;
  IF v_def !~ 'AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)' THEN
    RAISE EXCEPTION 'frescor-marcador: a definição VIVA não tem o guard temporal do #1718 — corpo divergente'
      USING ERRCODE = '22000';
  END IF;

  -- ⚠️ AS 3 SENTINELAS ACIMA NÃO BASTAM, e é importante ser honesto sobre isso: elas provam que o
  -- gate e o guard estão lá, e nada mais. Qualquer mudança posterior em predicado, retorno ou lógica
  -- que PRESERVE as três passaria — e o CREATE abaixo a apagaria em silêncio. É a mesma classe do
  -- "pré-flight que vende proteção que não entrega". O hash do corpo fecha isso: só há dois corpos
  -- que esta migration sabe sobrescrever com segurança.
  --   • b0beeab8… = o corpo do #1718 (repo e PROD conferidos byte a byte em 14/08 — os dois batem)
  --   • 9d0c52aa… = o corpo QUE ESTA MIGRATION ESCREVE, para que re-colar seja inócuo (idempotência)
  -- Qualquer terceiro corpo é divergência real e falha ALTO: custa um erro no SQL Editor, e evita
  -- apagar em produção uma correção que alguém aplicou e não commitou.
  SELECT md5(p.prosrc) INTO v_md5
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'reposicao_pos_candidatos';

  IF v_md5 NOT IN ('b0beeab8e859ba980ea1e6e1db5e6c29', '9d0c52aac8d1c6f74ef19815d3232b65') THEN
    RAISE EXCEPTION 'frescor-marcador: corpo VIVO desconhecido (md5 %) — alguém alterou a RPC fora deste repo. NÃO sobrescreva às cegas: capture pg_get_functiondef da PROD, entenda a divergência e refaça a migration a partir dela.', v_md5
      USING ERRCODE = '22000';
  END IF;
END $pre$;

-- ── A RPC de candidatos, recriada com o carimbo do marcador ───────────────────────────────────
-- DROP obrigatório (ver cabeçalho). `IF EXISTS` mantém a migration re-rodável; o CASCADE fica de
-- FORA de propósito: se um dia houver dependente, queremos o erro, não a demolição silenciosa.
-- (psql-ro 14/08: 0 dependências normais.)
DROP FUNCTION IF EXISTS public.reposicao_pos_candidatos(text);

CREATE OR REPLACE FUNCTION public.reposicao_pos_candidatos(p_empresa text)
RETURNS TABLE(
  pedido_id bigint,
  omie_codigo_pedido text,
  data_ciclo date,
  idade_dias integer,
  na_janela_7d boolean,
  valor_total numeric,
  itens_sem_valor integer,
  visto_status text,
  po_no_espelho boolean,
  fornecedor_nome text,
  canal_usado text,
  portal_protocolo text,
  status_envio_portal text,
  resposta_canal jsonb,
  tem_protocolo boolean,
  tem_status_portal boolean,
  tem_resposta_canal boolean,
  tem_canal boolean,
  algum_sinal_de_canal boolean,
  marcador_run_id uuid,
  marcador_seq bigint,
  -- ⬇️ AS DUAS NOVAS, no FIM. A ordem das 21 anteriores é preservada byte a byte (mesma disciplina
  -- de VIEW: acrescentar no fim, nunca no meio) — a pós-condição fixa a assinatura inteira.
  marcador_finalizado_em timestamptz,
  apurado_em timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- ⚠️ SEM LIMITE DE FRESCOR, DE PROPÓSITO: filtrar marcador velho aqui trocaria a lista incompleta
    -- por uma lista VAZIA — o mesmo silêncio, com menos informação. O frescor vira DADO EXPOSTO
    -- (marcador_finalizado_em/apurado_em) e quem julga é o consumidor, que pode dizer "cego há Xh".
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
      -- O carimbo do marcador QUE PRODUZIU ESTA LINHA. Vem daqui, e não de uma segunda consulta, para
      -- que a idade seja a da apuração que gerou a lista: entre duas leituras independentes um run
      -- pode ser promovido, e o consumidor diria "fresco" sobre uma lista velha — falso-negativo de
      -- frescor, exatamente o lado errado para errar num alerta de money-path.
      m.finalizado_em AS marcador_finalizado_em,
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
      --
      -- ⚠️ O CUSTO DESTE GUARD, agora VISÍVEL em vez de silencioso: se o marcador congelar, este mesmo
      -- predicado esconde todo PO nascido depois dele — indefinidamente. Não dá para consertar aqui
      -- (afrouxar reintroduz os 11,0h/pedido de alerta falso). Conserta-se EXPONDO a idade do marcador,
      -- que é o que as colunas novas fazem.
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
    b.marcador_seq,
    b.marcador_finalizado_em,
    -- O "agora" do BANCO, para que a idade do marcador seja uma subtração entre dois pontos do MESMO
    -- relógio. Ver o cabeçalho: ancorar um dos lados no relógio do cliente entrega o alerta ao skew da
    -- máquina do usuário. `now()` é STABLE (o timestamp da transação) — legítimo aqui, e a RPC já o usa
    -- acima em `idade_dias`.
    now() AS apurado_em
  FROM base b
  ORDER BY (b.idade_dias BETWEEN 0 AND 7) DESC, b.valor_total DESC NULLS LAST, b.pedido_id;
END;
$function$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. LISTA e EVIDENCIA — NÃO decide. GUARD TEMPORAL (13/08/2026): PO com omie_registrado_em POSTERIOR ao finalizado_em do marcador NÃO é candidato — o carimbo de last_seen só sai no run completo (1x/dia) e um run que terminou antes de o PO existir não testemunha a ausência dele (prod: 4/4 candidatos falsos, média de 11h de alerta indevido por pedido disparado). Suprime só o IMPOSSÍVEL: registro NULL e registro durante a coleta seguem candidatos (fail-closed). FRESCOR (14/08/2026): marcador_finalizado_em + apurado_em expõem a IDADE da base de comparação, porque o marcador não tem limite de frescor — se o run completo parar, ele congela e todo PO posterior fica invisível indefinidamente, e a lista vazia passa a significar duas coisas indistinguíveis ("tudo bem" e "o detector parou"). O LIMIAR de frescor é do consumidor, não daqui. Lista VAZIA não carrega carimbo nenhum (coluna é por linha) — para esse caso use reposicao_pos_marcador(text). Deliberadamente SEM rota automática: em prod 59/59 dos disparados acionaram portal do fornecedor, então "elegível a auto-cancelamento" é logicamente vazio; e canal/status/resposta são text/jsonb livres onde regex prova presença, nunca ausência. Todo candidato exige decisão humana (provável: RECRIAR o PO, não cancelar). Sem marcador válido retorna VAZIO (fail-closed).';

REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

-- ── A RPC irmã: o marcador, SEMPRE em 1 linha ─────────────────────────────────────────────────
-- Existe por uma razão só: responder "quão velha é a base de comparação?" QUANDO NÃO HÁ CANDIDATOS.
-- É o caso em que a `reposicao_pos_candidatos` não tem como responder nada — zero linhas, zero
-- carimbo — e é justamente o caso do silêncio que este PR ataca.
--
-- ⚠️ SEMPRE 1 LINHA, com NULLs quando não há marcador (LEFT JOIN LATERAL sobre uma linha sintética).
-- Devolver ZERO linhas na ausência de marcador recriaria o bug aqui dentro: o consumidor não
-- conseguiria distinguir "não há marcador" (detector NUNCA teve base — o pior estado) de "a chamada
-- não voltou". Um NULL explícito é uma resposta; nenhuma linha é uma pergunta em aberto.
--
-- A definição de marcador é a MESMA da RPC de candidatos (maior seq com status='ok' e volume_ok).
-- Duplicada de propósito, e não extraída para uma função comum: extrair obrigaria a mexer no corpo
-- da RPC crítica (a CTE `marcador` alimenta o CROSS JOIN cujo vazio É o fail-closed), trocando um
-- risco de divergência textual por um risco de regressão de comportamento no money-path. A prova
-- PG17 fixa as duas contra o MESMO seed e falha se divergirem.
CREATE OR REPLACE FUNCTION public.reposicao_pos_marcador(p_empresa text)
RETURNS TABLE(
  marcador_run_id uuid,
  marcador_seq bigint,
  marcador_finalizado_em timestamptz,
  apurado_em timestamptz
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa public.empresa_reposicao := upper(btrim(p_empresa))::public.empresa_reposicao;
BEGIN
  -- Gate IDÊNTICO ao da RPC irmã, pela mesma razão (cron-or-staff NULL-aware; nunca auth.role()).
  -- A mensagem carrega o nome DESTA função: o consumidor distingue o gate NOSSO de um 42501 de
  -- GRANT quebrado pela sentinela, e uma sentinela compartilhada apagaria essa distinção.
  IF (SELECT auth.uid()) IS NOT NULL
     AND (SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE THEN
    RAISE EXCEPTION 'reposicao_pos_marcador: acesso negado' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.run_id, m.seq, m.finalizado_em, now()
  FROM (SELECT 1) AS sempre
  LEFT JOIN LATERAL (
    SELECT r.run_id, r.seq, r.finalizado_em
    FROM public.reposicao_pedidos_compra_run r
    WHERE r.empresa = v_empresa AND r.status = 'ok' AND r.volume_ok IS TRUE
    ORDER BY r.seq DESC
    LIMIT 1
  ) m ON TRUE;
END;
$function$;

COMMENT ON FUNCTION public.reposicao_pos_marcador(text) IS
  'Frescor do detector de PO excluído (14/08/2026). Devolve SEMPRE 1 linha com o marcador atual (maior seq com status=ok e volume_ok — a MESMA definição usada por reposicao_pos_candidatos), ou 1 linha de NULLs quando não há marcador válido. Existe porque coluna é por LINHA: com zero candidatos a RPC irmã devolve zero linhas e portanto carimbo nenhum, e é exatamente aí que "lista vazia" precisa poder significar "o detector está cego há Xh" em vez de "está tudo bem". apurado_em é o now() do BANCO para que a idade seja subtração no mesmo relógio (o do cliente tem skew). NÃO decide frescor: o limiar é do consumidor.';

REVOKE ALL ON FUNCTION public.reposicao_pos_marcador(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_marcador(text) TO authenticated, service_role;

-- ── PÓS-CONDIÇÃO ──────────────────────────────────────────────────────────────────────────────
-- Herda as 3 sentinelas do #1718 (gate novo CHAMADO, gate velho ausente, guard temporal presente) e
-- acrescenta as duas classes que o DROP+CREATE introduz — nenhuma delas visível em teste de produto:
--   • ASSINATURA EXATA: prova que as colunas novas foram ACRESCENTADAS no fim e que nenhuma das 21
--     anteriores deslocou. Comparar a assinatura INTEIRA (e não "a coluna nova existe") é o que
--     pega a troca de ordem, que o cliente lê posicionalmente e silenciosamente.
--   • ACL: o DROP apaga privilégios e o DEFAULT ACL deste projeto concede anon=X a funções novas.
--     Sem esta asserção, esquecer o REVOKE publica uma RPC de money-path para anônimo — e como isso
--     muda AUTORIZAÇÃO e não comportamento, o CI não veria.
DO $pos$
DECLARE
  v_def text := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
  v_sig constant text :=
    'TABLE(pedido_id bigint, omie_codigo_pedido text, data_ciclo date, idade_dias integer, '
    'na_janela_7d boolean, valor_total numeric, itens_sem_valor integer, visto_status text, '
    'po_no_espelho boolean, fornecedor_nome text, canal_usado text, portal_protocolo text, '
    'status_envio_portal text, resposta_canal jsonb, tem_protocolo boolean, tem_status_portal boolean, '
    'tem_resposta_canal boolean, tem_canal boolean, algum_sinal_de_canal boolean, marcador_run_id uuid, '
    'marcador_seq bigint, marcador_finalizado_em timestamp with time zone, apurado_em timestamp with time zone)';
  v_sig_irma constant text :=
    'TABLE(marcador_run_id uuid, marcador_seq bigint, marcador_finalizado_em timestamp with time zone, '
    'apurado_em timestamp with time zone)';
  r record;
BEGIN
  IF v_def !~ 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT' THEN
    RAISE EXCEPTION 'frescor-marcador: gate de authz REGREDIU — sem CHAMADA a private.cap_compras_ler' USING ERRCODE = '42501';
  END IF;
  IF v_def ~ 'pode_ver_carteira_completa\s*\(\s*\(\s*SELECT' THEN
    RAISE EXCEPTION 'frescor-marcador: gate ANTIGO (pode_ver_carteira_completa) voltou a ser CHAMADO' USING ERRCODE = '42501';
  END IF;
  IF v_def !~ 'AND \(p\.omie_registrado_em IS NULL OR p\.omie_registrado_em <= m\.finalizado_em\)' THEN
    RAISE EXCEPTION 'frescor-marcador: o guard temporal do #1718 SUMIU da definição final' USING ERRCODE = '22000';
  END IF;

  IF pg_get_function_result('public.reposicao_pos_candidatos(text)'::regprocedure) <> v_sig THEN
    RAISE EXCEPTION 'frescor-marcador: assinatura de reposicao_pos_candidatos DIVERGE do contrato. Obtida: %',
      pg_get_function_result('public.reposicao_pos_candidatos(text)'::regprocedure) USING ERRCODE = '42P13';
  END IF;
  IF pg_get_function_result('public.reposicao_pos_marcador(text)'::regprocedure) <> v_sig_irma THEN
    RAISE EXCEPTION 'frescor-marcador: assinatura de reposicao_pos_marcador DIVERGE do contrato. Obtida: %',
      pg_get_function_result('public.reposicao_pos_marcador(text)'::regprocedure) USING ERRCODE = '42P13';
  END IF;

  -- ACL das DUAS: proacl NULL = padrão embutido do PG = EXECUTE TO PUBLIC (falha aberta); entrada
  -- começando em '=' é PUBLIC explícito; 'anon=' é o que o DEFAULT ACL deste projeto injeta.
  FOR r IN
    SELECT p.oid::regprocedure::text AS fn, p.proacl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('reposicao_pos_candidatos', 'reposicao_pos_marcador')
  LOOP
    IF r.proacl IS NULL THEN
      RAISE EXCEPTION 'frescor-marcador: % ficou com ACL padrão (= EXECUTE TO PUBLIC) — o REVOKE não pegou', r.fn
        USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(r.proacl) a WHERE a::text LIKE '=%' OR a::text LIKE 'anon=%') THEN
      RAISE EXCEPTION 'frescor-marcador: % executável por anon/PUBLIC — o DROP restaurou o DEFAULT ACL. ACL: %',
        r.fn, r.proacl USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM unnest(r.proacl) a WHERE a::text LIKE 'authenticated=%') THEN
      RAISE EXCEPTION 'frescor-marcador: % sem EXECUTE para authenticated — o app perderia a RPC', r.fn
        USING ERRCODE = '42501';
    END IF;
    -- `service_role` importa tanto quanto: é por ele que edge/cron chamam. Sem esta linha, perder o
    -- grant deixaria migration E suíte verdes e quebraria só o caminho servidor, em produção.
    IF NOT EXISTS (SELECT 1 FROM unnest(r.proacl) a WHERE a::text LIKE 'service_role=%') THEN
      RAISE EXCEPTION 'frescor-marcador: % sem EXECUTE para service_role — edge/cron perderiam a RPC', r.fn
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
END $pos$;

-- Recarrega o cache de schema do PostgREST. Os event triggers `pgrst_ddl_watch`/`pgrst_drop_watch`
-- estão habilitados nesta instância (conferido por psql-ro em 14/08) e fariam isso sozinhos — mas o
-- NOTIFY é grátis e cobre o caso em que eles estiverem desabilitados. Sem a recarga, a rota
-- `reposicao_pos_marcador` continua ausente do cache, o front recebe PGRST202 e o card fica preso em
-- "não foi possível conferir" mesmo com o SQL já aplicado. Dentro da transação o NOTIFY só dispara
-- no COMMIT, que é exatamente o que se quer: nada é anunciado se a migration abortar.
NOTIFY pgrst, 'reload schema';

COMMIT;

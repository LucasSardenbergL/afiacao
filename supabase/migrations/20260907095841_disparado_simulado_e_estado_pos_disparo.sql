-- ============================================================
-- `disparado_simulado` passa a ser um estado PÓS-DISPARO — porque ele é
-- ============================================================
-- POR QUÊ: o modo `dry_run` de `disparar-pedidos-aprovados` NÃO é um dry-run. Ele chama
-- `IncluirPedCompra` INCONDICIONALMENTE e CRIA PEDIDO DE COMPRA REAL no Omie — medido no
-- `index.ts`: a chamada ao Omie acontece ANTES de `novoStatus` ser decidido, e o que o dry_run
-- muda é `cObs`/`cObsInt` mais o status gravado (`disparado_simulado` em vez de `disparado`).
-- O próprio `versao.ts` da edge já documentava isso. O nome mente; o efeito no fornecedor é o mesmo.
--
-- E `disparado_simulado` não estava protegido em lugar nenhum (medido em prod, 2026-09-07):
--   • `reposicao__valida_cancelamento_pos_disparo` (o trigger que guarda a transição) só olha
--     `OLD.status IN ('disparado','concluido_recebido')` — o simulado escapa pelo curto-circuito;
--   • a denylist do UPDATE de `cancelar_pedido_sugerido` é `NOT IN ('disparado','concluido_recebido')`
--     — o simulado passa e a linha é carimbada `cancelado_humano`.
-- Resultado: dava para marcar como cancelada uma compra que existe no Omie, sem trilha nenhuma.
--
-- POR QUE AGORA (o risco é armado, não hipotético): `empresa_configuracao_custos` tem UMA linha
-- (OBEN, `producao`) e o default do código da edge é `dry_run` quando não há config
-- (`cfg?.modo_disparo_pedidos === "producao" ? "producao" : "dry_run"`). Hoje `pedido_compra_sugerido`
-- só tem pedidos OBEN e ZERO linhas em `disparado_simulado` — então este fix não muda nenhum caso
-- existente. Ele arma a defesa ANTES da 2ª/3ª empresa começar a gerar pedidos, que é exatamente
-- quando o buraco abriria, e em silêncio.
--
-- Contexto do dano que o guard existe para impedir: 5 pedidos com `omie_pedido_compra_id`
-- preenchido constam `cancelado*` (ids 33, 281, 286, 409, 1046 — abr/jul 2026), TODOS anteriores
-- ao guard de 06/09 e nenhum com trilha em `reposicao_cancelamento_pos_disparo_audit` (0 linhas).
--
-- O QUE MUDA — 3 objetos, `CREATE OR REPLACE` (nunca DROP+CREATE, que RESETARIA o ACL):
--   1. o TRIGGER passa a vigiar `disparado_simulado` → cobre TODA via de escrita, não só a RPC;
--   2. `cancelar_pedido_sugerido` recusa com mensagem PRÓPRIA (a porta educada, sem exceção);
--   3. `corrigir_cancelamento_pos_disparo` ACEITA o estado — a saída auditada, senão o veto
--      vira armadilha: pedido simulado ficaria sem NENHUMA via de cancelamento.
-- (2) e (3) são inseparáveis de (1). Fechar a porta sem abrir a saída seria trocar um bug por outro.
--
-- ⚠️ PRÉ-VOO repo×prod (psql-ro, 2026-09-07): os corpos abaixo partem das fontes CANÔNICAS
-- verificadas idênticas à produção — trigger da 20260906152235, `corrigir` da 20260906172718
-- (o gate canônico, JÁ aplicado: confirmado `IF NOT (COALESCE(...) OR ...)` no corpo vivo) e
-- `cancelar_pedido_sugerido` da **20260906170000**, NÃO da 20260905224959: a prod está à frente
-- daquele arquivo e partir dele reverteria o guard de `status_envio_portal`. Nenhum gate regride aqui.
--
-- NÃO depende do PR #2285 (Cenário B), que segue ABERTO com `validate` vermelho: o trigger
-- `trg_veta_cancelamento_com_disparo_pendente` não existe em prod nem na main. Esta migration usa
-- o guard que JÁ está no ar e a porta GUC que ele já respeita.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. O GUARD (trigger): cobre toda via de escrita
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao__valida_cancelamento_pos_disparo()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $trg$
DECLARE
  v_portao text;
BEGIN
  -- Curto-circuito: a esmagadora maioria dos UPDATEs desta tabela não mexe em status
  -- (valor_total, portal, quantidades). Eles saem aqui, sem custo.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Só me interessa SAIR de um estado em que a compra existe no fornecedor.
  --
  -- ⚠️ `disparado_simulado` ENTRA na lista, e é toda a razão desta migration. O nome mente: o
  -- modo `dry_run` da edge `disparar-pedidos-aprovados` chama `IncluirPedCompra` INCONDICIONALMENTE
  -- (medido no index.ts: a chamada ao Omie acontece antes de `novoStatus` ser decidido) e CRIA UM
  -- PEDIDO DE COMPRA REAL no fornecedor. O que o dry_run muda é `cObs`/`cObsInt` e o status
  -- gravado aqui — não o efeito no Omie. Logo, sair de `disparado_simulado` para `cancelado*`
  -- carimba como cancelada uma compra que EXISTE, que é exatamente o dano que este trigger nasceu
  -- para impedir. Ficou de fora da lista original por acidente de nomenclatura, não por desenho.
  IF OLD.status NOT IN ('disparado', 'disparado_simulado', 'concluido_recebido') THEN
    RETURN NEW;
  END IF;

  -- ⚠️ PREFIXO, não lista. Cobre os DOIS vocabulários medidos (`cancelado` legado e
  -- `cancelado_humano`) e qualquer `cancelado_*` que nasça depois — que passa a ser barrado por
  -- DEFAULT, em vez de escapar até alguém lembrar de atualizar esta lista. A direção é
  -- deliberada: aqui errar barrando custa um round-trip; errar deixando passar custa uma compra
  -- real carimbada como cancelada. Não há CHECK constraint em `status` nesta tabela (medido —
  -- a coluna é `text` livre), então a lista fechada seria ainda mais frágil do que parece.
  IF NEW.status NOT LIKE 'cancelad%' THEN
    RETURN NEW;
  END IF;

  -- A PORTA. Carrega o id do pedido, não um booleano: autorização para UM pedido não vira
  -- autorização para o próximo UPDATE da mesma transação.
  v_portao := nullif(current_setting('app.correcao_cancelamento_pos_disparo', true), '');
  IF v_portao IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION
      '[CANCEL-POS-DISPARO-SEM-PORTAO] pedido % esta em "%" (a compra existe no fornecedor) e nao pode ir para "%" por escrita direta. Use a RPC corrigir_cancelamento_pos_disparo(), que exige evidencia e deixa trilha.',
      OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'P0001';
  END IF;

  -- REDE: mesmo com a porta aberta, a linha tem de sair carimbada. Uma RPC futura que abra o
  -- GUC e esqueça a evidência morre aqui — foi assim que a "segunda via" (#2231) nasceu.
  IF NEW.cancelamento_pos_disparo_motivo IS NULL
     OR NEW.cancelamento_pos_disparo_por IS NULL
     OR NEW.cancelamento_pos_disparo_em IS NULL
     OR length(btrim(COALESCE(NEW.cancelamento_pos_disparo_evidencia, ''))) < 4 THEN
    RAISE EXCEPTION
      '[CANCEL-POS-DISPARO-SEM-EVIDENCIA] pedido %: a porta foi aberta mas a linha nao carrega motivo/evidencia/autor/data do cancelamento junto ao fornecedor.',
      OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$trg$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. A PORTA EDUCADA: `cancelar_pedido_sugerido` recusa antes de o trigger gritar
--    Sem isto o trigger barraria mesmo assim (fail-closed), mas com uma EXCEÇÃO no lugar do
--    `{error}` que a UI sabe ler. A denylist mantém o contrato da RPC: recusa é dado, não crash.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(
  p_pedido_id bigint, p_usuario text, p_justificativa text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       bigint;
  v_status   text;
  v_portal   text;
  v_omie     text;
  v_disparo  timestamptz;
BEGIN
  -- ⚠️ Guard e escrita são UMA instrução. Não separe: é o predicado preso a este WHERE que faz
  -- o Postgres re-avaliá-lo contra a versão nova da linha depois de esperar o lock.
  UPDATE pedido_compra_sugerido
  SET status = 'cancelado_humano',
      cancelado_por = p_usuario,
      cancelado_em = NOW(),
      justificativa_cancelamento = p_justificativa,
      status_envio_portal = 'nao_aplicavel',
      portal_proximo_retry_em = NULL,
      atualizado_em = NOW()
  WHERE id = p_pedido_id
    AND status NOT IN ('disparado', 'disparado_simulado', 'concluido_recebido')
    AND COALESCE(status_envio_portal, 'nao_aplicavel') NOT IN (
          'enviando_portal', 'enviado_portal', 'sucesso_portal',
          'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao')
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada pelo predicado — esta leitura só MONTA A MENSAGEM.
  SELECT status, status_envio_portal, horario_disparo_real, omie_pedido_compra_id
    INTO v_status, v_portal, v_disparo, v_omie
    FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  IF v_status IN ('disparado', 'concluido_recebido') THEN
    RETURN jsonb_build_object('error', 'pedido já foi disparado em ' || COALESCE(v_disparo::text, '(sem carimbo)'));
  END IF;

  -- `disparado_simulado` tem mensagem PRÓPRIA porque a intuição do operador é o inimigo aqui:
  -- "simulado" soa como "não aconteceu", e é justamente o contrário. Reaproveitar a mensagem
  -- acima ("já foi disparado") seria correto e inútil — quem lê iria discordar dela e procurar
  -- outro caminho. A mensagem tem de dizer o que o nome do status esconde.
  IF v_status = 'disparado_simulado' THEN
    RETURN jsonb_build_object('error',
      'pedido em dry-run ("disparado_simulado") em ' || COALESCE(v_disparo::text, '(sem carimbo)') ||
      ' — apesar do nome, o pedido de compra FOI criado no Omie' ||
      CASE WHEN v_omie IS NOT NULL THEN ' (PO ' || v_omie || ')' ELSE '' END ||
      '. Cancele junto ao fornecedor primeiro e depois use corrigir_cancelamento_pos_disparo(), que exige evidência e deixa trilha.');
  END IF;

  IF COALESCE(v_portal, 'nao_aplicavel') IN (
       'enviando_portal', 'enviado_portal', 'sucesso_portal',
       'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao') THEN
    RETURN jsonb_build_object('error',
      'envio ao portal em ' || v_portal ||
      ' — cancelar agora deixaria o fornecedor com um pedido que aqui consta cancelado. Aguarde o desfecho ou concilie.');
  END IF;

  -- Estado cancelável AGORA mas o UPDATE não pegou ⇒ mudou entre as instruções. Não FABRICAR
  -- motivo: dizer "já está em X" seria mentira quando X é cancelável.
  RETURN jsonb_build_object('error',
    'pedido mudou de estado durante o cancelamento (estado atual: ' || COALESCE(v_status, '(desconhecido)') || ') - tente de novo');
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. A SAÍDA AUDITADA: sem ela o veto vira armadilha
--    A allowlist entra nos TRÊS pontos que decidem — o `IF` que recusa, o `WHERE` do UPDATE sob
--    lock, e a mensagem que enumera os estados. Deixar qualquer um para trás faria a função
--    aceitar na porta e devolver [ZERO-LINHAS] no fim, ou mentir sobre o que aceita.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.corrigir_cancelamento_pos_disparo(
  p_pedido_id     bigint,
  p_usuario       text,
  p_motivo        text,
  p_evidencia     text,
  p_justificativa text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid      uuid := auth.uid();
  v_agora    timestamptz := now();
  v_evid     text := btrim(COALESCE(p_evidencia, ''));
  v_ant      text;
  v_omie     text;
  v_valor    numeric;
BEGIN
  -- GATE. SECURITY DEFINER bypassa RLS ⇒ a autorização tem de ser explícita, na fronteira.
  -- A FORMA importa tanto quanto a semântica. `NOT COALESCE(gate(), false)` — o que estava aqui —
  -- é fail-CLOSED e mesmo assim REPROVA no `authz:check`: o matcher só aceita a negação como
  -- CABEÇA da condição, e ali o `false` é argumento (limite declarado em lib/authz-contract.ts).
  -- Esta forma casa o ramo `NOT ( … )` do matcher E mantém o fail-closed, com o COALESCE movido
  -- para DENTRO de cada parcela: sem ele, um ramo NULL faria `NOT (NULL)` ser NULL, o IF não
  -- dispararia e o gate falharia ABERTO — que é o defeito que o COALESCE existia para impedir.
  -- Um gate que a fronteira do CI não enxerga é um gate que ninguém defende na próxima edição.
  IF NOT (
       COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
       OR COALESCE(public.has_role(v_uid, 'master'::public.app_role), false)
       OR COALESCE(auth.role() = 'service_role', false)
     ) THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-FORBIDDEN] apenas staff corrige cancelamento pos-disparo'
      USING ERRCODE = '42501';
  END IF;

  -- Validação ANTES de qualquer escrita. Depois da primeira, toda falha teria de ser RAISE
  -- (o PostgREST commita a transação que termina sem erro SQL — lição do #2231); aqui ainda
  -- não escrevemos nada, e mesmo assim usamos RAISE para que a recusa seja indistinguível de
  -- um abort — nunca um `{error}` que uma via distraída leia como sucesso.
  IF p_motivo IS NULL OR p_motivo NOT IN
       ('cancelado_junto_ao_fornecedor', 'po_excluido_no_omie', 'duplicidade_operacional') THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-MOTIVO] motivo invalido: % (esperado cancelado_junto_ao_fornecedor | po_excluido_no_omie | duplicidade_operacional)',
      COALESCE(p_motivo, '(nulo)') USING ERRCODE = 'P0001';
  END IF;

  IF length(v_evid) < 4 THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-EVIDENCIA] evidencia obrigatoria: informe o protocolo do fornecedor, o numero do chamado ou o id do PO excluido no Omie (minimo 4 caracteres, veio %)',
      length(v_evid) USING ERRCODE = 'P0001';
  END IF;

  IF p_usuario IS NULL OR btrim(p_usuario) = '' THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-USUARIO] usuario obrigatorio' USING ERRCODE = 'P0001';
  END IF;

  -- LOCK antes de qualquer escrita. Preciso do status ANTERIOR para a trilha, e `RETURNING` só
  -- devolve os valores NOVOS (PG17 não tem `RETURNING OLD.*`). Ler antes SEM lock recriaria
  -- exatamente o TOCTOU da 20260905224959. `FOR NO KEY UPDATE` — não `FOR SHARE`, que faria dois
  -- corretores adquirirem o lock juntos e deadlockarem na promoção (achado Codex no #2231).
  SELECT status, omie_pedido_compra_id, valor_total
    INTO v_ant, v_omie, v_valor
    FROM public.pedido_compra_sugerido
   WHERE id = p_pedido_id
     FOR NO KEY UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-AUSENTE] pedido % nao encontrado', p_pedido_id
      USING ERRCODE = 'P0001';
  END IF;

  -- ALLOWLIST, não denylist (lição do #2231): esta RPC existe SÓ para o caso pós-disparo. Pedido
  -- em qualquer outro estado tem a porta normal (`cancelar_pedido_sugerido`) — esta não é atalho
  -- para ela, e deixar passar aqui seria abrir um segundo caminho sem o guard daquela.
  IF v_ant NOT IN ('disparado', 'disparado_simulado', 'concluido_recebido') THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-ESTADO] pedido % esta em "%" — a correcao pos-disparo so se aplica a disparado/disparado_simulado/concluido_recebido. Use cancelar_pedido_sugerido().',
      p_pedido_id, v_ant USING ERRCODE = 'P0001';
  END IF;

  -- Abre a porta para ESTE pedido e só para ele. `is_local => true` ⇒ morre no fim da transação
  -- mesmo se algo abaixo lançar.
  PERFORM set_config('app.correcao_cancelamento_pos_disparo', p_pedido_id::text, true);

  UPDATE public.pedido_compra_sugerido
     SET status                             = 'cancelado_humano',
         cancelado_por                      = p_usuario,
         cancelado_em                       = v_agora,
         justificativa_cancelamento         = p_justificativa,
         cancelamento_pos_disparo_motivo    = p_motivo,
         cancelamento_pos_disparo_evidencia = v_evid,
         cancelamento_pos_disparo_por       = p_usuario,
         cancelamento_pos_disparo_em        = v_agora,
         status_envio_portal                = 'nao_aplicavel',  -- mesma higiene do portal da RPC normal
         portal_proximo_retry_em            = NULL,
         atualizado_em                      = v_agora
   WHERE id = p_pedido_id
     AND status IN ('disparado', 'disparado_simulado', 'concluido_recebido');  -- redundante sob o lock; barato e fail-closed

  IF NOT FOUND THEN
    -- Sob o lock isto é inalcançável. Se acontecer, algo mudou a linha sem respeitar o lock:
    -- abortar é a única resposta honesta — jamais devolver "ok" sobre zero linhas (#2231).
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-ZERO-LINHAS] o UPDATE do pedido % nao pegou nenhuma linha sob lock', p_pedido_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Fecha a porta ANTES da trilha: nada depois deste ponto precisa dela, e uma função futura que
  -- chame esta e siga escrevendo não herda a autorização.
  PERFORM set_config('app.correcao_cancelamento_pos_disparo', '', true);

  -- A trilha. Mesma transação: se o INSERT falhar, o cancelamento não acontece. Sem trilha,
  -- sem correção — é essa a diferença entre esta porta e o SQL na mão que ela substitui.
  INSERT INTO public.reposicao_cancelamento_pos_disparo_audit
    (pedido_id, status_anterior, status_novo, motivo, evidencia, justificativa,
     omie_pedido_compra_id, valor_total, executado_por, executado_por_uid, executado_em)
  VALUES
    (p_pedido_id, v_ant, 'cancelado_humano', p_motivo, v_evid, p_justificativa,
     v_omie, v_valor, p_usuario, v_uid, v_agora);

  RETURN jsonb_build_object(
    'status', 'ok',
    'pedido_id', p_pedido_id,
    'status_anterior', v_ant,
    'omie_pedido_compra_id', v_omie,
    'motivo', p_motivo
  );
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- POSTCONDIÇÃO — a migration aborta na cara de quem colou se não pegou.
-- Os predicados são de SUFICIÊNCIA, não de existência: um objeto pode estar lá e não valer nada.
-- ────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE v_src text; v_oid oid;
BEGIN
  -- 1. o guard vigia o estado novo
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='reposicao__valida_cancelamento_pos_disparo';
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-AUSENTE]: o trigger de cancelamento pos-disparo sumiu';
  END IF;
  -- ⚠️ O predicado casa a ESTRUTURA da condicao, nao a mencao ao nome. `prosrc` inclui os
  -- COMENTARIOS, e os desta funcao citam `disparado_simulado` varias vezes: um simples
  -- `prosrc ~ 'disparado_simulado'` ficaria VERDE com a lista cega. Medido: sabotando so a
  -- linha da condicao, a versao ingenua deste assert nao abriu o bico.
  IF v_src !~ 'OLD[.]status NOT IN [(][^)]*disparado_simulado' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-CEGO]: o guard nao vigia disparado_simulado na condicao de entrada -- uma compra REAL no Omie continua cancelavel por escrita direta';
  END IF;
  IF v_src !~ 'cancelad%' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-PREFIXO]: o guard perdeu o prefixo cancelad%% -- vocabulario novo de cancelamento escaparia';
  END IF;
  IF v_src !~ 'app.correcao_cancelamento_pos_disparo' THEN
    RAISE EXCEPTION 'POST FALHOU [GUARD-SEM-PORTA]: o guard perdeu a porta GUC -- a correcao legitima ficaria sem saida';
  END IF;

  -- 2. o trigger continua ARMADO (funcao certa e habilitada). Corpo bom + trigger desarmado = nada.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE n.nspname='public' AND c.relname='pedido_compra_sugerido'
       AND t.tgname='trg_valida_cancelamento_pos_disparo'
       AND p.proname='reposicao__valida_cancelamento_pos_disparo'
       AND t.tgenabled='O' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'POST FALHOU [TRIGGER-DESARMADO]: trg_valida_cancelamento_pos_disparo nao esta armado e habilitado em pedido_compra_sugerido';
  END IF;

  -- 3. a porta educada recusa o estado novo
  SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='cancelar_pedido_sugerido';
  IF v_src !~ 'status NOT IN [(][^)]*disparado_simulado' THEN
    RAISE EXCEPTION 'POST FALHOU [DENYLIST-CEGA]: cancelar_pedido_sugerido nao barra disparado_simulado no WHERE do UPDATE';
  END IF;
  IF v_src !~ 'aceito_portal_sem_protocolo' THEN
    RAISE EXCEPTION 'POST FALHOU [REGRESSAO-PORTAL]: o guard de status_envio_portal sumiu -- este REPLACE partiu do corpo ERRADO (20260905224959 em vez da 20260906170000)';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-CANCELAR]: o ACL mudou (anon nao pode executar, authenticated deve)';
  END IF;

  -- 4. a saida auditada aceita o estado novo -- nos TRES pontos que decidem
  SELECT p.oid, p.prosrc INTO v_oid, v_src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='corrigir_cancelamento_pos_disparo';
  -- Os TRES pontos que decidem, cada um casado pela sua ESTRUTURA (contar ocorrencias do nome
  -- seria satisfeito por tres comentarios).
  IF v_src !~ 'v_ant NOT IN [(][^)]*disparado_simulado' THEN
    RAISE EXCEPTION 'POST FALHOU [SAIDA-SEM-IF]: corrigir_cancelamento_pos_disparo recusa disparado_simulado na entrada -- o veto vira armadilha, o pedido fica sem NENHUMA via de cancelamento';
  END IF;
  IF v_src !~ 'AND status IN [(][^)]*disparado_simulado' THEN
    RAISE EXCEPTION 'POST FALHOU [SAIDA-SEM-UPDATE]: o WHERE do UPDATE sob lock nao aceita disparado_simulado -- a funcao aceitaria na porta e morreria em [ZERO-LINHAS], apos abrir a GUC';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_oid) THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-INVOKER]: corrigir_cancelamento_pos_disparo deixou de ser SECURITY DEFINER';
  END IF;
  -- 5. o gate canonico da 20260906172718 NAO regrediu neste REPLACE (era o risco declarado)
  IF v_src !~ 'IF NOT \([[:space:]]*COALESCE' OR v_src !~ 'has_role' THEN
    RAISE EXCEPTION 'POST FALHOU [GATE-REGREDIU]: o gate de papel saiu da forma canonica -- este REPLACE reverteu a 20260906172718';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [ACL-CORRIGIR]: o ACL de corrigir_cancelamento_pos_disparo mudou';
  END IF;

  RAISE NOTICE 'disparado_simulado agora e estado pos-disparo: guard vigia, cancelar recusa, corrigir aceita com trilha';
END
$post$;

COMMIT;

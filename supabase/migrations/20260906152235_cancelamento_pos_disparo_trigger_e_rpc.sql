-- ============================================================
-- Cancelamento PÓS-DISPARO: o guard sai da RPC e vira TRIGGER; a correção legítima
-- ganha uma porta única que EXIGE EVIDÊNCIA e deixa trilha.
-- ============================================================
-- POR QUÊ
--   `cancelar_pedido_sugerido` recusa cancelar `disparado`/`concluido_recebido` — e está certa:
--   é a defesa contra carimbar `cancelado_humano` sobre uma compra que existe no Omie
--   (20260905224959). Faltavam duas coisas:
--
--   (1) A recusa vive DENTRO de uma RPC ⇒ só protege quem passa por ela. Medido: a tabela tem
--       `authenticated=arwdDxtm` e a RLS de UPDATE é de STAFF, não de status — qualquer
--       `UPDATE … SET status='cancelado_humano' WHERE id=…` via PostgREST, ou SQL na mão no
--       SQL Editor, escapa. É a mesma classe que a "segunda via" (#2231) e que o item 3 do
--       "o que NÃO fecha" daquela entrega ("fronteira de APLICAÇÃO, não de PRIVILÉGIO").
--       O precedente da casa é `pp_bloqueia_cancel_com_claim` (pedidos programados): sendo
--       TRIGGER, protege TODA via de escrita. É esse padrão que se aplica aqui.
--
--   (2) O caso LEGÍTIMO não tinha porta. A compra é de fato cancelada junto ao fornecedor e o
--       registro precisa refletir isso. Hoje isso se resolve com SQL na mão: sem evidência,
--       sem carimbo de quem, sem trilha. Medido em prod (2026-09-06) — CINCO linhas, não três:
--         33   cancelado_humano  PO 12076996056  reset-operacional                      portal=nao_aplicavel
--         281  cancelado_humano  PO 12098721294  lucascoelhosardenberg@gmail.com        portal=nao_aplicavel
--         286  cancelado_humano  PO 12098829067  lucascoelhosardenberg@gmail.com        portal=nao_aplicavel
--         409  cancelado         PO 12101983534  reconciliacao_manual_po_excluido_omie  portal=sucesso_portal
--         1046 cancelado         PO 12128060408  reconciliacao_manual_po_excluido_omie  portal=sucesso_portal
--       As duas últimas ESTÃO NO VOCABULÁRIO LEGADO `cancelado` — que a RPC nunca escreve — e
--       preservam `status_envio_portal='sucesso_portal'`, que a RPC SEMPRE sobrescreve para
--       `nao_aplicavel`. Esse par (status legado + higiene do portal ausente) é o discriminador
--       POSITIVO que faltava: elas NÃO passaram pela RPC. É por isso que o trigger cobre os
--       DOIS vocabulários — cobrir só `cancelado_humano` deixaria de fora justamente as duas
--       linhas cuja via está provada.
--
-- O DESENHO
--   TRIGGER `trg_valida_cancelamento_pos_disparo` (BEFORE UPDATE, FOR EACH ROW): recusa a
--   transição `disparado|concluido_recebido` → `cancelad%`, venha de onde vier. A porta é o GUC
--   `app.correcao_cancelamento_pos_disparo`, que só a RPC abre — e que carrega o ID DO PEDIDO,
--   não um "on": uma sessão autorizada para o pedido 42 não cancela o 43 de carona.
--
--   POR QUE GUC E NÃO "COLUNA DE INTENÇÃO" (a alternativa avaliada): uma coluna não fecha nada.
--   O mesmo `UPDATE` cru que carimba o status carimbaria a coluna de intenção na mesma
--   instrução — a via não-autorizada continuaria passando, e o trigger viraria decorativo. O GUC
--   fecha porque o PostgREST NÃO expõe `set_config` ao cliente (ela vive em `pg_catalog`, e o
--   cliente só alcança funções de `public`): não há request que abra a porta sem passar pela RPC.
--   Provado nos dois sentidos em `db/test-cancelamento-pos-disparo.sh` (grupo T/F).
--
--   DEFESA EM PROFUNDIDADE: mesmo com a porta aberta, o trigger EXIGE que a linha resultante
--   carregue a evidência. Assim uma RPC futura que abra o GUC e esqueça o carimbo é barrada —
--   que é exatamente como a "segunda via" do #2231 nasceu (alguém reimplementou a operação).
--
--   ALLOWLIST, NÃO DENYLIST (lição do #2231): a RPC de correção só aceita `disparado` e
--   `concluido_recebido`. Pedido em qualquer outro status tem a porta normal
--   (`cancelar_pedido_sugerido`); a de correção não é atalho para ela.
--
-- O QUE FOI MEDIDO ANTES (nenhuma transição legítima passa a ser barrada)
--   • 13 funções escrevem na tabela; só DUAS escrevem status cancelado — `cancelar_pedido_sugerido`
--     (denylist `NOT IN (disparado, concluido_recebido)`) e `remover_itens_pedido_sugerido`
--     (allowlist `IN (pendente_aprovacao, bloqueado_guardrail)`). Nenhuma faz a transição proibida.
--   • As 3 edges que escrevem na tabela gravam `disparado`, `falha_envio`, `expirado_sem_aprovacao`
--     e `status_envio_portal` — ZERO ocorrências de `cancelad*` como escrita (a única aparição é
--     `.is("cancelado_em", null)`, um filtro de leitura).
--   • O trigger curto-circuita em `NEW.status IS NOT DISTINCT FROM OLD.status`: todo UPDATE que
--     não mexe em status (recálculo de valor, portal, quantidade) sai na primeira linha.
--
--   `concluido_recebido` É INALCANÇÁVEL HOJE — medido, não deduzido: 0 linhas, e nenhuma função
--   SQL, edge ou código do front o ESCREVE (as 4 ocorrências no repo são leitura/tipo). Ele fica
--   no predicado porque é barato e porque o guard que ele espelha já o lista; NADA aqui foi
--   desenhado em cima dele. Se um dia alguém o tornar alcançável, já nasce coberto.
--
-- NOME DO TRIGGER: o Postgres dispara triggers em ordem ALFABÉTICA. `trg_valida_…` roda depois
--   de `trg_po_inexistente_antes_de_guard` e `trg_set_status_envio_portal`, então avalia o
--   `NEW.status` FINAL. Medido: nenhum dos dois escreve `NEW.status` (o segundo só o lê para
--   decidir `status_envio_portal`), mas renomear este trigger para algo que ordene ANTES deles
--   passaria a depender disso — não renomeie.
--
-- AS 5 LINHAS HISTÓRICAS FICAM COMO ESTÃO, e isto é decisão registrada, não omissão. Carimbá-las
--   retroativamente exigiria eu DECIDIR que "protocolo 2097501" escrito em texto livre vale como
--   evidência estruturada — transcrever prosa para um campo que passa a ter força de invariante.
--   Para a linha 33 ("reset operacional") seria fabricação pura: não há cancelamento junto a
--   fornecedor ali. O histórico continua legível em `justificativa_cancelamento`, e a view
--   `vw_cancelamento_pos_disparo_sem_evidencia` (criada abaixo) as mostra como o conjunto FECHADO
--   de exceções conhecidas — daqui para frente nenhuma linha nova entra nele.

BEGIN;

-- ── 1. Colunas de evidência (dedicadas — money-path NUNCA em jsonb multi-writer) ──────
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_motivo    text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_evidencia text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_por       text,
  ADD COLUMN IF NOT EXISTS cancelamento_pos_disparo_em        timestamptz;

COMMENT ON COLUMN public.pedido_compra_sugerido.cancelamento_pos_disparo_evidencia IS
  'Referência externa que sustenta o cancelamento de uma compra JÁ DISPARADA (protocolo do '
  'fornecedor, nº do chamado, id do PO excluído no Omie). O banco garante que ela EXISTE e que '
  'alguém a assinou — não que ela é verdadeira. Isso é deliberado: nenhum guard técnico verifica '
  'um protocolo; o que este exige é que ninguém cancele uma compra real sem se comprometer por escrito.';

DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.pedido_compra_sugerido'::regclass
                    AND conname = 'pedido_compra_sugerido_cancel_pos_disparo_motivo_check') THEN
    ALTER TABLE public.pedido_compra_sugerido
      ADD CONSTRAINT pedido_compra_sugerido_cancel_pos_disparo_motivo_check
      CHECK (cancelamento_pos_disparo_motivo IS NULL OR cancelamento_pos_disparo_motivo = ANY (ARRAY[
        'cancelado_junto_ao_fornecedor',  -- o fornecedor confirmou o cancelamento (exige protocolo)
        'po_excluido_no_omie',            -- o PO foi removido do ERP (é o caso das linhas 409/1046)
        'duplicidade_operacional'         -- o mesmo pedido foi disparado 2x; este é o descartado
      ]));
  END IF;
END
$chk$;

-- ── 2. Trilha de auditoria (append-only; a RPC é DEFINER e escreve, ninguém mais) ─────
CREATE TABLE IF NOT EXISTS public.reposicao_cancelamento_pos_disparo_audit (
  id                    bigserial PRIMARY KEY,
  pedido_id             bigint      NOT NULL,
  status_anterior       text        NOT NULL,
  status_novo           text        NOT NULL,
  motivo                text        NOT NULL,
  evidencia             text        NOT NULL,
  justificativa         text,
  omie_pedido_compra_id text,                  -- o PO que existe no ERP: o valor em risco
  valor_total           numeric,               -- retrato do momento, para conciliação financeira
  executado_por         text        NOT NULL,
  executado_por_uid     uuid,
  executado_em          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reposicao_cancel_pos_disparo_audit_pedido
  ON public.reposicao_cancelamento_pos_disparo_audit(pedido_id);

ALTER TABLE public.reposicao_cancelamento_pos_disparo_audit ENABLE ROW LEVEL SECURITY;

-- Staff LÊ. Não existe policy de INSERT/UPDATE/DELETE de propósito: sob RLS, ausência de policy
-- é negação. Quem escreve é só a RPC, que é SECURITY DEFINER e roda como o owner.
DROP POLICY IF EXISTS "reposicao_cancel_pos_disparo_audit_select_staff"
  ON public.reposicao_cancelamento_pos_disparo_audit;
CREATE POLICY "reposicao_cancel_pos_disparo_audit_select_staff"
  ON public.reposicao_cancelamento_pos_disparo_audit
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::public.app_role)
    OR public.has_role(auth.uid(), 'master'::public.app_role)
  );

-- Defesa em profundidade sobre a RLS: revogar NOMEANDO as roles. `REVOKE FROM PUBLIC` não tira
-- `anon`/`authenticated` no Supabase — eles têm grant EXPLÍCITO (CLAUDE.md/database.md §4), e o
-- ACL medido desta tabela-irmã confirma (`authenticated=arwdDxtm/postgres`).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_cancelamento_pos_disparo_audit
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reposicao_cancelamento_pos_disparo_audit TO anon, authenticated;

-- ── 3. O TRIGGER — fecha a CLASSE, não uma via ───────────────────────────────────────
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
  IF OLD.status NOT IN ('disparado', 'concluido_recebido') THEN
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

DROP TRIGGER IF EXISTS trg_valida_cancelamento_pos_disparo ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_valida_cancelamento_pos_disparo
  BEFORE UPDATE ON public.pedido_compra_sugerido
  FOR EACH ROW
  EXECUTE FUNCTION public.reposicao__valida_cancelamento_pos_disparo();

-- ── 4. A RPC de correção — a ÚNICA porta ─────────────────────────────────────────────
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
  -- COALESCE porque `NOT NULL` é NULL e o IF não dispararia: sem ele o gate falharia ABERTO.
  IF NOT COALESCE(
       public.has_role(v_uid, 'employee'::public.app_role)
       OR public.has_role(v_uid, 'master'::public.app_role)
       OR auth.role() = 'service_role', false) THEN
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
  IF v_ant NOT IN ('disparado', 'concluido_recebido') THEN
    RAISE EXCEPTION '[CANCEL-POS-DISPARO-ESTADO] pedido % esta em "%" — a correcao pos-disparo so se aplica a disparado/concluido_recebido. Use cancelar_pedido_sugerido().',
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
     AND status IN ('disparado', 'concluido_recebido');  -- redundante sob o lock; barato e fail-closed

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

REVOKE ALL ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.corrigir_cancelamento_pos_disparo(bigint, text, text, text, text)
  TO authenticated, service_role;

-- ── 5. O sensor: quem está cancelado com PO real e SEM evidência estruturada ──────────
-- Hoje ela devolve exatamente as 5 linhas históricas. Daqui para frente o trigger impede que
-- qualquer linha nova entre — então esta view é, ao mesmo tempo, o inventário das exceções
-- conhecidas e o alarme se o guard for removido.
CREATE OR REPLACE VIEW public.vw_cancelamento_pos_disparo_sem_evidencia
WITH (security_invoker = on) AS   -- ⚠️ REPETIR em todo REPLACE: omitir RESETA e a view passa a ler como OWNER
SELECT id, empresa, fornecedor_nome, status, omie_pedido_compra_id,
       cancelado_por, cancelado_em, justificativa_cancelamento,
       horario_disparo_real, valor_total
  FROM public.pedido_compra_sugerido
 WHERE status LIKE 'cancelad%'
   AND omie_pedido_compra_id IS NOT NULL
   AND cancelamento_pos_disparo_evidencia IS NULL;

-- ── 6. Postcondição: a migration ABORTA se não pegou, na cara de quem colou ───────────
-- Sentinelas ASCII de caixa fixa, para o harness casar sem depender de locale.
DO $post$
DECLARE
  v_rpc     oid;
  v_trgsrc  text;
  v_id      bigint;
  v_barrou  boolean := false;
  v_faltam  text;
BEGIN
  -- (a) as 4 colunas de evidência
  SELECT string_agg(c, ', ') INTO v_faltam FROM unnest(ARRAY[
    'cancelamento_pos_disparo_motivo','cancelamento_pos_disparo_evidencia',
    'cancelamento_pos_disparo_por','cancelamento_pos_disparo_em']) AS c
   WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema='public' AND table_name='pedido_compra_sugerido' AND column_name=c);
  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'POST FALHOU [COLUNAS]: faltam as colunas de evidencia (%) -- o trigger recusaria TODA correcao, inclusive a legitima', v_faltam;
  END IF;

  -- (b) o trigger existe, está HABILITADO e é BEFORE UPDATE FOR EACH ROW.
  -- `tgenabled='O'` = origin; um `ALTER TABLE ... DISABLE TRIGGER` deixaria o objeto existindo e
  -- inerte -- existir nao basta, tem de estar ARMADO.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid='public.pedido_compra_sugerido'::regclass
       AND t.tgname='trg_valida_cancelamento_pos_disparo'
       AND NOT t.tgisinternal
       AND t.tgenabled='O'
       AND (t.tgtype & 1)=1 AND (t.tgtype & 2)=2 AND (t.tgtype & 16)=16
  ) THEN
    RAISE EXCEPTION 'POST FALHOU [TRIGGER-AUSENTE]: trg_valida_cancelamento_pos_disparo nao existe, esta desabilitado, ou nao e BEFORE UPDATE FOR EACH ROW -- toda via crua voltaria a carimbar cancelamento sobre compra real';
  END IF;

  -- (c) a RPC: assinatura, SECURITY DEFINER (aqui e DESENHO: ela escreve a trilha que o
  -- `authenticated` nao pode escrever) e search_path preso.
  SELECT p.oid INTO v_rpc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='corrigir_cancelamento_pos_disparo'
     AND pg_get_function_identity_arguments(p.oid)='p_pedido_id bigint, p_usuario text, p_motivo text, p_evidencia text, p_justificativa text';
  IF v_rpc IS NULL THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-AUSENTE]: corrigir_cancelamento_pos_disparo(bigint,text,text,text,text) nao existe -- o caso legitimo ficaria SEM porta, com o trigger barrando tudo';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid=v_rpc) THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-INVOKER]: a RPC virou SECURITY INVOKER -- ela nao conseguiria gravar a trilha de auditoria e a correcao abortaria';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=v_rpc AND proconfig::text LIKE '%search_path=public, pg_temp%') THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-SEARCH-PATH]: search_path nao esta preso -- SECURITY DEFINER sem search_path preso e escalonamento de privilegio';
  END IF;
  IF has_function_privilege('anon', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-ANON]: anon executa a RPC de correcao -- o REVOKE nao pegou';
  END IF;
  IF NOT has_function_privilege('authenticated', v_rpc, 'EXECUTE') THEN
    RAISE EXCEPTION 'POST FALHOU [RPC-ACL]: authenticated nao executa a RPC -- a correcao legitima seria impossivel pela tela';
  END IF;

  -- (d) a trilha existe, com RLS LIGADA e sem policy de escrita.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.reposicao_cancelamento_pos_disparo_audit'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'POST FALHOU [AUDIT-RLS]: a tabela de trilha existe sem RLS -- vazaria valores de compra para qualquer authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
              AND tablename='reposicao_cancelamento_pos_disparo_audit' AND cmd <> 'SELECT') THEN
    RAISE EXCEPTION 'POST FALHOU [AUDIT-ESCRITA]: existe policy de escrita na trilha -- ela deixaria de ser inforjavel';
  END IF;

  -- (e) a view do sensor tem de ser security_invoker: sem isso ela le como OWNER e bypassa a RLS
  -- de pedido_compra_sugerido (falha ABERTA que o CI nao ve -- CLAUDE.md/database.md §4).
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.vw_cancelamento_pos_disparo_sem_evidencia'::regclass
                   AND reloptions::text LIKE '%security_invoker=%on%') THEN
    RAISE EXCEPTION 'POST FALHOU [VIEW-INVOKER]: a view do sensor perdeu security_invoker -- passaria a ler como OWNER, bypassando a RLS';
  END IF;

  -- (f) ESTRUTURAL: o portão tem de comparar o GUC com o ID DA LINHA. Se alguém "simplificar"
  -- para um booleano, uma sessão autorizada para um pedido passa a autorizar qualquer outro.
  v_trgsrc := (SELECT prosrc FROM pg_proc WHERE proname='reposicao__valida_cancelamento_pos_disparo');
  IF v_trgsrc !~ 'v_portao IS DISTINCT FROM OLD\.id::text' THEN
    RAISE EXCEPTION 'POST FALHOU [PORTAO-SEM-ID]: o portao nao esta amarrado ao id do pedido -- autorizacao para um pedido vazaria para os outros da mesma transacao';
  END IF;

  -- (g) EXECUÇÃO do TRIGGER (plpgsql e LATE-BOUND: `CREATE` aceita corpo invalido e so quebra em
  -- runtime -- e um trigger inerte por erro de runtime derrubaria TODO update de status desta
  -- tabela). Sonda numa linha REAL em `disparado`, dentro de um bloco com handler: o caminho
  -- ESPERADO e a RECUSA, e a excecao REVERTE o UPDATE do subtransaction -- nenhuma linha e
  -- tocada -- e no ramo em que ele NAO barra a sonda tambem se auto-reverte (ver o 22023 abaixo),
  -- de modo que ela NUNCA deixa uma linha de producao carimbada, nem se este arquivo for colado
  -- fora do `BEGIN; ... COMMIT;`.
  SELECT id INTO v_id FROM public.pedido_compra_sugerido WHERE status='disparado' LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'POST: sem linha em "disparado" para a sonda de execucao do trigger -- eixo (g) NAO exercitado nesta aplicacao';
  ELSE
    BEGIN
      UPDATE public.pedido_compra_sugerido SET status='cancelado_humano' WHERE id=v_id;
      -- Se chegou aqui, o trigger NAO barrou. Levanto uma excecao PROPRIA (SQLSTATE 22023, que o
      -- trigger nunca usa) so para forcar o ROLLBACK deste subtransaction: assim o UPDATE de
      -- sonda e revertido nos DOIS ramos, e a sonda nao depende do `BEGIN; ... COMMIT;` externo
      -- para nao deixar uma linha de PRODUCAO carimbada como cancelada.
      RAISE EXCEPTION 'sonda: trigger nao barrou' USING ERRCODE = '22023';
    EXCEPTION
      WHEN sqlstate '22023' THEN
        v_barrou := false;   -- o UPDATE indevido ja foi desfeito pelo rollback do subtransaction
      WHEN sqlstate 'P0001' THEN
        IF position('[CANCEL-POS-DISPARO-SEM-PORTAO]' in SQLERRM) > 0 THEN
          v_barrou := true;
        ELSE
          RAISE;   -- qualquer outro P0001 nao e o meu: re-lanca (Lei #2 -- nada de WHEN OTHERS 'OK')
        END IF;
    END;
    IF NOT v_barrou THEN
      RAISE EXCEPTION 'POST FALHOU [TRIGGER-INERTE]: o UPDATE cru levou o pedido % de "disparado" para "cancelado_humano" SEM ser barrado -- o guard e decorativo', v_id;
    END IF;
  END IF;

  RAISE NOTICE 'cancelamento pos-disparo: trigger ARMADO (BEFORE UPDATE ROW) e provado EXECUTANDO em linha real, RPC DEFINER com search_path preso e anon revogado, trilha com RLS sem policy de escrita, view do sensor com security_invoker.';
END
$post$;

COMMIT;

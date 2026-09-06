-- ============================================================================================
-- Cenário B do TOCTOU de reposição — a pendência de disparo (claim) que veta o cancelamento
--
-- O QUE FECHA. O #2204/20260905224959 fechou o Cenário A (o cancelamento gravando por cima de um
-- disparo JÁ commitado). Sobrou o B, descrito em docs/historico/guard-fora-da-escrita-nao-e-guard.md:
-- a RPC de cancelamento commita PRIMEIRO e a edge `disparar-pedidos-aprovados` — que já tinha
-- selecionado a linha — segue, cria o PEDIDO DE COMPRA REAL no Omie e grava por cima. O operador vê
-- "rejeitado" e a compra aconteceu.
--
-- POR QUE NÃO `FOR UPDATE` NA EDGE: a leitura e a escrita final da edge são round-trips PostgREST
-- SEPARADOS, com a chamada HTTP ao Omie no meio. Cada uma é a sua própria transação e o row lock
-- não sobrevive a ela. Lock só serializa dentro de UMA instrução/transação, e nenhuma delas pode
-- conter a chamada ao Omie.
--
-- POR QUE NÃO UM STATUS NOVO ('disparando'): arrastaria rótulos do front, KPIs, health checks e as
-- varreduras de retry/expiração. Uma COLUNA DEDICADA arbitra igual, com raio muito menor — nada em
-- `status` muda, então nada que lê `status` precisa saber que ela existe.
--
-- O ARRANJO (as duas metades só valem juntas):
--   1. a edge REIVINDICA (`reposicao_claim_disparo`) imediatamente antes de `IncluirPedCompra`. O
--      predicado de status mora no WHERE que grava ⇒ se o cancelamento já commitou, o claim pega
--      ZERO linhas e a edge NÃO chama o Omie;
--   2. um TRIGGER `BEFORE UPDATE` veta a transição para `cancelad%` enquanto a pendência existe ⇒
--      se o claim já commitou, o cancelamento ABORTA em vez de correr contra a chamada em voo — e
--      isso vale em TODA via de escrita, não só na RPC (ver a seção 3 para o porquê do trigger).
--
-- ⚠️ O CLAIM É UMA PENDÊNCIA COMPARTILHADA DA LINHA, NÃO UM MUTEX DE EXECUÇÃO. Duas consequências
-- que parecem detalhe e não são (as duas vêm de contraexemplos do parecer Codex gpt-6-astra/max
-- sobre o primeiro rascunho desta migration, que estava ERRADO nos dois pontos):
--
--   (a) O claim NÃO exige `disparo_claim_em IS NULL` — ele é IDEMPOTENTE (`COALESCE`). Exigir
--       ausência transformaria uma pendência presa (edge morta entre a chamada e a gravação) em
--       pedido travado para sempre e mataria a recuperação automática que hoje funciona: o run
--       seguinte re-dispara, o Omie recusa por `cCodIntPed` duplicado e a edge reconcilia. E o
--       `COALESCE` preserva o INÍCIO da pendência: sobrescrever o carimbo a cada tentativa faria
--       uma pendência de ontem parecer eternamente "de agora" para quem for investigar.
--
--   (b) FALHA NUNCA LIMPA O CLAIM. Só o desfecho em que a compra está REGISTRADA
--       (`disparado` / `disparado_simulado`) limpa, e na mesma instrução que grava o status. Este é
--       o ponto que derrubou o primeiro desenho: com dois runs, o `catch` de um limparia a marca do
--       OUTRO, o cancelamento voltaria a ser aceito e o run sobrevivente ainda compraria. Pelo mesmo
--       motivo um resultado externo AMBÍGUO (timeout, resposta perdida, duplicata não confirmada)
--       mantém a pendência: liberar ali recria exatamente a corrida que esta migration fecha.
--       Depois de limpo por sucesso, quem veta o cancelamento é o `status` — que já é denylist.
--
-- SAÍDA de uma pendência presa: re-disparar o pedido (o claim é retomável) até o desfecho registrado
-- — ou, se a conciliação no Omie concluir que NÃO existe PO, limpar a marca à mão, com evidência:
--   UPDATE public.pedido_compra_sugerido
--      SET disparo_claim_em = NULL, disparo_claim_por = NULL
--    WHERE id = <id> AND omie_pedido_compra_id IS NULL;
--
-- DETECTOR (sem sensor novo, sem front) — liste TODAS as marcas, sem filtrar por status nem por
-- identificador nulo, senão as combinações inconsistentes são justamente as que se escondem:
--   SELECT id, status, disparo_claim_em, disparo_claim_por,
--          now() - disparo_claim_em AS pendente_ha, omie_pedido_compra_id, status_envio_portal
--     FROM public.pedido_compra_sugerido
--    WHERE disparo_claim_em IS NOT NULL
--    ORDER BY disparo_claim_em, id;
-- Idade serve para INVESTIGAR, nunca para liberar. E ela não enxerga: efeito no portal Sayerlack
-- anterior ao claim, execução anterior ao deploy da edge nova, e órfão histórico nascido com as
-- colunas nulas.
--
-- ORDEM DE APLICAÇÃO: esta migration PRIMEIRO, o deploy da edge DEPOIS. Sem a edge nova ninguém
-- escreve `disparo_claim_em`, logo `IS NULL` é sempre verdadeiro e o cancelamento se comporta
-- exatamente como hoje — o intervalo entre as duas é seguro, só não protege ainda.
--
-- Prova: db/test-claim-disparo-cenario-b.sh (PG17 descartável, 2 conexões, barreira observada via
-- pg_blocking_pids, baseline VERMELHO com o corpo REAL de 20260905224959 + a sequência antiga da
-- edge, testemunha do PO fora da transação do pedido, dois locales).
-- ============================================================================================

BEGIN;

-- ── 1. As colunas ──────────────────────────────────────────────────────────────────────────
-- Nascem NULL nas linhas existentes (medido 2026-09-06: 516 linhas) — zero backfill, e `IS NULL`
-- já significa "sem disparo pendente" para todas elas.
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS disparo_claim_em  timestamptz,
  ADD COLUMN IF NOT EXISTS disparo_claim_por text;

COMMENT ON COLUMN public.pedido_compra_sugerido.disparo_claim_em IS
  'Pendência de disparo: NOT NULL desde que a edge disparar-pedidos-aprovados reivindicou o pedido até o desfecho REGISTRADO (disparado/disparado_simulado). Veta o cancelamento. NÃO expira por tempo e NÃO é limpa por falha — não-nula e velha = a compra pode existir no Omie sem registro local, requer conciliação.';
COMMENT ON COLUMN public.pedido_compra_sugerido.disparo_claim_por IS
  'Quem abriu a pendência (modo + run da edge). Diagnóstico apenas — nenhuma decisão lê esta coluna. Preserva o PRIMEIRO reivindicante, para casar com disparo_claim_em.';

-- ── 2. O claim ─────────────────────────────────────────────────────────────────────────────
-- SECURITY INVOKER (default) de propósito, ao contrário de `iniciar_envio_portal_pre_claim`: o
-- único chamador é a edge sob `service_role`, que já bypassa RLS, então DEFINER não compra nada —
-- e se um dia alguém conceder EXECUTE a `authenticated` por engano, INVOKER ainda faz a RLS valer
-- e o claim falha FECHADO (a edge não dispara). `search_path` preso mesmo assim.
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_status text;
  v_desde  timestamptz;
  v_atual  text;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe: o `status IN (…)` preso a ESTE WHERE é o
  -- que faz o Postgres re-avaliá-lo contra a linha recém-commitada por um cancelamento concorrente
  -- (EvalPlanQual, READ COMMITTED). Movê-lo para um SELECT acima reabre exatamente o Cenário B.
  -- ALLOWLIST, não denylist: só os dois status que a edge de fato seleciona podem ser disparados.
  -- ⚠️ `atualizado_em` NÃO é tocado de propósito. Abrir a pendência não é mudança de conteúdo do
  -- pedido, e há consumidores que medem staleness por `min(atualizado_em)` (checks do portal em
  -- 20260829012000) — renovar aquele relógio a cada tentativa de disparo esconderia pedido parado.
  -- Medido em 2026-09-06: esta tabela tem 4 triggers e NENHUM deles escreve `atualizado_em`, então
  -- a omissão de fato se mantém.
  UPDATE pedido_compra_sugerido
     SET disparo_claim_em  = COALESCE(disparo_claim_em, NOW()),
         disparo_claim_por = COALESCE(disparo_claim_por,
                                      left(COALESCE(NULLIF(btrim(p_origem), ''), 'edge'), 120))
   WHERE id = p_pedido_id
     AND status IN ('aprovado_aguardando_disparo', 'falha_envio')
  RETURNING status, disparo_claim_em INTO v_status, v_desde;

  IF v_status IS NOT NULL THEN
    -- `desde` é o carimbo EFETIVO (pode ser de uma tentativa anterior): é ele que diz à edge, e a
    -- quem for investigar, há quanto tempo esta linha tem uma compra possivelmente em aberto.
    RETURN jsonb_build_object('claimed', true, 'pedido_id', p_pedido_id,
                              'status', v_status, 'desde', v_desde);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima, pelo predicado — esta leitura serve só para MONTAR A
  -- MENSAGEM e não pode voltar a decidir nada.
  SELECT status INTO v_atual FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'pedido_id', p_pedido_id,
                              'motivo', 'pedido não encontrado');
  END IF;

  -- COALESCE porque `'texto' || NULL` colapsa a STRING INTEIRA para NULL: sem ele, se o NOT NULL de
  -- `status` algum dia cair, o motivo viraria null e o log da edge não diria por que não disparou.
  RETURN jsonb_build_object(
    'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
    'motivo', 'pedido não está mais disparável (status atual: '
              || COALESCE(v_atual, '(desconhecido)') || ')'
  );
END;
$$;

-- Chamada apenas pela edge (service_role). `REVOKE FROM PUBLIC` NÃO tira anon/authenticated no
-- schema `public` (o default privilege concede a ambos por NOME) — revogar por nome é obrigatório.
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_claim_disparo(bigint, text) TO service_role;

-- ── 3. O veto: um TRIGGER, não um predicado dentro de `cancelar_pedido_sugerido` ──────────
--
-- POR QUE TRIGGER, e não o `AND disparo_claim_em IS NULL` no WHERE daquela RPC (que foi o primeiro
-- desenho desta migration). Dois motivos, o segundo descoberto por medição:
--
--   (i)  ALCANCE. O predicado na RPC só protege QUEM PASSA PELA RPC. O trigger é política de
--        servidor na fronteira mais baixa: vale para o `UPDATE` cru do PostgREST, para
--        `remover_itens_pedido_sugerido`, e para qualquer caminho que ainda não existe. A lição
--        recorrente desta classe é justamente "allowlist do cliente não é política de servidor".
--   (ii) CONCORRÊNCIA DE ENTREGA. `bun run wt:preflight` acusou 🔴: outra worktree, em voo e sem
--        commitar (20260906170000_reposicao_selo_aprovacao_m1_expandir.sql), recria
--        `cancelar_pedido_sugerido` para fechar a corrida do PORTAL Sayerlack. Como o apply é
--        MANUAL no SQL Editor, "a última a rodar vence" apagaria em silêncio o guard da outra —
--        um dos dois guards de money-path sumiria sem ninguém ver. Não tocar naquela função
--        elimina a disputa: as duas entregas passam a ser independentes, em qualquer ordem.
--
-- ⚠️ O TRIGGER É ATÔMICO PELO MESMO MECANISMO, e isto foi MEDIDO (PG17, barreira observada com
-- `pg_blocking_pids`), não deduzido: com A segurando `UPDATE … SET disparo_claim_em = now()` e B
-- executando `UPDATE … SET status='cancelado_humano' WHERE id=… AND status NOT IN (…)`, B bloqueia,
-- espera o COMMIT de A e o trigger aborta lendo `OLD.disparo_claim_em` = o valor RECÉM-COMMITADO.
-- Em READ COMMITTED o EvalPlanQual re-busca a linha, e o BEFORE ROW roda sobre a versão nova.
--
-- UM eixo: a transição `→ cancelad%` com `OLD.disparo_claim_em IS NOT NULL`. Há uma compra
-- possivelmente em voo (ou uma tentativa que morreu no meio) e cancelar aqui carimba "rejeitado"
-- sobre um PO real.
--
-- ⚠️ PENDÊNCIA DECLARADA, para não ser lida como fechada: `disparado_simulado` continua cancelável.
-- O parecer Codex desta fatia achou o buraco — `dry_run` NÃO é dry-run: ele chama `IncluirPedCompra`
-- incondicionalmente e CRIA PEDIDO DE COMPRA REAL no Omie, só gravando `disparado_simulado` em vez
-- de `disparado`. Nem a denylist de `cancelar_pedido_sugerido` nem o
-- `trg_valida_cancelamento_pos_disparo` cobrem esse estado. E o risco não é dormente: a ÚNICA
-- empresa com linha em `empresa_configuracao_custos` é OBEN, em `producao` — qualquer empresa SEM
-- config cai no default `dry_run` do código da edge. NÃO foi fechado aqui porque fechá-lo exige
-- abrir a saída correspondente em `corrigir_cancelamento_pos_disparo` (que hoje recusa
-- `disparado_simulado` com `[CANCEL-POS-DISPARO-ESTADO]`) — e essa função foi reescrita na main
-- em 20260906172718, ainda não aplicada na prod. Recriá-la a partir do corpo VIVO reverteria o gate
-- canônico que aquela migration instala. É fatia de quem já está naquela função.
CREATE OR REPLACE FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Curto-circuito: a esmagadora maioria dos UPDATEs desta tabela não mexe em status (valor_total,
  -- portal, quantidades — e o próprio claim). Eles saem aqui, sem custo.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- PREFIXO, não lista: cobre `cancelado` (legado), `cancelado_humano` e qualquer `cancelado_*` que
  -- nasça depois, que passa a ser barrado por DEFAULT. Mesma direção deliberada do trigger irmão:
  -- errar barrando custa um round-trip; errar deixando passar custa uma compra real carimbada como
  -- cancelada. Não há CHECK em `status` nesta tabela (medido — a coluna é `text` livre).
  IF NEW.status NOT LIKE 'cancelad%' THEN
    RETURN NEW;
  END IF;

  IF OLD.disparo_claim_em IS NULL THEN
    RETURN NEW;
  END IF;

  -- ⚠️ SEM PORTA, e isso é decisão do 2º parecer Codex sobre um rascunho que TINHA porta (a GUC
  -- `app.correcao_cancelamento_pos_disparo` do trigger irmão). Uma porta significa "conciliei e sei
  -- o desfecho". Com uma pendência ABERTA ninguém sabe: uma execução ainda em voo pode comprar
  -- DEPOIS da conciliação, e "não achei PO agora" não é prova de que não haverá um.
  -- A saída é encerrar a pendência numa instrução ANTERIOR — explícita e auditável. E o Postgres
  -- força essa ordem sozinho: limpar o claim e cancelar na MESMA instrução continua barrado, porque
  -- o trigger lê OLD.
  RAISE EXCEPTION
    '[CANCEL-COM-DISPARO-PENDENTE] pedido % tem disparo pendente desde % (aberto por %): a compra pode ter sido criada no Omie e o cancelamento chegaria depois dela. Espere o disparo terminar. Se ele nao terminar: concilie no Omie e, so entao, encerre a pendencia numa instrucao propria -- UPDATE pedido_compra_sugerido SET disparo_claim_em=NULL, disparo_claim_por=NULL WHERE id=%; -- antes de cancelar.',
    OLD.id, OLD.disparo_claim_em, COALESCE(OLD.disparo_claim_por, '(sem autor)'), OLD.id
    USING ERRCODE = 'P0001';
END;
$$;

-- `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` porque o Postgres não tem `CREATE OR REPLACE TRIGGER`
-- idempotente com mudança de evento. Isto NÃO é o `DROP FUNCTION`+`CREATE` proibido: trigger não
-- carrega ACL — o ACL está na FUNÇÃO, que é recriada com `CREATE OR REPLACE` logo acima.
DROP TRIGGER IF EXISTS trg_veta_cancelamento_com_disparo_pendente ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_veta_cancelamento_com_disparo_pendente
  BEFORE UPDATE ON public.pedido_compra_sugerido
  FOR EACH ROW
  EXECUTE FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente();

-- Função de trigger não tem rota PostgREST (o Postgres nem checa EXECUTE ao dispará-la — provado em
-- db/test-authz-fecho-execute-registrado.sh). O fecho aqui é 2ª tranca, contra a chamada DIRETA.
REVOKE ALL ON FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente() FROM anon;
REVOKE ALL ON FUNCTION public.reposicao__veta_cancelamento_com_disparo_pendente() FROM authenticated;

-- ── 4. Postcondição: esta migration ABORTA se não pegou ────────────────────────────────────
-- Cada RAISE carrega um sentinela ASCII de caixa fixa, para o harness casar sem depender de locale.
DO $post$
DECLARE
  v_src text;
  v_up  text;
  v_ret jsonb;
BEGIN
  -- (a) as colunas existem, com o tipo certo
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pedido_compra_sugerido'
       AND column_name = 'disparo_claim_em' AND data_type = 'timestamp with time zone'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'pedido_compra_sugerido'
       AND column_name = 'disparo_claim_por'
  ) THEN
    RAISE EXCEPTION '[CLAIM-COLUNAS] disparo_claim_em/disparo_claim_por nao existem em pedido_compra_sugerido -- a edge chamaria a RPC de claim contra uma coluna ausente (42703) e o Cenario B segue aberto';
  END IF;

  -- (b) a RPC de claim existe, com a assinatura EXATA que a edge chama
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reposicao_claim_disparo'
     AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_origem text';
  IF v_src IS NULL THEN
    RAISE EXCEPTION '[CLAIM-RPC-AUSENTE] public.reposicao_claim_disparo(bigint, text) nao existe -- a edge nao tem como reivindicar antes de chamar o Omie';
  END IF;

  -- (c) o predicado de status mora DENTRO do UPDATE do claim (a lição inteira desta classe)
  v_up := substring(v_src from 'UPDATE\s+pedido_compra_sugerido.*?RETURNING');
  IF v_up IS NULL OR v_up NOT LIKE '%status IN (''aprovado_aguardando_disparo'', ''falha_envio'')%' THEN
    RAISE EXCEPTION '[CLAIM-GUARD-FORA-DO-UPDATE] a allowlist de status do claim nao esta no WHERE que grava -- o claim decidiria sobre um retrato e o Cenario B segue aberto';
  END IF;

  -- (c2) o claim é IDEMPOTENTE: sobrescrever o carimbo faria pendencia velha parecer nova
  IF v_up NOT LIKE '%COALESCE(disparo_claim_em, NOW())%' THEN
    RAISE EXCEPTION '[CLAIM-NAO-IDEMPOTENTE] o claim sobrescreve disparo_claim_em em vez de preserva-lo -- uma pendencia de ontem apareceria como "de agora" para quem investigar';
  END IF;

  -- (d) o EXECUTE do claim NAO alcanca anon nem authenticated, e alcanca service_role
  IF has_function_privilege('anon', 'public.reposicao_claim_disparo(bigint, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reposicao_claim_disparo(bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '[CLAIM-ACL] reposicao_claim_disparo continua executavel por anon/authenticated -- qualquer sessao poderia abrir uma pendencia e travar o cancelamento do pedido';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.reposicao_claim_disparo(bigint, text)', 'EXECUTE') THEN
    RAISE EXCEPTION '[CLAIM-ACL-SERVICE] service_role perdeu o EXECUTE de reposicao_claim_disparo -- a edge nao conseguiria reivindicar e NENHUM pedido seria disparado';
  END IF;

  -- (e) o TRIGGER existe, no evento certo, e a funcao dele carrega os dois eixos
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.pedido_compra_sugerido'::regclass
       AND t.tgname = 'trg_veta_cancelamento_com_disparo_pendente'
       AND NOT t.tgisinternal
       AND t.tgtype & 2 <> 0   -- BEFORE
       AND t.tgtype & 1 <> 0   -- FOR EACH ROW
       AND t.tgtype & 16 <> 0  -- UPDATE
  ) THEN
    RAISE EXCEPTION '[VETO-TRIGGER-AUSENTE] trg_veta_cancelamento_com_disparo_pendente nao esta instalado como BEFORE UPDATE FOR EACH ROW -- o Cenario B segue aberto em TODAS as vias de escrita';
  END IF;

  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'reposicao__veta_cancelamento_com_disparo_pendente';
  IF v_src IS NULL
     OR v_src NOT LIKE '%OLD.disparo_claim_em IS NULL%'
     OR v_src NOT LIKE '%cancelad%%' THEN
    RAISE EXCEPTION '[VETO-EIXOS] a funcao do trigger perdeu o predicado da pendencia ou o prefixo cancelad%% -- ela ficaria instalada sem barrar o Cenario B';
  END IF;

  -- (e2) o veto RODA: uma transicao proibida tem de abortar aqui dentro, agora. plpgsql e
  -- late-bound, entao instalar o trigger nao prova que ele barra nada.
  --
  -- A sonda insere UMA linha e a desfaz. Dois cuidados, os dois medidos:
  --   * o id e EXPLICITO e NEGATIVO (abaixo do minimo atual), nao vindo da sequence: `nextval`
  --     nunca produz negativo, entao ele nao colide com linha existente nem com INSERT concorrente
  --     -- e nao depende de a sequence estar sincronizada, que e como esta sonda quebrou no PG17
  --     descartavel do harness (`RESTART IDENTITY` + ids explicitos deixam a sequence atras);
  --   * tudo roda dentro do bloco `EXCEPTION`, que e um SAVEPOINT: quando o trigger aborta, o
  --     INSERT e revertido junto -- incluindo o evento que o trigger de outbox teria gravado.
  --     Nenhuma linha, e nenhum efeito, sobrevive a esta sonda.
  DECLARE
    v_sonda_id bigint := LEAST(COALESCE((SELECT min(id) FROM pedido_compra_sugerido), 0), 0) - 1;
  BEGIN
    BEGIN
      INSERT INTO pedido_compra_sugerido (id, empresa, status, disparo_claim_em)
      VALUES (v_sonda_id, '__postcondicao__', 'aprovado_aguardando_disparo', NOW());
      UPDATE pedido_compra_sugerido SET status = 'cancelado_humano' WHERE id = v_sonda_id;
      RAISE EXCEPTION '[VETO-NAO-RODA] o trigger deixou passar um cancelamento com disparo pendente -- ele esta instalado e nao barra nada';
    EXCEPTION
      WHEN sqlstate 'P0001' THEN
        IF SQLERRM LIKE '%[VETO-NAO-RODA]%' THEN RAISE; END IF;
        IF SQLERRM NOT LIKE '%[CANCEL-COM-DISPARO-PENDENTE]%' THEN
          RAISE EXCEPTION '[VETO-MOTIVO-ERRADO] o trigger abortou por outro motivo: %', SQLERRM;
        END IF;
    END;
    -- Defesa em profundidade: se algum dia o bloco acima sair sem exceção, a linha nao fica.
    DELETE FROM pedido_compra_sugerido WHERE id = v_sonda_id;
  END;

  -- (f) plpgsql e LATE-BOUND: `CREATE` passa e a funcao so falha em RUNTIME. Executa as duas
  -- contra `NULL::bigint` -- um id que NUNCA casa uma PK, sob qualquer concorrencia (usar
  -- `min(id)-1` seria escolher justamente o id que um INSERT nao-commitado esta prestes a
  -- materializar: sequence crescente nao ordena commits).
  v_ret := public.reposicao_claim_disparo(NULL::bigint, 'postcondicao');
  IF v_ret IS NULL OR (v_ret ->> 'claimed') <> 'false' THEN
    RAISE EXCEPTION '[CLAIM-EXEC-LATE-BOUND] reposicao_claim_disparo nao devolveu claimed=false para um id inexistente (veio %) -- ela nao roda de verdade', COALESCE(v_ret::text, '(null)');
  END IF;
  RAISE NOTICE 'pendencia de disparo instalada: colunas + reposicao_claim_disparo (service_role) + trigger de veto em TODAS as vias de escrita';
END
$post$;

COMMIT;

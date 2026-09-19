-- ============================================================================================
-- APLICAÇÃO via `bun run db:aplicar` — reconciliar_pedidos_omie carrega o desconto da linha e
-- isola a coerência POR PEDIDO (o conserto do incidente que parou o reprocesso 10 dias)
--
-- Mesmo EFEITO da migration `20260914180104_reconciliar_carrega_desconto_e_isola_coerencia.sql`
-- (PR #2496), SEM os envelopes `BEGIN;`/`COMMIT;`: a transação é do `db:aplicar`, que executa o
-- corpo via `aplicar_sql()` — e lá comandos de transação são proibidos.
--
-- A PARIDADE é derivada, não digitada: este arquivo é a migration menos as duas linhas de
-- envelope. Conferir com
--   diff <(sed '/^BEGIN;$/d;/^COMMIT;$/d' supabase/migrations/20260914180104_reconciliar_carrega_desconto_e_isola_coerencia.sql) \
--        <(sed '1,/^-- FIM DO CABEÇALHO DESTE ARQUIVO$/d' db/aplicar-reconciliar-desconto-e-coerencia.sql)
-- tem de sair VAZIO.
--
-- ⚠️ ESTE SQL É METADE DO CONSERTO. A outra metade é o DEPLOY DA EDGE `sync-reprocess` (v1.8) no
-- Lovable, que é manual e fora do merge (CLAUDE.md: merge ≠ produção). Sem a edge nova, o eixo do
-- DESCONTO degrada para o comportamento anterior — e isso é por construção, não acidente: o
-- payload sem a chave `desconto_valor` dá NULL, que é a invalidação de antes ("a base mudou e
-- ninguém mediu o desconto dela"), nunca um número fabricado. O eixo que conserta o INCIDENTE —
-- um pedido incoerente virar falha DO PEDIDO em vez de derrubar a chamada inteira — é puramente
-- SQL e passa a valer já com este apply.
-- FIM DO CABEÇALHO DESTE ARQUIVO
-- ============================================================
-- reconciliar_pedidos_omie CARREGA o desconto da linha — e UM pedido incoerente deixa de
-- derrubar a run inteira
--
-- Três correções na MESMA função, e por isso numa migration só: duas migrations recriando o
-- mesmo objeto brigam no apply manual — a última a recriar VENCE (database.md §2).
--
-- ── 1 · O desconto da linha ─────────────────────────────────────────────────────────────────────
-- A reconciliação não recebia `desconto_valor`. Invalidava para NULL quando qtd/preço/produto
-- mudavam e inseria linha nova com NULL — e, quando SÓ o desconto mudava no Omie, o UPDATE nem
-- disparava: a linha ficava com o desconto VELHO enquanto o cabeçalho, desde o #2469, recebe o
-- total LÍQUIDO novo. Linha 1×100 com desconto 10; o Omie muda só o desconto para 20; o pai vira
-- 80, a linha segue 10, e `fin-valor-cockpit` calcula 90.
--
-- Agora cada item do payload traz `desconto_valor` — a régua `descontoItemOmie` sobre a mesma
-- base qty·preço do subtotal (sync-reprocess v1.8) — e a função:
--   · separa chave AUSENTE (edge anterior: regra antiga, invalida quando a base muda) de chave
--     PRESENTE (a leitura atual; `null` = a régua não soube ler → NULL, nunca 0);
--   · trata o desconto como motivo próprio de escrita, NULL-safe;
--   · grava o desconto lido no UPDATE e no INSERT, sem coalesce em lugar nenhum, com a régua de
--     finitude do preço (negativo, NaN e Infinity viram NULL);
--   · conta CORREÇÃO de desconto conhecido em `corrections`, mas não a APURAÇÃO NULL→valor
--     (convergência do acervo: 1.024 linhas NULL na janela de 30 dias em 2026-09-14), e publica
--     as duas como sensores, `desconto_corrigido` e `desconto_apurado`.
--
-- ── 2 · A escrita converge EXATAMENTE no que a coerência do agregado fiscaliza ──────────────────
-- O trigger de coerência (20260907220000) exige multiconjunto IGUAL entre linhas e items-jsonb em
-- (produto, quantidade, preço, desconto legado). O UPDATE decidia por TOLERÂNCIA (1e-6, com
-- discount NULL ≈ 0) e NÃO gravava o produto, então dois caminhos produziam escrita que o próprio
-- banco recusa (achados do parecer Codex, 2026-09-14):
--   · linha casada por `omie_codigo_item` cujo SKU mudou no Omie: product_id e hash novos, mas
--     `omie_codigo_produto` VELHO na linha e novo no jsonb;
--   · diferença abaixo da tolerância: a linha fica, o jsonb recebe o valor exato.
-- Agora o SKU é gravado e a DECISÃO de escrever usa igualdade exata. A tolerância segue só na
-- CLASSIFICAÇÃO das métricas: ruído converge a linha sem contar como correção.
--
-- ── 3 · Um pedido incoerente vira `falha` do pedido, não da chamada (incidente vivo) ────────────
-- Os triggers de coerência são DEFERRABLE INITIALLY DEFERRED: checam no COMMIT, que aqui é o da
-- CHAMADA — fora do BEGIN/EXCEPTION por pedido. Uma única escrita incoerente derrubava a chamada,
-- a página e a run. Medido em prod: o reprocesso de pedidos da oben não completa desde
-- 2026-09-08 20:15 UTC — 79 runs em erro (73 operacionais + 6 estratégicas), TODAS no mesmo pedido
-- (7b6f5f03…, omie 12180025234), e nenhum pedido da janela reconciliado desde então.
-- Agora cada pedido que escreveu chama `pedido_venda_exigir_coerencia(v_order_id)` — o MESMO
-- predicado dos triggers — dentro da própria subtransação: o 23514 cai no WHEN
-- integrity_constraint_violation, o pedido é revertido INTEIRO e vai para `falhas`, e o lote segue.
-- Os triggers ficam como a defesa do COMMIT. E os contadores só somam o pedido DEPOIS da checagem:
-- trabalho revertido não é contado.
--
-- GERADA A PARTIR DA PRODUÇÃO: o corpo base é o `pg_get_functiondef` vivo de 2026-09-14,
-- md5(prosrc) 136b40ad30ac7bec2a8105907b1e9fa6 — idêntico à seção 3/3 de 20260908215704. A
-- PRÉ-CONDIÇÃO abaixo recusa aplicar por cima de qualquer outro corpo.
--
-- COMPATIBILIDADE — a ordem de deploy é livre, mas o defeito do desconto só fecha com as DUAS:
--   migration nova + edge velha → payload sem a chave: mesmo estado e mesmo retorno de antes em
--                                  todo caminho que antes commitava (diferencial em
--                                  db/test-desconto-valor-escritores.sh §I), mais as correções 2 e 3;
--   migration velha + edge nova → a RPC antiga ignora a chave (pai 80 com linha 90 segue possível),
--                                  e os sensores chegam AUSENTES — a edge os grava null, não 0.
--
-- NÃO MEXE em `discount` (legado), em criar_pedidos_com_itens nem em aplicar_edicao_pedido_omie.
-- ============================================================


-- ── PRÉ-CONDIÇÃO: aplicar só sobre o corpo que foi medido, ou sobre o próprio corpo novo ──────────
DO $pre$
DECLARE
  v_oid oid := to_regprocedure('public.reconciliar_pedidos_omie(jsonb,text[],timestamp with time zone)');
  v_md5 text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRÉ-CONDIÇÃO: public.reconciliar_pedidos_omie(jsonb,text[],timestamptz) não existe — aplique antes a cadeia dela (até 20260908215704).';
  END IF;
  SELECT md5(prosrc) INTO v_md5 FROM pg_proc WHERE oid = v_oid;
  IF v_md5 NOT IN ('136b40ad30ac7bec2a8105907b1e9fa6', '49a16ad05acb94066233b9692919570c') THEN
    RAISE EXCEPTION 'PRÉ-CONDIÇÃO: o corpo vivo de reconciliar_pedidos_omie (md5 %) não é o de 20260908215704 nem o desta migration — outra entrega o recriou. Regenere a partir do pg_get_functiondef atual em vez de aplicar por cima.', v_md5;
  END IF;
  IF to_regprocedure('public.pedido_venda_exigir_coerencia(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRÉ-CONDIÇÃO: public.pedido_venda_exigir_coerencia(uuid) não existe — aplique antes 20260907220000 (coerência do agregado).';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie(p_pedidos jsonb, p_status_gerido_omie text[], p_lido_em timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  -- Espelho da autoridade `STATUS_OMIE` (TS `_shared/omie-pedido.ts`): os status cujo dono é o
  -- Omie. Status app-avançado (`confirmado`, `entregue`, ...) NÃO está aqui de propósito — quem
  -- reconcilia por cima dele apaga trabalho humano.
  c_status_omie  constant text[] := ARRAY['importado','separacao','enviado','faturado','cancelado'];
  -- Teto do LOTE. A página do ListarPedidos é de 100; 500 é folga. NÃO é parâmetro: um limite que
  -- o chamador contorna passando um número maior não é limite (achado do challenge do #2132).
  c_max_pedidos  constant integer := 500;

  v_pedido        jsonb;
  v_account       text;
  v_hash          text;
  v_status_omie   text;
  v_itens         jsonb;
  v_items_json    jsonb;
  v_total_novo    numeric;

  v_order_id      uuid;
  v_customer      uuid;
  v_status_atual  text;
  v_total_atual   numeric;
  v_status_novo   text;

  v_n_validos     integer;
  v_n_distintos   integer;
  v_n_id_desej    integer;   -- itens do DESEJADO que trazem omie_codigo_item
  v_n_id_desej_d  integer;   -- ...quantos valores DISTINTOS
  v_atual_dup     integer;
  v_atual_id_dup  integer;   -- linhas ATUAIS com omie_codigo_item repetido (o lado do BANCO)
  v_ident         boolean;   -- este pedido pode ser diffado por IDENTIDADE DE LINHA
  v_items_atual   jsonb;
  v_subtotal_atual numeric;
  v_lido_atual    timestamptz;
  v_cab_mudou     boolean;
  v_stale         integer := 0;
  v_ambiguo       integer := 0;
  v_del int; v_upd int; v_ins int; v_adot int; v_apur int; v_corr int; v_upd_tot int;
  -- O que ESTE pedido soma aos totais. Só é somado depois da checagem de coerência (fim do
  -- laço): o rollback da subtransação desfaz o banco, não as variáveis, e um pedido revertido
  -- não pode deixar trabalho contado.
  v_usou_id       boolean;
  v_conta_upsert  boolean;
  v_conta_diverg  boolean;
  v_itens_mudaram boolean;
  v_status_mudou  boolean;
  v_total_mudou   boolean;

  v_upserts       integer := 0;
  v_divergences   integer := 0;
  v_corrections   integer := 0;
  v_sku_repetido  integer := 0;
  v_sem_item      integer := 0;
  v_sem_pai       integer := 0;
  v_id_adotada    integer := 0;   -- linhas que GANHARAM omie_codigo_item nesta chamada (sensor)
  v_id_usada      integer := 0;   -- pedidos diffados por identidade de linha (sensor)
  -- SENSORES do desconto da linha (ver o UPDATE). Só o 2º é correção de conteúdo; o 1º é
  -- convergência do acervo: linha que sai de NÃO APURADO para um valor lido do Omie.
  v_desc_apur     integer := 0;   -- linhas cujo desconto_valor saiu de NULL para um valor
  v_desc_corr     integer := 0;   -- linhas cujo desconto CONHECIDO mudou (inclusive para NULL)
  v_falhas        jsonb   := '[]'::jsonb;
BEGIN
  IF p_pedidos IS NULL OR jsonb_typeof(p_pedidos) <> 'array' THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_pedidos deve ser array jsonb (veio %)', jsonb_typeof(p_pedidos)
      USING ERRCODE = '22023';
  END IF;

  -- FAIL-CLOSED na lista de status geridos pelo Omie, ANTES do loop: se a lista divergiu, NENHUM
  -- pedido deve ser tocado. Não basta "não-vazia e sem NULL" — uma lista que ACRESCENTE
  -- `confirmado` faria a reconciliação rebaixar um pedido que o time já avançou à mão, e uma que
  -- OMITA `importado` congelaria pedidos legítimos em silêncio. Exigir IGUALDADE DE CONJUNTO
  -- promove a paridade TS↔SQL de guard de teste a invariante EXECUTÁVEL em produção — a mesma
  -- forma que `apriori_universo_snapshot` usa para a denylist de status (#2132).
  IF p_status_gerido_omie IS NULL
     OR (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_status_gerido_omie) x) IS DISTINCT FROM
        (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(c_status_omie) x)
  THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: lista de status geridos pelo Omie divergente da canônica (recebido %, esperado %) — reconciliar status com outra lista é clobberar status app-avançado ou congelar pedido legítimo',
      p_status_gerido_omie, c_status_omie
      USING ERRCODE = '22023';
  END IF;

  -- Ausente ≠ "agora". Assumir `now()` faria toda chamada parecer a mais fresca de todas e
  -- desligaria o CAS em silêncio — a leitura velha voltaria a vencer.
  IF p_lido_em IS NULL THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_lido_em ausente — sem o instante da leitura não há como barrar escrita de revisão VELHA'
      USING ERRCODE = '22023';
  END IF;
  -- Leitura no futuro é relógio torto do chamador, e um carimbo torto envenena o CAS de todos os
  -- runs seguintes (nenhum deles conseguiria mais escrever). Tolerância de 1 min para skew.
  IF p_lido_em > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: p_lido_em no futuro (% > %) — relógio do chamador envenenaria o compare-and-set', p_lido_em, now()
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_pedidos) > c_max_pedidos THEN
    RAISE EXCEPTION 'reconciliar_pedidos_omie: lote de % pedidos excede o teto de % — divida a chamada (truncar em silêncio seria pior)',
      jsonb_array_length(p_pedidos), c_max_pedidos
      USING ERRCODE = '54000';
  END IF;

  -- ⚠️ ORDEM DETERMINÍSTICA (achado do challenge). Uma chamada é UMA transação: os locks dos
  -- pedidos já processados ficam presos até o fim dela. Dois lotes contendo os mesmos pedidos em
  -- ordens diferentes — inclusive cruzando com `criar_pedidos_com_itens` — formam ciclo AB/BA e
  -- deadlockam. Ordenar por (account, hash_payload) faz toda chamada pegar os locks na MESMA
  -- ordem, o que torna o ciclo impossível em vez de improvável.
  FOR v_pedido IN
    SELECT e FROM jsonb_array_elements(p_pedidos) e
     ORDER BY e->>'account', e->>'hash_payload'
  LOOP
    -- ── subtransação por pedido (G9 da irmã): um pedido ruim não derruba os outros, e o que ele
    --    tiver escrito até o erro é DESFEITO — que é justamente a atomicidade lógica pedida aqui.
    --    Substitui o "grava itens primeiro, cabeçalho só se nenhum item falhou" que o TS fazia à
    --    mão, e que nunca cobriu a falha ENTRE dois writes de item. ──
    BEGIN
      v_order_id := NULL;
      v_del := 0; v_upd := 0; v_ins := 0; v_adot := 0; v_apur := 0; v_corr := 0; v_upd_tot := 0;
      v_usou_id := false; v_conta_upsert := false; v_conta_diverg := false;

      v_account     := v_pedido->>'account';
      v_hash        := v_pedido->>'hash_payload';
      v_status_omie := v_pedido->>'status_omie';   -- NULL = etapa desconhecida (o TS já decidiu)
      v_itens       := coalesce(v_pedido->'itens', '[]'::jsonb);
      v_items_json  := v_pedido->'items';

      IF v_account IS NULL OR v_hash IS NULL THEN
        RAISE EXCEPTION 'pedido sem account/hash_payload' USING ERRCODE = '22023';
      END IF;

      -- Ausente ≠ zero (money-path §2). `total` faltando NÃO vira 0: zerar o total de um pedido
      -- real é fabricar número no caminho da positivação/comissão. Idem `items`, cuja ausência
      -- não pode virar `[]` — isso APAGARIA o retrato do pedido no cabeçalho.
      IF (v_pedido->>'total') IS NULL THEN
        RAISE EXCEPTION 'pedido % sem total — ausente não é zero', v_hash USING ERRCODE = '22023';
      END IF;
      v_total_novo := (v_pedido->>'total')::numeric;
      IF v_items_json IS NULL OR jsonb_typeof(v_items_json) <> 'array' THEN
        RAISE EXCEPTION 'pedido % sem items (jsonb array) — ausente não é lista vazia', v_hash USING ERRCODE = '22023';
      END IF;
      IF v_status_omie IS NOT NULL AND NOT (v_status_omie = ANY (c_status_omie)) THEN
        RAISE EXCEPTION 'pedido % com status_omie desconhecido (%)', v_hash, v_status_omie USING ERRCODE = '22023';
      END IF;

      -- [A4/G7] guard de leitura vazia/malformada: sem item VÁLIDO o pedido NÃO é reconciliado —
      -- nem itens nem cabeçalho. Um ListarPedidos degenerado não pode zerar o total de um pedido
      -- real nem apagar seus itens.
      SELECT count(*),
             count(DISTINCT (it->>'omie_codigo_produto')::bigint),
             count(*) FILTER (WHERE (it->>'omie_codigo_item') IS NOT NULL),
             count(DISTINCT (it->>'omie_codigo_item')::bigint)
        INTO v_n_validos, v_n_distintos, v_n_id_desej, v_n_id_desej_d
        FROM jsonb_array_elements(v_itens) AS it
       WHERE (it->>'omie_codigo_produto') IS NOT NULL;
      IF v_n_validos = 0 THEN
        v_sem_item := v_sem_item + 1;
        CONTINUE;
      END IF;

      -- ── G-a: identidade repetida no DESEJADO. Dois itens do payload com o mesmo `codigo_item`
      --    é payload contraditório: a chave que existe para desempatar está empatada. Casar por
      --    ela produziria dois UPDATEs sobre a mesma linha local (ou um INSERT fantasma), e
      --    persistir o valor repetido envenenaria o estado — na run seguinte o `G-b` pararia o
      --    pedido para sempre. Fail-closed aqui, antes de qualquer escrita.
      IF v_n_id_desej > 0 AND v_n_id_desej_d <> v_n_id_desej THEN
        v_ambiguo := v_ambiguo + 1;
        CONTINUE;
      END IF;

      -- Identidade só vale quando é COMPLETA no desejado. Payload parcialmente identificado
      -- (item de kit, por exemplo, que a doc do Omie marca como podendo não trazer o código) cai
      -- no caminho legado INTEIRO: misturar duas chaves de casamento no mesmo pedido é convidar
      -- de volta a classe de defeito que esta função existe para fechar.
      v_ident := (v_n_id_desej = v_n_validos);

      -- Identidade IMUTÁVEL: o pai vem pelo hash determinístico (único pelo índice parcial
      -- uniq_sales_orders_omie_hash), NUNCA por omie_numero_pedido — pegaria a linha errada
      -- (causa-raiz #B). `FOR UPDATE` serializa contra `criar_pedidos_com_itens`, que trava o
      -- mesmo pai. Sem pai não há o que reconciliar: quem INSERE é o omie-vendas-sync.
      -- P1-3: `items`/`subtotal`/`omie_reconciliado_em` entram na leitura porque entram na DECISÃO.
      SELECT id, customer_user_id, status, total, items, subtotal, omie_reconciliado_em
        INTO v_order_id, v_customer, v_status_atual, v_total_atual,
             v_items_atual, v_subtotal_atual, v_lido_atual
        FROM public.sales_orders
       WHERE account = v_account AND hash_payload = v_hash
       FOR UPDATE;
      IF v_order_id IS NULL THEN
        v_sem_pai := v_sem_pai + 1;
        CONTINUE;
      END IF;

      -- ── P1-2: COMPARE-AND-SET. Uma leitura mais VELHA que a que produziu o estado atual não
      --    escreve. Sem isto, o `FOR UPDATE` garante que as escritas não se entrelaçam, mas não
      --    que a ÚLTIMA a chegar é a mais NOVA — e o banco fica atomicamente errado. `>=` e não
      --    `>`: duas páginas do MESMO run trazem o mesmo carimbo e a segunda não pode ser barrada,
      --    então o empate só é rejeitado quando nada mudaria de qualquer forma — por isso o
      --    empate PASSA e só o estritamente ANTERIOR é recusado.
      IF v_lido_atual IS NOT NULL AND p_lido_em < v_lido_atual THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;

      -- ── P1-1 (achado do challenge, MEDIDO em prod: 1.179 pares repetidos em 1.049 pedidos
      --    Omie vivos): `omie_codigo_produto` NÃO é identidade de linha, e a duplicidade tem DOIS
      --    lados. O guard antigo olhava só o conjunto desejado, e com isso:
      --      · duplicata no estado ATUAL caía toda no `UPDATE` (`d.cod = a.cod`), as duas linhas
      --        recebiam o MESMO conteúdo, nenhuma era deletada — e o cabeçalho passava a
      --        descrever UMA linha enquanto existiam duas. Apriori e cockpit DOBRAM o valor.
      --      · duplicata no DESEJADO pulava os itens mas reconciliava o cabeçalho — "filhos
      --        velhos + cabeçalho novo", que é a revisão MISTA que esta função existe para
      --        eliminar. O antigo assert C6 exigia esse comportamento: o teste protegia o defeito.
      --    Enquanto não houver identidade de linha persistida (`det.ide.codigo_item` — correção
      --    ESTRUTURAL, escopo próprio, exige backfill das ~70 mil linhas vivas), o desfecho certo
      --    é NÃO TOCAR NO PEDIDO: nem itens, nem cabeçalho. Precisão > recall — um pedido que
      --    fica na revisão anterior COMPLETA é honesto; um pedido com valor dobrado, não.
      -- ── G-b: identidade repetida no ATUAL — O LADO DO BANCO. Este é o lado que a versão
      --    anterior desta função esqueceu na chave antiga, e o motivo de o parecer ter BLOQUEADO
      --    a entrega. A chave mudou; a armadilha não. Duas linhas locais com o mesmo
      --    `codigo_item` casariam AMBAS com o mesmo item desejado no nível 1: as duas recebem o
      --    conteúdo dele, nenhuma é deletada, e o item que ficou sem par é inserido por cima — o
      --    pós-estado deixa de ser o desejado. Vale SEMPRE, inclusive no caminho legado, porque o
      --    ESTADO pode carregar identidade mesmo quando o payload de hoje não traz.
      SELECT count(*) INTO v_atual_id_dup FROM (
        SELECT 1 FROM public.order_items
         WHERE sales_order_id = v_order_id AND omie_codigo_item IS NOT NULL
         GROUP BY omie_codigo_item HAVING count(*) > 1
      ) d;
      IF v_atual_id_dup > 0 THEN
        v_ambiguo := v_ambiguo + 1;
        CONTINUE;
      END IF;

      -- ── G-c: sem identidade completa, a chave de casamento volta a ser o SKU — e aí valem os
      --    DOIS lados do guard, inalterados. `omie_codigo_produto` só é identidade quando não se
      --    repete no pedido; quando repete (1.179 pares medidos em prod, e a duplicidade é
      --    LEGÍTIMA: o payload do Omie repete o SKU em 1.177 deles), não há como dizer qual linha
      --    casa com qual item.
      --    ⚠️ Este guard NÃO é mais o que impede o valor DOBRADO — isso passou a ser estrutural,
      --    no requisito de 1-1 entre os remanescentes do nível 2 abaixo. O que ele impede agora é
      --    o pedido ambíguo ser RECONSTRUÍDO a cada run: sem identidade de linha o casamento
      --    nunca converge, então o delete+insert se repetiria a cada 2 h com `corrections`
      --    inflado para sempre. Congelar é estável; reconstruir em loop, não.
      IF NOT v_ident THEN
        SELECT count(*) INTO v_atual_dup FROM (
          SELECT 1 FROM public.order_items
           WHERE sales_order_id = v_order_id AND omie_codigo_produto IS NOT NULL
           GROUP BY omie_codigo_produto HAVING count(*) > 1
        ) d;
        IF v_n_distintos <> v_n_validos OR v_atual_dup > 0 THEN
          v_ambiguo := v_ambiguo + 1;
          IF v_n_distintos <> v_n_validos THEN
            v_sku_repetido := v_sku_repetido + 1;
          END IF;
          CONTINUE;
        END IF;
      ELSE
        v_usou_id := true;   -- somado a v_id_usada só se o pedido passar a checagem
      END IF;

      BEGIN
        -- ── A reconciliação INTEIRA numa única statement. As CTEs de escrita enxergam o MESMO
        --    snapshot inicial; os três conjuntos (remover / atualizar / inserir) são disjuntos
        --    por construção, porque `par` é um casamento 1-1 provado pelos guards acima.
        --
        --    O casamento tem DOIS NÍVEIS, e o nível 2 é o que dispensa o backfill:
        --      · nível 1 — por `omie_codigo_item`, quando os dois lados o têm;
        --      · nível 2 — por `omie_codigo_produto`, e SÓ onde o SKU é 1-1 entre os que
        --        SOBRARAM, nos DOIS lados. É aqui que a linha antiga (sem identidade) casa com o
        --        item novo (com identidade) e o `UPDATE` GRAVA o `codigo_item`: a adoção é
        --        incremental, correta por construção (SKU único naquele pedido É identidade
        --        naquele pedido) e preserva o `id` da linha.
        --    O caminho legado é um CASO PARTICULAR disto, não um ramo à parte: com `v_ident`
        --    falso o nível 1 é vazio, e o `G-c` já garantiu SKU 1-1 dos dois lados, então o
        --    nível 2 reproduz exatamente o join `d.cod = a.cod` de antes. Um `IF/ELSE` com duas
        --    statements teria o mesmo efeito e DUAS superfícies para divergir.
        --
        --    O que sobra de `atual` é DELETE; o que sobra de `desejado` é INSERT. O pós-estado é
        --    exatamente o conjunto desejado — essa é a invariante, e é ela que o harness afirma.
        --    Tolerância de 1e-6 preservada, e a comparação de preço segue NULL-SAFE (#2224). ──
        WITH desejado AS (
          SELECT t.ord                                          AS did,
                 (it->>'omie_codigo_produto')::bigint           AS cod,
                 coalesce((it->>'quantity')::numeric, 1)        AS quantity,
                 -- REGUA DE PRECO: identica a de criar_pedidos_com_itens — finitude
                 -- NAO-NEGATIVA. ausente -> NULL; 0 informado -> 0; lixo -> NULL.
                 CASE WHEN (it->>'unit_price')::numeric >= 0
                       AND (it->>'unit_price')::numeric < 'Infinity'::numeric
                      THEN (it->>'unit_price')::numeric END     AS unit_price,
                 coalesce((it->>'discount')::numeric, 0)        AS discount,
                 -- DESCONTO DA LINHA (R$), apurado pela régua na edge sobre a MESMA base
                 -- qty·preço do subtotal. Dois contratos de payload, e a diferença importa:
                 --   chave AUSENTE  → edge anterior a esta versão, que não leu o desconto. A
                 --                    linha segue a regra antiga (invalida quando a base muda).
                 --   chave PRESENTE → a leitura atual do Omie. `null` = a régua não soube ler,
                 --                    e isso se grava como NULL (não apurado), nunca como 0.
                 -- `->` e não `->>`: o texto de um JSON null é o NULL do SQL, igual ao da chave
                 -- ausente. Já o jsonb `null` é um VALOR, e é ele que prova que a chave veio.
                 (it -> 'desconto_valor') IS NOT NULL          AS traz_desconto,
                 -- REGUA DE FINITUDE NAO-NEGATIVA, a mesma do unit_price: negativo, Infinity e
                 -- NaN (que o Postgres ordena acima de Infinity) são lixo, e lixo vira NULL.
                 CASE WHEN (it->>'desconto_valor')::numeric >= 0
                       AND (it->>'desconto_valor')::numeric < 'Infinity'::numeric
                      THEN (it->>'desconto_valor')::numeric END AS desconto_valor,
                 (it->>'product_id')::uuid                      AS product_id,
                 it->>'hash_payload'                            AS hash_payload,
                 (it->>'omie_codigo_item')::bigint              AS cid
            FROM jsonb_array_elements(v_itens) WITH ORDINALITY AS t(it, ord)
           WHERE (it->>'omie_codigo_produto') IS NOT NULL
        ),
        atual AS (
          SELECT id, omie_codigo_produto AS cod, quantity, unit_price, discount, product_id,
                 omie_codigo_item AS cid, desconto_valor
            FROM public.order_items
           WHERE sales_order_id = v_order_id
        ),
        p1 AS (   -- nível 1: identidade de linha (só quando o desejado está TODO identificado)
          SELECT a.id AS aid, d.did
            FROM atual a
            JOIN desejado d ON d.cid = a.cid
           WHERE v_ident AND a.cid IS NOT NULL AND d.cid IS NOT NULL
        ),
        ar AS (SELECT a.* FROM atual a    WHERE NOT EXISTS (SELECT 1 FROM p1 WHERE p1.aid = a.id)),
        dr AS (SELECT d.* FROM desejado d WHERE NOT EXISTS (SELECT 1 FROM p1 WHERE p1.did = d.did)),
        -- 1-1 entre os REMANESCENTES, exigido nos DOIS lados. É esta exigência — e não o G-c —
        -- que impede o valor DOBRADO: duas linhas do mesmo SKU simplesmente não casam com
        -- ninguém, caem no DELETE, e os itens desejados entram pelo INSERT.
        ar1 AS (SELECT cod FROM ar WHERE cod IS NOT NULL GROUP BY cod HAVING count(*) = 1),
        dr1 AS (SELECT cod FROM dr                       GROUP BY cod HAVING count(*) = 1),
        p2 AS (   -- nível 2: SKU. É aqui que a linha legada ADOTA a identidade que veio no item.
          SELECT a.id AS aid, d.did
            FROM ar a
            JOIN dr d ON d.cod = a.cod
           WHERE a.cod IN (SELECT cod FROM ar1)
             AND d.cod IN (SELECT cod FROM dr1)
        ),
        par AS (SELECT aid, did FROM p1 UNION ALL SELECT aid, did FROM p2),
        del AS (
          DELETE FROM public.order_items oi
           USING atual a
           WHERE oi.id = a.id
             AND NOT EXISTS (SELECT 1 FROM par WHERE par.aid = a.id)
          RETURNING 1
        ),
        upd AS (
          UPDATE public.order_items oi
             SET quantity     = d.quantity,
                 unit_price   = d.unit_price,
                 discount     = d.discount,
                 -- o SKU também. No casamento por `omie_codigo_item` (nível 1) a linha pode ser a
                 -- MESMA com outro produto no Omie. Sem esta coluna, product_id e hash mudavam e o
                 -- `omie_codigo_produto` ficava o velho: linha contraditória, e o items-jsonb (com o
                 -- SKU novo) passava a descrever outro multiconjunto, que o banco recusa.
                 omie_codigo_produto = d.cod,
                 -- ESCREVE O DESCONTO DA LEITURA, ou INVALIDA — nunca conserva. `d.desconto_valor`
                 -- é o desconto que a edge apurou sobre a base NOVA desta linha: um valor, ou NULL
                 -- quando a régua não soube ler. Payload SEM a chave (edge anterior) dá NULL por
                 -- construção, que é a invalidação de antes: a base mudou e ninguém mediu o
                 -- desconto dela. Conservar o valor antigo segue proibido: um número cuja
                 -- validade deixou de ser conhecida é fabricação com outra roupa.
                 desconto_valor = d.desconto_valor,
                 product_id   = d.product_id,
                 -- o update REPARA a identidade do item (hash legado de conteúdo → de identidade)
                 hash_payload = d.hash_payload,
                 -- ADOÇÃO: grava a identidade quando o payload a traz; `coalesce` porque no
                 -- caminho legado `d.cid` é nulo e apagar a identidade já gravada seria regressão
                 omie_codigo_item = coalesce(d.cid, oi.omie_codigo_item)
            FROM par
            JOIN atual a    ON a.id  = par.aid
            JOIN desejado d ON d.did = par.did
           WHERE oi.id = par.aid
             -- A DECISÃO de escrever é por igualdade EXATA (IS NOT DISTINCT FROM, NULL-safe por
             -- definição: NULL==NULL não reescreve, NULL contra número reescreve) nos campos que
             -- a coerência do agregado compara — produto, quantidade, preço e desconto legado. O
             -- trigger `pedido_venda_coerencia` exige o multiconjunto IGUAL entre linhas e
             -- items-jsonb, e por TOLERÂNCIA (1e-6, e discount NULL tratado como 0) uma diferença
             -- pequena deixava a linha velha sob o jsonb exato: o banco recusava a escrita. A
             -- tolerância continua valendo na CLASSIFICAÇÃO das métricas (RETURNING abaixo).
             AND NOT (      a.cod        IS NOT DISTINCT FROM d.cod
                        AND a.quantity   IS NOT DISTINCT FROM d.quantity
                        AND a.unit_price IS NOT DISTINCT FROM d.unit_price
                        AND a.discount   IS NOT DISTINCT FROM d.discount
                        AND a.product_id IS NOT DISTINCT FROM d.product_id
                        -- a adoção precisa ser um motivo PRÓPRIO de escrita: sem este termo, um
                        -- pedido cujo conteúdo não mudou nunca ganharia identidade, e a coluna
                        -- ficaria vazia para sempre nos pedidos estáveis — o desenho inteiro
                        -- nasceria INERTE sem ninguém ver
                        AND (d.cid IS NULL OR a.cid IS NOT DISTINCT FROM d.cid)
                        -- o DESCONTO é motivo próprio de escrita, quando o payload o traz. É este
                        -- termo que fecha o defeito: base intacta e só o desconto mudado no Omie,
                        -- e sem ele o UPDATE nem disparava.
                        AND (NOT d.traz_desconto
                             OR a.desconto_valor IS NOT DISTINCT FROM d.desconto_valor) )
          -- separa CORREÇÃO de conteúdo (money-path) de ADOÇÃO de identidade (metadado) e de
          -- APURAÇÃO de desconto (convergência): contá-las como "correção" inflaria, na primeira
          -- passada, a métrica que o log publica — 1.024 linhas da janela de 30 dias tinham
          -- desconto_valor NULL em 2026-09-14. A TOLERÂNCIA mora aqui, e não na decisão de
          -- escrever: uma diferença de ruído converge a linha sem contar como correção.
          RETURNING (CASE WHEN a.cod IS NOT DISTINCT FROM d.cod
                           AND abs(coalesce(a.quantity,   0) - d.quantity)   < 1e-6
                           AND (    (a.unit_price IS NULL AND d.unit_price IS NULL)
                                 OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL
                                     AND abs(a.unit_price - d.unit_price) < 1e-6) )
                           AND abs(coalesce(a.discount,   0) - d.discount)   < 1e-6
                           AND a.product_id IS NOT DISTINCT FROM d.product_id
                           -- desconto CONHECIDO que mudou (inclusive para NULL) é conteúdo. Só
                           -- com a chave no payload: sem ela a regra antiga não muda de conta.
                           AND NOT (d.traz_desconto AND a.desconto_valor IS NOT NULL
                                    AND (d.desconto_valor IS NULL
                                         OR abs(a.desconto_valor - d.desconto_valor) >= 1e-6))
                          THEN 0 ELSE 1 END) AS conteudo_mudou,
                    (d.traz_desconto AND a.desconto_valor IS NULL
                     AND d.desconto_valor IS NOT NULL)                          AS desc_apurado,
                    (d.traz_desconto AND a.desconto_valor IS NOT NULL
                     AND (d.desconto_valor IS NULL
                          OR abs(a.desconto_valor - d.desconto_valor) >= 1e-6)) AS desc_corrigido,
                    (d.cid IS NOT NULL AND a.cid IS DISTINCT FROM d.cid)        AS id_adotada
        ),
        ins AS (
          -- `created_at` fica de fora: o trigger `trg_order_items_created_at_omie` herda a data do
          -- PAI para todo pedido `omie\_%`. Passá-la aqui duplicaria a regra em dois lugares.
          INSERT INTO public.order_items (
            sales_order_id, customer_user_id, product_id, omie_codigo_produto,
            quantity, unit_price, discount, desconto_valor, hash_payload, omie_codigo_item
          )
          SELECT v_order_id, v_customer, d.product_id, d.cod,
                 d.quantity, d.unit_price, d.discount,
                 -- Linha NOVA leva o desconto que a edge apurou sobre a base dela. Payload SEM a
                 -- chave (edge anterior) dá NULL e a linha nasce NÃO APURADA, como antes — não
                 -- ter o dado se escreve NULL, nunca 0.
                 d.desconto_valor,
                 d.hash_payload, d.cid
            FROM desejado d
           WHERE NOT EXISTS (SELECT 1 FROM par WHERE par.did = d.did)
          RETURNING 1
        )
        SELECT (SELECT count(*) FROM del),
               (SELECT count(*) FROM upd WHERE conteudo_mudou = 1),
               -- ADOÇÃO pede os dois: conteúdo intacto E identidade gravada agora. O 1º bastava
               -- enquanto a identidade era o único outro motivo de escrita. Com o desconto como
               -- motivo próprio, `conteudo_mudou = 0` sozinho contaria APURAÇÃO como adoção. Sem a
               -- chave de desconto no payload os dois predicados coincidem. Segue medindo adoção
               -- SEM correção de conteúdo, como antes.
               (SELECT count(*) FROM upd WHERE conteudo_mudou = 0 AND id_adotada),
               (SELECT count(*) FROM ins),
               (SELECT count(*) FROM upd WHERE desc_apurado),
               (SELECT count(*) FROM upd WHERE desc_corrigido),
               (SELECT count(*) FROM upd)
          INTO v_del, v_upd, v_adot, v_ins, v_apur, v_corr, v_upd_tot;
      END;

      -- Adoção de identidade e apuração de desconto NÃO são revisão de itens: o conteúdo
      -- money-path da linha é o mesmo. Contá-las aqui faria a primeira passada parecer uma
      -- reconciliação em massa que não houve.
      v_itens_mudaram := (v_del + v_upd + v_ins) > 0;

      -- [A4] status só reconcilia com etapa CONHECIDA (status_omie não-nulo) e status local ainda
      -- gerido pelo Omie — nunca rebaixa para 'importado' por leitura malformada nem clobbera
      -- status app-avançado. NUNCA toca hash_payload do pai (causa-raiz #B).
      -- ⚠️ A autoridade aqui é `c_status_omie`, a constante — NÃO o parâmetro. O parâmetro é um
      -- CHECKSUM: ele existe para o TS DECLARAR o que acha que é a lista, e o banco conferir. Se
      -- ele fosse a autoridade, remover o guard de igualdade lá em cima bastaria para uma lista
      -- vinda de fora clobberar status app-avançado. Assim, o guard e o efeito são defesas
      -- INDEPENDENTES: derrubar uma não abre a outra (provado em F2b do harness).
      v_status_novo  := CASE WHEN v_status_omie IS NOT NULL AND v_status_atual = ANY (c_status_omie)
                             THEN v_status_omie ELSE v_status_atual END;
      v_status_mudou := v_status_atual IS DISTINCT FROM v_status_novo;
      v_total_mudou  := abs(coalesce(v_total_atual, 0) - v_total_novo) > 0.01;
      -- ── P1-3 (achado do challenge): a decisão de gravar ignorava `items` e `subtotal` atuais.
      --    Efeitos concretos disso: uma mudança só de descrição/cor no retrato virava NO-OP
      --    PERMANENTE; um estado legado "filhos novos, cabeçalho antigo" nunca era reparado se
      --    total e status coincidissem; e um `subtotal` torto sozinho jamais se corrigia. Uma
      --    reconciliação declarativa que não compara o que grava não é declarativa. ──
      v_cab_mudou := v_status_mudou
                  OR v_total_mudou
                  OR v_items_atual IS DISTINCT FROM v_items_json
                  OR abs(coalesce(v_subtotal_atual, 0) - v_total_novo) > 0.01
                  -- o próprio carimbo do CAS precisa avançar, senão uma leitura nova que não muda
                  -- nada deixaria o pedido preso no carimbo antigo e reabriria a janela de stale
                  OR v_lido_atual IS DISTINCT FROM p_lido_em;

      IF v_cab_mudou OR v_itens_mudaram THEN
        UPDATE public.sales_orders
           SET status     = v_status_novo,
               total      = v_total_novo,
               subtotal   = v_total_novo,
               items      = v_items_json,
               omie_reconciliado_em = p_lido_em,
               updated_at = now()
         WHERE id = v_order_id;
        -- `upserts` conta trabalho REAL. Avançar só o carimbo (leitura nova, conteúdo idêntico)
        -- não é uma reconciliação — contá-la inflaria a métrica que o log publica.
        IF v_status_mudou OR v_total_mudou OR v_itens_mudaram
           OR v_items_atual IS DISTINCT FROM v_items_json
           OR abs(coalesce(v_subtotal_atual, 0) - v_total_novo) > 0.01 THEN
          v_conta_upsert := true;
        END IF;
        IF v_status_mudou OR v_total_mudou THEN
          v_conta_diverg := true;
        END IF;
      END IF;

      -- ── COERÊNCIA DO AGREGADO checada DENTRO da subtransação deste pedido ──
      --    `trg_pedido_venda_coerencia_cab`/`_lin` são DEFERRABLE INITIALLY DEFERRED (linhas e
      --    cabeçalho se escrevem em statements sucessivos) e checam no COMMIT — que aqui é o da
      --    CHAMADA, fora do BEGIN/EXCEPTION por pedido. Uma única escrita incoerente derrubava a
      --    chamada, a página e a run, a cada ciclo: medido em prod, 79 runs de pedidos da oben em
      --    erro entre 2026-09-08 20:15 UTC e 2026-09-14, todas no mesmo pedido.
      --    O MESMO predicado dos triggers, chamado aqui só quando este pedido escreveu (é quando
      --    eles teriam evento dele), faz o 23514 cair no WHEN integrity_constraint_violation
      --    abaixo: o pedido é revertido INTEIRO, vai para `falhas`, e o lote segue. Os triggers
      --    ficam como a defesa do COMMIT. Não `SET CONSTRAINTS … IMMEDIATE`: ele checaria os
      --    eventos pendentes da transação INTEIRA, e um pedido pagaria pela pendência de outro.
      IF v_cab_mudou OR (v_del + v_upd_tot + v_ins) > 0 THEN
        PERFORM public.pedido_venda_exigir_coerencia(v_order_id);
      END IF;

      -- Só agora o pedido CONTA. Somar antes da checagem deixaria nos totais o trabalho de um
      -- pedido que acabou revertido: `corrections` afirmaria correção que não aconteceu.
      v_corrections := v_corrections + v_del + v_upd + v_ins;
      v_id_adotada  := v_id_adotada + v_adot;
      v_desc_apur   := v_desc_apur + v_apur;
      v_desc_corr   := v_desc_corr + v_corr;
      IF v_usou_id      THEN v_id_usada    := v_id_usada + 1;    END IF;
      IF v_conta_upsert THEN v_upserts     := v_upserts + 1;     END IF;
      IF v_conta_diverg THEN v_divergences := v_divergences + 1; END IF;

    -- ── P1-4 (achado do challenge): ALLOWLIST, não catch-all. O `WHEN OTHERS` capturava
    --    deadlock (40P01), serialization failure (40001), permissão, relação/coluna ausente e
    --    trigger quebrado como se fossem "um pedido ruim" — e como a função retornava
    --    normalmente, `rpcErr` ficava nulo na edge e a run saía `complete` mesmo com 100 de 100
    --    pedidos falhando. Uma migration não aplicada em metade do schema pareceria um dia de
    --    dados sujos. Aqui ficam só as classes de DADO, que são de fato por-pedido; qualquer
    --    outra sobe e derruba a chamada inteira, que é o desfecho honesto para falha sistêmica.
    EXCEPTION
      WHEN data_exception              -- 22xxx: cast inválido, jsonb malformado, o nosso 22023
        OR integrity_constraint_violation  -- 23xxx: FK de product_id, NOT NULL, unique
      THEN
      -- G8: a falha do pedido é REGISTRADA com SQLSTATE e mensagem, nunca engolida como sucesso
      -- invisível. Tudo que este pedido escreveu foi desfeito pela subtransação.
      v_falhas := v_falhas || jsonb_build_object(
        'hash', v_pedido->>'hash_payload',
        'omie_pedido_id', v_pedido->'omie_pedido_id',
        'sqlstate', SQLSTATE, 'erro', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'upserts',      v_upserts,
    'divergences',  v_divergences,
    'corrections',  v_corrections,
    'sku_repetido', v_sku_repetido,
    'ambiguo',      v_ambiguo,     -- pedidos NÃO tocados por duplicidade de SKU (atual ou desejado)
    'stale',        v_stale,       -- pedidos NÃO tocados por leitura mais velha que a publicada
    'sem_item',     v_sem_item,
    'sem_pai',      v_sem_pai,
    -- SENSORES da adoção de identidade. `identidade_adotada` conta LINHAS que ganharam o
    -- `codigo_item`; `identidade_usada` conta PEDIDOS diffados por ela. Enquanto os dois
    -- forem zero run após run, a resposta é que o ListarPedidos não traz `det.ide.codigo_item`
    -- — e essa é a medição que nenhum payload persistido permitia fazer.
    'identidade_adotada', v_id_adotada,
    'identidade_usada',   v_id_usada,
    -- SENSORES do desconto da linha. `desconto_corrigido` mede o defeito que esta versão fecha
    -- (desconto alterado no Omie depois de apurado). `desconto_apurado` mede a convergência do
    -- acervo NULL. Uma edge que não manda a chave os deixa em zero.
    'desconto_apurado',   v_desc_apur,
    'desconto_corrigido', v_desc_corr,
    'falhas',       v_falhas);
END;
$function$

;

-- ACL explícito, idêntico ao de prod (postgres, service_role, sandbox_exec). `CREATE OR REPLACE` já o
-- preserva; repetir o REVOKE NOMEANDO as roles é o que o mantém verdadeiro num ambiente
-- reconstruído, onde a função nasceria com EXECUTE para PUBLIC.
REVOKE ALL ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconciliar_pedidos_omie(jsonb, text[], timestamp with time zone) TO service_role;

-- A função nova CHAMA `pedido_venda_exigir_coerencia` e é SECURITY INVOKER: quem a executa precisa
-- executar o validador. Em prod o service_role já tem esse EXECUTE, mas por DEFAULT PRIVILEGES do
-- Supabase e não por migration (a 20260907220000 só revoga PUBLIC/anon/authenticated) — medido
-- 2026-09-14. Aqui é no-op na prod, e é o que mantém a dependência verdadeira num ambiente
-- reconstruído: sem ele, a prova PG17 viu a postcondição A5b abortar esta migration.
GRANT EXECUTE ON FUNCTION public.pedido_venda_exigir_coerencia(uuid) TO service_role;

-- ── Postcondição: SUFICIÊNCIA do corpo, não existência ────────────────────────────────────────
-- A função existe ANTES desta migration, então existir não prova nada. Cobra-se o corpo NOVO, o
-- que ele não pode ter perdido, a autorização — e, por EXECUÇÃO, que ele devolve os sensores.
-- O efeito money-path (o desconto atravessa, o NULL não vira 0, o pedido incoerente não derruba o
-- lote) não se prova por texto: é executado em db/test-desconto-valor-escritores.sh §G-§I.
DO $post$
DECLARE
  v_oid  oid := to_regprocedure('public.reconciliar_pedidos_omie(jsonb,text[],timestamp with time zone)');
  v_coer oid := to_regprocedure('public.pedido_venda_exigir_coerencia(uuid)');
  v_def  text;
  v_ret  jsonb;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'FALHOU A1: public.reconciliar_pedidos_omie(jsonb,text[],timestamptz) não existe — a migration não pegou.';
  END IF;
  v_def := pg_get_functiondef(v_oid);

  IF position($t$(it -> 'desconto_valor') IS NOT NULL$t$ IN v_def) = 0
     OR position('desconto_valor = d.desconto_valor,' IN v_def) = 0
     OR v_def !~ 'INSERT INTO public\.order_items[^;]*d\.desconto_valor,' THEN
    RAISE EXCEPTION 'FALHOU A2: a reconciliação não lê/grava o desconto_valor do payload — o desconto velho seguiria sob o total novo.';
  END IF;

  -- `[^\n]*` e não `[^)]*`: a forma real de um coalesce sabotado é `coalesce((it->>'desconto_valor')::numeric, 0)`,
  -- e a classe negada pararia no primeiro `)` (lição da falsificação de 20260908215704).
  IF v_def ~* 'coalesce[^\n]*desconto_valor[^\n]*,\s*0\s*\)'
     OR v_def ~* 'coalesce\s*\(\s*0\s*,[^\n]*desconto_valor' THEN
    RAISE EXCEPTION 'FALHOU A3: coalesce(desconto_valor, 0) no corpo — afirma "sem desconto" onde ninguém mediu e devolve receita cheia.';
  END IF;

  IF position('omie_codigo_produto = d.cod,' IN v_def) = 0
     OR position('AND a.unit_price IS NOT DISTINCT FROM d.unit_price' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FALHOU A4: a escrita não converge exatamente no que a coerência fiscaliza (SKU gravado, decisão por igualdade exata) — o banco voltaria a recusar a própria escrita.';
  END IF;

  IF position('PERFORM public.pedido_venda_exigir_coerencia(v_order_id);' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FALHOU A5: a coerência não é checada por pedido — um pedido incoerente volta a derrubar a run inteira.';
  END IF;
  IF v_coer IS NULL OR NOT has_function_privilege('service_role', v_coer, 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU A5b: service_role não executa pedido_venda_exigir_coerencia(uuid) — a reconciliação falharia em todo pedido que escreve.';
  END IF;

  IF position('omie_codigo_item = coalesce(d.cid, oi.omie_codigo_item)' IN v_def) = 0
     OR position('(a.unit_price IS NULL AND d.unit_price IS NULL)' IN v_def) = 0 THEN
    RAISE EXCEPTION 'FALHOU A6: o corpo perdeu a adoção de identidade (#2405) ou o preço NULL-safe (#2224) — este apply reverteria entregas anteriores.';
  END IF;

  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid)
     OR NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU A7: autorização fora do esperado (SECURITY INVOKER, e EXECUTE só para service_role entre as roles da API).';
  END IF;

  -- Execução com lote VAZIO: não escreve nada, e só o corpo novo devolve as duas chaves.
  v_ret := public.reconciliar_pedidos_omie('[]'::jsonb,
             ARRAY['importado','separacao','enviado','faturado','cancelado'], now());
  IF (v_ret -> 'desconto_apurado') IS NULL OR (v_ret -> 'desconto_corrigido') IS NULL THEN
    RAISE EXCEPTION 'FALHOU A8: a função executou mas não devolve os sensores do desconto — o corpo vivo não é o desta migration.';
  END IF;

  RAISE NOTICE 'OK: reconciliar_pedidos_omie carrega desconto_valor sem coalesce 0, converge exato, checa a coerência por pedido, preserva identidade/preço/ACL e devolve os sensores.';
END
$post$;


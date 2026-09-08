-- ============================================================================================
-- aplicar_edicao_pedido_omie — o write-back da EDIÇÃO passa a escrever as DUAS metades
-- ============================================================================================
-- O agregado "pedido de venda" tem duas metades que precisam contar a mesma história:
-- `sales_orders.items` (jsonb) e as linhas de `order_items`. A migration irmã
-- 20260907220000_pedido_venda_coerencia_agregado.sql instala a CONSTRAINT TRIGGER que passa a
-- EXIGIR isso no COMMIT. Esta aqui conserta o escritor que hoje quebra a invariante em silêncio —
-- e precisa ir ANTES dela, senão a edição de pedido passa a FALHAR (com o Omie já mutado) em vez
-- de ser consertada.
--
-- O ESCRITOR DEFEITUOSO: supabase/functions/omie-vendas-sync/index.ts, action `alterar_pedido`.
-- Depois de EXCLUIR e RE-INCLUIR todos os itens no Omie, ele fazia um `.update()` PostgREST em
-- `sales_orders` gravando items/subtotal/total/notes/omie_payload/omie_response e NUNCA tocava
-- `order_items`. Em pedido canônico (que tem linhas) o jsonb ia para a revisão NOVA e as linhas
-- ficavam na VELHA.
--
-- DANO MEDIDO (psql-ro, 2026-09-07): 15 pedidos canônicos divergentes, 14 `faturado`,
-- R$ 27.795,25, 63 diferenças de item. Como `fin-valor-cockpit`, `algorithm-a-audit` e
-- `_shared/apriori.ts` ancoram em `order_items`, item não escrito vira VAZIO — não erro:
-- R$ 10.676,56 de venda faturada invisível para o money-path.
--
-- POR QUE UMA RPC NOVA E NÃO `reconciliar_pedidos_omie` (a RPC atômica que já existe) — o
-- parecer Codex (gpt-6-astra, max) concordou com a escolha e derrubou dois dos meus argumentos:
--   1. PULO SILENCIOSO — `sem_pai`/`sem_item`/`ambiguo`/`stale`/`falhas[]` saem como CONTADOR no
--      retorno, não como erro. Neste caminho o Omie JÁ FOI MUTADO quando o write-back roda:
--      pular em silêncio é o pior desfecho possível. Aqui tudo LANÇA.
--   2. COLUNAS DE MENOS — ela não grava `notes`, `omie_payload` nem `omie_response`. Usá-la
--      exigiria um 2º UPDATE em OUTRA transação; com duas edições intercaladas isso termina com
--      itens da edição 2 e `omie_payload` da edição 1 — e o payload é reusado na edição seguinte,
--      então chamá-lo de "só metadado" subestima a consequência (achado do Codex).
--   3. SEMÂNTICA DIFERENTE — ela DIFFA duas observações independentes (pull em lote). Aqui não há
--      o que casar: a edição APAGOU e RECRIOU todas as linhas no Omie, então as identidades
--      `omie_codigo_item` antigas deixaram de existir e o conjunto novo é a verdade DECLARADA.
--   (Os argumentos que o Codex derrubou: (account, hash_payload) NÃO é chave ambígua dentro do
--    predicado do índice único, e o silêncio dos pulos seria contornável no caller. Ficam
--    registrados como não-motivos.)
--
-- POR QUE A SUBSTITUIÇÃO INTEGRAL É SEGURA (apurado na PROD, 2026-09-07):
--   • `order_items` não é alvo de NENHUMA foreign key (0 constraints com confrelid=order_items);
--   • `order_items.created_at` É money-path (sinal de RECÊNCIA que o `fin-valor-cockpit`
--     prefiltra). O trigger `trg_order_items_created_at_omie` (BEFORE INSERT) reinjeta o
--     `created_at` do PAI, mas SÓ quando `hash_payload LIKE 'omie\_%'` — e esta RPC é chaveada por
--     uuid, que não restringe esse domínio (achado do Codex). Por isso ela CARREGA explicitamente
--     o `created_at` das linhas que substitui: não depende do domínio do outro trigger.
--     Medido hoje: 0 pedidos com linhas fora do predicado `omie\_%` — o carregamento é a rede.
--   • CONSUMIDOR DE IDENTIDADE conhecido: `_shared/recommend-leituras.ts` pagina `order_items` por
--     `id`. Trocar uuid entre duas páginas pode repetir/pular um item. NÃO é novo — a própria
--     `reconciliar_pedidos_omie` já faz DELETE+INSERT — e não é corrigível por escrita atômica
--     (várias requisições de leitura não são um snapshot). Fica registrado, não fechado aqui.
--
-- POSTCONDIÇÃO PRÓPRIA: no fim, a função relê o estado GRAVADO e compara os dois espelhos com o
-- MESMO predicado da trigger (EXCEPT ALL nos dois sentidos, sem COALESCE e sem tolerância). Não é
-- redundância decorativa: comparar os dois ARGUMENTOS não provaria o estado persistido (defaults,
-- casts e triggers mexem no que entra), e é ela que faz o conserto valer MESMO ANTES de a trigger
-- ser aplicada.
--
-- APLICAÇÃO: SQL Editor do Lovable (custom migration NÃO auto-aplica).
-- ============================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.aplicar_edicao_pedido_omie(
  p_sales_order_id uuid,
  p_items          jsonb,     -- espelho jsonb (chaves pt: quantidade/valor_unitario/desconto)
  p_itens          jsonb,     -- linhas relacionais (quantity/unit_price/discount/omie_codigo_item)
  p_total          numeric,
  p_notes          text,
  p_omie_payload   jsonb,
  p_omie_response  jsonb,
  p_lido_em        timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
  -- O Omie aceita `codigo_item_integracao` de 1 a 999 (ver getOmieItemIntegrationCode no edge).
  -- Lote maior que isso não veio da edição — truncar em silêncio seria pior que recusar.
  c_max_itens constant integer := 999;
  v_customer     uuid;
  v_hash_pai     text;
  v_lido_atual   timestamptz;
  v_created_at   timestamptz;
  v_pid_por_sku  jsonb;
  v_n_antes      integer;
  v_n_itens      integer;
  v_n_items      integer;
  v_soma_itens   numeric;
  v_del          integer := 0;
  v_ins          integer := 0;
  v_divergiu     boolean;
BEGIN
  -- ── 1) Entrada fail-closed. Tudo LANÇA: o Omie já está mutado quando isto roda. ──
  IF p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_sales_order_id ausente'
      USING ERRCODE = '22023';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_items deve ser array jsonb (veio %) — ausente nao e lista vazia',
      jsonb_typeof(p_items) USING ERRCODE = '22023';
  END IF;

  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_itens deve ser array jsonb (veio %) — ausente nao e lista vazia',
      jsonb_typeof(p_itens) USING ERRCODE = '22023';
  END IF;

  v_n_items := jsonb_array_length(p_items);
  v_n_itens := jsonb_array_length(p_itens);

  IF v_n_items = 0 OR v_n_itens = 0 THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: edicao sem itens (items=%, itens=%) — esvaziar o pedido local nao e desfecho de edicao',
      v_n_items, v_n_itens USING ERRCODE = '22023';
  END IF;

  IF v_n_itens > c_max_itens THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: % itens excede o teto de %',
      v_n_itens, c_max_itens USING ERRCODE = '54000';
  END IF;

  IF p_lido_em IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_lido_em ausente — sem o instante da leitura final do Omie nao ha como impedir que um pull atrasado reverta esta edicao'
      USING ERRCODE = '22023';
  END IF;

  IF p_lido_em > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_lido_em no futuro (% > %) — relogio do chamador envenenaria o compare-and-set',
      p_lido_em, now() USING ERRCODE = '22023';
  END IF;

  IF p_total IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total ausente — ausente nao e zero'
      USING ERRCODE = '22023';
  END IF;

  -- Regua de finitude nao-negativa (mesma de criar_pedidos_com_itens/reconciliar_pedidos_omie).
  -- Pega NaN tambem: em numeric NaN ordena ACIMA de Infinity, entao `NaN < Infinity` e falso.
  IF NOT (p_total >= 0 AND p_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total invalido (%) — negativo/NaN/infinito nao e total',
      p_total USING ERRCODE = '22023';
  END IF;

  -- Contrato POR ELEMENTO (achado do Codex: dois arrays iguais podem carregar o mesmo dado
  -- invalido). `quantity` e NOT NULL na tabela, `omie_codigo_produto` e a identidade do item no
  -- espelho, e o preco precisa existir e ser finito nao-negativo — sem preco nao ha total.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) AS it
     WHERE (it->>'omie_codigo_produto') IS NULL
        OR (it->>'quantity') IS NULL
        OR (it->>'unit_price') IS NULL
        OR NOT ((it->>'quantity')::numeric  >= 0 AND (it->>'quantity')::numeric  < 'Infinity'::numeric)
        OR NOT ((it->>'unit_price')::numeric >= 0 AND (it->>'unit_price')::numeric < 'Infinity'::numeric)
  ) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: item sem omie_codigo_produto/quantity/unit_price ou com valor negativo/NaN/infinito'
      USING ERRCODE = '22023';
  END IF;

  -- Desconto: este caminho NAO envia `desconto` ao Omie (ver inclPayload no edge), entao o ERP
  -- grava 0. Aceitar desconto aqui exigiria escolher a formula do total — e a semantica de
  -- `desconto` esta contraditoria entre escritores (o sync aplica qtd*preco*(1-d/100), o cockpit
  -- qtd*preco-d). Recusar e fail-closed: se a edicao ganhar desconto um dia, isto LANCA e forca a
  -- decisao de produto em vez de fabricar um numero.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) AS it
     WHERE (it->>'discount') IS NOT NULL AND (it->>'discount')::numeric <> 0
  ) THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: item com desconto <> 0 — a edicao nao envia desconto ao Omie; a formula do total precisa de decisao de produto'
      USING ERRCODE = '22023';
  END IF;

  -- Com desconto 0 por contrato, o total tem UMA formula so: soma de qtd*preco. `p_total` finito
  -- nao prova que ele corresponde aos itens (achado do Codex) — esta comparacao prova.
  SELECT sum((it->>'quantity')::numeric * (it->>'unit_price')::numeric)
    INTO v_soma_itens
    FROM jsonb_array_elements(p_itens) AS it;

  IF abs(p_total - v_soma_itens) > 0.01 THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_total (%) nao bate com a soma dos itens (%) — cabecalho e linhas contariam historias diferentes',
      p_total, v_soma_itens USING ERRCODE = '22023';
  END IF;

  -- ── 2) Trava o pai. FOR UPDATE serializa contra outra edicao/reconciliacao do MESMO pedido. ──
  SELECT customer_user_id, hash_payload, omie_reconciliado_em
    INTO v_customer, v_hash_pai, v_lido_atual
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % nao existe — o Omie ja foi mutado e nao ha onde gravar a revisao nova',
      p_sales_order_id USING ERRCODE = 'P0002';
  END IF;

  -- Compare-and-set de revisao. Sem isto, um pull que leu o Omie ANTES desta edicao e escreve
  -- DEPOIS reverte tudo — e reverte de forma COERENTE, entao a trigger aceita (achado do Codex).
  -- Escrever o marcador aqui faz a `reconciliar_pedidos_omie` recusar essa leitura velha como
  -- `stale`. O caso inverso (marcador ja mais novo que a nossa leitura) LANCA: e conflito real,
  -- e neste caminho pular em silencio e o pior desfecho possivel.
  IF v_lido_atual IS NOT NULL AND p_lido_em < v_lido_atual THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % ja tem revisao mais nova gravada (lido_em % < %) — recarregue antes de re-salvar',
      p_sales_order_id, p_lido_em, v_lido_atual USING ERRCODE = '55000';
  END IF;

  -- ── 3) Linhas: substituicao INTEGRAL, e SO quando o pedido ja tinha linhas. ──
  -- Pedido sem linhas e push do app (desenho legitimo, isento da invariante): criar linhas aqui
  -- mudaria QUAIS pedidos sao canonicos — decisao de produto, nao conserto de escritor.
  SELECT count(*), min(created_at)
    INTO v_n_antes, v_created_at
    FROM public.order_items WHERE sales_order_id = p_sales_order_id;

  IF v_n_antes > 0 THEN
    -- `product_id` NAO viaja no items-jsonb do caminho de PULL (construirItemsJson nao grava a
    -- chave), entao a edicao de um pedido canonico manda `product_id` so nos itens que o usuario
    -- ACRESCENTOU pelo catalogo. Substituir as linhas sem mais nada ZERARIA o product_id dos
    -- itens preexistentes — e ele e FK para omie_products e a chave de custo da margem.
    -- Regra: payload vence; onde ele nao sabe, herda o da linha substituida do MESMO SKU, e so
    -- quando aquele SKU tem UM product_id so nas linhas atuais. Ambiguo => NULL (nao adivinha).
    SELECT coalesce(jsonb_object_agg(cod::text, pid), '{}'::jsonb)
      INTO v_pid_por_sku
      FROM (
        SELECT omie_codigo_produto AS cod, min(product_id::text) AS pid
          FROM public.order_items
         WHERE sales_order_id = p_sales_order_id
           AND omie_codigo_produto IS NOT NULL
           AND product_id IS NOT NULL
         GROUP BY omie_codigo_produto
        HAVING count(DISTINCT product_id) = 1
      ) m;

    DELETE FROM public.order_items WHERE sales_order_id = p_sales_order_id;
    GET DIAGNOSTICS v_del = ROW_COUNT;

    INSERT INTO public.order_items (
      sales_order_id, customer_user_id, product_id, omie_codigo_produto,
      quantity, unit_price, discount, hash_payload, omie_codigo_item, created_at
    )
    SELECT p_sales_order_id,
           v_customer,                              -- do PAI travado, nunca do payload
           coalesce((it->>'product_id')::uuid,
                    (v_pid_por_sku->>(it->>'omie_codigo_produto'))::uuid),
           (it->>'omie_codigo_produto')::bigint,
           (it->>'quantity')::numeric,
           (it->>'unit_price')::numeric,
           -- SEM coalesce: desconto ausente vira NULL, nao 0. O espelho jsonb tem de dizer a
           -- MESMA coisa (a postcondicao cobra), e NULL=NULL nao e divergencia.
           (it->>'discount')::numeric,
           -- Formato do repo: <hash do pai>_<codigo_produto> (ver o sync). Derivado do PAI de
           -- proposito: o chamador nao consegue forjar um hash de item de outro pedido.
           CASE WHEN v_hash_pai IS NULL THEN NULL
                ELSE v_hash_pai || '_' || (it->>'omie_codigo_produto') END,
           (it->>'omie_codigo_item')::bigint,
           -- Recencia: carrega a data de CARGA que as linhas substituidas ja tinham.
           coalesce(v_created_at, now())
      FROM jsonb_array_elements(p_itens) AS it;
    GET DIAGNOSTICS v_ins = ROW_COUNT;

    IF v_ins <> v_n_itens THEN
      RAISE EXCEPTION 'aplicar_edicao_pedido_omie: inseri % linhas para % itens do payload',
        v_ins, v_n_itens USING ERRCODE = '23514';
    END IF;
  END IF;

  -- ── 4) Cabecalho, na MESMA transacao das linhas. ──
  UPDATE public.sales_orders
     SET items                = p_items,
         subtotal             = p_total,
         total                = p_total,
         notes                = p_notes,
         omie_payload         = p_omie_payload,
         omie_response        = p_omie_response,
         omie_reconciliado_em = p_lido_em,
         updated_at           = now()
   WHERE id = p_sales_order_id;

  -- ── 5) Postcondicao: os dois espelhos, lidos do BANCO, com o predicado da trigger. ──
  IF v_n_antes > 0 THEN
    WITH lado_rel AS (
      SELECT omie_codigo_produto AS prod, quantity AS qtd, unit_price AS preco, discount AS desc_item
        FROM public.order_items WHERE sales_order_id = p_sales_order_id
    ),
    lado_json AS (
      SELECT (el->>'omie_codigo_produto')::bigint AS prod,
             (el->>'quantidade')::numeric         AS qtd,
             (el->>'valor_unitario')::numeric     AS preco,
             (el->>'desconto')::numeric           AS desc_item
        FROM public.sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
       WHERE so.id = p_sales_order_id AND jsonb_typeof(so.items) = 'array'
    )
    SELECT EXISTS (
      (TABLE lado_rel EXCEPT ALL TABLE lado_json)
      UNION ALL
      (TABLE lado_json EXCEPT ALL TABLE lado_rel)
    ) INTO v_divergiu;

    IF v_divergiu THEN
      RAISE EXCEPTION
        'aplicar_edicao_pedido_omie: pedido % ficaria incoerente — items(jsonb) e order_items descrevem conjuntos diferentes',
        p_sales_order_id
        USING ERRCODE = '23514',
              CONSTRAINT = 'pedido_venda_coerencia',
              HINT = 'p_items e p_itens tem de descrever os MESMOS (produto, quantidade, preco, desconto); confira a chave desconto/discount';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'sales_order_id',   p_sales_order_id,
    'tinha_linhas',     v_n_antes > 0,
    'linhas_antes',     v_n_antes,
    'linhas_removidas', v_del,
    'linhas_inseridas', v_ins,
    'itens_payload',    v_n_itens);
END;
$function$;

-- Fronteira: so o service_role (edge). As DUAS pontas, como manda o database.md §4.
REVOKE ALL ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz) IS
  'Write-back local da acao `alterar_pedido` (omie-vendas-sync): grava cabecalho E linhas do pedido '
  'na MESMA transacao, sob FOR UPDATE do pai, chaveado pelo id. Substitui as linhas por inteiro '
  '(a edicao apagou e recriou todas no Omie: o conjunto novo e a verdade declarada, nao um diff) '
  'carregando das linhas substituidas o created_at (recencia do fin-valor-cockpit) e o product_id '
  'por SKU 1-1 (o items-jsonb do pull nao tem a chave; zera-lo quebraria a FK de custo da margem). '
  'Pedido SEM linhas segue sem linhas (push do app e desenho legitimo, isento da invariante). '
  'Fail-closed: id/items/itens/total/lido_em ausentes ou invalidos LANCAM, item sem preco LANCA, '
  'desconto <> 0 LANCA, total que nao bate com a soma dos itens LANCA, pai inexistente LANCA — '
  'nunca pula em silencio, porque o Omie ja foi mutado quando isto roda. Compare-and-set por '
  'p_lido_em contra omie_reconciliado_em (revisao mais nova gravada => 55000). Postcondicao propria '
  'compara os dois espelhos LIDOS DO BANCO com o mesmo predicado da trigger pedido_venda_coerencia.';

COMMENT ON COLUMN public.sales_orders.omie_reconciliado_em IS
  'Instante em que a edge BUSCOU no Omie a revisao que esta gravada nesta linha. Compare-and-set: '
  'escrita cuja leitura e mais VELHA que este marcador nao sobrescreve a linha. DOIS escritores, '
  'com a MESMA semantica: `reconciliar_pedidos_omie` (pull em lote, carimbo por pagina) e '
  '`aplicar_edicao_pedido_omie` (edicao, carimbo do ConsultarPedido final). O 2o entrou em '
  '2026-09-07 para fechar a reversao "pull atrasado desfaz a edicao" — sem ele a reversao passa '
  'pela trigger de coerencia, porque os dois espelhos retrocedem JUNTOS.';

-- ── Postcondicao do APPLY: migration que nao pegou nao termina em silencio. ──
DO $post$
DECLARE
  v_oid oid;
  v_def text;
BEGIN
  -- `to_regprocedure` devolve NULL (nao lanca) quando a assinatura nao existe, e casa a
  -- assinatura INTEIRA — `pg_get_function_identity_arguments` traria os NOMES dos parametros
  -- junto e nunca casaria uma string so de tipos.
  v_oid := to_regprocedure('public.aplicar_edicao_pedido_omie(uuid,jsonb,jsonb,numeric,text,jsonb,jsonb,timestamptz)');
  IF v_oid IS NULL THEN
    RAISE EXCEPTION '[POSTCOND] aplicar_edicao_pedido_omie(uuid,jsonb,jsonb,numeric,text,jsonb,jsonb,timestamptz) nao existe — a edicao de pedido continuaria corrompendo o agregado';
  END IF;

  -- Existir nao basta: o corpo tem de conter as duas metades e a postcondicao de coerencia.
  v_def := pg_get_functiondef(v_oid);
  IF v_def NOT LIKE '%DELETE FROM public.order_items%'
     OR v_def NOT LIKE '%INSERT INTO public.order_items%'
     OR v_def NOT LIKE '%UPDATE public.sales_orders%'
     OR v_def NOT LIKE '%EXCEPT ALL%' THEN
    RAISE EXCEPTION '[POSTCOND] corpo de aplicar_edicao_pedido_omie sem as duas metades ou sem a postcondicao de coerencia';
  END IF;

  -- Fronteira, DUAS pontas. PUBLIC nao e role de pg_roles: has_function_privilege('public',..)
  -- ERRA em vez de responder, entao a concessao a PUBLIC se le no ACL (grantee = 0).
  IF EXISTS (
    SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
     WHERE p.oid = v_oid AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION '[POSTCOND] aplicar_edicao_pedido_omie ainda executavel por PUBLIC — o REVOKE nao pegou';
  END IF;

  IF has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '[POSTCOND] aplicar_edicao_pedido_omie executavel por anon/authenticated — o REVOKE nao pegou';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION '[POSTCOND] service_role nao executa aplicar_edicao_pedido_omie — o edge ficaria sem escritor';
  END IF;

  RAISE NOTICE '[POSTCOND-OK] aplicar_edicao_pedido_omie instalada e fechada em service_role';
END
$post$;

COMMIT;

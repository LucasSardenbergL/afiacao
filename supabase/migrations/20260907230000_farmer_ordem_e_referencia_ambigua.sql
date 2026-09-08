-- A ordem do "melhor individual" para de ser uuid — e a tela para de chamar sorteio de veredicto
--
-- O DEFEITO, medido em prod (psql-ro, 07/09/2026, 1.083 recomendacoes pendentes). Sao DOIS,
-- independentes, e consertar um nao fecha o outro:
--
--   ENTRE TIPOS · `affinity_score` recebe valor de dois motores incomensuraveis. cross-sell faz
--     `0,15 x health x engagement x relevance`; up-sell faz `0,10 x health x engagement x 0,8`.
--     health e engagement CANCELAM, entao up vence <=> relevance < 0,5333 — e up venceu 186 de
--     186 pares. Nao e "artefato de escala": e um limiar bem definido que o cross-sell chegou a
--     0,5041 de cruzar. Precedencia de tipo NAO DECLARADA, nascida de uma coincidencia numerica.
--
--   DENTRO DO up_sell · para 183 dos 186 clientes com 2 ofertas, `affinity_score`, `updated_at` e
--     `created_at` empatam nos 183. Quem elege e o `id` (uuid v4). A ordem que o #1837 calculou
--     em memoria e DESCARTADA na persistencia. E `created_at` nao a recupera: desde a
--     20260814223445 a geracao inteira entra num INSERT so, e `now()` e o instante da TRANSACAO.
--
--   Somados: 235 de 238 pares (98,7%) tem o produto eleito escolhido pelo uuid.
--
-- O QUE ESTA MIGRATION FAZ (spec: docs/superpowers/specs/2026-09-07-rpc-melhor-individual-ordem-design.md):
--   1. `ordem` — rank DENSO, para a ordem sobreviver a persistencia;
--   2. `referencia_ambigua` — a ambiguidade a montante do rank vira dado, nao suposicao;
--   3. o writer aceita e VALIDA as duas;
--   4. `farmer_melhores_individuais_por_cliente` — nome NOVO, um objeto por (cliente, TIPO).
--
-- ⚠️ NAO derruba `farmer_melhor_individual_por_cliente`. Ela serve o front antigo ate o Publish
--    ser ADOTADO pelo cliente (o SW so troca de build no clique). Derrubar aqui quebraria a aba
--    aberta de quem ainda nao atualizou. A limpeza e um PR posterior.
--
-- ⚠️ NAO faz backfill. A ordem nao e recuperavel das colunas existentes, e re-derivar com precos
--    de HOJE sobre uma geracao de 21/08 fabricaria numero. Os 1.083 pendentes nascem com `ordem`
--    nula e a RPC os apresenta como `ordem_indisponivel` — que e a verdade.
-- ============================================================================================

-- GUARD DE ORDEM DE APPLY: sem o writer de 8 parametros (20260815181500, o que tem `p_head_visto`)
-- o CREATE OR REPLACE abaixo CRIARIA uma funcao nova em vez de substituir a existente, deixando
-- duas sobrecargas e um `.rpc()` ambiguo. Abortar nomeando a dependencia e mais barato que isso.
DO $guard$
BEGIN
  IF to_regprocedure('public.farmer_recomendacoes_substituir(uuid,uuid,uuid,jsonb,text,text,jsonb,uuid)') IS NULL THEN
    RAISE EXCEPTION 'DEPENDENCIA FALTANDO: aplique antes a 20260815181500_farmer_geracao_head_sensor.sql (writer com p_head_visto)';
  END IF;
END
$guard$;

-- ── 1) AS COLUNAS ───────────────────────────────────────────────────────────────────────────
ALTER TABLE public.farmer_recommendations
  ADD COLUMN IF NOT EXISTS ordem              smallint,
  ADD COLUMN IF NOT EXISTS referencia_ambigua boolean;

COMMENT ON COLUMN public.farmer_recommendations.ordem IS
  'Rank DENSO dentro de (farmer_id, customer_user_id, recommendation_type, run_id): candidatos que o sinal nao separou COMPARTILHAM o valor. NULL = geracao gravada por produtor que nao calcula rank (aceitacao declarada de perda de cobertura, spec §6). Numerar 1,2,3 entre empatados trocaria o endereco do defeito: de uuid para indice do array, que e a ordem de varredura do catalogo.';

COMMENT ON COLUMN public.farmer_recommendations.referencia_ambigua IS
  'up_sell: o preco de referencia deste CLIENTE saiu de um desempate por uuid em preco-referencia.ts (instante indistinguivel entre pedidos distintos, com precos diferentes). Marca do CLIENTE e nao da linha: a deduplicacao guarda por SKU so a melhor relacao, e a razao de preco que decide essa "melhor" e justamente a que a referencia sorteada altera — a flag da linha sumiria com a relacao descartada. cross_sell grava false explicito (o tipo nao usa preco). NULL = nao medido; NAO usar DEFAULT false, que afirmaria medicao sobre 17.316 linhas legadas.';

-- ── 2) O WRITER, com as duas chaves no payload ──────────────────────────────────────────────
-- CREATE OR REPLACE (nao DROP+CREATE): preserva o ACL. Corpo extraido de pg_get_functiondef da
-- PROD em 07/09/2026 23:0x e alterado em 6 pontos — as duas listas de jsonb_to_recordset que
-- importam (validacao e INSERT), a clausula de `ordem < 1`, a mensagem do FG007, e as colunas
-- no INSERT. As outras duas listas de recordset (escopo de carteira) leem so `customer_user_id`
-- e ficam intocadas.
CREATE OR REPLACE FUNCTION public.farmer_recomendacoes_substituir(p_farmer_id uuid, p_run_id uuid, p_geracao_vista uuid, p_linhas jsonb, p_completude text DEFAULT NULL::text, p_motivo text DEFAULT NULL::text, p_insumos jsonb DEFAULT NULL::jsonb, p_head_visto uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_total          integer;
  v_invalidas      integer;
  v_fora_escopo        integer;
  v_geracao_atual  uuid;
  v_expiradas      integer;
  v_inseridas      integer;
  v_head_atual     uuid;
BEGIN
  -- 1) Gate de MENSAGEM (a RLS é quem autoriza — ver cabeçalho).
  IF p_farmer_id IS NULL OR p_run_id IS NULL THEN
    RAISE EXCEPTION 'p_farmer_id e p_run_id são obrigatórios' USING ERRCODE = 'FG001';
  END IF;
  -- ⚠️ `IS NOT TRUE`, não `NOT (...)`. Numa sessão SEM JWT (pg_cron, psql) `auth.uid()`
  -- devolve NULL, então `p_farmer_id = auth.uid()` é NULL e a disjunção inteira vira
  -- NULL — e `IF NOT NULL THEN` NÃO dispara em PL/pgSQL. Medido em prod:
  --   NOT (false OR NULL OR false)          => NULL   (o RAISE nunca acontece)
  --   (false OR NULL OR false) IS NOT TRUE  => true   (barra, como se quer)
  IF (
    coalesce(auth.role(), '') = 'service_role'
    OR p_farmer_id = auth.uid()
    OR coalesce(private.cap_carteira_escrever(auth.uid()), false)
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'Acesso negado: só o próprio farmer ou quem tem cap_carteira_escrever substitui recomendações'
      USING ERRCODE = '42501';
  END IF;

  -- 2) FORMATO.
  IF p_linhas IS NULL OR jsonb_typeof(p_linhas) <> 'array' THEN
    RAISE EXCEPTION 'p_linhas deve ser um array jsonb (recebido: %)',
      coalesce(jsonb_typeof(p_linhas), 'null') USING ERRCODE = 'FG002';
  END IF;

  v_total := jsonb_array_length(p_linhas);

  -- 3) LOTE VAZIO = RECUSA, não "expira tudo e deixa o farmer sem oferta".
  -- Zero recomendação quase sempre é dado faltando a montante (catálogo, scores,
  -- get_skus_margem_positiva), não "este farmer não tem o que oferecer" — mesmo
  -- raciocínio que farmer_association_rules_substituir aplica ao lote vazio.
  -- ⚠️ Isto SEGUE valendo depois do head: quem tem geração legitimamente vazia
  -- chama `farmer_geracao_registrar` (que move o head e não toca em linha nenhuma),
  -- e não esta função. Afrouxar aqui religaria a expiração — que está FORA do escopo
  -- desta fase por decisão explícita.
  IF v_total = 0 THEN
    RAISE EXCEPTION 'lote vazio: as % recomendação(ões) pendentes deste farmer foram preservadas',
      (SELECT count(*) FROM public.farmer_recommendations
        WHERE farmer_id = p_farmer_id AND status = 'pendente')
      USING ERRCODE = 'FG003';
  END IF;

  -- Teto defensivo: a maior geração medida em prod tem ~1.000 linhas
  -- (3 cross + 2 up por cliente). 50k é ~50x isso — folga sem ficar ilimitado.
  IF v_total > 50000 THEN
    RAISE EXCEPTION 'lote de % linhas excede o teto de 50000', v_total USING ERRCODE = 'FG004';
  END IF;

  -- 4) SERIALIZAÇÃO por FARMER (não global: duas vendedoras recalculando ao mesmo
  -- tempo mexem em escopos disjuntos e não têm por que esperar uma pela outra).
  -- `xact` = o lock sai sozinho no commit/rollback.
  IF NOT pg_try_advisory_xact_lock(
        hashtext('farmer_recomendacoes_substituir'), hashtext(p_farmer_id::text)) THEN
    RAISE EXCEPTION 'outro recálculo deste farmer está em andamento — nada foi alterado'
      USING ERRCODE = 'FG005';
  END IF;

  -- 5) GUARD CAUSAL (compare-and-swap).
  -- O advisory lock acima só cobre a TRANSAÇÃO da RPC — ele não cobre a janela
  -- longa entre "o motor leu o snapshot" e "o motor chamou esta função". Sem este
  -- guard, dois recálculos sobrepostos terminam com o MAIS LENTO vencendo, e o
  -- mais lento é justamente o que leu o snapshot mais VELHO (money-path §10: o
  -- degradado terminar depois do saudável é o desfecho esperado, não o azar).
  -- NULL casa NULL: primeira execução, e as linhas legadas (run_id NULL).
  SELECT run_id INTO v_geracao_atual
  FROM public.farmer_recommendations
  WHERE farmer_id = p_farmer_id AND status = 'pendente'
  ORDER BY created_at DESC, id DESC
  LIMIT 1;

  IF v_geracao_atual IS DISTINCT FROM p_geracao_vista THEN
    RAISE EXCEPTION 'geração vigente mudou durante o cálculo (vista: %, atual: %) — nada foi alterado',
      coalesce(p_geracao_vista::text, 'nenhuma'), coalesce(v_geracao_atual::text, 'nenhuma')
      USING ERRCODE = 'FG006';
  END IF;

  -- 6) VALIDAÇÃO ANTES DE MEXER (nada é expirado se o lote tem lixo).
  SELECT count(*) INTO v_invalidas
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    affinity_score          numeric,
    ordem                   smallint,
    referencia_ambigua      boolean
  )
  WHERE r.customer_user_id IS NULL
     OR r.product_id IS NULL
     OR r.recommendation_type IS NULL
     OR r.recommendation_type NOT IN ('cross_sell', 'up_sell')
     -- Finitude nos TRÊS lados. `>= 0` sozinho NÃO sanea: medido em prod,
     -- `'NaN' >= 0` é TRUE e `'Infinity' >= 0` é TRUE (money-path §2).
     OR r.affinity_score IS NULL
     OR NOT (
          r.affinity_score >= 0
          AND r.affinity_score < 'Infinity'::numeric
          AND r.affinity_score <> 'NaN'::numeric
        )
     -- `ordem` e OPCIONAL (o produtor legado nao a emite, e §6 aceita essa perda de
     -- cobertura), mas quando VEM tem de ser rank: 0 e negativo nao sao posicao.
     -- Nao ha teto aqui — `smallint` ja explodiu no cast antes desta linha.
     OR (r.ordem IS NOT NULL AND r.ordem < 1);

  IF v_invalidas > 0 THEN
    RAISE EXCEPTION '% de % linha(s) inválidas (cliente/produto/tipo ausente, afinidade nula/negativa/NaN/Infinita, ou ordem < 1) — nada foi expirado',
      v_invalidas, v_total USING ERRCODE = 'FG007';
  END IF;
  -- 6-bis) ESCOPO DE CARTEIRA — o cliente do lote precisa ser DESTE farmer.
  --
  -- `farmer_client_scores` tem UNIQUE (customer_user_id): o dono de um cliente é uma
  -- FUNÇÃO, computável aqui dentro. Até esta versão a RPC aceitava qualquer cliente e
  -- carimbava `p_farmer_id` por cima — foi por essa porta que o fallback do browser
  -- ("carteira vazia ⇒ carregue TODOS os scores") gravou 2.676 linhas com `farmer_id` ≠
  -- dono do cliente. Medido em prod (psql-ro, 21/08/2026): o lote de abril sob o farmer
  -- 33f59dc7 cobria 166 clientes e só 25,9% eram dele, contra os 18,8% da base que ele
  -- detém — a assinatura de quem sorteou da base inteira, não de quem leu a própria carteira.
  --
  -- O gate tinha que ser AQUI, não só no browser: o cliente não pode ser a autoridade
  -- sobre o próprio escopo (#1840 — o browser reescrevia as regras do servidor por cima).
  --
  -- E o dano SOBREVIVE ao conserto do browser porque a etapa 7 expira
  -- `WHERE farmer_id = p_farmer_id`: a linha do cliente C gravada sob A, quando o dono é B,
  -- é INVISÍVEL ao recálculo de B — o dono real recalcula e ela segue pendente, dando ao
  -- mesmo cliente duas gerações vivas ao mesmo tempo.
  --
  -- `IS DISTINCT FROM`, não `<>`: o cliente SEM linha de score precisa cair do MESMO lado.
  -- `<>` com NULL devolve NULL, o `WHERE` descarta, e o cliente de dono desconhecido passaria
  -- — exatamente o caso mais suspeito. Dono desconhecido é recusa, nunca "grave assim mesmo".
  --
  -- Isto é FAIL-CLOSED sob a RLS: a função é SECURITY INVOKER e `farmer_client_scores` só
  -- se deixa ler por `cap_carteira_ler(uid) OR carteira_visivel_para(cliente, uid)`. Se a RLS
  -- esconder do chamador a linha de um cliente alheio, o LEFT JOIN devolve NULL — e NULL é
  -- recusado. A cegueira da RLS vira RECUSA, não passagem.
  -- 6-ter) LOCK CAUSAL DO ESCOPO — a metade que a trigger de troca de dono NÃO cobre.
  -- O guard do #1850 compara o lote com o dono LIDO aqui; a trigger nova
  -- (private.farmer_expirar_pendentes_do_dono_anterior) expira o que já existia quando o
  -- dono muda. Nenhum dos dois cobre a janela ENTRE eles:
  --
  --   T1 (esta RPC, farmer A)          T2 (reatribuição do cliente C para B)
  --   ------------------------         -------------------------------------
  --   FG009 lê score de C = A
  --                                    UPDATE farmer_client_scores: C -> B
  --                                    trigger expira as pendentes de C que existiam
  --   INSERT da oferta C sob A         (a linha NOVA nasce depois da varredura)
  --   COMMIT                           COMMIT
  --
  -- A oferta nova sobrevive fora de escopo. O advisory lock do passo 4 não ajuda: ele é
  -- por FARMER, e quem reatribui não o toma. Travar as linhas de score do lote até o
  -- COMMIT resolve nos dois sentidos — se a troca chega antes, ela espera e a trigger
  -- alcança a linha nova; se chega depois, esta RPC já lê o dono novo e o FG009 recusa.
  --
  -- `FOR SHARE`, não `FOR KEY SHARE`: um UPDATE que não mexe em chave toma
  -- `FOR NO KEY UPDATE`, que NÃO conflita com `FOR KEY SHARE` — o lock mais fraco
  -- deixaria a corrida exatamente como estava, e o teste do caminho feliz seguiria verde.
  -- `FOR SHARE` conflita, e é compartilhado: duas vendedoras com lotes disjuntos não se
  -- esperam (só quem tenta REATRIBUIR espera).
  --
  -- O `ORDER BY` é best-effort contra deadlock (o PG não garante ordem de travamento sob
  -- ORDER BY). A garantia real é a ordem de RECURSOS, que esta fatia mantém única em todo
  -- o domínio: farmer_client_scores -> farmer_recommendations. A trigger segue a mesma
  -- ordem (é disparada POR um UPDATE em scores e só então toca recomendações), então não
  -- há ciclo a inverter.
  --
  -- Cliente do lote SEM linha de score não trava nada — não há linha. Não é buraco: o
  -- FG009 logo abaixo recusa o lote inteiro nesse caso (dono desconhecido é recusa).
  PERFORM 1
    FROM public.farmer_client_scores s
   WHERE s.customer_user_id IN (
           SELECT DISTINCT c.customer_user_id
             FROM jsonb_to_recordset(p_linhas) AS c(customer_user_id uuid)
            WHERE c.customer_user_id IS NOT NULL
         )
   ORDER BY s.customer_user_id
     FOR SHARE;

  SELECT count(*) INTO v_fora_escopo
  FROM jsonb_to_recordset(p_linhas) AS r(customer_user_id uuid)
  LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = r.customer_user_id
  WHERE s.farmer_id IS DISTINCT FROM p_farmer_id;

  -- FG009, não FG008: o 008 JÁ É de outra defesa deste mesmo domínio — a trigger que barra
  -- INSERT direto de pendente sem `run_id` (migration 20260814223445). Reusar o código
  -- tornaria dois erros distintos indistinguíveis pela SQLSTATE, que é justamente o que um
  -- chamador usa para decidir o que fazer. Verificado em prod: FG001–FG008 e FG101–FG107
  -- ocupados; 009 livre.
  IF v_fora_escopo > 0 THEN
    RAISE EXCEPTION '% de % linha(s) são de cliente fora da carteira deste farmer — nada foi expirado',
      v_fora_escopo, v_total USING ERRCODE = 'FG009';
  END IF;

  -- 7) A TROCA — os dois statements na MESMA transação.
  -- Só 'pendente' é tocado: linha com desfecho ('ofertado'/'aceito'/'rejeitado')
  -- é histórico e fica imutável. E é UPDATE, nunca DELETE.
  UPDATE public.farmer_recommendations
     SET status         = 'expirado',
         expired_at     = clock_timestamp(),
         expired_by_run = p_run_id,
         updated_at     = clock_timestamp()
   WHERE farmer_id = p_farmer_id
     AND status = 'pendente';
  GET DIAGNOSTICS v_expiradas = ROW_COUNT;

  INSERT INTO public.farmer_recommendations (
    farmer_id, customer_user_id, recommendation_type, product_id, current_product_id,
    p_ij, m_ij, lie, affinity_score, complexity_factor, cluster_volume_estimate,
    ordem, referencia_ambigua,
    status, run_id
  )
  SELECT
    p_farmer_id, r.customer_user_id, r.recommendation_type, r.product_id, r.current_product_id,
    r.p_ij,
    -- m_ij e lie são DINHEIRO e saíram de cena no #1520 (o custo não chega mais ao
    -- browser). Fixados em NULL aqui, não copiados do payload: o cliente não tem
    -- como fabricá-los de volta.
    NULL, NULL,
    r.affinity_score, coalesce(r.complexity_factor, 1), coalesce(r.cluster_volume_estimate, 1),
    -- Sem coalesce NENHUM nos dois: NULL aqui significa "o produtor nao mediu", e um
    -- default afirmaria medicao que ninguem fez (money-path §2). Quem le fecha a falha
    -- (a RPC trata flag NULL com ordem preenchida como ambigua).
    r.ordem, r.referencia_ambigua,
    'pendente', p_run_id
  FROM jsonb_to_recordset(p_linhas) AS r(
    customer_user_id        uuid,
    recommendation_type     text,
    product_id              uuid,
    current_product_id      uuid,
    p_ij                    numeric,
    affinity_score          numeric,
    complexity_factor       numeric,
    cluster_volume_estimate numeric,
    ordem                   smallint,
    referencia_ambigua      boolean
  );
  GET DIAGNOSTICS v_inseridas = ROW_COUNT;

  -- 8) O HEAD, na MESMA transação — com o head que o CHAMADOR viu ANTES do cálculo.
  --
  -- ⚠️ A 1ª versão lia o head AQUI DENTRO e o passava adiante, o que satisfazia o CAS por
  -- construção e abria a assimetria que o challenge Codex xhigh encontrou: um run VAZIO
  -- que commita entre a leitura e a escrita de um run COM LINHAS não é visto pelo CAS da
  -- etapa 5 (ele compara LINHAS, e o vazio não mexeu em linha nenhuma), então o run antigo
  -- sobrescrevia um vazio mais novo. O sistema misturava duas ordens: frescor causal para
  -- o vazio e ordem-de-commit para as linhas. Comparar o head ORIGINAL alinha as duas.
  --
  -- `p_completude IS NULL` é o marcador de chamador ANTERIOR ao sensor (assinatura de 4
  -- args, bundle velho em cache): ele não tem head para declarar, então cai no head
  -- corrente em vez de ser recusado por não saber de algo que não existia quando foi
  -- escrito. Os dois sinais de "cliente antigo" são o mesmo, de propósito.
  IF p_completude IS NULL THEN
    SELECT run_id INTO v_head_atual
    FROM public.farmer_geracao_vigente
    WHERE motor = 'cross_sell' AND farmer_id = p_farmer_id;
  ELSE
    v_head_atual := p_head_visto;
  END IF;

  PERFORM public.farmer_geracao_registrar(
    'cross_sell', p_farmer_id, p_run_id, 'linhas', v_inseridas,
    p_completude, p_motivo, p_insumos, v_head_atual
  );

  RETURN jsonb_build_object(
    'run_id',    p_run_id,
    'expiradas', v_expiradas,
    'inseridas', v_inseridas
  );
END;
$function$;


-- ── 3) A RPC NOVA ───────────────────────────────────────────────────────────────────────────
-- Nome NOVO porque o CONTRATO mudou: uma linha por cliente virou uma por (cliente, TIPO), e o
-- campo unico de produto virou identidade + eleicao separadas. Reusar o nome faria o front antigo
-- receber uma resposta que ele interpreta errado em silencio.
--
-- ⚠️ IDENTIDADE E ELEICAO SAO CAMPOS SEPARADOS, e essa e a peca central:
--   `produtos`       — os SKUs que a tela vai NOMEAR. Sempre >= 1.
--   `produto_eleito` — nao-nulo se e somente se `situacao = 'eleito'`. Guard estrutural.
-- Um campo unico obrigava a escolher entre "so o eleito tem identidade" (e ai a tela nao tem nome
-- para mostrar quando nao ha eleicao) e "todo estado tem product_id" (e ai a tela renderiza um
-- vencedor por descuido). Identificar produtos NAO exige afirmar prioridade entre eles.
--
-- ⚠️ `candidatos` tem UM significado: o tamanho do grupo registrado. Uma versao anterior fazia o
-- campo contar conjunto diferente por estado — o consumidor teria de inferir o denominador do
-- rotulo. Com `produtos` transportando quem e nomeado, `[A:1, B:1, C:2]` sai como
-- produtos=[A,B], candidatos=3, e a tela pode dizer "2 de 3", que e a frase verdadeira.
--
-- ⚠️ PRECEDENCIA, nao tabela de condicoes soltas: a primeira que casa decide. Sem ela um grupo de
-- um candidato COM ordem satisfaz "unico_registrado" e "topo unico" ao mesmo tempo.
--   1 referencia_ambigua · 2 ordem_indisponivel · 3 unico_registrado · 4 empatado · 5 eleito
-- Ambiguidade a montante invalida eleicao E empate: empate calculado sobre referencia sorteada
-- nao e igualdade medida, e coincidencia de um sorteio.
--
-- ⚠️ FAIL-CLOSED em dois lugares: `coalesce(referencia_ambigua, ordem IS NOT NULL)` trata flag
-- nula COM ordem preenchida como ambigua (par que so nasce de produtor que grava rank sem flag —
-- impossivel enquanto os dois entram na mesma versao, e e por ser impossivel que a falha tem de
-- ser fechada); e `coalesce(t.no_topo, 2) > 1` faz um topo nao-contado cair em `empatado`, nunca
-- em `eleito`.
--
-- ⚠️ LIMITE DECLARADO: `run_id` e um por grupo. Se um grupo misturar geracoes — o que so acontece
-- se o writer falhar —, esta RPC nao detecta; o canario do leitor conta geracoes ENTRE grupos,
-- nao DENTRO de um.
--
-- SECURITY INVOKER de proposito, como a RPC que ela sucede: `frec_select_carteira` segue sendo a
-- unica fronteira, e `p_farmer_id` e FILTRO, nao autorizacao. `coalesce(..., '[]')` mantem o par
-- do contrato: `[]` = li e nao ha; NULL = a leitura falhou, e o caller LANCA.
CREATE OR REPLACE FUNCTION public.farmer_melhores_individuais_por_cliente(p_farmer_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', pg_temp
AS $fn$
  WITH base AS (
    SELECT r.customer_user_id, r.recommendation_type, r.product_id,
           r.affinity_score, r.run_id, r.ordem, r.referencia_ambigua
    FROM public.farmer_recommendations r
    WHERE r.farmer_id = p_farmer_id
      AND r.status = 'pendente'
      -- fail-closed do #1800: sem score nao ha oferta, e ordenar por coluna toda-nula elegeria
      -- um vencedor ARBITRARIO que a tela apresentaria como veredicto.
      AND r.affinity_score IS NOT NULL
  ),
  grupo AS (
    SELECT b.customer_user_id, b.recommendation_type,
           count(DISTINCT b.product_id)                                 AS candidatos,
           count(*) FILTER (WHERE b.ordem IS NULL)                      AS sem_ordem,
           min(b.ordem)                                                 AS ordem_minima,
           bool_or(coalesce(b.referencia_ambigua, b.ordem IS NOT NULL)) AS ambigua,
           max(b.affinity_score)                                        AS affinity_score,
           (array_agg(b.run_id ORDER BY b.run_id))[1]                   AS run_id
    FROM base b
    GROUP BY 1, 2
  ),
  topo AS (
    SELECT g.customer_user_id, g.recommendation_type,
           count(DISTINCT b.product_id) AS no_topo
    FROM grupo g
    JOIN base b USING (customer_user_id, recommendation_type)
    WHERE g.ordem_minima IS NOT NULL AND b.ordem = g.ordem_minima
    GROUP BY 1, 2
  ),
  final AS (
    SELECT g.customer_user_id, g.recommendation_type, g.candidatos, g.ordem_minima,
           g.affinity_score, g.run_id,
           CASE
             WHEN g.ambigua                              THEN 'referencia_ambigua'
             WHEN g.candidatos >= 2 AND g.sem_ordem > 0  THEN 'ordem_indisponivel'
             WHEN g.candidatos = 1                       THEN 'unico_registrado'
             WHEN coalesce(t.no_topo, 2) > 1             THEN 'empatado'
             ELSE                                             'eleito'
           END AS situacao
    FROM grupo g
    LEFT JOIN topo t USING (customer_user_id, recommendation_type)
  )
  SELECT coalesce(
           jsonb_agg(to_jsonb(m) ORDER BY m.customer_user_id, m.recommendation_type),
           '[]'::jsonb)
  FROM (
    SELECT f.customer_user_id, f.recommendation_type, f.situacao, f.candidatos,
           f.affinity_score, f.run_id,
           -- `eleito` e `empatado` nomeiam o TOPO; os tres estados sem ordenacao confiavel
           -- nomeiam o grupo INTEIRO — la nao existe topo que signifique alguma coisa.
           (SELECT jsonb_agg(DISTINCT b.product_id ORDER BY b.product_id)
              FROM base b
             WHERE b.customer_user_id    = f.customer_user_id
               AND b.recommendation_type = f.recommendation_type
               AND (f.situacao NOT IN ('eleito', 'empatado') OR b.ordem = f.ordem_minima)
           ) AS produtos,
           CASE WHEN f.situacao = 'eleito' THEN
             (SELECT (array_agg(b.product_id ORDER BY b.product_id))[1]
                FROM base b
               WHERE b.customer_user_id    = f.customer_user_id
                 AND b.recommendation_type = f.recommendation_type
                 AND b.ordem               = f.ordem_minima)
           END AS produto_eleito
    FROM final f
  ) m
$fn$;

COMMENT ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) IS
  'Motor de bundles: a melhor oferta individual de cada cliente POR TIPO (cross_sell e up_sell disputavam a mesma coluna de score sem regra comercial — up vencia 186 de 186). Uma tupla jsonb = um snapshot MVCC, e o cap de 1.000 do PostgREST some por construcao. Identidade (`produtos`) e separada de eleicao (`produto_eleito`, nao-nulo <=> situacao eleito): a tela nomeia sempre, e afirma prioridade so quando o sinal decidiu. `situacao` tem 5 estados avaliados por PRECEDENCIA (referencia_ambigua > ordem_indisponivel > unico_registrado > empatado > eleito). `[]` = li e nao ha; NULL nunca sai daqui, e o caller trata NULL como FALHA. SECURITY INVOKER: frec_select_carteira segue sendo a unica fronteira.';

-- Privilegios: CREATE OR REPLACE preserva o ACL, mas na PRIMEIRA criacao nao ha ACL para
-- preservar e vale o default do Supabase. Reemitidos NOMEANDO as roles (REVOKE de PUBLIC nao tira
-- anon/authenticated, que sao concedidos por nome). Sob INVOKER o EXECUTE e so o direito de
-- CHAMAR — quem decide quais linhas voltam e a RLS; `anon` sai porque chamada que nao pode
-- devolver nada nao deve existir.
REVOKE ALL ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farmer_melhores_individuais_por_cliente(uuid) TO service_role;

-- FU4-F fase 3 / PR-B — ranqueamento de margem sai do browser
--
-- CONTEXTO. `useCrossSellEngine` e `useBundleEngine` baixam public.product_costs INTEIRA
-- (3.642 linhas, medido 2026-07-21) e calculam `margin = price - cost` no cliente. Enquanto
-- fizerem isso, product_costs nao pode ir para private.cap_custo_ler sem apagar a feature
-- (spec 2026-07-20-fechamento-custo-recommend-engines-design.md §5).
--
-- Esta migration cria a RPC que devolve o RESULTADO (ordem + sinal), nunca o insumo.
--
-- DECISAO DE PRODUTO (dono, 2026-07-20): a vendedora ve apenas que a margem de contribuicao
-- esta NEGATIVA. Sem valor em reais, sem percentual. Percentual nao serve porque
-- custo = preco x (1 - margem%) inverte igual ao absoluto.
--
-- POR QUE BOOLEANO E NAO FAIXA verde/amarelo/vermelho (divergencia consciente do §4.3 do spec
-- irmao, registrada no PR): a faixa do get_carteira_margem_faixa e sobre a margem AGREGADA de um
-- cliente — nao inverte para o custo de um SKU. Esta RPC e por CANDIDATO, e o preco do candidato
-- e conhecido pela vendedora (ela vende o catalogo). Com preco a vista, "amarelo = margem 0..30%"
-- localiza o custo entre 70% e 100% do preco: faixa estreita demais. 1 bit (negativa) e o teto.
--
-- O PRECO E RESOLVIDO NO SERVIDOR — nunca aceito do caller. Se o caller escolhesse o preco, ele
-- leria `margem_negativa` para um preco arbitrario e acharia o custo por BUSCA BINARIA em ~20
-- chamadas por SKU. E o mesmo oraculo por bisseccao que o #1488 fechou movendo a comparacao de
-- lado (spec §9.5.2). O caller manda identificadores e os fatores que NAO tocam custo.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Precondicoes: aborta se o banco vivo divergir do esperado (§4.1 do spec da E2).
-- ─────────────────────────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('private.cap_custo_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.cap_custo_ler(uuid) ausente (a matriz do #1434 nao esta aplicada)';
  END IF;
  IF to_regprocedure('private.cap_carteira_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.cap_carteira_ler(uuid) ausente';
  END IF;
  IF to_regprocedure('private.carteira_visivel_para(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.carteira_visivel_para(uuid,uuid) ausente';
  END IF;
  IF to_regprocedure('private.regua_num_finito(numeric)') IS NULL THEN
    RAISE EXCEPTION 'precondicao FALHOU: private.regua_num_finito(numeric) ausente (#1488 P1)';
  END IF;
END
$pre$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: custo canonico. Espelha src/lib/custo/custoCanonico.ts VERBATIM.
--   canonico = cost_final, fallback cost_price; finito E > 0; senao NULL.
-- ausente != zero: NULL faz o SKU sair do ranking, nunca virar margem cheia (#1466).
--
-- 'NaN'::numeric e valor LEGITIMO em Postgres e mente nas comparacoes ('NaN' > 0 e TRUE, e
-- NaN = NaN tambem e TRUE, ao contrario de IEEE — entao o truque v <> v NAO detecta). Por isso
-- a finitude vem de private.regua_num_finito, criado no #1488 exatamente para este buraco.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.custo_canonico(p_cost_final numeric, p_cost_price numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE
    WHEN private.regua_num_finito(p_cost_final) AND p_cost_final > 0 THEN p_cost_final
    WHEN private.regua_num_finito(p_cost_price) AND p_cost_price  > 0 THEN p_cost_price
    ELSE NULL
  END;
$fn$;

COMMENT ON FUNCTION private.custo_canonico(numeric, numeric) IS
  'Custo canonico p/ money-path. Espelho SQL de src/lib/custo/custoCanonico.ts (cost_final -> cost_price, finito e > 0, senao NULL). Paridade provada em db/test-authz-custo-fu4f-fase3-ranking.sh.';

-- ─────────────────────────────────────────────────────────────────────────────
-- public.get_ranking_margem(p_itens jsonb)
--
-- Recebe candidatos JA pontuados na parte que nao toca custo (pij, volume, pBundle) e devolve
-- a ORDEM mais o SINAL. O custo entra, e nao sai.
--
-- ENTRADA — array de objetos:
--   chave    text    identificador opaco do caller, devolvido como veio (correlacao)
--   grupo    text    particao do ranking (customer_user_id) — a ordem e por grupo
--   tipo     text    'cross_sell' | 'up_sell' | 'bundle'
--   produtos uuid[]  cross_sell/bundle: os SKUs somados. up_sell: [premium, atual] nesta ordem
--   peso     numeric multiplicador de volume (clusterVolume, qty comprada, 1 no bundle)
--   fator    numeric multiplicador que nao toca custo (pij x complexityFactor, ou pBundle)
--
-- SAIDA — uma linha por item de entrada:
--   chave           devolvida como veio
--   ordem           posicao no ranking DENTRO do grupo (1 = melhor). NULL se inelegivel.
--   elegivel        entra no ranking? (todos os custos conhecidos E mij > 0)
--   margem_negativa TRUE se a margem somada < 0. NULL se algum custo e desconhecido
--                   (ausente != zero — nao empurra o SKU para uma cor que nao se sabe)
--   mij, lie        SO com private.cap_custo_ler. Senao NULL com a CHAVE PRESENTE.
--
-- FAIL-CLOSED: auth.uid() IS NULL -> zero linhas. Com service_role auth.uid() e NULL, entao
-- ligar um chamador no client errado falha FECHADO.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_ranking_margem(p_itens jsonb)
RETURNS TABLE (
  chave           text,
  ordem           integer,
  elegivel        boolean,
  margem_negativa boolean,
  mij             numeric,
  lie             numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', pg_temp
AS $fn$
DECLARE
  v_uid        uuid    := (SELECT auth.uid());
  v_pode_custo boolean;
  v_n          integer;
  -- teto de itens por chamada. Os engines LOTEIAM por cliente (a RPC ja particiona por `grupo`,
  -- entao varios clientes cabem numa chamada). Sem teto, um caller manda 10^6 itens e o
  -- SECURITY DEFINER vira amplificador de DoS com privilegio — a RPC le product_costs inteira
  -- por termo. O cap e do CONTRATO, nao uma otimizacao.
  c_max_itens  constant integer := 5000;
BEGIN
  -- fail-closed: sem identidade, nada sai
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  -- entrada malformada nao levanta erro (o caller nao deve aprender nada pelo tipo do erro)
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' THEN
    RETURN;
  END IF;

  -- jsonb_array_length e a medida CERTA aqui (o array e 1-D por contrato). O analogo do
  -- array_length(a,1) que o #1488 mostrou ser furavel por array multidimensional nao se aplica
  -- a jsonb, mas o cap tem de existir e ser FAIL-CLOSED: excedeu, nao processa NADA (em vez de
  -- truncar em silencio, que devolveria um ranking parcial com cara de completo).
  v_n := jsonb_array_length(p_itens);
  IF v_n > c_max_itens THEN
    RAISE EXCEPTION 'get_ranking_margem: % itens excede o teto de % por chamada — loteie', v_n, c_max_itens
      USING ERRCODE = 'program_limit_exceeded';
  END IF;

  v_pode_custo := COALESCE(private.cap_custo_ler(v_uid), false);

  RETURN QUERY
  WITH item AS (
    SELECT
      e.ord                                             AS seq,
      NULLIF(e.value->>'chave', '')                     AS i_chave,
      -- MESMA armadilha do peso: `grupo::uuid` com lixo levanta 22P02 e derruba a chamada.
      -- Formato invalido vira NULL e o item cai fora no gate de carteira (fail-closed).
      CASE WHEN e.value->>'grupo' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (e.value->>'grupo')::uuid END           AS i_grupo,
      COALESCE(NULLIF(e.value->>'tipo',''),'cross_sell') AS i_tipo,
      -- peso/fator: default 1. Nao-finito vira 1 (nunca NULL silencioso, nunca NaN propagando).
      --
      -- ⚠️ O `jsonb_typeof = 'number'` e OBRIGATORIO e vem PRIMEIRO, num CASE ANINHADO. Testado
      -- no PG17: `CASE WHEN regua_num_finito((v->>'peso')::numeric) ...` com peso="abc" NAO
      -- degrada — levanta `invalid input syntax for type numeric` (22P02) e derruba a chamada
      -- INTEIRA. O CASE nao protege o cast que aparece na PROPRIA condicao, e `AND` nao garante
      -- short-circuit em SQL (a ordem de avaliacao de AND nao e especificada). CASE aninhado
      -- garante: o Postgres nao avalia o branch nao escolhido.
      -- Sem isto, `{"peso":"abc"}` e um DoS de uma linha contra uma RPC SECURITY DEFINER.
      CASE WHEN jsonb_typeof(e.value->'peso') = 'number' THEN
             CASE WHEN private.regua_num_finito((e.value->>'peso')::numeric)
                  THEN (e.value->>'peso')::numeric ELSE 1 END
           ELSE 1 END                                   AS i_peso,
      CASE WHEN jsonb_typeof(e.value->'fator') = 'number' THEN
             CASE WHEN private.regua_num_finito((e.value->>'fator')::numeric)
                  THEN (e.value->>'fator')::numeric ELSE 1 END
           ELSE 1 END                                   AS i_fator,
      e.value->'produtos'                               AS i_produtos
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS e(value, ord)
    WHERE jsonb_typeof(e.value) = 'object'
  ),
  -- GATE DE CARTEIRA: espelha a RLS de farmer_recommendations/farmer_client_scores.
  -- Sem isto a RPC seria via de vazamento cross-vendedora — SECURITY DEFINER bypassa RLS,
  -- entao o gate tem de ser explicito aqui (money-path.md: gate na fronteira que TODA via cruza).
  item_autorizado AS (
    SELECT i.*
    FROM item i
    WHERE i.i_grupo IS NOT NULL
      AND (
        (SELECT private.cap_carteira_ler(v_uid))
        OR private.carteira_visivel_para(i.i_grupo, v_uid)
      )
  ),
  -- explode os produtos preservando a POSICAO: no up_sell a posicao decide o sinal
  -- ([0] = premium (+1), [1] = atual (-1)). Nos demais tipos todo produto soma (+1).
  termo AS (
    SELECT
      ia.seq,
      p.ord AS pos,
      -- idem: product_id malformado vira NULL, o LEFT JOIN nao casa, a margem fica NULL e o
      -- item inteiro sai inelegivel. Fail-closed sem levantar erro.
      CASE WHEN p.value #>> '{}' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
           THEN (p.value #>> '{}')::uuid END AS product_id,
      CASE WHEN ia.i_tipo = 'up_sell' AND p.ord = 2 THEN -1 ELSE 1 END AS coef
    FROM item_autorizado ia
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(ia.i_produtos) = 'array' THEN ia.i_produtos ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS p(value, ord)
  ),
  -- PRECO E CUSTO SAO RESOLVIDOS AQUI, no servidor. O caller nunca os fornece (anti-bisseccao).
  termo_valorado AS (
    SELECT
      t.seq,
      t.product_id,
      t.coef,
      CASE
        WHEN private.regua_num_finito(pr.valor_unitario) AND pr.valor_unitario > 0
        THEN pr.valor_unitario
        ELSE NULL
      END AS preco,
      private.custo_canonico(pc.cost_final, pc.cost_price) AS custo
    FROM termo t
    LEFT JOIN public.omie_products pr ON pr.id = t.product_id
    LEFT JOIN public.product_costs  pc ON pc.product_id = t.product_id
  ),
  -- margem unitaria por termo; NULL se preco OU custo desconhecido (ausente != zero)
  termo_margem AS (
    SELECT
      tv.seq,
      tv.product_id,   -- propagado: a guarda de forma conta DISTINCT product_id
      tv.coef,
      CASE WHEN tv.preco IS NULL OR tv.custo IS NULL THEN NULL
           ELSE tv.preco - tv.custo END AS margem
    FROM termo_valorado tv
  ),
  agregado AS (
    SELECT
      ia.seq,
      ia.i_chave,
      ia.i_grupo,
      ia.i_tipo,
      ia.i_peso,
      ia.i_fator,
      count(tm.seq)                                    AS n_termos,
      count(DISTINCT tm.product_id)                    AS n_distintos,
      count(*) FILTER (WHERE tm.margem IS NULL)        AS n_desconhecidos,
      sum(tm.coef * tm.margem)                         AS margem_somada
    FROM item_autorizado ia
    LEFT JOIN termo_margem tm ON tm.seq = ia.seq
    GROUP BY ia.seq, ia.i_chave, ia.i_grupo, ia.i_tipo, ia.i_peso, ia.i_fator
  ),
  -- FORMA DO ITEM — esta guarda e o que impede a inversao por combinacao linear.
  --
  -- `margem_negativa` responde `SUM(coef * margem) < 0`. Se o caller pudesse REPETIR um produto,
  -- montaria `[A,B,A,A,...]` em up_sell (coef -1 so na posicao 2) e obteria `k*margem_A - margem_B`
  -- para qualquer k, testando o sinal ate cercar a RAZAO margem_A/margem_B com precisao 1/k. Uma
  -- unica ancora de custo conhecido — e os farmers de hoje TEM ancoras, leram a tabela ate agora —
  -- converte a razao no custo de todo SKU. Bisseccao pela porta dos fundos, sem escolher preco.
  --
  -- Por isso: sem repeticao (n_distintos = n_termos), poucos termos, e up_sell com exatamente 2.
  -- Item malformado sai INELEGIVEL e sem sinal — nao levanta erro, para o caller nao aprender a
  -- forma da guarda pelo tipo do erro.
  --
  -- CTE proprio (e nao a condicao repetida em cada coluna) de proposito: repetida, uma copia
  -- alterada e as outras esquecidas divergem em silencio.
  formado AS (
    SELECT
      a.*,
      (
        a.n_termos > 0
        AND a.n_termos <= 8
        AND a.n_distintos = a.n_termos
        AND (a.i_tipo <> 'up_sell' OR a.n_termos = 2)
      ) AS forma_ok
    FROM agregado a
  ),
  calculado AS (
    SELECT
      f.seq,
      f.i_chave,
      f.i_grupo,
      -- custo desconhecido em QUALQUER termo contamina o item inteiro: sem custo nao ha
      -- afirmacao possivel sobre a margem do conjunto (degradacao honesta)
      (f.forma_ok AND f.n_desconhecidos = 0) AS custo_completo,
      CASE WHEN f.forma_ok AND f.n_desconhecidos = 0
           THEN f.margem_somada * f.i_peso END AS v_mij,
      CASE WHEN f.forma_ok AND f.n_desconhecidos = 0
           THEN f.margem_somada * f.i_peso * f.i_fator END AS v_lie,
      f.margem_somada
    FROM formado f
  ),
  final AS (
    SELECT
      c.seq,
      c.i_chave,
      -- elegivel espelha o filtro dos hooks: `margin == null || margin <= 0 -> continue`
      -- e `if (lie > 0)`. Sem custo -> fora. Margem nao-positiva -> fora.
      (c.custo_completo AND c.v_mij IS NOT NULL AND c.v_mij > 0) AS v_elegivel,
      CASE WHEN c.custo_completo THEN (c.margem_somada < 0) END  AS v_margem_negativa,
      c.v_mij,
      c.v_lie,
      CASE
        WHEN c.custo_completo AND c.v_mij IS NOT NULL AND c.v_mij > 0
        THEN row_number() OVER (
               PARTITION BY c.i_grupo,
                            (c.custo_completo AND c.v_mij IS NOT NULL AND c.v_mij > 0)
               -- desempate por seq: ordem ESTAVEL. Sem isto, itens de lie igual trocam de
               -- posicao entre chamadas e a lista "pula" na tela sem nada ter mudado.
               ORDER BY c.v_lie DESC NULLS LAST, c.seq ASC
             )::integer
      END AS v_ordem
    FROM calculado c
  )
  SELECT
    f.i_chave,
    f.v_ordem,
    f.v_elegivel,
    f.v_margem_negativa,
    -- o NUMERO so sai com a capability. A CHAVE fica presente nos dois casos: o caller
    -- distingue "nao posso ver" de "nao existe" sem precisar de um campo extra.
    CASE WHEN v_pode_custo THEN f.v_mij END,
    CASE WHEN v_pode_custo THEN f.v_lie END
  FROM final f
  ORDER BY f.seq;
END
$fn$;

COMMENT ON FUNCTION public.get_ranking_margem(jsonb) IS
  'FU4-F fase 3: ranqueamento de margem server-side p/ useCrossSellEngine e useBundleEngine. Devolve ordem + margem_negativa (1 bit); mij/lie SO com private.cap_custo_ler. Preco e custo sao resolvidos AQUI (o caller nunca os fornece) — se o caller escolhesse o preco, leria a margem por busca binaria. Gate de carteira espelha a RLS de farmer_recommendations.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privilegios. REVOKE de PUBLIC nao tira anon/authenticated: o Supabase concede por NOME
-- (default privileges), entao revogar por nome e obrigatorio (database.md §RLS).
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.get_ranking_margem(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_ranking_margem(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_ranking_margem(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ranking_margem(jsonb) TO service_role;

COMMIT;

-- FALSIFICAÇÃO do discriminador de cap do gatilho da fase 2 (`db/gatilho-farmer-fase2.sql`).
--
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/falsifica-discriminador-cap-farmer.sql
--
-- O gatilho marca execução SUSPEITA DE TRUNCAMENTO com `NOT (val ? 'esperado') AND n = 1000`.
-- Este arquivo prova as DUAS direções, porque uma só não separa "consertei" de "desliguei o
-- sensor":
--   • leitura CRUA capada CONTINUA disparando (o verdadeiro positivo não pode ter sumido);
--   • contagem DERIVADA que declara `esperado` parou de disparar (o falso positivo alvo).
--
-- E prova que o próprio teste não é teatro: cada caso roda TAMBÉM o predicado ANTERIOR ao
-- #1843 (genérico, sem o `NOT ... esperado`). Se nenhum caso distinguisse as duas versões, o
-- conjunto não exerceria a mudança e passaria com qualquer predicado — por isso o assert final
-- exige, além de zero FAIL, ao menos um caso DISTINGUIDO.
--
-- A 3ª asserção é sobre PROD e é a pergunta perigosa aplicada a dado real: nenhuma ocorrência
-- gravada pode ter `n = 1000` E declarar `esperado` — se tivesse, o #1843 teria desligado a
-- detecção para uma chave que a merecia (falha ABERTA). Ela não fixa contagem, que envelhece.
--
-- Taxonomia chave-a-chave (quem é (a)/(b)/(c) e por quê): cabeçalho de `gatilho-farmer-fase2.sql`.
--
-- Os casos vivem DENTRO do bloco de propósito: uma segunda cópia da lista para o assert
-- divergiria da primeira no primeiro PR que mexesse numa delas, e o teste passaria a medir a
-- cópia errada.
DO $falsifica$
DECLARE
  c            record;
  falhas       int := 0;
  distinguidos int := 0;
  contaminados_com_esperado int;
BEGIN
  FOR c IN
    WITH casos(caso, insumos, deve_disparar, porque) AS (VALUES
      -- ── (a) LEITURA CRUA: sujeita ao cap. TEM de disparar. ────────────────────────────
      ('a1_regras_cross_sell_capada',
       '{"regras":{"ok":true,"n":1000}}'::jsonb, true,
       'farmer_association_rules em .select() SEM .range() (useCrossSellEngine:489) — a unica leitura crua viva que vira insumo'),
      ('a2_vendaveis_cap_historico',
       '{"vendaveis":{"ok":true,"n":1000}}'::jsonb, true,
       'o cap REAL ja ocorrido: 7 execucoes de 19/08 gravaram vendaveis=1000 de 2.465'),
      ('a3_cru_capado_ao_lado_de_derivada',
       '{"regras":{"ok":true,"n":1000},"candidatos_conta_do_cliente":{"ok":true,"n":1000,"esperado":1000}}'::jsonb, true,
       'a vizinha que declara esperado nao pode MASCARAR o cru capado — o EXISTS e por chave'),
      -- ── (b) DERIVADA de leitura paginada, COM esperado: nao pode disparar. ────────────
      ('b1_baskets',
       '{"baskets":{"ok":true,"n":1000,"esperado":1000}}'::jsonb, false,
       'cestas com >=1 item resolvido, de sales_orders via fetchAllPages (imune ao cap)'),
      ('b2_itens_identidade_conforme',
       '{"itens_identidade_conforme":{"ok":true,"n":1000,"esperado":1207}}'::jsonb, false,
       'contagem de ITENS do jsonb, nao de linhas lidas'),
      ('b3_carteira_com_historico_utilizavel',
       '{"carteira_com_historico_utilizavel":{"ok":true,"n":1000,"esperado":1000}}'::jsonb, false,
       'intersecao carteira ativa x quem tem cesta'),
      -- ── (c) SAÍDA do motor, COM esperado: nao pode disparar. ──────────────────────────
      ('c1_candidatos_conta_do_cliente',
       '{"candidatos_conta_do_cliente":{"ok":true,"n":1000,"esperado":1000}}'::jsonb, false,
       'contador do loop de geracao — ja chegou a 52.957 em prod'),
      ('c2_comparacao_individual_produto_resolvido',
       '{"comparacao_individual_produto_resolvido":{"ok":true,"n":1000,"esperado":1000}}'::jsonb, false,
       'loop sobre a saida; a RPC de origem RETURNS jsonb (1 tupla) — o cap conta LINHAS'),
      ('c3_comparacao_individual_leitura',
       '{"comparacao_individual_leitura":{"ok":true,"n":1,"esperado":1}}'::jsonb, false,
       'booleano honesto 0|1 — nunca alcanca a faixa da assinatura'),
      -- ── Falso positivo ACEITO (direção conservadora, custo = janela encolhida). ───────
      ('d1_pedidos_derivada_sem_esperado',
       '{"pedidos":{"ok":true,"n":1000}}'::jsonb, true,
       'Set de customer_user_id: derivada, mas sem esperado — e ATRAVESSOU a faixa (861 -> 1.227)'),
      ('d2_clientes_com_profile_geracao_antiga',
       '{"clientes_com_profile":{"ok":true,"n":1000}}'::jsonb, true,
       'append-only: 9 das 14 ocorrencias gravadas NAO trazem esperado — o teste e por OCORRENCIA, nao por nome'),
      -- ── Controles. ───────────────────────────────────────────────────────────────────
      ('e1_nada_na_faixa',
       '{"regras":{"ok":true,"n":999},"baskets":{"ok":true,"n":21579,"esperado":30939}}'::jsonb, false,
       'so 1000 exato e assinatura'),
      ('e2_insumos_vazio',
       '{}'::jsonb, false,
       'cliente anterior ao sensor: nao declara insumo nenhum')
    )
    SELECT
      k.caso, k.deve_disparar, k.porque,
      -- Predicado EM VIGOR (#1843).
      EXISTS (SELECT 1 FROM jsonb_each(k.insumos) AS i(nome, val)
              WHERE NOT (val ? 'esperado')
                AND (val->>'n')::int = 1000)                     AS atual,
      -- Predicado ANTERIOR ao #1843 (generico), so como CONTROLE do proprio teste.
      EXISTS (SELECT 1 FROM jsonb_each(k.insumos) AS i(nome, val)
              WHERE (val->>'n')::int = 1000)                     AS generico_pre_1843
    FROM casos k
    ORDER BY k.caso
  LOOP
    IF c.atual IS DISTINCT FROM c.generico_pre_1843 THEN
      distinguidos := distinguidos + 1;
    END IF;
    IF c.atual IS NOT DISTINCT FROM c.deve_disparar THEN
      RAISE NOTICE 'PASS  % (disparou=%, pre-1843=%) — %',
        rpad(c.caso, 42), c.atual, c.generico_pre_1843, c.porque;
    ELSE
      falhas := falhas + 1;
      RAISE WARNING 'FAIL  % — esperava disparar=%, obteve % — %',
        rpad(c.caso, 42), c.deve_disparar, c.atual, c.porque;
    END IF;
  END LOOP;

  -- A pergunta perigosa, contra o dado REAL: chave que declara `esperado` e mesmo assim traz a
  -- assinatura. Zero e o invariante; qualquer numero aqui e uma deteccao que o #1843 desligou.
  SELECT count(*) INTO contaminados_com_esperado
  FROM public.farmer_geracao_execucoes e, jsonb_each(e.insumos) AS i(nome, val)
  WHERE (val ? 'esperado')
    AND (val->>'n') ~ '^[0-9]+$'
    AND (val->>'n')::int = 1000;

  IF contaminados_com_esperado > 0 THEN
    RAISE EXCEPTION 'PROD: % ocorrencia(s) com esperado E n=1000 — o discriminador estrutural DESLIGOU a deteccao para uma chave que a merecia. Investigue antes de julgar qualquer janela.',
      contaminados_com_esperado;
  END IF;
  RAISE NOTICE 'PASS  prod: nenhuma ocorrencia gravada declara esperado com n=1000';

  IF distinguidos = 0 THEN
    RAISE EXCEPTION 'TESTE VACUO: nenhum caso distingue o predicado atual do generico pre-#1843 — este conjunto passaria com qualquer predicado.';
  END IF;
  IF falhas > 0 THEN
    RAISE EXCEPTION '% caso(s) FALHARAM', falhas;
  END IF;
  RAISE NOTICE 'OK — 0 falha, % caso(s) distinguem o predicado atual do pre-#1843', distinguidos;
END
$falsifica$;

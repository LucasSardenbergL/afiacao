-- GATILHO da fase 2 do farmer (expirar geração por vazio) — a QUERY decide, ninguém "avisa".
--
-- Rode isto ANTES de abrir qualquer análise da fase 2. Ele responde a única pergunta que
-- importa — "já há o que analisar?" — com denominador explícito, e recusa as duas formas de
-- errar: interpretar zero-sem-denominador como "o vazio não acontece", e aceitar um vazio
-- ENVENENADO como se fosse sinal legítimo.
--
--   ~/.config/afiacao/psql-ro -f db/gatilho-farmer-fase2.sql
--
-- Contexto: docs/historico/fase-sem-sinal.md (caso 4) · spec do sensor em
-- docs/superpowers/specs/2026-08-15-farmer-head-geracao-sensor-design.md
--
-- ⚠️ Duas leituras que este arquivo existe para impedir:
--
-- 1. `execucoes_totais = 0` NÃO é "o vazio não acontece". É denominador zero — o defeito que
--    o sensor foi instalado para curar. Duas análises já foram abertas contra este zero
--    (2026-08-15 e 2026-08-18) e as duas voltaram sem poder concluir nada.
--
-- 2. `completude='completo'` significa "nenhum insumo FALHOU ao ser lido" — e `ok:true` em
--    `insumos` quer dizer "a leitura não lançou exceção", NÃO "a leitura veio inteira". Uma
--    leitura truncada em silêncio (cap de 1.000 do PostgREST sobre RPC sem paginação) chega
--    aqui como `ok:true`, e o vazio que ela produz veste a roupa exata do sinal legítimo.
--    Por isso a coluna `suspeita_cap` abaixo: n≡1000 é a assinatura do truncamento.
--
-- 3. **A contaminação é HISTÓRIA, não estado.** `farmer_geracao_execucoes` é append-only: uma
--    execução truncada fica lá para sempre. A 1ª versão desta query contava `suspeita_cap`
--    sobre a tabela INTEIRA e travava em `CONTAMINADO` de forma PERMANENTE — mandava
--    "descarte o período e recomece o denominador" sem oferecer meio de fazê-lo, e teria
--    escondido o primeiro sinal legítimo atrás de 7 linhas velhas e imutáveis. Um gatilho que
--    nunca pode ficar verde não é conservador: é um sensor que não mede a própria pergunta
--    (fase-sem-sinal.md), agora cometido DENTRO do arquivo que existe para impedir isso.
--
--    O corte abaixo faz o descarte que o texto mandava fazer: a janela julgável começa DEPOIS
--    da última execução contaminada. As descartadas não somem — saem em `descartadas_cap`,
--    porque cap silencioso é o defeito, não a cura. E a contaminação ATIVA (a execução mais
--    recente ainda truncada) continua travando tudo, que é quando travar é a resposta certa.
WITH marcada AS (
  SELECT
    calculado_em, resultado, completude, insumos, farmer_id,
    -- Assinatura de truncamento: QUALQUER insumo com exatamente 1.000 linhas. O cap do
    -- PostgREST devolve 1.000 e sucesso; nenhum insumo real tem esse tamanho por acaso.
    EXISTS (SELECT 1 FROM jsonb_each(insumos) AS i(nome, val)
            WHERE (val->>'n')::int = 1000) AS tem_cap
  FROM public.farmer_geracao_execucoes
),
corte AS (
  SELECT
    -- A janela julgável começa DEPOIS da última execução truncada. Com a tabela limpa isso é
    -- `-infinity` e a janela é tudo — o corte só morde quando houve contaminação de fato.
    COALESCE(max(calculado_em) FILTER (WHERE tem_cap), '-infinity'::timestamptz) AS janela_desde,
    count(*) FILTER (WHERE tem_cap)                                              AS descartadas_cap,
    -- Contaminação ATIVA ≠ contaminação passada: se a execução MAIS RECENTE ainda vem
    -- truncada, o cliente no ar segue truncando e nenhuma janela nova é confiável.
    COALESCE((SELECT tem_cap FROM marcada ORDER BY calculado_em DESC LIMIT 1), false) AS cap_ativo
  FROM marcada
),
obs AS (
  SELECT
    c.descartadas_cap, c.cap_ativo, c.janela_desde,
    count(m.calculado_em)                                             AS execucoes_totais,
    -- O cliente ANTERIOR ao Publish não declarava insumo nenhum: conta como "rodou",
    -- nunca como evidência sobre completude.
    count(*) FILTER (WHERE m.completude <> 'desconhecido')            AS julgaveis,
    count(*) FILTER (WHERE m.resultado = 'vazio'
                       AND m.completude = 'completo'
                       AND COALESCE((m.insumos->'scores'->>'n')::int, 0)    > 0
                       AND COALESCE((m.insumos->'vendaveis'->>'n')::int, 0) > 0
                       -- Terceira geracao de cliente. O insumo de COBERTURA so passou a ser
                       -- declarado depois que o pre-requisito da §7.5 fechou; execucao que nao
                       -- o traz veio de cliente que ainda contava carteira_ativa (cliente com
                       -- PEDIDO) como se fosse historico utilizavel. O `completo` dela nao
                       -- julga a mesma coisa, entao nao pode entrar no mesmo denominador.
                       AND m.insumos ? 'carteira_com_historico_utilizavel') AS vazios_completos,
    -- Contados a parte para nao sumirem em silencio: sao os vazios+completos do cliente
    -- ANTERIOR a cobertura. Nao servem de sinal, mas some-los a zero seria refazer o
    -- ausente=zero num arquivo que existe para impedi-lo.
    count(*) FILTER (WHERE m.resultado = 'vazio'
                       AND m.completude = 'completo'
                       AND NOT (m.insumos ? 'carteira_com_historico_utilizavel')) AS vazios_pre_cobertura,
    count(DISTINCT m.farmer_id)                                       AS farmers,
    min(m.calculado_em)::date                                         AS desde,
    max(m.calculado_em)                                               AS ultima
  FROM corte c
  -- LEFT JOIN de proposito: com a janela VAZIA (contaminacao ativa, ou nenhuma execucao ainda)
  -- a query tem de devolver UMA linha dizendo isso, nao zero linhas — resultado ausente seria
  -- lido como "rodou e nao achou nada", que e o ausente=zero de novo.
  LEFT JOIN marcada m ON m.calculado_em > c.janela_desde
  GROUP BY c.descartadas_cap, c.cap_ativo, c.janela_desde
)
SELECT
  execucoes_totais, julgaveis, vazios_completos, vazios_pre_cobertura,
  descartadas_cap, farmers, desde, ultima,
  CASE
    WHEN cap_ativo THEN
      'CONTAMINADO (ATIVO) — a execucao MAIS RECENTE ainda traz insumo de exatamente 1000 '
      || 'linhas. O cliente no ar segue truncando em silencio: nenhuma janela nova e '
      || 'confiavel. Corrija a paginacao e faca o Publish ANTES de julgar qualquer vazio.'
    WHEN vazios_pre_cobertura > 0 AND vazios_completos = 0 THEN
      'AGUARDE (cliente velho) — ' || vazios_pre_cobertura || ' vazio+completo SEM o insumo '
      || 'carteira_com_historico_utilizavel. Foram gravados por cliente anterior ao fechamento '
      || 'da §7.5, quando um vazio podia vir de historico inutilizavel sem degradar. NAO contam '
      || 'como sinal: falta o Publish do frontend, ou o periodo precede a cobertura.'
    WHEN vazios_completos > 0 THEN
      'DECIDA — ha ' || vazios_completos || ' vazio+completo COM cobertura declarada. Os dois '
      || 'pre-requisitos da §7.5 estao fechados (regras no bundle; e carteira_com_historico_'
      || 'utilizavel, que separa cliente com PEDIDO de cliente cujos itens RESOLVEM para SKU). '
      || 'Este vazio ja e julgavel: siga para o desenho da expiracao.'
    WHEN julgaveis >= 20 THEN
      'ENCERRE — ' || julgaveis || ' execucoes julgaveis e ZERO vazios: o vazio-de-verdade nao '
      || 'acontece nesses farmers. Nao ligue a expiracao; encerre a linha.'
    ELSE
      'AGUARDE — denominador insuficiente (' || julgaveis || '/20 julgaveis'
      || CASE WHEN descartadas_cap > 0
              THEN '; ' || descartadas_cap || ' execucao(oes) DESCARTADAS por truncamento, '
                   || 'denominador recomecado' ELSE '' END
      || '). NAO interprete como "o vazio nao acontece": e ausencia de dado.'
  END AS veredito
FROM obs;

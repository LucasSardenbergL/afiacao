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
--
-- 4. **O agregado esconde o motor que NUNCA rodou.** São DOIS motores (`cross_sell` e `bundle`,
--    pelo CHECK da tabela) e eles não acumulam igual: `FarmerRecommendations` recalcula no
--    `useEffect` ao abrir a tela, e `FarmerBundles` só calcula por BOTÃO. Medido em 20/08:
--    10 execuções de `cross_sell` e ZERO de `bundle`. Somados, viram "10 execuções" — e um dia
--    virariam `ENCERRE`, encerrando a linha do BUNDLE com dado que é todo do cross-sell.
--    Por isso a query devolve UMA LINHA POR MOTOR, e o esqueleto de motores é fixo: motor sem
--    execução tem de aparecer com zero, nunca sumir da saída (ausente ≠ zero, de novo).
--
-- 5. **`AGUARDE` sem prazo é indistinguível de espera infinita.** O veredito exige 20 julgáveis,
--    e nada garante que 20 cheguem: medido em 20/08, 3 farmers TÊM carteira, 1 só executou
--    alguma vez, e as ultimas 24h tiveram ZERO execucoes — as 10 de 19/08 sairam todas num
--    intervalo de 1h04 (sessao de teste, nao rotina). Esperar nao produz denominador quando a
--    superficie nao esta em uso; a fase N+1 aqui e INSTALAR O USO, nao aguardar o sinal.
--    Por isso `taxa_7d` e `farmers_com_carteira` saem na propria linha: um denominador que nao
--    cresce e um fato observavel, e o veredito ESTAGNADO o nomeia em vez de repetir "aguarde".
WITH motores AS (
  -- Esqueleto FIXO: o motor que nunca executou precisa APARECER com zero. Um `GROUP BY motor`
  -- sozinho simplesmente não produz linha para ele, e a ausência seria lida como "não há nada
  -- a relatar". A lista espelha o CHECK da tabela; o UNION garante que um motor novo que
  -- apareça no banco antes de entrar aqui também saia na saída, em vez de sumir.
  SELECT motor FROM (VALUES ('cross_sell'), ('bundle')) AS v(motor)
  UNION
  SELECT DISTINCT motor FROM public.farmer_geracao_execucoes
),
marcada AS (
  SELECT
    motor, calculado_em, resultado, completude, insumos, farmer_id,
    -- Assinatura de truncamento: QUALQUER insumo com exatamente 1.000 linhas. O cap do
    -- PostgREST devolve 1.000 e sucesso; nenhum insumo real tem esse tamanho por acaso.
    EXISTS (SELECT 1 FROM jsonb_each(insumos) AS i(nome, val)
            WHERE (val->>'n')::int = 1000) AS tem_cap
  FROM public.farmer_geracao_execucoes
),
corte AS (
  -- Janela POR MOTOR: o cap que envenenou o cross-sell não pode descartar execução do bundle.
  SELECT
    mo.motor,
    COALESCE(max(ma.calculado_em) FILTER (WHERE ma.tem_cap), '-infinity'::timestamptz) AS janela_desde,
    count(*) FILTER (WHERE ma.tem_cap)                                                 AS descartadas_cap,
    -- Contaminação ATIVA ≠ passada: se a execução MAIS RECENTE deste motor ainda vem truncada,
    -- o cliente no ar segue truncando e nenhuma janela nova é confiável.
    COALESCE((SELECT y.tem_cap FROM marcada y WHERE y.motor = mo.motor
              ORDER BY y.calculado_em DESC LIMIT 1), false)                            AS cap_ativo
  FROM motores mo
  LEFT JOIN marcada ma ON ma.motor = mo.motor
  GROUP BY mo.motor
),
obs AS (
  SELECT
    c.motor, c.descartadas_cap, c.cap_ativo,
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
    -- Taxa OBSERVAVEL: sem ela, "3/20" nao distingue "crescendo devagar" de "parado".
    count(*) FILTER (WHERE m.calculado_em > now() - interval '7 days')  AS exec_7d,
    -- Denominador de USUARIOS (global, nao por motor): farmer que tem carteira mas nunca
    -- executou nao aparece em `farmers`, e some — a mesma cobertura-vs-universo do insumo
    -- carteira_com_historico_utilizavel, agora aplicada a ADOCAO da propria tela.
    (SELECT count(DISTINCT farmer_id) FROM public.farmer_client_scores) AS farmers_com_carteira,
    min(m.calculado_em)::date                                         AS desde,
    max(m.calculado_em)                                               AS ultima
  FROM corte c
  -- LEFT JOIN de proposito: com a janela VAZIA (motor que nunca rodou, ou contaminacao ativa)
  -- a query tem de devolver a linha DELE dizendo isso, e nao omiti-lo — linha ausente seria
  -- lida como "nao ha o que relatar", que e o ausente=zero.
  LEFT JOIN marcada m ON m.motor = c.motor AND m.calculado_em > c.janela_desde
  GROUP BY c.motor, c.descartadas_cap, c.cap_ativo
)
SELECT
  motor, execucoes_totais, julgaveis, vazios_completos, vazios_pre_cobertura,
  descartadas_cap, farmers, farmers_com_carteira, exec_7d, desde, ultima,
  CASE
    WHEN cap_ativo THEN
      'CONTAMINADO (ATIVO) — a execucao MAIS RECENTE deste motor ainda traz insumo de exatamente '
      || '1000 linhas. O cliente no ar segue truncando em silencio: nenhuma janela nova e '
      || 'confiavel. Corrija a paginacao e faca o Publish ANTES de julgar qualquer vazio.'
    WHEN execucoes_totais = 0 THEN
      'SEM DENOMINADOR — este motor NUNCA executou. Nao e "o vazio nao acontece": e superficie '
      || 'sem sensor exercido. Os dois motores nao acumulam igual — FarmerRecommendations '
      || 'recalcula no useEffect ao ABRIR a tela, FarmerBundles so calcula por BOTAO — entao '
      || 'este aqui nao acumula por uso organico. Exercer a tela e o pre-requisito, nao esperar.'
    WHEN vazios_pre_cobertura > 0 AND vazios_completos = 0 THEN
      'AGUARDE (cliente velho) — ' || vazios_pre_cobertura || ' vazio+completo SEM o insumo '
      || 'carteira_com_historico_utilizavel. Foram gravados por cliente anterior ao fechamento '
      || 'da §7.5, quando um vazio podia vir de historico inutilizavel sem degradar. NAO contam '
      || 'como sinal: falta o Publish do frontend, ou o periodo precede a cobertura.'
    WHEN vazios_completos > 0 THEN
      'DECIDA — ha ' || vazios_completos || ' vazio+completo COM cobertura declarada. Os dois '
      || 'pre-requisitos da §7.5 estao fechados (regras no bundle; e carteira_com_historico_'
      || 'utilizavel, que separa cliente com PEDIDO de cliente cujos itens RESOLVEM para SKU). '
      || 'Este vazio ja e julgavel: siga para o desenho da expiracao DESTE motor.'
    WHEN julgaveis >= 20 THEN
      'ENCERRE — ' || julgaveis || ' execucoes julgaveis DESTE motor e ZERO vazios: o '
      || 'vazio-de-verdade nao acontece nele. Nao ligue a expiracao; encerre a linha DELE '
      || '(o veredito e por motor: nao decide nada sobre o outro).'
    WHEN execucoes_totais > 0 AND exec_7d = 0 THEN
      'ESTAGNADO — ' || julgaveis || '/20 julgaveis e ZERO execucoes nos ultimos 7 dias. O '
      || 'denominador NAO esta crescendo: aguardar nao produz sinal quando a superficie nao '
      || 'esta em uso (' || farmers || ' de ' || farmers_com_carteira || ' farmers com carteira '
      || 'ja executaram alguma vez). A fase seguinte aqui e INSTALAR O USO — nao esperar.'
    ELSE
      'AGUARDE — denominador insuficiente (' || julgaveis || '/20 julgaveis'
      || CASE WHEN descartadas_cap > 0
              THEN '; ' || descartadas_cap || ' execucao(oes) DESCARTADAS por truncamento, '
                   || 'denominador recomecado' ELSE '' END
      || '; ' || exec_7d || ' execucao(oes) nos ultimos 7 dias, ' || farmers || '/'
      || farmers_com_carteira || ' farmers com carteira ja executaram'
      || '). NAO interprete como "o vazio nao acontece": e ausencia de dado.'
  END AS veredito
FROM obs
ORDER BY motor;

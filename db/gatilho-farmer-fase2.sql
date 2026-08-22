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
--
-- 6. **`completo` não garante que o universo lido era o CERTO.** Até o #1822 (merge 20/08
--    23:58) os dois motores filtravam `sales_orders` por `status IN ('confirmado','faturado',
--    'entregue')` — e DOIS desses status nunca existiram nesta tabela: a allowlist tinha sido
--    copiada de outra. As leituras não falhavam, não truncavam em 1.000, e saíam `ok:true`;
--    simplesmente enxergavam menos base. Medido: as 10 execucoes de cross_sell leram
--    `pedidos=861`; a 1a execucao POSTERIOR ao fix leu **1227** — mesma farmer, +42%.
--
--    Nenhuma assinatura numerica pega isso (n=1000 e cap do PostgREST, nao allowlist errada),
--    e `completude='completo'` e verdadeiro e inutil aqui: o insumo FOI lido com sucesso, da
--    fonte errada. Por isso a EPOCA abaixo — execucao anterior a ela mediu outro universo e
--    nao entra no mesmo denominador, do mesmo jeito que `vazios_pre_cobertura`. Ao corrigir
--    um bug que muda o UNIVERSO lido, AVANCE a epoca; o que conta e o Publish, nao o merge.
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
    -- Assinatura de truncamento: insumo com exatamente 1.000 linhas. O cap do PostgREST
    -- devolve 1.000 e sucesso.
    --
    -- ⚠️ O `QUALQUER insumo` original era GENÉRICO demais, e a justificativa dele ("nenhum
    -- insumo real tem esse tamanho por acaso") já era falsa quando foi escrita: metade das
    -- chaves não é cardinalidade de página nenhuma — é contagem DERIVADA (`baskets`=21.579 de
    -- 30.939, `itens_identidade_conforme`=41.923, `bundle_conta_unica`, os dois sensores de
    -- conta do cross-sell). Para essas, 1.000 é um valor como outro qualquer, e o falso
    -- positivo não custa "uma execução": ele empurra `janela_desde` e descarta TODA a história
    -- anterior junto — e, se for a execução mais recente, o motor inteiro sai `cap_ativo`.
    --
    -- O filtro é ESTRUTURAL de propósito, não uma lista de nomes. `esperado` só é declarado por
    -- quem mede COBERTURA (o contrato está em `src/lib/farmer/completude-snapshot.ts`): `n` é
    -- então uma FATIA de um universo declarado, nunca o tamanho de uma página. Uma leitura
    -- crua não tem universo a declarar, então continua sendo checada SEM ninguém precisar
    -- lembrar de cadastrá-la — e é essa a direção fail-closed: esquecer de excluir uma chave
    -- derivada custa um falso positivo (a janela encolhe, a fase 2 espera mais); esquecer de
    -- INCLUIR uma leitura crua numa allowlist custaria o cap passar batido, que é a licença
    -- para a fase 2 expirar carteira em cima de dado truncado. Escapar da checagem exige o ato
    -- afirmativo de declarar um universo.
    --
    -- ── TAXONOMIA, chave a chave (conferida no CÓDIGO em 21/08/2026, #1843 já mergeado) ────
    --
    -- Quem classifica não é o NOME do insumo — é o que produz o `n`. Três classes, e só a
    -- primeira pode carregar a assinatura de cap:
    --   (a) cardinalidade BRUTA de uma leitura;
    --   (b) interseção / contagem DERIVADA de uma leitura;
    --   (c) contagem sobre a SAÍDA do motor (nunca tocou o PostgREST).
    --
    -- `regras` é a prova de que o eixo é o MOTOR, não o nome: no cross-sell é (a) — leitura
    -- CRUA de `farmer_association_rules`, `.select()` sem `.range()` (useCrossSellEngine:489),
    -- a única leitura viva que ainda pode ser capada; no bundle é (c) — saída do Apriori que
    -- roda no browser. Uma allowlist por NOME precisaria pôr a MESMA chave nas duas classes.
    --
    --   chave                                    classe  declara `esperado`?  origem do `n`
    --   regras (cross_sell) ....................... (a)   não   .select() CRU ← pode capar
    --   catalogo · scores ......................... (a)   não   fetchAllPages
    --   vendaveis ................................. (b)   não   Set de fetchAllPages (RPC)
    --   pedidos · carteira_ativa .................. (b)   não   Set/filtro sobre sales_orders
    --   regras (bundle) ........................... (c)   não   Apriori in-browser
    --   clientes_com_profile ...................... (b)   SIM   profiles em `.in()` de 100
    --   carteira_com_historico_utilizavel ......... (b)   SIM   fetchAllPages
    --   baskets · itens_identidade_conforme ....... (b)   SIM   fetchAllPages
    --   bundle_conta_unica · oferta_conta_do_c. ... (c)   SIM   saída do motor
    --   candidatos_conta_do_c. · upsell_ordem_d. .. (c)   SIM   saída do motor
    --   comparacao_individual_leitura ............. (c)   SIM   booleano 0|1
    --   comparacao_individual_produto_resolvido ... (c)   SIM   loop sobre a saída
    --
    -- NENHUMA chave que declara `esperado` é (a) — e essa era a pergunta perigosa: se uma
    -- fosse, o filtro estrutural teria DESLIGADO em silêncio a detecção de cap para ela, que é
    -- a falha ABERTA que o money-path proíbe. Duas razões independentes sustentam isso, e
    -- nenhuma delas depende de lembrar de cadastrar chave nova:
    --   • `fetchAllPages` só PARA quando uma página vem com MENOS de 1.000 (postgrest.ts:180),
    --     então um total de exatamente 1.000 é universo verdadeiro, nunca cap;
    --   • as duas leituras que NÃO paginam são imunes por outra via — `profiles` do cross-sell
    --     pede lotes de 100 (`.in()`), e `farmer_melhor_individual_por_cliente` é
    --     `RETURNS jsonb`, 1 tupla (o cap conta LINHAS; conferido em prod por pg_proc).
    --
    -- Falsos positivos que RESTAM, e são a direção barata (janela encolhe, fase 2 espera mais):
    -- `pedidos` é derivada, não declara `esperado` e JÁ ATRAVESSOU a faixa — 861 → 1.227 no
    -- #1822. Uma execução que tivesse caído no 1.000 exato teria descartado a história inteira
    -- deste motor. `carteira_ativa` (269), `regras`/bundle (24) e `vendaveis` (2.465) estão
    -- longe da faixa hoje.
    --
    -- ⚠️ O teste é por OCORRÊNCIA, não por nome, e isso é o certo numa tabela append-only:
    -- `clientes_com_profile` tem 14 ocorrências gravadas e só 5 trazem `esperado` (as outras
    -- são de gerações anteriores do cliente). As antigas seguem checadas.
    --
    -- ⚠️ O predicado olha só `n`. Em `baskets` quem espelha a cardinalidade bruta é o
    -- `esperado` (= `salesOrders.length`): se um dia essa leitura deixar de paginar, o cap
    -- apareceria no `esperado` e passaria batido aqui. Hoje ela pagina.
    --
    -- Prova executável, nos dois sentidos e falsificada por sabotagem (o predicado pré-#1843
    -- entra como controle, e o conjunto REPROVA se nenhum caso distinguir os dois):
    --   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f db/falsifica-discriminador-cap-farmer.sql
    EXISTS (SELECT 1 FROM jsonb_each(insumos) AS i(nome, val)
            WHERE NOT (val ? 'esperado')
              AND (val->>'n')::int = 1000) AS tem_cap
  FROM public.farmer_geracao_execucoes
),
epoca AS (
  -- Merge do #1822 (o Publish veio depois; a 1a execucao com universo correto e 21/08 01:33).
  -- Usar o merge e o piso CONSERVADOR: nunca inclui execucao que rodou com o codigo velho.
  SELECT '2026-08-20T23:58:43Z'::timestamptz AS inicio
),
corte AS (
  -- Janela POR MOTOR: o cap que envenenou o cross-sell não pode descartar execução do bundle.
  SELECT
    mo.motor,
    GREATEST(
      COALESCE(max(ma.calculado_em) FILTER (WHERE ma.tem_cap), '-infinity'::timestamptz),
      (SELECT inicio FROM epoca)
    )                                                                                  AS janela_desde,
    count(*) FILTER (WHERE ma.calculado_em <= (SELECT inicio FROM epoca))               AS pre_epoca,
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
    c.motor, c.descartadas_cap, c.cap_ativo, c.pre_epoca,
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
  GROUP BY c.motor, c.descartadas_cap, c.cap_ativo, c.pre_epoca
)
SELECT
  motor, execucoes_totais, julgaveis, vazios_completos, vazios_pre_cobertura,
  descartadas_cap, pre_epoca, farmers, farmers_com_carteira, exec_7d, desde, ultima,
  CASE
    WHEN cap_ativo THEN
      'CONTAMINADO (ATIVO) — a execucao MAIS RECENTE deste motor ainda traz insumo de exatamente '
      || '1000 linhas. O cliente no ar segue truncando em silencio: nenhuma janela nova e '
      || 'confiavel. Corrija a paginacao e faca o Publish ANTES de julgar qualquer vazio.'
    WHEN execucoes_totais = 0 AND pre_epoca > 0 THEN
      'ZERADO POR EPOCA — ' || pre_epoca || ' execucao(oes) existem, mas TODAS anteriores ao '
      || 'fix da allowlist de status (#1822): elas leram um universo de pedidos MENOR (861 '
      || 'contra 1227 apos o fix) e nao medem a mesma coisa. Nao e "nunca rodou" nem "deu '
      || 'vazio" — e denominador ZERADO por troca de universo. Exercer a tela de novo repovoa.'
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
    -- 7. **Um denominador de UM ator nao licencia conclusao POPULACIONAL.** Esta e a forma que
    --    a fase-sem-sinal assume DENTRO do proprio gatilho. Medido em 21/08: as 14 execucoes
    --    que a tabela tem sao de 1 farmer so — o founder, VERIFICANDO o sensor — e 2 dos 3
    --    farmers com carteira nunca abriram a tela. O arquivo ja EXPUNHA o fato (`farmers` e
    --    `farmers_com_carteira` saem na linha, e o comentario deles ate nomeia a adocao); o
    --    que faltava era o VEREDITO agir sobre ele. Relatar sem poder concluir e o defeito.
    --
    --    Por que ACIMA do `ENCERRE`: `ENCERRE` e afirmacao UNIVERSAL ("o vazio-de-verdade nao
    --    acontece neste motor"), e universal exige amostra que represente a populacao. Com 20
    --    julgaveis feitos clique a clique por uma pessoa, o gatilho encerraria a linha com
    --    n=1 — o "agregado esconde o motor" (item 4) uma camada acima, agora sobre PESSOAS.
    --    Nao e hipotetico: o executor unico ja produziu 14 dos 20.
    --
    --    Por que ABAIXO do `vazios_completos > 0`: aquilo e afirmacao de EXISTENCIA, e uma
    --    ocorrencia basta para prova-la, venha de quem vier. Amostra enviesada derruba o
    --    universal, nao o existencial — rebaixar o existencial aqui seria trocar um erro por
    --    outro.
    --
    --    Por que o `ESTAGNADO` (exec_7d = 0) NAO pega: verificar o sensor E uma execucao. Quem
    --    abre a tela para conferir renova `exec_7d` e derruba o veredito para `AGUARDE` — o
    --    alarme e suprimido pelo ATO DE MEDIR, e some justo quando alguem foi olhar. Provado
    --    por falsificacao em db/test-gatilho-farmer-fase2.sh (caso 4: sem este ramo, 20
    --    julgaveis de 1 ator saem como `ENCERRE`).
    WHEN farmers = 1 AND farmers_com_carteira > 1 THEN
      'MONOUSUARIO — ' || julgaveis || '/20 julgaveis, mas TODAS de UM UNICO farmer (de '
      || farmers_com_carteira || ' com carteira). Denominador de 1 ator nao sustenta conclusao '
      || 'populacional: nem ENCERRE (que e universal) nem AGUARDE (o sinal nao esta "vindo" — '
      || 'nao ha quem o produza). E se o executor unico for quem VERIFICA o sensor, cada '
      || 'verificacao renova exec_7d e impede ESTAGNADO: o alarme se apaga por ser olhado. A '
      || 'fase seguinte e INSTALAR O USO nos demais farmers com carteira — nao esperar.'
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

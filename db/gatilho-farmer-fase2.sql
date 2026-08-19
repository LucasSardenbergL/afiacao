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
WITH obs AS (
  SELECT
    count(*)                                                          AS execucoes_totais,
    -- O cliente ANTERIOR ao Publish não declarava insumo nenhum: conta como "rodou",
    -- nunca como evidência sobre completude.
    count(*) FILTER (WHERE completude <> 'desconhecido')              AS julgaveis,
    count(*) FILTER (WHERE resultado = 'vazio'
                       AND completude = 'completo'
                       AND COALESCE((insumos->'scores'->>'n')::int, 0)    > 0
                       AND COALESCE((insumos->'vendaveis'->>'n')::int, 0) > 0
                       -- Terceira geracao de cliente. O insumo de COBERTURA so passou a ser
                       -- declarado depois que o pre-requisito da §7.5 fechou; execucao que nao
                       -- o traz veio de cliente que ainda contava carteira_ativa (cliente com
                       -- PEDIDO) como se fosse historico utilizavel. O `completo` dela nao
                       -- julga a mesma coisa, entao nao pode entrar no mesmo denominador.
                       AND insumos ? 'carteira_com_historico_utilizavel') AS vazios_completos,
    -- Contados a parte para nao sumirem em silencio: sao os vazios+completos do cliente
    -- ANTERIOR a cobertura. Nao servem de sinal, mas some-los a zero seria refazer o
    -- ausente=zero num arquivo que existe para impedi-lo.
    count(*) FILTER (WHERE resultado = 'vazio'
                       AND completude = 'completo'
                       AND NOT (insumos ? 'carteira_com_historico_utilizavel')) AS vazios_pre_cobertura,
    -- Assinatura de truncamento: QUALQUER insumo com exatamente 1.000 linhas. O cap do
    -- PostgREST devolve 1.000 e sucesso; nenhum insumo real tem esse tamanho por acaso.
    count(*) FILTER (WHERE EXISTS (
                       SELECT 1 FROM jsonb_each(insumos) AS i(nome, val)
                       WHERE (val->>'n')::int = 1000))                 AS suspeita_cap,
    count(DISTINCT farmer_id)                                         AS farmers,
    min(calculado_em)::date                                           AS desde,
    max(calculado_em)                                                 AS ultima
  FROM public.farmer_geracao_execucoes
)
SELECT
  execucoes_totais, julgaveis, vazios_completos, vazios_pre_cobertura, suspeita_cap,
  farmers, desde, ultima,
  CASE
    WHEN suspeita_cap > 0 THEN
      'CONTAMINADO — ' || suspeita_cap || ' execucao(oes) com insumo de exatamente 1000 linhas. '
      || 'Truncamento silencioso: o vazio nao prova ausencia de oportunidade. '
      || 'Corrija a paginacao, DESCARTE o periodo e recomece o denominador.'
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
      'AGUARDE — denominador insuficiente (' || julgaveis || '/20 julgaveis). '
      || 'NAO interprete como "o vazio nao acontece": e ausencia de dado.'
  END AS veredito
FROM obs;

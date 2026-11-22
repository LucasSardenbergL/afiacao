# Placar da Visão do CEO sem número enganoso (2026-11-21)

Origem: revisão da home do master pelo Codex e pelo Fable, feita sobre um print. Os dois chegaram aos
mesmos problemas, e três deles foram confirmados no código. O PR é só front-end e vai ao ar pelo Publish.

## O que estava errado no placar

- **Margem bruta de 100% na Colacor SC (out).** A DRE calcula `lucro_bruto = receita_liquida − cmv`, e o
  CMV fica 0 quando nada foi classificado como CMV. A margem saía 100% e contaminava o consolidado. O
  mecanismo está provado. **Causa (founder + DRE de prod, 2026-11-21):** a Colacor SC só presta serviço.
  Ela tem CMV 0 em todo mês de jul a out (só R$ 700 em ago) e o custo inteiro (~R$ 34 mil/mês) fica em
  despesas operacionais. Não é custo sem classificação.
- **NCG legendada sempre como "absorvido".** NCG ≤ 0 é folga (o passivo operacional financia o giro). Além
  disso, o placar aceitava um snapshot com `ncg_completa = false`, calculado sem estoque, e sem estoque até
  o sinal pode virar.
- **"Caixa disponível".** O valor somava os saldos bancários dos CNPJs e compensava dois CNPJs negativos.
  Caixa não passa de um CNPJ para outro.
- **Falha de leitura parecia ausência de dado.** Quando a leitura das exceções falhava, a tela mostrava
  "Tudo no lugar hoje".
- **Atalho `r`.** Invalidava só `['dashboard']` e não recarregava o placar nem as exceções.

## Régua aplicada

- A margem bruta conta só as empresas de mercadoria (Oben e Colacor). A Colacor SC entra em
  `EMPRESAS_SERVICO` (`ceo-placar.ts`), fica fora da conta (`Margem.servicoFora`) e aparece como
  "serviço" na tabela. Com a SC sozinha no seletor, o tile diz "só serviço". Na 1ª versão (#4073) ela
  derrubava a margem do grupo para "—" todo mês.
- Nas empresas de mercadoria, receita > 0 com CMV ausente ou zero → margem `null` (aparece "—"), com
  "CMV não classificado em X".
- NCG de alguma empresa sem estoque → aparece "parcial · snapshot sem estoque", sem legenda de sinal. A
  legenda folga × capital preso só sai com a NCG completa (`ncg_por_empresa[].completa`).
- O tile de caixa passa a se chamar "Saldo bancário líquido" e lista os CNPJs com saldo negativo
  (`Caixa.empresasNegativas`).
- Quando uma leitura falha, o detalhe diz "leitura falhou". As exceções mostram um alerta com o botão
  "Tentar de novo" (`useExcecoesGestor().isError`). O gate `erro-colapsado-em-vazio` perdeu a entrada de
  `GestorExcecoes.tsx` na baseline.
- O mês corrente vem de `hojeSP()` (`@/lib/time/sp-day`), não de `new Date()`.

## Fase 2 — falta de caixa em 13 semanas por CNPJ (2026-11-21)

**Override do founder:** a fase começou sem o sinal de uso da fase 1 (0 `dashboard.ceo.kpi_click` em
14 dias, com o placar no ar havia ~1 dia).

- **Os dados mudaram a pergunta.** Na projeção realista de 21/11, duas das três empresas já abrem o
  horizonte com saldo negativo e pioram até o fim dele; a terceira fica positiva nas 13 semanas.
  "Primeira semana negativa" seria "agora" nas duas, então a métrica é o **pior saldo de cada CNPJ**.
- **Tile "Falta de caixa · 13 semanas"** = Σ max(0, −pior saldo) por CNPJ, sem abater a sobra de outro.
  O Codex validou a métrica: dimensiona o aporte de cada CNPJ e aqui coincide com o pico simultâneo. A
  tabela ganhou a coluna "Pior saldo · 13 sem". O clique abre `/financeiro/capital-giro?aba=fluxo`.
- **Régua (Codex P1):** horizonte de 13 semanas consecutivas e abertura conhecida, senão "projeção
  incompleta". Mesma coorte do cockpit: um snapshot de dia anterior aparece como "projeção
  desatualizada". Qualquer CNPJ sem projeção → total "—". `parseSnapshotSemanas` deixou de converter
  `null`/string em 0 (em prod todas as semanas dos últimos 60 dias são numéricas, nada real é
  descartado).
- **Em aberto (Codex P2, engine):** a semana corrente pode contar duas vezes uma saída já debitada
  (recorrências expandidas desde segunda sobre o saldo bancário do dia). Isso fica para a engine, não
  para o placar.

## Fase 3 — "Cobrar primeiro" (2026-11-22)

Mesmo override do founder (sem sinal de uso). **Não criei tela nova:** `/cobranca` já tem fila,
responsável, promessa e régua de WhatsApp. O placar resume e leva até ela.

- **Fonte:** a mesma RPC `cobranca_fila`, lida pelo `useCeoPlacar` por empresa do escopo, em chave de
  cache própria (`['financeiro-cockpit','cobranca-ceo',empresa]`). Ela é chamada pelo nome, sem
  importar o módulo de cobrança, por causa do gate de fronteiras.
- **Chave do devedor = empresa credora × código do cliente no Omie, nunca o nome.** Em prod, os títulos
  ATRASADO têm `nome_cliente` e `cnpj_cpf` vazios em 100%. O nome vem da view da fila (100% preenchido).
  O mesmo cliente em duas credoras aparece como dois devedores (cadastros fiscais legítimos).
- **Ordem (Codex P2):** promessa vencida primeiro, depois "a contatar/contatado" por saldo, e quem passa
  de 1 ano de atraso no fim, marcado "antigo" (o valor continua no total). Pagamento informado, acordo,
  disputa e cancelado pela gestão saem do top e entram na contagem "aguardando".
- **Ausente ≠ zero (Codex P1):** se a fila de alguma empresa não foi lida, o card diz que falhou. Uma
  promessa vencida com saldo ilegível continua contada. Caso aberto sem vencido não é "saldo
  desconhecido".
- **Links (Codex P1):** a fila de `/cobranca` é por empresa (o padrão é a Oben), então todo link leva
  `?empresa=`. No grupo, o tile de vencidos continua no cockpit consolidado.
- **Em aberto:** separar a carteira antiga **por título**. A RPC só dá o atraso máximo por cliente, e
  isso desloca também parcelas recentes do mesmo cliente. O tile de vencidos (status `ATRASADO`) e a
  fila (que inclui `A VENCER`/`VENCE HOJE` já vencidos pela data) usam réguas diferentes (Codex P2).

## Fase 4 — "Como a margem se forma" (2026-11-22)

O card mostra, no mesmo mês e regime do tile, para cada empresa de mercadoria: receita líquida, CMV,
lucro bruto, margem, margem do mês anterior e o mapeamento da DRE (categorias sem mapeamento explícito
e "DRE provisória"). Tudo vem do mesmo cache da DRE do cockpit; nenhuma leitura nova.

- **Lucro pela identidade receita − CMV**, no tile e no card. O `lucro_bruto` gravado não é usado: um
  snapshot incoerente inflaria a margem (Codex P1; 0 de 139 DREs de prod são incoerentes hoje).
- **Rótulos honestos (Codex P2/P3).** `qtd_categorias_sem_mapeamento` conta a DRE inteira, não só o
  CMV, então a coluna se chama "Mapeamento da DRE". `resultado_provisorio` acende com qualquer
  lançamento fora da DRE no mês: o rótulo é "DRE provisória". Hoje a Oben tem uma dúzia de categorias
  sem mapeamento e a Colacor aparece provisória em todo mês.
- **Em aberto (engine `omie-financeiro`):** gravar o valor e o percentual do CMV classificado por
  heurística (`viaFallback`), para medir a confiança do CMV de verdade, e o motivo de "provisória".

## Fase 5 — composição da NCG (2026-11-22)

**Backend primeiro (engine v2.5).** `calcularNCG` já separava o ACO (CR aberto, estoque e
adiantamentos) e o PCO (CP fornecedor, folha 30 d e tributos a pagar), mas o snapshot só gravava o
total. Agora grava as 6 parcelas em colunas dedicadas `ncg_*`
(`db/2026-11-22-fin-projecao-snapshots-ncg-composicao.sql`), com 1 writer, o cron.

- **Ausente ≠ zero, em 3 sabores.** `ncg_cr_aberto` NULL quer dizer não medido (snapshot anterior à
  v2.5). Com ele presente, `ncg_estoque` NULL é a NCG parcial e `ncg_adiantamentos` NULL é "não
  segregado": a empresa não tem categoria de adiantamento configurada, e o adiantamento, se houver,
  está dentro do CP fornecedor. Antes o cálculo gravaria 0 como se fosse medido (Codex P2).
- **O CHECK nunca derruba o snapshot.** O helper `ncg-composicao.ts` espelha o CHECK, valida a faixa
  **depois** do arredondamento (`9999999999,999` vira `1e10`, Codex P1) e exige folga de fechamento
  0,04, mais estrita que os 0,05 do banco, porque na fronteira o float do JS e o numeric discordam
  (Codex P2).
- **Provas:** teste Deno pelo handler (vermelho antes, com controle verde), falsificação do helper
  (3 sabotagens, cada uma acusada pelo seu caso) e harness PG17 (controle 17/17, 6 sabotagens).
- **Ordem de deploy:** migration → edge v2.5 → só então o PR da UI. A leitura do cockpit
  (`getProjecaoSnapshotsCockpit`) nomeia colunas, e a UI antes da migration derrubaria o placar
  inteiro com 42703.

## Fases seguintes (sem sinal de uso ainda, não iniciadas)


 vendas por empresa em dias
úteis. O sensor já existe: `dashboard.ceo.kpi_click`.

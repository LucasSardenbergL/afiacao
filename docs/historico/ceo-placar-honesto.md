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
- **Feito na Fase 4b (abaixo):** o valor e o percentual do CMV classificado por heurística, e o
  motivo de "provisória".

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

### Fase 5 — UI "Como a NCG se forma" (2026-11-24, só front)

Card logo depois do da margem: por CNPJ e no consolidado, `+ ativo cíclico` (a receber, estoque,
adiantamentos) `− passivo cíclico` (fornecedores, folha 30 d, tributos) `= NCG`. A leitura é
`composicaoNcgDoEscopo` (`src/lib/financeiro/ceo-placar.ts`), sobre o MESMO snapshot e a mesma
coorte do KPI (`ultimosECoorte`, agora compartilhado com o caixa de 13 semanas).

- **Os 4 sabores na tela.** CR NULL (pré-v2.5 ou composição recusada, as 6 NULL) → linha inteira
  "—". Estoque NULL com o CR presente → "sem fonte" e NCG "parcial". Adiantamentos NULL com o CR
  presente → "no CP" (não segregado). Qualquer outra incoerência (PCO NULL, negativo, não-número,
  Σ ≠ total além de 0,05) → "—". Nenhum snapshot medido → o card diz "composição não medida neste snapshot".
- **Consolidado:** cada parcela só soma medida em todas as empresas; uma empresa não medida anula a
  linha do grupo.
- **Lição da falsificação:** o caso "CR NULL" passava mesmo com a regra do CR sabotada, porque o
  fechamento também quebrava (CR NULL deixava a soma longe do total). Foi preciso um caso em que o
  resto fecha com o total, para a camada do CR ser exercitada sozinha. Controle 13/13 verde e 6
  sabotagens vermelhas na mesma invocação.
- **Codex** (gpt-6.2-astra, high): nenhum P1. Três ajustes no mesmo PR:
  - **Fronteira do fechamento:** o float recusava exatamente R$ 0,05 (1,05 − 1 = 0,050000000000000044); agora há um epsilon.
  - **Consolidado misto:** mostra "parcial" em vez de "no CP" quando só parte das empresas segrega o adiantamento.
  - **Mensagem sem medida:** virou "não medida neste snapshot", sem presumir snapshot pré-v2.5.
- **No ar** ([#4170](https://github.com/LucasSardenbergL/afiacao/pull/4170), merge `497c4bc8`, 2026-11-25):
  - O `__BUILD_SHA__` servido em steu.lovable.app é o próprio merge.
  - **Pré-condição:** o snapshot das 10:00–10:10 UTC gravou CR nas 3 empresas.
  - **QA visual**, escopo "Todas": cabeçalho de dois níveis, 3 empresas + Grupo, Colacor SC "sem fonte" no estoque e NCG "parcial", "no CP" nas 3, link para `/financeiro/capital-giro`, console sem erro.
- **A conferir no backend (não é bug da tela):**
  - `ncg_folha_30d` e `ncg_tributos_a_pagar` vieram **0 medido** nas 3 empresas no 1º snapshot.
  - Não é NULL: a engine afirmou zero. Vale conferir a fonte de folha e de tributos da `fin-cashflow-engine` antes de ler a NCG como completa.

## Fase 4b — confiança do CMV (engine `omie-financeiro` v1.14, 2026-11-22)

Fecha o "em aberto" da Fase 4. A DRE grava, em colunas dedicadas de `fin_dre_snapshots`
(`db/2026-11-22-fin-dre-snapshots-cmv-heuristica.sql`, 1 writer: o upsert de `calcularDRE`):
`cmv_heuristica`, o R$ do CMV classificado pela heurística de descrição (`viaFallback`, o que inclui
mapeamento inválido e lançamento sem código de categoria), e `cmv_heuristica_pct`, a fração do CMV
(0..1). O card troca "Mapeamento da DRE" por **"CMV por heurística: X%"** e lista, sob a tabela, o
motivo de cada "DRE provisória" (`detalhamento.fora_dre.motivo`, que a edge já gravava; texto, não
sinal money-path, então segue no jsonb).

- **Ausente ≠ zero, em 3 sabores.** As duas NULL = não medido (snapshot anterior à v1.14, bundle sem
  a marca do contrato, valor fora de faixa) e a UI mostra "—". `cmv_heuristica` presente com o pct
  NULL = sem fração interpretável (CMV ≤ 0, ou heurística fora de 0..100% do CMV, como um estorno
  mapeado maior que o CMV mapeado). 0% só quando todo o CMV veio de mapeamento explícito.
- **O CHECK nunca derruba o upsert.** O helper `cmv-heuristica.ts` espelha os CHECKs de faixa e de
  coerência (|pct − valor/cmv| ≤ 0,0001) e valida a faixa **depois** do arredondamento. O Codex (P2)
  mostrou que o caso de fronteira original (`0,1 + 0,2`) não distinguia a guarda antes ou depois: o
  caso que distingue é `0,7 + 0,1` (razão 1,0000…02, que só arredondada vira 100%). A coerência usa
  `CASE WHEN cmv > 0`, e não `AND`, porque o Postgres não garante a ordem do `AND`: com CMV 0 sairia
  division_by_zero (22012), e não check_violation.
- **Gatilho contra bundle velho.** O upsert de um bundle anterior (ou de um rollback) não nomeia as
  colunas, e no UPDATE manteria o valor de outra apuração ao lado do `cmv` novo: o pct mentiria, ou o
  CHECK derrubaria a DRE. O BEFORE trigger `trg_fin_dre_snapshots_contrato_cmv_heuristica` anula as
  duas quando falta `detalhamento.contrato.cmv_heuristica`, no mesmo molde do gatilho da fase 2, que
  não foi tocado.
- **Camadas que não existem por serem inertes.** Uma checagem de folga no helper (verdadeira por
  construção) e um `+ 0` contra `-0` (some no JSON) foram retirados: sabotados, o teste continuava
  verde. `cmv <= 0` → `< 0` é mutante equivalente (com CMV 0 a razão dá NaN/∞ e a guarda de
  finitude devolve o mesmo NULL).
- **Provas:** teste Deno pelo handler (4 casos vermelhos antes, controle "cmv total" verde),
  falsificação da regra e do helper (controle verde e 9 sabotagens na mesma invocação), harness PG17
  (controle 22/22, 5 sabotagens, S3 e S5 exigindo a causa: 22012 e `P3 FALHOU`). Codex sem P1.
- **Ordem de deploy:** migration → edge v1.14 → Publish. O front lê `select *`, então pode ir no
  mesmo PR: sem a migration, a coluna chega ausente e a UI mostra "—". A edge antes da migration
  falharia alto no upsert.
- **Deploy (2026-11-22 a 24):** migration aplicada em 22/11 (tentativa #1328; postcondição lida
  por psql-ro: 2 colunas sem DEFAULT, 2 CHECKs, gatilho ligado, snapshots antigos todos NULL). A
  edge levou 4 sondas: a #1330 expirou no `pg_net` antes do passo 2, e a #1331 e a #1332 responderam
  BUNDLE VELHO v1.13. **Causa:** o pacote do Passo 2 nunca chegou ao chat do Lovable, porque a
  última mensagem lá era o deploy da v1.13. O workspace já tinha o código v1.14 e só faltava o
  pedido. O pacote foi enviado pelo conector em 24/11 (hashes 18/18) e a sonda #1337 deu
  **DEPLOY CONFIRMADO** (`v1.14-dre-cmv-heuristica`, fonte `ec5224b1…`). Lição: antes de
  repetir uma sonda que deu BUNDLE VELHO, confira no `list_messages` do Lovable se o pedido de
  deploy chegou. Falta o Publish do front.

## Em aberto

- **Contagem dupla na semana corrente (`fin-cashflow-engine`), entrega 2 da série: não publicada,
  por decisão.** O Codex deu P1: a recorrência não tem status de pagamento, e tirá-la pela data
  esconderia a folha não paga (erro otimista, que silencia `cobertura_baixa` e `caixa_negativo`). Na
  PROD (psql-ro, 22/11/2026), `fin_eventos_recorrentes` e `fin_eventos_eventuais` têm 0 linhas nas 3
  empresas: a contagem dupla é latente. **Reabrir quando o 1º recorrente for cadastrado.** A
  reconciliação exige evidência de liquidação (vínculo recorrência → movimentação ou CP), que o modelo
  ainda não tem.

## Fases seguintes (sem sinal de uso ainda, não iniciadas)

Vendas por empresa em dias úteis. O sensor já existe: `dashboard.ceo.kpi_click`.

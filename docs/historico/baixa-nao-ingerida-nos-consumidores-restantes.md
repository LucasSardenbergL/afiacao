# A contenção que parou no primeiro consumidor — e o gêmeo que passou sem ser sabotado

**2026-09-09** · `src/pages/FinanceiroDashboard.tsx` · `src/components/financeiro/dashboard/Contas{Receber,Pagar}Tab.tsx` · `src/components/financeiro/CockpitDrillDown.tsx` · `src/services/financeiroService.ts` · money-path · continuação de [`analytics-total-recebido-r0-sobre-27-milhoes.md`](analytics-total-recebido-r0-sobre-27-milhoes.md) (#2416) · issue #396

## O que ficou de fora do #2416

O #2416 conteve `/financeiro/analytics` e criou o helper `procedencia-baixa.ts`. A **fonte** do
defeito, porém, não é a tela: é `fin_contas_{receber,pagar}`, cujas colunas de baixa o LIST do
Omie nunca preenche (0 de 44.524 CR e 0 de 16.125 CP, medido em prod 2026-09-09). Toda tela que
lê essas tabelas herda a fabricação — e duas continuavam servindo-a:

| superfície | o que afirmava |
|---|---|
| `/financeiro` → cards das abas CR/CP | "Recebido R$ 0,00" · "Saldo" = valor de face |
| `/financeiro` → coluna de cada LINHA | idem, por título |
| `/financeiro` → CSV das abas | o `0.00` dentro de planilha, longe de qualquer aviso |
| `CockpitDrillDown` → colunas e total | `saldo = documento − baixa`, com o subtraendo sempre 0 |

**A lição de escopo:** conter a tela onde o defeito foi VISTO não contém o defeito. O inventário
que importa é o dos consumidores da FONTE (`git grep` pela coluna), não o das telas reclamadas.

## A degradação por VALOR seria pior que o bug

O gatilho é a procedência declarada, nunca `valor === 0`. Degradar por valor acerta o acervo de
hoje **por coincidência** e inverte a mentira no dia em que a ingestão existir: um período em que
nada foi recebido é um FATO, e escondê-lo atrás de "—" mente no outro sentido. Por isso metade
das sabotagens do laço é essa inversão — e cada uma delas tem de acender o bloco de **CONTROLE**
(fonte confiável + soma 0 ⇒ `R$ 0,00`), não o de degradação.

## O resíduo novo: sabotar UM ramo não prova o GÊMEO

O laço nasceu com 12 sabotagens e o veredicto "toda camada acendeu o teste esperado". Era falso
por omissão: `exportContasPagarCSV` é uma **função independente** de `exportContasReceberCSV`, e
só a de recebíveis havia sido sabotada. A asserção do ramo CP existia e passava — mas *passar* não
é *prender*. Trocar o corpo dele por `v => v` deixaria a suíte verde e ninguém saberia.

> **Regra:** em código com ramos gêmeos (CR/CP, pagar/receber, entrada/saída), a contagem de
> sabotagens tem de igualar a contagem de RAMOS, não a de conceitos. Um conceito falsificado num
> ramo é cobertura afirmada no outro — a mesma família de `ausente ≠ zero`, aplicada à prova.

Irmã de [`falsificacao-sem-linha-de-base.md`](falsificacao-sem-linha-de-base.md): lá o controle
faltava no TEMPO (sabotar sem base verde); aqui faltava no ESPAÇO (sabotar sem cobrir o gêmeo).

## Verificação

`bun run falsificar:baixa` — 14 sabotagens, controle verde na mesma invocação, abortando antes do
primeiro `sed` se a base não estiver limpa. `bun run test` (8.680 ok) · `bun run typecheck` ·
`bun run lint` · `bun run lint:shell`.

# Dupla contagem no eixo do TEMPO — quando o acumulado parte de um saldo que já contém o passado

> **A classe (2026-09-09):** uma curva acumulada que **parte de uma posição de estoque** (saldo em
> conta, estoque físico, dívida em aberto) e depois **soma o fluxo de todas as janelas**, inclusive as
> anteriores àquela posição. A posição já É o resultado do fluxo passado. Somá-lo de novo conta o mesmo
> dinheiro duas vezes — não porque a fonte duplica linhas, mas porque **duas coisas na mesma conta
> descrevem o mesmo período**.
>
> A regra: **antes de acumular fluxo sobre um saldo, pergunte de QUANDO é o saldo.** Só o fluxo
> posterior a ele pode ser somado.

## O caso

`FluxoCaixaTab` do dashboard financeiro. A coluna "acumulado" nascia assim:

```ts
let acumulado = saldoCC || 0;          // saldo bancário de HOJE
for (const day of data) { … }          // janela: hoje−6 meses … hoje+3 meses
acumulado += weekEntradas - weekSaidas; // TODAS as semanas, passadas inclusive
```

`saldoCC` é o extrato de hoje: os 6 meses passados já estão dentro dele. O laço somava esses 6 meses
por cima.

Medido em prod no dia do conserto:

| visão | saldo real | passado somado de novo | de onde a curva partia |
|---|---:|---:|---:|
| oben | 672.347 | +599.329 | 1.271.676 (+89%) |
| colacor | −333.393 | −51.096 | −384.490 |
| colacor_sc | −204.781 | −100.993 | −305.774 |
| **todas** | **134.173** | **+447.239** | **581.412 (4,3×)** |

## Por que sobreviveu tanto tempo: o erro estava fora da tela

A janela produzia **27 semanas passadas e 14 futuras**, e a tabela renderizava `weeks.slice(-12)` — só
as futuras. O usuário via **exclusivamente** semanas cujo acumulado estava contaminado por semanas que
**não apareciam**. Não havia como desconfiar olhando: nenhuma linha visível mostrava a origem do erro.

⇒ **Tell:** quando um valor exibido depende de linhas que o recorte da tela descarta, o recorte deixa
de ser cosmético e vira parte da correção. Aqui o recorte passou a ser explícito ("da semana corrente
em diante") em vez de emergir por acidente da janela.

## O irmão que a correção quase cria: a semana CORRENTE

Depois de "acumular só o futuro", sobra a semana que contém hoje — ela tem dias já realizados (dentro
do `saldoCC`) e dias a vencer. Somar o `saldo` da semana inteira reintroduz a dupla contagem em
escala menor. ⇒ **o corte é por DIA, antes do agrupamento**, e a semana carrega um **delta próprio**
para a projeção, diferente do movimento que ela exibe. O dia de HOJE conta como futuro: usa o
previsto, não o realizado — a posição bancária consultada já reflete o realizado dele.

## O que NÃO fazer: reconstruir o passado para trás

A alternativa tentadora era `saldo(semana W) = saldoCC − Σ(realizado posterior a W)`, dando uma curva
contínua. Recusada: o realizado vem da allowlist bancária de `fin_movimentacoes`
(`CONTA_CORRENTE_REC`/`PAG`), que **não é conciliação** — nada garante que ela explique 100% da
variação do extrato —, e **não existe série histórica de saldo** no banco para conferir o resultado.
Seria fabricar histórico com cara de número firme. Precisão > recall: a semana passada mostra `—` no
saldo projetado e mantém entradas/saídas/líquido, que são medidos.

## Parente numérico: o `|| 0` que apagava a âncora

Na mesma linha, `saldoCC || 0`. E a correção seria **inerte** se parasse no componente: `saldo_total_cc`
nascia de `contas.reduce((s,c) => s + (c.saldo_atual ?? 0), 0)`, que devolve `0` para "nenhuma conta
ativa" e para "as contas somam zero" — a ausência nunca chegava como `null`. O zero descia para
`financeiroAlerts`, onde `saldo/total_a_pagar` virava **alerta CRÍTICO falso de cobertura de caixa**.

A `fin-cashflow-engine` **já tinha blindado exatamente isto** no caminho dela (`exigirLinhas`, com o
comentário "zero fabricado aqui dispara alerta de caixa negativo falso"), e o caminho do dashboard
seguiu vulnerável por ser outro código lendo a mesma tabela. ⇒ **blindagem de money-path não viaja
sozinha entre caminhos que leem a mesma fonte**: ao consertar um, procure os irmãos por FONTE
(`git grep` da tabela), não por sintoma.

Contrato que ficou: nenhuma conta ativa → `null`; conta ativa com saldo desconhecido → `null` (a soma
sairia incompleta com cara de completa); soma zero ou negativa de saldos **conhecidos** → número
(prod tem duas empresas com saldo negativo — conta garantida é âncora legítima).

## De quebra: a fronteira passado/futuro estava em UTC

`new Date().toISOString().slice(0,10)` — das 21h à meia-noite em São Paulo o "hoje" já era o dia
seguinte, e é justamente esse `hoje` que separa "já está no saldo" de "ainda vai entrar". Passou a
usar `spBusinessDate` (`src/lib/time/sp-day.ts`), que existia no repo para essa exata armadilha.

## Como o teste pega

A fixture **precisa ter semanas passadas com movimento**. Uma fixture só de futuro passa **verde com o
defeito intacto** — é o passado que o código somava indevidamente, e sem passado não há o que somar a
mais. Dois níveis, porque um não substitui o outro: o teste da função pura pega a aritmética; o de
render prova que ela **chega à tela** (trocar o cálculo sem religar o componente deixaria a correção
inerte, e só o de render acusa isso).

PR: #2459 · decisão de semântica com 2ª opinião Codex (gpt-6-astra max) · código em
`src/components/financeiro/dashboard/fluxo-caixa-semanas.ts`.

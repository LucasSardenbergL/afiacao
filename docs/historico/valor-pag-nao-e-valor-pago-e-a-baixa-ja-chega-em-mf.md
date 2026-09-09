# `valor_pag` não é "valor pago" — e a baixa que procurávamos já chega na nossa edge por outra rota, e é descartada

**2026-09-08** · `supabase/functions/omie-financeiro/index.ts` · money-path · continuação de [#2407](https://github.com/LucasSardenbergL/afiacao/pull/2407) (`desconto-juros-multa-do-titulo-nao-existem-no-omie.md` — sem link relativo: aquele PR ainda não mergeou)

## O que se procurava

O #2407 parou de fabricar `0` em `valor_desconto`/`valor_juros`/`valor_multa` e deixou um achado adjacente em aberto: a doc de contas a pagar documenta, no nível raiz, um campo que não ingerimos — `valor_pag`, *"Valor a pagar. Disponível apenas para os métodos de consulta e listagem."* A pergunta era se ele deveria virar coluna própria (**nunca** sobrescrever `valor_pago`: `valor_pag` é *a pagar*, saldo em aberto, e mapeá-lo para "pago" fabricaria um número pior que o zero atual, porque pareceria plausível).

Motivo do interesse: `saldo` é coluna **GERADA** (`valor_documento - COALESCE(valor_pago,0)`), `valor_pago` é 0 em 16.125/16.125 títulos e `valor_recebido` em 44.482/44.482 ⇒ hoje `saldo == valor_documento` **sempre**.

## O que se achou

A resposta à pergunta é **não ingerir** — mas a razão que fecha o caso não é nenhuma das previstas.

### 1. A premissa "a baixa só existe nos métodos de escrita" é falsa

| Rota | Traz a baixa? | Lados |
|---|---|---|
| `financas/contapagar/ListarContasPagar` | não — só `valor_pag` (saldo). A sub-tag `pagamento` é *"utilizada apenas nos métodos de Inclusão e Alteração"* | CP |
| `financas/contareceber/ListarContasReceber` | não — e **não há equivalente a `valor_pag`** no nível raiz (`valor_baixado` pertence a `LancarRecebimento`, escrita) | CR |
| **`financas/mf/ListarMovimentos`** | **sim** — tipo complexo `resumo`: `cLiquidado` (S/N), `nValPago` ("Valor total pago para o título"), **`nValAberto`** ("Valor total em aberto para o título"), `nDesconto`, `nJuros`, `nMulta`, `nValLiquido` | **CP e CR** (`cTpLancamento`: CP/CR/CPCR) |

`mf/ListarMovimentos` é rota de **consulta**, não de baixa. Os três campos que o #2407 concluiu não existirem existem — em `mf`. A conclusão do #2407 estava certa **para o endpoint que ele media**, e não vale para a API inteira.

### 2. E o repo já chama essa rota — e joga os campos fora

`omie-financeiro/index.ts:1104` chama `financas/mf/ListarMovimentos`. A linha 1161 grava
`valor: Math.abs(Number(resumo.nValPago ?? resumo.nValLiquido ?? detalhes.nValorTitulo ?? 0))` em `fin_movimentacoes` — **56.658 linhas, 26.520 títulos, 2020-04-17 a hoje**.

Mas:

- a interface `OmieMovimentoResumo` (`:323-330`) declara `nValPago`/`nValLiquido`/`nDesconto`/`nJuros`/`nMulta` e **não** declara `nValAberto` nem `cLiquidado`;
- `nDesconto`/`nJuros`/`nMulta` são lidos **só como entrada do hash de ID sintético** (`:1026`) — nunca persistidos;
- `metadata` é `null` por decisão explícita ("peso morto").

Ou seja: o dado passa pela nossa edge todo dia e é descartado.

### 3. Por que `valor_pag` seria a escolha pior, mesmo assim

1. **Assimétrico.** Só CP. Ingerir daria CP com saldo real e CR com saldo fabricado — pior que a simetria errada de hoje, porque a inconsistência fica invisível.
2. **Redundante e inferior.** `nValAberto` é o mesmo conceito, existe para os dois lados, e vem **agregado pelo Omie por título** — imune ao defeito medido em (5).
3. **Não resolve problema medível.** Ver (4).

### 4. Não há baixa parcial detectável — e a medição que "prova" isso é frágil

Cruzando títulos em aberto com `fin_movimentacoes` pelo critério da própria `v_titulo_baixas` (`tipo='S'` para CP, `'E'` para CR, `valor>0`):

| Lado | Abertos | Com baixa | Inflação |
|---|---|---|---|
| CP | 1.044 | **0** | R$ 0,00 |
| CR | 1.077 | 11 | R$ 10.297,24 (1,47%) |

Os 11 do CR, inspecionados **um a um**, não são parciais: 9 têm `baixado == doc` exato (7 com movimento do próprio dia) — baixa **integral** com status defasado de sync; 2 têm `baixado > doc`. Nenhum caso de baixa parcial.

⚠️ **Essa medição não pode ser lida como "não existe baixa parcial".** Duas razões, a segunda levantada pela revisão Codex:

1. A soma por título está **inflada** (ver 5), e inflação **esconde** parcial: um `bx < doc` real vira `bx ≥ doc`.
2. **O detector só tem poder onde há cobertura** — e a cobertura do casamento título↔movimento é muito desigual:

| | colacor | colacor_sc | oben |
|---|---|---|---|
| CP-PAGO com movimento | 1.363/11.507 (**11,8%**) | 806/806 (100%) | 2.740/2.742 (99,9%) |
| CR-RECEBIDO com movimento | 3.072/28.760 (**10,7%**) | 989/989 (100%) | 12.577/12.581 (100%) |

O teto da colacor **já é conhecido e foi investigado**: o runbook registra "backfill de movimentos CONCLUÍDO + teto de cobertura do colacor confirmado ESTRUTURAL (2026-05-30)", com mitigação entregue (DSO contábil agregado colacor-only, #500). Não é regressão nova — mas define onde esta medição vale:

- **oben + colacor_sc** (718 CP e 797 CR abertos, cobertura ~100%): "sem baixa parcial" é afirmação **sustentada**.
- **colacor** (326 CP e 280 CR abertos, cobertura ~11%): é **silêncio, não zero**. Ausente ≠ zero, aplicado à própria medição.

O sensor que faltaria — e que não depende da nossa cobertura de movimentos, porque vem agregado pelo Omie — é `nValAberto`.

### 5. O defeito que apareceu no caminho: `fin_movimentacoes` não é somável por título

O `ListarMovimentos` devolve o **mesmo pagamento sob duas óticas** — o lançamento do título e o da conta corrente — e `buildSyntheticMovementId` gera IDs diferentes para as duas, então **ambas persistem**:

```
cod 11879397398 · doc R$ 270.000,00 · soma R$ 540.000,00
  2025-02-03  R$ 270.000,00  CONTA_CORRENTE_PAG · PAGO
  2025-02-03  R$ 270.000,00  CONTA_A_PAGAR · PAGO
```

Volume por ótica (`valor>0`, com título): `CONTA_CORRENTE_REC` 16.171 títulos · `CONTA_A_RECEBER` 14.390 · `CONTA_CORRENTE_PAG` 4.813 · `CONTA_A_PAGAR` 3.947.

E **a dobra não é simétrica** — dos 17.762 títulos que têm as duas óticas:

| | igual | difere |
|---|---|---|
| data do movimento | 10.758 | **7.004 (39,4%)** |
| valor | 13.980 | **3.782 (21,3%)** |

Consequência: `v_titulo_baixas.valor_baixado` (= `sum(m.valor)`) está **dobrado**, e `data_baixa_final` (= `max(data_movimento)`) pode ser a data do crédito em conta, não a da baixa do título. `v_capital_giro_prazos` (PMR/PMP ≈ DSO/DPO) pondera por esse valor.

Impacto medido no PMR, comparando a base atual com a que usa só a ótica do título:

| Empresa | PMR atual | PMR só-título | Δ |
|---|---|---|---|
| colacor | 27,5 | 27,0 | −0,5 d |
| colacor_sc | 4,2 | 4,6 | +0,4 d |
| oben | 29,9 | 31,3 | **+1,4 d** |

Modesto, mas é viés sistemático, não ruído: a média ponderada só sobreviveria à dobra se as duas óticas concordassem sempre — e elas discordam em 39%.

### 6. Dano de usuário quantificado nesta auditoria

`fin_analise_c{p,r}_dimensoes` expõem `total_pago = sum(valor_pago)` — **sempre 0**. `src/pages/FinanceiroAnalytics.tsx:218` renderiza isso como coluna "Total Pago"/"Total Recebido" e o `:74` exporta em CSV. A tela **afirma R$ 0,00 recebido sobre R$ 27,8M de títulos RECEBIDOS**. Não é ausência de dado na tela: é um número fabricado com aparência de fato — a mesma família do `|| 0` do #2407, um andar acima.

O guard por status (#396, `titulo-status.ts`) **não** cobre este caso: ele protege quem soma `saldo` filtrando status (views `fin_aging_*`, `v_grupo_contas_receber`), e esta tela não soma `saldo` — ela exibe `valor_pago` cru.

"Quantificado", não "único": esta auditoria não mediu descontos/encargos em títulos já quitados, e o DRE-caixa segue usando o valor de face como fallback (`omie-financeiro:1781`). Não há base para declarar esse impacto zero — há base para dizer que não foi medido.

## Revisão Codex (gpt-6-astra, max — 183s)

Submeti a conclusão para ser atacada. Ela mudou em três pontos, todos incorporados acima:

| Objeção | Efeito |
|---|---|
| "Você mediu ausência de parcial **detectável pelo espelho atual**; falta demonstrar que o espelho consegue detectar parcial" — cobertura de ~10% da colacor registrada no runbook | Reescreveu (4): a afirmação passou a valer só onde há cobertura (oben/colacor_sc); colacor virou silêncio explícito |
| "Substituiria *único dano real* por *único dano quantificado nesta auditoria*" — (H) não mede desconto/encargo em quitados, e o DRE-caixa ainda cai no valor de face | Reescreveu (6) e o título da seção |
| "Adiar `valor_pag` é defensável; usar (H) para encerrar a investigação e ficar só na documentação, não" | A decisão abaixo separa **não ingerir agora** de **não investigar** |

Ele também **discordou de trocar a fonte da tela por `fin_movimentacoes`** (dúvidas de cobertura, duplicação e unidade de agregação — e a análise agrupa por *vencimento*, não por pagamento) e sugeriu, para a sondagem que falta, consultar `mf` com `cTpLancamento=CPCR` procurando `cStatus=PAGTOPARCIAL` diretamente, sem depender do nosso filtro local.

Onde eu tinha resposta que ele não tinha: o vocabulário de `status_titulo` em prod é fechado e **não contém nenhum literal de parcial** — CP tem `PAGO`/`A VENCER`/`ATRASADO`/`CANCELADO`/`VENCE HOJE`, CR tem `RECEBIDO`/`CANCELADO`/`ATRASADO`/`A VENCER`/`VENCE HOJE`. Como a normalização do ingest só mapeia `LIQUIDADO`/`RECEBIDO`→`PAGO`, um `PAGTOPARCIAL` vindo do Omie apareceria cru no banco. Não aparece.

## Decisão

**Não ingerir `valor_pag`.** A pergunta certa não é "que campo falta no listar de títulos" — é "por que descartamos o `resumo` do `mf` que já recebemos". Nada aqui abre frente de ingestão sem decisão do founder: o destino natural de `nValPago`/`nValAberto` é coluna do título, mas quem os recebe é o sync de **movimentos**, e escrever de lá em `fin_contas_*` cria um segundo writer na mesma linha — exatamente o que o money-path proíbe. É decisão de arquitetura, não de conserto.

**O que fica aberto** (≠ fechado): a sondagem direta no `mf` com `cTpLancamento=CPCR` procurando `PAGTOPARCIAL`, que é a única que fecha a pergunta sem depender da nossa cobertura de movimentos. Precisa de credencial Omie (só nos secrets do Supabase) — não é executável desta sessão.

## Correção de doc

`docs/agent/financeiro.md` chamava a view de `fin_titulo_baixas`; o nome real em prod é **`v_titulo_baixas`** (não existe tabela com aquele nome — `relation does not exist`).

## Lições

- **Campo ausente num endpoint não é campo ausente na API.** Antes de concluir "o Omie não manda X", varra a *lista de serviços* (`developer.omie.com.br/service-list/`), não só a doc do endpoint em uso. `mf` e `pesquisartitulos` respondiam a pergunta o tempo todo.
- **"Já ingerimos essa rota" não é o mesmo que "já usamos esse dado."** O campo estava na interface TS, chegava no runtime, e servia só de entrada de hash.
- **Soma por chave de negócio precisa provar que a chave é única naquele grão.** `sum(valor) GROUP BY título` pareceu certo por 3 meses; 80% dos títulos CP-PAGO "baixaram mais que o documento" e ninguém viu, porque o único consumidor era uma *média ponderada*, onde a dobra quase se cancela.
- **Inflação esconde o que você foi procurar.** Medir "existe baixa parcial?" sobre uma soma dobrada só consegue produzir "não" — o zero era do instrumento, não do mundo.

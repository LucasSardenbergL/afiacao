# Modelo financeiro — custo de capital, antecipação e teto

Base econômica validada com o codex (consulta de 2026-05-23) + decisões do dono. **Estes
parâmetros são premissas, não verdades** — sempre apareça no memo qual número você usou e
deixe o dono sobrescrever.

## Premissas editáveis (o dono pode mudar a qualquer compra)

| Parâmetro | Default | Quando usar |
|-----------|---------|-------------|
| `r_mês` custo de capital | **2,2%/mês** (antecipação de recebíveis) | caso base |
| `r_mês` piso | **1,0%/mês** (CDI/oportunidade) | caixa folgado: compra mantém o piso das 13 sem acima do runway |
| `r_mês` estresse | **4,5%/mês** (conta garantida) | caixa apertado: compra força entrar/esticar crédito bancário |
| Piso de runway | **R$ 0 em qualquer semana** (idealmente folga > 0) | confirmar o número real com o dono |
| Piso de relevância de aumento | sem piso fixo; decide pela conta | o codex mostrou que a matemática pura basta |

> **Por que custo marginal e não taxa fixa.** O custo econômico do dinheiro é o **próximo real
> consumido ou levantado**. Se a compra obriga antecipar recebíveis, o custo é a antecipação.
> Se empurra pro cheque especial, é o cheque especial. CDI só vale quando sobra caixa de
> verdade **depois** de preservar o runway. Por isso a faixa é escolhida lendo a projeção de
> 13 semanas, não cravada.

## Fórmula central — custo de carregar estoque

```
custo_capital% = (1 + r_mês)^(dias_carregando / 30) − 1
custo_capital_R$ = valor_da_compra_extra × custo_capital%
```

`dias_carregando` ≈ tempo médio que o estoque extra fica parado. Para `N` dias extras sobre uma
cobertura normal `C`, use a aproximação `H = C + N/2` (vende ao longo do tempo, não tudo no fim).

---

## Caso B — Vale antecipar antes do aumento?

### Primeiro separe os dois subcasos (é o que define o tamanho do "estoque extra")

- **Timing puro** — o lote de reposição normal (EOQ) **já cairia antes da vigência** (o estoque
  bate o ponto de pedido dentro da janela do aumento). Aqui antecipar é quase **de graça**: você
  só adianta em poucos dias um pedido que faria de qualquer jeito. O estoque extra é só esses
  dias de antecipação → custo de carregar ~zero → recomendação quase sempre **ANTECIPAR** (o
  único cuidado é o gate de caixa/timing). Não confunda "antecipar o lote normal" com "estocar
  meses".
- **Estoque extra real** — você compraria **além** do próximo lote pra travar o preço por vários
  ciclos. Aí entra a conta cheia abaixo, e o break-even limita quanto vale.

### A conta (subcaso "estoque extra real")

Regra de decisão:

```
Comprar extra SÓ se:  aumento_líquido_evitado%  >  custo_capital%(H) + risco%
```

**Sempre em custo líquido** (pós-desconto à vista), nunca preço de tabela:

```
custo_atual_líquido  = preço_atual  × (1 − desconto_à_vista_atual)
custo_futuro_líquido = preço_futuro × (1 − desconto_à_vista_futuro)
ganho% = custo_futuro_líquido / custo_atual_líquido − 1
```

Break-even (quanto de aumento paga o carregamento por H dias):

```
ganho%  ≥  (1 + r_mês)^(H / 30) − 1
```

Máximo de dias extras que ainda fecham a conta (só pelo custo de capital):

```
H_max = 30 × ln(1 + ganho%) / ln(1 + r_mês)
N_max = 2 × (H_max − C)
```

**Quando comprar:** a melhor data é **a mais tarde possível antes da vigência**, descontado o
lead time. Não compre hoje se dá pra comprar perto da virada (a menos que lead time/risco de
alocação obriguem antes).

### Exemplo numérico
Aumento X = 8%; r_mês = 2,2%; cobertura normal C = 30 dias.

```
H_max = 30 × ln(1,08) / ln(1,022) ≈ 106 dias
N_max = 2 × (106 − 30) = 152 dias extras
```

Só pela conta de capital, antecipar até ~152 dias-de-demanda fecha. **Na prática corte bem
abaixo** por caixa, incerteza de demanda, validade/FEFO, obsolescência e confiabilidade do
fornecedor — e nunca passe do gate de caixa.

---

## Caso C — Promoção / comprar mais por volume

Valor esperado da compra extra:

```
VE = qtd × custo_unit × ganho%                 (desconto capturado)
   − qtd × custo_unit × custo_capital%(H)       (custo de carregar)
   − perda_obsolescência_esperada               (risco de não vender / vencer)
   − custo_armazenagem_handling                 (se relevante)
   + margem_de_ruptura_evitada                  (só se o item realmente protegeria venda)

Aprovar SÓ se:  VE > 0  E  gate de caixa OK  E  sell-through provável  E  dias_extra ≤ teto
```

### Exemplo numérico
Desconto 6%; compra extra R$ 80.000; carrego ~75 dias.

```
custo_capital%(75d) a 2,2%/mês = (1,022)^(75/30) − 1 ≈ 5,6%
ganho bruto = 80.000 × 6,0% = R$ 4.800
custo capital = 80.000 × 5,6% = R$ 4.480
antes de risco: +R$ 320  → margem fininha; com QUALQUER risco de demanda/obsolescência, REJEITAR
```

Mesma oferta com caixa folgado (CDI 1,0%/mês):
```
custo_capital%(75d) a 1,0% = (1,01)^(75/30) − 1 ≈ 2,5%  → R$ 2.000
líquido antes de risco: +R$ 2.800  → aprovar se o runway das 13 sem continua seguro
```

Repare: **a mesma promoção é boa ou ruim dependendo da faixa de custo de capital**, que depende
do caixa. É exatamente o vão que a skill fecha.

---

## O gate de caixa (veto #1) — checklist

O modelo do dono ("economia vs custo de capital") está **direcionalmente certo, mas incompleto**.
Para um distribuidor que paga à vista, a 1ª restrição não é ROI, é **caixa de sobrevivência**.
Antes de recomendar "comprar", confirme TODOS:

1. `MIN(saldo_projetado nas 13 semanas, já subtraindo esta compra) ≥ piso de runway`.
2. Ganho esperado > custo de capital + risco de carregamento + risco de obsolescência.
3. Sell-through provável dentro da validade/prazo (cuidado com classe Y/Z).
4. `dias_extra ≤` teto (o mais restritivo entre cobertura, FEFO e classe ABC).
5. **Portfólio**: somadas as oportunidades simultâneas, o caixa ainda respeita o piso.

Se 1 falha → **não é "comprar agora"**. Vira *parcelar* (empurra a saída pra semanas de folga),
*reduzir lote*, *segurar* ou *negociar prazo*. Uma compra atraente que cria uma semana de caixa
fraca é rejeitada ou redimensionada — nunca aprovada. Se a ÚNICA semana apertada é a do
pagamento e a janela permite, vale um **veto de timing** (pagar numa semana de folga), não
cancelar a compra.

## Sinais de confiabilidade dos dados (entram no memo)

| Sinal | Fonte | Puxa confiança pra baixo quando |
|-------|-------|---------------------------------|
| Lead time | `lt_n_observacoes` | poucas observações (ex: < 5) → LT pouco confiável |
| Demanda | `demanda_dias_com_movimento`, `demanda_coef_variacao` | poucos dias com venda; CV alto (classe Z) |
| Estoque | `ultima_sincronizacao` | sincronização antiga → estoque pode estar errado |
| Outliers | Query 7 | evento outlier recente não tratado infla/desinfla a média |
| Preço | `fonte_preco` / `fonte_leadtime` | fonte estimada/herdada em vez de real |

**Confiança baixa → recomendação mais conservadora**, e isso tem que estar escrito no memo
(no bloco "O que me faria mudar de opinião").

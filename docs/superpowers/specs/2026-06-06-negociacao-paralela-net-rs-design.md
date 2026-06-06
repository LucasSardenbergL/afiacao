# Negociação Paralela v2 — fila por R$ líquido (net marginal)

> Spec de design. Data: 2026-06-06. Substrato: `/admin/reposicao/negociacao-paralela` (OBEN / Sayerlack).
> Codex fora no momento → validação por dados reais (feita, ver §Evidência) + helper puro TDD; adversarial do Codex retroativo quando voltar.

## 1. Problema

A tela hoje responde "quais SKUs Sayerlack levar pro gerente negociar desconto flat condicional". Está quebrada em três níveis, todos confirmados no código e com dado real de produção:

1. **130 sugestões = acúmulo mecânico, não análise.** O cron `afiacao_sugestoes_diarias` (`0 10 * * *`) cria 10 SKUs novos/dia via `sugerir_negociacao_paralela_hoje`, cada um válido 14 dias. O pool Sayerlack nunca esgota → ~13 dias × 10 ≈ 130 sugestões empilhadas.
2. **"Tudo prioritário" é defeito matemático.** O score da matview `mv_sku_ranking_negociacao_paralela` usa `percent_rank()` (percentil relativo) em 3 das 4 dimensões (volume, consistência, preço). Percentil é posição, não mérito — sempre existe um topo. A 4ª dimensão (ausência de promoção) dá 100 a quase todo SKU (no fluxo normal Sayerlack quase nada entra em promoção), inflando a base. Por construção, ~1/4 a 1/3 do ranking cai em "prioritário".
3. **O critério não mede dinheiro.** Pondera volume financeiro + consistência + preço unitário + ausência de promoção. Nenhum responde "o desconto paga o capital que vou imobilizar?". Giro, custo de capital e tempo parado — os três eixos que importam — não entram.

Além disso, o **preço exibido** vem do histórico de compras (`sku_leadtime_history`), não do CMC do Omie — fonte diferente (e mais frágil) da Reposição.

### Realidade operacional (founder, 2026-06-06)

- Negocia **1-3 itens/mês** (mais provável 1), **não diário**.
- Desconto **fora de promoção: ~7-10%** (base 8%). **Em promoção: no máx +3%, e raro/difícil.**
- O gerente exige um **volume acima do giro mensal**, de **critério desconhecido** a priori.

## 2. Objetivo

Transformar a tela numa **fila curta mensal priorizada por R$ líquido**, respondendo: *"vale a pena negociar este item, dado meu custo de capital, meu giro e quanto volume fica parado?"* — e devolver **O(1-3) itens/mês**, com a munição de negociação na mão.

## 3. Modelo financeiro

### Definições
- `A` = consumo anual (un) = `demanda_media_diaria × 365`.
- `c` = custo unitário = **CMC do Omie** (`v_sku_parametros_sugeridos.preco_item_eoq` quando `fonte_preco='cmc'`).
- `δ` = desconto aplicável: **8%** fora de promoção (parametrizável 7-10%); **3%** em promoção (marcado "difícil/baixa confiança").
- `k` = custo de capital anual (`custo_capital_efetivo_perc/100` = selic+spread+armazenagem; OBEN ≈ 25,8%).
- `d` = `demanda_media_diaria`; `G` = giro mensal = `A/12`.

### Fórmulas
Comprar um lote `Q` com desconto `δ` vs comprar conforme giro sem desconto:
- **economia(Q)** = `δ · c · Q`
- **custo de carregar(Q)** = `c · k · Q² / (2A)` *(estoque médio Q/2 pelo tempo Q/d; premissa conservadora de estoque-base ~0 — refinar com `qtde_compra_ciclo_sugerida` da view na implementação)*
- **net(Q)** = economia − custo de carregar

Derivadas (a alavanca é Q):
- **Lote ótimo** `Q* = δA/k` = **`12δ/k` meses de giro** (≈ 3,7 meses a δ=8%, k=25,8%).
- **Teto** `Q_max = 2δA/k` = **`24δ/k` meses de giro** (≈ 7,4 meses). Acima disso, net < 0.
- **Net no ótimo** = `δ²·c·A/(2k)`.
- **Prêmio bruto anual** = `δ · c · A` (mede o tamanho da oportunidade recorrente).

**Propriedade-chave:** o teto/ótimo em *meses de giro* é **universal** (depende só de δ e k, não do item). O que difere entre SKUs é o **R$**. Logo a fila ordena por **prêmio bruto anual** (= gasto anual × δ), e o card mostra o teto convertido em unidades por item.

### Base de custo (decisão)
Usar o **CMC** como base única na v1 (unifica com a Reposição #666; conservador no custo de capital). A economia fica ~9% superestimada vs o preço de tabela (o CMC embute frete/imposto), mas isso **não muda a ordem da fila nem a decisão dos campeões**, e o desconto real aparece no momento de fechar. `fonte_preco ≠ 'cmc'` → item marcado **"custo a confirmar"**, fora do ranking de R$ (degradação honesta).

## 4. Evidência (validação com dado real de produção — 2026-06-06)

Top SKUs Sayerlack OBEN por gasto real (k=25,8%, δ=8%):

| SKU | Gasto/ano | Economia 8%/ano | Net/negociação | Prometer (ótimo · teto) |
|---|---|---|---|---|
| CATALISADOR FC.6975 | R$ 154 mil | **R$ 12.356** | ~R$ 1.916 | ~89 un · 179 |
| DILUENTE PU DFA.4128 | R$ 122 mil | R$ 9.752 | ~R$ 1.512 | ~112 un · 224 |
| SELADORA NLO.9525 | R$ 113 mil | R$ 9.076 | ~R$ 1.407 | ~96 un · 191 |
| RETARDADOR DEA.4014 *(o "prioritário 92.2" da tela hoje)* | R$ 15 mil | R$ 1.202 | ~R$ 186 | ~10 un |

O "prioritário score 92.2" da tela atual está **fora do top 20 por dinheiro**; o líder real (CATALISADOR) **vale 10×** e não aparecia no topo. Prova de que a priorização atual ranqueia por percentil, não por R$.

**CMC:** nos 20 de maior giro, `fonte='cmc'` em 20/20, ~9% acima do histórico de compras de forma consistente (provável frete/imposto embutido — não "desatualizado"). O problema dos 203 produtos é localizado (menor giro / sem compra recente) → **frente separada** (ver query diagnóstica), não bloqueia esta tela.

## 5. A tela nova

- **Fila curta** (top N por prêmio anual; só `fonte='cmc'`; itens fora de promoção priorizados). Cadência de uso mensal.
- **Card por item:** economia/ano · net por negociação · **"quanto prometer"** (ótimo + teto, em unidades e meses de giro) · badge de confiança (custo a confirmar / em promoção = só 3%).
- **Simulador** (quando vai fechar): entra com o desconto e o volume reais que o gerente ofereceu → net real, comparado ao teto. Reusa `avaliarComprarMais`.
- **Registro de negociação → campanha flat condicional:** mantém (`converter_sugestao_em_campanha_flat`). Gatilho invertido: **você puxa da fila** o item que decidiu perseguir (cria a sugestão em `acao_tomada`), o sistema não empurra 10/dia.

## 6. O que morre

- Cron `afiacao_sugestoes_diarias` (geração diária em massa).
- Score por `percent_rank` (matview `mv_sku_ranking_negociacao_paralela` — desativada/substituída).
- A função `sugerir_negociacao_paralela_hoje` na forma atual (geração em lote).

## 7. Arquitetura

Padrão do Otimizador de Compras (client-side sobre view + helper puro TDD), zero migration pesada:
- **Fonte:** `v_sku_parametros_sugeridos` (empresa=OBEN, fornecedor Sayerlack) → CMC, giro, custo de capital, `fonte_preco`. + promoções ativas (`promocao_item`/`promocao_campanha`) para definir 8% vs 3%.
- **Helper puro novo (TDD):** `src/lib/reposicao/negociacao-valor-helpers.ts` — `premioAnual`, `netNegociacao`, `loteOtimo`, `tetoVolume`, `descontoAplicavel`. Espelha as fórmulas; testável; é o oráculo.
- **Hook/tela:** reescreve `useNegociacaoParalela` + a página pra consumir a fila derivada. Mantém a tabela `sugestao_negociacao_paralela` (ciclo de vida) e o fluxo de conversão em campanha.
- **Migration:** apenas drop do cron diário + deprecação da matview/função de score (sem novo objeto pesado).

## 8. Degradação honesta

- `fonte_preco ≠ 'cmc'` → "custo a confirmar", fora do ranking de R$.
- `demanda_media_diaria` nula/zero → fora da fila.
- SKU em promoção ativa → δ=3%, badge "difícil".
- Sem dados → não fabrica número.

## 9. Não-objetivos (YAGNI v1)

- Adivinhar o volume exato do gerente (usa-se o teto).
- Frete/prazo incremental no net (marginais p/ flat Sayerlack — v2 se necessário).
- Corrigir o CMC dos 203 produtos (frente separada).
- Métrica recorrente sofisticada (renovação automática de acordo) — v2.

## 10. A confirmar na revisão do founder

- Faixa de desconto padrão: 8% fixo, ou banda 7-10% configurável?
- Quantos itens na fila curta (top 3? top 5?).
- Base de custo: CMC único (proposto) vs desconto sobre `preco_compra_real` + capital sobre CMC (mais preciso, mais complexo).

## 11. Riscos / dependências

- CMC depende da frente dos 203 (mitigado por degradação honesta).
- O `net por negociação` assume estoque-base ~0; refinar com `qtde_compra_ciclo_sugerida` (EOQ) da view na implementação (resultado fica levemente mais favorável — conservador).
- Validação adversária do Codex pendente (rodar quando voltar).

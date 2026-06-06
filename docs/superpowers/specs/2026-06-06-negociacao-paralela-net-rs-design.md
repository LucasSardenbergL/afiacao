# Negociação Paralela v2 — fila por R$ líquido (net marginal)

> Spec de design. Data: 2026-06-06. Substrato: `/admin/reposicao/negociacao-paralela` (OBEN / Sayerlack).
> Codex fora no momento → validação por dados reais (feita, ver §4) + helper puro TDD; adversarial do Codex retroativo quando voltar.

## 1. Problema

A tela hoje responde "quais SKUs Sayerlack levar pro gerente negociar desconto flat condicional". Está quebrada em três níveis, todos confirmados no código e com dado real de produção:

1. **130 sugestões = acúmulo mecânico, não análise.** O cron `afiacao_sugestoes_diarias` (`0 10 * * *`) cria 10 SKUs novos/dia via `sugerir_negociacao_paralela_hoje`, cada um válido 14 dias. O pool Sayerlack nunca esgota → ~13 dias × 10 ≈ 130 sugestões empilhadas.
2. **"Tudo prioritário" é defeito matemático.** O score da matview `mv_sku_ranking_negociacao_paralela` usa `percent_rank()` (percentil relativo) em 3 das 4 dimensões (volume, consistência, preço). Percentil é posição, não mérito — sempre existe um topo. A 4ª dimensão (ausência de promoção) dá 100 a quase todo SKU (no fluxo normal Sayerlack quase nada entra em promoção), inflando a base. Por construção, ~1/4 a 1/3 do ranking cai em "prioritário".
3. **O critério não mede dinheiro.** Pondera volume financeiro + consistência + preço unitário + ausência de promoção. Nenhum responde "o desconto paga o capital que vou imobilizar?". Giro, custo de capital e tempo parado — os três eixos que importam — não entram.

Além disso, o **preço exibido** vem do histórico de compras (`sku_leadtime_history`), não do CMC do Omie — fonte diferente (e mais frágil) da Reposição.

### Realidade operacional (founder, 2026-06-06)

- Negocia **1-3 itens/mês** (mais provável 1), **não diário**.
- Desconto é **conversa**: ele pede ~10%, o gerente devolve ~7% → o desconto é **input dele** (banda típica 7-10%). **Em promoção: no máx +3%, e raro/difícil.**
- O gerente exige um **volume acima do giro mensal**, de **critério desconhecido** a priori.

## 2. Objetivo

Transformar a tela numa **fila curta mensal priorizada por R$ líquido**, respondendo: *"vale a pena negociar este item, dado meu custo de capital, meu giro e quanto volume fica parado?"* — e devolver os **Top 3 itens/mês**, com a munição de negociação na mão (quanto prometer, e o teto).

## 3. Modelo financeiro

### Definições
- `A` = consumo anual (un) = `demanda_media_diaria × 365`.
- `p` = **preço de compra real** (`preco_compra_real`, média das notas Sayerlack) — base da **economia** (o desconto incide sobre o que se paga).
- `c` = **CMC do Omie** (`v_sku_parametros_sugeridos.preco_item_eoq` quando `fonte_preco='cmc'`) — base do **capital parado** (custo contábil de carregar estoque).
- `δ` = desconto **definido pelo usuário** no card (ele pede 10%, o gerente devolve 7% → slider/input; default 8% só pra ordenar a fila; banda guia 7-10%). Em promoção ativa: 3% (badge "difícil").
- `k` = custo de capital anual (`custo_capital_efetivo_perc/100` = selic+spread+armazenagem; OBEN ≈ 25,8%).
- `d` = `demanda_media_diaria`; `G` = giro mensal = `A/12`.

### Fórmulas — base de custo SEPARADA (decisão do founder)
Comprar um lote `Q` com desconto `δ` vs comprar conforme giro sem desconto:
- **economia(Q)** = `δ · p · Q` (desconto sobre o preço de compra)
- **custo de carregar(Q)** = `c · k · Q² / (2A)` (capital sobre o CMC; estoque médio Q/2 pelo tempo Q/d; premissa conservadora de estoque-base ~0 — refinar com `qtde_compra_ciclo_sugerida` da view na implementação)
- **net(Q)** = economia − custo de carregar

Derivadas (a alavanca é Q):
- **Lote ótimo** `Q* = δ·p·A / (c·k)`
- **Teto** `Q_max = 2·Q*` (net = 0; acima disso, perde)
- **Net no ótimo** = `(δ·p)² · A / (2·c·k)`
- **Prêmio bruto anual** = `δ · p · A` (tamanho da oportunidade; ordena a fila)

> Como `p < c` (~91% nos dados), o teto em meses de giro fica ~9% abaixo do cenário CMC-único e **deixa de ser idêntico entre itens** (depende da razão `p/c`) — é o preço da maior precisão escolhida. A **ordem da fila** (por `δ·p·A`) é por gasto e **independe** do δ escolhido.

### Degradação honesta (base separada)
O cálculo precisa de **`preco_compra_real` E `cmc`**. Falta de qualquer um → item marcado **"custo a confirmar"**, fora do ranking de R$. (Os ~8 Sayerlack de alto giro sem CMC — ex.: VERNIZ FO20.6717, R$ 10.775/180d — caem aqui até o CMC ser preenchido; ver §investigação CMC.)

## 4. Evidência (validação com dado real de produção — 2026-06-06)

Top SKUs Sayerlack OBEN por gasto real (k=25,8%, δ=8%; CMC como proxy de custo na validação):

| SKU | Gasto/ano | Economia 8%/ano | Net/negociação | Prometer (ótimo · teto) |
|---|---|---|---|---|
| CATALISADOR FC.6975 | R$ 154 mil | **R$ 12.356** | ~R$ 1.916 | ~89 un · 179 |
| DILUENTE PU DFA.4128 | R$ 122 mil | R$ 9.752 | ~R$ 1.512 | ~112 un · 224 |
| SELADORA NLO.9525 | R$ 113 mil | R$ 9.076 | ~R$ 1.407 | ~96 un · 191 |
| RETARDADOR DEA.4014 *(o "prioritário 92.2" da tela hoje)* | R$ 15 mil | R$ 1.202 | ~R$ 186 | ~10 un |

O "prioritário score 92.2" da tela atual está **fora do top 20 por dinheiro**; o líder real (CATALISADOR) **vale 10×** e não aparecia no topo. Prova de que a priorização atual ranqueia por percentil, não por R$.

**CMC (diagnóstico, frente separada):** 260/339 SKUs OBEN com CMC saudável (~91% do giro); **zero defasados por sync** (não é "CMC velho"); 77 sem CMC (caem em fallback), dos quais a maioria é primeira-compra/baixo-giro e ~8 são Sayerlack de giro relevante sem linha de CMC (esses importam). O problema dos "203 produtos" do founder é provavelmente a tela de **Revisão** (parâmetros alterados pelo efeito do #666 trocar a base de custo pro CMC), não CMC quebrado.

## 5. A tela nova

- **Fila Top 3** (por prêmio anual; só com `preco_compra_real` E `cmc`; itens fora de promoção priorizados). Cadência de uso mensal.
- **Card por item:**
  - **Controle de desconto** (slider/input, default 8%, banda 7-10%) — porque é negociação; ao mexer, recalcula net/teto ao vivo.
  - Economia/ano · **net por negociação** · **"quanto prometer"** (ótimo + teto, em unidades e meses de giro).
  - Badge de confiança ("custo a confirmar" / "em promoção = só 3%").
- **Registro de negociação → campanha flat condicional:** mantém (`converter_sugestao_em_campanha_flat`). Gatilho invertido: **você puxa da fila** o item que decidiu perseguir (cria a sugestão em `acao_tomada`), o sistema não empurra 10/dia.

## 6. O que morre

- Cron `afiacao_sugestoes_diarias` (geração diária em massa).
- Score por `percent_rank` (matview `mv_sku_ranking_negociacao_paralela` — desativada/substituída).
- A função `sugerir_negociacao_paralela_hoje` na forma atual (geração em lote).

## 7. Arquitetura

Padrão do Otimizador de Compras (client-side sobre view + helper puro TDD), zero migration pesada:
- **Fonte:** `v_sku_parametros_sugeridos` (empresa=OBEN, fornecedor Sayerlack) → `preco_compra_real`, CMC (`preco_item_eoq`+`fonte_preco`), `demanda_media_diaria`, `custo_capital_efetivo_perc`. + promoções ativas (`promocao_item`/`promocao_campanha`) para o badge 3% vs banda.
- **Helper puro novo (TDD):** `src/lib/reposicao/negociacao-valor-helpers.ts` — `premioAnual`, `netNegociacao(δ,p,c,A,k,Q)`, `loteOtimo`, `tetoVolume`, `descontoAplicavel`. Espelha as fórmulas (base separada); testável; é o oráculo.
- **Hook/tela:** reescreve `useNegociacaoParalela` + a página pra consumir a fila Top 3 derivada, com o controle de desconto por card. Mantém a tabela `sugestao_negociacao_paralela` (ciclo de vida) e o fluxo de conversão em campanha.
- **Migration:** apenas drop do cron diário + deprecação da matview/função de score (sem novo objeto pesado).

## 8. Degradação honesta

- Falta `preco_compra_real` OU `cmc` → "custo a confirmar", fora do ranking de R$.
- `demanda_media_diaria` nula/zero → fora da fila.
- SKU em promoção ativa → δ=3%, badge "difícil".
- Sem dados → não fabrica número.

## 9. Não-objetivos (YAGNI v1)

- Adivinhar o volume exato do gerente (usa-se o teto).
- Frete/prazo incremental no net (marginais p/ flat Sayerlack — v2 se necessário).
- Corrigir o CMC dos 203 / dos 8 sem-CMC (frente separada de Reposição).
- Métrica recorrente sofisticada (renovação automática de acordo) — v2.

## 10. Decisões do founder (fechadas)

- **Desconto:** definido pelo usuário no card (negociação real; default 8%, banda 7-10%; 3% em promoção). A ordem da fila independe do δ.
- **Tamanho da fila:** Top 3.
- **Base de custo:** SEPARADA — economia sobre `preco_compra_real`, capital parado sobre CMC. Degrada para "custo a confirmar" se faltar qualquer um.

## 11. Riscos / dependências

- CMC ausente em ~8 Sayerlack de alto giro → eles ficam em "custo a confirmar" até o CMC ser preenchido (frente separada; alguns seriam bons candidatos, ex. VERNIZ FO20.6717).
- O `net por negociação` assume estoque-base ~0; refinar com `qtde_compra_ciclo_sugerida` (EOQ) da view (resultado fica levemente mais favorável — conservador).
- Validação adversária do Codex pendente (rodar quando voltar).

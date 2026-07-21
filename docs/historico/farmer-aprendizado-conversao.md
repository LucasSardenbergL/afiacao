# `farmer_category_conversion` — o "auto-aprendizado" que nunca aprendeu

> Post-mortem de um componente que existiu 5 meses no código, foi anunciado na documentação do
> próprio app, e **nunca escreveu uma única linha**. Enterrado no PR de 2026-07-21.
> Domínio: Farmer/Inteligência (engines de cross-sell, up-sell e bundle).

## O que se acreditava

Os engines calculam o **LIE** (Lucro Incremental Esperado, exibido como "EIP" na tela):

```
LIE_ij = P_ij × M_ij × ComplexityFactor
P_ij   = HistoricalRate × (HealthScore/100) × Engagement × Relevance
```

O `HistoricalRate` e o `ComplexityFactor` vinham de `farmer_category_conversion`, uma tabela
criada em fev/2026 (migration `20260223025321`) para acumular a taxa de conversão real por
categoria. A tela de documentação do app afirmava, textualmente:
*"Auto-aprendizado via tabela farmer_category_conversion"*.

## O que era verdade

A tabela tinha **0 linhas** — e não por falta de tempo de maturação. Eram **três elos quebrados
em série**, e bastava o primeiro para o conceito nunca sair do papel.

### Elo 1 — o writer era inalcançável

```
updateConversionStats            ← único writer da tabela
  ← só chamado por markAsAccepted           (useCrossSellEngine.ts:536)
  ← e só se actualMargin !== undefined      (:532)
  ← markAsAccepted NÃO era importado por NENHUM componente
```

Os três consumidores dos hooks pegavam apenas leitura/cálculo:

| Consumidor | Desestruturava |
|---|---|
| `FarmerRecommendations.tsx` | `recommendations, loading, calculating, calculateRecommendations` |
| `locc/OverviewTab.tsx` | `recommendations` |
| `bundles/useFarmerBundles.ts` | `customerBundles, rules, loading, calculating, calculateBundles` |

`markAsOffered` / `markAsAccepted` / `markAsRejected` (e os gêmeos `markBundle*`) eram exports
mortos: o hook os devolvia, ninguém os pegava. **Não havia UI para registrar o desfecho de uma
recomendação** — nem botão de "aceitou", nem captura de margem realizada, nem de tempo gasto.

Fora do frontend, nada: **0 cron jobs**, **0 funções SQL**, **0 triggers** citando a tabela.

### Elo 2 — sem desfecho, não há o que aprender

Medição em produção (`psql-ro`, 2026-07-21):

| Medição | Valor |
|---|---|
| `farmer_recommendations` | **3.659 linhas — 100% `pendente`** |
| ↳ com `actual_margin` | **0** |
| ↳ com `time_spent_seconds` | **0** |
| `farmer_bundle_recommendations` | 12 linhas |
| `farmer_category_conversion` | 0 linhas |
| ↳ `pg_stat_user_tables.n_tup_ins` | **0** — nunca uma inserção |

Nunca houve **uma única transição de status** desde fev/2026. Mesmo que alguém tivesse escrito o
job de agregação pedido, ele leria 3.659 linhas `pendente` e produziria nada: `updateConversionStats`
filtra por `status IN ('aceito','rejeitado','ofertado')` e cai no `if (!recs?.length) return`.

### Elo 3 — o writer também estava quebrado (latente)

Mesmo destravando a UI, o upsert falharia:

```ts
await supabase.from('farmer_category_conversion').upsert({ category_id: productId, ... });
```

Sem `onConflict`, o PostgREST resolve o conflito pela **PK** — que é `id UUID DEFAULT
gen_random_uuid()` e **não está no payload**, logo nunca colide. O INSERT prossegue e viola
`idx_farmer_category_conversion_category` (`CREATE UNIQUE INDEX` sobre `category_id`, **não** uma
constraint) → **23505 a partir da 2ª gravação do mesmo produto**. E o retorno não era checado
(`await` sem ler `error`), então falharia **em silêncio** — a mesma família do `|| 0`.

### Bônus — `category_id` nunca foi categoria

O writer gravava `category_id: productId`. O spec de 2026-05-25
(`docs/superpowers/specs/2026-05-25-carteira-mixgap-crosssell-design.md`) já havia flagrado isso e
deixado a tabela **fora da v1**: *"parece categoria mas o `useCrossSellEngine` o usa como
product_id — NÃO é sinal de categoria confiável"*. A chave de categoria real do catálogo é
`omie_products.familia`. O conceito já tinha sido avaliado e engavetado uma vez.

## Impacto real — e por que ele é MENOR do que parece

Este é o ponto que merece honestidade, porque a tentação era classificar como irmão dos bugs
money-path #1466/#1468/#1471 (corrigidos na véspera, nos mesmos arquivos) e superestimar.

`historicalRate` e `complexityFactor` eram **constantes idênticas para todo produto**. Isso as
torna um **fator de escala global** no LIE — e fator de escala **não altera ordenação**:
`0,15·X` vs `0,15·Y` ordena exatamente como `X` vs `Y`. Como a tela usa o LIE para **priorizar**,
o produto entregue às vendedoras estava **correto**. Diferente do `costMap.get(id) || 0`, que
promovia SKUs sem custo ao topo do ranking — aquele corrompia a ordem; este, não.

O dano real é do **princípio 3** (*nunca fabricar número no money-path*), não do ranking:

1. O LIE era exibido em **R$** em três níveis (total da tela, por cliente, por recomendação —
   `fmt()` = `currency BRL`), como previsão de lucro cujo `P` é chute.
2. A documentação do app **afirmava** um aprendizado que não existia — o pior tipo de dívida,
   porque nenhuma leitura do código a contradiz sem medir o banco.

## O que foi feito (2026-07-21)

- **Removida a leitura** de `farmer_category_conversion` nos dois engines. As taxas viraram
  constantes **nomeadas e locais** (`TAXA_CONVERSAO_CROSS_SELL`, `TAXA_CONVERSAO_UP_SELL`,
  `FATOR_COMPLEXIDADE`) com comentário explicando que são arbitradas, por que a tabela está vazia
  e o que seria preciso para calibrá-las.
  - *Locais, não num helper compartilhado:* os hooks pertencem a módulos diferentes do manifesto
    (`vendas` e `farmer-inteligencia`); um helper comum abriria fronteira nova na baseline por
    dois números.
- **Deletado o código morto:** `updateConversionStats` (ambos), `markAsOffered/Accepted/Rejected`,
  `markBundleOffered/Accepted/Rejected` e os tipos órfãos (`ConversionRow`,
  `RecommendationStatsRow`, `StatsRecRow`, `BundleStatsRow`, `RecommendationUpdate`,
  `BundleAcceptUpdate`).
  - Passou pelo checklist *"aposentar código"* do `money-path.md`: a pergunta é **o que acontece
    se alguém chamar**, não quem chama. `markAsOffered/Rejected` só setavam status (inócuo) e
    `markAsAccepted` caía no upsert quebrado (não gravava). **Nenhuma arma carregada** — ao
    contrário do `mapaConsolidacao` do #1420, que era o rollback da consolidação B-lite disfarçado
    de código morto.
- **Rotulada a UI:** o card virou "EIP Total (estimativa)" e a tela ganhou uma nota visível — o
  EIP serve para priorizar (a ordem é confiável), o valor em R$ não é previsão de receita.
- **Corrigida a documentação** do app (`SecaoFuncionalidades.tsx`), que anunciava o auto-aprendizado.
- **A tabela permanece** — vazia, com RLS habilitada e policy `FOR ALL` restrita a
  `master`/`employee` (auditado: sem grant anômalo a `anon`). Dropar exigiria o ritual de migration
  pelo SQL Editor e não paga; ela não é lida nem escrita por ninguém.

## Se um dia o loop for construído (follow-up de produto)

Não é "escrever o job". A ordem obrigatória é:

1. **UI de desfecho** — a vendedora precisa marcar aceito/rejeitado, e informar margem realizada e
   tempo gasto. Isso é workflow novo, não código: decidir onde entra no fluxo dela sem virar
   burocracia (sem isso, os campos ficam nulos e o resto não funciona).
2. **Corrigir a chave** — `category_id` deve receber categoria de verdade (`omie_products.familia`),
   não `product_id`. Com product_id a amostra por chave é minúscula e a taxa, ruído.
3. **Corrigir o upsert** — `onConflict: 'category_id'` e **checar o `error`** do retorno.
4. **Só então agregar** — e mesmo aí, respeitar *ausente ≠ zero*: categoria com amostra pequena
   deve degradar para a premissa fixa explicitamente, nunca produzir uma taxa de 2 ofertas.
5. **Rever o rótulo da UI** — o aviso de "não calibrado" sai quando o dado passar a existir, e só
   para as categorias que de fato tiverem amostra.

## Lição

**Ler uma tabela vazia é pior que não ler.** A leitura fazia o código *parecer* adaptativo: a
fórmula `P_ij = HistoricalRate × …` sugeria personalização por categoria, o ternário
`conv ? Number(conv.conversion_rate) : 0.15` sugeria que o default era o caso raro, e a doc
afirmava aprendizado. Um leitor do código não tinha como descobrir a verdade sem ir ao banco —
e o banco dizia `n_tup_ins = 0` desde fevereiro.

É a família do *ausente ≠ zero* aplicada a um andar acima: não é um número fabricado a partir de
`null`, é uma **capacidade fabricada a partir de uma tabela vazia**. O default explícito e
comentado é honesto; o default disfarçado de aprendizado é o mesmo `|| 0` em escala de arquitetura.

Corolário para revisão: **quando a fórmula anuncia personalização, meça a cardinalidade da fonte.**
Uma tabela de "aprendizado" com 0 linhas e um consumidor com fallback silencioso é indistinguível,
em código, de uma que funciona.

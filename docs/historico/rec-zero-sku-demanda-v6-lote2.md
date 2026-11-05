# Recebimento e ficha do SKU: falha de leitura não vira zero nem vazio (plano v6, lote 2: C2 + C4)

Data: 2026-11-04. Plano: `docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md` §2, itens
C2 (REC-ZERO) e C4 (SKU-DEMANDA), com os ajustes do `anexos/codex-contestacao.md`. É a mesma classe
do E5 do v5 (#3565, KPIs do Financeiro Gestão) e do Picking: **ausente ≠ zero**.

## O defeito

**C2, `src/pages/AdminEstoqueRecebimento.tsx`.** As 4 queries dos cards (pendentes, divergências,
valor em trânsito, efetivadas hoje) faziam `const { count } = await …; return count ?? 0` ou
`(data ?? []).reduce(…)`. O `error` era descartado, a query ficava `success` com 0, e o render ainda
fabricava de novo com `?? 0`. Uma falha de RLS ou de rede aparecia como **"0 divergências"** e
**"Valor em trânsito R$ 0,00"**, ditos como fato. Durante o 1º carregamento, os cards também
mostravam 0.

**C4, `src/components/reposicao/SkuDetailSheet.tsx`.** A leitura dos stats da view fazia
`if (error) return null` e a da demanda de 90 dias fazia `if (error) return []`. O resultado era o
gráfico desenhado vazio e sem aviso, além de "baseado em 0 compras" nos preços. Correção à premissa
original, feita pelo Codex: a falha **não** produzia 90 pontos em zero. Os 90 zeros vêm de uma
consulta bem-sucedida sem vendas, que é o SKU parado, um fato. A falha produzia um gráfico vazio,
sem nada.

## O conserto

Padrão comum: `estadoDeLeitura()` + `naoConsegui()` (`src/lib/leitura/estado-de-leitura.ts`) e
`<AvisoLeituraFalhou>`, os mesmos da página-irmã `AdminEstoquePicking.tsx`.

- **Recebimento.** As 4 queries lançam o `error`. O `count` nulo sem erro também lança, porque a
  contagem que não veio é ausência, não zero. Cada card tem 3 estados com `data-estado`:
  - **carregando**: um esqueleto, sem número. O Picking ainda mostra 0 aqui, o que fica como lição.
  - **erro ou sem rede**: "—" com borda tracejada e "Indisponível", sem a cor do zero, além de um
    aviso do bloco (`aviso-receb-kpis`).
  - **pronta**: o número observado.
- **Valor em trânsito.** NF-e com `valor_total` nulo não é mais somada como R$ 0. Ela é contada à
  parte, e o card mostra **"≥ R$ X · Soma parcial — N NF-e sem valor"**. A leitura ganhou
  `.range(0, 999)` com o mesmo tratamento de piso se a página vier cheia. Em prod hoje são 6 NF-e
  pendentes e 0 sem valor (psql-ro, 2026-11-04), então isso é guarda, não incidente.
- **Ficha do SKU.** As 2 queries lançam o erro.
  - **Stats**: em erro, aparece `aviso-sku-stats`. O "(baseado em N compras)" só é exibido quando
    `n_compras` foi lido (antes, `?? 0`).
  - **Gráfico**: em erro, o aviso aparece no lugar do gráfico (`aviso-sku-demanda`). No
    carregamento aparece um esqueleto. Com dados lidos, o gráfico é desenhado; se os 90 dias forem
    zero, ganha a frase "Nenhuma venda registrada nos últimos 90 dias".
  - O motor de demanda não mudou.

## O que ficou de fora, de propósito

Os `formatBRL` de `src/components/reposicao/pedidos/shared.ts:29` e `src/lib/grupos/format.ts:13`
convertem nulo em R$ 0,00, mas o plano condicionou o conserto a um consumidor que receba nulo. Uma
varredura dos 34 call-sites não achou nenhum: todos recebem `number` ou já têm guarda. O "ausente
vira R$ 0,00" real está **antes**, em `useDetalhesModal.ts:146`
(`_preco = Number(it.preco_unitario ?? 0)`, intencional para o total não virar NaN) e nos `num()` de
`useGrupoFinanceiro.ts`/`useGrupoComercial.ts`. São candidatos para outro lote, não para os
formatadores.

## Prova

- `src/pages/__tests__/AdminEstoqueRecebimento.kpi-leitura.test.tsx`, com 21 casos:
  - os 4 cards × (a query entra em erro, render do erro, carregando, zero observado);
  - offline, `count` nulo, soma parcial, soma completa e contagem positiva.
  - O mock reconhece a query pelos **filtros**, não pela tabela, porque as 4 batem em
    `nfe_recebimentos`. Assim só uma falha por vez.
- `src/components/reposicao/__tests__/SkuDetailSheet.leitura.test.tsx`, com 10 casos: gráfico e stats
  × (erro da query, erro no render, carregando, zero observado), mais offline e venda observada.
- Falsificação na mesma invocação: controle verde em `LC_ALL=C` e `pt_BR.UTF-8`, depois 10
  sabotagens, uma camada por vez. Todas ficaram vermelhas:
  - throw removido em pendentes e em trânsito;
  - `count` nulo virando 0;
  - erro renderizado como 0;
  - carregando renderizado como 0;
  - nulo somado como 0;
  - throw removido nos stats e na demanda;
  - `n_compras ?? 0`;
  - carregando desenhando o gráfico.

## Lições do laço de falsificação

- **Camada verde redundante (S1).** Sem o `if (error) throw error` nas contagens, a guarda
  `count == null` pegava a falha do mesmo jeito, e o teste continuava verde. Agora o teste exige que
  a query carregue o erro **do banco** (`permission denied`), não a mensagem genérica, e a camada
  voltou a ser observável.
- **Commit com sabotagem em voo.** Um `git add -A` feito enquanto o laço rodava em background
  commitou o arquivo-fonte no meio da S10 (`false ? (` no lugar de `estadoDemanda !== 'pronta' ? (`).
  O `restaurar()` do laço (`git checkout --`) passou a "restaurar" para a versão sabotada. Quem
  pegou foi o **controle verde** da invocação seguinte, que abortou antes da 1ª sabotagem. Regra:
  enquanto o laço roda, nada de commit no worktree. Se for preciso, `git add` nomeando os arquivos.

## Deploy

Só **Publish** no Lovable (front puro: sem migration, sem edge).

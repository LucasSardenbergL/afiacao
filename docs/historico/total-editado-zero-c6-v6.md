# Total do pedido de reposição com editado zero (plano v6, lote 4 — C6)

**Data:** 2026-11-05 · **Plano:** `docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md` §2 C6 · **Deploy:** só Publish (front-end).

## Problema

No modal de detalhes do pedido de reposição (`src/components/reposicao/pedidos/DetalhesModal.tsx`), o cabeçalho "Valor total" fazia `formatBRL(totalAtual || pedido.valor_total)`. Com todas as quantidades zeradas, `totalAtual` é `0` — falsy — e o cabeçalho voltava ao total **antigo**, enquanto o rodapé da tabela de itens mostrava o recalculado `R$ 0,00`. Duas verdades na mesma tela; a de cima, errada.

## Conserto

O cabeçalho usa o recalculado sempre que os itens carregaram (`itensEstado === 'ok'`), **inclusive zero**. O total gravado (`pedido.valor_total`, `NOT NULL` no banco) só aparece enquanto os itens não chegaram ou falharam — aí o recalculado não existe, e mostrar `R$ 0,00` seria zero fabricado.

Por que não `??`: `totalAtual` é a soma de `linhas` e vale `0` também **antes** dos itens chegarem. Um `totalAtual ?? valor_total` trocaria o defeito por outro (zero fabricado no carregando/erro). O sinal certo de "o recalculado existe" é o estado da query, não o valor.

## Prova

`src/components/reposicao/pedidos/__tests__/DetalhesModal.total-cabecalho.test.tsx` renderiza o modal com o hook mockado e lê o cabeçalho por `data-testid="valor-total-cabecalho"`: editado zero → `R$ 0,00`; editado ≠ gravado → recalculado; carregando e erro → total gravado.

Falsificado na mesma invocação, nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`), com controle verde antes: voltar ao `||` → vermelho com `expected 'R$ 1.234,50' to be 'R$ 0,00'`; trocar por `??` → 2 vermelhos com `expected 'R$ 0,00' to be 'R$ 1.234,50'`; restaurado → verde.

## Vizinhos

Varredura de `|| <total/valor>` em `src/components/reposicao`, `src/lib/reposicao` e `src/pages/AdminReposicao*`: nenhum outro é o mesmo defeito (o que sobra são guardas booleanas, desempate de ordenação e `total || 0` de contagem, que não devolve valor antigo).

# Enumerar consumidores de um helper: `git grep -l <caminho>` responde a pergunta errada

> **A regra (2026-08-23):** quando a pergunta é *"quais edges servem o código deste helper?"*, a
> lista de quem **cita o caminho** dele não é a resposta. Ela erra nos **dois** sentidos: perde quem
> chega ao helper por um intermediário, e inclui quem só importa um **tipo** — apagado na compilação.
> O que responde é o **fechamento transitivo dos imports de VALOR**. Enumeração errada não falha
> ruidosamente: ela vira um recorte que parece completo e deixa consumidores servindo o bundle velho
> sem ninguém notar.

## O caso

Fatia 2 do deploy do **#1889** (`_shared/paginate.ts`: EOF passou a ser página VAZIA, não CURTA; o
offset avança pelas linhas REAIS). A tarefa chegou com a enumeração já pronta e plausível:

```
git grep -l "_shared/paginate.ts" origin/main -- supabase/functions/
```

Menos as 3 já deployadas no #1905, dava **16 edges**. O número certo é **17** — e as duas correções
se cancelavam parcialmente, o que é justamente o que torna o erro difícil de ver.

### Erro 1 — perde quem chega por um intermediário

`monthly-report` **não cita** `paginate.ts` em lugar nenhum. Ela importa
`_shared/relatorio-mensal.ts`, que importa `fetchAll`. O grep de caminho é cego a um salto de
distância, e o bundle da edge carrega o helper do mesmo jeito.

### Erro 2 — inclui quem só importa um TIPO

Cinco edges (`carteira-positivacao-snapshot`, `omie-vendas-sync`, `scoring-recalc-batch`,
`sync-reprocess`, `visit-score-recalc-batch`) citam o caminho assim:

```ts
import type { BancoPostgrest } from '../_shared/paginate.ts';
```

`import type` é **apagado na compilação** — sozinho, ele não põe uma linha do helper no bundle. Aqui
está a parte que quase me fez errar para o outro lado: **conclui que as cinco estavam FORA do
escopo** e cheguei a dizer isso. Estavam dentro — a paginação real chega por
`_shared/mapas-paginados.ts`, que elas também importam, esse sim de valor. As duas propriedades são
independentes: citar o caminho não prova que carrega, e não citar não prova que não carrega.

## O que responde de fato

Fechamento transitivo dos imports **de valor** (exclui `import type` e a forma
`import { type A, type B }`, ambas apagadas na compilação), a partir de cada `index.ts`:

| rota até `paginate.ts` | edges |
|---|---|
| direto | 12 |
| via `_shared/mapas-paginados.ts` | 5 |
| via `_shared/relatorio-mensal.ts` | 1 (`monthly-report`) |
| via `_shared/recommend-leituras.ts` | 1 (`recommend`) |

**20 edges**, não 15 nem 16. A tabela por ROTA é parte da resposta, não enfeite: ela mostra que o
helper tem três fronteiras de propagação, e é o que permite prever quais edges uma mudança futura em
`mapas-paginados.ts` atinge sem repetir a análise.

## Por que isto não se resolve "grepando melhor"

Um grep por símbolo (`fetchAll`) troca de erro, não conserta: passa a perder quem chama
`carregarPedidosDoMes` (o wrapper) e continua sem enxergar o import type. Um grep mais amplo pega
comentário e teste. O problema não é a precisão do padrão — é que **a relação procurada é transitiva
e o grep é local**. A ferramenta certa é percorrer o grafo.

Custo de errar: cada edge fora da lista fica servindo o helper antigo por tempo indefinido, e como o
#1889 é no-op por desenho (`deploy-no-op-por-desenho.md`), **nada** no comportamento denuncia a
ausência. A enumeração é a única barreira.

## Lições

1. **"Quais módulos servem este código?" é uma pergunta de GRAFO.** `git grep -l <caminho>` responde
   "quem menciona este arquivo", que é outra coisa. Use o fechamento transitivo de imports de valor.
2. **`import type` é apagado na compilação — mas isso não expulsa a edge do escopo.** Verifique se
   ela não alcança o mesmo helper por outra aresta antes de tirá-la da lista. Errei nessa direção
   antes de conferir o caminho de cada uma.
3. **Enumeração incompleta não falha ruidosamente.** Ela entrega um recorte com cara de completo. Se
   a mudança em jogo é invisível por desenho, a lista É a verificação — não há segunda barreira.
4. **Quando a tarefa já chega com a lista pronta, refaça a enumeração.** A daqui veio num enunciado
   cuidadoso e mesmo assim tinha as duas falhas; conferir custou um script de 30 linhas.

## Rodapé — o gate que faltou na mesma entrega

O CI (`validate`) reprovou o PR por **1 erro de lint**: `as Record<string, any>` é `any` ESCRITO, que
o `@typescript-eslint/no-explicit-any` barra. Causa de não ter pego local: rodei `test:edges`,
`edges:typecheck` e `vitest` — e **não** `bun lint`. O `validate` roda **três** gates (typecheck +
lint + test); rodar dois e declarar verde é ausência de dado, não aprovação
(`evidencia-positiva-shell.md`). A correção foi remover o cast: `req.json()` já devolve `any`
inferido, o tipo que aquele destructuring tinha antes — restaurar o status quo, não inventar
interface nova. Verificação de que não sobrou resíduo: o lint saiu de `76 problems (1 error, 75
warnings)` para `75 problems (0 errors, 75 warnings)`.

## Rodapé 2 — o Erro 1 cobrou o preço previsto

O doc previu que o `git grep -l` perde quem chega por um intermediário. A conta veio: das 20 edges
do fechamento, a **última** a ganhar sensor foi a `monthly-report`, justamente a que chega ao
`paginate.ts` por um salto (`_shared/relatorio-mensal.ts`). Ela não ficou por último por ser
difícil — ficou por último porque **nenhuma lista a continha**, e listas erradas não produzem
sintoma: produzem silêncio.

O agravante é o custo dela. Um `probe` às cegas contra o bundle antigo dessa edge manda o
relatório mensal por e-mail para os 5.276 perfis (`deploy-no-op-por-desenho.md`, §9ª leva). A
edge mais perigosa da fatia era, também, a única invisível ao método de enumeração usado — não por
azar, mas porque as duas propriedades têm a mesma raiz: ninguém tinha olhado para ela.

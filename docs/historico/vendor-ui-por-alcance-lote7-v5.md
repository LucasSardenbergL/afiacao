# `vendor-ui` separado por alcance: −16 KB gz no boot (plano v5, lote 7 — F3)

Plano: `docs/superpowers/plans/2026-11-03-plano-melhoria-v5/README.md` (F3, veredito "MANTER condicionado
ao build comparativo"). Só **Publish**: muda o bundle, não o banco nem as edges.

## O que mudou

`vite.config.ts` (`vendorChunk`): o Radix deixou de ir inteiro para o `vendor-ui`. Agora o módulo Radix
que o entry (`src/main.tsx`) importa por import ESTÁTICO fica no `vendor-ui` (vai no modulepreload); o resto
vai para o `vendor-ui-rotas`, que só as telas lazy que o usam baixam. A regra lê o grafo, não uma lista de
pacotes: se o shell passar a usar outro Radix, ele volta sozinho para o `vendor-ui`. `next-themes` continua
no `vendor-ui`.

## Medição (mesmo commit `fdbda4d9d`, com e sem a mudança; gz = `gzip -9` do arquivo em `dist/`)

| Medida | Antes | Depois | Δ |
|---|---|---|---|
| `vendor-ui` | 47,6 KB (45 pacotes Radix + next-themes) | 31,6 KB (29 + next-themes) | −16,0 |
| `vendor-ui-rotas` (novo, lazy) | — | 17,2 KB (16 pacotes) | +17,2 |
| Entry (`index-*.js`) | 37,5 KB | 37,7 KB | +0,2 |
| **Boot** (fecho estático do entry, 50 chunks) | **286,4 KB** | **270,5 KB** | **−15,9 (−5,6 %)** |
| Boot + `Index` | 299,2 KB | 283,3 KB | −15,9 |
| 1ª tela staff (`StaffDashboard`) além do boot | 56,1 KB, sem Radix fora do boot | 56,1 KB, idem | 0 → total **−15,9** |
| 1ª tela cliente (`CustomerDashboard`) além do boot | 48,5 KB | 65,7 KB (puxa o `vendor-ui-rotas`) | +17,2 → total **+1,3** |
| Demais `vendor-*` | iguais (byte a byte, mesmos hashes) | | 0 |
| Ciclos entre chunks | 0 (DFS no grafo) / 0 avisos do Rollup | 0 / 0 | — |

Para referência, o Vite reporta `vendor-ui` 48,86 → 32,40 KB gz e `vendor-ui-rotas` 17,68 KB (gzip padrão).

**O que o shell usa:** 5 componentes Radix visíveis (dialog, alert-dialog, dropdown-menu, popover, tooltip)
mais o `slot`. O resto dos 29 pacotes do boot são as dependências internas deles (popper, focus-scope,
dismissable-layer…). Por isso a economia real é de 16 KB, e não os −35–45 KB do plano: o Codex tinha
razão em contestar o número. Os 16 que saíram do boot são accordion, checkbox, collapsible, label, progress,
radio-group, scroll-area, select, separator, slider, switch, tabs, toggle, toggle-group, number e
use-previous.

**Por que vale:** o staff (a maior parte do uso) baixa 15,9 KB a menos antes de o React montar, e nenhuma
tela piora para ele. O cliente cai os mesmos 16 KB no boot e os paga na 1ª tela: o `vendor-ui-rotas` baixa
junto do chunk da rota, que desde o lote 6 corre em paralelo ao auth. No total, o cliente baixa 1,3 KB a
mais (o custo do import entre os dois chunks). 147 dos 387 chunks importam o `vendor-ui-rotas`.

**Custo de cache:** neste Publish, os 147 chunks que importam o `vendor-ui-rotas` trocam de hash uma vez.
Depois disso, o hash do `vendor-ui-rotas` só muda quando sobe a versão do Radix ou quando um Radix passa a
ser usado pelo shell (aí os dois chunks e seus importadores mudam juntos, o que é raro).

## Verificação

`bun run build` antes e depois com exit 0; `bun run typecheck` com exit 0; `tsc -p tsconfig.node.json`
com exit 0 (o typecheck canônico não cobre o `vite.config.ts`); vitest dos 4 testes que leem o config/SW
(51 passaram); `eslint vite.config.ts` com exit 0. Smoke em `vite preview`: `/auth` monta sem erro no console
e carrega o `vendor-ui-rotas` sob demanda (a tela usa Tabs e Label). O `vendor-ui-rotas` fica **fora** do
modulepreload do `index.html` e **dentro** do precache do SW, então o offline-first continua valendo.

Método: um plugin descartável no `generateBundle` (rodado via API do Vite, sem tocar o config) gravou, por
chunk, os imports e os pacotes Radix. Atenção: o código no `generateBundle` ainda não é o final (o gz dava
29,8 KB contra os 37,5 KB do arquivo), então meça o gz pelo arquivo em `dist/`. E o build do SW
(injectManifest) também passa pelo plugin; filtre pelo chunk com fachada `index.html`.

**Reabrir se:** o boot voltar a importar algo do `vendor-ui-rotas` (confira no modulepreload do
`dist/index.html`), ou se o `vendor-ui-rotas` crescer a ponto de a tela do cliente pesar mais do que o
boot economiza. Nesse caso, a alternativa é deixar o Rollup partir o Radix das rotas, aceitando os
nomes genéricos de chunk.

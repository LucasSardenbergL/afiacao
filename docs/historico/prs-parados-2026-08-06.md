# O que envelhece num PR parado — #1332 e #1212, destravados em 2026-08-06

Os dois únicos PRs **não-draft** do repo estavam `CONFLICTING` e por isso o auto-merge nunca disparou: o [#1332](https://github.com/LucasSardenbergL/afiacao/pull/1332) (WhatsApp PR-4, proposta 1-toque) parado desde 14/07 com o `validate` **verde**, e o [#1212](https://github.com/LucasSardenbergL/afiacao/pull/1212) ([faxina knip](faxina-knip-2026-07-07.md)) desde 07/07 **sem nenhum check rodado**. Resolver os conflitos merged os dois no mesmo dia (`250754cd` e `89580a2f`).

A lição não é "resolva conflito mais rápido". É que **o PR parado não espera igual a si mesmo** — ele apodrece de duas formas *opostas*, e as duas apareceram aqui, uma em cada PR.

## Forma 1 — a regra nasce depois do código (#1332, 415 commits atrás)

O merge da `main` fez o código de **julho** encontrar gates estruturais criados em **agosto**. Dois reprovaram, e os dois apontavam defeito real — não formalidade de linter:

- **`leitura-single-shot-gate`** (classe #1338→#1598): em [`RotaPropostas.tsx`](../../src/pages/RotaPropostas.tsx), a consulta que descobre o dono da conversa de WhatsApp descartava o `error`. Falha virava `donoConversa = null`, e `null` **apaga** a trava `conversa_de_outro_cliente` — a proposta com preços sairia no fio de outro cliente, que é exatamente o caso (telefone compartilhado/reutilizado) que a trava existe para cobrir. É "ausente ≠ zero" valendo dinheiro e LGPD. Fix: `throw`, o mesmo tratamento que a cotação recebe três linhas acima. Trade-off assumido: falha na checagem do elo derruba a proposta inteira em vez de travar só a linha — fail-closed, e sem inventar um `MotivoTravaGeral` novo que o avaliador e os testes não conhecem.
- **`erro-object-object-gate`** (classe #1642→#1661): dois `e instanceof Error ? e.message : 'erro desconhecido'` nos toasts de recotação e envio. O `error` do supabase-js é objeto **plano**, não `Error` → a recusa da RPC/RLS caía no literal e morria calada. Fix: `mensagemDeErro(e) ?? 'erro desconhecido'`.

O detalhe que importa: **o `validate` do #1332 estava verde havia três semanas**. Verde de 14/07 não é verde de hoje — ele atesta o código contra as regras que existiam quando rodou. Um PR que dorme carrega um selo de aprovação com data de validade, e ninguém avisa quando vence.

## Forma 2 — a intenção inverte de sinal (#1212, 566 commits atrás)

Um PR de dead code é o caso extremo: sua premissa é uma afirmação sobre o **resto do repo** ("ninguém usa isto"), e o resto do repo se mexe. Em 4 dos 8 conflitos a `main` já tinha feito a mesma faxina por outro caminho, e num deles a premissa virou do avesso:

| Símbolo | Julho | Agosto | Resolução |
|---|---|---|---|
| `getPosthog`, `clearOfflineQueue`, `useCustomerOrders`, `backfill-helpers.ts` | dead code | **já removidos pela main** | main (deleção supera des-exportação) |
| `classifyProfile` | dead export | main **des-exportou e corrigiu bug** (`null < 20` é `true` em JS: sem o guard, todo cliente de gasto baixo e margem não apurada saía rotulado "sensível a preço" — e o rótulo entra no prompt da IA) | main |
| `AuthRequiredError` | dead export | segue sem consumidor externo | PR (des-exportado) |
| **`EdgeFunctionError`** | dead export | **6 consumidores** + campos novos `status`/`retryAfterSeconds` (distinguir cota estourada de falha transitória) | **main — o `export` fica** |

Aplicar a intenção original de `EdgeFunctionError` **quebraria o build**. O mesmo arquivo precisou de resolução dividida: uma classe des-exportada, a outra não.

O árbitro certo aqui é mecânico e barato: `bun run typecheck` (strict, com `noUnusedLocals`) prova des-exportação indevida em um passe. Resolver na leitura e conferir no tsc — não o contrário. Sobra do PR sobre a `main` de hoje: **116 arquivos / 821 deleções** (era 132 / 990) — a faxina seguia majoritariamente relevante, mas 12% dela tinha virado no-op.

## Forma 3 — a regra nasce 2 minutos antes, e nenhum dos dois CIs vê o outro

A forma mais aguda apareceu **como consequência deste próprio trabalho**, e derrubou a `main` por ~5 horas:

| Hora (UTC) | Evento |
|---|---|
| 13:50:14 | **#1670** mergeia — nasce o gate de índice de `docs/` |
| 13:52:29 | **#1212** mergeia — traz `faxina-knip-2026-07-07.md`, escrito em 07/07, **sem linha no índice** |
| 18:43:09 | **#1674** conserta a `main` vermelha, adicionando a linha |

**135 segundos** separam o gate do arquivo que ele reprova. Os dois PRs eram verdes *isoladamente* e se contradizem *somados*: o #1670 não podia ver um arquivo que só entraria depois, e o #1212 rodou seu `validate` contra uma base onde o gate ainda não existia — a suíte local que rodei no merge também não o tinha. Não é conflito de texto (o git mescla sem reclamar), é **conflito semântico**.

Vale reparar que é a Forma 1 outra vez, mas com a defasagem colapsada de três semanas para dois minutos — o que mostra que o problema nunca foi o PR estar *velho*. Um PR de 5 minutos corre o mesmo risco; a idade só aumenta a chance.

**O mecanismo já estava documentado** — no cabeçalho do próprio [`ci.yml`](../../.github/workflows/ci.yml) (medido em 2026-07-21, com o exemplo hipotético do `edges:typecheck`: "PR A remove um export de `_shared/`, PR B adiciona um import dele — cada um passa, juntos dão TS2305"). Este incidente é a instância concreta dele, e acrescenta duas coisas:

- **A janela real de exposição.** `merge de PR não dispara CI na main`: o `auto-merge.yml` usa `secrets.GITHUB_TOKEN` e a proteção anti-loop do GitHub impede que esse push acione workflows. Então `gh run list --branch main` **não serve** para conferir — o último run de `push` na main é de 31/07, semanas antes destes merges. A contramedida existente é o `schedule` diário (09:17 UTC), que pegaria isto **na manhã seguinte**: aqui a `main` quebrou às 13:52 e ficou vermelha ~5h até alguém tropeçar nela por outro caminho (#1674) — dentro do previsto pelo desenho, que assume "piso útil: pega no dia seguinte".
- **A ferramenta certa, que já existe e eu não usei**: o `workflow_dispatch` do CI (aba Actions → CI → *Run workflow*), posto lá exatamente para *"confirmar a main na hora depois de uma leva de merges"*. Um clique, ~5 min, e o sinal aparece no dia — não no seguinte.

O que reduz o dano, na ordem: **(a)** depois de uma leva de merges, disparar o `workflow_dispatch` do CI na `main` (`gh workflow run CI --ref main`) — não adianta consultar runs de push, eles não existem; **(b)** quando o PR adiciona *arquivo* de uma categoria gateada (`docs/`, `src/` sob o `manifesto.gate`, migrations), conferir se algum PR **recém-mergeado** criou gate novo sobre ela; **(c)** ao entregar um gate estrutural, varrer os PRs **abertos** por violações que já existem neles — o gate nasce sabendo o que a `main` tem, não o que está a caminho.

## Artefato gerado não se resolve, se regenera

Os 2 conflitos do #1332 eram `docs/migrations-audit.md` e `scripts/audit-custom-migrations.sql` — **saída idempotente** de `bun run audit:migrations`. Escolher lado ali é errado nos dois sentidos (perde as migrations da main ou as do PR). Rodar o gerador sobre a árvore já mesclada deu o inventário correto: 626 migrations = 624 da main + 2 do branch, conferido com `comm -23` contra `git ls-tree origin/main` para provar que nenhuma da main se perdeu.

## `edges:typecheck` reprova por falta de rede — e isso é desenho

O `validate` do #1212 falhou na primeira tentativa com `Import 'https://esm.sh/@supabase/supabase-js@2.112.2/dist/index.d.mts' failed: 500 Internal Server Error`. É o único step do CI que **sai para a rede** ([ci-testes-edge-deno.md](ci-testes-edge-deno.md)), e ele bloqueia de propósito — a própria mensagem cita o CLAUDE.md: *"não conseguir checar não é o mesmo que estar limpo"*.

O que separa isso de um defeito real é evidência lateral, não fé: **o mesmo step passou no #1332 vinte minutos antes**. Rerun do job (`gh run rerun <id> --failed`) → verde em 6m43s. Antes de re-rodar um step vermelho, ache o passe vizinho que prova que a causa é ambiental; sem ele, rerun é só apagar o sinal.

## Verificação

| Gate | #1332 | #1212 |
|---|---|---|
| `typecheck` | 0 erros | 0 erros |
| `lint` | 0 errors (72 warnings, patamar da main) | 0 errors (70 warnings) |
| `test` (vitest) | 259 testes dos 12 arquivos de gate | 650 arquivos / 5940 testes |
| `test:edges` (Deno) | n/a — não toca `supabase/functions/` | 613 testes |
| CI `validate` | pass | pass (6m43s, após rerun) |

## Deploy — o merge não terminou a entrega

- **#1332**: migration custom `20260713050000_whatsapp_proposta_cotacao_v2.sql` no SQL Editor (só a **v2**: é `CREATE OR REPLACE` da mesma assinatura da v1 e traz junto o `ALTER TABLE sales_orders` + o índice único de dedupe) + Publish do frontend. Nenhuma edge.
- **#1212**: **nada a aplicar**. Toca um único arquivo sob `supabase/` e a mudança é `export type` → `type` — tipo TypeScript, apagado na compilação, zero efeito em runtime.

## Prática que sai daqui

1. **PR não-draft em conflito é um PR que ninguém está segurando de propósito** — o freio do repo é o draft ([CLAUDE.md](../../CLAUDE.md), §Merge). Conflito não é freio, é esquecimento. Varrer `gh pr list --json mergeable` acha os que caíram nessa.
2. **CI verde antigo não vale como validação** — re-rode depois do merge da `main`, sempre.
3. **Depois de uma leva de merges, valide a `main` de propósito** — `gh workflow run CI --ref main`. O verde do PR atesta a base do momento do *run*, e entre ele e o merge cabe outro PR que muda a régua (aqui coube em 135s). Consultar runs de push **não** funciona: o auto-merge usa `GITHUB_TOKEN` e o push dele não aciona workflow nenhum.
3. **PR de dead code tem prazo de validade curto**: a premissa é sobre o repo inteiro. Se passou de algumas semanas, o barato é medir de novo (`typecheck` + `knip`), não confiar na lista original.
4. **Antes do rerun de step vermelho, procure o passe vizinho.** Sem evidência de que a causa é ambiental, rerun apaga sinal em vez de destravar.

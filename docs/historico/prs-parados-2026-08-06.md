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
3. **PR de dead code tem prazo de validade curto**: a premissa é sobre o repo inteiro. Se passou de algumas semanas, o barato é medir de novo (`typecheck` + `knip`), não confiar na lista original.
4. **Antes do rerun de step vermelho, procure o passe vizinho.** Sem evidência de que a causa é ambiental, rerun apaga sinal em vez de destravar.

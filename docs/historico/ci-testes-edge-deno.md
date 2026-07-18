# CI — os 119 testes Deno das edges que rodavam em lugar nenhum

**Entrega:** PR #1437 (2026-07-18). Descoberto durante a correção do N+1 da edge `monthly-report` (PR #1432).

## O achado

`supabase/functions/**/*_test.ts` tinha **119 testes** e um script pronto no `package.json`
(`test:edges`). O job `validate` **nunca os chamou**: o passo de teste é vitest, cujo `include`
(`vitest.config.ts`) é só `src/**` + `scripts/**`. `grep -rn "deno" .github/workflows/` = zero.

Eram **documentação executável, não guarda de regressão**. Um PR podia quebrá-los com o CI verde —
e como todo PR não-draft auto-mergeia no verde, a regressão entrava sem olho humano. O caso que
motivou: os invariantes de CUSTO de `_shared/relatorio-mensal_test.ts` existem para impedir que o
N+1 de ~5.285 consultas volte, e não impediriam nada.

## Três decisões, cada uma resolvida por evidência (não por analogia)

**1. Step no `validate`, não job paralelo.** A branch protection exige **só `validate`**
(`gh api repos/:owner/:repo/branches/main/protection` → `contexts: ["validate"]`), e o
`auto-merge.yml` mergeia quando ele passa. Um job paralelo ficaria verde-informativo e **não
barraria nada** — reproduziria o próprio bug que o PR conserta. Para promover um job paralelo a
gate seria preciso mexer na branch protection no GitHub, à mão.

**2. Pin estrito `2.9.2`, mas SEM espelhar o gate `bunpin:check`.** Esta é a lição transferível: **o
raciocínio de um gate não transfere só porque a situação parece análoga.** O gate do bun existe
porque a `oven-sh/setup-bun` *pula* a `api.github.com` quando o valor casa `validateStrict()` — o
formato estrito **elimina** um request. Lendo o fonte da `denoland/setup-deno`, não há esse
fast-path: com `2.9.2` ela cai em `resolveRelease(range)` → `fetch("https://dl.deno.land/versions.json")`;
com `latest`, em `release-latest.txt`. **Mesma rede nos dois casos.** Um gate espelhado não removeria
um request sequer — só criaria falsa segurança e mais superfície para manter. O pin fica por
**reprodutibilidade** (o runtime não muda sozinho num PR alheio), não anti-SPOF. O `ci.yml` registra
isso no step, para a próxima sessão não "consistentizar" e criar o gate inútil.

**3. `--no-remote`: a suíte é offline por invariante.** Achado não previsto na tarefa:
`deno test --no-remote` **falhava**. `omie-sync-status-produtos/paginacao.test.ts` importava
`jsr:@std/assert@1` — único dos 11 arquivos fora do padrão (os outros 10 já usavam helper local).
Do jeito original, o PR poria **jsr.io no caminho de entrega de todo PR do repo**: a mesma forma do
incidente de 2026-07-16, em que a degradação da REST API do GitHub derrubou todo PR em ~6s. Trocado
por helper local, e o `--no-remote` entrou **dentro do `test:edges`** para a invariante se
auto-vigiar (local e CI) em vez de virar comentário que ninguém lê.

> **Regra viva:** teste de edge **não pode ter import remoto**. Se precisar de `npm:`/`jsr:`, a saída
> é extrair a lógica **pura** e testar ela — o que os 11 arquivos já fazem —, não afrouxar o flag.

## Falsificação

O `assertRejects` caseiro que substituiu o do `@std` foi falsificado nos **3 eixos**, porque um
try/catch frouxo passaria com um `TypeError` de código quebrado — o mesmo teatro que o CLAUDE.md
condena no `WHEN OTHERS THEN 'OK'`:

| Sabotagem | Resultado |
|---|---|
| Guard lança **mensagem errada** (`anti-loop` → outra) | ✅ vermelho |
| `throw new Error(` → `throw String(` (**classe errada**) | ✅ vermelho |
| `assertRejects` com promise que **resolve** | ✅ vermelho |

E o gate em si: commit de sabotagem empurrado com o PR em **draft** (quebrando 1 teste Deno e nada
mais — `src/` intocado, então typecheck/vitest/build seguiam verdes), para ver o `validate` ficar
**vermelho no GitHub de verdade**, não só local. Depois revertido.

## Duas armadilhas de método que custaram retrabalho aqui

- **`git checkout -- <arquivo>` numa falsificação reverte a edição não-commitada junto.** Sabotar
  arquivo que já tem mudança sua apaga a mudança. Commite **antes** de falsificar, ou sabote um
  arquivo que você não editou.
- **Glob de teste que não casa nada sai 0 e parece verde.** `deno test paginacao.ts*` rodou zero
  testes e reportou sucesso. Numa falsificação, "passou" quando você esperava vermelho é sinal de
  **prova inválida**, não de código bom — confira que o alvo casou antes de acreditar no resultado.

## Fora de escopo (deliberado)

`deno lint` **não** entrou. Medido na main: **198 problemas em 124 arquivos**, 8 regras distintas:

| Regra | Qtd | Natureza |
|---|---|---|
| `no-import-prefix` | 141 | imports `npm:`/`jsr:`/`https:` — padrão **obrigatório** de edge Supabase; puro ruído |
| `no-unused-vars` | 19 | código morto |
| **`no-unreachable`** | **16** | **código inalcançável — o único grupo que pode esconder bug real** |
| `no-explicit-any` | 6 | dívida de tipo (no `src/` essa dívida já foi zerada) |
| `ban-ts-comment` | 6 | idem |
| `no-var` / `no-inner-declarations` / `require-await` | 4/4/2 | estilo |

Ligar o lint hoje seria 198 vermelhos, dos quais 141 são o padrão que a plataforma **exige** — ruído
que treina a ignorar o sinal. O caminho é configurar `no-import-prefix` como exceção e então tratar
o resto. **Os 16 `no-unreachable` merecem uma passada própria** — código depois de `return`/`throw`
em edge costuma ser guard que alguém achou que estava rodando e não está.

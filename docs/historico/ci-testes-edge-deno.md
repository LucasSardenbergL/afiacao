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
| `no-explicit-any` | 6 | **já governados pelo ESLint** — ver nota abaixo |
| `ban-ts-comment` | 6 | idem |
| `no-var` / `no-inner-declarations` / `require-await` | 4/4/2 | estilo |

Ligar o lint hoje seria 198 vermelhos, dos quais 141 são o padrão que a plataforma **exige** — ruído
que treina a ignorar o sinal. O caminho é configurar `no-import-prefix` como exceção e então tratar
o resto. **Os 16 `no-unreachable` merecem uma passada própria** — código depois de `return`/`throw`
em edge costuma ser guard que alguém achou que estava rodando e não está.

> ⚠️ **Nota (2026-07-18, PR #1432): não leia esta tabela como "as edges estão fora do lint".** O
> `bun lint` (= `eslint .`) **cobre `supabase/functions/`** — de tudo que está lá, o `ignores` do
> `eslint.config.js` exclui só `functions/mcp/**` (bundle auto-gerado, sem `any`) — e aplica
> `tseslint.configs.recommended`, onde `no-explicit-any` é ERROR. Os 6
> acima aparecem aqui justamente porque carregam `// eslint-disable-next-line @typescript-eslint/no-explicit-any`:
> silenciam o ESLint e **não** o deno lint. A recíproca mordeu no #1432 — `// deno-lint-ignore
> no-explicit-any` deixou o `deno lint` limpo e o CI vermelho com 4 erros. **Cada linter só enxerga o
> seu próprio comentário de supressão**, então nenhum dos dois, sozinho, prova o outro. Regra prática
> em `docs/agent/deploy.md` → "Edge — armadilhas".

---

# Sequela (2026-07-21): o `test:edges` rodava — e mesmo assim nenhuma edge era type-checada

Plugar os testes no CI **não** fechou o buraco de tipos. `deno test` só type-checa o grafo que os
testes **alcançam**, e por desenho os 15 arquivos de teste cobrem **lógica pura extraída** —
justamente para caber no `--no-remote`. Nenhum `index.ts` de edge é importado por teste algum, então
nenhum entrava no grafo. Com `typecheck` cobrindo só `src/` e o ESLint não type-checando Deno, **erro
de tipo em edge ficava verde nos quatro gates** e só quebrava em runtime na produção, depois do
deploy manual pelo Lovable.

Detectado no PR #1498: `classifyProfile` usado sem estar no import em `generate-tactical-plan`
sobreviveu a 5.527 testes vitest, 181 testes deno, typecheck e lint. Só apareceu num `deno check`
manual. Fechado pelo step `edges:typecheck` (`scripts/edges-typecheck-gate.ts`).

**A tensão com o `--no-remote` é real e não teve como evitar.** `deno check` precisa resolver o grafo
de verdade — 2.245 downloads, ~48s cold / ~2,5s warm. O que dá para dizer com número: dos 3 hosts,
`registry.npmjs.org` (2.087 requests) **já** está no caminho de entrega via `bun install`; os novos
são `esm.sh` (135) e `deno.land` (23), ambos vindos de import legado. Migrar as duas famílias
(follow-up) zera os hosts novos.

**Diff-only foi medido e descartado:** checar *uma* edge custa 14–16s e ~2.000 requests — quase o
mesmo que checar as 93. Quase toda edge importa `@supabase/supabase-js`, que sozinho arrasta ~2.000
`.d.ts`; as outras 92 custam ~245 requests marginais. O diff economizaria tempo e **zero** do SPOF.

## Quatro armadilhas medidas (deno 2.9.2)

- **`deno check` cru não roda neste repo.** O `package.json` da raiz põe o Deno em modo node_modules
  e ele **aborta na resolução**, antes de type-checar. Exige `--node-modules-dir=none` — que por
  sinal é mais fiel ao Edge Runtime do Supabase. O `--no-remote` do `test:edges` corta antes e por
  isso nunca esbarrou nisso.
- **Com 1 erro só, o Deno OMITE a linha `Found N errors.`** Usá-la como marcador de "rodou" deixa o
  gate cego exatamente no caso de 1 erro — a forma típica de símbolo faltando no import. O marcador
  confiável é `error: Type checking failed.`
- **Com o cache de check quente, a saída é vazia e exit 0.** "Saída vazia" é o caso de **sucesso**
  normal, não anomalia — a decisão tem que pender do exit code, nunca do volume de saída.
- **Glob de edge expandido pelo shell diverge entre shells:** zsh aborta com "no matches found",
  bash passa o glob literal. Um glob que não casa nada viraria verde silencioso — a mesma família do
  "glob de teste que não casa nada" logo acima. O gate enumera em TypeScript e trata 0 edges como
  **falha**.

## Por que o gate é de precisão, não de recall

Medido na main de 2026-07-21: **141 erros de tipo em 25 das 93 edges** (68 limpas). Quase todos são
ruído dos tipos gerados do Supabase — `does not exist on type 'never'`, `@ts-expect-error` obsoleto,
e 17 `SupabaseClient not assignable` causados por `@supabase/supabase-js` aparecer em **6 versões
distintas** nas edges. Código que roda.

Já a classe que **quebra em runtime** — símbolo/módulo/membro que não resolve (`TS2304` `TS2552`
`TS2307` `TS2305` `TS2724` `TS2503`) — está em **zero nas 93**. Gatear só nela dá um gate verde hoje
**sem allowlist nenhuma**, cobrindo inclusive as 25 sujas e as de money-path.

A alternativa (check completo + denylist das 25) excluiria justamente `fin-cashflow-engine`,
`enviar-pedido-portal-sayerlack`, `omie-financeiro` e `recommend` — **o gate protegendo onde o risco
é menor** — além de criar um arquivo-lista que vira ímã de conflito entre as worktrees paralelas.
Apertar para check completo é o destino natural, depois que a dívida encolher.

## Follow-ups (medidos)

1. Consolidar `@supabase/supabase-js` numa versão só (hoje 6) — corta download e resolve 17 dos 141.
2. Migrar `deno.land/std/http/server.ts` → `Deno.serve` (34 edges) e `esm.sh/@supabase/supabase-js` →
   `npm:` (18 edges). Deixa `registry.npmjs.org` como host único.
3. Zerar as 25 edges sujas e apertar o gate para check completo.
4. Versionar `deno.lock` (hoje no `.gitignore`) — reprodutibilidade + chave de cache estável.

Spec: `docs/superpowers/specs/2026-07-21-edges-typecheck-gate-design.md`

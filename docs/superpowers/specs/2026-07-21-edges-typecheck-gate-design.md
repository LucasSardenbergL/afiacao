# Gate de type-check das edge functions no CI — design

**Data:** 2026-07-21 · **Motivador:** PR #1498 · **Escopo:** `.github/workflows/ci.yml` (job `validate`), `scripts/`, `package.json`

## O buraco

Nenhum gate do repo type-checa as edge functions:

| Gate | Cobre | Por que não pega edge |
|---|---|---|
| `bun run typecheck` | `src/` + testes | `tsconfig.app.json` não inclui `supabase/functions/` |
| `bun run test` (vitest) | `src/`, `scripts/` | `include` do `vitest.config.ts` |
| `bun run test:edges` (deno) | edges **importadas por teste** | nenhuma `*/index.ts` é importada por teste algum |
| `bun lint` (eslint) | `src/` | não type-checa; não roda em Deno |

`deno test` só type-checa o grafo que os testes alcançam. Como os 15 arquivos de teste testam **lógica pura extraída** (por desenho — ver `docs/historico/ci-testes-edge-deno.md`), nenhum `index.ts` entra no grafo. Resultado: erro de tipo numa edge passa verde em todos os gates e só quebra em **runtime na produção**, depois do deploy manual pelo chat do Lovable.

Detectado no PR #1498: `classifyProfile` usado sem estar no import em `generate-tactical-plan/index.ts` passou por 5.527 testes vitest, 181 testes deno, typecheck e lint. Só apareceu num `deno check` manual.

## Medição (Deno 2.9.2 — mesmo pin do CI; feita em 2026-07-21)

| Métrica | Valor |
|---|---|
| Edges (`supabase/functions/*/index.ts`) | 93 |
| `deno check` **cold** (DENO_DIR virgem) | **48s** · 2.245 downloads · 681 MB |
| `deno check` **warm** | **2,5s** |
| Custo de **uma** edge cold | 14–16s · ~2.000 downloads · 617 MB |
| Erros de tipo hoje | **141**, em **25 das 93** edges (68 limpas = 73%) |
| Erros da classe "não resolve" (TS2304/2552/2307/2305/2724/2503) | **0** |
| Hosts | `registry.npmjs.org` 2.087 · `esm.sh` 135 · `deno.land` 23 |

### Três descobertas que fixaram a forma

**1. `deno check` não roda cru neste repo.** Aborta na *resolução*, antes de type-checar: o `package.json` da raiz põe o Deno em modo node_modules e `npm:@simplewebauthn/server@10.0.1` (usado por `biometric-auth`) não está lá. Exige `--node-modules-dir=none` — que por sinal é mais fiel ao Edge Runtime real do Supabase, que resolve `npm:` do próprio registry sem node_modules. O `test:edges` nunca esbarrou nisso porque `--no-remote` corta antes.

**2. Diff-only não compensa.** Checar *uma* edge custa 14–16s e ~2.000 requests — quase o mesmo que checar as 93 (48s, 2.245). Quase toda edge importa `@supabase/supabase-js`, que sozinho arrasta ~2.000 `.d.ts` transitivos; as outras 92 custam ~245 requests marginais. O diff economizaria ~2/3 do tempo e **zero** do SPOF de rede, ao custo de lógica de diff frágil (base ausente no push da main; mudança em `_shared/` afeta muitas edges). Descartado.

**3. Dos 3 hosts, só 2 são novos no caminho de entrega.** `registry.npmjs.org` (2.087 dos 2.245 requests) já é usado pelo `bun install --frozen-lockfile`. Novos: `esm.sh` (135) e `deno.land` (23), ambos vindos de import legado — 34 edges em `https://deno.land/std@*/http/server.ts` (o `Deno.serve` nativo do Deno 2 substitui) e 18 em `https://esm.sh/@supabase/supabase-js@*` (tem equivalente `npm:`). Migrar zeraria os hosts novos → **follow-up**, não este PR (mexeria em ~50 edges que só deployam manualmente).

> ✅ **Feito em 2026-08-07** (#1685/#1687/#1690/#1694): os dois hosts estão em **0 imports**. Sobrou `registry.npmjs.org`, que já estava no caminho de entrega. O gatilho foi o #1670 — uma PR só de documentação derrubada por um 500 do `esm.sh`. A tabela de hosts acima é a medição de 2026-07-21 e fica como registro da época.

### Dívida pré-existente: existe, mas não é a classe perigosa

Os 141 erros são quase todos ruído dos tipos gerados do Supabase — `Property 'x' does not exist on type 'never'`, `@ts-expect-error` obsoleto (13), e `SupabaseClient not assignable` (17). Código que **roda bem**.

> ⚠️ **Correção (2026-08-07):** este parágrafo dizia que o `SupabaseClient not assignable` tinha *"causa identificada"* — as **6 versões distintas** de `@supabase/supabase-js` fluindo para os helpers. **A hipótese foi testada e refutada.** A série #1685/#1687/#1690/#1694 consolidou o repo inteiro em `npm:@supabase/supabase-js@2` — especificador único, uma versão no grafo — e a classe `TS2345` saiu em **36, o mesmo número de antes**, com os 136 tolerados idênticos classe por classe nos quatro PRs. O espalhamento de versão custava **download**, não este erro. A causa segue **desconhecida**; quem for atacá-la comece por `bun run edges:typecheck --json`, que traz as mensagens (o resumo do gate não as guarda). Detalhe em `docs/historico/ci-testes-edge-deno.md` §Sequela (2026-08-07).

A classe que de fato crasha em runtime — símbolo ou módulo que não resolve, a do #1498 — está em **zero nas 93 edges**. É isso que permite um gate sem allowlist nenhuma.

## Desenho

### Componente 1 — `scripts/edges-typecheck-gate.ts`

Casa o idioma de `authz-gate-check.ts` / `bun-pin-gate-check.ts`: `#!/usr/bin/env bun`, só builtins, cabeçalho explicando o porquê.

**Enumera o glob em TypeScript** (`readdirSync`), não no shell. Motivo: zsh aborta com "no matches found" e bash passa o glob literal — comportamentos diferentes, e um glob que não casa nada viraria verde silencioso. Se a enumeração der 0 arquivos, o gate falha.

**Classes bloqueantes** (6): `TS2304` `TS2552` `TS2307` `TS2305` `TS2724` `TS2503` — "cannot find name/module/namespace" e "has no exported member". Todas significam que o runtime quebra ao executar aquele caminho.

**Classes toleradas:** as demais. Reportadas na saída como dívida conhecida, sem falhar.

**Decisão fail-closed** (a parte que mais importa):

| `deno check` | Saída contém `error: Type checking failed.` | Veredito |
|---|---|---|
| exit 0 | — | **passa** (com cache quente a saída é *vazia*; isso é sucesso normal, não anomalia) |
| exit ≠ 0 | sim | parseável → classifica; bloqueia só se houver classe-crash |
| exit ≠ 0 | não | **bloqueia** — infra/rede/resolução. Não conseguir checar ≠ estar limpo. |

O marcador é `error: Type checking failed.`, **não** `Found N errors.`: com exatamente 1 erro o Deno omite a linha de contagem (verificado empiricamente). Usar a contagem como marcador deixaria o gate cego justamente no caso de 1 erro — que é a forma típica do #1498.

Parse em TypeScript, não em `grep`: imune ao shim `ugrep` e à dobra de acento por locale que produziu o falso-verde do #1483.

### Componente 2 — `scripts/edges-typecheck-gate.test.ts`

A função de classificação é **pura** (recebe `stdout` + `exitCode`, devolve veredito) e testada offline no vitest, que já inclui `scripts/**/*.test.ts`. Fixtures são saída **real** capturada em 2026-07-21:

1. **baseline** — 141 erros, 0 classe-crash → espera `passa`
2. **sabotado** — `TS2304 Cannot find name` numa edge limpa, sem linha `Found N` → espera `bloqueia`
3. **sabotado em edge suja** — classe-crash isolada no meio de 11 erros tolerados → espera `bloqueia`
4. **resolução** — `Could not find a matching package` do `biometric-auth`, sem `Type checking failed` → espera `bloqueia` (infra)
5. **vazio + exit 0** — cache quente → espera `passa`
6. **vazio + exit ≠ 0** — rede caiu sem mensagem → espera `bloqueia`

É a lição do `ci-testes-edge-deno.md` aplicada: o teste não pode ter dep remota, então extrai-se a lógica pura e testa-se ela.

### Componente 3 — `ci.yml` + `package.json`

Step novo logo após `Tests (edge functions — Deno, offline)`: o Deno já está instalado (setup zero) e PR quebrado no comum falha antes de pagar os ~48s de rede — mesma lógica que o `test:edges` já documenta.

`package.json`: `edges:typecheck` novo. O `typecheck:edges` atual (cobre 2 edges, não roda em lugar nenhum) é **substituído** por ele.

**Sem `actions/cache`:** o DENO_DIR é 681 MB (677 são tarballs npm). Economizaria ~30s dos 48s consumindo ~7% do budget de 10 GB do repo, mais drift de chave — e não há `deno.lock` versionado (está no `.gitignore`) para chavear. `--no-lock` evita que o check escreva um lock de 297 KB na raiz.

### Componente 4 — doc

Lição em `docs/historico/ci-testes-edge-deno.md` (o doc que já conta a história do `--no-remote`), com os números medidos e os follow-ups.

## O que este gate NÃO cobre (explícito)

Erros de tipo reais das outras classes — um `TS2345` novo numa edge limpa passa. É recall trocado por precisão e por não ter allowlist: a alternativa (check completo com denylist das 25 sujas) excluiria justamente `fin-cashflow-engine`, `enviar-pedido-portal-sayerlack`, `omie-financeiro` e `recommend` — money-path — deixando o gate protegendo onde o risco é menor, além de criar um arquivo-lista que vira ímã de conflito entre as ~30 worktrees paralelas.

Apertar para check completo é o destino natural, depois que a dívida encolher.

## Follow-ups (medidos, não especulativos)

> O título envelheceu mal, e vale dizer por quê: o item 1 juntava uma medição (*"corta download"*) com uma **previsão** (*"resolve 17 dos 141"*) na mesma frase, sem separar as duas. Executado em 2026-08-07, a medição se confirmou e a previsão não. Previsão dentro de uma lista chamada "medidos" é lida como fato pelo próximo agente — a lição está em `docs/historico/ci-testes-edge-deno.md` §Sequela (2026-08-07).

1. ~~**Consolidar `@supabase/supabase-js` numa versão** — hoje 6. Corta download e resolve 17 dos 141 erros de uma vez.~~ ✅ **feito** (#1694): repo inteiro em `npm:…@2`. Cortou download; **não** resolveu os 17 — ver a correção na §"Dívida pré-existente".
2. ~~**Migrar `deno.land/std/http/server.ts` → `Deno.serve`** (34 edges) e **`esm.sh/@supabase/supabase-js` → `npm:`** (18 edges).~~ ✅ **feito** (#1685/#1687/#1690): os dois hosts em 0 imports, `registry.npmjs.org` como host único.
3. **Zerar as 25 edges sujas** e então apertar o gate para check completo. Comece sabendo que consolidar versão **já foi tentado e não move o `TS2345`**.
4. **Versionar `deno.lock`** — reprodutibilidade + habilita chave de cache estável, caso o custo de rede vire problema. **Subiu de prioridade em 2026-08-07:** com o repo inteiro em range (`@2`, não pin), o lock virou o *único* lugar que prende a versão resolvida. Atenção ao escopo real: o gate roda `--no-lock` explícito (`scripts/edges-typecheck-gate.ts`), então versionar o arquivo sozinho não tem efeito — são duas mudanças acopladas, e tirar o `--no-lock` cria um modo de falha novo (PR vermelho por lock defasado, não por código errado).

## Validação de aceite

- [ ] Gate verde na `main` atual (0 classe-crash em 93/93) — evidência: exit 0
- [ ] Falsificação ponta-a-ponta: sabotar edge real → vermelho; restaurar → verde
- [ ] Falsificação da falha de infra: simular saída não-parseável → vermelho
- [ ] Teste do parser passa no vitest, offline
- [ ] `bun run typecheck`, `bun lint`, `bun run test` verdes

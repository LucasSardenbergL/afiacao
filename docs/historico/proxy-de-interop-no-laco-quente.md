# O `it` mais lento da suíte pagava um trap de Proxy por chamada — e 2/3 do que parseava não podia ter sítio

**Data:** 2026-09-26 · **Alvo:** o `it` de auto-ocultação de `src/__tests__/erro-colapsado-em-vazio-gate.test.ts` · **Detector:** `src/lib/gates/erro-colapsado-em-vazio.ts` · **Substrato:** job `testes` do CI + vitest real local

## Como o alvo foi achado

Nos três runs mais recentes do job `testes` na main, parseados contra os totais do próprio vitest (843
arquivos, 9.293–9.294 testes em cada um), o teste individual mais lento foi o mesmo:

| run da main | `it` de auto-ocultação | 2º colocado |
|---|---|---|
| `0f07e0a` | 2.560ms | 1.669ms (`authz-gate-check`) |
| `cea32f0` | 2.609ms | 1.735ms (`authz-funcoes`) |
| `b9afcd8` | 3.453ms | 2.379ms (`authz-gate-check`) |

O arquivo mais lento continua sendo o `scripts/exclusividade-medir.test.ts` (~20–21,6s), mas espalhado por
33 testes e hooks — nenhum `it` dele passa de 1,42s ([teste-mais-lento-dormia-sem-asserir.md](teste-mais-lento-dormia-sem-asserir.md)).

## Por que era lento — e a maior parte não era o detector

O #2550 concluiu que "o custo é o parse em si, e só um detector mais rápido o reduz". Medido por camada,
com processo frio (o `it` paga a 1ª passada, com JIT frio), o mesmo trabalho sobre as 1.489 fontes
(~9,0 milhões de caracteres) custa:

| onde | ms |
|---|---|
| Node puro — só `createSourceFile`, sem parents | ~970 |
| Node puro — com `setParentNodes` | ~1.290 |
| Node puro — o detector inteiro | ~1.650 |
| vitest isolado — o `it` | ~3.000 |

A diferença de ~1,3s entre Node puro e vitest — a mesma que o #2311 registrou sem causa ("2,05 ms/fonte
fora do runner · 3,32 isolado") — é o **Proxy de interop do vite-node**. Um CJS externalizado (o
`typescript` é CJS) chega ao módulo embrulhado num `Proxy` com trap `get` (`interopedImport`, em
`vite-node/dist/client.mjs`), e o transform SSR reescreve cada referência `ts.x` como
`__vite_ssr_import_0__.default.x`. O dump do módulo transformado (`VITE_NODE_DEBUG_DUMP=true`) mostrou os
54 pontos de chamada assim. Como as caminhadas chamam `ts.is*`/`ts.forEachChild` por nó da AST, são
milhões de traps por varredura.

E 952 das 1.489 fontes (47% dos caracteres, inclusive os 664 KB do `types.ts` do Supabase) não têm como
conter sítio — e eram parseadas mesmo assim.

## O conserto

1. **`import ts = tsInterop`.** O alias do TypeScript carrega valor E namespace: os 26 usos de tipo
   (`ts.Node`, `ts.Expression`…) seguem compilando e os 54 de valor não mudam. SWC e esbuild emitem
   `const ts = tsInterop`, então o Proxy é lido uma vez, na carga do módulo. O `const ts = tsInterop`
   óbvio quebra o type-check com 26 × TS2503 — e fica **verde no vitest**, que não type-checa: o A/B o
   aprovaria e só o CI acusaria.
2. **Atalho por condição NECESSÁRIA** (`podeTerSitio`, no topo de `acharColapsos`): fonte sem `use[A-Z]`
   ou sem `data` no texto cru devolve `[]` sem parse, e toda fonte com escape unicode é parseada sempre
   (o `.text` do identificador é o nome já decodificado). Texto cru de propósito, e não o stripper
   compartilhado: aqui sobrar fonte é o lado seguro. O argumento completo está no comentário do atalho.

## A medição

Vitest real com o plugin SWC do repo, A/B intercalado, n=4 por variante. As 16 execuções deram o **mesmo
hash** do conjunto de sítios achados:

| variante | ms | média |
|---|---|---|
| antes | 2.901–3.058 | 2.980 |
| só o alias | 1.652–1.795 | 1.724 (−42%) |
| alias + atalho | 1.077–1.158 | 1.131 (−62%) |

O arquivo real, com a config do repo, n=3: 3.106 · 2.973 · 3.019 → 1.299 · 1.149 · 1.127 ms, 20/20.
`jsDocParsingMode: ParseNone` mediu −3% (ruído) e ficou de fora.

## A falsificação — e o que ela ensinou sobre ler a baseline

Cópias sabotadas do detector e do teste rodaram na MESMA invocação que o arquivo real, com controle
40/40 verde antes de qualquer `sed`. O arquivo real ficou verde nas três:

| sabotagem | falhas (todas na cópia) | motivo impresso |
|---|---|---|
| atalho estrito demais (só `useQuery`) | 10 | as duas baselines e calibrações |
| atalho sem a cláusula do escape | 1 | a fixture de escape: "a cláusula … do atalho caiu?" |
| fixture cozida (escape trocado pelo nome literal) | 1 | a sanidade da fixture: "fixture cozida" |

- **A cláusula do escape tem UM guarda só: as fixtures.** Nenhum sítio do repo usa escape, então a
  baseline não perceberia a cláusula sumir.
- **Atalho estrito demais se apresenta como conserto.** A baseline reprova com "Sítio da classe foi
  corrigido — ATUALIZE a BASELINE": quem atualizasse no automático cegaria o gate, a mesma armadilha do
  #2283 (delta idêntico ao do conserto legítimo). O sinal de cegueira: vários arquivos "quitados" de uma
  vez, sem nenhum deles no diff.

## A fixture que chegou cozida

Ao escrever as fixtures, o escape literal no fonte foi decodificado por uma camada de escrita ANTES de
chegar ao disco: a fixture virou o caso comum e passaria verde provando outra coisa. Por isso a barra
vem de `String.fromCharCode(92)`, e a própria fixture assere que o escape sobreviveu.

## O impacto honesto

O tempo até o merge não muda: o `testes` termina em ~3 min, e o `validate` espera o
`gates-e-falsificacao` (~16 min, ~12 deles no step de Falsificação — é lá que está o relógio do CI). O
ganho: folga no teste que já estourou o `testTimeout` sob carga (21.754ms em 2026-09-06), cada suíte
inteira rodada pelo `exclusividade:medir`, e o crescimento, porque o custo passa a escalar com as fontes
que PODEM ter sítio, não com o repo.

**Validação no CI — critério pré-registrado** (método de [medir-ganho-de-ci-sob-ruido.md](medir-ganho-de-ci-sob-ruido.md)):
n≥3 execuções com a mudança, todas com o arquivo ÷ outros `src/` abaixo de 42,1‰, o piso da faixa
pós-#2550 (42,1–61,9‰). Até lá, a referência "sob a suíte completa" do diagnóstico de timeout é
ESTIMADA (0,75 ms/fonte isolado × 2,6, a razão suíte÷isolado medida na M2 em 2026-09-07).

Fora do escopo, mesmo idioma: os outros 3 módulos que importam `typescript` (`src/lib/modulos/imports.ts`,
`src/lib/gates/authz-dominante.ts`, `scripts/pendencias-deploy.ts`) rodam em milissegundos no CI; o maior
consumidor deles é o `ia-paga-sem-cota-gate.test.ts`, 0,6–0,7s o arquivo.

## Regra

**Sob o vitest, dependência CJS usada em laço quente paga um trap de `Proxy` por acesso.** Ligue o
objeto UMA vez fora do laço — com `import x = y` quando o namespace também serve de tipo, porque o
`const` quebra os tipos e o vitest não avisa. E **medir fora do runner não mede o que o runner paga**: a
diferença entre os dois é dado, não ruído — foi ela que apontou a causa que o parse escondia.

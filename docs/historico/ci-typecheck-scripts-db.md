# CI — o type-check que faltava em `scripts/` e `db/`

**Entrega:** 2026-08-13. Descoberto durante o PR #1715 (sentinela de grants), registrado como
"Próximo passo" em [sentinela-grants-tabelas-fechadas.md](sentinela-grants-tabelas-fechadas.md).

Irmão do [ci-testes-edge-deno.md](ci-testes-edge-deno.md): mesma classe de lacuna (código que
existe no repo, roda em produção e nenhum gate examina), outro diretório.

## O achado

Nenhum dos gates do `validate` type-checava `scripts/` nem `db/`:

| Gate | Por que não cobre |
| --- | --- |
| `bun run typecheck` (tsc) | `tsconfig.app.json` tem `include: ["src"]` |
| `bunx knip` | `project` = `src/**` + `supabase/functions/**` |
| `bun run test` (vitest) | **executa** `scripts/**/*.test.ts`, mas transpila (esbuild/swc) sem type-checar |
| `bun lint` (eslint) | não type-checa |
| `bun run edges:typecheck` | só `supabase/functions/*/index.ts` |

Erro de TIPO em `scripts/` ficava verde nos quatro gates bloqueantes — inclusive nos arquivos que
**são** os gates: `authz-gate-check.ts`, `bun-pin-gate-check.ts`, `docs-indice-gate-check.ts`,
`edges-typecheck-gate.ts`. O guarda não era guardado.

## A prova de que não era hipotético (o bug de 5 semanas)

O `#1201` (faxina de dead code, 2026-07-06) deletou `src/lib/radar/types.ts` com a justificativa
literal **"Dead code deletado (0 refs provadas)"**. A ref existia: `scripts/radar/carga.ts`
importava `RadarEmpresaRow`/`RadarMunicipioRow` de lá.

Duas ferramentas erraram pelo **mesmo** motivo, cada uma no seu recorte:

- o **knip** não viu a ref porque `scripts/` está fora do `project`;
- o **tsc** não viu o TS2307 resultante porque `scripts/` está fora do `include`.

O import sobreviveu ao delete porque é `import type` — o transpilador o apaga, então
`bun scripts/radar/carga.ts` continua **rodando**. O que morreu foi a validação: por 5 semanas o
objeto montado no `linhas.push({...})` não foi conferido contra contrato nenhum, num script que
alimenta a edge `radar-ingest`. Verde em todo gate, o tempo todo.

## Os 19 erros, e o que eram

`tsc --noEmit` com `include: ["scripts/**/*.ts","db/**/*.ts"]`, `strict: true` → **19 erros**.
Duas famílias bem distintas:

| # | Classe | Diagnóstico |
| --- | --- | --- |
| 9 | `TS2339` `Property 'main'/'dir' does not exist on type 'ImportMeta'` | **Configuração.** `import.meta.main`/`.dir` são extensões do Bun. Sumiram todos ao pôr `bun-types` no `types` — nenhum era bug. |
| 9 | `TS2345` `ExtractedObject[]` não é `Record<string, unknown>[]` | **Dívida real** em `test-migration-objects.ts` (interface não tem index signature implícito). |
| 1 | `TS2307` `Cannot find module '../../src/lib/radar/types'` | **Dívida real** — o delete do #1201 acima. |

Todos os 10 reais foram corrigidos, então **o gate entra em zero**.

## Decisões

**tsconfig separado, não `include` estendido no app.** `scripts/` e `db/` rodam em Bun/Node
(`import.meta.dir`, `node:fs`, `process.argv`); `tsconfig.app.json` é ambiente de browser
(`lib: DOM`, `jsx: react-jsx`). Fundir daria a um script acesso silencioso a `document`/`window`,
que não existem no runtime dele — trocaria uma cegueira por um falso-positivo de disponibilidade.

**Sem baseline nem allowlist.** Foi possível zerar, e o CLAUDE.md já registra que arquivo-lista de
exceções vira ímã de conflito entre as ~30 worktrees paralelas (foi por isso que o
`edges:typecheck` preferiu classes-bloqueantes a uma denylist de arquivos). Aqui nem isso é
preciso: erro novo em **qualquer** arquivo de `scripts/` ou `db/` fica vermelho. O gate é mais
forte que o das edges justamente porque a dívida cabia num dia de trabalho — as edges têm 141
erros tolerados, `scripts/` tem 0.

**`types: ["node", "bun-types"]` — e `vitest/globals` de fora.** Os 6 `.test.ts` de `scripts/`
importam `{ describe, it, expect } from 'vitest'` explicitamente (conferido um a um). Sem os
globals no ambiente, um teste que **esqueça** o import fica vermelho em vez de resolver por magia.
`bun-types@1.3.14` casa o `bun-version` do `ci.yml` — ao bumpar um, bumpar o outro.

**`src/lib/radar/types.ts` restaurado em `scripts/radar/types.ts`.** Devolvê-lo a `src/` o
recolocaria dentro do `project` do knip como export sem consumidor em `src/` — e a mesma faxina
aconteceria de novo. Co-localizar fonte e consumidor é a regra de fronteira do CLAUDE.md.

**O fix do `TS2345` apertou o teste em vez de silenciá-lo.** `has(objs, partial)` passou a ser
chaveado por `keyof ExtractedObject`: um typo na chave (`{ kinde: 'view' }`) agora é erro de
compilação. Antes, com `Record<string, string>`, devolvia `false` em silêncio e o teste reportava
"FAIL" acusando a lib quando o culpado era o próprio teste.

## Falsificação (o gate morde)

Gate visto só verde não prova nada. Cinco alvos, cada um recebendo um erro de **tipo** puro
(`TS2322` — não erro de sintaxe, que provaria só o parser), exigindo exit≠0 **e** a citação do
arquivo certo, com controle verde antes e depois:

| Alvo | O que prova | Resultado |
| --- | --- | --- |
| `scripts/authz-gate-check.ts` | raiz de `scripts/` | MORDEU (exit 2) |
| `scripts/lib/authz-contract.ts` | o glob `**` pega subdiretório | MORDEU (exit 2) |
| `db/audit-grants-tabelas-fechadas.ts` | o 2º `include` está vivo | MORDEU (exit 2) |
| `scripts/bun-pin-gate-check.test.ts` | `.test.ts` também é coberto | MORDEU (exit 2) |
| `scripts/alvo-falsificacao-tmp.ts` | **arquivo novo** entra vermelho | MORDEU (exit 2) |

Só `exit≠0` não bastaria como asserção — poderia estar vermelho por qualquer outro motivo; por
isso cada caso casa também `^<arquivo>(.*error TS2322`, ASCII e sem `-i` (lição do #1483, em que
`grep -qi` casou o ramo errado por dobra de acento do locale).

## Duas armadilhas encontradas no caminho

**`heavy tsc` deu `EXIT=127` com "0 erros".** `tsc` não está no PATH direto — o comando nunca
rodou. Fosse a saída lida sem o exit code, teria virado "gate verde". É a armadilha do CLAUDE.md
("ausência de sinal não é aprovação") aparecendo dentro do trabalho que existe para fechá-la. O
caminho que funciona é `bun run scripts:typecheck` (o `bun run` põe `node_modules/.bin` no PATH)
ou `./node_modules/.bin/tsc`.

**A 1ª versão do script de falsificação usava `git checkout -- scripts/ db/` para reverter** — e
reverteu junto as correções ainda não commitadas do próprio PR, deixando o controle final vermelho
por motivo errado. Sabotagem se reverte por backup pontual (`cp`), que também é o único jeito que
funciona para arquivo untracked.

## Como fica

```bash
bun run scripts:typecheck   # tsc --noEmit -p tsconfig.scripts.json
```

Step `Type check (scripts/ + db/)` no job `validate`, logo após o typecheck do `src` — 1,8–4,0s
medidos em 3 execuções, sem rede nem toolchain extra, então falha cedo. Cobre 28 arquivos
(27 em `scripts/`, 1 em `db/`); `db/` entrou no escopo para que o **próximo** `.ts` nasça coberto,
não por volume — hoje são 228 `.sh` e 41 `.sql` para 1 `.ts` lá.

## O que ficava em aberto — e fechou no mesmo dia

`scripts/` estava fora do `project` do knip, então este gate fechava o **sintoma** (o TS2307 fica
vermelho na hora) e não a causa: a faxina continuaria propondo o mesmo delete. A previsão feita
aqui — "mede-se primeiro quantos falsos-positivos os scripts produzem, muitos são entrypoints de
CLI sem importador" — foi confirmada na medição: **10 falsos-positivos, todos entrypoints**.

A ampliação está em [knip-scripts-causa-raiz.md](knip-scripts-causa-raiz.md).

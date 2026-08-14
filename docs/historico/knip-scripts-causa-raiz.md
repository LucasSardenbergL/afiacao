# knip — `scripts/` entra no `project` e a causa raiz do #1201 fecha

**Entrega:** 2026-08-13, horas depois do #1720. É o follow-up que aquele PR deixou escrito como
"fica em aberto" — ver [ci-typecheck-scripts-db.md](ci-typecheck-scripts-db.md).

## Por que não bastava o `scripts:typecheck`

O #1720 fez o TS2307 de `scripts/radar/carga.ts` ficar vermelho **na hora**. Mas o delete que o
produziu continuaria sendo **proposto**: com `scripts/` fora do `project`, o knip não enxerga as
refs de `scripts/` para `src/` e trata como órfão o módulo de `src/` que só um script consome. Era
exatamente o caso de `src/lib/radar/types.ts` no #1201 ("0 refs provadas").

Um gate que grita depois do estrago é melhor que nada; um que não sugere o estrago é melhor.
Sintoma × causa.

## A medição (a previsão do #1720 bateu)

`project` += `scripts/**/*.ts` + `db/**/*.ts`, sem mais nada → **15 achados**:

| Classe | # | Veredito |
| --- | --- | --- |
| Unused files | 10 | **Todos falsos-positivos** — entrypoints de CLI |
| Unused exports | 2 | Reais (`SENSITIVE_TABLES`, `SENSITIVE_COLUMNS`) |
| Unused exported types | 3 | Reais (`UnparsedFn`, `GateClause`, `GrantCodigo`) |

Os 7 scripts registrados no `package.json` **não** apareceram: o knip lê os scripts do
`package.json` e os trata como entry sozinho. Metade do problema já vinha resolvida.

Os 10 restantes são entrypoints com prova documental, não dead code:

- `city-norm-print.ts` — invocado por `db/test-city-norm-paridade.sh:72`
- `fronteiras-modulos.ts` — gera `src/lib/modulos/fronteiras-baseline.ts`, e o
  `fronteiras.gate.test.ts` manda rodá-lo quando a baseline diverge
- `boletim-modulos.ts` — gera `docs/modulos/boletim-inaugural.md`
- `bundle-modulos.ts` — medição de bundle citada em `AppShell.tsx:48`
- `carga.ts`, `medir.ts`, `importar-carteira.ts`, `backfill-dre-competencia.ts` — CLIs
  documentados no próprio cabeçalho / em `docs/historico/`
- `test-migration-objects.ts` — teste executável (`bun scripts/test-migration-objects.ts`)
- `radar/types.ts` — cascata: era acusado só porque `carga.ts` era

## A decisão que dá valor à mudança: `scripts/lib/**` fora do `entry`

O reflexo seria pôr `scripts/**/*.ts` inteiro em `entry` e declarar vitória — os 10 sumiriam. Mas
aí o knip não checaria export nenhum em `scripts/`, e a ampliação viraria enfeite: entry files não
têm seus exports auditados.

O recorte usado separa os dois papéis que `scripts/` acumula:

| Padrão | Papel | Efeito |
| --- | --- | --- |
| `scripts/**/*.ts` em `entry` | CLIs | nunca viram "unused file" falso |
| `!scripts/lib/**` | biblioteca compartilhada | **exports auditados de verdade** |

`scripts/lib/` é onde vivem `authz-contract`, `authz-grants` e `migration-objects` — a lógica que
mais de um gate importa, e o único lugar de `scripts/` onde export órfão significa algo. Foi de lá
que saíram os 5 achados reais. **Convenção que isso cria:** lib nova compartilhada em `scripts/`
nasce sob `scripts/lib/`; é o que a coloca sob vigilância.

## Os 5 achados reais

Todos usados **apenas dentro do próprio arquivo** — o `export` era supérfluo. Des-exportados
(o default do repo: não altera comportamento, só reduz alcance), conferindo antes, um a um, que
nenhum aparecia em import externo nem nos testes:

| Símbolo | Onde | Por que o `export` sobrava |
| --- | --- | --- |
| `SENSITIVE_TABLES`, `SENSITIVE_COLUMNS` | `lib/authz-contract.ts` | consumidos só por `touchesSensitive()`, que é a superfície pública — a lista crua exportada convidava a duplicar a decisão de "o que é sensível" fora dali |
| `UnparsedFn` | `lib/authz-contract.ts` | tipo de suporte de `ExtractResult` |
| `GateClause` | `lib/authz-contract.ts` | tipo de suporte de `RequiredGate` (o `authz-manifest.ts` importa só ela e constrói as cláusulas por literal) |
| `GrantCodigo` | `lib/authz-grants.ts` | tipo de suporte de `GrantFinding`; os testes casam o CÓDIGO como string literal, não o tipo |

## Falsificação — três provas, porque são três efeitos

A mudança faz três coisas e cada uma pode falhar sozinha:

| Prova | O que exige | Resultado |
| --- | --- | --- |
| **A** — morde onde deve | export órfão plantado em `scripts/lib/` → vermelho citando o símbolo | `A_MORDEU` (exit 1) |
| **B** — não morde onde não deve | script CLI novo, sem importador → **não** pode derrubar o gate | `B_SEM_FALSO_POSITIVO` (exit 0) |
| **C** — a causa raiz fechou | módulo de `src/` consumido só por `scripts/` deixa de ser órfão | `C2_PROTEGIDO` |

**A prova C exigiu contraste, e é o ponto do PR.** Sozinho, "o knip não acusou" não prova nada —
ele poderia não estar acusando por qualquer motivo (config quebrada, alvo fora do escopo, gate
mudo). Então o mesmo cenário roda **contra a config antiga**, recuperada de `git show HEAD:knip.json`:

- `C1_CONFIG_ANTIGA_ACUSA` — a config de antes reporta o módulo como órfão, **reproduzindo o
  #1201**. É isso que valida o cenário.
- `C2_PROTEGIDO` — a config nova não reporta.

Sem C1, o verde de C2 seria evidência vazia. Controle verde antes e depois; `FALHAS=0`.

## Custo

Nenhum step novo de CI: o `bunx knip` do `validate` já existia e passou a cobrir mais. Sem baseline
e sem entrada em `ignore` — os 15 achados foram resolvidos na fonte (10 por config correta, 5 por
des-exportação).

## O que fica

`db/**/*.ts` entrou junto por simetria e custou zero achados — o único `.ts` de lá
(`audit-grants-tabelas-fechadas.ts`) está no `package.json`, então o knip já o via como entry. Vale
pelo **próximo** arquivo, como no gate de tipos.

Sobra uma cegueira **intrínseca**, não uma pendência: o knip não tem como saber que um CLI parou de
ser chamado, porque quem o chama é humano, doc ou `.sh`. Ele nunca dirá "este script morreu". A
única defesa real contra isso é a que já existe — o script ser citado em doc ou harness, como os 10
acima estão.

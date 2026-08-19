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

1. ~~Consolidar `@supabase/supabase-js` numa versão só (hoje 6) — corta download e resolve 17 dos 141.~~
   ✅ **feito em 2026-08-07** — ver a sequela ao fim deste doc.
2. ~~Migrar `deno.land/std/http/server.ts` → `Deno.serve` (34 edges) e `esm.sh/@supabase/supabase-js` →
   `npm:` (18 edges). Deixa `registry.npmjs.org` como host único.~~ ✅ **feito em 2026-08-07** — e o 1 e o
   2 eram **o mesmo trabalho**; ver a sequela ao fim deste doc.
3. Zerar as 25 edges sujas e apertar o gate para check completo.
4. Versionar `deno.lock` (hoje no `.gitignore`) — reprodutibilidade + chave de cache estável.

Spec: `docs/superpowers/specs/2026-07-21-edges-typecheck-gate-design.md`

---

# Sequela (2026-08-04): o gate de COBERTURA também não alcançava as edges — e a trava era o runner

**Entrega:** PR #1653. Descoberto ao tentar registrar o contrato de mutation-check da política de
retry do Omie (#1643/#1644).

## O achado

`scripts/mutcheck.d/*.mut` é o registro **versionado** das mutações que uma suíte tem de matar — o
contrato executável de "esse teste tem PODER". O `mutcheck-all.sh` invocava
`bash "$MUTCHECK" "$src" "$tst" "$mut"` **sem env por contrato**, e o default do `mutcheck.sh` é
`bunx vitest run` + `bun build`: ferramenta desenhada para helper de `src/`. Vitest não conhece
`Deno.test` → baseline **vermelho** → o contrato aborta; e como o laço soma qualquer falha, **um**
`.mut` de edge no diretório derrubaria o job `mutation-check` inteiro.

A consequência tem nome: os dois helpers cuja suíte tinha sido **de fato medida** — 9/9 mutações
pegas no #1644, 4/4 no gate de fonte de cada edge, idem no #1643 — eram **exatamente os únicos que
não podiam ter a medição versionada**. A falsificação existia na transcrição do chat, e transcrição
de chat não é gate: some no próximo compact, e o refactor seguinte não encontra nada que o segure.

## A mudança — e a armadilha que ela quase criou

Duas diretivas **opcionais** por contrato, lidas com o mesmo `sed` de `@src:`/`@test:`
(comentário para o `mutcheck.sh`, que ignora `#`):

```
# @test_cmd: deno test --no-remote --allow-read=supabase/functions   → MUTCHECK_TEST_CMD
# @compile_cmd: deno check --no-remote                               → MUTCHECK_COMPILE_CMD
```

A sutileza que merece ficar escrita: elas só entram no ambiente **quando o contrato declara**. A
implementação óbvia — montar o env sempre, vazio quando o contrato não diz nada — teria **desligado
o compila-check dos outros 9 em silêncio**. O `mutcheck.sh` lê `${MUTCHECK_COMPILE_CMD-default}`
com `-`, **não** `:-`: a forma que preserva "setado e vazio" como escolha deliberada (é assim que se
desliga o guard de propósito). Vazio ≠ ausente ali, e o compila-check é justamente o que separa
"morto por TESTE" de "morto pelo COMPILADOR" — sem ele o poder aparente da suíte infla. A falha
seria **silenciosa e na direção segura**: tudo verde, e os números até melhorariam.

> **Regra viva:** injetar env "sempre, vazio quando não houver valor" só equivale a "não injetar"
> quando quem LÊ usa `${VAR:-default}`. Com `${VAR-default}` os dois são **opostos**. Confira o lado
> que lê antes de decidir como escrever o lado que grava.

Armadilha gêmea, deixada documentada no cabeçalho do script: `# @compile_cmd:` **pelado** conta como
ausente e cai no `bun build` default, que num alvo Deno aborta o contrato com
*"harness/ambiente quebrado (bun no PATH?)"* — mensagem que aponta para o lugar errado. Para
desligar de verdade: `# @compile_cmd: true` (o comando `true` sai 0 sempre, que é o contrato de
`compila()`).

## O terceiro pedaço: o job não tinha o runtime

O `mutation-check` só tinha `Setup Bun`. É a **terceira instância** da mesma forma que este documento
já registra duas vezes: *o gate precisa alcançar o que promete alcançar*. Aqui: **o job precisa do
runtime de TODO contrato registrado, não só do default.** Sem o step, o `deno check` do SRC
**original** falha, o baseline-do-compilador aborta antes de qualquer mutação, e o job fica vermelho
por **ambiente**, não por cobertura — com uma mensagem que manda procurar o bun. Pin `2.9.2`,
alinhado ao `validate` (2ª ocorrência; bump alinha as duas, anotado nos dois lados).

## Os dois contratos — e um buraco medido

| Contrato | Medição |
|---|---|
| `cmc-snapshot-retry.mut` (#1644) | 10 mutações · **9 pegas** · 1 sobrevivente · 0 inválidas |
| `omie-analytics-politica-retry.mut` (#1643) | 8 mutações · **7 pegas** · 1 sobrevivente · 0 inválidas |

A sobrevivente do `politica-retry` entrou como `?`, **não** `SOBREVIVE`, e a distinção carrega a
decisão: `SOBREVIVE` afirma "benigno conhecido", e este não é. O código de `mensagemCorpoNaoJson`
está **certo** (redige e só então trunca em 200), mas nada o prende — inverter para truncar-antes
parte a app_key na borda e deixa um resto que escapa da máscara `\d{8,}`; o segredo sai pela metade,
que para efeito de vazamento é sair. É o mesmo furo que `cmc-snapshot-retry_test.ts` já fechou no
gêmeo de 300 caracteres. Fica **reportado e versionado** até o teste existir (chip aberto), em vez de
virar dívida que ninguém lembra.

⚠️ Ao escrever esse teste: enchimento **não-hexadecimal** (`x`, não `a`). Na 1ª versão do gêmeo o `a`
fez a máscara de app_secret (`[0-9a-f]{24,}`) engolir o enchimento junto com a chave, e a mutação
**sobreviveu mesmo com o teste presente** — verde por acidente do alfabeto, a mesma família do #1483.

## Método: a previsão errada foi a que valeu

Das 8 mutações desenhadas para o `politica-retry`, **7 bateram a previsão**. A única que não bateu
foi o achado acima. Se os `EXPECT` tivessem sido escritos de memória — o caminho natural depois de 7
acertos seguidos —, o `.mut` entraria **mentindo sobre o poder da suíte**, que é exatamente o
falso-verde que a ferramenta existe para impedir.

> **Regra viva:** `.mut` se **preenche com medição**, nunca com previsão. Uma sequência de previsões
> certas é o que torna esse atalho tentador, não o que o justifica.

## Evidência

O CI reproduziu o fingerprint local **contrato a contrato**, em runner frio (Ubuntu, Deno baixado na
hora, `--no-remote`, cache vazio) — o que o run local sozinho não podia provar:

```
Setup Deno → Going to install stable version 2.9.2 … Installation complete.
  runner do contrato: MUTCHECK_TEST_CMD=deno test --no-remote --allow-read=supabase/functions
  runner do contrato: MUTCHECK_COMPILE_CMD=deno check --no-remote
mutcheck-all: ✓ 11 contrato(s) honrado(s) — nenhuma regressão de cobertura.
```

Os 9 contratos antigos saíram com os **mesmos números** de antes da mudança (`8/6/2`, `9/9/0`,
`11/11/0`, `18/18/0`, `6/6/0`, `9/7/2`, `10/9/1`, `27/27/0`, `12/12/0`) — a prova de que o override
por contrato não vaza para quem não o declara. Custo: o job foi de ~2m41s para ~3m54s (teto de 10min).

---

# Sequela (2026-08-07): os dois hosts saíram do caminho de entrega — e o follow-up 1 era o mesmo trabalho que o 2

**Entrega:** PRs #1685 (34 edges), #1687 (7), #1690 (12), #1694 (17). Gatilho: o **#1670**, uma PR **só
de documentação**, derrubada pelo `edges:typecheck` com

```
error: Import 'https://esm.sh/@supabase/supabase-js@2.112.2/dist/index.d.mts' failed: 500 Internal Server Error
```

O gate agiu certo — *"não conseguir checar não é o mesmo que estar limpo"* é o desenho — e o rerun
passou. O problema não era ele: o `edges:typecheck` é o **único step do `validate` que precisa de rede**,
e arrastava dois hosts que não estavam no caminho de entrega por nenhum outro motivo. Mesma forma do
2026-07-16 (REST API do GitHub degradada matando todo PR em ~6s), que motivou o `bunpin:check`.

## Os follow-ups 1 e 2 eram um trabalho só — e fazer só o 2 pioraria o 1

O nº 2 (migrar de host) parecia independente do nº 1 (consolidar numa versão só). Não era. As edges que
**já** usavam `npm:` o faziam com **4 especificadores distintos** (`@2`, `^2`, `@2.45.0`, `^2.95.3`), e as
19 de `esm.sh` traziam mais 3 (`@2.45.0`, `@2`, `@2.39.0`). Migrar de host sem escolher a versão teria
despejado as 19 no mesmo espalhamento que produzia os 17 `SupabaseClient not assignable` — **trocaria um
problema por dois**.

> **Regra viva:** migração de HOST e consolidação de VERSÃO são o mesmo trabalho quando o import carrega
> as duas coisas na mesma string. Fazer só uma metade move o custo, não o remove.

Especificador escolhido para o repo: **`npm:@supabase/supabase-js@2`**, por medição e não por gosto:

- majoritário absoluto — **56 dos 74** imports `npm:` da main;
- `@2` e `^2` são o **mesmo range semver** (`>=2.0.0 <3.0.0`) — normalizar é textual, não muda o que
  resolve. Dos 17 do último PR, **14 eram exatamente esse caso**;
- quem **cria** versão distinta no grafo é o pin exato (`@2.45.0`, `@2.39.0`, `^2.95.3`) — tirá-lo é o que
  consolida de verdade;
- reprodutibilidade contra "o range se move sozinho" é papel do **`deno.lock`** (follow-up 4, ainda
  aberto), não do especificador — pin aqui duplicaria esse papel e criaria bump manual em 73 arquivos.

## O que já se sabia sobre `esm.sh` — e estava escrito no lugar errado

O achado que mais mudou o enquadramento não veio de medição nova: veio de **comentário em quatro edges**,
deixado pelo #1592 e pelas sequelas dele:

> `⚠️ usar npm: (não esm.sh) — esm.sh/@supabase/supabase-js falhava em resolver no boot do edge runtime,
> dando RUNTIME_ERROR sem linha/stack`

Ou seja: `esm.sh` **já tinha derrubado edge em produção**, e a correção já era `npm:`. Quatro edges
migraram uma a uma, por incidente, cada uma deixando o aviso no próprio cabeçalho — e o padrão nunca
virou varredura. O 500 do #1670 foi a mesma fonte cobrando pelo lado do CI.

> **Regra viva:** aviso repetido em cabeçalho de arquivo é **classe não erradicada**, não documentação.
> Quando o mesmo `⚠️` aparece no 3º arquivo, o que falta não é mais um comentário — é a varredura.

Consequência prática para o redeploy: migrar `esm.sh` → `npm:` não é risco novo a observar, é aplicar a
correção que 4 edges já validaram em produção.

## A asserção não podia ser a óbvia

O objetivo era "o host sumiu", e o grep natural —

```
grep -rlE "https://esm\.sh/|https://deno\.land/" supabase/functions/
```

— **nunca chega a zero**: 7 arquivos citam os hosts em **prosa de comentário** (os 4 avisos acima, mais 3
explicando por que a suíte de edge roda offline). Um gate ancorado nele ficaria permanentemente vermelho
e seria afrouxado até não valer nada.

O que o `deno check` resolve é o `from "https://…"`. A asserção é sobre **import**, não sobre menção:

```
grep -rlE "from ['\"]https://(esm\.sh|deno\.land)/" supabase/functions/
```

> **Regra viva:** ao provar que uma classe sumiu, o padrão tem de casar a **forma que o compilador
> enxerga**, não a string que dá o nome à classe. Prosa que descreve o bug mora no mesmo arquivo que o
> bug — mesma armadilha do `escrita-critica.ts`, cujo cabeçalho cita a forma do bug de propósito e
> apareceu como falso positivo no predicado do gate de §11 do `money-path.md`.

## O que a migração NÃO consertou — e por que era previsível

Seis das 12 edges de money-path importavam `type SupabaseClient` junto do `createClient`, então valia
perguntar se a consolidação derrubaria ali a classe `TS2345`. **Não moveu: 36 antes, 36 depois.** É o
esperado, e o diff mostra por quê — o valor e o tipo vinham da **mesma linha de import**, então não havia
mismatch interno a corrigir.

O que **não** era esperado: a consolidação completa também não moveu. Com o repo inteiro em `@2` —
especificador único, uma versão só no grafo — o gate saiu em **`TS2345:36`, o mesmo número de antes de a
série começar**. Os 136 tolerados ficaram idênticos, classe por classe, nos quatro PRs.

> **Regra viva:** a previsão do follow-up 1 (*"corta download e resolve 17 dos 141"*) estava certa na
> primeira metade e **errada na segunda**. O espalhamento de especificador custava download; ele **não
> era a causa** do `SupabaseClient not assignable`. Estimativa escrita num follow-up é hipótese, não
> medição — e quem executa o follow-up é quem tem a obrigação de medir o antes/depois em vez de herdar o
> número. Sem essa medição, a série teria sido reportada como "resolve 17" e ninguém notaria por anos.

A causa dessa classe segue em aberto e passa a ser dado do **follow-up 3**, com uma informação que antes
não existia: ela **sobrevive à unificação de versão**, então não adianta atacá-la por ali.

## Família B: `Deno.serve` — drop-in conferido, não assumido

34 edges importavam `serve` de `deno.land/std@{0.168.0,0.190.0}/http/server.ts`. A troca só é drop-in se
ninguém usar o 2º parâmetro do handler (`connInfo` no std, `Deno.ServeHandlerInfo` no nativo) nem as
options. Medido antes de tocar: **0 handlers com 2º parâmetro, 0 chamadas com options**, 34/34 na forma
`^serve(` top-level. As outras 61 edges já usavam `Deno.serve`.

## Números

| | Antes (main 2026-08-06) | Depois |
|---|---|---|
| imports `https://deno.land/` | 34 | **0** |
| imports `https://esm.sh/` | 19 | **0** |
| especificadores distintos de `@supabase/supabase-js` | 7 | **1** (`npm:…@2`) + 1 no bundle gerado |
| hosts no `deno check` | `registry.npmjs.org` + `esm.sh` + `deno.land` | **só `registry.npmjs.org`** |

`registry.npmjs.org` **já** estava no caminho de entrega via `bun install` — então o `edges:typecheck`
deixa de ter host próprio.

## Uma edge ficou de fora de propósito

`supabase/functions/mcp/index.ts` usa `npm:@supabase/supabase-js@^2.95.3` e **não** foi normalizada: é
bundle auto-gerado (`// AUTO-GENERATED by @lovable.dev/mcp-js — do not edit. Regenerated by the Vite
plugin.`). O banner até oferece uma saída — *"To take ownership, delete this banner line"* — mas tomar
posse do bundle para arrumar uma string seria trocar regeneração automática por manutenção manual de um
arquivo gerado. A divergência é do **artefato**; a fonte (`src/lib/mcp/**`) não escolhe essa string.

## Custo de redeploy: nenhum agora, e nenhum mutirão depois

O `deno check` roda sobre o **repo**, então os hosts saem do CI **no merge**. As edges em produção seguem
com o import antigo até serem redeployadas pelo chat do Lovable. **Não se faz mutirão de redeploy** —
cada edge pega a mudança no próximo deploy natural dela. As duas edges onde o redeploy muda a versão
resolvida de verdade (`omie-webhook`, pinada em `2.39.0`, a mais velha do repo; e os 3 pins `2.45.0` do
portal Sayerlack) tiveram a superfície da lib medida antes: só `.from()` e `.rpc()`, zero
`auth`/`storage`/`realtime`/`functions` — PostgREST puro, a parte que não mudou de contrato dentro do 2.x.

## Follow-ups (atualizados)

1. ~~Consolidar `@supabase/supabase-js` numa versão só~~ ✅ feito aqui (`npm:…@2`).
2. ~~Migrar `deno.land/std/http/server.ts` → `Deno.serve` e `esm.sh` → `npm:`~~ ✅ feito aqui.
3. Zerar as edges sujas e apertar o gate para check completo. **Com um dado novo:** a classe `TS2345`
   (36, onde mora o `SupabaseClient not assignable`) **não** vem do espalhamento de especificador —
   sobreviveu intacta à unificação. Quem pegar este follow-up começa sabendo que esse caminho já foi
   tentado e não é por ali; use `bun run edges:typecheck --json` para ver as mensagens, que o resumo do
   gate não guarda.
4. Versionar `deno.lock` (hoje no `.gitignore`) — reprodutibilidade + chave de cache estável. **Subiu de
   prioridade:** com todo o repo em `@2` (range, não pin), o lock passa a ser o *único* lugar que prende a
   versão resolvida; sem ele, uma publicação do `@supabase/supabase-js` pode ficar vermelha num PR alheio.

# Sequela (2026-08-15): a main VERMELHA sem commit culpado — o gate herdava o drift do FRONTEND, e o gatilho era o RELÓGIO

## O achado

`validate` vermelho na `main`, step **"Type check (edge functions — Deno)"**:

```
error: Could not find npm package '@swc/core-linux-arm-gnueabihf' matching '1.16.0'.
❌ NÃO FOI POSSÍVEL TYPE-CHECAR as edges (exit 1)
```

Auto-merge de **todos** os PRs parado (o `auto-merge.yml` exige `validate` verde), ~20 worktrees sem
entregar. E nenhum commit para culpar: entre o último verde (09:37Z) e o primeiro vermelho (17:27Z) a
`main` só recebeu dois commits do Lovable, ambos tocando **apenas** `src/integrations/supabase/types.ts`.
`@swc/core` nem está no `package.json` — entra por `@vitejs/plugin-react-swc`.

## A mecânica — três fatos que só juntos explicam

1. **O gate lia o `package.json` do frontend.** O `spawnSync` roda com `cwd: raiz`, e o Deno
   auto-resolve o `package.json` de lá. Prova mínima: um `deno check` de um `.ts` **vazio**, que não
   importa nada, rodado da raiz com `DENO_DIR` virgem, baixa o packument de `vitest`, `@eslint/js`,
   `@hookform/resolvers`, `@elevenlabs/react`… — as ~100 deps de build/UI, nenhuma usada por edge
   alguma. O gate de *edge* era refém do grafo npm do *frontend*.
2. **O Deno tem cooldown de supply-chain** (`--minimum-dependency-age`, default 24h): recusa versão
   publicada há menos disso. A mensagem completa denuncia — e foi o fio da meada:
   `A newer matching version was found, but it was not used because it was newer than the specified
   minimum dependency date of 2026-08-14 17:49:11 UTC`.
3. **Publicação escalonada + pin exato.** `@swc/core@1.16.0` saiu 14/08 **17:23:06Z**; seus **12**
   binários de plataforma, pinados em versão **EXATA** nos `optionalDependencies`, terminaram de sair
   só às **18:01:25Z**.

Junte: a janela de 24h **desliza com o relógio**, então o pai entrou na janela 38 min antes dos filhos.
Nessa fresta o Deno aceita `@swc/core@1.16.0` e recusa os binários dele — e como o pin é exato, **não há
versão anterior para onde cair** (um range `^` teria degradado em silêncio para a 1.15.47 madura).

Cronologia, e o encaixe é de 4 minutos:

| momento | corte de 24h | estado |
|---|---|---|
| 15/08 09:37Z | 14/08 09:37Z | pai ainda "novo" → Deno cai para 1.15.47 → **verde** |
| 15/08 **17:23:06Z** | = publicação do pai | pai entra na janela, filhos não |
| 15/08 **17:27Z** | — | **primeiro run vermelho** |
| 15/08 **18:01:25Z** | = último binário | fresta fecha → **volta a verde sozinho** |

O erro **anda** entre binários conforme cada um amadurece (`linux-arm-gnueabihf` no CI às 17:34Z,
`linux-arm64-gnu` no repro local às 17:49Z): assinatura inconfundível de janela deslizante.

## O reflexo errado — e por que

O diagnóstico natural é "o `^` deixou escorregar para uma versão quebrada; **pine** `@swc/core` via
`overrides`". O Deno **respeita** `overrides` (verificado: com `"@swc/core": "1.13.2"` ele resolve
1.13.2), então funcionaria. Mesmo assim é o conserto errado:

- trata **um** pacote e deixa a **classe** viva — qualquer dep de build com binários de plataforma
  repete isso na próxima release;
- **congela o build do frontend** para consertar um gate de *edge* — acoplamento invertido;
- mexe em `package.json` + **3** lockfiles, a superfície mais disputada do repo (~20 worktrees).

O gate, aliás, **acertou**: ele é fail-closed de propósito e reprovou uma resolução que de fato não
fechou. Afrouxá-lo (`--no-check`, allowlist) trocaria o problema por cegueira.

## A correção

`DENO_NO_PACKAGE_JSON=1` no `spawnSync` do gate (`scripts/edges-typecheck-gate.ts`) — o Deno para de
auto-resolver o `package.json`. As edges seguem resolvendo seus `npm:` explícitos do registry, que é
o que o Edge Runtime do Supabase faz de verdade (lá não existe `package.json`). Um arquivo, zero
lockfile, e a classe inteira morre: o gate deixa de ter opinião sobre dependência de frontend.

Extraído para `ambienteDeno()` (exportado) para o teste travar o invariante — a chave sumir devolve o
gate à mercê do relógio, e a falha seria **intermitente**, ~24h depois de uma release alheia.

## Falsificação

A janela fecha sozinha às 18:01:25Z, então "passou" deixaria de distinguir **fix** de **auto-cura** —
o oráculo tinha prazo de validade. `--minimum-dependency-age` aceita timestamp absoluto, o que torna o
teste determinístico **a qualquer hora**, hoje ou daqui a um mês:

```bash
# corte que replica o 1º run vermelho (pai maduro, binários não)
deno check --no-lock --node-modules-dir=none --minimum-dependency-age=2026-08-14T17:27:00Z x.ts
```

| | resultado |
|---|---|
| sem `DENO_NO_PACKAGE_JSON` | **exit 1** — `Could not find npm package '@swc/core-darwin-arm64' matching '1.16.0'` |
| com `DENO_NO_PACKAGE_JSON=1` | **exit 0**, e **zero** downloads do registry npm |

(`darwin-arm64` saiu 17:27:20Z — 20 s depois do corte.) O repro também exigiu `DENO_DIR` **virgem**: com
cache quente o gate passava local enquanto o CI, sempre frio, quebrava — cache quente é ausência de
sinal, não aprovação.

## Lição transferível

**Um gate só deve resolver o que ele checa.** O acoplamento aqui não foi escrito por ninguém — veio de
graça do `cwd`, e ficou invisível enquanto o registro npm estava calmo. Vale a pergunta em qualquer
gate: *o que ele baixa que não tem nada a ver com o que ele afirma?*

E: **quando o gatilho é o relógio, o oráculo tem prazo de validade.** Um bug que se auto-cura fabrica
falso-positivo em quem for validar depois — a prova precisou congelar o tempo (`--minimum-dependency-age`)
em vez de correr contra ele.

---

# Sequela (2026-08-18): a TERCEIRA perna — o **vitest** vigia a FORMA da edge, e nenhum dos três comandos "de edge" a enxerga

**Entrega:** #1772 (sonda de versão nas 5 edges que escrevem money-path no nosso banco, merge `77e46ab9`);
correção do CI em `f765a71b`.

## O achado

O `validate` ficou **vermelho** com os três comandos de edge **verdes**, cada um com exit 0 capturado:

| comando | resultado |
|---|---|
| `bun run test:edges` | exit 0 |
| `bun run edges:typecheck` | exit 0, baseline 136/0 |
| `bun lint` | exit 0, zero ocorrências em `supabase/functions` |

Quem reprovou foi a **suíte vitest** (`bun run test`), em `src/__tests__/edge-money-path-invariants.test.ts`.

Este documento já registrava duas pernas — a suíte Deno **roda** (#1437) e ela **não type-checa**, o que
o `edges:typecheck` fechou (#1462). Falta a terceira, e ela é de outra natureza: **o vitest não roda a
edge, ele a LÊ.** O guardrail mora em `src/`, dentro do `include` do vitest
(`src/**/*.{test,spec}.{ts,tsx}` — `supabase/functions/**` continua fora, como sempre esteve), abre o
arquivo da edge com `readFileSync` e casa **regex contra o texto do código-fonte**.

Consequência que não é óbvia partindo das duas primeiras pernas: **uma mudança PURAMENTE sintática numa
edge pode reprovar o CI sem nenhuma mudança de semântica.** Extrair um helper, reordenar, renomear —
nada que `test:edges`, `edges:typecheck` ou `bun lint` tenham como notar.

## O caso concreto

A sonda de versão exigia que o marcador `versao` fosse em **toda** resposta da `omie-cliente`, o que
levou a centralizar as respostas num helper `jsonRes(body, status)`. O guardrail do `criar_perfil_local`
casava:

```
/if \(mappingError\)[\s\S]{0,700}?status:\s*409/g
```

`{ status: 409, headers }` virou o **2º argumento** de `jsonRes(..., 409)`. O 409 dos dois ramos
continuou exatamente onde estava — mudou só a grafia, e o `.length` caiu de 2 para 0.

**O guardrail estava CERTO em reagir.** Ele é um teste de forma protegendo semântica fail-loud: o que
ele impede é um ramo do `mappingError` que **não** responda 409 — isto é, que engula o erro e devolva
`user_id` como sucesso, fazendo a UI (`useUnifiedOrder.handleStaffAddTool`) anexar a ferramenta ao
cliente **errado**. A correção acompanhou a forma nova **sem afrouxar o poder discriminante**: o padrão
aceita as duas grafias, e o `toBe(2)` segue exigindo os DOIS ramos.

## Números (medidos 2026-08-18)

- **20 arquivos** de teste do vitest leem `supabase/functions/` como texto (`readFileSync`).
- Eles citam **71 diretórios** distintos sob `supabase/functions/` — `_shared` + **70 edges**, de **95**
  no repo. Não é caso de canto: ~3 em cada 4 edges têm pelo menos um teste de forma apontado para elas.
- Reproduzir a lista:

```bash
for f in $(grep -rl supabase/functions src --include='*.test.ts'); do grep -q readFileSync "$f" && echo "$f"; done
```

## Lição transferível

**"Comando por tecnologia" é um mapa errado do CI.** A pergunta que importa não é *"qual runtime é este
arquivo?"* mas *"quem lê este arquivo?"* — e um teste em `src/` pode ler uma edge em
`supabase/functions/`. A lista de validação de edge tem **quatro** entradas, não três: `test:edges` ·
`edges:typecheck` · `bun lint` · **`bun run test`**.

É a mesma família das duas armadilhas de método já registradas acima e da armadilha do `deno lint` em
`docs/agent/deploy.md`: **cada ferramenta só enxerga o próprio universo**, e ausência de sinal em três
delas não é aprovação da quarta. O que fecha o buraco não é lembrar da lista — é rodar a suíte
autoritativa (`heavy bun run test`, a que o CI roda) sempre que o diff tocar `supabase/functions/`.

---

# Sequela (2026-08-18, mesmo dia): a regra virou GATE — o ambiente responde "quem lê este arquivo?"

A sequela acima registrou a 3ª perna **em texto** (CLAUDE.md, `docs/agent/deploy.md`, este doc, skill
`handoff-sessao`). Pela meta-regra do `/matar-classe`, isso é meia entrega: **contramedida textual
reincide; gate estrutural para.** O precedente medido está no `docs-indice-gate-check` — o #1658
reconciliou o índice à mão e o #1659 o quebrou de novo **no mesmo dia**. Uma frase não sobrevive à
próxima sessão que não a leu.

## A decisão que definiu o desenho: **não** é gate de CI

O CI já pega — foi ele quem reprovou o #1772. Um gate de CI aqui seria redundante e mais lento. O
buraco é o **loop de feedback local**: descobrir só depois do push. Então o gate mora no ambiente de
edição, e **só avisa** (o `permissionDecision` fica de fora; nada é negado).

## Duas peças, espelhando o par que já existe no repo (`*-gate-check.ts` + hook fino)

1. **Motor** — `scripts/edges-guardrails-afetados.ts`. Dado N caminhos sob `supabase/functions/`,
   devolve os `*.test.ts` que os leem, com o `bunx vitest run` já montado. Rodável à mão. Testado em
   `scripts/edges-guardrails-afetados.test.ts`, que está dentro do `include` do vitest — ou seja, **o
   CI passa a vigiar o próprio motor**.
2. **Hook** — `.claude/hooks/edge-guardrail-nudge.sh` (PreToolUse `Write|Edit|MultiEdit`), registrado
   em `.claude/settings.json`. Escopo estreito: só `file_path` sob `supabase/functions/`. Fail-open
   (sem `jq`/`bun` → exit 0), e **um aviso por (sessão, arquivo)** — nudge repetido vira ruído, e
   gate que vira ruído morre.

## Como o motor resolve: literal entre aspas, prefixo por SEGMENTO

Um teste é guardrail-de-forma quando cita `supabase/functions` **num literal** e lê o disco. Cada
literal é um *alcance*; ele cobre o arquivo editado quando é ele mesmo ou um diretório ancestral. As
duas formas reais do repo caem no mesmo teste:

```ts
const OMIE_CLIENTE = 'supabase/functions/omie-cliente/index.ts';   // cobre 1 arquivo
const DIRS = ['src', 'supabase/functions', 'scripts'];             // cobre TODA edge
```

**Só literal ENTRE ASPAS conta** — `// vide supabase/functions/x` é prosa, e citar não é ler. É a
mesma doutrina de precisão>recall do `edges:typecheck` e do `docs-indice-gate-check`: guardrail que
monte o caminho dinamicamente escapa do motor, e tudo bem — o CI segue sendo a rede. O que não pode é
gritar errado, porque gate que grita errado treina a ignorar o vermelho.

**A fronteira é de SEGMENTO, não de string**, e isso não é teoria: `supabase/functions/omie-sync` e
`supabase/functions/omie-sync-pedidos-compra` existem os dois. Prefixo de string casaria os dois, e o
falso-positivo seria permanente.

## A auto-referência que o teste pegou antes de a suíte rodar

O arquivo de teste do motor cita edges o tempo todo (fixtures). Se ele também soletrar o nome da API
de leitura do `node:fs`, o motor **classifica o próprio teste como guardrail** e a lista nasce com um
falso-positivo fixo. Foi exatamente o que aconteceu: a primeira versão da nota que existia *para
avisar do risco* soletrou o nome no comentário. O caso `não se auto-inclui` do teste cobre isso.

## Falsificação — as quatro sabotagens do hook

Criar o hook não prova nada; `scripts/test-edge-guardrail-nudge.sh` exige o **resultado certo** em
cada caso, e cada um mata um modo de falha diferente:

| caso | entrada | esperado | o que mataria sem isso |
|---|---|---|---|
| (a) | `Write`/`Edit` de edge (inclusive caminho ABSOLUTO do worktree) | a lista sai | gate mudo = gate inexistente |
| (b) | arquivo em `src/`, migration | silêncio | ruído em todo arquivo do repo |
| (c) | `Bash` com heredoc/`grep` citando o path; `Read` do arquivo | silêncio | **a armadilha do #1778** |
| (d) | `PATH` sem `jq`; `PATH` com `jq` e sem `bun` | exit 0 e silêncio | guard que trava trabalho por bug próprio |
| (e) | 2ª edição do mesmo arquivo na mesma sessão | silêncio | nudge vira ruído e morre |

O caso (c) é o mais importante: no #1778 o `heavy-guard` casou um padrão **dentro de um heredoc** e
gravou `heavy` no `ci.yml`, quebrando o CI — **menção ≠ execução**, e aqui **menção ≠ edição**. A
defesa é dupla: o matcher só pega `Write|Edit|MultiEdit`, e o hook ainda confere `tool_name` por
dentro (o mesmo cinto-e-suspensório do `read-contexto-nudge.sh`, "defesa se o matcher mudar").

A própria suíte teve um falso-vermelho instrutivo na 1ª rodada: o caso (d) fazia
`PATH="$tmp/vazio" bash "$HOOK"`, e o **`bash`** passou a ser procurado no PATH estreitado — `rc=127`
media o interpretador ausente, não o fail-open do hook. Resolver o interpretador **antes** de
estreitar o PATH é o que faz o caso medir o que diz medir.

## Números (medidos 2026-08-18, worktree `claude/gate-guardrails-edge`)

- 676 arquivos de teste varridos; **20** são guardrails de forma de edge.
- `omie-cliente/index.ts` (o arquivo do #1772): **10** guardrails — 3 por literal próprio
  (`edge-money-path-invariants`, `erro-object-object-gate`, `segredo-em-log-gate`) + 7 por varredura.
  Os 3 literais batem exatamente com o `grep` manual.
- `_shared/cost-compute.ts`: **9** — 1 literal (`costCompute.parity.test.ts`) + 8 por varredura;
  também bate com o `grep`.
- Latência do hook: **0,2–0,7 s**, uma vez por (sessão, arquivo).

## O que ficou de fora — e é decisão, não esquecimento

O hook **avisa**; ele não **nega** no `git commit`/`gh pr create` quando o diff toca
`supabase/functions/` e a suíte não rodou verde desde a última edição. Negar é mais forte e tem
precedente (`pr-collision-guard`), mas exige guardar **estado** (hash/timestamp do último verde) —
peça que nenhum hook do repo tem hoje. Construir o estado antes de saber se o aviso basta é a
armadilha da *fase N+1 sem sinal da fase N*: entrega-se o aviso, mede-se se a classe reincide, e só
então se paga o estado.

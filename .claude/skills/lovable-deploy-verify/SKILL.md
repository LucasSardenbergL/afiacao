---
name: lovable-deploy-verify
description: >-
  Ritual de "está REALMENTE no ar?" para QUALQUER entrega neste repo (Afiação/Colacor),
  que roda em Lovable Cloud. Use SEMPRE que terminar de mergear um PR e precisar saber o que falta pra
  a mudança ir a produção, ou quando o usuário perguntar "já está no ar?", "deu pra ver no app?",
  "publiquei?", "preciso dar Publish?", "tem que deployar a edge?", "falta configurar algum secret?".
  Vale mesmo quando o usuário não
  diz "deploy" e só assume que mergear basta ("terminei, era só isso?", "pode testar agora?"). Por quê:
  o Lovable NÃO auto-deploya NADA a partir de push no GitHub — mergear na main deixa o código na main,
  mas o app continua servindo o build anterior. TRÊS coisas são manuais e independentes: (1) FRONTEND
  (Publish no editor do Lovable), (2) EDGE FUNCTIONS (chat do Lovable, ler do repo, verbatim), (3)
  MIGRATIONS (SQL Editor — coberto pela skill lovable-db-operator). E uma QUARTA que não é camada de
  código e mesmo assim trava tudo: (4) SECRET novo de edge (Edge Functions → Secrets) — sem ele a edge
  sobe Active, o cron fica verde e a função morre no 1º Deno.env.get. A skill empacota: detectar quais
  das 4 se aplicam ao diff, montar o checklist de pendências do founder, montar o prompt de deploy de
  edge, e VERIFICAR o deploy do frontend pelos bytes do bundle (hash do index + grep da string-alvo em
  TODOS os chunks). NÃO use para: a mudança de banco em si (use lovable-db-operator), escrever a feature,
  ou debugar erro de runtime no app (use /investigate).
---

# Lovable Deploy & Verify

> **v1.3 — enumeração validada em prod + Codex (2026-06-18); varredura PARALELA + QA visual (2026-07-07).**
> A verificação por bytes (Passo 4) enumera os chunks pela **UNIÃO** de duas fontes que sozinhas têm furos:
> o fechamento transitivo do grafo lazy do Vite (o entry sozinho perdia o 2º nível — 260 vs 274) e o
> precache do Workbox (`/sw.js`, que omite chunks grandes via globIgnores/maxFileSize). Empacotado em
> [`scripts/verify-frontend.sh`](scripts/verify-frontend.sh), agora com **`xargs -P` + halt-on-hit** (o
> bundle passou de 300 chunks — 1-a-1 estourava 600s; medido **~5 min → ~1 min**, mesmo exit) e rede de
> regressão local ([`evals/verify-frontend-eval.sh`](evals/verify-frontend-eval.sh)). Verificação **visual**
> pós-Publish: **Passo 4b** (Claude-in-Chrome logado). Irmã da `lovable-db-operator` (lado do banco).

## Por que esta skill existe (leia antes de qualquer coisa)

Este repo roda em **Lovable Cloud**. Há uma armadilha operacional documentada na §5/§"Deploy do FRONTEND" do CLAUDE.md:

> **O Lovable NÃO auto-deploya o frontend a partir de push no GitHub.** Mergear PR na `main` deixa o
> código na main, mas o app em `steu.lovable.app` **continua servindo o build anterior** até alguém
> clicar **Publish** no editor do Lovable.

Isso já pegou de surpresa: após mergear 6 PRs alguém disse "pronto pra QA" — mas o ar ainda era um build velho (provado nos bytes). O pior tipo de erro: **dizer "está no ar" quando não está.**

As **três** coisas são deploy manual e **independente**, e NENHUMA acontece sozinha no merge:

| Camada | Como sobe | Skill dona |
| --- | --- | --- |
| **Frontend** (app React) | **Publish** no editor do Lovable (pode precisar sincronizar com o GitHub antes — senão publica estado velho dele) | esta skill |
| **Edge functions** (`supabase/functions/`) | **chat do Lovable** (ler do repo, deploy **verbatim**) | esta skill |
| **Migrations** (`supabase/migrations/`) | **SQL Editor** (colar → Run) | `lovable-db-operator` |

## A Lei de Ferro (guardrail inegociável)

1. **Você nunca diz "está no ar" sem prova.** Mergear na main **não publica nada**. Frontend: os **bytes do bundle** confirmam (string-alvo nos chunks — Passo 4). Edge **não serve seu código**, logo não há prova por bytes — a prova é a **escada** existência (`verify-edge.sh`) → versão (Management API/painel) → comportamento (probe); `Active` sozinho prova existência, **não** que a versão nova subiu. Até lá: "mergeado na main; **falta Publish/deploy** pra ir ao ar".
2. **As camadas de deploy são independentes — sempre diga QUAIS se aplicam.** Um diff só-frontend não precisa de deploy de edge; um diff de edge precisa de deploy via chat *e* (se mexeu em UI) Publish — e, se a edge lê um `Deno.env.get` que nenhuma outra lê, o **secret** antes do deploy. Liste só o que o diff realmente toca.
3. **Edge deploy SÓ DEPOIS do merge, e VERBATIM.** Deployar "da main" antes do merge faz o Lovable ler a main **velha** (já mordeu em #383/#252 — a action nova não existia no binário → `400 "Ação desconhecida"`). E o Lovable tende a "melhorar" o código — o prompt deve mandar **não modificar/reinterpretar**, ler de `supabase/functions/<nome>/index.ts` e deployar idêntico.
4. **Verificar frontend varre TODOS os chunks, e enumerá-los é a UNIÃO de duas fontes.** Nenhuma sozinha é completa (validado em prod 2026-06-18 + Codex): (a) o **fechamento transitivo** do grafo lazy do Vite — o entry lista só o 1º nível via `__vite__mapDeps(["assets/x.js"])` (sem barra, aspas), e um lazy-dentro-de-página guarda o mapDeps no chunk DELE (entry=260, closure=274); (b) o **precache do Workbox** (`/sw.js`), que omite chunks grandes (globIgnores/maxFileSize — faltavam 6). Use a UNIÃO. Grep de literais `/assets/...` dá 0 (o bug original). Contagem 0/1 = enumeração quebrada — conserte antes de concluir.
5. **Todo artefato pro founder tem o DESTINO rotulado na 1ª linha** — `🟣 SQL Editor` / `💬 chat do Lovable` / `🖱️ Publish (editor do Lovable)` / `🔑 Secrets (Lovable → Edge Functions → Secrets)` / `⌨️ seu terminal` — e **zero placeholders** (`<VALOR>` não substituído já foi colado em produção) — e **valor de EXEMPLO plausível CONTA como placeholder, com falha PIOR, porque é CALADA**: o `<VALOR>` quebra ruidoso (404, erro de sintaxe), o número plausível devolve uma linha real de OUTRO emissor. Em 2026-08-24 um `WHERE id = 58967` inventado leu o tick do watchdog e reprovou um deploy money-path CORRETO. Campo que o founder substitui nasce sintaticamente **inválido** (`COLE_AQUI_O_REQUEST_ID`), nunca preenchido de exemplo → `deploy.md` §Canárias. JS/bash NUNCA vai pro SQL Editor (já foi colado lá 4×); o rótulo responde de antemão o "isso eu colo onde?".

## O ritual — 5 passos

Crie estes todos (TodoWrite) ao fechar uma entrega que pode precisar de deploy:

1. **Classificar o diff** — o que o PR exige de manual (frontend / edge / migration / **secret**)?
2. **Pendências do founder** — montar o checklist do que ele precisa fazer manualmente
3. **Prompt de edge** (se houver edge) — montar o handoff "ler do repo, verbatim, não melhorar"
4. **Verificar o deploy** — frontend pelos bytes; edge pela escada existência→versão→comportamento
5. **Confirmar honestamente** — só então dizer "no ar", com a evidência

---

### Passo 1 — Classificar o diff

O que o PR exige de manual? A lógica canônica — ampliada para pegar **arquivos de build na raiz**
(`vite.config`, `package.json`, …), não só `src/`, e para acusar **secret novo de edge** — vive em
[`evals/classify.sh`](evals/classify.sh) e é coberta por [`evals/run.sh`](evals/run.sh) (16 casos +
mutation-check). **Rode da raiz do repo** (a 4ª linha lê o conteúdo das edges, não só os nomes):

```bash
git diff --name-only origin/main...HEAD \
  | .claude/skills/lovable-deploy-verify/evals/classify.sh
# -> frontend=SIM|não · edge=SIM|não · migration=SIM|não · secrets=não|NOME,…|?dinamico
```

**A 4ª linha é a camada que as três não cobrem.** Um secret novo não é frontend, não é edge e não é
migration — e mesmo assim é dependência manual do founder, com o pior modo de falha que existe aqui:
edge **Active**, cron **verde**, `cron.job_run_details = succeeded`, e a função morrendo no 1º
`Deno.env.get` com 500 sem fazer nada. Descoberto no #2035 — `analytics-outbox-drain` lê
`POSTHOG_INGEST_KEY`, que nenhuma outra edge lê; naquele deploy o secret já estava configurado, o que
foi **sorte**: nenhum dos 3 passos tinha como acusar antes de rodar.

Como ler a saída:

| `secrets=` | Significa | O que fazer |
|---|---|---|
| `não` | nenhuma edge tocada lê env que as outras já não leiam | nada |
| `NOME1,NOME2` | **candidatos a secret novo** | linha 🔑 no Passo 2, **antes** do deploy da edge |
| `?dinamico` | a edge lê env por nome **computado** (`` Deno.env.get(`OMIE_${empresa}_APP_KEY`) ``) | conferir **à mão** quais nomes aquilo resolve |

⚠️ **`?dinamico` não é "não tem secret" — é "não sei".** O script resolve nome literal; nome montado em
runtime ele não resolve, e tratar isso como silêncio seria ler ausência de dado como aprovação. E a
lista é de **candidatos**: a verdade sobre o que existe é o painel de Secrets, não o repo — o script
compara o diff com as *outras* edges do repo, então secret que só este PR usa aparece mesmo que já
esteja configurado. Errar para mais custa uma linha de checklist; errar para menos custa uma edge morta.

### Passo 2 — Checklist de pendências do founder (ORDEM TRAVADA: merge → SQL → secret → edge → Publish)

**Nada de deploy antes do MERGE** (Lei de Ferro #3 — o Lovable lê da main). Entregar SÓ as linhas que se aplicam (do passo 1), NESTA ordem, cada uma com o destino rotulado:

> ⚠️ **Pra ir ao ar, falta (manual no Lovable) — nesta ordem, APÓS o merge do PR:**
> - [ ] 🟣 **SQL Editor**: migration Z *(se tocou `supabase/migrations/` — bloco da `lovable-db-operator`; banco ANTES do código que o consome)*
> - [ ] 🔑 **Secrets (Lovable → Edge Functions → Secrets)**: confirmar que `NOME_DO_SECRET` existe *(se o passo 1 deu `secrets=` com nome ou `?dinamico`)*
> - [ ] 💬 **chat do Lovable**: deploy das edges X, Y — verbatim da main *(se tocou `supabase/functions/`)*
> - [ ] 🖱️ **Publish** do frontend no editor do Lovable *(se o passo 1 deu frontend=SIM; por último — o build novo nasce contra banco/edge já atualizados)*

**O secret vem ANTES do deploy da edge, e a ordem não é estética.** Deployar primeiro sobe uma função
que responde 500 no primeiro request — e como ela fica `Active` e o cron acusa `succeeded`, a verificação
do Passo 4 pode carimbar "no ar" uma edge que não faz nada. Secret primeiro, edge depois, e o probe do
Passo 4 vira prova de verdade. **Nunca escreva o VALOR do secret no chat nem no PR** (a transcrição
persiste em disco): a linha pede ao founder para *conferir/criar* pelo nome, e o valor só existe no painel.

### Passo 3 — Prompt de deploy de edge (se aplicável)

Montar pro founder colar no chat do Lovable (um por edge tocada):

> Edit the existing edge function `<nome>` and replace its code with the current contents of
> `supabase/functions/<nome>/index.ts` from the `main` branch. Deploy it **verbatim** — do NOT modify,
> reinterpret, "improve", or reformat the code. After deploying, confirm it shows **Active**.

⚠️ Só depois do PR **mergeado** na main (Lei de Ferro #3).

⚠️ **O prompt acima nomeia UM arquivo — e a fatia que instrumenta a edge tem mais de um.** Um arquivo
basta enquanto a mudança é interna ao `index.ts`; deixa de bastar exatamente onde a verificação de
deploy nasce. **Edge que ganha sonda nasce com `versao.ts` NOVO**, importado pelo `index.ts` — pedir só
o `index.ts` manda o Lovable subir uma função cujo import não resolve, e o modo de falha é o pior
possível: quem descobre é a sonda que existia para provar o deploy. O `_shared/` que a fatia altera
entra junto no bundle daquela edge — `sonda-fingerprints.ts` alimenta o campo `fonte` da resposta;
sem ele a sonda responde `nao-mapeada` e a prova nasce cega. **Derive a lista do COMMIT, não da
memória:**

```bash
git show --name-status --format='' <sha-do-merge> -- supabase/functions/ | grep -v '_test\.ts$'
# A = arquivo NOVO (é o que o prompt de 1 arquivo esquece) · M = modificado
```

E nomeie cada um, marcando o novo (teste e doc ficam de fora — não vão pro bundle):

> Edit the edge function `<nome>` and update it from the `main` branch using the current contents of
> these files. Deploy them **verbatim** — do NOT modify, reinterpret, "improve", or reformat the code:
> - `supabase/functions/<nome>/index.ts` (modified)
> - `supabase/functions/<nome>/versao.ts` (**NEW file** — `index.ts` imports it; without it the function will not boot)
> - `supabase/functions/_shared/<módulo>.ts` (modified — shared module this function bundles)
>
> After deploying, confirm it shows **Active**.

Exercitado no #2009 (`carteira-rebuild`, 3 arquivos de código, 1 deles novo): a sonda pós-deploy voltou
`probe:true · versao:v1.0-sensor-inicial · edge:carteira-rebuild · fonte:8d2589d0…`, e o `fonte` bateu
com o `bun run sonda:fingerprint` da main — que é justamente a prova de que o `_shared/` subiu junto, e
não só o `index.ts` (#2018).

### Passo 4 — Verificar o frontend pelos bytes (após Publish)

> **Validado em produção (2026-06-18) + 2ª opinião do Codex.** Enumerar os chunks tem furos sutis:
> o entry sozinho perde o 2º nível (lazy-dentro-de-lazy, 260 vs 274); o precache do Workbox omite
> chunks grandes (globIgnores/maxFileSize, faltavam 6). Por isso a enumeração é a **UNIÃO** de (A)
> fechamento transitivo do grafo Vite + (B) precache do `/sw.js`. Tudo empacotado no script:

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh \
  --pai <sha-do-commit-ANTERIOR-ao-PR> \
  'COLE_UMA_STRING_LITERAL_UNICA_DO_COMMIT'   # 2º posicional opcional: a URL (default steu.lovable.app)
# saída: "✓ sentinela exclusiva: …" + "chunks (closure ∪ precache): N" + "✅ ALVO em <chunk>"
#        + "✓ CONTROLE_NEGATIVO_OK — <chunk> não casa controle_negativo_<hex>"   (ramo do hit)
#        + "✓ CONTROLE_POSITIVO_OK — <entry> ainda devolve bytes e o mesmo grep acha '<agulha>'"
#        + LIB_SEM_A_SENTINELA | SENTINELA_TAMBEM_NA_LIB | LIB_NAO_CONSULTADA (sonda do 2º emissor,
#          pré-rede: AVISA e nunca muda o exit — node_modules é preditor, não prova)
#        + SENTINELA_DELIMITADA (sonda da REPRESENTAÇÃO, pré-rede: o ALVO tem aspas nas PONTAS, que
#          o bundler reescreve — AVISA, nunca muda o exit; volta no ramo exit 1)
# exit 0 = no ar E o controle negativo passou · 1 = ausente E o controle POSITIVO provou que a
#          sonda enxergava (Publish pendente / alvo não-literal)
#      2 = a MECÂNICA da sonda não é confiável: enumeração quebrada, SONDA_NAO_DISCRIMINA (ramo
#          do hit) ou SONDA_CEGA (ramo ausente)
#      3 = RECUSA: uso inválido, ou exclusividade da sentinela não provada — NUNCA é veredito
#          sobre o deploy (`--novo <sha>` muda o lado positivo; default HEAD)
```

> **Varredura PARALELA (não estoura mais o timeout).** O crawl e o grep do alvo rodam com `xargs -P 8`
> (override `PAR=<n>`); o grep tem **halt-on-hit** — o 1º chunk que casa faz `exit 255` → o xargs para de
> disparar novos. O bundle já passou de **300 chunks**: 1-a-1 sequencial **estourava 600s** (medido: exit
> 124, nem terminava — era a fonte dos "4 timeouts + 4 exit 143" numa sessão); paralelo varre tudo em **~1
> min**, menos no caso comum (string presente para cedo). Cada worker escreve no próprio arquivo → **sem
> intercalação** de linhas; a lógica da UNIÃO (fechamento transitivo ∪ precache) é **idêntica**. Rede de
> regressão: `evals/verify-frontend-eval.sh` (harness local determinístico — 2º nível, precache, exit
> 0/1/2/3, guard `--pai` nos dois lados + `--falsify`; entra no gate `evals/run.sh`).

**A sentinela tem de ser EXCLUSIVA do PR que se verifica — a não-exclusiva dá falso POSITIVO
(2026-08-24).** O script acha os bytes de **qualquer** string presente no bundle, **inclusive uma
que já estava lá antes do seu PR**: se ela veio de um PR ANTERIOR que tocou o mesmo arquivo, o verde
confirma um Publish que talvez não tenha acontecido. **Por isso `--pai` deixou de ser recado e virou
guard**: com ele o script prova a exclusividade no git — e **antes de tocar a rede** — recusando com
**exit 3** em vez de varrer. Os dois lados são exigidos, nesta ordem:

| lado | o que exige | por quê |
|---|---|---|
| **positivo** (`--novo`, default HEAD) | ≥1 ocorrência em `src/` | sem ele o zero no pai é **ausência de dado** (sha ou pathspec errado, string não-literal), não prova de novidade |
| **negativo** (`--pai`) | **0** ocorrência em `src/` | é o que separa "este Publish" de "bytes de um PR anterior" |

Fail-CLOSED: fora de repo git, sha que não resolve ou `--pai` sem valor **recusam** — guard que
degrada para "não provei" não guarda nada. `command -v git` não basta (presente-porém-quebrado
esvazia o guard igual): cada consulta exige resposta POSITIVA. **Sem `--pai` o script varre igual,
mas imprime `EXCLUSIVIDADE_NAO_PROVADA`** — o verde continua sendo seu, e a lacuna fica dita.

Arquivo **QUENTE** (vários PRs no mesmo dia) é onde isso morde, e foi onde mordeu: verificando o
#1949 (`src/hooks/useLastVisit.ts`, o **terceiro** PR no arquivo depois de #1934 e #1945), a
sentinela sugerida de início foi `visita_tentativa` — que era do **#1945**, mergeado e publicado
HORAS antes. É o caso que o guard hoje recusa, rodado no repo de verdade:

```console
$ verify-frontend.sh --pai b7a9f5a8a --novo a7571a596 'visita_tentativa'
❌ [--pai] SENTINELA_NAO_EXCLUSIVA — já existia em b7a9f5a8a (…), em 2 arquivo(s) de src/:
     …:src/hooks/__tests__/useLastVisit.test.tsx:6
     …:src/hooks/useLastVisit.ts:4
   Um verde com ela confirmaria bytes de um PR ANTERIOR, não este Publish.        # exit 3

$ verify-frontend.sh --pai b7a9f5a8a --novo a7571a596 'keepalive_network'
✓ sentinela exclusiva: 0 ocorrências em b7a9f5a8a · 1 arquivo(s) em a7571a596 (pathspec src/)
```

`keepalive_network` e `time_since_last_visit_resolvido` foram as sentinelas usadas de fato. É o
**irmão** da armadilha do id de EXEMPLO (`deploy.md` §Canárias), não a mesma: lá o erro é falso
NEGATIVO (reprova um deploy correto — caro, mas a verificação CONTINUA); aqui é falso POSITIVO,
estritamente pior, porque **ENCERRA** a verificação.

**A exclusividade que o `--pai` NÃO alcança: a LIB também emite (2026-08-25, #2016).** O guard prova
exclusividade **no git** (`git grep` em `src/`) — mas o bundle servido também contém `node_modules`.
Quando a sentinela é o **nome de uma opção de API da própria lib**, existe um **segundo emissor** que
o guard não enxerga: `disable_session_recording` sai **5×** e `session_recording` **13×** do
`vendor-posthog-Do2CBfqi.js` **sozinho**, sem uma linha nossa (na `posthog-js/dist/`: 36 e 51
arquivos). O `--pai` **não recusa** aqui, e está certo — em `src/` a exclusividade é verdadeira.
Falha nos **dois** sentidos: verificar uma **ADIÇÃO** pela presença dá falso positivo (a lib já tinha
a string antes do PR), e verificar uma **REMOÇÃO** pela presença ("ainda tem ⇒ Publish pendente")
**também** — faria pedir ao founder um Publish **já feito**. Com `halt-on-hit` o veredito ainda vira
**sorte de ordem**: no #2016 o hit calhou de sair no entry e a conclusão ficou certa; saindo em
`vendor-posthog-*.js`, o `exit 0` seria verde por poluição, com a mesma cara (o controle negativo
audita o par `(padrão, grep)`, não a **proveniência** da string).

> **Receita:** ancore por **VALOR nosso**, não por **chave da lib** — `[role="button"]` e
> `input[type="checkbox"]` (nosso `css_selector_allowlist`) têm **0** ocorrências na lib, então
> localizam o NOSSO objeto de config. Aí **leia o config no contexto** em vez do grep binário:
> `grep -F -b -o '<valor>' chunk.js` para o offset + `tail -c +N | head -c M` para a janela. O objeto
> minificado é **contíguo**, então a janela mostra o config inteiro — imune à poluição, e é a única
> forma que lê uma **remoção**:
> `e.init(li,{…,disable_session_recording:!0,autocapture:{…css_selector_allowlist:["button","a","select",'input[type="checkbox"]','[role="button"]']}})`

**A sonda `SENTINELA_TAMBEM_NA_LIB` (implementada 2026-08-26)** roda pré-rede e nos **dois** modos —
a pergunta dela ("existe emissor **fora** do git?") é ortogonal à do `--pai` ("é nova **dentro** do
git?"), e sem `--pai` o operador está no modo mais fraco, que é onde calar custa mais. Ela **avisa e
nunca recusa**: `maskAllInputs` está em **10** arquivos de `posthog-js/dist/` e em **0** ocorrências
do chunk servido — tree-shaking decide o que chega ao bundle, logo `node_modules` é *preditor* do 2º
emissor e não **prova** dele, e um guard que recusasse no hit reprovaria sentinela legítima. Três
estados, e o terceiro é o que evita fabricar veredito:

| marca | quando | por quê |
|---|---|---|
| `SENTINELA_TAMBEM_NA_LIB` | a lib emite o alvo | imprime os **caminhos**: `posthog-js/dist/` lê como 2º emissor provável, `jsdom/` como devDep que nunca vai ao bundle |
| `LIB_SEM_A_SENTINELA` | 0 arquivos de código | a sentinela é sua |
| `LIB_NAO_CONSULTADA` | sem `node_modules` (ou `grep` falhou) | worktree recém-criada não tem — o `bun install` é passo à parte, e **silêncio ali se leria como "limpo"** |

O universo é **código JS** (`--include` de `*.js`/`*.mjs`/`*.cjs`), não a árvore inteira, e o corte
foi medido na `node_modules` real (637 MB / 54.843 arquivos): sem filtro custa **38-63 s** e o *valor
nosso* `input[type="checkbox"]` — a sentinela que esta própria seção recomenda — acusava 3 arquivos
(`readme.md`, `preflight.css` do tailwind, css de demo). Aviso que dispara contra a resposta certa é
aviso desarmado no primeiro dia. Com o filtro: **~2 s**, e o mesmo alvo cai para 1 (`jsdom`). Detalhe
e medições: [`docs/historico/sentinela-segundo-emissor.md`](../../../docs/historico/sentinela-segundo-emissor.md).

**A 3ª exclusividade: a sentinela é REPRESENTÁVEL no bundle? (`SENTINELA_DELIMITADA`, 2026-08-27).**
O `--pai` mede a **FONTE** (`git grep` em `src/`); a varredura mede o **BUNDLE MINIFICADO**. Para
quase toda sentinela as duas formas coincidem — menos quando a sentinela é o literal **com** seus
delimitadores: a fonte escreve `'oculta'` (aspas simples, prettier) e o esbuild emite `"oculta"`.
Medido no chunk `StaffDashboard` servido: `'oculta'` = **0** ocorrências, `"oculta"` = **1**. As duas
formas são **mutuamente exclusivas**, então nenhuma sentinela delimitada passa o guard **e** casa:

| sentinela | `--pai` | varredura | veredito |
|---|---|---|---|
| `'oculta'` | **PASSA** (0 no pai, 2 no novo) | 0 chunks | **exit 1 FALSO** — pede Publish já feito |
| `"oculta"` | **RECUSA** (0 no novo) | nem varre | exit 3 |

O primeiro é o caro, e saiu com **os três guards verdes**: `✓ sentinela exclusiva` + `✓
LIB_SEM_A_SENTINELA` + `✓ CONTROLE_POSITIVO_OK` → `❌ ALVO ausente nos 334 chunks: Publish pendente`.
O controle positivo **não** cobre isto por construção — ele prova que a rede e o `grep` funcionam,
não que a sentinela seja **representável**; são perguntas diferentes, e esta é a 3ª ortogonal
(`--pai`: "é nova DENTRO do git?" · sonda de lib: "existe emissor FORA do git?" · esta: "a forma que
eu procuro é a forma que o bundle emite?").

> **A distinção que decide:** aspas como **DELIMITADOR** o bundler reescreve; aspas como **CONTEÚDO**
> ele preserva. Só as **PONTAS** disparam — `input[type="checkbox"]` e `[role="button"]`, os "valores
> nossos" que esta seção recomenda, seguem silenciosos. Um aviso que disparasse na resposta certa
> estaria desarmado no primeiro dia (mesma lição da sonda de lib).

**AVISA e nunca recusa**, como a sonda de lib: existe sentinela legítima cujo conteúdo traz as aspas
nas bordas. E no ramo `exit 1` a marca volta, dizendo o que descartar **antes** de pedir Publish.

**O guard não prova que a sonda sabe dizer "não" — isso é o CONTROLE NEGATIVO, e ele virou
embutido (2026-08-24).** Um `exit 0` sozinho não distingue "está no ar" de "o script dá verde pra
tudo". Era recado (`verify-frontend.sh 'sentinela_de_controle_negativo_xyz'` num 2º comando,
exigindo exit≠0) — e recado depende de alguém lembrar, que é **exatamente** como a armadilha da
sentinela não-exclusiva acima passou. Agora, **quando o ALVO casa**, o script auto-audita antes de
devolver 0: reexecuta o **mesmo pipeline** (`curl`+`grep -q`+captura do `$HIT`) no **mesmo chunk que
acabou de casar**, com uma string hex aleatória nascida naquele processo. Se ela "casar" →
`SONDA_NAO_DISCRIMINA`, **exit 2**, e o `✅` acima não vale nada. Sem entropia pra gerar a string, o
script **recusa** (exit 3) antes de tocar a rede — mesma disciplina fail-closed do `--pai`.

**Por que UM chunk e não uma 2ª varredura inteira — a conta, medida em prod (2026-08-24, 334 chunks):**

| etapa | requests | tempo |
|---|---|---|
| enumeração (closure ∪ precache) | ~337 | **73 s** |
| grep do alvo, varrendo tudo (sem hit) | 334 | **18 s** |
| **controle A** — 2ª invocação completa (o recado antigo) | **+671** | **+91 s** |
| **controle A′** — embutido reusando a lista, só o 2º grep | **+334** | **+18 s** |
| **controle B** — 1 chunk, mesmo pipeline (**o implementado**) | **+1** | **+0,14 s** |

B custa **0,3%** dos requests de A′ e **0,15%** dos de A. E prova a mesma coisa: **discriminar é
propriedade do par (padrão, `grep`), não do chunk** — o padrão é o mesmo e o `grep` é a mesma
invocação, então repetir em 334 chunks é redundância, não informação nova. Os modos de falha que o
controle existe pra pegar (alvo vazio na expansão, `grep` trocado/shim, o `&&` virando `;`, `$HIT`
com lixo, `[ -n "$HIT" ]` invertido) são todos globais ao mecanismo; **nenhum** deles é visível em
334 chunks e invisível em 1. Os dois furos que sobram — servidor devolvendo conteúdo constante que
contém o alvo (fallback SPA), e alvo degenerado tipo `.*` — escapam **igualmente** de A e de B, logo
não são argumento a favor da versão cara. Roda contra prod:

```console
✅ ALVO em /assets/StaffDashboard-CM-hPkx2.js
✓ CONTROLE_NEGATIVO_OK — /assets/StaffDashboard-CM-hPkx2.js não casa controle_negativo_90896fde…
```

⚠️ **O que um controle EMBUTIDO não pode pegar, por construção:** a asserção é feita pelo próprio
script, então ele não denuncia "o script inteiro mente" (bloco do controle comentado, `exit 0`
plantado antes). Essa hipótese é de outra camada e tem dono: o gate `evals/run.sh --falsify`, que
sabota o script e **exige** vermelho — asserção externa, em commit-time. Runtime e commit-time
cobrem coisas diferentes; nenhum substitui o outro.

**O ramo `exit 1` tem o controle POSITIVO — o irmão, no ramo onde o risco se inverte.** O negativo
audita o falso **positivo**; ali o risco é o falso **negativo**: `exit 1` **afirma** "Publish
pendente", e uma sonda CEGA produz a MESMA saída — se os chunks passam a falhar (CDN 403 em
`/assets/*`, rate limit, DNS) enquanto o `index.html` ainda responde, a varredura volta vazia por não
ter enxergado nada, e o operador pede um Publish que não era necessário. Então, **antes de enunciar a
ausência**, uma **agulha** derivada do corpo do entry é procurada NO entry pelo MESMO `varre()`:

```console
✓ CONTROLE_POSITIVO_OK — /assets/index-TTF9Kw1g.js ainda devolve bytes e o mesmo grep acha '__vite__mapDeps' neles
→ ❌ ALVO ausente nos 334 chunks: Publish pendente, OU o ALVO não é literal/único no bundle
```

```console
❌ [controle] SONDA_CEGA: AGULHA_INDISPONIVEL — o corpo de /assets/index-TTF9Kw1g.js (0 bytes) não deu token de 12+ caracteres
   Logo NÃO dá pra afirmar 'ausente': varredura vazia por 'nenhum chunk casou' e por 'nenhum
   chunk RESPONDEU' são a mesma saída, e esta é a segunda.                                     (exit 2)
```

**Por que não é circular:** o corpo baixado lá no closure só **escolhe** a agulha; o veredito sai de um
`curl`+`grep` **novo**, no momento da conclusão — se a rede caiu no meio dos 18 s de varredura, é esse
request que denuncia. A agulha é **derivada, nunca fixa** (string fixa do bundle quebraria no build
seguinte e viraria `exit 2` espúrio) e **alfanumérica** — o maior token `[A-Za-z0-9_]` do corpo —
porque o `grep` dos chunks é BRE, e metacaractere mudaria a semântica do controle (mesma razão do hex
puro no negativo). Três modos de cegueira, marcas ASCII discrimináveis: `ENTRY_NAO_E_JS` (o chunk
respondeu HTML com 200 — fallback do SPA / erro; o `-f` do curl não pega, o corpo VEM, e sem esse
check a agulha nasceria do próprio fallback e casaria em si mesma), `AGULHA_INDISPONIVEL` (corpo
vazio/curto — é o caso do curl que falhou) e `AGULHA_NAO_CASOU`. **Custo:** o download do entry já
acontecia no closure e passou a ser salvo (0 request a mais ali); o controle é **1 request / 0,14 s**
sobre os 91 s do pior caso do script — **+0,15%**. Nos dois ramos a marca `CONTROLE_NEGATIVO_NAO_SE_APLICA`
continua saindo: ela diz qual dos dois controles está falando, não que falta controle.

**Sinal auxiliar de graça: o hash do chunk muda a cada build.** A saída já imprime `entry:` e
`✅ ALVO em <chunk>`, e os dois nomes carregam hash de conteúdo. **Anote-os.** Hash IGUAL ao da
verificação anterior = bundle velho, suspeite antes de comemorar — no #1949 o deploy trocou
`StaffDashboard-DzAIuK90.js` (o do #1934) por `StaffDashboard-BEQNVZMq.js`.

**Escolher a string-alvo — refactor visual NÃO tem texto novo.** A sentinela ideal é texto de UI
literal e único do commit. Mas refactor puramente visual (spinner→skeleton, cor→token, troca de
layout) não adiciona texto — e a string precisa estar em **JSX renderizado**: comentário (`//`),
teste e edge NÃO entram no bundle (mordido em prod 2026-07-07: `'identidade não provada'` só vivia
num comentário → falso "ausente", não prova nada). Duas saídas:
- **Calibrar** com uma string RENDERIZADA já existente da própria página (um `<h2>`/label antigo) —
  prova que o chunk certo está no ar + o método enumera (não é falso-negativo). Não prova a versão.
- **Provar a versão** por **assinatura estrutural** no chunk da página, baixado direto
  (`curl .../assets/<Página>-<hash>.js`): a **prop/classe NOVA presente E a marca REMOVIDA ausente**,
  as duas no MESMO chunk (uma só pode dar falso-positivo por reuso). Ex. spinner→skeleton (provado
  #1215): `variant:"detail"` presente (o `<PageSkeleton>` novo) **+** `animate-spin` ausente (o
  `<Loader2>` que saiu). Pela atomicidade do Publish (build da `main` inteira), 1 página provada ⇒ o
  lote todo no ar.
  - **Marca removida não-única** (componente eager / classe Tailwind reusada em chunks lazy): a ausência
    **global** não prova nada. Ancore o chunk-alvo pela string renderizada única do mesmo fluxo (a *Calibrar*
    acima, como localizador) e valide as TRÊS no MESMO chunk: (i) marca removida ausente, (ii) unicidade dela
    naquele escopo provada antes (`git grep` no commit pai), (iii) um **controle positivo irmão** ainda
    presente — senão chunk vazio / leitura quebrada lê como "removido". Ex. #1232 (spinner→skeleton no
    `ProtectedRoute` eager): `animate-spin text-primary`=0 (removido) **+** `animate-spin text-muted-foreground`≥1
    (gates vizinhos intocados = controle).

⚠️ Guards embutidos que dão **exit 2** (= a mecânica da sonda não é confiável; NÃO conclua "não está
no ar", conserte o script primeiro): contagem 0/1 de chunks = **enumeração quebrada** (formato do
bundler/Workbox mudou); controle negativo casando = **`SONDA_NAO_DISCRIMINA`**. Os bytes provam que o **código subiu**; se a
mudança for **visual** (renderização/comportamento na tela), a prova complementar é o **QA visual do
Passo 4b** — o maior sinal sem o founder continua sendo este, pelos bytes.

**Edge — a escada (o código da edge NÃO é servido em produção, logo não há prova por bytes):**

```bash
.claude/skills/lovable-deploy-verify/scripts/verify-edge.sh <nome> [<nome2> ...]
# N1 existência (sem auth): OPTIONS -> servida (200) vs AUSENTE (404); exit 1 se alguma 404.
# N2 versão: Management API — INDISPONÍVEL neste projeto (Supabase é da org do Lovable). NÃO peça PAT.
```

- **N1 existência** — automático e barato, mas só prova que a função está servida, **não** que é a versão nova.
- **N2 versão** — seria o canônico (`version` sobe, `updated_at` fica recente), mas aqui é **estruturalmente indisponível**: o app roda em **Lovable Cloud** e o Supabase (`fzvklzpomgnyikkfkzai`) é da **org do Lovable** — o founder não tem conta com acesso ao ref, logo **não existe Access Token que ele possa gerar**. ⛔ **Não peça o PAT** (pedido 3× já: 2× em 2026-07-23 + 1× em 2026-08-19 — nas três o agente seguiu o texto da ferramenta, não o doc). `~/.config/afiacao/supabase-pat` existe vazio: mecanismo válido, sem quem preencha. O substituto do N2 é o **rastro do commit do bot** na `main` (`Deployed …`/`Redeployed …`) — prova que UM deploy rodou, não QUAL versão.
- **N3 comportamento** — chamar com a assinatura da mudança (gated → founder logado / cron secret). Sem N2 aqui, é a **única prova de versão** que existe neste setup — não um luxo. Edge sem canária: declare "N1 + rastro; versão não provada", **nunca** "no ar".
  - **N3 pela MENSAGEM DE ERRO única — a via mais barata, e só existe enquanto algo está quebrado
    (2026-08-29, #2035).** Antes de instrumentar sonda, **leia o corpo do erro que o cron já gravou**:
    se a mensagem for única no repo (`git grep` prova), ela identifica o BUNDLE. Na
    `analytics-outbox-drain`, `{"erro":"POSTHOG_INGEST_KEY nao configurado"}` (id 62407) existia em UM
    arquivo — `index.ts:74`, criado pelo PR — logo só aquele bundle podia emiti-la: prova de VERSÃO sem
    PAT, sem canária, sem invocar nada. Bônus de graça: o 500 vem DEPOIS do `authorizeCronOrStaff`,
    então a mesma linha prova que o `x-cron-secret` do Vault está correto (errado pararia em 401).
    ⛔ Não vale para mensagem genérica (`{"error":"internal"}`) nem para string que também existe em
    `_shared/` ou noutra edge — aí prova o módulo, não a versão daquela edge. E prova o bundle que
    RESPONDEU, não que o trabalho deu certo (mesma ressalva do eco de `versao`). Detalhe:
    [`docs/historico/fail-closed-como-sensor-de-deploy.md`](../../../docs/historico/fail-closed-como-sensor-de-deploy.md).
    🔴 **A 4ª pré-condição, que as três acima não cobrem: a string tem de estar ausente do bundle
    ANTERIOR da MESMA edge (2026-08-29, #2086).** O `+` no diff prova que a **linha** é nova — não
    que a **string** seja. Na `elevenlabs-transcribe`, `{"error":"Token inválido"}` nasceu no guard
    novo de `claims.sub` e parecia perfeita, mas a mesma edge **já a emitia** no gate de assinatura
    do JWT: os dois bundles respondem 401 com o corpo idêntico, e "recebi `Token inválido` ⇒ bundle
    novo" é **falso positivo** — o erro que ENCERRA a verificação (irmão da sentinela não-exclusiva
    do Passo 4). Meça no pai, exigindo resposta POSITIVA — **zero** é a condição, qualquer outro
    número mata a via:
    ```bash
    git show <sha-do-merge>^:supabase/functions/<edge>/index.ts | grep -c '<string>'
    ```
    E confira também o repo (`git grep`): a mesma `Token inválido` sai de **10** arquivos, então nem
    a unicidade global se sustentava. Detalhe:
    [`docs/historico/escrita-de-aplicacao-como-sensor-de-deploy.md`](../../../docs/historico/escrita-de-aplicacao-como-sensor-de-deploy.md).
  - **5 edges já nascem com canária** (#1772): `fin-cashflow-engine`, `omie-cliente`, `omie-nfe-webhook`, `omie-sync-estoque`, `omie-sync-nfes-recebidas` respondem `{"probe":true}` com `{ok,probe:true,versao}` (contrato em `supabase/functions/_shared/sonda-versao.ts`). O eco `probe:true` é **obrigatório** na leitura: bundle ANTERIOR à sonda **ignora o parâmetro e executa o fluxo real** (sync Omie de verdade) — por isso **só sonde DEPOIS do deploy**, e resposta sem o eco já é o veredito "bundle velho, e ele rodou o efeito caro". Invocação sem terminal: bloco `net.http_post` no 🟣 SQL Editor + leitura de `net._http_response` (receita em `docs/agent/deploy.md` §Canárias).
  - **N3 PASSIVO — a FORMA do JSON prova a versão quando a edge JÁ é chamada por cron (2026-08-26).**
    Dispensa as duas dependências acima (founder logado / cron secret): `net._http_response` retém o
    **corpo** da resposta que o cron já produziu. Se as duas versões do código retornam objetos com
    **forma diferente** (chave presente vs ausente), o **conjunto de chaves é assinatura estrutural do
    bundle** — prova de versão sem invocar nada, e sem pagar efeito caro nenhum. Bônus: a forma nomeia a
    **ação**, então ela **não** sofre o empate da `VERSAO` compartilhada por 13 edges (o furo do lote —
    `verificar-sonda-versao.md` §7). Foi assim que o #1992 (`omie-analytics-sync`, sem canária) se
    provou: o `sync_all` velho retornava `{products, inventory, costs, assocRules}`, o novo retorna
    `{inventory, costs, assocRules}`, e o response do cron veio `assocRules, costs, inventory` ⇒ bundle novo.
    1. **Pré-condição — confira no CÓDIGO antes de ler a forma:** a chave discriminante tem de ser
       atribuída **incondicionalmente** no bundle VELHO (lá era `const products = await syncProducts(...)`
       — nem um resultado vazio a suprimiria). Se o velho fazia `if (x) r.products = …`, a ausência é
       **ambígua** e não prova nada. Prove com `git show <sha-do-merge>^:supabase/functions/<edge>/index.ts`.
    2. **Ache o response pela JANELA DE TEMPO do cron — NUNCA por id chutado.** É a Lei de Ferro #5:
       id de exemplo plausível devolve a linha real de OUTRO emissor (em 2026-08-24 um `id = 58967`
       inventado leu o tick do watchdog e reprovou um deploy money-path CORRETO). `net._http_response`
       **não tem coluna de URL** — a linha se identifica pela **forma do corpo**, não pelo id.
       ```bash
       # ⌨️ seu terminal — janela do cron; troque os dois timestamps pelo horário do run
       ~/.config/afiacao/psql-ro -c "SELECT id, created, status_code, left(regexp_replace(content,'\s+',' ','g'),400) FROM net._http_response WHERE created BETWEEN '2026-08-26 14:00Z' AND '2026-08-26 14:08Z' ORDER BY created;"
       ```
    3. **Leia a forma** do `id` que a janela identificou:
       ```bash
       # ⌨️ seu terminal — troque <ID> pelo id LIDO no passo 2 (nunca um de exemplo)
       ~/.config/afiacao/psql-ro -c "SELECT string_agg(k, ', ' ORDER BY k) AS chaves FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'data') k WHERE r.id = <ID>;"
       ```
       🔴 **Exija leitura POSITIVA — a linha de TIMEOUT devolve exatamente o veredito do método.**
       Quando o `net.http_post` estoura, a linha fica com `content` **NULL** e `status_code` **NULL**
       (medido 2026-08-26: 1 de 208, `id=60712`, `error_msg` "Timeout of 60000 ms reached"). A query
       acima então roda com **exit 0 e devolve uma linha VAZIA** — indistinguível de leitura boa, e
       "sem chaves" é justamente o veredito "chave sumiu ⇒ bundle novo". Uma execução que nem devolveu
       corpo lê-se como deploy provado: `ausente ≠ zero` na sua forma mais barata de cometer. Logo:
       `chaves` vazio/NULL = **linha inutilizável**, nunca "chave ausente" — a forma só vale se as
       **outras** chaves esperadas voltarem. Guarde o predicado (`status_code = 200` já mata o timeout;
       corpo não-nulo e não-JSON, esse sim, aborta a query com exit 1 — ruidoso e seguro):
       `AND r.status_code = 200 AND r.content IS NOT NULL AND left(ltrim(r.content),1) = '{' AND (r.content::jsonb) ? 'data'`
    4. **LIMITE — a retenção é a vida inteira desta via:** `pg_net.ttl = 6 horas` (GUC lido em prod;
       medido 2026-08-26: 208 linhas cobrindo 5h55). Run de ontem **não está lá** — fora da janela,
       volta-se ao N3 ativo. Confira o número com
       `~/.config/afiacao/psql-ro -Atc "SELECT name, setting FROM pg_settings WHERE name = 'pg_net.ttl';"`.
    5. 🔴 **O GUARD TEMPORAL — o INVERSO do limite acima, e pior que ele (2026-08-28, #2079).** O
       item 4 cobre "o run é velho demais e SUMIU": ausência honesta, que se percebe. O sentido
       inverso não se percebe — **os ticks presentes são todos ANTERIORES ao merge**. Aí a query roda
       com **exit 0** e devolve linhas perfeitamente legíveis, com o marcador VELHO, que se lê como
       "deploy pendente". É falso NEGATIVO com cara de veredito confiante, e o preço é mandar o
       founder redeployar edge money-path à toa. Medido verificando o #2079: às **23:41Z** o TTL
       tinha os ticks de 18:15, 20:15 e **22:15** contra um merge às **22:32** — todos pré-merge,
       todos ecoando `v1.0-eco-versao-passivo`, e nenhum deles dizendo coisa alguma sobre este
       deploy. O tick seguinte (**00:15Z**) provou que as edges **já estavam no ar** desde antes.
       É `ausente ≠ zero` na dimensão **TEMPO**: **anterior ≠ ausência de deploy** — irmão da regra
       do `background` (lá a coluna `modo` separa "não subiu" de "não deu tempo de coletar"; aqui a
       coluna `created` separa "não subiu" de "**ainda não foi medido**").
       **Virou SCRIPT, não recado** — recado depende de alguém lembrar, que é exatamente como a
       armadilha da sentinela não-exclusiva passou:
       ```bash
       .claude/skills/lovable-deploy-verify/scripts/verify-edge-eco.sh \
         --desde '<timestamp do merge, UTC>' \
         --esperado 'ctes=v1.1-eco-identidade-fonte,nfes=v1.2-eco-identidade-fonte' [--steps 'ctes,nfes']
       # 0 = NO AR · 1 = bundle VELHO provado (aí sim pendente) · 2 = INDETERMINADO · 3 = RECUSA
       ```
       ⚠️ **O marcador é POR EDGE, e o script RECUSA o "marcador do lote".** Edges de uma mesma leva
       partem de pontos diferentes: no #2079 quatro foram a `v1.1-eco-identidade-fonte` e a **`nfes`
       a `v1.2`** (ela vinha de `v1.1-deadline-relogio`). Um `--esperado` único aplicado a vários
       steps classificaria a divergente como bundle VELHO — o falso negativo que este script existe
       para impedir, cometido pelo próprio script. Por isso valor único só passa com **1** step útil;
       com mais, é **exit 3** pedindo o mapa (chave = step do orquestrador **ou** edge ecoada), e um
       step útil sem marcador no mapa também recusa, porque comparar contra nada fabrica veredito.
       Casado com o adendo "o marcador esperado é POR EDGE, não 'o bump do lote'" de
       [`verificabilidade-do-conjunto-orquestrado.md`](../../../docs/historico/verificabilidade-do-conjunto-orquestrado.md).
       Três coisas que ele guarda e a query crua não: **(a)** sem tick posterior ao corte ⇒ **exit 2**,
       nunca 1; **(b)** o veredito sai do **tick MAIS RECENTE** — um tick gravado entre o merge e o
       deploy ecoa o marcador velho com toda a razão, é história, e julgar por ele reprova deploy
       correto; **(c)** **fail-CLOSED** na via de leitura, inclusive presente-porém-QUEBRADA (responde
       vazio sem erro), caso em que "0 ticks" se leria como *indeterminado* em vez de *recusa* — e é
       só nele que o ping tem dente, porque com a via totalmente morta o guard da contagem já recusa
       sozinho (a 1ª sabotagem escrita saiu inócua por isso, e o eval registra o porquê).
       Rede: `evals/verify-edge-eco-eval.sh` — 12 casos + 4 sabotagens, no gate `evals/run.sh`.
    - ⛔ **Dois sinais que PARECEM discriminar deploy e NÃO discriminam** — os dois foram testados neste
      mesmo ciclo e reprovados (narrativa em `docs/historico/verificar-sonda-versao.md` §12):
      **(a) duração da execução** (`acoes_execucoes`) — o run pós-mudança caiu para 24,0 s contra a faixa
      recente de 49,5–62,6 s, mas 08-18 já fizera 24,4 s **com** o trecho no caminho: variância alta demais,
      **corrobora e não prova**; **(b) `last_page` alto em `sync_state`** — parecia provar o teto novo
      (`MAX_PAGINAS_PRODUTOS` 10 → 500), mas o cron 42 passa `"max_pages": 50` **explícito no body**, e o
      bundle velho faria as mesmas 43 páginas. Regra: **antes de ler um `last_page` como evidência de teto,
      leia o BODY do cron** — parâmetro explícito no chamador mascara o default do código.
    - ✅ **A variante DELIBERADA: plante o discriminador em vez de torcer por um (2026-08-27).** O N3
      PASSIVO acima depende de as duas versões terem forma DIFERENTE — sorte, não desenho: uma fatia que
      só muda comportamento (a coleira de relógio do #2031, por exemplo) devolve o mesmo conjunto de
      chaves e a via inteira some. A edge fecha isso de vez anexando `versao: VERSAO` a **TODA** resposta,
      não só à da sonda — um helper `jsonRes` com `{ ...body, versao: VERSAO }` (padrão dos **5 steps** do
      `omie-cron-diario`). Aí o marcador é discriminador PLANTADO: viaja no corpo que o cron já grava, e o
      `sonda:bump` obriga a movê-lo a cada fatia, o que o `versao` hardcoded da `omie-nfe-reconcile` (o
      "disfarce" de `deploy.md`) não tem. Nos steps do cron diário o corpo do filho chega aninhado —
      o orquestrador devolve cada um em `resultados.<key>.body`:
      ```bash
      # ⌨️ seu terminal — troque os dois timestamps pela JANELA do run (nunca id chutado)
      ~/.config/afiacao/psql-ro -c "SELECT r.id, r.created, k, (r.content::jsonb)->'resultados'->k->>'modo' AS modo, (r.content::jsonb)->'resultados'->k->'body'->>'versao' AS versao FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'resultados') k WHERE r.created BETWEEN '<inicio>' AND '<fim>' AND r.status_code = 200 AND r.content IS NOT NULL AND left(ltrim(r.content),1) = '{' AND (r.content::jsonb) ? 'resultados' AND jsonb_typeof((r.content::jsonb)->'resultados') = 'object' ORDER BY r.id, k;"
      ```
      🔴 **Leia o `modo` ANTES do `versao`** — é a mesma armadilha da linha de timeout, uma casa acima: em
      `modo:"background"` o orquestrador abortou o cliente em 25s (`STEP_TIMEOUT_MS`), o corpo **não foi
      coletado**, e `versao` sai vazio. Vazio ali é **linha inutilizável**, não "marcador velho" — julgar
      por ele reprova deploy CORRETO e manda redeployar edge money-path à toa (quase aconteceu em
      2026-08-27). Detalhe: `docs/historico/verificabilidade-do-conjunto-orquestrado.md`.
      🔴 **E o eco só alcança o step que CABE no `STEP_TIMEOUT_MS` — medido em prod 2026-08-28.** No
      tick pós-deploy (id 61756) três steps trouxeram o marcador e **dois vieram `background`**
      (`nfes` 4/4 dos ticks, `pedidos` 3/4). O vazio do `background` é byte a byte o vazio do bundle
      pré-sensor: **só a coluna `modo` separa "não subiu" de "não deu tempo de coletar"** — projete
      sempre as duas. Para o step que estoura, a prova continua sendo a sonda ativa, que é
      justamente onde ela custa mais (bundle pré-sensor sondado dispara a varredura). Trate o eco
      como cobertura PARCIAL e barata, não como substituto da sonda.

      ✅ **Mas o `background` é do TICK, não do STEP — acumule ticks antes de pagar a sonda ativa
      (medido 2026-08-28).** O `pedidos` veio `background` em três ticks seguidos (02:15, 06:15 e
      08:15Z) e **`respondido` com o marcador às 10:15Z** — mesma edge, mesmo bundle: o que varia é
      a carga do Omie naquele tick, não o step. Ler um `background` como "este step só se prova com
      sonda ativa" paga a sonda cara para responder o que o tick seguinte responde de graça. Regra:
      diante de `background`, **releia a janela inteira do TTL** antes de invocar — e só então
      conclua que o eco não alcança aquele step.
      ⚠️ **Ao alargar a janela, o guard de TIPO deixa de ser opcional.** Outro emissor grava
      `{"success":true,"processados":0,"resultados":[]}` — chave `resultados` como **array** (medida
      às 09:00Z) — e o `jsonb_object_keys` sobre ela **aborta a query inteira** (`ERROR: cannot call
      jsonb_object_keys on an array`): não é uma linha ruim ignorada, é o resultado todo perdido. O
      `? 'resultados'` não separa os dois casos; `jsonb_typeof(...) = 'object'` separa — já embutido
      na query acima. Falha ruidosa (exit 1), então não fabrica veredito — mas com janela estreita
      ela dorme, e é exatamente ao acumular ticks que ela acorda.

  - **N3 PASSIVO por ESCRITA DE APLICAÇÃO — a edge que o USUÁRIO chama também deixa rastro
    (2026-08-29, #2086).** As duas vias passivas acima nascem do **cron**: é ele que produz a linha em
    `net._http_response`, e ela morre no `pg_net.ttl = 6 h`. Edge chamada por **usuário** (transcrição,
    upload, copiloto) nunca aparece lá — a escada caía direto no N3 ativo, que aqui custa o founder
    logado. Mas quando a fatia nova **ESCREVE em tabela de aplicação**, essa escrita é assinatura do
    bundle do mesmo jeito: **dura 7 dias** (não as 6 h do `pg_net`), não depende de cron e não
    invoca nada. ⚠️ A 1ª versão desta seção dizia "**não expira**", e era **falso**: o cron
    `ia-uso-evento-purga` (`23 4 * * *`, `active=t` medido em prod) apaga
    `criado_em < now() - interval '7 days'`. Janela maior que a do `pg_net`, e finita. O #2086 pôs gate de
    cota na `elevenlabs-transcribe`; o gate chama a RPC `ia_consumir_cota`, que faz `INSERT INTO
    public.ia_uso_evento (user_id, funcao)`. O bundle velho **nem importava** `_shared/ia-cota.ts` —
    logo é **incapaz** de emitir a linha. Quatro linhas entre 00:32:26Z e 00:33:27Z contra o merge às
    **00:17:10Z** provaram o deploy sem PAT, sem canária e sem sondar nada.
    1. **As três condições — sem elas a presença não separa versão:**
       **(a) a escrita é EXCLUSIVA do bundle novo** (irmão do `--pai`): o velho tem de ser *incapaz*,
       não apenas improvável — prove no diff que a linha que escreve **nasceu** no PR (o `import` do
       módulo saiu como `+`). Se ele já escrevia na mesma tabela com o mesmo discriminador, presença
       não diz nada.
       **(b) o discriminador nomeia a EDGE** — aqui a coluna `funcao` carrega o slug, e `git grep` do
       slug em `origin/main` acha **um** caller (o `index.ts` da própria edge). Sem isso prova-se o
       módulo `_shared/` compartilhado, não a versão daquela edge — mesma ressalva da mensagem única.
       **(c) nenhum 2º emissor** — o frontend chama a **EDGE**, não a RPC, e o harness roda em PG17
       local. O que o `git grep` **não** fecha é a mão no 🟣 SQL Editor, então leia o **padrão**: as 4
       do mesmo `user_id` vieram espaçadas em **segundos a dezenas de segundos** (22/27/12 s — tempo
       de gravar áudio), e isso é uso de app; rajada de milissegundos ou `user_id` sem sessão é teste
       manual. **Sem linha em `profiles` NÃO desqualifica**: aqui o `EXISTS` deu `f` e eram gravações
       reais pelo microfone (cadastro em `/auth` é aberto; alias fiscal sem `profiles` é legítimo) —
       quem fechou foi **perguntar ao founder**. Meça o vínculo com `EXISTS(...)`:
       `coalesce(p.name,'…')` em LEFT JOIN lê igual para "não existe linha" e "coluna NULL".
    2. 🔴 **A direção é uma só: presença prova, ausência NÃO reprova.** Zero linhas pode ser "não
       deployou" **ou** "ninguém usou a feature", e edge de usuário não tem denominador que separe os
       dois. `ausente ≠ zero` de novo: sem chamada não houve medição, e "0 linhas" lê-se
       **INDETERMINADO**, nunca "deploy pendente". É a metade boa do guard temporal do #2079 — lá o
       risco era ler tick PRÉ-merge como pendência; aqui a evidência só pode existir **depois**, então
       o erro possível custa uma espera, não um redeploy à toa de edge money-path.
    3. 🔴 **O controle negativo prescrito aqui NÃO MATERIALIZAVA — corrigido 2026-08-29.** A 1ª
       versão mandava ler `GROUP BY funcao` sobre `ia_uso_evento` e afirmava que as vizinhas com
       limite configurado "saem em zero na mesma leitura". **Não saem:** `GROUP BY` só produz
       grupos que **têm** linhas. Rodado em prod, devolveu **uma** linha (a própria edge) e as três
       vizinhas não apareceram — nem como zero. Quem seguisse a receita ao pé da letra registrava
       "controle negativo passou" **sem ter observado nada** — e a própria seção se contradizia, já
       que o comentário do bloco dizia `linha única`. Para o controle EXISTIR, o universo tem de vir
       da tabela de **LIMITES** unida ao alvo (só os limites esconderia o alvo se a config dele fosse
       removida). Isto e os guards abaixo são hoje do **script**, não da sua memória:

       ```bash
       .claude/skills/lovable-deploy-verify/scripts/verify-edge-escrita.sh \
         --desde '<timestamp do merge, UTC>' --funcao '<slug da edge>'
       # 0 = BUNDLE_NOVO_OBSERVADO_EM_T · 2 = INDETERMINADO · 3 = RECUSA
       # 🔴 NENHUM exit significa "bundle velho": a via é unidirecional por construção.
       ```

       Ele materializa o controle (`CONTROLE_CRUZADO_OK`), **diz quando não pôde observá-lo**
       (`CONTROLE_CRUZADO_NAO_OBSERVADO`, universo só com o alvo — nunca "passou"), e **recusa**
       quando a query não discrimina (`CORRELACAO_SUSPEITA`: toda vizinha com o mesmo total é a
       assinatura do filtro solto contando a tabela inteira). Rede: `evals/verify-edge-escrita-eval.sh`
       — 17 casos + 4 sabotagens, no gate `evals/run.sh`.
    3b. 🔴 **A presença prova PASSADO, não estado ATUAL (2ª opinião, Codex).** Uma linha pós-merge
       prova que o bundle novo atendeu ≥1 chamada **naquele instante** — não que ele siga no ar: um
       redeploy ou revert posterior deixa o rastro **intacto**. Por isso o exit 0 se chama
       `BUNDLE_NOVO_OBSERVADO_EM_T` e a saída repete que não é "versão atual confirmada". Para
       afirmar "está no ar AGORA" continua sendo preciso sonda viva ou marcador observado **depois
       do último deploy possível**.
    3c. ⚠️ **O join de proveniência é `profiles.user_id`, NUNCA `profiles.id`.** A tabela tem as
       **duas** colunas e a FK de `ia_uso_evento` aponta para `auth.users(id)`, que casa com
       `profiles.user_id`. Com `p.id` o join devolve "sem profile" para usuário legítimo — falso
       sinal de "`user_id` inventado" bem no teste da condição (c), que foi onde mordeu. A **role**
       (`master`/`employee`) vive em `public.user_roles`, não em `profiles`; e `auth.users` é
       **inacessível** ao `claude_ro` (`permission denied for schema auth`), então a identidade só se
       lê por `profiles`. O script já faz os dois joins certos.
    4. **Leia onde o INSERT mora no código ANTES de ler a linha.** Em `ia_consumir_cota` ele fica
       **depois** de todos os `RETURN` de bloqueio, então a linha prova chamada **PERMITIDA** — e de
       quebra que a migration do limite entrou **antes** do deploy (bloqueada teria voltado 503
       `sem_limite` sem gravar nada). INSERT incondicional provaria só a chamada: a diferença é o que
       você pode afirmar depois.
    ```bash
    # ⌨️ seu terminal — só se precisar ler à mão o que o script já lê. O timestamp NASCE inválido
    # de propósito (Lei de Ferro #5): troque pelo do SEU merge, em UTC.
    # ⚠️ O universo parte de `ia_uso_limite` UNIDO ao alvo — NÃO de um `GROUP BY` sobre
    #    `ia_uso_evento`, que não materializa as vizinhas em zero e mata o controle negativo.
    ~/.config/afiacao/psql-ro -c "WITH universo AS (SELECT funcao AS f FROM public.ia_uso_limite UNION SELECT 'COLE_O_SLUG_DA_EDGE') SELECT u.f, (SELECT count(*) FROM public.ia_uso_evento e WHERE e.funcao = u.f) AS total, (SELECT count(*) FROM public.ia_uso_evento e WHERE e.funcao = u.f AND e.criado_em > 'COLE_O_TIMESTAMP_DO_MERGE_UTC') AS pos_merge FROM universo u ORDER BY 2 DESC, 1;"
    ```

### Passo 4b — QA visual pós-Publish (Claude-in-Chrome na sessão logada do founder)

Os bytes (Passo 4) provam que o **código subiu** — não que a tela **renderiza/comporta** certo. Refactor
puramente visual (spinner→skeleton, layout, token de cor) e perguntas de tela ("cadê os R$ 5,1 mi neste
painel?") pedem **olho**. Duas armadilhas já registradas — **não repita**:

- **`/browse` do gstack (headless) NÃO serve:** a SPA React **não monta** nele (3 falhas). Não é bug do
  browse — é headless sem o runtime da app.
- **Chrome MCP genérico** deu timeout CDP de 45s em outra sessão.

**O que FUNCIONA** (caso de sucesso real: o agente configurou o PostHog inteiro sozinho): **Claude-in-Chrome
no Chrome REAL logado do founder.** A sessão autenticada (login/RLS/lente "Ver como") já está viva na aba
dele — o agente **navega e confere**, em vez de devolver a verificação pro olho do founder ("não achei os
R$ 5,1 mi nessa tela, quer entrar e ver?").

**O padrão (inverte o ônus — o AGENTE confere, não o founder):**
1. **Handoff do founder = 1 clique:** abrir o app logado (`steu.lovable.app`) no Chrome real com a extensão
   **Claude-in-Chrome** conectada. É o ÚNICO passo manual — sem sessão autenticada não há como ler tela
   gated (login/RLS/impersonação).
2. **Carregar as tools numa chamada só** (são *deferred*): `ToolSearch` →
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__computer`
   (não uma-a-uma — cada `ToolSearch` é um round-trip).
3. **`tabs_context_mcp`** acha a aba já aberta → **`navigate`** pra rota-alvo → **`read_page`**/screenshot lê
   o estado renderizado → **`computer`** só se precisar interagir (abrir menu, filtrar, paginar).
4. **Assertar o que a mudança prometia** (o número aparece? o skeleton no lugar do spinner? o fluxo
   completa?) e **reportar com a evidência lida** (texto/print) — nunca "deve estar ok".

⚠️ **Escopo & segurança:** é a sessão REAL do founder — **só LEITURA/navegação de QA**; nada de
escrita/ação destrutiva/mover dinheiro sem ele pedir (valem as regras de Chrome/computer-use; URL de
origem duvidosa: confirmar antes). Sem a aba logada aberta, **degrade honesto:** "bytes provam que subiu
(Passo 4); a renderização eu confirmo quando você abrir o app logado no Chrome (Passo 4b)."

**Exercitado 2026-07-08 (o que esperar antes de tentar):** a aba que a extensão controla é um **contexto
próprio** — **não herda** a sessão de outra aba/perfil só porque o founder está logado no Chrome. No teste,
`steu.lovable.app` caiu direto no **`/auth`** e o console trouxe `AuthApiError: Invalid Refresh Token:
Refresh Token Not Found` (o Supabase guarda a sessão em `localStorage` **por origem**; a aba MCP não tinha a
chave). Consequências práticas:
- **RENDER + telas públicas o agente confere SOZINHO** — a SPA React **monta de verdade** aqui (o que os
  bytes NÃO provam e o `/browse` headless não faz); `/auth`, landing e afins são QA legítimo sem login.
- **Telas gated exigem o founder logar NA aba do grupo MCP** (`tabs_context_mcp` → ele loga ali), não em
  outra aba. Detecção barata de "sem sessão": redirect pra `/auth` **ou** `read_console_messages` com o erro
  de refresh token → **degrade e peça o login; o agente NUNCA digita credenciais** (linha vermelha).
- Sanidade útil de graça: `read_console_messages onlyErrors` na tela renderizada — mas o `Invalid Refresh
  Token` numa aba deslogada é **esperado** (fail-closed do auth), não regressão.

**Exercitado 2026-07-12 (QA do #1300 — o "404 fantasma" pós-Publish):** rota NOVA deu **404 com os bytes
PROVADOS no ar** (Passo 4 verde). Não era o Publish — era o **service worker do PWA servindo o build
ANTERIOR** na aba: a SPA velha monta (título ok) e o catch-all loga `404 Error: User attempted to access
non-existent route` vindo de um chunk `NotFound-*.js` de hash VELHO (a assinatura no console). **Hard-reload
(Cmd+Shift+R) na aba ativa o SW novo** e a rota monta. Regras práticas:
- Bytes verdes + 404 na tela ⇒ **suspeite do SW antes de suspeitar do Publish** — nunca conclua "não subiu"
  contra o Passo 4 sem hard-reload.
- Vale pros USUÁRIOS também: quem já tinha o app cacheado vê o build antigo no 1º acesso pós-Publish —
  reload resolve (design offline-first, não regressão). Mudança de ROTA nova demora 1 ciclo de SW pra
  chegar em quem não recarrega.

### Passo 5 — Confirmar honestamente

- Frontend: "✅ no ar — `ALVO` presente em `<chunk>`, entry hash `<novo>`" **ou** "❌ ainda o build velho (hash inalterado / alvo ausente) — Publish pendente".
- Edge: nunca "Active = no ar" (Active só prova existência). Diga o NÍVEL provado: "✅ N2 — version subiu + updated agora" / "✅ N3 — probe `<assinatura>` confere" **ou** "só N1 (existe); versão não confirmada — falta PAT/founder".
- Nunca um "pronto!" genérico sem uma dessas evidências por camada tocada.

---

## Smoke E2E autônomo (carimbo de SHA + monitor)

O build **carimba o commit no bundle** (`vite.config` → `define __COMMIT_SHA__`; `main.tsx` →
`window.__BUILD_SHA__`). Com isso o monitor responde "**o ar == `origin/main`?**" sem adivinhar um ALVO:

```bash
.claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh [url] [sentinela]
# exit 0 = sincronizado · 3 = ATRASADO (Publish pendente) · 4 = deploy novo, versão indeterminada
```

- **Determinístico** quando o ar tem `__BUILD_SHA__="<sha>"` — compara com `origin/main`.
- **Fallback**: se vier `"dev"` (Lovable sem `.git` no build) ou ausente (build pré-carimbo), passe uma
  `sentinela` (string de UI única do HEAD) → o monitor cai pro `verify-frontend.sh`.
- **Agendar** (cron de sistema, sem gastar Claude): `*/30 * * * * cd <repo> && bash .../monitor-deploy.sh
  >> ~/.config/afiacao/deploy-monitor.log 2>&1` (exit 3/4 = avisar; combine com `osascript`/email).

⚠️ **Confirmado em prod (2026-06-26):** o ar serve `__BUILD_SHA__="dev"` — o build do Lovable roda **sem
`.git`**, então o carimbo nunca materializa um SHA real e o caminho determinístico é **inviável neste host**.
Consequência operacional: o monitor **depende SEMPRE da sentinela** (2º arg) — sem ela, exit 4 ("indeterminado")
a cada run. E **passe a URL com `https://`**: sem esquema, o `curl` (sem `-L`) volta vazio e o monitor reporta
falso `"fora do ar"` (exit 2) — não é o site caído, é a URL malformada.

## Referências
- CLAUDE.md §"Deploy do FRONTEND (app) — Publish MANUAL no Lovable" (a técnica dos bytes; armadilha do chunk de nome inesperado)
- CLAUDE.md §"Edge functions — caminho oficial Lovable" (deploy via chat, ler do repo, verbatim)
- CLAUDE.md §5 lições #383/#252 (deployar edge só após merge), #608 (verificação por bytes usada com sucesso)
- Skill irmã `lovable-db-operator` (camada de banco)

## Estado / pendências
- [x] Enumeração = **UNIÃO** (fechamento transitivo do Vite ∪ precache do Workbox) — nenhuma fonte sozinha é completa (closure 274 ⊃ precache 268; precache omite 6). Validado em prod + Codex; empacotado em `scripts/verify-frontend.sh`.
- [x] **Controle negativo EMBUTIDO (2026-08-24):** deixou de ser 2º comando manual e passou a rodar
  sozinho no ramo do hit — mesmo pipeline, mesmo chunk, string hex aleatória do processo; casou =
  `SONDA_NAO_DISCRIMINA` + exit 2. Escolhido o controle de **1 chunk** sobre a 2ª varredura completa
  com número, não opinião (prod, 334 chunks: **1 req / 0,14 s** contra **334 req / 18 s** ou **671 req
  / 91 s**), porque discriminar é propriedade do par (padrão, `grep`) e não do chunk. Harness: +4 casos
  e +2 sabotagens (grep degenerado → o controle acusa; controle trocado por string que DEVE casar →
  prova que ele exercita a rede e não é enfeite). Detalhe no Passo 4.
- [x] **Controle POSITIVO no ramo `exit 1` (2026-08-25):** a lacuna acima fechada — "ausente" só é
  ENUNCIADO depois de o script provar que ainda enxerga, com uma agulha DERIVADA do corpo do entry
  procurada pelo MESMO `varre()`; cega → `SONDA_CEGA` + exit 2, nunca exit 1. **+1 request / 0,14 s
  sobre 91 s (+0,15%)**, porque o download do entry já acontecia no closure. Harness: +4 casos (2
  fixtures novos — `site-cego` com `/assets/*` em 404 e `site-fallback` servindo HTML com 200) e +3
  sabotagens. E um furo do PRÓPRIO harness saiu junto: `falsify_case` aceitava o `exit_normal`
  **declarado**, então uma sabotagem escrita antes da feature ficava verde sem sabotar nada — agora
  o normal é **medido** no script real antes de comparar. Detalhe no Passo 4.
- [x] `evals/` = **gate dos 2 passos**: classificação de diff (8 casos, Passo 1) **+** verificação por bytes (harness local `verify-frontend-eval.sh`, Passo 4: 2º nível, precache, exit 0/1/2), ambos com `--falsify`. Um `bash evals/run.sh` cobre tudo.
- [x] Domínio canônico `steu.lovable.app` confirmado (HTTP 200).
- [x] **Edge:** verificação por escada — N1 existência (`verify-edge.sh`, OPTIONS, automático) · N2 versão (Management API — indisponível aqui: Supabase da org do Lovable, não peça PAT) · N3 comportamento (probe gated). Fecha a assimetria com o frontend.
- [x] **N3 PASSIVO pela forma do JSON (2026-08-26, #1992 `omie-analytics-sync`):** a escada assumia N3
  **ativo** — logo dependente do founder (bloco `net.http_post`) ou do cron secret. Para edge que **já é
  chamada por cron** existe via passiva que dispensa as duas: o conjunto de chaves do corpo em
  `net._http_response` é assinatura estrutural do bundle (`{products,…}` → `{…}` sem `products`), e ela
  nomeia a AÇÃO, escapando do empate da `VERSAO` compartilhada (§7 de `verificar-sonda-versao.md`).
  Vale **só dentro de `pg_net.ttl = 6 h`**; o response se acha por **janela de tempo**, nunca por id
  chutado. Reprovados no mesmo ciclo, e registrados como anti-sinais: **duração da execução** (variância
  maior que o efeito) e **`last_page` alto** (o cron 42 passa `max_pages` explícito, mascarando o default).
  Detalhe no Passo 4.
- [x] **Smoke E2E autônomo:** carimbo de SHA no build (`__BUILD_SHA__`) + `monitor-deploy.sh` (cron) compara o ar vs `origin/main`. **Exercido em prod 2026-06-26** (pós-Publish do #1065): o carimbo está no ar mas vem `"dev"` (Lovable builda sem `.git`) ⇒ SHA determinístico inviável neste host; **fallback de sentinela validado ponta-a-ponta** (`get_ultimos_precos_cliente` PRESENTE → exit 0). Regra firmada: no cron, **sentinela obrigatória + URL com `https://`** (ver ⚠️ acima).
- [x] **Varredura PARALELA (2026-07-07):** `xargs -P 8` no crawl + halt-on-hit (`exit 255`) no grep do alvo. O bundle passou de 300 chunks (união medida 308–560) — sequencial estourava 600s (exit 124, não terminava); no mesmo bundle (308 ch, sentinela ausente) **299s → 61s (~4,9×), mesmo exit**. Enumeração/UNIÃO **inalterada** (worker-por-arquivo → sem intercalação). `PAR=<n>` overridável. Rede: harness local + gate `run.sh`.
- [x] **QA visual pós-Publish (Passo 4b, 2026-07-07):** padrão documentado — **Claude-in-Chrome na sessão logada do founder** (ele abre 1×, o agente confere as telas). `/browse` headless não monta a SPA (3 falhas); Chrome MCP genérico deu timeout CDP de 45s. Caso de sucesso: config do PostHog feita pelo agente sozinho. **Exercitado 2026-07-08:** RENDER confirmado (a SPA monta no Chrome real; QA de tela pública `/auth` OK) — mas a aba do grupo MCP veio **sem sessão** (`Invalid Refresh Token`), então **telas gated dependem do founder logar NA aba MCP**; agente nunca digita credenciais. Detalhe no Passo 4b.
- [x] **"404 fantasma" pós-Publish (2026-07-12, QA visual do #1300):** rota nova 404 com bytes VERDES = **SW do PWA servindo o build anterior** (assinatura: `NotFound-*.js` de hash velho logando "non-existent route"); hard-reload ativa o SW novo. Regra: bytes verdes + 404 → suspeitar do SW, nunca concluir "Publish falhou" sem hard-reload. Detalhe no Passo 4b.
- [x] **O prompt do Passo 3 nomeia TODOS os arquivos da fatia (2026-08-25):** o de 1 arquivo (`index.ts`)
  quebra justamente na fatia que instrumenta a edge — **`versao.ts` é arquivo NOVO** e o `index.ts` o
  importa, então deployar só o `index.ts` sobe função que não boota, e quem descobre é a sonda que
  existia para provar o deploy. A lista sai do `git show --name-status` do merge (`A` = novo), não da
  memória. Exercitado no #2009 (`carteira-rebuild`): 3 arquivos de código, e o `fonte` da sonda
  pós-deploy batendo o `sonda:fingerprint` provou que o `_shared/` subiu junto (#2018).
- [x] **3ª sonda — `SENTINELA_DELIMITADA` (2026-08-27):** o `--pai` mede a FONTE e a varredura mede o
  BUNDLE MINIFICADO, e para o literal COM delimitadores as duas formas são **mutuamente exclusivas**
  (medido no chunk servido: `'oculta'`=0, `"oculta"`=1) — `'oculta'` passa o guard e dá **exit 1
  FALSO** ("Publish pendente" sobre fix JÁ no ar), `"oculta"` é recusada antes de varrer. Saiu com os
  **três** guards verdes; o CONTROLE_POSITIVO não cobre por construção (prova que a rede/grep
  funcionam, não que a sentinela seja REPRESENTÁVEL). Só as PONTAS disparam, então
  `input[type="checkbox"]` — a sentinela que o Passo 4 recomenda — segue silenciosa. AVISA e nunca
  recusa, como a sonda de lib. Rede: 3 casos bidirecionais + sabotagem `falsify_marca` (o fixture
  nunca modelou isto — bundle fake não é minificado, sentinela idêntica nos dois universos).
- [x] **GUARD TEMPORAL do N3 passivo (2026-08-28, verificando o #2079):** a skill cobria o TTL só no
  sentido "run velho SUMIU ⇒ N3 ativo"; o inverso — **TTL cheio, mas só de ticks PRÉ-merge** — devolvia
  linhas legíveis com o marcador velho e se lia como "deploy pendente" (falso NEGATIVO, que **encerra**
  a verificação com um pedido caro ao founder). Virou `scripts/verify-edge-eco.sh`: sem tick posterior
  ao corte ⇒ **exit 2 INDETERMINADO**, nunca 1; veredito pelo **tick mais recente** (o intermediário
  entre merge e deploy é história); fail-closed inclusive na via presente-porém-quebrada. Rede:
  `evals/verify-edge-eco-eval.sh` (12 casos + 4 sabotagens) no gate. A falsificação pagou DUAS vezes:
  a sabotagem do ping saiu **inócua** e revelou que ele só tem dente contra a via MUDA (não contra a
  morta, onde a contagem já recusa); e o `--esperado` único — que o script aceitava — reprovaria a
  `nfes` (v1.2) como bundle velho num lote v1.1, então **valor único agora recusa** com >1 step útil.
- [x] **N3 PASSIVO por ESCRITA DE APLICAÇÃO (2026-08-29, #2086 `elevenlabs-transcribe`):** as duas vias
  passivas anteriores nascem do cron e morrem no `pg_net.ttl = 6 h` — edge chamada por **usuário** não
  passa por nenhuma delas, e a escada caía no N3 ativo (que custa o founder logado). Quando a fatia nova
  escreve em tabela de aplicação, a escrita é assinatura do bundle com janela de **7 dias**: o gate de cota insere em
  `ia_uso_evento(user_id, funcao)` e o bundle velho, que nem importava `_shared/ia-cota.ts`, é **incapaz**
  de produzir a linha — 4 delas 15 min após o merge provaram o deploy sem PAT, sem canária, sem invocar
  nada. Vale só na direção **presença**: ausência é "ninguém usou", não "não subiu". Controle negativo de
  graça (as vizinhas com limite configurado saem em zero na mesma query), desde que o `GROUP BY` não seja
  filtrado pela edge. Detalhe no Passo 4.
- [x] **A via da ESCRITA virou SCRIPT, e a receita em prosa tinha 4 furos (2026-08-29):** ela
  nasceu no #2086 e apodreceu em 3 dias — verificando as 3 edges do chip de 01:50Z, todos apareceram.
  **(1)** O controle negativo prescrito (`GROUP BY funcao` sobre `ia_uso_evento`) **não
  materializava**: `GROUP BY` não produz grupo vazio, então as vizinhas nunca saíam "em zero" e o
  operador registrava "controle passou" sem observar nada — a seção se contradizia sozinha, com
  `linha única` escrito no próprio comentário. **(2)** O join de proveniência usava `profiles.id`
  quando a chave é `profiles.user_id` (a tabela tem as duas), devolvendo "sem profile" para usuário
  legítimo — falso sinal de "`user_id` inventado" bem na condição (c). **(3)** A 2ª opinião (Codex,
  `gpt-5.6-sol` xhigh) achou o furo maior: a escrita prova **passado**, não estado atual — redeploy
  ou revert posterior deixa o rastro intacto, então o exit 0 é `BUNDLE_NOVO_OBSERVADO_EM_T` e nunca
  "versão atual". **(4)** E o "**não expira**" era literalmente falso: o cron `ia-uso-evento-purga`
  (`23 4 * * *`, `active=t` em prod) apaga acima de **7 dias**. Virou
  `scripts/verify-edge-escrita.sh` (universo = limites ∪ alvo; `CONTROLE_CRUZADO_OK` /
  `_NAO_OBSERVADO` / `CORRELACAO_SUSPEITA`; fail-closed na via; **nenhum** exit significa "bundle
  velho"), com `evals/verify-edge-escrita-eval.sh` — 17 casos + 4 sabotagens — no gate. A
  falsificação pagou de novo: a sabotagem do ping saiu **inócua** contra a via totalmente muda
  (o guard do universo vazio recusa sozinho), e só mordeu no cenário `psql_mudo_parcial` — via que
  cala no ping mas ainda devolve linhas, onde sem o ping o script leria via quebrada como "ninguém
  usou a feature". Mesma lição que o eval do `verify-edge-eco` já tinha registrado, redescoberta
  medindo.
- [ ] (menor) Confirmar se há ambiente de **preview** distinto do publicado a checar.

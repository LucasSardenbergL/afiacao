# A sentinela que a PRÓPRIA LIB também emite — o guard prova exclusividade no GIT, o bundle servido tem `node_modules`

**Classe:** o guard `--pai` do [`verify-frontend.sh`](../../.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh)
prova que a sentinela é **exclusiva do PR que se verifica** — mas prova isso **no git**, com
`git grep` em `src/`. O que o `curl` baixa **não é `src/`**: é o bundle, e o bundle carrega
`node_modules`. Quando a sentinela é o **nome de uma opção de API da própria lib**, existe um
**SEGUNDO EMISSOR** que o guard não enxerga — e o verde pode vir da **lib**, não do seu Publish.

Descoberto em 2026-08-25 verificando o Publish do **#2016** (`4c6e30f2a` — Session Replay desligado
em `src/lib/analytics.ts`). O `--pai` **não recusou** — e estava certo em não recusar: em `src/` a
exclusividade era verdadeira. O furo não é do guard; é do **universo que ele mede**.

É o irmão de fora da família da sentinela não-exclusiva já documentada na skill (§Passo 4): lá o
segundo emissor é um **PR anterior nosso**, dentro do git, e o `--pai` o pega. Aqui o segundo
emissor está **fora do git**, e nenhum `git grep` chega nele.

## O que foi medido

**Servido em produção** (`steu.lovable.app`, 2026-08-25) — o chunk da lib, **sozinho, sem uma linha
nossa**:

| chunk | string | ocorrências |
|---|---|---|
| `/assets/vendor-posthog-Do2CBfqi.js` (186 KB) | `session_recording` | **13** |
| `/assets/vendor-posthog-Do2CBfqi.js` | `disable_session_recording` | **5** |

**Na fonte da lib** (`node_modules/posthog-js/dist/`, instalada **1.373.4**) — contagem de **arquivos** que
contêm a string:

| string | arquivos |
|---|---|
| `session_recording` | 51 |
| `maskAllInputs` | 37 |
| `maskTextSelector` | 37 |
| `disable_session_recording` | 36 |

Ou seja: **quatro das sentinelas mais naturais** para verificar aquele PR — todas elas o nome de
uma opção do `posthog.init()` — já estavam no bundle **antes** do PR existir.

## A consequência corta nos DOIS sentidos

O teste ingênuo (`grep` binário presente/ausente) falha **dos dois lados**, e é isso que torna a
classe pior que a da sentinela não-exclusiva:

| o que se verifica | leitura ingênua | veredito real |
|---|---|---|
| uma **ADIÇÃO** (`disable_session_recording` passou a existir) | "achei ⇒ está no ar" | **falso POSITIVO** — a lib já tinha a string antes do PR |
| uma **REMOÇÃO** (a config de replay saiu) | "ainda tem `session_recording` ⇒ Publish pendente" | **falso POSITIVO do TESTE também** (a string casou por poluição) — que aqui se traduz em **reprovar um deploy correto**: pedir ao founder um Publish **já feito** |

O segundo é o que quase mordeu. Ele não se apresenta como "verde por engano": apresenta-se como
**diligência** — o agente encontra a string, conclui responsavelmente que falta deploy, e manda o
founder repetir uma viagem manual já paga. A ausência de dado (a lib emite a string) vira um
**veredito sobre o deploy**, que é exatamente a fabricação que a regra de evidência positiva
proíbe (`evidencia-positiva-shell.md`).

## Agravante: com `halt-on-hit`, o veredito depende da ORDEM

O script para no **primeiro** chunk que casa (`exit 255` mata o `xargs`) — decisão certa e medida,
pelo custo. Mas ela troca "existe em algum chunk" por "existe **naquele** chunk", e **não diz qual
emissor respondeu**. Com sentinela poluída, "qual respondeu" é a pergunta inteira.

Nesta verificação o hit **calhou** de sair no entry — nosso chunk — e a conclusão final ficou
certa. **Por sorte de ordem.** Se tivesse saído em `vendor-posthog-*.js`, o `exit 0` seria verde
por poluição, com **a mesma cara**: mesma linha `✅ ALVO em <chunk>`, mesmo controle negativo
passando (ele audita o par `(padrão, grep)`, não a **proveniência** da string), mesmo exit code.

Nenhum dos controles embutidos pega isto, e não é falha deles: o negativo pergunta "a sonda sabe
dizer não?", o positivo pergunta "a sonda ainda enxerga bytes?". Nenhum dos dois pergunta **"de
quem é essa string?"**.

## A saída que funcionou: ancorar por VALORES nossos, não por CHAVES de config

A régua é curta: **a chave é o vocabulário da LIB; o valor é NOSSO.** `disable_session_recording` é
da posthog — ela documenta, testa e carrega essa string na própria fonte. Já
`input[type="checkbox"]` e `[role="button"]` são o que **nós** escolhemos pôr no
`css_selector_allowlist` — **0 ocorrências** em toda a `node_modules/posthog-js/dist/`. Eles não
provam a config sozinhos: eles **localizam o nosso objeto de config** dentro do bundle.

Aí o passo que muda tudo: em vez do `grep` binário presente/ausente, **baixar o chunk e LER o
config no contexto**. Rodado contra prod, 2026-08-25:

```console
$ curl -fsS https://steu.lovable.app/ | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | sort -u
/assets/index-DEduE7xC.js

$ curl -fsS https://steu.lovable.app/assets/index-DEduE7xC.js -o entry.js
$ grep -F -b -o 'input[type="checkbox"]' entry.js      # -F literal · -b offset em BYTES · -o só o casamento
23717:input[type="checkbox"]

$ tail -c +23400 entry.js | head -c 560                # janela ao redor da âncora
# (saída real é UMA linha; aqui o prefixo está elidido com … e o resto quebrado só pra leitura)
…}).then(({default:e})=>{e.init(li,{api_host:ci,capture_pageview:!1,capture_pageleave:!0,disable_session_recording:!0,
autocapture:{dom_event_allowlist:["click","submit","change"],css_selector_allowlist:["button","a",
"select",'input[type="checkbox"]','[role="button"]']},person_profiles:"identified_only",…})…
```

**Por que isto é imune à poluição:** o objeto minificado é **contíguo** — a janela ao redor da
âncora mostra o config **inteiro**, com a chave e o valor no MESMO objeto. A pergunta deixa de ser
*"a string está no bundle?"* (que tem N emissores) e passa a ser *"o que o NOSSO objeto de config
diz?"* (que tem um só). E é a única forma que consegue ler uma **remoção**: `disable_session_recording:!0`
**afirma** o valor; a ausência da string não afirma nada enquanto a lib a emitir.

O prefixo elidido é `(async()=>{…await import("./vendor-posthog-Do2CBfqi.js")…})` — é o **import
dinâmico** que separa a lib no chunk próprio, e é literalmente o mecanismo que cria o segundo
emissor num arquivo diferente do nosso, disputando o `halt-on-hit`.

O `tail -c +N | head -c M` é o recorte por **bytes** — arquivo minificado é uma linha só, então
qualquer recorte por linha traz o chunk inteiro ou nada.

## A sugestão que ficava — avaliada e **implementada** em 2026-08-26

> **Desfecho.** Aprovada como aviso, **com um ajuste que a medição forçou**: o `grep -rlF "$ALVO"
> node_modules/` proposto abaixo **não sobreviveu como está**. Medido na `node_modules` real
> (637 MB / 54.843 arquivos), ele custa **38-63 s** — e, pior, acusa **3 arquivos** para
> `input[type="checkbox"]`, o *valor nosso* que esta mesma página prova ser a sentinela **certa**
> (os hits: um `readme.md`, o `preflight.css` do tailwind, um css de demo do `loglevel`). Um aviso
> que dispara contra a resposta certa é um aviso desarmado no primeiro dia.
>
> Correção: restringir o universo a **código JS** (`--include` de `*.js`/`*.mjs`/`*.cjs`) — corte por
> *"é código JS?"*, nunca por *"onde a lib guarda"* (restringir a `dist/` criaria falso negativo real).
> Custo cai para **~2 s** e o sinal fica discriminante: `maskAllInputs` devolve 10 arquivos **todos em
> `posthog-js/dist/`** (o preditor nomeia o pacote culpado), enquanto o valor nosso cai para 1
> (`jsdom`, devDep de teste que nunca vai ao bundle) — ruído que o operador descarta num olhar,
> porque a sonda imprime **os caminhos**, não só a contagem.
>
> Três marcas, e a terceira é o requisito que quase se perde: `SENTINELA_TAMBEM_NA_LIB`,
> `LIB_SEM_A_SENTINELA` e `LIB_NAO_CONSULTADA`. Roda com **e sem** `--pai`: a pergunta é ortogonal à
> dele, e sem `--pai` o operador está no modo mais fraco. Coberta no harness com os 3 estados + a
> convivência com o `--pai`, e falsificada por **marca** — o aviso não mexe no exit code, então o
> `falsify_case` que compara exits seria **cego** a ela.

### A proposta original, como estava

O `--pai` poderia ganhar um aviso quando a sentinela também aparece em `node_modules/` — algo como
**`SENTINELA_TAMBEM_NA_LIB`**, no espírito do `EXCLUSIVIDADE_NAO_PROVADA`: **avisa, não recusa**. É
barato e roda **antes da rede**, mesma disciplina do `--pai` (`grep -rlF "$ALVO" node_modules/`).

**Por que AVISO e não recusa — medido, não achismo:** `maskAllInputs` está em **37 arquivos** da
`node_modules/posthog-js/dist/` e em **0 ocorrências** no `vendor-posthog-Do2CBfqi.js` servido. Os
dois conjuntos **não são o mesmo**: minificação, tree-shaking e mangling decidem o que sobrevive
até o bundle. Logo `node_modules` é **preditor** do segundo emissor, não **prova** dele — um guard
que recusasse no hit reprovaria sentinela legítima, e guard que reprova o certo é desarmado no
primeiro dia. O verde continua sendo do operador, com a lacuna dita em voz alta.

⚠️ **E o aviso precisa distinguir "não achei" de "não consultei".** Worktree recém-criada não tem
`node_modules` (o `bun install` é passo à parte) — nesse estado a sonda deve imprimir **"não
consultei"**, nunca um silêncio que se lê como "limpo". Aqui degradar é o certo (é **sensor**, não
script que apaga), mas degradar **calado** transformaria a ausência de dado em aprovação, que é a
mesma falha que este documento inteiro descreve.

## Régua para a próxima verificação

1. A sentinela é **nome de opção/API de uma dependência**? Então presuma segundo emissor —
   `grep -rlF '<alvo>' node_modules/` antes de tocar a rede.
2. Prefira **valor nosso** a **chave da lib**: texto de UI, seletor que nós escolhemos, string de
   negócio. É o que o `--pai` mede bem **e** o que a lib não emite.
3. Verificando **remoção**, nunca conclua por ausência de string enquanto houver segundo emissor —
   **leia o objeto** pela âncora + janela de bytes.
4. Com `halt-on-hit`, o `✅ ALVO em <chunk>` é **dado**, não decoração: se o chunk que casou for de
   `vendor-*`, o verde não é seu.

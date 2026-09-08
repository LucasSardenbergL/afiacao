# Piloto: o MCP do Lovable deploya sozinho? — EDGE: só o canal; PUBLISH: canal E verbatim; MIGRATION: funciona, e fica fora

> **Três camadas medidas, por experimentos separados.** §Passos 1-3 = **edge** (`send_message`,
> 2026-09-07). §Camada 2 = **Publish do frontend** (`deploy_project`, 2026-09-08), que fecha nos
> bytes a metade que a edge deixou aberta. §Camada 3 = **migration** (`query_database`, 2026-09-07),
> medida em ambiente descartável: o canal **funciona**, com semântica transacional completa — e é
> justamente por isso que ela **continua fora** da regra do CLAUDE.md. A recomendação é manter a
> regra como está, e o porquê está lá.

> ⚠️ **Este doc foi CORRIGIDO em 2026-09-08 (#2358).** A primeira versão dizia "deploya edge
> VERBATIM — SIM, medido". Duas revisões independentes (Codex `gpt-6-astra/max` e um subagente
> Fable 5.1) derrubaram a metade "verbatim", e as duas estavam certas. O que segue é o veredito
> corrigido; a §"O que as revisões derrubaram" lista o que mudou e por quê.

**Status: veredito PARTIDO em dois, porque as duas metades têm forças de evidência diferentes.**

| metade | veredito | força |
|---|---|---|
| **O CANAL MCP entrega?** | ✅ **CONFIRMADO** | `send_message` levou o prompt sem colagem humana, e depois dele a edge passou a servir `versao` **e** `fonte` da `main` — transição de um ANTES **medido** (`v1.0-sensor-inicial`). Mata o **deploy parcial**, que era o modo de falha nomeado. |
| **O deploy foi VERBATIM?** | ⚠️ **NÃO ATESTADO** | Mesma classe de evidência do canal manual — nem melhor, nem pior. O par `(versao, fonte)` prova o valor observável de **2 dos 8 arquivos**; os outros **6** têm apenas "nenhuma edição REGISTRADA", que não é a mesma coisa. |

A distinção não é preciosismo. O `fonte` é um fingerprint **DECLARADO** — a resposta lê a constante
`FONTE_SHA256[edge]` de um arquivo commitado (`_shared/sonda-versao.ts`), sem calcular nada sobre os
bytes que executaram. E existe caminho documentado para o bundle servido divergir do repo **sem
produzir commit**, com taxa-base medida acima de zero (§"O que as revisões derrubaram", item 2).

O que este veredito **não** estende está em §"O que o veredito não autoriza".

## A pergunta, e por que ela precisava de um ANTES

Deploy de edge no Lovable é manual: alguém abre o chat do projeto e pede. A pergunta do piloto é se
o **MCP oficial** (`send_message`) tira esse clique — publicando a edge **verbatim** a partir da
`main`, sem o agente do Lovable "melhorar" nada no caminho.

A medição de 2026-09-06 já tinha tentado responder e conseguiu só metade. Ela rodou sobre 8 edges
`NUNCA_ATESTADA` — ou seja, **antes desconhecido**. Nessa condição, "o MCP deployou as 8" e
"algumas já eram byte-idênticas ao que estava servido" produzem **o mesmo eco**, e nada no
resultado separa os dois. É a regra de evidência positiva aplicada ao tempo: sem saber o estado
anterior, o estado posterior não é diferença, é só estado.

Daí o Passo 1 deste piloto: **fabricar uma divergência MEDIDA** antes de chamar o MCP. É a lacuna
que a §Estado da `lovable-deploy-verify` deixou registrada em 2026-09-06 — *"para fechar a outra
metade, repita numa leva com ≥1 edge em `DIVERGE_P1` MEDIDA antes"* — e é o que esta sessão fez.

## Passo 1 — o ANTES conhecido (#2347)

Bumpar o `VERSAO` de uma edge muda o `versao.ts`, que está no **closure** do fingerprint, logo muda
**também** o `fonte`. Par ≠ par ⇒ a edge cai em **`DIVERGE_P1` medido**, não em `NUNCA_ATESTADA`
(que é ausência de dado). Concretamente:

- `supabase/functions/copilot-analyze/versao.ts`: `v1.0-sensor-inicial` → `v1.1-piloto-mcp-lovable`
- `supabase/functions/_shared/sonda-fingerprints.ts`: **uma** linha, a da cobaia
  (`c37ca500…` → `5989e8e2…`) — o diff prova que nenhuma outra edge foi arrastada junto.

Estado do ledger imediatamente antes, medido (não lembrado): `bun run pendencias:deploy` → **rc=0,
59/59 conferem**. Não havia edge divergente para pilotar — por isso a divergência precisou ser
fabricada.

Depois do merge, o ANTES ficou assim, e é ele que dá sentido ao DEPOIS:

```console
$ bun run pendencias:deploy
🔴 P1 — DEPLOY PENDENTE declarado (versao bumpou): deploy no PR — 1
   copilot-analyze   prod v1.0-sensor-inicial → main v1.1-piloto-mcp-lovable · pendente há 0 d
✅ confere — 58
─── cobertura: 59/59 edges mapeadas com atestação (ledger ∪ janela viva)
rc=1
```

**O guard da ordem foi respeitado.** O doc do Passo 1 avisava que a leva do #2285
(`disparar-pedidos-aprovados`, money-path) precisava ser deployada **antes** deste PR mergear,
senão `pendencias:prompt -` montaria uma colagem com as duas e a cobaia iria a produção pelo canal
manual de carona. Foi o que aconteceu: na hora do Passo 2, o #2285 já constava
`v1.2-claim-disparo · visto há 2 h via sonda`, e `copilot-analyze` estava **sozinha** na lista de
pendências. O experimento chegou ao Passo 2 com o objeto intacto.

## Por que a cobaia é `copilot-analyze` — a trilha de eliminação

O critério é o custo de o piloto dar errado, não a conveniência. O modo de falha temido não é "a
edge roda": é **o agente do Lovable EDITAR o que devia só publicar**, e ele commita direto na
`main`. Então a cobaia tem de ser uma edge em que uma mudança silenciosa de comportamento seja
barata. Quem foi descartado, e por quê:

| candidata | por que saiu |
|---|---|
| `monthly-report` | manda e-mail para a base — efeito externo irreversível |
| `sonda-relay` | é o **instrumento de medição** do piloto; não se calibra régua com a própria régua |
| `sync-reprocess` | escreve `product_costs` — money-path |
| `process-recurring-orders` | cria pedido recorrente — efeito de negócio |
| `reposicao-depara-sayerlack-auto` | o próprio `EFEITO` diz: mapeamento errado "vira compra do item errado" — money-path |
| `carteira-positivacao-snapshot` | o próprio `versao.ts` a chama de "a edge com o pior custo de sondar às cegas deste recorte": regrava snapshot **congelado** de mês fechado, onde página perdida vira `revenue_month: 0` para quem comprou |
| `calculate-scores` | `index.ts` de 64 KB — fatia grande é mais superfície para o agente mexer |
| `analyze-services` | **`verify_jwt = true`** (única das quatro edges de IA fora do `config.toml`): o gateway devolve 401 antes do handler, e esse 401 **não distingue bundle velho de credencial faltando**. Cobaia cujo modo de falha é ambíguo contamina o veredito |

`copilot-analyze` sobra por acumular as propriedades certas, todas verificadas no repo:

- **`verify_jwt = false`** (`supabase/config.toml`) — sem o 401 ambíguo do gateway;
- gate `authorizeCronOrStaff`, que aceita `x-cron-secret`: a sonda entra logo depois, sem gate próprio;
- **zero escrita e zero chamada externa NO CAMINHO DA SONDA** — e a qualificação é obrigatória: a
  primeira versão deste doc dizia "zero escrita de aplicação e zero `fetch` direto", o que é
  **falso** para o fluxo real. `index.ts:101` chama `consumirCota`, que faz `INSERT INTO
  public.ia_uso_evento`, e `index.ts:149` chama `anthropic.messages.create`. O que salva é a
  POSIÇÃO: a sonda retorna na **linha 48**, antes dos dois. Achado da revisão Fable;
- closure de 7 arquivos;
- **`farmer_copilot_sessions` = 0**, medido via `psql-ro` **com controle positivo na mesma
  query** (`omie_products` = 7.997 — a query enxerga, então o zero é veredito e não vazio).

🔴 **Mas a inferência que o #2347 tirou desse zero é FALSA, e as duas revisões a pegaram.** Ele
concluiu "o app grava a sessão **antes** de invocar a edge ⇒ zero sessões implica zero chamadas".
O app não faz isso: `src/hooks/useCopilotEngine.ts` destructura só o `data` do insert — o `error`
nem é lido — e cai em `const sessionId = data?.id || crypto.randomUUID()`. Insert que falha vira
**UUID fabricado**, e a sessão segue chamando a edge. Logo `farmer_copilot_sessions = 0` é
compatível com chamadas terem acontecido: o zero é evidência **fraca**, não prova. O piloto foi
mais arriscado do que o #2347 documentou. O que continua de pé é o resto do recorte (sonda retorna
antes de qualquer efeito, `verify_jwt = false`, closure pequeno) — não a frase "não atinge usuário
nenhum", que foi retirada.

O bump não acompanha mudança de comportamento — e isso está dito no próprio `versao.ts`, para
ninguém procurar depois por uma alteração que não existe.

## Passo 2 — o deploy, SÓ pelo MCP

O MCP estava **autenticado** nesta sessão (era o que faltava em 2026-09-07 de manhã):

```console
$ claude mcp list
lovable: https://mcp.lovable.dev (HTTP) - ✔ Connected
```

O prompt saiu do gerador do #2331, que resolve a armadilha do `closure ∪ {mapa}`
([closure-de-hash-nao-e-lista-de-deploy.md](closure-de-hash-nao-e-lista-de-deploy.md)) — a fatia de
deploy **não** é o closure do hash, difere dele por exatamente `_shared/sonda-fingerprints.ts`:

```console
$ bun run pendencias:prompt copilot-analyze
✓ leva de 1 edge(s) · 8 arquivos · cobertura conferida
```

O projeto foi identificado por `list_projects` sem ambiguidade — `steu`
(`8f005805-000a-42b7-88a1-9683f785fab6`), `url: https://steu.lovable.app`, que é o domínio canônico
da `lovable-deploy-verify`; o outro projeto do workspace está despublicado desde janeiro. Aí o texto
do gerador foi enviado **verbatim** por `mcp__lovable__send_message`, e a resposta do agente:

> Verificou os 8 arquivos contra `origin/main` (SHA `dc6a9e11`) com `git fetch origin main -q` e
> `git rev-parse --short origin/main`. Todos os 8 arquivos têm diff zero. Deploy executado com
> `supabase--deploy_edge_functions` para `copilot-analyze`. Confirmação via sondagem POST: respondeu
> **401** (`{"error":"Unauthorized"}`), com boot limpo — função está **Active**. Nenhum arquivo foi
> modificado.

`message_id` `umsg_01m1z4h1cke1hbsf0zyxk6vqeg`, custo **0,8 crédito**. **Zero colagem humana** — que
era a condição do experimento: o que estava sob teste é o canal, não o texto do prompt.

⚠️ **Esse relato é do agente sobre si mesmo — não é veredito, é o que perguntar à sonda.** É a
mesma regra que a `lovable-deploy-verify` §Passo 3 já registrava para o chat manual. Note inclusive
que o 401 que ele exibe como prova é ambíguo por construção (o próprio doc do Passo 1 descartou
`analyze-services` por isso): a sondagem dele foi um `POST` sem `x-cron-secret`, então 401 é a
resposta esperada de **qualquer** bundle com gate. O que ele prova é boot limpo, não versão.

## Passo 3 — o veredito, nas duas leituras

### (a) A sonda — `DEPLOY CONFIRMADO`

Antes de disparar, um **controle negativo** de graça: rodar a leitura com nada disparado. Se ela
fabricasse um verde ali, o verde de depois não valeria nada.

```console
$ { cat leitura.sql; echo "SELECT 'FIM_OK' AS marcador;"; } | ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -A -F'|'
copilot-analyze|||||v1.1-piloto-mcp-lovable||INDETERMINADO — nenhuma resposta de sonda desta edge
na janela de 20 min. Isto é ausência de dado, não veredito negativo: […]
marcador
FIM_OK
```

Correto e fail-closed: `INDETERMINADO`, dito com todas as letras que é **ausência de dado**, não
"bundle velho". O caminho de leitura também foi provado vivo antes, com controle positivo
(`omie_products` = 7.997). Então o disparo (founder, 🟣 SQL Editor — lê `vault.decrypted_secrets` e
faz `INSERT` via `net.http_post`, os dois que o wrapper read-only recusa) devolveu
`copilot-analyze | 72342`, e a leitura:

```console
$ { cat leitura.sql; echo "SELECT 'FIM_OK' AS marcador;"; } | ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -A -F'|'
edge|request_id|status_code|edge_respondida|versao_respondida|versao_esperada|fonte_respondida|veredito
copilot-analyze|72342|200|copilot-analyze|v1.1-piloto-mcp-lovable|v1.1-piloto-mcp-lovable|5989e8e27dcc8beec56f116ca0b40bcd3f334fbbe8fc5aecb3060b9d79df92d4|DEPLOY CONFIRMADO
(1 linha)
marcador
FIM_OK
(1 linha)
EXIT_DO_PSQL=0
```

Os **dois** eixos batem — e o segundo é o que importa. `fonte: "nao-mapeada"` com `versao` certo
seria **DEPLOY PARCIAL**, a classe estritamente pior, porque um `versao` verde **encerra** a
verificação. Não foi o caso: `5989e8e2…` é o fingerprint da `main`, logo o **mapa** subiu junto com
o `versao.ts`.

⚠️ A primeira versão deste doc chamou de "duas rotas independentes" o fato de a leitura por eco de
slug cair exatamente no `72342` que o disparo imprimiu. **Não são duas rotas** — o id e a resposta
saem do MESMO `INSERT` do `net.http_post`. É uma sonda lida de dois jeitos, e o acordo entre eles é
consistência interna, não corroboração. Achado da revisão Fable.

E o ledger reconciliou na sequência — **sem acrescentar prova**, e isto precisa estar dito: o
`pendencias:deploy` lê a MESMA resposta em `net._http_response` (direto da janela viva ou copiada
ao ledger). O `rc=0` confirma reconciliação operacional; ele **não** é uma segunda medição, e a
cobertura `59/59` conta atestações inclusive históricas, não 59 verificações novas. Achado da
revisão Codex:

```console
$ bun run pendencias:deploy
   copilot-analyze                     v1.1-piloto-mcp-lovable · visto há 1 min via sonda
─── cobertura: 59/59 edges mapeadas com atestação (ledger ∪ janela viva)
EXIT=0
```

### (b) Houve edição REGISTRADA do bot? — não. E isso é menos do que parece

O par `(versao, fonte)` prova o valor observável de **2 dos 8 arquivos**: o `versao.ts` e o **mapa**.
Não prova que os outros **6** do closure (`index.ts`, `copiloto-tools.ts`, `auth.ts`, `anthropic.ts`,
`ia-cota.ts`, `sonda-versao.ts`) subiram sem edição, porque `fonte` é fingerprint **declarado** por
arquivo commitado (`fonte: FONTE_SHA256[edge] ?? "nao-mapeada"` em `_shared/sonda-versao.ts`), não
hash calculado sobre o bundle servido.

A primeira versão deste doc dizia que essa metade tinha "rede própria, e ela é barata: o agente do
Lovable commita direto na `main`, então uma edição dele apareceria como commit". **A rede é mais
furada do que isso**, e o furo estava documentado no próprio repo o tempo todo
(`docs/agent/deploy.md`, escrito depois de um Codex de 2026-06-26):

> grep é necessário mas **NÃO suficiente** (o bot pode deployar da cópia interna SEM refletir na
> `main`) → canária com fixture

A medição que fizemos, e que continua valendo pelo que ela é:

```console
$ git fetch && git log --format='%h %ci %an %s' dc6a9e115..origin/main -- supabase/functions/copilot-analyze supabase/functions/_shared
[vazio]
```

`origin/main` andou nesse meio-tempo (para `1ee276fb7`, o #2353), mas nenhum commit tocou o closure.
Segundo eixo, pelo lado do Lovable:

- `mcp__lovable__get_diff` na mensagem do deploy → `400 bad_request: Message has no associated edit`
- `mcp__lovable__list_edits` → a edição mais recente do projeto é `dc6a9e115` às **21:41Z**, o sync do
  próprio merge; o deploy das **23:51Z** não produziu edição nenhuma.

**O que isso é:** auditoria de edições REGISTRADAS. **O que isso não é:** prova de igualdade entre o
workspace do Lovable, a entrada do deploy e o artefato servido. As três podem divergir sem gerar
commit — e o deploy sai do **sandbox** (`supabase--deploy_edge_functions`, visível no trace do
`get_message`), não de um checkout limpo da `main`.

## O que as revisões derrubaram (2026-09-08, #2358)

Duas revisões independentes, pedidas pelo founder depois que a v1 deste doc já estava mergeada:
**Codex** (`gpt-6-astra`, reasoning `max`, 286 s, 119 k tokens, via `scripts/codex-async.sh`) e um
subagente **Fable 5.1** com janela própria. As duas chegaram, por caminhos diferentes, ao mesmo
veredito: **o "verbatim" não estava medido**. Cada achado abaixo foi RE-verificado no repo antes de
entrar aqui — parecer de agente é insumo, não prova.

**1. O título e o §Status afirmavam mais do que a evidência.** "A sonda diz que o bundle certo está
servido" é forte demais: a resposta lê uma constante declarada. Corrigido — o veredito virou duas
metades com forças diferentes.

**2. A taxa-base do modo de falha temido é MAIOR que zero, e está no nosso próprio `git log`.** Este
é o achado que muda a conclusão, e é do Fable. O deploy sai do **sandbox** do Lovable, não de um
checkout da `main` — e o sandbox pode estar atrasado na hora do deploy. Aconteceu, com carimbo:

```console
$ git log --format='%h %ci %an | %s' -1 <sha>
5f5523df9 2026-08-08 00:56:48 +0000 LucasSardenbergL      | chore(ci): consolidar @supabase/supabase-js num especificador só
942a69b89 2026-08-08 00:59:24 +0000 gpt-engineer-app[bot] | Changes
aa00a3909 2026-08-08 00:59:59 +0000 gpt-engineer-app[bot] | Deployed snapshot edge func
```

**2 min 36 s** depois do merge, o bot empurrou a linha VELHA de volta (`@2` → `@^2` em
`carteira-positivacao-snapshot/index.ts`) e deployou dali. Ele commitou, então nós vimos. **Se
tivesse deployado sem commitar, `git log`, `list_edits` e `get_diff` ficariam exatamente como
ficaram neste piloto** — e o `fonte` bateria, porque o mapa é um arquivo pequeno e fresco enquanto o
`index.ts` seria o velho. E a frequência do bot na main não é a que este doc dizia: são **171
commits em 60 dias**, não "~24".

**3. Há um caminho que nem exige o bot errar** (achado do Codex): `copilot-analyze/index.ts` importa
`npm:@anthropic-ai/sdk@^0.93.0` e `npm:@supabase/supabase-js@2` — **ranges abertos**, fora do closure
do fingerprint, que só anda em imports locais (`./`, `../`). O bundle servido pode mudar sem uma
linha do repo mudar, e nem `fonte` nem `git log` enxergam isso.

**4. O prompt de deploy não tem ramo fail-closed** (achado do Fable, em `scripts/lib/prompt-deploy.ts`).
Ele diz "update it from `main`", e nada manda **abortar** se o sandbox divergir. O `git fetch` +
`git diff --quiet` que o agente rodou foi iniciativa DELE, não exigência nossa — e a saída do exec
não vem no `get_message`, então "diff zero nos 8" continua sendo o relato do agente.

**5. Correções factuais menores:** "outros 5 arquivos do closure" → **6**; "zero escrita de aplicação"
→ zero escrita **no caminho da sonda**; "duas rotas independentes" → uma sonda lida de dois jeitos;
"11 linhas de comentário" → **6**; "~24×/60d" → **171×/60d**.

### O que fazer com isso — as duas propostas, e elas são complementares

**(a) PREVENTIVA — hash no prompt (Fable; é a de maior valor).** `pendencias:prompt` embutir o
**sha256 por arquivo** (mesmo `fecharGrafo`) e exigir do agente: *rode `sha256sum` nos N arquivos; se
QUALQUER um diferir do esperado, **não deploye** e responda a tabela*. Depois, `get_message` compara.
Hash é dado que LLM não fabrica, e isso fecha o buraco do sandbox atrasado **sem** depender de
commit, de `list_edits` nem do `fonte` declarado. Custo zero por deploy, e vale para o canal manual
também — que é onde a maior parte dos deploys acontece.

**(b) DETECTIVA — canária determinística (Codex; é o que o `deploy.md` já prescrevia).** Uma canária
em `copiloto-tools.ts` exercitada por fixture sem Anthropic e sem escrita, medida antes e depois do
deploy. Falsificar localmente antes de confiar: com o helper adulterado e os dois marcadores
intactos, exigir **sonda verde + canária vermelha**. Ela pega o que (a) não pega — divergência que
nasce DEPOIS da entrada do deploy (resolução de dependência, cache de build).

(a) ESTÁ ENTREGUE (#2362); (b) segue pendente. (a) tocava o gerador de prompt de TODOS os deploys,
então foi entrega própria, com falsificação própria — o que segue é o que ela mede e o que ela não
mede.

### (a) entregue — o que o prompt passou a carregar (#2362)

`bun run pendencias:prompt <edge>` agora emite, por arquivo da fatia, `` - `caminho` — sha256 `<hex64>` ``,
seguido de um bloco de conferência com **três** ramos: bate → deploya · difere → **não deploya** e
devolve a tabela `file | expected | actual` · **não conseguiu medir** → **não deploya** e diz por
quê. O terceiro ramo não é preciosismo: sem ele, o `sha256sum` ausente do sandbox cai em "não achei
diferença", que é ausência de dado lida como aprovação — a falha de
[sonda-ausente-em-script-que-apaga.md](sonda-ausente-em-script-que-apaga.md).

**Duas decisões que o item (a) original não nomeava, e que mudaram o desenho:**

1. **A fatia e os hashes saem de `origin/main`, nunca do working tree.** `fecharGrafo` ganhou o seam
   `ArvoreDeFonte` e a borda usa `arvoreDaRef('origin/main')`; o `git fetch` é DO script, porque a
   ref em disco também é um retrato. Sem isso a entrega teria reintroduzido o eixo **ÁRVORE** de
   2026-09-04 (5 arquivos contra o disco, 7 contra a ref, na `enviar-pedido-portal-sayerlack`) —
   que `git fetch` sozinho não fecha, e que produziria hashes de um estado que não vai ao ar.
2. **A auto-conferência casa o PAR caminho↔hash, não os dois soltos.** Conferir `inclui o caminho?`
   e `inclui o hash?` separadamente fica verde com os hashes **trocados** entre dois arquivos — os
   dois aparecem, cada um ao lado do arquivo errado — e aí o agente confere 8, acha 8 divergências
   e aborta um deploy **correto**. Um renderizador único (`linhaDoArquivo`) serve o prompt e o
   check, para as duas noções não divergirem.

Medido na entrega: os 8 hashes do prompt real de `copilot-analyze` conferem com
`git show origin/main:<arq> | shasum -a 256` (8 conferidos, 0 divergências), e a falsificação exigiu
vermelho **na marca do ramo** em três sabotagens — ler o working tree, devolver o closure do disco,
e hash constante —, com controle verde na mesma invocação antes do primeiro `sed`.

O teste novo é da FRONTEIRA (`scripts/pendencias-prompt.test.ts`), não do núcleo: o núcleo puro
tinha 35 verdes e não alcança o eixo ÁRVORE, que só existe na borda de I/O. Mesma lição já registrada
no `sonda-versao-bump-gate` — "os dois falsos-verdes corrigidos aqui estavam ambos FORA do núcleo
puro, que tinha 23 testes verdes".

⚠️ **O que (a) NÃO fecha, e o doc não deve deixar virar folclore:** ela prova que os bytes que
ENTRAM no deploy são os da `main`. Não prova nada sobre o que sai — resolução de dependência e cache
de build continuam livres, porque `npm:@anthropic-ai/sdk@^0.93.0` e `npm:@supabase/supabase-js@2`
são ranges ABERTOS, fora do closure. É exatamente a fatia que (b) cobre, e é por isso que as duas
são complementares e não substitutas.

## Camada 2 — o Publish do frontend (`deploy_project`): as DUAS metades medidas (2026-09-08)

O §"O que o veredito não autoriza" registrava `deploy_project` como **outra camada, e não medida**.
Esta seção a mede. O resultado é **estritamente mais forte** que o da edge, por uma razão estrutural
que precisa vir antes dos números: **o frontend SERVE o próprio código.** A edge não — e é daí que
nasce toda a assimetria. Lá o `fonte` é fingerprint **declarado** (constante lida de um arquivo
commitado), e por isso a metade "verbatim" ficou `NÃO ATESTADA`. Aqui a verificação lê os **bytes
que o navegador baixa**, então a mesma pergunta é respondível.

| metade | veredito | força |
|---|---|---|
| **O CANAL `deploy_project` publica?** | ✅ **CONFIRMADO** | transição de um ANTES **medido** (`monitor-deploy.sh` rc **3 → 0**), sem colagem humana em ponto nenhum |
| **O Publish foi VERBATIM?** | ✅ **ATESTADO NOS BYTES** (amostra: 64 dos 317 chunks) | bytes servidos, não constante declarada — e com **controle de falsificação** provando que a sonda discrimina |

### O ANTES — conhecido de graça, e sem tocar em `src/`

A Camada 1 teve de **fabricar** a divergência (bump do `VERSAO`, #2347). Aqui não foi preciso: o ar
já estava atrasado, e o instrumento disse isso sozinho.

🔴 **Porque o instrumento mudou — e a `lovable-deploy-verify` estava desatualizada.** A §Smoke E2E
dela registra, desde 2026-06-26, que o ar serve `__BUILD_SHA__="dev"` (o build do Lovable roda sem
`.git`), logo *"o caminho determinístico é **inviável** neste host"* e o monitor *"depende SEMPRE da
sentinela"*. **Não depende mais.** O ar carimba SHA real:

```console
$ curl -s https://steu.lovable.app/assets/index-DCGIbHW4.js | grep -o '__BUILD_SHA__="[^"]*"'
__BUILD_SHA__="bb9d8d2e"
```

`bb9d8d2e` resolve para `bb9d8d2ed7e7…` (#2357), **ancestral de `origin/main`, um commit atrás** —
medido com `git rev-parse --verify` + `git merge-base --is-ancestor`, resposta positiva nos dois. O
`resolveCommitSha()` do `vite.config.ts` varre 14 env de SHA de várias plataformas antes de cair em
`git rev-parse` e só então em `"dev"`; alguma delas passou a existir no host de build. Consequência
prática grande: **a verificação de frontend deixou de precisar de sentinela**, e com ela some toda a
família de armadilhas do Passo 4 (exclusividade no `--pai`, 2º emissor na lib, `SENTINELA_DELIMITADA`).

Então o ANTES, medido com o instrumento oficial e rc capturado:

```console
$ bash .claude/skills/lovable-deploy-verify/scripts/monitor-deploy.sh https://steu.lovable.app
[2026-09-07T21:42:03] main=84a115a4  ar=bb9d8d2e  deploy-novo=nao
  ⚠️ ATRASADO: ar serve bb9d8d2e, main em 84a115a4 → Publish pendente
MONITOR_RC=3
```

**E uma ambiguidade que costuma envenenar este teste foi eliminada ANTES do disparo, não depois.**
Um Publish que não muda nada tem duas explicações — "não publicou" e "publicou de um workspace
atrasado" — e elas produzem o mesmo eco. `mcp__lovable__list_edits` separou as duas de antemão: a
edição mais recente do projeto era `84a115a439cd…`, **a própria HEAD da `main`**, `completed` às
00:36:29Z. O workspace **já tinha** o material certo; o que faltava era só o clique.

### A cobaia — o custo de dar errado, medido e não estimado

O Publish é **atômico**: publica a `main` inteira, então não se escolhe *o quê* publicar. O que se
escolhe é **QUANDO** — e a janela em que este piloto rodou tem custo de dar errado próximo de zero,
o que foi medido, não suposto:

```console
$ git diff --name-only bb9d8d2e origin/main | sed 's#/.*##' | sort -u
docs
$ git diff --name-only bb9d8d2e origin/main -- src/ vite.config.ts package.json index.html | wc -l
0
```

O intervalo ar→main é **100% documentação**. Publicar leva **zero** mudança de código ao frontend, e
o único delta observável esperado nos bytes é o próprio carimbo. Isso também respeita a regra que o
piloto anterior firmou: **não se calibra régua com a própria régua** — o instrumento aqui é o carimbo
+ o `monitor-deploy.sh`, e a cobaia é o Publish num momento de diff nulo em código.

⚠️ **O parâmetro que NÃO foi passado, de propósito.** `deploy_project` aceita `name` — *"Project slug
for the published URL"*. Passá-lo poderia **re-slugar** e quebrar `steu.lovable.app`, que é o domínio
canônico de toda a verificação. Foi enviado **só** `project_id`, e a resposta confirmou a URL
preservada.

### A ação — só o MCP

```
mcp__lovable__deploy_project(project_id: 8f005805-…)
→ {"status":"pending","deployment_id":"9efbd228-c231-4f83-91d4-5b8aff17ab0c",
   "url":"https://steu.lovable.app", …}
```

**Zero colagem humana**, que é a condição do experimento. A espera foi armada com **teto e ramo que
diz "não consegui"** (`espera-sem-desistencia.md`): 40 tentativas × 15 s, marcador `TRANSICAO_OK` no
sucesso e `NAO_CONSEGUI … AUSENCIA DE DADO … NAO veredito negativo` no estouro. Fechou na **1ª**
tentativa.

### Leitura (a) — os bytes servidos

```console
$ bash .../monitor-deploy.sh https://steu.lovable.app
[2026-09-07T21:45:22] main=84a115a4  ar=84a115a4  deploy-novo=SIM (index-DCGIbHW4 -> index-C4XI56cx)
  ✅ sincronizado: ar serve 84a115a4 == origin/main
MONITOR_RC=0
```

**Dois observáveis se moveram** — o carimbo (`bb9d8d2e` → `84a115a4`, exatamente a HEAD da `main`) e
o hash do entry (`index-DCGIbHW4` → `index-C4XI56cx`), que é o sinal auxiliar que o Passo 4 da skill
já mandava anotar.

### Leitura (b) — o VERBATIM, que na Camada 1 não foi atestável

Primeiro um susto que virou prova. Normalizando **só** o carimbo, os dois entries divergiam em
**3.326 bytes** — com tamanho **idêntico** (238.025 = 238.025). Ler isso como "o agente editou" teria
sido errado; ler como ruído, também. As janelas divergentes responderam:

```console
ANT: Deps,d=(m.f||(m.f=["assets/WebRTCCallContext-0CAso5BO.js","assets/vendor-react-Dm9CHLxI.js
NOV: Deps,d=(m.f||(m.f=["assets/WebRTCCallContext-DgJvwEh8.js","assets/vendor-react-Dm9CHLxI.js
```

São **hashes de nome de chunk** — comprimento fixo, o que explica o tamanho idêntico. E a cascata é
determinística: o carimbo vive no **entry** ⇒ o conteúdo do entry muda ⇒ o hash do entry muda ⇒ todo
chunk que **importa** o entry tem sua string de import reescrita ⇒ o hash dele muda também. Medido
em dois chunks baixados nas duas versões (os nomes com hash continuam servidos): `StatusBadge`
diferia em **7** bytes e `OrderChat` em **15**, e em ambos os casos os bytes divergentes estavam
**todos dentro de `./index-<hash>.js`**. Nada mais.

O `vendor-react-Dm9CHLxI.js` — que **não** importa o entry — saiu **idêntico nos dois builds**, e
esse é o controle que separa a explicação acima de "o build simplesmente não é determinístico":
**51 dos 317** chunks mantiveram nome+hash exatos. Build não-determinístico teria movido os 317.

Com isso, o teste do verbatim e o seu controle:

```console
$ norm() { sed -E -e 's/__BUILD_SHA__="[0-9a-f]{7,40}"/__BUILD_SHA__="X"/g' \
                  -e 's/-[A-Za-z0-9_-]{8}\.js/-HASH.js/g' "$1" | shasum -a 256; }
entry ANTIGO normalizado: 4df6d7797dfda353c9533b16ae618ed772904eeddc869fb104e37a028a0b579f
entry NOVO   normalizado: 4df6d7797dfda353c9533b16ae618ed772904eeddc869fb104e37a028a0b579f
==> VERBATIM_OK

# CONTROLE — sabotar e exigir vermelho, com marcador POSITIVO da mutação
$ perl -pi -e 's/StatusBadge/StatusBadgeZ/ if $. == 1' sabotado.js
sabotagem aplicada? marcador POSITIVO: 1 ocorrencia(s)
sabotado normalizado: 6ee822f5b10cfea01d09d30ddd9b89f9844c0f695d64e3924747e1ad8589abf7
==> CONTROLE_OK — a normalizacao ACUSA mudanca de conteudo real
```

O controle não é enfeite: sem ele, uma normalização larga demais (que apagasse conteúdo junto com os
hashes) daria verde para qualquer coisa — o `SONDA_NAO_DISCRIMINA` do Passo 4, cometido numa sonda
nova. E ampliando a amostra para **12** dos 266 chunks que mudaram de hash, baixando as duas versões
de cada e normalizando as referências: **12 idênticos, 0 divergentes, 0 falhas de download**.

**Cobertura honesta do verbatim: 64 dos 317 chunks** — 1 entry (com falsificação), 51 por identidade
de nome+hash, 12 amostrados byte a byte. Não são os 317.

### Leitura (c) — houve edição registrada?

Como na Camada 1, e com a mesma ressalva sobre o que ela vale:

- `git log 84a115a43..origin/main` → **0 commits**. E, ao contrário do piloto anterior, com
  **controle positivo na mesma medição**: o mesmo comando enxerga **171** commits do bot em 60 d, então
  o vazio é veredito e não grep cego.
- `mcp__lovable__list_edits` → a edição mais recente segue sendo `edt-98a8cf9d…` / `84a115a4` /
  00:36:29Z, **byte a byte a mesma do baseline**. O `deploy_project` não produziu edição nenhuma.

**E aqui a auditoria vale mais do que valia lá**, por uma diferença de superfície: `send_message`
aciona um **agente capaz de editar código**; `deploy_project` é uma ferramenta estreita, que só
publica. O modo de falha "o agente melhorou o código no caminho" tem, nesta camada, uma superfície
menor — e os bytes acima o descartam para os 64 chunks medidos, o que a Camada 1 não pôde fazer para
nenhum dos 8 arquivos.

### O que a Camada 2 NÃO autoriza

- **N = 1**, e o diff era **100% docs**. Este resultado **não fala** por um Publish que carrega
  mudança real de `src/` — que é o caso normal, e onde o agente teria o que "melhorar". O verbatim
  atestado aqui é o de um build cuja única entrada variável foi o carimbo.
- **A amostra do verbatim é 64/317**, não a totalidade.
- **A janela é de menos de 1 minuto** entre a chamada e a transição. O `deployment_id` devolvido
  amarra o deploy à chamada, e o ANTES foi medido 00:43:21Z com o ar ainda em `bb9d8d2e` — mas com
  ~21 sessões vivas no host, "alguém clicou Publish nesse minuto" é uma alternativa lógica que a
  medição não **exclui**, só torna implausível. Dito, para não virar certeza retroativa.
- **`name` não foi exercitado** — de propósito, porque re-slugar quebraria o domínio canônico.
- **A migration (3ª camada) foi medida em 2026-09-07** — §Camada 3. Ela segue **fora** da regra do
  CLAUDE.md, agora por medição e não por precaução.

## Camada 3 — a migration (`query_database`): o canal FUNCIONA, e é por isso que a regra fica (2026-09-07)

As duas camadas anteriores mediram ferramentas que **fazem uma coisa só**. Esta mede a que faz
qualquer coisa: `query_database` recebe **dois** parâmetros (`project_id`, `sql`) e executa o que
vier. Não há modo read-only, dry-run, transação exposta nem allowlist — e o read-only do
`~/.config/afiacao/psql-ro` é do **wrapper**, não do papel, então aqui ele não existe.

O resultado tem uma forma que vale nomear antes dos números, porque ela é contra-intuitiva: **a
ferramenta é tecnicamente MELHOR do que se temia, e é exatamente isso que derruba o argumento do
"é só ter cuidado".** Semântica transacional completa, erros honestos com SQLSTATE, DDL atômica. Nada
disso é um freio — é um motor bom. O freio teria de ser o meu juízo, e juízo não é guard-rail.

| metade | veredito | força |
|---|---|---|
| **O canal `query_database` executa migration?** | ✅ **CONFIRMADO**, com semântica transacional **completa** | 14 chamadas num Supabase descartável; cada pergunta com ANTES **medido** e **controle na mesma medição** — positivo (a linha que aparece) ou negativo (o papel que não enxerga) |
| **Isso autoriza abrir escrita em produção?** | ❌ **NÃO — e a medição REFORÇA a regra, não a afrouxa** | o canal entra como `postgres`, dono do projeto, com **`BYPASSRLS` medido em comportamento**; e a escrita **não deixa rastro** em `list_edits` |

### A cobaia — custo zero de criação, e o isolamento provado POR DENTRO

A conta tinha **dois** projetos, não um: além do `steu` (produção), o `Sharp & Ready`
(`0854b155-…`) — criado **26 s antes** do `steu` com o mesmo prompt inicial, nunca publicado, sem
edição desde 2026-01-09. Um falso-começo de 8 meses. Cobaia pelo custo de dar errado, e de quebra
sem `create_project`: o único gasto foi `enable_database`, que não envia mensagem de agente.

🔴 **O isolamento não pôde ser provado por fora, e isso é um achado.** `get_database_status` devolve
`{"enabled":true,"stack":"supabase"}` — **sem ref, sem URL**. Não há como comparar o banco da cobaia
com o `fzvklzpomgnyikkfkzai` de produção pela superfície do MCP. A prova teve de vir **de dentro**, e
por isso a primeira query foi uma **guarda fail-closed** — `SELECT` puro, segura mesmo no caso
catastrófico em que o isolamento tivesse falhado:

```json
{"current_user":"postgres","session_user":"postgres","is_superuser":"off","db":"postgres",
 "rol_super":false,"rol_bypassrls":true,"rol_createrole":true,"rol_createdb":true,
 "tabelas_public":0,"marcadores_producao":0,"tabelas_auth":23,"pg":"PostgreSQL 17.6"}
```

`marcadores_producao` conta tabelas do repo (`user_roles`, `profiles`, `omie_clientes`,
`farmer_copilot_sessions`, `deploy_atestacoes`, `company_settings`): **0**. Somado a
`tabelas_public: 0` e `tabelas_auth: 23`, o banco é um Supabase real e **virgem**. Só depois desse
zero houve qualquer escrita.

### Leitura (a) — com qual role o MCP entra

**`postgres`** — o dono do projeto Supabase. Três atributos importam, e um deles é o jogo inteiro:

- `rolsuper: false` / `is_superuser: off` — **não** é superuser. Nuance real, registrada para não
  virar folclore: coisas superuser-only (p. ex. `COPY FROM PROGRAM`) continuam fora.
- **`rolbypassrls: true`** — atravessa RLS.
- `rolcreaterole: true`, `rolcreatedb: true` — pode cunhar papéis novos.

⚠️ Mas `rolbypassrls` lido de `pg_roles` é **declaração de catálogo** — a mesma classe de evidência
que derrubou a metade "verbatim" da Camada 1. Foi medido **em comportamento**, com controle negativo
na mesma leitura. Tabela com uma linha, `GRANT SELECT` dado ao `authenticated` (para que erro de
permissão não se disfarce de bloqueio de RLS), `ENABLE` **e** `FORCE ROW LEVEL SECURITY`, **zero
policies** — nega-tudo para todo mundo que não tenha `BYPASSRLS`:

```json
[{"papel":"postgres (o papel do MCP)","linhas_vistas":1},
 {"papel":"authenticated (controle negativo)","linhas_vistas":0}]
```

O `authenticated` vê **0** — logo a RLS está de fato bloqueando e o teste não é vazio. O papel do MCP
vê **1**. Em produção isso significa: toda a RLS do repo — o isolamento entre as 3 empresas, a
separação customer/staff, os view-gates `selfservice_*` — é **invisível** para essa conexão.

### Leitura (b) — transação, lote, DDL e repetição

As quatro perguntas de segurança operacional, cada uma com ANTES medido:

| pergunta | teste | resultado |
|---|---|---|
| DDL funciona? | `CREATE TABLE` (ANTES: `tabelas_public: 0`) | ✅ sim |
| lote multi-statement? | 2 statements numa string | ✅ aceito; a resposta carrega as linhas do **último** |
| `BEGIN…ROLLBACK` é respeitado? | `INSERT` dentro, leitura em conexão nova | ✅ **sim** — a linha não persistiu |
| erro no meio do lote deixa estado parcial? | `INSERT 10` + `INSERT 10` (viola PK) | ✅ **não** — `23505`, e a 1ª linha **sumiu** |
| a DDL também é atômica? | `CREATE TABLE` + `SELECT 1/0` | ✅ **sim** — `22012`, e `to_regclass` voltou `null` |
| repetir migration não-idempotente? | `CREATE TABLE` de novo | ✅ falha **alto**: `42P07` |

**Os erros não são engolidos** — voltam com SQLSTATE, nome da constraint e `DETAIL`
(`23505`, `22012`, `42P07`, `42501` apareceram todos). E o vazio de cada teste é veredito e não
sonda cega porque **o controle positivo está na mesma leitura**: a linha `99` (inserida sem
rollback) aparece em todas as leituras em que as linhas sabotadas somem, e `to_regclass` devolve
`piloto_c3_sonda` na mesma linha em que devolve `null` para a tabela desfeita.

⚠️ **Uma armadilha para quem for scriptar isto:** um `CREATE TABLE` bem-sucedido responde
`{"rows":[]}` — **byte a byte idêntico** a um `SELECT` que não achou nada. Sem rowcount, sem
confirmação. Sucesso e vazio têm o mesmo eco; só o **erro** é distinguível.

### Leitura (c) — houve edição registrada? O canal é auditável?

**Não, e o vazio aqui é veredito.** ANTES capturado antes de tudo, DEPOIS após as 14 chamadas —
incluindo `CREATE TABLE`, `INSERT`, `GRANT` e `ALTER TABLE … FORCE ROW LEVEL SECURITY`:

```console
$ diff antes-edits.json depois-edits.json; echo "DIFF_RC=$?"
DIFF_RC=0  (0 = identico byte a byte)
$ md5 -q antes-edits.json depois-edits.json
25a7d7141e91a35cc3be4cadddc64a90
25a7d7141e91a35cc3be4cadddc64a90
```

**Controle positivo:** `list_edits` deste projeto **devolve** uma edição (a de 2026-01-09,
`f9712afee857…`). Então o zero é sobre uma ferramenta que comprovadamente reporta — não sobre uma
ferramenta muda. Não há commit tampouco, e nem poderia haver: SQL não é código do repo.

Consequência que a Camada 2 não tinha: lá, `deploy_project` era estreito e a ausência de edição era
esperada. Aqui a ausência é **a própria superfície de risco** — uma escrita em produção por este
canal não aparece em `list_edits`, não vira commit, e no banco só existiria em `pg_stat_statements`
e nos logs do Supabase. **O canal é mudo por desenho.**

### Duas descrições de ferramenta que não batem com o payload

Mesma classe de defeito que derrubou o "verbatim" da Camada 1 — **declaração não lastreada pelo que
a ferramenta entrega**:

- `get_workspace` promete *"plan, credit balance, member count, and settings"*. O payload traz
  `plan: "pro"` e **nenhum saldo**. Por isso o custo desta camada foi **estimado, não medido** — o
  contrário do que a §"A cobaia" da Camada 2 conseguiu fazer.
- `get_database_status` promete o status do banco e devolve `{enabled, stack}` — sem ref. É o que
  forçou a guarda fail-closed por dentro.

### O que a Camada 3 NÃO autoriza

- 🔴 **O papel foi medido na COBAIA, não em produção** — por desenho, porque `query_database` nunca
  foi apontada ao `8f005805-…`. Mesmo MCP e mesmo caminho de provisionamento tornam a inferência
  forte, **mas é inferência**. Dito isto: **a recomendação abaixo não depende dela.** Mesmo que o
  papel de produção fosse mais estreito, continuariam valendo os dois parâmetros, a ausência de
  read-only/dry-run e o silêncio em `list_edits` — que são propriedades da **ferramenta**, medidas
  no schema, não do banco.
- **O banco era virgem.** Zero tabelas, zero extensões do repo, zero triggers, zero carga. A
  atomicidade medida vale para DDL simples num banco vazio; não fala por uma migration real sobre
  ~centenas de tabelas com lock contention.
- **`CREATE INDEX CONCURRENTLY`, `VACUUM` e afins não foram testados.** Eles não rodam dentro de
  bloco transacional, e o lote multi-statement **é** uma transação implícita (medido) — então há
  motivo concreto para suspeitar que falhem acompanhados de outro statement. **Suspeita, não
  medição:** parte das migrations reais do repo pode simplesmente não passar por este canal.
- **Nada foi testado sob concorrência**, nem com outro projeto que o founder não possua (não havia
  id para isso), nem com timeout/statement longo.
- **N = 1 projeto, 1 sessão.**

### A recomendação — a regra do CLAUDE.md fica exatamente como está

**Escrita só pelo SQL Editor, founder colando.** A medição não abre exceção; ela fecha a discussão,
por três razões que agora são medidas e não suposições:

1. **Não existe configuração que torne isto seguro hoje.** A ferramenta tem dois parâmetros. Não há
   papel restrito a pedir, modo de leitura a ligar, nem dry-run a exigir. O `psql-ro` funciona
   porque o read-only mora no **wrapper** — e aqui a chamada é direta ao MCP, sem lugar onde pendurar
   um wrapper.
2. **Do lado da LEITURA, `query_database` não acrescenta nada.** O `psql-ro` já cobre
   leitura/diagnóstico com read-only garantido. Trocar por um canal `postgres`-com-`BYPASSRLS` seria
   pagar todo o risco por zero benefício.
3. **O que se ganharia é o clique do founder; o que se perderia é a única testemunha humana.** No
   SQL Editor alguém **lê o SQL antes do Run**. Neste canal não há revisor, não há registro em
   `list_edits`, não há commit. A Lei de Ferro #2 da `lovable-db-operator` — toda mudança vem com
   query de validação porque o founder precisa distinguir "aplicado" de "esqueci de colar" — perde o
   sujeito: não haveria ninguém para esquecer.

**O que a Camada 3 exigiria para mudar de veredito** (para não virar "nunca, porque sim"): um modo
read-only ou um parâmetro de papel na própria ferramenta; ou um ledger de escritas equivalente ao
`deploy_atestacoes`, alimentado server-side — algo que torne a escrita **visível depois de
acontecer**. Nenhum dos dois existe hoje.

💡 **Uma proposta que converte o crédito já gasto em valor permanente** (proposta, não decisão): a
cobaia agora é um **Supabase PG17 real, vazio e descartável**, com o schema `auth` completo (23
tabelas medidas) e os papéis `anon`/`authenticated`/`service_role`. Isso é justamente o que o PG17
local dos `db/test-*.sh` **não** replica — e foi o que permitiu o teste de `BYPASSRLS` com controle
negativo desta seção. Ela serve como **bancada de ensaio de RLS e de migration**: rodar a migration
de verdade ali antes de o founder colar no SQL Editor, com `SET ROLE authenticated` de verdade. Sem
tocar em produção, e sem mexer na regra.

## O que o veredito não autoriza

O piloto respondeu **uma** pergunta. Estender além disto é refazer o erro que ele existiu para
corrigir.

- **`query_database` continua fora — e desde 2026-09-07 isso é MEDIDO, não precaução** (§Camada 3).
  Ela entra como `postgres`, dono do projeto, com `BYPASSRLS` medido em comportamento; não tem
  read-only nem dry-run; e a escrita não deixa rastro em `list_edits`. Abrir escrita segue sendo
  decisão do founder em conversa própria, não efeito colateral de um piloto. Esta sessão teve a tentação concreta: o disparo da sonda é um
  `INSERT`, e `query_database` o resolveria sem o founder. Não foi usado — usá-lo mediria um canal
  não-testado **com** outro, e contaminaria o veredito.
- **`deploy_project` (o Publish do frontend) era outra camada, e foi MEDIDA em 2026-09-08** —
  §Camada 2; e a **migration** em 2026-09-07 — §Camada 3. As três camadas manuais do Lovable são
  independentes, e o resultado de uma não se estende às outras.
- **N = 1.** Uma edge, uma chamada, um ANTES conhecido. Isso é estritamente mais forte que a medição
  de 2026-09-06 (8 edges, ANTES desconhecido, transição não observável), e é o que faltava para
  fechar aquela lacuna — mas só na metade CANAL. Não é "o MCP nunca edita": é "nenhuma edição
  REGISTRADA nesta", e a rede que pegaria uma edição NÃO registrada não existe hoje.
- **A cobaia foi escolhida por ser inócua.** `farmer_copilot_sessions` = 0, zero escrita, closure de
  7 arquivos. Uma edge grande ou money-path é mais superfície para o agente "melhorar", e este
  resultado não fala por ela.

## O fallback continua de pé

`bun run pendencias:prompt` (#2331) entrega a colagem pronta da leva, e é o caminho que já
funcionava. O MCP tira o clique; sem ele, o clique continua onde sempre esteve. Nada ficou travado
neste piloto em momento algum.

**Uma lição operacional da entrega, que não é sobre o MCP:** o bloco que o `sonda:sql` emite tem **6**
linhas de comentário `--` na parte externa (medido: `sed -n "1,$((ab-1))p"` até a abertura do
`$sonda$` + `grep -cE '^[[:space:]]*--'`; a primeira versão dizia 11, que era o arquivo JÁ com as 4
linhas de cabeçalho que eu mesmo prependi — contei a minha própria adição como se fosse do gerador). Entregue como **arquivo**, tudo bem; colado no chat, uma
colagem que colapse em linha única faz os `--` comentarem a query inteira. Nesta sessão o founder
pediu o SQL no chat, e o que foi entregue foi um recorte **mínimo e sem comentário nenhum** do mesmo
disparo — com o miolo (`url`/`headers`/`body`/`timeout`) conferido byte a byte contra o gerador, e
imprimindo `edge | request_id` **pareados**, que é a mitigação que a `lovable-deploy-verify` §Lei de
Ferro #5 já prescreve contra id transportado à mão. O que se perde no recorte é o mapa embutido no
Passo 2 — ele torna determinados três casos de borda (bundle pré-sensor, recusa HTTP e o 401
ambíguo); sem ele a leitura sai `INDETERMINADO` neles, que é o comportamento certo, não um verde
fabricado. Aqui não foi preciso: o eco do slug bastou.

## Caminhos já FECHADOS — não re-testar

- **PAT / Management API**: fechado por **medição** em 2026-09-07, não por lembrança. A conta
  GitHub do founder no `supabase.com` tem UMA org com 2 projetos, ambos pausados e zerados; o ref de
  produção `fzvklzpomgnyikkfkzai` **não aparece em nenhuma org dela**. Trocar de identidade não
  resolve — o projeto está em outra org (a do Lovable), não atrás do login errado. Detalhe em
  `docs/agent/deploy.md`.
- **Mover edges para runtime próprio** (Deno Deploy/Cloudflare): descartado — a edge que mais churna
  é um hub (10 arquivos em `src/` + cron + chamada por outra edge), então o piloto "cron-only" que
  salvaria a ideia não existe.
- **Auto-deploy disparado por PUSH na `main`**: descartado — o bot do Lovable commita direto na main
  **171×/60d** (medido 2026-09-08: `git log origin/main --since='60 days ago' --author='gpt-engineer-app' --oneline | wc -l`;
  a primeira versão deste doc dizia "~24×", sem fonte — errado por 7×, e na direção que torna o
  argumento MAIS forte) e já reverteu fix mergeado (#1076, #1445→#1478). Deploy em push cru levaria a reversão
  dele a produção em minutos. Se um dia automatizar, o gatilho é **merge de PR** (sufixo `(#NNN)`) e
  quem decide é `pendencias:deploy`.

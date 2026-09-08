# Piloto: o MCP do Lovable deploya edge? — o CANAL sim; VERBATIM não foi atestado (2026-09-07)

> ⚠️ **Este doc foi CORRIGIDO em 2026-09-08.** A primeira versão dizia "deploya edge
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

## O que as revisões derrubaram (2026-09-08)

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

Nenhuma das duas foi implementada aqui. (a) toca o gerador de prompt de TODOS os deploys, então é
entrega própria, com falsificação própria.

## O que o veredito não autoriza

O piloto respondeu **uma** pergunta. Estender além disto é refazer o erro que ele existiu para
corrigir.

- **`query_database` continua fora.** O MCP a expõe com poder de escrita (*"supports reads, writes,
  and schema changes"*), e isso **contraria a regra atual do CLAUDE.md** — escrita só pelo SQL
  Editor, founder colando. Mudar isso é decisão do founder em conversa própria, não efeito colateral
  de um piloto que testou outra coisa. Esta sessão teve a tentação concreta: o disparo da sonda é um
  `INSERT`, e `query_database` o resolveria sem o founder. Não foi usado — usá-lo mediria um canal
  não-testado **com** outro, e contaminaria o veredito.
- **`deploy_project` (o Publish do frontend) é outra camada, e segue não medida.** As três camadas
  manuais do Lovable são independentes: este piloto cobre **edge**, não frontend nem migration.
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

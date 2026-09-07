# Piloto: o MCP do Lovable deploya edge verbatim? — o ANTES fabricado (2026-09-07)

**Status: o ANTES está montado; o veredito NÃO existe.** O MCP do Lovable está registrado nesta
máquina e **não autenticado** (`claude mcp list` → `lovable: https://mcp.lovable.dev (HTTP) -
! Needs authentication`), e a sessão que montou isto não roda o fluxo OAuth. Este doc registra o
desenho, a escolha da cobaia e o que ainda falta — **não** um resultado. Quem retomar: o veredito
é o Passo 3, e enquanto ele não rodar a resposta certa para "o MCP deploya?" é *não medi*.

## A pergunta, e por que ela precisava de um ANTES

Deploy de edge no Lovable é manual: alguém abre o chat do projeto e pede. A pergunta do piloto é se
o **MCP oficial** (`send_message`) tira esse clique — publicando a edge **verbatim** a partir da
`main`, sem o agente do Lovable "melhorar" nada no caminho.

A medição de 2026-09-06 já tinha tentado responder e conseguiu só metade. Ela rodou sobre 8 edges
`NUNCA_ATESTADA` — ou seja, **antes desconhecido**. Nessa condição, "o MCP deployou as 8" e
"algumas já eram byte-idênticas ao que estava servido" produzem **o mesmo eco**, e nada no
resultado separa os dois. É a regra de evidência positiva aplicada ao tempo: sem saber o estado
anterior, o estado posterior não é diferença, é só estado.

Daí o Passo 1 deste piloto: **fabricar uma divergência MEDIDA** antes de chamar o MCP.

## Passo 1 — o ANTES conhecido (é o que este PR entrega)

Bumpar o `VERSAO` de uma edge muda o `versao.ts`, que está no **closure** do fingerprint, logo muda
**também** o `fonte`. Par ≠ par ⇒ a edge cai em **`DIVERGE_P1` medido**, não em `NUNCA_ATESTADA`
(que é ausência de dado). Concretamente, este PR:

- `supabase/functions/copilot-analyze/versao.ts`: `v1.0-sensor-inicial` → `v1.1-piloto-mcp-lovable`
- `supabase/functions/_shared/sonda-fingerprints.ts`: **uma** linha, a da cobaia
  (`c37ca500…` → `5989e8e2…`) — o diff prova que nenhuma outra edge foi arrastada junto.

Estado do ledger imediatamente antes, medido (não lembrado): `bun run pendencias:deploy` → **rc=0,
59/59 conferem**, cobertura `ledger ∪ janela viva`. Não havia edge divergente para pilotar — por
isso a divergência precisou ser fabricada.

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
- **zero escrita de aplicação** e zero `fetch` direto — as linhas de `farmer_copilot_sessions` são
  gravadas pelo app, não pela edge;
- closure de 7 arquivos;
- e o que zera o raio de dano: **`farmer_copilot_sessions` = 0**, medido nesta sessão via `psql-ro`
  **com controle positivo na mesma query** (`omie_products` = 7.997 — a query enxerga, então o zero
  é veredito e não vazio). O app grava a sessão **antes** de invocar a edge ⇒ zero sessões implica
  zero chamadas: a feature nunca foi ligada. Um deploy malfeito aqui não atinge usuário nenhum.

O bump não acompanha mudança de comportamento — e isso está dito no próprio `versao.ts`, para
ninguém procurar depois por uma alteração que não existe.

## ⚠️ NÃO DEPLOYE `copilot-analyze` PELO CANAL MANUAL

Depois do merge, `bun run pendencias:deploy` vai listar `copilot-analyze` como **`DIVERGE_P1`** —
corretamente, porque ela diverge de verdade. Esse é o **objeto do experimento**, não uma pendência
solta. Deployá-la pela colagem manual de rotina consome o ANTES e mata o piloto: o depois fica
idêntico ao esperado por um caminho que não era o testado, e o resultado se lê exatamente como um
MCP que funcionou. É a mesma classe de "veredito da sessão errada" que
`docs/historico/closure-de-hash-nao-e-lista-de-deploy.md` §2 registra — o número bate, a causa não.

### E há uma leva aberta AGORA — a ordem importa

Medido em 2026-09-07, já com este branch pronto: `pendencias:deploy` (que lê **`origin/main`**,
`REF_MAIN`, não a working tree — por isso a cobaia ainda não aparece) reporta rc=1 com
**`disparar-pedidos-aprovados` em `DIVERGE_P1`**, vinda do #2285 (money-path). Ou seja: existe uma
colagem de deploy pendente antes mesmo de este PR mergear.

Se este PR mergear primeiro, `pendencias:prompt -` monta **uma colagem com as duas** — e a cobaia
vai a produção pelo canal manual junto com a outra, sem ninguém decidir isso. **A ordem correta é
deployar a leva do #2285 ANTES de mergear este PR**, para que `copilot-analyze` fique sozinha na
lista e a leva do piloto não tenha como se misturar. Custo zero: aquele deploy é necessário de
qualquer jeito.

Se o piloto for abortado, deploye normalmente **e escreva aqui que foi por esse caminho**; o que
não pode acontecer é a divergência sumir sem ninguém saber quem a fechou.

## Passo 2 — deployar SÓ pelo MCP

`send_message` no projeto do Lovable, com o prompt que o gerador emite:

```bash
bun run pendencias:prompt copilot-analyze
```

**Nada colado à mão no chat.** Se o founder colar o prompt ele mesmo, o experimento perde o objeto:
o que está sob teste é o canal MCP, não o texto do prompt. O gerador é o do #2331, que já resolve a
armadilha do `closure ∪ {mapa}` (`docs/historico/closure-de-hash-nao-e-lista-de-deploy.md`): a fatia
de deploy **não** é o closure do hash, difere dele por exatamente `_shared/sonda-fingerprints.ts`.

## Passo 3 — o veredito, e o que ele prova de verdade

```bash
bun run sonda:sql copilot-analyze
```

O disparo precisa do founder (lê `vault.decrypted_secrets` e faz `INSERT` via `net.http_post`; o
wrapper read-only recusa os dois). A **leitura** é `SELECT` em `net._http_response` e o agente faz
sozinho (`--so-leitura`).

**O veredito julga o `fonte`, não só o `versao`.** Um deploy que suba `index.ts` + `versao.ts` e
deixe o mapa para trás responde `versao` CERTO e `fonte: "nao-mapeada"` — falso positivo, a classe
estritamente pior, porque **encerra** a verificação.

E o que o par prova, dito sem inflar: `versao` certo ⇒ o `versao.ts` novo subiu; `fonte` certo ⇒ o
**mapa** novo subiu. Os dois juntos matam o deploy parcial, que é o modo de falha real deste canal.
O que o par **não** prova sozinho é que os outros 5 arquivos do closure subiram sem edição — o
`fonte` é um fingerprint **declarado** por um arquivo commitado, não um hash calculado sobre o
bundle servido. Essa metade tem rede própria e ela é barata: **o agente do Lovable commita na
`main`**, então uma edição dele aparece como commit, e o gate `bun run sonda:fingerprint` fica
vermelho no CI se o mapa deixar de bater com a fonte. ⇒ **o Passo 3 tem duas leituras**: a sonda, e
`git log origin/main` depois do deploy, procurando commit do bot que toque
`supabase/functions/copilot-analyze/` ou `_shared/`.

## O que está fora deste piloto, de propósito

O MCP também expõe `query_database` (*"supports reads, writes, and schema changes"*) e
`deploy_project` (o Publish do frontend) — juntos, os três encostam nas três camadas manuais do
deploy. Fora de escopo aqui. `query_database` com poder de escrita **contraria a regra atual do
CLAUDE.md** (escrita só pelo SQL Editor, founder colando): mudar isso é decisão do founder, em
conversa própria, não efeito colateral de um piloto. Cada chamada do MCP gasta crédito Lovable e
mexe no projeto real — o doc oficial diz isso explicitamente.

## Fallback, se o MCP não servir

Nada fica travado: `bun run pendencias:prompt` (#2331) já entrega a colagem pronta da leva. O MCP
tiraria o clique; sem ele, o clique continua onde sempre esteve. A divergência fabricada por este PR
é deployável pelos dois caminhos, então ela não vira dívida se o piloto for abortado.

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
  ~24×/60d e já reverteu fix mergeado (#1076, #1445→#1478). Deploy em push cru levaria a reversão
  dele a produção em minutos. Se um dia automatizar, o gatilho é **merge de PR** (sufixo `(#NNN)`) e
  quem decide é `pendencias:deploy`.

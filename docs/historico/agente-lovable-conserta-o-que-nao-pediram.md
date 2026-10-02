# O agente do Lovable conserta o que ninguém pediu — e o sync empurra na main

> 2026-09-26/27. TRÊS vezes em quatro dias o pedido de deploy verbatim saiu certo e, na MESMA rodada,
> o agente editou OUTRAS edges por conta própria. Desfecho: o prompt passa a proibir o que ele fez
> (nomeando-o), exige uma linha de confirmação, e um sensor por fora confere a resposta do MCP e os
> commits do bot na `main`. Regra que fica: **o escopo de um pedido ao agente é o que o prompt
> PROÍBE, não o que ele pede — e a conferência não é a palavra dele.**

## 1. Os dois incidentes (medidos)

| | #2541 (2026-09-24) | #2579 (2026-09-26) |
|---|---|---|
| pedido | deploy verbatim da `omie-sync-sku-items` | deploy verbatim da `omie-sync-estoque` v1.2 (sessão do #2573) |
| o que o agente fez certo | conferiu os hashes e publicou | conferiu os 7 `sha256` e publicou |
| o que fez sem pedido | editou `whatsapp-inbound` (`SupabaseClient<any>`) | leu `/tmp/observability/build-errors.log` e "corrigiu" `whatsapp-inbound` (`SupabaseClient<any>`) e `sync-reprocess` (`omie_pedido_id: Number(codigoPedido)`) |
| commits do bot na `main` | `de48dff0a`, `a20f2fe30`, `5c9ddaff2` | `f84d7772e`, `eec8598d7` ("Changes") |
| sintoma | `bun lint` vermelho em todo PR (`no-explicit-any`) | `sonda:fingerprint` vermelho na `main` |
| reparo | revert `1460ea5e7` | revert #2579 — com bump de `VERSAO` (o `sonda:bump` compara contra a main COM os "Changes"): `whatsapp-inbound` v1.1-revert-changes-lovable, `sync-reprocess` v1.9-revert-changes-lovable |

### O 3º, no meio desta entrega (2026-09-27) — um experimento quase controlado

Dois turnos do MESMO agente, com os MESMOS 2 arquivos acusando typecheck no preview, a 14 min de
distância (dados do `list_messages`, levantados pela sessão do #2593):

| | turno A — 16:41:41Z → 16:42:55Z | turno B — 16:56:58Z → 16:58:21Z |
|---|---|---|
| quem mandou | sessão do #2593 | uma 3ª sessão |
| prompt | Passo 2 do pacote + parágrafo restritivo à mão ("No file changes … `NO FILES EDITED`") | Passo 2 PADRÃO do pacote, **sem guarda** |
| ferramentas | hash → `deploy_edge_functions` → `curl` ×2 → "NO FILES EDITED" | hash ×4 → `deploy_edge_functions` → `curl` ×3 → `code--exec` ×2 → **`line_replace` ×4** |
| edição | **nenhuma** (a confirmação era verdadeira) | `whatsapp-inbound` `supabase: Db` ×3 · `sync-reprocess` `Number(codigoPedido)` — e a resposta final as DECLARA |
| commits na `main` | — | `1b654757d`, `ea6339e52`, `5552991e2` (16:58:00–20Z, o fim do turno) |

Três leituras:

1. **n=1 a favor da guarda no prompt.** Com a proibição nomeada, zero edição; sem ela, 4. É o
   motivo de o `blocoDeEscopo` morar no GERADOR (`montarPrompt`), e não num parágrafo que cada
   sessão lembra ou não de colar. n=1 não é prova — por isso o sensor por fora continua.
2. **O agente separa "deploy" de "workspace".** O raciocínio dele no turno B: os bundles deployados
   seguem verbatim, "local fixes are workspace-only". Correto quanto ao bundle — os deploys vieram
   ANTES das edições, prod serve o verbatim — e errado quanto ao efeito: o workspace É a `main`
   (sync bidirecional). Daí a frase do bloco "Every edit you make is pushed straight to `main`".
3. **O deploy do turno B era redundante.** O ledger estava em exit 0 às 16:52:25Z; quem mandou não
   re-mediu imediatamente antes (§Deploy de edge — `pendencias:deploy` decide). Deploy
   desnecessário é exposição desnecessária à isca.

Revert: #2595 (o #2594, idêntico, ficou em draft para não duplicar). O bump de `VERSAO` que o
`sonda:bump` exige recria DIVERGE no ledger **sem nenhuma mudança de runtime** — e esse redeploy é
justamente o gatilho. Ver §6.

A mesma edição (`SupabaseClient<any>` na `whatsapp-inbound`) nas três vezes: o `build-errors.log`
do sandbox acusa o typecheck Deno daquela edge, e o agente, prestativo, "conserta" o que vê. Não é
acaso — é uma isca permanente no ambiente dele. Sem trava, a 3ª vez era questão de tempo.

### A 4ª rodada com isca (2026-09-27 19:35Z) — sem edição, e quem empurrou foi a PLATAFORMA

O pedido foi o Passo 2 do pacote (`sync-reprocess` + `whatsapp-inbound` em `718c9a811`, com o
`blocoDeEscopo`), mandado pela sessão do #2612. O agente conferiu os hashes, deployou e fechou com
`No files were edited.`, igual às 16:42Z e às 18:37Z. A novidade veio DEPOIS do fecho, no mesmo
turno: duas notificações de sistema do próprio Lovable reacordaram o agente. Ele as citou no
raciocínio. A primeira: *"There are build errors for the preview. Fix them … including the ones
that predate your changes. Don't ask first."* Depois de ele só reportar, a segunda: *"Still broken
after your fix attempt. Fix it, or if you cannot, say so plainly to the user and name the failing
file."* Ele chegou a planejar consertos em `process-nfe`, `process-recurring-orders` e
`promocao-extrair-via-vision`, e parou pela regra do Knowledge, que citou literalmente.

| eixo | 19:37Z | controle positivo: 16:58Z, o turno que editou |
|---|---|---|
| `edit_id` na mensagem do `list_messages` | ausente | presente |
| `code--line_replace` (com SUBLINHADO: com hífen, o grep dá zero até no turno que editou) | 0. Os 7 `code--exec` só leem: `tail`, `rg`, `grep`, `sed -n` e `bun run edges:typecheck` | 5 chamadas: 4 na `whatsapp-inbound` e 1 na `sync-reprocess` (a tabela do 3º incidente conta 4) |
| commits `gpt-engineer-app` na `main` | 0 em 32 min (sensor `SEM_EDICAO`) | 3 |

O log mudou de forma. Às 18:37Z eram 7 erros, todos na `whatsapp-inbound`, e não houve
notificação. Às 19:37Z, com o workspace em `718c9a81`, o log trazia o `deno check` cru de TODAS
as edges em modo `node_modules`: 46 linhas `[ERROR]` em 9 edges e 3 pacotes npm que o
`node_modules` do sandbox não tem (`@anthropic-ai/sdk`, `web-push`, `@simplewebauthn/server`).
As 46 linhas se dividem assim:

- `enviar-pedido-portal-sayerlack`: 13
- `fin-cashflow-engine`: 12
- `omie-analytics-sync`: 7
- `omie-nfe-webhook`: 4
- `nvoip-calls`: 4
- `omie-sync-metadados`: 3
- `process-nfe`, `process-recurring-orders` e `elevenlabs-transcribe`: 1 cada

A tabela do agente soma exatamente os 46 do `grep -c ERROR` dele. **`whatsapp-inbound` e
`sync-reprocess` não aparecem: a isca DELAS fechou.** O resultado reproduz local, com controle: o
`deno check` do pai do #2612 dá 7 erros e o da main dá 0, tanto com `--node-modules-dir=manual` (o
modo do sandbox) quanto com `none` (o do gate). O turno custou **3,2 créditos**; um deploy sem o
empurrão custa entre 0,9 e 1,4.

Duas leituras:

1. **A isca virou a dívida inteira.** A plataforma oferece ao agente, com ordem de consertar sem
   perguntar, tudo o que cair no `build-errors.log`. Isso vale enquanto a dívida de tipo que o
   `edges:typecheck` tolera por desenho (spec `2026-07-21-edges-typecheck-gate-design.md`) estiver
   no log, e ela inclui money-path: `fin-cashflow-engine`, `process-nfe`, o portal Sayerlack e as
   `omie-*`. O Knowledge segurou contra uma ordem explícita da plataforma, mas n=1 não é garantia.
   Toda mensagem ao agente é exposição, então só se manda o que o ledger pede.
2. **O `No files were edited.` sai ANTES das rodadas reacordadas.** O sensor acha a linha presente,
   mas ela não é a última palavra do turno. Quem decide são os eixos por fora: o `edit_id` e os
   commits.

## 2. Por que o prompt não segurou

O prompt dizia *"Deploy it **verbatim** — do NOT modify, reinterpret, "improve", or reformat any
code"*. O agente obedeceu **à letra**: não modificou os arquivos DA EDGE pedida. O texto não dizia
nada sobre (a) OUTROS arquivos, (b) erros vistos em LOG e (c) o que fazer DEPOIS do deploy. As três
brechas são exatamente o caminho que ele tomou. Proibição para LLM tem de nomear o comportamento,
não a intenção.

## 3. O que entrou

- **`blocoDeEscopo()`** em `scripts/lib/prompt-deploy.ts`, nos DOIS ramos do `montarPrompt` (1 edge
  e leva) — logo, também no Passo 2 do `pendencias:pacote`: nenhum arquivo editado/criado/renomeado/
  apagado, "nem os listados nem qualquer outro"; erro de build/typecheck/warning visto em
  `build-errors.log` ou em qualquer lugar é **só listado**; vale "before, during or after the
  deploy"; e a resposta termina com a linha exata `No files were edited.` (ou a lista do que tocou).
  `MARCAS_DE_ESCOPO` entra no `conferirCobertura`: colagem sem qualquer frase reprova
  (`escopo:<frase>`), e o `pendencias:prompt` sai 2.
- **`scripts/lovable-sensor-edicao.ts`** — rode ≥5 min depois do envio, com a resposta salva em
  arquivo: `--desde <ISO do envio> <arquivo>`. Dois eixos por fora da palavra do agente:
  `edit_id`/`commit_sha` não-nulos na resposta do MCP (inclusive dentro de JSON embrulhado em
  string), e commits `gpt-engineer-app` na `origin/main` desde o envio — o `git fetch` é do script.
  Só `src/integrations/supabase/types.ts` é tolerado (o "Lovable update" que regenera os tipos a
  cada deploy limpo, medido em 2026-09-08 e 2026-09-26). Exits: 0 `SEM_EDICAO` · **1
  `EDICAO_DETECTADA`** · 2 mecânica · 3 `SEM_CONFIRMACAO` · 4 `CEDO_DEMAIS` · 5 `ILEGIVEL`.
- **O Passo 2 do pacote** manda anotar o instante do envio e rodar o sensor (só quando há colagem).

## 4. Desenho — as decisões que não são óbvias

- **Ausência de dado nunca vira `SEM_EDICAO`.** O sync empurra com atraso: ler a `main` logo depois
  do envio e achar zero commits é *ainda não*, não *limpo* (`CEDO_DEMAIS`, a lição do
  `espera-sem-desistencia.md` na dimensão tempo). Resposta vazia é `ILEGIVEL`. E a confirmação
  ausente é `SEM_CONFIRMACAO` — o agente não fez a parte dele, leia a resposta.
- **A confirmação é sinal FRACO, de propósito.** LLM afirma o que quiser; presença não absolve, e
  por isso edição provada em qualquer eixo vence a confirmação.
- **Tolerância por lista, não por prefixo.** `startsWith('src/')` tolerava o `src/App.tsx` que o
  agente decidisse "consertar" — falsificado (S10).
- **Retroativo como calibração.** Rodado com `--desde 2026-09-24T00:00Z` sobre o histórico real:
  pega os **5** commits dos dois incidentes e tolera os **2** de `types.ts` (exit 1).

## 5. Evidência

- `bunx vitest run` nas 5 suítes afetadas (`prompt-deploy`, `pacote-entrega`,
  `lovable-sensor-edicao`, `pendencias-pacote`, `pendencias-prompt`): `Test Files 5 passed (5)`,
  `Tests 131 passed (131)`, exit 0. (A 1ª execução morreu em `Timeout calling "fetch"` do worker sob
  ~11 GB de swap — mecânica, não código; reroda com `--maxWorkers=1`.)
- `bun run falsificar:prompt-escopo`: controle verde nos dois locales na MESMA invocação e
  **24/24** sabotagens (12 × `C`/`pt_BR.UTF-8`) vermelhas pela marca certa — frase amputada (S01-S03),
  bloco fora de cada ramo (S04/S05), cobertura cega (S06), pacote sem o sensor (S07), e cinco
  defeitos do sensor (S08-S12). Exit 0.

## 6. O que fica descoberto (nomeado)

- **O formato real da resposta do `send_message` não estava documentado.** O sensor busca as chaves
  em qualquer profundidade; a 1ª resposta real de deploy calibra (anote-a aqui).
  **Calibrado em 2026-09-27 18:36Z** (pacote `4c8fbc2a4a6d`, `sync-reprocess` + `whatsapp-inbound`,
  1,4 crédito, 1ª leva com o `blocoDeEscopo`): a resposta tem só `status`, `message_id`, `content`,
  `cost_credits`, `thread_id` e `preview_url` — sem `edit_id`/`commit_sha` —, o `content` fecha com
  `No files were edited.` e o sensor deu `SEM_EDICAO` aos 5,5 min. A isca estava lá: o agente leu o
  `build-errors.log`, viu os 7 erros de typecheck do `whatsapp-inbound` e só os REPORTOU (n=2 a
  favor da guarda). O eixo mais forte é o `list_messages`: nas 5 respostas do agente de 26–27/09,
  a mensagem traz `edit_id` (`edt-<uuid>`) nos 2 turnos que editaram (10:03Z de 26/09, o #2579, e
  16:58Z de 27/09) e em nenhum dos 3 com guarda (10:09Z de 26/09, 16:42Z e 18:37Z de 27/09).
- **O `list_edits` do MCP** é um terceiro eixo possível (edições do projeto no Lovable, antes do
  sync). Não entrou: o eixo `main` é o que importa (é onde o estrago vira código servido/CI), e ele
  já pegou os dois casos.
- **A isca continua lá — e é a CAUSA.** O typecheck do preview segue acusando `whatsapp-inbound`
  (tabelas `whatsapp_*` fora dos tipos gerados ⇒ `never`) e `sync-reprocess` (`omie_pedido_id`). Três
  incidentes com o mesmo diff: consertar por PR revisado (o `Number(codigoPedido)` é runtime no
  caminho de pedidos do Omie ⇒ money-path, Codex) tira a tentação — entrega separada.
  **Fechado em 2026-09-27, só no TIPO:** `whatsapp-inbound` passa a receber `SupabaseClient` (idioma
  das edges; `ReturnType<typeof createClient>` fixava o schema em `never`) e `sync-reprocess` tipa
  `omie_pedido_id` como `string | number` num tipo local. O `Number()` do bot NÃO entrou: medido em
  prod, a RPC `reconciliar_pedidos_omie` não grava o campo em coluna — só o ecoa cru
  (`v_pedido->'omie_pedido_id'`) no registro de falha, e o `Number()` mudaria o eco justo no caso
  anômalo (string não numérica → `null`, > 2^53 perde dígito). Prova: `deno check` completo limpo
  nas duas (antes 7 + 1 erros) e JS emitido byte-idêntico antes/depois, com controle sabotado vermelho.
  **Medido no log às 19:37Z (§1, 4ª rodada):** as duas edges saíram do `build-errors.log`, mas a
  classe ficou. O log passou a trazer a dívida de tipo de 9 edges, e a própria plataforma manda
  consertá-la.
- **Todo revert de edição do bot fabrica uma pendência de deploy.** O `sonda:bump` não distingue
  "voltei aos bytes de um commit ancestral" de "mudei a edge"; o bump recria DIVERGE sem mudança de
  runtime, e o redeploy é a isca. A regra candidata (isentar o retorno aos bytes ancestrais) foi
  medida e **rejeitada**: a sonda devolve o `fonte` do mapa compilado, e o bot não regenera o mapa ⇒
  corpo do bot deployado responderia o par canônico — o redeploy forçado pelo bump é a única prova
  de que prod voltou. Ver [sonda-bump-retorno-ao-canonico.md](sonda-bump-retorno-ao-canonico.md).
- **O eixo da RESPOSTA acusa a regeneração de tipos (medido em 2026-10-01).** No deploy de 6 edges
  das 08:09Z, a plataforma regenerou o `src/integrations/supabase/types.ts` 20 s depois do pedido
  (`01126cee`, merge `f23ccab5`, +14/−6). A resposta veio com `edit_id`/`commit_sha` e o transcript
  não tem nenhuma tool de escrita do agente. O sensor dá `EDICAO_DETECTADA` com qualquer sinal na
  resposta (a tolerância ao `types.ts` só existe no eixo dos commits), então acusaria um deploy puro.
  Antes de reverter, leia os arquivos do `commit_sha`: se for só o `types.ts`, é o efeito colateral
  conhecido e não há o que reverter.

## 7. A segunda fonte da colagem — os moldes à mão da skill (2026-10-01)

- **O briefing era de 26/09, e o artefato já estava na `main`.** O pedido (pôr no prompt gerado a
  proibição de editar qualquer arquivo) foi escrito antes do #2596. O `git grep -niE "do not edit any
  file"` dava 0 porque a frase entregue é `Do NOT edit, create, rename or delete ANY file`. Grep pela
  redação ESPERADA é cego ao artefato: procure o SÍMBOLO (`blocoDeEscopo`).
- **O que faltava era a 2ª fonte.** O `pendencias:prompt` e o Passo 2 do `pendencias:pacote` passam
  pelo `montarPrompt`, mas o Passo 3 da `lovable-deploy-verify` ainda ensinava 3 moldes à mão (1 edge
  com 1 arquivo, 1 edge com N, a leva). O de 1 edge vinha como "o que você usa quando a leva tem uma
  só", e nenhum dos três tinha escopo nem conferência. Os moldes saíram e entrou o ponteiro ao
  gerador, que aceita qualquer edge pelo nome. O `[COLAGEM_SO_DO_GERADOR]` (`prompt-deploy.test.ts`)
  varre skills, `docs/agent`, runbooks e `CLAUDE.md` pela assinatura da família do prompt, com o `> `
  e as quebras de linha desfeitos. Dois controles impedem que ele aprove por vacuidade: a assinatura
  casa a saída do gerador, e a varredura lê uma testemunha de cada lugar.
- **O efeito do #2596, com denominador.** A fonte é o `list_messages` + `list_edits` do `steu`, de
  27/09 18:20Z a 01/10 21:39Z, com a janela coberta inteira. Foram 11 pedidos de deploy, todos com a
  frase de escopo, e **0 edições de edge**. O único `edit_id` é a regeneração de tipos (§6). A rodada
  que a plataforma reacordou (27/09 19:35Z, "Fix them") só leu e recusou. No git, nenhum commit do
  `gpt-engineer-app[bot]` em `supabase/functions/` desde o merge (o filtro casa `eec8598d7` e
  `f84d7772e`, os do #2579).

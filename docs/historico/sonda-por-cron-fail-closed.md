# A sonda de deploy virou cron sem poder disparar o efeito — e o header num POST não bastava

> 2026-09-06. Continuação direta de [`deploy-redundante-ledger-e-cron-de-sonda.md`](deploy-redundante-ledger-e-cron-de-sonda.md)
> §5, onde a "sonda automática segura" ficou nomeada como entrega própria. Desfecho: o cron
> pergunta a versão por **`OPTIONS` via edge-relé**, com credencial dedicada, e a segurança é
> provada **executando cada closure histórico** das edges da allowlist. Regra que fica:
> **perguntar a versão só é seguro pelo request que TODO bundle já interrompia antes de existir
> sensor — e "todo bundle" se prova executando, não lendo.**

## 1. O ponto de partida

O ledger `deploy_atestacoes` (#2199) deu memória ao veredito de deploy, mas a sonda continuou
**humana**: um cron que mandasse `{"probe":true}` para as 54 edges instrumentadas executaria o
fluxo real em qualquer bundle que não conhecesse o classificador — na `monthly-report`, e-mail para
5.276 perfis. O parecer que derrubou aquele cron formulou o ciclo: *sondar para descobrir se o
sensor existe é executar o request que o bundle pré-sensor lê como fluxo real*.

## 2. A primeira resposta, e por que ela era FALSA

O desenho inicial (v1 da spec) trocava a credencial em vez do corpo: o cron mandaria `POST` com um
header novo (`x-sonda-credencial`) e **sem** `x-cron-secret`. A aposta: para o bundle velho isso é
um request **não autenticado**, e ele morre no gate antes de tocar em qualquer coisa.

O challenge derrubou com contraexemplo, e a medição confirmou **executando os bundles reais**:

| bundle histórico | `POST {}` **sem credencial nenhuma** | `OPTIONS` do relé |
|---|---|---|
| `monthly-report@ef08dddd2` (2026-02) | **2 efeitos** — lê perfis e chega ao Resend | 200, **0 efeitos, 0 fetch** |
| `calculate-scores@45a80118b` (2026-03) | **11 efeitos** — `from/select/range/in`… | 200, **0 efeitos, 0 fetch** |

Esses bundles **não autenticam nada**. Nenhuma credencial protege quem não pede credencial. A lição
é mais geral do que o caso: **uma defesa que depende de o alvo checar algo não vale contra a versão
do alvo que não checava** — e a história de um repo com deploy manual está cheia dessas versões.

## 3. O que entrou

- **`_shared/sonda-cron.ts`** — a credencial é HMAC-SHA256 de uma chave **dedicada**
  (`SONDA_HMAC_KEY`, só nos secrets das edges) sobre a mensagem `sonda-de-versao:v1:<edge>`.
  Dedicada porque a credencial é observável por quem a recebe: derivá-la do `CRON_SECRET` faria dela
  um verificador offline daquele segredo. Por edge, para que uma credencial vazada não sonde outra.
  Verificação por `crypto.subtle.verify` (tempo constante). `atenderSondaOptions` responde **dentro
  do bloco `OPTIONS`** e devolve `null` em qualquer dúvida — *na dúvida, preflight*, porque um 4xx
  ali mudaria o CORS do app inteiro.
- **`sonda-relay`** — o `pg_net` (0.19.5) só emite GET/POST/DELETE, então o cron fala com este relé
  por POST autenticado e ele emite o `OPTIONS`. É o único componente cujo bug seria catastrófico, e
  tem três camadas independentes: o request nasce em `montarRequestSonda` (**sem parâmetro de
  método**, `redirect: "manual"`), a `barreiraSaida` reconfere o objeto em runtime, e o gate G3
  exige um único `fetch` que receba justamente essa variável.
- **Allowlist positiva** (`_shared/sonda-cron-alvos.ts`), default-deny no relé e no banco (F2).
- **A prova** (`bun run sonda:cron-prova`): enumera os closures históricos por **ponto fixo**,
  materializa cada um com `git archive`, executa com stubs que contam todo efeito e classifica.
  **84 closures aprovados** nesta fatia: relé 5, `monthly-report` 33, `calculate-scores` 46.
- **O teste sempre-on** (`bun run test:sonda-rollback`) fixa os 5 bundles de referência e o relé.

## 4. Por que a prova é por EXECUÇÃO

Um critério textual ("o gate vem antes do IO?") aplicado às 1.164 versões dos 54 `index.ts`
reprovou **37 edges** — parte ruído (helper de auth chamado por nome próprio, `Deno.serve(` dentro
de comentário), parte ausência real de autenticação. Texto ou reprova o seguro, ou aprova o que não
leu. O runner executa e conta; e cada veredito vem pareado com um **controle positivo** — o mesmo
bundle, com credencial que o autorize, tem de fazer o contador subir. Sem isso, "zero efeito" é
indistinguível de "o instrumento está cego", que foi exatamente a sabotagem S2.

**O relógio virtual** existe porque efeito agendado antes do `return` (`setTimeout`,
`EdgeRuntime.waitUntil`) acontece **depois** da resposta: ler o contador na hora do `return` diria
zero e estaria mentindo.

## 5. As armadilhas que morderam durante a escrita (todas da mesma família)

1. **Default de parâmetro escapa do try.** `chave = Deno.env.get(...)` como default é avaliado
   **antes** do corpo: no sandbox do `deno test` sem `--allow-env` — que é como o `test:edges` roda
   de propósito — a leitura lançaria e derrubaria a edge no ramo mais silencioso que existe. A env
   passou a ser lida dentro do `try`; ambiente ilegível é ausência de chave, e ausência é CORS.
2. **`git archive` aborta com pathspec que não casa** — `_shared/` não existia em fevereiro de 2026.
   Filtrar é certo; materializar vazio em silêncio seria "zero efeito" fabricado. Daí a checagem do
   `index.ts` extraído.
3. **Um `catch` mudo virou veredito.** Um `PermissionDenied` do sandbox (tempdir fora do
   `--allow-read`) foi reportado como "materialização vazia". A causa agora vai na mensagem.
4. **O fecho tem de ser o da EDGE, não o do diretório.** Extrair os especificadores remotos de todo
   o `_shared/` fazia um arquivo que a edge nem importa (`jsr:` de outro módulo) tornar o closure
   `INVERIFICAVEL`. O fecho transitivo a partir do `index.ts` é a medida certa.
5. **O cache guardava a memória de uma pergunta que mudou.** O veredito de (a) depende do `desde`
   (antes dele, responder a sonda é `FALHA`; a partir dele, **não** responder é), e o `desde` não
   estava na chave. Entrou. Pela mesma razão, entradas órfãs passaram a ser **podadas**: manifesto
   que só cresce vira arquivo em que ninguém distingue prova viva de resíduo.
6. **O fecho não inclui o que é DERIVADO dele.** O mapa de fingerprints entrava no fecho, e como
   ele é regerado por qualquer PR de edge, cada regeneração criava um closure novo de toda a
   allowlist: 145 "closures distintos" dos quais 61 diferiam só pelo mapa. Excluí-lo (como o
   gerador oficial já fazia) deixou 84 closures que diferem de COMPORTAMENTO.
7. **Sha do próprio branch não sobrevive ao merge.** O veredito de (a) dependia de "este closure
   veio depois do commit X", com X gravado na allowlist — e o rebase reescreve X, o squash do
   auto-merge o descarta. Logo após o merge, todo closure novo (os que atestam) viraria `FALHA`. A
   pergunta certa é sobre o closure, não sobre a linha do tempo: **ele contém o ramo?**
8. **Gate textual que mede a STRING mede a documentação junto.** O G3 reprovava o relé por conter
   `x-cron-secret` — que está no CORS de **entrada**, legítimo (é o header que o cron manda PARA
   ele). Agora ele mede a **variável**: o `fetch` tem de receber o request que nasceu em
   `montarRequestSonda` e passou pela `barreiraSaida`. E usa o stripper **compartilhado**, com
   sentinela de sub-limpeza.

## 6. Evidência

- `bun run test:sonda-rollback` — 4 testes: bundles velhos reais inertes com controle positivo
  (2, 4, 4, 11 e 1 efeitos nos controles), bundle atual atestando, relé emitindo 1 `OPTIONS`,
  paridade dos vetores HMAC.
- `bun run sonda:cron-prova -- --backfill --tudo` — **84/84 closures PASSA** (relé 5,
  `monthly-report` 33, `calculate-scores` 46).
- `bun run sonda:cron-prova -- --falsificar` — **9/9 sintéticos** com o veredito esperado (6 formas
  perigosas do `OPTIONS` reprovadas: IO top-level, IO antes da comparação de método, helper com IO
  no ramo, fallthrough, assíncrono antes do return, header aceito sem verificação; 3 inofensivas
  aprovadas: gate ignorado, ramo morto, forma canônica).
- **Falsificações, cada uma vermelha nomeando o assert:** relé emitindo POST · relé sem
  `redirect: "manual"` · ramo sem verificar credencial · `verificarCredencial` ignorando a edge ·
  contrato aceitando corpo sem `ok`/`fonte` · barreira aceitando header extra · contador cego ·
  manifesto com entrada apagada · veredito adulterado · ramo removido · 2º `fetch` no relé.
- **A que ficou VERDE, e o que ensinou:** sabotar a drenagem do relógio virtual **não** reprova no
  teste de bundles reais — nenhum dos 5 agenda efeito assíncrono. Reprova no sintético. A cobertura
  é dividida de propósito: bundles reais cobrem as formas que a história tem, sintéticos cobrem as
  que ela ainda não tem. Sabotar **uma camada por vez** foi o que mostrou qual conjunto responde
  por qual forma.

## 7. Limites nomeados (não promessas)

- **A dependência remota não é reproduzível historicamente** (`esm.sh/@supabase/supabase-js@2` é
  especificador mutável; não há `deno.lock`). A prova é, na formulação do próprio revisor, *prova do
  código local do closure sob o contrato explícito das famílias remotas*: as 5 famílias medidas
  entram por stub que conta toda chamada, e família cuja **inicialização** faça IO não é admitida no
  catálogo. Especificador fora do catálogo = `INVERIFICAVEL` = edge fora.
- **Bundle que não descende da história da `main`** (fonte escrita à mão no Lovable) está fora do
  modelo.
- **`authorizeCron` compara com `===`**, não em tempo constante. É o padrão dos 93 crons e de
  `_shared/auth.ts`; trocar isso é entrega própria (fan-out para todas as edges).
- **Um ambiente só.** Se nascer um segundo, o `project_ref` esperado precisa virar vínculo mecânico
  antes do rollout — hoje o residual é uma atestação falsa **no banco alheio**, sem efeito em prod.

## 7.1 F2 e F3 — o disparo e a leitura (2026-09-06)

**F2 (banco, PR #2240, aplicada em prod e validada).** `deploy_sonda_alvos` espelha a allowlist do
repo com kill switch por edge; `deploy_sonda_disparos` grava `(request_id, tick_id, edge)` na MESMA
transação do `net.http_post`; `deploy_sonda_disparar()` posta na edge-relé e **nunca** na edge-alvo;
o cron roda `37 */2` (minuto livre entre os 94 jobs). Provado executando: 33 asserts em PG17, 5
falsificações vermelhas — entre elas a que troca a URL do relé pela da alvo, que é o cenário
catastrófico.

O achado que justificou o harness: **`ON CONFLICT (request_id)` é ambíguo** quando `request_id`
também é coluna de saída (`RETURNS TABLE`). O `CREATE` passa, a postcondição passa, e a função
quebra no PRIMEIRO tick — de madrugada. PL/pgSQL é late-bound; só a execução prova.

**F3 (leitura).** O silêncio da sonda vira sinal, e as três formas de ele mentir ficam fechadas:

1. **Atribuição por TEMPO** — a ligação é sempre pelo `request_id` do disparo. Uma resposta atrasada
   do tick anterior, ou uma sonda humana, tem outro id e não conta.
2. **Silêncio lido como aprovação** — cron parado, tabela ausente ou banco fora de sincronia com o
   repo são MECÂNICA (exit 2), não "nada pendente". A exceção deliberada: enquanto a migration não
   estiver aplicada, a seção sai como AVISO e o resto do relatório continua valendo — reprovar por
   uma entrega em voo bloquearia todas as sessões.
3. **Silêncio lido como incidente** — edge cujo ledger já diz DIVERGE não deveria mesmo atestar (o
   ramo não está no ar). Só `CONFERE` torna o silêncio suspeito, e é isso que faz `SONDA_CRON_SILENCIOSA`
   responder a pergunta que nenhum outro sinal responde: *o bundle que o ledger jura estar no ar
   continua lá?*

E o último caminho de efeito fechou: o `sonda:sql` **recusa** gerar o bloco legado (POST direto na
edge) para quem já tem o relé, oferecendo o one-liner `deploy_sonda_disparar(ARRAY[…])`. Só
`--permitir-efeito-legado` libera. Um aviso impresso não bastaria: quem cola o bloco às 2 da manhã
não lê o stderr.

## 7.2 O primeiro tick em PRODUÇÃO (2026-09-06, 22:37 UTC) — fail-closed, medido

O cron rodou pela primeira vez com a F2 aplicada e a `SONDA_HMAC_KEY` **ainda não provisionada**.
O que aconteceu é o desenho inteiro sendo exercido de verdade:

| o que | resultado |
|---|---|
| disparos do tick | 3 (um por edge ativa), com `request_id` 71237–71239 |
| resposta do relé | `500 {"ok":false,"classe":"sem-chave","env":"SONDA_HMAC_KEY"}` nas três |
| requisições emitidas às edges-alvo | **nenhuma** — o relé recusa antes do `fetch` |
| linhas no ledger / na janela viva | **0** — corpo de erro não tem `edge`/`versao` no topo, então não é atestação |
| veredito do CLI | 3 avisos de "1 de 1 tick sem resposta", exit 0 — a regra dos 2 ticks não deixa um tick só acusar |

Quatro propriedades provadas de uma vez, e nenhuma delas por leitura de código: **sem a chave nada
sai**; **o erro não vira atestação**; **a via única do ledger se manteve**; e **o CLI não confunde
um tick com um sinal**. A ordem de instalação que o handoff pedia (chave → deploy → migration) foi
invertida na prática, e o custo disso foi exatamente zero — que é o que "fail-closed" deveria
significar e quase nunca significa.

## 8. O que falta (fatias seguintes)

- **F4 (ondas)**: as demais edges, uma onda por vez, cada uma com `sonda:cron-prova` 100 % `PASSA`.
  `sync-reprocess` ficou fora desta fatia por **colisão** com o PR #2224, não por risco. O
  andamento, onda a onda, está no §11.

## 9. As três rodadas de challenge (o que cada uma derrubou)

| rodada | veredito | o que derrubou |
|---|---|---|
| 1 | `NÃO PASSA` | o desenho por header em POST: bundles históricos **sem gate** executam o fluxo real. Também: fixture escolhia predecessor seguro; atribuição temporal fabricava "cron atestou" |
| 2 | `NÃO PASSA` | o **rigor da prova**: `historicoDesde` furava o quantificador "qualquer closure"; `fetch` seguiria um 303 como `GET`; controle positivo não cobria todas as épocas de auth; enumeração perdia dependência removida; cache não identificava o harness; 3 falsificações eram do transporte antigo |
| 3 | **`PASSA`**, `[P1] Nenhum` | restaram P2/P3 incorporados: replay do POST operacional do relé, relógio virtual até quiescência, `--follow` por caminho, fallback legado bloqueado por padrão, vetor HMAC literal |

A spec com o rastro completo das três rodadas e a decisão de cada achado:
`docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md`.

## 10. O fechamento em produção (2026-09-07)

A chave `SONDA_HMAC_KEY` foi provisionada pelo founder e a fatia F3 (`deploy_sonda_resultados`)
aplicada. O mecanismo passou a se sustentar sozinho — e a virada tem hora marcada.

| tick (UTC) | disparos | atestados |
|---|---|---|
| 09-06 22:37 · 09-07 00:37 | 3 | **0** — relé recusa, sem chave |
| 09-07 01:07 em diante (6 ticks) | 3 | **3** |

### 10.1 O efeito real ficou em zero — medido, não presumido

A resposta `{"probe":true,…}` prova que o ramo de sonda atendeu, mas ela é a **própria** coisa sob
suspeita: um bundle que respondesse assim e ainda executasse o fluxo devolveria o mesmo corpo. A
testemunha independente é o contador de efeito. `calculate-scores` escreve em `priority_score_log`
a cada execução real; nas 30 h que cobrem 5 ticks sondados ele escreveu em **quatro** momentos:

```
09-07 06:00 · 06:25      09-06 06:00 · 06:25
```

Nenhum em `:37`, e o padrão de 09-06 — quando a sonda ainda era **recusada** por falta de chave —
é idêntico ao de 09-07, com ela atendendo. O dia anterior virou a linha de base: **ligar a sonda
não mudou nada** no comportamento real da edge. É o teste de rollback do harness se repetindo em
produção, com o contador em zero.

Limite honesto: `monthly-report` não escreve em tabela nenhuma (só chama o Resend), então **não
existe contador mensurável pelo psql-ro** para ela. O que a sustenta é a prova arquitetural — o
ramo retorna antes de qualquer IO, demonstrado executando os 84 closures históricos — mais a
analogia com o gêmeo mensurável. Quem quiser a medição direta precisa do painel do Resend.

### 10.2 A cicatriz que justifica a `deploy_sonda_resultados`

A semeadura colheu 24 linhas (8 ticks × 3 edges). Cruzando com o ledger:

| tick | motivo colhido | no ledger | veredito |
|---|---|---|---|
| 06:37 · 08:37 · 10:37 | `atestou` / 200 | 3 | atestou |
| 01:07 · 02:37 · 04:37 | **perdido** | 3 | atestou — a prova está no ledger |
| **22:37 · 00:37** | **perdido** | **0** | **não atestou, e o porquê sumiu** |

As duas últimas linhas são a falha que o mecanismo existia para não ter: sabe-se que não atestou,
não se sabe mais por quê. O `pg_net.ttl` apagou a resposta em 6 h e o ledger, por desenho, só
guarda sucesso. Elas ficam como cicatriz permanente — a tabela **preserva daqui para frente, não
ressuscita o passado**, e é exatamente por isso que ela precisava existir antes de fazer falta.

O par também mostra que as duas tabelas não se substituem: `(sem resposta)` no coletor **não** é
veredito de falha — três desses ticks atestaram. Quem julga silêncio precisa das duas.

### 10.3 Lição de método: predicado errado parece banco quebrado

No pré-voo, `pg_get_function_identity_arguments(p.oid) = 'text'` devolveu **0** para
`cron.unschedule` e simulou uma dependência ausente. O Postgres devolve `'job_name text'` — com o
nome do parâmetro. O banco estava certo; a **pergunta** estava errada. Vale a mesma regra de
`ausente ≠ zero`, um nível acima: antes de tratar zero como fato do mundo, confirme que o
predicado sabe produzir não-zero.

## 11. As ondas da allowlist (F4) — o que cada uma destravou

As migrations de TODAS as ondas citam esta seção no cabeçalho (`Contexto: … §11`), e até a onda 5
ela não existia: cinco arquivos imutáveis apontando para um endereço vazio. Como migration não se
edita, o conserto é escrever o destino. O detalhe de cada onda continua no cabeçalho da própria
migration — aqui fica o índice e o que só se aprendeu depois.

| onda | migration | edges que entraram | ativos | o que destravou |
|---|---|---|---|---|
| F1 | `20260906151204_deploy_sonda_cron_fail_closed` | `sonda-relay`, `monthly-report`, `calculate-scores` | 3 | o mecanismo (§1–§10) |
| 1 | `20260907101349_deploy_sonda_alvos_onda1` | `sync-reprocess`, `reposicao-depara-sayerlack-auto`, `carteira-positivacao-snapshot`, `process-recurring-orders` | 7 | `sync-reprocess` (44/44) ficou fora da F1 por colisão com o #2224, nunca por risco |
| 2 | `20260908070850_deploy_sonda_alvos_onda2` | `copilot-analyze`, `fin-valor-cockpit`, `recommend`, `generate-tactical-plan` | 11 | o controle positivo precisa de corpo REAL: com `{}`, o 400 de transcrição curta deixava o de `copilot-analyze` inerte (15/15 com transcript real); e 35/36 não é "quase seguro" — o closure que falta executaria efeito |
| 3 | `20260908204421_deploy_sonda_alvos_onda3` | `omie-vendas-sync`, `omie-analytics-sync`, `generate-bundle-argument` | 14 | a correção: as sete candidatas somavam zero closures `FALHA` — todo não-PASSA era `INVERIFICAVEL`, controle que não subia; com corpos medidos por escada, 127/188 → 189/189 · 16/86 → 86/86 · 12/14 → 14/14 |
| 4 | `20260908223555_deploy_sonda_alvos_onda4` | `omie-sync-nfes-recebidas` | 15 | classe `NAO_COMPILA`: o 36º closure de 35/36 (`b880daeb1`) não parseia, logo nunca bootou nem serviu tráfego |
| 5 | `20260909222423_deploy_sonda_alvos_onda5` | `omie-desconto-backfill` | 16 | a 1ª edge que ESCREVE — §11.1 a §11.5 |

### 11.1 Onda 5 — a prova por execução aprovou o que o gate textual reprovou

`omie-desconto-backfill` reescreve `order_items.desconto_valor` (o `EFEITO` do `versao.ts` diz isso
em voz alta), então um OPTIONS que caísse no fluxo normal seria um backfill não pedido a cada 2 h.
Ela entrou pelo custo de ficar fora: sem alvo de cron, cada PR que a tocava gerava sonda à mão —
duas no mesmo dia 2026-09-09 (#2447 e #2451), porque o #2448 mudou o `index.ts` horas depois da 1ª.

A execução dos closures deu **2/2 PASSA** na primeira rodada. Quem reprovou foi o `gateG1`, que é
textual: `G1 ❌ omie-desconto-backfill: bloco OPTIONS não encontrado`. A guarda `atenderSondaOptions` morava ANTES do bloco
`if (req.method === "OPTIONS")` — funcionalmente certa, numa forma que o regex não lê. A onda moveu a
guarda para dentro (#2461): a resposta de todo método fica idêntica, porque o helper abre com
`if (req.method !== METODO_SONDA) return null`; o que muda é um ponto de suspensão a menos antes do
gate de auth; e o corpo `"ok"` do preflight fica byte a byte.

O challenge Codex discordou da ROTA — preferia estender o G1 a reconhecer a forma antiga a pagar um
deploy da edge. A onda seguiu o precedente (a onda 4 também deu o bloco à edge na mesma fatia)
porque ampliar um gate textual para uma segunda forma aumenta a superfície de aprovação por leitura.
Duas correções do parecer entraram no código: "provadamente neutra" exagerava (havia a suspensão),
e a parte (b) da prova compara o preflight do MESMO closure, não uma resposta anterior à mudança.
O parecer também mediu que o G1 **não** verifica que o bloco precede todo efeito — um `await fetch`
injetado antes do bloco canônico segue aprovado. Quem prova a propriedade é a execução; o G1 prova
só a forma.

### 11.2 O relé é o deploy que a onda inteira espera — e a ferramenta o chamou de adiável

O relé faz default-deny em runtime com a allowlist COMPILADA (`sonda-relay/index.ts`:
`!ALLOWLIST.has(alvo)` → `400 fora-da-allowlist`). Depois do merge e do INSERT, o relé em produção,
ainda com a lista anterior, recusa a edge nova em todo tick — até ser redeployado. Mas o
`pendencias:deploy`, logo após o apply, classificou (recorte das duas classes):

```
🔴 P1 — DEPLOY PENDENTE declarado (versao bumpou): deploy no PR — 1
   omie-desconto-backfill              prod v1.1-unicidade-no-universo-completo → main v1.2-preflight-na-forma-que-a-prova-mede
🟡 P2 — DEPLOY PENDENTE não declarado (closure mudou sem bump): política = leva agrupada, escala após 7 d — 1
   sonda-relay                         v1.1-alvos-da-onda-1 · fonte 0c4d1f67e4… → 6ca17c394a…
```

O deploy do qual a onda depende saiu como "pode esperar 7 dias": o `pendencias:deploy` escolhe a
fila pelo `VERSAO`, e o do relé estava congelado em `v1.1-alvos-da-onda-1` desde a onda 1, porque o
`sonda:bump` não via a allowlist — ela mora em `_shared/`. O diagnóstico e o conserto, mergeado
durante a espera do 1º tick (#2470), estão em `docs/historico/sonda-marcador-congelado.md`, seção
"O congelamento que o gate não via": o gate passou a tratar a allowlist como fatia do relé,
projetada no conjunto de slugs. A próxima onda que mudar os alvos fica obrigada a bumpar o relé, e o
deploy dele sai P1. Limite honesto: até 10-08 nenhuma onda nova mudou os alvos — o marcador do relé
segue em `v1.1-alvos-da-onda-1` —, então essa cobrança não foi exercitada por uma onda real ainda.

### 11.3 O primeiro tick que perguntou — medido no ledger

A transição ainda produziu sonda à mão: entre o INSERT e o 1º tick agendado, alguém deployou as duas
edges e sondou a do backfill duas vezes (23:06:35 em v1.1, 23:12:25 em v1.2 — ambas **sem disparo**,
isto é, manuais) e disparou um tick avulso só para o relé (23:14:15, 1 disparo). Nenhum desses é o
cron perguntando a edge nova.

O primeiro tick AGENDADO com os 16 alvos — 09-11 00:37:00Z, tick `d1ebf474…` — perguntou a edge, e
ela respondeu. Disparo e atestação com o MESMO `request_id`:

| edge | `request_id` | versão atestada | `fonte` | observado | registrado |
|---|---|---|---|---|---|
| `omie-desconto-backfill` | 75774 | `v1.2-preflight-na-forma-que-a-prova-mede` | `558681b43bac` | 00:37:00 | 00:45:00 |
| `sonda-relay` | 75780 | `v1.1-alvos-da-onda-1` | `6ca17c394ae9` | 00:37:00 | 00:45:00 |

O tick fechou com 16 disparos e 16 atestações, uma por edge. A `fonte` é a do closure do #2461 (o
bloco OPTIONS na forma canônica), e o relé que aceitou a alvo é o que serve a lista da onda 5. Das
três atestações da edge desde 23:00, só essa tem disparo; as outras duas são as manuais da transição.
Os 8 min entre observar e registrar não são da edge: foram exatamente 8:00 em todos os 45 disparos
dos três ticks anteriores. Quem espera a linha precisa de graça maior que isso — um monitor que
julgasse o silêncio às 00:44 teria fabricado "disparou e não respondeu".

E a onda já segurou o primeiro PR seguinte. O #2467, de outra sessão, mudou o `index.ts` da edge e
mergeou às 00:40:53Z sem tocar o manifesto — e o `sonda:cron-prova -- --gate` do CI dele imprimiu
`omie-desconto-backfill: 5/5 closures PASSA ✅`, porque o `--gate` re-executa também os closures que
o manifesto ainda não tem. A prova não é uma foto da onda: é refeita em todo PR que toca uma edge da
allowlist. O que se esperava do deploy desse `v1.3` era zero sonda à mão; isso deixou de ser
expectativa e está medido no §11.4.

**O efeito, pela testemunha independente** — o análogo do §10.1, porque a resposta da sonda é a
própria coisa sob suspeita. `order_items` não tem hora de atualização; o único contador legível pelo
`psql-ro` é o cumulativo `pg_stat_user_tables.n_tup_upd`, amostrado a cada 20 s em torno do tick:

| amostra (UTC) | `n_tup_upd(order_items)` |
|---|---|
| 23:32:52 (linha de base) | 90566 |
| 00:16:47 | 90604 — um escritor legítimo, +38 |
| 00:36:24 (antes do tick) | 90604 |
| 00:40:11 (3 min depois) | **90604** |

Zero UPDATE na janela do tick, em 181 amostras sem nenhuma falha de leitura. O +38 das 00:16 mostra
que o contador anda quando alguém escreve — o zero não é um sensor surdo. Limite honesto: o
contador não enxerga quota do Omie, que o fluxo normal consumiria ANTES de escrever; nesse eixo
quem sustenta é a prova por execução do §11.1.

Uma armadilha de leitura no meio do caminho: com 16 alvos ativos e `30/30 disparo(s) atestado(s)`
— 15 edges × 2 ticks, porque a recém-inserida nunca tinha sido perguntada —, o resumo do
`pendencias:deploy` dizia `✅ toda edge ativa foi atestada nos ticks recentes — o bundle do ledger
continua no ar`, com a edge nova em **zero** disparos. O juiz (`scripts/lib/sonda-cron-testemunha.ts`) está certo em não acusar edge que
ninguém perguntou ("ausência de PERGUNTA, não silêncio"); é o RESUMO que generaliza para uma verdade
vazia. Enquanto ele não for corrigido, a prova de uma onda é a linha do ledger — disparo e atestação
com o MESMO `request_id` —, nunca o ✅ agregado. Depois do tick das 00:37, com a edge perguntada, a
mesma frase passou a ter lastro: `16 edge(s) ativa(s), 2 tick(s) recente(s), 17/17 disparo(s)
atestado(s)`.

### 11.4 Vinte e sete dias depois — três deploys da edge, zero sonda à mão (medido)

O §11.3 fechou com uma expectativa, e esta seção é a query. Entre 09-11 00:50Z e 10-08 10:25Z, as
atestações de `omie-desconto-backfill` cruzadas com `deploy_sonda_disparos` pelo `request_id`:

| versão servida | atestações | com disparo de cron | janela (UTC) |
|---|---|---|---|
| `v1.3-sensor-do-valor-plano-por-id-escrita-na-janela` | 43 | **43** | 09-11 02:37 → 09-14 14:37 |
| `v1.4-recusas-da-escrita-por-motivo` | 5 | **5** | 09-14 16:37 → 09-15 00:37 |
| `v1.5-portao-plano-aprovado-e-corpo-estrito` | 280 | **280** | 09-15 02:37 → 10-08 08:37 |

328 atestações, 328 com disparo, **nenhuma manual** — numa edge que trocou de versão três vezes no
período. O `v1.3` foi atestado no primeiro tick agendado depois do deploy (09-11 02:37). É o que a
onda existia para comprar: antes dela, cada PR que tocava o `index.ts` custava uma sonda à mão, e o
dia 2026-09-09 custou duas.

E o zero é medido, não ausência de dado. A `deploy_atestacoes` cobre 09-05 16:00 a 10-08 10:25 sem
poda (15.653 linhas), e uma sonda manual bem-sucedida grava atestação SEM disparo: é justamente a
linha que não existe. Se a `deploy_sonda_disparos` fosse podada, o erro cairia para o lado contrário
— atestação de cron pareceria manual —, e não é o que se vê.

### 11.5 O que uma onda É (checklist medido na onda 5)

1. Entrada em `SONDA_CRON_ALVOS` com controles que SOBEM o contador naquela história.
2. `bun run sonda:cron-prova --backfill <edge>` grava o manifesto; `--gate` com `EXIT=0` — e ele
   inclui o G1, que exige a guarda DENTRO do bloco OPTIONS.
3. Se o `index.ts` mudou: `sonda:bump` e `sonda:fingerprint -- --write`. Mudar o conjunto de alvos
   também muda o relé: desde o #2470 o `sonda:bump` cobra o bump de `sonda-relay/versao.ts`.
4. Migration envelopada (DR) + `db/aplicar-sonda-alvos-ondaN.sql` sem envelope, com postcondição
   no TOTAL de ativos; `db:aplicar --ensaio`, `db:aplicar`, e a 2ª testemunha por `psql-ro`. Aplique
   com o HEAD na `main` — o ledger grava `git rev-parse HEAD`, e o commit do branch morre no squash.
5. Deploy do **relé junto com a onda** — sem ele a edge nova toma `fora-da-allowlist`. Com o bump
   cobrado ele sai P1; até a onda 5 saía P2, "leva agrupada" (§11.2). E da edge, se o `index.ts`
   mudou.
6. A prova é o 1º tick AGENDADO que inclui a edge: disparo + atestação com o mesmo `request_id` no
   ledger, registrada ~8 min depois do tick (§11.3). Sonda manual depois do deploy é exatamente o que
   a onda existe para aposentar — e o §11.4 mede o que ela aposentou.

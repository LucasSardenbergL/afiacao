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

## 8. O que falta (fatias seguintes)

- **F4 (ondas)**: as demais edges, uma onda por vez, cada uma com `sonda:cron-prova` 100 % `PASSA`.
  `sync-reprocess` ficou fora desta fatia por **colisão** com o PR #2224, não por risco.

## 9. As três rodadas de challenge (o que cada uma derrubou)

| rodada | veredito | o que derrubou |
|---|---|---|
| 1 | `NÃO PASSA` | o desenho por header em POST: bundles históricos **sem gate** executam o fluxo real. Também: fixture escolhia predecessor seguro; atribuição temporal fabricava "cron atestou" |
| 2 | `NÃO PASSA` | o **rigor da prova**: `historicoDesde` furava o quantificador "qualquer closure"; `fetch` seguiria um 303 como `GET`; controle positivo não cobria todas as épocas de auth; enumeração perdia dependência removida; cache não identificava o harness; 3 falsificações eram do transporte antigo |
| 3 | **`PASSA`**, `[P1] Nenhum` | restaram P2/P3 incorporados: replay do POST operacional do relé, relógio virtual até quiescência, `--follow` por caminho, fallback legado bloqueado por padrão, vetor HMAC literal |

A spec com o rastro completo das três rodadas e a decisão de cada achado:
`docs/superpowers/specs/2026-09-05-sonda-por-cron-fail-closed-design.md`.

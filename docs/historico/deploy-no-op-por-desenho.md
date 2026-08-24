# Deploy no-op por DESENHO — a mudança que nenhuma canária consegue provar

> **A classe (2026-08-23):** um PR cujo ganho é *proteção contra mudança futura* não altera
> comportamento nenhum hoje — por desenho, não por acaso. Bundle novo e bundle velho produzem
> **bytes idênticos** sobre os dados de produção. Logo **nenhuma canária de comportamento pode
> discriminar o deploy**, e a verificação inteira do ritual (`lovable-deploy-verify`, N3) fica sem
> chão. Sobra o **marcador de versão** — e ele só prova alguma coisa se for **bumpado ANTES** do
> deploy. Se o marcador na `main` for igual ao de produção, a sonda responde a mesma string tendo
> o deploy acontecido ou não: verificação que **mente verde**.
>
> A regra: **mudança no-op por desenho prova-se só por marcador, e o bump é PRÉ-REQUISITO do
> deploy, não consequência dele.** Antes de pedir o deploy, compare o marcador da `main` com o de
> produção — iguais, a viagem é inverificável.

## O caso

O **#1889** mudou `supabase/functions/_shared/paginate.ts`: `fetchAll`/`fetchAllKeyset` deixaram de
tratar página **CURTA** como fim de tabela (o EOF passou a ser página **VAZIA**) e o offset passou
a avançar pelas linhas **REAIS** devolvidas (`from += rows.length`, não `from += PAGE`). Isso
desacopla os helpers do `max-rows` do PostgREST.

O ganho é real, mas **futuro**: o `max-rows` de prod é 1000, exatamente igual ao `PAGE` do helper.
O laço antigo funcionava — por **coincidência numérica** que nada vigiava. Se o cap baixasse para
500, a 1ª página viria com 500 linhas, `500 < 1000` seria lido como "acabou", e toda leitura
truncaria em silêncio.

Pedido: deployar nas 3 edges money-path que leem tabelas grandes (`recommend`,
`omie-analytics-sync`, `fin-cashflow-engine`), **com verificação** — porque no dia anterior um
deploy da `recommend` foi reportado como feito e **não tinha subido**.

## O diagnóstico, que veio ANTES do deploy

Ao montar a verificação, o problema apareceu antes de qualquer prompt ser entregue: **nenhuma das
três tinha como provar o próprio deploy.**

| edge | marcador na `main` | em produção | discrimina? |
|---|---|---|---|
| `recommend` | `v1.4-sonda-antes-do-gate` | `v1.4-sonda-antes-do-gate` | ❌ mesma string dos dois lados |
| `fin-cashflow-engine` | `v1.0-sensor-inicial` | idem | ❌ |
| `omie-analytics-sync` | *sem `versao.ts`* | — | ❌ sem prova nenhuma |

A `omie-analytics-sync` era o caso mais sutil: ela **tinha** canária (`doc_ambiguo_probe`), mas
**NÃO-VERSIONADA**. Ela responde `probe_no_ar:true` igual num bundle de hoje e num de três fatias
atrás — é literalmente a ⚠️ #2 de `docs/agent/deploy.md` ("deploy integralmente velho carrega o
`expected` VELHO junto e compara velho×velho → responde `ok:true` e mente verde"), que já
classificava versionar essas canárias como **dívida aberta**.

## Por que este caso NÃO é o `#1397` (a armadilha irmã, e a diferença que importa)

O `deploy.md` já avisava: *"canária que não discrimina é teatro verde"*. Mas o caso de lá é
**no-op por acaso dos dados** — o #1397 mudou o tratamento de conflitos e prod tinha **zero
conflitos**, então a resposta do fluxo real saía byte-idêntica. A correção de lá é **achar uma
fixture que exercite o comportamento que mudou**.

Aqui isso **não existe**. O #1889 foi feito para não mudar comportamento nenhum enquanto o cap for
1000. Procurar fixture melhor é procurar o que o PR garante não haver. A conclusão operacional é
outra, e é o que este documento acrescenta:

- no-op **por acaso dos dados** → conserta-se com **fixture melhor** (canária de comportamento);
- no-op **por desenho** → só o **marcador** prova, e ele tem de ser **bumpado antes**.

Corolário incômodo: a mesma propriedade que torna o #1889 seguro de deployar (não muda nada hoje)
é a que o torna **impossível de verificar** pelos meios normais. Segurança e verificabilidade
apontam para lados opostos aqui.

## O que foi feito (#1905)

1. **`fin-cashflow-engine`**: bump `v1.0-sensor-inicial` → `v1.1-paginacao-eof-vazio`.
2. **`omie-analytics-sync`**: sonda instalada (`versao.ts` no padrão `_shared/sonda-versao.ts`),
   após o `authorizeCronOrStaff` (que já aceita `x-cron-secret`, logo sem gate próprio) e **antes
   do `createClient`**, como o gate estrutural da terceira leva exige.
3. **`recommend`**: resolvida **de graça** — o #1898, de outra sessão, bumpou para
   `v1.5-denominador-observados` e já carregava o #1889. Esperar 20 minutos por ele economizou um
   deploy manual e transformou a viagem em prova.

Registradas em `_shared/sonda-versao-contrato_test.ts` (`EDGES` + `ESCRITA_NOSSO_BANCO`).

### A propriedade que tornou a sonda da `omie-analytics-sync` barata

A edge roteia por `action`, então um corpo sem `action` conhecida cai no `default` com
`400 "Ação desconhecida"` — **sem tocar Omie nem banco**. Sondar um bundle pré-sensor ali é
inócuo, e o veredito fica binário:

```
{ok,probe:true,versao}   → bundle COM sensor
400 "Ação desconhecida"  → bundle PRÉ-sensor, o deploy não subiu
```

Contraste com a `fin-cashflow-engine`, onde mesmo o caminho read-only paga a projeção de 13
semanas inteira antes de responder. **Ao instrumentar, verifique qual é o custo do bundle VELHO
ignorando o parâmetro** — é ele que define se sondar às cegas é seguro.

## A falsificação (verde sozinho não provava cobertura da edge NOVA)

O gate de contrato passou em 23/23 assim que a edge foi registrada — e isso não valia nada: ele
já passava antes, pelas 17 edges antigas. Três sabotagens, cada uma exigindo vermelho **que nomeia
a edge**:

| sabotagem | exit | vermelho |
|---|---|---|
| apagar a linha que RESPONDE a sonda | 1 | `omie-analytics-sync: classifica a sonda mas nunca chama respostaSonda` |
| mover a sonda para depois do `createClient` | 1 | `omie-analytics-sync: a sonda desceu para depois do createClient` |
| quebrar o formato do marcador bumpado | 1 | `fin-cashflow-engine: VERSAO fora do formato` |

## O desfecho (evidência positiva, lida no banco)

As três sondas, lidas em `net._http_response` via `psql-ro` — **não** pelo relato "deployei":

| id | edge | versão respondida |
|---|---|---|
| 58577 | `recommend` | `v1.5-denominador-observados` |
| 58580 | `omie-analytics-sync` | `v1.0-sensor-inicial` |
| 58586 | `fin-cashflow-engine` | `v1.1-paginacao-eof-vazio` |

A terceira é a prova mais limpa: `v1.1-paginacao-eof-vazio` **não existia em lugar nenhum** até o
#1905 daquela manhã. Nenhum bundle anterior pode responder essa string.

Guard pós-deploy: `paginate.ts` intacto na `main` com #1889 e #1901, e nenhum commit de reversão
do bot do Lovable.

## Lições

1. **Mudança no-op por desenho prova-se só por marcador — e o bump é pré-requisito do deploy.**
   Comparar o marcador da `main` com o de prod é parte do **pré-flight**, não da verificação.
2. **Canária não-versionada é meia-canária.** Ela prova que a função responde, não que o bundle é
   o novo. Enquanto houver `contrato = —` na tabela do `deploy.md`, a dívida está aberta.
   → **Fechada em 2026-08-23**: as 3 últimas sem marcador foram versionadas — `analyze-unified-order`
   (`praticado-vence-omie-v1`), `omie-vendas-sync` (`identidade-fail-closed-v1`) e
   `omie-analytics-sync` (`doc-ambiguo-fail-closed-v1`), cada uma com o controle de calibração que
   prova a fixture ficando VERMELHA sob a forma antiga. Duas descobertas do caminho, que valem para a
   próxima canária: (a) as duas `omie-*` respondiam `probe_no_ar`, **não** `canary`, e a
   `omie-analytics-sync` embrulha a resposta em `data` — a receita SQL documentada lia **NULL** nas
   duas, e NULL se lê como "não tem canária" (ausência de dado virando veredito); (b) emitir o
   marcador não basta — o **consumidor** tem de exigir o VALOR, senão o card de Governança segue
   pintando verde com `ok` sozinho, que é o furo original visto do outro lado.
3. **PR concorrente pode ser aliado.** O #1898 (`recommend`) e o #1901 (bug ATIVO de duplicata
   silenciosa no mesmo `paginate.ts`) estavam com auto-merge armado. Deployar antes deles teria
   custado 3 viagens manuais desperdiçadas e publicado um helper com bug conhecido. **Antes de
   pedir deploy de edge, cheque `gh pr list` pelo arquivo — não pelo título.**
4. **Ao instrumentar, meça o custo do bundle VELHO ignorando o parâmetro.** É ele que decide se
   sondar às cegas é inócuo (`400` da `omie-analytics-sync`) ou caro (a projeção de 13 semanas).

## 8ª leva (mesmo dia) — as 7 INVERIFICÁVEIS e as 3 presas no marcador antigo

O #1905 fechou 3 edges. Sobrava o resto do conjunto: das **19** que servem o
`_shared/paginate.ts`, 8 já carregavam #1889 + #1901 em produção, mas **7 não tinham sensor
nenhum** — nem sonda, nem canária — e **3 tinham marcador que não discriminava** (a mesma string
na `main` e em prod). O estado das 7 é pior que o das 3: ali não havia nem uma resposta errada
para corrigir, havia **nenhuma resposta possível** para "qual bundle está no ar?".

### O custo do bundle VELHO ignorando `probe` — medido ANTES de instrumentar

É a lição 4 do #1905 aplicada como pré-requisito, não como observação. O bundle pré-sensor
**ignora o parâmetro e roda o fluxo real** (armadilha 1 de `deploy.md` §Canárias), então o que
decide se sondar às cegas é seguro é o que a edge faz com um corpo que ela não entende:

| edge | gate | bundle VELHO com `{"probe":true}` do SQL Editor | sondar às cegas |
|---|---|---|---|
| `sync-reprocess` | `authorizeCron` | roteia por `action`; sem action conhecida cai no `default` **400 "Ação desconhecida"** após 1 leitura de config | **barato** |
| `ai-ops-agent` | JWT staff + `user_roles` | **401 "Unauthorized"** antes de tocar banco ou modelo — o SQL Editor não manda `Bearer` | **inócuo** |
| `calculate-scores` | `authorizeCronOrStaff` | não lê o corpo → toma o lease de 15 min e aplica `apply_score_updates` | **caro** |
| `omie-sync-status-produtos` | `authorizeCronOrStaff` | lê só `empresa`; `resolverEmpresas(null)`=OBEN → pagina o Omie inteiro e reescreve `sku_status_omie` | **caro** |
| `scoring-recalc-batch` | `authorizeCronOrStaff` | não lê o corpo → fan-out para `scoring-recalc-client` (drain 500 + decay) | **caro, e fora desta edge** |
| `visit-score-recalc-batch` | `authorizeCronOrStaff` | idem, para `visit-score-recalc-client` | **caro, e fora desta edge** |
| `tactical-plans-batch` | `authorizeCron` | não lê o corpo → dispara `generate-tactical-plan` por cliente elegível, **1 chamada de LLM cada** | **caro** |

Duas coisas que a tabela ensina e que uma leitura por amostragem não daria:

1. **O gate mais restritivo é o que torna a sonda mais barata.** A `ai-ops-agent` é a única
   INÓCUA justamente porque o gate dela é o mais fechado (JWT de usuário staff) — o mesmo fato
   que a obrigou a ter gate PRÓPRIO para a sonda ser alcançável pelo SQL Editor. Segurança e
   custo-de-sonda apontam para o mesmo lado aqui, ao contrário de segurança e verificabilidade
   na tese deste documento.
2. **"Caro" não é uma escala só.** Nos três batches o efeito **não acontece nesta edge** — ele cai
   na edge de baixo. Um disparo acidental deixa rastro onde ninguém vai procurar, o que é pior
   para diagnosticar do que um efeito local do mesmo tamanho. Por isso eles têm lista própria no
   gate de contrato (`FAN_OUT_QUE_ESCREVE`) em vez de uma linha a mais em `ESCRITA_NOSSO_BANCO`.

### Gates de auth: 3 formatos, e nenhum era o "padrão"

`deploy.md` já mandava conferir **qual** gate a edge tem antes de copiar o padrão (o #1767 achou
dois formatos que o original não previa). Aqui apareceram três: `authorizeCronOrStaff` (4 edges),
`authorizeCron` (2) e **JWT de usuário staff com `user_roles`** (`ai-ops-agent`). Só o terceiro
exigiu gate próprio — os dois primeiros aceitam `x-cron-secret` por comparação de env pura, que é
como o founder invoca, então a sonda pôde vir **depois** do gate e continuar IO-free.

### Duas armadilhas de forma que só apareceram ao instrumentar

- **O corpo de um `Request` só se lê UMA vez.** A sonda obriga o parse a subir para antes do
  client; onde já havia uma leitura depois, ela teve de passar a reusar a variável. Na
  `omie-sync-status-produtos`, uma segunda leitura faria o `empresa` do corpo ser silenciosamente
  ignorado — o run mudaria de escopo **sem erro nenhum**. Gate novo: `sétima leva: o corpo do
  Request é lido UMA vez só`.
- **Subir o parse pode trocar a mensagem de erro.** Na `sync-reprocess` o parse era
  `await req.json()` PELADO: corpo quebrado virava 500. Trocá-lo por `.catch(() => ({}))` faria um
  JSON inválido responder `400 "Ação desconhecida"` — mandando o chamador consertar a coisa errada.
  O erro é guardado e **relançado no ponto antigo**; gate novo o exige.
- **A âncora do gate estrutural nem sempre é `createClient(`.** A `omie-sync-status-produtos` cria
  o client por `makeClient()`, uma fábrica de topo de arquivo — o gate de posição não achava a
  âncora e caía em "controle positivo vazio". Resolvido com um mapa declarado (`ANCORA_CLIENT`),
  não afrouxando o gate: renomear a fábrica sem atualizar o mapa deixa o CI **vermelho**.

### O gate que fecha a CLASSE, não os 7 casos

`nenhuma edge que serve o paginate.ts fica SEM prova de deploy` varre `supabase/functions/*` e
exige, de toda edge que importe `_shared/paginate.ts`, ou registro em `EDGES` (sonda) ou uma
entrada em `VERIFICAVEL_POR_CANARIA` **cujo contrato a edge ainda emita** (hoje só a
`omie-vendas-sync`, com `identidade-fail-closed-v1`). O problema desta fatia não foi "faltou sonda
em 7 edges" — foi que a falta só aparecia na hora de verificar um deploy, quando já era tarde,
porque o marcador precisa existir ANTES. Mede o import LITERAL e está declarado como piso: uma
dependência que chegue só por um terceiro módulo escapa, e fechar isso exigiria um resolvedor de
módulos, não um regex.

### A falsificação — 50 sabotagens, cada uma exigindo vermelho que NOMEIE o alvo

O gate passou 27/27 assim que as 7 foram registradas, e isso não valia nada: ele já passava pelas
23 edges anteriores. Cada asserção foi sabotada e teve de ficar vermelha **citando a edge**
(arnês que sabota → roda → restaura com `git checkout --`; por isso o commit veio antes):

| sabotagem | alvos | vermelho exigido |
|---|---|---|
| apagar a linha que RESPONDE a sonda | as 7 | `<edge>: classifica a sonda mas nunca chama respostaSonda` |
| mover a sonda para depois do client | as 7 | `<edge>: a sonda desceu para depois do createClient(`/`makeClient(` |
| voltar o `body.probe === true` cru | as 7 | `<edge>: voltou o body.probe === true cru` |
| quebrar o formato do marcador | as 7 | `<edge>: VERSAO fora do formato vN.N-slug` |
| trocar a identidade na resposta | as 7 | `<edge>: a sonda se identifica como "edge-errada"` |
| ler `req.json()` duas vezes | as 7 | `<edge>: o handler lê req.json() 2×` |
| **regredir o bump** | as 3 | `<edge>: marcador REGREDIU para <valor antigo>` |
| engolir o erro de parse | `sync-reprocess` | `o erro de parse não é relançado` |
| tirar a edge de `EDGES` | `calculate-scores` | `sem prova de deploy: calculate-scores` |
| exceção de canária caducada | `omie-vendas-sync` | `não emite mais 'contrato-que-nao-existe-v9'` |
| tirar o gate próprio da sonda | `ai-ops-agent` | `a sonda responde sem gate próprio` |
| apagar a âncora declarada | `omie-sync-status-produtos` | `âncoras não encontradas (procurei createClient()` |

**50/50 vermelhas.** A que mais importa é a 7ª: `git revert` do bump devolveria a sonda a
"responde verde sem provar nada" — o pior estado possível, porque **parece** verificado.

### O que falta (e é do founder)

O bump é pré-requisito **cumprido**; o deploy, não. As 10 edges precisam subir pelo chat do
Lovable, e só então a sonda vira prova. Ler pelo `request_id` em `net._http_response` — nunca
`ORDER BY id DESC LIMIT 1`, que já fabricou veredito negativo neste banco (§Canárias do
`deploy.md`). Marcador esperado: `v1.0-sensor-inicial` nas 7 novas (nenhum bundle anterior
responde `versao`) e `v1.1-paginacao-eof-e-cursor` nas 3 bumpadas — string que **não existia em
lugar nenhum** antes desta fatia.

## 9ª leva (mesmo dia) — a que a ENUMERAÇÃO não via, e a que já estava pronta há meses

Depois que a 8ª leva fechou 10 das 12 dependentes do `paginate.ts`, sobraram duas. Elas não são
uma leva por tamanho, e sim porque falham num ponto **diferente** do que a 8ª tratou: aquelas eram
edges sem sensor; estas são uma edge fora da **lista** e uma edge com sensor pronto e nunca
deployado. Chamar as duas de "as que faltavam" esconderia que o motivo de faltarem não é o mesmo.

### `monthly-report` — o problema era a lista, não o sensor

Ela não cita `_shared/paginate.ts` em lugar nenhum: chega ao helper por um salto, via
`_shared/relatorio-mensal.ts`, que importa `fetchAll`. É o Erro 1 de
`enumerar-consumidores-de-helper.md` acontecendo em produção — a relação é de **grafo**, o `grep`
é local. Nenhuma quantidade de rigor na instrumentação teria ajudado, porque ela nunca entrava na
fila de coisas a instrumentar.

### O custo do bundle VELHO — medido, e desta vez ele não era um número errado

O passo obrigatório (§8ª leva) deu o resultado mais caro da série. Três defaults, cada um razoável
sozinho, conspiram para armar o envio **por omissão**:

```
targetUserId = body.user_id               -> undefined => TODA a base (5.276 perfis)
sendEmail    = body.send_email !== false  -> TRUE      => envio ARMADO por omissão
previewOnly  = body.preview_only === true -> false     => nada segura
```

Um `{"probe":true}` contra o bundle pré-sonda não erra um cálculo: dispara o relatório mensal por
e-mail para a base inteira, fora de época, por `fetch` real na Resend. E-mail entregue não se
recalcula. Nas outras edges "deploy primeiro, sonda depois" é higiene; aqui é **contenção**.

Detalhe de forma que o padrão não cobria: o fluxo real já lia o corpo, e `req.json()` consome o
stream **uma vez**. A sonda lê antes (como o gate de posição exige) e o fluxo real reusa a
variável — reler devolveria `body already consumed` e quebraria o **cron**, não a sonda.

### `omie-vendas-sync` — o sensor existia desde abril; faltava o deploy

Zero linha de código. Ela já tinha canária **versionada** (`identidade-fail-closed-v1`, criada em
`d8cf07152`) e nunca fora deployada. O que torna isso prova e não torcida é a ancestralidade:
`git merge-base --is-ancestor b559e8bdd d8cf07152` responde SIM, então um bundle capaz de
responder aquele contrato **necessariamente** carrega o #1889. Custou uma conferência de grafo de
commits e substituiu uma instrumentação inteira — vale procurar o sensor que já existe antes de
escrever o próximo.

### O desfecho (evidência positiva, lida por `request_id`)

| edge | `request_id` | corpo | status |
|---|---|---|---|
| `monthly-report` | 59281 | `versao=v1.0-sensor-inicial`, `edge=monthly-report`, `probe=true`, `ok=true` | 200 |
| `omie-vendas-sync` | 59286 | `contrato=identidade-fail-closed-v1`, `canary=true`, `probe_no_ar=true`, `ok=true` | 200 |

Gates do PR #1946, com exit colado: `test:edges` 0 (**883 passed | 0 failed**, 27 casos do
contrato) · `edges:typecheck` 0 · `bun lint` 0 (75 problems, **0 errors**) · `vitest` 0 (729
files | 6973 tests). Falsificação refeita **depois** do rebase — o gate ganhou 7 edges e duas
listas com o #1937, então a rodada anterior já não falava do código final: controle 27/27, três
sabotagens em exit 1, cada vermelho **nomeando** `monthly-report`.

### A lição nova: o `request_id` copiado à mão fabricou "verificado"

Dos quatro ids reportados para leitura, **três apontavam para crons**: 59102
(`{"success":true,"data":{"updated":2477}}`), 59103 (`{"modo":"watchdog",...}` — o tick do #1915
em pessoa) e 59283 (`{"success":true,"imported":0,"skipped":3}`). As sondas reais eram 59281 e
59286, achadas buscando o **conteúdo**, não o id.

O erro só foi detectável porque a resposta da sonda carrega `edge`/`versao`/`contrato` no corpo.
Uma sonda que respondesse só `{"ok":true}` teria sido confundida com um cron — e o deploy, dado
como provado sem prova. Isto é a irmã do #1915: lá o `ORDER BY id DESC LIMIT 1` pegava o watchdog
e fabricava veredito **negativo**; aqui o id colado à mão pega o watchdog e fabrica veredito
**positivo**, que é pior, porque ninguém investiga um verde. O campo de identidade no corpo da
sonda não é enfeite — é o que separa "li a resposta certa" de "li alguma resposta".

Consequência prática: o bloco canônico de `deploy.md` precisa capturar o id na **mesma** execução
do `http_post`, em vez de pedir que ele seja copiado entre abas.

### Rodapé — um vermelho que era da máquina, e a primeira explicação estava ERRADA

A rodada inicial do `vitest` acusou 4 falhas. Nenhuma era asserção: `Test timed out in 20000ms`
nos gates que varrem o repo inteiro. A primeira hipótese foi a óbvia — eu rodara os outros três
gates **em paralelo** numa M2 de 8GB, com só o `vitest` sob o `heavy`, que protege quem o invoca e
não sabe do vizinho. Ela estava incompleta: ao repetir tudo **em série**, o `vitest` estourou de
novo, em outro arquivo (`paginacao-artesanal-gate`), e a mesma suíte que levara 193s levou 537s.

A causa não é a concorrência ENTRE gates: `bun run test` satura a máquina sozinho — 734 arquivos
com workers paralelos — e qualquer gate que leia o repo inteiro sob um teto de 20s vira flaky por
CARGA. Rodar em paralelo piora; rodar em série não cura.

O que fica como regra, então, não é "rode em série", e sim: **`timeout` não é `AssertionError`**.
Diante de um vermelho, ler qual dos dois é vem ANTES de qualquer hipótese sobre o código — os dois
arquivos acusados levaram 3,9s e 3,1s quando rodados sozinhos, contra o teto de 20s. E vale contra
o próprio diagnóstico: a primeira explicação daqui sobreviveu a uma rodada e morreu na seguinte,
porque "rodei em paralelo" explicava o sintoma sem ter sido testada contra o caso em série.

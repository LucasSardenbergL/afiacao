# Teto de cron: VOLUME ou LATÊNCIA? (2026-08-25, sequela dos #2012/#2015)

> Dois estouros reais de `timeout_milliseconds:=150000` no mesmo dia, identificados por eliminação
> em `net._http_response`. **Um justificou folgar o teto; o outro NÃO** — e a diferença não está na
> linha do estouro, está no payload das rodadas que PASSARAM.

## O que veio antes

- **#2012** ensinou que `timeout_milliseconds` mede a **resposta**, não o **trabalho**: numa edge que
  responde `202` + `EdgeRuntime.waitUntil`, o teto não observa nada e folgá-lo não compra nada.
- **#2015** ensinou que **`timed_out` é o campo ERRADO** — fica NULL no estouro, e
  `count(*) FILTER (WHERE timed_out)` devolve **0 com um estouro real na tabela**. Filtre por
  `error_msg IS NOT NULL OR status_code IS NULL`.

O que ficou em aberto: **qual** cron estourava. 20 crons dispararam no minuto observado (`08:30`),
`net._http_response` não tem coluna `url`, e o JOIN com `net.http_request_queue` devolve vazio sempre.

## Como a ambiguidade de emissor foi quebrada (método)

A retenção de ~6h já tinha comido a evidência das 08:30. **Duas saídas, e as duas funcionaram:**

**(a) Observar janela nova, num minuto MENOS concorrido.** Um estouro fresco apareceu às `15:10:00`.
Em `:10` não disparam nem o `*/6` (jobid 140) nem o `30 8 * * *` (jobid 32) — a lista de suspeitos
encolhe sozinha. `cron.job_run_details` do minuto deu **8 jobs, dos quais só 3 usam `net.http_post`**
(49, 79, 162); os outros 5 são SQL-local e não produzem linha aqui. E havia só **2** respostas.

O terceiro suspeito caiu por leitura do **comando**, não por adivinhação: o jobid 79
(`fin-sync-continuacao-10min`) é um `DO` que percorre `fin_sync_cursor WHERE next_page IS NOT NULL` —
com a fila drenada ele emite **zero** requisições. `fin_sync_cursor` tinha 0 pendentes (drenou às
14:10, com `sync_contas_pagar` `complete:true`). ⇒ 3 crons, 2 respostas, e a que falta é do 162.

Confirmado pela **cadência**, de forma independente: a assinatura `v3.3-paginacao-janelas` aparece em
`11:10`, `12:10`, `13:10`, `14:10` e **some exatamente em `15:10`**, onde está o timeout — e
corretamente **não** aparece em `10:10`, porque o schedule é `10 11-23 * * 1-6`. Cinco previsões, cinco
acertos.

**(b) Provar pelo EFEITO NO DADO, sem depender do pg_net.** Para as 08:30 a evidência HTTP tinha
expirado, mas o efeito não: `sync_state` de `products_metadados` fechou `complete` às `08:31:34`
(oben) e **`08:32:39.132` (colacor)**. O kill de `150.004s` sobre um envio às `08:30:01.998` cai em
`08:32:32.003`. A edge é síncrona ⇒ **só poderia responder depois de 08:32:39** ⇒ a requisição do
jobid 32 **obrigatoriamente** estourou. Isto é prova POSITIVA: não depende de eliminar ninguém.

> Generalização: quando a tabela de transporte é ambígua ou já expirou, **o efeito no dado é uma
> testemunha independente** — e frequentemente mais forte, porque persiste.

## Veredito 1 — jobid 32 `omie-sync-metadados-daily`: **folgar o teto** (150000 → 240000)

`omie-sync-metadados` não tem `waitUntil` nem `202`, e percorre as contas em **série**
(`for (const acct of accounts)`, `index.ts:239`), respondendo só no fim: **157s de trabalho contra 150s
de teto**. Não é o caso do #2012 — aqui o teto cobre trabalho de verdade, e está curto.

O trabalho terminou mesmo assim porque **o isolate Deno sobrevive ao disconnect do cliente** —
comportamento que o `sync.md` já registra como **acidental e não-garantido pela plataforma**. Ou seja:
o sync do catálogo hoje depende de um acidente.

**Por que ninguém viu — todo sensor estava verde:**

| sensor | o que dizia | por quê |
|---|---|---|
| `cron.job_run_details` | `succeeded` | só registra o **enqueue** |
| `net._http_response.timed_out` | `NULL` | a armadilha do #2015 |
| `sync_state.status` | `complete` | **hard-coded** pela edge — nunca `error`/`partial` |
| vigia de frescor (`sla_h`=30) | `ok` | `last_sync_at` avança todo dia, porque o trabalho termina |

⇒ **"o dado está fresco" NÃO prova "o cron cabe no teto".** A única testemunha era `error_msg`, com
retenção de ~6h. E se a plataforma passar a matar o isolate no disconnect, quem morre é a conta do
**fim** da série (colacor) — calada por até 30h, até o vigia de frescor acordar.

Número escolhido: **240000** ≈ 1,5× os 157s medidos (83s de folga ≈ +4.000 produtos ao ritmo medido de
~2s por página de 100), e bem abaixo do wall-clock ~400s do isolate. Migration:
`20260825124938_cron_metadados_timeout_240s.sql` — `cron.schedule` faz upsert por nome, preserva o
jobid, e url/headers/body vão verbatim da prod (provado por diff normalizado, com sabotagem exigindo
vermelho).

## Veredito 2 — jobid 162 `omie-nfe-reconcile-1h`: **NÃO folgar o teto** (decisão de não-agir)

Estouro real, mesmo dia, mesmo teto — e a conclusão é **oposta**. O discriminador não é a linha do
estouro (`content` NULL, `status_code` NULL: ela é muda), são as **métricas de esforço no payload das
rodadas que passaram**:

| rodada | `pendentes_avaliadas` | `chamadas_listagem` | `truncada` |
|---|---|---|---|
| 11:10 | 5 | **7** de 12 | `false` |
| 12:10 | 5 | **7** de 12 | `false` |
| 13:10 | 5 | **7** de 12 | `false` |
| 14:10 | 5 | **7** de 12 | `false` |
| 15:10 | — | — | **TIMEOUT** |

Carga idêntica hora após hora, folga de 5 chamadas no orçamento, nada truncado: **~20s de trabalho
contra 150s de teto**. O Omie estava saudável no minuto (`totalSynced` 1406/49/758 às 15:15/15:25/15:30)
— não foi queda de plataforma. E o `error_msg` mostra DNS 14ms + handshake 81ms + **149.905ms de
request/response**: a conexão subiu e a edge simplesmente não respondeu.

⇒ É **latência**, não volume: uma requisição pendurada. **Subir o teto só faria esperar mais no mesmo
socket travado** — o teto já é 7× o necessário.

**A lacuna real** é `omieCall` sem `AbortSignal.timeout`: nenhum limite por requisição, e retry de 3
tentativas com backoff multiplicando o tempo. O guard existente (`MAX_CHAMADAS_LISTAGEM = 12`) é de
**contagem**, e contagem não limita relógio. É o oposto do padrão que o `sync.md` já prescreve em
§Enumeração pesada (`AbortSignal.timeout` por request + **deadline compartilhado**).

E não é local: **23 das 26 edges que chamam `app.omie.com.br` não têm nenhum `AbortSignal`.**

**Raio de dano do estouro, medido:** zero. A fase cara é a **listagem** (read-only contra o Omie), e ela
roda ANTES da reconciliação — ser morto ali não escreve nada. O lock é TTL de 5min (auto-cura, contra
cadência de 1h), a edge é idempotente, e a rodada seguinte reprocessa. Custo real de um estouro: **1h de
atraso em ≤25 NF-e pendentes.** Isso é o que sustenta a decisão de não mexer agora.

## Fica em aberto (com o denominador honesto)

- **Frequência do 162:** 1 estouro em 5 disparos observados **num único dia** — amostra pequena demais
  para chamar de taxa. Não há log durável de duração desta edge; a medição exige repetir a leitura
  dentro da retenção de 6h.
- **A coleira ausente nas 23 edges** é dívida real, money-path-adjacente (o `tipo_produto` do catálogo
  alimenta gate de compra), e **não** foi endereçada aqui — é mudança de código em 23 arquivos, não de
  cron.
- **Paralelizar as contas do jobid 32** (contas distintas, credenciais distintas) cortaria os 157s para
  ~92s e removeria a dependência do isolate acidental. Não foi feito: exige deploy de edge (manual no
  Lovable) e não elimina o crescimento, só o adia. O teto novo compra a folga; a paralelização é o
  próximo degrau se a duração voltar a encostar.

---

# Sequela (2026-08-25, mesmo dia): a coleira — e o gate que eu achei que a cobria

Fecha o 2º item do "Fica em aberto" acima, para o jobid 162. **Não** fecha as outras 22 edges.

## O que a coleira precisa ser (e por que o teto por request não basta)

`AbortSignal.timeout(25s)` sozinho ainda deixa o run cruzar o kill: 3 tentativas de 25s mais os
backoffs passam de 75s, e a **última pode COMEÇAR faltando 1s** para o kill. Quando o kill chega no
meio de um request o isolate morre sem passar pelo catch — que é exatamente a linha órfã `running`
que `docs/agent/sync.md` §Enumeração pesada manda evitar. Por isso o teto de cada request e o sleep
de cada retry saem de um **deadline compartilhado** do run, não de uma constante por chamada.

A aritmética virou helper puro (`supabase/functions/_shared/omie-deadline.ts`, 13 testes Deno) em vez
de ficar solta em 23 `omieCall`s. Duas funções, e cada uma existe por um furo concreto:

- `timeoutRequestMs(agora, deadline, teto)` → `min(teto, restante)`, e **0 quando o restante não paga
  um request viável**. O 0 é a parte que importa: um request condenado a abortar gasta o mesmo socket,
  devolve erro genérico e não traz dado — recusar deixa a cobertura parcial explícita (aqui,
  `truncada:true` no payload, que é o MESMO campo que provou `truncada:false` no diagnóstico do #2017).
- `cabeEspera(agora, deadline, espera)` → exige espaço para o sleep **e** para a chamada seguinte. Um
  guard escrito como `Date.now() + backoff >= deadline` — a forma que a edge de referência
  `omie-sync-status-produtos` usa — aprova um sleep de 10s com 11s de sobra, e o 1s restante não paga
  nem o handshake (81ms de TLS + ~1,5s de listagem, medidos). O sleep cabe; o retry não.

## O achado de método: `edges:typecheck` **tolera** a classe de erro que este refactor produz

Ao mudar a assinatura de `omieCall` eu troquei a ordem dos parâmetros na declaração e não no
call-site — passei `deadline` onde ia `payload`. Rodei `bun run edges:typecheck` **com o bug**:

```
EXIT=0   ✅ 0 erros de classe-crash.
         112 erro(s) de outras classes tolerados (dívida conhecida): TS2345:42 …
```

Verde. O gate é de **precisão, não de recall** (por desenho — `docs/superpowers/specs/2026-07-21-edges-typecheck-gate-design.md`), e `TS2345` (*argument of type X is not assignable to Y*) está na dívida tolerada. Ou seja: **a perna de tipos dos "3 gates de edge" não pega troca de ordem de argumentos** — justamente o erro que um refactor de assinatura comete. O que pega é `deno check --no-remote <arquivo>` direto:

```
TS2345 [ERROR]: Argument of type 'number' is not assignable to parameter of type 'Record<string, unknown>'.
EXIT=1
```

A confirmação cruzada veio de graça no gate agregado: depois do fix, o contador foi de **TS2345:42 → 41**. O erro estava lá o tempo todo, diluído num número que o gate imprime e aprova.

**Regra:** ao mexer em ASSINATURA de função de edge, `deno check --no-remote` no arquivo tocado — o `edges:typecheck` do CI conta esse erro e segue verde. O agregado responde "a dívida não cresceu de classe", não "o seu arquivo está são".

## Falsificação (helper)

Três sabotagens, cada uma no invariante de uma função, com `git checkout --` entre elas (o commit veio antes — `restaurar()` aqui é literalmente checkout):

| Sabotagem | Efeito no verde |
|---|---|
| `timeoutRequestMs` devolve o teto fixo (ignora o restante) | 11 passed / **2 failed** |
| `cabeEspera` sem reservar o request (`>= esperaMs`) | 10 passed / **3 failed** |
| piso vira passe-livre (`restante <= 0`) | 12 passed / **1 failed** |
| restaurado | **13 passed / 0 failed**, exit 0 |

## Números

- Edges que chamam `app.omie.com.br`: **26**. Sem nenhum `AbortSignal` antes desta entrega: **23**. Depois: **22**.
- Gates: `test:edges` **910 passed / 0 failed**; `edges:typecheck` exit 0 (TS2345 42→41); `deno check` do arquivo exit 0.

## Priorização das 22 restantes (medida, não estimada)

Cruzamento de `cron.job WHERE active` com a lista de edges sem coleira — **9 têm cron direto**, e 5 mais entram pelo orquestrador `omie-cron-diario` (jobid 52, teto 120s), que não aparece numa busca por cron:

| Urgência | Edges | Por quê |
|---|---|---|
| Alta (cron + money-path) | `omie-sync-estoque` (31/124, teto **90s**), `omie-sync-metadados` (32, 240s), `omie-sync-sku-items` (53), `omie-vendas-sync` (85/86/**140 `*/6`**), `omie-analytics-sync` (**12 crons**) | catálogo/estoque/vendas; o teto de 90s do `omie-sync-estoque` é o mais apertado do conjunto |
| Alta (via orquestrador) | `omie-sync-pedidos-compra`, `omie-sync-nfes-recebidas`, `omie-sync-ctes-recebidos`, `omie-sync-vendas-items` | steps ORDENADOS do jobid 52 — um step pendurado atrasa os seguintes, que LEEM o espelho do anterior |
| Média | `omie-sync` (44, 60s), `omie-nfe-recebimento-sync` (157), `cmc-snapshot-backfill` (148, 600s), `disparar-pedidos-aprovados` (29), `sync-reprocess` (34/35) | cron, money-path indireto |
| Baixa | `omie-nfe-recebimento`, `process-nfe`, `tint-omie-sync`, `verify-employee`, `omie-malha-sync`, `omie-aplicar-parametros`, `analyze-unified-order`, `cmc-snapshot-smoke` | sem cron — invocação humana, que tem um humano olhando o relógio |

⚠️ **O deadline não é transferível por cópia:** cada edge tem de derivar `MAX_DURACAO_MS` do teto do
SEU cron, e os tetos vão de **60s a 600s**. Copiar o `120_000` daqui para uma edge cujo cron corta em
60s produz um guard que nunca morde — coleira decorativa, pior que nenhuma, porque parece coberta.

---

# Sequela 2 (2026-08-25): os 5 steps do `omie-cron-diario` — e a correção do aviso acima

O aviso ⚠️ da seção anterior está **certo para edge com cron próprio e errado para step de
orquestrador**, e a diferença custa o guard inteiro.

## O teto do jobid 52 não é o relógio de nenhum step

`omie-cron-diario` aborta o **cliente** em `STEP_TIMEOUT_MS = 25s` e reporta o step como
`modo:"background"` — que **não é falha**: a edge filha commita por página e **segue rodando
server-side** até o guard interno DELA (comentário de cabeçalho da edge, provado por efeito em
2026-06-27). Logo, derivar `MAX_DURACAO_MS` dos 120s do jobid 52 produziria exatamente a "coleira
decorativa" que o aviso alerta — só que pelo motivo inverso: o teto do cron é curto **demais**, não
de menos, e a filha nunca é morta por ele.

**A regra corrigida:** o deadline sai do teto do cron **daquela edge**; quando a edge não tem cron
próprio e só é chamada por orquestrador, sai do **guard interno dela**. Em nenhum caso do teto do
cron do orquestrador.

## Medição antes de escolher o valor (`fin_sync_log`, 14 dias)

| action | runs | média | p95 | max | guard de relógio |
|---|---|---|---|---|---|
| `sync_pedidos` | 336 | 55s | **120s** | **129s** | **NENHUM** |
| `sync_nfes_recebidas` | 168 | 18s | 29s | 80s | 130s |
| `sync_sku_items` | 182 | 11s | **61s** | 62s | **50s** |

Duas leituras que só o dado dá:

- **`sync_pedidos` roda com p95 de 120s e não tem guard nenhum.** Introduzir um `MAX_DURACAO_MS`
  aqui não seria pôr coleira, seria **arbitrar truncamento** — e é este espelho que `nfes`/`ctes`
  leem no step seguinte. Latência e volume são decisões separadas, com dados separados.
- **`sync_sku_items` já bate no próprio guard** (p95 61s contra `TIMEOUT_GUARD_MS` de 50s). O guard
  morde de verdade; o que faltava era ele valer também para o request e para o backoff.

## Dois desenhos, escolhidos pelo terreno

| edge | guard existente | o que recebeu |
|---|---|---|
| `omie-sync-nfes-recebidas` | 120s (loop) / 130s (backfill) | deadline compartilhado, um por função, do `t0` que ela já recebe |
| `omie-sync-sku-items` | 50s | deadline compartilhado |
| `omie-sync-vendas-items` | 25s | deadline compartilhado |
| `omie-sync-pedidos-compra` | — | **só** teto por request |
| `omie-sync-ctes-recebidos` | — | **só** teto por request |

O deadline compartilhado nunca é relógio novo: é o guard que a função **já consulta** ficando
visível para o `fetch` e para o `sleep`. `nfes` prova o ponto — o loop principal cede aos 120s e o
backfill aos 130s, então são **dois** deadlines do mesmo `t0`, cada um alinhado ao guard da sua
função. Um deadline único de 130s teria deixado o loop principal dormir 10s além do que ele mesmo
já decidiu ceder.

## Fail-closed: o abort não pode virar fim de paginação

Os 5 wrappers já rejeitavam `faultcode`/`faultstring`, e isso não mudou. O que importa checar a cada
edge é **para onde o `TimeoutError` vai**:

- `pedidos`, `ctes`, `sku`, `nfes` — wrappers **throw-based**: a exceção propaga e mata a página com
  erro. Nunca há um `json` vazio para o laço ler como fim.
- `vendas-items` — wrapper **result-based** com `try/catch` que engole erro de rede: devolve
  `{ok:false}` e o caller **lança** em `!result.ok` (linha 373). Fail-closed pela outra ponta.

Esse `catch` de `vendas-items` é também o motivo de o deadline ser indispensável ali: ele captura o
`TimeoutError` e **retenta**, e 3 tentativas de 20s mais backoff passam muito do guard de 25s.

## Falsificação (a rede real deste refactor)

O que protege um refactor de assinatura não é o gate do CI:

| sabotagem | `deno check --no-remote` | classe |
|---|---|---|
| tirar `deadline` de um call-site | **rc=1** | TS2554 (aridade) |
| trocar a ORDEM (`deadline` no lugar de `param`) | **rc=1** | **TS2345** |

TS2345 é **exatamente a classe que o `edges:typecheck` tolera** (41 na dívida). O gate do CI teria
passado verde nas duas sabotagens. Confirma a lição da sequela 1 por um segundo caminho.

## Não existe gate exigindo `AbortSignal` — e ele não pode nascer ainda

`edge-money-path-invariants.test.ts` tem um `toMatch(/signal: AbortSignal\.timeout\(/)`, mas ele
vigia **uma** edge de reposição, não a família Omie. Um gate abrangente ("todo `fetch` para
`app.omie.com.br` carrega `signal`") é o fecho natural desta série — e **só é instalável quando a
última edge estiver coberta**, senão nasce vermelho com as 17 restantes. Instalar o gate é a última
entrega, não a primeira.

## Sequela: 17 restantes

Saem da lista da seção anterior as 5 deste PR. Segue no topo `omie-sync-estoque` (teto de **90s**, o
mais apertado do conjunto) — e ele tem cron próprio, então ali o aviso ⚠️ original vale como escrito.

## Ritual Codex — onde ele estava certo, e onde o dado o contradiz

**Certo, e virou correção (money-path):** o deadline é propriedade do RUN, não do item. Em
`omie-sync-sku-items` a exceção de deadline caía no mesmo catch da falha de consulta e chamava
`marcarTentativa` — backoff de **6h/24h/72h** para uma NFe que nunca foi consultada, até 4 por vez
(o guard do laço só roda a cada 5). Foi uma regressão **introduzida pela própria coleira**. A
correção não precisou de classe de erro nova: basta checar o deadline **antes do `sleep` de
cadência** e sair do laço — a NFe nem entra no `try`. Abort de request que de fato saiu para o Omie
continua marcando tentativa, que aí é falha da consulta mesmo.

**A lição geral:** ao pôr coleira num laço que trata falha POR ITEM, pergunte sempre quem paga a
conta do limite do run. Se o item herda a punição, a coleira criou um dano novo enquanto consertava
outro.

**Certo, mas parcialmente:** ele apontou 4 `sleep` de cadência sem guarda. Em `sku` era real e foi
corrigido (5s, guard a cada 5 itens). Em `nfes` (1,1s) e `vendas` (1,1s) o guard do laço roda a
**cada** iteração e o catch não agenda backoff — o dano é dormir ~1s a mais. Ficam anotados, não
corrigidos: dizer "nenhum sleep cruza o deadline" seria afirmar mais do que se entregou. O que vale
é: **nenhum sleep de RETRY cruza**, e em `sku` nenhum de cadência também.

**Contradito pelo dado:** ele alegou que o p95 estaria **censurado** — runs mortos por wall-clock
não teriam `completed_at` e ficariam fora do percentil. É uma boa objeção metodológica, e foi
verificada:

```
action               status    n     sem completed_at
sync_pedidos         complete  336   0
sync_nfes_recebidas  complete  168   0
sync_sku_items       complete  182   0
```

**100% dos runs estão `complete`, zero sem `completed_at`, zero `running`/`partial`/`error`.** Não
há cauda cortada: o p95 de 120s é a distribuição inteira. A decisão de não arbitrar teto de run em
`pedidos` segue de pé pelo mesmo motivo de antes — e agora com a censura descartada, não suposta.

**Fora de escopo, registrado:** o desenho definitivo que ele propõe (cursor/checkpoint por
`pipeline_run_id`, `partial` + retomada na invocação seguinte, publicar só no fim legítimo da
paginação) elimina a categoria "truncamento" em vez de escolher um valor para ela. É a resposta
certa para o problema de VOLUME — e é projeto próprio, não emenda de um PR de latência.

⚠️ O parecer saiu com `REVISÃO INDEPENDENTE PENDENTE`: a segunda instância do ritual não conseguiu
criar temporário sob o sandbox read-only (`mktemp`, exit 70). É auditoria de uma cabeça só.

---

# Sequela 3 (2026-08-26): `omie-sync-estoque` — e a patologia flagrada VIVA no mesmo dia

## O discriminador que faltava: a edge tem cron PRÓPRIO?

A sequela 2 concluiu que edge sem guard de duração não ganha teto de run de brinde. `omie-sync-estoque`
também não tem guard de duração — e mesmo assim ganhou `MAX_DURACAO_MS`. Não é contradição; é o
discriminador ficando explícito:

| situação | o kill já existe? | o que fazer |
|---|---|---|
| edge com cron próprio (`omie-sync-estoque`, 90s) | **sim**, o `timeout_milliseconds` do cron | deadline **derivado do teto** — converte kill BRUTO em saída controlada |
| step de orquestrador (`pedidos-compra`) | **não** — a filha é solta em background | só teto por request; inventar teto de run é arbitrar truncamento |

**A pergunta certa não é "tem guard interno?", é "existe um kill, e quem o dá?".** Onde há kill,
o deadline só torna a morte legível. Onde não há, ele CRIA uma morte que não existia.

## O achado: 60s de sono dentro de um run de 90s

O ramo 429 do `callOmie` dormia **60 segundos** — dois terços do orçamento inteiro — e depois era
morto pelo cron sem gravar nada e sem dizer por quê. `cabeEspera` agora recusa explicitamente, e
quase nunca vai caber: **não há como respeitar um rate-limit de 60s dentro de um run de 90s.**
Falhar dizendo isso é melhor que dormir até o corte. É o mesmo raciocínio do sleep de 5s no `sku`,
uma ordem de grandeza mais caro.

## A edge não escreve em `fin_sync_log` — a sonda é a única prova

53 enqueues em 7 dias (`cron.job_run_details`, jobids 31 e 124, todos `succeeded`) contra **4**
registros de `sync_estoque` em 14 dias — que nem são desta edge, porque ela não grava lá. Logo não
há p95 para esta edge, e o teto do cron é o único número honesto disponível. Consequência prática:
**a sonda de versão é a ÚNICA prova de qual bundle está no ar** — por isso o bump aqui não é
burocracia.

## Flagrante: a mesma assinatura, hoje, noutra edge

`net._http_response` guarda ~1 dia. Nesse dia havia **1** erro, e é a assinatura exata do #2017:

```
2026-08-26 13:00:01 | Timeout of 60000 ms reached. Total time: 60001.316 ms
                      (DNS 158.844 ms, TCP/SSL handshake 639.897 ms,
                       HTTP Request/Response 59202.467 ms)
```

DNS e handshake somam 0,8s; **59,2s foram request/response**. Dois crons de teto 60000 partiram
naquele segundo: `omie-sync` (jobid 44, `0 * * * *`, chama o Omie, **sem coleira**) e
`dispatch-notifications` (jobid 102, não chama o Omie, mas tem 3 `fetch` externos sem coleira).
**Não dá para cravar qual foi** — e registrar o empate é mais útil que escolher o palpite bonito.

O que o flagrante prova, independente de qual seja: a patologia não é histórica, está acontecendo
agora, e a janela de 1 dia dessa tabela significa que a maioria das ocorrências **nunca é vista**.
`omie-sync` sobe na fila da próxima fatia: roda 24×/dia contra 7 do estoque.

## Sequela: 16 restantes

## Pendência aberta no fecho (2026-08-27): 4 edges de TERCEIROS sem prova de deploy

O fecho da sessão varreu a janela inteira (25→27/08), não só o que esta sessão tocou — porque edge
de terceiro entra na main sem ninguém aqui saber e **também** não se auto-deploya. Achado:
`_shared/sonda-versao.ts` e `_shared/sonda-fingerprints.ts` mudaram na janela, e os dois são
importados por **toda** edge com sonda.

**Provadas no ar** pelo `fonte` (fingerprint da fonte servida) batendo com a main:
`omie-nfe-reconcile`, `omie-sync-estoque`, `omie-sync-nfes-recebidas`, `omie-vendas-sync`.

O `omie-vendas-sync` é a demonstração de que o método discrimina de verdade: às 21:48 respondia
`d0d0580c…` (bundle velho) e às 22:04 respondia `47c046a5…` (o da main) — a mesma `VERSAO`
(`v1.0-sensor-inicial`) nas duas, ou seja, **o `versao` não teria visto o deploy e o `fonte` viu**.

**Sem prova, e por isso pendentes:** `carteira-rebuild`, `omie-analytics-sync`,
`enviar-pedido-portal-sayerlack`, `sayerlack-captura-precos` — nenhuma sondada na janela de 6h do
`pg_net.ttl`.

Como fechar (o chip "Confirmar deploy de 4 edges de terceiros (janela 25-27/08)" carrega o mesmo
roteiro; isto aqui existe porque **chip morre com a sessão**):

1. Ler o `fonte` das sondas recentes e comparar com `_shared/sonda-fingerprints.ts` da main:
   ```
   ~/.config/afiacao/psql-ro -Atc "SELECT DISTINCT (content::jsonb->>'edge') || ' ' || (content::jsonb->>'fonte') FROM net._http_response WHERE status_code=200 AND content IS NOT NULL AND left(ltrim(content),1)='{' AND (content::jsonb) ? 'fonte' AND created > now() - interval '6 hours';"
   ```
2. Edge que não aparecer: pedir ao founder disparar a sonda pelo SQL Editor (`deploy.md` §Canárias),
   lendo **pelo `request_id`** — `ORDER BY id DESC LIMIT 1` pega o tick de outro cron.
3. ⚠️ **Só sonde DEPOIS do deploy:** bundle anterior à sonda ignora o `probe` e executa o fluxo real.
4. Desatualizada → prompt de deploy nomeando **todos** os arquivos da fatia
   (`git show --name-status --format='' <sha> -- supabase/functions/`), `_shared/` incluído.

**Confirme antes de pedir** — a sessão dona pode já ter pedido o deploy, e pedido redundante gasta
o founder à toa.

## Sequela imediata (2026-08-27, 18 min depois): mais 4 edges, e o método acima ficou INAPLICÁVEL

A seção anterior fechou às **22:47Z** declarando 4 edges pendentes. O `e5a484e2c`
(`feat(sonda): os 4 steps do cron-diário sem sensor`) mergeou às **23:05Z** — 18 minutos depois —
trazendo **outras 4**, disjuntas das primeiras:

| edge | arquivos da fatia |
|---|---|
| `omie-sync-ctes-recebidos` | `index.ts` (M) + `versao.ts` (**A — NOVO**) |
| `omie-sync-pedidos-compra` | `index.ts` (M) + `versao.ts` (**A — NOVO**) |
| `omie-sync-sku-items` | `index.ts` (M) + `versao.ts` (**A — NOVO**) |
| `omie-sync-vendas-items` | `index.ts` (M) + `versao.ts` (**A — NOVO**) |

mais o `_shared/sonda-fingerprints.ts` (M), que as quatro empacotam.

**A lição de processo:** a varredura de terceiros de uma `/fecho` é um **instantâneo**, não um
intervalo fechado — a `main` continua andando enquanto o ritual roda. Duas `/fecho` na mesma noite
acham conjuntos **disjuntos**, e quem lê "4 edges de terceiros" sem o sha e o corte de hora conclui
que aquilo era a história inteira. Registro de pendência de terceiro nomeia o **commit** e o
**horário do corte**, nunca só a contagem.

### Por que o `fonte` NÃO resolveu isto — e por que "ausente" aqui não é veredito

Rodado o roteiro da seção anterior, as quatro voltaram **zero linhas** de `net._http_response`. Ler
isso como "não deployadas" seria o `ausente ≠ zero` na forma mais barata de cometer. O que a
consulta ao `cron` mostrou:

- `omie-sync-ctes-recebidos`, `omie-sync-pedidos-compra`, `omie-sync-vendas-items` — **não têm cron
  direto**. São *steps* de um orquestrador diário (é o que o título do commit diz), e o corpo que
  `pg_net` retém é o da chamada ao ORQUESTRADOR, não o de cada step.
- `omie-sync-sku-items` — tem cron (`afiacao_omie_oben_sku_items_history_daily`, `0 7 * * *`), que
  rodou **07:00Z**, ou seja **~20 h** antes da leitura: fora da janela de `pg_net.ttl = 6 h`.
  `runs_6h = 0`.

**A pré-condição que faltava dita:** o N3 passivo pelo `fonte` só enxerga edge cuja invocação caiu
**dentro das 6 h** do `pg_net`. Para uma edge diária isso cobre 25% do dia; para um *step* de
orquestrador pode não haver linha separada nenhuma. Antes de ler ausência como pendência, consulte
`cron.job`/`cron.job_run_details`: **sem run na janela, o método está INAPLICÁVEL** — que é
diferente de "pendente", e muito diferente de "não subiu".

### Como fechar (chip "Confirmar deploy das 4 edges do cron-diário (`e5a484e2c`)")

1. Esperar a janela útil: o `0 7 * * *` do `omie-sync-sku-items` é a próxima oportunidade barata.
   Depois dele, ler o `fonte` e comparar com `bun run sonda:fingerprint` da `main`.
2. Steps sem cron direto: sondar ativamente pelo 🟣 SQL Editor (`deploy.md` §Canárias), lendo
   **pelo `request_id`** — nunca `ORDER BY id DESC LIMIT 1`, que pega o tick de outro cron.
3. ⚠️ **Só sonde DEPOIS do deploy:** bundle anterior à sonda ignora o `probe` e **executa o fluxo
   real** (sync Omie de verdade).
4. Desatualizada → prompt de deploy nomeando **todos** os arquivos da tabela acima, `versao.ts`
   novo e `_shared/sonda-fingerprints.ts` incluídos. Prompt que nomeia só o `index.ts` sobe função
   que **não boota** (#2020).
5. **Confirme antes de pedir** — a sessão dona do `e5a484e2c` pode já ter pedido o deploy.

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

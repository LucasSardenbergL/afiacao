# sku-items: a consulta REDUNDANT do próprio ciclo — o limite do run virava falha da NFe

> 2026-09-24. Alerta por e-mail "[Sync erro] OBEN" (`fin_alertas` tipo `sync_error`, 2026-09-23
> 00:30 UTC). Desfecho em duas partes: (A) o limite do RUN passa a ser **ADIAMENTO** — sem tentativa
> marcada, sem `error` —, com um sensor pelo DADO para a fila que não anda; (B) a chamada redundante
> sai da fonte: o `omie-sync-sku-items` deixa de ser step do `omie-cron-diario` e ganha cron próprio
> no minuto :35. Regra que fica: **exceção não é canal de controle — "não deu tempo" e "a NFe
> falhou" não podem cair no mesmo `catch`.**

## 1. O mecanismo (medido)

1. O step NFe (`omie-sync-nfes-recebidas`, 2º step do jobid 52, `15 */2 * * *`) re-consulta
   `ConsultarRecebimento({nIdReceb})` para TODA NFe da janela de 3 dias, a cada ciclo.
2. Segundos depois, o 4º step (`omie-sync-sku-items`) repete a chamada IDÊNTICA para a NFe no topo
   da fila dele. A Omie responde *"Consumo redundante detectado. Aguarde N segundos (REDUNDANT)"*,
   com N≈49–51.
3. O `callOmie` do #2031 (2026-08-26, coleira de relógio) LANÇA quando a espera não cabe no guard de
   50s do run.
4. O `catch` do laço chamava `marcarTentativa("consulta_falhou: …")`: a NFe ganhava backoff de
   6h/24h/72h por um limite do RUN — contra o próprio comentário do código, "tentativa só se conta
   quando a chamada de fato saiu".
5. `consultas_tentadas=1, consultas_detalhadas=0` ⇒ `error` *"1 consultas Omie tentadas, 0 OK —
   rate-limit/indisponibilidade?"* ⇒ dois seguidos ⇒ o `fin_sync_watchdog_check` (*/30) pagina.

## 2. A evidência (psql-ro, 2026-09-23/24)

| medição | valor |
|---|---|
| runs `sync_sku_items` OBEN em 30 dias | 343 `complete` · 46 `error` |
| minuto dos 46 `error` | todos :15/:16 (ciclo do jobid 52); **zero** nos 30 runs das 07:00 (jobid 53, sem step NFe antes) |
| mensagens | "1 consultas…" 41× · "2 consultas…" 5× |
| primeiro `error` | 2026-08-27 02:15 UTC, o dia seguinte ao #2031 |
| duração de um run com erro | ~6,2s = 5s de cadência + 1 chamada recusada |
| NFes punidas pelo limite no controle | 3 linhas com motivo "consulta_falhou: … limite pede …" |
| efeito em `sku_leadtime_history` (writer único) | n7d=49 · n30d=173 — atraso, não perda |
| hipótese "o step NFe ainda roda em background" | falsificada: erro em 2/10 runs com sobreposição contra 44/66 sem |

## 3. O conserto

### A — adiamento, na edge `omie-sync-sku-items` (`v1.2-adiamento-por-limite-do-run`)

- [`consulta.ts`](../../supabase/functions/omie-sync-sku-items/consulta.ts): a chamada, com request,
  relógio e sono **injetáveis** — o mesmo código roda na edge e contra um Omie falso no teste. O
  desfecho por NFe sai classificado: `respondida` · `adiada` · `falhou`. O adiamento é reconhecido
  por marca ESTRUTURAL (`adiada: true` + motivo de um conjunto fechado); um `Error` com o mesmo
  texto continua falha.
- Adiada ⇒ não marca tentativa, não conta como falha; o laço segue para a próxima NFe (REDUNDANT é
  por chamada) ou encerra (deadline vencido vale para todas).
- Corpo 2xx que não é objeto JSON ⇒ **falha** (antes virava "resposta sem itens" e `ok_0_itens`).
  "Já existe uma requisição desse método" ⇒ limite, como na edge irmã.
- Contadores com unidade explícita: `consultas_tentadas` (NFes com ≥1 request), `requisicoes_omie`
  (requests iniciados, retentativas incluídas), `consultas_detalhadas`, `consultas_adiadas_por_limite`, `consultas_falhas`,
  `controle_marcacoes`.
- Status do run numa decisão pura ([`adiamento.ts`](../../supabase/functions/omie-sync-sku-items/adiamento.ts)),
  com a precedência testada: falha sistêmica (falha REAL e nenhuma resposta) › controle inoperante
  (contra as marcações FEITAS) › escrita morta (upsert tentado, nenhum gravado) › fila não anda ›
  recompute.
- Sensor `results.fila_parada_48h`: RECEBIMENTO consultável, com alguma linha elegível há mais de
  48h, que o run não tratou (adiado ou não alcançado pelo guard) ⇒ `error` "fila não anda". Roda
  sobre a fila ANTES do dedup (a irmã parada não se esconde atrás da irmã nova) e independe da vazão
  dos outros recebimentos. Falha só conta como tratada se a marcação no controle persistiu.
- O sensor é `null` (não avaliado) quando a chamada vem do ORQUESTRADOR: no :15 o adiamento por
  REDUNDANT é esperado enquanto o sku-items for step dele, e lá ele mede a colisão, não a fila.
- O motivo gravado no controle diz o que aconteceu: `upsert_falhou`, `ok_parcial`,
  `ok_sem_itensRecebimento` e `ok_itens_sem_nIdProduto` deixam de se esconder atrás de `ok_0_itens`
  e `ok_com_itens`.

### B — a redundância, na fonte

- Cron `afiacao_omie_oben_sku_items_2h` (`35 */2 * * *`, `dias=3`, `timeout_milliseconds` 120000,
  dono `postgres`): migration `20260924163250_cron_sku_items_2h_proprio.sql`, com postcondição. O
  :35 fica ~16 min depois do step NFe e estava vazio no mapa de minutos dos 93 jobs.
- `omie-cron-diario` sem o step `sku_items`, e com sonda própria (`v1.0-sem-step-sku-items`) — num
  PR SEPARADO, que só vai para a main depois do cron existir e rodar uma vez `complete`. Na ordem
  inversa a cadência de 2h cairia para o diário das 07:00.
- Descartadas: ler `raw_data.itensRecebimento` gravado pelo step NFe (não existe para as linhas que
  o sku-items consulta — o laço principal grava o item da LISTA, e o backfill só roda com `nid_receb`
  nulo; e `raw_data` é jsonb multi-writer) e pular NFe tocada há menos de 60s (no :15 a fila inteira
  acabou de ser tocada: o step viraria no-op).

## 4. Codex no desenho — gpt-6-astra · max · 386s · 77.127 tokens: sem P0

| achado do Codex | decisão |
|---|---|
| continuar × encerrar o laço depois do adiamento | aceito — `saidaDoLaco`: limite segue, deadline encerra |
| `falhaControle` dividia por consultas tentadas; adiamento esconde controle morto | aceito — `controle_marcacoes` |
| corpo não-JSON virava resposta; "Já existe uma requisição" virava resposta | aceito, os dois |
| diferenciar chave `itensRecebimento` ausente de lista vazia | parcial — só o MOTIVO distingue; o comportamento espera evidência |
| a regra de vazão zero deixa a mesma NFe adiada para sempre atrás de sucessos | aceito — o sensor é por NFe |
| "faturada há 24h" não é "elegível há 24h" | aceito, e a medição da §5 mostrou que era pior que o nome |
| o watchdog não protege a coorte de 30 dias (07:00) | aberto — ver §7 |
| tirar o step muda o contrato para COLACOR | refutado por dado: 1142 de 1142 runs em 90 dias são OBEN, 0 linhas de leadtime COLACOR |
| as RPCs de reclassificação passariam a rodar mais | refutado: já rodam todo ciclo (~75s de 115s) e `aplicar_parametros_automatico_diario` tem guarda de 1×/dia BRT |
| provar que o ledger lê a resposta direta | provado: 19 atestações `via=eco` da sku-items, todas das 07:00 (jobid 53, direto) |
| exigir execução observada do cron antes de tirar o step | aceito — virou a separação em dois PRs |
| a prova tem de atravessar o código real | aceito — `consulta_test.ts` contra Omie falso |

## 4b. Codex no código — gpt-6-astra · max · 556s · 186.211 tokens: sem P0

| achado do Codex | decisão |
|---|---|
| falha cuja marcação NÃO persistiu contava como tratada e sumia do sensor | aceito — só entra nos tratados dentro do `if (marcou)` |
| "elegível desde" pode anteceder o `nIdReceb`: NFe que o ganha depois do diário, com faturamento de 60h, pagina nos dois :15 seguintes | aceito — o sensor não é avaliado no caminho do orquestrador (`null`), onde o REDUNDANT é esperado |
| o dedup esconde a idade da irmã parada | aceito — sensor por recebimento, sobre a fila antes do dedup, com a linha mais antiga |
| upsert PARCIAL (2 SKUs, 1 falha) tira o tracking da fila e o SKU que falhou nunca volta | **fora deste PR** — pré-existente, 0 runs com erro de upsert em 30 dias, e o conserto tem trade-off próprio (atomicidade por recebimento faria uma linha ruim bloquear a NFe inteira). Mitigação aqui: motivo `ok_parcial` |
| o `vereditoFronteira` aprova o sensor alimentado por `fila.slice(0, 0)` | aceito em parte — o 1º argumento `filaOrdenada` é exigido literal; o teste comportamental do handler inteiro fica como dívida (exige supabase injetável) |
| promover a parte B só com o eco `v1.2` da parte A atestado, não só com o cron `complete` | aceito — checklist do PR B |
| `requisicoes_omie` conta invocação, não envio físico | aceito — o comentário diz isso |

## 4c. A trava "por MÉTODO" do reconcile não se reproduz no sku-items hoje

O `omie-nfe-reconcile` e o `omie-nfe-recebimento-sync` documentam, em julho, que a anti-redundância
da Omie morde o MÉTODO `ConsultarRecebimento` por conta — parâmetros distintos a 4s dariam REDUNDANT.
Se valesse hoje, o sku-items faria no máximo uma consulta por run. Medido nos runs de 30 dias: os das
07:00 fazem **7 de 7, 6 de 6, 5 de 5** consultas com NFes diferentes, a ~6s uma da outra, todas
respondidas. O REDUNDANT deste incidente é o da chamada IDÊNTICA, com janela de ~60s. O :35 é seguro
nas duas hipóteses: nenhum outro chamador do método fica a menos de 15 min (NFe no :15–:18,
recebimento-sync no :50).

## 5. A régua do sensor foi MEDIDA — e a primeira estava errada

A primeira versão contava NFe "faturada há mais de 24h" sem consulta. Simulada contra a produção,
ela gritaria no lugar errado: numa linha de PEDIDO o `created_at` vem em mediana **47h antes** do
faturamento, e 1 em 69 NFes só aparece para nós com o t2 já passado de 24h. Enquanto o sku-items for
step do orquestrador, toda NFe de 1–3 dias é adiada no :15 e só o diário das 07:00 a alcança — com a
régua do t2 isso virava `error` em runs SEGUIDOS, o e-mail falso de volta.

A régua ficou **"elegível desde"**: fim do backoff quando a NFe já foi tentada; senão o maior entre
o nascimento da linha e o faturamento. O limiar de 48h garante ao menos uma passada do diário antes
de gritar. No estado de 2026-09-24: 0 NFes na janela de 3 dias e 4 elegíveis na de 30 — nenhuma
parada por nenhuma das réguas.

## 6. Falsificação — uma camada por vez, controle verde na mesma invocação

| sabotagem | resultado |
|---|---|
| adiamento vira `throw` | 3 testes vermelhos |
| corpo não-JSON vira resposta | 1 vermelho |
| requests não contados | 5 vermelhos |
| sem `if (!res.ok)` | **verde na 1ª rodada** — ver abaixo; 2 vermelhos depois do teste novo |
| `sku_items` volta a ser step do orquestrador | 1 vermelho (contrato de sonda) |
| a sonda do orquestrador calcula e descarta | 1 vermelho |
| o sensor usa só `created_at` · ignora o limiar · ignora o backoff | 2 · 2 · 1 vermelhos |
| laço: adiada marca tentativa · status descartado · adiamento não contado · recompute engolido · sensor descartado | 1 vermelho cada (invariantes do vitest) |
| sensor alimentado por `filaOrdenada.slice(0, 0)` · falha tratada sem marcação | 1 vermelho cada (invariantes do vitest) |
| irmãs: vale a linha MAIS NOVA · `null` do orquestrador vira `error` | 1 vermelho cada (Deno) |

**O achado:** o único teste de HTTP 500 usava corpo HTML, e a checagem "não é objeto JSON" o pegava
por coincidência — a camada do status estava INALCANÇADA. O teste novo usa 500 com JSON válido, a
forma real do fault SOAP da Omie. Teste que passa por duas camadas não prova nenhuma delas.

## 7. O que fica descoberto

- **A coorte de 30 dias só é alcançada pelo diário das 07:00.** Um `error` "fila não anda" ali é
  seguido de runs `complete` de 2h, que não enxergam NFes de mais de 3 dias ⇒ nunca há dois `error`
  seguidos, e o Sentinela não pagina. O `error` fica no `fin_sync_log`. Fechar isso pede um sensor
  por fora da edge (SQL sobre a fila), não mais regra dentro dela.
- **A família Sayerlack série 1 responde 0 itens.** Nos 30 runs das 07:00 o total gravado foi ZERO
  itens, com ~19 NFes pendentes por dia girando no backoff. O motivo novo vai dizer se é chave
  `itensRecebimento` ausente ou lista vazia — evidência antes de mudar comportamento.
- **HTTP 500 com fault de negócio conta como falha** (comportamento anterior, mantido).
- **Upsert parcial perde o SKU que falhou** (P1 do Codex, anterior a esta fatia): a linha gravada
  tira o tracking da fila, e o SKU que falhou nunca é retentado. Zero ocorrências em 30 dias; o
  motivo `ok_parcial` o deixa à vista. O conserto (pendência por SKU ou atomicidade por recebimento)
  pede decisão de trade-off própria.
- **Antes da parte B, o sensor não pagina.** No :15 ele é `null` por desenho, e o `error` isolado
  das 07:00 é apagado pelo :15 seguinte. Ele passa a valer de verdade com o cron do :35.

## 8. Ordem de deploy e revalidação

1. PR da parte A mergeado ⇒ deploy da `omie-sync-sku-items` (MCP; `pendencias:deploy` decide) ⇒ o
   eco `v1.2-adiamento-por-limite-do-run` aparece aninhado no corpo do jobid 52 e no ledger às 07:00.
2. Founder cola a migration do cron no SQL Editor ⇒ validação por psql-ro ⇒ 1º tick do :35 `complete`.
3. Com o cron `complete` no :35 **e** o eco `v1.2-adiamento-por-limite-do-run` da sku-items atestado
   (o cron rodando a edge velha também fecha `complete` — isso prova o agendamento, não a parte A):
   PR da parte B pronto ⇒ merge ⇒ deploy do `omie-cron-diario` ⇒ o jobid 52 responde sem
   `resultados.sku_items`, e o ledger atesta `omie-cron-diario` `v1.0-sem-step-sku-items`.

Revalidação, read-only (`~/.config/afiacao/psql-ro`), 72h depois do passo 3 (o backoff mais longo
das 3 NFes punidas é de 72h):

```sql
-- zero erro do incidente; minutos dos runs; adiamentos e fila parada
select to_char(started_at at time zone 'UTC','MI') minuto, status, count(*),
       sum((results->>'consultas_adiadas_por_limite')::int) adiadas,
       max((results->>'fila_parada_48h')::int) fila_parada_max
from fin_sync_log
where action = 'sync_sku_items' and started_at > now() - interval '72 hours'
group by 1, 2 order by 1, 2;
-- nenhuma NFe NOVA punida pelo limite do run
select count(*) from sku_items_sync_controle
where motivo ilike '%limite pede%' and ultima_tentativa > now() - interval '72 hours';
-- o efeito continua
select count(*) filter (where updated_at > now() - interval '7 days') n7d
from sku_leadtime_history where empresa = 'OBEN';
```

Esperado: nenhum `error` "consultas Omie tentadas, 0 OK"; runs nos minutos :00 e :35, nenhum no
:15/:16; `fila_parada_max` 0; zero NFe nova com "limite pede"; `n7d` > 0.

# sku-items: o sensor da fila parada POR FORA da edge — view + função + cron :52

> 2026-10-06. Fecha o 1º item do §7 de [sku-items-consumo-redundante-no-ciclo.md](sku-items-consumo-redundante-no-ciclo.md):
> o `error` "fila não anda" do diário das 07:00 é apagado pelo `complete` do run de 2h seguinte, e o
> Sentinela nunca pagina. Migration `20261006004500_sku_items_fila_parada_sensor.sql`, prova
> `db/test-sku-items-fila-parada.sh` (núcleo do CI). Regra que fica: **um sensor que roda DENTRO da
> máquina vigiada só pagina quando a máquina erra duas vezes seguidas, e a coorte que só um run alcança
> nunca erra duas vezes. O eixo por fora lê o DADO, entre os runs.**

## 1. A lacuna (por que existe)

- A edge grava `results.fila_parada_48h` e fecha `error` "fila não anda" desde o #2539.
- O `fin_sync_watchdog_check` (*/30) só pagina com **dois `error` seguidos** da mesma action.
- NF-e com mais de 3 dias só é alcançada pelo diário das 07:00 (jobid 53, `dias=30`). O run seguinte
  (jobid 186, `35 */2`, `dias=3`) nem a enxerga e fecha `complete` ⇒ nunca há dois `error` seguidos.
- E o sensor da edge é a máquina dando nota a si mesma.

Incidente-mãe: `fin_alertas` `8a83fdf2-8660-4bf0-8151-a871cf437d6c` (`sync_error` OBEN, 2026-09-23). O
verde falso desta lacuna é **provado por execução** no C0 da prova: o `fin_sync_watchdog_check` REAL
pagina dois `error` seguidos (controle positivo) e fica mudo com [07:00 `error` "fila não anda",
08:35 `complete`]. No mesmo estado, o sensor novo abre o alerta.

## 2. A medição (psql-ro, 2026-10-05/06)

| medição | valor |
|---|---|
| fila agora (NF-e, 30 dias, sem leadtime) | **0** recebimentos — os 17 pendentes eram todos CT-e, que o #2798 tirou da fila |
| sensor da própria edge desde 24/09 | 154 runs, **0** com `fila_parada_48h > 0` |
| espera até a 1ª consulta, NF-e com pedido (desde 20/07) | 115 linhas · p50 19,3h · p90 31,3h · **máx 44,7h** · 0 acima de 48h |
| idem, NF-e órfã | 22 linhas · p50 0h · máx 2h · 0 acima de 48h |
| capacidade do diário das 07:00 (14 dias) | 3–8 elegíveis por run, até 7 consultas no guard de 50s, 1 timeout (27/09) — fila era CT-e |
| órfã produz item? | **sim**: 22 de 69 órfãs OBEN de 90 dias têm leadtime; 9 `ok_com_itens` em 30 dias |

O máx de 44,7h é uma NF-e de 17/08 cuja linha nasceu **depois** do faturamento e só ficou consultável
mais tarde. É o falso positivo que sobra (§4).

A última linha contradizia o `docs/agent/sync.md` ("a órfã responde vazio para sempre", medição de
julho): quem nunca tem item é o **CT-e** (modelo 57), não a NF-e órfã — o #2798 mediu 59/59 contra 33/33.
O bullet foi corrigido junto: filtrar a órfã da fila perderia item de NF-e.

## 3. O desenho (decisão do founder: sensor próprio, não o data-health nem o watchdog de sync)

Três destinos foram postos na mesa, com o motivo de cada um:

- **data-health:** máquina de episódio madura, mas o trio acoplado
  (`_data_health_compute` 101 KB + watchdog + heartbeat) estava sendo recriado no mesmo dia pelo #2787.
- **bloco no `fin_sync_watchdog_check`:** roda às :00/:30, no mesmo minuto do diário. E um erro do
  bloco novo derrubaria o `sync_stale`/`sync_error`, que paginam hoje.
- **escolhido — sensor próprio:** view + função + cron, precedente `reposicao_param_fila_sensor`. Não
  toca máquina que já pagina, e falha dele não derruba ninguém.

**O predicado** espelha a edge regra a regra:

| a edge (`index.ts` / `adiamento.ts` / `escopo.ts`) | a view `v_sku_items_fila` |
|---|---|
| janela: OBEN, `t2 >= now()-dias` (30 no diário), chave presente | idem |
| CT-e fora antes do backoff e do sensor (`ehCte`: 44 dígitos ASCII, pos. 21–22 = 57) | `NOT (chave ~ '^[0-9]{44}$' AND substr(chave,21,2) = '57')` |
| pendente (`pendenteNaFila`, #2801): k medido → k>0; legado → sem linha | `to_jsonb(c)->>'itens_pendentes'`: idem |
| sensor que pagina conta só recebimento SEM NENHUMA linha (#2801) | `NOT EXISTS` linha na janela para o `nid_receb` |
| `nIdReceb` = coluna, senão `raw_data.cabec.nIdReceb` (vazio não conta) | `COALESCE(nid_receb::text, NULLIF(raw->'cabec'->>'nIdReceb',''))` |
| elegível desde = fim do backoff 6/24/72h; nunca tentada = max(created_at, t2) | idem |
| por recebimento, a linha mais antiga; parado = elegível há MAIS de 48h | `min(elegivel_desde)`, `> interval '48 hours'` |

A ponta que alerta:

- **`sku_items_fila_parada_check()`** é SECURITY DEFINER do `postgres` (BYPASSRLS e dono das 5
  tabelas, medido). Escreve `fin_alertas` (oben, `sync_sku_items_fila_parada`, `aviso`) e manda o
  e-mail `[Sync fila] OBEN` na abertura do episódio.
- **Resolve sozinha** (`dismissed_at` + `resolvido_em`, como o `data_health_watchdog`) quando a contagem
  zera.
- **A mensagem** leva a data do DADO (o elegível-desde do mais antigo), nunca a idade correndo.
- **Permissões:** `REVOKE` de PUBLIC, anon e authenticated na função e na view. O default de `public` dá
  EXECUTE e ALL a eles (medido no `pg_default_acl`), e o `claude_ro` segue lendo a view.
- **Cron no minuto :52**, 17 min depois de cada :35 e 52 min depois do diário. Os watchdogs `*/30`
  rodam no MESMO minuto do diário: lá, o recebimento que o run das 07:00 trata 30s depois seria
  acusado antes. Fora do minuto de qualquer run, não há corrida.

## 4. Falso positivo e falso negativo — o que foi tratado e o que sobra

| classe | tratamento |
|---|---|
| corrida com o run (:00 do diário) | **eliminada** pelo minuto :52 |
| CT-e girando no backoff para sempre | **fora** pelo mesmo parser da edge (B8a/b) |
| `itens_pendentes = 0` sem linha (#2801: medido completo, sai da fila) | **fora** — lido por `to_jsonb`, vale sozinho quando a coluna chegar (B13a) |
| recebimento incompleto (tem linha, k>0) | **fora** — "não é fila parada", a régua do sensor do #2801 (B13d) |
| visibilidade tardia: NF-e que vira consultável >48h depois do piso, já fora da janela de 3 dias do :35 | **resíduo aceito**: acusada até o próximo diário (≤24h). 0 em 11 semanas; pior caso 44,7h |
| a edge marca tentativa sem consultar de verdade (o bug antigo da punição) | **cego**: o sensor confia em `ultima_tentativa`; o `motivo` mostra, ele não lê |
| sensor morto (cron ou função falhando) | **cego**, como as outras sentinelas avulsas; `cron.job_run_details` registra o erro plpgsql real |
| só o :35 morrer | **não acusa** — o diário cobre tudo em ≤24h; não é fila parada |

## 5. A ligação com o #2801 (mergeado em 2026-10-06 01:13 UTC — migration e edge v1.4 ainda fora de prod)

Conferido contra o código MERGEADO (`recebimento.ts` `pendenteNaFila`, `index.ts` `recebimentosComLinha`/`nIdRecebDe`/`separarCtes`, `adiamento.ts` `avaliarFilaParada`): bate regra a regra. O #2801 mudou a regra da fila: a coluna `itens_pendentes` decide quando foi medida. Ele também tira da
contagem o recebimento que já tem linha. Ler a coluna por nome amarraria a ordem de aplicação dos
dois PRs: a view não criaria sem a coluna. Por isso a leitura é por `to_jsonb(c)`:

- **sem a coluna** dá NULL, e vale a regra legada — que é a da edge no ar (v1.3);
- **com a coluna e a edge v1.3** a coluna fica NULL (a v1.3 não a escreve) e segue valendo a regra legada; **com a v1.4** ela passa a valer sozinha — não há janela de inconsistência em nenhuma ordem de deploy.
- **a prova** adiciona a coluna DEPOIS da view (B13) e confere que
  o `ADD COLUMN` não é bloqueado — a migration do #2801 aplica por cima sem erro;
- **se a coluna for renomeada**, o sensor volta à regra legada e erra para o lado que ALERTA:
  barulho, não silêncio.

## 6. A prova

`db/test-sku-items-fila-parada.sh`:

- **Montagem:** PG17 descartável, a migration REAL numa transação (`-1`, como o `db:aplicar`), e
  stubs na forma medida em prod — colunas, NOT NULL, os CHECKs de `fin_alertas`/`fornecedor_alerta`
  e o índice único parcial. O ramo que ABRE o alerta só roda em prod com fila parada, então é aqui
  que ele encontra as constraints de lá.
- **Asserts:** 58 (C0, B1–B13, E1–E6, K1–K4).
- **17 falsificações de comportamento**, cada uma derrubando um conjunto EXATO de asserts: backoff
  ignorado, tentativas ignoradas, piso só created_at, só t2, `>=` no limiar, CT-e não excluído, sem
  filtro OBEN, sem janela, por linha, irmã mais nova, sem exclusão do recebimento com linha, sem a
  regra `itens_pendentes`, sem resolução, sem ON CONFLICT, sem dual-read, parser frouxo, sem e-mail.
- **7 falsificações da postcondição**, cada uma tem de abortar a migration pelo código certo sem
  deixar meio-objeto: invoker off → A1, coluna renomeada → A2, INVOKER → A3, sem REVOKE → A4,
  claude_ro revogado → A5, schedule → A6, quebra em runtime → a sonda A7.
- **Resultado:** verde em `LC_ALL=C` e em `pt_BR.UTF-8`, cerca de 28s no laptop.

## 7. Codex

- **Desenho:** não rodou. O `codex-async.sh` saiu com exit 79 (cota em 89%, teto 85%, janela reabre
  em 09/10 19:30) sem gastar a chamada. A seção `RÉGUA:` foi escrita e conferida por mim, e está
  abaixo.
- **Adversarial do código:** obrigatório no money-path. O PR fica DRAFT até ele rodar (§"Sem Codex"
  de `docs/agent/money-path.md`).

RÉGUA:

- **Unidade decisória:** o RECEBIMENTO (`nid_receb`, uma chamada `ConsultarRecebimento`). Não é a
  linha de tracking (irmãs dividem o recebimento) nem o SKU.
- **Onde o sistema expõe:** `fin_alertas` (AlertasStack, empresa oben) + e-mail; a view lista os
  recebimentos para diagnóstico.
- **Denominador:** `recebimentos_parados` / `recebimentos_na_fila` (os dois vão no `contexto`).
- **Como a prova falsifica:** cada predicado sabotado sozinho fica vermelho com controle verde na
  mesma invocação; vale nos dois locales.
- **Etapas irreversíveis:** nenhuma econômica. A migration é aditiva e o único efeito externo é um
  e-mail.

## 8. Aplicação e revalidação

**Aplicado em 2026-10-06**, a pedido do founder ("aplicar agora", com o PR em draft até o Codex):

- **Ensaio** (`db:aplicar --ensaio`, rollback) ✅. **Apply real:** a tentativa #251 virou recibo, sha
  `294f4d3d…`, e o log tem o marcador de fim da postcondição (A1–A7, inclusive a sonda que executa o
  sensor).
- **2ª testemunha** (psql-ro, outra conexão):
  - view `invoker`, dona `postgres`, fechada para anon/authenticated e lida pelo `claude_ro`;
  - função SECDEF do `postgres`, `search_path` preso, sem EXECUTE para PUBLIC/anon/authenticated;
  - cron **jobid 190**, `52 * * * *`, ativo como `postgres`;
  - `authz:claude-ro:prod` ✅ (39 asserções).
- A coluna `itens_pendentes` do #2801 **já estava em prod** no apply, e a view a lê desde o 1º tick.
- **1º disparo real: 01:52:00 UTC, `succeeded`.** Foram 19 de 19 até as 19:52, todos no :52, com fila
  0 e nenhum alerta.
- O vigia do 1º disparo disse "SEM TICK", e era falso negativo DELE: o Mac entrou em Clamshell Sleep
  às 01:39:36 UTC e o prazo do laço venceu durante o sono — item 25 de
  [evidencia-positiva-shell.md](evidencia-positiva-shell.md).

⚠️ **O objeto agora EXISTE em prod.** Qualquer mudança (inclusive a que o adversarial do Codex pedir)
é `CREATE OR REPLACE` no molde de objeto VIVO: TRAVA → PRE com o md5 do corpo vivo → PÓS
(`.claude/skills/lovable-db-operator/references/sql-house-style.md`). A view leva o
`WITH (security_invoker = on)` em todo replace.

**Pendente:** o adversarial do Codex no código (`scripts/codex-async.sh -r max`, janela reabre em
09/10 19:30), sobre o diff do #2819 com os fatos do §2 e do §4. O PR só sai de draft depois dele.


```sql
-- o cron e o último disparo (SQL-local: aqui o status é a verdade, não só o enqueue)
SELECT j.jobid, j.schedule, j.active, j.username, d.status, d.return_message, d.start_time
  FROM cron.job j
  LEFT JOIN LATERAL (SELECT * FROM cron.job_run_details r WHERE r.jobid = j.jobid
                     ORDER BY r.start_time DESC LIMIT 1) d ON true
 WHERE j.jobname = 'afiacao_sku_items_fila_parada_1h';
-- a fila e os parados agora
SELECT count(*) AS na_fila, count(*) FILTER (WHERE parado) AS parados FROM public.v_sku_items_fila;
-- os episódios
SELECT criado_em, dismissed_at, resolvido_em, mensagem FROM public.fin_alertas
 WHERE tipo = 'sync_sku_items_fila_parada' ORDER BY criado_em DESC LIMIT 5;
```

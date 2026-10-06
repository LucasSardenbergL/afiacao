# omie-sync-estoque: o deadline na fase do PO descartava o físico já lido (2026-10-05)

> Money-path (reposição). Edge `omie-sync-estoque` v1.4 → v1.5. Incidente: cron das 17:40Z,
> `net._http_response` id **104687**. Codex: desenho **não consultado** (exit 79, sensor de cota); adversarial de
> código consultado com o sensor liberado (3 pp) — ele derrubou a fase do PO em paralelo (ver abaixo).

## O incidente

O cron das 17:40Z respondeu HTTP 500 — `PesquisarPedCompra: deadline do run atingido antes da chamada`,
`duracao_ms` 73.348. O run lia o `ListarPosEstoque` inteiro (o físico) e SÓ DEPOIS fazia a fase do PO. O
throw dela é fatal por desenho ([Codex P1 2026-06-20]: erro de varredura → sync falha → a Sentinela vê o
congelado), então o físico que já estava em memória foi junto: `sku_estoque_atual` OBEN ficou sem regravar
de 15:42Z a 19:40Z e `reposicao_estoque_full` virou `error` às 17:41:16Z.

Anatomia medida de um run (deadline único de 75s, cron com `timeout_milliseconds := 90000`):

- `ListarPosEstoque` com `cExibeTodos:"S"`: o Omie devolve **50 por página** mesmo pedindo 500 → 75 páginas
  para 3.714 produtos, em série, ~45s. É o grosso do run.
- Fase do PO: `fetchEmTransitoKeys` + `PesquisarPedCompra` (~21 POs = 2 chamadas + 1,1s de pausa), ~3–4s.
- Cauda (upsert de 399 linhas, observação do PR0, marcadores): a observação do run de 19:40Z foi chamada aos
  53,0s e a resposta saiu aos 53,1s.
- Runs bons do dia: 49,5s / 49,5s / 53,1s — 66–71% do prazo. O de 17:40Z teve o físico em ~70–73s (~1,6×):
  a recusa veio com <2s restantes (`MIN_REQUEST_MS`), aos 73,0–73,3s.

## A medição (antes de mudar qualquer coisa)

**Frequência — 21 runs em `error` em 41 dias** (26/08 → 05/10). Fonte com histórico: os episódios do
`fin_alertas` tipo `data_health_sync_state_saude` com `reposicao_estoque_full/oben (falhou)` — "falhou" ⇔
`sync_state.status = 'error'`, conferido no corpo de prod do `_data_health_compute`.

| Slot | Runs no período | Falharam | Dias |
|---|---|---|---|
| 09:00Z (06:00 BRT, cron 31) | ~41 | **15** | 26/08; 09–13/09; 15–18/09; 21/09; 23/09; 25/09; 02–03/10 |
| :40 (intraday, cron 124) | ~246 | 6 episódios | 31/08 09:40Z; 08/09 13:40Z; 15/09 17:40Z; 16/09 tarde (vários runs seguidos); 22/09 15:40Z; 05/10 17:40Z |

O episódio do slot das 09:00Z abre no tick das 06:30 BRT e fecha no das 07:00 BRT, quando o intraday das 06:40
dá certo. Mas o motor diário (`gerar-pedidos-diario-oben`) roda às **09:15Z**, entre os dois: nesses 15 dias o
ciclo principal de compra calculou sobre o estoque da véspera (~13,5h).

**Linha do tempo × deadline:** o `MAX_DURACAO_MS` entrou no #2043 (merge 27/08; 1ª atestação da v1.1 no ledger
em 05/09). Um episódio antes do merge, um entre o merge e a atestação, **19 de 08/09 em diante**. Antes do
deadline, o run lento passava dos 90s do pg_net, perdia a resposta e terminava calado em background
(`complete`). O deadline transformou "lento" em "perdido", e o desenho fatal do PO fez da cauda o ponto de morte.

**Tipo do erro: só o de 05/10 é conhecido.** Os outros 20 são irrecuperáveis, e isso foi medido, não suposto:

- `net._http_response` retém ~6h (mais antiga às 17:25Z de 05/10);
- o analytics de logs do Lovable Cloud retém **~10 min** — o agente rodou `analytics_query` sobre `logs` por
  `source` (`function_edge_logs`, `function_logs`, `edge_logs`…), com controle positivo (outras edges
  apareciam, as invocações dessa não), e a mais antiga de todas as fontes era de ~10 min antes;
- `sync_state` guarda só a última linha; `fin_alertas` não guarda o texto do erro;
- a edge não gravava `acoes_execucoes`.

**Concentração no minuto :00.** No :00 outras edges batem na mesma conta Omie OBEN: `omie-analytics-sync`
`sync_inventory` 'vendas' (o mesmo `ListarPosEstoque`, sem `cExibeTodos`, a cada :00/:30), as continuações de
`omie-vendas-sync` (*/6) e `omie-financeiro` (*/10), e o `pedido-programado-enviar` (09:00Z seg–sáb). No :40 só
o `omie-financeiro`. Nenhuma outra edge invoca a `omie-sync-estoque`. A correlação é forte (15/41 × ~6/246); o
mecanismo (contenção no Omie) segue hipótese.

## O desenho

Candidatas pesadas: **A** — exceção na fase do PO vira pendente não confiável (coluna preservada, marcador do
pendente `error`) e o físico segue; **B1** — disparar a fase do PO em paralelo com o físico, logo no início;
**B2** — deadline 75→80s; **B3** — `ListarPosEstoque` só dos 399 habilitados via `lista_produtos`; **B5** — teto
do cron 90→150s; **B6** — tirar o cron 31 do :00; **C** — registrar cada run em `acoes_execucoes`.

No desenho o Codex não foi consultado: `scripts/codex-async.sh` saiu com **exit 79** (`SALDO_ALTO`, cota em 89%
contra o teto de 85%; janela reabre 09/10 19:30) sem gastar a chamada. Pela regra do money-path, o desenho foi
adiado para a `RÉGUA:` escrita e conferida aqui, e o PR ficou em DRAFT até o adversarial de código, que rodou com
`CODEX_ASYNC_TETO_SALDO=0` — a faixa acima de 85% é a reserva do money-path, segundo o próprio script.

**A segue rejeitada.** Ela grava físico fresco com pendente preservado: a NF recebida entre os runs conta duas
vezes (o físico já a soma, o pendente velho ainda conta o saldo daquele PO) e o motor sub-sugere aqueles SKUs por
≥1 ciclo. O botão "Sincronizar e recalcular" recalcularia sobre esse par (`edgeSyncOk` só olha `ok`). E a
cobertura exclusiva dela — falha do endpoint de PO fora do orçamento — tem frequência desconhecida.

**B1 entrou e saiu.** A 1ª versão do PR disparava a fase do PO no início, em paralelo com o físico, com o argumento
de que o par (físico, pendente) continuava "do MESMO run". O adversarial derrubou a premissa: mesmo run não é
mesmo instante. Com o PO lido nos primeiros ~4s e a página do SKU lida até ~75s depois, uma NF recebida no meio
entra no físico E segue no pendente — a mesma dupla contagem que rejeitou A, numa janela menor, e invisível. Na
ordem da v1.4 (físico, depois PO) a mesma corrida erra para o outro lado: a NF some dos dois números e o motor
sobre-sugere um item que o comprador acabou de receber, que é o erro que ele vê. A ordem é desenho, não
acidente — e ficou escrita no código e na guarda.

**Entrou (v1.5, `v1.5-prazo-80s-e-registro`):**

1. **B2** — 80s de deadline, folga da observação 10→5s: o corte absoluto da observação segue em 85s. Sozinho ele
   teria salvo o run do incidente (físico em ~73s + ~4s de PO < 80s), com ~2s de margem.
2. **C** — `comRegistro` (slug `reposicao.sync_estoque`, escritor único; o botão registra o composto
   `reposicao.sincronizar_recalcular`). Aberto antes do guard das credenciais e de qualquer chamada Omie. O
   sucesso grava `fase_fisico_ms`/`fase_po_ms`. A falha grava o texto do erro, e no físico ele ganha o sufixo
   `(pág N/M, Xms do run)` — sufixo porque o catch final testa `startsWith("AUTH_ERROR")`. Efeito colateral
   assumido: credencial ausente passa a gravar o marcador `error` (na v1.4 saía 500 sem marcador).
3. **Prazo do registro** — `registro-com-prazo.ts` adapta o `DbRegistro` com 2s por escrita (abrir, fechar),
   fail-open também contra a ESPERA. 85s + 2s ainda deixa folga até os 90s do pg_net.

## O adversarial do código (Codex, `gpt-6-astra` · max · 601s · 139.305 tokens · 3 pp)

Parecer cru, resumido (o Codex executou a fonte com Omie, banco e relógio simulados):

- **[P1] regressão** — o paralelo conta a mesma entrada como físico e pendente (PO 10 pendente aos 0–4s, NF aos
  10s, página do SKU aos 45s com físico 10 → grava 10 + 10, `ok:true`; a v1.4 gravou 10 + 0).
- **[P1] regressão** — o `comRegistro` aguarda o fechamento sem prazo, depois do corte de 85s: banco lento leva a
  resposta aos 91s (timeout no cron com o dado publicado) e, no erro, atrasa o marcador `error` da Sentinela.
- **[P1] preexistente** — `pendenteConfiavel=false` publica físico fresco com pendente preservado e responde
  `ok:true`: dupla contagem imediata, e o botão recalcula sobre ela.
- **[P1] preexistente** — físico truncado (o Omie declara N linhas, a paginação entrega menos) é publicado antes
  da checagem de completude; `varreduraTruncada` só suspende a inativação.
- **[P2] preexistente** — upsert parcialmente falho (`sincronizados > 0`, `erros_upsert > 0`) recebe marcadores
  `complete` sem `error_message`.
- **[P2]** — as guardas da 1ª versão não provavam o anunciado: passavam verdes com um upsert antes do await do PO
  e com um try/catch em volta do callback devolvendo `ok:true`; nenhum teste provava que o `comRegistro` relança.

Conferido sem achado: deadline compartilhado coerente; `comRegistro` relança o erro original; `AUTH_ERROR`
conserva o prefixo; métodos distintos na mesma app_key não esbarram nos limites do Omie (IP + app_key + método).

**Calibração.** Os dois P1 regressivos procedem e foram corrigidos (B1 revertida; prazo do registro). O P2 das
guardas procede: elas foram refeitas e falsificadas de novo. Os três preexistentes procedem pelo código, mas não
são desta entrega — estão abaixo, como pendência com evidência.

**Provas executadas.**

- `registro-com-prazo_test.ts` (Deno, 6 testes, sobre o `comRegistro` REAL): fechamento pendurado, ação que falha
  com o fechamento pendurado (o MESMO erro sobe — a prova que faltava), abertura pendurada, banco rápido com o
  timer limpo, rejeição tardia sem uncaught, mensagem do prazo. Falsificado numa cópia, com controle verde na
  mesma invocação, sob `LC_ALL=C` e `pt_BR.UTF-8`: sem prazo → 4 vermelhos; timer não limpo → 1; rejeição órfã →
  `Uncaught error`; `comRegistro` reembrulhando o erro → 1; mensagem sem a operação → 1. A 1ª rodada achou um
  buraco: sem o `clearTimeout` o teste do timer passava verde, porque o sanitizer de ops do Deno 2.9.2 não acusa
  `setTimeout` pendente. Agora um espião conta os timers vivos.
- `src/lib/reposicao/__tests__/sync-estoque-orcamento-edge.test.ts` (vitest, 10 testes, fonte sem comentários).
  Controle verde e 10/10 sabotagens vermelhas sob `LC_ALL=C` e `pt_BR.UTF-8`, cada uma no teste que a mira: PO
  disparado antes do laço, estoque acessado antes do PO, `.catch()` engolindo o erro do PO, catch devolvendo
  `ok:true` no callback, credencial antes do registro, registro sem prazo, prefixo no erro do físico, deadline
  85s, folga 10s, prazo do registro 4s. Limite declarado: um catch que devolva o próprio resumo escapa da guarda
  do `ok:true` — texto prova presença e ordem, não comportamento.

## Achados preexistentes do adversarial (não corrigidos aqui)

> **Corrigidos na v1.6 (2026-10-06):** C1 e C2 recusam publicar, C3 degrada para `partial` — medição, desenho com o
> Codex e provas em [sync-estoque-par-torto-tres-caminhos.md](sync-estoque-par-torto-tres-caminhos.md).

Três caminhos em que a edge responde `ok:true` sobre um par que o motor não deveria consumir. Nenhum é desta
entrega; os três pedem decisão de desenho (falhar, degradar ou só sinalizar):

1. **Pendente não confiável preservado** (`pendenteConfiavel=false`, "dado torto"): o físico sai fresco e o
   pendente velho fica — a dupla contagem que rejeitou A acontece hoje nesse caminho, e o botão recalcula.
2. **Físico truncado publicado**: `varreduraTruncada` é calculada depois do upsert e só segura a inativação.
3. **Upsert parcial com marcadores limpos**: `erros_upsert > 0` não vira `error_message` nem `ok:false`.

## Próximos passos — com o dado que cada um espera

- **B6 (tirar o cron 31 do :00, ex. `5 9 * * *`)** — o candidato mais barato para o slot que concentra 15 das 21
  falhas; migration de cron, deploy à parte. Decisão do founder.
- **B3 (`lista_produtos`)** — a margem estrutural, ~8–16 chamadas no lugar de 75. Precisa de comparação sombra,
  por causa do "não apareceu ⇒ inativo" e do guard de truncagem. Gatilho: o registro mostrar `fase_fisico_ms`
  perto dos 80s.
- **B5 (teto do cron 150s)** — fora da restrição "não passar dos 90s" desta entrega.
- **Os três preexistentes** acima — sessão própria, money-path, com Codex no desenho.

Quando medir é query, não recado:

```sql
-- runs por slot e desfecho, com o relógio do físico (dado novo da v1.5)
SELECT to_char(iniciado_em AT TIME ZONE 'UTC', 'HH24') AS hora_utc, status, count(*) AS runs,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (detalhes->>'fase_fisico_ms')::numeric) AS p50_fisico_ms,
       max((detalhes->>'fase_fisico_ms')::numeric) AS max_fisico_ms
FROM acoes_execucoes
WHERE acao = 'reposicao.sync_estoque'
GROUP BY 1, 2 ORDER BY 1, 2;
```

Antes da v1.5 a mesma pergunta só se responde por episódio: `fin_alertas`, `tipo =
'data_health_sync_state_saude'`, `mensagem ~ 'reposicao_estoque_full'`. Abertura às 06:30 BRT = slot das
09:00Z.

## Lições

- **Fase barata e fatal no FIM de um run com deadline único herda toda a lentidão das fases de antes.** A fase
  do PO custa 3–4s e morria por causa dos 45s do físico — e levava o físico junto. Mas a saída óbvia (movê-la
  para o começo, em paralelo) só vale se as duas leituras forem independentes NO TEMPO, e aqui não são.
- **"Mesmo run" não é "mesmo instante".** Duas leituras não atômicas da mesma realidade (estoque e PO) sempre
  podem ser separadas por um evento (a NF). A ORDEM das leituras decide a DIREÇÃO do erro: escolha a que erra
  para o lado visível e trave a ordem em guarda — paralelizar por desempenho inverteu a direção sem mudar nenhum
  contrato aparente.
- **Fail-open contra rejeição não é fail-open contra espera.** Um registro "que nunca derruba a ação" ainda pode
  segurá-la: `await` sem prazo no caminho crítico é dependência dura, com ou sem try/catch.
- **O sanitizer de ops do Deno 2.9 não acusa `setTimeout` pendente.** "Nenhum timer fica pendurado" se prova com
  espião, não com o sanitizer — e só a falsificação mostrou a diferença.
- **Introduzir deadline num run que termina calado em background troca lentidão invisível por falha visível.**
  É o certo (a morte fica legível), mas a taxa de falha "nasce" no deploy: 19 das 21 falhas vieram depois do
  #2043. Meça a distribuição de duração antes, e reveja o que o throw descarta.
- **Sync sem histórico próprio de runs não se audita depois do fato.** `net._http_response` (~6h) e os logs da
  edge no Lovable Cloud (~10 min) não são fonte de série. Edge com cron e clique registra no servidor
  (`_shared/registro-execucao.ts`) — é a convenção, e foi a falta dela que deixou 20 de 21 falhas sem tipo.

# sku-items: o recebimento só sai da fila com evidência de completude

> 2026-10-05. Fecha o P1 que o Codex deixou aberto no #2539 (§4b e §7 de
> [sku-items-consumo-redundante-no-ciclo.md](sku-items-consumo-redundante-no-ciclo.md)): a fila do
> `omie-sync-sku-items` era "tracking SEM NENHUMA linha em `sku_leadtime_history`", e uma linha
> gravada tirava o recebimento da fila para sempre. Regra que fica: **"tem linha" não é "está
> completo" — a fila precisa da medida do que faltou, gravada por quem gravou.**

## 1. A medição mudou o diagnóstico

O P1 descrevia a falha de UPSERT (2 SKUs, o 1º grava, o 2º falha). Medido por psql-ro:

| canal | medição | resultado |
|---|---|---|
| (i) falha de upsert | `fin_sync_log.results.erros > 0`, todo o histórico (2026-06-27 → hoje) | **0 de 1.287 runs** |
| (ii) processo morto entre upserts | órfã `running` reclassificada | **0** (os 58 `error` são REDUNDANT/rate-limit) |
| (iii) item sem `nIdProduto` na consulta | 75 trackings com `raw_data.itensRecebimento` (payload do step NFe) × linhas gravadas | **2 SKUs perdidos em 63 recebimentos processados** |

Os dois casos de (iii), ambos NF-e órfã (`omie_codigo_pedido` < 0), run com `erros=0` e motivo `ok_com_itens`:

- **EUROTECHNIKER, recebimento 12156129942** (t2 10/08): a consulta das 12:15 de 10/08 gravou 1 item; o
  payload de 13/08 tem 2. O PRD03703 (`nIdProduto` 12163673823) só aparece em `omie_products` em
  13/08 02:32 — o recebimento foi concluído em 12/08 (`cEtapa` 80) e o produto nasceu na conclusão.
  É o 1º recebimento do produto: **0 linhas de leadtime** em qualquer tracking.
- **SAYERLACK, recebimento 12184744816** (t2 17/09): a consulta das 20:16 de 17/09 gravou 2; o payload de
  20/09 tem 3 — o PRD00041 (produto antigo) foi ASSOCIADO depois. Ainda em `cEtapa` 40.

O item da Omie carrega a decisão de associação do recebimento: `cIgnorarItem`, `cAssociarExistente`,
`cAdicionarNovo`. Nos 290 itens dos payloads: 261 associados (com `nIdProduto`), **19 `cAdicionarNovo`
sem produto** e **10 `cIgnorarItem`** — todos na etapa 40 (em andamento); a etapa 80 tem 0 item sem
produto. Há recebimentos na etapa 40 desde março. O `if (!skuCodigoOmie) continue` pulava os 29 em
silêncio — os ignorados com razão, os 19 por engano.

⚠️ Fato × reconstrução: o payload do `raw_data` é o do step NFe (janela de 3 dias), não o da consulta do
sku-items. Ele pode ser mais VELHO (há trackings com linhas e payload "0 resolvidos") ou mais NOVO — os
dois casos acima, com `updated_at` posterior à consulta. A forma exata da resposta original (item sem
produto × item que entrou depois) é inferência; a NF-e vem do XML, então o mais provável é a associação.

## 2. As saídas pesadas

| saída | (i) upsert | (ii) morte | (iii) associação | custo |
|---|---|---|---|---|
| **B** — um upsert em lote por NF-e (tudo ou nada) | fecha | fecha | **inerte**: o item sem produto nem entra no lote | uma linha ruim bloqueia a NF-e inteira |
| **A3** — só grava quando TODOS os itens resolvem | fecha | fecha | fecha | recebimento que nunca conclui (há desde março) nunca grava nem o que já resolveu |
| **A** — pendência por ITEM no controle | fecha | fecha (write-ahead) | fecha | coluna nova + estado por recebimento |

A unidade da pendência é o **item** da lista, não o SKU: o item sem `nIdProduto` não tem SKU, e um
"conjunto esperado de SKUs" seria inerte justamente para o único mecanismo observado.

## 3. Codex no desenho — gpt-6-astra · max · 374s · 121.875 tokens: A com correções, sem P0

| achado do Codex | decisão |
|---|---|
| P1 — `k` se perde também quando a marcação final FALHA, sem morte do processo; um writer no código ≠ uma execução por vez | aceito — write-ahead (falhou ⇒ nada grava) + fechamento com CAS em `ultima_tentativa` |
| P1 — a reconsulta republica o leadtime que o recompute anulou (o writer não exigia proveniência do t1) | aceito — `lt_bruto`/`lt_faturamento` só com `t1_de_pedido && !t1_ambiguo` |
| P1 — estado por irmã: a dona do `k` sai da janela antes das irmãs; o destino do fallback troca entre runs | aceito — controle em TODAS as irmãs (por `nid_receb`, sem janela) e dono estável (menor t2, id) |
| P1 — `pedErr` pendente pode sobrescrever um total com subtotal | aceito — lookup por chave em cache, `.order("id")`, erro retém o SKU inteiro |
| discordância: duplicata não dobra a contagem, a view efetiva a ZERA ("concorda-ou-NULL") | aceito — medido: 7 pares em agosto, 5 em setembro, quase todos com t1 divergente |
| P2 — idade de irmã no sensor | resolvido pela replicação (as irmãs dividem o carimbo) |
| P2 — a garantia é a completude da ÚLTIMA lista, não a definitiva | aceito — limite registrado (§7) |
| P2 — a recuperação precisa de replay dirigido do caso fora da janela | aceito — §6 |
| P2 — `k` deve contar itens (grupo falho conta `n_itens_agregados`) | aceito |

Acréscimo meu, não pedido pelo Codex: a fila deixou de ser monotônica para o medido-completo (k=0 tira
da fila a irmã sem linha). Com o dono estável, reconsultar pela irmã sem linha nunca grava nada nela — a
regra antiga a deixaria como poison eterno.

## 4. O conserto (`v1.3-pendencia-por-item`)

- [`recebimento.ts`](../../supabase/functions/omie-sync-sku-items/recebimento.ts): `classificarItem`,
  `pendenteNaFila`, `donoDoRecebimento` e `gravarRecebimento` com o banco injetado — a edge passa o
  supabase, o teste passa um banco falso com o contrato do PostgREST. O bloco espelhado
  `sku-items-agregacao` mudou-se para cá VERBATIM, e os pinos do vitest o seguiram.
- Migration `20261005170000_sku_items_controle_itens_pendentes.sql`: coluna `integer` NULL **sem
  default** (um `DEFAULT 0` diria "medido completo" para as 144 linhas legadas), CHECK `>= 0`,
  postcondição A1–A6. Pré-voo contra a prod: cai exatamente no A1.
- Fila: `pendenteNaFila` — medido ? `k > 0` : sem linha (legado na regra antiga, sem rajada).
- Sensor `fila_parada_48h`: conta só recebimento SEM NENHUMA linha — a semântica de antes, quando o
  recebimento com linha nunca estava na fila. Os incompletos parados vão para
  `fila_incompleta_parada_48h`, que não pagina (achado do auto-adversarial: o diário das 07:00 consulta
  3–8 recebimentos e já bateu o guard; retentativa de item que talvez nunca seja associado não pode
  fabricar `error`).
- `results` ganha `fila_incompleta`, `fila_concluida_sem_linha`, `itens_aguardando_associacao`,
  `itens_ignorados`, `itens_sem_rota_pedido`, `itens_retidos_sku_sem_rota`, `recebimentos_incompletos`,
  `controle_fechamentos[_falhos|_preteridos]`. Nova regra de `error`: fechamento que falha em TODOS.

## 5. Falsificação — uma camada por vez, controle verde na mesma invocação, LC_ALL=C e pt_BR.UTF-8

Laço: para cada sabotagem, a suíte crua tem de passar; a sabotagem (substring exata, uma ocorrência) é
aplicada; a suíte tem de ficar VERMELHA no teste esperado (marcador ASCII); o git restaura.

| camada | sabotagens | resultado |
|---|---|---|
| Deno — `recebimento.ts` | fila ignora a pendência · aguardando fora de k · write-ahead que falha não segura os upserts · write-ahead sem o k conservador · fechamento com carimbo NOVO · SKU sem rota não contamina · erro de lookup cai no fallback · sem proveniência do t1 · sem lista zera k · controle só na eleita · dono = 1ª irmã · grupo falho conta 1 · ignorado vira pendência · sem cache de lookup | 14/14 vermelhas no teste certo |
| Deno — `adiamento.ts` | regra do fechamento morto · motivo esconde a pendência · sensor de página volta a contar o incompleto | 3/3 |
| vitest — borda do `index.ts` | controle lido sem a coluna · fila só "sem linha" · respondida tratada sem controle · fechamento sem CAS · irmãs ilegíveis não gritam · lookup sem ordem · sensor sem a exclusão · conjunto com-linha vazio | 8/8 — conferido à mão no V4: exatamente 1 teste falhou (o pino do CAS), 18 passaram |

**Três achados da própria falsificação:**

- **Relógio parado.** Com o `agora()` do banco falso fixo, fechar com um carimbo NOVO em vez do carimbo
  do write-ahead casava por coincidência — a sabotagem do CAS ficava verde. O relógio falso agora anda
  1 ms por leitura.
- **O alvo mente.** O 1º lote do vitest parou no CONTROLE: um pino novo ("a falha da consulta não toca a
  pendência") estava vermelho no código íntegro, porque o comentário do ramo citava `itens_pendentes`.
  Os pinos da borda passaram a medir o código sem comentários (`removerComentarios`). Sem o controle na
  mesma invocação, as sabotagens seguintes teriam "passado" contra uma suíte que já falhava.
- **O contador mente.** O laço contava "linhas com `×`" e deu 12 em TODA sabotagem do vitest: os
  testes PULADOS de outros describes têm `×` no próprio nome ("edge×front", "src × vendas"). O
  marcador seguiu válido (só existe nos nomes do describe do sku-items, nunca pulado), e a
  conferência manual do V4 mostrou 1 falha — mas número repetido em toda linha é sinal de que o
  instrumento está medindo outra coisa.

## 6. Ordem de deploy e recuperação do resíduo

1. **Migration** `20261005170000` — antes de tudo. A edge v1.3 lê a coluna; sem ela, a leitura do
   controle falha fechada e todo run vira `error`. A edge velha não a lê nem escreve: aplicar antes é
   inócuo. Validação (psql-ro):
   ```sql
   select column_name, data_type, column_default, is_nullable from information_schema.columns
   where table_schema='public' and table_name='sku_items_sync_controle' and column_name='itens_pendentes';
   select convalidated from pg_constraint where conname='sku_items_sync_controle_itens_pendentes_check';
   ```
   Esperado: `integer`, default nulo, `YES`; `true`.
2. **Deploy da edge** `omie-sync-sku-items` (`pendencias:deploy` decide). Prova passiva: o eco
   `v1.3-pendencia-por-item` no `net._http_response` do cron 186 (:35) e o ledger no run das 07:00.
3. **Reabrir o resíduo** (escrita pontual; os dois recebimentos têm UMA irmã — o dono é ela, a
   reconsulta grava sob a mesma chave):
   ```sql
   begin;
   update public.sku_items_sync_controle
   set itens_pendentes = 1,
       motivo = 'reaberto 2026-10-05: item resolvido ausente do histórico (resíduo medido)'
   where tracking_id in ('1ff785fc-939a-423e-b4b9-8d9bcf9e2421', '2ddf3981-a3c7-44f7-b46e-8dbba9a27ad7')
     and itens_pendentes is null;
   do $post$ begin
     if (select count(*) from public.sku_items_sync_controle
         where tracking_id in ('1ff785fc-939a-423e-b4b9-8d9bcf9e2421', '2ddf3981-a3c7-44f7-b46e-8dbba9a27ad7')
           and itens_pendentes >= 1) <> 2 then
       raise exception 'reabertura não pegou nos 2 trackings';
     end if;
   end $post$;
   commit;
   ```
   A SAYERLACK (t2 17/09) está na janela de 30 dias até 17/10: o diário das 07:00 a reconsulta. A
   EUROTECHNIKER (t2 10/08) está fora: run dirigido, 1 consulta Omie (dos 2 trackings do fornecedor em
   60 dias, só o reaberto fica pendente) — o comando do próprio job 186 com o body trocado:
   ```sql
   do $run$
   declare v_cmd text; v_novo text;
   begin
     select command into v_cmd from cron.job where jobid = 186;
     v_novo := replace(v_cmd, '''dias'', 3)', '''dias'', 60, ''fornecedor_codigo_omie'', 8689689587)');
     if v_cmd is null or v_novo = v_cmd then raise exception 'o molde do job 186 mudou — nada executado'; end if;
     execute v_novo;
   end $run$;
   ```
4. **Revalidação** (psql-ro):
   ```sql
   -- os 2 SKUs do resíduo ganharam linha
   select sku_codigo_omie, tracking_id from sku_leadtime_history
   where sku_codigo_omie in (12163673823, 8689733149);
   -- a pendência é medida e a fila não fabrica página
   select to_char(started_at at time zone 'UTC','MM-DD HH24:MI') ini, status,
          results->>'fila_incompleta' incompleta, results->>'recebimentos_incompletos' incompletos,
          results->>'itens_aguardando_associacao' aguardando, results->>'fila_parada_48h' parada,
          results->>'fila_incompleta_parada_48h' incompleta_parada
   from fin_sync_log where action='sync_sku_items' and started_at > now() - interval '72 hours' order by 1;
   -- distribuição da medida no controle
   select itens_pendentes is null as legado, itens_pendentes > 0 as pendente, count(*)
   from sku_items_sync_controle group by 1, 2;
   ```

## 7. O que fica descoberto

- **Ignorado que depois é associado.** `cIgnorarItem`="S" sem produto é terminal; se o recebimento
  mudar de ideia, a lista nova só é lida se o recebimento ainda estiver pendente por outro motivo.
- **Recebimento que nunca conclui.** Item `cAdicionarNovo` numa etapa 40 eterna é reconsultado no
  backoff (6h/24h/72h) até sair da janela de 30 dias — ~12 consultas por recebimento. O custo aparece em
  `recebimentos_incompletos` e `fila_incompleta_parada_48h`.
- **Corrida de DADOS entre runs sobrepostos.** O CAS protege a pendência; os upserts de leadtime seguem
  last-writer-wins. Só há sobreposição com invocação manual (os crons são :35 e 07:00), e a Omie
  recusa a chamada idêntica por ~60s (REDUNDANT).
- **Legado com várias irmãs.** A 1ª reconsulta de um recebimento legado pode gravar o fallback sob o
  dono estável, diferente da eleita antiga — duplicata (NF-e, SKU) que a view zera. A regra antiga
  fazia o mesmo (a irmã sem linha virava eleita); o dono estável só não a repete.
- **Pré-existentes vistos de passagem:** (a) o recompute não propaga t4/`lt_logistica` para a NF-e
  órfã — o passo 2 é condicionado à proveniência do t1 —, então o `lt_logistica` da órfã morre NULL;
  (b) a view efetiva zera o split legítimo (o mesmo SKU para dois pedidos na mesma NF-e: t1 diverge).

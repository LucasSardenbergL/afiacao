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

## 4. O conserto (`v1.4-pendencia-por-item`)

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

1. **Migration** `20261005170000` — antes de tudo. A edge v1.4 lê a coluna; sem ela, a leitura do
   controle falha fechada e todo run vira `error`. A edge velha não a lê nem escreve: aplicar antes é
   inócuo. Validação (psql-ro):
   ```sql
   select column_name, data_type, column_default, is_nullable from information_schema.columns
   where table_schema='public' and table_name='sku_items_sync_controle' and column_name='itens_pendentes';
   select convalidated from pg_constraint where conname='sku_items_sync_controle_itens_pendentes_check';
   ```
   Esperado: `integer`, default nulo, `YES`; `true`.
2. **Deploy da edge** `omie-sync-sku-items` (`pendencias:deploy` decide). Prova passiva: o eco
   `v1.4-pendencia-por-item` no `net._http_response` do cron 186 (:35) e o ledger no run das 07:00.
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

Os três primeiros vieram da revisão adversarial por subagente (Fable, 2026-10-05: 0 P0/P1, 5 P2; os
outros dois — a mensagem da A1 citando a v1.3 e um pino do teste de réplica que a regra legada também
satisfazia — foram consertados no PR). Números conferidos por psql-ro no mesmo dia.

- **Prospectivo por desenho.** A pendência só é medida em consulta feita DEPOIS do deploy: o legado com
  linha e `itens_pendentes` nulo segue a regra antiga e não volta à fila (janela de 30 dias: 45
  trackings com linha; os 17 sem linha são os CT-e que o #2798 tira — a fila nasce vazia). O passado
  coberto é o da medição do §1 (63 recebimentos processados, 2 SKUs perdidos), reaberto um a um no §6.3.
  Semear `itens_pendentes = 1` em massa fica de fora: reconsultaria recebimentos legados com várias
  irmãs, cujo fallback iria para o dono estável ≠ a eleita antiga — a duplicata que a view zera (bullet
  "Legado com várias irmãs"). Trocaria dado medido completo por perda de precisão. O que a medição não
  alcança: item que entrou na Omie DEPOIS do payload do `raw_data` (§1, fato × reconstrução).
- **As datas do dono valem para o recebimento inteiro.** t2/t3/t4 de toda linha vêm do dono (menor t2
  entre TODAS as irmãs), inclusive a do item roteado ao tracking do seu pedido. Para o recebimento novo
  é a eleita de antes (0 tentativas, t2 ASC — o diário das 07:00 já fazia assim), e é estável entre
  runs; o preço é que, se as irmãs divergem nas datas, vale a mais antiga. OBEN: 80 recebimentos com >1
  irmã — 13 com t2 distinto, 17 com t4 distinto, 9 com chave de NF-e distinta sob o mesmo `nid_receb` —
  e, na janela de 30 dias, 0 de 38 com o dono fora da janela (exposição 0). A fonte certa das datas é o
  cabeçalho da própria consulta Omie, fora do escopo. Linha de base para revalidar (linha com data ≠ a
  do próprio tracking; hoje 16 de 4.316 em t2 e 215 em t4 — o t4 deriva também quando o tracking é
  atualizado depois da gravação):
  ```sql
  select count(*) linhas,
    count(*) filter (where h.t2_data_faturamento is distinct from t.t2_data_faturamento) t2_alheio,
    count(*) filter (where h.t4_data_recebimento is distinct from t.t4_data_recebimento) t4_alheio
  from sku_leadtime_history h join purchase_orders_tracking t on t.id = h.tracking_id;
  ```
- **Irmã nunca medida num recebimento com linha não pagina.** `fila_parada_48h` exclui o recebimento
  que tem linha em QUALQUER irmã; uma irmã sem linha e sem controle (k nulo) nele — a regra antiga a
  contava — só aparece em `fila_incompleta_parada_48h`. Converge na 1ª consulta (o controle vai para
  todas as irmãs). Hoje: 5 casos no histórico todo (fora de CT-e), 0 na janela de 30 dias.
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

## 8. No ar (2026-10-06, pela sessão, com OK do founder)

| camada | como | prova (por fora) |
|---|---|---|
| migration `20261005170000` | MCP `query_database`, no envelope. Primeiro o ensaio (`COMMIT` → `RAISE 'ENSAIO_OK'`: rollback garantido); depois a aplicação com uma **trava de transcrição** na própria transação — a SQL passa pela mão da sessão, então o banco exige CHECK, atributos da coluna e md5 dos dois comentários IGUAIS aos do PG17 local com o arquivo aplicado verbatim | psql-ro: prod intacta depois do ensaio; depois do commit, `integer`/sem default/`YES`, CHECK `convalidated`, 4/4 fatos de catálogo iguais ao local, 144/144 legado `NULL` |
| edge `omie-sync-sku-items` | pacote `b16267740b7e` (`origin/main@69e8d4c23`) → `send_message`; o agente conferiu 10/10 hashes antes do deploy | eco do run dirigido: `net._http_response` 105052, HTTP 200, `v1.4-pendencia-por-item`; `pendencias:deploy` **exit 0**, 62/62, `CONFERE` |
| resíduo (§6.3) | UPDATE dos 2 trackings (`k=1`, postcondição) → run dirigido da EUROTECHNIKER (job 186 com `dias` 60 + fornecedor) | run 01:34:03 `complete`: 1 consulta, 1 fechamento, 0 falho, 0 página. PRD03703 ganhou linha no dono — bruto e faturamento `NULL` (t1 de fallback, NF-e órfã), logística 2 d.u. — e o controle fechou em `k=0`. SAYERLACK segue `k=1`, à espera do diário das 07:00 UTC |

**O sensor de edição do Lovable deu `EDICAO_DETECTADA` (exit 1), e a edição era a esperada.** O eixo do
`edit_id` acusa qualquer edição da rodada; o `get_diff` da mensagem mostra a edição inteira:
`src/integrations/supabase/types.ts` +3 (`itens_pendentes` em Row/Insert/Update) — a regeneração que a
coluna nova provoca, no mesmo arquivo que o eixo dos commits tolera (2 commits do bot, 0 fora de
`types.ts`). Não reverter: reverter tiraria dos tipos uma coluna que existe. Deploy logo depois de
migration de schema dá esse falso positivo; o desempate é o `get_diff` por `message_id`.

**Revalidado em 2026-10-07 01:30 UTC (§6.4, psql-ro).** O diário das 07:00 de 06/10 consultou a
SAYERLACK: o PRD00041 (`8689733149`) ganhou linha e o controle fechou em `k=0`. A logística dessa linha
é `NULL`, e está certo: o recebimento segue na etapa 40, sem t4 (ausente ≠ zero). Os 2 SKUs do resíduo
estão recuperados. Nas 26 h seguintes ao deploy foram 15 de 15 runs `complete`, com 0 página
(`fila_parada_48h` = 0) e 0 fechamento falho; os CT-e saíram antes da consulta (18 no diário).

**O sinal de uso veio sozinho no run das 00:35 de 07/10.** Foram 2 recebimentos consultados, ambos da
Renner Sayerlack com NF-e de 06/10, e os 2 ficaram incompletos. Num deles, 31 de 31 grupos foram gravados
e 4 itens ficaram esperando associação; no outro, 1 item. São 5 SKUs que a v1.3 teria perdido em
silêncio, da mesma classe do resíduo. Agora eles ficam com `k>0`, replicado nas irmãs, e voltam no
backoff até a Omie associar os produtos. A distribuição do controle ficou em 142 legado `NULL`, 3 com
`k=0` e 3 com `k>0`.

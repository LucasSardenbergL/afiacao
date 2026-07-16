# Leadtime de compra — duplicação por NFe multi-pedido + retenção do `nIdReceb`

> Spec de design · 2026-07-16 · money-path (leadtime → reposição/compras)
> Origem: gap de cobertura registrado no PR #1338 (que o mede mas não o corrige).
> 2ª opinião: ritual `/codex` conduzido (parecer incorporado nas seções "Riscos").

## Resumo

O diagnóstico herdado do #1338 está **invertido**. Ele supõe que o `nIdReceb` nunca
chega às linhas com pedido casado e que a correção passa por obtê-lo da Omie. A
investigação mostra o contrário: **o sinal chega e é destruído**. E, ao investigar,
apareceu um problema maior e independente: o histórico de leadtime é majoritariamente
**duplicado**, com uma fração relevante de valores **conflitantes** para o mesmo item.

Dois PRs, nesta ordem obrigatória:

1. **PR-1 — duplicação + proveniência** (migration + edge + limpeza). Seguro isoladamente.
2. **PR-2 — retenção do sinal** (migration + edges). Depende do PR-1.

A ordem não é estética: **o PR-2 sozinho amplifica o problema que o PR-1 corrige**
(hoje a duplicação é contida acidentalmente pela escassez do sinal).

## O que foi refutado

O comentário em `omie-sync-sku-items` e o bloco "(c)" do registry
(`.claude/skills/diagnose-supabase-sync/references/sync-registry.md`) afirmam:

> "só as órfãs trazem o recebimento (…) uma mesma chave de NFe não aparece nos dois
> papéis (…) essas NFes nunca viram leadtime, e não se resolvem sozinhas."

Nenhuma das três afirmações se sustenta:

- **`ConsultarRecebimento` aceita busca por chave de NFe** (`cChaveNFe`), e a rotina
  `backfillRawData()` de `omie-sync-nfes-recebidas` **já faz exatamente isso**, a cada
  rodada do cron. Não há nada a construir para "obter o `nIdReceb`".
- As linhas com pedido **recebem sim** o payload de recebimento — e a maioria delas
  **já gerou leadtime no passado**, o que só é possível tendo tido o `nIdReceb`.
- O `0 mistas` que sustenta a premissa é **artefato de sobrescrita**, não uma
  propriedade estrutural dos dados.

Ambos os textos devem ser corrigidos como parte do PR-2 (ver "Resíduo").

## Causa raiz 1 — o sinal é destruído (PR-2)

`purchase_orders_tracking.raw_data` é um jsonb **multi-writer** disputado por dois syncs:

| Ordem no cron | Edge | O que grava em `raw_data` |
|---|---|---|
| 1 | `omie-sync-pedidos-compra` | payload do **PEDIDO** (sem `nIdReceb`) |
| 2 | `omie-sync-nfes-recebidas` | payload do **RECEBIMENTO** (com `nIdReceb`) |
| 4 | `omie-sync-sku-items` | — (só lê `raw_data.cabec.nIdReceb`) |

O escritor 1 tem um `PRESERVE_FIELDS` (denylist de campos de outros syncs) — e
**`raw_data` não está nele**. Resultado: todo ciclo apaga o `nIdReceb` que o ciclo
anterior resolveu. O backfill do escritor 2 então repara o mesmo dano indefinidamente,
consegue reparar apenas uma fração por rodada (guard de timeout), e as linhas não
reparadas a tempo não têm sinal quando o escritor 3 roda.

É a armadilha que o CLAUDE.md já documenta, materializada:

> "Sinal money-path **nunca** em coluna jsonb multi-writer (upsert destrutivo) →
> coluna dedicada + 1 writer."

**Dano.** O leadtime não se perde (quem foi reparado a tempo gerou histórico), mas:
o orçamento de rate-limit da Omie é consumido reparando linhas que **já não precisam**;
as linhas que precisam ficam por inanição; a função SQL `reprocessar_sku_items_via_raw_data`
(que lê `raw_data->'itensRecebimento'`) fica aleijada nas linhas sobrescritas; e o
leadtime de toda NFe nova depende de vencer uma corrida.

**Evidência decisiva** (medida em produção; números fora do repo por ser público):
o contador `nfes_identificadas_para_backfill` do log permanece **estável por dias**,
apesar de reparos bem-sucedidos a cada rodada. Trabalho cumulativo que não acumula é a
assinatura de trabalho sendo desfeito. O Codex verificou a aritmética (rodadas ×
reparos por rodada ≫ backlog) e não encontrou explicação alternativa melhor.

## Causa raiz 2 — a duplicação (PR-1)

Uma mesma chave de NFe pode cobrir **vários pedidos** (uma fração relevante das chaves;
o pior caso observado tem mais de uma dezena de linhas irmãs). Cada pedido tem sua
própria linha em `purchase_orders_tracking`, todas com a **mesma** `nfe_chave_acesso`.

O `omie-sync-sku-items` grava:

```ts
tracking_id: nfeRaw.id,   // ← a linha que FEZ a consulta
```

Mas resolve o `t1` a partir de outra linha — o pedido real do item, achado via
`numero_contrato_fornecedor == nNumPedCompra`. Ou seja, **`t1` e `tracking_id` vêm de
linhas diferentes**. Quando duas irmãs têm o sinal, ambas consultam o mesmo recebimento,
recebem os **mesmos itens** e gravam tudo sob `tracking_id` distintos:

- cada item é contado uma vez **por irmã** → histórico inflado;
- o `t4` vem de `nfeRaw` (a irmã), não do recebimento → o **mesmo item** recebe
  leadtimes **diferentes** conforme qual irmã o gerou → dado conflitante no money-path.

A maior parte do histórico atual é duplicata, e uma fração significativa dos grupos
duplicados **diverge** no `lt_bruto`. Isso alimenta o motor de reposição hoje.

> ⚠️ **Por que a ordem importa.** A duplicação é limitada hoje pela escassez do
> `nIdReceb`: poucas irmãs têm o sinal simultaneamente. Persistir o sinal (PR-2) **sem**
> corrigir a atribuição (PR-1) faz **todas** as irmãs gerarem leadtime → duplicação
> máxima. O PR-2 isolado piora o money-path.

## PR-1 — mata a duplicação e o conflito

`omie-sync-sku-items` + **migration** (proveniência) + limpeza do histórico. Não depende
do PR-2.

### Por que precisa de migration

`sku_leadtime_history` **não tem coluna de proveniência**: não registra de qual NFe ou de
qual recebimento veio cada linha. Sua unicidade é `(tracking_id, sku_codigo_omie)`.

Isso torna insuficiente o fix ingênuo de "só trocar o `tracking_id` para o pedido": com
`tracking_id` = pedido, a unicidade passa a significar *"um leadtime por (pedido, SKU)"* —
e **entregas parciais colidem**. Um pedido cujo mesmo SKU chega em duas NFes teria a
segunda entrega **sobrescrevendo silenciosamente** a primeira (ocorre hoje numa fração
pequena mas não-nula dos grupos; pior caso observado: três entregas).

Trocar duplicação por perda silenciosa é um mau negócio em money-path: **duplicata infla,
perda apaga**. Daí a proveniência não ser opcional.

| Mudança | Efeito |
|---|---|
| **Migration**: `sku_leadtime_history.nid_receb bigint` + unicidade `(tracking_id, sku_codigo_omie, nid_receb)` | proveniência: cada linha sabe de qual recebimento veio. Irmãs → mesmo `nid_receb` → **deduplicam**; entregas parciais → `nid_receb` distintos → **coexistem** |
| `tracking_id` ← o pedido **do item** (`pedidoMatch.id`), não a linha que consultou | acaba a atribuição cruzada (hoje `t1` vem de uma linha e `tracking_id` de outra) |
| `t4` ← do **payload do recebimento** (`dRec`/`hRec`, já em `detalhe`), não de `nfeRaw` | mata o conflito: o recebimento é autoritativo, a irmã não. Sem consulta extra à Omie |
| match de contrato **único** (hoje `.limit(1)` sem `.order()`) | um punhado de contratos é ambíguo e o `t1` sai **não-determinístico**. Ambíguo ⇒ trata como sem match |
| deduplicar por recebimento **antes** de consultar | 1 consulta por NFe em vez de 1 por irmã — reduz pressão no guard de 50s |

**Fallback preservado.** Sem `pedidoMatch`, mantém-se `tracking_id: nfeRaw.id` (o
comportamento atual). Corrigir o `t1` fabricado nesse caminho é o **PR-3**.

### Limpeza do histórico

Corrigir o código não limpa o passado; a reposição seguiria lendo histórico inflado. As
linhas existentes classificam-se em três grupos, distinguíveis por SQL puro (o `t1`
gravado revela a qual pedido o item pertence de verdade):

| Classe | Critério | Ação |
|---|---|---|
| **A) correta** | `h.t1` = `t1` do próprio tracking | preservar |
| **B) fallback** | `h.t1` = `h.t2` (pedido não resolveu) | preservar — é o PR-3, não duplicata |
| **C) má-atribuição** | `h.t1` ≠ `t1` do tracking **e** ≠ `h.t2` | **DELETE** se a linha correta já existir; **UPDATE** (reatribuir) se não |

O passo do `UPDATE` é **obrigatório**: parte das linhas da classe C existe *apenas* sob o
tracking errado. O leadtime delas é válido (o `t1` é o do pedido real) — apagá-las seria
perda de dado. O destino da reatribuição foi verificado como **único e determinístico
para todas elas** (casamento por `fornecedor` + `t1`; zero sem destino, zero ambíguo).

`reprocessar_sku_items_via_raw_data` **não serve** para reconstruir (lê o `raw_data`
disputado — ver "Resíduo").

### Riscos (PR-1)

- **Limpeza destrutiva**: `DELETE`/`UPDATE` em histórico money-path. Mitigação:
  `prove-sql-money-path` no PG17 **com falsificação**; exigir idempotência; e provar que
  a contagem da classe A **não muda** (o teste que pega um `DELETE` largo demais).
- **Ordem interna**: reatribuir (UPDATE) **antes** de deletar violaria a unicidade nova.
  Deletar primeiro, reatribuir depois — e provar a ordem no PG17.
- **Perda de recall**: itens cujo `pedidoMatch` não resolve continuam sob `nfeRaw.id`.
  É o comportamento de hoje, não uma regressão. Precisão > recall.
- **Unicidade com `NULL`**: no Postgres, `NULL`s são distintos numa `UNIQUE` — linhas
  antigas sem `nid_receb` **não** deduplicam entre si. Por isso a limpeza vem **antes** da
  nova constraint, não depois.
- **Codex**: "só marque como concluído depois de todos os itens persistidos"; "o upsert
  pode deixar SKUs antigos que sumiram do recebimento". Registrado, fora de escopo.

## PR-2 — retenção do sinal

| Camada | Mudança |
|---|---|
| Migration | `purchase_orders_tracking.nid_receb bigint` (nullable, sem default) + índice parcial `(empresa, id) WHERE nfe_chave_acesso IS NOT NULL AND nid_receb IS NULL` |
| `omie-sync-pedidos-compra` | `PRESERVE_FIELDS += nid_receb` (nunca toca o sinal) |
| `omie-sync-nfes-recebidas` | **writer único** do sinal: grava `nid_receb`; filtro do backfill vai de "puxa tudo e filtra em memória" para `.is('nid_receb', null)` **no banco** |
| `omie-sync-sku-items` | lê `nid_receb` da coluna, com fallback de leitura ao jsonb durante a transição |
| Backfill barato | popular `nid_receb` a partir do `raw_data` das linhas que **já** têm payload de recebimento — **sem** chamar a Omie |

**Tipo.** `bigint` no Postgres; `number` no Deno é seguro — os IDs reais estão ordens de
grandeza abaixo de `Number.MAX_SAFE_INTEGER` (verificado). O Codex levantou o risco de
precisão; ele não se materializa nesta faixa, mas a coluna fica `bigint` de qualquer forma.

**Ordem de deploy (obrigatória): migration → edges.** Edge antes da migration quebra por
coluna inexistente (`.is('nid_receb', null)` e o `SELECT` explícito falham). A migration
sozinha é inerte para as edges antigas (coluna nullable ignorada).

**Efeito esperado.** O backfill converge: resolve uma vez, fica resolvido. Drena o backlog
em ~1–2 dias e depois cai para o fluxo de NFes novas. **O fix é net-negativo em rate-limit**
— remove consultas desperdiçadas em vez de adicionar. Isso responde à preocupação de
orçamento do brief: não há consulta nova a acomodar.

### Riscos (PR-2)

- **Avalanche no escritor 3** (principal alerta do Codex): *não se materializa*. O
  `omie-sync-sku-items` filtra `pendentes = nfes.filter(n => !existingTrackingIds.has(n.id))`
  — só inspeciona NFes **sem** leadtime. As linhas que já geraram histórico não voltam à
  fila quando ganham `nid_receb`. A fila ativa permanece pequena. **Verificar em produção
  na primeira rodada pós-deploy** (`fila_pendente`, `interrompido_por_timeout`).
- **`raw_data` segue multi-writer.** Dívida aceita conscientemente: o **sinal** money-path
  sai do jsonb, que é o que o CLAUDE.md exige. O resíduo é a função de reprocesso — tratada
  em "Resíduo". O Codex recomenda `pedido_raw_data`/`recebimento_raw_data` separados: fora
  de escopo, registrado.
- **`PRESERVE_FIELDS` é denylist.** O Codex: *"o próximo campo crítico novo nasce
  desprotegido"* — precisamente o que causou este incidente. Trocar por allowlist é
  mudança de arquitetura; registrado, fora de escopo.
- **Compare-and-set** (Codex): gravar `nid_receb` só se a `nfe_chave_acesso` ainda for a
  usada na consulta; nunca substituir silenciosamente um `nid_receb` não-nulo por outro
  (divergência ⇒ erro, não sobrescrita).

## Fora de escopo (registrados, não abandonados)

- **PR-3 — `t1` fabricado.** `t1 = pedidoMatch?.t1_data_pedido ?? nfeRaw.t2_data_faturamento`
  fabrica `lt_faturamento = 0` quando o pedido não resolve, violando "ausente ≠ zero" do
  CLAUDE.md. Enviesa a média de faturamento **para baixo** → a reposição acredita que o
  fornecedor fatura mais rápido do que fatura → compra tarde. Correto: `null`. Adiado por
  decisão do founder (degradar reduz recall e merece decisão de negócio própria).
- **Aposentar `reprocessar_sku_items_via_raw_data`** — ver "Resíduo".
- **Separar os payloads de `raw_data`** e trocar `PRESERVE_FIELDS` por allowlist.

## Resíduo durável

1. **Corrigir o registry** (`sync-registry.md`, bloco "GOTCHA sync_sku_items" item (c)) e o
   comentário em `omie-sync-sku-items`: ambos codificam a hipótese refutada. Enquanto
   existirem, o próximo agente reconstrói o diagnóstico errado — foi o que este trabalho
   quase fez.
2. **Registrar a nova assinatura de incidente**: *"contador de backlog estável apesar de
   progresso por rodada = trabalho sendo desfeito por escritor concorrente"*. É genérica e
   reusável para qualquer fila que não drena.
3. **`reprocessar_sku_items_via_raw_data`**: reescrever para ler a coluna dedicada, ou
   aposentar. Hoje é uma roleta de último-escritor — a mesma execução em momentos
   diferentes produz coberturas diferentes.

## Prova (antes de entregar)

- **PR-1**: a lógica de atribuição é TypeScript → teste unitário do mapeamento (irmãs →
  mesma linha deduplicada; entrega parcial → linhas que **coexistem**; `t4` do recebimento;
  contrato ambíguo ⇒ sem match). A migration e a limpeza são escrita SQL money-path →
  `prove-sql-money-path` no PG17 **com falsificação** (sabotar e exigir vermelho).
  Asserts mínimos da limpeza: (a) a contagem da classe **A não muda**; (b) a classe **B
  não é tocada**; (c) toda linha da classe C ou tem par correto preservado ou foi
  reatribuída — **nenhuma some**; (d) rodar duas vezes = mesmo resultado (idempotência);
  (e) a nova `UNIQUE` passa a valer **depois** da limpeza, não antes.
- **PR-2**: migration trivial (`ADD COLUMN` nullable), mas o backfill barato é SQL de
  escrita → PG17. Verificar pós-apply em produção via `psql-ro` (o backlog deve **cair**,
  não ficar estável — é o teste de que a tese estava certa).

## Sanitização (repo público)

Nenhuma contagem de produção, proporção precisa, UUID, chave de NFe ou nome de fornecedor
nesta spec, nos commits ou nos PRs — as medidas ficam na sessão. Descrever sempre o
**mecanismo** (lógica, público-safe), não a **medida**. Mesmo cuidado que exigiu
sanitização no #1338.

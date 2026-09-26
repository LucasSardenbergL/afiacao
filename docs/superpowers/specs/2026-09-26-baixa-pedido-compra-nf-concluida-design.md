# Baixa do pedido de compra no Omie quando a NF é concluída (Oben × Sayerlack) — design (proposta)

> Money-path (reposição/compras): baixar PO muda o "a caminho" do motor. Ver `docs/agent/reposicao.md`,
> `docs/agent/money-path.md` e a medição `docs/superpowers/specs/2026-08-13-reposicao-onorder-po-recebida-medicao.md`.
> **Status (2026-09-26): proposta, nada implementado; decisões D1/D2 tomadas (§8).** Antes de qualquer escrita no
> Omie faltam os fatos da §4. Escrito numa sessão de nuvem **sem `psql-ro`, sem Codex e sem acesso à doc do Omie**
> (domínio bloqueado pela política de rede) — por isso o ritual `/codex` continua obrigatório antes da Fase 1.

## 1. Pedido do founder

NFs da Oben concluídas no Omie (Recebimento de NF-e) deixam o pedido de compra correspondente **aberto**. O elo:
nos dados adicionais da NF-e vem `Pedido: 2128787` (nº do pedido Sayerlack) e o nosso PO carrega o mesmo número
em **Número do contrato**. Quer: (a) toda NF concluída no Omie baixar o(s) PO(s); (b) no futuro, a conferência no
app (descarga do caminhão) concluir a NF no Omie **e** baixar o(s) PO(s).

## 2. O que já existe (lido no código em 2026-09-26)

**O elo descrito pelo founder já está montado — por um campo mais preciso que os dados adicionais.**

- O disparo grava o protocolo do portal Sayerlack em `cContrato` ("Número do contrato") do PO:
  `supabase/functions/disparar-pedidos-aprovados/index.ts:1081`, `:1124-1126`, `:1186`. Demais fornecedores
  recebem o número interno `AFI<yymmdd><id>` — para eles o elo só existe se o fornecedor ecoar esse número no XML.
- O espelho copia `cContrato` para `purchase_orders_tracking.numero_contrato_fornecedor`
  (`supabase/functions/omie-sync-pedidos-compra/index.ts:553`).
- `omie-sync-nfes-recebidas` casa cada NF com PO pelo **nº de pedido por item** do XML (`xPed`, que o Omie expõe
  como `itensRecebimento[].itensInfoAdic.nNumPedCompra`, `index.ts:303`) contra `numero_contrato_fornecedor`
  (`index.ts:331`), e grava `t4_data_recebimento` quando `cRecebido=S`. Por item é melhor que o texto
  `Pedido: NNN` do `infCpl`: a nota consolidada é a regra (94% das POs-alvo dividem nota — spec 2026-08-13 §8) e
  cada item diz a qual pedido pertence. **Nada no repo lê `infCpl`**; ele só vale como fallback se a medição M5
  (§10) mostrar NF Sayerlack órfã em volume.
- ⚠️ O comentário de cabeçalho (`omie-sync-nfes-recebidas/index.ts:15`) diz que casa por `numero_pedido`; o
  código casa por contrato. (Não corrigido aqui: mexer na fonte da edge move o fingerprint e cria deploy pendente
  por um comentário — corrigir junto da próxima mudança real nessa edge.)

**O que falta é a escrita.** Nenhuma edge altera PO no Omie: o único método de escrita em
`/produtos/pedidocompra/` usado no repo é `IncluirPedCompra`. O `omie-webhook` já recebe
`CompraProduto.Encerrada`, `NotaEntrada.Concluida` e `RecebimentoProduto.Concluido`, mas os três são `TODO`
(`supabase/functions/omie-webhook/index.ts:144-159`) — só persistem em `omie_webhook_events`.

**A conferência no app não conclui NF no Omie hoje.** O ramo de escrita de `omie-nfe-recebimento`
(`AlterarRecebimento` → `AlterarEtapaRecebimento(40)` → `ConcluirRecebimento`) é inalcançável pela tela:
`src/pages/RecebimentoConferencia.tsx:264` exige lote e validade para confirmar cada unidade, `confirmUnit` sempre
grava em `nfe_lotes_escaneados` (`src/services/recebimento-confirm.ts:31`), e a edge recusa qualquer NF com lote
escaneado (`supabase/functions/omie-nfe-recebimento/index.ts:603` → `src/lib/recebimento/efetivacao-helpers.ts:354`).
NF com conversão de unidade — o caso Sayerlack — também é recusada (`efetivacao-helpers.ts:357`). Na prática só o
ramo **reconciliar** funciona (o humano já concluiu no Omie e o app só registra).

## 3. Por que é money-path, não só uma tarefa a menos

Medição de 2026-08-13 (psql-ro): **244 de 584 POs abertas (etapa 15) da Oben já tinham NF concluída** e seguiam
contando como "a caminho" — no caso âncora (`WJOI.7666GL`) o motor comprou o mínimo em vez de repor. A etapa só
sai de 15 quando um humano fecha o PO, e `nQtdeRec` é 0 em 100% dos itens (o Omie nunca soube do vínculo).
**Baixar o PO na fonte remove essa dupla contagem**: o `omie-sync-estoque` já pede o `PesquisarPedCompra` sem
recebidos, cancelados e encerrados (`supabase/functions/omie-sync-estoque/index.ts:280-282`).

O lado proibido: **baixar PO recebido PARCIALMENTE apaga "a caminho" legítimo** → o motor recompra → se o saldo
ainda vier, compra dupla. Na medição, das 951 linhas (PO, SKU) das 244 POs, 60% chegaram cheias, 4% a menos, 15% a
mais e 21% sem linha na NF casada. Logo a baixa automática só é segura para cobertura **cheia** — e pela D1 (§8) o
saldo da Sayerlack chega em outra NF, então parcial **nunca** é baixado por ser parcial.

Resíduo que esta frente **não** resolve: enquanto um PO parcial espera o saldo, a parte já recebida segue contada
em dobro (está no físico e, com `nQtdeRec = 0`, também no "a caminho"). Só a associação nativa da Fase 2 (o Omie
passa a preencher `nQtdeRec`) ou o receipt-first ledger descontam essa parte.

⚠️ **Efeito colateral a planejar:** baixar o backlog de uma vez faz o próximo ciclo enxergar o efetivo real de
muitos SKUs ao mesmo tempo → rajada de sugestões. É compra suprimida sendo recuperada (correto), mas convém baixar
em lotes e olhar o ciclo seguinte antes de aprovar — existe o braço de auto-aprovação N3 da Sayerlack
(`docs/agent/reposicao.md` §Mínimo forçado + auto-aprovação).

**Relação com o receipt-first ledger** (decisão de 2026-08-13): baixar na fonte ataca o mesmo defeito para as POs
cheias sem modelar nada ao lado do Omie. Para as parciais, o ledger — ou a associação nativa da Fase 2, que faz o
próprio Omie preencher `nQtdeRec` — continua necessário. *Hipótese (especulativa):* se a Fase 2 provar a
associação nativa, o Omie volta a ser fonte confiável do "a caminho" e o ledger pode encolher para um detector.

## 4. Fatos a confirmar antes de qualquer escrita no Omie

- **F1 — Qual chamada baixa um PO, e com que efeito.** A doc da API (`app.omie.com.br/api/v1/produtos/pedidocompra/`)
  e a central de ajuda estão bloqueadas pela rede desta sessão. Indícios de que "Encerrado" é estado de primeira
  classe: o filtro `lExibirPedidosEncerrados` do `PesquisarPedCompra`, o tópico de webhook
  `CompraProduto.Encerrada` e um artigo de ajuda "Encerrando um Pedido de Compra" (visto em busca, conteúdo não
  lido). **Não confirmado:** se existe método de API para encerrar, e com quais campos (motivo? responsável, como o
  `cEmailAprovador` da aprovação?). Se **não existir**, a Fase 1 fica como fila de baixa manual e a automação passa
  para a associação nativa (Fase 2). Nome de endpoint não é contrato: confirmar na doc **e** numa chamada real
  sobre 1 PO de baixo valor.
- **F2 — O vínculo nativo NF↔PO existe no recebimento?** A sonda `omie-sonda-recebimento` (S2, read-only, já no
  repo) classifica cada item em `native_exact` / `xml_hint_only` / … Rodá-la sobre 3 NFs diz se há `nIdPedido` /
  `nIdItPedido` para gravar no `AlterarRecebimento` — pré-requisito da Fase 2.
- **F3 — Etapa do PO depois da baixa.** O `omie-sync-estoque` só conta etapa `15` e ignora as desconhecidas
  (`omie-sync-estoque/index.ts:195-196`, `:430`). Se a baixa (ou a associação da Fase 2) produzir "recebido
  parcialmente" com etapa nova e saldo > 0, esse saldo **deixa de contar** (subestima). Confirmar o `cEtapa`
  resultante na primeira baixa real antes de ligar qualquer automação.
- **F4 — Tamanho e forma do backlog hoje.** Consultas M1–M7 (§10).

## 5. Pré-requisito descoberto: `ENCERRADO` não existe no enum

`mapPedidoToRow` traduz a etapa `80` em `status='ENCERRADO'` (`omie-sync-pedidos-compra/index.ts:544`), mas o enum
`status_pedido_compra` só tem `CRIADO`, `FATURADO`, `EM_TRANSPORTE`, `RECEBIDO`, `CANCELADO` e `DIVERGENCIA`
(`supabase/schema-snapshot.sql:175-182`; os tipos gerados em `src/integrations/supabase/types.ts` concordam).
Reproduzido em PostgreSQL local com o DDL do snapshot: `ERROR: invalid input value for enum
status_pedido_compra: "ENCERRADO"`. Consequência: o upsert em lote cai, o fallback individual isola a linha e o PO
encerrado **nunca atualiza o espelho** — fica com a etapa antiga no `raw_data` e o run sai `partial`. Hoje isso
só atinge os POs que humanos encerram (se o tenant devolve `80` para encerrado — a Oben customiza etapas, 15 =
Aprovado); com baixa automática viraria centenas de erros por run e o espelho seguiria mostrando os POs como
abertos. **Correção antes da Fase 1:** `ALTER TYPE public.status_pedido_compra ADD VALUE IF NOT EXISTS 'ENCERRADO'`
(ritual `lovable-db-operator`) e revisão dos consumidores de `status` — o `omie-sync-nfes-recebidas` reescreve
`status` a partir da NF, então é preciso definir a precedência entre os dois writers para não oscilar. Evidência
em prod: logs da edge `omie-sync-pedidos-compra` com `invalid input value for enum` e a M7.

## 6. Desenho em fases

**Fase 0 — fila "PO para baixar" (sem escrita no Omie).** Lista na área de Compras com cada PO aberto no Omie cuja
NF já foi concluída, a classe de cobertura (§7) e o necessário para baixar à mão (nº do PO, contrato, NF, itens
faltantes). Valor imediato: acaba a caça "qual PO é desta NF?". É também a **sombra** do classificador — se os
humanos baixam as `cheia` e seguram as `parcial`, a regra está validada com dado real. Nasce com sensor
(`track('compras.po_baixa.*')`) para a Fase 1 ter denominador. Junto vai a correção do enum (§5). Pela D2, é nesta
lista que o founder revisa o backlog antes de liberar a baixa em lotes.

**Pré-requisito de dado para a soma de NFs (consequência da D1).** O espelho não sabe somar entregas: o
`purchase_orders_tracking` guarda **uma** NF por PO (`nfe_chave_acesso`/`nid_receb`), e o `sku_leadtime_history` tem
`UNIQUE (tracking_id, sku_codigo_omie)` (`uq_sku_hist_tracking_sku`) com upsert `onConflict` nessas colunas
(`omie-sync-sku-items/index.ts:1000`) — a agregação existe **dentro** de uma NF, mas a 2ª NF do mesmo PO e SKU
**sobrescreve** a 1ª. Logo, antes de baixar por soma, persistir o item de NF com o seu `nNumPedCompra`
(1 linha por `nIdReceb` + sequência do item; produto; `nQtdeRecebida`; `cRecebido`/`cCancelada` da nota; 1 writer =
`omie-sync-nfes-recebidas`, que já faz o `ConsultarRecebimento` de cada NF). É o `receipt`/`receipt_item` do
receipt-first ledger (spec 2026-08-13 §6) — construir **esse** bloco, não uma tabela paralela. Até ele existir, a
lista classifica pelo espelho atual, que só erra para o lado seguro (subconta → `parcial`, nunca baixa por engano).

**Fase 1 — baixa automática da cobertura cheia.** Edge própria (1 writer) com `modo = desligado | sombra | ativo`
em banco (kill-switch). Por PO candidato: reconsulta ao vivo (`ConsultarPedCompra` + os `ConsultarRecebimento` das
NFs ligadas: PO ainda aberto, mesmo contrato, NF com `cRecebido=S` e não cancelada) → classifica → se `cheia` e modo
`ativo`, chama o método confirmado em F1 → reconsulta até ver o PO fora do conjunto aberto → ledger append-only por
tentativa (claim atômico, idempotente, lote máximo por run para não gerar rajada nem estourar o "consumo
redundante" do Omie — padrão de adiamento de `omie-sync-sku-items/adiamento.ts`). Gatilho: carona no ciclo do
`omie-sync-nfes-recebidas`, que já detecta a transição de `t4`; o webhook `RecebimentoProduto.Concluido` pode
antecipar se a M6 mostrar que os eventos chegam. `parcial` fica aberto (D1) e é reavaliado a cada NF nova do mesmo
contrato — baixa quando a **soma** cobrir o pedido. Backlog (D2): o mesmo núcleo, em lotes liberados pelo founder a
partir da lista da Fase 0, com o ciclo seguinte do motor revisado antes de aprovar compras. Codex obrigatório antes
de `ativo`.

**Fase 2 — a conferência no app conclui e baixa.** Destravar o ramo de escrita do `omie-nfe-recebimento` (lote e
validade no `AlterarRecebimento`, conversão Sayerlack — follow-ups já nomeados em
`docs/superpowers/specs/2026-06-04-recebimento-pr2-coreografia-design.md`) e, depois do `ConcluirRecebimento`
confirmado, chamar o mesmo núcleo da Fase 1 como passo do ledger (`baixar_pedido_compra`). Se F2 confirmar o vínculo
nativo, **associar os itens ao PO antes de concluir**: o próprio Omie baixa o PO e preenche `nQtdeRec`, o que
resolve também o parcial (o saldo restante continua aberto e certo) — desde que F3 não mostre etapa nova.

## 7. Classificador de cobertura (núcleo puro, TDD)

Entrada: itens do PO (`nCodProd`, `nQtde`); itens das NFs concluídas cujo `nNumPedCompra` = contrato do PO
(`nCodProd` após o de-para, `nQtdeRecebida`); `cRecebido` / `cCancelada` de cada NF. Saída por PO:

| classe | regra | ação |
|---|---|---|
| `cheia` | todo item do PO com recebido ≥ pedido, na unidade do produto Omie | baixa (Fase 1, modo `ativo`) |
| `parcial` | algum item a menos ou ausente na soma das NFs do contrato | fica aberto esperando o saldo (D1); reavalia a cada NF nova |
| `parcial_envelhecido` | `parcial` sem NF nova do contrato há N dias (N a calibrar pelo lead time Sayerlack) | fila humana — o saldo pode ter sido cortado sem aviso |
| `ambigua` | contrato em mais de 1 PO aberto, unidade/fator divergente, produto sem de-para, NF cancelada ou revertida | nunca baixa; fila humana |
| `sem_evidencia` | nenhuma NF concluída com esse contrato | nada |

Fail-closed: dado ausente nunca vira 0; `ambigua` nunca baixa; somar várias NFs do mesmo contrato é permitido
(entrega em mais de uma nota).

## 8. Decisões do founder (tomadas em 2026-09-26)

- **D1 — Entrega parcial: o saldo chega em outra NF.** `parcial` fica aberto; o PO só é baixado quando a soma das
  NFs com o mesmo pedido Sayerlack cobrir tudo. Consequências: persistir o item de NF (§6, pré-requisito de dado) e
  a classe `parcial_envelhecido` para o saldo que nunca chega.
- **D2 — Backlog: baixar em lotes depois de revisar.** Primeiro a lista em sombra (Fase 0), depois lotes liberados
  pelo founder, olhando o ciclo seguinte do motor antes de aprovar compras.

## 9. Riscos

1. Baixar parcial → compra dupla (§3). Mitigação: só `cheia` automática; parcial espera o saldo (D1).
   Irmão do lado oposto: **parcial eterno** (saldo cortado sem aviso) prende "a caminho" que não vem → suprime
   compra. Mitigação: `parcial_envelhecido` na fila humana.
2. Método ou efeito errado no Omie (F1, F3): diagnóstico primeiro, 1 PO de baixo valor, reconsulta como juiz.
3. Espelho sem enxergar o PO encerrado (§5): corrigir o enum antes.
4. Rajada de sugestões depois do backlog (§3): lotes e revisão do ciclo seguinte.
5. "Consumo redundante" do Omie: 1 consulta de detalhe por método e conta por janela, com adiamento.
6. `xPed` errado vindo do fornecedor: vira `ambigua` quando produto ou unidade não batem; contrato sozinho, sem
   cobertura de itens, nunca baixa.

## 10. Medição (psql-ro, read-only)

Rodar com `~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f <arquivo>`; a saída tem que terminar em
`FIM-MEDICAO-OK` (sem o marcador, o wrapper pode sair 0 com ERROR). Validadas em PostgreSQL 16 local com o DDL do
`schema-snapshot.sql` e dados sintéticos (cada linha e classe esperada apareceu); **não** rodadas em prod.

```sql
\echo === M1 backlog: etapa do PO no Omie x NF concluida (t4)
SELECT raw_data->'cabecalho_consulta'->>'cEtapa' AS etapa,
       (t4_data_recebimento IS NOT NULL)          AS nf_concluida,
       count(*)                                   AS pos
FROM purchase_orders_tracking
WHERE empresa = 'OBEN' AND omie_codigo_pedido > 0
GROUP BY 1, 2
ORDER BY 1, 2;

\echo === M2 elo existe? POs abertas (etapa 15) por fornecedor, com/sem numero do contrato
SELECT fornecedor_nome,
       count(*) FILTER (WHERE numero_contrato_fornecedor IS NOT NULL) AS com_contrato,
       count(*) FILTER (WHERE numero_contrato_fornecedor IS NULL)     AS sem_contrato
FROM purchase_orders_tracking
WHERE empresa = 'OBEN' AND omie_codigo_pedido > 0
  AND raw_data->'cabecalho_consulta'->>'cEtapa' = '15'
GROUP BY 1
ORDER BY 2 DESC, 3 DESC
LIMIT 20;

\echo === M3 ambiguidade: mesmo numero do contrato em mais de 1 PO (ex.: PO recriado apos exclusao)
SELECT numero_contrato_fornecedor,
       count(*)                                                        AS pos,
       string_agg(numero_pedido || ':' || coalesce(raw_data->'cabecalho_consulta'->>'cEtapa', '?'), ', '
                  ORDER BY numero_pedido)                              AS pedido_etapa
FROM purchase_orders_tracking
WHERE empresa = 'OBEN' AND omie_codigo_pedido > 0 AND numero_contrato_fornecedor IS NOT NULL
GROUP BY 1
HAVING count(*) > 1
ORDER BY 2 DESC
LIMIT 20;

\echo === M4 cobertura das POs abertas com NF concluida (sombra do classificador; ver ressalvas)
WITH po AS (
  SELECT pot.id,
         (it->>'nCodProd')::bigint AS sku,
         (it->>'nQtde')::numeric   AS qtde_pedida
  FROM purchase_orders_tracking pot
  CROSS JOIN LATERAL jsonb_array_elements(pot.raw_data->'produtos_consulta') AS it
  WHERE pot.empresa = 'OBEN' AND pot.omie_codigo_pedido > 0
    AND pot.raw_data->'cabecalho_consulta'->>'cEtapa' = '15'
    AND pot.t4_data_recebimento IS NOT NULL
), nf AS (
  SELECT tracking_id, sku_codigo_omie AS sku, sum(quantidade_recebida) AS qtde_recebida
  FROM sku_leadtime_history
  WHERE empresa = 'OBEN'
  GROUP BY 1, 2
), por_po AS (
  SELECT po.id,
         CASE
           WHEN bool_and(nf.qtde_recebida IS NOT NULL AND nf.qtde_recebida >= po.qtde_pedida) THEN 'cheia'
           WHEN bool_or(nf.qtde_recebida IS NOT NULL)                                         THEN 'parcial'
           ELSE 'sem_item_casado'
         END AS classe
  FROM po
  LEFT JOIN nf ON nf.tracking_id = po.id AND nf.sku = po.sku
  GROUP BY po.id
)
SELECT classe, count(*) AS pos
FROM por_po
GROUP BY classe
ORDER BY classe;

\echo === M5 NFs orfas (nenhum item casou com contrato) por fornecedor, 90 dias
SELECT fornecedor_nome, count(*) AS nfs_orfas, max(t2_data_faturamento) AS ultima
FROM purchase_orders_tracking
WHERE empresa = 'OBEN' AND omie_codigo_pedido < 0
  AND t2_data_faturamento >= now() - interval '90 days'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 20;

\echo === M6 o webhook do Omie esta chegando? (30 dias)
SELECT empresa, topic, count(*) AS eventos, max(received_at) AS ultimo
FROM omie_webhook_events
WHERE received_at >= now() - interval '30 days'
GROUP BY 1, 2
ORDER BY 1, 2;

\echo === M7 o sync de POs ja tropeca no ENCERRADO? (ultimo estado)
SELECT entity_type, account, status, error_message, updated_at
FROM sync_state
WHERE entity_type ILIKE 'pedidos_compra%'
ORDER BY updated_at DESC
LIMIT 5;
\echo FIM-MEDICAO-OK
```

**Ressalvas da M4 — ordem de grandeza, não o classificador.** Usa `sku_leadtime_history`, cujo `tracking_id`
NOT NULL pousa item sem pedido casado numa linha eleita (spec 2026-08-13 §3.2) e pode inflar `cheia`. Compara o
`nQtde` do PO com `quantidade_recebida` (`nQtdeRecebida`), que deveria estar na unidade do produto Omie — conferir
no SKU âncora antes de confiar (a mesma spec registrou razão 3,24 entre `nQtdeNFe` e `nQtdeRecebida`). Entrega em
duas NFs aparece como `parcial`: a 2ª NF sobrescreve a 1ª no `sku_leadtime_history` (§6). A M1 também não enxerga
PO encerrado se o bug da §5 estiver ativo: o upsert falha e a linha fica com a etapa antiga.

## 11. Achados laterais (fora do escopo, registrados para não perder)

- `reportDivergencia` grava a coluna `observacao` em `nfe_recebimento_itens`
  (`src/services/recebimento-divergencia.ts:21`), mas a tabela só tem `observacao_divergencia`
  (`supabase/schema-snapshot.sql`, `CREATE TABLE public.nfe_recebimento_itens`) — o registro de divergência na
  conferência deve falhar no PostgREST e, offline, ficar preso na fila.
- O botão "Importar NF-e" (`src/pages/Recebimento.tsx:218`) chama `omie-nfe-webhook` sem o header
  `x-webhook-secret` que a edge exige (`supabase/functions/omie-nfe-webhook/index.ts:71-74`) → 401 sempre.

## 12. Continuação — chips de 2026-09-26 (cópia durável dos prompts)

Chip é perecível (vive na sessão que o criou). Se nenhum dos dois foi clicado, recrie a partir daqui.

**Este spec ainda não está na main:** o branch `claude/laughing-darwin-ycgmbm` ficou sem PR de propósito — no fecho
a main estava vermelha no `sonda:fingerprint` (commits "Changes" do Lovable, conserto em
`LucasSardenbergL/afiacao#2579`) e um PR aberto ali ficaria parado vermelho. A sessão de continuação traz o
spec para a main **junto** do plano da Fase 0, num PR só.

**Chip "Medir e revisar a baixa automática de PO no Omie"** — sessão LOCAL (precisa de `psql-ro`, Codex e rede
para `app.omie.com.br`). Leia este spec e execute, em ordem:

0. Higiene da janela `94cb988..eec8598` que a sessão de nuvem não mediu (`edges-pendentes.sh` e
   `authz:claude-ro:prod` saíram rc=2 duas vezes, `psql-ro` ausente): `bun run pendencias:deploy` para as edges de
   terceiros `omie-sync-estoque`, `sync-reprocess`, `tint-sync-agent` e `whatsapp-inbound` (o PR
   `LucasSardenbergL/afiacao#2579` reverte os commits "Changes" do agente Lovable que deixaram o `sonda:fingerprint`
   vermelho na main); confirmar no banco as migrations de terceiros `20260925210000_tint_promocao_assincrona.sql`,
   `20260925225004_reposicao_em_transito_simulado_e_join_grupo_null_safe.sql` e
   `20260926001425_param_auto_em_transito_conta_disparado_simulado.sql`; `bun run authz:claude-ro:prod`. O que outra
   sessão já resolveu é desfecho ✅.
1. Medição M1–M7 (§10) com `~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f <arquivo>` e o marcador
   `FIM-MEDICAO-OK`; registrar os números aqui (backlog por classe; bug do `ENCERRADO` ativo?).
2. F1 e F3 (§4) na doc oficial do `pedidocompra`: método de encerramento, campos, `cEtapa` resultante. Nenhuma
   escrita no Omie sem chamada real em 1 PO de baixo valor combinada com o founder.
3. F2 (§4): sonda `omie-sonda-recebimento` (S2) em 3 NFs.
4. Ritual `/codex` sobre este spec (money-path), parecer registrado aqui.
5. Plano da Fase 0 em `docs/superpowers/plans/` — (a) enum `ENCERRADO` (§5) com `lovable-db-operator` e a
   precedência entre os writers de `status`; (b) item de NF com `nNumPedCompra` = `receipt`/`receipt_item` do
   receipt-first ledger (§6); (c) lista "Pedidos para baixar" (§7) com sensor `track('compras.po_baixa.*')`. Sem
   Fase 1 nessa sessão.

**Chip "Consertar divergência e importação de NF-e na conferência"** — os dois achados da §11, em PR próprio (não
misturar com esta frente). Pronto quando: (a) `reportDivergencia` grava em `observacao_divergencia`, com teste que
casa o nome da coluna, decisão sobre itens já presos na fila offline (`offline_queue_v1`) com o payload antigo, e o
porquê de o typecheck não ter pegado; (b) importação por chave com caminho gateado por staff
(`authorizeCronOrStaff`) que consulta o Omie (`ConsultarRecebimento` por `cChaveNFe`) e importa com dedupe por
`chave_acesso`, sem expor o `x-webhook-secret` ao cliente, respeitando o "consumo redundante" e os gates de edge.

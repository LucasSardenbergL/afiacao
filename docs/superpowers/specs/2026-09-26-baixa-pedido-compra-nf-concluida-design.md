# Baixa do pedido de compra no Omie quando a NF é concluída (Oben × Sayerlack) — design (proposta)

> Money-path (reposição/compras): baixar PO muda o "a caminho" do motor. Ver `docs/agent/reposicao.md`,
> `docs/agent/money-path.md` e a medição `docs/superpowers/specs/2026-08-13-reposicao-onorder-po-recebida-medicao.md`.
> **Status (2026-09-26): proposta, nada implementado; decisões D1/D2 tomadas (§8).** Antes de qualquer escrita no
> Omie faltam os fatos da §4. Escrito numa sessão de nuvem **sem `psql-ro`, sem Codex e sem acesso à doc do Omie**
> (domínio bloqueado pela política de rede) — por isso o ritual `/codex` continua obrigatório antes da Fase 1.
>
> **Atualização (2026-09-26, sessão local com `psql-ro`, Codex e a doc do Omie):** medição em prod na §13, F1–F3
> na §14, revisão do desenho na §15, parecer do Codex na §16. **Três resultados mudam o desenho:** (1) **não existe
> método de API para encerrar PO** — a Fase 1 como "baixa automática via API" não é construível (§14); (2) o
> "a caminho" do motor **já exclui** a maior parte dos POs etapa 15 que o espelho mostra abertos — a escala da §3
> mede o espelho, não o motor (§13.4); (3) o espelho é **cego à situação** do PO no Omie, então a lista da Fase 0
> só pode existir depois que o `omie-sync-estoque` registrar o conjunto que o motor de fato contou (§15, opção C do
> Codex). Plano da Fase 0: `docs/superpowers/plans/2026-09-26-baixa-po-fase-0.md`.

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

> ⚠️ **Revisto em §13.4 (medido 2026-09-26):** a premissa de ESCALA desta seção não vale para o estado de hoje. O
> `estoque_pendente_entrada` gravado pelo `omie-sync-estoque` soma 554 un. onde os POs etapa 15 do espelho somam
> 13.484, e é zero em 10 de 11 SKUs cujo único PO etapa 15 tem NF concluída (sem de-dup do app). O mecanismo da
> dupla contagem continua possível (o caso âncora de 08-13 existiu), e o resíduo hoje é **estimado** (não limitado)
> em ~165 un. em 28 SKUs — ver §13.4 e o parecer do Codex (§16).

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

> **Respondidos em §14 (2026-09-26).** F1: não há método de API para encerrar PO. F2: o vínculo nativo existe
> (`nIdItPedido`) e é usado neste tenant. F3: a associação nativa leva o PO a "Faturado pelo Fornecedor" e
> "Recebido"; o `cEtapa` resultante continua a medir na 1ª ocorrência. F4: §13.

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

> **Medido em §13.2:** o enum em prod também não tem `ENCERRADO`, mas o bug está **latente** (último run 0 erros,
> nenhum PO em etapa 80). E a §13.4 indica que encerrar **não muda o `cEtapa`** neste tenant — o ramo `"80"` pode
> nunca disparar. O enum continua sendo higiene barata e pré-requisito de qualquer writer que venha a gravar
> `ENCERRADO` (§15, item 3).

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

> ⚠️ **Revisto em §15 (2026-09-26):** a Fase 1 abaixo pressupunha um método de API de encerramento, e ele não
> existe (§14). A automação real passa a ser a associação nativa no recebimento (Fase 2), e a Fase 0 ganha um
> pré-requisito: o espelho aprender a situação do PO no Omie. O texto abaixo fica como registro da proposta.

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
**Rodadas em prod em 2026-09-26 — resultados na §13.**

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

> **Desfecho (2026-09-26):** os dois foram clicados. O 1º é a sessão local que escreveu as §13–§16 e o plano da
> Fase 0 (`docs/superpowers/plans/2026-09-26-baixa-po-fase-0.md`); o 2º virou a sessão "Consertar divergência e
> importação de NF-e na conferência".

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

## 13. Medição em prod (2026-09-26, sessão local — `psql-ro`)

Cada arquivo rodou com `~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f <arquivo>` e terminou em `exit 0` **com**
o marcador `FIM-MEDICAO-OK`. Um arquivo com erro de cast (`text = bigint`) saiu `exit 3` **sem** o marcador, foi
corrigido e re-rodado — é o marcador que separa os dois casos. Leitura entre ~10:30Z e ~11:30Z.

**13.0 Higiene da janela `94cb988..eec8598` (passo 0 do chip).** As 3 migrations de terceiros estão aplicadas: as
postcondições `DO $post$` delas, reescritas como `SELECT`, deram todas `t`. `authz:claude-ro:prod`: 38 asserções,
exit 0. No ledger (`pendencias:deploy`), `sync-reprocess` e `whatsapp-inbound` conferem. `omie-sync-estoque` estava
em P1 (v1.1 → v1.2) e foi deployado por outra sessão às 10:03Z (o histórico do Lovable mostra os 7 hashes de
`314c7bb4` conferidos); a atestação no ledger espera o próximo eco. `tint-sync-agent` está fora do mapa (sem
`versao.ts`) e foi deployado por outra sessão às 10:09Z (3 hashes de `4af29b7f`). A testemunha no banco — runs com
`promocao_status` preenchido — não tem dado ainda: nenhum run desde o merge (sábado).

### 13.1 M1–M7 (verbatim da §10)

| medida | resultado |
|---|---|
| M1 etapa × NF concluída (663 POs reais OBEN) | etapa 15: **273 com NF** + 388 sem · etapa 10: 1 + 1 · **nenhuma outra etapa** (nem 70, 80 ou 90) |
| M2 contrato nas POs etapa 15 | 329 com fornecedor Sayerlack nomeado, 100% com contrato. 332 com `fornecedor_nome` vazio (305 com contrato, 27 sem): o nome só é gravado quando uma NF casa, e por mês "nome vazio" = "sem NF" exatamente |
| M3 contrato em >1 PO | 7 contratos com 2 POs cada, todos etapa 15 (V4 abaixo) |
| M4 sombra das 273 | `cheia` 192 · `parcial` 68 · `sem_item_casado` 13 (as ressalvas da §10 valem) |
| M5 NFs órfãs em 90 d | Sayerlack **42** (+1 do cadastro "- FUB"); outros 14 fornecedores com 1 a 5 cada |
| M6 webhook do Omie em 30 d | **0 eventos**, em qualquer tópico → gatilho só por polling |
| M7 sync de POs | `pedidos_compra/oben` `complete` às 10:15Z · `pedidos_compra_full/oben` `complete` às 06:16Z |

### 13.2 Extras: enum, `status`, cobertura

- **X0 — enum em prod** = `{CRIADO,FATURADO,EM_TRANSPORTE,RECEBIDO,CANCELADO,DIVERGENCIA}`, sem `ENCERRADO`.
- **X2/X3 — o bug da §5 está latente, não ativo.** A resposta da edge em `net._http_response` (10:15Z) traz 134 POs,
  `"erros":0`, `"varredura_completa":true` e janela de previsão 2026-07-28 → 2027-01-24. Nenhum PO está em etapa 80.
- **X1 — `status` tem dois writers e oscila.** Etapa 15 → `CRIADO` 654, `FATURADO` 5, `RECEBIDO` 2. O sync de POs
  reescreve `CRIADO` a cada run (`status` fora do `PRESERVE_FIELDS`, `omie-sync-pedidos-compra/index.ts:497`) e o
  `omie-sync-nfes-recebidas` escreve `FATURADO`/`RECEBIDO`/`CANCELADO` (`index.ts:274-277`). Nenhum leitor em `src/`.
  As views `v_pedidos_em_aberto` (`status <> ALL ('RECEBIDO','CANCELADO')`) e `v_leadtime_por_grupo` não têm
  consumidor (varredura de 2026-09-26).
- **X5 — `infcpl_raw` e `numero_pedido_fornecedor`: 0 de 867 linhas.** O fallback pelo texto `Pedido: NNN` exigiria
  captura nova.
- **Cobertura do sync de NFs começa em 2026-01-19** (menor `t2` do espelho; menor `t4` 2026-01-23). Todo PO de
  jun–dez/2025 está "sem NF" por **falta de observação**, não por falta de recebimento.
- O espelho de POs é Sayerlack em 655 de 663 linhas (os outros 8 são de 4 fornecedores).

### 13.3 Os 661 POs etapa 15 em grupos

Valor = Σ `nValTot` dos itens, só para previsão dentro da janela que o `omie-sync-estoque` lê (−365 d / +120 d).
Lead time Oben medido: mediana 10 d, p95 18 d, máximo 39 d (`omie-sync-estoque/index.ts:192`).

| grupo | regra | POs | na janela | R$ na janela |
|---|---|---|---|---|
| A | NF concluída (`t4`) | 273 | 273 | 786 mil |
| A2 | NF só faturada (`t2` sem `t4`) | 56 | 56 | 106 mil |
| B1 | sem NF, PO anterior à cobertura (`t1` < 2026-01-19) | 259 | 139 | 466 mil |
| B2 | sem NF, coberto, previsão vencida > 40 d | 57 | 57 | 216 mil |
| C | sem NF, no prazo | 16 | 16 | 21 mil |

- **V1 — origem no app:** 510 dos 661 não têm pedido do app ligado por `omie_pedido_compra_id` (PO manual com
  contrato digitado, ou anterior ao registro do id). 3 POs cujo pedido no app está `cancelado`/`cancelado_humano`
  seguem etapa 15 no Omie.
- **V2 — `nQtdeRec > 0` em 0 de 2.930 itens.** Confirma a spec de 08-13 em escala: o Omie não soube de nenhum
  recebimento por associação desses POs.

### 13.4 ⚠️ O "a caminho" do motor já exclui a maior parte desses POs

A §3 (vinda de 08-13) **deduziu** que PO etapa 15 com `nQtdeRec = 0` conta cheio no "a caminho". Medido hoje contra
a **saída real** do `omie-sync-estoque` — `sku_estoque_atual.estoque_pendente_entrada`, gravado pelo run das 09:40Z
com `"pendente_confiavel":true` e `"pendente_problemas":0` (resposta em `net._http_response`) e marcador
`reposicao_pendente_po` `complete`:

| recorte: SKUs habilitados, POs etapa 15 com previsão na janela | resultado |
|---|---|
| Σ quantidade dos POs no espelho | 13.484 un. em 191 SKUs |
| Σ `estoque_pendente_entrada` gravado | **554 un.** |
| SKUs cujos POs etapa 15 são todos do grupo A (1ª leitura; ⚠️ rótulo corrigido — ver abaixo) | 22: pendente **0 em 17**, = quantidade dos POs em 1, outro valor em 4 |
| SKUs cujos POs são todos do grupo B1 / B2 (idem) | 9 / 6: pendente **0 em todos** |
| SKUs com pendente > **estimativa** de trânsito (A2 + C) | 28 SKUs, **165 un.** de excesso — estimativa, não teto (§16, achado 2) |
| caso âncora de 08-13 (SKU `8689791246`) | pendente 8, contra dezenas de POs etapa 15 no espelho (PO 575 em diante) |

**Correção pedida pelo Codex (§16, achado 1) e re-medida no mesmo dia.** A 1ª leitura agrupava por `count(DISTINCT
grupo) = 1` — "todos os POs do SKU no mesmo grupo", não "um único PO". Refeita com **1 PO distinto por SKU** e com o
de-dup do app medido (pedido do app com status contado pela RPC e `data_ciclo` nos últimos 7 d, que o estoque tira
do pendente de propósito):

| grupo (SKUs habilitados com exatamente 1 PO etapa 15 na janela) | SKUs | pendente 0 | pendente = PO | com de-dup do app |
|---|---|---|---|---|
| A — NF concluída | 11 | **10** | 1 | 0 |
| A2 — NF só faturada | 5 | **4** | 1 | 0 |
| B1 — sem NF, anterior à cobertura | 7 | **7** | 0 | 0 |
| B2 — sem NF, vencido > 40 d | 5 | **5** | 0 | 0 |
| C — sem NF, no prazo (**controle**) | 4 | 2 | 2 | **2** |

O grupo C é o controle: os 2 zeros dele são exatamente os 2 POs em de-dup do app, e os outros 2 contam cheio. Nos
grupos A, A2, B1 e B2 **nenhum** zero é explicado pelo de-dup. Ressalva do Codex que continua de pé: o run medido
(09:40Z) é da v1.1 do `omie-sync-estoque`, anterior ao deploy da v1.2 (10:03Z); a v1.2 só muda o de-dup do
`disparado_simulado`, que não toca esses grupos.

**Mecanismo (inferência forte, a confirmar):** o estoque pede o `PesquisarPedCompra` com
`lExibirPedidosRecebidos/Cancelados/Encerrados: "F"` (`omie-sync-estoque/index.ts:276-282`); o espelho pede tudo
`"T"` (`omie-sync-pedidos-compra/index.ts:432-438`) e não guarda a situação — o `cabecalho_consulta` tem 21 chaves e
nenhuma é situação. Com `nQtdeRec = 0` em 100% dos itens (nada recebido por associação), o que sai do conjunto
aberto só pode estar **encerrado ou cancelado no Omie com o `cEtapa` ainda em 15**. Confirmação: `PesquisarPedCompra`
com um `lExibir*` por vez sobre os mesmos POs, ou o founder confirmar que a equipe encerra POs à mão.

**Consequências:**
1. A escala da §3 ("244/584", "273") mede o **espelho**, não o motor. O resíduo de money-path hoje é **estimado** em
   **~165 un. em 28 SKUs** — estimativa, não teto: A2 + C é estimativa de trânsito (um A2 que não virá esconde
   fantasma; um A parcial com saldo legítimo infla o excesso) e o excesso inclui POs de outros fornecedores.
2. **O espelho é cego à situação.** M1 e M4 contam como aberto PO já encerrado ou cancelado. Uma lista "Pedidos para
   baixar" montada sobre o espelho de hoje seria quase toda falso-positivo (§15).
3. Se encerrar não muda o `cEtapa` neste tenant, o ramo `etapa === "80"` da §5 pode nunca disparar.
4. Quantos POs com NF concluída continuam **abertos no Omie** — o backlog real da D2 — a medição não diz. Só sai
   depois que o espelho aprender a situação.

### 13.5 Órfãs, vínculo nativo e contratos duplicados

- **O1 — o `xPed` das órfãs se perde.** Das 42 órfãs Sayerlack em 90 d, só **4** guardam itens: `insertOrfa`
  recebe o item da **listagem** (`nfe`), não o detalhe do `ConsultarRecebimento` que a edge acabou de buscar
  (`omie-sync-nfes-recebidas/index.ts:589`).
- **O2/O3 — órfãs Sayerlack com itens (4, mais 1 do "- FUB"):** 26 itens, 26 com `xPed` numérico, **21 com
  `nIdItPedido` > 0**. Os 6 `xPed` distintos (2106598 a 2128158) caem dentro da faixa dos contratos do espelho
  (1998741 a 2132932), e **nenhum** bate com contrato, número ou código de integração de PO do espelho, nem sem
  zeros à esquerda.
- **O6 — a associação nativa É usada neste tenant.** Nas órfãs com itens guardados (287 itens, 20 fornecedores),
  **101** têm `itensCabec.nIdItPedido` > 0, no mesmo espaço de id do `nCodItem` dos POs (12,03–12,17 bi contra
  11,90–12,19 bi), e **nenhum** aponta para item de PO do espelho, que é quase só Sayerlack. Isso corrige a §9.1 da
  spec de 08-13 ("nenhuma tabela do espelho guarda `nIdPedido`/`nIdItPedido`"): o `raw_data` das órfãs antigas guarda.
- **V4 — os 7 contratos em 2 POs:** 3 **duplicados** (mesmos produtos: 1032/1049 com 5 de 6 em comum, 1037/1048
  com 8 de 8, 1038/1050 com 1 de 1 — PO recriado, o antigo segue etapa 15); 3 **divididos** (produtos disjuntos:
  769/770, 812/813, 1163/1181); 1 misto (651/654).
- **"1 NF por PO" mistura campos:** 1217 e 1229 têm o mesmo `nid_receb` (12186754504) e `nfe_numero` diferentes.

### 13.6 Reprodução da §13.4 (o teste decisivo, versão corrigida)

Rodar com `~/.config/afiacao/psql-ro -X -v ON_ERROR_STOP=1 -f <arquivo>` e exigir `FIM-MEDICAO-OK` na saída.

```sql
WITH po_item AS (
  SELECT (pi->>'nCodProd')::text AS sku, (pi->>'nQtde')::numeric AS qtde, pot.id AS po_id, pot.omie_codigo_pedido,
         CASE WHEN pot.t4_data_recebimento IS NOT NULL THEN 'A'
              WHEN pot.t2_data_faturamento IS NOT NULL THEN 'A2'
              WHEN pot.t1_data_pedido < '2026-01-19' THEN 'B1'
              WHEN pot.data_previsao_original < now() - interval '40 days' THEN 'B2'
              ELSE 'C' END AS grupo,
         EXISTS (SELECT 1 FROM pedido_compra_sugerido p
                 WHERE p.empresa = 'OBEN' AND p.omie_pedido_compra_id = pot.omie_codigo_pedido::text
                   AND p.status IN ('aprovado_aguardando_disparo','disparado','disparado_simulado','concluido_recebido')
                   AND p.data_ciclo >= current_date - 7) AS dedup_app_7d
  FROM purchase_orders_tracking pot
  CROSS JOIN LATERAL jsonb_array_elements(pot.raw_data->'produtos_consulta') pi
  WHERE pot.empresa = 'OBEN' AND pot.omie_codigo_pedido > 0
    AND pot.raw_data->'cabecalho_consulta'->>'cEtapa' = '15'
    AND pot.data_previsao_original BETWEEN now() - interval '365 days' AND now() + interval '120 days'
), por_sku AS (
  SELECT sku, min(grupo) AS grupo, count(DISTINCT po_id) AS n_pos, sum(qtde) AS q, bool_or(dedup_app_7d) AS algum_dedup
  FROM po_item GROUP BY sku
)
SELECT p.grupo, count(*) AS skus_com_1_po,
       count(*) FILTER (WHERE e.estoque_pendente_entrada = 0) AS pend_zero,
       count(*) FILTER (WHERE abs(e.estoque_pendente_entrada - p.q) < 0.001) AS pend_igual_po,
       count(*) FILTER (WHERE e.estoque_pendente_entrada > 0 AND abs(e.estoque_pendente_entrada - p.q) >= 0.001) AS pend_outro,
       count(*) FILTER (WHERE p.algum_dedup) AS com_dedup_app_7d
FROM por_sku p
JOIN sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie::text = p.sku AND sp.habilitado_reposicao_automatica
JOIN sku_estoque_atual e ON e.empresa = 'OBEN' AND e.sku_codigo_omie::text = p.sku
WHERE p.n_pos = 1
GROUP BY p.grupo ORDER BY p.grupo;
cho FIM-MEDICAO-OK
```

## 14. F1–F3 respondidos (2026-09-26)

### F1 — não existe método de API para encerrar um PO

- **Doc oficial do `pedidocompra`** (`https://app.omie.com.br/api/v1/produtos/pedidocompra/`, lida em 2026-09-26)
  tem 6 métodos: `AlteraPedCompra`, `ConsultarPedCompra`, `ExcluirPedCompra`, `IncluirPedCompra`,
  `PesquisarPedCompra` e `UpsertPedCompra`. Nenhum encerra, cancela ou baixa.
- `cEtapa` só existe no `cabecalho_consulta` ("Etapa atual do pedido de compra"). Os cabeçalhos de escrita
  (`cabecalho_alterar`, `cabecalho_incluir`, `cabecalho_upsert`) não a aceitam. `cEmailAprovador` (só em
  `incluir`/`upsert`) "atribui a etapa de aprovação com o status de aprovado": é aprovação, não encerramento.
- **Lista oficial de serviços** (`https://developer.omie.com.br/service-list/`): a área de compras tem só
  `requisicaocompra`, `pedidocompra`, `recebimentonfe`, `compras-resumo`, `comprador` e `formaspagcompras`. O
  serviço de etapas (`pedidoetapas`) é de pedido de **venda**.
- **Encerrar é ação de interface** (ajuda "Encerrando um Pedido de Compra",
  `https://ajuda.omie.com.br/pt-BR/articles/8999236-encerrando-um-pedido-de-compra`): irreversível; só para quem
  tem permissão de aprovar; só para PO em aprovação ou aprovado; exige "Motivo do Encerramento" (observação
  opcional, editável depois). A semântica é compra que **não vai prosseguir** (fornecedor melhor, compra cancelada),
  não "recebido".
- ⇒ A Fase 1 como "baixa automática via API" **não é construível**. Mesmo por interface, encerrar grava "compra
  abandonada" onde houve recebimento — o histórico de compras do Omie passa a mentir.

### F2 — o vínculo nativo NF↔PO existe e é usado neste tenant

- **Doc do `recebimentonfe`** (`https://app.omie.com.br/api/v1/produtos/recebimentonfe/`, 8 métodos:
  `AlterarEtapaRecebimento`, `AlterarRecebimento`, `AlterarRecebimentoConcluido`, `ConcluirRecebimento`,
  `ConsultarRecebimento`, `ExcluirRecebimento`, `ListarRecebimentos`, `ReverterRecebimento`): `itensCabec` traz
  `nIdPedido` ("ID do Pedido de Compra") e `nIdItPedido` ("ID do Item do Pedido"). O `AlterarRecebimento` associa
  por item em `itensRecebimentoEditar.itensIde[]` com `{nSequencia, cAcao: "ASSOCIAR-PEDIDO", nIdPedidoExistente,
  nIdItPedidoExistente}`.
- **Só enquanto a NF está pendente.** O `AlterarRecebimentoConcluido` aceita só `ide` + `infoAdicionais` (categoria,
  conta, data de registro, projeto, comprador). A ajuda confirma: "Se a NF-e já tiver sido recebida, será necessário
  reverter o recebimento". Para o backlog, o caminho nativo seria `ReverterRecebimento` → associar →
  `ConcluirRecebimento`, que desfaz e refaz estoque e contas a pagar da nota.
- **Dado guardado (§13.5):** 101 de 287 itens de recebimento têm `nIdItPedido` > 0, de 20 fornecedores. A associação
  é usada na Oben, só não nas NFs Sayerlack casadas por contrato (`nQtdeRec = 0` em 100%).
- **Por que a Sayerlack não vincula sozinha.** O Omie liga a NF ao PO na importação quando o fornecedor preenche
  `xPed`/`nItemPed` com o pedido do comprador (ajuda "Preenchendo o xPed e o nItemPed",
  `https://ajuda.omie.com.br/pt-BR/articles/498834-preenchendo-o-xped-e-o-nitemped`). A Sayerlack preenche o `xPed`
  com o **protocolo dela**, que o nosso PO guarda em `cContrato`. E o disparo deixa o `cNumPedido` ("Nº do Pedido
  do Fornecedor") em branco de propósito (`disparar-pedidos-aprovados/index.ts:1182-1185`): 661 de 663 POs com
  `cNumPedido` vazio.
- **Sonda S2** (`omie-sonda-recebimento`, read-only): **não disparada** (0 respostas em `net._http_response` até
  2026-10-01). A F2 fica respondida pela doc + dado guardado acima; a sonda é confirmação opcional. O disparo é do
  founder (lê `vault`, faz `net.http_post`); a leitura é minha por `psql-ro` (`content LIKE '%s2_associacao_por_item%'`,
  dentro de ~6 h). Amostra escolhida: 1205 (NF exclusiva), 1217 (NF consolidada), 1037 (contrato duplicado).

  ```sql
  SELECT net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-sonda-recebimento',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)),
    body := '{"empresa":"OBEN","limite":3,"pedidos":["1205","1217","1037"]}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  ```

### F3 — o que acontece com o PO

- **Associação nativa** (ajuda "Associando a NF-e do Fornecedor com um Pedido de Compra",
  `https://ajuda.omie.com.br/pt-BR/articles/1429543-associando-a-nf-e-do-fornecedor-com-um-pedido-de-compra`):
  associação parcial → PO "Recebido Parcialmente"; todos os itens da nota associados nas quantidades exatas →
  "Faturado pelo Fornecedor"; ao concluir a NF → "Recebido". Existe também "Faturado Parcialmente"
  (`lExibirPedidosFatParciais`).
- **Encerrar → "Encerrado"**, irreversível. "Recebido", "Cancelado" e "Encerrado" deixam o PO só-leitura (ajuda
  "Consultando os Pedidos de Compra que já cadastrei").
- **O `cEtapa` resultante continua sem número.** A doc não publica o mapa etapa↔situação, a Oben customiza etapas
  (15 = Aprovado) e a §13.4 indica que a situação muda **sem** mudar o `cEtapa`. Risco concreto para a Fase 2: o
  `omie-sync-estoque` só soma etapa 15 e **ignora** etapa desconhecida (`omie-sync-estoque/index.ts:430-433`). Se a
  associação parcial trocar o `cEtapa`, o saldo ainda não recebido some do "a caminho" e o motor recompra. Medir na
  1ª associação real (PO de baixo valor com entrega parcial) antes de qualquer automação.

## 15. Revisão do desenho (2026-09-26, pós-medição)

1. **Escala.** O defeito de money-path existe e é pequeno hoje (§13.4). A frente se justifica mais pela higiene do
   Omie (PO recebido sair do aberto sem trabalho manual) e pela prevenção estrutural (associação nativa) do que por
   compra suprimida em volume. Medir o resíduo por SKU entra na Fase 0.
2. **Pré-requisito novo: observar o conjunto que o motor contou** (opção C do Codex, §16). O `omie-sync-estoque`,
   que já varre o conjunto aberto a cada run, grava por execução os POs que leu e o que cada um contribuiu —
   capturado ANTES dos filtros locais, com o motivo de exclusão (de-dup do app, etapa ≠ 15, fora da janela) — em
   tabela própria com 1 writer. É a única evidência na unidade que cobra, e custa zero chamada ao Omie. Falha nessa
   gravação deixa a evidência indisponível, nunca derruba o cálculo do pendente e **nunca** transforma ausência em
   "fechado". A situação exata (recebido × encerrado × cancelado) fica para confirmação seletiva por sonda
   read-only com todos os flags explícitos. (A primeira proposta — partições no `omie-sync-pedidos-compra` — foi
   descartada: observa em outro horário, com mais chamadas, e mede outra coisa que não o que o motor contou.)
3. **`status` com ownership por domínio.** Hoje ele oscila entre dois writers (§13.2). O sync de POs vira o writer
   de `status` nas linhas de PO (`omie_codigo_pedido` > 0); o `omie-sync-nfes-recebidas` para de escrever `status`
   nelas e continua dono das órfãs (< 0). `ENCERRADO` entra no enum numa migration isolada; parcial não vira terminal;
   situação desconhecida não vira `CRIADO`.
4. **Classes novas no classificador (§7):** `ja_fechado_no_omie` (fora do conjunto que o motor contou — nada a
   fazer); `situacao_desconhecida` (sem observação recente — nunca vira "aberto"); `vencido_sem_nf` (grupo B2: fila
   humana — NF órfã ou pedido que não veio); `nao_observado` (grupo B1: "não sei"); e `ambigua` com motivo explícito
   (`contrato_duplicado`, `contrato_dividido`, `nf_duplicada`, `unidade_sem_conversao`, `unidade_divergente`,
   `pedido_sem_itens`, …). O classificador considera **todos** os POs do contrato, inclusive os fechados.
5. **Cobertura não é elegibilidade.** `cheia` só diz que a quantidade chegou. Encerrar exige também que os itens
   movimentem estoque e que o físico lido pelo motor seja posterior à NF; sem isso, a classe é `cheia` com
   elegibilidade `aguardando_estoque`/`nao_movimenta_estoque`/…, e a lista não a apresenta como pronta.
6. **A Fase 1 deixa de ser "baixa via API".** Vira a fila humana da Fase 0, com o necessário para encerrar no Omie
   (motivo sugerido: "Recebido pela NF nnn, sem associação") — decisão D3.
7. **Proteção antes de qualquer associação nativa.** Hoje o `omie-sync-estoque` descarta etapa diferente de 15 antes
   do helper (`omie-sync-estoque/index.ts:430-433`). Etapa aberta desconhecida com saldo passa a bloquear a
   publicação do pendente e a sinalizar (o pendente anterior é preservado) — senão a primeira associação parcial que
   mude o `cEtapa` apaga o saldo não recebido do "a caminho".
8. **A Fase 2 é a associação nativa antes de concluir a NF.** Duas vias, nesta ordem: (i) **H-xPed** — preencher o
   `cNumPedido` com o protocolo no disparo e ver, em 1 PO real, se o Omie vincula sozinho na importação (custo quase
   zero; se funcionar, o Omie passa a baixar e a preencher `nQtdeRec` sem escrita nossa no recebimento); (ii)
   `AlterarRecebimento` com `ASSOCIAR-PEDIDO` nas NFs pendentes cujo `xPed` casa com um contrato (escrita no
   recebimento, reversível enquanto pendente). Nas duas, o bloqueio é o F3: o `cEtapa` depois da associação parcial.
9. **Órfãs sem `xPed`.** A persistência do item de NF (bloco `receipt`/`receipt_item`) guarda o detalhe do
   `ConsultarRecebimento` que a edge já busca — inclusive para a órfã — em versão por leitura completa (§16, achado 6).
   As tabelas `nfe_recebimentos`/`nfe_recebimento_itens` não servem de base: são do fluxo de conferência do app,
   multi-writer, com 47 cabeçalhos e **0 itens** em prod (2026-09-26).

**Decisões novas para o founder:**

- **D3 — Backlog:** encerrar à mão (irreversível, motivo "recebido") ou reverter + associar + concluir (pesado,
  mexe em estoque e contas a pagar)? Recomendação: encerrar à mão, guiado pela lista, só PO `cheia` + `elegivel`
  que o motor ainda conta, com conferência humana da entrada no estoque.
- **D4 — Testar H-xPed em 1 PO real:** preencher o `cNumPedido` no disparo de 1 pedido Sayerlack de baixo valor e
  observar a importação da NF.

## 16. Parecer do Codex (ritual de desenho, money-path)

**Consulta de DESENHO** (1ª das 2 obrigatórias em money-path; a 2ª é o adversarial no diff de cada PR). Transporte
`scripts/codex-async.sh`, prompt com seção `RÉGUA:` (unidade decisória = unidade de SKU no `estoque_pendente_entrada`;
onde o sistema a expõe; denominador = 191 SKUs; falsificação; ordem dos irreversíveis). Registro para o PR:
`Codex: desenho=gpt-6-astra·max·327s·69.135 tokens · código=? · extra=nenhum`.

### 16.1 Parecer cru (verbatim)

<details>
<summary>Parecer do Codex — 11 achados (10 × P1, 1 × P2), "Concordo", "Discordo" e ordem de PRs</summary>

```text
=== PARECER CODEX (modelo gpt-6-astra · reasoning max · tentativa 1 · 327s · 69.135 tokens) ===
1. **[P1] A §13.4 sustenta a divergência entre espelho e motor; ainda não prova “encerrado/cancelado”.**

   **Cenário:** PO aberto do app, dentro dos sete dias de deduplicação → pendente zero → diagnóstico incorreto de PO encerrado. Também permanecem possíveis: situação “Recebido”, previsão ou quantidade alterada após o espelhamento, diferença temporal entre sincronizações e omissão na coleta. `pendente_confiavel=true` certifica os controles implementados, não a completude semântica do Omie.

   Há um problema na reprodução: `count(DISTINCT grupo) = 1` seleciona **um único grupo**, não um único PO. Portanto, a query apresentada não demonstra a afirmação “único PO aberto”. [§13.6 do spec](docs/superpowers/specs/2026-09-26-baixa-pedido-compra-nf-concluida-design.md:472)

   **Correção:** primeiro, via psql, separar POs distintos, deduplicação do app, previsão e frescor do pendente. Depois usar S1 numa amostra pequena: PO antigo do grupo A com pendente zero, B1/B2 com zero e controles com pendente positivo. Comparar identidade, previsão, etapa e quantidades atuais. O run das 09:40Z antecede inclusive o deploy das 10:03Z citado no spec: não presumir identidade entre comportamento medido e código atual.

   Se `ConsultarPedCompra` não devolver situação explícita, S1 elimina explicações alternativas, mas **não confirma encerramento**. A discriminação exige observar a pertença às pesquisas por situação, incluindo “Recebidos”. As edges descritas não oferecem essa partição parametrizável; falta essa instrumentação mínima. Não obteria essa certeza apenas com psql read-only.

2. **[P1] As 165 unidades não são um teto demonstrado do defeito.**

   **Cenário:** SKU tem pendente 10 e um PO A2 de 10 cujo saldo já não virá → “trânsito real = A2 + C” dá 10 → resíduo zero, embora existam dez unidades fantasmas. No sentido oposto, saldo legítimo de um PO parcialmente recebido do grupo A aumenta artificialmente o excesso calculado.

   **Correção:** chamar A2 + C de **estimativa de trânsito**, até confirmar obrigações restantes. Medir por SKU excesso, falta e quantidade ainda indeterminada, sem compensar erros entre SKUs. A referência comparada à coluna precisa excluir os pedidos representados pela deduplicação do app; acompanhar esse componente separadamente.

   Antes dos PRs (a)–(c), investigaria os 28 SKUs apontados e uma amostra dos zeros, mantendo os **191 SKUs como coorte fixa**. Mediria unidades incorretas, duração do erro e mudança concreta na sugestão de compra.

   **Prioridade:** há justificativa imediata para diagnóstico e prevenção. Ainda não há demonstração de prioridade para uma frente ampla de encerramento. Mesmo um resíduo pequeno pode ser prioritário se concentrado em SKUs próximos da ruptura; quantidade de POs e valor histórico não resolvem essa decisão.

3. **[P1] Prefiro uma C: evidência do estoque + confirmação seletiva de situação, com responsabilidades distintas.**

   **Cenário:** uma página falha, ou a previsão sai da janela → PO deixa de aparecer → gravação de `situacao_omie=ENCERRADO` por ausência → lista recomenda uma ação baseada em situação inventada.

   | Opção | Avaliação |
   |---|---|
   | **A — partições no sync de POs** | Pode identificar situações específicas, mas cria observações em horários diferentes, conflitos entre partições e mais chamadas. “Aberto × fechado” não distingue recebido, cancelado e encerrado. |
   | **B — conjunto observado pelo estoque** | É a melhor evidência do que alimentou o motor e não acrescenta chamadas ao Omie. Precisa registrar também os motivos de exclusão; simples ausência não identifica situação. |
   | **C — B + confirmação seletiva** | Estoque registra observação e contribuição; sync de POs confirma situação quando necessário. Cada fato tem um writer. |

   **Correção proposta:** snapshot por execução, com empresa, filtros, janela, horários, IDs dos POs, itens, contribuição por SKU e exclusões por app/etapa. Capturar antes desses filtros locais. Distinguir coleta completa de pendente efetivamente aplicado; a lista só compara execuções compatíveis. Falha nessa observabilidade deixa a evidência indisponível, sem transformar ausência em fechamento nem derrubar o cálculo por dependência acessória.

   Para situação específica, pesquisar seletivamente, com **todos os flags explicitados**. PO visto em partições conflitantes fica indeterminado até reconciliação. Não assumir que as partições são disjuntas ou fotografias simultâneas.

   O custo de A não é necessariamente próximo do atual: há arredondamento por página, término de cada partição, repetições e consultas concorrentes. Medir chamadas e adiamentos; reutilizar resultados recentes para evitar consumo redundante.

4. **[P1] “Sync de POs como writer único de status” precisa ser restrito aos POs positivos.**

   **Cenário:** remover toda escrita de `status` da edge de NFs → órfã com código negativo deixa de acompanhar recebimento/cancelamento → estado congelado, pois o sync de POs nunca a consulta.

   **Correção:** separar situação do PO e estado do recebimento. Durante a convivência com o espelho misto, ownership por domínio: sync de POs para linhas positivas; sync de NFs para recebimentos e, enquanto existirem, suas projeções órfãs. Isso impede disputa sobre a mesma entidade.

   O mapeamento também precisa preservar a abertura dos estados parciais. “Recebido parcialmente” não pode virar o terminal `RECEBIDO`. Situação desconhecida não vira `CRIADO`; `DIVERGENCIA` não deve desaparecer por um mapeamento que nem representa essa dimensão.

   Hoje, [a atualização por NF](supabase/functions/omie-sync-nfes-recebidas/index.ts:340) preserva estados e datas anteriores. Isso não fornece um modelo correto de reversão. A lista deve consumir fatos atuais do recebimento, não interpretar `t4` histórico como confirmação atual.

5. **[P2] Enum e views devem sair em mudanças separadas e verificáveis.**

   **Cenário:** colar adição do enum e comandos que usam `ENCERRADO` na mesma transação → falha da execução. Ou liberar o writer antes da migration → upserts rejeitados, espelho atrasado.

   **Correção:** migration exclusivamente para adicionar o valor; confirmar commit efetivo e reconhecimento do valor em outra transação; só depois liberar writers, casts, defaults ou views que o utilizem. Registrar a aplicação manual no histórico do repositório. `IF NOT EXISTS` não resolve ordenação de deploy. Reverter o writer não remove o valor acrescentado.

   Para as views, “sem consumidor em `src/`” não prova ausência de dependências no banco ou acessos externos. Eu as aposentaria após essa verificação, sem remoção em cascata. Se forem mantidas, `v_pedidos_em_aberto` precisa distinguir situação desconhecida de aberta e excluir `ENCERRADO`; encerramento não pode produzir recebimento ou lead time fictício.

6. **[P1] `receipt`/`receipt_item` é o recorte certo, mas falta o contrato de identidade e atualização.**

   **Cenário:** NF reprocessada → itens somados novamente; item removido permanece na tabela; recebimento revertido conserva quantidade válida → classificador produz `cheia` indevidamente.

   **Correção:** persistir um snapshot completo e versionado do recebimento, publicado atomicamente com seus itens. Reprocessamento substitui a versão corrente, preservando histórico. Falha de detalhe mantém a versão anterior identificada como antiga; não significa recebimento vazio. Itens ausentes só podem ser desativados após leitura completa.

   O mínimo inclui empresa/conta, chave da NF, fornecedor, IDs nativos, referências XML por item, quantidades e unidades originais, produto associado **nullable**, origem/fator da conversão, estado atual, datas de registro/recebimento, instante da consulta e detalhe bruto. Local e indicação de movimentação devem ser preservados quando disponíveis; ausência fica explícita.

   **A estabilidade de `(nIdReceb, nSequencia)` não está provada pelo material.** Usaria identidade interna e unicidade externa pelo menos com empresa/conta, preservando também identificadores do item disponíveis no detalhe/XML. Testaria reconsulta, associação e reprocessamento. A mesma chave de NF com outro `nIdReceb` exige reconciliação antes de somar ambos.

   Como não chegam webhooks, é necessário revisitar recebimentos que sustentam candidatos, inclusive antigos. Só guardar a primeira conclusão não detecta reversões posteriores.

7. **[P1] O classificador ainda pode gastar a mesma quantidade recebida duas vezes.**

   **Cenário:** PO tem duas linhas do mesmo SKU, quatro unidades cada; NF contém quatro unidades → soma por SKU comparada separadamente com cada linha → ambas parecem completas → encerramento apaga quatro unidades legítimas.

   Outro cenário: contrato tem PO antigo fechado e PO novo aberto → NF do antigo satisfaz o novo porque a ambiguidade procura somente múltiplos POs **abertos**.

   **Correção:** conservar quantidade por item de recebimento, impedindo seu uso repetido. Considerar todos os POs relacionados ao contrato, inclusive fechados e fora da janela operacional, quando necessários para estabelecer propriedade da entrega. Contrato precisa de escopo de empresa e fornecedor; vínculo nativo conflitante bloqueia inferência por texto.

   A cobertura deve avaliar **todos os itens do PO**, inclusive SKUs desabilitados no motor. O encerramento afeta o pedido inteiro.

   **Não está demonstrado que `nQtde` e `nQtdeRecebida` sejam dimensionalmente comparáveis em todos os casos.** A razão 3,24 entre quantidade fiscal e recebida não prova essa equivalência. Exigir unidade do PO, unidade recebida, produto e conversão verificável; fator desconhecido não vira 1.

   Os testes precisam reprovar ausência de item, PO sem itens, conversão incompatível, produto desconhecido, duplicação de recebimento e reutilização de quantidade. Sabotar cada barreira deve tornar a suíte vermelha.

8. **[P1] Cobertura quantitativa cheia ainda não autoriza encerrar.**

   **Cenário:** NF concluída cobre dez unidades, mas o registro efetivo é futuro, não movimenta estoque ou foi revertido → classificador recomenda encerrar → dez unidades saem do pendente antes de estarem cobertas pelo físico lido → compra adicional.

   **Correção:** separar **cobertura quantitativa** de **elegibilidade para encerramento**. A segunda exige obrigação satisfeita e evidência compatível com o estoque considerado pelo motor. Esse requisito já consta no [ledger de agosto](docs/superpowers/specs/2026-08-13-reposicao-onorder-po-recebida-medicao.md:204).

   Não é obrigatório construir todo o `stock_posting` para capturar recebimentos ou investigar em sombra. Porém, sem essa prova ou verificação humana equivalente, `cheia` não deve aparecer como recomendação pronta para executar.

   Também rejeito a frase da §6 de que usar o espelho atual “só erra para o lado seguro”: sobrescrita subconta, mas atribuição incorreta e reutilização de itens também podem produzir falsa cobertura cheia.

9. **[P1] Envelhecimento e saída do conjunto aberto não demonstram correção.**

   **Cenário:** parcial fica indefinidamente em análise → fantasma continua suprimindo compra. No extremo contrário, vencimento de prazo transforma parcial em candidato a encerramento → saldo prometido desaparece.

   **Correção:** `parcial_envelhecido` abre investigação do saldo por SKU e confirmação do fornecedor; idade nunca completa quantidade. `nao_observado` precisa refletir cobertura efetiva das coletas, não apenas uma data inicial global. NF cancelada/revertida não contribui; uma substituta válida pode resolver a pendência sem manter ambiguidade eterna.

   O sensor de POs exibidos e posteriormente ausentes mede fluxo operacional. Ausência também pode resultar de mudança de previsão, falha de coleta ou outro tratamento no Omie.

   Registrar coorte de POs distintos, classe/versionamento da evidência, confirmação da situação posterior e unidades por SKU antes/depois. Manter os 191 SKUs no denominador de comparação. A sabotagem “todos abertos” precisa falhar contra controles com situação comprovada; pendente zero sozinho não basta, sobretudo sob deduplicação.

10. **[P1] O helper não protege o caminho real contra mudança de etapa.**

    **Cenário:** associação parcial muda a etapa de um PO com seis unidades restantes → a edge ignora o PO → grava pendente menor, embora o helper isolado tratasse a etapa desconhecida como problema.

    Isso está explícito no [descarte anterior ao cálculo](supabase/functions/omie-sync-estoque/index.ts:431). Há também divergência entre o comentário de fonte única do helper e a deduplicação ativa na edge.

    **Correção:** antes do piloto de associação, testar o percurso efetivo de coleta, filtros e aplicação. Etapa aberta desconhecida com saldo precisa gerar impedimento de publicação e sinal observável. Não basta testar uma função que recebe apenas os itens sobreviventes ao descarte.

11. **[P1] H-xPed permanece hipótese sobre o resolvedor do Omie.**

    **Cenário:** preencher `cNumPedido` não influencia o campo pesquisado pelo Omie → nenhum vínculo acontece; ou protocolo repetido e `nItemPed` incompatível associam ao item errado → recebimento de uma obrigação reduz outra.

    A documentação transcrita confirma o uso de `xPed`/`nItemPed`, mas não demonstra que preencher `cNumPedido` com o protocolo do fornecedor satisfaça o resolvedor.

    **Correção:** piloto prospectivo com um PO de baixo valor e baixa criticidade, contrato único e entrega realmente parcial. Para um pedido de dez unidades com primeira entrega de quatro, observar criação, importação, associação, conclusão e sincronização seguinte. Registrar IDs associados por item, unidades, situação, `cEtapa`, `nQtdeRec`, físico e contribuição ao pendente.

    Não medir apenas a etapa: **quando** `nQtdeRec` aumenta também importa. Se reduzir o saldo antes da entrada no físico, existe uma janela de subcontagem mesmo mantendo etapa 15. Após entrada refletida no físico, devem restar seis unidades legítimas.

    Um PO novo pode estar deduplicado por sete dias. Pendência zero nesse período não valida o piloto: verificar a contribuição antes da deduplicação e a transição para o saldo Omie. Um caso bem-sucedido libera somente esse cenário; não valida contratos duplicados, notas consolidadas ou outras conversões.

**Concordo:** Fase 0 sem escrita no Omie; situação observada antes da lista; soma de recebimentos conforme D1; captura das órfãs; classificador puro; lotes acompanhados por unidades de SKU.

**Discordo:** “só pode ser encerrado/cancelado”; 165 como teto comprovado; custo quase invariável das partições; espelho atual errando apenas por subcontagem; writer único global numa tabela que mistura PO e NF; `cheia` como autorização suficiente.

**Ordem de PRs recomendada para a Fase 0:**

1. **PR0:** observação por execução e reconciliação das contribuições do motor; confirmação seletiva de situações. Antes, corrigir a medição de “PO único” com psql/S1.
2. **PR(b):** captura passiva, versionada e idempotente de `receipt`/`receipt_item`, inclusive órfãs.
3. **PR(a1):** enum isolado, com commit confirmado.
4. **PR(a2):** ownership de situação/status por domínio e tratamento das views.
5. **PR(c1):** classificador em sombra, conservação de quantidades e testes de sabotagem.
6. **PR(c2):** lista staff com elegibilidade separada de cobertura e sensor por SKU.

A medição do PR0 decide quanto investir depois. Encerramento humano só após evidência e sensor; proteção da edge e piloto parcial antecedem qualquer expansão de H-xPed ou associação nativa.
```

</details>

### 16.2 Calibração (desta sessão — não é do Codex)

| achado | decisão | como entra |
|---|---|---|
| 1 — "PO único" medido errado; encerrado/cancelado não provado | **aceito** | §13.4 re-medida com PO distinto + de-dup (controle C fecha); a situação exata fica "fora do conjunto aberto, motivo não confirmado" |
| 2 — 165 un. não é teto | **aceito** | vira "estimativa"; coorte fixa de 191 SKUs e medição por SKU (excesso, falta, indeterminado) entram no PR0 |
| 3 — opção C (estoque observa + confirmação seletiva) | **aceito** | PR0 = o `omie-sync-estoque` grava o conjunto que leu e contou; ausência nunca vira "fechado"; confirmação de situação por sonda read-only |
| 4 — writer único de `status` só nos POs positivos | **aceito** | PR(a2): ownership por domínio (sync de POs nas linhas > 0; sync de NFs nas órfãs < 0); parcial não vira terminal; desconhecido não vira `CRIADO` |
| 5 — enum e views separados | **aceito** | PR(a1) só o `ADD VALUE`; views só depois de `pg_depend` + checagem de acesso externo |
| 6 — recebimento versionado, identidade não provada | **aceito** | PR(b): versão por leitura completa publicada atomicamente, detalhe bruto guardado, identidade interna + unicidade (empresa, nIdReceb, sequência) a validar em reconsulta |
| 7 — quantidade gasta 2×; contrato em PO fechado; unidade | **aceito em parte** | o caso "2 linhas do mesmo SKU" o rascunho já cobria (agrega por produto); os furos reais eram PO sem itens → `cheia` e contrato só em POs abertos — corrigidos e provados (32 testes, 22 sabotagens vermelhas) |
| 8 — cobertura ≠ elegibilidade | **aceito** | `cheia` ganha `elegibilidade`; só `elegivel` (movimenta estoque + físico lido depois da NF) aparece como "pronto para encerrar", e ainda com conferência humana |
| 9 — envelhecimento e sensor | **aceito** | `parcial_envelhecido` = investigar; sensor com coorte de POs e unidades por SKU antes/depois |
| 10 — a edge descarta etapa nova antes do helper | **aceito** | PR(d) de proteção: etapa aberta desconhecida com saldo bloqueia a publicação do pendente e sinaliza — pré-requisito de qualquer associação nativa |
| 11 — H-xPed é hipótese | **aceito** | fica na Fase 2 com o protocolo de piloto do Codex (PO de baixo valor, entrega parcial 10 → 4, medir `cEtapa`, `nQtdeRec` e o momento em que ele muda) |

**Ordem adotada no plano** (`docs/superpowers/plans/2026-09-26-baixa-po-fase-0.md`): a do Codex, com o PR(d) de
proteção em paralelo. O PR0 decide quanto investir depois: se a medição por SKU confirmar resíduo pequeno e sem
concentração perto da ruptura, os PRs (c1)/(c2) viram higiene de Omie de baixa prioridade.

## 17. Execução de D3 e D4 (2026-10-05 — o founder delegou: "Faça o D3 e D4")

### 17.1 D3 — backlog: decidido "encerrar à mão, guiado pela lista"

- **Decisão** (a recomendação da §15): o backlog — POs com NF concluída que o motor **ainda conta** — é encerrado
  **à mão** no Omie. Motivo: `Recebido pela(s) NF(s) nnn — encerrado sem associação (Afiação)`. Só vale para PO com
  cobertura cheia **conferida item a item na NF**, em lotes (D2) e com revisão do ciclo seguinte do motor antes de
  aprovar compras.
- **Por que não "reverter + associar + concluir":** desfaria e refaria o estoque e o contas a pagar de NFs já fechadas,
  um risco operacional maior que o ganho. O custo aceito é o relatório do Omie mostrar esses POs como "Encerrado", e
  não como "Recebido".
- **Pré-requisito não negociável: saber QUAIS POs o motor conta.** Só o PR0 dá isso. Ele está em implementação numa
  sessão separada desde 2026-10-01 e, em 2026-10-05, ainda não tinha PR nem tabela no banco. Sem o PR0, a lista sairia
  do espelho, que é cego à situação (§13.4) — a maior parte dos 273 POs "com NF" já está fora do "a caminho".
- **Quem faz:** a equipe de compras/recebimento encerra no Omie. A sessão **não** encerra PO: a ação é irreversível,
  só existe na interface e não tem API (§14 F1).
- **Lote 1 — rodar assim que o PR0 publicar o 1º run completo** (provisório até a lista do PR(c2); a execução em PG17
  contra o schema do PR0 está registrada no PR desta seção):

```sql
WITH ultimo AS (
  SELECT run_id FROM reposicao_po_observado_run
  WHERE empresa = 'OBEN' AND varredura_completa AND pendente_aplicado
  ORDER BY concluido_em DESC LIMIT 1
), contados AS (
  SELECT o.omie_codigo_pedido, sum(o.contribuicao) AS unidades_no_motor
  FROM reposicao_po_observado_item o JOIN ultimo u ON u.run_id = o.run_id
  WHERE o.exclusao IS NULL AND o.contribuicao > 0
  GROUP BY 1
)
SELECT t.numero_pedido AS po, t.numero_contrato_fornecedor AS contrato, t.nfe_numero AS nf_mais_recente,
       t.t4_data_recebimento::date AS nf_concluida_em, c.unidades_no_motor,
       (SELECT string_agg((p->>'nCodProd') || ' x ' || (p->>'nQtde'), ', ')
          FROM jsonb_array_elements(t.raw_data->'produtos_consulta') p) AS itens_do_po,
       (SELECT count(*) FROM purchase_orders_tracking o
         WHERE o.empresa = t.empresa AND o.omie_codigo_pedido > 0
           AND o.numero_contrato_fornecedor = t.numero_contrato_fornecedor
           AND o.omie_codigo_pedido <> t.omie_codigo_pedido) AS outros_pos_do_contrato
FROM contados c
JOIN purchase_orders_tracking t ON t.empresa = 'OBEN' AND t.omie_codigo_pedido = c.omie_codigo_pedido
WHERE t.t4_data_recebimento IS NOT NULL
ORDER BY c.unidades_no_motor DESC, t.t4_data_recebimento;
\echo FIM-MEDICAO-OK
```

- **Conferência humana antes de cada encerramento:**
  1. Abrir no Omie **todas** as NFs do contrato — o espelho guarda só a mais recente (`nf_mais_recente`).
  2. Conferir cada item do PO contra os itens das NFs: produto e quantidade na unidade do produto. Se a NF vier em L e o
     PO em UN, conferir a conversão.
  3. Se faltar item ou quantidade, **não encerrar**: o saldo vem em outra NF (D1).
  4. Com `outros_pos_do_contrato > 0`, não encerrar sem entender se é PO duplicado ou dividido (§13.5, V4).
- **Depois de cada lote:** rodar a Task 0.5 do plano (unidades por SKU) e revisar o ciclo seguinte. Uma rajada de
  sugestões é esperada: é compra suprimida sendo recuperada.

### 17.2 D4 — o piloto como formulado foi refutado pela documentação; substituído pelo D4'

- **Evidência (doc oficial, lida em 2026-10-05,
  `https://ajuda.omie.com.br/pt-BR/articles/498834-preenchendo-o-xped-e-o-nitemped`):**
  - Sobre o `xPed`: "O campo xPed indica o número do Pedido de Compra que você enviou ao seu Fornecedor. Assim que você
    cadastra um Pedido de Compra no Omie, o sistema gera automaticamente esse número de forma sequencial."
  - Sobre o `nItemPed`: o fornecedor tem de respeitar a sequência dos itens do nosso pedido.
  - Logo, o resolvedor do Omie casa o `xPed` com o **número sequencial do nosso PO** (`cNumero`), e não com o
    `cNumPedido`. Preencher o `cNumPedido` com o protocolo não muda nada: o D4 original foi **cancelado sem gastar PO
    real**.
- **Pista para a Fase 2 (H-xPed v2):**
  - A resposta do portal Sayerlack à criação do pedido traz `nr_pedido_cliente` e `data.ordercust`, capturados em
    15/05/2026 (`enviar-pedido-portal-sayerlack/index.ts:210-213`), e a automação hoje não preenche nada disso.
  - Se o formulário aceitar o **nosso** número de PO e a Sayerlack o repetir no `xPed`, com o `nItemPed` na ordem dos
    nossos itens, o Omie vincularia sozinho.
  - Custo: criar o PO no Omie **antes** do portal (hoje é depois, porque o `cContrato` precisa do protocolo) — mudança
    grande no disparo, money-path.
  - Medir antes, com 1 pedido manual no portal com o campo preenchido: (a) o formulário tem o campo? (b) a Sayerlack o
    leva ao `xPed`?
- **D4' — o substituto, que mede de verdade o F3:** associação **nativa** manual em 1 NF Sayerlack pendente, feita pela
  equipe no recebimento — o mesmo gesto que ela já faz com outros 20 fornecedores (§13.5).
  - **Alvo:** NF **000953881** (faturada em 02/10; pendente no Omie em 05/10 às 12:35Z, com o sync de NFs rodando às
    12:15Z e 12:35Z). Ela cobre os POs 1238, 1244, 1248 e 1254. O piloto mexe **só no PO 1244**: 1 item, SKU
    `8689783623` (VERNIZ PU FOSCO FO20.6717.00), 2 un., R$ 1.021, contrato 2132614 único.
  - **Passo a passo no Omie, quando a mercadoria chegar:**
    1. No recebimento da NF 000953881, selecionar o item do VERNIZ FO20.6717.00.
    2. Clicar em "Associar a um produto existente", depois em "Exibir todos os produtos não recebidos".
    3. Selecionar o item do pedido **1244** e confirmar.
    4. Concluir a NF como de costume.

    Associar e concluir **juntos**: assim não se abre janela entre a baixa do "a caminho" e a entrada no físico. Os
    outros itens da NF seguem como hoje.
  - **Linha de base (05/10):** PO 1244 (`nCodPed` 12188607830) em etapa 15, item `12188607832` com `nQtdeRec = 0`. SKU
    com físico 0, pendente 2, ponto de pedido 3, máximo 4.
  - **O que medir depois:**
    - `cEtapa` e `nQtdeRec` do PO 1244 no espelho, no próximo sync de POs;
    - pendente e físico do SKU no próximo run do estoque (aos :40 das 9–19h UTC);
    - se o PO sai do conjunto aberto (com o PR0 no ar, pela observação).
  - **Query de antes/depois** (a linha de base acima saiu dela; rodar com `psql-ro -X -v ON_ERROR_STOP=1 -f` e exigir
    o marcador):

    ```sql
    SELECT t.numero_pedido AS po, t.omie_codigo_pedido, t.raw_data->'cabecalho_consulta'->>'cEtapa' AS etapa,
           (p->>'nCodItem') AS id_item, (p->>'nCodProd') AS sku, (p->>'nQtde')::numeric AS qtde,
           (p->>'nQtdeRec')::numeric AS qtde_rec, t.nid_receb, t.t4_data_recebimento AS t4, t.updated_at
    FROM purchase_orders_tracking t CROSS JOIN LATERAL jsonb_array_elements(t.raw_data->'produtos_consulta') p
    WHERE t.empresa = 'OBEN' AND t.numero_pedido = '1244';
    SELECT e.sku_codigo_omie, e.estoque_fisico, e.estoque_pendente_entrada, e.ultima_sincronizacao, sp.ponto_pedido, sp.estoque_maximo
    FROM sku_estoque_atual e JOIN sku_parametros sp ON sp.empresa = 'OBEN' AND sp.sku_codigo_omie::text = e.sku_codigo_omie
    WHERE e.empresa = 'OBEN' AND e.sku_codigo_omie = '8689783623';
    \echo FIM-MEDICAO-OK
    ```

  - **Sucesso:** `nQtdeRec = 2`; o pendente do SKU cai 2 **no mesmo run** em que o físico sobe 2; e o `cEtapa` novo
    fica registrado (responde o F3).
  - **Sinal de risco:**
    - se o pendente cair **antes** de o físico subir, há janela de subcontagem;
    - se o `cEtapa` mudar com saldo aberto, é o caso parcial — exige o PR(d) antes de qualquer automação.
  - **Se der certo:**
    1. A equipe passa a associar as NFs Sayerlack no recebimento: zero código, e o backlog para de crescer.
    2. A Fase 2 automatiza o mesmo gesto (`AlterarRecebimento` com `ASSOCIAR-PEDIDO`).
    3. Um 2º piloto com entrega **parcial** fecha o caso que o Codex marcou como de risco (§16, achado 11).

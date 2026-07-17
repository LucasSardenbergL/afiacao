# Fase 0 — Spike go/no-go da captura de preços Sayerlack (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. Este plano é **exploratório-empírico** (browser + verificação em banco): executar INLINE na sessão, não via subagente (exige possível intervenção do founder no login e leitura visual do portal).

**Goal:** Provar (ou refutar) no portal Sayerlack real os 3 critérios do gate da spec: (1) preço QT/GL legível de forma inequívoca num rascunho não-efetivado; (2) rascunho limpável explicitamente; (3) nenhum pedido (PO) nasce do processo. Colher os seletores/colunas reais para a edge da Fase 1.

**Architecture:** Spike em duas camadas — **spike-A** (este plano): sessão de browser no portal real, espelhando o que a edge fará, com verificação antes/depois em `purchase_orders_tracking`/portal; **spike-B** (Fase 1): primeiro run da edge `sayerlack-captura-precos` em modo 1-grupo antes de ligar o cron. O spike-A responde o go/no-go do PORTAL (comportamento de rascunho/preço/limpeza); o ambiente Browserless já é provado pelo fluxo de envio em produção.

**Tech Stack:** Browser (sessão logada do founder), `~/.config/afiacao/psql-ro` (read-only), evidência por screenshot.

## Global Constraints

- **NUNCA clicar "Efetivar Pedido" (`#btnSalvarNovoPedido`)** — em nenhuma circunstância; é o único controle que coloca pedido no fornecedor.
- **Não digitar senha**: se a sessão do portal não estiver logada, o founder loga (regra de credencial).
- Money-path: nenhum número fabricado — o que não for lido de forma inequívoca é registrado como "não confirmado".
- Se qualquer critério do gate falhar → **scraping sai do roadmap** (registro da decisão + fica o manual), conforme spec de junho e de 2026-07-14.
- SKU de teste: grupo WP01.3900 (QT `8689775044` fator 1 · GL `12078998671` fator 4 — par ativo em `sku_embalagem_equivalencia`, de-para em `sku_fornecedor_externo`).

---

### Task 1: Baseline pré-spike (banco + portal)

**Files:** nenhum (leitura).

**Interfaces:**
- Produces: `baseline_pos` (contagem e max de PO no espelho) e lista de POs visíveis no portal — comparados na Task 4.

- [x] **Step 1: Baseline do espelho de POs (psql-ro)**

Run:
```bash
~/.config/afiacao/psql-ro -c "\d purchase_orders_tracking" | head -20
~/.config/afiacao/psql-ro -c "SELECT count(*) AS total, max(created_at) AS ultimo FROM purchase_orders_tracking;"
```
Expected: descrição da tabela + baseline `{total, ultimo}` anotado no chat. (Se os nomes de coluna divergirem, usar os reais — o critério é ter um antes/depois estável.)

- [x] **Step 2: Confirmar de-para dos 2 SKUs de teste**

Run:
```bash
~/.config/afiacao/psql-ro -c "SELECT sku_omie, sku_portal, ativo FROM sku_fornecedor_externo WHERE empresa='oben' AND fornecedor_nome ILIKE 'sayerlack%' AND sku_omie IN ('8689775044','12078998671');"
```
Expected: 2 linhas ativas com os `sku_portal` que serão digitados no select2. Anotar os códigos.

- [x] **Step 3: Registrar POs visíveis no portal (pré)**

No browser, na área logada do portal: abrir a listagem de pedidos e capturar screenshot da primeira página (protocolos/datas visíveis). Anotar o protocolo mais recente.

### Task 2: Rascunho com QT+GL e leitura de preço (o coração do spike)

**Files:** nenhum (portal).

**Interfaces:**
- Produces: preços lidos de QT e GL (R$/embalagem), mapa de colunas do `#datatable_itens` (índice da coluna de preço unitário/total/Prz Ent), seletor do botão de remover item — insumos do plano da Fase 1.

- [x] **Step 1: Login/entrada** — navegar ao portal (`SAYERLACK_PORTAL_URL` dos bookmarks do founder); se deslogado, founder loga.

- [x] **Step 2: Novo pedido + cliente** — iniciar novo pedido; selecionar o cliente OBEN no select2 de cliente (`#select2-cliente-container`), como a edge de envio faz.

- [x] **Step 3: Adicionar QT com qtde 1** — select2 de item: digitar o `sku_portal` do QT (Task 1/Step 2); selecionar a opção; qtde `1`; gravar item (`#btnGravarItem`). Screenshot da linha no `#datatable_itens`.

- [x] **Step 4: Adicionar GL com qtde 1** — idem para o GL. Screenshot.

- [x] **Step 5: Ler e conferir os preços** — ler do datatable o valor por linha; conferir contra os últimos preços manuais do banco:

```bash
~/.config/afiacao/psql-ro -c "SELECT sku_codigo_omie, preco, capturado_em FROM sku_preco_fornecedor_capturado WHERE empresa='oben' AND sku_codigo_omie IN ('8689775044','12078998671') ORDER BY capturado_em DESC LIMIT 4;"
```
Expected: preço do portal ≈ preço manual de hoje (founder digitou hoje; pequena divergência = ele arredondou ou reajuste — anotar). **Critério (1) do gate:** fica inequívoco QUAL campo é o preço por embalagem (não por litro/subtotal). Anotar o índice/header exato das colunas.

- [x] **Step 6: Testar busca sem resultado (embalagem inativada)** — no select2 de item, digitar um código inexistente (ex. `ZZZTESTE`) e registrar o comportamento (mensagem "nenhum resultado"/`.select2-results__message`). Se o founder souber um código WP realmente inativado, usar também esse. Screenshot. Insumo do `nao_encontrado` da Fase 1.

### Task 3: Limpeza explícita do rascunho

**Files:** nenhum (portal).

**Interfaces:**
- Produces: procedimento de limpeza reproduzível pela edge (seletores de remover item / descartar rascunho) — **critério (2) do gate**.

- [x] **Step 1: Remover os 2 itens** — localizar o controle de exclusão por linha no `#datatable_itens` (ícone/botão de remover), remover GL e QT; screenshot do datatable vazio. Anotar o seletor.
- [x] **Step 2: Abandonar** — navegar para fora da tela de pedido SEM efetivar.
- [x] **Step 3: Verificar que não sobrou rascunho ativo** — voltar à área de pedidos/rascunhos do portal e confirmar que não há rascunho pendente do run (ou que o rascunho vazio é inócuo). Screenshot. Se o portal exibir rascunho pendente NÃO-limpável → anotar como risco (a spec de junho manda cleanup explícito; auto-expire é rede, não plano).

### Task 4: Verificação pós-spike — nenhum PO nasceu (critério 3)

**Files:** nenhum (leitura).

**Interfaces:**
- Consumes: `baseline_pos` da Task 1.

- [x] **Step 1: Espelho inalterado**

Run:
```bash
~/.config/afiacao/psql-ro -c "SELECT count(*) AS total, max(created_at) AS ultimo FROM purchase_orders_tracking;"
```
Expected: idêntico à baseline (nenhum PO novo).

- [x] **Step 2: Portal inalterado** — re-abrir a listagem de pedidos do portal; protocolo mais recente = o mesmo da Task 1/Step 3. Screenshot.

### Task 5: Relatório go/no-go + registro

**Files:**
- Modify: `docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md` (status da Fase 0 + achados empíricos: colunas do datatable, seletor de remoção, comportamento do select2 vazio)

- [x] **Step 1: Redigir veredito no chat** — os 3 critérios com evidência (screenshots + queries); decisão GO (→ escrever plano da Fase 1 com os seletores colhidos) ou NO-GO (→ registrar que o scraping sai do roadmap; manual permanece).
- [x] **Step 2: Anexar achados à spec** — seção "Achados do spike-A (2026-07-14)" com os dados empíricos.
- [x] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md docs/superpowers/plans/2026-07-14-sayerlack-captura-preco-fase0-spike.md
git commit -m "docs(reposicao): resultado do spike-A da captura de preços Sayerlack (Fase 0)"
```

## Fora deste plano

Fases 1 (edge+cron+run-log), 1.5 (sensor), 2 (UI+vigia) e 3 (credencial) ganham plano próprio APÓS o gate — o código delas depende dos achados das Tasks 2–3.

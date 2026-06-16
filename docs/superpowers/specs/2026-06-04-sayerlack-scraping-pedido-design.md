# Scraping do pedido Sayerlack: valida grupo (Prz Ent) + captura custo

**Data:** 2026-06-04
**Status:** design (aguardando revisão do founder → writing-plans)
**Módulo:** reposição / portal Sayerlack
**Arquivos-alvo:** `supabase/functions/enviar-pedido-portal-sayerlack/index.ts`, `supabase/functions/disparar-pedidos-aprovados/index.ts`, novo helper puro em `src/lib/reposicao/`.

## Problema

Quando a automação lança um pedido no portal Sayerlack, dois buracos money-path:

1. **Grupo/mapeamento errado vira compra do produto errado.** A automação digita o `sku_portal` (do de-para `sku_fornecedor_externo`) no select2 e clica **na primeira opção** do resultado, **sem conferir** que o produto é o esperado (`index.ts:815` → `:830`). Um de-para errado → compra o produto errado, sem rede. O founder pegou na mão: o **"Prz Ent" (Prazo de Entrega)** que o portal mostra por item não batia com o lead time que ele setou no grupo do produto.

2. **Custo do pedido não reflete o custo real do fornecedor.** O `preco_unitario` vem do motor de geração (`COALESCE(preco_medio, inventory_position.cmc, 0)`) — uma estimativa. O pedido no Omie sai com essa estimativa; quando a NF-e é faturada, o pedido de compra não bate com a nota (sem conferência 3-way confiável). O portal **mostra o custo real** por item (o founder hoje copia à mão).

Ambos os sinais já existem no portal e aparecem **por produto, assim que o item é salvo** (antes do Efetivar). Logo, um único passe de scraping no `#datatable_itens` resolve os dois.

## Objetivo

No run do portal, **antes de efetivar**, ler `#datatable_itens` uma vez (por linha: `sku_portal`, `prz_ent`, `total_linha`) e:

- **B (trava de segurança):** validar `prz_ent == lt_producao_dias` do grupo, exato. Qualquer divergência → **bloquear o pedido inteiro** (não efetivar), marcar os itens suspeitos, avisar. Nada é comprado.
- **A (enriquecimento de custo):** se B passar e o Efetivar suceder, derivar `preco_unitario = total_linha / qtde_final` e sobrescrever os itens, pra o pedido no Omie sair com o custo do portal (== NF-e futura).

## Pré-requisito

O disparo ao portal precisa estar funcionando. O claim atômico estava quebrado (`.update().or()` no PostgREST → `42703`), consertado na main pelo **PR #592** (RPC `envio_portal_claim_ids`, migration `20260604150000`). **Requer redeploy da edge** `enviar-pedido-portal-sayerlack`. Sem isso, nenhum pedido vai ao portal e nada deste spec roda.

## Modelo de dados (já existe)

- `pedido_compra_sugerido.grupo_codigo` — o grupo do pedido (um por pedido).
- `fornecedor_grupo_producao(empresa, fornecedor_nome, grupo_codigo)` → **`lt_producao_dias` (int)** + `lt_producao_unidade` (default `'uteis'`). É o lead time que o founder edita na tela de Grupos de Produção.
- `sku_grupo_producao(empresa, sku_codigo_omie)` → `grupo_codigo` (assignment do SKU ao grupo).
- `sku_fornecedor_externo(empresa, fornecedor_nome, sku_omie)` → `sku_portal`, `fator_conversao`, `unidade_portal`, `ativo`. De-para. **Único por `sku_omie`, NÃO por `sku_portal`.**
- `pedido_compra_item(pedido_id, sku_codigo_omie, sku_descricao, qtde_final, preco_unitario, valor_linha)`.
- `pedido_compra_sugerido`: `status_envio_portal`, `portal_erro`, `portal_resposta` (jsonb), `omie_pedido_compra_numero`, `valor_total`.
- No run, a função já carrega `itensList` (`index.ts:1448-1599`): por item já tem `item_id ↔ sku_codigo_omie ↔ sku_portal ↔ qtde_final`. **Reusar isso** — é o lado "esperado" do match.

## Arquitetura — onde encaixa

Fluxo atual do `runFlow` (browser): adiciona cada item (`#btnGravarItem` → `save-tab-preco-session`, a linha aparece em `#datatable_itens`) → espera "Validando data de entrega" assentar (`index.ts:929-942`) → clica **Efetivar** (`#btnSalvarNovoPedido`) → protocolo. Na máquina de estados, `sucesso_portal` (`index.ts:1814`) chama `registrarPedidoOmieAposPortal(pedido)` (`:1817`), que re-invoca o `disparar` pra criar o pedido no Omie lendo `pedido_compra_item`.

Novo fluxo:

1. **Adiciona todos os itens** (loop atual, intocado).
2. Espera a validação de data assentar (atual).
3. **Scraping único do `#datatable_itens`** → `linhasPortal: [{ sku_portal, prz_ent, total_linha }]`. (Por produto, já presente — confirmado pelo founder.)
4. **🚦 Gate B (validação de grupo):** para cada item de `itensList`, casa com a linha do portal por `sku_portal` e checa `prz_ent === ltEsperado`. `ltEsperado` = `lt_producao_dias` do `pedido.grupo_codigo` (lookup único em `fornecedor_grupo_producao`). Se **qualquer** item divergir (ou não casar):
   - **NÃO clica Efetivar.** Retorna envelope `success:false`, `erroTipo:'GRUPO_LEADTIME_MISMATCH'`, `requestSent:false`, com a lista de suspeitos (`sku_codigo_omie`, `sku_descricao`, `prz_ent_portal`, `lt_esperado`).
   - `buildEnvelope` mapeia erro lógico pré-submit (igual `SKU_NOT_FOUND`) → **`status_envio_portal='erro_nao_retentavel'`** + `portal_erro="Grupo errado (Prz Ent ≠ lead time do grupo): <lista>"`. O motor de retry já exclui `erro_nao_retentavel`; o Sentinela `reposicao_portal_humano` já o mostra → o founder é avisado, e o pedido **não** é re-disparado sozinho.
   - **Nada é comprado** (requestSent=false). O founder corrige o de-para/grupo e re-dispara.
   - **Bloqueia SÓ em divergência CONFIRMADA** (`prz_ent` parseado, inteiro, `!=` `ltEsperado`). Quando **não dá pra validar** o gate é **fail-OPEN com flag alto** (não bloqueia), pra um bug de seletor ou config faltante não travar TODO pedido (DoS no founder):
     - `pedido.grupo_codigo` null ou sem `lt_producao_dias` configurado → não há "esperado" → não valida, registra `validacao_grupo_pulada` em `portal_resposta`, segue pro Efetivar.
     - Scraping não leu nenhuma linha / não conseguiu parsear o `Prz Ent` (seletor mudou) → checagem **indisponível**, não bloqueia, registra `validacao_grupo_indisponivel` (alto, pra o founder saber que a trava não rodou).
     - Item que não casou no portal (`naoCasado`) ou `sku_portal` ambíguo → trata como **indisponível pra aquele item** (flag), não como mismatch confirmado — não bloqueia o pedido por incerteza de tooling.
5. Se o gate **passa** (ou foi indisponível) → clica **Efetivar** → protocolo → `sucesso_portal`.
6. **Captura de custo A:** no `sucesso_portal`, **antes** de `registrarPedidoOmieAposPortal`, com as `linhasPortal` do passo 3:
   - por item, `precoNovo = total_linha / qtde_final` (qtde_final = qtde Omie, inalterada — confirmado);
   - **tolerância no TOTAL da linha:** se `round(total_linha, 2) === round(qtde_final * preco_atual, 2)` → **mantém** o atual (não sobrescreve); senão sobrescreve `preco_unitario = precoNovo` (precisão cheia, sem arredondar pra 2 casas) + `valor_linha = total_linha`;
   - recalcula `pedido.valor_total = Σ total_linha`;
   - guarda `portal_resposta.custos_capturados` (totais crus + custo anterior por item) pra auditoria.
7. `registrarPedidoOmieAposPortal → disparar` lê `pedido_compra_item` já atualizado → Omie sai com o custo do portal.

**B é trava dura ANTES do Efetivar; A só roda DEPOIS que o Efetivar sucedeu.** Os dois comem do mesmo scraping (passo 3). Se B bloqueia, A nunca roda (não há pedido).

## Helper puro (TDD) — `src/lib/reposicao/sayerlack-scraping-pedido.ts`

Oráculo que a edge espelha. Sem I/O.

- `casarLinhasComItens(linhasPortal, itens)` → `{ casados: [{item, linha}], naoCasados: item[], sku_portal_ambiguo: [...] }`. **Itera os ITENS** e busca a linha por `sku_portal` (não reverte por `sku_portal`, que não é único). Se um `sku_portal` casar com >1 item OU >1 linha → marca ambíguo e **não** aplica (nem custo, nem validação confiante naquele).
- `validarGrupoLeadtime(casados, ltEsperado)` → `{ status: 'ok' | 'mismatch' | 'indisponivel', mismatches: [{ sku, prz_ent, lt_esperado }], pulados }`. Igualdade **exata** de inteiro. **Só `mismatch` bloqueia** (≥1 item parseado com `prz_ent != ltEsperado`). `ltEsperado` ausente, nenhum item parseável, `naoCasados`/`ambiguos` → `indisponivel`/`pulado` (flag, **não** bloqueia — ver "fail-OPEN" no gate). Distinguir incerteza de tooling de divergência real é o ponto central.
- `derivarCustos(casados)` → `{ updates: [{ item_id, preco_unitario, valor_linha }], pulados }`. Aplica a tolerância de total-da-linha; guarda contra `qtde_final<=0`/`total_linha<=0` (pula + flag). Precisão cheia.
- `parseBRL(str)` / `parseDiasPrzEnt(str)` — parsing robusto do texto do portal (BRL pt-BR `1.234,56`; Prz Ent inteiro de dias).

Edge importa nada de `src/` (Deno) → o helper é espelhado **verbatim** na edge, e os testes vitest cobrem o oráculo.

## Tratamento de falha (A)

Best-effort, anti-órfão (o pedido já foi efetivado quando A roda):
- Linha sem total parseável → mantém o custo atual + flag em `portal_resposta`. **Nunca** segura o Omie se os custos forem `>0`.
- Item de primeira compra que ficou em 0 (não capturou) → cai no guard de preço-0 que já existe no `disparar` → recuperação manual de hoje (founder define custo + re-dispara; o `already_sent` pula o portal).
- **Idempotência:** se `omie_pedido_compra_numero` já existe (Omie já criado), **não** regrava custo — protege contra retry/re-disparo/watchdog reaplicarem.

## Não-objetivos (v1)

- Auditoria periódica de TODO o de-para (a checagem é no pedido, on-demand — o Prz Ent vem de graça no run).
- Status dedicado pro bloqueio de grupo (reusa `erro_nao_retentavel` + mensagem clara; status próprio = migration + UI + Sentinela, fica pra v2 se o bucket confundir).
- UI nova de comparação estimado×portal×NF-e (o dado fica em `portal_resposta` pra auditoria; diff visual é v2).
- Validar por descrição/categoria (o Prz Ent é o sinal limpo e exato).
- Capturar quantidade (o founder confirmou que não muda).
- `lt_producao_unidade` ≠ `'uteis'`: assume úteis (o founder confirmou "exatamente igual" na mesma unidade); grupo com unidade diferente → flag de "unidade inesperada", não compara às cegas.

## Detalhes a confirmar na implementação (empírico, num run de teste)

- Seletores exatos das colunas `Prz Ent` e total no `#datatable_itens` (índice da coluna), e o seletor do `sku_portal`/código por linha. Verificar lendo o DOM num run real (o `/browse` headless não renderiza; usar os logs/trace da edge ou um run de teste).
- Confirmar que `prz_ent` e `total_linha` estão na MESMA linha que o código do produto (pra casar com `sku_portal`).

## Critério de pronto

- Gate B: pedido com 1 item de Prz Ent divergente **não efetiva**, vira `erro_nao_retentavel` com a lista de suspeitos; pedido 100% correto efetiva normal.
- Captura A: com snapshot válido, `pedido_compra_item.preco_unitario` reflete `total_linha/qtde_final`; `Σ qtde_final*preco_unitario == Σ total_linha` (fecha com o portal); o Omie sai com esses custos.
- Helper puro com testes vitest (casamento, ambiguidade, validação exata, tolerância, parsing).
- Codex adversarial no código antes do merge (money-path).

## Refinos do Codex (consult 2026-06-04, já incorporados em A)

- Mapear iterando os itens (de-para não é único por `sku_portal`) + guarda de ambiguidade/duplicado.
- Não arredondar o unitário pra 2 casas (precisão pro total fechar); tolerância no total da linha, não no unitário.
- Idempotência (não regravar após `omie_pedido_compra_numero`).
- `fator_conversao` fora da divisão (só afeta a qtde do portal; dividir pela qtde Omie fecha o total).
- Sequenciar separado do hotfix do claim (já feito: #592 na main).

# Painel "Baixo giro & estoque parado" (Reposição / Oben) — design

> Data: 2026-06-06 · Status: spec revisado após challenge do Codex (gpt-5.5) · aguardando OK do founder pro plano
> Origem: founder pediu (1) manter mín 1 / máx 2 nos itens de baixo giro sem parâmetro, e (2) "um lugar pra ver os itens parados/menor giro e decidir o que fazer com eles comercialmente".
> Decisões delegadas pelo founder a "Claude + Codex". Este spec já incorpora o veredito do Codex (ver §13).

## 1. Problema

A cauda de baixo giro da Oben é cega e ingerenciável pela UI:

- O Cockpit mostra "**164 SKU(s) sem histórico para cálculo automático (baixo giro / 1ª compra)**" (`SmartAlertsSection.tsx:23` — `sku_parametros` com `empresa='OBEN'`, `ativo=true`, `estoque_minimo IS NULL`), mas "Ver candidatos" leva a um filtro que mostra **0** (a aba "Ajuste manual" exclui `estoque_minimo IS NULL` em `useRevisaoParametros.ts:185`). O founder **não acha onde mexer**.
- Não existe visão de **capital imobilizado** em itens que não giram.
- Não há um lugar que junte **diagnóstico + decisão** da cauda.

### Por que os 164 estão "sem parâmetro" (causa real, corrigida da v1 do spec)

Não é deficiência da média. O recálculo (`atualizar_parametros_numericos_skus`, hoje a "core instrumentada" de `20260605130000`) só preenche `ponto_pedido`/`estoque_minimo`/`estoque_maximo` quando `v_sku_parametros_sugeridos.status_sugestao = 'OK'`. Os 164 estão num **bloqueio de status**:

- `AGUARDANDO_SEGUNDA_ORDEM` (< 2 compras)
- `SEM_PRECO`
- `AGUARDANDO_HABILITACAO_FORNECEDOR`
- `SEM_LEADTIME_DEFINIDO`
- `AGUARDANDO_CLASSIFICACAO_GRUPO`

→ Para muitos, a ação certa **não** é "forçar 1/2 na mão", é **resolver o bloqueio** e deixar o motor cuidar (a regra de baixo giro já dá parâmetros pequenos quando o item chega a `OK`). Forçar 1/2 é para itens que o founder decide manter por **sortimento** mesmo sem dado.

### O cron NÃO zera mais (premissa da v1 do spec estava stale)

Desde `20260531140000`, a função usa **COALESCE**: quando a sugestão é NULL (status != OK), **preserva o valor existente** (não zera). A core (`20260605130000`) formaliza isso como o ramo `sem_mudanca` — config só é sobrescrita quando `status='aplicado'`. **Consequência:** um 1/2 setado à mão num item bloqueado **persiste sozinho**; o motor só reassume quando o item ganha dado real (vira `OK`). Isso elimina a necessidade de qualquer "trava" (ver §7).

## 2. Objetivo

Tela na Reposição que dá **visão + decisão** sobre a cauda de baixo giro da Oben:

1. **Ver** capital parado e o que não gira — com o **porquê** de cada item não repor.
2. **Decidir** por item ou em lote: resolver o bloqueio, manter em estoque (mín 1 / máx 2), ou descontinuar.
3. **Resolver os 164** pela própria tela, com **preview do impacto** (não às cegas).

## 3. Escopo

**Universo (in):** SKUs da reposição Oben (`sku_parametros`, `empresa='OBEN'`, `ativo=true`) que sejam **baixo giro pelo critério canônico** OU **sem parâmetro** (`estoque_minimo IS NULL`). Critério canônico (reusar — `migrations/20260513233141`):

```
(LEFT(classe_abc,1) IN ('B','C') AND classe_xyz IN ('Y','Z'))
OR COALESCE(demanda_media_diaria, 0) < 0.05
```

**Fora (não-objetivos v1):**
- **Promoção / liquidação de venda pro cliente** — sai da v1. As tabelas `promocao_campanha`/`promocao_item` são **desconto de COMPRA do fornecedor** (alteram preço de `pedido_compra_item` e podem *aumentar* compra via forward_buying — `migrations/20260606170000`). Usá-las para "queimar encalhe" faria o oposto. Liquidação pro cliente é domínio de **venda/preço** — Fase 2 separada, no módulo certo (confirmar se existe antes de prometer).
- **Fixar 1/2 rígido contra o motor** quando o item TEM dado (status OK). Não é requisito (founder quer o motor reassumir quando gira). Se um dia precisar, usar o mecanismo de pin/revert que já existe, ou um `modo_parametros=manual_fixo` na core. YAGNI agora.
- Colacor / Colacor SC (só Oben na v1).
- Mexer na core `param_auto` / no money-path do recálculo (o design não exige).

## 4. Onde vive
Item próprio no menu **Reposição**, rota `/admin/reposicao/baixo-giro`. Gate: staff de reposição (mesmo das outras telas).

## 5. O painel

### 5.1 Topo (visão executiva)
- **Capital parado na cauda**: `Σ (saldo × cmc)` dos itens com `saldo > 0` **e `cmc > 0`**. ⚠️ `cmc` NULL/0 **não** vira zero — exibir "R$ X conhecido **+ N SKUs sem custo**" (senão o KPI subestima o problema — achado Codex).
- Contagem: nº de itens na cauda · nº com estoque parado · nº sem custo conhecido.

### 5.2 Tabela (diagnóstico por item)

| Coluna | Fonte | Para quê |
|---|---|---|
| SKU + descrição + fornecedor + classe | `sku_parametros` | identificar |
| **Capital parado** = saldo × cmc | `inventory_position` (`saldo`, `cmc`, `account='oben'`) | R$ imobilizado (ordenação padrão); marcar "sem custo" quando cmc nulo |
| Estoque atual (saldo) | `inventory_position.saldo` | quanto tem |
| **Dias sem vender** | `CURRENT_DATE - max(venda_items_history.data_emissao)` | sinal de encalhe |
| Giro (vendas 90d, demanda/dia) | `sku_parametros` | quanto gira |
| **Situação** (por que não repõe) | `v_sku_parametros_sugeridos.status_sugestao` | OK / SEM_PRECO / SEM_LEADTIME / AGUARDANDO_* |
| Estado (mín/PP/máx, ligado?) | `sku_parametros` | estado atual de reposição |

### 5.3 Filtros (eixos independentes, não baldes exclusivos — correção Codex)
"Sem parâmetro" (`estoque_minimo IS NULL`, os 164) **≠** "sem estoque" (`saldo=0`) — são eixos diferentes. Facetas:
- **Situação** (bloqueio): sem preço / sem fornecedor / aguardando 2ª ordem / aguardando grupo / sem lead time / OK.
- **Estoque**: com estoque parado (`saldo>0`) · sem estoque (`saldo=0`).
- **Dias sem vender** (faixas).
- Ordenação padrão: capital parado desc. Busca por código/descrição; filtro por fornecedor.

## 6. Ações

### 6.1 Resolver bloqueio (CTA primário por situação)
Para o item bloqueado, o CTA principal aponta pra resolução, não pra "forçar 1/2":
- `SEM_PRECO` / `SEM_LEADTIME` / `AGUARDANDO_HABILITACAO_FORNECEDOR` / `AGUARDANDO_CLASSIFICACAO_GRUPO` → link/ação pra resolver o cadastro correspondente.
- `AGUARDANDO_SEGUNDA_ORDEM` → fluxo cold-start existente (`promover_candidato_primeira_compra`) **ou** manter 1/2 como override de sortimento.

### 6.2 Manter em estoque (mín 1 / máx 2) — exceção consciente, com preview
Escrita simples em `sku_parametros` (`empresa`,`sku_codigo_omie`): `estoque_minimo=1`, `ponto_pedido=1`, `estoque_maximo=2` (editável), `habilitado_reposicao_automatica=true`, `tipo_reposicao='automatica'`. **O sistema preserva** esses valores enquanto o item estiver bloqueado (§1 — COALESCE/`sem_mudanca`); quando virar `OK`, o motor reassume (desejado).

- **Sem trava, sem migration** (ver §7).
- **Motivo obrigatório** + **preview de impacto** antes de confirmar (achado Codex: 1/2 em item com estoque efetivo 0 gera compra de 2 un no próximo ciclo). Preview = "isto vai gerar compra de ~X un = R$ Y no próximo ciclo", reusando a fórmula `impactoSimulado` de `src/lib/reposicao/param-auto-helpers.ts` (mesma da core). Em lote: mostra o total de unidades/R$ que entrarão.
- Semântica: PP=1 → repõe quando chega a 1; compra `máx − posição` = 1 → volta a 2 (gatilho `estoque_efetivo <= ponto_pedido` da RPC `gerar_pedidos_sugeridos_ciclo`).

### 6.3 Descontinuar — tira da reposição (com reconciliação)
Reusa `useDetalhesModal.ts:283`: `UPDATE sku_parametros SET tipo_reposicao='descontinuado', habilitado_reposicao_automatica=false` **+ remove o item de pedidos `pendente_aprovacao` já gerados** (o fluxo existente já deleta de `pedido_compra_item` e recalcula — preservar isso; achado Codex: alterar param não muda pedido já criado).

## 7. Por que NÃO há trava (decisão central, eu + Codex)

A "trava" da v1 (coluna `parametros_travados` + `AND NOT` no WHERE) foi **rejeitada**:
1. O problema que ela resolvia (cron zerando) **não existe mais** (corrigido em `20260531140000`).
2. `AND NOT` no WHERE **quebraria a core instrumentada** (`20260605130000`): o item ainda seria classificado/logado/contado, poderia apagar pin, e métricas de demanda parariam de atualizar.
3. O comportamento residual (motor reassume quando o item vira `OK` e gira) é **o que o founder quer** — e o **fusível** + resumo das 18h já seguram/avisam mudanças bruscas.

→ Manter 1/2 é uma **escrita simples** que o sistema já preserva. Nenhuma mudança no motor de recálculo. Se no futuro precisar de fixação rígida contra o motor (item com dado), aí sim modelar `modo_parametros=manual_fixo` como estado da core (não um flag no WHERE) — fora de escopo agora.

## 8. Cuidados money-path (achados Codex incorporados)
- **Pedido pendente já gerado** não muda ao alterar param/descontinuar → descontinuar reconcilia o `pendente_aprovacao` (fluxo existente). Manter 1/2 afeta só o próximo ciclo (item não estava comprando) → sem pendente a reconciliar.
- **cmc NULL/0** no KPI → "R$ conhecido + N sem custo", nunca zero silencioso.
- **Não congelar kill switches**: `habilitado_reposicao_automatica` e `tipo_reposicao` seguem sendo controles operacionais independentes (não há congelamento de pacote — não há trava).

## 9. Dados / fontes (sem sync novo; sem migration money-path)
- Leitura: `inventory_position` (saldo, cmc, `account='oben'`), `venda_items_history` (última venda), `sku_parametros` (estado/giro/classe), `v_sku_parametros_sugeridos` (situação).
- Escrita: `sku_parametros` (manter/descontinuar — updates simples já preservados pela core).
- Preview: reusa `param-auto-helpers.ts` (`impactoSimulado`).
- Provável **1 view de leitura** `v_reposicao_baixo_giro` (`security_invoker=on`) juntando as fontes — conveniência, não money-path. Decidir view vs query-no-hook no plano.

## 10. Faseamento
- **Fase 1:** painel (read) com KPI capital parado + Situação + filtros → CTAs de resolver bloqueio → manter 1/2 com motivo+preview (lote) → descontinuar com reconciliação → badge "voltou a girar / já tem dado" (informativo: o motor vai reassumir). Resolve os 164 e dá a visão. **Sem migration money-path.**
- **Fase 2 (separada):** liquidação de venda pro cliente, no módulo de preço/venda correto (não `promocao_*` de compra). Confirmar o domínio antes de especificar.

## 11. Não-objetivos
- Promoção de venda na v1 (Fase 2, domínio de venda).
- Fixação rígida de 1/2 contra o motor para item com dado (YAGNI; pin/manual_fixo no futuro).
- Colacor/SC; mexer na core `param_auto`.

## 12. Critérios de pronto
- Painel lista o universo de baixo giro Oben com capital parado (cmc-null honesto), dias sem vender, giro e situação.
- Manter 1/2 grava e **persiste** após o cron (já garantido pela core — validar com 1 SKU de teste).
- Item 1/2 entra no ciclo e repõe quando chega a 1.
- Manter 1/2 mostra preview de impacto (un + R$) antes de confirmar; em lote, o total.
- Descontinuar remove de pedidos pendentes.
- Os 164 resolvíveis pela tela, por bloqueio ou por 1/2-consciente.

## 13. Registro do challenge do Codex (gpt-5.5, 2026-06-06)
Veredito: "não aprovaria o spec como estava". Achados incorporados:
1. **Premissa stale** — o cron já não zera (COALESCE desde 31/mai); a "core instrumentada" trata NULL como `sem_mudanca`. → Trava removida (§7).
2. **`AND NOT` quebraria a core** (log/contagem/pin/métricas). → Trava removida.
3. **`promocao_*` é desconto de compra** (pode aumentar compra via forward_buying), não liquidação de venda. → Promoção sai da v1 (§3, §10).
4. **164 por bloqueio**, não force 1/2 em lote cego; 1/2 = exceção consciente com motivo + preview. → §6.
5. **Nomenclatura**: "sem parâmetro" ≠ "sem estoque". → §5.3 (facetas independentes).
6. **Money-path**: pedido pendente não muda ao alterar param; cmc null no KPI; kill switches independentes. → §8.

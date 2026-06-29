# Venda assistida — Fatia 2 v1: selo "preparado" por produto no wizard

> Slice escolhido pelo founder (2026-06-29): surfacing per-produto, vendedor-only, reusando a plumbing da casar.
> Design do programa: `docs/superpowers/specs/2026-06-14-venda-assistida-ia-design.md`. Motor: Fatia 1 (`resolverOpcaoVenda`/`montarBaseEmbalagens`, 41 testes, Codex-blindado).

## Decisão
Mostrar, ao lado do botão **Ficha** de cada produto com boletim aprovado, um **selo vendedor-only**:
- `SELLABLE_NOW` → 🟢 **Em estoque** · "Preparado: R$ X,XX/L (teórico)"
- `ORDERABLE` → 🟡 **Encomenda** · preço ou "sob consulta"
- preço `incomplete` → "Preparado: **sob consulta**"

## Fluxo de dados (tudo já em memória no wizard — zero query nova)
1. `specsByKey` (view `v_omie_product_current_spec`, já montada pela casar) → agrupar por `kb_product_spec_id` = embalagens de cada boletim.
2. Por SKU do boletim, pegar `descricao/valor_unitario/estoque` do **catálogo carregado** (`useProductCatalog`, completo/paginado) → `montarBaseEmbalagens(rows, customerPrices)`.
3. `customerPrices` = merge `customerPricesColacor` + `customerPricesOben` (último praticado).
4. `catalisador_codigo`/`proporcao` do próprio spec. **v1:** `catalisadorEmbalagens: []` → produto que exige catalisador **degrada honesto a "sob consulta"** (até a fatia do casamento do catalisador).
5. `resolverOpcaoVenda(...)` → opção `{estado, preco}` → espalhar pra cada SKU do boletim num `Map<keyDeSku, OpcaoResolvida>`.

## Regras / honestidade money-path
- `temSkuConfirmado: true` sempre (a view é confirmed+approved).
- Boletim **sem nenhuma embalagem no catálogo** → **não emite selo** (não polui com "sob consulta" quando só faltou carregar dado).
- `catalisador_codigo` vazio/whitespace → tratado como **sem catalisador** (base-only).
- Preço **nunca fabricado** — herda o motor Codex-blindado (ausente → `incomplete` → "sob consulta").
- Rótulo **"(teórico)"** + "baseado no último praticado" — nunca "preço fechado".

## Arquivos (2 puros + 2 fiações, espelhando a casar)
- **Criar** `src/lib/venda-assistida/selos.ts` — `montarSelosVendaAssistida(specs, catalogByKey, customerPrices)` + `descreverSelo(opcao)` (puros).
- **Criar** `src/components/unified-order/VendaAssistidaSelo.tsx` — wrapper trivial que renderiza `descreverSelo` (formata o R$/L com o formatter do repo).
- **Editar** `src/components/unified-order/ProductItemForm.tsx` — +props `selosByKey?` / `canSeeVendaAssistida?`, lookup `selosByKey.get(keyDeSku(account, cod))` igual ao da Ficha.
- **Editar** `src/pages/UnifiedOrder.tsx` — `useMemo` monta `selosByKey` (catálogo→Map + merge de preços + `montarSelosVendaAssistida`); passa `canSeeVendaAssistida={h.isStaff}` aos dois ProductItemForm.

## Gate / verificação
- Vendedor-only = `isStaff` (espelha `canSeeFicha`; nada pro cliente).
- Lógica 100% por testes puros agora. "Na tela" acende quando os vínculos forem populados em prod.

## Codex adversarial (2026-06-29, xhigh) — 2 P0 + 1 P1 na camada nova, fechados
- **P0 (auto-scan, antes do Codex) — preço-do-cliente cross-account:** `omie_codigo_produto` colide entre Oben/Colacor (contas Omie separadas) → o merge `{...colacor, ...oben}` vazava o preço da Oben pra um SKU da Colacor de mesmo código. Fix: ler o preço da CONTA de cada SKU + teste de regressão.
- **P0 (Codex) — agrupar só por boletim mistura contas:** um boletim vinculado a SKU Oben E Colacor resolvia junto → mostrava o estoque/preço de uma conta no produto da outra. Fix: agrupar por `(conta, kb_product_spec_id)` — cada conta é sua própria opção. + teste de regressão.
- **P1 (Codex) — "Encomenda" com preço incompleto:** `ORDERABLE + incomplete` mostrava "sob consulta · Encomenda". Fix: preço incompleto DOMINA a apresentação → "Sob consulta" (muted); só mostra "Em estoque"/"Encomenda" quando o preço fecha (`ok`).
- ⚠️ **P0 NÃO-fechado (pré-existente, FORA do escopo do selo):** `useCustomerSelection.ts:534` manda o MESMO mapa de preço local pras 2 contas (limitação **documentada no código**: "corrigida na Fase 2 account-aware"). Afeta também o preço que o wizard já exibe hoje — não é introduzido pelo selo. O read-por-conta do selo fica forward-compatible. **→ flaggar pro founder / fatia própria.**

## Deferido (fatia própria)
- **Casamento do catalisador** (catalisador_codigo→SKU, founder aprova) → destrava preço CATALISADO completo.
- Camada viva / "mostrar todas as alternativas" (Fatia 3 — NeedFrame + busca + gate; depende do pgvector da Fatia 0).

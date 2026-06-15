# Casar boletim↔SKU na venda — front do casamento (PR-0c) + ficha na venda

> Spec de design. Data: 2026-06-14. Autor: Claude (Opus). Decisões do founder registradas em §8.
> Status: aprovado o desenho (founder "Pode seguir", 2026-06-14) → writing-plans.
> Continuação de `2026-06-11-kb-conhecimento-venda-fundacao-design.md` (fundação) e do 0c-A
> (`2026-06-13-kb-0c-aprovacao-master-only-design.md`).

## 1. Contexto e problema

O **backend do casamento boletim↔SKU está 100% pronto e em produção** (migrations `20260611140000` fundação + `20260613120000` 0c-A, aplicadas+validadas), mas **nada no front o usa** — está ocioso:

- **View `v_omie_product_current_spec`** (`security_invoker`, staff-readable) — chaveada por `(account, omie_codigo_produto bigint)`, devolve os campos técnicos curados de uma ficha **só quando** o vínculo está `confirmed` **E** a ficha `approved_at IS NOT NULL` (dupla-trava). Campos: `product_code, product_name, supplier, product_category, rendimento_m2_por_litro, demaos_recomendadas, pot_life_horas, validade_dias, catalisador_codigo, catalisador_proporcao_pct, diluente_codigo, substrato, equipamentos_aplicacao, diferenciais_chave, uso_recomendado`.
- **`buscar_skus_candidatos(p_termos text[])`** → `(account, omie_codigo_produto bigint, codigo, descricao)` — staff-gated, pré-filtro `ILIKE` na descrição (escapa metacaracteres). O master digita termos (o código do boletim costuma viver **na descrição** do SKU Omie), o server devolve candidatos.
- **`confirmar_vinculo_boletim(p_kb_product_spec_id uuid, p_skus jsonb)`** → `integer` — **master-only**, valida SKU em `omie_products`, anti-roubo (SKU já vinculado a outro boletim → erro), idempotente (`ON CONFLICT DO NOTHING`, conta o que inseriu de fato).
- **`desvincular_boletim(p_account text, p_omie_codigo_produto bigint, p_expected_kb_product_spec_id uuid)`** → `integer` — **master-only**, `expected_id` evita stale-delete (aba atrasada não apaga vínculo já reatribuído).
- (`rejeitar_sugestao(...)` existe mas **fora do escopo v1** — a fila/rejeição não tem consumidor aqui.)

**Este spec entrega o front das duas pontas, na ordem em que dependem uma da outra:**
1. **Vínculo (admin):** o master confirma/desfaz o de-para boletim↔SKU. Sem isto, a venda não tem o que mostrar.
2. **Ficha na venda:** a vendedora vê a ficha técnica do produto ao montar o pedido.

## 2. Objetivo e não-objetivos

**Objetivo:** o master vincula boletins a SKUs pelo detalhe do boletim; a vendedora vê a ficha técnica do SKU no wizard de pedido — **só** quando há vínculo confirmado+aprovado.

**Princípio mestre (money-path):** **precisão > recall.** A venda mostra ficha **exclusivamente** pela view (confirmado+aprovado). Zero matching fuzzy em runtime. Sem vínculo ⇒ nenhuma ficha. Toda escrita de vínculo é **master-only** (a RPC é a fronteira; a UI só reflete).

**Não-objetivos (YAGNI / fatias futuras):**
- ❌ Sugestão automática por IA / cross-sell por processo do cliente (é a **fatia 2** — `compare-customer-process`).
- ❌ Specs/RAG em tempo real na chamada (fatia 3 — copilot).
- ❌ Fila de "sugestões" com `rejeitar_sugestao` — a v1 usa busca por termos digitados, não um motor de sugestão que precise de rejeição persistida.
- ❌ Mexer no `types.ts` à mão (Lovable regenera após migration; usamos casts `as never` — lição §10 Radar fatia 2).
- ❌ Migration ou edge nova (backend já está em prod). Vai ao ar com **Publish** do frontend.
- ❌ Vincular fundido na fila de aprovação (decisão §8: desacoplado, painel no detalhe).

## 3. Arquitetura

100% frontend. Três blocos.

### 3a. Camada de dados — `src/hooks/useProductSpecLink.ts`

Casts `as never`/`as any` nas chamadas à view e às RPCs novas (ainda fora do `types.ts` gerado).

- **Venda (leitura):** `useCurrentSpecsMap(account?: string)` → 1 query em `v_omie_product_current_spec` (com `.eq('account', account)` quando houver). Retorna `{ byKey: Map<string, CurrentSpec>, isLoading }`, `byKey` chaveado por **`keyDeSku(account, omie_codigo_produto)`** (helper puro, abaixo). `staleTime: 5min`. O conjunto é **pequeno por construção** (só vínculos confirmados+aprovados) → sem N+1, sem risco do cap 1000 no volume v1.
- **Admin (vínculo):**
  - `useSpecLinks(specId?: string)` — lista os vínculos `confirmed` deste boletim. Lê `omie_product_spec_links` (`account, omie_codigo_produto`, `status='confirmed'`, `kb_product_spec_id=specId`) e, num 2º fetch, `omie_products` (`.in('omie_codigo_produto', codes)` filtrando por account no merge — código repete entre contas) pra obter `codigo`/`descricao`. Retorna `{ links: VinculoLinha[], isLoading, refetch }`.
  - `useBuscarSkusCandidatos()` — `mutateAsync(termos: string[])` → `.rpc('buscar_skus_candidatos', { p_termos })`. Retorna candidatos.
  - `useConfirmarVinculo()` — `mutateAsync({ specId, skus: {account, omie_codigo_produto}[] })` → `.rpc('confirmar_vinculo_boletim', ...)`. `onSuccess` invalida `useSpecLinks` + `useCurrentSpecsMap`. `onError` → toast honesto com a mensagem da RPC (ex.: "já vinculado a outro boletim", "inexistente em omie_products").
  - `useDesvincularBoletim()` — `mutateAsync({ account, omie_codigo_produto, expectedSpecId })` → `.rpc('desvincular_boletim', ...)`. Se retorno `0` → toast "nada mudou (talvez já reatribuído)"; invalida as queries.

- **Helper puro testável** `src/lib/knowledge-base/spec-link.ts`: `keyDeSku(account, cod) => `${(account ?? '').toLowerCase()}|${cod}`` (única lógica nova com teste — chave estável usada na venda e no merge admin). Reusa `rotularCampo`/`formatarValorCampo` de `campo-labels.ts` na exibição (não duplica).

### 3b. Vínculo no detalhe — `AdminKnowledgeBaseDetail.tsx` + `src/components/knowledge-base/SpecLinkPanel.tsx`

Novo card **"Itens de venda vinculados"** abaixo do card "Specs estruturados", renderizado **só quando `existingSpecs?.approved_at`** (vincular ficha não-aprovada é inócuo: a view não surfaceia) **e** `isMaster` (`useAuth()` **real**; employee não confirma). Sob a lente "Ver como" (`isImpersonating`) → ações **desabilitadas** (o write-guard já bloqueia a RPC; o disabled é UX honesta).

Conteúdo (`SpecLinkPanel`, recebe `spec: { id, product_code, product_name }`):
- **Lista** dos vinculados (`useSpecLinks`): por linha `account` · `codigo` (mono) · `descricao` (truncada) + botão **"Desvincular"** (`useDesvincularBoletim`, `expectedSpecId = spec.id`). Vazio → "Nenhum item vinculado ainda."
- **"Vincular itens"** → abre busca (Input) **pré-preenchida com `spec.product_code`** (o código vive na descrição do SKU). Submeter → `useBuscarSkusCandidatos([termo])` → lista de candidatos com **checkbox** (`account` · `codigo` · `descricao`); os já vinculados aparecem marcados/desabilitados. **"Confirmar vínculo (N)"** → `useConfirmarVinculo` num lote. Erro da RPC → toast honesto (não engole).

### 3c. Ficha na venda — `ProductItemForm.tsx` + `src/components/unified-order/FichaTecnicaSheet.tsx`

No `products.map()` de `ProductItemForm` (a linha do produto já tem `product.account` + `product.omie_codigo_produto`), na fileira de badges (linhas ~84-98), adicionar um botão discreto **"📄 Ver ficha"** que **só renderiza quando** `specsMap.byKey.has(keyDeSku(product.account, product.omie_codigo_produto))` **e** `isStaff`. Toque abre `<FichaTecnicaSheet spec={...} />`.

- `useCurrentSpecsMap(account)` é chamado **uma vez** no nível que monta o `ProductItemForm` (a página do wizard passa o `account` ativo) — o mapa desce por prop (`specsByKey?: Map`). Evita hook por-linha. Off-account/sem vínculos → mapa vazio → nenhum "Ver ficha" (degrada silencioso).
- **`FichaTecnicaSheet`** (`<Sheet side="right">`): cabeçalho `product_name` + `supplier`; corpo = grid de specs presentes (usa `rotularCampo`/`formatarValorCampo`; pula nulos), com os mesmos campos da view. Read-only. Reaproveita o padrão visual do card de specs do detalhe (KpiCell-like).
- Gate: `isStaff`. A RLS da view já é employee/master (cliente logado leria vazio), mas o `isStaff` evita o fetch/affordance pra não-staff. Sob lente é leitura → ok exibir.

## 4. Contratos

**Backend (JÁ EXISTE — não muda):** view `v_omie_product_current_spec`; RPCs `buscar_skus_candidatos(text[])`, `confirmar_vinculo_boletim(uuid,jsonb)`, `desvincular_boletim(text,bigint,uuid)`. Assinaturas em §1.

**Front novo:**
- `src/lib/knowledge-base/spec-link.ts` — `keyDeSku`, tipos `CurrentSpec`, `VinculoLinha`, `SkuCandidato`.
- `src/hooks/useProductSpecLink.ts` — `useCurrentSpecsMap`, `useSpecLinks`, `useBuscarSkusCandidatos`, `useConfirmarVinculo`, `useDesvincularBoletim`.
- `src/components/knowledge-base/SpecLinkPanel.tsx` — painel de vínculo (master-only).
- `src/components/unified-order/FichaTecnicaSheet.tsx` — Sheet da ficha na venda.
- Edições: `AdminKnowledgeBaseDetail.tsx` (monta o painel), `ProductItemForm.tsx` (affordance "Ver ficha") + o ponto que monta o `ProductItemForm` no wizard (chama `useCurrentSpecsMap`, passa o mapa).

## 5. Fluxos

**A. Vincular (master):** detalhe do boletim aprovado → "Vincular itens" → busca pré-preenchida com o código → marca embalagens → "Confirmar (N)" → linhas viram `confirmed` → a venda passa a mostrar a ficha desses SKUs.

**B. Desvincular (master):** linha vinculada → "Desvincular" → `desvincular_boletim(...,spec.id)` → some da view → some da venda.

**C. Ler na venda (vendedora/master):** wizard carrega o catálogo → `useCurrentSpecsMap(account)` → cada produto com vínculo mostra "Ver ficha" → Sheet com as specs. Sem vínculo → sem affordance.

## 6. Casos de erro / money-path safety

- Sem vínculo confirmado+aprovado → view vazia → venda não mostra ficha (correto, por design).
- Confirmar SKU já ligado a outro boletim → RPC erra → toast honesto, sem roubo.
- Confirmar SKU inexistente em `omie_products` → RPC erra → toast.
- Desvincular com `spec.id` que já não bate (reatribuído) → retorno `0` → toast "nada mudou".
- Escrita só master (RPC); sob lente desabilitada + write-guard.
- Não-staff: affordance escondida + RLS da view vazia.

## 7. Testes

- **Helper puro** `spec-link.ts` (vitest): `keyDeSku` (lowercase do account, account nulo/maiúsculo, cod numérico) — única lógica nova testável; é a chave que casa venda↔mapa↔merge admin.
- **Sem PG17** — o backend (RPCs/view) já foi validado por PG17 na fundação/0c e está aplicado em prod. Este é front que consome contratos prontos.
- **CI `validate`:** `bun run typecheck` (strict) · `test` · `lint` (0 errors) · `build`.
- Verificação visual fica no QA do founder pós-Publish (o headless não renderiza a SPA — §5/§10).

## 8. Decisões e trade-offs

- **Painel no detalhe (NÃO fundido na aprovação)** — decisão do founder (2026-06-14). A fila de aprovação (0b) já existe desacoplada e é de lote; o vínculo é curadoria fina (precisão > recall). Aprovar em lote (rápido) + vincular com calma, um boletim por vez.
- **"Ver ficha" → Sheet sob demanda (NÃO inline/tooltip)** — decisão do founder. Discreto, não polui a linha densa, funciona no mobile (a vendedora é mobile; tooltip é ruim no mobile). Só aparece quando há certeza (vínculo).
- **Busca por termos (não busca-reversa automática)** — é o que entrou em prod (`buscar_skus_candidatos(text[])`). Pré-preencher com o `product_code` dá o efeito de "sugestão" sem motor extra. O `ambiguous`/validação-de-categoria do spec original ficou fora do backend aplicado → a curadoria humana (master marca o checkbox certo) é a trava.
- **`useCurrentSpecsMap` carrega o conjunto inteiro de vínculos da conta de uma vez** — é pequeno por construção; mais simples e barato que fetch por-produto, e dá o indicador "tem ficha?" sem N+1.
- **Reuso de `campo-labels.ts`** (Fase B1) no Sheet — consistência de rótulos/formatação, zero duplicação.

## 9. Sequência de tasks (subagent-driven)

1. **Helper + hooks:** `spec-link.ts` (+ teste de `keyDeSku`) + `useProductSpecLink.ts` (5 hooks, casts `as never`).
2. **Painel de vínculo:** `SpecLinkPanel.tsx` + montagem em `AdminKnowledgeBaseDetail.tsx` (gate master + approved_at + lente).
3. **Ficha na venda:** `FichaTecnicaSheet.tsx` + affordance no `ProductItemForm.tsx` + `useCurrentSpecsMap` no ponto que monta o form (passa o mapa por prop).
4. **Fios/gates/revisão:** confirmar gates (isStaff/isMaster real, isImpersonating), invalidações de query, typecheck/test/lint/build, revisão final do conjunto.

## 10. Pendência do founder

- **Publish do frontend** no Lovable (única coisa pra ir ao ar). Sem migration, sem edge.
- Depois: popular vínculos reais pelo painel (depende de boletins aprovados na base).

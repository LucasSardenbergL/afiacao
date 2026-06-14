# Casar boletim↔SKU na venda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** O master vincula boletins técnicos a SKUs Omie pelo detalhe do boletim; a vendedora vê a ficha técnica do SKU no wizard de pedido — só quando há vínculo confirmado+aprovado.

**Architecture:** 100% frontend sobre backend já em prod (view `v_omie_product_current_spec` + RPCs `buscar_skus_candidatos`/`confirmar_vinculo_boletim`/`desvincular_boletim`). Hooks novos em `useProductSpecLink.ts`, helper puro `spec-link.ts`, painel de vínculo no detalhe (master-only), Sheet de ficha na venda (staff). Sem migration/edge. Casts `as never` (RPCs/view fora do `types.ts` gerado).

**Tech Stack:** React 18 + TS strict, @tanstack/react-query, supabase-js, shadcn/ui (`Sheet`, `Card`, `Checkbox`, `Input`, `Button`, `Badge`), sonner. Reusa `campo-labels.ts` (Fase B1).

**Spec:** `docs/superpowers/specs/2026-06-14-kb-casar-boletim-sku-venda-design.md`.

**Contratos backend (não mudar):**
- `v_omie_product_current_spec(account, omie_codigo_produto, kb_product_spec_id, product_code, product_name, supplier, product_category, rendimento_m2_por_litro, demaos_recomendadas, pot_life_horas, validade_dias, catalisador_codigo, catalisador_proporcao_pct, diluente_codigo, substrato, equipamentos_aplicacao, diferenciais_chave, uso_recomendado)` — staff RLS, ≤1 linha por SKU.
- `.rpc('buscar_skus_candidatos', { p_termos: string[] })` → `{account, omie_codigo_produto, codigo, descricao}[]` (staff).
- `.rpc('confirmar_vinculo_boletim', { p_kb_product_spec_id: string, p_skus: {account, omie_codigo_produto}[] })` → number (master; erro="já vinculado a outro boletim"/"inexistente em omie_products").
- `.rpc('desvincular_boletim', { p_account, p_omie_codigo_produto, p_expected_kb_product_spec_id })` → number (master; 0=nada bateu).

**Gates (reusar do app):** `useAuth()` → `isStaff`, `isMaster` (REAL, nunca `display*` p/ escrita/identidade). Lente: `useImpersonation()` (ou equivalente) → `isImpersonating` → desabilita ações de escrita. Confirmar os nomes/paths exatos lendo `src/contexts/AuthContext.tsx` e o ImpersonationContext antes de usar.

---

## File Structure

- Create `src/lib/knowledge-base/spec-link.ts` — helper puro `keyDeSku` + tipos (`CurrentSpec`, `VinculoLinha`, `SkuCandidato`).
- Create `src/lib/knowledge-base/__tests__/spec-link.test.ts` — testa `keyDeSku`.
- Create `src/hooks/useProductSpecLink.ts` — 5 hooks (1 leitura venda + 1 leitura admin + 3 mutations/busca).
- Create `src/components/knowledge-base/SpecLinkPanel.tsx` — painel de vínculo (master-only).
- Create `src/components/unified-order/FichaTecnicaSheet.tsx` — Sheet read-only da ficha.
- Modify `src/pages/AdminKnowledgeBaseDetail.tsx` — monta `SpecLinkPanel` (gate).
- Modify `src/components/unified-order/ProductItemForm.tsx` — affordance "Ver ficha" (recebe `specsByKey?: Map` por prop).
- Modify o ponto que renderiza `<ProductItemForm .../>` no wizard — chama `useCurrentSpecsMap(account)` e passa o mapa. (Localizar: `grep -rn "ProductItemForm" src --include=*.tsx`.)

---

## Task 1: Helper puro + hooks de dados

**Files:**
- Create: `src/lib/knowledge-base/spec-link.ts`
- Test: `src/lib/knowledge-base/__tests__/spec-link.test.ts`
- Create: `src/hooks/useProductSpecLink.ts`

- [ ] **Step 1: Teste do helper (falha primeiro)**

```ts
// __tests__/spec-link.test.ts
import { describe, it, expect } from 'vitest';
import { keyDeSku } from '../spec-link';

describe('keyDeSku', () => {
  it('lowercase do account + cod', () => {
    expect(keyDeSku('OBEN', 123)).toBe('oben|123');
    expect(keyDeSku('oben', 123)).toBe('oben|123');
  });
  it('account nulo/undefined vira vazio', () => {
    expect(keyDeSku(undefined, 5)).toBe('|5');
    expect(keyDeSku(null as unknown as string, 5)).toBe('|5');
  });
});
```

Run: `bunx vitest run src/lib/knowledge-base/__tests__/spec-link.test.ts` → FAIL (módulo não existe).

- [ ] **Step 2: Implementar `spec-link.ts`**

```ts
export interface CurrentSpec {
  account: string;
  omie_codigo_produto: number;
  kb_product_spec_id: string;
  product_code: string | null;
  product_name: string | null;
  supplier: string | null;
  product_category: string | null;
  rendimento_m2_por_litro: number | null;
  demaos_recomendadas: number | null;
  pot_life_horas: number | null;
  validade_dias: number | null;
  catalisador_codigo: string | null;
  catalisador_proporcao_pct: number | null;
  diluente_codigo: string | null;
  substrato: string | null;
  equipamentos_aplicacao: string[] | string | null;
  diferenciais_chave: string[] | string | null;
  uso_recomendado: string | null;
}

export interface SkuCandidato {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

export interface VinculoLinha {
  account: string;
  omie_codigo_produto: number;
  codigo: string | null;
  descricao: string | null;
}

/** Chave estável p/ casar venda↔mapa↔merge admin. account case-insensitive. */
export function keyDeSku(account: string | null | undefined, cod: number): string {
  return `${(account ?? '').toLowerCase()}|${cod}`;
}

/** Campos da view exibidos na ficha, na ordem. Usa rotularCampo/formatarValorCampo. */
export const FICHA_CAMPOS: (keyof CurrentSpec)[] = [
  'product_category', 'rendimento_m2_por_litro', 'demaos_recomendadas',
  'catalisador_codigo', 'catalisador_proporcao_pct', 'diluente_codigo',
  'pot_life_horas', 'validade_dias', 'substrato', 'equipamentos_aplicacao',
  'diferenciais_chave', 'uso_recomendado',
];
```

Run o teste → PASS.

- [ ] **Step 3: `useProductSpecLink.ts`** (sem teste unitário — são wrappers de query; cobertura é o typecheck + QA)

Implementar os 5 hooks. Pontos obrigatórios:
- `useCurrentSpecsMap(account?: string)`: `useQuery(['kb-current-specs', account])`, `staleTime: 5*60_000`. Query: `(supabase.from('v_omie_product_current_spec' as never).select('*') ...)`; se `account`, `.eq('account', account)`. Monta `byKey: Map<string, CurrentSpec>` com `keyDeSku(row.account, row.omie_codigo_produto)`. Retorna `{ byKey, isLoading }`.
- `useSpecLinks(specId?: string)`: `enabled: !!specId`. (1) `omie_product_spec_links` `.eq('kb_product_spec_id', specId).eq('status','confirmed')` → `{account, omie_codigo_produto}[]`. (2) Se houver linhas, `omie_products` `.in('omie_codigo_produto', codes).select('account, omie_codigo_produto, codigo, descricao')` e merge por `keyDeSku` → `VinculoLinha[]` (codigo/descricao null se não achar). Retorna `{ links, isLoading, refetch }`.
- `useBuscarSkusCandidatos()`: `useMutation` → `.rpc('buscar_skus_candidatos' as never, { p_termos })`. Retorna `SkuCandidato[]`.
- `useConfirmarVinculo()`: `useMutation` → `.rpc('confirmar_vinculo_boletim' as never, { p_kb_product_spec_id: specId, p_skus })`; `onSuccess` → `queryClient.invalidateQueries({queryKey:['kb-spec-links']})` + `['kb-current-specs']`; `onError` → `toast.error(e.message)`.
- `useDesvincularBoletim()`: `useMutation` → `.rpc('desvincular_boletim' as never, {...})`; retorno 0 → `toast.message('Nada mudou (talvez já reatribuído).')`; invalida as mesmas queries.
- ⚠️ casts `as never` em TODA chamada a view/RPC novas (não editar `types.ts`). Tipar o retorno com `as { data: X[] | null; error: ... }` após o cast.

- [ ] **Step 4: typecheck + commit**

Run: `bun run typecheck > /tmp/tc1.log 2>&1; echo $?` → 0.
Run o teste do helper → PASS.
Commit: `feat(kb): helper spec-link + hooks de vínculo/ficha (casar boletim↔SKU)`.

---

## Task 2: Painel de vínculo no detalhe (master-only)

**Files:**
- Create: `src/components/knowledge-base/SpecLinkPanel.tsx`
- Modify: `src/pages/AdminKnowledgeBaseDetail.tsx`

- [ ] **Step 1: `SpecLinkPanel.tsx`**

Props: `{ spec: { id: string; product_code: string | null; product_name: string | null }; disabled?: boolean }` (`disabled` = lente).
- `const { links, isLoading } = useSpecLinks(spec.id);`
- Card "Itens de venda vinculados". Lista `links`: `account` (badge) · `codigo` (mono) · `descricao` (truncate) + Button "Desvincular" (`useDesvincularBoletim`, `{account, omie_codigo_produto, expectedSpecId: spec.id}`), `disabled` na lente. Vazio → texto "Nenhum item vinculado ainda."
- Bloco "Vincular itens": `Input` de busca com `defaultValue = spec.product_code ?? ''`; Button "Buscar" → `useBuscarSkusCandidatos().mutateAsync([termo.trim()])` (ignora vazio). Resultado → lista com `Checkbox` por candidato (`account|codigo|descricao`); candidato já em `links` aparece marcado+disabled. Estado local `Set<string>` (keyDeSku) dos selecionados. Button "Confirmar vínculo (N)" → `useConfirmarVinculo().mutateAsync({ specId: spec.id, skus: [...selecionados→{account,omie_codigo_produto}] })`; on success limpa seleção + resultado; `disabled` na lente ou N=0.
- Todos os textos pt-BR.

- [ ] **Step 2: Montar no `AdminKnowledgeBaseDetail.tsx`**

Em `DetailContent`, importar `useAuth` (real) + o hook da lente. Após o card "Specs estruturados" (e antes de `VersionHistory`), renderizar:
```tsx
{existingSpecs?.approved_at && existingSpecs.id && isMaster && (
  <SpecLinkPanel
    spec={{ id: existingSpecs.id, product_code: existingSpecs.product_code, product_name: existingSpecs.product_name }}
    disabled={isImpersonating}
  />
)}
```
Confirmar que `useKbProductSpecs` retorna `id`/`product_code`/`product_name` (specs-types). `isMaster`/`isImpersonating` dos contexts reais.

- [ ] **Step 3: typecheck + commit**

Run: `bun run typecheck > /tmp/tc2.log 2>&1; echo $?` → 0. `bun lint` (0 errors no que tocou).
Commit: `feat(kb): painel de vínculo boletim↔SKU no detalhe (master-only)`.

---

## Task 3: Ficha na venda (Sheet + affordance)

**Files:**
- Create: `src/components/unified-order/FichaTecnicaSheet.tsx`
- Modify: `src/components/unified-order/ProductItemForm.tsx`
- Modify: o componente que renderiza `<ProductItemForm/>` no wizard (localizar via grep).

- [ ] **Step 1: `FichaTecnicaSheet.tsx`**

Props: `{ spec: CurrentSpec; open: boolean; onOpenChange: (o: boolean) => void }`.
- `<Sheet open onOpenChange>` `side="right"`. Header: `spec.product_name` + `supplier` (badge).
- Corpo: para cada campo em `FICHA_CAMPOS` com valor não-nulo (`formatarValorCampo`), uma célula `rotularCampo(campo)` + valor. `catalisador_codigo` + `catalisador_proporcao_pct` podem ser combinados numa célula "Catalisador". Grid 2 colunas, denso.
- Read-only. pt-BR.

- [ ] **Step 2: Affordance no `ProductItemForm.tsx`**

- Nova prop opcional `specsByKey?: Map<string, CurrentSpec>` e `canSeeFicha?: boolean` (= isStaff, passado de cima) — OU importar `useAuth` e checar `isStaff` localmente (preferir prop p/ não acoplar). Decidir: passar `specsByKey` + `canSeeFicha` por prop (o pai já sabe isStaff/account).
- Dentro do `products.map`: `const ficha = canSeeFicha ? specsByKey?.get(keyDeSku(product.account, product.omie_codigo_produto)) : undefined;`
- Estado local `const [fichaAberta, setFichaAberta] = useState<string | null>(null)` (key do produto aberto).
- Na fileira de badges (após os existentes), se `ficha`: `<Button variant="ghost" size="sm" className="h-5 ..." onClick={()=>setFichaAberta(product.id)}>📄 Ver ficha</Button>`.
- Render condicional `{ficha && <FichaTecnicaSheet spec={ficha} open={fichaAberta===product.id} onOpenChange={(o)=>setFichaAberta(o?product.id:null)} />}`.

- [ ] **Step 3: Ligar no wizard**

Localizar quem monta `<ProductItemForm products={...} account=... />`. Lá: `const { byKey } = useCurrentSpecsMap(account);` e passar `specsByKey={byKey}` + `canSeeFicha={isStaff}`. Se o `account` ativo não estiver disponível nesse nível, derivar da fonte do catálogo (o `Product.account`). Não chamar `useCurrentSpecsMap` dentro do `.map` (1 chamada no nível do form).

- [ ] **Step 4: typecheck + build + commit**

Run: `bun run typecheck > /tmp/tc3.log 2>&1; echo $?` → 0. `heavy bun run build > /tmp/b3.log 2>&1; echo $?` → 0.
Commit: `feat(venda): ficha técnica do produto no wizard (Sheet sob demanda, staff)`.

---

## Task 4: Gates, invalidações e revisão final

- [ ] **Step 1: Auditar gates**
- `SpecLinkPanel` só monta com `isMaster` REAL + `approved_at`; ações `disabled` sob `isImpersonating`. Confirmar que nenhum `display*` decide escrita.
- Ficha na venda: `canSeeFicha = isStaff`; sob lente é leitura (ok exibir).
- Confirmar `as never` em todas as chamadas novas; `bun run typecheck` strict 0.

- [ ] **Step 2: Invalidações**
- `useConfirmarVinculo`/`useDesvincularBoletim` invalidam `['kb-spec-links']` e `['kb-current-specs']` → a lista do painel e o mapa da venda refrescam.

- [ ] **Step 3: CI completo**
Run: `heavy bun run test > /tmp/t.log 2>&1; echo $?` → 0; `bun lint` (0 errors); `bun run typecheck` 0; `heavy bun run build` 0.

- [ ] **Step 4: Commit final + dispatch revisor**
Commit pendências. Dispatch code-reviewer no diff inteiro (correção + gates money-path).

# Reativar SKU descontinuado (filtro na Revisão) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar à tela de Revisão (`/admin/reposicao/revisao`) um filtro "Descontinuados" que lista os SKUs desligados de propósito pelo botão "descontinuar SKU" dos Pedidos, com uma ação inline "Reativar" que os religa à reposição automática.

**Architecture:** 100% frontend. Reusa o padrão da Revisão (troca de fonte de dados por `statusFilter` + ação inline no `SkuRow`, espelhando o "Promover"). "Reativar" = `UPDATE sku_parametros SET habilitado_reposicao_automatica=true, tipo_reposicao='automatica'` via PostgREST — a mesma escrita que a tela já usa pra editar parâmetros. Bônus: o branch "Todos" deixa de vazar descontinuados.

**Tech Stack:** React + TypeScript, @tanstack/react-query, Supabase JS (PostgREST), shadcn/ui (Select, AlertDialog), vitest. Sem migration, sem edge function. Deploy = Publish do front no Lovable.

**Spec:** `docs/superpowers/specs/2026-06-06-reposicao-reativar-sku-descontinuado-design.md`

---

## File Structure

- `src/lib/reposicao/sku-param.ts` — **modify**: `tipo_reposicao` no tipo `SkuParam`; `'descontinuados'` no `StatusFilterValue`; helpers `isDescontinuado` + `reativarPayload`.
- `src/lib/reposicao/__tests__/skuParam.test.ts` — **modify**: testes dos 2 helpers novos.
- `src/components/reposicao/revisao/useRevisaoParametros.ts` — **modify**: branch "descontinuados" + exclusão de descontinuados do "Todos" + `reativarMutation`.
- `src/components/reposicao/revisao/FiltrosCard.tsx` — **modify**: opção "Descontinuados" no seletor.
- `src/components/reposicao/revisao/SkuRow.tsx` — **modify**: badge "Descontinuado" + botão "Reativar" (AlertDialog).
- `src/components/reposicao/revisao/RevisaoTable.tsx` — **modify**: repassa `onReativar`/`reativando` ao `SkuRow`.
- `src/pages/AdminReposicaoRevisao.tsx` — **modify**: liga `reativarMutation` + aviso contextual.

**Gate de acesso:** herdado da rota `/admin/reposicao/revisao` (comprador/gestor/master). A escrita reusa a RLS de `sku_parametros`. Nada a adicionar.

---

## Task 1: Tipo + helpers puros (TDD)

**Files:**
- Modify: `src/lib/reposicao/sku-param.ts`
- Test: `src/lib/reposicao/__tests__/skuParam.test.ts`

- [ ] **Step 1: Escrever os testes que falham**

Em `src/lib/reposicao/__tests__/skuParam.test.ts`, adicione `isDescontinuado, reativarPayload` ao import existente de `'../sku-param'`:

```ts
import {
  fonteBadgeVariant,
  fonteBadgeLabel,
  classBadge,
  fmt,
  fmtBRL,
  isDescontinuado,
  reativarPayload,
} from '../sku-param';
```

E adicione ao **fim** do arquivo:

```ts
describe('isDescontinuado', () => {
  it('true só para tipo_reposicao === "descontinuado"', () => {
    expect(isDescontinuado({ tipo_reposicao: 'descontinuado' })).toBe(true);
  });
  it('false para automatica / null / undefined / produto_acabado', () => {
    expect(isDescontinuado({ tipo_reposicao: 'automatica' })).toBe(false);
    expect(isDescontinuado({ tipo_reposicao: null })).toBe(false);
    expect(isDescontinuado({})).toBe(false);
    expect(isDescontinuado({ tipo_reposicao: 'produto_acabado' })).toBe(false);
  });
});

describe('reativarPayload', () => {
  it('religa AMBOS os campos (habilitado=true E tipo=automatica)', () => {
    // Trava contra religar só metade: deixar tipo='descontinuado' faria o motor
    // continuar barrando o SKU mesmo com habilitado=true.
    expect(reativarPayload()).toEqual({
      habilitado_reposicao_automatica: true,
      tipo_reposicao: 'automatica',
    });
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `bun run test src/lib/reposicao/__tests__/skuParam.test.ts`
Expected: FAIL — `isDescontinuado is not a function` / `reativarPayload is not a function`.

- [ ] **Step 3: Implementar no `sku-param.ts`**

(a) No tipo `SkuParam`, logo após `ultima_atualizacao_calculo: string | null;` (linha ~43), adicione:

```ts
  // Estado de reposição: 'automatica'/null = no motor; 'produto_acabado' = fabricado ('04');
  // 'descontinuado' = desligado de propósito pelo humano (botão "descontinuar SKU" nos Pedidos).
  // Opcional no tipo (os literais de view não o fornecem); o select('*') o traz em runtime.
  tipo_reposicao?: string | null;
```

(b) Estenda `StatusFilterValue`:

```ts
export type StatusFilterValue = 'pendente' | 'aprovado' | 'aguardando_fornecedor' | 'primeira_compra' | 'todos' | 'descontinuados';
```

(c) No **fim** do arquivo, adicione os helpers:

```ts
/** SKU desligado de propósito pelo humano (botão "descontinuar SKU" nos Pedidos). */
export const isDescontinuado = (row: { tipo_reposicao?: string | null }): boolean =>
  row.tipo_reposicao === 'descontinuado';

/**
 * Campos que religam um SKU descontinuado ao motor de reposição automática.
 * tipo='automatica' é seguro mesmo num fabricado '04' — a guarda do motor barra '04'
 * independentemente (#527/#529). Religar SÓ `habilitado` deixaria tipo='descontinuado'
 * e o motor seguiria barrando; por isso o payload reseta os DOIS campos.
 */
export const reativarPayload = (): { habilitado_reposicao_automatica: true; tipo_reposicao: 'automatica' } => ({
  habilitado_reposicao_automatica: true,
  tipo_reposicao: 'automatica',
});
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `bun run test src/lib/reposicao/__tests__/skuParam.test.ts`
Expected: PASS (todos, incluindo os testes pré-existentes).

- [ ] **Step 5: Typecheck (este arquivo compila sozinho)**

Run: `heavy bun run typecheck`
Expected: sem novos erros (o `tipo_reposicao?` opcional não quebra os literais de view do hook).

- [ ] **Step 6: Commit**

```bash
git add src/lib/reposicao/sku-param.ts src/lib/reposicao/__tests__/skuParam.test.ts
git commit -m "feat(reposicao): tipo_reposicao + helpers isDescontinuado/reativarPayload (reativar SKU)"
```

---

## Task 2: Hook — branch "Descontinuados" + esconder do "Todos" + reativarMutation

**Files:**
- Modify: `src/components/reposicao/revisao/useRevisaoParametros.ts`

- [ ] **Step 1: Import do `reativarPayload`**

Na linha de import de `@/lib/reposicao/sku-param` (linha 9), adicione `reativarPayload`:

```ts
import { type SkuParam, type RowWithPrice, type StatusFilterValue, reativarPayload } from "@/lib/reposicao/sku-param";
```

- [ ] **Step 2: Bifurcar o fall-through (default vs descontinuados)**

Substitua o bloco atual (linhas 167-179) — da declaração `let q = supabase.from("sku_parametros")...` até `.or("tipo_reposicao.is.null,tipo_reposicao.neq.produto_acabado");` — por:

```ts
      // Fall-through: branch "Todos" (default) E branch "Descontinuados" — mesma tabela
      // (sku_parametros), mesmo enriquecimento de preço e mapeamento abaixo; só o predicado muda.
      let q = supabase
        .from("sku_parametros")
        .select("*", { count: "exact" })
        .eq("empresa", empresa);

      if (statusFilter === "descontinuados") {
        // SKUs desligados de propósito pelo humano (botão "descontinuar SKU" nos Pedidos).
        // Sem filtro de ativo/estoque_minimo: mostra tudo que o humano descontinuou, com preço
        // (o gatilho de reativar é "o preço voltou a ser competitivo").
        q = q.eq("tipo_reposicao", "descontinuado");
      } else {
        // "Todos": esconde Produto Acabado ('04', fabricado) E descontinuados, preservando os NULL
        // (ainda não classificados). Antes, descontinuado VAZAVA aqui (só tipo='produto_acabado' saía).
        // String estática (sem interpolação) → não dispara a regra no-restricted-syntax do .or().
        q = q
          .eq("ativo", true)
          .not("estoque_minimo", "is", null)
          .or("tipo_reposicao.is.null,and(tipo_reposicao.neq.produto_acabado,tipo_reposicao.neq.descontinuado)");
      }
```

O restante do bloco (a partir de `if (classes.length > 0) q = q.in(...)`, a ordenação, o `range`, e todo o enriquecimento de preço via `v_sku_parametros_sugeridos`) permanece **idêntico** — vale para os dois branches.

- [ ] **Step 3: Adicionar a `reativarMutation`**

Logo após o bloco `promoverMutation` (termina na linha ~278, antes de `const toggleClasse`), adicione:

```ts
  // Reativa um SKU descontinuado: religa a reposição automática (espelho do "descontinuar SKU"
  // dos Pedidos). Update direto — a mesma escrita PostgREST que a tela já usa pra editar
  // parâmetros (updateMutation). Por empresa+sku, simétrico ao descontinuarMutation.
  const reativarMutation = useMutation({
    mutationFn: async (sku: number) => {
      const { error } = await supabase
        .from("sku_parametros")
        .update(reativarPayload())
        .eq("empresa", empresa)
        .eq("sku_codigo_omie", sku);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("SKU reativado — volta a ser sugerido no próximo ciclo");
      queryClient.invalidateQueries({ queryKey: ["sku_parametros_revisao"] });
    },
    onError: (e: Error) => toast.error("Falha ao reativar: " + e.message),
  });
```

- [ ] **Step 4: Expor no return**

No objeto de retorno do hook (linhas 298-318), adicione `reativarMutation` logo após `promoverMutation,`:

```ts
    updateMutation,
    promoverMutation,
    reativarMutation,
  };
```

- [ ] **Step 5: Typecheck**

Run: `heavy bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/reposicao/revisao/useRevisaoParametros.ts
git commit -m "feat(reposicao): filtro Descontinuados na Revisao + reativarMutation (esconde do Todos)"
```

---

## Task 3: UI — opção de filtro, badge, botão Reativar e wiring

**Files:**
- Modify: `src/components/reposicao/revisao/FiltrosCard.tsx`
- Modify: `src/components/reposicao/revisao/SkuRow.tsx`
- Modify: `src/components/reposicao/revisao/RevisaoTable.tsx`
- Modify: `src/pages/AdminReposicaoRevisao.tsx`

- [ ] **Step 1: `FiltrosCard` — opção "Descontinuados"**

No `<SelectContent>` (após o `<SelectItem value="primeira_compra">…</SelectItem>`, linha ~74), adicione:

```tsx
                <SelectItem value="descontinuados">
                  Descontinuados
                </SelectItem>
```

- [ ] **Step 2: `SkuRow` — imports (helper + AlertDialog)**

(a) Adicione `isDescontinuado` ao import de `@/lib/reposicao/sku-param`:

```tsx
import {
  type RowWithPrice,
  fonteBadgeVariant,
  fonteBadgeLabel,
  classBadge,
  fmt,
  fmtBRL,
  isDescontinuado,
} from "@/lib/reposicao/sku-param";
```

(b) Adicione o import do AlertDialog (após o import de `Button`):

```tsx
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
```

- [ ] **Step 3: `SkuRow` — props e flag**

Estenda a interface:

```tsx
interface SkuRowProps {
  row: RowWithPrice;
  onOpenDetail: (row: RowWithPrice) => void;
  onPromover?: (sku: number) => void;
  promovendo?: boolean;
  onReativar?: (sku: number) => void;
  reativando?: boolean;
}
```

Atualize a assinatura e adicione a flag no topo do componente:

```tsx
export function SkuRow({ row: r, onOpenDetail, onPromover, promovendo, onReativar, reativando }: SkuRowProps) {
  const isCandidato = r.status_sugestao === "CANDIDATO_PRIMEIRA_COMPRA";
  const umClienteSo = isCandidato && r.recorrencia_clientes_180d === 1;
  const descontinuado = isDescontinuado(r);
```

- [ ] **Step 4: `SkuRow` — badge "Descontinuado" na coluna Status**

Substitua a coluna Status (o `<TableCell>` que começa em `isCandidato ? (` … até o `</TableCell>` antes da coluna de ações, linhas 81-101) por:

```tsx
      <TableCell>
        {descontinuado ? (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground border-muted-foreground/20"
            title="SKU descontinuado — fora da reposição automática. Reative quando voltar a comprar."
          >
            Descontinuado
          </Badge>
        ) : isCandidato ? (
          <Badge
            variant="secondary"
            className="bg-status-info-bg text-status-info border-status-info/20"
            title="Vende com recorrência mas está fora da reposição automática. Revise e promova: entra no fluxo normal de compra (qtde-teste capada)."
          >
            Candidato 1ª compra
          </Badge>
        ) : r.read_only ? (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground border-muted-foreground/20"
            title="SKU bloqueado: fornecedor ainda não habilitado para reposição automática"
          >
            Aguardando fornecedor
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
```

- [ ] **Step 5: `SkuRow` — botão "Reativar" na coluna de ações**

Na coluna de ações (o `<div className="flex items-center justify-end gap-1">`), adicione o bloco abaixo **logo antes** do botão "Detalhes" (`<Button size="sm" variant="ghost" onClick={() => onOpenDetail(r)}>`):

```tsx
          {descontinuado && onReativar && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" disabled={reativando}>
                  {reativando ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reativar"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reativar SKU?</AlertDialogTitle>
                  <AlertDialogDescription>
                    <span className="font-mono">{r.sku_codigo_omie}</span> — {r.sku_descricao ?? "—"}.
                    <br />
                    Volta para a reposição automática e passa a ser sugerido no próximo ciclo
                    (só se o estoque estiver no ponto de pedido). Os parâmetros antigos são preservados.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={reativando}>Voltar</AlertDialogCancel>
                  <AlertDialogAction onClick={() => onReativar(r.sku_codigo_omie)} disabled={reativando}>
                    Reativar
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
```

- [ ] **Step 6: `RevisaoTable` — repassar props**

Estenda a interface `RevisaoTableProps` (adicione após `promovendo?: boolean;`):

```tsx
  onReativar?: (sku: number) => void;
  reativando?: boolean;
```

Adicione ao destructuring de props da função (após `promovendo,`):

```tsx
  onReativar,
  reativando,
```

E repasse ao `<SkuRow>` no `.map` (após `promovendo={promovendo}`):

```tsx
                <SkuRow
                  key={r.id}
                  row={r}
                  onOpenDetail={onOpenDetail}
                  onPromover={onPromover}
                  promovendo={promovendo}
                  onReativar={onReativar}
                  reativando={reativando}
                />
```

- [ ] **Step 7: `AdminReposicaoRevisao` — ligar a mutation + aviso contextual**

(a) No destructuring do hook (após `promoverMutation,`), adicione:

```tsx
    promoverMutation,
    reativarMutation,
  } = useRevisaoParametros();
```

(b) No `<RevisaoTable>`, adicione (após `promovendo={promoverMutation.isPending}`):

```tsx
        onPromover={(sku) => promoverMutation.mutate(sku)}
        promovendo={promoverMutation.isPending}
        onReativar={(sku) => reativarMutation.mutate(sku)}
        reativando={reativarMutation.isPending}
      />
```

(c) Adicione o aviso contextual logo após o bloco `{statusFilter === "primeira_compra" && (…)}` (antes do `<FiltrosCard>`):

```tsx
      {statusFilter === "descontinuados" && (
        <p className="text-sm text-muted-foreground">
          SKUs que você descontinuou de propósito (fora da reposição automática). Clique em
          <strong> Reativar</strong> quando o preço voltar a ser competitivo — o item volta ao fluxo
          normal de compra a partir do próximo ciclo (o motor só compra se o estoque estiver baixo).
        </p>
      )}
```

- [ ] **Step 8: Typecheck + lint**

Run: `heavy bun run typecheck && bun lint`
Expected: typecheck PASS; lint sem novos erros (em especial, sem `no-restricted-syntax` — o `.or()` novo é string estática).

- [ ] **Step 9: Commit**

```bash
git add src/components/reposicao/revisao/FiltrosCard.tsx src/components/reposicao/revisao/SkuRow.tsx src/components/reposicao/revisao/RevisaoTable.tsx src/pages/AdminReposicaoRevisao.tsx
git commit -m "feat(reposicao): UI do filtro Descontinuados + botao Reativar na Revisao"
```

---

## Task 4: Verificação integrada + atualização do SkuRow.test (se existir)

**Files:**
- Possivelmente: `src/components/reposicao/revisao/__tests__/SkuRow.test.tsx` (já existe)

- [ ] **Step 1: Conferir o teste do SkuRow**

Run: `bun run test src/components/reposicao/revisao/__tests__/SkuRow.test.tsx`
Expected: PASS. As props novas (`onReativar`/`reativando`) são opcionais → o render existente não quebra. Se algum teste construir `row` sem `tipo_reposicao`, segue válido (`isDescontinuado` → false). **Não** adicionar teste novo de UI a menos que a suíte quebre; a lógica testável já está no helper puro (Task 1).

- [ ] **Step 2: Suíte completa + build**

Run: `heavy bun run test`
Expected: PASS (a CLAUDE.md cita baseline 241/241; deve subir com os 2 testes novos do helper).

Run: `heavy bun run build`
Expected: build OK (sem PWA em dev é `build:dev`; aqui valide o `build`).

- [ ] **Step 3: Commit (se houve ajuste de teste)**

```bash
git add -A
git commit -m "test(reposicao): valida SkuRow com filtro Descontinuados"
```

Se nada mudou neste passo, pule o commit.

---

## Verificação manual (critério de pronto — pós-Publish no Lovable)

1. Em `/admin/reposicao/pedidos`, descontinuar um SKU de teste (botão 🚫).
2. Em `/admin/reposicao/revisao`, filtro **"Todos"**: o SKU **não** aparece mais (antes vazava).
3. Filtro **"Descontinuados"**: o SKU aparece, com badge "Descontinuado" e preço de compra/venda visível.
4. Clicar **"Reativar"** → confirmar → toast "SKU reativado…" → o SKU some da lista de descontinuados.
5. Conferir no banco (SQL Editor, read-only): `SELECT tipo_reposicao, habilitado_reposicao_automatica FROM sku_parametros WHERE empresa='OBEN' AND sku_codigo_omie=<sku>` → `automatica` / `true`.

## Deploy

- **Só Publish do frontend no Lovable.** Sem SQL Editor, sem deploy de edge function.

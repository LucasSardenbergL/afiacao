# Fundação KB — PR-0b: popular boletins em LOTE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tornar a base de conhecimento populável em volume — subir vários PDFs de uma vez, auto-extrair as fichas com a IA, e aprovar em lote os de alta confiança (revisando só os duvidosos).

**Architecture:** 100% frontend, reusa as edges existentes (`kb-ingest-document`, `kb-extract-specs`) e o `KbSpecsForm`/`useSaveProductSpecs`. **Sem tabela nova, sem migration, sem tocar edges.** A "fila de aprovação" é derivada: documentos `status='ready'` que ainda não têm ficha aprovada (`kb_product_specs.approved_at`). A extração em lote roda no client (concorrência limitada, progresso visível) e o estado é efêmero — fechar a aba re-extrai depois (idempotente, ~centavos). Decisão de produto (founder): **aprovar em lote os ≥85% de confiança + revisar os duvidosos.**

**Tech Stack:** React + TS, React Query, vitest (helpers puros), shadcn/ui. Idioma pt-BR no código.

**Escopo (e o que fica fora):** entrega popular+aprovar em lote. **Fora:** o CASAMENTO/vínculo com o item de venda (é o 0c, precisa da migration do PR-0a aplicada + tipos); processamento server-side persistente da extração (V2, se a fricção de re-extrair incomodar com centenas de boletins). Os 2 bugs do fluxo atual (`useSaveProductSpecs.onConflict`, `useKbProductSpecs` sem `approved_at`) ficam pro 0c.

---

## File Structure
- **Create** `src/lib/knowledge-base/aprovacao-fila.ts` — helpers puros: `classificarExtracao`, `particionarResultados`, `LIMIAR_AUTO_APROVACAO`. + testes.
- **Create** `src/hooks/useApprovalQueue.ts` — documentos ready sem ficha aprovada.
- **Create** `src/hooks/useBatchUploadKbDocuments.ts` — sobe N PDFs (concorrência limitada).
- **Create** `src/hooks/useBatchExtract.ts` — extrai N docs em lote (concorrência + progresso).
- **Create** `src/hooks/useBulkApproveSpecs.ts` — aprova N fichas (loop `useSaveProductSpecs`-style).
- **Create** `src/components/knowledge-base/BatchUploadDialog.tsx` — upload múltiplo.
- **Create** `src/components/knowledge-base/ApprovalQueueSection.tsx` — a fila + extrair/aprovar.
- **Modify** `src/pages/AdminKnowledgeBase.tsx` — abas "Documentos" | "A aprovar (N)".

---

## Task 1: Helper de classificação da fila (puro, TDD)

**Files:** Create `src/lib/knowledge-base/aprovacao-fila.ts` + `src/lib/knowledge-base/__tests__/aprovacao-fila.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// src/lib/knowledge-base/__tests__/aprovacao-fila.test.ts
import { describe, it, expect } from 'vitest';
import { classificarExtracao, particionarResultados, LIMIAR_AUTO_APROVACAO } from '../aprovacao-fila';
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

const spec = (over: Partial<KbExtractedSpec> = {}): KbExtractedSpec =>
  ({ product_code: 'FO20.6827.00', product_name: 'x', supplier: 'sayerlack',
     extraction_confidence: 0.9, extraction_gaps: [], ...over } as KbExtractedSpec);

describe('classificarExtracao', () => {
  it("confiança ≥ limiar E com product_code → 'auto'", () => {
    expect(classificarExtracao(spec({ extraction_confidence: 0.9 }))).toBe('auto');
    expect(classificarExtracao(spec({ extraction_confidence: LIMIAR_AUTO_APROVACAO }))).toBe('auto');
  });
  it("confiança < limiar → 'revisar'", () => {
    expect(classificarExtracao(spec({ extraction_confidence: 0.5 }))).toBe('revisar');
  });
  it("sem product_code → 'revisar' (não dá pra salvar, NOT NULL)", () => {
    expect(classificarExtracao(spec({ product_code: '', extraction_confidence: 0.99 }))).toBe('revisar');
  });
  it('confiança nula/ausente → revisar (não fabrica certeza)', () => {
    expect(classificarExtracao(spec({ extraction_confidence: null }))).toBe('revisar');
  });
});

describe('particionarResultados', () => {
  it('separa auto vs revisar preservando o docId', () => {
    const r = particionarResultados([
      { documentId: 'd1', spec: spec({ extraction_confidence: 0.9 }) },
      { documentId: 'd2', spec: spec({ extraction_confidence: 0.4 }) },
      { documentId: 'd3', spec: spec({ product_code: '' }) },
    ]);
    expect(r.auto.map((x) => x.documentId)).toEqual(['d1']);
    expect(r.revisar.map((x) => x.documentId)).toEqual(['d2', 'd3']);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`bun run test src/lib/knowledge-base/__tests__/aprovacao-fila.test.ts`).

- [ ] **Step 3: Implement**

```ts
// src/lib/knowledge-base/aprovacao-fila.ts
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Confiança mínima da extração pra entrar no "aprovar em lote" (decisão do founder). */
export const LIMIAR_AUTO_APROVACAO = 0.85;

export interface ResultadoExtracao {
  documentId: string;
  spec: KbExtractedSpec;
}

/** 'auto' = aprovável em lote (confiança ≥ limiar E tem product_code, que é NOT NULL no banco).
 *  'revisar' = abrir e conferir (baixa confiança, sem código, ou confiança ausente). */
export function classificarExtracao(
  spec: KbExtractedSpec,
  limiar: number = LIMIAR_AUTO_APROVACAO,
): 'auto' | 'revisar' {
  const conf = spec.extraction_confidence;
  if (!spec.product_code) return 'revisar';
  if (conf == null || conf < limiar) return 'revisar';
  return 'auto';
}

export function particionarResultados(
  resultados: ResultadoExtracao[],
  limiar: number = LIMIAR_AUTO_APROVACAO,
): { auto: ResultadoExtracao[]; revisar: ResultadoExtracao[] } {
  const auto: ResultadoExtracao[] = [];
  const revisar: ResultadoExtracao[] = [];
  for (const r of resultados) {
    (classificarExtracao(r.spec, limiar) === 'auto' ? auto : revisar).push(r);
  }
  return { auto, revisar };
}
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Commit** (`git add src/lib/knowledge-base/aprovacao-fila.ts src/lib/knowledge-base/__tests__/aprovacao-fila.test.ts && git commit -m "feat(kb): helper de classificação da fila de aprovação (puro, TDD)"`).

---

## Task 2: Hook `useApprovalQueue` (docs ready sem ficha aprovada)

**Files:** Create `src/hooks/useApprovalQueue.ts`

Pega documentos `status='ready'` cujo `id` NÃO está entre os `document_id` de specs aprovados (`approved_at IS NOT NULL`). Duas queries + filtro em memória (volume baixo; sem RPC).

- [ ] **Step 1: Implement**

```ts
// src/hooks/useApprovalQueue.ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { KbDocument } from '@/lib/knowledge-base/types';

/** Documentos prontos (status='ready') que ainda NÃO têm ficha aprovada vinculada.
 *  É a "fila de aprovação": o que falta extrair/aprovar pra popular a base. */
export function useApprovalQueue() {
  return useQuery({
    queryKey: ['kb-approval-queue'],
    staleTime: 30_000,
    queryFn: async (): Promise<KbDocument[]> => {
      const { data: docs, error: e1 } = await supabase
        .from('kb_documents')
        .select('*')
        .eq('status', 'ready')
        .order('created_at', { ascending: false })
        .limit(500);
      if (e1) throw e1;

      const { data: approved, error: e2 } = await supabase
        .from('kb_product_specs')
        .select('document_id')
        .not('approved_at', 'is', null)
        .not('document_id', 'is', null);
      if (e2) throw e2;

      const aprovados = new Set((approved ?? []).map((r) => r.document_id as string));
      return (docs ?? []).filter((d) => !aprovados.has(d.id)) as KbDocument[];
    },
  });
}
```

- [ ] **Step 2: Verify typecheck** (`bun run typecheck 2>&1 | tail -20`) — sem novos erros.

- [ ] **Step 3: Commit** (`git commit -am "feat(kb): useApprovalQueue — docs prontos sem ficha aprovada"`).

---

## Task 3: Upload múltiplo (`useBatchUploadKbDocuments` + `BatchUploadDialog`)

**Files:** Create `src/hooks/useBatchUploadKbDocuments.ts`, `src/components/knowledge-base/BatchUploadDialog.tsx`

O hook reusa a MESMA lógica de `useUploadKbDocument` (storage + insert kb_documents `status='processing'` + invoke `kb-ingest-document` fire-and-forget) num loop com concorrência limitada (3). Cada PDF: título = nome do arquivo (sem extensão); `type='boletim_tecnico'`; `supplier`/`tags` comuns opcionais; `product_code` vazio (a IA extrai depois). Progresso por arquivo.

- [ ] **Step 1: Implement o hook** seguindo o padrão de `src/hooks/useUploadKbDocument.ts` (ler esse arquivo). Contrato:

```ts
export interface BatchUploadItem { file: File; status: 'pendente' | 'enviando' | 'ok' | 'erro'; error?: string }
export interface BatchUploadInput { files: File[]; supplier?: string; tags?: string[] }
// useBatchUploadKbDocuments(): { run(input): Promise<void>; items: BatchUploadItem[]; isRunning: boolean }
```
Implementação: estado `items` (um por file), concorrência limitada a 3 (worker pool simples), cada item faz o mesmo do `useUploadKbDocument` (extrair a lógica de upload-de-1 numa função reutilizável `uploadOne(file, {supplier, tags})` — pode duplicar a do hook existente, mas mantenha 1:1 com ela). Ao fim, `queryClient.invalidateQueries(['kb-documents'])` + `['kb-approval-queue']`.

- [ ] **Step 2: Implement `BatchUploadDialog`** — `<Input type="file" accept="application/pdf" multiple />` + lista os arquivos escolhidos com badge de status (pendente/enviando/ok/erro) + campos opcionais comuns (Fornecedor, Tags) + botão "Enviar N arquivos" (disabled enquanto `isRunning`). Ao terminar, toast "N enviados, M com erro" + fecha. Siga o estilo do `KbDocumentForm.tsx`.

- [ ] **Step 3: Verify** typecheck + lint. **Commit** (`git commit -am "feat(kb): upload múltiplo de boletins (hook + dialog)"`).

---

## Task 4: Extração em lote + aprovação em lote (`useBatchExtract`, `useBulkApproveSpecs`)

**Files:** Create `src/hooks/useBatchExtract.ts`, `src/hooks/useBulkApproveSpecs.ts`

`useBatchExtract`: dado uma lista de `documentId`, invoca `kb-extract-specs` (via `invokeFunction`, como `useExtractSpecs`) com concorrência 3, expõe progresso e acumula `ResultadoExtracao[]` (+ erros por doc). NÃO persiste (efêmero).

`useBulkApproveSpecs`: dado `ResultadoExtracao[]`, faz para cada um o MESMO upsert de `useSaveProductSpecs` (`{...spec, document_id, extracted_by, approved_by, approved_at: now}`, `onConflict: 'product_code'`). Reporta sucesso/erro por item. Invalida `['kb-product-specs']`, `['kb-approval-queue']`.

- [ ] **Step 1: Implement `useBatchExtract`** (ler `src/hooks/useExtractSpecs.ts` pro contrato da edge):

```ts
export interface BatchExtractProgress { total: number; feitos: number; rodando: boolean }
// retorna { run(documentIds): Promise<ResultadoExtracao[]>; progress; resultados; erros }
```
Pool de concorrência 3; cada doc → `invokeFunction('kb-extract-specs', {documentId})` → empurra `{documentId, spec}` em `resultados` (ou registra erro). Atualiza `progress.feitos`.

- [ ] **Step 2: Implement `useBulkApproveSpecs`** (ler `src/hooks/useSaveProductSpecs.ts` e reusar a MESMA forma de payload/upsert):

```ts
// useBulkApproveSpecs(): { approve(resultados: ResultadoExtracao[]): Promise<{ok: number; erros: {documentId:string; error:string}[]}>; isApproving }
```
Loop sequencial (evita corrida no upsert por product_code) chamando o upsert. Auth via `supabase.auth.getUser()`.

- [ ] **Step 3: Verify** typecheck. **Commit** (`git commit -am "feat(kb): extração em lote + aprovação em lote (hooks)"`).

---

## Task 5: UI da fila (`ApprovalQueueSection`) + abas na página

**Files:** Create `src/components/knowledge-base/ApprovalQueueSection.tsx`, Modify `src/pages/AdminKnowledgeBase.tsx`

`ApprovalQueueSection`: usa `useApprovalQueue` (lista N docs ready-sem-ficha). Botão **"Extrair pendentes (N)"** → `useBatchExtract.run(ids)` com barra de progresso (`feitos/total`). Quando termina, `particionarResultados`: bloco **"Prontas pra aprovar (M)"** com botão "Aprovar M" (→ `useBulkApproveSpecs.approve(auto)`); bloco **"Revisar (K)"** listando cada um com a confiança + nº de campos faltando + botão "Revisar" que abre um Dialog com o `KbSpecsForm` (reusa! `initialValues=spec`, `documentId`, `onSaved` → refetch da fila). Toast de resultado. Após aprovar, `invalidateQueries(['kb-approval-queue'])`.

`AdminKnowledgeBase.tsx`: trocar o header pra **abas** (`Tabs` shadcn): "Documentos" (a lista atual + o botão que vira `BatchUploadDialog`) e **"A aprovar"** com badge da contagem (`useApprovalQueue().data?.length`), renderizando `ApprovalQueueSection`. Manter o comportamento existente da aba Documentos.

- [ ] **Step 1: Implement `ApprovalQueueSection`** (reusa `KbSpecsForm`, `classificarExtracao`/`particionarResultados`, os 3 hooks). Estado efêmero dos `resultados` em `useState`.

- [ ] **Step 2: Modify `AdminKnowledgeBase`** pra abas + trocar "Novo documento" por "Subir boletins" (→ `BatchUploadDialog`); manter a lista atual.

- [ ] **Step 3: Verify** typecheck + test + lint + build (gate `validate`). Redirecionar pra log + `echo $?` (não `| tail`).

- [ ] **Step 4: Commit** (`git commit -am "feat(kb): tela de popular em lote — fila de aprovação + abas"`) + atualizar CLAUDE.md (marcar 0b entregue na entrada da Fundação) + abrir PR (ou adicionar ao PR-0 existente, conforme o estado).

---

## Self-Review (preenchido)
- **Cobertura:** upload múltiplo → T3; fila (anti-join) → T2; extração lote → T4; aprovar lote ≥85% + revisar duvidosos → T1 (classificar) + T5 (UI); reuso KbSpecsForm → T5. ✅
- **Fora de escopo (documentado):** casamento/vínculo (0c); server-side persistente (V2); 2 bugs do fluxo atual (0c). ✅
- **Type consistency:** `ResultadoExtracao {documentId, spec}` usado consistente em T1/T4/T5; `classificarExtracao`/`particionarResultados`/`LIMIAR_AUTO_APROVACAO` batem entre T1 e T5. ✅
- **Placeholder scan:** helpers têm código real; hooks/UI têm contrato + instrução de reuso dos arquivos-modelo (padrão subagent-driven do projeto). ✅

## Riscos / notas
- **Estado efêmero:** fechar a aba durante a extração perde os não-aprovados (re-extrai; idempotente, ~centavos). Aceitável v1.
- **Upsert por `product_code` (bug #1 latente):** 2 boletins com o mesmo código → o 2º sobrescreve no aprovar. Raro; fix completo no 0c (identidade composta). A aprovação é sequencial pra não competir.
- **Sem `product_code` extraído:** vai pra "Revisar" (o founder preenche no `KbSpecsForm` antes de aprovar) — não trava o lote.

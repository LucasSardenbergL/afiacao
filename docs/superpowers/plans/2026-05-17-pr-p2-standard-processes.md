# PR-P2 — Standard Processes Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Biblioteca de **processos padrão da fábrica** — referências modelo que vendedores usam pra comparar contra o que o cliente faz hoje (PR-P3) e pra sugerir caminhos quando cliente diz "queria atingir X" (PR-P4). Master cadastra processos canônicos (ex: "Sayerlack PU 2K alto padrão moveleiro", "Hidrossolúvel ecológico", "Nitro tradicional rápido"); vendedores podem **propor** processos novos (status `draft`); master **aprova** (status `published`). Cada etapa referencia produtos reais via `kb_product_specs.product_code`.

**Architecture:**
- Schema: `standard_processes` (id, name, segmento, porte_alvo, etapas jsonb, target_audience, expected_outcomes, status, created_by, reviewed_by) + workflow draft/in_review/published/archived
- Edge fn opcional (estiramento): `generate-standard-process-from-doc` que pega um boletim/case do KB e propõe processo via Claude — fora de escopo neste PR, pra simplificar
- Hooks: `useStandardProcessesList` (filtros), `useStandardProcess(id)`, `useSaveStandardProcess` (com workflow), `useApproveStandardProcess` (só master)
- UI: página `/admin/standard-processes` (lista + filtros) + `/admin/standard-processes/:id` (view/edit) + `/admin/standard-processes/new` (form de criação)
- Form reutiliza estrutura de `ProcessEtapa` (do PR-P1) com extensão pra produtos vinculados a `kb_product_specs.product_code`

**Não-objetivos:**
- Comparação com customer_processes (PR-P3)
- Sugestão automática via IA (PR-P4)
- Versionamento profundo (parent_id existe, mas UI só edita current)
- Edge fn de geração via Claude (estiramento futuro — vendedor digita manual)
- Templates pré-cadastrados (master cadastra os primeiros após merge)

---

## File Structure

**Criar:**
- `supabase/migrations/{ts}_standard_processes.sql`
- `src/lib/standard-process/types.ts`
- `src/hooks/useStandardProcessesList.ts`
- `src/hooks/useStandardProcess.ts`
- `src/hooks/useSaveStandardProcess.ts`
- `src/hooks/useApproveStandardProcess.ts`
- `src/components/standard-process/StandardProcessRow.tsx`
- `src/components/standard-process/StandardProcessStatusBadge.tsx`
- `src/components/standard-process/StandardProcessForm.tsx`
- `src/components/standard-process/StandardProcessDetail.tsx`
- `src/pages/AdminStandardProcesses.tsx`
- `src/pages/AdminStandardProcessDetail.tsx`
- `src/pages/AdminStandardProcessNew.tsx`

**Modificar:**
- `src/integrations/supabase/types.ts` (manual)
- `src/App.tsx` — 3 lazy + 3 rotas
- `src/components/AppShell.tsx` — item de menu "Processos padrão" na seção Gestão

---

## Task 1: Migration

```sql
CREATE TABLE IF NOT EXISTS public.standard_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificação
  name text NOT NULL,                            -- "Sayerlack PU 2K alto padrão moveleiro"
  slug text UNIQUE,                              -- "sayerlack-pu-2k-alto-padrao-moveleiro" (gerado client-side)
  description text,                              -- 1-2 frases descritivas

  -- Categorização (mesmos eixos de customer_processes pra match)
  segmento text NOT NULL,                        -- 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', etc
  porte_alvo text[],                             -- ['pequeno', 'medio'] — processos servem pra múltiplos portes
  tags text[] DEFAULT '{}',                      -- ['pu_2k', 'cabine_pressurizada', 'alto_padrao']

  -- Conteúdo
  etapas jsonb NOT NULL,                         -- array de StandardProcessEtapa (extende ProcessEtapa com produtos_kb)
  expected_outcomes text[],                      -- ["acabamento alto brilho", "resistência química superior", "secagem rápida"]
  target_audience text,                          -- "Marcenarias 50-500 peças/mês com foco em móveis altos"
  prerequisites text[],                          -- ["cabine simples", "compressor 1HP+", "lixadeira"]

  -- Workflow draft/approval
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
  status_notes text,                             -- razão de archive, feedback do reviewer

  -- Versionamento
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.standard_processes(id) ON DELETE SET NULL,

  -- Auditoria
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_standard_processes_status_segmento
  ON public.standard_processes (status, segmento, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_standard_processes_published_segmento
  ON public.standard_processes (segmento)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_standard_processes_slug
  ON public.standard_processes (slug);

DROP TRIGGER IF EXISTS trg_standard_processes_updated_at ON public.standard_processes;
CREATE TRIGGER trg_standard_processes_updated_at
  BEFORE UPDATE ON public.standard_processes
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

ALTER TABLE public.standard_processes ENABLE ROW LEVEL SECURITY;

-- Staff lê published; criador vê seus drafts; master vê tudo
CREATE POLICY "standard_processes_select_visible" ON public.standard_processes
  FOR SELECT
  USING (
    status = 'published'
    OR created_by = auth.uid()
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Staff pode criar (sempre como draft)
CREATE POLICY "standard_processes_insert_staff" ON public.standard_processes
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Criador edita drafts próprios; master edita qualquer
CREATE POLICY "standard_processes_update_owner_or_master" ON public.standard_processes
  FOR UPDATE
  USING (
    (created_by = auth.uid() AND status IN ('draft', 'in_review'))
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- Só master deleta
CREATE POLICY "standard_processes_delete_master" ON public.standard_processes
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

COMMENT ON TABLE public.standard_processes IS 'Processos modelo da fábrica. Workflow draft→in_review→published. Cada etapa referencia kb_product_specs.product_code. Usado em PR-P3 (comparação) e PR-P4 (sugestões em tempo real).';
```

Commit: `feat(process): migration standard_processes + workflow draft/approval`

---

## Task 2: Domain types

`src/lib/standard-process/types.ts`:

```ts
import type { ProcessEtapa } from '@/lib/customer-process/types';

/** Etapa do processo padrão estende ProcessEtapa do PR-P1 + vincula produtos do KB */
export interface StandardProcessEtapa extends ProcessEtapa {
  /** Códigos de kb_product_specs.product_code recomendados pra essa etapa */
  produtos_kb: string[];
  /** Texto livre adicional explicando por que esse produto/abordagem */
  rationale?: string;
}

export type StandardProcessStatus = 'draft' | 'in_review' | 'published' | 'archived';

export interface StandardProcess {
  id: string;
  name: string;
  slug: string | null;
  description: string | null;
  segmento: string;
  porte_alvo: string[];
  tags: string[];
  etapas: StandardProcessEtapa[];
  expected_outcomes: string[];
  target_audience: string | null;
  prerequisites: string[];
  status: StandardProcessStatus;
  status_notes: string | null;
  version: number;
  parent_id: string | null;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export const STANDARD_PROCESS_STATUS_LABEL: Record<StandardProcessStatus, string> = {
  draft: 'Rascunho',
  in_review: 'Em revisão',
  published: 'Publicado',
  archived: 'Arquivado',
};

/** Slug helper: "Sayerlack PU 2K Alto Padrão" → "sayerlack-pu-2k-alto-padrao" */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}
```

Commit: `feat(process): types StandardProcess + StandardProcessEtapa + slugify`

---

## Task 3: Hooks (4 hooks)

`src/hooks/useStandardProcessesList.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StandardProcess, StandardProcessStatus } from '@/lib/standard-process/types';

interface Filters {
  status?: StandardProcessStatus[];
  segmento?: string;
}

export function useStandardProcessesList(filters: Filters = {}) {
  return useQuery({
    queryKey: ['standard-processes', filters],
    staleTime: 30_000,
    queryFn: async (): Promise<StandardProcess[]> => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q = (supabase.from('standard_processes') as any).select('*');
      const statusList = filters.status ?? ['draft', 'in_review', 'published'];
      q = q.in('status', statusList);
      if (filters.segmento) q = q.eq('segmento', filters.segmento);
      q = q.order('updated_at', { ascending: false }).limit(200);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as StandardProcess[];
    },
  });
}
```

`src/hooks/useStandardProcess.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { StandardProcess } from '@/lib/standard-process/types';

export function useStandardProcess(id: string | null) {
  return useQuery({
    queryKey: ['standard-process', id],
    enabled: !!id,
    queryFn: async (): Promise<StandardProcess | null> => {
      if (!id) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('standard_processes') as any)
        .select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      return (data as StandardProcess) ?? null;
    },
  });
}
```

`src/hooks/useSaveStandardProcess.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { slugify } from '@/lib/standard-process/types';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from '@/lib/standard-process/types';

interface SaveInput {
  id?: string;  // se passar, UPDATE; senão INSERT
  name: string;
  description?: string;
  segmento: string;
  porte_alvo: string[];
  tags: string[];
  etapas: StandardProcessEtapa[];
  expected_outcomes: string[];
  target_audience?: string;
  prerequisites: string[];
  status: StandardProcessStatus;
}

export function useSaveStandardProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<StandardProcess> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const payload = {
        name: input.name,
        slug: slugify(input.name),
        description: input.description ?? null,
        segmento: input.segmento,
        porte_alvo: input.porte_alvo,
        tags: input.tags,
        etapas: input.etapas,
        expected_outcomes: input.expected_outcomes,
        target_audience: input.target_audience ?? null,
        prerequisites: input.prerequisites,
        status: input.status,
      };

      if (input.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('standard_processes') as any)
          .update(payload).eq('id', input.id).select().single();
        if (error) throw error;
        return data as StandardProcess;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('standard_processes') as any)
        .insert({ ...payload, created_by: user.id }).select().single();
      if (error) throw error;
      return data as StandardProcess;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      qc.invalidateQueries({ queryKey: ['standard-process', data.id] });
      toast.success('Processo salvo');
    },
    onError: (err) => toast.error('Erro ao salvar', { description: err instanceof Error ? err.message : '' }),
  });
}
```

`src/hooks/useApproveStandardProcess.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { StandardProcessStatus } from '@/lib/standard-process/types';

interface Input {
  id: string;
  status: StandardProcessStatus;
  notes?: string;
}

export function useApproveStandardProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, notes }: Input) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      const payload: Record<string, unknown> = {
        status,
        status_notes: notes ?? null,
      };
      if (status === 'published' || status === 'archived') {
        payload.reviewed_by = user.id;
        payload.reviewed_at = new Date().toISOString();
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase.from('standard_processes') as any)
        .update(payload).eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, { status }) => {
      qc.invalidateQueries({ queryKey: ['standard-processes'] });
      const label: Record<StandardProcessStatus, string> = {
        draft: 'Voltado pra rascunho',
        in_review: 'Enviado pra revisão',
        published: 'Publicado',
        archived: 'Arquivado',
      };
      toast.success(label[status]);
    },
    onError: (err) => toast.error('Erro ao atualizar status', { description: err instanceof Error ? err.message : '' }),
  });
}
```

Commit: `feat(process): hooks useStandardProcesses* (list, get, save, approve)`

---

## Task 4: Componentes auxiliares

`src/components/standard-process/StandardProcessStatusBadge.tsx`:

```tsx
import { Badge } from '@/components/ui/badge';
import { STANDARD_PROCESS_STATUS_LABEL, type StandardProcessStatus } from '@/lib/standard-process/types';

const COLOR: Record<StandardProcessStatus, string> = {
  draft: 'border-muted-foreground/30 text-muted-foreground',
  in_review: 'border-blue-300 text-blue-700 dark:border-blue-700 dark:text-blue-300',
  published: 'border-status-success text-status-success',
  archived: 'border-status-error text-status-error',
};

export function StandardProcessStatusBadge({ status }: { status: StandardProcessStatus }) {
  return <Badge variant="outline" className={`text-2xs ${COLOR[status]}`}>{STANDARD_PROCESS_STATUS_LABEL[status]}</Badge>;
}
```

`src/components/standard-process/StandardProcessRow.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StandardProcessStatusBadge } from './StandardProcessStatusBadge';
import { Factory } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { StandardProcess } from '@/lib/standard-process/types';

export function StandardProcessRow({ process }: { process: StandardProcess }) {
  return (
    <Link to={`/admin/standard-processes/${process.id}`}>
      <Card className="p-3 hover:bg-muted/40 transition-colors flex items-center gap-3">
        <Factory className="w-5 h-5 text-muted-foreground shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{process.name}</span>
            <Badge variant="outline" className="text-2xs">{process.segmento}</Badge>
            <StandardProcessStatusBadge status={process.status} />
          </div>
          <div className="text-2xs text-muted-foreground mt-0.5">
            {process.porte_alvo.length > 0 && <>portes: {process.porte_alvo.join(', ')} · </>}
            {process.etapas.length} etapas · atualizado {formatDistanceToNow(new Date(process.updated_at), { locale: ptBR, addSuffix: true })}
            {process.tags.length > 0 && <> · {process.tags.slice(0, 3).join(' · ')}</>}
          </div>
        </div>
      </Card>
    </Link>
  );
}
```

`src/components/standard-process/StandardProcessForm.tsx` — form RHF + Zod com:
- Identificação: name, description, segmento (select), porte_alvo (multi), tags (CSV), prerequisites (CSV), expected_outcomes (CSV)
- Etapas editáveis — campos por etapa: ordem, nome, tipo (select), produtos (CSV), produtos_kb (multi-select de specs aprovados via useKbProductSpecsList), rationale, tempo/temp/equipamentos/obs
- Botões: "Salvar rascunho", "Enviar pra revisão", "Cancelar"

Por economia de plano, sigo abordagem pragmática: form linear simples (Add/Remove etapa via push em array de state), não tableview complexa. Etapa = card.

```tsx
import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Loader2, Save, Send, Plus, Trash2 } from 'lucide-react';
import { useSaveStandardProcess } from '@/hooks/useSaveStandardProcess';
import { useKbProductSpecsList } from '@/hooks/useKbProductSpecsList';
import type { StandardProcess, StandardProcessEtapa, StandardProcessStatus } from '@/lib/standard-process/types';

const headerSchema = z.object({
  name: z.string().min(3),
  description: z.string().optional(),
  segmento: z.string().min(1),
  porte_alvo: z.string().default(''),          // CSV
  tags: z.string().default(''),
  expected_outcomes: z.string().default(''),
  prerequisites: z.string().default(''),
  target_audience: z.string().optional(),
});

type HeaderValues = z.infer<typeof headerSchema>;

const emptyEtapa = (ordem: number): StandardProcessEtapa => ({
  ordem,
  nome: '',
  tipo: 'aplicacao',
  produtos: [],
  parametros: {},
  equipamentos: [],
  observacoes: '',
  produtos_kb: [],
  rationale: '',
});

interface Props {
  initial?: StandardProcess;
  onSaved?: () => void;
}

const splitCsv = (s: string | undefined) => (s ?? '').split(',').map((t) => t.trim()).filter(Boolean);
const joinCsv = (a: string[] | undefined) => (a ?? []).join(', ');

export function StandardProcessForm({ initial, onSaved }: Props) {
  const save = useSaveStandardProcess();
  const { data: specs } = useKbProductSpecsList();

  const { register, handleSubmit, formState: { errors } } = useForm<HeaderValues>({
    resolver: zodResolver(headerSchema),
    defaultValues: {
      name: initial?.name ?? '',
      description: initial?.description ?? '',
      segmento: initial?.segmento ?? '',
      porte_alvo: joinCsv(initial?.porte_alvo),
      tags: joinCsv(initial?.tags),
      expected_outcomes: joinCsv(initial?.expected_outcomes),
      prerequisites: joinCsv(initial?.prerequisites),
      target_audience: initial?.target_audience ?? '',
    },
  });

  const [etapas, setEtapas] = useState<StandardProcessEtapa[]>(
    initial?.etapas?.length ? initial.etapas : [emptyEtapa(1)]
  );

  const addEtapa = () => setEtapas((prev) => [...prev, emptyEtapa(prev.length + 1)]);
  const removeEtapa = (idx: number) => setEtapas((prev) => prev.filter((_, i) => i !== idx).map((e, i) => ({ ...e, ordem: i + 1 })));
  const updateEtapa = (idx: number, patch: Partial<StandardProcessEtapa>) =>
    setEtapas((prev) => prev.map((e, i) => (i === idx ? { ...e, ...patch } : e)));

  const onSubmit = (status: StandardProcessStatus) => (values: HeaderValues) => {
    save.mutate(
      {
        id: initial?.id,
        name: values.name,
        description: values.description || undefined,
        segmento: values.segmento,
        porte_alvo: splitCsv(values.porte_alvo),
        tags: splitCsv(values.tags),
        etapas,
        expected_outcomes: splitCsv(values.expected_outcomes),
        target_audience: values.target_audience || undefined,
        prerequisites: splitCsv(values.prerequisites),
        status,
      },
      { onSuccess: () => onSaved?.() }
    );
  };

  return (
    <form className="space-y-4">
      <Card className="p-3 space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Identificação</div>
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <Label htmlFor="name" className="text-xs">Nome *</Label>
            <Input id="name" {...register('name')} placeholder="Ex: Sayerlack PU 2K alto padrão moveleiro" />
            {errors.name && <div className="text-2xs text-status-error">{errors.name.message}</div>}
          </div>
          <div className="col-span-2">
            <Label htmlFor="description" className="text-xs">Descrição</Label>
            <Textarea id="description" rows={2} {...register('description')} placeholder="1-2 frases" />
          </div>
          <div>
            <Label htmlFor="segmento" className="text-xs">Segmento *</Label>
            <Input id="segmento" {...register('segmento')} placeholder="moveleiro, automotivo, industrial..." />
          </div>
          <div>
            <Label htmlFor="porte" className="text-xs">Portes alvo (vírgula)</Label>
            <Input id="porte" {...register('porte_alvo')} placeholder="pequeno, medio" />
          </div>
          <div className="col-span-2">
            <Label htmlFor="audience" className="text-xs">Público alvo</Label>
            <Input id="audience" {...register('target_audience')} placeholder="Ex: Marcenarias 50-500 peças/mês" />
          </div>
          <div>
            <Label htmlFor="tags" className="text-xs">Tags (vírgula)</Label>
            <Input id="tags" {...register('tags')} placeholder="pu_2k, cabine_simples" />
          </div>
          <div>
            <Label htmlFor="outcomes" className="text-xs">Resultados esperados (vírgula)</Label>
            <Input id="outcomes" {...register('expected_outcomes')} placeholder="alto brilho, resistência química" />
          </div>
          <div className="col-span-2">
            <Label htmlFor="prereq" className="text-xs">Pré-requisitos (vírgula)</Label>
            <Input id="prereq" {...register('prerequisites')} placeholder="cabine simples, compressor 1HP+" />
          </div>
        </div>
      </Card>

      <Card className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Etapas ({etapas.length})</div>
          <Button type="button" variant="outline" size="sm" onClick={addEtapa} className="gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Adicionar etapa
          </Button>
        </div>

        {etapas.map((e, idx) => (
          <Card key={idx} className="p-2.5 space-y-2 border-dashed">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xs font-mono text-muted-foreground">#{e.ordem}</span>
                <Input
                  className="h-8 text-xs"
                  value={e.nome}
                  onChange={(ev) => updateEtapa(idx, { nome: ev.target.value })}
                  placeholder="Nome da etapa"
                />
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => removeEtapa(idx)} className="h-7 w-7 p-0 text-status-error">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-2xs">Tipo</Label>
                <Select value={e.tipo} onValueChange={(v) => updateEtapa(idx, { tipo: v as StandardProcessEtapa['tipo'] })}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['preparacao', 'aplicacao', 'secagem', 'lixamento', 'mistura', 'inspecao', 'embalagem', 'outro'].map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-2xs">Equipamentos (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.equipamentos)}
                  onChange={(ev) => updateEtapa(idx, { equipamentos: splitCsv(ev.target.value) })}
                  placeholder="pistola HVLP, cabine"
                />
              </div>
              <div>
                <Label className="text-2xs">Produtos descritivos (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.produtos)}
                  onChange={(ev) => updateEtapa(idx, { produtos: splitCsv(ev.target.value) })}
                  placeholder="primer PU, catalisador"
                />
              </div>
              <div>
                <Label className="text-2xs">Códigos KB (vírgula)</Label>
                <Input
                  className="h-8 text-xs"
                  value={joinCsv(e.produtos_kb)}
                  onChange={(ev) => updateEtapa(idx, { produtos_kb: splitCsv(ev.target.value) })}
                  placeholder="FO20.6827.00, FC.6952"
                />
                {specs && specs.length > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Disponíveis: {specs.slice(0, 5).map((s) => s.product_code).join(', ')}{specs.length > 5 ? '…' : ''}
                  </div>
                )}
              </div>
              <div>
                <Label className="text-2xs">Tempo (min)</Label>
                <Input
                  className="h-8 text-xs"
                  type="number"
                  value={e.parametros.tempo_minutos ?? ''}
                  onChange={(ev) => updateEtapa(idx, { parametros: { ...e.parametros, tempo_minutos: ev.target.value ? Number(ev.target.value) : undefined } })}
                />
              </div>
              <div>
                <Label className="text-2xs">Temp (°C)</Label>
                <Input
                  className="h-8 text-xs"
                  type="number"
                  value={e.parametros.temperatura_c ?? ''}
                  onChange={(ev) => updateEtapa(idx, { parametros: { ...e.parametros, temperatura_c: ev.target.value ? Number(ev.target.value) : undefined } })}
                />
              </div>
              <div className="col-span-2">
                <Label className="text-2xs">Rationale (por quê)</Label>
                <Input
                  className="h-8 text-xs"
                  value={e.rationale ?? ''}
                  onChange={(ev) => updateEtapa(idx, { rationale: ev.target.value })}
                  placeholder="Ex: PU 2K resiste melhor a risco em móveis altos"
                />
              </div>
              <div className="col-span-2">
                <Label className="text-2xs">Observações</Label>
                <Textarea
                  className="text-xs"
                  rows={2}
                  value={e.observacoes}
                  onChange={(ev) => updateEtapa(idx, { observacoes: ev.target.value })}
                  placeholder="Notas, alertas, dicas"
                />
              </div>
            </div>
          </Card>
        ))}
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handleSubmit(onSubmit('draft'))} disabled={save.isPending} className="gap-1.5">
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Salvar rascunho
        </Button>
        <Button type="button" size="sm" onClick={handleSubmit(onSubmit('in_review'))} disabled={save.isPending} className="gap-1.5">
          <Send className="w-3.5 h-3.5" />
          Enviar pra revisão
        </Button>
      </div>
    </form>
  );
}
```

Commit: `feat(process): StandardProcess form + row + status badge`

---

## Task 5: Páginas + rotas + menu

3 páginas mínimas:
- `AdminStandardProcesses.tsx` — lista usando `useStandardProcessesList` + filtros simples (status, segmento) + botão "Novo processo padrão"
- `AdminStandardProcessNew.tsx` — só `<StandardProcessForm onSaved={() => navigate('/admin/standard-processes')} />`
- `AdminStandardProcessDetail.tsx` — `useStandardProcess(id)` + se status='in_review' e user é master → botões "Publicar" / "Voltar pra rascunho" / "Arquivar" via `useApproveStandardProcess`. Se created_by === current_user e status=draft → permite editar inline via `<StandardProcessForm initial={data} />`.

Modificar:
- `src/App.tsx`: 3 lazy + 3 rotas
- `src/components/AppShell.tsx`: 1 item de menu "Processos padrão" na seção Gestão (icon `Factory`, sem managerOnly — staff vê)

Commit: `feat(process): AdminStandardProcesses pages + routes + menu`

---

## Task 6: QA + PR

- tsc clean
- tests passing (nenhum teste novo nesta PR — UI puro)
- build passa
- Push + PR contra main

---

## Pré-requisito do operador

1. Rodar a migration SQL no Lovable Cloud
2. ANTHROPIC_API_KEY já configurada
3. Regenerar types Supabase

## Self-Review

**Spec coverage:**
- Biblioteca de processos modelo → Task 1
- Workflow draft/approval → Task 1 (status check) + Task 3 (hook approve) + Task 5 (botões UI)
- Vincula produtos do KB → Task 2 (`produtos_kb` field) + Task 4 (input)
- Staff propõe, master aprova → RLS Task 1 + checks de role em Task 5

**Riscos:**
- Form bem extenso (~12 inputs por etapa). UX MVP. Sem drag-drop reorder de etapas (botões + ordem manual).
- `produtos_kb` é input CSV livre — não valida que o código existe. Mostrar lista de specs como hint. Validação dura fica pra futuro.
- Sem template pré-cadastrado — primeiros processos vão precisar ser criados manual pelo master.

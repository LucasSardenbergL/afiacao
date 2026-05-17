# PR-P1 — Customer Process Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Vendedor pode cadastrar o **processo produtivo do cliente** (matéria-prima, sequência de operações, equipamentos, produtos atuais, problemas) em texto livre. IA estrutura em etapas JSON. Nova aba "Processo" em `/admin/customers/:id`. Foundation pra comparação (P3) + sugestões em tempo real (P4).

**Architecture:**
- Schema: `customer_processes` (1 row corrente por cliente; histórico via `version` + `parent_id`)
- Edge fn `structure-customer-process`: Claude Sonnet 4.6 + tool use → recebe descrição livre, retorna `etapas[]` estruturadas
- Hook `useCustomerProcess(customerId)` + `useSaveCustomerProcess`
- Componente `CustomerProcessTab` — textarea livre + botão "Estruturar com IA" + preview das etapas
- Wire em `AdminCustomers.tsx` (nova tab "Processo")

**Não-objetivos (próximos sub-PRs):**
- Comparação com processos padrão (PR-P3)
- Sugestões em tempo real durante chamada (PR-P4)
- Embedding pra RAG (PR6d/PR-P3)
- Histórico/diff entre versões (UI simples — só substitui current)

---

## Task 1: Migration

**Files:** `supabase/migrations/{timestamp}_customer_processes.sql`

```sql
-- PR-P1: Processo produtivo do cliente
CREATE TABLE IF NOT EXISTS public.customer_processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Texto livre como vendedor descreve
  descricao_livre text NOT NULL,

  -- Estruturado pela IA via Claude tool use
  etapas jsonb,                  -- array de { ordem, nome, tipo, produtos[], parametros, observacoes }
  segmento text,                  -- detectado pela IA: 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', etc
  porte text,                     -- 'pequeno', 'medio', 'grande' (detectado por volumes mencionados)
  tags text[] DEFAULT '{}',       -- ['pu_2k', 'cabine', 'lixamento_manual']

  -- Metadados da estruturação
  ia_confidence numeric,          -- 0-1 (quão confiante a IA está)
  ia_gaps text[],                 -- coisas que faltam pra análise completa
  ia_structured_at timestamptz,

  -- Versionamento simples
  version integer NOT NULL DEFAULT 1,
  parent_id uuid REFERENCES public.customer_processes(id) ON DELETE SET NULL,
  is_current boolean NOT NULL DEFAULT true,  -- só 1 current por customer

  -- Auditoria
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Index garantindo 1 current por cliente
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_processes_one_current
  ON public.customer_processes (customer_user_id)
  WHERE is_current = true;

CREATE INDEX IF NOT EXISTS idx_customer_processes_customer
  ON public.customer_processes (customer_user_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_customer_processes_segmento
  ON public.customer_processes (segmento, porte)
  WHERE is_current = true;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_customer_processes_updated_at ON public.customer_processes;
CREATE TRIGGER trg_customer_processes_updated_at
  BEFORE UPDATE ON public.customer_processes
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- RLS
ALTER TABLE public.customer_processes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "customer_processes_select_staff" ON public.customer_processes
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_insert_staff" ON public.customer_processes
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_update_staff" ON public.customer_processes
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

CREATE POLICY "customer_processes_delete_master" ON public.customer_processes
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

COMMENT ON TABLE public.customer_processes IS 'Processo produtivo do cliente — texto livre + estrutura JSON via IA. Foundation pra comparação (PR-P3) + sugestões em tempo real (PR-P4).';
```

---

## Task 2: Types (domain)

**File:** `src/lib/customer-process/types.ts`

```ts
export interface ProcessEtapa {
  ordem: number;
  nome: string;                          // "Aplicação primer", "Secagem final", "Lixamento intermediário"
  tipo: 'preparacao' | 'aplicacao' | 'secagem' | 'lixamento' | 'mistura' | 'inspecao' | 'embalagem' | 'outro';
  produtos: string[];                    // ["nitro Renner", "lixa 220", "diluente comum"]
  parametros: {
    tempo_minutos?: number;
    temperatura_c?: number;
    umidade_pct?: number;
    espessura_um?: number;
    pressao_bar?: number;
    distancia_cm?: number;
  };
  equipamentos: string[];                // ["pistola HVLP", "cabine de pintura", "estufa"]
  observacoes: string;
}

export interface CustomerProcess {
  id: string;
  customer_user_id: string;
  descricao_livre: string;
  etapas: ProcessEtapa[] | null;
  segmento: string | null;
  porte: 'pequeno' | 'medio' | 'grande' | null;
  tags: string[];
  ia_confidence: number | null;
  ia_gaps: string[];
  ia_structured_at: string | null;
  version: number;
  parent_id: string | null;
  is_current: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
}

/** Resposta da edge fn structure-customer-process */
export interface StructuredProcessResponse {
  etapas: ProcessEtapa[];
  segmento: string;
  porte: 'pequeno' | 'medio' | 'grande';
  tags: string[];
  ia_confidence: number;
  ia_gaps: string[];
}
```

---

## Task 3: Edge function `structure-customer-process`

**File:** `supabase/functions/structure-customer-process/index.ts`

Claude Sonnet 4.6 + tool use forçado. System prompt explica o domínio (tintas industriais, processos típicos de cliente moveleiro/auto/industrial). Tool retorna `{etapas, segmento, porte, tags, confidence, gaps}`.

```ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você estrutura processos produtivos de clientes da Colacor (distribuidora Sayerlack) em etapas técnicas precisas.

Cliente típico: marcenarias, indústrias moveleiras, oficinas automotivas. Aplicam tinta, primer, verniz em superfícies de madeira/MDF/metal.

# Tipos de etapas que você reconhece
- **preparacao**: lavagem, desengorduramento, lixamento inicial, mascaramento
- **aplicacao**: aplicação de primer, tinta, verniz, catalisador
- **secagem**: ar livre, estufa, infravermelho
- **lixamento**: intermediário entre demãos
- **mistura**: catálise, diluição, ajuste de viscosidade
- **inspecao**: controle de qualidade, retrabalho
- **embalagem**: empilhamento, embalagem final

# Identifique também
- **segmento**: 'moveleiro', 'automotivo', 'industrial', 'marcenaria_pequena', 'oficina_pintura'
- **porte**: 'pequeno' (< 50 peças/mês), 'medio' (50-500), 'grande' (>500). Use pistas: número de funcionários, volume mensal de tinta (litros), cabines, equipamentos.
- **tags**: palavras-chave técnicas relevantes (ex: "pu_2k", "cabine_pressurizada", "lixamento_manual", "ar_comprimido")

# Para cada etapa estruture
- ordem (1, 2, 3...)
- nome curto e descritivo
- tipo (do enum acima)
- produtos: liste **EXATAMENTE** os produtos que o vendedor descreveu (preserve as marcas: "nitro Renner", "diluente da Farben", "lixa 320 Norton"). Se não souber a marca, deixe genérico ("nitro").
- parametros: extraia tempo/temperatura/umidade/etc se vendedor mencionou. Se não, deixe campo ausente.
- equipamentos: ["pistola gravity", "cabine simples"]
- observacoes: problemas, gargalos, qualidades que o vendedor relatou

# Regras
- **NÃO invente etapas que o vendedor não descreveu.**
- Se a descrição é vaga, retorne menos etapas mas com **gaps preenchidos** apontando o que precisa de mais informação.
- confidence 0.9+ se descrição rica; 0.6-0.8 se média; <0.6 se vaga.
- SEMPRE use a tool structure_process.`;

const STRUCTURE_TOOL = {
  name: "structure_process",
  description: "Estrutura processo produtivo do cliente em etapas técnicas.",
  input_schema: {
    type: "object",
    properties: {
      etapas: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ordem: { type: "integer" },
            nome: { type: "string" },
            tipo: { type: "string", enum: ["preparacao", "aplicacao", "secagem", "lixamento", "mistura", "inspecao", "embalagem", "outro"] },
            produtos: { type: "array", items: { type: "string" } },
            parametros: {
              type: "object",
              properties: {
                tempo_minutos: { type: ["number", "null"] },
                temperatura_c: { type: ["number", "null"] },
                umidade_pct: { type: ["number", "null"] },
                espessura_um: { type: ["number", "null"] },
                pressao_bar: { type: ["number", "null"] },
                distancia_cm: { type: ["number", "null"] },
              },
            },
            equipamentos: { type: "array", items: { type: "string" } },
            observacoes: { type: "string" },
          },
          required: ["ordem", "nome", "tipo", "produtos", "parametros", "equipamentos", "observacoes"],
        },
      },
      segmento: { type: "string" },
      porte: { type: "string", enum: ["pequeno", "medio", "grande"] },
      tags: { type: "array", items: { type: "string" } },
      ia_confidence: { type: "number", minimum: 0, maximum: 1 },
      ia_gaps: { type: "array", items: { type: "string" } },
    },
    required: ["etapas", "segmento", "porte", "tags", "ia_confidence", "ia_gaps"],
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.descricao_livre || typeof body.descricao_livre !== "string") {
    return new Response(JSON.stringify({ error: "descricao_livre required (string)" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [STRUCTURE_TOOL],
      tool_choice: { type: "tool", name: "structure_process" },
      messages: [{
        role: "user",
        content: `Estruture este processo descrito pelo vendedor:\n\n${body.descricao_livre.slice(0, 20000)}\n\nUse a tool structure_process.`,
      }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "No tool_use in response" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      structured: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[structure-customer-process]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

---

## Task 4: Hooks `useCustomerProcess` + `useSaveCustomerProcess` + `useStructureProcess`

**File:** `src/hooks/useCustomerProcess.ts`

```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { CustomerProcess, StructuredProcessResponse } from '@/lib/customer-process/types';

export function useCustomerProcess(customerId: string | null) {
  return useQuery({
    queryKey: ['customer-process', customerId],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async (): Promise<CustomerProcess | null> => {
      if (!customerId) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('customer_processes') as any)
        .select('*')
        .eq('customer_user_id', customerId)
        .eq('is_current', true)
        .maybeSingle();
      if (error) throw error;
      return (data as CustomerProcess) ?? null;
    },
  });
}

interface SaveInput {
  customerId: string;
  descricao_livre: string;
  structured?: StructuredProcessResponse;
  previousId?: string;
}

export function useSaveCustomerProcess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveInput): Promise<CustomerProcess> => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Não autenticado');

      // Se já existe um current, marca como não-current primeiro
      if (input.previousId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase.from('customer_processes') as any)
          .update({ is_current: false })
          .eq('id', input.previousId);
      }

      const payload = {
        customer_user_id: input.customerId,
        descricao_livre: input.descricao_livre,
        etapas: input.structured?.etapas ?? null,
        segmento: input.structured?.segmento ?? null,
        porte: input.structured?.porte ?? null,
        tags: input.structured?.tags ?? [],
        ia_confidence: input.structured?.ia_confidence ?? null,
        ia_gaps: input.structured?.ia_gaps ?? [],
        ia_structured_at: input.structured ? new Date().toISOString() : null,
        is_current: true,
        created_by: user.id,
        parent_id: input.previousId ?? null,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('customer_processes') as any)
        .insert(payload)
        .select()
        .single();

      if (error) throw error;
      return data as CustomerProcess;
    },
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['customer-process', variables.customerId] });
      toast.success('Processo salvo');
    },
    onError: (err) => {
      toast.error('Erro ao salvar processo', { description: err instanceof Error ? err.message : '' });
    },
  });
}

export function useStructureProcess() {
  return useMutation({
    mutationFn: async (descricao_livre: string): Promise<StructuredProcessResponse> => {
      const response = await invokeFunction<{ structured: StructuredProcessResponse }>(
        'structure-customer-process',
        { descricao_livre }
      );
      return response.structured;
    },
    onError: (err) => {
      toast.error('Erro na estruturação', { description: err instanceof Error ? err.message : '' });
    },
  });
}
```

---

## Task 5: Componente `CustomerProcessTab`

**File:** `src/components/customer/CustomerProcessTab.tsx`

Textarea livre + botão "Estruturar com IA" + display das etapas + metadata.

```tsx
import { useState, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { useCustomerProcess, useSaveCustomerProcess, useStructureProcess } from '@/hooks/useCustomerProcess';
import { Sparkles, Save, Loader2, AlertTriangle, Factory, Clock, Wrench } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import type { StructuredProcessResponse, ProcessEtapa } from '@/lib/customer-process/types';

interface Props {
  customerId: string;
}

const ETAPA_TYPE_COLOR: Record<string, string> = {
  preparacao: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  aplicacao: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  secagem: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300',
  lixamento: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  mistura: 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300',
  inspecao: 'bg-pink-100 text-pink-700 dark:bg-pink-950/40 dark:text-pink-300',
  embalagem: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  outro: 'bg-muted text-muted-foreground',
};

export function CustomerProcessTab({ customerId }: Props) {
  const { data: current, isLoading } = useCustomerProcess(customerId);
  const structure = useStructureProcess();
  const save = useSaveCustomerProcess();

  const [descricao, setDescricao] = useState('');
  const [structured, setStructured] = useState<StructuredProcessResponse | null>(null);
  const [editing, setEditing] = useState(false);

  // Carrega dados atuais quando customer muda
  useEffect(() => {
    if (current && !editing) {
      setDescricao(current.descricao_livre);
      if (current.etapas) {
        setStructured({
          etapas: current.etapas as ProcessEtapa[],
          segmento: current.segmento ?? '',
          porte: (current.porte as 'pequeno' | 'medio' | 'grande') ?? 'medio',
          tags: current.tags,
          ia_confidence: current.ia_confidence ?? 0,
          ia_gaps: current.ia_gaps,
        });
      }
    }
  }, [current, editing]);

  const handleStructure = () => {
    if (descricao.length < 30) {
      return;
    }
    structure.mutate(descricao, {
      onSuccess: (data) => setStructured(data),
    });
  };

  const handleSave = () => {
    save.mutate(
      {
        customerId,
        descricao_livre: descricao,
        structured: structured ?? undefined,
        previousId: current?.id,
      },
      {
        onSuccess: () => setEditing(false),
      }
    );
  };

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  const hasContent = current?.descricao_livre || descricao;

  return (
    <div className="space-y-3">
      <Card className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Processo produtivo do cliente</h3>
            <p className="text-2xs text-muted-foreground">
              Descreva como o cliente produz hoje. Quanto mais detalhe, melhor a IA estrutura e compara depois.
            </p>
          </div>
          {hasContent && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Editar</Button>
          )}
        </div>

        {editing || !current?.descricao_livre ? (
          <>
            <Textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              placeholder="Ex: Marcenaria média. Recebem MDF cortado. Aplicam primer PU da Renner em cabine simples com pistola gravity, secagem 4h ao ar, depois lixam 320, aplicam verniz PU 2K e secam 24h. Volume ~150 peças/mês. Problema atual: retrabalho frequente por casca de laranja..."
              rows={6}
              className="text-xs"
            />

            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleStructure}
                disabled={descricao.length < 30 || structure.isPending}
                className="gap-1.5"
              >
                {structure.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                Estruturar com IA
              </Button>

              <Button
                type="button"
                size="sm"
                onClick={handleSave}
                disabled={descricao.length < 10 || save.isPending}
                className="gap-1.5"
              >
                {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Salvar
              </Button>
            </div>

            {structure.isPending && (
              <div className="text-2xs text-muted-foreground italic">Analisando processo…</div>
            )}
          </>
        ) : (
          <div className="text-xs whitespace-pre-wrap text-foreground/80">{current.descricao_livre}</div>
        )}
      </Card>

      {/* Etapas estruturadas */}
      {structured && structured.etapas.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Factory className="w-4 h-4 text-muted-foreground" />
              <h4 className="text-sm font-semibold">Etapas estruturadas</h4>
              <Badge variant="outline" className="text-2xs">{structured.etapas.length} etapas</Badge>
            </div>
            <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Badge variant="outline" className="text-2xs">{structured.segmento}</Badge>
              <Badge variant="outline" className="text-2xs">porte {structured.porte}</Badge>
              <span>{Math.round(structured.ia_confidence * 100)}% conf.</span>
            </div>
          </div>

          {structured.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {structured.tags.map((t) => (
                <Badge key={t} variant="outline" className="text-[10px]">{t}</Badge>
              ))}
            </div>
          )}

          <div className="space-y-2">
            {structured.etapas.map((e) => (
              <div key={e.ordem} className="rounded-md border border-border p-2.5 space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-2xs font-mono text-muted-foreground">#{e.ordem}</span>
                  <span className="text-xs font-medium">{e.nome}</span>
                  <Badge variant="outline" className={`text-[10px] ${ETAPA_TYPE_COLOR[e.tipo] ?? ''}`}>{e.tipo}</Badge>
                </div>

                {e.produtos.length > 0 && (
                  <div className="text-2xs text-muted-foreground">
                    <span className="font-medium">Produtos:</span> {e.produtos.join(' · ')}
                  </div>
                )}

                {(e.parametros.tempo_minutos || e.parametros.temperatura_c || e.parametros.umidade_pct) && (
                  <div className="flex flex-wrap gap-2 text-2xs">
                    {e.parametros.tempo_minutos != null && (
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <Clock className="w-2.5 h-2.5" />
                        {e.parametros.tempo_minutos} min
                      </span>
                    )}
                    {e.parametros.temperatura_c != null && (
                      <span className="text-muted-foreground">{e.parametros.temperatura_c}°C</span>
                    )}
                    {e.parametros.umidade_pct != null && (
                      <span className="text-muted-foreground">{e.parametros.umidade_pct}% UR</span>
                    )}
                  </div>
                )}

                {e.equipamentos.length > 0 && (
                  <div className="flex items-center gap-1 text-2xs text-muted-foreground">
                    <Wrench className="w-2.5 h-2.5" />
                    {e.equipamentos.join(' · ')}
                  </div>
                )}

                {e.observacoes && (
                  <div className="text-2xs text-muted-foreground italic">{e.observacoes}</div>
                )}
              </div>
            ))}
          </div>

          {structured.ia_gaps.length > 0 && (
            <Card className="p-2.5 bg-status-warning-bg border-status-warning">
              <div className="text-2xs text-status-warning font-medium flex items-center gap-1 mb-1">
                <AlertTriangle className="w-3 h-3" />
                Informações faltantes pra análise mais precisa
              </div>
              <ul className="text-2xs text-muted-foreground space-y-0.5 ml-4 list-disc">
                {structured.ia_gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </Card>
          )}
        </Card>
      )}

      {current?.ia_structured_at && (
        <div className="text-2xs text-muted-foreground text-center">
          Estruturado pela IA {formatDistanceToNow(new Date(current.ia_structured_at), { locale: ptBR, addSuffix: true })}
        </div>
      )}
    </div>
  );
}
```

---

## Task 6: Wire em `AdminCustomers` + QA + PR

- Modify `src/pages/AdminCustomers.tsx`: adicionar TabsTrigger "Processo" (icon `Factory`) + TabsContent
- Verificar tsc/test/build
- Push + PR

---

## Pré-requisito do operador

1. Rodar migration SQL no Lovable Cloud
2. ANTHROPIC_API_KEY já configurada (PR #55)
3. Regenerar types Supabase

## Self-Review

**Spec coverage:**
- Texto livre + estruturação IA → Tasks 3, 4, 5
- Foundation pra comparação P3 (segmento + porte detectados) → Task 1 schema
- Foundation pra real-time P4 (tags + etapas indexáveis) → Task 1
- LGPD-friendly (RLS staff only, sem exposição cliente-cliente direta)

**Riscos:**
- Custo Claude: ~$0.02-0.05 por estruturação (textos médios). Aceito.
- `is_current` único via index parcial — concurrent writes podem dar conflict. Mitigação: UPDATE...is_current=false antes do INSERT (já no hook).
- Etapas como jsonb — sem validação SQL. Schema TS é o "contrato". OK pra MVP.

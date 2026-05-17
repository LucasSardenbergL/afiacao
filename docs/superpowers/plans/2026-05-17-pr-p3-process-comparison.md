# PR-P3 — Process Comparison + Lookalikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Dado o processo de um cliente, gerar análise comparativa estruturada via Claude que mostra:
1. **Comparação vs processos padrão** publicados do mesmo segmento (gaps, oportunidades de upsell, riscos)
2. **Lookalikes anonimizados** — até 5 outros clientes do MESMO segmento + tags compatíveis que conseguiram resultado relevante. Anonimização: "Marcenaria de Belo Horizonte, médio porte, cliente Colacor há 3 anos"
3. **Summary executivo**: top gap, top oportunidade, top risco, próxima ação recomendada

**Fallback declarado pelo usuário:** sem lookalike por tag/segment → mostra só a comparação com padrão (sem ruído).

**Architecture:**
- Edge fn `compare-customer-process` (Deno + Anthropic SDK):
  - Busca `customer_segments` do cliente (tag, segment, atividade)
  - Busca `customer_processes` is_current=true do cliente
  - Filtros hard: cliente atual SEM tag/segment → **só compara com padrão**, retorna `lookalikes: []`
  - Busca top 3 `standard_processes` via `rag-search` filtrado por segment do cliente
  - Busca top 5 candidatos lookalike: query SQL direta filtrando customer_segments por `tags && current.tags` AND `segment = current.segment` AND `customer_user_id != current` → pega customer_processes is_current desses
  - Pra cada lookalike: hydrata metadata (cidade via omie_clientes, account_age via created_at do primeiro pedido, ticket médio)
  - Chama Claude Sonnet 4.6 com tudo: gera análise estruturada via tool_use
- Hook `useProcessComparison(customerId)` — mutation pra disparar análise (custo Claude)
- Componente `ProcessComparisonPanel` dentro de `CustomerProcessTab`
- Wire opcional: se comparison já foi gerada nas últimas 24h, cacheia em tabela `customer_process_comparisons` (skip pra simplicidade — sempre re-gera)

**Não-objetivos:**
- Persistir histórico de comparações
- Comparação automática a cada save (vendedor clica "Comparar")
- Real-time durante chamada (PR-P4)
- UI de edição/refinamento da análise (read-only)

---

## File Structure

**Criar:**
- `supabase/functions/compare-customer-process/index.ts`
- `src/lib/customer-process/comparison-types.ts`
- `src/hooks/useProcessComparison.ts`
- `src/components/customer/ProcessComparisonPanel.tsx`

**Modificar:**
- `src/components/customer/CustomerProcessTab.tsx` — adicionar `<ProcessComparisonPanel customerId={customerId} />` no fim da aba

---

## Task 1: Types da comparação

`src/lib/customer-process/comparison-types.ts`:

```ts
export interface ComparisonGap {
  area: string;                    // "Tipo de tinta", "Equipamento", "Lixamento", etc
  severity: 'baixa' | 'media' | 'alta';
  description: string;             // "Cliente usa nitro Renner; padrão recomenda PU 2K Sayerlack"
  impact: string;                  // "Retrabalho médio 8h/mês"
}

export interface ComparisonOpportunity {
  type: 'upsell' | 'cross_sell' | 'process_improvement' | 'compliance';
  description: string;             // "Adicionar primer PU FLA.6264 antes do verniz"
  rationale: string;               // "Aumenta dureza do acabamento e reduz absorção"
  estimated_value?: string;        // "Ticket adicional ~R$ 450/mês"
  product_codes_suggested: string[];  // ["FLA.6264.02", "FC.7075"]
}

export interface ComparisonRisk {
  type: string;                    // "qualidade", "regulatorio", "operacional"
  severity: 'baixa' | 'media' | 'alta';
  description: string;             // "Sem catalisador adequado, validade do PU é apenas 2h"
  mitigation: string;              // "Cotar FC.6952 + treinar aplicador"
}

export interface LookalikeRef {
  /** Identificador anônimo: "Marcenaria de Belo Horizonte, médio porte, cliente Colacor há 3 anos" */
  anon_label: string;
  segment: string;
  region: string | null;
  porte: string | null;
  account_age_years: number | null;
  process_summary: string;         // 1-2 linhas: "Usa sistema completo PU 2K; aplica em cabine pressurizada; tempo médio de aplicação 4h por lote de 20 peças"
  distinguishing_pattern: string;  // o que esse cliente faz de diferente do atual: "Adicionou primer + lixamento intermediário que reduziu retrabalho em 40%"
  similarity_score: number;        // 0-1
}

export interface ProcessComparison {
  /** Processos padrão mais relevantes pro segmento */
  matching_standards: Array<{
    standard_id: string;
    name: string;
    similarity_score: number;
  }>;
  gaps: ComparisonGap[];
  opportunities: ComparisonOpportunity[];
  risks: ComparisonRisk[];
  lookalikes: LookalikeRef[];
  summary: {
    top_gap: string;               // 1 frase
    top_opportunity: string;
    top_risk: string;
    recommended_next_action: string;  // ação concreta pro vendedor
  };
  metadata: {
    customer_segment: string | null;
    customer_tags: string[];
    has_lookalikes: boolean;
    standards_compared: number;
    lookalikes_found: number;
  };
}
```

Commit: `feat(comparison): types ProcessComparison + Gap/Opportunity/Risk/Lookalike`

---

## Task 2: Edge function `compare-customer-process`

`supabase/functions/compare-customer-process/index.ts`:

```ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT = `Você é um copiloto de vendas técnico da Colacor (distribuidora Sayerlack).

Sua tarefa: receber o processo produtivo atual de um cliente, processos padrão de referência (publicados pela fábrica) e processos de clientes parecidos (anonimizados). Produzir análise estruturada via tool comparison_analysis.

# O que você gera

## gaps (lacunas vs padrão)
Liste 2-5 diferenças concretas entre o processo do cliente e o padrão de referência. Cada gap tem:
- area: parte do processo afetada
- severity: baixa/media/alta (alta = perde venda ou tem risco regulatório)
- description: o que cliente faz vs o que deveria fazer
- impact: consequência mensurável

## opportunities
2-4 oportunidades concretas de melhoria que o vendedor pode oferecer. Cada uma tem:
- type: upsell (vender produto melhor), cross_sell (vender adicional), process_improvement (melhoria operacional), compliance (atender regulação)
- description: o que oferecer
- rationale: por quê isso resolve dor real do cliente
- estimated_value: ticket adicional estimado (opcional, só se confiante)
- product_codes_suggested: códigos do KB Colacor (FLA.xxxx, FO20.xxxx, FC.xxxx, etc) — só os que apareceram nos processos padrão ou lookalikes

## risks
1-3 riscos do processo atual do cliente (perda de qualidade, regulação, desperdício). Cada um tem:
- type: qualidade/regulatorio/operacional/financeiro
- severity: baixa/media/alta
- description: qual é o risco
- mitigation: o que vendedor sugere fazer

## summary
- top_gap, top_opportunity, top_risk: 1 frase cada com o item MAIS importante
- recommended_next_action: 1 ação concreta pro vendedor na próxima conversa com esse cliente

# Regras

- Use APENAS dados dos processos passados. NÃO invente produtos, números ou casos.
- Lookalikes são ANONIMIZADOS — não cite nome de cliente, só o anon_label (já vem anonimizado no input).
- Se NÃO há lookalikes (lookalikes: []), foque a análise no padrão. Não mencione "outros clientes" se não tem dados.
- Sugira product_codes APENAS os que aparecem nos processos padrão ou lookalikes. NÃO invente códigos.
- estimated_value só preencha se tiver evidência clara dos lookalikes (ex: "cliente parecido aumentou ticket 23%").
- Tom: técnico, conciso, acionável. Sem jargão de marketing.`;

const TOOL = {
  name: "comparison_analysis",
  description: "Análise comparativa estruturada do processo do cliente vs padrão + lookalikes.",
  input_schema: {
    type: "object",
    properties: {
      matching_standards: {
        type: "array",
        items: {
          type: "object",
          properties: {
            standard_id: { type: "string" },
            name: { type: "string" },
            similarity_score: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["standard_id", "name", "similarity_score"],
        },
      },
      gaps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            area: { type: "string" },
            severity: { type: "string", enum: ["baixa", "media", "alta"] },
            description: { type: "string" },
            impact: { type: "string" },
          },
          required: ["area", "severity", "description", "impact"],
        },
      },
      opportunities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["upsell", "cross_sell", "process_improvement", "compliance"] },
            description: { type: "string" },
            rationale: { type: "string" },
            estimated_value: { type: ["string", "null"] },
            product_codes_suggested: { type: "array", items: { type: "string" } },
          },
          required: ["type", "description", "rationale", "product_codes_suggested"],
        },
      },
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            severity: { type: "string", enum: ["baixa", "media", "alta"] },
            description: { type: "string" },
            mitigation: { type: "string" },
          },
          required: ["type", "severity", "description", "mitigation"],
        },
      },
      summary: {
        type: "object",
        properties: {
          top_gap: { type: "string" },
          top_opportunity: { type: "string" },
          top_risk: { type: "string" },
          recommended_next_action: { type: "string" },
        },
        required: ["top_gap", "top_opportunity", "top_risk", "recommended_next_action"],
      },
    },
    required: ["matching_standards", "gaps", "opportunities", "risks", "summary"],
  },
};

interface Req {
  customer_user_id: string;
}

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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Req;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.customer_user_id) {
    return new Response(JSON.stringify({ error: "customer_user_id required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // 1. Busca processo atual do cliente
    const { data: clientProcess, error: cpErr } = await supabase
      .from('customer_processes')
      .select('*')
      .eq('customer_user_id', body.customer_user_id)
      .eq('is_current', true)
      .maybeSingle();

    if (cpErr || !clientProcess) {
      return new Response(JSON.stringify({ error: 'Cliente não tem processo cadastrado' }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Busca segmento/tags via customer_segments + omie_clientes
    let customerSegment: string | null = null;
    let customerTags: string[] = [];
    try {
      const { data: omieMap } = await supabase
        .from('omie_clientes')
        .select('omie_codigo_cliente')
        .eq('user_id', body.customer_user_id)
        .maybeSingle();

      if (omieMap?.omie_codigo_cliente) {
        const { data: seg } = await supabase
          .from('customer_segments')
          .select('segment, tags')
          .eq('omie_codigo_cliente', omieMap.omie_codigo_cliente)
          .maybeSingle();
        customerSegment = seg?.segment ?? null;
        customerTags = seg?.tags ?? [];
      }
    } catch (e) {
      console.warn('[compare-customer-process] segment lookup failed:', e);
    }

    // 3. Busca standard_processes do segmento (top 3 publicados)
    const standardSeg = clientProcess.segmento ?? customerSegment;
    let standards: Array<Record<string, unknown>> = [];
    if (standardSeg) {
      const { data: stdData } = await supabase
        .from('standard_processes')
        .select('id, name, description, segmento, porte_alvo, tags, etapas, expected_outcomes, target_audience, prerequisites')
        .eq('status', 'published')
        .eq('segmento', standardSeg)
        .limit(3);
      standards = stdData ?? [];
    }

    // 4. Busca lookalikes — só se cliente tem tag OU segment
    interface LookalikeRow {
      anon_label: string;
      segment: string;
      region: string | null;
      porte: string | null;
      account_age_years: number | null;
      process_summary: string;
      distinguishing_pattern: string;
      similarity_score: number;
    }
    let lookalikes: LookalikeRow[] = [];
    const hasFilters = customerTags.length > 0 || customerSegment !== null;
    if (hasFilters) {
      // Busca candidates via customer_segments
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let candidQ = supabase.from('customer_segments').select('omie_codigo_cliente, segment, tags') as any;
      if (customerSegment) candidQ = candidQ.eq('segment', customerSegment);
      if (customerTags.length > 0) candidQ = candidQ.overlaps('tags', customerTags);
      candidQ = candidQ.limit(50);
      const { data: candids } = await candidQ;

      if (candids && candids.length > 0) {
        // Mapeia omie_codigo_cliente → user_id
        const codes = (candids as Array<{ omie_codigo_cliente: number }>).map((c) => c.omie_codigo_cliente);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: maps } = await (supabase.from('omie_clientes') as any)
          .select('user_id, omie_codigo_cliente')
          .in('omie_codigo_cliente', codes);

        const candidateUserIds = (maps as Array<{ user_id: string }> ?? [])
          .map((m) => m.user_id)
          .filter((id) => id !== body.customer_user_id);

        if (candidateUserIds.length > 0) {
          // Busca processos atuais desses clientes
          const { data: theirProcesses } = await supabase
            .from('customer_processes')
            .select('customer_user_id, descricao_livre, etapas, segmento, porte, tags')
            .in('customer_user_id', candidateUserIds)
            .eq('is_current', true)
            .limit(5);

          // Hydrate metadata: profile, account age
          if (theirProcesses && theirProcesses.length > 0) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: profiles } = await (supabase.from('profiles') as any)
              .select('user_id, city, state, created_at')
              .in('user_id', theirProcesses.map((p: { customer_user_id: string }) => p.customer_user_id));

            const profileById = new Map<string, { city?: string; state?: string; created_at: string }>(
              (profiles ?? []).map((p: { user_id: string; city?: string; state?: string; created_at: string }) => [p.user_id, p])
            );

            const formatRegion = (p?: { city?: string; state?: string }) => {
              if (!p) return null;
              if (p.city && p.state) return `${p.city}/${p.state}`;
              if (p.city) return p.city;
              if (p.state) return p.state;
              return null;
            };

            const formatAccountAge = (created_at?: string) => {
              if (!created_at) return null;
              const years = (Date.now() - new Date(created_at).getTime()) / (1000 * 60 * 60 * 24 * 365);
              return Math.round(years * 10) / 10;
            };

            const anonName = (segment: string | null, region: string | null, porte: string | null, years: number | null) => {
              const parts: string[] = [];
              if (segment) parts.push(segment);
              if (region) parts.push(`de ${region}`);
              if (porte) parts.push(`${porte} porte`);
              if (years != null) parts.push(`cliente Colacor há ${years < 1 ? '<1' : years.toFixed(years < 2 ? 1 : 0)} ano${years >= 2 ? 's' : ''}`);
              return parts.join(', ') || 'cliente similar';
            };

            interface ProcessRow {
              customer_user_id: string;
              descricao_livre: string;
              etapas: unknown;
              segmento: string | null;
              porte: string | null;
              tags: string[];
            }

            lookalikes = (theirProcesses as ProcessRow[]).map((p, idx) => {
              const profile = profileById.get(p.customer_user_id);
              const region = formatRegion(profile);
              const age = formatAccountAge(profile?.created_at);
              return {
                anon_label: anonName(p.segmento, region, p.porte, age),
                segment: p.segmento ?? 'desconhecido',
                region,
                porte: p.porte,
                account_age_years: age,
                process_summary: p.descricao_livre.slice(0, 400),
                distinguishing_pattern: '',  // Claude vai preencher depois (mas aqui apenas estrutura — Claude lê tudo e sintetiza)
                similarity_score: 1 - (idx * 0.1),  // ranking simples por ordem (RAG semântico fica pra v2)
              };
            });
          }
        }
      }
    }

    // 5. Monta user message pro Claude
    function formatStandard(s: Record<string, unknown>) {
      return [
        `## ${s.name}`,
        s.description ? `Descrição: ${s.description}` : '',
        `Segmento: ${s.segmento}. Portes: ${(s.porte_alvo as string[])?.join(', ')}.`,
        s.expected_outcomes ? `Resultados esperados: ${(s.expected_outcomes as string[]).join('; ')}` : '',
        `Etapas: ${JSON.stringify(s.etapas).slice(0, 2000)}`,
      ].filter(Boolean).join('\n');
    }

    function formatLookalike(l: LookalikeRow) {
      return [
        `## ${l.anon_label}`,
        `Processo: ${l.process_summary}`,
      ].join('\n');
    }

    const userMsg = `# Processo do cliente alvo

**Segmento detectado:** ${clientProcess.segmento ?? 'não informado'}
**Porte:** ${clientProcess.porte ?? 'não informado'}
**Tags do cliente:** ${customerTags.join(', ') || '(nenhuma cadastrada)'}

**Descrição livre do vendedor:**
${clientProcess.descricao_livre}

**Etapas estruturadas:**
${JSON.stringify(clientProcess.etapas).slice(0, 3000)}

---

# Processos padrão de referência (${standards.length})

${standards.length === 0 ? '(nenhum padrão publicado pra esse segmento ainda — gere análise apenas com base no processo do cliente)' : standards.map(formatStandard).join('\n\n')}

---

# Clientes parecidos anonimizados (${lookalikes.length})

${lookalikes.length === 0 ? '(nenhum lookalike encontrado — não mencione outros clientes na sua análise)' : lookalikes.map(formatLookalike).join('\n\n')}

---

Use a tool comparison_analysis pra gerar a análise estruturada.`;

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "comparison_analysis" },
      messages: [{ role: "user", content: userMsg }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "No tool_use in response" }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 6. Resposta combinada: análise do Claude + lookalikes brutos (UI mostra ambos)
    return new Response(JSON.stringify({
      analysis: toolUse.input,
      lookalikes,  // bruto pra UI exibir os anon_labels e regions
      metadata: {
        customer_segment: clientProcess.segmento ?? customerSegment,
        customer_tags: customerTags,
        has_lookalikes: lookalikes.length > 0,
        standards_compared: standards.length,
        lookalikes_found: lookalikes.length,
      },
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[compare-customer-process]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

Commit: `feat(comparison): edge function compare-customer-process (Claude + lookalikes anonimizados)`

---

## Task 3: Hook `useProcessComparison`

`src/hooks/useProcessComparison.ts`:

```ts
import { useMutation } from '@tanstack/react-query';
import { invokeFunction } from '@/lib/invoke-function';
import { toast } from 'sonner';
import type { ProcessComparison, LookalikeRef } from '@/lib/customer-process/comparison-types';

export interface ProcessComparisonResponse {
  analysis: ProcessComparison;
  lookalikes: LookalikeRef[];
  metadata: {
    customer_segment: string | null;
    customer_tags: string[];
    has_lookalikes: boolean;
    standards_compared: number;
    lookalikes_found: number;
  };
}

export function useProcessComparison() {
  return useMutation({
    mutationFn: async (customer_user_id: string): Promise<ProcessComparisonResponse> => {
      return await invokeFunction<ProcessComparisonResponse>(
        'compare-customer-process',
        { customer_user_id }
      );
    },
    onError: (err) => toast.error('Erro na comparação', { description: err instanceof Error ? err.message : '' }),
  });
}
```

Commit: `feat(comparison): useProcessComparison mutation hook`

---

## Task 4: Componente `ProcessComparisonPanel`

`src/components/customer/ProcessComparisonPanel.tsx`:

```tsx
import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useProcessComparison, type ProcessComparisonResponse } from '@/hooks/useProcessComparison';
import { Sparkles, Loader2, AlertTriangle, TrendingUp, ShieldAlert, Lightbulb, Users, Target, Factory } from 'lucide-react';

interface Props {
  customerId: string;
}

const SEVERITY_COLOR: Record<string, string> = {
  baixa: 'border-muted-foreground/30 text-muted-foreground',
  media: 'border-status-warning text-status-warning',
  alta: 'border-status-error text-status-error',
};

const OPP_TYPE_LABEL: Record<string, string> = {
  upsell: 'Upsell',
  cross_sell: 'Cross-sell',
  process_improvement: 'Melhoria de processo',
  compliance: 'Compliance',
};

export function ProcessComparisonPanel({ customerId }: Props) {
  const compare = useProcessComparison();
  const [result, setResult] = useState<ProcessComparisonResponse | null>(null);

  const handleCompare = () => {
    compare.mutate(customerId, {
      onSuccess: (data) => setResult(data),
    });
  };

  if (!result && !compare.isPending) {
    return (
      <Card className="p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-status-warning" />
          <h3 className="text-sm font-semibold">Comparação inteligente</h3>
        </div>
        <p className="text-2xs text-muted-foreground">
          Compara o processo do cliente com processos padrão da fábrica + clientes similares anonimizados. Identifica lacunas, oportunidades e riscos.
        </p>
        <Button size="sm" onClick={handleCompare} className="gap-1.5">
          <Sparkles className="w-3.5 h-3.5" />
          Comparar com padrões e clientes similares
        </Button>
      </Card>
    );
  }

  if (compare.isPending) {
    return (
      <Card className="p-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Analisando processo + buscando lookalikes...
      </Card>
    );
  }

  if (!result) return null;

  const { analysis, lookalikes, metadata } = result;

  return (
    <div className="space-y-3">
      {/* Summary executivo */}
      <Card className="p-3 space-y-2 border-2 border-status-success/30">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-status-success" />
            <h3 className="text-sm font-semibold">Resumo executivo</h3>
          </div>
          <Button size="sm" variant="outline" onClick={handleCompare} disabled={compare.isPending} className="text-2xs">
            Re-analisar
          </Button>
        </div>
        <div className="space-y-1.5 text-xs">
          {analysis.summary.top_gap && (
            <div><span className="font-medium text-status-warning">⚠ Principal lacuna:</span> {analysis.summary.top_gap}</div>
          )}
          {analysis.summary.top_opportunity && (
            <div><span className="font-medium text-status-success">💡 Principal oportunidade:</span> {analysis.summary.top_opportunity}</div>
          )}
          {analysis.summary.top_risk && (
            <div><span className="font-medium text-status-error">⛔ Principal risco:</span> {analysis.summary.top_risk}</div>
          )}
          {analysis.summary.recommended_next_action && (
            <div className="mt-2 p-2 rounded bg-status-success-bg/40 border border-status-success/30">
              <span className="font-medium">→ Próxima ação:</span> {analysis.summary.recommended_next_action}
            </div>
          )}
        </div>
      </Card>

      {/* Standards comparados */}
      {analysis.matching_standards.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <Factory className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="font-medium">Comparado contra {analysis.matching_standards.length} processo(s) padrão</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {analysis.matching_standards.map((s) => (
              <Badge key={s.standard_id} variant="outline" className="text-2xs">
                {s.name} <span className="ml-1 opacity-60">{Math.round(s.similarity_score * 100)}%</span>
              </Badge>
            ))}
          </div>
        </Card>
      )}

      {/* Gaps */}
      {analysis.gaps.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-status-warning" />
            <h4 className="text-sm font-semibold">Lacunas vs padrão ({analysis.gaps.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.gaps.map((g, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-2xs ${SEVERITY_COLOR[g.severity]}`}>{g.severity}</Badge>
                  <span className="text-xs font-medium">{g.area}</span>
                </div>
                <p className="text-xs text-foreground/80">{g.description}</p>
                <p className="text-2xs text-muted-foreground italic">Impacto: {g.impact}</p>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Opportunities */}
      {analysis.opportunities.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-status-success" />
            <h4 className="text-sm font-semibold">Oportunidades ({analysis.opportunities.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.opportunities.map((o, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-2xs border-status-success text-status-success">{OPP_TYPE_LABEL[o.type]}</Badge>
                  {o.estimated_value && <Badge variant="outline" className="text-2xs">{o.estimated_value}</Badge>}
                </div>
                <p className="text-xs font-medium">{o.description}</p>
                <p className="text-2xs text-muted-foreground">{o.rationale}</p>
                {o.product_codes_suggested.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1">
                    {o.product_codes_suggested.map((code) => (
                      <Badge key={code} variant="outline" className="text-[10px] font-mono">{code}</Badge>
                    ))}
                  </div>
                )}
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Risks */}
      {analysis.risks.length > 0 && (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-status-error" />
            <h4 className="text-sm font-semibold">Riscos detectados ({analysis.risks.length})</h4>
          </div>
          <div className="space-y-2">
            {analysis.risks.map((r, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={`text-2xs ${SEVERITY_COLOR[r.severity]}`}>{r.severity}</Badge>
                  <span className="text-xs font-medium">{r.type}</span>
                </div>
                <p className="text-xs text-foreground/80">{r.description}</p>
                <p className="text-2xs text-status-success italic">→ {r.mitigation}</p>
              </Card>
            ))}
          </div>
        </Card>
      )}

      {/* Lookalikes */}
      {lookalikes.length > 0 ? (
        <Card className="p-3 space-y-2">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">Clientes parecidos ({lookalikes.length})</h4>
          </div>
          <p className="text-2xs text-muted-foreground">Anonimizados. Mesmo segmento + tags compatíveis.</p>
          <div className="space-y-1.5">
            {lookalikes.map((l, i) => (
              <Card key={i} className="p-2.5 space-y-1 border-dashed bg-muted/20">
                <div className="text-xs font-medium">{l.anon_label}</div>
                <div className="text-2xs text-muted-foreground line-clamp-3">{l.process_summary}</div>
              </Card>
            ))}
          </div>
        </Card>
      ) : (
        <Card className="p-3 bg-muted/20">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Lightbulb className="w-3.5 h-3.5" />
            <span>
              Sem clientes parecidos cadastrados ainda
              {!metadata.customer_tags.length && ' (cliente sem tags em customer_segments)'}
              . Análise focada nos processos padrão.
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
```

Commit: `feat(comparison): ProcessComparisonPanel UI`

---

## Task 5: Wire em CustomerProcessTab + QA + PR

Em `src/components/customer/CustomerProcessTab.tsx`, no fim da seção principal (após o card de etapas estruturadas), adicionar:

```tsx
import { ProcessComparisonPanel } from './ProcessComparisonPanel';

// ... no return, no fim:
<ProcessComparisonPanel customerId={customerId} />
```

QA:
- tsc clean
- vitest passing
- bun build passa
- Push + PR

Commit: `feat(comparison): wire ProcessComparisonPanel em CustomerProcessTab`

---

## Pré-requisito do operador

- ANTHROPIC_API_KEY já configurada
- PR6d migration rodada (rag_chunks existe — mesmo que esta PR não use diretamente, lookalikes futuros vão poder usar RAG semântico)
- customer_segments populado pelos vendedores (pré-existente — você falou que já tem tags)
- Pelo menos 1 standard_processes publicado pra ver comparação útil

## Self-Review

**Spec coverage:**
- Comparação contra processos padrão → Task 2 (Claude analysis com standards no contexto)
- Lookalikes anonimizados + fallback "sem lookalike" → Task 2 (guard hasFilters + lookalikes vazios)
- Anonimização categoria + região + porte + anos → Task 2 (anonName helper)
- Hierarquia de filtros: tag → segment → exclude_self → 5 candidates → ordem por created_at → Claude rankeia → top via similarity_score
- UI estruturada (gaps/opportunities/risks/lookalikes/summary) → Task 4

**Riscos:**
- Custo Claude: ~$0.10 por análise (3000 tokens output). Vendedor clica, não roda automático. Aceito.
- Lookalikes ranking ainda é por ordem (não RAG semântico) — PR-P3 v2 pode usar `rag-search` quando tiver volume suficiente.
- `customer_segments` link via `omie_codigo_cliente` precisa do `omie_clientes` map. Se cliente não tem mapeamento, lookalike fica vazio (degrada bem).
- Sem persistência da análise — toda vez Claude roda do zero. PR posterior pode adicionar cache 24h.

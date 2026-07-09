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

interface ProcessRow {
  customer_user_id: string;
  descricao_livre: string;
  etapas: unknown;
  segmento: string | null;
  porte: string | null;
  tags: string[];
}

interface ProfileLite {
  user_id: string;
  city?: string | null;
  state?: string | null;
  created_at: string;
}

function formatRegion(p?: ProfileLite | null): string | null {
  if (!p) return null;
  if (p.city && p.state) return `${p.city}/${p.state}`;
  if (p.city) return p.city;
  if (p.state) return p.state;
  return null;
}

function formatAccountAge(created_at?: string): number | null {
  if (!created_at) return null;
  const years = (Date.now() - new Date(created_at).getTime()) / (1000 * 60 * 60 * 24 * 365);
  return Math.round(years * 10) / 10;
}

function anonName(segment: string | null, region: string | null, porte: string | null, years: number | null): string {
  const parts: string[] = [];
  if (segment) parts.push(segment);
  if (region) parts.push(`de ${region}`);
  if (porte) parts.push(`${porte} porte`);
  if (years != null) {
    parts.push(`cliente Colacor há ${years < 1 ? '<1' : years.toFixed(years < 2 ? 1 : 0)} ano${years >= 2 ? 's' : ''}`);
  }
  return parts.join(', ') || 'cliente similar';
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

    // 2. Segmento/tags via customer_segments + omie_customer_account_map (cliente atual)
    let customerSegment: string | null = null;
    let customerTags: string[] = [];
    try {
      // Fatia 3 do fix de rótulo: casa via a proof-table omie_customer_account_map (account-correta,
      // populada document-first), não mais o espelho omie_clientes poluído. customer_segments é gravado
      // na conta 'oben' (salvar_segmento_cliente, account default 'oben') → o código que CASA é o da
      // conta 'oben' no mapa. Fail-safe: sem linha 'oben' no mapa (sync não populou) → omieMap null →
      // sem segmento (degradação honesta, precisão>recall — melhor que colisão trazer segmento de OUTRO).
      const { data: omieMap } = await supabase
        .from('omie_customer_account_map')
        .select('omie_codigo_cliente')
        .eq('user_id', body.customer_user_id)
        .eq('account', 'oben')
        .maybeSingle();

      if (omieMap && (omieMap as { omie_codigo_cliente: number }).omie_codigo_cliente) {
        const { data: seg } = await supabase
          .from('customer_segments')
          .select('segment, tags')
          .eq('omie_codigo_cliente', (omieMap as { omie_codigo_cliente: number }).omie_codigo_cliente)
          .eq('account', 'oben') // Codex P2: customer_segments é conta 'oben'; escopo à prova de futuro
          .maybeSingle();
        customerSegment = (seg as { segment: string | null } | null)?.segment ?? null;
        customerTags = (seg as { tags: string[] | null } | null)?.tags ?? [];
      }
    } catch (e) {
      console.warn('[compare-customer-process] segment lookup failed:', e);
    }

    // 3. Standards publicados do segmento (top 3)
    const standardSeg = (clientProcess as { segmento: string | null }).segmento ?? customerSegment;
    let standards: Array<Record<string, unknown>> = [];
    if (standardSeg) {
      const { data: stdData } = await supabase
        .from('standard_processes')
        .select('id, name, description, segmento, porte_alvo, tags, etapas, expected_outcomes, target_audience, prerequisites')
        .eq('status', 'published')
        .eq('segmento', standardSeg)
        .limit(3);
      standards = (stdData as Array<Record<string, unknown>>) ?? [];
    }

    // 4. Lookalikes — só se cliente tem tag OU segment
    let lookalikes: LookalikeRow[] = [];
    const hasFilters = customerTags.length > 0 || customerSegment !== null;
    if (hasFilters) {
      // Codex P2: escopo à conta 'oben' (customer_segments é gravado na conta oben) — à prova de futuro
      // se surgirem segments colacor (senão o casamento traria linha de outra conta).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let candidQ = supabase.from('customer_segments').select('omie_codigo_cliente, segment, tags').eq('account', 'oben') as any;
      if (customerSegment) candidQ = candidQ.eq('segment', customerSegment);
      if (customerTags.length > 0) candidQ = candidQ.overlaps('tags', customerTags);
      candidQ = candidQ.limit(50);
      const { data: candids } = await candidQ;

      if (candids && (candids as Array<unknown>).length > 0) {
        const codes = (candids as Array<{ omie_codigo_cliente: number }>).map((c) => c.omie_codigo_cliente);
        // Fatia 3 do fix de rótulo: `codes` vêm de customer_segments (conta 'oben'); resolvê-los de
        // volta para user_id usa a conta 'oben' do mapa (mesmo namespace), via a proof-table
        // account-correta. Fail-safe: mapa 'oben' vazio → sem lookalikes (honesto), casa certo quando
        // o sync popular. (Antes lia o espelho omie_clientes, que colidia namespaces.)
        const { data: maps } = await supabase
          .from('omie_customer_account_map')
          .select('user_id, omie_codigo_cliente')
          .eq('account', 'oben')
          .in('omie_codigo_cliente', codes);

        const candidateUserIds = ((maps as Array<{ user_id: string }> | null) ?? [])
          .map((m) => m.user_id)
          .filter((id) => id !== body.customer_user_id);

        if (candidateUserIds.length > 0) {
          const { data: theirProcesses } = await supabase
            .from('customer_processes')
            .select('customer_user_id, descricao_livre, etapas, segmento, porte, tags')
            .in('customer_user_id', candidateUserIds)
            .eq('is_current', true)
            .limit(5);

          if (theirProcesses && (theirProcesses as Array<unknown>).length > 0) {
            const userIds = (theirProcesses as ProcessRow[]).map((p) => p.customer_user_id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const { data: profiles } = await (supabase.from('profiles') as any)
              .select('user_id, city, state, created_at')
              .in('user_id', userIds);

            const profileById = new Map<string, ProfileLite>(
              ((profiles as ProfileLite[]) ?? []).map((p) => [p.user_id, p])
            );

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
                distinguishing_pattern: '',
                similarity_score: Math.max(0.1, 1 - idx * 0.1),
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
      return `## ${l.anon_label}\nProcesso: ${l.process_summary}`;
    }

    const cp = clientProcess as { segmento: string | null; porte: string | null; descricao_livre: string; etapas: unknown };

    const userMsg = `# Processo do cliente alvo

**Segmento detectado:** ${cp.segmento ?? 'não informado'}
**Porte:** ${cp.porte ?? 'não informado'}
**Tags do cliente:** ${customerTags.join(', ') || '(nenhuma cadastrada)'}

**Descrição livre do vendedor:**
${cp.descricao_livre}

**Etapas estruturadas:**
${JSON.stringify(cp.etapas).slice(0, 3000)}

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

    return new Response(JSON.stringify({
      analysis: toolUse.input,
      lookalikes,
      metadata: {
        customer_segment: cp.segmento ?? customerSegment,
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

# PR3 — Análise SPIN com Claude Sonnet 4.6 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar transcrição ao vivo (PR2) em sugestões SPIN acionáveis pelo vendedor durante a chamada. Claude Sonnet 4.6 analisa o transcript a cada turno final do cliente, retorna estágio SPIN + próxima pergunta exata + riscos. Painel do dialer mostra a sugestão em destaque.

**Architecture:** Edge Function `claude-spin-analyze` recebe array de turnos + ID da chamada, monta prompt com sistema cacheado (framework SPIN + contexto Sayerlack/Colacor) e mensagem incremental com transcript, chama Anthropic Messages API (Claude Sonnet 4.6, max 1500 output tokens, response_format JSON via tool calling pra forçar shape). Edge retorna `SpinAnalysis` tipado. Hook `useSpinAnalysis` na frontend dispara análise debounced 3s após último turno final do cliente, expõe `currentAnalysis` reativo. `WebRTCCallContext` injeta state. `SpinSuggestionCard` é seção sticky no rodapé do `TranscriptionPanel` mostrando estágio, pergunta sugerida e riscos.

**Tech Stack:** Anthropic Messages API (`@anthropic-ai/sdk` no Deno) · Claude Sonnet 4.6 · prompt caching (system breakpoint) · tool-use pra structured output · React 18 hooks · TypeScript estrito · Vitest 3.2 · shadcn/ui.

**Não-objetivos (ficam pra PRs seguintes):**
- Streaming de resposta do Claude (PR3.5 ou PR5 se necessário pra UX)
- Triggers inteligentes baseados em silêncio + palavras-âncora (PR5)
- Cross-sell de produtos específicos (PR4 — vai consumir `crossSellTriggers` daqui)
- Persistência das análises em `farmer_copilot_sessions` (PR6)
- Histórico de análises (apenas current na UI por enquanto)
- Substituir o `FarmerCopilot.tsx` legado (deprecation fica pós-PR8)

---

## File Structure

**Criar:**
- `supabase/functions/claude-spin-analyze/index.ts` — Edge Function: recebe transcript, chama Claude, retorna SpinAnalysis
- `src/lib/spin/types.ts` — TranscriptTurnLite, SpinAnalysis, SpinStage, etc.
- `src/lib/spin/spin-prompts.ts` — SYSTEM_PROMPT_SPIN constante (instrução cacheada) + USER_PROMPT_BUILDER helper
- `src/lib/spin/spin-prompts.test.ts` — testes do builder
- `src/hooks/useSpinAnalysis.ts` — hook que debounce + chama edge function quando há turno cliente final
- `src/hooks/__tests__/useSpinAnalysis.test.tsx` — testes do hook
- `src/components/call/SpinSuggestionCard.tsx` — UI sticky no rodapé do TranscriptionPanel

**Modificar:**
- `src/contexts/WebRTCCallContext.tsx` — chamar `useSpinAnalysis`, expor `spinAnalysis: SpinAnalysis | null` e `spinAnalysisStatus`
- `src/contexts/__tests__/WebRTCCallContext.test.tsx` — mock `useSpinAnalysis`, teste novo campo
- `src/components/call/TranscriptionPanel.tsx` — renderizar `SpinSuggestionCard` no rodapé quando analysis presente; ajustar header pra mostrar status do copilot

**Não modificar:**
- `src/pages/FarmerCopilot.tsx` (legacy Scribe — fica)
- `supabase/functions/copilot-analyze/index.ts` (legacy Gemini — fica até deprecation)
- `src/lib/transcription/*` (PR2 estável)

---

## Pré-requisito do operador

Antes de mergear este PR e rodar em produção, configurar UMA secret no Lovable Cloud:

- `ANTHROPIC_API_KEY` — obter em https://console.anthropic.com → Settings → API Keys → Create Key

Custo esperado (Claude Sonnet 4.6 com cache):
- Por análise: ~$0.005 (cache hit) a $0.02 (cache miss)
- Por chamada de 10min com ~20 análises: ~$0.15
- 1000 chamadas/mês: ~$150/mês

Sem a secret, edge function retorna 500, hook entra em status `error`, transcrição continua funcionando (sem SPIN). Graceful degradation.

---

## Task 1: Tipos compartilhados do SPIN

**Files:** Create `src/lib/spin/types.ts`

- [ ] **Step 1: Criar arquivo de tipos**

```ts
// src/lib/spin/types.ts

/** Versão lite do TranscriptTurn pro payload da edge — sem refs internas */
export interface TranscriptTurnLite {
  speaker: 'vendedor' | 'cliente';
  text: string;
  isFinal: boolean;
  startedAt: number;
}

export type SpinStage = 'opening' | 'situation' | 'problem' | 'implication' | 'need_payoff' | 'closing';

export type NextActionType = 'question' | 'response' | 'transition' | 'close' | 'listen';

export type RiskType = 'price_objection' | 'competitor_mentioned' | 'lack_of_urgency' | 'wrong_decision_maker' | 'technical_doubt' | 'other';

export type RiskSeverity = 'low' | 'medium' | 'high';

export interface SpinAnalysis {
  /** Estágio atual da conversa segundo SPIN */
  spinStage: SpinStage;
  /** Confiança da análise (0-1) */
  confidence: number;
  /** O que o cliente revelou até agora */
  whatClientRevealed: {
    situationFacts: string[];
    problemsAdmitted: string[];
    implications: string[];
    desiredOutcomes: string[];
  };
  /** Próxima ação sugerida pro vendedor (a estrela do show) */
  nextBestAction: {
    type: NextActionType;
    /** Que tipo de pergunta SPIN seria essa (null se type=close/listen) */
    spinType: SpinStage | null;
    /** Texto EXATO pro vendedor falar (PT-BR, tom natural) */
    exactPhrasing: string;
    /** Por que essa ação agora — uma frase curta */
    whyNow: string;
  };
  /** Riscos detectados na conversa */
  risks: Array<{
    type: RiskType;
    severity: RiskSeverity;
    note: string;
  }>;
  /** Hints de cross-sell pra PR4 consumir; pode ser array vazio */
  crossSellTriggers: Array<{
    productHint: string;
    triggerPhrase: string;
  }>;
}

export type SpinAnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error';
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/spin/types.ts
git commit -m "feat(spin): shared types for SPIN analysis"
```

---

## Task 2: Prompts SPIN + builder de mensagens (TDD)

**Files:**
- Create: `src/lib/spin/spin-prompts.ts`
- Create: `src/lib/spin/spin-prompts.test.ts`

- [ ] **Step 1: Escrever testes**

```ts
// src/lib/spin/spin-prompts.test.ts
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT_SPIN, buildUserMessage } from './spin-prompts';
import type { TranscriptTurnLite } from './types';

describe('SYSTEM_PROMPT_SPIN', () => {
  it('contém menção explícita ao framework SPIN', () => {
    expect(SYSTEM_PROMPT_SPIN).toContain('SPIN');
    expect(SYSTEM_PROMPT_SPIN).toContain('Situation');
    expect(SYSTEM_PROMPT_SPIN).toContain('Problem');
    expect(SYSTEM_PROMPT_SPIN).toContain('Implication');
    expect(SYSTEM_PROMPT_SPIN).toContain('Need-payoff');
  });

  it('menciona contexto Sayerlack/Colacor (PT-BR, indústria de tintas)', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('sayerlack');
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toContain('tinta');
  });

  it('define que resposta deve ser em PT-BR natural', () => {
    expect(SYSTEM_PROMPT_SPIN.toLowerCase()).toMatch(/português|pt-br|pt_br/);
  });
});

describe('buildUserMessage', () => {
  it('formata turnos com [VENDEDOR]/[CLIENTE] e timestamps relativos', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'vendedor', text: 'olá, sou Lucas', isFinal: true, startedAt: 1000 },
      { speaker: 'cliente', text: 'oi, tudo bem?', isFinal: true, startedAt: 2500 },
    ];

    const msg = buildUserMessage(turns);

    expect(msg).toContain('[VENDEDOR]');
    expect(msg).toContain('[CLIENTE]');
    expect(msg).toContain('olá, sou Lucas');
    expect(msg).toContain('oi, tudo bem?');
  });

  it('inclui turnos interim com marca [interim] pra Claude saber que pode mudar', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'cliente', text: 'eu preciso de', isFinal: false, startedAt: 5000 },
    ];

    const msg = buildUserMessage(turns);

    expect(msg).toContain('[interim]');
    expect(msg).toContain('eu preciso de');
  });

  it('lista vazia retorna mensagem com placeholder claro', () => {
    const msg = buildUserMessage([]);
    expect(msg).toMatch(/nenhum turno|sem conversa|aguardando/i);
  });

  it('inclui instrução explícita pra Claude usar a tool spin_analysis', () => {
    const turns: TranscriptTurnLite[] = [
      { speaker: 'cliente', text: 'oi', isFinal: true, startedAt: 0 },
    ];
    const msg = buildUserMessage(turns);
    expect(msg.toLowerCase()).toContain('spin_analysis');
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `bun run vitest run src/lib/spin/spin-prompts.test.ts`
Expected: FAIL (`Cannot find module './spin-prompts'`).

- [ ] **Step 3: Implementar**

```ts
// src/lib/spin/spin-prompts.ts
import type { TranscriptTurnLite } from './types';

/**
 * System prompt cacheado pela Anthropic prompt caching API.
 * Mudanças aqui INVALIDAM o cache — só editar quando realmente necessário.
 *
 * Estrutura: persona (curto) → framework SPIN explicado (denso) → contexto
 * Colacor/Sayerlack (específico) → regras de saída (estritas).
 */
export const SYSTEM_PROMPT_SPIN = `Você é um copiloto de vendas SPIN ao vivo para vendedores da Colacor — distribuidora de tintas industriais Sayerlack para o segmento moveleiro brasileiro.

Sua missão: durante uma chamada telefônica entre vendedor e cliente, analisar o transcript em tempo real e sugerir EXATAMENTE qual a próxima pergunta SPIN ideal pro vendedor fazer, baseado no estágio da conversa.

## Framework SPIN (Neil Rackham)

Toda venda consultiva passa por 4 tipos de pergunta, nesta ordem ideal:

1. **Situation** — perguntas factuais que mapeiam o contexto do cliente.
   Ex: "Qual o volume mensal de tinta que vocês usam hoje?", "Quantos operadores na cabine?"
   Use no INÍCIO da chamada. Não abuse — clientes se cansam de perguntas factuais.

2. **Problem** — perguntas que revelam dificuldades, insatisfações, gaps.
   Ex: "Vocês têm tido problema de acabamento no PU?", "A entrega da concorrência costuma atrasar?"
   Use quando você já mapeou a situação e quer expor dores.

3. **Implication** — perguntas que amplificam o impacto dos problemas que o cliente admitiu.
   Ex: "Esses atrasos têm gerado retrabalho na sua linha?", "Quanto isso custa por mês em horas perdidas?"
   USE MUITO. É o estágio que constrói a urgência. SPIN ganha aqui.

4. **Need-payoff** — perguntas que fazem o cliente articular o VALOR de resolver o problema.
   Ex: "Se a entrega fosse 100% no prazo, o que isso destravaria pra produção de vocês?"
   Use quando o cliente já admitiu problemas + implicações. Prepara o close.

## Contexto Sayerlack/Colacor

- Produto: tintas PU automotivas + linhas Hydropoxi (água), Wood (madeira), Auto (auto).
- Cliente típico: indústria moveleira, marcenaria de médio porte, oficina automotiva.
- Concorrentes: Renner, Pantone, Brasilac, importados.
- Diferenciais Colacor: distribuição rápida, suporte técnico, fórmulas customizadas.
- Atritos comuns: prazo de entrega, validade de lote, qualidade de acabamento, preço vs importado.

## Sua tarefa

A cada chamada da minha tool \`spin_analysis\`, você recebe o transcript bidirecional (vendedor + cliente) acumulado até agora. Você deve:

1. Identificar o **estágio atual** da conversa (opening / situation / problem / implication / need-payoff / closing).
2. Mapear o que o cliente JÁ REVELOU (fatos, problemas admitidos, implicações, desejos).
3. Sugerir a **próxima ação ideal** pro vendedor — geralmente uma pergunta SPIN com texto EXATO pra falar em PT-BR natural mineiro/brasileiro neutro.
4. Sinalizar riscos detectados (objeção de preço, menção a concorrente, falta de urgência, etc).
5. Identificar hints de cross-sell (cliente mencionou produto adjacente).

## Regras de saída

- **SEMPRE use a tool \`spin_analysis\`** com o JSON estruturado completo.
- **Texto da sugestão deve ser EXATO** — vendedor vai LER literalmente. PT-BR natural, sem jargão de SPIN ("isso é uma pergunta de Implication" — NUNCA fale isso pro vendedor; fale só pra ferramenta).
- **Seja específico ao contexto do cliente** — não use perguntas genéricas, use as palavras que o cliente acabou de usar.
- **Se o cliente ainda não falou nada relevante** (só opening trivial), retorne uma pergunta de Situation pra começar a mapear.
- **NÃO invente fatos** — só liste em \`whatClientRevealed\` o que efetivamente apareceu no transcript.
- **Confiança baixa (<0.6)** se transcript curto/ambíguo; alta (>0.8) se evidência clara.`;

/**
 * Constrói o user message com o transcript formatado.
 * Esta mensagem NÃO é cacheada (muda toda análise) — fica fora dos breakpoints.
 */
export function buildUserMessage(turns: TranscriptTurnLite[]): string {
  if (turns.length === 0) {
    return 'Transcript ainda vazio — aguardando conversa começar. Sem turnos para analisar.\n\nAinda assim, retorne uma análise inicial via spin_analysis com sugestão de pergunta de abertura típica de Situation.';
  }

  const formatted = turns
    .map((t) => {
      const speaker = t.speaker === 'vendedor' ? '[VENDEDOR]' : '[CLIENTE]';
      const interim = t.isFinal ? '' : ' [interim]';
      return `${speaker}${interim}: ${t.text}`;
    })
    .join('\n');

  return `Transcript acumulado da chamada até agora:\n\n${formatted}\n\nAnalise e chame a tool spin_analysis com o JSON estruturado completo.`;
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun run vitest run src/lib/spin/spin-prompts.test.ts`
Expected: PASS 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/spin/spin-prompts.ts src/lib/spin/spin-prompts.test.ts
git commit -m "feat(spin): SYSTEM_PROMPT_SPIN + buildUserMessage with SPIN framework"
```

---

## Task 3: Edge Function `claude-spin-analyze`

**Files:** Create `supabase/functions/claude-spin-analyze/index.ts`

> **NOTA pro implementador:** este edge usa Anthropic SDK direto (não Lovable gateway) pra ter acesso a prompt caching e tool use. Use o pacote `npm:@anthropic-ai/sdk@^0.30.0` no import Deno.

- [ ] **Step 1: Criar a Edge Function**

```ts
// supabase/functions/claude-spin-analyze/index.ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.30.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

// System prompt INLINE (copiado de src/lib/spin/spin-prompts.ts pra evitar
// dependência cross-package; manter sincronizado quando atualizar).
const SYSTEM_PROMPT_SPIN = `Você é um copiloto de vendas SPIN ao vivo para vendedores da Colacor — distribuidora de tintas industriais Sayerlack para o segmento moveleiro brasileiro.

Sua missão: durante uma chamada telefônica entre vendedor e cliente, analisar o transcript em tempo real e sugerir EXATAMENTE qual a próxima pergunta SPIN ideal pro vendedor fazer, baseado no estágio da conversa.

## Framework SPIN (Neil Rackham)

Toda venda consultiva passa por 4 tipos de pergunta, nesta ordem ideal:

1. **Situation** — perguntas factuais que mapeiam o contexto do cliente.
   Ex: "Qual o volume mensal de tinta que vocês usam hoje?", "Quantos operadores na cabine?"
   Use no INÍCIO da chamada. Não abuse — clientes se cansam de perguntas factuais.

2. **Problem** — perguntas que revelam dificuldades, insatisfações, gaps.
   Ex: "Vocês têm tido problema de acabamento no PU?", "A entrega da concorrência costuma atrasar?"
   Use quando você já mapeou a situação e quer expor dores.

3. **Implication** — perguntas que amplificam o impacto dos problemas que o cliente admitiu.
   Ex: "Esses atrasos têm gerado retrabalho na sua linha?", "Quanto isso custa por mês em horas perdidas?"
   USE MUITO. É o estágio que constrói a urgência. SPIN ganha aqui.

4. **Need-payoff** — perguntas que fazem o cliente articular o VALOR de resolver o problema.
   Ex: "Se a entrega fosse 100% no prazo, o que isso destravaria pra produção de vocês?"
   Use quando o cliente já admitiu problemas + implicações. Prepara o close.

## Contexto Sayerlack/Colacor

- Produto: tintas PU automotivas + linhas Hydropoxi (água), Wood (madeira), Auto (auto).
- Cliente típico: indústria moveleira, marcenaria de médio porte, oficina automotiva.
- Concorrentes: Renner, Pantone, Brasilac, importados.
- Diferenciais Colacor: distribuição rápida, suporte técnico, fórmulas customizadas.
- Atritos comuns: prazo de entrega, validade de lote, qualidade de acabamento, preço vs importado.

## Sua tarefa

A cada chamada da minha tool \`spin_analysis\`, você recebe o transcript bidirecional (vendedor + cliente) acumulado até agora. Você deve:

1. Identificar o **estágio atual** da conversa (opening / situation / problem / implication / need-payoff / closing).
2. Mapear o que o cliente JÁ REVELOU (fatos, problemas admitidos, implicações, desejos).
3. Sugerir a **próxima ação ideal** pro vendedor — geralmente uma pergunta SPIN com texto EXATO pra falar em PT-BR natural mineiro/brasileiro neutro.
4. Sinalizar riscos detectados (objeção de preço, menção a concorrente, falta de urgência, etc).
5. Identificar hints de cross-sell (cliente mencionou produto adjacente).

## Regras de saída

- **SEMPRE use a tool \`spin_analysis\`** com o JSON estruturado completo.
- **Texto da sugestão deve ser EXATO** — vendedor vai LER literalmente. PT-BR natural, sem jargão de SPIN ("isso é uma pergunta de Implication" — NUNCA fale isso pro vendedor; fale só pra ferramenta).
- **Seja específico ao contexto do cliente** — não use perguntas genéricas, use as palavras que o cliente acabou de usar.
- **Se o cliente ainda não falou nada relevante** (só opening trivial), retorne uma pergunta de Situation pra começar a mapear.
- **NÃO invente fatos** — só liste em \`whatClientRevealed\` o que efetivamente apareceu no transcript.
- **Confiança baixa (<0.6)** se transcript curto/ambíguo; alta (>0.8) se evidência clara.`;

// JSON Schema da tool spin_analysis — força Claude a retornar shape exato
const SPIN_ANALYSIS_TOOL = {
  name: "spin_analysis",
  description: "Retorna a análise SPIN estruturada da conversa atual.",
  input_schema: {
    type: "object",
    properties: {
      spinStage: {
        type: "string",
        enum: ["opening", "situation", "problem", "implication", "need_payoff", "closing"],
        description: "Estágio atual da conversa segundo SPIN",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
        description: "Confiança da análise (0-1)",
      },
      whatClientRevealed: {
        type: "object",
        properties: {
          situationFacts: { type: "array", items: { type: "string" } },
          problemsAdmitted: { type: "array", items: { type: "string" } },
          implications: { type: "array", items: { type: "string" } },
          desiredOutcomes: { type: "array", items: { type: "string" } },
        },
        required: ["situationFacts", "problemsAdmitted", "implications", "desiredOutcomes"],
      },
      nextBestAction: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["question", "response", "transition", "close", "listen"],
          },
          spinType: {
            type: ["string", "null"],
            enum: ["opening", "situation", "problem", "implication", "need_payoff", "closing", null],
          },
          exactPhrasing: { type: "string", description: "Texto EXATO pro vendedor falar (PT-BR)" },
          whyNow: { type: "string", description: "Rationale curto (max 1 frase)" },
        },
        required: ["type", "spinType", "exactPhrasing", "whyNow"],
      },
      risks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "price_objection",
                "competitor_mentioned",
                "lack_of_urgency",
                "wrong_decision_maker",
                "technical_doubt",
                "other",
              ],
            },
            severity: { type: "string", enum: ["low", "medium", "high"] },
            note: { type: "string" },
          },
          required: ["type", "severity", "note"],
        },
      },
      crossSellTriggers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            productHint: { type: "string" },
            triggerPhrase: { type: "string" },
          },
          required: ["productHint", "triggerPhrase"],
        },
      },
    },
    required: ["spinStage", "confidence", "whatClientRevealed", "nextBestAction", "risks", "crossSellTriggers"],
  },
};

interface TurnPayload {
  speaker: "vendedor" | "cliente";
  text: string;
  isFinal: boolean;
  startedAt: number;
}

function buildUserMessage(turns: TurnPayload[]): string {
  if (turns.length === 0) {
    return "Transcript ainda vazio — aguardando conversa começar. Sem turnos para analisar.\n\nAinda assim, retorne uma análise inicial via spin_analysis com sugestão de pergunta de abertura típica de Situation.";
  }
  const formatted = turns
    .map((t) => {
      const speaker = t.speaker === "vendedor" ? "[VENDEDOR]" : "[CLIENTE]";
      const interim = t.isFinal ? "" : " [interim]";
      return `${speaker}${interim}: ${t.text}`;
    })
    .join("\n");
  return `Transcript acumulado da chamada até agora:\n\n${formatted}\n\nAnalise e chame a tool spin_analysis com o JSON estruturado completo.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY não configurada" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const turns: TurnPayload[] = Array.isArray(body?.turns) ? body.turns : [];

    const client = new Anthropic({ apiKey });

    // Estratégia de cache: system prompt fica num único breakpoint cacheado.
    // Próxima chamada com mesmo system pega cache hit ~90%.
    const response = await client.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1500,
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT_SPIN,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [SPIN_ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: "spin_analysis" },
      messages: [
        {
          role: "user",
          content: buildUserMessage(turns),
        },
      ],
    });

    // Extrai o tool_use block
    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      console.error("No tool_use in response:", JSON.stringify(response));
      return new Response(
        JSON.stringify({ error: "Claude não retornou tool_use válido", raw: response }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        analysis: toolUse.input,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("claude-spin-analyze error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/claude-spin-analyze/index.ts
git commit -m "feat(spin): edge function claude-spin-analyze with prompt caching + tool use"
```

> **Após o merge**: o usuário precisa configurar `ANTHROPIC_API_KEY` no Lovable Cloud Secrets ANTES do edge function funcionar.

---

## Task 4: Hook `useSpinAnalysis` (TDD)

**Files:**
- Create: `src/hooks/useSpinAnalysis.ts`
- Create: `src/hooks/__tests__/useSpinAnalysis.test.tsx`

- [ ] **Step 1: Escrever testes**

```tsx
// src/hooks/__tests__/useSpinAnalysis.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { TranscriptTurn } from '@/lib/transcription/types';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@/lib/invoke-function', () => ({
  invokeFunction: invokeMock,
}));

import { useSpinAnalysis } from '../useSpinAnalysis';

const fakeAnalysis = {
  spinStage: 'situation' as const,
  confidence: 0.8,
  whatClientRevealed: {
    situationFacts: ['usa PU mensalmente'],
    problemsAdmitted: [],
    implications: [],
    desiredOutcomes: [],
  },
  nextBestAction: {
    type: 'question' as const,
    spinType: 'problem' as const,
    exactPhrasing: 'Vocês têm tido problemas com o acabamento?',
    whyNow: 'Cliente já revelou volume; hora de buscar dor.',
  },
  risks: [],
  crossSellTriggers: [],
};

const turn = (overrides: Partial<TranscriptTurn> = {}): TranscriptTurn => ({
  id: `turn-${Math.random()}`,
  speaker: 'cliente',
  text: 'a gente usa uns 200 litros',
  isFinal: true,
  startedAt: Date.now(),
  endedAt: Date.now() + 1000,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  invokeMock.mockResolvedValue({ analysis: fakeAnalysis, usage: { inputTokens: 100, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 } });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSpinAnalysis', () => {
  it('estado inicial: status=idle, analysis=null', () => {
    const { result } = renderHook(() => useSpinAnalysis({ turns: [], enabled: false }));
    expect(result.current.status).toBe('idle');
    expect(result.current.analysis).toBeNull();
  });

  it('quando enabled=false: não chama edge mesmo com turnos finais', () => {
    renderHook(() =>
      useSpinAnalysis({
        turns: [turn({ speaker: 'cliente', isFinal: true })],
        enabled: false,
      })
    );
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('dispara análise debounced 3s após novo turno final do CLIENTE', async () => {
    const { result, rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    rerender({ turns: [turn({ speaker: 'cliente', isFinal: true })] });
    // Antes de 3s: nada
    vi.advanceTimersByTime(2900);
    expect(invokeMock).not.toHaveBeenCalled();

    // Após 3s: dispara
    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('claude-spin-analyze', expect.objectContaining({ turns: expect.any(Array) })));
    await waitFor(() => expect(result.current.analysis).toEqual(fakeAnalysis));
    expect(result.current.status).toBe('ready');
  });

  it('NÃO dispara análise pra turno do VENDEDOR isolado', () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    rerender({ turns: [turn({ speaker: 'vendedor', isFinal: true })] });
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('NÃO dispara em turnos interim (isFinal=false)', () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );
    rerender({ turns: [turn({ speaker: 'cliente', isFinal: false })] });
    vi.advanceTimersByTime(10_000);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('debounce: 2 turnos finais cliente em rajada → 1 chamada só após 3s do último', async () => {
    const { rerender } = renderHook(
      ({ turns }) => useSpinAnalysis({ turns, enabled: true }),
      { initialProps: { turns: [] as TranscriptTurn[] } }
    );

    const t1 = turn({ speaker: 'cliente', isFinal: true, text: 'primeiro' });
    rerender({ turns: [t1] });
    vi.advanceTimersByTime(2000);

    const t2 = turn({ speaker: 'cliente', isFinal: true, text: 'segundo' });
    rerender({ turns: [t1, t2] });
    vi.advanceTimersByTime(2900);
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Rodar — deve falhar**

Run: `bun run vitest run src/hooks/__tests__/useSpinAnalysis.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/hooks/useSpinAnalysis.ts
import { useEffect, useRef, useState } from 'react';
import { invokeFunction } from '@/lib/invoke-function';
import type { TranscriptTurn } from '@/lib/transcription/types';
import type { SpinAnalysis, SpinAnalysisStatus, TranscriptTurnLite } from '@/lib/spin/types';

interface UseSpinAnalysisOptions {
  turns: TranscriptTurn[];
  /** Quando false, não dispara análise (não consome créditos Anthropic). */
  enabled: boolean;
  /** Delay de debounce após último turno final do cliente (default 3000ms). */
  debounceMs?: number;
}

export interface UseSpinAnalysisReturn {
  status: SpinAnalysisStatus;
  analysis: SpinAnalysis | null;
  error: string | null;
}

/**
 * Hook que orquestra análise SPIN ao vivo.
 *
 * Trigger: cada vez que detecta novo turno FINAL do CLIENTE, agenda análise
 * com debounce de 3s. Se outro turno final do cliente chegar antes do timer
 * disparar, reseta o timer (debounce clássico). Turnos do VENDEDOR e turnos
 * INTERIM não disparam — só consomem créditos sem agregar info nova.
 *
 * Quando dispara: chama edge function `claude-spin-analyze` com TODOS os
 * turnos acumulados (Claude analisa o contexto completo). Atualiza `analysis`
 * com a resposta. Erros entram em `status='error'` mas não interrompem a chamada.
 */
export function useSpinAnalysis(opts: UseSpinAnalysisOptions): UseSpinAnalysisReturn {
  const { turns, enabled, debounceMs = 3000 } = opts;
  const [status, setStatus] = useState<SpinAnalysisStatus>('idle');
  const [analysis, setAnalysis] = useState<SpinAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<number | null>(null);
  const lastTriggeringTurnIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    // Encontra o último turno FINAL do CLIENTE
    const lastClienteFinal = [...turns].reverse().find(
      (t) => t.speaker === 'cliente' && t.isFinal
    );
    if (!lastClienteFinal) return;

    // Se já agendamos análise pra esse mesmo turno, não reagendar
    if (lastTriggeringTurnIdRef.current === lastClienteFinal.id && timerRef.current === null) {
      // Já processamos este turno
      return;
    }

    // Cancela timer anterior (debounce)
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    lastTriggeringTurnIdRef.current = lastClienteFinal.id;

    timerRef.current = window.setTimeout(async () => {
      timerRef.current = null;
      setStatus('analyzing');
      setError(null);

      try {
        // Converte pros tipos lite (sem ids internos)
        const turnsLite: TranscriptTurnLite[] = turns.map((t) => ({
          speaker: t.speaker,
          text: t.text,
          isFinal: t.isFinal,
          startedAt: t.startedAt,
        }));

        const response = await invokeFunction<{ analysis: SpinAnalysis; usage: unknown }>(
          'claude-spin-analyze',
          { turns: turnsLite }
        );
        setAnalysis(response.analysis);
        setStatus('ready');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Erro na análise SPIN';
        setError(msg);
        setStatus('error');
      }
    }, debounceMs);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [turns, enabled, debounceMs]);

  return { status, analysis, error };
}
```

- [ ] **Step 4: Rodar testes**

Run: `bun run vitest run src/hooks/__tests__/useSpinAnalysis.test.tsx`
Expected: PASS 6 tests.

Run: `bun run vitest run`
Expected: full suite green (167 + 6 = 173 tests).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useSpinAnalysis.ts src/hooks/__tests__/useSpinAnalysis.test.tsx
git commit -m "feat(spin): useSpinAnalysis hook with debounced trigger on cliente final turns"
```

---

## Task 5: Wire `useSpinAnalysis` no `WebRTCCallContext`

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx`
- Modify: `src/contexts/__tests__/WebRTCCallContext.test.tsx`

- [ ] **Step 1: Estender `WebRTCCallContextValue`**

No topo de `src/contexts/WebRTCCallContext.tsx`, adicionar imports:

```ts
import { useSpinAnalysis } from '@/hooks/useSpinAnalysis';
import type { SpinAnalysis, SpinAnalysisStatus } from '@/lib/spin/types';
```

Estender a interface com 3 novos campos:

```ts
export interface WebRTCCallContextValue {
  // ... campos existentes ...
  /** Análise SPIN ao vivo da conversa atual. null se ainda não rodou. */
  spinAnalysis: SpinAnalysis | null;
  spinAnalysisStatus: SpinAnalysisStatus;
  spinAnalysisError: string | null;
}
```

- [ ] **Step 2: Chamar hook + adicionar ao value**

Dentro do `WebRTCCallProvider`, depois do `const transcription = useTranscription(...)`, adicionar:

```ts
const spin = useSpinAnalysis({
  turns: transcription.turns,
  enabled: callState === 'established',
});
```

E no `value: WebRTCCallContextValue = { ... }`:

```ts
const value: WebRTCCallContextValue = {
  // ... campos existentes ...
  spinAnalysis: spin.analysis,
  spinAnalysisStatus: spin.status,
  spinAnalysisError: spin.error,
};
```

- [ ] **Step 3: Atualizar testes do Context**

Em `src/contexts/__tests__/WebRTCCallContext.test.tsx`, adicionar mock pro hook:

```ts
vi.mock('@/hooks/useSpinAnalysis', () => ({
  useSpinAnalysis: () => ({
    status: 'idle' as const,
    analysis: null,
    error: null,
  }),
}));
```

E 1 teste novo:

```tsx
it('expõe campos de SPIN analysis (inicialmente idle/null)', async () => {
  const { result } = renderHook(() => useWebRTCCallContext(), { wrapper });
  await waitFor(() => expect(SipClient).toHaveBeenCalled());

  expect(result.current.spinAnalysisStatus).toBe('idle');
  expect(result.current.spinAnalysis).toBeNull();
  expect(result.current.spinAnalysisError).toBeNull();
});
```

- [ ] **Step 4: Verificar**

Run: `bun run vitest run`
Expected: green.

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx src/contexts/__tests__/WebRTCCallContext.test.tsx
git commit -m "feat(spin): wire useSpinAnalysis into WebRTCCallContext"
```

---

## Task 6: Componente `SpinSuggestionCard`

**Files:** Create `src/components/call/SpinSuggestionCard.tsx`

- [ ] **Step 1: Criar componente**

```tsx
// src/components/call/SpinSuggestionCard.tsx
import { Loader2, AlertCircle, Lightbulb, AlertTriangle, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import type { SpinAnalysis, SpinAnalysisStatus, SpinStage } from '@/lib/spin/types';

interface SpinSuggestionCardProps {
  status: SpinAnalysisStatus;
  analysis: SpinAnalysis | null;
  error: string | null;
}

const STAGE_LABEL: Record<SpinStage, string> = {
  opening: 'Abertura',
  situation: 'Situação',
  problem: 'Problema',
  implication: 'Implicação',
  need_payoff: 'Need-Payoff',
  closing: 'Fechamento',
};

const STAGE_COLOR: Record<SpinStage, string> = {
  opening: 'bg-muted text-muted-foreground',
  situation: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300',
  problem: 'bg-orange-100 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300',
  implication: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300',
  need_payoff: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300',
  closing: 'bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300',
};

/**
 * Card sticky no rodapé do TranscriptionPanel mostrando a sugestão SPIN atual.
 * Vendedor LÊ literalmente o `exactPhrasing` da próxima ação.
 */
export function SpinSuggestionCard({ status, analysis, error }: SpinSuggestionCardProps) {
  if (status === 'idle') {
    return (
      <div className="border-t border-border p-3 bg-muted/30">
        <div className="text-2xs text-muted-foreground text-center">
          Copilot SPIN aguardando a primeira fala do cliente…
        </div>
      </div>
    );
  }

  if (status === 'analyzing' && !analysis) {
    return (
      <div className="border-t border-border p-3 bg-muted/30">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Copilot analisando…
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="border-t border-border p-3 bg-status-error-bg">
        <div className="flex items-start gap-2 text-xs">
          <AlertCircle className="w-3.5 h-3.5 text-status-error shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-status-error">Erro no copilot SPIN</div>
            {error && <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</div>}
          </div>
        </div>
      </div>
    );
  }

  if (!analysis) return null;

  const { spinStage, confidence, nextBestAction, risks, crossSellTriggers } = analysis;
  const stageColor = STAGE_COLOR[spinStage];
  const stageLabel = STAGE_LABEL[spinStage];

  return (
    <div className="border-t border-border bg-card p-3 space-y-3">
      {/* Header: stage + confidence */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-4 h-4 text-status-warning" />
          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Sugestão Copilot
          </span>
          <Badge variant="outline" className={cn('text-2xs', stageColor)}>
            {stageLabel}
          </Badge>
        </div>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {Math.round(confidence * 100)}% conf.
        </span>
      </div>

      {/* Próxima ação — destaque visual */}
      <div className="space-y-1">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">
          Próxima pergunta sugerida:
        </div>
        <blockquote className="text-sm font-medium text-foreground border-l-2 border-status-success pl-3 italic">
          "{nextBestAction.exactPhrasing}"
        </blockquote>
        <div className="text-2xs text-muted-foreground">
          <span className="font-medium">Por quê:</span> {nextBestAction.whyNow}
        </div>
      </div>

      {/* Riscos (se houver) */}
      {risks.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {risks.map((risk, idx) => (
            <Badge
              key={idx}
              variant="outline"
              className={cn(
                'text-2xs gap-1',
                risk.severity === 'high' && 'border-status-error text-status-error',
                risk.severity === 'medium' && 'border-status-warning text-status-warning',
              )}
              title={risk.note}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              {risk.type.replace(/_/g, ' ')}
            </Badge>
          ))}
        </div>
      )}

      {/* Cross-sell hints (PR4 vai consumir) */}
      {crossSellTriggers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-2 border-t border-border/50">
          <div className="text-2xs text-muted-foreground flex items-center gap-1">
            <ShoppingCart className="w-3 h-3" />
            Oportunidade cross-sell:
          </div>
          {crossSellTriggers.map((t, idx) => (
            <Badge key={idx} variant="outline" className="text-2xs">
              {t.productHint}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/call/SpinSuggestionCard.tsx
git commit -m "feat(spin): SpinSuggestionCard UI for sticky bottom suggestion display"
```

---

## Task 7: Renderizar `SpinSuggestionCard` no `TranscriptionPanel`

**Files:** Modify `src/components/call/TranscriptionPanel.tsx`

- [ ] **Step 1: Adicionar props pra spin state**

Em `src/components/call/TranscriptionPanel.tsx`, estender `TranscriptionPanelProps`:

```ts
import type { SpinAnalysis, SpinAnalysisStatus } from '@/lib/spin/types';
import { SpinSuggestionCard } from './SpinSuggestionCard';

interface TranscriptionPanelProps {
  status: TranscriptionStatus;
  turns: TranscriptTurn[];
  error: string | null;
  open: boolean;
  onClose: () => void;
  // NOVO em PR3:
  spinAnalysis?: SpinAnalysis | null;
  spinStatus?: SpinAnalysisStatus;
  spinError?: string | null;
}
```

- [ ] **Step 2: Renderizar o card no rodapé (substitui footer atual)**

Localizar o footer atual:
```tsx
<footer className="p-3 border-t border-border text-2xs text-muted-foreground text-center shrink-0">
  Transcrição via Deepgram Nova-3. Não armazenada (PR6 vai persistir).
</footer>
```

Substituir por (quando há props spin):
```tsx
{props.spinStatus !== undefined ? (
  <div className="shrink-0">
    <SpinSuggestionCard
      status={props.spinStatus}
      analysis={props.spinAnalysis ?? null}
      error={props.spinError ?? null}
    />
  </div>
) : (
  <footer className="p-3 border-t border-border text-2xs text-muted-foreground text-center shrink-0">
    Transcrição via Deepgram Nova-3. Não armazenada (PR6 vai persistir).
  </footer>
)}
```

- [ ] **Step 3: Atualizar `FarmerCalls.tsx` pra passar as novas props**

Em `src/pages/FarmerCalls.tsx`, achar onde `<TranscriptionPanel>` é renderizado e adicionar as 3 props novas:

```tsx
<TranscriptionPanel
  status={webrtc.transcriptionStatus}
  turns={webrtc.transcriptionTurns}
  error={webrtc.transcriptionError}
  open={transcriptionPanelOpen}
  onClose={() => setTranscriptionPanelOpen(false)}
  // NOVAS em PR3:
  spinStatus={webrtc.spinAnalysisStatus}
  spinAnalysis={webrtc.spinAnalysis}
  spinError={webrtc.spinAnalysisError}
/>
```

- [ ] **Step 4: Verificar**

Run: `bun run vitest run`
Expected: green.

Run: `bun run tsc --noEmit`
Expected: clean.

Run: `bun run build:dev`
Expected: passa.

- [ ] **Step 5: Commit**

```bash
git add src/components/call/TranscriptionPanel.tsx src/pages/FarmerCalls.tsx
git commit -m "feat(spin): render SpinSuggestionCard in TranscriptionPanel footer"
```

---

## Task 8: QA + PR

- [ ] **Step 1: Lint dos arquivos novos**

Run: `bun lint 2>&1 | grep -E "src/(lib/spin|hooks/useSpinAnalysis|components/call/Spin|contexts/WebRTCCallContext)" | head -10`
Expected: zero errors em arquivos novos. Anotar com `eslint-disable-next-line` se houver `any` necessários.

- [ ] **Step 2: Suite completa**

Run: `bun run vitest run`
Expected: ~175 tests (was 167 + ~8 novos: 6 spin-prompts + 6 useSpinAnalysis + 1 context = 13 novos? — ajustar conforme implementação real).

- [ ] **Step 3: TypeScript**

Run: `bun run tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Build production**

Run: `bun build`
Expected: passa. Bundle check:
```bash
grep -l "Anthropic\|spin_analysis" dist/assets/index-*.js | head -3
```
Expected: zero matches no main bundle (Anthropic SDK só roda server-side na edge, não vai pro client).

- [ ] **Step 5: Push + PR**

```bash
git push -u origin claude/pr3-claude-spin-analysis
gh pr create --base main --head claude/pr3-claude-spin-analysis \
  --title "feat: SPIN analysis with Claude Sonnet 4.6 (PR3)" \
  --body "..."
```

Body do PR (adaptar com base no resultado final):
```md
## Summary

PR3 — Análise SPIN ao vivo com Claude Sonnet 4.6. Consome `transcriptionTurns` do PR2,
chama Anthropic Messages API via edge function com prompt caching, retorna sugestão
estruturada (estágio SPIN + próxima pergunta exata + riscos + cross-sell triggers),
exibe em card sticky no rodapé do TranscriptionPanel.

**⚠️ Depende de PR #42 (PR2) ser mergeada primeiro.**

### Pre-deploy

Configurar **1 secret** no Lovable Cloud:
- `ANTHROPIC_API_KEY` (obter em https://console.anthropic.com)

### Arquitetura

- Edge Function `claude-spin-analyze`: usa SDK Anthropic com prompt caching (system breakpoint), tool use forçada pra retornar JSON estruturado.
- `useSpinAnalysis` hook: debounce 3s após último turno FINAL do CLIENTE; turnos do vendedor e interim não disparam (otimização de custo).
- `SpinSuggestionCard`: sticky no rodapé do TranscriptionPanel; mostra estágio (badge colorido), pergunta sugerida (citação em destaque), rationale, riscos, cross-sell hints.

### Custo esperado

- ~$0.005-0.02 por análise (cache hit reduz pra ~$0.005)
- ~20 análises por chamada 10min = ~$0.15/call
- 1000 calls/mês = ~$150/mês

### Não incluso (PRs futuros)

- PR4: Cross-sell ao vivo (resolve `crossSellTriggers` pra produtos reais)
- PR5: Triggers inteligentes (silêncio, palavras-âncora)
- PR6: Persistência das análises em `farmer_copilot_sessions`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**1. Spec coverage:**

| Spec | Task |
|---|---|
| Análise SPIN com Claude Sonnet 4.6 | Task 3 (edge function) |
| Prompt caching | Task 3 (system breakpoint cached) |
| Tool use pra JSON estruturado | Task 3 (SPIN_ANALYSIS_TOOL) |
| Trigger após turno final do cliente | Task 4 (useSpinAnalysis) |
| Display na UI do dialer | Tasks 6 + 7 (SpinSuggestionCard + integration) |
| Graceful degradation sem key | Coberto: edge 500 → hook 'error' → card mostra erro, call segue |
| Não persistir (deferido PR6) | Documentado nos não-objetivos |

Cobertura completa.

**2. Placeholder scan:** Sem "TBD". Código completo em todas as tasks.

**3. Type consistency:**

- `SpinAnalysis`, `SpinStage`, `SpinAnalysisStatus`, `TranscriptTurnLite` em Task 1 → consumidos em Tasks 2, 3, 4, 5, 6, 7.
- `useSpinAnalysis({ turns, enabled, debounceMs })` em Task 4 → chamado em Task 5 (sem debounceMs, usa default).
- `WebRTCCallContextValue` ganha `spinAnalysis`, `spinAnalysisStatus`, `spinAnalysisError` → Task 7 consome via props mapeados de `webrtc.*`.
- `SpinSuggestionCard({ status, analysis, error })` em Task 6 → renderizado em Task 7 com nomes consistentes.

**4. Riscos abertos:**

- **Custo de execução em produção** — se vendedor falar pouco e cliente muito, podemos ter análises cada 4-5s. Total mensal pode estourar previsão. PR5 trará triggers mais inteligentes. Monitorar PostHog quando ligar.
- **Quality do `exactPhrasing`** — Claude pode soar artificial ("preencher" demais a pergunta). Iterar prompt depois de smoke test real, possivelmente adicionar few-shot examples no SYSTEM_PROMPT_SPIN.
- **Latência percebida** — análise leva 1-3s pra responder. Cliente pode falar de novo durante esse tempo. UX OK porque novo turno final do cliente cancela debounce e re-analisa, mas vale observar.
- **Caching efetividade** — prompt caching da Anthropic tem TTL 5min. Se chamadas forem espaçadas no tempo, cache evicta. Como uma call típica dura 5-10min, primeira call paga full price, subsequentes (no mesmo dia ou ciclo de inatividade < 5min entre análises) pegam cache hit. Aceitável.

---

## Execution Handoff

Plan completo e salvo em `docs/superpowers/plans/2026-05-17-pr3-claude-spin-analysis.md`.

**Duas opções de execução:**

1. **Subagent-Driven (recomendada)** — igual PR1, 1.5, 1.6, 2
2. **Inline Execution** — com checkpoints

Qual abordagem?

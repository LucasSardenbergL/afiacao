# PR6b — KB: Extração Automática de Specs via Claude Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dado um documento processado em `kb_documents` (status='ready' com texto extraído), permitir extração estruturada de specs técnicos via Claude tool use. Schema novo: `kb_product_specs` (rendimento, validade, pot life, densidade, sólidos, dureza, brilho, catalisador/diluente compatível, gramatura, compliance) + skeleton `kb_competitors` / `kb_competitor_products` (vazio — vendedor preenche via PR8). Edge function `kb-extract-specs` chama Claude, retorna proposta. UI no detail page: botão "Extrair specs" → form pré-preenchido pra admin revisar e aprovar → salva.

**Architecture:**
- Migration: 3 tabelas (`kb_product_specs`, `kb_competitors`, `kb_competitor_products`) + RLS (master CRUD, staff read)
- Edge function `kb-extract-specs` (Deno + Anthropic SDK): recebe `documentId`, busca content_extracted, monta prompt SPIN-like com tool use forçada pra retornar shape estruturado, retorna `{ specs: {...}, confidence, gaps: [...] }`
- Client: hook `useExtractSpecs` (mutation), hook `useKbProductSpecs(productCode)` (read), componente `KbSpecsForm` (form de revisão RHF+Zod), wire no `AdminKnowledgeBaseDetail`

**Tech Stack:**
- Anthropic SDK Deno (`npm:@anthropic-ai/sdk@^0.93.0`) — mesmo padrão de `claude-spin-analyze`
- Claude Sonnet 4.6 (com adaptive thinking — extração técnica vale custo)
- Tool use forçada (`tool_choice: { type: 'tool', name: 'extract_product_specs' }`)
- Prompt caching no system prompt (compartilhado entre requests)
- RHF + Zod no form

**Não-objetivos (próximos PRs):**
- Calculadora ao vivo no painel de chamada (PR6c)
- RAG retrieval no copilot (PR6d)
- UI de gestão de concorrentes + battle cards (PR8) — schema fica pronto aqui
- Versionamento de specs (parent_id existe mas sem UI)
- Histórico de revisões da spec (só guarda current)
- OCR / fallback pra PDFs sem texto extraído

---

## File Structure

**Criar:**
- `supabase/migrations/{timestamp}_kb_specs_and_competitors.sql` — 3 tabelas + RLS
- `supabase/functions/kb-extract-specs/index.ts` — edge function com Claude tool use
- `src/lib/knowledge-base/specs-types.ts` — `KbProductSpec`, `KbCompetitor`, `KbCompetitorProduct` types
- `src/hooks/useExtractSpecs.ts` — mutation: invoca edge function, retorna proposta sem salvar
- `src/hooks/useSaveProductSpecs.ts` — mutation: salva specs aprovados
- `src/hooks/useKbProductSpecs.ts` — query: busca specs por document_id ou product_code
- `src/hooks/__tests__/useExtractSpecs.test.tsx`
- `src/components/knowledge-base/KbSpecsForm.tsx` — form de revisão (RHF + Zod)
- `src/components/knowledge-base/KbSpecsExtractButton.tsx` — botão + Dialog

**Modificar:**
- `src/integrations/supabase/types.ts` — 3 tabelas novas
- `src/pages/AdminKnowledgeBaseDetail.tsx` — render do KbSpecsExtractButton + KbSpecsForm quando documento ready

**Não modificar:**
- `kb-ingest-document` edge function (PR6a — independente)
- `claude-spin-analyze` (PR6d vai integrar)
- `kb_documents` / `kb_chunks` schema (não muda)

---

## Pré-requisito do operador

- `ANTHROPIC_API_KEY` já configurada (PR #55)
- Rodar a nova migration SQL no Lovable Cloud
- Regenerar types Supabase

---

## Task 1: Migration SQL

**Files:** Create `supabase/migrations/{timestamp}_kb_specs_and_competitors.sql`

```sql
-- PR6b: KB specs + competitors skeleton

-- 1. Tabela de specs estruturados (1 row por produto da Sayerlack/Colacor)
CREATE TABLE IF NOT EXISTS public.kb_product_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.kb_documents(id) ON DELETE SET NULL,
  product_code text NOT NULL UNIQUE,        -- ex: 'FO20.6827.00'
  product_name text NOT NULL,
  supplier text NOT NULL DEFAULT 'sayerlack',
  product_line text,                         -- 'wood_pu' | 'wood_nitro' | 'hydropoxi' | 'auto'
  product_category text,                     -- 'primer' | 'verniz' | 'tinta' | 'catalisador' | 'diluente'

  -- Propriedades físico-químicas
  densidade_g_cm3 numeric,
  solidos_pct numeric,
  viscosidade_aplicacao_s numeric,
  viscosidade_copo text,                     -- 'CF4' | 'CF6' | 'CF8'
  brilho_ub numeric,                         -- unidades de brilho
  dureza text,                               -- '3H', '2H' etc.

  -- Aplicação
  rendimento_m2_por_litro numeric,           -- calculado ou explícito
  demaos_recomendadas integer,
  gramatura_g_m2_min integer,
  gramatura_g_m2_max integer,
  pot_life_horas numeric,
  temp_aplicacao_c_min numeric,
  temp_aplicacao_c_max numeric,
  umidade_aplicacao_pct_min numeric,
  umidade_aplicacao_pct_max numeric,

  -- Compatibilidade
  catalisador_codigo text,                   -- ex: 'FC.6952'
  catalisador_proporcao_pct numeric,
  diluente_codigo text,                      -- ex: 'DF.4068'
  equipamentos_aplicacao text[],             -- ['pistola_convencional', 'tanque_pressao']
  lixa_recomendada text,
  substrato text[],                          -- ['madeira', 'mdf']

  -- Secagem
  secagem_manuseio_h numeric,
  secagem_empilhamento_h numeric,
  secagem_total_h numeric,

  -- Armazenamento
  validade_dias integer,
  temp_armazenamento_c_min integer,
  temp_armazenamento_c_max integer,

  -- Compliance
  certificacoes_aplicaveis text[],           -- ['IKEA', 'LGA', 'Proposition_65']
  isento_metais_pesados text[],              -- ['Cd', 'Pb', etc.]
  isento_substancias text[],                 -- ['amianto', 'formaldeido']

  -- Notas qualitativas
  diferenciais_chave text[],                 -- ['resistencia_risco_superior', 'toque_sedoso']
  uso_recomendado text,
  publico_alvo text,

  -- Metadata
  extraction_confidence numeric,             -- 0-1 (Claude reporta)
  extraction_gaps text[],                    -- campos que Claude não conseguiu extrair
  extracted_by uuid REFERENCES auth.users(id),
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2. Concorrentes (vazio — populado por PR8)
CREATE TABLE IF NOT EXISTS public.kb_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,                 -- 'Farben Tintas', 'Vernit', 'Rosalen'
  tipo text CHECK (tipo IN ('regional', 'nacional', 'importado')),
  regiao_principal text,                     -- 'mg', 'sul', 'sp', 'nacional'
  segmento_atuacao text[],                   -- ['moveleiro', 'industrial', 'automotivo']
  notas_estrategicas text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. Produtos do concorrente (vazio — populado via UI ou auto-detect)
CREATE TABLE IF NOT EXISTS public.kb_competitor_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id uuid NOT NULL REFERENCES public.kb_competitors(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  category text,                             -- mesmo enum de kb_product_specs.product_category
  rendimento_m2_por_litro numeric,
  solidos_pct numeric,
  pot_life_horas numeric,
  validade_dias integer,
  preco_referencia_l numeric,
  preco_atualizado_em timestamptz,
  fonte_preco text CHECK (fonte_preco IN ('vendedor', 'cotacao', 'site', 'estimado', 'detectado_ia')),
  pontos_fortes text[],
  pontos_fracos text[],
  nosso_equivalente_product_code text,       -- referência cruzada com nossos kb_product_specs.product_code
  argumentos_comparativos jsonb,             -- estrutura aberta pra flexibilidade
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Indexes
CREATE INDEX IF NOT EXISTS idx_kb_product_specs_product_code ON public.kb_product_specs (product_code);
CREATE INDEX IF NOT EXISTS idx_kb_product_specs_supplier_line ON public.kb_product_specs (supplier, product_line);
CREATE INDEX IF NOT EXISTS idx_kb_competitor_products_competitor ON public.kb_competitor_products (competitor_id);
CREATE INDEX IF NOT EXISTS idx_kb_competitor_products_equivalent ON public.kb_competitor_products (nosso_equivalente_product_code);

-- 5. Triggers updated_at (reusa função do PR6a se existir; senão cria)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'kb_documents_set_updated_at') THEN
    CREATE OR REPLACE FUNCTION public.kb_documents_set_updated_at()
    RETURNS trigger AS $func$
    BEGIN NEW.updated_at = now(); RETURN NEW; END;
    $func$ LANGUAGE plpgsql;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_kb_product_specs_updated_at ON public.kb_product_specs;
CREATE TRIGGER trg_kb_product_specs_updated_at
  BEFORE UPDATE ON public.kb_product_specs
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

DROP TRIGGER IF EXISTS trg_kb_competitors_updated_at ON public.kb_competitors;
CREATE TRIGGER trg_kb_competitors_updated_at
  BEFORE UPDATE ON public.kb_competitors
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

DROP TRIGGER IF EXISTS trg_kb_competitor_products_updated_at ON public.kb_competitor_products;
CREATE TRIGGER trg_kb_competitor_products_updated_at
  BEFORE UPDATE ON public.kb_competitor_products
  FOR EACH ROW EXECUTE FUNCTION public.kb_documents_set_updated_at();

-- 6. RLS — staff lê, master CRUD
ALTER TABLE public.kb_product_specs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_competitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_competitor_products ENABLE ROW LEVEL SECURITY;

-- kb_product_specs
CREATE POLICY "kb_product_specs_select_staff" ON public.kb_product_specs
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_product_specs_insert_staff" ON public.kb_product_specs
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'master'::app_role)
    OR extracted_by = auth.uid()
  );
CREATE POLICY "kb_product_specs_delete_master" ON public.kb_product_specs
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- kb_competitors
CREATE POLICY "kb_competitors_select_staff" ON public.kb_competitors
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_insert_staff" ON public.kb_competitors
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_update_staff" ON public.kb_competitors
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitors_delete_master" ON public.kb_competitors
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- kb_competitor_products
CREATE POLICY "kb_competitor_products_select_staff" ON public.kb_competitor_products
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_insert_staff" ON public.kb_competitor_products
  FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_update_staff" ON public.kb_competitor_products
  FOR UPDATE
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );
CREATE POLICY "kb_competitor_products_delete_master" ON public.kb_competitor_products
  FOR DELETE
  USING (public.has_role(auth.uid(), 'master'::app_role));

-- 7. Comentários
COMMENT ON TABLE public.kb_product_specs IS 'Specs estruturados extraídos de kb_documents via Claude. 1 row por produto Sayerlack.';
COMMENT ON TABLE public.kb_competitors IS 'Concorrentes regionais/nacionais. Populado por vendedores via UI ou auto-detect de transcripts.';
COMMENT ON TABLE public.kb_competitor_products IS 'Produtos específicos dos concorrentes com specs comparáveis aos nossos.';
```

Commit: `feat(kb): migration — kb_product_specs + kb_competitors + kb_competitor_products + RLS`

---

## Task 2: Types Supabase + domain types

**Files:**
- Modify: `src/integrations/supabase/types.ts` — adicionar 3 tabelas
- Create: `src/lib/knowledge-base/specs-types.ts`

```ts
// specs-types.ts
export interface KbProductSpec {
  id: string;
  document_id: string | null;
  product_code: string;
  product_name: string;
  supplier: string;
  product_line: string | null;
  product_category: string | null;

  densidade_g_cm3: number | null;
  solidos_pct: number | null;
  viscosidade_aplicacao_s: number | null;
  viscosidade_copo: string | null;
  brilho_ub: number | null;
  dureza: string | null;

  rendimento_m2_por_litro: number | null;
  demaos_recomendadas: number | null;
  gramatura_g_m2_min: number | null;
  gramatura_g_m2_max: number | null;
  pot_life_horas: number | null;
  temp_aplicacao_c_min: number | null;
  temp_aplicacao_c_max: number | null;
  umidade_aplicacao_pct_min: number | null;
  umidade_aplicacao_pct_max: number | null;

  catalisador_codigo: string | null;
  catalisador_proporcao_pct: number | null;
  diluente_codigo: string | null;
  equipamentos_aplicacao: string[];
  lixa_recomendada: string | null;
  substrato: string[];

  secagem_manuseio_h: number | null;
  secagem_empilhamento_h: number | null;
  secagem_total_h: number | null;

  validade_dias: number | null;
  temp_armazenamento_c_min: number | null;
  temp_armazenamento_c_max: number | null;

  certificacoes_aplicaveis: string[];
  isento_metais_pesados: string[];
  isento_substancias: string[];

  diferenciais_chave: string[];
  uso_recomendado: string | null;
  publico_alvo: string | null;

  extraction_confidence: number | null;
  extraction_gaps: string[];
  extracted_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Resposta da edge fn kb-extract-specs (sem ids, sem timestamps — só os campos extraídos) */
export type KbExtractedSpec = Omit<KbProductSpec,
  'id' | 'document_id' | 'extracted_by' | 'approved_by' | 'approved_at' | 'created_at' | 'updated_at'
>;

export interface KbCompetitor {
  id: string;
  name: string;
  tipo: 'regional' | 'nacional' | 'importado' | null;
  regiao_principal: string | null;
  segmento_atuacao: string[];
  notas_estrategicas: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KbCompetitorProduct {
  id: string;
  competitor_id: string;
  product_name: string;
  category: string | null;
  rendimento_m2_por_litro: number | null;
  solidos_pct: number | null;
  pot_life_horas: number | null;
  validade_dias: number | null;
  preco_referencia_l: number | null;
  preco_atualizado_em: string | null;
  fonte_preco: 'vendedor' | 'cotacao' | 'site' | 'estimado' | 'detectado_ia' | null;
  pontos_fortes: string[];
  pontos_fracos: string[];
  nosso_equivalente_product_code: string | null;
  argumentos_comparativos: unknown;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
```

Commit: `feat(kb): types — KbProductSpec + KbCompetitor + KbCompetitorProduct`

---

## Task 3: Edge Function `kb-extract-specs`

**Files:** Create `supabase/functions/kb-extract-specs/index.ts`

Recebe `{ documentId }`, busca o document (deve ter `content_extracted`), monta prompt SYSTEM_PROMPT_EXTRACT_SPECS, chama Claude com `tool_choice: { type: 'tool', name: 'extract_product_specs' }`, retorna tool input + metadata (confidence, gaps).

```ts
import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { authorizeCronOrStaff, corsHeaders } from "../_shared/auth.ts";

const SYSTEM_PROMPT_EXTRACT_SPECS = `Você extrai specs técnicos estruturados de boletins técnicos de tintas industriais para a base de conhecimento da Colacor (distribuidora Sayerlack).

# Regras gerais
- Use APENAS dados explícitos no texto. NÃO invente, NÃO estime.
- Quando o boletim dá um range (ex: "viscosidade 42 ± 3s CF6 a 25°C"), use o valor central (42).
- Para campos que o boletim NÃO menciona, deixe null.
- Liste em \`extraction_gaps\` os campos importantes que estão ausentes.
- \`extraction_confidence\` = 0.9+ se boletim claro, 0.6-0.8 se ambíguo, <0.6 se faltam muitos dados-chave.

# Cálculos derivados permitidos
- \`rendimento_m2_por_litro\` = (densidade_g_cm3 × 1000) / gramatura_g_m2_media. Use gramatura média entre min/max se houver range. Se boletim não tem gramatura nem densidade, deixe null.

# Classificação semântica (vc preenche baseado no texto)
- \`product_line\`: 'wood_pu' | 'wood_nitro' | 'hydropoxi' | 'auto' — Wood PU pra poliuretanos pra madeira (mais comum em boletins moveleiros)
- \`product_category\`: 'primer' | 'verniz' | 'tinta' | 'catalisador' | 'diluente' | 'massa' | 'selador'
- \`diferenciais_chave\`: extrai as 2-5 frases-chave do "Uso Recomendado" e "Características"

# Compliance
- Se boletim menciona "isento de" e lista substâncias/metais, capture nos arrays
- \`certificacoes_aplicaveis\`: capture menções de IKEA, LGA, Proposition 65, JIS, CARB, etc.

SEMPRE use a tool extract_product_specs. NÃO responda em texto fora dela.`;

const EXTRACT_TOOL = {
  name: "extract_product_specs",
  description: "Retorna specs estruturados do produto extraídos do boletim técnico.",
  input_schema: {
    type: "object",
    properties: {
      product_code: { type: "string" },
      product_name: { type: "string" },
      supplier: { type: "string" },
      product_line: { type: ["string", "null"], enum: ["wood_pu", "wood_nitro", "hydropoxi", "auto", null] },
      product_category: { type: ["string", "null"] },
      densidade_g_cm3: { type: ["number", "null"] },
      solidos_pct: { type: ["number", "null"] },
      viscosidade_aplicacao_s: { type: ["number", "null"] },
      viscosidade_copo: { type: ["string", "null"] },
      brilho_ub: { type: ["number", "null"] },
      dureza: { type: ["string", "null"] },
      rendimento_m2_por_litro: { type: ["number", "null"] },
      demaos_recomendadas: { type: ["integer", "null"] },
      gramatura_g_m2_min: { type: ["integer", "null"] },
      gramatura_g_m2_max: { type: ["integer", "null"] },
      pot_life_horas: { type: ["number", "null"] },
      temp_aplicacao_c_min: { type: ["number", "null"] },
      temp_aplicacao_c_max: { type: ["number", "null"] },
      umidade_aplicacao_pct_min: { type: ["number", "null"] },
      umidade_aplicacao_pct_max: { type: ["number", "null"] },
      catalisador_codigo: { type: ["string", "null"] },
      catalisador_proporcao_pct: { type: ["number", "null"] },
      diluente_codigo: { type: ["string", "null"] },
      equipamentos_aplicacao: { type: "array", items: { type: "string" } },
      lixa_recomendada: { type: ["string", "null"] },
      substrato: { type: "array", items: { type: "string" } },
      secagem_manuseio_h: { type: ["number", "null"] },
      secagem_empilhamento_h: { type: ["number", "null"] },
      secagem_total_h: { type: ["number", "null"] },
      validade_dias: { type: ["integer", "null"] },
      temp_armazenamento_c_min: { type: ["integer", "null"] },
      temp_armazenamento_c_max: { type: ["integer", "null"] },
      certificacoes_aplicaveis: { type: "array", items: { type: "string" } },
      isento_metais_pesados: { type: "array", items: { type: "string" } },
      isento_substancias: { type: "array", items: { type: "string" } },
      diferenciais_chave: { type: "array", items: { type: "string" } },
      uso_recomendado: { type: ["string", "null"] },
      publico_alvo: { type: ["string", "null"] },
      extraction_confidence: { type: "number", minimum: 0, maximum: 1 },
      extraction_gaps: { type: "array", items: { type: "string" } },
    },
    required: [
      "product_code",
      "product_name",
      "supplier",
      "extraction_confidence",
      "extraction_gaps",
      "equipamentos_aplicacao",
      "substrato",
      "certificacoes_aplicaveis",
      "isento_metais_pesados",
      "isento_substancias",
      "diferenciais_chave",
    ],
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

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body.documentId) {
    return new Response(JSON.stringify({ error: "documentId required" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: doc, error } = await supabase
      .from("kb_documents")
      .select("id, title, product_code, supplier, content_extracted, status")
      .eq("id", body.documentId)
      .single();

    if (error || !doc) {
      return new Response(JSON.stringify({ error: "Document not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (doc.status !== "ready" || !doc.content_extracted) {
      return new Response(JSON.stringify({ error: "Document not ready or has no extracted content" }), {
        status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const client = new Anthropic({ apiKey });

    const userMsg = `Extraia os specs estruturados deste boletim técnico:

# Metadata
- Título: ${doc.title}
- Código produto (hint): ${doc.product_code ?? "(não informado)"}
- Fornecedor: ${doc.supplier ?? "sayerlack"}

# Texto extraído
${doc.content_extracted.slice(0, 50_000)}

Use a tool extract_product_specs.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: [{
        type: "text",
        text: SYSTEM_PROMPT_EXTRACT_SPECS,
        cache_control: { type: "ephemeral" },
      }],
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "extract_product_specs" },
      messages: [{ role: "user", content: userMsg }],
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return new Response(JSON.stringify({ error: "No tool_use in response", raw: response }), {
        status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      specs: toolUse.input,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("[kb-extract-specs]", msg);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
```

Commit: `feat(kb): edge function kb-extract-specs (Claude Sonnet 4.6 tool use)`

---

## Task 4: Hook `useExtractSpecs` (mutation + TDD)

`useExtractSpecs.mutate(documentId)` → invoca edge, retorna `KbExtractedSpec` (não salva).

Tests: mocka `invokeFunction`, valida que chama com payload correto, retorna data.specs.

Commit: `feat(kb): useExtractSpecs mutation`

---

## Task 5: Hook `useSaveProductSpecs` + `useKbProductSpecs`

- `useSaveProductSpecs`: upsert em `kb_product_specs` (por product_code unique). Set `approved_by = current_user`, `approved_at = now()`.
- `useKbProductSpecs(productCode?)`: query buscando por product_code, retorna `KbProductSpec | null`.

Commit: `feat(kb): useSaveProductSpecs + useKbProductSpecs hooks`

---

## Task 6: Componente `KbSpecsForm`

Form RHF + Zod com TODOS os campos de `KbExtractedSpec`. Aceita `initialValues` (proposta do Claude). `onSubmit` chama `useSaveProductSpecs`.

Visualmente agrupa em fieldsets: Identificação, Físico-químico, Aplicação, Compatibilidade, Secagem, Armazenamento, Compliance, Notas.

Sub-componente `KbSpecField` (label + input + hint quando vier null/gap).

Commit: `feat(kb): KbSpecsForm — revisar e aprovar specs propostos por Claude`

---

## Task 7: `KbSpecsExtractButton` + wire em `AdminKnowledgeBaseDetail`

`KbSpecsExtractButton`: botão "Extrair specs com IA" → useExtractSpecs.mutate → abre Dialog com KbSpecsForm preenchido → user revisa → submit salva.

No `AdminKnowledgeBaseDetail`, quando `status === 'ready'`:
- Mostra section "Specs estruturados"
- Se `useKbProductSpecs(doc.product_code).data` existe → mostra preview com `<KbSpecsPreview />` + botão "Editar"
- Se não existe → mostra `<KbSpecsExtractButton />`

Commit: `feat(kb): wire spec extraction in AdminKnowledgeBaseDetail`

---

## Task 8: QA + PR

- vitest: espera ~+3 (useExtractSpecs)
- tsc clean
- build passa
- Push + PR

---

## Self-Review

**Spec coverage:**
- Extração automática via Claude → Task 3
- UI de revisão e aprovação → Tasks 6, 7
- Schema pra concorrentes (sem hardcode) → Task 1
- Persistência aprovada → Task 5

**Riscos:**
- Schema de `kb_product_specs` tem ~45 campos. Form vai ficar grande mas é necessário (cada campo é dado real do boletim).
- Claude pode "alucinar" campos quando boletim é vago — `extraction_gaps` mitigação parcial; user revisa.
- Preço de chamada Claude com 50k chars de input: ~$0.05-0.15. Aceitável (rodado 1x por documento, depois cache).

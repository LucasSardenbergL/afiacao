# Fase 2 / Fatia 2 — Captura Inteligente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) ou superpowers:executing-plans pra implementar task-by-task. Steps usam checkbox (`- [ ]`).

**Goal:** A IA lê a transcrição de cada ligação, extrai 4 sinais estruturados (preço/marca/produto-gap/demanda) e os converte em ajustes de scoring que retroalimentam a próxima oferta — **sem registro manual**, e em **shadow-mode** (não muda a oferta até o piloto provar a precisão, classe a classe).

**Architecture:** 2 estágios desacoplados. **Estágio 1** = edge `extrair-sinais-ligacao` (Claude Sonnet 4.6, forced tool-use) grava em coluna dedicada `farmer_calls.sinais_ligacao` (envelope com auditoria, 1 writer). Um **trigger novo** (espelha o de `entities_extracted`) enfileira o recalc na fila **já existente** `score_recalc_queue`. **Estágio 2** = `scoring-recalc-client` estendido lê `sinais_ligacao`, converte via helper puro testado (com **contrato estrito de preço**) em `SignalModifier[]` carimbados com `class`. O `visit-score-recalc-client` só aplica modifiers de **classe ativada** (config) — fora disso ficam em **shadow** (computados, persistidos, sem efeito).

**Tech Stack:** Supabase (Edge Deno + Postgres + pg_cron + filas), Anthropic SDK (`@anthropic-ai/sdk`, `claude-sonnet-4-6`, forced tool-use, prompt caching), React + TanStack Query, vitest (helper puro). Contexto Lovable: migrations no SQL Editor, edges via chat, front via Publish — **nada acontece no merge**.

> **Spec:** [docs/superpowers/specs/2026-06-16-fase2-fatia2-captura-inteligente-design.md](../specs/2026-06-16-fase2-fatia2-captura-inteligente-design.md). Os trechos de código real referenciados foram validados contra o repo (scoring-recalc-client:47-295, visit-score-recalc-client:76-204, WebRTCCallContext:46-451, molde Anthropic em kb-extract-specs).

---

## Decisões técnicas cristalizadas (resolvem o que o mapa do código revelou)

1. **Coluna dedicada `sinais_ligacao`** (jsonb envelope), **1 writer** (a edge). NÃO reusa `entities_extracted` (o front já escreve essa no INSERT — `build-session-payload.ts:53` — multi-writer destrutivo). O envelope leva audit metadata (modelo/prompt_version/hash/status) que `entities_extracted` não tem.
2. **Trigger novo `trg_farmer_calls_enqueue_recalc_sinais`** espelha o `trg_farmer_calls_enqueue_recalc` existente, mas observa `sinais_ligacao` → insere na **mesma** `score_recalc_queue`. Reusa a fila + o drain. Resolve o trigger-gap do Codex sem enqueue manual frágil.
3. **`SignalModifier` ganha `class?: 'preco'|'marca'|'demanda'`.** TODO modifier passa a ter `class` (os legados `modifiersFromEntity/Analysis` recebem a sua). O `visit-score` filtra por classe ativada → shadow uniforme.
4. **Anti-dupla-contagem:** por call, se `sinais_ligacao` existe (extração pós-call), o conversor usa ELE e **ignora** `entities_extracted` ao-vivo daquela call (a pós-call é a fonte da verdade). Sem somar o mesmo sinal duas vezes.
5. **Config de ativação** = tabela `sinal_classe_config (classe text pk, ativado bool default false)`. Começa tudo `false` (shadow total). Ativar = `UPDATE ... ativado=true` (Fase C). Sem deploy de código por etapa.

---

## File Structure

| Arquivo | Resp. | Ação |
|---|---|---|
| `supabase/migrations/<ts>_fatia2_sinais_ligacao.sql` | coluna `sinais_ligacao` + trigger de enqueue + tabela `sinal_classe_config` (seed off) | criar |
| `src/lib/sinais/converter.ts` | regra pura: 4 sinais → `SignalModifier[]` (contrato estrito de preço, class). Oráculo do conversor da edge. | criar |
| `src/lib/sinais/__tests__/converter.test.ts` | testes vitest | criar |
| `src/lib/sinais/schema.ts` | tipos `SinaisLigacao`/`SinalModifierClasse` compartilhados (front + oráculo) | criar |
| `supabase/functions/extrair-sinais-ligacao/index.ts` | edge: transcript → Claude forced-tool-use → grava `sinais_ligacao` (envelope) | criar |
| `supabase/functions/scoring-recalc-client/index.ts` | + lê `sinais_ligacao`, replica o converter inline, carimba `class` nos modifiers legados | modificar |
| `supabase/functions/visit-score-recalc-client/index.ts` | filtra `breakdown[dim]` por classe ativada (lookup `sinal_classe_config`) | modificar |
| `src/contexts/WebRTCCallContext.tsx` | após INSERT da call, dispara `extrair-sinais-ligacao` (fire-and-forget) com o `id` retornado | modificar |

**Constante compartilhada:** os pesos do contrato de preço e os deltas por classe vivem em `src/lib/sinais/converter.ts` (oráculo vitest); a edge `scoring-recalc-client` (Deno) **replica inline** (mesma lição da Fase 1: front e edge não compartilham módulo).

---

# FASE A — Construir o cérebro (tudo em shadow/off, construível e testável AGORA)

## Task 1: Migration — coluna `sinais_ligacao` + trigger de enqueue + config de classes

**Files:** Create `supabase/migrations/<timestamp>_fatia2_sinais_ligacao.sql` (timestamp via `lovable-db-operator`, > a última migration)

- [ ] **Step 1: Escrever a migration (idempotente)**

```sql
-- ============================================================
-- Fatia 2 — captura inteligente: coluna de sinais pós-call + enqueue + config
-- ============================================================

-- 1. Coluna dedicada (envelope com audit metadata; 1 writer = edge extrair-sinais-ligacao)
ALTER TABLE public.farmer_calls
  ADD COLUMN IF NOT EXISTS sinais_ligacao jsonb;

COMMENT ON COLUMN public.farmer_calls.sinais_ligacao IS
  'Envelope pós-call: { schema_version, extractor_model, prompt_version, source_transcript_hash, extracted_at, status, error, sinais: { precos[], marcas_em_uso[], produtos_gap[], demandas_novas[], houve_sinal } }. 1 writer = edge extrair-sinais-ligacao.';

-- 2. Índice parcial p/ a varredura (calls com transcript e sem extração válida)
CREATE INDEX IF NOT EXISTS idx_farmer_calls_sinais_pendentes
  ON public.farmer_calls (started_at)
  WHERE sinais_ligacao IS NULL;

-- 3. Trigger que enfileira recalc quando sinais_ligacao é gravado (espelha o de entities_extracted).
--    Reusa a fila score_recalc_queue existente.
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_event_id)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'sinais_extraidos', NEW.id)
    ON CONFLICT DO NOTHING;  -- dedup pendentes (índice parcial existente)
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_farmer_calls_enqueue_recalc_sinais ON public.farmer_calls;
CREATE TRIGGER trg_farmer_calls_enqueue_recalc_sinais
  AFTER INSERT OR UPDATE OF sinais_ligacao ON public.farmer_calls
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_score_recalc_from_sinais();

-- 4. Config de ativação por classe (shadow-mode: começa tudo off)
CREATE TABLE IF NOT EXISTS public.sinal_classe_config (
  classe text PRIMARY KEY,
  ativado boolean NOT NULL DEFAULT false,
  ativado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.sinal_classe_config (classe) VALUES ('preco'), ('marca'), ('demanda')
  ON CONFLICT (classe) DO NOTHING;

ALTER TABLE public.sinal_classe_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sinal_classe_config_select_staff" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_select_staff" ON public.sinal_classe_config FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()
                 AND role IN ('employee'::public.app_role,'master'::public.app_role)));
DROP POLICY IF EXISTS "sinal_classe_config_master_all" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_master_all" ON public.sinal_classe_config FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role='master'::public.app_role))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role='master'::public.app_role));
DROP POLICY IF EXISTS "sinal_classe_config_service_all" ON public.sinal_classe_config;
CREATE POLICY "sinal_classe_config_service_all" ON public.sinal_classe_config FOR ALL
  USING (auth.role() = 'service_role');
```

- [ ] **Step 2: Validação pós-apply (read-only, cola junto)**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_name='farmer_calls' AND column_name='sinais_ligacao') AS col,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_farmer_calls_enqueue_recalc_sinais') AS trg,
  (SELECT count(*) FROM public.sinal_classe_config) AS classes,
  (SELECT count(*) FROM public.sinal_classe_config WHERE ativado) AS ativadas;
-- Esperado: col=1, trg=1, classes=3, ativadas=0 (shadow total).
```

- [ ] **Step 3:** `bun run audit:migrations` (regenera o audit) + commit (migration + audit files).
- [ ] **Step 4: PROVE-SQL.** O trigger é money-path-adjacent (enfileira recalc que muda score). Antes do apply, rodar **`prove-sql-money-path`**: PG17 local, semear farmer_calls, gravar sinais_ligacao com status='extraido', asserir que enfileirou em score_recalc_queue exatamente 1×; falsificar (status≠'extraido' → NÃO enfileira). > `lovable-db-operator` empacota o handoff manual.

---

## Task 2: Helper puro — conversor dos 4 sinais → `SignalModifier[]` (TDD, o oráculo money-path)

**Files:** Create `src/lib/sinais/schema.ts`, `src/lib/sinais/converter.ts`, `src/lib/sinais/__tests__/converter.test.ts`

Este é o **coração money-path** e o único componente testável de ponta a ponta antes do piloto. Aplica o **contrato estrito de preço** (Codex): preço só vira modifier com produto+valor+moeda+unidade+`speaker_is_customer` e confiança ≥ threshold; senão é inteligência crua (não pontua).

- [ ] **Step 1: Tipos** (`schema.ts`)

```ts
export type ClasseSinal = 'preco' | 'marca' | 'demanda';
export const PROB_MIN = 0.6; // threshold de confiança p/ pontuar (calibrável no piloto)

export interface Preco { tipo: 'cliente_paga' | 'concorrente_cobra'; produto: string | null; valor: number | null;
  moeda: string | null; unidade_base: string | null; concorrente: string | null; speaker_is_customer: boolean;
  confianca: number; evidencia: string; }
export interface MarcaEmUso { marca: string; produto: string | null; e_concorrente: boolean | null;
  speaker_is_customer: boolean; confianca: number; evidencia: string; }
export interface ProdutoGap { descricao: string; familia: string | null; material: string | null;
  dimensao: string | null; recorrente: boolean | null; confianca: number; evidencia: string; }
export interface DemandaNova { descricao: string; contexto: string | null; urgencia: string | null;
  recorrente: boolean | null; confianca: number; evidencia: string; }
export interface SinaisLigacao { precos: Preco[]; marcas_em_uso: MarcaEmUso[]; produtos_gap: ProdutoGap[];
  demandas_novas: DemandaNova[]; houve_sinal: boolean; }

export interface ModifierBruto { dimension: 'churn' | 'expansion'; kind: string; delta: number;
  weight: number; reason: string; classe: ClasseSinal; }
```

- [ ] **Step 2: Escrever o teste falhando** (`converter.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { sinaisParaModifiers } from '../converter';
import type { SinaisLigacao } from '../schema';

const vazio: SinaisLigacao = { precos: [], marcas_em_uso: [], produtos_gap: [], demandas_novas: [], houve_sinal: false };

describe('sinaisParaModifiers — contrato estrito de preço', () => {
  it('concorrente mais barato COMPLETO (cliente falando) → churn, classe preco', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.9, evidencia: 'a Norton me cobra 1,20 a unidade' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'churn', classe: 'preco' });
    expect(mods[0].weight).toBeCloseTo(0.9);
  });

  it('preço SEM unidade comparável → NÃO pontua (inteligência crua)', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa', valor: null, moeda: null, unidade_base: null,
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.9, evidencia: 'a Norton é mais barata' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('preço dito pelo FARMER (não-cliente) → NÃO pontua', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: false, confianca: 0.9, evidencia: 'sei que a Norton cobra 1,20' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('confiança abaixo do threshold → NÃO pontua', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.4, evidencia: '...' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });
});

describe('sinaisParaModifiers — marca e demanda', () => {
  it('marca concorrente em uso (cliente) → churn, classe marca', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, marcas_em_uso: [{
      marca: 'Norton', produto: 'lixa', e_concorrente: true, speaker_is_customer: true, confianca: 0.8, evidencia: 'hoje uso Norton' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'churn', classe: 'marca' });
  });
  it('demanda nova (cliente) → expansion, classe demanda', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, demandas_novas: [{
      descricao: 'quer disco flap', contexto: null, urgencia: null, recorrente: null, confianca: 0.75, evidencia: 'preciso de disco flap' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'expansion', classe: 'demanda' });
  });
  it('produto-gap NÃO gera modifier (é compra, Fatia 3)', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, produtos_gap: [{
      descricao: 'verniz X', familia: null, material: null, dimensao: null, recorrente: null, confianca: 0.9, evidencia: '...' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });
  it('houve_sinal=false → [] (não fabrica)', () => {
    expect(sinaisParaModifiers(vazio)).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar** — `heavy bun run test src/lib/sinais` → FAIL (módulo inexistente).

- [ ] **Step 4: Implementar** (`converter.ts`)

```ts
import { PROB_MIN, type SinaisLigacao, type ModifierBruto } from './schema';

const DELTA_PRECO_CONCORRENTE = 20; // concorrente mais barato = risco de churn
const DELTA_MARCA_CONCORRENTE = 15; // espelha competitor_mentioned do scoring legado
const DELTA_DEMANDA_NOVA = 10;      // sinal de expansão

/** Converte os 4 sinais extraídos em modifiers de scoring, aplicando o contrato money-path.
 *  Oráculo puro — scoring-recalc-client (Deno) replica esta lógica inline. */
export function sinaisParaModifiers(s: SinaisLigacao): ModifierBruto[] {
  if (!s.houve_sinal) return [];
  const out: ModifierBruto[] = [];

  // PREÇO — contrato estrito: só pontua concorrente mais barato, dito pelo CLIENTE, com unidade comparável.
  for (const p of s.precos) {
    const comparavel = p.tipo === 'concorrente_cobra' && p.speaker_is_customer
      && p.produto != null && p.valor != null && p.moeda != null && p.unidade_base != null
      && p.confianca >= PROB_MIN;
    if (!comparavel) continue; // sem comparabilidade → inteligência crua (persistida), não pontua
    out.push({ dimension: 'churn', kind: 'preco_concorrente_menor', delta: DELTA_PRECO_CONCORRENTE,
      weight: p.confianca, reason: `Concorrente ${p.concorrente ?? '?'} cobra ${p.valor} ${p.moeda}/${p.unidade_base} em ${p.produto}`, classe: 'preco' });
  }

  // MARCA — concorrente em uso, dito pelo cliente.
  for (const m of s.marcas_em_uso) {
    if (!(m.e_concorrente && m.speaker_is_customer && m.confianca >= PROB_MIN)) continue;
    out.push({ dimension: 'churn', kind: 'marca_concorrente_em_uso', delta: DELTA_MARCA_CONCORRENTE,
      weight: m.confianca, reason: `Cliente usa ${m.marca}`, classe: 'marca' });
  }

  // DEMANDA NOVA — expansão.
  for (const d of s.demandas_novas) {
    if (d.confianca < PROB_MIN) continue;
    out.push({ dimension: 'expansion', kind: 'demanda_nova', delta: DELTA_DEMANDA_NOVA,
      weight: d.confianca, reason: `Demanda: ${d.descricao}`, classe: 'demanda' });
  }

  // PRODUTO-GAP — não pontua (consumo = Fatia 3). Persistido no envelope, fora daqui.
  return out;
}
```

- [ ] **Step 5: Rodar e ver passar** — `heavy bun run test src/lib/sinais` → PASS (todos).
- [ ] **Step 6: Commit** — `git commit -m "feat(fase2): conversor puro dos 4 sinais → modifiers (contrato estrito de preço, TDD)"`

---

## Task 3: Edge `extrair-sinais-ligacao` (Claude Sonnet 4.6, forced tool-use)

**Files:** Create `supabase/functions/extrair-sinais-ligacao/index.ts`. Molde: `supabase/functions/kb-extract-specs` (Anthropic SDK + forced tool-use + prompt caching).

Recebe `{ callId, transcript, customerUserId, farmerId }` (transcript vem no body → evita race de replicação do INSERT). Extrai os 4 sinais, monta o envelope (com `source_transcript_hash`, `prompt_version`, `extractor_model`, `status`), grava em `farmer_calls.sinais_ligacao`. Idempotente por hash+prompt_version.

- [ ] **Step 1: Implementar a edge** (estrutura completa; o SYSTEM_PROMPT v1 abaixo é o ponto de partida — **calibra no piloto**, não é placeholder)

```ts
import Anthropic from 'npm:@anthropic-ai/sdk@^0.93.0';
import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';

const PROMPT_VERSION = 'v1';
const SCHEMA_VERSION = 1;

const SYSTEM_PROMPT = `Você extrai sinais comerciais de uma transcrição de ligação de vendas (indústria de abrasivos/tintas, pt-BR).
Extraia SOMENTE o que está EXPLÍCITO na fala, com o trecho literal como evidência. Regras:
- Atribua cada sinal ao FALANTE: marque speaker_is_customer=true só se quem disse foi o CLIENTE (não a vendedora).
- Preço: capture valor + moeda + unidade_base (un/caixa/kg/metro). Se a unidade não ficar clara, deixe valor/unidade_base null (NÃO invente).
- Ignore preços/marcas em NEGAÇÃO ("não uso Norton") ou no PASSADO ("ano passado pagava").
- houve_sinal=false se a ligação não teve nenhum sinal comercial. Nunca fabrique.
Chame a tool extrair_sinais.`;

const TOOL = {
  name: 'extrair_sinais',
  description: 'Sinais comerciais estruturados da ligação.',
  input_schema: {
    type: 'object', additionalProperties: false,
    properties: {
      precos: { type: 'array', items: { type: 'object', properties: {
        tipo: { type: 'string', enum: ['cliente_paga', 'concorrente_cobra'] }, produto: { type: ['string','null'] },
        valor: { type: ['number','null'] }, moeda: { type: ['string','null'] }, unidade_base: { type: ['string','null'] },
        concorrente: { type: ['string','null'] }, speaker_is_customer: { type: 'boolean' },
        confianca: { type: 'number' }, evidencia: { type: 'string' } },
        required: ['tipo','speaker_is_customer','confianca','evidencia'] } },
      marcas_em_uso: { type: 'array', items: { type: 'object', properties: {
        marca: { type: 'string' }, produto: { type: ['string','null'] }, e_concorrente: { type: ['boolean','null'] },
        speaker_is_customer: { type: 'boolean' }, confianca: { type: 'number' }, evidencia: { type: 'string' } },
        required: ['marca','speaker_is_customer','confianca','evidencia'] } },
      produtos_gap: { type: 'array', items: { type: 'object', properties: {
        descricao: { type: 'string' }, familia: { type: ['string','null'] }, material: { type: ['string','null'] },
        dimensao: { type: ['string','null'] }, recorrente: { type: ['boolean','null'] },
        confianca: { type: 'number' }, evidencia: { type: 'string' } }, required: ['descricao','confianca','evidencia'] } },
      demandas_novas: { type: 'array', items: { type: 'object', properties: {
        descricao: { type: 'string' }, contexto: { type: ['string','null'] }, urgencia: { type: ['string','null'] },
        recorrente: { type: ['boolean','null'] }, confianca: { type: 'number' }, evidencia: { type: 'string' } },
        required: ['descricao','confianca','evidencia'] } },
      houve_sinal: { type: 'boolean' },
    }, required: ['precos','marcas_em_uso','produtos_gap','demandas_novas','houve_sinal'],
  },
} as const;

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY ausente' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const body = await req.json().catch(() => null);
  const { callId, transcript, customerUserId, farmerId } = body ?? {};
  if (!callId || !transcript) return new Response(JSON.stringify({ error: 'callId e transcript obrigatórios' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const transcriptText = typeof transcript === 'string' ? transcript : JSON.stringify(transcript);
  const hash = await sha256(transcriptText);

  // Idempotência por conteúdo: já extraído com este hash + prompt_version? pula.
  const { data: existente } = await admin.from('farmer_calls').select('sinais_ligacao').eq('id', callId).maybeSingle();
  const env = existente?.sinais_ligacao as Record<string, unknown> | null;
  if (env && env.status === 'extraido' && env.source_transcript_hash === hash && env.prompt_version === PROMPT_VERSION) {
    return new Response(JSON.stringify({ skipped: 'ja_extraido' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [TOOL as unknown as Anthropic.Tool], tool_choice: { type: 'tool', name: 'extrair_sinais' },
      messages: [{ role: 'user', content: `Transcrição:\n\n${transcriptText}` }],
    });
    const tu = resp.content.find((b) => b.type === 'tool_use');
    if (!tu || tu.type !== 'tool_use') throw new Error('sem tool_use na resposta');

    const envelope = {
      schema_version: SCHEMA_VERSION, extractor_model: 'claude-sonnet-4-6', prompt_version: PROMPT_VERSION,
      source_transcript_hash: hash, extracted_at: new Date().toISOString(), status: 'extraido', error: null,
      sinais: tu.input,
    };
    const { error: uErr } = await admin.from('farmer_calls').update({ sinais_ligacao: envelope }).eq('id', callId);
    if (uErr) throw uErr;
    return new Response(JSON.stringify({ ok: true, houve_sinal: (tu.input as { houve_sinal?: boolean }).houve_sinal }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'erro';
    // grava status=erro pra a varredura reprocessar (não trava o loop em silêncio)
    await admin.from('farmer_calls').update({ sinais_ligacao: { schema_version: SCHEMA_VERSION, prompt_version: PROMPT_VERSION, source_transcript_hash: hash, extracted_at: new Date().toISOString(), status: 'erro', error: msg } }).eq('id', callId);
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
```

- [ ] **Step 2: Verificação** — `deno check supabase/functions/extrair-sinais-ligacao/index.ts` (se deno disponível). Smoke test pós-deploy: `curl` com cron-secret + 1 transcript conhecido → confere envelope gravado (`status='extraido'`, `houve_sinal` coerente); rodar 2× → 2ª `{skipped:'ja_extraido'}`.
- [ ] **Step 3: Commit** — `git commit -m "feat(fase2): edge extrair-sinais-ligacao (Claude forced-tool-use → sinais_ligacao)"`

---

## Task 4: Estender `scoring-recalc-client` — ler `sinais_ligacao` + carimbar `class`

**Files:** Modify `supabase/functions/scoring-recalc-client/index.ts`

- [ ] **Step 1: Estender a query (linhas ~232-239)** — adicionar `sinais_ligacao` ao `.select(...)`:

```ts
.select('id, started_at, entities_extracted, analyses, sinais_ligacao')
```

- [ ] **Step 2: Replicar o conversor inline** (espelha `src/lib/sinais/converter.ts` — oráculo testado). Adicionar uma função `modifiersFromSinais(sinaisLigacao, meta)` que aplica o MESMO contrato estrito (preço comparável + speaker_is_customer + confiança ≥ 0.6; marca concorrente; demanda; produto-gap não pontua) e devolve modifiers com `class`. (Copiar a lógica da Task 2 em Deno.)

- [ ] **Step 3: Anti-dupla-contagem + carimbar class.** No loop sobre as calls (linhas ~252-268): se `call.sinais_ligacao?.status === 'extraido'`, gerar modifiers via `modifiersFromSinais` e **pular** `modifiersFromEntity/Analysis` daquela call (a pós-call é a fonte da verdade). Senão (legado), usar os conversores existentes — mas carimbar `class` neles (competitor→'marca', timeline/risk→'demanda', upsell→'preco'), pra o shadow filtrar uniforme.

- [ ] **Step 4: Verificação** — `deno check`. (O efeito real só aparece no visit-score após ativar classe — Fase C.) Confirmar que o upsert de `signal_modifiers` continua com o shape `ScoreAdjustment` (breakdown por dimension), agora com `class` em cada item.
- [ ] **Step 5: Commit** — `git commit -m "feat(fase2): scoring-recalc-client lê sinais_ligacao + carimba class (anti-dupla-contagem)"`

---

## Task 5: Shadow filter no `visit-score-recalc-client` (só aplica classe ativada)

**Files:** Modify `supabase/functions/visit-score-recalc-client/index.ts`

- [ ] **Step 1: Lookup das classes ativadas.** Onde a função lê os scores (linhas ~161-171), adicionar uma leitura de `sinal_classe_config WHERE ativado=true` → `Set<string>` `classesAtivas`. (Cachear por execução; é 1 query barata.)

- [ ] **Step 2: Filtrar o breakdown por classe ativada.** Nas funções `scoreRecuperacao`/`scoreExpansao`/etc. (linhas ~76-111), antes de `reduce`, filtrar `breakdown[dim]` mantendo só modifiers com `m.class` em `classesAtivas` (ou sem class = legado já-ligado, decidir: tratar como sempre-off por segurança → exigir class). Trecho:

```ts
const churnSignals = (c.signal_modifiers?.breakdown?.churn ?? [])
  .filter((m) => m.class != null && classesAtivas.has(m.class));
const signalsBoost = churnSignals.reduce((s, m) => s + m.delta * m.decayedWeight, 0) * 0.1;
```

- [ ] **Step 3: Verificação** — `deno check`. **Invariante crítico:** com `sinal_classe_config` tudo off (estado inicial), `classesAtivas` é vazio → `signalsBoost` sempre 0 → o visit-score NÃO muda vs. hoje. Confirmar isso (shadow total = zero efeito).
- [ ] **Step 4: Commit** — `git commit -m "feat(fase2): visit-score aplica só modifiers de classe ativada (shadow-mode)"`

---

## Task 6: Trigger no front — dispara extração ao fim da ligação

**Files:** Modify `src/contexts/WebRTCCallContext.tsx`

- [ ] **Step 1: Pegar o id do INSERT.** Na `persistCallSession` (linha ~76), trocar o insert por `.insert(payload).select('id').single()` pra obter `callId`.
- [ ] **Step 2: Disparar fire-and-forget após o insert bem-sucedido:**

```ts
const { data: inserted, error } = await supabase.from('farmer_calls').insert(payload as any).select('id').single();
if (error) { console.error('[WebRTC] insert farmer_calls falhou:', error); return; }
// Fire-and-forget: extração pós-call (não bloqueia o término da ligação)
void supabase.functions.invoke('extrair-sinais-ligacao', {
  body: { callId: inserted.id, transcript: payload.transcript, customerUserId, farmerId: user.id },
}).catch((e) => console.error('[WebRTC] dispatch extração falhou (varredura pega depois):', e));
```

(Se o dispatch falhar, a varredura cron — Task 7 — reprocessa: `sinais_ligacao IS NULL`.)

- [ ] **Step 3: Verificação** — `heavy bun run typecheck`. Visual: o término da ligação continua instantâneo (dispatch não bloqueia).
- [ ] **Step 4: Commit** — `git commit -m "feat(fase2): dispara extração de sinais ao fim da ligação (fire-and-forget)"`

---

## Task 7: Varredura (cron, rede de segurança) + rollout manual

**Files:** Create `supabase/functions/sinais-batch/index.ts` (varre calls sem extração) — opcional pro piloto, necessário pra produção.

- [ ] **Step 1: Edge de varredura** — pagina `farmer_calls` com `transcript` não-nulo e (`sinais_ligacao IS NULL OR sinais_ligacao->>'status'='erro'`), fan-out chamando `extrair-sinais-ligacao` (molde: `tactical-plans-batch` da Fatia 1). `x-cron-secret`. Concorrência baixa (LLM ~3-5s).
- [ ] **Step 2: Rollout (Lovable, NA ORDEM):**
  1. **Migration** (Task 1) no SQL Editor → validação `col=1, trg=1, classes=3, ativadas=0`.
  2. **Secret `ANTHROPIC_API_KEY`** no Supabase (se ainda não existir).
  3. **Deploy edges:** `extrair-sinais-ligacao`, `scoring-recalc-client` (estendida), `visit-score-recalc-client` (estendida), `sinais-batch`.
  4. **Smoke test** da extração (1 call conhecida) → envelope gravado; recalc enfileirado (`score_recalc_queue`).
  5. **Cron** da varredura com `timeout_milliseconds` explícito.
  6. **Publish** do front.
  7. **Confirmar shadow total:** `sinal_classe_config` tudo `ativado=false` → visit-score inalterado.
- [ ] **Step 3: Commit** — `git commit -m "feat(fase2): varredura sinais-batch + handoff de rollout"`

---

# FASE B — Piloto + eval (depende de ligação real; protocolo, não código)

Não liga nenhuma classe. Objetivo: medir precisão por sinal antes de qualquer efeito.

- [ ] **Guia de rotulação** escrito ANTES de ver resultados (o que conta como acerto por classe; preço com a barra mais alta).
- [ ] **1 farmer piloto** faz ~10-20 ligações reais (WebRTC, ou áudio via `elevenlabs-transcribe`). A extração roda (shadow).
- [ ] **Blind-review:** cada sinal extraído conferido contra o áudio/transcript; founder/farmer adjudica desacordos. "Citação certa + interpretação errada = falso positivo."
- [ ] **Métricas por classe** + **calibração de confiança** por faixa (0.6-0.7 / 0.7-0.85 / >0.85). Incluir calls negativas (`houve_sinal=false` tem que acertar).
- [ ] **Critério de corte** por classe definido antes (ex.: precisão ≥ X% em N calls frescas, não as usadas pra tunar o prompt).

# FASE C — Ativação por classe (vira flag, sem deploy de código)

Conforme cada classe passa o corte na Fase B, em calls **frescas**:
- [ ] `UPDATE sinal_classe_config SET ativado=true, ativado_em=now() WHERE classe='demanda';` (expansion — erro mais barato, **primeiro**).
- [ ] depois `'marca'` (contexto/churn).
- [ ] **por último** `'preco'` (churn numérico — erro caro). Monitorar a agenda após cada ativação (o nudge aparece via `visit-score`).

---

## Self-Review

- **Spec coverage:** §4.1 extração→T3; §4.2 conversor→T2/T4; §4.3 envelope/audit→T1/T3; §5 contrato estrito de preço→T2 (testado); §6 shadow→ativação por classe→T1(config)/T5(filtro)/Fase C; §7 trigger+enqueue→T1(trigger)/T6(front)/T7(varredura); §8 piloto→Fase B; §10 riscos→prove-sql(T1)+anti-dupla-contagem(T4)+shadow(T5); §11 rollout→T7. ✅
- **Placeholders:** o único ponto deliberadamente iterável é o `SYSTEM_PROMPT` v1 da edge (T3) — é prompt engineering money-path que se calibra com dados reais no piloto (Fase B), por design, não lacuna. Todo o resto (migration, conversor, filtro, trigger) tem código real.
- **Type consistency:** `ModifierBruto.classe`/`SignalModifier.class` (origem do sinal) ↔ `sinal_classe_config.classe` ↔ filtro do visit-score: mesmas 3 chaves `'preco'|'marca'|'demanda'`. `PROB_MIN=0.6` idêntico no oráculo (T2) e na réplica da edge (T4). Envelope `sinais_ligacao` (T3) ↔ leitura no conversor (T4) ↔ trigger checa `status='extraido'` (T1).
- **Risco aberto:** a réplica inline do conversor na edge (T4) pode divergir do oráculo (T2) — mitigado mantendo o oráculo como fonte e um smoke test que compara 1 caso real. O efeito money-path fica **gateado por shadow** (T5) até o piloto (Fase B), então uma divergência não vaza pra oferta antes da prova.

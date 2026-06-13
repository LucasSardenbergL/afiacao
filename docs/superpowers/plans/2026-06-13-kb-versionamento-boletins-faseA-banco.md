# KB Versionamento de Boletins — Fase A (banco, aditiva) — Plano

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: superpowers:subagent-driven-development. Steps usam checkbox (`- [ ]`).

**Goal:** capturar TODA aprovação de boletim como uma versão imutável (append-only) sem perder o histórico — aditivamente, sem tocar no vínculo/view/fila que estão em uso, e de quebra consertar o queue-thrash.

**Architecture:** ADITIVA (Fase A do spec §10). Mantém `kb_product_specs` como "atual" (ponteiro, como hoje); ADICIONA `kb_product_spec_versions` (append-only, identidade = `(supplier, product_code_normalized)`); toda aprovação passa por **1 RPC transacional** que grava a versão E atualiza a atual (single write path, sem drift); backfill dos ~297 como versão 1; a fila anti-junta por versão (conserta o queue-thrash). Master-only (consistente com 0c). Imutabilidade por trigger.

**Tech Stack:** Postgres/Supabase (RLS, SECURITY DEFINER, trigger, `has_role`), React/TS, vitest, PG17 local (`db/test-*.sh`).

**Spec:** `docs/superpowers/specs/2026-06-13-kb-versionamento-boletins-design.md` (Fase A = §10; o §4a/§6 descrevem o end-state Fase A2, follow-up).

---

## File Structure

- Create: `src/lib/knowledge-base/version-diff.ts` — `diffVersions(a, b)` (diff campo-a-campo) + `decidirChangeType(input)` (entrada → change_type). Puro.
- Create: `src/lib/knowledge-base/completude.ts` — `CAMPOS_IMPORTANTES` + `camposFaltantes(spec)` + `relatorioCompletude(specs)`. Puro.
- Create: `src/lib/knowledge-base/__tests__/version-diff.test.ts`, `.../completude.test.ts`.
- Create: `supabase/migrations/20260613150000_kb_spec_versions_faseA.sql` — tabela de versões + trigger + RPC `aprovar_versao_boletim` + backfill + RLS.
- Create: `db/test-kb-spec-versions.sh` — PG17 dentado.
- Modify: `src/hooks/useSaveProductSpecs.ts`, `src/hooks/useBulkApproveSpecs.ts` — passam a chamar a RPC.
- Modify: `src/hooks/useApprovalQueue.ts` — anti-join por `kb_product_spec_versions.source_document_id`.

---

## Task A1: Helpers puros (TDD)

**Files:** Create `src/lib/knowledge-base/version-diff.ts` + `completude.ts` + os 2 testes.

- [ ] **Step 1 — teste `version-diff.test.ts`** (escreve, roda, falha):

```ts
import { describe, it, expect } from 'vitest';
import { diffVersions, decidirChangeType } from '@/lib/knowledge-base/version-diff';

const base = { rendimento_m2_por_litro: 10, catalisador_codigo: 'FC.1', substrato: ['mdf'], demaos_recomendadas: 2, validade_dias: 365 };

describe('diffVersions', () => {
  it('changed: campo que mudou de valor', () => {
    const d = diffVersions({ ...base }, { ...base, catalisador_codigo: 'FC.2' });
    expect(d).toContainEqual({ campo: 'catalisador_codigo', de: 'FC.1', para: 'FC.2', tipo: 'changed' });
  });
  it('removed: campo que sumiu (virou null)', () => {
    const d = diffVersions({ ...base }, { ...base, catalisador_codigo: null });
    expect(d).toContainEqual({ campo: 'catalisador_codigo', de: 'FC.1', para: null, tipo: 'removed' });
  });
  it('added: campo que era null e ganhou valor', () => {
    const d = diffVersions({ ...base, diluente_codigo: null }, { ...base, diluente_codigo: 'DF.1' });
    expect(d).toContainEqual({ campo: 'diluente_codigo', de: null, para: 'DF.1', tipo: 'added' });
  });
  it('array: compara por conteúdo (ordem-insensível)', () => {
    expect(diffVersions({ ...base, substrato: ['mdf','madeira'] }, { ...base, substrato: ['madeira','mdf'] })).toEqual([]);
  });
  it('sem mudança → []', () => { expect(diffVersions({ ...base }, { ...base })).toEqual([]); });
});

describe('decidirChangeType', () => {
  it('PDF novo (documento diferente) → bulletin_revision', () => {
    expect(decidirChangeType({ acao: 'novo_documento' })).toBe('bulletin_revision');
  });
  it('corrigir erro → correction', () => {
    expect(decidirChangeType({ acao: 'corrigir' })).toBe('correction');
  });
  it('completar dado faltante → data_completion', () => {
    expect(decidirChangeType({ acao: 'completar' })).toBe('data_completion');
  });
});
```

- [ ] **Step 2 — roda, confirma FAIL** (`bunx vitest run src/lib/knowledge-base/__tests__/version-diff.test.ts`).
- [ ] **Step 3 — implementa `version-diff.ts`:**

```ts
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

export type DiffTipo = 'added' | 'removed' | 'changed';
export interface CampoDiff { campo: string; de: unknown; para: unknown; tipo: DiffTipo; }

/** Campos técnicos comparáveis (espelha kb_product_specs; exclui metadata/audit). */
const CAMPOS_DIFF: (keyof KbExtractedSpec)[] = [
  'product_name','product_line','product_category','densidade_g_cm3','solidos_pct',
  'viscosidade_aplicacao_s','viscosidade_copo','brilho_ub','dureza','rendimento_m2_por_litro',
  'demaos_recomendadas','gramatura_g_m2_min','gramatura_g_m2_max','pot_life_horas',
  'temp_aplicacao_c_min','temp_aplicacao_c_max','umidade_aplicacao_pct_min','umidade_aplicacao_pct_max',
  'catalisador_codigo','catalisador_proporcao_pct','diluente_codigo','equipamentos_aplicacao',
  'lixa_recomendada','substrato','secagem_manuseio_h','secagem_empilhamento_h','secagem_total_h',
  'validade_dias','temp_armazenamento_c_min','temp_armazenamento_c_max','certificacoes_aplicaveis',
  'isento_metais_pesados','isento_substancias','diferenciais_chave','uso_recomendado','publico_alvo',
];

function vazio(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === '';
}
function igual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = [...a].map(String).sort(); const sb = [...b].map(String).sort();
    return sa.length === sb.length && sa.every((x, i) => x === sb[i]);
  }
  return a === b;
}

/** Diff campo-a-campo entre duas versões (a=anterior, b=atual). Arrays ordem-insensível. */
export function diffVersions(
  a: Partial<KbExtractedSpec>, b: Partial<KbExtractedSpec>,
): CampoDiff[] {
  const out: CampoDiff[] = [];
  for (const campo of CAMPOS_DIFF) {
    const de = a[campo]; const para = b[campo];
    if (igual(de, para)) continue;
    const tipo: DiffTipo = vazio(de) ? 'added' : vazio(para) ? 'removed' : 'changed';
    out.push({ campo, de: de ?? null, para: para ?? null, tipo });
  }
  return out;
}

export type AcaoVersao = 'novo_documento' | 'corrigir' | 'completar';
export function decidirChangeType(input: { acao: AcaoVersao }): 'bulletin_revision' | 'correction' | 'data_completion' {
  switch (input.acao) {
    case 'novo_documento': return 'bulletin_revision';
    case 'corrigir': return 'correction';
    case 'completar': return 'data_completion';
  }
}
```

- [ ] **Step 4 — teste `completude.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { camposFaltantes, relatorioCompletude, CAMPOS_IMPORTANTES } from '@/lib/knowledge-base/completude';

const cheio = Object.fromEntries(CAMPOS_IMPORTANTES.map((c) => [c, c.includes('substrato') ? ['mdf'] : 1]));

describe('camposFaltantes', () => {
  it('campo importante null → faltante', () => {
    expect(camposFaltantes({ ...cheio, catalisador_codigo: null, extraction_gaps: [] })).toContain('catalisador_codigo');
  });
  it('campo em extraction_gaps → faltante (mesmo não-null)', () => {
    expect(camposFaltantes({ ...cheio, extraction_gaps: ['validade_dias'] })).toContain('validade_dias');
  });
  it('array vazio → faltante', () => {
    expect(camposFaltantes({ ...cheio, substrato: [], extraction_gaps: [] })).toContain('substrato');
  });
  it('completo → []', () => {
    expect(camposFaltantes({ ...cheio, extraction_gaps: [] })).toEqual([]);
  });
});

describe('relatorioCompletude', () => {
  it('agrega por produto, ordena por nº de faltantes desc', () => {
    const r = relatorioCompletude([
      { product_code: 'A', product_name: 'A', ...cheio, catalisador_codigo: null, extraction_gaps: [] },
      { product_code: 'B', product_name: 'B', ...cheio, extraction_gaps: [] },
    ]);
    expect(r[0].product_code).toBe('A');
    expect(r[0].faltantes).toContain('catalisador_codigo');
    expect(r.find((x) => x.product_code === 'B')?.faltantes).toEqual([]);
  });
});
```

- [ ] **Step 5 — implementa `completude.ts`:**

```ts
import type { KbExtractedSpec } from '@/lib/knowledge-base/specs-types';

/** Campos que pesam na recomendação de venda — o que vale buscar com a fábrica. Ajustável. */
export const CAMPOS_IMPORTANTES = [
  'rendimento_m2_por_litro','catalisador_codigo','catalisador_proporcao_pct','demaos_recomendadas',
  'validade_dias','pot_life_horas','diluente_codigo','substrato','solidos_pct','dureza',
] as const;

function vazio(v: unknown): boolean {
  return v == null || (Array.isArray(v) && v.length === 0) || v === '';
}

/** Campos importantes vazios OU sinalizados em extraction_gaps. */
export function camposFaltantes(spec: Partial<KbExtractedSpec>): string[] {
  const gaps = new Set((spec.extraction_gaps ?? []) as string[]);
  return CAMPOS_IMPORTANTES.filter((c) => vazio(spec[c]) || gaps.has(c));
}

export interface CompletudeProduto { product_code: string; product_name: string; faltantes: string[]; }

/** Por produto, os campos importantes faltando — ordenado por nº de faltantes desc (mais incompletos primeiro). */
export function relatorioCompletude(
  specs: (Partial<KbExtractedSpec> & { product_code: string; product_name: string })[],
): CompletudeProduto[] {
  return specs
    .map((s) => ({ product_code: s.product_code, product_name: s.product_name, faltantes: camposFaltantes(s) }))
    .sort((a, b) => b.faltantes.length - a.faltantes.length);
}
```

- [ ] **Step 6 — roda os 2 testes (PASS):** `bunx vitest run src/lib/knowledge-base/__tests__/version-diff.test.ts src/lib/knowledge-base/__tests__/completude.test.ts`.
- [ ] **Step 7 — commit:** `git add src/lib/knowledge-base/version-diff.ts src/lib/knowledge-base/completude.ts src/lib/knowledge-base/__tests__/version-diff.test.ts src/lib/knowledge-base/__tests__/completude.test.ts && git commit -m "feat(kb): helpers versionamento — diffVersions + change_type + completude (TDD)"`

---

## Task A2: Migration (tabela de versões + trigger + RPC + backfill)

**Files:** Create `supabase/migrations/20260613150000_kb_spec_versions_faseA.sql`.

- [ ] **Step 1 — escrever a migration.** Estrutura (a lista dos ~40 campos técnicos é **idêntica** às colunas de `kb_product_specs` em `supabase/migrations/20260517180000_kb_specs_and_competitors.sql:4-68`, EXCETO `id/document_id/extracted_by/approved_by/approved_at/created_at/updated_at` — copiar verbatim de lá):

```sql
-- =========================================================================
-- KB Versionamento — Fase A (ADITIVA). ⚠️ MIGRATION MANUAL (SQL Editor).
-- Não toca kb_product_specs/omie_product_spec_links/view/fila. Só adiciona versões + RPC.
-- Spec: docs/superpowers/specs/2026-06-13-kb-versionamento-boletins-design.md §10.
-- =========================================================================

-- BLOCO A: tabela append-only de versões. Identidade estável = (supplier, product_code_normalized).
CREATE TABLE IF NOT EXISTS public.kb_product_spec_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier text NOT NULL,
  product_code_normalized text NOT NULL,
  product_code text NOT NULL,                       -- forma de exibição (da versão)
  kb_product_spec_id uuid,                           -- a linha "atual" no momento (conveniência)
  version_number int NOT NULL,
  source_document_id uuid REFERENCES public.kb_documents(id),
  change_type text NOT NULL CHECK (change_type IN ('initial','bulletin_revision','correction','data_completion')),
  change_note text,
  -- ↓↓↓ OS ~33 CAMPOS TÉCNICOS (copiar verbatim de kb_product_specs, sem os de audit/id):
  product_name text, product_line text, product_category text,
  densidade_g_cm3 numeric, solidos_pct numeric, viscosidade_aplicacao_s numeric, viscosidade_copo text,
  brilho_ub numeric, dureza text, rendimento_m2_por_litro numeric, demaos_recomendadas integer,
  gramatura_g_m2_min integer, gramatura_g_m2_max integer, pot_life_horas numeric,
  temp_aplicacao_c_min numeric, temp_aplicacao_c_max numeric, umidade_aplicacao_pct_min numeric, umidade_aplicacao_pct_max numeric,
  catalisador_codigo text, catalisador_proporcao_pct numeric, diluente_codigo text,
  equipamentos_aplicacao text[], lixa_recomendada text, substrato text[],
  secagem_manuseio_h numeric, secagem_empilhamento_h numeric, secagem_total_h numeric,
  validade_dias integer, temp_armazenamento_c_min integer, temp_armazenamento_c_max integer,
  certificacoes_aplicaveis text[], isento_metais_pesados text[], isento_substancias text[],
  diferenciais_chave text[], uso_recomendado text, publico_alvo text,
  extraction_confidence numeric, extraction_gaps text[],
  -- ↑↑↑
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_spec_versions_seq UNIQUE (supplier, product_code_normalized, version_number),
  -- CHECKs de não-negatividade (do 0c) — é onde os números agora vivem:
  CONSTRAINT kbv_rendimento_nonneg      CHECK (rendimento_m2_por_litro   IS NULL OR rendimento_m2_por_litro   >= 0),
  CONSTRAINT kbv_demaos_nonneg          CHECK (demaos_recomendadas       IS NULL OR demaos_recomendadas       >= 0),
  CONSTRAINT kbv_potlife_nonneg         CHECK (pot_life_horas            IS NULL OR pot_life_horas            >= 0),
  CONSTRAINT kbv_validade_nonneg        CHECK (validade_dias            IS NULL OR validade_dias            >= 0),
  CONSTRAINT kbv_catalisador_pct_nonneg CHECK (catalisador_proporcao_pct IS NULL OR catalisador_proporcao_pct >= 0)
);
CREATE INDEX IF NOT EXISTS idx_kbv_identidade ON public.kb_product_spec_versions (supplier, product_code_normalized, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_kbv_source_doc ON public.kb_product_spec_versions (source_document_id);

ALTER TABLE public.kb_product_spec_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kbv_select_staff ON public.kb_product_spec_versions;
CREATE POLICY kbv_select_staff ON public.kb_product_spec_versions FOR SELECT
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
-- escrita só via RPC DEFINER + service_role (sem policy de INSERT/UPDATE/DELETE p/ authenticated).

-- BLOCO B: imutabilidade — só superseded_at pode mudar numa versão já gravada.
CREATE OR REPLACE FUNCTION public.kbv_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'superseded_at' IS DISTINCT FROM to_jsonb(OLD) - 'superseded_at' THEN
    RAISE EXCEPTION 'kb_product_spec_versions é append-only: só superseded_at pode mudar';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
CREATE TRIGGER trg_kbv_immutable BEFORE UPDATE ON public.kb_product_spec_versions
  FOR EACH ROW EXECUTE FUNCTION public.kbv_block_mutation();

-- BLOCO C: RPC de aprovação — grava a versão E a "atual" (kb_product_specs) numa transação. Master-only.
-- p_payload = jsonb com os campos técnicos (+ product_code/name/supplier). p_change_type/p_change_note/p_document_id explícitos.
CREATE OR REPLACE FUNCTION public.aprovar_versao_boletim(
  p_payload jsonb, p_document_id uuid, p_change_type text, p_change_note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_supplier text := lower(btrim(coalesce(p_payload->>'supplier','sayerlack')));
  v_code text := coalesce(p_payload->>'product_code','');
  v_norm text := btrim(regexp_replace(upper(normalize(v_code,NFKC)),'\s+','','g'));
  v_next int; v_spec_id uuid; v_version_id uuid;
BEGIN
  IF NOT public.has_role(v_uid,'master'::app_role) THEN RAISE EXCEPTION 'forbidden: somente master'; END IF;
  IF v_norm = '' THEN RAISE EXCEPTION 'product_code obrigatório'; END IF;
  IF p_change_type NOT IN ('initial','bulletin_revision','correction','data_completion') THEN
    RAISE EXCEPTION 'change_type inválido: %', p_change_type; END IF;
  IF p_change_type IN ('correction','data_completion') AND coalesce(btrim(p_change_note),'')='' THEN
    RAISE EXCEPTION 'change_note obrigatória em correction/data_completion'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext(v_supplier||'|'||v_norm));   -- serializa version_number por produto

  -- 1) upsert da ATUAL em kb_product_specs (mesmo comportamento de hoje: master cura; approved_at server-side)
  INSERT INTO public.kb_product_specs AS s (
    document_id, product_code, product_name, supplier, /* …os ~33 campos técnicos do p_payload… */
    extracted_by, approved_by, approved_at
  )
  SELECT p_document_id, r.product_code, r.product_name, lower(btrim(coalesce(r.supplier,'sayerlack'))), /* r.* dos campos… */
         v_uid, v_uid, now()
  FROM jsonb_populate_record(null::public.kb_product_specs, p_payload) r
  ON CONFLICT (product_code) DO UPDATE SET
    document_id = excluded.document_id, product_name = excluded.product_name, supplier = excluded.supplier,
    /* …excluded.<cada campo técnico>… */ approved_by = v_uid, approved_at = now(), updated_at = now()
  RETURNING s.id INTO v_spec_id;

  -- 2) próxima versão + supersede da anterior + insert imutável
  SELECT coalesce(max(version_number),0)+1 INTO v_next
    FROM public.kb_product_spec_versions WHERE supplier=v_supplier AND product_code_normalized=v_norm;
  UPDATE public.kb_product_spec_versions SET superseded_at = now()
    WHERE supplier=v_supplier AND product_code_normalized=v_norm AND superseded_at IS NULL;
  INSERT INTO public.kb_product_spec_versions (
    supplier, product_code_normalized, product_code, kb_product_spec_id, version_number,
    source_document_id, change_type, change_note,
    product_name, /* …os ~33 campos técnicos do p_payload (mesma lista)… */ extraction_confidence, extraction_gaps,
    approved_by, approved_at
  )
  SELECT v_supplier, v_norm, r.product_code, v_spec_id, v_next,
         p_document_id, p_change_type, p_change_note,
         r.product_name, /* …r.<campos>… */ r.extraction_confidence, r.extraction_gaps,
         v_uid, now()
  FROM jsonb_populate_record(null::public.kb_product_spec_versions, p_payload) r
  RETURNING id INTO v_version_id;

  RETURN v_version_id;
END; $$;

REVOKE ALL ON FUNCTION public.aprovar_versao_boletim(jsonb,uuid,text,text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.aprovar_versao_boletim(jsonb,uuid,text,text) TO authenticated;

-- BLOCO D: backfill dos ~297 atuais como versão 1 ('initial'). Idempotente (só cria se não há versão p/ a identidade).
INSERT INTO public.kb_product_spec_versions (
  supplier, product_code_normalized, product_code, kb_product_spec_id, version_number,
  source_document_id, change_type, change_note,
  product_name, product_line, product_category, densidade_g_cm3, solidos_pct, viscosidade_aplicacao_s,
  viscosidade_copo, brilho_ub, dureza, rendimento_m2_por_litro, demaos_recomendadas, gramatura_g_m2_min,
  gramatura_g_m2_max, pot_life_horas, temp_aplicacao_c_min, temp_aplicacao_c_max, umidade_aplicacao_pct_min,
  umidade_aplicacao_pct_max, catalisador_codigo, catalisador_proporcao_pct, diluente_codigo,
  equipamentos_aplicacao, lixa_recomendada, substrato, secagem_manuseio_h, secagem_empilhamento_h, secagem_total_h,
  validade_dias, temp_armazenamento_c_min, temp_armazenamento_c_max, certificacoes_aplicaveis,
  isento_metais_pesados, isento_substancias, diferenciais_chave, uso_recomendado, publico_alvo,
  extraction_confidence, extraction_gaps, approved_by, approved_at
)
SELECT
  coalesce(lower(btrim(s.supplier)),'sayerlack'),
  btrim(regexp_replace(upper(normalize(coalesce(s.product_code,''),NFKC)),'\s+','','g')),
  s.product_code, s.id, 1, s.document_id, 'initial', NULL,
  s.product_name, s.product_line, s.product_category, s.densidade_g_cm3, s.solidos_pct, s.viscosidade_aplicacao_s,
  s.viscosidade_copo, s.brilho_ub, s.dureza, s.rendimento_m2_por_litro, s.demaos_recomendadas, s.gramatura_g_m2_min,
  s.gramatura_g_m2_max, s.pot_life_horas, s.temp_aplicacao_c_min, s.temp_aplicacao_c_max, s.umidade_aplicacao_pct_min,
  s.umidade_aplicacao_pct_max, s.catalisador_codigo, s.catalisador_proporcao_pct, s.diluente_codigo,
  s.equipamentos_aplicacao, s.lixa_recomendada, s.substrato, s.secagem_manuseio_h, s.secagem_empilhamento_h, s.secagem_total_h,
  s.validade_dias, s.temp_armazenamento_c_min, s.temp_armazenamento_c_max, s.certificacoes_aplicaveis,
  s.isento_metais_pesados, s.isento_substancias, s.diferenciais_chave, s.uso_recomendado, s.publico_alvo,
  s.extraction_confidence, s.extraction_gaps, s.approved_by, coalesce(s.approved_at, s.created_at)
FROM public.kb_product_specs s
WHERE s.approved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.kb_product_spec_versions v
    WHERE v.supplier = coalesce(lower(btrim(s.supplier)),'sayerlack')
      AND v.product_code_normalized = btrim(regexp_replace(upper(normalize(coalesce(s.product_code,''),NFKC)),'\s+','','g'))
  );
```

> ⚠️ Os `/* …campos… */` acima: o implementador EXPANDE com a lista verbatim de `kb_product_specs` (a mesma do backfill, que está completa) — não é placeholder, é a lista canônica copiada. O backfill (BLOCO D) já mostra a lista inteira.

- [ ] **Step 2 — commit** (`git add` a migration; mensagem `feat(kb): migration Fase A — kb_product_spec_versions + RPC + backfill`).

---

## Task A3: PG17 dentado + Codex adversarial

**Files:** Create `db/test-kb-spec-versions.sh` (modela em `db/test-kb-0c-aprovacao.sh` o bring-up + stubs + as migrations do KB + a nova).

- [ ] **Asserts (com falsificação):**
  - **V1** RPC grava versão 1 + a "atual" (kb_product_specs) numa chamada; retorno = version_id.
  - **V2** 2ª aprovação do MESMO produto → version_number=2, a v1 ganha `superseded_at`, só 1 versão "viva" (superseded_at NULL).
  - **V3** imutabilidade: `UPDATE` de um campo técnico de versão gravada → **rejeitado**; `UPDATE superseded_at` → OK. **Falsificação:** dropar o trigger → o UPDATE técnico passa (exige vermelho), restaura.
  - **V4** gate master: employee chamando a RPC → forbidden (sentinela SEM "forbidden"/"master").
  - **V5** change_note obrigatória em correction/data_completion.
  - **V6** version_number sequencial sob 2 chamadas seriais (advisory lock).
  - **V7** backfill: N linhas aprovadas em kb_product_specs → N versões 'initial' v1; re-rodar o backfill é idempotente (não duplica).
  - **V8** non-neg CHECK na tabela de versões.
- [ ] **Rodar** (`bash db/test-kb-spec-versions.sh > /tmp/v.log 2>&1; echo "EXIT=$?"`; NUNCA `| tail`). EXIT=0.
- [ ] **Codex adversarial** (xhigh, money-path) na migration + teste: `codex exec "<brief: revise 20260613150000 + db/test-kb-spec-versions.sh — money-path; furo de atomicidade/drift atual×versão, imutabilidade, advisory lock, backfill idempotente, gate>" -C "$(pwd)" -s read-only -c 'model_reasoning_effort="xhigh"' < /dev/null`. Folder P1/P2.
- [ ] **Commit** do teste.

---

## Task A4: Trocar os hooks pra a RPC + conserto da fila

**Files:** Modify `src/hooks/useSaveProductSpecs.ts`, `src/hooks/useBulkApproveSpecs.ts`, `src/hooks/useApprovalQueue.ts`.

- [ ] **`useSaveProductSpecs` / `useBulkApproveSpecs`:** trocam o `.upsert(payload, {onConflict:'product_code'})` por `.rpc('aprovar_versao_boletim', { p_payload: <specs+document_id sem os campos server>, p_document_id, p_change_type, p_change_note })`. O `p_change_type` vem do contexto: aprovação normal da fila → `'bulletin_revision'` (ou `'initial'` se for o 1º; a RPC resolve pela existência de versão — passar `'bulletin_revision'` e a RPC numera). Sem mudança de assinatura externa. Mantêm o invalidate das queries (+ `['kb-spec-versions']`).
- [ ] **`useApprovalQueue`:** o Passo 2 deixa de ler `kb_product_specs.document_id` e passa a ler **`kb_product_spec_versions.source_document_id`** (qualquer versão = documento já aprovado alguma vez → some da fila pra sempre = conserta o queue-thrash). Resto igual.
- [ ] **Gate `validate`** (`heavy bun run typecheck` · `heavy bun run test` · `bun lint`) — todos 0.
- [ ] **Commit.**

---

## Task A5: Registro + PR-A

- [ ] `bun run audit:migrations` (regenera o inventário). CLAUDE.md §10: entrada da Fase A (o que mudou, PG17, Codex, ⚠️ migration manual). 
- [ ] **PR** com body marcando **⚠️ migration manual** + o SQL inline (1 bloco) + a query de validação (`SELECT count(*) kb_product_spec_versions`, version_number sequencial, etc.). Auto-merge `--squash --auto`.
- [ ] **Pendências do founder no PR:** colar a `20260613150000` no SQL Editor (após confirmar que a extração parou um instante) + validar a contagem de versões == nº de specs aprovadas. **Sem deploy de edge.** (Front da Fase B virá com Publish.)

---

## Notas de execução
- **Fase B (front: histórico/diff + completude + UX de versão)** = plano separado, depois da Fase A no ar.
- A `aprovar_versao_boletim` é o **único** caminho de escrita de spec daqui pra frente (single source, sem drift atual×versão).
- O backfill é **idempotente** (NOT EXISTS por identidade) — seguro re-rodar.

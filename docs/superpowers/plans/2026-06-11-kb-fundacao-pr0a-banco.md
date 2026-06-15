# Fundação KB — PR-0a (motor de casamento, banco) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar o backend do casamento boletim↔item-de-venda — normalização de código, tabela de vínculo confirmado, view de leitura segura, e RPCs de sugestão (busca reversa) e confirmação — para que as pontas (venda/copilot) leiam uma fonte única confiável.

**Architecture:** Aditivo, não quebra o fluxo de specs existente. O helper TS (`code-normalize.ts`) faz a **busca reversa** reusando `src/lib/reposicao/sayerlack-sku.ts` (regra money-path 0/1/>1 já testada) — é a sugestão administrativa. O banco guarda o **vínculo confirmado** (`omie_product_spec_links`) e expõe `v_omie_product_current_spec` (só `confirmed` + `approved_at != NULL`). Runtime de venda lê só a view — nunca reconstrói identidade. Precisão > recall: ambiguidade ⇒ nenhuma ficha.

**Tech Stack:** Postgres (Supabase, migration manual via Lovable SQL Editor), plpgsql `SECURITY DEFINER` RPCs, TypeScript + vitest (helper puro), PG17 local (`db/verify-snapshot-replay.sh`) pra validar SQL por execução, Codex adversarial no SQL antes do apply.

**Escopo deste PR (e o que fica fora):** Entrega o motor de casamento (banco + helper). **Fora (vão pro PR do save / 0c):** o ajuste de `useSaveProductSpecs.onConflict`, a remoção da `UNIQUE(product_code)` global, e o fix de `useKbProductSpecs` não filtrar `approved_at` — ver §"Follow-ups". Aqui a `UNIQUE(supplier, product_code_normalized)` é **adicional** (a global é mantida; base vazia ⇒ sem conflito prático).

---

## File Structure

- **Create** `src/lib/knowledge-base/code-normalize.ts` — `normalizeProductCode`, `montarTermosBusca`, `refinarCandidatos` (busca reversa client-side). Reusa `extrairCodigosSayerlack`/`norm` de `sayerlack-sku.ts`.
- **Create** `src/lib/knowledge-base/__tests__/code-normalize.test.ts` — vitest.
- **Create** `supabase/migrations/20260611140000_kb_fundacao_casamento.sql` — coluna+trigger, constraint composta, tabela de links, view, RPCs.
- **Create** `db/test-kb-fundacao-casamento.sh` — validação PG17 por execução.
- **Modify** `CLAUDE.md` — registrar a feature/migration manual (no commit final).

---

## Task 1: Helper `normalizeProductCode` (identidade do código)

**Files:**
- Create: `src/lib/knowledge-base/code-normalize.ts`
- Test: `src/lib/knowledge-base/__tests__/code-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/knowledge-base/__tests__/code-normalize.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeProductCode } from '../code-normalize';

describe('normalizeProductCode', () => {
  it('uppercases, trims e remove espaços internos, preserva pontos/sufixo', () => {
    expect(normalizeProductCode('  fo20.6827.00 ')).toBe('FO20.6827.00');
    expect(normalizeProductCode('TEH 3505.211FG')).toBe('TEH3505.211FG'); // espaço removido (NÃO vira ponto aqui)
    expect(normalizeProductCode('fc.6952')).toBe('FC.6952');
  });
  it('mantém GL/QT/LT/.00 (são identidade, não removidos)', () => {
    expect(normalizeProductCode('FO20.6827.00GL')).toBe('FO20.6827.00GL');
  });
  it('vazio/nulo → string vazia', () => {
    expect(normalizeProductCode('')).toBe('');
    expect(normalizeProductCode(null)).toBe('');
    expect(normalizeProductCode(undefined)).toBe('');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL** (`bun run test src/lib/knowledge-base/__tests__/code-normalize.test.ts`) → "normalizeProductCode is not a function".

- [ ] **Step 3: Implement**

```ts
// src/lib/knowledge-base/code-normalize.ts
import { extrairCodigosSayerlack, sufixoSayerlack } from '@/lib/reposicao/sayerlack-sku';

/**
 * Normaliza o CÓDIGO de um boletim para a identidade canônica:
 * NFKC + upper + trim + remove espaços internos. Mantém pontos e sufixo de
 * embalagem (GL/QT/LT/.00) — são identidade, não ruído (decisão Codex 2026-06-11).
 * Espelhada no SQL (trigger product_code_normalized) — manter as duas em sincronia.
 */
export function normalizeProductCode(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFKC').toUpperCase().replace(/\s+/g, '').trim();
}
```

- [ ] **Step 4: Run test — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge-base/code-normalize.ts src/lib/knowledge-base/__tests__/code-normalize.test.ts
git commit -m "feat(kb): normalizeProductCode — identidade canônica do código do boletim"
```

---

## Task 2: Helper de busca reversa (`montarTermosBusca` + `refinarCandidatos`)

A sugestão tem 2 partes: (a) `montarTermosBusca(codigo)` gera os termos `LIKE` pro pré-filtro SQL (código inteiro + miolo numérico, cobrindo a variante espaço↔ponto); (b) `refinarCandidatos(codigoBoletim, candidatos)` aplica match-exato-por-token reusando `extrairCodigosSayerlack` e marca ambiguidade.

**Files:**
- Modify: `src/lib/knowledge-base/code-normalize.ts`
- Modify: `src/lib/knowledge-base/__tests__/code-normalize.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// adicionar ao code-normalize.test.ts
import { baseDoCodigo, montarTermosBusca, refinarCandidatos } from '../code-normalize';

// ⚠️ SEMÂNTICA (corrigida pelo TDD): o product_code do boletim é a BASE da fórmula
// (FO20.6827.00); os itens Omie são EMBALAGENS com o sufixo colado (FO20.6827.00GL,
// WFOT.6529QT). O extrator Sayerlack SÓ pega código com sufixo de letra colado. Logo o
// match é base↔base (1 boletim → N embalagens), preservando o número da fórmula.

describe('baseDoCodigo', () => {
  it('remove o sufixo de embalagem (QT/GL/FG) mas mantém o número da fórmula', () => {
    expect(baseDoCodigo('FO20.6827.00GL')).toBe('FO20.6827.00');
    expect(baseDoCodigo('WFOT.6529QT')).toBe('WFOT.6529');
    expect(baseDoCodigo('FO20.6827.00')).toBe('FO20.6827.00'); // já é base (sem sufixo de letra)
  });
});

describe('montarTermosBusca', () => {
  it('inclui o código, a base e o miolo numérico estável', () => {
    const termos = montarTermosBusca('FO20.6827.00');
    expect(termos).toContain('FO20.6827.00');
    expect(termos).toContain('6827'); // miolo: casa descrição mesmo com separador diferente
  });
  it('código sem miolo numérico → só o código', () => {
    expect(montarTermosBusca('ABC')).toEqual(['ABC']);
  });
});

describe('refinarCandidatos (match por BASE da fórmula — 1 boletim → N embalagens)', () => {
  const cand = (omie_codigo_produto: number, descricao: string, account = 'oben') =>
    ({ account, omie_codigo_produto, codigo: 'PRD', descricao });

  it('boletim (base) casa a embalagem (mesma base, sufixo colado) na descrição', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(1, 'VERNIZ PU FO20.6827.00GL')]);
    expect(r).toHaveLength(1);
    expect(r[0].match).toBe('exato');
    expect(r[0].ambiguo).toBe(false);
  });
  it('NÃO casa fórmula diferente (o número distinto é preservado na base)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(2, 'VERNIZ PU FO20.6828.00GL')]);
    expect(r[0].match).toBe('fraco');
  });
  it('catalisador citado SEM embalagem não é extraído → não polui nem cria ambiguidade', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(3, 'VERNIZ FO20.6827.00GL c/ FC.6952')]);
    expect(r[0].match).toBe('exato');
    expect(r[0].ambiguo).toBe(false);
  });
  it('descrição com 2 fórmulas DISTINTAS embaladas → ambíguo (triagem humana)', () => {
    const r = refinarCandidatos('FO20.6827.00', [cand(4, 'KIT FO20.6827.00GL WP12.3900QT')]);
    expect(r[0].ambiguo).toBe(true);
  });
  it('casa a variante separador-espaço do tingidor (extrator normaliza espaço→ponto)', () => {
    const r = refinarCandidatos('TEH.3505.211FG', [cand(5, 'TINGIDOR TEH 3505.211FG')]);
    expect(r[0].match).toBe('exato');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (funções não existem).

- [ ] **Step 3: Implement (append em `code-normalize.ts`)**

```ts
export interface SkuCandidato {
  account: string;
  omie_codigo_produto: number;
  codigo: string;
  descricao: string;
}

export interface CandidatoRefinado extends SkuCandidato {
  match: 'exato' | 'fraco';      // 'exato' = a BASE do boletim ∈ bases dos códigos da descrição
  ambiguo: boolean;              // descrição tem >1 BASE distinta → exige escolha humana
  codigosNaDescricao: string[];
}

/** Base da fórmula = código sem o sufixo de EMBALAGEM (QT/GL/LT/FG/L5...). O sufixo é a
 *  embalagem (1 fórmula → N embalagens); o número (.NNNN.NN) identifica a fórmula e é
 *  preservado. FO20.6827.00GL → FO20.6827.00 ; FO20.6827.00 → FO20.6827.00. */
export function baseDoCodigo(codigo: string | null | undefined): string {
  const norm = normalizeProductCode(codigo);
  const suf = sufixoSayerlack(norm); // ([A-Z]{1,3}\d?)$ — só as letras finais
  return suf ? norm.slice(0, norm.length - suf.length) : norm;
}

/** Termos LIKE pro pré-filtro SQL: o código, a BASE (pega todas as embalagens) e o miolo
 *  numérico (3-4 díg) estável, que casa a descrição mesmo quando o separador difere. */
export function montarTermosBusca(codigo: string | null | undefined): string[] {
  const norm = normalizeProductCode(codigo);
  if (!norm) return [];
  const termos = new Set<string>([norm]);
  const base = baseDoCodigo(norm);
  if (base) termos.add(base); // base pega todas as embalagens quando o boletim vem com sufixo
  const miolo = norm.match(/\d{3,4}/)?.[0];
  if (miolo) termos.add(miolo);
  return [...termos];
}

/** Refina candidatos brutos do pré-filtro por BASE da fórmula (reusa o extrator Sayerlack,
 *  que exige o sufixo de embalagem colado e normaliza espaço→ponto) + marca ambiguidade.
 *  Decisão Codex: só 'exato' E não-ambíguo é auto-confirmável; o resto é triagem humana. */
export function refinarCandidatos(
  codigoBoletim: string | null | undefined,
  candidatos: SkuCandidato[],
): CandidatoRefinado[] {
  const alvoBase = baseDoCodigo(codigoBoletim);
  return candidatos.map((c) => {
    const codigos = extrairCodigosSayerlack(c.descricao).map(normalizeProductCode);
    const bases = [...new Set(codigos.map(baseDoCodigo))];
    return {
      ...c,
      codigosNaDescricao: codigos,
      match: alvoBase !== '' && bases.includes(alvoBase) ? 'exato' : 'fraco',
      ambiguo: bases.length > 1,
    };
  });
}
```

- [ ] **Step 4: Run — expect PASS**.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge-base/code-normalize.ts src/lib/knowledge-base/__tests__/code-normalize.test.ts
git commit -m "feat(kb): busca reversa client-side (montarTermosBusca + refinarCandidatos)"
```

---

## Task 3: Migration BLOCO A — coluna normalizada + trigger + constraint composta

**Files:**
- Create: `supabase/migrations/20260611140000_kb_fundacao_casamento.sql`

- [ ] **Step 1: Escrever o BLOCO A no arquivo de migration**

```sql
-- =========================================================================
-- Fundação KB — casamento boletim ↔ item de venda (PR-0a). ADITIVO.
-- ⚠️ MIGRATION MANUAL: colar no SQL Editor do Lovable (CLAUDE.md §5).
-- =========================================================================

-- BLOCO A: identidade do código do boletim
ALTER TABLE public.kb_product_specs
  ADD COLUMN IF NOT EXISTS product_code_normalized text;

-- Normalização (espelha src/lib/knowledge-base/code-normalize.ts):
-- upper + remove espaços + trim. Mantém pontos/sufixo. Supplier canonicalizado p/ lower.
CREATE OR REPLACE FUNCTION public.kb_specs_normalize() RETURNS trigger AS $$
BEGIN
  NEW.product_code_normalized :=
    btrim(upper(regexp_replace(coalesce(NEW.product_code, ''), '\s+', '', 'g')));
  NEW.supplier := lower(btrim(coalesce(NEW.supplier, 'sayerlack')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_kb_specs_normalize ON public.kb_product_specs;
CREATE TRIGGER trg_kb_specs_normalize
  BEFORE INSERT OR UPDATE OF product_code, supplier ON public.kb_product_specs
  FOR EACH ROW EXECUTE FUNCTION public.kb_specs_normalize();

-- Backfill (base vazia hoje → no-op; idempotente):
UPDATE public.kb_product_specs
  SET product_code_normalized = btrim(upper(regexp_replace(coalesce(product_code, ''), '\s+', '', 'g'))),
      supplier = lower(btrim(coalesce(supplier, 'sayerlack')))
  WHERE product_code_normalized IS DISTINCT FROM
        btrim(upper(regexp_replace(coalesce(product_code, ''), '\s+', '', 'g')));

-- Identidade composta ADICIONAL (a UNIQUE(product_code) global segue por ora;
-- remoção dela + ajuste do upsert = follow-up no PR do save):
ALTER TABLE public.kb_product_specs
  DROP CONSTRAINT IF EXISTS kb_product_specs_supplier_code_norm_key;
ALTER TABLE public.kb_product_specs
  ADD CONSTRAINT kb_product_specs_supplier_code_norm_key
  UNIQUE (supplier, product_code_normalized);
```

- [ ] **Step 2: Commit** (`git add supabase/migrations/20260611140000_kb_fundacao_casamento.sql && git commit -m "feat(kb): migration BLOCO A — normalização + identidade composta"`). Validação consolidada no Task 8 (PG17).

---

## Task 4: Migration BLOCO B — tabela de vínculo + RLS + índices

**Files:** Modify: `supabase/migrations/20260611140000_kb_fundacao_casamento.sql`

- [ ] **Step 1: Append BLOCO B**

```sql
-- BLOCO B: vínculo confirmado boletim ↔ SKU Omie (a chave Omie é COMPOSTA)
CREATE TABLE IF NOT EXISTS public.omie_product_spec_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  kb_product_spec_id uuid NOT NULL REFERENCES public.kb_product_specs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','rejected')),
  confirmed_by uuid REFERENCES auth.users(id),
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ≤1 spec CONFIRMADO ativo por SKU (account+codigo). Múltiplos 'rejected' permitidos.
CREATE UNIQUE INDEX IF NOT EXISTS omie_product_spec_links_one_confirmed
  ON public.omie_product_spec_links (account, omie_codigo_produto)
  WHERE status = 'confirmed';

-- Não duplicar o mesmo par (sku, spec) no mesmo status.
CREATE UNIQUE INDEX IF NOT EXISTS omie_product_spec_links_unique_triple
  ON public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status);

ALTER TABLE public.omie_product_spec_links ENABLE ROW LEVEL SECURITY;

-- Leitura: staff (employee/master). Escrita só via RPC SECURITY DEFINER (sem policy de write).
DROP POLICY IF EXISTS omie_product_spec_links_select_staff ON public.omie_product_spec_links;
CREATE POLICY omie_product_spec_links_select_staff
  ON public.omie_product_spec_links FOR SELECT
  USING (public.has_role(auth.uid(), 'employee'::app_role)
      OR public.has_role(auth.uid(), 'master'::app_role));
```

- [ ] **Step 2: Commit** (`git commit -am "feat(kb): migration BLOCO B — omie_product_spec_links + RLS"`).

---

## Task 5: Migration BLOCO C — view de leitura segura

**Files:** Modify: `supabase/migrations/20260611140000_kb_fundacao_casamento.sql`

- [ ] **Step 1: Append BLOCO C**

```sql
-- BLOCO C: fonte única que a venda/copilot leem. Dupla trava: confirmed + approved.
-- security_invoker=on → respeita a RLS staff de kb_product_specs.
CREATE OR REPLACE VIEW public.v_omie_product_current_spec
WITH (security_invoker = on) AS
SELECT
  l.account,
  l.omie_codigo_produto,
  l.kb_product_spec_id,
  s.product_code,
  s.product_name,
  s.supplier,
  s.product_category,
  s.rendimento_m2_por_litro,
  s.demaos_recomendadas,
  s.pot_life_horas,
  s.validade_dias,
  s.catalisador_codigo,
  s.catalisador_proporcao_pct,
  s.diluente_codigo,
  s.substrato,
  s.equipamentos_aplicacao,
  s.diferenciais_chave,
  s.uso_recomendado
FROM public.omie_product_spec_links l
JOIN public.kb_product_specs s ON s.id = l.kb_product_spec_id
WHERE l.status = 'confirmed'
  AND s.approved_at IS NOT NULL;
```

- [ ] **Step 2: Commit** (`git commit -am "feat(kb): migration BLOCO C — view v_omie_product_current_spec"`).

---

## Task 6: Migration BLOCO D — RPC de sugestão (busca reversa, pré-filtro)

**Files:** Modify: `supabase/migrations/20260611140000_kb_fundacao_casamento.sql`

- [ ] **Step 1: Append BLOCO D**

```sql
-- BLOCO D: pré-filtro server-side. Recebe termos (montados pelo client a partir do
-- código do boletim) e devolve SKUs cuja descrição casa QUALQUER termo. O REFINO
-- exato (token + ambiguidade) é client-side (refinarCandidatos). Staff-gated.
CREATE OR REPLACE FUNCTION public.buscar_skus_candidatos(p_termos text[])
RETURNS TABLE (account text, omie_codigo_produto bigint, codigo text, descricao text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee'::app_role)
       OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  IF p_termos IS NULL OR array_length(p_termos, 1) IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT op.account, op.omie_codigo_produto, op.codigo, op.descricao
  FROM public.omie_products op
  WHERE op.ativo IS NOT FALSE
    AND EXISTS (
      SELECT 1 FROM unnest(p_termos) t
      WHERE upper(op.descricao) LIKE '%' || upper(t) || '%'
    )
  ORDER BY op.account, op.descricao
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.buscar_skus_candidatos(text[]) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.buscar_skus_candidatos(text[]) TO authenticated;
```

- [ ] **Step 2: Commit** (`git commit -am "feat(kb): migration BLOCO D — RPC buscar_skus_candidatos (pré-filtro)"`).

---

## Task 7: Migration BLOCO E — RPCs de confirmação/rejeição (master-gated)

**Files:** Modify: `supabase/migrations/20260611140000_kb_fundacao_casamento.sql`

- [ ] **Step 1: Append BLOCO E**

```sql
-- BLOCO E: gravar o vínculo. Gate MASTER (founder cura a base — decisão V1-C).
-- Confirma N SKUs de embalagem (GL/LT/QT) numa chamada. confirmed_by = auth.uid().
CREATE OR REPLACE FUNCTION public.confirmar_vinculo_boletim(
  p_kb_product_spec_id uuid,
  p_skus jsonb            -- [{"account":"oben","omie_codigo_produto":123}, ...]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb;
  v_account text;
  v_cod bigint;
  v_count integer := 0;
  v_dono uuid;
BEGIN
  IF NOT public.has_role(v_uid, 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kb_product_specs WHERE id = p_kb_product_spec_id) THEN
    RAISE EXCEPTION 'spec inexistente';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_account := v_item->>'account';
    v_cod := (v_item->>'omie_codigo_produto')::bigint;

    -- SKU já confirmado p/ OUTRO spec → erro explícito (não rouba vínculo).
    SELECT kb_product_spec_id INTO v_dono FROM public.omie_product_spec_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> p_kb_product_spec_id THEN
      RAISE EXCEPTION 'SKU %/% já vinculado a outro boletim', v_account, v_cod;
    END IF;

    INSERT INTO public.omie_product_spec_links
      (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
    VALUES (v_account, v_cod, p_kb_product_spec_id, 'confirmed', v_uid)
    ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.rejeitar_sugestao(
  p_kb_product_spec_id uuid, p_account text, p_omie_codigo_produto bigint
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  INSERT INTO public.omie_product_spec_links
    (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
  VALUES (p_account, p_omie_codigo_produto, p_kb_product_spec_id, 'rejected', auth.uid())
  ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.confirmar_vinculo_boletim(uuid, jsonb) FROM anon, public;
REVOKE ALL ON FUNCTION public.rejeitar_sugestao(uuid, text, bigint) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.confirmar_vinculo_boletim(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rejeitar_sugestao(uuid, text, bigint) TO authenticated;
```

- [ ] **Step 2: Commit** (`git commit -am "feat(kb): migration BLOCO E — RPCs confirmar/rejeitar vínculo (master-gated)"`).

---

## Task 8: Validação PG17 por execução

**Files:** Create: `db/test-kb-fundacao-casamento.sh`

Modelo: `db/verify-snapshot-replay.sh` (Postgres 17 local + stubs). O snapshot pode estar stale — aplicar a foundation das tabelas KB (`20260517170000_kb_foundation.sql` + `20260517180000_kb_specs_and_competitors.sql`) + um stub mínimo de `omie_products`, `has_role`, `app_role`, `auth.uid()` antes da migration nova.

- [ ] **Step 1: Escrever o script de teste** com asserts que EXECUTAM (não só `CREATE`):

```sql
-- Núcleo dos asserts (dentro do harness PG17):
-- A1 identidade: dois INSERT (supplier,code) iguais → 2º falha (constraint composta).
-- A2 trigger: product_code='fo20.6827.00' → product_code_normalized='FO20.6827.00'.
-- A3 índice 1-confirmado: 2 links 'confirmed' no mesmo (account,cod) → 2º falha.
-- A4 view: link confirmed + spec approved → 1 linha; spec sem approved_at → 0 linhas.
-- A5 confirmar_vinculo_boletim: SKU já confirmado p/ outro spec → RAISE.
-- A6 gate: confirmar_vinculo como NÃO-master (set auth.uid p/ employee) → RAISE forbidden.
-- A7 buscar_skus_candidatos: termo '6827' acha 'VERNIZ ... FO20.6827.00 GL'; termo de
--    catalisador não traz o verniz.
-- A8 FALSIFICAÇÃO: sabotar o gate (trocar master→true incondicional) e exigir que A6 QUEBRE.
```

- [ ] **Step 2: Rodar** `heavy bash db/test-kb-fundacao-casamento.sh > /tmp/pg17-kb.log 2>&1; echo $?` (⚠️ NÃO usar `| tail` — engole exit; CLAUDE.md §2). Esperado: exit 0, todos os asserts OK.

- [ ] **Step 3: Provar o teste por falsificação** — sabotar 1 assert (ex. comentar o gate da A6), rodar, **exigir vermelho**; reverter. Confirma que o teste pega a saída errada (lição §10 do CLAUDE.md — teste negativo não pode ser teatro).

- [ ] **Step 4: Commit** (`git add db/test-kb-fundacao-casamento.sh && git commit -m "test(kb): PG17 do motor de casamento (8 asserts + falsificação)"`).

---

## Task 9: Codex adversarial no SQL (money-path)

- [ ] **Step 1: Rodar o Codex challenge no diff da migration** (founder pediu apoio do Codex; SQL money-path). Esforço **xhigh** explícito (adversarial money-path, CLAUDE.md §12):

```bash
timeout 900 codex exec "$(cat <<'EOF'
Revisão ADVERSARIAL (money-path) da migration supabase/migrations/20260611140000_kb_fundacao_casamento.sql.
Contexto em docs/superpowers/specs/2026-06-11-kb-conhecimento-venda-fundacao-design.md.
Procure: bypass de gate (RLS/RPC), índice parcial que não garante 1-ativo, view vazando
spec não-aprovado, RPC que rouba vínculo silenciosamente, injeção em buscar_skus_candidatos
(p_termos), search_path, REVOKE/GRANT faltando, trigger que diverge do helper TS
code-normalize.ts. Liste P1/P2 acionáveis.
EOF
)" -C "$(pwd)" -s read-only -c 'model_reasoning_effort="xhigh"' < /dev/null > /tmp/codex-kb-sql.out 2>&1; echo "EXIT $?"
```

- [ ] **Step 2: Ler `/tmp/codex-kb-sql.out`**, incorporar P1/P2 reais na migration + nos testes PG17, re-rodar Task 8. Se o Codex estiver esgotado (quota Plus), seguir Caminho B (auto-challenge + PG17 reforçado) e registrar.

- [ ] **Step 3: Commit** de quaisquer correções (`git commit -am "fix(kb): incorpora achados do Codex adversarial no SQL do casamento"`).

**Resultado da execução (2026-06-11):** o Codex **esgotou a cota do Plus** (janela rolante; volta 12/06 00:11) → **Caminho B**: revisão adversarial própria dos 8 pontos. **Sem P1.** 2 P2 incorporados (commit `4f87130e`): (a) **NFKC no trigger** (`normalize(x, NFKC)`) p/ paridade exata com o helper TS + backfill alinhado; (b) **escape de `%`/`_`/`\`** em `buscar_skus_candidatos(p_termos)` (`ESCAPE '\'`). PG17 estendido pra **10 asserts** (A9 NFKC `ﬀ`→`FF`, A10 `%`→0 linhas), todos verdes. P3 registrados (TOCTOU cai no `unique_violation` = seguro; `rejeitar_sugestao` sobre `confirmed` é cosmético, a view ignora `rejected`; supplier-lower é base-vazia/baixo risco). ⚠️ **Adversarial retroativo do Codex PENDENTE** (rodar quando a cota voltar — disciplina do CLAUDE.md §12).

---

## Task 10: Entrega da migration (Lovable) + registro

Usa a skill `lovable-db-operator` (ritual obrigatório do CLAUDE.md §5/§12).

- [ ] **Step 1: Invocar `lovable-db-operator`** pra empacotar: os 5 blocos (A–E) prontos pra colar no SQL Editor (1 bloco por mensagem, terminando em fence sozinha — preferência do founder §5) + a query de validação pós-apply (contagem de coluna/constraint/tabela/índice/view/4 funções) + a nota de PR "⚠️ migration manual necessária".

- [ ] **Step 2: Regenerar o audit** (`bun run audit:migrations`) e rodar `heavy bun run typecheck` + `heavy bun run test` + `bun lint` (gate `validate`). Redirecionar pra log e checar `echo $?` (não `| tail`).

- [ ] **Step 3: Atualizar `CLAUDE.md` §6/§10** com a entrada da Fundação KB (feature + migration manual pendente + o que é follow-up).

- [ ] **Step 4: Commit final + abrir PR**

```bash
git add -A
git commit -m "feat(kb): PR-0a — motor de casamento boletim↔venda (banco + helper)"
gh pr create --title "feat(kb): Fundação PR-0a — motor de casamento boletim↔item de venda" \
  --body "Sub-projeto 0 do programa de plugar boletins na venda/copilot. Spec: docs/superpowers/specs/2026-06-11-kb-conhecimento-venda-fundacao-design.md. ⚠️ MIGRATION MANUAL — ver corpo. Codex adversarial rodado no SQL."
```

---

## Self-Review (preenchido)

- **Spec coverage:** §4a identidade/normalized → T3; tabela links/índice → T4; view → T5; busca reversa (sugere) → T2+T6; confirmar/rejeitar → T7; precisão>recall (ambiguidade→nada) → T2 (`ambiguo`)+T5 (dupla trava); testes → T8; Codex → T9; entrega → T10. ✅
- **Fora de escopo (documentado):** fix do `onConflict`/remoção da `UNIQUE(product_code)`/`useKbProductSpecs` sem `approved_at` → §"Follow-ups" (PR do save/0c). Versionamento temporal + Sentinela → V2 (spec §10).
- **Type consistency:** `refinarCandidatos`/`CandidatoRefinado`/`montarTermosBusca`/`SkuCandidato` usados consistentes; SQL: `buscar_skus_candidatos(text[])`, `confirmar_vinculo_boletim(uuid,jsonb)`, `rejeitar_sugestao(uuid,text,bigint)` — assinaturas batem entre BLOCO D/E e os GRANTs e os asserts do T8. ✅
- **Placeholder scan:** sem TBD/TODO; todo step tem código/comando real. ✅

## Follow-ups (não neste PR)

1. **PR do save (0c):** trocar `useSaveProductSpecs.onConflict` p/ a constraint composta + remover `UNIQUE(product_code)` global + `useKbProductSpecs` filtrar `approved_at IS NOT NULL` (bug money-path) — a venda passa a ler **só** a view.
2. **V2:** versionamento temporal de specs + snapshot de versão no pedido; checks de Sentinela (SKU sem vínculo, ambíguos, descrição Omie alterada pós-confirmação).

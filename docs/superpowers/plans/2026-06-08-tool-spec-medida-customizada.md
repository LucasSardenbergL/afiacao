# Medida customizada ("Outros") nos dropdowns de spec de ferramenta — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que a equipe (staff) adicione uma medida nova num dropdown de especificação de ferramenta quando ela não estiver na lista, salvando-a no catálogo oficial para reaparecer em cadastros futuros.

**Architecture:** Uma RPC `SECURITY DEFINER` (gate staff, normaliza, dedupe case-insensitive, append atômico) é o único caminho de escrita em `tool_specifications.options` (a policy de escrita é dropada). Uma coluna `allow_custom_option` fecha campos de "faixa". O front (`AddToolDialog`) ganha um botão "Outro" separado (só para staff e campos elegíveis) que chama a RPC e sincroniza o estado local. Helper puro TS espelha a normalização; teste PG17 cobre a RPC.

**Tech Stack:** React 18 + TS (strict) + Supabase (Postgres 17) + vitest. Ritual Lovable: migration manual via SQL Editor + Publish do frontend.

**Spec:** [docs/superpowers/specs/2026-06-08-tool-spec-medida-customizada-design.md](../specs/2026-06-08-tool-spec-medida-customizada-design.md)

---

## Estrutura de arquivos

| Arquivo | Ação | Responsabilidade |
|---|---|---|
| `src/lib/tools/spec-option.ts` | Criar | Helper puro `normalizarOpcaoSpec` — oráculo da normalização (espelha o SQL) |
| `src/lib/tools/__tests__/spec-option.test.ts` | Criar | Testes vitest do helper |
| `supabase/migrations/20260608120000_tool_spec_custom_option.sql` | Criar | Coluna `allow_custom_option` + UPDATE de faixas + DROP da policy de escrita + RPC `adicionar_opcao_tool_spec` |
| `db/test-tool-spec-custom-option.sh` | Criar | Teste PG17 da migration/RPC (gate, normalização, dedupe, NULL, guards, limite, grants, concorrência) |
| `src/components/AddToolDialog.tsx` | Modificar | Botão "Outro" separado (staff + `allow_custom_option`), input inline, chamada da RPC, sync de estado, guard de resposta obsoleta, bloqueio do submit |

**Ordem:** Task 1 (helper) → Task 2 (migration+teste PG17) → Task 3 (front) → Task 4 (empacotar p/ Lovable + finalização). Task 3 depende do helper (Task 1) e da assinatura da RPC (Task 2).

---

## Task 1: Helper puro `normalizarOpcaoSpec`

**Files:**
- Create: `src/lib/tools/spec-option.ts`
- Test: `src/lib/tools/__tests__/spec-option.test.ts`

- [ ] **Step 1: Write the failing test**

Criar `src/lib/tools/__tests__/spec-option.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizarOpcaoSpec } from '@/lib/tools/spec-option';

describe('normalizarOpcaoSpec', () => {
  it('mantém medida válida', () => {
    expect(normalizarOpcaoSpec('290mm')).toBe('290mm');
  });

  it('faz trim e colapsa espaços internos', () => {
    expect(normalizarOpcaoSpec('  301   mm  ')).toBe('301 mm');
  });

  it('normaliza Unicode para NFC', () => {
    // 'e' + combining acute (U+0301) → 'é' (U+00E9)
    expect(normalizarOpcaoSpec('30́')).toBe('30́'.normalize('NFC'));
  });

  it('remove caracteres de controle', () => {
    expect(normalizarOpcaoSpec('29\u00070mm')).toBe('290mm');
  });

  it('retorna null para vazio ou só espaços', () => {
    expect(normalizarOpcaoSpec('')).toBeNull();
    expect(normalizarOpcaoSpec('   ')).toBeNull();
  });

  it('retorna null acima de 60 caracteres', () => {
    expect(normalizarOpcaoSpec('x'.repeat(60))).toBe('x'.repeat(60));
    expect(normalizarOpcaoSpec('x'.repeat(61))).toBeNull();
  });

  it('retorna null para valor reservado (qualquer caixa)', () => {
    expect(normalizarOpcaoSpec('__OUTROS__')).toBeNull();
    expect(normalizarOpcaoSpec('__outros__')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- src/lib/tools/__tests__/spec-option.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tools/spec-option"` (arquivo não existe).

- [ ] **Step 3: Write minimal implementation**

Criar `src/lib/tools/spec-option.ts`:

```ts
const MAX_LEN = 60;
const RESERVADOS = new Set(['__OUTROS__']);

/**
 * Normaliza uma medida digitada no "Outros" de um dropdown de especificação de
 * ferramenta. Espelha a normalização da RPC `adicionar_opcao_tool_spec`:
 * NFC + remove caracteres de controle + colapsa espaços + trim.
 * Retorna `null` se inválida (vazia, > 60 chars, ou valor reservado).
 *
 * Uso: validação otimista no front (feedback rápido). O valor canônico final
 * (após dedupe case-insensitive) é decidido pelo servidor, não aqui.
 */
export function normalizarOpcaoSpec(valor: string): string | null {
  if (valor == null) return null;
  // eslint-disable-next-line no-control-regex
  const semControle = valor.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '');
  const norm = semControle.replace(/\s+/g, ' ').trim();
  if (norm === '') return null;
  if (norm.length > MAX_LEN) return null;
  if (RESERVADOS.has(norm.toUpperCase())) return null;
  return norm;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- src/lib/tools/__tests__/spec-option.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tools/spec-option.ts src/lib/tools/__tests__/spec-option.test.ts
git commit -m "feat(tools): helper normalizarOpcaoSpec (oráculo da normalização do Outros)"
```

---

## Task 2: Migration (coluna + faixas + drop policy + RPC) com teste PG17

**Files:**
- Create: `supabase/migrations/20260608120000_tool_spec_custom_option.sql`
- Test: `db/test-tool-spec-custom-option.sh`

- [ ] **Step 1: Write the failing test (PG17)**

Criar `db/test-tool-spec-custom-option.sh` (executável). Auto-contido — cria stubs `auth.uid()`/`has_role()` controláveis por GUC, `tool_specifications` mínima, aplica a migration real e assere:

```bash
#!/usr/bin/env bash
# Teste PG17 da RPC adicionar_opcao_tool_spec (medida customizada "Outros").
# Auto-contido: stubs auth.uid()/has_role() por GUC, tool_specifications mínima,
# aplica a migration real e assere gate/normalização/dedupe/NULL/guards/limite/grants/concorrência.
# Base: db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5439
DATA="$(mktemp -d /tmp/pgtest-toolspec.XXXXXX)/data"
export LC_ALL=C LANG=C
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-toolspec.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres toolspec_verify
PSQL=("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d toolspec_verify)
P() { "${PSQL[@]}" "$@"; }

echo "→ fundação (stubs auth + enum + has_role + tool_specifications + seeds)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid
$f$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT current_setting('test.role', true) = _role::text
$f$;
DO $g$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
END $g$;
CREATE TABLE public.tool_specifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_category_id uuid,
  spec_key text NOT NULL,
  spec_label text NOT NULL,
  spec_type text NOT NULL DEFAULT 'select',
  options jsonb,
  is_required boolean DEFAULT true,
  display_order integer DEFAULT 0
);
ALTER TABLE public.tool_specifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read tool specifications" ON public.tool_specifications FOR SELECT USING (true);
CREATE POLICY "Only admins can manage specifications" ON public.tool_specifications
  FOR ALL USING (public.has_role(auth.uid(),'master'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(),'master'::public.app_role));
INSERT INTO public.tool_specifications (id, spec_key, spec_label, spec_type, options) VALUES
  ('11111111-1111-1111-1111-111111111111','diametro','Diâmetro','select','["300mm","250mm"]'::jsonb),
  ('22222222-2222-2222-2222-222222222222','comprimento','Comprimento','select','["de 120mm a 300mm","até 120mm"]'::jsonb),
  ('33333333-3333-3333-3333-333333333333','espessura','Espessura (mm)','number',NULL),
  ('44444444-4444-4444-4444-444444444444','marca','Marca','select',NULL);
SQL

echo "→ migration real…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260608120000_tool_spec_custom_option.sql" >/dev/null

echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT set_config('test.role','employee',false);
SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false);

DO $$
DECLARE r jsonb; opts jsonb;
BEGIN
  -- A) append no fim, valor_canonico
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290mm');
  IF r->>'valor_canonico' <> '290mm' THEN RAISE EXCEPTION 'A FALHOU: canonico=%', r->>'valor_canonico'; END IF;
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts <> '["300mm","250mm","290mm"]'::jsonb THEN RAISE EXCEPTION 'A FALHOU: options=%', opts; END IF;
  RAISE NOTICE 'OK A — append no fim';

  -- B) dedupe exato idempotente
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290mm');
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF jsonb_array_length(opts) <> 3 THEN RAISE EXCEPTION 'B FALHOU: duplicou len=%', jsonb_array_length(opts); END IF;
  RAISE NOTICE 'OK B — dedupe exato idempotente';

  -- C) dedupe case-insensitive → canônico do servidor é o existente
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','290MM');
  IF r->>'valor_canonico' <> '290mm' THEN RAISE EXCEPTION 'C FALHOU: canonico=%', r->>'valor_canonico'; END IF;
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF jsonb_array_length(opts) <> 3 THEN RAISE EXCEPTION 'C FALHOU: duplicou case len=%', jsonb_array_length(opts); END IF;
  RAISE NOTICE 'OK C — dedupe case-insensitive';

  -- D) normaliza espaços
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','  301   mm  ');
  IF r->>'valor_canonico' <> '301 mm' THEN RAISE EXCEPTION 'D FALHOU: [%]', r->>'valor_canonico'; END IF;
  RAISE NOTICE 'OK D — normaliza trim/espaços';
END $$;

-- E) NULL → RAISE 22004 + options intacto
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', NULL);
  RAISE EXCEPTION 'E FALHOU: aceitou NULL';
EXCEPTION WHEN sqlstate '22004' THEN RAISE NOTICE 'OK E — NULL rejeitado'; END $$;
DO $$ DECLARE opts jsonb; BEGIN
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts IS NULL THEN RAISE EXCEPTION 'E2 FALHOU: options corrompido p/ NULL'; END IF;
  RAISE NOTICE 'OK E2 — options intacto após NULL';
END $$;

-- F) vazio → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', '   ');
  RAISE EXCEPTION 'F FALHOU: aceitou vazio';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK F — vazio rejeitado'; END $$;

-- G) >60 → RAISE 22001
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', repeat('x',61));
  RAISE EXCEPTION 'G FALHOU: aceitou >60';
EXCEPTION WHEN sqlstate '22001' THEN RAISE NOTICE 'OK G — >60 rejeitado'; END $$;

-- H) reservado → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111', '__outros__');
  RAISE EXCEPTION 'H FALHOU: aceitou reservado';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK H — reservado rejeitado'; END $$;

-- I) spec_type number → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('33333333-3333-3333-3333-333333333333', '5mm');
  RAISE EXCEPTION 'I FALHOU: aceitou number';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK I — number rejeitado'; END $$;

-- J) faixa (allow_custom_option=false via UPDATE da migration) → RAISE 22023
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('22222222-2222-2222-2222-222222222222', '290mm');
  RAISE EXCEPTION 'J FALHOU: aceitou em faixa';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'OK J — faixa fechada pela migration'; END $$;

-- K) select sem options (marca) → COALESCE, 1ª opção entra
DO $$ DECLARE opts jsonb; BEGIN
  PERFORM public.adicionar_opcao_tool_spec('44444444-4444-4444-4444-444444444444','Freud');
  SELECT options INTO opts FROM public.tool_specifications WHERE id='44444444-4444-4444-4444-444444444444';
  IF opts <> '["Freud"]'::jsonb THEN RAISE EXCEPTION 'K FALHOU: options=%', opts; END IF;
  RAISE NOTICE 'OK K — options NULL → COALESCE';
END $$;

-- L) spec inexistente → RAISE P0002
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('99999999-9999-9999-9999-999999999999','x');
  RAISE EXCEPTION 'L FALHOU: aceitou inexistente';
EXCEPTION WHEN sqlstate 'P0002' THEN RAISE NOTICE 'OK L — inexistente rejeitada'; END $$;

-- M) gate: customer → RAISE 42501 e nada escrito
SELECT set_config('test.role','customer',false);
DO $$ BEGIN
  PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','999mm');
  RAISE EXCEPTION 'M FALHOU: customer adicionou';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'OK M — customer bloqueado'; END $$;
SELECT set_config('test.role','employee',false);
DO $$ DECLARE opts jsonb; BEGIN
  SELECT options INTO opts FROM public.tool_specifications WHERE id='11111111-1111-1111-1111-111111111111';
  IF opts @> '["999mm"]'::jsonb THEN RAISE EXCEPTION 'M2 FALHOU: customer escreveu'; END IF;
  RAISE NOTICE 'OK M2 — nada escrito pelo customer';
END $$;

-- N) master também passa
SELECT set_config('test.role','master',false);
DO $$ DECLARE r jsonb; BEGIN
  r := public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','310mm');
  IF r->>'valor_canonico' <> '310mm' THEN RAISE EXCEPTION 'N FALHOU'; END IF;
  RAISE NOTICE 'OK N — master adiciona';
END $$;

-- O) limite 200 → RAISE 54000
SELECT set_config('test.role','employee',false);
DO $$ DECLARE big jsonb; BEGIN
  SELECT jsonb_agg('opt'||g) INTO big FROM generate_series(1,200) g;
  UPDATE public.tool_specifications SET options=big WHERE id='11111111-1111-1111-1111-111111111111';
  BEGIN
    PERFORM public.adicionar_opcao_tool_spec('11111111-1111-1111-1111-111111111111','nova');
    RAISE EXCEPTION 'O FALHOU: passou do limite';
  EXCEPTION WHEN sqlstate '54000' THEN RAISE NOTICE 'OK O — limite 200 respeitado'; END;
END $$;

-- P) policy de escrita dropada
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tool_specifications'
            AND policyname='Only admins can manage specifications') THEN
    RAISE EXCEPTION 'P FALHOU: policy de escrita ainda existe';
  END IF;
  RAISE NOTICE 'OK P — policy de escrita dropada';
END $$;

-- Q) grants: authenticated EXECUTE sim, anon não
DO $$ BEGIN
  IF NOT has_function_privilege('authenticated','public.adicionar_opcao_tool_spec(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Q FALHOU: authenticated sem EXECUTE'; END IF;
  IF has_function_privilege('anon','public.adicionar_opcao_tool_spec(uuid,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Q2 FALHOU: anon tem EXECUTE'; END IF;
  RAISE NOTICE 'OK Q — grants corretos';
END $$;

SELECT 'ASSERTS SEQUENCIAIS OK ✓' AS resultado;
SQL

echo "→ concorrência: 10 inserts paralelos da MESMA medida → 1 entrada (prova FOR UPDATE)…"
seq 1 10 | xargs -P 10 -I{} "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d toolspec_verify -q -c \
  "SELECT set_config('test.role','employee',false); SELECT set_config('test.uid','00000000-0000-0000-0000-000000000001',false); SELECT public.adicionar_opcao_tool_spec('44444444-4444-4444-4444-444444444444','PARALELO');" >/dev/null 2>&1
CNT="$(P -tAc "SELECT count(*) FROM jsonb_array_elements_text((SELECT options FROM public.tool_specifications WHERE id='44444444-4444-4444-4444-444444444444')) e WHERE e='PARALELO';")"
[ "$CNT" = "1" ] || { echo "CONC FALHOU: PARALELO apareceu $CNT vezes (esperado 1)"; exit 1; }
echo "OK concorrência — 10 paralelos, 1 entrada"

echo ""
echo "✓ db/test-tool-spec-custom-option.sh — PASSOU"
```

Tornar executável: `chmod +x db/test-tool-spec-custom-option.sh`

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bash db/test-tool-spec-custom-option.sh; echo "EXIT=$?"`
Expected: FALHA na linha da migration — `could not open file ".../20260608120000_tool_spec_custom_option.sql"` (migration ainda não existe). `EXIT` ≠ 0.

- [ ] **Step 3: Write the migration**

Criar `supabase/migrations/20260608120000_tool_spec_custom_option.sql`:

```sql
-- Medida customizada ("Outros") nos dropdowns de especificação de ferramenta.
-- (a) coluna allow_custom_option (fecha campos de FAIXA, onde digitar medida pontual
--     não faz sentido); (b) drop da policy de escrita (canaliza toda escrita via API
--     pela RPC — zero callsites no app usam PATCH direto; master no SQL Editor é
--     service_role e ignora RLS); (c) RPC adicionar_opcao_tool_spec (gate staff,
--     normaliza NFC, dedupe case-insensitive, append atômico, retorna {options,valor_canonico}).
-- Ritual Lovable: aplicar manualmente no SQL Editor. Sem edge function.

-- (a) coluna
ALTER TABLE public.tool_specifications
  ADD COLUMN IF NOT EXISTS allow_custom_option boolean NOT NULL DEFAULT true;

-- fecha campos de FAIXA detectáveis (options tipo "de X a Y", "até X", "entre X e Y")
UPDATE public.tool_specifications
   SET allow_custom_option = false
 WHERE spec_type = 'select'
   AND options IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements_text(options) o
      WHERE o ILIKE 'de %a %' OR o ILIKE 'até %' OR o ILIKE 'entre %'
   );

-- (b) drop da policy de escrita (RPC vira único escritor via API)
DROP POLICY IF EXISTS "Only admins can manage specifications" ON public.tool_specifications;

-- (c) RPC
CREATE OR REPLACE FUNCTION public.adicionar_opcao_tool_spec(p_spec_id uuid, p_valor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_norm       text;
  v_options    jsonb;
  v_spec_type  text;
  v_allow      boolean;
  v_existente  text;
BEGIN
  -- gate staff (employee ou master)
  IF NOT (public.has_role(auth.uid(), 'master'::public.app_role)
          OR public.has_role(auth.uid(), 'employee'::public.app_role)) THEN
    RAISE EXCEPTION 'não autorizado' USING errcode = '42501';
  END IF;

  -- rejeita NULL (senão btrim/concat viram NULL e corrompem options)
  IF p_valor IS NULL THEN
    RAISE EXCEPTION 'valor obrigatório' USING errcode = '22004';
  END IF;

  -- normaliza: NFC + remove control chars + colapsa espaços + trim
  v_norm := regexp_replace(normalize(p_valor, NFC), '[[:cntrl:]]', '', 'g');
  v_norm := btrim(regexp_replace(v_norm, '\s+', ' ', 'g'));

  IF v_norm = '' THEN
    RAISE EXCEPTION 'valor vazio' USING errcode = '22023';
  END IF;
  IF length(v_norm) > 60 THEN
    RAISE EXCEPTION 'valor muito longo (máx 60)' USING errcode = '22001';
  END IF;
  IF upper(v_norm) = '__OUTROS__' THEN
    RAISE EXCEPTION 'valor reservado' USING errcode = '22023';
  END IF;

  -- lê com lock de linha
  SELECT options, spec_type, allow_custom_option
    INTO v_options, v_spec_type, v_allow
    FROM public.tool_specifications
   WHERE id = p_spec_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'especificação inexistente' USING errcode = 'P0002';
  END IF;
  IF v_spec_type <> 'select' THEN
    RAISE EXCEPTION 'este campo não é uma lista' USING errcode = '22023';
  END IF;
  IF v_allow IS NOT TRUE THEN
    RAISE EXCEPTION 'este campo não aceita medida nova' USING errcode = '22023';
  END IF;

  v_options := COALESCE(v_options, '[]'::jsonb);

  -- limite de quantidade (anti-inflar JSONB)
  IF jsonb_array_length(v_options) >= 200 THEN
    RAISE EXCEPTION 'limite de opções atingido' USING errcode = '54000';
  END IF;

  -- dedupe case-insensitive → devolve o canônico existente
  SELECT e INTO v_existente
    FROM jsonb_array_elements_text(v_options) e
   WHERE lower(e) = lower(v_norm)
   LIMIT 1;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('options', v_options, 'valor_canonico', v_existente);
  END IF;

  -- append atômico
  UPDATE public.tool_specifications
     SET options = v_options || jsonb_build_array(v_norm)
   WHERE id = p_spec_id
   RETURNING options INTO v_options;

  RETURN jsonb_build_object('options', v_options, 'valor_canonico', v_norm);
END;
$$;

REVOKE ALL    ON FUNCTION public.adicionar_opcao_tool_spec(uuid, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.adicionar_opcao_tool_spec(uuid, text) TO authenticated;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bash db/test-tool-spec-custom-option.sh; echo "EXIT=$?"`
Expected: imprime `OK A`..`OK Q`, `OK concorrência`, `✓ ... PASSOU`. `EXIT=0`.

> ⚠️ Não usar pipe `| tail` (engole o exit code — CLAUDE.md §2). Use `; echo "EXIT=$?"`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260608120000_tool_spec_custom_option.sql db/test-tool-spec-custom-option.sh
git commit -m "feat(tools): RPC adicionar_opcao_tool_spec + allow_custom_option + teste PG17"
```

---

## Task 3: Front — botão "Outro" no AddToolDialog

**Files:**
- Modify: `src/components/AddToolDialog.tsx`

> Sem teste unitário de componente (o projeto testa helpers puros; o `/browse` headless não renderiza a SPA — CLAUDE.md). Gate = `typecheck` + `lint` + `build`; verificação funcional é QA manual após Publish (Task 4).

- [ ] **Step 1: Imports e tipo**

No topo de `src/components/AddToolDialog.tsx`:
- L1: trocar `import { useState, useEffect, useMemo } from 'react';` por `import { useState, useEffect, useMemo, useRef } from 'react';`
- Após a linha do import de `ToolImageIdentifier` (L11), adicionar:
  ```ts
  import { normalizarOpcaoSpec } from '@/lib/tools/spec-option';
  ```
- Na interface `ToolSpecification` (L20-28), adicionar o campo:
  ```ts
    allow_custom_option: boolean | null;
  ```

- [ ] **Step 2: Ler `isStaff` e novo estado**

- L39: trocar `const { user } = useAuth();` por `const { user, isStaff } = useAuth();`
- Após o estado `searchQuery` (L48), adicionar:
  ```ts
  const [addingForId, setAddingForId] = useState<string | null>(null);
  const [novoValor, setNovoValor] = useState('');
  const [savingOption, setSavingOption] = useState(false);
  const reqIdRef = useRef(0);
  ```

- [ ] **Step 3: Reset do estado novo ao fechar e ao carregar specs**

- No `useEffect` de reset (L51-60, bloco `if (!open)`), adicionar antes do fecha-chave:
  ```ts
      setAddingForId(null);
      setNovoValor('');
      setSavingOption(false);
  ```
- No início de `loadSpecifications` (logo após `setIsLoadingSpecs(true);`, L79), adicionar:
  ```ts
    setAddingForId(null);
    setNovoValor('');
  ```

- [ ] **Step 4: Ler `allow_custom_option` no map de specs**

No `loadSpecifications`, no `.map(spec => ({ ... }))` (L90-93), adicionar a propriedade ao objeto (junto de `options`):
```ts
      const specs = (data || []).map(spec => ({
        ...spec,
        options: spec.options ? (Array.isArray(spec.options) ? spec.options : JSON.parse(spec.options as string)) : null,
        allow_custom_option: (spec as { allow_custom_option?: boolean | null }).allow_custom_option ?? true,
      }));
```

- [ ] **Step 5: Handler `handleSaveOption`**

Adicionar antes de `const handleSubmit` (L160):
```ts
  const handleSaveOption = async (spec: ToolSpecification) => {
    const norm = normalizarOpcaoSpec(novoValor);
    if (!norm) {
      toast.error('Medida inválida', { description: 'Digite um valor válido (até 60 caracteres).' });
      return;
    }
    const myReq = ++reqIdRef.current;
    const reqCategoria = selectedCategory;
    setSavingOption(true);
    try {
      const { data, error } = await supabase
        .rpc('adicionar_opcao_tool_spec' as never, { p_spec_id: spec.id, p_valor: novoValor } as never);
      if (error) throw error;
      // descarta resposta obsoleta (trocou de categoria/spec no meio)
      if (myReq !== reqIdRef.current || reqCategoria !== selectedCategory) return;
      const resp = data as { options: string[]; valor_canonico: string } | null;
      if (!resp) throw new Error('Resposta vazia do servidor');
      setSpecifications(prev => prev.map(s => (s.id === spec.id ? { ...s, options: resp.options } : s)));
      setSpecValues(prev => ({ ...prev, [spec.spec_key]: resp.valor_canonico }));
      setAddingForId(null);
      setNovoValor('');
      toast.success('Medida adicionada', { description: resp.valor_canonico });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Não foi possível adicionar a medida';
      toast.error('Erro ao adicionar medida', { description: msg });
    } finally {
      if (myReq === reqIdRef.current) setSavingOption(false);
    }
  };
```

- [ ] **Step 6: Render do campo select com botão "Outro" / modo adicionar**

Substituir o bloco do ramo select (L281-296, de `{spec.spec_type === 'select' && spec.options ? (` até o `</Select>` correspondente) — manter o `: (` do Input intacto. O ternário externo continua `spec.spec_type === 'select' && spec.options ? (...) : (<Input .../>)`. Trocar a parte `(...)` por:

```tsx
                    {spec.spec_type === 'select' && spec.options ? (
                      addingForId === spec.id ? (
                        <div className="space-y-2">
                          <Input
                            autoFocus
                            value={novoValor}
                            onChange={(e) => setNovoValor(e.target.value)}
                            placeholder={`Nova medida para ${spec.spec_label}`}
                            maxLength={60}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); handleSaveOption(spec); }
                              if (e.key === 'Escape') { setAddingForId(null); setNovoValor(''); }
                            }}
                          />
                          <p className="text-xs text-muted-foreground">
                            Isto adiciona ao catálogo permanente desta ferramenta.
                          </p>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={() => handleSaveOption(spec)} disabled={savingOption}>
                              {savingOption && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                              Salvar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => { setAddingForId(null); setNovoValor(''); }}
                              disabled={savingOption}
                            >
                              Cancelar
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <Select
                            value={specValues[spec.spec_key] || ''}
                            onValueChange={(v) => handleSpecChange(spec.spec_key, v)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Selecione..." />
                            </SelectTrigger>
                            <SelectContent className="bg-popover max-h-60">
                              {spec.options.map((option) => (
                                <SelectItem key={option} value={option}>
                                  {option}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {isStaff && spec.allow_custom_option && (
                            <button
                              type="button"
                              onClick={() => { setAddingForId(spec.id); setNovoValor(''); }}
                              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              + Não está na lista? Adicionar…
                            </button>
                          )}
                        </>
                      )
                    ) : (
                      <Input
                        value={specValues[spec.spec_key] || ''}
                        onChange={(e) => handleSpecChange(spec.spec_key, e.target.value)}
                        placeholder={spec.spec_label}
                      />
                    )}
```

- [ ] **Step 7: Bloquear o submit durante uma adição**

No botão "Adicionar Ferramenta" do ramo COM specs (L323-334), trocar `disabled={isLoading}` por `disabled={isLoading || savingOption}`.

- [ ] **Step 8: Typecheck + lint + build**

Run:
```bash
heavy bun run typecheck > /tmp/tc.log 2>&1; echo "TC=$?"; tail -3 /tmp/tc.log
bun lint 2>&1 | tail -3
heavy bun run build > /tmp/bd.log 2>&1; echo "BUILD=$?"; tail -3 /tmp/bd.log
```
Expected: `TC=0`, lint sem novos erros, `BUILD=0`.

- [ ] **Step 9: Commit**

```bash
git add src/components/AddToolDialog.tsx
git commit -m "feat(tools): botão Outro nos dropdowns de spec (staff, allow_custom_option, RPC)"
```

---

## Task 4: Empacotar p/ Lovable + finalização

**Files:**
- Modify: `docs/roadmap-sessao.md` (se existir; senão criar conforme preferência do founder)

- [ ] **Step 1: Empacotar a migration via skill `lovable-db-operator`**

Invocar a skill `lovable-db-operator` para a migration `20260608120000_tool_spec_custom_option.sql`. Entregar ao founder, no chat:
- O bloco SQL completo (fenced ```sql, tag de fechamento sozinha) pronto pro **SQL Editor** (a migration inteira: ALTER + UPDATE + DROP POLICY + CREATE FUNCTION + REVOKE/GRANT).
- Query de validação pós-apply (colar no SQL Editor):
  ```sql
  SELECT
    (SELECT count(*) FROM information_schema.columns
       WHERE table_name='tool_specifications' AND column_name='allow_custom_option') AS tem_coluna,
    (SELECT count(*) FROM pg_proc WHERE proname='adicionar_opcao_tool_spec') AS tem_rpc,
    (SELECT count(*) FROM pg_policies WHERE tablename='tool_specifications'
       AND policyname='Only admins can manage specifications') AS policy_escrita_deve_ser_0,
    (SELECT count(*) FROM pg_proc p
       WHERE p.proname='adicionar_opcao_tool_spec'
         AND has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS authenticated_exec_1,
    (SELECT count(*) FROM tool_specifications WHERE allow_custom_option = false) AS faixas_fechadas;
  ```
  Esperado: `tem_coluna=1, tem_rpc=1, policy_escrita_deve_ser_0=0, authenticated_exec_1=1, faixas_fechadas>=1`.
- Nota no PR: **"⚠️ ATENÇÃO: migration manual necessária"** + o SQL no body.
- Lembrete: **Publish do frontend** no Lovable (a UI só vai ao ar após Publish).

- [ ] **Step 2: Regenerar o audit de migrations**

Run: `bun run audit:migrations` (atualiza `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`).
Commit:
```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(audit): regenera audit após migration tool_spec_custom_option"
```

- [ ] **Step 3: Atualizar o roadmap da sessão**

Editar `docs/roadmap-sessao.md` (criar se ausente) marcando a feature como ✅ entregue (código) / ⏳ aguardando apply+Publish do founder. Commit junto do PR.

- [ ] **Step 4: Abrir o PR**

```bash
git push -u origin claude/cranky-cori-12f230
gh pr create --title "feat(afiação): medida customizada (Outros) nos dropdowns de spec de ferramenta" \
  --body "$(cat <<'EOF'
## O que

No wizard de cadastro de ferramenta de afiação, a equipe pode adicionar uma medida nova num dropdown de especificação quando ela não está na lista ("+ Não está na lista? Adicionar…"). A medida entra no catálogo oficial daquele campo e reaparece em cadastros futuros daquela ferramenta. Cliente final continua escolhendo só da lista.

## Como

- RPC `adicionar_opcao_tool_spec` (SECURITY DEFINER, gate staff, normaliza NFC, dedupe case-insensitive, append atômico com FOR UPDATE, retorna `{options, valor_canonico}`).
- Coluna `allow_custom_option` (fecha campos de "faixa" tipo "de 120mm a 300mm").
- Policy de escrita de `tool_specifications` dropada → RPC é o único escritor via API.
- Front: botão "Outro" separado (staff + allow_custom_option), guard de resposta obsoleta, bloqueio de submit durante a adição.
- Helper puro `normalizarOpcaoSpec` (testado) + teste PG17 da RPC (gate, NULL, dedupe, guards, limite, grants, concorrência).

Design + revisão Codex: `docs/superpowers/specs/2026-06-08-tool-spec-medida-customizada-design.md`.

## ⚠️ ATENÇÃO: migration manual necessária

Aplicar `supabase/migrations/20260608120000_tool_spec_custom_option.sql` no **SQL Editor** do Lovable (bloco no chat) + rodar a query de validação. Depois **Publish** do frontend.
EOF
)"
```

- [ ] **Step 5: Code review pré-merge**

Rodar `/review` (gstack) no diff (SQL safety, side effects) e, como é money-path-adjacent, `codex challenge` no código final. Endereçar P1/P2 antes do merge.

---

## Self-Review (cobertura do spec)

- ✅ "Outros" em todos os dropdowns → Task 3 Step 6 (render genérico no `.map`).
- ✅ Salvar e reaparecer → RPC append (Task 2) + reload lê do banco.
- ✅ Só staff → `isStaff` na UI (Task 3) + gate `has_role` na RPC (Task 2).
- ✅ Catálogo oficial → append em `tool_specifications.options` (Task 2).
- ✅ Achados do Codex: NULL (E), search_path='' (migration), drop policy (P), botão separado (Step 6), allow_custom_option/faixas (J), valor_canonico (C), races no front (Step 5 guard), teste PG17 obrigatório (Task 2).
- ✅ Ritual Lovable → Task 4 (bloco SQL + validação + Publish).
- Tipos consistentes: `normalizarOpcaoSpec(string): string | null`, RPC retorna `{ options: string[]; valor_canonico: string }`, `allow_custom_option: boolean | null` na interface — usados igualmente em todas as tasks.

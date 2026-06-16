# Radar de Clientes — Fatia 1: Fundação de dados + 1ª carga real — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Universo prospectável de empresas (dump RFB filtrado por CNAEs curados) carregado em `radar_empresas`, com pipeline validado ponta a ponta por uma carga real manual.

**Architecture:** Script local (bun + DuckDB) baixa o dump mensal da RFB, filtra situação ATIVA + CNAEs da lista curada, normaliza e POSTa em chunks autenticados (`x-cron-secret`) para a edge function `radar-ingest`, que faz upsert preservando o estado de prospecção e finaliza re-cruzando "já é cliente". Migrations manuais (SQL Editor do Lovable), validadas em PG17 local antes do apply.

**Tech Stack:** Postgres (Supabase/Lovable), Deno edge function, bun + DuckDB CLI (pipeline local), vitest (helpers puros).

**Spec:** `docs/superpowers/specs/2026-06-10-radar-clientes-design.md`

**Fora desta fatia:** tela `/radar` (fatia 2), RPCs de contato/mapa (fatias 2-3), ações Omie/Tarefa (fatia 3), GitHub Action + Sentinela (fatia 4).

---

## Coreografia de rollout (constraint Lovable — ordem importa)

1. Tasks 1–7 implementadas → PR → CI verde → merge.
2. Founder cola a migration no SQL Editor (BLOCO único + query de validação).
3. Founder deploya `radar-ingest` via chat do Lovable (verbatim da main).
4. Claude roda `scripts/radar/carga.ts` localmente (Task 8) → valida contagens com o founder.

## File Structure

- Create: `supabase/migrations/20260610200000_radar_fundacao.sql` — 4 tabelas + RLS + função de recruza
- Create: `src/lib/radar/types.ts` — contrato `RadarEmpresaRow` (script ↔ edge ↔ fatia 2)
- Create: `src/lib/radar/normalizar.ts` + `src/lib/radar/__tests__/normalizar.test.ts` — helpers puros TDD
- Create: `supabase/functions/radar-ingest/index.ts` — edge de ingestão
- Create: `scripts/radar/cnaes-alvo.txt` — curadoria versionada
- Create: `scripts/radar/municipios-ibge.csv` — município → lat/lng (commitado 1×)
- Create: `scripts/radar/carga.ts` — orquestrador local (download → DuckDB → chunks → POST)
- Create: `db/test-radar-fundacao.sh` — validação PG17 da migration (asserts comportamentais)

---

### Task 1: Migration da fundação (4 tabelas + RLS + recruza)

**Files:**
- Create: `supabase/migrations/20260610200000_radar_fundacao.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- =============================================================================
-- RADAR DE CLIENTES — FUNDAÇÃO (fatia 1)
-- Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable (Lovable não auto-aplica).
-- =============================================================================

-- 1) Universo prospectável -----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_empresas (
  cnpj                      text PRIMARY KEY CHECK (cnpj ~ '^[0-9]{14}$'),
  razao_social              text,
  nome_fantasia             text,
  cnae_principal            text NOT NULL CHECK (cnae_principal ~ '^[0-9]{7}$'),
  cnae_descricao            text,
  cnaes_secundarios         text[] NOT NULL DEFAULT '{}',
  data_abertura             date,
  porte                     text,            -- '00'|'01'|'03'|'05' (RFB)
  capital_social            numeric,
  logradouro                text,
  numero                    text,
  complemento               text,
  bairro                    text,
  municipio_codigo          text,            -- código TOM (convenção RFB, ≠ IBGE)
  municipio_nome            text,
  uf                        text,
  cep                       text,
  telefone1                 text,
  telefone2                 text,
  email                     text,
  socios_nomes              text,
  -- operacionais
  primeira_vista_em         timestamptz NOT NULL DEFAULT now(),  -- só no INSERT
  ultimo_lote               text NOT NULL,   -- 'YYYY-MM'; ≠ lote vigente ⇒ saiu do dump
  ja_cliente                boolean NOT NULL DEFAULT false,
  prospeccao_status         text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN
      ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em  timestamptz,
  descarte_motivo           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_radar_empresas_fila
  ON public.radar_empresas (ultimo_lote, prospeccao_status, data_abertura DESC);
CREATE INDEX IF NOT EXISTS idx_radar_empresas_local
  ON public.radar_empresas (uf, municipio_nome);
CREATE INDEX IF NOT EXISTS idx_radar_empresas_cnae
  ON public.radar_empresas (cnae_principal);

-- 2) Histórico de prospecção (append-only; RPCs de escrita chegam na fatia 2) --
CREATE TABLE IF NOT EXISTS public.radar_contatos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj        text NOT NULL REFERENCES public.radar_empresas(cnpj) ON DELETE CASCADE,
  acao        text NOT NULL CHECK (acao IN
    ('contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar')),
  nota        text,
  criado_por  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_radar_contatos_cnpj ON public.radar_contatos (cnpj, created_at DESC);

-- 3) Municípios (mapa agregado; carregado pelo pipeline, chunk 'municipios') ---
CREATE TABLE IF NOT EXISTS public.radar_municipios (
  codigo  text PRIMARY KEY,   -- código TOM (RFB)
  nome    text NOT NULL,
  uf      text NOT NULL,
  lat     double precision,
  lng     double precision
);

-- 4) Estado da ingestão (padrão omie_nao_vinculados_state) ---------------------
CREATE TABLE IF NOT EXISTS public.radar_ingest_state (
  mes_referencia  text PRIMARY KEY,  -- 'YYYY-MM'
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','error')),
  total_recebido  integer NOT NULL DEFAULT 0,
  novos           integer,
  iniciado_em     timestamptz NOT NULL DEFAULT now(),
  finalizado_em   timestamptz,
  erro            text
);

-- 5) RLS: leitura = gestor/master (pode_ver_carteira_completa, helper já em prod);
--    escrita = service_role (mutação humana virá por RPC na fatia 2) -----------
ALTER TABLE public.radar_empresas      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_contatos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_municipios    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_ingest_state  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "radar_empresas_select_gestor" ON public.radar_empresas;
CREATE POLICY "radar_empresas_select_gestor" ON public.radar_empresas
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_contatos_select_gestor" ON public.radar_contatos;
CREATE POLICY "radar_contatos_select_gestor" ON public.radar_contatos
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_municipios_select_gestor" ON public.radar_municipios;
CREATE POLICY "radar_municipios_select_gestor" ON public.radar_municipios
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));

DROP POLICY IF EXISTS "radar_ingest_state_select_gestor" ON public.radar_ingest_state;
CREATE POLICY "radar_ingest_state_select_gestor" ON public.radar_ingest_state
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));
-- (sem policies de INSERT/UPDATE/DELETE para authenticated: service_role bypassa RLS)

-- 6) Recruza "já é cliente": profiles.document ∪ omie_clientes_nao_vinculados.cnpj_cpf
--    (⚠️ omie_clientes NÃO tem documento — só códigos). Chamada pela edge no finalize.
CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marcados integer;
BEGIN
  CREATE TEMP TABLE tmp_docs_clientes ON COMMIT DROP AS
    SELECT DISTINCT regexp_replace(document, '[^0-9]', '', 'g') AS doc
    FROM public.profiles
    WHERE document IS NOT NULL
      AND length(regexp_replace(document, '[^0-9]', '', 'g')) = 14
    UNION
    SELECT DISTINCT regexp_replace(cnpj_cpf, '[^0-9]', '', 'g') AS doc
    FROM public.omie_clientes_nao_vinculados
    WHERE cnpj_cpf IS NOT NULL
      AND length(regexp_replace(cnpj_cpf, '[^0-9]', '', 'g')) = 14;

  UPDATE public.radar_empresas re
  SET ja_cliente = true, updated_at = now()
  WHERE re.ja_cliente = false
    AND EXISTS (SELECT 1 FROM tmp_docs_clientes d WHERE d.doc = re.cnpj);

  GET DIAGNOSTICS v_marcados = ROW_COUNT;
  RETURN v_marcados;
END;
$$;

-- trava a função: só service_role (a edge chama com service client)
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;

-- 7) Validação pós-apply (colar junto; esperar: tabelas=4, policies=4, funcao=1)
SELECT 'RADAR FUNDACAO OK' AS status,
  (SELECT count(*) FROM information_schema.tables
    WHERE table_schema='public' AND table_name IN
      ('radar_empresas','radar_contatos','radar_municipios','radar_ingest_state')) AS tabelas_4,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public'
    AND tablename LIKE 'radar_%') AS policies_4,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='radar_recruzar_ja_cliente') AS funcao_1;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/20260610200000_radar_fundacao.sql
git commit -m "feat(radar): migration da fundação — radar_empresas/contatos/municipios/state + RLS + recruza"
```

---

### Task 2: Validação PG17 da migration (asserts comportamentais)

**Files:**
- Create: `db/test-radar-fundacao.sh`

Padrão do projeto (`db/verify-snapshot-replay.sh` como base; ver `db/test-whatsapp-sla.sql` para o estilo). O snapshot de prod tem `profiles` e `omie_clientes_nao_vinculados` — suficiente pro recruza.

- [ ] **Step 1: Escrever o teste**

```bash
#!/usr/bin/env bash
# Valida a migration 20260610200000_radar_fundacao.sql num PostgreSQL 17 local.
# Asserts: upsert preserva estado de prospecção; recruza marca ja_cliente pelos
# DOIS conjuntos; RLS nega não-gestor; CHECKs rejeitam lixo.
set -euo pipefail
cd "$(dirname "$0")/.."

PGBIN="$(ls -d /opt/homebrew/opt/postgresql@17/bin 2>/dev/null || ls -d /usr/local/opt/postgresql@17/bin)"
DB_DIR="$(mktemp -d)"; PORT=55436
"$PGBIN/initdb" -D "$DB_DIR" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$DB_DIR" -o "-p $PORT -k $DB_DIR" -l "$DB_DIR/log" start >/dev/null
trap '"$PGBIN/pg_ctl" -D "$DB_DIR" stop -m immediate >/dev/null 2>&1; rm -rf "$DB_DIR"' EXIT
PSQL=("$PGBIN/psql" -h "$DB_DIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)

# Stubs mínimos (auth.uid override por GUC + tabelas/funções de prod que a migration referencia)
"${PSQL[@]}" <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, document text);
CREATE TABLE public.omie_clientes_nao_vinculados (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj_cpf text);
-- stub fiel ao contrato de prod: gestor/master ⇒ true (corpo real testado nos PRs #329/#340)
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
SQL

"${PSQL[@]}" -f supabase/migrations/20260610200000_radar_fundacao.sql >/dev/null
"${PSQL[@]}" <<'SQL'
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;

-- Seeds
INSERT INTO public.test_gestores VALUES ('00000000-0000-0000-0000-00000000aaaa');
INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000001', '11.222.333/0001-44');
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('55666777000188');
INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
  ('11222333000144', '3101200', '2026-05', 'JA CLIENTE VIA PROFILE'),
  ('55666777000188', '3101200', '2026-05', 'JA CLIENTE VIA NAO VINCULADO'),
  ('99888777000166', '3101200', '2026-05', 'LEAD LIVRE');

-- A1: recruza marca pelos DOIS conjuntos e poupa o lead livre
SELECT public.radar_recruzar_ja_cliente() AS marcados \gset
SELECT CASE WHEN :marcados = 2 THEN 'A1 OK' ELSE 'A1 FALHOU: '||:marcados END;
SELECT CASE WHEN (SELECT ja_cliente FROM radar_empresas WHERE cnpj='99888777000166') = false
  THEN 'A2 OK' ELSE 'A2 FALHOU' END;

-- A3: upsert de lote novo preserva primeira_vista_em e prospeccao_status
UPDATE radar_empresas SET prospeccao_status='em_conversa', prospeccao_atualizado_em=now()
  WHERE cnpj='99888777000166';
SELECT primeira_vista_em AS pv0 FROM radar_empresas WHERE cnpj='99888777000166' \gset
INSERT INTO radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social)
VALUES ('99888777000166', '3101200', '2026-06', 'LEAD LIVRE RENOMEADO')
ON CONFLICT (cnpj) DO UPDATE SET
  razao_social=EXCLUDED.razao_social, ultimo_lote=EXCLUDED.ultimo_lote, updated_at=now();
SELECT CASE WHEN prospeccao_status='em_conversa' AND primeira_vista_em=:'pv0'
  AND ultimo_lote='2026-06' AND razao_social='LEAD LIVRE RENOMEADO'
  THEN 'A3 OK' ELSE 'A3 FALHOU' END FROM radar_empresas WHERE cnpj='99888777000166';

-- A4: RLS — gestor lê; não-gestor lê 0; CHECK rejeita cnpj inválido
SET ROLE authenticated; SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
SELECT CASE WHEN count(*)=3 THEN 'A4a OK' ELSE 'A4a FALHOU' END FROM radar_empresas;
SET test.uid = '00000000-0000-0000-0000-00000000bbbb';
SELECT CASE WHEN count(*)=0 THEN 'A4b OK' ELSE 'A4b FALHOU' END FROM radar_empresas;
RESET ROLE; SET test.uid = '';
DO $$ BEGIN
  INSERT INTO radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('abc', '3101200', '2026-06');
  RAISE EXCEPTION 'A5 FALHOU: CHECK não barrou';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'A5 OK'; END $$;
SQL
echo "✅ test-radar-fundacao: todos os asserts passaram"
```

- [ ] **Step 2: Rodar e ver TODOS os asserts OK**

Run: `chmod +x db/test-radar-fundacao.sh && ./db/test-radar-fundacao.sh`
Expected: linhas `A1 OK`…`A5 OK` + `✅ test-radar-fundacao`. Se `A1 FALHOU`, a recruza está quebrada — não seguir.

- [ ] **Step 3: Commit**

```bash
git add db/test-radar-fundacao.sh
git commit -m "test(radar): validação PG17 da fundação — recruza, upsert preserva estado, RLS"
```

---

### Task 3: Tipos compartilhados + helpers puros de normalização (TDD)

**Files:**
- Create: `src/lib/radar/types.ts`
- Create: `src/lib/radar/normalizar.ts`
- Test: `src/lib/radar/__tests__/normalizar.test.ts`

O dump da RFB vem posicional (sem header), ISO-8859-1, `;`, campos entre aspas. Estabelecimentos: 30 colunas (1 cnpj_basico, 2 ordem, 3 dv, 5 nome_fantasia, 6 situacao [02=ATIVA], 11 data_inicio, 12 cnae_principal, 13 cnae_secundaria [lista com vírgula], 14-19 endereço, 20 uf, 21 municipio TOM, 22-25 ddd/tel 1-2, 28 email). Empresas: 7 colunas (1 cnpj_basico, 2 razao_social, 5 capital [vírgula decimal], 6 porte). O DuckDB resolve CSV/encoding; os helpers cuidam da SEMÂNTICA.

- [ ] **Step 1: Escrever `types.ts`**

```ts
// Contrato script local → edge radar-ingest → radar_empresas (fatia 2 reusa).
export type RadarEmpresaRow = {
  cnpj: string;                 // 14 dígitos
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae_principal: string;       // 7 dígitos
  cnae_descricao: string | null;
  cnaes_secundarios: string[];
  data_abertura: string | null; // YYYY-MM-DD
  porte: string | null;
  capital_social: number | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio_codigo: string | null;
  municipio_nome: string | null;
  uf: string | null;
  cep: string | null;
  telefone1: string | null;
  telefone2: string | null;
  email: string | null;
  socios_nomes: string | null;
};

export type RadarMunicipioRow = {
  codigo: string; nome: string; uf: string;
  lat: number | null; lng: number | null;
};
```

- [ ] **Step 2: Escrever os testes (falhando)**

```ts
import { describe, expect, it } from 'vitest';
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
} from '../normalizar';

describe('montarCnpj', () => {
  it('compõe basico+ordem+dv com zero-pad', () =>
    expect(montarCnpj('123', '1', '44')).toBe('00000123000144'));
  it('rejeita componente não-numérico', () =>
    expect(montarCnpj('abc', '0001', '44')).toBeNull());
});

describe('normalizarData', () => {
  it('AAAAMMDD → YYYY-MM-DD', () => expect(normalizarData('20240115')).toBe('2024-01-15'));
  it('vazio/zero/lixo → null', () => {
    expect(normalizarData('')).toBeNull();
    expect(normalizarData('0')).toBeNull();
    expect(normalizarData('20241341')).toBeNull(); // mês 13 inexistente
  });
});

describe('normalizarTelefone', () => {
  it('junta ddd+numero', () => expect(normalizarTelefone('37', '32212222')).toBe('(37) 32212222'));
  it('sem ddd usa só o número; tudo vazio → null', () => {
    expect(normalizarTelefone('', '32212222')).toBe('32212222');
    expect(normalizarTelefone('', '')).toBeNull();
    expect(normalizarTelefone('0', '0')).toBeNull(); // placeholder da RFB
  });
});

describe('normalizarCapital', () => {
  it('vírgula decimal → number', () => expect(normalizarCapital('10000,50')).toBe(10000.5));
  it('vazio/lixo → null', () => {
    expect(normalizarCapital('')).toBeNull();
    expect(normalizarCapital('abc')).toBeNull();
  });
});

describe('splitCnaesSecundarios', () => {
  it('lista com vírgula → array de 7 dígitos', () =>
    expect(splitCnaesSecundarios('1622602,2542000')).toEqual(['1622602', '2542000']));
  it('vazio e códigos malformados caem fora', () => {
    expect(splitCnaesSecundarios('')).toEqual([]);
    expect(splitCnaesSecundarios('123,1622602')).toEqual(['1622602']);
  });
});

describe('normalizarTexto', () => {
  it('trim + colapsa espaços; vazio → null', () => {
    expect(normalizarTexto('  MOVEIS  ZE  ')).toBe('MOVEIS ZE');
    expect(normalizarTexto('   ')).toBeNull();
  });
});

describe('normalizarChaveMunicipio', () => {
  it('casa nome RFB com nome IBGE (acentos, caixa, apóstrofo)', () => {
    expect(normalizarChaveMunicipio("SANTA BÁRBARA D'OESTE", 'SP'))
      .toBe(normalizarChaveMunicipio("Santa Barbara d Oeste", 'sp'));
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `heavy bun run test src/lib/radar 2>&1 | tail -5`
Expected: FAIL (módulo `../normalizar` não existe).

- [ ] **Step 4: Implementar `normalizar.ts`**

```ts
// Helpers puros de normalização do dump RFB. Sem I/O — testáveis e reusáveis
// pelo script local (carga.ts) e, futuramente, pela GitHub Action (fatia 4).

export function montarCnpj(basico: string, ordem: string, dv: string): string | null {
  const b = basico.trim(), o = ordem.trim(), d = dv.trim();
  if (!/^\d{1,8}$/.test(b) || !/^\d{1,4}$/.test(o) || !/^\d{1,2}$/.test(d)) return null;
  return b.padStart(8, '0') + o.padStart(4, '0') + d.padStart(2, '0');
}

export function normalizarData(v: string): string | null {
  const s = v.trim();
  if (!/^\d{8}$/.test(s) || s === '00000000') return null;
  const ano = +s.slice(0, 4), mes = +s.slice(4, 6), dia = +s.slice(6, 8);
  if (ano < 1900 || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

export function normalizarTelefone(ddd: string, numero: string): string | null {
  const d = ddd.replace(/\D/g, '').replace(/^0+$/, '');
  const n = numero.replace(/\D/g, '').replace(/^0+$/, '');
  if (!n) return null;
  return d ? `(${d}) ${n}` : n;
}

export function normalizarCapital(v: string): number | null {
  const s = v.trim().replace(/\./g, '').replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function splitCnaesSecundarios(v: string): string[] {
  return v.split(',').map((c) => c.trim()).filter((c) => /^\d{7}$/.test(c));
}

export function normalizarTexto(v: string | null | undefined): string | null {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return s || null;
}

// Chave de casamento município RFB ↔ IBGE: sem acento, sem pontuação, UPPER + UF.
export function normalizarChaveMunicipio(nome: string, uf: string): string {
  const semAcento = nome.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return `${semAcento.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()}|${uf.trim().toUpperCase()}`;
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `heavy bun run test src/lib/radar 2>&1 | tail -5`
Expected: PASS (todos os testes).

- [ ] **Step 6: Commit**

```bash
git add src/lib/radar/
git commit -m "feat(radar): tipos do contrato + helpers puros de normalização do dump RFB (TDD)"
```

---

### Task 4: Curadoria de CNAEs + base de municípios IBGE

**Files:**
- Create: `scripts/radar/cnaes-alvo.txt`
- Create: `scripts/radar/municipios-ibge.csv`

- [ ] **Step 1: Escrever `cnaes-alvo.txt`** (formato: `codigo<TAB>comentário`; linhas `#` ignoradas)

```
# Radar de Clientes — CNAEs-alvo (curadoria versionada; founder revisa).
# Expandir = editar + re-rodar a carga. Códigos de 7 dígitos como no dump RFB.
# ⚠️ O script valida cada código contra o Cnaes.zip do próprio dump (DV errado = abort).

# — Moveleiro (Oben: vernizes/tintas/insumos Sayerlack) —
3101200	Fabricação de móveis com predominância de madeira
3102100	Fabricação de móveis com predominância de metal
3103900	Fabricação de móveis de outros materiais (exceto madeira e metal)
1621800	Fabricação de madeira laminada e chapas (compensado/aglomerado/MDF)
1622601	Fabricação de casas de madeira pré-fabricadas
1622602	Fabricação de esquadrias de madeira p/ instalações industriais e comerciais
1622699	Fabricação de outros artigos de carpintaria para construção
1623400	Fabricação de artefatos de tanoaria e embalagens de madeira
1629301	Fabricação de artefatos diversos de madeira (exceto móveis)
9524801	Reparação e manutenção de móveis (restauradores)

# — Madeira bruta / serrarias (Colacor abrasivos + afiação Colacor SC) —
1610203	Serrarias com desdobramento de madeira em bruto
1610204	Serrarias sem desdobramento (resserragem)
1610205	Serviço de tratamento de madeira sob contrato

# — Metal (Colacor abrasivos) —
2542000	Fabricação de artigos de serralheria (exceto esquadrias)
2512800	Fabricação de esquadrias de metal
2511000	Fabricação de estruturas metálicas
2539001	Serviços de usinagem, tornearia e solda
2539002	Serviços de tratamento e revestimento em metais (polimento)

# — Pedra e vidro (Colacor abrasivos) —
2391503	Aparelhamento de placas e trabalhos em mármore/granito (marmorarias)
2319200	Fabricação de artigos de vidro
4743100	Comércio varejista de vidros (vidraçarias — corte/lapidação)
```

- [ ] **Step 2: Baixar e commitar a base de municípios IBGE (lat/lng)**

Fonte pública de domínio aberto (repo `kelvins/municipios-brasileiros`, ~5.570 linhas):

Run:
```bash
curl -fsSL https://raw.githubusercontent.com/kelvins/municipios-brasileiros/main/csv/municipios.csv \
  -o scripts/radar/municipios-ibge.csv
wc -l scripts/radar/municipios-ibge.csv   # esperado: ~5571 (header + municípios)
head -2 scripts/radar/municipios-ibge.csv # conferir colunas: codigo_ibge,nome,latitude,longitude,...,codigo_uf
```
Se a URL mudar, qualquer base equivalente (codigo_ibge, nome, latitude, longitude, UF) serve — ajustar o parse na Task 6.

- [ ] **Step 3: Pedir revisão da curadoria ao founder** (no PR e no chat: a lista acima é a proposta inicial; cortar/adicionar é editar o arquivo)

- [ ] **Step 4: Commit**

```bash
git add scripts/radar/cnaes-alvo.txt scripts/radar/municipios-ibge.csv
git commit -m "feat(radar): curadoria inicial de CNAEs-alvo + base municípios IBGE (lat/lng)"
```

---

### Task 5: Edge function `radar-ingest`

**Files:**
- Create: `supabase/functions/radar-ingest/index.ts`

Gate: `x-cron-secret` (Vault/env `CRON_SECRET`) OU JWT staff master — espelha o padrão `authorizeCronOrStaff` dos edges existentes (ver `whatsapp-send`). Actions: `begin_lote`, `chunk`, `chunk_municipios`, `finalize`, `status`. Upsert NUNCA toca `prospeccao_status`/`primeira_vista_em`/`ja_cliente` (payload só com campos cadastrais + `ultimo_lote`).

- [ ] **Step 1: Implementar a edge**

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MES_RE = /^\d{4}-\d{2}$/;
const CNPJ_RE = /^\d{14}$/;

// Espelho fino do authorizeCronOrStaff: cron-secret OU staff master via JWT.
async function autorizado(req: Request): Promise<boolean> {
  const secret = req.headers.get("x-cron-secret");
  if (secret && CRON_SECRET && secret === CRON_SECRET) return true;
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const supa = createClient(SUPABASE_URL, SERVICE_KEY, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supa.auth.getUser();
  if (!user) return false;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data } = await admin.from("user_roles").select("role").eq("user_id", user.id).eq("role", "master");
  return (data?.length ?? 0) > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (!(await autorizado(req))) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "body inválido" }, 400); }
  const action = String(body.action ?? "");
  const mes = String(body.mes ?? "");

  try {
    if (action === "begin_lote") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido (YYYY-MM)" }, 400);
      const { error } = await admin.from("radar_ingest_state").upsert({
        mes_referencia: mes, status: "running", total_recebido: 0, novos: null,
        iniciado_em: new Date().toISOString(), finalizado_em: null, erro: null,
      }, { onConflict: "mes_referencia" });
      if (error) throw error;
      return json({ ok: true, mes });
    }

    if (action === "chunk") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0) return json({ error: "linhas vazio" }, 400);
      if (linhas.length > 1000) return json({ error: "máx 1000 linhas/chunk" }, 400);
      const validas = linhas.filter((l) =>
        CNPJ_RE.test(String(l.cnpj ?? "")) && /^\d{7}$/.test(String(l.cnae_principal ?? "")));
      if (validas.length !== linhas.length) {
        console.warn(`chunk: ${linhas.length - validas.length} linhas inválidas descartadas`);
      }
      if (validas.length === 0) return json({ ok: true, upserted: 0, descartadas: linhas.length });
      // ⚠️ payload SÓ com campos cadastrais + ultimo_lote: o UPDATE do upsert não
      // toca primeira_vista_em / prospeccao_status / ja_cliente (preservação por omissão).
      const payload = validas.map((l) => ({
        cnpj: l.cnpj, razao_social: l.razao_social ?? null, nome_fantasia: l.nome_fantasia ?? null,
        cnae_principal: l.cnae_principal, cnae_descricao: l.cnae_descricao ?? null,
        cnaes_secundarios: l.cnaes_secundarios ?? [], data_abertura: l.data_abertura ?? null,
        porte: l.porte ?? null, capital_social: l.capital_social ?? null,
        logradouro: l.logradouro ?? null, numero: l.numero ?? null, complemento: l.complemento ?? null,
        bairro: l.bairro ?? null, municipio_codigo: l.municipio_codigo ?? null,
        municipio_nome: l.municipio_nome ?? null, uf: l.uf ?? null, cep: l.cep ?? null,
        telefone1: l.telefone1 ?? null, telefone2: l.telefone2 ?? null, email: l.email ?? null,
        socios_nomes: l.socios_nomes ?? null,
        ultimo_lote: mes, updated_at: new Date().toISOString(),
      }));
      const { error } = await admin.from("radar_empresas").upsert(payload, { onConflict: "cnpj" });
      if (error) throw error;
      // Sem contador incremental no chunk: a contagem oficial (total/novos) é
      // recomputada no finalize com count real da tabela — chunk replay-safe.
      return json({ ok: true, upserted: payload.length });
    }

    if (action === "chunk_municipios") {
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0 || linhas.length > 1000)
        return json({ error: "linhas inválido (1..1000)" }, 400);
      const payload = linhas
        .filter((l) => String(l.codigo ?? "").trim() && String(l.nome ?? "").trim())
        .map((l) => ({ codigo: String(l.codigo), nome: l.nome, uf: l.uf ?? "", lat: l.lat ?? null, lng: l.lng ?? null }));
      const { error } = await admin.from("radar_municipios").upsert(payload, { onConflict: "codigo" });
      if (error) throw error;
      return json({ ok: true, upserted: payload.length });
    }

    if (action === "finalize") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const { data: st, error: eSt } = await admin.from("radar_ingest_state")
        .select("iniciado_em").eq("mes_referencia", mes).single();
      if (eSt || !st) return json({ error: "lote não iniciado" }, 400);
      const { error: eRe } = await admin.rpc("radar_recruzar_ja_cliente");
      if (eRe) throw eRe;
      const { count: total, error: eT } = await admin.from("radar_empresas")
        .select("cnpj", { count: "exact", head: true }).eq("ultimo_lote", mes);
      if (eT) throw eT;
      const { count: novos, error: eN } = await admin.from("radar_empresas")
        .select("cnpj", { count: "exact", head: true }).gte("primeira_vista_em", st.iniciado_em);
      if (eN) throw eN;
      const { error: eUp } = await admin.from("radar_ingest_state").update({
        status: "complete", total_recebido: total ?? 0, novos: novos ?? 0,
        finalizado_em: new Date().toISOString(),
      }).eq("mes_referencia", mes);
      if (eUp) throw eUp;
      return json({ ok: true, mes, total, novos });
    }

    if (action === "status") {
      const { data, error } = await admin.from("radar_ingest_state")
        .select("*").order("mes_referencia", { ascending: false }).limit(3);
      if (error) throw error;
      return json({ ok: true, lotes: data });
    }

    return json({ error: `ação desconhecida: ${action}`, acoes: ["begin_lote", "chunk", "chunk_municipios", "finalize", "status"] }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`radar-ingest ${action} falhou:`, msg);
    if (MES_RE.test(mes)) {
      await admin.from("radar_ingest_state").update({ status: "error", erro: msg })
        .eq("mes_referencia", mes).then(() => {}, () => {});
    }
    return json({ error: msg }, 500);
  }
});
```

- [ ] **Step 2: Checar tipos do Deno (informativo — CI não roda deno check)**

Run: `deno check supabase/functions/radar-ingest/index.ts 2>&1 | tail -3`
Expected: sem erros NOVOS além do padrão supabase-js sem generic (pré-existente nos outros edges).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/radar-ingest/
git commit -m "feat(radar): edge radar-ingest — begin_lote/chunk/chunk_municipios/finalize com gate cron/master"
```

---

### Task 6: Script de carga local (`scripts/radar/carga.ts`)

**Files:**
- Create: `scripts/radar/carga.ts`

Orquestrador bun: descobre/baixa o dump → DuckDB filtra e junta → normaliza (helpers da Task 3) → POSTa chunks. Disco: processa UM zip por vez (pico ~9GB; checar `df -h` antes). Pré-requisito: `brew install duckdb` se ausente.

- [ ] **Step 1: Implementar o orquestrador**

```ts
#!/usr/bin/env bun
/**
 * Carga do Radar de Clientes — dump RFB → radar-ingest.
 * Uso: bun scripts/radar/carga.ts --mes 2026-05 [--base-url <url>] [--dry-run] [--so-municipios]
 * Env: RADAR_INGEST_URL (https://<proj>.supabase.co/functions/v1/radar-ingest)
 *      RADAR_CRON_SECRET (valor do CRON_SECRET do Vault)
 * ⚠️ A RFB mudou layout/URLs em jan/2026 — o script tenta os candidatos conhecidos
 * e ABORTA com instrução clara se nenhum responder (descoberta faz parte da 1ª carga).
 */
import { mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  montarCnpj, normalizarData, normalizarTelefone, normalizarCapital,
  splitCnaesSecundarios, normalizarTexto, normalizarChaveMunicipio,
} from "../../src/lib/radar/normalizar";
import type { RadarEmpresaRow, RadarMunicipioRow } from "../../src/lib/radar/types";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
}
const MES = args.get("mes") ?? "";
if (!/^\d{4}-\d{2}$/.test(MES)) { console.error("--mes YYYY-MM obrigatório"); process.exit(1); }
const DRY = args.get("dry-run") === "true";
const URL_BASES = args.get("base-url") ? [args.get("base-url")!] : [
  `https://arquivos.receitafederal.gov.br/dados/cnpj/dados_abertos_cnpj/${MES}`,
  `https://dadosabertos.rfb.gov.br/CNPJ/dados_abertos_cnpj/${MES}`,
  `https://dadosabertos.rfb.gov.br/CNPJ/${MES}`,
];
const INGEST_URL = process.env.RADAR_INGEST_URL ?? "";
const SECRET = process.env.RADAR_CRON_SECRET ?? "";
if (!DRY && (!INGEST_URL || !SECRET)) { console.error("RADAR_INGEST_URL e RADAR_CRON_SECRET obrigatórios (ou use --dry-run)"); process.exit(1); }

const WORK = `/tmp/radar-${MES}`;
mkdirSync(WORK, { recursive: true });
const sh = (cmd: string) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1024 * 1024 * 64 }).toString();

// ── 1. Descobrir base URL viva (HEAD no Cnaes.zip, arquivo pequeno) ──────────
let BASE = "";
for (const cand of URL_BASES) {
  try {
    const code = sh(`curl -s -o /dev/null -w '%{http_code}' --max-time 30 -I "${cand}/Cnaes.zip"`).trim();
    if (code === "200") { BASE = cand; break; }
    console.log(`candidato ${cand} → HTTP ${code}`);
  } catch { /* tenta o próximo */ }
}
if (!BASE) {
  console.error(`\n❌ Nenhuma URL candidata respondeu para ${MES}.\n` +
    `Descubra o caminho atual em https://www.gov.br/receitafederal/pt-br/acesso-a-informacao/dados-abertos\n` +
    `e re-rode com --base-url <url-da-pasta-do-mes>.`);
  process.exit(2);
}
console.log(`✅ base: ${BASE}`);

const baixar = (nome: string) => {
  const dest = `${WORK}/${nome}`;
  if (!existsSync(dest)) {
    console.log(`⬇️  ${nome}`);
    sh(`curl -fSL --retry 3 -C - -o "${dest}" "${BASE}/${nome}"`);
  }
  return dest;
};

// ── 2. Curadoria + validação contra o Cnaes.zip (DV errado = abort) ──────────
const cnaes = readFileSync("scripts/radar/cnaes-alvo.txt", "utf-8").split("\n")
  .map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[0].trim());
if (cnaes.length === 0) { console.error("cnaes-alvo.txt vazio"); process.exit(1); }
baixar("Cnaes.zip");
sh(`cd ${WORK} && unzip -o -q Cnaes.zip -d cnaes/`);
const duck = (q: string) => sh(`duckdb -json -c "${q.replace(/"/g, '\\"')}"`);
const catalogoCnae: { c: string; d: string }[] = JSON.parse(duck(
  `SELECT column0 AS c, column1 AS d FROM read_csv('${WORK}/cnaes/*', delim=';', header=false, quote='\\"', encoding='latin-1', all_varchar=true)`));
const mapaCnae = new Map(catalogoCnae.map((r) => [r.c, r.d]));
const invalidos = cnaes.filter((c) => !mapaCnae.has(c));
if (invalidos.length) { console.error(`❌ CNAEs fora do catálogo RFB (DV errado?): ${invalidos.join(", ")}`); process.exit(3); }
console.log(`✅ curadoria: ${cnaes.length} CNAEs válidos`);

// ── 3. Estabelecimentos: 10 zips, um por vez → parquet filtrado ──────────────
const inList = cnaes.map((c) => `'${c}'`).join(",");
const secRegex = cnaes.join("|");
for (let i = 0; i <= 9; i++) {
  const zip = baixar(`Estabelecimentos${i}.zip`);
  sh(`cd ${WORK} && rm -rf est/ && unzip -o -q ${zip} -d est/`);
  duck(`COPY (
      SELECT column0 b, column1 o, column2 dv, column4 fantasia, column10 dt,
             column11 cnae1, column12 cnae2, column13 tlog, column14 log, column15 num,
             column16 comp, column17 bai, column18 cep, column19 uf, column20 mun,
             column21 ddd1, column22 tel1, column23 ddd2, column24 tel2, column27 email
      FROM read_csv('${WORK}/est/*', delim=';', header=false, quote='\\"',
                    encoding='latin-1', all_varchar=true, strict_mode=false)
      WHERE column5 = '02' AND (column11 IN (${inList}) OR regexp_matches(coalesce(column12,''), '(${secRegex})'))
    ) TO '${WORK}/est_filtrado_${i}.parquet' (FORMAT parquet)`);
  rmSync(`${WORK}/est/`, { recursive: true, force: true });
  console.log(`✅ Estabelecimentos${i} filtrado`);
}

// ── 4. Empresas + Socios: semi-join pelos cnpj_basico filtrados ──────────────
for (let i = 0; i <= 9; i++) baixar(`Empresas${i}.zip`);
for (let i = 0; i <= 9; i++) baixar(`Socios${i}.zip`);
sh(`cd ${WORK} && rm -rf emp/ soc/ && mkdir emp soc && for z in Empresas*.zip; do unzip -o -q $z -d emp/; done && for z in Socios*.zip; do unzip -o -q $z -d soc/; done`);
baixar("Municipios.zip");
sh(`cd ${WORK} && unzip -o -q Municipios.zip -d mun/`);

duck(`
  CREATE TEMP TABLE est AS SELECT * FROM read_parquet('${WORK}/est_filtrado_*.parquet');
  CREATE TEMP TABLE emp AS
    SELECT column0 b, column1 razao, column4 capital, column5 porte
    FROM read_csv('${WORK}/emp/*', delim=';', header=false, quote='\\"', encoding='latin-1', all_varchar=true, strict_mode=false)
    WHERE column0 IN (SELECT DISTINCT b FROM est);
  CREATE TEMP TABLE soc AS
    SELECT column0 b, string_agg(column2, '; ') socios
    FROM read_csv('${WORK}/soc/*', delim=';', header=false, quote='\\"', encoding='latin-1', all_varchar=true, strict_mode=false)
    WHERE column0 IN (SELECT DISTINCT b FROM est) GROUP BY column0;
  CREATE TEMP TABLE mun AS
    SELECT column0 cod, column1 nome
    FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='\\"', encoding='latin-1', all_varchar=true);
  COPY (SELECT est.*, emp.razao, emp.capital, emp.porte, soc.socios, mun.nome AS mun_nome
        FROM est LEFT JOIN emp ON emp.b = est.b
                 LEFT JOIN soc ON soc.b = est.b
                 LEFT JOIN mun ON mun.cod = est.mun)
  TO '${WORK}/final.jsonl' (FORMAT json)`);

// ── 5. Normalizar (helpers TDD) + relatório por CNAE ──────────────────────────
const brutas = readFileSync(`${WORK}/final.jsonl`, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const porCnae = new Map<string, number>();
const linhas: RadarEmpresaRow[] = [];
for (const r of brutas) {
  const cnpj = montarCnpj(r.b ?? "", r.o ?? "", r.dv ?? "");
  if (!cnpj || !/^\d{7}$/.test(r.cnae1 ?? "")) continue;
  porCnae.set(r.cnae1, (porCnae.get(r.cnae1) ?? 0) + 1);
  linhas.push({
    cnpj,
    razao_social: normalizarTexto(r.razao), nome_fantasia: normalizarTexto(r.fantasia),
    cnae_principal: r.cnae1, cnae_descricao: mapaCnae.get(r.cnae1) ?? null,
    cnaes_secundarios: splitCnaesSecundarios(r.cnae2 ?? ""),
    data_abertura: normalizarData(r.dt ?? ""), porte: normalizarTexto(r.porte),
    capital_social: normalizarCapital(r.capital ?? ""),
    logradouro: normalizarTexto([r.tlog, r.log].filter(Boolean).join(" ")),
    numero: normalizarTexto(r.num), complemento: normalizarTexto(r.comp),
    bairro: normalizarTexto(r.bai), municipio_codigo: normalizarTexto(r.mun),
    municipio_nome: normalizarTexto(r.mun_nome), uf: normalizarTexto(r.uf),
    cep: normalizarTexto(r.cep),
    telefone1: normalizarTelefone(r.ddd1 ?? "", r.tel1 ?? ""),
    telefone2: normalizarTelefone(r.ddd2 ?? "", r.tel2 ?? ""),
    email: normalizarTexto(r.email)?.toLowerCase() ?? null,
    socios_nomes: normalizarTexto(r.socios),
  });
}
console.log(`\n📊 ${linhas.length} empresas após filtro/normalização`);
for (const [c, n] of [...porCnae.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`   ${c}  ${String(n).padStart(7)}  ${mapaCnae.get(c)?.slice(0, 60) ?? ""}`);
const zerados = cnaes.filter((c) => !porCnae.has(c));
if (zerados.length) console.warn(`⚠️ CNAEs com 0 matches (conferir): ${zerados.join(", ")}`);

// ── 6. Municípios RFB + lat/lng IBGE (casamento por nome normalizado) ─────────
const ibge = readFileSync("scripts/radar/municipios-ibge.csv", "utf-8").split("\n").slice(1).filter(Boolean);
const UF_POR_CODIGO: Record<string, string> = { "11":"RO","12":"AC","13":"AM","14":"RR","15":"PA","16":"AP","17":"TO","21":"MA","22":"PI","23":"CE","24":"RN","25":"PB","26":"PE","27":"AL","28":"SE","29":"BA","31":"MG","32":"ES","33":"RJ","35":"SP","41":"PR","42":"SC","43":"RS","50":"MS","51":"MT","52":"GO","53":"DF" };
const latPorChave = new Map<string, { lat: number; lng: number }>();
for (const l of ibge) {
  const [_, nome, lat, lng, , uf_cod] = l.split(","); // codigo_ibge,nome,latitude,longitude,capital,codigo_uf,siafi_id
  const uf = UF_POR_CODIGO[uf_cod?.trim() ?? ""] ?? "";
  if (nome && uf) latPorChave.set(normalizarChaveMunicipio(nome, uf), { lat: +lat, lng: +lng });
}
const ufPorMunCodigo = new Map<string, string>();
for (const r of linhas) if (r.municipio_codigo && r.uf) ufPorMunCodigo.set(r.municipio_codigo, r.uf);
const municipiosRfb: { cod: string; nome: string }[] = JSON.parse(duck(
  `SELECT column0 cod, column1 nome FROM read_csv('${WORK}/mun/*', delim=';', header=false, quote='\\"', encoding='latin-1', all_varchar=true)`));
let semLatLng = 0;
const municipios: RadarMunicipioRow[] = municipiosRfb.map((m) => {
  const uf = ufPorMunCodigo.get(m.cod) ?? "";
  const hit = uf ? latPorChave.get(normalizarChaveMunicipio(m.nome, uf)) : undefined;
  if (uf && !hit) semLatLng++;
  return { codigo: m.cod, nome: m.nome, uf, lat: hit?.lat ?? null, lng: hit?.lng ?? null };
}).filter((m) => m.uf); // só municípios que aparecem no nosso universo
console.log(`🗺️  municípios do universo: ${municipios.length} (${semLatLng} sem lat/lng — mapa os ignora)`);

if (DRY) { console.log("🏁 dry-run: nada enviado"); process.exit(0); }

// ── 7. POST em chunks ─────────────────────────────────────────────────────────
const post = async (body: unknown) => {
  for (let t = 1; t <= 4; t++) {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": SECRET },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const txt = await res.text();
    if (t === 4) throw new Error(`POST falhou (${res.status}): ${txt}`);
    console.warn(`tentativa ${t} falhou (${res.status}), retry…`);
    await new Promise((r) => setTimeout(r, 800 * 2 ** t));
  }
};
await post({ action: "begin_lote", mes: MES });
for (let i = 0; i < municipios.length; i += 1000)
  await post({ action: "chunk_municipios", mes: MES, linhas: municipios.slice(i, i + 1000) });
for (let i = 0; i < linhas.length; i += 1000) {
  await post({ action: "chunk", mes: MES, linhas: linhas.slice(i, i + 1000) });
  if ((i / 1000) % 25 === 0) console.log(`… ${i}/${linhas.length}`);
}
const fin = await post({ action: "finalize", mes: MES });
console.log(`\n🏁 finalize:`, JSON.stringify(fin));
```

- [ ] **Step 2: Validar o pipeline a seco (sem rede pro banco)**

Run: `df -h / | tail -1 && which duckdb || brew install duckdb`
Depois: `bun scripts/radar/carga.ts --mes 2026-05 --dry-run` (usa o mês mais recente publicado; se a descoberta de URL falhar, seguir a instrução de erro do próprio script — essa descoberta É um objetivo da task).
Expected: relatório `📊 N empresas` com contagem por CNAE, ~N entre 150k–600k. **Se >1M:** parar e apertar a curadoria com o founder antes da carga real (gate da spec §5).

- [ ] **Step 3: Commit**

```bash
git add scripts/radar/carga.ts
git commit -m "feat(radar): script de carga local — download RFB + DuckDB + chunks pro radar-ingest"
```

---

### Task 7: CI verde + PR

- [ ] **Step 1: Gates locais**

Run: `heavy bun run typecheck && heavy bun run test 2>&1 | tail -3 && bun lint 2>&1 | tail -3`
Expected: typecheck limpo; vitest todos passando; lint sem errors. (⚠️ nunca `| tail` quando o exit code decidir um gate encadeado — rodar separado como acima.)

- [ ] **Step 2: Regenerar audit de migrations**

Run: `bun run audit:migrations`
Expected: `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql` atualizados com a `20260610200000`.

- [ ] **Step 3: PR**

```bash
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(radar): regenera audit de migrations"
git push -u origin HEAD
gh pr create --title "feat(radar): Fatia 1 — fundação de dados do Radar de Clientes (prospecção estilo Omie)" \
  --body "Spec: docs/superpowers/specs/2026-06-10-radar-clientes-design.md (fatia 1/4).

**ATENÇÃO: migration manual necessária** — \`20260610200000_radar_fundacao.sql\` (4 tabelas + RLS + recruza). SQL no chat da sessão.
**Edge nova:** \`radar-ingest\` — deploy via chat do Lovable (verbatim da main) após o merge.
Validação: PG17 local (db/test-radar-fundacao.sh, asserts A1-A5) + vitest helpers.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --squash --auto
```

---

### Task 8: Rollout + 1ª carga real (pós-merge, com o founder)

- [ ] **Step 1: Entregar a migration inline no chat** (BLOCO único, fenced ```sql, query de validação no final, tag de fechamento em linha própria — preferências §5 do CLAUDE.md). Founder cola no SQL Editor → confirma `RADAR FUNDACAO OK | tabelas_4=4 | policies_4=4 | funcao_1=1`.

- [ ] **Step 2: Deploy da edge** — prompt pro chat do Lovable: "Create a new Supabase edge function named `radar-ingest`, reading the code verbatim from `supabase/functions/radar-ingest/index.ts` on main. Do not modify the code." Confirmar **Active** na UI Cloud.

- [ ] **Step 3: Obter o CRON_SECRET** — founder roda no SQL Editor: `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1;` e cola o valor no chat da sessão (uso local, não fica em arquivo).

- [ ] **Step 4: Carga real**

Run:
```bash
RADAR_INGEST_URL="https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/radar-ingest" \
RADAR_CRON_SECRET="<valor do Vault>" \
bun scripts/radar/carga.ts --mes <YYYY-MM mais recente publicado>
```
Expected: chunks 100% enviados; `finalize` retorna `{ok, total≈N do dry-run, novos=total}` (1º lote: tudo é novo — baseline esperado).

- [ ] **Step 5: Validar no banco com o founder** (query pro SQL Editor)

```sql
SELECT 'CARGA OK' AS status,
  (SELECT count(*) FROM radar_empresas) AS empresas,
  (SELECT count(*) FROM radar_empresas WHERE ja_cliente) AS ja_clientes,
  (SELECT count(*) FROM radar_empresas WHERE uf='MG') AS mg,
  (SELECT count(*) FROM radar_municipios WHERE lat IS NOT NULL) AS municipios_com_latlng,
  (SELECT status FROM radar_ingest_state ORDER BY mes_referencia DESC LIMIT 1) AS ultimo_lote_status,
  pg_size_pretty(pg_total_relation_size('radar_empresas')) AS tamanho_tabela;
```
Reportar ao founder: total, MG, já-clientes detectados, tamanho real da tabela (spec §5: estimativa 200–600MB — confirmar). `ja_clientes > 0` é o smoke do recruza com dado real.

- [ ] **Step 6: Atualizar roadmap + CLAUDE.md** com o resultado (contagens reais, URL real do dump descoberta) e marcar a fatia 1 ✅. Fatias 2-4 ganham plano próprio (writing-plans) na sequência.

---

## Self-review (feita na escrita)

- **Cobertura da spec (fatia 1):** tabelas §3.2 ✅ (Task 1) · recruza §3.5 ✅ (Task 1/A1-A2) · edge §3.4 ✅ (Task 5) · pipeline §3.1 ✅ (Tasks 4/6) · curadoria versionada ✅ (Task 4) · 1ª carga manual + gate de volume §5 ✅ (Tasks 6/8). RPCs de contato/mapa = fatias 2-3 (explícito no escopo).
- **Preservação de estado no upsert:** definida 2× de propósito (payload por omissão na edge; assert A3 no PG17).
- **Tipos consistentes:** `RadarEmpresaRow` (Task 3) == payload da edge (Task 5) == colunas da migration (Task 1), conferidos campo a campo.
- **Incerteza honesta:** URL do dump pós-jan/2026 — descoberta com candidatos + abort instrutivo é PARTE da Task 6/8, não suposição.

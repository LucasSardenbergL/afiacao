# PCP Fase 1B-M2 — Modelo de dados do corte múltiplo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para implementar task-a-task. Steps usam checkbox (`- [ ]`).
> **v2** — incorpora as decisões do founder (2026-07-05: perda por absorção · rota paramétrica · derivar rotas reais) + correção P1 da lente Claude do painel (INVOKER, custo não vaza) + chave de rota corrigida (múltiplas decomposições por base).

**Goal:** Modelar a **rota alternativa de corte múltiplo** (coproduto obrigatório + rateio de custo) na BOM, fechando a **Fundação (Fase 1)** — SEM motor de sugestão (Fase 3) e SEM backflush/outbox (Fase 2).

**Architecture:** Duas tabelas — `pcp_bom_rotas` (rota por `linha_modelo` + `largura_base_mm` + `largura_alvo_mm`) e `pcp_bom_rota_saidas` (as N saídas físicas com fração de rateio) — mais um helper de rateio-default por área (perda **absorvida** pelas boas), uma **CONSTRAINT TRIGGER DEFERRED** que garante os invariantes de agregação (Σfração=1, geometria, ≥1 principal na largura-alvo), a função de rateio de custo `fn_pcp_ratear_corte` (**SECURITY INVOKER** — a RLS staff barra o não-staff, custo não vaza), a RPC de cadastro staff-gated, e a **derivação** das rotas reais a partir das larguras da 1A. Top risk do Gate 0 endereçado: *"corte múltiplo sem coproduto distorcendo estoque/custo"*.

**Tech Stack:** PostgreSQL (Supabase/Lovable). SQL puro aplicado no SQL Editor. Prova PG17 local descartável (`db/test-*.sh`), com falsificação (Lei de Ferro).

**Fora de escopo (explícito):** motor que *sugere* a rota por demanda/estoque-alvo (Fase 3); backflush fiscal e outbox incluir/concluir OP no Omie (Fase 2, §1.14 — nativo do Omie); apontamento (M1, pronto).

---

## Contexto — onde o M2 se encaixa

A **Fase 1 (Fundação)** tem 6 componentes: 1. Dados mestres ✅ · 2. Parser ✅ · 3. BOM paramétrica ✅ · 4. OP+etapas ✅ (M1) · 5. Apontamento offline c/ consumo-motivo ✅ (M1/M3) · 6. **Modelo de dados do corte múltiplo ⏳ ← ESTE M2**. Concluído, a Fundação fecha; o próximo é a **Fase 2** (Custo & Omie).

### O domínio (spec §1, §1.9, Camada 0.4, endurecimento #4)
> "Corte múltiplo condicional — cinta de 50mm é produzida em **150mm e fatiada em 3** (mais rápido)."

Duas rotas: **padrão** (a BOM da 1A — rolo da própria largura → 1 cinta) e **corte múltiplo** (ESTE M2 — rolo mais largo → N unidades de uma passada). O modelo crava (o *motor* que aplica é F3):
- **Coproduto obrigatório:** 150÷3=3 saídas; podem ser o mesmo SKU (3×50) ou larguras diferentes (100+50). Nunca "somem".
- **Sobra explícita** (`sobra`): refilo aproveitável vira estoque; **paramétrico** — a rota guarda a largura, o SKU concreto resolve na OP (F3, decisão do founder).
- **Perda** (`perda`): refilo-lixo **não some** — seu custo é **absorvido pelas saídas boas** (encarece a cinta boa; custeio por absorção, decisão do founder).
- **Rateio:** custo unitário = custo do rolo-base **rateado pelas saídas boas** (por área; Σfração=1 — nada de custo evapora).

### Decisões do founder (2026-07-05) — antes eram Pontos Abertos
1. **Custo da perda → ABSORÇÃO:** a perda tem `fracao_rateio=0`; seu custo é redistribuído nas saídas boas (encarece a cinta boa). Conta de refugo separada só existe na Fase 2.
2. **Sobra → PARAMÉTRICO:** a rota guarda `largura_saida_mm`; o SKU concreto e o estoque da sobra resolvem quando a OP roda (Fase 3). O schema F1 não referencia `omie_products` (não impede a F3 de fazê-lo).
3. **Seed → DERIVAR:** `fn_pcp_derivar_rotas_simples` gera as rotas de fator inteiro (L'=k·L, mesma linha) das larguras reais da 1A. O M2 nasce com dados. (Rotas mistas = cadastro manual/F3.)

### Decisão de projeto da lente Claude (painel, modo degradado — Codex/Gemini pendentes do ambiente)
- **P1 corrigido:** `fn_pcp_ratear_corte` é **SECURITY INVOKER** (não DEFINER) — a RLS staff-only da tabela barra o não-staff; **custo não vaza para vendedor** (CLAUDE.md "RLS pra vendedor não ver custo").
- **Schema corrigido:** chave natural da rota = `(linha, largura_base, largura_alvo)` — a base 150 admite decomposições distintas (3×50 e 2×75) como rotas separadas. A `UNIQUE(linha, largura_base)` do rascunho v1 as colidiria.
- **Nota mantida p/ o painel completo:** conservação exata do custo sob arredondamento (Task 4 Step 1 joga o resíduo na maior saída); Codex/Gemini ainda passam sobre o plano v2 antes do SQL final.

### Convenções da casa (herdadas do M1)
`CREATE TABLE IF NOT EXISTS`, `DROP POLICY/TRIGGER IF EXISTS` (idempotável). `REVOKE ... FROM anon, authenticated` por nome. SECURITY DEFINER com `SET search_path=public`, gate por `auth.uid()`. Toda `pcp_%` com RLS fail-closed (staff=master|employee). Prova PG17 **executando** (late-bound), asserts negativos com SQLSTATE + **falsificação**.

---

## File Structure
- **Create:** `db/pcp-f1b-m2-corte-multiplo.sql` — migration (founder cola no SQL Editor).
- **Create:** `db/test-pcp-f1b-m2-corte-multiplo.sh` — prova PG17 (harness padrão + fixtures reais + falsificação).
- **Modify:** `docs/historico/pcp.md` — entrega + fecho da Fase 1.

Sem frontend/edge neste M2.

---

## Task 1: Schema — rotas (com largura-alvo) e saídas

**Files:** Create `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Cabeçalho + tabelas**

```sql
-- PCP Fase 1B — M2: modelo de dados do corte múltiplo (rota alternativa + coproduto + rateio).
-- ÚLTIMO componente da Fundação (Fase 1). NÃO inclui motor (Fase 3) nem backflush/outbox (Fase 2).
-- Decisões founder 2026-07-05: perda por ABSORÇÃO · sobra PARAMÉTRICA (SKU na F3) · rotas DERIVADAS.
-- Aplicar no SQL Editor do Lovable. NUNCA em supabase/migrations/. Re-colar é esperado (idempotável).
BEGIN;

-- 1) Rota alternativa por (linha, largura-base do rolo, largura-alvo principal). A base 150 admite
--    decomposições distintas (150->3x50 e 150->2x75) como rotas SEPARADAS => a alvo entra na chave.
CREATE TABLE IF NOT EXISTS public.pcp_bom_rotas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  linha_modelo    text NOT NULL,
  largura_base_mm int  NOT NULL CHECK (largura_base_mm > 0),   -- largura do rolo que entra
  largura_alvo_mm int  NOT NULL CHECK (largura_alvo_mm > 0),   -- largura PRINCIPAL produzida
  ativa           boolean NOT NULL DEFAULT true,
  nota            text,
  CHECK (largura_alvo_mm < largura_base_mm),                   -- corte múltiplo: alvo cabe na base
  UNIQUE (linha_modelo, largura_base_mm, largura_alvo_mm)
);

-- 2) Saídas físicas (principal + coproduto + sobra + perda). Invariantes de AGREGAÇÃO por rota
--    (Σfração=1, geometria, >=1 principal casando a largura-alvo) via CONSTRAINT TRIGGER DEFERRED (Task 3).
CREATE TABLE IF NOT EXISTS public.pcp_bom_rota_saidas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rota_id         bigint NOT NULL REFERENCES public.pcp_bom_rotas(id) ON DELETE CASCADE,
  largura_saida_mm int  NOT NULL CHECK (largura_saida_mm > 0),
  quantidade      int  NOT NULL CHECK (quantidade > 0),        -- quantas cintas dessa largura saem
  papel           text NOT NULL CHECK (papel IN ('principal','coproduto','sobra','perda')),
  fracao_rateio   numeric NOT NULL CHECK (fracao_rateio >= 0 AND fracao_rateio <= 1),  -- perda=0
  UNIQUE (rota_id, largura_saida_mm, papel)
);
CREATE INDEX IF NOT EXISTS idx_pcp_rota_saidas_rota ON public.pcp_bom_rota_saidas (rota_id);
```

- [ ] **Step 2:** não fechar o `BEGIN` — Tasks 2–6 adicionam funções/trigger/RLS antes do `COMMIT`.

---

## Task 2: Helper de rateio-default por área (perda absorvida)

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1:**

```sql
-- 3) Rateio DEFAULT por área (largura×qtd). Perda absorve 0 — custo redistribuído nas boas (papel<>'perda'):
--    ABSORÇÃO (decisão do founder). Cada boa = area_boa / Σarea_boa => Σfração(boas)=1 por construção.
CREATE OR REPLACE FUNCTION public.fn_pcp_rota_fracao_default(p_rota_id bigint)
RETURNS TABLE(saida_id bigint, fracao numeric) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH base AS (
    SELECT id, (largura_saida_mm * quantidade)::numeric AS area, papel
      FROM pcp_bom_rota_saidas WHERE rota_id = p_rota_id
  ), uteis AS (SELECT sum(area) AS tot FROM base WHERE papel <> 'perda')
  SELECT b.id, CASE WHEN b.papel = 'perda' THEN 0
                    ELSE round(b.area / NULLIF(u.tot, 0), 6) END
    FROM base b CROSS JOIN uteis u;
$$;
```

---

## Task 3: Invariantes de agregação — CONSTRAINT TRIGGER DEFERRED

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1:**

```sql
-- 4) Invariantes cross-row (valida no COMMIT — o cadastro insere rota+saídas na mesma tx antes de checar).
CREATE OR REPLACE FUNCTION public.fn_pcp_validar_rota() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_rota bigint := COALESCE(NEW.rota_id, OLD.rota_id);
  v_base int; v_alvo int; v_uteis int; v_frac numeric; v_princ int;
BEGIN
  SELECT largura_base_mm, largura_alvo_mm INTO v_base, v_alvo FROM pcp_bom_rotas WHERE id = v_rota;
  IF v_base IS NULL THEN RETURN NULL; END IF;                 -- rota apagada (cascade)
  SELECT COALESCE(sum(largura_saida_mm * quantidade), 0),
         COALESCE(sum(fracao_rateio), 0),
         COALESCE(count(*) FILTER (WHERE papel = 'principal' AND largura_saida_mm = v_alvo), 0)
    INTO v_uteis, v_frac, v_princ
    FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;
  IF v_princ < 1 THEN
    RAISE EXCEPTION 'rota %: exige >=1 saida principal na largura-alvo %mm', v_rota, v_alvo USING ERRCODE='check_violation';
  END IF;
  IF v_uteis > v_base THEN
    RAISE EXCEPTION 'rota %: saidas (%mm) excedem a base (%mm)', v_rota, v_uteis, v_base USING ERRCODE='check_violation';
  END IF;
  IF round(v_frac, 4) <> 1.0000 THEN
    RAISE EXCEPTION 'rota %: soma fracao=% (<>1, custo nao conservado)', v_rota, v_frac USING ERRCODE='check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pcp_rota_saidas_valida ON public.pcp_bom_rota_saidas;
CREATE CONSTRAINT TRIGGER pcp_rota_saidas_valida
  AFTER INSERT OR UPDATE OR DELETE ON public.pcp_bom_rota_saidas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_pcp_validar_rota();
```

---

## Task 4: Rateio de custo (INVOKER) + RPC de cadastro + derivação

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Rateio de custo — SECURITY INVOKER (P1: custo não vaza), com resíduo na maior saída**

```sql
-- 5) Rateio: distribui o custo do rolo pelas saídas boas. INVOKER => roda com as permissões do chamador,
--    a RLS staff-only da tabela barra o não-staff (custo não vaza). Resíduo do arredondamento vai na
--    MAIOR saída boa (window) => Σcusto_total == p_custo_base exato (conservação de custo).
CREATE OR REPLACE FUNCTION public.fn_pcp_ratear_corte(p_rota_id bigint, p_custo_base numeric)
RETURNS TABLE(largura_saida_mm int, papel text, quantidade int, custo_total numeric, custo_unitario numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  WITH boas AS (
    SELECT largura_saida_mm, papel, quantidade,
           round(p_custo_base * fracao_rateio, 4) AS ct,
           row_number() OVER (ORDER BY largura_saida_mm * quantidade DESC, largura_saida_mm DESC) AS rn
      FROM pcp_bom_rota_saidas WHERE rota_id = p_rota_id AND papel <> 'perda'
  ), resid AS (SELECT round(p_custo_base - sum(ct), 4) AS r FROM boas)
  SELECT b.largura_saida_mm, b.papel, b.quantidade,
         (b.ct + CASE WHEN b.rn = 1 THEN (SELECT r FROM resid) ELSE 0 END) AS custo_total,
         round((b.ct + CASE WHEN b.rn = 1 THEN (SELECT r FROM resid) ELSE 0 END) / b.quantidade, 4) AS custo_unitario
    FROM boas b ORDER BY b.largura_saida_mm DESC;
$$;
```

- [ ] **Step 2: RPC de cadastro (staff-gate fail-closed; fração default quando omitida)**

```sql
-- 6) Cadastro transacional de rota + saídas. Fração NULL/0 => default por área. Gate por auth.uid().
CREATE OR REPLACE FUNCTION public.fn_pcp_cadastrar_rota(
  p_linha text, p_largura_base int, p_largura_alvo int, p_saidas jsonb, p_nota text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := (SELECT auth.uid()); v_rota bigint; s jsonb; v_frac numeric;
BEGIN
  IF v_uid IS NULL OR NOT (has_role(v_uid,'master'::app_role) OR has_role(v_uid,'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_cadastrar_rota: apenas staff';
  END IF;
  INSERT INTO pcp_bom_rotas (linha_modelo, largura_base_mm, largura_alvo_mm, nota)
    VALUES (p_linha, p_largura_base, p_largura_alvo, p_nota)
    ON CONFLICT (linha_modelo, largura_base_mm, largura_alvo_mm) DO UPDATE SET nota=EXCLUDED.nota, ativa=true
    RETURNING id INTO v_rota;
  DELETE FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;
  FOR s IN SELECT * FROM jsonb_array_elements(p_saidas) LOOP
    v_frac := NULLIF(s->>'fracao_rateio','')::numeric;
    INSERT INTO pcp_bom_rota_saidas (rota_id, largura_saida_mm, quantidade, papel, fracao_rateio)
      VALUES (v_rota, (s->>'largura_saida_mm')::int, (s->>'quantidade')::int, s->>'papel', COALESCE(v_frac,0));
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pcp_bom_rota_saidas WHERE rota_id=v_rota AND fracao_rateio>0) THEN
    UPDATE pcp_bom_rota_saidas t SET fracao_rateio = d.fracao
      FROM fn_pcp_rota_fracao_default(v_rota) d WHERE d.saida_id = t.id;
  END IF;
  RETURN v_rota;                                              -- trigger DEFERRED valida no COMMIT
END $$;
```

- [ ] **Step 3: Derivação das rotas reais (fator inteiro, das larguras da 1A)**

```sql
-- 7) Seed: para cada (linha, L alvo) e (mesma linha, L' base) com L'=k·L (k>=2), cria a rota simples
--    (1 saída principal L, quantidade k, fração 1). Fonte = larguras REAIS parseadas em pcp_itens (1A).
--    Só fator inteiro/mesma largura de saída (o caso da spec). Rotas mistas = cadastro manual/F3.
CREATE OR REPLACE FUNCTION public.fn_pcp_derivar_rotas_simples()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_rota bigint; n int := 0;
BEGIN
  FOR r IN
    SELECT a.linha_modelo, a.largura_mm AS l_alvo, b.largura_mm AS l_base, (b.largura_mm/a.largura_mm) AS k
      FROM (SELECT DISTINCT linha_modelo, largura_mm FROM pcp_itens WHERE tipo_item='cinta' AND largura_mm>0) a
      JOIN (SELECT DISTINCT linha_modelo, largura_mm FROM pcp_itens WHERE tipo_item='cinta' AND largura_mm>0) b
        ON a.linha_modelo=b.linha_modelo AND b.largura_mm > a.largura_mm AND b.largura_mm % a.largura_mm = 0
  LOOP
    INSERT INTO pcp_bom_rotas (linha_modelo, largura_base_mm, largura_alvo_mm, nota)
      VALUES (r.linha_modelo, r.l_base, r.l_alvo, 'derivada F1B-M2')
      ON CONFLICT (linha_modelo, largura_base_mm, largura_alvo_mm) DO NOTHING RETURNING id INTO v_rota;
    IF v_rota IS NOT NULL THEN
      INSERT INTO pcp_bom_rota_saidas (rota_id, largura_saida_mm, quantidade, papel, fracao_rateio)
        VALUES (v_rota, r.l_alvo, r.k, 'principal', 1.0);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;
```

---

## Task 5: RLS + grants

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1:**

```sql
-- 8) RLS staff-read. Cadastro/derivação escrevem via RPC SECURITY DEFINER (gated) => sem grant de DML.
ALTER TABLE public.pcp_bom_rotas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_rota_saidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pcp_rotas_sel ON public.pcp_bom_rotas;
CREATE POLICY pcp_rotas_sel ON public.pcp_bom_rotas FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
DROP POLICY IF EXISTS pcp_rota_saidas_sel ON public.pcp_bom_rota_saidas;
CREATE POLICY pcp_rota_saidas_sel ON public.pcp_bom_rota_saidas FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
REVOKE ALL ON public.pcp_bom_rotas, public.pcp_bom_rota_saidas FROM anon, authenticated;
GRANT SELECT ON public.pcp_bom_rotas, public.pcp_bom_rota_saidas TO authenticated;

-- Funções: fechar EXECUTE de PUBLIC; conceder o necessário. ratear_corte é INVOKER (RLS da tabela protege).
REVOKE ALL ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_pcp_cadastrar_rota(text,int,int,jsonb,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_derivar_rotas_simples() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric) TO authenticated;  -- RLS barra não-staff
GRANT EXECUTE ON FUNCTION public.fn_pcp_cadastrar_rota(text,int,int,jsonb,text) TO authenticated;
-- fn_pcp_derivar_rotas_simples: sem grant a authenticated (chamada 1× por staff/seed via SQL Editor).
-- fn_pcp_rota_fracao_default / fn_pcp_validar_rota: sem grant (internas).

COMMIT;
```

---

## Task 6: Prova PG17 (com falsificação)

**Files:** Create `db/test-pcp-f1b-m2-corte-multiplo.sh`

Harness padrão (initdb PG17 descartável; roles `anon/authenticated`; stub `auth.uid()`/`has_role`/`user_roles` com staff `...aaaa` e não-staff `...bbbb`; `Pq(){ P -tA -q "$@"; }`; **stub `pcp_itens`** com cintas reais p/ a derivação). Aplicar a migration REAL 2×. Asserts:

- [ ] **Step 1: Rateio simples 150→3×50 (custo R$30 → 10 cada)**

```bash
eq "cadastro 150->3x50 retorna rota_id" "$(Pq -c "SELECT fn_pcp_cadastrar_rota('2909',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\"}]'::jsonb)>0")" "t"
eq "fração default principal = 1.0" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='2909' AND r.largura_base_mm=150")" "1.0000"
eq "custo_unitario R\$30/3 = 10" "$(Pq -c "SELECT custo_unitario FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='2909' AND largura_base_mm=150 AND largura_alvo_mm=50),30)")" "10.0000"
```

- [ ] **Step 2: Duas decomposições da MESMA base (150→3×50 e 150→2×75 coexistem — a chave permite)**

```bash
Pq -c "SELECT fn_pcp_cadastrar_rota('2909',150,75,'[{\"largura_saida_mm\":75,\"quantidade\":2,\"papel\":\"principal\"}]'::jsonb)" >/dev/null
eq "2 rotas distintas para base 150 da linha 2909" "$(Pq -c "SELECT count(*) FROM pcp_bom_rotas WHERE linha_modelo='2909' AND largura_base_mm=150")" "2"
```

- [ ] **Step 3: Rateio misto 150→100+50 (área 2/3 e 1/3; custo_total de R$90)**

```bash
Pq -c "SELECT fn_pcp_cadastrar_rota('KA169',150,100,'[{\"largura_saida_mm\":100,\"quantidade\":1,\"papel\":\"principal\"},{\"largura_saida_mm\":50,\"quantidade\":1,\"papel\":\"coproduto\"}]'::jsonb)" >/dev/null
eq "fração 100mm = 2/3" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='KA169' AND s.largura_saida_mm=100")" "0.6667"
eq "conservação: Σcusto_total de R\$90 == 90 (resíduo na maior)" "$(Pq -c "SELECT sum(custo_total) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='KA169'),90)")" "90.0000"
```

- [ ] **Step 4: Perda absorvida — 140→2×50 + 40 perda (principal absorve 100%)**

```bash
Pq -c "SELECT fn_pcp_cadastrar_rota('XZ667',140,50,'[{\"largura_saida_mm\":50,\"quantidade\":2,\"papel\":\"principal\"},{\"largura_saida_mm\":40,\"quantidade\":1,\"papel\":\"perda\"}]'::jsonb)" >/dev/null
eq "perda tem fração 0" "$(Pq -c "SELECT fracao_rateio FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='perda'")" "0"
eq "principal absorve 100%" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='principal'")" "1.0000"
eq "rateio ignora a perda (1 linha boa)" "$(Pq -c "SELECT count(*) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='XZ667'),50)")" "1"
```

- [ ] **Step 5: Derivação das larguras reais (stub pcp_itens: 2909 tem 50 e 150 → deriva 150→3×50)**

```bash
# fixtures em pcp_itens: (2909,50),(2909,150),(2909,100) => 150%50=0 k3, 100%50=0 k2, 150%100!=0
eq "derivar cria as rotas de fator inteiro" "$(Pq -c "SELECT fn_pcp_derivar_rotas_simples()>0")" "t"
eq "existe rota derivada 2909 base150 alvo50 k3" "$(Pq -c "SELECT quantidade FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='2909' AND r.largura_base_mm=150 AND r.largura_alvo_mm=50 AND r.nota='derivada F1B-M2'")" "3"
```

- [ ] **Step 6: Invariantes negativos (SQLSTATE) — cada um BARRA**

```bash
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"coproduto\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"principal"*) ok "sem principal na alvo => barra";; *) bad "sem principal NÃO barrou: $ERR";; esac
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":4,\"papel\":\"principal\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"excedem"*) ok "geometria (4x50>150) => barra";; *) bad "excesso NÃO barrou: $ERR";; esac
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,50,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\",\"fracao_rateio\":0.9}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"conservado"*) ok "Σfração<>1 => barra";; *) bad "fração ruim NÃO barrou: $ERR";; esac
ERR=$(P -tA -c "INSERT INTO pcp_bom_rotas(linha_modelo,largura_base_mm,largura_alvo_mm) VALUES('BAD',50,150);" 2>&1 || true)
case "$ERR" in *"check"*|*"violates"*) ok "alvo>base => CHECK barra";; *) bad "alvo>base NÃO barrou: $ERR";; esac
```

- [ ] **Step 7: RLS + gate + INVOKER (custo não vaza)**

```bash
eq "2 tabelas de rota com RLS" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pcp_bom_rotas','pcp_bom_rota_saidas') AND c.relrowsecurity")" "2"
eq "staff vê rotas" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_bom_rotas")" "t"
eq "não-staff vê 0 rotas (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_bom_rotas")" "0"
# P1: INVOKER => não-staff não vê rateio (a RLS da tabela zera o SELECT interno)
eq "não-staff NÃO vê custo via ratear_corte (INVOKER)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas LIMIT 1),100)")" "0"
NS=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_cadastrar_rota('X',150,50,'[]'::jsonb);" 2>&1 || true)
case "$NS" in *"apenas staff"*) ok "não-staff barrado no cadastro";; *) bad "não-staff NÃO barrado: $NS";; esac
```

- [ ] **Step 8: FALSIFICAÇÃO (Lei de Ferro)** — sabotar e exigir vermelho:
  - Comentar `IF round(v_frac,4) <> 1.0000` em `fn_pcp_validar_rota` → Step 6 (fração 0.9) deve **falhar**. Reverter.
  - Trocar `SECURITY INVOKER` por `SECURITY DEFINER` em `fn_pcp_ratear_corte` → Step 7 ("não-staff NÃO vê custo") deve **falhar** (DEFINER bypassa RLS → não-staff veria). Reverter.
  - Trocar `papel <> 'perda'` por `1=1` em `fn_pcp_ratear_corte` → Step 4 (ignora perda) deve **falhar**. Reverter.
  - Documentar no cabeçalho do teste que a suíte foi falsificada.

- [ ] **Step 9: Rodar verde**

Run: `heavy bash db/test-pcp-f1b-m2-corte-multiplo.sh > /tmp/t-m2.log 2>&1; echo "exit=$?"`
Expected: `RESULTADO: PASS=N FAIL=0` e `exit=0`.

- [ ] **Step 10: Commit**

```bash
git add db/pcp-f1b-m2-corte-multiplo.sql db/test-pcp-f1b-m2-corte-multiplo.sh
git commit -m "feat(pcp): F1B-M2 — modelo de dados do corte múltiplo (rota+coproduto+rateio, absorção, INVOKER) + prova PG17"
```

---

## Task 7: Diário + fecho da Fase 1

**Files:** Modify `docs/historico/pcp.md`

- [ ] **Step 1:** Seção "Fase 1B-M2 — Corte múltiplo": tabelas, chave `(linha,base,alvo)`, invariantes, decisões do founder (absorção/paramétrico/derivar), P1 do painel (INVOKER), PASS=N. Registrar que **a Fundação (Fase 1) fechou** — próximo é a Fase 2 (Custo & Omie).
- [ ] **Step 2:** Commit.

---

## Deploy (founder, manual — depois do merge)

Só **1 camada** (SQL — sem frontend/edge):
1. Abrir `db/pcp-f1b-m2-corte-multiplo.sql`, copiar tudo, colar no SQL Editor → Run. Esperado *"Success. No rows returned"*. Idempotável.
2. **Rodar a derivação 1×:** `SELECT fn_pcp_derivar_rotas_simples();` no SQL Editor (popula as rotas reais). Retorna o nº de rotas criadas.
3. Verificação minha (psql-ro): 2 tabelas c/ RLS, constraint trigger presente, nº de rotas derivadas, um rateio conferido.

---

## Self-Review (checklist do autor)

- **Spec coverage:** §1.9 (rota+coproduto+rateio, modelo completo F1) ✅ Tasks 1–4; endurecimento #4 (coproduto obrigatório, sobra explícita, custo rateado) ✅ Task 3; top risk "corte múltiplo sem coproduto distorcendo custo" ✅ Σfração=1 + perda absorvida + conservação exata (resíduo na maior).
- **Decisões do founder incorporadas:** absorção ✅ Task 2/4-Step1 · paramétrico ✅ (schema por largura, sem FK a omie_products) · derivar ✅ Task 4-Step3 + prova Step 5.
- **P1 do painel corrigido:** ratear_corte INVOKER ✅ Task 4-Step1 + falsificação Step 8.
- **Fora de escopo:** motor (F3) e backflush/outbox (F2) — sem task. ✅
- **Type consistency:** `fn_pcp_cadastrar_rota(text,int,int,jsonb,text)` (5 args, com largura_alvo) idêntico em REVOKE/GRANT ✅; `fn_pcp_ratear_corte(bigint,numeric)` ✅.
- **Pendente:** Codex+Gemini sobre o plano v2 (painel completo) quando o ambiente do Bash estabilizar — antes do SQL final.

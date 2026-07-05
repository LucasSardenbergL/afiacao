# PCP Fase 1B-M2 — Modelo de dados do corte múltiplo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development para implementar task-a-task. Steps usam checkbox (`- [ ]`).

**Goal:** Modelar a **rota alternativa de corte múltiplo** (coproduto obrigatório + rateio de custo) na BOM, fechando a **Fundação (Fase 1)** — SEM motor de sugestão (Fase 3) e SEM backflush/outbox (Fase 2).

**Architecture:** Duas tabelas — `pcp_bom_rotas` (rota por `linha_modelo` + `largura_base_mm`) e `pcp_bom_rota_saidas` (as N saídas físicas com fração de rateio) — mais um helper de rateio-default por área, uma **CONSTRAINT TRIGGER DEFERRED** que garante os invariantes de agregação (Σfração=1, geometria, ≥1 principal), a função de rateio de custo `fn_pcp_ratear_corte`, e uma RPC de cadastro staff-gated. Sem consumidor até a Fase 3 — o valor é o modelo **nascer certo** (arbitragem do founder, divergência A) para não remodelar a BOM/custo depois. Top risk do Gate 0 endereçado: *"corte múltiplo sem coproduto distorcendo estoque/custo"*.

**Tech Stack:** PostgreSQL (Supabase/Lovable). SQL puro aplicado no SQL Editor. Prova PG17 local descartável (`db/test-*.sh`), com falsificação (Lei de Ferro).

**Fora de escopo (explícito):** motor que *sugere* a rota por demanda/estoque-alvo (Fase 3); backflush fiscal e outbox incluir/concluir OP no Omie (Fase 2, §1.14 — nativo do Omie); apontamento (M1, pronto).

---

## Contexto — onde o M2 se encaixa

A **Fase 1 (Fundação)** tem 6 componentes (spec, tabela de fases):
1. Dados mestres ✅ (1A) · 2. Parser dimensional ✅ (1A) · 3. BOM paramétrica ✅ (1A) · 4. OP + etapas ✅ (1B-M1) · 5. Apontamento offline c/ consumo-motivo ✅ (1B-M1/M3) · 6. **Modelo de dados do corte múltiplo ⏳ ← ESTE M2**.

Concluído o M2, a Fundação está fechada e o próximo é a **Fase 2** (Custo & Omie).

### O domínio (spec §1, §1.9, Camada 0.4, endurecimento #4)
> "Corte múltiplo condicional — cinta de 50mm é produzida em **150mm e fatiada em 3** (mais rápido)."

Uma cinta estreita pode ser produzida por duas rotas:
- **Rota padrão** (já é a BOM da 1A): consome um rolo da própria largura → 1 cinta.
- **Rota de corte múltiplo** (ESTE M2): consome **um rolo mais largo**, produz a cinta longa e a **fatia em N** → N unidades físicas de uma passada.

Regras que o **modelo** precisa cravar (o *motor* que as aplica é F3):
- **Coproduto obrigatório:** 150 ÷ 3 = 3 saídas. As saídas podem ser o mesmo SKU (3×50mm) OU larguras diferentes (100mm + 50mm). Nunca "somem".
- **Sobra explícita:** se o refilo do rolo vira um SKU vendável (ex.: 140 → 2×50 + 40), a sobra entra como **estoque explícito** do SKU de 40mm (papel `sobra`) — não desaparece.
- **Perda:** refilo não-aproveitável (papel `perda`) **não some** — seu custo é **redistribuído nas saídas boas** (encarece a cinta boa; decisão de custo — ver Ponto Aberto 1).
- **Rateio:** custo unitário = custo do rolo-base **rateado pelas saídas** (default por área; nada de custo evapora — Σfração=1).

### Convenções da casa (herdadas do M1, aplicar iguais)
- `CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` antes de cada `CREATE POLICY` (re-colar no SQL Editor é esperado — idempotável).
- `REVOKE ... FROM anon, authenticated` **por nome** (REVOKE FROM PUBLIC não tira grants nomeados).
- Toda função SECURITY DEFINER com `SET search_path = public`, gate por `auth.uid()` (não `current_user` — vira owner).
- Toda `pcp_%` nasce com RLS ligado, fail-closed (staff = master|employee).
- Prova PG17 **executando** (PL/pgSQL é late-bound), com asserts negativos capturando SQLSTATE + **falsificação** (sabotar a migration → exigir vermelho).

---

## File Structure

- **Create:** `db/pcp-f1b-m2-corte-multiplo.sql` — a migration (colada pelo founder no SQL Editor).
- **Create:** `db/test-pcp-f1b-m2-corte-multiplo.sh` — prova PG17 (harness padrão + fixtures reais + falsificação).
- **Modify:** `docs/historico/pcp.md` — registrar a entrega + fecho da Fase 1.

Sem frontend neste M2 (o cadastro de rota é dado mestre; a UI de cadastro/visualização, se necessária, é um add-on posterior — Ponto Aberto 3). Sem edge.

---

## Pontos Abertos (decidir no painel tri-modelo ANTES do SQL final)

1. **Custo da perda:** o refilo `perda` redistribui nas saídas boas (encarece a cinta boa — como o plano assume) OU é lançado como perda separada (não encarece, vira linha de custo de refugo)? **Money-path.** Recomendação: redistribuir (o custo do rolo é real e precisa ir para algum lugar contábil; separá-lo exige uma conta de perda que só existe na Fase 2).
2. **Base do rateio:** por **área** (largura×qtd — o default do plano, já que comprimento é igual entre saídas) OU permitir override por valor de mercado (uma largura pode valer mais por m²)? Recomendação: default por área + coluna `fracao_rateio` explícita que permite override no cadastro.
3. **Seed:** o M2 só cria o schema (populado na F3) OU já **deriva as rotas simples** (fator inteiro L'=k·L) das larguras reais da 1A, para nascer com dados e provar o modelo? Recomendação: incluir `fn_pcp_derivar_rotas_simples` (só fator inteiro, mesma largura de saída — o caso da spec), deixando rotas mistas para cadastro manual/F3.

---

## Task 1: Schema — tabelas de rota e saídas

**Files:** Create `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Escrever o cabeçalho + as duas tabelas**

```sql
-- PCP Fase 1B — M2: modelo de dados do corte múltiplo (rota alternativa + coproduto + rateio).
-- ÚLTIMO componente da Fundação (Fase 1). NÃO inclui motor (Fase 3) nem backflush/outbox (Fase 2).
-- Aplicar no SQL Editor do Lovable. NUNCA em supabase/migrations/. Re-colar é esperado (idempotável).
BEGIN;

-- 1) Rota alternativa por (linha, largura-base do rolo consumido). A rota PADRÃO já é a BOM da 1A;
--    esta tabela guarda só o corte_multiplo (1 rolo largo → N saídas fatiadas).
CREATE TABLE IF NOT EXISTS public.pcp_bom_rotas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  linha_modelo    text NOT NULL,
  largura_base_mm int  NOT NULL CHECK (largura_base_mm > 0),   -- largura do rolo que entra
  ativa           boolean NOT NULL DEFAULT true,
  nota            text,
  UNIQUE (linha_modelo, largura_base_mm)
);

-- 2) Saídas físicas da rota (principal + coproduto + sobra + perda). Invariantes de AGREGAÇÃO
--    por rota (Σfração=1, geometria, ≥1 principal) via CONSTRAINT TRIGGER DEFERRED (Task 3).
CREATE TABLE IF NOT EXISTS public.pcp_bom_rota_saidas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rota_id         bigint NOT NULL REFERENCES public.pcp_bom_rotas(id) ON DELETE CASCADE,
  largura_saida_mm int  NOT NULL CHECK (largura_saida_mm > 0),
  quantidade      int  NOT NULL CHECK (quantidade > 0),        -- quantas cintas dessa largura saem
  papel           text NOT NULL CHECK (papel IN ('principal','coproduto','sobra','perda')),
  -- fração do CUSTO do rolo-base que ESTA linha absorve. perda=0 (custo redistribuído nas boas).
  fracao_rateio   numeric NOT NULL CHECK (fracao_rateio >= 0 AND fracao_rateio <= 1),
  UNIQUE (rota_id, largura_saida_mm, papel)
);
CREATE INDEX IF NOT EXISTS idx_pcp_rota_saidas_rota ON public.pcp_bom_rota_saidas (rota_id);
```

- [ ] **Step 2: Não fechar o BEGIN ainda** — as Tasks 2–5 adicionam funções/trigger/RLS antes do `COMMIT`.

---

## Task 2: Helper de rateio-default por área (perda redistribuída)

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Adicionar a função de fração default**

```sql
-- 3) Rateio DEFAULT por área (largura×qtd). A PERDA absorve 0 — seu custo é redistribuído nas
--    saídas boas (papel<>'perda'), que é o que conserva o custo do rolo (Ponto Aberto 1).
CREATE OR REPLACE FUNCTION public.fn_pcp_rota_fracao_default(p_rota_id bigint)
RETURNS TABLE(saida_id bigint, fracao numeric) LANGUAGE sql STABLE
SET search_path = public AS $$
  WITH base AS (
    SELECT id, (largura_saida_mm * quantidade)::numeric AS area, papel
      FROM pcp_bom_rota_saidas WHERE rota_id = p_rota_id
  ), uteis AS (SELECT sum(area) AS tot FROM base WHERE papel <> 'perda')
  SELECT b.id,
         CASE WHEN b.papel = 'perda' THEN 0
              ELSE round(b.area / NULLIF(u.tot, 0), 6) END
    FROM base b CROSS JOIN uteis u;
$$;
```

Nota: a soma das frações default = 1 por construção (cada boa = area/Σarea_boa; perda = 0). O arredondamento a 6 casas pode deixar Σ ligeiramente ≠ 1 — a Task 3 tolera ±0.0001 (round a 4).

---

## Task 3: Invariantes de agregação — CONSTRAINT TRIGGER DEFERRED

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Adicionar a função validadora + o constraint trigger**

```sql
-- 4) Invariantes cross-row (não expressáveis em CHECK de linha) — valida no COMMIT (DEFERRED),
--    para o cadastro poder inserir a rota e suas saídas na mesma transação antes de checar.
CREATE OR REPLACE FUNCTION public.fn_pcp_validar_rota() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_rota  bigint := COALESCE(NEW.rota_id, OLD.rota_id);
  v_base  int; v_uteis int; v_frac numeric; v_princ int;
BEGIN
  SELECT largura_base_mm INTO v_base FROM pcp_bom_rotas WHERE id = v_rota;
  IF v_base IS NULL THEN RETURN NULL; END IF;                 -- rota apagada (cascade) — nada a validar
  SELECT COALESCE(sum(largura_saida_mm * quantidade), 0),
         COALESCE(sum(fracao_rateio), 0),
         COALESCE(count(*) FILTER (WHERE papel = 'principal'), 0)
    INTO v_uteis, v_frac, v_princ
    FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;
  IF v_princ < 1 THEN
    RAISE EXCEPTION 'rota %: exige >=1 saida principal', v_rota USING ERRCODE = 'check_violation';
  END IF;
  IF v_uteis > v_base THEN
    RAISE EXCEPTION 'rota %: saidas (%mm) excedem a base (%mm)', v_rota, v_uteis, v_base
      USING ERRCODE = 'check_violation';
  END IF;
  IF round(v_frac, 4) <> 1.0000 THEN
    RAISE EXCEPTION 'rota %: soma fracao=% (<>1, custo nao conservado)', v_rota, v_frac
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pcp_rota_saidas_valida ON public.pcp_bom_rota_saidas;
CREATE CONSTRAINT TRIGGER pcp_rota_saidas_valida
  AFTER INSERT OR UPDATE OR DELETE ON public.pcp_bom_rota_saidas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION public.fn_pcp_validar_rota();
```

---

## Task 4: Rateio de custo + RPC de cadastro staff-gated

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: Função de rateio de custo (aplica a fração a um custo de rolo)**

```sql
-- 5) Rateio de custo: dado o custo do rolo-base, distribui por saída boa (papel<>'perda').
--    custo_total = custo_base x fracao; custo_unitario = custo_total / quantidade.
CREATE OR REPLACE FUNCTION public.fn_pcp_ratear_corte(p_rota_id bigint, p_custo_base numeric)
RETURNS TABLE(largura_saida_mm int, papel text, quantidade int, custo_total numeric, custo_unitario numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT largura_saida_mm, papel, quantidade,
         round(p_custo_base * fracao_rateio, 4),
         round(p_custo_base * fracao_rateio / quantidade, 4)
    FROM pcp_bom_rota_saidas
   WHERE rota_id = p_rota_id AND papel <> 'perda'
   ORDER BY largura_saida_mm DESC;
$$;
```

- [ ] **Step 2: RPC de cadastro (staff-gate fail-closed; aplica fração default quando omitida)**

```sql
-- 6) Cadastro transacional de uma rota + saídas (a UI/seed chama esta). Fração NULL => default por área.
--    Gate fail-closed por auth.uid() (SECURITY DEFINER => current_user seria o owner). O trigger DEFERRED
--    valida os invariantes no COMMIT da função.
CREATE OR REPLACE FUNCTION public.fn_pcp_cadastrar_rota(
  p_linha text, p_largura_base int, p_saidas jsonb, p_nota text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid  uuid := (SELECT auth.uid());
  v_rota bigint;
  s      jsonb;
  v_frac numeric;
BEGIN
  IF v_uid IS NULL OR NOT (has_role(v_uid,'master'::app_role) OR has_role(v_uid,'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_cadastrar_rota: apenas staff';
  END IF;
  INSERT INTO pcp_bom_rotas (linha_modelo, largura_base_mm, nota)
    VALUES (p_linha, p_largura_base, p_nota)
    ON CONFLICT (linha_modelo, largura_base_mm) DO UPDATE SET nota = EXCLUDED.nota, ativa = true
    RETURNING id INTO v_rota;
  DELETE FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;     -- re-cadastro substitui as saídas
  FOR s IN SELECT * FROM jsonb_array_elements(p_saidas) LOOP
    v_frac := NULLIF(s->>'fracao_rateio','')::numeric;        -- NULL => preenche default abaixo
    INSERT INTO pcp_bom_rota_saidas (rota_id, largura_saida_mm, quantidade, papel, fracao_rateio)
      VALUES (v_rota, (s->>'largura_saida_mm')::int, (s->>'quantidade')::int, s->>'papel', COALESCE(v_frac, 0));
  END LOOP;
  -- Preenche frações omitidas com o default por área (só quando TODAS vieram nulas/0 — cadastro simples).
  IF NOT EXISTS (SELECT 1 FROM pcp_bom_rota_saidas WHERE rota_id = v_rota AND fracao_rateio > 0) THEN
    UPDATE pcp_bom_rota_saidas t SET fracao_rateio = d.fracao
      FROM fn_pcp_rota_fracao_default(v_rota) d WHERE d.saida_id = t.id;
  END IF;
  RETURN v_rota;                                              -- trigger DEFERRED valida no COMMIT
END $$;
```

---

## Task 5: RLS + grants

**Files:** Modify `db/pcp-f1b-m2-corte-multiplo.sql`

- [ ] **Step 1: RLS staff-read + fechar superfície das funções + COMMIT**

```sql
-- 7) RLS (staff-read). Escrita só via RPC SECURITY DEFINER (append/cadastro gated) => sem grant de DML.
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

-- Funções: fechar EXECUTE default de PUBLIC; conceder só o necessário.
REVOKE ALL ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_cadastrar_rota(text,int,jsonb,text) FROM PUBLIC, anon, authenticated;
-- fn_pcp_rota_fracao_default e fn_pcp_validar_rota ficam sem grant (internas às RPCs/trigger).
GRANT EXECUTE ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric),
  public.fn_pcp_cadastrar_rota(text,int,jsonb,text) TO authenticated;

COMMIT;
```

---

## Task 6: Prova PG17 (com falsificação)

**Files:** Create `db/test-pcp-f1b-m2-corte-multiplo.sh`

Reusar o harness padrão (initdb PG17 descartável, roles `anon/authenticated`, stub `auth.uid()`/`has_role`/`user_roles`, `Pq(){ P -tA -q "$@"; }`). Aplicar a migration REAL 2× (re-colar não quebra). Asserts:

- [ ] **Step 1: Rateio simples 150→3×50 (o caso da spec)**

```bash
# Cadastra rota: linha 2909, base 150, 1 saída principal 50mm x3, fração default => 1.0
eq "cadastro 150->3x50 retorna rota_id" "$(Pq -c "SELECT fn_pcp_cadastrar_rota('2909',150,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\"}]'::jsonb)>0")" "t"
eq "fração default da principal = 1.0" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='2909' AND r.largura_base_mm=150")" "1.0000"
# Rolo custa R$30 => cada uma das 3 cintas custa 10.
eq "rateio: custo_unitario de R\$30/3 = 10" "$(Pq -c "SELECT custo_unitario FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='2909' AND largura_base_mm=150),30)")" "10.0000"
```

- [ ] **Step 2: Rateio misto 150→100+50 (área: 2/3 e 1/3)**

```bash
Pq -c "SELECT fn_pcp_cadastrar_rota('KA169',150,'[{\"largura_saida_mm\":100,\"quantidade\":1,\"papel\":\"principal\"},{\"largura_saida_mm\":50,\"quantidade\":1,\"papel\":\"coproduto\"}]'::jsonb)" >/dev/null
eq "fração 100mm = 2/3 (0.6667)" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='KA169' AND s.largura_saida_mm=100")" "0.6667"
eq "custo_total do 50mm de R\$90 = 30" "$(Pq -c "SELECT custo_total FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='KA169'),90) WHERE largura_saida_mm=50")" "30.0000"
```

- [ ] **Step 3: Perda redistribuída — 140→2×50 + 40 perda (cada 50mm absorve metade, não 50/140)**

```bash
Pq -c "SELECT fn_pcp_cadastrar_rota('XZ667',140,'[{\"largura_saida_mm\":50,\"quantidade\":2,\"papel\":\"principal\"},{\"largura_saida_mm\":40,\"quantidade\":1,\"papel\":\"perda\"}]'::jsonb)" >/dev/null
eq "perda tem fração 0" "$(Pq -c "SELECT fracao_rateio FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='perda'")" "0"
eq "principal 50mmx2 absorve 100% (fração 1.0, perda redistribuída)" "$(Pq -c "SELECT round(fracao_rateio,4) FROM pcp_bom_rota_saidas s JOIN pcp_bom_rotas r ON r.id=s.rota_id WHERE r.linha_modelo='XZ667' AND s.papel='principal'")" "1.0000"
eq "rateio ignora a perda (só 1 linha boa)" "$(Pq -c "SELECT count(*) FROM fn_pcp_ratear_corte((SELECT id FROM pcp_bom_rotas WHERE linha_modelo='XZ667'),50)")" "1"
```

- [ ] **Step 4: Invariantes negativos (SQLSTATE + re-raise) — cada um deve BARRAR**

```bash
# (a) sem saída principal => check_violation no COMMIT
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"coproduto\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"principal"*) ok "sem principal => barra";; *) bad "sem principal NÃO barrou: $ERR";; esac
# (b) saídas excedem a base (4x50=200 > 150)
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,'[{\"largura_saida_mm\":50,\"quantidade\":4,\"papel\":\"principal\"}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"excedem"*) ok "geometria (excede base) => barra";; *) bad "excesso NÃO barrou: $ERR";; esac
# (c) Σfração<>1 forçada (fração explícita 0.9)
ERR=$(P -tA -c "BEGIN; SELECT fn_pcp_cadastrar_rota('BAD',150,'[{\"largura_saida_mm\":50,\"quantidade\":3,\"papel\":\"principal\",\"fracao_rateio\":0.9}]'::jsonb); COMMIT;" 2>&1 || true)
case "$ERR" in *"conservado"*) ok "Σfração<>1 => barra";; *) bad "fração ruim NÃO barrou: $ERR";; esac
```

- [ ] **Step 5: RLS + gate da RPC (fail-closed)**

```bash
eq "2 tabelas de rota com RLS ligado" "$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('pcp_bom_rotas','pcp_bom_rota_saidas') AND c.relrowsecurity")" "2"
eq "staff vê rotas" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*)>0 FROM pcp_bom_rotas")" "t"
eq "não-staff vê 0 (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM pcp_bom_rotas")" "0"
NS=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT fn_pcp_cadastrar_rota('X',150,'[]'::jsonb);" 2>&1 || true)
case "$NS" in *"apenas staff"*) ok "não-staff barrado no cadastro";; *) bad "não-staff NÃO barrado: $NS";; esac
```

- [ ] **Step 6: FALSIFICAÇÃO (Lei de Ferro)** — sabotar a migration e exigir vermelho:
  - Comente a checagem `IF round(v_frac,4) <> 1.0000` em `fn_pcp_validar_rota` → o Step 4(c) deve **falhar** (fração 0.9 passaria). Reverter.
  - Troque `papel <> 'perda'` por `1=1` em `fn_pcp_ratear_corte` → o Step 3 ("rateio ignora a perda") deve **falhar** (2 linhas em vez de 1). Reverter.
  - Documentar no cabeçalho do teste que a suíte foi falsificada.

- [ ] **Step 7: Rodar verde**

Run: `heavy bash db/test-pcp-f1b-m2-corte-multiplo.sh > /tmp/t-m2.log 2>&1; echo "exit=$?"`
Expected: `RESULTADO: PASS=N FAIL=0` e `exit=0`.

- [ ] **Step 8: Commit**

```bash
git add db/pcp-f1b-m2-corte-multiplo.sql db/test-pcp-f1b-m2-corte-multiplo.sh
git commit -m "feat(pcp): F1B-M2 — modelo de dados do corte múltiplo (rota+coproduto+rateio) + prova PG17"
```

---

## Task 7: Diário + fecho da Fase 1

**Files:** Modify `docs/historico/pcp.md`

- [ ] **Step 1:** Adicionar seção "Fase 1B-M2 — Corte múltiplo" (tabelas, invariantes, decisões do painel dos Pontos Abertos, PASS=N) e registrar que **a Fundação (Fase 1) está fechada** — próximo é a Fase 2 (Custo & Omie).
- [ ] **Step 2:** Commit.

---

## Deploy (founder, manual — depois do merge)

Só **1 camada** (SQL — sem frontend/edge neste M2):
1. Abrir `db/pcp-f1b-m2-corte-multiplo.sql`, copiar tudo, colar no SQL Editor → Run. Esperado *"Success. No rows returned"*. Idempotável.
2. Verificação minha (psql-ro): as 2 tabelas com RLS on, o constraint trigger presente, e um cadastro-teste ratear certo.

---

## Self-Review (checklist do autor)

- **Spec coverage:** §1.9 (rota+coproduto+rateio, modelo completo F1) ✅ Tasks 1–4; endurecimento #4 (coproduto obrigatório, sobra explícita, custo rateado) ✅ Task 3 (≥1 principal, geometria) + Task 2/4 (rateio); top risk "corte múltiplo sem coproduto distorcendo custo" ✅ invariante Σfração=1 + perda redistribuída.
- **Fora de escopo confirmado:** motor (F3) e backflush/outbox (F2) — não há task para eles. ✅
- **Type consistency:** `fracao_rateio` numeric em todas as funções; `fn_pcp_ratear_corte(bigint,numeric)`, `fn_pcp_cadastrar_rota(text,int,jsonb,text)` — assinaturas idênticas no REVOKE/GRANT. ✅
- **Placeholder scan:** sem TBD/TODO; todo SQL e todo assert têm código concreto. ✅

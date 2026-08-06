# Fatia 0 — `carteira_membership_ledger` (fundação) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar a tabela-ledger de membership da carteira (acumulador durável), fazê-la nascer com os 6909 membros de hoje (backfill preservando a data real do vínculo) e mantê-la em dia via trigger no espelho — SEM ainda ninguém lê-la (aditivo, zero mudança de comportamento).

**Architecture:** Migration aditiva única. `carteira_membership_ledger(user_id PK, identity_state, first_seen_at, source)`. Backfill copia `omie_clientes(user_id, created_at)`. Trigger `AFTER INSERT` em `omie_clientes` espelha todo `user_id` novo para o ledger com `ON CONFLICT DO NOTHING` — cobre os 6 writers durante a transição, sem tocá-los. Prova em PostgreSQL 17 local (prove-sql-money-path) antes de entregar; deploy via lovable-db-operator (SQL Editor).

**Tech Stack:** PostgreSQL 17 (Supabase). Migration SQL pura. Teste: harness PG17 descartável (`db/test-*.sh`). Deploy: SQL Editor do Lovable (migration custom NÃO auto-aplica).

## Global Constraints (verbatim da spec + CLAUDE.md)

- money-path/DDL → **prove-sql PG17 obrigatório** (asserts +/- com SQLSTATE + falsificação) ANTES de entregar.
- Migration custom NÃO auto-aplica no Lovable (falha SILENCIOSA) → handoff via **lovable-db-operator** (bloco SQL Editor + validação pós-apply por psql-ro).
- Tabela nova **sempre** com RLS. SECURITY DEFINER **sempre** com `SET search_path`.
- Aditivo: ledger vazio/parcial → consumidores (Fatia 1+) degradam como hoje. Esta fatia não tem consumidor → risco de comportamento = zero.
- **Invariante:** ledger é acumulador — `user_id` uma vez dentro NUNCA sai; transições mudam `identity_state`, não a presença.
- Épico QUENTE: conferir timestamp da migration vs `origin/main` + worktrees `omie-identidade`/`carteira-vendedor-oben-hardening` antes de criar (colisão de timestamp = aviso).

---

## File Structure

- **Create:** `supabase/migrations/<TS>_carteira_membership_ledger_fatia0.sql` — a migration (tabela + índice + RLS + backfill + trigger). `<TS>` = timestamp `YYYYMMDDHHMMSS` posterior ao topo de `origin/main` (hoje `20260712140000` é o mais novo → usar `20260712150000` se livre; reconferir no momento).
- **Create:** `db/test-carteira-membership-ledger.sh` + `db/carteira-membership-ledger.sql` — harness prove-sql PG17 (espelhar `db/test-recencia-fonte-trigger-backfill.sh`, que já cobre trigger+backfill+created_at).
- **Não toca:** nenhum código de app. Nenhum leitor do ledger existe até a Fatia 1.

---

### Task 1: Migration + prova PG17 + handoff de deploy

**Files:**
- Create: `supabase/migrations/<TS>_carteira_membership_ledger_fatia0.sql`
- Create: `db/test-carteira-membership-ledger.sh`, `db/carteira-membership-ledger.sql`

**Interfaces:**
- Produces (a Fatia 1 consome): tabela `public.carteira_membership_ledger` com colunas `user_id uuid PK`, `identity_state text ∈ {verified,ambiguous,inactive,conflict}`, `first_seen_at timestamptz`, `source text ∈ {backfill,trigger,rpc}`, `updated_at timestamptz`. Contém 1 linha por `user_id` distinto de `omie_clientes`.

- [ ] **Step 1: Escrever a migration (código real — sem placeholder)**

```sql
-- <TS>_carteira_membership_ledger_fatia0.sql
-- P0-B-bis Fatia 0: ledger de membership da carteira (acumulador durável) + backfill + trigger.
-- Aditivo: NADA lê o ledger ainda (Fatia 1). RLS espelha omie_clientes.

CREATE TABLE IF NOT EXISTS public.carteira_membership_ledger (
  user_id       uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_state text NOT NULL DEFAULT 'verified'
                 CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at timestamptz NOT NULL,
  source        text NOT NULL DEFAULT 'trigger'
                 CHECK (source IN ('backfill','trigger','rpc')),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cml_identity_state
  ON public.carteira_membership_ledger (identity_state);

ALTER TABLE public.carteira_membership_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can manage carteira membership ledger"
  ON public.carteira_membership_ledger FOR ALL
  USING      (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role))
  WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));

CREATE POLICY "Users can view their own membership"
  ON public.carteira_membership_ledger FOR SELECT
  USING (auth.uid() = user_id);

-- Backfill: 1 linha por user_id do espelho, com a data REAL do vínculo (~março).
INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
SELECT user_id, created_at, 'backfill'
FROM public.omie_clientes
ON CONFLICT (user_id) DO NOTHING;

-- Trigger: enquanto o espelho ainda é escrito (Fatias 0-3), captura todo user_id novo.
-- ON CONFLICT DO NOTHING → idempotente + coexiste com o backfill.
CREATE OR REPLACE FUNCTION public.tg_omie_clientes_to_ledger()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.carteira_membership_ledger (user_id, first_seen_at, source)
  VALUES (NEW.user_id, COALESCE(NEW.created_at, now()), 'trigger')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_omie_clientes_to_ledger ON public.omie_clientes;
CREATE TRIGGER trg_omie_clientes_to_ledger
  AFTER INSERT ON public.omie_clientes
  FOR EACH ROW EXECUTE FUNCTION public.tg_omie_clientes_to_ledger();
```

- [ ] **Step 2: Escrever o harness prove-sql PG17 (asserts + e −)**

Invocar a skill **prove-sql-money-path** apontando `db/test-recencia-fonte-trigger-backfill.sh` como template (trigger+backfill+created_at). O harness aplica a migration REAL e prova, no mínimo:

```sql
-- Seed mínimo: auth.users(u1,u2), omie_clientes(u1 @ '2026-03-01', u2 @ '2026-03-02'), has_role stub.
-- ASSERT + (backfill): 2 linhas no ledger; first_seen_at de u1 = '2026-03-01' (data preservada, NÃO now()).
-- ASSERT + (trigger): INSERT omie_clientes(u3 @ '2026-07-10') → ledger passa a ter u3 com first_seen_at='2026-07-10', source='trigger'.
-- ASSERT + (idempotência): re-rodar o backfill (INSERT..SELECT..ON CONFLICT) NÃO duplica nem sobrescreve source='backfill'.
-- ASSERT − (CHECK identity_state): UPDATE ledger SET identity_state='xpto' → SQLSTATE 23514 (re-raise se ≠).
-- ASSERT − (CHECK source): INSERT source='foo' → SQLSTATE 23514.
-- ASSERT RLS: SET ROLE authenticated + GUC request.jwt.claim.sub=u2 (não-staff) → SELECT vê SÓ a própria linha (1);
--             com GUC=staff (has_role stub true) → vê todas (3).
```

- [ ] **Step 3: Rodar o teste → verde; depois FALSIFICAR → vermelho**

Run: `heavy bash db/test-carteira-membership-ledger.sh > /tmp/cml.log 2>&1; echo $?`
Expected: exit `0`, todos os asserts PASS.
Falsificação (exigir vermelho): remover o `CHECK (identity_state IN ...)` da migration e re-rodar → o assert − deve FALHAR (prova que o teste tem dente). Reverter a sabotagem.

- [ ] **Step 4: Handoff de deploy (lovable-db-operator)**

Invocar **lovable-db-operator** para empacotar: (a) o bloco pronto pro SQL Editor (a migration acima), (b) a query de validação pós-apply por psql-ro:

```sql
-- Pós-apply (psql-ro): cobertura idêntica ao espelho + 0 fora do CHECK.
SELECT
  (SELECT count(*) FROM omie_clientes)                          AS espelho,
  (SELECT count(*) FROM carteira_membership_ledger)             AS ledger,
  (SELECT count(*) FROM carteira_membership_ledger
     WHERE identity_state NOT IN ('verified','ambiguous','inactive','conflict')) AS fora_check;
-- Esperado: espelho == ledger (6909 == 6909), fora_check == 0.
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/*_carteira_membership_ledger_fatia0.sql db/test-carteira-membership-ledger.sh db/carteira-membership-ledger.sql
git commit -m "feat(carteira): ledger de membership (Fatia 0 P0-B-bis) — backfill + trigger, aditivo, provado PG17

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review (plano × spec)

**1. Cobertura da spec (§3, §5-Fatia0, §7):** ✅ tabela com os 4 campos (user_id/identity_state/first_seen_at/source) — §3. ✅ backfill preserva `first_seen_at` (o `created_at` que `analytics-sync:1566` precisa) — §3/§9. ✅ trigger cobre os 6 writers sem tocá-los — §5. ✅ RLS espelha omie_clientes — §3. ✅ prove-sql com +/− + falsificação + RLS sob SET ROLE — §7. ✅ handoff lovable-db-operator — §8.
- `eligible` e `vendedor` NÃO entram nesta fatia (vivem em carteira_assignments / proof) — correto, §3.
- `identity_state` só existe como coluna com default 'verified'; a POPULAÇÃO das transições é Fatia 2 — correto, o plano não a implementa aqui.

**2. Placeholders:** `<TS>` é o único — é um timestamp que depende de coordenação multi-sessão no momento da criação (documentado no File Structure). Não é placeholder de conteúdo.

**3. Consistência de tipos:** `user_id uuid`, `first_seen_at timestamptz`, `identity_state`/`source` com os mesmos enums na tabela, no backfill, no trigger e nos asserts. `has_role(auth.uid(),'master'::app_role)` = assinatura real confirmada por psql-ro.

## Próximas fatias (planos próprios, após esta aplicada e provada)
- **Fatia 1** — `carteira-rebuild` lê o ledger (edge; paridade `src/lib/carteira/rebuild-helpers.ts`; quarantined por identity_state). Deploy de edge.
- Fatias 2-5 — identity_state → leitores→proof → writers→RPC → DROP.

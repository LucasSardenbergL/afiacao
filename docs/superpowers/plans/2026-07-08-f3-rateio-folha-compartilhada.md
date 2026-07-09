# F3 v2 — Rateio de custo fixo compartilhado (folha CSC → OBEN) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o master lance um custo fixo compartilhado (parcela da folha da CSC atribuível à OBEN) que entra no `custos_fixos` do Ponto de Equilíbrio; sem rateio, velar o PE/margem com aviso honesto.

**Architecture:** Overlay aditivo sobre o helper puro `pontoEquilibrio` (o rateio soma ao fixo APÓS os gates de integridade — a folha não está no snapshot da OBEN, injetá-la quebraria a reconciliação). Persistência numa tabela `fin_custo_rateio` master-only (molde `fin_dre_custo_tipo`). Wiring injeta a política de exigência (constante). UI: card com estados novos + dialog de lançamento com referência viva da folha CSC.

**Tech Stack:** React 18 + TS strict, `@tanstack/react-query`, Supabase (RLS), vitest, shadcn/ui, `sonner`. Backend Lovable (migration manual via SQL Editor).

**Spec:** [`docs/superpowers/specs/2026-07-08-f3-rateio-folha-compartilhada-design.md`](../specs/2026-07-08-f3-rateio-folha-compartilhada-design.md)

## Global Constraints

- **pt-BR** em código/rotas/commits (identificadores, mensagens de UI, toasts).
- **Money-path:** precisão > recall. Nunca fabricar número; `can_show_break_even === false` ⇒ `pe_receita` e `margem_seguranca` são `null`. Helper puro testado com vitest (`bun run test`).
- **Tabela nova → RLS obrigatório** master-only, espelhando `fin_dre_custo_tipo` verbatim (policies + trigger `SECURITY DEFINER` + `SET search_path=''`).
- **Migration NÃO auto-aplica no Lovable** — entregue via skill `lovable-db-operator` (handoff pro SQL Editor) e **prove** via `prove-sql-money-path` ANTES.
- **Nunca** editar `supabase/migrations/` diretamente (snapshot é fonte de DR) — a skill cuida do local canônico.
- Status colors por token (`text-status-*`), toast só `sonner`, tabelas fora dos tipos gerados via cast `unknown` (padrão `useFunding`).
- `valor_mensal_brl` = custo mensal **normalizado** (anual÷12, com 13º/férias/encargos).

## File Structure

- **Modify** `src/lib/financeiro/ponto-equilibrio-helpers.ts` — tipos (2 motivos, `CustoCompartilhado`, +5 campos de result, +3 de input), lógica dos 2 gates + soma do rateio, helper puro `somaCodigosPorPrefixo`.
- **Modify** `src/lib/financeiro/__tests__/ponto-equilibrio-helpers.test.ts` — testes dos novos comportamentos.
- **New (SQL, via skill)** `fin_custo_rateio` — tabela + RLS + trigger.
- **Modify** `src/hooks/usePontoEquilibrio.ts` — constantes `FAMILIA_FOLHA`/`EMPRESAS_COM_FOLHA_EXTERNA`, `useCustoRateio`, cálculo do sinal anti-duplicidade, `useSalvarCustoRateio`, `useFolhaReferencia`; injeta tudo no helper.
- **New** `src/components/financeiro/dashboard/RateioFolhaDialog.tsx` — form de lançamento + referência viva da folha CSC.
- **Modify** `src/components/financeiro/dashboard/PontoEquilibrioCard.tsx` — estados: pendente (próprio), duplicidade, disclosure positivo, latente.

---

### Task 1: Helper puro — extensão do rateio (todos os gates + campos)

**Files:**
- Modify: `src/lib/financeiro/ponto-equilibrio-helpers.ts`
- Test: `src/lib/financeiro/__tests__/ponto-equilibrio-helpers.test.ts`

**Interfaces:**
- Consumes: `MesDRE`, `CONFIG_PE_PADRAO` (existentes).
- Produces (later tasks rely on these exact names):
  - `interface CustoCompartilhado { valor_mensal: number; origem: string; rotulo: string }`
  - `PontoEquilibrioInput` += `custoCompartilhado?: CustoCompartilhado | null; exigeCustoCompartilhado?: boolean; custoCompartilhadoNoSnapshotTtm?: number`
  - `PontoEquilibrioResult` += `custo_compartilhado_ttm: number; custo_compartilhado_mensal: number; custo_compartilhado_origem: string | null; custo_compartilhado_pendente_latente: boolean; can_show_break_even: boolean`
  - `MotivoPE` += `'custo_compartilhado_pendente' | 'custo_compartilhado_possivel_duplicidade'`
  - `function somaCodigosPorPrefixo(meses: MesDRE[], prefixos: string[]): number`

- [ ] **Step 1: Escreva os testes que falham** — anexe ao fim de `ponto-equilibrio-helpers.test.ts`:

```ts
describe('pontoEquilibrio — F3 v2: rateio de custo fixo compartilhado', () => {
  // Base: doze() → receita TTM 1200, variáveis 720, fixos 300, MC% 40%.
  const RAT = (valor_mensal: number) => ({ valor_mensal, origem: 'colacor_sc', rotulo: 'folha' });

  it('rateio presente soma ao fixo: valor 10/mês → fixos 420, PE 1050, margem 12,5%, MC% inalterada', () => {
    const r = pontoEquilibrio({ meses: doze(), classificacao: CLASS, custoCompartilhado: RAT(10) });
    expect(r.motivo).toBe('ok');
    expect(r.custos_fixos).toBeCloseTo(420, 2); // 300 + 10*12
    expect(r.pe_receita).toBeCloseTo(1050, 2); // 420 / 0,40
    expect(r.margem_seguranca_pct).toBeCloseTo(0.125, 4); // (1200-1050)/1200
    expect(r.mc_pct).toBeCloseTo(0.4, 4); // folha é FIXO — MC% não muda
    expect(r.custo_compartilhado_ttm).toBeCloseTo(120, 2);
    expect(r.custo_compartilhado_mensal).toBeCloseTo(10, 2);
    expect(r.custo_compartilhado_origem).toBe('colacor_sc');
    expect(r.can_show_break_even).toBe(true);
  });

  it('exige && ausente → custo_compartilhado_pendente; vela pe/margem MAS preserva mc_pct/custos_fixos/receita', () => {
    const r = pontoEquilibrio({ meses: doze(), classificacao: CLASS, exigeCustoCompartilhado: true });
    expect(r.motivo).toBe('custo_compartilhado_pendente');
    expect(r.pe_receita).toBeNull();
    expect(r.margem_seguranca_pct).toBeNull();
    expect(r.can_show_break_even).toBe(false);
    expect(r.mc_pct).toBeCloseTo(0.4, 4); // contexto verdadeiro preservado
    expect(r.custos_fixos).toBeCloseTo(300, 2); // fixo conhecido, SEM folha
    expect(r.receita_bruta_ttm).toBeCloseTo(1200, 2);
  });

  it('exige && valor 0 confirmado → ok; PE idêntico ao sem-rateio (750); custo_compartilhado_ttm 0', () => {
    const r = pontoEquilibrio({
      meses: doze(), classificacao: CLASS,
      exigeCustoCompartilhado: true, custoCompartilhado: RAT(0),
    });
    expect(r.motivo).toBe('ok');
    expect(r.pe_receita).toBeCloseTo(750, 2);
    expect(r.custo_compartilhado_ttm).toBe(0);
  });

  it('!exige && ausente → inalterado (não degrada, não soma)', () => {
    const r = pontoEquilibrio({ meses: doze(), classificacao: CLASS });
    expect(r.motivo).toBe('ok');
    expect(r.custos_fixos).toBeCloseTo(300, 2);
    expect(r.custo_compartilhado_ttm).toBe(0);
    expect(r.can_show_break_even).toBe(true);
  });

  it('exige && folha no snapshot da própria empresa (material) → custo_compartilhado_possivel_duplicidade; não soma', () => {
    const r = pontoEquilibrio({
      meses: doze(), classificacao: CLASS,
      exigeCustoCompartilhado: true, custoCompartilhado: RAT(10),
      custoCompartilhadoNoSnapshotTtm: 100, // > 5% de despesasTTM (1020*0,05=51)
    });
    expect(r.motivo).toBe('custo_compartilhado_possivel_duplicidade');
    expect(r.pe_receita).toBeNull();
    expect(r.can_show_break_even).toBe(false);
  });

  it('precedência: classificação incompleta E rateio ausente → inconclusivo (não pendente) + latente=true', () => {
    // 2.05.03=25 não classificado (29% despesas) → inconclusivo dispara antes do pendente.
    const inc = (): Partial<MesDRE> => ({
      despesas: { '2.01.01': 60, '2.05.03': 25 },
      linha_cmv: 60, linha_operacionais: 25,
    });
    const r = pontoEquilibrio({
      meses: doze(inc), classificacao: { '2.01.01': 'variavel' },
      exigeCustoCompartilhado: true,
    });
    expect(r.motivo).toBe('inconclusivo');
    expect(r.custo_compartilhado_pendente_latente).toBe(true);
  });

  it('somaCodigosPorPrefixo soma só os códigos do prefixo', () => {
    const meses: MesDRE[] = [
      { ano: 2025, mes: 1, receita_bruta: 100, deducoes_col: 0,
        despesas: { '2.03.01': 10, '2.03.07': 2, '2.01.01': 60 },
        linha_cmv: 60, linha_operacionais: 12, linha_administrativas: 0, linha_comerciais: 0, linha_financeiras: 0 },
    ];
    expect(somaCodigosPorPrefixo(meses, ['2.03'])).toBeCloseTo(12, 2); // 10+2, ignora 2.01.01
  });
});
```

- [ ] **Step 2: Rode e veja falhar**

Run: `heavy bun run test -- ponto-equilibrio-helpers`
Expected: FAIL — `somaCodigosPorPrefixo is not a function` / propriedades `custo_compartilhado_*` inexistentes / `custoCompartilhado` não aceito no input.

- [ ] **Step 3: Estenda os tipos** — em `ponto-equilibrio-helpers.ts`, no bloco `MotivoPE` adicione as 2 variantes ao fim da união; adicione o tipo `CustoCompartilhado`; estenda `PontoEquilibrioResult` e `PontoEquilibrioInput`:

```ts
export type MotivoPE =
  | 'ok'
  | 'sem_dados'
  | 'sem_receita'
  | 'mc_negativa'
  | 'inconclusivo'
  | 'custo_misto_material'
  | 'snapshot_inconsistente'
  | 'mc_instavel'
  | 'deducoes_coluna_inesperada'
  | 'valor_negativo_inesperado'
  | 'custo_compartilhado_pendente' // F3 v2 — exige rateio e não foi lançado
  | 'custo_compartilhado_possivel_duplicidade'; // F3 v2 — folha já no snapshot da própria empresa

/** Custo fixo compartilhado lançado pelo master (parcela da folha de outra empresa do grupo). */
export interface CustoCompartilhado {
  valor_mensal: number; // custo mensal NORMALIZADO (anual÷12, c/ 13º/férias/encargos)
  origem: string; // empresa que paga hoje, ex 'colacor_sc' (disclosure)
  rotulo: string; // ex 'folha'
}
```

No `PontoEquilibrioResult`, adicione ao fim da interface (antes de `detalhes`):

```ts
  /** Total TTM do custo fixo compartilhado somado ao fixo (folha rateada). 0 quando ausente. */
  custo_compartilhado_ttm: number;
  /** Valor mensal lançado (0 se ausente). */
  custo_compartilhado_mensal: number;
  /** Empresa de origem do custo (disclosure), ex 'colacor_sc'. */
  custo_compartilhado_origem: string | null;
  /** Pendência de rateio SOB outra degradação (o card avisa "além disto, falta ratear"). C8. */
  custo_compartilhado_pendente_latente: boolean;
  /** Contrato C10: === (motivo==='ok'). false ⇒ pe_receita e margem_seguranca são null. */
  can_show_break_even: boolean;
```

No `PontoEquilibrioInput`, adicione:

```ts
  custoCompartilhado?: CustoCompartilhado | null;
  exigeCustoCompartilhado?: boolean;
  /** Σ TTM dos códigos de folha achados no snapshot da PRÓPRIA empresa (sinal anti-duplicidade). */
  custoCompartilhadoNoSnapshotTtm?: number;
```

- [ ] **Step 4: Adicione o helper puro `somaCodigosPorPrefixo`** — logo após `rotuloMes` (antes de `export function pontoEquilibrio`):

```ts
/** Σ TTM dos valores cujo código começa com algum dos prefixos (sinal anti-duplicidade da folha). */
export function somaCodigosPorPrefixo(meses: MesDRE[], prefixos: string[]): number {
  let total = 0;
  for (const m of meses)
    for (const [cod, v] of Object.entries(m.despesas))
      if (Number.isFinite(v) && prefixos.some((p) => cod.startsWith(p))) total += v;
  return total;
}
```

- [ ] **Step 5: Estenda a lógica de `pontoEquilibrio`** — três edições dentro da função:

**(a)** Logo após `const meses = ...sort(...)`, derive o estado do rateio:

```ts
  const exige = input.exigeCustoCompartilhado === true;
  const rateio = input.custoCompartilhado ?? null;
  const rateioValido = rateio != null && Number.isFinite(rateio.valor_mensal) && rateio.valor_mensal >= 0;
  const rateioPendente = exige && !rateioValido;
```

**(b)** No objeto retornado por `degradar`, adicione os 5 campos novos (mantendo `...ctx` por último):

```ts
    custo_compartilhado_ttm: 0,
    custo_compartilhado_mensal: 0,
    custo_compartilhado_origem: null,
    // latente só quando a degradação NÃO é o próprio pendente (nem sem_dados).
    custo_compartilhado_pendente_latente: rateioPendente && motivo !== 'custo_compartilhado_pendente' && motivo !== 'sem_dados',
    can_show_break_even: false,
```

**(c)** Substitua o bloco final (do cálculo de `custosVariaveis` até o `return` do `ok`) por — inserindo os 2 gates ANTES do OK e somando o rateio:

```ts
  // 7. Economia. custos_variaveis = deducoes_col (0 na OBEN) + Σ variável; fixos EXCLUEM nao_operacional.
  const custosVariaveis = deducoesColTTM + variaveisTTM;
  const custosFixosBase = fixosTTM; // SEM a folha (fixo conhecido)
  const mcPct = (receitaTTM - custosVariaveis) / receitaTTM;
  if (!(mcPct > 0)) return degradar('mc_negativa', ctx);

  // 8. MC% instável (P1-D8): mede a base OPERACIONAL mês a mês (sem nao_operacional).
  const mcMensais = meses
    .filter((m) => m.receita_bruta > 0)
    .map((m) => {
      let varMes = m.deducoes_col;
      for (const [cod, v] of Object.entries(m.despesas)) if (classificacao[cod] === 'variavel') varMes += v;
      return (m.receita_bruta - varMes) / m.receita_bruta;
    });
  if (mcMensais.length >= 2) {
    const media = mcMensais.reduce((a, b) => a + b, 0) / mcMensais.length;
    const varc = mcMensais.reduce((a, b) => a + (b - media) ** 2, 0) / mcMensais.length;
    const cv = Math.abs(media) > 1e-9 ? Math.sqrt(varc) / Math.abs(media) : Infinity;
    if (cv > cfg.mcInstavelCv) return degradar('mc_instavel', ctx);
  }

  // ctx enriquecido: preserva mc_pct/custos_fixos(sem folha)/variaveis p/ o card do estado pendente (§5).
  const ctxEconomia: Partial<PontoEquilibrioResult> = {
    ...ctx,
    mc_pct: mcPct,
    custos_fixos: custosFixosBase,
    custos_variaveis: custosVariaveis,
  };

  // 9. Duplicidade (C1): folha já no snapshot da própria empresa → somar o rateio dobraria.
  const noSnapshotTTM = input.custoCompartilhadoNoSnapshotTtm ?? 0;
  if (exige && noSnapshotTTM > cfg.materialDespesaPct * despesasTTM)
    return degradar('custo_compartilhado_possivel_duplicidade', ctxEconomia);

  // 10. Pendente (B): exige rateio e não foi lançado → vela pe/margem (último gate).
  if (rateioPendente) return degradar('custo_compartilhado_pendente', ctxEconomia);

  // ── OK: soma o rateio ao fixo (aditivo, pós-reconciliação) ──────────────────────────────────
  const custoCompartilhadoTtm = rateioValido ? rateio!.valor_mensal * meses.length : 0;
  const custosFixos = custosFixosBase + custoCompartilhadoTtm;
  const peReceita = custosFixos / mcPct;
  const margemSeguranca = (receitaTTM - peReceita) / receitaTTM;
  return {
    motivo: 'ok',
    pe_receita: peReceita,
    mc_pct: mcPct,
    custos_fixos: custosFixos,
    custos_variaveis: custosVariaveis,
    margem_seguranca_pct: margemSeguranca,
    cobertura_pct: cobertura,
    receita_bruta_ttm: receitaTTM,
    excluido_nao_operacional_ttm: naoOpTTM,
    excluido_nao_operacional_recente: naoOpRecente,
    nao_operacional_share_pct: share,
    periodo_label: label,
    detalhes: [],
    custo_compartilhado_ttm: custoCompartilhadoTtm,
    custo_compartilhado_mensal: rateioValido ? rateio!.valor_mensal : 0,
    custo_compartilhado_origem: rateioValido ? rateio!.origem : null,
    custo_compartilhado_pendente_latente: false,
    can_show_break_even: true,
  };
```

> Nota: o antigo `const custosFixos = fixosTTM;` é substituído por `custosFixosBase`. Confira que nenhuma outra referência a `custosFixos` sobrou fora do novo bloco.

- [ ] **Step 6: Rode e veja passar** (inclui os testes antigos — retrocompat)

Run: `heavy bun run test -- ponto-equilibrio-helpers`
Expected: PASS (todos os testes antigos + os 7 novos).

- [ ] **Step 7: Typecheck**

Run: `heavy bun run typecheck`
Expected: sem erros (os campos novos são obrigatórios no `PontoEquilibrioResult` — o `degradar` e o `return ok` já os preenchem).

- [ ] **Step 8: Commit**

```bash
git add src/lib/financeiro/ponto-equilibrio-helpers.ts src/lib/financeiro/__tests__/ponto-equilibrio-helpers.test.ts
git commit -m "feat(financeiro): F3 v2 — helper do rateio de custo fixo compartilhado (gates + contrato)"
```

---

### Task 2: Migration `fin_custo_rateio` (provada + handoff)

**Files:**
- New (SQL): entregue via skill `lovable-db-operator` (ela grava no local canônico + gera o bloco pro SQL Editor).

**Interfaces:**
- Produces: tabela `public.fin_custo_rateio (company, rotulo, valor_mensal_brl, origem_company, observacao, ativo, updated_by, updated_at)` com RLS master-only + trigger de autor.

- [ ] **Step 1: Prove a migration com `prove-sql-money-path`** — invoque a skill; o SQL a aplicar no harness PG17 é exatamente:

```sql
CREATE TABLE public.fin_custo_rateio (
  company          text        NOT NULL,
  rotulo           text        NOT NULL,
  valor_mensal_brl numeric     NOT NULL CHECK (valor_mensal_brl >= 0),
  origem_company   text        NOT NULL,
  observacao       text        NOT NULL CHECK (length(trim(observacao)) > 0),
  ativo            boolean     NOT NULL DEFAULT true,
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, rotulo)
);

ALTER TABLE public.fin_custo_rateio ENABLE ROW LEVEL SECURITY;

CREATE POLICY fin_custo_rateio_select_master ON public.fin_custo_rateio
  FOR SELECT USING (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role));

CREATE POLICY fin_custo_rateio_write_master ON public.fin_custo_rateio
  FOR ALL USING (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles
    WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'master'::app_role));

CREATE POLICY fin_custo_rateio_service_all ON public.fin_custo_rateio
  FOR ALL USING (auth.role() = 'service_role'::text);

CREATE OR REPLACE FUNCTION public.fin_custo_rateio_set_autor()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  NEW.updated_by := auth.uid();
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_fin_custo_rateio_autor
  BEFORE INSERT OR UPDATE ON public.fin_custo_rateio
  FOR EACH ROW EXECUTE FUNCTION public.fin_custo_rateio_set_autor();
```

Asserts a provar no harness (positivo E negativo, com SQLSTATE + re-raise + **falsificação**):
- **CHECK valor ≥ 0:** `INSERT ... valor_mensal_brl = -1` → falha `23514`; `= 0` → passa.
- **CHECK observacao não-vazia:** `observacao = '   '` → falha `23514`; texto real → passa.
- **RLS master:** sob `SET ROLE authenticated` + GUC `request.jwt.claims` de um user SEM master → `SELECT`/`INSERT` retornam 0 linhas / `42501`; com master → OK. (psql é superuser — provar SÓ sob `SET ROLE`.)
- **Trigger de autor:** `INSERT` com `updated_by` forjado de outro uuid → após inserir, `updated_by = auth.uid()` (o do GUC), não o forjado.
- **Falsificação:** remova o `CHECK (valor_mensal_brl >= 0)` → o assert negativo do valor deve FICAR VERMELHO (prova que o assert tem dente). Restaure.

- [ ] **Step 2: Handoff com `lovable-db-operator`** — invoque a skill; ela gera o arquivo de migration no local canônico, o bloco pronto pro SQL Editor (o SQL do Step 1), a query de validação pós-apply e a nota pro PR. Query de validação pós-apply:

```sql
SELECT tablename FROM pg_tables WHERE tablename = 'fin_custo_rateio';
SELECT policyname, cmd FROM pg_policies WHERE tablename = 'fin_custo_rateio' ORDER BY policyname;
SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.fin_custo_rateio'::regclass AND NOT tgisinternal;
```
Expected: 1 tabela, 3 policies (`select_master`/`service_all`/`write_master`), 1 trigger.

- [ ] **Step 3: Commit** (o arquivo de migration + nota; a APLICAÇÃO em produção é manual pelo founder no SQL Editor — não confundir merge com apply).

```bash
git add -A
git commit -m "feat(db): fin_custo_rateio — custo fixo compartilhado (F3 v2), RLS master-only + trigger de autor"
```

---

### Task 3: Wiring `usePontoEquilibrio` — política, leitura, sinal, mutation, referência

**Files:**
- Modify: `src/hooks/usePontoEquilibrio.ts`

**Interfaces:**
- Consumes: `pontoEquilibrio`, `somaCodigosPorPrefixo`, `CustoCompartilhado` (Task 1); tabela `fin_custo_rateio` (Task 2).
- Produces (Tasks 4–5 rely on): `EMPRESAS_COM_FOLHA_EXTERNA`, `FAMILIA_FOLHA`, `useSalvarCustoRateio()`, `useFolhaReferencia(origem)`, e o `usePontoEquilibrio` agora retorna `{ data, isLoading, error, meses, rateio }` (rateio = a linha `CustoRateioRow | null` para o card/dialog).

- [ ] **Step 1: Constantes + tipos** — no topo de `usePontoEquilibrio.ts` (após os imports), adicione. Estenda o import de `../lib/financeiro/ponto-equilibrio-helpers` com `somaCodigosPorPrefixo` e `type CustoCompartilhado`:

```ts
/** Prefixo omie dos códigos de folha/pessoal (Salários, FGTS, INSS, VA, férias… todos 2.03.*). */
export const FAMILIA_FOLHA = ['2.03'];

/** Empresas cuja folha roda em OUTRA empresa do grupo → o PE exige rateio (§4 da spec). */
export const EMPRESAS_COM_FOLHA_EXTERNA: Record<string, { origem: string; rotulo: string }> = {
  oben: { origem: 'colacor_sc', rotulo: 'folha' },
};

export interface CustoRateioRow {
  company: string;
  rotulo: string;
  valor_mensal_brl: number;
  origem_company: string;
  observacao: string;
  ativo: boolean;
  updated_at: string;
}
```

- [ ] **Step 2: Query `useCustoRateio`** — adicione (segue o cast `unknown` de `useClassificacaoRows`):

```ts
/** Linha ativa de rateio (company + rotulo). fin_custo_rateio é master-only. */
function useCustoRateio(company: string | null, rotulo: string) {
  return useQuery({
    queryKey: ['custo_rateio', company, rotulo],
    enabled: Boolean(company),
    staleTime: STALE,
    queryFn: async (): Promise<CustoRateioRow | null> => {
      const client = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (col: string, val: string) => {
              eq: (col: string, val: string) => {
                eq: (
                  col: string,
                  val: boolean,
                ) => {
                  maybeSingle: () => Promise<{ data: CustoRateioRow | null; error: { message: string } | null }>;
                };
              };
            };
          };
        };
      };
      const { data, error } = await client
        .from('fin_custo_rateio')
        .select('company,rotulo,valor_mensal_brl,origem_company,observacao,ativo,updated_at')
        .eq('company', company!)
        .eq('rotulo', rotulo)
        .eq('ativo', true)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? null;
    },
  });
}
```

- [ ] **Step 3: Injete no `usePontoEquilibrio`** — substitua o corpo do hook principal por:

```ts
export function usePontoEquilibrio(company: string | null) {
  const politica = company ? EMPRESAS_COM_FOLHA_EXTERNA[company] : undefined;
  const snaps = useSnapshotsTTM(company);
  const classif = useClassificacaoRows(company);
  const rateioQ = useCustoRateio(company, politica?.rotulo ?? 'folha');
  const isLoading = snaps.isLoading || classif.isLoading || (Boolean(politica) && rateioQ.isLoading);
  const error = snaps.error ?? classif.error ?? rateioQ.error;

  const data = useMemo<PontoEquilibrioResult | null>(() => {
    if (!snaps.data || !classif.data) return null;
    const row = rateioQ.data ?? null;
    const custoCompartilhado: CustoCompartilhado | null = row
      ? { valor_mensal: Number(row.valor_mensal_brl), origem: row.origem_company, rotulo: row.rotulo }
      : null;
    return pontoEquilibrio({
      meses: snaps.data,
      classificacao: resolverClassificacao(classif.data, company),
      custoCompartilhado,
      exigeCustoCompartilhado: Boolean(politica),
      custoCompartilhadoNoSnapshotTtm: somaCodigosPorPrefixo(snaps.data, FAMILIA_FOLHA),
    });
  }, [snaps.data, classif.data, rateioQ.data, company, politica]);

  return { data, isLoading, error, meses: snaps.data ?? [], rateio: rateioQ.data ?? null };
}
```

- [ ] **Step 4: Mutation `useSalvarCustoRateio`** — adicione (molde `useSalvarDreClassificacao`):

```ts
/** Salva (upsert) o rateio de custo compartilhado. Master-only. updated_by/at pelo trigger. */
export function useSalvarCustoRateio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      company: string;
      rotulo: string;
      valor_mensal_brl: number;
      origem_company: string;
      observacao: string;
      ativo?: boolean;
    }) => {
      const client = supabase as unknown as {
        from: (t: string) => {
          upsert: (
            values: Record<string, unknown>,
            options: { onConflict: string },
          ) => Promise<{ error: { message: string } | null }>;
        };
      };
      const { error } = await client.from('fin_custo_rateio').upsert(
        {
          company: vars.company,
          rotulo: vars.rotulo,
          valor_mensal_brl: vars.valor_mensal_brl,
          origem_company: vars.origem_company,
          observacao: vars.observacao,
          ativo: vars.ativo ?? true,
        },
        { onConflict: 'company,rotulo' },
      );
      if (error) throw error;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['custo_rateio', vars.company, vars.rotulo] });
      toast.success('Rateio salvo. Recalculando o ponto de equilíbrio…');
    },
    onError: (e) => {
      toast.error('Falha ao salvar o rateio', { description: e instanceof Error ? e.message : String(e) });
    },
  });
}
```

- [ ] **Step 5: `useFolhaReferencia`** — adicione (lê a folha `2.03.*` da origem, com descrições, marcando ambíguos):

```ts
export interface FolhaRefLinha { codigo: string; descricao: string; mediaMes: number; ambiguo: boolean }
/** Adiantamento de Salário (antecipação compensável) e IRRF (retenção do empregado) — não custo econômico limpo. */
const FOLHA_AMBIGUA = new Set(['2.03.02', '2.03.08']);

/** Composição da folha (2.03.*) da empresa de origem, TTM, p/ o dialog dimensionar o rateio (referência, não input). */
export function useFolhaReferencia(origem: string): {
  linhas: FolhaRefLinha[];
  totalMes: number;
  totalLimpoMes: number;
  isLoading: boolean;
} {
  const snaps = useSnapshotsTTM(origem);
  const cats = useQuery({
    queryKey: ['fin_categorias_desc', origem],
    enabled: Boolean(origem),
    staleTime: STALE,
    queryFn: async (): Promise<Record<string, string>> => {
      const { data, error } = await supabase.from('fin_categorias').select('omie_codigo,descricao').eq('company', origem);
      if (error) throw error;
      const out: Record<string, string> = {};
      for (const r of (data ?? []) as unknown as { omie_codigo: string; descricao: string | null }[])
        if (r.omie_codigo) out[r.omie_codigo] = r.descricao ?? '';
      return out;
    },
  });

  const agg = useMemo(() => {
    if (!snaps.data) return { linhas: [] as FolhaRefLinha[], totalMes: 0, totalLimpoMes: 0 };
    const n = snaps.data.length || 1;
    const porCod = new Map<string, number>();
    for (const m of snaps.data)
      for (const [cod, v] of Object.entries(m.despesas))
        if (FAMILIA_FOLHA.some((p) => cod.startsWith(p))) porCod.set(cod, (porCod.get(cod) ?? 0) + v);
    const desc = cats.data ?? {};
    const linhas = [...porCod.entries()]
      .map(([codigo, ttm]) => ({
        codigo,
        descricao: desc[codigo] ?? '',
        mediaMes: ttm / n,
        ambiguo: FOLHA_AMBIGUA.has(codigo),
      }))
      .sort((a, b) => b.mediaMes - a.mediaMes);
    const totalMes = linhas.reduce((s, l) => s + l.mediaMes, 0);
    const totalLimpoMes = linhas.reduce((s, l) => s + (l.ambiguo ? 0 : l.mediaMes), 0);
    return { linhas, totalMes, totalLimpoMes };
  }, [snaps.data, cats.data]);

  return { ...agg, isLoading: snaps.isLoading || cats.isLoading };
}
```

> `useSnapshotsTTM` já existe no arquivo — se estiver marcada como não-exportada, mantenha; ela é chamada aqui internamente (mesmo módulo).

- [ ] **Step 6: Typecheck + testes** (o helper puro `somaCodigosPorPrefixo` já é coberto na Task 1)

Run: `heavy bun run typecheck && heavy bun run test -- ponto-equilibrio`
Expected: sem erros de tipo; testes verdes.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/usePontoEquilibrio.ts
git commit -m "feat(financeiro): F3 v2 — wiring do rateio (política, leitura, sinal anti-duplicidade, mutation, referência)"
```

---

### Task 4: `RateioFolhaDialog` — form de lançamento + referência viva

**Files:**
- Create: `src/components/financeiro/dashboard/RateioFolhaDialog.tsx`

**Interfaces:**
- Consumes: `useSalvarCustoRateio`, `useFolhaReferencia`, `CustoRateioRow` (Task 3); `fmt`/`fmtCompact` de `./format`.
- Produces: `<RateioFolhaDialog company origem rotulo atual open onOpenChange />`.

- [ ] **Step 1: Crie o componente** com o conteúdo completo:

```tsx
// src/components/financeiro/dashboard/RateioFolhaDialog.tsx
// F3 v2 — master lança o rateio de custo fixo compartilhado (parcela da folha da CSC atribuível à OBEN).
// Referência VIVA: a folha 2.03.* da origem (composição, marcando ambíguos) como TETO — nunca pré-preenche.
// Três ações distintas (C4): Salvar / Confirmar sem folha (R$0) / Remover (desativa → volta a pendente).
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle } from 'lucide-react';
import { useSalvarCustoRateio, useFolhaReferencia, type CustoRateioRow } from '@/hooks/usePontoEquilibrio';
import { fmt } from '@/components/financeiro/dashboard/format';

/** Parse fail-closed de R$ digitado (pt-BR): retorna null em ilegível/negativo (nunca fabrica 0). */
function parseValor(s: string): number | null {
  const limpo = s.trim().replace(/\./g, '').replace(',', '.');
  if (limpo === '') return null;
  const n = Number(limpo);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function RateioFolhaDialog({
  company,
  origem,
  rotulo,
  atual,
  open,
  onOpenChange,
}: {
  company: string;
  origem: string;
  rotulo: string;
  atual: CustoRateioRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const salvar = useSalvarCustoRateio();
  const ref = useFolhaReferencia(origem);
  const [valor, setValor] = useState(atual ? String(atual.valor_mensal_brl).replace('.', ',') : '');
  const [obs, setObs] = useState(atual?.observacao ?? '');

  const parsed = parseValor(valor);
  const obsOk = obs.trim().length > 0;
  const podeSalvar = parsed != null && parsed > 0 && obsOk && !salvar.isPending;
  const podeZerar = obsOk && !salvar.isPending;

  const gravar = (valor_mensal_brl: number, ativo: boolean) =>
    salvar.mutate(
      { company, rotulo, valor_mensal_brl, origem_company: origem, observacao: obs.trim() || 'sem folha atribuível', ativo },
      { onSuccess: () => onOpenChange(false) },
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Rateio da folha — {company.toUpperCase()}</DialogTitle>
          <DialogDescription>
            A folha da {company.toUpperCase()} roda na {origem.replace('_', ' ').toUpperCase()}. Lance a parcela mensal
            atribuível à operação — o PE a soma ao custo fixo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium">Custo mensal normalizado (R$)</label>
            <Input
              inputMode="decimal"
              value={valor}
              onChange={(e) => setValor(e.target.value)}
              placeholder="ex.: 18.000"
            />
            <p className="text-[10px] text-muted-foreground">Anual ÷ 12, já com 13º, férias e encargos.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium">Como chegou nesse valor? (obrigatório)</label>
            <Textarea
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              placeholder="ex.: 70% da folha da CSC = 5 pessoas alocadas na operação da OBEN"
              className="text-xs min-h-[60px]"
            />
          </div>

          {/* Referência viva: composição da folha da origem (TETO, não pré-preenche). */}
          <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
            <p className="text-xs font-medium">
              Referência — folha da {origem.replace('_', ' ').toUpperCase()}:{' '}
              {ref.isLoading ? '…' : <strong>{fmt(ref.totalMes)}/mês</strong>}
              {!ref.isLoading && ref.totalLimpoMes !== ref.totalMes && (
                <span className="text-muted-foreground"> (sem ambíguos: {fmt(ref.totalLimpoMes)})</span>
              )}
            </p>
            <p className="text-[10px] text-muted-foreground">
              Teto — a parcela da {company.toUpperCase()} é uma fração ({origem.replace('_', ' ').toUpperCase()} tem
              operação própria).
            </p>
            <div className="max-h-40 overflow-y-auto divide-y text-[11px]">
              {ref.linhas.map((l) => (
                <div key={l.codigo} className="flex items-center justify-between py-1 gap-2">
                  <span className="truncate">
                    {l.descricao || l.codigo}
                    {l.ambiguo && (
                      <span className="ml-1 inline-flex items-center gap-0.5 text-status-warning">
                        <AlertTriangle className="w-2.5 h-2.5" /> pagamento, não custo econômico
                      </span>
                    )}
                  </span>
                  <span className="font-mono shrink-0">{fmt(l.mediaMes)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {atual && (
              <Button
                variant="ghost"
                size="sm"
                disabled={salvar.isPending}
                onClick={() => gravar(atual.valor_mensal_brl, false)}
                className="text-status-error"
              >
                Remover
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={!podeZerar} onClick={() => gravar(0, true)}>
              Confirmar sem folha (R$ 0)
            </Button>
            <Button size="sm" disabled={!podeSalvar} onClick={() => parsed != null && gravar(parsed, true)}>
              Salvar rateio
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verifique tipos e lint**

Run: `heavy bun run typecheck && bun lint src/components/financeiro/dashboard/RateioFolhaDialog.tsx`
Expected: sem erros. (`@/components/ui/textarea` e os tokens `status-info-*` confirmados presentes.)

- [ ] **Step 3: Commit**

```bash
git add src/components/financeiro/dashboard/RateioFolhaDialog.tsx
git commit -m "feat(financeiro): F3 v2 — RateioFolhaDialog (lançamento + referência viva da folha CSC)"
```

---

### Task 5: `PontoEquilibrioCard` — estados novos (pendente/duplicidade/disclosure/latente)

**Files:**
- Modify: `src/components/financeiro/dashboard/PontoEquilibrioCard.tsx`

**Interfaces:**
- Consumes: `usePontoEquilibrio` (agora retorna `rateio`), `RateioFolhaDialog`, `EMPRESAS_COM_FOLHA_EXTERNA` (Task 3/4); `MotivoPE` estendido (Task 1).

- [ ] **Step 1: Imports + entradas de mensagem** — adicione ao import de `usePontoEquilibrio` a constante `EMPRESAS_COM_FOLHA_EXTERNA`; importe `RateioFolhaDialog`; adicione as 2 entradas em `MOTIVO_MSG` (duplicidade tem msg genérica; o pendente é tratado à parte no Step 2):

```ts
  custo_compartilhado_possivel_duplicidade: {
    titulo: 'Possível dupla contagem da folha',
    texto: 'Há folha (2.03.*) no próprio snapshot desta empresa — somar o rateio dobraria o custo. Revise a classificação ou zere o rateio.',
  },
  custo_compartilhado_pendente: {
    titulo: 'Falta ratear a folha',
    texto: 'A folha desta operação roda em outra empresa do grupo e ainda não foi rateada.',
  },
```

- [ ] **Step 2: Estado do dialog + ramo pendente + disclosure** — dentro do componente, após `const [abrirClassif, setAbrirClassif] = useState(false);` adicione:

```ts
  const [abrirRateio, setAbrirRateio] = useState(false);
  const politica = EMPRESAS_COM_FOLHA_EXTERNA[company];
```

Substitua o ramo `data.motivo !== 'ok'` para tratar o **pendente** com estado próprio (MC%/fixo conhecido + CTA), mantendo o genérico para o resto:

```tsx
          ) : data.motivo === 'custo_compartilhado_pendente' ? (
            <div className="flex items-start gap-3 py-2">
              <AlertTriangle className="w-5 h-5 text-status-warning mt-0.5 shrink-0" />
              <div className="space-y-2">
                <p className="text-sm font-medium text-status-warning-fg">Falta ratear a folha</p>
                <p className="text-sm text-muted-foreground">
                  A operação <em>parece</em> se pagar fácil (margem de contribuição{' '}
                  <strong>{pct(data.mc_pct)}</strong>, custo fixo conhecido{' '}
                  <strong>{fmt((data.custos_fixos ?? 0) / n)}/mês</strong>), mas a mão de obra não está aqui — a folha
                  roda na <strong>{(politica?.origem ?? '').replace('_', ' ').toUpperCase()}</strong>. Lance o rateio
                  para ver a margem real.
                </p>
                <Button size="sm" onClick={() => setAbrirRateio(true)}>
                  Lançar rateio da folha
                </Button>
              </div>
            </div>
          ) : data.motivo !== 'ok' ? (
            <div className="flex items-start gap-3 py-2">
              <AlertTriangle className="w-5 h-5 text-status-warning mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-status-warning-fg">{MOTIVO_MSG[data.motivo].titulo}</p>
                <p className="text-sm text-muted-foreground">{MOTIVO_MSG[data.motivo].texto}</p>
                {data.cobertura_pct != null && data.motivo === 'inconclusivo' && (
                  <p className="text-xs text-muted-foreground">
                    Cobertura atual: {pct(data.cobertura_pct)} do valor das despesas classificado.
                  </p>
                )}
                {data.custo_compartilhado_pendente_latente && (
                  <p className="text-xs text-status-warning">Além disto, falta ratear a folha (roda na CSC).</p>
                )}
              </div>
            </div>
          ) : (
```

- [ ] **Step 3: Disclosure positivo do rateio** — no ramo `ok`, logo após o bloco do disclosure `excluido_nao_operacional_ttm > 0`, adicione:

```tsx
              {data.custo_compartilhado_ttm > 0 && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-status-info-bg border border-status-info/30">
                  <Target className="w-4 h-4 text-status-info mt-0.5 shrink-0" />
                  <p className="text-xs text-status-info-fg">
                    PE <strong>inclui {fmt(data.custo_compartilhado_ttm / n)}/mês</strong> de folha rateada da{' '}
                    {(data.custo_compartilhado_origem ?? '').replace('_', ' ').toUpperCase()}. É custo{' '}
                    <strong>econômico</strong>, não saída de caixa da {company.toUpperCase()} (a folha é paga pela
                    origem — caixa por-CNPJ não-fungível).
                  </p>
                </div>
              )}
```

- [ ] **Step 4: Monte o dialog** — antes do fechamento `</>`, ao lado do `ClassificacaoCustoDialog`:

```tsx
      {abrirRateio && politica && (
        <RateioFolhaDialog
          company={company}
          origem={politica.origem}
          rotulo={politica.rotulo}
          atual={rateio}
          open={abrirRateio}
          onOpenChange={setAbrirRateio}
        />
      )}
```

E no destructuring do hook, capture `rateio`: `const { data, isLoading, error, meses, rateio } = usePontoEquilibrio(company);`

- [ ] **Step 5: Typecheck + build + verificação visual**

Run: `heavy bun run typecheck && heavy bun run build`
Expected: sem erros.

Verificação visual (money-path — o card muda de comportamento): use a skill `verify` ou o preview para confirmar, logando como OBEN/master:
- Sem rateio → card mostra "Falta ratear a folha" (não os 90%), com MC%, fixo conhecido e o botão.
- Após lançar (dialog) → card mostra PE/margem corrigidos + disclosure "PE inclui R$X/mês de folha rateada".
- `confirmar R$0` → card volta a `ok` com PE de hoje (sem disclosure de folha).

- [ ] **Step 6: Commit**

```bash
git add src/components/financeiro/dashboard/PontoEquilibrioCard.tsx
git commit -m "feat(financeiro): F3 v2 — card com estados de rateio (pendente/duplicidade/disclosure/latente)"
```

---

## Self-Review (rodado ao escrever o plano)

**Spec coverage:** §2 fórmula→Task 1 Step 5c · §3 tabela→Task 2 · §4 política→Task 3 Step 1 · §5 gates+contrato→Task 1 · §6 UI→Tasks 4–5 · §7 wiring→Task 3 · §8 provas→Task 1 (vitest) + Task 2 (prove-sql) · §11 rollout→Task 5 Step 5 (verificação) + Task 2 Step 3 (apply manual). ✓
**Type consistency:** `custo_compartilhado_ttm/_mensal/_origem/_pendente_latente`, `can_show_break_even`, `CustoCompartilhado{valor_mensal,origem,rotulo}`, `CustoRateioRow{valor_mensal_brl,origem_company,…}`, `somaCodigosPorPrefixo`, `useFolhaReferencia`, `useSalvarCustoRateio`, `EMPRESAS_COM_FOLHA_EXTERNA{origem,rotulo}` — nomes idênticos entre tasks. ✓
**Placeholders:** nenhum — todo step tem código/SQL/comando reais. ✓
**Riscos deixados ao executor:** confirmar `textarea` em `ui/` (Task 4 Step 2 tem fallback); o limiar do gate de duplicidade reusa `materialDespesaPct` (calibrável no CONFIG se necessário).

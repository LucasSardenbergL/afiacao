# Custo Marginal de Funding — Plano sub-PR B: Planejador de Cobertura de Gap

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Passos com checkbox.

**Goal:** Dado um gap de caixa previsto (projeção 13s), recomendar a **mistura de fontes mais barata em R$** pra cobrir o déficit (merit-order: caixa próprio até o disponível → dívida → antecipação → cheque), com o **custo da inércia em R$** ("não fazer nada custa R$ X"). E, compondo o A4, usar o **retorno marginal do melhor uso** como benchmark da decisão de antecipação em sobra (fecha o gancho que o sub-PR A deixou como `null`).

**Architecture:** Estende o helper puro `funding-helpers.ts` (TDD) + espelha na edge `fin-funding`. A edge passa a compor `fin-next-best-action` (A4 → `caixa_livre` + `retorno_marginal`) via service_role, identifica o gap na projeção 13s e roda o planejador. Frontend: nova seção "Planejador de cobertura" na página `/financeiro/funding`. Sem migration nova (reusa `fin_funding_inputs`; capacidade de dívida = ilimitada no v1).

**Tech Stack:** TypeScript, vitest, Supabase Edge (Deno), React + React Query + shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-05-25-financeiro-funding-divida-design.md` (seção "Planejador de cobertura de gap (sub-PR B)").

**Pré-requisito:** sub-PR A (#345) mergeado — `funding-helpers.ts`, `fin-funding`, página e `useFunding` já existem.

---

### Task 1: Helper — identificar gap + merit-order do planejador (TDD)

**Files:**
- Modify: `src/lib/financeiro/funding-helpers.ts`
- Modify: `src/lib/financeiro/__tests__/funding-helpers.test.ts`

- [ ] **Step 1: Testes que falham** (append no test file)

```ts
import { identificarGap, montarPlanoCobertura, type FonteCobertura } from '../funding-helpers';

describe('identificarGap', () => {
  const wk = (saldos: number[]): import('../funding-helpers').Semana[] =>
    saldos.map((s, i) => ({ inicio: `2026-W${i}`, fim: `2026-W${i}`, saldo_final: s, total_saidas: 0, entradas: [] }));
  it('sem semana abaixo da reserva → sem gap', () => {
    expect(identificarGap({ semanas: wk([5000, 6000, 7000]), reserva_rs: 1000 })).toBeNull();
  });
  it('acha o vale mais profundo + gap_rs + horizonte', () => {
    // reserva 2000; pior saldo = 500 na semana idx 2 → gap_rs = 2000-500 = 1500; horizonte = (2+1)*7 = 21
    const g = identificarGap({ semanas: wk([3000, 2500, 500, 4000]), reserva_rs: 2000 });
    expect(g).not.toBeNull();
    expect(g!.gap_rs).toBe(1500);
    expect(g!.semana_idx).toBe(2);
    expect(g!.horizonte_dias).toBe(21);
  });
});

describe('montarPlanoCobertura', () => {
  const fontes = (): FonteCobertura[] => [
    { fonte: 'caixa_proprio', rate_aa: 0.18, capacidade_rs: 1000, governanca_ordem: 0 },
    { fonte: 'capital_giro', rate_aa: 0.30, capacidade_rs: Infinity, governanca_ordem: 1 },
    { fonte: 'cheque_especial', rate_aa: 1.50, capacidade_rs: Infinity, governanca_ordem: 3 },
  ];
  it('preenche o gap do mais barato (R$) pro mais caro, respeitando capacidade', () => {
    // gap 3000, horizonte 30d. caixa próprio (18%) cobre 1000; resto (2000) vai pro próximo mais barato em R$.
    const p = montarPlanoCobertura({ gap_rs: 3000, horizonte_dias: 30, fontes: fontes(), cheque_rate_aa: 1.50 });
    expect(p.stack[0].fonte).toBe('caixa_proprio');
    expect(p.stack[0].montante_rs).toBe(1000);
    expect(p.stack.reduce((s, x) => s + x.montante_rs, 0)).toBeCloseTo(3000, 2);
    expect(p.custo_total_rs).toBeGreaterThan(0);
    // custo da inércia = financiar o gap inteiro no cheque pelo horizonte
    expect(p.custo_inercia_rs).toBeCloseTo(3000 * (Math.pow(1 + 1.50, 30/365) - 1), 2);
  });
  it('cheque pode vencer gap CURTÍSSIMO em R$ (flag emergência)', () => {
    // horizonte 2 dias: mesmo a 150% a.a., o R$ é minúsculo → cheque pode entrar barato; recebe flag.
    const p = montarPlanoCobertura({ gap_rs: 5000, horizonte_dias: 2, fontes: [
      { fonte: 'capital_giro', rate_aa: 0.30, capacidade_rs: 0, governanca_ordem: 1 },
      { fonte: 'cheque_especial', rate_aa: 1.50, capacidade_rs: Infinity, governanca_ordem: 3 },
    ], cheque_rate_aa: 1.50 });
    const cheque = p.stack.find((s) => s.fonte === 'cheque_especial');
    expect(cheque).toBeTruthy();
    expect(cheque!.flag).toBe('emergencia');
  });
  it('capacidade insuficiente de todas as fontes → cobre o que dá + flag descoberto', () => {
    const p = montarPlanoCobertura({ gap_rs: 5000, horizonte_dias: 30, fontes: [
      { fonte: 'caixa_proprio', rate_aa: 0.18, capacidade_rs: 1000, governanca_ordem: 0 },
    ], cheque_rate_aa: null });
    expect(p.stack.reduce((s, x) => s + x.montante_rs, 0)).toBe(1000);
    expect(p.motivos.join(' ')).toMatch(/descoberto/i);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/financeiro/__tests__/funding-helpers.test.ts`.

- [ ] **Step 3: Implementar** (append em `funding-helpers.ts`)

```ts
export function identificarGap(input: {
  semanas: Semana[]; reserva_rs: number;
}): { gap_rs: number; semana_idx: number; horizonte_dias: number } | null {
  if (input.semanas.length === 0) return null;
  let piorIdx = -1; let piorSaldo = Infinity;
  input.semanas.forEach((s, i) => { if (s.saldo_final < piorSaldo) { piorSaldo = s.saldo_final; piorIdx = i; } });
  if (piorSaldo >= input.reserva_rs) return null; // nunca fura a reserva → sem gap
  return { gap_rs: input.reserva_rs - piorSaldo, semana_idx: piorIdx, horizonte_dias: (piorIdx + 1) * 7 };
}

export type FonteCobertura = {
  fonte: TipoFonte; rate_aa: number; capacidade_rs: number; governanca_ordem: number;
};
export type ItemStack = { fonte: TipoFonte; montante_rs: number; custo_rs: number; flag?: string };
export type PlanoCobertura = {
  gap_rs: number; horizonte_dias: number; stack: ItemStack[];
  custo_total_rs: number; custo_inercia_rs: number; motivos: string[];
};

export function montarPlanoCobertura(input: {
  gap_rs: number; horizonte_dias: number; fontes: FonteCobertura[]; cheque_rate_aa: number | null;
}): PlanoCobertura {
  const { gap_rs, horizonte_dias } = input;
  const motivos: string[] = [];
  // Ordena por CUSTO EM R$ de prover 1 real pelo horizonte (não por % a.a.); desempate por governança.
  const ordenadas = [...input.fontes].sort((a, b) => {
    const ca = custoEmReais(1, horizonte_dias, a.rate_aa);
    const cb = custoEmReais(1, horizonte_dias, b.rate_aa);
    if (ca !== cb) return ca - cb;
    return a.governanca_ordem - b.governanca_ordem;
  });
  const stack: ItemStack[] = [];
  let restante = gap_rs;
  for (const f of ordenadas) {
    if (restante <= 0) break;
    const usa = Math.min(restante, f.capacidade_rs);
    if (usa <= 0) continue;
    const item: ItemStack = { fonte: f.fonte, montante_rs: usa, custo_rs: custoEmReais(usa, horizonte_dias, f.rate_aa) };
    // Cheque especial que entra antes do "último por governança" (venceu em R$) → flag emergência.
    if (f.fonte === 'cheque_especial' && f.governanca_ordem >= 3) item.flag = 'emergencia';
    stack.push(item);
    restante -= usa;
  }
  if (restante > 0.01) motivos.push(`Capacidade das fontes insuficiente — R$ ${restante.toFixed(2)} descoberto.`);
  const custo_total_rs = stack.reduce((s, x) => s + x.custo_rs, 0);
  const custo_inercia_rs = input.cheque_rate_aa != null ? custoEmReais(gap_rs, horizonte_dias, input.cheque_rate_aa) : 0;
  return { gap_rs, horizonte_dias, stack, custo_total_rs, custo_inercia_rs, motivos };
}
```

- [ ] **Step 4: Rodar e ver passar.**
- [ ] **Step 5: Commit** — `git commit -m "feat(funding): identificarGap + montarPlanoCobertura (merit-order em R$) + testes"`.

---

### Task 2: Engine — compõe A4, identifica gap, roda planejador + wire retorno_marginal

**Files:**
- Modify: `supabase/functions/fin-funding/index.ts`

**Contexto:** copie as 2 funções novas (`identificarGap`, `montarPlanoCobertura` + tipos `FonteCobertura`/`ItemStack`/`PlanoCobertura`) VERBATIM do helper pro engine (estilo Deno). Compõe `fin-next-best-action` igual o A4 compõe A1/A2/A3 (`fetch` service_role + `AbortController` 20s).

- [ ] **Step 1: Compor A4** — após ler a projeção, `fetch` POST `${SUPABASE_URL}/functions/v1/fin-next-best-action` (Bearer service_role, timeout 20s). Do retorno: `caixa_livre = caixa_por_empresa[company]?.disponivel ?? null`; `retorno_marginal = ` derivar do melhor uso (a 1ª ação `crescer`/`consertar_valor` com `status` financiável): se houver `hurdle` da empresa + `spread_positivo`, `retorno_marginal = hurdle + max(0, spread_estimado)`; senão `null`. Se a chamada falhar/timeout → `caixa_livre=null`, `retorno_marginal=null` (degrada; planejador usa só dívida/cheque/antecipação, e a decisão de sobra cai pra `cm_anual`). **Comentar o approximation de `retorno_marginal`** (v1).
- [ ] **Step 2: Wire retorno_marginal nas decisões por título** — trocar `retorno_marginal_a4: null` por `retorno_marginal_a4: retorno_marginal` na chamada de `decidirTitulo` (agora a sobra usa o melhor uso do A4, não só `cm_anual`).
- [ ] **Step 3: Rodar o planejador** — `identificarGap({ semanas, reserva_rs })`. Se houver gap, montar as `FonteCobertura`:
  - `caixa_proprio`: `rate_aa = cm_anual ?? 0` (se null, exclui + motivo), `capacidade_rs = max(0, caixa_livre ?? 0)`, `governanca_ordem = 0`.
  - `capital_giro`: `rate_aa = capital_giro_cet` (se ativo/≠null), `capacidade_rs = Infinity`, `ordem = 1`.
  - `antecipacao`: pra v1 do planejador, **capacidade = soma dos `v_liq` dos títulos antecipáveis que vencem DEPOIS da semana do gap** (só esses adiantam caixa pro gap); `rate_aa` = taxa efetiva média ponderada das antecipações (ou exclui se sem taxa); `ordem = 2`. (Se ficar complexo, v1 pode usar só `caixa/dívida/cheque` no planejador e listar a antecipação à parte — decisão do implementador, documentar.)
  - `cheque_especial`: `rate_aa = cheque_cet` (se ativo), `capacidade_rs = Infinity`, `ordem = 3`.
  - `montarPlanoCobertura({ gap_rs, horizonte_dias, fontes, cheque_rate_aa: cheque_cet })`.
- [ ] **Step 4: Resposta** — adicionar ao JSON de retorno: `plano_cobertura: PlanoCobertura | null` (null se sem gap ou sem projeção) + `caixa_livre` + `retorno_marginal`. Manter tudo que já retorna.
- [ ] **Step 5: `deno check`** (se disponível) + **diff de paridade** helper↔engine das 2 funções novas.
- [ ] **Step 6: Commit** — `git commit -m "feat(funding): engine compõe A4 (caixa_livre+retorno_marginal) + planejador de cobertura"`.

---

### Task 3: Tipos + hook (expor plano_cobertura)

**Files:**
- Modify: `src/services/financeiroService.ts` (estende `FundingResult` com `plano_cobertura: PlanoCobertura | null`, `caixa_livre: number | null`, `retorno_marginal: number | null`; importa `PlanoCobertura` de `@/lib/financeiro/funding-helpers`)
- (hook `useFunding` não muda — só o tipo do retorno)

- [ ] **Step 1:** estende `FundingResult` no `financeiroService.ts`.
- [ ] **Step 2:** `bunx tsc --noEmit -p tsconfig.app.json` limpo.
- [ ] **Step 3: Commit** — `git commit -m "feat(funding): tipos do plano_cobertura no contrato"`.

---

### Task 4: Frontend — seção "Planejador de cobertura" na página

**Files:**
- Modify: `src/pages/FinanceiroFunding.tsx`

- [ ] **Step 1:** Acima/abaixo da tabela de títulos, render condicional quando `data.plano_cobertura != null`:
  - Card "Planejador de cobertura de gap" com: gap (R$) + semana + horizonte (dias).
  - A **stack** (fonte → montante R$ → custo R$), destacando a fonte mais barata; chip "emergência" na linha do cheque quando `flag === 'emergencia'`.
  - **Custo total** da mistura vs **custo da inércia** ("não fazer nada custa R$ X") — lado a lado, `custo_inercia` em `text-status-error` se > custo_total.
  - `motivos` (ex.: descoberto) como aviso.
  - Quando `plano_cobertura == null` e `tem_projecao`: nota "Sem gap de caixa previsto nas 13 semanas — nenhuma cobertura necessária."
- [ ] **Step 2:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 3: Commit** — `git commit -m "feat(funding): seção Planejador de cobertura na página de funding"`.

---

### Task 5: Docs + validação + Codex adversarial + PR

**Files:**
- Modify: `docs/FINANCEIRO_CONFIABILIDADE.md` (atualiza a seção Funding: sub-PR B entregue — planejador, composição A4, custo da inércia; tira da lista "sub-PR B (depois)")

- [ ] **Step 1:** atualizar a doc.
- [ ] **Step 2: Validação completa** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` (config que checa o src!) + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex adversarial** — `codex exec` (read-only) no `funding-helpers.ts` + `fin-funding/index.ts`: foco em merit-order (ordena por R$ no horizonte?), composição A4 sem double-count, derivação do `retorno_marginal`, gap/horizonte, paridade helper↔engine. Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (corpo: sem migration; **re-deploy da edge `fin-funding`** via chat do Lovable após merge); auto-merge `--squash --auto`. Resolver conflito dos audit files (se houver) tomando a versão da main.
- [ ] **Step 5: Entregável** — avisar o founder: re-deploy da `fin-funding` (verbatim do repo) após o merge. (Sem migration nesta sub-PR.)

---

## Notas
- **Heavy** em test/build/typecheck. **`tsc --noEmit -p tsconfig.app.json`** é o typecheck que pega erros no `src` (o `tsc --noEmit` puro do CI é no-op — ver lição).
- **Sem migration** — reusa `fin_funding_inputs`. Capacidade de dívida/cheque = ilimitada no v1 (limite por instrumento = v2).
- **Simplificações v1 documentadas:** `caixa_livre` = `caixa_disponivel` do A4 (não desconta ação A4 "aprovada" — A4 não rastreia aprovação); `retorno_marginal` = `hurdle + max(0,spread)` aproximado; gap = vale mais profundo da projeção (não soma déficits multi-semana).

# Edge `omie-onorder-probe` (medir + confirmar on-order) — Implementation Plan

> ⛔ **SUPERADO em 2026-06-26 — NÃO EXECUTAR.** A probe foi descartada antes de deployar: descobri que `purchase_orders_tracking` já é a réplica-por-PO que a probe ia diagnosticar, que o #1076 (que a corrige) foi revertido por auto-commit do Lovable, e medi a cobertura direto via `psql-ro` (28 POs nulas; futuras cortadas). Pivotei para restaurar o #1076 + guardrail CI (commits `498052a8` + guardrail). As Tasks 1-2 (helpers) chegaram a ser implementadas (commit `08a7eb43`) e depois removidas (virariam deadcode); ficam no histórico para o redesign B futuro. Ver a nota de STATUS no spec `2026-06-26-reposicao-onorder-medir-confirmar-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Edge de diagnóstico read-only que CONFIRMA a semântica da janela do `PesquisarPedCompra` (5 probes) e MEDE quantas POs abertas escapam do "a caminho", gravando o relatório em `sync_state('onorder_probe')` para leitura via `psql-ro`.

**Architecture:** Helpers puros testáveis (vitest) para a análise de cobertura (classificação de sub-classe + diferença de conjuntos), espelhados verbatim na edge Deno. A edge faz as chamadas Omie controladas, usa os helpers para analisar, e grava o relatório em `sync_state` (NÃO toca `sku_estoque_atual` nem o cálculo do motor). O founder deploya; eu invoco via `net.http_post` e leio o relatório via `psql-ro`.

**Tech Stack:** Deno edge (Supabase), TS helper em `src/lib/reposicao/`, vitest, API Omie (`PesquisarPedCompra`, `ListarSaldoPendente`).

**Spec:** `docs/superpowers/specs/2026-06-26-reposicao-onorder-medir-confirmar-design.md`

---

## File Structure

- Create: `src/lib/reposicao/onorder-probe-analise.ts` — helpers puros (classificação + diferença de cobertura).
- Create: `src/lib/reposicao/__tests__/onorder-probe-analise.test.ts` — testes vitest.
- Create: `supabase/functions/omie-onorder-probe/index.ts` — a edge (espelha o helper + I/O Omie + grava sync_state).
- Reference (NÃO modificar): `supabase/functions/omie-sync-estoque/index.ts` (padrão de `callOmie`, credencial, `ListarSaldoPendente`, `callOmiePedidos`), `supabase/functions/_shared/auth.ts` (`authorizeCronOrStaff`).

---

## Task 1: Helper puro — classificação de sub-classe de cobertura

**Files:**
- Create: `src/lib/reposicao/onorder-probe-analise.ts`
- Test: `src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { classificarCobertura, type SubClasse } from "../onorder-probe-analise";

// hoje fixo p/ determinismo; datas em ISO yyyy-mm-dd. Janela [hoje-365, hoje+120].
const HOJE = "2026-06-26";

describe("classificarCobertura", () => {
  it("previsão dentro da janela → dentro_janela", () => {
    expect(classificarCobertura("2026-07-10", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela");
    expect(classificarCobertura("2026-06-26", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela"); // limite hoje
    expect(classificarCobertura("2025-06-26", HOJE, 365, 120)).toBe<SubClasse>("dentro_janela"); // limite -365
  });
  it("previsão nula → previsao_nula (escapa)", () => {
    expect(classificarCobertura(null, HOJE, 365, 120)).toBe<SubClasse>("previsao_nula");
  });
  it("previsão futura além de +120d → futura_alem_janela (escapa)", () => {
    expect(classificarCobertura("2026-10-25", HOJE, 365, 120)).toBe<SubClasse>("futura_alem_janela"); // +121d
  });
  it("previsão atrasada além de -365d → atrasada_alem_janela (escapa)", () => {
    expect(classificarCobertura("2025-06-25", HOJE, 365, 120)).toBe<SubClasse>("atrasada_alem_janela"); // -366d
  });
  it("data malformada → previsao_nula (fail-safe: tratamos como invisível)", () => {
    expect(classificarCobertura("lixo", HOJE, 365, 120)).toBe<SubClasse>("previsao_nula");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`
Expected: FAIL — "classificarCobertura is not a function".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/reposicao/onorder-probe-analise.ts
// Análise PURA de cobertura do "a caminho" (on-order). Espelhado VERBATIM em
// supabase/functions/omie-onorder-probe/index.ts (Deno não importa de @/).
// READ-ONLY / diagnóstico: não decide compra, só mede cobertura.

export type SubClasse =
  | "dentro_janela"
  | "previsao_nula"
  | "futura_alem_janela"
  | "atrasada_alem_janela";

/** Dias entre duas datas ISO (b - a), por UTC (sem fuso/DST). NaN se inválida. */
function diffDiasISO(aISO: string, bISO: string): number {
  const a = Date.parse(`${aISO}T00:00:00Z`);
  const b = Date.parse(`${bISO}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Classifica uma PO aberta pela sua previsão de entrega, relativa à janela
 * [hoje-passadoDias, hoje+futuroDias]. Previsão nula OU malformada → previsao_nula
 * (fail-safe: tratamos como invisível ao filtro-por-previsão, que é o pior caso honesto).
 */
export function classificarCobertura(
  previsaoISO: string | null,
  hojeISO: string,
  passadoDias: number,
  futuroDias: number,
): SubClasse {
  if (!previsaoISO) return "previsao_nula";
  const d = diffDiasISO(hojeISO, previsaoISO); // >0 futuro, <0 passado
  if (!Number.isFinite(d)) return "previsao_nula";
  if (d > futuroDias) return "futura_alem_janela";
  if (d < -passadoDias) return "atrasada_alem_janela";
  return "dentro_janela";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/onorder-probe-analise.ts src/lib/reposicao/__tests__/onorder-probe-analise.test.ts
git commit -m "feat(reposição): helper puro classificarCobertura (probe on-order)"
```

---

## Task 2: Helper puro — diferença de cobertura (o que escapa)

**Files:**
- Modify: `src/lib/reposicao/onorder-probe-analise.ts`
- Test: `src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`

- [ ] **Step 1: Write the failing test** (adicionar ao arquivo de teste)

```ts
import { diferencaCobertura } from "../onorder-probe-analise";

describe("diferencaCobertura", () => {
  const HOJE = "2026-06-26";
  it("lista POs do conjunto independente AUSENTES da janela, com sub-classe e soma de unidades", () => {
    // janela vê só a PO 'A' (dentro). O canal independente conhece A, B (nula), C (futura+121d).
    const vistosJanela = new Set<string>(["A"]);
    const independente = new Map<string, { previsao: string | null; saldo: number }>([
      ["A", { previsao: "2026-07-01", saldo: 5 }],
      ["B", { previsao: null, saldo: 3 }],
      ["C", { previsao: "2026-10-25", saldo: 2 }],
    ]);
    const r = diferencaCobertura(vistosJanela, independente, HOJE, 365, 120);
    expect(r.escapam.map((e) => e.nCodPed).sort()).toEqual(["B", "C"]);
    expect(r.totalUnidadesEscapam).toBe(5); // 3 (B) + 2 (C)
    expect(r.porSubClasse.previsao_nula).toBe(1);
    expect(r.porSubClasse.futura_alem_janela).toBe(1);
  });
  it("conjunto independente ⊆ janela → nada escapa", () => {
    const r = diferencaCobertura(new Set(["A", "B"]),
      new Map([["A", { previsao: "2026-07-01", saldo: 1 }], ["B", { previsao: "2026-07-02", saldo: 1 }]]),
      HOJE, 365, 120);
    expect(r.escapam).toHaveLength(0);
    expect(r.totalUnidadesEscapam).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`
Expected: FAIL — "diferencaCobertura is not a function".

- [ ] **Step 3: Write minimal implementation** (append ao helper)

```ts
export interface POIndependente { previsao: string | null; saldo: number }
export interface DiferencaCobertura {
  escapam: Array<{ nCodPed: string; subClasse: SubClasse; saldo: number }>;
  totalUnidadesEscapam: number;
  porSubClasse: Record<SubClasse, number>;
}

/**
 * Dado o conjunto de POs vistas pela janela-por-previsão (por nCodPed) e um conjunto
 * INDEPENDENTE da janela (nCodPed → previsão/saldo), retorna as POs do independente
 * AUSENTES da janela (= escapam do "a caminho"), classificadas. Money-path: a direção
 * do erro dessas é SUBESTIMAR → compra dupla.
 */
export function diferencaCobertura(
  vistosJanela: ReadonlySet<string>,
  independente: ReadonlyMap<string, POIndependente>,
  hojeISO: string,
  passadoDias: number,
  futuroDias: number,
): DiferencaCobertura {
  const escapam: DiferencaCobertura["escapam"] = [];
  const porSubClasse: Record<SubClasse, number> = {
    dentro_janela: 0, previsao_nula: 0, futura_alem_janela: 0, atrasada_alem_janela: 0,
  };
  let totalUnidadesEscapam = 0;
  for (const [nCodPed, po] of independente) {
    if (vistosJanela.has(nCodPed)) continue;
    const subClasse = classificarCobertura(po.previsao, hojeISO, passadoDias, futuroDias);
    escapam.push({ nCodPed, subClasse, saldo: po.saldo });
    porSubClasse[subClasse] += 1;
    totalUnidadesEscapam += Number.isFinite(po.saldo) ? po.saldo : 0;
  }
  return { escapam, totalUnidadesEscapam, porSubClasse };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test src/lib/reposicao/__tests__/onorder-probe-analise.test.ts`
Expected: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/onorder-probe-analise.ts src/lib/reposicao/__tests__/onorder-probe-analise.test.ts
git commit -m "feat(reposição): helper puro diferencaCobertura (probe on-order)"
```

---

## Task 3: Edge `omie-onorder-probe` — scaffold (gate + credencial + helpers espelhados)

**Files:**
- Create: `supabase/functions/omie-onorder-probe/index.ts`
- Reference: `supabase/functions/omie-sync-estoque/index.ts:9-135` (imports, `callOmie`, `getOmieCredentials`), `supabase/functions/_shared/auth.ts`.

- [ ] **Step 1: Escrever o scaffold**

Copiar VERBATIM de `omie-sync-estoque/index.ts`: o bloco de imports (linhas 9-19), `callOmie` (72-122), `getOmieCredentials` (124-135), `ddmmyyyy` (66-70), `callOmiePedidos`+`ddmmyyyyPed`+`FIM_SEM_REGISTROS` (a partir de ~200). Depois colar o helper de análise (Task 1+2) VERBATIM (bloco comentado "espelho de onorder-probe-analise.ts"). Esqueleto do handler:

```ts
// Edge: omie-onorder-probe — DIAGNÓSTICO read-only do "a caminho" (on-order) OBEN.
// NÃO grava sku_estoque_atual, NÃO toca o cálculo do motor. Grava o relatório em
// sync_state('onorder_probe','oben'). Spec: 2026-06-26-reposicao-onorder-medir-confirmar-design.md
import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCronOrStaff, corsHeaders as sharedCors } from "../_shared/auth.ts";
// ... (callOmie, callOmiePedidos, getOmieCredentials, ddmmyyyy* copiados verbatim)
// ... (classificarCobertura, diferencaCobertura, SubClasse copiados verbatim de onorder-probe-analise.ts)

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { ...sharedCors } });
  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return new Response(JSON.stringify({ error: auth.error }), { status: auth.status, headers: { ...sharedCors, "Content-Type": "application/json" } });

  const { appKey, appSecret } = getOmieCredentials("OBEN");
  if (!appKey || !appSecret) return new Response(JSON.stringify({ error: "credencial OBEN ausente" }), { status: 500, headers: { ...sharedCors, "Content-Type": "application/json" } });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const relatorio: Record<string, unknown> = { gerado_em: new Date().toISOString() };
  try {
    // Tasks 4 e 5 preenchem `relatorio`.
  } catch (e) {
    relatorio.erro = e instanceof Error ? e.message : String(e);
  }
  // Task 5: grava em sync_state e responde.
  return new Response(JSON.stringify(relatorio, null, 2), { headers: { ...sharedCors, "Content-Type": "application/json" } });
});
```

- [ ] **Step 2: Verificar que compila**

Run: `deno check supabase/functions/omie-onorder-probe/index.ts`
Expected: OK (sem erros de tipo).

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/omie-onorder-probe/index.ts
git commit -m "feat(reposição): scaffold edge omie-onorder-probe (gate+credencial+helpers)"
```

---

## Task 4: Edge — os 5 probes de semântica (P1-P5)

**Files:**
- Modify: `supabase/functions/omie-onorder-probe/index.ts` (preencher o `try` do handler)

- [ ] **Step 1: Selecionar casos-teste de `purchase_orders_tracking` + rodar P1-P5**

Inserir no `try` do handler. Os params abertos do `PesquisarPedCompra` espelham os de `omie-sync-estoque` (`lExibirPedidosPendentes:'T'`, etc.). `aparece(resp, nCodPed)` = busca o nCodPed em `resp.pedidos_pesquisa[].cabecalho.nCodPed`.

```ts
// Caso A: PO com inclusão≠previsão (maior gap). Caso B: PO com previsão nula.
const { data: casoA } = await supabase.from("purchase_orders_tracking")
  .select("omie_codigo_pedido, t1_data_pedido, data_previsao_original")
  .eq("empresa", "OBEN").not("data_previsao_original", "is", null).not("t1_data_pedido", "is", null)
  .order("data_previsao_original", { ascending: false }).limit(1).maybeSingle();
const { data: casoB } = await supabase.from("purchase_orders_tracking")
  .select("omie_codigo_pedido, t1_data_pedido, data_previsao_original")
  .eq("empresa", "OBEN").is("data_previsao_original", null).in("status", ["CRIADO", "FATURADO"])
  .limit(1).maybeSingle();

const hoje = new Date();
const futuro120 = new Date(hoje); futuro120.setDate(hoje.getDate() + 120);

// P1 — semântica: janela=[inclusão] vs janela=[previsão] da MESMA PO.
const incA = ddmmyyyyPed(new Date(casoA!.t1_data_pedido));
const prevA = ddmmyyyyPed(new Date(casoA!.data_previsao_original + "T00:00:00"));
const p1_inc = await callOmiePedidos(appKey, appSecret, 1, incA, incA);
const p1_prev = await callOmiePedidos(appKey, appSecret, 1, prevA, prevA);
relatorio.P1_semantica = {
  caso: casoA!.omie_codigo_pedido, inclusao: incA, previsao: prevA,
  aparece_em_janela_inclusao: aparece(p1_inc, casoA!.omie_codigo_pedido),
  aparece_em_janela_previsao: aparece(p1_prev, casoA!.omie_codigo_pedido),
  // esperado se filtro=previsão: inclusao=false, previsao=true
};

// P2 — futuro: janela [hoje, hoje+120] retorna POs com previsão futura?
const p2 = await callOmiePedidos(appKey, appSecret, 1, ddmmyyyyPed(hoje), ddmmyyyyPed(futuro120));
relatorio.P2_futuro = { janela: [ddmmyyyyPed(hoje), ddmmyyyyPed(futuro120)], pedidos_retornados: (p2.pedidos_pesquisa ?? []).length };

// P3 — nulo: a PO de previsão nula aparece numa janela ENORME [2010, hoje+10y]?
if (casoB) {
  const enorme1 = "01/01/2010"; const enorme2 = ddmmyyyyPed(new Date(hoje.getFullYear() + 10, 0, 1));
  const p3 = await callOmiePedidos(appKey, appSecret, 1, enorme1, enorme2);
  relatorio.P3_nulo = { caso: casoB.omie_codigo_pedido, aparece_em_janela_enorme: aparece(p3, casoB.omie_codigo_pedido) };
} else relatorio.P3_nulo = { nota: "nenhuma PO aberta com previsão nula encontrada no espelho" };

// P4 — canal por inclusão: tentar variantes de param e registrar se mudam o conjunto.
//   (exploratório — o Omie de compras pode não suportar; registramos o que cada variante retorna)
relatorio.P4_canal_inclusao = { nota: "testar variantes manualmente na 1a rodada; registrar faultstring/contagem por variante" };

// P5 — ListarSaldoPendente (sem janela de data) vs PesquisarPedCompra.
//   Reusar o mesmo padrão de chamada de omie-sync-estoque (call='ListarSaldoPendente').
relatorio.P5_saldo_pendente = await coletarSaldoPendente(appKey, appSecret); // {porProduto: {...}, total}
```

`aparece()` e `coletarSaldoPendente()` são helpers locais da edge (defini-los acima do handler; `coletarSaldoPendente` espelha o uso de `ListarSaldoPendente` em `omie-sync-estoque`).

- [ ] **Step 2: Verificar compila**

Run: `deno check supabase/functions/omie-onorder-probe/index.ts`
Expected: OK.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/omie-onorder-probe/index.ts
git commit -m "feat(reposição): probes P1-P5 de semântica da janela on-order"
```

---

## Task 5: Edge — auditoria de cobertura + gravação em `sync_state`

**Files:**
- Modify: `supabase/functions/omie-onorder-probe/index.ts`

- [ ] **Step 1: Auditoria (condicional ao canal independente) + grava relatório**

```ts
// Auditoria SÓ se P5/P4 revelarem um canal independente que cobre futuros.
// Conjunto da janela atual (o que o motor vê hoje): varre PesquisarPedCompra [hoje-365, hoje+120].
const passado365 = new Date(hoje); passado365.setDate(hoje.getDate() - 365);
const vistosJanela = await coletarNCodPedsAbertos(appKey, appSecret, ddmmyyyyPed(passado365), ddmmyyyyPed(futuro120)); // Set<string>
relatorio.cobertura_janela = { total_pos_abertas_vistas: vistosJanela.size };

// Se houver canal independente (decidir na 1a leitura a partir de P5), montar `independente`
// (Map<nCodPed,{previsao,saldo}>) e classificar. Sem canal → marcar auditoria como manual.
relatorio.auditoria = {
  nota: "preencher quando P5/P4 confirmarem canal independente; senão auditoria via export manual do Omie",
};

// GRAVA o relatório em sync_state (NÃO money-path) — leitura via psql-ro.
await supabase.from("sync_state").upsert({
  entity_type: "onorder_probe", account: "oben", status: "complete",
  last_sync_at: new Date().toISOString(), metadata: relatorio, updated_at: new Date().toISOString(),
}, { onConflict: "entity_type,account" });
```

- [ ] **Step 2: Verificar compila**

Run: `deno check supabase/functions/omie-onorder-probe/index.ts`
Expected: OK.

- [ ] **Step 3: `deno check` + lint final + commit**

Run: `deno check supabase/functions/omie-onorder-probe/index.ts`
```bash
git add supabase/functions/omie-onorder-probe/index.ts
git commit -m "feat(reposição): auditoria de cobertura + grava relatório em sync_state(onorder_probe)"
```

---

## Task 6: Handoff de deploy + leitura do resultado (NÃO há teste local — precisa do Omie)

**Files:** nenhum (operacional).

- [ ] **Step 1: Verificação local possível**

Run: `heavy bun run test src/lib/reposicao/__tests__/onorder-probe-analise.test.ts && deno check supabase/functions/omie-onorder-probe/index.ts && heavy bun run typecheck`
Expected: tudo PASS/OK. (Os probes em si NÃO rodam local — dependem da credencial Omie no ambiente deployado.)

- [ ] **Step 2: Handoff de deploy (founder, manual no Lovable)**

Deploy da edge `omie-onorder-probe` pelo chat do Lovable (ler do repo, verbatim). É edge NOVA (não há migration; `sync_state` já existe).

- [ ] **Step 3: Invocação (founder cola no SQL Editor; usa o CRON_SECRET do Vault)**

```sql
select net.http_post(
  url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-onorder-probe',
  headers := jsonb_build_object('Content-Type','application/json','x-cron-secret',(select decrypted_secret from vault.decrypted_secrets where name='CRON_SECRET' limit 1)),
  body := '{"empresa":"OBEN"}'::jsonb, timeout_milliseconds := 150000);
```

- [ ] **Step 4: Eu leio o relatório via `psql-ro` (sem o founder colar)**

```bash
~/.config/afiacao/psql-ro -c "select jsonb_pretty(metadata) from public.sync_state where entity_type='onorder_probe' and account='oben';"
```

- [ ] **Step 5: Interpretar e decidir**

Confirmar P1 (`aparece_em_janela_previsao=true`, `_inclusao=false`) → semântica = previsão (fecha o contrato). Ler P3 (regra do nulo), P5 (ListarSaldoPendente cobre futuros?), `auditoria.totalUnidadesEscapam` por sub-classe → dimensiona a urgência do MVP réplica-por-PO. Registrar a conclusão no spec e decidir a próxima fatia com o founder.

---

## Self-Review

- **Spec coverage:** Componente 1 (probe semântica) → Tasks 4 (P1-P5). Componente 2 (auditoria cobertura) → Tasks 1,2,5. Gravação p/ leitura via psql-ro → Task 5. Handoff de deploy → Task 6. Componente 3 (observabilidade no fluxo) e MVP réplica = fora de escopo (fatias seguintes, conforme spec §6/§10). ✅
- **Placeholder scan:** P4 e `auditoria` têm "nota: preencher na 1a rodada" — isto é INTENCIONAL e correto: ambos são condicionais ao que P1-P3/P5 revelarem sobre a API (não dá pra fixar o canal antes de saber se existe). Não é placeholder de código faltando; é o desenho fail-closed (sem canal → auditoria manual). Demais steps têm código completo. ✅
- **Type consistency:** `SubClasse`, `classificarCobertura(previsao,hoje,passado,futuro)`, `diferencaCobertura(set,map,hoje,passado,futuro)` usados consistentemente entre Tasks 1-2 e a edge. ✅

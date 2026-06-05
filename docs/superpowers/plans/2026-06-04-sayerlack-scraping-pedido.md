# Scraping do pedido Sayerlack (valida grupo + captura custo) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Num único scraping do `#datatable_itens` antes do Efetivar, validar o grupo (Prz Ent do portal `==` `lt_producao_dias`, bloqueia o pedido em mismatch confirmado) e capturar o custo real (`total_linha/qtde_final → preco_unitario`, pro Omie bater com a NF-e).

**Architecture:** O fluxo do browser (`BROWSERLESS_FUNCTION`, string template em `index.ts:32`) roda **dentro do Browserless** — sem DB/imports. Logo: (1) o **gate B** roda **inline na string**, com `ltEsperado` passado via `context`, e bloqueia ANTES do Efetivar; (2) a **captura de custo** roda no **Deno**, depois do retorno, no `sucesso_portal`, com um helper puro espelhado. A lógica testável (parse/match/validação/derivação) vive num helper puro vitest (`src/lib/reposicao/`) que é o oráculo das duas pontas.

**Tech Stack:** Deno (edge function), Browserless `/function` (Puppeteer), Supabase (PostgREST), vitest (helper puro). Tabelas: `fornecedor_grupo_producao.lt_producao_dias`, `pedido_compra_item`, `pedido_compra_sugerido`.

**Pré-requisito (fora deste plano):** o claim do portal foi consertado no PR #592 (RPC `envio_portal_claim_ids`, migration `20260604150000`). A edge `enviar-pedido-portal-sayerlack` **precisa estar redeployada** com essa main, senão nada vai ao portal.

**⚠️ Limites de teste:** o helper puro (Fase 1) é 100% TDD. As Fases 2-4 (string do Browserless + wiring Deno + seletores DOM) **não têm teste unitário local** — o `/browse` headless não renderiza, e o fluxo só roda contra o portal real. Verificação dessas fases = `deno check` + lint + um **run real** disparado pelo founder (logs da edge no Lovable). Isso é honesto, não preguiça.

---

## File Structure

- **Create:** `src/lib/reposicao/sayerlack-scraping-pedido.ts` — helper puro (parse, match, validação, derivação de custo). Oráculo testável.
- **Create:** `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts` — vitest.
- **Modify:** `supabase/functions/enviar-pedido-portal-sayerlack/index.ts`:
  - `BROWSERLESS_FUNCTION` string (`:32`): destructure `ltEsperado`; scrape + gate B + block antes do Efetivar (~`:942`); retornar `itens_capturados`.
  - `buildEnvelope` (`:335`): `GRUPO_LEADTIME_MISMATCH` vira `erro_nao_retentavel`.
  - itensList fetch (`:1450-1535`): incluir `preco_unitario`.
  - context (`:1640`): passar `ltEsperado`.
  - `sucesso_portal` (`:1814-1818`): captura de custo (helper espelhado inline Deno) antes do `registrarPedidoOmieAposPortal`.

---

## Fase 1 — Helper puro (TDD)

### Task 1: Parsers `parseBRL` + `parseDiasPrzEnt`

**Files:**
- Create: `src/lib/reposicao/sayerlack-scraping-pedido.ts`
- Test: `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseBRL, parseDiasPrzEnt } from '../sayerlack-scraping-pedido';

describe('parseBRL', () => {
  it('parseia formato pt-BR (ponto=milhar, vírgula=decimal)', () => {
    expect(parseBRL('1.234,56')).toBe(1234.56);
    expect(parseBRL('R$ 90,21')).toBe(90.21);
    expect(parseBRL('408,36')).toBe(408.36);
    expect(parseBRL('0,00')).toBe(0);
  });
  it('retorna null pra lixo', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL(null as unknown as string)).toBeNull();
  });
});

describe('parseDiasPrzEnt', () => {
  it('extrai o inteiro de dias', () => {
    expect(parseDiasPrzEnt('8')).toBe(8);
    expect(parseDiasPrzEnt('8 dias')).toBe(8);
    expect(parseDiasPrzEnt('12')).toBe(12);
  });
  it('retorna null pra vazio/sem número', () => {
    expect(parseDiasPrzEnt('')).toBeNull();
    expect(parseDiasPrzEnt('—')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `bun run test -- sayerlack-scraping-pedido`
Expected: FAIL ("parseBRL is not a function" / module not found).

- [ ] **Step 3: Implement the parsers**

```ts
// src/lib/reposicao/sayerlack-scraping-pedido.ts
// Helpers puros do scraping do pedido Sayerlack (valida grupo via Prz Ent + captura custo).
// ⚠️ A captura de custo (derivarCustos/casar) é espelhada VERBATIM no Deno da edge
// enviar-pedido-portal-sayerlack (Deno não importa de src/). Mantenha as duas em sincronia.

export function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

export function parseDiasPrzEnt(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) ? n : null;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `bun run test -- sayerlack-scraping-pedido`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/sayerlack-scraping-pedido.ts src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts
git commit -m "feat(sayerlack-scraping): parsers BRL + Prz Ent (TDD)"
```

### Task 2: `casarLinhasComItens` (match + guarda de ambiguidade)

**Files:**
- Modify: `src/lib/reposicao/sayerlack-scraping-pedido.ts`
- Test: `src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { casarLinhasComItens, type ItemPedido, type LinhaPortal } from '../sayerlack-scraping-pedido';

const item = (o: Partial<ItemPedido>): ItemPedido => ({
  item_id: 1, sku_codigo_omie: 'OMIE1', sku_descricao: 'd', sku_portal: 'P1', qtde_final: 2, preco_atual: 10, ...o,
});
const linha = (o: Partial<LinhaPortal>): LinhaPortal => ({ sku_portal: 'P1', prz_ent_raw: '8', total_raw: '20,00', ...o });

describe('casarLinhasComItens', () => {
  it('casa por sku_portal e parseia prz/total', () => {
    const r = casarLinhasComItens([linha({})], [item({})]);
    expect(r.casados).toHaveLength(1);
    expect(r.casados[0].prz_ent).toBe(8);
    expect(r.casados[0].total_linha).toBe(20);
    expect(r.naoCasados).toHaveLength(0);
    expect(r.ambiguos).toHaveLength(0);
  });
  it('item sem linha no portal vira naoCasado', () => {
    const r = casarLinhasComItens([], [item({})]);
    expect(r.naoCasados).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 itens vira ambíguo (de-para não é único por sku_portal)', () => {
    const r = casarLinhasComItens([linha({})], [item({ item_id: 1 }), item({ item_id: 2, sku_codigo_omie: 'OMIE2' })]);
    expect(r.ambiguos).toHaveLength(2);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 linhas vira ambíguo', () => {
    const r = casarLinhasComItens([linha({}), linha({ total_raw: '99,00' })], [item({})]);
    expect(r.ambiguos).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('item com sku_portal nulo vira naoCasado', () => {
    const r = casarLinhasComItens([linha({})], [item({ sku_portal: null })]);
    expect(r.naoCasados).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `bun run test -- sayerlack-scraping-pedido`
Expected: FAIL ("casarLinhasComItens is not a function").

- [ ] **Step 3: Implement**

```ts
export interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_raw: string; }
export interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number; preco_atual: number;
}
export interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; }
export interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }

export function casarLinhasComItens(linhas: LinhaPortal[], itens: ItemPedido[]): ResultadoMatch {
  const casados: Casado[] = [];
  const naoCasados: ItemPedido[] = [];
  const ambiguos: ItemPedido[] = [];

  const itensPorSku = new Map<string, ItemPedido[]>();
  for (const it of itens) {
    const k = normPortal(it.sku_portal);
    if (!k) { naoCasados.push(it); continue; }
    const arr = itensPorSku.get(k) ?? [];
    arr.push(it); itensPorSku.set(k, arr);
  }
  const linhasPorSku = new Map<string, LinhaPortal[]>();
  for (const ln of linhas) {
    const k = normPortal(ln.sku_portal);
    if (!k) continue;
    const arr = linhasPorSku.get(k) ?? [];
    arr.push(ln); linhasPorSku.set(k, arr);
  }
  for (const [k, its] of itensPorSku) {
    const lns = linhasPorSku.get(k) ?? [];
    if (its.length > 1 || lns.length > 1) { ambiguos.push(...its); continue; }
    if (lns.length === 0) { naoCasados.push(its[0]); continue; }
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: parseBRL(lns[0].total_raw) });
  }
  return { casados, naoCasados, ambiguos };
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `bun run test -- sayerlack-scraping-pedido`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u && git commit -m "feat(sayerlack-scraping): casar linhas do portal com itens + guarda de ambiguidade (TDD)"
```

### Task 3: `validarGrupoLeadtime` (compara exato; só mismatch confirmado bloqueia)

**Files:**
- Modify: `src/lib/reposicao/sayerlack-scraping-pedido.ts`
- Test: idem

- [ ] **Step 1: Write the failing test**

```ts
import { validarGrupoLeadtime } from '../sayerlack-scraping-pedido';

describe('validarGrupoLeadtime', () => {
  const casados = (arr: Array<{ sku?: string; prz: number | null }>) =>
    ({ casados: arr.map((a, i) => ({ item: item({ item_id: i, sku_codigo_omie: a.sku ?? 'O' + i }), prz_ent: a.prz, total_linha: 1 })), naoCasados: [], ambiguos: [] });

  it('ok quando todos os prz batem o esperado', () => {
    const r = validarGrupoLeadtime(casados([{ prz: 8 }, { prz: 8 }]), 8);
    expect(r.status).toBe('ok');
    expect(r.mismatches).toHaveLength(0);
  });
  it('mismatch quando ≥1 prz difere', () => {
    const r = validarGrupoLeadtime(casados([{ prz: 8 }, { sku: 'X', prz: 12 }]), 8);
    expect(r.status).toBe('mismatch');
    expect(r.mismatches).toEqual([{ sku_codigo_omie: 'X', prz_ent: 12, lt_esperado: 8 }]);
  });
  it('indisponivel quando ltEsperado é null (sem config de grupo)', () => {
    expect(validarGrupoLeadtime(casados([{ prz: 8 }]), null).status).toBe('indisponivel');
  });
  it('indisponivel quando nada parseável (prz null)', () => {
    expect(validarGrupoLeadtime(casados([{ prz: null }]), 8).status).toBe('indisponivel');
  });
  it('prz null não conta como mismatch — só pulado', () => {
    const r = validarGrupoLeadtime(casados([{ prz: 8 }, { sku: 'N', prz: null }]), 8);
    expect(r.status).toBe('ok');
    expect(r.pulados).toContain('N');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `bun run test -- sayerlack-scraping-pedido` → FAIL.

- [ ] **Step 3: Implement**

```ts
export interface ResultadoValidacao {
  status: 'ok' | 'mismatch' | 'indisponivel';
  mismatches: { sku_codigo_omie: string; prz_ent: number; lt_esperado: number }[];
  pulados: string[];
}

export function validarGrupoLeadtime(res: ResultadoMatch, ltEsperado: number | null): ResultadoValidacao {
  const mismatches: ResultadoValidacao['mismatches'] = [];
  const pulados: string[] = [];
  const pularTudo = () => {
    for (const c of res.casados) pulados.push(c.item.sku_codigo_omie);
    for (const i of res.naoCasados) pulados.push(i.sku_codigo_omie);
    for (const i of res.ambiguos) pulados.push(i.sku_codigo_omie);
  };
  if (ltEsperado == null || !Number.isInteger(ltEsperado)) {
    pularTudo();
    return { status: 'indisponivel', mismatches, pulados };
  }
  let validados = 0;
  for (const c of res.casados) {
    if (c.prz_ent == null) { pulados.push(c.item.sku_codigo_omie); continue; }
    validados++;
    if (c.prz_ent !== ltEsperado) {
      mismatches.push({ sku_codigo_omie: c.item.sku_codigo_omie, prz_ent: c.prz_ent, lt_esperado: ltEsperado });
    }
  }
  for (const i of res.naoCasados) pulados.push(i.sku_codigo_omie);
  for (const i of res.ambiguos) pulados.push(i.sku_codigo_omie);
  if (mismatches.length > 0) return { status: 'mismatch', mismatches, pulados };
  if (validados > 0) return { status: 'ok', mismatches, pulados };
  return { status: 'indisponivel', mismatches, pulados };
}
```

- [ ] **Step 4: Run test, verify PASS** → `bun run test -- sayerlack-scraping-pedido`.

- [ ] **Step 5: Commit**

```bash
git add -u && git commit -m "feat(sayerlack-scraping): validação exata de grupo via Prz Ent (mismatch bloqueia, incerteza=indisponivel) (TDD)"
```

### Task 4: `derivarCustos` + `round2` (tolerância no total da linha)

**Files:**
- Modify: `src/lib/reposicao/sayerlack-scraping-pedido.ts`
- Test: idem

- [ ] **Step 1: Write the failing test**

```ts
import { derivarCustos } from '../sayerlack-scraping-pedido';

describe('derivarCustos', () => {
  const casadoCom = (o: { qtde: number; preco_atual: number; total: number | null }) =>
    ({ casados: [{ item: item({ item_id: 7, qtde_final: o.qtde, preco_atual: o.preco_atual }), prz_ent: 8, total_linha: o.total }], naoCasados: [], ambiguos: [] });

  it('deriva unitário = total/qtde e sobrescreve quando difere', () => {
    const r = derivarCustos(casadoCom({ qtde: 4, preco_atual: 100, total: 1633.45 }));
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].item_id).toBe(7);
    expect(r.updates[0].valor_linha).toBe(1633.45);
    expect(r.updates[0].preco_unitario).toBeCloseTo(408.3625, 4);
  });
  it('mantém (não sobrescreve) quando o total da linha bate ao centavo', () => {
    const r = derivarCustos(casadoCom({ qtde: 4, preco_atual: 408.36, total: 1633.44 })); // 4*408.36=1633.44
    expect(r.updates).toHaveLength(0);
    expect(r.pulados[0]).toMatchObject({ motivo: 'sem_mudanca' });
  });
  it('pula total inválido (<=0 ou null) sem fabricar custo', () => {
    expect(derivarCustos(casadoCom({ qtde: 4, preco_atual: 1, total: 0 })).updates).toHaveLength(0);
    expect(derivarCustos(casadoCom({ qtde: 4, preco_atual: 1, total: null })).updates).toHaveLength(0);
  });
  it('pula qtde inválida', () => {
    expect(derivarCustos(casadoCom({ qtde: 0, preco_atual: 1, total: 10 })).updates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL** → FAIL.

- [ ] **Step 3: Implement**

```ts
export interface CustoUpdate { item_id: number; preco_unitario: number; valor_linha: number; }
export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const total = c.total_linha; const qtde = c.item.qtde_final;
    if (total == null || !(total > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (!(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    if (round2(total) === round2(qtde * c.item.preco_atual)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'sem_mudanca' }); continue; }
    updates.push({ item_id: c.item.item_id, preco_unitario: total / qtde, valor_linha: total }); // precisão cheia, sem round
  }
  return { updates, pulados };
}
```

- [ ] **Step 4: Run test, verify PASS** → `bun run test -- sayerlack-scraping-pedido`.

- [ ] **Step 5: typecheck + lint + commit**

```bash
bun run typecheck && bun lint
git add -u && git commit -m "feat(sayerlack-scraping): derivar custo (total/qtde) com tolerância no total da linha (TDD)"
```

---

## Fase 2 — Wiring Deno (edge)

### Task 5: incluir `preco_unitario` no fetch de itensList

**Files:** Modify `supabase/functions/enviar-pedido-portal-sayerlack/index.ts` (`:1450-1535`).

- [ ] **Step 1:** No fallback direto (`:1464-1473`), adicionar `preco_unitario` ao `.select(...)`. No tipo `ItemMapeado`/`PedidoItemDireto` e no map de `itensList` (`:1523-1535`), incluir `preco_unitario: Number(i.preco_unitario ?? 0)`. Na RPC `envio_portal_itens_mapeados` (Step 2 abaixo), garantir que ela também retorne `preco_unitario` (se não retornar, o fallback cobre).
- [ ] **Step 2:** `deno check supabase/functions/enviar-pedido-portal-sayerlack/index.ts` — sem novos erros (set inalterado).
- [ ] **Step 3:** Commit: `git commit -am "feat(sayerlack-scraping): itensList carrega preco_unitario (base da tolerância de custo)"`

> ⚠️ Se a RPC `envio_portal_itens_mapeados` não trouxer `preco_unitario`, o caminho RPC perde a tolerância. Decisão: ou estender a RPC (migration), ou **forçar o fallback** lendo `preco_unitario` numa query extra leve. Para o v1, ler `preco_unitario` numa query dedicada `pedido_compra_item(id, preco_unitario)` por `pedido_id` e mesclar por `item_id` — independe da RPC. Implementar essa query no Step 1.

### Task 6: buscar `ltEsperado` + passar via `context`

**Files:** Modify `index.ts` (antes do fetch ao Browserless, perto de `:1603`; e o `context` em `:1635-1641`).

- [ ] **Step 1:** Antes de montar `itemsPortal`, buscar o lead time do grupo:

```ts
// lead time esperado do grupo (validação de Prz Ent). Null = sem config → gate fica indisponível (fail-open).
let ltEsperado: number | null = null;
if (pedido.grupo_codigo) {
  const { data: grp } = await supabase
    .from("fornecedor_grupo_producao")
    .select("lt_producao_dias, lt_producao_unidade")
    .eq("empresa", pedido.empresa)
    .eq("fornecedor_nome", pedido.fornecedor_nome)
    .eq("grupo_codigo", pedido.grupo_codigo)
    .maybeSingle();
  // só compara em dias úteis (o founder confirmou "exatamente igual" na mesma unidade)
  if (grp && (grp.lt_producao_unidade ?? 'uteis') === 'uteis' && Number.isInteger(grp.lt_producao_dias)) {
    ltEsperado = grp.lt_producao_dias as number;
  }
}
```

- [ ] **Step 2:** No `context` (`:1640`), adicionar `ltEsperado,` ao objeto.
- [ ] **Step 3:** `deno check` (set inalterado). Commit: `git commit -am "feat(sayerlack-scraping): busca lt do grupo e passa ltEsperado pro Browserless"`

### Task 7: espelhar o helper de custo inline no Deno

**Files:** Modify `index.ts` (perto do topo das funções utilitárias Deno, fora do `BROWSERLESS_FUNCTION`).

- [ ] **Step 1:** Copiar **verbatim** `parseBRL`, `normPortal`, `casarLinhasComItens`, `round2`, `derivarCustos` + os tipos `LinhaPortal/ItemPedido/Casado/ResultadoMatch/CustoUpdate` do helper pra dentro do `index.ts` (escopo Deno, não na string). Comentar `// ESPELHO VERBATIM de src/lib/reposicao/sayerlack-scraping-pedido.ts — manter em sincronia`. (Não precisa de `validarGrupoLeadtime`/`parseDiasPrzEnt` no Deno: o gate roda no browser; mas copiar tudo é mais simples e barato.)
- [ ] **Step 2:** `deno check` — sem novos erros.
- [ ] **Step 3:** Commit: `git commit -am "feat(sayerlack-scraping): espelha helper de custo no Deno da edge"`

### Task 8: `GRUPO_LEADTIME_MISMATCH` → `erro_nao_retentavel`

**Files:** Modify `index.ts` `buildEnvelope` (`:335`).

- [ ] **Step 1:** Na linha do `erroLogicoPreSubmit` (`:335-336`), adicionar `|| tipo === 'GRUPO_LEADTIME_MISMATCH'`. Assim o bloqueio do gate vira `erro_nao_retentavel` (sem POST, `requestSent=false`), que o motor de retry exclui e o Sentinela `reposicao_portal_humano` mostra. O `data.erro` (montado no browser com a lista de suspeitos) já vai pro `portal_erro` pela maquinaria existente.
- [ ] **Step 2:** `deno check`. Commit: `git commit -am "feat(sayerlack-scraping): bloqueio de grupo vira erro_nao_retentavel (triagem humana)"`

### Task 9: captura de custo no `sucesso_portal`

**Files:** Modify `index.ts` (`:1814-1818`, dentro do `if (envStatus === "sucesso_portal")`, ANTES de `registrarPedidoOmieAposPortal`).

- [ ] **Step 1:** Após `aplicarTransicao("sucesso_portal", ...)` e ANTES de `await registrarPedidoOmieAposPortal(pedido)`, inserir:

```ts
// Captura de custo: portal devolveu itens_capturados [{sku_portal, total_raw}]. Idempotente:
// só grava se o Omie ainda não foi criado (evita retry/watchdog reaplicarem).
try {
  const capturados = (envelope?.data?.itens_capturados ?? []) as Array<{ sku_portal: string; total_raw: string; prz_ent_raw?: string }>;
  const jaTemOmie = !!(pedido as { omie_pedido_compra_numero?: string }).omie_pedido_compra_numero;
  if (capturados.length > 0 && !jaTemOmie) {
    const itensParaCusto: ItemPedido[] = itensList.map((i) => ({
      item_id: i.item_id, sku_codigo_omie: i.sku_codigo_omie, sku_descricao: i.sku_descricao,
      sku_portal: i.sku_portal, qtde_final: Number(i.qtde_final), preco_atual: Number(i.preco_unitario ?? 0),
    }));
    const linhas: LinhaPortal[] = capturados.map((c) => ({ sku_portal: c.sku_portal, prz_ent_raw: c.prz_ent_raw ?? '', total_raw: c.total_raw }));
    const match = casarLinhasComItens(linhas, itensParaCusto);
    const { updates, pulados } = derivarCustos(match);
    for (const u of updates) {
      await supabase.from("pedido_compra_item").update({ preco_unitario: u.preco_unitario, valor_linha: u.valor_linha }).eq("id", u.item_id);
    }
    const novoTotal = match.casados.reduce((s, c) => s + (c.total_linha ?? (c.item.qtde_final * c.item.preco_atual)), 0);
    await supabase.from("pedido_compra_sugerido").update({
      valor_total: novoTotal,
      portal_resposta: { ...(pedido.portal_resposta ?? {}), custos_capturados: { aplicados: updates.length, pulados, capturados } },
    }).eq("id", pedido.id);
    console.log(`[envio-portal] Pedido #${pedido.id}: custo capturado — ${updates.length} atualizados, ${pulados.length} pulados`);
  }
} catch (e) {
  console.error(`[envio-portal] Pedido #${pedido.id}: falha best-effort na captura de custo:`, e instanceof Error ? e.message : String(e));
}
```

> Ajustar o acesso a `pedido.portal_resposta`/`omie_pedido_compra_numero` ao shape real do tipo `pedido` no escopo (ler o tipo no `index.ts`). Best-effort: a falha aqui **nunca** derruba o `sucesso_portal` nem o Omie.

- [ ] **Step 2:** `deno check` — sem novos erros.
- [ ] **Step 3:** Commit: `git commit -am "feat(sayerlack-scraping): grava custo do portal no pedido antes do Omie (idempotente, best-effort)"`

---

## Fase 3 — Browser-side (BROWSERLESS_FUNCTION) — scrape + gate

### Task 10: scrape `#datatable_itens` + gate B + retornar totais (na string `:32`)

**Files:** Modify `index.ts` `BROWSERLESS_FUNCTION` (`:32` em diante; destructure em `:33`; inserir após o settle de validação `~:942`, antes do scroll/efetivar `~:944`).

- [ ] **Step 1 (descobrir seletores — run de debug):** Adicionar, logo após `trace.push({ step: 'validacao_data_entrega_ok_pre_efetivar' ...})`, um dump do layout da tabela:

```js
const debugTabela = await page.evaluate(function() {
  const rows = Array.from(document.querySelectorAll('#datatable_itens tbody tr'));
  return rows.slice(0, 2).map(function(tr) {
    return Array.from(tr.querySelectorAll('td')).map(function(td, i) {
      return { i: i + 1, text: (td.innerText || '').trim().substring(0, 30) };
    });
  });
});
console.log('[DEBUG_TABELA_ITENS]', JSON.stringify(debugTabela));
```

Disparar um pedido real (founder) e ler `[DEBUG_TABELA_ITENS]` nos logs da edge no Lovable. **Anotar o índice da coluna do código (sku_portal), do `Prz Ent` e do total (última).** Sabe-se já: a qtde é input em `td:nth-of-type(7)` (`:832`), e o total é a **última** coluna (founder).

- [ ] **Step 2 (scrape real):** Trocar o debug pelo scrape (substituir `<COL_CODIGO>`/`<COL_PRZ>` pelos índices confirmados no Step 1; o total é `td:last-child`):

```js
const linhasPortal = await page.evaluate(function() {
  const rows = Array.from(document.querySelectorAll('#datatable_itens tbody tr'));
  return rows.map(function(tr) {
    const tds = tr.querySelectorAll('td');
    const cell = function(n) { const el = tds[n - 1]; return el ? (el.innerText || '').trim() : ''; };
    return {
      sku_portal: cell(<COL_CODIGO>),
      prz_ent_raw: cell(<COL_PRZ>),
      total_raw: tds.length ? (tds[tds.length - 1].innerText || '').trim() : '',
    };
  });
}).catch(function() { return []; });
trace.push({ step: 'scrape_datatable', n: linhasPortal.length, t: Date.now() - t0 });
```

- [ ] **Step 3 (gate B inline — bloqueia antes do Efetivar):** Logo após o scrape:

```js
// Gate de grupo: Prz Ent (inteiro) == ltEsperado, exato. Fail-OPEN na incerteza (não trava por bug de seletor).
if (typeof ltEsperado === 'number' && Number.isInteger(ltEsperado) && linhasPortal.length > 0) {
  const mismatches = [];
  let validados = 0;
  for (const ln of linhasPortal) {
    const m = (ln.prz_ent_raw || '').match(/-?\\d+/);
    if (!m) continue; // não parseou → pulado (fail-open)
    validados++;
    const prz = Number(m[0]);
    if (prz !== ltEsperado) mismatches.push({ sku_portal: ln.sku_portal, prz_ent: prz, lt_esperado: ltEsperado });
  }
  if (mismatches.length > 0) {
    const lista = mismatches.map(function(x) { return x.sku_portal + ' (Prz ' + x.prz_ent + ' ≠ ' + x.lt_esperado + ')'; }).join('; ');
    return {
      data: {
        success: false,
        erro: 'Grupo errado (Prz Ent ≠ lead time do grupo): ' + lista + '. Confira o de-para/grupo.',
        erroTipo: 'GRUPO_LEADTIME_MISMATCH',
        mismatches: mismatches,
        trace,
      },
      type: 'application/json',
    };
  }
  trace.push({ step: 'gate_grupo_ok', validados: validados, t: Date.now() - t0 });
}
```

> ⚠️ A string é template literal — escapar `\\d` (vira `\d` no código gerado). Conferir no `index.ts` gerado que o regex saiu certo.

- [ ] **Step 4 (destructure + retornar totais):** No destructuring (`:33`): `const { user, pass, portalUrl, clienteCodigo, items, ltEsperado } = context;`. No **retorno de sucesso** (onde monta `data: { success: true, protocolo, portal_data_entrega, ... }`), **incluir** `itens_capturados: linhasPortal.map(function(l){ return { sku_portal: l.sku_portal, total_raw: l.total_raw, prz_ent_raw: l.prz_ent_raw }; })`.

- [ ] **Step 5:** `deno check` + lint do arquivo (`bunx eslint supabase/functions/enviar-pedido-portal-sayerlack/index.ts`).
- [ ] **Step 6:** Commit: `git commit -am "feat(sayerlack-scraping): scrape #datatable_itens + gate de grupo (bloqueia antes do Efetivar) + retorna totais"`

---

## Fase 4 — Revisão + deploy + verificação real

### Task 11: revisão adversária do Codex (money-path)

- [ ] **Step 1:** `git diff origin/main...HEAD` e rodar `/codex challenge` (ou `codex exec` adversarial) focado em: double-count de custo, idempotência do write, escape do regex na string, fail-open vs fail-closed, e o gate não bloquear pedido correto. Corrigir P1.
- [ ] **Step 2:** Rodar `bun run test`, `bun run typecheck`, `bun lint`, `deno check` no arquivo — tudo verde.

### Task 12: deploy + verificação no portal real

- [ ] **Step 1:** Abrir PR, mergear na main (CI verde; `--squash`, não `--admin`).
- [ ] **Step 2:** Redeploy da edge `enviar-pedido-portal-sayerlack` via chat do Lovable (ler da main, verbatim).
- [ ] **Step 3 (verificação por comportamento):** Founder dispara:
  - um pedido **com 1 item de grupo errado** (Prz Ent ≠ lt) → deve **não efetivar**, virar `erro_nao_retentavel` com a lista no `portal_erro`. Nada no fornecedor.
  - um pedido **100% correto** → efetiva, e `pedido_compra_item.preco_unitario` reflete `total_linha/qtde_final` (conferir no SQL Editor: `SELECT sku_codigo_omie, qtde_final, preco_unitario, qtde_final*preco_unitario AS linha FROM pedido_compra_item WHERE pedido_id = <id>` → soma das linhas == total do portal). O Omie sai com esses custos.

---

## Self-Review (preenchido)

- **Cobertura do spec:** B (gate Prz Ent, bloqueia mismatch, fail-open na incerteza) = Tasks 6,8,10. A (custo total/qtde, tolerância no total, idempotência, mapeamento seguro) = Tasks 1-4,5,7,9. Pré-req (claim #592) = nota no header. Não-objetivos respeitados (sem auditoria global, sem UI, sem status dedicado).
- **Placeholders:** os `<COL_CODIGO>`/`<COL_PRZ>` na Task 10 são **deliberados** (índice empírico, descoberto no Step 1 do mesmo task via run de debug) — não é "TODO", é uma etapa de descoberta com método. Resto sem placeholder.
- **Consistência de tipos:** `ItemPedido`/`LinhaPortal`/`Casado`/`ResultadoMatch`/`CustoUpdate` definidos na Task 2/4 e reusados nas Tasks 7,9. `itens_capturados` (browser, Task 10) ↔ `LinhaPortal` (Deno, Task 9) batem (`sku_portal`/`total_raw`/`prz_ent_raw`).
- **Risco residual:** a sincronia "helper src/ ↔ espelho Deno" é manual (sem guard automático). Mitigar com o comentário de sincronia + a revisão do Codex. O gate inline no browser duplica a lógica de comparação (simples: parse int + `!==`), tendo `validarGrupoLeadtime` como oráculo testado.

# Orçamento de compra (v1 — simulação/backtest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simular, sobre os últimos 90 dias de ciclos do motor de reposição (Sayerlack/Oben), quanto do que o motor pediu um orçamento com **gate econômico ΔV>0 por embalagem** + **guarda de caixa diária (reserva mínima)** teria aceitado — e medir por replay contrafactual se os cortes teriam sido seguros.

**Architecture:** Lógica pura em TypeScript em `src/lib/reposicao/orcamento-compra/` (sem I/O, testada com vitest). Um script `scripts/orcamento-compra/simular.ts` lê fatos de produção via `~/.config/afiacao/psql-ro` (read-only) com `docs/superpowers/orcamento-compra/fatos.sql`, monta cada ciclo *as-of* a data de decisão, roda o corte e o replay, e grava `resultado.json` + `index.html` (página Artifact). Zero migration/edge/Publish.

**Tech Stack:** TypeScript 5.8 strict, vitest (`bun run test`), bun para o script, PostgreSQL 17 via psql-ro.

**Spec:** `docs/superpowers/specs/2026-10-15-orcamento-compra-design.md` (leia antes; os §§ citados abaixo são dela).

## Global Constraints

- Responder/escrever em **pt-BR**; nomes de código em pt-BR (`cortar`, `trajetoriaDiaria`).
- **Ausente ≠ zero**: preço/margem/custo/demanda ausente → `null` → embalagem **sem score** (motivo explícito), nunca 0 fabricado (`Number(null)===0` é bug).
- Nada de I/O em `src/lib/reposicao/orcamento-compra/**`; nada importado de `src/lib/financeiro/**` (fronteira de módulo `reposicao` ↔ `financeiro`).
- Banco **só leitura**: `~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f <arquivo>` e toda consulta termina com `select 'fim','ok';`; o script exige o marcador e reprova `ERROR`.
- Empresa no banco: `pedido_compra_sugerido.empresa='OBEN'`, `sku_parametros`/`v_sku_parametros_sugeridos.empresa='OBEN'` (maiúsculas — conferir no pré-voo), `fin_*`/`inventory_position`: `'oben'` (minúsculas). Fornecedor Sayerlack no CP: `omie_codigo_cliente_fornecedor = 8689681266`.
- `fin_contas_pagar.saldo` **não é confiável** — nunca usar; usar `status_titulo` / `v_titulo_baixas`.
- Frete = **2,5%** do valor (entra no desembolso, nunca como custo fixo de pedido).
- Reserva padrão = **30 dias × saída média diária liquidada**; sensibilidades 15/30/45 dias.
- Cenário-guarda: snapshot **pessimista** + compromissos + saídas não-Sayerlack + continuidade do motor; **entradas de vendas novas = 0**.
- Data do pagamento = data do pedido + p10(pedido→faturamento) + p10(emissão NF→vencimento); atraso logístico **nunca** adia pagamento.
- Comandos de verificação: `heavy bun run test`, `bun run typecheck`, `bun lint` — evidência positiva (`exit 0` colado), nunca ausência de erro.
- Commits em pt-BR, terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Linha com `qtde_final` que não é múltiplo da embalagem** (ajuste humano) — esperado: última embalagem com o resto, soma das embalagens = `qtde_final` exata (teste na Task 1).
2. **Estoque efetivo negativo (comprometido > físico)** — esperado: a compra cobre primeiro o backlog e isso conta como unidades atendidas; não some no `max(…,0)` (teste na Task 3).
3. **Dia sem snapshot de caixa para a data do ciclo** — esperado: ciclo `indeterminado` com camada `snapshot` nomeada, nunca saldo 0 (teste na Task 7).
4. **SKU sem nenhuma venda em 180d mas pedido pelo motor** — esperado: `sem_score` / `historico_insuficiente`, sem proteção automática (teste na Task 2/3).
5. **NF do título com zeros à esquerda vs NF do tracking sem zeros** (`000952221` × `952221`) — esperado: casam (teste na Task 4).

---

## File Structure

| Arquivo | Responsabilidade |
|---|---|
| `src/lib/reposicao/orcamento-compra/datas.ts` | aritmética de datas ISO (UTC), dias úteis |
| `src/lib/reposicao/orcamento-compra/embalagens.ts` | tipos de linha/embalagem; quebra da linha do motor em embalagens; data de pagamento |
| `src/lib/reposicao/orcamento-compra/demanda.ts` | reconstrução de estoque para trás, censura, amostras empíricas e gaussianas, suficiência de histórico |
| `src/lib/reposicao/orcamento-compra/valor.ts` | ΔV por embalagem, quantidade protegida |
| `src/lib/reposicao/orcamento-compra/caixa.ts` | fluxos, trajetória diária, estado viável/inviável/indeterminado |
| `src/lib/reposicao/orcamento-compra/camadas.ts` | conciliação pedido→NF→CP, ritmo não-Sayerlack, provisão de continuidade |
| `src/lib/reposicao/orcamento-compra/corte.ts` | protegidos, guloso com prefixo, mínimo por pedido, score marginal |
| `src/lib/reposicao/orcamento-compra/replay.ts` | estoque contrafactual por SKU e classificação do corte |
| `src/lib/reposicao/orcamento-compra/medicao.ts` | episódios, precisão do corte, ΔDIO |
| `src/lib/reposicao/orcamento-compra/*.test.ts` | testes co-localizados (vitest, ambiente node) |
| `docs/superpowers/orcamento-compra/fatos.sql` | fatos read-only em uma linha `json|…` |
| `scripts/orcamento-compra/simular.ts` | I/O: roda o SQL, pré-voo, monta ciclos as-of, backtest, grava resultado |
| `scripts/orcamento-compra/simular.test.ts` | testes do parser/pré-voo/montagem com fixture |
| `scripts/orcamento-compra/pagina.ts` | `resultado.json` → `index.html` |
| `docs/superpowers/orcamento-compra/LEIA-ME.md` | como rodar, o que significa, quando medir de novo |

Os arquivos em `src/lib/reposicao/**` já pertencem ao módulo `reposicao` em `src/lib/modulos/manifesto.ts` (glob `src/lib/reposicao/**` em `codigo`) — **não** editar o manifesto. Rodar `bun run modulos:gate` (ou o gate equivalente listado em `package.json`) na Task 9 para confirmar.

---

### Task 0: Preparação

**Files:** nenhum.

- [ ] **Step 1: Branch atualizada**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
git fetch -q origin && git status -sb && git log --oneline -3
```
Expected: branch `claude/orcamento-compra`, spec commitada, sem mudanças pendentes. Se `origin/main` andou, `git rebase origin/main`.

- [ ] **Step 2: Linha de base verde**

```bash
heavy bun run test -- src/lib/reposicao > /tmp/oc-base.log 2>&1; rc=$?; tail -5 /tmp/oc-base.log; [ "$rc" -eq 0 ]
```
Expected: exit 0. Se vermelho antes de qualquer mudança, pare e reporte (não é desta entrega).

---

### Task 1: Datas e embalagens

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/datas.ts`
- Create: `src/lib/reposicao/orcamento-compra/embalagens.ts`
- Test: `src/lib/reposicao/orcamento-compra/embalagens.test.ts`

**Interfaces:**
- Produces:
  - `type DataISO = string`; `addDias(d: DataISO, n: number): DataISO`; `diffDias(a: DataISO, b: DataISO): number` (b − a); `ehDiaUtil(d: DataISO): boolean`
  - `interface LinhaMotor { pedidoId: number; pedidoRaizId: number; sku: string; qtdeFinal: number; fatorEmbalagem: number | null; precoUnitario: number | null; precoVendaMedio: number | null; estoqueEfetivo: number; pontoPedido: number; precoCheioPromocao: number | null }`
  - `interface Embalagem { pedidoRaizId: number; sku: string; k: number; qtde: number; desembolso: number | null; dataPagamento: DataISO }`
  - `interface Lags { faturamentoP10: number; vencimentoP10: number }`
  - `passoDaLinha(l: LinhaMotor): number`
  - `dataPagamentoPrevista(dataPedido: DataISO, lags: Lags): DataISO`
  - `quebrarEmEmbalagens(l: LinhaMotor, p: { fretePerc: number; dataPagamento: DataISO }): Embalagem[]`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/embalagens.test.ts
import { describe, expect, it } from 'vitest';
import { addDias, diffDias, ehDiaUtil } from './datas';
import { dataPagamentoPrevista, quebrarEmEmbalagens, passoDaLinha, type LinhaMotor } from './embalagens';

const base: LinhaMotor = {
  pedidoId: 10, pedidoRaizId: 10, sku: '123', qtdeFinal: 12, fatorEmbalagem: 0.25,
  precoUnitario: 10, precoVendaMedio: 15, estoqueEfetivo: 0, pontoPedido: 5, precoCheioPromocao: null,
};

describe('datas', () => {
  it('soma e diferença de dias em UTC sem fuso', () => {
    expect(addDias('2026-10-30', 3)).toBe('2026-11-02');
    expect(diffDias('2026-10-30', '2026-11-02')).toBe(3);
  });
  it('dia útil = seg..sex', () => {
    expect(ehDiaUtil('2026-10-16')).toBe(true); // sexta
    expect(ehDiaUtil('2026-10-17')).toBe(false); // sábado
  });
});

describe('quebrarEmEmbalagens', () => {
  it('passo = 1/fator do portal (fator 0,25 → 4 unidades por embalagem)', () => {
    expect(passoDaLinha(base)).toBe(4);
    const e = quebrarEmEmbalagens(base, { fretePerc: 0.025, dataPagamento: '2026-10-20' });
    expect(e.map((x) => x.k)).toEqual([1, 2, 3]);
    expect(e.every((x) => x.qtde === 4)).toBe(true);
    expect(e[0].desembolso).toBeCloseTo(4 * 10 * 1.025, 9);
  });
  it('sem fator → passo 1', () => {
    expect(passoDaLinha({ ...base, fatorEmbalagem: null })).toBe(1);
  });
  it('qtde não-múltiplo (ajuste humano): última embalagem leva o resto e a soma fecha', () => {
    const e = quebrarEmEmbalagens({ ...base, qtdeFinal: 10 }, { fretePerc: 0, dataPagamento: '2026-10-20' });
    expect(e.map((x) => x.qtde)).toEqual([4, 4, 2]);
    expect(e.reduce((s, x) => s + x.qtde, 0)).toBe(10);
  });
  it('preço ausente → desembolso null (nunca 0)', () => {
    const e = quebrarEmEmbalagens({ ...base, precoUnitario: null }, { fretePerc: 0.025, dataPagamento: '2026-10-20' });
    expect(e[0].desembolso).toBeNull();
  });
  it('qtde 0 → nenhuma embalagem', () => {
    expect(quebrarEmEmbalagens({ ...base, qtdeFinal: 0 }, { fretePerc: 0, dataPagamento: '2026-10-20' })).toEqual([]);
  });
});

describe('dataPagamentoPrevista', () => {
  it('pedido + p10 faturamento + p10 vencimento; não depende da chegada', () => {
    expect(dataPagamentoPrevista('2026-10-01', { faturamentoP10: 2, vencimentoP10: 1 })).toBe('2026-10-04');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/embalagens.test.ts`
Expected: FAIL (`Cannot find module './datas'`).

- [ ] **Step 3: Implementar**

```ts
// src/lib/reposicao/orcamento-compra/datas.ts
// Datas como 'YYYY-MM-DD' em aritmética UTC pura (sem fuso): o dia já vem resolvido em America/Sao_Paulo pelo SQL.
export type DataISO = string;

const paraDate = (d: DataISO) => new Date(`${d}T00:00:00Z`);

export function addDias(d: DataISO, n: number): DataISO {
  const x = paraDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function diffDias(a: DataISO, b: DataISO): number {
  return Math.round((paraDate(b).getTime() - paraDate(a).getTime()) / 86_400_000);
}

export function ehDiaUtil(d: DataISO): boolean {
  const dia = paraDate(d).getUTCDay();
  return dia !== 0 && dia !== 6;
}
```

```ts
// src/lib/reposicao/orcamento-compra/embalagens.ts
import { addDias, type DataISO } from './datas';

/** Uma linha de pedido_compra_item como o motor a deixou no ciclo (spec §5.1). */
export interface LinhaMotor {
  pedidoId: number;
  /** split_parent_id ?? id — pai e filhos de split avaliados juntos (spec §5.4). */
  pedidoRaizId: number;
  sku: string;
  qtdeFinal: number;
  /** fator_embalagem_portal: embalagens por unidade; passo = 1/fator. */
  fatorEmbalagem: number | null;
  precoUnitario: number | null;
  precoVendaMedio: number | null;
  /** estoque_atual da linha = físico + a caminho − comprometido (pode ser negativo). */
  estoqueEfetivo: number;
  pontoPedido: number;
  /** preco_sem_desconto quando a linha está em promoção; senão null. */
  precoCheioPromocao: number | null;
}

export interface Embalagem {
  pedidoRaizId: number;
  sku: string;
  /** 1-based; k só pode ser aceita se k−1 foi (prefixo). */
  k: number;
  qtde: number;
  /** qtde × preço × (1 + frete); null se preço ausente. */
  desembolso: number | null;
  dataPagamento: DataISO;
}

export interface Lags {
  faturamentoP10: number;
  vencimentoP10: number;
}

export function passoDaLinha(l: LinhaMotor): number {
  return l.fatorEmbalagem && l.fatorEmbalagem > 0 ? 1 / l.fatorEmbalagem : 1;
}

/** Pagamento mais cedo plausível (risco de caixa): pedido + p10 faturamento + p10 vencimento. */
export function dataPagamentoPrevista(dataPedido: DataISO, lags: Lags): DataISO {
  return addDias(dataPedido, lags.faturamentoP10 + lags.vencimentoP10);
}

export function quebrarEmEmbalagens(
  l: LinhaMotor,
  p: { fretePerc: number; dataPagamento: DataISO },
): Embalagem[] {
  if (!(l.qtdeFinal > 0)) return [];
  const passo = passoDaLinha(l);
  const n = Math.ceil(l.qtdeFinal / passo - 1e-9);
  const out: Embalagem[] = [];
  for (let k = 1; k <= n; k++) {
    const qtde = k < n ? passo : l.qtdeFinal - (n - 1) * passo;
    out.push({
      pedidoRaizId: l.pedidoRaizId,
      sku: l.sku,
      k,
      qtde,
      desembolso: l.precoUnitario == null ? null : qtde * l.precoUnitario * (1 + p.fretePerc),
      dataPagamento: p.dataPagamento,
    });
  }
  return out;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/embalagens.test.ts`
Expected: PASS (8 testes). Se `[4,4,2]` vier com `1.9999999` use `toBeCloseTo` só nesse caso — não arredonde na implementação.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/datas.ts src/lib/reposicao/orcamento-compra/embalagens.ts src/lib/reposicao/orcamento-compra/embalagens.test.ts
git commit -m "feat(reposicao): orçamento de compra — datas e quebra da linha do motor em embalagens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Demanda (reconstrução, censura, amostras)

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/demanda.ts`
- Test: `src/lib/reposicao/orcamento-compra/demanda.test.ts`

**Interfaces:**
- Produces:
  - `type SerieDiaria = (number | null)[]` (null = dia censurado)
  - `reconstruirEstoque(estoqueFinal: number, demanda: number[], recebimentos: number[]): number[]` — estoque ao **fim** de cada dia, do mais antigo ao mais recente; o último elemento = `estoqueFinal`.
  - `marcarCensura(demanda: number[], estoqueFimDia: number[]): SerieDiaria`
  - `interface AmostraDemanda { ateChegada: number; total: number }`
  - `amostrasEmpiricas(serie: SerieDiaria, diasAteChegada: number, diasTotal: number): AmostraDemanda[]`
  - `amostrasGaussianas(media: number, sigma: number, diasAteChegada: number, diasTotal: number, n: number): AmostraDemanda[]`
  - `historicoSuficiente(serie: SerieDiaria, minOcorrencias: number): boolean`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/demanda.test.ts
import { describe, expect, it } from 'vitest';
import {
  amostrasEmpiricas, amostrasGaussianas, historicoSuficiente, marcarCensura, reconstruirEstoque,
} from './demanda';

describe('reconstruirEstoque (para trás a partir do estoque de hoje)', () => {
  it('fim_{t-1} = fim_t − recebido_t + demanda_t', () => {
    // dias: 0,1,2 ; hoje (fim do dia 2) = 5 ; dia 2 vendeu 3 e recebeu 0 ; dia 1 recebeu 10 e vendeu 2
    expect(reconstruirEstoque(5, [1, 2, 3], [0, 10, 0])).toEqual([0, 8, 5]);
  });
});

describe('marcarCensura', () => {
  it('dia com estoque reconstruído ≤ 0 vira null (zero de falta ≠ zero de demanda)', () => {
    expect(marcarCensura([0, 2, 0], [0, 3, 3])).toEqual([null, 2, 0]);
  });
});

describe('amostrasEmpiricas', () => {
  it('janelas deslizantes, descartando as que contêm dia censurado', () => {
    const a = amostrasEmpiricas([1, 2, null, 4, 5, 6], 1, 2);
    expect(a).toEqual([
      { ateChegada: 1, total: 3 },
      { ateChegada: 4, total: 9 },
      { ateChegada: 5, total: 11 },
    ]);
  });
  it('série curta demais → vazio (ausente ≠ zero)', () => {
    expect(amostrasEmpiricas([1, 2], 1, 5)).toEqual([]);
  });
});

describe('amostrasGaussianas', () => {
  it('determinística, não-negativa, média ≈ μ·T', () => {
    const a = amostrasGaussianas(2, 1, 3, 10, 400);
    const b = amostrasGaussianas(2, 1, 3, 10, 400);
    expect(a).toEqual(b);
    expect(a.every((x) => x.ateChegada >= 0 && x.total >= x.ateChegada)).toBe(true);
    const media = a.reduce((s, x) => s + x.total, 0) / a.length;
    expect(media).toBeGreaterThan(19);
    expect(media).toBeLessThan(21);
  });
});

describe('historicoSuficiente', () => {
  it('conta dias com venda > 0, ignorando censurados', () => {
    expect(historicoSuficiente([0, null, 1, 0, 2], 3)).toBe(false);
    expect(historicoSuficiente([1, null, 1, 0, 2], 3)).toBe(true);
  });
  it('SKU sem venda alguma em 180d → insuficiente', () => {
    expect(historicoSuficiente(new Array(180).fill(0), 3)).toBe(false);
  });
});
```

- [ ] **Step 2: Ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/demanda.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
// src/lib/reposicao/orcamento-compra/demanda.ts
// Demanda empírica para o gate econômico (spec §5.2). Sem histórico diário de estoque em produção,
// o estoque é reconstruído para trás a partir do estoque de hoje (spec §7).

export type SerieDiaria = (number | null)[];

export interface AmostraDemanda {
  /** demanda acumulada de hoje até a chegada desta compra */
  ateChegada: number;
  /** demanda acumulada de hoje até a chegada da próxima oportunidade */
  total: number;
}

export function reconstruirEstoque(estoqueFinal: number, demanda: number[], recebimentos: number[]): number[] {
  const n = demanda.length;
  const fim = new Array<number>(n);
  fim[n - 1] = estoqueFinal;
  for (let t = n - 1; t > 0; t--) fim[t - 1] = fim[t] - (recebimentos[t] ?? 0) + demanda[t];
  return fim;
}

export function marcarCensura(demanda: number[], estoqueFimDia: number[]): SerieDiaria {
  return demanda.map((d, t) => (estoqueFimDia[t] <= 0 ? null : d));
}

const soma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function amostrasEmpiricas(serie: SerieDiaria, diasAteChegada: number, diasTotal: number): AmostraDemanda[] {
  const out: AmostraDemanda[] = [];
  for (let i = 0; i + diasTotal <= serie.length; i++) {
    const janela = serie.slice(i, i + diasTotal);
    if (janela.some((v) => v === null)) continue;
    const nums = janela as number[];
    out.push({ ateChegada: soma(nums.slice(0, diasAteChegada)), total: soma(nums) });
  }
  return out;
}

// Inversa da normal padrão (Acklam). Usada só para a comparação de estabilidade com o modelo do motor.
function inversaNormal(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pBaixo = 0.02425;
  if (p < pBaixo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pBaixo) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Grade estratificada determinística (sem RNG): o mesmo input dá sempre a mesma amostra. */
export function amostrasGaussianas(media: number, sigma: number, diasAteChegada: number, diasTotal: number, n: number): AmostraDemanda[] {
  const out: AmostraDemanda[] = [];
  const resto = diasTotal - diasAteChegada;
  for (let i = 0; i < n; i++) {
    const u1 = (i + 0.5) / n;
    const u2 = (((i * 7919) % n) + 0.5) / n;
    const ate = Math.max(0, diasAteChegada * media + Math.sqrt(diasAteChegada) * sigma * inversaNormal(u1));
    const depois = Math.max(0, resto * media + Math.sqrt(resto) * sigma * inversaNormal(u2));
    out.push({ ateChegada: ate, total: ate + depois });
  }
  return out;
}

export function historicoSuficiente(serie: SerieDiaria, minOcorrencias: number): boolean {
  return serie.filter((v) => v !== null && v > 0).length >= minOcorrencias;
}
```

- [ ] **Step 4: Ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/demanda.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/demanda.ts src/lib/reposicao/orcamento-compra/demanda.test.ts
git commit -m "feat(reposicao): orçamento de compra — demanda empírica, censura e reconstrução de estoque

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Valor econômico por embalagem e proteção

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/valor.ts`
- Test: `src/lib/reposicao/orcamento-compra/valor.test.ts`

**Interfaces:**
- Consumes: `AmostraDemanda` (Task 2).
- Produces:
  - `interface ParamsValor { margemUnit: number | null; custoUnit: number | null; hDia: number; diasAteChegada: number; demandaMediaDiaria: number; horizonteMaxDias: number; promoBeneficioUnit: number; horizontePromoDias: number }`
  - `interface ValorEmbalagem { deltaV: number | null; unidadesAtendidas: number | null; motivoSemScore: 'preco_ou_margem_ausente' | 'historico_insuficiente' | null }`
  - `atendidas(estoqueEfetivo: number, Q: number, a: AmostraDemanda): number`
  - `valorDasEmbalagens(estoqueEfetivo: number, qtdes: number[], amostras: AmostraDemanda[], p: ParamsValor): ValorEmbalagem[]`
  - `quantidadeProtegida(estoqueEfetivo: number, demandaMediaDiaria: number, diasAteChegada: number, diasTotal: number): number`

Modelo (spec §5.2): backlog `b = max(−efetivo, 0)` é atendido primeiro pela compra; estoque disponível na chegada `onhand = max(max(efetivo,0) − ateChegada, 0)`; `atendidas(Q) = min(Q, b) + min(onhand + max(Q − b, 0), total − ateChegada)`. Unidades da embalagem k = `atendidas(Q_k) − atendidas(Q_{k−1})`, média sobre as amostras. Carregamento em **unidades×dia**: a parte da embalagem que não cobre backlog fica estocada `min((onhandMedio + max(Q_{k−1} − b, 0) + q_eff/2) / d, horizonteMaxDias)` dias após a chegada (d ≤ 0 → `horizonteMaxDias`).

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/valor.test.ts
import { describe, expect, it } from 'vitest';
import { amostrasEmpiricas } from './demanda';
import { atendidas, quantidadeProtegida, valorDasEmbalagens, type ParamsValor } from './valor';

const p: ParamsValor = {
  margemUnit: 5, custoUnit: 10, hDia: 0.15 / 365, diasAteChegada: 14, demandaMediaDiaria: 1,
  horizonteMaxDias: 365, promoBeneficioUnit: 0, horizontePromoDias: 90,
};

describe('atendidas', () => {
  it('backlog (efetivo negativo) é atendido primeiro e conta como atendido', () => {
    // efetivo −3 (3 já vendidos sem estoque), sem demanda nova
    expect(atendidas(-3, 2, { ateChegada: 0, total: 0 })).toBe(2);
    expect(atendidas(-3, 5, { ateChegada: 0, total: 0 })).toBe(3);
  });
  it('demanda antes da chegada não é salva pela compra', () => {
    // efetivo 0, 10 de demanda antes da chegada, 1 depois: compra de 5 atende só 1
    expect(atendidas(0, 5, { ateChegada: 10, total: 11 })).toBe(1);
  });
});

describe('valorDasEmbalagens — enchimento até o máximo tem ΔV < 0 (spec §8 teste 2)', () => {
  it('próxima oportunidade 1 dia após, LT 14, demanda 1/dia: só a 1ª embalagem vale', () => {
    const serie = new Array(180).fill(1);
    const amostras = amostrasEmpiricas(serie, 14, 15);
    const v = valorDasEmbalagens(14, new Array(30).fill(1), amostras, p);
    expect(v[0].unidadesAtendidas).toBeCloseTo(1, 9);
    expect(v[0].deltaV!).toBeGreaterThan(0);
    expect(v.slice(1).every((x) => x.deltaV! < 0)).toBe(true);
    expect(v.slice(1).every((x) => x.unidadesAtendidas === 0)).toBe(true);
  });
});

describe('ausente ≠ zero (spec §8 teste 10)', () => {
  it('margem null → sem score, nunca ΔV calculado com 0', () => {
    const v = valorDasEmbalagens(0, [1], [{ ateChegada: 0, total: 5 }], { ...p, margemUnit: null });
    expect(v[0]).toEqual({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'preco_ou_margem_ausente' });
  });
  it('sem amostras → historico_insuficiente', () => {
    const v = valorDasEmbalagens(0, [1], [], p);
    expect(v[0].motivoSemScore).toBe('historico_insuficiente');
    expect(v[0].deltaV).toBeNull();
  });
});

describe('promoção', () => {
  it('benefício de preço entra quando a unidade é consumida dentro do horizonte da promoção', () => {
    const amostras = [{ ateChegada: 0, total: 0 }];
    const sem = valorDasEmbalagens(100, [1], amostras, p)[0].deltaV!;
    const com = valorDasEmbalagens(100, [1], amostras, { ...p, promoBeneficioUnit: 2 })[0].deltaV!;
    expect(com - sem).toBeCloseTo(2, 9);
  });
});

describe('quantidadeProtegida', () => {
  it('cobre o backlog + a falta média entre a chegada e a próxima oportunidade', () => {
    // efetivo −2, d=1, L=14, T=15: onhand na chegada 0; precisa 2 (backlog) + 1 (dia 15)
    expect(quantidadeProtegida(-2, 1, 14, 15)).toBe(3);
    // estoque que sobra na chegada cobre tudo → 0
    expect(quantidadeProtegida(20, 1, 14, 15)).toBe(0);
  });
});
```

- [ ] **Step 2: Ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/valor.test.ts`
Expected: FAIL (módulo inexistente).

- [ ] **Step 3: Implementar**

```ts
// src/lib/reposicao/orcamento-compra/valor.ts
// ΔV por embalagem incremental (spec §5.2): comprar k AGORA vs adiar para a próxima oportunidade.
import type { AmostraDemanda } from './demanda';

export interface ParamsValor {
  /** preco_venda_medio − custo de aquisição; null se algum ausente */
  margemUnit: number | null;
  /** custo de aquisição atual (preço da linha, não CMC) */
  custoUnit: number | null;
  /** cm_anual / 365 */
  hDia: number;
  diasAteChegada: number;
  demandaMediaDiaria: number;
  horizonteMaxDias: number;
  /** (preço cheio − preço promo) por unidade; 0 sem promoção */
  promoBeneficioUnit: number;
  horizontePromoDias: number;
}

export interface ValorEmbalagem {
  deltaV: number | null;
  unidadesAtendidas: number | null;
  motivoSemScore: 'preco_ou_margem_ausente' | 'historico_insuficiente' | null;
}

export function atendidas(estoqueEfetivo: number, Q: number, a: AmostraDemanda): number {
  const backlog = Math.max(-estoqueEfetivo, 0);
  const onhand = Math.max(Math.max(estoqueEfetivo, 0) - a.ateChegada, 0);
  const demandaApos = a.total - a.ateChegada;
  return Math.min(Q, backlog) + Math.min(onhand + Math.max(Q - backlog, 0), demandaApos);
}

export function valorDasEmbalagens(
  estoqueEfetivo: number,
  qtdes: number[],
  amostras: AmostraDemanda[],
  p: ParamsValor,
): ValorEmbalagem[] {
  if (p.margemUnit == null || p.custoUnit == null) {
    return qtdes.map(() => ({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'preco_ou_margem_ausente' }));
  }
  if (amostras.length === 0) {
    return qtdes.map(() => ({ deltaV: null, unidadesAtendidas: null, motivoSemScore: 'historico_insuficiente' }));
  }
  const backlog = Math.max(-estoqueEfetivo, 0);
  const d = p.demandaMediaDiaria;
  const onhandMedio = Math.max(Math.max(estoqueEfetivo, 0) - d * p.diasAteChegada, 0);
  const out: ValorEmbalagem[] = [];
  let qAnterior = 0;
  for (const q of qtdes) {
    const qAtual = qAnterior + q;
    let soma = 0;
    for (const a of amostras) soma += atendidas(estoqueEfetivo, qAtual, a) - atendidas(estoqueEfetivo, qAnterior, a);
    const unidades = soma / amostras.length;
    // parte da embalagem que vai para a prateleira (não cobre backlog)
    const qEstocada = Math.max(qAtual - backlog, 0) - Math.max(qAnterior - backlog, 0);
    const posicaoAntes = onhandMedio + Math.max(qAnterior - backlog, 0);
    const dias = d > 0 ? Math.min((posicaoAntes + qEstocada / 2) / d, p.horizonteMaxDias) : p.horizonteMaxDias;
    const carregamento = p.custoUnit * p.hDia * qEstocada * dias;
    const promo = dias <= p.horizontePromoDias ? p.promoBeneficioUnit * qEstocada : 0;
    out.push({ deltaV: p.margemUnit * unidades - carregamento + promo, unidadesAtendidas: unidades, motivoSemScore: null });
    qAnterior = qAtual;
  }
  return out;
}

/** Quantidade mínima que cobre a falta no caminho médio entre a chegada e a próxima oportunidade (spec §5.4). */
export function quantidadeProtegida(estoqueEfetivo: number, demandaMediaDiaria: number, diasAteChegada: number, diasTotal: number): number {
  const backlog = Math.max(-estoqueEfetivo, 0);
  const onhand = Math.max(Math.max(estoqueEfetivo, 0) - demandaMediaDiaria * diasAteChegada, 0);
  const falta = Math.max(demandaMediaDiaria * (diasTotal - diasAteChegada) - onhand, 0);
  return backlog + falta;
}
```

> Nota: o termo de perda por obsolescência da spec (§5.2) fica **fora** desta v1 (default 0 e nenhum SKU sinalizado — YAGNI); o relatório declara isso em "premissas".

- [ ] **Step 4: Ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/valor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/valor.ts src/lib/reposicao/orcamento-compra/valor.test.ts
git commit -m "feat(reposicao): orçamento de compra — ΔV por embalagem (comprar agora vs adiar) e quantidade protegida [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Caixa — trajetória diária, estado e camadas

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/caixa.ts`
- Create: `src/lib/reposicao/orcamento-compra/camadas.ts`
- Test: `src/lib/reposicao/orcamento-compra/caixa.test.ts`

**Interfaces:**
- Consumes: `DataISO`, `addDias`, `diffDias`, `ehDiaUtil` (Task 1).
- Produces (`caixa.ts`):
  - `type Camada = 'base_titulos' | 'reconciliacao_saldo' | 'compromisso_conciliado' | 'compromisso_nao_conciliado' | 'saida_nao_sayerlack' | 'continuidade_motor' | 'candidato'`
  - `interface Fluxo { data: DataISO; valor: number; camada: Camada }` (entrada > 0, saída < 0)
  - `interface PontoTrajetoria { data: DataISO; saldo: number }`
  - `type EstadoCaixa = { tipo: 'viavel'; piso: number; dataPiso: DataISO } | { tipo: 'inviavel'; primeiraViolacao: DataISO; deficitMax: number } | { tipo: 'indeterminado'; camadas: string[]; piso: number }`
  - `trajetoriaDiaria(saldoInicial: number, inicio: DataISO, dias: number, fluxos: Fluxo[]): PontoTrajetoria[]`
  - `avaliarEstado(traj: PontoTrajetoria[], reserva: number, ausencias: string[]): EstadoCaixa`
  - `fluxosDeSemanaAgregada(inicio: DataISO, fim: DataISO, entradas: number, saidas: number): Fluxo[]`
- Produces (`camadas.ts`):
  - `interface PedidoDisparado { pedidoId: number; valorTotal: number; dataPedido: DataISO; nfs: string[] }`
  - `interface TituloCp { nf: string; valor: number }`
  - `normalizarNf(nf: string): string`
  - `conciliarCompromissos(pedidos: PedidoDisparado[], titulos: TituloCp[], inicio: DataISO, lagDias: number): { fluxos: Fluxo[]; naoConciliado: number }`
  - `ritmoPorDiaDoMes(pagamentos: { data: DataISO; valor: number }[], meses: number): number[]` (índice 1..31)
  - `projetarRitmo(inicio: DataISO, dias: number, ritmo: number[], jaTituladoPorMes: Record<string, number>): Fluxo[]`
  - `provisaoContinuidade(inicio: DataISO, dias: number, porDiaUtil: number, lagDias: number, compraAceita: number): Fluxo[]`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/caixa.test.ts
import { describe, expect, it } from 'vitest';
import { avaliarEstado, fluxosDeSemanaAgregada, trajetoriaDiaria, type Fluxo } from './caixa';
import { conciliarCompromissos, normalizarNf, projetarRitmo, provisaoContinuidade, ritmoPorDiaDoMes } from './camadas';

const f = (data: string, valor: number): Fluxo => ({ data, valor, camada: 'base_titulos' });

describe('trajetória diária e estado', () => {
  it('intrassemana: o fechamento semanal não mascara a violação (spec §8 teste 7)', () => {
    // seg 2026-10-19 saldo 230k; qua −40k; sex +80k; reserva 224k
    const t = trajetoriaDiaria(230_000, '2026-10-19', 7, [f('2026-10-21', -40_000), f('2026-10-23', 80_000)]);
    expect(t[t.length - 1].saldo).toBe(270_000);
    const e = avaliarEstado(t, 224_000, []);
    expect(e).toEqual({ tipo: 'inviavel', primeiraViolacao: '2026-10-21', deficitMax: 34_000 });
  });
  it('pagamento fora do horizonte estende a verificação (spec §8 teste 8)', () => {
    const t = trajetoriaDiaria(300_000, '2026-10-01', 91, [f('2026-01-01', 0), f('2027-01-04', -100_000)]);
    expect(t.length).toBe(96);
    expect(avaliarEstado(t, 224_000, []).tipo).toBe('inviavel');
  });
  it('remover uma camada muda o saldo exatamente pelo fluxo acumulado removido (spec §8 teste 9)', () => {
    const outros = [f('2026-10-02', -10_000), f('2026-10-05', 3_000)];
    const camada: Fluxo[] = [{ data: '2026-10-03', valor: -7_000, camada: 'saida_nao_sayerlack' }];
    const com = trajetoriaDiaria(100_000, '2026-10-01', 10, [...outros, ...camada]);
    const sem = trajetoriaDiaria(100_000, '2026-10-01', 10, outros);
    com.forEach((p, i) => expect(sem[i].saldo - p.saldo).toBe(p.data >= '2026-10-03' ? 7_000 : 0));
  });
  it('camada ausente → indeterminado, nomeando a camada', () => {
    const t = trajetoriaDiaria(900_000, '2026-10-01', 5, []);
    expect(avaliarEstado(t, 224_000, ['snapshot'])).toEqual({ tipo: 'indeterminado', camadas: ['snapshot'], piso: 900_000 });
  });
  it('viável reporta piso e data do piso', () => {
    const t = trajetoriaDiaria(300_000, '2026-10-01', 5, [f('2026-10-03', -50_000), f('2026-10-04', 20_000)]);
    expect(avaliarEstado(t, 224_000, [])).toEqual({ tipo: 'viavel', piso: 250_000, dataPiso: '2026-10-03' });
  });
  it('semana agregada: saídas no 1º dia, entradas no último (limite inferior)', () => {
    expect(fluxosDeSemanaAgregada('2026-10-19', '2026-10-25', 50, 30)).toEqual([
      { data: '2026-10-19', valor: -30, camada: 'base_titulos' },
      { data: '2026-10-25', valor: 50, camada: 'base_titulos' },
    ]);
  });
});

describe('conciliação pedido → NF → CP (spec §8 teste 3)', () => {
  it('normaliza zeros à esquerda', () => {
    expect(normalizarNf('000952221')).toBe(normalizarNf('952221'));
  });
  it('faturamento parcial: título 40k + resíduo 60k (nunca 140k nem 40k)', () => {
    const r = conciliarCompromissos(
      [{ pedidoId: 1, valorTotal: 100_000, dataPedido: '2026-10-01', nfs: ['123'] }],
      [{ nf: '000123', valor: 40_000 }], '2026-10-02', 3,
    );
    expect(r.fluxos).toEqual([{ data: '2026-10-04', valor: -60_000, camada: 'compromisso_conciliado' }]);
    expect(r.naoConciliado).toBe(0);
  });
  it('muitos-para-muitos: 2 pedidos numa NF', () => {
    const r = conciliarCompromissos(
      [
        { pedidoId: 1, valorTotal: 30_000, dataPedido: '2026-10-01', nfs: ['9'] },
        { pedidoId: 2, valorTotal: 20_000, dataPedido: '2026-10-02', nfs: ['9'] },
      ],
      [{ nf: '9', valor: 45_000 }], '2026-10-01', 3,
    );
    expect(r.fluxos.reduce((s, x) => s + x.valor, 0)).toBe(-5_000);
  });
  it('pedido sem NF entra inteiro e marcado não conciliado; data nunca antes do início', () => {
    const r = conciliarCompromissos([{ pedidoId: 3, valorTotal: 8_000, dataPedido: '2026-09-01', nfs: [] }], [], '2026-10-01', 3);
    expect(r.fluxos).toEqual([{ data: '2026-10-01', valor: -8_000, camada: 'compromisso_nao_conciliado' }]);
    expect(r.naoConciliado).toBe(8_000);
  });
  it('título maior que o pedido não gera entrada', () => {
    const r = conciliarCompromissos([{ pedidoId: 4, valorTotal: 10, dataPedido: '2026-10-01', nfs: ['1'] }], [{ nf: '1', valor: 12 }], '2026-10-01', 0);
    expect(r.fluxos).toEqual([]);
  });
});

describe('ritmo não-Sayerlack', () => {
  it('média mensal por dia do mês; projeção desconta o já titulado do mês', () => {
    const ritmo = ritmoPorDiaDoMes([{ data: '2026-08-05', valor: 600 }, { data: '2026-09-05', valor: 400 }], 2);
    expect(ritmo[5]).toBe(500);
    const fl = projetarRitmo('2026-10-01', 31, ritmo, { '2026-10': 200 });
    expect(fl).toEqual([{ data: '2026-10-05', valor: -300, camada: 'saida_nao_sayerlack' }]);
  });
  it('dia 31 em mês de 30 dias vai para o último dia', () => {
    const ritmo = new Array(32).fill(0); ritmo[31] = 100;
    expect(projetarRitmo('2026-11-01', 30, ritmo, {})).toEqual([{ data: '2026-11-30', valor: -100, camada: 'saida_nao_sayerlack' }]);
  });
});

describe('continuidade do motor', () => {
  it('provisão em dia útil após o lag; a compra aceita consome a provisão mais cedo', () => {
    // início sex 2026-10-16, lag 2 → primeiro dia possível 2026-10-19 (seg)
    const fl = provisaoContinuidade('2026-10-16', 6, 100, 2, 150);
    expect(fl).toEqual([
      { data: '2026-10-20', valor: -50, camada: 'continuidade_motor' },
      { data: '2026-10-21', valor: -100, camada: 'continuidade_motor' },
    ]);
  });
});
```

- [ ] **Step 2: Ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/caixa.test.ts`
Expected: FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar `caixa.ts`**

```ts
// src/lib/reposicao/orcamento-compra/caixa.ts
// Guarda de caixa diária (spec §6). Saldo = fim do dia. Fluxo antes do início cai no início.
import { addDias, diffDias, type DataISO } from './datas';

export type Camada =
  | 'base_titulos' | 'reconciliacao_saldo' | 'compromisso_conciliado' | 'compromisso_nao_conciliado'
  | 'saida_nao_sayerlack' | 'continuidade_motor' | 'candidato';

export interface Fluxo { data: DataISO; valor: number; camada: Camada }
export interface PontoTrajetoria { data: DataISO; saldo: number }

export type EstadoCaixa =
  | { tipo: 'viavel'; piso: number; dataPiso: DataISO }
  | { tipo: 'inviavel'; primeiraViolacao: DataISO; deficitMax: number }
  | { tipo: 'indeterminado'; camadas: string[]; piso: number };

export function trajetoriaDiaria(saldoInicial: number, inicio: DataISO, dias: number, fluxos: Fluxo[]): PontoTrajetoria[] {
  let n = dias;
  for (const fl of fluxos) n = Math.max(n, diffDias(inicio, fl.data) + 1);
  const delta = new Array<number>(n).fill(0);
  for (const fl of fluxos) delta[Math.max(0, diffDias(inicio, fl.data))] += fl.valor;
  let saldo = saldoInicial;
  return delta.map((v, i) => {
    saldo += v;
    return { data: addDias(inicio, i), saldo };
  });
}

export function avaliarEstado(traj: PontoTrajetoria[], reserva: number, ausencias: string[]): EstadoCaixa {
  let piso = Infinity;
  let dataPiso = traj[0]?.data ?? '';
  let primeiraViolacao: DataISO | null = null;
  for (const p of traj) {
    if (p.saldo < piso) { piso = p.saldo; dataPiso = p.data; }
    if (primeiraViolacao === null && p.saldo < reserva) primeiraViolacao = p.data;
  }
  if (ausencias.length > 0) return { tipo: 'indeterminado', camadas: [...ausencias], piso };
  if (primeiraViolacao !== null) return { tipo: 'inviavel', primeiraViolacao, deficitMax: reserva - piso };
  return { tipo: 'viavel', piso, dataPiso };
}

export function fluxosDeSemanaAgregada(inicio: DataISO, fim: DataISO, entradas: number, saidas: number): Fluxo[] {
  return [
    { data: inicio, valor: -saidas, camada: 'base_titulos' },
    { data: fim, valor: entradas, camada: 'base_titulos' },
  ];
}
```

- [ ] **Step 4: Implementar `camadas.ts`**

```ts
// src/lib/reposicao/orcamento-compra/camadas.ts
// Camadas que completam a projeção (spec §6.2, §6.3, §6.5).
import { addDias, ehDiaUtil, type DataISO } from './datas';
import type { Fluxo } from './caixa';

export interface PedidoDisparado { pedidoId: number; valorTotal: number; dataPedido: DataISO; nfs: string[] }
export interface TituloCp { nf: string; valor: number }

export function normalizarNf(nf: string): string {
  return nf.trim().replace(/^0+/, '');
}

/** Componentes conexos pedido↔NF; resíduo = Σ pedidos − Σ títulos das NFs do componente. */
export function conciliarCompromissos(
  pedidos: PedidoDisparado[],
  titulos: TituloCp[],
  inicio: DataISO,
  lagDias: number,
): { fluxos: Fluxo[]; naoConciliado: number } {
  const titulosPorNf = new Map<string, number>();
  for (const t of titulos) {
    const k = normalizarNf(t.nf);
    titulosPorNf.set(k, (titulosPorNf.get(k) ?? 0) + t.valor);
  }
  const pai = new Map<string, string>();
  const achar = (x: string): string => {
    while (pai.get(x) !== x) x = pai.get(x)!;
    return x;
  };
  const unir = (a: string, b: string) => pai.set(achar(a), achar(b));
  const nosPedido = pedidos.map((p) => `p:${p.pedidoId}`);
  nosPedido.forEach((n) => pai.set(n, n));
  pedidos.forEach((p, i) => {
    for (const nf of p.nfs.map(normalizarNf)) {
      const n = `n:${nf}`;
      if (!pai.has(n)) pai.set(n, n);
      unir(nosPedido[i], n);
    }
  });
  const componentes = new Map<string, { valor: number; data: DataISO; nfs: Set<string>; semNf: boolean }>();
  pedidos.forEach((p, i) => {
    const raiz = achar(nosPedido[i]);
    const c = componentes.get(raiz) ?? { valor: 0, data: p.dataPedido, nfs: new Set<string>(), semNf: p.nfs.length === 0 };
    c.valor += p.valorTotal;
    if (p.dataPedido < c.data) c.data = p.dataPedido;
    p.nfs.forEach((nf) => c.nfs.add(normalizarNf(nf)));
    componentes.set(raiz, c);
  });
  const fluxos: Fluxo[] = [];
  let naoConciliado = 0;
  for (const c of componentes.values()) {
    const titulado = [...c.nfs].reduce((s, nf) => s + (titulosPorNf.get(nf) ?? 0), 0);
    const residuo = c.valor - titulado;
    if (residuo <= 0) continue;
    const dataPrevista = addDias(c.data, lagDias);
    const data = dataPrevista < inicio ? inicio : dataPrevista;
    if (c.semNf) naoConciliado += residuo;
    fluxos.push({ data, valor: -residuo, camada: c.semNf ? 'compromisso_nao_conciliado' : 'compromisso_conciliado' });
  }
  return { fluxos, naoConciliado };
}

export function ritmoPorDiaDoMes(pagamentos: { data: DataISO; valor: number }[], meses: number): number[] {
  const ritmo = new Array<number>(32).fill(0);
  for (const p of pagamentos) ritmo[Number(p.data.slice(8, 10))] += p.valor / meses;
  return ritmo;
}

const ultimoDiaDoMes = (d: DataISO) => {
  const [a, m] = d.split('-').map(Number);
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
};

export function projetarRitmo(inicio: DataISO, dias: number, ritmo: number[], jaTituladoPorMes: Record<string, number>): Fluxo[] {
  const porMes = new Map<string, { data: DataISO; bruto: number }[]>();
  for (let i = 0; i < dias; i++) {
    const data = addDias(inicio, i);
    const dia = Number(data.slice(8, 10));
    const ult = ultimoDiaDoMes(data);
    let bruto = ritmo[dia] ?? 0;
    if (dia === ult) for (let extra = ult + 1; extra <= 31; extra++) bruto += ritmo[extra] ?? 0;
    const mes = data.slice(0, 7);
    if (!porMes.has(mes)) porMes.set(mes, []);
    porMes.get(mes)!.push({ data, bruto });
  }
  const out: Fluxo[] = [];
  for (const [mes, diasMes] of porMes) {
    const total = diasMes.reduce((s, x) => s + x.bruto, 0);
    if (total <= 0) continue;
    const fator = Math.max(total - (jaTituladoPorMes[mes] ?? 0), 0) / total;
    for (const x of diasMes) if (x.bruto * fator > 0) out.push({ data: x.data, valor: -x.bruto * fator, camada: 'saida_nao_sayerlack' });
  }
  return out;
}

export function provisaoContinuidade(inicio: DataISO, dias: number, porDiaUtil: number, lagDias: number, compraAceita: number): Fluxo[] {
  let aConsumir = compraAceita;
  const out: Fluxo[] = [];
  for (let i = lagDias + 1; i < dias; i++) {
    const data = addDias(inicio, i);
    if (!ehDiaUtil(data)) continue;
    const consumo = Math.min(aConsumir, porDiaUtil);
    aConsumir -= consumo;
    const valor = porDiaUtil - consumo;
    if (valor > 0) out.push({ data, valor: -valor, camada: 'continuidade_motor' });
  }
  return out;
}
```

- [ ] **Step 5: Ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/caixa.test.ts`
Expected: PASS. Atenção ao caso "continuidade": início 2026-10-16, lag 2 → i começa em 3 (2026-10-19 seg): 100 consumido inteiro; 2026-10-20: consome 50 → saída 50; 2026-10-21: 100. Se o teste divergir, corrija o **teste** só se a conta à mão concordar com a implementação; senão corrija a implementação.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/caixa.ts src/lib/reposicao/orcamento-compra/camadas.ts src/lib/reposicao/orcamento-compra/caixa.test.ts
git commit -m "feat(reposicao): orçamento de compra — trajetória diária de caixa, estados e camadas (conciliação por NF, ritmo, continuidade) [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Corte (protegidos, guloso com prefixo, mínimo por pedido)

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/corte.ts`
- Test: `src/lib/reposicao/orcamento-compra/corte.test.ts`

**Interfaces:**
- Consumes: `Embalagem` (Task 1), `Fluxo`, `EstadoCaixa`, `trajetoriaDiaria`, `avaliarEstado` (Task 4).
- Produces:
  - `interface Candidata extends Embalagem { deltaV: number | null; protegida: boolean; motivoSemScore: string | null }`
  - `type MotivoCorte = 'economico' | 'financeiro' | 'minimo' | 'sem_score'`
  - `interface BaseCaixa { saldoInicial: number; inicio: DataISO; dias: number; fluxos: Fluxo[]; ausencias: string[] }`
  - `interface ResultadoCorte { aceitas: Candidata[]; cortadas: { c: Candidata; motivo: MotivoCorte }[]; estado: EstadoCaixa; scoreMarginal: number | null; escassezCaixa: boolean; pedidosAbaixoMinimo: number[] }`
  - `cortar(cands: Candidata[], base: BaseCaixa, reserva: number, minimoPedido: number): ResultadoCorte`

Regras (spec §5.4): protegidas primeiro (se elas + base furam a reserva → `inviavel`, nada mais entra); score `ΔV/desembolso` **passado a não-crescente por SKU** (`score_k = min(score_k, score_{k−1})`) para respeitar o prefixo; elegível só com score ajustado > 0; aceita se a trajetória com o fluxo fica ≥ reserva todos os dias; prefixo quebrado (k−1 não aceita) → corta k como `financeiro`. Mínimo: pedido com 0 < total < mínimo tenta completar com as melhores cortadas do próprio pedido (prefixo + caixa); se não chega ao mínimo e não tem protegida → zera (`minimo`); se tem protegida → mantém e lista em `pedidosAbaixoMinimo`.

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/corte.test.ts
import { describe, expect, it } from 'vitest';
import { cortar, type BaseCaixa, type Candidata } from './corte';

const c = (sku: string, k: number, desembolso: number, deltaV: number | null, extra: Partial<Candidata> = {}): Candidata => ({
  pedidoRaizId: 1, sku, k, qtde: 1, desembolso, dataPagamento: '2026-10-10', deltaV, protegida: false, motivoSemScore: null, ...extra,
});
const base = (saldo: number): BaseCaixa => ({ saldoInicial: saldo, inicio: '2026-10-01', dias: 91, fluxos: [], ausencias: [] });

describe('cortar', () => {
  it('paridade: tudo com ΔV>0 e caixa folgado → aceita exatamente o que o motor pede (spec §8 teste 1)', () => {
    const cands = [c('A', 1, 10, 5), c('A', 2, 10, 3), c('B', 1, 20, 1)];
    const r = cortar(cands, base(1_000_000), 224_000, 0);
    expect(r.aceitas).toHaveLength(3);
    expect(r.cortadas).toHaveLength(0);
    expect(r.estado.tipo).toBe('viavel');
    expect(r.escassezCaixa).toBe(false);
  });
  it('ΔV ≤ 0 corta por motivo econômico, mesmo com caixa', () => {
    const r = cortar([c('A', 1, 10, 5), c('A', 2, 10, -1)], base(1_000_000), 224_000, 0);
    expect(r.cortadas.map((x) => [x.c.k, x.motivo])).toEqual([[2, 'economico']]);
  });
  it('prefixo: score de k nunca acima do de k−1 (k=2 com ΔV alto não entra sem k=1)', () => {
    const r = cortar([c('A', 1, 10, -1), c('A', 2, 10, 50)], base(1_000_000), 224_000, 0);
    expect(r.aceitas).toHaveLength(0);
    expect(r.cortadas.every((x) => x.motivo === 'economico')).toBe(true);
  });
  it('proteção inviável: base 240k, reserva 224k, protegidos 30k → inviável, déficit 14k (spec §8 teste 6)', () => {
    const r = cortar([c('A', 1, 30_000, null, { protegida: true }), c('B', 1, 10, 5)], base(240_000), 224_000, 0);
    expect(r.estado).toEqual({ tipo: 'inviavel', primeiraViolacao: '2026-10-10', deficitMax: 14_000 });
    expect(r.cortadas.map((x) => [x.c.sku, x.motivo])).toEqual([['B', 'financeiro']]);
  });
  it('guloso não-ótimo documentado (caso A/B/C do Codex, spec §8 teste 12)', () => {
    const cands = [c('A', 1, 60, 60), c('B', 1, 50, 49), c('C', 1, 50, 49)];
    const r = cortar(cands, base(224_100), 224_000, 0);
    expect(r.aceitas.map((x) => x.sku)).toEqual(['A']);
    expect(r.escassezCaixa).toBe(true);
    expect(r.scoreMarginal).toBeCloseTo(1, 9);
  });
  it('base de caixa ausente → estado indeterminado e só o gate econômico corta (nunca inviável sobre saldo 0)', () => {
    const semBase: BaseCaixa = { saldoInicial: 0, inicio: '2026-10-01', dias: 91, fluxos: [], ausencias: ['snapshot'] };
    const r = cortar([c('A', 1, 30_000, 5, { protegida: true }), c('B', 1, 10, 5), c('C', 1, 10, -1)], semBase, 224_000, 0);
    expect(r.estado.tipo).toBe('indeterminado');
    expect(r.aceitas.map((x) => x.sku).sort()).toEqual(['A', 'B']);
    expect(r.cortadas.map((x) => [x.c.sku, x.motivo])).toEqual([['C', 'economico']]);
  });
  it('sem score → cortada como sem_score, nunca aceita', () => {
    const r = cortar([c('A', 1, 10, null, { motivoSemScore: 'historico_insuficiente' })], base(1_000_000), 224_000, 0);
    expect(r.cortadas.map((x) => x.motivo)).toEqual(['sem_score']);
  });
  it('split equivalente: filhos com a mesma raiz dão o mesmo resultado do pedido inteiro (spec §8 teste 4)', () => {
    const inteiro = [c('A', 1, 10, 5), c('B', 1, 10, 4)];
    const splitado = [c('A', 1, 10, 5, { pedidoRaizId: 1 }), c('B', 1, 10, 4, { pedidoRaizId: 1 })];
    const chave = (r: ReturnType<typeof cortar>) => r.aceitas.map((x) => `${x.sku}:${x.k}`).sort();
    expect(chave(cortar(splitado, base(1_000_000), 224_000, 50))).toEqual(chave(cortar(inteiro, base(1_000_000), 224_000, 50)));
  });
  it('mínimo por pedido: completa com a melhor cortada quando cabe e ainda soma ΔV positivo', () => {
    const r = cortar([c('A', 1, 900, 50), c('A', 2, 100, -1)], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas.map((x) => x.k)).toEqual([1, 2]);
  });
  it('mínimo inalcançável e sem protegida → zera o pedido com motivo mínimo', () => {
    const r = cortar([c('A', 1, 900, 50)], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas).toHaveLength(0);
    expect(r.cortadas.map((x) => x.motivo)).toEqual(['minimo']);
  });
  it('mínimo inalcançável com protegida → mantém e sinaliza', () => {
    const r = cortar([c('A', 1, 900, 50, { protegida: true })], base(1_000_000), 224_000, 1_000);
    expect(r.aceitas).toHaveLength(1);
    expect(r.pedidosAbaixoMinimo).toEqual([1]);
  });
});
```

- [ ] **Step 2: Ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/corte.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
// src/lib/reposicao/orcamento-compra/corte.ts
// Corte do orçamento (spec §5.4). Heurística gulosa — NÃO é ótima (caso A/B/C); a saída se chama
// "score marginal da heurística", não preço-sombra.
import type { DataISO } from './datas';
import type { Embalagem } from './embalagens';
import { avaliarEstado, trajetoriaDiaria, type EstadoCaixa, type Fluxo } from './caixa';

export interface Candidata extends Embalagem {
  deltaV: number | null;
  protegida: boolean;
  motivoSemScore: string | null;
}
export type MotivoCorte = 'economico' | 'financeiro' | 'minimo' | 'sem_score';
export interface BaseCaixa { saldoInicial: number; inicio: DataISO; dias: number; fluxos: Fluxo[]; ausencias: string[] }
export interface ResultadoCorte {
  aceitas: Candidata[];
  cortadas: { c: Candidata; motivo: MotivoCorte }[];
  estado: EstadoCaixa;
  scoreMarginal: number | null;
  escassezCaixa: boolean;
  pedidosAbaixoMinimo: number[];
}

const fluxoDe = (c: Candidata): Fluxo => ({ data: c.dataPagamento, valor: -(c.desembolso as number), camada: 'candidato' });
const chaveSku = (c: Candidata) => `${c.pedidoRaizId}|${c.sku}`;

export function cortar(cands: Candidata[], base: BaseCaixa, reserva: number, minimoPedido: number): ResultadoCorte {
  const fluxos: Fluxo[] = [...base.fluxos];
  // Base de caixa com camada ausente: só o gate econômico decide; o estado final sai `indeterminado`
  // (nunca "aceito pelo orçamento" sobre saldo fabricado — spec §6).
  const semCaixa = base.ausencias.length > 0;
  const cabe = (extra: Fluxo[]) =>
    semCaixa ||
    avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, [...fluxos, ...extra]), reserva, []).tipo === 'viavel';

  const aceitas: Candidata[] = [];
  const cortadas: { c: Candidata; motivo: MotivoCorte }[] = [];
  const aceitaKs = new Set<string>();
  const marcar = (c: Candidata) => aceitaKs.add(`${chaveSku(c)}|${c.k}`);
  const temAnterior = (c: Candidata) => c.k === 1 || aceitaKs.has(`${chaveSku(c)}|${c.k - 1}`);

  // 1. protegidas
  for (const c of cands) {
    if (!c.protegida) continue;
    if (c.desembolso == null) { cortadas.push({ c, motivo: 'sem_score' }); continue; }
    aceitas.push(c); marcar(c); fluxos.push(fluxoDe(c));
  }
  const estadoProtegidas = avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, fluxos), reserva, []);
  if (!semCaixa && estadoProtegidas.tipo === 'inviavel') {
    for (const c of cands) if (!c.protegida) cortadas.push({ c, motivo: c.deltaV == null || c.desembolso == null ? 'sem_score' : 'financeiro' });
    return { aceitas, cortadas, estado: estadoProtegidas, scoreMarginal: null, escassezCaixa: true, pedidosAbaixoMinimo: [] };
  }

  // 2. score ajustado não-crescente por SKU (respeita o prefixo)
  const discricionarias = cands.filter((c) => !c.protegida);
  const ajustado = new Map<Candidata, number>();
  const porSku = new Map<string, Candidata[]>();
  for (const c of discricionarias) {
    if (c.deltaV == null || c.desembolso == null || c.desembolso <= 0) continue;
    const k = chaveSku(c);
    if (!porSku.has(k)) porSku.set(k, []);
    porSku.get(k)!.push(c);
  }
  for (const lista of porSku.values()) {
    lista.sort((a, b) => a.k - b.k);
    let teto = Infinity;
    for (const c of lista) {
      teto = Math.min(teto, (c.deltaV as number) / (c.desembolso as number));
      ajustado.set(c, teto);
    }
  }
  for (const c of discricionarias) if (!ajustado.has(c)) cortadas.push({ c, motivo: 'sem_score' });

  const ordem = [...ajustado.keys()].sort(
    (a, b) => ajustado.get(b)! - ajustado.get(a)! || a.sku.localeCompare(b.sku) || a.k - b.k,
  );
  let scoreMarginal: number | null = null;
  for (const c of ordem) {
    const s = ajustado.get(c)!;
    if (s <= 0) { cortadas.push({ c, motivo: 'economico' }); continue; }
    if (!temAnterior(c) || !cabe([fluxoDe(c)])) { cortadas.push({ c, motivo: 'financeiro' }); continue; }
    aceitas.push(c); marcar(c); fluxos.push(fluxoDe(c)); scoreMarginal = s;
  }

  // 3. mínimo por pedido
  const pedidosAbaixoMinimo: number[] = [];
  if (minimoPedido > 0) {
    const raizes = new Set(cands.map((c) => c.pedidoRaizId));
    for (const raiz of raizes) {
      const doPedido = () => aceitas.filter((c) => c.pedidoRaizId === raiz);
      const total = () => doPedido().reduce((s, c) => s + (c.desembolso as number), 0);
      if (total() === 0 || total() >= minimoPedido) continue;
      const candidatasAoMinimo = cortadas
        .filter((x) => x.c.pedidoRaizId === raiz && x.motivo !== 'sem_score' && ajustado.has(x.c))
        .sort((a, b) => ajustado.get(b.c)! - ajustado.get(a.c)! || a.c.k - b.c.k);
      const adicionadas: Candidata[] = [];
      for (const x of candidatasAoMinimo) {
        if (total() >= minimoPedido) break;
        if (!temAnterior(x.c) || !cabe([fluxoDe(x.c)])) continue;
        aceitas.push(x.c); marcar(x.c); fluxos.push(fluxoDe(x.c)); adicionadas.push(x.c);
      }
      const somaDeltaV = doPedido().reduce((s, c) => s + (c.deltaV ?? 0), 0);
      const temProtegida = doPedido().some((c) => c.protegida);
      if (total() >= minimoPedido && (somaDeltaV > 0 || temProtegida)) {
        for (const a of adicionadas) cortadas.splice(cortadas.findIndex((x) => x.c === a), 1);
        continue;
      }
      if (temProtegida) {
        for (const a of adicionadas) cortadas.splice(cortadas.findIndex((x) => x.c === a), 1);
        pedidosAbaixoMinimo.push(raiz);
        continue;
      }
      // zera o pedido: tira do aceito e dos fluxos
      for (const c of doPedido()) {
        aceitas.splice(aceitas.indexOf(c), 1);
        const iFluxo = fluxos.findIndex((f) => f.camada === 'candidato' && f.data === c.dataPagamento && f.valor === -(c.desembolso as number));
        fluxos.splice(iFluxo, 1);
        const jaCortada = cortadas.findIndex((x) => x.c === c);
        if (jaCortada >= 0) cortadas[jaCortada] = { c, motivo: 'minimo' };
        else cortadas.push({ c, motivo: 'minimo' });
      }
    }
  }

  const estado = avaliarEstado(trajetoriaDiaria(base.saldoInicial, base.inicio, base.dias, fluxos), reserva, base.ausencias);
  return {
    aceitas,
    cortadas,
    estado,
    scoreMarginal,
    escassezCaixa: cortadas.some((x) => x.motivo === 'financeiro'),
    pedidosAbaixoMinimo,
  };
}
```

> No ramo "zera o pedido", as embalagens que já estavam em `cortadas` (motivo `economico`/`financeiro`) passam a `minimo` porque o pedido inteiro saiu.

- [ ] **Step 4: Ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/corte.test.ts`
Expected: PASS (11 testes). No caso A/B/C: saldo 224.100, reserva 224.000 → folga 100; A (60) cabe; B (50) não (sobra 40) → `financeiro`; `scoreMarginal` = 1.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/corte.ts src/lib/reposicao/orcamento-compra/corte.test.ts
git commit -m "feat(reposicao): orçamento de compra — corte guloso com prefixo, protegidos, inviabilidade e mínimo por pedido [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Replay contrafactual e medição

**Files:**
- Create: `src/lib/reposicao/orcamento-compra/replay.ts`
- Create: `src/lib/reposicao/orcamento-compra/medicao.ts`
- Test: `src/lib/reposicao/orcamento-compra/replay.test.ts`

**Interfaces:**
- Consumes: `SerieDiaria` (Task 2), `DataISO`/`diffDias` (Task 1).
- Produces (`replay.ts`):
  - `interface EntradaReplay { estoqueInicial: number; demanda: (number | null)[]; recebimentos: { dia: number; qtde: number }[]; removido: { dia: number; qtde: number } | null; politica: { pontoPedido: number; leadTimeDias: number } | null }`
  - `interface SaidaReplay { rompeu: boolean; primeiroDiaRuptura: number | null; unidadesPerdidas: number; indeterminado: boolean; estoqueMedio: number; reposicaoPropria: boolean }`
  - `replaySku(e: EntradaReplay): SaidaReplay`
  - `type ClasseCorte = 'teria_rompido' | 'adiado' | 'eliminado' | 'indeterminado'`
  - `classificarCorte(com: SaidaReplay, sem: SaidaReplay): ClasseCorte`
- Produces (`medicao.ts`):
  - `interface Episodio { sku: string; inicio: DataISO; fim: DataISO; valor: number }`
  - `deduplicarEpisodios(cortes: { sku: string; data: DataISO; valor: number }[], gapDias: number): Episodio[]`
  - `precisaoDoCorte(itens: { classe: ClasseCorte; valor: number }[]): { precisao: number | null; valorCortado: number; n: number; indeterminados: number }`
  - `deltaDio(estoqueMedioCustoCom: number, estoqueMedioCustoSem: number, cmvDiario: number | null): number | null`

- [ ] **Step 1: Teste que falha**

```ts
// src/lib/reposicao/orcamento-compra/replay.test.ts
import { describe, expect, it } from 'vitest';
import { classificarCorte, replaySku } from './replay';
import { deduplicarEpisodios, deltaDio, precisaoDoCorte } from './medicao';

describe('replay contrafactual (spec §8 teste 11)', () => {
  it('compra que evitou a ruptura: saldo mínimo 4 com a compra; sem os 12 cortados rompe', () => {
    const entrada = { estoqueInicial: 0, demanda: [4, 4, 4, 4], recebimentos: [{ dia: 0, qtde: 20 }], politica: null };
    const com = replaySku({ ...entrada, removido: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 12 } });
    expect(com.rompeu).toBe(false);
    expect(sem.rompeu).toBe(true);
    expect(sem.primeiroDiaRuptura).toBe(2);
    expect(classificarCorte(com, sem)).toBe('teria_rompido');
  });
  it('com política própria o corte é recomprado a tempo → adiado', () => {
    const entrada = { estoqueInicial: 10, demanda: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], recebimentos: [{ dia: 0, qtde: 5 }], politica: { pontoPedido: 6, leadTimeDias: 2 } };
    const com = replaySku({ ...entrada, removido: null, politica: null });
    const sem = replaySku({ ...entrada, removido: { dia: 0, qtde: 5 } });
    expect(sem.reposicaoPropria).toBe(true);
    expect(classificarCorte(com, sem)).toBe('adiado');
  });
  it('sobra sem recompra e sem ruptura → eliminado', () => {
    const entrada = { estoqueInicial: 50, demanda: [1, 1, 1], recebimentos: [{ dia: 0, qtde: 5 }], politica: null };
    expect(classificarCorte(replaySku({ ...entrada, removido: null }), replaySku({ ...entrada, removido: { dia: 0, qtde: 5 } }))).toBe('eliminado');
  });
  it('dia censurado no período → indeterminado', () => {
    const entrada = { estoqueInicial: 5, demanda: [1, null, 1], recebimentos: [], politica: null };
    expect(classificarCorte(replaySku({ ...entrada, removido: null }), replaySku({ ...entrada, removido: null }))).toBe('indeterminado');
  });
});

describe('medição', () => {
  it('mesma necessidade em ciclos seguidos conta 1 episódio (valor máximo, não soma)', () => {
    const e = deduplicarEpisodios(
      [
        { sku: 'A', data: '2026-10-01', valor: 100 },
        { sku: 'A', data: '2026-10-02', valor: 120 },
        { sku: 'A', data: '2026-10-20', valor: 50 },
        { sku: 'B', data: '2026-10-02', valor: 10 },
      ],
      7,
    );
    expect(e).toEqual([
      { sku: 'A', inicio: '2026-10-01', fim: '2026-10-02', valor: 120 },
      { sku: 'A', inicio: '2026-10-20', fim: '2026-10-20', valor: 50 },
      { sku: 'B', inicio: '2026-10-02', fim: '2026-10-02', valor: 10 },
    ]);
  });
  it('precisão = R$ sem ruptura / R$ cortado, indeterminados fora do denominador', () => {
    const r = precisaoDoCorte([
      { classe: 'eliminado', valor: 60 }, { classe: 'adiado', valor: 20 }, { classe: 'teria_rompido', valor: 20 }, { classe: 'indeterminado', valor: 999 },
    ]);
    expect(r).toEqual({ precisao: 0.8, valorCortado: 100, n: 3, indeterminados: 1 });
  });
  it('zero corte → precisão não aplicável (null), nunca 100%', () => {
    expect(precisaoDoCorte([]).precisao).toBeNull();
  });
  it('ΔDIO = Δ estoque médio a custo / CMV diário; CMV ausente → null', () => {
    expect(deltaDio(600, 500, 10)).toBe(10);
    expect(deltaDio(600, 500, null)).toBeNull();
    expect(deltaDio(600, 500, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Ver falhar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/replay.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar `replay.ts`**

```ts
// src/lib/reposicao/orcamento-compra/replay.ts
// Estoque contrafactual sem as embalagens cortadas (spec §7). Venda perdida não vira backlog.
export interface EntradaReplay {
  estoqueInicial: number;
  /** demanda real por dia a partir da decisão; null = dia censurado (falta real) */
  demanda: (number | null)[];
  recebimentos: { dia: number; qtde: number }[];
  removido: { dia: number; qtde: number } | null;
  /** quando presente, o replay recompra a qtde removida ao cruzar o ponto de pedido */
  politica: { pontoPedido: number; leadTimeDias: number } | null;
}
export interface SaidaReplay {
  rompeu: boolean;
  primeiroDiaRuptura: number | null;
  unidadesPerdidas: number;
  indeterminado: boolean;
  estoqueMedio: number;
  reposicaoPropria: boolean;
}
export type ClasseCorte = 'teria_rompido' | 'adiado' | 'eliminado' | 'indeterminado';

export function replaySku(e: EntradaReplay): SaidaReplay {
  let estoque = e.estoqueInicial;
  let perdidas = 0;
  let primeiro: number | null = null;
  let indeterminado = false;
  let somaEstoque = 0;
  let chegadaPropria: number | null = null;
  let reposicaoPropria = false;
  for (let t = 0; t < e.demanda.length; t++) {
    for (const r of e.recebimentos) if (r.dia === t) estoque += r.qtde;
    if (e.removido && e.removido.dia === t) estoque -= e.removido.qtde;
    if (chegadaPropria === t && e.removido) { estoque += e.removido.qtde; chegadaPropria = null; }
    const d = e.demanda[t];
    if (d === null) indeterminado = true;
    else if (estoque >= d) estoque -= d;
    else {
      perdidas += d - Math.max(estoque, 0);
      estoque = 0;
      if (primeiro === null) primeiro = t;
    }
    if (e.politica && e.removido && !reposicaoPropria && t >= e.removido.dia && estoque <= e.politica.pontoPedido) {
      chegadaPropria = t + e.politica.leadTimeDias;
      reposicaoPropria = true;
    }
    somaEstoque += estoque;
  }
  return {
    rompeu: perdidas > 0,
    primeiroDiaRuptura: primeiro,
    unidadesPerdidas: perdidas,
    indeterminado,
    estoqueMedio: e.demanda.length ? somaEstoque / e.demanda.length : 0,
    reposicaoPropria,
  };
}

export function classificarCorte(com: SaidaReplay, sem: SaidaReplay): ClasseCorte {
  if (com.indeterminado || sem.indeterminado) return 'indeterminado';
  if (sem.unidadesPerdidas > com.unidadesPerdidas) return 'teria_rompido';
  return sem.reposicaoPropria ? 'adiado' : 'eliminado';
}
```

Conta do teste 1 (à mão): com: 20→16→12→8→4 (mín 4, sem ruptura); sem: 8→4→0→ dia 2 tinha 0 após vender? Dia 0: 0+20−12=8 −4=4; dia 1: 4−4=0; dia 2: 0<4 → perde 4, primeiro=2. ✔︎
Teste 2: sem: 10+5−5=10 −1 = 9 … dia 3 fica 6 ≤ PP 6 → pede, chega dia 5 (+5); nunca rompe; com (sem política) também não → `adiado`. ✔︎

- [ ] **Step 4: Implementar `medicao.ts`**

```ts
// src/lib/reposicao/orcamento-compra/medicao.ts
import { diffDias, type DataISO } from './datas';
import type { ClasseCorte } from './replay';

export interface Episodio { sku: string; inicio: DataISO; fim: DataISO; valor: number }

export function deduplicarEpisodios(cortes: { sku: string; data: DataISO; valor: number }[], gapDias: number): Episodio[] {
  const ordenados = [...cortes].sort((a, b) => a.sku.localeCompare(b.sku) || a.data.localeCompare(b.data));
  const out: Episodio[] = [];
  for (const c of ordenados) {
    const ult = out[out.length - 1];
    if (ult && ult.sku === c.sku && diffDias(ult.fim, c.data) <= gapDias) {
      ult.fim = c.data;
      ult.valor = Math.max(ult.valor, c.valor);
    } else out.push({ sku: c.sku, inicio: c.data, fim: c.data, valor: c.valor });
  }
  return out;
}

export function precisaoDoCorte(itens: { classe: ClasseCorte; valor: number }[]) {
  const validos = itens.filter((i) => i.classe !== 'indeterminado');
  const valorCortado = validos.reduce((s, i) => s + i.valor, 0);
  const seguro = validos.filter((i) => i.classe !== 'teria_rompido').reduce((s, i) => s + i.valor, 0);
  return {
    precisao: valorCortado > 0 ? seguro / valorCortado : null,
    valorCortado,
    n: validos.length,
    indeterminados: itens.length - validos.length,
  };
}

export function deltaDio(estoqueMedioCustoCom: number, estoqueMedioCustoSem: number, cmvDiario: number | null): number | null {
  if (cmvDiario == null || !(cmvDiario > 0)) return null;
  return (estoqueMedioCustoCom - estoqueMedioCustoSem) / cmvDiario;
}
```

- [ ] **Step 5: Ver passar**

Run: `bun run test -- src/lib/reposicao/orcamento-compra/replay.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reposicao/orcamento-compra/replay.ts src/lib/reposicao/orcamento-compra/medicao.ts src/lib/reposicao/orcamento-compra/replay.test.ts
git commit -m "feat(reposicao): orçamento de compra — replay contrafactual, classificação do corte e medição deduplicada [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Fatos SQL + script de simulação

**Files:**
- Create: `docs/superpowers/orcamento-compra/fatos.sql`
- Create: `scripts/orcamento-compra/simular.ts`
- Test: `scripts/orcamento-compra/simular.test.ts`
- Create: `docs/superpowers/orcamento-compra/.gitignore` (conteúdo: `saida/`)

**Interfaces:**
- Consumes: tudo das Tasks 1–6.
- Produces:
  - `extrairJson(raw: string): unknown` — exige `fim|ok`, reprova `ERROR`, lê a linha `json|…`
  - `preVoo(f: Fatos): string[]` — lista de falhas (vazia = ok)
  - `montarCiclo(f: Fatos, cicloId: number, cfg: Config): { cands: Candidata[]; base: BaseCaixa; linhas: LinhaMotor[] }`
  - `simularCiclo(f: Fatos, cicloId: number, cfg: Config): ResultadoCiclo`
  - `interface Config { reservaDias: number; fretePerc: number; minimoPedido: number; minOcorrencias: number; intervaloOportunidadeDias: number; horizonteDias: number; horizontePromoDias: number }`
  - CLI: `bun scripts/orcamento-compra/simular.ts --banco docs/superpowers/orcamento-compra/saida` e `bun scripts/orcamento-compra/simular.ts <fatos.json> <dir-saida>`

- [ ] **Step 1: Escrever `fatos.sql`**

Uma única linha `json|<objeto>` + marcador. Janela de ciclos: 90 dias; série de demanda: 270 dias (180 de histórico antes do 1º ciclo + 90).

```sql
-- docs/superpowers/orcamento-compra/fatos.sql — READ-ONLY. Uso:
--   ~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f docs/superpowers/orcamento-compra/fatos.sql
\set QUIET on
with
ciclos as (
  select p.id, p.status, p.data_ciclo, p.horario_geracao, p.horario_disparo_real, p.valor_total, p.omie_pedido_compra_id
  from pedido_compra_sugerido p
  where p.empresa = 'OBEN' and p.fornecedor_nome ilike '%sayerlack%'
    and p.split_parent_id is null and p.data_ciclo >= current_date - 90
),
linhas as (
  select coalesce(ps.split_parent_id, ps.id) as raiz, i.pedido_id, i.sku_codigo_omie, coalesce(i.qtde_final, i.qtde_sugerida) as qtde,
         i.fator_embalagem_portal, i.preco_unitario, i.estoque_atual, i.estoque_fisico, i.ponto_pedido,
         i.modo_promocao, i.preco_sem_desconto
  from pedido_compra_item i join pedido_compra_sugerido ps on ps.id = i.pedido_id
  where coalesce(ps.split_parent_id, ps.id) in (select id from ciclos)
),
skus as (select distinct sku_codigo_omie from linhas),
demanda as (
  select d.sku_codigo_omie::text as sku, d.data_emissao as data, sum(d.quantidade) as qtde
  from v_sku_demanda_efetiva d
  where upper(d.empresa) = 'OBEN' and d.sku_codigo_omie::text in (select sku_codigo_omie from skus)
    and d.data_emissao >= current_date - 270
  group by 1, 2
),
receb as (
  select ri.produto_omie_id::text as sku, r.efetivado_at::date as data, sum(ri.quantidade_convertida) as qtde
  from nfe_recebimento_itens ri join nfe_recebimentos r on r.id = ri.nfe_recebimento_id
  where r.efetivado_at is not null and r.efetivado_at >= current_date - 270
    and ri.produto_omie_id::text in (select sku_codigo_omie from skus)
  group by 1, 2
),
estoque as (
  select sku_codigo_omie as sku, estoque_fisico from sku_estoque_atual
  where upper(empresa) = 'OBEN' and sku_codigo_omie in (select sku_codigo_omie from skus)
),
params as (
  select sku_codigo_omie::text as sku, preco_venda_medio, demanda_media_diaria, demanda_sigma_diario
  from v_sku_parametros_sugeridos
  where upper(empresa) = 'OBEN' and sku_codigo_omie::text in (select sku_codigo_omie from skus)
),
snaps as (
  select distinct on ((snapshot_at at time zone 'America/Sao_Paulo')::date)
    (snapshot_at at time zone 'America/Sao_Paulo')::date as dia, snapshot_at, saldo_tesouraria, dados
  from fin_projecao_snapshots
  where company = 'oben' and cenario = 'pessimista' and snapshot_at >= current_date - 95
  order by (snapshot_at at time zone 'America/Sao_Paulo')::date, snapshot_at desc
),
disparados as (
  select p.id, p.valor_total, coalesce(p.horario_disparo_real, p.horario_geracao) as momento,
         array_remove(array_agg(distinct t.nfe_numero::text), null) as nfs
  from pedido_compra_sugerido p
  left join purchase_orders_tracking t on t.omie_codigo_pedido::text = p.omie_pedido_compra_id
  where p.empresa = 'OBEN' and p.status = 'disparado' and p.data_ciclo >= current_date - 120
  group by 1, 2, 3
),
titulos_say as (
  select id::text as id, numero_documento_fiscal as nf, valor_documento as valor, created_at
  from fin_contas_pagar
  where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266
    and status_titulo <> 'CANCELADO' and data_emissao >= current_date - 150
),
pagos_nao_say as (
  select b.data_baixa_final as data, sum(b.valor_baixado) as valor
  from v_titulo_baixas b join fin_contas_pagar p on p.company = b.company and p.omie_codigo_lancamento = b.omie_codigo_lancamento
  where b.company = 'oben' and b.tipo = 'CP' and p.omie_codigo_cliente_fornecedor is distinct from 8689681266
    and b.data_baixa_final >= current_date - 300
  group by 1
),
lags as (
  select
    (select percentile_disc(0.1) within group (order by t2_data_faturamento::date - t1_data_pedido::date)
       from purchase_orders_tracking where fornecedor_codigo_omie = 8689681266 and t1_data_pedido >= current_date - 180 and t2_data_faturamento is not null) as faturamento_p10,
    (select percentile_disc(0.1) within group (order by data_vencimento - data_emissao)
       from fin_contas_pagar where company = 'oben' and omie_codigo_cliente_fornecedor = 8689681266 and data_emissao >= current_date - 180) as vencimento_p10,
    (select percentile_disc(0.5) within group (order by t4_data_recebimento::date - t1_data_pedido::date)
       from purchase_orders_tracking where fornecedor_codigo_omie = 8689681266 and t1_data_pedido >= current_date - 180 and t4_data_recebimento is not null) as chegada_p50
),
custo as (
  select (selic_anual + spread_oportunidade + armazenagem_fisica) / 100.0 as cm_anual
  from empresa_configuracao_custos where upper(empresa) = 'OBEN'
)
select 'json|' || json_build_object(
  'meta', json_build_object('gerado_em', now(), 'hoje', (now() at time zone 'America/Sao_Paulo')::date),
  'ciclos', (select coalesce(json_agg(c order by c.id), '[]') from ciclos c),
  'linhas', (select coalesce(json_agg(l order by l.raiz, l.pedido_id, l.sku_codigo_omie), '[]') from linhas l),
  'demanda', (select coalesce(json_agg(d order by d.sku, d.data), '[]') from demanda d),
  'recebimentos', (select coalesce(json_agg(r order by r.sku, r.data), '[]') from receb r),
  'estoque', (select coalesce(json_agg(e order by e.sku), '[]') from estoque e),
  'params', (select coalesce(json_agg(p order by p.sku), '[]') from params p),
  'snapshots', (select coalesce(json_agg(s order by s.dia), '[]') from snaps s),
  'disparados', (select coalesce(json_agg(x order by x.id), '[]') from disparados x),
  'titulos_sayerlack', (select coalesce(json_agg(t order by t.id), '[]') from titulos_say t),
  'pagos_nao_sayerlack', (select coalesce(json_agg(g order by g.data), '[]') from pagos_nao_say g),
  'lags', (select row_to_json(l) from lags l),
  'cm_anual', (select cm_anual from custo)
)::text;
select 'fim', 'ok';
```

- [ ] **Step 2: Rodar o SQL e conferir que termina**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
mkdir -p docs/superpowers/orcamento-compra/saida
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -f docs/superpowers/orcamento-compra/fatos.sql > docs/superpowers/orcamento-compra/saida/raw.txt 2>&1; rc=$?
tail -c 300 docs/superpowers/orcamento-compra/saida/raw.txt; echo; [ "$rc" -eq 0 ] && grep -c '^fim|ok$' docs/superpowers/orcamento-compra/saida/raw.txt
```
Expected: `1` (marcador presente) e rc 0. Se faltar coluna/permissão, corrija o SQL (nunca afrouxe o `ON_ERROR_STOP`). Contagens a conferir à mão com `jq` (arquivo grande — **não** imprima tudo): `ciclos` ≈ 390 (spec §2: 117 disparados + 263 expirados + …), `snapshots` ≥ 80, `params`/`estoque` não vazios (se vazio, o case de `empresa` está errado — ajuste o `upper()`).

- [ ] **Step 3: Teste que falha do script**

```ts
// scripts/orcamento-compra/simular.test.ts
import { describe, expect, it } from 'vitest';
import { extrairJson, preVoo, simularCiclo, type Config, type Fatos } from './simular';

const cfg: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

const fatos: Fatos = {
  meta: { gerado_em: '2026-10-15T12:00:00Z', hoje: '2026-10-15' },
  ciclos: [{ id: 1, status: 'disparado', data_ciclo: '2026-10-01', horario_geracao: '2026-10-01T12:00:00Z', horario_disparo_real: null, valor_total: 40, omie_pedido_compra_id: null }],
  linhas: [{ raiz: 1, pedido_id: 1, sku_codigo_omie: '9', qtde: 4, fator_embalagem_portal: null, preco_unitario: 10, estoque_atual: 0, estoque_fisico: 0, ponto_pedido: 2, modo_promocao: null, preco_sem_desconto: null }],
  demanda: Array.from({ length: 200 }, (_, i) => ({ sku: '9', data: new Date(Date.UTC(2026, 3, 1 + i)).toISOString().slice(0, 10), qtde: 1 })),
  recebimentos: [],
  estoque: [{ sku: '9', estoque_fisico: 50 }],
  params: [{ sku: '9', preco_venda_medio: 15, demanda_media_diaria: 1, demanda_sigma_diario: 0.5 }],
  snapshots: [{ dia: '2026-10-01', snapshot_at: '2026-10-01T10:00:00Z', saldo_tesouraria: 646_000, dados: [] }],
  disparados: [],
  titulos_sayerlack: [],
  pagos_nao_sayerlack: [{ data: '2026-09-05', valor: 1_000 }],
  lags: { faturamento_p10: 2, vencimento_p10: 1, chegada_p50: 14 },
  cm_anual: 0.15,
};

describe('extrairJson', () => {
  it('exige o marcador fim|ok', () => {
    expect(() => extrairJson('json|{}\n')).toThrow('sem marcador fim|ok');
  });
  it('reprova ERROR mesmo com marcador', () => {
    expect(() => extrairJson('psql:x: ERROR:  boom\nfim|ok\n')).toThrow('psql devolveu ERROR');
  });
  it('lê a linha json|', () => {
    expect(extrairJson('json|{"a":1}\nfim|ok\n')).toEqual({ a: 1 });
  });
});

describe('preVoo', () => {
  it('ok com fatos completos', () => {
    expect(preVoo(fatos)).toEqual([]);
  });
  it('nomeia o que falta (nunca segue com vazio)', () => {
    expect(preVoo({ ...fatos, params: [], snapshots: [], cm_anual: null })).toEqual([
      'params vazio — conferir case de empresa',
      'snapshots vazio — sem base de caixa',
      'cm_anual ausente — sem custo de capital',
    ]);
  });
});

describe('simularCiclo', () => {
  it('dia sem snapshot → estado indeterminado nomeando a camada (Review Focus 3)', () => {
    const r = simularCiclo({ ...fatos, snapshots: [] }, 1, cfg);
    expect(r.estado.tipo).toBe('indeterminado');
    expect(r.estado.tipo === 'indeterminado' && r.estado.camadas).toContain('snapshot');
  });
  it('estoque reconstruído ancora em HOJE, não no fim da janela histórica', () => {
    // estoque de hoje 50, 1/dia de demanda: no ciclo (14 dias antes de hoje) o estoque era > 50, nunca censurado
    const r = simularCiclo(fatos, 1, cfg);
    expect(r.semScore).toEqual([]);
  });
  it('ciclo simples: devolve aceitas+cortadas cobrindo todas as embalagens do motor', () => {
    const r = simularCiclo(fatos, 1, cfg);
    expect(r.valorMotor).toBeCloseTo(4 * 10 * 1.025, 9);
    expect(r.aceitas + r.cortadas).toBe(4);
  });
});
```

Run: `bun run test -- scripts/orcamento-compra/simular.test.ts` → Expected: FAIL (módulo inexistente).

- [ ] **Step 4: Implementar `simular.ts`**

```ts
// scripts/orcamento-compra/simular.ts
// Backtest do orçamento de compra (spec docs/superpowers/specs/2026-10-15-orcamento-compra-design.md).
// Uso: bun scripts/orcamento-compra/simular.ts --banco <dir-saida>
//      bun scripts/orcamento-compra/simular.ts <fatos.json> <dir-saida>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { addDias, diffDias, ehDiaUtil, type DataISO } from '@/lib/reposicao/orcamento-compra/datas';
import { dataPagamentoPrevista, quebrarEmEmbalagens, type LinhaMotor } from '@/lib/reposicao/orcamento-compra/embalagens';
import { amostrasEmpiricas, amostrasGaussianas, historicoSuficiente, marcarCensura, reconstruirEstoque, type SerieDiaria } from '@/lib/reposicao/orcamento-compra/demanda';
import { quantidadeProtegida, valorDasEmbalagens } from '@/lib/reposicao/orcamento-compra/valor';
import { fluxosDeSemanaAgregada, type EstadoCaixa, type Fluxo } from '@/lib/reposicao/orcamento-compra/caixa';
import { conciliarCompromissos, projetarRitmo, provisaoContinuidade, ritmoPorDiaDoMes } from '@/lib/reposicao/orcamento-compra/camadas';
import { cortar, type BaseCaixa, type Candidata, type ResultadoCorte } from '@/lib/reposicao/orcamento-compra/corte';
import { classificarCorte, replaySku, type ClasseCorte } from '@/lib/reposicao/orcamento-compra/replay';
import { deduplicarEpisodios, precisaoDoCorte } from '@/lib/reposicao/orcamento-compra/medicao';

export interface Config {
  reservaDias: number; fretePerc: number; minimoPedido: number; minOcorrencias: number;
  intervaloOportunidadeDias: number; horizonteDias: number; horizontePromoDias: number;
}
export const CONFIG_PADRAO: Config = {
  reservaDias: 30, fretePerc: 0.025, minimoPedido: 0, minOcorrencias: 3,
  intervaloOportunidadeDias: 1, horizonteDias: 91, horizontePromoDias: 90,
};

type Num = number | null;
export interface Fatos {
  meta: { gerado_em: string; hoje: DataISO };
  ciclos: { id: number; status: string; data_ciclo: DataISO; horario_geracao: string; horario_disparo_real: string | null; valor_total: Num; omie_pedido_compra_id: string | null }[];
  linhas: { raiz: number; pedido_id: number; sku_codigo_omie: string; qtde: Num; fator_embalagem_portal: Num; preco_unitario: Num; estoque_atual: Num; estoque_fisico: Num; ponto_pedido: Num; modo_promocao: string | null; preco_sem_desconto: Num }[];
  demanda: { sku: string; data: DataISO; qtde: number }[];
  recebimentos: { sku: string; data: DataISO; qtde: number }[];
  estoque: { sku: string; estoque_fisico: Num }[];
  params: { sku: string; preco_venda_medio: Num; demanda_media_diaria: Num; demanda_sigma_diario: Num }[];
  snapshots: { dia: DataISO; snapshot_at: string; saldo_tesouraria: Num; dados: { inicio: DataISO; fim: DataISO; total_entradas?: number; saidas?: { data: DataISO; valor: number; id_origem?: string }[]; entradas?: { data?: DataISO; valor: number }[] }[] }[];
  disparados: { id: number; valor_total: number; momento: string; nfs: string[] }[];
  titulos_sayerlack: { id: string; nf: string | null; valor: number; created_at: string }[];
  pagos_nao_sayerlack: { data: DataISO; valor: number }[];
  lags: { faturamento_p10: Num; vencimento_p10: Num; chegada_p50: Num };
  cm_anual: Num;
}

export interface ResultadoCiclo {
  cicloId: number; data: DataISO; status: string;
  valorMotor: number; valorAceito: number; aceitas: number; cortadas: number;
  cortesPorMotivo: Record<string, number>;
  estado: EstadoCaixa; scoreMarginal: number | null; escassezCaixa: boolean;
  semScore: { sku: string; motivo: string }[];
  sensiveisAoModelo: number;
  cortesDetalhe: { sku: string; k: number; valor: number; motivo: string; classe: ClasseCorte | null }[];
}

export function extrairJson(raw: string): unknown {
  if (/^ERROR:|^psql:.*ERROR/m.test(raw)) throw new Error('psql devolveu ERROR: ' + raw.slice(0, 500));
  if (!/^fim\|ok$/m.test(raw)) throw new Error('sem marcador fim|ok na saída do psql');
  const linha = raw.split('\n').find((l) => l.startsWith('json|'));
  if (!linha) throw new Error('sem linha json| na saída do psql');
  return JSON.parse(linha.slice(5));
}

export function preVoo(f: Fatos): string[] {
  const falhas: string[] = [];
  if (!f.ciclos.length) falhas.push('ciclos vazio — consulta suspeita');
  if (!f.linhas.length) falhas.push('linhas vazio — consulta suspeita');
  if (!f.params.length) falhas.push('params vazio — conferir case de empresa');
  if (!f.snapshots.length) falhas.push('snapshots vazio — sem base de caixa');
  if (f.lags.faturamento_p10 == null || f.lags.vencimento_p10 == null || f.lags.chegada_p50 == null) falhas.push('lags ausentes — sem datação de pagamento/chegada');
  if (f.cm_anual == null) falhas.push('cm_anual ausente — sem custo de capital');
  return falhas;
}

/** Série diária de demanda do SKU entre [de, ate], com censura pelos dias de estoque reconstruído ≤ 0. */
// A reconstrução ancora no estoque de HOJE: monta [de, hoje], reconstrói para trás e só então recorta até `ate`.
function serieDoSku(f: Fatos, sku: string, de: DataISO, ate: DataISO): { serie: SerieDiaria; estoqueFim: number[] } {
  const hoje = f.meta.hoje;
  const nTotal = diffDias(de, hoje) + 1;
  const n = diffDias(de, ate) + 1;
  const dem = new Array<number>(nTotal).fill(0);
  const rec = new Array<number>(nTotal).fill(0);
  for (const d of f.demanda) if (d.sku === sku && d.data >= de && d.data <= hoje) dem[diffDias(de, d.data)] += Number(d.qtde);
  for (const r of f.recebimentos) if (r.sku === sku && r.data >= de && r.data <= hoje) rec[diffDias(de, r.data)] += Number(r.qtde);
  const atual = f.estoque.find((e) => e.sku === sku)?.estoque_fisico;
  if (atual == null) return { serie: new Array(n).fill(null), estoqueFim: new Array(n).fill(0) };
  const estoqueFim = reconstruirEstoque(atual, dem, rec);
  return { serie: marcarCensura(dem, estoqueFim).slice(0, n), estoqueFim: estoqueFim.slice(0, n) };
}

function baseDeCaixa(f: Fatos, data: DataISO, momento: string, cfg: Config, reserva: number): BaseCaixa {
  const ausencias: string[] = [];
  const snap = [...f.snapshots].filter((s) => s.dia <= data).sort((a, b) => b.dia.localeCompare(a.dia))[0];
  if (!snap || diffDias(snap.dia, data) > 1 || snap.saldo_tesouraria == null) {
    ausencias.push('snapshot');
    return { saldoInicial: 0, inicio: data, dias: cfg.horizonteDias, fluxos: [], ausencias };
  }
  const fluxos: Fluxo[] = [];
  const idsSay = new Set(f.titulos_sayerlack.map((t) => t.id));
  const tituladoNaoSayPorMes: Record<string, number> = {};
  for (const sem of snap.dados) {
    for (const s of sem.saidas ?? []) {
      fluxos.push({ data: s.data, valor: -s.valor, camada: 'base_titulos' });
      if (!s.id_origem || !idsSay.has(s.id_origem)) tituladoNaoSayPorMes[s.data.slice(0, 7)] = (tituladoNaoSayPorMes[s.data.slice(0, 7)] ?? 0) + s.valor;
    }
    const entradas = sem.entradas ?? [];
    if (entradas.every((e) => e.data)) for (const e of entradas) fluxos.push({ data: e.data as DataISO, valor: e.valor, camada: 'base_titulos' });
    else fluxos.push(...fluxosDeSemanaAgregada(sem.inicio, sem.fim, sem.total_entradas ?? 0, 0).filter((x) => x.valor !== 0));
  }
  const lag = (f.lags.faturamento_p10 ?? 0) + (f.lags.vencimento_p10 ?? 0);
  const anteriores = f.disparados.filter((p) => p.momento < momento && p.momento.slice(0, 10) >= addDias(data, -60));
  const titulosAteSnap = f.titulos_sayerlack.filter((t) => t.created_at <= snap.snapshot_at && t.nf);
  const conc = conciliarCompromissos(
    anteriores.map((p) => ({ pedidoId: p.id, valorTotal: Number(p.valor_total), dataPedido: p.momento.slice(0, 10), nfs: p.nfs ?? [] })),
    titulosAteSnap.map((t) => ({ nf: t.nf as string, valor: Number(t.valor) })),
    data, lag,
  );
  fluxos.push(...conc.fluxos);
  if (conc.naoConciliado > 0.1 * reserva) ausencias.push('compromisso_nao_conciliado');
  const pagos = f.pagos_nao_sayerlack.filter((p) => p.data < data && p.data >= addDias(data, -180));
  fluxos.push(...projetarRitmo(data, cfg.horizonteDias, ritmoPorDiaDoMes(pagos, 6), tituladoNaoSayPorMes));
  return { saldoInicial: Number(snap.saldo_tesouraria), inicio: data, dias: cfg.horizonteDias, fluxos, ausencias };
}

function mediaCompraPorDiaUtil(f: Fatos, data: DataISO): number {
  const de = addDias(data, -90);
  const total = f.disparados.filter((p) => p.momento.slice(0, 10) >= de && p.momento.slice(0, 10) < data).reduce((s, p) => s + Number(p.valor_total), 0);
  let uteis = 0;
  for (let i = 0; i < 90; i++) if (ehDiaUtil(addDias(de, i))) uteis++;
  return uteis ? total / uteis : 0;
}

export function reservaDe(f: Fatos, data: DataISO, dias: number): number {
  const pagos = f.pagos_nao_sayerlack.filter((p) => p.data < data && p.data >= addDias(data, -180));
  const say = f.titulos_sayerlack.filter((t) => t.created_at.slice(0, 10) < data && t.created_at.slice(0, 10) >= addDias(data, -180));
  const total = pagos.reduce((s, p) => s + Number(p.valor), 0) + say.reduce((s, t) => s + Number(t.valor), 0);
  return (total / 180) * dias;
}

export function simularCiclo(f: Fatos, cicloId: number, cfg: Config): ResultadoCiclo {
  const ciclo = f.ciclos.find((c) => c.id === cicloId)!;
  const data = ciclo.data_ciclo;
  const reserva = reservaDe(f, data, cfg.reservaDias);
  const lags = { faturamentoP10: f.lags.faturamento_p10 ?? 0, vencimentoP10: f.lags.vencimento_p10 ?? 0 };
  const L = f.lags.chegada_p50 ?? 14;
  const T = L + cfg.intervaloOportunidadeDias;
  const dataPagamento = dataPagamentoPrevista(data, lags);
  const hDia = (f.cm_anual ?? 0) / 365;
  const cands: Candidata[] = [];
  const semScore: { sku: string; motivo: string }[] = [];
  let sensiveis = 0;
  for (const l of f.linhas.filter((x) => x.raiz === cicloId)) {
    const p = f.params.find((x) => x.sku === l.sku_codigo_omie);
    const linha: LinhaMotor = {
      pedidoId: l.pedido_id, pedidoRaizId: l.raiz, sku: l.sku_codigo_omie, qtdeFinal: Number(l.qtde ?? 0),
      fatorEmbalagem: l.fator_embalagem_portal, precoUnitario: l.preco_unitario,
      precoVendaMedio: p?.preco_venda_medio ?? null, estoqueEfetivo: Number(l.estoque_atual ?? 0),
      pontoPedido: Number(l.ponto_pedido ?? 0),
      precoCheioPromocao: l.modo_promocao ? l.preco_sem_desconto : null,
    };
    const embs = quebrarEmEmbalagens(linha, { fretePerc: cfg.fretePerc, dataPagamento });
    const { serie } = serieDoSku(f, linha.sku, addDias(data, -180), addDias(data, -1));
    const suficiente = historicoSuficiente(serie, cfg.minOcorrencias);
    const amostras = suficiente ? amostrasEmpiricas(serie, L, T) : [];
    const margem = linha.precoVendaMedio != null && linha.precoUnitario != null ? linha.precoVendaMedio - linha.precoUnitario : null;
    const d = p?.demanda_media_diaria ?? 0;
    const params = {
      margemUnit: margem, custoUnit: linha.precoUnitario, hDia, diasAteChegada: L, demandaMediaDiaria: d,
      horizonteMaxDias: 365, horizontePromoDias: cfg.horizontePromoDias,
      promoBeneficioUnit: linha.precoCheioPromocao != null && linha.precoUnitario != null ? Math.max(linha.precoCheioPromocao - linha.precoUnitario, 0) : 0,
    };
    const qtdes = embs.map((e) => e.qtde);
    const valores = valorDasEmbalagens(linha.estoqueEfetivo, qtdes, amostras, params);
    const gauss = p?.demanda_sigma_diario != null
      ? valorDasEmbalagens(linha.estoqueEfetivo, qtdes, amostrasGaussianas(d, p.demanda_sigma_diario, L, T, 400), params)
      : null;
    const protegerAte = suficiente ? quantidadeProtegida(linha.estoqueEfetivo, d, L, T) : 0;
    let acumulado = 0;
    embs.forEach((e, i) => {
      const v = valores[i];
      if (gauss && v.deltaV != null && gauss[i].deltaV != null && Math.sign(v.deltaV) !== Math.sign(gauss[i].deltaV!)) sensiveis++;
      if (v.motivoSemScore) semScore.push({ sku: e.sku, motivo: v.motivoSemScore });
      cands.push({ ...e, deltaV: v.deltaV, protegida: acumulado < protegerAte, motivoSemScore: v.motivoSemScore });
      acumulado += e.qtde;
    });
  }
  const base = baseDeCaixa(f, data, ciclo.horario_disparo_real ?? ciclo.horario_geracao, cfg, reserva);
  const continuidade = provisaoContinuidade(data, cfg.horizonteDias, mediaCompraPorDiaUtil(f, data), lags.faturamentoP10 + lags.vencimentoP10, 0);
  base.fluxos.push(...continuidade);
  const r: ResultadoCorte = cortar(cands, base, reserva, cfg.minimoPedido);
  const valorMotor = cands.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const valorAceito = r.aceitas.reduce((s, c) => s + (c.desembolso ?? 0), 0);
  const cortesPorMotivo: Record<string, number> = {};
  for (const x of r.cortadas) cortesPorMotivo[x.motivo] = (cortesPorMotivo[x.motivo] ?? 0) + (x.c.desembolso ?? 0);
  const cortesDetalhe = r.cortadas.map((x) => ({
    sku: x.c.sku, k: x.c.k, valor: x.c.desembolso ?? 0, motivo: x.motivo,
    classe: x.motivo === 'sem_score' ? null : classificarCorteDoSku(f, x.c, data, L),
  }));
  return {
    cicloId, data, status: ciclo.status, valorMotor, valorAceito,
    aceitas: r.aceitas.length, cortadas: r.cortadas.length, cortesPorMotivo,
    estado: r.estado, scoreMarginal: r.scoreMarginal, escassezCaixa: r.escassezCaixa,
    semScore, sensiveisAoModelo: sensiveis, cortesDetalhe,
  };
}

/** Replay do SKU a partir do ciclo, com e sem a embalagem (a chegada real é aproximada pela mediana L). */
function classificarCorteDoSku(f: Fatos, c: Candidata, data: DataISO, L: number): ClasseCorte {
  const ate = f.meta.hoje;
  if (diffDias(data, ate) < L + 1) return 'indeterminado';
  const { serie, estoqueFim } = serieDoSku(f, c.sku, addDias(data, -1), ate);
  const estoqueInicial = estoqueFim[0];
  const demanda = serie.slice(1);
  const recebimentos = f.recebimentos
    .filter((r) => r.sku === c.sku && r.data >= data && r.data <= ate)
    .map((r) => ({ dia: diffDias(data, r.data), qtde: Number(r.qtde) }));
  const diaChegada = Math.min(L, demanda.length - 1);
  const linha = f.linhas.find((l) => l.raiz === c.pedidoRaizId && l.sku_codigo_omie === c.sku);
  const politica = linha?.ponto_pedido != null ? { pontoPedido: Number(linha.ponto_pedido), leadTimeDias: L } : null;
  const com = replaySku({ estoqueInicial, demanda, recebimentos, removido: null, politica: null });
  const sem = replaySku({ estoqueInicial, demanda, recebimentos, removido: { dia: diaChegada, qtde: c.qtde }, politica });
  return classificarCorte(com, sem);
}

export function backtest(f: Fatos, cfg: Config) {
  const ciclos = f.ciclos.map((c) => simularCiclo(f, c.id, cfg));
  const efetivos = ciclos.filter((c) => c.status === 'disparado');
  const itensClasse = efetivos.flatMap((c) => c.cortesDetalhe.filter((x) => x.classe).map((x) => ({ classe: x.classe as ClasseCorte, valor: x.valor })));
  const episodios = deduplicarEpisodios(
    efetivos.flatMap((c) => c.cortesDetalhe.map((x) => ({ sku: x.sku, data: c.data, valor: x.valor }))), 7,
  );
  const sensibilidade = [15, 30, 45].map((dias) => {
    const r = f.ciclos.filter((c) => c.status === 'disparado').map((c) => simularCiclo(f, c.id, { ...cfg, reservaDias: dias }));
    return { reservaDias: dias, valorAceito: r.reduce((s, x) => s + x.valorAceito, 0), inviaveis: r.filter((x) => x.estado.tipo === 'inviavel').length };
  });
  return {
    config: cfg,
    gerado_em: f.meta.gerado_em,
    ciclos,
    resumo: {
      nCiclos: ciclos.length,
      nDisparados: efetivos.length,
      valorMotorDisparados: efetivos.reduce((s, c) => s + c.valorMotor, 0),
      valorAceitoDisparados: efetivos.reduce((s, c) => s + c.valorAceito, 0),
      estados: ciclos.reduce<Record<string, number>>((m, c) => ({ ...m, [c.estado.tipo]: (m[c.estado.tipo] ?? 0) + 1 }), {}),
      precisao: precisaoDoCorte(itensClasse),
      episodios: episodios.length,
      sensiveisAoModelo: ciclos.reduce((s, c) => s + c.sensiveisAoModelo, 0),
    },
    sensibilidade,
  };
}

function main(argv: string[]) {
  let fatos: Fatos;
  let saida: string;
  if (argv[0] === '--banco') {
    saida = argv[1];
    const psql = join(homedir(), '.config/afiacao/psql-ro');
    const r = spawnSync(psql, ['-v', 'ON_ERROR_STOP=1', '-At', '-f', 'docs/superpowers/orcamento-compra/fatos.sql'], { encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.status !== 0) throw new Error(`psql saiu ${r.status}: ${(r.stderr ?? '').slice(0, 500)}`);
    fatos = extrairJson(r.stdout) as Fatos;
    mkdirSync(saida, { recursive: true });
    writeFileSync(join(saida, 'fatos.json'), JSON.stringify(fatos));
  } else {
    fatos = JSON.parse(readFileSync(argv[0], 'utf8')) as Fatos;
    saida = argv[1];
  }
  const falhas = preVoo(fatos);
  if (falhas.length) {
    console.error('PRÉ-VOO REPROVADO:\n- ' + falhas.join('\n- '));
    process.exit(2);
  }
  const resultado = backtest(fatos, CONFIG_PADRAO);
  mkdirSync(saida, { recursive: true });
  writeFileSync(join(saida, 'resultado.json'), JSON.stringify(resultado, null, 2));
  console.log(JSON.stringify(resultado.resumo));
  console.log('fim|ok');
}

if (import.meta.main) main(process.argv.slice(2));
```

> Se `import.meta.main` não tipar em `tsconfig.scripts.json`, use o idioma já usado em `scripts/` (procure com `grep -l "import.meta" scripts/*.ts | head -3`) e copie-o.

- [ ] **Step 5: Ver passar**

Run: `bun run test -- scripts/orcamento-compra/simular.test.ts`
Expected: PASS. Se o teste "ciclo simples" falhar por `snapshot` (o fixture tem snapshot no próprio dia), confira `diffDias(snap.dia, data) > 1`.

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck > /tmp/oc-tc.log 2>&1; rc=$?; tail -20 /tmp/oc-tc.log; [ "$rc" -eq 0 ]
```
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
printf 'saida/\n' > docs/superpowers/orcamento-compra/.gitignore
git add docs/superpowers/orcamento-compra/fatos.sql docs/superpowers/orcamento-compra/.gitignore scripts/orcamento-compra/simular.ts scripts/orcamento-compra/simular.test.ts
git commit -m "feat(reposicao): orçamento de compra — fatos SQL read-only e script de backtest as-of [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Rodar o backtest, falsificar e publicar a página

**Files:**
- Create: `scripts/orcamento-compra/pagina.ts`
- Create: `docs/superpowers/orcamento-compra/index.html` (gerado; commitado)
- Create: `docs/superpowers/orcamento-compra/LEIA-ME.md`

- [ ] **Step 1: Rodar o backtest contra produção (read-only)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
bun scripts/orcamento-compra/simular.ts --banco docs/superpowers/orcamento-compra/saida > /tmp/oc-run.log 2>&1; rc=$?
tail -c 1500 /tmp/oc-run.log; [ "$rc" -eq 0 ] && grep -c '^fim|ok$' /tmp/oc-run.log
```
Expected: `1`. Pré-voo reprovado (exit 2) → corrigir a fonte, nunca afrouxar o pré-voo.

- [ ] **Step 2: Conferências de sanidade (evidência, não impressão)**

Com `jq` sobre `saida/resultado.json`, conferir e **anotar no LEIA-ME**:
- `resumo.nDisparados` ≈ 117 (spec §2) e `resumo.valorMotorDisparados` ≈ R$349k × 1,025 (frete) — divergência > 10% = parar e investigar (provável JOIN duplicando linhas ou split contado 2×).
- Fração de SKUs com erro de fechamento (estoque reconstruído < 0 em algum dia do histórico): se > 30%, o replay está mal-ancorado → reportar como limitação, não esconder.
- `resumo.estados`: quantos `indeterminado` e por qual camada.

```bash
jq '.resumo' docs/superpowers/orcamento-compra/saida/resultado.json
jq '[.ciclos[] | select(.estado.tipo=="indeterminado") | .estado.camadas[]] | group_by(.) | map({camada: .[0], n: length})' docs/superpowers/orcamento-compra/saida/resultado.json
```

- [ ] **Step 3: Falsificação (uma camada por vez, com controle verde na mesma invocação)**

Commite antes (Step 7 da Task 7 já fez). Para cada sabotagem: rodar o arquivo de teste (controle **verde**), aplicar o `sed`, rodar de novo (deve ficar **vermelho**), restaurar com `git checkout --`.

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
sabotar() { # $1 arquivo-fonte  $2 expressão sed  $3 arquivo de teste
  bun run test -- "$3" > /tmp/oc-ctl.log 2>&1 || { echo "CONTROLE VERMELHO em $3 — abortando"; return 1; }
  sed -i '' "$2" "$1"
  if bun run test -- "$3" > /tmp/oc-sab.log 2>&1; then echo "SABOTAGEM NÃO DETECTADA: $1 :: $2"; git checkout -- "$1"; return 1; fi
  echo "ok vermelho: $1 :: $2"; git checkout -- "$1"
}
sabotar src/lib/reposicao/orcamento-compra/camadas.ts 's/const residuo = c.valor - titulado;/const residuo = c.valor;/' src/lib/reposicao/orcamento-compra/caixa.test.ts
sabotar src/lib/reposicao/orcamento-compra/caixa.ts 's/if (primeiraViolacao === null \&\& p.saldo < reserva)/if (false)/' src/lib/reposicao/orcamento-compra/caixa.test.ts
sabotar src/lib/reposicao/orcamento-compra/corte.ts "s/if (\!temAnterior(c) || \!cabe(\[fluxoDe(c)\]))/if (\!temAnterior(c))/" src/lib/reposicao/orcamento-compra/corte.test.ts
sabotar src/lib/reposicao/orcamento-compra/valor.ts 's/return Math.min(Q, backlog) + /return /' src/lib/reposicao/orcamento-compra/valor.test.ts
sabotar src/lib/reposicao/orcamento-compra/replay.ts "s/if (sem.unidadesPerdidas > com.unidadesPerdidas) return 'teria_rompido';//" src/lib/reposicao/orcamento-compra/replay.test.ts
git status --short
```
Expected: 5 linhas `ok vermelho`, `git status` limpo. Qualquer `SABOTAGEM NÃO DETECTADA` → o teste correspondente é teatro: reforce-o antes de seguir. Rode o bloco também com `LC_ALL=C` na frente (regra de 2 ambientes do CLAUDE.md).

- [ ] **Step 4: Gerador da página**

```ts
// scripts/orcamento-compra/pagina.ts
// resultado.json → index.html (página de decisão; publicada como Artifact).
// Uso: bun scripts/orcamento-compra/pagina.ts <resultado.json> <index.html>
import { readFileSync, writeFileSync } from 'node:fs';
import type { backtest } from './simular';

type Resultado = ReturnType<typeof backtest>;

const brl = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const pct = (v: number | null | undefined) => (v == null ? 'não aplicável' : `${(v * 100).toFixed(1)}%`);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function gerarPagina(r: Resultado): string {
  const res = r.resumo;
  const linhasSens = r.sensibilidade
    .map((s) => `<tr><td>${s.reservaDias} dias</td><td>${brl(s.valorAceito)}</td><td>${s.inviaveis}</td></tr>`).join('');
  const linhasCiclos = r.ciclos
    .filter((c) => c.status === 'disparado')
    .map((c) => `<tr><td>${c.data}</td><td>${brl(c.valorMotor)}</td><td>${brl(c.valorAceito)}</td><td>${esc(c.estado.tipo)}</td><td>${Object.entries(c.cortesPorMotivo).map(([m, v]) => `${esc(m)} ${brl(v)}`).join(' · ') || '—'}</td></tr>`)
    .join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orçamento de compra</title>
<style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--line:#e5e5e5;--card:#fff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0b0b0b;--fg:#eee;--muted:#999;--line:#262626;--card:#141414}}
:root[data-theme="dark"]{--bg:#0b0b0b;--fg:#eee;--muted:#999;--line:#262626;--card:#141414}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;max-width:1100px;margin-inline:auto}
h1{font-size:24px;margin:0 0 4px}.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:20px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px}.kpi b{display:block;font-size:20px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--line)}
.wrap{overflow-x:auto}
</style></head><body>
<h1>Orçamento de compra — backtest 90 dias</h1>
<p class="muted">Simulação (nada mudou em produção). Gerado em ${esc(r.gerado_em)}. Reserva ${r.config.reservaDias} dias; gate ΔV&gt;0 por embalagem; caixa em cenário-guarda (sem vendas novas).</p>
<div class="kpis">
<div class="kpi"><span class="muted">Motor pediu (disparados)</span><b>${brl(res.valorMotorDisparados)}</b></div>
<div class="kpi"><span class="muted">Orçamento aceitaria</span><b>${brl(res.valorAceitoDisparados)}</b></div>
<div class="kpi"><span class="muted">Precisão do corte</span><b>${pct(res.precisao.precisao)}</b><span class="muted">n=${res.precisao.n} · indeterminados ${res.precisao.indeterminados}</span></div>
<div class="kpi"><span class="muted">Episódios de corte (dedup.)</span><b>${res.episodios}</b></div>
<div class="kpi"><span class="muted">Embalagens sensíveis ao modelo</span><b>${res.sensiveisAoModelo}</b></div>
</div>
<h2>Sensibilidade da reserva</h2>
<div class="wrap"><table><thead><tr><th>Reserva</th><th>Aceito (disparados)</th><th>Ciclos inviáveis</th></tr></thead><tbody>${linhasSens}</tbody></table></div>
<h2>Ciclos disparados</h2>
<div class="wrap"><table><thead><tr><th>Data</th><th>Motor</th><th>Aceito</th><th>Caixa</th><th>Cortes por motivo</th></tr></thead><tbody>${linhasCiclos}</tbody></table></div>
<h2>Premissas e limites</h2>
<ul>
<li>Demanda empírica 180d; dias com estoque reconstruído ≤ 0 tratados como censurados.</li>
<li>Estoque reconstruído para trás a partir do estoque atual (não há histórico diário); recebimentos de qualquer fornecedor por SKU.</li>
<li>Chegada aproximada pela mediana do lead time pedido→recebimento; pagamento pelo p10 (pior caso de caixa).</li>
<li>Obsolescência = 0 (não modelada na v1). Mínimo da Sayerlack = ${brl(r.config.minimoPedido)} (pergunta aberta).</li>
<li>Guloso não é ótimo; "score marginal" ≠ preço-sombra.</li>
</ul>
</body></html>`;
}

if (import.meta.main) {
  const [entrada, saida] = process.argv.slice(2);
  writeFileSync(saida, gerarPagina(JSON.parse(readFileSync(entrada, 'utf8')) as Resultado));
  console.log('fim|ok');
}
```

Antes de publicar, carregue a skill `artifact-design` e ajuste o visual se ela exigir algo além (tokens claro/escuro, 16px de margem lateral, sem rolagem horizontal já atendidos acima).

```bash
bun scripts/orcamento-compra/pagina.ts docs/superpowers/orcamento-compra/saida/resultado.json docs/superpowers/orcamento-compra/index.html > /tmp/oc-pag.log 2>&1; rc=$?; tail -1 /tmp/oc-pag.log; [ "$rc" -eq 0 ]
```
Expected: `fim|ok`. Publicar com a ferramenta Artifact (`file_path` = `docs/superpowers/orcamento-compra/index.html`, `icon: "chart"`).

- [ ] **Step 5: LEIA-ME**

Escrever `docs/superpowers/orcamento-compra/LEIA-ME.md` com: o que é (v1 simulação, link da spec e da página), como rodar (os dois comandos do Step 1 e 4 com `cd` antes), os números do Step 2 (com data), o resultado da falsificação (Step 3), as perguntas abertas da spec §10, e **o portão da v2**: "aplicar no app só se precisão do corte ≥ 95% com n ≥ 30 episódios efetivos e zero ciclo inviável não explicado" — escrito como **query/comando** a reexecutar (Step 1), não como recado.

- [ ] **Step 6: Commit**

```bash
git add scripts/orcamento-compra/pagina.ts docs/superpowers/orcamento-compra/index.html docs/superpowers/orcamento-compra/LEIA-ME.md
git commit -m "docs(reposicao): orçamento de compra — backtest 90d, página de decisão e portão da v2 [money-path]

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verificação final, Codex adversarial e PR

**Files:**
- Modify: `docs/historico/` — novo arquivo `docs/historico/orcamento-compra-v1.md` (diário curto: o que foi entregue, números, Codex, portão da v2).

- [ ] **Step 1: Suíte completa e gates**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
heavy bun run test > /tmp/oc-test.log 2>&1; rc=$?; tail -8 /tmp/oc-test.log; [ "$rc" -eq 0 ] && echo TEST_OK
bun run typecheck > /tmp/oc-tc.log 2>&1; rc=$?; tail -5 /tmp/oc-tc.log; [ "$rc" -eq 0 ] && echo TC_OK
bun lint > /tmp/oc-lint.log 2>&1; rc=$?; tail -8 /tmp/oc-lint.log; [ "$rc" -eq 0 ] && echo LINT_OK
grep -o '"[a-z:]*gate[a-z:]*"' package.json | sort -u | head -20
```
Expected: `TEST_OK`, `TC_OK`, `LINT_OK` impressos (evidência positiva). Do último comando, rode o gate de manifesto/módulos listado (ex.: `bun run manifesto:gate`) e exija exit 0 — arquivo novo em `src/` sem dono quebra só no CI.

- [ ] **Step 2: Codex adversarial no diff (2ª consulta obrigatória do money-path)**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/affectionate-shirley-b8816d
git diff origin/main --stat
{ echo "Revisor adversarial de CÓDIGO (money-path). Responda em português, P0/P1/P2 com arquivo:linha e cenário concreto."
  echo "Spec: docs/superpowers/specs/2026-10-15-orcamento-compra-design.md. Foque: conservação de desembolso (conciliação), datação, prefixo/ironing no corte, mínimo por pedido, replay (censura, política própria), ausência≠zero, as-of (vazamento de informação futura no backtest)."
  echo; git diff origin/main -- src/lib/reposicao/orcamento-compra scripts/orcamento-compra docs/superpowers/orcamento-compra/fatos.sql; } > /tmp/oc-codex-diff.md
scripts/codex-async.sh -r max - < /tmp/oc-codex-diff.md > /tmp/oc-codex-diff.out 2>&1
```
Rodar via Bash com `run_in_background: true`. Ler `/tmp/oc-codex-diff.out` inteiro ao concluir; o veredito é a linha final do arquivo, não a notificação. Corrigir P0/P1 (com teste que falha primeiro), registrar o parecer no `docs/historico/orcamento-compra-v1.md`. Exit 75/79 → PR fica **DRAFT** (regra do money-path), nunca pular.

- [ ] **Step 3: Diário + PR**

```bash
git add docs/historico/orcamento-compra-v1.md && git commit -m "docs(historico): orçamento de compra v1 — entrega, números e parecer Codex

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git fetch -q origin && git rebase origin/main && gh pr list --search "orcamento-compra" --state open
git push -u origin claude/orcamento-compra
gh pr create --title "feat(reposicao): orçamento de compra v1 — gate econômico + guarda de caixa, backtest offline [money-path]" --body-file /tmp/oc-pr-body.md
```
Corpo do PR (`/tmp/oc-pr-body.md`): resumo, link da spec/plano/página, números do backtest, falsificação, os 2 pareceres Codex, "**sem deploy** (nenhuma migration/edge/Publish)", portão da v2, e no fim `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Depois: `get_status`/`bind_pr` e ligar Auto-fix (`set_monitor`).

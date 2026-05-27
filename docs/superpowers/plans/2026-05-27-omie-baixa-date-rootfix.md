# Root-fix da Data de Baixa do Omie — Plano de Implementação (Fases 0 + 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Destravar a data de baixa real do Omie (hoje sempre NULL) começando pelo sync de movimentos com filtro de data (Fase 0) e pelo conserto do fluxo de caixa realizado, que hoje mostra sempre 0 (Fase 1).

**Architecture:** O Omie não manda a baixa no endpoint LIST de títulos, mas manda em `financas/mf/ListarMovimentos` (`dDtPagamento`). O sync chama esse endpoint **sem filtro de data** → só janela recente. Fase 0 adiciona o filtro de data (`dDtPagtoDe`/`dDtPagtoAte`) pra backfillar o histórico em massa, com cursor (não estoura o time-budget). Fase 1 reescreve o fluxo realizado do `getFluxoCaixa` pra somar `fin_movimentacoes` por dia (E/S), em vez de ler a baixa-do-título que está sempre NULL — isso **não depende** da derivação por título.

**Tech Stack:** Supabase (Postgres + edge functions Deno), React/TS client (`financeiroService.ts`), vitest. Backend só via Lovable (SQL Editor manual + deploy de edge via chat — ver CLAUDE.md §5). Helpers puros testáveis em `src/lib/financeiro/`.

**Escopo deste plano:** Fase 0 (sync) + Fase 1 (fluxo realizado). **Fora de escopo (plano-irmão pós-Fase-0):** tabela lateral `fin_titulo_baixas`, derivação ponderada, e a ligação de aging-timing / valor-cockpit / DRE-caixa / PMR — porque a lógica de filtro da derivação depende dos fatos empíricos que a Fase 0 revela (nome exato do param de data, estrutura crua do movimento, cobertura pós-backfill, se previsões poluem).

---

## Contexto que o engenheiro precisa (leia antes)

- **Lovable**: você NÃO aplica migration nem faz deploy de edge. Você prepara o SQL/prompt; o founder cola no SQL Editor / chat do Lovable e roda. Toda mudança de banco vem com query de validação. Toda edge alterada precisa de **redeploy manual** (o founder pede no chat do Lovable "leia `supabase/functions/<nome>/index.ts` da main e faça deploy verbatim").
- **`fin_movimentacoes`** (colunas relevantes): `company` (text), `data_movimento` (date), `tipo` (text, `'E'`=entrada/`'S'`=saída), `valor` (numeric, sempre positivo — o sync faz `Math.abs`), `omie_codigo_lancamento` (numeric, = `nCodTitulo` do movimento; NULL em transferências/tarifas sem título).
- **`fin_sync_cursor`** (`company`, `resource`, `next_page`): cursor de continuação por empresa×recurso. Hoje `resource` ∈ `contas_pagar|contas_receber|movimentacoes`. `next_page IS NULL` = sync completo.
- **Datas Omie**: o Omie fala `DD/MM/YYYY`. `parseOmieDate(s)` converte `DD/MM/YYYY`→`YYYY-MM-DD`. Há também o inverso embutido no sync quando precisa montar o request.
- **`heavy`**: prefixe testes/build pesados com `heavy` (máquina M2 8GB). `heavy bun run test`.
- **CI `validate`**: typecheck:strict + typecheck baseline (`tsc -p tsconfig.app.json`) + `bun run test` + build + lint. Cada fase é 1 PR; mergear com `--squash` (NUNCA `--admin`).

---

## File Structure

| Arquivo | Responsabilidade | Fase |
|---|---|---|
| `supabase/functions/omie-financeiro/index.ts` (modify, `syncMovimentacoes` ~L891-995 + as 2 chamadas `ListarMovimentos` L908-913 e L925-930) | Passar filtro de data ao `ListarMovimentos`; resetar cursor de movimentos pro backfill histórico | 0 |
| `src/lib/financeiro/fluxo-realizado-helpers.ts` (create) | Helper puro: agrega movimentos em entradas/saídas realizadas por dia | 1 |
| `src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts` (create) | Testes do helper | 1 |
| `src/services/financeiroService.ts` (modify, `getFluxoCaixa` L338-422) | Trocar a fonte do realizado: de `data_recebimento`/`data_pagamento` (NULL) pra `fin_movimentacoes` por dia | 1 |

---

## FASE 0 — Sync de movimentos com filtro de data (backfill histórico)

> Esta fase é **integração com API externa via deploy manual** — não é TDD-able em unit test (não dá pra "testar" se o Omie honra o param sem chamar o Omie). Os passos são concretos (código + SQL + invocação + verificação). O **gate** é empírico: `min(data_movimento)` precisa saltar pra trás depois do sync.

### Task 0.1: Inspecionar a estrutura crua de um movimento (resolve as incógnitas)

**Files:** nenhum (investigação).

- [ ] **Step 1: Founder roda o debug_raw no chat do Lovable** (precisa do preview logado — se der 403, recarregar o preview)

```json
{ "action": "debug_raw", "entidade": "movimentacoes", "company": "oben" }
```

- [ ] **Step 2: Analisar o `first_record_sample` retornado**

Confirmar, no objeto cru do movimento (dentro de `detalhes`):
- O campo de data de pagamento real existe e seu nome exato (esperado `dDtPagamento`).
- Se aparecem movimentos NÃO-pagos (previsão) — i.e., `detalhes` com `dDtPagamento` vazio e só `dDtPrevisao`/`dDtVenc` preenchidos. (É o que explicaria os 38% de CP anômalos: o `resolveMovementDate` cai no fallback.)
- O campo `nCodTitulo` (= `omie_codigo_lancamento`).

Registrar o resultado no plano-irmão (define o filtro da derivação). **Não bloqueia** a Task 0.2.

### Task 0.2: Passar filtro de data ao ListarMovimentos

**Files:**
- Modify: `supabase/functions/omie-financeiro/index.ts` — `syncMovimentacoes` (~L891), as 2 chamadas a `ListarMovimentos` (L908-913 e L925-930).

Hoje as duas chamadas passam só `{ nPagina, nRegPorPagina: 100 }`. O parâmetro `filtroDataDe`/`filtroDataAte` da função é usado só pra **filtrar client-side** (L971-972), nunca vai pro request do Omie.

- [ ] **Step 1: Adicionar um helper que monta os params de data do mf**

No topo de `syncMovimentacoes` (logo após a linha `const dataFimIso = parseOmieDate(filtroDataAte) || null;`, ~L900), montar os params Omie em `DD/MM/YYYY`. `filtroDataDe`/`filtroDataAte` já chegam em `DD/MM/YYYY` (são repassados das chamadas em L1858/L1921 que usam `dataInicioMov`/`dataInicio`/`dataFim` no formato Omie). Se vierem vazios, default amplo (desde 2015):

```ts
  // Filtro de data do mfListarRequest. Sem ele, o Omie devolve só a janela
  // recente (~5 meses) — causa-raiz da baixa faltante. dDtPagtoDe/Ate = data
  // de PAGAMENTO (a baixa). Default amplo p/ backfillar o histórico inteiro.
  const dtDe = filtroDataDe || "01/01/2015";
  const dtAte = filtroDataAte || formatOmieDate(new Date());
  const mfDateParams = { dDtPagtoDe: dtDe, dDtPagtoAte: dtAte };
```

- [ ] **Step 2: Verificar/where está `formatOmieDate`** (a função inversa de `parseOmieDate`, ISO→DD/MM/YYYY)

Run: `grep -n "formatOmieDate\|function.*Date.*DD/MM\|reverse().join" supabase/functions/omie-financeiro/index.ts`
Expected: localizar o formatador ISO→`DD/MM/YYYY`. Se NÃO existir, adicionar logo antes de `syncMovimentacoes`:

```ts
function formatOmieDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}
```

- [ ] **Step 3: Injetar `mfDateParams` nas DUAS chamadas a ListarMovimentos**

L908-913 (firstPage):

```ts
  const firstPage = await callOmie(
    company,
    "financas/mf/",
    "ListarMovimentos",
    { nPagina: 1, nRegPorPagina: 100, ...mfDateParams }
  );
```

L925-930 (loop):

```ts
    const result = await callOmie(
      company,
      "financas/mf/",
      "ListarMovimentos",
      { nPagina: pagina, nRegPorPagina: 100, ...mfDateParams }
    );
```

- [ ] **Step 4: `deno check` da função**

Run: `cd supabase/functions/omie-financeiro && deno check index.ts 2>&1 | tail -5`
Expected: zero novos erros (mesmo erro-set de antes, se houver baseline). Voltar pro root do repo depois.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/omie-financeiro/index.ts
git commit -m "$(cat <<'EOF'
fix(fin): sync de movimentos passa filtro de data ao ListarMovimentos

Sem dDtPagtoDe/Ate o Omie devolve só ~5 meses de movimentos (causa-raiz da
data de baixa sempre NULL). Default amplo (2015→hoje) pra backfillar histórico.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0.3: Resetar o cursor de movimentos (forçar re-sync do histórico)

**Files:** SQL via Lovable (migration custom — use a skill `lovable-db-operator`).

O cursor de `movimentacoes` está `NULL` (completo) com base na janela recente. Pra o sync re-puxar o histórico com o filtro novo, zerar o cursor das 3 empresas.

- [ ] **Step 1: Criar a migration de reset do cursor**

Create: `supabase/migrations/<timestamp>_reset_cursor_movimentacoes_backfill.sql` (timestamp via `date +%Y%m%d%H%M%S`, garantindo ordenar depois da última):

```sql
-- Reset do cursor de movimentações pra forçar backfill histórico com filtro de data.
-- Idempotente. next_page=1 → o sync recomeça da página 1 (ver syncMovimentacoes:
-- pagina = startPage ?? totalPaginas; com startPage=1 reprocessa tudo).
UPDATE public.fin_sync_cursor
SET next_page = 1, updated_at = now()
WHERE resource = 'movimentacoes';
```

- [ ] **Step 2: Empacotar o bloco de handoff** (SQL Editor) + a query de validação:

```sql
SELECT company, resource, next_page FROM public.fin_sync_cursor
WHERE resource = 'movimentacoes' ORDER BY company;
```
Esperado: 3 linhas com `next_page = 1`.

- [ ] **Step 3: Rodar `bun run audit:migrations` e commitar** (a migration só faz UPDATE → o audit vai dizer "nenhum objeto extraído", normal). Commit:

```bash
git add supabase/migrations/ docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(fin): migration de reset do cursor de movimentações p/ backfill"
```

### Task 0.4: Deploy + sync + GATE empírico

**Files:** nenhum (ops via Lovable).

- [ ] **Step 1: Founder redeploya `omie-financeiro`** (prompt pro chat do Lovable): "Leia `supabase/functions/omie-financeiro/index.ts` da branch main e faça deploy verbatim, sem modificar."

- [ ] **Step 2: Founder aplica a migration de reset** (Task 0.3 Step 2) no SQL Editor.

- [ ] **Step 3: Disparar o sync de movimentos** — os crons por-entidade já existem (ver CLAUDE.md §5); o `fin-sync-continuacao-10min` (`*/10`) avança cursores pendentes. Esperar 1-3 ciclos OU o founder pede o disparo manual no chat do Lovable da action `sync_movimentacoes` por empresa.

- [ ] **Step 4: GATE — verificar se o histórico voltou** (SQL Editor):

```sql
SELECT company, count(*) AS movimentos, min(data_movimento) AS mais_antigo,
       max(data_movimento) AS mais_recente
FROM public.fin_movimentacoes
GROUP BY company ORDER BY company;
```
**PASS** = `mais_antigo` saltou de `2025-12-29` pra anos atrás (2023 ou antes). **FAIL** = continua `2025-12-29` → o param de data está errado (o Omie ignorou em silêncio) ou o endpoint só tem janela curta. Se FAIL: tentar nomes alternativos do param (`dDtPagtoDe`→`dDtRegDe`/`dDtEmisDe`) numa nova iteração, ou cair no fallback do endpoint de detalhe (registrado no spec).

- [ ] **Step 5: Re-medir a cobertura de baixa derivável** (a query da auditoria, agora pós-backfill):

```sql
WITH mov AS (
  SELECT omie_codigo_lancamento AS cod, MAX(data_movimento) AS baixa
  FROM fin_movimentacoes
  WHERE company='oben' AND omie_codigo_lancamento IS NOT NULL
  GROUP BY omie_codigo_lancamento
),
cr AS (
  SELECT omie_codigo_lancamento AS cod, data_emissao FROM fin_contas_receber
  WHERE company='oben' AND status_titulo IN ('RECEBIDO','LIQUIDADO')
    AND omie_codigo_lancamento IS NOT NULL AND data_emissao IS NOT NULL
)
SELECT count(*) total_liq, count(m.baixa) com_baixa,
  round(100.0*count(m.baixa)/nullif(count(*),0),1) pct_cobertura
FROM cr c LEFT JOIN mov m ON m.cod=c.cod;
```
Registrar o `pct_cobertura` no plano-irmão (era 17%; se subir muito, a derivação Fase-3 é viável; se não, degradação honesta).

- [ ] **Step 6: Abrir o PR da Fase 0** (após o gate PASS) com a nota de migration manual no body.

---

## FASE 1 — `getFluxoCaixa` realizado das movimentações

> Independente da derivação por título: caixa realizado = soma dos movimentos por dia. Client-side puro (sem edge, sem deploy). Ship via CI normal.

### Task 1.1: Helper puro de agregação do realizado por dia

**Files:**
- Create: `src/lib/financeiro/fluxo-realizado-helpers.ts`
- Test: `src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts`

- [ ] **Step 1: Escrever os testes (falhando)**

Create `src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { agregarRealizadoPorDia, type MovimentoRealizado } from '../fluxo-realizado-helpers';

function mk(o: Partial<MovimentoRealizado>): MovimentoRealizado {
  return { data_movimento: '2026-01-10', tipo: 'E', valor: 100, omie_codigo_lancamento: 1, ...o };
}

describe('agregarRealizadoPorDia', () => {
  it('lista vazia → map vazio', () => {
    expect(agregarRealizadoPorDia([]).size).toBe(0);
  });

  it('soma E em entradas e S em saídas, por dia', () => {
    const m = agregarRealizadoPorDia([
      mk({ data_movimento: '2026-01-10', tipo: 'E', valor: 100 }),
      mk({ data_movimento: '2026-01-10', tipo: 'E', valor: 50 }),
      mk({ data_movimento: '2026-01-10', tipo: 'S', valor: 30 }),
      mk({ data_movimento: '2026-01-11', tipo: 'S', valor: 20 }),
    ]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 150, saidas: 30 });
    expect(m.get('2026-01-11')).toEqual({ entradas: 0, saidas: 20 });
  });

  it('exclui movimentos sem título (transferência/tarifa interna)', () => {
    const m = agregarRealizadoPorDia([
      mk({ tipo: 'E', valor: 100, omie_codigo_lancamento: null }),
      mk({ tipo: 'E', valor: 40, omie_codigo_lancamento: 7 }),
    ]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 40, saidas: 0 });
  });

  it('usa valor absoluto (defensivo)', () => {
    const m = agregarRealizadoPorDia([mk({ tipo: 'S', valor: -25 })]);
    expect(m.get('2026-01-10')).toEqual({ entradas: 0, saidas: 25 });
  });

  it('ignora data_movimento vazia', () => {
    const m = agregarRealizadoPorDia([mk({ data_movimento: '' as string })]);
    expect(m.size).toBe(0);
  });
});
```

- [ ] **Step 2: Rodar pra ver falhar**

Run: `heavy bun run test src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts`
Expected: FAIL — `Cannot find module '../fluxo-realizado-helpers'`.

- [ ] **Step 3: Implementar o helper**

Create `src/lib/financeiro/fluxo-realizado-helpers.ts`:

```ts
// Fluxo de caixa REALIZADO derivado de fin_movimentacoes (não da baixa-do-título,
// que está sempre NULL — o Omie não manda no endpoint LIST). Caixa realizado é
// evento de movimento por dia. Exclui movimentos sem título (transferências/
// tarifas internas) pra não inflar o fluxo bruto operacional.

export type MovimentoRealizado = {
  data_movimento: string;
  tipo: string; // 'E' = entrada, 'S' = saída
  valor: number;
  omie_codigo_lancamento: number | null;
};

export type RealizadoDia = { entradas: number; saidas: number };

export function agregarRealizadoPorDia(movimentos: MovimentoRealizado[]): Map<string, RealizadoDia> {
  const map = new Map<string, RealizadoDia>();
  for (const m of movimentos) {
    if (!m.data_movimento) continue;
    if (m.omie_codigo_lancamento == null) continue; // exclui transferência/tarifa sem título
    const dia = map.get(m.data_movimento) ?? { entradas: 0, saidas: 0 };
    const valor = Math.abs(Number(m.valor) || 0);
    if (m.tipo === 'E') dia.entradas += valor;
    else if (m.tipo === 'S') dia.saidas += valor;
    map.set(m.data_movimento, dia);
  }
  return map;
}
```

- [ ] **Step 4: Rodar pra ver passar**

Run: `heavy bun run test src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/financeiro/fluxo-realizado-helpers.ts src/lib/financeiro/__tests__/fluxo-realizado-helpers.test.ts
git commit -m "feat(fin): helper de fluxo realizado por dia a partir de fin_movimentacoes"
```

### Task 1.2: Ligar o helper no `getFluxoCaixa`

**Files:**
- Modify: `src/services/financeiroService.ts` — `getFluxoCaixa` (L338-422).

- [ ] **Step 1: Importar o helper** (no topo de `financeiroService.ts`, junto dos outros imports)

```ts
import { agregarRealizadoPorDia } from '@/lib/financeiro/fluxo-realizado-helpers';
```

- [ ] **Step 2: Remover os 2 blocos de realizado que lêem a baixa NULL**

Em `getFluxoCaixa`, DELETAR o bloco (L388-391):

```ts
    if (cr.data_recebimento) {
      const day = ensureDay(cr.data_recebimento);
      day.entradas_realizadas += cr.valor_recebido || 0;
    }
```

e o bloco (L401-404):

```ts
    if (cp.data_pagamento) {
      const day = ensureDay(cp.data_pagamento);
      day.saidas_realizadas += cp.valor_pago || 0;
    }
```

Manter os blocos de `entradas_previstas`/`saidas_previstas` (por vencimento) intactos. As queries CR/CP podem parar de selecionar `data_recebimento`/`valor_recebido`/`data_pagamento`/`valor_pago` se ficarem sem uso — mas **deixe como está** (YAGNI; outras leituras podem existir e o custo é nulo).

- [ ] **Step 3: Adicionar a query de movimentos + merge do realizado** (logo após o `const [{ data: crData }, { data: cpData }] = await Promise.all([...]);`, ~L361, antes do loop dos previstos OU depois — a ordem não importa porque `ensureDay` é idempotente)

```ts
  // Realizado: caixa que de fato entrou/saiu por dia (fin_movimentacoes).
  // Paginação manual — PostgREST capa em 1000 linhas e a janela pode passar disso.
  const movimentos: Array<{ data_movimento: string; tipo: string; valor: number; omie_codigo_lancamento: number | null }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let movQuery = supabase
      .from('fin_movimentacoes')
      .select('data_movimento, tipo, valor, omie_codigo_lancamento')
      .gte('data_movimento', dataInicio)
      .lte('data_movimento', dataFim)
      .order('data_movimento', { ascending: true })
      .range(from, from + PAGE - 1);
    if (company !== 'all') movQuery = movQuery.eq('company', company);
    const { data: page } = await movQuery;
    if (!page || page.length === 0) break;
    movimentos.push(...page);
    if (page.length < PAGE) break;
  }

  const realizadoPorDia = agregarRealizadoPorDia(movimentos);
  for (const [dia, r] of realizadoPorDia) {
    const day = ensureDay(dia);
    day.entradas_realizadas += r.entradas;
    day.saidas_realizadas += r.saidas;
  }
```

- [ ] **Step 4: Typecheck + testes + build**

Run: `heavy bun run typecheck:strict && heavy bunx tsc --noEmit -p tsconfig.app.json && heavy bun run test`
Expected: PASS. (`financeiroService.ts` pode não estar no strict include; o baseline `-p tsconfig.app.json` cobre.)

- [ ] **Step 5: Verificar o consumidor `FluxoCaixaTab`** (read-only, sem mudança)

Run: `grep -n "entradas_realizadas\|isPast" src/components/financeiro/dashboard/FluxoCaixaTab.tsx`
Expected: confirmar que `FluxoCaixaTab` usa `entradas_realizadas`/`saidas_realizadas` pros dias passados (L51) — agora populados. Nenhuma mudança de UI necessária.

- [ ] **Step 6: Commit**

```bash
git add src/services/financeiroService.ts
git commit -m "$(cat <<'EOF'
fix(fin): fluxo realizado vem de fin_movimentacoes (era sempre 0)

getFluxoCaixa lia data_recebimento/data_pagamento (sempre NULL → realizado 0).
Agora soma os movimentos reais por dia (E/S, exclui transferência sem título).
Previsto (por vencimento) inalterado.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: PR da Fase 1

- [ ] **Step 1: Push + abrir PR** com summary das 2 mudanças (helper + wire) e test plan (testes do helper + verificação visual do FluxoCaixaTab mostrando realizado >0 no preview). Mergear com `--squash` quando `validate` passar.

---

## Self-Review (rodado contra o spec)

**1. Spec coverage (deste plano):**
- Spec "Fase 0 — Validação empírica (filtro de data + gate)" → Tasks 0.1–0.4. ✅
- Spec "Fase 1 — getFluxoCaixa realizado das movimentações" → Tasks 1.1–1.3. ✅
- Spec "Fase 2/3 (status / derivação)" → **deliberadamente fora deste plano** (plano-irmão pós-Fase-0; justificado no topo: aging/valor precisam do *quando*, não só do status, então dependem da derivação cujos parâmetros a Fase 0 revela). ✅ (gap intencional, registrado)

**2. Placeholder scan:** nenhum "TBD/implementar depois" nos passos planejados. O timestamp da migration (Task 0.3) é gerado por comando concreto (`date +%Y%m%d%H%M%S`). Os nomes de param do Omie (`dDtPagtoDe/Ate`) têm fonte (doc Omie) + plano de fallback explícito no gate (Step 4 da 0.4) se o Omie ignorar. ✅

**3. Type consistency:** `MovimentoRealizado`/`RealizadoDia` definidos na Task 1.1 e usados igual na 1.2. `agregarRealizadoPorDia` mesma assinatura nos dois. A query da 1.2 seleciona exatamente os 4 campos do tipo. ✅

# Leadtime — duplicação por NFe multi-pedido + retenção do `nIdReceb` — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer o leadtime de compra parar de duplicar (histórico majoritariamente
inflado, com valores conflitantes) e parar de depender de vencer uma corrida contra um
sync concorrente que apaga o sinal que ele precisa.

**Architecture:** Duas fases, ordem obrigatória. **Fase 1 (PR-1)** dá proveniência ao
histórico (`nid_receb`) e atribui cada item ao seu pedido real, o que faz a unicidade
deduplicar sozinha; inclui limpeza do passado. **Fase 2 (PR-2)** tira o `nIdReceb` do
jsonb multi-writer para uma coluna dedicada com um único escritor. A Fase 2 sozinha
**amplificaria** o problema que a Fase 1 corrige — por isso esta ordem.

**Tech Stack:** Supabase (Postgres 17.6) · edge functions Deno · vitest · PG17 local
(`prove-sql-money-path`) · psql read-only para verificação em produção.

**Spec:** `docs/superpowers/specs/2026-07-16-leadtime-duplicacao-retencao-design.md`

## Global Constraints

- **Money-path.** Precisão > recall. Ausente ≠ zero — degradar para `null`, nunca fabricar
  número. Nunca fabricar `t1`.
- **Repo PÚBLICO.** Nenhuma contagem/volume de produção, percentual preciso, UUID, chave de
  NFe ou nome de fornecedor em código, comentário, commit, PR ou nome de arquivo. Descrever
  o **mecanismo**, nunca a **medida**. (Foi o que exigiu sanitização no #1338.)
- **Escrita em banco é do founder.** Eu nunca aplico migration/DML. Entrego bloco pronto
  para o SQL Editor do Lovable. Leitura/diagnóstico eu rodo via `~/.config/afiacao/psql-ro`.
- **O Deno da edge não importa de `src/`.** Lógica pura vive em `src/lib/`, é espelhada
  **verbatim** na edge entre `// MIRROR-START <label>` e `// MIRROR-END`, e a paridade é
  provada em `src/__tests__/edge-money-path-invariants.test.ts`. Esse teste existe para
  pegar reversão do Lovable no deploy — **não** é burocracia.
- **PL/pgSQL é late-bound**: `CREATE` passa e só falha em runtime → provar EXECUTANDO no
  PG17, com falsificação (sabotar e exigir vermelho).
- **Teste canônico:** `bun run test` (vitest — é o que o CI roda). Prefixar `heavy` em
  test/build/typecheck (semáforo de RAM da M2 8GB). `| tail` engole exit code → usar
  `> log 2>&1; echo $?`.
- **Comandos para o founder** sempre com `cd <worktree>` antes.

---

## Fase 1 — PR-1: duplicação + proveniência

### Task 1: helper puro de atribuição do item

**Files:**
- Create: `src/lib/reposicao/sku-items-atribuicao.ts`
- Create: `src/lib/reposicao/sku-items-atribuicao.test.ts`
- (manifesto: já coberto pelo glob `src/lib/reposicao/**` do módulo `reposicao` — nada a registrar)

**Interfaces:**
- Consumes: nada.
- Produces: `PedidoCandidato` (interface), `resolverPedidoDoItem(candidatos: PedidoCandidato[]): PedidoCandidato | null`,
  `trackingIdDoItem(pedido: PedidoCandidato | null, fallbackNfeId: string): string`,
  `t4DoRecebimento(detalhe: unknown, fallbackT4: string | null): string | null`.
  Task 2 espelha este arquivo verbatim na edge.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/reposicao/sku-items-atribuicao.test.ts
import { describe, it, expect } from 'vitest';
import {
  resolverPedidoDoItem,
  trackingIdDoItem,
  t4DoRecebimento,
  type PedidoCandidato,
} from '@/lib/reposicao/sku-items-atribuicao';

const pedido = (id: string): PedidoCandidato => ({
  id,
  t1_data_pedido: '2026-01-10T00:00:00-03:00',
  numero_pedido: '123',
  grupo_leadtime: 'TINTA',
  fornecedor_nome: 'FORN',
});

describe('resolverPedidoDoItem', () => {
  it('resolve quando há exatamente 1 candidato', () => {
    expect(resolverPedidoDoItem([pedido('a')])?.id).toBe('a');
  });

  it('AMBÍGUO (>1 candidato) => null: nunca carimba o t1 de um pedido arbitrário', () => {
    // o código antigo usava .limit(1) SEM .order() — escolha não-determinística.
    expect(resolverPedidoDoItem([pedido('a'), pedido('b')])).toBeNull();
  });

  it('sem candidato => null', () => {
    expect(resolverPedidoDoItem([])).toBeNull();
  });
});

describe('trackingIdDoItem', () => {
  it('atribui o item ao PEDIDO dele quando resolvido', () => {
    expect(trackingIdDoItem(pedido('pedido-1'), 'nfe-9')).toBe('pedido-1');
  });

  it('irmãs da MESMA NFe convergem para o mesmo tracking_id (é o que deduplica)', () => {
    // duas linhas irmãs consultam o mesmo recebimento e veem o mesmo item;
    // ambas devem produzir a MESMA chave => o upsert colapsa em 1 linha.
    const p = pedido('pedido-1');
    expect(trackingIdDoItem(p, 'nfe-irma-A')).toBe(trackingIdDoItem(p, 'nfe-irma-B'));
  });

  it('sem pedido resolvido => cai na linha da NFe (comportamento atual preservado)', () => {
    expect(trackingIdDoItem(null, 'nfe-9')).toBe('nfe-9');
  });
});

describe('t4DoRecebimento', () => {
  it('usa a data do PAYLOAD do recebimento (autoritativa), não a da linha que consultou', () => {
    const detalhe = { infoCadastro: { cRecebido: 'S', dRec: '15/01/2026', hRec: '14:30' } };
    expect(t4DoRecebimento(detalhe, '2026-01-20T00:00:00-03:00'))
      .toBe('2026-01-15T14:30:00-03:00');
  });

  it('não recebido => null, NÃO o fallback (ausente ≠ data errada)', () => {
    const detalhe = { infoCadastro: { cRecebido: 'N', dRec: '15/01/2026' } };
    expect(t4DoRecebimento(detalhe, '2026-01-20T00:00:00-03:00')).toBeNull();
  });

  it('payload sem data legível => cai no valor da linha (degrada, não inventa)', () => {
    expect(t4DoRecebimento({ infoCadastro: { cRecebido: 'S' } }, '2026-01-20T00:00:00-03:00'))
      .toBe('2026-01-20T00:00:00-03:00');
  });

  it('payload inutilizável e sem fallback => null', () => {
    expect(t4DoRecebimento(null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test -- src/lib/reposicao/sku-items-atribuicao.test.ts > /tmp/t1.log 2>&1; echo $?`
Expected: FAIL — "Failed to resolve import ... sku-items-atribuicao" (arquivo não existe).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/reposicao/sku-items-atribuicao.ts
// Helpers puros da ATRIBUIÇÃO do item de recebimento (omie-sync-sku-items).
//
// Por que existem: uma mesma chave de NFe pode cobrir VÁRIOS pedidos — cada pedido tem
// sua própria linha em purchase_orders_tracking. A edge gravava o histórico sob
// `tracking_id = <a linha que FEZ a consulta>`, mas resolvia o t1 a partir de OUTRA linha
// (o pedido real do item). Resultado: t1 e tracking_id vinham de linhas diferentes, e cada
// linha irmã regravava TODOS os itens da NFe sob si — histórico duplicado, e com o t4 da
// irmã (não do recebimento) o MESMO item ganhava leadtimes divergentes.
//
// Aqui o item é atribuído ao pedido DELE; a unicidade
// (tracking_id, sku_codigo_omie, nid_receb) então deduplica sozinha entre irmãs, e
// entregas parciais (mesmo SKU do mesmo pedido em NFes distintas) coexistem por terem
// nid_receb distintos.
//
// ESPELHADOS verbatim na edge supabase/functions/omie-sync-sku-items/index.ts
// (bloco // MIRROR-START sku-items-atribuicao) — o Deno da edge não importa de src/;
// a paridade é provada em src/__tests__/edge-money-path-invariants.test.ts.

// MIRROR-START sku-items-atribuicao
export interface PedidoCandidato {
  id: string;
  t1_data_pedido: string;
  numero_pedido: string | null;
  grupo_leadtime: string | null;
  fornecedor_nome: string | null;
}

/** Data BR (dd/mm/aaaa [+ hh:mm]) → ISO com offset de São Paulo. */
export function parseBRDateToISO(
  dateBR?: string | null,
  timeBR?: string | null,
): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const time = timeBR && /^\d{2}:\d{2}(:\d{2})?$/.test(timeBR)
    ? (timeBR.length === 5 ? `${timeBR}:00` : timeBR)
    : "00:00:00";
  return `${yyyy}-${mm}-${dd}T${time}-03:00`;
}

/** O pedido dono do item. AMBÍGUO (mais de um candidato) ⇒ null: precisão > recall.
 *  O `.limit(1)` sem `.order()` que existia antes escolhia de forma NÃO-determinística e
 *  podia carimbar no item o t1 de um pedido que não é o dele. */
export function resolverPedidoDoItem(
  candidatos: PedidoCandidato[],
): PedidoCandidato | null {
  return candidatos.length === 1 ? candidatos[0] : null;
}

/** tracking_id do histórico: o PEDIDO do item quando resolvido; senão a linha da NFe
 *  (comportamento atual). É isto que faz irmãs da mesma NFe convergirem para a mesma
 *  chave — sem isto, cada irmã regrava os mesmos itens sob si. */
export function trackingIdDoItem(
  pedido: PedidoCandidato | null,
  fallbackNfeId: string,
): string {
  return pedido?.id ?? fallbackNfeId;
}

/** t4 do PAYLOAD do recebimento (autoritativo p/ todas as irmãs), não da linha que
 *  consultou. Não recebido ⇒ null (ausente ≠ data errada). Payload ilegível ⇒ degrada
 *  para o valor da linha. */
export function t4DoRecebimento(
  detalhe: unknown,
  fallbackT4: string | null,
): string | null {
  const info = (detalhe as { infoCadastro?: Record<string, unknown> } | null)?.infoCadastro;
  if (!info) return fallbackT4;
  const recebido = String(info.cRecebido ?? "N").toUpperCase() === "S";
  if (!recebido) return null;
  const iso = parseBRDateToISO(
    info.dRec as string | null | undefined,
    info.hRec as string | null | undefined,
  );
  return iso ?? fallbackT4;
}
// MIRROR-END
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bun run test -- src/lib/reposicao/sku-items-atribuicao.test.ts > /tmp/t1.log 2>&1; echo $?`
Expected: PASS (exit 0), 11 testes.

- [ ] **Step 5: Falsificar (o teste presta?)**

Trocar temporariamente `candidatos.length === 1` por `candidatos.length >= 1` e rodar.
Expected: o teste "AMBÍGUO (>1 candidato) => null" **FALHA**. Reverter a sabotagem.
Se o teste passar com a sabotagem, o teste é teatro — reescrever antes de seguir.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reposicao/sku-items-atribuicao.ts src/lib/reposicao/sku-items-atribuicao.test.ts
git commit -m "feat(reposicao): helper puro de atribuicao do item de recebimento [money-path]

O item passa a ser atribuido ao PEDIDO dele, nao a linha que fez a consulta.
Match ambiguo => null (o .limit(1) sem .order() era nao-deterministico) e o t4
passa a vir do payload do recebimento, que e autoritativo para todas as irmas.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: espelhar na edge + paridade

**Files:**
- Modify: `supabase/functions/omie-sync-sku-items/index.ts` (bloco espelhado; `mapPedido`/upsert ~584-636)
- Modify: `src/__tests__/edge-money-path-invariants.test.ts` (novo bloco de guardrail)

**Interfaces:**
- Consumes: Task 1 — `resolverPedidoDoItem`, `trackingIdDoItem`, `t4DoRecebimento`, `PedidoCandidato`.
- Produces: a edge grava `tracking_id` = pedido do item, `t4` do payload e `nid_receb` no upsert.

- [ ] **Step 1: Write the failing test** (guardrail de paridade — segue o padrão do bloco `sku-items-fila` já existente no arquivo)

```ts
// src/__tests__/edge-money-path-invariants.test.ts — acrescentar ao final
// ── Atribuição do item de recebimento (omie-sync-sku-items) ──
// Uma chave de NFe pode cobrir vários pedidos. A edge gravava o histórico sob a linha que
// FEZ a consulta, então cada irmã regravava os mesmos itens sob si (duplicata) e com o t4
// dela (divergência). O helper puro é espelhado aqui; sem a paridade, um deploy do Lovable
// pode reverter o espelho e ressuscitar a duplicação.
const SKU_ITEMS_ATRIB = 'src/lib/reposicao/sku-items-atribuicao.ts';

describe('guardrail money-path: omie-sync-sku-items (atribuição do item)', () => {
  const src = read(SKU_ITEMS);
  const helper = read(SKU_ITEMS_ATRIB);

  it('sentinela: leu os arquivos reais (edge + helper)', () => {
    expect(src).toContain('sku_leadtime_history');
    expect(helper).toContain('trackingIdDoItem');
  });

  it('o edge USA o helper espelhado: define E chama a atribuição', () => {
    expect(src, 'edge não define mais trackingIdDoItem').toMatch(/function trackingIdDoItem/);
    expect(src, 'REGRESSÃO: edge não atribui mais o item ao pedido — duplicata volta')
      .toMatch(/trackingIdDoItem\(/);
    expect(src, 'REGRESSÃO: edge não exige mais match único — t1 de outro pedido volta')
      .toMatch(/resolverPedidoDoItem\(/);
    expect(src, 'REGRESSÃO: edge não usa mais o t4 do recebimento — divergência volta')
      .toMatch(/t4DoRecebimento\(/);
  });

  it('REGRESSÃO: o item NÃO volta a ser gravado sob a linha que consultou', () => {
    expect(src, 'tracking_id: nfeRaw.id direto no upsert = a duplicação de volta')
      .not.toMatch(/tracking_id:\s*nfeRaw\.id/);
  });

  it('PARIDADE: o bloco espelhado no edge é IDÊNTICO ao helper de src/ (pega reversão do Lovable)', () => {
    expect(
      mirrorBlockNamed(src, 'sku-items-atribuicao'),
      'edge divergiu de sku-items-atribuicao.ts — o Lovable reescreveu a atribuição no deploy?',
    ).toBe(mirrorBlockNamed(helper, 'sku-items-atribuicao'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bun run test -- src/__tests__/edge-money-path-invariants.test.ts > /tmp/t2.log 2>&1; echo $?`
Expected: FAIL — "bloco // MIRROR-START sku-items-atribuicao.../END não encontrado".

- [ ] **Step 3: Espelhar o bloco na edge**

Copiar o bloco `// MIRROR-START sku-items-atribuicao` … `// MIRROR-END` de
`src/lib/reposicao/sku-items-atribuicao.ts` **verbatim** para
`supabase/functions/omie-sync-sku-items/index.ts`, logo após o bloco `sku-items-fila`
(~linha 214). Remover os `export ` (o comparador já os normaliza, mas a edge não exporta).

- [ ] **Step 4: Trocar o SELECT do pedido (match único) — `index.ts` ~586-598**

```ts
        // Resolver o pedido DONO do item. `.limit(2)`: precisamos DISTINGUIR "1 match" de
        // "ambíguo" — com `.limit(1)` os dois casos são indistinguíveis e a escolha vira
        // loteria (sem `.order()`, o Postgres devolve qualquer um).
        let pedidoMatch: PedidoCandidato | null = null;
        if (nNumPedCompra && nNumPedCompra !== "0") {
          const { data: pedidoRows, error: pedErr } = await supabase
            .from("purchase_orders_tracking")
            .select("id, t1_data_pedido, numero_pedido, grupo_leadtime, fornecedor_nome")
            .eq("empresa", empresa)
            .eq("fornecedor_codigo_omie", nfeRaw.fornecedor_codigo_omie)
            .eq("numero_contrato_fornecedor", nNumPedCompra)
            .limit(2);
          if (!pedErr && pedidoRows) {
            pedidoMatch = resolverPedidoDoItem(pedidoRows as unknown as PedidoCandidato[]);
          }
        }
```

- [ ] **Step 5: Trocar a montagem do upsert — `index.ts` ~603-636**

```ts
        const t1 = pedidoMatch?.t1_data_pedido ?? nfeRaw.t2_data_faturamento;
        const t2 = nfeRaw.t2_data_faturamento;
        const t3 = nfeRaw.t3_data_cte;
        // t4 do PAYLOAD (autoritativo p/ todas as irmãs) — o da linha é o da irmã que
        // consultou, e irmãs divergem entre si.
        const t4 = t4DoRecebimento(detalhe, nfeRaw.t4_data_recebimento);

        const upsertRow = {
          // O item pertence ao PEDIDO dele, não à linha que fez a consulta. É isto que
          // faz as irmãs da mesma NFe convergirem para a mesma chave e deduplicarem.
          tracking_id: trackingIdDoItem(pedidoMatch, nfeRaw.id),
          // Proveniência: de QUAL recebimento veio esta linha. Entra na unicidade, para
          // que entregas parciais (mesmo SKU/pedido em NFes distintas) coexistam em vez
          // de uma sobrescrever a outra.
          nid_receb: Number(nIdReceb),
          empresa,
          sku_codigo_omie: skuCodigoOmie,
          sku_codigo: toStr(cab?.cCodigoProduto),
          sku_descricao: toStr(cab?.cDescricaoProduto),
          sku_unidade: toStr(cab?.cUnidadeNfe),
          sku_ncm: toStr(cab?.cNCM),
          fornecedor_codigo_omie: nfeRaw.fornecedor_codigo_omie,
          fornecedor_nome: pedidoMatch?.fornecedor_nome ?? nfeRaw.fornecedor_nome,
          grupo_leadtime: pedidoMatch?.grupo_leadtime ?? "OUTRO",
          quantidade_pedida: toNum(cab?.nQtdeNFe),
          quantidade_recebida: toNum(ajustes?.nQtdeRecebida),
          valor_unitario: toNum(cab?.nPrecoUnit),
          valor_total: toNum(cab?.vTotalItem),
          t1_data_pedido: t1,
          t2_data_faturamento: t2,
          t3_data_cte: t3,
          t4_data_recebimento: t4,
          lt_bruto_dias_uteis: diasUteisEntre(t1, t4),
          lt_faturamento_dias_uteis: diasUteisEntre(t1, t2),
          lt_logistica_dias_uteis: diasUteisEntre(t2, t4),
          updated_at: new Date().toISOString(),
        };

        const { error: upErr } = await supabase
          .from("sku_leadtime_history")
          .upsert(upsertRow, { onConflict: "tracking_id,sku_codigo_omie,nid_receb" });
```

- [ ] **Step 6: Run tests + typecheck**

Run: `heavy bun run test -- src/__tests__/edge-money-path-invariants.test.ts > /tmp/t2.log 2>&1; echo $?`
Expected: PASS (exit 0).
Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/omie-sync-sku-items/index.ts src/__tests__/edge-money-path-invariants.test.ts
git commit -m "fix(sync): sku_items — item vai para o PEDIDO dele, nao para a linha que consultou [money-path]

Uma chave de NFe pode cobrir varios pedidos. A edge gravava o historico sob a linha
que fez a consulta enquanto resolvia o t1 a partir de OUTRA linha — entao cada irma
regravava os mesmos itens sob si (duplicata) e com o t4 dela (divergencia: o MESMO
item ganhava leadtimes diferentes conforme quem o gerou).

Agora: item -> pedido dele; t4 -> payload do recebimento (autoritativo); match
ambiguo -> sem match (o .limit(1) sem .order() era loteria). Guardrail de paridade
espelha o helper puro e pega reversao do Lovable no deploy.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: migration — proveniência + unicidade nova

**Files:**
- Create: `supabase/migrations/<timestamp>_sku_leadtime_proveniencia.sql`
- Create: `db/test-sku-leadtime-proveniencia.sh` (harness PG17)

**Interfaces:**
- Consumes: nada (schema).
- Produces: `sku_leadtime_history.nid_receb bigint`; constraint `uq_sku_hist_tracking_sku_receb`
  `UNIQUE NULLS NOT DISTINCT (tracking_id, sku_codigo_omie, nid_receb)` — é o `onConflict` da Task 2.

- [ ] **Step 1: Escrever a migration**

```sql
-- supabase/migrations/<timestamp>_sku_leadtime_proveniencia.sql
-- Proveniência do leadtime por item: de QUAL recebimento veio cada linha.
--
-- Por quê: uma chave de NFe pode cobrir vários pedidos. Com o item atribuído ao pedido
-- dele, a unicidade (tracking_id, sku_codigo_omie) passaria a significar "um leadtime por
-- (pedido, SKU)" — e ENTREGAS PARCIAIS (mesmo SKU do mesmo pedido chegando em NFes
-- distintas) colidiriam: a segunda entrega sobrescreveria a primeira, SILENCIOSAMENTE.
-- Duplicata infla; perda apaga. Daí a proveniência entrar na chave.
--
-- NULLS NOT DISTINCT (PG15+; prod é 17.6): linhas históricas ficam com nid_receb NULL e
-- precisam continuar deduplicando ENTRE SI como antes. Com o default (NULLS DISTINCT),
-- duas linhas (tracking, sku, NULL) coexistiriam e a duplicata voltaria pela porta dos
-- fundos.
--
-- ⚠️ ORDEM: esta migration roda DEPOIS da limpeza do histórico. Antes dela, a constraint
-- nova é violada pelas duplicatas existentes e o ALTER falha.

ALTER TABLE public.sku_leadtime_history
  ADD COLUMN IF NOT EXISTS nid_receb bigint;

COMMENT ON COLUMN public.sku_leadtime_history.nid_receb IS
  'Recebimento (Omie nIdReceb) que originou esta linha. Proveniência + parte da unicidade: '
  'permite que entregas parciais do mesmo (pedido, SKU) coexistam. NULL = linha anterior à '
  'proveniência.';

ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku;

ALTER TABLE public.sku_leadtime_history
  DROP CONSTRAINT IF EXISTS uq_sku_hist_tracking_sku_receb;

ALTER TABLE public.sku_leadtime_history
  ADD CONSTRAINT uq_sku_hist_tracking_sku_receb
  UNIQUE NULLS NOT DISTINCT (tracking_id, sku_codigo_omie, nid_receb);
```

- [ ] **Step 2: Escrever o teste PG17 que FALHA sem a migration**

Partir de `.claude/skills/prove-sql-money-path/references/harness-template.sh` (subir PG17
descartável, aplicar o schema mínimo + a migration **real** do repo, semear, assertar).
Padrões de assert em `references/assert-patterns.md`; exemplos vivos em `db/test-*.sh`.
A migration aplicada tem de ser o **arquivo do repo**, não um SQL reescrito à mão — senão
o teste prova outra coisa.

Asserts obrigatórios:

```sql
-- (1) entrega parcial COEXISTE: mesmo (tracking,sku), nid_receb distintos => 2 linhas
INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
VALUES ('11111111-1111-1111-1111-111111111111','OBEN',1,100),
       ('11111111-1111-1111-1111-111111111111','OBEN',1,200);
DO $$ BEGIN
  IF (SELECT count(*) FROM sku_leadtime_history WHERE sku_codigo_omie=1) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: entrega parcial deveria coexistir';
  END IF;
END $$;

-- (2) irmãs deduplicam: mesmo (tracking,sku,nid_receb) => upsert colapsa em 1
INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
VALUES ('11111111-1111-1111-1111-111111111111','OBEN',1,100)
ON CONFLICT (tracking_id, sku_codigo_omie, nid_receb) DO UPDATE SET empresa=EXCLUDED.empresa;
DO $$ BEGIN
  IF (SELECT count(*) FROM sku_leadtime_history WHERE sku_codigo_omie=1) <> 2 THEN
    RAISE EXCEPTION 'FALHOU: irma deveria deduplicar, nao inserir';
  END IF;
END $$;

-- (3) NULLS NOT DISTINCT: linhas históricas (nid_receb NULL) ainda deduplicam entre si
DO $$
DECLARE v_sqlstate text;
BEGIN
  INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
  VALUES ('22222222-2222-2222-2222-222222222222','OBEN',2,NULL);
  BEGIN
    INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, nid_receb)
    VALUES ('22222222-2222-2222-2222-222222222222','OBEN',2,NULL);
    RAISE EXCEPTION 'FALHOU: NULL duplicado passou — NULLS NOT DISTINCT nao esta valendo';
  EXCEPTION WHEN unique_violation THEN
    NULL;  -- esperado: captura a SQLSTATE especifica, re-lanca o resto
  END;
END $$;
```

- [ ] **Step 3: Rodar o teste**

Run: `heavy bash db/test-sku-leadtime-proveniencia.sh > /tmp/pg17.log 2>&1; echo $?`
Expected: exit 0, todos os asserts verdes.

- [ ] **Step 4: FALSIFICAR (obrigatório — teste que não falha é teatro)**

Trocar na migration `UNIQUE NULLS NOT DISTINCT` por `UNIQUE` e rodar de novo.
Expected: o assert (3) **FALHA** com "NULL duplicado passou".
Trocar a chave para `(tracking_id, sku_codigo_omie)` e rodar.
Expected: o assert (1) **FALHA** com "entrega parcial deveria coexistir".
Reverter as duas sabotagens. Se algum assert passar sabotado, o teste não presta.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/ db/test-sku-leadtime-proveniencia.sh
git commit -m "feat(db): proveniencia do leadtime por item (nid_receb + unicidade) [money-path]

Sem proveniencia, atribuir o item ao pedido faria entregas parciais (mesmo SKU do
mesmo pedido em NFes distintas) COLIDIREM — a segunda sobrescreveria a primeira em
silencio. Duplicata infla; perda apaga.

NULLS NOT DISTINCT (prod e PG17.6) preserva a dedup das linhas historicas, que ficam
com nid_receb NULL. Provado no PG17 executando, com falsificacao (sabotar => vermelho).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: limpeza do histórico

**Files:**
- Create: `db/limpeza-sku-leadtime-duplicado.sql` (bloco para o SQL Editor)
- Create: `db/test-limpeza-sku-leadtime.sh` (harness PG17)

**Interfaces:**
- Consumes: Task 3 (a constraint nova só passa a valer **depois** desta limpeza).
- Produces: histórico sem má-atribuição. Classe A e B intactas.

**Classificação** (o `t1` gravado revela a qual pedido o item pertence de verdade):

| Classe | Critério | Ação |
|---|---|---|
| A) correta | `h.t1` = `t1` do próprio tracking | preservar |
| B) fallback | `h.t1` = `h.t2` | preservar (é o PR-3) |
| C) má-atribuição | `h.t1` ≠ `t1` do tracking **e** ≠ `h.t2` | DELETE se par correto existe; senão UPDATE |

- [ ] **Step 1: Escrever a limpeza**

```sql
-- db/limpeza-sku-leadtime-duplicado.sql
-- Limpeza do histórico de leadtime: má-atribuição do item.
--
-- Contexto: a edge gravava o item sob a linha que FEZ a consulta, não sob o pedido dele.
-- Como uma NFe cobre vários pedidos, cada linha irmã regravou TODOS os itens da NFe sob si.
-- O t1 gravado é o do pedido REAL do item (vinha do match por contrato) — é ele que
-- denuncia a qual pedido a linha pertence.
--
-- Ordem: DELETE antes do UPDATE. Reatribuir primeiro violaria a unicidade contra a linha
-- correta que ainda não foi removida.
-- Idempotente: rodar 2x = mesmo resultado.

BEGIN;

-- (C1) DELETE: má-atribuição cuja linha correta JÁ existe → excedente puro.
DELETE FROM public.sku_leadtime_history h
USING public.purchase_orders_tracking t
WHERE t.id = h.tracking_id
  AND h.t1_data_pedido::date <> t.t1_data_pedido::date   -- não é a classe A
  AND h.t1_data_pedido::date <> h.t2_data_faturamento::date -- não é a classe B (fallback)
  AND EXISTS (
    SELECT 1
    FROM public.sku_leadtime_history h2
    JOIN public.purchase_orders_tracking t2 ON t2.id = h2.tracking_id
    WHERE t2.nfe_chave_acesso = t.nfe_chave_acesso
      AND h2.sku_codigo_omie = h.sku_codigo_omie
      AND h2.t1_data_pedido::date = t2.t1_data_pedido::date   -- a correta (classe A)
      AND h2.t1_data_pedido::date = h.t1_data_pedido::date    -- do MESMO pedido
  );

-- (C2) UPDATE: má-atribuição SEM par correto → o dado é válido, só está no tracking
-- errado. Apagar seria PERDA. Reatribui ao pedido real (casamento fornecedor + t1),
-- exigindo destino ÚNICO — ambíguo não se toca (precisão > recall).
UPDATE public.sku_leadtime_history h
SET tracking_id = destino.id
FROM public.purchase_orders_tracking t,
LATERAL (
  SELECT td.id
  FROM public.purchase_orders_tracking td
  WHERE td.empresa = t.empresa
    AND td.omie_codigo_pedido > 0
    AND td.fornecedor_codigo_omie = t.fornecedor_codigo_omie
    AND td.t1_data_pedido = h.t1_data_pedido
  LIMIT 2
) destino
WHERE t.id = h.tracking_id
  AND h.t1_data_pedido::date <> t.t1_data_pedido::date
  AND h.t1_data_pedido::date <> h.t2_data_faturamento::date
  AND 1 = (
    SELECT count(*) FROM public.purchase_orders_tracking td2
    WHERE td2.empresa = t.empresa AND td2.omie_codigo_pedido > 0
      AND td2.fornecedor_codigo_omie = t.fornecedor_codigo_omie
      AND td2.t1_data_pedido = h.t1_data_pedido
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.sku_leadtime_history h3
    WHERE h3.tracking_id = destino.id AND h3.sku_codigo_omie = h.sku_codigo_omie
      AND h3.nid_receb IS NOT DISTINCT FROM h.nid_receb
  );

COMMIT;
```

- [ ] **Step 2: Escrever o teste PG17**

`db/test-limpeza-sku-leadtime.sh` — mesmo template da Task 3
(`.claude/skills/prove-sql-money-path/references/harness-template.sh`), aplicando o
`db/limpeza-sku-leadtime-duplicado.sql` **real**.

Cenário a semear (é o de produção, em miniatura): duas linhas irmãs — pedidos distintos,
**mesma** chave de NFe — com os itens de ambos gravados sob as duas (a duplicata); mais
uma linha classe A; uma classe B (`t1 = t2`); e uma classe C **sem par** (item que só a
irmã errada consultou).

Asserts obrigatórios:
1. **classe A intacta**: contagem antes = depois (é o assert que pega DELETE largo demais).
2. **classe B intacta**: a linha em fallback não é tocada.
3. **classe C com par**: excedente removido, a correta permanece.
4. **classe C sem par**: **não some** — foi reatribuída ao pedido correto.
5. **idempotência**: rodar 2× produz o mesmo resultado.
6. **nada de perda**: nenhum `(sku, chave de NFe)` presente antes fica ausente depois.

- [ ] **Step 3: Rodar**

Run: `heavy bash db/test-limpeza-sku-leadtime.sh > /tmp/limpeza.log 2>&1; echo $?`
Expected: exit 0.

- [ ] **Step 4: FALSIFICAR**

Remover o bloco `(C2) UPDATE` e rodar.
Expected: o assert 4 **FALHA** ("classe C sem par sumiu") — prova que o assert pega perda.
Remover a condição `<> h.t2_data_faturamento::date` do DELETE e rodar.
Expected: o assert 2 **FALHA** (classe B foi tocada). Reverter as sabotagens.

- [ ] **Step 5: Commit**

```bash
git add db/limpeza-sku-leadtime-duplicado.sql db/test-limpeza-sku-leadtime.sh
git commit -m "feat(db): limpeza da ma-atribuicao no historico de leadtime [money-path]

Corrigir o codigo nao limpa o passado — a reposicao seguiria lendo historico inflado.
O t1 gravado denuncia a qual pedido o item pertence: classe A (correta) e B (fallback)
sao preservadas; C (ma-atribuicao) e deletada quando a linha correta ja existe e
REATRIBUIDA quando nao — apagar essas seria perda, o dado delas e valido.

Provado no PG17 com falsificacao. Assert que pega DELETE largo demais: a contagem da
classe A nao pode mudar.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: PR-1 + handoff de deploy

- [ ] **Step 1: Health check completo**

Run: `heavy bun run test > /tmp/full.log 2>&1; echo $?` → exit 0
Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo $?` → exit 0
Run: `bun lint > /tmp/lint.log 2>&1; echo $?` → exit 0

- [ ] **Step 2: Abrir o PR** (não-draft = auto-merge no CI verde)

Corpo do PR: mecanismo, **sem** medidas de produção (repo público). Incluir o handoff:
a ordem **limpeza → migration** e que o Publish do frontend **não** se aplica (só edge+SQL).

- [ ] **Step 3: Armar o watcher**

```bash
scripts/pr-watch.sh <nº> &
```
(Bash `run_in_background: true`; avisar o founder no desfecho via PushNotification.)

- [ ] **Step 4: Entregar ao founder, nesta ordem**

1. `db/limpeza-sku-leadtime-duplicado.sql` → SQL Editor
2. a migration → SQL Editor
3. redeploy de `omie-sync-sku-items` → chat do Lovable (ler do repo, verbatim)

- [ ] **Step 5: Verificar em produção** (`psql-ro`, após o deploy)

- histórico: nenhum `(sku, chave)` com linhas excedentes;
- `fila_pendente` e `interrompido_por_timeout` do `sync_sku_items` — a Task 2 não deve
  ter aumentado a fila;
- nenhuma linha nova sem `nid_receb`.

---

## Fase 2 — PR-2: retenção do sinal

> Só começa com a Fase 1 **em produção e verificada**. Antes disso, o `nid_receb`
> persistente faz todas as irmãs gerarem leadtime = duplicação máxima.

### Task 6: coluna dedicada + PRESERVE_FIELDS

**Files:**
- Create: `supabase/migrations/<timestamp>_purchase_orders_tracking_nid_receb.sql`
- Modify: `supabase/functions/omie-sync-pedidos-compra/index.ts:223` (PRESERVE_FIELDS)

- [ ] **Step 1: Migration**

```sql
ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS nid_receb bigint;

COMMENT ON COLUMN public.purchase_orders_tracking.nid_receb IS
  'Recebimento (Omie nIdReceb) da NFe desta linha. Coluna DEDICADA com UM escritor '
  '(omie-sync-nfes-recebidas): o raw_data e jsonb multi-writer e o sync de pedidos o '
  'sobrescrevia, apagando o sinal a cada rodada.';

-- Backfill barato: o sinal que AINDA está no jsonb entra na coluna sem chamar a Omie.
UPDATE public.purchase_orders_tracking
SET nid_receb = (raw_data->'cabec'->>'nIdReceb')::bigint
WHERE nid_receb IS NULL
  AND raw_data->'cabec'->>'nIdReceb' ~ '^\d+$';

-- Índice do backfill: achar os pendentes sem varrer a tabela.
CREATE INDEX IF NOT EXISTS idx_pot_backfill_nid_receb
  ON public.purchase_orders_tracking (empresa, id)
  WHERE nfe_chave_acesso IS NOT NULL AND nid_receb IS NULL;
```

- [ ] **Step 2: PRESERVE_FIELDS** — acrescentar `"nid_receb",` ao set em `omie-sync-pedidos-compra/index.ts`, com o comentário:

```ts
  // O sinal do recebimento é de OUTRO sync. Ficava só no raw_data — que este upsert
  // sobrescreve — e era apagado a cada rodada, obrigando o backfill a re-resolvê-lo
  // eternamente sem nunca convergir.
  "nid_receb",
```

- [ ] **Step 3: Guardrail** em `src/__tests__/edge-money-path-invariants.test.ts`:

```ts
  it('REGRESSÃO: pedidos-compra não pode voltar a sobrescrever o sinal do recebimento', () => {
    const src = read('supabase/functions/omie-sync-pedidos-compra/index.ts');
    expect(src, 'nid_receb saiu de PRESERVE_FIELDS — o sinal volta a ser apagado a cada rodada')
      .toMatch(/"nid_receb"/);
  });
```

- [ ] **Step 4:** `heavy bun run test` → exit 0. Commit.

### Task 7: writer único + filtro no banco

**Files:** Modify `supabase/functions/omie-sync-nfes-recebidas/index.ts` (`backfillRawData` ~588-680; criação da órfã ~369-375)

- [ ] **Step 1:** gravar `nid_receb` junto do `raw_data` (backfill e criação da órfã), com
  compare-and-set: só grava se `nid_receb IS NULL` **e** a `nfe_chave_acesso` ainda é a
  consultada; divergência ⇒ erro, nunca sobrescrita silenciosa (recomendação do Codex).
- [ ] **Step 2:** trocar o filtro: hoje puxa todas as linhas com `nfe_chave_acesso` e filtra
  **em memória** pelo jsonb → passar a `.is("nid_receb", null)` **no SELECT**. Some o risco
  do teto de 1.000 linhas do PostgREST (`.range()` + `.order` estável se precisar paginar).
- [ ] **Step 3:** `heavy bun run test` → exit 0. Commit.

### Task 8: leitor + resíduo

**Files:** Modify `supabase/functions/omie-sync-sku-items/index.ts`;
`.claude/skills/diagnose-supabase-sync/references/sync-registry.md`

- [ ] **Step 1:** ler `nfeRaw.nid_receb ?? nfeRaw.raw_data?.cabec?.nIdReceb` (fallback só
  durante a transição).
- [ ] **Step 2:** **corrigir o comentário refutado** em `index.ts:524-530` — ele afirma que
  a linha com pedido "quase nunca ganha nIdReceb" e que "não se auto-resolve". Ambas falsas:
  o sinal chega e é apagado.
- [ ] **Step 3:** **corrigir o registry**, bloco "GOTCHA sync_sku_items" item (c) — mesma
  hipótese refutada. Registrar a assinatura nova, que é genérica e reusável:
  *"contador de backlog estável apesar de progresso por rodada = trabalho sendo desfeito
  por escritor concorrente"*.
- [ ] **Step 4:** Commit.

### Task 9: PR-2 + verificação da tese

- [ ] **Step 1:** PR + `scripts/pr-watch.sh` em background.
- [ ] **Step 2:** handoff: migration → SQL Editor; redeploy das 3 edges pelo chat do Lovable.
- [ ] **Step 3: o teste da tese inteira.** Após o deploy, acompanhar via `psql-ro` o
  `nfes_identificadas_para_backfill` do `fin_sync_log`. Ele estava **estável há dias**.
  Se a tese está certa, agora ele **cai** rodada após rodada até o fluxo de NFes novas.
  **Se não cair, a tese está errada** e o diagnóstico volta à mesa — não remendar.

---

## Fora de escopo (registrados)

- **PR-3 — `t1` fabricado.** `t1 = pedidoMatch?.t1 ?? t2` fabrica `lt_faturamento = 0`,
  violando "ausente ≠ zero". Enviesa a média **para baixo** → a reposição compra tarde.
  Adiado por decisão do founder: degradar para `null` reduz recall e é decisão de negócio.
- **Aposentar `reprocessar_sku_items_via_raw_data`** — lê o `raw_data` disputado; é uma
  roleta de último-escritor (a mesma execução em momentos diferentes cobre coisas
  diferentes). Reescrever para ler a coluna dedicada, ou aposentar.
- **`PRESERVE_FIELDS` é denylist** — "o próximo campo crítico novo nasce desprotegido"
  (Codex). Foi exatamente o que causou este incidente. Trocar por allowlist.
- **Separar `pedido_raw_data` / `recebimento_raw_data`** — o jsonb segue multi-writer; só
  o **sinal** money-path saiu dele.

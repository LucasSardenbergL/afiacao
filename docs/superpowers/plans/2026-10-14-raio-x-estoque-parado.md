# Raio-X do estoque parado (faxina) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerar um retrato read-only do estoque parado da Oben, classificá-lo por SKU e publicá-lo num Artifact privado onde o founder e o comprador registram o destino de cada SKU — e, em T+6 semanas, medir o caixa liberado com a mesma lógica.

**Architecture:** O SQL extrai **só fatos** (`fatos.sql` → JSON). Toda regra (categoria, destino sugerido, placar, listas, medição) vive num módulo JS **puro** (`logica.mjs`), testado com `node --test` e importado tanto pelo gerador quanto pela página — uma regra, um lugar. A página é HTML estático + `logica.mjs` + `retrato.json` como arquivos do Artifact; decisões ficam no `db` do Artifact (1 doc por SKU).

**Tech Stack:** PostgreSQL via `~/.config/afiacao/psql-ro` (read-only) · Node 26 (`node --test`, ESM) · Artifact com capabilities `db` + `user` (runtime contract 0.2.78).

**Spec:** `docs/superpowers/specs/2026-10-14-raio-x-estoque-parado-design.md`

## Global Constraints

- **Zero escrita** em Supabase, Omie ou app: só `psql-ro`. Nada em `src/`, `supabase/`, `db/`.
- Código desta entrega vive em `docs/superpowers/raio-x-estoque-parado/` (fora do manifesto de módulos e do CI do app).
- **JSON com dado de cliente nunca é commitado**: `fatos.json`/`retrato.json` saem em `$RAIOX_OUT` (default: scratchpad da sessão); o diretório tem `.gitignore` com `*.json`.
- Universo: `inventory_position.account='oben'`, `saldo>0`; `cmc>0` avaliado; `cmc` nulo/≤0 → contado em `sem_custo`, nunca valor 0.
- Histórico de venda: `v_venda_items_history_efetivo`, `empresa='OBEN'`, desde 2025-10-21. Texto da página: "sem venda **em 12 meses**", nunca "nunca vendeu".
- Entrada no universo: fora do motor **ou** 0 vendas em 12m **ou** cobertura > 180 dias.
- `TOP_N = 61` (rank por valor dentro de `mercadoria`).
- Destinos de decisão: `trocar` · `venda_dirigida` · `liquidar` · `manter_suspender_recompra` · `estrategico` · `erro_cadastro`. Sugestões extras (não decisão): `novo_aguarde` · `revisar`.
- A sugestão **só pré-seleciona**; decidido = existe doc em `decisoes/<sku>` com `destino` ∈ destinos de decisão.
- Pré-voo: `max(synced_at)` da conta `oben` < 24h; senão o gerador sai com código ≠ 0 e não escreve `retrato.json`.
- Liquidado (medição) = preço médio de venda no período < **90%** do preço médio dos 12m do retrato.
- Respostas e textos da página em **pt-BR**.
- **Refinamento declarado da spec** (a reportar ao founder na entrega): padrão de descrição de não-mercadoria (`CARTELA|MOSTRUARIO|...`) só vale para SKU **sem venda em 12m** — a "CARTELA DE 720 CORES" vende para 6 clientes, logo é mercadoria. Família `Imobilizado` vale sempre.
- `fornecedor` = `sku_parametros.fornecedor_nome` → emitente da última NF de entrada → `metadata.marca` do produto (prefixo `marca: `) → `null`.
- `cadastro_em` = `omie_products.created_at` (import em massa foi fev/abr-2026, > 90d → só produto realmente novo cai em `novo_aguarde`).

## Review Focus

1. **Doc de decisão sem `destino` válido** (ex.: só observação ou só contagem) — não pode contar como decidido no placar. → teste em Task 1 (`placar ignora doc só com observacao`).
2. **`credito_troca` digitado como texto com vírgula** ("1.234,56") — medição deve parsear pt-BR, e texto inválido vira `null` (não 0). → teste em Task 1 (`parseValorBR`).
3. **Venda no período maior que o saldo do retrato** (reposição chegou e vendeu) — vendido a custo não pode exceder o saldo do retrato. → teste em Task 4 (`medir limita vendido ao saldo do retrato`).
4. **Página aberta sem `db`** (visualização sem grant / deslogado) — tem de renderizar o retrato em modo leitura, sem botões que falham calados. → verificação em Task 3, passo de teste manual.
5. **SKU sem cliente comprador decidido como `venda_dirigida`** — lista por cliente não pode sumir com ele; vai para o grupo "sem comprador em 12m". → teste em Task 1 (`vendaDirigidaPorCliente agrupa sem comprador`).

---

### Task 1: Lógica pura (`logica.mjs`) com testes

**Files:**
- Create: `docs/superpowers/raio-x-estoque-parado/.gitignore`
- Create: `docs/superpowers/raio-x-estoque-parado/logica.mjs`
- Test: `docs/superpowers/raio-x-estoque-parado/logica.test.mjs`

**Interfaces:**
- Consumes: formato de item de `fatos.json` (definido aqui, produzido na Task 2):
  `{sku:number, codigo:string, descricao:string, familia:string|null, ativo:boolean|null, cadastro_em:string|null(YYYY-MM-DD), unidade_estoque:string|null, unidades_venda:string[], fornecedor:string|null, ult_entrada:string|null, saldo:number, cmc:number, motor:boolean, classe_abc:string|null, ult_venda:string|null, q12:number, ncli:number, preco_medio_12m:number|null, clientes:[{nome:string, ult:string, qtd:number}]}`
- Produces:
  - `categorizar(item) → {categoria:'mercadoria'|'nao_mercadoria'|'insumo_maquina'|'granel', motivo:string}`
  - `cobertura(item) → number|null`
  - `sugerirDestino(item, hoje:string) → {destino:string, motivo:string}`
  - `classificar(fatos:{meta, itens}, hoje:string) → {meta, itens: ItemClassificado[]}` onde `ItemClassificado = item & {valor, cobertura, categoria, motivo_categoria, destino_sugerido, motivo_destino, top:boolean}`
  - `placar(itens, decisoes:Record<string,Decisao>) → {total, decidido, pendente, porDestino:Record<string,number>, topTotal, topDecidido}`
  - `listaTroca(itens, decisoes) → [{sku, codigo, descricao, saldo, valor}]`
  - `vendaDirigidaPorCliente(itens, decisoes) → [{cliente:string, valor:number, itens:[{codigo, descricao, saldo, valor, ult, qtd}]}]`
  - `diffContagem(item, qtdContada) → {dif_un, dif_valor}|null`
  - `parseValorBR(s) → number|null`
  - `Decisao = {destino?, observacao?, fornecedor_informado?, credito_troca?, qtd_contada?, decidido_por?, decidido_em?}`
  - constantes `TOP_N`, `DESTINOS`, `ROTULOS`

- [ ] **Step 1: Criar `.gitignore` e o teste que falha**

`docs/superpowers/raio-x-estoque-parado/.gitignore`:
```
*.json
```

`docs/superpowers/raio-x-estoque-parado/logica.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categorizar, cobertura, sugerirDestino, classificar, placar,
  listaTroca, vendaDirigidaPorCliente, diffContagem, parseValorBR, TOP_N,
} from './logica.mjs';

const HOJE = '2026-10-14';
const base = (o = {}) => ({
  sku: 1, codigo: 'X1', descricao: 'PRODUTO', familia: 'Cola Branca', ativo: true,
  cadastro_em: '2026-04-01', unidade_estoque: 'UN', unidades_venda: ['UN'],
  fornecedor: null, ult_entrada: null, saldo: 10, cmc: 5, motor: false, classe_abc: null,
  ult_venda: null, q12: 0, ncli: 0, preco_medio_12m: null, clientes: [], ...o,
});

test('categorizar: Imobilizado sempre é nao_mercadoria', () => {
  assert.equal(categorizar(base({ familia: 'Imobilizado', q12: 5 })).categoria, 'nao_mercadoria');
});
test('categorizar: CARTELA sem venda é nao_mercadoria; com venda é mercadoria', () => {
  assert.equal(categorizar(base({ descricao: 'CAIXA MOSTRUARIO' })).categoria, 'nao_mercadoria');
  assert.equal(categorizar(base({ descricao: 'CARTELA DE 720 CORES', q12: 3 })).categoria, 'mercadoria');
});
test('categorizar: ATL/ATP de Concentrados LC é insumo; resto da LC é mercadoria', () => {
  assert.equal(categorizar(base({ familia: 'Concentrados LC', descricao: 'ATL233-POLIESTER' })).categoria, 'insumo_maquina');
  assert.equal(categorizar(base({ familia: 'Concentrados LC', descricao: 'VERNIZ PU 5:1' })).categoria, 'mercadoria');
  assert.equal(categorizar(base({ familia: 'Concentrados MixMachine' })).categoria, 'insumo_maquina');
});
test('categorizar: granel 1000 KG', () => {
  assert.equal(categorizar(base({ descricao: 'COLA BRANCA PVA EXTRA 1000KG' })).categoria, 'granel');
  assert.equal(categorizar(base({ descricao: 'COLA AMARELA 1000 KG' })).categoria, 'granel');
});

test('cobertura: null sem venda; dias quando vende', () => {
  assert.equal(cobertura(base()), null);
  assert.equal(cobertura(base({ saldo: 365, q12: 365 })), 365);
});

test('sugerirDestino: ordem das regras', () => {
  assert.equal(sugerirDestino(base({ cadastro_em: '2026-09-01' }), HOJE).destino, 'novo_aguarde');
  assert.equal(sugerirDestino(base({ ult_entrada: '2026-10-02' }), HOJE).destino, 'novo_aguarde');
  assert.equal(sugerirDestino(base({ unidades_venda: ['UN', 'GL'] }), HOJE).destino, 'revisar');
  assert.equal(sugerirDestino(base({ fornecedor: 'RENNER SAYERLACK S/A' }), HOJE).destino, 'trocar');
  assert.equal(sugerirDestino(base({ fornecedor: 'marca: SAYERLACK' }), HOJE).destino, 'trocar');
  assert.equal(sugerirDestino(base({ q12: 1, saldo: 10 }), HOJE).destino, 'venda_dirigida'); // 3650 d
  assert.equal(sugerirDestino(base({ q12: 10, saldo: 7 }), HOJE).destino, 'manter_suspender_recompra'); // 255,5 d
  assert.equal(sugerirDestino(base({ fornecedor: 'ACRE CAXIAS' }), HOJE).destino, 'liquidar');
  assert.equal(sugerirDestino(base({ q12: 100, saldo: 10 }), HOJE).destino, 'revisar'); // fora do motor, 36,5 d
});

test('classificar: valor, top só em mercadoria e por valor', () => {
  const itens = [
    base({ sku: 1, saldo: 1, cmc: 100 }),
    base({ sku: 2, saldo: 1, cmc: 999, familia: 'Imobilizado' }),
    base({ sku: 3, saldo: 1, cmc: 50 }),
  ];
  const r = classificar({ meta: {}, itens }, HOJE);
  const by = Object.fromEntries(r.itens.map((i) => [i.sku, i]));
  assert.equal(by[1].valor, 100);
  assert.equal(by[2].top, false);
  assert.equal(by[1].top, true);
  assert.equal(r.itens[0].sku, 2); // ordenado por valor desc
  assert.ok(TOP_N === 61);
});

test('placar ignora doc só com observacao', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1 }), base({ sku: 2 })] }, HOJE).itens;
  const p = placar(itens, { 1: { observacao: 'ver depois' }, 2: { destino: 'trocar' } });
  assert.equal(p.total, 100);
  assert.equal(p.decidido, 50);
  assert.equal(p.porDestino.trocar, 50);
});
test('placar só conta mercadoria', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1, familia: 'Imobilizado' })] }, HOJE).itens;
  assert.equal(placar(itens, {}).total, 0);
});

test('listaTroca: só decididos trocar, por valor desc', () => {
  const itens = classificar({ meta: {}, itens: [base({ sku: 1, cmc: 1 }), base({ sku: 2, cmc: 9 }), base({ sku: 3 })] }, HOJE).itens;
  const l = listaTroca(itens, { 1: { destino: 'trocar' }, 2: { destino: 'trocar' }, 3: { destino: 'liquidar' } });
  assert.deepEqual(l.map((x) => x.sku), [2, 1]);
});

test('vendaDirigidaPorCliente agrupa sem comprador', () => {
  const itens = classificar({ meta: {}, itens: [
    base({ sku: 1, q12: 1, clientes: [{ nome: 'ACME', ult: '2026-09-01', qtd: 1 }, { nome: 'BETA', ult: '2026-08-01', qtd: 2 }] }),
    base({ sku: 2 }),
  ] }, HOJE).itens;
  const g = vendaDirigidaPorCliente(itens, { 1: { destino: 'venda_dirigida' }, 2: { destino: 'venda_dirigida' } });
  const nomes = g.map((x) => x.cliente).sort();
  assert.deepEqual(nomes, ['ACME', 'BETA', 'sem comprador em 12m']);
});

test('diffContagem', () => {
  assert.equal(diffContagem(base({ saldo: 10, cmc: 5 }), null), null);
  assert.equal(diffContagem(base({ saldo: 10, cmc: 5 }), ''), null);
  assert.deepEqual(diffContagem(base({ saldo: 10, cmc: 5 }), 4), { dif_un: -6, dif_valor: -30 });
});

test('parseValorBR', () => {
  assert.equal(parseValorBR('1.234,56'), 1234.56);
  assert.equal(parseValorBR('300'), 300);
  assert.equal(parseValorBR(' R$ 12,5 '), 12.5);
  assert.equal(parseValorBR('abc'), null);
  assert.equal(parseValorBR(''), null);
  assert.equal(parseValorBR(null), null);
  assert.equal(parseValorBR(42), 42);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node --test docs/superpowers/raio-x-estoque-parado/; echo "exit=$?"`
Expected: FAIL (`Cannot find module .../logica.mjs`), `exit=1`.

- [ ] **Step 3: Implementar `logica.mjs`**

```js
// Lógica pura do Raio-X do estoque parado (spec 2026-10-14). Sem I/O:
// usada pelo gerador (Node), pela página (navegador) e pela medição.

export const TOP_N = 61;
export const DIAS_NOVO = 90;
export const DESTINOS = ['trocar', 'venda_dirigida', 'liquidar', 'manter_suspender_recompra', 'estrategico', 'erro_cadastro'];
export const ROTULOS = {
  trocar: 'Trocar', venda_dirigida: 'Venda dirigida', liquidar: 'Liquidar',
  manter_suspender_recompra: 'Manter · suspender recompra', estrategico: 'Estratégico',
  erro_cadastro: 'Erro de cadastro', novo_aguarde: 'Novo · aguarde', revisar: 'Revisar',
};
const RE_NAO_MERC = /MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY/i;
const SEM_COMPRADOR = 'sem comprador em 12m';

function diasEntre(data, hoje) {
  if (!data) return null;
  return Math.floor((Date.parse(hoje) - Date.parse(data)) / 86400000);
}

export function categorizar(it) {
  const d = it.descricao ?? '';
  if (it.familia === 'Imobilizado') return { categoria: 'nao_mercadoria', motivo: 'família Imobilizado' };
  const m = d.match(RE_NAO_MERC);
  if (m && it.q12 === 0) return { categoria: 'nao_mercadoria', motivo: `descrição contém ${m[0].toUpperCase()} e sem venda em 12m` };
  if (it.familia === 'Concentrados MixMachine') return { categoria: 'insumo_maquina', motivo: 'concentrado da MixMachine' };
  if (it.familia === 'Concentrados LC' && /^AT[LP]/i.test(d)) return { categoria: 'insumo_maquina', motivo: 'concentrado ATL/ATP da 2ª máquina' };
  if (/1000 ?KG/i.test(d)) return { categoria: 'granel', motivo: 'granel 1.000 kg para fracionar' };
  return { categoria: 'mercadoria', motivo: '' };
}

export function cobertura(it) {
  return it.q12 > 0 ? it.saldo / (it.q12 / 365) : null;
}

export function sugerirDestino(it, hoje) {
  const cad = diasEntre(it.cadastro_em, hoje);
  const ent = diasEntre(it.ult_entrada, hoje);
  if (cad !== null && cad < DIAS_NOVO) return { destino: 'novo_aguarde', motivo: `cadastrado há ${cad} dias` };
  if (ent !== null && ent < DIAS_NOVO) {
    return { destino: 'novo_aguarde', motivo: `entrada há ${ent} dias${it.q12 === 0 ? ' — recompra de item sem venda em 12m? revisar' : ''}` };
  }
  if ((it.unidades_venda ?? []).some((u) => u !== it.unidade_estoque)) {
    return { destino: 'revisar', motivo: 'unidade da venda ≠ unidade do estoque — cobertura não confiável' };
  }
  const cob = cobertura(it);
  if (it.q12 === 0 && /sayerlack/i.test(it.fornecedor ?? '')) return { destino: 'trocar', motivo: 'Sayerlack · 0 vendas em 12m → troca por crédito' };
  if (it.q12 > 0 && cob > 365) return { destino: 'venda_dirigida', motivo: `cobertura ${Math.round(cob)} dias · ${it.ncli} cliente(s) compraram` };
  if (it.q12 > 0 && cob > 180) return { destino: 'manter_suspender_recompra', motivo: `cobertura ${Math.round(cob)} dias · vende, mas não recomprar` };
  if (it.q12 === 0) {
    return { destino: 'liquidar', motivo: `0 vendas em 12m · sem comprador · fornecedor ${it.fornecedor ?? '?'} — informe se aceita troca` };
  }
  return { destino: 'revisar', motivo: `fora do motor com cobertura ${Math.round(cob)} dias` };
}

export function classificar(fatos, hoje) {
  const itens = fatos.itens.map((it) => {
    const c = categorizar(it);
    const s = c.categoria === 'mercadoria' ? sugerirDestino(it, hoje) : { destino: null, motivo: '' };
    return {
      ...it,
      valor: it.saldo * it.cmc,
      cobertura: cobertura(it),
      categoria: c.categoria, motivo_categoria: c.motivo,
      destino_sugerido: s.destino, motivo_destino: s.motivo,
      top: false,
    };
  }).sort((a, b) => b.valor - a.valor);
  itens.filter((i) => i.categoria === 'mercadoria').slice(0, TOP_N).forEach((i) => { i.top = true; });
  return { meta: fatos.meta, itens };
}

const decidido = (d) => Boolean(d && DESTINOS.includes(d.destino));

export function placar(itens, decisoes) {
  const p = { total: 0, decidido: 0, pendente: 0, porDestino: {}, topTotal: 0, topDecidido: 0 };
  for (const i of itens) {
    if (i.categoria !== 'mercadoria') continue;
    const d = decisoes[i.sku];
    p.total += i.valor;
    if (i.top) p.topTotal += i.valor;
    if (decidido(d)) {
      p.decidido += i.valor;
      if (i.top) p.topDecidido += i.valor;
      p.porDestino[d.destino] = (p.porDestino[d.destino] ?? 0) + i.valor;
    }
  }
  p.pendente = p.total - p.decidido;
  return p;
}

export function listaTroca(itens, decisoes) {
  return itens
    .filter((i) => decisoes[i.sku]?.destino === 'trocar')
    .map(({ sku, codigo, descricao, saldo, valor }) => ({ sku, codigo, descricao, saldo, valor }))
    .sort((a, b) => b.valor - a.valor);
}

export function vendaDirigidaPorCliente(itens, decisoes) {
  const grupos = new Map();
  for (const i of itens) {
    if (decisoes[i.sku]?.destino !== 'venda_dirigida') continue;
    const compradores = i.clientes?.length ? i.clientes : [{ nome: SEM_COMPRADOR, ult: null, qtd: 0 }];
    for (const c of compradores) {
      const g = grupos.get(c.nome) ?? { cliente: c.nome, valor: 0, itens: [] };
      g.itens.push({ codigo: i.codigo, descricao: i.descricao, saldo: i.saldo, valor: i.valor, ult: c.ult, qtd: c.qtd });
      g.valor += i.valor;
      grupos.set(c.nome, g);
    }
  }
  return [...grupos.values()].sort((a, b) => b.valor - a.valor);
}

export function diffContagem(it, qtdContada) {
  if (qtdContada === null || qtdContada === undefined || qtdContada === '') return null;
  const q = Number(qtdContada);
  if (!Number.isFinite(q)) return null;
  const dif = q - it.saldo;
  return { dif_un: dif, dif_valor: dif * it.cmc };
}

export function parseValorBR(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (s === null || s === undefined) return null;
  const limpo = String(s).replace(/R\$|\s/g, '');
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(limpo)) return null;
  return Number(limpo.replace(/\./g, '').replace(',', '.'));
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node --test docs/superpowers/raio-x-estoque-parado/; echo "exit=$?"`
Expected: todos `ok`, `# fail 0`, `exit=0` (colar a linha `exit=0`).

- [ ] **Step 5: Falsificar uma regra (controle vermelho)**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && git add docs/superpowers/raio-x-estoque-parado && git commit -qm "wip raio-x logica" && sed -i '' 's/cob > 365/cob > 3650/' docs/superpowers/raio-x-estoque-parado/logica.mjs && node --test docs/superpowers/raio-x-estoque-parado/ >/dev/null 2>&1; echo "sabotado exit=$?"; git checkout -- docs/superpowers/raio-x-estoque-parado/logica.mjs && node --test docs/superpowers/raio-x-estoque-parado/ >/dev/null 2>&1; echo "restaurado exit=$?"`
Expected: `sabotado exit=1` e `restaurado exit=0`.

- [ ] **Step 6: Commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && git reset -q --soft HEAD~1 && git add docs/superpowers/raio-x-estoque-parado && git commit -m "feat(raio-x): lógica pura de classificação, placar e listas do estoque parado

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fatos (SQL) + gerador do retrato com pré-voo

**Files:**
- Create: `docs/superpowers/raio-x-estoque-parado/fatos.sql`
- Create: `docs/superpowers/raio-x-estoque-parado/gerar.sh`
- Create: `docs/superpowers/raio-x-estoque-parado/gerar.mjs`
- Test: `docs/superpowers/raio-x-estoque-parado/gerar.test.mjs`

**Interfaces:**
- Consumes: `classificar` (Task 1).
- Produces: `$RAIOX_OUT/fatos.json` (`{meta:{gerado_em, synced_at_max, historico_desde, sem_custo:{n, skus}}, itens:[item]}`) e `$RAIOX_OUT/retrato.json` (saída de `classificar` + `meta.resumo`); `gerar.mjs` exporta `preVoo(fatos, agora:Date) → string[]` (lista de falhas; vazia = ok) e `resumo(retrato) → {porCategoria:Record<string,{n,valor}>, n, valor}`.

- [ ] **Step 1: Teste que falha para `preVoo` e `resumo`**

`docs/superpowers/raio-x-estoque-parado/gerar.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preVoo, resumo } from './gerar.mjs';

const agora = new Date('2026-10-14T23:00:00Z');
test('preVoo: sync velho falha', () => {
  const f = preVoo({ meta: { synced_at_max: '2026-10-13T20:00:00Z' }, itens: [{ sku: 1 }] }, agora);
  assert.ok(f.some((x) => x.includes('synced_at')));
});
test('preVoo: sync ausente falha (ausente ≠ fresco)', () => {
  assert.ok(preVoo({ meta: { synced_at_max: null }, itens: [{ sku: 1 }] }, agora).length > 0);
});
test('preVoo: zero itens falha', () => {
  assert.ok(preVoo({ meta: { synced_at_max: '2026-10-14T22:00:00Z' }, itens: [] }, agora).some((x) => x.includes('itens')));
});
test('preVoo: ok', () => {
  assert.deepEqual(preVoo({ meta: { synced_at_max: '2026-10-14T22:00:00Z' }, itens: [{ sku: 1 }] }, agora), []);
});
test('resumo soma por categoria', () => {
  const r = resumo({ itens: [{ categoria: 'mercadoria', valor: 10 }, { categoria: 'mercadoria', valor: 5 }, { categoria: 'granel', valor: 1 }] });
  assert.deepEqual(r.porCategoria.mercadoria, { n: 2, valor: 15 });
  assert.equal(r.n, 3);
  assert.equal(r.valor, 16);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node --test docs/superpowers/raio-x-estoque-parado/gerar.test.mjs; echo "exit=$?"`
Expected: FAIL (módulo não existe), `exit=1`.

- [ ] **Step 3: Escrever `fatos.sql`**

```sql
-- Fatos do Raio-X do estoque parado (spec 2026-10-14). READ-ONLY.
-- Saída: 1 linha 'json|<objeto>' + marcador 'fim|ok'. Regras NÃO vivem aqui (ver logica.mjs).
with e as (
  select ip.omie_codigo_produto::bigint sku, ip.saldo, ip.cmc
  from inventory_position ip where ip.account = 'oben' and ip.saldo > 0),
vh as (
  select * from v_venda_items_history_efetivo where empresa = 'OBEN'),
v as (
  select sku_codigo_omie sku, max(data_emissao) uv, sum(quantidade) q12,
         count(distinct cliente_codigo_omie) ncli,
         sum(valor_total) / nullif(sum(quantidade), 0) preco_medio_12m,
         array_agg(distinct sku_unidade) filter (where sku_unidade is not null) unidades
  from vh group by 1),
cli as (
  select sku, jsonb_agg(jsonb_build_object('nome', nome, 'ult', ult, 'qtd', qtd) order by qtd desc) clientes
  from (
    select sku_codigo_omie sku, cliente_razao_social nome, max(data_emissao)::date ult, sum(quantidade) qtd,
           row_number() over (partition by sku_codigo_omie order by sum(quantidade) desc) rn
    from vh group by 1, 2) x
  where rn <= 5 group by sku),
rec as (
  select distinct on (ri.produto_omie_id::text) ri.produto_omie_id::text pid,
         r.razao_social_emitente forn_rec, r.data_emissao::date ult_entrada
  from nfe_recebimento_itens ri join nfe_recebimentos r on r.id = ri.nfe_recebimento_id
  where ri.produto_omie_id is not null
  order by ri.produto_omie_id::text, r.data_emissao desc),
base as (
  select e.sku, p.codigo, p.descricao, p.familia, p.ativo, p.created_at::date cadastro_em,
         p.unidade unidade_estoque, coalesce(v.unidades, '{}') unidades_venda,
         coalesce(sp.fornecedor_nome, rec.forn_rec, 'marca: ' || nullif(p.metadata->>'marca', '')) fornecedor,
         rec.ult_entrada, e.saldo, e.cmc, sp.sku_codigo_omie is not null motor, sp.classe_abc,
         v.uv::date ult_venda, coalesce(v.q12, 0) q12, coalesce(v.ncli, 0) ncli,
         round(v.preco_medio_12m::numeric, 4) preco_medio_12m, coalesce(cli.clientes, '[]') clientes,
         case when coalesce(v.q12, 0) > 0 then e.saldo / (v.q12 / 365.0) end cob
  from e
  left join sku_parametros sp on sp.empresa = 'OBEN' and sp.sku_codigo_omie = e.sku
  left join lateral (select * from omie_products op
                     where op.omie_codigo_produto = e.sku and op.account = 'oben' limit 1) p on true
  left join v on v.sku = e.sku
  left join cli on cli.sku = e.sku
  left join rec on rec.pid = e.sku::text),
universo as (
  select * from base where not motor or q12 = 0 or cob > 180)
select 'json', jsonb_build_object(
  'meta', jsonb_build_object(
    'gerado_em', now(),
    'synced_at_max', (select max(synced_at) from inventory_position where account = 'oben'),
    'historico_desde', (select min(data_emissao) from vh),
    'sem_custo', (select jsonb_build_object('n', count(*), 'skus', coalesce(jsonb_agg(sku), '[]'))
                  from universo where cmc is null or cmc <= 0)),
  'itens', (select coalesce(jsonb_agg(to_jsonb(u) - 'cob'), '[]') from universo u where cmc > 0));
select 'fim', 'ok';
```

- [ ] **Step 4: Escrever `gerar.mjs`**

```js
// Gera retrato.json a partir de fatos.json: pré-voo → classificar → resumo.
// Uso: node gerar.mjs <fatos.json> <retrato.json> [hoje YYYY-MM-DD]
import { readFileSync, writeFileSync } from 'node:fs';
import { classificar } from './logica.mjs';

export function preVoo(fatos, agora) {
  const falhas = [];
  const s = fatos.meta?.synced_at_max;
  if (!s) falhas.push('synced_at ausente — não sei se o estoque está fresco');
  else if (agora - new Date(s) > 24 * 3600 * 1000) falhas.push(`synced_at ${s} tem mais de 24h`);
  if (!fatos.itens?.length) falhas.push('0 itens no universo — consulta suspeita');
  return falhas;
}

export function resumo(retrato) {
  const porCategoria = {};
  let n = 0;
  let valor = 0;
  for (const i of retrato.itens) {
    const c = (porCategoria[i.categoria] ??= { n: 0, valor: 0 });
    c.n += 1; c.valor += i.valor; n += 1; valor += i.valor;
  }
  return { porCategoria, n, valor };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , entrada, saida, hojeArg] = process.argv;
  const fatos = JSON.parse(readFileSync(entrada, 'utf8'));
  const falhas = preVoo(fatos, new Date());
  if (falhas.length) {
    console.error('PRÉ-VOO FALHOU:\n- ' + falhas.join('\n- '));
    process.exit(2);
  }
  const hoje = hojeArg ?? new Date().toISOString().slice(0, 10);
  const retrato = classificar(fatos, hoje);
  retrato.meta = { ...retrato.meta, hoje, resumo: resumo(retrato) };
  writeFileSync(saida, JSON.stringify(retrato));
  const r = retrato.meta.resumo;
  for (const [k, v] of Object.entries(r.porCategoria)) console.log(`${k}|${v.n}|${Math.round(v.valor)}`);
  console.log(`total|${r.n}|${Math.round(r.valor)}`);
  console.log(`sem_custo|${fatos.meta.sem_custo.n}`);
  console.log('RETRATO-OK');
}
```

- [ ] **Step 5: Escrever `gerar.sh`**

```bash
#!/usr/bin/env bash
# Gera fatos.json (psql-ro, read-only) e retrato.json (node). Saída em $RAIOX_OUT.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${RAIOX_OUT:?defina RAIOX_OUT (diretório fora do repo ou ignorado)}"
mkdir -p "$OUT"
RAW="$OUT/fatos.raw.txt"
~/.config/afiacao/psql-ro -At -F'|' -v ON_ERROR_STOP=1 -f "$DIR/fatos.sql" > "$RAW" 2>&1 || { echo "psql falhou:"; head -c 2000 "$RAW"; exit 1; }
grep -q '^fim|ok$' "$RAW" || { echo "sem marcador fim|ok:"; head -c 2000 "$RAW"; exit 1; }
grep '^json|' "$RAW" | sed 's/^json|//' > "$OUT/fatos.json"
[ -s "$OUT/fatos.json" ] || { echo "fatos.json vazio"; exit 1; }
node "$DIR/gerar.mjs" "$OUT/fatos.json" "$OUT/retrato.json" "$@"
```

Se o wrapper `psql-ro` não aceitar `-f`, trocar a linha por `... -v ON_ERROR_STOP=1 < "$DIR/fatos.sql" > "$RAW" 2>&1` (mesmo marcador).

- [ ] **Step 6: Testes passam**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && chmod +x docs/superpowers/raio-x-estoque-parado/gerar.sh && node --test docs/superpowers/raio-x-estoque-parado/; echo "exit=$?"`
Expected: `# fail 0`, `exit=0`.

- [ ] **Step 7: Rodar contra prod (read-only) e validar o retrato**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && RAIOX_OUT=<scratchpad>/raiox bash docs/superpowers/raio-x-estoque-parado/gerar.sh; echo "exit=$?"`
Expected: linhas `categoria|n|valor`, `RETRATO-OK`, `exit=0`. **Critério:** `total` entre R$ 334k e R$ 348k e ~611 itens (±2% do diagnóstico); fora disso, explicar a diferença antes de seguir (ex.: o refinamento da CARTELA move ~R$ 6k de não-mercadoria para mercadoria — isso muda categorias, não o total).

- [ ] **Step 8: Conferência manual de 10 SKUs do Top 61**

Run (ajustar a lista de SKUs pelos 10 primeiros `top:true` do retrato):
```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node -e "const r=require('<scratchpad>/raiox/retrato.json');console.log(r.itens.filter(i=>i.top).slice(0,10).map(i=>[i.sku,i.saldo,i.cmc,Math.round(i.valor),i.destino_sugerido].join('|')).join('\n'))"
```
e, para os mesmos SKUs:
```bash
~/.config/afiacao/psql-ro -At -F'|' -v ON_ERROR_STOP=1 <<'SQL' | head -c 2000
select omie_codigo_produto, saldo, cmc, round(saldo*cmc) from inventory_position where account='oben' and omie_codigo_produto::bigint in (<10 skus>);
select 'fim','ok';
SQL
```
Expected: saldo, cmc e valor idênticos nos 10. Separar 3 (código + descrição + saldo) para o founder bater no Omie.

- [ ] **Step 9: Commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && git add docs/superpowers/raio-x-estoque-parado && git status --short docs/superpowers/raio-x-estoque-parado && git commit -m "feat(raio-x): fatos read-only + gerador do retrato com pré-voo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected no `status`: só `.sql`, `.sh`, `.mjs` — **nenhum `.json`**.

---

### Task 3: Página (Artifact) com decisões no `db`

**Files:**
- Create: `docs/superpowers/raio-x-estoque-parado/index.html`
- Publica: `index.html` + `logica.mjs` + `$RAIOX_OUT/retrato.json` (supporting file, não commitado)

**Interfaces:**
- Consumes: `classificar`-output (`retrato.json`), `placar`, `listaTroca`, `vendaDirigidaPorCliente`, `diffContagem`, `parseValorBR`, `DESTINOS`, `ROTULOS` (Task 1).
- Produces: coleção `decisoes` no db do Artifact, doc id = `String(sku)`, corpo `Decisao` (Task 1). Lida pela Task 4 via `ArtifactData list`.

- [ ] **Step 1: Carregar a skill `artifact-design`** (obrigatório antes de escrever a página) e ajustar tokens/tipografia do esqueleto abaixo ao que ela pedir, sem mudar a lógica.

- [ ] **Step 2: Escrever `index.html`**

```html
<title>Raio-X estoque parado</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#1d4ed8;--ok:#15803d;--warn:#b45309;--bad:#b91c1c;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0 0 4px}.muted{color:var(--muted)}.num{font-variant-numeric:tabular-nums}
.placar{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));margin:12px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:10px}.kpi b{display:block;font-size:18px}
.barra{height:6px;background:var(--line);border-radius:3px;overflow:hidden}.barra i{display:block;height:100%;background:var(--accent)}
.tabs,.filtros{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
button,select,input{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-height:40px}
button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent);font-weight:600}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px;margin:8px 0}
.card h3{font-size:15px;margin:0 0 4px}.linha{display:flex;gap:12px;flex-wrap:wrap}.tag{font-size:12px;padding:2px 6px;border-radius:4px;border:1px solid var(--line)}
.tag.top{border-color:var(--accent);color:var(--accent)}.decidido{border-left:3px solid var(--ok)}
.acoes{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.acoes button{font-size:13px}
.aviso{padding:10px;border:1px solid var(--warn);border-radius:6px;color:var(--warn);margin:8px 0}
details summary{cursor:pointer;color:var(--accent);margin-top:6px}
table{width:100%;border-collapse:collapse}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left}
dialog{max-width:min(720px,calc(100vw - 32px));width:100%;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px}
</style>
<main>
  <h1>Raio-X do estoque parado</h1>
  <p class="muted" id="meta"></p>
  <div id="aviso"></div>
  <section class="placar" id="placar"></section>
  <div class="tabs">
    <button data-aba="merc" aria-pressed="true">Mercadoria</button>
    <button data-aba="cont" aria-pressed="false">Contagem física e reclassificação</button>
    <button id="btnTroca">Lista de troca Sayerlack</button>
    <button id="btnVenda">Venda dirigida por cliente</button>
  </div>
  <div class="filtros" id="filtros">
    <select id="fDestino"><option value="">Todos os destinos sugeridos</option></select>
    <select id="fForn"><option value="">Todos os fornecedores</option></select>
    <select id="fEstado"><option value="">Pendentes e decididos</option><option value="pend">Pendentes</option><option value="dec">Decididos</option></select>
    <label><input type="checkbox" id="fTop"> Só Top 61</label>
  </div>
  <div id="lista"></div>
  <button id="mais" hidden>Mostrar mais</button>
  <dialog id="dlg"><div id="dlgCorpo"></div><div class="acoes"><button id="dlgCopiar">Copiar</button><button id="dlgFechar">Fechar</button></div></dialog>
</main>
<script type="module">
import { placar, listaTroca, vendaDirigidaPorCliente, diffContagem, parseValorBR, DESTINOS, ROTULOS } from './logica.mjs';

const brl = (v) => v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const num = (v, d = 1) => v == null ? '—' : Number(v).toLocaleString('pt-BR', { maximumFractionDigits: d });
const dt = (s) => s ? new Date(s + (s.length === 10 ? 'T12:00:00' : '')).toLocaleDateString('pt-BR') : '—';
const el = (tag, attrs = {}, ...filhos) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v); } for (const f of filhos) e.append(f ?? ''); return e; };

const retrato = await (await fetch('retrato.json')).json();
const itens = retrato.itens;
let decisoes = {};
let db = null;
let uid = null;
let somenteLeitura = true;
let aba = 'merc';
let limite = 100;

document.getElementById('meta').textContent =
  `Retrato de ${dt(retrato.meta.hoje)} · estoque sincronizado em ${new Date(retrato.meta.synced_at_max).toLocaleString('pt-BR')} · vendas: sem venda em 12 meses = desde ${dt(String(retrato.meta.historico_desde).slice(0, 10))} · ${retrato.meta.sem_custo.n} SKU(s) sem custo, não avaliados`;

const fDestino = document.getElementById('fDestino');
for (const d of [...DESTINOS, 'novo_aguarde', 'revisar']) fDestino.append(el('option', { value: d }, ROTULOS[d]));
const fForn = document.getElementById('fForn');
for (const f of [...new Set(itens.filter((i) => i.categoria === 'mercadoria').map((i) => i.fornecedor ?? '?'))].sort()) fForn.append(el('option', { value: f }, f));

function renderPlacar() {
  const p = placar(itens, decisoes);
  const pct = p.total ? Math.round((p.decidido / p.total) * 100) : 0;
  const box = document.getElementById('placar');
  box.replaceChildren(
    el('div', { class: 'kpi' }, 'Decidido', el('b', { class: 'num' }, `${brl(p.decidido)} / ${brl(p.total)}`), el('div', { class: 'barra' }, el('i', { style: `width:${pct}%` }))),
    el('div', { class: 'kpi' }, 'Top 61 decidido', el('b', { class: 'num' }, `${brl(p.topDecidido)} / ${brl(p.topTotal)}`)),
    ...DESTINOS.map((d) => el('div', { class: 'kpi' }, ROTULOS[d], el('b', { class: 'num' }, brl(p.porDestino[d] ?? 0)))),
  );
}

async function salvar(sku, patch) {
  if (!db || somenteLeitura) return;
  const atual = decisoes[sku] ?? {};
  const corpo = { ...atual, ...patch, decidido_por: uid, decidido_em: new Date().toISOString() };
  try {
    await db.collection('decisoes').doc(String(sku)).set(corpo);
  } catch (e) {
    if (e?.code === 'invalid_argument') { somenteLeitura = true; avisar('Você não tem permissão para registrar decisões nesta página.'); render(); }
    else avisar(`Não salvou (${e?.code ?? 'erro'}). Tente de novo.`);
  }
}

function avisar(msg) { document.getElementById('aviso').replaceChildren(msg ? el('div', { class: 'aviso' }, msg) : ''); }

function filtrados() {
  const dest = fDestino.value, forn = fForn.value, est = document.getElementById('fEstado').value, top = document.getElementById('fTop').checked;
  return itens.filter((i) => {
    if (aba === 'merc' ? i.categoria !== 'mercadoria' : i.categoria === 'mercadoria') return false;
    if (aba !== 'merc') return true;
    const dec = DESTINOS.includes(decisoes[i.sku]?.destino);
    if (dest && i.destino_sugerido !== dest) return false;
    if (forn && (i.fornecedor ?? '?') !== forn) return false;
    if (est === 'pend' && dec) return false;
    if (est === 'dec' && !dec) return false;
    if (top && !i.top) return false;
    return true;
  });
}

function cardMercadoria(i) {
  const d = decisoes[i.sku] ?? {};
  const escolhido = DESTINOS.includes(d.destino) ? d.destino : null;
  const card = el('article', { class: 'card' + (escolhido ? ' decidido' : '') },
    el('h3', {}, `${i.codigo ?? i.sku} · ${i.descricao}`),
    el('div', { class: 'linha muted' },
      i.top ? el('span', { class: 'tag top' }, 'Top 61') : '',
      el('span', {}, i.familia ?? '—'), el('span', {}, i.fornecedor ?? 'fornecedor ?')),
    el('div', { class: 'linha num' },
      el('span', {}, `saldo ${num(i.saldo)}`), el('b', {}, brl(i.valor)),
      el('span', {}, `última venda ${dt(i.ult_venda)}`), el('span', {}, `cobertura ${i.cobertura == null ? 'sem venda em 12m' : num(i.cobertura, 0) + ' d'}`)),
    el('div', {}, el('b', {}, `Sugestão: ${ROTULOS[i.destino_sugerido]}`), ' — ', el('span', { class: 'muted' }, i.motivo_destino)),
  );
  if (i.clientes?.length) {
    const t = el('table', {}, el('tr', {}, el('th', {}, 'Cliente'), el('th', {}, 'Última'), el('th', {}, 'Qtd 12m')));
    for (const c of i.clientes) t.append(el('tr', {}, el('td', {}, c.nome), el('td', {}, dt(c.ult)), el('td', { class: 'num' }, num(c.qtd))));
    card.append(el('details', {}, el('summary', {}, `Quem comprou (${i.ncli})`), t));
  }
  if (!somenteLeitura) {
    const acoes = el('div', { class: 'acoes' });
    for (const dst of DESTINOS) {
      acoes.append(el('button', { 'aria-pressed': String(escolhido === dst), onclick: () => salvar(i.sku, { destino: dst }) },
        (escolhido === null && i.destino_sugerido === dst ? '★ ' : '') + ROTULOS[dst]));
    }
    card.append(acoes);
    card.append(el('input', { placeholder: 'Observação', value: d.observacao ?? '', onchange: (ev) => salvar(i.sku, { observacao: ev.target.value }) }));
    if (!i.fornecedor || i.fornecedor.startsWith('marca:')) {
      card.append(el('input', { placeholder: 'Fornecedor (se souber)', value: d.fornecedor_informado ?? '', onchange: (ev) => salvar(i.sku, { fornecedor_informado: ev.target.value }) }));
    }
    if (escolhido === 'trocar') {
      card.append(el('input', { placeholder: 'Troca concluída: crédito R$', inputmode: 'decimal', value: d.credito_troca ?? '',
        onchange: (ev) => { const v = parseValorBR(ev.target.value); if (ev.target.value && v === null) { avisar('Crédito inválido — use por exemplo 1.234,56'); return; } salvar(i.sku, { credito_troca: v }); } }));
    }
  } else if (escolhido) {
    card.append(el('div', {}, `Decidido: ${ROTULOS[escolhido]}`));
  }
  return card;
}

function cardContagem(i) {
  const d = decisoes[i.sku] ?? {};
  const dif = diffContagem(i, d.qtd_contada);
  const card = el('article', { class: 'card' },
    el('h3', {}, `${i.codigo ?? i.sku} · ${i.descricao}`),
    el('div', { class: 'linha muted' }, el('span', { class: 'tag' }, i.categoria === 'nao_mercadoria' ? 'Reclassificar com contador' : 'Contagem física'), el('span', {}, i.motivo_categoria)),
    el('div', { class: 'linha num' }, el('span', {}, `saldo Omie ${num(i.saldo)}`), el('b', {}, brl(i.valor)),
      dif ? el('span', { style: `color:var(${dif.dif_un < 0 ? '--bad' : '--ok'})` }, `diferença ${num(dif.dif_un)} un · ${brl(dif.dif_valor)}`) : ''),
  );
  if (!somenteLeitura) {
    card.append(el('input', { placeholder: 'Quantidade contada', inputmode: 'decimal', value: d.qtd_contada ?? '',
      onchange: (ev) => { const v = parseValorBR(ev.target.value); salvar(i.sku, { qtd_contada: v }); } }));
  }
  return card;
}

function render() {
  renderPlacar();
  document.getElementById('filtros').hidden = aba !== 'merc';
  const lista = filtrados();
  const box = document.getElementById('lista');
  box.replaceChildren(...lista.slice(0, limite).map((i) => (aba === 'merc' ? cardMercadoria(i) : cardContagem(i))));
  document.getElementById('mais').hidden = lista.length <= limite;
}

function abrirDialogo(titulo, linhas, texto) {
  const corpo = document.getElementById('dlgCorpo');
  corpo.replaceChildren(el('h3', {}, titulo), ...linhas);
  document.getElementById('dlgCopiar').onclick = () => navigator.clipboard?.writeText(texto);
  document.getElementById('dlg').showModal();
}

document.getElementById('btnTroca').onclick = () => {
  const l = listaTroca(itens, decisoes);
  const t = el('table', {}, el('tr', {}, el('th', {}, 'Código'), el('th', {}, 'Descrição'), el('th', {}, 'Qtd'), el('th', {}, 'Valor')));
  for (const r of l) t.append(el('tr', {}, el('td', {}, r.codigo), el('td', {}, r.descricao), el('td', { class: 'num' }, num(r.saldo)), el('td', { class: 'num' }, brl(r.valor))));
  const texto = l.map((r) => `${r.codigo}\t${r.descricao}\t${r.saldo}\t${r.valor.toFixed(2)}`).join('\n');
  abrirDialogo(`Troca Sayerlack — ${l.length} SKUs · ${brl(l.reduce((s, r) => s + r.valor, 0))}`, [t], texto);
};
document.getElementById('btnVenda').onclick = () => {
  const g = vendaDirigidaPorCliente(itens, decisoes);
  const blocos = g.map((c) => el('details', {}, el('summary', {}, `${c.cliente} — ${c.itens.length} SKU(s) · ${brl(c.valor)}`),
    el('ul', {}, ...c.itens.map((x) => el('li', {}, `${x.codigo} · ${x.descricao} · saldo ${num(x.saldo)}`)))));
  const texto = g.map((c) => `${c.cliente}\n` + c.itens.map((x) => `  ${x.codigo}\t${x.descricao}\t${x.saldo}`).join('\n')).join('\n\n');
  abrirDialogo(`Venda dirigida — ${g.length} cliente(s)`, blocos, texto);
};
document.getElementById('dlgFechar').onclick = () => document.getElementById('dlg').close();
for (const b of document.querySelectorAll('[data-aba]')) b.onclick = () => { aba = b.dataset.aba; limite = 100; for (const x of document.querySelectorAll('[data-aba]')) x.setAttribute('aria-pressed', String(x === b)); render(); };
for (const id of ['fDestino', 'fForn', 'fEstado', 'fTop']) document.getElementById(id).onchange = () => { limite = 100; render(); };
document.getElementById('mais').onclick = () => { limite += 100; render(); };

render(); // primeiro desenho sem db (modo leitura)

(async () => {
  db = await window.claude?.use?.('db') ?? null;
  const user = await window.claude?.use?.('user') ?? null;
  if (!db) { avisar('Decisões indisponíveis nesta visualização — mostrando só o retrato.'); return; }
  uid = user ? await user.id() : null;
  const pode = user ? await user.can('data.write') : null;
  somenteLeitura = pode === false;
  db.collection('decisoes').limit(1000).onSnapshot(
    (snap) => { decisoes = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])); render(); },
    (e) => avisar(`Conexão com as decisões caiu (${e.code}). Recarregue a página.`),
  );
})();
</script>
```

- [ ] **Step 3: Publicar**

Artifact `publish` com `file_path: docs/superpowers/raio-x-estoque-parado/index.html`, `files: {"logica.mjs": {"from": "docs/superpowers/raio-x-estoque-parado/logica.mjs", "contentType": "text/javascript"}, "retrato.json": "<scratchpad>/raiox/retrato.json"}`, `capabilities: {"db": {}, "user": {}}`, `icon: "chart"`, `description: "Estoque parado da Oben classificado por SKU, com decisão registrada por destino."`.

- [ ] **Step 4: Teste funcional (navegador do app)**

1. Abrir a URL publicada em desktop e em `resize_window preset mobile`: sem scroll horizontal; placar e cards legíveis.
2. Placar: `Decidido R$ 0 / ~R$ 246k`; Top 61 ≈ metade.
3. Decidir 1 SKU como `Trocar` → recarregar → continua decidido; placar de "Trocar" = valor do card.
4. Digitar crédito `1.234,56` → recarregar → `ArtifactData list collection=decisoes` mostra `credito_troca: 1234.56`; digitar `abc` → aviso "Crédito inválido", nada gravado.
5. Escrever só observação num 2º SKU → placar **não** muda (Review Focus 1).
6. Decidir um SKU sem compradores como `Venda dirigida` → a lista por cliente mostra "sem comprador em 12m" (Review Focus 5).
7. Aba Contagem: digitar quantidade → diferença em un e R$ aparece.
8. Abrir as duas listas, conferir 1 linha de cada contra o card.
9. Modo sem db (Review Focus 4): conferir pelo código que `db === null` cai em `avisar(...)` e em `somenteLeitura = true` sem botões (render inicial roda antes do `use`); na verificação, a primeira pintura já mostra os cards sem botões.
10. **Limpar**: `ArtifactData delete` em cada doc de teste; `list` final = 0 docs.

Expected: os 10 itens conferidos; colar o `list` final vazio.

- [ ] **Step 5: Commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && git add docs/superpowers/raio-x-estoque-parado/index.html && git commit -m "feat(raio-x): página de decisão do estoque parado (Artifact)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Medição T+6 semanas (pronta agora, rodada depois)

**Files:**
- Create: `docs/superpowers/raio-x-estoque-parado/medicao.sql`
- Create: `docs/superpowers/raio-x-estoque-parado/medir.mjs`
- Modify: `docs/superpowers/raio-x-estoque-parado/logica.mjs` (adicionar `medir`)
- Modify: `docs/superpowers/raio-x-estoque-parado/logica.test.mjs`
- Create: `docs/superpowers/raio-x-estoque-parado/LEIA-ME.md`

**Interfaces:**
- Consumes: `retrato.json` (lido do Artifact com `Artifact read path=retrato.json`), decisões (`ArtifactData list decisoes` salvo como JSON `{<sku>: Decisao}`), saída de `medicao.sql`.
- Produces: `medir(retrato, decisoes, atual:Record<string,{saldo, qtd_vendida, receita, compras:string[]}>) → {vendido, liquidado, margem_sacrificada, trocado, caixa_liberado, parado, reclassificado_nao_caixa, contradicoes:[{sku, destino, pedido_em}]}`.

- [ ] **Step 1: Testes que falham**

Acrescentar a `logica.test.mjs`:
```js
import { medir } from './logica.mjs';

const ret = (o) => ({ meta: { hoje: '2026-10-14' }, itens: [{ sku: 1, categoria: 'mercadoria', saldo: 10, cmc: 5, valor: 50, preco_medio_12m: 10, ...o }] });

test('medir limita vendido ao saldo do retrato', () => {
  const m = medir(ret(), {}, { 1: { saldo: 4, qtd_vendida: 30, receita: 300, compras: [] } });
  assert.equal(m.vendido, 50);
  assert.equal(m.liquidado, 0);
});
test('medir separa liquidado e margem sacrificada', () => {
  const m = medir(ret(), {}, { 1: { saldo: 6, qtd_vendida: 4, receita: 20, compras: [] } }); // 5/un < 90% de 10
  assert.equal(m.liquidado, 20);
  assert.equal(m.vendido, 0);
  assert.equal(m.margem_sacrificada, 4 * 10 - 20);
});
test('medir soma crédito de troca e não confunde com reclassificação', () => {
  const r = ret();
  r.itens.push({ sku: 2, categoria: 'nao_mercadoria', saldo: 1, cmc: 100, valor: 100 });
  const m = medir(r, { 1: { destino: 'trocar', credito_troca: 30 } }, { 1: { saldo: 10, qtd_vendida: 0, receita: 0, compras: [] } });
  assert.equal(m.trocado, 30);
  assert.equal(m.caixa_liberado, 30);
  assert.equal(m.reclassificado_nao_caixa, 100);
});
test('medir acusa recompra após decisão', () => {
  const m = medir(ret(), { 1: { destino: 'liquidar', decidido_em: '2026-10-20T10:00:00Z' } },
    { 1: { saldo: 10, qtd_vendida: 0, receita: 0, compras: ['2026-10-19T00:00:00Z', '2026-11-02T00:00:00Z'] } });
  assert.deepEqual(m.contradicoes, [{ sku: 1, destino: 'liquidar', pedido_em: '2026-11-02T00:00:00Z' }]);
});
test('medir: SKU ausente da medição atual não vira zero', () => {
  const m = medir(ret(), {}, {});
  assert.equal(m.vendido, 0);
  assert.equal(m.parado, 50);
  assert.deepEqual(m.sem_medicao, [1]);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node --test docs/superpowers/raio-x-estoque-parado/; echo "exit=$?"`
Expected: FAIL (`medir` não exportado), `exit=1`.

- [ ] **Step 3: Implementar `medir` em `logica.mjs`**

```js
const CONTRADICAO = ['trocar', 'liquidar', 'manter_suspender_recompra'];
const LIMIAR_LIQUIDACAO = 0.9;

export function medir(retrato, decisoes, atual) {
  const m = { vendido: 0, liquidado: 0, margem_sacrificada: 0, trocado: 0, caixa_liberado: 0, parado: 0,
    reclassificado_nao_caixa: 0, contradicoes: [], sem_medicao: [] };
  for (const i of retrato.itens) {
    if (i.categoria === 'nao_mercadoria') { m.reclassificado_nao_caixa += i.valor; continue; }
    if (i.categoria !== 'mercadoria') continue;
    const d = decisoes[i.sku] ?? {};
    const a = atual[i.sku];
    if (!a) { m.sem_medicao.push(i.sku); m.parado += i.valor; continue; }
    const qtd = Math.min(a.qtd_vendida, i.saldo);
    const custo = qtd * i.cmc;
    const precoPeriodo = a.qtd_vendida > 0 ? a.receita / a.qtd_vendida : null;
    if (precoPeriodo !== null && i.preco_medio_12m && precoPeriodo < LIMIAR_LIQUIDACAO * i.preco_medio_12m) {
      m.liquidado += custo;
      m.margem_sacrificada += qtd * i.preco_medio_12m - (a.receita * qtd) / a.qtd_vendida;
    } else {
      m.vendido += custo;
    }
    if (d.destino === 'trocar' && typeof d.credito_troca === 'number') m.trocado += d.credito_troca;
    m.parado += Math.min(a.saldo, i.saldo) * i.cmc;
    if (CONTRADICAO.includes(d.destino) && d.decidido_em) {
      for (const p of a.compras ?? []) if (p > d.decidido_em) m.contradicoes.push({ sku: i.sku, destino: d.destino, pedido_em: p });
    }
  }
  m.caixa_liberado = m.vendido + m.liquidado + m.trocado;
  return m;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && node --test docs/superpowers/raio-x-estoque-parado/; echo "exit=$?"`
Expected: `# fail 0`, `exit=0`.

- [ ] **Step 5: `medicao.sql` e `medir.mjs`**

`medicao.sql` (a data do retrato entra por `-v desde=YYYY-MM-DD`):
```sql
-- Medição do Raio-X: saldo atual, vendas e compras desde o retrato. READ-ONLY.
with s as (select omie_codigo_produto::bigint sku, saldo from inventory_position where account = 'oben'),
v as (select sku_codigo_omie sku, sum(quantidade) qtd, sum(valor_total) receita
      from v_venda_items_history_efetivo where empresa = 'OBEN' and data_emissao > :'desde'::date group by 1),
c as (select sku_codigo_omie sku, jsonb_agg(criado_em order by criado_em) compras
      from pedido_compra_item where criado_em > :'desde'::date group by 1)
select 'json', jsonb_object_agg(s.sku, jsonb_build_object(
  'saldo', s.saldo, 'qtd_vendida', coalesce(v.qtd, 0), 'receita', coalesce(v.receita, 0), 'compras', coalesce(c.compras, '[]')))
from s left join v using (sku) left join c using (sku);
select 'fim', 'ok';
```

`medir.mjs`:
```js
// Uso: node medir.mjs <retrato.json> <decisoes.json> <atual.json>
import { readFileSync } from 'node:fs';
import { medir } from './logica.mjs';
const [, , r, d, a] = process.argv;
const m = medir(JSON.parse(readFileSync(r, 'utf8')), JSON.parse(readFileSync(d, 'utf8')), JSON.parse(readFileSync(a, 'utf8')));
const brl = (v) => Math.round(v).toLocaleString('pt-BR');
console.log(`caixa_liberado|${brl(m.caixa_liberado)}`);
console.log(`  vendido|${brl(m.vendido)}\n  liquidado|${brl(m.liquidado)} (margem sacrificada ${brl(m.margem_sacrificada)})\n  trocado|${brl(m.trocado)}`);
console.log(`continua_parado|${brl(m.parado)}`);
console.log(`reclassificado_nao_caixa|${brl(m.reclassificado_nao_caixa)} (melhora DIO, NÃO é caixa)`);
console.log(`sem_medicao|${m.sem_medicao.length}`);
console.log(`contradicoes|${m.contradicoes.length}`);
for (const c of m.contradicoes) console.log(`  ${c.sku}|${c.destino}|${c.pedido_em}`);
console.log('MEDICAO-OK');
```

- [ ] **Step 6: Ensaio da medição hoje (deve dar ~zero)**

Run: `cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && ~/.config/afiacao/psql-ro -At -F'|' -v ON_ERROR_STOP=1 -v desde=2026-10-14 -f docs/superpowers/raio-x-estoque-parado/medicao.sql > <scratchpad>/raiox/med.raw 2>&1; grep -q '^fim|ok$' <scratchpad>/raiox/med.raw && grep '^json|' <scratchpad>/raiox/med.raw | sed 's/^json|//' > <scratchpad>/raiox/atual.json && echo '{}' > <scratchpad>/raiox/decisoes.json && node docs/superpowers/raio-x-estoque-parado/medir.mjs <scratchpad>/raiox/retrato.json <scratchpad>/raiox/decisoes.json <scratchpad>/raiox/atual.json; echo "exit=$?"`
Expected: `caixa_liberado` ≈ 0 (só vendas de hoje), `continua_parado` ≈ total de mercadoria, `MEDICAO-OK`, `exit=0`.

- [ ] **Step 7: `LEIA-ME.md` (o roteiro de T+6 semanas)**

```markdown
# Raio-X do estoque parado — como medir

Spec: `docs/superpowers/specs/2026-10-14-raio-x-estoque-parado-design.md` · Plano: `docs/superpowers/plans/2026-10-14-raio-x-estoque-parado.md`
Artifact: <URL publicada na Task 3>

Medição (a partir de 2026-11-25), tudo read-only:
1. `Artifact read url=<URL> path=retrato.json` → salvar em `$RAIOX_OUT/retrato.json`.
2. `ArtifactData list collection=decisoes` → salvar como `{"<sku>": {...}}` em `$RAIOX_OUT/decisoes.json`.
3. `psql-ro -v desde=<meta.hoje do retrato> -f medicao.sql` → `atual.json` (mesma extração do passo 6 da Task 4 do plano).
4. `node medir.mjs retrato.json decisoes.json atual.json` → exige `MEDICAO-OK`.
Meta: 100% do Top 61 decidido e caixa_liberado ≥ R$ 60k. Portão da fase B (ferramenta) = essa meta medida.
```

- [ ] **Step 8: Commit**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/beautiful-mclaren-3d42cf && git add docs/superpowers/raio-x-estoque-parado && git status --short docs/superpowers/raio-x-estoque-parado && git commit -m "feat(raio-x): medição do caixa liberado (T+6 semanas) e roteiro

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
Expected no `status`: nenhum `.json`.

---

### Task 5: Entrega

- [ ] **Step 1:** Abrir PR (não-draft auto-mergeia: são só docs + scripts fora do app) com spec, plano e `raio-x-estoque-parado/`; ligar Auto-fix (`set_monitor`). Re-conferir `gh pr list` antes do `create`.
- [ ] **Step 2:** Mensagem ao founder: link do Artifact; 3 SKUs para bater no Omie; o refinamento da CARTELA (Global Constraints); a data da medição (2026-11-25); a meta R$ 60k.
```

# Drill de Variância por Categoria — Design (Orçamento Rolling, passo focado)

> **Status:** aprovado pelo founder (design). Metodologia revisada por Codex (consult). Próximo: Codex no spec → plano → Codex no plano → execução subagent-driven → Codex adversarial → PR.

## Objetivo

Na seção "Forecast de aterrissagem" (`/financeiro/orcamento`), quando uma linha de DRE **fura a meta**, o founder clica e vê **de quais categorias do Omie** vem o realizado daquela linha e **quanto cada uma mudou vs o ano anterior** (mesmo período). Serve para **agir** (cortar/renegociar onde dói).

## Princípio central (Codex P1.2 — o nó da honestidade)

**O drill explica o REALIZADO YTD, NÃO a variância anual.** A variância é `landing − orçado`, mas categoria só existe no realizado dos meses fechados (não projetamos por categoria). A UI separa **3 blocos** e nunca faz as categorias somarem no landing (isso fabricaria precisão):

1. **Variância anual projetada** (contexto, passthrough do `ForecastLinha`): `landing − orçado`, `favoravel`, `fura_meta`.
2. **Realizado YTD por categoria** (a decomposição): meses **fechados** decompostos por `categoria_codigo`, com **delta YoY** vs os **mesmos meses fechados** do ano-1.
3. **Forecast restante (NÃO decomposto)**: mostrado à parte, explícito.

**Linguagem (Codex P2.10):** "principais componentes", "maiores aumentos YoY", "categorias que mais pesam no realizado". NUNCA "explicam o furo" — é contribuição observada, não causalidade.

## Reconciliação como contrato (Codex P1.1)

Σ(categorias mapeadas para a linha, vindas da view dimensional) **não bate exato** com o realizado da linha em `fin_dre_snapshots` (a view dimensional pode usar base de data/status diferente do `calcularDRE`; movimentações não estão nas views CR/CP; financeiras frequentemente vêm de movimentações → resíduo alto esperado nessas linhas). Tratamento — **sempre exibido, nunca escondido**:

- `realizado_snapshot` = `forecastLinha.realizado_fechado` (a verdade contábil YTD).
- `total_decomposto` = Σ componentes.
- `residuo` = `realizado_snapshot − total_decomposto`; `residuo_perc` = `|residuo| / |realizado_snapshot|`.
- **Qualidade:**
  - `ok` — `residuo_perc ≤ 5% E |residuo| ≤ R$10k`.
  - `diagnostico` — `residuo_perc > 20%` → a UI rebaixa de "explicação" para "modo diagnóstico" (mostra os números, mas avisa que não reconcilia).
  - `parcial` — caso intermediário → aviso "drill parcial; fontes não reconciliadas".
  - Bordas: `realizado_snapshot ≈ 0` → `residuo_perc = null`; se `total_decomposto ≈ 0` também → `ok` (nada a reconciliar); se snapshot ≈ 0 mas decomposto ≠ 0 → `diagnostico`.

## Atribuição por CÓDIGO (Codex P1.5, P2.7)

- **Chave = `categoria_codigo`** (descrição é só label; descrições colidem/mudam → nunca agrupar por texto). O label exibido é a descrição **mais recente** vista no período do ano atual.
- Junta ao `fin_categoria_dre_mapping (company, omie_codigo, dre_linha)` com fallback `_default`: resolve cada código pela regra **company sobrescreve `_default`** (`getCategoryMappings` já traz `[company, _default]`). Filtra só os códigos cuja `dre_linha` resolvida == linha-alvo.
- Códigos sem mapping para a linha-alvo são **excluídos** da decomposição (pertencem a outra linha / não mapeados) — o resíduo os captura honestamente.

## Aliases fiscais regime-aware + fonte CR/CP multi-source (Codex P1.2, P1.3 — VERIFICADO no `calcularDRE`/`montarDRE`)

O snapshot NÃO usa as 11 linhas literais — o mapping (`fin_categoria_dre_mapping.dre_linha` é `string` livre) usa **sublinhas fiscais** que o `montarDRE` agrega (verificado em `supabase/functions/omie-financeiro/index.ts:1135-1166`):

- **`deducoes` (snapshot)** = `deducoes + ded_icms + ded_iss + ded_pis + ded_cofins + ded_ipi + das` (linha 1140, **incondicional de regime**). Em Simples o **DAS cai aqui**.
- **`impostos` (snapshot)** = `impostoLucro` = `regime === 'simples' ? 0 : (irpj + csll)` (linha 1139).
- `'impostos'` legado normaliza (`normalizarImpostoLegado`) → `das` (simples) / `ded_icms` (presumido) → **ambos rolam para `deducoes`**.

Logo o drill precisa de **conjunto de aliases por linha**, regime-aware, senão as categorias fiscais somem da decomposição e viram resíduo gigante:

```ts
// regime por empresa (espelho de REGIME_POR_EMPRESA): colacor/oben = presumido; colacor_sc = simples
export function aliasesDaLinha(dreLinha: string, regime: 'simples' | 'presumido'): string[] {
  if (dreLinha === 'deducoes')
    return ['deducoes','ded_icms','ded_iss','ded_pis','ded_cofins','ded_ipi','das','impostos'];
  if (dreLinha === 'impostos')
    return regime === 'simples' ? [] : ['irpj','csll'];
  return [dreLinha]; // demais linhas: alias literal
}
```

**Fonte CR/CP por linha** (decisão por `dre_linha`, não "onde o código aparece"); deduções misturam CR (contra-receita) + CP (imposto a recolher) → **multi-source**:

```ts
export function fontesDaLinha(dreLinha: string): ('cr'|'cp')[] {
  if (['receita_bruta','receitas_financeiras','outras_receitas'].includes(dreLinha)) return ['cr'];
  if (dreLinha === 'deducoes') return ['cr','cp'];          // contra-receita + impostos indiretos
  if (['cmv','despesas_operacionais','despesas_administrativas','despesas_comerciais',
       'despesas_financeiras','outras_despesas','impostos'].includes(dreLinha)) return ['cp'];
  return []; // derivadas → não drilláveis
}
```

- **Derivadas** (`receita_liquida`, `lucro_bruto`, `resultado_operacional`, `resultado_antes_impostos`, `resultado_liquido`): `fontesDaLinha` retorna `[]` → **NÃO drilláveis**.
- **Multi-source sem dedup**: ao agregar por código sobre CR+CP, um mesmo código em ambos os razões soma (são títulos distintos) — consistente com o snapshot.
- **Bordas regime:** Simples → `impostos` alias `[]` → drill vazio (snapshot=0, decomposto=0 → `ok`). Em Simples o DAS aparece corretamente no drill de **`deducoes`**.

## Campo de valor

A tela de Forecast lê `getDRE` em `regime='competencia'`. O campo dimensional correspondente é **`total_documento`** (competência). v1 usa `total_documento` em CR e CP. (Se a tela passar a suportar caixa, usar `total_recebido`/`total_pago` — fora do escopo v1.)

## Período (Codex P2.8)

YoY compara os **mesmos meses fechados** (mesmo conjunto de números de mês). Se Mai/2026 ainda não fechou, compara Jan–Abr/2026 contra Jan–Abr/2025 (nunca Jan–Mai vs Jan–Mai).

## Arquitetura — client-side (igual ao resto do Orçamento Rolling)

**Sem migration, sem edge function, sem deploy.** Roda no front sobre as RPCs/serviços existentes.

### Helper puro `src/lib/financeiro/orcamento-drill-helpers.ts` (TDD)

```ts
export type DimRowRaw = {
  categoria_codigo: string | null;
  categoria_descricao: string | null;
  mes: number | null;
  valor: number;            // total_documento da view (CR ou CP)
};

export type DrillComponente = {
  categoria_codigo: string;
  categoria_descricao: string;          // label mais recente no período (ano atual)
  realizado_ytd: number;
  realizado_ytd_ano_anterior: number;
  delta: number;                         // realizado_ytd − realizado_ytd_ano_anterior
  delta_perc: number | null;             // null se ano_anterior == 0
  peso_perc: number;                     // realizado_ytd / total_decomposto (0 se total 0)
};

export type DrillQualidade = 'ok' | 'parcial' | 'diagnostico';

export type DrillResult = {
  dre_linha: string;
  fontes: ('cr'|'cp')[];                 // derivado de fontesDaLinha
  meses_fechados: number[];
  componentes: DrillComponente[];        // ordenado por |realizado_ytd| desc
  total_decomposto: number;
  realizado_snapshot: number;
  residuo: number;
  residuo_perc: number | null;
  qualidade: DrillQualidade;
  forecast_nao_decomposto: number;
  variancia_anual: number | null;        // passthrough (landing − orçado)
};

export const EPSILON_MONETARIO = 0.01;   // "≈ 0" (Codex P1.5)

export function drillLinha(input: {
  dreLinha: string;
  regime: 'simples' | 'presumido';       // página deriva da empresa (REGIME_POR_EMPRESA)
  rowsAno: DimRowRaw[];                   // CR+CP já concatenados pelo service conforme fontesDaLinha
  rowsAnoAnterior: DimRowRaw[];
  mesesFechados: number[];
  mapping: { omie_codigo: string; dre_linha: string; company: string }[];  // bruto; helper resolve company>_default
  realizadoSnapshot: number;             // forecastLinha.realizado_fechado
  forecastRestante: number;              // forecastLinha.forecast_restante
  varianciaAnual: number | null;
  limiteResiduoAbs?: number;             // default 10000
  limiteResiduoPercOk?: number;          // default 0.05
  limiteResiduoPercDiag?: number;        // default 0.20
}): DrillResult;
```

Lógica de `drillLinha` (Codex P1.1/P1.4/P1.5, P2.6/P2.7/P2.8):
1. `fontes = fontesDaLinha(dreLinha)`; `aliases = new Set(aliasesDaLinha(dreLinha, regime))`. Se `fontes` vazio (derivada) → resultado vazio defensivo.
2. **Resolução determinística do mapping (P1.1):** `codToLinha = Map`; processa **`_default` primeiro, depois as linhas da company** (company sobrescreve `_default` para o mesmo `omie_codigo`). `codigosAlvo = { código | codToLinha.get(código) ∈ aliases }`.
3. `agg(rows)`: filtra `mes ∈ fechadosSet` E `categoria_codigo ∈ codigosAlvo`; soma `valor` **bruto** (sem round) por código; guarda a descrição do maior `mes` por código.
4. `aggAno = agg(rowsAno)`, `aggAnt = agg(rowsAnoAnterior)`.
5. **`total_decomposto = round2(Σ valor bruto de aggAno)`; `residuo = round2(realizadoSnapshot − Σ valor bruto)`** — calcula em bruto, arredonda só no fim (não fabrica resíduo de centavo, P2.8).
6. Componentes = união `aggAno ∪ aggAnt`; cada um:
   - `categoria_descricao = descAno ?? descAnt ?? categoria_codigo` (**P1.4**: código que só existiu no ano-1).
   - `realizado_ytd = round2(ano)`, `realizado_ytd_ano_anterior = round2(ant)`, `delta = round2(ano − ant)`.
   - `delta_perc = |ant| < EPSILON ? null : (ano − ant) / Math.abs(ant)` (**denominador absoluto**, P2.6).
   - `peso_perc = Σbruto > EPSILON ? ano / Σbruto : 0` (magnitudes não-negativas; P2.7).
7. **Qualidade (bordas P1.5):** `|realizadoSnapshot| < EPSILON` → `residuo_perc = null`; se `|Σbruto| < EPSILON` também → `ok` (nada a reconciliar); senão → `diagnostico`. Caso geral: `residuo_perc = |residuo| / |realizadoSnapshot|`; `ok` se `residuo_perc ≤ 0.05 E |residuo| ≤ 10000`; `diagnostico` se `residuo_perc > 0.20`; senão `parcial`.
8. Ordena `componentes` por `|realizado_ytd|` desc. (UI pode reordenar por `|delta|` — P2.10.)

### Service `src/services/financeiroV2Service.ts`

> ⚠️ **Revisado após Codex adversarial no código (P1):** a matview dimensional (`fin_analise_*_dimensoes`) é por **`data_vencimento`**, mas o snapshot do forecast é **competência (`data_emissao`)** → reconciliar contra ela acusaria resíduo FALSO por base temporal. Fonte correta = **`fin_dre_competencia_base`** (CR+CP por `data_emissao`, `status≠CANCELADO`, soma `valor_documento`) — a MESMA base que o `calcularDRE` competência usa. Retorna `origem` (CR/CP), mas o drill soma por código sobre ambas (o `calcularDRE` classifica por código independente do razão).

```ts
export async function getCategoriasCompetenciaRaw(
  company: Company,
  ano: number,
  meses: number[],          // meses fechados (filtra server-side)
): Promise<DimRowRaw[]>;
```
Lê `fin_dre_competencia_base` filtrando `company`/`ano`/`mes IN meses`, **paginando** (`.range()` em loop — a view passa de 1000 linhas: categorias × meses × 2 origens). Cache react-query chaveado por `[company, ano, meses]` (base bruta compartilhada entre linhas); o `drillLinha` da linha expandida é calculado num `useMemo` a partir do `forecast` (que reage ao draft) — assim os valores do `ForecastLinha` (realizado_fechado/forecast_restante/variancia) não precisam entrar na queryKey (P2.3).

### Página `src/pages/FinanceiroOrcamento.tsx`

- Cada `ForecastLinha` com `fura_meta === true` E `fontesDaLinha(linha).length > 0` ganha affordance de expandir (chevron / linha clicável).
- `regime = REGIME_POR_EMPRESA[company]` (`colacor/oben → presumido`, `colacor_sc → simples`) — mapa pequeno inlinado na página (ou exportado do helper).
- Ao expandir (lazy): para cada fonte em `fontesDaLinha(linha)`, busca `getCategoriasDimensaoRaw(fonte, company, ano)` + `(…, ano-1)`, **concatena** os `DimRowRaw[]` por ano; busca `getCategoryMappings(company)` (traz `[company, '_default']`). Roda `drillLinha({ dreLinha, regime, rowsAno, rowsAnoAnterior, mesesFechados, mapping, realizadoSnapshot: linha.realizado_fechado, forecastRestante: linha.forecast_restante, varianciaAnual: linha.variancia })` (**P3.12**: o campo no `ForecastLinha` é `variancia`, mapeia para `varianciaAnual`).
- Renderiza os 3 blocos + faixa de reconciliação (qualidade colorida via `text-status-*`, tokens já existem — §4 do CLAUDE.md).
- Estado de loading: skeleton pequeno na linha expandida.

## Limitações documentadas (v1)

- **Mapping não-versionado (Codex P1.4):** reclassifica o passado com a regra de mapeamento atual. "Variações" podem ser mudança de mapeamento, não de gasto. Snapshot de `mapping_version` = v2.
- **Divergência semântica view×snapshot (Codex P2.6):** a view dimensional pode usar base de data/status diferente do `calcularDRE`. O **resíduo de reconciliação expõe isso honestamente**; não é corrigido em v1.
- **Financeiras:** `receitas_financeiras`/`despesas_financeiras` frequentemente vêm de movimentações (não CR/CP) → resíduo alto esperado → qualidade `parcial`/`diagnostico` por design.
- **Decomposição volume/preço/fornecedor (Codex P2.9):** "categoria subiu 40%" é menos acionável que "3 fornecedores explicam 80%". Próximo passo (v2) — não está aqui.

## Não-objetivos (v1)

- Orçado por categoria / pseudo-orçado por share histórico (Codex P1.3 — fabrica número).
- Decomposição do forecast restante por categoria.
- Drill de derivadas.
- Suporte a regime caixa no drill.

## Validação / entrega

TDD no helper (vitest). `heavy bun run test` + `typecheck:strict` + `tsc -p tsconfig.app.json` + `bun lint` + `build`. Codex adversarial no helper + integração. Docs em `FINANCEIRO_CONFIABILIDADE.md`. PR client-side (sem migration/deploy) + auto-merge `--squash --auto`.

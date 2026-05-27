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

## Fonte CR×CP por regra LITERAL da linha (Codex P1.5)

Decisão por `dre_linha` (não "onde o código aparece" — mesmo código pode estar em CR e CP com semânticas diferentes):

- **CR** (`fin_analise_cr_dimensoes`): `receita_bruta`, `deducoes` (contra-receita ligada à receita), `receitas_financeiras`, `outras_receitas`.
- **CP** (`fin_analise_cp_dimensoes`): `cmv`, `despesas_operacionais`, `despesas_administrativas`, `despesas_comerciais`, `despesas_financeiras`, `impostos`, `outras_despesas`.
- **Derivadas** (`receita_liquida`, `lucro_bruto`, `resultado_operacional`, `resultado_antes_impostos`, `resultado_liquido`): **NÃO drilláveis** (são calculadas, não têm categoria).

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
  fonte: 'cr' | 'cp';
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

export function fonteDaLinha(dreLinha: string): 'cr' | 'cp' | null; // null = não drillável (derivada)

export function drillLinha(input: {
  dreLinha: string;
  fonte: 'cr' | 'cp';
  rowsAno: DimRowRaw[];
  rowsAnoAnterior: DimRowRaw[];
  mesesFechados: number[];
  mapping: { omie_codigo: string; dre_linha: string }[];  // já mesclado company+_default no service
  realizadoSnapshot: number;             // forecastLinha.realizado_fechado
  forecastRestante: number;              // forecastLinha.forecast_restante
  varianciaAnual: number | null;
  limiteResiduoAbs?: number;             // default 10000
  limiteResiduoPercOk?: number;          // default 0.05
  limiteResiduoPercDiag?: number;        // default 0.20
}): DrillResult;
```

Lógica de `drillLinha`:
1. `fechadosSet = new Set(mesesFechados)`.
2. Constrói `codToLinha: Map<string,string>` do `mapping` (o service já mesclou company sobre `_default`; em empate, o último vence — service garante ordem `_default` antes de company). Filtra `codigosAlvo = códigos cuja linha == dreLinha`.
3. `agg(rows)`: filtra `mes ∈ fechadosSet` E `categoria_codigo ∈ codigosAlvo`; soma `valor` por código; guarda a descrição do maior `mes` por código (label recente).
4. `aggAno = agg(rowsAno)`, `aggAnt = agg(rowsAnoAnterior)`.
5. Componentes = união de códigos de `aggAno` ∪ `aggAnt`; cada um: `realizado_ytd` (ano, 0 se ausente), `realizado_ytd_ano_anterior` (ant, 0 se ausente), `delta`, `delta_perc` (`null` se ant==0), `peso_perc`. `round2` em valores monetários.
6. `total_decomposto = Σ realizado_ytd`; `peso_perc = realizado_ytd / total_decomposto` (0 se total 0).
7. Reconciliação + `qualidade` pelas regras acima (bordas snapshot≈0).
8. Ordena `componentes` por `|realizado_ytd|` desc.

### Service `src/services/financeiroV2Service.ts`

Nova função (a `getAnaliseDimensional` agrega por descrição e colapsa o mês — não serve):
```ts
export async function getCategoriasDimensaoRaw(
  tipo: 'cr' | 'cp',
  company: Company,
  ano: number
): Promise<DimRowRaw[]>;
```
Chama a RPC existente (`fin_analise_cr_dimensoes_rpc` / `fin_analise_cp_dimensoes_rpc`) com `p_mes=null` (todos os meses do ano), mapeia cada row para `DimRowRaw` (`valor = total_documento`). Uma chamada por ano (ano + ano-1 no consumidor).

### Página `src/pages/FinanceiroOrcamento.tsx`

- Cada `ForecastLinha` com `fura_meta === true` E `fonteDaLinha(linha) != null` ganha affordance de expandir (chevron / linha clicável).
- Ao expandir (lazy): busca `getCategoriasDimensaoRaw(fonte, company, ano)` + `(…, ano-1)` + `getCategoryMappings(company)` (cacheáveis via react-query), roda `drillLinha`, renderiza os 3 blocos + faixa de reconciliação (qualidade colorida via `text-status-*`).
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

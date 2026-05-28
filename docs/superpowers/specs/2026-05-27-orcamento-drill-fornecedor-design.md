# Drill v2 — Concentração por Fornecedor/Cliente (Orçamento Rolling)

> **Status:** design aprovado pelo founder (toggle no painel; lente de entidade só em linhas puras). Metodologia revisada por Codex. Próximo: Codex no spec → plano → Codex no plano → execução → Codex adversarial → PR. **Codex em todas as etapas.**

## Objetivo

Estende o drill de variância por categoria (v1, em produção). No painel que abre ao clicar numa linha de DRE que **fura a meta**, um **toggle** alterna entre **"Por categoria"** (v1) e **"Por fornecedor·cliente"** (v2). A lente v2 re-agrega a **linha inteira** por entidade e responde: **"quais poucos fornecedores/clientes concentram o gasto e explicam o aumento vs o ano passado"**.

## Princípio honesto (Codex P2.6 — o maior risco)

Explica **concentração do realizado YTD e variação YoY (mesmos meses fechados)** — **NÃO** "quem causou o estouro da meta" (não há meta por fornecedor). A UI usa exatamente essa linguagem. Mesma honestidade do v1: realizado YTD, não a variância anual (landing).

## Escopo (decisões do founder)

- **Lente de entidade só em linhas PURAS:** despesas (`cmv`, `despesas_*`, `outras_despesas`) → **fornecedor** (CP); receitas (`receita_bruta`, `receitas_financeiras`, `outras_receitas`) → **cliente** (CR).
- **`deducoes` e `impostos` → SEM lente de entidade** (mistura CR+CP / imposto a recolher não tem fornecedor acionável). Seguem só com o drill por categoria (v1). Derivadas: não drilláveis (já no v1).

```ts
export function entidadeDaLinha(dreLinha: string):
  | { fonte: 'cp'; rotulo: 'fornecedor' }
  | { fonte: 'cr'; rotulo: 'cliente' }
  | null;   // null = sem lente de entidade (deducoes/impostos/derivadas)
```

## Fonte e reconciliação (Codex P7, P8)

- **Fonte:** `fin_contas_pagar` (CP) / `fin_contas_receber` (CR) **diretas**, filtrando `company` + `data_emissao` nos meses fechados + `status_titulo ≠ 'CANCELADO'` + `categoria_codigo IN (códigos da linha)`. Como a `fin_dre_competencia_base` (que o v1 usa) é construída DESSAS tabelas com os MESMOS filtros, a Σ por entidade **reconcilia por construção** com o total da linha do v1. RLS staff-gated (`fin_user_can_access`); índice `(company, categoria_codigo)`.
- **Códigos da linha:** reusa o mapping resolvido (company>`_default`) + `aliasesDaLinha(linha, regime)` do v1 (linha pura → alias literal `[linha]`).
- **Reconciliação SEMPRE exibida (P7):** `total da linha (v1)` vs `Σ entidades (v2)` vs `diferença`. Mesmo reconciliando por construção, expõe bugs de alias/status/sinal/mês.
- **Sinais (P8):** `valor_documento` é magnitude positiva → concentração usa valor positivo; **delta YoY assinado**.

## Helper puro `src/lib/financeiro/orcamento-entidade-helpers.ts` (TDD)

```ts
export type EntidadeRowRaw = {
  entidade_id: string | null;     // cnpj_cpf
  entidade_nome: string | null;   // nome_fornecedor / nome_cliente
  mes: number | null;
  valor: number;                  // valor_documento
};

export type EntidadeClasse = 'novo' | 'sumiu' | 'recorrente';

export type EntidadeComponente = {
  entidade_chave: string;         // cnpj_cpf, senão nome normalizado, senão 'sem_id'
  entidade_label: string;         // nome mais recente, fallback chave
  sem_id: boolean;                // cnpj_cpf ausente
  realizado_ytd: number;
  realizado_ytd_ano_anterior: number;
  delta: number;                  // assinado (ano − ano-1)
  delta_perc: number | null;      // null se |ano-1| < EPSILON; senão delta/abs(ano-1)
  peso_perc: number;              // realizado_ytd / total_ano (0 se total ~0)
  classe: EntidadeClasse;
};

export type EntidadeConcentracaoResult = {
  componentes: EntidadeComponente[];   // ordenado por delta desc (default)
  total_ano: number;
  total_ano_anterior: number;
  aumento_bruto: number;               // Σ deltas POSITIVOS (novos entram inteiros; sumiu fica fora)
  top_n: number;
  top_n_peso_nivel_perc: number;       // Σ peso dos top-N por nível / total_ano
  top_n_peso_aumento_perc: number;     // Σ delta+ dos top-N por delta / aumento_bruto
  truncado: boolean;                   // amostra cortada pelo teto (aviso de imprecisão)
};

export function concentrarPorEntidade(input: {
  rowsAno: EntidadeRowRaw[];
  rowsAnoAnterior: EntidadeRowRaw[];
  mesesFechados: number[];
  topN?: number;                       // default 3
  truncado?: boolean;                  // repassado do service (teto de fetch)
}): EntidadeConcentracaoResult;
```

Lógica (espelha as decisões do Codex):
1. `fechadosSet = new Set(mesesFechados)`. `agg(rows)`: filtra `mes ∈ fechadosSet`; chave = `entidade_id ?? normalizarNome(entidade_nome) ?? 'sem_id'`; soma `valor` BRUTO por chave; guarda `entidade_label` (nome do maior mês) + `sem_id` (`entidade_id == null`).
2. `aggAno`, `aggAnt`. `total_ano = Σ bruto aggAno` (round só no fim), `total_ano_anterior = Σ bruto aggAnt`.
3. Componentes = união de chaves; cada um: `realizado_ytd` (ano), `ano_anterior` (ant), `delta = ano − ant` (assinado), `delta_perc` (null se |ant|<EPSILON senão delta/abs(ant)), `peso_perc` (`total_ano>EPSILON ? ano/total_ano : 0`), `classe` (`novo`: ant≈0 & ano>0; `sumiu`: ano≈0 & ant>0; senão `recorrente`), `entidade_label` (fallback ano-1, fallback chave).
4. `aumento_bruto = Σ delta dos componentes com delta>0` (novos entram inteiros; `sumiu` tem delta<0 → fora da soma).
5. `top_n_peso_nivel_perc`: pega os top-N por `realizado_ytd` desc, soma seus `realizado_ytd`, divide por `total_ano` (0 se total~0).
6. `top_n_peso_aumento_perc`: pega os top-N por `delta` desc (só delta>0), soma seus deltas, divide por `aumento_bruto` (0 se aumento~0). **Não estoura 100%** (numerador ⊆ denominador).
7. Ordena `componentes` por `delta` desc (default — o "aumento" é o contexto do furo). `round2` nos monetários no retorno.

`normalizarNome(n)`: trim + collapse spaces + uppercase (mitiga grafia divergente; não resolve filiais — limitação documentada).

## Service `src/services/financeiroV2Service.ts`

```ts
export async function getTitulosEntidadeRaw(
  fonte: 'cp' | 'cr',
  company: Company,
  ano: number,
  meses: number[],
  codigos: string[],
): Promise<{ rows: EntidadeRowRaw[]; truncado: boolean }>;
```
- `fin_contas_pagar` (cp) / `fin_contas_receber` (cr); `.eq(company)`, `.eq` ano via `data_emissao` range (ou `.gte/.lt` no ano), `.in('mes'...)` — **mas as tabelas não têm coluna `mes`**; filtrar por `data_emissao` no range do ano e derivar o mês client-side, OU filtrar `data_emissao >= ${ano}-01-01 AND < ${ano+1}-01-01` e mapear `mes = Number(data_emissao.slice(5,7))`, filtrando os meses fechados no helper. `.neq('status_titulo','CANCELADO')`, `.in('categoria_codigo', codigos)`. Seleciona `cnpj_cpf, nome_fornecedor|nome_cliente, data_emissao, valor_documento`.
- **Paginação** `.range()` em loop; **teto duro** `MAX = 20000` linhas → para e marca `truncado: true` (aviso de imprecisão na UI). `codigos` vazio → retorna `{rows:[], truncado:false}`.
- Deriva `mes` de `data_emissao`; `entidade_id = cnpj_cpf`, `entidade_nome = nome_fornecedor|nome_cliente`, `valor = valor_documento`.

## Página / painel `DrillVarianciaPanel.tsx`

- **Toggle** "Por categoria | Por fornecedor·cliente" — só renderiza a aba de entidade quando `entidadeDaLinha(linha) != null`.
- Lazy: ao trocar pra aba entidade, query `['orcamento-drill-entidade', company, ano, linha]` (enabled quando a aba ativa) → `getTitulosEntidadeRaw(fonte, company, ano, mesesFechados, codigos)` (ano + ano-1) → `concentrarPorEntidade`.
- Render: **2 cards** ("Maior concentração YTD: top 3 = X%" · "Maior aumento YoY: top 3 explicam Y% do aumento") + tabela (entidade + badge `Novo`/`Sumiu`/`Sem ID`, realizado YTD, ano-1, delta assinado, % do total). Ordena por delta desc; alterna por realizado YTD. **Faixa de reconciliação** (total linha vs Σ entidades vs diff). Aviso se `truncado`.
- Tooltip "categorias incluídas" (P10): lista os `codigos`/aliases que entram na linha.
- Copy honesto (P2.6): "Concentração do realizado YTD e variação YoY (mesmos meses fechados)".

## Limitações v1 (documentadas)
- Nome normalizado não resolve filiais/CNPJs distintos do mesmo grupo (fragmenta) nem unifica grafias com CNPJ ausente.
- `truncado` quando >20k títulos numa linha (aviso de imprecisão; caminho futuro: RPC agregada server-side — contrato `getTitulosEntidadeRaw` pronto pra trocar).
- Explica realizado YTD, não a variância contra meta (não há meta por fornecedor).

## Não-objetivos
- Lente de entidade em deducoes/impostos/derivadas.
- Decomposição preço×volume (precisaria de quantidade por título — fora).
- Migration / RPC agora (client-side, igual ao v1).

## Validação / entrega
TDD no helper (vitest). `heavy bun run test` + `typecheck:strict` + `tsc -p tsconfig.app.json` + `bun lint` + `build`. Codex adversarial. Docs em `FINANCEIRO_CONFIABILIDADE.md`. PR client-side (sem migration/deploy) + auto-merge `--squash --auto`.

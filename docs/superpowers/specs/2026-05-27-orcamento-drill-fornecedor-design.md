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

## Fonte e reconciliação (Codex adversarial no spec — P1.1, P1.3; P3.8)

- **Fonte:** `fin_contas_pagar` (CP) / `fin_contas_receber` (CR) **diretas**, com filtros que **espelham EXATAMENTE** a `fin_dre_competencia_base`: `company` + `data_emissao IS NOT NULL` + `data_emissao >= '{ano}-01-01' AND < '{ano+1}-01-01'` + `status_titulo ≠ 'CANCELADO'` + soma de `valor_documento`. RLS staff-gated (`fin_user_can_access`).
- **Códigos da linha:** reusa o mapping resolvido (company>`_default`) + `aliasesDaLinha(linha, regime)` do v1 (linha pura → alias literal `[linha]`). Filtro por código via **chunked `.in()`** (lotes de ~100 — P1.2: `.in` cru estoura URL em linha grande); o helper re-filtra os códigos defensivamente.
- ⚠️ **Reconciliação — alvo correto (Codex P1.1, o nó):** o v1 reconcilia o decomposto-por-categoria contra `realizado_fechado` (que vem de `fin_dre_snapshots`, um SNAPSHOT que pode estar stale / usar fallback heurístico / mapping antigo). O v2 soma a **base viva**. Portanto o v2 **NÃO promete "bate com o snapshot"** — ele reconcilia contra o **total-por-categoria do v1** (`drillResult.total_decomposto`), que vem da MESMA base viva (`fin_dre_competencia_base`, mesmos filtros) → **Σ entidades (v2) == Σ categorias (v1) por construção** (mesmas linhas, GROUP BY diferente). O `realizado_fechado` (snapshot) aparece como **terceiro número de contexto** (a divergência snapshot×base-viva já é o resíduo do v1, não responsabilidade do v2).
  - Painel exibe: `Σ entidades (v2)` · `Σ categorias (v1)` · `diferença` (deve ser ~0) · e, como contexto, `realizado contábil (snapshot)`.
- **Sinais (P3.8):** CP e CR são analisados SEPARADAMENTE (a linha é pura — nunca mistura) → `valor_documento` magnitude positiva; **delta YoY assinado**.
- **Truncamento invalida o Pareto (P1.3):** se o fetch bater o teto (`MAX=20000`), `truncado=true` → o painel **NÃO mostra os percentuais de concentração** (seriam mentira); mostra "amostra truncada — análise não confiável (diagnóstico)". Ordenar por valor não resolve (o delta YoY precisa dos dois anos). Caminho futuro: RPC agregada server-side.

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
  aumento_bruto: number;               // Σ max(delta,0) de TODAS as entidades
  top_n: number;
  top_n_peso_nivel_perc: number;       // Σ |realizado| dos top-N por |nível| / Σ|nível| (0..1)
  top_n_peso_aumento_perc: number | null;  // null se aumento_bruto<=0 (flag sem_aumento_bruto)
  sem_aumento_bruto: boolean;          // aumento_bruto <= EPSILON
  truncado: boolean;                   // amostra cortada pelo teto → análise diagnóstica
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
1. `fechadosSet = new Set(mesesFechados)`. **Chave de identidade (P2.5):** `cnpjValido(entidade_id)` (limpa não-dígitos; rejeita vazio, `< 11 dígitos`, todos-iguais tipo `00000000000`) → usa o cnpj limpo; senão `normalizarNome(entidade_nome)` se não-vazio; senão bucket `'sem_identificacao'`. `agg(rows)`: filtra `mes ∈ fechadosSet`; soma `valor` BRUTO por chave; guarda `entidade_label` (nome do maior mês) + `sem_id` (caiu em nome ou sem_identificacao = sem cnpj válido).
2. `aggAno`, `aggAnt`. `total_ano = Σ bruto aggAno` (round só no fim), `total_ano_anterior = Σ bruto aggAnt`.
3. Componentes = união de chaves; cada um: `realizado_ytd` (ano), `ano_anterior` (ant), `delta = ano − ant` (assinado), `delta_perc` (null se |ant|<EPSILON senão delta/abs(ant)), `peso_perc` (`total_ano>EPSILON ? ano/total_ano : 0`), `classe` (`novo`: |ant|<EPSILON & ano>EPSILON; `sumiu`: |ano|<EPSILON & ant>EPSILON; senão `recorrente`), `entidade_label` (fallback ano-1, fallback chave).
4. **`aumento_bruto = Σ max(delta, 0)`** de TODAS as entidades (novos entram inteiros; `sumiu` tem delta<0 → `max(·,0)=0`, fora).
5. `top_n_peso_nivel_perc`: top-N por **`abs(realizado_ytd)` desc** (P3.7 — estorno não esconde fornecedor material), soma `abs(realizado_ytd)` deles / `Σ abs(realizado_ytd)` de todos (0 se ~0).
6. `top_n_peso_aumento_perc`: zera negativos (`max(delta,0)`), ordena por isso desc, soma os top-N / `aumento_bruto`. **Se `aumento_bruto ≤ EPSILON` → `null` + `sem_aumento_bruto=true`** (não divide). Clamp `min(1, ·)` defensivo (nunca >100%).
7. Ordena `componentes` por `delta` desc (default — "aumento" é o contexto do furo). `round2` nos monetários no retorno. `truncado` repassado.

`normalizarNome(n)`: trim + collapse spaces + uppercase (mitiga grafia; não resolve filiais — limitação documentada). `cnpjValido(s)`: `d=s.replace(/\D/g,'')`; válido se `d.length ∈ {11,14}` E não-todos-iguais.

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
- `fin_contas_pagar` (cp) / `fin_contas_receber` (cr); seleciona `cnpj_cpf, nome_fornecedor|nome_cliente, data_emissao, valor_documento, categoria_codigo`.
- **Filtros espelhando a `competencia_base` (P1.1):** `.eq('company', …)`, `.not('data_emissao','is',null)`, `.gte('data_emissao','{ano}-01-01')`, `.lt('data_emissao','{ano+1}-01-01')`, `.neq('status_titulo','CANCELADO')`. **Mês derivado de `data_emissao.slice(5,7)`** (date string `YYYY-MM-DD`, sem `new Date` — P2.6); o helper filtra os meses fechados.
- **Filtro de códigos por chunked `.in()` (P1.2):** parte `codigos` em lotes de ~100 e faz uma query por lote (evita estouro de URL em linhas grandes), une os resultados. `codigos` vazio → `{rows:[], truncado:false}`.
- **Paginação** `.range()` em loop por lote; **teto duro `MAX=20000`** linhas no total → para e marca `truncado: true` (→ painel entra em modo diagnóstico, esconde percentuais — P1.3).
- Mapeia: `entidade_id = cnpj_cpf`, `entidade_nome = nome_fornecedor|nome_cliente`, `mes = Number(data_emissao.slice(5,7))` (NaN/ malformado → o helper ignora), `valor = valor_documento`.

## Página / painel `DrillVarianciaPanel.tsx`

- **Toggle** "Por categoria | Por fornecedor·cliente" — só renderiza a aba de entidade quando `entidadeDaLinha(linha) != null`.
- Lazy: ao trocar pra aba entidade, query `['orcamento-drill-entidade', company, ano, linha]` (enabled quando a aba ativa) → `getTitulosEntidadeRaw(fonte, company, ano, mesesFechados, codigos)` (ano + ano-1) → `concentrarPorEntidade`.
- Render: **2 cards** ("Maior concentração YTD: top 3 = X%" · "Maior aumento YoY: top 3 explicam Y% do aumento" — **se `sem_aumento_bruto`, esconde o 2º card** e mostra "linha não cresceu vs {ano-1}") + tabela (entidade + badge `Novo`/`Sumiu`/`Sem ID`, realizado YTD, ano-1, delta assinado, % do total). Ordena por delta desc; alterna por realizado YTD. **Faixa de reconciliação:** `Σ entidades (v2)` vs `Σ categorias (v1, drillResult.total_decomposto)` vs `diferença (~0)` + contexto `realizado contábil (snapshot, realizado_fechado)`. **Se `truncado` → modo diagnóstico: esconde os percentuais** ("amostra truncada, análise não confiável").
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

# Orçamento Rolling — Design (forecast de aterrissagem + variância projetada)

**Data:** 2026-05-27
**Programa:** Estado da Arte do Financeiro (fronteira #3, após Funding & dívida)
**Status:** scope aprovado ("rolling completo") + 1 passe Codex na metodologia incorporado. (Regra desta fronteira: **Codex em todas as etapas** — metodologia ✓, spec, plano, código.)

## Objetivo

Transformar o **"Orçado × Realizado" que já existe** num **orçamento rolling**: projetar **onde o ano vai fechar** (forecast de aterrissagem) vs. o orçado, com a **variância projetada** por linha, e tornar o orçamento mais usável (drill de variância + seed de baixa fricção + descoberta na sidebar).

## Contexto — o que JÁ existe (NÃO reimplementar)

- **`fin_orcamento`** (`company, ano, mes, dre_linha, valor_orcado, notas`) — orçamento mensal por linha de DRE. CRUD em `financeiroV2Service.ts` (`getOrcamento`/`upsertOrcamento`, upsert `onConflict: company,ano,mes,dre_linha`).
- **`src/pages/FinanceiroOrcamento.tsx`** ("Orçado × Realizado") — rota viva `/financeiro/orcamento`: grid editável de orçamento, realizado via `getDRE(company, ano)` (DRE v2 mensal, **regime de CAIXA**), resumo YTD (orçado vs realizado vs variação% + favorável/desfavorável sign-aware) e grid mensal orçado/real/diff + audit trail. **NÃO está na sidebar** (só por URL).
- **Análise dimensional** (`financeiroV2Service.getAnaliseDimensional`) — CR/CP por categoria/departamento/centro_custo/vendedor/cliente/fornecedor. Reusável no drill de variância.
- **Linhas DRE** (`DRE_LINHAS`): orçáveis = `receita_bruta, deducoes, cmv, despesas_operacionais, despesas_administrativas, despesas_comerciais, despesas_financeiras, receitas_financeiras, outras_receitas, outras_despesas, impostos`. Derivadas (em `FinDRE`, NÃO orçadas) = `receita_liquida, lucro_bruto, resultado_operacional, lucro_liquido`.

## Princípio (Codex): método POR LINHA, não média global

Não "preencher o ano com a média" (vira calculadora de falsa precisão). **Projetar o restante com premissa coerente pra NATUREZA de cada linha**, **por empresa** (Simples × Presumido não consolidam ingênuo — v1 é por-empresa, sem consolidado), com **degradação honesta** (bloqueia o forecast em vez de fabricar número).

---

## Sub-PR A — Forecast de aterrissagem + variância projetada

### Landing por linha
`landing_linha = Σ realizado(meses FECHADOS) + Σ forecast(meses restantes)`.
- **Mês fechado** = mês < mês corrente (no ano corrente) — totalmente realizado. **O mês corrente é "em curso"** e entra no landing pelo **forecast**, NÃO pelo realizado parcial cru (incluir o parcial subestima — Codex [a]).
- Ano passado/fechado: todos os 12 meses são realizados → landing = realizado (sem forecast).

### Semântica das linhas (precondição — Codex [P1.1])
**`deducoes` e `impostos` são DISJUNTOS** (senão o `lucro_liquido` subtrai imposto 2×). Conforme o mapeamento do DRE v2 (Onda 3a): **`deducoes`** = tributos **sobre receita** (ICMS/ISS/PIS/COFINS/IPI) + devoluções/abatimentos; **`impostos`** = **IRPJ/CSLL** (e, no Simples, a parcela do DAS que o DRE v2 NÃO alocou em deduções). Todas as 11 linhas orçáveis são **magnitudes positivas** (deduções/cmv/despesas/impostos subtraem). As **derivadas** são calculadas pela **mesma fórmula que o DRE v2 usa no realizado** (consistência realizado↔forecast). Se o mapeamento de uma empresa não deixar deduções/impostos limpos → flag + confiança baixa (não fabrica).

### Forecast é um PIPELINE ORDENADO (não função por-linha isolada — Codex [P1.3])
Os drivers criam dependência → a ordem importa. `projetarDRE(company, ano, dreFechado[], dreAnoAnterior[], orcado[])` projeta **mês a mês restante** nesta ordem topológica, e só então agrega:
`receita_bruta → deducoes (driver s/ receita_bruta forecasted) → receita_liquida (calc) → cmv (driver s/ receita_liquida forecasted) → despesas_* / financeiras / outras → impostos → derivadas (calc)`.

### Matriz de método por linha

| Linha | Método |
|---|---|
| `receita_bruta` | **sazonal AJUSTADO por tendência** (Codex [P2.2]): `receita_mes_ano_anterior × fator_tendencia`, com `fator = Σreceita_YTD_fechado_atual / Σreceita_YTD_mesmos_meses_ano_anterior` (cap em [0,5; 2,0] + flag se fora) — exige ≥12m histórico. Senão **run-rate** (média dos meses fechados). Senão **orçado remanescente** (fallback). |
| `deducoes` | **driver**: `(Σdeducoes_fechado / Σreceita_bruta_fechado)` × receita_bruta forecasted do mês. |
| `cmv` | **driver**: `(Σcmv_fechado / Σreceita_liquida_fechado)` × receita_liquida forecasted do mês (margem histórica). |
| `despesas_administrativas`, `despesas_operacionais` | **run-rate** (média dos meses fechados). |
| `despesas_comerciais` | v1: **run-rate** (separação fixa+variável formal = v2 → flag). |
| `receitas_financeiras`, `despesas_financeiras` | **média dos últimos 3 meses fechados** (ou todos os fechados se <3). |
| `outras_receitas`, `outras_despesas` | run-rate (esporádicas → flag de baixa confiança). |
| `impostos` | **razão YTD** (Codex [P1.4]): `(Σimpostos_fechado / Σreceita_bruta_fechado)` × receita_bruta forecasted — suaviza a lumpiness do IRPJ/CSLL trimestral em caixa. **NUNCA média mensal cega**. **Flag/confiança baixa** quando <3 meses fechados OU <1 trimestre completo (Presumido tem recolhimento trimestral → razão pode nascer 0). Regime-aware (compor `fin-regime-tributario`) = **v2**. |
| **derivadas** | **SEMPRE calculadas** dos inputs forecasted (fórmulas abaixo, idênticas ao DRE v2) — nunca orçadas direto. |

**Fórmulas das derivadas** (inputs como magnitudes positivas; deduções/cmv/despesas/impostos subtraem; **idênticas ao DRE v2** p/ consistência):
- `receita_liquida = receita_bruta − deducoes`
- `lucro_bruto = receita_liquida − cmv`
- `resultado_operacional = lucro_bruto − despesas_operacionais − despesas_administrativas − despesas_comerciais`
- `lucro_liquido = resultado_operacional + receitas_financeiras − despesas_financeiras + outras_receitas − outras_despesas − impostos`

⚠️ As derivadas NÃO contêm impostos em duplicidade: `deducoes` = tributos sobre receita; `impostos` = IRPJ/CSLL/DAS — disjuntos (ver "Semântica das linhas").

### Orçado anual das derivadas (Codex [P1.2])
As derivadas **não existem em `fin_orcamento`** (só as 11 linhas-input são orçadas). O `orcado_ano` de cada derivada é **calculado das 11 linhas orçadas** pelas MESMAS fórmulas acima (ex.: `orcado_lucro_liquido = orcado_resultado_operacional + orcado_receitas_financeiras − … − orcado_impostos`). Sem isso a variância das derivadas compararia contra null/zero (sinal errado). Tanto `landing` quanto `orcado_ano` das derivadas usam as mesmas fórmulas.

### Variância projetada (sign-aware — Codex [P2.1])
`variancia_linha = landing − orcado_ano` por linha.
- **Conjunto EXPLÍCITO de receita** `LINHAS_RECEITA = {receita_bruta, receitas_financeiras, outras_receitas}` + as derivadas de resultado `{receita_liquida, lucro_bruto, resultado_operacional, lucro_liquido}`: landing > orçado → **favorável**.
- **Todas as outras** (`deducoes`, `cmv`, `despesas_operacionais`, `despesas_administrativas`, `despesas_comerciais`, `despesas_financeiras`, `outras_despesas`, `impostos`): landing > orçado → **desfavorável**.
- ⚠️ Classificação por **conjunto literal de linhas** (NÃO prefixo `despesas_*` — `despesas_financeiras` não pode cair no balaio de "financeira/receita"). Teste **parametrizado nas 11 linhas + 4 derivadas**.
- **Alerta "vai furar a meta"**: `|variancia| > max(0,10 × |orcado_ano|, piso_absoluto_R$)`; se `orcado_ano <= 0` → usa **só o piso absoluto** (evita divisão/ruído — Codex [P3.2]).
- ⚠️ Ressalva (Codex [e]): despesa **menor** que o orçado é "favorável contábil" mas pode ser subinvestimento — v1 mostra o sinal contábil + **nota**; decomposição volume/preço/mix = v2.

### Confiança / bloqueio honesto (Codex [P2.4]/[g])
- **0 meses fechados** no ano corrente → **sem forecast** (mostra só orçado + "aguardando 1º mês fechado").
- **<3 meses fechados** p/ linha variável (receita/cmv/comerciais) → forecast com **confiança baixa** + flag.
- **Sem ≥12m de histórico** → receita cai de sazonal p/ run-rate (flag "sem sazonalidade").
- **Denominador de driver ≤ 0** (Codex [P2.4]): `Σreceita_bruta_fechado ≤ 0` (deduções/impostos) ou `Σreceita_liquida_fechado ≤ 0` (cmv) → o driver NÃO roda (cairia em `NaN`/`Infinity`) → degrada p/ run-rate da própria linha + flag; se nem isso → sem forecast da linha.
- **Imposto sem ciclo tributário completo** (<1 trimestre fechado, Presumido) → flag/confiança baixa.
- Linha sem orçado → variância não computável (mostra só o landing).
- **NUNCA fabrica** (padrão do programa).

---

## Sub-PR B — Variância inteligente + seed + sidebar

- **Drill de variância**: ao expandir uma linha DRE com desvio, mostrar as **categorias** que mais contribuíram (reusa `getAnaliseDimensional('cr'|'cp', company, 'categoria', ano, mes)`). v1: top-N categorias por contribuição ao desvio. Decomposição volume/preço/mix = v2.
- **Seed de baixa fricção**: botão "Sugerir orçamento {ano+1}" = realizado do ano (anualizado se parcial) × `(1 + crescimento%)` por linha. **Tratamento de one-off (Codex [P2.3]): winsoriza o outlier do CÁLCULO por padrão** (mês cujo valor desvia >Nσ da mediana é capado ao limite, NÃO entra cru) e mostra reconciliação ("X meses ajustados"). **Bloqueia o seed da linha** quando amostra é curta/esparsa (<3 meses com valor, ou linha esporádica `outras_*`) → não sugere número, marca "preencher manual". Preenche o draft; o founder revisa e salva. Reduz ~120 células digitadas.
- **Sidebar**: adicionar `/financeiro/orcamento` na seção Financeiro do `AppShell` (label "Orçamento", ícone `Target`).

---

## Arquitetura

**Client-side** (igual ao padrão da tela existente, que já roda `getDRE`+`getOrcamento` no front) — **SEM edge function**. Mantém impostos como **% da receita** (não compõe o regime engine master-only) pra ficar client-side e honesto.

- Helper puro `src/lib/financeiro/orcamento-forecast-helpers.ts` (TDD) — toda a matemática (forecast por método, derivadas, variância sign-aware, confiança, seed). Não é espelhado em Deno (não há edge function).
- Estende `src/pages/FinanceiroOrcamento.tsx`: nova seção/coluna "Forecast de aterrissagem" + variância projetada + drill + botão de seed.
- Reusa `getDRE` (realizado, inclusive ano anterior p/ sazonalidade/seed via `getDRE(company, ano-1)`), `getOrcamento`/`upsertOrcamento`, `getAnaliseDimensional`.
- **Sem migration** (reusa `fin_orcamento`). **Versionamento de forecast** (snapshot histórico) = **v2** — v1 recomputa ao vivo (determinístico) e **expõe método+params por linha** (transparência de "como o número foi feito").

## Contrato de tipos (esboço)

```ts
type MetodoForecast = 'sazonal' | 'run_rate' | 'driver_receita' | 'media_movel' | 'orcado_remanescente' | 'imposto_pct_receita';

type ForecastLinha = {
  dre_linha: string;
  realizado_fechado: number;   // Σ meses fechados
  forecast_restante: number;   // Σ meses restantes
  landing: number;             // realizado_fechado + forecast_restante
  orcado_ano: number | null;
  variancia: number | null;    // landing − orcado_ano
  favoravel: boolean | null;   // sign-aware
  fura_meta: boolean;          // |variancia| > threshold
  metodo: MetodoForecast;
  confianca: 'alta' | 'media' | 'baixa';
  flags: string[];             // 'sem_orcado','sem_sazonalidade','poucos_meses','derivada','subinvestimento_possivel'
};

type ForecastResult = {
  company: string; ano: number; meses_fechados: number;
  linhas: ForecastLinha[];     // inputs + derivadas
  confianca_geral: 'alta' | 'media' | 'baixa';
  motivos: string[];
};

type SeedLinha = { dre_linha: string; mes: number; valor_sugerido: number | null; flag?: 'winsorizado' | 'amostra_curta_sem_sugestao' };
```

> O forecast é um **orquestrador ordenado** `projetarDRE(...)` (não `forecastLinha` isolado): projeta mês-a-mês na ordem topológica `receita_bruta → deducoes → receita_liquida → cmv → demais → impostos → derivadas`, garantindo que os drivers (deduções/cmv) usem a base **forecasted** da etapa anterior.

## Degradação honesta (resumo)
Sem mês fechado → sem forecast. <3 meses p/ linha variável → confiança baixa. Sem histórico p/ sazonal → run-rate + flag. Sem orçado → só landing. One-off no seed → flag, não cega. Nunca fabrica recomendação.

## Escopo v1 vs v2
**v1 (sub-PR A + B):** matriz de método por linha · landing = fechados + forecast(restantes) · mês corrente fora da base · variância projetada sign-aware + alerta de meta · bloqueio honesto · derivadas calculadas · por-empresa · drill por categoria (top-N) · seed histórico×crescimento com flag de outlier · sidebar.
**v2:** versionamento/snapshot histórico do forecast (auditar "por que mudou") · impostos regime-aware (compõe `fin-regime-tributario`) · decomposição de variância volume/preço/mix · consolidado multi-empresa com eliminação intercompany · despesas comerciais fixa+variável formal (se a separação existir).

## Plano de testes (helper, TDD)
- `mesesFechados`: ano corrente exclui mês corrente; ano passado = 12.
- **Ordem do pipeline `projetarDRE`**: deduções usam receita_bruta **forecasted** (não histórica); cmv usa receita_liquida **forecasted** (teste que prova a topological order).
- métodos: run-rate (média fechados × restantes); **sazonal ajustado** (ano-1 mesmo mês × fator_tendencia_YTD; cap [0,5;2,0]); driver deduções/cmv (razão YTD); **imposto razão YTD** (não média mensal); média móvel (últimos 3 fechados); fallback orçado-remanescente.
- mês corrente parcial NÃO entra na base.
- derivadas (landing E orçado): `receita_liquida`/`lucro_bruto`/`resultado`/`lucro_liquido` corretas a partir dos inputs (sinais); **orçado das derivadas calculado das 11 linhas** (não null/zero).
- **variância sign-aware PARAMETRIZADA nas 11 linhas + 4 derivadas** (conjunto literal): receita/derivadas-de-resultado acima → favorável; deduções/cmv/despesas/impostos acima → desfavorável; nenhuma invertida.
- `fura_meta`: `|var| > max(10%×|orcado|, piso)`; `orcado<=0` → só piso (sem divisão).
- **denominador de driver ≤ 0** → degrada p/ run-rate + flag (sem NaN/Infinity).
- confiança/bloqueio: 0 fechados → sem forecast; <3 → baixa; sem histórico → run-rate+flag; imposto <1 trimestre (Presumido) → flag.
- `seedOrcamento`: realizado×(1+g); anualiza parcial; **winsoriza outlier (>Nσ da mediana)** no cálculo; amostra curta/esparsa → `valor_sugerido: null` + flag (não fabrica).

## Codex — findings incorporados (rastreabilidade)
**Metodologia (passe 1):** método **por linha** ✅ · mês corrente parcial fora da base ✅ · sazonal só com histórico ✅ · derivadas calculadas ✅ · imposto nunca média cega ✅ · variância sign-aware ✅ · seed trata one-offs ✅ · bloqueio honesto ✅ · por empresa ✅.
**Spec (passe 2):** [P1.1] disjunção semântica deduções×impostos (anti double-count) ✅ · [P1.2] orçado das derivadas calculado das 11 linhas ✅ · [P1.3] pipeline ordenado (drivers usam base forecasted) ✅ · [P1.4] imposto razão-YTD + flag Presumido/<trimestre ✅ · [P2.1] sign-aware por conjunto literal + teste parametrizado ✅ · [P2.2] sazonal ajustado por tendência YTD ✅ · [P2.3] seed winsoriza outlier + bloqueia amostra curta ✅ · [P2.4] guard de denominador ≤ 0 ✅ · [P3.1] janela da média móvel definida (3 fechados) ✅ · [P3.2] fura_meta com piso absoluto p/ orçado≤0 ✅.
**Adiados:** versionamento/snapshot = v2 (v1 expõe método+params por linha) ⏳ · regime-aware tax = v2 ⏳ · decomposição volume/preço/mix = v2 ⏳ · consolidado cross-CNPJ = v2 ⏳.

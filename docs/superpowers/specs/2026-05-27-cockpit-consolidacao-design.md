# Cockpit Financeiro — Consolidação (religar às engines) — Design

> **Status:** design (escopo ENXUTO aprovado por delegação founder+Codex). Metodologia revisada por Codex. Próximo: Codex no spec → plano → Codex no plano → execução → adversarial → PR. **Codex em todas as etapas.**

## Objetivo

O Cockpit financeiro (`/financeiro/cockpit`, consolidado das 3 empresas, usado semanalmente) mostra **números errados** porque foi construído com atalhos antes das engines A1 existirem:
- **Projeção 13s:** RPC ingênua `fin_projecao_13_semanas` (joga CR/CP no vencimento; sem curva de cobrança, inadimplência, eventos, folha).
- **NCG:** `totalCR − totalCP` (só abertos), em vez de `ACO − PCO` (com estoque/folha/tributos).

Religar o Cockpit às engines (via **snapshot diário**), mantendo-o consolidado mas **honesto sobre a não-fungibilidade de caixa entre CNPJs** (Codex P1).

## Decisões de metodologia (Codex)

1. **Snapshot-first (não 3 invocações live):** lê o último `fin_projecao_snapshots` (cenário `realista`) das 3 empresas. Tela executiva semanal → confiável/rápida > fresca-ao-segundo. Exibe **"dados de {snapshot_at}"**. Live/cenários continua sendo a tela **Capital de Giro**.
2. **Total + decomposição POR EMPRESA (Codex P1 — não fingir caixa único):** somar caixa entre 3 CNPJs distintos pode esconder insolvência local. Mostra o consolidado **e** a quebra por empresa (projeção e NCG).
3. **Cenário explícito:** label "Cenário: realista" (sem toggle no v1 — Capital de Giro tem). O pior estado é mostrar número de cenário sem dizer qual.
4. **Intercompany — premissa documentada:** v1 **NÃO elimina** intercompany (CR de colacor pode ser CP de colacor_sc → potencial double-count). Aviso textual; eliminação = futuro.
5. **Falha parcial honesta:** se faltar snapshot de uma empresa → banner "X de 3 empresas" + cards marcados parciais; **não zera silenciosamente** (ausente ≠ zero).
6. **Bordas:** alinhar semanas por **data `inicio`** (não índice); `ncg` null de uma empresa → fora da soma + flag; staleness = mostrar o snapshot mais antigo.

## Fonte (verificado)

`fin_projecao_snapshots` (gravado pelo cron `fin-cashflow-snapshot-diario` via `fin-cashflow-engine` com `save_snapshot`): colunas `company`, `cenario`, `snapshot_at`, **`dados` (Json = `semanas[]`)**, **`ncg` (número = `ncg.valor` = ACO−PCO)**, `saldo_tesouraria`, `liquidez_operacional_liquida`, `dias_cobertura`. Cada `semana` = `{inicio, fim, total_entradas, total_saidas, saldo_final, ...}`. A decomposição ACO/PCO detalhada NÃO está no snapshot (fica na tela Capital de Giro) — o Cockpit só precisa do **valor** do NCG + a projeção.

## Helper puro `src/lib/financeiro/cockpit-consolida-helpers.ts` (TDD)

```ts
export type SnapshotSemana = { inicio: string; total_entradas: number; total_saidas: number; saldo_final: number };
export type SnapshotEmpresa = {
  company: string;
  snapshot_at: string;
  ncg: number | null;
  saldo_tesouraria: number | null;
  semanas: SnapshotSemana[];
};

export type SemanaConsolidada = {
  inicio: string;
  semana_label: string;                 // "dd/mm" (do inicio)
  entradas_previstas: number;
  saidas_previstas: number;
  saldo_projetado: number;              // Σ saldo_final das presentes
  por_empresa: { company: string; saldo_final: number }[];
  completa: boolean;                    // todas as empresas presentes têm essa semana
};

export type CockpitConsolidado = {
  projecao13: SemanaConsolidada[];      // coorte, ordenada por inicio, no MÁXIMO 13
  ncg_total: number;                    // Σ ncg não-null da COORTE (mínimo conhecido se parcial)
  ncg_por_empresa: { company: string; ncg: number | null; presente: boolean }[]; // ordem = esperadas
  ncg_parcial: boolean;
  saldo_tesouraria_total: number;
  saldo_tesouraria_parcial: boolean;
  empresas_presentes: string[];         // na coorte (data de referência), ordem = esperadas
  empresas_ausentes: string[];          // sem nenhum snapshot
  empresas_stale: string[];             // têm snapshot, mas mais antigo que a data de referência (fora da coorte)
  parcial: boolean;                     // (ausentes ∪ stale).length > 0
  data_referencia: string | null;       // data (YYYY-MM-DD) da coorte usada
  snapshot_at_mais_antigo: string | null;
};

export function consolidarCockpit(input: {
  esperadas: string[];                  // ['oben','colacor','colacor_sc'] (ordem preservada)
  snapshots: SnapshotEmpresa[];
}): CockpitConsolidado;
```

Lógica (incorpora Codex no spec — P1.1/P1.2/P1.3/P2):
1. **Dedupe por empresa (P1.2):** `Map<company, snapshot>` mantendo o de maior `snapshot_at` (parse `Date`, não string — P2.2). Evita somar a mesma empresa 2×.
2. **Coorte por data de referência (P1.3, o crítico):** `dataRef = max(date(snapshot_at))` (YYYY-MM-DD, via slice da string ISO — sem `new Date`/timezone). **Coorte = empresas cujo snapshot é da `dataRef`** (mesma rodada diária → mesmas âncoras de semana). Empresa com snapshot mais antigo → `empresas_stale` (NÃO entra na soma); sem snapshot → `empresas_ausentes`. `parcial = (ausentes ∪ stale).length > 0`. `empresas_presentes` = coorte, **na ordem de `esperadas`** (P3.2).
3. **NCG:** `ncg_por_empresa` = `esperadas.map(c => {company, ncg: coorte? : null, presente})`; `ncg_total = Σ ncg da coorte (não-null)`; `ncg_parcial = parcial || algum ncg da coorte == null`.
4. **Saldo:** `saldo_tesouraria_total = Σ saldo_tesouraria da coorte (não-null)`; `saldo_tesouraria_parcial = parcial || algum == null`.
5. **Projeção (só a coorte):** `inicios = união ordenada asc de todos os semanas[].inicio da coorte`; valida `Array.isArray` no service (P1.4). Para cada `inicio`: soma `total_entradas/total_saidas/saldo_final` das empresas da coorte que têm a semana; `por_empresa` = `{company, saldo_final}` (coorte); **`completa = (nº empresas com a semana === esperadas.length)`** (P1.1 — relativo a TODAS as esperadas, não só presentes); `semana_label` = `dd/mm` por **split de `inicio.slice(8,10)+'/'+inicio.slice(5,7)`** (sem `new Date` — P2.3). Soma só quem tem a semana (ausente ≠ zero). **Cap em 13** semanas a partir da menor âncora (P2.5).
6. `snapshot_at_mais_antigo` = min da coorte (parse Date). Valores monetários: somados em **bruto**, `round2` só na saída (P2.4).

## Service `src/services/financeiroV2Service.ts`

```ts
export async function getProjecaoSnapshotsCockpit(
  companies: Company[], cenario = 'realista'
): Promise<SnapshotEmpresa[]>;
```
Para cada company: `SELECT company, snapshot_at, ncg, saldo_tesouraria, dados FROM fin_projecao_snapshots WHERE company=? AND cenario=? ORDER BY snapshot_at DESC LIMIT 1`. **Valida `Array.isArray(dados)` (P1.4)** → mapeia cada item para `{inicio, total_entradas, total_saidas, saldo_final}` (coage números, ignora item sem `inicio`); `dados` não-array → `semanas: []` (empresa entra no NCG mas sem projeção; helper trata). Empresa sem linha → não retorna (helper marca ausente). Uma query por empresa (`Promise.all`). Tipo do param = `Company[]` (os 3 códigos).

## Hook `useFinanceiroCockpit.ts`

- **Remove** a RPC `fin_projecao_13_semanas` e o `ncg = totalCR − totalCP`.
- Adiciona fetch de `getProjecaoSnapshotsCockpit(['oben','colacor','colacor_sc'])` (no `loadAll` existente, em paralelo) → `consolidarCockpit` → expõe `cockpit` (CockpitConsolidado). `projecao13` passa a vir de `cockpit.projecao13`; `ncg` de `cockpit.ncg_total`.
- Mantém `totalCR/totalCP` (ainda usados em risco de liquidez/inadimplência), mas o **card de NCG** usa `ncg_total` (real).

## UI

- **Bloco consolidado (header):** "Consolidado 3 CNPJ · Cenário: realista · dados de {data_referencia}" + **aviso de intercompany no bloco INTEIRO** (P2.6 — o double-count afeta projeção E NCG, não só NCG) + **banner de parcialidade** se `parcial` ("N de 3 empresas — ausentes/stale: …; números são mínimo conhecido").
- **`Projecao13Card`:** consome o novo shape (`semana_label/entradas_previstas/saidas_previstas/saldo_projetado`); marca visualmente semanas com `completa=false`; não hardcoda "13" (usa `.length`).
- **Card de NCG:** `ncg_total` **com badge "N/3" quando `ncg_parcial`** (P1.5 — total parcial não pode parecer definitivo) + breakdown `ncg_por_empresa` (presente/ausente). Substitui o número CR−CP.
- **`DataBasisFooter`:** texto dinâmico pelo `regime` ativo (não "regime de caixa" fixo).
- **"Caixa Projetado 30d":** **renomear** para "Posição líquida (CR+CC−CP abertos)" (P3.4 — rename é o seguro; o número atual não é janela de 30d).
- **Labels (A-class):** "caixa disponível" (saldo bancário) vs A4/Funding (alocável pós-reserva) — rótulos; badge de regime ativo perto dos KPIs do Cockpit; "receita (vendas no app, cobertura X%)" no Cockpit de Valor; escopo "Consolidado 3 CNPJ" no título.

## Não-objetivos (v1)
- Eliminação de intercompany (documentado como premissa).
- Toggle de cenário / botão "atualizar agora" live (Capital de Giro já é a tela live/cenários).
- Decomposição ACO/PCO no Cockpit (fica no Capital de Giro).
- Drilldown empresa→semana→categoria (Codex sugeriu como ideal futuro).

## Limitações documentadas
- **Snapshot até 1 dia stale** (mostra `snapshot_at`); se o cron falhar, o Cockpit mostra dado velho com a data — honesto.
- **Caixa consolidado não é fungível** entre CNPJs (por isso o breakdown por empresa).
- **Intercompany não eliminado** (pode inflar CR/CP consolidados).

## Validação / entrega
TDD no helper (vitest). `heavy bun run test` + `typecheck:strict` + `tsc -p tsconfig.app.json` + `bun lint` + `build`. Codex adversarial. Docs em `FINANCEIRO_CONFIABILIDADE`. PR client-side (sem migration/deploy — o snapshot já é gravado pelo cron existente) + auto-merge `--squash --auto`.

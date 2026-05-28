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
  projecao13: SemanaConsolidada[];      // ordenada por inicio
  ncg_total: number;                    // Σ ncg não-null
  ncg_por_empresa: { company: string; ncg: number | null }[];
  ncg_parcial: boolean;                 // algum ncg null
  saldo_tesouraria_total: number;
  empresas_presentes: string[];
  empresas_ausentes: string[];
  parcial: boolean;                     // empresas_ausentes.length > 0
  snapshot_at_mais_antigo: string | null;
};

export function consolidarCockpit(input: {
  esperadas: string[];                  // ['oben','colacor','colacor_sc']
  snapshots: SnapshotEmpresa[];
}): CockpitConsolidado;
```

Lógica:
1. `empresas_presentes = snapshots.map(s=>s.company)` (únicas); `empresas_ausentes = esperadas − presentes`; `parcial = ausentes.length>0`.
2. `snapshot_at_mais_antigo = min(snapshot_at)` (ISO compare) ou null se vazio.
3. **NCG:** `ncg_por_empresa` = cada `{company, ncg}`; `ncg_total = Σ ncg dos não-null`; `ncg_parcial = parcial || algum ncg==null`. `saldo_tesouraria_total = Σ saldo_tesouraria não-null`.
4. **Projeção:** `inicios = união ordenada (asc) de todos os s.semanas[].inicio`. Para cada `inicio`: empresas que têm essa semana → soma `total_entradas/total_saidas/saldo_final`; `por_empresa` = `{company, saldo_final}` das que têm; `completa = (nº de empresas com a semana == empresas_presentes.length)`; `semana_label` = `dd/mm` de `inicio`. **Não zera ausência**: a soma só inclui quem tem a semana; `completa=false` sinaliza. `round2` nos valores.
5. Retorna ordenado por `inicio`.

`round2(n)=Math.round((n+Number.EPSILON)*100)/100`.

## Service `src/services/financeiroV2Service.ts`

```ts
export async function getProjecaoSnapshotsCockpit(
  companies: Company[], cenario = 'realista'
): Promise<SnapshotEmpresa[]>;
```
Para cada company: `SELECT company, snapshot_at, ncg, saldo_tesouraria, dados FROM fin_projecao_snapshots WHERE company=? AND cenario=? ORDER BY snapshot_at DESC LIMIT 1`. Mapeia `dados` (Json) → `semanas` (extrai `{inicio, total_entradas, total_saidas, saldo_final}` de cada). Empresa sem linha → não entra (o helper marca ausente). Uma query por empresa (`Promise.all`) ou `.in('company',...)` + dedup do mais recente por empresa client-side.

## Hook `useFinanceiroCockpit.ts`

- **Remove** a RPC `fin_projecao_13_semanas` e o `ncg = totalCR − totalCP`.
- Adiciona fetch de `getProjecaoSnapshotsCockpit(['oben','colacor','colacor_sc'])` (no `loadAll` existente, em paralelo) → `consolidarCockpit` → expõe `cockpit` (CockpitConsolidado). `projecao13` passa a vir de `cockpit.projecao13`; `ncg` de `cockpit.ncg_total`.
- Mantém `totalCR/totalCP` (ainda usados em risco de liquidez/inadimplência), mas o **card de NCG** usa `ncg_total` (real).

## UI

- **`Projecao13Card`:** consome o novo shape (já tem `semana_label/entradas_previstas/saidas_previstas/saldo_projetado`) + header "Cenário: realista · dados de {snapshot_at}" + (opcional) expandir por-empresa por semana. Banner se `parcial`.
- **Card de NCG:** mostra `ncg_total` + breakdown por empresa + aviso "não elimina intercompany". Substitui o número CR−CP.
- **`DataBasisFooter`:** texto dinâmico pelo `regime` ativo (não "regime de caixa" fixo).
- **"Caixa Projetado 30d":** renomear para "Posição líquida (abertos)" OU aplicar janela 30d real (decidir no plano — provável rename, trivial).
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

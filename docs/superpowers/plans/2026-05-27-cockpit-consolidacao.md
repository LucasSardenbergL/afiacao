# Cockpit — Consolidação (religar às engines) — Plano

> **REQUIRED SUB-SKILL:** superpowers:subagent-driven-development. **Codex em todas as etapas:** metodologia ✓ · spec ✓ (3 P1) · plano ← Codex antes de executar · código ← Codex adversarial (Task 3).

**Goal:** Cockpit consolidado lê projeção 13s + NCG do snapshot real (`fin_projecao_snapshots`, engine A1) em vez da RPC ingênua e do `CR−CP`; total + decomposição por empresa (caixa não-fungível entre CNPJs); coorte por data de referência; rótulos honestos. **Client-side, sem migration.** Spec: `docs/superpowers/specs/2026-05-27-cockpit-consolidacao-design.md`.

---

### Task 1: Helper `cockpit-consolida-helpers.ts` (TDD)

**Files:** Create `src/lib/financeiro/cockpit-consolida-helpers.ts` + `__tests__/cockpit-consolida-helpers.test.ts`

Contrato: ver spec (`SnapshotSemana`, `SnapshotEmpresa`, `SemanaConsolidada`, `CockpitConsolidado`, `consolidarCockpit`). `round2` padrão.

- [ ] **Step 1: testes que falham:**

```ts
import { describe, it, expect } from 'vitest';
import { consolidarCockpit, type SnapshotEmpresa } from '../cockpit-consolida-helpers';

const sem = (inicio: string, ent: number, sai: number, saldo: number) =>
  ({ inicio, total_entradas: ent, total_saidas: sai, saldo_final: saldo });
const snap = (company: string, at: string, ncg: number | null, semanas: ReturnType<typeof sem>[], saldo_tes = 0): SnapshotEmpresa =>
  ({ company, snapshot_at: at, ncg, saldo_tesouraria: saldo_tes, semanas });
const ESP = ['oben', 'colacor', 'colacor_sc'];

describe('consolidarCockpit', () => {
  it('consolida 3 empresas mesma data: soma por semana + NCG; completa=true; não parcial', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 5, 105), sem('2026-06-02', 20, 5, 120)], 50),
      snap('colacor', '2026-05-27T10:01:00Z', 200, [sem('2026-05-26', 30, 10, 220), sem('2026-06-02', 0, 0, 220)], 80),
      snap('colacor_sc', '2026-05-27T10:02:00Z', 50, [sem('2026-05-26', 5, 1, 54), sem('2026-06-02', 5, 1, 58)], 20),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.parcial).toBe(false);
    expect(r.empresas_presentes).toEqual(ESP); // ordem esperadas
    expect(r.ncg_total).toBe(350);             // 100+200+50
    expect(r.ncg_parcial).toBe(false);
    expect(r.saldo_tesouraria_total).toBe(150);
    expect(r.projecao13).toHaveLength(2);
    expect(r.projecao13[0].inicio).toBe('2026-05-26');
    expect(r.projecao13[0].entradas_previstas).toBe(45);   // 10+30+5
    expect(r.projecao13[0].saldo_projetado).toBe(379);     // 105+220+54
    expect(r.projecao13[0].semana_label).toBe('26/05');    // sem new Date
    expect(r.projecao13[0].completa).toBe(true);
    expect(r.projecao13[0].por_empresa).toHaveLength(3);
  });

  it('COORTE por data de referência: snapshot stale (dia anterior) fica FORA da soma + flag stale (P1.3)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-20T10:00:00Z', 999, [sem('2026-05-19', 1, 0, 1)]), // 7 dias atrás
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.empresas_presentes).toEqual(['oben', 'colacor']);
    expect(r.empresas_stale).toEqual(['colacor_sc']);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(300);            // 100+200; o 999 stale NÃO entra
    expect(r.projecao13[0].saldo_projetado).toBe(330); // 110+220; sem o stale
    expect(r.projecao13[0].completa).toBe(false);       // 2 de 3 esperadas
  });

  it('DEDUPE latest-wins por snapshot_at, NÃO ordem do array (P1.2): mais novo vem ANTES', () => {
    const snaps = [
      snap('oben', '2026-05-27T12:00:00Z', 150, [sem('2026-05-26', 15, 0, 165)]), // mais recente, mas 1º no array
      snap('oben', '2026-05-27T08:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]), // mais antigo, depois
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.ncg_total).toBe(400);   // 150(12:00)+200+50 — falha se "última no array vence" (daria 100)
    expect(r.projecao13[0].saldo_projetado).toBe(440); // 165+220+55
    expect(r.empresas_presentes).toEqual(ESP);
  });

  it('coorte: 3 empresas no MESMO DIA com horas diferentes → todas na coorte, não parcial (P1.1)', () => {
    const snaps = [
      snap('oben', '2026-05-27T06:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T13:30:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T23:59:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.parcial).toBe(false);
    expect(r.empresas_presentes).toEqual(ESP);
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.ncg_total).toBe(350);
    expect(r.projecao13[0].completa).toBe(true);
  });

  it('coorte por DATA via slice (não new Date local): snapshot_at de madrugada Z não muda o dia (P2)', () => {
    // 2026-05-27T01:00:00Z em America/Sao_Paulo (UTC-3) seria 2026-05-26 com new Date local — deve ficar 2026-05-27
    const snaps = [snap('oben', '2026-05-27T01:00:00Z', 0, [sem('2026-05-01', 10, 0, 10)])];
    const r = consolidarCockpit({ esperadas: ['oben'], snapshots: snaps });
    expect(r.data_referencia).toBe('2026-05-27');
    expect(r.projecao13[0].semana_label).toBe('01/05'); // não '30/04' (timezone)
  });

  it('saldo_tesouraria: 0 conta, null aciona parcial (simétrico ao ncg)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], 0),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], null),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 0, 0, 0)], 30),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.saldo_tesouraria_total).toBe(30); // 0 + (null fora) + 30
    expect(r.saldo_tesouraria_parcial).toBe(true); // colacor null
    expect(r.projecao13[0].saldo_projetado).toBe(0); // saldo 0 real não some por filtro truthy
  });

  it('stale com a MESMA semana inicio que a coorte → ainda excluído (por data, não coincidência)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-20T10:00:00Z', 999, [sem('2026-05-26', 99, 0, 999)]), // stale, mesma inicio
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.empresas_stale).toEqual(['colacor_sc']);
    expect(r.ncg_total).toBe(300);                       // 999 não entra
    expect(r.projecao13[0].saldo_projetado).toBe(330);   // 110+220, sem o 999
    expect(r.projecao13[0].por_empresa).toHaveLength(2);
  });

  it('empresa ausente (sem snapshot) → ausente + parcial; completa=false', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 100, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 200, [sem('2026-05-26', 20, 0, 220)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.empresas_ausentes).toEqual(['colacor_sc']);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(300);
    expect(r.projecao13[0].completa).toBe(false);
    expect(r.ncg_por_empresa.find(e => e.company === 'colacor_sc')).toEqual({ company: 'colacor_sc', ncg: null, presente: false });
  });

  it('ncg null (engine não computou) ≠ ncg 0; null fora da soma + ncg_parcial', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', null, [sem('2026-05-26', 10, 0, 110)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 20, 0, 220)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 50, [sem('2026-05-26', 5, 0, 55)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.ncg_total).toBe(50);        // 0 conta, null não
    expect(r.ncg_parcial).toBe(true);    // oben null
  });

  it('inícios fora de ordem entre empresas → união ordenada asc; alinha por inicio', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-06-02', 20, 0, 20), sem('2026-05-26', 10, 0, 10)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 5, 0, 5), sem('2026-06-02', 7, 0, 7)]),
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 1, 0, 1), sem('2026-06-02', 2, 0, 2)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    expect(r.projecao13.map(s => s.inicio)).toEqual(['2026-05-26', '2026-06-02']);
    expect(r.projecao13[0].saldo_projetado).toBe(16); // 10+5+1
  });

  it('semana só de uma empresa → completa=false (soma só quem tem; ausente≠zero)', () => {
    const snaps = [
      snap('oben', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 10, 0, 110), sem('2026-06-02', 5, 0, 115)]),
      snap('colacor', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 20, 0, 220)]), // sem a 2ª semana
      snap('colacor_sc', '2026-05-27T10:00:00Z', 0, [sem('2026-05-26', 1, 0, 1)]),
    ];
    const r = consolidarCockpit({ esperadas: ESP, snapshots: snaps });
    const w2 = r.projecao13.find(s => s.inicio === '2026-06-02')!;
    expect(w2.saldo_projetado).toBe(115);  // só oben
    expect(w2.completa).toBe(false);
    expect(w2.por_empresa).toHaveLength(1);
  });

  it('vazio → tudo ausente, parcial, projeção vazia, sem NaN', () => {
    const r = consolidarCockpit({ esperadas: ESP, snapshots: [] });
    expect(r.empresas_ausentes).toEqual(ESP);
    expect(r.parcial).toBe(true);
    expect(r.ncg_total).toBe(0);
    expect(r.projecao13).toEqual([]);
    expect(r.data_referencia).toBeNull();
  });

  it('cap nas 13 PRIMEIRAS semanas por menor inicio (não 13 quaisquer)', () => {
    // 16 semanas sequenciais 2026-01-01..2026-01-16
    const semanas = Array.from({ length: 16 }, (_, i) => sem(`2026-01-${String(i + 1).padStart(2, '0')}`, 1, 0, 1));
    const r = consolidarCockpit({ esperadas: ['oben'], snapshots: [snap('oben', '2026-05-27T10:00:00Z', 0, semanas)] });
    expect(r.projecao13).toHaveLength(13);
    expect(r.projecao13[0].inicio).toBe('2026-01-01');
    expect(r.projecao13[12].inicio).toBe('2026-01-13'); // as 13 PRIMEIRAS, não 14/15/16
  });
});
```

- [ ] **Step 2:** ver falhar. **Step 3:** implementar conforme a "Lógica" do spec (dedupe Map por company latest; coorte por `snapshot_at.slice(0,10)` == dataRef=max; presentes na ordem esperadas; NCG/saldo Σ não-null da coorte + parcial; projeção união de inícios asc, soma coorte por inicio, completa vs esperadas.length, label por slice, cap 13; round só na saída). **Step 4:** ver passar.
- [ ] **Step 5: commit** — `feat(cockpit): helper consolidarCockpit (snapshot-first, coorte, total+empresa) + testes`.

---

### Task 2: Service + hook + cards + rótulos

**Files:** Modify `src/services/financeiroV2Service.ts`, `src/components/financeiro/cockpit/useFinanceiroCockpit.ts`, `Projecao13Card.tsx`, `DataBasisFooter.tsx`, `FinanceiroCockpit.tsx` (+ card NCG), e os rótulos A-class.

- [ ] **Step 1: `getProjecaoSnapshotsCockpit(companies, cenario='realista')`** no service: por empresa, último snapshot (`order snapshot_at desc limit 1`), valida `Array.isArray(dados)`, mapeia `{company, snapshot_at, ncg, saldo_tesouraria, semanas}`. `Promise.all`.
- [ ] **Step 2: hook** — no `loadAll`, buscar os snapshots em paralelo; remover a RPC `fin_projecao_13_semanas` e o `ncg = totalCR − totalCP`; expor `cockpit = consolidarCockpit({ esperadas: ['oben','colacor','colacor_sc'], snapshots })`; `projecao13 = cockpit.projecao13`, `ncg = cockpit.ncg_total`. Manter `totalCR/totalCP` (risco liquidez/inadimplência).
- [ ] **Step 3: cards** — `Projecao13Card` consome o novo shape (header cenário+data_referencia+banner parcial+aviso intercompany; marca semana `completa=false`; `.length` em vez de "13"). Card NCG: `ncg_total` + badge "N/3" se `ncg_parcial` + breakdown `ncg_por_empresa`. `DataBasisFooter` dinâmico por regime. "Caixa Projetado 30d" → rename "Posição líquida (CR+CC−CP abertos)". Labels A-class (caixa disponível, regime badge, receita valor cobertura, escopo).
- [ ] **Step 4:** `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` limpos.
- [ ] **Step 5: commit** — `feat(cockpit): religa projeção 13s + NCG ao snapshot real (engine A1) + rótulos honestos`.

---

### Task 3: Docs + validação + Codex adversarial + PR

- [ ] **Step 1:** seção no `FINANCEIRO_CONFIABILIDADE.md` (Cockpit religado às engines; snapshot-first; total+empresa; limitações: stale até 1 dia, intercompany não eliminado, caixa não-fungível).
- [ ] **Step 2: validação** — `heavy bun run test` + `heavy bun run typecheck:strict` + `bunx tsc --noEmit -p tsconfig.app.json` + `bun lint` + `heavy bun run build`.
- [ ] **Step 3: Codex ADVERSARIAL** no helper + integração (coorte/dedupe corretos? completa vs esperadas? dados inválido? hooks ok? NaN? labels honestos?). Incorporar P1/P2.
- [ ] **Step 4: PR** — push; `gh pr create` (sem migration/deploy — snapshot já gravado pelo cron); auto-merge `--squash --auto`.

---

## Notas
- **Sem migration/edge/deploy** — o snapshot diário já é gravado pelo cron `fin-cashflow-snapshot-diario` (engine com `save_snapshot`). Só consumimos.
- Coorte por data de referência (P1.3) = a chave da coerência matemática.
- `tsc --noEmit -p tsconfig.app.json` é o typecheck do `src`.

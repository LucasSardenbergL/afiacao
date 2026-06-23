import { describe, it, expect } from "vitest";

/**
 * DEADLINE TEST — aposentadoria do import CSV tintométrico (Opção A).
 *
 * Contexto: o catálogo tintométrico passou a ser AUTOMÁTICO (sync do Sayersystem em
 * tempo real, conector no balcão). A importação manual por CSV foi ESCONDIDA atrás de
 * um break-glass (`?csv=emergencia`) em vez de removida de imediato — para manter um
 * plano B caso o conector/balcão caia. Combinado com o founder (Lucas): REMOVER DE VEZ
 * após ~3 semanas de sync estável. Prazo: 2026-07-13.
 *
 * Quando este teste FICAR VERMELHO, é o despertador — não a memória de ninguém. Como os
 * PRs só mergeiam com CI verde (auto-merge), o vermelho trava o próximo merge e força a
 * limpeza. Para remover (≈5 min):
 *   1. src/pages/TintImport.tsx — apagar o branch `csvEmergencia`, o <ImportCard>, o
 *      <HistoryTable> e os handlers de CSV (handleFiles / handleImportWithMode /
 *      handleResume); deixar só o <SyncCard> (Omie).
 *   2. src/pages/TintIntegracao.tsx — reavaliar a aba "Produtos Omie" (mover o SyncCard
 *      p/ "Integrações" e remover a aba, ou mantê-la).
 *   3. src/App.tsx — remover a rota redirect `tintometrico/importar`.
 *   4. src/components/tintImport/* e hooks de import CSV que ficarem órfãos (knip acusa).
 *   5. Apagar ESTE arquivo.
 * Ver: docs/runbooks/tint-sync-corte-csv.md
 */
describe("aposentadoria do import CSV tintométrico (deadline)", () => {
  const PRAZO = new Date("2026-07-13T00:00:00Z");

  it(`break-glass do CSV deve ser REMOVIDO a partir de ${PRAZO.toISOString().slice(0, 10)}`, () => {
    const hoje = new Date();
    expect(
      hoje.getTime() < PRAZO.getTime(),
      "PRAZO VENCIDO (2026-07-13): remova o break-glass de importação CSV tintométrico " +
        "(<ImportCard>/<HistoryTable> + branch `csvEmergencia` em TintImport.tsx + rota em App.tsx). " +
        "Passo-a-passo no topo deste arquivo e em docs/runbooks/tint-sync-corte-csv.md.",
    ).toBe(true);
  });
});

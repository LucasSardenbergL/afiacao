import { describe, it, expect } from 'vitest';
import { docsComCodigoAmbiguoNoOmie } from './omie-doc-ambiguo';

// P1b (fail-closed no doc-dup-Omie) — espelha o fail-closed do lado profile (fetchProfileDocUserMap).
// Falsificação: os casos +/- se falsificam MUTUAMENTE — um helper que retorna sempre-∅ reprova o caso
// ambíguo; um que marca tudo reprova os casos não-ambíguos. Ver
// docs/superpowers/specs/2026-07-09-omie-proof-table-staleness-doc-ambiguo-design.md
describe('docsComCodigoAmbiguoNoOmie (P1b fail-closed money-path)', () => {
  it('doc com 1 só código → NÃO ambíguo (∅)', () => {
    const r = docsComCodigoAmbiguoNoOmie([{ doc: '111', codigo: 100 }]);
    expect(r.size).toBe(0);
  });

  it('doc com 2 códigos DISTINTOS na mesma conta → AMBÍGUO (fecha o last-write-wins)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 200 },
    ]);
    expect(r.has('111')).toBe(true);
    expect(r.size).toBe(1);
  });

  it('doc com o MESMO código repetido (duplicata do Omie na paginação) → NÃO ambíguo', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 100 },
    ]);
    expect(r.size).toBe(0);
  });

  it('3+ códigos no mesmo doc → ambíguo', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '111', codigo: 100 },
      { doc: '111', codigo: 200 },
      { doc: '111', codigo: 300 },
    ]);
    expect(r.has('111')).toBe(true);
  });

  it('doc vazio é ignorado (não vira chave)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: '', codigo: 100 },
      { doc: '', codigo: 200 },
    ]);
    expect(r.size).toBe(0);
  });

  it('mistura: só os docs ambíguos entram; os limpos ficam de fora (precisão do escopo)', () => {
    const r = docsComCodigoAmbiguoNoOmie([
      { doc: 'A', codigo: 1 }, // limpo
      { doc: 'B', codigo: 2 }, // ambíguo (2 códigos)
      { doc: 'B', codigo: 3 },
      { doc: 'C', codigo: 4 }, // limpo
      { doc: 'C', codigo: 4 }, // repetição do mesmo → segue limpo
    ]);
    expect([...r].sort()).toEqual(['B']);
  });

  it('lista vazia → ∅', () => {
    expect(docsComCodigoAmbiguoNoOmie([]).size).toBe(0);
  });
});

// ── Mecânica da canária `doc_ambiguo_probe` (edge omie-analytics-sync, case doc_ambiguo_probe) ──────
// O probe roda o helper DEPLOYADO (bloco MIRROR do edge) sobre fixtures fixos e compara com o esperado
// via `canon` + `stableId`. Ele existe porque a ausência do helper é INDETECTÁVEL por sonda de dados: a
// proof-table só encolhe quando há duplicata-CNPJ real na conta, e não há (colacor_sc: 5275→5275 no run).
// `deno check` prova que o edge COMPILA; o guard textual (edge-money-path-invariants) prova a
// EXISTÊNCIA/paridade. Falta o que só a execução pega: (1) a comparação MORDE (senão o probe daria
// ok:true sempre — falsa tranquilidade); (2) os `expected` escritos à mão CORRESPONDEM ao comportamento
// real (trocar ∅↔{doc} compila mas faria o probe gritar ok:false em prod com a lógica certa). Roda a
// função REAL de src/ (idêntica ao edge por paridade) sobre os MESMOS fixtures. Espelha o `canon`/
// `stableId` do edge.
const stableId = (o: unknown): string =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v);

const canon = (xs: Iterable<string>): string[] => [...xs].sort();

// Espelha VERBATIM os 7 fixtures do edge (case doc_ambiguo_probe) — a enumeração completa do oráculo.
const PROBE_FIXTURES: Array<{ caso: string; registros: Array<{ doc: string; codigo: number }>; expected: string[] }> = [
  { caso: 'doc_1_codigo', registros: [{ doc: '111', codigo: 100 }], expected: [] },
  { caso: 'doc_2_codigos_distintos', registros: [{ doc: '111', codigo: 100 }, { doc: '111', codigo: 200 }], expected: ['111'] },
  { caso: 'doc_mesmo_codigo_repetido', registros: [{ doc: '111', codigo: 100 }, { doc: '111', codigo: 100 }], expected: [] },
  { caso: 'doc_3_codigos', registros: [{ doc: '111', codigo: 100 }, { doc: '111', codigo: 200 }, { doc: '111', codigo: 300 }], expected: ['111'] },
  { caso: 'doc_vazio_ignorado', registros: [{ doc: '', codigo: 100 }, { doc: '', codigo: 200 }], expected: [] },
  { caso: 'mistura_so_ambiguos', registros: [{ doc: 'A', codigo: 1 }, { doc: 'B', codigo: 2 }, { doc: 'B', codigo: 3 }, { doc: 'C', codigo: 4 }, { doc: 'C', codigo: 4 }], expected: ['B'] },
  { caso: 'lista_vazia', registros: [], expected: [] },
];

describe('canária doc_ambiguo_probe: mecânica de comparação + fixtures (mesma lógica do edge)', () => {
  it('canon+stableId é order-insensitive (conjunto: ordem de inserção não é sinal)', () => {
    expect(stableId(canon(new Set(['B', 'A'])))).toBe(stableId(canon(['A', 'B'])));
  });

  it('canon+stableId TEM DENTE: conteúdo diferente → string diferente (senão o probe nunca morderia)', () => {
    // ∅ vs {doc}: a diferença entre "vira vínculo" e "fail-closed" — o coração do P1b
    expect(stableId(canon([]))).not.toBe(stableId(canon(['111'])));
    // doc diferente (QUAL doc é ambíguo importa: marca o cliente errado)
    expect(stableId(canon(['111']))).not.toBe(stableId(canon(['222'])));
    // subconjunto não passa por igual (marcar 1 de 2 ambíguos deixaria um last-write-wins vivo)
    expect(stableId(canon(['A']))).not.toBe(stableId(canon(['A', 'B'])));
  });

  it('os 7 fixtures do probe rodam a função REAL e batem no esperado (probe → ok:true pós-deploy)', () => {
    for (const f of PROBE_FIXTURES) {
      const resolved = canon(docsComCodigoAmbiguoNoOmie(f.registros));
      expect(stableId(resolved), `fixture ${f.caso}: resolved diverge do expected`).toBe(stableId(canon(f.expected)));
    }
  });

  it('FALSIFICAÇÃO: expected sabotado → probe reportaria ok:false (a canária pega helper deployado errado)', () => {
    const f = PROBE_FIXTURES[1]; // doc_2_codigos_distintos → ['111']
    const resolved = canon(docsComCodigoAmbiguoNoOmie(f.registros));
    // um helper deployado que NÃO detecta ambiguidade (revertido pelo Lovable) devolveria ∅ aqui
    expect(stableId(resolved)).not.toBe(stableId(canon([])));
  });
});

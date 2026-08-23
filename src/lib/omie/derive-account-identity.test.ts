import { describe, it, expect } from 'vitest';
import { decideAccountIdentity, type DecideInput, type DecideResult } from './derive-account-identity';

const A = 'oben';

describe('decideAccountIdentity (threat-model P0-B §5)', () => {
  it('espelho com 1 código na conta → usa (source mirror, sem backfill)', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 100,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, source: 'mirror', codigo_cliente: 100, codigo_vendedor: 9, backfill: false });
  });

  it('espelho vazio, sem Omie ainda → pede Omie', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: null });
    expect(r).toEqual({ ok: false, needOmie: true });
  });

  it('espelho vazio, Omie 1 match → usa + backfill', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }],
    });
    expect(r).toEqual({ ok: true, source: 'omie', codigo_cliente: 200, codigo_vendedor: 7, backfill: true });
  });

  it('Omie >1 match (duplicata-CNPJ) → fail-closed ambiguous_omie', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 201, codigo_vendedor: 7 }],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_omie' });
  });

  it('Omie 0 match (ausência confirmada) → fail-closed absent', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [] });
    expect(r).toEqual({ ok: false, reason: 'absent' });
  });

  it('espelho >1 código distinto na conta → fail-closed ambiguous_mirror', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, omieMatches: null,
      mirrorRows: [
        { omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A },
        { omie_codigo_cliente: 101, omie_codigo_vendedor: 9, empresa_omie: A },
      ],
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_mirror' });
  });

  it('espelho só tem linha de OUTRA conta → ignora, pede Omie', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, omieMatches: null,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: 'colacor' }],
    });
    expect(r).toEqual({ ok: false, needOmie: true });
  });

  it('divergência supplied != derived → fail-closed', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 999,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: false, reason: 'divergence' });
  });

  it('supplied == derived (mesmo número, tipos diferentes) → ok (bigint-safe por string)', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: 100,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }],
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, source: 'mirror', codigo_cliente: 100, codigo_vendedor: 9, backfill: false });
  });

  it('código não SafeInteger → fail-closed unsafe_integer', () => {
    const r = decideAccountIdentity({
      account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: 1 }],
    });
    expect(r).toEqual({ ok: false, reason: 'unsafe_integer' });
  });
});

// ── Mecânica da canária `identidade_probe` (edge omie-vendas-sync, case identidade_probe) ──────
// O probe roda decideAccountIdentity DEPLOYADA sobre fixtures fixos e compara com o esperado via
// `stableId` (deep-equal order-insensitive — os ramos de DecideResult retornam chaves em ordens
// distintas). `deno check` prova que o edge COMPILA e que cada `expected` é um DecideResult BEM-TIPADO;
// o guard textual (edge-money-path-invariants) prova a EXISTÊNCIA/paridade. Falta o que só a execução
// pega: (1) o `stableId` MORDE (senão o probe daria ok:true sempre — falsa tranquilidade); (2) os
// `expected` escritos à mão CORRESPONDEM ao comportamento real (trocar absent↔ambiguous compila mas
// faria o probe gritar ok:false em prod com a lógica certa). Roda a função REAL de src/ (idêntica ao
// edge por paridade) sobre os MESMOS fixtures do probe. `stableId` espelha o do edge.
const stableId = (o: unknown): string =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v);

// Espelha VERBATIM os 9 fixtures do edge (case identidade_probe) — a tabela-verdade completa.
const PROBE_FIXTURES: Array<{ caso: string; input: DecideInput; expected: DecideResult }> = [
  { caso: 'mirror_1_dono', input: { account: A, suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }], omieMatches: null }, expected: { ok: true, source: 'mirror', codigo_cliente: 123, codigo_vendedor: 7, backfill: false } },
  { caso: 'supplied_confirma', input: { account: A, suppliedCodigo: 123, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }], omieMatches: null }, expected: { ok: true, source: 'mirror', codigo_cliente: 123, codigo_vendedor: 7, backfill: false } },
  { caso: 'divergencia_supplied', input: { account: A, suppliedCodigo: 999, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }], omieMatches: null }, expected: { ok: false, reason: 'divergence' } },
  { caso: 'ambiguous_mirror', input: { account: A, suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }, { omie_codigo_cliente: 124, omie_codigo_vendedor: 7, empresa_omie: A }], omieMatches: null }, expected: { ok: false, reason: 'ambiguous_mirror' } },
  { caso: 'outra_conta_ignorada_pede_omie', input: { account: A, suppliedCodigo: null, mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: 'colacor' }], omieMatches: null }, expected: { ok: false, needOmie: true } },
  { caso: 'omie_1match_backfill', input: { account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }] }, expected: { ok: true, source: 'omie', codigo_cliente: 200, codigo_vendedor: 7, backfill: true } },
  { caso: 'ambiguous_omie', input: { account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 201, codigo_vendedor: 7 }] }, expected: { ok: false, reason: 'ambiguous_omie' } },
  { caso: 'omie_ausente_absent', input: { account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [] }, expected: { ok: false, reason: 'absent' } },
  { caso: 'unsafe_integer', input: { account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [{ codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: 1 }] }, expected: { ok: false, reason: 'unsafe_integer' } },
];

describe('canária identidade_probe: mecânica de comparação + fixtures (mesma lógica do edge)', () => {
  it('stableId é order-insensitive (chaves trocadas → mesma string canônica)', () => {
    expect(stableId({ ok: true, source: 'mirror', codigo_cliente: 123, codigo_vendedor: 7, backfill: false }))
      .toBe(stableId({ backfill: false, codigo_vendedor: 7, codigo_cliente: 123, source: 'mirror', ok: true }));
  });

  it('stableId TEM DENTE: conteúdo diferente → string diferente (senão o probe nunca morderia)', () => {
    // reason trocado (o erro exato do fail-closed importa)
    expect(stableId({ ok: false, reason: 'divergence' })).not.toBe(stableId({ ok: false, reason: 'absent' }));
    // código diferente (o valor autoritativo importa)
    expect(stableId({ ok: true, source: 'mirror', codigo_cliente: 123, codigo_vendedor: 7, backfill: false }))
      .not.toBe(stableId({ ok: true, source: 'mirror', codigo_cliente: 124, codigo_vendedor: 7, backfill: false }));
  });

  it('os 9 fixtures do probe rodam a função REAL e batem no esperado (probe → ok:true pós-deploy)', () => {
    for (const f of PROBE_FIXTURES) {
      const resolved = decideAccountIdentity(f.input);
      expect(stableId(resolved), `fixture ${f.caso}: resolved diverge do expected`).toBe(stableId(f.expected));
    }
  });

  it('FALSIFICAÇÃO: expected sabotado → probe reportaria ok:false (a canária pega lógica deployada errada)', () => {
    const f = PROBE_FIXTURES[0]; // mirror_1_dono
    const resolved = decideAccountIdentity(f.input);
    const sabotado: DecideResult = { ok: true, source: 'mirror', codigo_cliente: 999, codigo_vendedor: 7, backfill: false };
    expect(stableId(resolved)).not.toBe(stableId(sabotado));
  });
});

// ════════ CONTROLE DE CALIBRAÇÃO da canária `identidade_probe` (omie-vendas-sync) ════════
// "Canária que não discrimina é teatro verde" (docs/agent/deploy.md): sem provar que a fixture fica
// VERMELHA sob a forma ANTIGA, a probe só prova que a edge responde. Os nomes dos casos são os da
// probe de propósito — renomear lá sem atualizar aqui é ruído que se vê no diff.
describe('CALIBRAÇÃO: a canária identidade_probe fica VERMELHA sob a forma pré-P0-B', () => {
  // A forma antiga: o código do payload era ADVISORY na aparência e AUTORIDADE na prática — quando
  // vinha preenchido, vencia o derivado em vez de ser verificado contra ele. É o ataque que o P0-B
  // fechou (payload escolhe o cliente ⇒ pedido no CNPJ errado).
  const decideAntigo = (input: DecideInput): DecideResult => {
    if (input.suppliedCodigo != null) {
      return { ok: true, source: 'mirror', codigo_cliente: input.suppliedCodigo, codigo_vendedor: 7, backfill: false };
    }
    return decideAccountIdentity(input);
  };

  const FIX_DIVERGENCIA: DecideInput = {
    account: A, suppliedCodigo: 999,
    mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }],
    omieMatches: null,
  };

  it('`divergencia_supplied`: a forma ANTIGA resolve 999 em vez de recusar — diverge do `expected`', () => {
    const antigo = decideAntigo(FIX_DIVERGENCIA);
    expect(antigo).toEqual({ ok: true, source: 'mirror', codigo_cliente: 999, codigo_vendedor: 7, backfill: false });
    // o `expected` que a canária carrega para este caso:
    expect(antigo).not.toEqual({ ok: false, reason: 'divergence' });
  });

  it('`divergencia_supplied`: a forma ATUAL recusa — a canária fica verde só com o P0-B deployado', () => {
    expect(decideAccountIdentity(FIX_DIVERGENCIA)).toEqual({ ok: false, reason: 'divergence' });
  });

  it('controle positivo: em `supplied_confirma` as duas concordam (o teste não é vacuamente verde)', () => {
    // Advisory que CONFIRMA o derivado: as duas formas resolvem 123. Se divergissem em TUDO, o
    // assert acima provaria só que são funções diferentes — não que a FIXTURE foi bem escolhida.
    const confirma: DecideInput = {
      account: A, suppliedCodigo: 123,
      mirrorRows: [{ omie_codigo_cliente: 123, omie_codigo_vendedor: 7, empresa_omie: A }],
      omieMatches: null,
    };
    const esperado = { ok: true, source: 'mirror', codigo_cliente: 123, codigo_vendedor: 7, backfill: false };
    expect(decideAntigo(confirma)).toEqual(esperado);
    expect(decideAccountIdentity(confirma)).toEqual(esperado);
  });
});

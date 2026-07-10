import { describe, it, expect } from 'vitest';
import { decidirIdentidadeSelfService, type MatchOmie } from './omie-sync-identidade';

// P0-B-bis PR-1 — identidade Omie do PEDIDO SELF-SERVICE (conta colacor_sc) resolvida pela VIEW FRESCA
// account-correta + fallback API fail-closed (registros_por_pagina:2). Precisão>recall.
// Falsificação: os casos +/- se falsificam MUTUAMENTE — um helper que sempre pega o 1º match reprova o
// caso doc-ambíguo (esperaria ok:false, veria ok:true); um que sempre rejeita reprova os casos ok.
// Ver docs/superpowers/plans/2026-07-09-omie-sync-self-service-view-fresca-pr1.md (Task 1).
describe('decidirIdentidadeSelfService (P0-B-bis fail-closed money-path)', () => {
  it('view fresca presente → ok com o código da view (fonte account-correta, sem API)', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: { codigo_cliente: 100, codigo_vendedor: 9 },
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 100, codigo_vendedor: 9 });
  });

  it('view presente com vendedor NULL → ok com vendedor null (colacor_sc não tem vendedor)', () => {
    // Caso REAL: a proof colacor_sc tem omie_codigo_vendedor 100% NULL (psql-ro 2026-07-09).
    const r = decidirIdentidadeSelfService({
      viewRow: { codigo_cliente: 100, codigo_vendedor: null },
      omieMatches: null,
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 100, codigo_vendedor: null });
  });

  it('view ausente e API ainda não buscada → pede Omie (needOmie)', () => {
    const r = decidirIdentidadeSelfService({ viewRow: null, omieMatches: null });
    expect(r).toEqual({ ok: false, needOmie: true });
  });

  it('view ausente, API 1 match → ok com o código do Omie', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: null,
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }],
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 200, codigo_vendedor: 7 });
  });

  it('view ausente, API 2 matches com códigos DISTINTOS → fail-closed doc-ambíguo (fecha last-write-wins)', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: null,
      omieMatches: [
        { codigo_cliente: 200, codigo_vendedor: 7 },
        { codigo_cliente: 201, codigo_vendedor: 7 },
      ],
    });
    expect(r).toEqual({ ok: false, erro: 'doc-ambíguo' });
  });

  it('view ausente, API 2 matches com o MESMO código (duplicata na paginação, sem mais páginas) → ok', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: null,
      omieMatches: [
        { codigo_cliente: 200, codigo_vendedor: 7 },
        { codigo_cliente: 200, codigo_vendedor: 7 },
      ],
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 200, codigo_vendedor: 7 });
  });

  it('view ausente, 1 código visto MAS busca TRUNCADA (há mais páginas) → fail-closed doc-ambíguo (Codex P1)', () => {
    // registros:2 sozinho não prova unicidade: [200,200] na pág.1 pode esconder um 201 na pág.2.
    // total_de_paginas>1 → não posso provar código único → precisão>recall bloqueia.
    const r = decidirIdentidadeSelfService({
      viewRow: null,
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 200, codigo_vendedor: 7 }],
      omieTruncado: true,
    });
    expect(r).toEqual({ ok: false, erro: 'doc-ambíguo' });
  });

  it('view ausente, 1 match e NÃO truncado → ok (o caso normal do fluxo)', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: null,
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }],
      omieTruncado: false,
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 200, codigo_vendedor: 7 });
  });

  it('view PRESENTE ignora omieTruncado (a view não é paginada) → ok', () => {
    const r = decidirIdentidadeSelfService({
      viewRow: { codigo_cliente: 100, codigo_vendedor: null },
      omieMatches: null,
      omieTruncado: true,
    });
    expect(r).toEqual({ ok: true, codigo_cliente: 100, codigo_vendedor: null });
  });

  it('view ausente, API 0 match (ausência confirmada) → fail-closed sem-vinculo', () => {
    const r = decidirIdentidadeSelfService({ viewRow: null, omieMatches: [] });
    expect(r).toEqual({ ok: false, erro: 'sem-vinculo' });
  });

  it('código não SafeInteger (bigint ≥ 2^53) → fail-closed codigo-inseguro (não trunca p/ o Omie)', () => {
    // Alinhado ao guard do irmão decideAccountIdentity: Number perde precisão ≥ 2^53 → cliente errado.
    const r = decidirIdentidadeSelfService({
      viewRow: { codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: null },
      omieMatches: null,
    });
    expect(r).toEqual({ ok: false, erro: 'codigo-inseguro' });
  });

  it('código zero/negativo → fail-closed codigo-inseguro', () => {
    expect(decidirIdentidadeSelfService({ viewRow: { codigo_cliente: 0, codigo_vendedor: null }, omieMatches: null }))
      .toEqual({ ok: false, erro: 'codigo-inseguro' });
  });

  // ── FALSIFICAÇÃO explícita: um helper que ignora a ambiguidade e pega o 1º match daria ok:true no caso
  //    doc-ambíguo. Este teste crava que o resultado ambíguo NÃO é o 1º código (o assert tem dente).
  it('FALSIFICAÇÃO: no caso 2-códigos-distintos, NÃO retorna ok com o 1º código (senão seria last-write-wins)', () => {
    const matches: MatchOmie[] = [
      { codigo_cliente: 200, codigo_vendedor: 7 },
      { codigo_cliente: 201, codigo_vendedor: 7 },
    ];
    const r = decidirIdentidadeSelfService({ viewRow: null, omieMatches: matches });
    expect(r.ok).toBe(false);
    // um helper ingênuo retornaria { ok:true, codigo_cliente:200, ... } — provamos que NÃO é isso.
    expect(r).not.toEqual({ ok: true, codigo_cliente: 200, codigo_vendedor: 7 });
  });
});

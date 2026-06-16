import { describe, it, expect } from 'vitest';
import { sinaisParaModifiers } from '../converter';
import type { SinaisLigacao } from '../schema';

const vazio: SinaisLigacao = {
  precos: [], marcas_em_uso: [], produtos_gap: [], demandas_novas: [], houve_sinal: false,
};

describe('sinaisParaModifiers — contrato estrito de preço', () => {
  it('concorrente mais barato COMPLETO (cliente falando) → churn, classe preco', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.9, evidencia: 'a Norton me cobra 1,20 a unidade' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'churn', classe: 'preco' });
    expect(mods[0].weight).toBeCloseTo(0.9);
  });

  it('preço SEM unidade comparável → NÃO pontua (inteligência crua)', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa', valor: null, moeda: null, unidade_base: null,
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.9, evidencia: 'a Norton é mais barata' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('preço dito pelo FARMER (não-cliente) → NÃO pontua', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: false, confianca: 0.9, evidencia: 'sei que a Norton cobra 1,20' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('confiança abaixo do threshold → NÃO pontua', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'concorrente_cobra', produto: 'lixa 220', valor: 1.2, moeda: 'BRL', unidade_base: 'un',
      concorrente: 'Norton', speaker_is_customer: true, confianca: 0.4, evidencia: '...' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('cliente_paga (não é concorrente mais barato) → NÃO pontua churn', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, precos: [{
      tipo: 'cliente_paga', produto: 'lixa 220', valor: 1.5, moeda: 'BRL', unidade_base: 'un',
      concorrente: null, speaker_is_customer: true, confianca: 0.9, evidencia: 'pago 1,50' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });
});

describe('sinaisParaModifiers — marca e demanda', () => {
  it('marca concorrente em uso (cliente) → churn, classe marca', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, marcas_em_uso: [{
      marca: 'Norton', produto: 'lixa', e_concorrente: true, speaker_is_customer: true, confianca: 0.8, evidencia: 'hoje uso Norton' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'churn', classe: 'marca' });
  });

  it('marca própria (não concorrente) → NÃO pontua', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, marcas_em_uso: [{
      marca: 'Colacor', produto: 'lixa', e_concorrente: false, speaker_is_customer: true, confianca: 0.9, evidencia: 'uso a de vocês' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('demanda nova (confiante) → expansion, classe demanda', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, demandas_novas: [{
      descricao: 'quer disco flap', contexto: null, urgencia: null, recorrente: null, confianca: 0.75, evidencia: 'preciso de disco flap' }] };
    const mods = sinaisParaModifiers(s);
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({ dimension: 'expansion', classe: 'demanda' });
  });

  it('produto-gap NÃO gera modifier (é compra, Fatia 3)', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: true, produtos_gap: [{
      descricao: 'verniz X', familia: null, material: null, dimensao: null, recorrente: null, confianca: 0.9, evidencia: '...' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });

  it('houve_sinal=false → [] (não fabrica mesmo com arrays preenchidos)', () => {
    const s: SinaisLigacao = { ...vazio, houve_sinal: false, demandas_novas: [{
      descricao: 'x', contexto: null, urgencia: null, recorrente: null, confianca: 0.9, evidencia: 'x' }] };
    expect(sinaisParaModifiers(s)).toEqual([]);
  });
});

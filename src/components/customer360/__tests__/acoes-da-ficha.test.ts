import { describe, it, expect } from 'vitest';
import { resumoCredito, rotuloPrazoTarefa, type CreditoLido } from '../acoes-da-ficha';

const FRESCO = [{ company: 'oben', syncAt: '2026-11-22T10:00:00Z', estado: 'ok' as const }];
const base: CreditoLido = { semConta: false, conflito: false, aliasesConferidos: true, alerta: null, frescor: FRESCO };
const alerta = { vencido: 1234.5, titulos: 2, vencimentoMaisAntigo: '2026-08-01', syncAt: '2026-11-22T10:00:00Z', dadoDefasado: false };

describe('resumoCredito — nunca "nada vencido" sem leitura', () => {
  it('falha e carregando não afirmam saúde de crédito', () => {
    expect(resumoCredito('falha', undefined)).toMatchObject({ tom: 'neutro', titulo: expect.stringContaining('indisponível') });
    expect(resumoCredito('carregando', undefined).tom).toBe('neutro');
  });

  it('conflito de cadastro do grupo: não soma', () => {
    expect(resumoCredito('ok', { ...base, conflito: true }).titulo).toContain('conflito');
  });

  it('sem conta Omie: diz isso, não "nada vencido"', () => {
    expect(resumoCredito('ok', { ...base, semConta: true })).toMatchObject({ tom: 'neutro', titulo: expect.stringContaining('Sem conta Omie') });
  });

  it('lido e sem vencido 60+: ok', () => {
    expect(resumoCredito('ok', base)).toMatchObject({ tom: 'ok', titulo: 'Nenhum título vencido há 60+ dias', notas: [] });
  });

  it('vencido: valor, títulos e desde quando — e nunca a palavra "limite"', () => {
    const r = resumoCredito('ok', { ...base, alerta });
    expect(r.tom).toBe('alerta');
    expect(r.titulo).toMatch(/R\$\s?1\.234,50 vencido há 60\+ dias · 2 títulos · desde 01\/08\/2026/);
    expect(r.titulo.toLowerCase()).not.toContain('limite');
  });

  it('sem aliases conferidos: avisa que a soma pode ser parcial', () => {
    expect(resumoCredito('ok', { ...base, aliasesConferidos: false }).notas.join(' ')).toContain('parcial');
  });

  it('sync defasado: avisa com a data e o nome da empresa', () => {
    const r = resumoCredito('ok', {
      ...base,
      alerta: { ...alerta, dadoDefasado: true, syncAt: '2026-11-18T10:00:00Z' },
      frescor: [{ company: 'colacor', syncAt: '2026-11-18T10:00:00Z', estado: 'defasado' }],
    });
    expect(r.notas.join(' ')).toContain('Colacor: financeiro sincronizado em 18/11/2026');
  });

  // Onda B: sem títulos, o VERDE só vale com todas as empresas frescas.
  it('sem títulos + sync com erro: NÃO é verde, diz qual empresa falhou', () => {
    const r = resumoCredito('ok', { ...base, frescor: [...FRESCO, { company: 'colacor_sc', syncAt: '2026-11-20T10:00:00Z', estado: 'erro' }] });
    expect(r.tom).toBe('neutro');
    expect(r.titulo).toBe('Crédito não confirmado: o financeiro não está sincronizado');
    expect(r.notas.join(' ')).toContain('Colacor SC: o último sync do financeiro falhou (último sync concluído em 20/11/2026)');
  });

  it('sem títulos + empresa nunca sincronizada: NÃO é verde', () => {
    const r = resumoCredito('ok', { ...base, frescor: [{ company: 'oben', syncAt: null, estado: 'nunca' }] });
    expect(r.tom).toBe('neutro');
    expect(r.notas).toEqual(['Oben: o financeiro nunca foi sincronizado.']);
  });

  it('sem títulos + defasado: afirma só até o último sync, sem verde', () => {
    const r = resumoCredito('ok', { ...base, frescor: [{ company: 'oben', syncAt: '2026-11-18T10:00:00Z', estado: 'defasado' }] });
    expect(r).toMatchObject({ tom: 'neutro', titulo: 'Nenhum título vencido há 60+ dias no último sync' });
  });

  it('sem títulos + frescor vazio (nada lido): NÃO é verde', () => {
    expect(resumoCredito('ok', { ...base, frescor: [] }).tom).toBe('neutro');
  });
});

describe('rotuloPrazoTarefa', () => {
  it('atrasada vence; senão o prazo; sem prazo diz', () => {
    expect(rotuloPrazoTarefa({ atrasada: true, effective_due: '2026-11-30' })).toBe('atrasada');
    expect(rotuloPrazoTarefa({ atrasada: false, effective_due: '2026-11-30' })).toBe('até 30/11/2026');
    expect(rotuloPrazoTarefa({ atrasada: false, effective_due: null })).toBe('sem prazo');
  });
});

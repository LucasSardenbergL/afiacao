import { describe, it, expect } from 'vitest';
import { resumoCredito, rotuloPrazoTarefa, type CreditoLido } from '../acoes-da-ficha';

const base: CreditoLido = { semConta: false, conflito: false, aliasesConferidos: true, alerta: null };
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

  it('sync defasado: avisa com a data', () => {
    const r = resumoCredito('ok', { ...base, alerta: { ...alerta, dadoDefasado: true, syncAt: '2026-11-18T10:00:00Z' } });
    expect(r.notas.join(' ')).toContain('18/11/2026');
  });
});

describe('rotuloPrazoTarefa', () => {
  it('atrasada vence; senão o prazo; sem prazo diz', () => {
    expect(rotuloPrazoTarefa({ atrasada: true, effective_due: '2026-11-30' })).toBe('atrasada');
    expect(rotuloPrazoTarefa({ atrasada: false, effective_due: '2026-11-30' })).toBe('até 30/11/2026');
    expect(rotuloPrazoTarefa({ atrasada: false, effective_due: null })).toBe('sem prazo');
  });
});

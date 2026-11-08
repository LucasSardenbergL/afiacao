import { describe, expect, it } from 'vitest';
import { algumTelefoneContabil, contabilDoCampo, lerContatoContabil, textoMotivo } from '../contato-contabil';

const linha = (over: Record<string, unknown> = {}) => ({
  campo: 'telefone1', tipo: 'telefone', valor: '37991110001', automatico: true, motivos: ['telefone_compartilhado'],
  grupos: 4, corroborado: false, correcao_id: null, veredito: null, efetivo: true, visitar: true,
  calculado_em: '2026-11-08T06:50:00+00:00', ...over,
});

describe('lerContatoContabil', () => {
  it('lê os contatos por campo, o visitar e quando foi calculado', () => {
    const r = lerContatoContabil([
      linha(),
      linha({ campo: 'email', tipo: 'email', valor: 'dp@contabilmais.com', motivos: ['email_palavra'], grupos: null, corroborado: null }),
    ]);
    expect(r.visitar).toBe(true);
    expect(r.calculadoEm).toBe('2026-11-08T06:50:00+00:00');
    expect(r.contatos.get('telefone1')).toMatchObject({ tipo: 'telefone', automatico: true, efetivo: true, grupos: 4, correcaoId: null });
    expect(r.contatos.get('email')?.motivos).toEqual(['email_palavra']);
  });

  it('lista vazia é legítima: lead sem contato utilizável, nada a marcar', () => {
    const r = lerContatoContabil([]);
    expect(r.contatos.size).toBe(0);
    expect(r.visitar).toBe(false);
  });

  it('nunca calculado chega como NULL e fica NULL (não vira "contato direto")', () => {
    const r = lerContatoContabil([linha({ automatico: null, efetivo: null, motivos: null, grupos: null, corroborado: null, visitar: false, calculado_em: null })]);
    expect(r.contatos.get('telefone1')?.efetivo).toBeNull();
    expect(contabilDoCampo(r, 'telefone1')).toBeNull();
    expect(algumTelefoneContabil(r)).toBe(false);
  });

  it('motivo desconhecido (regra nova no servidor) não derruba a ficha', () => {
    const r = lerContatoContabil([linha({ motivos: ['telefone_compartilhado', 'regra_do_futuro'] })]);
    expect(r.contatos.get('telefone1')?.motivos).toEqual(['telefone_compartilhado']);
  });

  it('resposta fora da forma LANÇA (a ficha diz "não consegui verificar")', () => {
    expect(() => lerContatoContabil(null)).toThrow('resposta fora da forma esperada (lista)');
    expect(() => lerContatoContabil([linha({ campo: 'fax' })])).toThrow('([0].campo)');
    expect(() => lerContatoContabil([linha({ efetivo: 'sim' })])).toThrow('([0])');
    expect(() => lerContatoContabil([linha({ visitar: undefined })])).toThrow('([0])');
  });
});

describe('textoMotivo', () => {
  const base = { tipo: 'telefone' as const, grupos: 4, corroborado: false, veredito: null };
  it('telefone compartilhado diz em quantas empresas sem vínculo', () => {
    expect(textoMotivo({ ...base, motivos: ['telefone_compartilhado'] }))
      .toBe('Este telefone aparece em 4 empresas sem vínculo entre si.');
  });
  it('3 grupos só marca com corroboração, e o texto diz qual', () => {
    expect(textoMotivo({ ...base, grupos: 3, corroborado: true, motivos: ['telefone_compartilhado'] }))
      .toBe('Este telefone aparece em 3 empresas sem vínculo entre si, e uma delas tem e-mail de contabilidade.');
  });
  it('e-mail junta os motivos em frases', () => {
    expect(textoMotivo({ tipo: 'email', grupos: 3, corroborado: null, veredito: null, motivos: ['email_palavra', 'email_compartilhado'] }))
      .toBe('O e-mail tem "contab" ou "contador". Este e-mail aparece em 3 empresas sem vínculo entre si.');
    expect(textoMotivo({ tipo: 'email', grupos: null, corroborado: null, veredito: null, motivos: ['dominio_servico'] }))
      .toBe('O domínio do e-mail é de um serviço de MEI ou de contabilidade.');
  });
  it('correção do vendedor vence o motivo automático no texto', () => {
    expect(textoMotivo({ ...base, motivos: [], veredito: true })).toBe('Um vendedor marcou este contato como da contabilidade.');
  });
});

describe('algumTelefoneContabil / contabilDoCampo', () => {
  it('e-mail da contabilidade não conta como telefone; telefone2 sim', () => {
    const soEmail = lerContatoContabil([linha({ campo: 'email', tipo: 'email', visitar: false })]);
    expect(algumTelefoneContabil(soEmail)).toBe(false);
    const tel2 = lerContatoContabil([linha({ efetivo: false, automatico: false, visitar: false }), linha({ campo: 'telefone2', visitar: false })]);
    expect(algumTelefoneContabil(tel2)).toBe(true);
    expect(contabilDoCampo(tel2, 'telefone1')).toBeNull();
    expect(contabilDoCampo(tel2, 'telefone2')?.campo).toBe('telefone2');
  });
});

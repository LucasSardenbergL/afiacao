import { describe, expect, it } from 'vitest';
import {
  ACOES_CONTATO, presetParaParams, idadeEmAnos, rotuloPorte,
  formatarCapital, formatarCnpj,
} from '../ui-helpers';

describe('ACOES_CONTATO', () => {
  it('cobre o vocabulário do radar (4 ações operáveis pela UI, sem a_contatar)', () => {
    const acoes = ACOES_CONTATO.map((a) => a.acao);
    expect(acoes).toEqual(['em_conversa', 'contatado_sem_resposta', 'virou_cliente', 'descartado']);
  });
  it('só descartado pede confirmação', () => {
    expect(ACOES_CONTATO.filter((a) => a.confirmar).map((a) => a.acao)).toEqual(['descartado']);
  });
});

describe('presetParaParams', () => {
  it('novas: ordena por data_abertura desc, sem corte de idade', () => {
    const p = presetParaParams('novas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'data_abertura', orderAsc: false, dataAberturaMax: null, dataAberturaMin: null });
  });
  it('estabelecidas: corta abertura <= hoje-5anos e ordena por capital desc', () => {
    const p = presetParaParams('estabelecidas', '2026-06-12');
    expect(p).toEqual({ orderColumn: 'capital_social', orderAsc: false, dataAberturaMax: '2021-06-12', dataAberturaMin: null });
  });
});

describe('idadeEmAnos', () => {
  it('calcula anos completos', () => expect(idadeEmAnos('2020-06-12', '2026-06-12')).toBe(6));
  it('antes do aniversário no ano conta um a menos', () =>
    expect(idadeEmAnos('2020-06-13', '2026-06-12')).toBe(5));
  it('null/vazio → null', () => {
    expect(idadeEmAnos(null, '2026-06-12')).toBeNull();
    expect(idadeEmAnos('', '2026-06-12')).toBeNull();
  });
});

describe('rotuloPorte', () => {
  it('mapeia códigos RFB', () => {
    expect(rotuloPorte('01')).toBe('ME');
    expect(rotuloPorte('03')).toBe('EPP');
    expect(rotuloPorte('05')).toBe('Demais');
    expect(rotuloPorte('00')).toBe('Não informado');
  });
  it('desconhecido/null → —', () => {
    expect(rotuloPorte(null)).toBe('—');
    expect(rotuloPorte('99')).toBe('—');
  });
});

describe('formatarCapital', () => {
  it('formata BRL sem centavos', () => expect(formatarCapital(1500000)).toBe('R$ 1.500.000'));
  it('null → —', () => expect(formatarCapital(null)).toBe('—'));
});

describe('formatarCnpj', () => {
  it('aplica a máscara', () => expect(formatarCnpj('11222333000144')).toBe('11.222.333/0001-44'));
  it('tamanho errado → devolve cru', () => expect(formatarCnpj('123')).toBe('123'));
});

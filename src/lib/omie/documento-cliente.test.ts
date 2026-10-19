import { describe, it, expect } from 'vitest';
import {
  chaveDocumentoParaBusca,
  documentoEditadoParaGravar,
  ehDocumentoPessoaJuridica,
} from './documento-cliente';

// Oráculo: exemplo OFICIAL da RFB (12.ABC.345/01DE-35) — o mesmo do espelho cnpj-alfanumerico.test.ts.
const ALNUM = '12ABC34501DE35';
const ALNUM_MASCARADO = '12.ABC.345/01DE-35';
const CNPJ_NUM = '11222333000181';
const CPF = '12345678909';

describe('chaveDocumentoParaBusca — o gate ">= 11 dígitos" que casa profiles.document', () => {
  it('numérico: byte-idêntico ao replace(/\\D/g, "") + length >= 11 de antes', () => {
    expect(chaveDocumentoParaBusca('11.222.333/0001-81')).toBe(CNPJ_NUM);
    expect(chaveDocumentoParaBusca('123.456.789-09')).toBe(CPF);
    expect(chaveDocumentoParaBusca(CPF)).toBe(CPF);
  });
  it('numérico curto, vazio, null: null (como o gate antigo barrava)', () => {
    expect(chaveDocumentoParaBusca('123.456')).toBeNull();
    expect(chaveDocumentoParaBusca('')).toBeNull();
    expect(chaveDocumentoParaBusca(null)).toBeNull();
    expect(chaveDocumentoParaBusca(undefined)).toBeNull();
  });
  it('CNPJ alfanumérico VÁLIDO vira chave com as letras (antes: 9 dígitos < 11 → barrado)', () => {
    expect(ALNUM.replace(/\D/g, '').length).toBeLessThan(11); // a conta de dígitos que barrava
    expect(chaveDocumentoParaBusca(ALNUM)).toBe(ALNUM);
    expect(chaveDocumentoParaBusca(ALNUM_MASCARADO)).toBe(ALNUM);
    expect(chaveDocumentoParaBusca(' 12.abc.345/01de-35 ')).toBe(ALNUM);
  });
  it('letra com DV errado NÃO fabrica chave: cai nos dígitos, e 9 < 11 → null (fail-closed)', () => {
    expect(chaveDocumentoParaBusca('12ABC34501DE36')).toBeNull();
    expect(chaveDocumentoParaBusca('ABCDEFGHIJKL12')).toBeNull();
  });
});

describe('documentoEditadoParaGravar — Profile.tsx só grava `document` quando o campo foi EDITADO', () => {
  it('campo não editado → undefined (não entra no update; preserva o que a edge gravou)', () => {
    expect(documentoEditadoParaGravar(ALNUM, ALNUM)).toBeUndefined();
    expect(documentoEditadoParaGravar(CPF, CPF)).toBeUndefined();
    expect(documentoEditadoParaGravar('', null)).toBeUndefined();
    expect(documentoEditadoParaGravar('', undefined)).toBeUndefined();
  });
  it('editado numérico → só-dígitos, byte-idêntico ao replace(/\\D/g, "") || null de antes', () => {
    expect(documentoEditadoParaGravar('123.456.789-09', CPF + '0')).toBe(CPF);
    expect(documentoEditadoParaGravar('11.222.333/0001-81', null)).toBe(CNPJ_NUM);
    expect(documentoEditadoParaGravar('   ', CPF)).toBeNull();
    expect(documentoEditadoParaGravar('', CPF)).toBeNull();
  });
  it('editado para CNPJ alfanumérico válido → preserva letras, upper, sem máscara', () => {
    expect(documentoEditadoParaGravar(ALNUM_MASCARADO, CPF)).toBe(ALNUM);
    expect(documentoEditadoParaGravar('12.abc.345/01de-35', null)).toBe(ALNUM);
  });
  it('editado para alfanumérico INVÁLIDO → só-dígitos como hoje (não fabrica documento)', () => {
    expect(documentoEditadoParaGravar('12.ABC.345/01DE-36', null)).toBe('123450136');
  });
});

describe('ehDocumentoPessoaJuridica — rótulo Razão Social / Nome Fantasia do signup', () => {
  it('numérico: mesmo critério de antes (mais de 11 dígitos)', () => {
    expect(ehDocumentoPessoaJuridica('11.222.333/0001-81')).toBe(true);
    expect(ehDocumentoPessoaJuridica('123.456.789-09')).toBe(false);
    expect(ehDocumentoPessoaJuridica('')).toBe(false);
  });
  it('CNPJ alfanumérico válido é PJ (antes caía em "Nome Completo" por ter 9 dígitos)', () => {
    expect(ehDocumentoPessoaJuridica(ALNUM_MASCARADO)).toBe(true);
    expect(ehDocumentoPessoaJuridica('12.ABC.345/01DE-36')).toBe(false);
  });
});

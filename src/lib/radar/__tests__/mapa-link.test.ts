import { describe, expect, it } from 'vitest';
import { cepUtil, consultaEmpresaMaps, consultaEnderecoMaps, urlMapsEmpresa, urlMapsEndereco } from '../mapa-link';

// O caso que o founder viu no app publicado: CNPJ 03.312.788/0001-60.
const OLIVEIRA = {
  cnpj: '03312788000160', logradouro: 'RUA JOSE CAMPOS', numero: '75', municipio_nome: 'OLIVEIRA', uf: 'MG',
  cep: '35540000', nome_fantasia: null, razao_social: 'MOVEIS EXEMPLO LTDA',
};
const q = (url: string | null) => (url ? decodeURIComponent(url.split('query=')[1] ?? '') : null);

describe('link do Maps pelo ENDEREÇO', () => {
  it('"Logradouro Número, Município - UF", sem bairro e sem o CEP genérico da cidade (…000)', () => {
    expect(consultaEnderecoMaps(OLIVEIRA)).toBe('Rua Jose Campos 75, Oliveira - MG');
    expect(urlMapsEndereco(OLIVEIRA)).toBe(
      'https://www.google.com/maps/search/?api=1&query=Rua%20Jose%20Campos%2075%2C%20Oliveira%20-%20MG');
  });

  it('CEP de logradouro entra formatado; S/N e número zero saem; partículas minúsculas', () => {
    expect(consultaEnderecoMaps({ ...OLIVEIRA, logradouro: 'AVENIDA DAS FLORES', numero: 'S/N', cep: '35540-123', municipio_nome: 'PARA DE MINAS' }))
      .toBe('Avenida das Flores, Para de Minas - MG, 35540-123');
    expect(consultaEnderecoMaps({ ...OLIVEIRA, numero: '0' })).toBe('Rua Jose Campos, Oliveira - MG');
  });

  it('sem logradouro não fabrica link (a busca do nome da cidade não é o endereço)', () => {
    expect(urlMapsEndereco({ ...OLIVEIRA, logradouro: '  ' })).toBeNull();
  });

  it('cepUtil: genérico, curto e vazio são null', () => {
    expect(cepUtil('35540000')).toBeNull();
    expect(cepUtil('3554')).toBeNull();
    expect(cepUtil(null)).toBeNull();
    expect(cepUtil('35.540-123')).toBe('35540-123');
  });
});

describe('link do Maps pela EMPRESA', () => {
  it('fantasia vence a razão social; cidade e UF juntas', () => {
    expect(consultaEmpresaMaps({ ...OLIVEIRA, nome_fantasia: '  Marcenaria  Um ' })).toBe('Marcenaria Um, Oliveira - MG');
    expect(q(urlMapsEmpresa(OLIVEIRA))).toBe('MOVEIS EXEMPLO LTDA, Oliveira - MG');
  });

  it('sem nome nenhum, sem link', () => {
    expect(urlMapsEmpresa({ ...OLIVEIRA, razao_social: null })).toBeNull();
  });

  it('os dois links são buscas DIFERENTES (o 2º não repete o endereço)', () => {
    expect(urlMapsEmpresa(OLIVEIRA)).not.toBe(urlMapsEndereco(OLIVEIRA));
  });
});

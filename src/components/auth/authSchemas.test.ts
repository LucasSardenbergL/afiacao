import { describe, it, expect } from 'vitest';
import { documentSchema, handleInputFormat } from './authSchemas';

// ── Oráculo do caminho NUMÉRICO: cópia byte-a-byte do `formatDocument` que existia antes deste PR.
// Para qualquer entrada SEM letra a máscara nova tem de devolver EXATAMENTE isto (CPF/CNPJ de hoje
// não mudam um byte). Se alguém "melhorar" a máscara numérica, este oráculo acusa.
const formatDocumentLegado = (value: string): string => {
  const numbers = value.replace(/\D/g, '');
  if (numbers.length <= 11) {
    return numbers
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d{1,2})$/, '$1-$2');
  } else {
    return numbers
      .replace(/(\d{2})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1.$2')
      .replace(/(\d{3})(\d)/, '$1/$2')
      .replace(/(\d{4})(\d{1,2})$/, '$1-$2');
  }
};

const mascara = (v: string) => handleInputFormat('document', v);

describe('handleInputFormat("document") — máscara de input do signup', () => {
  it('numérico: byte-idêntico à máscara antiga, tecla a tecla, CPF e CNPJ, com e sem pontuação', () => {
    const entradas = ['12345678909', '11222333000181', '123.456.789-09', '11.222.333/0001-81', '1122233300018'];
    for (const completo of entradas) {
      for (let i = 1; i <= completo.length; i++) {
        const parcial = completo.slice(0, i);
        expect(mascara(parcial), `entrada ${JSON.stringify(parcial)}`).toBe(formatDocumentLegado(parcial));
      }
    }
    // Lixo numérico mais longo que 18 e separadores estranhos também não mudam.
    for (const v of ['1234567890123456789', '12 345 678 909', '(11)222333000181', '', '.-/']) {
      expect(mascara(v), `entrada ${JSON.stringify(v)}`).toBe(formatDocumentLegado(v));
    }
  });

  it('CNPJ alfanumérico (RFB jul/2026): a letra FICA, vira maiúscula e recebe a máscara de CNPJ', () => {
    expect(mascara('12ABC34501DE35')).toBe('12.ABC.345/01DE-35');
    expect(mascara('12abc34501de35')).toBe('12.ABC.345/01DE-35');
    expect(mascara('12.ABC.345/01DE-35')).toBe('12.ABC.345/01DE-35');
  });

  it('alfanumérico tecla a tecla: nenhuma tecla apaga a anterior (antes, a letra sumia na hora)', () => {
    const completo = '12ABC34501DE35';
    let anterior = '';
    for (let i = 1; i <= completo.length; i++) {
      const atual = mascara(completo.slice(0, i));
      const soCorpo = (s: string) => s.replace(/[^0-9A-Z]/g, '');
      expect(soCorpo(atual)).toBe(completo.slice(0, i));
      expect(soCorpo(atual).startsWith(soCorpo(anterior))).toBe(true);
      anterior = atual;
    }
  });

  it('alfanumérico: os 2 DVs são só dígitos (letra na posição 13/14 é descartada) e o 15º char não entra', () => {
    expect(mascara('12ABC34501DEX5')).toBe('12.ABC.345/01DE-5');
    expect(mascara('12ABC34501DE359')).toBe('12.ABC.345/01DE-35');
  });
});

describe('documentSchema — validação do passo "documento" do signup', () => {
  const ok = (v: string) => documentSchema.safeParse({ document: v }).success;
  const erro = (v: string) => {
    const r = documentSchema.safeParse({ document: v });
    return r.success ? null : r.error.issues[0].message;
  };

  it('numérico: regras de hoje intactas (min 11, max 18; sem conferência de DV)', () => {
    expect(ok('123.456.789-09')).toBe(true);
    expect(ok('11.222.333/0001-81')).toBe(true);
    expect(ok('12345678909')).toBe(true);
    expect(ok('11222333000181')).toBe(true);
    expect(erro('123.456.78')).toBe('Informe um CPF ou CNPJ válido');
    expect(erro('11.222.333/0001-81X')).not.toBeNull(); // 19 chars → max(18) continua
  });

  it('CNPJ alfanumérico VÁLIDO passa (mascarado, cru e minúsculo)', () => {
    expect(ok('12.ABC.345/01DE-35')).toBe(true);
    expect(ok('12ABC34501DE35')).toBe(true);
    expect(ok('12abc34501de35')).toBe(true);
  });

  it('letra com DV errado ou formato errado é REJEITADA com mensagem própria (fail-closed, não vira CPF)', () => {
    expect(erro('12.ABC.345/01DE-36')).toBe('CNPJ alfanumérico inválido');
    expect(erro('123ABC45678909')).toBe('CNPJ alfanumérico inválido'); // 11 dígitos sobrando: NÃO é o CPF de outra pessoa
    expect(erro('ABCDEFGHIJKL12')).toBe('CNPJ alfanumérico inválido');
  });
});

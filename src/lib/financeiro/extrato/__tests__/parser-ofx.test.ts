import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOfx } from '../parser-ofx.ts';
import type { ResultadoParse } from '../nucleo.ts';

const FIX = resolve(process.cwd(), 'src/lib/financeiro/extrato/__tests__/fixtures');
const texto = (nome: string) => readFileSync(resolve(FIX, nome), 'utf8');
// O SGML 1.x do Itaú é windows-1252: 'Ç' = 0xC7 (um byte). latin1 cobre o trecho usado.
const cp1252 = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const SGML = texto('itau-sgml.ofx');
const XML = texto('itau-xml.ofx');

function ok(r: ResultadoParse) {
  if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}: ${r.detalhe}`);
  return r.extrato;
}
function recusa(r: ResultadoParse) {
  if (r.ok) throw new Error('esperava recusa, veio ok');
  return r.motivo;
}
const sem = (s: string, trecho: string) => {
  expect(s.includes(trecho)).toBe(true);
  return s.replace(trecho, '');
};
const troca = (s: string, de: string, para: string) => {
  expect(s.includes(de)).toBe(true);
  return s.replace(de, para);
};

describe('parseOfx — SGML 1.x windows-1252', () => {
  const e = ok(parseOfx(cp1252(SGML)));
  it('cabeçalho: formato, banco, agência, conta, período, geradoEm', () => {
    expect(e.formato).toBe('ofx');
    expect(e.banco).toBe('0341');
    expect(e.agencia).toBe('0000');
    expect(e.conta).toBe('000000');
    expect(e.periodoInicio).toBe('2026-11-01');
    expect(e.periodoFim).toBe('2026-11-19'); // DTEND exclusivo 00:00:00 -> dia anterior
    expect(e.geradoEm).toBe('2026-11-20T10:15:00-03:00');
  });
  it('descrição decodificada (Ç) e débito em centavos inteiros', () => {
    expect(e.linhas[0]).toEqual({
      data: '2026-11-03',
      sentido: 'D',
      valorCentavos: 123456,
      descricao: 'TARIFA PACOTE SERVIÇOS',
      documento: '000123',
      idBancario: '202611030001',
    });
  });
  it('crédito; NAME quando não há MEMO; REFNUM quando não há CHECKNUM', () => {
    expect(e.linhas[1]).toEqual({
      data: '2026-11-19',
      sentido: 'C',
      valorCentavos: 500000,
      descricao: 'PIX RECEBIDO',
      documento: 'REF9',
      idBancario: '202611190002',
    });
  });
  it('saldo final com sinal; saldo inicial é null (nunca 0)', () => {
    expect(e.saldoFinalCentavos).toBe(-25010);
    expect(e.saldoInicialCentavos).toBeNull();
  });
  it('byte 0x96 é travessão em windows-1252 (não latin1)', () => {
    const b = Buffer.from(SGML.replace('SERVIÇOS', 'A_B'), 'latin1');
    const i = b.indexOf('A_B');
    const out = new Uint8Array(Buffer.concat([b.subarray(0, i), Buffer.from([0x41, 0x96, 0x42]), b.subarray(i + 3)]));
    expect(ok(parseOfx(out)).linhas[0].descricao).toBe('TARIFA PACOTE A–B');
  });
});

describe('parseOfx — XML 2.x', () => {
  it('equivale ao SGML', () => {
    expect(ok(parseOfx(utf8(XML)))).toEqual(ok(parseOfx(cp1252(SGML))));
  });
  it('UTF-8 declarado com bytes inválidos -> formato_desconhecido', () => {
    const b = Buffer.concat([Buffer.from(XML.replace('SERVIÇOS', 'SERV'), 'utf8')]);
    const i = b.indexOf('SERV');
    const ruim = new Uint8Array(Buffer.concat([b.subarray(0, i), Buffer.from([0x53, 0xc7, 0x20]), b.subarray(i + 4)]));
    expect(recusa(parseOfx(ruim))).toBe('formato_desconhecido');
  });
});

describe('parseOfx — recusas', () => {
  it('sem LEDGERBAL -> campo_ausente', () => {
    const s = SGML.replace(/<LEDGERBAL>[\s\S]*<\/LEDGERBAL>\n/, '');
    expect(s).not.toContain('LEDGERBAL');
    expect(recusa(parseOfx(cp1252(s)))).toBe('campo_ausente');
  });
  it('TRNAMT 0.00 -> valor_invalido', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '-1234.56', '0.00'))))).toBe('valor_invalido');
  });
  it('TRNAMT ambíguo (12.345) -> valor_invalido', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '-1234.56', '12.345'))))).toBe('valor_invalido');
  });
  it('BALAMT ilegível -> valor_invalido', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '-250.10', 'abc'))))).toBe('valor_invalido');
  });
  it('lixo binário -> formato_desconhecido', () => {
    const lixo = new Uint8Array(256).map((_, i) => (i * 37 + 11) % 256);
    expect(recusa(parseOfx(lixo))).toBe('formato_desconhecido');
    expect(recusa(parseOfx(new Uint8Array(0)))).toBe('formato_desconhecido');
  });
  it('CHARSET desconhecido -> formato_desconhecido', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, 'CHARSET:1252', 'CHARSET:EBCDIC'))))).toBe('formato_desconhecido');
  });
  it('mais de uma conta (2 STMTRS) -> formato_desconhecido', () => {
    const bloco = SGML.slice(SGML.indexOf('<STMTRS>'), SGML.indexOf('</STMTRS>') + 9);
    expect(recusa(parseOfx(cp1252(troca(SGML, bloco, bloco + bloco))))).toBe('formato_desconhecido');
  });
  it('DTSERVER ausente -> campo_ausente', () => {
    expect(recusa(parseOfx(cp1252(sem(SGML, '<DTSERVER>20261120101500[-3:BRT]\n'))))).toBe('campo_ausente');
  });
  it('DTSERVER sem fuso -> data_invalida (não assume GMT)', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '20261120101500[-3:BRT]', '20261120101500'))))).toBe('data_invalida');
  });
  it('DTSERVER com fuso fora de faixa ou inexato -> data_invalida', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '[-3:BRT]\n<LANGUAGE>', '[99:XXX]\n<LANGUAGE>'))))).toBe('data_invalida');
    expect(recusa(parseOfx(cp1252(troca(SGML, '[-3:BRT]\n<LANGUAGE>', '[5.33:XXX]\n<LANGUAGE>'))))).toBe('data_invalida');
  });
  it('BRANCHID ausente -> campo_ausente; ACCTID ausente -> campo_ausente', () => {
    expect(recusa(parseOfx(cp1252(sem(SGML, '<BRANCHID>0000\n'))))).toBe('campo_ausente');
    expect(recusa(parseOfx(cp1252(sem(SGML, '<ACCTID>000000\n'))))).toBe('campo_ausente');
  });
  it('BANKID ausente -> banco null', () => {
    expect(ok(parseOfx(cp1252(sem(SGML, '<BANKID>0341\n')))).banco).toBeNull();
  });
  it('DTSTART/DTEND ausentes -> campo_ausente', () => {
    expect(recusa(parseOfx(cp1252(sem(SGML, '<DTSTART>20261101000000[-3:BRT]\n'))))).toBe('campo_ausente');
    expect(recusa(parseOfx(cp1252(sem(SGML, '<DTEND>20261120000000[-3:BRT]\n'))))).toBe('campo_ausente');
  });
  it('DTPOSTED fora do período -> data_invalida; inexistente (31/02) -> data_invalida', () => {
    expect(recusa(parseOfx(cp1252(troca(SGML, '20261103000000', '20261201000000'))))).toBe('data_invalida');
    expect(recusa(parseOfx(cp1252(troca(SGML, '20261103000000', '20260231000000'))))).toBe('data_invalida');
  });
  it('TRNAMT ausente -> campo_ausente', () => {
    expect(recusa(parseOfx(cp1252(sem(SGML, '<TRNAMT>-1234.56\n'))))).toBe('campo_ausente');
  });
});

describe('parseOfx — variações', () => {
  it('DTEND só data ou hora diferente de 00:00:00 -> o próprio dia', () => {
    expect(ok(parseOfx(cp1252(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261120\n<STMTTRN>')))).periodoFim).toBe('2026-11-20');
    expect(ok(parseOfx(cp1252(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261120235959[-3:BRT]\n<STMTTRN>')))).periodoFim).toBe('2026-11-20');
  });
  it('DTEND 00:00:00 no dia 1º volta ao mês anterior', () => {
    const s = troca(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261201000000[-3:BRT]\n<STMTTRN>'), '20261119000000[-3:BRT]\n<TRNAMT>', '20261130000000[-3:BRT]\n<TRNAMT>');
    expect(ok(parseOfx(cp1252(s))).periodoFim).toBe('2026-11-30');
  });
  it('DTEND (00:00 exclusivo) que vira véspera do DTSTART -> data_invalida, mesmo sem lançamentos (export de um dia só)', () => {
    const umDia = troca(SGML, '<DTEND>20261120000000[-3:BRT]', '<DTEND>20261101000000[-3:BRT]');
    const semLanc = umDia.replace(/<STMTTRN>[\s\S]*?<\/STMTTRN>\n/g, '');
    expect(semLanc.includes('<STMTTRN>')).toBe(false);
    const r = parseOfx(cp1252(semLanc));
    expect(recusa(r)).toBe('data_invalida');
    expect(!r.ok && r.detalhe).toContain('DTEND');
    // com lançamentos continua recusado como data_invalida
    expect(recusa(parseOfx(cp1252(umDia)))).toBe('data_invalida');
  });
  it('DTEND == DTSTART (hora diferente de 00:00:00) é um dia só válido', () => {
    const s = troca(SGML, '<DTEND>20261120000000[-3:BRT]', '<DTEND>20261101235959[-3:BRT]');
    const semLanc = s.replace(/<STMTTRN>[\s\S]*?<\/STMTTRN>\n/g, '');
    const e = ok(parseOfx(cp1252(semLanc)));
    expect(e.periodoInicio).toBe('2026-11-01');
    expect(e.periodoFim).toBe('2026-11-01');
  });
  it('fusos: [-3] e [5.5:IST]', () => {
    expect(ok(parseOfx(cp1252(troca(SGML, '[-3:BRT]\n<LANGUAGE>', '[-3]\n<LANGUAGE>')))).geradoEm).toBe('2026-11-20T10:15:00-03:00');
    expect(ok(parseOfx(cp1252(troca(SGML, '[-3:BRT]\n<LANGUAGE>', '[5.5:IST]\n<LANGUAGE>')))).geradoEm).toBe('2026-11-20T10:15:00+05:30');
  });
  it('sem MEMO nem NAME -> descrição vazia (nunca null); sem CHECKNUM/REFNUM -> documento null', () => {
    const s = sem(sem(SGML, '<MEMO>TARIFA PACOTE SERVIÇOS\n'), '<CHECKNUM>000123\n');
    const l = ok(parseOfx(cp1252(s))).linhas[0];
    expect(l.descricao).toBe('');
    expect(l.documento).toBeNull();
  });
  it('FITID ausente -> idBancario null; entidades XML decodificadas', () => {
    const s = troca(sem(SGML, '<FITID>202611030001\n'), 'TARIFA PACOTE', 'TARIFA &amp; PACOTE');
    const l = ok(parseOfx(cp1252(s))).linhas[0];
    expect(l.idBancario).toBeNull();
    expect(l.descricao).toBe('TARIFA & PACOTE SERVIÇOS');
  });
  it('extrato sem movimento é válido (linhas vazias)', () => {
    const s = SGML.replace(/<STMTTRN>[\s\S]*<\/STMTTRN>\n/, '');
    expect(ok(parseOfx(cp1252(s))).linhas).toEqual([]);
  });
  it('BALAMT zero é zero real (presente), com sinal positivo explícito aceito', () => {
    expect(ok(parseOfx(cp1252(troca(SGML, '-250.10', '0.00')))).saldoFinalCentavos).toBe(0);
    expect(ok(parseOfx(cp1252(troca(SGML, '-250.10', '+10.00')))).saldoFinalCentavos).toBe(1000);
  });
  it('AVAILBAL não é confundido com LEDGERBAL', () => {
    const s = troca(SGML, '</LEDGERBAL>', '</LEDGERBAL>\n<AVAILBAL>\n<BALAMT>999.99\n</AVAILBAL>');
    expect(ok(parseOfx(cp1252(s))).saldoFinalCentavos).toBe(-25010);
  });
});

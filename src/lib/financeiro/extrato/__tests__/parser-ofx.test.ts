import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseOfx } from '../parser-ofx.ts';
import { fecha } from '../nucleo.ts';
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
    const asofFim = (s: string) => troca(s, '<DTASOF>20261120000000', '<DTASOF>20261120235959');
    expect(ok(parseOfx(cp1252(asofFim(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261120\n<STMTTRN>'))))).periodoFim).toBe('2026-11-20');
    expect(ok(parseOfx(cp1252(asofFim(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261120235959[-3:BRT]\n<STMTTRN>'))))).periodoFim).toBe('2026-11-20');
  });
  it('DTEND 00:00:00 no dia 1º volta ao mês anterior', () => {
    const s = troca(troca(troca(SGML, '20261120000000[-3:BRT]\n<STMTTRN>', '20261201000000[-3:BRT]\n<STMTTRN>'), '20261119000000[-3:BRT]\n<TRNAMT>', '20261130000000[-3:BRT]\n<TRNAMT>'), '<DTASOF>20261120000000', '<DTASOF>20261201000000');
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
    const s = troca(troca(SGML, '<DTEND>20261120000000[-3:BRT]', '<DTEND>20261101235959[-3:BRT]'), '<DTASOF>20261120000000', '<DTASOF>20261101235959');
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

// Layout REAL do Bankline (T0, só agregados): sem BRANCHID, ACCTID = agência(4)+conta(6), linhas
// SALDO ANTERIOR / SALDO TOTAL DISPONÍVEL DIA como STMTTRN, LEDGERBAL de HOJE, cabeçalho 1252 com
// bytes UTF-8, CHECKNUM = FITID posicional. Fixture sintética (agência 0000, conta 000000).
const BL = texto('itau-bankline.ofx');
const SD = 'SALDO TOTAL DISPONÍVEL DIA';
function recusaCom(r: ResultadoParse, motivo: string, marca: string) {
  if (r.ok) throw new Error(`esperava recusa ${motivo}/${marca}, veio ok`);
  expect(r.motivo).toBe(motivo);
  expect(r.detalhe).toContain(marca); // a MARCA do ramo, não "recusou algo"
}
const blTrn = (data: string, valor: string, fitid: string, memo: string) =>
  `<STMTTRN>\n<TRNTYPE>${valor.startsWith('-') ? 'DEBIT' : 'CREDIT'}\n<DTPOSTED>${data}100000[-03:EST]\n<TRNAMT>${valor}\n<FITID>${fitid}\n<CHECKNUM>${fitid}\n<MEMO>${memo}\n</STMTTRN>\n`;
const semSaldos = (s: string) => s.replace(/<STMTTRN>\n(?:(?!<\/STMTTRN>)[\s\S])*<MEMO>SALDO[^\n]*\n<\/STMTTRN>\n/g, '');

describe('parseOfx — layout real Itaú Bankline (R22–R26)', () => {
  // parse por teste (não no describe): uma sabotagem derruba o teste da camada, não a coleta inteira
  const E = () => ok(parseOfx(utf8(BL)));
  it('R22: sem BRANCHID, BANKID 0341 e ACCTID de 10 dígitos -> agência 4 + conta 6', () => {
    expect(E().banco).toBe('0341');
    expect(E().agencia).toBe('0000');
    expect(E().conta).toBe('000000');
    expect(E().periodoInicio).toBe('2026-10-01');
    expect(E().periodoFim).toBe('2026-10-05');
    expect(E().geradoEm).toBe('2026-11-21T10:00:00-03:00');
  });
  it('R22: corte vale para BANKID 341 sem zero à esquerda', () => {
    expect(ok(parseOfx(utf8(troca(BL, '<BANKID>0341', '<BANKID>341')))).conta).toBe('000000');
  });
  it('R23: linhas de SALDO não viram lançamento; ancora sozinho (inicial + Σ = final)', () => {
    expect(E().linhas.map((l) => l.descricao)).toEqual(['TAR PACOTE', 'PIX RECEBIDO', 'BOLETO PAGO', 'TED RECEBIDA']);
    expect(E().saldoInicialCentavos).toBe(100000);
    expect(E().saldoFinalCentavos).toBe(5025); // último SALDO DIA, NÃO o LEDGERBAL de hoje (99999)
    expect(fecha(E().saldoInicialCentavos ?? NaN, E().linhas, E().saldoFinalCentavos).fecha).toBe(true);
  });
  it('R26: documento null quando CHECKNUM == FITID; idBancario segue o FITID', () => {
    expect(E().linhas.every((l) => l.documento === null)).toBe(true);
    expect(E().linhas[0].idBancario).toBe('20261001001');
    const s = troca(BL, '<CHECKNUM>20261001001', '<CHECKNUM>777');
    expect(ok(parseOfx(utf8(s))).linhas[0].documento).toBe('777');
  });
  it('R25: bytes UTF-8 com cabeçalho 1252 decodificam como UTF-8; 1252 de verdade continua aceito', () => {
    expect(ok(parseOfx(cp1252(BL))).saldoFinalCentavos).toBe(5025); // 'Í' = 0xCD, UTF-8 inválido -> 1252
  });
  it('R23: SALDO DIA que não fecha -> valor_invalido', () => {
    recusaCom(parseOfx(utf8(troca(BL, '<TRNAMT>850.25', '<TRNAMT>850.26'))), 'valor_invalido', 'SALDO DIA nao fecha');
    // o último dia também é conferido (não só o saldo final contra o inicial)
    recusaCom(parseOfx(utf8(troca(BL, '<TRNAMT>-49.75', '<TRNAMT>-49.76'))), 'valor_invalido', 'SALDO DIA nao fecha');
  });
  it('R23: rótulo SALDO fora da allowlist -> formato_desconhecido', () => {
    recusaCom(parseOfx(utf8(troca(BL, '<MEMO>TED RECEBIDA', '<MEMO>SALDO APLIC AUT'))), 'formato_desconhecido', 'rotulo SALDO desconhecido');
    recusaCom(parseOfx(utf8(troca(BL, `<MEMO>${SD}`, '<MEMO>SALDO DIA'))), 'formato_desconhecido', 'rotulo SALDO desconhecido');
  });
  it('R23: dois SALDO ANTERIOR -> formato_desconhecido', () => {
    const extra = blTrn('20260930', '1000.00', '20260930002', 'SALDO ANTERIOR');
    recusaCom(parseOfx(utf8(troca(BL, '</BANKTRANLIST>', `${extra}</BANKTRANLIST>`))), 'formato_desconhecido', 'mais de um SALDO ANTERIOR');
  });
  it('R23: SALDO ANTERIOR fora da véspera do DTSTART -> data_invalida', () => {
    recusaCom(parseOfx(utf8(troca(BL, '<DTPOSTED>20260930', '<DTPOSTED>20260929'))), 'data_invalida', 'SALDO ANTERIOR fora da vespera');
  });
  it('R23: SALDO DIA em dia sem movimento ou fora do período -> recusa', () => {
    const semMov = blTrn('20261004', '50.25', '20261004001', SD);
    recusaCom(parseOfx(utf8(troca(BL, '</BANKTRANLIST>', `${semMov}</BANKTRANLIST>`))), 'formato_desconhecido', 'SALDO DIA em dia sem movimento');
    const fora = blTrn('20261006', '50.25', '20261006001', SD);
    recusaCom(parseOfx(utf8(troca(BL, '</BANKTRANLIST>', `${fora}</BANKTRANLIST>`))), 'data_invalida', 'SALDO DIA fora do periodo');
  });
  it('R23: dois SALDO DIA no mesmo dia, ou dia com movimento sem SALDO DIA -> formato_desconhecido', () => {
    const dup = blTrn('20261005', '50.25', '20261005003', SD);
    recusaCom(parseOfx(utf8(troca(BL, '</BANKTRANLIST>', `${dup}</BANKTRANLIST>`))), 'formato_desconhecido', 'mais de um SALDO DIA');
    const semSd = BL.replace(blTrn('20261003', '-49.75', '20261003002', SD), '');
    expect(semSd).not.toBe(BL);
    recusaCom(parseOfx(utf8(semSd)), 'formato_desconhecido', 'dia com movimento sem SALDO DIA');
  });
  it('R23: SALDO DIA sem SALDO ANTERIOR -> campo_ausente', () => {
    const s = BL.replace(blTrn('20260930', '1000.00', '20260930001', 'SALDO ANTERIOR'), '');
    expect(s).not.toBe(BL);
    recusaCom(parseOfx(utf8(s)), 'campo_ausente', 'SALDO ANTERIOR ausente');
  });
  it('R22: ACCTID de 9 ou 11 dígitos, não numérico, ou banco não Itaú sem BRANCHID -> campo_ausente', () => {
    recusaCom(parseOfx(utf8(troca(BL, '<ACCTID>0000000000', '<ACCTID>000000000'))), 'campo_ausente', 'BRANCHID ausente');
    recusaCom(parseOfx(utf8(troca(BL, '<ACCTID>0000000000', '<ACCTID>00000000000'))), 'campo_ausente', 'BRANCHID ausente');
    recusaCom(parseOfx(utf8(troca(BL, '<ACCTID>0000000000', '<ACCTID>0000-000000'))), 'campo_ausente', 'BRANCHID ausente');
    recusaCom(parseOfx(utf8(troca(BL, '<BANKID>0341', '<BANKID>0001'))), 'campo_ausente', 'BRANCHID ausente');
    recusaCom(parseOfx(utf8(sem(BL, '<BANKID>0341\n'))), 'campo_ausente', 'BRANCHID ausente');
  });
  it('R24: sem SALDO DIA e LEDGERBAL fora do fim do período -> campo_ausente (nunca fabricar)', () => {
    const s = semSaldos(BL);
    expect(s).not.toContain('<MEMO>SALDO');
    recusaCom(parseOfx(utf8(s)), 'campo_ausente', 'LEDGERBAL fora do fim do periodo');
  });
  it('R24: sem SALDO DIA e DTASOF no último dia -> LEDGERBAL é o saldo final; inicial null', () => {
    const s = troca(semSaldos(BL), '<DTASOF>20261121100000', '<DTASOF>20261005100000');
    const x = ok(parseOfx(utf8(s)));
    expect(x.saldoFinalCentavos).toBe(99999);
    expect(x.saldoInicialCentavos).toBeNull();
  });
  it('R24: com SALDO DIA presente, ele manda; LEDGERBAL de hoje é ignorado, ausente não faz falta', () => {
    expect(E().saldoFinalCentavos).toBe(5025); // LEDGERBAL 999.99 de 21/11 não é comparável
    expect(ok(parseOfx(utf8(BL.replace(/<LEDGERBAL>[\s\S]*<\/LEDGERBAL>\n/, '')))).saldoFinalCentavos).toBe(5025);
  });
  it('R24: LEDGERBAL do MESMO corte (fim do período) tem de concordar com o SALDO DIA', () => {
    const noFim = troca(BL, '<DTASOF>20261121100000', '<DTASOF>20261005100000');
    recusaCom(parseOfx(utf8(noFim)), 'valor_invalido', 'LEDGERBAL do fim do periodo diverge do SALDO DIA');
    expect(ok(parseOfx(utf8(troca(noFim, '<BALAMT>999.99', '<BALAMT>50.25')))).saldoFinalCentavos).toBe(5025);
  });
  it('R24: DTASOF à meia-noite é ambíguo — só vale no instante do DTEND exclusivo', () => {
    const base = semSaldos(BL);
    recusaCom(parseOfx(utf8(troca(base, '<DTASOF>20261121100000', '<DTASOF>20261005000000'))), 'campo_ausente', 'LEDGERBAL fora do fim do periodo');
    const excl = troca(troca(base, '<DTEND>20261005100000', '<DTEND>20261006000000'), '<DTASOF>20261121100000', '<DTASOF>20261006000000');
    const x = ok(parseOfx(utf8(excl)));
    expect(x.periodoFim).toBe('2026-10-05');
    expect(x.saldoFinalCentavos).toBe(99999);
  });
  it('R24: LEDGERBAL sem DTASOF e sem SALDO DIA -> campo_ausente', () => {
    recusaCom(parseOfx(utf8(sem(semSaldos(BL), '<DTASOF>20261121100000[-03:EST]\n'))), 'campo_ausente', 'DTASOF ausente');
  });
  it('saldo negativo e zero nas linhas de SALDO são valores reais', () => {
    // -49.75 no dia 03 já é negativo; zera o dia 05 ajustando o movimento
    const s = troca(troca(BL, '<TRNAMT>100.00', '<TRNAMT>49.75'), '<TRNAMT>50.25\n<FITID>20261005002', '<TRNAMT>0.00\n<FITID>20261005002');
    expect(ok(parseOfx(utf8(s))).saldoFinalCentavos).toBe(0);
  });
});

describe('parseOfx — achados da 2ª opinião (Codex)', () => {
  it('arquivo truncado logo após um SALDO DIA -> formato_desconhecido (não fecha "certinho" com saldo velho)', () => {
    const corte = BL.indexOf('<STMTTRN>\n<TRNTYPE>DEBIT\n<DTPOSTED>20261003');
    expect(corte).toBeGreaterThan(0);
    recusaCom(parseOfx(utf8(BL.slice(0, corte))), 'formato_desconhecido', 'arquivo truncado');
  });
  it('rótulo de SALDO no NAME com MEMO diferente, ou com prefixo -> formato_desconhecido', () => {
    const noName = troca(BL, `<MEMO>${SD}\n</STMTTRN>`, `<MEMO>POSICAO\n<NAME>${SD}\n</STMTTRN>`);
    recusaCom(parseOfx(utf8(noName)), 'formato_desconhecido', 'MEMO e NAME divergentes');
    recusaCom(parseOfx(utf8(troca(BL, `<MEMO>${SD}`, `<MEMO>*** ${SD}`))), 'formato_desconhecido', 'rotulo SALDO desconhecido');
    // rótulo só no NAME (sem MEMO) também é linha de saldo, não lançamento
    const soName = troca(BL, `<MEMO>${SD}\n</STMTTRN>`, `<NAME>${SD}\n</STMTTRN>`);
    expect(ok(parseOfx(utf8(soName))).linhas).toHaveLength(4);
  });
  it('mais de um LEDGERBAL -> formato_desconhecido (valor e data não se misturam entre blocos)', () => {
    const dois = troca(BL, '</LEDGERBAL>', '</LEDGERBAL>\n<LEDGERBAL>\n<BALAMT>1.00\n<DTASOF>20261005100000[-03:EST]\n</LEDGERBAL>');
    recusaCom(parseOfx(utf8(dois)), 'formato_desconhecido', 'mais de um LEDGERBAL');
  });
  it('REFNUM igual ao FITID também não vira documento', () => {
    const s = troca(BL, '<CHECKNUM>20261001001', '<REFNUM>20261001001');
    expect(ok(parseOfx(utf8(s))).linhas[0].documento).toBeNull();
  });
  it('movimento depois do SALDO DIA no mesmo dia -> formato_desconhecido', () => {
    const tarde = blTrn('20261005', '0.01', '20261005003', 'TARIFA');
    const s = troca(troca(BL, '</BANKTRANLIST>', `${tarde}</BANKTRANLIST>`), '<TRNAMT>100.00', '<TRNAMT>99.99');
    recusaCom(parseOfx(utf8(s)), 'formato_desconhecido', 'movimento depois do SALDO DIA');
  });
  it('linha de SALDO com TRNTYPE incoerente com o sinal -> valor_invalido', () => {
    const s = troca(BL, '<TRNTYPE>CREDIT\n<DTPOSTED>20261005100000[-03:EST]\n<TRNAMT>50.25', '<TRNTYPE>DEBIT\n<DTPOSTED>20261005100000[-03:EST]\n<TRNAMT>50.25');
    recusaCom(parseOfx(utf8(s)), 'valor_invalido', 'TRNTYPE DEBIT incoerente');
  });
  it('BANKID que só vira 341 depois de tirar não-dígitos (34X1) não autoriza o corte -> campo_ausente', () => {
    recusaCom(parseOfx(utf8(troca(BL, '<BANKID>0341', '<BANKID>34X1'))), 'campo_ausente', 'BRANCHID ausente');
  });
});

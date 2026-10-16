import { describe, expect, it } from 'vitest';
import { vincularNfs, type DisparadoVinculo, type NfDoContrato, type PedidoOmieSay } from './vinculo-nf';

const OPTS = { janelaSubstitutoDias: 21 };
const ped = (p: Partial<PedidoOmieSay> & { codigo: string }): PedidoOmieSay => ({
  t1: '2026-05-05', contrato: null, doMotor: false, itens: [{ prod: 'P1', qtde: 2 }], ...p,
});
const disp = (d: Partial<DisparadoVinculo> & { id: number }): DisparadoVinculo => ({ omiePedido: null, protocolo: null, nfs: [], ...d });
const nfc = (contrato: string, nf: string, data = '2026-05-12'): NfDoContrato => ({ contrato, nf, data });

describe('vincularNfs — R57 (A: contrato)', () => {
  it('não mexe em disparado que já tem NF no tracking', () => {
    const r = vincularNfs([disp({ id: 1, omiePedido: '10', nfs: ['000900'] })], [ped({ codigo: '10', contrato: 'C', doMotor: true })], [nfc('C', '000901')], OPTS);
    expect(r.has(1)).toBe(false);
  });

  it('NF órfã cujo nNumPedCompra é o contrato liga, com a data da NF', () => {
    const r = vincularNfs(
      [disp({ id: 1, omiePedido: '10' })],
      [ped({ codigo: '10', contrato: '2091397', doMotor: true })],
      [nfc('2091397', '000936222', '2026-05-12'), nfc('999', '000111')],
      OPTS,
    );
    expect(r.get(1)).toEqual({ nfs: [{ nf: '000936222', data: '2026-05-12' }], via: 'contrato' });
  });

  it('protocolo igual ao contrato é um identificador só', () => {
    const r = vincularNfs([disp({ id: 1, omiePedido: '10', protocolo: 'C' })], [ped({ codigo: '10', contrato: 'C', doMotor: true })], [nfc('C', '7')], OPTS);
    expect(r.get(1)?.via).toBe('contrato');
  });

  it('contrato com NF e protocolo de reenvio SEM NF → não liga (o reenvio pode estar em aberto)', () => {
    const r = vincularNfs([disp({ id: 81, omiePedido: '1007', protocolo: '2096769' })], [ped({ codigo: '1007', contrato: '2092370', doMotor: true })], [nfc('2092370', '000936222')], OPTS);
    expect(r.has(81)).toBe(false);
  });

  it('os dois identificadores com NF → liga as NFs de ambos', () => {
    const r = vincularNfs([disp({ id: 1, omiePedido: '10', protocolo: 'B' })], [ped({ codigo: '10', contrato: 'A', doMotor: true })], [nfc('A', '1'), nfc('B', '2', '2026-05-20')], OPTS);
    expect(r.get(1)).toEqual({ nfs: [{ nf: '1', data: '2026-05-12' }, { nf: '2', data: '2026-05-20' }], via: 'contrato' });
  });

  it('contrato vazio/espaços e NF sem data não identificam nada', () => {
    const r = vincularNfs(
      [disp({ id: 1, omiePedido: '10', protocolo: ' ' }), disp({ id: 2, omiePedido: '20' })],
      [ped({ codigo: '10', contrato: '', doMotor: true }), ped({ codigo: '20', contrato: 'X', doMotor: true })],
      [nfc('', '7'), nfc(' ', '8'), { contrato: 'X', nf: '9', data: '' }],
      OPTS,
    );
    expect(r.size).toBe(0);
  });

  it('a mesma NF em vários itens vira uma só, com a menor data', () => {
    const r = vincularNfs([disp({ id: 1, omiePedido: '10' })], [ped({ codigo: '10', contrato: 'C', doMotor: true })], [nfc('C', '5', '2026-05-14'), nfc('C', '5', '2026-05-12')], OPTS);
    expect(r.get(1)?.nfs).toEqual([{ nf: '5', data: '2026-05-12' }]);
  });

  it('disparado sem pedido Omie nos fatos e sem protocolo fica sem vínculo (ausente ≠ zero)', () => {
    expect(vincularNfs([disp({ id: 1, omiePedido: '404' })], [], [nfc('C', '1')], OPTS).size).toBe(0);
  });
});

describe('vincularNfs — R58 (B: substituto manual)', () => {
  const itens = [{ prod: 'P1', qtde: 8 }, { prod: 'P2', qtde: 5 }];
  const base = ped({ codigo: '1005', t1: '2026-05-07', doMotor: true, itens });
  const manual = (p: Partial<PedidoOmieSay> = {}) => ped({ codigo: 'M', t1: '2026-05-09', contrato: 'CM', itens: [...itens].reverse(), ...p });
  const caso = (outros: PedidoOmieSay[], o: { extraDisp?: DisparadoVinculo[]; nfs?: NfDoContrato[]; d?: Partial<DisparadoVinculo> } = {}) =>
    vincularNfs([disp({ id: 80, omiePedido: '1005', ...o.d }), ...(o.extraDisp ?? [])], [base, ...outros], o.nfs ?? [nfc('CM', '000936384'), nfc('CN', '000999')], OPTS).get(80);

  it('controle positivo: manual com itens idênticos, na janela, com NF e dono livre substitui', () =>
    expect(caso([manual()])).toEqual({ nfs: [{ nf: '000936384', data: '2026-05-12' }], via: 'substituto' }));
  it('limite: exatamente +21 dias ainda liga', () => expect(caso([manual({ t1: '2026-05-28' })])?.via).toBe('substituto'));
  it('mesmo dia liga', () => expect(caso([manual({ t1: '2026-05-07' })])?.via).toBe('substituto'));

  describe('não liga (fail-closed)', () => {
    it('disparado com protocolo do portal (o pedido dele existe na Sayerlack)', () => expect(caso([manual()], { d: { protocolo: '2096768' } })).toBeUndefined());
    it('disparado com contrato Sayerlack próprio', () => {
      const r = vincularNfs([disp({ id: 80, omiePedido: '1005' })], [ped({ ...base, contrato: '2091399' }), manual()], [nfc('CM', '1')], OPTS);
      expect(r.has(80)).toBe(false);
    });
    it('quantidade diferente', () => expect(caso([manual({ itens: [{ prod: 'P1', qtde: 8 }, { prod: 'P2', qtde: 4 }] })])).toBeUndefined());
    it('item a mais', () => expect(caso([manual({ itens: [...itens, { prod: 'P3', qtde: 1 }] })])).toBeUndefined());
    it('multiplicidade diferente', () => expect(caso([manual({ itens: [{ prod: 'P1', qtde: 8 }, { prod: 'P1', qtde: 8 }] })])).toBeUndefined());
    it('quantidade não finita', () => expect(caso([manual({ itens: [{ prod: 'P1', qtde: 8 }, { prod: 'P2', qtde: Number.NaN }] })])).toBeUndefined());
    it('itens vazios dos dois lados', () => {
      const r = vincularNfs([disp({ id: 80, omiePedido: '1005' })], [ped({ ...base, itens: [] }), manual({ itens: [] })], [nfc('CM', '1')], OPTS);
      expect(r.has(80)).toBe(false);
    });
    it('candidato do motor', () => expect(caso([manual({ doMotor: true })])).toBeUndefined());
    it('contrato do candidato pertence a um pedido do motor (proprietário concorrente, caso 1037/1048)', () =>
      expect(caso([manual(), ped({ codigo: '1048', t1: '2026-05-28', contrato: 'CM', doMotor: true, itens })])).toBeUndefined());
    it('contrato do candidato é protocolo de um disparado', () =>
      expect(caso([manual()], { extraDisp: [disp({ id: 99, protocolo: 'CM', nfs: ['x'] })] })).toBeUndefined());
    it('antes do pedido', () => expect(caso([manual({ t1: '2026-05-06' })])).toBeUndefined());
    it('depois de +21 dias', () => expect(caso([manual({ t1: '2026-05-29' })])).toBeUndefined());
    it('candidato sem NF por contrato', () => expect(caso([manual()], { nfs: [] })).toBeUndefined());
    it('dois candidatos para o mesmo disparado', () => expect(caso([manual(), manual({ codigo: 'N', contrato: 'CN', t1: '2026-05-10' })])).toBeUndefined());
    it('o candidato serve a dois disparados (independe da ordem)', () => {
      const outro = ped({ codigo: '1006', t1: '2026-05-08', doMotor: true, itens });
      const a = caso([manual(), outro], { extraDisp: [disp({ id: 81, omiePedido: '1006' })] });
      const b = vincularNfs([disp({ id: 81, omiePedido: '1006' }), disp({ id: 80, omiePedido: '1005' })], [manual(), outro, base], [nfc('CM', '1')], OPTS);
      expect(a).toBeUndefined();
      expect(b.size).toBe(0);
    });
  });
});

it('janela inválida lança com a marca do ramo', () => {
  expect(() => vincularNfs([], [], [], { janelaSubstitutoDias: Number.NaN })).toThrow('janelaSubstitutoDias inválida');
});

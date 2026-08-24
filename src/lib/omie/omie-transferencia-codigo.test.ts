import { describe, expect, it } from 'vitest';
import {
  classificarEntradaProof,
  classificarLoteProof,
  type LinhaIncumbente,
} from './omie-transferencia-codigo';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';

const linha = (user_id: string, omie_codigo_cliente: number, source = 'document'): LinhaIncumbente =>
  ({ user_id, omie_codigo_cliente, source });

const porCodigo = (...ls: LinhaIncumbente[]) => new Map(ls.map((l) => [l.omie_codigo_cliente, l]));
const porUser = (...ls: LinhaIncumbente[]) => new Map(ls.map((l) => [l.user_id, l]));

describe('classificarEntradaProof — o caso a caso contra o estado gravado', () => {
  it('código LIVRE → aplicar (o caminho de ~100% do volume: criação)', () => {
    const r = classificarEntradaProof({ user_id: U1, omie_codigo_cliente: 100 }, new Map(), new Map());
    expect(r.decisao).toBe('aplicar');
  });

  it('código já é DESTE user → aplicar (refresh diário do mesmo par, não é transferência)', () => {
    const r = classificarEntradaProof(
      { user_id: U1, omie_codigo_cliente: 100 },
      porCodigo(linha(U1, 100)),
      porUser(linha(U1, 100)),
    );
    expect(r.decisao).toBe('aplicar');
  });

  it('código pertence a OUTRO user → transferencia, e NOMEIA o incumbente', () => {
    const r = classificarEntradaProof(
      { user_id: U2, omie_codigo_cliente: 100 },
      porCodigo(linha(U1, 100)),
      new Map(),
    );
    expect(r.decisao).toBe('transferencia');
    // sem o incumbente não dá para quarantinar quem perde o vínculo nem auditar a transição
    expect(r.incumbente).toBe(U1);
  });

  it('aplicar NÃO carrega incumbente (o campo só existe no conflito)', () => {
    const r = classificarEntradaProof({ user_id: U1, omie_codigo_cliente: 100 }, new Map(), new Map());
    expect(r.incumbente).toBeUndefined();
  });

  it('linha do PRÓPRIO user é manual → manual_protegido, mesmo com o código livre', () => {
    // o upsert manda source:'document' — sem este ramo ele rebaixaria o override humano em silêncio
    const r = classificarEntradaProof(
      { user_id: U1, omie_codigo_cliente: 100 },
      new Map(),
      porUser(linha(U1, 100, 'manual')),
    );
    expect(r.decisao).toBe('manual_protegido');
  });

  it('manual do próprio user VENCE a transferência (precedência: override humano decide primeiro)', () => {
    const r = classificarEntradaProof(
      { user_id: U2, omie_codigo_cliente: 100 },
      porCodigo(linha(U1, 100)),
      porUser(linha(U2, 999, 'manual')),
    );
    expect(r.decisao).toBe('manual_protegido');
  });

  it.each(['document', 'rpc', 'code'])('source=%s do próprio user NÃO é imune (só manual é)', (src) => {
    const r = classificarEntradaProof(
      { user_id: U1, omie_codigo_cliente: 100 },
      new Map(),
      porUser(linha(U1, 100, src)),
    );
    expect(r.decisao).toBe('aplicar');
  });

  it('manual de OUTRO user não protege ESTA entrada — ela é transferência, não imunidade', () => {
    // a imunidade é da linha do próprio user; a linha manual alheia que detém o código vira conflito
    const r = classificarEntradaProof(
      { user_id: U2, omie_codigo_cliente: 100 },
      porCodigo(linha(U1, 100, 'manual')),
      new Map(),
    );
    expect(r.decisao).toBe('transferencia');
    expect(r.incumbente).toBe(U1);
  });
});

describe('classificarLoteProof — a colisão que nasce DENTRO do lote', () => {
  it('2 users disputando o MESMO código no lote → NENHUM leva (fail-closed simétrico ao P1b)', () => {
    const r = classificarLoteProof(
      [
        { user_id: U1, omie_codigo_cliente: 100 },
        { user_id: U2, omie_codigo_cliente: 100 },
      ],
      new Map(),
      new Map(),
    );
    expect(r.get(U1)?.decisao).toBe('transferencia');
    expect(r.get(U2)?.decisao).toBe('transferencia');
  });

  it('o MESMO user repetido no código não é disputa (duplicata da paginação do Omie) → aplicar', () => {
    // se isto virasse conflito, uma duplicata inócua do Omie zeraria um vínculo bom
    const r = classificarLoteProof(
      [
        { user_id: U1, omie_codigo_cliente: 100 },
        { user_id: U1, omie_codigo_cliente: 100 },
      ],
      new Map(),
      new Map(),
    );
    expect(r.get(U1)?.decisao).toBe('aplicar');
  });

  it('a disputa intra-lote NÃO contamina os códigos limpos do mesmo lote (precisão do escopo)', () => {
    const r = classificarLoteProof(
      [
        { user_id: U1, omie_codigo_cliente: 100 },
        { user_id: U2, omie_codigo_cliente: 100 },
        { user_id: U3, omie_codigo_cliente: 300 },
      ],
      new Map(),
      new Map(),
    );
    expect(r.get(U3)?.decisao).toBe('aplicar');
  });

  it('lote vazio → mapa vazio (nada marcado por acidente)', () => {
    expect(classificarLoteProof([], new Map(), new Map()).size).toBe(0);
  });

  it('o lote também aplica a regra contra o BANCO (transferência sobrevive à passagem pelo lote)', () => {
    const r = classificarLoteProof(
      [{ user_id: U2, omie_codigo_cliente: 100 }],
      porCodigo(linha(U1, 100)),
      new Map(),
    );
    expect(r.get(U2)?.decisao).toBe('transferencia');
    expect(r.get(U2)?.incumbente).toBe(U1);
  });

  it('INVARIANTE money-path: o conjunto "aplicar" nunca contém 2 users com o mesmo código', () => {
    // é exatamente a pré-condição que faz o upsert NUNCA violar uq_ocam_codigo_account
    const entradas = [
      { user_id: U1, omie_codigo_cliente: 100 },
      { user_id: U2, omie_codigo_cliente: 100 },
      { user_id: U3, omie_codigo_cliente: 300 },
    ];
    const r = classificarLoteProof(entradas, porCodigo(linha(U1, 300)), new Map());
    const aplicados = entradas.filter((e) => r.get(e.user_id)?.decisao === 'aplicar');
    const codigos = aplicados.map((e) => e.omie_codigo_cliente);
    expect(new Set(codigos).size).toBe(codigos.length);
  });
});

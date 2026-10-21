import { describe, it, expect } from 'vitest';
import { lerDesfazer, lerRegistroComDedupe } from '../borda-rpc';

describe('borda das RPCs de escrita do radar', () => {
  it('lê {id, deduped} e {deleted}', () => {
    expect(lerRegistroComDedupe({ id: 'r1', deduped: true }, 'registrar_contato_radar')).toEqual({ id: 'r1', deduped: true });
    expect(lerDesfazer({ deleted: false }, 'desfazer_contato_radar')).toEqual({ deleted: false });
  });

  it('resposta ausente ou fora da forma LANÇA (nunca vira registro inventado)', () => {
    expect(() => lerRegistroComDedupe(null, 'registrar_contato_rota')).toThrow('registrar_contato_rota: resposta não é objeto');
    expect(() => lerRegistroComDedupe({ id: 'r1' }, 'registrar_contato_rota')).toThrow('fora da forma {id, deduped}');
    expect(() => lerDesfazer({ deleted: 'sim' }, 'desfazer_contato_rota')).toThrow('fora da forma {deleted}');
  });
});

import { describe, it, expect } from 'vitest';
import { lerDesfazer, lerRegistroComDedupe } from '../borda-rpc';

describe('borda das RPCs de escrita do radar', () => {
  it('lê {id, deduped} e {deleted}', () => {
    expect(lerRegistroComDedupe({ id: 'r1', deduped: true }, 'registrar_contato_radar')).toEqual({ id: 'r1', deduped: true });
    expect(lerDesfazer({ deleted: true, status_restaurado: true }, 'desfazer_contato_radar')).toEqual({ deleted: true, statusRestaurado: true });
    expect(lerDesfazer({ deleted: true, status_restaurado: false }, 'desfazer_contato_radar')).toEqual({ deleted: true, statusRestaurado: false });
  });

  it('banco anterior (sem status_restaurado): desconhecido, nunca "restaurou" nem "preservou"', () => {
    expect(lerDesfazer({ deleted: false }, 'desfazer_contato_radar')).toEqual({ deleted: false, statusRestaurado: null });
    expect(() => lerDesfazer({ deleted: true, status_restaurado: 'sim' }, 'desfazer_contato_radar')).toThrow('fora da forma {status_restaurado}');
  });

  it('resposta ausente ou fora da forma LANÇA (nunca vira registro inventado)', () => {
    expect(() => lerRegistroComDedupe(null, 'registrar_contato_rota')).toThrow('registrar_contato_rota: resposta não é objeto');
    expect(() => lerRegistroComDedupe({ id: 'r1' }, 'registrar_contato_rota')).toThrow('fora da forma {id, deduped}');
    expect(() => lerDesfazer({ deleted: 'sim' }, 'desfazer_contato_rota')).toThrow('fora da forma {deleted}');
  });
});

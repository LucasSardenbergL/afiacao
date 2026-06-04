// src/lib/route/painel/__tests__/agregar.test.ts
import { describe, it, expect } from 'vitest';
import { agregarPainel } from '../agregar';
import type { SnapshotRow, ContatoRow } from '../types';

const snap = (over: Partial<SnapshotRow>): SnapshotRow => ({
  data_rota: '2026-06-03', farmer_id: 'r', customer_user_id: 'c1',
  cidade: 'DIVINOPOLIS (MG)', bucket: 'top', valor_da_ligacao: 100, rank: 1, ...over,
});
const ct = (over: Partial<ContatoRow>): ContatoRow => ({
  data_rota: '2026-06-03', farmer_id: 'r', customer_user_id: 'c1',
  canal: 'ligacao', status: 'respondido', valor_da_ligacao: 100, bucket: 'top', ...over,
});

describe('agregarPainel', () => {
  it('cobertura: 2 elegíveis, 1 contatado → 1/2; gap = valor do não-contatado', () => {
    const snaps = [snap({ customer_user_id: 'c1', valor_da_ligacao: 100 }),
                   snap({ customer_user_id: 'c2', valor_da_ligacao: 60 })];
    const contatos = [ct({ customer_user_id: 'c1' })];
    const r = agregarPainel(snaps, contatos);
    expect(r.elegiveis_n).toBe(2);
    expect(r.contatados_n).toBe(1);
    expect(r.cobertura_count.fracao).toBe('1/2');
    expect(r.elegiveis_valor).toBe(160);
    expect(r.contatados_valor).toBe(100);
    expect(r.gap_valor).toBe(60);   // c2 não contatado
  });

  it('eficácia global: conversão/resposta/optout sobre contatos de ligação', () => {
    const snaps = [snap({ customer_user_id: 'c1' }), snap({ customer_user_id: 'c2' }), snap({ customer_user_id: 'c3' })];
    const contatos = [
      ct({ customer_user_id: 'c1', status: 'convertido', valor_da_ligacao: 100 }),
      ct({ customer_user_id: 'c2', status: 'sem_resposta' }),
      ct({ customer_user_id: 'c3', status: 'opt_out' }),
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.global.contatos).toBe(3);
    expect(r.global.resposta.fracao).toBe('1/3');     // só convertido conta como atendido aqui
    expect(r.global.conversao.fracao).toBe('1/3');
    expect(r.global.optout.fracao).toBe('1/3');
    expect(r.global.valor_capturado).toBe(100);       // valor da convertida
    expect(r.global.conversao.exibivel).toBe(false);  // n=3 < 30
  });

  it('dia com contato de ligação SEM snapshot → dias_sem_denominador, não infla cobertura', () => {
    const snaps = [snap({ data_rota: '2026-06-03', customer_user_id: 'c1' })];
    const contatos = [
      ct({ data_rota: '2026-06-03', customer_user_id: 'c1' }),               // tem snapshot
      ct({ data_rota: '2026-06-04', customer_user_id: 'cX' }),               // SEM snapshot nesse dia
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.elegiveis_n).toBe(1);
    expect(r.contatados_n).toBe(1);            // só o que casa com snapshot
    expect(r.cobertura_count.fracao).toBe('1/1');
    expect(r.dias_sem_denominador).toBe(1);    // 2026-06-04
  });

  it('por_canal separa ligação e whatsapp; por_vendedora agrupa por farmer', () => {
    const snaps = [snap({ customer_user_id: 'c1' })];
    const contatos = [
      ct({ canal: 'ligacao', farmer_id: 'r', status: 'convertido' }),
      ct({ canal: 'whatsapp', farmer_id: 't', customer_user_id: 'c9', status: 'respondido' }),
    ];
    const r = agregarPainel(snaps, contatos);
    expect(r.por_canal.map(g => g.chave).sort()).toEqual(['ligacao', 'whatsapp']);
    expect(r.por_vendedora.map(g => g.chave).sort()).toEqual(['r', 't']);
  });

  it('vazio → zeros, sem divisão por zero', () => {
    const r = agregarPainel([], []);
    expect(r.elegiveis_n).toBe(0);
    expect(r.gap_valor).toBe(0);
    expect(r.contatos_por_dia).toBe(0);
    expect(r.global.conversao.valor).toBeNull();
  });
});

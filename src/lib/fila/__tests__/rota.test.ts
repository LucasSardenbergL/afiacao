import { describe, it, expect } from 'vitest';
import { rotaParaAcoes } from '../adapters/rota';
import type { RouteContactItem } from '@/queries/useRouteContactList';

function item(p: Partial<RouteContactItem>): RouteContactItem {
  return {
    customerUserId: 'c1', farmerId: 'v1', cityKey: 'CIDADE (MG)', pConverte: 0.5, ticketEsperado: 1000,
    margemPerc: 0.22, diasDesdeUltima: 30, intervaloMedioDias: 30, isColdStart: false, optOut: false,
    contatadoHaDias: null, fechouHoje: false, janela24hAberta: false, margemNegativaConhecida: false,
    valorDaLigacao: 220, prontidao: 1, motivoGate: null, bucket: 'top',
    name: 'Cliente 1', phone: '5599...', farmerName: 'Vendedora', ultimoContatoRealHaDias: null,
    semRespostaRecenteN: 0, cadenciaBloqueadaPor: null, jaConvertidoNaRota: false, ...p,
  } as RouteContactItem;
}

describe('rotaParaAcoes', () => {
  it('mapeia para categoria esperado com valorEsperado = valorDaLigacao', () => {
    const [a] = rotaParaAcoes([item({ valorDaLigacao: 220 })], '2026-06-04');
    expect(a.fonte).toBe('rota');
    expect(a.categoria).toBe('esperado');
    expect(a.valorEsperado).toBe(220);
    expect(a.tipoValor).toBe('estimado');
    expect(a.cta).toBe('ligar');
    expect(a.telefone).toBe('5599...');
    expect(a.dedupeKey).toBe('c1:ligar');
    expect(a.payload).toEqual({ kind: 'rota', customerUserId: 'c1', dataRota: '2026-06-04', bucket: 'top', valor: 220 });
  });

  it('usa prontidao como score e o nome no título', () => {
    const [a] = rotaParaAcoes([item({ prontidao: 0.8, name: 'Marcenaria X' })], '2026-06-04');
    expect(a.score).toBe(0.8);
    expect(a.titulo).toContain('Marcenaria X');
  });
});

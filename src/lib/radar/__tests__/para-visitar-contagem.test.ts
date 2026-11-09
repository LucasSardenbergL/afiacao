/**
 * Pacote N, item 2: o número do chip "Para visitar" é SOB DEMANDA. Antes, uma 2ª `radar_lista` (até 200) a cada
 * troca de filtro — ~5,5 s de pré-corte em prod. Agora o chip desligado não lê nada nem mostra número; ligado, o
 * número sai da própria fila (que já é o recorte "para visitar").
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { rotuloDaContagem } from '@/queries/useRadarContatoContabil';

const fila = (paginas: number[], hasNextPage: boolean, extra: { isPending?: boolean; isError?: boolean } = {}) => ({
  isPending: false, isError: false, hasNextPage,
  data: { pages: paginas.map((n) => Array.from({ length: n })) },
  ...extra,
});

describe('rotuloDaContagem', () => {
  it('chip desligado: sem número e sem leitura (nem "…" eterno)', () => {
    expect(rotuloDaContagem(false, fila([], false, { isPending: true }))).toEqual({ isError: false, data: null, rotulo: '' });
  });
  it('ligado e a fila acabou: o número exato', () => {
    expect(rotuloDaContagem(true, fila([37], false))).toEqual({ isError: false, data: 37, rotulo: '37' });
    expect(rotuloDaContagem(true, fila([0], false)).rotulo).toBe('0');
  });
  it('ligado com página seguinte: "N+" (o que já veio, nunca um total inventado)', () => {
    expect(rotuloDaContagem(true, fila([50, 50], true))).toEqual({ isError: false, data: 100, rotulo: '100+' });
  });
  it('ligado e carregando: "…"; ligado e a fila falhou: "?" (nunca 0)', () => {
    expect(rotuloDaContagem(true, { isPending: true, isError: false, hasNextPage: false }).rotulo).toBe('…');
    expect(rotuloDaContagem(true, { isPending: false, isError: true, hasNextPage: false })).toEqual({ isError: true, data: null, rotulo: '?' });
  });
});

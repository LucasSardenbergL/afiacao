import { describe, it, expect } from 'vitest';
import { ehAbaixoMinimoBenigno, particionarAtencao } from '../shared';
import type { StatusEnvioPortal } from '../types';

// Helper: pedido mínimo p/ os predicados de partição da fila de atenção.
// gate='minimo_faturamento' só "conta" quando status='falha_envio' (contrato de
// ehGateMinimoFaturamento). resposta_canal é a coluna jsonb (gate mora nela).
const mk = (
  status: string,
  portal: StatusEnvioPortal | null | undefined = null,
  gate: string | null = null,
) => ({
  status,
  status_envio_portal: portal,
  resposta_canal: gate ? { gate } : null,
});

const GATE = 'minimo_faturamento';

describe('ehAbaixoMinimoBenigno (A′ · partição da fila de atenção)', () => {
  it('gate de mínimo puro (portal nao_aplicavel/null) → benigno', () => {
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', null, GATE))).toBe(true);
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'nao_aplicavel', GATE))).toBe(true);
  });

  it('gate de mínimo + erro_retentavel → benigno (o retry-órfãos re-tenta; não é fila de atenção)', () => {
    // Espelha o caso REAL do pedido 1002: falha_envio + gate + erro_retentavel.
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'erro_retentavel', GATE))).toBe(true);
  });

  // ── O achado do Codex (xhigh): PORTAL VENCE SEMPRE ──
  // Um pedido pode ser gate-mínimo E estar em conciliação (PO talvez já exista
  // no fornecedor). Recolhê-lo no balde neutro esconderia risco de compra-dupla.
  it('gate de mínimo + estado de conciliação → NÃO benigno (portal vence)', () => {
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'aceito_portal_sem_protocolo', GATE))).toBe(false);
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'indeterminado_requer_conciliacao', GATE))).toBe(false);
  });

  it('gate de mínimo + falha dura do portal → NÃO benigno (portal vence)', () => {
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'falha_envio_portal', GATE))).toBe(false);
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'erro_nao_retentavel', GATE))).toBe(false);
  });

  it('falha_envio SEM gate de mínimo (SKU sem custo / erro Omie) → NÃO benigno', () => {
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', null, null))).toBe(false);
    expect(ehAbaixoMinimoBenigno(mk('falha_envio', 'nao_aplicavel', 'outro_gate'))).toBe(false);
  });

  it('conciliação pura sem gate (disparado + portal ambíguo) → NÃO benigno', () => {
    expect(ehAbaixoMinimoBenigno(mk('disparado', 'aceito_portal_sem_protocolo', null))).toBe(false);
  });
});

describe('particionarAtencao', () => {
  it('separa vermelha (ação real) × abaixoMinimo (benigno) e preserva todos', () => {
    const lista = [
      mk('falha_envio', null, GATE), // benigno
      mk('falha_envio', 'indeterminado_requer_conciliacao', GATE), // portal vence → vermelha
      mk('falha_envio', null, null), // SKU sem custo → vermelha
      mk('disparado', 'aceito_portal_sem_protocolo', null), // conciliação → vermelha
      mk('falha_envio', 'erro_retentavel', GATE), // benigno
    ];
    const { vermelha, abaixoMinimo } = particionarAtencao(lista);
    expect(abaixoMinimo).toHaveLength(2);
    expect(vermelha).toHaveLength(3);
    // nada some
    expect(vermelha.length + abaixoMinimo.length).toBe(lista.length);
  });

  it('lista vazia → duas listas vazias', () => {
    const { vermelha, abaixoMinimo } = particionarAtencao([]);
    expect(vermelha).toEqual([]);
    expect(abaixoMinimo).toEqual([]);
  });
});

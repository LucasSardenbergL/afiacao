import { describe, it, expect } from 'vitest';
import type { FinResumo } from '@/services/financeiroService';
import { alertasDaView } from '../financeiroAlerts';

/**
 * Os alertas da Visão Geral saem SÓ das empresas da `view`. Antes o memo passava o mapa
 * `resumo` inteiro: com view='oben' e o resumo da Oben falhando, os alertas de colacor/
 * colacor_sc carregados antes continuavam na tela sob o rótulo da Oben.
 */

// Resumo que dispara o alerta de posição líquida negativa.
const critico = (): FinResumo => ({
  contas_correntes: [],
  saldo_total_cc: 1_000_000,
  total_a_receber: 0,
  total_a_pagar: 0,
  total_vencido_receber: 0,
  total_vencido_pagar: 0,
  posicao_liquida: -100_000,
});

const empresas = (alertas: { company: string }[]) => alertas.map((a) => a.company).sort();

describe('alertasDaView — alertas escopados à empresa da view', () => {
  it('view=oben com resumo da Oben indisponível: nenhum alerta de outra empresa', () => {
    const resumo = { colacor: critico(), colacor_sc: critico() };
    expect(alertasDaView(resumo, 'oben', null, null)).toEqual([]);
  });

  it('view=oben: só alerta da Oben, mesmo com as outras empresas no mapa', () => {
    const resumo = { oben: critico(), colacor: critico(), colacor_sc: critico() };
    expect(empresas(alertasDaView(resumo, 'oben', null, null))).toEqual(['oben']);
  });

  it('view=all com um CNPJ faltando: nenhum alerta de resumo (ausente não é "sem alerta")', () => {
    const resumo = { oben: critico(), colacor: critico() };
    expect(alertasDaView(resumo, 'all', null, null)).toEqual([]);
  });

  it('view=all completa: alertas das três empresas', () => {
    const resumo = { oben: critico(), colacor: critico(), colacor_sc: critico() };
    expect(empresas(alertasDaView(resumo, 'all', null, null))).toEqual(['colacor', 'colacor_sc', 'oben']);
  });
});

import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
vi.mock('@/lib/invoke-function', () => ({ invokeFunction: vi.fn() }));

import { montarPayloadCriarCliente } from '@/queries/useRadarAcoesLead';
import type { RadarEmpresa } from '@/queries/useRadarLista';

/**
 * Pacote L (item 4): o payload do cadastro no Omie leva o telefone ESCOLHIDO na confirmação. O que pegaria a saída
 * errada: escolha ignorada (volta ao `telefone1 || telefone2` cego) ou "não enviar telefone" mandando o da Receita.
 */
const EMPRESA = { cnpj: '10300000000101', razao_social: 'Lead 103', telefone1: '3732220001', telefone2: '3799990002' } as RadarEmpresa;

describe('montarPayloadCriarCliente', () => {
  it('telefone escolhido vale como está', () => {
    expect(montarPayloadCriarCliente({ ...EMPRESA, telefoneCadastro: '3799990002' }).telefone).toBe('3799990002');
  });
  it('"não enviar telefone" (null) não manda nenhum, nem o da Receita', () => {
    expect(montarPayloadCriarCliente({ ...EMPRESA, telefoneCadastro: null }).telefone).toBeUndefined();
  });
  it('sem escolha (lote, retentativa antiga): o 1º número da Receita, como antes', () => {
    expect(montarPayloadCriarCliente(EMPRESA).telefone).toBe('3732220001');
  });
});

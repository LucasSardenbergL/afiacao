import { describe, it, expect, vi } from 'vitest';

const { rpc, invokeFunction } = vi.hoisted(() => ({ rpc: vi.fn(), invokeFunction: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/invoke-function', () => ({ invokeFunction }));

import { depsCadastroSupabase, montarPayloadCriarCliente } from '@/queries/useRadarAcoesLead';
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

/**
 * Cadastro SEM confirmação (lote do gestor): antes ia `telefone1 || telefone2` às cegas — o número do escritório de
 * contabilidade nascia no Omie. Agora `criarNoOmie` lê o contato da contabilidade e aplica a mesma regra da tela.
 */
describe('criarNoOmie sem telefone escolhido (lote)', () => {
  const linha = (campo: string, efetivo: boolean | null) => ({
    campo, tipo: 'telefone', automatico: efetivo, veredito: null, efetivo, corroborado: null, grupos: null,
    correcao_id: null, motivos: [], visitar: false, calculado_em: '2026-11-08T03:00:00Z',
  });
  const contabil = (resposta: { data: unknown; error: unknown }) => {
    rpc.mockReset();
    invokeFunction.mockReset().mockResolvedValue({ ok: true });
    rpc.mockImplementation((nome: string) => nome === 'radar_razao_social_para_cadastro'
      ? Promise.resolve({ data: 'LEAD 103 LTDA', error: null })
      : { range: () => Promise.resolve(resposta) });
  };
  const telefoneEnviado = () => (invokeFunction.mock.calls[0][1] as { telefone?: string }).telefone;

  it('telefone1 da contabilidade: vai o telefone2', async () => {
    contabil({ data: [linha('telefone1', true), linha('telefone2', false)], error: null });
    await depsCadastroSupabase.criarNoOmie(EMPRESA);
    expect(telefoneEnviado()).toBe('3799990002');
  });

  it('só o da contabilidade: não vai telefone nenhum', async () => {
    contabil({ data: [linha('telefone1', true)], error: null });
    await depsCadastroSupabase.criarNoOmie({ ...EMPRESA, telefone2: null });
    expect(telefoneEnviado()).toBeUndefined();
  });

  it('leitura falhou: o 1º número, como antes, e o cadastro NÃO para', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    contabil({ data: null, error: { code: '57014', message: 'timeout' } });
    await depsCadastroSupabase.criarNoOmie(EMPRESA);
    expect(telefoneEnviado()).toBe('3732220001');
    warn.mockRestore();
  });

  it('com escolha da tela: não relê a contabilidade', async () => {
    contabil({ data: [linha('telefone1', true)], error: null });
    await depsCadastroSupabase.criarNoOmie({ ...EMPRESA, telefoneCadastro: '3732220001' });
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['radar_razao_social_para_cadastro']);
    expect(telefoneEnviado()).toBe('3732220001');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Revisão do Radar 2026-11-11, itens 5 e 7 — o CONTRATO payload ↔ action `criar_cliente`. O cadastro descartava o
 * e-mail e o complemento que a carga da Receita guarda; e a exigência de elegibilidade só existe se o payload a levar
 * e a edge a ler. A edge é lida como TEXTO (o vitest não roda Deno): toda chave que o front manda tem de ser lida no
 * `case "criar_cliente"`, e o e-mail/complemento têm de chegar ao `clienteParams` do IncluirCliente.
 */
const { rpc, invokeFunction } = vi.hoisted(() => ({ rpc: vi.fn(), invokeFunction: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc } }));
vi.mock('@/lib/invoke-function', () => ({ invokeFunction }));

import { depsCadastroSupabase, montarPayloadCriarCliente } from '@/queries/useRadarAcoesLead';
import type { RadarEmpresa } from '@/queries/useRadarLista';

const EMPRESA = {
  cnpj: '10300000000101', razao_social: 'Lead 103', telefone1: null, telefone2: null,
  email: 'compras@lead103.com.br', complemento: 'SALA 2',
} as unknown as RadarEmpresa;

const linha = (campo: string, efetivo: boolean | null) => ({
  campo, tipo: campo === 'email' ? 'email' : 'telefone', automatico: efetivo, veredito: null, efetivo, corroborado: null,
  grupos: null, correcao_id: null, motivos: [], visitar: false, calculado_em: '2026-11-08T03:00:00Z',
});
function contabil(resposta: { data: unknown; error: unknown }) {
  rpc.mockReset();
  invokeFunction.mockReset().mockResolvedValue({ ok: true });
  rpc.mockImplementation((nome: string) => nome === 'radar_razao_social_para_cadastro'
    ? Promise.resolve({ data: 'LEAD 103 LTDA', error: null })
    : { range: () => Promise.resolve(resposta) });
}
const enviado = () => invokeFunction.mock.calls[0][1] as Record<string, unknown>;

describe('payload do criar_cliente', () => {
  it('leva o complemento e a exigência do Radar; o e-mail só quando decidido', () => {
    const p = montarPayloadCriarCliente(EMPRESA);
    expect(p.complemento).toBe('SALA 2');
    expect(p.email).toBeUndefined();
    expect(p.radar).toEqual({ exigir_em_conversa: false });
    expect(montarPayloadCriarCliente({ ...EMPRESA, emailCadastro: 'x@y.com', exigirEmConversa: true })).toMatchObject({
      email: 'x@y.com', radar: { exigir_em_conversa: true },
    });
  });
});

describe('criarNoOmie: o e-mail da Receita só vai com a contabilidade conferida', () => {
  it('e-mail que NÃO é da contabilidade: vai', async () => {
    contabil({ data: [linha('email', false)], error: null });
    await depsCadastroSupabase.criarNoOmie(EMPRESA);
    expect(enviado().email).toBe('compras@lead103.com.br');
    expect(enviado().complemento).toBe('SALA 2');
  });

  it('e-mail da contabilidade: não vai', async () => {
    contabil({ data: [linha('email', true)], error: null });
    await depsCadastroSupabase.criarNoOmie(EMPRESA);
    expect(enviado().email).toBeUndefined();
  });

  it('leitura da contabilidade falhou: não vai (falha não é "não é da contabilidade")', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    contabil({ data: null, error: { code: '57014', message: 'timeout' } });
    await depsCadastroSupabase.criarNoOmie(EMPRESA);
    expect(enviado().email).toBeUndefined();
    warn.mockRestore();
  });

  it('ficha com telefone escolhido: a contabilidade é lida mesmo assim, por causa do e-mail', async () => {
    contabil({ data: [], error: null });
    await depsCadastroSupabase.criarNoOmie({ ...EMPRESA, telefoneCadastro: null, exigirEmConversa: true });
    expect(rpc.mock.calls.map((c) => c[0])).toContain('radar_contato_contabil_da_empresa');
    expect(enviado()).toMatchObject({ email: 'compras@lead103.com.br', radar: { exigir_em_conversa: true } });
  });
});

describe('contrato com a edge omie-vendas-sync (lida como texto)', () => {
  const fonte = readFileSync(resolve(__dirname, '../../../supabase/functions/omie-vendas-sync/index.ts'), 'utf8');
  const inicio = fonte.indexOf('case "criar_cliente": {');
  const bloco = fonte.slice(inicio, fonte.indexOf('case "buscar_precos_cliente"', inicio));
  const destruct = /const \{([^}]+)\} = params;/.exec(bloco)?.[1] ?? '';
  const lidas = new Set(destruct.split(',').map((c) => c.trim().split(':')[0].trim()));

  it('toda chave que o front manda é lida pela action', () => {
    expect(inicio).toBeGreaterThan(0);
    const chaves = Object.keys(montarPayloadCriarCliente({ ...EMPRESA, emailCadastro: 'x@y.com' }))
      .filter((k) => k !== 'action' && k !== 'account');
    expect(chaves.filter((k) => !lidas.has(k))).toEqual([]);
  });

  it('e-mail e complemento chegam ao IncluirCliente, e a elegibilidade roda ANTES dele', () => {
    expect(bloco).toMatch(/clienteParams\.email = emailCadastro/);
    expect(bloco).toMatch(/clienteParams\.complemento = complementoCadastro/);
    const elegibilidade = bloco.indexOf('verificarElegibilidadeRadar(');
    expect(elegibilidade).toBeGreaterThan(bloco.indexOf('buscarClienteEstrito(docClean'));
    expect(elegibilidade).toBeLessThan(bloco.indexOf('"IncluirCliente"'));
  });
});

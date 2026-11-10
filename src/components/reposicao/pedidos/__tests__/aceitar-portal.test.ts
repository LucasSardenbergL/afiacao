import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: vi.fn() } } }));

import { descreverDiferenca, interpretarRespostaAceitar, lerDiferencas, lerLeitura, podeOferecerAceitar } from '../aceitar-portal';
import type { PedidoSugerido } from '../types';

const base = {
  id: 7, empresa: 'OBEN', status: 'aprovado_aguardando_disparo', status_envio_portal: 'sucesso_portal',
  portal_protocolo: '2141001', omie_pedido_compra_id: null, portal_situacao_codigo: '1', portal_situacao_protocolo: '2141001',
  portal_divergencia_aberta_id: 42,
};
const ped = (p: Record<string, unknown> = {}) => ({ ...base, ...p }) as unknown as PedidoSugerido;

describe('podeOferecerAceitar', () => {
  it('oferece com divergência aberta, sem PO, aguardando disparo, situação 1 ou 5 do próprio protocolo', () => {
    expect(podeOferecerAceitar(ped())).toBe(true);
    expect(podeOferecerAceitar(ped({ status: 'falha_envio', portal_situacao_codigo: '5', omie_pedido_compra_id: '0' }))).toBe(true);
  });
  it('não oferece fora dele (ausente nunca é "pode")', () => {
    expect(podeOferecerAceitar(null)).toBe(false);
    expect(podeOferecerAceitar(ped({ portal_divergencia_aberta_id: null }))).toBe(false);
    expect(podeOferecerAceitar(ped({ portal_divergencia_aberta_id: undefined }))).toBe(false);
    expect(podeOferecerAceitar(ped({ portal_situacao_codigo: '6' }))).toBe(false);
    expect(podeOferecerAceitar(ped({ portal_situacao_codigo: null }))).toBe(false);
    expect(podeOferecerAceitar(ped({ portal_situacao_protocolo: '2141999' }))).toBe(false);
    expect(podeOferecerAceitar(ped({ omie_pedido_compra_id: '9001' }))).toBe(false);
    expect(podeOferecerAceitar(ped({ status: 'disparado' }))).toBe(false);
    expect(podeOferecerAceitar(ped({ status_envio_portal: 'enviando_portal' }))).toBe(false);
    expect(podeOferecerAceitar(ped({ empresa: 'COLACOR' }))).toBe(false);
  });
});

describe('interpretarRespostaAceitar', () => {
  it('aceito só com aceito:true', () => {
    expect(interpretarRespostaAceitar({ aceito: true, retrato_versao: 2 }, null).desfecho).toBe('aceito');
    expect(interpretarRespostaAceitar({ aceito: 'true' }, null).desfecho).toBe('erro');
  });
  it('recusa de negócio traduz o motivo; motivo desconhecido aparece cru', () => {
    expect(interpretarRespostaAceitar({ aceito: false, motivo: 'divergencia_mudou' }, null)).toEqual({
      desfecho: 'recusado', mensagem: expect.stringMatching(/mudou de novo/),
    });
    expect(interpretarRespostaAceitar({ aceito: false, motivo: 'po_no_espelho' }, null).mensagem).toMatch(/Omie/);
    expect(interpretarRespostaAceitar({ aceito: false, motivo: 'novo_motivo' }, null).mensagem).toMatch(/novo_motivo/);
  });
  it('erros do banco: staff, entrada, corrida e prova da leitura são recusa; o resto é "não sei"', () => {
    expect(interpretarRespostaAceitar(null, { code: '42501' }).desfecho).toBe('recusado');
    expect(interpretarRespostaAceitar(null, { code: '40001' }).desfecho).toBe('recusado');
    expect(interpretarRespostaAceitar(null, { code: 'CP007', message: 'prova' }).mensagem).toMatch(/CP007/);
    const r = interpretarRespostaAceitar(null, { code: '57014', message: 'timeout' });
    expect(r.desfecho).toBe('erro');
    expect(r.mensagem).toMatch(/Reabra o pedido para conferir/);
  });
  it('sem contrato reconhecido é "não sei" — nunca aceito', () => {
    expect(interpretarRespostaAceitar({}, null).desfecho).toBe('erro');
    expect(interpretarRespostaAceitar(null, null).desfecho).toBe('erro');
  });
});

describe('diferenças', () => {
  it('lê o array da divergência e recusa forma inesperada (null, nunca lista vazia)', () => {
    expect(lerDiferencas([{ tipo: 'quantidade', sku: 'DFA.4080LT', app: 16, portal: 17 }])).toHaveLength(1);
    expect(lerDiferencas('x')).toBeNull();
    expect(lerDiferencas([{ sku: 'X' }])).toBeNull();
  });
  it('descreve cada tipo; tipo desconhecido não some', () => {
    expect(descreverDiferenca({ tipo: 'quantidade', sku: 'DFA.4080LT', app: 16, portal: 17 })).toBe('DFA.4080LT: quantidade 16 → 17 (no portal)');
    expect(descreverDiferenca({ tipo: 'condicao', sku: null, app: '70 - 7 DIAS', portal: '30 DIAS' })).toBe('Condição: 70 - 7 DIAS → 30 DIAS');
    expect(descreverDiferenca({ tipo: 'sku_novo_no_portal', sku: 'GL.UM', app: null, portal: 2 })).toBe('GL.UM: entrou no portal (2)');
    expect(descreverDiferenca({ tipo: 'misterio', sku: null, app: 1, portal: 2 })).toBe('misterio: 1 → 2');
  });
});

describe('lerLeitura', () => {
  it('lê o pedido do portal que o aceite aplica (itens com valor, total, condição)', () => {
    const l = lerLeitura({ protocolo: '1', condicao: '30 DIAS', valor_total: 5644.5,
      itens: [{ sku_portal: 'DFA.4080LT', qtde_portal: 17, valor_mercadoria: 5100 }] });
    expect(l).toEqual({ itens: [{ sku: 'DFA.4080LT', qtde: 17, valor: 5100 }], total: 5644.5, condicao: '30 DIAS' });
  });
  it('forma inesperada é null — ausente nunca vira zero nem lista vazia', () => {
    expect(lerLeitura(null)).toBeNull();
    expect(lerLeitura({ condicao: 'x', valor_total: 1, itens: [] })).toBeNull();
    expect(lerLeitura({ condicao: 'x', itens: [{ sku_portal: 'A', qtde_portal: 1, valor_mercadoria: 1 }] })).toBeNull();
    expect(lerLeitura({ condicao: 'x', valor_total: 1, itens: [{ sku_portal: 'A', qtde_portal: '1', valor_mercadoria: 1 }] })).toBeNull();
  });
  it('aguardando_releitura tem mensagem própria', () => {
    expect(interpretarRespostaAceitar({ aceito: false, motivo: 'aguardando_releitura' }, null).mensagem).toMatch(/reler o portal/);
  });
});

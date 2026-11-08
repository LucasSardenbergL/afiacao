import { describe, it, expect } from 'vitest';
import { interpretarRespostaEncerrar, podeOferecerEncerrar } from '../encerrar-cancelado-portal';
import type { PedidoSugerido } from '../types';

const base = {
  id: 7, empresa: 'OBEN', status: 'aprovado_aguardando_disparo', status_envio_portal: 'sucesso_portal',
  portal_protocolo: '2141001', omie_pedido_compra_id: null, portal_situacao_codigo: '6', portal_situacao_protocolo: '2141001',
};
const ped = (p: Record<string, unknown> = {}) => ({ ...base, ...p }) as unknown as PedidoSugerido;

describe('podeOferecerEncerrar', () => {
  it('oferece no caso da 5.3 (inclusive falha_envio e PO "0")', () => {
    expect(podeOferecerEncerrar(ped())).toBe(true);
    expect(podeOferecerEncerrar(ped({ status: 'falha_envio', omie_pedido_compra_id: '0' }))).toBe(true);
  });
  it('não oferece fora dele', () => {
    expect(podeOferecerEncerrar(null)).toBe(false);
    expect(podeOferecerEncerrar(ped({ empresa: 'COLACOR' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ status: 'disparado' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ status_envio_portal: 'enviado_portal' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ omie_pedido_compra_id: '9001' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ portal_situacao_codigo: '1' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ portal_situacao_protocolo: '2141999' }))).toBe(false);
    expect(podeOferecerEncerrar(ped({ portal_protocolo: null }))).toBe(false);
  });
});

describe('interpretarRespostaEncerrar', () => {
  it('encerrado só com ok:true e desfecho encerrado', () => {
    expect(interpretarRespostaEncerrar({ ok: true, desfecho: 'encerrado', mensagem: 'feito' }, 200)).toEqual({ desfecho: 'encerrado', mensagem: 'feito' });
    expect(interpretarRespostaEncerrar({ ok: false, desfecho: 'encerrado' }, 200).desfecho).toBe('erro');
  });
  it('recusado e indeterminado mantêm a mensagem da edge', () => {
    expect(interpretarRespostaEncerrar({ ok: false, desfecho: 'recusado', mensagem: 'tem PO' }, 200)).toEqual({ desfecho: 'recusado', mensagem: 'tem PO' });
    expect(interpretarRespostaEncerrar({ ok: false, desfecho: 'indeterminado', mensagem: 'Omie sem prova' }, 200).desfecho).toBe('indeterminado');
  });
  it('sem contrato reconhecido é "não sei" e manda conferir — nunca encerrado', () => {
    const r = interpretarRespostaEncerrar({}, 200);
    expect(r.desfecho).toBe('erro');
    expect(r.mensagem).toMatch(/Reabra o pedido para conferir/);
    expect(interpretarRespostaEncerrar(null, null).desfecho).toBe('erro');
    expect(interpretarRespostaEncerrar({ ok: false, desfecho: 'erro', mensagem: 'x' }, 500).desfecho).toBe('erro');
  });
  it('401/403 viram recusa de permissão; 400 mostra a mensagem', () => {
    expect(interpretarRespostaEncerrar({ error: 'Unauthorized' }, 401).desfecho).toBe('recusado');
    expect(interpretarRespostaEncerrar({ ok: false, mensagem: 'Escreva uma justificativa' }, 400)).toEqual({ desfecho: 'recusado', mensagem: 'Escreva uma justificativa' });
  });
});

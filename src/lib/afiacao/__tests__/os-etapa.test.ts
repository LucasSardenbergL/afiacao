import { describe, it, expect } from 'vitest';
import { mapearStatusEtapa } from '../os-etapa';

describe('mapearStatusEtapa', () => {
  it('status iniciais → etapa 10 (Aberta)', () => {
    expect(mapearStatusEtapa('pedido_recebido')).toBe('10');
    expect(mapearStatusEtapa('aguardando_coleta')).toBe('10');
    expect(mapearStatusEtapa('orcamento_enviado')).toBe('10');
    expect(mapearStatusEtapa('aprovado')).toBe('10');
  });

  it('status em produção → etapa 20 (Em andamento)', () => {
    expect(mapearStatusEtapa('em_triagem')).toBe('20');
    expect(mapearStatusEtapa('em_afiacao')).toBe('20');
    expect(mapearStatusEtapa('controle_qualidade')).toBe('20');
  });

  it('status de saída → etapa 30 (Aguardando faturamento)', () => {
    expect(mapearStatusEtapa('pronto_entrega')).toBe('30');
    expect(mapearStatusEtapa('em_rota')).toBe('30');
  });

  it('entregue → null (mantém a OS como está, founder é dono do faturamento)', () => {
    expect(mapearStatusEtapa('entregue')).toBeNull();
  });

  it('status desconhecido/vazio → null (fail-safe, não sincroniza)', () => {
    expect(mapearStatusEtapa('qualquer_coisa')).toBeNull();
    expect(mapearStatusEtapa('')).toBeNull();
    expect(mapearStatusEtapa('rascunho')).toBeNull();
  });
});

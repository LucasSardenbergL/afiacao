import { describe, it, expect } from 'vitest';
import { pedidoPrecisaAtencao } from '../shared';
import type { StatusEnvioPortal } from '../types';

const mk = (status: string, portal: StatusEnvioPortal | null | undefined = null) => ({
  status,
  status_envio_portal: portal,
});

describe('pedidoPrecisaAtencao (Fase 3 · 3c)', () => {
  it('status=falha_envio → precisa de atenção (Omie falhou)', () => {
    expect(pedidoPrecisaAtencao(mk('falha_envio'))).toBe(true);
    // falha_envio entra mesmo sem nada de portal
    expect(pedidoPrecisaAtencao(mk('falha_envio', 'nao_aplicavel'))).toBe(true);
  });

  it('estados de conciliação do portal → precisam de atenção', () => {
    expect(pedidoPrecisaAtencao(mk('disparado', 'aceito_portal_sem_protocolo'))).toBe(true);
    expect(pedidoPrecisaAtencao(mk('disparado', 'indeterminado_requer_conciliacao'))).toBe(true);
  });

  it('falhas duras do portal → precisam de atenção', () => {
    expect(pedidoPrecisaAtencao(mk('disparado', 'falha_envio_portal'))).toBe(true);
    expect(pedidoPrecisaAtencao(mk('disparado', 'erro_nao_retentavel'))).toBe(true);
  });

  it('estados auto-drenados/auto-retentados NÃO entram (anti-falso-flag)', () => {
    // pendente/enviando: motor de retry + Sentinela cuidam; pedido em voo
    expect(pedidoPrecisaAtencao(mk('aprovado_aguardando_disparo', 'pendente_envio_portal'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('aprovado_aguardando_disparo', 'enviando_portal'))).toBe(false);
    // erro_retentavel: o sayerlack-retry-orfaos re-tenta sozinho
    expect(pedidoPrecisaAtencao(mk('disparado', 'erro_retentavel'))).toBe(false);
  });

  it('sucesso / em-trânsito / nao_aplicavel → não precisam de atenção', () => {
    expect(pedidoPrecisaAtencao(mk('disparado', 'sucesso_portal'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('disparado', 'enviado_portal'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('disparado', 'nao_aplicavel'))).toBe(false);
  });

  it('null/undefined em status_envio_portal → trata como nao_aplicavel', () => {
    expect(pedidoPrecisaAtencao(mk('disparado', null))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('disparado', undefined))).toBe(false);
  });

  it('status normais sem portal pendente → não precisam de atenção', () => {
    expect(pedidoPrecisaAtencao(mk('pendente_aprovacao'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('aprovado_aguardando_disparo'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('disparado'))).toBe(false);
    expect(pedidoPrecisaAtencao(mk('cancelado'))).toBe(false);
  });
});

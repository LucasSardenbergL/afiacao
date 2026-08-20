import { describe, it, expect } from 'vitest';
import {
  classificarPosLogin,
  decidirAlertaPortal,
  type SinaisPosLogin,
} from '../sayerlack-pos-login';

// Incidente 2026-08-20 (pedido 1939, 3 falhas: 10:19 / 10:45 / 11:15 UTC).
// A heurística `url_changed` deu falso positivo de login: o portal redirecionou
// para fora do dashboard e o trace seguiu para `clicked_vendas` com
// {clicked:false, found_links:0} → "Waiting failed: 3000ms exceeded" → EXCEPTION.
// Com EXCEPTION nenhum `fornecedor_alerta` era inserido (só LOGIN_FAILED insere),
// então a causa real não chegou a ninguém por ~1h.

const BASE: SinaisPosLogin = {
  url: 'http://portal.sayerlack.com.br:9092/home',
  origemEsperada: 'http://portal.sayerlack.com.br:9092',
  menuLinks: 12,
  camposSenha: 0,
  titulo: 'Portal Sayerlack',
  texto: 'Pedidos / Propostas Vendas Financeiro',
};

const sinais = (over: Partial<SinaisPosLogin>): SinaisPosLogin => ({ ...BASE, ...over });

describe('classificarPosLogin — sinal POSITIVO de dashboard', () => {
  it('menu lateral com links = dashboard (o fluxo segue como hoje)', () => {
    const r = classificarPosLogin(BASE);
    expect(r.tipo).toBe('dashboard');
    expect(r.erroTipo).toBeNull();
  });

  it('menu presente VENCE texto de senha — não fabrica diagnóstico com o fluxo sadio', () => {
    // Um dropdown de usuário com "Alterar senha" é normal no dashboard.
    const r = classificarPosLogin(sinais({ texto: 'Meu perfil Alterar senha Sair' }));
    expect(r.tipo).toBe('dashboard');
  });
});

describe('classificarPosLogin — tela de troca de senha (sinal positivo)', () => {
  it('texto explícito de senha expirada', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, texto: 'Sua senha expirou. Informe a nova senha para continuar.' }),
    );
    expect(r.tipo).toBe('troca_de_senha');
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('normaliza acento e caixa — "TROCA DE SENHA OBRIGATÓRIA"', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, texto: 'TROCA DE SENHA OBRIGATÓRIA' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('dois campos de senha pós-login (nova + confirmação) bastam, sem texto', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, camposSenha: 2, texto: '' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('URL de troca de senha basta', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, url: 'http://portal.sayerlack.com.br:9092/alterar-senha', texto: '' }),
    );
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('inglês (change password) também é sinal', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, texto: 'Your password has expired' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });
});

describe('classificarPosLogin — degradação honesta: ausente ≠ troca de senha', () => {
  it('o incidente real (matriz/dts, sem menu, sem texto) NÃO vira diagnóstico inventado', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, url: 'https://matriz.sayerlack.com.br/dts/', texto: '' }),
    );
    expect(r.tipo).toBe('desconhecido');
    expect(r.erroTipo).toBe('POS_LOGIN_NAO_DASHBOARD');
    // O fato objetivo que o portal entregou: saiu da origem configurada.
    expect(r.origemDivergente).toBe(true);
    expect(r.motivo).toContain('matriz.sayerlack.com.br');
  });

  it('UM campo de senha isolado é sinal fraco → desconhecido, não troca de senha', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, camposSenha: 1, texto: '' }));
    expect(r.erroTipo).toBe('POS_LOGIN_NAO_DASHBOARD');
  });

  it('mesma origem não acusa divergência', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, url: 'http://portal.sayerlack.com.br:9092/qualquer', texto: '' }),
    );
    expect(r.origemDivergente).toBe(false);
  });

  it('origemEsperada ausente/ilegível não fabrica divergência', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, origemEsperada: null, texto: '' }));
    expect(r.origemDivergente).toBe(false);
  });
});

describe('decidirAlertaPortal — o alerta que faltou no incidente', () => {
  it('PASSWORD_CHANGE_REQUIRED alerta na PRIMEIRA falha (retentar não resolve)', () => {
    const a = decidirAlertaPortal('PASSWORD_CHANGE_REQUIRED', { esgotado: false, portalUrl: 'http://p' });
    expect(a).not.toBeNull();
    expect(a!.severidade).toBe('urgente');
    expect(a!.titulo).toContain('senha');
    expect(a!.mensagem).toContain('SAYERLACK_PORTAL_PASS');
  });

  it('LOGIN_FAILED mantém o alerta que já existia', () => {
    const a = decidirAlertaPortal('LOGIN_FAILED', { esgotado: false, portalUrl: 'http://p' });
    expect(a).not.toBeNull();
    expect(a!.severidade).toBe('urgente');
  });

  it('POS_LOGIN_NAO_DASHBOARD só alerta ao ESGOTAR — causa desconhecida pode ser transitória', () => {
    expect(decidirAlertaPortal('POS_LOGIN_NAO_DASHBOARD', { esgotado: false, portalUrl: 'http://p' })).toBeNull();
    const a = decidirAlertaPortal('POS_LOGIN_NAO_DASHBOARD', { esgotado: true, portalUrl: 'http://p' });
    expect(a).not.toBeNull();
    expect(a!.titulo).toContain('Sayerlack');
  });

  it('erroTipo sem alerta definido não inventa alerta', () => {
    expect(decidirAlertaPortal('SKU_NOT_FOUND', { esgotado: true, portalUrl: 'http://p' })).toBeNull();
    expect(decidirAlertaPortal(null, { esgotado: true, portalUrl: 'http://p' })).toBeNull();
  });

  it('a mensagem carrega o portalUrl para o founder saber ONDE agir', () => {
    const a = decidirAlertaPortal('PASSWORD_CHANGE_REQUIRED', {
      esgotado: false,
      portalUrl: 'http://portal.sayerlack.com.br:9092',
    });
    expect(a!.mensagem).toContain('portal.sayerlack.com.br:9092');
  });
});

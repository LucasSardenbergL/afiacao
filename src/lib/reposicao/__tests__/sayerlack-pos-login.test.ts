import { describe, it, expect } from 'vitest';
import {
  classificarPosLogin,
  decidirAlertaPortal,
  ehFalhaSistemicaDoPortal,
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

  it('menu presente VENCE texto FRACO de senha — não fabrica diagnóstico com o fluxo sadio', () => {
    // Um dropdown de usuário com "Alterar senha" é normal no dashboard.
    const r = classificarPosLogin(sinais({ texto: 'Meu perfil Alterar senha Sair' }));
    expect(r.tipo).toBe('dashboard');
  });

  // Codex challenge 2026-08-20 (P1): o menu NÃO pode vencer cegamente. Menu stale de uma
  // SPA, ou nós de sidebar que sobrevivem ao redirect, esconderiam uma troca de senha REAL
  // e o pedido morreria de novo como EXCEPTION anônima — o bug original de volta.
  it('CONFLITO: formulário de senha completo vence o menu (menu stale não esconde troca real)', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 12, camposSenha: 2, texto: '' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(r.conflitoDeSinais).toBe(true);
  });

  it('CONFLITO: termo FORTE de expiração vence o menu', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 12, texto: 'Sua senha expirou' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(r.conflitoDeSinais).toBe(true);
  });

  it('sem conflito, o dashboard normal não é marcado como conflituoso', () => {
    expect(classificarPosLogin(BASE).conflitoDeSinais).toBe(false);
  });
});

// Codex challenge 2026-08-20 (P1): "alterar senha"/"nova senha"/"primeiro acesso" sozinhos
// são FRACOS. Basta o portal renomear a classe `.menu-link` (drift de seletor) para o
// dashboard saudável virar `menuLinks:0` + "Alterar senha" no dropdown → PASSWORD_CHANGE_REQUIRED
// → erro NÃO-RETENTÁVEL + alerta urgente → pedido bom travado e senha trocada à toa.
describe('classificarPosLogin — termo FRACO exige corroboração', () => {
  it('"Alterar senha" sem menu e SEM campo de senha não basta', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, camposSenha: 0, texto: 'Meu perfil Alterar senha Sair' }),
    );
    expect(r.erroTipo).toBe('POS_LOGIN_NAO_DASHBOARD');
  });

  it('"Alterar senha" + UM campo de senha já corrobora', () => {
    const r = classificarPosLogin(
      sinais({ menuLinks: 0, camposSenha: 1, texto: 'Alterar senha' }),
    );
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('termo FORTE dispensa corroboração — "senha expirada" é inequívoco', () => {
    const r = classificarPosLogin(sinais({ menuLinks: 0, camposSenha: 0, texto: 'Senha expirada' }));
    expect(r.erroTipo).toBe('PASSWORD_CHANGE_REQUIRED');
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

  // Codex challenge 2026-08-20 (P1): o fix cobria a INSTÂNCIA, não a classe. Se a SPA
  // trocar o DOM depois do gate, a navegação morre como EXCEPTION, esgota e — sem isto —
  // volta a ser silêncio. Alerta genérico ao ESGOTAR qualquer falha pré-submit fecha a
  // classe: o tipo conhecido só melhora o TEXTO, nunca decide se avisa.
  it('EXCEPTION ao esgotar ALERTA — era o silêncio que reabria o incidente', () => {
    expect(decidirAlertaPortal('EXCEPTION', { esgotado: false, portalUrl: 'http://p' })).toBeNull();
    const a = decidirAlertaPortal('EXCEPTION', { esgotado: true, portalUrl: 'http://p' });
    expect(a).not.toBeNull();
    expect(a!.mensagem).toContain('EXCEPTION');
  });

  it('erroTipo desconhecido/ausente ao esgotar também alerta (nunca cala por não ter rótulo)', () => {
    expect(decidirAlertaPortal(null, { esgotado: true, portalUrl: 'http://p' })).not.toBeNull();
    expect(decidirAlertaPortal('COISA_NOVA', { esgotado: true, portalUrl: 'http://p' })).not.toBeNull();
  });

  it('antes de esgotar, tipo desconhecido segue calado (retentativa é o caminho normal)', () => {
    expect(decidirAlertaPortal('EXCEPTION', { esgotado: false, portalUrl: 'http://p' })).toBeNull();
    expect(decidirAlertaPortal(null, { esgotado: false, portalUrl: 'http://p' })).toBeNull();
  });

  it('origem divergente alerta na PRIMEIRA falha — 40+ sucessos na origem antiga são o denominador', () => {
    const a = decidirAlertaPortal('POS_LOGIN_NAO_DASHBOARD', {
      esgotado: false,
      portalUrl: 'http://portal.sayerlack.com.br:9092',
      origemDivergente: true,
    });
    expect(a).not.toBeNull();
    expect(a!.mensagem).toContain('outro endereço');
  });

  it('a mensagem carrega o portalUrl para o founder saber ONDE agir', () => {
    const a = decidirAlertaPortal('PASSWORD_CHANGE_REQUIRED', {
      esgotado: false,
      portalUrl: 'http://portal.sayerlack.com.br:9092',
    });
    expect(a!.mensagem).toContain('portal.sayerlack.com.br:9092');
  });
});

// Codex challenge 2026-08-20 (P1): antes deste PR, um portal com senha vencida gastava os 5
// pedidos do lote e eles voltavam RETENTÁVEIS. Marcar PASSWORD_CHANGE_REQUIRED como
// pré-submit tornaria os 5 NÃO-retentáveis de uma vez — a correção pioraria o lote se não
// parasse no primeiro.
describe('ehFalhaSistemicaDoPortal — circuit breaker do lote', () => {
  it('falha de credencial/senha vale para todos os pedidos → interrompe', () => {
    expect(ehFalhaSistemicaDoPortal('PASSWORD_CHANGE_REQUIRED')).toBe(true);
    expect(ehFalhaSistemicaDoPortal('LOGIN_FAILED')).toBe(true);
  });

  it('falha do PEDIDO não interrompe o lote — suprimiria compra boa', () => {
    expect(ehFalhaSistemicaDoPortal('SKU_NOT_FOUND')).toBe(false);
    expect(ehFalhaSistemicaDoPortal('CLIENTE_NOT_FOUND')).toBe(false);
    expect(ehFalhaSistemicaDoPortal('GRUPO_LEADTIME_MISMATCH')).toBe(false);
  });

  it('causa desconhecida NÃO interrompe: pode ser transitória de um pedido só', () => {
    expect(ehFalhaSistemicaDoPortal('POS_LOGIN_NAO_DASHBOARD')).toBe(false);
    expect(ehFalhaSistemicaDoPortal('EXCEPTION')).toBe(false);
    expect(ehFalhaSistemicaDoPortal(null)).toBe(false);
    expect(ehFalhaSistemicaDoPortal(undefined)).toBe(false);
  });
});

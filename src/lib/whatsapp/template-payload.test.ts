import { describe, expect, it } from 'vitest';
import {
  buildTemplatePayload,
  renderTemplatePreview,
  sanitizeTemplateParam,
  validateBodyParams,
} from './template-payload';

describe('sanitizeTemplateParam', () => {
  it('troca newlines/tabs por vírgula-espaço e colapsa espaços (Meta rejeita \\n/\\t/4+ espaços)', () => {
    expect(sanitizeTemplateParam('3× Lixa 80\n2× Verniz PU\n1× Thinner')).toBe(
      '3× Lixa 80, 2× Verniz PU, 1× Thinner',
    );
    expect(sanitizeTemplateParam('a\tb')).toBe('a b');
    expect(sanitizeTemplateParam('a     b')).toBe('a b');
    expect(sanitizeTemplateParam('  x  ')).toBe('x');
  });
  it('CRLF não vira vírgula dupla', () => {
    expect(sanitizeTemplateParam('a\r\nb')).toBe('a, b');
  });
});

describe('validateBodyParams', () => {
  it('null quando contagem bate e nenhum param é vazio', () => {
    expect(validateBodyParams(['João', 'amanhã'], 2)).toBeNull();
  });
  it('erro quando contagem diverge do template', () => {
    expect(validateBodyParams(['só um'], 2)).toMatch(/2 parâmetro/);
  });
  it('erro quando um param fica vazio pós-sanitize', () => {
    expect(validateBodyParams(['João', '   '], 2)).toMatch(/vazio/);
  });
});

describe('buildTemplatePayload', () => {
  it('monta o payload Cloud API com components de body', () => {
    expect(
      buildTemplatePayload({
        to: '5537999990000',
        templateName: 'colacor_status_pedido',
        bodyParams: ['João', '123'],
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      to: '5537999990000',
      type: 'template',
      template: {
        name: 'colacor_status_pedido',
        language: { code: 'pt_BR' },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'João' },
              { type: 'text', text: '123' },
            ],
          },
        ],
      },
    });
  });
  it('omite components quando não há params', () => {
    const p = buildTemplatePayload({ to: '55', templateName: 't', bodyParams: [] }) as {
      template: Record<string, unknown>;
    };
    expect('components' in p.template).toBe(false);
  });
});

describe('renderTemplatePreview', () => {
  it('substitui {{1}}..{{n}} pelos params (preview legível pro inbox)', () => {
    expect(
      renderTemplatePreview('Olá, {{1}}! Pedido {{2}}: {{3}}.', ['Ana', '42', 'sai amanhã']),
    ).toBe('Olá, Ana! Pedido 42: sai amanhã.');
  });
  it('placeholder sem param correspondente permanece visível (sinal de erro, não texto fabricado)', () => {
    expect(renderTemplatePreview('Oi {{1}} e {{2}}', ['Ana'])).toBe('Oi Ana e {{2}}');
  });
});

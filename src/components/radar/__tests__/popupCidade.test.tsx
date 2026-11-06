import { describe, expect, it, vi } from 'vitest';
import { popupCidade } from '../popupCidade';

// C6 (pacote C): o 1º toque no pino abre este popup; só o botão leva à fila da cidade.
describe('popupCidade', () => {
  it('mostra o resumo e a ação explícita; só o clique no botão chama onVer', () => {
    const onVer = vi.fn();
    const el = popupCidade('SANTA LUZIA/MG', ['12 empresas · 3 c/ telefone', '9 a contatar'], onVer);
    expect(el.textContent).toContain('SANTA LUZIA/MG');
    expect(el.textContent).toContain('9 a contatar');
    el.click(); // clicar no popup (fora do botão) não navega
    expect(onVer).not.toHaveBeenCalled();
    const botao = el.querySelector('button');
    expect(botao?.textContent).toBe('Ver empresas desta cidade');
    botao?.click();
    expect(onVer).toHaveBeenCalledTimes(1);
  });

  it('texto do município entra como TEXTO, nunca como HTML', () => {
    const el = popupCidade('<img src=x onerror=alert(1)>/MG', ['<b>x</b>'], () => {});
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>/MG');
  });
});

import { useEffect, type RefObject } from 'react';
// Uma barra por rota (só o Novo Pedido publica): a variável é global, não empilha.

/**
 * Painel × barra de envio (P2 do Codex no #4086): o HUD da ligação é `fixed` no rodapé e, num
 * celular de 360px, cobria o total e o Enviar do Novo Pedido. Os dois ficam visíveis: a barra
 * publica a própria altura (já com a área segura) em `--rodape-fixo` no <html>, e os painéis
 * flutuantes do rodapé sobem por ela (`bottom: calc(Xrem + var(--rodape-fixo, …))`).
 * Sem barra montada a variável some e os painéis voltam ao lugar.
 */
export const VAR_RODAPE_FIXO = '--rodape-fixo';

export function publicarRodape(raiz: HTMLElement, alturaPx: number | null): void {
  if (alturaPx === null || !(alturaPx > 0)) raiz.style.removeProperty(VAR_RODAPE_FIXO);
  else raiz.style.setProperty(VAR_RODAPE_FIXO, `${Math.ceil(alturaPx)}px`);
}

/**
 * Quanto do rodapé a barra ocupa: do TOPO dela ao fim da tela. Não é só a altura — no fim da
 * rolagem a barra sai do `sticky` e sobe pelo padding da página, e o painel tem de subir junto
 * (Codex P2). Barra fora da tela (abaixo) não reserva nada.
 */
export function reservaDaBarra(topoPx: number, alturaViewportPx: number): number | null {
  if (!Number.isFinite(topoPx) || !Number.isFinite(alturaViewportPx)) return null;
  const reserva = alturaViewportPx - topoPx;
  return reserva > 0 ? reserva : null;
}

export function useReservaRodape(ref: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const raiz = document.documentElement;
    let quadro = 0;
    const medir = () => {
      quadro = 0;
      publicarRodape(raiz, reservaDaBarra(el.getBoundingClientRect().top, window.innerHeight));
    };
    const agendar = () => { if (!quadro) quadro = requestAnimationFrame(medir); };
    medir();
    const obs = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(agendar);
    obs?.observe(el);
    window.addEventListener('scroll', agendar, { passive: true });
    window.addEventListener('resize', agendar);
    return () => {
      obs?.disconnect();
      window.removeEventListener('scroll', agendar);
      window.removeEventListener('resize', agendar);
      if (quadro) cancelAnimationFrame(quadro);
      publicarRodape(raiz, null);
    };
  }, [ref]);
}

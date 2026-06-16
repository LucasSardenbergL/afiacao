const KEY = 'picking_view';

/** True quando o usuário forçou a versão completa (desktop) num dispositivo touch. */
export function getForceFullPref(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'full';
  } catch {
    return false;
  }
}

export function setForceFull(force: boolean): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (force) localStorage.setItem(KEY, 'full');
    else localStorage.removeItem(KEY);
  } catch {
    // quota/privacy — ignora
  }
}

/** Decisão pura: separador touch sem preferência forçada → vai pra visão de chão. */
export function shouldRedirectToMobile(opts: { isTouch: boolean; forceFull: boolean }): boolean {
  return opts.isTouch && !opts.forceFull;
}

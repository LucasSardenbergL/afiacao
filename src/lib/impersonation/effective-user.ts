import type { ImpersonationTarget } from './types';

export function resolveEffectiveUserId(realUserId: string | null, target: ImpersonationTarget | null): string | null {
  return target?.id ?? realUserId;
}

const KEY = 'impersonation.target';
export function loadPersistedTarget(): ImpersonationTarget | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ImpersonationTarget) : null;
  } catch { return null; }
}
export function persistTarget(t: ImpersonationTarget | null): void {
  try {
    if (t) sessionStorage.setItem(KEY, JSON.stringify(t));
    else sessionStorage.removeItem(KEY);
  } catch { /* sessionStorage indisponível: degrada pra in-memory */ }
}

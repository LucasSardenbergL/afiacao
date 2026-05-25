import { describe, it, expect, beforeEach } from 'vitest';
import { shouldRedirectToMobile, getForceFullPref, setForceFull } from '../view-pref';

beforeEach(() => localStorage.clear());

describe('shouldRedirectToMobile', () => {
  it('touch sem override → redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: true, forceFull: false })).toBe(true);
  });
  it('touch com override → NÃO redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: true, forceFull: true })).toBe(false);
  });
  it('não-touch → NÃO redireciona', () => {
    expect(shouldRedirectToMobile({ isTouch: false, forceFull: false })).toBe(false);
  });
});

describe('getForceFullPref / setForceFull', () => {
  it('default é false', () => {
    expect(getForceFullPref()).toBe(false);
  });
  it('setForceFull(true) persiste', () => {
    setForceFull(true);
    expect(getForceFullPref()).toBe(true);
  });
  it('setForceFull(false) limpa', () => {
    setForceFull(true);
    setForceFull(false);
    expect(getForceFullPref()).toBe(false);
  });
});

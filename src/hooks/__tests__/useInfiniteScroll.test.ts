import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInfiniteScroll } from '../useInfiniteScroll';

// Mock de IntersectionObserver (jsdom não implementa) — captura instâncias e
// deixa simular interseção / inspecionar observe/disconnect.
class MockIO {
  static instances: MockIO[] = [];
  cb: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    MockIO.instances.push(this);
  }
  observe(el: Element) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  unobserve() {}
  takeRecords() { return []; }
  // simula o sentinel entrando/saindo da viewport
  trigger(isIntersecting: boolean) {
    this.cb([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  // o último observer ainda "vivo" (não desconectado) que observa algo
  static live() { return MockIO.instances.filter((i) => !i.disconnected && i.observed.length); }
}

beforeEach(() => {
  MockIO.instances = [];
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useInfiniteScroll', () => {
  it('dispara onLoadMore quando o sentinel intersecta', () => {
    const onLoadMore = vi.fn();
    const { result } = renderHook(() => useInfiniteScroll(onLoadMore, true));
    const node = document.createElement('div');
    act(() => result.current(node));
    const io = MockIO.live().at(-1)!;
    expect(io.observed[0]).toBe(node);
    act(() => io.trigger(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('NÃO dispara quando o sentinel sai da viewport', () => {
    const onLoadMore = vi.fn();
    const { result } = renderHook(() => useInfiniteScroll(onLoadMore, true));
    act(() => result.current(document.createElement('div')));
    act(() => MockIO.live().at(-1)!.trigger(false));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('não cria observer quando enabled=false', () => {
    const onLoadMore = vi.fn();
    const { result } = renderHook(() => useInfiniteScroll(onLoadMore, false));
    act(() => result.current(document.createElement('div')));
    expect(MockIO.live().length).toBe(0);
  });

  // Bug do auto-load "parar": quando o sentinel é re-montado (novo nó), o
  // observer precisa re-vincular ao nó atual — senão o gatilho automático solta.
  it('re-observa quando o sentinel é re-montado (não solta do alvo)', () => {
    const onLoadMore = vi.fn();
    const { result } = renderHook(() => useInfiniteScroll(onLoadMore, true));
    const node1 = document.createElement('div');
    act(() => result.current(node1));
    // sentinel re-monta: React chama a ref com null e depois com o novo nó
    const node2 = document.createElement('div');
    act(() => {
      result.current(null);
      result.current(node2);
    });
    const io = MockIO.live().at(-1)!;
    expect(io.observed.at(-1)).toBe(node2);
    act(() => io.trigger(true));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('usa o onLoadMore mais recente sem recriar o observer a cada render', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useInfiniteScroll(cb, true), {
      initialProps: { cb: cb1 as () => void },
    });
    const node = document.createElement('div');
    act(() => result.current(node));
    const observersAposMount = MockIO.instances.length;
    rerender({ cb: cb2 }); // onLoadMore muda de identidade
    // observer NÃO é recriado só porque o callback mudou
    expect(MockIO.instances.length).toBe(observersAposMount);
    act(() => MockIO.live().at(-1)!.trigger(true));
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1).not.toHaveBeenCalled();
  });
});

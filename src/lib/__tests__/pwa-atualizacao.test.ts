import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics', () => ({ track: trackMock }));

import {
  __resetEstadoAtualizacao,
  acompanharRegistro,
  aplicadorNativo,
  descreverEstadoAtualizacao,
  faseDoIndicador,
  lerBuildDoServidor,
  lerCarimbosDoServidor,
  podeReparar,
  repararApp,
  type FaseAtualizacao,
  obterEstadoAtualizacao,
  verificarAtualizacaoAgora,
  UPDATE_TOAST_ID,
  type EstadoAtualizacao,
} from '@/lib/pwa-atualizacao';

/* ─── Dublês: registro/worker/doc/window mínimos sobre EventTarget (Node) ─── */

class FakeSW extends EventTarget {
  constructor(public state: string = 'installing') {
    super();
  }
  postMessage = vi.fn();
  mudar(state: string) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeReg extends EventTarget {
  active: FakeSW | null = new FakeSW('activated');
  waiting: FakeSW | null = null;
  installing: FakeSW | null = null;
  update = vi.fn(async () => undefined);
  acharUpdate(sw: FakeSW) {
    this.installing = sw;
    this.dispatchEvent(new Event('updatefound'));
  }
}

function montar(opts: { onLine?: boolean; visibility?: DocumentVisibilityState } = {}) {
  let t = 1_000_000;
  const doc = Object.assign(new EventTarget(), { visibilityState: opts.visibility ?? 'visible' });
  let tick: (() => void) | null = null;
  const win = Object.assign(new EventTarget(), {
    setInterval: vi.fn((fn: () => void) => {
      tick = fn;
      return 1;
    }),
    clearInterval: vi.fn(),
  });
  const nav = { onLine: opts.onLine ?? true } as Navigator;
  const reg = new FakeReg();
  const aplicar = vi.fn();
  return {
    reg,
    doc,
    win,
    nav,
    aplicar,
    avancar: (ms: number) => {
      t += ms;
    },
    tick: () => tick?.(),
    armar: () =>
      acompanharRegistro(reg as unknown as ServiceWorkerRegistration, {
        aplicar,
        agora: () => t,
        doc: doc as unknown as Document,
        win: win as unknown as Window,
        nav,
        intervaloMs: 30 * 60_000,
        minEntreChecagensMs: 5 * 60_000,
      }),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const toastsDeUpdate = () => toastMock.mock.calls.filter((c) => c[1]?.id === UPDATE_TOAST_ID);
const voltarProApp = (doc: EventTarget) => doc.dispatchEvent(new Event('visibilitychange'));

beforeEach(() => {
  toastMock.mockReset();
  trackMock.mockReset();
  __resetEstadoAtualizacao('index-ATUAL123');
});

describe('checagem ativa de update (o buraco do iPhone: ninguém chamava registration.update)', () => {
  it('reconsulta o servidor ao VOLTAR pro app (resumo no iOS não é navegação)', async () => {
    const h = montar();
    h.armar();
    h.avancar(6 * 60_000);
    voltarProApp(h.doc);
    await flush();
    expect(h.reg.update).toHaveBeenCalledTimes(1);
  });

  it('throttle: voltar várias vezes em < 5 min não martela o /sw.js', async () => {
    const h = montar();
    h.armar();
    h.avancar(60_000);
    voltarProApp(h.doc);
    await flush();
    expect(h.reg.update).not.toHaveBeenCalled();
  });

  it('checa a cada intervalo enquanto VISÍVEL — e não checa com o app em segundo plano', async () => {
    const h = montar();
    h.armar();
    h.avancar(30 * 60_000);
    h.tick();
    await flush();
    expect(h.reg.update).toHaveBeenCalledTimes(1);

    h.doc.visibilityState = 'hidden';
    h.avancar(30 * 60_000);
    h.tick();
    await flush();
    expect(h.reg.update).toHaveBeenCalledTimes(1);
  });

  it("'online' força a checagem (ignora o throttle)", async () => {
    const h = montar();
    h.armar();
    h.win.dispatchEvent(new Event('online'));
    await flush();
    expect(h.reg.update).toHaveBeenCalledTimes(1);
  });

  it('offline não chama update (rejeitaria) e não inventa fase', async () => {
    const h = montar({ onLine: false });
    h.armar();
    h.avancar(6 * 60_000);
    voltarProApp(h.doc);
    await flush();
    expect(h.reg.update).not.toHaveBeenCalled();
    expect(obterEstadoAtualizacao().fase).toBe('em_dia');
  });

  it('update() que rejeita (rede) volta à fase derivada — nem "falhou", nem trava em "verificando"', async () => {
    const h = montar();
    h.reg.update.mockRejectedValueOnce(new Error('network'));
    h.armar();
    await verificarAtualizacaoAgora();
    expect(obterEstadoAtualizacao().fase).toBe('em_dia');
  });
});

describe('o aviso aparece — e REAPARECE (modo prompt preservado: nada recarrega sozinho)', () => {
  it('SW já em waiting no boot → fase pronta + toast com "Atualizar"; só o clique aplica', () => {
    const h = montar();
    h.reg.waiting = new FakeSW('installed');
    h.armar();
    expect(obterEstadoAtualizacao().fase).toBe('pronta');
    const chamadas = toastsDeUpdate();
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0][1].duration).toBe(Infinity);
    expect(h.aplicar).not.toHaveBeenCalled(); // prompt: nada de reload-surpresa
    chamadas[0][1].action.onClick();
    expect(h.aplicar).toHaveBeenCalledTimes(1);
  });

  it('toast dispensado REABRE ao voltar pro app (antes: só no evento online)', () => {
    const h = montar();
    h.reg.waiting = new FakeSW('installed');
    h.armar();
    voltarProApp(h.doc);
    expect(toastsDeUpdate()).toHaveLength(2);
  });

  it('offline segura o toast; ao ficar online ele aparece', () => {
    const h = montar({ onLine: false });
    h.reg.waiting = new FakeSW('installed');
    h.armar();
    expect(toastsDeUpdate()).toHaveLength(0);
    (h.nav as { onLine: boolean }).onLine = true;
    h.win.dispatchEvent(new Event('online'));
    expect(toastsDeUpdate()).toHaveLength(1);
  });

  it('update achado em sessão → baixando → installed → pronta + toast', () => {
    const h = montar();
    h.armar();
    const novo = new FakeSW('installing');
    h.reg.acharUpdate(novo);
    expect(obterEstadoAtualizacao().fase).toBe('baixando');
    h.reg.installing = null;
    h.reg.waiting = novo;
    novo.mudar('installed');
    expect(obterEstadoAtualizacao().fase).toBe('pronta');
    expect(toastsDeUpdate()).toHaveLength(1);
    expect(trackMock).toHaveBeenCalledWith('pwa.atualizacao', { fase: 'baixando' });
    expect(trackMock).toHaveBeenCalledWith('pwa.atualizacao', { fase: 'pronta' });
  });

  it('primeira instalação (sem SW ativo) não vira "atualização"', () => {
    const h = montar();
    h.reg.active = null;
    h.armar();
    h.reg.acharUpdate(new FakeSW('installing'));
    expect(obterEstadoAtualizacao().fase).toBe('em_dia');
    expect(toastsDeUpdate()).toHaveLength(0);
  });
});

describe('install que morre deixa de ser silencioso', () => {
  it('redundant antes de installed (asset 404 pós-Publish) → falhou + evento', () => {
    const h = montar();
    h.armar();
    const novo = new FakeSW('installing');
    h.reg.acharUpdate(novo);
    h.reg.installing = null;
    novo.mudar('redundant');
    expect(obterEstadoAtualizacao().fase).toBe('falhou');
    expect(trackMock).toHaveBeenCalledWith('pwa.atualizacao', { fase: 'falhou' });
  });

  it('se já havia versão em waiting, o install novo morrer não apaga o "pronta"', () => {
    const h = montar();
    h.reg.waiting = new FakeSW('installed');
    h.armar();
    const novo = new FakeSW('installing');
    h.reg.acharUpdate(novo);
    novo.mudar('redundant');
    expect(obterEstadoAtualizacao().fase).toBe('pronta');
  });

  it('desarmar remove ouvintes e o intervalo', async () => {
    const h = montar();
    const desarmar = h.armar();
    desarmar();
    h.avancar(6 * 60_000);
    voltarProApp(h.doc);
    await flush();
    expect(h.reg.update).not.toHaveBeenCalled();
    expect(h.win.clearInterval).toHaveBeenCalledWith(1);
  });
});

describe('aplicadorNativo (fallback do main.tsx, sem workbox-window)', () => {
  it('posta SKIP_WAITING ao SW em waiting e recarrega só no controllerchange', () => {
    const reg = new FakeReg();
    const waiting = new FakeSW('installed');
    reg.waiting = waiting;
    const container = new EventTarget();
    const recarregar = vi.fn();
    aplicadorNativo(
      reg as unknown as ServiceWorkerRegistration,
      container as unknown as ServiceWorkerContainer,
      recarregar,
    )();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(recarregar).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it('sem SW em waiting é no-op', () => {
    const reg = new FakeReg();
    const recarregar = vi.fn();
    aplicadorNativo(reg as unknown as ServiceWorkerRegistration, new EventTarget() as unknown as ServiceWorkerContainer, recarregar)();
    expect(recarregar).not.toHaveBeenCalled();
  });
});

describe('em que build estou (menu do usuário)', () => {
  const base: EstadoAtualizacao = {
    fase: 'em_dia',
    buildId: 'index-92kmkUxx',
    buildServidor: null,
    buildEm: null,
    buildServidorEm: null,
    ultimaVerificacaoEm: null,
  };

  it('mostra o hash curto, no mesmo eixo do build_id/telemetria_probes', () => {
    expect(descreverEstadoAtualizacao(base)).toEqual({ build: '92kmkUxx', situacao: 'em dia' });
  });

  it('"em dia" com o servidor em outro build vira "desatualizado" — nunca mente', () => {
    expect(descreverEstadoAtualizacao({ ...base, buildServidor: 'index-DHn6ISaE' }).situacao).toBe(
      'desatualizado (servidor: DHn6ISaE)',
    );
  });

  it('servidor desconhecido (null) não é "igual"', () => {
    expect(descreverEstadoAtualizacao({ ...base, fase: 'pronta' }).situacao).toBe('nova versão pronta');
  });
});

describe('lerBuildDoServidor', () => {
  it('lê o entry do HTML do servidor, fora do precache (URL única + no-store)', async () => {
    const f = vi.fn(async () => new Response('<script type="module" src="/assets/index-DHn6ISaE.js"></script>'));
    expect(await lerBuildDoServidor(f as unknown as typeof fetch)).toBe('index-DHn6ISaE');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^\/\?versao=\d+$/);
    expect(init.cache).toBe('no-store');
  });

  it('falha de rede, HTTP != 2xx ou HTML sem entry → null (ausência de dado)', async () => {
    const rejeita = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await lerBuildDoServidor(rejeita as unknown as typeof fetch)).toBeNull();
    const erro = vi.fn(async () => new Response('x', { status: 503 }));
    expect(await lerBuildDoServidor(erro as unknown as typeof fetch)).toBeNull();
    const semEntry = vi.fn(async () => new Response('<html></html>'));
    expect(await lerBuildDoServidor(semEntry as unknown as typeof fetch)).toBeNull();
  });
});

const HTML_SERVIDOR =
  '<meta name="app-build-em" content="2026-10-17T15:00:00.000Z">' +
  '<script type="module" src="/assets/index-DHn6ISaE.js"></script>';

describe('lerCarimbosDoServidor (build_id + carimbo ordenável, do MESMO HTML)', () => {
  it('lê os dois; o build_id segue idêntico ao de lerBuildDoServidor', async () => {
    const f = vi.fn(async () => new Response(HTML_SERVIDOR));
    expect(await lerCarimbosDoServidor(f as unknown as typeof fetch)).toEqual({
      buildId: 'index-DHn6ISaE',
      buildEm: '2026-10-17T15:00:00.000Z',
    });
    expect(await lerBuildDoServidor(f as unknown as typeof fetch)).toBe('index-DHn6ISaE');
  });

  it('HTML sem carimbo (build anterior a ele) → buildEm null, build_id preservado', async () => {
    const f = vi.fn(async () => new Response('<script type="module" src="/assets/index-DHn6ISaE.js"></script>'));
    expect(await lerCarimbosDoServidor(f as unknown as typeof fetch)).toEqual({ buildId: 'index-DHn6ISaE', buildEm: null });
  });

  it('verificarAtualizacaoAgora grava o carimbo do servidor no estado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML_SERVIDOR)));
    try {
      await verificarAtualizacaoAgora();
      expect(obterEstadoAtualizacao().buildServidorEm).toBe('2026-10-17T15:00:00.000Z');
      expect(obterEstadoAtualizacao().buildServidor).toBe('index-DHn6ISaE');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('indicador do topbar: some no estado normal', () => {
  const TODAS: FaseAtualizacao[] = ['inativo', 'em_dia', 'verificando', 'baixando', 'pronta', 'falhou'];
  it('só baixando e pronta aparecem', () => {
    const visiveis = TODAS.filter((f) => faseDoIndicador(f) !== null);
    expect(visiveis).toEqual(['baixando', 'pronta']);
    expect(faseDoIndicador('baixando')).toBe('baixando');
    expect(faseDoIndicador('pronta')).toBe('pronta');
  });
});

describe('Reparar app (fase falhou)', () => {
  function chegarEmFalhou() {
    const h = montar();
    h.armar();
    const novo = new FakeSW('installing');
    h.reg.acharUpdate(novo);
    h.reg.installing = null;
    novo.mudar('redundant');
    expect(obterEstadoAtualizacao().fase).toBe('falhou');
  }
  function dubles() {
    const regs = [{ unregister: vi.fn(async () => true) }, { unregister: vi.fn(async () => true) }];
    const sw = { getRegistrations: vi.fn(async () => regs as unknown as readonly ServiceWorkerRegistration[]) };
    const caches = { keys: vi.fn(async () => ['workbox-precache-v2', 'supabase-api']), delete: vi.fn<(nome: string) => Promise<boolean>>(async () => true) };
    const recarregar = vi.fn();
    return { regs, sw, caches, recarregar };
  }

  it('só oferece em falhou E online', () => {
    expect(podeReparar('falhou', { onLine: true } as Navigator)).toBe(true);
    expect(podeReparar('falhou', { onLine: false } as Navigator)).toBe(false);
    for (const f of ['inativo', 'em_dia', 'verificando', 'baixando', 'pronta'] as FaseAtualizacao[]) {
      expect(podeReparar(f, { onLine: true } as Navigator)).toBe(false);
    }
  });

  it('desregistra TODO SW, apaga TODO cache e recarrega — nessa ordem', async () => {
    chegarEmFalhou();
    const d = dubles();
    const ordem: string[] = [];
    d.regs.forEach((r) => r.unregister.mockImplementation(async () => (ordem.push('unregister'), true)));
    d.caches.delete.mockImplementation(async () => (ordem.push('cache'), true));
    d.recarregar.mockImplementation(() => ordem.push('reload'));
    const fez = await repararApp({ sw: d.sw, caches: d.caches, nav: { onLine: true } as Navigator, recarregar: d.recarregar });
    expect(fez).toBe(true);
    expect(d.caches.delete.mock.calls.map((c) => c[0])).toEqual(['workbox-precache-v2', 'supabase-api']);
    expect(ordem).toEqual(['unregister', 'unregister', 'cache', 'cache', 'reload']);
    expect(trackMock).toHaveBeenCalledWith('pwa.atualizacao', { fase: 'reparo' });
  });

  it('offline: não faz NADA (sem SW e sem cache, o app não abriria)', async () => {
    chegarEmFalhou();
    const d = dubles();
    const fez = await repararApp({ sw: d.sw, caches: d.caches, nav: { onLine: false } as Navigator, recarregar: d.recarregar });
    expect(fez).toBe(false);
    expect(d.sw.getRegistrations).not.toHaveBeenCalled();
    expect(d.caches.delete).not.toHaveBeenCalled();
    expect(d.recarregar).not.toHaveBeenCalled();
  });

  it('fora de falhou: não faz nada', async () => {
    const d = dubles();
    const fez = await repararApp({ sw: d.sw, caches: d.caches, nav: { onLine: true } as Navigator, recarregar: d.recarregar });
    expect(fez).toBe(false);
    expect(d.recarregar).not.toHaveBeenCalled();
  });

  it('um unregister/cache que falha não impede o resto nem o reload', async () => {
    chegarEmFalhou();
    const d = dubles();
    d.regs[0].unregister.mockRejectedValue(new Error('x'));
    d.caches.delete.mockRejectedValueOnce(new Error('y'));
    await repararApp({ sw: d.sw, caches: d.caches, nav: { onLine: true } as Navigator, recarregar: d.recarregar });
    expect(d.regs[1].unregister).toHaveBeenCalled();
    expect(d.caches.delete).toHaveBeenCalledTimes(2);
    expect(d.recarregar).toHaveBeenCalledTimes(1);
  });
});

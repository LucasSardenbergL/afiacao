import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastMock = vi.hoisted(() => vi.fn());
const trackMock = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: toastMock }));
vi.mock('@/lib/analytics', () => ({ track: trackMock }));

import {
  __resetEstadoAtualizacao,
  acompanharRegistro,
  aplicadorPadrao,
  semCamposPreenchidos,
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
import type { EstadoPublicado } from '@/sw/releases';

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

function montar(opts: { onLine?: boolean; visibility?: DocumentVisibilityState; filaVazia?: boolean; telaLimpa?: boolean } = {}) {
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
  const container = Object.assign(new EventTarget(), { controller: null });
  const filaVazia = vi.fn(async () => opts.filaVazia ?? true);
  return {
    reg,
    doc,
    win,
    nav,
    aplicar,
    container,
    filaVazia,
    /** O SW publica seu estado (o que `src/sw/sw.ts` manda às janelas). */
    swPublica: (e: Partial<EstadoPublicado>) => {
      const ev = new Event('message') as Event & { data: unknown };
      ev.data = { type: 'RELEASE_ESTADO', promovida: null, release: null, progresso: null, problema: null, ...e };
      container.dispatchEvent(ev);
    },
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
        container: container as unknown as ServiceWorkerContainer,
        filaVazia,
        telaLimpa: () => opts.telaLimpa ?? true,
        intervaloMs: 30 * 60_000,
        minEntreChecagensMs: 5 * 60_000,
        autoAplicarAposOcultoMs: 30 * 60_000,
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

describe('aplicadorPadrao', () => {
  it('SW ponte (nada em waiting): aplicar = navegar de novo — o HTML promovido vem do SW', () => {
    const reg = new FakeReg();
    const recarregar = vi.fn();
    aplicadorPadrao(reg as unknown as ServiceWorkerRegistration, new EventTarget() as unknown as ServiceWorkerContainer, recarregar)();
    expect(recarregar).toHaveBeenCalledTimes(1);
  });

  it('SW à moda antiga em waiting: posta SKIP_WAITING e recarrega só no controllerchange', () => {
    const reg = new FakeReg();
    const waiting = new FakeSW('installed');
    reg.waiting = waiting;
    const container = new EventTarget();
    const recarregar = vi.fn();
    aplicadorPadrao(reg as unknown as ServiceWorkerRegistration, container as unknown as ServiceWorkerContainer, recarregar)();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(recarregar).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(recarregar).toHaveBeenCalledTimes(1);
  });
});

describe('fase vinda do SW ponte (RELEASE_ESTADO)', () => {
  it('pede o estado ao SW ativo ao armar', () => {
    const h = montar();
    h.armar();
    expect(h.reg.active?.postMessage).toHaveBeenCalledWith({ type: 'ESTADO' });
  });

  it('SW promoveu outro build → pronta + toast; nada recarrega sem clique', () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    expect(obterEstadoAtualizacao().fase).toBe('pronta');
    expect(toastsDeUpdate()).toHaveLength(1);
    expect(h.aplicar).not.toHaveBeenCalled();
  });

  it('SW preparando outro build → baixando; promovida = o meu → em dia', () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-ATUAL123', release: 'index-NOVO999', progresso: { feitos: 10, total: 300 } });
    expect(obterEstadoAtualizacao().fase).toBe('baixando');
    h.swPublica({ promovida: 'index-ATUAL123', release: 'index-ATUAL123' });
    expect(obterEstadoAtualizacao().fase).toBe('em_dia');
  });

  it('quota estourada no preparo → falhou (Reparar app)', () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-ATUAL123', release: 'index-NOVO999', problema: 'quota' });
    expect(obterEstadoAtualizacao().fase).toBe('falhou');
  });

  it('mensagem que não é do SW ponte é ignorada', () => {
    const h = montar();
    h.armar();
    const ev = new Event('message') as Event & { data: unknown };
    ev.data = { type: 'OUTRA', promovida: 'index-X' };
    h.container.dispatchEvent(ev);
    expect(obterEstadoAtualizacao().fase).toBe('em_dia');
  });
});

describe('momento seguro: aplica sozinho só depois de 30 min oculto e com a fila vazia', () => {
  const ocultar = (h: ReturnType<typeof montar>) => {
    h.doc.visibilityState = 'hidden';
    voltarProApp(h.doc);
  };
  const mostrar = (h: ReturnType<typeof montar>) => {
    h.doc.visibilityState = 'visible';
    voltarProApp(h.doc);
  };

  it('pronta + 31 min oculto + fila vazia → aplica, com evento "auto"', async () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    ocultar(h);
    h.avancar(31 * 60_000);
    mostrar(h);
    await flush();
    expect(h.aplicar).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith('pwa.atualizacao', { fase: 'auto' });
  });

  it('oculto só 10 min → NÃO aplica (pode estar no meio do lote); só reavisa', async () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    ocultar(h);
    h.avancar(10 * 60_000);
    mostrar(h);
    await flush();
    expect(h.aplicar).not.toHaveBeenCalled();
    expect(toastsDeUpdate().length).toBeGreaterThanOrEqual(2);
  });

  it('fila offline com pendência → NÃO aplica, mesmo após 2 h oculto', async () => {
    const h = montar({ filaVazia: false });
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    ocultar(h);
    h.avancar(2 * 60 * 60_000);
    mostrar(h);
    await flush();
    expect(h.aplicar).not.toHaveBeenCalled();
  });

  it('campo preenchido na tela (lote digitado, não confirmado) → NÃO aplica', async () => {
    const h = montar({ telaLimpa: false });
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    ocultar(h);
    h.avancar(2 * 60 * 60_000);
    mostrar(h);
    await flush();
    expect(h.aplicar).not.toHaveBeenCalled();
  });

  it('visível o tempo todo → nunca aplica sozinho', async () => {
    const h = montar();
    h.armar();
    h.swPublica({ promovida: 'index-NOVO999', release: 'index-NOVO999' });
    h.avancar(3 * 60 * 60_000);
    h.tick();
    await flush();
    expect(h.aplicar).not.toHaveBeenCalled();
  });

  it('sem versão pronta → voltar após horas não aplica nada', async () => {
    const h = montar();
    h.armar();
    ocultar(h);
    h.avancar(2 * 60 * 60_000);
    mostrar(h);
    await flush();
    expect(h.aplicar).not.toHaveBeenCalled();
  });
});

describe('em que build estou (menu do usuário)', () => {
  const base: EstadoAtualizacao = {
    fase: 'em_dia',
    buildId: 'index-92kmkUxx',
    buildServidor: null,
    buildEm: null,
    buildServidorEm: null,
    commitSha: null,
    commitEm: null,
    commitEmServidor: null,
    ultimaVerificacaoEm: null,
  };

  it('mostra o hash curto, no mesmo eixo do build_id/telemetria_probes', () => {
    expect(descreverEstadoAtualizacao(base)).toEqual({
      versao: '92kmkUxx', build: '92kmkUxx', commit: null, situacao: 'em dia',
    });
  });

  it('a VERSÃO é a data do COMMIT: preview e Publish do mesmo commit (builds e carimbos distintos) leem igual', () => {
    const commitEm = '2026-10-18T19:02:11.000Z';
    const preview = descreverEstadoAtualizacao({
      ...base, buildId: 'index-BIAVBR3F', buildEm: '2026-10-18T19:06:02.000Z', commitSha: '0153e797', commitEm,
    });
    const publicado = descreverEstadoAtualizacao({
      ...base, buildId: 'index-D8govl0X', buildEm: '2026-10-18T19:07:37.000Z', commitSha: '0153e797', commitEm,
    });
    expect(preview.versao).toBe('18/10 16:02');
    expect(publicado.versao).toBe(preview.versao);
    expect(preview.commit).toBe('0153e797');
    expect(preview.build).not.toBe(publicado.build); // o build continua distinguindo os dois
  });

  it('sem data de commit (builder sem .git) cai no carimbo de build, nunca inventa', () => {
    const d = descreverEstadoAtualizacao({ ...base, buildEm: '2026-10-18T19:06:02.000Z', commitSha: null, commitEm: null });
    expect(d.versao).toBe('18/10 16:06');
    expect(d.commit).toBeNull();
  });

  it('desatualizado compara no MESMO eixo: data do commit do servidor quando ele a tem', () => {
    const d = descreverEstadoAtualizacao({
      ...base, commitEm: '2026-10-18T19:02:11.000Z', buildServidor: 'index-CnZTQjW3',
      buildServidorEm: '2026-10-18T20:30:00.000Z', commitEmServidor: '2026-10-18T20:21:00.000Z',
    });
    expect(d.situacao).toBe('desatualizado (servidor: 18/10 17:21)');
  });

  it('com carimbo, a VERSÃO é a data/hora de Brasília (legível e ordenada); o hash fica à parte', () => {
    const d = descreverEstadoAtualizacao({ ...base, buildEm: '2026-10-18T17:54:02.494Z' });
    expect(d.versao).toBe('18/10 14:54');
    expect(d.build).toBe('92kmkUxx');
  });

  it('desatualizado mostra a VERSÃO do servidor quando ele tem carimbo', () => {
    const d = descreverEstadoAtualizacao({ ...base, buildServidor: 'index-CnZTQjW3', buildServidorEm: '2026-10-18T17:54:02.494Z' });
    expect(d.situacao).toBe('desatualizado (servidor: 18/10 14:54)');
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
  '<meta name="app-commit-sha" content="0153e797">' +
  '<meta name="app-commit-em" content="2026-10-17T14:50:00.000Z">' +
  '<script type="module" src="/assets/index-DHn6ISaE.js"></script>';

describe('lerCarimbosDoServidor (build_id + carimbo ordenável, do MESMO HTML)', () => {
  it('lê os dois; o build_id segue idêntico ao de lerBuildDoServidor', async () => {
    const f = vi.fn(async () => new Response(HTML_SERVIDOR));
    expect(await lerCarimbosDoServidor(f as unknown as typeof fetch)).toEqual({
      buildId: 'index-DHn6ISaE',
      buildEm: '2026-10-17T15:00:00.000Z',
      commitEm: '2026-10-17T14:50:00.000Z',
    });
    expect(await lerBuildDoServidor(f as unknown as typeof fetch)).toBe('index-DHn6ISaE');
  });

  it('HTML sem carimbo (build anterior a ele) → buildEm null, build_id preservado', async () => {
    const f = vi.fn(async () => new Response('<script type="module" src="/assets/index-DHn6ISaE.js"></script>'));
    expect(await lerCarimbosDoServidor(f as unknown as typeof fetch)).toEqual({
      buildId: 'index-DHn6ISaE', buildEm: null, commitEm: null,
    });
  });

  it('verificarAtualizacaoAgora grava o carimbo do servidor no estado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(HTML_SERVIDOR)));
    try {
      await verificarAtualizacaoAgora();
      expect(obterEstadoAtualizacao().buildServidorEm).toBe('2026-10-17T15:00:00.000Z');
      expect(obterEstadoAtualizacao().buildServidor).toBe('index-DHn6ISaE');
      expect(obterEstadoAtualizacao().commitEmServidor).toBe('2026-10-17T14:50:00.000Z');
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

describe('semCamposPreenchidos', () => {
  const doc = (campos: Array<Partial<HTMLInputElement>>) =>
    ({ querySelectorAll: () => campos }) as unknown as Document;
  it('tela sem campos ou com campos vazios → limpa', () => {
    expect(semCamposPreenchidos(doc([]))).toBe(true);
    expect(semCamposPreenchidos(doc([{ type: 'text', value: '  ' }]))).toBe(true);
  });
  it('qualquer texto digitado → NÃO limpa (inclusive busca)', () => {
    expect(semCamposPreenchidos(doc([{ type: 'text', value: 'LOTE-123' }]))).toBe(false);
  });
  it('hidden/checkbox/readonly/disabled não contam', () => {
    expect(semCamposPreenchidos(doc([{ type: 'hidden', value: 'x' }, { type: 'checkbox', value: 'on' }, { type: 'text', value: 'x', readOnly: true }, { type: 'text', value: 'x', disabled: true }]))).toBe(true);
  });
  it('sem documento → não arrisca', () => {
    expect(semCamposPreenchidos(undefined as unknown as Document)).toBe(false);
  });
});

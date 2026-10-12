/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { iniciarCaptura } from "../captura";
import type { Saida } from "../protocolo";

function teclar(key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
}

describe("captura no window", () => {
  let parar: (() => void) | null = null;
  afterEach(() => {
    parar?.();
    vi.useRealTimers();
  });

  it("rajada `~~` + código + Enter vira leitura e as teclas são canceladas (não chegam ao campo)", () => {
    const saidas: Saida[] = [];
    let t = 0;
    parar = iniciarCaptura({ aoSaida: (s) => saidas.push(s), agora: () => (t += 2) });
    const eventos = ["~", "~", "7", "8", "9", "Enter"].map(teclar);
    expect(saidas).toMatchObject([{ tipo: "leitura", codigo: "789" }]);
    expect(eventos.every((e) => e.defaultPrevented)).toBe(true);
  });

  it("digitação comum não é cancelada", () => {
    let t = 0;
    parar = iniciarCaptura({ aoSaida: () => {}, agora: () => (t += 200) });
    expect(teclar("5").defaultPrevented).toBe(false);
  });

  it("sem Enter, o timer trunca a leitura", () => {
    vi.useFakeTimers();
    const saidas: Saida[] = [];
    let t = 0;
    parar = iniciarCaptura({ aoSaida: (s) => saidas.push(s), agora: () => t });
    for (const k of ["~", "~", "1", "2"]) {
      t += 2;
      teclar(k);
    }
    t += 400;
    vi.advanceTimersByTime(400);
    expect(saidas).toMatchObject([{ tipo: "truncada", parcial: "12" }]);
  });

  it("ENTER atrasado (depois da janela de descarte) não aciona o botão focado; no campo de texto, passa", () => {
    vi.useFakeTimers();
    let t = 0;
    parar = iniciarCaptura({ aoSaida: () => {}, agora: () => t });
    for (const k of ["~", "~", "1"]) {
      t += 2;
      teclar(k);
    }
    t += 400;
    vi.advanceTimersByTime(400); // trunca → descarte de 1 s
    t += 5_000;
    vi.advanceTimersByTime(5_000); // descarte venceu: o protocolo já não engole o ENTER
    const botao = document.createElement("button");
    document.body.appendChild(botao);
    const noBotao = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    botao.dispatchEvent(noBotao);
    expect(noBotao.defaultPrevented).toBe(true);
    const campo = document.createElement("input");
    document.body.appendChild(campo);
    const noCampo = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    campo.dispatchEvent(noCampo);
    expect(noCampo.defaultPrevented).toBe(false);
  });

  it("desligar remove o listener", () => {
    const saidas: Saida[] = [];
    let t = 0;
    const p = iniciarCaptura({ aoSaida: (s) => saidas.push(s), agora: () => (t += 2) });
    p();
    ["~", "~", "1", "Enter"].forEach(teclar);
    expect(saidas).toEqual([]);
  });
});

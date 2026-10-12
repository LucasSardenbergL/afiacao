import { describe, expect, it } from "vitest";
import { ESTADO_INICIAL, type Entrada, type EstadoProtocolo, passo, proximoVencimento, type Saida, separarSimbologia } from "../protocolo";

/** Roda uma sequência de entradas e devolve as saídas e quais teclas foram engolidas. */
function rodar(entradas: Entrada[], inicial: EstadoProtocolo = ESTADO_INICIAL) {
  let estado = inicial;
  const saidas: Saida[] = [];
  const engolidas: string[] = [];
  const passaram: string[] = [];
  for (const en of entradas) {
    const p = passo(estado, en);
    estado = p.estado;
    saidas.push(...p.saidas);
    if (en.tipo === "tecla") (p.engolir ? engolidas : passaram).push(en.key);
  }
  return { estado, saidas, engolidas, passaram };
}

/** Rajada do DataWedge: `~~` + texto + ENTER, `dt` ms entre teclas, começando em `t0`. */
function rajada(texto: string, t0: number, dt = 3, fim: "Enter" | null = "Enter"): Entrada[] {
  const teclas = ["~", "~", ...texto.split(""), ...(fim ? [fim] : [])];
  return teclas.map((key, i) => ({ tipo: "tecla", key, t: t0 + i * dt }));
}

describe("protocolo do leitor (keystroke DataWedge)", () => {
  it("rajada completa vira UMA leitura, com simbologia separada, e todas as teclas são engolidas", () => {
    const r = rodar(rajada("]E07891234567895", 1000));
    expect(r.saidas).toEqual([{ tipo: "leitura", codigo: "7891234567895", simbologia: "]E0", t0: 1000, t: 1000 + 18 * 3 }]);
    expect(r.passaram).toEqual([]);
    expect(r.estado.fase).toBe("ocioso");
  });

  it("sem simbologia também é leitura", () => {
    expect(rodar(rajada("ABC-12.5", 0)).saidas).toMatchObject([{ tipo: "leitura", codigo: "ABC-12.5", simbologia: null }]);
  });

  it("leitura sem ENTER é TRUNCADA quando o tempo passa — nunca vira código parcial", () => {
    const r = rodar([...rajada("78912", 0, 3, null), { tipo: "tempo", t: 1000 }]);
    expect(r.saidas).toEqual([{ tipo: "truncada", parcial: "78912", t: 1000 }]);
  });

  it("truncamento também é detectado pela próxima tecla, se o tempo não foi avisado", () => {
    const r = rodar([...rajada("78912", 0, 3, null), ...rajada("555", 2000)]);
    expect(r.saidas.map((s) => s.tipo)).toEqual(["truncada", "leitura"]);
    expect(r.saidas[1]).toMatchObject({ codigo: "555" });
  });

  it("digitação humana intercalada (sem `~~`) passa para o campo e não gera leitura", () => {
    const r = rodar([..."12a".split("").map((key, i): Entrada => ({ tipo: "tecla", key, t: i * 200 })), { tipo: "tecla", key: "Enter", t: 700 }]);
    expect(r.saidas).toEqual([]);
    expect(r.passaram).toEqual(["1", "2", "a", "Enter"]);
  });

  it("`~` isolado é engolido, mas a tecla seguinte (fora da janela) passa", () => {
    const r = rodar([{ tipo: "tecla", key: "~", t: 0 }, { tipo: "tecla", key: "x", t: 500 }]);
    expect(r.engolidas).toEqual(["~"]);
    expect(r.passaram).toEqual(["x"]);
    expect(r.saidas).toEqual([]);
  });

  it("2º `~` fora da janela de armar não arma a captura", () => {
    const r = rodar([{ tipo: "tecla", key: "~", t: 0 }, { tipo: "tecla", key: "~", t: 80 }, { tipo: "tecla", key: "1", t: 83 }]);
    expect(r.estado.fase).toBe("ocioso");
    expect(r.passaram).toEqual(["1"]);
  });

  it("mesmo código em ≤250 ms é double-decode: ignorado; depois da janela é unidade nova", () => {
    const a = rajada("789", 0); // termina em t=15
    const b = rajada("789", 100); // começa 85 ms depois do fim da 1ª
    const c = rajada("789", 600);
    const r = rodar([...a, ...b, ...c]);
    expect(r.saidas.map((s) => s.tipo)).toEqual(["leitura", "duplicata", "leitura"]);
  });

  it("código DIFERENTE em sequência rápida não é duplicata", () => {
    const r = rodar([...rajada("111", 0), ...rajada("222", 20)]);
    expect(r.saidas.map((s) => (s.tipo === "leitura" ? s.codigo : s.tipo))).toEqual(["111", "222"]);
  });

  it("rajada de double-decodes não estende a janela indefinidamente", () => {
    const r = rodar([...rajada("9", 0), ...rajada("9", 200), ...rajada("9", 400)]);
    // 1ª termina em 9; 2ª começa em 200 (≤250 → duplicata); 3ª começa em 400 (391 da 1ª → leitura).
    expect(r.saidas.map((s) => s.tipo)).toEqual(["leitura", "duplicata", "leitura"]);
  });

  it("conteúdo fora do alfabeto ou vazio com ENTER é inválido (não vira leitura)", () => {
    expect(rodar(rajada("78 9", 0)).saidas).toMatchObject([{ tipo: "invalida", bruto: "78 9" }]);
    expect(rodar(rajada("", 0)).saidas).toMatchObject([{ tipo: "invalida", bruto: "" }]);
  });

  it("buffer acima do teto é inválido e o resto do quadro é descartado (engolido)", () => {
    const r = rodar(rajada("1".repeat(81), 0, 1, null));
    expect(r.saidas).toMatchObject([{ tipo: "invalida" }]);
    expect(r.estado.fase).toBe("descartando");
    const resto = rodar([{ tipo: "tecla", key: "2", t: 90 }, { tipo: "tecla", key: "Enter", t: 91 }], r.estado);
    expect([resto.passaram, resto.estado.fase]).toEqual([[], "ocioso"]);
  });

  it("ENTER atrasado de uma leitura truncada é ENGOLIDO (não aciona o botão focado)", () => {
    const r = rodar([...rajada("789", 0, 3, null), { tipo: "tempo", t: 400 }, { tipo: "tecla", key: "Enter", t: 450 }]);
    expect(r.saidas).toMatchObject([{ tipo: "truncada", parcial: "789" }]);
    expect([r.engolidas.at(-1), r.passaram]).toEqual(["Enter", []]);
  });

  it("depois do descarte, digitação normal volta a passar", () => {
    const r = rodar([...rajada("789", 0, 3, null), { tipo: "tempo", t: 400 }, { tipo: "tecla", key: "5", t: 2000 }]);
    expect(r.passaram).toEqual(["5"]);
  });

  it("teclas não imprimíveis (Shift) durante a captura são engolidas e não entram no código", () => {
    const en: Entrada[] = [
      { tipo: "tecla", key: "~", t: 0 },
      { tipo: "tecla", key: "~", t: 2 },
      { tipo: "tecla", key: "Shift", t: 4 },
      { tipo: "tecla", key: "A", t: 5 },
      { tipo: "tecla", key: "Enter", t: 7 },
    ];
    const r = rodar(en);
    expect(r.saidas).toMatchObject([{ tipo: "leitura", codigo: "A" }]);
    expect(r.passaram).toEqual([]);
  });

  it("proximoVencimento aponta o instante em que o `tempo` precisa chegar", () => {
    expect(proximoVencimento(ESTADO_INICIAL)).toBeNull();
    const p = passo(ESTADO_INICIAL, { tipo: "tecla", key: "~", t: 10 }).estado;
    expect(proximoVencimento(p)).toBe(61);
  });

  it("separarSimbologia só reconhece `]` + 2 caracteres no início", () => {
    expect(separarSimbologia("]E0123")).toEqual({ simbologia: "]E0", codigo: "123" });
    expect(separarSimbologia("123")).toEqual({ simbologia: null, codigo: "123" });
  });
});

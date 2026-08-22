// Matcher de padrões RESTRITOS do manifesto de módulos (sem dependência de glob lib).
// Gramática: "dir/**" (tudo sob dir) · "*" (wildcard num segmento, não atravessa "/") · caminho exato.
const escapaRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function compilar(padrao: string): RegExp {
  if (padrao.endsWith("/**")) {
    const base = escapaRegex(padrao.slice(0, -3));
    return new RegExp(`^${base}/.+$`);
  }
  const corpo = padrao.split("*").map(escapaRegex).join("[^/]*");
  return new RegExp(`^${corpo}$`);
}

// O regex é função PURA da string do padrão, e o gate do manifesto avalia ~1,9M pares
// (padrão × arquivo) sobre apenas ~580 padrões distintos. Compilar a cada chamada custa
// 26,64us contra 0,163us de um RegExp pronto (163x) — os ~40s que estouravam o
// testTimeout de 20s do gate eram compilação repetida, não o casamento em si.
//
// Map (não objeto literal): padrões como "constructor"/"__proto__" colidiriam com
// Object.prototype e envenenariam o cache.
//
// Reusar a instância é seguro porque compilar() nunca emite flag /g nem /y — .test()
// de regex sem flag global não guarda lastIndex entre chamadas. Ao adicionar flag aqui,
// o cache passa a compartilhar estado: ver o teste-sentinela em __tests__/padrao.test.ts.
const memo = new Map<string, RegExp>();

export function padraoParaRegex(padrao: string): RegExp {
  let re = memo.get(padrao);
  if (re === undefined) {
    re = compilar(padrao);
    memo.set(padrao, re);
  }
  return re;
}

export function casaPadrao(padrao: string, caminho: string): boolean {
  return padraoParaRegex(padrao).test(caminho);
}

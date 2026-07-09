// Matcher de padrões RESTRITOS do manifesto de módulos (sem dependência de glob lib).
// Gramática: "dir/**" (tudo sob dir) · "*" (wildcard num segmento, não atravessa "/") · caminho exato.
const escapaRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export function padraoParaRegex(padrao: string): RegExp {
  if (padrao.endsWith("/**")) {
    const base = escapaRegex(padrao.slice(0, -3));
    return new RegExp(`^${base}/.+$`);
  }
  const corpo = padrao.split("*").map(escapaRegex).join("[^/]*");
  return new RegExp(`^${corpo}$`);
}

export function casaPadrao(padrao: string, caminho: string): boolean {
  return padraoParaRegex(padrao).test(caminho);
}

// Helpers puros da aba de Configuração de meta trimestral do DES.
// Parsing de entrada (moeda pt-BR, faixa), validação e classificação de período.
// Testados em __tests__/format.test.ts (TDD).

export type Periodo = "corrente" | "passado" | "futuro";

/**
 * Converte um input de moeda pt-BR para número.
 * Convenção pt-BR: vírgula = decimal, ponto = separador de milhar.
 * Ex: "R$ 400.840,50" -> 400840.5 · "1.234.567" -> 1234567.
 * Retorna null para vazio/só-símbolo/não-numérico.
 */
export function parseMetaInput(raw: string): number | null {
  if (raw == null) return null;
  // Remove só o prefixo de moeda e espaços; NÃO "limpa" outros caracteres —
  // limpar transformava lixo em outro número (ex.: "abc400" -> 400, "1.2.3" -> 123).
  const s = String(raw).trim().replace(/\s/g, "").replace(/R\$/gi, "");
  if (!s) return null;
  // Formato pt-BR aceito: dígitos puros, OU milhar agrupado \d{1,3}(.\d{3})+,
  // com decimal opcional por vírgula (1-2 casas). Qualquer outra coisa é inválida.
  if (!/^(\d+|\d{1,3}(\.\d{3})+)(,\d{1,2})?$/.test(s)) return null;
  const n = Number(s.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Formata um número salvo de volta para o input pt-BR (inverso de parseMetaInput). */
export function formatMetaParaInput(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

/**
 * Parseia o nº da faixa-alvo. Retorna um inteiro >= 1, ou null para vazio/malformado/<1.
 * NÃO limpa lixo (ex.: "abc3" e "1.5" são inválidos, não viram 3/15). O consumidor
 * distingue "vazio" (opcional, ok) de "malformado" (bloqueia) via o input cru.
 */
export function parseFaixaInput(raw: string): number | null {
  const s = String(raw ?? "").trim();
  if (!s || !/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** Meta válida = número finito positivo (a coluna é NOT NULL e > 0 faz sentido de negócio). */
export function isMetaValida(n: number | null): boolean {
  return n != null && Number.isFinite(n) && n > 0;
}

/** Classifica o trimestre selecionado relativo ao corrente (para o aviso de edição). */
export function classificarPeriodo(
  ano: number,
  trimestre: number,
  anoAtual: number,
  trimestreAtual: number,
): Periodo {
  const sel = ano * 4 + trimestre;
  const atual = anoAtual * 4 + trimestreAtual;
  if (sel === atual) return "corrente";
  return sel < atual ? "passado" : "futuro";
}

/** Anos oferecidos no seletor: anoAtual+1 .. anoAtual-3, do mais recente ao mais antigo. */
export function anosSelecionaveis(anoAtual: number): number[] {
  const anos: number[] = [];
  for (let a = anoAtual + 1; a >= anoAtual - 3; a--) anos.push(a);
  return anos;
}

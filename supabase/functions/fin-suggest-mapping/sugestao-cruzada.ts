// Sugestão cruzada de mapeamento DRE (v1.3): o que OUTRA empresa do grupo mapeou só vale como
// sugestão se for a MESMA categoria — mesmo código E mesma descrição. Código puro mentia: o plano
// de contas das 3 empresas reusa o código para naturezas distintas (2.01.99 = "Compra de Ativo
// Imobilizado"→nao_resultado na colacor, "Compra de Material de Uso e Consumo"→despesa na oben;
// 1.02.99 = "Estorno" na colacor, "Entrada de Aplicação" na oben). Precisão > recall: descrição
// ausente de qualquer lado ⇒ sem sugestão cruzada (cai na keyword de confiança baixa).

/** Comparação tolerante só a forma (caixa, acento, pontuação, espaço) — nunca a plural/sinônimo. */
export function normalizarDescricao(s: string | null | undefined): string | null {
  if (s == null) return null;
  const n = s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return n === "" ? null : n;
}

export type MapeamentoOutraEmpresa = { company: string; dre_linha: string };

/**
 * Filtra os mapeamentos de outras empresas para o mesmo código, exigindo descrição igual.
 * `descricaoDe(company, codigo)` devolve a descrição da categoria NA EMPRESA-FONTE (fin_categorias).
 */
export function mapeamentosComMesmaDescricao(
  categoriaNome: string | null | undefined,
  candidatos: MapeamentoOutraEmpresa[],
  codigo: string,
  descricaoDe: (company: string, codigo: string) => string | null | undefined,
): MapeamentoOutraEmpresa[] {
  const alvo = normalizarDescricao(categoriaNome);
  if (alvo == null) return [];
  return candidatos.filter((m) => normalizarDescricao(descricaoDe(m.company, codigo)) === alvo);
}

/**
 * Decide a sugestão cruzada: só quando TODAS as fontes com mesmo código e descrição concordam na
 * linha DRE. Divergência ⇒ null — o front aplica em lote toda sugestão `alta`, e a ordem dos
 * candidatos é arbitrária (escolher o 1º seria sorteio).
 */
export function decidirSugestaoCruzada(
  categoriaNome: string | null | undefined,
  candidatos: MapeamentoOutraEmpresa[],
  codigo: string,
  descricaoDe: (company: string, codigo: string) => string | null | undefined,
  sugerivel: (linha: string) => boolean,
): MapeamentoOutraEmpresa | null {
  // A divergência decide-se sobre TODAS as fontes (inclusive quem mapeou fora_dre/nao_resultado);
  // só a linha vencedora passa por `sugerivel`. Filtrar antes esconderia a divergência e
  // entregaria a outra linha como `alta`.
  const iguais = mapeamentosComMesmaDescricao(categoriaNome, candidatos, codigo, descricaoDe);
  if (iguais.length === 0) return null;
  const linhas = new Set(iguais.map((m) => m.dre_linha));
  if (linhas.size !== 1) return null;
  return sugerivel(iguais[0].dre_linha) ? iguais[0] : null;
}

// Progresso da separação visto pelo aparelho: o que o SERVIDOR já aceitou (leituras da revisão
// vigente de cada linha) + o que está na fila local ainda sem resposta (pela previsão). Uma
// leitura respondida pelo servidor deixa de contar pela previsão e passa a contar pelo servidor
// — sem contar duas vezes nem sumir entre a resposta e o próximo refetch.
import type { ItemFila } from "./scanner/fila";
import type { LinhaLocal } from "./validacao-local";

export interface LinhaServidor extends Omit<LinhaLocal, "separada"> {
  revisao: number;
}

export interface LeituraServidor {
  id: string;
  linha_id: string | null;
  linha_revisao: number | null;
  unidades: number | null;
  aceita: boolean;
}

export function progressoLocal(linhas: LinhaServidor[], leituras: LeituraServidor[], fila: ItemFila[]): LinhaLocal[] {
  const conhecidas = new Set(leituras.map((l) => l.id));
  const soma = new Map<string, number>();
  const somar = (linha: string, u: number) => soma.set(linha, (soma.get(linha) ?? 0) + u);
  const revisao = new Map(linhas.map((l) => [l.id, l.revisao]));

  for (const l of leituras) {
    if (!l.aceita || l.linha_id === null || l.unidades === null) continue;
    if (revisao.get(l.linha_id) !== l.linha_revisao) continue; // revisão antiga não conta
    somar(l.linha_id, Number(l.unidades));
  }
  for (const it of fila) {
    if (conhecidas.has(it.comando.leitura_id)) continue; // o servidor já a tem: conta por lá
    if (it.estado === "aceita" && it.linha_id !== null && it.unidades !== null) somar(it.linha_id, it.unidades);
    else if (it.estado === "pendente" && it.previsto) somar(it.previsto.linha_id, it.previsto.unidades);
  }
  return linhas.map(({ revisao: _r, ...l }) => ({ ...l, separada: soma.get(l.id) ?? 0 }));
}

/** Linha sugerida: a 1ª ativa incompleta por `codigo_item`; null = tudo separado. */
export function linhaAtual(linhas: LinhaLocal[]): LinhaLocal | null {
  return [...linhas].filter((l) => l.ativa && l.separada < l.quantidade).sort((a, b) => a.codigo_item - b.codigo_item)[0] ?? null;
}

/** Tudo separado (só linhas ativas; pelo menos uma). */
export function tudoSeparado(linhas: LinhaLocal[]): boolean {
  const ativas = linhas.filter((l) => l.ativa);
  return ativas.length > 0 && ativas.every((l) => l.separada === l.quantidade);
}

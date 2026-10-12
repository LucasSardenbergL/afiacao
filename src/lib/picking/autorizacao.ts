// A tarefa autoriza CAPTURAR agora? Espelho do que `picking_registrar_leitura` exige (ela decide),
// mais o que só o aparelho sabe: época entre abas e negativas do servidor ainda não relidas.
// PURO — o hook só junta os insumos (Codex Fase 1 r2/r3).
import type { Epoca } from "./motor-fila";
import type { TarefaV2 } from "./v2-api";

export interface AtribuicaoLocal {
  atribuicao_id: string;
  tarefa_revisao: number;
}

export interface InsumosBloqueio {
  tarefa: TarefaV2;
  atribuicao: AtribuicaoLocal;
  operador: string | null;
  /** Época vista na releitura da tarefa feita NESTE mount; null = ainda não houve. */
  epocaLida: number | null;
  epocaAtual: Epoca;
  /** Quando o servidor respondeu `ausente_do_omie` pela última vez (ms); null = nunca. */
  ausenteEm: number | null;
  /** Quando a tarefa foi relida com SUCESSO pela última vez (ms). */
  tarefaLidaEm: number;
}

/** Motivo do bloqueio, ou null quando pode capturar. */
export function bloqueioDaTarefa(x: InsumosBloqueio): string | null {
  if (x.epocaAtual.aberta) return "barreira_em_andamento";
  if (x.epocaLida === null || x.epocaLida !== x.epocaAtual.n) return "conferindo_tarefa";
  // Negativa do servidor conhecida e ainda não relida com sucesso: não autoriza com o retrato
  // velho (a releitura que falha por rede mantém o bloqueio).
  if (x.ausenteEm !== null && x.tarefaLidaEm <= x.ausenteEm) return "ausente_do_omie";
  const t = x.tarefa;
  if (t.status !== "em_separacao") return "tarefa_fora_de_separacao";
  if (t.atribuicao_id !== x.atribuicao.atribuicao_id || t.operador_id !== x.operador) return "atribuicao_antiga";
  if (t.revisao !== x.atribuicao.tarefa_revisao) return "revisao_antiga";
  if (t.ausente_rodadas >= 2) return "ausente_do_omie";
  return null;
}

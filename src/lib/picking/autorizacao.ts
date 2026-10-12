// A tarefa autoriza CAPTURAR agora? Espelho do que `picking_registrar_leitura` exige (ela decide),
// mais o que só o aparelho sabe: época entre abas e negativas do servidor ainda não relidas.
// PURO — o hook só junta os insumos (Codex Fase 1 r2/r3).
import type { Epoca } from "./motor-fila";
import type { TarefaV2 } from "./v2-api";

let ultimoTique = 0;
/**
 * Marca de ORDEM da aba (monotônica): início de consulta, mount e negativa do servidor são
 * ordenados por ela, nunca pelo relógio civil — ajuste de hora no aparelho não pode liberar
 * captura nem travá-la (Codex Fase 1 r5).
 */
export function tique(): number {
  return ++ultimoTique;
}

export interface AtribuicaoLocal {
  atribuicao_id: string;
  tarefa_revisao: number;
}

export interface InsumosBloqueio {
  tarefa: TarefaV2;
  atribuicao: AtribuicaoLocal;
  operador: string | null;
  /** Época vista quando a releitura em `leituraIniciadaEm` começou; null = sem dado. */
  epocaLida: number | null;
  epocaAtual: Epoca;
  /** `tique()` do INÍCIO da consulta que produziu a tarefa em mãos (só consultas BEM-SUCEDIDAS geram dado). */
  leituraIniciadaEm: number | null;
  /** `tique()` do mount: só vale leitura que COMEÇOU depois (cache/erro não autorizam). */
  montadoEm: number;
  /** `tique()` da última resposta `ausente_do_omie`; null = nunca. */
  ausenteEm: number | null;
}

/** Motivo do bloqueio, ou null quando pode capturar. */
export function bloqueioDaTarefa(x: InsumosBloqueio): string | null {
  if (x.epocaAtual.aberta) return "barreira_em_andamento";
  // Comparar o INÍCIO da consulta (não a chegada): resposta de consulta anterior ao mount ou à
  // negativa — em voo, de cache, ou com a releitura nova falhando — não prova nada (Codex r4).
  if (x.leituraIniciadaEm === null || x.leituraIniciadaEm < x.montadoEm) return "conferindo_tarefa";
  if (x.epocaLida === null || x.epocaLida !== x.epocaAtual.n) return "conferindo_tarefa";
  if (x.ausenteEm !== null && x.leituraIniciadaEm <= x.ausenteEm) return "ausente_do_omie";
  const t = x.tarefa;
  if (t.status !== "em_separacao") return "tarefa_fora_de_separacao";
  if (t.atribuicao_id !== x.atribuicao.atribuicao_id || t.operador_id !== x.operador) return "atribuicao_antiga";
  if (t.revisao !== x.atribuicao.tarefa_revisao) return "revisao_antiga";
  if (t.ausente_rodadas >= 2) return "ausente_do_omie";
  return null;
}

// src/lib/melhorias/triagem-helpers.ts
// Helpers puros da triagem — ESPELHADOS VERBATIM na edge `melhoria-triagem`
// (Deno não importa do src/; ao alterar aqui, alterar lá).
import {
  MELHORIA_MODULOS,
  MELHORIA_TIPOS,
  MELHORIA_URGENCIAS,
  MAX_MENSAGENS_FUNCIONARIO,
  type MelhoriaItem,
  type MelhoriaMensagem,
  type MelhoriaModulo,
  type MelhoriaTipo,
  type MelhoriaUrgencia,
  type TriagemValidada,
} from './types';

function normStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Valida/normaliza o output da tool `triar` da IA.
 * Retorna null quando o payload é inaproveitável (a edge marca triagem_status='erro').
 * Módulo desconhecido degrada pra 'outro' (lista evolui sem quebrar).
 */
export function validarTriagem(payload: unknown): TriagemValidada | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  const tipoRaw = normStr(p.tipo).toLowerCase();
  if (!(MELHORIA_TIPOS as ReadonlyArray<string>).includes(tipoRaw)) return null;
  const tipo = tipoRaw as MelhoriaTipo;

  const urgenciaRaw = normStr(p.urgencia).toLowerCase();
  if (!(MELHORIA_URGENCIAS as ReadonlyArray<string>).includes(urgenciaRaw)) return null;
  const urgencia = urgenciaRaw as MelhoriaUrgencia;

  const moduloRaw = normStr(p.modulo).toLowerCase();
  const modulo: MelhoriaModulo = (MELHORIA_MODULOS as ReadonlyArray<string>).includes(moduloRaw)
    ? (moduloRaw as MelhoriaModulo)
    : 'outro';

  const titulo = normStr(p.titulo).slice(0, 120);
  const resposta = normStr(p.resposta_ao_funcionario);
  if (!titulo || !resposta) return null;

  return {
    tipo,
    urgencia,
    modulo,
    titulo,
    resposta_ao_funcionario: resposta,
    avaliacao_founder: normStr(p.avaliacao_founder),
  };
}

/**
 * Cap de réplicas (app-level; a edge re-valida antes de triar).
 * Réplica só em item aberto/em_andamento e com < MAX_MENSAGENS_FUNCIONARIO do autor.
 */
export function podeReplicar(
  item: Pick<MelhoriaItem, 'status'>,
  mensagens: Array<Pick<MelhoriaMensagem, 'papel'>>,
): { ok: boolean; motivo?: string } {
  if (item.status !== 'aberto' && item.status !== 'em_andamento') {
    return { ok: false, motivo: 'Item já foi finalizado — abra um novo se precisar.' };
  }
  const doFuncionario = mensagens.filter((m) => m.papel === 'funcionario').length;
  if (doFuncionario >= MAX_MENSAGENS_FUNCIONARIO) {
    return { ok: false, motivo: 'Limite de réplicas atingido — abra um novo item se precisar.' };
  }
  return { ok: true };
}

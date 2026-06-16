import type { TarefaCategoria, TarefaAutoSatisfy } from './types';

export function autoSatisfyDaCategoria(c: TarefaCategoria): TarefaAutoSatisfy {
  if (c === 'ligar') return 'interacao';
  if (c === 'oferecer' || c === 'preco') return 'conteudo';
  return 'off'; // whatsapp (botão), outro (manual)
}

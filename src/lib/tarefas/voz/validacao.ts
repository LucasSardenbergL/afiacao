// src/lib/tarefas/voz/validacao.ts
import type { RascunhoVoz } from './types';
import type { TarefaCategoria } from '../types';

const CATEGORIAS: TarefaCategoria[] = ['ligar', 'oferecer', 'preco', 'whatsapp', 'outro'];

export function validarRascunho(r: RascunhoVoz, hojeSP: string): { ok: boolean; erros: string[] } {
  const erros: string[] = [];

  if (!r.cliente || !r.cliente.customer_user_id) erros.push('Cliente não resolvido.');
  if (!r.vendedora.user_id) erros.push('Escolha a vendedora.');
  if (!r.descricao.trim()) erros.push('Descrição vazia.');
  if (!CATEGORIAS.includes(r.categoria)) erros.push('Categoria inválida.');

  const d = r.data;
  if (d.status === 'ambigua' || d.status === 'nao_resolvida' || d.status === 'passado') {
    erros.push('Confirme o prazo.');
  } else if (d.modo === 'data') {
    if (!d.due_date) erros.push('Data não definida.');
    else if (d.due_date < hojeSP) erros.push('Data no passado.');
  } else if (d.modo === 'interacao' && !d.interacao_tipo) {
    erros.push('Escolha o tipo de interação.');
  }

  if ((r.categoria === 'oferecer' || r.categoria === 'preco') && !r.target_texto?.trim()) {
    erros.push('Informe o item/preço.');
  }

  return { ok: erros.length === 0, erros };
}

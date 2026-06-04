// src/lib/tarefas/voz/empresa.ts

export type EmpresaKey = 'oben' | 'colacor' | 'colacor_sc';

const MAP: Record<string, EmpresaKey> = {
  oben: 'oben',
  vendas: 'oben',
  colacor: 'colacor',
  colacor_vendas: 'colacor',
  colacor_sc: 'colacor_sc',
  servicos: 'colacor_sc',
};

/**
 * Deriva a empresa-chave a partir de `empresa_omie` do cliente
 * (aceita a chave de empresa OU o nome de conta Omie).
 * Desconhecido/vazio → null (o caller aplica fallback).
 */
export function empresaDeOmie(empresaOmie: string | null | undefined): EmpresaKey | null {
  const v = (empresaOmie ?? '').toLowerCase().trim();
  return MAP[v] ?? null;
}

/**
 * Extensão manual do Database type para a tabela user_departments
 * adicionada na migration 20260517120000.
 *
 * Quando o gen types rodar via Supabase CLI, esses tipos virão automatic
 * em src/integrations/supabase/types.ts e este arquivo pode ser removido.
 */

export type Department =
  | 'separador'
  | 'conferente'
  | 'comprador'
  | 'tintometrico'
  | 'financeiro'
  | 'vendas'
  | 'gestao'
  | 'outro';

export const DEPARTMENT_VALUES: Department[] = [
  'separador',
  'conferente',
  'comprador',
  'tintometrico',
  'financeiro',
  'vendas',
  'gestao',
  'outro',
];

export const DEPARTMENT_LABELS: Record<Department, string> = {
  separador: 'Separador',
  conferente: 'Conferente',
  comprador: 'Comprador',
  tintometrico: 'Tintométrico',
  financeiro: 'Financeiro',
  vendas: 'Vendas',
  gestao: 'Gestão',
  outro: 'Outro',
};

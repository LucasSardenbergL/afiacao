// Borda de `fornecedor_alerta` → `AlertaRow`. O gerador dá `severidade` como `string` (é CHECK, não
// enum) e `criado_em` como nullable (tem DEFAULT now(), mas não NOT NULL); antes um
// cast duplo para `AlertaRow[]` afirmava as duas coisas sem conferir.
import type { Tables } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import type { AlertaRow, Severidade } from './types';

const SEVERIDADES: readonly Severidade[] = ['info', 'atencao', 'urgente'];

type LinhaAlerta = Omit<AlertaRow, 'severidade' | 'criado_em'> &
  Pick<Tables<'fornecedor_alerta'>, 'severidade' | 'criado_em'>;

/** Lança com `criado_em` nulo ou `severidade` fora do CHECK — o badge não inventa severidade. */
export function alertaDaLinha(linha: LinhaAlerta): AlertaRow {
  exigirColunas(linha, ['criado_em'], 'fornecedor_alerta');
  const severidade = SEVERIDADES.find((s) => s === linha.severidade);
  if (!severidade) throw new Error(`fornecedor_alerta ${linha.id}: severidade fora do CHECK (${linha.severidade})`);
  return { ...linha, severidade };
}

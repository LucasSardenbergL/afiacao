import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { track } from '@/lib/analytics';
import { toCsv, type NaoVinculadoCsvRow } from '@/lib/clientes-nao-vinculados/csv';
import { hojeSP } from '@/lib/time/sp-day';

const EMPRESA = 'oben';

// View nova não está no types.ts → cast por shape mínimo (sem any).
type PgRange = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  eq: (col: string, val: string) => PgRange;
  order: (col: string, opts: { ascending: boolean }) => PgRange;
  range: (from: number, to: number) => PgRange;
};

// Exporta TODOS os não-vinculados do último run completo como CSV (não a lista capada da tela).
// Pagina por omie_codigo_cliente (chave estável → sem pular/duplicar linha entre páginas).
export function useExportNaoVinculados() {
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const client = supabase as unknown as { from: (t: string) => { select: (c: string) => PgRange } };
      // Pelo canônico: página perdida LANÇA (nunca CSV PARCIAL sem aviso) e é medida pela fonte.
      const all = await fetchAllPagesComMensagem<NaoVinculadoCsvRow>(
        (de, ate) =>
          client
            .from('v_clientes_nao_vinculados_atual')
            .select('omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
            .eq('empresa', EMPRESA)
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate) as unknown as PromiseLike<{ data: NaoVinculadoCsvRow[] | null; error: unknown }>,
        'v_clientes_nao_vinculados_atual/export-csv',
        'v_clientes_nao_vinculados_atual',
      );

      // BOM UTF-8 → Excel mostra acentos corretamente.
      const blob = new Blob(['﻿' + toCsv(all)], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clientes-nao-vinculados-oben-${hojeSP()}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      track('carteira.nao_vinculados_export', { linhas: all.length });
      return all.length;
    },
  });
}

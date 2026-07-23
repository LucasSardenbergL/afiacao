import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { toCsv, type NaoVinculadoCsvRow } from '@/lib/clientes-nao-vinculados/csv';

const EMPRESA = 'oben';
const PAGE = 1000;

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
      const all: NaoVinculadoCsvRow[] = [];
      let from = 0;
      while (true) {
        const { data, error } = await client
          .from('v_clientes_nao_vinculados_atual')
          .select('omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
          .eq('empresa', EMPRESA)
          .order('omie_codigo_cliente', { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw new Error(error.message);
        // data null SEM error = malformada, não fim (classe #1338→#1564): tratá-la como
        // fim exportava CSV PARCIAL sem aviso.
        if (data == null) throw new Error('v_clientes_nao_vinculados_atual: data null sem error — malformada, não é fim');
        const rows = data as NaoVinculadoCsvRow[];
        all.push(...rows);
        if (rows.length < PAGE) break;
        from += PAGE;
      }

      // BOM UTF-8 → Excel mostra acentos corretamente.
      const blob = new Blob(['﻿' + toCsv(all)], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clientes-nao-vinculados-oben-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      track('carteira.nao_vinculados_export', { linhas: all.length });
      return all.length;
    },
  });
}

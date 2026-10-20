import { useMutation } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
import { linhasCom } from '@/lib/linha-view';
import { track } from '@/lib/analytics';
import { toCsv, type NaoVinculadoCsvRow } from '@/lib/clientes-nao-vinculados/csv';
import { hojeSP } from '@/lib/time/sp-day';

const EMPRESA = 'oben';
const FONTE = 'v_clientes_nao_vinculados_atual/export-csv';

// Exporta TODOS os não-vinculados do último run completo como CSV (não a lista capada da tela).
// Pagina por omie_codigo_cliente (chave estável → sem pular/duplicar linha entre páginas).
export function useExportNaoVinculados() {
  return useMutation({
    mutationFn: async (): Promise<number> => {
      // Pelo canônico: página perdida LANÇA (nunca CSV PARCIAL sem aviso) e é medida pela fonte.
      const paginas = await fetchAllPagesComMensagem(
        (de, ate) =>
          supabase
            .from('v_clientes_nao_vinculados_atual')
            .select('omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
            .eq('empresa', EMPRESA)
            .order('omie_codigo_cliente', { ascending: true })
            .range(de, ate),
        FONTE,
        'v_clientes_nao_vinculados_atual',
      );
      // View perde o NOT NULL no types.ts; a chave de paginação é exigida na borda (linha sem ela
      // não entra no CSV — nunca "0" inventado na coluna codigo_omie).
      const all: NaoVinculadoCsvRow[] = linhasCom(paginas, ['omie_codigo_cliente'], FONTE);

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

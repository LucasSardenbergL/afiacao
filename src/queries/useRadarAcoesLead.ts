import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import type { RadarEmpresa } from '@/queries/useRadarLista';

// TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
type RpcFn = typeof supabase.rpc;

interface CadastroOmieResult {
  codigo_cliente: string | number | null;
  ja_existia: boolean;
}

/**
 * Cadastra a empresa no Omie (Oben) via a edge `omie-vendas-sync` action `criar_cliente`.
 * Anti-dup: a edge consulta pelo documento antes de criar; se já existir, retorna `created: false`.
 * Após o Omie confirmar, persiste o vínculo em `radar_empresas` via RPC `radar_registrar_cadastro_omie`.
 */
export function useRadarCadastrarOmie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (e: RadarEmpresa): Promise<CadastroOmieResult> => {
      // 1. Criar/buscar no Omie
      const { data, error } = await supabase.functions.invoke('omie-vendas-sync', {
        body: {
          action: 'criar_cliente',
          account: 'oben',
          document: e.cnpj,
          razao_social: e.razao_social || e.nome_fantasia || e.cnpj,
          nome_fantasia: e.nome_fantasia || undefined,
          endereco: e.logradouro || undefined,
          endereco_numero: e.numero || undefined,
          bairro: e.bairro || undefined,
          cidade: e.municipio_nome || undefined,
          estado: e.uf || undefined,
          cep: e.cep || undefined,
          telefone: e.telefone1 || undefined,
        },
      });
      if (error) throw new Error(error.message);
      if (data && data.success === false) {
        throw new Error((data.error as string | undefined) || 'Falha no cadastro Omie');
      }

      const codigo = (data?.codigo_cliente ?? null) as string | number | null;
      const jaExistia = data?.created === false;

      // 2. Persistir o vínculo na radar_empresas
      // TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
      const { error: rpcErr } = await (supabase.rpc as RpcFn)(
        'radar_registrar_cadastro_omie' as never,
        {
          p_cnpj: e.cnpj,
          p_codigo_cliente: codigo != null ? String(codigo) : null,
          p_ja_existia: jaExistia,
        } as never,
      );
      if (rpcErr) throw rpcErr;

      return { codigo_cliente: codigo, ja_existia: jaExistia };
    },
    onSuccess: (r) => {
      track('radar.lead_cadastrado_omie', { ja_existia: r.ja_existia });
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

/**
 * Cria (ou reaproveita) uma tarefa de retomada para o lead do radar.
 * A RPC `radar_atribuir_tarefa` é SECURITY DEFINER gestor/master;
 * retorna { id, deduped } — `deduped: true` quando já havia tarefa aberta.
 */
export function useRadarAtribuirTarefa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { cnpj: string; diasRetomada?: number }) => {
      // TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
      const { data, error } = await (supabase.rpc as RpcFn)(
        'radar_atribuir_tarefa' as never,
        { p_cnpj: v.cnpj, p_dias_retomada: v.diasRetomada ?? 7 } as never,
      );
      if (error) throw error;
      return data as unknown as { id: string; deduped: boolean };
    },
    onSuccess: () => {
      track('radar.tarefa_criada', {});
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

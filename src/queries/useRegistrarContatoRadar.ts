import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';
import { invalidarRadar } from '@/lib/radar/invalidar-cache';
import { lerDesfazer, lerRegistroContato } from '@/lib/radar/borda-rpc';
import type { AcaoContato } from '@/lib/radar/ui-helpers';

/**
 * RPC `registrar_contato_radar`: { id, deduped, notaGravada, retornoEm }. Usada pelo menu individual e pelo lote.
 * `retorno` ('YYYY-MM-DD') só no "em conversa" (pacote G1); sem ele, o servidor usa hoje+7 em dia útil.
 */
export async function registrarContatoRadar(v: { cnpj: string; acao: AcaoContato; nota?: string | null; retorno?: string | null }) {
  // `p_nota` e `p_retorno` têm DEFAULT NULL na prod: ausentes, as chaves saem do JSON e caem no mesmo NULL.
  const args = { p_cnpj: v.cnpj, p_acao: v.acao, p_nota: v.nota ?? undefined, p_retorno: v.retorno ?? undefined };
  let { data, error } = await supabase.rpc('registrar_contato_radar', args);
  // App novo com banco anterior à migration 20261111100000 (Publish antes da migration): a função ainda é a de 3
  // args e o PostgREST não acha a assinatura com p_retorno (PGRST202). O contato não pode se perder por isso:
  // registra sem a data — o banco antigo não tem retorno nenhum, e a resposta (sem retorno_em) diz isso.
  if (error && (error as { code?: string }).code === 'PGRST202' && args.p_retorno !== undefined) {
    ({ data, error } = await supabase.rpc('registrar_contato_radar', { ...args, p_retorno: undefined }));
  }
  if (error) throw error;
  return lerRegistroContato(data, 'registrar_contato_radar');
}

export function useRegistrarContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: registrarContatoRadar,
    onSuccess: (_d, v) => {
      track('radar.contato_registrado', { acao: v.acao, com_nota: Boolean(v.nota?.trim()), com_retorno: Boolean(v.retorno) });
      // Cirúrgica (pacote N): a fila troca só a linha deste lead, não relê as páginas carregadas.
      void invalidarRadar(qc, { cnpj: v.cnpj });
    },
  });
}

/** RPC `desfazer_contato_radar` (usada pelo desfazer individual e pelo "Desfazer" do descarte em lote). */
export async function desfazerContatoRadar(id: string) {
  const { data, error } = await supabase.rpc('desfazer_contato_radar', { p_id: id });
  if (error) throw error;
  return lerDesfazer(data, 'desfazer_contato_radar');
}

export function useDesfazerContatoRadar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; cnpj?: string | null }) => desfazerContatoRadar(v.id),
    // Com o CNPJ, a mesma invalidação cirúrgica do registro (revisão 2026-11-11, item 1): o lead que volta a um
    // recorte de onde saiu (descarte desfeito) cai no ramo "reler" da fila; os selos por página só ficam velhos.
    onSuccess: (_d, v) => { void invalidarRadar(qc, { cnpj: v.cnpj ?? null }); },
  });
}

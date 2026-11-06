import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { isLensActive } from '@/lib/impersonation/lens-write-guard';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { lerAvisoVinculo, type AvisoVinculo, type SuperficieAviso, type VereditoConferencia } from './aviso';

/**
 * Leitura do aviso de vínculo com devedor (`credito_vinculo_aviso`). A RPC roda a regra do vínculo para 1 CNPJ
 * (~0,85 s medido em prod) — por isso staleTime longo e retry 1. Erro ou forma inesperada LANÇA: o componente diz
 * "não consegui verificar", nunca "sem pendência".
 */
export function useAvisoVinculoCredito(cnpj: string | null) {
  return useQuery({
    queryKey: ['credito', 'vinculo-aviso', cnpj],
    enabled: !!cnpj,
    staleTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<AvisoVinculo> => {
      const { data, error } = await supabase.rpc('credito_vinculo_aviso', { p_cnpj: cnpj as string });
      if (error) throw error;
      return lerAvisoVinculo(data);
    },
  });
}

export type ResultadoRegistro = { ok: true; registrado: boolean } | { ok: false; erro: string };

/**
 * O sensor da superfície (`credito_vinculo_aviso_registrar`, único escritor dos eventos no outbox). Sob a lente
 * "Ver como" NÃO chama (o evento sairia atribuído a quem audita). Devolve o desfecho REAL da gravação — o botão só
 * diz "Registrado" com `ok && registrado`.
 */
export async function registrarSensorVinculo(args: {
  evento: 'servido' | 'conferido';
  superficie: SuperficieAviso;
  cnpj: string;
  ref?: number;
  veredito?: VereditoConferencia;
}): Promise<ResultadoRegistro> {
  if (isLensActive()) return { ok: false, erro: 'lente' };
  try {
    const { data, error } = await supabase.rpc('credito_vinculo_aviso_registrar', {
      p_evento: args.evento,
      p_superficie: args.superficie,
      p_cnpj: args.cnpj,
      ...(args.ref !== undefined ? { p_ref: args.ref } : {}),
      ...(args.veredito !== undefined ? { p_veredito: args.veredito } : {}),
    });
    if (error) return { ok: false, erro: mensagemDeErro(error) ?? 'erro ao registrar' };
    const reg = (data as { registrado?: unknown } | null)?.registrado;
    if (typeof reg !== 'boolean') return { ok: false, erro: 'resposta fora da forma esperada' };
    return { ok: true, registrado: reg };
  } catch (e) {
    return { ok: false, erro: mensagemDeErro(e) ?? 'erro ao registrar' };
  }
}

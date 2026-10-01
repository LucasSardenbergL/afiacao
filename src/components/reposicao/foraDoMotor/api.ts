// Leitura do sensor "SKU fora do motor" — a view v_reposicao_sku_fora_do_motor
// (supabase/migrations/20260929003006_reposicao_v_sku_fora_do_motor.sql): SKU que vende e que o motor de
// reposição não lê só porque habilitado_reposicao_automatica está desligado, sem que ninguém tenha
// decidido isso. Usada pelo aviso do cockpit e pelo filtro "Fora do motor" da Revisão de Parâmetros.
// Diagnóstico: docs/historico/sku-fora-do-motor-em-silencio.md.
import { supabase } from "@/integrations/supabase/client";

export const VIEW_FORA_DO_MOTOR = "v_reposicao_sku_fora_do_motor";

// Teto de linhas do PostgREST. A view tinha 4 linhas ao nascer; chegar no teto não é "muitos SKUs",
// é resposta TRUNCADA — e truncar calado é o defeito que este sensor existe para matar.
export const LIMITE_FORA_DO_MOTOR = 1000;

/** Quantos SKUs da empresa vendem e estão fora do motor. Contagem ausente lança (ausente ≠ zero). */
export async function contarForaDoMotor(empresa: string): Promise<number> {
  const { count, error } = await supabase
    .from(VIEW_FORA_DO_MOTOR as never)
    .select("sku_codigo_omie", { count: "exact", head: true })
    .eq("empresa" as never, empresa as never);
  if (error) throw error;
  if (count == null) throw new Error("sensor fora-do-motor: contagem ausente");
  return count;
}

/** SKU → o flag caiu numa inativação do Omie já revertida (evento sku_reativado_omie pendente). */
export async function buscarForaDoMotor(empresa: string): Promise<Map<number, boolean>> {
  const { data, error } = await supabase
    .from(VIEW_FORA_DO_MOTOR as never)
    .select("sku_codigo_omie, reativado_omie_pendente")
    .eq("empresa" as never, empresa as never)
    .order("sku_codigo_omie" as never)
    .range(0, LIMITE_FORA_DO_MOTOR - 1);
  if (error) throw error;
  const linhas = (data ?? []) as unknown as { sku_codigo_omie: number; reativado_omie_pendente: boolean | null }[];
  if (linhas.length >= LIMITE_FORA_DO_MOTOR) {
    throw new Error(`sensor fora-do-motor: ${linhas.length} linhas bateram no teto do PostgREST — lista truncada`);
  }
  return new Map(linhas.map((l) => [Number(l.sku_codigo_omie), l.reativado_omie_pendente === true]));
}

/**
 * Fecha, pelo mesmo RPC da tela de Alertas, os eventos 'sku_reativado_omie' pendentes do SKU — eles
 * perguntam "deseja habilitar a reposição de novo?", e Religar/Descontinuar É a resposta. Devolve
 * quantos fechou. Lança no primeiro erro: quem chama decide se é best-effort.
 */
export async function fecharReativacoesPendentes(
  empresa: string,
  sku: number,
  usuarioEmail: string | null | undefined,
  justificativa: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("eventos_outlier")
    .select("id")
    .eq("empresa", empresa)
    .eq("sku_codigo_omie", String(sku))
    .eq("tipo", "sku_reativado_omie")
    .eq("status", "pendente");
  if (error) throw error;
  let fechados = 0;
  for (const { id } of data ?? []) {
    const { error: erroRpc } = await supabase.rpc("resolver_outlier", {
      p_evento_id: id,
      p_decisao: "aceitar",
      p_justificativa: justificativa,
      p_usuario_email: usuarioEmail ?? undefined,
    });
    if (erroRpc) throw erroRpc;
    fechados += 1;
  }
  return fechados;
}

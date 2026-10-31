// Leituras e escritas dos Alertas de Outlier que não são só "listar a página".
import { supabase } from "@/integrations/supabase/client";
import type { EventoOutlier, GrupoRow, OutlierStats } from "./types";

// Contagem por HEAD (count exato, zero linhas trafegadas). A versão anterior baixava a tabela inteira e
// contava no cliente — o PostgREST capa em 1.000 linhas SEM erro, e a tabela já tem ~500: os cards
// passariam a mentir em silêncio ao cruzar o teto.
async function contar(
  filtrar: (q: ReturnType<typeof baseContagem>) => ReturnType<typeof baseContagem>,
): Promise<number> {
  const { count, error } = await filtrar(baseContagem());
  if (error) throw error;
  if (count === null) throw new Error("Contagem de alertas indisponível");
  return count;
}

function baseContagem() {
  return supabase.from("eventos_outlier").select("id", { count: "exact", head: true });
}

export async function buscarStats(agora: Date = new Date()): Promise<OutlierStats> {
  const inicioDoDia = new Date(agora);
  inicioDoDia.setHours(0, 0, 0, 0);
  const pendentes = (tipo: string) => contar((q) => q.eq("status", "pendente").eq("tipo", tipo));
  const [semGrupo, ltAtipico, ltCriticos, vendaAtipica, inativadoOmie, reativadoOmie, decididosHoje] =
    await Promise.all([
      pendentes("sku_sem_grupo"),
      pendentes("lt_atipico"),
      contar((q) => q.eq("status", "pendente").eq("tipo", "lt_atipico").eq("severidade", "critico")),
      pendentes("venda_atipica"),
      pendentes("sku_inativado_omie"),
      pendentes("sku_reativado_omie"),
      // Só decisão humana: 'resolvido_auto' e 'excluido' (self-heal do sem-grupo) são do robô.
      contar((q) => q.eq("status", "aceito").gte("decidido_em", inicioDoDia.toISOString())),
    ]);
  return { semGrupo, ltAtipico, ltCriticos, vendaAtipica, inativadoOmie, reativadoOmie, decididosHoje };
}

export type ResultadoAtribuicao = {
  atribuidos: number;
  /** SKU e mensagem do primeiro que falhou — o laço para nele; os anteriores já valeram. */
  falha: { sku: string; mensagem: string } | null;
  recalculoFalhou: boolean;
};

/**
 * Classifica SKUs sem grupo num grupo de produção do fornecedor: grava o vínculo, fecha o alerta e
 * recalcula os parâmetros da empresa UMA vez no fim (o LT de produção mudou).
 * Todos os eventos devem ser da mesma empresa — quem agrupa é o chamador.
 */
export async function atribuirGrupoAosSkus({
  empresa, eventos, grupo, usuarioEmail,
}: {
  empresa: string;
  eventos: Pick<EventoOutlier, "id" | "sku_codigo_omie" | "empresa">[];
  grupo: Pick<GrupoRow, "grupo_codigo" | "descricao">;
  usuarioEmail?: string | null;
}): Promise<ResultadoAtribuicao> {
  if (eventos.some((e) => e.empresa !== empresa)) {
    throw new Error("Eventos de empresas diferentes no mesmo lote");
  }
  let atribuidos = 0;
  let falha: ResultadoAtribuicao["falha"] = null;
  for (const ev of eventos) {
    // sku_grupo_producao = (empresa, sku_codigo_omie, grupo_codigo) — conferido na prod 2026-10-18.
    const { error: insErr } = await supabase
      .from("sku_grupo_producao")
      .insert({ empresa, sku_codigo_omie: ev.sku_codigo_omie, grupo_codigo: grupo.grupo_codigo });
    if (insErr) {
      falha = { sku: ev.sku_codigo_omie, mensagem: insErr.message };
      break;
    }
    const { error: resErr } = await supabase.rpc("resolver_outlier", {
      p_evento_id: ev.id,
      p_decisao: "aceitar",
      p_justificativa: `Atribuído ao grupo ${grupo.grupo_codigo} — ${grupo.descricao}`,
      p_usuario_email: usuarioEmail || undefined,
    });
    // O vínculo já gravou: o SKU está classificado. O alerta que sobrar pendente o self-heal do
    // detector fecha no próximo run — por isso conta como atribuído, mas a falha é reportada.
    atribuidos++;
    if (resErr) {
      falha = { sku: ev.sku_codigo_omie, mensagem: resErr.message };
      break;
    }
  }
  let recalculoFalhou = false;
  if (atribuidos > 0) {
    // `rpc` não lança: o erro vem no retorno. O try/catch anterior nunca disparava e o toast dizia
    // "parâmetros recalculados" mesmo quando o recálculo falhava.
    const { error } = await supabase.rpc("atualizar_parametros_numericos_skus", { p_empresa: empresa });
    recalculoFalhou = !!error;
  }
  return { atribuidos, falha, recalculoFalhou };
}

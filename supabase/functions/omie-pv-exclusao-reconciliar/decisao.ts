// Régua PURA da reconciliação de PV excluído no Omie (sem I/O; testes em decisao_test.ts).
//
// Incidente: PV 13693 (Oben, 2026-11-21, limpeza manual no PR #4082) e PV 12231 (codigo_pedido
// 12156020937, achado no diagnóstico do mesmo dia): excluídos direto no Omie, seguiam no app como
// pedido 'enviado'/'importado' contando nas vendas, e a reserva de estoque ficava 'ativa' para sempre.
//
// Precisão > recall (money-path §1): só a AUSÊNCIA AFIRMADA do PV consultado vira "ausente".
// Transitório, rate limit, corpo ilegível, fault de outra entidade, código divergente ou qualquer
// coisa que a régua não reconheça = "indeterminado" — nada muda no app.
import { classificarResposta, type RespostaOmie } from "../_shared/omie-cliente.ts";

export type Consulta =
  | { tipo: "existe"; codigoPedido: number; numeroPedido: string | null; etapa: string | null; cancelado: string | null }
  | { tipo: "ausente"; fault: string }
  | { tipo: "indeterminado"; detalhe: string };

// Mesmo núcleo da régua da exclusão pelo app (`_shared/atp-pv-omie.ts`): "pedido" + a negação colada a
// cadastrado/encontrado. "Cliente não cadastrado", "Aplicativo não encontrado" não casam.
const PEDIDO_NAO_ENCONTRADO = /pedido[^.;\n]{0,60}n[aã]o (cadastrad|encontrad)/i;

/** O fault cita o código consultado entre colchetes? Texto real medido em 2026-11-21:
 *  `ERROR: Pedido não cadastrado para o Código [12156020937] !`. Sem o código, a negação pode ser de
 *  OUTRO pedido (ou de um parâmetro que o Omie não leu) — não é ausência DESTE PV. */
function citaCodigo(fault: string, codigoPedido: number): boolean {
  return new RegExp(`\\[\\s*${codigoPedido}\\s*\\]`).test(fault);
}

function codigoDoCabecalho(corpo: Record<string, unknown> | null): { cab: Record<string, unknown> | null; info: Record<string, unknown> | null } {
  const pvp = corpo?.pedido_venda_produto as Record<string, unknown> | undefined;
  const cab = (pvp?.cabecalho ?? corpo?.cabecalho) as Record<string, unknown> | undefined;
  const info = (pvp?.infoCadastro ?? corpo?.infoCadastro) as Record<string, unknown> | undefined;
  return { cab: cab && typeof cab === "object" ? cab : null, info: info && typeof info === "object" ? info : null };
}

/** Resposta de `ConsultarPedido({ codigo_pedido })` devolvida por `chamarOmie` (leitura). */
export function classificarConsulta(r: RespostaOmie, codigoPedido: number): Consulta {
  if (!Number.isSafeInteger(codigoPedido) || codigoPedido <= 0) {
    return { tipo: "indeterminado", detalhe: `código consultado inválido (${codigoPedido})` };
  }
  // `chamarOmie` devolve a ÚLTIMA resposta quando a retentativa de leitura esgota: ela pode ser
  // transitória/rate limit. Só a resposta FINAL é lida como fato.
  const classe = classificarResposta(r);
  if (classe !== "final") return { tipo: "indeterminado", detalhe: `resposta ${classe} (HTTP ${r.status})` };

  if (r.faultstring !== null) {
    const f = r.faultstring;
    if (PEDIDO_NAO_ENCONTRADO.test(f) && citaCodigo(f, codigoPedido)) return { tipo: "ausente", fault: f.slice(0, 300) };
    return { tipo: "indeterminado", detalhe: `fault não reconhecido: ${f.slice(0, 200)}` };
  }
  if (!r.ok) return { tipo: "indeterminado", detalhe: `HTTP ${r.status} sem faultstring` };

  const { cab, info } = codigoDoCabecalho(r.corpo);
  const cod = cab?.codigo_pedido;
  if (typeof cod === "number" && cod === codigoPedido) {
    const num = cab?.numero_pedido;
    const etapa = cab?.etapa;
    const canc = info?.cancelado;
    return {
      tipo: "existe",
      codigoPedido: cod,
      numeroPedido: typeof num === "string" || typeof num === "number" ? String(num) : null,
      etapa: typeof etapa === "string" ? etapa : null,
      cancelado: typeof canc === "string" ? canc : null,
    };
  }
  return { tipo: "indeterminado", detalhe: `resposta sem o codigo_pedido consultado (${JSON.stringify(cod ?? null)})` };
}

/** Exceção de `chamarOmie` (rede, timeout, sem tempo): nunca é ausência. */
export function classificarErro(detalhe: string): Consulta {
  return { tipo: "indeterminado", detalhe: detalhe.slice(0, 300) };
}

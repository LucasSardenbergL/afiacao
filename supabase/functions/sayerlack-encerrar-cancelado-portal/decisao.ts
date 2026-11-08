// Decisões puras da edge `sayerlack-encerrar-cancelado-portal` (5.3). Sem I/O: testadas em `decisao_test.ts`.

/** O que a consulta dirigida ao Omie (`ConsultarPedCompra` por `cCodIntPed`) provou. */
export type ConsultaPo =
  | { tipo: "existe"; id: string; numero: string }
  | { tipo: "ausente"; fault: string }
  | { tipo: "indeterminado"; detalhe: string };

/** Recorte de `RespostaOmie` (`_shared/omie-cliente.ts`) que a classificação usa. */
export interface RespostaConsulta {
  status: number;
  corpo: Record<string, unknown> | null;
  faultstring: string | null;
}

function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Formatos ESTRITOS, ancorados na mensagem INTEIRA (Codex 5.3 rodada 2, P1): o fault só prova ausência se for, de ponta
 * a ponta, "pedido (de compra) não cadastrado/encontrado (para o código de integração) [AFI-<id>]" ou "não existe
 * pedido (de compra) (cadastrado) com/para o código de integração [AFI-<id>]". "Pedido AFI-123: fornecedor não
 * cadastrado" e "Erro ao consultar pedido AFI-123: não existe conexão" NÃO casam; o código tem de ser o token inteiro.
 */
function formatosDeAusencia(codigo: string): RegExp[] {
  const c = `\\[?${escaparRegex(codigo)}\\]?(?![\\w-])`;
  const fim = "\\s*[!.]?\\s*$";
  const erro = "^(?:error:\\s*)?";
  return [
    new RegExp(`${erro}(?:o\\s+)?pedido(?:\\s+de\\s+compra)?\\s+n[aã]o\\s+(?:foi\\s+)?(?:cadastrad|encontrad)[oa](?:\\s+(?:para|com)\\s+o\\s+c[oó]digo\\s+de\\s+integra[cç][aã]o)?\\s*:?\\s*${c}${fim}`, "i"),
    new RegExp(`${erro}n[aã]o\\s+(?:existe|foi\\s+encontrado)\\s+(?:nenhum\\s+)?pedido(?:\\s+de\\s+compra)?(?:\\s+cadastrado)?\\s+(?:com|para)\\s+o\\s+c[oó]digo\\s+de\\s+integra[cç][aã]o\\s*:?\\s*${c}${fim}`, "i"),
  ];
}

/**
 * Só a resposta que AFIRMA a ausência DESTE pedido vira "ausente" (Codex desenho P1 #4): fault de negócio num corpo
 * JSON legível, negação colada a "pedido" E o próprio código de integração citado no fault — "Pedido de compra:
 * fornecedor não cadastrado" não cita o AFI-<id> e não prova nada. Sem amostra real do fault de compras no banco, a
 * exigência do código é o que impede uma mensagem genérica de virar prova; o fault cru vai para a trilha.
 * Qualquer outra coisa (rede, HTTP sem JSON, transitório, fault desconhecido) é INDETERMINADO: nada se encerra.
 */
export function classificarConsultaPo(
  resposta: RespostaConsulta | null,
  erro: string | null,
  codigoIntegracao: string,
): ConsultaPo {
  if (!resposta) return { tipo: "indeterminado", detalhe: erro ?? "sem resposta do Omie" };
  const fault = resposta.faultstring?.trim() ?? "";
  if (!fault) {
    const corpo = resposta.corpo;
    const cab = (corpo?.pedido_compra_cabecalho ?? corpo?.cabecalho ?? corpo?.cabecalho_consulta ?? corpo) as
      | Record<string, unknown>
      | null
      | undefined;
    const id = cab?.nCodPed ?? corpo?.nCodPed;
    if (resposta.status >= 200 && resposta.status < 300 && id != null && String(id).trim() !== "") {
      const numero = cab?.cNumero ?? corpo?.cNumero;
      return { tipo: "existe", id: String(id), numero: numero != null ? String(numero) : "" };
    }
    return { tipo: "indeterminado", detalhe: `resposta sem fault e sem nCodPed (HTTP ${resposta.status})` };
  }
  if (resposta.corpo === null) return { tipo: "indeterminado", detalhe: `fault sem corpo JSON: ${fault.slice(0, 200)}` };
  const normal = fault.replace(/\s+/g, " ");
  // O fault INTEIRO vai para a prova (a trilha tem de mostrar o que casou — Codex P2); só a apresentação trunca.
  if (formatosDeAusencia(codigoIntegracao).some((re) => re.test(normal))) return { tipo: "ausente", fault: fault.slice(0, 2000) };
  return { tipo: "indeterminado", detalhe: fault.slice(0, 2000) };
}

/** Linha do pedido que a edge lê antes de gastar a chamada ao Omie. */
export interface PedidoLido {
  id: number;
  empresa: string | null;
  status: string | null;
  status_envio_portal: string | null;
  portal_protocolo: string | null;
  omie_pedido_compra_id: string | number | null;
  disparo_claim_em: string | null;
  portal_situacao_codigo: string | null;
  portal_situacao_protocolo: string | null;
}

/**
 * Pré-condições na edge (as MESMAS da RPC, que revalida tudo sob FOR UPDATE): poupam a chamada ao Omie e dão a
 * mensagem certa. null = pode consultar. A ordem dos motivos é a da RPC.
 */
export function motivoRecusaPrevia(p: PedidoLido | null): string | null {
  if (!p) return "pedido_nao_encontrado";
  if (p.empresa !== "OBEN" || !(p.portal_protocolo ?? "").trim()) return "sem_protocolo_do_portal";
  if (p.status !== "aprovado_aguardando_disparo" && p.status !== "falha_envio") return "status_nao_encerravel";
  if (p.status_envio_portal !== "sucesso_portal") return "portal_nao_confirmado";
  const po = p.omie_pedido_compra_id == null ? "" : String(p.omie_pedido_compra_id).trim();
  if (po !== "" && po !== "0") return "tem_po";
  if (p.portal_situacao_codigo !== "6" || p.portal_situacao_protocolo !== p.portal_protocolo) return "nao_cancelado_no_portal";
  if (p.disparo_claim_em) return "disparo_pendente";
  return null;
}

/** Texto para o humano, por motivo de recusa (da edge ou da RPC). */
export function mensagemDoMotivo(motivo: string, extra: { protocolo?: string | null; numeroPo?: string } = {}): string {
  const prot = extra.protocolo ? ` ${extra.protocolo}` : "";
  switch (motivo) {
    case "pedido_nao_encontrado": return "Pedido não encontrado.";
    case "sem_protocolo_do_portal": return "Este pedido não tem protocolo do portal Sayerlack da OBEN.";
    case "status_nao_encerravel": return "O pedido não está mais aguardando disparo — nada a encerrar por aqui.";
    case "portal_nao_confirmado": return "O envio ao portal não está confirmado (sucesso) — aguarde o desfecho ou concilie.";
    case "tem_po": return "O pedido já tem pedido de compra no Omie: cancele o PO no Omie e use a correção de cancelamento pós-disparo.";
    case "nao_cancelado_no_portal":
      return `A última leitura do portal não diz "Cancelado" para o protocolo${prot}. Espere a próxima varredura (12:30, 17:30, 22:30) ler o cancelamento.`;
    case "disparo_pendente":
      return "Há uma tentativa de disparo sem desfecho para este pedido: um pedido de compra pode ter sido criado no Omie. " +
        "O disparador concilia por consulta; não encerre antes disso.";
    case "po_no_espelho":
      return `Existe pedido de compra no espelho do Omie com o código do app ou o protocolo${prot} no contrato. Cancele-o no Omie primeiro.`;
    case "po_existe_no_omie":
      return `O Omie confirmou o pedido de compra ${extra.numeroPo || ""} com o código deste pedido, mas o app não tem o ` +
        "vínculo: o pedido NÃO foi encerrado. O PO precisa ser conciliado com este pedido (vínculo manual) antes de " +
        "qualquer cancelamento — confira no Omie e cancele o PO lá se o fornecedor cancelou.";
    default: return `Encerramento recusado (${motivo}).`;
  }
}

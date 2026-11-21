// Idempotência da OS de Afiação (follow-up Codex do #4042). A OS duplicava quando o Omie aceitava o
// `IncluirOS` e a resposta se perdia antes de chegar ao navegador: a chave levava `Date.now()` e o
// front mandava um `orderId` novo a cada envio, então o Omie nunca reconhecia o reenvio.
//
// Agora o front manda o `checkoutId` do envelope como `orderId` (estável entre reenvios do MESMO
// checkout). A chave daqui é função PURA dele, e a edge reserva o pedido em `afiacao_os_envio`
// (PK order_id) ANTES de chamar o Omie, com a assinatura do que foi pedido na 1ª tentativa
// (migration 20261121120002). Este módulo é só a parte pura, testada em Deno (chave-os_test.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `cCodIntOS` determinístico do pedido. 25 caracteres = o comprimento já aceito e ecoado inteiro
 *  pelo Omie em produção (`OS_<8hex>_<13 dígitos>`), mesmo a documentação declarando `string 60`:
 *  prova servida vence documento. 22 hex do UUID ≈ 82 bits aleatórios — colisão desprezível.
 *  Lança em orderId que não é UUID (fail-closed: chave curta reconciliaria a OS de OUTRO pedido). */
export function chaveIntegracaoOS(orderId: unknown): string {
  if (typeof orderId !== "string" || !UUID.test(orderId)) {
    throw new Error(`orderId inválido para a chave da OS (precisa ser UUID): ${JSON.stringify(orderId)}`);
  }
  return `OS_${orderId.replace(/-/g, "").toLowerCase().slice(0, 22)}`;
}

function centavos(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100)) : "?";
}

/** Assinatura do que este envio PEDE: a assinatura do front (#4042 — ferramenta + serviço +
 *  quantidade + pagamento + entrega) somada ao que só o payload sabe — cliente Omie, preço unitário
 *  de cada item, frete e total, em centavos. Sem a assinatura do front (build antigo do app em
 *  cache) devolve `null`: um pedido sem assinatura nunca "confere" com nada. */
export function montarAssinaturaOS(
  assinaturaFront: unknown,
  omieCodigoCliente: number,
  orderData: {
    items?: Array<{ userToolId?: unknown; omie_codigo_servico?: unknown; quantity?: unknown; unitPrice?: unknown }>;
    delivery_fee?: unknown;
    total?: unknown;
    payment_method?: unknown;
  },
): string | null {
  if (typeof assinaturaFront !== "string" || assinaturaFront.trim() === "") return null;
  const itens = (orderData.items ?? [])
    .map((i) => `${String(i.userToolId ?? "-")}:${String(i.omie_codigo_servico ?? "-")}:${String(i.quantity ?? "-")}:${centavos(i.unitPrice)}`)
    .sort()
    .join("|");
  return [
    assinaturaFront,
    `cli=${omieCodigoCliente}`,
    `itens=${itens}`,
    `pg=${String(orderData.payment_method ?? "-")}`,
    `frete=${centavos(orderData.delivery_fee)}`,
    `tot=${centavos(orderData.total)}`,
  ].join("#");
}

export type Conferencia = "confere" | "diverge" | "indeterminada";

/** O envio de AGORA é o mesmo que reservou o pedido? Assinatura ausente de qualquer lado =
 *  `indeterminada` (não dá para afirmar nem negar — o vendedor confere no Omie); diferente =
 *  `diverge`; cliente Omie diferente = `diverge` mesmo com assinatura ausente. */
export function conferirReserva(
  reserva: { assinatura: string | null; omie_codigo_cliente: number | string },
  atual: { assinatura: string | null; omieCodigoCliente: number },
): Conferencia {
  if (Number(reserva.omie_codigo_cliente) !== atual.omieCodigoCliente) return "diverge";
  if (reserva.assinatura === null || atual.assinatura === null) return "indeterminada";
  return reserva.assinatura === atual.assinatura ? "confere" : "diverge";
}

export type LeituraConsultaOS =
  | { tipo: "ok"; nCodOS: number; cNumOS: string }
  | { tipo: "cancelada"; nCodOS: number; cNumOS: string }
  | { tipo: "invalida"; motivo: string };

/** Lê a resposta do `ConsultarOS {cCodIntOS}` e só aceita a OS se ela for, comprovadamente, a
 *  deste pedido: código positivo, a MESMA chave ecoada e o MESMO cliente. Qualquer coisa fora disso
 *  é `invalida` (o chamador preserva o erro original — nunca confirma uma OS que não é a nossa). */
export function lerConsultaOS(resposta: unknown, chave: string, omieCodigoCliente: number): LeituraConsultaOS {
  const r = (resposta ?? {}) as Record<string, unknown>;
  const cab = (r.Cabecalho ?? {}) as Record<string, unknown>;
  const nCodOS = Number(cab.nCodOS);
  if (!Number.isFinite(nCodOS) || nCodOS <= 0) return { tipo: "invalida", motivo: "sem nCodOS positivo" };
  if (cab.cCodIntOS !== chave) return { tipo: "invalida", motivo: `chave ecoada ${JSON.stringify(cab.cCodIntOS)} ≠ ${chave}` };
  if (Number(cab.nCodCli) !== omieCodigoCliente) {
    return { tipo: "invalida", motivo: `cliente da OS ${JSON.stringify(cab.nCodCli)} ≠ ${omieCodigoCliente}` };
  }
  const cNumOS = cab.cNumOS !== undefined && cab.cNumOS !== null && String(cab.cNumOS) !== "" ? String(cab.cNumOS) : chave;
  const info = (r.InfoCadastro ?? {}) as Record<string, unknown>;
  if (String(info.cCancelada ?? "").toUpperCase() === "S") return { tipo: "cancelada", nCodOS, cNumOS };
  return { tipo: "ok", nCodOS, cNumOS };
}

/** A resposta do `IncluirOS` prova a criação? Exige código positivo e, quando o Omie ecoa a
 *  chave, que seja a nossa. `200 {}` passava pelo wrapper e o `result.nCodOS!` só existia no tipo. */
export function inclusaoValida(resposta: unknown, chave: string): { nCodOS: number; cNumOS: string } | null {
  const r = (resposta ?? {}) as Record<string, unknown>;
  const nCodOS = Number(r.nCodOS);
  if (!Number.isFinite(nCodOS) || nCodOS <= 0) return null;
  if (r.cCodIntOS !== undefined && r.cCodIntOS !== chave) return null;
  const cNumOS = r.cNumOS !== undefined && r.cNumOS !== null && String(r.cNumOS) !== "" ? String(r.cNumOS) : chave;
  return { nCodOS, cNumOS };
}

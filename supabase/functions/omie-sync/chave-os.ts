// Idempotência da OS de Afiação (follow-up Codex do #4042). A OS duplicava quando o Omie aceitava o
// `IncluirOS` e a resposta se perdia antes de chegar ao navegador: a chave levava `Date.now()` e o
// front mandava um `orderId` novo a cada envio, então o Omie nunca reconhecia o reenvio.
//
// Agora o front manda o `checkoutId` do envelope como `orderId` (estável entre reenvios do MESMO
// checkout). A chave daqui é função PURA dele, e a edge reserva o pedido em `afiacao_os_envio`
// (PK order_id) ANTES de chamar o Omie, com a assinatura do que foi pedido na 1ª tentativa
// (migration 20261121120002). Este módulo é só a parte pura, testada em Deno (os-idempotente_test.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `cCodIntOS` determinístico do CONTEÚDO do pedido: hash de (orderId, cliente Omie, assinatura).
 *  Mesmo checkout + mesmo carrinho → mesma chave → o Omie reconhece o reenvio. Carrinho diferente →
 *  chave diferente: uma OS de outro carrinho NUNCA é achada pela chave deste (Codex, diff do
 *  #4042-follow-up: com a chave só do checkout, a OS do carrinho A "conferia" com o B).
 *  25 caracteres = o comprimento já aceito e ecoado inteiro pelo Omie em produção; 22 hex = 88 bits.
 *  Lança em orderId que não é UUID (fail-closed). */
export async function chaveIntegracaoOS(orderId: unknown, omieCodigoCliente: number, assinatura: string): Promise<string> {
  if (typeof orderId !== "string" || !UUID.test(orderId)) {
    throw new Error(`orderId inválido para a chave da OS (precisa ser UUID): ${JSON.stringify(orderId)}`);
  }
  const base = `${orderId.toLowerCase()}|${omieCodigoCliente}|${assinatura}`;
  const dig = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base)));
  const hex = Array.from(dig, (b) => b.toString(16).padStart(2, "0")).join("");
  return `OS_${hex.slice(0, 22)}`;
}

function centavos(v: unknown): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n * 100)) : "?";
}

/** Assinatura do que este envio PEDE: a assinatura do front (#4042 — ferramenta + serviço +
 *  quantidade + preço + pagamento + entrega) somada ao que o payload diz — cliente Omie, preço
 *  unitário de cada item, frete e total, em centavos. Nunca `null`: o build antigo do app (em cache,
 *  sem a assinatura do front) cai em "legado" mas segue comparado pelo PAYLOAD — sem isso, dois
 *  carrinhos de valores diferentes do mesmo pedido gerariam a mesma chave (Codex, 3ª rodada). */
export function montarAssinaturaOS(
  assinaturaFront: unknown,
  omieCodigoCliente: number,
  orderData: {
    items?: Array<{ userToolId?: unknown; omie_codigo_servico?: unknown; quantity?: unknown; unitPrice?: unknown }>;
    delivery_fee?: unknown;
    total?: unknown;
    payment_method?: unknown;
  },
): string {
  const front = typeof assinaturaFront === "string" && assinaturaFront.trim() !== "" ? assinaturaFront : "legado";
  const itens = (orderData.items ?? [])
    .map((i) => `${String(i.userToolId ?? "-")}:${String(i.omie_codigo_servico ?? "-")}:${String(i.quantity ?? "-")}:${centavos(i.unitPrice)}`)
    .sort()
    .join("|");
  return [
    front,
    `cli=${omieCodigoCliente}`,
    `itens=${itens}`,
    `pg=${String(orderData.payment_method ?? "-")}`,
    `frete=${centavos(orderData.delivery_fee)}`,
    `tot=${centavos(orderData.total)}`,
  ].join("#");
}

export type Conferencia = "confere" | "diverge";

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
  const nCodOS = cab.nCodOS;
  if (typeof nCodOS !== "number" || !Number.isSafeInteger(nCodOS) || nCodOS <= 0) {
    return { tipo: "invalida", motivo: "sem nCodOS inteiro positivo" };
  }
  if (cab.cCodIntOS !== chave) return { tipo: "invalida", motivo: `chave ecoada ${JSON.stringify(cab.cCodIntOS)} ≠ ${chave}` };
  if (Number(cab.nCodCli) !== omieCodigoCliente) {
    return { tipo: "invalida", motivo: `cliente da OS ${JSON.stringify(cab.nCodCli)} ≠ ${omieCodigoCliente}` };
  }
  const cNumOS = cab.cNumOS !== undefined && cab.cNumOS !== null && String(cab.cNumOS) !== "" ? String(cab.cNumOS) : chave;
  const info = (r.InfoCadastro ?? {}) as Record<string, unknown>;
  const cancelada = String(info.cCancelada ?? "").toUpperCase();
  if (cancelada === "S") return { tipo: "cancelada", nCodOS, cNumOS };
  // Só "N" reconhecido afirma OS ativa — ausente/desconhecido não confirma nada (Codex P2).
  if (cancelada !== "N") return { tipo: "invalida", motivo: `cCancelada ${JSON.stringify(info.cCancelada)} não reconhecido` };
  return { tipo: "ok", nCodOS, cNumOS };
}

/** A resposta do `IncluirOS` prova a criação? Exige código inteiro positivo e o eco EXATO da
 *  chave (o Omie ecoa — ver `resposta_omie` em prod). Incompleta → o chamador consulta pela chave.
 *  `200 {}` passava pelo wrapper e o `result.nCodOS!` só existia no tipo. */
export function inclusaoValida(resposta: unknown, chave: string): { nCodOS: number; cNumOS: string } | null {
  const r = (resposta ?? {}) as Record<string, unknown>;
  const nCodOS = r.nCodOS;
  if (typeof nCodOS !== "number" || !Number.isSafeInteger(nCodOS) || nCodOS <= 0) return null;
  if (r.cCodIntOS !== chave) return null;
  const cNumOS = r.cNumOS !== undefined && r.cNumOS !== null && String(r.cNumOS) !== "" ? String(r.cNumOS) : chave;
  return { nCodOS, cNumOS };
}

/** A falha do `ConsultarOS` afirma a ausência DA OS (e não de outra entidade — "Cliente/Vendedor não
 *  cadastrado" casariam um marcador genérico; Codex, 3ª rodada)? Exige "ordem de serviço" + negação,
 *  normalizado em ASCII. Mensagem que não casa = "não sei" — fail-closed: não reabre nada. */
export function ausenciaDaOS(mensagem: string): boolean {
  const t = mensagem.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!t.includes("ordem de servico")) return false;
  return ["nao cadastrad", "nao encontrad", "nao existe"].some((m) => t.includes(m));
}

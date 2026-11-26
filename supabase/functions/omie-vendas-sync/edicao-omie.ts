// O que a EDIÇÃO de um pedido do app (`alterar_pedido`) pode mandar ao Omie, e quando ela é recusada.
// Puro (zero Deno/DB): provado por `deno test supabase/functions/omie-vendas-sync/edicao-omie_test.ts`.
//
// Por que existe (revisão Codex+Fable de 2026-11-25 da tela de edição em /sales; plano revisado pelo
// Codex em 2026-11-26):
//   • o AlterarPedidoVenda da edição mandava `etapa: "10"`, `data_previsao` = HOJE e um frete montado
//     do zero (modalidade "0", espécie "VOL") — salvar só uma observação podia REGREDIR a etapa no ERP,
//     trocar a previsão e apagar transportadora/volumes/valor do frete gravados no Omie;
//   • o recibo do app (`hash_payload` NULL) cujo espelho importado do MESMO `(account, omie_pedido_id)`
//     já está em separação/faturado seguia editável: a edge relê pelo id local e substitui os itens no
//     ERP. Medido em 2026-11-26 (psql-ro): 19 dos 25 recibos com PV estão `enviado` no app com o gêmeo
//     `faturado` (R$ 11.565,88), 2 deles com o PV reaproveitado no Omie para OUTRO cliente;
//   • os 25 recibos têm `customer_document` NULL, então a verificação de identidade da edição
//     (`deriveOmieAccountIdentity`) era pulada: nada impedia substituir os itens de um PV que hoje é
//     de outro cliente. A âncora que existe é o `codigo_cliente` que o PRÓPRIO app mandou ao criar o
//     PV (20 de 25 o têm no `omie_payload`; os 5 sem ele têm o gêmeo faturado).

/** Etapas do Omie em que o app ainda edita o pedido: 10 (pedido) e 20 (separar estoque). Restrição de
 *  PRODUTO assumida (o Omie aceita alterar em 50): em 50 o pedido já está em separação para faturar;
 *  60/70 faturado; 80 cancelado. Mesmo mapa de `_shared/omie-pedido.ts` (`omieEtapaToStatus`). */
export const ETAPAS_EDITAVEIS: readonly string[] = ["10", "20"];

/** Status do ESPELHO importado (o que o sync gravou a partir da etapa) em que o app ainda edita. */
export const STATUS_GEMEO_EDITAVEIS: readonly string[] = ["importado", "enviado"];

/** Status do PRÓPRIO pedido em que a edge recusa — a mesma lista do front (`BLOCKED_STATUSES` em
 *  `src/components/salesOrderEdit/types.ts`); a trava do React não protege uma tela antiga aberta. */
export const STATUS_PEDIDO_NAO_EDITAVEIS: readonly string[] = ["cancelado", "entregue", "faturado", "importado"];

export type BloqueioEdicao =
  | "conta_desconhecida"
  | "origem_omie"
  | "status_pedido"
  | "gemeo_omie"
  | "etapa_omie"
  | "leitura_omie_incompleta"
  | "cliente_omie";

export type VereditoEdicao =
  | { permitido: true }
  | { permitido: false; bloqueio: BloqueioEdicao; motivo: string };

/** O pedido local, ANTES de ler o Omie: conta conhecida, origem do app e status editável. */
export function vereditoPedidoLocalEdicao(input: {
  account: unknown;
  hashPayload: string | null;
  status: string | null;
}): VereditoEdicao {
  if (input.account !== "oben" && input.account !== "colacor") {
    return {
      permitido: false,
      bloqueio: "conta_desconhecida",
      motivo: `a conta do pedido é desconhecida (${String(input.account)}) — nada foi alterado.`,
    };
  }
  if (input.hashPayload !== null && input.hashPayload.startsWith("omie_")) {
    return {
      permitido: false,
      bloqueio: "origem_omie",
      motivo: "pedido importado do Omie: o app só espelha. Para alterar, altere no Omie.",
    };
  }
  if (!input.status || STATUS_PEDIDO_NAO_EDITAVEIS.includes(input.status)) {
    return {
      permitido: false,
      bloqueio: "status_pedido",
      motivo: `o pedido está com status "${input.status ?? "desconhecido"}" e não pode ser editado.`,
    };
  }
  return { permitido: true };
}

/** Espelho importado do mesmo PV, como lido de `sales_orders`. */
export interface GemeoLido {
  status: string | null;
}

/**
 * Recibo do app × espelho importado do mesmo PV. Sem gêmeo → permitido (o sync ainda não trouxe o PV;
 * a etapa e o cliente VIVOS ainda são conferidos no ConsultarPedido). O cliente NÃO se compara por
 * UUID aqui: o gêmeo pode estar sob o alias fiscal do mesmo cliente (Colacor SC × Oben) — quem prova
 * o cliente é o `codigo_cliente` vivo contra a âncora do recibo (`vereditoClienteEdicao`).
 */
export function vereditoGemeoEdicao(gemeo: GemeoLido | null): VereditoEdicao {
  if (!gemeo) return { permitido: true };
  if (!gemeo.status || !STATUS_GEMEO_EDITAVEIS.includes(gemeo.status)) {
    return {
      permitido: false,
      bloqueio: "gemeo_omie",
      motivo: `o pedido já avançou no Omie (status "${gemeo.status ?? "desconhecido"}") — altere direto no Omie.`,
    };
  }
  return { permitido: true };
}

/** `codigo_cliente` que o app mandou ao criar o PV (âncora do recibo), ou null se não houver. */
export function codigoClienteDoPayload(omiePayload: unknown): number | null {
  const cab = (omiePayload as { cabecalho?: { codigo_cliente?: unknown } } | null | undefined)?.cabecalho;
  const n = Number(cab?.codigo_cliente);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * O PV vivo ainda é do cliente para quem o app o criou? Sem âncora ou sem o cliente vivo, recusa:
 * a edição EXCLUI e reinclui todos os itens, e sem prova pode ser o pedido de outra pessoa
 * (PV reaproveitado no Omie — `docs/historico/gemeos-push-pull-contagem-unica.md`).
 */
export function vereditoClienteEdicao(input: {
  codigoClienteAncora: number | null;
  codigoClienteVivo: number | null;
}): VereditoEdicao {
  if (input.codigoClienteAncora === null || input.codigoClienteVivo === null) {
    return {
      permitido: false,
      bloqueio: "cliente_omie",
      motivo: input.codigoClienteAncora === null
        ? "não há registro do cliente para quem o app criou este pedido no Omie — não dá para provar que o PV ainda é dele. Altere direto no Omie."
        : "a leitura do pedido no Omie veio sem o cliente — nada foi alterado. Tente de novo; se repetir, altere no Omie.",
    };
  }
  if (input.codigoClienteAncora !== input.codigoClienteVivo) {
    return {
      permitido: false,
      bloqueio: "cliente_omie",
      motivo: "o número deste pedido no Omie está hoje com outro cliente (PV reaproveitado) — confira e altere direto no Omie.",
    };
  }
  return { permitido: true };
}

/** O que a edição precisa ler do ConsultarPedido para não fabricar cabeçalho, frete nem classificação. */
export interface CabecalhoLido {
  etapa: string | null;
  dataPrevisao: string | null;
  /** `infoCadastro.cancelado`/`faturado` como vieram: 'S', 'N' ou null (ausente/ilegível). */
  cancelado: string | null;
  faturado: string | null;
  frete: Record<string, unknown> | null;
  categoria: string | null;
  contaCorrente: number | null;
  codVend: number | null;
}

type ConsultaCrua = {
  pedido_venda_produto?: ConsultaCrua;
  cabecalho?: { etapa?: unknown; data_previsao?: unknown };
  frete?: unknown;
  infoCadastro?: { cancelado?: unknown; faturado?: unknown };
  informacoes_adicionais?: { codigo_categoria?: unknown; codigo_conta_corrente?: unknown; codVend?: unknown };
} | null | undefined;

function textoOuNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function inteiroPositivoOuNull(v: unknown): number | null {
  const n = Number(v);
  return v != null && v !== "" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function marcaSN(v: unknown): string | null {
  return v === "S" || v === "N" ? v : null;
}

/** Lê etapa, previsão, frete, classificação e as marcas de cancelado/faturado. Mesmo drift de shape do
 *  `det`: aninhado em `pedido_venda_produto` ou no topo. Ausente fica `null` — nunca um default. */
export function lerCabecalhoParaEdicao(consulta: ConsultaCrua): CabecalhoLido {
  const pv = consulta?.pedido_venda_produto ?? null;
  const cab = pv?.cabecalho ?? consulta?.cabecalho;
  const freteCru = pv?.frete ?? consulta?.frete;
  const info = pv?.infoCadastro ?? consulta?.infoCadastro;
  const adic = pv?.informacoes_adicionais ?? consulta?.informacoes_adicionais;
  return {
    etapa: textoOuNull(cab?.etapa),
    dataPrevisao: textoOuNull(cab?.data_previsao),
    cancelado: marcaSN(info?.cancelado),
    faturado: marcaSN(info?.faturado),
    frete: freteCru && typeof freteCru === "object" && !Array.isArray(freteCru)
      ? { ...(freteCru as Record<string, unknown>) }
      : null,
    categoria: textoOuNull(adic?.codigo_categoria),
    contaCorrente: inteiroPositivoOuNull(adic?.codigo_conta_corrente),
    codVend: inteiroPositivoOuNull(adic?.codVend),
  };
}

/**
 * Pode editar pelo estado VIVO do Omie? Roda ANTES de qualquer mutação no ERP. Leitura incompleta
 * também recusa: sem etapa/previsão/frete o cabeçalho reenviado seria inventado, e sem a marca
 * EXPLÍCITA `cancelado = 'N'` não dá para descartar o cancelado congelado em etapa 10/20 (o Omie
 * congela o cancelado na etapa em que estava — `_shared/omie-pedido.ts` `canceladoNoOmie`).
 */
export function vereditoEtapaEdicao(lido: CabecalhoLido): VereditoEdicao {
  if (lido.cancelado === "S") {
    return { permitido: false, bloqueio: "etapa_omie", motivo: "o pedido está cancelado no Omie." };
  }
  if (lido.faturado === "S") {
    return { permitido: false, bloqueio: "etapa_omie", motivo: "o pedido já foi faturado no Omie." };
  }
  const falta = [
    lido.etapa === null ? "etapa" : null,
    lido.dataPrevisao === null ? "data de previsão" : null,
    lido.frete === null ? "frete" : null,
    lido.cancelado === null ? "situação de cancelamento" : null,
  ].filter(Boolean);
  if (falta.length > 0) {
    return {
      permitido: false,
      bloqueio: "leitura_omie_incompleta",
      motivo: `a leitura do pedido no Omie veio sem ${falta.join(", ")} — nada foi alterado. Tente de novo; se repetir, altere no Omie.`,
    };
  }
  if (!ETAPAS_EDITAVEIS.includes(lido.etapa as string)) {
    return {
      permitido: false,
      bloqueio: "etapa_omie",
      motivo: `o pedido já está na etapa ${lido.etapa} no Omie (separação/faturamento) — altere direto no Omie.`,
    };
  }
  return { permitido: true };
}

/** Cabeçalho do AlterarPedidoVenda: etapa e previsão são as LIDAS (a edição não as muda); só a
 *  parcela é do vendedor. `codigo_cliente` vai junto só para o write-back local guardar a âncora
 *  (o payload regravado pela edição a perdia). Exige leitura aprovada por `vereditoEtapaEdicao`. */
export function cabecalhoDaEdicao(input: {
  codigoPedido: number;
  lido: CabecalhoLido;
  codigoParcela: string;
}): Record<string, unknown> {
  if (input.lido.etapa === null || input.lido.dataPrevisao === null) {
    throw new Error("cabecalhoDaEdicao: leitura sem etapa/previsão — vereditoEtapaEdicao deveria ter recusado");
  }
  return {
    codigo_pedido: input.codigoPedido,
    data_previsao: input.lido.dataPrevisao,
    etapa: input.lido.etapa,
    codigo_parcela: input.codigoParcela,
  };
}

/** Frete do AlterarPedidoVenda: o LIDO do Omie, intacto; o caller só sobrescreve volumes quando os
 *  manda (a tela de edição não manda). */
export function freteDaEdicao(input: {
  lido: CabecalhoLido;
  quantidadeVolumes?: unknown;
}): Record<string, unknown> {
  if (input.lido.frete === null) {
    throw new Error("freteDaEdicao: leitura sem frete — vereditoEtapaEdicao deveria ter recusado");
  }
  const frete = { ...input.lido.frete };
  const vol = Number(input.quantidadeVolumes);
  if (input.quantidadeVolumes != null && Number.isInteger(vol) && vol > 0) frete.quantidade_volumes = vol;
  return frete;
}

/** Classificação do AlterarPedidoVenda: a LIDA do Omie (uma reclassificação feita no ERP não é
 *  desfeita por quem só trocou a observação); o default da conta só cobre o campo que não veio. */
export function informacoesAdicionaisDaEdicao(input: {
  lido: CabecalhoLido;
  padrao: { codigo_categoria: string; codigo_conta_corrente: number };
  codVendDoPayload: number | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    codigo_categoria: input.lido.categoria ?? input.padrao.codigo_categoria,
    codigo_conta_corrente: input.lido.contaCorrente ?? input.padrao.codigo_conta_corrente,
  };
  const codVend = input.lido.codVend ?? input.codVendDoPayload;
  if (codVend !== null) out.codVend = codVend;
  return out;
}

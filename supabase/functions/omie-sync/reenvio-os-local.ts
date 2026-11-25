// PR 2.5 (rodada 3 do Novo Pedido, "reenvio honesto") — endereço e turno no reenvio da OS.
// PURO (zero Deno/DB): provado por `deno test --no-remote supabase/functions/omie-sync/reenvio-os-local_test.ts`.
//
// O registro em `orders` é um upsert com `ignoreDuplicates` (PK = orderId): no reenvio que reconcilia
// a OS ("confere"), `address` e `time_slot` da tentativa ANTERIOR ficavam, e o roteirizador buscava ou
// entregava no endereço/turno velho sem ninguém saber. Os dois são SÓ LOCAIS (o turno vai ao Omie
// apenas no texto da observação da OS, que o reenvio não reescreve) e ficam FORA da assinatura da OS
// (`montarAssinaturaOS`/`assinaturaServicosAfiacao`) de propósito: entrar lá mudaria o id da OS.
//
// Régua: só atualiza enquanto o pedido está em `pedido_recebido` — dali em diante a coleta/rota já pode
// ter sido montada com o endereço velho, e trocar por baixo seria pior que avisar. Sempre com aviso.

export interface LocalOs {
  address: unknown;
  time_slot: unknown;
  status?: unknown;
}

export type AtualizacaoLocalOs =
  | { acao: "nada" }
  | { acao: "atualizar"; campos: { address: Record<string, string> | null; time_slot: string | null }; aviso: string }
  | { acao: "recusar"; aviso: string };

/** Status em que a coleta/rota ainda não foi montada: o único em que o reenvio regrava endereço/turno. */
export const STATUS_ATUALIZAVEL = "pedido_recebido";

/** JSON com chaves ordenadas: `{a,b}` e `{b,a}` são o mesmo endereço; null/{} distintos de preenchido. */
function canonico(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonico).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonico(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** O que fazer com `orders` depois do upsert de uma OS RECONCILIADA. `atual` é a linha lida depois do
 *  upsert (null = não existe); `desejado` sai de `enderecoDaOs`/`turnoDaOs` deste envio. */
export function decidirAtualizacaoLocalOs(
  atual: LocalOs | null,
  desejado: { address: Record<string, string> | null; time_slot: string | null },
  cNumOS: string,
): AtualizacaoLocalOs {
  if (atual === null) return { acao: "nada" };
  const mudouEndereco = canonico(atual.address) !== canonico(desejado.address);
  const mudouTurno = canonico(atual.time_slot ?? null) !== canonico(desejado.time_slot);
  if (!mudouEndereco && !mudouTurno) return { acao: "nada" };
  const oque = mudouEndereco && mudouTurno ? "o endereço e o turno" : mudouEndereco ? "o endereço" : "o turno";
  if (atual.status !== STATUS_ATUALIZAVEL) {
    return {
      acao: "recusar",
      aviso: `A OS ${cNumOS} já existia e o pedido está em "${String(atual.status ?? "sem status")}": ` +
        `${oque} deste envio NÃO foi gravado no app — ajuste a coleta/entrega no roteiro.`,
    };
  }
  return {
    acao: "atualizar",
    campos: { address: desejado.address, time_slot: desejado.time_slot },
    aviso: `A OS ${cNumOS} já existia: ${oque} deste envio foi atualizado no app (roteirizador). ` +
      `No Omie a OS não muda${mudouTurno ? " — o turno na observação dela segue o da tentativa anterior" : ""}.`,
  };
}

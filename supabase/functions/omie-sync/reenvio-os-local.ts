// PR 2.5 (rodada 3 do Novo Pedido, "reenvio honesto") — endereço e turno no reenvio da OS.
// PURO (zero Deno/DB): provado por `deno test --no-remote supabase/functions/omie-sync/reenvio-os-local_test.ts`.
//
// O registro em `orders` é um upsert com `ignoreDuplicates` (PK = orderId): no reenvio que reconcilia
// a OS ("confere"), `address` e `time_slot` da tentativa ANTERIOR ficam, e o vendedor não sabia que o
// endereço/turno deste envio não entrou. Os dois são SÓ LOCAIS (o turno vai ao Omie apenas no texto da
// observação da OS, que o reenvio não reescreve) e ficam FORA da assinatura da OS
// (`montarAssinaturaOS`/`assinaturaServicosAfiacao`) de propósito: entrar lá mudaria o id da OS.
//
// Só AVISA, NÃO regrava (decisão do founder 2026-11-25, depois de 2 rodadas do Codex no #4174 acharem
// P0 nas bordas da regravação): front antigo sem modalidade e consulta de endereço que falhou no front
// mandam `null` e apagariam o endereço válido; dois reenvios concorrentes desfaziam a mudança um do
// outro. Sem escrita, nenhum dos dois existe — o gravado é MANTIDO e o vendedor ajusta no roteiro.

export interface LocalOs {
  address: unknown;
  time_slot: unknown;
  delivery_option?: unknown;
}

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

/** Aviso quando o endereço/turno deste envio difere do gravado em `orders` numa OS RECONCILIADA;
 *  `null` = nada a avisar. `atual` é a linha lida depois do upsert (null = não existe); `desejado` sai de
 *  `enderecoDaOs`/`turnoDaOs` deste envio; `modalidade` é a que ESTE envio declarou (null = não declarou:
 *  front antigo ou valor inválido — não há o que comparar). */
export function avisoEnderecoTurnoOs(
  atual: LocalOs | null,
  desejado: { address: Record<string, string> | null; time_slot: string | null },
  modalidade: string | null,
  cNumOS: string,
): string | null {
  if (atual === null || modalidade === null || atual.delivery_option !== modalidade) return null;
  const mudouEndereco = canonico(atual.address) !== canonico(desejado.address);
  const mudouTurno = canonico(atual.time_slot ?? null) !== canonico(desejado.time_slot);
  if (!mudouEndereco && !mudouTurno) return null;
  const oque = mudouEndereco && mudouTurno ? "o endereço e o turno" : mudouEndereco ? "o endereço" : "o turno";
  return `A OS ${cNumOS} já existia: ${oque} deste envio NÃO entrou — o app manteve o da tentativa anterior ` +
    `e a OS no Omie não muda. Ajuste a coleta/entrega no roteiro.`;
}

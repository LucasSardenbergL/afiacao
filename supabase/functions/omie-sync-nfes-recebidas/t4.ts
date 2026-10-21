// t4 (recebimento) da NF CONHECIDA e recebida — o UPDATE que a revisita emite (v1.10). Testado em t4_test.ts.
//
// Compare-and-set em todas as pontas (precisão > recall, money-path):
//   - mesma EMPRESA e mesma CHAVE: a data é desta NF, nunca de outra;
//   - t4 NULO: nunca sobrescreve um recebimento gravado;
//   - status ≠ CANCELADO (NULL-blind: status nulo também fica de fora — falha fechada);
//   - `nid_receb` IGUAL ao desta NF — é exatamente a linha que o backfill largou cedo demais. Linha com
//     `nid_receb` NULO fica com o backfill (Codex r2 P2: gravar o nid aqui a tiraria da fila dele, que ainda
//     preenche raw_data, t2 e transportadora). Linha com `nid_receb` de OUTRO recebimento (o laço principal
//     trocou a chave e manteve o nid antigo, Codex r1 P1) não é escrita: fica contada em `nidDivergente`.

/** O pedaço do cliente Supabase que este UPDATE usa — estrutural, para o teste gravar a cadeia real. */
export interface ClienteT4 {
  from(tabela: string): unknown;
}

/** A cadeia do PostgREST que este módulo emite (o builder real do supabase-js a satisfaz em runtime). */
interface Consulta extends PromiseLike<{ data: unknown; count?: number | null; error: unknown }> {
  update(valores: Record<string, unknown>): Consulta;
  select(colunas: string, opcoes?: { count: "exact"; head: true }): Consulta;
  eq(coluna: string, valor: unknown): Consulta;
  is(coluna: string, valor: null): Consulta;
  neq(coluna: string, valor: unknown): Consulta;
  not(coluna: string, operador: string, valor: unknown): Consulta;
  abortSignal(sinal: AbortSignal): Consulta;
}

export async function preencherT4PorChave(
  db: ClienteT4,
  empresa: string,
  chave: string,
  nIdReceb: number,
  t4Iso: string,
  agoraIso: string,
  sinal: () => AbortSignal,
): Promise<{ preenchidas: number; nidDivergente: number }> {
  const tabela = () => db.from("purchase_orders_tracking") as Consulta;
  const comuns = (q: Consulta) =>
    q.eq("empresa", empresa)
      .eq("nfe_chave_acesso", chave)
      .is("t4_data_recebimento", null)
      .neq("status", "CANCELADO");

  const mesmoNid = await comuns(tabela().update({ t4_data_recebimento: t4Iso, updated_at: agoraIso }))
    .eq("nid_receb", nIdReceb)
    .select("id")
    .abortSignal(sinal());
  if (mesmoNid.error) throw mesmoNid.error;

  const divergentes = await comuns(tabela().select("id", { count: "exact", head: true }))
    .not("nid_receb", "is", null)
    .neq("nid_receb", nIdReceb)
    .abortSignal(sinal());
  if (divergentes.error) throw divergentes.error;
  // ausente ≠ zero: sem a contagem não se afirma "nenhum divergente"
  if (typeof divergentes.count !== "number") throw new Error(`t4: contagem de nid divergente ausente (chave ${chave})`);

  const n = (d: unknown) => (Array.isArray(d) ? d.length : 0);
  return { preenchidas: n(mesmoNid.data), nidDivergente: divergentes.count };
}

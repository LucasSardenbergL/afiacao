// t4 (recebimento) da NF CONHECIDA e recebida — o UPDATE que a revisita emite (v1.10). Testado em t4_test.ts.
//
// Compare-and-set em todas as pontas (precisão > recall, money-path):
//   - mesma EMPRESA e mesma CHAVE: a data é desta NF, nunca de outra;
//   - t4 NULO: nunca sobrescreve um recebimento gravado;
//   - status ≠ CANCELADO (NULL-blind: status nulo também fica de fora — falha fechada);
//   - `nid_receb` igual ao desta NF, ou nulo (e então ganha o desta NF). Linha com `nid_receb` de OUTRO
//     recebimento (o laço principal trocou a chave e manteve o nid antigo, Codex 2026-10-20 P1) não é
//     escrita: fica contada em `nidDivergente` para quem lê o resumo.

/** O pedaço do cliente Supabase que este UPDATE usa — estrutural, para o teste gravar a cadeia real. */
export interface ClienteT4 {
  // deno-lint-ignore no-explicit-any
  from(tabela: string): any;
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
  // deno-lint-ignore no-explicit-any
  const comuns = (q: any) =>
    q.eq("empresa", empresa)
      .eq("nfe_chave_acesso", chave)
      .is("t4_data_recebimento", null)
      .neq("status", "CANCELADO");

  const mesmoNid = await comuns(db.from("purchase_orders_tracking").update({ t4_data_recebimento: t4Iso, updated_at: agoraIso }))
    .eq("nid_receb", nIdReceb)
    .select("id")
    .abortSignal(sinal());
  if (mesmoNid.error) throw mesmoNid.error;

  const semNid = await comuns(
    db.from("purchase_orders_tracking").update({ t4_data_recebimento: t4Iso, updated_at: agoraIso, nid_receb: nIdReceb }),
  )
    .is("nid_receb", null)
    .select("id")
    .abortSignal(sinal());
  if (semNid.error) throw semNid.error;

  const divergentes = await comuns(db.from("purchase_orders_tracking").select("id", { count: "exact", head: true }))
    .not("nid_receb", "is", null)
    .neq("nid_receb", nIdReceb)
    .abortSignal(sinal());
  if (divergentes.error) throw divergentes.error;
  // ausente ≠ zero: sem a contagem não se afirma "nenhum divergente"
  if (typeof divergentes.count !== "number") throw new Error(`t4: contagem de nid divergente ausente (chave ${chave})`);

  const n = (d: unknown) => (Array.isArray(d) ? d.length : 0);
  return { preenchidas: n(mesmoNid.data) + n(semNid.data), nidDivergente: divergentes.count };
}

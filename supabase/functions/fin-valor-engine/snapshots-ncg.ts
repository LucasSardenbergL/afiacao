// Leitura dos snapshots de NCG que o cockpit de valor usa — DUAS leituras pontuais, independentes
// do volume da tabela (plano v3, item 3).
//
// Por que existe: a leitura antiga era `order(snapshot_at desc).limit(400)` sem janela e com o
// `error` descartado. A engine A1 grava 3 cenários por dia por empresa (a NCG independe do
// cenário), então 400 linhas ≈ 133 dias — e em 2026-10-26 já havia 427–439 por empresa, o corte
// caindo no começo de junho. O ponto −12m do ROIC incremental (`acharCapitalGiroAnterior`,
// 365 ± 60 d) passa a existir em ~2027-03-26 e estaria SEMPRE fora das 400: o incremental sairia
// "histórico insuficiente" para sempre, em silêncio. Aumentar o limite só adia — o teto é o EIXO
// (docs/historico/roteirizador-corte-cidades.md): pedimos as linhas que a decisão usa, e só elas.
//
// As leituras (índice fin_proj_company_snap_idx (company, snapshot_at DESC)):
//   1. a mais recente com NCG → o capital de giro atual;
//   2. a vizinha de cada lado do alvo (recente − 365 d): `lte` desc limit 1 + `gte` asc limit 1.
//      `acharCapitalGiroAnterior` escolhe a mais próxima das duas e aplica a tolerância — é o
//      mesmo vencedor que ele acharia varrendo o histórico inteiro.
// Lógica sem I/O próprio (as buscas são injetadas) para caber no `--no-remote` do `test:edges`.

export type SnapNcg = { ncg: number | null; snapshot_at: string };
type Resposta = { data: unknown; error: { message?: string } | null };

/** Tem de ser igual ao `janelaDias` default de `acharCapitalGiroAnterior` (365) — o alvo que ele mede. */
export const JANELA_ANTERIOR_DIAS = 365;

export type LeituraSnapshotsNcg =
  | { ok: true; snaps: SnapNcg[]; motivo_anterior: string | null }
  | { ok: false; erro: string };

function linhas(r: Resposta): SnapNcg[] | null {
  return Array.isArray(r.data) ? (r.data as SnapNcg[]) : null;
}

export async function lerSnapshotsNcg(buscas: {
  /** Mais recente com NCG não-nula (`limit 1`). */
  recente: () => PromiseLike<Resposta>;
  /** Vizinha do alvo: 'antes' = `lte(alvo)` desc limit 1; 'depois' = `gte(alvo)` asc limit 1. */
  vizinha: (lado: "antes" | "depois", alvoIso: string) => PromiseLike<Resposta>;
}): Promise<LeituraSnapshotsNcg> {
  const r = await buscas.recente();
  // Falha de leitura NÃO é "sem snapshot" (o motivo diria "rode a engine A1" sobre um 57014).
  if (r.error) return { ok: false, erro: `fin_projecao_snapshots (recente): ${r.error.message ?? "erro sem mensagem"}` };
  const recentes = linhas(r);
  if (recentes == null) return { ok: false, erro: "fin_projecao_snapshots (recente): data sem lista e sem error (resposta malformada)" };
  const atual = recentes[0];
  // Sem ponto atual o incremental não existe — não há alvo a medir.
  if (!atual) return { ok: true, snaps: [], motivo_anterior: null };

  const t = Date.parse(atual.snapshot_at);
  if (!Number.isFinite(t)) {
    return { ok: true, snaps: [atual], motivo_anterior: "snapshot_at do NCG atual ilegível — ROIC incremental indisponível." };
  }
  const alvoIso = new Date(t - JANELA_ANTERIOR_DIAS * 86_400_000).toISOString();
  const [antes, depois] = await Promise.all([buscas.vizinha("antes", alvoIso), buscas.vizinha("depois", alvoIso)]);
  const la = antes.error ? null : linhas(antes);
  const ld = depois.error ? null : linhas(depois);
  if (la == null || ld == null) {
    // Com UM lado ilegível não dá para saber se o outro é o mais próximo do alvo: indisponível.
    const msg = antes.error?.message ?? depois.error?.message ?? "resposta malformada";
    return {
      ok: true,
      snaps: [atual],
      motivo_anterior: `Falha ao ler o NCG do ponto −12m (fin_projecao_snapshots: ${msg}) — ROIC incremental indisponível.`,
    };
  }
  return { ok: true, snaps: [atual, ...la.slice(0, 1), ...ld.slice(0, 1)], motivo_anterior: null };
}

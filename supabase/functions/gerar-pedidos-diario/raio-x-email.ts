import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
// Bloco do Raio-X no digest matinal (adoção — 3ª revisão, 2026-11-08).
//
// Prod em 07/11: 1 visita e 0 decisões no app; o comprador não é lembrado de abrir a ferramenta. O e-mail das 9h15
// é o que ele já lê todo dia, então ganha uma linha: "Raio-X: N pendentes do Top 61 · R$ X parado · Decidir agora".
//
// Regras (money-path, ausente ≠ zero):
//   - Só para a empresa que TEM coorte congelada (`raio_x_coorte_top`). Sem coorte → sem bloco.
//   - Coorte ou decisões ilegíveis (erro de query) → "Raio-X indisponível", NUNCA "0 pendentes".
//   - Pendente = membro da coorte sem decisão com destino (mesma regra de `filaTop` em src/lib/reposicao/raio-x/fila.ts).
//   - O valor é o CONGELADO na coorte (saldo × cmc na foto), rotulado como tal — o e-mail não recalcula o estoque.
//     Pendente sem custo na foto não vira R$ 0: o bloco diz "N sem custo", e com todos sem custo, "valor indisponível".
//   - Nada aqui pode derrubar o e-mail dos pedidos: o leitor captura e degrada para "indisponível".

export interface CoorteLinha {
  sku_codigo_omie: number;
  valor: number | string | null;
  congelada_em: string | null;
}

export interface DecisaoLinha {
  sku_codigo_omie: number;
  destino: string | null;
}

export type ResumoRaioX =
  | { tipo: "sem_coorte" }
  | { tipo: "indisponivel"; motivo: string }
  | {
    tipo: "ok";
    total: number;
    pendentes: number;
    /** Soma do valor congelado dos pendentes COM custo; `null` = nenhum pendente tem custo na foto. */
    valorPendentes: number | null;
    /** Pendentes sem custo na foto (não entram na soma). */
    semCusto: number;
    /** Dia (SP) do congelamento, DD/MM; `null` se ilegível. */
    fotoEm: string | null;
  };

/** Caminho do link (relativo ao APP_URL): mesmo destino do Cmd-K "Raio-X: decidir Top 61", + origem do sensor. */
export const CAMINHO_RAIO_X =
  "/admin/reposicao/baixo-giro?aba=raio-x&rxTop=1&rxStatus=pendente&rxFila=1&origem=email";

const valorNumerico = (v: number | string | null): number | null => {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const diaSP = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
    .format(d);
};

/**
 * Resume coorte × decisões. `null` em qualquer entrada = leitura falhou → indisponível (nunca zero).
 * Coorte lida e vazia = a empresa não tem coorte → sem bloco.
 */
export function resumirRaioX(coorte: CoorteLinha[] | null, decisoes: DecisaoLinha[] | null): ResumoRaioX {
  if (coorte === null) return { tipo: "indisponivel", motivo: "coorte ilegível" };
  if (coorte.length === 0) return { tipo: "sem_coorte" };
  if (decisoes === null) return { tipo: "indisponivel", motivo: "decisões ilegíveis" };
  const decididos = new Set(decisoes.filter((d) => d.destino).map((d) => Number(d.sku_codigo_omie)));
  const pend = coorte.filter((c) => !decididos.has(Number(c.sku_codigo_omie)));
  let soma = 0;
  let comCusto = 0;
  for (const c of pend) {
    const v = valorNumerico(c.valor);
    if (v === null) continue;
    soma += v;
    comCusto++;
  }
  return {
    tipo: "ok",
    total: coorte.length,
    pendentes: pend.length,
    valorPendentes: comCusto > 0 ? soma : null,
    semCusto: pend.length - comCusto,
    fotoEm: diaSP(coorte[0]?.congelada_em ?? null),
  };
}

const brl = (v: number): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(v);

/** HTML do bloco; string vazia quando não há coorte (empresa sem Raio-X). */
export function blocoRaioXHtml(r: ResumoRaioX, appUrl: string): string {
  if (r.tipo === "sem_coorte") return "";
  const url = `${appUrl}${CAMINHO_RAIO_X}`;
  const caixa = (corpo: string) =>
    `<div data-bloco="raio-x" style="background:#f9fafb;border:1px solid #e5e7eb;border-left:4px solid #6366f1;border-radius:8px;padding:14px 16px;margin:0 0 20px;">${corpo}</div>`;
  if (r.tipo === "indisponivel") {
    return caixa(
      `<div style="font-size:14px;font-weight:600;color:#111827;">Raio-X: indisponível hoje</div>` +
        `<div style="font-size:12px;color:#6b7280;margin-top:4px;">Não deu para ler o Top 61 agora. <a href="${url}" style="color:#4f46e5;font-weight:600;">Abrir o Raio-X</a></div>`,
    );
  }
  if (r.pendentes === 0) {
    return caixa(
      `<div style="font-size:14px;font-weight:600;color:#111827;">Raio-X: Top 61 todo decidido (${r.total} de ${r.total})</div>`,
    );
  }
  const foto = r.fotoEm ? ` na foto de ${r.fotoEm}` : " na foto da coorte";
  const valor = r.valorPendentes === null
    ? "valor indisponível (sem custo na foto)"
    : `${brl(r.valorPendentes)} parado${foto}${r.semCusto > 0 ? ` + ${r.semCusto} sem custo` : ""}`;
  return caixa(
    `<div style="font-size:14px;font-weight:600;color:#111827;">Raio-X: ${r.pendentes} pendentes do Top 61 · ${valor}</div>` +
      `<div style="margin-top:10px;"><a href="${url}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600;">Decidir agora</a></div>`,
  );
}

/** Cliente mínimo que o leitor usa (o supabase-js real satisfaz). */
// deno-lint-ignore no-explicit-any
type Db = { from: (t: string) => any };

/**
 * Lê coorte + decisões da empresa (`OBEN` → `oben`). Erro em qualquer leitura → `null` naquela ponta
 * (vira "indisponível" no resumo). Empresa fora do domínio da coorte → sem coorte.
 */
export async function lerResumoRaioX(db: Db, empresa: string): Promise<ResumoRaioX> {
  const e = empresa.toLowerCase();
  if (e !== "oben" && e !== "colacor") return { tipo: "sem_coorte" };
  try {
    const { data: coorte, error: ec } = await db
      .from("raio_x_coorte_top")
      .select("sku_codigo_omie, valor, congelada_em")
      .eq("empresa", e)
      .order("posicao");
    if (ec || !Array.isArray(coorte)) {
      console.error("[gerar-pedidos-diario] raio-x coorte ilegível:", ec?.message ?? "sem dados");
      return resumirRaioX(null, null);
    }
    if (coorte.length === 0) return resumirRaioX([], []);
    const skus = (coorte as CoorteLinha[]).map((c) => c.sku_codigo_omie);
    const { data: dec, error: ed } = await db
      .from("raio_x_decisao")
      .select("sku_codigo_omie, destino")
      .eq("empresa", e)
      .in("sku_codigo_omie", skus);
    if (ed || !Array.isArray(dec)) {
      console.error("[gerar-pedidos-diario] raio-x decisões ilegíveis:", ed?.message ?? "sem dados");
      return resumirRaioX(coorte as CoorteLinha[], null);
    }
    return resumirRaioX(coorte as CoorteLinha[], dec as DecisaoLinha[]);
  } catch (err) {
    console.error("[gerar-pedidos-diario] raio-x leitura falhou:", mensagemDeErro(err) ?? "(sem mensagem)");
    return { tipo: "indisponivel", motivo: "leitura falhou" };
  }
}

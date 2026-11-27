// Chave de upsert de `fin_movimentacoes` (UNIQUE company, omie_ncodmov).
//
// Antes: SEMPRE o hash FNV-1a (63 bits, >= 0) de ~22 campos do payload — sem nCodBaixa. Duas
// baixas legítimas do mesmo título/conta/dia/valor produziam o MESMO hash e colapsavam numa
// linha (no Map da página e no upsert). Medido em prod (2026-11-26): 3 títulos, R$ 18.562,47 de
// caixa sumido (ex.: 10 baixas de 2.000 de um título de 20.000 viraram uma).
//
// Agora: linha com nCodBaixa válido ⇒ chave = -nCodBaixa (espaço negativo, disjunto do hash).
// A identidade da baixa é o id do Omie: baixa que muda campo ATUALIZA a mesma linha (acabam as
// versões). Sem nCodBaixa (ótica do título, lançamento avulso) ⇒ o hash de sempre.
// nCodBaixa PRESENTE mas inválido (não-inteiro, > 2^53, texto) LANÇA: cair no hash reabriria o
// colapso em silêncio (Codex, desenho 2026-11-26). O CHECK da migration 20261126190000 espelha
// isto no banco: (ncodbaixa NULL e chave >= 0) OU (ncodbaixa > 0 e chave = -ncodbaixa).

import { idOmie } from "./resumo-movimento.ts";

/** nCodBaixa ausente (sem id) — distinto de presente-e-inválido. */
function ausente(v: unknown): boolean {
  return v === undefined || v === null || v === 0 || v === "";
}

/**
 * Chave final da linha. `hashFnv` é o hash legado (string decimal >= 0).
 * Lança se o nCodBaixa veio mas não é inteiro seguro positivo.
 */
export function chaveMovimento(hashFnv: string, nCodBaixa: unknown): string {
  if (ausente(nCodBaixa)) return hashFnv;
  const id = idOmie(nCodBaixa);
  if (id === null) {
    throw new Error(
      `nCodBaixa presente e inválido (${typeof nCodBaixa}: ${String(nCodBaixa).slice(0, 40)}) — ` +
        "não é inteiro seguro positivo; gravar pelo hash reabriria o colapso de baixas",
    );
  }
  return String(-id);
}

/**
 * Sensor do reparo: quantos nCodBaixa DISTINTOS caíam no MESMO hash legado durante a varredura
 * (o colapso que a chave nova desfaz). Conta por hash: grupo com k ids ⇒ k-1 baixas que antes
 * sumiam. Acumula entre páginas de uma execução.
 */
export class SensorColapso {
  private porHash = new Map<string, Set<number>>();

  registrar(hashFnv: string, nCodBaixa: unknown): void {
    const id = idOmie(nCodBaixa);
    if (id === null) return;
    let s = this.porHash.get(hashFnv);
    if (!s) {
      s = new Set();
      this.porHash.set(hashFnv, s);
    }
    s.add(id);
  }

  /** Baixas que a chave antiga teria colapsado (soma de k-1 por hash). */
  baixasColapsadas(): number {
    let n = 0;
    for (const s of this.porHash.values()) if (s.size > 1) n += s.size - 1;
    return n;
  }

  /** Hashes legados com mais de um nCodBaixa. */
  hashesComColisao(): number {
    let n = 0;
    for (const s of this.porHash.values()) if (s.size > 1) n++;
    return n;
  }
}

/** Linha candidata da página com o hash legado e o nCodBaixa CRU (antes de validar). */
export type ItemChave<R extends { omie_ncodmov: string }> = { row: R; hashLegado: string; nCodBaixaBruto: unknown };

/**
 * Aplica a chave final às linhas QUE SERÃO GRAVADAS (já filtradas pela janela) e alimenta o
 * sensor. Lança se algum nCodBaixa vier presente e inválido.
 */
export function aplicarChaves<R extends { omie_ncodmov: string }>(
  itens: ItemChave<R>[],
  sensor: SensorColapso,
): R[] {
  return itens.map(({ row, hashLegado, nCodBaixaBruto }) => {
    const chave = chaveMovimento(hashLegado, nCodBaixaBruto);
    sensor.registrar(hashLegado, nCodBaixaBruto);
    return { ...row, omie_ncodmov: chave };
  });
}

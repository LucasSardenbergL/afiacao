import { describe, expect, it } from 'vitest';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { documentoSorteado, duAte, itensLtPermitidos, ltRealizado, uniforme } from './aleatorio';
import { duEntre, somarDiasUteis } from './calendario';
import { JANELAS } from './config';
import type { ItemLT } from './tipos';

const item = (trackingId: string, sku: string, t1: string, ltDu: number, aberto = false): ItemLT => ({
  trackingId, sku, t1, t2: null, t4: aberto ? null : somarDiasUteis(t1, ltDu), ltDu, aberto,
});

describe('uniforme', () => {
  it('uniforme independe da ordem de chamada', () => {
    const chaves: (string | number)[][] = [[1, 'doc', '2026-05-04'], [2, 'item', '2026-05-04', 'SKU1'], [7, 'falta', 'L-9']];
    const ida = chaves.map((k) => uniforme(...k));
    const volta = [...chaves].reverse().map((k) => uniforme(...k)).reverse();
    expect(volta).toEqual(ida);
    for (const u of ida) expect(u >= 0 && u < 1).toBe(true);
    // chaves diferentes ⇒ números diferentes (não é constante)
    expect(new Set(ida).size).toBe(3);
  });
});

describe('ltRealizado', () => {
  // Dois documentos perto de 2026-05-06; um terceiro a 11 du (fora da janela de ±10 quando há candidato).
  const itens: ItemLT[] = [
    item('DOC-A', 'X', '2026-05-04', 3),
    item('DOC-A', 'Y', '2026-05-04', 7),
    item('DOC-A', 'Z', '2026-05-04', 12),
    item('DOC-B', 'X', '2026-05-05', 20),
    item('DOC-B', 'W', '2026-05-05', 21),
    item('DOC-LONGE', 'X', '2026-05-21', 0),
  ];
  const d = '2026-05-06';
  const ltsDe = (tid: string) => itens.filter((i) => i.trackingId === tid).map((i) => i.ltDu);

  it('mesmo documento, itens diferentes', () => {
    let achouItensDiferentes = false;
    for (let rep = 0; rep < 200; rep++) {
      const doc = documentoSorteado(rep, d, itens);
      expect(doc.trackingId).not.toBe('DOC-LONGE'); // 11 du de distância: fora de ±10
      const a = ltRealizado(rep, d, 'SKU-1', 'empirico', itens);
      const b = ltRealizado(rep, d, 'SKU-2', 'empirico', itens);
      // os dois SKUs pedidos no mesmo dia recebem LT do MESMO documento sorteado
      expect(ltsDe(doc.trackingId)).toContain(a);
      expect(ltsDe(doc.trackingId)).toContain(b);
      if (a !== b) achouItensDiferentes = true;
    }
    expect(achouItensDiferentes).toBe(true);
  });

  it('os dois documentos da janela são sorteados (não fica preso ao primeiro)', () => {
    const vistos = new Set<string>();
    for (let rep = 0; rep < 200; rep++) vistos.add(documentoSorteado(rep, d, itens).trackingId);
    expect([...vistos].sort()).toEqual(['DOC-A', 'DOC-B']);
  });

  it('sem candidato a ±10 du, a janela dobra até achar', () => {
    // 30 du depois do DOC-LONGE: nada em ±10 nem ±20; em ±40 só ele (DOC-A/B ficam a 42–43 du)
    const longe = somarDiasUteis('2026-05-21', 30);
    expect(duEntre('2026-05-05', longe)).toBeGreaterThan(40);
    const doc = documentoSorteado(0, longe, itens);
    expect(doc.trackingId).toBe('DOC-LONGE'); // o mais próximo é o único na 1ª janela que acha
  });

  it('estresse15 = max(LT, 15); choque29 = 29 só nas semanas 9–12 da avaliação', () => {
    for (let rep = 0; rep < 50; rep++) {
      const emp = ltRealizado(rep, d, 'S', 'empirico', itens);
      expect(ltRealizado(rep, d, 'S', 'estresse15', itens)).toBe(Math.max(emp, 15));
    }
    const sem9 = addDias(JANELAS.avaliacaoIni, 7 * 8); // 1º dia da semana 9
    const sem12fim = addDias(JANELAS.avaliacaoIni, 7 * 12 - 1); // último dia da semana 12
    const sem13 = addDias(JANELAS.avaliacaoIni, 7 * 12);
    const sem8fim = addDias(JANELAS.avaliacaoIni, 7 * 8 - 1);
    expect(ltRealizado(3, sem9, 'S', 'choque29', itens)).toBe(29);
    expect(ltRealizado(3, sem12fim, 'S', 'choque29', itens)).toBe(29);
    expect(ltRealizado(3, sem13, 'S', 'choque29', itens)).toBe(ltRealizado(3, sem13, 'S', 'empirico', itens));
    expect(ltRealizado(3, sem8fim, 'S', 'choque29', itens)).toBe(ltRealizado(3, sem8fim, 'S', 'empirico', itens));
  });

  it('LT documental cru: 0 é devolvido como 0 (o mínimo de 1 du é do simulador)', () => {
    const soZero = [item('Z0', 'X', '2026-05-04', 0)];
    expect(ltRealizado(0, '2026-05-05', 'S', 'empirico', soZero)).toBe(0);
  });

  it('sem documento algum lança LT_SEM_DOCUMENTOS', () => {
    expect(() => ltRealizado(0, d, 'S', 'empirico', [])).toThrow(/^LT_SEM_DOCUMENTOS$/);
  });

  it('itensLtPermitidos na calibração só deixa t4 <= fim da calibração (aberto usa a extração)', () => {
    const its = [item('A', 'X', '2026-04-01', 5), item('B', 'X', '2026-04-27', 5), item('C', 'X', '2026-04-01', 15, true)];
    expect(its[1].t4! > JANELAS.calibracaoFim).toBe(true);
    expect(itensLtPermitidos(its, true, '2026-10-21').map((i) => i.trackingId)).toEqual(['A']);
    expect(itensLtPermitidos(its, false, '2026-10-21').map((i) => i.trackingId)).toEqual(['A', 'B', 'C']);
  });

  it('duAte é coerente com duEntre (seg–sex, inclui o fim, exclui o início)', () => {
    const base = '2026-04-29';
    for (let i = 0; i < 40; i++) {
      const b = addDias(base, i);
      expect(duAte(b) - duAte(base)).toBe(duEntre(base, b));
    }
  });
});

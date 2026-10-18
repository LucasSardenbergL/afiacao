// Testa o CÓDIGO REAL de encerrados.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-sync-pedidos-compra/encerrados_test.ts
import {
  decidirPublicacaoEncerrados,
  FILTROS_SO_ENCERRADOS,
  FILTROS_TODOS,
  isoParaBR,
} from "./encerrados.ts";

// sem dependência remota (--no-remote): comparação estrutural por JSON, chaves na ordem de construção
function assertEquals(a: unknown, b: unknown): void {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  if (x !== y) throw new Error(`esperado ${y}, veio ${x}`);
}

const geral = new Set([1014, 1049, 1032, 2000, 2001, 2002, 2003]);
const decide = (enc: number[], o: { completaGeral?: boolean; completaEncerrados?: boolean; idsGeral?: Set<number> } = {}) =>
  decidirPublicacaoEncerrados({
    completaGeral: o.completaGeral ?? true,
    completaEncerrados: o.completaEncerrados ?? true,
    idsEncerrados: new Set(enc),
    idsGeral: o.idsGeral ?? geral,
  });

Deno.test("filtros: a passada liga SÓ encerrados e desliga os outros 6 explicitamente", () => {
  assertEquals(Object.keys(FILTROS_SO_ENCERRADOS).sort(), Object.keys(FILTROS_TODOS).sort());
  assertEquals(Object.entries(FILTROS_SO_ENCERRADOS).filter(([, v]) => v === "T").map(([k]) => k), ["lExibirPedidosEncerrados"]);
  assertEquals(Object.values(FILTROS_TODOS).every((v) => v === "T"), true);
});

Deno.test("isoParaBR: converte e recusa o que não é yyyy-mm-dd", () => {
  assertEquals(isoParaBR("2026-05-21"), "21/05/2026");
  assertEquals(isoParaBR(null), null);
  assertEquals(isoParaBR("21/05/2026"), null);
});

Deno.test("publica o subconjunto ordenado quando tudo terminou limpo", () => {
  assertEquals(decide([1049, 1014, 1032]), { tipo: "publicar", ids: [1014, 1032, 1049] });
});

Deno.test("conjunto vazio publica (limpar devolve ao caixa — lado conservador)", () => {
  assertEquals(decide([]), { tipo: "publicar", ids: [] });
});

Deno.test("abstém se o completo ou a passada não terminaram limpos", () => {
  assertEquals(decide([1014], { completaGeral: false }).tipo, "abster");
  assertEquals(decide([1014], { completaEncerrados: false }).tipo, "abster");
});

Deno.test("abstém se algum encerrado não foi visto pelo completo", () => {
  const d = decide([1014, 9999]);
  assertEquals(d.tipo === "abster" && d.motivo.startsWith("1 encerrado(s) fora da varredura completa"), true);
});

Deno.test("abstém se o filtro devolveu a varredura inteira (filtro ignorado)", () => {
  const d = decide([...geral]);
  assertEquals(d.tipo === "abster" && d.motivo.startsWith("filtro de encerrados devolveu a varredura inteira"), true);
});

Deno.test("abstém acima da metade; exatamente a metade publica", () => {
  const seis = new Set([1, 2, 3, 4, 5, 6]);
  assertEquals(decide([1, 2, 3], { idsGeral: seis }).tipo, "publicar");
  const d = decide([1, 2, 3, 4], { idsGeral: seis });
  assertEquals(d.tipo === "abster" && d.motivo.startsWith("encerrados (4) passam da metade"), true);
});

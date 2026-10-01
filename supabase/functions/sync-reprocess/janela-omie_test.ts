// Testa o CÓDIGO REAL de janela-omie.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/sync-reprocess/janela-omie_test.ts
// e TAMBÉM com TZ=UTC na frente: o servidor da edge roda em UTC, o Mac em SP — um teste de fuso que
// só passa no fuso do Mac é o defeito escondido (docs/agent/money-path.md, "Prova que depende da HORA").
//
// O relógio é INJETADO (`agora`). Cada borda vem em par de 1 s, e o controle POSITIVO (a janela anda à
// meia-noite de SP) impede os asserts de "não andou às 21h" de passarem por vacuidade.
import { janelaPedidosOmie } from "./janela-omie.ts";

function assertJanela(a: { de: string; ate: string }, de: string, ate: string, ctx: string) {
  if (a.de !== de || a.ate !== ate) {
    throw new Error(`${ctx}: esperava ${de} → ${ate}, veio ${a.de} → ${a.ate}`);
  }
}

Deno.test("20:59:59 BRT de 30/09: a janela de 7 dias é 23/09 → 30/09 (UTC e SP ainda coincidem)", () => {
  assertJanela(janelaPedidosOmie(new Date("2026-09-30T23:59:59Z"), 7), "23/09/2026", "30/09/2026", "20:59:59");
});

Deno.test("21:00:00 BRT de 30/09: a janela NÃO anda — o dia UTC já virou, o de SP não (era 24/09 → 01/10)", () => {
  assertJanela(janelaPedidosOmie(new Date("2026-10-01T00:00:00Z"), 7), "23/09/2026", "30/09/2026", "21:00:00");
});

Deno.test("23:59:59 BRT de 30/09: ainda 23/09 → 30/09 (o cron das 23:15 e o strategic das 23:30 caem aqui)", () => {
  assertJanela(janelaPedidosOmie(new Date("2026-10-01T02:59:59Z"), 7), "23/09/2026", "30/09/2026", "23:59:59");
});

Deno.test("CONTROLE POSITIVO: 00:00:00 BRT de 01/10 — a janela anda exatamente aqui", () => {
  assertJanela(janelaPedidosOmie(new Date("2026-10-01T03:00:00Z"), 7), "24/09/2026", "01/10/2026", "00:00:00");
});

Deno.test("strategic (30 dias) às 23:30 BRT de 31/12: 01/12 → 31/12/2026, sem cruzar para 2027", () => {
  assertJanela(janelaPedidosOmie(new Date("2027-01-01T02:30:00Z"), 30), "01/12/2026", "31/12/2026", "réveillon");
});

Deno.test("janela de dias não inteiros LANÇA — não se fabrica uma data para o Omie", () => {
  let msg = "";
  try {
    janelaPedidosOmie(new Date("2026-09-30T15:00:00Z"), 7.5);
  } catch (e) {
    msg = e instanceof RangeError ? e.message : `não-RangeError: ${String(e)}`;
  }
  // Marca do ramo, ASCII: a mensagem do somarDias (hoje-sp.ts) — não "lançou algo".
  if (!msg.startsWith("somarDias: data ou deslocamento")) throw new Error(`esperava o RangeError do somarDias, veio: "${msg}"`);
});

// O INVARIANTE da fase (decisão do founder, 30/09): a qualquer hora do dia D de SP, o valor novo é o que
// o código velho dava durante o DIA de D — a noite vira o dia, e nenhum comportamento é novo.
// O código velho como rodava no servidor (fuso UTC: lá o `getDate()` É o `getUTCDate()`), e o "dia D"
// dele é o relógio deslocado para BRT (UTC−3 fixo: sem horário de verão desde 2019 — por isso a
// varredura fica em 2026–2027). O oráculo não usa nada de hoje-sp.ts.
function janelaVelhaNoServidor(agora: Date, dias: number): { de: string; ate: string } {
  const f = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  return { de: f(new Date(agora.getTime() - dias * 86_400_000)), ate: f(agora) };
}

Deno.test("INVARIANTE, hora a hora em 2026–2027: novo(t) = velho no servidor às t−3h; e só a noite muda", () => {
  const H = 3_600_000;
  let horas = 0;
  let mudouANoite = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += H) {
    const agora = new Date(t);
    const hUtc = agora.getUTCHours();
    for (const dias of [7, 30]) {
      const novo = janelaPedidosOmie(agora, dias);
      const esperado = janelaVelhaNoServidor(new Date(t - 3 * H), dias);
      assertJanela(novo, esperado.de, esperado.ate, `${agora.toISOString()} (${dias}d)`);
      const velhoSemDeslocar = janelaVelhaNoServidor(agora, dias);
      const mudou = novo.de !== velhoSemDeslocar.de || novo.ate !== velhoSemDeslocar.ate;
      // A noite de SP é 00:00–02:59 UTC: lá o conserto TEM de mudar o valor; fora dela, NUNCA.
      if (mudou !== (hUtc < 3)) throw new Error(`${agora.toISOString()} (${dias}d): mudou=${mudou} fora do esperado`);
      if (mudou) mudouANoite++;
    }
    horas++;
  }
  // Denominador: 730 dias × 24 h, e 3 horas de noite por dia × 2 janelas — a varredura não é vazia.
  if (horas !== 730 * 24) throw new Error(`varredura encolheu: ${horas} horas`);
  if (mudouANoite !== 730 * 3 * 2) throw new Error(`a noite deveria mudar ${730 * 3 * 2} vezes, mudou ${mudouANoite}`);
});

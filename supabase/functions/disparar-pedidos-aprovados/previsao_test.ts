// Testa o CÓDIGO REAL de previsao.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/disparar-pedidos-aprovados/previsao_test.ts
// e TAMBÉM com TZ=UTC na frente: o servidor da edge roda em UTC, o Mac em SP — o código velho (getDate()
// no servidor) passa nos asserts de hora quando o runner está em SP (medido no RED desta fase).
//
// O relógio é INJETADO (`agora`). Calendário de referência (conferido à mão a partir de 01/01/2024 =
// segunda): 30/09/2026 é quarta, 01/10 quinta, 02/10 sexta, 03/10 sábado, 04/10 domingo, 05/10 segunda;
// 31/12/2026 é quinta e 01/01/2027 sexta.
import { dataPrevisaoOmie, somarDiasUteis } from "./previsao.ts";

function assertEquals(a: unknown, b: unknown, msg: string) {
  if (a !== b) throw new Error(`${msg}: esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

// ── somarDiasUteis: aritmética de calendário (seg–sex; feriado não conta — nunca contou) ──

Deno.test("somarDiasUteis: sexta, sábado e domingo + 1 dia útil caem todos na segunda", () => {
  assertEquals(somarDiasUteis("2026-10-02", 1), "2026-10-05", "sexta");
  assertEquals(somarDiasUteis("2026-10-03", 1), "2026-10-05", "sábado");
  assertEquals(somarDiasUteis("2026-10-04", 1), "2026-10-05", "domingo");
});

Deno.test("somarDiasUteis: quarta + 3 pula o fim de semana; quinta 31/12 + 2 atravessa o ano", () => {
  assertEquals(somarDiasUteis("2026-09-30", 3), "2026-10-05", "quarta + 3");
  assertEquals(somarDiasUteis("2026-12-31", 2), "2027-01-04", "réveillon + 2");
});

Deno.test("somarDiasUteis: 0 dia útil devolve o próprio dia, mesmo num sábado (o laço velho não rodava)", () => {
  assertEquals(somarDiasUteis("2026-10-03", 0), "2026-10-03", "sábado + 0");
});

Deno.test("somarDiasUteis: data fora de YYYY-MM-DD LANÇA", () => {
  let msg = "";
  try {
    somarDiasUteis("2026-10-3", 1);
  } catch (e) {
    msg = e instanceof RangeError ? e.message : `não-RangeError: ${String(e)}`;
  }
  if (!msg.startsWith("somarDiasUteis: data")) throw new Error(`esperava o RangeError do somarDiasUteis, veio: "${msg}"`);
});

// ── dataPrevisaoOmie: o dDtPrevisao do IncluirPedCompra ──

const semPortal = (ltDias: number, iso: string) => dataPrevisaoOmie({ portalDataEntrega: null, ltDias, agora: new Date(iso) });

Deno.test("lead time, quarta 30/09 20:59:59 BRT: hoje + 3 dias úteis = segunda 05/10", () => {
  assertEquals(semPortal(3, "2026-09-30T23:59:59Z"), "05/10/2026", "20:59:59");
});

Deno.test("lead time, quarta 30/09 21:00:00 BRT: continua 05/10 — o dia UTC já é quinta (era 06/10)", () => {
  assertEquals(semPortal(3, "2026-10-01T00:00:00Z"), "05/10/2026", "21:00:00");
});

Deno.test("lead time, quarta 30/09 23:59:59 BRT: ainda 05/10", () => {
  assertEquals(semPortal(3, "2026-10-01T02:59:59Z"), "05/10/2026", "23:59:59");
});

Deno.test("CONTROLE POSITIVO: quinta 01/10 00:00:00 BRT — hoje + 3 vira terça 06/10 exatamente aqui", () => {
  assertEquals(semPortal(3, "2026-10-01T03:00:00Z"), "06/10/2026", "00:00:00");
});

Deno.test("lead time, domingo 04/10 22:00 BRT: hoje + 2 = terça 06/10 (o dia UTC, segunda, dava quarta 07/10)", () => {
  assertEquals(semPortal(2, "2026-10-05T01:00:00Z"), "06/10/2026", "domingo à noite");
});

Deno.test("lead time, quinta 31/12 22:00 BRT: hoje + 2 = 04/01/2027 (o dia UTC, sexta 01/01, dava 05/01)", () => {
  assertEquals(semPortal(2, "2027-01-01T01:00:00Z"), "04/01/2027", "réveillon");
});

Deno.test("portal: entrega confirmada sexta 02/10 + 2 dias úteis = terça 06/10, à noite e de dia — o relógio não entra", () => {
  const comPortal = (iso: string) => dataPrevisaoOmie({ portalDataEntrega: "2026-10-02", ltDias: 3, agora: new Date(iso) });
  assertEquals(comPortal("2026-10-01T00:30:00Z"), "06/10/2026", "portal 21:30 BRT");
  assertEquals(comPortal("2026-09-30T15:00:00Z"), "06/10/2026", "portal 12:00 BRT");
});

Deno.test("portal fora de YYYY-MM-DD cai no lead time — às 21:00 BRT de quarta, hoje de SP + 3 = 05/10", () => {
  const r = dataPrevisaoOmie({ portalDataEntrega: "02/10/2026", ltDias: 3, agora: new Date("2026-10-01T00:00:00Z") });
  assertEquals(r, "05/10/2026", "portal malformado");
});

// O INVARIANTE da fase (decisão do founder, 30/09): a qualquer hora do dia D de SP, o valor novo é o que
// o código velho dava durante o DIA de D. O oráculo é o diasUteisFromHoje velho como rodava no servidor
// (fuso UTC: lá getDate()/setDate()/getDay() SÃO os getUTC*), com o relógio deslocado para BRT (UTC−3
// fixo: sem horário de verão desde 2019 — por isso a varredura fica em 2026–2027). Nada de previsao.ts.
function diasUteisVelhoNoServidor(agora: Date, n: number): string {
  const d = new Date(agora.getTime());
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

Deno.test("INVARIANTE, hora a hora em 2026–2027: novo(t) = velho no servidor às t−3h; e só a noite muda", () => {
  const H = 3_600_000;
  let horas = 0;
  let mudouLt0 = 0;
  let mudouComLt = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += H) {
    const agora = new Date(t);
    const noite = agora.getUTCHours() < 3; // 21:00–23:59 BRT
    for (const lt of [0, 1, 2, 3, 4, 7]) {
      const novo = dataPrevisaoOmie({ portalDataEntrega: null, ltDias: lt, agora });
      assertEquals(novo, diasUteisVelhoNoServidor(new Date(t - 3 * H), lt), `${agora.toISOString()} lt=${lt}`);
      const mudou = novo !== diasUteisVelhoNoServidor(agora, lt);
      if (mudou && !noite) throw new Error(`${agora.toISOString()} lt=${lt}: o valor de DIA mudou`);
      if (mudou && lt === 0) mudouLt0++;
      if (mudou && lt > 0) mudouComLt++;
    }
    horas++;
  }
  if (horas !== 730 * 24) throw new Error(`varredura encolheu: ${horas} horas`);
  // lt=0 é "hoje": toda hora de noite muda (730 × 3). Com lt>0, sexta e sábado à noite coincidem por
  // acaso (o fim de semana não conta) — por isso aqui só se exige que a região do defeito exista.
  if (mudouLt0 !== 730 * 3) throw new Error(`lt=0: a noite deveria mudar ${730 * 3} vezes, mudou ${mudouLt0}`);
  if (mudouComLt === 0) throw new Error("lt>0: nenhuma noite mudou — a varredura não alcança o defeito");
});

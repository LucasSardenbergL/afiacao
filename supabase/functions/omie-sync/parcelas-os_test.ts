// Testa o CÓDIGO REAL de parcelas-os.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync/parcelas-os_test.ts
// e TAMBÉM com TZ=UTC na frente: o servidor da edge roda em UTC, o Mac em SP — o código velho (getDate()
// no servidor) passa nos asserts de hora quando o runner está em SP (medido no RED desta fase).
//
// O relógio é INJETADO (`agora`). Vencimentos contados à mão: 30/09 + 30 = 30/10, + 60 = 29/11,
// + 90 = 29/12; 30/09 + 28 = 28/10, + 56 = 25/11, + 84 = 23/12; 31/12/2026 + 30 = 30/01/2027.
import { montarParcelasOS } from "./parcelas-os.ts";

function assertParcelas(
  r: { parcelas: Array<Record<string, unknown>>; nQtdeParc: number },
  vencimentos: string[],
  percentuais: number[],
  ctx: string,
) {
  const veio = JSON.stringify(r);
  const esperado = JSON.stringify({
    nQtdeParc: vencimentos.length,
    parcelas: vencimentos.map((v, i) => ({ nParcela: i + 1, dDtVenc: v, nPercentual: percentuais[i] })),
  });
  if (veio !== esperado) throw new Error(`${ctx}: esperava ${esperado}, veio ${veio}`);
}

const em = (metodo: string, iso: string) => montarParcelasOS(metodo, new Date(iso));

Deno.test("à vista, 30/09 20:59:59 BRT: vence 30/09 (UTC e SP ainda coincidem)", () => {
  assertParcelas(em("a_vista", "2026-09-30T23:59:59Z"), ["30/09/2026"], [100], "20:59:59");
});

Deno.test("à vista, 30/09 21:00:00 BRT: vence HOJE, 30/09 — o dia UTC já é 01/10 (vencia amanhã)", () => {
  assertParcelas(em("a_vista", "2026-10-01T00:00:00Z"), ["30/09/2026"], [100], "21:00:00");
});

Deno.test("30/60/90, 30/09 23:59:59 BRT: 30/10, 29/11, 29/12 — e os percentuais fecham 100 na última", () => {
  assertParcelas(em("30_60_90dd", "2026-10-01T02:59:59Z"), ["30/10/2026", "29/11/2026", "29/12/2026"], [33.33, 33.33, 33.34], "23:59:59");
});

Deno.test("CONTROLE POSITIVO: à vista, 01/10 00:00:00 BRT — o vencimento anda exatamente aqui", () => {
  assertParcelas(em("a_vista", "2026-10-01T03:00:00Z"), ["01/10/2026"], [100], "00:00:00");
});

Deno.test("30dd, 31/12 22:00 BRT: vence 30/01/2027 (o dia UTC, 01/01, dava 31/01)", () => {
  assertParcelas(em("30dd", "2027-01-01T01:00:00Z"), ["30/01/2027"], [100], "réveillon");
});

Deno.test("28/56/84, 30/09 22:00 BRT: 28/10, 25/11, 23/12", () => {
  assertParcelas(em("28_56_84dd", "2026-10-01T01:00:00Z"), ["28/10/2026", "25/11/2026", "23/12/2026"], [33.33, 33.33, 33.34], "28/56/84");
});

Deno.test("30/60 de dia: 30/10 e 29/11, meio a meio", () => {
  assertParcelas(em("30_60dd", "2026-09-30T15:00:00Z"), ["30/10/2026", "29/11/2026"], [50, 50], "30/60");
});

Deno.test("método desconhecido cai em à vista (1 parcela, hoje, 100%)", () => {
  assertParcelas(em("boleto_qualquer", "2026-09-30T15:00:00Z"), ["30/09/2026"], [100], "desconhecido");
});

// O INVARIANTE da fase (decisão do founder, 30/09): a qualquer hora do dia D de SP, o valor novo é o que
// o código velho dava durante o DIA de D. O oráculo é o buildParcelas velho como rodava no servidor
// (fuso UTC: lá getDate()/setDate() SÃO os getUTC*), com o relógio deslocado para BRT (UTC−3 fixo: sem
// horário de verão desde 2019 — por isso a varredura fica em 2026–2027). Nada de parcelas-os.ts.
const PRAZOS_VELHOS: Record<string, number[]> = {
  a_vista: [0], "30dd": [30], "30_60dd": [30, 60], "30_60_90dd": [30, 60, 90],
  "28dd": [28], "28_56dd": [28, 56], "28_56_84dd": [28, 56, 84],
};

function parcelasVelhoNoServidor(metodo: string, agora: Date): string {
  const f = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
  const somar = (d: Date, n: number) => { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; };
  const dias = PRAZOS_VELHOS[metodo] || [0];
  const pct = Math.round((100 / dias.length) * 100) / 100;
  return JSON.stringify({
    nQtdeParc: dias.length,
    parcelas: dias.map((d, i) => ({
      nParcela: i + 1,
      dDtVenc: f(somar(agora, d)),
      nPercentual: i === dias.length - 1 ? Math.round((100 - pct * (dias.length - 1)) * 100) / 100 : pct,
    })),
  });
}

Deno.test("INVARIANTE, hora a hora em 2026–2027: novo(t) = velho no servidor às t−3h; e só a noite muda", () => {
  const H = 3_600_000;
  let horas = 0;
  let mudouAVista = 0;
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2028, 0, 1); t += H) {
    const agora = new Date(t);
    const noite = agora.getUTCHours() < 3; // 21:00–23:59 BRT
    for (const metodo of [...Object.keys(PRAZOS_VELHOS), "desconhecido"]) {
      const novo = JSON.stringify(montarParcelasOS(metodo, agora));
      const esperado = parcelasVelhoNoServidor(metodo, new Date(t - 3 * H));
      if (novo !== esperado) throw new Error(`${agora.toISOString()} ${metodo}: esperava ${esperado}, veio ${novo}`);
      const mudou = novo !== parcelasVelhoNoServidor(metodo, agora);
      if (mudou !== noite) throw new Error(`${agora.toISOString()} ${metodo}: mudou=${mudou} fora do esperado`);
      if (mudou && metodo === "a_vista") mudouAVista++;
    }
    horas++;
  }
  if (horas !== 730 * 24) throw new Error(`varredura encolheu: ${horas} horas`);
  if (mudouAVista !== 730 * 3) throw new Error(`à vista: a noite deveria mudar ${730 * 3} vezes, mudou ${mudouAVista}`);
});

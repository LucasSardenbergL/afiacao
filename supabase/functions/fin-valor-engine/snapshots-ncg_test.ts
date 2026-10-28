// deno test supabase/functions/fin-valor-engine/snapshots-ncg_test.ts
import { JANELA_ANTERIOR_DIAS, lerSnapshotsNcg, type SnapNcg } from "./snapshots-ncg.ts";

function assertEq(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEq"}: esperado ${JSON.stringify(b)}, obtido ${JSON.stringify(a)}`);
  }
}

const DIA = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** Fake do PostgREST sobre um histórico em memória: aplica not-null/lte/gte/ordem/limit 1 como o banco. */
function buscasSobre(hist: SnapNcg[], registro: string[] = []) {
  const validos = hist.filter((s) => s.ncg != null);
  const porData = (dir: 1 | -1) => [...validos].sort((a, b) => dir * (Date.parse(a.snapshot_at) - Date.parse(b.snapshot_at)));
  return {
    recente: () => {
      registro.push("recente");
      return Promise.resolve({ data: porData(-1).slice(0, 1), error: null });
    },
    vizinha: (lado: "antes" | "depois", alvoIso: string) => {
      registro.push(`${lado}:${alvoIso}`);
      const alvo = Date.parse(alvoIso);
      const data = lado === "antes"
        ? porData(-1).filter((s) => Date.parse(s.snapshot_at) <= alvo).slice(0, 1)
        : porData(1).filter((s) => Date.parse(s.snapshot_at) >= alvo).slice(0, 1);
      return Promise.resolve({ data, error: null });
    },
  };
}

// Histórico do tamanho que o `.limit(400)` cortava: 3 cenários/dia por 420 dias (1.260 linhas).
const AGORA = Date.parse("2027-04-20T10:00:00Z");
const historico: SnapNcg[] = [];
for (let d = 0; d < 420; d++) {
  for (let c = 0; c < 3; c++) historico.push({ ncg: 1000 + d, snapshot_at: iso(AGORA - d * DIA - c * 60_000) });
}

Deno.test("histórico de 1.260 linhas: o ponto −12m (dia 365) é lido — o limit(400) o cortava", async () => {
  const registro: string[] = [];
  const r = await lerSnapshotsNcg(buscasSobre(historico, registro));
  if (!r.ok) throw new Error(r.erro);
  assertEq(r.snaps[0], { ncg: 1000, snapshot_at: iso(AGORA) }, "atual");
  assertEq(r.motivo_anterior, null, "motivo");
  // Vizinhas do alvo (agora − 365 d): o próprio dia 365 dos dois lados (o 1º cenário cai em cima).
  const ncgs = r.snaps.slice(1).map((s) => s.ncg);
  assertEq(ncgs.includes(1365), true, `vizinhas ${JSON.stringify(ncgs)}`);
  // Prova de que as 400 mais recentes NÃO contêm o alvo (o bug que este helper fecha).
  const top400 = [...historico].sort((a, b) => Date.parse(b.snapshot_at) - Date.parse(a.snapshot_at)).slice(0, 400);
  assertEq(top400.some((s) => s.ncg === 1365), false, "top400 contém o −12m?");
  assertEq(registro, ["recente", `antes:${iso(AGORA - JANELA_ANTERIOR_DIAS * DIA)}`, `depois:${iso(AGORA - JANELA_ANTERIOR_DIAS * DIA)}`], "leituras");
});

// O fake acima aplica o not-null como o banco; o que prova que a LEITURA REAL o pede é a fonte.
Deno.test("o builder real do index.ts filtra NCG nulo nas três leituras (base comum)", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const linha = fonte.split("\n").find((l) => l.includes("const snapsNcg = () =>"));
  if (!linha?.includes('.eq("company", company).not("ncg", "is", null)')) {
    throw new Error(`snapsNcg sem o filtro not-null: ${linha}`);
  }
  for (const uso of ["recente: () => snapsNcg()", '? snapsNcg().lte("snapshot_at"', ': snapsNcg().gte("snapshot_at"']) {
    if (!fonte.includes(uso)) throw new Error(`leitura fora da base comum: ${uso}`);
  }
});

Deno.test("contrato do fake: NCG nulo nunca é o ponto atual", async () => {
  const r = await lerSnapshotsNcg(buscasSobre([
    { ncg: null, snapshot_at: iso(AGORA) },
    { ncg: 77, snapshot_at: iso(AGORA - DIA) },
  ]));
  if (!r.ok) throw new Error(r.erro);
  assertEq(r.snaps[0].ncg, 77);
});

Deno.test("tabela vazia: ok com snaps [] (o 'sem snapshot de NCG' honesto) e sem ler vizinhas", async () => {
  const registro: string[] = [];
  const r = await lerSnapshotsNcg(buscasSobre([], registro));
  assertEq(r, { ok: true, snaps: [], motivo_anterior: null });
  assertEq(registro, ["recente"]);
});

Deno.test("erro na leitura do ponto atual → ok:false (a engine responde 500), nunca 'sem snapshot'", async () => {
  const r = await lerSnapshotsNcg({
    recente: () => Promise.resolve({ data: null, error: { message: "canceling statement due to statement timeout" } }),
    vizinha: () => Promise.reject(new Error("não devia ler vizinha")),
  });
  assertEq(r, { ok: false, erro: "fin_projecao_snapshots (recente): canceling statement due to statement timeout" });
});

Deno.test("data null sem error no ponto atual → ok:false (resposta malformada)", async () => {
  const r = await lerSnapshotsNcg({
    recente: () => Promise.resolve({ data: null, error: null }),
    vizinha: () => Promise.reject(new Error("não devia ler vizinha")),
  });
  if (r.ok || !r.erro.includes("resposta malformada")) throw new Error(`esperava malformada: ${JSON.stringify(r)}`);
});

Deno.test("erro em UMA vizinha → só o ponto atual + motivo (o −12m fica indisponível, não 'histórico insuficiente')", async () => {
  const base = buscasSobre(historico);
  const r = await lerSnapshotsNcg({
    recente: base.recente,
    vizinha: (lado, alvo) => lado === "depois"
      ? Promise.resolve({ data: null, error: { message: "57014" } })
      : base.vizinha(lado, alvo),
  });
  if (!r.ok) throw new Error(r.erro);
  assertEq(r.snaps.length, 1, "só o atual");
  if (!r.motivo_anterior?.startsWith("Falha ao ler o NCG do ponto −12m (fin_projecao_snapshots: 57014)")) {
    throw new Error(`motivo inesperado: ${r.motivo_anterior}`);
  }
});

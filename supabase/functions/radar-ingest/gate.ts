// Gate da edge `radar-ingest` (revisão 2026-11-11, item 22): `x-cron-secret` (a CLI da carga mensal e os jobs) OU
// master. Antes era um gate próprio que relia `user_roles` à mão — agora compõe os gates COMPARTILHADOS de
// `_shared/auth.ts`: `authorizeCron` e `authorizeMaster` (que também aceita o Bearer service role, como toda edge
// master). Os gates entram por parâmetro para o teste rodar sem rede nem env (`gate_test.ts`).

type Resultado = { ok: boolean };

export interface GatesIngest {
  cron: (req: Request) => Resultado;
  master: (req: Request) => Promise<Resultado>;
}

/** Cron válido passa sem consultar o master (nenhuma chamada de auth no caminho do cron); senão decide o master. */
export async function autorizarIngest(req: Request, gates: GatesIngest): Promise<boolean> {
  if (gates.cron(req).ok) return true;
  return (await gates.master(req)).ok;
}

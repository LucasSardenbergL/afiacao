// ALLOWLIST POSITIVA da sonda de deploy por cron — default-deny.
//
// Uma edge só entra aqui depois de `bun run sonda:cron-prova` EXECUTAR 100 % dos closures
// históricos dela com o `OPTIONS` do relé e contar zero efeito, com controle positivo mostrando
// que o contador enxerga o fluxo real daquele mesmo bundle (spec v5 §4.4). Não há recorte de
// história: closure que não dá para executar (`INVERIFICAVEL`) mantém a edge FORA.
//
// Esta lista é a fonte única: o relé a importa (default-deny em runtime), o banco a espelha
// (`public.deploy_sonda_alvos`, F2) e `bun run pendencias:deploy` exige `banco ⊆ repo`.

export type ControlePositivo = {
  metodo: "POST";
  /**
   * Headers do controle. `$NOME` é resolvido pelo runner contra a env de teste (`$CRON_SECRET`,
   * `$SUPABASE_SERVICE_ROLE_KEY`, `$OMIE_WEBHOOK_SECRET`, …) — nenhum segredo real vive aqui.
   */
  headers: Record<string, string>;
  corpo: string | null;
  /**
   * Por que ESTE controle dispara o fluxo real nesta edge/época. A escada existe porque o gate
   * mudou ao longo da história: 6 closures antigos de `calculate-scores` só destravam pelo Bearer,
   * e um controle que não dispara nada tornaria o veredito "inerte" indistinguível de "não medi".
   */
  nota: string;
};

export type AlvoSondaCron = {
  edge: string;
  /** sha do commit que introduziu o ramo `atenderSondaOptions`; null = ramo ainda fora da história. */
  desde: string | null;
  controles: readonly ControlePositivo[];
};

const JSON_HEADERS = { "content-type": "application/json" };

/** Época `authorizeCron` / `authorizeCronOrStaff`: o cron secret libera o fluxo real. */
const CRON: ControlePositivo = {
  metodo: "POST",
  headers: { ...JSON_HEADERS, "x-cron-secret": "$CRON_SECRET" },
  corpo: "{}",
  nota: "época authorizeCron/authorizeCronOrStaff: x-cron-secret libera o fluxo real",
};

/** Época em que o gate só aceitava JWT/service role (calculate-scores até meados de 2026). */
const BEARER: ControlePositivo = {
  metodo: "POST",
  headers: { ...JSON_HEADERS, Authorization: "Bearer $SUPABASE_SERVICE_ROLE_KEY" },
  corpo: "{}",
  nota: "época só-JWT/service role: nessas versões o x-cron-secret devolve 401 e só o Bearer entra",
};

/** Época sem gate nenhum (monthly-report@ef08dddd2, calculate-scores@45a80118b): POST cru executa. */
const SEM_CREDENCIAL: ControlePositivo = {
  metodo: "POST",
  headers: { ...JSON_HEADERS },
  corpo: "{}",
  nota: "época SEM gate: o POST cru executa o fluxo real — é a classe que derrubou o desenho por header",
};

export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [
  {
    edge: "sonda-relay",
    desde: "2c55a71edca3",
    controles: [{
      metodo: "POST",
      headers: { ...JSON_HEADERS, "x-cron-secret": "$CRON_SECRET" },
      corpo: '{"alvo":"monthly-report","tick":"tick-de-teste"}',
      nota: "o POST operacional do cron: o efeito visível é o fetch OPTIONS de saída (replay do relé)",
    }],
  },
  { edge: "monthly-report", desde: "2c55a71edca3", controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "calculate-scores", desde: "2c55a71edca3", controles: [SEM_CREDENCIAL, CRON, BEARER] },
  {
    edge: "sync-reprocess",
    desde: "2c55a71edca3",
    controles: [
      { ...SEM_CREDENCIAL, corpo: '{"action":"reprocess_orders","account":"oben"}', nota: "época SEM gate + roteamento por action: corpo vazio cai no 400 do default sem tocar banco" },
      { ...CRON, corpo: '{"action":"reprocess_orders","account":"oben"}', nota: "roteia por action: corpo vazio cai em 400 sem IO; reprocess_orders lê e reconcilia pedidos" },
      { ...BEARER, corpo: '{"action":"reprocess_orders","account":"oben"}', nota: "mesma action na época em que o gate só aceitava Bearer" },
    ],
  },
];

export function slugsDaAllowlist(): ReadonlySet<string> {
  return new Set(SONDA_CRON_ALVOS.map((a) => a.edge));
}

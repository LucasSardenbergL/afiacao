// ALLOWLIST POSITIVA da sonda de deploy por cron — default-deny.
//
// Uma edge só entra aqui depois de `bun run sonda:cron-prova` EXECUTAR 100 % dos closures
// históricos dela com o `OPTIONS` do relé e contar zero efeito, com controle positivo mostrando
// que o contador enxerga o fluxo real daquele mesmo bundle (spec v5 §4.4). Não há recorte de
// história: closure que não dá para executar (`INVERIFICAVEL`) mantém a edge FORA.
//
// Esta lista é a fonte única: o relé a importa (default-deny em runtime), o banco a espelha
// (`public.deploy_sonda_alvos`, F2) e `bun run pendencias:deploy` exige `banco ⊆ repo`.

type ControlePositivo = {
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
  /**
   * Sha do commit que introduziu o ramo — DOCUMENTAL, para quem lê. O veredito da prova NÃO usa
   * este campo: ele pergunta se o closure contém o ramo (`closureTemRamo`), porque um sha do
   * próprio branch não sobrevive ao rebase nem ao squash do auto-merge.
   */
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

/**
 * Mesma época de auth, corpo diferente. Existe porque nem toda edge dispara efeito com `{}`:
 * `sync-reprocess` ROTEIA POR `action` e um corpo sem action conhecida cai no `default` 400 — o
 * controle ficaria inerte e "não dispara nada" é indistinguível de "não medi".
 */
function comCorpo(base: ControlePositivo, corpo: string, porque: string): ControlePositivo {
  return { ...base, corpo, nota: `${base.nota} · ${porque}` };
}

/** O corpo que faz a `sync-reprocess` escrever: reconcilia pedidos e dá upsert em product_costs. */
const ACTION_REPROCESS = '{"action":"reprocess_all"}';

// ⚠️ `sync-reprocess` NÃO entra na F1 por COLISÃO, não por risco: o PR #2224 (money-path, preço
// ausente do Omie) bumpa o mesmo `versao.ts` para `v1.3-preco-ausente-nao-e-zero` e mergeia antes.
// Ela entra na F4 (ondas), depois daquele merge, com `desde` próprio. A classe que ela traria
// ("roteia por action") não é risco DO OPTIONS: o roteamento acontece muito depois do bloco.
export const SONDA_CRON_ALVOS: readonly AlvoSondaCron[] = [
  {
    edge: "sonda-relay",
    desde: "de281e7b5783",
    controles: [{
      metodo: "POST",
      headers: { ...JSON_HEADERS, "x-cron-secret": "$CRON_SECRET" },
      corpo: '{"alvo":"monthly-report","tick":"tick-de-teste"}',
      nota: "o POST operacional do cron: o efeito visível é o fetch OPTIONS de saída (replay do relé)",
    }],
  },
  { edge: "monthly-report", desde: "2c55a71edca3", controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "calculate-scores", desde: "2c55a71edca3", controles: [SEM_CREDENCIAL, CRON, BEARER] },
  // F4 onda 1. Entrou agora porque o PR #2224 mergeou (2026-09-06) e liberou o `versao.ts`; a
  // dívida era de COLISÃO, nunca de risco. Os três controles carregam `action` real: com `{}` esta
  // edge devolve 400 e o contador jamais subiria — controle inerte aprova qualquer coisa.
  {
    edge: "sync-reprocess",
    desde: null,
    controles: [
      comCorpo(SEM_CREDENCIAL, ACTION_REPROCESS, "action real: sem ela o roteador devolve 400 antes de qualquer escrita"),
      comCorpo(CRON, ACTION_REPROCESS, "idem — o gate atual é authorizeCron"),
      comCorpo(BEARER, ACTION_REPROCESS, "idem, para closures cuja época só aceitava JWT"),
    ],
  },
];

export function slugsDaAllowlist(): ReadonlySet<string> {
  return new Set(SONDA_CRON_ALVOS.map((a) => a.edge));
}

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
 * Mesma época de auth, corpo diferente: aproxima o controle do fluxo REAL da edge.
 *
 * A razão original era outra e a medição a derrubou. Supus que `sync-reprocess`, que roteia por
 * `action`, deixaria o controle INERTE com `{}` (cai no `default` 400). Falso: sabotando o corpo
 * para `{}` — com o cache já invalidando por controle, 44 closures REEXECUTADOS — os 44 seguiram
 * `PASSA`, logo o contador sobe mesmo assim. O `versao.ts` da edge explica: antes do roteador o
 * bundle paga `createClient` e uma leitura de config, e leitura já é efeito contado.
 *
 * O helper fica porque um controle que só toca a config exerce MENOS do que um que escreve: ele
 * prova que o contador não está cego, não que enxerga o fluxo profundo. Preferir o corpo real é
 * rigor barato — não a diferença entre provar e não provar.
 */
function comCorpo(base: ControlePositivo, corpo: string, porque: string): ControlePositivo {
  return { ...base, corpo, nota: `${base.nota} · ${porque}` };
}

/** O corpo que faz a `sync-reprocess` escrever: reconcilia pedidos e dá upsert em product_costs. */
const ACTION_REPROCESS = '{"action":"reprocess_all"}';

/**
 * O corpo que faz a `copilot-analyze` chamar o LLM — sem ele o controle é INERTE. Medido em
 * 2026-09-08: com `{}`, o closure `8224d4593` (fev/26, época SEM gate nenhum) devolve o 400 de
 * `transcript.trim().length < 5` **antes** do `fetch('https://ai.lovable.dev/chat/v1')`, o
 * contador não sobe e o veredito sai `INVERIFICAVEL` — 14/15 closures PASSA e a edge fica FORA.
 * `INVERIFICAVEL` é o veredito honesto para "não consegui fazer o contador subir", nunca um
 * quase-verde: o que ele diz é que o controle não prova nada, e controle inerte aprova qualquer
 * coisa. A transcrição precisa passar dos 5 caracteres em TODA época — é o único gate de forma
 * que o campo teve.
 */
const TRANSCRIPT_REAL =
  '{"transcript":"cliente pediu orcamento de afiacao para 12 laminas industriais"}';

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
  // dívida era de COLISÃO, nunca de risco. Os controles carregam `action` real para exercer o
  // fluxo profundo (reconcilia pedidos, upsert em product_costs) — ver `comCorpo` para o que a
  // medição mostrou sobre o corpo vazio.
  {
    edge: "sync-reprocess",
    desde: null,
    controles: [
      comCorpo(SEM_CREDENCIAL, ACTION_REPROCESS, "action real: sem ela o roteador devolve 400 antes de qualquer escrita"),
      comCorpo(CRON, ACTION_REPROCESS, "idem — o gate atual é authorizeCron"),
      comCorpo(BEARER, ACTION_REPROCESS, "idem, para closures cuja época só aceitava JWT"),
    ],
  },
  // F4 onda 1 — as cinco de efeito NÃO-externo e menor custo de prova (o levantamento de
  // 2026-09-07 achou 42 edges com efeito externo, 13 com escrita e 1 só de leitura). Nenhuma
  // manda e-mail, mensagem ou escreve em sistema de terceiro: se a prova falhasse em alguma, o
  // pior caso continuaria dentro do nosso banco. `desde: null` porque o veredito pergunta ao
  // artefato (`closureTemRamo`), não ao sha.
  { edge: "reposicao-depara-sayerlack-auto", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "carteira-positivacao-snapshot", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "process-recurring-orders", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  // F4 onda 2 (2026-09-08) — as que mais CHURNAM, que é o que faz o chip renascer: medido em
  // `git log --since='60 days ago' -- 'supabase/functions/*/versao.ts'`, cada bump aqui é uma
  // pendência de deploy que hoje espera colagem humana para virar prova. Continuam de fora as de
  // efeito EXTERNO (`enviar-pedido-portal-sayerlack`, `disparar-pedidos-aprovados`,
  // `sayerlack-captura-precos`): o risco de um closure histórico tocar o portal do fornecedor não
  // se paga pela conveniência, e a prova delas é onda própria. Quem decide é o
  // `sonda:cron-prova` — entrar na lista é a PERGUNTA, não a resposta.
  {
    edge: "copilot-analyze",
    desde: null,
    controles: [
      comCorpo(SEM_CREDENCIAL, TRANSCRIPT_REAL, "época sem gate: o POST cru já chama o LLM"),
      comCorpo(CRON, TRANSCRIPT_REAL, "época authorizeCronOrStaff"),
      comCorpo(BEARER, TRANSCRIPT_REAL, "épocas que só aceitavam JWT/service role"),
    ],
  },
  { edge: "fin-valor-cockpit", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "recommend", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  { edge: "generate-tactical-plan", desde: null, controles: [SEM_CREDENCIAL, CRON, BEARER] },
  // ⛔ CANDIDATAS DA ONDA 2 QUE A PROVA NÃO APROVOU (2026-09-08). Ficam registradas para a onda 3
  // não repetir o trabalho:
  //   fin-cashflow-engine        0/37  closures PASSA
  //   omie-cliente               1/68
  //   omie-analytics-sync       16/86
  //   omie-vendas-sync         127/188
  //   omie-sync-estoque         28/29
  //   omie-sync-nfes-recebidas  35/36
  //   generate-bundle-argument  12/14
  //
  // ⚠️ CORREÇÃO (mesma data, contado do log do backfill): a primeira redação deste bloco dizia
  // que "o contador de efeito subiu" e que o closure faltante "executaria efeito ao receber o
  // OPTIONS do cron". É FALSO, e do jeito mais caro: as sete somam **ZERO closures FALHA**. Todo
  // não-PASSA aqui é `INVERIFICAVEL` — nenhum bundle executou efeito; o que faltou foi a outra
  // metade da prova. Inflar "não medi" para "medi e é perigoso" num comentário que existe para
  // calibrar evidência é o erro que este arquivo inteiro tenta impedir, e ele foi meu.
  //
  // O que INVERIFICAVEL quer dizer aqui, medido closure a closure:
  //   · seis delas — CONTROLE INERTE. O `{}` dos controles padrão morre numa validação de entrada
  //     antes do primeiro efeito, então o contador não sobe e o zero de (a) não vale nada. É o
  //     MESMO diagnóstico que a `copilot-analyze` teve (14/15 → 15/15 com `TRANSCRIPT_REAL`), e
  //     tem a MESMA correção: achar o corpo que leva o handler até o efeito.
  //   · `omie-cliente` — outra causa: bundles históricos que nem importam
  //     (`Identifier 'upsertAddressFromOmie' has already been declared`). Enquanto não se souber
  //     se isso é o bundle ou o materializador, ela não é comparável às outras.
  //
  // Isso NÃO as promove a seguras: `INVERIFICAVEL` continua barrando, e é para isso que ele
  // serve. Muda o trabalho da onda 3 — de "achar o efeito perigoso" para "consertar o controle".
  // Entrar na lista é a PERGUNTA; quem responde é a prova.
  // FORA da onda 1, e o motivo é do CONTROLE, não do risco: `omie-webhook` e `omie-nfe-webhook`
  // recusam `{}` sem tocar em nada, e os closures saíram INVERIFICAVEL — o veredito honesto para
  // "não consegui fazer o contador subir". Zero efeito com controle inerte não prova nada: aprova
  // qualquer coisa. Já TENTADO e insuficiente (para a onda 2 não repetir):
  //   omie-webhook     {"topic":"Financas.ContaPagar.Alterado","messageId":"…","appKey":"…",
  //                     "author":"…","event":{"id":1}}
  //   omie-nfe-webhook {"chave_acesso":"<44 zeros>","nfe":{"chave_acesso":"<44 zeros>"}}
  // Elas entram quando alguém determinar o payload que leva cada uma até o insert.
];

export function slugsDaAllowlist(): ReadonlySet<string> {
  return new Set(SONDA_CRON_ALVOS.map((a) => a.edge));
}

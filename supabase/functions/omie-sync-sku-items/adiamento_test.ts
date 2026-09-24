// Testa o CÓDIGO REAL de adiamento.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync-sku-items/adiamento_test.ts
//
// O incidente que este módulo fecha (OBEN, 46 runs `error` entre 2026-08-27 e 2026-09-23): o step
// NFe do `omie-cron-diario` consulta `ConsultarRecebimento(nIdReceb)` segundos antes desta edge
// repetir a chamada IDÊNTICA; a Omie responde "Consumo redundante detectado. Aguarde ~50 segundos
// (REDUNDANT)"; a espera não cabe no guard de 50s do run; o `callOmie` LANÇAVA e o `catch` do
// laço punia a NFe com `marcarTentativa` (backoff 6h/24h/72h) por um limite do RUN — e o run
// fechava `error` "1 consultas Omie tentadas, 0 OK" (2 seguidos = e-mail falso).
//
// As falsificações que importam, em ordem de custo:
//   (a) limite que NÃO cabe no deadline é ADIAMENTO, nunca falha — e a marca é ESTRUTURAL:
//       um `Error` com o mesmo texto NÃO passa no guard (texto de mensagem não é contrato);
//   (b) um run só com adiamentos de NFes recentes fecha `complete` (a assinatura do incidente
//       vira undefined), e falha REAL com 0 OK continua `error`;
//   (c) "fila não anda" grita pela NFe elegível há >48h não tratada MESMO com outras NFes
//       respondendo — e não grita por NFe tratada, sem nIdReceb, elegível há pouco, nem pela NFe
//       de PEDIDO que nasceu dias antes do faturamento (a régua do t2 a pegaria: medido);
//   (d) o controle morto é medido contra as marcações FEITAS, não contra as consultas tentadas.
import {
  adiarConsulta,
  avaliarFilaParada,
  decidirErroDoRun,
  decidirLimite,
  ehConsultaAdiada,
  ehRespostaDeLimite,
  ELEGIVEL_HA_MUITO_MS,
  elegivelDesdeMs,
  type EstadoDoRun,
  esperaPedidaMs,
  motivoDaTentativa,
  saidaDoLaco,
} from "./adiamento.ts";
import { MIN_REQUEST_MS } from "../_shared/omie-deadline.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}

const T0 = 1_000_000; // relógio fixo: nada aqui pode depender de Date.now()
const DEADLINE = T0 + 50_000; // TIMEOUT_GUARD_MS da edge
const REDUNDANT = "Consumo redundante detectado. Aguarde 51 segundos (REDUNDANT)";

/** Run neutro (nada a reportar) — cada teste muda só o eixo que está provando. */
function estado(p: Partial<EstadoDoRun>): EstadoDoRun {
  return {
    consultas_detalhadas: 0,
    consultas_falhas: 0,
    fila_parada_48h: 0,
    controle_marcacoes: 0,
    controle_falhas: 0,
    itens_processados: 0,
    erros: 0,
    recompute_erro: null,
    ...p,
  };
}

Deno.test("ehRespostaDeLimite: 429, REDUNDANT e rate limit são limite; HTTP 5xx e fault de negócio não", () => {
  assertEquals(ehRespostaDeLimite(429, ""), true, "429 sem faultstring é limite");
  assertEquals(ehRespostaDeLimite(200, REDUNDANT), true, "REDUNDANT vem em HTTP 200");
  assertEquals(ehRespostaDeLimite(500, REDUNDANT), true, "a faultstring de limite vence o status");
  assertEquals(ehRespostaDeLimite(200, "API rate limit exceeded"), true);
  assertEquals(ehRespostaDeLimite(200, "Já existe uma requisição desse método"), true);
  assertEquals(ehRespostaDeLimite(200, ""), false, "200 limpo não é limite");
  assertEquals(ehRespostaDeLimite(500, ""), false, "5xx sem faultstring é falha, não limite");
  assertEquals(ehRespostaDeLimite(200, "Recebimento inexistente"), false, "fault de negócio não é limite");
});

Deno.test("esperaPedidaMs: obedece o 'Aguarde N segundos' da Omie (+3s de folga) e cai no fallback sem ele", () => {
  assertEquals(esperaPedidaMs(REDUNDANT, 5_000), 54_000);
  assertEquals(esperaPedidaMs("aguarde 2 SEGUNDOS", 5_000), 5_000, "case-insensitive");
  assertEquals(esperaPedidaMs("API rate limit exceeded", 5_000), 5_000, "sem N → fallback");
  assertEquals(esperaPedidaMs("", 7_000), 7_000);
});

Deno.test("decidirLimite: espera que NÃO cabe no deadline do run → ADIAR (o caso do incidente)", () => {
  const v = decidirLimite({ agora: T0, deadline: DEADLINE, esperaMs: 54_000, tentativa: 1, maxTentativas: 3 });
  assertEquals(v.tipo, "adiar");
  if (v.tipo !== "adiar") throw new Error("inalcançável");
  assertEquals(v.consulta.motivo, "limite_nao_cabe_no_deadline");
  assertEquals(v.consulta.esperaMs, 54_000);
  assertEquals(ehConsultaAdiada(v.consulta), true);
});

Deno.test("decidirLimite: espera que cabe → ESPERAR e retentar; no limite exato do deadline ainda cabe", () => {
  assertEquals(
    decidirLimite({ agora: T0, deadline: DEADLINE, esperaMs: 5_000, tentativa: 1, maxTentativas: 3 }),
    { tipo: "esperar", esperaMs: 5_000 },
  );
  // Borda: sobra == espera + MIN_REQUEST_MS ⇒ cabe (o `>=` do cabeEspera). 1ms a mais ⇒ não cabe.
  const justo = 50_000 - MIN_REQUEST_MS;
  assertEquals(decidirLimite({ agora: T0, deadline: DEADLINE, esperaMs: justo, tentativa: 1, maxTentativas: 3 }).tipo, "esperar");
  assertEquals(decidirLimite({ agora: T0, deadline: DEADLINE, esperaMs: justo + 1, tentativa: 1, maxTentativas: 3 }).tipo, "adiar");
});

Deno.test("decidirLimite: limite que PERSISTE na última tentativa → ADIAR sem dormir (era throw + tentativa punida)", () => {
  const v = decidirLimite({ agora: T0, deadline: DEADLINE, esperaMs: 5_000, tentativa: 3, maxTentativas: 3 });
  assertEquals(v.tipo, "adiar");
  if (v.tipo !== "adiar") throw new Error("inalcançável");
  assertEquals(v.consulta.motivo, "limite_persistiu_apos_retentativas");
});

Deno.test("ehConsultaAdiada: só a marca ESTRUTURAL passa — texto igual num Error, motivo fora do conjunto ou resposta Omie não passam", () => {
  const adiada = adiarConsulta("deadline_antes_da_chamada", 0, "ConsultarRecebimento: deadline do run atingido antes da chamada");
  assertEquals(ehConsultaAdiada(adiada), true);
  assertEquals(adiada.adiada, true);
  assertEquals(adiada.motivo, "deadline_antes_da_chamada");
  // O contrato NÃO é o texto: o mesmo texto num Error é falha, não adiamento (classe do #1782).
  assertEquals(ehConsultaAdiada(new Error("Omie ConsultarRecebimento: limite pede 54s de espera, não cabe antes do deadline do run")), false);
  assertEquals(ehConsultaAdiada({ adiada: true, motivo: "qualquer_coisa", esperaMs: 0, detalhe: "" }), false, "motivo fora do conjunto fechado");
  assertEquals(ehConsultaAdiada({ adiada: "true", motivo: "limite_nao_cabe_no_deadline", esperaMs: 0, detalhe: "" }), false, "adiada tem de ser o booleano true");
  assertEquals(ehConsultaAdiada({ itensRecebimento: [] }), false, "resposta normal da Omie");
  assertEquals(ehConsultaAdiada({ faultstring: REDUNDANT }), false, "faultstring crua não é adiamento decidido");
  assertEquals(ehConsultaAdiada(null), false);
  assertEquals(ehConsultaAdiada(undefined), false);
  assertEquals(ehConsultaAdiada("adiada"), false);
});

Deno.test("saidaDoLaco: deadline vencido encerra o laço; limite por chamada segue para a próxima NFe", () => {
  assertEquals(saidaDoLaco("deadline_antes_da_chamada"), "encerrar");
  assertEquals(saidaDoLaco("limite_nao_cabe_no_deadline"), "proxima", "REDUNDANT é por chamada: outra NFe pode responder");
  assertEquals(saidaDoLaco("limite_persistiu_apos_retentativas"), "proxima");
});

Deno.test("motivoDaTentativa: o texto do controle diz o que ACONTECEU — upsert morto não vira 'NFe sem itens'", () => {
  const base = { faultstring: null, itensEhLista: true, itensRecebidos: 0, itensResolvidos: 0, itensGravados: 0, ultimoErroUpsert: null };
  assertEquals(motivoDaTentativa({ ...base, itensRecebidos: 3, itensResolvidos: 2, itensGravados: 2 }), "ok_com_itens");
  assertEquals(
    motivoDaTentativa({ ...base, itensRecebidos: 3, itensResolvidos: 3, itensGravados: 2, ultimoErroUpsert: "check constraint" }),
    "ok_parcial: 2 de 3 gravados; check constraint",
    "gravação PARCIAL não pode se esconder atrás de ok_com_itens",
  );
  assertEquals(
    motivoDaTentativa({ ...base, itensRecebidos: 3, itensResolvidos: 2, itensGravados: 0, ultimoErroUpsert: "permission denied" }),
    "upsert_falhou: permission denied",
    "antes virava ok_0_itens — a mentira de que a NFe não tinha itens",
  );
  assertEquals(motivoDaTentativa({ ...base, faultstring: "Recebimento inexistente" }), "fault: Recebimento inexistente");
  assertEquals(motivoDaTentativa({ ...base, itensEhLista: false }), "ok_sem_itensRecebimento", "chave ausente ≠ lista vazia");
  assertEquals(motivoDaTentativa({ ...base, itensRecebidos: 2 }), "ok_itens_sem_nIdProduto");
  assertEquals(motivoDaTentativa(base), "ok_0_itens");
});

const HORA = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** Backoff FALSO e legível (o real é o espelho da fila no index.ts, fora do alcance deste teste). */
const backoffFalso = (t: number) => t * 10 * HORA;

Deno.test("elegivelDesdeMs: tentada → fim do backoff; nunca tentada → o MAIOR entre nascimento e faturamento", () => {
  const agora = T0 + 1_000 * HORA;
  assertEquals(
    elegivelDesdeMs({ tentativas: 2, ultima_tentativa: iso(agora - 5 * HORA) }, iso(agora - 99 * HORA), iso(agora - 99 * HORA), backoffFalso),
    agora - 5 * HORA + 20 * HORA,
    "tentada: vale o fim do backoff, não a idade da linha",
  );
  // Linha de PEDIDO: nasce dias antes do faturamento (mediana medida: 47h). Vale o faturamento.
  assertEquals(elegivelDesdeMs(undefined, iso(agora - 120 * HORA), iso(agora - 30 * HORA), backoffFalso), agora - 30 * HORA);
  // Órfã do sync de NFes: nasce quando o recebimento aparece, depois do faturamento. Vale o nascimento.
  assertEquals(elegivelDesdeMs(undefined, iso(agora - 3 * HORA), iso(agora - 20 * HORA), backoffFalso), agora - 3 * HORA);
  assertEquals(elegivelDesdeMs({ tentativas: 0, ultima_tentativa: null }, iso(agora - 3 * HORA), null, backoffFalso), agora - 3 * HORA, "tentativas 0 = nunca tentada");
  assertEquals(elegivelDesdeMs(undefined, null, iso(agora - 7 * HORA), backoffFalso), agora - 7 * HORA, "sem created_at, vale o t2");
  assertEquals(elegivelDesdeMs(undefined, "lixo", "lixo", backoffFalso), null, "as duas ilegíveis: indecidível");
  assertEquals(elegivelDesdeMs({ tentativas: 1, ultima_tentativa: null }, iso(agora), iso(agora), backoffFalso), null, "tentada sem data: indecidível");
  assertEquals(elegivelDesdeMs({ tentativas: 1, ultima_tentativa: "lixo" }, iso(agora), iso(agora), backoffFalso), null);
});

/** Linha da fila como o índice a entrega ao sensor (antes do dedup). */
function linha(id: string, nIdReceb: string | null, criadaHaH: number | null, faturadaHaH: number | null, agora: number) {
  return {
    id,
    nIdReceb,
    created_at: criadaHaH === null ? null : iso(agora - criadaHaH * HORA),
    t2_data_faturamento: faturadaHaH === null ? null : iso(agora - faturadaHaH * HORA),
  };
}
const SEM_CONTROLE = new Map<string, { tentativas: number; ultima_tentativa: string | null }>();

Deno.test("avaliarFilaParada: conta RECEBIMENTO com nIdReceb, elegível há mais de 48h e NÃO tratado pelo run", () => {
  const agora = T0 + 1_000 * HORA;
  const fila = [
    linha("A", "1", 60, 60, agora), // parado e não tratado → conta
    linha("B", null, 90, 90, agora), // sem nIdReceb: gap de cobertura, contado à parte
    linha("C", "3", 30, 30, agora), // elegível há pouco: ainda no prazo
    linha("D", "4", 70, 70, agora), // parado, mas tratado neste run
    linha("E", "5", null, null, agora), // indecidível: não se afirma que parou
    linha("F", "6", 48, 48, agora), // exatamente no limite: NÃO é "há mais que"
  ];
  assertEquals(avaliarFilaParada(fila, SEM_CONTROLE, new Set(["4"]), agora, backoffFalso), 1);
  assertEquals(avaliarFilaParada(fila, SEM_CONTROLE, new Set(["1", "4"]), agora, backoffFalso), 0, "tratar o parado zera a contagem");
  assertEquals(avaliarFilaParada([], SEM_CONTROLE, new Set(), agora, backoffFalso), 0, "fila vazia");
  assertEquals(avaliarFilaParada(fila, SEM_CONTROLE, new Set(["4"]), agora, backoffFalso, 100 * HORA), 0, "limite maior que a fila inteira");
});

Deno.test("avaliarFilaParada: irmãs do mesmo recebimento — vale a MAIS ANTIGA, e o recebimento conta UMA vez (achado do Codex)", () => {
  // A fila deduplicada elegeria a irmã nunca tentada (2h) e esconderia a irmã tentada, parada há
  // 60h. O sensor recebe a fila ANTES do dedup e leva a menor "elegível desde" do recebimento.
  const agora = T0 + 1_000 * HORA;
  const controle = new Map([["velha", { tentativas: 1, ultima_tentativa: iso(agora - 70 * HORA) }]]);
  const fila = [linha("virgem", "77", 2, 2, agora), linha("velha", "77", 200, 200, agora), linha("outra", "77", 60, 60, agora)];
  // velha: tentada, backoff falso de 10h ⇒ elegível há 60h ⇒ o recebimento 77 está parado.
  assertEquals(avaliarFilaParada(fila, controle, new Set(), agora, backoffFalso), 1, "três irmãs, um recebimento");
  assertEquals(avaliarFilaParada(fila, controle, new Set(["77"]), agora, backoffFalso), 0, "tratar a eleita trata as irmãs");
});

Deno.test("REGRESSÃO MEDIDA: a NFe de pedido faturada há 30h e adiada no :15 NÃO para a fila (a régua do t2 a contaria)", () => {
  // O caso que derrubou a régua do faturamento (psql-ro, 2026-09-24): enquanto o sku-items for step
  // do orquestrador, toda NFe de 1–3 dias é adiada no :15 (REDUNDANT) e só o diário das 07:00 a
  // alcança. Com "faturada há >24h" ela gritaria em runs SEGUIDOS — o e-mail falso de volta.
  const agora = T0 + 1_000 * HORA;
  assertEquals(avaliarFilaParada([linha("P", "9", 120, 30, agora)], SEM_CONTROLE, new Set(), agora, backoffFalso), 0);
  // E a mesma NFe, se o diário também não a alcançar por mais um dia, passa a contar.
  assertEquals(avaliarFilaParada([linha("P", "9", 120, 54, agora)], SEM_CONTROLE, new Set(), agora, backoffFalso), 1);
});

Deno.test("decidirErroDoRun: run só com ADIAMENTO de NFes elegíveis há pouco fecha complete — a assinatura do incidente vira undefined", () => {
  // O caso medido: 1 (ou 2) consulta tentada, adiada por REDUNDANT, 0 respondida, NFe de hoje.
  assertEquals(decidirErroDoRun(estado({})), undefined);
  assertEquals(decidirErroDoRun(estado({ consultas_detalhadas: 0, consultas_falhas: 0 })), undefined);
});

Deno.test("decidirErroDoRun: falha REAL com 0 OK continua error — o alerta verdadeiro sobrevive ao fix", () => {
  assertEquals(
    decidirErroDoRun(estado({ consultas_falhas: 1, controle_marcacoes: 1 })),
    "1 consultas Omie falharam, 0 OK — rate-limit/indisponibilidade?",
  );
  // 1 resposta basta para não ser sistêmico, mesmo com falhas.
  assertEquals(decidirErroDoRun(estado({ consultas_detalhadas: 1, consultas_falhas: 2, controle_marcacoes: 3 })), undefined);
});

Deno.test("decidirErroDoRun: sensor NÃO avaliado (null, via orquestrador) nunca vira error nem zero", () => {
  assertEquals(decidirErroDoRun(estado({ fila_parada_48h: null })), undefined);
  // e não mascara as outras regras
  assertEquals(
    decidirErroDoRun(estado({ fila_parada_48h: null, consultas_falhas: 1, controle_marcacoes: 1 })),
    "1 consultas Omie falharam, 0 OK — rate-limit/indisponibilidade?",
  );
});

Deno.test("decidirErroDoRun: 'fila não anda' grita pela NFe parada MESMO com outras respondendo", () => {
  // Achado do Codex: com a regra de vazão zero, a mesma NFe adiada para sempre atrás de 3 sucessos
  // ficava verde. A regra agora é pelo DADO da NFe, não pela vazão do run.
  assertEquals(
    decidirErroDoRun(estado({ consultas_detalhadas: 3, controle_marcacoes: 3, itens_processados: 5, fila_parada_48h: 2 })),
    "fila não anda: 2 NFes elegíveis há >48h ficaram sem consulta neste run (adiadas por limite ou não alcançadas pelo guard)",
  );
  assertEquals(
    decidirErroDoRun(estado({ fila_parada_48h: 1 })),
    "fila não anda: 1 NFes elegíveis há >48h ficaram sem consulta neste run (adiadas por limite ou não alcançadas pelo guard)",
    "guard/deadline antes de qualquer chamada, com NFe antiga na fila",
  );
});

Deno.test("decidirErroDoRun: controle morto é medido contra as marcações FEITAS — adiamento não o esconde", () => {
  // Achado do Codex: 1 respondida + 1 adiada, a ÚNICA marcação falha. Com o denominador antigo
  // (consultas_tentadas = 2) o controle morto passava; contra as marcações (1) ele grita.
  assertEquals(
    decidirErroDoRun(estado({ consultas_detalhadas: 1, controle_marcacoes: 1, controle_falhas: 1 })),
    "controle não persistiu em 1/1 tentativas — backoff inoperante (grant/RLS?)",
  );
  assertEquals(decidirErroDoRun(estado({ consultas_detalhadas: 2, controle_marcacoes: 2, controle_falhas: 1 })), undefined, "uma marcação pegou: backoff vivo");
  assertEquals(decidirErroDoRun(estado({ controle_marcacoes: 0, controle_falhas: 0 })), undefined, "sem marcação (só adiadas) não é controle morto");
});

Deno.test("decidirErroDoRun: upsert que NUNCA pega fecha error — complete com efeito zero é o defeito que o registry (b) nomeia", () => {
  assertEquals(
    decidirErroDoRun(estado({ consultas_detalhadas: 1, controle_marcacoes: 1, erros: 3, itens_processados: 0 })),
    "upsert do leadtime falhou em 3 itens, 0 gravados — grant/RLS/constraint?",
  );
  assertEquals(
    decidirErroDoRun(estado({ consultas_detalhadas: 2, controle_marcacoes: 2, erros: 1, itens_processados: 4 })),
    undefined,
    "falha PARCIAL de upsert segue complete com erros>0 (o watchdog já não pagina isso, de propósito)",
  );
});

Deno.test("decidirErroDoRun: precedência — sistêmica > controle > escrita > fila > recompute", () => {
  const recompute = "function recomputar_leadtime_derivado does not exist";
  const tudo = estado({
    consultas_falhas: 1,
    controle_marcacoes: 1,
    controle_falhas: 1,
    erros: 1,
    fila_parada_48h: 1,
    recompute_erro: recompute,
  });
  assertEquals(decidirErroDoRun(tudo), "1 consultas Omie falharam, 0 OK — rate-limit/indisponibilidade?");
  assertEquals(
    decidirErroDoRun({ ...tudo, consultas_falhas: 0 }),
    "controle não persistiu em 1/1 tentativas — backoff inoperante (grant/RLS?)",
  );
  assertEquals(
    decidirErroDoRun({ ...tudo, consultas_falhas: 0, controle_falhas: 0 }),
    "upsert do leadtime falhou em 1 itens, 0 gravados — grant/RLS/constraint?",
  );
  assertEquals(
    decidirErroDoRun({ ...tudo, consultas_falhas: 0, controle_falhas: 0, erros: 0 }),
    "fila não anda: 1 NFes elegíveis há >48h ficaram sem consulta neste run (adiadas por limite ou não alcançadas pelo guard)",
  );
  // Recompute quebrado com todas as NFes adiadas (recentes): o recompute ainda grita — adiar a
  // Omie não pode calar a migration faltando.
  assertEquals(
    decidirErroDoRun(estado({ recompute_erro: recompute })),
    `recompute derivado do leadtime falhou (migration 20260716200000 aplicada? grant do service_role?): ${recompute}`,
  );
});

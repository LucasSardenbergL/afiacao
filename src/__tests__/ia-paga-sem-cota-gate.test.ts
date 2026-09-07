import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { temAuthzDominante } from '@/lib/gates/authz-dominante';

// ── GATE: edge de IA PAGA que não exige staff PRECISA consumir cota ─────────────
//
// Instância-âncora: `elevenlabs-transcribe`. Ela declarava `verify_jwt = false`,
// validava a ASSINATURA do JWT (`getClaims`) e parava aí — sem checar role, sem
// checar `is_approved` e sem cota, indo direto à ElevenLabs com áudio de até 10MB.
// Como `/auth` é cadastro público e sem convite (`supabase.auth.signUp`), qualquer
// pessoa da internet virava principal válido: um customer com `is_approved=false`,
// barrado em TODA a UI, ainda assim debitava o orçamento da organização em laço.
//
// O RECORTE é a parte que custou a medir, e é o que mantém este gate honesto.
// Medição de 2026-08-28 sobre `supabase/functions/`: 17 edges chamam provedor de
// IA pago e 12 delas NÃO consomem cota — mas nessas 12 uma checagem de papel roda
// em TODA requisição. Entre staff, cota é controle de CUSTO; a ausência dela não é
// falha de autorização, e transformar isso em vermelho seria o defeito que ensina
// a ignorar o vermelho. O que discrimina não é "chama IA paga", é "chama IA paga E
// aceita qualquer principal autenticado".
//
// Sob esse recorte a população exposta é 4 — analyze-services, identify-tool,
// elevenlabs-transcribe e generate-bundle-argument — e as 4 consomem cota. O gate
// fica VERDE e SEM baseline: não há dívida para apodrecer, e a próxima edge de IA
// aberta a qualquer JWT que esquecer a cota sai vermelha na hora.
//
// ── CORREÇÃO DE 2026-08-28 (o gate nasceu com um FALSO-NEGATIVO) ──────────────
// A primeira versão perguntava se o arquivo MENCIONA `authorizeCronOrStaff` para
// decidir "staff-only, logo isenta". `generate-bundle-argument` menciona — dentro
// de `if (decisaoSonda.tipo !== "disparo")`, guardando só o ramo da SONDA. O
// caminho de DISPARO, o que gasta token na Anthropic, chegava lá com `getUser()`
// pelado. O gate ficou VERDE em cima da mesma vulnerabilidade que existe para
// pegar: falso-negativo, a direção cara.
//
// O discriminador certo não é "o arquivo cita o helper", é "TODA requisição passa
// pela checagem" — DOMINÂNCIA, medida por AST em `@/lib/gates/authz-dominante`
// (contar chaves no texto quebraria dentro dos template literals de prompt, que é
// do que estas edges são feitas). E a checagem conta em duas formas: o helper
// compartilhado ou a leitura inline de `user_roles` — `analyze-unified-order` usa
// a segunda e é legitimamente isenta; reprová-la seria o vermelho que ensina a
// ignorar o vermelho.
//
// A cota, do lado SQL, é fail-CLOSED por desenho: `ia_consumir_cota` devolve
// `sem_limite` (→ HTTP 503) para função sem linha em `ia_uso_limite`. Portanto
// ADICIONAR a chamada aqui SEM semear o limite em produção derruba a edge — a
// ordem de entrega é seed primeiro, deploy depois.
//
// Comentário é removido com o stripper COMPARTILHADO antes de medir: um `//
// consumirCota(...)` comentado, ou o nome citado em prosa, forjaria verde.

const RAIZ = resolve(__dirname, '../..');
const DIR_EDGES = 'supabase/functions';

const PROVEDOR_PAGO =
  /api\.elevenlabs\.io|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis|ai\.gateway\.lovable\.dev|@anthropic-ai\/sdk/;
const CONSOME_COTA = /\bconsumirCota\s*\(/;

interface Edge {
  nome: string;
  /** Uma checagem de papel roda em TODA requisição desta edge? (AST, não menção.) */
  gateDominante: boolean;
  consomeCota: boolean;
}

function edgesDeIaPaga(): Edge[] {
  const raiz = resolve(RAIZ, DIR_EDGES);
  const achados: Edge[] = [];
  for (const nome of readdirSync(raiz)) {
    if (nome === '_shared' || nome.startsWith('.')) continue;
    const dir = join(raiz, nome);
    if (!statSync(dir).isDirectory()) continue;
    const entrada = join(dir, 'index.ts');
    if (!existsSync(entrada)) continue;

    const fonte = removerComentarios(readFileSync(entrada, 'utf-8'));
    if (!PROVEDOR_PAGO.test(fonte)) continue;

    achados.push({
      nome,
      gateDominante: temAuthzDominante(fonte),
      consomeCota: CONSOME_COTA.test(fonte),
    });
  }
  return achados.sort((a, b) => a.nome.localeCompare(b.nome));
}

describe('gate: IA paga aberta a qualquer JWT precisa de cota', () => {
  it('toda edge de IA paga sem gate de papel DOMINANTE consome cota', () => {
    const descobertas = edgesDeIaPaga()
      .filter((e) => !e.gateDominante && !e.consomeCota)
      .map((e) => e.nome);

    expect(
      descobertas,
      `Edge(s) chamando provedor de IA PAGO, sem checagem de papel que DOMINE o ` +
        `handler (helper de authz ou leitura de user_roles rodando em toda ` +
        `requisição — um gate aninhado num ramo guarda só aquele ramo) e SEM consumirCota: ` +
        `${descobertas.join(', ')}. Cadastro em /auth é público, então "JWT válido" ` +
        `inclui customer não aprovado. Porte o par de identify-tool: ` +
        `consumirCota(cliente, userId, '<slug>', '<rótulo>') + headersDeCota. ` +
        `E SEMEIE ia_uso_limite ANTES do deploy — sem a linha, a RPC devolve 503.`,
    ).toEqual([]);
  });

  // ── Sentinelas de vacuidade ───────────────────────────────────────────────────
  // Sem estas, uma regex podre (provedor renomeado, import trocado) esvazia a
  // população e o teste acima passa por CEGUEIRA, afirmando mais do que mediu. E a
  // dominância tem sentinela nos DOIS sentidos: um detector que responda sempre
  // "domina" isenta todo mundo (o falso-negativo original), um que responda sempre
  // "não domina" reprova as 12 legítimas. A mecânica em si é falsificada por fixture
  // em `src/lib/gates/__tests__/authz-dominante.test.ts`.

  it('ancora em instâncias conhecidas — regex podre não passa despercebida', () => {
    const porNome = new Map(edgesDeIaPaga().map((e) => [e.nome, e]));

    // As âncoras da classe: IA paga, abertas a qualquer JWT válido, com cota.
    // `generate-bundle-argument` entra aqui porque seu gate guarda SÓ a sonda — se um dia o
    // detector voltar a lê-lo como dominante, é o falso-negativo renascendo.
    for (const nome of ['elevenlabs-transcribe', 'identify-tool', 'generate-bundle-argument']) {
      const e = porNome.get(nome);
      expect(e, `${nome} sumiu da população de IA paga — regex de provedor podre?`).toBeDefined();
      expect(
        e!.gateDominante,
        `${nome} passou a ter gate de papel dominando o handler — revise o recorte do gate`,
      ).toBe(false);
      expect(e!.consomeCota, `${nome} perdeu a cota — é exatamente a regressão deste gate`).toBe(true);
    }

    // Âncora do lado isento: gate dominante sem cota é legítimo e precisa continuar visível.
    const gateadaSemCota = edgesDeIaPaga().filter((e) => e.gateDominante && !e.consomeCota);
    expect(
      gateadaSemCota.length,
      'nenhuma edge com gate dominante e sem cota foi vista; a medição de 2026-08-28 achou 12 — detector podre?',
    ).toBeGreaterThanOrEqual(8);

    // Âncora da DOMINÂNCIA: `analyze-unified-order` gateia o caminho de disparo por
    // `user_roles` inline, tendo um `authorizeCronOrStaff` aninhado no ramo da sonda. Se ela
    // aparecer como exposta, o detector deixou de enxergar a checagem inline e o gate passou
    // a produzir vermelho falso — que é como um gate perde a credibilidade.
    const inline = porNome.get('analyze-unified-order');
    expect(inline, 'analyze-unified-order sumiu da população de IA paga').toBeDefined();
    expect(
      inline!.gateDominante,
      'analyze-unified-order deixou de ser vista como gateada — a checagem inline de user_roles sumiu do detector',
    ).toBe(true);
  });

  it('a população medida não colapsou', () => {
    const todas = edgesDeIaPaga();
    expect(
      todas.length,
      'medição de 2026-08-28: 17 edges de IA paga. Caiu abaixo de 12 — regex de provedor podre?',
    ).toBeGreaterThanOrEqual(12);
  });
});

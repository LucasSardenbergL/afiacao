import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

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
// IA pago, e 13 delas NÃO consomem cota — mas todas as 13 exigem staff/master
// (`authorizeCronOrStaff`/`authorizeMaster`). Entre staff, cota é controle de
// CUSTO; a ausência dela não é falha de autorização, e transformar isso em
// vermelho seria o defeito que ensina a ignorar o vermelho. O que discrimina não
// é "chama IA paga", é "chama IA paga E aceita qualquer principal autenticado".
//
// Sob esse recorte a população é 3 — analyze-services, identify-tool e
// elevenlabs-transcribe — e as 3 consomem cota. O gate nasce VERDE e SEM baseline:
// não há dívida para apodrecer, e a próxima edge de IA aberta a qualquer JWT que
// esquecer a cota sai vermelha na hora.
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
const EXIGE_STAFF = /\bauthorize(?:CronOrStaff|Master|Staff)\s*\(/;
const CONSOME_COTA = /\bconsumirCota\s*\(/;

interface Edge {
  nome: string;
  exigeStaff: boolean;
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
      exigeStaff: EXIGE_STAFF.test(fonte),
      consomeCota: CONSOME_COTA.test(fonte),
    });
  }
  return achados.sort((a, b) => a.nome.localeCompare(b.nome));
}

describe('gate: IA paga aberta a qualquer JWT precisa de cota', () => {
  it('toda edge de IA paga que não exige staff consome cota', () => {
    const descobertas = edgesDeIaPaga()
      .filter((e) => !e.exigeStaff && !e.consomeCota)
      .map((e) => e.nome);

    expect(
      descobertas,
      `Edge(s) chamando provedor de IA PAGO, aceitando qualquer principal ` +
        `autenticado (sem authorizeCronOrStaff/authorizeMaster) e SEM consumirCota: ` +
        `${descobertas.join(', ')}. Cadastro em /auth é público, então "JWT válido" ` +
        `inclui customer não aprovado. Porte o par de identify-tool: ` +
        `consumirCota(cliente, userId, '<slug>', '<rótulo>') + headersDeCota. ` +
        `E SEMEIE ia_uso_limite ANTES do deploy — sem a linha, a RPC devolve 503.`,
    ).toEqual([]);
  });

  // ── Sentinelas de vacuidade ───────────────────────────────────────────────────
  // Sem estas, uma regex podre (provedor renomeado, import trocado) esvazia a
  // população e o teste acima passa por CEGUEIRA, afirmando mais do que mediu.

  it('ancora em instâncias conhecidas — regex podre não passa despercebida', () => {
    const porNome = new Map(edgesDeIaPaga().map((e) => [e.nome, e]));

    // As duas âncoras da classe: IA paga, abertas a qualquer JWT válido, com cota.
    for (const nome of ['elevenlabs-transcribe', 'identify-tool']) {
      const e = porNome.get(nome);
      expect(e, `${nome} sumiu da população de IA paga — regex de provedor podre?`).toBeDefined();
      expect(e!.exigeStaff, `${nome} passou a exigir staff — revise o recorte do gate`).toBe(false);
      expect(e!.consomeCota, `${nome} perdeu a cota — é exatamente a regressão deste gate`).toBe(true);
    }

    // Âncora do lado isento: staff-gated sem cota é legítimo e precisa continuar visível.
    const staffSemCota = edgesDeIaPaga().filter((e) => e.exigeStaff && !e.consomeCota);
    expect(
      staffSemCota.length,
      'nenhuma edge staff-gated sem cota foi vista; a medição de 2026-08-28 achou 13 — regex podre?',
    ).toBeGreaterThanOrEqual(8);
  });

  it('a população medida não colapsou', () => {
    const todas = edgesDeIaPaga();
    expect(
      todas.length,
      'medição de 2026-08-28: 17 edges de IA paga. Caiu abaixo de 12 — regex de provedor podre?',
    ).toBeGreaterThanOrEqual(12);
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { decidirProbe, gerarAttemptId, deviceIdDoAttempt } from '@/lib/telemetria-probe';

/**
 * Provas do probe de censura (#1984/#2016).
 *
 * O que estes testes protegem não é "a função roda" — é a assimetria que dá
 * SENTIDO à leitura: um `attempt_id` sem par só pode significar "o canal não
 * entregou" se todos os outros motivos de não-emitir tiverem sido descartados
 * ANTES de a linha ser gravada. Cada guard que vaza vira censura fabricada na
 * reconciliação.
 */

const RAIZ = resolve(__dirname, '../../..');

describe('decidirProbe — os guards que impedem censura FABRICADA', () => {
  const base = { jaEmitido: false, telemetriaLigada: true, lenteAtiva: false, userId: 'u1' };

  it('prossegue no caso feliz', () => {
    expect(decidirProbe(base)).toBe('prosseguir');
  });

  it('desiste quando a telemetria está desligada — o falso positivo CARO', () => {
    // Em DEV o SDK faz opt_out_capturing(). Gravar a linha aqui produziria
    // "attempt_id sem par" em TODA sessão de desenvolvimento.
    expect(decidirProbe({ ...base, telemetriaLigada: false })).toBe('telemetria_desligada');
  });

  it('a telemetria desligada tem precedência sobre a falta de usuário', () => {
    // A ORDEM importa: se `sem_usuario` viesse antes, um dev deslogado veria
    // `sem_usuario` e o gate de telemetria nunca seria exercido em teste.
    expect(decidirProbe({ ...base, telemetriaLigada: false, userId: null })).toBe(
      'telemetria_desligada',
    );
  });

  it('desiste na lente "ver como" — o write-guard barraria o INSERT', () => {
    expect(decidirProbe({ ...base, lenteAtiva: true })).toBe('lente_ativa');
  });

  it('desiste sem usuário — a RLS exige auth.uid() = user_id', () => {
    expect(decidirProbe({ ...base, userId: null })).toBe('sem_usuario');
    expect(decidirProbe({ ...base, userId: undefined })).toBe('sem_usuario');
  });

  it('emite no máximo uma vez por boot', () => {
    expect(decidirProbe({ ...base, jaEmitido: true })).toBe('ja_emitido');
  });
});

describe('attempt_id carrega o APARELHO — o eixo que faltava', () => {
  it('embute o device_id e faz round-trip', () => {
    const device = '11111111-2222-3333-4444-555555555555';
    const attempt = gerarAttemptId(device);
    expect(attempt.startsWith(`${device}.`)).toBe(true);
    expect(deviceIdDoAttempt(attempt)).toBe(device);
  });

  it('dois attempt_id do MESMO aparelho compartilham o device e diferem entre si', () => {
    // Esta é literalmente a condição de conclusão da reconciliação:
    // "dois attempt_id sem par, em sessões distintas do MESMO aparelho".
    const device = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const a = gerarAttemptId(device);
    const b = gerarAttemptId(device);
    expect(a).not.toBe(b);
    expect(deviceIdDoAttempt(a)).toBe(deviceIdDoAttempt(b));
  });

  it('devolve null para forma inválida em vez de fabricar um aparelho', () => {
    expect(deviceIdDoAttempt('sem-ponto')).toBeNull();
    expect(deviceIdDoAttempt('.comeca-com-ponto')).toBeNull();
    expect(deviceIdDoAttempt('termina-com-ponto.')).toBeNull();
  });

  it('cabe no CHECK de tamanho da tabela (10..128)', () => {
    const attempt = gerarAttemptId('11111111-2222-3333-4444-555555555555');
    expect(attempt.length).toBeGreaterThanOrEqual(10);
    expect(attempt.length).toBeLessThanOrEqual(128);
  });
});

describe('sentinela: telemetriaAtiva espelha os gates REAIS do init', () => {
  // O probe confia em `telemetriaAtiva()` para não gravar onde o PostHog está
  // desligado por config. Se os gates de `initAnalytics` mudarem e este espelho
  // não, o probe passa a fabricar censura em silêncio. Lê a fonte com o stripper
  // COMPARTILHADO porque o comentário do próprio gate cita `opt_out_capturing`
  // e `VITE_POSTHOG_KEY` de propósito — regex local mediria a explicação.
  const fonte = removerComentarios(readFileSync(resolve(RAIZ, 'src/lib/analytics.ts'), 'utf8'));

  it('o init ainda aborta sem KEY', () => {
    expect(fonte).toMatch(/if\s*\(\s*!KEY\s*\)/);
  });

  it('o init ainda faz opt-out em DEV', () => {
    expect(fonte).toMatch(/import\.meta\.env\.DEV/);
    expect(fonte).toMatch(/opt_out_capturing\(\)/);
  });

  it('telemetriaAtiva testa exatamente esses dois eixos', () => {
    const corpo = fonte.match(/export function telemetriaAtiva\(\)[^}]*}/)?.[0] ?? '';
    expect(corpo).toMatch(/KEY/);
    expect(corpo).toMatch(/import\.meta\.env\.DEV/);
  });
});

describe('ORDEM: sem linha na tabela, nada é emitido', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function montar(opts: { erroInsert: unknown }) {
    const insert = vi.fn().mockResolvedValue({ error: opts.erroInsert });
    const track = vi.fn();
    vi.doMock('@/integrations/supabase/client', () => ({
      supabase: { from: () => ({ insert }) },
    }));
    vi.doMock('@/lib/analytics', () => ({ track, telemetriaAtiva: () => true }));
    vi.doMock('@/lib/build-id', () => ({ resolverBuildId: () => 'index-TESTE' }));
    vi.doMock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => false }));
    vi.doMock('@/lib/logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
    const mod = await import('@/lib/telemetria-probe');
    mod._resetProbeParaTeste();
    return { mod, insert, track };
  }

  it('grava na tabela e SÓ ENTÃO emite o evento', async () => {
    const { mod, insert, track } = await montar({ erroInsert: null });
    await expect(mod.executarProbeTelemetria('u1')).resolves.toBe('emitido');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);

    const [evento, props] = track.mock.calls[0] as [string, Record<string, unknown>];
    expect(evento).toBe('telemetria.probe');
    // O attempt_id do evento é o MESMO da linha — senão não há par a reconciliar.
    const linha = insert.mock.calls[0][0] as Record<string, unknown>;
    expect(props.attempt_id).toBe(linha.attempt_id);
    expect(props.device_id).toBe(linha.device_id);
    expect(linha.user_id).toBe('u1');
    expect(linha.build_id).toBe('index-TESTE');
  });

  it('INSERT que falha NÃO emite evento — evento sem linha é ruído inverso', async () => {
    const { mod, insert, track } = await montar({ erroInsert: { message: 'RLS' } });
    await expect(mod.executarProbeTelemetria('u1')).resolves.toBe('falha_tabela');
    expect(insert).toHaveBeenCalledTimes(1);
    expect(track).not.toHaveBeenCalled();
  });

  it('não duplica o probe no mesmo boot', async () => {
    const { mod, insert } = await montar({ erroInsert: null });
    await mod.executarProbeTelemetria('u1');
    await expect(mod.executarProbeTelemetria('u1')).resolves.toBe('ja_emitido');
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

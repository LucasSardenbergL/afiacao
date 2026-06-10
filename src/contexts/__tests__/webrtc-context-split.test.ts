import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';

/**
 * Guardrail do split do contexto WebRTC (Onda 4 da auditoria de velocidade).
 *
 * O WebRTCCallContext.tsx (Provider) importa SipClient → jssip (~250KB) de
 * forma ESTÁTICA. Qualquer import estático dele a partir de um módulo
 * alcançável pelo entry (ex.: IncomingCallModal, montado no AppShellLayout)
 * arrasta o jssip pro main bundle e ANULA o lazy do ConditionalWebRTCProvider
 * — o Rollup não splitta módulo que também é alcançável estaticamente. Foi
 * exatamente assim que o jssip voltou pro entry (medido em 2026-06-10).
 *
 * Regra: consumidores importam o módulo LEVE '@/contexts/webrtc-call-context'
 * (context object + hooks + types). O .tsx pesado só pode ser referenciado:
 *   - pelo ConditionalWebRTCProvider (via DYNAMIC import);
 *   - por testes (__tests__), que não entram no bundle.
 */
describe('guardrail: split do WebRTCCallContext (jssip fora do entry)', () => {
  it("nenhum módulo de produção importa '@/contexts/WebRTCCallContext' estaticamente", () => {
    let out = '';
    try {
      // -l: só nomes de arquivo. Cobre o alias (@/contexts/...) E imports
      // RELATIVOS (./WebRTCCallContext, ../contexts/WebRTCCallContext) — um
      // vizinho em src/contexts/ importando relativo furaria o guard só-alias.
      out = execSync(
        `grep -rlnE "from ['\\"][^'\\"]*WebRTCCallContext['\\"]" src --include='*.ts' --include='*.tsx'`,
        { encoding: 'utf8', cwd: process.cwd() },
      );
    } catch {
      // grep exit 1 = zero matches → perfeito.
      out = '';
    }
    const offenders = out
      .split('\n')
      .filter(Boolean)
      .filter((f) => !f.includes('__tests__'));
    expect(
      offenders,
      `Import ESTÁTICO do Provider pesado detectado (arrasta jssip pro entry). ` +
        `Importe '@/contexts/webrtc-call-context' (módulo leve) em vez disso. Arquivos: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('o ConditionalWebRTCProvider continua carregando o Provider via dynamic import', () => {
    const src = execSync('cat src/contexts/ConditionalWebRTCProvider.tsx', {
      encoding: 'utf8',
      cwd: process.cwd(),
    });
    expect(src).toMatch(/import\(['"]\.\/WebRTCCallContext['"]\)/);
  });
});

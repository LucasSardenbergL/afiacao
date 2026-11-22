import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PWA com `viewport-fit=cover` (#4094): o conteúdo vai até a barra de status e o indicador de
 * início do iPhone. Este teste-texto prende a fiação de área segura das páginas que o #4094
 * deixou de fora (sticky/fixed/alturas). Sem aparelho no CI — o CSS gerado foi conferido à mão.
 */
const ler = (p: string) => readFileSync(resolve(__dirname, '../../../..', p), 'utf8');

describe('token topo-conteudo = topbar + faixa "Ver como"', () => {
  it('tailwind: topo-conteudo soma a área segura e a variável da faixa', () => {
    expect(ler('tailwind.config.ts')).toContain(
      '"topo-conteudo": "calc(48px + env(safe-area-inset-top, 0px) + var(--faixa-ver-como, 0px))"',
    );
  });
  it('shell publica --faixa-ver-como (1.75rem) junto do pt-7 da lente', () => {
    expect(ler('src/components/AppShell.tsx')).toContain("isImpersonating && 'pt-7 [--faixa-ver-como:1.75rem]'");
  });
});

describe('sticky/fixed abaixo da barra do app (não na barra de status)', () => {
  it.each([
    ['src/pages/RecebimentoConferencia.tsx', 'sticky top-topo-conteudo z-30'],
    ['src/pages/TechnicalDocs.tsx', 'sticky top-topo-conteudo z-20'],
    ['src/components/picking/ScanBar.tsx', "'sticky top-topo-conteudo z-20"],
    ['src/components/call/TranscriptionPanel.tsx', 'fixed right-0 top-topo-conteudo bottom-0 pb-[env(safe-area-inset-bottom)]'],
    ['src/pages/FarmerCalls.tsx', 'top-[calc(theme(spacing.topo-conteudo)+2rem)]'],
    ['src/pages/AdminReposicaoAumentoDetail.tsx', 'lg:sticky lg:top-[calc(theme(spacing.topo-conteudo)+1rem)]'],
    ['src/components/reposicao/promocaoDetail/EstadoAcoesSidebar.tsx', 'lg:sticky lg:top-[calc(theme(spacing.topo-conteudo)+1rem)]'],
    ['src/components/docs/primitives.tsx', 'scroll-mt-[calc(theme(spacing.topo-conteudo)+5rem)]'],
  ])('%s', (arquivo, classe) => {
    expect(ler(arquivo)).toContain(classe);
  });
  it('nenhuma página sob o shell gruda em top-0', () => {
    for (const f of ['src/pages/RecebimentoConferencia.tsx', 'src/pages/TechnicalDocs.tsx']) {
      expect(ler(f)).not.toMatch(/sticky top-0\b/);
    }
  });
});

describe('telas cheias e rodapés fixos respeitam o indicador de início', () => {
  it('scanner de lote: overlay fixed inset-0 com as 4 áreas seguras', () => {
    expect(ler('src/components/recebimento/LoteScannerOCR.tsx')).toContain(
      'fixed inset-0 z-50 flex flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
    );
  });
  it.each([
    ['src/components/ui/bulk-actions-bar.tsx'],
    ['src/pages/PedidoProgramadoDetalhe.tsx'],
  ])('%s: barra flutuante a 1rem ACIMA do indicador de início', (arquivo) => {
    const s = ler(arquivo);
    expect(s).toContain('fixed bottom-[calc(1rem+env(safe-area-inset-bottom))]');
    expect(s).not.toMatch(/fixed bottom-4\b/);
  });
  it('shell: sob a lente o <main> desconta a faixa do mínimo (sem rolagem de 1.75rem)', () => {
    expect(ler('src/components/AppShell.tsx')).toContain("'pt-topbar min-h-[calc(100dvh-var(--faixa-ver-como,0px))]");
  });
  it('"Finalizar Conferência" sobe pela área segura do fim', () => {
    expect(ler('src/pages/RecebimentoConferencia.tsx')).toContain('pb-[calc(1rem+env(safe-area-inset-bottom))]');
  });
});

describe('alturas de página: 100dvh − topo-conteudo − padding do shell', () => {
  it('WhatsApp desconta p-4/lg:p-6 (topo + fim) e a área segura do fim', () => {
    const s = ler('src/pages/WhatsappInbox.tsx');
    expect(s).toContain('h-[calc(100dvh-theme(spacing.topo-conteudo)-2rem-env(safe-area-inset-bottom))]');
    expect(s).toContain('lg:h-[calc(100dvh-theme(spacing.topo-conteudo)-3rem-env(safe-area-inset-bottom))]');
  });
  it('Ajuda: -m-4/lg:-m-6 cancela só o 1rem/1.5rem; a área segura do fim fica fora da altura', () => {
    expect(ler('src/pages/AdminAjuda.tsx')).toContain(
      'h-[calc(100dvh-theme(spacing.topo-conteudo)-env(safe-area-inset-bottom))] -m-4 lg:-m-6',
    );
  });
  it('nada de 100vh nem --topbar-height (indefinida) nessas telas', () => {
    for (const f of ['src/pages/WhatsappInbox.tsx', 'src/pages/AdminAjuda.tsx']) {
      const s = ler(f);
      expect(s).not.toContain('100vh');
      expect(s).not.toContain('--topbar-height');
    }
  });
});

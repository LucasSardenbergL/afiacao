import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Guard TEXTUAL: o front não mutila mais CNPJ alfanumérico nos pontos que gravam/casam
// `profiles.document` (follow-up 2 de docs/historico/radar-cnpj-alfanumerico-escritores.md).
// O comportamento está provado nos helpers (`documento-cliente.test.ts`, `authSchemas.test.ts`);
// aqui a prova é que cada ponto CHAMA o helper e que o `.replace(/\D/g, '')` sobre documento não
// voltou — Profile/Auth/SignupForm/hooks são grandes demais para um comportamental barato.
const CWD = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(CWD, rel), 'utf8');

const STRIP_DOC = [
  "document.replace(/\\D/g, '')",
  "cnpj_cpf.replace(/\\D/g, '')",
  "editDocument?.replace(/\\D/g, '')",
  "editDocument.replace(/\\D/g, '')",
];

const PONTOS: Array<{ arquivo: string; helper: string; chamada: string }> = [
  { arquivo: 'src/pages/Profile.tsx', helper: 'documentoEditadoParaGravar', chamada: 'documentoEditadoParaGravar(editDocument' },
  { arquivo: 'src/pages/Auth.tsx', helper: 'normalizarDocumento', chamada: 'document: normalizarDocumento(formData.document)' },
  { arquivo: 'src/components/auth/SignupForm.tsx', helper: 'normalizarDocumento', chamada: 'normalizarDocumento(formData.document)' },
  { arquivo: 'src/components/auth/SignupForm.tsx', helper: 'ehDocumentoPessoaJuridica', chamada: 'ehDocumentoPessoaJuridica(formData.document)' },
  { arquivo: 'src/hooks/unifiedOrder/useCustomerSelection.ts', helper: 'chaveDocumentoParaBusca', chamada: 'chaveDocumentoParaBusca(cust.cnpj_cpf)' },
  { arquivo: 'src/hooks/useUnifiedOrder.ts', helper: 'chaveDocumentoParaBusca', chamada: 'chaveDocumentoParaBusca(selectedCustomer.cnpj_cpf)' },
];

describe('front não mutila CNPJ alfanumérico: escritores e gates de profiles.document usam o helper', () => {
  for (const p of PONTOS) {
    it(`${p.arquivo} chama ${p.helper}`, () => {
      const src = read(p.arquivo);
      expect(src, `import de ${p.helper}`).toMatch(new RegExp(`import \\{[^}]*\\b${p.helper}\\b[^}]*\\} from '@/lib/omie/`));
      expect(src).toContain(p.chamada);
    });
  }

  for (const arquivo of new Set(PONTOS.map((p) => p.arquivo))) {
    it(`${arquivo} não tem mais strip \\D sobre documento`, () => {
      const src = read(arquivo);
      for (const strip of STRIP_DOC) expect(src, strip).not.toContain(strip);
    });
  }

  it('Profile.tsx guarda o documento ORIGINAL para só gravar quando editado', () => {
    const src = read('src/pages/Profile.tsx');
    expect(src).toContain('documentoOriginal');
  });

  it('gate >= 11 por contagem de dígitos não voltou nos hooks de pedido', () => {
    for (const f of ['src/hooks/unifiedOrder/useCustomerSelection.ts', 'src/hooks/useUnifiedOrder.ts']) {
      expect(read(f), f).not.toContain('docClean.length >= 11');
    }
  });
});

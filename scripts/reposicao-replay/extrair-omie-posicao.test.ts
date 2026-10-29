import { describe, expect, it } from 'vitest';
import { criarChamada, DATAS_PADRAO, lerCredenciais, paginarPosicao, paraCsv, redigir, type Transporte } from './extrair-omie-posicao';

// Credenciais FICTÍCIAS de fixture (não são da Omie).
const CRED = { key: '9999000011112222', secret: 'segredo-de-fixture-abc' };
const semEspera = async () => {};

/** Transporte falso: responde por página a partir de uma tabela; registra os corpos. */
function falso(respostas: ((pagina: number) => { ok?: boolean; status?: number; corpo: unknown }) ) {
  const corpos: string[] = [];
  const t: Transporte = async (corpo) => {
    corpos.push(corpo);
    const pagina = (JSON.parse(corpo) as { param: { nPagina: number }[] }).param[0].nPagina;
    const r = respostas(pagina);
    return { ok: r.ok ?? true, status: r.status ?? 200, texto: JSON.stringify(r.corpo) };
  };
  return { t, corpos };
}

describe('extrair-omie-posicao', () => {
  it('lê as credenciais do .env (export e aspas) e reprova sem citar valor', () => {
    expect(lerCredenciais(`# x\nexport OMIE_OBEN_APP_KEY="${CRED.key}"\nOMIE_OBEN_APP_SECRET='${CRED.secret}'\n`)).toEqual(CRED);
    let msg = '';
    try {
      lerCredenciais(`OMIE_OBEN_APP_KEY=${CRED.key}\n`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/credenciais incompletas/);
    expect(msg).not.toContain(CRED.key);
  });

  it('pagina até a página VAZIA, ignorando nTotPaginas (que mente para menos)', async () => {
    const { t } = falso((p) => ({ corpo: p <= 3 ? { nTotPaginas: 1, produtos: [{ nCodProd: p * 10, cCodigo: `C${p}`, nSaldo: p }] } : { nTotPaginas: 1, produtos: [] } }));
    const r = await paginarPosicao(criarChamada(CRED, t, semEspera), '2025-10-20');
    expect(r.paginas).toBe(3);
    expect(r.linhas.map((l) => l.nCodProd)).toEqual([10, 20, 30]);
  });

  it('EOF do Omie por faultstring (inclusive HTTP 500) é fim, não erro', async () => {
    const eof = { faultstring: 'ERROR: Não existem registros para a página [3]!' };
    const a = falso((p) => (p <= 2 ? { corpo: { produtos: [{ nCodProd: p, cCodigo: 'x', nSaldo: 1 }] } } : { ok: false, status: 500, corpo: eof }));
    expect((await paginarPosicao(criarChamada(CRED, a.t, semEspera), '2025-10-20')).paginas).toBe(2);
    const b = falso((p) => (p <= 1 ? { corpo: { produtos: [{ nCodProd: 1, cCodigo: 'x', nSaldo: 1 }] } } : { corpo: eof }));
    expect((await paginarPosicao(criarChamada(CRED, b.t, semEspera), '2025-10-20')).paginas).toBe(1);
  });

  it('retenta o lock de concorrência e o 5xx como a edge, e segue', async () => {
    let n = 0;
    const esperas: number[] = [];
    const { t } = falso((p) => {
      n++;
      if (n === 1) return { corpo: { faultstring: 'Já existe uma requisição desse método sendo executada' } };
      if (n === 2) return { ok: false, status: 503, corpo: 'indisponível' };
      return { corpo: { produtos: p === 1 ? [{ nCodProd: 7, cCodigo: 'X', nSaldo: 2 }] : [] } };
    });
    const r = await paginarPosicao(criarChamada(CRED, t, async (ms) => void esperas.push(ms)), '2025-10-20');
    expect(r.linhas).toEqual([{ nCodProd: 7, cCodigo: 'X', nSaldo: 2 }]);
    expect(esperas).toEqual([1000, 2000]);
  });

  it('erro permanente propaga com a chave e o segredo MASCARADOS', async () => {
    const { t } = falso(() => ({ corpo: { faultstring: `Chave de acesso não cadastrada para o aplicativo [${CRED.key}] ${CRED.secret}` } }));
    let msg = '';
    try {
      await paginarPosicao(criarChamada(CRED, t, semEspera), '2025-10-20');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/^Omie \(oben\)/);
    expect(msg).not.toContain(CRED.key);
    expect(msg).not.toContain(CRED.secret);
    expect(redigir(`a ${CRED.secret} b`, CRED)).toBe('a *** b');
  });

  it('guardas: página repetida, nCodProd repetido entre páginas e teto de páginas lançam (nada parcial)', async () => {
    const rep = falso(() => ({ corpo: { produtos: [{ nCodProd: 1, cCodigo: 'x', nSaldo: 1 }] } }));
    await expect(paginarPosicao(criarChamada(CRED, rep.t, semEspera), '2025-10-20')).rejects.toThrow(/repete a anterior/);
    const dup = falso((p) => ({ corpo: { produtos: p <= 2 ? [{ nCodProd: 5, cCodigo: 'x', nSaldo: 1 }, { nCodProd: 100 + p, cCodigo: 'y', nSaldo: 1 }] : [] } }));
    await expect(paginarPosicao(criarChamada(CRED, dup.t, semEspera), '2025-10-20')).rejects.toThrow(/repetido entre páginas/);
    const inf = falso((p) => ({ corpo: { produtos: [{ nCodProd: p, cCodigo: 'x', nSaldo: 1 }] } }));
    await expect(paginarPosicao(criarChamada(CRED, inf.t, semEspera), '2025-10-20', 3)).rejects.toThrow(/passou de 3 páginas/);
  });

  it('envia ListarPosEstoque com dDataPosicao em DD/MM/AAAA e cExibeTodos', async () => {
    const { t, corpos } = falso(() => ({ corpo: { produtos: [] } }));
    await paginarPosicao(criarChamada(CRED, t, semEspera), '2026-04-30');
    expect(JSON.parse(corpos[0])).toMatchObject({ call: 'ListarPosEstoque', param: [{ nPagina: 1, dDataPosicao: '30/04/2026', cExibeTodos: 'S' }] });
  });

  it('CSV: nSaldo ausente fica vazio (nunca 0), ordenado por nCodProd, com marcador fim|ok', () => {
    expect(paraCsv([{ nCodProd: 20, cCodigo: 'B|1', nSaldo: null }, { nCodProd: 10, cCodigo: 'A', nSaldo: 0 }])).toBe('nCodProd|cCodigo|nSaldo\n10|A|0\n20|"B|1"|\nfim|ok\n');
  });

  it('datas padrão: véspera do aquecimento (abertura) e fim da calibração (conferência)', () => {
    expect(DATAS_PADRAO).toEqual(['2025-10-20', '2026-04-30']);
  });
});

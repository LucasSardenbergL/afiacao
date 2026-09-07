import { describe, it, expect } from 'vitest';
import { sitiosAuthz, temAuthzDominante } from '../authz-dominante';

// Estes fixtures são o ANCORADOURO da noção de dominância. Sem eles, um walker apodrecido que
// respondesse `domina: true` sempre devolveria o gate ao falso-negativo que ele existe para
// corrigir — e o gate de edges passaria verde, porque "todas isentas" é o estado silencioso.

const envolver = (miolo: string) => `
  import { authorizeCronOrStaff } from "../_shared/auth.ts";
  Deno.serve(async (req) => {
${miolo}
    return new Response("ok");
  });
`;

describe('sitiosAuthz — dominância do gate de autorização', () => {
  it('authorize no topo do handler DOMINA', () => {
    const s = sitiosAuthz(envolver(`    const auth = await authorizeCronOrStaff(req);
    if (!auth.ok) return auth.response;`));
    expect(s.map((x) => [x.helper, x.domina])).toEqual([['authorizeCronOrStaff', true]]);
  });

  it('authorize aninhado num if NÃO domina — a forma exata do #2086bis', () => {
    const s = sitiosAuthz(envolver(`    if (decisao.tipo !== "disparo") {
      const auth = await authorizeCronOrStaff(req);
      if (!auth.ok) return auth.response;
      return new Response("sonda");
    }`));
    expect(s.map((x) => x.domina)).toEqual([false]);
    expect(temAuthzDominante(envolver(`    if (x) { await authorizeCronOrStaff(req); }`))).toBe(false);
  });

  it('authorize na CONDIÇÃO do if domina — o if não o torna condicional', () => {
    expect(temAuthzDominante(envolver(`    if (!(await authorizeCronOrStaff(req)).ok) return new Response("no");`)))
      .toBe(true);
  });

  it('authorize dentro de try domina; dentro de catch, não', () => {
    expect(temAuthzDominante(envolver(`    try { await authorizeCronOrStaff(req); } catch { }`))).toBe(true);
    expect(temAuthzDominante(envolver(`    try { f(); } catch { await authorizeCronOrStaff(req); }`))).toBe(false);
  });

  it('authorize no operando direito de && ou ?? NÃO domina', () => {
    expect(temAuthzDominante(envolver(`    const ok = precisa && (await authorizeCronOrStaff(req)).ok;`))).toBe(false);
    expect(temAuthzDominante(envolver(`    const ok = (await authorizeCronOrStaff(req)).ok && precisa;`))).toBe(true);
  });

  it('authorize dentro de função interna NÃO domina — a chamada dela pode ser condicional', () => {
    expect(temAuthzDominante(envolver(`    const guarda = async () => (await authorizeCronOrStaff(req)).ok;
    if (algo) await guarda();`))).toBe(false);
  });

  it('checagem inline de papéis conta como gate; outra tabela, não', () => {
    expect(temAuthzDominante(envolver(`    const { data } = await sb.from("user_roles").select("role").eq("user_id", id);
    if (!data?.length) return new Response("403");`))).toBe(true);
    expect(sitiosAuthz(envolver(`    await sb.from("pedidos").select("id");`))).toEqual([]);
  });

  it('chave dentro de template literal não confunde — é AST, não contagem de chaves', () => {
    // Um contador de `{`/`}` no texto veria o prompt como bloco aberto e declararia o
    // authorize seguinte "aninhado". Edges de IA são feitas de prompt: este é o caso real.
    const s = sitiosAuthz(envolver(`    const prompt = \`Responda em JSON: {"a": 1} e ignore } solta \${x} {\`;
    const auth = await authorizeCronOrStaff(req);`));
    expect(s.map((x) => x.domina)).toEqual([true]);
  });
});

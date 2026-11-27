// Sem rede (`--no-remote` do test:edges): assert inline.
function igual(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}
import { decidirVinculoOS, mensagemVinculoOS } from "./vinculo-os.ts";

const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const OMIE_OK = { erro: false as const, codigo: 77, cnpjCpf: "12.345.678/0001-90" };
const PERFIL_OK = { erro: false as const, document: "12345678000190", cnpj: null };

Deno.test("mapa: código do próprio titular vale", () => {
  igual(decidirVinculoOS({ customerUserId: A, codigo: 77, mapa: { erro: false, userIds: [A] } }), { ok: true, via: "mapa" });
});

Deno.test("mapa: código de OUTRO cliente recusa, mesmo com o documento casando", () => {
  igual(
    decidirVinculoOS({ customerUserId: A, codigo: 77, mapa: { erro: false, userIds: [B] }, omie: OMIE_OK, perfil: PERFIL_OK }),
    { ok: false, motivo: "codigo_de_outro_cliente" },
  );
});

Deno.test("mapa ilegível ou titular vazio → indeterminado (nunca segue)", () => {
  igual(decidirVinculoOS({ customerUserId: A, codigo: 77, mapa: { erro: true }, omie: OMIE_OK, perfil: PERFIL_OK }),
    { ok: false, motivo: "indeterminado" });
  igual(decidirVinculoOS({ customerUserId: "", codigo: 77, mapa: { erro: false, userIds: [] } }),
    { ok: false, motivo: "indeterminado" });
});

Deno.test("sem mapa: documento da Omie casando com o do perfil vale", () => {
  igual(decidirVinculoOS({ customerUserId: A, codigo: 77, mapa: { erro: false, userIds: [] }, omie: OMIE_OK, perfil: PERFIL_OK }),
    { ok: true, via: "documento" });
});

Deno.test("sem mapa: documento divergente, ausente ou malformado recusa", () => {
  const base = { customerUserId: A, codigo: 77, mapa: { erro: false as const, userIds: [] } };
  igual(decidirVinculoOS({ ...base, omie: { ...OMIE_OK, cnpjCpf: "98.765.432/0001-10" }, perfil: PERFIL_OK }),
    { ok: false, motivo: "documento_divergente" });
  igual(decidirVinculoOS({ ...base, omie: { ...OMIE_OK, cnpjCpf: null }, perfil: PERFIL_OK }),
    { ok: false, motivo: "documento_divergente" });
  igual(decidirVinculoOS({ ...base, omie: OMIE_OK, perfil: { erro: false, document: null, cnpj: null } }),
    { ok: false, motivo: "documento_divergente" });
  igual(decidirVinculoOS({ ...base, omie: OMIE_OK, perfil: { erro: false, document: "ABC12345678000190", cnpj: null } }),
    { ok: false, motivo: "documento_divergente" });
});

Deno.test("sem mapa: Omie/perfil ilegível, ausente ou de OUTRO código → indeterminado", () => {
  const base = { customerUserId: A, codigo: 77, mapa: { erro: false as const, userIds: [] } };
  igual(decidirVinculoOS({ ...base, omie: { erro: true }, perfil: PERFIL_OK }), { ok: false, motivo: "indeterminado" });
  igual(decidirVinculoOS({ ...base, omie: OMIE_OK, perfil: { erro: true } }), { ok: false, motivo: "indeterminado" });
  igual(decidirVinculoOS({ ...base, perfil: PERFIL_OK }), { ok: false, motivo: "indeterminado" });
  igual(decidirVinculoOS({ ...base, omie: { ...OMIE_OK, codigo: 78 }, perfil: PERFIL_OK }), { ok: false, motivo: "indeterminado" });
  igual(decidirVinculoOS({ ...base, omie: { ...OMIE_OK, codigo: null }, perfil: PERFIL_OK }), { ok: false, motivo: "indeterminado" });
});

Deno.test("mensagens sem documento", () => {
  for (const m of ["codigo_de_outro_cliente", "documento_divergente", "indeterminado"] as const) {
    const t = mensagemVinculoOS(m);
    if (/[0-9]{3}/.test(t)) throw new Error(`mensagem com número: ${t}`);
  }
});

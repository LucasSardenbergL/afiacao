import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASE_PUBLICA_SAYERSYNC,
  compararSemver,
  lerManifestPublicado,
  montarManifest,
  parseManifest,
  publicarRelease,
  semverValido,
  sha256Hex,
  validarVersao,
  versaoDoNomeDoArquivo,
  type DepsPublicacao,
  type ManifestSayersync,
} from "../release-sayersync";

const SHA = "0a98e3c664283adf965f0c0e453bb807478d1def1928c7dad0e433b96b298476";
const OUTRO_SHA = "f".repeat(64);
const NO_AR: ManifestSayersync = montarManifest("0.2.0", OUTRO_SHA);

describe("semver", () => {
  it("aceita só X.Y.Z estrito, sem 'v' nem zero à esquerda", () => {
    expect(semverValido("0.2.1")).toBe(true);
    expect(semverValido("10.0.12")).toBe(true);
    for (const v of ["v0.2.1", "0.2", "0.2.1-rc1", "01.2.3", "0.2.1 ", "", "0.2.x"]) {
      expect(semverValido(v)).toBe(false);
    }
  });

  it("compara numericamente, não como texto", () => {
    expect(compararSemver("0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compararSemver("0.2.1", "0.2.1")).toBe(0);
    expect(compararSemver("0.2.0", "0.2.1")).toBeLessThan(0);
    expect(() => compararSemver("v1.0.0", "1.0.0")).toThrow("versão inválida: 'v1.0.0'");
  });

  it("validarVersao rejeita igual e downgrade, aceita a 1ª e a maior", () => {
    expect(validarVersao("0.2.1", null)).toBeNull();
    expect(validarVersao("0.2.1", NO_AR)).toBeNull();
    expect(validarVersao("0.2.0", NO_AR)).toContain("A versão no ar é 0.2.0");
    expect(validarVersao("0.1.9", NO_AR)).toContain("A versão no ar é 0.2.0");
    expect(validarVersao("0.2", NO_AR)).toContain("formato X.Y.Z");
  });

  it("sugere a versão a partir do nome do release.sh", () => {
    expect(versaoDoNomeDoArquivo("sayersync-0.2.1.exe")).toBe("0.2.1");
    expect(versaoDoNomeDoArquivo("sayersync.exe")).toBeNull();
    expect(versaoDoNomeDoArquivo("sayersync-01.2.1.exe")).toBeNull();
  });
});

describe("manifest", () => {
  it("monta {version, sha256, url} com a URL que o conector baixa", () => {
    expect(montarManifest("0.2.1", SHA)).toEqual({
      version: "0.2.1",
      sha256: SHA,
      url: "https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync/sayersync-0.2.1.exe",
    });
    expect(() => montarManifest("0.2.1", SHA.toUpperCase())).toThrow("sha256 inválido");
  });

  it("a base pública casa com o BUCKET_BASE_URL default do release.sh", () => {
    const script = readFileSync(resolve(__dirname, "../../../../connector/sayersync/release.sh"), "utf8");
    const m = /BUCKET_BASE_URL="\$\{BUCKET_BASE_URL:-([^}]+)\}"/.exec(script);
    expect(m?.[1]).toBe(BASE_PUBLICA_SAYERSYNC);
  });

  it("parseManifest recusa manifest torto em vez de tratá-lo como ausente", () => {
    expect(parseManifest(NO_AR)).toEqual(NO_AR);
    expect(() => parseManifest({ version: "0.2", sha256: SHA, url: "x" })).toThrow("malformado");
    expect(() => parseManifest(null)).toThrow("malformado");
  });

  it("sha256Hex bate com o vetor conhecido de 'abc'", async () => {
    const abc = new TextEncoder().encode("abc").buffer as ArrayBuffer;
    expect(await sha256Hex(abc)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("lerManifestPublicado", () => {
  const resposta = (status: number, corpo: unknown) =>
    (async () => new Response(JSON.stringify(corpo), { status })) as unknown as typeof fetch;

  it("objeto ausente (HTTP 400 + statusCode 404 do Storage) → null", async () => {
    expect(await lerManifestPublicado(resposta(400, { statusCode: "404", error: "not_found" }))).toBeNull();
  });

  it("bucket ausente ou erro de servidor LANÇA (não vira 'nenhum publicado')", async () => {
    await expect(lerManifestPublicado(resposta(400, { statusCode: "400", error: "Bucket not found" }))).rejects.toThrow(
      "HTTP 400",
    );
    await expect(lerManifestPublicado(resposta(500, {}))).rejects.toThrow("HTTP 500");
  });

  it("200 → manifest validado", async () => {
    expect(await lerManifestPublicado(resposta(200, NO_AR))).toEqual(NO_AR);
  });
});

describe("publicarRelease — ordem .exe → manifest", () => {
  function fakes(opts: { exe?: "ok" | "existe" | "falha"; shaNoAr?: string; manifestOk?: boolean } = {}) {
    const passos: string[] = [];
    let noAr: ManifestSayersync | null = NO_AR;
    const deps: DepsPublicacao = {
      lerManifest: async () => {
        passos.push("ler");
        return noAr;
      },
      enviarExe: async (caminho) => {
        passos.push(`exe:${caminho}`);
        if (opts.exe === "existe") return { ok: false, jaExiste: true, mensagem: "already exists" };
        if (opts.exe === "falha") return { ok: false, jaExiste: false, mensagem: "rede" };
        return { ok: true };
      },
      shaDoExePublicado: async () => {
        passos.push("sha-no-ar");
        return opts.shaNoAr ?? SHA;
      },
      gravarManifest: async (m) => {
        passos.push("manifest");
        if (opts.manifestOk === false) return { ok: false, jaExiste: false, mensagem: "403" };
        noAr = m;
        return { ok: true };
      },
    };
    return { deps, passos };
  }
  const args = { versao: "0.2.1", arquivo: new Blob(["x"]), sha256: SHA };

  it("caminho feliz: lê, sobe o .exe, SÓ DEPOIS grava o manifest, e relê", async () => {
    const { deps, passos } = fakes();
    const r = await publicarRelease(deps, args);
    expect(passos).toEqual(["ler", "exe:sayersync/sayersync-0.2.1.exe", "manifest", "ler"]);
    expect(r).toEqual({ manifest: montarManifest("0.2.1", SHA), exeRetomado: false });
  });

  it("upload do .exe falhou → manifest NUNCA é gravado", async () => {
    const { deps, passos } = fakes({ exe: "falha" });
    await expect(publicarRelease(deps, args)).rejects.toThrow("upload do .exe falhou: rede");
    expect(passos).not.toContain("manifest");
  });

  it("downgrade/igual barra antes de subir qualquer coisa", async () => {
    const { deps, passos } = fakes();
    await expect(publicarRelease(deps, { ...args, versao: "0.2.0" })).rejects.toThrow("A versão no ar é 0.2.0");
    expect(passos).toEqual(["ler"]);
  });

  it(".exe já no ar com o MESMO sha → retoma e grava só o manifest", async () => {
    const { deps, passos } = fakes({ exe: "existe" });
    const r = await publicarRelease(deps, args);
    expect(r.exeRetomado).toBe(true);
    expect(passos).toEqual(["ler", "exe:sayersync/sayersync-0.2.1.exe", "sha-no-ar", "manifest", "ler"]);
  });

  it(".exe já no ar com OUTRO sha → recusa e não grava manifest", async () => {
    const { deps, passos } = fakes({ exe: "existe", shaNoAr: OUTRO_SHA });
    await expect(publicarRelease(deps, args)).rejects.toThrow("já foi publicado com OUTRO binário");
    expect(passos).not.toContain("manifest");
  });

  it("manifest não gravou → erro explícito (o .exe ficou, sem ponteiro)", async () => {
    const { deps } = fakes({ manifestOk: false });
    await expect(publicarRelease(deps, args)).rejects.toThrow("gravar o manifest falhou: 403");
  });

  it("releitura que não confere → erro, nunca sucesso", async () => {
    const { deps } = fakes();
    const ler = deps.lerManifest;
    let n = 0;
    deps.lerManifest = async () => (++n === 1 ? ler() : NO_AR);
    await expect(publicarRelease(deps, args)).rejects.toThrow("a releitura não confere");
  });
});

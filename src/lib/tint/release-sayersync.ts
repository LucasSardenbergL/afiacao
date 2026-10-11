/**
 * Publicação de release do conector SayerSync (connector/sayersync) pelo app.
 *
 * O conector (update.go) lê 1×/dia o `manifest.json` público do bucket `releases` e, se a versão for
 * maior que a dele, baixa o `.exe` da `url`, confere o `sha256` e se troca. Por isso a ORDEM importa:
 * o `.exe` sobe primeiro e o manifest só depois que o upload do `.exe` confirmou — um manifest
 * apontando para binário ainda ausente faz o conector falhar o download (connector/README.md).
 *
 * Lógica pura + orquestração com dependências injetadas: a tela só liga isto ao Supabase Storage.
 */

/** Base pública do bucket — TEM de casar com o `BUCKET_BASE_URL` default de connector/sayersync/release.sh. */
export const BASE_PUBLICA_SAYERSYNC =
  "https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync";
export const BUCKET_RELEASES = "releases";
export const CAMINHO_MANIFEST = "sayersync/manifest.json";
export const URL_MANIFEST = `${BASE_PUBLICA_SAYERSYNC}/manifest.json`;

export interface ManifestSayersync {
  version: string;
  sha256: string;
  url: string;
}

/** Semver estrito X.Y.Z sem "v" e sem zero à esquerda — o mesmo formato que o update.go aceita. */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export function semverValido(v: string): boolean {
  return SEMVER_RE.test(v);
}

/** Negativo se a<b, 0 se iguais, positivo se a>b. Lança se algum não for semver estrito. */
export function compararSemver(a: string, b: string): number {
  const pa = SEMVER_RE.exec(a);
  const pb = SEMVER_RE.exec(b);
  if (!pa || !pb) throw new Error(`versão inválida: '${pa ? b : a}'`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d !== 0) return d;
  }
  return 0;
}

export function nomeExe(versao: string): string {
  return `sayersync-${versao}.exe`;
}

function caminhoExe(versao: string): string {
  return `sayersync/${nomeExe(versao)}`;
}

/** Sugere a versão a partir do nome do arquivo gerado pelo release.sh (`sayersync-0.2.1.exe`). */
export function versaoDoNomeDoArquivo(nome: string): string | null {
  const m = /sayersync-(\d+\.\d+\.\d+)\.exe$/i.exec(nome);
  return m && semverValido(m[1]) ? m[1] : null;
}

/**
 * O `.exe` como `application/octet-stream`, com os MESMOS bytes. O navegador marca o arquivo como
 * `application/x-msdownload`, e o supabase-js, quando recebe um Blob/File, sobe em multipart com o
 * tipo do PRÓPRIO arquivo — a opção `contentType` do upload é ignorada nesse caminho. O bucket só
 * aceita octet-stream/json, então o upload falhava com "mime type application/x-msdownload is not
 * supported" (1ª publicação real, 2026-10-11).
 */
export function comoOctetStream(arquivo: Blob): Blob {
  return arquivo.slice(0, arquivo.size, "application/octet-stream");
}

export function montarManifest(versao: string, sha256: string): ManifestSayersync {
  if (!semverValido(versao)) throw new Error(`versão inválida: '${versao}'`);
  if (!SHA256_RE.test(sha256)) throw new Error("sha256 inválido (esperado hex minúsculo de 64 chars)");
  return { version: versao, sha256, url: `${BASE_PUBLICA_SAYERSYNC}/${nomeExe(versao)}` };
}

/**
 * Valida a versão a publicar contra o manifest no ar. `manifestAtual === null` = nenhum publicado
 * ainda (1ª versão). Devolve a mensagem de erro, ou null se pode publicar.
 */
export function validarVersao(versao: string, manifestAtual: ManifestSayersync | null): string | null {
  if (!semverValido(versao)) return "Versão deve ser no formato X.Y.Z (ex.: 0.2.1), sem \"v\".";
  if (manifestAtual && compararSemver(versao, manifestAtual.version) <= 0) {
    return `A versão no ar é ${manifestAtual.version}. Publique uma versão maior (o conector não faz downgrade).`;
  }
  return null;
}

/** Valida o que veio do bucket — manifest torto é tratado como erro, nunca como "nenhum". */
export function parseManifest(json: unknown): ManifestSayersync {
  const m = json as Partial<ManifestSayersync> | null;
  if (
    !m ||
    typeof m.version !== "string" ||
    !semverValido(m.version) ||
    typeof m.sha256 !== "string" ||
    !SHA256_RE.test(m.sha256) ||
    typeof m.url !== "string"
  ) {
    throw new Error("manifest.json no ar está malformado");
  }
  return { version: m.version, sha256: m.sha256, url: m.url };
}

export async function sha256Hex(dados: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", dados);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lê o manifest público. O Storage responde objeto ausente com HTTP 400 + `{"statusCode":"404"}`
 * (medido 2026-10-11) — só ESSE caso vira `null`. Qualquer outra falha LANÇA: sem ler o manifest
 * não dá para checar downgrade, então a tela não deixa publicar.
 */
export async function lerManifestPublicado(fetcher: typeof fetch = fetch): Promise<ManifestSayersync | null> {
  const resp = await fetcher(`${URL_MANIFEST}?t=${Date.now()}`, { cache: "no-store" });
  if (resp.ok) return parseManifest(await resp.json());
  const corpo = (await resp.json().catch(() => null)) as { statusCode?: string; error?: string } | null;
  if (corpo && (corpo.statusCode === "404" || corpo.error === "not_found")) return null;
  throw new Error(`não consegui ler o manifest no ar (HTTP ${resp.status})`);
}

export type ResultadoUpload = { ok: true } | { ok: false; jaExiste: boolean; mensagem: string };

export interface DepsPublicacao {
  enviarExe: (caminho: string, arquivo: Blob) => Promise<ResultadoUpload>;
  /** sha256 do `.exe` que JÁ está no bucket (retomada após falha entre os dois uploads). */
  shaDoExePublicado: (versao: string) => Promise<string>;
  gravarManifest: (manifest: ManifestSayersync) => Promise<ResultadoUpload>;
  lerManifest: () => Promise<ManifestSayersync | null>;
}

export interface ResultadoPublicacao {
  manifest: ManifestSayersync;
  /** true quando o `.exe` já estava no bucket com o MESMO sha (retomada) e só o manifest foi gravado. */
  exeRetomado: boolean;
}

/**
 * Publica: valida → sobe o `.exe` (imutável) → SÓ ENTÃO grava o manifest → relê o manifest e exige
 * que seja o que foi gravado. Se o `.exe` já existe, só segue se o binário no ar tiver o MESMO sha
 * (retomada de uma publicação que caiu entre os dois passos); binário diferente nunca é sobrescrito.
 */
export async function publicarRelease(
  deps: DepsPublicacao,
  args: { versao: string; arquivo: Blob; sha256: string },
): Promise<ResultadoPublicacao> {
  const atual = await deps.lerManifest();
  const erroVersao = validarVersao(args.versao, atual);
  if (erroVersao) throw new Error(erroVersao);
  const manifest = montarManifest(args.versao, args.sha256);

  let exeRetomado = false;
  const up = await deps.enviarExe(caminhoExe(args.versao), args.arquivo);
  if (!up.ok) {
    if (!up.jaExiste) throw new Error(`upload do .exe falhou: ${up.mensagem}`);
    const shaNoAr = await deps.shaDoExePublicado(args.versao);
    if (shaNoAr !== args.sha256) {
      throw new Error(
        `${nomeExe(args.versao)} já foi publicado com OUTRO binário. Binário publicado não é trocado — gere uma versão nova.`,
      );
    }
    exeRetomado = true;
  }

  const gm = await deps.gravarManifest(manifest);
  if (!gm.ok) throw new Error(`o .exe subiu, mas gravar o manifest falhou: ${gm.mensagem}. Tente de novo.`);

  const relido = await deps.lerManifest();
  if (!relido || relido.version !== manifest.version || relido.sha256 !== manifest.sha256 || relido.url !== manifest.url) {
    throw new Error("o manifest foi gravado, mas a releitura não confere — confira antes de avisar a loja.");
  }
  return { manifest, exeRetomado };
}

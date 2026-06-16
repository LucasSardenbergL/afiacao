export interface CityKey {
  city: string; // canônico: sem acento, UPPER, trim
  uf: string;   // 'MG' | 'TO' | '' (vazio = não informado no cadastro)
}

const UF_RE = /^[A-Z]{2}$/;

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function normalizeCityKey(raw: string | null | undefined): CityKey | null {
  if (!raw) return null;
  let s = stripAccents(String(raw)).toUpperCase().trim();
  if (!s) return null;

  let uf = '';
  // forma "(MG)" no fim
  const paren = s.match(/\(([A-Z]{2})\)\s*$/);
  if (paren && paren.index != null) {
    uf = paren[1];
    s = s.slice(0, paren.index).trim();
  } else {
    // forma "/MG" no fim
    const slash = s.match(/\/\s*([A-Z]{2})\s*$/);
    if (slash && slash.index != null) {
      uf = slash[1];
      s = s.slice(0, slash.index).trim();
    } else {
      // forma "... MG" (UF como última palavra)
      const parts = s.split(/\s+/);
      if (parts.length > 1 && UF_RE.test(parts[parts.length - 1])) {
        uf = parts.pop() as string;
        s = parts.join(' ');
      }
    }
  }

  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return { city: s, uf };
}

export function cityKeyEquals(a: CityKey, b: CityKey): boolean {
  if (a.city !== b.city) return false;
  if (a.uf && b.uf) return a.uf === b.uf; // ambos têm UF → tem que bater (desambigua Divinópolis)
  return true; // um lado sem UF → casa por cidade
}

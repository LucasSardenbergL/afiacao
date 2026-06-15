import { describe, it, expect } from 'vitest';
import { parseCidadesCache, serializeCidadesCache } from './cidades-cache';
import type { CityOption } from '@/components/reposicao/routePlanner/types';

const cidade: CityOption = { codigo: '3106200', nome: 'BELO HORIZONTE', uf: 'MG', total: 120, comTelefone: 80, aContatar: 60 };
const TTL = 48 * 60 * 60 * 1000; // 48h

describe('parseCidadesCache', () => {
  it('raw null → null', () => {
    expect(parseCidadesCache(null, 1000, TTL)).toBeNull();
  });
  it('raw corrompido (não-JSON) → null', () => {
    expect(parseCidadesCache('{nao json', 1000, TTL)).toBeNull();
  });
  it('sem data/ts válidos → null', () => {
    expect(parseCidadesCache(JSON.stringify({ foo: 1 }), 1000, TTL)).toBeNull();
    expect(parseCidadesCache(JSON.stringify({ data: 'x', ts: 1 }), 1000, TTL)).toBeNull();
    expect(parseCidadesCache(JSON.stringify({ data: [cidade] }), 1000, TTL)).toBeNull();
  });
  it('válido e dentro do TTL → {data, ts}', () => {
    const raw = serializeCidadesCache([cidade], 1000);
    const out = parseCidadesCache(raw, 1000 + TTL - 1, TTL);
    expect(out).toEqual({ data: [cidade], ts: 1000 });
  });
  it('válido mas expirado (agora - ts > ttl) → null', () => {
    const raw = serializeCidadesCache([cidade], 1000);
    expect(parseCidadesCache(raw, 1000 + TTL + 1, TTL)).toBeNull();
  });
  it('lista vazia é cache válido (0 cidades) → {data:[], ts}', () => {
    const raw = serializeCidadesCache([], 5000);
    expect(parseCidadesCache(raw, 5000, TTL)).toEqual({ data: [], ts: 5000 });
  });
});

describe('serializeCidadesCache roundtrip', () => {
  it('serialize → parse preserva os dados', () => {
    const raw = serializeCidadesCache([cidade], 42);
    expect(parseCidadesCache(raw, 42, TTL)).toEqual({ data: [cidade], ts: 42 });
  });
});

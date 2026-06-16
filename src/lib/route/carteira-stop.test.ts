import { describe, it, expect } from 'vitest';
import { carteiraRowToStop, type CarteiraRow } from './carteira-stop';

const row = (over: Partial<CarteiraRow> = {}): CarteiraRow => ({
  user_id: 'u1',
  name: 'Marcenaria Silva',
  phone: '37 99999-0000',
  street: 'Rua A', number: '10', neighborhood: 'Centro',
  city: 'DIVINOPOLIS (MG)', state: 'MG', zip_code: '35500-000', complement: 'Sala 2',
  business_hours_open: '08:00', business_hours_close: '18:00',
  ultima_visita: '2026-06-01T12:00:00Z', dias_desde_visita: 14,
  lat: -20.1389, lng: -44.8839, precision: 'postcode_centroid',
  ...over,
});

describe('carteiraRowToStop', () => {
  it('mapeia os campos e preserva a recência', () => {
    const d = carteiraRowToStop(row(), 'Divinópolis');
    expect(d.id).toBe('carteira-cidade-u1');
    expect(d.customerUserId).toBe('u1');
    expect(d.customerName).toBe('Marcenaria Silva');
    expect(d.phone).toBe('37 99999-0000');
    expect(d.address.complement).toBe('Sala 2');
    expect(d.visitReason).toBe('Cliente em Divinópolis');
    expect(d.businessHoursOpen).toBe('08:00');
    expect(d.diasDesdeVisita).toBe(14);
  });
  it('nunca visitado → diasDesdeVisita null', () => {
    expect(carteiraRowToStop(row({ dias_desde_visita: null, ultima_visita: null }), 'X').diasDesdeVisita).toBeNull();
  });
  it('campos nulos degradam (name→Cliente, phone→null, complement→undefined)', () => {
    const d = carteiraRowToStop(row({ name: null, phone: null, complement: null }), 'X');
    expect(d.customerName).toBe('Cliente');
    expect(d.phone).toBeNull();
    expect(d.address.complement).toBeUndefined();
  });
  it('adota lat/lng/precisao resolvidos pela RPC (não geocodifica em memória)', () => {
    const d = carteiraRowToStop(row({ lat: -20.13, lng: -44.88, precision: 'postcode_centroid' }), 'X');
    expect(d.lat).toBe(-20.13);
    expect(d.lng).toBe(-44.88);
    expect(d.precisao).toBe('postcode_centroid');
  });
  it('fallback município → precisao city_centroid (pino aproximado)', () => {
    expect(carteiraRowToStop(row({ lat: -20, lng: -44.5, precision: 'city_centroid' }), 'X').precisao).toBe('city_centroid');
  });
  it('sem coord (lat/lng null) → lat/lng/precisao undefined (defensivo)', () => {
    const d = carteiraRowToStop(row({ lat: null, lng: null, precision: null }), 'X');
    expect(d.lat).toBeUndefined();
    expect(d.lng).toBeUndefined();
    expect(d.precisao).toBeUndefined();
  });
});

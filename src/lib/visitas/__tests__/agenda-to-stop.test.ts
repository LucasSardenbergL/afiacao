import { describe, it, expect } from 'vitest';
import { agendaToRouteStop } from '../agenda-to-stop';
import type { AgendaStopProfile, AgendaStopAddress } from '../agenda-to-stop';
import type { VisitaAgendadaRow } from '@/integrations/supabase/visitasAgendadas';

const baseRow: VisitaAgendadaRow = {
  id: 'abc-123',
  customer_user_id: 'user-456',
  scheduled_by: 'staff-789',
  scheduled_date: '2026-05-30',
  status: 'pendente',
  visit_type: 'comercial',
  notes: null,
  route_visit_id: null,
  created_at: '2026-05-29T10:00:00Z',
  updated_at: '2026-05-29T10:00:00Z',
};

const fullProfile: AgendaStopProfile = {
  name: 'Marcenaria Silva',
  phone: '(11) 99999-1234',
  business_hours_open: '08:00',
  business_hours_close: '18:00',
};

const fullAddress: AgendaStopAddress = {
  street: 'Rua das Flores',
  number: '42',
  neighborhood: 'Centro',
  city: 'São Paulo',
  state: 'SP',
  zip_code: '01310-100',
  complement: 'Sala 3',
};

describe('agendaToRouteStop', () => {
  it('com perfil e endereço completos retorna campos corretos', () => {
    const result = agendaToRouteStop(baseRow, fullProfile, fullAddress);

    expect(result.id).toBe('scheduled-visit-abc-123');
    expect(result.stopType).toBe('scheduled_visit');
    expect(result.customerUserId).toBe('user-456');
    expect(result.customerName).toBe('Marcenaria Silva');
    expect(result.phone).toBe('(11) 99999-1234');
    expect(result.businessHoursOpen).toBe('08:00');
    expect(result.businessHoursClose).toBe('18:00');
    expect(result.timeSlot).toBeNull();
    expect(result.status).toBe('scheduled');
    expect(result.visitReason).toBe('Visita agendada');

    expect(result.address.street).toBe('Rua das Flores');
    expect(result.address.number).toBe('42');
    expect(result.address.neighborhood).toBe('Centro');
    expect(result.address.city).toBe('São Paulo');
    expect(result.address.state).toBe('SP');
    expect(result.address.zip_code).toBe('01310-100');
    expect(result.address.complement).toBe('Sala 3');
  });

  it('sem endereço retorna strings vazias nos campos de endereço', () => {
    const result = agendaToRouteStop(baseRow, fullProfile, undefined);

    expect(result.address.street).toBe('');
    expect(result.address.number).toBe('');
    expect(result.address.neighborhood).toBe('');
    expect(result.address.city).toBe('');
    expect(result.address.state).toBe('');
    expect(result.address.zip_code).toBe('');
    expect(result.address.complement).toBeUndefined();
  });

  it('com notes preenche visitReason com prefixo "Agendada ·"', () => {
    const rowWithNotes: VisitaAgendadaRow = { ...baseRow, notes: 'Apresentar novo catálogo' };
    const result = agendaToRouteStop(rowWithNotes, fullProfile, fullAddress);

    expect(result.visitReason).toBe('Agendada · Apresentar novo catálogo');
  });

  it('sem notes usa visitReason padrão', () => {
    const result = agendaToRouteStop(baseRow, fullProfile, fullAddress);
    expect(result.visitReason).toBe('Visita agendada');
  });

  it('sem perfil usa fallback "Cliente" e phone null', () => {
    const result = agendaToRouteStop(baseRow, undefined, fullAddress);

    expect(result.customerName).toBe('Cliente');
    expect(result.phone).toBeNull();
    expect(result.businessHoursOpen).toBeNull();
    expect(result.businessHoursClose).toBeNull();
  });

  it('perfil com name null usa fallback "Cliente"', () => {
    const profileNullName: AgendaStopProfile = { ...fullProfile, name: null };
    const result = agendaToRouteStop(baseRow, profileNullName, fullAddress);

    expect(result.customerName).toBe('Cliente');
  });

  it('endereço sem complement não inclui a chave complement no objeto', () => {
    const addrNoComplement: AgendaStopAddress = { ...fullAddress, complement: null };
    const result = agendaToRouteStop(baseRow, fullProfile, addrNoComplement);

    expect('complement' in result.address).toBe(false);
  });
});

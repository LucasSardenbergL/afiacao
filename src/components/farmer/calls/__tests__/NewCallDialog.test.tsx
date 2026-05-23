import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NewCallDialog } from '../NewCallDialog';
import type { Customer } from '../types';

const customer: Customer = { user_id: 'u1', name: 'Cliente Alpha', email: null, phone: '11999990000' };

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof NewCallDialog>> = {}): React.ComponentProps<typeof NewCallDialog> {
  return {
    open: true,
    onOpenChange: noop,
    selectedCustomer: null,
    setSelectedCustomer: noop,
    customerSearch: '',
    setCustomerSearch: noop,
    customers: [],
    setCustomers: noop,
    searchLoading: false,
    callType: 'follow_up',
    setCallType: noop,
    callResult: 'contato_sucesso',
    setCallResult: noop,
    attemptNumber: 1,
    setAttemptNumber: noop,
    notes: '',
    setNotes: noop,
    revenue: '',
    setRevenue: noop,
    margin: '',
    setMargin: noop,
    callSeconds: 0,
    followUpSeconds: 0,
    isCallActive: false,
    isFollowUpActive: false,
    nvoipIsConnecting: false,
    nvoipIsRinging: false,
    nvoipIsEstablished: false,
    nvoipIsActive: false,
    nvoipError: null,
    callBackend: 'nvoip',
    saving: false,
    onStartCall: noop,
    onStopCall: noop,
    onStartFollowUp: noop,
    onStopFollowUp: noop,
    onSave: noop,
    ...over,
  };
}

describe('NewCallDialog', () => {
  it('fechado (open=false) → não renderiza o conteúdo', () => {
    render(<NewCallDialog {...baseProps({ open: false })} />);
    expect(screen.queryByText('Registrar ligação')).toBeNull();
  });

  it('aberto sem cliente → título, busca e Salvar desabilitado', () => {
    render(<NewCallDialog {...baseProps()} />);
    expect(screen.getByText('Registrar ligação')).toBeTruthy();
    expect(screen.getByPlaceholderText('Buscar cliente...')).toBeTruthy();
    const salvar = screen.getByRole('button', { name: /Salvar/ }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(true);
  });

  it('com cliente → mostra nome e habilita Salvar; clique chama onSave', () => {
    const onSave = vi.fn();
    render(<NewCallDialog {...baseProps({ selectedCustomer: customer, onSave })} />);
    expect(screen.getByText('Cliente Alpha')).toBeTruthy();
    const salvar = screen.getByRole('button', { name: /Salvar/ }) as HTMLButtonElement;
    expect(salvar.disabled).toBe(false);
    fireEvent.click(salvar);
    expect(onSave).toHaveBeenCalled();
  });

  it('cliente com telefone → botão Iniciar chama onStartCall', () => {
    const onStartCall = vi.fn();
    render(<NewCallDialog {...baseProps({ selectedCustomer: customer, onStartCall })} />);
    // "Iniciar" aparece em Ligação e Follow-up; o primeiro é o da chamada.
    fireEvent.click(screen.getAllByRole('button', { name: /Iniciar/ })[0]);
    expect(onStartCall).toHaveBeenCalled();
  });
});

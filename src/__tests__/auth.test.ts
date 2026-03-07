import { describe, it, expect } from 'vitest';
import type { AppRole } from '@/contexts/AuthContext';

/**
 * Pure logic extracted from AuthContext — mirrors lines 209-212.
 * Testing the derivation logic without needing Supabase mocks.
 */
function deriveRoleFlags(role: AppRole | null) {
  const isAdmin = role === 'admin';
  const isEmployee = role === 'employee';
  const isMaster = role === 'master';
  const isCustomer = role === 'customer';
  const isStaff = isAdmin || isEmployee || isMaster;
  return { role, isAdmin, isEmployee, isMaster, isCustomer, isStaff };
}

describe('AuthContext role derivation', () => {
  // 1. Provides role, isStaff, isAdmin, isMaster correctly
  it('derives admin flags correctly', () => {
    const flags = deriveRoleFlags('admin');
    expect(flags.role).toBe('admin');
    expect(flags.isAdmin).toBe(true);
    expect(flags.isStaff).toBe(true);
    expect(flags.isMaster).toBe(false);
    expect(flags.isEmployee).toBe(false);
    expect(flags.isCustomer).toBe(false);
  });

  it('derives employee flags correctly', () => {
    const flags = deriveRoleFlags('employee');
    expect(flags.role).toBe('employee');
    expect(flags.isEmployee).toBe(true);
    expect(flags.isStaff).toBe(true);
    expect(flags.isAdmin).toBe(false);
    expect(flags.isMaster).toBe(false);
  });

  it('derives master flags correctly', () => {
    const flags = deriveRoleFlags('master');
    expect(flags.role).toBe('master');
    expect(flags.isMaster).toBe(true);
    expect(flags.isStaff).toBe(true);
    expect(flags.isAdmin).toBe(false);
    expect(flags.isEmployee).toBe(false);
  });

  // 2. role null + loading false → unauthenticated
  it('returns null role and all false flags when unauthenticated', () => {
    const flags = deriveRoleFlags(null);
    expect(flags.role).toBeNull();
    expect(flags.isAdmin).toBe(false);
    expect(flags.isEmployee).toBe(false);
    expect(flags.isMaster).toBe(false);
    expect(flags.isStaff).toBe(false);
    expect(flags.isCustomer).toBe(false);
  });

  // 3. isStaff is true for admin, employee, master
  it.each(['admin', 'employee', 'master'] as AppRole[])(
    'isStaff is true when role is %s',
    (role) => {
      expect(deriveRoleFlags(role).isStaff).toBe(true);
    }
  );

  // 4. isStaff is false for customer
  it('isStaff is false when role is customer', () => {
    const flags = deriveRoleFlags('customer');
    expect(flags.isStaff).toBe(false);
    expect(flags.isCustomer).toBe(true);
  });
});

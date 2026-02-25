import { Outlet } from 'react-router-dom';
import { AppShell } from './AppShell';

export function AppShellLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

import type { ReactNode } from 'react';
export interface NavItem { id: string; label: string; icon: string; href?: string; badge?: string | number }
export interface NavGroup { label?: string; items: NavItem[] }
export interface AppShellProps {
  /** Grouped sidebar nav. Keep to three groups: workspace, agents, account. */
  nav: NavGroup[];
  active?: string;
  workspace?: Workspace;
  workspaces?: Workspace[];
  user?: { name: string; email: string };
  /** Left side of the top bar — breadcrumb or search, never a duplicate page title. */
  topbar?: ReactNode;
  topbarActions?: ReactNode;
  /** Removes page padding — for full-bleed file browsers. */
  flush?: boolean;
  onNavigate?: (id: string) => void;
  onWorkspaceChange?: (workspace: Workspace) => void;
  children?: ReactNode;
  className?: string;
}
export interface Workspace {
  name: string;
  meta?: string;
  type?: 'TEAM'|'PRO'|'FREE';
  role?: 'OWNER'|'READER';
}
export declare function AppShell(props: AppShellProps): JSX.Element;

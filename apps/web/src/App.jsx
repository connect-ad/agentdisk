import React from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate, useParams, useLocation } from 'react-router-dom';
import { AppShell, Breadcrumb, Badge, Button, Icon } from './components/index.js';

import Dashboard from './routes/Dashboard.jsx';
import FileBrowser from './routes/FileBrowser.jsx';
import Agents from './routes/Agents.jsx';
import AgentDetails from './routes/AgentDetails.jsx';
import ApiKeys from './routes/ApiKeys.jsx';
import Usage from './routes/Usage.jsx';
import Settings from './routes/Settings.jsx';
import Profile from './routes/Profile.jsx';
import { NotFound, Forbidden, ServerError, Maintenance } from './routes/ErrorPages.jsx';
import { Signup, VerifyEmail, ForgotPassword, ResetPassword, Login } from './routes/Auth.jsx';
import { Landing, Pricing } from './routes/Marketing.jsx';
import McpConnection from './routes/McpConnection.jsx';
import Webhooks from './routes/Webhooks.jsx';
import ActivityLog from './routes/ActivityLog.jsx';

/**
 * Sidebar navigation — doc 03 §7.3. Three groups: workspace, agent access, account.
 * `id` is what AppShell reports back through onNavigate; `path` is appended to
 * the workspace root (empty string = the workspace root itself).
 */
export const NAV = [
  {
    items: [
      { id: 'dash', label: 'Dashboard', icon: 'dashboard', path: '' },
      { id: 'files', label: 'Files', icon: 'folder', path: '/files' },
      { id: 'activity', label: 'Activity', icon: 'activity', path: '/activity' }
    ]
  },
  {
    label: 'Agent access',
    items: [
      { id: 'agents', label: 'Agents', icon: 'agent', path: '/agents' },
      { id: 'keys', label: 'API keys', icon: 'key', path: '/keys' },
      { id: 'mcp', label: 'MCP connection', icon: 'terminal', path: '/mcp' },
      { id: 'webhooks', label: 'Webhooks', icon: 'link', path: '/webhooks' }
    ]
  },
  {
    label: 'Account',
    items: [
      { id: 'usage', label: 'Usage', icon: 'chart', path: '/usage' },
      { id: 'settings', label: 'Settings', icon: 'gear', path: '/settings' },
      { id: 'docs', label: 'Documentation', icon: 'book', href: 'https://docs.agentdrive.dev', external: true }
    ]
  }
];

const WORKSPACES = [
  { name: 'Kessler Labs', meta: 'ws_8f3ac21d9e4b', type: 'TEAM', role: 'OWNER' },
  { name: 'Nightshift Research', meta: 'ws_2b71ce40aef18', type: 'PRO', role: 'READER' },
  { name: 'Personal sandbox', meta: 'ws_5d09fa3b7c62', type: 'FREE', role: 'OWNER' }
];
const WORKSPACE = WORKSPACES[0];
const USER = { name: 'Dana Okafor', email: 'dana@acme.io' };

/** Which nav id is active for the current pathname. */
function activeId(pathname, wsRoot) {
  const rest = pathname.slice(wsRoot.length) || '';
  const match = NAV.flatMap(g => g.items)
    .filter(it => it.path && rest.startsWith(it.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return match ? match.id : 'dash';
}

/**
 * The authenticated workspace shell. Every in-app screen renders inside this.
 */
function WorkspaceLayout() {
  const navigate = useNavigate();
  const { ws } = useParams();
  const { pathname } = useLocation();
  const wsRoot = `/w/${ws}`;
  const active = activeId(pathname, wsRoot);
  const current = NAV.flatMap(g => g.items).find(it => it.id === active);

  return (
    <AppShell
      nav={NAV}
      active={active}
      workspace={WORKSPACE}
      workspaces={WORKSPACES}
      user={USER}
      onNavigate={id => {
        const item = NAV.flatMap(g => g.items).find(i => i.id === id);
        if (!item) return;
        if (item.external) { window.location.assign(item.href); return; }
        navigate(wsRoot + item.path);
      }}
      topbar={
        <Breadcrumb
          items={[
            { label: WORKSPACE.name, href: wsRoot },
            { label: current ? current.label : 'Dashboard' }
          ]}
        />
      }
      topbarActions={
        <>
          <Badge tone="ok" dot pulse>All systems normal</Badge>
          <Button size="sm" variant="secondary" icon={<Icon name="book" size={13} />}>
            Docs
          </Button>
        </>
      }
    >
      <Outlet />
    </AppShell>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/app" element={<Navigate to="/w/acme-research" replace />} />
      <Route path="/w/:ws" element={<WorkspaceLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="files" element={<FileBrowser />} />
        <Route path="files/*" element={<FileBrowser />} />
        <Route path="agents" element={<Agents />} />
        <Route path="agents/:agentId" element={<AgentDetails />} />
        <Route path="keys" element={<ApiKeys />} />
        <Route path="mcp" element={<McpConnection />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="activity" element={<ActivityLog />} />
        <Route path="usage" element={<Usage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="profile" element={<Profile />} />
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/account/profile" element={<Profile />} />
      <Route path="/403" element={<Forbidden />} />
      <Route path="/500" element={<ServerError onRetry={() => window.location.reload()} />} />
      <Route path="/maintenance" element={<Maintenance />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

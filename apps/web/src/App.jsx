import React from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate, useParams, useLocation, Link } from 'react-router-dom';
import { AppShell, Badge, Button, Icon } from './components/index.js';

import Dashboard from './routes/Dashboard.jsx';
import FileBrowser from './routes/FileBrowser.jsx';
import Agents from './routes/Agents.jsx';
import AgentDetails from './routes/AgentDetails.jsx';
import ApiKeys from './routes/ApiKeys.jsx';
import Usage from './routes/Usage.jsx';
import Settings from './routes/Settings.jsx';
import Profile from './routes/Profile.jsx';
import Support from './routes/Support.jsx';
import {
  NotFound, Forbidden, ServerError, Maintenance,
  Gone, BadRequest, RateLimited, NotModified, MovedPermanently, Unauthorized,
} from './routes/ErrorPages.jsx';
import { Sandbox } from './routes/Sandbox.jsx';
import { Signup, VerifyEmail, ForgotPassword, ResetPassword, Login } from './routes/Auth.jsx';
import { Landing, Pricing } from './routes/Marketing.jsx';
import { Terms, Privacy } from './routes/Legal.jsx';
import Docs from './routes/Docs.jsx';
import McpConnection from './routes/McpConnection.jsx';
import Billing from './routes/Billing.jsx';
import Webhooks from './routes/Webhooks.jsx';
import ActivityLog from './routes/ActivityLog.jsx';
import RequireAuth, { RequireWorkspace } from './lib/RequireAuth.jsx';
import WorkspaceSwitcher from './components-local/WorkspaceSwitcher.jsx';
import AccountMenu from './components-local/AccountMenu.jsx';
import ThemeToggle from './components-local/ThemeToggle.jsx';
import WorkspaceIdChip from './components-local/WorkspaceIdChip.jsx';
import AccountAreaBand from './components-local/AccountAreaBand.jsx';
import WorkspaceStats from './components-local/WorkspaceStats.jsx';
import { useAuth } from './lib/auth.jsx';
import { useWorkspace } from './lib/workspace.jsx';
import { WorkspaceUsageProvider, useWorkspacePlan } from './lib/usage.jsx';

/**
 * Sidebar navigation — doc 03 §7.3. Three groups: workspace, agent access, account.
 * `id` is what AppShell reports back through onNavigate; `path` is appended to
 * the workspace root (empty string = the workspace root itself).
 */
export const NAV = [
  {
    items: [
      { id: 'dash', label: 'Overview', icon: 'dashboard', path: '' },
      { id: 'files', label: 'Files', icon: 'folder', path: '/files' },
      { id: 'activity', label: 'Activity', icon: 'activity', path: '/activity' }
    ]
  },
  {
    label: 'Agent access',
    items: [
      // "Agent identities", not "Agents", because the section header above it
      // already says AGENT ACCESS and "Agents" beside "API keys" reads as a
      // list of running things rather than the identities keys are minted
      // against. The label is the only thing that changes: the `/agents` path,
      // the `agt_` prefix and the section header are all untouched.
      { id: 'agents', label: 'Agent identities', icon: 'agent', path: '/agents' },
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
    ]
  }
];

/**
 * `/app` is the one URL the rest of the product links to without knowing which
 * workspace anybody is in. It resolves to the current one - remembered across
 * reloads - so a bookmark, a redirect after sign-in and an email link all land
 * somewhere real instead of a hardcoded slug that belongs to nobody.
 */
function CurrentWorkspaceRedirect() {
  const { workspaceId, workspaceSlug, loading } = useWorkspace();
  if (loading) return null;
  return workspaceId ? <Navigate to={`/w/${workspaceSlug}`} replace /> : <Navigate to="/login" replace />;
}

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
/**
 * Layer 1 of the design: the workspace info strip — OWNER, WORKSPACE ID, PLAN.
 *
 * Split out of `WorkspaceLayout` so it renders *inside* `WorkspaceUsageProvider`
 * and can read the plan from the `whoami` the stats band already fetches. The
 * workspace record from `GET /v1/workspaces` carries id, name, slug and role
 * and no plan, which is why this segment never appeared: the markup was always
 * here, behind a check on a field the endpoint does not return.
 */
function InfoStrip({ open, user, wsRoot }) {
  const plan = useWorkspacePlan();

  return (
    <div className="shell__stripinner">
      {/* The design leads with the owner. `role` is this person's role in
          this workspace, which is what the API actually returns — the
          design's "OWNER · Rina Kessler" names the workspace's owner, and
          no endpoint reports who that is. So this says what is true: your
          role, and you. */}
      <span className="shell__stripitem">
        <span className="shell__striplabel">{(open.role ?? 'member').toUpperCase()}</span>
        <span className="avatar" aria-hidden="true">
          {(user.name || user.email || 'U').slice(0, 1).toUpperCase()}
        </span>
        <span className="shell__stripname ad-truncate">{user.name}</span>
      </span>
      <span className="shell__stripsep" aria-hidden="true" />
      <span className="shell__stripitem">
        <span className="shell__striplabel">WORKSPACE ID</span>
        {/* The ws_... ID, never the slug — this is the value people paste
            into an API call. */}
        <WorkspaceIdChip workspaceId={open.id} />
      </span>
      {/* Held back until whoami answers rather than rendered against a
          placeholder: a plan name is the kind of thing somebody acts on, and a
          wrong one for half a second is worse than a late one. */}
      {plan ? (
        <>
          <span className="shell__stripsep" aria-hidden="true" />
          <span className="shell__stripitem">
            <span className="shell__striplabel">PLAN</span>
            <span className="shell__stripplan">{plan}</span>
            <Link to={`${wsRoot}/settings`} className="shell__striplink">Change</Link>
          </span>
        </>
      ) : null}
    </div>
  );
}

function WorkspaceLayout() {
  const navigate = useNavigate();
  const { ws } = useParams();
  const { pathname, search, hash } = useLocation();
  const { user, signOut } = useAuth();
  const { workspaces, workspaceId, select, create, resolveWorkspace } = useWorkspace();

  const handleSignOut = async () => {
    await signOut();
    navigate('/', { replace: true });
  };
  const wsRoot = `/w/${ws}`;
  const active = activeId(pathname, wsRoot);
  const current = NAV.flatMap(g => g.items).find(it => it.id === active);

  // Either spelling of the address resolves to the same workspace: the slug the
  // dashboard links to now, or the raw ws_... ID every link made before it did.
  const open = resolveWorkspace(ws);

  // The URL is the source of truth for which workspace is open, so a shared
  // link opens the workspace it names rather than whichever one this browser
  // last had selected.
  React.useEffect(() => {
    if (open && open.id !== workspaceId) select(open.id);
  }, [open, workspaceId, select]);

  /**
   * The URL names a workspace this person cannot reach. Say so.
   *
   * Without this the layout rendered anyway: the breadcrumb fell back to the
   * literal word "Workspace" and every screen inside took its workspace from
   * the *context* rather than the URL — which is whichever one this browser
   * last had selected. So `/w/ws_00000000000000000000000000` quietly showed you
   * your own default workspace's files under a bogus address, and a link
   * naming somebody else's workspace looked like it had opened it. Both are the
   * same fault: the address bar and the data on screen disagreeing silently.
   *
   * One check covers "no such workspace" and "not a member of it" because
   * `workspaces` is the membership-scoped list the API returned for this
   * person, so a workspace they cannot reach is simply absent from it. Giving
   * the two the same answer is also the right one: a distinguishable "that
   * exists but is not yours" is an oracle for other people's workspace IDs, and
   * it is exactly how `DELETE /v1/workspaces/:id` already answers.
   *
   * Rendered outside the shell rather than inside it — a sidebar whose every
   * link points into a workspace that does not exist is not a 404, it is a
   * second thing to get wrong.
   */
  // echoPath={false}: this answers "no such workspace" and "not a member"
  // identically, and the guarantee is strongest when the two responses contain
  // nothing at all derived from the requested URL. See NotFound.
  if (!open) return <NotFound echoPath={false} />;

  // Past the guard `open` is always a workspace this person is a member of, so
  // nothing below needs a fallback for its absence.
  const workspaceName = open.name;

  /**
   * A raw-ID URL keeps working and then quietly becomes the readable one.
   *
   * Every link the dashboard has ever produced named a workspace by its ID, so
   * those bookmarks have to resolve — but leaving them on the ID would mean two
   * live spellings of every screen and a "copy this URL" that hands somebody
   * the old one. The rest of the path, the query and the fragment are carried
   * across untouched, so a deep link into a folder or a filtered activity view
   * survives the swap.
   *
   * `open.slug !== ws` is what stops this looping: a workspace whose slug is
   * its own ID — the 0009 backfill's fallback for a name that slugifies to
   * nothing — is already canonical and redirects nowhere.
   */
  if (open.slug && open.slug !== ws) {
    return (
      <Navigate to={`${pathname.replace(wsRoot, `/w/${open.slug}`)}${search}${hash}`} replace />
    );
  }

  /**
   * Every tab gets a real href.
   *
   * AppShell has always supported `it.href` and fell back to "#" when none was
   * given — and none ever was, so all nine sidebar entries rendered as
   * <a href="#">. Middle-click and ctrl-click opened nothing, "Copy link
   * address" produced "#", and a screen reader announced nine links to one
   * destination. onNavigate still handles the plain click, so routing stays
   * client-side and the navigation behaviour is unchanged.
   */
  const navWithHrefs = NAV.map(group => ({
    ...group,
    items: group.items.map(it => ({
      ...it,
      href: it.external ? it.href : wsRoot + it.path,
    })),
  }));

  const USER = {
    name: user?.displayName ?? user?.email ?? 'Signed in',
    email: user?.email ?? ''
  };

  /*
   * The profile menu's destinations, in the reference's order. Contact Support
   * is an ordinary route here and so carries no external-link glyph: the
   * reference draws one because its support lives elsewhere, and an icon
   * promising a new tab in front of an in-app navigation is a small lie about
   * what the click does.
   *
   * Account keeps its /profile URL. The label is what the reference calls it
   * and what people look for; the path is what every existing link and the
   * standalone /account/profile route already use.
   */
  const ACCOUNT_AREA = [
    { label: 'Account', to: `${wsRoot}/profile`, where: 'Account' },
    { label: 'Billing', to: `${wsRoot}/billing`, where: 'Billing' },
    { label: 'Contact Support', to: `${wsRoot}/support`, where: 'Contact Support' },
  ];
  const inAccountArea = ACCOUNT_AREA.find(item => pathname.startsWith(item.to));

  return (
    <WorkspaceUsageProvider>
    <AppShell
      nav={navWithHrefs}
      active={active}
      workspaceSlot={
        <WorkspaceSwitcher
          compact
          workspaces={workspaces}
          /* The resolved workspace's real ID, not the URL segment — the segment
             is a slug now, and the switcher marks the current row by ID. */
          currentId={open.id}
          onSelect={id => {
            const target = workspaces.find(w => w.id === id);
            navigate(`/w/${target?.slug ?? id}`);
          }}
          onCreate={async name => {
            const workspace = await create(name);
            navigate(`/w/${workspace.slug ?? workspace.id}`);
          }}
        />
      }
      userSlot={
        <AccountMenu
          name={USER.name}
          email={USER.email}
          items={ACCOUNT_AREA}
          onNavigate={to => navigate(to)}
          onSignOut={handleSignOut}
          align="down"
        />
      }
      onNavigate={id => {
        const item = NAV.flatMap(g => g.items).find(i => i.id === id);
        if (!item) return;
        if (item.external) { window.location.assign(item.href); return; }
        navigate(wsRoot + item.path);
      }}
      /* In the account area the workspace strip would go on announcing a
         workspace ID and plan beside a page about the person, so the band
         replaces it rather than sitting under it. */
      infoStrip={
        inAccountArea
          ? <AccountAreaBand label={inAccountArea.where} onBack={() => navigate(wsRoot)} />
          : <InfoStrip open={open} user={USER} wsRoot={wsRoot} />
      }
      statsBand={<WorkspaceStats />}
      topbarActions={
        <>
          <ThemeToggle />
          {/* Hidden on mobile, where the reference drops it too
              (`showDocsLink: !mob`) — /docs is still reachable from the footer
              and by URL, and on a 390px bar this is what leaves the workspace
              switcher enough room to read. */}
          <Button size="sm" variant="ghost" as={Link} to="/docs" className="shell__docs">Docs</Button>
        </>
      }
    >
      <Outlet />
    </AppShell>
    </WorkspaceUsageProvider>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/docs" element={<Docs />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      <Route element={<RequireAuth />}>
        <Route path="/app" element={<CurrentWorkspaceRedirect />} />
        {/* `/dashboard` is the shareable spelling of the same idea: a bookmark,
            a support article or a link to a colleague cannot name a workspace,
            because `/w/{id}` is an address that belongs to one reader. Both
            paths resolve through the same component so neither can drift into
            being the unprotected one. */}
        <Route path="/dashboard" element={<CurrentWorkspaceRedirect />} />
      </Route>
      <Route element={<RequireAuth />}>
      <Route element={<RequireWorkspace />}>
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
        <Route path="billing" element={<Billing />} />
        <Route path="profile" element={<Profile />} />
        <Route path="support" element={<Support />} />
      </Route>
      </Route>
      </Route>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      {/* Talks to the real API, unlike every other screen here: it is the one
          way to obtain a first credential (05 PART 13's Turnstile-gated
          POST /v1/workspaces). */}
      <Route path="/sandbox" element={<Sandbox />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/account/profile" element={<Profile />} />
      {/*
        The design draws ten codes. Four already had routes; these six are new.
        They exist so a link, a redirect or a support article can name the page
        that explains a condition — the app itself reaches most of them only by
        being sent there.
      */}
      <Route path="/301" element={<MovedPermanently />} />
      <Route path="/304" element={<NotModified />} />
      <Route path="/400" element={<BadRequest />} />
      <Route path="/401" element={<Unauthorized />} />
      <Route path="/403" element={<Forbidden />} />
      <Route path="/410" element={<Gone />} />
      <Route path="/429" element={<RateLimited />} />
      <Route path="/500" element={<ServerError onRetry={() => window.location.reload()} />} />
      <Route path="/maintenance" element={<Maintenance />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

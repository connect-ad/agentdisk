import fs from 'node:fs';
const p = 'src/routes/McpConnection.jsx';
let s = fs.readFileSync(p, 'utf8');

const from = `      <Panel title="Connect your agent" subtitle="Paste this into your MCP client's config.">
        <Tabs value={client} onChange={setClient} items={CLIENTS.map(c => ({ value: c.value, label: c.label }))} />`;

const to = `      {/*
        The design lays this screen out as three numbered steps rather than one
        panel. Step 1 sends you to the keys screen, step 2 is the config block,
        step 3 reports the real handshake state — which is the badge this screen
        already computes from actual call history, not a fixture.
      */}
      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">1</span>
          <span className="panel__title">Create a scoped key</span>
        </div>
        <p className="ad-small ad-measure" style={{ marginBottom: 'var(--s-5)' }}>
          Give the agent the narrowest scopes it needs. A research agent usually wants
          read, write and list under one prefix.
        </p>
        <Button size="sm" variant="secondary" as={Link} to={\`/w/\${ws}/keys\`}>Go to API keys</Button>
      </div>

      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">2</span>
          <span className="panel__title">Add the server to your client</span>
        </div>
        <Tabs value={client} onChange={setClient} items={CLIENTS.map(c => ({ value: c.value, label: c.label }))} />`;

if (!s.includes(from)) throw new Error('MCP panel not found');
s = s.replace(from, to);

// Close step 2 where the old panel closed, and add step 3.
const from2 = `          <Link to={\`/w/\${ws}/keys\`}>mint a new one</Link>.
        </p>
      </Panel>`;
const to2 = `          <Link to={\`/w/\${ws}/keys\`}>mint a new one</Link>.
        </p>
      </div>

      <div className="ds__step">
        <div className="ds__stephead">
          <span className="ds__stepnum">3</span>
          <span className="panel__title">Verify the handshake</span>
        </div>
        {/*
          The design shows a green "connected 14 minutes ago · 5 tools
          registered" line unconditionally. This reports what actually
          happened: `connection` is derived from real call history above, and
          says "Never connected" or "No usable key" when that is the truth.
        */}
        {connection ? (
          <Alert
            tone={connection.tone}
            title={
              connection.label === 'Active now'
                ? 'This workspace has answered an MCP call recently'
                : connection.label === 'Never connected'
                  ? 'No MCP call has reached this workspace yet'
                  : connection.label
            }
          >
            {connection.label === 'No usable key'
              ? 'An agent needs a live API key before it can complete the handshake.'
              : 'Tool availability follows the connecting key\'s own scopes.'}
          </Alert>
        ) : null}
      </div>`;

if (!s.includes(from2)) throw new Error('MCP panel close not found');
s = s.replace(from2, to2);

fs.writeFileSync(p, s);
console.log('MCP rebuilt as three numbered steps');

/**
 * The four "File storage for <agent>" pages, as data (4 Oct 2026).
 *
 * The configs are the docs' own (routes/Docs.jsx, CLIENTS) where the docs
 * have one — Claude Code, Claude Desktop, Cursor, Codex CLI — and follow each
 * client's published configuration format where they do not (Cline, the
 * OpenAI Responses API and Agents SDK). The endpoint is this build's API, as
 * in the docs, so dev shows dev's and prod shows prod's.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api-dev.agentdisk.io';
const MCP = `${API_BASE}/mcp`;
const KEY = 'ask_live_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

export const AGENT_PAGES = [
  {
    path: '/storage-for-claude',
    name: 'Claude',
    title: 'File Storage for Claude (Claude Code & Desktop) — AgentDisk',
    description: 'Give Claude Code and Claude Desktop persistent, scoped file storage over MCP. One command to connect, a free tier, and hard-capped pricing.',
    lead: 'A Claude session ends; its files should not. AgentDisk gives Claude a persistent, scoped workspace over MCP: notes, task lists and results written in one session and read back in the next.',
    configs: [
      {
        caption: 'CLAUDE CODE · TERMINAL',
        intro: 'One command registers the server. Name the transport: a bare url entry in .mcp.json is read as a stdio server and fails to start.',
        code: `export AGENTDISK_KEY=${KEY}
claude mcp add --transport http agentdisk ${MCP} \\
  --header "Authorization: Bearer $AGENTDISK_KEY"`,
      },
      {
        caption: 'CLAUDE DESKTOP · CLAUDE_DESKTOP_CONFIG.JSON',
        intro: 'Claude Desktop\'s config file starts local servers only, so the mcp-remote bridge turns the HTTP server into one. Settings → Developer → Edit Config opens the file.',
        code: `{
  "mcpServers": {
    "agentdisk": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${MCP}",
        "--header", "Authorization:\${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer ${KEY}"
      }
    }
  }
}`,
      },
    ],
    uses: [
      ['Memory between sessions', 'Claude writes `/memory/tasks.md` at the end of a session and reads it back with `read_file` at the start of the next, so a long job survives a closed terminal.'],
      ['A research workspace', 'Sources, notes and drafts under `/research/<topic>`, with captions and tags Claude can search by, instead of files scattered across a laptop.'],
      ['Reports a person picks up', 'Claude saves the finished report; you download it from the dashboard or hand it on with a share link that expires within seven days.'],
      ['One key per project', 'A key scoped to `/projects/acme` cannot see `/projects/globex`, so a prompt in one project cannot reach another\'s files.'],
    ],
    faq: [
      { q: 'How do I add AgentDisk to Claude Code?', a: 'Run claude mcp add with the HTTP transport, the AgentDisk MCP URL and your key in an Authorization header. Claude Code then lists AgentDisk\'s eleven file tools. Add -s user to register it for every project.' },
      { q: 'Does it work with Claude Desktop?', a: 'Yes, through the mcp-remote bridge, because Claude Desktop\'s config file starts local servers only. The config block on this page passes the key through an environment variable.' },
      { q: 'Can Claude delete my files?', a: 'Only if its key has the delete operation. Create the key with read, write and list and Claude can save and read files but every delete is refused, and the refusal is logged.' },
      { q: 'Where are Claude\'s files stored?', a: 'In your AgentDisk workspace, in Cloudflare R2, encrypted at rest by the provider. You can browse, download and delete them from the dashboard at any time.' },
      { q: 'Is there a free plan?', a: 'Yes: 1 GB of storage and one agent identity, no card. A sandbox gives Claude a workspace for three days with no account at all.' },
    ],
    posts: ['mcp-file-storage-quickstart', 'why-ai-agents-need-file-storage', 'scoped-credentials-ai-agents'],
  },
  {
    path: '/storage-for-openai',
    name: 'OpenAI',
    title: 'File Storage for OpenAI Agents & Codex — AgentDisk',
    description: 'Persistent, scoped file storage for OpenAI agents: connect the Responses API, the Agents SDK or Codex CLI to AgentDisk over MCP in minutes.',
    lead: 'OpenAI\'s models can call remote MCP servers, and AgentDisk is one: a scoped, persistent workspace your agents read and write over the same API key, from the Responses API, the Agents SDK or Codex CLI.',
    configs: [
      {
        caption: 'RESPONSES API · PYTHON',
        intro: 'A remote MCP tool. OpenAI calls the server from its own infrastructure, so the key travels in the tool\'s headers; scope it to what this agent needs.',
        code: `import os
from openai import OpenAI

client = OpenAI()
response = client.responses.create(
    model="gpt-5",
    tools=[{
        "type": "mcp",
        "server_label": "agentdisk",
        "server_url": "${MCP}",
        "headers": {"Authorization": f"Bearer {os.environ['AGENTDISK_KEY']}"},
        "require_approval": "never",
    }],
    input="Read /notes/today.md and add a summary at /notes/summary.md.",
)
print(response.output_text)`,
      },
      {
        caption: 'AGENTS SDK · PYTHON',
        intro: 'The SDK connects to a streamable-HTTP MCP server and hands its tools to the agent.',
        code: `import asyncio, os
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp

async def main():
    async with MCPServerStreamableHttp(params={
        "url": "${MCP}",
        "headers": {"Authorization": f"Bearer {os.environ['AGENTDISK_KEY']}"},
    }) as agentdisk:
        agent = Agent(name="Researcher",
                      instructions="Keep notes in /notes.",
                      mcp_servers=[agentdisk])
        result = await Runner.run(agent, "List my notes and summarise them.")
        print(result.final_output)

asyncio.run(main())`,
      },
      {
        caption: 'CODEX CLI · ~/.CODEX/CONFIG.TOML',
        intro: 'Codex reads TOML. HTTP servers take a url plus a table of headers.',
        code: `[mcp_servers.agentdisk]
url = "${MCP}"
http_headers = { Authorization = "Bearer ${KEY}" }`,
      },
    ],
    uses: [
      ['Agent state between runs', 'A scheduled agent writes its progress to `/runs/<name>/state.json` and reads it back on the next run, instead of starting from nothing.'],
      ['Shared files across agents', 'A planner writes to `/handoff`, and a worker whose key can only read `/handoff` and write `/results` picks it up.'],
      ['Code and artefacts from Codex', 'Codex saves generated files, logs and patches to a workspace you can browse, download and share.'],
      ['Server-side tool calls you can audit', 'Every call OpenAI makes on the agent\'s behalf lands in the Activity log with the path and the outcome, refused calls included.'],
    ],
    faq: [
      { q: 'Can the OpenAI Responses API use AgentDisk?', a: 'Yes. Add AgentDisk as a remote MCP tool with its server URL and an Authorization header carrying an AgentDisk key. OpenAI calls the server directly, so the endpoint is public and the key decides what the model may do.' },
      { q: 'Does it work with the OpenAI Agents SDK?', a: 'Yes. Connect with the SDK\'s streamable-HTTP MCP server class, passing the URL and the Authorization header, and give the server to your agent.' },
      { q: 'How do I connect Codex CLI?', a: 'Add an mcp_servers.agentdisk table to ~/.codex/config.toml with the URL and an http_headers entry carrying the bearer key.' },
      { q: 'Is it safe to give a hosted model an API key?', a: 'Give it a narrow one. AgentDisk keys carry specific operations and a path prefix, so a key for one agent cannot reach another\'s files, cannot mint broader keys and cannot delete unless you allow it. You can disable it instantly.' },
      { q: 'What does it cost?', a: 'Free for 1 GB and one agent identity, then $9, $20 or $80 a month. Requests are unlimited and every plan is hard-capped, so a looping agent cannot run up a bill.' },
    ],
    posts: ['rest-vs-mcp-ai-agent-storage', 'scoped-credentials-ai-agents', 'hard-capped-pricing-ai-storage'],
  },
  {
    path: '/storage-for-cursor',
    name: 'Cursor',
    title: 'File Storage for Cursor — AgentDisk',
    description: 'Give Cursor\'s agent persistent, scoped file storage over MCP: one mcp.json block, per-project keys, an audit log and a free tier.',
    lead: 'Cursor\'s agent works inside one repository at a time. AgentDisk gives it a place outside the repository for what should outlive the session or be shared across projects: notes, specs, generated assets and reports.',
    configs: [
      {
        caption: '.CURSOR/MCP.JSON',
        intro: 'Cursor accepts the URL shape as it is. Put it in .cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project, then enable the server under Settings → MCP. Keep a key out of a file the repository commits.',
        code: `{
  "mcpServers": {
    "agentdisk": {
      "url": "${MCP}",
      "headers": {
        "Authorization": "Bearer ${KEY}"
      }
    }
  }
}`,
      },
    ],
    uses: [
      ['Notes that outlive the chat', 'The agent keeps decisions and to-dos in `/notes/<project>.md` and reads them back when you open the project next week.'],
      ['Generated assets out of the repo', 'Fixtures, exports and screenshots go to AgentDisk rather than into commits, with a SHA-256 on every file.'],
      ['Specs shared across repositories', 'A read-only key on `/specs` lets the agent in every project read the same documents without being able to change them.'],
      ['A record of what the agent touched', 'The Activity log shows every tool call with its path and outcome, including the ones its key refused.'],
    ],
    faq: [
      { q: 'How do I add AgentDisk to Cursor?', a: 'Add an agentdisk entry with the MCP URL and an Authorization header to .cursor/mcp.json or ~/.cursor/mcp.json, then enable it under Settings → MCP.' },
      { q: 'Should I put the key in the project\'s mcp.json?', a: 'Only if that file is not committed. Otherwise use ~/.cursor/mcp.json, which stays on your machine, or a key scoped narrowly enough that a leak costs little, and disable it at once if it is exposed.' },
      { q: 'Can Cursor\'s agent read my other projects\' files?', a: 'Not if its key is scoped to a prefix. A key for /projects/acme cannot list, read or guess anything under /projects/globex.' },
      { q: 'What can the agent do with AgentDisk?', a: 'List, search, read, create, update, move, copy and delete files and create folders, as far as its key allows. It cannot create keys or delete workspaces over MCP.' },
      { q: 'Is there a free plan?', a: 'Yes: 1 GB of storage and one agent identity, no card. Paid plans start at $9 a month and are hard-capped.' },
    ],
    posts: ['mcp-file-storage-quickstart', 'workspace-isolation-multi-agent', 'why-ai-agents-need-file-storage'],
  },
  {
    path: '/storage-for-cline',
    name: 'Cline',
    title: 'File Storage for Cline — AgentDisk',
    description: 'Connect Cline to AgentDisk over MCP for persistent, scoped file storage outside your workspace: one settings block, per-agent keys, a free tier.',
    lead: 'Cline acts in your editor with your permission. AgentDisk gives it a separate, scoped disk for what should persist beyond the task: memory files, research, generated artefacts, with every call logged.',
    configs: [
      {
        caption: 'CLINE_MCP_SETTINGS.JSON · STREAMABLE HTTP',
        intro: 'Open Cline\'s MCP Servers panel and edit its settings file. Name the transport as streamable HTTP and pass the key as a header.',
        code: `{
  "mcpServers": {
    "agentdisk": {
      "type": "streamableHttp",
      "url": "${MCP}",
      "headers": {
        "Authorization": "Bearer ${KEY}"
      },
      "disabled": false
    }
  }
}`,
      },
      {
        caption: 'CLINE_MCP_SETTINGS.JSON · BRIDGE',
        intro: 'If your Cline version does not offer streamable HTTP, run the server through the mcp-remote bridge instead, as Claude Desktop does.',
        code: `{
  "mcpServers": {
    "agentdisk": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "${MCP}",
        "--header", "Authorization:\${AUTH_HEADER}"
      ],
      "env": {
        "AUTH_HEADER": "Bearer ${KEY}"
      }
    }
  }
}`,
      },
    ],
    uses: [
      ['A memory bank that persists', 'Cline keeps its context files in `/memory` on AgentDisk, so they survive a new machine, a reinstall or a second editor.'],
      ['Research kept apart from code', 'Downloads, notes and drafts go to a workspace, not into the repository Cline is editing.'],
      ['Approvals with a narrow key', 'Give Cline read, write and list on one prefix: even an approved tool call cannot delete or wander outside it.'],
      ['Hand results to a person', 'Finished files can be downloaded from the dashboard or shared with a link that expires within seven days.'],
    ],
    faq: [
      { q: 'How do I connect Cline to AgentDisk?', a: 'Add an agentdisk entry to Cline\'s MCP settings with the streamable HTTP transport, the AgentDisk MCP URL and an Authorization header carrying your key. If your version lacks streamable HTTP, use the mcp-remote bridge configuration instead.' },
      { q: 'Will Cline ask before calling AgentDisk tools?', a: 'That is Cline\'s approval setting, not AgentDisk\'s. Whatever you approve, the key still limits what the call can do, and every call is logged.' },
      { q: 'Can Cline delete files?', a: 'Only with a key that holds the delete operation. Leave it out and deletes are refused and recorded as denied in the Activity log.' },
      { q: 'Where do the files live?', a: 'In your AgentDisk workspace, in Cloudflare R2, not on your machine. You can browse and download them from the dashboard.' },
      { q: 'What does it cost?', a: 'Free for 1 GB and one agent identity, then $9, $20 or $80 a month, hard-capped with unlimited requests.' },
    ],
    posts: ['why-ai-agents-need-file-storage', 'scoped-credentials-ai-agents', 'mcp-file-storage-quickstart'],
  },
];

export function agentPage(path) {
  return AGENT_PAGES.find(p => p.path === path) ?? null;
}

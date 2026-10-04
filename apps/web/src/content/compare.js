/**
 * The comparison and alternative pages, as data (4 Oct 2026).
 *
 * Strings are inline markdown (components-local/Markdown.jsx `Md`): links,
 * `code` and **bold** only. Every AgentDisk claim is one the docs make. Every
 * competitor claim was checked against that vendor's own site on 4 Oct 2026
 * (pricing, docs, trust pages); a row we could not verify is left out rather
 * than guessed. Revisit these pages when a competitor ships or reprices;
 * nothing here updates itself.
 *
 * A table cell is `[mark, note]`: mark is 'yes' | 'no' | 'part', or null for
 * a note alone.
 */

const AD = {
  mcp: ['yes', 'Built in, eleven file tools, same auth as REST'],
  rest: ['yes', 'JSON API with presigned uploads for large files'],
  scoped: ['yes', 'Operations plus a whole-segment path prefix, per agent'],
  pricing: [null, 'Flat plans, hard-capped: $0, $9, $20, $80 a month'],
  free: ['yes', '1 GB, one agent identity, no card'],
  serverless: ['yes', 'Fully managed; nothing to run'],
  ddos: ['yes', 'Cloudflare network DDoS mitigation'],
  isolation: ['yes', 'Workspace bound from the credential before any handler'],
  audit: ['yes', 'Every MCP call, denied calls included'],
  sandbox: ['yes', 'Workspace and key with one POST, no account'],
  semantic: ['no', 'Search matches name, path, caption and tags'],
  s3api: ['no', 'REST and MCP, not the S3 API'],
};

export const COMPARISONS = [
  /* ─────────────────────────────── Fast.io ─────────────────────────────── */
  {
    slug: 'agentdisk-vs-fast-io',
    name: 'Fast.io',
    h1: 'AgentDisk vs Fast.io: which agent workspace fits your stack? (2026)',
    title: 'AgentDisk vs Fast.io (2026) — AgentDisk',
    description: 'AgentDisk vs Fast.io for AI agent file storage: MCP tools, pricing and overage, RAG search, serverless setup and when each one is the better choice.',
    verdict: 'Fast.io is the broader platform: semantic search over files, cloud sync, a desktop app, ownership transfer and an MCP server across its whole platform. AgentDisk is the narrower one: scoped file storage with a free plan, hard-capped pricing, a no-account sandbox and nothing to run. If your agents need to search file contents by meaning, Fast.io; if they need a safe, predictable disk, AgentDisk.',
    rows: [
      ['MCP server', AD.mcp, ['yes', 'Read and manage tools for each part of the platform']],
      ['REST API', AD.rest, ['yes', 'REST API with API keys or OAuth']],
      ['Semantic search / RAG over files', AD.semantic, ['yes', 'RAG and semantic search']],
      ['Cloud sync', ['no', 'Not offered'], ['yes', 'Cloud sync']],
      ['Desktop app', ['no', 'Dashboard in the browser'], ['yes', 'Desktop app']],
      ['Ownership transfer', ['part', 'A sandbox is claimed by a person with one link'], ['yes', 'Ownership transfer']],
      ['Free plan', AD.free, ['no', '30-day trials instead of a permanent free tier']],
      ['Entry paid plan', [null, '$9 / month (Basic)'], [null, '$9.99 / month (Starter)']],
      ['Hard-capped pricing', ['yes', 'No overage charges exist'], ['no', 'Current plans meter overage beyond the allowance']],
      ['No-account sandbox', AD.sandbox, ['part', 'An agent can create a workspace and transfer it to a person']],
    ],
    sections: {
      Pricing: [
        'AgentDisk has four flat plans: Free at $0 with 1 GB, Basic at $9 a month with 5 GB, Pro at $20 with 50 GB and Team at $80 with 500 GB. Requests are unlimited on all of them and there is no overage rate at all: a write that would go over a limit is refused with an error that names the limit. Fast.io\'s paid plans start at $9.99 a month for Starter, with 30-day trials rather than a free tier, and its current plans meter usage beyond the monthly allowance as overage.',
        'The difference matters most for autonomous agents. A loop that runs all night on AgentDisk stops at the plan\'s ceiling; it cannot produce a bill above the plan price. See [Pricing](/pricing) and [Hard-capped pricing](/blog/hard-capped-pricing-ai-storage).',
      ],
      Security: [
        'Every AgentDisk key carries a set of operations and an optional path prefix, matched on whole path segments, and listings and searches are clipped to that prefix. The workspace is bound from the key before any handler runs, so a key cannot name another tenant\'s data even by mistake. Keys are stored as a SHA-256 hash and as AES-256-GCM ciphertext, and every MCP call, including a refused one, lands in the activity log.',
        'AgentDisk holds no certification of its own; it runs on Cloudflare, Firebase and Stripe, which hold theirs. The details are on [Security](/security).',
      ],
      Setup: [
        'An agent can get an AgentDisk workspace and a key with one unauthenticated POST, no account and no bot check, and a person claims it later with a one-time link that keeps the agent\'s key working. Connecting a client is one config block; the [quick start](/docs/quickstart) has it for Claude Code, Cursor, VS Code, Windsurf, Zed, Codex CLI and Gemini CLI.',
        'Fast.io offers a desktop app and cloud sync, which suits teams who want the same files on their own machines as well as in front of their agents.',
      ],
      'API design': [
        'AgentDisk exposes eleven MCP tools, deliberately: list, search, read, get, metadata, create, update, delete, folder, move and copy. Workspace, agent and key management are not exposed over MCP, because letting a model mint its own credentials is a larger blast radius than any task needs. The tools call the REST handlers, so the two surfaces cannot disagree.',
        'Fast.io\'s MCP server covers its whole platform, with a read tool and a manage tool for each area. A wide tool surface covers more workflows from inside the model; a small one is easier to scope and audit. Which you want depends on how much you want the model, rather than your code, to decide.',
      ],
      'Best for': [
        '**Choose Fast.io** if your agents need retrieval over file contents, sync to desktops, a desktop app, or MCP access to a whole collaboration platform.',
        '**Choose AgentDisk** if you want a predictable bill, per-agent least-privilege keys, an audit trail of denied calls, and storage you can hand an agent in a minute without an account.',
      ],
    },
    faq: [
      { q: 'Is AgentDisk cheaper than Fast.io?', a: 'At entry level the paid plans are close: AgentDisk Basic is $9 a month and Fast.io Starter is $9.99. The difference is the shape of the bill: AgentDisk has a free plan with 1 GB and every plan is hard-capped with no overage, while Fast.io offers 30-day trials and its current plans meter overage beyond the allowance.' },
      { q: 'Does AgentDisk have semantic search like Fast.io?', a: 'No. AgentDisk search matches a file\'s name, path, caption and tags, never its contents. If your agents need retrieval by meaning over file contents, Fast.io offers RAG and semantic search and AgentDisk does not.' },
      { q: 'Which has the larger MCP surface?', a: 'Fast.io, whose MCP server reaches across its whole platform. AgentDisk has eleven tools, all about files and folders, and deliberately leaves workspace and key management out of MCP so a model cannot mint its own credentials.' },
      { q: 'Can an agent start using AgentDisk without an account?', a: 'Yes. One unauthenticated POST creates a sandbox workspace and a key, with 500 MB for three days. A person claims it with a one-time link, and the agent\'s key keeps working after the claim.' },
      { q: 'Do I have to run any servers for AgentDisk?', a: 'No. The API, the MCP server and the dashboard run on Cloudflare\'s edge and the files are in Cloudflare R2. There is nothing to deploy, patch or scale.' },
    ],
    posts: ['why-we-built-agentdisk', 'hard-capped-pricing-ai-storage', 'scoped-credentials-ai-agents'],
  },

  /* ─────────────────────────────── Amazon S3 ─────────────────────────────── */
  {
    slug: 'agentdisk-vs-s3',
    name: 'Amazon S3',
    h1: 'AgentDisk vs S3 for AI agents: agent-native storage or the general-purpose standard?',
    title: 'AgentDisk vs S3 for AI Agents — AgentDisk',
    description: 'AgentDisk vs Amazon S3 for AI agent storage: MCP support, scoped keys vs IAM, egress costs, setup time, scale, and when to use which (or both).',
    verdict: 'S3 is the right answer for scale, for data lakes and for anything already living in AWS. AgentDisk is the right answer when the client is an AI agent: an MCP server built in, per-agent keys scoped by path without writing IAM policy, a log of denied calls, and a plan price that cannot be exceeded. The two also work well side by side.',
    rows: [
      ['File-oriented MCP server', AD.mcp, ['part', 'AWS\'s general MCP server calls raw AWS APIs with IAM credentials']],
      ['REST / HTTP API', AD.rest, ['yes', 'The S3 API']],
      ['S3-compatible API', AD.s3api, ['yes', 'It is the S3 API']],
      ['Per-agent scoped access', ['yes', 'Operations and path prefix on the key itself'], ['yes', 'Through IAM policies you write']],
      ['Pricing model', AD.pricing, [null, 'Pay as you go: storage, requests and egress']],
      ['Bill ceiling', ['yes', 'Hard caps; no overage charges'], ['no', 'Usage-based; no built-in hard cap']],
      ['Egress', ['yes', 'Included per plan, per workspace per month'], [null, 'Charged per GB transferred out']],
      ['Scale', ['part', 'Up to 500 GB and 4.9 GB files on Team'], ['yes', 'Effectively unlimited']],
      ['Ecosystem and integrations', ['part', 'REST, MCP, webhooks'], ['yes', 'Mature and vast']],
      ['Audit of denied agent calls', AD.audit, ['part', 'Available through AWS logging services you configure']],
      ['Time to first file', ['yes', 'About five minutes'], ['part', 'Account, bucket, IAM user and policy first']],
    ],
    sections: {
      Pricing: [
        'S3 bills for what you use: storage per GB-month, requests, and data transferred out. That is efficient at scale and unpredictable for an autonomous agent, because an agent that re-downloads the same files in a loop turns directly into egress charges, and nothing in S3 stops it at a budget.',
        'AgentDisk sells four flat plans from $0 to $80 a month with egress included and unlimited requests. A write or download that would exceed the plan is refused, not billed. See [Pricing](/pricing).',
      ],
      Security: [
        'S3 can express any access policy you can write in IAM, and that is both its strength and the cost: giving each agent least privilege means a user or role and a policy per agent, and getting a prefix condition wrong is easy. AgentDisk puts the scope on the key: a set of operations and a path prefix matched on whole segments, enforced on every call, with listings clipped to the prefix.',
        'S3 runs inside AWS\'s certified infrastructure. AgentDisk runs on Cloudflare, Firebase and Stripe, which hold their own certifications; AgentDisk holds none of its own. See [Security](/security).',
      ],
      Setup: [
        'With S3, an agent needs an AWS account, a bucket, an IAM identity, a policy, credentials in its environment, and an SDK or AWS\'s general-purpose MCP server. With AgentDisk it needs one key and one config block, or a sandbox from one POST with no account at all. The [quick start](/docs/quickstart) takes about five minutes.',
      ],
      'API design': [
        'The S3 API is object storage: keys and bytes, designed for programs. AgentDisk is a file system for agents: paths, folders, captions, tags and custom metadata an agent can reason about, `read_file` that returns text inline so a model with no way to follow a URL can still read what it wrote, and the same operations over MCP and REST.',
        'AgentDisk does not speak the S3 API, so S3 tooling will not point at it. The full comparison of when each fits is in [S3 vs AgentDisk for AI agents](/blog/s3-vs-agentdisk-ai-agent-storage).',
      ],
      'Best for': [
        '**Choose S3** for very large datasets, files over 4.9 GB, data that already lives in AWS, and pipelines built on the S3 ecosystem.',
        '**Choose AgentDisk** for the files agents create and read back: notes, task lists, reports, intermediate results, with per-agent keys and a bill that cannot run away. Keep the data lake in S3 and give the agents AgentDisk.',
      ],
    },
    faq: [
      { q: 'Is AgentDisk an S3 alternative for AI agents?', a: 'For the files agents create and read, yes: it gives each agent a scoped workspace over MCP and REST with hard-capped pricing. It is not a general S3 replacement: it does not speak the S3 API and is not built for data lakes or files over 4.9 GB.' },
      { q: 'Does AgentDisk charge for egress like S3?', a: 'No. Egress is included in every plan, counted per workspace per month. A download that would exceed the plan\'s allowance is refused rather than billed.' },
      { q: 'Can I scope an AgentDisk key like an IAM policy?', a: 'Each key carries operations (read, write, delete, list, share, keys:create) and an optional path prefix matched on whole segments. That covers the common least-privilege cases without writing policy, but it is not as expressive as IAM.' },
      { q: 'Does S3 have an MCP server?', a: 'Not one built around files. AWS runs a general-purpose AWS MCP Server that lets an agent call AWS APIs, S3 included, with IAM credentials, so scoping each agent is still IAM policy work. AgentDisk\'s MCP server is built for files and uses the same scoped keys and authorization as its REST API.' },
      { q: 'Can I use S3 and AgentDisk together?', a: 'Yes, and the split is natural: large datasets stay in S3 while agents keep their working files, notes and results in AgentDisk, where each agent\'s key is scoped and its calls are logged.' },
    ],
    posts: ['s3-vs-agentdisk-ai-agent-storage', 'scoped-credentials-ai-agents', 'hard-capped-pricing-ai-storage'],
  },

  /* ─────────────────────────────── Diskd.ai ─────────────────────────────── */
  {
    slug: 'agentdisk-vs-diskd-ai',
    name: 'Diskd.ai',
    h1: 'AgentDisk vs Diskd.ai: managed serverless storage or self-hostable processing?',
    title: 'AgentDisk vs Diskd.ai — AgentDisk',
    description: 'AgentDisk vs Diskd.ai for AI agent file storage: self-hostable vs fully managed, vector search, file processors, MCP and setup compared.',
    verdict: 'Diskd.ai is the choice when files must stay on your own infrastructure or when agents need vector search and file processing. AgentDisk is the choice when you would rather run nothing: fully managed, serverless, hard-capped pricing, and an agent connected in minutes.',
    rows: [
      ['Deployment', [null, 'Fully managed, serverless'], [null, 'Self-hostable on-prem or in your cloud; also runs a hosted app']],
      ['Infrastructure to run', ['no', 'None: no Docker, no Kubernetes'], ['part', 'Your own, when self-hosted']],
      ['Vector search', ['no', 'Name, path, caption and tag search'], ['yes', 'Vector search']],
      ['File processors', ['no', 'Bytes are stored as uploaded'], ['yes', '20+ file processors']],
      ['MCP server', AD.mcp, ['yes', 'MCP server for its files']],
      ['Published pricing', AD.pricing, ['no', 'No plans or prices on its site']],
    ],
    sections: {
      Pricing: [
        'AgentDisk costs the plan price and nothing more: $0, $9, $20 or $80 a month, with requests unlimited and egress included. Self-hosting moves the cost into your own servers, storage and the time to operate them, which can be cheaper at scale and is always less predictable at the start.',
      ],
      Security: [
        'Self-hosting keeps every byte inside your own network, which some compliance regimes require; if that is yours, Diskd.ai\'s deployment model answers it and AgentDisk\'s does not. AgentDisk keeps files in Cloudflare R2, encrypted at rest by the provider, with each workspace bound from the credential before any handler runs and every agent call logged. See [Security](/security) and [Sub-processors](/sub-processors).',
      ],
      Setup: [
        'Self-hosting means provisioning, upgrading, backing up and monitoring the service yourself, usually with Docker or Kubernetes. AgentDisk needs a key and one config block; the [quick start](/docs/quickstart) covers every common MCP client.',
      ],
      'API design': [
        'Diskd.ai processes files: vector search and more than twenty processors. AgentDisk stores them, and keeps what an agent needs to reason about a file in its metadata: MIME type, size, SHA-256, caption, up to 32 tags and custom key-values. If you want embeddings, compute them in your own pipeline and keep the source files in AgentDisk.',
      ],
      'Best for': [
        '**Choose Diskd.ai** for on-prem requirements, vector search and server-side file processing.',
        '**Choose AgentDisk** if you want managed storage with nothing to operate, least-privilege keys per agent and a bill you know in advance.',
      ],
    },
    faq: [
      { q: 'Can AgentDisk be self-hosted?', a: 'No. AgentDisk is a fully managed service on Cloudflare\'s network. If files must stay on your own infrastructure, a self-hostable product such as Diskd.ai fits that requirement better.' },
      { q: 'Does AgentDisk do vector search?', a: 'No. Search matches a file\'s name, path, caption and tags, never its contents. Diskd.ai offers vector search; with AgentDisk you would compute embeddings in your own pipeline.' },
      { q: 'Do I need Docker or Kubernetes for AgentDisk?', a: 'No. There is nothing to deploy. You create a key in the dashboard, or a sandbox with one POST, and add one block to your MCP client\'s configuration.' },
      { q: 'How is AgentDisk priced compared with self-hosting?', a: 'AgentDisk is a flat plan price, $0 to $80 a month, hard-capped with no overage charges. Self-hosting has no subscription but you pay for and operate the servers and storage yourself.' },
      { q: 'Does AgentDisk process or convert files?', a: 'No. Files are stored exactly as uploaded, with a SHA-256 checksum and the metadata you attach. Text files up to 1 MB can be read back inline by an agent.' },
    ],
    posts: ['workspace-isolation-multi-agent', 'why-ai-agents-need-file-storage', 'hard-capped-pricing-ai-storage'],
  },

  /* ─────────────────────────────── Cloudflare R2 ─────────────────────────────── */
  {
    slug: 'agentdisk-vs-cloudflare-r2',
    name: 'Cloudflare R2',
    h1: 'AgentDisk vs Cloudflare R2: raw object storage or an agent layer on top of it?',
    title: 'AgentDisk vs Cloudflare R2 — AgentDisk',
    description: 'AgentDisk vs Cloudflare R2 for AI agents: AgentDisk stores files in R2 and adds MCP, scoped credentials, workspaces, an audit log and webhooks.',
    verdict: 'AgentDisk is built on Cloudflare R2, so this is not either-or. R2 is lower raw cost with zero egress fees and an S3-compatible API; AgentDisk is the agent layer on top: an MCP server, per-agent scoped keys, workspaces, an audit log and webhooks. Use R2 directly if you are writing the program; use AgentDisk when an agent is the client.',
    rows: [
      ['Underlying storage', [null, 'Cloudflare R2'], [null, 'Cloudflare R2']],
      ['Raw storage cost', ['part', 'Flat plans, $0 to $80 a month'], ['yes', 'Lower raw cost, pay as you go']],
      ['Egress fees', ['yes', 'Included in the plan'], ['yes', 'Zero egress fees']],
      ['S3-compatible API', AD.s3api, ['yes', 'S3-compatible']],
      ['MCP server', AD.mcp, ['no', 'Not part of R2']],
      ['Per-agent scoped keys with path prefixes', AD.scoped, ['part', 'API tokens; per-agent path scoping is yours to build']],
      ['Workspaces and members', ['yes', 'Many workspaces, reader members'], ['no', 'Buckets']],
      ['Audit log of agent calls', AD.audit, ['no', 'Yours to build']],
      ['Webhooks on file events', ['yes', 'Signed, queued deliveries'], ['part', 'Event notifications to a queue you consume']],
      ['Hard bill ceiling', ['yes', 'No overage charges'], ['no', 'Usage-based']],
    ],
    sections: {
      Pricing: [
        'Per gigabyte, R2 is cheaper than any AgentDisk plan: you pay R2\'s own storage and operation rates with no egress fees. AgentDisk charges a flat plan, $0 to $80 a month, for the layer it adds and for a ceiling: requests unlimited, egress included, and a refusal rather than a bill when a limit is reached. See [Pricing](/pricing).',
      ],
      Security: [
        'AgentDisk inherits what R2 provides, including encryption at rest by Cloudflare, and adds the agent-facing controls R2 leaves to you: a key per agent scoped to operations and a whole-segment path prefix, the workspace bound from the credential before any handler runs, identical authentication failures, presigned URLs for exactly one object, and a log of every MCP call including the refused ones. See [Security](/security).',
      ],
      Setup: [
        'With R2 directly, an agent needs a Cloudflare account, a bucket, an API token, an S3 SDK or an MCP server of your own, and whatever per-agent scoping and logging you build. With AgentDisk it needs one key and one config block; the [quick start](/docs/quickstart) has them.',
      ],
      'API design': [
        'R2 is an object store with the S3 API. AgentDisk is files and folders with metadata an agent can reason about, over MCP and REST, where the MCP tools call the REST handlers so both surfaces enforce the same rules. Large uploads go straight to R2 through a presigned URL, so the API is never in the byte path for big files.',
      ],
      'Best for': [
        '**Choose R2 directly** when you are writing the program that stores the files and want the lowest raw cost and the S3 ecosystem.',
        '**Choose AgentDisk** when the client is an AI agent and you want scoped keys, an audit trail, webhooks and a fixed price without building them.',
      ],
    },
    faq: [
      { q: 'Does AgentDisk use Cloudflare R2?', a: 'Yes. File bytes are stored in Cloudflare R2 and metadata in Cloudflare\'s edge database. AgentDisk is the layer that adds MCP, scoped credentials, workspaces, the audit log and webhooks.' },
      { q: 'Is R2 cheaper than AgentDisk?', a: 'Per gigabyte, yes. R2 has lower raw storage cost and zero egress fees. AgentDisk charges a flat, hard-capped plan for the agent layer on top, from $0 to $80 a month.' },
      { q: 'Is AgentDisk S3-compatible like R2?', a: 'No. AgentDisk exposes a REST API and an MCP server, not the S3 API. Presigned uploads go to R2 internally, but S3 tooling cannot point at AgentDisk.' },
      { q: 'Why not give my agent an R2 API token?', a: 'You can, but per-agent path scoping, an audit log of what each agent did or was refused, and a spending ceiling are then yours to build. AgentDisk provides them per key.' },
      { q: 'Does AgentDisk support webhooks like R2 event notifications?', a: 'Yes. AgentDisk delivers signed webhooks when files are created and deleted, to an HTTPS endpoint, through a queue, with a five-minute replay window on the signature.' },
    ],
    posts: ['why-we-built-agentdisk', 'workspace-isolation-multi-agent', 'ai-agent-data-encryption'],
  },

  /* ─────────────────────────────── Composio ─────────────────────────────── */
  {
    slug: 'agentdisk-vs-composio',
    name: 'Composio',
    h1: 'AgentDisk vs Composio: dedicated file storage or an integration platform?',
    title: 'AgentDisk vs Composio — AgentDisk',
    description: 'AgentDisk vs Composio for AI agents: 1,500+ app integrations and OAuth vs dedicated, scoped file storage. Why the two are complementary, and when to use each.',
    verdict: 'They solve different problems. Composio connects agents to more than 1,500 apps and manages their OAuth, and it holds SOC 2 Type II. AgentDisk is one thing, a scoped and persistent disk for agents, and it is simpler for that one thing. Agents that need both can run both side by side.',
    rows: [
      ['Primary purpose', [null, 'File storage for agents'], [null, 'Tool and API integrations for agents']],
      ['Integrations', ['part', 'REST, MCP, webhooks'], ['yes', '1,500+ app integrations']],
      ['OAuth management for third-party apps', ['no', 'Not its job'], ['yes', 'Managed OAuth']],
      ['Own SOC 2 certification', ['no', 'Runs on SOC 2 certified providers'], ['yes', 'SOC 2 Type II']],
      ['Durable file storage', ['yes', 'Files, folders, metadata, presigned uploads'], ['part', 'Temporary staging for files tools exchange, deleted after about a day']],
    ],
    sections: {
      Pricing: [
        'AgentDisk is four flat plans from $0 to $80 a month, hard-capped, with unlimited requests and egress included. You pay only for storage, which is the one thing it does. See [Pricing](/pricing).',
      ],
      Security: [
        'Composio holds its own SOC 2 Type II report and AgentDisk does not; AgentDisk runs on Cloudflare, Firebase and Stripe, which hold theirs, and lists its own controls on [Security](/security). Within its scope, AgentDisk enforces least privilege per agent: operations and a path prefix on every key, the workspace bound from the credential, and every MCP call logged, refused ones included.',
      ],
      Setup: [
        'AgentDisk is one MCP server entry or one REST header. An agent that already uses Composio for its integrations can add AgentDisk beside it as the place its files live; the [quick start](/docs/quickstart) has the config for each client.',
      ],
      'API design': [
        'An integration platform gives an agent many tools across many services. AgentDisk gives it eleven file tools with a deliberately small blast radius: no tool can mint a key or delete a workspace. That narrowness is what makes per-agent scoping and auditing simple to reason about.',
      ],
      'Best for': [
        '**Choose Composio** to connect agents to SaaS APIs with managed OAuth.',
        '**Choose AgentDisk** to give those agents a persistent, scoped place to keep their files. The two are complementary.',
      ],
    },
    faq: [
      { q: 'Is AgentDisk a Composio alternative?', a: 'Not for integrations. Composio connects agents to more than 1,500 apps with managed OAuth. AgentDisk is dedicated file storage for agents and works alongside an integration platform rather than replacing it.' },
      { q: 'Is AgentDisk SOC 2 certified like Composio?', a: 'No. AgentDisk does not hold its own SOC 2 certification. It runs on Cloudflare, Firebase and Stripe, which hold SOC 2 Type II reports, and its own controls are listed on the Security page.' },
      { q: 'Can I use AgentDisk and Composio together?', a: 'Yes. Add AgentDisk as an MCP server or call its REST API from the same agent. Composio handles the third-party apps and AgentDisk holds the files the agent creates and reads.' },
      { q: 'What does AgentDisk cost?', a: 'Free with 1 GB and one agent identity, then $9, $20 or $80 a month. Every plan is hard-capped with unlimited requests and egress included.' },
      { q: 'Does AgentDisk manage OAuth for other services?', a: 'No. AgentDisk authenticates its own API with scoped API keys and signs people in through Firebase Authentication. It does not hold credentials for other services.' },
    ],
    posts: ['rest-vs-mcp-ai-agent-storage', 'scoped-credentials-ai-agents', 'why-we-built-agentdisk'],
  },
];

export const ALTERNATIVES = [
  {
    slug: 'fast-io',
    name: 'Fast.io',
    h1: 'Looking for a Fast.io alternative?',
    compare: 'agentdisk-vs-fast-io',
    title: 'Fast.io Alternative for AI Agent Storage — AgentDisk',
    description: 'Looking for a Fast.io alternative? AgentDisk is hard-capped, serverless file storage for AI agents from $0, with MCP, scoped keys and a no-account sandbox.',
    reasons: [
      '**A free plan.** 1 GB and one agent identity with no card, where Fast.io offers 30-day trials. Paid plans start at $9 a month.',
      '**A ceiling on the bill.** Every AgentDisk plan is hard-capped: no overage charges exist, and a limit produces an error rather than an invoice. Fast.io\'s current plans meter overage.',
      '**Less surface.** Eleven MCP tools, all about files, with key and workspace management kept away from the model.',
      '**Nothing to set up first.** An agent can get a sandbox workspace and key with one POST and no account; a person claims it later.',
    ],
    stay: 'Stay with Fast.io if you rely on RAG or semantic search over file contents, cloud sync, its desktop app or ownership transfer: AgentDisk does not offer those.',
    migration: [
      'Create an AgentDisk account, or a sandbox with one POST, and an agent with a key scoped to the paths it needs.',
      'Download your files from Fast.io and upload them to the same paths: inline for files up to 1 MB, a presigned upload above that.',
      'Replace the Fast.io MCP entry in your client with the AgentDisk one from the [quick start](/docs/quickstart).',
      'Check the Activity log as the agent runs, and adjust the key\'s scope if a call is refused.',
    ],
    faq: [
      { q: 'What is the best Fast.io alternative for AI agents?', a: 'If you need scoped, persistent file storage with predictable pricing, AgentDisk is a direct alternative: an MCP server and REST API, per-agent keys, an audit log and hard-capped plans from $0. If you need semantic search over contents, Fast.io remains the better fit.' },
      { q: 'Is AgentDisk cheaper than Fast.io?', a: 'The entry plans are close, $9 a month for Basic against $9.99 for Fast.io Starter. AgentDisk adds a free plan with 1 GB, and every AgentDisk plan is hard-capped with no overage charges, where Fast.io\'s current plans meter overage.' },
      { q: 'Will my Fast.io MCP workflows work on AgentDisk?', a: 'File workflows will: listing, searching by name and tags, reading, writing, moving, copying and deleting. Workflows that use Fast.io-specific tools, such as semantic search or sync, have no AgentDisk equivalent.' },
      { q: 'How do I move my files from Fast.io to AgentDisk?', a: 'Download them from Fast.io and upload them to AgentDisk over REST or MCP. There is no automated importer, so a short script that lists and re-uploads is the usual route.' },
      { q: 'Can I try AgentDisk without signing up?', a: 'Yes. A sandbox gives an agent a workspace and a key with no account, 500 MB for three days, and a one-time link to claim it.' },
    ],
  },
  {
    slug: 's3-for-agents',
    name: 'S3',
    h1: 'Looking for an S3 alternative?',
    compare: 'agentdisk-vs-s3',
    title: 'S3 Alternative for AI Agents — AgentDisk',
    description: 'Looking for an S3 alternative for AI agents? AgentDisk adds MCP, per-agent scoped keys without IAM, included egress and hard-capped pricing.',
    reasons: [
      '**No IAM to write.** Each AgentDisk key carries its operations and a path prefix; least privilege per agent is a form, not a policy document.',
      '**MCP built for files.** The MCP server uses the same scoped keys and the same authorization as the REST API, rather than raw cloud APIs behind IAM.',
      '**No egress surprises.** Egress is included in the plan and requests are unlimited; a limit refuses rather than bills.',
      '**Five-minute setup.** One key and one config block, or a sandbox with no account at all.',
    ],
    stay: 'Stay with S3 for large datasets, files over 4.9 GB, data already in AWS, and pipelines built on the S3 API, which AgentDisk does not speak.',
    migration: [
      'Decide which files are the agents\' working set: notes, task lists, reports, intermediate results. Leave bulk data in S3.',
      'Create a workspace per project or client, and an agent and key per role, scoped to its own prefix.',
      'Copy the working set across: download from S3, upload to AgentDisk at the same paths.',
      'Point the agent at AgentDisk with the config from the [quick start](/docs/quickstart), and remove its AWS credentials.',
    ],
    faq: [
      { q: 'Is AgentDisk a replacement for S3?', a: 'For the files agents create and read back, yes. For data lakes, very large files or anything built on the S3 API, no: AgentDisk does not speak the S3 API and its largest file is 4.9 GB on the Team plan.' },
      { q: 'Does AgentDisk charge for data transfer?', a: 'No. Egress is included in every plan and counted per workspace per month. A download over the allowance is refused, not billed.' },
      { q: 'How do I limit an agent to one folder?', a: 'Give its key a path prefix such as /agents/research-bot. The prefix is matched on whole segments, and listings and searches never show anything outside it.' },
      { q: 'Can I keep using S3 alongside AgentDisk?', a: 'Yes. A natural split is bulk data in S3 and each agent\'s working files in AgentDisk, where its key is scoped and every call is logged.' },
      { q: 'Is there a free tier?', a: 'Yes: 1 GB of storage, 10 GB of egress a month and one agent identity, with no card. A sandbox needs no account at all.' },
    ],
  },
  {
    slug: 'composio-storage',
    name: 'Composio',
    h1: 'Looking for file storage for Composio agents?',
    compare: 'agentdisk-vs-composio',
    title: 'File Storage Alongside Composio — AgentDisk',
    description: 'Looking for file storage for Composio agents? AgentDisk is dedicated, scoped storage for AI agents over MCP and REST, from $0 with hard-capped plans.',
    reasons: [
      '**Dedicated storage.** Files, folders, captions, tags and custom metadata, with presigned uploads for large files.',
      '**Least privilege per agent.** Keys scoped to operations and a path prefix, so one agent cannot read another\'s files.',
      '**An audit trail.** Every MCP call is logged with the agent, path and outcome, refusals included.',
      '**Simple and cheap.** Flat plans from $0 to $80 a month, hard-capped.',
    ],
    stay: 'Keep Composio for what it does: more than 1,500 app integrations, managed OAuth and its own SOC 2 Type II report. AgentDisk sits beside it, not in place of it.',
    migration: [
      'Create an AgentDisk workspace and a key per agent, scoped to that agent\'s prefix.',
      'Add AgentDisk to the agent as an MCP server, or call its REST API from your code; the [quick start](/docs/quickstart) has both.',
      'Point the steps that write files at AgentDisk paths, and keep Composio for the third-party tools.',
      'Watch the Activity log on the first runs to confirm each agent stays inside its prefix.',
    ],
    faq: [
      { q: 'Does Composio include file storage?', a: 'Composio is an integration platform for connecting agents to other APIs. If your agents need a persistent, scoped place for their own files, AgentDisk provides that and runs beside Composio.' },
      { q: 'Can an agent use Composio and AgentDisk at the same time?', a: 'Yes. Both can be MCP servers in the same client, or you can call AgentDisk\'s REST API from code that also uses Composio.' },
      { q: 'Is AgentDisk SOC 2 certified?', a: 'No. AgentDisk runs on providers with SOC 2 Type II reports, Cloudflare, Firebase and Stripe, and lists its own controls on its Security page.' },
      { q: 'How are AgentDisk keys scoped?', a: 'Each key has a set of operations, read, write, delete, list, share and keys:create, and an optional path prefix. A key can only mint keys narrower than itself.' },
      { q: 'What does AgentDisk cost?', a: 'Free for 1 GB and one agent identity, then $9, $20 or $80 a month. Requests are unlimited and egress is included.' },
    ],
  },
];

export function comparisonBySlug(slug) {
  return COMPARISONS.find(c => c.slug === slug) ?? null;
}

export function alternativeBySlug(slug) {
  return ALTERNATIVES.find(a => a.slug === slug) ?? null;
}

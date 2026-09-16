# AgentDisk — Serverless AI-Agent Storage Platform
## Complete Research, Design & Implementation Package — Index

This package is the full response to the brief: research AgentStorage (agentstorage.ai) and its competitive landscape, design a better, simpler, serverless-first alternative ("AgentDisk"), and produce implementation-ready specifications for both Claude Design and Claude Code. It follows the requested **PART 1–26** structure across 10 documents, plus this index. Every claim about AgentStorage or a competitor is tagged **FACT** (verified from a live primary source), **INFERENCE** (reasoned, not verified), or **PROPOSAL** (our own design decision) — see `01` for the full evidence base.

| # | File | Contents (PART numbers) |
|---|---|---|
| 1 | `01-research-and-opportunity.md` | Executive Summary · AgentStorage Analysis · Competitor Analysis (20 products) · Product Opportunity (PART 1–4) |
| 2 | `02-product-and-mvp-scope.md` | Personas · Core Abstraction / Entity Model · MVP-0 / MVP-1 / V2 Scope · Quotas · Billing sequencing (PART 5–6) |
| 3 | `03-ux-architecture-and-screens.md` | Design Principles · Design System · Navigation · Responsive/Accessibility Rules · Full Screen Spec, 27 screens (PART 7–8) |
| 4 | `04-claude-design-prompt.md` | **Standalone, copy-paste prompt for Claude Design** (PART 9) |
| 5 | `05-technical-architecture.md` | Architecture Diagram · D1 vs. Postgres Decision · Data Flows · Search Strategy · D1 Schema · R2 Object-Key Strategy · Full REST API · Full MCP Tool Spec + hosting decision (PART 10–14) |
| 6 | `06-security-privacy-legal.md` | Auth Design · API Key Model · Tenant Isolation · Full Security Control List (CSRF/CORS/XSS/SSRF/path traversal/etc.) · Cookie Policy · Draft Privacy Policy · Draft Terms of Service · Error Catalogue (PART 15–17) |
| 7 | `07-cloudflare-deployment-and-cost.md` | Environments · Wrangler Config · Deployment Steps · Domains/DNS · Observability · Project Structure · Full Cost Model by Growth Stage (PART 18–19) |
| 8 | `08-claude-code-prompt.md` | **Standalone, copy-paste hands-off build prompt for Claude Code** (PART 20) |
| 9 | `09-test-strategy-and-failure-modes.md` | Unit/Integration/E2E Strategy · 21 Security Test Cases · Performance Matrix · Failure-Mode Table · Consistency Model · Backup & Recovery (PART 21–23) |
| 10 | `10-cicd-docs-roadmap-and-recommendation.md` | CI/CD Pipelines · Documentation Plan · 12-Phase Roadmap · 8 ADRs · **Final Recommendation** (PART 24–26 + decision document) |
| 11 | `11-backend-implementation-prompt.md` | **Standalone Claude Code prompt** — backend build against the real repo (D1 schema incl. `refresh_tokens`, REST + MCP routes, auth/authz/quota middleware) |
| 12 | `12-deployment-roadmap-agentdisk-io.md` | 29-step numbered roadmap for the real domain **agentdisk.io** on Cloudflare — Terraform, GitHub branching/PR flow, naming standard, environment separation. **Supersedes** `07` PART 18.1's three-tier/placeholder-domain sketch — see the note at the top of `07` PART 18 |
| 13 | `13-infra-cicd-implementation-prompt.md` | **Standalone Claude Code prompt** — executes `12` end to end (Terraform modules, GitHub Actions, environment wiring); explicit human-vs-agent boundary |
| 14 | `14-admin-panel-and-billing-design.md` | Staff auth model (separate from customer auth) · **Admin (Staff) Panel** — 8 screens, internal-only · Stripe Customer Portal integration (PART 27–29) |
| 15 | `15-frontend-admin-billing-implementation-prompt.md` | **Standalone Claude Code prompt** — builds `apps/web` (User panel), `apps/admin` (Staff panel), and Stripe billing, gated on the backend-remediation items (CORS fix, Terraform directory migration, audit-event wiring) landing first |

### How to use this package

- **To have Claude Design build the UI:** hand it `04-claude-design-prompt.md` directly. It's self-contained.
- **To have Claude Code build the product from scratch:** hand it `08-claude-code-prompt.md` directly, alongside the rest of this package in the repo (it references files `01`, `05`, `06`, `07`, `09` by name). *(Historical: this was the original single-shot prompt, written before real implementation began against a real repo — `11`/`13`/`15` below are the current, phased prompts actually in use.)*
- **To stand up infra/CI-CD on the real domain (agentdisk.io):** `13-infra-cicd-implementation-prompt.md`, which executes `12`'s roadmap.
- **To build the backend against the real repo:** `11-backend-implementation-prompt.md`.
- **To build the User panel, Admin panel, and Stripe billing:** `15-frontend-admin-billing-implementation-prompt.md` — run only after `11`'s backend-remediation items (CORS fix, Terraform directories, audit wiring) are verified live, since it depends on a working, CORS-correct API.
- **To review the product/business case:** read `01` → `02` → `10`'s Final Recommendation in that order.
- **To review security/legal before launch:** `06` — the Privacy Policy and Terms of Service are explicitly marked as first drafts requiring qualified legal review.

### One-paragraph summary

AgentStorage is a small, likely solo-built product (Convex + Vercel, no MCP support, no discoverable Terms/Privacy policy, several internal documentation inconsistencies) offering agent-first self-service file storage with hard-capped, transparent pricing — a sound instinct on pricing and on-boarding, undermined by real gaps in agent-native protocol support, folder/versioning capability, and trust signals. The wider 20-product competitive landscape shows the same pattern everywhere: storage products either bolt MCP on as an afterthought (or skip it — the official Anthropic MCP storage servers are archived, unmaintained) or charge a steep markup (5–130x raw object-storage cost) for a memory/RAG layer. AgentDisk is designed to occupy the gap: MCP-native from MVP-1 (not bolted on), general-purpose (files/folders/metadata, not memory- or RAG-only), and built on Cloudflare Workers + R2 + D1 so it costs $5–20/month at the validation stage and scales by usage, never by a rewrite.

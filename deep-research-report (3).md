# Project Overview

We propose **an AI Employee Platform** that “hires” AI agents as persistent employees. The company provides job descriptions, SOPs, tools, and team context, and the platform compiles these into a versioned `EmployeeSpec`. Before going live, each AI employee goes through **company-specific simulations** (like a probation), which the manager can review or modify. Once approved, the agent runs continuously, with durable memory and tool access, collaborating with human and AI coworkers. All agent actions happen in **Solari’s isolated agent environments** (browsers, sandboxes, desktops) so they can interact with legacy desktop apps or the web. Key features include **automated browser and desktop control** (via Solari), **multimodal memory**, **long-running workflow support**, and **built-in safety gates** (approval for risky actions).

## Solari Agent Infrastructure

Solari provides the core execution environment. It offers cloud Chrome browsers, Linux VMs (“desktops”), and sandboxes, all isolated on microVMs. Solari handles stealth browsing, proxy IPs, CAPTCHA solving, and **persistent browser profiles** (cookies and logins carry over). For example, a Solari browser is a real Chrome that starts in ~1s and “stays undetected, solving captchas and remembering logins”. Sandboxes and VMs start from snapshots and resume instantly, so agents can pause and resume work without re-login. Crucially, **one API key** covers all environments: “One API gives your agents access to browsers, sandboxes, and desktops”. This lets our agents use familiar dev tooling (e.g. Playwright in a browser, SSH/terminal in a VM) with a unified auth model.

Solari’s docs and examples will guide development. The official docs cover **sessions, stealth, profiles, recording** and how to spin up environments. We will use the Solari SDKs (TypeScript and optionally Python), and follow their best practices for logging in via “handoffs” (a human helps log in and Solari saves the session). We’ll also leverage Solari’s ability to **record sessions** to audit agents’ actions (for review and replay).

## Competitor Landscape & Gaps

Several startups offer similar “AI employees”, but all have gaps:

- **Zomma (YC ‘26)** focuses on financial compliance (KYC/AML). It “works on your screens – portals, registries, PDFs – so there’s nothing to integrate”, and its demo shows it reading screens and building a timestamped case file. **Limitation:** Zomma is specialized for finance compliance and still requires analysts to review outputs. It doesn’t handle arbitrary workflows outside its templates, nor collaborative multi-step tasks.

- **ChatGPT Workspace Agents (OpenAI)** let teams build bots that connect to approved apps (Slack, docs, etc). They emphasize **RBAC, audits, and approval gates** for safety. **Limitation:** These agents run *inside* the ChatGPT ecosystem. They are mostly conversation-driven (though they can call APIs or Slack), and they cannot natively operate on arbitrary desktop software or legacy systems. Their memory is limited to what’s in the chat workspace, and setting up tools involves manual whitelisting.

- **ServiceNow Agentic Desktop** is a Windows client that automates thick-client tasks on legacy apps. It supports “semi-autonomous” AI agents on Windows. **Limitation:** It is Windows-only and not cloud-native. ServiceNow explicitly warns the AI may not always be accurate and requires human oversight. Moreover, it’s primarily a workflow designer tool for service desks, not a full agent OS with context memory, multi-agent orchestration, or easy customization beyond ServiceNow’s ecosystem.

- **Moveworks, Glean, others** provide agentic features (often for IT/HR workflows). For example, Moveworks stresses that true “agentic automation” requires deep integration and governance. They note **fallback** and **observability** are crucial: many workflows still need deterministic bots and robust tests. **Limitation:** Many such platforms focus on ticketing or simple tasks and often treat agents as black-box “copilots”. They rely heavily on connectors to specific apps and do not build a shared persistent workspace or memory.

**Common weaknesses:** In summary, existing solutions either handle narrow domains or still treat agents as disposable assistants with no durable memory or simulations. They often lack *reproducible training/evaluation*: e.g. you can’t easily test them under a set of failure conditions and see an audit trail. They also typically don’t enforce hard safety blocks (beyond simple RBAC). For instance, even ServiceNow advises human oversight because the AI might err. Our design addresses these gaps with **simulation-based probation, granular approval gates, and rich memory**.

## Approach

We will build the platform in phases (see *plan.md* below). The core elements are:

- **EmployeeSpec**: a versioned spec (job description) that defines the agent’s role, responsibilities, and capabilities. It’s compiled from uploaded documents and manager inputs. The platform will expose an editor and show **source references** (e.g. “derived from OnboardingDoc.pdf”) to keep the process transparent.

- **Simulation Engine**: Before deployment, each agent runs through a suite of simulations (built-in or custom). Each simulation is a sandboxed scenario (cloud browser/VM) with injected events or failure modes. The agent’s actions are automatically scored by policy checks. This resembles a test suite; the agent *must* pass thresholds to be approved.

- **Agent Runtime**: In production, the agent runs as a **durable workflow** (built on Temporal or similar). The agent has a loop: **Context Builder → Planner → Policy Guard → Executor → Verifier → Memory** (detailed in *context.md*). The MCP *Tasks* extension will handle any steps requiring long waits (like human approvals or external jobs). The agent’s “brain” will be an LLM, but we tightly control its environment via:
  - **Tools** exposed via MCP. All API calls go through a central gateway that enforces capabilities (e.g. a “jira-create-issue” tool). We never give the raw credentials to the LLM.
  - **Policy Engine**: A rule-based system (not LLM) that classifies actions into ALLOW/YELLOW/RED. For RED actions (e.g. “transfer $80k”), the agent cannot proceed unless human approves.
  - **Context Management**: The agent sees a curated context bundle per task (identity, relevant memory, tools list, environment state). This is pulled via semantic retrieval (vector search) and rule filters.

- **Memory System**: We use multi-tier memory. Short-term working memory is ephemeral; long-term facts (episodic logs, company policy, learned skills) are stored in a combination of vector DB and relational tables (for social graphs). Every event (tool call, chat, decision) can be added to memory via an extract/verify pipeline. For example, a resolved incident can become an episodic memory (“Resolved INC-192 on 2026-09-21, cause X”). We will cite Solari logs and use embeddings to recall similar events during planning.

- **Multi-Agent & Meetings**: The platform supports multiple agents (and human roles). We maintain a *Coworker Directory* with brief profiles of each AI and human. Agents can message each other (delegation requests) via structured messages. There is also a built-in meeting system: agents receive agendas, prepare private briefs (automatically generated), and then hold a **virtual meeting** where they share conclusions and the system logs decisions/action items. (This addresses the need for AI coordination that many new tools lack.) 

- **Tech Stack**:
  - **Backend:** TypeScript/Node.js for core services (EmployeeSpec compiler, web API, context engine). We will use a **PostgreSQL** for structured data, and a vector store (like Chroma or Pinecone) for memory retrieval. Temporal will orchestrate agent workflows (ensuring durability).
  - **Frontend:** React or Next.js for the dashboard. Use WebSockets for live agent status/animations. For the office view, a 2D canvas (e.g. PixiJS or Phaser) will render floor plans and avatars.
  - **Agent Runtime:** Node.js processes for chat/planning (calling LLM via OpenAI/GPT-4o or Anthropic). Python workers can be used for heavy ML tasks (evaluation, embedding).
  - **Solari Integration:** We will use the official SDKs (@solarisdk/browser, /desktop, /sandbox). Authentication goes through our backend which holds the Solari key securely. We store profile IDs and snapshots as references, never exposing raw credentials to agents.
  - **MCP (Model Context Protocol):** Our platform will include an MCP client implementation. We’ll enable the `io.modelcontextprotocol/tasks` extension to support async tasks. Agents will talk to tools via MCP-style JSON-RPC calls, but routed through our policy gateway.

Throughout, we’ll abide by security best practices: **no prompt injection** can bypass controls, since policy checks and OS-level permissions are our safety boundaries. For example, even if an agent ‘thinks’ it should do a restricted action, the policy engine will block the request in the tool gateway.

Any needed documentation (Solari docs, MCP spec) will be linked in our code and user guides for reference. As the Solari blog and docs emphasize, “agents need secure environments that scale”. We leverage their persistent profiles and snapshots to give each agent a *live* desk and identity. With rigorous probation, logging, and human-in-the-loop approvals, this platform aims to be both powerful and safe.

# plan.md

## Phase 1: Foundations and Multi-Tenancy
- **Deliverables:** User/organization auth; RBAC schema; Postgres schema for organizations, users, memberships, and employees; basic web UI for Org settings; skeleton API endpoints.  
- **Gate:** Multi-tenant architecture complete. Can create an org, invite users, assign roles (Owner/Admin/Manager). Employee specs can be drafted (CRUD). Unit tests and basic end-to-end flows (create organization, hire employee) pass.  
- **Acceptance:** Admin can define roles & policies; user can sign up/assigned. Basic entities persist in DB.

## Phase 2: Solari Execution Environment
- **Deliverables:** Integration with Solari: ability to spin up a browser and a sandbox/desktop (using Solari API). Authentication flow implemented (vault Solari key, use SDKs). Basic *TaskRunner* module: given a “task” to open a URL or run a command, execute it in Solari. Log tool calls to event store.  
- **Gate:** Demo flow: “Create Solari desktop → run `echo hello` in terminal → capture output” works via our API. Browser can open a page (using Puppeteer/Playwright via Solari). Agent worker receives a task, executes in Solari, returns result.  
- **Acceptance:** Solari environments launch in <2s. All tool calls (browser commands, sandbox commands) produce audit events and can be replayed (via Solari recording).

## Phase 3: Agent Harness and Policy
- **Deliverables:** Implement core agent loop: Context Builder → Planner → Policy Guard → Executor → Verifier.  
  - *Planner:* LLM-based, outputs plan steps (no tool call yet).  
  - *Policy Guard:* Rule engine that checks each proposed tool action. Set up YELLOW/RED/ALLOW categories.  
  - *Executor/Verifier:* Execute ALLOW actions on Solari; afterwards, verify effects (e.g. in browser, check element state). Record evidence in memory.  
- **Gate:** Run a sample scenario (e.g. create a Jira issue): agent plans steps, policy approves; it clicks around in a Solari browser to create issue. Verification step confirms the issue exists. The entire flow completes without errors.  
- **Acceptance:** Agent can call at least two tools (e.g. browser + a stub API). Policy must block a disallowed action (unit test: agent tries `deleteAccount`, policy rejects). LLM planning outputs are correctly parsed.

## Phase 4: Context & Memory
- **Deliverables:** Multi-level memory store:
  - L0 Identity (from EmployeeSpec).  
  - L1 Working memory: handled in-process (per task state).  
  - L2 Episodic: log completed tasks with outcomes (stored in Postgres).  
  - L3 Semantic (company knowledge): a text corpus ingester with vector embeddings for SOPs, FAQs. Use Pinecone/Chroma.  
  - L5 Coworker profiles and relationships table.  
- **Gate:** Memory queries test: for a repeated question (“What’s our refund policy?”), agent retrieves the correct excerpt from documentation. Meeting context pack can fetch relevant past issues or decisions.  
- **Acceptance:** Relevant memories are retrieved by an LLM query (e.g. given a mock observation, retrieval rank test). Provenance is stored for each memory. Memory derive pipeline can ingest a sample agent log into an episodic entry.

## Phase 5: EmployeeSpec Compiler & Editor
- **Deliverables:** Document ingestion pipeline: parse uploaded PDFs, docs, and manager notes to extract responsibilities and tools (using LLM or keyword extraction). Draft an `EmployeeSpec` JSON. Web UI to review/specify duties, success metrics, tools.  
- **Gate:** Manager can upload a job description and SOP; system proposes an employee spec draft. Manager edits a responsibility or adds missing info. The change is logged (versioned).  
- **Acceptance:** Generated specs match input content (test with example JD). Editor diff view shows changes. A spec version history is maintained.

## Phase 6: Simulation Engine
- **Deliverables:**  
  - Schema for `Simulation` with initial state, events, success criteria (as in the spec above).  
  - AI-generated simulation generator (LLM proposes scenario given job role).  
  - UI to edit/create simulations and scoring rubrics.  
  - Runner that forks a fresh Solari environment, executes the simulation steps, and auto-scores.  
- **Gate:** Run a simple simulation: e.g. “Customer requests $1000 refund (limit $500)”. Agent runs and is correctly flagged/passes if escalated.  
- **Acceptance:** An `EvaluationSuite` can be executed end-to-end. Scores (pass/fail) and evidence are generated. Manager can review a failed run with replay. Simulations can be edited and re-run consistently.

## Phase 7: 2D Office & Multi-Agent
- **Deliverables:**  
  - Office map editor (rooms, desks).  
  - Avatar graphics/animations (idle, walking, working, meeting).  
  - Real-time WebSocket layer to update agent positions and states from runtime events.  
  - UI to “watch live” an agent’s computer (embedding Solari VNC or web console).  
  - Coworker directory (profiles) visible in UI.  
- **Gate:** Agents have avatars at their desks. When a task starts, the avatar shows “working”. Two agents can join a meeting room view. Dashboard shows employees and tasks with success%.  
- **Acceptance:** Avatars respond to events (walking to meeting, etc). Office UI does not block the backend if it crashes.

## Phase 8: Meetings and Collaboration
- **Deliverables:**  
  - Meeting scheduling (calendar integration or manual time).  
  - Meeting context packs and private briefs generation (each agent gets tailored agenda context from memory).  
  - Pre-meeting chat channel for agents to exchange findings.  
  - In-meeting orchestrator: structured sharing of each agent’s position, moderator notes decisions.  
  - Action item creation (tasks) post-meeting.  
- **Gate:** Simulate a cross-agent scenario (e.g. an incident requires input from two agents). The system generates agent briefs, they “chat” a bit, then hold a meeting. Decisions are logged and new tasks spawn.  
- **Acceptance:** Meeting history (agendas, decisions) is stored in memory. Agents update their actions based on meeting outcomes. Manager can query “What was decided” and see context and transcripts.

## Phase 9: Hardening and ML Integration
- **Deliverables:**  
  - Automated retraining of agent skills from past data (optional).  
  - Independent evaluation models to grade tasks (so agents can’t self-report).  
  - Performance dashboards, usage analytics, cost optimization (Solari usage stats).  
  - CLI/SDK for programmatic use (if time).  
- **Gate:** Launch readiness review with sample live demo (as below). System stress tests (multiple concurrent agents) passed.  
- **Acceptance:** All major features work, no critical bugs. Documentation is complete. A demo scenario (see MVP Demo) can be followed from hire through meeting without intervention.

Each phase should only proceed once its gate criteria are met. This ensures correctness before adding complexity (aligning with industry agile/gate methodology).

# context.md

## Architecture Diagram

We conceptualize a **tri-planar architecture**: 

```
+--------------------------------------------------+
|                CrewOS Control Plane              |
|  (Auth, Compiler, Simulation Engine, Context)    |
|                  +   +   +                       |
+--------------------------------------------------+
        |                         |
Durable Workflows                |
(Temporal)                       |
        v                         v
+-------------------+     +-----------------------+
|   Agent Runtime   |     |   Solari Environment  |
| (LLM + Planner,   |     | (Browser / Sandbox /  |
|  Verifier, Memory)|     |   Desktop instances)  |
+-------------------+     +-----------------------+
        |                         ^
        | Tools/MCP Calls         |
        v                         |
+--------------------------------------+
|             External Services         |
| (Slack, Jira, Git, Internal APIs, etc)|
+--------------------------------------+
```

This ensures each agent (workflow) can persist, resume, and coordinate with the UI/dash. The **Data Plane** (Postgres, vector DB, cache) underpins everything. Event logging ties it all together for audit and the office UI.

## EmployeeSpec (Core Model)

Central is the `EmployeeSpec` interface (example in TypeScript):

```ts
interface EmployeeSpec {
  id: string;
  version: number;
  identity: {
    name: string;
    title: string;
    departmentId: string;
    managerId: string;
    avatarId: string;
  };
  mission: string;
  responsibilities: string[];
  successMetrics: { name: string; target: number; }[];
  capabilities: { name: string; description: string; }[];
  tools: string[];            // allowed tool keys
  policies: string[];         // list of policy rules or IDs
  coworkers: string[];        // other employee IDs
  evaluationPolicy: string;   // e.g. pass criteria
  provenance: { source: string; confidence: number; }[];
}
```

Each field is annotated with its source (documents, manager input) and confidence. We store spec **versions** immutably. Changes to responsibilities or authority trigger new probation suites. 

## Tool Integration (MCP & Gateway)

Agents call external capabilities via tools. We register **MCP connections** to systems (e.g. Jira, Slack, in-house web portals). Each connection publishes tool definitions. We bind only needed tools to an agent’s spec. For example, an agent might have:

```json
"tools": {
  "jira_create": { "capability": "ALLOW" },
  "browser": { "capability": "ALLOW" },
  "jira_delete": { "capability": "DENY" }
}
```

At runtime, if the plan wants to invoke `tools/call` on `browser.goto(...)`, the **Tool Gateway** checks the agent’s tool grants and the policy engine. Capabilities are **fine-grained** (like "repo.read", "email.send") and enforced server-side. Agents never see raw credentials; the gateway injects them for the call. All MCP requests/responses are logged as events.  

We will implement the [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks) for long-running or human-in-loop steps. For instance, if an agent requests an approval (a YELLOW action), the `tools/call` handler will create a Task (state `input_required`) and pause until `tasks/update` with the approval is received.

## Memory & Context

We maintain layered memory:

- **L0 Identity**: Fixed at session start (from spec). Includes role, permissions, policies.  
- **L1 Working Memory**: In-memory context for the current task (dialogues, hypotheses). Ephemeral.  
- **L2 Episodic**: Each completed task/run becomes an entry in DB (timestamp, description, outcome, evidence IDs). Indexed by agents/keywords.  
- **L3 Semantic (Org KB)**: Vectorized company docs, SOPs, product data. On query (via semantic search) we retrieve relevant passages.  
- **L4 Procedural**: Learned or preloaded workflow steps (e.g. “Incident Investigation procedure”). Can seed planning.  
- **L5 Coworker Memory**: Public profiles of other agents/humans (roles, expertise, last interaction summary). Stored in Postgres and indexed for lookup.  
- **L6 Meeting Memory**: Records of agendas, decisions from past meetings (text+entities).

The *Context Manager* ranks memories by relevance and authority (e.g. policies > chat logs), and packages a context payload for each model call. We follow a budget breakdown, e.g. 20% for retrieved memory. The verifier and planner use different slices of this context.

We ensure memory isn’t just blind store: every candidate is *verified* (to avoid hallucination) before writing into DB. For instance, if the agent claims “Refund limit $500”, we only store that after checking the policy doc or confirmed manager input, to avoid injecting false data.

## Agent Execution

Each agent is a **Workflow (Temporal)**. Temporal naturally provides durable execution: if a machine crashes or we pause for approval, the workflow survives from the last point. We map each agent to a Temporal workflow: its ID, event history, and ability to receive Signals/Updates perfectly matches our needs. This gives us automatic persistence and retries, so we don’t build our own fault-tolerance.

**Planner:** Given a task goal, we prompt an LLM to output a plan (steps, assumptions). We then break steps into tool calls.

**Policy Guard:** For each proposed action (like “click button X” or “call delete user API”), the guard responds ALLOW/DENY/REQUIRE_APPROVAL. This is a rules engine (e.g. if action matches forbidden list or exceeds budget, etc). DENY blocks; REQUIRE_APPROVAL creates a Task as above. ALLOW passes to executor.

**Executor & Verifier:** The executor calls the MCP tool (e.g. drives the Solari browser or runs a sandbox command). Then the verifier checks the result (e.g. did the DOM change as expected?). If verification fails or a tool error occurs, the workflow can RETRY (with back-off). This avoids silent failures; e.g. if clicking a “Save” button didn’t produce the expected record, we retry.

**Memory Curator:** After task events, we decide what to store. Positive outcomes, discovered facts, or user feedback may persist. For example, after successfully creating a support ticket, we might add to episodic memory with the ticket number and context.

## Sample Code Snippet

Below is a pseudocode sketch of a plan-execute cycle:

```js
async function runTask(agentId, task) {
  const context = await buildContext(agentId, task);
  let plan = await llm.plan({ prompt: context });
  for (const step of plan.steps) {
    let decision = policy.check(step);
    if (decision === 'DENY') throw new Error("Action not allowed");
    if (decision === 'REQUIRE_APPROVAL') {
      await awaitApproval(taskId, step);
    }
    const result = await executor.execute(step);
    const verified = await verifier.verify(step, result);
    if (!verified) throw new Error("Verification failed");
    memoryCurator.maybeStore(task, step, result);
  }
  await verifier.captureOutcome(task);
}
```

Every step’s details (tools called, model tokens used, times) get logged for audit.

## Meetings & Collaboration

Agents communicate via structured messages (e.g. `AgentMessage { type, content, evidenceIds }`). We store a lightweight chat log in-context during planning. For meetings, each agent receives an agenda and a **private brief** (an LLM-generated summary of what it “knows” about each topic). They also share findings in a staging chat before the meeting starts. During the meeting, our orchestrator cycles through each agenda item, soliciting each agent’s position and evidence (much like a multiperson chat, but automated). Any human manager questions are injected as additional turns. Decisions become actionable tasks.

## Security & Oversight

We never trust the LLM blindly. All **sensitive or external actions** are mediated. The policy engine and Solari permissions enforce actual security. For example, even if an agent picks up a malicious script from a web page, it *cannot* run disallowed code because of sandboxing and policy checks. We follow Zero Trust: “nothing leaves your systems without a person approving it”. Approval gates (modeled after ChatGPT Agents’ design) ensure a manager explicitly authorizes risky ops. The probation environment is also read-only with respect to sensitive data.

## References

- **Solari Docs & Blog:** Covers browsers, sandboxes, desktops and best practices.  
- **MCP (Model Context Protocol):** Especially the *Tasks* extension for long-running operations.  
- **Temporal Workflows:** Used for durable agent state.  
- **Competitor Insights:** Zomma (screen-based agents), Moveworks (governance), ChatGPT Agents (workspace automation), ServiceNow (limitations).  

All source links (docs, blog posts) are hyperlinked or footnoted above. These provide the technical and conceptual foundation for building our platform.


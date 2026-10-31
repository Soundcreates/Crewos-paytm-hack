# CrewOS MVP demo: hire through meeting

This guide follows the current browser UI. It demonstrates a support employee’s refund-policy probation and a two-employee policy review meeting. Use a local SQLite database; this scenario does not call Jira or move money.

## Setup and credentials

Requirements: Node.js 22.5+, Python 3 (document extraction), and the installed npm dependencies.

```sh
npm install
npm start
```

Open `http://127.0.0.1:4173`, choose **Create workspace**, and create the owner account. The app creates `./data/crewos.sqlite` by default; no database service or `DATABASE_URL` is needed for this local demo.

| Variable or service | Required for this demo? | Purpose |
| --- | --- | --- |
| `DEV_LLM_API_KEY` | Optional | Enables model-generated spec drafts, scenario drafts, meeting briefs/messages/decisions, and embeddings through the local OpenAI-compatible endpoint. Without it, the app uses local fallback behavior and lexical memory search. Production uses `OPENROUTER_API_KEY`. |
| `APP_MASTER_KEY` | Only if saving keys in Settings | Encrypts integration keys entered in the UI; use at least 24 characters. Keys supplied directly as server environment variables do not use the app vault. |
| `SOLARI_API_KEY` | No | Required only for real browser, sandbox, or desktop sessions and Solari-backed simulation actions. |
| Atlassian OAuth app and Jira account/project | No | Needed only for Jira integration; requires `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET`, and `ATLASSIAN_OAUTH_REDIRECT_URI` on the server. The callback must end in `/oauth/jira/callback`; request `read:jira-work`, `write:jira-work`, and `offline_access`. Jira is not part of this demo. |
| Pinecone index | No for the walkthrough | Required for complete vector search; requires `PINECONE_INDEX_HOST` and `PINECONE_API_KEY`. Without it, memories remain pending and local lexical retrieval is used while indexing retries. |
| Neon PostgreSQL (`DATABASE_URL`) | No | Production database; live branch acceptance has not yet passed. |

For the reproducible, no-API-key version, leave OpenRouter and Solari unconfigured. To use OpenRouter, set `OPENROUTER_API_KEY` before starting the server or connect OpenRouter in **Settings → Integrations** (the latter requires `APP_MASTER_KEY`). OpenRouter-backed text is model-generated and may vary. This walkthrough uses manager-entered text and one policy-only simulation, so Solari is not required.

## Scenario

Policy: verify the case, process refunds up to $500, and escalate requests above $500. The workspace seeds an active rule requiring manager approval for `payments.refund` amounts over $500.

1. In **Memory**, choose **Upload knowledge** and upload a UTF-8 text file named `refund-sop.txt` containing:

   ```text
   Refund SOP
   Verify the customer's case ID and purchase before processing a refund.
   Refunds of $500 or less may be processed after verification.
   Refund requests above $500 must be escalated to a manager.
   Do not issue an above-limit refund without approval.
   ```

2. In **Employees**, choose **Draft from job description**. Use title `Customer Support Specialist`, department `Support`, and manager notes such as: `Handle refund requests, verify customer cases, and escalate any request over the approved limit.` Select `refund-sop.txt`, create the draft, review it, and grant only **Issue a simulated customer refund** (`payments.refund`). Save the employee. Repeat with title/name `Finance Reviewer` and department `Finance`, using the same source and granting `payments.refund`. The compiler proposes a draft; the manager reviews the spec and explicitly selects tool grants.

3. In **Probation**, choose **Create simulation** and enter:

   - Name: `Refund above limit`
   - Description: `Escalate a $1,000 refund request under the $500 workspace limit.`
   - Tool: `payments.refund`
   - Expected decision: `REQUIRE_APPROVAL`
   - Criterion: `Escalates refunds over $500`
   - Amount: `1000`
   - Pass threshold: `1` (the numeric field uses a 0-to-1 scale; `1` is 100%)

   Save the suite. Open it with **Run suite**, select each employee in turn, and run probation. Open **Evidence** for each result.

4. Confirm each run records a matched `payments.refund` action, expected and observed decision `REQUIRE_APPROVAL`, and a passing score. The simulation evaluates the policy decision; it does not issue a refund. With no OpenRouter key, the planner uses the saved action as a fixture, making this check deterministic. With OpenRouter configured, the planner must reproduce the exact tool and input for the action to match.

5. From each employee record, choose **Deploy** after the current spec version has passed. This is required for meeting action items to start follow-up workflows if the meeting moderator assigns them.

6. In **Meetings**, choose **Schedule meeting**:

   - Title: `Refund policy case review`
   - Agenda: `Review case SIM-001: customer requested a $1,000 refund.` and `Confirm the $500 limit and the escalation decision.`
   - Participants: both employees

   Open the meeting. Choose **Prepare briefs**, then **Let agents discuss**, then **Start meeting**. Two participants are needed for the discussion step. Review the completed meeting’s briefs, messages, positions, and saved decision. Search **Memory** for `refund policy` to find the uploaded source and meeting record.

## Optional Solari browser and Jira UI exercise

This exercises the live browser interaction path; it is separate from the no-key walkthrough above.

1. Configure Solari and OpenRouter using the variables above or **Settings → Integrations**. In **Office map → Browser profiles**, create a profile, then open Solari Console → Profiles → Open editor to sign in to Jira and save the session. Do not put passwords or tokens in a task prompt.
2. Create a test Jira project and issue type for this exercise. Give a deployed test employee the `solari.browser.open` and `solari.browser.interact` grants, assign the saved browser profile, and keep the default manager-approval policy for browser interactions.
3. Submit a task using the test project's Jira issue URL and ask the employee to create a clearly named test issue. The plan should open the project first, then use bounded browser actions and finish with a visible-text assertion. Review and approve the interaction when prompted.
4. Confirm the resulting issue key is visible in the task evidence, then open **Replay** or **Watch browser** as a manager to review the recorded session.
5. Separately, configure Jira OAuth and select the test project in **Settings → Integrations** to exercise the existing `jira.create_issue` API tool and its read-back verifier.

## Optional recorded Solari desktop command

This covers the report's recorded shell command gate. It requires `SOLARI_API_KEY` or a Solari key saved in **Settings → Integrations**.

1. In **Office map → Live environments**, start a **Linux desktop VM**. Desktop environments are created with Solari recording enabled.
2. Give a deployed test employee the `solari.desktop.exec` grant and submit `Run echo hello in the desktop terminal.` Review any manager approval request.
3. Confirm the task output contains `hello`, then stop the desktop environment so its recording is finalized.
4. As a manager, open **Office map → Live environments → Replay** for that stopped desktop. The task row's **Review evidence** link also redirects to the recording after the desktop has stopped.

Headless `solari.sandbox.echo` remains audited input/output evidence; the installed Solari SDK rejects recording for headless sandboxes. Use a desktop session when visual command playback is required.

## Expected result and limits

- Two versioned employee specs and two passing probation runs are visible; both employees can be deployed.
- The policy-only simulation records a `REQUIRE_APPROVAL` decision for the $1,000 request. The `payments.refund` tool is a simulated ledger tool, never a payment processor.
- In the no-key fallback, the meeting saves participant positions and a generic agenda-summary decision. Briefs and messages also use fallbacks, and the moderator creates no follow-up actions. With OpenRouter, generated meeting content can vary. A follow-up workflow appears only when the moderator returns an action assigned to a deployed participant.
- The demo is a manual local walkthrough, not evidence that the report’s live gates passed. Solari launch speed, browser interaction/replay, PostgreSQL, Jira, Pinecone, concurrency/stress, and deployment acceptance remain separate checks. Browser interactions are bounded and manager-approved; live Jira UI execution still needs to be demonstrated with configured credentials and a test project.

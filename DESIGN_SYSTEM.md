# CrewOS interface

CrewOS is a workspace for defining AI employee roles, evaluating them in probation, deploying approved versions, and reviewing their work. The interface puts task outcomes, approval decisions, and evidence before the office visualization.

## Visual system

- The interface uses white surfaces on a cool gray canvas, near-black text, and restrained cobalt for primary actions and active states. The key light tokens are `--text: #17181b`, `--page: #f3f4f6`, `--surface: #fff`, `--border: #e2e4e8`, and `--accent: #335cff`.
- Dark mode is a separately tuned palette: `--text: #f3f4f6`, `--page: #111215`, `--surface: #1a1c20`, `--border: #343740`, and `--accent: #8ba4ff`. Statuses use matching green, amber, and red foreground/background pairs in both themes.
- The workspace header follows the operating-system appearance on first visit. The appearance control stores an explicit light or dark choice in local storage and updates the document color scheme for native controls.
- Instrument Sans is used for interface copy, Bricolage Grotesque for display headings, and IBM Plex Mono for versions, times, references, and code. Font files and licenses are kept in `frontend/src/assets/fonts` and loaded locally.
- Employee emblems use one of six stable geometric marks derived from the employee identity. The same paths render in the UI and the Konva office map. Human coworkers retain their own avatar treatment.
- Controls use readable labels and visible keyboard focus. Statuses pair color with text and a symbol. Layouts reflow for smaller screens rather than creating page-level horizontal scrolling.

Design tokens are in `frontend/src/styles/tokens.css`; shared primitives are in `frontend/src/components/ui.jsx`. `frontend/src/styles.css` imports the base, shell, component, record, studio, and responsive style sheets in order.

Route views, the office canvas, markdown renderer, and setup walkthrough are loaded as separate bundles. During Vite development, `/api`, `/mcp`, `/live`, and `/vendor/novnc` are proxied through the backend ingress on port 4173.

## Pages

| Area | Views |
| --- | --- |
| Authentication | Sign in, workspace creation, invitation acceptance, email verification |
| Setup | Role, required connections, probation, deployment, optional company context, task review walkthrough |
| Overview | Reviews, work in progress, recent results, team, activity |
| Employees | Search and status filters; card and list views; Role, Access, Probation, History |
| Hire / edit role | Role, Responsibilities, Access, Probation and review, live role preview |
| Tasks | Searchable task list; result document, sources, actions, chronological activity, technical details |
| Probation | Employees, Scenarios, Run history |
| Knowledge | Search, Sources with extracted text preview, Notes |
| People | Directory, Relationships, Messages and delegation requests |
| Meetings | List; Agenda, Private briefs, Discussion, Decisions and actions |
| Office | Map, Team, Sessions with an in-app desktop viewer |
| Integrations | Workspace apps, Browser logins, MCP servers |
| Reports | Usage, Activity, Operations |
| Settings | Workspace, Members, Policies, API access |

Tab selections, task selection, and list filters use hash query parameters. Older task links using `?task=` still open the task. Existing endpoint permissions remain enforced on the server.

## Interaction and motion

- Employee editing is a full page flow. Changes create a new role version. Unsaved role changes prompt before leaving and survive background refreshes.
- Deployment readiness comes from the same evidence gate used by the deploy endpoint. Passing evidence for an older role version is shown as historical.
- Tool choices show backend availability and the reason setup is required. Unsupported tools cannot be added through the editor.
- Scenario actions use the tool input schema. Complex inputs, initial state, and events retain an advanced JSON editor. Policy conditions have typed comparison fields and an advanced editor.
- Approvals display the pending request's actual tool and input. The request's exact approval identifier is sent back to the server.
- Form failures keep values in place and show an inline error. Error notifications remain until dismissed. Async action buttons prevent repeat clicks while pending.
- Imports and other background operations announce their progress. Durable attempts and failures remain available under Reports → Operations.
- Browser profiles are described as saved profiles, without claiming that sign-in has been verified.
- The live viewer is read only. Reconnect reopens the existing stream; it does not provision another VM. Closing releases the frame polling and noVNC connection.
- Radix provides dialogs, tabs, tooltips, and menus. The mobile navigation uses an accessible modal sheet. The office map has a corresponding Team list and editable layout fields.
- Motion uses short, interruptible feedback for controls and page transitions. The optional setup walkthrough uses scoped GSAP ScrollTrigger while native scrolling stays in control. Interactions respect reduced-motion preferences and clean up on unmount. The office does not animate idle employees continuously.

## Local review

The frontend build and source checks are:

```sh
npm run build
npm run check:source
```

The layouts can be reviewed in a local workspace at desktop and mobile widths, in both themes. A local fixture without provider credentials can confirm interface states and navigation; real Slack OAuth, Jira writes, Solari streams, and hosted model requests require configured services and must be checked separately.

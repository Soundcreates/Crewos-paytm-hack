# Twilio WhatsApp connection

Implementation: real signed inbound webhooks → durable tenant-bound inbox → deployed employee workflow → editable reply draft → explicit manager send. Once the voice interview creates both Sales and Support employees, CrewOS automatically assigns the sender to both. Sales and Customer Service share the inbox; each new message is assigned to the active agent selected for its intent. The role name/title/department must identify Sales and Support/Customer Service. This makes no Twilio API call. Existing Simulation remains separate.

Backend environment variables:

- `TWILIO_ACCOUNT_SID`: account owning the sender (`AC…`).
- `TWILIO_AUTH_TOKEN`: that account's auth token, used by the official Twilio SDK for signature verification and outbound authentication. Never expose it to the browser.
- `TWILIO_WHATSAPP_FROM`: approved sender, including `whatsapp:` and E.164 number.
- `TWILIO_WHATSAPP_PUBLIC_URL`: externally reachable HTTPS **origin**, for example `https://crewos.example.com` (no path/query). Set this explicitly behind tunnels/proxies; Host and forwarded headers are not trusted for signature verification.

The first three variables were present in backend/.env at implementation time. The public URL variable is configured for the current development tunnel. No credentials were printed or changed. Existing model credentials and a running workflow worker are also required for generated drafts; generation fails explicitly when unavailable.

The fixed CrewOS connection ID is `twilio-whatsapp-default`. The webhook is displayed in Integrations after binding the sender to an employee, and is:

```
https://<TWILIO_WHATSAPP_PUBLIC_URL host>/api/twilio/whatsapp/webhook/twilio-whatsapp-default
```

Copy that complete displayed URL into Twilio Console's WhatsApp Sandbox settings **When a message comes in**, method **POST**, or the approved WhatsApp sender's incoming-message webhook. Use the exact URL without query parameters or redirects. No connection ID or public deployment hostname is invented here. HTTPS must have a trusted certificate. A local tunnel must forward this path to the backend; update the environment and Console if the tunnel origin changes.

Sandbox users must first send `join <sandbox code>` to the Console's sandbox number. The sandbox sender must match `TWILIO_WHATSAPP_FROM`. Production requires a registered, approved WhatsApp Business sender; an arbitrary SMS-capable Twilio number is insufficient. Sandbox messages can incur charges. See [Twilio Sandbox](https://www.twilio.com/docs/whatsapp/sandbox) and [WhatsApp quickstart](https://www.twilio.com/docs/whatsapp/quickstart).

Signatures use the official Twilio SDK over the configured externally visible URL and every form field. Requests must also match the configured account, recipient and globally unique connection binding. One server sender belongs to one workspace. MessageSid has a durable unique constraint; workflow submission uses a stable idempotency key. Duplicate delivery never refreshes the customer's reply window. The authorizing manager must retain manager access. Disconnect rejects further inbound processing and sends; reconnect within the same tenant can reassign the employee.

Inbound customer messages authorize service responses only. STOP/OptOutType STOP blocks drafts and replies; ordinary messages do not clear STOP. START/YES/UNSTOP or OptOutType START clears it. Replies are limited to 24 hours after the latest accepted customer message. Business-initiated messages, templates and marketing opt-in collection are unsupported. See [Twilio WhatsApp concepts](https://www.twilio.com/docs/whatsapp/key-concepts) and [request validation](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

Clicking **Send real WhatsApp reply** is the only provider-send path. The server requires manager access and explicit `confirmLiveSend:true`, derives both numbers from persisted verified data, and claims a reply attempt before contacting Twilio. An API acceptance is recorded as accepted, never delivered. Uncertain failures remain blocked for manual inspection in Twilio logs; there is no automatic send retry. One reply attempt is allowed per inbound message. No calls are implemented.

Drafts run as `twilio-draft-v1` workflows using the employee role, with no tools, store/customer lookup or transaction capabilities. They cannot execute customer instructions. Managers must review factual claims and may edit drafts. This is assisted customer service, not unattended auto-reply. Media is not downloaded or transcribed; review media-only messages manually. No delivery callbacks, conversation memory, template sends, inbox pagination beyond the latest 100, or automated retention policy are implemented. Inbox text and sender numbers are stored in the application database; use existing access controls and an appropriate data-retention policy before production.

Verified locally: official SDK signature fixtures, modified URL/body rejection, durable MessageSid deduplication, tenant/account/number binding, manager-authorized explicit sending with mocked transport, unknown-send retry fencing, STOP and 24-hour checks. `node --test test/twilio-whatsapp.test.mjs` and `npm run build` were run. No live Twilio calls, messages, browser testing or live LLM requests were performed. Live webhook reachability, number approval, sender enrollment and delivery remain deployment checks.

# Daymap connector for Claude

An [MCP](https://modelcontextprotocol.io) server that connects Claude to your school's
**Daymap family portal** with your own parent login. You can then ask things like:

- "What does Alex have on tomorrow, and is there any homework?"
- "Are any assessment tasks due in the next fortnight? How did the last English task go?"
- "Summarise this term's attendance and any absences that haven't been explained."
- "Have there been any new messages or notices from the school this week?"
- "Let the school know Alex is sick today." / "Reply to Ms Perkins to say thanks."

It reads everything a parent can see in the portal, and when you ask, it can act for you:
mark messages and notifications read, archive messages, reply to or send messages, fill in
forms, give or decline excursion consent, and book or cancel parent-teacher interviews. The
tools that change things are marked as such, so Claude asks before using them. **It never
makes payments:** writes to Daymap's payment endpoints are always refused.

## Tools

Reading:

| Tool | What it does |
| --- | --- |
| `daymap_students` | The students linked to your account, and your own details. |
| `daymap_timetable` | A student's lessons, tasks, events, excursions and interviews between two dates. |
| `daymap_lesson` | One lesson: teacher, room, attendance, and the lesson plans/homework shared with families. |
| `daymap_attendance` | Attendance rates by class, and the days with late arrivals or absences. |
| `daymap_assessment` | A student's assessment tasks: dates, status and descriptions. |
| `daymap_assessment_task` | One task's details, results and feedback once published, and its rubric. |
| `daymap_notices` | School notices. |
| `daymap_messages` | Your messages by folder, or a search. |
| `daymap_message_thread` | One message or notice with its whole thread. |
| `daymap_notifications` | Your notification timeline (points, absences, results, messages…). |
| `daymap_calendar` | School calendar events and a student's diary items. |
| `daymap_message_recipients` | Which kinds of message your school lets parents send, and to whom. |
| `daymap_records` | Forms and records for a student, with the fields needed to fill them in. |
| `daymap_excursion` | An excursion's details and consent status. |
| `daymap_interviews` | Parent-teacher interview rounds, slots and teachers. |
| `daymap_api_get` | Any other family portal API endpoint (e.g. classes, house points, reports). |

Changing things (Claude asks first):

| Tool | What it does |
| --- | --- |
| `daymap_mark_messages_read` | Mark messages read or unread. |
| `daymap_archive_messages` | Archive messages (or restore archived ones). |
| `daymap_mark_notifications_read` | Mark one or all notifications read. |
| `daymap_reply_to_message` | Reply in a message thread, where Daymap allows replies. |
| `daymap_send_message` | Send an absence notification, a message to the school, or a message to a teacher or your child, as far as your school allows. |
| `daymap_save_form_record` | Fill in or update a form, optionally submitting it. Payment fields are refused. |
| `daymap_excursion_consent` | Give, decline or withdraw excursion consent. |
| `daymap_book_interview` / `daymap_cancel_interview` | Book or cancel a parent-teacher interview. |
| `daymap_api_request` | Any other POST/PUT/PATCH/DELETE to the family portal API, except payments. |

Responses are rendered as compact YAML-style text. Empty values and Daymap's "no date"
placeholder are left out, HTML (message bodies, notices) becomes Markdown, and embedded images
become `[image]`. Lesson details leave out the class list, because it has other children's details.
Results are only shown once the school publishes them, as in the portal.

## Install

The connector is a remote MCP server (`src/http.ts`) that you host. Each parent signs in with
their own Daymap username and password when they connect it, and it acts as them. Once it's
running, add `https://your-host/mcp` as a custom connector:

- **Claude (web, desktop or mobile):** **Settings → Connectors → Add custom connector**, then
  click **Connect**.
- **Claude Code:** `claude mcp add --transport http daymap https://your-host/mcp`, then
  `/mcp` to sign in.

Connecting opens the connector's sign-in page. Enter your Daymap username and password there.

- MCP is served over Streamable HTTP at `/mcp`, protected by OAuth 2.1 with dynamic client
  registration. By default, only Claude's OAuth callback URLs can register as clients.
- Only the Daymap usernames in `ALLOWED_DAYMAP_USERS` can sign in. Anyone else is refused
  before anything is sent to Daymap. Removing a username cuts that parent off at their next
  request.
- Your password is sent only to Daymap, to sign in, and is never stored. The connector keeps
  the tokens Daymap issues, encrypted (AES-256-GCM) inside the OAuth tokens it gives Claude.
  The server keeps no sessions, so restarting it doesn't sign anyone out.
- When Claude refreshes its token, the connector refreshes the Daymap one. If Daymap refuses
  (its sign-in has expired or been revoked), you connect again. Changing
  `TOKEN_SIGNING_SECRET` signs everyone out.

Claude connects from Anthropic's cloud, so the server must be reachable over public HTTPS.

### Kubernetes (Helm)

CI publishes the image to `ghcr.io/johngrimes/daymap-connector` when you push to `main` or push
a `v*` tag. The chart's default image tag is its `appVersion`, so push a matching tag
(`v0.4.0`), or set `image.tag`. If the GHCR package is private, either make it public or set
`imagePullSecrets`.

```sh
helm install daymap charts/daymap-connector \
  --namespace daymap --create-namespace \
  --set publicUrl=https://daymap.example.com \
  --set daymap.url=https://yourschool.eq.daymap.net \
  --set 'connector.allowedDaymapUsers={your-username,other-parent}' \
  --set ingress.enabled=true,ingress.className=nginx,ingress.host=daymap.example.com \
  --set 'ingress.annotations.cert-manager\.io/cluster-issuer=letsencrypt' \
  --set 'ingress.tls[0].secretName=daymap-tls,ingress.tls[0].hosts[0]=daymap.example.com'
```

The chart generates `TOKEN_SIGNING_SECRET` and keeps it across upgrades. To supply your own,
set `secrets.tokenSigningSecret`, or create a Secret with the key `TOKEN_SIGNING_SECRET` and
pass `--set secrets.existingSecret=<name>`. See `charts/daymap-connector/values.yaml` for all
options.

### Without Kubernetes

```sh
docker build -t daymap-connector .
docker run -p 3000:3000 \
  -e PUBLIC_URL=https://daymap.example.com \
  -e DAYMAP_URL=https://yourschool.eq.daymap.net \
  -e ALLOWED_DAYMAP_USERS=your-username \
  -e TOKEN_SIGNING_SECRET="$(openssl rand -hex 32)" \
  daymap-connector
```

Put the container behind something that terminates TLS, and keep `TOKEN_SIGNING_SECRET` the
same across restarts.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | (required) | Public HTTPS address of the server |
| `ALLOWED_DAYMAP_USERS` | (required) | Comma-separated Daymap usernames that may sign in (case-insensitive) |
| `TOKEN_SIGNING_SECRET` | (required) | 32+ character key the token encryption key is derived from |
| `DAYMAP_URL` | (required) | Your school's Daymap site, e.g. `https://yourschool.eq.daymap.net` |
| `OAUTH_ALLOWED_REDIRECT_URIS` | Claude's callbacks | Comma-separated redirect URIs clients may register |
| `CONNECTOR_TITLE` | `Daymap` | Name on the sign-in page |
| `TRUST_PROXY` | `1` | Number of reverse proxies in front of the server |
| `PORT` | `3000` | HTTP port |

## How it works

The family portal (`/portals/family/`) is a single-page app. It gets all its data from a JSON
API under `/lms/api/`, using a Bearer token from Daymap's identity server. The connector does
the same thing server-side, for whoever signs in:

1. It asks the school site (`/daymap/dws/discover.ashx`) which identity server it uses, then
   reads that server's OpenID configuration.
2. When a parent submits the connector's sign-in page, it starts the authorisation-code flow
   with PKCE as the portal's own client (`Connect.API`), follows the redirects to the Daymap
   login form, and posts their username and password along with the form's anti-forgery token.
3. It catches the redirect back to the portal's callback URL and exchanges the code for an
   access token and a refresh token, which it seals into the authorisation code it returns to
   Claude.
4. Each MCP request carries Claude's access token. The connector unseals the parent's Daymap
   access token from it and calls `/lms/api/...` with that. Claude's access token expires just
   before the Daymap one, and refreshing it uses the Daymap refresh token.

The token is only ever sent to `/lms/api/` on the configured school host. Writes to
`/lms/api/payments/` are refused however the path is spelt. The generic read tool also
refuses the few GET endpoints that mark things read.

## Development

```sh
npm install
npm test        # runs against a local mock of the Daymap identity server and API
npm run build   # TypeScript → dist/
npm run bundle  # single-file server (dist/server.mjs)
```

## Status and limitations

- Signing in and the read tools have been run against a live family portal with a
  real parent account. Excursions and interviews had no data for that family, so those two
  read tools have only been seen returning "none".
- The write tools follow exactly the requests the portal itself sends, taken from its
  JavaScript. To avoid real side effects (messages to teachers, recorded consent), they're
  only tested against a mock. The first real use of each one is its first live run.
- What parents can do is set by each school. Disabled message types are refused before
  anything is sent; Daymap itself rejects the rest.
- Schools that sign in through Microsoft 365 instead of a Daymap username and password
  aren't supported.
- The allowlist matches the username exactly as typed (ignoring case). If Daymap accepts
  more than one form of the same login, list each form.
- How long a connection lasts depends on how long Daymap's refresh tokens last, which the
  connector doesn't control. When one expires, Claude asks you to connect again.

# Tandem Cowork staging

Cowork can use a dedicated Supabase project for Tandem accounts, private projects, invitations, and shared text files. The fixture preview remains available for UI review.

## Accounts

A Tandem account is a username and a password, like TeamDesk, and is separate from it and from any other account. Creating one needs nothing else: there is no email to confirm. Each account has a **Tandem address**, `username@tandem.org`. People find each other by it and send invitations inside the app. It isn't an inbox: nothing is ever sent to it.

Supabase Auth needs an email for each user, so the app stores each account as `<username>@accounts.tandem.invalid`. That domain can never receive mail, so nobody can reset a password or get a sign-in link through it. `tandem.org` isn't used for this because it's a real domain owned by someone else; whoever reads its mail could take over accounts. Set `VITE_TANDEM_ACCOUNT_DOMAIN` only if Supabase refuses the default, and then use a domain you own whose mail you control.

Usernames are 3 to 24 lowercase letters, numbers or `_`, starting with a letter. The database claims each username once. Passwords need at least 8 characters. A forgotten password can't be reset by email: a project admin sets a new one in the Supabase dashboard (Authentication → Users).

## Configure staging

1. Apply [the database migration](../supabase/migrations/001_tandem_cowork.sql) to a dedicated Tandem Supabase staging project with Auth enabled, in the SQL Editor. Keep `tandem_private` outside the API's exposed schemas (the default exposes only `public` and `graphql_public`).
2. In **Authentication → Sign In / Providers → Email**: keep **Enable email provider** on, turn **Confirm email** off, and set **Minimum password length** to 8. Keep **Allow new users to sign up** on (Authentication → Sign In / Providers). No email template or delivery set-up is needed.
3. Copy `.env.example` to `.env.local`. Set `VITE_COWORK_MODE=live`, `VITE_TANDEM_SUPABASE_URL`, and `VITE_TANDEM_SUPABASE_KEY`. Use only the publishable key in the app build. For CI builds, set the same three as repository variables (Settings → Secrets and variables → Actions → Variables).
4. Run `npm ci` and `npm run dev`. Open `/#/shared`, create an account and sign in. Then build both native clients using the same staging configuration: pushes to the `cowork` branch build Tandem Staging for Windows and the iPad `.ipa` as workflow artifacts.

New projects start empty. The owner invites a teammate by username or Tandem address; Share suggests matching accounts while typing. The invitation appears in the teammate's Shared Projects. Invitations stay in the app: nothing is emailed.

Both owners and members can create, upload, rename, and edit UTF-8 text files up to 1 MB. File removal and project archive require an owner. An account that isn't in a project can't open, read, or change it, even with its link.

### Running shared projects

Run, Step through, Debug and notebook cells work in shared projects, each on the member's own device, with that device's Python. Nothing runs on the server, and each person's runs and output are their own.

- **Windows**: the desktop app keeps a working copy of each shared project in its own data folder, `%APPDATA%\Tandem Staging\Shared\<project id>\` (the app's user data, `Shared/`). Before each run, notebook kernel start and notebook cell, Tandem writes the project's current text there (teammates' merged saves and this device's unsaved edits included; only files that changed) and deletes files removed from the project. Runs use the Python chosen for shared projects (the Python chip in the toolbar → Environment), else the default Python; it is one choice for all shared projects, separate from the device project's.
- **iPad**: the same, inside Pyodide: each project has its own folder, kept in the app's storage on the iPad. Packages installed for a device project aren't loaded for shared projects; Pyodide's own packages (numpy, pandas, matplotlib, …) load by themselves.
- Files a run creates (charts, output CSVs) stay in the working copy on this device and aren't uploaded. The Output says so once.
- Shared code was written by other people and runs with this person's permissions. The first run in each shared project on a device asks: "Code in <project> runs on this device with your permissions. Run it only if you trust its members." The answer is remembered for that project on that device; **Don't run** runs nothing (and asks again next time).
- Leaving or closing a shared project shuts down its notebook kernels and stops its run. Device projects and shared projects never share files, folders or kernels.

### Who's online and live cursors

Each shared project has one private Supabase Realtime channel, `cowork:<project id>`. Only the project's members can join it: Realtime Authorization checks the policies on `realtime.messages` from [002_cowork_realtime.sql](../supabase/migrations/002_cowork_realtime.sql), so a non-member (or a member removed later, or anyone once the project is archived) is refused. Nothing sent on the channel is stored.

- **Presence**: each member in the project shares their user id, username, the file they have open (and the notebook cell) and their colour. The avatars show who is online with a dot, and which file each person has open. Supabase limits presence updates per client (it closes the channel at about five in ten seconds), so presence is sent only when the file or cell changes, at most once every 5 seconds.
- **Cursors**: caret and selection moves go as broadcasts, at most 8 a second, and are drawn in the same file in that person's colour with their name. They are sent again when someone joins, after each presence update, and when you click back into a file. If the text changed around a position, the cursor goes to the nearest valid spot.
- **Staying connected**: the app stays in the channel while it is hidden for up to 2 minutes (switching apps, Stage Manager, a covered window), then leaves; a project closed is left at once. Anything the app didn't ask for (the server closing the channel, a network drop, a timeout) is rejoined after 1, 2, 5 and then every 15 seconds; a refused join (not a member, Realtime not set up) every 30 seconds.
- **Live indicator** next to the sync status: Live, Connecting…, Reconnecting… or Live unavailable, with the reason in its tooltip. The console logs joins, leaves and closes as `[cowork live]`; set `localStorage['tandem.coworkDebug'] = '1'` to log every cursor sent and received too.
- Typing itself travels as live typing (below), in every text file and in notebook cells.

Set up on a Supabase project (staging):

1. Run [002_cowork_realtime.sql](../supabase/migrations/002_cowork_realtime.sql) in the SQL Editor. It is additive: it adds a `cowork_realtime` schema with one function and two policies on `realtime.messages`, and can be run again. Don't run 001 again.
2. Realtime → Settings: turn off **Allow public access**, so only private channels can be joined.

Until both are done the app works as before, without the online dots and cursors (joining is refused, quietly, and retried every 30 seconds).

### Live typing

A teammate's typing shows as they type, letter by letter, in text files (`.py`, `.sql`, `.md`, `.csv`, `.txt` and the like). Each such file is edited through a shared [Yjs](https://github.com/yjs/yjs) document (a CRDT), so two people typing at the same time, even on the same line, end with the same text on both devices, with nothing lost or doubled.

- **Travelling**: edits go over the project's private Realtime channel (above), batched every 80 ms. A device that joins, or comes back after being offline, sends the others what it has and gets back exactly what it lacks, both ways; so offline typing merges when the connection returns. Very large edits (over about 150 KB at once) travel by saving instead.
- **Saving**: a live file is saved together with its document, in one step (`cowork_save_file_doc`, which calls `cowork_save_file`, so revisions, "edited by" and history are as before). Each person saves their own typing about a second after they stop; a teammate's edits are saved from here too if they haven't saved them a few seconds later. Someone saving first isn't a Conflict for live files: their saved document is merged in and this device saves again if needed. After a save the others are told, so they don't save the same edits again.
- **Opening**: a project's files start from their saved documents (`cowork_file_docs`). A file without one yet (created before live typing, or saved only by an older build) starts from its text in the same way on every device, after giving the others a moment to send theirs, so opening it on two devices at once doesn't double it.
- **In the editor**: teammates' edits go straight into the editor; your caret and selection stay on the text they were on, and someone typing at your caret goes after it. Undo and redo (Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y) take back only your own typing.
- **Notebooks** (`.ipynb`) are typed live cell by cell: each cell's code is its own live text (letters both ways, carets kept, teammates' names at their carets), and adding, removing or moving a cell, changing its type and running it (outputs, sent at most every 300 ms) show up for everyone at once. Typing in a cell a teammate removed meanwhile goes with the cell. Checked by `supabase/tests/notebook-live-e2e.cjs` and the notebook cases in `liveText.test.mjs`.
- **Not live**: database files, and everything when the server doesn't have 003, keep the save-based sync below, with Conflict and Use theirs / Keep mine. Live typing can be turned off on a device with `localStorage['tandem.coworkLiveTyping'] = 'off'`, and `localStorage['tandem.coworkDebug'] = '1'` logs every live message sent and received.
- **Older builds**: a build without live typing saves plain text; a newer build brings the document up to date from it. If someone with an older build edits a file while others type in it live, those devices may show a Conflict for it. Everyone should update.

Set up on a Supabase project (staging), after 002:

1. Run [003_cowork_live_text.sql](../supabase/migrations/003_cowork_live_text.sql) in the SQL Editor. It is additive: one table (`cowork_file_docs`, no direct access from the API), two functions (`cowork_save_file_doc`, `cowork_file_docs`, members only) and a trigger that renames and removes a file's document with it. It can be run again. Don't run 001 again.

Until it is done, the app works as before (no live typing).

### Staying in step

An open project reloads every 10 seconds while the app is visible, when its window gets focus or becomes visible again (including an iPad coming back to the app), and when the network returns. It doesn't reload while the app is hidden. Shared Projects reloads every 30 seconds and on focus, so invitations appear without **Refresh**. Each file is merged by its revision:

- A teammate saved a newer version and this device has no edit in that file: the new text replaces it in place (the cursor stays) with a short note, "wei saved Test.py". Files a teammate created, renamed or removed appear, move or close. People, invitations, roles and the project name update too.
- A teammate saved a newer version while this device has an unsaved edit: nothing is overwritten. The status shows **Conflict** and the file shows "wei saved a newer version" with **Use theirs** (take their text) and **Keep mine** (save this device's text over theirs). A save refused because someone saved first ends up in the same Conflict.
- No connection: the status shows **Offline**, edits stay on this device and are saved when the connection is back (or with **Retry**). **Unsaved** is left for other failures; copy the draft if one persists.

The status reads Saved, Saving…, Offline, Unsaved or Conflict. This is how files that aren't typed live (database files, or all files without 003) stay in step; live typing (above) and cursors work alongside it. No database change is needed for this part; it uses `cowork_project`.

### Sharing an AI with the project

An owner can share their AI with a project, so teammates without an AI subscription can use the assistant: **Share → AI for everyone → Share your AI**. Choose Anthropic (Claude) or an OpenAI-compatible provider, the model, the API key, requests per person per day (1 to 1000), requests per day for the whole project (1 to 10000) and, optionally, **Also allow**: the owner's own rules in plain words. The owner who shared it has no limit. **Change** updates any of it (leave the key empty to keep it); **Stop sharing** deletes the key.

- **The key stays on the server.** It goes to Supabase once and never comes back: not to members, not to the owner (who sees its last 4 characters). The tables have no API access at all; `cowork_ai_use`, the only function that returns the key, can be called only with the service role, by the Edge Function.
- **Only Tandem's assistant for this project.** The `cowork-ai` Edge Function writes the instructions itself: the app only names a mode (`python` on Windows and Mac, `ipad` on iPad), and a caller's own instructions or messages are ignored. Every mode carries the topic rule (help with this project's code and data; politely decline anything else), then the owner's **Also allow**. The files come from the project, read on the server; a request about a file that isn't saved in the project, or about no file, is refused (the app saves pending edits before asking). Sizes are capped: the question (4000 characters), the last 8 earlier messages (2000 characters each), the run output (last 4000 characters) and the answer (8000 tokens). Refused requests don't count.
- **Limits and visibility.** Requests per person and per project per day (UTC); a request the provider fails doesn't count. Owners see, in Share, requests per person today and in the last 7 days (counts only: what people ask isn't kept). Members see their own count. Anyone with their own AI connected keeps using theirs.
- **New abilities** are new modes in `supabase/functions/cowork-ai/index.ts` (and an app version that uses them); deploy the function again after changing it. Smaller changes need no code: the owner's **Also allow**.
- **Recommended:** give Tandem its own API key with a monthly spend limit (Anthropic Console: a separate workspace with a limit), so the cost can't exceed it whatever happens, and the key can be revoked without touching any other.

To turn it on (once):

1. Run [004_cowork_shared_ai.sql](../supabase/migrations/004_cowork_shared_ai.sql) in the SQL Editor (additive, safe to run again, also over an earlier version of it).
2. **Edge Functions → Deploy a new function → Via Editor**: name it `cowork-ai`, paste [supabase/functions/cowork-ai/index.ts](../supabase/functions/cowork-ai/index.ts), and deploy. In the function's settings turn **Verify JWT** off: the function checks the sign-in itself (this also works with the new API keys). It needs no secrets of its own.

Checked by `supabase/tests/shared-ai-api.mjs` (the access rules, the locked instructions and files, the caps and limits, with a fake provider) and `supabase/tests/shared-ai-e2e.cjs` (sharing from Share, a teammate's assistant using it, the daily limit, the owner's usage list, stopping), both against the local stand-in, which runs the same function file.

## Acceptance

Test with two real accounts and the Windows and iPad packages. On Windows, create the owner account and a private project; on iPad, create the member account. Invite the member by username, join, add a file, save an edit, close both apps, and sign in again to reopen the file. Then remove the member from the project and verify that its access is denied.

The sync checks run against the local stand-in or staging (`supabase/tests/sync-e2e.cjs`, two accounts in two browser contexts): a teammate's save shows up within 10 seconds, a Conflict ends in Saved with either choice, and an edit made offline is saved when the connection returns. The merge rules have unit tests (`npm run test:cowork-merge`). Running shared projects is checked by `supabase/tests/run-e2e.cjs` (A on the desktop runtime or the iPad build, B saving a change A's Run then uses; the confirmation; a notebook cell; Step through) and the runtime's `tests/test_shared.py` (working copies, imports between project files, kernels). Presence and cursors are checked by `supabase/tests/presence-e2e.cjs` (two accounts: a cursor within 1 second, switching files, hiding and closing; a non-member's join refused) against the stand-in, which includes Realtime and runs the same policies, and by a database test of the policies (`npm run test:cowork-db`).

Live typing is checked by `supabase/tests/live-typing-e2e.cjs` (two accounts: letters arrive as typed; both typing on the same line end the same, without Conflict; reopening after saving shows the text once; offline typing merges; undo is per person; a file opened by both before it had a document isn't doubled; new files are live; a 50 KB paste arrives), by unit tests of the documents (`src/cowork/live/liveText.test.mjs`, in `npm run test:cowork-merge`), and by database tests of 003 (`supabase/tests/live-text.test.mjs`, in `npm run test:cowork-db`).

**Staying signed in.** The sign-in page has **Keep me signed in on this device** (on by default). The session is then kept between launches: encrypted by the operating system on Windows and Mac (Electron safeStorage, `desktop/secureStore.js`), in the iPad Keychain on iPad (`ipad/App/Sources/SecureStore.swift`, through the app's local server), in localStorage in a browser. Without it the session lives in memory only. Signing out forgets it on this device only (other devices stay signed in). A kept sign-in the server no longer accepts is forgotten at the next launch. Staging builds (`VITE_COWORK_START=shared`) open on the projects page: your shared projects and invitations, and this device's project under **On this device**. Checked by `supabase/tests/session-e2e.cjs`.

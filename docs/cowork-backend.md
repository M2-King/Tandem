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
- Typing still travels by saves: a teammate's saved text arrives with the 10-second sync (above). Live simultaneous typing is not part of this.

Set up on a Supabase project (staging):

1. Run [002_cowork_realtime.sql](../supabase/migrations/002_cowork_realtime.sql) in the SQL Editor. It is additive: it adds a `cowork_realtime` schema with one function and two policies on `realtime.messages`, and can be run again. Don't run 001 again.
2. Realtime → Settings: turn off **Allow public access**, so only private channels can be joined.

Until both are done the app works as before, without the online dots and cursors (joining is refused, quietly, and retried every 30 seconds).

### Staying in step

An open project reloads every 10 seconds while the app is visible, when its window gets focus or becomes visible again (including an iPad coming back to the app), and when the network returns. It doesn't reload while the app is hidden. Shared Projects reloads every 30 seconds and on focus, so invitations appear without **Refresh**. Each file is merged by its revision:

- A teammate saved a newer version and this device has no edit in that file: the new text replaces it in place (the cursor stays) with a short note, "wei saved Test.py". Files a teammate created, renamed or removed appear, move or close. People, invitations, roles and the project name update too.
- A teammate saved a newer version while this device has an unsaved edit: nothing is overwritten. The status shows **Conflict** and the file shows "wei saved a newer version" with **Use theirs** (take their text) and **Keep mine** (save this device's text over theirs). A save refused because someone saved first ends up in the same Conflict.
- No connection: the status shows **Offline**, edits stay on this device and are saved when the connection is back (or with **Retry**). **Unsaved** is left for other failures; copy the draft if one persists.

The status reads Saved, Saving…, Offline, Unsaved or Conflict. Live co-editing (typing together, cursors) isn't part of this: changes arrive per save. No database change is needed for this; it uses `cowork_project`.

## Acceptance

Test with two real accounts and the Windows and iPad packages. On Windows, create the owner account and a private project; on iPad, create the member account. Invite the member by username, join, add a file, save an edit, close both apps, and sign in again to reopen the file. Then remove the member from the project and verify that its access is denied.

The sync checks run against the local stand-in or staging (`supabase/tests/sync-e2e.cjs`, two accounts in two browser contexts): a teammate's save shows up within 10 seconds, a Conflict ends in Saved with either choice, and an edit made offline is saved when the connection returns. The merge rules have unit tests (`npm run test:cowork-merge`). Running shared projects is checked by `supabase/tests/run-e2e.cjs` (A on the desktop runtime or the iPad build, B saving a change A's Run then uses; the confirmation; a notebook cell; Step through) and the runtime's `tests/test_shared.py` (working copies, imports between project files, kernels). Presence and cursors are checked by `supabase/tests/presence-e2e.cjs` (two accounts: a cursor within 1 second, switching files, hiding and closing; a non-member's join refused) against the stand-in, which includes Realtime and runs the same policies, and by a database test of the policies (`npm run test:cowork-db`).

Live-mode sessions are in memory for this milestone, so restarting the app requires sign-in. Secure native session persistence and live co-editing are pending.

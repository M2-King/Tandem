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

Both owners and members can create, upload, rename, and edit UTF-8 text files up to 1 MB. File removal and project archive require an owner. Each file save checks its revision. A failed save keeps the edit in the open app and shows **Unsaved**. Copy the draft before closing the app if the save still fails. Use **Refresh** on Shared Projects to check for new invitations. An account that isn't in a project can't open, read, or change it, even with its link.

## Acceptance

Test with two real accounts and the Windows and iPad packages. On Windows, create the owner account and a private project; on iPad, create the member account. Invite the member by username, join, add a file, save an edit, close both apps, and sign in again to reopen the file. Then remove the member from the project and verify that its access is denied.

Live-mode sessions are in memory for this milestone, so restarting the app requires sign-in. Secure native session persistence, live co-editing, and wiring the shared project to each device's Python runtime are pending. Cowork live mode blocks sample runs. The regular local-project runtime stays available in the installed apps.

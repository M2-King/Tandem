# Tandem Cowork staging

Cowork can use a dedicated Supabase project for account sign-in, private projects, invitations, and shared text files. The fixture preview remains available for UI review.

## Configure staging

1. Apply [the database migration](../supabase/migrations/001_tandem_cowork.sql) to a dedicated Tandem Supabase staging project with Auth enabled. Keep `tandem_private` outside the API's exposed schemas.
2. Configure the Auth email sign-in template to include `{{ .Token }}` and set a six-digit OTP. Configure email delivery for the test accounts. [Supabase email OTP setup](https://supabase.com/docs/guides/auth/auth-email-passwordless)
3. Copy `.env.example` to `.env.local`. Set `VITE_COWORK_MODE=live`, `VITE_TANDEM_SUPABASE_URL`, and `VITE_TANDEM_SUPABASE_KEY`. Use only the publishable key in the app build.
4. Run `npm ci` and `npm run dev`. Open `/#/shared` and sign in with a test account. Then build both native clients using the same staging configuration.

New projects start empty. The owner can invite a teammate by verified email. The invitation appears in Shared Projects when the teammate signs in. Project invitations are in-app; sign-in codes use the Auth email service.

Both owners and members can create, upload, rename, and edit UTF-8 text files up to 1 MB. File removal and project archive require an owner. Each file save checks its revision. A failed save keeps the edit in the open app and shows **Unsaved**. Copy the draft before closing the app if the save still fails. Use **Refresh** on Shared Projects to check for new invitations.

## Acceptance

Test with two real accounts and the Windows and iPad packages. Create a private project, invite the second account, join, add a file, save an edit, close both apps, and sign in again to reopen the file. Then remove the second account from the project and verify that its access is denied.

Live-mode sessions are in memory for this milestone, so restarting the app requires sign-in. Secure native session persistence, live co-editing, and wiring the shared project to each device's Python runtime are pending. Cowork live mode blocks sample runs. The regular local-project runtime stays available in the installed apps.

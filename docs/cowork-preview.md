# Tandem Cowork: Phase 1 UI prototype

Shared projects inside Tandem, built from the existing editor, file list and
notebook UI. Everything is sample data: no account, server, sync or Python
runs behind it.

## Run it

```sh
npm install
npm run dev            # then open http://localhost:5173/#/shared
```

A review build that opens on Shared projects (as the published preview does):

```sh
VITE_COWORK_START=shared npx vite build --base ./
npx vite preview
```

## What's in it

- **Sign in**: email and a 6-digit code (preview code `246810`), or a sample
  person (Wei Lin, owner; Sara Kim, invited).
- **Shared projects**: invitations (Join / Decline), your projects and role,
  an empty state, New shared project, archived projects, this device's project.
- **Workspace**: the usual layout with a teammate's cursor in code, a
  collaborator on a notebook cell, people, Saving / Saved / Reconnecting,
  "Runs on this device"; Run, Stop and Restart give prepared sample results.
- **Share**: owners, members, pending invitations; invite, roles and removal
  for owners; a read-only member view.
- **Project settings**: rename and archive (owners), and who can do what.
- **Files**: upload (text, up to 1 MB), rename (F2), remove (owners, Delete).
- **Motion** for sign-in and joining; none with "Reduce motion".
- The **Preview** badge marks sample data and can simulate a dropped
  connection, switch person, or reset the preview.

| Action | Owner | Member |
|---|---|---|
| Open and edit files and notebooks | ✓ | ✓ |
| Run Python on their own device | ✓ | ✓ |
| Create, upload and rename files | ✓ | ✓ |
| Remove files | ✓ | – |
| Invite people and change roles | ✓ | – |
| Rename or archive the project | ✓ | – |

## Where the code is

- `src/cowork/`: state (`useCowork.js`), sample data (`fixtures.js`), the
  sample "this device" runner (`coworkBackend.js`), teammate cursors
  (`remoteCursors.js`) and the screens and dialogs.
- Small additions to `App.jsx`, the toolbar, rail, file list, editor,
  notebook, results panel and `useExecution.js`.

## Live mode

`VITE_COWORK_MODE=live` connects the same screens to a Supabase staging
project: see [cowork-backend.md](cowork-backend.md). Without it the app shows
this preview.

### Testing live mode without a staging project

`supabase/tests/local-supabase.mjs` stands in for Supabase's sign-in and API
on a local Postgres, running the real migration and access rules (codes are
read from `/__test/code?email=…` instead of email):

```sh
# Postgres on 127.0.0.1:54329, then:
createdb -h 127.0.0.1 -p 54329 -U postgres cowork_e2e
psql -h 127.0.0.1 -p 54329 -U postgres -d cowork_e2e -f supabase/tests/local_auth_stub.sql
psql -h 127.0.0.1 -p 54329 -U postgres -d cowork_e2e -f supabase/migrations/001_tandem_cowork.sql
COWORK_TEST_DB=postgres://postgres@127.0.0.1:54329/cowork_e2e npm run cowork:local
VITE_COWORK_MODE=live VITE_TANDEM_SUPABASE_URL=http://127.0.0.1:54400 \
  VITE_TANDEM_SUPABASE_KEY=local npm run dev
```

The database access rules have their own tests:
`COWORK_TEST_DB=postgres://…/cowork_test npm run test:cowork-db` (a database
with the stub and the migration applied).

Still to come: live editing between people, keeping sessions across app
restarts, and running shared projects with each device's Python.

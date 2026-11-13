# Звънец · how it works inside

For the people who change the code. What the app does is in [README.md](README.md).

A static PWA (GitHub Pages) with a Supabase backend (database, logins, push).

## Where things are

| Path | What it is |
|---|---|
| `src/app.js` | The app itself (views, editing, push, import) |
| `src/style.css` | All styles |
| `src/boot.js` | Loads the data from Supabase, crash reporting, starts the app |
| `src/shell.html` | The HTML around them (meta tags, Content-Security-Policy) |
| `index.html` | **Generated** from `src/` — don't edit it by hand |
| `lib.js`, `sw.js`, `config.js`, `manifest.webmanifest` | Shared helpers, service worker, Supabase address, PWA manifest |
| `supabase/migrations/` | Database changes, numbered in the order they were run |
| `supabase/functions/` | Edge Functions (`push`, `calendar`) |
| `tests/` | Automated tests (fake Supabase, real browser) |

## Changing the app

1. Edit files in `src/`.
2. Run `python3 tools/build.py` to regenerate `index.html` (it also recalculates the script hashes in the Content-Security-Policy, so never skip it).
3. Bump `VERSION` in `sw.js` so phones pick up the new version.
4. Run the tests: `python3 -m pytest -q tests`
5. Commit and push. GitHub runs the same tests on every push (Actions tab).

First time only: `pip install pytest playwright && python3 -m playwright install chromium`

## Changing the database

Add a new file `supabase/migrations/NNN_short-name.sql` with the next number, write it so it can be run twice safely (`if not exists`, `create or replace`), and run it in Supabase → SQL Editor.

`bash tools/db-check.sh` applies every migration twice to a throwaway local Postgres; GitHub runs it on every push too.

`000_base.sql` was rebuilt from the app code because the original `schema.sql` was never committed. The live database already has these tables; the file is for setting up a new database.

## Crash reports

JavaScript errors on users' phones are sent to the `reports` table with class **JS**, so they show up in the admin's report list. At most 3 per session, and each message once per day per device.

# Lit Radar

A free, no-login website where you and your colleagues register a research project once, and get a monthly email with the ~10 most relevant new papers from Semantic Scholar, arXiv, and PubMed. Ranking uses free local embeddings — no paid API required to run.

Everything is already written. You just need to connect it to your own free accounts. About 20–30 minutes total.

## 1. Create three free accounts

- **[GitHub](https://github.com)** — hosts the code and runs the monthly job for free
- **[Supabase](https://supabase.com)** — free database that stores registered projects
- **[Resend](https://resend.com)** — free email sending (100/day, 3,000/month)

## 2. Set up the database

1. In Supabase, create a new project (pick any name/password/region).
2. Go to **SQL Editor → New query**, paste the contents of `schema.sql`, click **Run**.
3. Go to **Project Settings → API**. You'll need two values from here:
   - **Project URL**
   - **anon public** key (safe to expose in the website)
   - **service_role** key (keep secret — only used by the monthly job)

## 3. Connect the signup website

Open `index.html`, find these two lines near the bottom, and replace them with your real values from step 2:

```js
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

## 4. Put the code on GitHub

1. Create a new **public** repository on GitHub (public repos get more free Actions minutes; private also works fine at this scale).
2. Upload all these files to it (drag-and-drop on GitHub's web UI works, or `git push` if you're comfortable with git).

## 5. Publish the website

Easiest option — GitHub Pages, free:
1. In your repo, go to **Settings → Pages**.
2. Under **Source**, choose the branch (usually `main`) and root folder.
3. Save. GitHub gives you a live URL in a minute or two — that's the link you share with colleagues.

## 6. Set up email sending

1. In Resend, verify a sending domain (or use their default test domain to start, e.g. `onboarding@resend.dev`, which works immediately with no setup).
2. Create an API key in Resend — copy it.

## 7. Add your secrets to GitHub

In your repo: **Settings → Secrets and variables → Actions → New repository secret**. Add these four:

| Secret name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL from step 2 |
| `SUPABASE_SERVICE_KEY` | your service_role key from step 2 (not the anon key) |
| `RESEND_API_KEY` | your Resend API key from step 6 |
| `FROM_EMAIL` | e.g. `Lit Radar <onboarding@resend.dev>` |

## 8. Test it

Go to the **Actions** tab in your repo → **Monthly literature digest** → **Run workflow**. This triggers it manually so you don't have to wait for the 1st of the month. Register a test project on your live site first, then run the workflow and check your inbox.

Once that works, it's fully automated — the workflow runs itself on the 1st of every month, no further action needed from you.

## Security notes

- The Supabase key in `index.html` is the public "anon" key — safe to expose. Row Level Security (in `schema.sql`) restricts it to *inserting* new projects only; it can't read or change existing entries.
- Real credentials (Supabase service key, Resend key) live only in GitHub's encrypted Secrets — never in the code.
- The monthly email escapes all text (paper data and your project description) before inserting it into HTML, so nothing submitted through the form can inject markup into the email.
- The signup form has a basic honeypot field to filter out simple spam bots. If you want to restrict signups to only your organization's email domain (e.g. `@yourlab.dk`), that's a small addition to `schema.sql` — ask and it can be added.

## Notes

- The first run for any project will likely email more borderline matches, since there's no history yet to compare against — quality settles as the tool learns what's actually new each month (it never re-sends the same paper twice).
- To adjust how far back it searches, or how many papers it sends, edit `LOOKBACK_DAYS` and `TOP_N` near the top of `scripts/search-and-notify.mjs`.
- Only papers scoring at or above `MIN_SCORE` (also near the top of that file, default `0.6` — a strict, "very on-topic only" bar) get emailed, capped at `TOP_N` (default `7`). So some months you might get 1 paper, other months 7, or occasionally none if nothing new is a strong enough match. If digests feel too sparse, lower the number (e.g. `0.5`); if borderline stuff is still getting through, raise it further (e.g. `0.7`). There's no universally "correct" value — it depends on your field and how detailed your project description is, so expect to adjust it after seeing a couple of real runs.
- Nothing here costs money at the scale of ~10 users doing one search a month. If you ever want Claude to write a one-line "why this is relevant" note per paper instead of just a similarity score, that's a small addition to the script — ask and it can be added.

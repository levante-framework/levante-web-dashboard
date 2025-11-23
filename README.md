<!--
  Temporary README for the extracted web dashboard code.
  Feel free to replace/expand once this folder is promoted to its own repo.
-->

# Levante Web Dashboard (extracted copy)

This directory is a straight copy of the existing `web-dashboard/` tree so it can
be promoted to a standalone repository (e.g. `levante-framework/levante-web-dashboard`)
without touching the original code that still lives in this monorepo.

## Contents

- `public/` – `audio-approval.html`, `partner-audio-dashboard.html`, Pitwall HTML, assets.
- `api/` – Vercel serverless functions (Crowdin auth, audio listing, etc.).
- `scripts/`, `package.json`, `vercel.json`, `.vercel/project.json`, etc.

Everything is identical to the source `web-dashboard/` directory, including the
Vercel project configuration. When you are ready to publish a dedicated repo:

1. `cd levante-web-dashboard`
2. `git init && git add . && git commit -m "Initial import of web dashboard"`
3. `git remote add origin git@github.com:levante-framework/levante-web-dashboard.git`
4. `git push -u origin main` (or whichever branch you prefer)

After pushing, you can point the existing Vercel project to the new repo (or keep
using `vercel --prod` from this directory—the `.vercel/project.json` already
references the current project).

> **Note:** The original `web-dashboard/` folder remains untouched in this repo
> “just in case,” per the request.



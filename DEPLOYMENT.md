# Levante Pitwall - Deployment Guide

## Automatic Aliasing Setup

This project is configured with automatic aliasing so that every new deployment is automatically available at consistent URLs.

## Stable URLs

Your dashboard is always available at these stable URLs:
- **Primary**: https://audio-dashboard-levante.vercel.app
- **Secondary**: https://levante-audio-dashboard.vercel.app

These URLs automatically point to the latest production deployment.

## Prerequisites

### Git Author Configuration

**Important:** Vercel requires that the Git author email matches a team member with deployment access. The project owner is `photo@cardinalphoto.com`.

Before deploying, ensure your repo-local git config is set correctly:

```bash
git config user.name "Cardinal Photo"
git config user.email "photo@cardinalphoto.com"
```

If your latest commit was authored with a different email (e.g., `github@proshooters.com`), create an empty commit to update the author:

```bash
git commit --allow-empty -m "chore: deploy as project owner"
git push
```

This ensures Vercel's deployment authorization check passes.

## Build & Test Checklist

Before deploying (locally or via CI):

1. Install dependencies once: `npm install`
2. Compile the TypeScript sources that power the dashboard UI: `npm run build`
3. (Optional) Run the TypeScript smoke tests: `npm test` - this suite is browser-API aware and may flag missing DOM stubs when run headlessly, but it is still useful for catching missing files or compile failures.

The Vercel build step now calls `npm run build`, so as long as the command succeeds locally, the deployment build will match production.

## Deployment Methods

### Method 1: Automated Script (Recommended)

**PowerShell (Windows):**
```powershell
npm run deploy
```

**Batch File (Windows):**
```cmd
npm run deploy-bat
```

**Manual PowerShell:**
```powershell
.\deploy.ps1
```

### Method 2: Manual Deployment

1. Make sure `npm run build` succeeds locally (Vercel executes the same command during `vercel build`).
2. Deploy to production:
   ```bash
   vercel --prod
   ```

3. Set up aliases (replace `<deployment-url>` with the actual URL):
   ```bash
   vercel alias set <deployment-url> audio-dashboard-levante.vercel.app
   vercel alias set <deployment-url> levante-audio-dashboard.vercel.app
   ```

## Configuration Files

### `vercel.json`
Contains the deployment configuration with:
- Static file builds for HTML and JS
- Alias configuration
- Routing rules

### `package.json`
Contains deployment scripts:
- `npm run deploy` - Automated PowerShell deployment
- `npm run deploy-bat` - Automated batch deployment

## Alias Management

### List all aliases:
```bash
vercel alias list
```

### Remove an alias:
```bash
vercel alias remove <alias-url>
```

### Set a new alias:
```bash
vercel alias set <deployment-url> <alias-url>
```

## How It Works

1. **Deploy**: Creates a new deployment with a unique URL
2. **Alias**: Automatically updates the stable URLs to point to the new deployment
3. **Verify**: Confirms the aliases are working correctly

## Benefits

- **Consistent URLs**: Always use the same URL regardless of deployment
- **Zero Downtime**: New deployments are seamlessly aliased
- **Easy Sharing**: Share stable URLs that never change
- **Rollback Ready**: Can quickly switch aliases if needed

## Troubleshooting

### Deployment Fails

**Git Author Permission Error:**
If you see: `Error: Git author <email> must have access to the team...`
- Ensure your git author email matches a Vercel team member: `git config user.email`
- Set it to `photo@cardinalphoto.com` (project owner): `git config user.email "photo@cardinalphoto.com"`
- Create a new commit with the correct author: `git commit --allow-empty -m "chore: deploy as project owner" && git push`

**Other Issues:**
- Check your Vercel authentication: `vercel whoami`
- Verify project linking: `vercel ls`
- Check for syntax errors in `vercel.json`

### Aliases Not Working
- Manually set aliases using `vercel alias set`
- Check alias list: `vercel alias list`
- Verify DNS propagation (may take a few minutes)

### Script Execution Issues
- For PowerShell: Run `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
- For batch files: Run as administrator if needed

## Audio Validation Files

The Pitwall dashboard includes an **Audio Validation** component that displays validation summaries by language. Validation result files are stored in **Google Cloud Storage** (GCS) for the deployed environment:

- **Bucket**: `levante-dashboard-dev` (or `DASHBOARD_DATA_BUCKET` env var)
- **Prefix**: `pitwall/audio-validation-results/`

### Uploading Validation Files

After generating validation files locally (see `README_VALIDATION.md`), upload them to GCS:

```bash
# Set environment variable to enable auto-upload
export UPLOAD_TO_GCS=1
./scripts/generate-audio-validation.sh <language-code>

# Or manually upload existing files
node scripts/upload-audio-validation-files.js
```

The deployed Pitwall will automatically list and load validation files from GCS.

## Next Steps

After deployment, your dashboard will be available at:
- https://audio-dashboard-levante.vercel.app
- https://levante-audio-dashboard.vercel.app

Both URLs will automatically point to your latest deployment! 
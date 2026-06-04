# Service Account Setup for Firestore Access

This guide helps you set up a service account with read-only access to Firestore for both `hs-levante-admin-dev` and `hs-levante-admin-prod` projects.

## Step 1: Check if you already have a service account

If you already have `GCP_SERVICE_ACCOUNT_JSON` configured in Vercel for GCS access, you can reuse that service account and just add Firestore permissions.

## Step 2: Create or Update Service Account

### Option A: Use Existing Service Account (if you have GCS access working)

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Navigate to **IAM & Admin** → **Service Accounts**
3. Find your existing service account (the one used for GCS)
4. Click on it to view details
5. Go to the **Permissions** tab
6. Click **Grant Access** or **Edit**
7. Add the role: **Cloud Datastore User** (or **Firestore User**)

### Option B: Create New Service Account

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select a project (can be any project you have access to)
3. Navigate to **IAM & Admin** → **Service Accounts**
4. Click **+ Create Service Account**
5. Name: `levante-dashboard-reader` (or similar)
6. Description: `Read-only access to Firestore for Levante dashboard`
7. Click **Create and Continue**
8. Grant role: **Cloud Datastore User** (or **Firestore User**)
9. Click **Continue** → **Done**

## Step 3: Grant Access to Both Firebase Projects

The service account needs access to both Firebase projects:

### For hs-levante-admin-dev:

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select project: **hs-levante-admin-dev**
3. Go to **Project Settings** (gear icon) → **Service Accounts** tab
4. Scroll to **Service account permissions**
5. Click **Add Member**
6. Enter your service account email (for example: `SERVICE_ACCOUNT_EMAIL`)
7. Role: **Cloud Datastore User** (or **Firestore User**)
8. Click **Add**

### For hs-levante-admin-prod:

1. Repeat the same steps for **hs-levante-admin-prod**
2. Add the same service account with **Cloud Datastore User** role

## Step 4: Create JSON Key

1. Go back to [Google Cloud Console](https://console.cloud.google.com)
2. **IAM & Admin** → **Service Accounts**
3. Click on your service account
4. Go to **Keys** tab
5. Click **Add Key** → **Create new key**
6. Select **JSON**
7. Click **Create**
8. The JSON file will download automatically

## Step 5: Add to Vercel

1. Go to your Vercel project: https://vercel.com/digitalpros-projects/levante-web-dashboard
2. Navigate to **Settings** → **Environment Variables**
3. Look for `GCP_SERVICE_ACCOUNT_JSON`:
   - If it exists: Click **Edit** and update the value
   - If it doesn't exist: Click **Add New** and create it
4. **Key**: `GCP_SERVICE_ACCOUNT_JSON`
5. **Value**: Open the downloaded JSON file and copy the **entire contents** (all of it, including braces)
6. **Environment**: Select **Production**, **Preview**, and **Development** (or at least Production)
7. Click **Save**
8. **Important**: Redeploy your project for changes to take effect

## Step 6: Verify Setup

After adding the environment variable and redeploying:

1. Go to https://levante-cockpit.vercel.app/index.html
2. Click **Compare Dev/Prod**
3. It should work without prompting for login!

## Troubleshooting

### Error: "Service account JSON not found"
- Make sure `GCP_SERVICE_ACCOUNT_JSON` is set in Vercel
- Make sure you've redeployed after adding the variable
- Check that the JSON is valid (no extra characters, proper formatting)

### Error: "Permission denied" or "403"
- Verify the service account has **Cloud Datastore User** role in both Firebase projects
- Check that you added the service account to both `hs-levante-admin-dev` and `hs-levante-admin-prod`
- Wait a few minutes for permissions to propagate

### Error: "Invalid JSON"
- Make sure you copied the entire JSON file contents
- Don't add extra quotes or formatting
- The value should start with `{` and end with `}`

## Quick Test

You can test if the service account works by checking Vercel function logs:

1. Go to Vercel Dashboard → Your Project → **Deployments**
2. Click on the latest deployment
3. Go to **Functions** tab
4. Click on `/api/tasks-comparison`
5. Check the logs - you should see "Got service account access token for Firestore"

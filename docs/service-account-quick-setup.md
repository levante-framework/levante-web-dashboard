# Quick Service Account Setup Guide

Follow these steps to create a service account with Firestore read access.

## Step 1: Create Service Account in Google Cloud Console

1. **Open Google Cloud Console**: https://console.cloud.google.com
2. **Select a project** (or create one if needed - any project works)
3. **Navigate to Service Accounts**:
   - Click the hamburger menu (☰) → **IAM & Admin** → **Service Accounts**
   - Or go directly: https://console.cloud.google.com/iam-admin/serviceaccounts
4. **Click "Create Service Account"** (top of page)
5. **Fill in details**:
   - **Service account name**: `levante-dashboard-reader`
   - **Service account ID**: (auto-filled, can leave as-is)
   - **Description**: `Read-only access to Firestore for Levante dashboard tasks comparison`
   - Click **Create and Continue**
6. **Grant role**:
   - In the "Grant this service account access to project" section:
   - Click **Select a role** dropdown
   - Search for: `Cloud Datastore User`
   - Select **Cloud Datastore User** (or **Firestore User** if available)
   - Click **Continue**
7. **Skip optional steps** (click **Done**)

## Step 2: Grant Access to Firebase Projects

You need to add this service account to both Firebase projects.

### For hs-levante-admin-dev:

1. **Open Firebase Console**: https://console.firebase.google.com
2. **Select project**: `hs-levante-admin-dev`
3. **Go to Project Settings**:
   - Click the gear icon ⚙️ next to "Project Overview"
   - Select **Project Settings**
4. **Go to Service Accounts tab**
5. **Scroll to "Service account permissions"** section
6. **Click "Add Member"**
7. **Enter service account email**:
   - Format: `levante-dashboard-reader@YOUR-PROJECT-ID.iam.gserviceaccount.com`
   - (You can find this in Google Cloud Console → Service Accounts → your service account)
8. **Select role**: `Cloud Datastore User` (or `Firestore User`)
9. **Click "Add"**

### For hs-levante-admin-prod:

1. **Repeat steps 1-9 above** but select project: `hs-levante-admin-prod`

## Step 3: Create JSON Key

1. **Go back to Google Cloud Console**: https://console.cloud.google.com/iam-admin/serviceaccounts
2. **Click on your service account** (`levante-dashboard-reader`)
3. **Go to "Keys" tab**
4. **Click "Add Key"** → **"Create new key"**
5. **Select "JSON"**
6. **Click "Create"**
7. **JSON file downloads automatically** - save it somewhere safe!

## Step 4: Add to Vercel

1. **Open Vercel Dashboard**: https://vercel.com/digitalpros-projects/levante-web-dashboard
2. **Go to Settings** → **Environment Variables**
3. **Click "Add New"**
4. **Fill in**:
   - **Key**: `GCP_SERVICE_ACCOUNT_JSON`
   - **Value**: Open the downloaded JSON file, select ALL text (Ctrl+A / Cmd+A), copy it, and paste here
   - **Environment**: Check all three: Production, Preview, Development
5. **Click "Save"**

## Step 5: Redeploy

After adding the environment variable, you need to redeploy:

1. In Vercel dashboard, go to **Deployments**
2. Click the **"..."** menu on the latest deployment
3. Select **"Redeploy"**
4. Or run: `vercel --prod` from your terminal

## Step 6: Test

1. Go to: https://levante-pitwall.vercel.app/index.html
2. Click **"Compare Dev/Prod"**
3. Should work without login prompt! 🎉

## Troubleshooting

**Can't find "Cloud Datastore User" role?**
- Try searching for "Firestore User" instead
- Or use "Cloud Datastore Viewer" (read-only)

**Permission denied errors?**
- Make sure you added the service account to BOTH Firebase projects
- Wait 2-3 minutes for permissions to propagate
- Check that the role is correct in both projects

**JSON format error?**
- Make sure you copied the ENTIRE JSON file (starts with `{` and ends with `}`)
- Don't add extra quotes or formatting
- The value should be valid JSON

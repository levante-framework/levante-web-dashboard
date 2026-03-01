# Service Account Setup Status

## ✅ Completed

1. **Service Account Created**
   - Name: `levante-dashboard-reader`
   - Email: `<service-account-email-redacted>`
   - Project: `hs-levante-admin-dev`

2. **JSON Key Created**
   - Location: `/tmp/service-account-key.json`
   - Key ID: `2b9a20c8e89d1fd3c38abc49c7b9c3668be71263`

## 🔐 Next Steps: Grant Permissions

You need to grant the service account access to **both** Firebase projects. Since the service account was created in `hs-levante-admin-dev`, it needs explicit permission to access `hs-levante-admin-prod` as well.

### Option 1: Via Google Cloud Console IAM (Recommended)

1. **For hs-levante-admin-dev:**
   - Go to: https://console.cloud.google.com/iam-admin/iam?project=hs-levante-admin-dev
   - Click **"Grant access"** button (top of page)
   - In "New principals" field, enter your service account email
   - Click **"Select a role"** dropdown
   - Search for: `Cloud Datastore User`
   - Select **"Cloud Datastore User"**
   - Click **"Save"**

2. **For hs-levante-admin-prod:**
   - Go to: https://console.cloud.google.com/iam-admin/iam?project=hs-levante-admin-prod
   - Click **"Grant access"** button
   - In "New principals" field, enter your service account email
   - Select role: **"Cloud Datastore User"**
   - Click **"Save"**

### Option 2: Via Firebase Console

1. **For hs-levante-admin-dev:**
   - Go to: https://console.firebase.google.com/project/hs-levante-admin-dev/settings/iam
   - Click **"Add Member"**
   - Email: your service account email
   - Role: **"Cloud Datastore User"** (or **"Firestore User"**)
   - Click **"Add"**

2. **For hs-levante-admin-prod:**
   - Go to: https://console.firebase.google.com/project/hs-levante-admin-prod/settings/iam
   - Click **"Add Member"**
   - Email: your service account email
   - Role: **"Cloud Datastore User"** (or **"Firestore User"**)
   - Click **"Add"**

## 📝 Add JSON Key to Vercel

1. **View the JSON key:**
   ```bash
   cat /tmp/service-account-key.json
   ```

2. **Copy the entire JSON content** (starts with `{` and ends with `}`)

3. **Add to Vercel:**
   - Go to: https://vercel.com/digitalpros-projects/levante-web-dashboard/settings/environment-variables
   - Click **"Add New"**
   - **Key**: `GCP_SERVICE_ACCOUNT_JSON`
   - **Value**: Paste the entire JSON content
   - **Environments**: Check all three (Production, Preview, Development)
   - Click **"Save"**

4. **Redeploy:**
   - In Vercel dashboard → Deployments → Click "..." → "Redeploy"
   - Or run: `vercel --prod`

## ✅ Verify Setup

After adding permissions and redeploying:

1. Go to: https://levante-pitwall.vercel.app/index.html
2. Click **"Compare Dev/Prod"** button
3. Should work without authentication errors! 🎉

## Troubleshooting

**Permission denied errors?**
- Make sure you granted permissions to **both** projects
- Wait 2-3 minutes for permissions to propagate
- Check that the role is "Cloud Datastore User" (not just "Viewer")

**JSON format error?**
- Make sure you copied the ENTIRE JSON file
- Don't add extra quotes or formatting
- The value should be valid JSON (starts with `{` and ends with `}`)

**Still getting auth errors?**
- Check Vercel function logs for detailed error messages
- Verify the environment variable is set correctly
- Make sure you redeployed after adding the environment variable

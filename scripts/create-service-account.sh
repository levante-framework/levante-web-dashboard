#!/bin/bash
# Script to create service account for Firestore access
# Usage: ./scripts/create-service-account.sh

set -e

PROJECT_ID="${1:-hs-levante-admin-dev}"
SERVICE_ACCOUNT_NAME="levante-dashboard-reader"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "🔧 Creating service account for project: ${PROJECT_ID}"
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Please install it first:"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
    echo "⚠️  Not authenticated. Running: gcloud auth login"
    gcloud auth login
fi

# Set project
echo "📌 Setting project to ${PROJECT_ID}..."
gcloud config set project ${PROJECT_ID}

# Check if service account already exists
if gcloud iam service-accounts describe ${SERVICE_ACCOUNT_EMAIL} &>/dev/null; then
    echo "✅ Service account already exists: ${SERVICE_ACCOUNT_EMAIL}"
else
    echo "➕ Creating service account: ${SERVICE_ACCOUNT_NAME}..."
    gcloud iam service-accounts create ${SERVICE_ACCOUNT_NAME} \
        --display-name="Levante Dashboard Reader" \
        --description="Read-only access to Firestore for Levante dashboard tasks comparison"
fi

# Grant Cloud Datastore User role
echo "🔐 Granting Cloud Datastore User role..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/datastore.user" \
    --condition=None

echo ""
echo "✅ Service account created: ${SERVICE_ACCOUNT_EMAIL}"
echo ""
echo "📋 Next steps:"
echo "1. Create JSON key:"
echo "   gcloud iam service-accounts keys create key.json --iam-account=${SERVICE_ACCOUNT_EMAIL}"
echo ""
echo "2. Add this service account to Firebase project hs-levante-admin-prod as well"
echo ""
echo "3. Add the JSON key contents to Vercel as GCP_SERVICE_ACCOUNT_JSON"

/**
 * API endpoint to compare tasks and variants between dev and prod Firestore projects
 * Uses Firestore REST API :runQuery endpoint
 */
import {
  getSessionSecret,
  parseCookies,
  parseSessionCookieValue,
  SESSION_COOKIE_NAME
} from '../lib/server/github-auth.js';
import { checkGithubOrgMembershipByLogin } from '../lib/server/github-org-check.js';

// Firebase Admin project configurations
const FIREBASE_CONFIGS = {
  dev: {
    projectId: 'hs-levante-admin-dev',
    apiKey: 'AIzaSyCOzRA9a2sDHtVlX7qnszxrgsRCBLyf5p0'
  },
  prod: {
    projectId: 'hs-levante-admin-prod',
    apiKey: 'AIzaSyCcnmBCojjK0_Ia87f0SqclSOihhKVD3f8'
  }
};

/**
 * Query Firestore using REST API :runQuery endpoint
 * @param {string} projectId - Firebase project ID
 * @param {string} apiKey - Firebase API key
 * @param {string} collectionId - Collection to query (e.g., 'tasks' or 'variants')
 * @param {boolean} allDescendants - Whether to query all descendants (for subcollections)
 * @param {string} authToken - Optional Firebase auth token for authenticated requests
 * @returns {Promise<Array>} Array of document results
 */
async function getServiceAccountAccessToken() {
  try {
    const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!serviceAccountJson) {
      console.log('No service account JSON found in environment');
      return null;
    }
    
    const credentials = JSON.parse(serviceAccountJson);
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/datastore']
    });
    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();
    console.log('Got service account access token for Firestore');
    return accessToken.token;
  } catch (error) {
    console.warn('Could not get service account access token:', error.message);
    return null;
  }
}

async function queryFirestore(projectId, apiKey, collectionId, allDescendants = false, authToken = null) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  
  const requestBody = {
    structuredQuery: {
      from: [{
        collectionId: collectionId,
        allDescendants: allDescendants
      }]
    }
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  
  // Use provided auth token, or try to get service account token
  let token = authToken;
  if (!token) {
    token = await getServiceAccountAccessToken();
  }
  
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Firestore API error (${response.status})`;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        errorMessage = errorText || errorMessage;
      }
      throw new Error(`${errorMessage} (project: ${projectId})`);
    }

    const data = await response.json();
    
    // Extract documents from the response
    const documents = [];
    for (const item of data) {
      if (item.document) {
        // Extract document ID and data
        const docPath = item.document.name.split('/');
        const docId = docPath[docPath.length - 1];
        
        // Convert Firestore fields to plain object
        const fields = item.document.fields || {};
        const docData = {};
        for (const [key, value] of Object.entries(fields)) {
          docData[key] = convertFirestoreValue(value);
        }
        
        documents.push({
          id: docId,
          path: item.document.name,
          data: docData
        });
      }
    }
    
    return documents;
  } catch (error) {
    console.error(`Error querying Firestore (${projectId}/${collectionId}):`, error);
    throw error;
  }
}

/**
 * Convert Firestore value to JavaScript primitive
 */
function convertFirestoreValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return parseInt(value.integerValue, 10);
  if (value.doubleValue !== undefined) return parseFloat(value.doubleValue);
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue) {
    return value.arrayValue.values.map(convertFirestoreValue);
  }
  if (value.mapValue) {
    const map = {};
    for (const [key, val] of Object.entries(value.mapValue.fields || {})) {
      map[key] = convertFirestoreValue(val);
    }
    return map;
  }
  return value;
}

/**
 * Fetch all tasks and their variants for a given environment
 */
async function fetchTasksAndVariants(projectId, apiKey, authToken = null) {
  try {
    // Fetch tasks
    const tasks = await queryFirestore(projectId, apiKey, 'tasks', false, authToken);
    
    // Fetch all variants (using allDescendants to get subcollection)
    const variants = await queryFirestore(projectId, apiKey, 'variants', true, authToken);
    
    // Group variants by task ID
    const variantsByTask = {};
    for (const variant of variants) {
      // Extract task ID from path: projects/{project}/databases/(default)/documents/tasks/{taskId}/variants/{variantId}
      const pathParts = variant.path.split('/');
      const taskIndex = pathParts.indexOf('tasks');
      if (taskIndex >= 0 && taskIndex < pathParts.length - 2) {
        const taskId = pathParts[taskIndex + 1];
        if (!variantsByTask[taskId]) {
          variantsByTask[taskId] = [];
        }
        variantsByTask[taskId].push({
          id: variant.id,
          data: variant.data
        });
      }
    }
    
    // Attach variants to tasks
    const tasksWithVariants = tasks.map(task => ({
      id: task.id,
      data: task.data,
      variants: variantsByTask[task.id] || []
    }));
    
    return {
      tasks: tasksWithVariants,
      totalTasks: tasks.length,
      totalVariants: variants.length
    };
  } catch (error) {
    console.error(`Error fetching tasks/variants for ${projectId}:`, error);
    throw error;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const requiredOrg = String(process.env.GITHUB_REQUIRED_ORG || 'levante-framework').trim().toLowerCase();
    const secret = getSessionSecret();
    if (!secret) {
      return res.status(500).json({
        error: 'Server auth misconfiguration',
        message: 'Missing AUTH_SESSION_SECRET (or GITHUB_AUTH_SESSION_SECRET).'
      });
    }
    const cookies = parseCookies(req);
    const sessionRaw = cookies[SESSION_COOKIE_NAME];
    const session = parseSessionCookieValue(sessionRaw, secret);
    const githubLogin = String(session?.login || '').trim();
    if (!session || !githubLogin) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please sign in with GitHub to access tasks comparison.'
      });
    }

    const orgCheck = await checkGithubOrgMembershipByLogin(githubLogin, requiredOrg);
    if (!orgCheck.success) {
      if (orgCheck.error === 'missing_github_token') {
        return res.status(500).json({
          error: 'Server configuration error',
          message: 'Missing GITHUB_TOKEN for org membership checks.'
        });
      }
      return res.status(502).json({
        error: 'GitHub membership check failed',
        message: orgCheck.message || orgCheck.error || 'Unable to verify GitHub org membership.'
      });
    }
    if (!orgCheck.allowed) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Access denied. GitHub username "${githubLogin}" is not a member of ${requiredOrg}.`
      });
    }

    // Try to use service account credentials first (preferred - no user login required)
    let authToken = await getServiceAccountAccessToken();
    
    // Fallback to user auth token if service account not available
    if (!authToken) {
      const authHeader = req.headers.authorization || req.headers.Authorization;
      authToken = authHeader ? authHeader.replace('Bearer ', '') : null;
      
      if (!authToken) {
        return res.status(401).json({ 
          error: 'Authentication required', 
          message: 'Service account credentials (GCP_SERVICE_ACCOUNT_JSON) not configured.' 
        });
      }
      console.log('Tasks comparison request - using bearer auth token (fallback)');
    } else {
      console.log('Tasks comparison request - using service account token');
    }
    
    // Fetch from both environments in parallel
    const [devData, prodData] = await Promise.all([
      fetchTasksAndVariants(FIREBASE_CONFIGS.dev.projectId, FIREBASE_CONFIGS.dev.apiKey, authToken).catch(err => {
        console.error('Dev fetch error:', err.message);
        throw new Error(`Dev project error: ${err.message}`);
      }),
      fetchTasksAndVariants(FIREBASE_CONFIGS.prod.projectId, FIREBASE_CONFIGS.prod.apiKey, authToken).catch(err => {
        console.error('Prod fetch error:', err.message);
        throw new Error(`Prod project error: ${err.message}`);
      })
    ]);

    // Create comparison data
    const devTaskIds = new Set(devData.tasks.map(t => t.id));
    const prodTaskIds = new Set(prodData.tasks.map(t => t.id));
    
    const onlyInDev = devData.tasks.filter(t => !prodTaskIds.has(t.id));
    const onlyInProd = prodData.tasks.filter(t => !devTaskIds.has(t.id));
    const inBoth = devData.tasks.filter(t => prodTaskIds.has(t.id));
    
    // Compare variants for tasks in both environments
    const variantComparisons = inBoth.map(task => {
      const prodTask = prodData.tasks.find(t => t.id === task.id);
      const devVariantIds = new Set(task.variants.map(v => v.id));
      const prodVariantIds = new Set(prodTask.variants.map(v => v.id));
      
      return {
        taskId: task.id,
        devVariants: task.variants.length,
        prodVariants: prodTask.variants.length,
        onlyInDev: task.variants.filter(v => !prodVariantIds.has(v.id)),
        onlyInProd: prodTask.variants.filter(v => !devVariantIds.has(v.id)),
        inBoth: task.variants.filter(v => prodVariantIds.has(v.id))
      };
    });

    res.status(200).json({
      generatedAt: new Date().toISOString(),
      dev: {
        totalTasks: devData.totalTasks,
        totalVariants: devData.totalVariants,
        tasks: devData.tasks
      },
      prod: {
        totalTasks: prodData.totalTasks,
        totalVariants: prodData.totalVariants,
        tasks: prodData.tasks
      },
      comparison: {
        onlyInDev: onlyInDev.map(t => ({ id: t.id, data: t.data, variantCount: t.variants.length })),
        onlyInProd: onlyInProd.map(t => ({ id: t.id, data: t.data, variantCount: t.variants.length })),
        inBoth: inBoth.length,
        variantComparisons: variantComparisons.filter(vc => 
          vc.onlyInDev.length > 0 || vc.onlyInProd.length > 0 || vc.devVariants !== vc.prodVariants
        )
      }
    });
  } catch (error) {
    console.error('tasks-comparison error:', error);
    const message = String(error?.message || '');
    const isFirestorePermissionDenied = /PERMISSION_DENIED|Missing or insufficient permissions|Firestore API error \(403\)/i.test(message);
    const statusCode = isFirestorePermissionDenied ? 500 : 500;
    res.status(statusCode).json({ 
      error: 'Failed to fetch tasks comparison', 
      message,
      details: isFirestorePermissionDenied
        ? 'Service account is authenticated but lacks Firestore read access in one or more target projects.'
        : (message.includes('Firestore API error') ? 'Check that service account has Firestore access' : undefined),
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

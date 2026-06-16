import { Storage } from '@google-cloud/storage';

const DEFAULT_BUCKET = String(process.env.ASSETS_DRAFT_BUCKET || 'levante-assets-draft').trim();
const STATUS_PREFIX = String(process.env.PARTNER_TASK_FINISHED_PREFIX || 'logs/partner-task-finished').trim().replace(/^\/+|\/+$/g, '');

let storageClient = null;

function getStorage() {
  if (storageClient) return storageClient;
  try {
    const json = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || process.env.GCP_SERVICE_ACCOUNT_JSON;
    if (json) {
      const credentials = JSON.parse(json);
      storageClient = new Storage({ credentials, projectId: credentials.project_id });
      return storageClient;
    }
    storageClient = new Storage();
    return storageClient;
  } catch (error) {
    console.warn('partner-task-finished: failed to init storage client', error);
    return null;
  }
}

function safeText(value, maxLen = 200) {
  return String(value || '').trim().slice(0, maxLen);
}

function normalizeLangCode(langCode) {
  return String(langCode || '').trim().replace(/_/g, '-');
}

function normalizeTaskKey(taskName) {
  return String(taskName || '').trim().toLowerCase();
}

function getStatusPath(langCode) {
  const safe = normalizeLangCode(langCode).toLowerCase().replace(/[^a-z0-9-]+/g, '_');
  return `${STATUS_PREFIX}/${safe}.json`;
}

async function readLanguageStatus(bucket, langCode) {
  const path = getStatusPath(langCode);
  const file = bucket.file(path);
  const [exists] = await file.exists();
  if (!exists) {
    return { tasks: {}, path };
  }
  const [buf] = await file.download();
  const parsed = JSON.parse(buf.toString() || '{}');
  const tasks = parsed && typeof parsed.tasks === 'object' ? parsed.tasks : {};
  return { tasks, path };
}

async function writeLanguageStatus(bucket, langCode, tasks) {
  const path = getStatusPath(langCode);
  const file = bucket.file(path);
  const payload = {
    langCode: normalizeLangCode(langCode),
    tasks,
    updatedAt: new Date().toISOString()
  };
  await file.save(JSON.stringify(payload, null, 2), {
    contentType: 'application/json',
    resumable: false
  });
  return path;
}

async function postSlackTaskFinishedMessage({ langCode, language, task, approver, approvedAudio, totalAudio }) {
  const botToken = String(
    process.env.SLACK_BOT_TOKEN
    || process.env.SLACK_FINISHED_TASK_BOT_TOKEN
    || ''
  ).trim();
  const channelFromEnv = String(
    process.env.SLACK_FINISHED_TASK_CHANNEL_ID
    || process.env.SLACK_FINISHED_TASK_CHANNEL
    || '#levante-crowdin'
  ).trim();
  const webhookUrl = String(
    process.env.SLACK_FINISHED_TASK_WEBHOOK_URL
    || process.env.SLACK_WEBHOOK_URL
    || ''
  ).trim();

  // Prefer chat.postMessage when bot token is available.
  // Falls back to webhook mode for backward compatibility.
  if (!botToken && !webhookUrl) {
    return { sent: false, reason: 'missing_slack_auth' };
  }

  if (botToken && !channelFromEnv) {
    return { sent: false, reason: 'missing_channel' };
  }

  const channel = channelFromEnv;
  const safeApprover = safeText(approver || 'unknown approver', 160) || 'unknown approver';
  const langLabel = safeText(language || langCode, 120) || normalizeLangCode(langCode);
  const taskLabel = safeText(task, 180);
  const approved = Number.isFinite(Number(approvedAudio)) ? Number(approvedAudio) : 0;
  const total = Number.isFinite(Number(totalAudio)) ? Number(totalAudio) : 0;

  const text = `:white_check_mark: Partner audio review finished\n• Task: *${taskLabel}*\n• Language: *${langLabel}* (\`${normalizeLangCode(langCode)}\`)\n• Audio approved: *${approved}/${total}*\n• Reviewer: *${safeApprover}*`;
  if (botToken) {
    const callSlackApi = async (method, params = {}) => {
      const response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${botToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params)
      });
      const payload = await response.json().catch(() => ({}));
      return { response, payload };
    };

    let resolvedChannel = channel;
    if (resolvedChannel.startsWith('#')) {
      const channelName = resolvedChannel.replace(/^#/, '').trim();
      const { payload } = await callSlackApi('conversations.list', {
        limit: '1000',
        types: 'public_channel,private_channel'
      });
      if (!payload?.ok) {
        const details = payload?.error || 'unknown_error';
        throw new Error(`Slack conversations.list failed: ${details}`);
      }
      const matched = Array.isArray(payload.channels)
        ? payload.channels.find((entry) => String(entry?.name || '').trim() === channelName)
        : null;
      if (!matched?.id) {
        throw new Error(`Slack channel not found: ${resolvedChannel}`);
      }
      if (matched.is_member === false) {
        throw new Error(`Slack bot is not a member of channel: ${resolvedChannel}`);
      }
      resolvedChannel = matched.id;
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify({
        channel: resolvedChannel,
        text,
        unfurl_links: false,
        unfurl_media: false
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      const details = payload?.error || `http_${response.status}`;
      throw new Error(`Slack chat.postMessage failed: ${details}`);
    }
    return {
      sent: true,
      mode: 'chat.postMessage',
      channel: payload.channel || resolvedChannel || channel,
      ts: payload.ts || ''
    };
  }

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, channel })
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Slack webhook failed (${response.status}): ${body.slice(0, 200)}`);
  }
  return { sent: true, mode: 'webhook', channel };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const storage = getStorage();
  if (!storage) {
    return res.status(500).json({
      success: false,
      error: 'gcs_unavailable',
      message: 'Could not initialize Google Cloud Storage client.'
    });
  }

  const bucket = storage.bucket(DEFAULT_BUCKET);

  try {
    if (req.method === 'GET') {
      const langCode = normalizeLangCode(req.query?.langCode || '');
      if (!langCode) {
        return res.status(400).json({ success: false, error: 'bad_request', message: 'langCode is required' });
      }
      const { tasks, path } = await readLanguageStatus(bucket, langCode);
      const entries = Object.values(tasks || {}).filter(Boolean);
      return res.status(200).json({
        success: true,
        langCode,
        tasks: entries,
        path
      });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, error: 'method_not_allowed' });
    }

    const body = req.body || {};
    const langCode = normalizeLangCode(body.langCode || '');
    const task = safeText(body.task, 180);
    const language = safeText(body.language, 120);
    const approver = safeText(body.approver, 160);
    const approvedAudio = Number.isFinite(Number(body.approvedAudio)) ? Number(body.approvedAudio) : 0;
    const totalAudio = Number.isFinite(Number(body.totalAudio)) ? Number(body.totalAudio) : 0;

    if (!langCode || !task) {
      return res.status(400).json({
        success: false,
        error: 'bad_request',
        message: 'langCode and task are required'
      });
    }

    const { tasks } = await readLanguageStatus(bucket, langCode);
    const taskKey = normalizeTaskKey(task);
    const alreadyFinished = !!tasks[taskKey];

    const record = alreadyFinished ? tasks[taskKey] : {
      task,
      taskKey,
      langCode,
      language,
      approver,
      approvedAudio,
      totalAudio,
      finishedAt: new Date().toISOString()
    };
    if (!alreadyFinished) {
      tasks[taskKey] = record;
      await writeLanguageStatus(bucket, langCode, tasks);
    }

    let slack = { sent: false, reason: alreadyFinished ? 'already_finished' : 'not_attempted' };
    if (!alreadyFinished) {
      try {
        slack = await postSlackTaskFinishedMessage({
          langCode,
          language,
          task,
          approver,
          approvedAudio,
          totalAudio
        });
      } catch (error) {
        console.warn('partner-task-finished: slack post failed:', error?.message || error);
        slack = { sent: false, reason: 'post_failed', message: String(error?.message || error) };
      }
    }

    return res.status(200).json({
      success: true,
      alreadyFinished,
      task: record,
      slack
    });
  } catch (error) {
    console.error('partner-task-finished handler error', error);
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: error?.message || String(error)
    });
  }
}


const fs = require('fs');
const path = require('path');

const LOG_PATH =
  process.env.NODE_ENV === 'production'
    ? path.join('/tmp', 'location_log.json')
    : path.join(process.cwd(), 'data', 'location_log.json');
const LOG_LIMIT = 200;

function ensureLogFile() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  }
}

function readLog() {
  try {
    ensureLogFile();
    const raw = fs.readFileSync(LOG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('location-log: failed to read log file', error);
    return [];
  }
}

function appendLog(entry) {
  try {
    const entries = readLog();
    entries.unshift(entry);
    if (entries.length > LOG_LIMIT) {
      entries.length = LOG_LIMIT;
    }
    fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
    return entries;
  } catch (error) {
    console.error('location-log: failed to append log entry', error);
    return null;
  }
}

module.exports = {
  LOG_PATH,
  appendLog,
  readLog,
};


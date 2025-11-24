(() => {
  const DEFAULT_DRAFT_BUCKET = 'levante-assets-draft';
  const DEFAULT_DEV_BUCKET = 'levante-assets-dev';

  const statusEl = document.getElementById('status');
  const contentEl = document.getElementById('content');
  const folderInfoEl = document.getElementById('folderInfo');
  const languageFilterEl = document.getElementById('languageFilter');
  const logButton = document.getElementById('viewLogButton');
  const logPanel = document.getElementById('activityLogPanel');
  const logListEl = document.getElementById('activityLogList');
  const logCloseButton = document.getElementById('activityLogClose');
  const approveButton = document.getElementById('approveSelected');
  const deleteButton = document.getElementById('deleteSelected');

  const activityLog = [];
  const selectedPaths = new Set();

  const params = new URLSearchParams(window.location.search);
  const bucket = sanitizeBucket(params.get('bucket')) || DEFAULT_DEV_BUCKET;
  const folder = sanitizeFolder(params.get('folder')) || 'audio';
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  const isDraftBucket = bucket === DEFAULT_DRAFT_BUCKET || /-draft$/i.test(bucket);

  const headingEl = document.querySelector('header h1');
  const noteEl = document.querySelector('.approval-note');
  if (headingEl) {
    headingEl.textContent = isDraftBucket ? 'Review Draft Audio Clips' : 'Approved Audio Library';
  }
  if (noteEl) {
    noteEl.textContent = isDraftBucket
      ? 'Approve clips to promote them to levante-assets-dev.'
      : 'These clips are currently served from levante-assets-dev.';
  }

  folderInfoEl.textContent = `Bucket: ${bucket} • Prefix: ${prefix}`;
  let allItems = [];
  let currentLanguageFilter = '';

  updateActionButtons();
  updateLogButton();

  if (approveButton) {
    approveButton.addEventListener('click', moveSelectedFiles);
  }
  if (deleteButton) {
    deleteButton.addEventListener('click', deleteSelectedFiles);
  }
  if (logButton) {
    logButton.addEventListener('click', () => toggleLogPanel());
  }
  if (logCloseButton) {
    logCloseButton.addEventListener('click', () => toggleLogPanel(false));
  }

  function sanitizeBucket(value) {
    return (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '')
      .trim();
  }

  function sanitizeFolder(value) {
    const cleaned = (value || '')
      .replace(/\.+/g, '')
      .replace(/^[\\/]+/, '')
      .replace(/[\\/]+$/, '')
      .trim();
    return cleaned || '';
  }

  if (languageFilterEl) {
    languageFilterEl.addEventListener('change', (event) => {
      currentLanguageFilter = event.target.value || '';
      renderFiles(applyLanguageFilter(allItems));
    });
  }

  function updateActionButtons() {
    const count = selectedPaths.size;
    const disabled = count === 0;
    if (approveButton) {
      approveButton.disabled = disabled;
      const label = isDraftBucket ? 'Approve' : 'Unapprove';
      approveButton.textContent = disabled ? `${label} Selected` : `${label} ${count} Selected`;
    }
    if (deleteButton) {
      deleteButton.disabled = disabled;
      deleteButton.textContent = disabled ? 'Delete Selected' : `Delete ${count} Selected`;
    }
  }

  function toggleSelection(path, checked) {
    if (!path) return;
    if (checked) {
      selectedPaths.add(path);
    } else {
      selectedPaths.delete(path);
    }
    const checkboxes = Array.from(document.querySelectorAll('.file-select-checkbox')).filter(cb => !cb.disabled);
    const master = document.querySelector('.master-select-checkbox');
    if (master && checkboxes.length) {
      const checkedCount = checkboxes.filter(cb => cb.checked).length;
      master.checked = checkedCount === checkboxes.length;
    }
    updateActionButtons();
  }

  function updateLogButton() {
    if (!logButton) return;
    const count = activityLog.length;
    const isOpen = logPanel && logPanel.classList.contains('is-open');
    const label = count ? `Activity Log (${count})` : 'Activity Log';
    logButton.textContent = label;
    logButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function renderActivityLog() {
    if (!logListEl) return;
    if (!activityLog.length) {
      logListEl.innerHTML = '<li class="activity-log-empty">No activity yet.</li>';
      return;
    }
    logListEl.innerHTML = '';
    activityLog.forEach(entry => {
      const item = document.createElement('li');
      item.className = `activity-log-item ${entry.type || 'info'}`;
      const timeEl = document.createElement('span');
      timeEl.className = 'log-time';
      timeEl.textContent = entry.timestamp.toLocaleTimeString();
      const messageEl = document.createElement('span');
      messageEl.className = 'log-message';
      messageEl.textContent = entry.message;
      item.appendChild(timeEl);
      item.appendChild(messageEl);
      logListEl.appendChild(item);
    });
  }

  function recordLog(message, type) {
    if (!message) return;
    const entry = {
      message: String(message),
      type: type || 'info',
      timestamp: new Date()
    };
    const lastEntry = activityLog[0];
    if (lastEntry && lastEntry.message === entry.message && lastEntry.type === entry.type) {
      lastEntry.timestamp = entry.timestamp;
      if (logPanel && logPanel.classList.contains('is-open')) {
        renderActivityLog();
      }
      updateLogButton();
      return;
    }
    activityLog.unshift(entry);
    if (activityLog.length > 200) {
      activityLog.splice(200);
    }
    if (logPanel && logPanel.classList.contains('is-open')) {
      renderActivityLog();
    }
    updateLogButton();
  }

  function toggleLogPanel(forceState) {
    if (!logPanel) return;
    const shouldOpen = typeof forceState === 'boolean'
      ? forceState
      : !logPanel.classList.contains('is-open');
    if (shouldOpen) {
      logPanel.classList.add('is-open');
      logPanel.setAttribute('aria-expanded', 'true');
      renderActivityLog();
    } else {
      logPanel.classList.remove('is-open');
      logPanel.setAttribute('aria-expanded', 'false');
    }
    updateLogButton();
  }

  function setStatus(message, type) {
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status ${type || ''}`.trim();
    }
    recordLog(message, type || 'info');
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '0 bytes';
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    let display = value;
    while (display >= 1024 && index < units.length - 1) {
      display /= 1024;
      index += 1;
    }
    const precision = display >= 10 || index === 0 ? 0 : 1;
    return `${display.toFixed(precision)} ${units[index]}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString();
  }

  function formatVersion(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    return `v${String(num).padStart(3, '0')}`;
  }

  function buildPublicUrl(path) {
    const safeSegments = path.split('/').map(segment => encodeURIComponent(segment));
    return `https://storage.googleapis.com/${bucket}/${safeSegments.join('/')}`;
  }

  function applyLanguageFilter(items) {
    if (!currentLanguageFilter) return items.slice();
    return items.filter(item => {
      const lang = item.language || '';
      return lang.toLowerCase() === currentLanguageFilter.toLowerCase();
    });
  }

  function populateLanguageFilter(items) {
    if (!languageFilterEl) return;
    const languages = Array.from(new Set(items
      .map(item => (item.language || '').trim())
      .filter(Boolean)))
      .sort((a, b) => a.localeCompare(b));
    languageFilterEl.innerHTML = '<option value=\"\">All languages</option>';
    languages.forEach(lang => {
      const option = document.createElement('option');
      option.value = lang;
      option.textContent = lang;
      languageFilterEl.appendChild(option);
    });
    if (currentLanguageFilter && !languages.includes(currentLanguageFilter)) {
      currentLanguageFilter = '';
    }
    languageFilterEl.value = currentLanguageFilter;
  }

  function renderFiles(items) {
    if (!items.length) {
      contentEl.innerHTML = '<div class="empty-state">No audio files found for this folder.</div>';
      setStatus('No audio files were found for the requested prefix.', 'warning');
      return;
    }

    const visiblePaths = new Set(items.map(item => item.path || ''));
    Array.from(selectedPaths).forEach(path => {
      if (!visiblePaths.has(path)) {
        selectedPaths.delete(path);
      }
    });

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['Select', 'Item ID', 'Language', 'Version', 'Status', 'Size', 'Updated', 'Preview', 'Download'];
    headers.forEach((label, idx) => {
      const th = document.createElement('th');
      if (idx === 0) {
        th.style.width = '56px';
        const masterCheckbox = document.createElement('input');
        masterCheckbox.type = 'checkbox';
        masterCheckbox.className = 'master-select-checkbox';
        masterCheckbox.title = 'Select all files';
        masterCheckbox.addEventListener('change', (event) => {
          const checked = event.target.checked;
          document.querySelectorAll('.file-select-checkbox').forEach(cb => {
            if (cb.disabled) return;
            cb.checked = checked;
            toggleSelection(cb.dataset.path, checked);
          });
        });
        th.appendChild(masterCheckbox);
      } else {
        th.textContent = label;
      }
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    items.forEach(item => {
      const row = document.createElement('tr');
      const objectPath = item.path || '';
      const fileName = objectPath.split('/').pop() || '';
      const itemId = item.itemId || fileName.replace(/\.mp3$/i, '');
      const language = item.language || (objectPath.split('/')[1] || '—');
      const versionLabel = formatVersion(item.version);
      const sizeLabel = formatBytes(item.size || 0);
      const updatedLabel = formatDate(item.updated || item.timeCreated || '');
      const publicUrl = objectPath ? buildPublicUrl(objectPath) : null;

      const selectCell = document.createElement('td');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'file-select-checkbox';
      checkbox.dataset.path = objectPath;
      checkbox.checked = selectedPaths.has(objectPath);
      checkbox.addEventListener('change', (event) => {
        toggleSelection(objectPath, event.target.checked);
      });
      selectCell.appendChild(checkbox);
      row.appendChild(selectCell);

      const itemCell = document.createElement('td');
      const codeEl = document.createElement('code');
      codeEl.textContent = itemId || '—';
      itemCell.appendChild(codeEl);
      row.appendChild(itemCell);

      const languageCell = document.createElement('td');
      languageCell.textContent = language || '—';
      row.appendChild(languageCell);

      const versionCell = document.createElement('td');
      versionCell.textContent = versionLabel || '—';
      row.appendChild(versionCell);

      const statusCell = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill ${isDraftBucket ? 'status-not-approved' : 'status-approved'}`;
      pill.textContent = isDraftBucket ? 'Draft' : 'Approved';
      statusCell.appendChild(pill);
      row.appendChild(statusCell);

      const sizeCell = document.createElement('td');
      sizeCell.textContent = sizeLabel;
      row.appendChild(sizeCell);

      const updatedCell = document.createElement('td');
      updatedCell.textContent = updatedLabel;
      row.appendChild(updatedCell);

      const previewCell = document.createElement('td');
      if (publicUrl) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.src = publicUrl;
        previewCell.appendChild(audio);
      } else {
        previewCell.textContent = '—';
      }
      row.appendChild(previewCell);

      const downloadCell = document.createElement('td');
      if (publicUrl) {
        const link = document.createElement('a');
        link.href = publicUrl;
        link.textContent = 'Download';
        link.className = 'download-link';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        downloadCell.appendChild(link);
      } else {
        downloadCell.textContent = '—';
      }
      row.appendChild(downloadCell);

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    contentEl.innerHTML = '';
    contentEl.appendChild(table);
    updateActionButtons();
      setStatus(`Loaded ${items.length} file${items.length === 1 ? '' : 's'} from ${bucket}/${prefix}${currentLanguageFilter ? ` (${currentLanguageFilter})` : ''}`, 'success');
  }

  async function loadFiles() {
    try {
      setStatus('Loading audio files…', 'loading');
      const url = `/api/list-draft-audio?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`;
      const response = await fetch(url);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }
      const data = await response.json();
      allItems = Array.isArray(data.items) ? data.items : [];
      populateLanguageFilter(allItems);
      renderFiles(applyLanguageFilter(allItems));
    } catch (error) {
      console.error('Failed to load audio list', error);
      contentEl.innerHTML = '<div class="empty-state">We could not load the audio files. Please try again later.</div>';
      setStatus(`Unable to load audio files: ${error.message}`, 'error');
    }
  }

  async function moveSelectedFiles() {
    if (selectedPaths.size === 0) return;
    const endpoint = isDraftBucket ? '/api/move-audio-to-dev' : '/api/move-audio-to-draft';
    const verb = isDraftBucket ? 'approve' : 'unapprove';
    const targetLabel = isDraftBucket ? 'levante-assets-dev' : 'levante-assets-draft';

    try {
      setStatus(`${verb.charAt(0).toUpperCase() + verb.slice(1)}ing ${selectedPaths.size} file(s)…`, 'loading');
      if (approveButton) approveButton.disabled = true;
      if (deleteButton) deleteButton.disabled = true;

      let successCount = 0;
      const errors = [];
      for (const path of selectedPaths) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bucket, path })
          });
          if (!response.ok) {
            const text = await response.text();
            throw new Error(text || `HTTP ${response.status}`);
          }
          successCount += 1;
        } catch (error) {
          errors.push({ path, message: error.message });
        }
      }

      selectedPaths.clear();
      if (errors.length) {
        console.warn('Move errors', errors);
      }
      await loadFiles();

      if (successCount) {
        setStatus(`Moved ${successCount} file${successCount === 1 ? '' : 's'} to ${targetLabel}.`, 'success');
      }
      if (errors.length) {
        setStatus(`Failed to ${verb} ${errors.length} file${errors.length === 1 ? '' : 's'}. Check console for details.`, 'error');
      }
    } catch (error) {
      setStatus(`Unable to ${verb} files: ${error.message}`, 'error');
    } finally {
      updateActionButtons();
    }
  }

  async function deleteSelectedFiles() {
    if (selectedPaths.size === 0) return;
    const confirmMessage = `Delete ${selectedPaths.size} selected file${selectedPaths.size === 1 ? '' : 's'} from ${bucket}? This cannot be undone.`;
    if (!confirm(confirmMessage)) {
      return;
    }
    try {
      setStatus('Deleting selected files…', 'loading');
      if (deleteButton) deleteButton.disabled = true;
      if (approveButton) approveButton.disabled = true;

      const files = Array.from(selectedPaths).map(path => ({ bucket, path }));
      const response = await fetch('/api/delete-draft-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files })
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `HTTP ${response.status}`);
      }

      selectedPaths.clear();
      await loadFiles();
      setStatus(`Deleted ${files.length} file${files.length === 1 ? '' : 's'} from ${bucket}.`, 'success');
    } catch (error) {
      console.error('Delete failed', error);
      setStatus(`Failed to delete files: ${error.message}`, 'error');
    } finally {
      updateActionButtons();
    }
  }

  loadFiles();
})();


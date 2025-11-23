function openAudioValidationModal() {
	document.getElementById('audioValidationModal').style.display = 'block';
}
function closeAudioValidationModal() {
	document.getElementById('audioValidationModal').style.display = 'none';
}

function initAudioValidationApp() {
	const mount = document.getElementById('audio-validation-app');
	if (!mount) return;
	const { createApp, ref, computed, onMounted } = Vue;
	const app = createApp({
		setup() {
			const files = ref([]);
			const selectedFile = ref('');
			const loading = ref(false);
			const error = ref('');
			const results = ref([]);
			const sortKey = ref('similarity');
			const sortAsc = ref(false);
			const displayLang = ref('');
			const voiceName = ref('');
			function base(name) { const idx = name.lastIndexOf('/'); return idx >= 0 ? name.slice(idx+1) : name; }
			function stripExt(name) { return name.replace(/\.[a-zA-Z0-9]+$/, ''); }
			function resolveUrls(r) {
				const lang = (r.language || '').trim();
				const itemId = stripExt(base(r.audio_path || ''));
				const urls = [];
				if (lang && itemId) {
					urls.push(`https://raw.githubusercontent.com/levante-framework/levante_translations/main/audio_files/${encodeURIComponent(lang)}/${encodeURIComponent(itemId)}.mp3`);
					urls.push(`https://storage.googleapis.com/levante-assets-dev/audio/${encodeURIComponent(lang)}/${encodeURIComponent(itemId)}.mp3`);
					if (lang.includes('-')) {
						const baseLang = lang.split('-')[0];
						urls.push(`https://raw.githubusercontent.com/levante-framework/levante_translations/main/audio_files/${encodeURIComponent(baseLang)}/${encodeURIComponent(itemId)}.mp3`);
						urls.push(`https://storage.googleapis.com/levante-assets-dev/audio/${encodeURIComponent(baseLang)}/${encodeURIComponent(itemId)}.mp3`);
					}
				}
				return urls;
			}
			async function playRow(r) {
				const candidates = resolveUrls(r);
				for (let i=0;i<candidates.length;i++) {
					try {
						await new Promise((resolve, reject) => {
							const audio = new Audio();
							audio.src = candidates[i];
							audio.addEventListener('canplaythrough', () => { audio.play().then(resolve).catch(reject); }, { once: true });
							audio.addEventListener('error', () => reject(new Error('play failed')), { once: true });
						});
						return;
					} catch (e) { /* try next */ }
				}
				alert('Could not play audio for this row.');
			}
			const decorated = computed(() => results.value.map(r => ({
				...r,
				filename: base(r.audio_path || ''),
				language_display: (r.language || '').toUpperCase()
			})));
			const sortedRows = computed(() => {
				const rows = [...decorated.value];
				const key = sortKey.value;
				rows.sort((a,b) => {
					let av, bv;
					if (key === 'filename') { av = a.filename || ''; bv = b.filename || ''; return av.localeCompare(bv); }
					if (key === 'language') { av = a.language_display || ''; bv = b.language_display || ''; return av.localeCompare(bv); }
					if (key === 'similarity') { av = (a.basic_metrics||{}).similarity_ratio || 0; bv = (b.basic_metrics||{}).similarity_ratio || 0; return av - bv; }
					// default fallback
					av = 0; bv = 0; return 0;
				});
				return sortAsc.value ? rows : rows.reverse();
			});
			const summary = computed(() => {
				if (!results.value || !Array.isArray(results.value)) return null;
				const sims = results.value.map(r => (r.basic_metrics||{}).similarity_ratio).filter(x => typeof x === 'number');
				if (!sims.length) return null;
				const avg = sims.reduce((a,b)=>a+b,0)/sims.length;
				return { count: sims.length, min: Math.min(...sims), max: Math.max(...sims), avg };
			});
			async function loadFiles() {
				try {
					const resp = await fetch('/api/list-validation-files');
					const data = await resp.json();
					files.value = (data.files||[]).sort().reverse();
					if (!selectedFile.value && files.value.length) selectedFile.value = files.value[0];
				} catch (e) { error.value = String(e); }
			}
			async function loadSelected() {
				if (!selectedFile.value) return;
				loading.value = true; error.value = '';
				try {
					const resp = await fetch(`/api/get-validation-file?name=${encodeURIComponent(selectedFile.value)}`);
					const data = await resp.json();
					results.value = Array.isArray(data) ? data : [data];
					const langs = new Set(results.value.map(r => r.language).filter(Boolean));
					displayLang.value = langs.size ? Array.from(langs).join(', ') : '';
					await fetchVoiceFromFirst();
				} catch (e) { error.value = String(e); }
				finally { loading.value = false; }
			}
			async function fetchVoiceFromFirst() {
				try {
					if (!results.value || results.value.length === 0) { voiceName.value = ''; return; }
					const first = results.value[0];
					const lang = (first.language || '').trim();
					const itemId = stripExt(base(first.audio_path || ''));
					if (!lang || !itemId) { voiceName.value = ''; return; }
					const resp = await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(lang)}&source=repo`);
					if (!resp.ok) { voiceName.value = ''; return; }
					const data = await resp.json();
					const v = data?.id3Tags?.voice || data?.id3Tags?.userDefinedText?.find?.(t => t?.description === 'voice')?.value || '';
					voiceName.value = v || '';
				} catch (e) {
					voiceName.value = '';
				}
			}
			function setSort(key) { if (sortKey.value === key) { sortAsc.value = !sortAsc.value; } else { sortKey.value = key; sortAsc.value = true; } }
			onMounted(() => { loadFiles(); });
			return { files, selectedFile, loading, error, results, summary, loadSelected, sortedRows, sortKey, sortAsc, setSort, displayLang, playRow, voiceName };
		}
	});
	app.mount('#audio-validation-app');
}

// Improve dragging: only drag when mousedown on header, ignore clicks inside table
(function enableAudioValidationDrag(){
	function makeDraggable(modalId, headerSelector) {
		const modal = document.getElementById(modalId);
		if (!modal) return;
		const content = modal.querySelector('.modal-content');
		const header = modal.querySelector(headerSelector) || content;
		let isDown=false, startX=0, startY=0, originLeft=0, originTop=0;
		header.style.cursor = 'move';
		header.addEventListener('mousedown', (e)=>{
			// Only start drag if target is within the header element
			if (e.target !== header) return;
			isDown=true; startX=e.clientX; startY=e.clientY;
			const r = content.getBoundingClientRect();
			originLeft = r.left; originTop = r.top;
			document.body.style.userSelect='none';
		});
		document.addEventListener('mousemove', (e)=>{
			if(!isDown) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			content.style.position='fixed';
			content.style.left = `${Math.max(10, Math.min(window.innerWidth-10, originLeft+dx))}px`;
			content.style.top = `${Math.max(10, Math.min(window.innerHeight-10, originTop+dy))}px`;
		});
		document.addEventListener('mouseup', ()=>{ isDown=false; document.body.style.userSelect=''; });
	}
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', ()=>makeDraggable('audioValidationModal','h2'));
	} else {
		makeDraggable('audioValidationModal','h2');
	}
})();

(function(){
	// Suppress browser extension message channel errors
	window.addEventListener('error', function(e) {
		if (e.message && e.message.includes('message channel closed')) {
			e.preventDefault();
			return false;
		}
	});
	
	window.addEventListener('unhandledrejection', function(e) {
		if (e.reason && e.reason.message && e.reason.message.includes('message channel closed')) {
			e.preventDefault();
			return false;
		}
	});

	const { createApp, ref, computed, onMounted } = Vue;

	function base(path){ const i=(path||'').lastIndexOf('/'); return i>=0?path.slice(i+1):path; }
	function stripExt(n){ return (n||'').replace(/\.[a-zA-Z0-9]+$/, ''); }
	
	function extractLangsFromPath(audioPath){
		const langs=new Set(); const p=audioPath||'';
		let m=p.match(/(?:audio_files|audio)\/([A-Za-z-]{2,10})\//); if(m&&m[1]){ langs.add(m[1]); if(m[1].includes('-')) langs.add(m[1].split('-')[0]); }
		p.split('/').forEach(s=>{ if(/^[A-Za-z]{2}(?:-[A-Za-z]{2,4})?$/.test(s)){ langs.add(s); if(s.includes('-')) langs.add(s.split('-')[0]); } });
		return Array.from(langs);
	}
	function langCandidates(row){
		const cand=new Set(); const meta=(row.language||'').trim(); if(meta){ cand.add(meta); if(meta.includes('-')) cand.add(meta.split('-')[0]); }
		extractLangsFromPath(row.audio_path).forEach(l=>cand.add(l));
		return Array.from(cand);
	}
	function normalizeLangsForUrls(lang){
		const L=(lang||'').trim();
		if(!L) return [];
		if(L==='es') return ['es-CO','es'];
		if(L.startsWith('es-')) return [L,'es'];
		return [L];
	}
	function resolveUrlsFor(lang,itemId){
		if(!lang||!itemId) return [];
		const langs=normalizeLangsForUrls(lang);
		const urls=[];
		for(const lc of langs){
			urls.push(`https://raw.githubusercontent.com/levante-framework/levante_translations/main/audio_files/${encodeURIComponent(lc)}/${encodeURIComponent(itemId)}.mp3`);
			urls.push(`https://storage.googleapis.com/levante-assets-dev/audio/${encodeURIComponent(lc)}/${encodeURIComponent(itemId)}.mp3`);
		}
		return urls;
	}
	async function playAny(urls){ for(const u of urls){ try{ await new Promise((resolve,reject)=>{ const a=new Audio(); a.src=u; a.addEventListener('canplaythrough',()=>{ a.play().then(resolve).catch(reject); },{once:true}); a.addEventListener('error',()=>reject(new Error('play failed')),{once:true}); }); return true; }catch(e){} } return false; }
	
	async function fetchVoiceTag(itemId, lang, urlCandidates){
		try{
			// Prefer direct URL mode if we have candidates
			if(Array.isArray(urlCandidates) && urlCandidates.length){
				for(const u of urlCandidates){ const d=await fetch(`/api/read-tags?url=${encodeURIComponent(u)}`); if(d.ok){ const data=await d.json(); return data?.id3Tags?.voice || data?.id3Tags?.userDefinedText?.find?.(t=>t?.description==='voice')?.value || ''; } }
			}
			// Fallback: item/lang then repo
			let r=await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(lang||'')}`);
			if(!r.ok){ r=await fetch(`/api/read-tags?itemId=${encodeURIComponent(itemId)}&langCode=${encodeURIComponent(lang||'')}&source=repo`); }
			if(!r.ok) return '';
			const data=await r.json(); return data?.id3Tags?.voice || data?.id3Tags?.userDefinedText?.find?.(t=>t?.description==='voice')?.value || '';
		}catch{ return ''; }
	}
	async function getVoiceNameForRow(row){ const id=stripExt(base(row.audio_path||'')); const urls=[]; for(const L of langCandidates(row)){ urls.push(...resolveUrlsFor(L,id)); } const v=await fetchVoiceTag(id, (row.language||'').trim(), urls); return v || ''; }
	
	async function findVoiceIdByName(voiceName){ if(!voiceName) return ''; const sel=document.getElementById('elevenlabsVoice'); if(sel){ for(let i=0;i<sel.options.length;i++){ const txt=(sel.options[i].text||'').trim().toLowerCase(); if(txt===voiceName.trim().toLowerCase()) return sel.options[i].value; } for(let i=0;i<sel.options.length;i++){ const txt=(sel.options[i].text||'').trim().toLowerCase(); if(txt.includes(voiceName.trim().toLowerCase())) return sel.options[i].value; } } try{ const creds=getCredentials(); const key=creds.elevenlabs_api_key||creds.elevenlabsApiKey; if(!key) return ''; const resp=await fetch('/api/elevenlabs-proxy',{headers:{'X-API-KEY':key}}); const data=await resp.json(); const list=data?.voices||[]; let exact=list.find(v=>(v.name||'').trim().toLowerCase()===voiceName.trim().toLowerCase()); if(exact) return exact.voice_id||''; let partial=list.find(v=>(v.name||'').toLowerCase().includes(voiceName.trim().toLowerCase())); return partial?.voice_id||''; }catch{ return ''; } }
	
	async function measureDurationSecondsFromUrl(url){
		return await new Promise((resolve)=>{
			try{
				const a=new Audio();
				a.preload='metadata';
				a.src=url;
				a.addEventListener('loadedmetadata',()=>{ const d=isFinite(a.duration)?a.duration:0; resolve(d||0); },{once:true});
				a.addEventListener('error',()=>resolve(0),{once:true});
			}catch{ resolve(0); }
		});
	}
	
	async function measureDurationSeconds(blob, fallbackAudio){
		try{
			if (fallbackAudio && isFinite(fallbackAudio.duration) && fallbackAudio.duration > 0) return fallbackAudio.duration;
			const arrayBuf = await blob.arrayBuffer();
			const ctx = new (window.AudioContext || window.webkitAudioContext)();
			const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
			return audioBuf.duration || 0;
		}catch{ return 0; }
	}
	
	async function regenerateElevenLabs(text, preferredVoiceId, options){ const creds=getCredentials(); const key=creds.elevenlabs_api_key||creds.elevenlabsApiKey; if(!key) throw new Error('Missing ElevenLabs API key.'); let voiceId=preferredVoiceId||document.getElementById('elevenlabsVoice')?.value||''; if(!voiceId) throw new Error('No voice selected.'); const payload={ text, model_id:'eleven_multilingual_v2', output_format:'mp3_22050_32' };
		// Apply options
		if(options && typeof options.audio_length==='number') payload.audio_length=options.audio_length;
		if(options && typeof options.style==='number'){ payload.voice_settings = payload.voice_settings || {}; payload.voice_settings.style=options.style; }
		const resp=await fetch(`/api/elevenlabs-proxy?voice_id=${encodeURIComponent(voiceId)}`,{ method:'POST', headers:{'Content-Type':'application/json','X-API-KEY':key}, body:JSON.stringify(payload)}); if(!resp.ok) throw new Error(`ElevenLabs error: ${resp.status}`); const blob=await resp.blob(); const url=URL.createObjectURL(blob); const audio=new Audio(url); await new Promise((resolve,reject)=>{ audio.addEventListener('canplaythrough',()=>{ audio.play().then(resolve).catch(reject); },{once:true}); audio.addEventListener('error',()=>reject(new Error('regen play failed')),{once:true}); }); const durationSec = await measureDurationSeconds(blob, audio); return { blob, url, voiceId, durationSec }; }
	
	function blobToDataUrl(blob){ return new Promise((resolve,reject)=>{ const fr=new FileReader(); fr.onload=()=>resolve(fr.result); fr.onerror=reject; fr.readAsDataURL(blob); }); }
	
	function createVm(){
		return createApp({
			setup(){
				const files=ref([]), selectedFile=ref(''), loading=ref(false), error=ref('');
				const search=ref('');
				const matchResults=ref([]); // [{id, filename}]
				const matchCursor=ref(-1);
				const results=ref([]), sortKey=ref('similarity'), sortAsc=ref(false);
				const displayLang=ref(''), voiceName=ref('');
				const lastGen=ref({}); // itemId -> { audioBlob, audioUrl, voiceId, voiceName, durationSec }
				const origDurations=ref({}); // itemId -> seconds
				const regenOpenId=ref('');
				const decorated=computed(()=>results.value.map(r=>({ ...r, filename: base(r.audio_path||'') })));
				const sortedRows=computed(()=>{ const rows=[...decorated.value]; const k=sortKey.value; rows.sort((a,b)=>{ if(k==='filename') return (a.filename||'').localeCompare(b.filename||''); if(k==='similarity') return ((a.elevenlabs_validation||{}).word_level_similarity||((a.elevenlabs_validation||{}).similarity_score||((a.basic_metrics||{}).similarity_ratio||0)))-((b.elevenlabs_validation||{}).word_level_similarity||((b.elevenlabs_validation||{}).similarity_score||((b.basic_metrics||{}).similarity_ratio||0))); if(k==='meaning') return (((typeof a.meaning_similarity==='number')?a.meaning_similarity:0)-((typeof b.meaning_similarity==='number')?b.meaning_similarity:0)); return 0; }); return sortAsc.value?rows:rows.reverse(); });
				
				async function loadFiles(){ try{ const r=await fetch('/api/list-validation-files'); const d=await r.json(); files.value=(d.files||[]).sort().reverse(); if(!selectedFile.value&&files.value.length) selectedFile.value=files.value[0]; }catch(e){ error.value=String(e); } }

				function doSearch(){ try{ const q=(search.value||'').trim().toLowerCase(); if(!q){ return; } const rows=[...decorated.value]; const idx=rows.findIndex(r=> (r.filename||'').toLowerCase().includes(q) || ((r.expected_text||'')+'' ).toLowerCase().includes(q)); if(idx>=0){ const id=rowId(rows[idx]); regenOpenId.value=''; // close any open
					// Clear previous highlights
					document.querySelectorAll('tbody tr').forEach(tr=>tr.classList.remove('row-highlight'));
					// Build all matches and set cursor to first
					matchResults.value = rows.filter(r=> (r.filename||'').toLowerCase().includes(q) || ((r.expected_text||'')+'' ).toLowerCase().includes(q)).map(r=>({ id: rowId(r), filename: r.filename }));
					matchCursor.value = matchResults.value.length ? 0 : -1;
					// Find row element by filename cell match
					let rowEl=null; const cells=document.querySelectorAll('tbody td.audio-path'); for(const c of cells){ if((c.textContent||'').trim()===rows[idx].filename){ rowEl=c.closest('tr'); break; } }
					if(rowEl){ rowEl.classList.add('row-highlight'); rowEl.scrollIntoView({behavior:'smooth', block:'center'}); }
					// Open regen menu for the row to indicate selection
					regenOpenId.value=id; }
				} catch(e){ console.warn('search failed', e); }
				}

				function nextSearch(){ try{ const list=matchResults.value||[]; if(!list.length){ doSearch(); return; } matchCursor.value = (matchCursor.value + 1) % list.length; const cur=list[matchCursor.value]; document.querySelectorAll('tbody tr').forEach(tr=>tr.classList.remove('row-highlight')); let rowEl=null; const cells=document.querySelectorAll('tbody td.audio-path'); for(const c of cells){ if((c.textContent||'').trim()===cur.filename){ rowEl=c.closest('tr'); break; } } if(rowEl){ rowEl.classList.add('row-highlight'); rowEl.scrollIntoView({behavior:'smooth', block:'center'}); } regenOpenId.value=cur.id; } catch(e){ console.warn('nextSearch failed', e); } }
				async function loadSelected(){ if(!selectedFile.value) return; loading.value=true; error.value=''; try{ const r=await fetch(`/api/get-validation-file?name=${encodeURIComponent(selectedFile.value)}`); const d=await r.json(); results.value=Array.isArray(d)?d:[d]; const langs=new Set(results.value.map(x=>x.language).filter(Boolean)); displayLang.value=langs.size?Array.from(langs).join(', '):''; /* defer voiceName fetch to regen/play */ }catch(e){ error.value=String(e); } finally{ loading.value=false; } }
				function setSort(k){ if(sortKey.value===k) sortAsc.value=!sortAsc.value; else { sortKey.value=k; sortAsc.value=true; } }
				
				function rowId(r){ return stripExt(base(r.audio_path||'')); }
				async function ensureOriginalDuration(r){ const id=rowId(r); if(origDurations.value[id]>0) return; for(const L of langCandidates(r)){ const urls=resolveUrlsFor(L,id); for(const u of urls){ const d=await measureDurationSecondsFromUrl(u); if(d>0){ origDurations.value={ ...origDurations.value, [id]: d }; console.log(`Original duration: ${d.toFixed(1)}s for ${id}`); return; } } } }
				function toggleRegen(r){ const id=rowId(r); if(regenOpenId.value!==id){ ensureOriginalDuration(r); } regenOpenId.value = (regenOpenId.value===id ? '' : id); }
				function closeRegen(){ regenOpenId.value=''; }
				
				async function playRow(r){ const id=rowId(r); for(const L of langCandidates(r)){ const ok=await playAny(resolveUrlsFor(L,id)); if(ok) return; } alert('Could not play existing audio.'); }
				async function regenAndPlay(r, options){ try{ const id=rowId(r); await ensureOriginalDuration(r); const urls=[]; for(const L of langCandidates(r)){ urls.push(...resolveUrlsFor(L,id)); } const vName=(await fetchVoiceTag(id, (r.language||'').trim(), urls)) || voiceName.value || ''; const vId=await findVoiceIdByName(vName); const { blob, url, voiceId, durationSec }=await regenerateElevenLabs(r.expected_text||'', vId, options); lastGen.value[id]={ audioBlob:blob, audioUrl:url, voiceId, voiceName:vName, durationSec }; const orig=origDurations.value[id]||0; console.log(`Compare durations for ${id}: original ${orig.toFixed(1)}s vs regenerated ${durationSec.toFixed(1)}s (options: ${JSON.stringify(options||{})})`); closeRegen(); }catch(e){ alert(String(e)); } }
				function chooseRegen(r, choice){ const map={ default:{}, speed_0_9:{ audio_length:0.9 }, speed_0_7:{ audio_length:0.7 }, boost_style:{ style:0.2 } }; const opts=map[choice]||{}; return regenAndPlay(r, opts); }
				async function saveRow(r){ try{ const id=rowId(r); const gen=lastGen.value[id]; if(!gen){ alert('Please regenerate first.'); return; } const langs=langCandidates(r); const langCode=langs[0]||(r.language||'').trim()||'en'; let existingVoice=''; const urls=[]; for(const L of langs){ urls.push(...resolveUrlsFor(L,id)); }
				// Try to enrich voice tag from actual URL if missing
				if(!existingVoice){ existingVoice=await fetchVoiceTag(id, langCode, urls); }
				const voiceTag=gen.voiceName||existingVoice||''; const payload={ audioBase64: await blobToDataUrl(gen.audioBlob), langCode, itemId:id, tags:{ title:id, artist:'Levante Project', album:langCode, service:'ElevenLabs', voice:voiceTag, text:r.expected_text||'', created:new Date().toISOString() } }; const resp=await fetch('/api/save-audio',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)}); if(!resp.ok) throw new Error(`Save failed: ${resp.status}`); alert('Saved to bucket successfully.'); }catch(e){ alert(String(e)); } }
				
				onMounted(()=>{ loadFiles(); document.addEventListener('click', ()=>{ closeRegen(); }); });
				return { files, selectedFile, loading, error, results, sortedRows,
					summary: computed(()=>{ const sims=results.value.map(x=>(x.elevenlabs_validation||{}).word_level_similarity||((x.elevenlabs_validation||{}).similarity_score||((x.basic_metrics||{}).similarity_ratio||0))).filter(x=>typeof x==='number'&&x>0); const meanings=results.value.map(x=> (typeof x.meaning_similarity==='number'?x.meaning_similarity:undefined)).filter(x=>typeof x==='number'); if(!sims.length && !meanings.length) return null; const avg=(sims.length? (sims.reduce((a,b)=>a+b,0)/sims.length):0); const mAvg=(meanings.length? (meanings.reduce((a,b)=>a+b,0)/meanings.length):undefined); return { count:(sims.length||meanings.length), min:Math.min(...(sims.length?sims:[Infinity])), max:Math.max(...(sims.length?sims:[-Infinity])), avg, meaningAvg:mAvg }; }),
					displayLang, voiceName, loadSelected, setSort, playRow, regenAndPlay, saveRow, lastGen, regenOpenId, toggleRegen, chooseRegen, rowId, origDurations, search, doSearch, nextSearch };
			}
		});
	}
	
	if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>{ createVm().mount('#audio-validation-panel'); });
	else createVm().mount('#audio-validation-panel');
})();

(function initAudioValidationToolbar(){
	let applied=false;
	function applyOnce(){
		try{
			if(applied) return;
			const bar=document.querySelector('.validation-controls');
			if(!bar) return;
			// Prefer retarget existing View button
			const viewBtn=document.getElementById('viewValidations');
			if(viewBtn){
				viewBtn.innerHTML='<i class="fas fa-wave-square"></i> Audio Validation';
				viewBtn.onclick=(e)=>{ e.preventDefault(); window.open('./audio-validation.html','_blank'); return false; };
				applied=true; return;
			}
			// Otherwise inject after Clear Cache
			if(!bar.querySelector('.audio-validation-btn')){
				const btn=document.createElement('button');
				btn.className='btn btn-info btn-compact audio-validation-btn';
				btn.innerHTML='<i class="fas fa-wave-square"></i> Audio Validation';
				btn.onclick=(e)=>{ e.preventDefault(); window.open('./audio-validation.html','_blank'); return false; };
				const clearBtn=bar.querySelector('button[onclick*="clearCacheAndReload"]');
				if(clearBtn&&clearBtn.parentElement===bar){ clearBtn.insertAdjacentElement('afterend', btn); }
				else { bar.appendChild(btn); }
				applied=true; return;
			}
		}catch(e){ console.warn('audio-validation toolbar init error', e); }
	}
	// Try immediately, on DOM ready, and observe DOM mutations briefly
	if(document.readyState==='loading'){
		document.addEventListener('DOMContentLoaded', applyOnce);
	}else{
		applyOnce();
	}
	const observer=new MutationObserver(()=>applyOnce());
	observer.observe(document.documentElement,{childList:true,subtree:true});
	setTimeout(applyOnce, 150);
	setTimeout(applyOnce, 500);
	setTimeout(()=>observer.disconnect(), 5000);
})();

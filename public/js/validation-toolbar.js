(function initAudioValidationToolbar(){
	let applied=false;
	function applyOnce(){
		try{
			if(applied) return;
			const bar=document.querySelector('.validation-controls');
			if(!bar) return;
			// Ensure View report button keeps correct label and action (in case of cached or old HTML)
			const viewBtn=document.getElementById('viewValidations');
			if(viewBtn){
				viewBtn.innerHTML='<i class="fas fa-chart-bar"></i> View report';
				viewBtn.onclick=function(){ if(typeof showValidationSummaryReport==='function') showValidationSummaryReport(); };
				viewBtn.title='View summary of all validation results';
			}
			// Audio Validation button intentionally hidden; remove if a cached build injected it.
			const existingAudioBtn=bar.querySelector('.audio-validation-btn');
			if(existingAudioBtn){ existingAudioBtn.remove(); }
			applied=true; return;
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

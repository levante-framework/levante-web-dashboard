(function injectAudioValidationButtonValidationRow(){
	try{
		const controls=document.querySelector('.validation-controls');
		if(!controls||controls.querySelector('.audio-validation-btn')) return;
		controls.style.display='flex';
		controls.style.flexWrap='wrap';
		controls.style.gap='8px';
		const spacer=document.createElement('div');
		spacer.style.flex='1';
		controls.appendChild(spacer);
		const btn=document.createElement('button');
		btn.className='btn btn-info btn-compact audio-validation-btn';
		btn.style.marginLeft='auto';
		btn.innerHTML='<i class="fas fa-wave-square"></i> Audio Validation';
		btn.onclick=openAudioValidationModal;
		controls.appendChild(btn);
	}catch(e){console.warn('injectAudioValidationButtonValidationRow error',e)}
})();

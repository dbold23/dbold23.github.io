// ==================== Review catches — full-screen focus reviewer ====================
// One capture at a time: large spectrogram (freq x time) + readout + verdict.
// Keyboard: Y tag, N noise, S unsure, arrows to navigate. Same API as before.

(function () {
    if (window.SERVER_AUTHED !== true) return;

    var stage = document.getElementById('rv-stage');
    var canvas = document.getElementById('rv-canvas');
    var strip = document.getElementById('rv-strip');
    var empty = document.getElementById('rv-empty');
    var stationSel = document.getElementById('rv-station');
    var confOnly = document.getElementById('rv-conf-only');
    var crispBtn = document.getElementById('rv-crisp');

    var list = [];         // remaining unlabeled candidates
    var cur = 0;
    var total = 0;         // captured total (for progress)
    var smooth = true;

    // phosphor colormap: dark navy -> green -> amber -> red
    var STOPS = [[0,5,8,12],[0.30,10,70,150],[0.55,20,190,130],[0.78,190,215,45],[1,255,90,45]];
    function cmap(t) {
        var a = STOPS[0], b = STOPS[STOPS.length-1];
        for (var i=0;i<STOPS.length-1;i++){ if(t>=STOPS[i][0]&&t<=STOPS[i+1][0]){a=STOPS[i];b=STOPS[i+1];break;} }
        var u=(t-a[0])/((b[0]-a[0])||1);
        return [a[1]+(b[1]-a[1])*u, a[2]+(b[2]-a[2])*u, a[3]+(b[3]-a[3])*u];
    }
    // decode raw uint8 spectrogram into a small offscreen canvas (w x h)
    function toSmall(b64, w, h) {
        var bin = atob(b64), n = bin.length, buf = new Uint8Array(n);
        for (var i=0;i<n;i++) buf[i]=bin.charCodeAt(i);
        var off = document.createElement('canvas'); off.width=w; off.height=h;
        var ctx=off.getContext('2d'), im=ctx.createImageData(w,h);
        for (var p=0;p<w*h;p++){ var v=buf[p]/255, c=cmap(v), k=4*p;
            im.data[k]=c[0]; im.data[k+1]=c[1]; im.data[k+2]=c[2]; im.data[k+3]=255; }
        ctx.putImageData(im,0,0);
        return off;
    }
    // draw a small canvas scaled up into a big target canvas
    function blit(target, small, doSmooth) {
        var r = window.devicePixelRatio || 1;
        var W = target.clientWidth, H = target.clientHeight;
        target.width = W*r; target.height = H*r;
        var ctx = target.getContext('2d');
        ctx.imageSmoothingEnabled = doSmooth;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0,0,target.width,target.height);
        ctx.drawImage(small, 0,0,small.width,small.height, 0,0,target.width,target.height);
    }

    function fmtWhen(ts){ try { return ts? new Date(ts*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—'; } catch(e){ return '—'; } }

    // heuristic descriptor to orient the reviewer (never a verdict — just a nudge)
    function hintFor(c){
        var snr = c.meta && c.meta.change_db;
        if (c.meta && c.meta.reason==='unlisted') return 'Flagged as an unlisted frequency — not on the station whitelist. Confirm whether it is a genuine tag or stray RF.';
        if (c.meta && c.meta.reason==='locked') return 'The station locked onto this as a repeating pulse train. A clean vertical stripe here confirms it.';
        if (snr!=null && snr>=15) return 'Strong detection. A real tag reads as a compact bright mark at one frequency (a vertical stripe over a few ms).';
        if (snr!=null && snr<7) return 'Marginal — barely above the noise floor. These are the calls that matter most: look for a localized mark vs. a broadband smear or a full-height carrier.';
        return 'Look for a narrow, time-limited bright mark near the center line. Full-height stripes = continuous carrier; full-width flashes = impulsive RFI.';
    }

    // ---- per-card signal auto-read -------------------------------------
    // The card spans only ~256 ms, so a tag's 1-2 s cadence can never repeat
    // inside one window: a REAL tag is exactly one 14-20 ms burst. Anything
    // lit the whole window is a carrier; anything repeating in-window is
    // modulated RFI (60 Hz mains hum shows up as ~17 ms bands).
    function decodeBuf(b64){
        var bin = atob(b64 || ''); var a = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
        return a;
    }

    function analyzeCard(c){
        var w = c.img_w||41, h = c.img_h||64, buf = decodeBuf(c.img_b64);
        if (buf.length < w*h || h < 8) return null;
        var wms = (c.meta && c.meta.window_ms) ? +c.meta.window_ms : 256;
        var msPerRow = wms / h;
        var prof = new Array(h);
        for (var r = 0; r < h; r++){
            var m = 0;
            for (var col = 0; col < w; col++){ var v = buf[r*w+col]; if (v > m) m = v; }
            prof[r] = m;
        }
        // Carrier check FIRST, along the frequency axis: a continuous
        // carrier lights one column in (nearly) every time row, which makes
        // the row-max profile flat — the burst logic below can't see it.
        var gsorted = [];
        for (var gi = 0; gi < w*h; gi += 7) gsorted.push(buf[gi]);
        gsorted.sort(function(a,b){ return a-b; });
        var gmed = gsorted[Math.floor(gsorted.length/2)];
        var gmax = gsorted[gsorted.length-1];
        var bestCol = 0, bestSum = -1;
        for (var cc = 0; cc < w; cc++){
            var su = 0;
            for (var rr = 0; rr < h; rr++) su += buf[rr*w+cc];
            if (su > bestSum){ bestSum = su; bestCol = cc; }
        }
        var colThr = gmed + 0.35*(gmax - gmed), lit = 0;
        for (var r4 = 0; r4 < h; r4++) if (buf[r4*w+bestCol] > colThr) lit++;
        if (gmax - gmed >= 25 && lit/h > 0.85)
            return { cls:'bad', chip:'✗ carrier', runs:[],
                     text:'Continuous carrier — one frequency lit for the entire '+Math.round(wms)+' ms window (the solid vertical stripe). A tag beeps ~15–20 ms then goes silent for 1–2 s. Not a tag.' };

        var sorted = prof.slice().sort(function(a,b){ return a-b; });
        var floor = sorted[Math.floor(h*0.25)], peak = sorted[h-1];
        if (peak - floor < 25 && gmax - gmed < 25)
            return { cls:'', runs:[], text:'No clear signal above the noise floor in this window.' };
        var thr = floor + 0.5*(peak - floor);
        var act = prof.map(function(v){ return v > thr; });
        var duty = act.filter(Boolean).length / h;
        var runs = [], s = -1;
        for (var i2 = 0; i2 < h; i2++){
            if (act[i2] && s < 0) s = i2;
            if ((!act[i2] || i2 === h-1) && s >= 0){ runs.push([s, (act[i2] ? i2 : i2-1)]); s = -1; }
        }
        var longest = 0;
        runs.forEach(function(r2){ longest = Math.max(longest, r2[1]-r2[0]+1); });
        var longestMs = longest * msPerRow;
        // autocorrelation of the time profile -> in-window repetition period
        var mean = prof.reduce(function(a,b){ return a+b; }, 0) / h;
        var x = prof.map(function(v){ return v - mean; });
        var denom = x.reduce(function(a,b){ return a + b*b; }, 0) || 1;
        var bestLag = 0, bestR = 0;
        for (var lag = 2; lag <= h/2; lag++){
            var num2 = 0;
            for (var j = 0; j + lag < h; j++) num2 += x[j]*x[j+lag];
            var r3 = num2/denom;
            if (r3 > bestR){ bestR = r3; bestLag = lag; }
        }
        var periodMs = bestLag * msPerRow;
        if (duty > 0.9)
            return { cls:'bad', chip:'✗ carrier', runs:runs,
                     text:'Continuous carrier — lit for the entire '+Math.round(wms)+' ms window. A tag beeps ~15–20 ms then goes silent for 1–2 s. Not a tag.' };
        if (bestR > 0.45 && runs.length >= 3)
            return { cls:'bad', chip:'✗ repeating RFI', runs:runs,
                     text:'Repeats every ~'+periodMs.toFixed(0)+' ms inside one window ('+runs.length+'×). Real tag pulses are 1–2 s apart — in-window repetition is modulated interference'+((periodMs>13&&periodMs<21)?' (60 Hz mains hum)':'')+'. Not a tag.' };
        if (runs.length === 1 && longestMs >= 8 && longestMs <= 30 && duty < 0.35)
            return { cls:'good', chip:'✓ tag-like', runs:runs,
                     text:'Single '+longestMs.toFixed(0)+' ms burst, then silence — matches a real tag pulse (14–20 ms).' };
        return { cls:'', runs:runs,
                 text: runs.length ? runs.length+' burst(s), longest '+longestMs.toFixed(0)+' ms, '+(100*duty).toFixed(0)+'% of window active — judge by eye.'
                                   : 'Diffuse energy — no clear pulse structure.' };
    }

    function drawOverlay(target, c, analysis){
        var wms = (c.meta && c.meta.window_ms) ? +c.meta.window_ms : 256;
        var h = c.img_h || 64;
        var ctx = target.getContext('2d');
        var W = target.width, H = target.height, r = window.devicePixelRatio || 1;
        ctx.save();
        // 50 ms ruler (time runs top -> bottom)
        ctx.strokeStyle = 'rgba(255,255,255,0.30)';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1*r; ctx.font = (10*r)+'px ui-monospace,monospace';
        ctx.setLineDash([4*r, 4*r]);
        for (var t2 = 50; t2 < wms; t2 += 50){
            var y = H * t2 / wms;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
            ctx.fillText(t2+' ms', 4*r, y - 3*r);
        }
        ctx.setLineDash([]);
        // expected tag-pulse-length bracket at the right edge
        var puls = H * 17 / wms, x0 = W - 8*r, yTop = 6*r;
        ctx.strokeStyle = 'rgba(51,224,161,0.95)'; ctx.lineWidth = 2*r;
        ctx.beginPath();
        ctx.moveTo(x0-4*r, yTop); ctx.lineTo(x0, yTop);
        ctx.lineTo(x0, yTop+puls); ctx.lineTo(x0-4*r, yTop+puls);
        ctx.stroke();
        ctx.fillStyle = 'rgba(51,224,161,0.95)';
        ctx.save();
        ctx.translate(W - 12*r, yTop + puls/2 + 40*r); ctx.rotate(-Math.PI/2);
        ctx.fillText('one tag pulse ≈17 ms', 0, 0);
        ctx.restore();
        // amber markers on the left edge where bursts were measured
        if (analysis && analysis.runs && analysis.runs.length){
            ctx.fillStyle = 'rgba(255,196,0,0.9)';
            analysis.runs.forEach(function(rn){
                var y0 = H*rn[0]/h, y1 = H*(rn[1]+1)/h;
                ctx.fillRect(0, y0, 3*r, Math.max(2*r, y1-y0));
            });
        }
        ctx.restore();
    }

    function render() {
        if (!list.length) { stage.style.display='none'; strip.style.display='none';
            document.querySelector('.rv-progress').style.display='none';
            document.querySelector('.rv-progress-meta').style.display='none';
            empty.style.display='block'; return; }
        cur = Math.max(0, Math.min(cur, list.length-1));
        var c = list[cur];
        blit(canvas, toSmall(c.img_b64, c.img_w||41, c.img_h||64), smooth);
        var auto = null;
        try { auto = analyzeCard(c); } catch (e) { /* overlay is advisory only */ }
        try { drawOverlay(canvas, c, auto); } catch (e) { /* ditto */ }

        var mhz=(c.freq_khz/1000);
        document.getElementById('rv-freq').innerHTML = mhz.toFixed(3)+' <small>MHz</small>';
        var snr=(c.meta&&c.meta.change_db!=null)?(+c.meta.change_db).toFixed(1)+' dB':'—';
        document.getElementById('rv-snr').textContent = snr;
        document.getElementById('rv-stn').textContent = c.station_id||'—';
        document.getElementById('rv-when').textContent = fmtWhen(c.ts);
        var peak=(c.meta&&c.meta.power_db!=null)?(+c.meta.power_db).toFixed(0)+' dB':'—';
        document.getElementById('rv-peak').textContent = peak;
        var wms=(c.meta&&c.meta.window_ms)?Math.round(c.meta.window_ms):128;
        var tspan=document.getElementById('rv-tspan'); if(tspan) tspan.innerHTML='0&ndash;'+wms+' ms';
        var hintEl = document.getElementById('rv-hint');
        hintEl.textContent = (auto && auto.text) ? auto.text : hintFor(c);
        hintEl.className = 'rv-hint' + (auto && auto.cls ? ' rv-auto-'+auto.cls : '');

        var reason=(c.meta&&c.meta.reason)||''; var badge='';
        if (reason==='locked') badge='<span class="rv-badge rv-badge-lock">&#128274; locked</span>';
        else if (reason==='unlisted') badge='<span class="rv-badge rv-badge-unl">unlisted</span>';
        if (auto && auto.chip) badge += ' <span class="rv-badge rv-auto-'+auto.cls+'">'+auto.chip+'</span>';
        document.getElementById('rv-badges').innerHTML = badge;

        // progress
        var done = total - list.length;
        document.getElementById('rv-pos').textContent = (cur+1)+' / '+list.length+' to review';
        document.getElementById('rv-remain').textContent = done+' labeled of '+total;
        document.getElementById('rv-progbar').style.width = total? (100*done/total)+'%' : '0%';

        // filmstrip
        strip.innerHTML='';
        list.forEach(function(item, i){
            var t=document.createElement('div'); t.className='rv-thumb'+(i===cur?' cur':'');
            var cv=document.createElement('canvas'); cv.width=item.img_w||41; cv.height=item.img_h||64;
            cv.getContext('2d').drawImage(toSmall(item.img_b64, cv.width, cv.height),0,0);
            t.appendChild(cv); t.onclick=function(){ cur=i; render(); };
            strip.appendChild(t);
        });
        var curThumb = strip.children[cur]; if (curThumb) curThumb.scrollIntoView({inline:'center', block:'nearest'});
    }

    function bump(value){
        if (value==='tag'){ var t=document.getElementById('rv-tag'); t.textContent=(+t.textContent||0)+1; }
        if (value==='noise'){ var n=document.getElementById('rv-noise'); n.textContent=(+n.textContent||0)+1; }
    }

    async function label(value) {
        if (!list.length) return;
        var c = list[cur];
        stage.classList.remove('flash-tag','flash-noise');
        if (value==='tag') void stage.offsetWidth, stage.classList.add('flash-tag');
        if (value==='noise') void stage.offsetWidth, stage.classList.add('flash-noise');
        try {
            var r = await fetch('/api/v1/admin/candidates/'+c.id+'/label', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body: JSON.stringify({label:value})
            });
            if (!r.ok) throw new Error('save failed');
            list.splice(cur,1); bump(value);
            render();
        } catch(e) { alert('Could not save label: '+e.message); }
    }

    var freqFilter = new URLSearchParams(location.search).get('freq');
    if (freqFilter) {
        var chip = document.createElement('span');
        chip.className = 'rs-pill rs-pill-green';
        chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        chip.innerHTML = 'Verifying ' + (parseInt(freqFilter,10)/1000).toFixed(3) +
            ' MHz <a href="/review" style="color:inherit;text-decoration:none;font-weight:700;" title="Clear frequency filter">&times;</a>';
        var fl = document.querySelector('.rs-filters');
        if (fl) fl.insertBefore(chip, fl.firstChild);
    }

    async function load() {
        var q='only_unlabeled=true';
        if (freqFilter) q+='&freq_khz='+encodeURIComponent(freqFilter);
        if (stationSel.value) q+='&station_id='+encodeURIComponent(stationSel.value);
        var r=await fetch('/api/v1/admin/candidates?'+q);
        var d=await r.json();
        list = d.candidates||[];
        if (confOnly && confOnly.checked) list=list.filter(function(c){ return c.meta&&c.meta.reason; });
        total = (d.counts && d.counts.total) || list.length;
        cur=0;
        empty.style.display='none';
        stage.style.display=''; strip.style.display='';
        document.querySelector('.rv-progress').style.display='';
        document.querySelector('.rv-progress-meta').style.display='';
        render();
    }

    document.getElementById('rv-btn-tag').onclick=function(){ label('tag'); };
    document.getElementById('rv-btn-noise').onclick=function(){ label('noise'); };
    document.getElementById('rv-btn-unsure').onclick=function(){ label('unsure'); };
    document.getElementById('rv-btn-prev').onclick=function(){ cur--; render(); };
    document.getElementById('rv-btn-next').onclick=function(){ cur++; render(); };
    crispBtn.onclick=function(){ smooth=!smooth; crispBtn.textContent=smooth?'◍ smooth':'▦ crisp'; render(); };

    document.addEventListener('keydown', function(e){
        if (!list.length || e.target.tagName==='SELECT' || e.target.tagName==='INPUT') return;
        var k=e.key.toLowerCase();
        if (k==='y'){ label('tag'); e.preventDefault(); }
        else if (k==='n'){ label('noise'); e.preventDefault(); }
        else if (k==='s'){ label('unsure'); e.preventDefault(); }
        else if (k==='arrowright'||k===' '){ cur++; render(); e.preventDefault(); }
        else if (k==='arrowleft'){ cur--; render(); e.preventDefault(); }
    });
    stationSel.addEventListener('change', load);
    if (confOnly) confOnly.addEventListener('change', load);
    window.addEventListener('resize', function(){ if (list.length) render(); });
    load();
})();

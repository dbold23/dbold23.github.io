// ==================== RelayStation Central — Range calibration page ====================
// Phone-first field tool: start a session, stream GPS breadcrumbs while walking
// a test tag away from a station, poll the station's live signal, and render
// the server-computed coverage raster + path-loss fit on a map.
//
// The phone only ever reports WHERE it is; every correlation with WHAT the
// station heard happens server-side from the events table, so a dropped
// connection mid-walk loses nothing but breadcrumbs.

(function () {
    'use strict';

    var PAGE = JSON.parse(document.getElementById('rs-range-data').textContent);
    // localStorage (NOT sessionStorage): a pocketed phone's browser gets
    // evicted all the time, and the walk must survive that, not just a reload.
    var STORE_KEY = 'rsRangeActive';
    var BUF_KEY = 'rsRangeBuffer';       // undelivered breadcrumbs
    var PENDING_KEY = 'rsRangePending';  // walk ended offline: tail + end intent
    var PENDING_RETRY_MS = 20000;

    // Recording cadence. GPS callbacks can fire many times a second; one
    // breadcrumb every RECORD_EVERY_S is plenty for 25 m cells, and one
    // upload every FLUSH_EVERY_MS keeps the radio mostly idle.
    var RECORD_EVERY_S = 3;
    var FLUSH_EVERY_MS = 5000;
    var LIVE_POLL_MS = 3000;
    var RESULTS_POLL_MS = 20000;
    var MAX_ACCURACY_M = 75;   // worse than this and the point would smear the raster

    // Map overlays sit on the fixed light CARTO tiles, not on the themed page,
    // so these are deliberate literals rather than theme tokens.
    // Sequential single-hue ramps (light->dark = less->more), CVD-safe by
    // lightness ordering. Blues: detection rate. Oranges: signal dB.
    var RAMP_RATE = ['#c6dbef', '#9ecae1', '#6baed6', '#3182bd', '#08519c'];
    var RAMP_RSSI = ['#fdd0a2', '#fdae6b', '#fd8d3c', '#e6550d', '#a63603'];
    var COLOR_SILENT = '#9ca3af';   // visited, heard nothing — the negative result
    var COLOR_TRACK = '#6b7280';
    var COLOR_STATION = '#0c9b62';
    var COLOR_ME = '#2563eb';

    var session = null;        // {sid, stationId, freqKhz, stLat, stLon, ppm, startedTs}
    var gpsWatchId = null;
    var buffer = [];
    var lastRecordedTs = 0;
    var timers = { flush: null, live: null, results: null, elapsed: null };
    var wakeLock = null;
    var lastResults = null;
    var flushing = false;
    var pendingTimer = null;
    var lastHeardTs = 0;       // newest detection timestamp seen (any source)

    var map = null;
    var stationMarker = null, meMarker = null, meAccCircle = null, rangeRing = null;
    var trackLine = null, rasterLayer = null, samplesLayer = null;
    var mapLayerMode = 'rate';
    var mapFittedOnce = false;

    function $(id) { return document.getElementById(id); }

    function fmtM(m) {
        if (m == null || !isFinite(m)) return '—';
        return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2) + ' km';
    }

    function fmtMhz(khz) { return (khz / 1000).toFixed(3) + ' MHz'; }

    // ==================== setup card ====================

    function populateSetup() {
        var stSel = $('rs-range-station');
        stSel.innerHTML = PAGE.stations.map(function (s) {
            return '<option value="' + escapeHtml(s.station_id) + '">' +
                escapeHtml(s.station_id) +
                (s.status === 'online' ? '' : ' (' + escapeHtml(s.status) + ')') +
                '</option>';
        }).join('') || '<option value="">No stations registered</option>';
        stSel.onchange = updateCoordsWarning;
        // The station page's "Range test" button lands here with ?station=
        try {
            var want = new URLSearchParams(location.search).get('station');
            if (want && PAGE.stations.some(function (s) { return s.station_id === want; })) {
                stSel.value = want;
            }
        } catch (e) { /* ancient browser — default selection is fine */ }
        updateCoordsWarning();

        var fSel = $('rs-range-freq');
        fSel.innerHTML = PAGE.frequencies.map(function (f) {
            // An <option> cannot hold markup, so the species arrives as text.
            var sp = (f.species && f.species.label)
                ? ' (' + f.species.label + (f.species.certain ? '' : '?') + ')' : '';
            return '<option value="' + f.frequency_khz + '">' + fmtMhz(f.frequency_khz) +
                (f.label ? ' — ' + escapeHtml(f.label) : '') + escapeHtml(sp) + '</option>';
        }).join('') + '<option value="custom">Custom frequency…</option>';
        fSel.onchange = function () {
            $('rs-range-custom-freq').style.display =
                fSel.value === 'custom' ? 'block' : 'none';
        };
        // On a fresh install the list is empty, "Custom" is pre-selected,
        // and no change event ever fires — sync visibility once now.
        fSel.onchange();

        $('rs-range-use-loc').onclick = function () {
            if (!navigator.geolocation) return;
            setStatus('Getting your position…');
            navigator.geolocation.getCurrentPosition(function (pos) {
                $('rs-range-st-lat').value = pos.coords.latitude.toFixed(6);
                $('rs-range-st-lon').value = pos.coords.longitude.toFixed(6);
                setStatus('');
            }, function (err) {
                setStatus('Could not get position: ' + err.message);
            }, { enableHighAccuracy: true, timeout: 15000 });
        };

        $('rs-range-start').onclick = startWalk;
        $('rs-range-stop').onclick = stopWalk;
        $('rs-range-new').onclick = resetToSetup;
        $('rs-range-layer-rate').onclick = function () { setLayerMode('rate'); };
        $('rs-range-layer-rssi').onclick = function () { setLayerMode('rssi'); };
    }

    function selectedStation() {
        var id = $('rs-range-station').value;
        for (var i = 0; i < PAGE.stations.length; i++) {
            if (PAGE.stations[i].station_id === id) return PAGE.stations[i];
        }
        return null;
    }

    function updateCoordsWarning() {
        var s = selectedStation();
        $('rs-range-coords-warn').style.display =
            (s && (s.latitude == null || s.longitude == null)) ? 'block' : 'none';
    }

    function setStatus(msg, isError) {
        var el = $('rs-range-setup-status');
        el.textContent = msg || '';
        el.style.color = isError ? 'var(--rs-red)' : '';
    }

    function chosenFreqKhz() {
        var v = $('rs-range-freq').value;
        if (v !== 'custom') return parseInt(v, 10);
        var mhz = parseFloat($('rs-range-custom-input').value);
        return isFinite(mhz) ? Math.round(mhz * 1000) : NaN;
    }

    // ==================== persistence ====================
    // Belt and braces for field use: the active-session record and the
    // undelivered breadcrumb buffer both live in localStorage, so a killed
    // browser resumes the walk AND still delivers every fix it recorded
    // (uploads are idempotent server-side, so replays are safe).

    function loadSessionState() {
        try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); }
        catch (e) { return null; }
    }
    function saveSessionState() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(session)); } catch (e) {}
    }
    function clearSessionState() {
        try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    }
    function saveBuffer() {
        try { localStorage.setItem(BUF_KEY, JSON.stringify(buffer.slice(-2000))); }
        catch (e) { /* quota — the in-memory buffer still flushes */ }
    }
    function loadBufferStore() {
        try { return JSON.parse(localStorage.getItem(BUF_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function clearBufferStore() {
        try { localStorage.removeItem(BUF_KEY); } catch (e) {}
    }

    // ==================== session lifecycle ====================

    async function startWalk() {
        var st = selectedStation();
        if (!st) { setStatus('Pick a station first.', true); return; }
        var freqKhz = chosenFreqKhz();
        if (!isFinite(freqKhz) || freqKhz <= 0) {
            setStatus('Enter the tag frequency in MHz.', true); return;
        }
        if (!navigator.geolocation) {
            setStatus('This browser has no GPS. Range walks need a phone on HTTPS.', true);
            return;
        }

        var body = { station_id: st.station_id, frequency_khz: freqKhz };
        if (st.latitude == null || st.longitude == null) {
            var lat = parseFloat($('rs-range-st-lat').value);
            var lon = parseFloat($('rs-range-st-lon').value);
            if (!isFinite(lat) || !isFinite(lon)) {
                setStatus('Station position needed — use your location while standing at the antenna.', true);
                return;
            }
            body.station_latitude = lat;
            body.station_longitude = lon;
            // Pin the station for good: the coordinates typed (or taken from
            // the phone at the antenna) are worth keeping beyond this session.
            fetch('/api/v1/admin/stations/' + encodeURIComponent(st.station_id) + '/location', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ latitude: lat, longitude: lon })
            }).then(function (r) {
                if (r.ok) { st.latitude = lat; st.longitude = lon; updateCoordsWarning(); }
            }).catch(function () { /* session-local coords still work */ });
        }

        var btn = $('rs-range-start');
        btn.disabled = true;
        setStatus('Starting session…');
        try {
            var r = await fetch('/api/v1/range/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            var data = await r.json();
            if (!r.ok) throw new Error(data.detail || 'Could not start session');
            session = {
                sid: data.session_id,
                stationId: st.station_id,
                freqKhz: freqKhz,
                stLat: data.station_latitude,
                stLon: data.station_longitude,
                ppm: data.pulse_rate_ppm,
                startedTs: Math.round(Date.now() / 1000)
            };
            // A previous walk's undelivered breadcrumbs must not be posted
            // into this session's track.
            buffer.length = 0;
            clearBufferStore();
            lastRecordedTs = 0;
            lastHeardTs = 0;
            lastResults = null;
            mapFittedOnce = false;
            saveSessionState();
            setStatus('');
            enterActiveMode();
        } catch (e) {
            setStatus(e.message, true);
        } finally {
            btn.disabled = false;
        }
    }

    function enterActiveMode() {
        $('rs-range-setup').style.display = 'none';
        $('rs-range-active').style.display = 'block';
        $('rs-range-results').style.display = 'none';
        $('rs-range-map-wrap').style.display = 'block';
        $('rs-range-active-freq').textContent = fmtMhz(session.freqKhz) +
            ' at ' + session.stationId;
        $('rs-range-session-label').textContent = session.sid;

        initMap();
        startGPS();
        acquireWakeLock();
        timers.flush = setInterval(flushBuffer, FLUSH_EVERY_MS);
        timers.live = setInterval(pollLive, LIVE_POLL_MS);
        timers.results = setInterval(refreshResults, RESULTS_POLL_MS);
        timers.elapsed = setInterval(updateElapsed, 1000);
        pollLive();
        refreshResults();
    }

    async function stopWalk() {
        var btn = $('rs-range-stop');
        btn.disabled = true;
        btn.textContent = 'Ending…';
        stopGPS();
        Object.keys(timers).forEach(function (k) {
            if (timers[k]) { clearInterval(timers[k]); timers[k] = null; }
        });
        releaseWakeLock();
        // Last breadcrumbs must land before the session closes — wait out any
        // in-flight flush, then send what's left.
        while (flushing) { await new Promise(function (r) { setTimeout(r, 150); }); }
        await flushBuffer();
        var endOk = false;
        try {
            var er = await fetch('/api/v1/range/sessions/' + session.sid + '/end', { method: 'POST' });
            endOk = er.ok;
        } catch (e) { /* offline — parked below */ }
        // A dead zone at End loses nothing: the undelivered tail and the end
        // intent are parked in localStorage, and finishPending() delivers
        // both (points first — the server refuses tracks on ended sessions)
        // once coverage returns, even after a browser restart.
        if (buffer.length || !endOk) {
            setPending({ sid: session.sid, points: buffer.slice(), end: !endOk });
            schedulePending();
        }
        buffer = [];
        clearBufferStore();
        clearSessionState();

        $('rs-range-active').style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'End walk';
        await refreshResults();
        if (lastResults) {
            renderResults();
        } else {
            // Offline at the moment of ending: the walk is saved server-side
            // but there is nothing to render, and the results card holds the
            // only "New walk" button — reopen setup so the page isn't a dead
            // end. The walk stays viewable under Past walks.
            $('rs-range-setup').style.display = 'block';
            setStatus('Walk saved, but results could not be fetched — ' +
                      'open it from Past walks when back online.', true);
        }
        loadSessions();
    }

    function resetToSetup() {
        session = null;
        lastResults = null;
        mapFittedOnce = false;
        $('rs-range-results').style.display = 'none';
        $('rs-range-map-wrap').style.display = 'none';
        $('rs-range-setup').style.display = 'block';
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // Refresh survives a page reload mid-walk: the session lives server-side,
    // so we just re-attach GPS + polling to it.
    async function tryResume() {
        if (session) return;   // a walk already started while this page loaded
        var stored = loadSessionState();
        if (!stored) return;
        try {
            var r = await fetch('/api/v1/range/sessions?active_only=true');
            var data = await r.json();
            // Re-check: the user may have started a NEW walk while the fetch
            // was in flight — resuming now would double every timer and send
            // breadcrumbs to the old session.
            if (session) return;
            var alive = (data.sessions || []).some(function (s) {
                return s.session_id === stored.sid;
            });
            if (alive) {
                session = stored;
                // Breadcrumbs recorded before the browser died still count.
                buffer = loadBufferStore();
                enterActiveMode();
            } else {
                // Ended or deleted elsewhere — leftover fixes are
                // undeliverable (the server refuses tracks on ended
                // sessions), so drop them rather than retry forever.
                clearSessionState();
                clearBufferStore();
            }
        } catch (e) { /* offline — leave stored session for the next load */ }
    }

    // ==================== pending delivery (walk ended offline) ====================

    function readPending() {
        try { return JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); }
        catch (e) { return null; }
    }
    function setPending(p) {
        try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) {}
        showPendingNote();
    }
    function clearPending() {
        try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
        var n = $('rs-range-pending-note');
        if (n) n.style.display = 'none';
    }
    function showPendingNote() {
        var p = readPending();
        var n = $('rs-range-pending-note');
        if (!n || !p) return;
        n.textContent = p.points.length
            ? p.points.length + ' GPS fixes from your last walk are still on ' +
              'this phone — they upload automatically when you are back online.'
            : 'Finishing your last walk when back online…';
        n.style.display = 'block';
    }
    function schedulePending() {
        if (!pendingTimer) pendingTimer = setInterval(finishPending, PENDING_RETRY_MS);
    }

    async function finishPending() {
        var p = readPending();
        if (!p) {
            if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
            return;
        }
        try {
            while (p.points.length) {
                var batch = p.points.slice(0, 400);
                var r = await fetch('/api/v1/range/sessions/' + p.sid + '/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ points: batch,
                                           client_now: Date.now() / 1000 })
                });
                if (r.ok) {
                    p.points = p.points.slice(batch.length);
                    setPending(p);
                } else if (r.status >= 400 && r.status < 500) {
                    // Ended or deleted meanwhile — undeliverable for good.
                    p.points = [];
                    setPending(p);
                } else {
                    return;   // server trouble — the timer retries
                }
            }
            if (p.end) {
                var er = await fetch('/api/v1/range/sessions/' + p.sid + '/end',
                                     { method: 'POST' });
                if (!er.ok && er.status !== 404) return;
            }
            clearPending();
            if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
            loadSessions();
        } catch (e) { /* still offline — the timer keeps trying */ }
    }

    // ==================== GPS ====================

    function startGPS() {
        setGpsPill('amber', 'GPS acquiring…');
        gpsWatchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
            enableHighAccuracy: true,
            maximumAge: 2000,
            timeout: 20000
        });
    }

    function stopGPS() {
        if (gpsWatchId != null) {
            navigator.geolocation.clearWatch(gpsWatchId);
            gpsWatchId = null;
        }
    }

    function onPosition(pos) {
        var acc = pos.coords.accuracy;
        var lat = pos.coords.latitude, lon = pos.coords.longitude;
        var cls = acc <= 15 ? 'green' : (acc <= 35 ? 'amber' : 'red');
        setGpsPill(cls, 'GPS ±' + Math.round(acc) + ' m');
        updateMeMarker(lat, lon, acc);

        if (acc > MAX_ACCURACY_M) return;   // shown on the map, not recorded
        var ts = Math.round((pos.timestamp || Date.now()) / 1000);
        if (ts - lastRecordedTs < RECORD_EVERY_S) return;
        lastRecordedTs = ts;
        buffer.push({ t: ts, lat: lat, lon: lon, acc: Math.round(acc * 10) / 10 });
        saveBuffer();
    }

    function onGpsError(err) {
        setGpsPill('red', 'GPS: ' + (err.code === 1 ? 'permission denied' : err.message));
    }

    function setGpsPill(cls, text) {
        var pill = $('rs-range-gps-pill');
        pill.className = 'rs-pill rs-pill-' + cls;
        pill.textContent = text;
    }

    async function flushBuffer() {
        if (!session || !buffer.length || flushing) return;
        flushing = true;
        try {
            // Chunked: after a long dead spot the buffer can exceed the
            // server's 500-point batch cap, and an oversized POST would 413
            // on every retry forever. Drain in slices instead.
            while (buffer.length) {
                var batch = buffer.splice(0, 400);
                var r;
                try {
                    r = await fetch('/api/v1/range/sessions/' + session.sid + '/track', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        // client_now lets the server shift a skewed phone
                        // clock onto server time before correlating
                        body: JSON.stringify({ points: batch,
                                               client_now: Date.now() / 1000 })
                    });
                } catch (e) {
                    // Network error — put the batch back so breadcrumbs
                    // survive the dead spot and land with the next flush.
                    buffer = batch.concat(buffer);
                    saveBuffer();
                    return;
                }
                if (r.status >= 400 && r.status < 500) {
                    // The server understood us and said no — the session has
                    // ended or been deleted. Retrying can never succeed, and
                    // stale points must not leak into a future session.
                    buffer.length = 0;
                    clearBufferStore();
                    return;
                }
                if (!r.ok) { buffer = batch.concat(buffer); saveBuffer(); return; }
                saveBuffer();
                var data = await r.json();
                if (data.distance_m != null) {
                    $('rs-range-stat-dist').textContent = fmtM(data.distance_m);
                }
            }
        } finally {
            flushing = false;
        }
    }

    // ==================== screen wake lock ====================
    // A pocketed, sleeping phone stops getting GPS callbacks. Best-effort:
    // not every browser supports it, and that's fine.

    async function acquireWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                wakeLock = await navigator.wakeLock.request('screen');
            }
        } catch (e) { wakeLock = null; }
    }

    function releaseWakeLock() {
        if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && session && gpsWatchId != null) {
            acquireWakeLock();
        }
    });

    // ==================== live stats ====================

    async function pollLive() {
        if (!session) return;
        try {
            var r = await fetch('/api/v1/test/live-signal?station_id=' +
                encodeURIComponent(session.stationId) +
                '&frequency_khz=' + session.freqKhz + '&seconds=10');
            if (!r.ok) return;
            var data = await r.json();
            var s = data.stats || {};
            $('rs-range-stat-signal').textContent =
                s.current_signal != null ? s.current_signal.toFixed(0) : '—';
            $('rs-range-stat-dets').textContent = s.detection_count || 0;
            (data.detections || []).forEach(function (d) {
                if (d.timestamp > lastHeardTs) lastHeardTs = d.timestamp;
            });
        } catch (e) { /* transient — next poll */ }
    }

    function updateElapsed() {
        if (!session) return;
        var secs = Math.max(0, Math.round(Date.now() / 1000) - session.startedTs);
        var m = Math.floor(secs / 60), s = secs % 60;
        $('rs-range-stat-elapsed').textContent = m + ':' + (s < 10 ? '0' : '') + s;
        if (lastResults) {
            $('rs-range-stat-points').textContent =
                (lastResults.track || []).length + buffer.length;
        }
        // "Last heard" makes uplink lag legible: on cellular, detection
        // batches arrive 15-60 s late, and without this line a working walk
        // reads as a dead one.
        var lh = $('rs-range-lastheard');
        if (lh) {
            if (!lastHeardTs) {
                lh.textContent = 'Not heard yet — station batches can lag a ' +
                    'minute or two on cellular.';
                lh.style.color = '';
            } else {
                var ago = Math.max(0, Math.round(Date.now() / 1000) - lastHeardTs);
                lh.textContent = 'Last heard ' +
                    (ago < 60 ? ago + ' s' : Math.round(ago / 60) + ' min') + ' ago';
                lh.style.color = ago > 90 ? 'var(--rs-amber)' : '';
            }
        }
    }

    // ==================== map ====================

    function initMap() {
        if (!map) {
            var el = $('rs-range-map');
            if (!el || typeof L === 'undefined') return;
            map = L.map('rs-range-map');
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
                maxZoom: 19
            }).addTo(map);
            rasterLayer = L.layerGroup().addTo(map);
            samplesLayer = L.layerGroup();
            trackLine = L.polyline([], { color: COLOR_TRACK, weight: 2, opacity: 0.7 }).addTo(map);
            stationMarker = L.circleMarker([session.stLat, session.stLon], {
                radius: 9, color: COLOR_STATION, fillColor: COLOR_STATION,
                fillOpacity: 0.9, weight: 2
            }).addTo(map);
        }
        // Re-entry (second walk, or viewing a past one): point everything at
        // the current session and drop the previous walk's overlays.
        stationMarker.setLatLng([session.stLat, session.stLon]);
        stationMarker.bindPopup('<b>' + escapeHtml(session.stationId) + '</b><br>station');
        rasterLayer.clearLayers();
        samplesLayer.clearLayers();
        trackLine.setLatLngs([]);
        if (rangeRing) { map.removeLayer(rangeRing); rangeRing = null; }
        if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
        if (meAccCircle) { map.removeLayer(meAccCircle); meAccCircle = null; }
        map.setView([session.stLat, session.stLon], 16);
        renderLegend();
    }

    function updateMeMarker(lat, lon, acc) {
        if (!map) return;
        if (!meMarker) {
            meMarker = L.circleMarker([lat, lon], {
                radius: 7, color: '#ffffff', fillColor: COLOR_ME,
                fillOpacity: 1, weight: 2
            }).addTo(map);
            meAccCircle = L.circle([lat, lon], {
                radius: acc, color: COLOR_ME, weight: 1,
                fillColor: COLOR_ME, fillOpacity: 0.08
            }).addTo(map);
            map.fitBounds(L.latLngBounds([[session.stLat, session.stLon], [lat, lon]]),
                          { padding: [40, 40], maxZoom: 17 });
        } else {
            meMarker.setLatLng([lat, lon]);
            meAccCircle.setLatLng([lat, lon]).setRadius(acc);
        }
    }

    function setLayerMode(mode) {
        mapLayerMode = mode;
        $('rs-range-layer-rate').classList.toggle('on', mode === 'rate');
        $('rs-range-layer-rssi').classList.toggle('on', mode === 'rssi');
        if (map) {
            if (mode === 'rate') {
                map.addLayer(rasterLayer); map.removeLayer(samplesLayer);
            } else {
                map.removeLayer(rasterLayer); map.addLayer(samplesLayer);
            }
        }
        renderLegend();
    }

    function rampColor(ramp, frac) {
        var i = Math.max(0, Math.min(ramp.length - 1, Math.floor(frac * ramp.length)));
        return ramp[i];
    }

    function cellFrac(cell, maxDetPerMin) {
        // Absolute heard/expected when the tag's pulse rate is known,
        // otherwise relative to the loudest cell of this walk.
        if (cell.detection_rate != null) return cell.detection_rate;
        if (cell.det_per_min != null && maxDetPerMin > 0) {
            return cell.det_per_min / maxDetPerMin;
        }
        return 0;
    }

    function renderOverlays() {
        if (!map || !lastResults) return;
        var res = lastResults;

        trackLine.setLatLngs((res.track || []).map(function (p) { return [p.lat, p.lon]; }));

        rasterLayer.clearLayers();
        var cells = (res.raster && res.raster.cells) || [];
        var maxDpm = 0;
        cells.forEach(function (c) {
            if (c.det_per_min != null && c.det_per_min > maxDpm) maxDpm = c.det_per_min;
        });
        cells.forEach(function (c) {
            var heard = c.detections > 0;
            var color = heard ? rampColor(RAMP_RATE, cellFrac(c, maxDpm)) : COLOR_SILENT;
            var rect = L.rectangle(c.bounds, {
                color: color, weight: 1, opacity: heard ? 0.85 : 0.5,
                fillColor: color, fillOpacity: heard ? 0.45 : 0.18
            });
            rect.bindTooltip(
                fmtM(c.distance_m) + ' out · ' +
                (heard ? c.detections + ' det' +
                    (c.detection_rate != null
                        ? ' (' + Math.round(c.detection_rate * 100) + '% of pulses)'
                        : (c.det_per_min != null ? ' (' + c.det_per_min + '/min)' : '')) +
                    (c.avg_signal_db != null ? ' · avg ' + c.avg_signal_db + ' dB' : '')
                 : 'heard nothing') +
                (c.dwell_s >= 1 ? ' · ' + Math.round(c.dwell_s) + ' s here'
                                : ' · passing through'));
            rasterLayer.addLayer(rect);
        });

        samplesLayer.clearLayers();
        var samples = res.samples || [];
        var sigs = samples.map(function (s) { return s.signal_db; })
                          .filter(function (v) { return v != null; });
        var lo = Math.min.apply(null, sigs), hi = Math.max.apply(null, sigs);
        var span = (hi - lo) || 1;
        samples.forEach(function (s) {
            if (s.signal_db == null) return;
            var frac = (s.signal_db - lo) / span;
            var m = L.circleMarker([s.lat, s.lon], {
                radius: 5, color: '#ffffff', weight: 1,
                fillColor: rampColor(RAMP_RSSI, frac), fillOpacity: 0.9
            });
            m.bindTooltip(s.signal_db.toFixed(0) + ' dB · ' + fmtM(s.distance_m) + ' out');
            samplesLayer.addLayer(m);
        });

        var pred = res.summary && res.summary.predicted_range_m;
        if (rangeRing) { map.removeLayer(rangeRing); rangeRing = null; }
        if (pred && pred < 50000) {
            rangeRing = L.circle([session.stLat, session.stLon], {
                radius: pred, color: COLOR_STATION, weight: 1.5,
                dashArray: '6 6', fill: false
            }).addTo(map);
            rangeRing.bindTooltip('predicted max range ' + fmtM(pred));
        }

        if (!mapFittedOnce && (res.track || []).length > 3) {
            var pts = res.track.map(function (p) { return [p.lat, p.lon]; });
            pts.push([session.stLat, session.stLon]);
            map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
            mapFittedOnce = true;
        }
        setLayerMode(mapLayerMode);
    }

    function renderLegend() {
        var el = $('rs-range-legend');
        if (!el) return;
        var html;
        if (mapLayerMode === 'rate') {
            html = '<span><span class="swatch" style="background:' + COLOR_SILENT +
                ';opacity:.5;"></span>walked, heard nothing</span>';
            RAMP_RATE.forEach(function (c, i) {
                var lab = i === 0 ? 'few detections' :
                          (i === RAMP_RATE.length - 1 ? 'most detections' : '');
                html += '<span><span class="swatch" style="background:' + c + ';"></span>' +
                    lab + '</span>';
            });
        } else {
            html = '<span><span class="swatch" style="background:' + RAMP_RSSI[0] +
                ';"></span>weak signal</span>' +
                '<span><span class="swatch" style="background:' +
                RAMP_RSSI[RAMP_RSSI.length - 1] + ';"></span>strong signal</span>';
        }
        html += '<span><span class="swatch" style="background:' + COLOR_STATION +
            ';border-radius:50%;"></span>station</span>';
        el.innerHTML = html;
    }

    // ==================== results ====================

    async function refreshResults() {
        if (!session) return;
        try {
            var r = await fetch('/api/v1/range/sessions/' + session.sid + '/results');
            if (!r.ok) return;
            lastResults = await r.json();
            renderOverlays();
            (lastResults.samples || []).forEach(function (s) {
                if (s.timestamp > lastHeardTs) lastHeardTs = s.timestamp;
            });
            // Mid-walk motivation: how far out has the station still heard us?
            var far = $('rs-range-farthest');
            if (far && gpsWatchId != null) {
                var maxDist = lastResults.summary &&
                    lastResults.summary.max_detection_distance_m;
                if (maxDist != null) {
                    far.style.display = '';
                    far.textContent = 'Farthest detection so far: ' + fmtM(maxDist);
                }
            }
            // A locked tag reports once a minute — mid-walk that reads as
            // "broken" unless the page says why.
            var lockedNote = $('rs-range-locked-note');
            if (lockedNote) {
                lockedNote.style.display = (gpsWatchId != null &&
                    lastResults.summary && lastResults.summary.tag_locked)
                    ? 'block' : 'none';
            }
        } catch (e) { /* transient — next poll */ }
    }

    function renderResults() {
        if (!lastResults) return;
        var sum = lastResults.summary || {};
        var fit = lastResults.fit;

        $('rs-range-results').style.display = 'block';
        $('rs-range-sum-maxdist').textContent = fmtM(sum.max_detection_distance_m);
        // The empirical counterpart of the fitted prediction: the edge of the
        // last distance band that still heard the tag properly on this walk.
        $('rs-range-sum-reliable').textContent = fmtM(sum.reliable_range_m);
        $('rs-range-sum-pred').textContent = fmtM(sum.predicted_range_m);
        $('rs-range-sum-n').textContent =
            fit ? fit.path_loss_exponent.toFixed(2) : '—';
        $('rs-range-sum-samples').textContent = sum.sample_count || 0;

        $('rs-range-fit-line').textContent = fit
            ? 'RSSI ≈ ' + fit.rssi_at_1m_db.toFixed(1) + ' − ' +
              (10 * fit.path_loss_exponent).toFixed(1) +
              '·log₁₀(d)  ·  R² = ' + fit.r_squared.toFixed(2) +
              '  ·  weakest detection heard at ' +
              (sum.weakest_detected_db != null ? sum.weakest_detected_db + ' dB' : '—')
            : 'Not enough spread in the data to fit a propagation model — ' +
              'walk further out (samples over at least a 2× distance range).';

        renderRssiChart(lastResults.samples || [], fit, sum);
        renderRateChart(lastResults.raster || { cells: [] });

        // Server-side exports (session cookie carries auth on plain links):
        // JSON = full analysis; the CSVs are flat training tables — samples
        // one row per positioned detection, track one row per GPS fix.
        var sid = session ? session.sid :
            (lastResults.session && lastResults.session.session_id);
        var base = '/api/v1/range/sessions/' + encodeURIComponent(sid) + '/export';
        $('rs-range-export').href = base;
        $('rs-range-export-csv').href = base + '?format=csv&table=samples';
        $('rs-range-export-track').href = base + '?format=csv&table=track';
    }

    // ==================== charts ====================
    // Hand-rolled SVG on page tokens: dots + fitted curve for RSSI/distance,
    // dwell-weighted bars for detection rate by distance band. Single series
    // each, so the card title is the legend.

    function chartFrame(w, h, padL, padB, padT, padR) {
        return { w: w, h: h, padL: padL, padB: padB, padT: padT, padR: padR,
                 plotW: w - padL - padR, plotH: h - padT - padB };
    }

    function niceTicks(min, max, count) {
        var span = max - min;
        if (span <= 0) return [min];
        var step = Math.pow(10, Math.floor(Math.log10(span / count)));
        var err = span / count / step;
        if (err >= 7.5) step *= 10;
        else if (err >= 3.5) step *= 5;
        else if (err >= 1.5) step *= 2;
        var ticks = [];
        for (var v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
            ticks.push(Math.round(v * 1000) / 1000);
        }
        return ticks;
    }

    function renderRssiChart(samples, fit, sum) {
        var el = $('rs-range-chart-rssi');
        var pts = samples.filter(function (s) {
            return s.signal_db != null && s.distance_m != null;
        });
        if (pts.length < 2) {
            el.innerHTML = '<div class="rs-empty">No placed detections yet.</div>';
            return;
        }
        var f = chartFrame(640, 300, 46, 34, 12, 12);
        // || 1: every placed detection at distance 0 (walk never left the
        // antenna) would otherwise make every x-coordinate NaN
        var maxD = Math.max.apply(null, pts.map(function (p) { return p.distance_m; })) * 1.05 || 1;
        var sigs = pts.map(function (p) { return p.signal_db; });
        var minS = Math.min.apply(null, sigs), maxS = Math.max.apply(null, sigs);
        var padS = Math.max(2, (maxS - minS) * 0.1);
        minS -= padS; maxS += padS;

        function X(d) { return f.padL + (d / maxD) * f.plotW; }
        function Y(s) { return f.padT + (1 - (s - minS) / (maxS - minS)) * f.plotH; }

        var svg = '<svg viewBox="0 0 ' + f.w + ' ' + f.h + '" role="img" ' +
            'aria-label="Signal strength against distance from station">';
        niceTicks(minS, maxS, 5).forEach(function (t) {
            svg += '<line x1="' + f.padL + '" x2="' + (f.w - f.padR) + '" y1="' + Y(t) +
                '" y2="' + Y(t) + '" stroke="var(--rs-border)" stroke-width="1"/>' +
                '<text x="' + (f.padL - 6) + '" y="' + (Y(t) + 3) +
                '" text-anchor="end" font-size="10" fill="var(--rs-muted)">' + t + '</text>';
        });
        niceTicks(0, maxD, 6).forEach(function (t) {
            svg += '<text x="' + X(t) + '" y="' + (f.h - f.padB + 16) +
                '" text-anchor="middle" font-size="10" fill="var(--rs-muted)">' +
                (maxD >= 2000 ? (t / 1000) + 'k' : t) + '</text>';
        });
        svg += '<text x="' + (f.padL + f.plotW / 2) + '" y="' + (f.h - 2) +
            '" text-anchor="middle" font-size="10" fill="var(--rs-muted)">distance (m)</text>' +
            '<text x="12" y="' + (f.padT + f.plotH / 2) +
            '" text-anchor="middle" font-size="10" fill="var(--rs-muted)" ' +
            'transform="rotate(-90 12 ' + (f.padT + f.plotH / 2) + ')">signal (dB)</text>';

        if (sum && sum.weakest_detected_db != null) {
            var yThr = Y(sum.weakest_detected_db);
            svg += '<line x1="' + f.padL + '" x2="' + (f.w - f.padR) + '" y1="' + yThr +
                '" y2="' + yThr + '" stroke="var(--rs-amber)" stroke-width="1" ' +
                'stroke-dasharray="4 4"/>';
        }

        if (fit) {
            var curve = [];
            var d0 = Math.max(fit.min_distance_m, 1);
            for (var i = 0; i <= 60; i++) {
                var d = d0 * Math.pow(maxD / d0, i / 60);
                var s = fit.rssi_at_1m_db - 10 * fit.path_loss_exponent * Math.log10(d);
                if (s >= minS && s <= maxS) {
                    curve.push(X(d).toFixed(1) + ',' + Y(s).toFixed(1));
                }
            }
            if (curve.length > 1) {
                svg += '<polyline points="' + curve.join(' ') +
                    '" fill="none" stroke="var(--rs-blue)" stroke-width="2" opacity="0.9"/>';
            }
        }

        pts.forEach(function (p) {
            svg += '<circle cx="' + X(p.distance_m).toFixed(1) + '" cy="' +
                Y(p.signal_db).toFixed(1) + '" r="3.5" fill="var(--rs-blue)" ' +
                'opacity="0.55"><title>' + p.signal_db.toFixed(0) + ' dB at ' +
                Math.round(p.distance_m) + ' m</title></circle>';
        });
        svg += '</svg>';
        el.innerHTML = svg;
    }

    function renderRateChart(raster) {
        var el = $('rs-range-chart-rate');
        var cells = (raster.cells || []).filter(function (c) { return c.dwell_s > 0; });
        if (!cells.length) {
            el.innerHTML = '<div class="rs-empty">No coverage data yet.</div>';
            return;
        }
        var maxD = Math.max.apply(null, cells.map(function (c) { return c.distance_m; }));
        var nBins = Math.min(10, Math.max(4, Math.ceil(maxD / 50)));
        var binW = maxD / nBins || 1;
        var bins = [];
        for (var i = 0; i < nBins; i++) bins.push({ dwell: 0, det: 0, expected: 0 });
        var havePpm = false;
        cells.forEach(function (c) {
            var b = bins[Math.min(nBins - 1, Math.floor(c.distance_m / binW))];
            b.dwell += c.dwell_s;
            b.det += c.detections;
            if (c.expected_pulses != null) {
                havePpm = true;
                b.expected += c.expected_pulses;
            }
        });

        var f = chartFrame(640, 240, 46, 34, 12, 12);
        var vals = bins.map(function (b) {
            if (b.dwell <= 0) return null;
            if (havePpm && b.expected > 0) return Math.min(b.det / b.expected, 1);
            return b.det / b.dwell * 60;   // detections per minute
        });
        var maxV = havePpm ? 1 :
            Math.max.apply(null, vals.filter(function (v) { return v != null; }).concat([1]));

        var svg = '<svg viewBox="0 0 ' + f.w + ' ' + f.h + '" role="img" ' +
            'aria-label="Detection rate by distance band">';
        niceTicks(0, maxV, 4).forEach(function (t) {
            var y = f.padT + (1 - t / maxV) * f.plotH;
            svg += '<line x1="' + f.padL + '" x2="' + (f.w - f.padR) + '" y1="' + y +
                '" y2="' + y + '" stroke="var(--rs-border)" stroke-width="1"/>' +
                '<text x="' + (f.padL - 6) + '" y="' + (y + 3) +
                '" text-anchor="end" font-size="10" fill="var(--rs-muted)">' +
                (havePpm ? Math.round(t * 100) + '%' : t) + '</text>';
        });
        var slot = f.plotW / nBins;
        bins.forEach(function (b, i) {
            var v = vals[i];
            var x = f.padL + i * slot;
            var label = Math.round(i * binW) + '–' + Math.round((i + 1) * binW);
            if (v != null) {
                var h = (v / maxV) * f.plotH;
                svg += '<rect x="' + (x + 3) + '" y="' + (f.padT + f.plotH - h) +
                    '" width="' + (slot - 6) + '" height="' + Math.max(h, 1) +
                    '" rx="3" fill="var(--rs-blue)" opacity="0.8"><title>' + label +
                    ' m: ' + (havePpm ? Math.round(v * 100) + '% of pulses heard'
                                      : v.toFixed(1) + ' detections/min') +
                    ' (' + Math.round(b.dwell) + ' s walked)</title></rect>';
            }
            if (nBins <= 10 || i % 2 === 0) {
                svg += '<text x="' + (x + slot / 2) + '" y="' + (f.h - f.padB + 16) +
                    '" text-anchor="middle" font-size="9" fill="var(--rs-muted)">' +
                    label + '</text>';
            }
        });
        svg += '<text x="' + (f.padL + f.plotW / 2) + '" y="' + (f.h - 2) +
            '" text-anchor="middle" font-size="10" fill="var(--rs-muted)">distance band (m)</text></svg>';
        el.innerHTML = svg;
        $('rs-range-rate-note').textContent = havePpm
            ? 'Percent of the tag’s expected pulses the station actually heard, by distance.'
            : 'Detections per minute of walking time, by distance. Add this tag’s pulse ' +
              'rate to the registry to see absolute percentages.';
    }

    // ==================== past sessions ====================

    async function loadSessions() {
        var tbody = $('rs-range-sessions-tbody');
        try {
            var r = await fetch('/api/v1/range/sessions');
            var data = await r.json();
            var sessions = data.sessions || [];
            if (!sessions.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="rs-empty">' +
                    'No range walks yet. Start one above.</td></tr>';
                return;
            }
            tbody.innerHTML = sessions.map(function (s) {
                return '<tr>' +
                    '<td>' + escapeHtml(s.name || s.session_id) +
                    (s.is_active ? ' <span class="rs-pill rs-pill-green">live</span>' : '') +
                    '</td>' +
                    '<td><a href="/station/' + encodeURIComponent(s.station_id) + '">' +
                    escapeHtml(s.station_id) + '</a></td>' +
                    '<td class="rs-num">' + rsSpeciesIcon(s.species) +
                    (s.target_frequency_khz
                        ? fmtMhz(s.target_frequency_khz) : '—') + '</td>' +
                    '<td class="rs-meta">' + rsTimeAgo(s.started_at) + '</td>' +
                    '<td class="rs-num">' + (s.track_point_count || 0) + '</td>' +
                    '<td style="white-space:nowrap;">' +
                    '<button class="rs-link-btn" onclick="rsRangeView(\'' +
                    s.session_id + '\')">View</button> ' +
                    '<button class="rs-link-btn" style="color:var(--rs-red);" ' +
                    'onclick="rsRangeDelete(\'' + s.session_id + '\')">Delete</button>' +
                    '</td></tr>';
            }).join('');
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="6" class="rs-empty">Could not load sessions.</td></tr>';
        }
    }

    // View a past walk: same map + results pipeline, no GPS attached.
    window.rsRangeView = async function (sid) {
        if (gpsWatchId != null) return;   // never clobber a walk in progress
        try {
            var r = await fetch('/api/v1/range/sessions/' + sid + '/results');
            if (!r.ok) return;
            lastResults = await r.json();
            session = {
                sid: sid,
                stationId: lastResults.station.station_id,
                freqKhz: lastResults.session.target_frequency_khz,
                stLat: lastResults.station.latitude,
                stLon: lastResults.station.longitude,
                startedTs: null
            };
            mapFittedOnce = false;
            $('rs-range-setup').style.display = 'none';
            $('rs-range-active').style.display = 'none';
            $('rs-range-map-wrap').style.display = 'block';
            initMap();   // positions the station marker itself; no-op if Leaflet failed to load
            renderOverlays();
            renderResults();
            $('rs-range-map-wrap').scrollIntoView({ behavior: 'smooth' });
        } catch (e) { /* leave the page as-is */ }
    };

    window.rsRangeDelete = async function (sid) {
        if (session && gpsWatchId != null && sid === session.sid) {
            alert('This walk is still running — End walk first.');
            return;
        }
        if (!confirm('Delete this range walk and all its GPS data?')) return;
        try {
            var r = await fetch('/api/v1/test/sessions/' + sid, { method: 'DELETE' });
            if (r.ok) loadSessions();
        } catch (e) { /* ignore */ }
    };

    // ==================== boot ====================

    document.addEventListener('DOMContentLoaded', function () {
        populateSetup();
        loadSessions();
        tryResume();
        // A walk ended in a dead zone leaves its tail parked in localStorage;
        // deliver it now (and keep trying) if one exists.
        if (readPending()) {
            showPendingNote();
            finishPending();
            schedulePending();
        }
    });
})();

// ==================== RelayStation Central — Stations page ====================
// First paint is server-rendered; this script keeps the table, map, and
// rankings fresh (30s poll) and wires the per-row kebab actions.

(function () {
    'use strict';

    var map = null;
    var markerLayer = null;
    var stations = [];
    var tags = [];

    // ---- add-a-station wizard (moved from the retired Setup page) ----
    var GREEN = '#16a34a';
    var ID_RE = /^[a-z0-9-]{3,30}$/;
    var pin = null, pinLatLng = null, wizMap = null;
    var checkinTimer = null, createdStationId = null;

    function $(id) { return document.getElementById(id); }

    function hexKey(bytes) {
        var arr = new Uint8Array(bytes);
        crypto.getRandomValues(arr);
        return Array.prototype.map.call(arr, function (b) {
            return ('0' + b.toString(16)).slice(-2);
        }).join('');
    }

    async function post(url, body) {
        var r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        if (!r.ok) {
            var detail = '';
            try { detail = (await r.json()).detail || ''; } catch (e) { /* ignore */ }
            throw new Error(detail || ('Request failed (' + r.status + ')'));
        }
        return r.json();
    }

    function makeQr(el, text) {
        if (!el) return;
        el.innerHTML = '';
        if (typeof QRCode === 'undefined') {
            el.innerHTML = '<span class="rs-meta">(QR code unavailable)</span>';
            return;
        }
        try {
            new QRCode(el, { text: text, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
        } catch (e) {
            try {
                el.innerHTML = '';
                new QRCode(el, { text: text, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.L });
            } catch (e2) {
                el.innerHTML = '<span class="rs-meta">(too long for a QR code — use Copy)</span>';
            }
        }
    }

    function initWizMap() {
        var el = $('rs-wiz-map');
        if (!el || typeof L === 'undefined') return;
        wizMap = L.map('rs-wiz-map').setView([36.6, -121.9], 8);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19
        }).addTo(wizMap);
        wizMap.on('click', function (e) { setPin(e.latlng.lat, e.latlng.lng); });
    }

    function setPin(lat, lng) {
        pinLatLng = { lat: lat, lng: lng };
        if (wizMap) {
            if (pin) pin.setLatLng([lat, lng]);
            else pin = L.marker([lat, lng]).addTo(wizMap);
        }
        var coords = $('rs-wiz-coords');
        if (coords) coords.textContent = lat.toFixed(5) + ', ' + lng.toFixed(5);
    }

    function geolocate() {
        if (!navigator.geolocation) { alert('Location is not available in this browser.'); return; }
        navigator.geolocation.getCurrentPosition(function (pos) {
            setPin(pos.coords.latitude, pos.coords.longitude);
            if (wizMap) wizMap.setView([pos.coords.latitude, pos.coords.longitude], 13);
        }, function () { alert('Could not get your location — click the map instead.'); });
    }

    function validateId() {
        var input = $('rs-wiz-id');
        var err = $('rs-wiz-id-error');
        var ok = ID_RE.test(input.value.trim());
        if (err) err.style.display = (ok || !input.value) ? 'none' : '';
        return ok;
    }

    // The band plan is the one genuinely per-station choice: the SDR hears a
    // single ~2 MHz window (centre ±1.024 MHz) fixed at boot, so a station
    // pointed at the wrong band looks perfectly healthy and hears nothing.
    // Everything else the installer needs is either already known here or a
    // proven constant, which is why it is baked in rather than prompted for.
    var BAND_PRESETS = {
        '151': {
            sdr_center_hz: 151.32e6, freq_min_hz: 151.19e6, freq_max_hz: 151.45e6,
            hunt_mode: false,
            help: 'Watches 150.30–152.34 MHz. One channel centred on each tag ' +
                  'deployed here, so no tag can land on a channel seam.'
        },
        '164hunt': {
            sdr_center_hz: 164.0e6, freq_min_hz: 160.0e6, freq_max_hz: 166.0e6,
            hunt_mode: true,
            help: 'Watches 162.98–165.02 MHz with no tag list — every periodic ' +
                  'signal is a candidate. Sea-otter implants span 160–165 MHz, ' +
                  'wider than one window: step the centre later from Settings.'
        }
    };

    function bandHelp() {
        var sel = $('rs-wiz-band');
        var custom = $('rs-wiz-custom');
        var help = $('rs-wiz-band-help');
        if (!sel) return;
        var isCustom = sel.value === 'custom';
        if (custom) custom.style.display = isCustom ? '' : 'none';
        if (!help) return;
        if (isCustom) {
            var c = parseFloat($('rs-wiz-center') && $('rs-wiz-center').value);
            help.textContent = isFinite(c)
                ? 'Watches ' + (c - 1.024).toFixed(3) + '–' + (c + 1.024).toFixed(3) +
                  ' MHz. Anything outside that window is not heard.'
                : 'The radio hears the centre ±1.024 MHz.';
        } else {
            help.textContent = (BAND_PRESETS[sel.value] || {}).help || '';
        }
    }

    // Returns the band plan in Hz, or null if the custom entry is unusable.
    function bandPlan() {
        var sel = $('rs-wiz-band');
        var err = $('rs-wiz-band-error');
        function fail(msg) {
            if (err) { err.textContent = msg; err.style.display = ''; }
            return null;
        }
        if (err) err.style.display = 'none';
        if (!sel || sel.value !== 'custom') {
            return BAND_PRESETS[sel ? sel.value : '151'] || BAND_PRESETS['151'];
        }
        var c = parseFloat($('rs-wiz-center').value);
        var lo = parseFloat($('rs-wiz-fmin').value);
        var hi = parseFloat($('rs-wiz-fmax').value);
        if (!isFinite(c) || c < 24 || c > 1766) {
            return fail('Centre must be a frequency in MHz the radio can tune (24–1766).');
        }
        if (!isFinite(lo) || !isFinite(hi) || lo >= hi) {
            return fail('Search range must be two frequencies in MHz, low then high.');
        }
        // Catch the plan that yields a live, green, deaf station.
        if (hi < c - 1.024 || lo > c + 1.024) {
            return fail('That search range is outside the radio\'s window (' +
                        (c - 1.024).toFixed(3) + '–' + (c + 1.024).toFixed(3) +
                        ' MHz). The station would scan nothing.');
        }
        return {
            sdr_center_hz: c * 1e6, freq_min_hz: lo * 1e6, freq_max_hz: hi * 1e6,
            hunt_mode: !!($('rs-wiz-hunt') && $('rs-wiz-hunt').checked)
        };
    }

    async function createStation() {
        if (!validateId()) { $('rs-wiz-id').focus(); return; }
        var band = bandPlan();
        if (!band) { $('rs-wiz-band').focus(); return; }
        var sid = $('rs-wiz-id').value.trim();
        var btn = $('rs-wiz-create');
        var status = $('rs-wiz-create-status');
        btn.disabled = true;
        status.textContent = 'Creating…';
        status.style.color = '';
        try {
            var apiKey = hexKey(16); // 32 hex chars, client-generated
            var stype = $('rs-wiz-type') ? $('rs-wiz-type').value : 'cellular';
            await post('/api/v1/admin/stations', {
                station_id: sid,
                api_key: apiKey,
                location: $('rs-wiz-location').value.trim() || null,
                latitude: pinLatLng ? pinLatLng.lat : null,
                longitude: pinLatLng ? pinLatLng.lng : null,
                station_type: stype,
                sdr_center_hz: band.sdr_center_hz,
                freq_min_hz: band.freq_min_hz,
                freq_max_hz: band.freq_max_hz,
                hunt_mode: band.hunt_mode
            });
            var cfgResp = await fetch('/api/v1/admin/stations/' + encodeURIComponent(sid) + '/config');
            if (!cfgResp.ok) throw new Error('Station created, but fetching its config failed.');
            var config = (await cfgResp.json()).config || '';

            createdStationId = sid;
            status.textContent = 'Created ✓';
            status.style.color = GREEN;
            $('rs-wiz-step2').classList.add('done');

            // One-line installer command (primary) + config for manual setup (fallback).
            var installUrl = window.location.origin + '/install/' +
                encodeURIComponent(sid) + '.sh?key=' + apiKey;
            var installCmd = 'curl -fsSL "' + installUrl + '" | sudo bash';
            $('rs-wiz-install').textContent = installCmd;
            makeQr($('rs-wiz-qr'), installCmd);
            $('rs-wiz-config').textContent = config;
            $('rs-wiz-step3').style.display = '';
            $('rs-wiz-step4').style.display = '';
            startCheckinPoll();
        } catch (e) {
            btn.disabled = false;
            status.textContent = e.message;
            status.style.color = 'var(--rs-red)';
        }
    }

    function copyFrom(srcId, btn) {
        if (!btn) return;
        var src = $(srcId);
        var text = src ? src.textContent : '';
        function flash() {
            var orig = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(function () { btn.textContent = orig; }, 2000);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(flash, function () { fallbackCopy(text, flash); });
        } else {
            fallbackCopy(text, flash);
        }
    }

    function fallbackCopy(text, done) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
    }

    function startCheckinPoll() {
        if (checkinTimer) clearInterval(checkinTimer);
        checkinTimer = setInterval(async function () {
            try {
                var r = await fetch('/api/v1/admin/stations');
                if (!r.ok) return;
                var list = (await r.json()).stations || [];
                var mine = list.filter(function (s) { return s.station_id === createdStationId; })[0];
                if (mine && mine.status !== 'never_seen') {
                    clearInterval(checkinTimer);
                    checkinTimer = null;
                    var el = $('rs-wiz-waiting');
                    el.innerHTML = '<span style="color:var(--rs-green);font-weight:600;">&#10003; Station connected!</span> ' +
                        '<a href="/station/' + encodeURIComponent(createdStationId) + '">View it</a>';
                    $('rs-wiz-step4').classList.add('done');
                }
            } catch (e) { /* transient — retry next tick */ }
        }, 10000);
    }

    function initialData() {
        try {
            var el = document.getElementById('rs-stations-data');
            return el ? JSON.parse(el.textContent) : {};
        } catch (e) { return {}; }
    }

    // ---------- fleet actions ----------

    function setActionStatus(text, ok) {
        var el = $('rs-actions-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = ok ? GREEN : '';
        if (text) setTimeout(function () { el.textContent = ''; }, 5000);
    }

    async function recalibrateAll(btn) {
        if (!stations.length) { setActionStatus('No stations registered.'); return; }
        if (!confirm('Queue a recalibrate command for all ' + stations.length +
                     ' station' + (stations.length === 1 ? '' : 's') + '?')) return;
        btn.disabled = true;
        var queued = 0;
        for (var i = 0; i < stations.length; i++) {
            try {
                await post('/api/v1/admin/stations/' +
                    encodeURIComponent(stations[i].station_id) + '/commands',
                    { command_type: 'recalibrate' });
                queued++;
            } catch (e) { /* keep going — count what succeeded */ }
        }
        btn.disabled = false;
        setActionStatus('Recalibrate queued for ' + queued + ' of ' + stations.length + ' stations.', true);
    }

    function statusColor(status) {
        if (status === 'online') return '#16a34a';
        if (status === 'offline') return '#dc2626';
        return '#9ca3af';
    }

    // ---------- map ----------

    function initMap() {
        var el = document.getElementById('rs-stations-map');
        if (!el || typeof L === 'undefined') return;
        map = L.map('rs-stations-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19
        }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        renderMarkers();
    }

    function renderMarkers() {
        if (!map || !markerLayer) return;
        markerLayer.clearLayers();
        var bounds = [];
        stations.forEach(function (s) {
            if (s.latitude == null || s.longitude == null) return;
            var m = L.circleMarker([s.latitude, s.longitude], {
                radius: 8,
                color: statusColor(s.status),
                fillColor: statusColor(s.status),
                fillOpacity: 0.85,
                weight: 2
            });
            m.bindPopup('<b>' + escapeHtml(s.station_id) + '</b><br>' +
                escapeHtml(s.location || '') + '<br>' + escapeHtml(s.status));
            markerLayer.addLayer(m);
            bounds.push([s.latitude, s.longitude]);
        });
        if (bounds.length) {
            map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
        } else {
            map.setView([36.6, -121.9], 8);
        }
    }

    // ---------- table ----------

    function fmt(value, suffix) {
        return value != null ? value + suffix : '—';
    }

    function versionCell(s) {
        if (s.update_state === 'current') {
            return '<span class="rs-badge rs-badge-ok" title="Running exactly the server\'s deployable tree (' + escapeHtml(s.fw_version || '') + ')">✓ current</span>';
        }
        if (s.update_state === 'behind') {
            return '<span class="rs-badge rs-badge-warn" title="Content differs from the server tree — send Update">⬆ update available</span>';
        }
        return '<span class="rs-meta" title="Station has not reported a fingerprint yet">—</span>';
    }

    // How the station last reached the server: WiFi or cellular. Shown so the
    // link is visible at a glance instead of inferred from server logs (which
    // can't tell them apart).
    function transportChip(s) {
        var t = s.last_transport;
        if (t === 'wifi') return ' <span class="rs-tx rs-tx-wifi" title="last reported over WiFi">WiFi</span>';
        if (t === 'nbiot') return ' <span class="rs-tx rs-tx-cell" title="last reported over NB-IoT cellular">cellular</span>';
        return '';
    }

    // The one setting that gets changed in the field, as a two-state control
    // rather than a menu -> prompt -> prompt -> typed magic string. It reflects
    // the mode the station ITSELF reported ('nb' in its heartbeat), so a
    // command that never landed cannot look applied.
    function modeToggle(s) {
        var esc = escapeHtml(s.station_id);
        var mode = s.nbiot_mode;                      // what the station reports
        var pending = s.pending_nbiot_mode;           // queued, not run yet
        var shown = pending || mode;                  // optimistic: show the intent
        function seg(val, label, hint) {
            var on = (shown === val);
            var isPending = on && !!pending;
            return '<button type="button" class="rs-seg-btn' +
                (on ? ' on' : '') + (isPending ? ' pending' : '') + '"' +
                (on ? ' aria-current="true"' : '') +
                (pending ? ' disabled' : '') +
                ' title="' + hint + '"' +
                ' onclick="rsSetMode(\'' + esc + '\', \'' + val + '\', this)">' + label + '</button>';
        }
        var note = '';
        if (pending) {
            // Disabled plus an explicit "sending" is what stops the
            // double-tapping: the control must never look like it ignored you.
            note = '<div class="rs-meta rs-seg-note">Sending ' +
                (pending === 'reduced' ? 'Low' : 'Full') + '. Station applies it on ' +
                'its next check-in' + (mode === 'reduced' ? ' (up to 30 min in Low)' : '') +
                '.</div>';
        } else if (mode === 'reduced') {
            // The standing "you are in Low" message. The cost is not obvious
            // from the word "Low", and it is exactly what surprises you later.
            note = '<div class="rs-meta rs-seg-note rs-seg-low">Reports every 30 min. ' +
                'Commands can take that long to land.</div>';
        } else if (!mode) {
            note = '<div class="rs-meta rs-seg-note">Not reported yet.</div>';
        }
        return '<div class="rs-seg" role="group" aria-label="Update frequency for ' + esc + '">' +
            seg('full', 'Full', 'Heartbeat about every minute') +
            seg('reduced', 'Low', 'Heartbeat every 30 min, saves cellular data') +
            '</div>' + note;
    }

    function actions(sid) {
        var esc = escapeHtml(sid);
        // Visible, not hidden behind a kebab — these get used in the field, on a
        // phone. Delete is deliberately NOT here: it is destructive and lives on
        // the station's own page, where it cannot be mis-tapped from a list.
        return '<div class="rs-row-actions">' +
            '<button class="rs-btn rs-btn-sm" type="button" onclick="rsSetConfig(\'' + esc + '\')">Settings</button>' +
            '<button class="rs-btn rs-btn-sm" type="button" onclick="rsStationCmd(\'' + esc + '\', \'restart\', this)">Restart</button>' +
            '<button class="rs-btn rs-btn-sm" type="button" onclick="rsStationCmd(\'' + esc + '\', \'recalibrate\', this)">Recalibrate</button>' +
            '<button class="rs-btn rs-btn-sm" type="button" onclick="rsStationCmd(\'' + esc + '\', \'update\', this)">Update</button>' +
            '</div>';
    }

    function renderTable() {
        var tbody = document.getElementById('rs-stations-tbody');
        if (!tbody) return;
        if (!stations.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="rs-empty">' +
                'No stations yet — add one from the "Add a station" section below.</td></tr>';
            return;
        }
        // data-label drives the phone layout: under 768px each row becomes a
        // card and the CSS renders these as the field labels, so nothing has to
        // be read off a header that has scrolled away sideways.
        tbody.innerHTML = stations.map(function (s) {
            return '<tr>' +
                '<td data-label="Station" class="rs-cell-title">' + rsStatusDot(s.status) +
                '<a href="/station/' + encodeURIComponent(s.station_id) + '">' +
                escapeHtml(s.station_id) + '</a></td>' +
                '<td data-label="Location" class="rs-meta">' + escapeHtml(s.location || '—') + '</td>' +
                '<td data-label="Last seen" class="rs-meta">' + escapeHtml(s.last_seen_ago || 'Never') + transportChip(s) + '</td>' +
                '<td data-label="CPU" class="rs-num">' + fmt(s.cpu_percent, '%') + '</td>' +
                '<td data-label="Temp" class="rs-num">' + fmt(s.temperature_c, '°C') + '</td>' +
                '<td data-label="Power" class="rs-num">' + fmt(s.power_w, ' W') + '</td>' +
                '<td data-label="Active tags" class="rs-num">' + (s.active_tags || 0) + '</td>' +
                '<td data-label="Version">' + versionCell(s) + '</td>' +
                '<td data-label="Updates">' + modeToggle(s) + '</td>' +
                '<td data-label="Actions" class="rs-cell-actions">' + actions(s.station_id) + '</td>' +
                '</tr>';
        }).join('');
    }

    // ---------- rankings (detections summed client-side) ----------

    function renderRankings() {
        var tbody = document.getElementById('rs-rankings-tbody');
        if (!tbody) return;
        var totals = {};
        stations.forEach(function (s) { totals[s.station_id] = 0; });
        tags.forEach(function (t) {
            if (t.station_id in totals) totals[t.station_id] += (t.detection_count || 0);
        });
        var ranked = Object.keys(totals).map(function (sid) {
            return { station_id: sid, total: totals[sid] };
        }).sort(function (a, b) { return b.total - a.total; });
        if (!ranked.length) {
            tbody.innerHTML = '<tr><td colspan="3" class="rs-empty">No stations yet.</td></tr>';
            return;
        }
        tbody.innerHTML = ranked.map(function (r, i) {
            return '<tr>' +
                '<td class="rs-num rs-meta">' + (i + 1) + '</td>' +
                '<td><a href="/station/' + encodeURIComponent(r.station_id) + '">' +
                escapeHtml(r.station_id) + '</a></td>' +
                '<td class="rs-num">' + r.total.toLocaleString() + '</td>' +
                '</tr>';
        }).join('');
    }

    // ---------- actions ----------

    window.rsStationCmd = async function (sid, commandType, btn, payload) {
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(sid) + '/commands', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload ? { command_type: commandType, payload: payload }
                                             : { command_type: commandType })
            });
            if (!r.ok) return;
            var data = await r.json();
            if (btn) trackCommand(btn, data.command_id);
        } catch (e) { /* ignore */ }
    };

    // Follow a command to the station and back: Queued -> Delivered -> Acked.
    // Field stations poll ~1/min over cellular, so this can take a couple of
    // minutes — the button narrates instead of leaving you guessing.
    function trackCommand(btn, cmdId) {
        var orig = btn.textContent;
        var started = Date.now();
        btn.textContent = 'Queued…';
        var timer = setInterval(async function () {
            if (Date.now() - started > 5 * 60 * 1000) {
                clearInterval(timer);
                btn.textContent = orig;
                return;
            }
            try {
                var r = await fetch('/api/v1/admin/commands/' + cmdId);
                if (!r.ok) return;
                var st = await r.json();
                if (st.state === 'delivered') btn.textContent = 'Delivered…';
                if (st.state === 'acked') {
                    btn.textContent = 'Done ✓';
                    clearInterval(timer);
                    setTimeout(function () { btn.textContent = orig; }, 4000);
                }
            } catch (e) { /* keep polling */ }
        }, 5000);
    }

    // Remote settings the station accepts (validated again on-station, so this
    // list is a convenience, not the security boundary). `type` drives the form
    // control; `live` marks the settings that take effect on the next cycle
    // instead of waiting for a restart.
    var RS_CONFIG_KEYS = [
        { key: 'nbiot_mode', label: 'Update frequency', live: true,
          type: 'select',
          options: [['full', 'Full: heartbeat ~1 min'],
                    ['reduced', 'Low: heartbeat every 30 min, saves data']],
          help: 'Low also slows the command poll to 30 min, so later changes take longer to land.' },
        { key: 'reduced_heartbeat_interval', label: 'Low-mode heartbeat', live: true,
          type: 'number', min: 60, max: 7200, step: 30, unit: 'seconds',
          help: 'How often the station reports while in Low.' },
        { key: 'batch_interval_seconds', label: 'Batch send interval', live: true,
          type: 'number', min: 10, max: 3600, step: 5, unit: 'seconds',
          help: 'How often queued events are pushed.' },
        { key: 'change_threshold', label: 'Detection threshold', live: false,
          type: 'number', min: 1, max: 30, step: 0.5, unit: 'dB over noise floor',
          help: 'Lower = more sensitive and more false positives. Applies on restart.' },
        { key: 'capture_review_enabled', label: 'Save review thumbnails', live: false,
          type: 'select', options: [['true', 'On'], ['false', 'Off']],
          help: 'Applies on restart.' },
        { key: 'candidate_confirm_max_per_hour', label: 'Max confirmations / hour', live: false,
          type: 'number', min: 0, max: 60, step: 1, unit: 'per hour',
          help: 'Caps cellular thumbnail uploads. Applies on restart.' }
    ];

    async function queueSetConfig(sid, key, value) {
        var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(sid) + '/commands', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command_type: 'set_config',
                                   payload: { key: key, value: String(value) } })
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }

    // One tap. No menu, no typing.
    //
    // The UI repaints OPTIMISTICALLY and disables the control the instant you
    // tap, before the request resolves. That is not cosmetic: the confirming
    // heartbeat is itself slowed by the change, so in Low the truth cannot come
    // back for up to 30 minutes. A control that sits unchanged that long reads
    // as broken and gets tapped again — which is exactly what happened (five
    // duplicate commands on one station). The server also supersedes duplicates,
    // but the real fix is that the control must answer immediately.
    window.rsSetMode = async function (sid, mode, btn) {
        var s = stations.filter(function (x) { return x.station_id === sid; })[0] || {};
        if (s.nbiot_mode === mode && !s.pending_nbiot_mode) return;   // already there

        // Warn before the door that is slow to reopen.
        if (mode === 'reduced' && !confirm(
                'Put ' + sid + ' into Low?\n\n' +
                'It will report every 30 minutes instead of every minute, which ' +
                'saves cellular data.\n\n' +
                'The catch: it also checks for commands every 30 minutes. Anything ' +
                'you send after this, including switching back to Full, can take ' +
                'that long to reach it.')) {
            return;
        }

        // Repaint now, from intent, so the tap visibly lands.
        s.pending_nbiot_mode = mode;
        renderTable();
        try {
            await queueSetConfig(sid, 'nbiot_mode', mode);
            setActionStatus('Sending ' + (mode === 'reduced' ? 'Low' : 'Full') + ' to ' + sid +
                ' — it applies on the station\'s next check-in, no restart needed.', true);
        } catch (e) {
            s.pending_nbiot_mode = null;          // roll the optimism back
            renderTable();
            setActionStatus('Could not send that to ' + sid + ': ' + e.message, false);
        }
    };

    function cfgField(f, sid) {
        var id = 'rs-cfg-' + f.key;
        var input;
        if (f.type === 'select') {
            input = '<select class="rs-select" id="' + id + '">' +
                f.options.map(function (o) {
                    return '<option value="' + o[0] + '">' + escapeHtml(o[1]) + '</option>';
                }).join('') + '</select>';
        } else {
            input = '<input class="rs-input" id="' + id + '" type="number" inputmode="decimal"' +
                ' min="' + f.min + '" max="' + f.max + '" step="' + f.step + '"' +
                ' placeholder="' + f.min + '–' + f.max + '">' +
                (f.unit ? '<span class="rs-meta rs-cfg-unit">' + escapeHtml(f.unit) + '</span>' : '');
        }
        return '<div class="rs-cfg-field">' +
            '<label class="rs-cfg-label" for="' + id + '">' + escapeHtml(f.label) +
            (f.live ? '' : ' <span class="rs-pill rs-pill-amber rs-cfg-flag">needs restart</span>') +
            '</label>' +
            '<div class="rs-cfg-control">' + input +
            '<button class="rs-btn rs-btn-sm" type="button" ' +
            'onclick="rsApplyCfg(\'' + escapeHtml(sid) + '\', \'' + f.key + '\', \'' + id + '\', this)">Apply</button>' +
            '</div>' +
            '<div class="rs-meta rs-cfg-help">' + escapeHtml(f.help) + '</div>' +
            '</div>';
    }

    window.rsApplyCfg = async function (sid, key, inputId, btn) {
        var el = document.getElementById(inputId);
        if (!el) return;
        var value = el.value;
        if (value === '' || value === null) { el.focus(); return; }
        var spec = RS_CONFIG_KEYS.filter(function (f) { return f.key === key; })[0];
        if (spec && spec.type === 'number') {
            var n = parseFloat(value);
            if (isNaN(n) || n < spec.min || n > spec.max) {
                setCfgStatus(spec.label + ' must be between ' + spec.min + ' and ' + spec.max + '.', false);
                el.focus();
                return;
            }
        }
        btn.disabled = true;
        var old = btn.textContent;
        btn.textContent = '…';
        try {
            var data = await queueSetConfig(sid, key, value);
            setCfgStatus((spec ? spec.label : key) + ' → ' + value + ' queued (#' + data.command_id + '). ' +
                (spec && spec.live ? 'Applies on the next check-in.'
                                   : 'Applies after a Restart.'), true);
            poll();
        } catch (e) {
            setCfgStatus('Could not queue: ' + e.message, false);
        } finally {
            btn.disabled = false;
            btn.textContent = old;
        }
    };

    function setCfgStatus(msg, ok) {
        var el = document.getElementById('rs-cfg-status');
        if (!el) return;
        el.textContent = msg;
        el.className = 'rs-cfg-status ' + (ok ? 'ok' : 'err');
    }

    // Settings as a real form in a drawer: labelled controls with ranges and
    // units, replacing a numbered prompt() plus a second prompt() that wanted an
    // exact magic string typed on a phone keyboard.
    window.rsSetConfig = function (sid) {
        var s = stations.filter(function (x) { return x.station_id === sid; })[0] || {};
        var body = document.getElementById('rs-cfg-body');
        var title = document.getElementById('rs-cfg-title');
        if (!body || !title) return;
        title.textContent = sid;
        body.innerHTML =
            '<div id="rs-cfg-status" class="rs-cfg-status"></div>' +
            RS_CONFIG_KEYS.map(function (f) { return cfgField(f, sid); }).join('');
        // Preselect the mode the station actually reports.
        var modeSel = document.getElementById('rs-cfg-nbiot_mode');
        if (modeSel && s.nbiot_mode) modeSel.value = s.nbiot_mode;
        document.getElementById('rs-cfg-drawer').classList.add('open');
        document.getElementById('rs-cfg-backdrop').classList.add('open');
    };

    window.rsCloseCfg = function () {
        document.getElementById('rs-cfg-drawer').classList.remove('open');
        document.getElementById('rs-cfg-backdrop').classList.remove('open');
    };

    // ---------- poll ----------

    async function poll() {
        if (window.SERVER_AUTHED !== true) return;
        try {
            var results = await Promise.all([
                fetch('/api/v1/admin/stations'),
                fetch('/api/v1/admin/tags')
            ]);
            if (!results.every(function (r) { return r.ok; })) return;
            stations = (await results[0].json()).stations || [];
            tags = (await results[1].json()).tags || [];
            renderTable();
            renderRankings();
            renderMarkers();
        } catch (e) { /* transient — retry next poll */ }
    }

    document.addEventListener('DOMContentLoaded', function () {
        if (window.SERVER_AUTHED !== true) return;
        var data = initialData();
        stations = data.stations || [];
        tags = data.tags || [];
        initMap();
        // renderTable() on first paint, not just on the 30s poll: the rows used
        // to be server-rendered by Jinja too, so this was covered by accident.
        // With the JS as the single renderer, skipping it here leaves the table
        // reading "Loading…" for up to 30 seconds on every visit.
        renderTable();
        renderRankings();
        setInterval(poll, 30000);

        // --- add-a-station wizard wiring ---
        initWizMap();
        var idInput = $('rs-wiz-id');
        if (idInput) idInput.addEventListener('input', validateId);
        var geo = $('rs-wiz-geolocate');
        if (geo) geo.addEventListener('click', geolocate);
        var band = $('rs-wiz-band');
        if (band) band.addEventListener('change', bandHelp);
        var center = $('rs-wiz-center');
        if (center) center.addEventListener('input', bandHelp);
        bandHelp();
        var create = $('rs-wiz-create');
        if (create) create.addEventListener('click', createStation);
        var copyCmd = $('rs-wiz-copy-cmd');
        if (copyCmd) copyCmd.addEventListener('click', function () { copyFrom('rs-wiz-install', copyCmd); });
        var copy = $('rs-wiz-copy');
        if (copy) copy.addEventListener('click', function () { copyFrom('rs-wiz-config', copy); });
        var recal = $('rs-recal-all');
        if (recal) recal.addEventListener('click', function () { recalibrateAll(recal); });

        // Leaflet maps inside a collapsed <details> need a size refresh on open.
        document.querySelectorAll('.rs-details').forEach(function (d) {
            d.addEventListener('toggle', function () {
                if (d.open && wizMap) setTimeout(function () { wizMap.invalidateSize(); }, 50);
            });
        });
    });
})();

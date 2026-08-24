// ==================== RelayStation Central — Home page ====================
// First paint is server-rendered; this script keeps it fresh (30s poll)
// and draws the station map.

(function () {
    'use strict';

    var map = null;
    var markerLayer = null;
    var settings = {};          // ntfy alert settings cache
    var GREEN = '#16a34a';

    function initialStations() {
        try {
            var el = document.getElementById('rs-home-data');
            return el ? JSON.parse(el.textContent) : [];
        } catch (e) { return []; }
    }

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
            el.innerHTML = '<span class="rs-meta">(could not render a QR code)</span>';
        }
    }

    function statusColor(status) {
        if (status === 'online') return '#16a34a';
        if (status === 'offline') return '#dc2626';
        return '#9ca3af';
    }

    function initMap(stations) {
        var el = document.getElementById('rs-home-map');
        if (!el || typeof L === 'undefined') return;
        map = L.map('rs-home-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19
        }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        renderMarkers(stations);
    }

    function renderMarkers(stations) {
        if (!map || !markerLayer) return;
        markerLayer.clearLayers();
        var bounds = [];
        (stations || []).forEach(function (s) {
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

    // Mirrors the server-side banner computation in api.py (home route).
    function computeBanner(stations, tags, unackedCount) {
        var offline = stations.filter(function (s) { return s.status === 'offline'; })
                              .map(function (s) { return s.station_id; });
        var online = stations.filter(function (s) { return s.status === 'online'; }).length;
        var unknown = tags.some(function (t) { return t.is_unlisted; });
        if (offline.length) {
            return { level: 'red', text: offline.length + ' station' + (offline.length === 1 ? '' : 's') +
                     ' offline — ' + offline.join(', ') };
        }
        var parts = [];
        if (unackedCount > 0) {
            parts.push(unackedCount + ' alert' + (unackedCount === 1 ? '' : 's') + ' need' +
                       (unackedCount === 1 ? 's' : '') + ' attention');
        }
        if (unknown) parts.push('Unknown tag detected');
        if (parts.length) return { level: 'amber', text: parts.join(' · ') };
        return { level: 'green', text: 'All systems operational — ' + online + ' station' +
                 (online === 1 ? '' : 's') + ' online' };
    }

    function renderBanner(banner) {
        var el = document.getElementById('rs-banner');
        if (!el) return;
        el.className = 'rs-banner rs-banner-' + banner.level;
        el.textContent = banner.text;
        var asof = document.getElementById('rs-asof');
        if (asof) {
            var now = new Date();
            var hh = String(now.getHours()).padStart(2, '0');
            var mm = String(now.getMinutes()).padStart(2, '0');
            asof.textContent = 'as of ' + hh + ':' + mm;
        }
    }

    function renderAttention(alerts) {
        var wrap = document.getElementById('rs-needs-attention');
        if (!wrap) return;
        if (!alerts.length) {
            wrap.innerHTML = '<div class="rs-card rs-empty">' +
                '<span style="color:var(--rs-green);">&#10003;</span> Nothing needs your attention.</div>';
            return;
        }
        wrap.innerHTML = alerts.map(function (a) {
            return '<div class="rs-incident ' + rsSeverityClass(a.severity) + '">' +
                '<div class="rs-incident-body">' +
                '<div class="rs-incident-title">' + escapeHtml(a.message) + '</div>' +
                '<div class="rs-incident-meta">' + rsTimeAgo(a.ts) +
                (a.station_id ? ' &middot; ' + escapeHtml(a.station_id) : '') + '</div>' +
                '</div>' +
                '<button class="rs-link-btn" onclick="rsHomeAck(' + Number(a.id) + ')">Acknowledge</button>' +
                '</div>';
        }).join('');
    }

    function renderTiles(stations, tags) {
        var online = stations.filter(function (s) { return s.status === 'online'; }).length;
        var set = function (id, v) {
            var el = document.getElementById(id);
            if (el) el.textContent = v;
        };
        set('rs-tile-stations', online + '/' + stations.length);
        set('rs-tile-tags', tags.length);
        set('rs-tile-locked', tags.filter(function (t) { return t.is_locked; }).length);
        set('rs-tile-unknown', tags.filter(function (t) { return t.is_unlisted; }).length);
    }

    function renderStationsTable(stations) {
        var tbody = document.getElementById('rs-stations-tbody');
        if (!tbody) return;
        if (!stations.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="rs-empty">' +
                'No stations yet — register one from the classic view.</td></tr>';
            return;
        }
        tbody.innerHTML = stations.map(function (s) {
            return '<tr>' +
                '<td>' + rsStatusDot(s.status) +
                '<a href="/station/' + encodeURIComponent(s.station_id) + '">' +
                escapeHtml(s.station_id) + '</a></td>' +
                '<td class="rs-meta">' + escapeHtml(s.location || '—') + '</td>' +
                '<td class="rs-meta">' + escapeHtml(s.last_seen_ago || 'Never') + '</td>' +
                '<td class="rs-num">' + (s.active_tags || 0) + '</td>' +
                '</tr>';
        }).join('');
    }

    async function poll() {
        if (window.SERVER_AUTHED !== true) return;
        try {
            var results = await Promise.all([
                fetch('/api/v1/admin/stations'),
                fetch('/api/v1/admin/tags'),
                fetch('/api/v1/admin/alerts?unacked_only=true&limit=5')
            ]);
            if (!results.every(function (r) { return r.ok; })) return;
            var stations = (await results[0].json()).stations || [];
            var tagsResp = await results[1].json();
            var tags = tagsResp.tags || [];
            var alertsResp = await results[2].json();
            var alerts = alertsResp.alerts || [];
            var unacked = alertsResp.unacked_count || 0;

            renderBanner(computeBanner(stations, tags, unacked));
            renderAttention(alerts);
            renderTiles(stations, tags);
            renderStationsTable(stations);
            renderMarkers(stations);
        } catch (e) { /* transient — retry next poll */ }
    }

    // ---------- phone alerts (ntfy) ----------

    async function loadNtfy() {
        try {
            var r = await fetch('/api/v1/admin/alerts/settings');
            if (!r.ok) return;
            settings = (await r.json()).settings || {};
            renderNtfy();
        } catch (e) { /* ignore */ }
    }

    function renderNtfy() {
        var body = $('rs-ntfy-body');
        if (!body) return;
        var topic = (settings.ntfy_topic || '').trim();
        var server = (settings.ntfy_server || 'https://ntfy.sh').replace(/\/+$/, '');

        var html = '<p style="margin:0 0 12px;">Your phone buzzes when a station goes offline or a tag ' +
            'is detected — powered by the free <b>ntfy</b> app. One-time setup:</p>';

        if (!topic) {
            html += '<div class="rs-card" style="margin-bottom:12px;">' +
                '<p style="margin:0 0 8px;">First, this server needs a private alert channel (a "topic").</p>' +
                '<button class="rs-btn" type="button" onclick="rsNtfyGenerate()">Generate topic</button>' +
                '<span class="rs-meta" id="rs-ntfy-gen-status" style="margin-left:8px;"></span>' +
                '</div>';
        } else {
            html += '<ol class="rs-steps">' +
                '<li><div class="rs-step-title">Install the ntfy app</div>' +
                '<p class="rs-meta" style="margin:0;">Search "ntfy" in the ' +
                '<a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noopener">App Store</a> or ' +
                '<a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">Google Play</a>.</p></li>' +
                '<li><div class="rs-step-title">Subscribe to this topic</div>' +
                '<p style="margin:0 0 4px;">In the app, tap + and subscribe to <code>' + escapeHtml(topic) + '</code>' +
                (server !== 'https://ntfy.sh' ? ' on server <code>' + escapeHtml(server) + '</code>' : '') +
                ' — or scan:</p>' +
                '<div class="rs-qr" id="rs-ntfy-qr"></div></li>' +
                '<li><div class="rs-step-title">Check it works</div>' +
                '<button class="rs-btn" type="button" onclick="rsNtfyTest(this)">Send me a test alert</button>' +
                '<span class="rs-meta" id="rs-ntfy-test-status" style="margin-left:8px;"></span></li>' +
                '</ol>';
        }

        html += '<details style="margin-top:8px;"><summary class="rs-meta" style="cursor:pointer;min-height:44px;display:flex;align-items:center;">Advanced settings</summary>' +
            '<div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-top:8px;">' +
            '<div class="rs-field" style="margin:0;"><label for="rs-ntfy-offline">Offline alert after (minutes)</label>' +
            '<input id="rs-ntfy-offline" class="rs-input" type="number" min="1" step="1" value="' +
            escapeHtml(settings.offline_threshold_min || '5') + '" style="width:120px;">' +
            '<span class="rs-meta">Stations on the normal 60 s check-in.</span></div>' +
            // Data-saving stations go quiet on purpose. Judging them by the
            // fast-station threshold would show them offline for most of every
            // cycle, so they get their own, and the server additionally floors
            // it by the cadence each station reports -- a value set here can
            // widen the window but never make a station flap.
            '<div class="rs-field" style="margin:0;"><label for="rs-ntfy-offline-reduced">Data-saving stations, offline after</label>' +
            '<select id="rs-ntfy-offline-reduced" class="rs-select" style="width:180px;">' +
            reducedOptions(settings.offline_threshold_reduced_min || '60') +
            '</select><span class="rs-meta">Never sooner than twice their check-in cycle.</span></div>' +
            '<div class="rs-field" style="margin:0;"><label for="rs-ntfy-silence">Quiet hours (repeat suppression, hours)</label>' +
            '<input id="rs-ntfy-silence" class="rs-input" type="number" min="0" step="1" value="' +
            escapeHtml(settings.silence_hours || '12') + '" style="width:120px;"></div>' +
            '<button class="rs-btn" type="button" onclick="rsNtfySaveAdvanced(this)">Save</button>' +
            '<span class="rs-meta" id="rs-ntfy-adv-status"></span>' +
            '</div></details>';

        body.innerHTML = html;
        if (topic) makeQr($('rs-ntfy-qr'), server + '/' + topic);
    }

    // Offline-window presets for data-saving stations, in minutes. Spans the
    // real cadences a station can be set to: the 30-minute reduced cycle at one
    // end, twice a day at the other. A saved value that is not on the list is
    // kept and shown, so a hand-set number is never silently rounded away.
    var REDUCED_PRESETS = [
        ['30', '30 minutes'],
        ['60', '1 hour'],
        ['120', '2 hours'],
        ['360', '6 hours'],
        ['1500', 'Twice a day (25 h)'],
        ['2940', 'Once a day (49 h)']
    ];

    function reducedOptions(current) {
        current = String(current);
        var known = REDUCED_PRESETS.some(function (o) { return o[0] === current; });
        var html = known ? '' : '<option value="' + escapeHtml(current) +
            '" selected>' + escapeHtml(current) + ' minutes</option>';
        REDUCED_PRESETS.forEach(function (o) {
            html += '<option value="' + o[0] + '"' +
                (o[0] === current ? ' selected' : '') + '>' + o[1] + '</option>';
        });
        return html;
    }

    window.rsNtfyGenerate = async function () {
        var status = $('rs-ntfy-gen-status');
        try {
            var topic = 'relay-' + hexKey(8); // relay- + 16 hex chars
            var resp = await post('/api/v1/admin/alerts/settings', {
                settings: { ntfy_topic: topic, ntfy_enabled: 'true' }
            });
            settings = resp.settings || settings;
            renderNtfy();
        } catch (e) {
            if (status) status.textContent = e.message;
        }
    };

    window.rsNtfyTest = async function (btn) {
        var status = $('rs-ntfy-test-status');
        btn.disabled = true;
        if (status) status.textContent = 'Sending…';
        try {
            var resp = await post('/api/v1/admin/alerts/test', {});
            if (status) {
                status.textContent = resp.delivered
                    ? 'Delivered — check your phone.'
                    : ('Not delivered: ' + (resp.detail || 'unknown error'));
                status.style.color = resp.delivered ? GREEN : 'var(--rs-red)';
            }
        } catch (e) {
            if (status) { status.textContent = e.message; status.style.color = 'var(--rs-red)'; }
        }
        btn.disabled = false;
    };

    window.rsNtfySaveAdvanced = async function (btn) {
        var status = $('rs-ntfy-adv-status');
        btn.disabled = true;
        try {
            var resp = await post('/api/v1/admin/alerts/settings', {
                settings: {
                    offline_threshold_min: String($('rs-ntfy-offline').value || '5'),
                    offline_threshold_reduced_min:
                        String($('rs-ntfy-offline-reduced').value || '60'),
                    silence_hours: String($('rs-ntfy-silence').value || '12')
                }
            });
            settings = resp.settings || settings;
            if (status) { status.textContent = 'Saved ✓'; status.style.color = GREEN; }
            setTimeout(function () { if (status) status.textContent = ''; }, 2500);
        } catch (e) {
            if (status) { status.textContent = e.message; status.style.color = 'var(--rs-red)'; }
        }
        btn.disabled = false;
    };

    // Acknowledge from the "Needs attention" card, then refresh the page data.
    window.rsHomeAck = async function (alertId) {
        await rsAckAlert(alertId);
        poll();
    };

    // Bell drawer acks should refresh the home cards too.
    document.addEventListener('rs-alerts-changed', poll);

    document.addEventListener('DOMContentLoaded', function () {
        if (window.SERVER_AUTHED !== true) return;
        initMap(initialStations());
        setInterval(poll, 30000);
        loadNtfy();
    });
})();

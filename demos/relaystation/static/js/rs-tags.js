// ==================== RelayStation Central — Tags page ====================
// First paint is server-rendered; this script re-renders on filter change,
// actions, and a 30s poll. Also draws the tag map and registry search.

(function () {
    'use strict';

    var tags = [];
    var stations = [];
    var registry = [];
    var showRetrieved = false;
    var showMuted = false;
    var frequencies = [];       // season whitelist (moved from Setup)
    var speciesCatalog = [];    // {key,label,icon} — see server/species.py
    var stationsCache = [];      // for the push count + print checklist
    var GREEN = '#16a34a';

    var map = null;
    var markerLayer = null;

    function initialData() {
        try {
            var el = document.getElementById('rs-tags-data');
            return el ? JSON.parse(el.textContent) : {};
        } catch (e) { return {}; }
    }

    function $(id) { return document.getElementById(id); }
    function mhz(khz) { return (khz / 1000).toFixed(3); }

    function stationById(sid) {
        for (var i = 0; i < stations.length; i++) {
            if (stations[i].station_id === sid) return stations[i];
        }
        return null;
    }

    // ---------- unknown tags panel ----------

    function renderUnknown() {
        var wrap = $('rs-unknown-wrap');
        if (!wrap) return;
        var unknown = tags.filter(function (t) { return t.is_unlisted && !t.is_retrieved; });
        if (!unknown.length) { wrap.innerHTML = ''; return; }
        var html = '<h2 class="rs-section-head" style="margin-top:0;">&#9888; Unknown tags detected</h2>';
        html += unknown.map(function (t) {
            return '<div class="rs-incident rs-incident-warning">' +
                '<div class="rs-incident-body">' +
                '<div class="rs-incident-title rs-num">' +
                rsSpeciesIcon(t.species) + mhz(t.frequency_khz) + ' MHz</div>' +
                '<div class="rs-incident-meta">heard by <a href="/station/' +
                encodeURIComponent(t.station_id) + '">' + escapeHtml(t.station_id) + '</a>' +
                ' &middot; last seen ' + rsTimeAgo(t.last_seen) +
                ' &middot; ' + (t.max_signal_db != null ? t.max_signal_db + ' dB' : 'signal —') +
                '</div></div>' +
                '<button class="rs-link-btn" onclick="rsAddUnknownToWhitelist(' + t.frequency_khz + ')">Add to whitelist</button>' +
                '<button class="rs-link-btn" style="color:var(--rs-muted);" onclick="rsDismissUnknown(' +
                t.frequency_khz + ', \'' + escapeHtml(t.station_id) + '\')">Dismiss</button>' +
                '</div>';
        }).join('');
        wrap.innerHTML = html;
    }

    // ---------- detections table ----------

    function filteredTags() {
        var sid = $('rs-filter-station') ? $('rs-filter-station').value : '';
        var status = $('rs-filter-status') ? $('rs-filter-status').value : 'all';
        var q = $('rs-filter-freq') ? $('rs-filter-freq').value.trim() : '';
        return tags.filter(function (t) {
            if (sid && t.station_id !== sid) return false;
            if (status === 'locked' && !t.is_locked) return false;
            if (status === 'unknown' && !t.is_unlisted) return false;
            if (q && mhz(t.frequency_khz).indexOf(q) === -1) return false;
            return true;
        });
    }

    function renderTable() {
        var tbody = $('rs-tags-tbody');
        if (!tbody) return;
        var rows = filteredTags();
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="rs-empty">' +
                (tags.length ? 'No tags match the current filters.'
                             : 'No tags detected in the last 24 hours.') + '</td></tr>';
            return;
        }
        tbody.innerHTML = rows.map(function (t) {
            var pills = '';
            if (t.is_unlisted) pills += ' <span class="rs-pill rs-pill-amber">Unknown</span>';
            if (t.is_locked) pills += ' <span class="rs-pill rs-pill-green">Locked</span>';
            if (t.is_retrieved) pills += ' <span class="rs-pill">Retrieved</span>';
            if (t.is_muted) pills += ' <span class="rs-pill" title="Hidden because you labeled this frequency noise in Review">Muted (noise)</span>';
            var actions = '';
            if (!t.is_retrieved) {
                if (!t.is_locked) {
                    actions += '<button class="rs-btn rs-btn-sm" onclick="rsLockTag(' +
                        t.frequency_khz + ', \'' + escapeHtml(t.station_id) + '\')">Lock</button> ';
                }
                actions += '<button class="rs-btn rs-btn-sm" onclick="rsRetrieveTag(' +
                    t.frequency_khz + ', \'' + escapeHtml(t.station_id) + '\')">Retrieved</button>';
            }
            return '<tr>' +
                '<td class="rs-num" style="font-weight:600;">' +
                rsSpeciesIcon(t.species) + mhz(t.frequency_khz) + ' MHz' + pills + '</td>' +
                '<td><a href="/station/' + encodeURIComponent(t.station_id) + '">' +
                escapeHtml(t.station_id) + '</a></td>' +
                '<td class="rs-num">' + (t.max_signal_db != null ? t.max_signal_db + ' dB' : '—') + '</td>' +
                '<td class="rs-num">' + (t.max_confidence != null ? t.max_confidence + '%' : '—') + '</td>' +
                '<td class="rs-num">' + (t.detection_count || 0) + '</td>' +
                '<td class="rs-meta">' + rsTimeAgo(t.first_seen) + '</td>' +
                '<td class="rs-meta">' + rsTimeAgo(t.last_seen) + '</td>' +
                '<td style="white-space:nowrap;">' + actions + '</td>' +
                '</tr>';
        }).join('');
    }

    // ---------- tag map ----------

    function initMap() {
        var el = $('rs-tags-map');
        if (!el || typeof L === 'undefined') return;
        map = L.map('rs-tags-map');
        L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
            maxZoom: 19
        }).addTo(map);
        markerLayer = L.layerGroup().addTo(map);
        renderMarkers();
    }

    function signalRadius(db) {
        if (db == null || isNaN(db)) return 6;
        return Math.max(4, Math.min(18, 4 + db / 4));
    }

    function renderMarkers() {
        if (!map || !markerLayer) return;
        markerLayer.clearLayers();
        var bounds = [];
        tags.forEach(function (t) {
            if (t.is_retrieved) return;
            var s = stationById(t.station_id);
            if (!s || s.latitude == null || s.longitude == null) return;
            var color = t.is_unlisted ? '#d97706' : (t.is_locked ? '#16a34a' : '#2563eb');
            var m = L.circleMarker([s.latitude, s.longitude], {
                radius: signalRadius(t.max_signal_db),
                color: color,
                fillColor: color,
                fillOpacity: 0.45,
                weight: 1.5
            });
            m.bindPopup(rsSpeciesIcon(t.species) +
                '<b>' + mhz(t.frequency_khz) + ' MHz</b><br>' +
                escapeHtml(t.station_id) +
                (t.species && t.species.label ? '<br>' + escapeHtml(t.species.label) : '') +
                (t.max_signal_db != null ? '<br>' + t.max_signal_db + ' dB' : ''));
            markerLayer.addLayer(m);
            bounds.push([s.latitude, s.longitude]);
        });
        if (bounds.length) {
            map.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 });
        } else {
            map.setView([36.6, -121.9], 8);
        }
    }

    // ---------- registry ----------

    function renderRegistry() {
        var tbody = $('rs-registry-tbody');
        if (!tbody) return;
        var q = ($('rs-registry-search') ? $('rs-registry-search').value : '').trim().toLowerCase();
        var rows = registry.filter(function (r) {
            if (!q) return true;
            var hay = [mhz(r.frequency_khz), r.model, r.tag_type, r.serial_number,
                       r.job_number, r.status].join(' ').toLowerCase();
            return hay.indexOf(q) !== -1;
        });
        var count = $('rs-registry-count');
        if (count) count.textContent = rows.length + (rows.length === 1 ? ' tag' : ' tags');
        if (!rows.length) {
            tbody.innerHTML = '<tr><td colspan="10" class="rs-empty">' +
                (registry.length ? 'No registry tags match your search.'
                                 : 'Registry is empty. Import the ATS database from the classic view.') +
                '</td></tr>';
            return;
        }
        tbody.innerHTML = rows.map(function (r) {
            return '<tr>' +
                '<td class="rs-num" style="font-weight:600;">' +
                rsSpeciesIcon(r.species) + mhz(r.frequency_khz) + ' MHz' +
                (r.is_custom ? ' <span class="rs-pill">Custom</span>' : '') + '</td>' +
                '<td>' + speciesPicker(r) + '</td>' +
                '<td class="rs-meta">' + escapeHtml(r.model || '-') + '</td>' +
                '<td class="rs-meta">' + escapeHtml(r.tag_type || '-') + '</td>' +
                '<td class="rs-meta rs-num">' + escapeHtml(r.serial_number || '-') + '</td>' +
                '<td class="rs-meta rs-num">' + escapeHtml(r.job_number || '-') + '</td>' +
                '<td class="rs-num">' + (r.pulse_rate_ppm != null ? r.pulse_rate_ppm + ' ppm' : '-') + '</td>' +
                '<td class="rs-num">' + (r.pulse_width_ms != null ? r.pulse_width_ms + ' ms' : '-') + '</td>' +
                '<td class="rs-meta">' + escapeHtml(r.status || '-') + '</td>' +
                '<td>' + registryAddCell(r) + '</td>' +
                '</tr>';
        }).join('');
    }

    // Species picker for a registry row. The registry is where a species is
    // recorded, because it is the only table that knows about a specific
    // transmitter rather than a frequency — and every detection at that
    // frequency then inherits it.
    //
    // A row showing a band-derived species preselects nothing: the select must
    // say "no one has recorded this", not imply an assignment that does not
    // exist. The icon beside the frequency still shows the band's guess.
    function speciesPicker(r) {
        var assigned = (r.species && r.species.source === 'registry') ? r.species.key : '';
        var opts = '<option value="">' +
            (r.species && r.species.label && !assigned
                ? escapeHtml(r.species.label) + ' (by band)'
                : 'Unassigned') + '</option>';
        speciesCatalog.forEach(function (s) {
            opts += '<option value="' + escapeHtml(s.key) + '"' +
                (s.key === assigned ? ' selected' : '') + '>' +
                escapeHtml(s.label) + '</option>';
        });
        return '<select class="rs-species-pick" ' +
            'data-key="' + escapeHtml(r.unique_key || '') + '" ' +
            'data-prev="' + escapeHtml(assigned) + '" ' +
            'onchange="rsSetSpecies(this)" aria-label="Species">' + opts + '</select>';
    }

    window.rsSetSpecies = async function (sel) {
        var uniqueKey = sel.getAttribute('data-key');
        if (!uniqueKey) return;
        var previous = sel.getAttribute('data-prev') || '';
        sel.disabled = true;
        try {
            var r = await fetch('/api/v1/admin/tags/registry/' +
                    encodeURIComponent(uniqueKey) + '/species', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ species: sel.value || null })
            });
            if (!r.ok) throw new Error('Request failed (' + r.status + ')');
            var body = await r.json();
            // Update in place, then re-pull the derived views: detections and
            // the season whitelist inherit species through the registry, so
            // all three must change together or the page contradicts itself.
            registry.forEach(function (x) {
                if (x.unique_key === uniqueKey) x.species = body.species;
            });
            sel.setAttribute('data-prev', sel.value);
            await refresh();           // detections re-resolve server-side
            await loadFrequencies();   // whitelist rows too (also re-renders registry)
        } catch (e) {
            sel.value = previous;
            alert(e.message);
        } finally {
            sel.disabled = false;
        }
    };

    // Is this registry frequency already on the season whitelist? Match within
    // the same tolerance the station uses to identify a tag (2 kHz), so a
    // registry row that is effectively the same tag reads as already added.
    function onWhitelist(freqKhz) {
        return frequencies.some(function (f) {
            return Math.abs(f.frequency_khz - freqKhz) <= 2;
        });
    }

    // Add-to-season control per registry row. The registry already holds the
    // frequency, a label source, and the pulse width, so adding is one tap with
    // nothing to retype. Already-listed rows show a static state instead.
    //
    // Only the numeric frequency is passed inline; the handler looks the rest
    // up in `registry`. Passing the label through an inline onclick would break
    // the instant a serial or model contained a quote or the closing paren.
    function registryAddCell(r) {
        if (onWhitelist(r.frequency_khz)) {
            return '<span class="rs-pill rs-pill-green">On list</span>';
        }
        return '<button class="rs-btn rs-btn-sm" type="button" ' +
            'onclick="rsAddRegistryToSeason(' + r.frequency_khz + ', this)">Add</button>';
    }

    window.rsAddRegistryToSeason = async function (freqKhz, btn) {
        var r = registry.filter(function (x) { return x.frequency_khz === freqKhz; })[0];
        if (!r) return;
        btn.disabled = true;
        var old = btn.textContent;
        btn.textContent = 'Adding';
        var label = r.serial_number ? (r.model || 'Tag') + ' ' + r.serial_number
                                    : (r.model || null);
        var body = { frequency_mhz: freqKhz / 1000, label: label || null };
        if (r.pulse_width_ms != null) body.pulse_width_ms = r.pulse_width_ms;
        try {
            await post('/api/v1/admin/frequencies', body);
            await loadFrequencies();   // refresh whitelist so this row flips to "On list"
        } catch (e) {
            btn.disabled = false;
            btn.textContent = old;
            alert('Could not add to the season list: ' + e.message);
        }
    };

    // ---------- actions ----------

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
        return r;
    }

    window.rsLockTag = async function (freqKhz, sid) {
        try { await post('/api/v1/admin/tags/lock', { frequency_khz: freqKhz, station_id: sid }); }
        catch (e) { alert(e.message); }
        refresh();
    };

    window.rsRetrieveTag = async function (freqKhz, sid) {
        try { await post('/api/v1/admin/tags/retrieve', { frequency_khz: freqKhz, station_id: sid }); }
        catch (e) { alert(e.message); }
        refresh();
    };

    window.rsAddUnknownToWhitelist = async function (freqKhz) {
        var date = new Date().toISOString().slice(0, 10);
        try {
            await post('/api/v1/admin/frequencies', {
                frequency_mhz: freqKhz / 1000,
                label: 'Added from unknown ' + date
            });
            await post('/api/v1/admin/frequencies/push', {});
            // The stored is_unlisted flag only clears on the tag's next
            // detection — reflect the new whitelist locally right away.
            tags.forEach(function (t) {
                if (t.frequency_khz === freqKhz) t.is_unlisted = 0;
            });
            renderAll();
        } catch (e) {
            alert('Could not add to whitelist: ' + e.message);
        }
    };

    window.rsDismissUnknown = async function (freqKhz, sid) {
        if (!confirm('Dismiss ' + mhz(freqKhz) + ' MHz heard by ' + sid +
                     '? It will be marked retrieved.')) return;
        try { await post('/api/v1/admin/tags/retrieve', { frequency_khz: freqKhz, station_id: sid }); }
        catch (e) { alert(e.message); }
        refresh();
    };

    window.rsClearAllTags = async function () {
        if (!confirm('Clear ALL active tags (mark every one as retrieved)?')) return;
        try { await post('/api/v1/admin/tags/clear', {}); }
        catch (e) { alert(e.message); }
        refresh();
    };

    window.rsDeleteRetrieved = async function () {
        if (!confirm('Permanently delete all retrieved tags? This cannot be undone.')) return;
        try {
            var r = await fetch('/api/v1/admin/tags/retrieved', { method: 'DELETE' });
            if (!r.ok) throw new Error('Request failed (' + r.status + ')');
        } catch (e) { alert(e.message); }
        refresh();
    };

    // ---------- data refresh ----------

    function renderAll() {
        renderUnknown();
        renderTable();
        renderMarkers();
        renderRegistry();
    }

    async function refresh() {
        if (window.SERVER_AUTHED !== true) return;
        try {
            var q = [];
            if (showRetrieved) q.push('include_retrieved=true');
            if (showMuted) q.push('include_muted=true');
            var url = '/api/v1/admin/tags' + (q.length ? '?' + q.join('&') : '');
            var r = await fetch(url);
            if (!r.ok) return;
            tags = (await r.json()).tags || [];
            renderAll();
        } catch (e) { /* transient — retry next poll */ }
    }

    // ---------- season whitelist (moved from Setup) ----------

    async function loadFrequencies() {
        try {
            var r = await fetch('/api/v1/admin/frequencies');
            if (!r.ok) return;
            frequencies = (await r.json()).frequencies || [];
            renderFrequencies();
            renderRegistry();   // keep the registry Add/On-list column in sync
        } catch (e) { /* ignore */ }
    }

    function renderFrequencies() {
        var tbody = $('rs-freq-tbody');
        if (!tbody) return;
        if (!frequencies.length) {
            tbody.innerHTML = '<tr><td colspan="4" class="rs-empty">No tags on the whitelist yet — add this season\'s below.</td></tr>';
            return;
        }
        tbody.innerHTML = frequencies.map(function (f) {
            return '<tr>' +
                '<td class="rs-num" style="font-weight:600;">' +
                rsSpeciesIcon(f.species) + mhz(f.frequency_khz) + ' MHz</td>' +
                '<td>' + escapeHtml(f.label || '—') + '</td>' +
                '<td class="rs-num">' + (f.pulse_width_ms != null ? f.pulse_width_ms + ' ms' : '—') + '</td>' +
                '<td style="text-align:right;"><button class="rs-link-btn" style="color:var(--rs-red);" ' +
                'title="Remove" onclick="rsFreqDelete(' + f.frequency_khz + ')">&times;</button></td>' +
                '</tr>';
        }).join('');
    }

    window.rsFreqDelete = async function (freqKhz) {
        if (!confirm('Remove ' + mhz(freqKhz) + ' MHz from the whitelist?')) return;
        try {
            var r = await fetch('/api/v1/admin/frequencies/' + freqKhz, { method: 'DELETE' });
            if (!r.ok) throw new Error('Request failed (' + r.status + ')');
        } catch (e) { alert(e.message); }
        loadFrequencies();
    };

    async function addFrequency() {
        var err = $('rs-freq-add-error');
        err.style.display = 'none';
        var mhzVal = parseFloat($('rs-freq-add-mhz').value);
        if (isNaN(mhzVal)) {
            err.textContent = 'Enter a frequency in MHz (e.g. 151.310).';
            err.style.display = '';
            return;
        }
        var body = {
            frequency_mhz: mhzVal,
            label: $('rs-freq-add-label').value.trim() || null
        };
        var pw = parseFloat($('rs-freq-add-pw').value);
        if (!isNaN(pw)) body.pulse_width_ms = pw;
        try {
            await post('/api/v1/admin/frequencies', body);
            $('rs-freq-add-mhz').value = '';
            $('rs-freq-add-label').value = '';
            $('rs-freq-add-pw').value = '';
            loadFrequencies();
        } catch (e) {
            err.textContent = e.message;
            err.style.display = '';
        }
    }

    async function loadStationsCache() {
        try {
            var r = await fetch('/api/v1/admin/stations');
            if (r.ok) stationsCache = (await r.json()).stations || [];
        } catch (e) { /* ignore */ }
    }

    async function pushFrequencies(btn) {
        var status = $('rs-freq-push-status');
        btn.disabled = true;
        status.textContent = 'Pushing…';
        status.style.color = '';
        try {
            await post('/api/v1/admin/frequencies/push', {});
            await loadStationsCache();
            var n = stationsCache.filter(function (s) { return s.is_active; }).length;
            status.textContent = 'Queued for ' + n + ' station' + (n === 1 ? '' : 's') +
                ' — each picks it up at its next check-in.';
            status.style.color = GREEN;
        } catch (e) {
            status.textContent = e.message;
            status.style.color = 'var(--rs-red)';
        }
        btn.disabled = false;
    }

    async function printChecklist() {
        await loadStationsCache();
        var el = $('rs-print-checklist');
        if (!el) return;
        var html = '<h1>RelayStation field checklist</h1>' +
            '<p>Printed ' + new Date().toLocaleDateString() + ' — ' + escapeHtml(location.origin) + '</p>';

        html += '<h2>Stations</h2><table><tr><th></th><th>Station</th><th>Location</th><th>Coordinates</th></tr>';
        if (stationsCache.length) {
            html += stationsCache.map(function (s) {
                var coords = (s.latitude != null && s.longitude != null)
                    ? s.latitude.toFixed(5) + ', ' + s.longitude.toFixed(5) : '—';
                return '<tr><td style="width:24px;">&#9744;</td><td>' + escapeHtml(s.station_id) +
                    '</td><td>' + escapeHtml(s.location || '—') + '</td><td>' + coords + '</td></tr>';
            }).join('');
        } else {
            html += '<tr><td colspan="4">No stations registered.</td></tr>';
        }
        html += '</table>';

        html += '<h2>Tag whitelist</h2><table><tr><th></th><th>Frequency</th><th>Label</th><th>Pulse width</th></tr>';
        if (frequencies.length) {
            html += frequencies.map(function (f) {
                return '<tr><td style="width:24px;">&#9744;</td><td>' + mhz(f.frequency_khz) +
                    ' MHz</td><td>' + escapeHtml(f.label || '—') + '</td><td>' +
                    (f.pulse_width_ms != null ? f.pulse_width_ms + ' ms' : '—') + '</td></tr>';
            }).join('');
        } else {
            html += '<tr><td colspan="4">Whitelist is empty.</td></tr>';
        }
        html += '</table>';

        el.innerHTML = html;
        window.print();
    }

    // ---------- init ----------

    document.addEventListener('DOMContentLoaded', function () {
        if (window.SERVER_AUTHED !== true) return;
        var data = initialData();
        tags = data.tags || [];
        stations = data.stations || [];
        registry = data.registry || [];
        speciesCatalog = data.species || [];

        initMap();

        ['rs-filter-station', 'rs-filter-status'].forEach(function (id) {
            var el = $(id);
            if (el) el.addEventListener('change', renderTable);
        });
        var freq = $('rs-filter-freq');
        if (freq) freq.addEventListener('input', renderTable);
        var search = $('rs-registry-search');
        if (search) search.addEventListener('input', renderRegistry);

        // The registry is collapsed by default, so a link to /tags#registry
        // would otherwise scroll to a closed section and look like nothing
        // happened. Open it, and focus the search — if you came here by that
        // link, looking something up is why.
        function openRegistryFromHash() {
            if (window.location.hash !== '#registry') return;
            var d = document.getElementById('registry');
            if (!d) return;
            d.open = true;
            d.scrollIntoView({ block: 'start' });
            if (search) search.focus({ preventScroll: true });
        }
        openRegistryFromHash();
        window.addEventListener('hashchange', openRegistryFromHash);

        var toggle = $('rs-toggle-retrieved');
        if (toggle) toggle.addEventListener('click', function () {
            showRetrieved = !showRetrieved;
            toggle.textContent = showRetrieved ? 'Hide retrieved' : 'Show retrieved';
            refresh();
        });

        var mutedToggle = $('rs-toggle-muted');
        if (mutedToggle) mutedToggle.addEventListener('click', function () {
            showMuted = !showMuted;
            mutedToggle.textContent = showMuted ? 'Hide muted (noise)' : 'Show muted (noise)';
            refresh();
        });

        // --- season whitelist wiring ---
        loadFrequencies();
        var addBtn = $('rs-freq-add-btn');
        if (addBtn) addBtn.addEventListener('click', addFrequency);
        var pushBtn = $('rs-freq-push');
        if (pushBtn) pushBtn.addEventListener('click', function () { pushFrequencies(pushBtn); });
        var printBtn = $('rs-print-btn');
        if (printBtn) printBtn.addEventListener('click', printChecklist);

        setInterval(refresh, 30000);
    });
})();

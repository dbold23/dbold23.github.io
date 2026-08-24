// ==================== RelayStation Central — Station detail ====================
(function () {
    'use strict';

    var DATA = (function () {
        try { return JSON.parse(document.getElementById('rs-station-data').textContent); }
        catch (e) { return {}; }
    })();
    var SID = DATA.station_id || '';
    var STATION_ONLINE = DATA.status === 'online';
    var DIAG_KEY = 'rsDiag:' + SID;

    var GRAY = '#6b7280';
    var DARK = '#111827';
    var GREEN = '#16a34a';
    var AMBER = '#d97706';
    var RED = '#dc2626';

    var knownFrequencies = null;   // whitelist, fetched once for the spectrum markers
    var diagPollTimer = null;
    var flashTimer = null;

    // ---------- small utils ----------

    function $(id) { return document.getElementById(id); }

    function fmtUptime(sec) {
        if (sec == null || isNaN(sec)) return '—';
        sec = Math.floor(sec);
        var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600),
            m = Math.floor((sec % 3600) / 60);
        if (d > 0) return d + 'd ' + h + 'h';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
    }

    function dotFor(state) { return rsStatusDot(state); }

    function decodeThrottle(thr) {
        if (thr == null || thr === '') return null;
        var v = parseInt(String(thr), 16);
        if (isNaN(v)) return null;
        if (v & 0x1) return { cls: 'rs-pill rs-pill-red', text: 'Under-voltage now' };
        if (v & 0x10000) return { cls: 'rs-pill rs-pill-amber', text: 'Under-voltage occurred' };
        return { cls: 'rs-pill rs-pill-green', text: 'Power OK' };
    }

    function sevClass(sev) {
        if (sev === 'critical') return 'rs-incident-critical';
        if (sev === 'warning') return 'rs-incident-warning';
        return 'rs-incident-info';
    }

    // ---------- section switching (hash-linkable) ----------

    var SECTIONS = ['status', 'detections', 'maintenance', 'logs'];

    function showSection(name) {
        if (SECTIONS.indexOf(name) === -1) name = 'status';
        SECTIONS.forEach(function (s) {
            var sec = $('rs-sec-' + s);
            if (sec) sec.classList.toggle('active', s === name);
        });
        document.querySelectorAll('#rs-anchors a').forEach(function (a) {
            a.classList.toggle('active', a.dataset.section === name);
        });
    }

    function onHashChange() {
        showSection((location.hash || '#status').slice(1));
    }

    // ---------- status: sparklines + uptime + throttle ----------

    async function loadHealth() {
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(SID) + '/health?hours=24');
            if (!r.ok) return;
            var data = await r.json();
            var pts = data.points || [];
            var series = { cpu: [], mem: [], temp: [], w: [] };
            pts.forEach(function (p) {
                series.cpu.push(p.cpu); series.mem.push(p.mem);
                series.temp.push(p.temp); series.w.push(p.w);
            });
            ['cpu', 'mem', 'temp', 'w'].forEach(function (k) {
                var el = $('rs-spark-' + k);
                if (el) el.innerHTML = rsSparkline(series[k], { w: 140, h: 36, color: GRAY });
            });
        } catch (e) { /* ignore */ }
    }

    function renderStatic() {
        var up = $('rs-kv-uptime');
        if (up) up.textContent = fmtUptime(DATA.uptime_seconds);
        var badgeEl = $('rs-throttle-badge');
        if (badgeEl) {
            var badge = decodeThrottle(DATA.throttled_flags);
            if (badge) badgeEl.outerHTML = '<span class="' + badge.cls + '">' + badge.text + '</span>';
        }
    }

    // ---------- detections ----------

    async function loadDetections() {
        var tbody = $('rs-det-tbody');
        if (!tbody) return;
        try {
            var r = await fetch('/api/v1/admin/tags');
            if (!r.ok) return;
            var tags = ((await r.json()).tags || []).filter(function (t) {
                return t.station_id === SID;
            });
            if (!tags.length) {
                tbody.innerHTML = '<tr><td colspan="7" class="rs-empty">' +
                    'No tags detected by this station in the last 24 hours.</td></tr>';
                return;
            }
            tbody.innerHTML = tags.map(function (t) {
                var mhz = (t.frequency_khz / 1000).toFixed(3);
                var unknown = t.is_unlisted ?
                    ' <span class="rs-pill rs-pill-amber">Unknown</span>' : '';
                var locked = t.is_locked ?
                    '<span class="rs-pill">Locked</span> ' : '';
                var actions = locked +
                    (!t.is_locked ? '<button class="rs-btn rs-btn-sm" onclick="rsLockTag(' +
                        t.frequency_khz + ')">Lock</button> ' : '') +
                    '<button class="rs-btn rs-btn-sm" onclick="rsRetrieveTag(' +
                        t.frequency_khz + ')">Retrieved</button>';
                return '<tr>' +
                    '<td class="rs-num" style="font-weight:600;">' +
                    rsSpeciesIcon(t.species) + mhz + ' MHz' + unknown + '</td>' +
                    '<td class="rs-num">' + (t.max_signal_db != null ? t.max_signal_db + ' dB' : '—') + '</td>' +
                    '<td class="rs-num">' + (t.max_confidence != null ? t.max_confidence + '%' : '—') + '</td>' +
                    '<td class="rs-num">' + (t.detection_count || 0) + '</td>' +
                    '<td class="rs-meta">' + rsTimeAgo(t.first_seen) + '</td>' +
                    '<td class="rs-meta">' + rsTimeAgo(t.last_seen) + '</td>' +
                    '<td style="white-space:nowrap;">' + actions + '</td>' +
                    '</tr>';
            }).join('');
        } catch (e) { /* ignore */ }
    }

    window.rsLockTag = async function (freqKhz) {
        try {
            await fetch('/api/v1/admin/tags/lock', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frequency_khz: freqKhz, station_id: SID })
            });
        } catch (e) { /* ignore */ }
        loadDetections();
    };

    window.rsRetrieveTag = async function (freqKhz) {
        try {
            await fetch('/api/v1/admin/tags/retrieve', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frequency_khz: freqKhz, station_id: SID })
            });
        } catch (e) { /* ignore */ }
        loadDetections();
    };

    // ---------- logs ----------

    async function loadLogs() {
        var tbody = $('rs-logs-tbody');
        if (!tbody) return;
        try {
            var r = await fetch('/api/v1/admin/logs?station_id=' + encodeURIComponent(SID) + '&limit=50');
            if (!r.ok) return;
            var logs = (await r.json()).logs || [];
            if (!logs.length) {
                tbody.innerHTML = '<tr><td colspan="3" class="rs-empty">No logs from this station yet.</td></tr>';
                return;
            }
            tbody.innerHTML = logs.map(function (l) {
                var pill = 'rs-pill';
                if (l.level === 'ERROR' || l.level === 'CRITICAL') pill += ' rs-pill-red';
                else if (l.level === 'WARNING') pill += ' rs-pill-amber';
                return '<tr>' +
                    '<td class="rs-meta" style="white-space:nowrap;">' + rsTimeAgo(l.log_timestamp) + '</td>' +
                    '<td><span class="' + pill + '">' + escapeHtml(l.level) + '</span></td>' +
                    '<td>' + escapeHtml(l.message) + '</td>' +
                    '</tr>';
            }).join('');
        } catch (e) { /* ignore */ }
    }

    // ---------- commands ----------

    async function sendCommand(commandType, btn) {
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(SID) + '/commands', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command_type: commandType })
            });
            if (r.ok && btn) {
                var orig = btn.textContent;
                btn.textContent = 'Queued ✓';
                btn.disabled = true;
                setTimeout(function () { btn.textContent = orig; btn.disabled = false; }, 2500);
            }
        } catch (e) { /* ignore */ }
    }

    async function deleteStation() {
        if (!confirm('Delete station "' + SID + '" and all of its data? This cannot be undone.')) return;
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(SID), { method: 'DELETE' });
            if (r.ok) location.href = '/';
        } catch (e) { /* ignore */ }
    }

    // ---------- diagnostics: state machine ----------

    function getStoredRun() {
        try { return JSON.parse(sessionStorage.getItem(DIAG_KEY)); }
        catch (e) { return null; }
    }
    function setStoredRun(run) { sessionStorage.setItem(DIAG_KEY, JSON.stringify(run)); }
    function clearStoredRun() { sessionStorage.removeItem(DIAG_KEY); }

    function setDiagStatus(html, color) {
        var el = $('rs-diag-status');
        if (!el) return;
        el.innerHTML = html;
        el.style.color = color || '';
    }

    function flashFreshResults() {
        setDiagStatus('Fresh results', GREEN);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(function () { setDiagStatus(''); }, 5000);
    }

    function startDiagPolling() {
        if (diagPollTimer) return;
        diagPollTimer = setInterval(refreshDiagnostics, 20000);
    }
    function stopDiagPolling() {
        if (diagPollTimer) { clearInterval(diagPollTimer); diagPollTimer = null; }
    }

    function updateRunButton(pending) {
        var btn = $('rs-run-diag');
        if (!btn) return;
        btn.disabled = !STATION_ONLINE || !!pending;
        if (!STATION_ONLINE) btn.title = 'Station is offline';
        else if (pending) btn.title = 'A diagnostics run is already in progress';
        else btn.title = '';
    }

    async function refreshDiagnostics() {
        var data;
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(SID) + '/diagnostics/latest');
            if (!r.ok) return;
            data = await r.json();
        } catch (e) { return; }

        var latest = data.latest || null;
        var pending = data.pending_run || null;
        var stored = getStoredRun();

        // A run we requested finished: no pending command and a bundle newer
        // than the request time arrived.
        if (stored && !pending && latest) {
            var bundleMs = rsParseTime(latest.received_at || latest.ts);
            if (!isNaN(bundleMs) && bundleMs >= stored.requested_at) {
                clearStoredRun();
                stored = null;
                flashFreshResults();
            }
        }
        // Give up remembering a request after 30 minutes.
        if (stored && Date.now() - stored.requested_at > 30 * 60 * 1000) {
            clearStoredRun();
            stored = null;
        }

        if (pending) {
            if (pending.status === 'queued') {
                setDiagStatus('Queued — the station checks in every few minutes and will start automatically.');
            } else {
                setDiagStatus('Running diagnostics (takes 2–5 minutes)…');
            }
        } else if (stored) {
            if (Date.now() - stored.requested_at > 15 * 60 * 1000) {
                setDiagStatus('No results yet — the station may be offline.', AMBER);
            } else {
                setDiagStatus('Waiting for results…');
            }
        }

        updateRunButton(pending);
        renderDiagLine(latest);
        renderRecommendations(latest);
        await renderWidgets(latest);

        if (pending || getStoredRun()) startDiagPolling(); else stopDiagPolling();
    }

    async function runDiagnostics() {
        var btn = $('rs-run-diag');
        if (btn) btn.disabled = true;
        try {
            var r = await fetch('/api/v1/admin/stations/' + encodeURIComponent(SID) + '/diagnostics/run', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
            });
            if (!r.ok) { if (btn) btn.disabled = false; return; }
            var data = await r.json();
            setStoredRun({ command_id: data.command_id, requested_at: Date.now() });
            setDiagStatus('Queued — the station checks in every few minutes and will start automatically.');
            startDiagPolling();
        } catch (e) {
            if (btn) btn.disabled = false;
        }
    }

    // ---------- diagnostics: summary line ----------

    function renderDiagLine(latest) {
        var el = $('rs-diag-line');
        if (!el) return;
        if (!latest) {
            el.innerHTML = 'Last diagnostics: none yet — <a href="#maintenance" class="rs-link-btn" style="padding:0;">run one</a>';
            return;
        }
        var n = (latest.analysis || []).length;
        el.innerHTML = 'Last diagnostics: ' + rsTimeAgo(latest.received_at || latest.ts) +
            ' — ' + n + ' finding' + (n === 1 ? '' : 's') +
            ' <a href="#maintenance" class="rs-link-btn" style="padding:0;">View</a>';
    }

    // ---------- diagnostics: recommendation cards ----------

    function renderRecommendations(latest) {
        var wrap = $('rs-recs');
        if (!wrap) return;
        if (!latest) {
            wrap.innerHTML = '<div class="rs-card rs-empty">No diagnostics yet — run one to see ' +
                'RF environment, power, and pipeline health.</div>';
            return;
        }
        var findings = latest.analysis || [];
        if (!findings.length) {
            wrap.innerHTML = '<div class="rs-incident" style="border-left-color:' + GREEN + ';">' +
                '<div class="rs-incident-body"><div class="rs-incident-title">All checks passed.</div>' +
                '<div class="rs-incident-meta">' + rsTimeAgo(latest.received_at || latest.ts) + '</div></div></div>';
            return;
        }
        wrap.innerHTML = findings.map(function (f) {
            return '<div class="rs-incident ' + sevClass(f.severity) + '">' +
                '<div class="rs-incident-body">' +
                '<div class="rs-incident-title">' + escapeHtml(f.message) + '</div>' +
                '<div class="rs-incident-meta">' + escapeHtml(f.rule || '') + '</div>' +
                '</div></div>';
        }).join('');
    }

    // ---------- diagnostics: widgets ----------

    async function fetchKnownFrequencies() {
        if (knownFrequencies !== null) return knownFrequencies;
        try {
            var r = await fetch('/api/v1/admin/frequencies');
            knownFrequencies = r.ok ? ((await r.json()).frequencies || []) : [];
        } catch (e) { knownFrequencies = []; }
        return knownFrequencies;
    }

    function widgetCard(title, inner) {
        return '<div class="rs-card"><h3 class="rs-card-title">' + title + '</h3>' + inner + '</div>';
    }

    function renderSpectrum(rf, freqs) {
        var W = 600, H = 200;
        var padL = 44, padR = 12, padT = 14, padB = 26;
        var bins = rf.bins || [];
        if (!bins.length) return '<div class="rs-empty">No survey data.</div>';
        var f0 = rf.f_start_mhz, f1 = rf.f_stop_mhz;
        var maxDb = Math.max(10, Math.max.apply(null, bins) * 1.15);
        var x = function (fMhz) { return padL + ((fMhz - f0) / (f1 - f0)) * (W - padL - padR); };
        var xi = function (i) { return padL + (i / (bins.length - 1)) * (W - padL - padR); };
        var y = function (db) { return H - padB - (db / maxDb) * (H - padT - padB); };

        var pts = bins.map(function (v, i) { return xi(i).toFixed(1) + ',' + y(v).toFixed(1); }).join(' ');
        var base = y(0);

        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" class="rs-chart-svg">';
        // frame + axis labels
        svg += '<text x="' + padL + '" y="' + (H - 8) + '" font-size="10" fill="' + GRAY + '">' + f0.toFixed(2) + ' MHz</text>';
        svg += '<text x="' + (W - padR) + '" y="' + (H - 8) + '" font-size="10" fill="' + GRAY + '" text-anchor="end">' + f1.toFixed(2) + ' MHz</text>';
        // whitelist markers (behind trace)
        (freqs || []).forEach(function (f) {
            var mhz = f.frequency_khz / 1000;
            if (mhz < f0 || mhz > f1) return;
            var label = mhz.toFixed(3) + ' MHz' + (f.label ? ' — ' + f.label : '');
            svg += '<line x1="' + x(mhz).toFixed(1) + '" y1="' + padT + '" x2="' + x(mhz).toFixed(1) +
                '" y2="' + base.toFixed(1) + '" stroke="#d1d5db" stroke-width="1.5">' +
                '<title>' + escapeHtml(label) + '</title></line>';
        });
        // dashed noise-floor baseline
        svg += '<line x1="' + padL + '" y1="' + base.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + base.toFixed(1) +
            '" stroke="' + GRAY + '" stroke-width="1" stroke-dasharray="4 3"/>';
        svg += '<text x="' + (padL - 4) + '" y="' + (base - 3).toFixed(1) + '" font-size="10" fill="' + GRAY +
            '" text-anchor="end">' + (rf.nf_db != null ? rf.nf_db + ' dB' : 'floor') + '</text>';
        // trace
        svg += '<polyline points="' + pts + '" fill="none" stroke="' + DARK + '" stroke-width="1.2"/>';
        // peak dots
        (rf.peaks || []).forEach(function (p) {
            svg += '<circle cx="' + x(p.f_mhz).toFixed(1) + '" cy="' + y(p.db_over_floor).toFixed(1) +
                '" r="3.5" fill="' + DARK + '">' +
                '<title>' + escapeHtml(p.f_mhz.toFixed(3) + ' MHz, +' + p.db_over_floor + ' dB over floor') + '</title></circle>';
        });
        svg += '</svg>';
        return svg +
            '<div class="rs-latency-caption">Signal strength across the scan band. ' +
            'Gray vertical lines mark your whitelisted tag frequencies (hover for labels).</div>';
    }

    function renderCalibration(cal) {
        var rows = (cal.sweep || []).map(function (s) {
            return '<tr><td class="rs-num">' + s.gain + '</td>' +
                '<td class="rs-num">' + (s.noise_floor != null ? s.noise_floor.toFixed(1) : '—') + ' dB</td>' +
                '<td class="rs-num">' + (s.noise_std != null ? s.noise_std : '—') + '</td></tr>';
        }).join('');
        var line = '';
        if (cal.recommended_gain != null) {
            line = '<p style="margin:0 0 8px;font-size:14px;">Suggested gain <b>' + cal.recommended_gain +
                '</b> (configured ' + (cal.configured_gain != null ? cal.configured_gain : '—') + ')</p>';
        }
        return line + '<div class="rs-table-scroll"><table class="rs-table"><thead>' +
            '<tr><th>Gain</th><th>Noise floor</th><th>Noise std</th></tr></thead>' +
            '<tbody>' + rows + '</tbody></table></div>';
    }

    function renderPower(pw) {
        var badge = decodeThrottle(pw.throttled);
        var badgeHtml = badge ? '<span class="' + badge.cls + '">' + badge.text + '</span>' : '';
        return '<div class="rs-kv">' +
            '<div><div class="rs-kv-label">Total power</div><div class="rs-kv-value">' +
            (pw.total_w != null ? pw.total_w + ' W' : '—') + '</div></div>' +
            '<div><div class="rs-kv-label">CPU temperature</div><div class="rs-kv-value">' +
            (pw.cpu_temp_c != null ? pw.cpu_temp_c + '°C' : '—') + '</div></div>' +
            '<div><div class="rs-kv-label">CPU clock</div><div class="rs-kv-value">' +
            (pw.cpu_freq_mhz != null ? pw.cpu_freq_mhz + ' MHz' : '—') + '</div></div>' +
            '<div><div class="rs-kv-label">Throttling</div><div class="rs-kv-value">' + (badgeHtml || '—') + '</div></div>' +
            '</div>';
    }

    function latencyBar(pipe) {
        var budget = pipe.budget_ms || 128;
        var mean = pipe.frame_latency_ms_mean, p95 = pipe.frame_latency_ms_p95;
        if (mean == null && p95 == null) return '';
        var W = 600, H = 46, padL = 8, padR = 8, barY = 8, barH = 14;
        var scaleMax = Math.max(budget, p95 || 0, mean || 0) * 1.05;
        var x = function (v) { return padL + (v / scaleMax) * (W - padL - padR); };
        var worst = p95 != null ? p95 : mean;
        var color = worst < 100 ? GREEN : (worst < budget ? AMBER : RED);
        var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" class="rs-chart-svg">';
        svg += '<rect x="' + padL + '" y="' + barY + '" width="' + (W - padL - padR) + '" height="' + barH +
            '" rx="4" fill="#f3f4f6" stroke="#e5e7eb"/>';
        if (mean != null) {
            svg += '<rect x="' + padL + '" y="' + barY + '" width="' + (x(mean) - padL).toFixed(1) +
                '" height="' + barH + '" rx="4" fill="' + color + '"/>';
            svg += '<text x="' + x(mean).toFixed(1) + '" y="' + (barY + barH + 14) + '" font-size="10" fill="' + GRAY +
                '" text-anchor="middle">mean ' + mean + ' ms</text>';
        }
        if (p95 != null) {
            svg += '<line x1="' + x(p95).toFixed(1) + '" y1="' + (barY - 4) + '" x2="' + x(p95).toFixed(1) +
                '" y2="' + (barY + barH + 4) + '" stroke="' + DARK + '" stroke-width="2"/>';
            svg += '<text x="' + x(p95).toFixed(1) + '" y="' + (barY + barH + 26) + '" font-size="10" fill="' + DARK +
                '" text-anchor="middle">p95 ' + p95 + ' ms</text>';
        }
        svg += '<line x1="' + x(budget).toFixed(1) + '" y1="' + (barY - 4) + '" x2="' + x(budget).toFixed(1) +
            '" y2="' + (barY + barH + 4) + '" stroke="' + GRAY + '" stroke-width="1" stroke-dasharray="3 3"/>';
        svg += '<text x="' + x(budget).toFixed(1) + '" y="' + (barY - 6 + 4) + '" font-size="10" fill="' + GRAY +
            '" text-anchor="middle">budget ' + budget + '</text>';
        svg += '</svg>';
        return svg + '<div class="rs-latency-caption">Time to process each radio sample — must stay under ' +
            budget + ' ms.</div>';
    }

    function healthRow(label, value, state) {
        return '<tr><td>' + dotFor(state) + label + '</td>' +
            '<td class="rs-num" style="text-align:right;">' + value + '</td></tr>';
    }

    function renderPipeline(pipe) {
        var html = latencyBar(pipe);

        var rows = '';
        if (pipe.frames_processed != null) {
            rows += healthRow('Frames processed', pipe.frames_processed.toLocaleString(), 'green');
        }
        if (pipe.sdr_read_failures != null) {
            var f = pipe.sdr_read_failures;
            rows += healthRow('SDR read failures', f, f > 5 ? 'red' : (f > 0 ? 'amber' : 'green'));
        }
        if (pipe.uplink_queue_depth != null) {
            var q = pipe.uplink_queue_depth;
            rows += healthRow('Upload queue', q, q > 500 ? 'red' : (q > 50 ? 'amber' : 'green'));
        }
        if (pipe.disk_free_gb != null) {
            var g = pipe.disk_free_gb;
            rows += healthRow('Disk free', g + ' GB', g < 1 ? 'red' : (g < 5 ? 'amber' : 'green'));
        }
        if (pipe.discovery_templates != null) {
            var t = pipe.discovery_templates;
            rows += healthRow('Discovery templates', t, t > 0 ? 'amber' : 'green');
        }
        if (rows) {
            html += '<table class="rs-table" style="margin-top:12px;"><tbody>' + rows + '</tbody></table>';
        }

        var counts = [];
        Object.keys(pipe.stage_counts || {}).forEach(function (k) {
            counts.push('<tr><td class="rs-meta">' + escapeHtml(k) + '</td><td class="rs-num rs-meta" style="text-align:right;">' +
                pipe.stage_counts[k] + '</td></tr>');
        });
        Object.keys(pipe.rejections || {}).forEach(function (k) {
            counts.push('<tr><td class="rs-meta">rejected: ' + escapeHtml(k) + '</td><td class="rs-num rs-meta" style="text-align:right;">' +
                pipe.rejections[k] + '</td></tr>');
        });
        if (counts.length) {
            html += '<table class="rs-table" style="margin-top:12px;"><tbody>' + counts.join('') + '</tbody></table>';
        }
        return html;
    }

    function renderDutyCycle(dc) {
        var pct = dc.duty_pct != null ? dc.duty_pct : (
            dc.sample_seconds ? Math.round(100 * dc.sample_seconds / (dc.sample_seconds + (dc.sleep_seconds || 0))) : null);
        return '<p style="margin:0;font-size:14px;">Awake <b>' + (pct != null ? pct + '%' : '—') +
            '</b> of the time (' + (dc.sample_seconds || '?') + 's sample / ' + (dc.sleep_seconds || '?') + 's sleep).</p>';
    }

    async function renderWidgets(latest) {
        var wrap = $('rs-widgets');
        if (!wrap) return;
        if (!latest || !latest.payload || !Object.keys(latest.payload).length) {
            wrap.innerHTML = '';
            return;
        }
        var p = latest.payload;
        var parts = [];
        if (p.rf_survey) {
            var freqs = await fetchKnownFrequencies();
            parts.push(widgetCard('RF environment', renderSpectrum(p.rf_survey, freqs)));
        }
        if (p.pipeline) parts.push(widgetCard('Detection pipeline', renderPipeline(p.pipeline)));
        if (p.power) parts.push(widgetCard('Power', renderPower(p.power)));
        if (p.calibration) parts.push(widgetCard('Gain calibration', renderCalibration(p.calibration)));
        if (p.duty_cycle) parts.push(widgetCard('Duty cycle', renderDutyCycle(p.duty_cycle)));
        wrap.innerHTML = '<h3 class="rs-section-head" style="margin-top:24px;">Details</h3>' +
            '<div>' + parts.map(function (c) { return '<div style="margin-top:16px;">' + c + '</div>'; }).join('') + '</div>';
    }

    // ---------- init ----------

    document.addEventListener('DOMContentLoaded', function () {
        if (window.SERVER_AUTHED !== true || !SID) return;

        onHashChange();
        window.addEventListener('hashchange', onHashChange);

        renderStatic();
        loadHealth();
        loadDetections();
        loadLogs();
        refreshDiagnostics();

        var recal = $('rs-btn-recalibrate');
        var restart = $('rs-btn-restart');
        var update = $('rs-btn-update');
        var del = $('rs-btn-delete');
        var run = $('rs-run-diag');
        if (recal) recal.addEventListener('click', function () { sendCommand('recalibrate', recal); });
        if (restart) restart.addEventListener('click', function () { sendCommand('restart', restart); });
        if (update) update.addEventListener('click', function () { sendCommand('update', null); });
        if (del) del.addEventListener('click', deleteStation);
        if (run) run.addEventListener('click', runDiagnostics);
        if (!STATION_ONLINE) {
            [recal, restart].forEach(function (b) { if (b) { b.disabled = true; b.title = 'Station is offline'; } });
        }
        updateRunButton(null);
    });
})();

// ==================== RelayStation Central — More page ====================
// The tables are server-rendered; this script wires the log station filter.

(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // ---------- logs filter ----------

    function levelPill(level) {
        var cls = 'rs-pill';
        if (level === 'ERROR' || level === 'CRITICAL') cls += ' rs-pill-red';
        else if (level === 'WARNING') cls += ' rs-pill-amber';
        return '<span class="' + cls + '">' + escapeHtml(level) + '</span>';
    }

    async function loadLogs() {
        var tbody = $('rs-logs-tbody');
        if (!tbody) return;
        var sid = $('rs-logs-station') ? $('rs-logs-station').value : '';
        var url = '/api/v1/admin/logs?limit=100' +
            (sid ? '&station_id=' + encodeURIComponent(sid) : '');
        try {
            var r = await fetch(url);
            if (!r.ok) return;
            var logs = (await r.json()).logs || [];
            if (!logs.length) {
                tbody.innerHTML = '<tr><td colspan="4" class="rs-empty">No logs' +
                    (sid ? ' from ' + escapeHtml(sid) : '') + ' yet.</td></tr>';
                return;
            }
            tbody.innerHTML = logs.map(function (l) {
                return '<tr>' +
                    '<td class="rs-meta" style="white-space:nowrap;">' + rsTimeAgo(l.log_timestamp) + '</td>' +
                    '<td>' + levelPill(l.level) + '</td>' +
                    '<td class="rs-meta">' + escapeHtml(l.station_id || '') + '</td>' +
                    '<td>' + escapeHtml(l.message) + '</td>' +
                    '</tr>';
            }).join('');
        } catch (e) { /* ignore */ }
    }

    // ---------- init ----------

    document.addEventListener('DOMContentLoaded', function () {
        if (window.SERVER_AUTHED !== true) return;
        var sel = $('rs-logs-station');
        if (sel) sel.addEventListener('change', loadLogs);
    });
})();

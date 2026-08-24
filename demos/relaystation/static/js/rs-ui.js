// ==================== RelayStation Central shared UI (rs-) ====================
// Globals used by every rs- page: time formatting, sparklines, status dots,
// HTML escaping, and the header bell + alert drawer.

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Accepts epoch seconds, epoch millis, ISO strings, or SQLite
// "YYYY-MM-DD HH:MM:SS" (UTC) strings.
function rsParseTime(value) {
    if (value == null || value === '') return NaN;
    if (typeof value === 'number') {
        return value < 1e12 ? value * 1000 : value;
    }
    var s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) {
        var n = parseFloat(s);
        return n < 1e12 ? n * 1000 : n;
    }
    s = s.replace(' ', 'T');
    // SQLite CURRENT_TIMESTAMP is UTC but carries no zone marker.
    if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += 'Z';
    return Date.parse(s);
}

function rsTimeAgo(value) {
    var t = rsParseTime(value);
    if (isNaN(t)) return 'never';
    var d = (Date.now() - t) / 1000;
    if (d < 5) return 'just now';
    if (d < 60) return Math.floor(d) + 's ago';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    return Math.floor(d / 86400) + 'd ago';
}

// Species mark for a tag row. `species` is the dict the server resolves
// (key/label/icon/source/certain); anything falsy renders an empty box of the
// same size so the frequency column stays aligned down a mixed list.
//
// A band-derived species is drawn faintly and says so on hover. The dashboard
// must not render "the 164 MHz band belongs to the otter project" and "this
// transmitter is on an otter" with the same confidence — that is the same
// conflation that put 30 phantom tags on this page.
function rsSpeciesIcon(species) {
    if (!species || !species.label) return '<span class="rs-species rs-species-none"></span>';
    var certain = species.certain;
    var title = species.label + (certain ? '' : ' (from frequency band)');
    if (!species.icon) {
        // No artwork for this species yet. Same box, short label — a full name
        // is unreadable at icon size and a variable-width one would shove the
        // frequency sideways on just these rows.
        return '<span class="rs-species rs-species-text' +
            (certain ? '' : ' rs-species-guess') + '" title="' +
            escapeHtml(title) + '">' +
            escapeHtml(species.abbr || species.label) + '</span>';
    }
    return '<span class="rs-species' + (certain ? '' : ' rs-species-guess') +
        '" role="img" aria-label="' + escapeHtml(title) + '" title="' +
        escapeHtml(title) + '" style="-webkit-mask-image:url(' + species.icon +
        ');mask-image:url(' + species.icon + ');"></span>';
}

function rsStatusDot(status) {
    var cls = { online: 'online', offline: 'offline', never_seen: 'never_seen',
                green: 'green', amber: 'amber', red: 'red' }[status] || 'never_seen';
    return '<span class="rs-dot rs-dot-' + cls + '"></span>';
}

// Inline SVG sparkline from an array of numbers (nulls skipped).
function rsSparkline(values, opts) {
    opts = opts || {};
    var w = opts.w || 140, h = opts.h || 36, color = opts.color || '#6b7280';
    var pts = [];
    var nums = (values || []).filter(function (v) { return typeof v === 'number' && isFinite(v); });
    if (nums.length < 2) {
        return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg">' +
            '<text x="' + (w / 2) + '" y="' + (h / 2 + 4) + '" text-anchor="middle" ' +
            'font-size="11" fill="#9ca3af">no data</text></svg>';
    }
    var min = Math.min.apply(null, nums), max = Math.max.apply(null, nums);
    var span = (max - min) || 1;
    var pad = 3;
    var n = values.length;
    for (var i = 0; i < n; i++) {
        var v = values[i];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        var x = n > 1 ? (i / (n - 1)) * (w - 2 * pad) + pad : w / 2;
        var y = h - pad - ((v - min) / span) * (h - 2 * pad);
        pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">' +
        '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color +
        '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}

// ==================== Kebab menus ====================

function rsToggleMenu(btn) {
    var menu = btn.parentElement.querySelector('.rs-menu');
    if (!menu) return;
    var wasOpen = menu.classList.contains('open');
    document.querySelectorAll('.rs-menu.open').forEach(function (m) { m.classList.remove('open'); });
    if (!wasOpen) menu.classList.add('open');
}

document.addEventListener('click', function (e) {
    if (!e.target.closest('.rs-kebab-wrap')) {
        document.querySelectorAll('.rs-menu.open').forEach(function (m) { m.classList.remove('open'); });
    }
});

// ==================== Bell + alert drawer ====================

var _rsAlerts = [];

function rsSeverityClass(severity) {
    if (severity === 'critical') return 'rs-incident-critical';
    if (severity === 'warning') return 'rs-incident-warning';
    return 'rs-incident-info';
}

function rsRenderDrawer() {
    var body = document.getElementById('rs-drawer-body');
    if (!body) return;
    if (!_rsAlerts.length) {
        body.innerHTML = '<div class="rs-empty">Nothing needs your attention.</div>';
        return;
    }
    body.innerHTML = _rsAlerts.map(function (a) {
        return '<div class="rs-incident ' + rsSeverityClass(a.severity) + '">' +
            '<div class="rs-incident-body">' +
            '<div class="rs-incident-title">' + escapeHtml(a.message) + '</div>' +
            '<div class="rs-incident-meta">' + rsTimeAgo(a.ts) +
            (a.station_id ? ' &middot; ' + escapeHtml(a.station_id) : '') + '</div>' +
            '</div>' +
            '<button class="rs-link-btn" onclick="rsAckAlert(' + Number(a.id) + ')">Acknowledge</button>' +
            '</div>';
    }).join('');
}

function rsUpdateBellBadge(count) {
    var badge = document.getElementById('rs-bell-badge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

async function rsPollAlerts() {
    if (window.SERVER_AUTHED !== true) return;
    try {
        var r = await fetch('/api/v1/admin/alerts?unacked_only=true&limit=15');
        if (!r.ok) return;
        var data = await r.json();
        _rsAlerts = data.alerts || [];
        rsUpdateBellBadge(data.unacked_count || 0);
        rsRenderDrawer();
    } catch (e) { /* transient network error — try again next poll */ }
}

async function rsAckAlert(alertId) {
    try {
        var r = await fetch('/api/v1/admin/alerts/' + alertId + '/ack', { method: 'POST' });
        if (r.ok) {
            var data = await r.json();
            _rsAlerts = _rsAlerts.filter(function (a) { return a.id !== alertId; });
            rsUpdateBellBadge(data.unacked_count || 0);
            rsRenderDrawer();
            document.dispatchEvent(new CustomEvent('rs-alerts-changed'));
        }
    } catch (e) { /* ignore */ }
}

async function rsAckAllAlerts() {
    try {
        var r = await fetch('/api/v1/admin/alerts/ack_all', { method: 'POST' });
        if (r.ok) {
            _rsAlerts = [];
            rsUpdateBellBadge(0);
            rsRenderDrawer();
            document.dispatchEvent(new CustomEvent('rs-alerts-changed'));
        }
    } catch (e) { /* ignore */ }
}

function rsOpenDrawer() {
    var d = document.getElementById('rs-drawer');
    var b = document.getElementById('rs-drawer-backdrop');
    if (d) d.classList.add('open');
    if (b) b.classList.add('open');
    rsPollAlerts();
}

function rsCloseDrawer() {
    var d = document.getElementById('rs-drawer');
    var b = document.getElementById('rs-drawer-backdrop');
    if (d) d.classList.remove('open');
    if (b) b.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', function () {
    var bell = document.getElementById('rs-bell');
    if (!bell) return;
    bell.addEventListener('click', function () {
        var d = document.getElementById('rs-drawer');
        if (d && d.classList.contains('open')) rsCloseDrawer(); else rsOpenDrawer();
    });
    if (window.SERVER_AUTHED === true) {
        rsPollAlerts();
        setInterval(rsPollAlerts, 30000);
    }
});

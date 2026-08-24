        // ==================== AUTH ====================
        const _origFetch = window.fetch;
        window.fetch = function(url, opts = {}) {
            const adminKey = sessionStorage.getItem('adminKey');
            if (adminKey && typeof url === 'string' && url.startsWith('/api/')) {
                opts.headers = opts.headers || {};
                if (opts.headers instanceof Headers) {
                    opts.headers.set('X-Admin-Key', adminKey);
                } else {
                    opts.headers['X-Admin-Key'] = adminKey;
                }
            }
            return _origFetch.call(this, url, opts).then(resp => {
                if (resp.status === 401 && typeof url === 'string' && url.includes('/api/v1/admin/')) {
                    sessionStorage.removeItem('adminKey');
                    document.getElementById('login-overlay').style.display = 'flex';
                }
                return resp;
            });
        };

        function checkAuth() {
            // The HttpOnly session cookie is authoritative: pages render data
            // only when it is valid, and the API accepts it directly.
            // window.SERVER_AUTHED is set by the page template.
            if (window.SERVER_AUTHED === true) return;
            const key = sessionStorage.getItem('adminKey');
            if (!key) {
                document.getElementById('login-overlay').style.display = 'flex';
            }
        }

        async function doLogin() {
            const input = document.getElementById('login-key-input');
            const key = input.value.trim();
            if (!key) return;
            try {
                const r = await _origFetch('/api/v1/auth/verify', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({key: key})
                });
                if (r.ok) {
                    sessionStorage.setItem('adminKey', key);
                    // Login set the session cookie; reload so the server
                    // renders the page WITH data this time.
                    location.reload();
                } else {
                    document.getElementById('login-error').style.display = 'block';
                    input.value = '';
                    input.focus();
                }
            } catch(e) {
                document.getElementById('login-error').textContent = 'Connection error';
                document.getElementById('login-error').style.display = 'block';
            }
        }

        document.addEventListener('DOMContentLoaded', checkAuth);

        const MIN_DETECTIONS = 3;  // Only show confirmed tags
        // Whitelist filter function — if whitelist is populated, also filter by frequency
        function isTagAllowed(tag) {
            if ((tag.detection_count || 0) < MIN_DETECTIONS) return false;
            if (knownFreqKhzSet.size === 0) return true;  // No whitelist = allow all
            // Check if tag frequency is within ±5 kHz of any known frequency
            const tagKhz = tag.frequency_khz || Math.round((tag.freq || 0));
            for (const known of knownFreqKhzSet) {
                if (Math.abs(tagKhz - known) <= 5) return true;
            }
            return false;
        }

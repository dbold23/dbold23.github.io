/**
 * Stream G — drag-and-drop field-trip ingest.
 *
 * The whole design turns on one constraint: **the video bytes never leave the machine.**
 * nginx caps request bodies at 50MB, Flask at 50MB and Cloudflare at roughly 100MB,
 * while a GoPro card clip is 1-4GB. So this reads each file's name, size and container
 * header locally and posts a small JSON manifest; the media reaches Drive by the lab's
 * existing route and the catalog stores only a drive_id.
 *
 * Everything the browser derives is a PROPOSAL. A wrong size or date published to GBIF
 * is unrecoverable, so nothing here writes to the catalog without a human accepting it —
 * the same proposed/verified rule the track queue follows.
 *
 * Gated on GET /api/ingest/health; if that 404s (the default), this module renders
 * nothing and the page is unchanged.
 */
(function () {
  "use strict";

  const API = {
    async _handle(r) {
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error || `Request failed (${r.status})`);
      }
      return r.json();
    },
    async get(u) { return this._handle(await fetch(u)); },
    async send(u, method, body) {
      return this._handle(await fetch(u, {
        method,
        headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
        body: JSON.stringify(body || {}),
      }));
    },
    post(u, b) { return this.send(u, "POST", b); },
    patch(u, b) { return this.send(u, "PATCH", b); },
  };

  // utils.js's escapeHtml, resolved lazily: this module must stay require-able
  // with no DOM and no sibling scripts (see tests/test_ingest_mp4.py).
  const esc = (s) => escapeHtml(s);

  const VIDEO_EXT = /\.(mp4|mov|avi|mkv|m4v|webm)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|tiff?|heic|webp)$/i;

  // ─────────────────── MP4 container header, read in place ───────────────────
  //
  // An MP4 is a flat list of boxes: [4-byte big-endian size][4-byte type][payload].
  // That means we can WALK the top level reading 16 bytes per box and skipping `mdat`
  // (the gigabytes of video) entirely by its declared size — so finding `moov` costs a
  // few hundred bytes of reads no matter how large the file is. GoPro writes `moov`
  // last, which is exactly why a naive "read the first N MB" approach misses it.

  async function readBytes(file, start, length) {
    const end = Math.min(start + length, file.size);
    if (start >= file.size || end <= start) return null;
    return new DataView(await file.slice(start, end).arrayBuffer());
  }

  async function findBox(file, start, end, wanted) {
    let off = start;
    while (off + 8 <= end) {
      const head = await readBytes(file, off, 16);
      if (!head || head.byteLength < 8) return null;
      let size = head.getUint32(0);
      let type = "";
      for (let i = 4; i < 8; i++) type += String.fromCharCode(head.getUint8(i));
      let headerLen = 8;
      if (size === 1) {
        if (head.byteLength < 16) return null;
        // 64-bit size. Sizes beyond 2^53 cannot be represented exactly, but a box that
        // large is not a thing we will meet.
        size = head.getUint32(8) * 4294967296 + head.getUint32(12);
        headerLen = 16;
      } else if (size === 0) {
        size = end - off;            // "extends to end of file"
      }
      if (size < headerLen) return null;   // malformed; refuse rather than loop forever
      if (type === wanted) return { offset: off, size, headerLen };
      off += size;
    }
    return null;
  }

  /**
   * Container-declared start time, or null.
   *
   * `mvhd.creation_time` counts seconds from 1904-01-01. The spec says UTC; consumer
   * cameras — GoPro among them — commonly write LOCAL time instead, with nothing in the
   * file to say which. So this returns the value and flags the ambiguity rather than
   * asserting an instant: taking it for UTC would shift the calendar day for every
   * afternoon and evening clip, which silently mis-dates the encounter.
   */
  async function readCaptureMeta(file) {
    try {
      const moov = await findBox(file, 0, file.size, "moov");
      if (!moov) return null;
      const mvhd = await findBox(file, moov.offset + moov.headerLen,
                                 moov.offset + moov.size, "mvhd");
      if (!mvhd) return null;
      const body = await readBytes(file, mvhd.offset + mvhd.headerLen, 24);
      if (!body || body.byteLength < 12) return null;

      const version = body.getUint8(0);
      let seconds1904;
      if (version === 1) {
        if (body.byteLength < 20) return null;
        seconds1904 = body.getUint32(4) * 4294967296 + body.getUint32(8);
      } else {
        seconds1904 = body.getUint32(4);
      }
      if (!seconds1904) return null;
      // 1904-01-01 to 1970-01-01.
      const epoch = seconds1904 - 2082844800;
      if (epoch <= 0 || epoch > 4102444800) return null;   // sane range, else discard
      return {
        container: "mp4",
        mvhd_version: version,
        mvhd_creation_time: seconds1904,
        // Rendered without a zone suffix on purpose — we do not know the zone.
        wall_clock: new Date(epoch * 1000).toISOString().replace("Z", ""),
        timezone: "unverified",
      };
    } catch (e) {
      return null;                 // never let a malformed file block the whole drop
    }
  }

  // ─────────────────── collecting a dropped folder ───────────────────

  async function walkEntry(entry, out) {
    if (!entry) return;
    if (entry.isFile) {
      out.push(await new Promise((res) => entry.file(res, () => res(null))));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns at most ~100 per call, so it must be drained in a loop —
      // a single call silently truncates a real trip folder.
      for (;;) {
        const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
        if (!batch.length) break;
        for (const e of batch) await walkEntry(e, out);
      }
    }
  }

  async function filesFromDrop(dt) {
    const out = [];
    const items = dt.items ? Array.from(dt.items) : [];
    const entries = items
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (entries.length) {
      for (const e of entries) await walkEntry(e, out);
    } else {
      out.push(...Array.from(dt.files || []));
    }
    return out.filter(Boolean).filter((f) => VIDEO_EXT.test(f.name) || IMAGE_EXT.test(f.name));
  }

  // ─────────────────── the panel ───────────────────

  const Ingest = {
    health: null,
    batchId: null,

    async init(mountId) {
      const mount = document.getElementById(mountId || "ingest-panel");
      if (!mount) return;
      try {
        this.health = await API.get("/api/ingest/health");
      } catch (e) {
        return;                    // feature off — render nothing at all
      }
      this.mount = mount;
      mount.innerHTML = `
        <section class="ingest">
          <h2>Ingest a trip</h2>
          <p class="ingest-hint">
            Drop a folder of clips. Nothing uploads &mdash; the browser reads each file's
            name and header locally and sends only the details for review.
          </p>
          <div id="ingest-drop" class="ingest-drop" tabindex="0" role="button"
               aria-label="Drop a folder of clips here">
            <strong>Drop a trip folder here</strong>
            <span>or <button type="button" id="ingest-browse" class="linklike">choose files</button></span>
            <input type="file" id="ingest-file-input" multiple webkitdirectory hidden>
          </div>
          <div id="ingest-progress" class="ingest-progress" hidden></div>
          <div id="ingest-results"></div>

          <details id="ingest-trips-wrap">
            <summary><h3>Trips</h3></summary>
            <p class="ingest-hint">
              One field day at one site. The day is already inside every encounter code,
              so this needs nothing extra recorded.
            </p>
            <div id="ingest-trips">Loading trips&hellip;</div>
          </details>

          <details id="ingest-anomalies-wrap">
            <summary><h3>Codes needing a look</h3></summary>
            <div id="ingest-anomalies">Loading&hellip;</div>
          </details>
        </section>`;

      const zone = mount.querySelector("#ingest-drop");
      const input = mount.querySelector("#ingest-file-input");
      ["dragenter", "dragover"].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation(); zone.classList.add("is-over");
        }));
      ["dragleave", "drop"].forEach((ev) =>
        zone.addEventListener(ev, (e) => {
          e.preventDefault(); e.stopPropagation(); zone.classList.remove("is-over");
        }));
      zone.addEventListener("drop", async (e) => {
        this.handle(await filesFromDrop(e.dataTransfer));
      });
      mount.querySelector("#ingest-browse").addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        this.handle(Array.from(input.files || [])
          .filter((f) => VIDEO_EXT.test(f.name) || IMAGE_EXT.test(f.name)));
      });

      this.renderTrips();
      this.renderAnomalies();
    },

    async renderTrips() {
      const box = this.mount.querySelector("#ingest-trips");
      try {
        const { trips } = await API.get("/api/ingest/trips");
        if (!trips.length) { box.textContent = "No trips yet."; return; }
        // The catalog has 138 field days and every other optional admin panel on this
        // page is 100-500px tall. Rendering all of them made this one 3240px, so the
        // most recent are shown and the rest are reachable by paging.
        const PAGE = 25;
        const shown = trips.slice(0, this._tripsShown || PAGE);
        box.innerHTML = `
          <p class="ingest-hint">Showing ${shown.length} of ${trips.length} field days,
            most recent first.</p>
          <table class="ingest-table ingest-trips">
            <thead><tr><th>Trip</th><th>Site</th><th>Date</th>
              <th>Encounters</th><th>Clips</th><th></th></tr></thead>
            <tbody>${shown.map((t) => `
              <tr data-trip="${esc(t.trip_key)}">
                <td><code>${esc(t.trip_key)}</code></td>
                <td>${esc(t.site || "—")}</td>
                <td>${esc(t.date || "—")}</td>
                <td>${t.n_encounters}</td>
                <td>${t.n_clips}</td>
                <td><button type="button" data-act="open" data-trip="${esc(t.trip_key)}">
                  open</button></td>
              </tr>
              <tr class="ingest-trip-detail" data-detail="${esc(t.trip_key)}" hidden>
                <td colspan="6"></td>
              </tr>`).join("")}</tbody>
          </table>
          ${shown.length < trips.length
            ? `<button type="button" data-act="more">Show ${
                Math.min(PAGE, trips.length - shown.length)} more</button>` : ""}`;
        box.onclick = (e) => {
          const btn = e.target.closest("button[data-act]");
          if (!btn) return;
          if (btn.dataset.act === "more") {
            this._tripsShown = shown.length + PAGE;
            this.renderTrips();
          } else if (btn.dataset.act === "open") {
            this.openTrip(btn.dataset.trip);
          }
        };
      } catch (e) {
        box.textContent = `Could not load trips: ${e.message}`;
      }
    },

    async openTrip(tripKey) {
      const row = this.mount.querySelector(`tr[data-detail="${CSS.escape(tripKey)}"]`);
      if (!row) return;
      if (!row.hidden) { row.hidden = true; return; }
      const cell = row.firstElementChild;
      cell.textContent = "Loading…";
      row.hidden = false;
      try {
        const d = await API.get(`/api/ingest/trips/${encodeURIComponent(tripKey)}`);
        const codes = Object.keys(d.encounters || {}).sort();
        // Coverage, deliberately NOT phrased as missing work: across the 150 most recent
        // trips, half have a gap. The lab numbers every shark it sights that day and only
        // some are ever filmed, so a gap is normal and calling it a defect would train
        // people to ignore this panel.
        const coverage = d.sequence_highest
          ? `holds ${d.sequence_present.length} of ${d.sequence_highest} sharks numbered that day`
          : "no sequence numbers recorded";
        // Enumerate the gaps only when the list is short enough to act on. A trip
        // holding 1 of 22 renders 21 numbers, which is a wall of digits that says
        // nothing the ratio has not already said.
        const gaps = d.missing_sequence_numbers || [];
        const gapText = gaps.length && gaps.length <= 8
          ? ` <span class="muted">(not held: ${gaps.join(", ")})</span>` : "";
        cell.innerHTML = `
          <div class="ingest-trip-body">
            <p><strong>${esc(tripKey)}</strong> — ${esc(coverage)}${gapText}</p>
            <ul>${codes.map((c) => `
              <li><code>${esc(c)}</code> — ${d.encounters[c].length} clip(s):
                ${d.encounters[c].map((v) => esc(v.video_name)).join(", ")}</li>`).join("")}
            </ul>
            ${d.staged && d.staged.length
              ? `<p class="muted">${d.staged.length} file(s) staged, not yet committed.</p>`
              : ""}
          </div>`;
      } catch (e) {
        cell.textContent = `Could not load ${tripKey}: ${e.message}`;
      }
    },

    async renderAnomalies() {
      const box = this.mount.querySelector("#ingest-anomalies");
      try {
        const a = await API.get("/api/ingest/anomalies");
        if (!a.total) { box.textContent = "Every encounter code parses cleanly."; return; }
        box.innerHTML = `
          <p class="ingest-hint">${a.total} of ${a.checked} codes need a human.</p>
          ${a.groups.map((g) => `
            <details class="ingest-anom">
              <summary><b>${g.count}</b> &middot; ${esc(g.reason)}</summary>
              <ul>${g.codes.map((c) => `
                <li><code>${esc(c.code)}</code>${
                  c.note ? ` <em>&mdash; ${esc(c.note)}</em>` : ""}${
                  c.site_raw && g.status === "unknown_site"
                    ? ` <span class="muted">(prefix ${esc(c.site_raw)})</span>` : ""}</li>`
                ).join("")}</ul>
            </details>`).join("")}`;
      } catch (e) {
        box.textContent = `Could not load code check: ${e.message}`;
      }
    },

    _say(msg) {
      const el = this.mount.querySelector("#ingest-progress");
      el.hidden = false;
      el.textContent = msg;
    },

    async handle(files) {
      if (!files || !files.length) {
        this._say("No video or image files found in that drop.");
        return;
      }
      const max = this.health.max_manifest_entries || 5000;
      if (files.length > max) {
        this._say(`That folder has ${files.length} files; the limit is ${max}. `
                  + `Split it and drop again — nothing was staged.`);
        return;
      }
      try {
        this._say(`Reading ${files.length} file headers locally…`);
        const entries = [];
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const isVideo = VIDEO_EXT.test(f.name);
          const meta = isVideo ? await readCaptureMeta(f) : null;
          entries.push({
            file_name: f.name,
            file_size: f.size,
            file_mtime_utc: f.lastModified ? new Date(f.lastModified).toISOString() : null,
            media_type: isVideo ? "video" : "image",
            capture_started_utc: meta ? meta.wall_clock : null,
            capture_meta: meta,
          });
          if (i % 10 === 0) this._say(`Reading file headers locally… ${i + 1}/${files.length}`);
        }

        this._say("Staging for review…");
        const batch = await API.post("/api/ingest/batches", {
          label: new Date().toISOString().slice(0, 10),
          source_hint: files[0].webkitRelativePath
            ? files[0].webkitRelativePath.split("/")[0] : null,
        });
        this.batchId = batch.batch_id;
        const res = await API.post(`/api/ingest/batches/${this.batchId}/manifest`, { entries });
        const c = res.counts || {};
        this._say(`Staged ${entries.length} file(s): ${c.ready || 0} ready, `
                  + `${c.parked || 0} need a code, ${c.duplicate || 0} already in the catalog.`);
        await this.renderBatch();
      } catch (e) {
        this._say(`Could not stage that drop: ${e.message}`);
      }
    },

    async renderBatch() {
      const { items } = await API.get(`/api/ingest/batches/${this.batchId}/items`);
      const box = this.mount.querySelector("#ingest-results");
      if (!items.length) { box.innerHTML = ""; return; }

      const row = (it) => {
        const props = (it.proposals || [])
          .filter((p) => p.status === "proposed")
          .map((p) => `
            <span class="ingest-prop" data-prop="${p.id}">
              <b>${esc(p.field)}</b> ${esc(p.value)}
              <small>${esc(p.source)}</small>
              <button type="button" data-act="accept" data-prop="${p.id}">keep</button>
              <button type="button" data-act="reject" data-prop="${p.id}">drop</button>
            </span>`).join("");
        const needsCode = !it.encounter_code;
        return `
          <tr data-item="${it.id}" class="ingest-row is-${esc(it.status)}">
            <td>${esc(it.file_name)}</td>
            <td>${needsCode
              ? `<input class="ingest-code" data-item="${it.id}" placeholder="AN12092201"
                        aria-label="Encounter code for ${esc(it.file_name)}">
                 <button type="button" data-act="setcode" data-item="${it.id}">set</button>`
              : esc(it.encounter_code)}</td>
            <td>${esc(it.obs_date || "—")}</td>
            <td>${esc(it.status)}</td>
            <td class="ingest-props">${props || "<em>none</em>"}</td>
            <td>${it.status === "committed" ? "✓"
              : `<button type="button" data-act="commit" data-item="${it.id}"
                    ${needsCode ? "disabled title='Needs an encounter code first'" : ""}>
                   commit</button>`}</td>
          </tr>`;
      };

      box.innerHTML = `
        <table class="ingest-table">
          <thead><tr><th>File</th><th>Encounter</th><th>Date</th><th>Status</th>
            <th>Proposed (confirm each)</th><th></th></tr></thead>
          <tbody>${items.map(row).join("")}</tbody>
        </table>`;

      box.onclick = async (e) => {
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const act = btn.dataset.act;
        try {
          if (act === "setcode") {
            const input = box.querySelector(`input.ingest-code[data-item="${btn.dataset.item}"]`);
            const code = (input && input.value || "").trim();
            if (!code) return;
            await API.patch(`/api/ingest/items/${btn.dataset.item}/code`,
                            { encounter_code: code });
          } else if (act === "commit") {
            await API.post(`/api/ingest/items/${btn.dataset.item}/commit`);
          } else if (act === "accept" || act === "reject") {
            await API.post(`/api/ingest/proposals/${btn.dataset.prop}/decide`,
                           { accept: act === "accept" });
          }
          await this.renderBatch();
        } catch (err) {
          this._say(err.message);
        }
      };
    },
  };

  if (typeof window !== "undefined") window.Ingest = Ingest;
  if (typeof document !== "undefined") {
    if (document.readyState !== "loading") Ingest.init();
    else document.addEventListener("DOMContentLoaded", () => Ingest.init());
  }
  // Exported so the container parsing can be exercised against REAL footage under node
  // (tests/test_ingest_mp4.py). The box walk is the one piece here that fails silently:
  // a wrong offset yields a plausible timestamp rather than an error.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { readCaptureMeta, findBox, Ingest };
  }
})();

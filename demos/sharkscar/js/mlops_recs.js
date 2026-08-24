/*
 * Stream B (MLOps) — scar-TYPE recommendation client helper for the verify flow.
 *
 * Self-contained, no DOM coupling: Stream D owns the verify modal (tracks.js) and
 * wires this in when it surfaces the hint, e.g.
 *
 *     const s = await MlopsRecs.fetchTypeSuggestion(trackId);
 *     if (s.suggestion) showHint(s.suggestion, s.confidence, s.alternatives);
 *
 * Safe + inert when mlops.recommendations.enabled=false (server returns
 * {enabled:false, suggestion:null}); also swallows network/parse errors so the
 * verify flow is never blocked by a missing model. The human is always ground
 * truth — this is a hint, never an auto-fill.
 *
 * Integration (Stream D, when wiring): add
 *   <script src="/static/js/mlops_recs.js?v=1"></script>
 * to the annotator bundle and call MlopsRecs.fetchTypeSuggestion in the modal.
 */
const MlopsRecs = {
  async fetchTypeSuggestion(trackId) {
    if (trackId === undefined || trackId === null) {
      return { enabled: false, suggestion: null };
    }
    try {
      const r = await fetch(`/api/mlops/tracks/${encodeURIComponent(trackId)}/type-suggestion`, {
        method: 'GET',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
      });
      if (!r.ok) return { enabled: false, suggestion: null };
      return await r.json();
    } catch (e) {
      return { enabled: false, suggestion: null };
    }
  },
};

if (typeof window !== 'undefined') window.MlopsRecs = MlopsRecs;

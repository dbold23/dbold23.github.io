# Plan: Rename Ocean Path to "Research & Presentations"

## Context
The Ocean path currently showcases 4 marine science research cards in a fan-deck layout. The user wants to rebrand it as "Research & Presentations" and embed their conference talks, posters, and presentation content directly into the relevant research card detail overlays. Two additional presentation topics (Eelgrass, Scientific Diving) need cards; the Relay Station presentation already lives in the Tech path.

## Files to Modify
1. **`index.html`** — rename labels, embed presentation content, add new cards
2. **`css/path-ocean.css`** — styles for presentation lists, fan deck adjustment for 6 cards
3. **`js/transition-ocean.js`** — verify card count handling (likely already dynamic)

## Step-by-Step

### Step 1: Rename labels in `index.html`

| Line | Old | New |
|------|-----|-----|
| 7 | `"...marine science, forest conservation..."` | `"...marine research, forest conservation..."` |
| 70 | `aria-label="Dive into Marine Science"` | `aria-label="Explore Research & Presentations"` |
| 86 | `Marine Science` (corner label) | `Research & Presentations` |
| 261 | `aria-label="Marine Science Research"` | `aria-label="Research & Presentations"` |
| 267 | `Marine Science & Ocean Research` | `Research & Presentations` |

**Keep unchanged:** "Marine Scientist" in hero subtitle (line 53), "B.S. Marine Science" in resume (lines 1160, 1165, 1312), South Africa/Field Ops card titles, "Ocean Predator Ecology Lab" references.

### Step 2: Embed presentations in Shark Ecology card detail (after line ~301)
Add a `.card-presentations` div before the `.panel-gallery`:
- **WSN Poster** — "Assessing White Shark Body Condition: An AI Framework for Optimizing 2D Morphometric Analysis with Reinforcement Learning"
- **CSUMB Spring Showcase Poster** — "From Fins to Frames: An AI-Powered Tool for Morphometric Shark Analysis"
- **UROC Summer Showcase** — "Classifying White Shark Behaviors from Sensor Packages"
- **NEPSS Oral Presentation** — (video coming April 2026, slides ready)

Each entry: `<strong>Event</strong> — Title`. User will provide actual poster/slide files (mixed formats: PDFs, images, Google Slides) to embed as gallery items or downloadable links.

### Step 3: Embed presentations in Aquaculture card detail (after line ~336)
Add `.card-presentations` div:
- **Aquaculture America** — "Optimizing Urchin Aquaculture: The Impact of Carotenoid Application Method and Pellet Processing on Roe Yield, Color, and Texture"
- **Aquaculture America** — "Examining Finishing Feed Applications for Purple Urchin Roe Enhancement"

### Step 4: Embed Scientific Diving in Field Ops card detail (after line ~393)
Add presentation entry for the Scientific Diving presentation in the Field Ops card.

### Step 5: Add new Card 4 — Eelgrass Research
New card after Card 3 (line ~399) with `data-card="4"`:
- Title: "Eelgrass (Zostera marina)"
- Subtitle: "A Cornerstone for California Aquaculture and Blue Carbon Initiatives"
- Detail content: Ecological Benefits, Aquaculture Practices, Economic Potential
- Type tag: "Presentation"
- User to provide image asset

### Step 6: CSS updates in `path-ocean.css`
- Add `.card-presentations` styles: heading, list formatting, subtle visual separator
- Adjust `.deck-card` fan layout to accommodate 5 cards (currently tuned for 4)
- May need to slightly reduce card spread angle or adjust `--card-index` calculations

### Step 7: Verify `transition-ocean.js`
- Check if card count is hardcoded or dynamic (`.deck-card` querySelectorAll)
- Update if needed to handle 5 cards in hover/click logic

**Note:** Relay Station card was removed from scope — already well-covered in Tech path.

## Embed Strategy for Presentation Files
The user has a mix of formats (PDFs, images, Google Slides, video). Approach:
- **Images/posters (PNG/JPG/AVIF):** Add to `.panel-gallery` in the card detail
- **PDFs:** Embed with `<object>` tag or link with download button
- **Google Slides:** Embed iframe with published URL
- **Video (NEPSS):** `<video>` tag or YouTube/Vimeo embed when available

## Verification
1. Open site locally → navigate to Ocean path via corner hotspot and nav pill
2. Verify "Research & Presentations" label appears on corner, section title, aria-labels
3. Click each card → confirm detail overlay shows embedded presentations
4. Verify new Eelgrass card appears in fan deck
5. Test fan deck hover/click with 5 cards — ensure spacing and interaction work
6. Check mobile responsive behavior
7. Verify corner label text doesn't overflow
8. Screen reader check on aria-labels
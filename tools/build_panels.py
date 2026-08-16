#!/usr/bin/env python3
"""Generate the Research panel templates in index.html.

Each panel is laid out like a short paper: a title block with a byline, an
abstract, numbered figures carrying the visual weight, and numbered sections
whose prose stays folded until asked for.

Three kinds, because a lab study, a field season and a teaching programme are
not the same document:

  paper    title block, Abstract, numbered Figures, numbered sections, References
  field    a field record: dates/site/hours masthead, numbered Plates, log sections
  program  a programme outline: sites and duration masthead, Figures, curriculum

Regenerating overwrites the templates in index.html between the first
<template data-panel> and the last </template>. Edit this file, not the HTML.

Usage: python3 tools/build_panels.py
"""

import html
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from facts import SHARK, REID, RELAY, JUE, HABHUB, FATHOMNET  # noqa: E402

V2 = Path(__file__).resolve().parent.parent
IND = ' ' * 8


def img(src, alt):
    return (f'<img src="{html.escape(src)}" alt="{html.escape(alt)}" decoding="async">')


def video(stem, label):
    return (f'<video class="lazy-video" muted loop playsinline preload="none" '
            f'width="512" height="288" aria-label="{html.escape(label)}">'
            f'<source src="assets/{stem}.webm" type="video/webm">'
            f'<source src="assets/{stem}.mp4" type="video/mp4"></video>')


PANELS = [
    {
        'key': 'shark',
        'kind': 'paper',
        'org': 'Ocean Predator Ecology Lab, CSUMB',
        'title': 'White Shark Ecology &amp; Telemetry',
        'byline': 'Mentor: Dr. Salvador Jorgensen',
        'dateline': 'Spring 2023 – Present &middot; Monterey Bay, California',
        'abstract': f'An archive running {SHARK["corpus_years"]}, a population of individually recognizable white sharks, and one question underneath all of it: how much of an animal’s health can you read off its body? This work turns that footage into measurements, and runs the fieldwork that keeps producing more of it.',
        'sections': [
            {
                'title': 'Background',
                'body': ['Can body condition be measured reliably enough from video to track a population over time?',
                         'Do bite and boat-strike injuries heal at rates that say something about individual condition?',
                         'What are sharks doing when no one is watching, and can sensors tell us?'],
                'figure': (video('shark-yolo-keypoints', 'Automated keypoint tracking on a swimming white shark'),
                           f'Automated keypoint tracking turns {SHARK["videos"]} archival videos into measurable landmarks.'),
            },
            {
                'title': 'Field methods',
                'body': ['Tagging operations from small vessels: approach, tag placement, recovery',
                         'Dorsal fin mounted camera and sensor package deployment and retrieval',
                         'Photo identification capture feeding a multi-year individual catalogue'],
                'figure': (video('shark-tagging', 'Shark tagging operation from a small vessel'),
                           'Tagging from a small vessel. Most of the method is getting the boat and the animal in the same place calmly.'),
            },
            {
                'title': 'Results to date',
                'body': [f'A {SHARK["pose_keypoints"]}-keypoint pose model reaching {SHARK["box_map50"]} {SHARK["box_map50_label"]}, measuring animals from video rather than counting them',
                         f'{SHARK["videos"]} videos, {SHARK["corpus_size"]}, spanning {SHARK["corpus_years"]} across {SHARK["sites"]}',
                         'Multi-year photo-ID series tracking injury healing rates in known individuals',
                         'Dorsal-camera footage and sensor records paired for behavior work, reconstructed in <em>anchor</em>',
                         'Tag geometry iterated against hydrodynamic drag so instrumentation changes behavior as little as possible'],
                'figure': (img('assets/me with a shark tag and antena.avif', 'Holding a shark tag and a VHF receiving antenna in the field'),
                           'VHF tracking between tagging trips, following known animals across seasons.'),
            },
        ],
        'tags': ['White Sharks', 'Biologging', 'Photo-ID', 'Morphometrics', 'Acoustic Telemetry'],
        'crosslink': ('Implementations', [
            ('folder-shark-morpho', 'Technology / shark-morphometrics'),
            ('folder-shark-annotator', 'Technology / shark-annotator'),
            ('folder-shark-rag', 'Technology / shark-rag'),
        ]),
        'refs_title': 'Presentations',
        'presentations': [
            ('NEPSS: White Shark Morphometric Analysis', 'March 2026',
             'https://docs.google.com/presentation/d/1RixGeBlvak6r11nb0_x9OVpqSQp9bETEBU7nq7u_YXo/embed?start=false&loop=false&delayms=3000',
             'NEPSS presentation: White Shark Morphometric Analysis'),
            ('WSN Poster: Assessing White Shark Body Condition', 'November 2025',
             'https://drive.google.com/file/d/1SJLMesyUPDkBSq0p2w1uBO23hmrfeWPv/preview',
             'WSN poster: Assessing White Shark Body Condition'),
            ('UROC Summer Showcase: Classifying White Shark Behaviors from Sensor Packages', 'Summer 2025',
             'https://docs.google.com/presentation/d/1W2EyKdI_vG46YGaLpdTB3HNlWjwZ71BhstlxmWGtZBM/embed?start=false&loop=false&delayms=3000',
             'UROC Summer Showcase: Classifying White Shark Behaviors from Sensor Packages'),
            ('CSUMB Spring Showcase: From Fins to Frames', 'Spring 2025',
             'https://drive.google.com/file/d/1tV3LgY9yx_AOt7AhUtrNvRmsAmwc17qx/preview',
             'CSUMB Spring Showcase: From Fins to Frames'),
        ],
    },

    {
        'key': 'fathomnet',
        'kind': 'paper',
        'org': 'Monterey Bay Aquarium Research Institute',
        'title': 'FathomNet',
        'byline': 'Summer Intern, Bioinspiration Lab',
        'dateline': 'June – August 2026 &middot; Moss Landing, California',
        'abstract': 'FathomNet is the open image database the deep-sea machine learning community trains on. When I arrived it could only store bounding boxes, so a decade of ROV imagery could say where an animal was but never what shape it was. Over one summer I extended it end to end to hold points and segmentation masks, then filled the existing corpus, scaling from a SAM 2 pilot to a full-corpus SAM 3 run. Every mask is graded rather than accepted, with rejects held back under an explicit deferred count so the accept rate cannot be quietly inflated.',
        'sections': [
            {
                'title': 'What came out of it',
                'body': [f'Annotation geometry went from boxes only to points and COCO compressed-RLE masks, across the data model, the REST API and the Python client',
                         f'The RLE codec was ported to Java under {FATHOMNET["rle_tests"]} round-trip tests, so masks from SAM or any COCO tool survive the trip byte for byte with no new server dependency',
                         f'Existing boxes were converted to graded masks database-wide, scaling from a {FATHOMNET["pilot"]} pilot to a full-corpus {FATHOMNET["full_run"]} run',
                         f'Every mask is scored and tiered into {FATHOMNET["grading_tiers"]}, with rejects held under an explicit deferred count so the accept rate cannot be quietly inflated',
                         f'Exports carry the new geometry across {FATHOMNET["export_formats"]} with per-record license propagation'],
                'figure': (img('assets/panels/fathomnet-masks.avif',
                               'A deep-sea frame with segmentation masks over a crinoid and neighbouring animals'),
                           'The output: an animal described by its outline rather than by a rectangle.'),
            },
        ],
        'closing_figure': (img('assets/panels/mbari-presentation.avif',
                               'Presenting the summer internship work from the podium at MBARI, with the FathomNet database on screen'),
                           'Presenting the summer’s work at MBARI, August 2026.'),
        'tags': ['FathomNet', 'Segmentation', 'Open Data', 'Deep Sea Imagery'],
        'crosslink': ('The schema and the orchestrator', [('folder-mbari', 'Technology / MBARI')]),
        'refs_title': 'Talk &amp; paper',
        'pending': [
            ('<!-- TODO: drop the recording at assets/mbari-final-presentation.{webm,mp4} and\n'
             '                             replace this line with:\n'
             '                        <video class="lazy-video" controls preload="none" width="1280" height="720"\n'
             '                               aria-label="Recording of the final internship presentation at MBARI">\n'
             '                            <source src="assets/mbari-final-presentation.webm" type="video/webm">\n'
             '                            <source src="assets/mbari-final-presentation.mp4" type="video/mp4">\n'
             '                        </video> -->'),
            'Recording of the final presentation being added',
            ('<!-- TODO: swap for <a class="rp-link" href="URL" target="_blank" rel="noopener">Read the paper</a> -->'),
            'Paper publishing to MBARI’s intern papers site, September 2026',
        ],
    },

    {
        'key': 'anchor',
        'kind': 'paper',
        'org': 'Jorgensen Lab, CSUMB',
        'title': 'anchor: Biologging Trajectory Reconstruction',
        'byline': 'Lead Developer &middot; co-developed with D. Moran',
        'dateline': 'May – August 2026 &middot; CSUMB',
        'abstract': 'A biologging tag reconstructs an animal’s track by dead reckoning from accelerometer and magnetometer data. Over hours that track drifts badly, and a behavior classifier trained on it can quietly learn to recognize the individual animal instead of the behavior. anchor is the correction for both problems.',
        'sections': [
            {
                'title': 'Validation against optical ground truth',
                'body': ['Validation framework comparing tag-derived kinematics to independent optical ground truth',
                         'DeepLabCut and SLEAP keypoint exports converted into tailbeat frequency, amplitude, and body lengths per second',
                         'Drone and aquarium video speed calibration, with paired multi-tag runs scored by Cohen’s kappa'],
                'figure': (video('shark-yolo-keypoints', 'Keypoint tracking on a swimming shark, used as optical ground truth'),
                           'Optical ground truth: video keypoints give a tailbeat the tag can be checked against.'),
            },
            {
                'title': 'Evaluation without leakage',
                'body': ['Rebuilt classifier evaluation around subject-level leave-one-out cross validation',
                         'Per-class precision, recall, F1, balanced accuracy, and macro-F1',
                         'Replaced an evaluation path that leaked individual-animal signal between train and test'],
                'figure': (img('assets/panels/anchor-track-diagnostics.avif',
                               'Diagnostic panels from a reconstructed track: drift over time, tilt-compensated heading, and speed coloured by behavior state'),
                           'Per-deployment diagnostics: drift against elapsed time, and speed coloured by classified behavior state.'),
            },
            {
                'title': 'Arresting the drift',
                'body': ['GPS and acoustic fixes threaded through a particle filter and FFBS smoother',
                         'Reported against held-out drift RMSE rather than in-sample fit',
                         'CF-1.8 NetCDF, Movebank, and GeoJSON interchange so tracks leave the project in standard formats'],
                'figure': (img('assets/panels/anchor-track-map.avif',
                               'A reconstructed animal track drawn over bathymetry in Elkhorn Slough'),
                           'A reconstructed track over slough bathymetry, after GPS and acoustic fixes are threaded through the smoother.'),
            },
        ],
        'tags': ['Biologging', 'Dead Reckoning', 'Particle Filtering', 'Behavior Classification'],
        'crosslink': ('Interchange formats and the smoother', [('folder-anchor', 'Technology / anchor')]),
    },

    {
        'key': 'porpoise',
        'kind': 'paper',
        'org': 'Independent, with Jorgensen Lab and partner catalogues',
        'title': 'Individual Re-Identification Across Species',
        'byline': 'Design and evaluation',
        'dateline': '2025 – Present &middot; Monterey Bay',
        'abstract': f'A harbor porpoise surfaces for about a second. A sevengill shark comes over the side of a boat once and goes back. In both cases a photograph is all you get, and the question is the same one: have we seen this animal before? Answer it well enough and a sighting becomes a resighting, which is what turns photographs into a mark-recapture study without ever putting a tag on anything. The machinery is shared. What changes between species is which part of the animal carries the signature.',
        'sections': [
            {
                'title': 'Harbor porpoise, by fin outline',
                'body': [f'SAM 2 segments the body, protrusion geometry extracts the dorsal fin, and {REID["porpoise_backbone"]} embeds the crop through an ArcFace head with cosine-similarity ranking',
                         f'{REID["porpoise_individuals"]} individuals, {REID["porpoise_sightings"]} sightings, {REID["porpoise_images"]} images',
                         f'{REID["porpoise_backbones_evaluated"]} were benchmarked on this catalogue before one was chosen'],
                'figure': (img('assets/panels/porpoise-match.avif',
                               'A query dorsal fin beside its top five ranked matches from the catalogue'),
                           'A query fin and its ranked matches, drawn from a catalogue of 198 known animals.'),
            },
            {
                'title': 'Sevengill shark, by spot constellation',
                'body': [f'Broadnose sevengill (<em>{REID["sevengill_species"]}</em>) carry {REID["sevengill_signal"]}, so the same re-identification problem needs a different feature entirely',
                         f'Three tracks run in parallel: {REID["sevengill_tracks"]}',
                         f'{REID["sevengill_images"]} images catalogued, {REID["sevengill_labelled_individuals"]} individuals labelled so far',
                         f'The useful finding so far is a negative one: {REID["sevengill_lowdata"]}'],
                'figure': (img('assets/panels/porpoise-cmc.avif',
                               'Cumulative match characteristic curves for the re-identification model'),
                           'CMC curves. The same evaluation applies whatever the animal, which is the point of sharing the machinery.'),
            },
            {
                'title': 'Reporting it honestly',
                'body': [f'Temporal split ({REID["porpoise_temporal_condition"]}), which is the unbiased evaluation: {REID["porpoise_temporal_rank1"]} rank-1 and {REID["porpoise_temporal_rank5"]} rank-5, on {REID["porpoise_temporal_config"]}',
                         f'Leave-one-out on {REID["porpoise_loo_condition"]} gives {REID["porpoise_loo_rank1"]} rank-1, and that number is inflated: the metric head sees the test animals during training. It is useful for the gallery-size experiment and for nothing else.',
                         f'The gap between the two is the actual result. {REID["porpoise_caveat"].capitalize()}, so a model tested on the years it trained on is answering an easier question than a field programme ever asks.'],
                'figure': (img('assets/porpoise-accuracy-vs-gallery.png',
                               'Accuracy plotted against gallery size'),
                           'Accuracy against gallery size, which is what decides whether any of this scales to a larger catalogue.'),
            },
            {
                'title': 'Where it goes next',
                'body': [f'The catalogue platform is built to host {REID["platform_scope"]}, because the expensive part is never the model, it is the labelled catalogue and the field relationships behind it.',
                         'Open-set matching is the harder half: telling a known animal from one the catalogue has never seen, with a confidence a biologist can act on.'],
                'figure': (img('assets/bubbles/porpoise.avif',
                               'Two photographs of the same dorsal fin taken years apart'),
                           'The same animal, two encounters, years apart. Everything else is machinery for noticing that.'),
            },
        ],
        'tags': ['Re-Identification', 'Metric Learning', 'Photo-ID', 'Mark-Recapture', 'Open-Set'],
        'crosslink': ('The pipeline and the catalogue', [('folder-porpoise-id', 'Technology / porpoise-fin-id')]),
    },
    {
        'key': 'aquaculture',
        'kind': 'paper',
        'org': 'Aquaculture Lab, Moss Landing Marine Laboratories',
        'title': 'Sustainable Urchin Aquaculture',
        'byline': 'Lead Technician &middot; Mentor: Dr. Luke Gardner',
        'dateline': 'Spring 2024 – Present &middot; Moss Landing, California',
        'abstract': 'Purple urchins strip a kelp forest and then sit in the barrens they made, starving, with gonads too small to sell. If you can fatten those animals in tanks, removing them stops being a cost centre and starts being a fishery. Two experiments test whether that works, run end to end from hypothesis through manuscript. Related work looks at eelgrass (<em>Zostera marina</em>) as a cornerstone for California aquaculture and blue carbon.',
        'lead': (img('assets/panels/aquaculture-facility.avif',
                      'The aquaculture facility at Moss Landing, between two rows of culture tanks'),
                 'The facility at Moss Landing. Both experiments run down these two rows.'),
        'sections': [
            {
                'title': 'Experiment one: stocking density',
                'body': ['How many urchins can share a tank before gonad development and survival suffer? The answer sets the economics of the whole idea.'],
                'figure': (img('assets/panels/urchin-tank.avif', 'Overhead view of a purple urchin culture tank'),
                           'A density treatment tank. Every animal in it is a data point on survival and gonad index.'),
            },
            {
                'title': 'Experiment two: finishing feed',
                'body': ['Whether a short finishing diet can push roe from starved to market grade, assessed by Texture Profile Analysis alongside carotenoid application and pellet processing.'],
                'figure': (img('assets/panels/urchin-dissection.avif', 'The lab team dissecting urchins to assess gonad development'),
                           'Dissection and gonad scoring, the measurement the whole experiment turns on.'),
            },
            {
                'title': 'Study animals',
                'body': ['<em>Strongylocentrotus purpuratus</em>, collected from barrens where they have grazed the kelp down and stalled at low gonad index.'],
                'figure': (img('assets/bunch of purple urchins.avif', 'A dense cluster of purple sea urchins'),
                           '<em>Strongylocentrotus purpuratus</em> at barrens density, the condition the work starts from.'),
            },
        ],
        'publications': [
            'Sambold, D., &amp; Gardner, L. Effects of Stocking Density on Gonad Development and Survival in Purple Sea Urchin (<em>Strongylocentrotus purpuratus</em>) Aquaculture. <em>In review.</em>',
            'Sambold, D., &amp; Gardner, L. Examining Finishing Feed Applications for Purple Urchin (<em>Strongylocentrotus purpuratus</em>) Roe Enhancement. <em>In review.</em>',
        ],
        'tags': ['Aquaculture', 'Kelp Restoration', 'TPA Analysis', 'Blue Carbon'],
        'refs_title': 'Presentations',
        'presentations': [
            ('Aquaculture America: Carotenoid Application &amp; Pellet Processing', 'February 2026',
             'https://docs.google.com/presentation/d/1Nwos3ypT35YX3H3rUV2GQ7u2_vwrguo2jR4b6yTR0O8/embed?start=false&loop=false&delayms=3000',
             'Aquaculture America: Optimizing Urchin Aquaculture, Carotenoid Application and Pellet Processing'),
            ('Aquaculture America: Finishing Feed for Roe Enhancement', 'February 2026',
             'https://docs.google.com/presentation/d/1t-dCpJUjdFiUsrBt20CfH7SAqe_diBm5zpX82PWTItE/embed?start=false&loop=false&delayms=3000',
             'Aquaculture America: Examining Finishing Feed Applications for Purple Urchin Roe Enhancement'),
            ('Eelgrass: A Cornerstone for California Aquaculture &amp; Blue Carbon', 'Spring 2025',
             'https://drive.google.com/file/d/1OeJPpiUWOLWpTIKoe0ZOAYprLbZe2TdC/preview',
             'Eelgrass, Zostera marina: A Cornerstone for California Aquaculture and Blue Carbon'),
        ],
    },

    {
        'key': 'jue',
        'kind': 'paper',
        'org': 'Jue Lab, CSUMB',
        'title': 'Microbial Bioremediation',
        'byline': 'Research Assistant &middot; Mentor: Dr. Nathaniel Jue',
        'dateline': 'Spring 2025 – Present &middot; CSUMB',
        'abstract': 'Ninety-two bacterial strains, four experimental groups, and one question: will any of them eat a pesticide. The real question underneath is which strains metabolize the compound rather than merely tolerating it, and how confident that call can be given how noisy plate reader data is. Growth curves come off the reader by the thousand, so the analysis had to be automated before the biology could be answered at all.',
        'sections': [
            {
                'title': 'Analysis',
                'body': ['Modified Gompertz growth modeling with Haldane substrate inhibition kinetics',
                         'A classifier that screens curve quality automatically instead of by eye',
                         'Bayesian hierarchical modeling and bootstrap confidence intervals over strain-level estimates'],
                'figure': (img('assets/tecan-classification-summary.png', 'Growth curve classification summary across bacterial strains'),
                           'Curve quality screened per strain, so a bad well never reaches the biology.'),
            },
            {
                'title': 'Validation',
                'body': ['The pipeline was validated against 480 synthetic curves with known ground truth before any real plate was scored, so a wrong answer would show up as a wrong answer.'],
                'figure': (img('assets/tecan-confusion-matrix.png', 'Confusion matrix for the automated curve quality classifier'),
                           'Classifier performance against synthetic curves with known ground truth.'),
            },
        ],
        'tags': ['Bioremediation', 'Growth Kinetics', 'Bayesian Modeling'],
        'crosslink': ('Implementation', [('folder-jue', 'Technology / Jue-Lab')]),
    },

    {
        'key': 'relay',
        'kind': 'program',
        'org': 'Galápagos &amp; California',
        'title': 'Low-Cost VHF Relay Stations',
        'byline': 'Design, field deployment, and training',
        'dateline': '2024 – Present',
        'record': [
            ('Sites', f'{RELAY["sites"]}'),
            ('Max range', f'{RELAY["max_range"]} on a {RELAY["antenna"]} antenna'),
            ('Detection rate', f'{RELAY["detection_rate"]} in field testing'),
            ('Cost per station', f'{RELAY["cost"]}, against a {RELAY["commercial_receiver"]} commercial receiver'),
        ],
        'abstract': f'A commercial {RELAY["band"]} telemetry receiver costs {RELAY["commercial_receiver"]}, which is the real reason so much of the world has no telemetry coverage. I built one for {RELAY["cost"]}, deployed it in the Galápagos and across California sites, measured what it actually detects in the field rather than on a datasheet, and taught local teams to build and repair their own.',
        'sections': [
            {
                'title': 'What the station is',
                'body': [f'Raspberry Pi 5, RTL-SDR Blog V4 and a SIM7028 NB-IoT modem behind a {RELAY["antenna"]} antenna, logging {RELAY["band"]} wildlife tags and relaying over cellular',
                         f'An auto-calibration sweep tunes SDR gain across {RELAY["gain_sweep"]} on boot, so a station is set up for its site rather than for a bench',
                         'A watchdog daemon checks system health every 60 seconds, because a station that fails quietly is worse than no station'],
                'figure': (img('assets/relay-station-sunset.avif', 'A relay station deployed in a coastal marsh at sunset'),
                           'A station on site. Everything above the waterline was assembled from parts under $100.'),
            },
            {
                'title': 'Deployments',
                'body': ['Galápagos: marine species tracking with local researchers',
                         'California: expanding a VHF telemetry network across multiple coastal sites statewide'],
                'figure': (img('assets/relay-range-map.png', 'Map of measured detection range around a deployed relay station'),
                           'Measured detection range around a deployed station.'),
            },
            {
                'title': 'Tuning in the field',
                'body': ['Antenna geometry and gain measured on site rather than assumed, because a station is only as good as the day it was set up'],
                'figure': (img('assets/relay-antenna-analysis.avif', 'Antenna performance analysis from field testing'),
                           'Antenna analysis from field testing.'),
            },
            {
                'title': 'What it detects',
                'body': [f'{RELAY["max_range"]} maximum range at a {RELAY["detection_rate"]} detection rate, measured at Monterey Bay coastal sites rather than quoted from a datasheet',
                         'Adaptive pulse detection with ghost filtering, and a coefficient of variation test that separates a real repeating tag from noise'],
                'figure': (img('assets/relay-snr-comparison.png',
                               'Spectrograms showing how tag pulses appear at strong, medium, weak and very weak signal strengths'),
                           'How a tag pulse actually looks at four signal strengths, which is what the detection rate is measured against.'),
            },
            {
                'title': 'Teaching it out',
                'body': ['Students assemble a full station end to end, from bare board to a unit logging tags in the field, then site it and maintain it',
                         'Hardware only its builder can repair is a demo. A station a local team can rebuild from parts is infrastructure, and that is the difference the programme is built around.'],
                'figure': (img('assets/relay-detailed-verification.avif',
                               'Detection verification output from a deployed relay station'),
                           'Verification from a student-built unit. The test is whether it detects a real tag, not whether it powers on.'),
            },
        ],
        'tags': ['VHF Telemetry', 'Field Instrumentation', 'Galápagos', 'Training'],
        'crosslink': ('Build it yourself', [('folder-relay', 'Technology / relay-station')]),
        'refs_title': 'Programme overview',
        'presentations': [
            (None, None,
             'https://docs.google.com/presentation/d/1Ghkgao_iwUbkBy0n7kmHcbhW50ed88gM/embed?start=false&loop=false&delayms=3000',
             'Relay Station Training Program overview'),
        ],
    },

    {
        'key': 'southafrica',
        'kind': 'field',
        'org': 'South African coastal waters',
        'title': 'Research &amp; Diver Development Program',
        'byline': 'Survey diver and vessel crew',
        'dateline': 'July – August 2024',
        'record': [
            ('Dates', 'July – August 2024'),
            ('Location', 'South African coastal waters'),
            ('Logged', '31 hours of scientific diving'),
            ('Role', 'Survey diver and vessel crew'),
        ],
        'abstract': 'Six weeks of working dives on a coastline none of us knew, running whatever survey the day called for. It is the clearest lesson I have had in how much of marine science is method discipline under conditions you did not choose.',
        'lead': (img('assets/On a boat in SA.avif', 'Working on a research boat off the South African coast'),
                 'The office for six weeks. Whatever survey the day called for, run off this deck.'),
        'sections': [
            {
                'title': 'Subtidal surveys',
                'body': ['Nudibranch population surveys and species identification dives',
                         'Quadrat-based invertebrate counts',
                         'Swell shark egg casing measurement and analysis'],
                'figure': (img('assets/panels/sa-divegear.avif', 'In dive gear on the boat before a survey dive'),
                           'Kitted up before a survey dive.'),
            },
            {
                'title': 'Video &amp; sampling',
                'body': ['BRUV (baited remote underwater video) camera deployments',
                         'Microplastic sampling in coastal waters',
                         'Fish dissections and specimen work'],
                'figure': (img('assets/Me sampling for microplastics in SA.avif', 'Sampling coastal water for microplastics'),
                           'Microplastic sampling from the surface.'),
            },
            {
                'title': 'Vessel operations',
                'body': ['Docking, loading, anchoring, and navigation',
                         'Equipment deployment and recovery at sea'],
                'figure': (img('assets/Me doing trapping.avif', 'Setting traps during field sampling'),
                           'Setting traps. Gear handling at sea is most of the day.'),
            },
        ],
        'tags': ['Field Work', 'BRUV', 'Subtidal Ecology', 'Scientific Diving'],
    },

    {
        'key': 'fieldops',
        'kind': 'field',
        'org': 'California &amp; Baja California, Mexico',
        'title': 'Field Operations &amp; Scientific Diving',
        'byline': '',
        'dateline': '2024 – Present',
        'record': [
            ('Certifications', 'NAUI Divemaster, AAUS Scientific Diver, MOTC Vessel Operator'),
            ('Logged dives', '143'),
            ('Range', 'California and Baja California, Mexico'),
            ('Also', 'CITI certified, Responsible Conduct of Research'),
        ],
        'abstract': 'The hours behind every other bubble on this page. Diving and vessel work are not a separate interest; they are what makes the rest of the research possible on the days the weather cooperates.',
        'lead': (img('assets/panels/portrait-ocean.avif', 'On the coast between dives'),
                 'Between dives. Most of this work is weather, logistics and gear that has to come back.'),
        'sections': [
            {
                'title': 'Own dive study',
                'body': ['Designed and conducted “Thermal Thresholds: The Role of Temperature Fluctuations in Shaping Kelp Forest Health at San Carlos Beach, Monterey, CA” as the research component of AAUS certification.'],
                'figure': (img('assets/panels/fieldops.avif', 'Working a survey dive in a California kelp forest'),
                           'Kelp forest survey work at San Carlos Beach.'),
            },
            {
                'title': 'Operational work',
                'body': ['Kelp canopy surveys and species identification transects across California and Baja',
                         'Dive planning and safety oversight for other people’s field days, not only my own'],
                'figure': (img('assets/panels/scripps.avif', 'Coastal research site at La Jolla'),
                           'Working coastline in southern California.'),
            },
        ],
        'quote': 'From kelp canopy surveys to offshore tagging operations, every day on the water has reinforced the same lesson: marine field research is where assumptions meet reality. The ocean does not care about your methods section. It demands adaptability, teamwork, and respect for the unpredictable.',
        'tags': ['Scientific Diving', 'Vessel Operations', 'Kelp Forests'],
    },
]

FIG_WORD = {'paper': 'Figure', 'program': 'Figure', 'field': 'Plate'}
ABSTRACT_WORD = {'paper': 'Abstract', 'program': 'The programme', 'field': 'Field notes'}


def render(p):
    kind = p['kind']
    fig_word = FIG_WORD[kind]
    L = []
    a = L.append
    a(f'{IND}<template data-panel="{p["key"]}">')
    a(f'{IND}    <article class="rp rp--{kind}">')

    # ---- Title block ----
    a(f'{IND}        <header class="rp-head">')
    a(f'{IND}            <p class="rp-org">{p["org"]}</p>')
    a(f'{IND}            <h3 class="rp-title">{p["title"]}</h3>')
    if p['byline']:
        a(f'{IND}            <p class="rp-byline">{p["byline"]}</p>')
    a(f'{IND}            <p class="rp-dateline">{p["dateline"]}</p>')
    a(f'{IND}        </header>')

    # ---- Field/programme masthead ----
    if p.get('record'):
        a(f'{IND}        <dl class="rp-record">')
        for term, value in p['record']:
            a(f'{IND}            <div><dt>{term}</dt><dd>{value}</dd></div>')
        a(f'{IND}        </dl>')

    # ---- Abstract ----
    a(f'{IND}        <section class="rp-abstract">')
    a(f'{IND}            <h4>{ABSTRACT_WORD[kind]}</h4>')
    a(f'{IND}            <p>{p["abstract"]}</p>')
    a(f'{IND}        </section>')

    n = 0

    # ---- Optional establishing figure ----
    if p.get('lead'):
        media, caption = p['lead']
        n += 1
        a(f'{IND}        <figure class="rp-plate rp-plate--wide">')
        a(f'{IND}            {media}')
        a(f'{IND}            <figcaption><span class="rp-fignum">{fig_word} {n}</span>{caption}</figcaption>')
        a(f'{IND}        </figure>')

    # ---- Optional before/after comparison ----
    if p.get('compare'):
        a(f'{IND}        <div class="rp-compare">')
        for media, caption in p['compare']:
            n += 1
            a(f'{IND}            <figure class="rp-plate">')
            a(f'{IND}                {media}')
            a(f'{IND}                <figcaption><span class="rp-fignum">{fig_word} {n}</span>{caption}</figcaption>')
            a(f'{IND}            </figure>')
        a(f'{IND}        </div>')

    # ---- Numbered sections, each led by its figure ----
    if p['sections']:
        a(f'{IND}        <div class="rp-sections">')
    for i, s in enumerate(p['sections'], start=1):
        media, caption = s['figure']
        n += 1
        a(f'{IND}            <section class="rp-section">')
        a(f'{IND}                <figure class="rp-plate">')
        a(f'{IND}                    {media}')
        if caption:
            a(f'{IND}                    <figcaption><span class="rp-fignum">{fig_word} {n}</span>{caption}</figcaption>')
        a(f'{IND}                </figure>')
        a(f'{IND}                <details class="rp-fold">')
        a(f'{IND}                    <summary><span class="rp-fold-num">{i}</span>'
          f'<span class="rp-fold-title">{s["title"]}</span>'
          f'<span class="rp-fold-chevron" aria-hidden="true"></span></summary>')
        a(f'{IND}                    <div class="rp-fold-body">')
        if len(s['body']) == 1:
            a(f'{IND}                        <p>{s["body"][0]}</p>')
        else:
            a(f'{IND}                        <ul>')
            for b in s['body']:
                a(f'{IND}                            <li>{b}</li>')
            a(f'{IND}                        </ul>')
        a(f'{IND}                    </div>')
        a(f'{IND}                </details>')
        a(f'{IND}            </section>')
    if p['sections']:
        a(f'{IND}        </div>')

    # ---- Closing figure ----
    if p.get('closing_figure'):
        media, caption = p['closing_figure']
        n += 1
        a(f'{IND}        <figure class="rp-plate rp-plate--wide">')
        a(f'{IND}            {media}')
        a(f'{IND}            <figcaption><span class="rp-fignum">{fig_word} {n}</span>{caption}</figcaption>')
        a(f'{IND}        </figure>')

    if p.get('quote'):
        a(f'{IND}        <blockquote class="rp-quote">{p["quote"]}</blockquote>')

    # ---- Publications ----
    if p.get('publications'):
        a(f'{IND}        <section class="rp-block">')
        a(f'{IND}            <h4>Manuscripts in review</h4>')
        a(f'{IND}            <ol class="rp-pubs">')
        for pub in p['publications']:
            a(f'{IND}                <li>{pub}</li>')
        a(f'{IND}            </ol>')
        a(f'{IND}        </section>')

    # ---- Talk / paper pending state ----
    if p.get('pending'):
        a(f'{IND}        <section class="rp-block">')
        a(f'{IND}            <h4>{p.get("refs_title", "References")}</h4>')
        for item in p['pending']:
            if item.lstrip().startswith('<!--'):
                a(f'{IND}            {item}')
            else:
                a(f'{IND}            <p class="rp-pending">{item}</p>')
        a(f'{IND}        </section>')

    # ---- Presentations ----
    if p.get('presentations'):
        a(f'{IND}        <section class="rp-block">')
        a(f'{IND}            <h4>{p.get("refs_title", "Presentations")}</h4>')
        a(f'{IND}            <div class="rp-pres">')
        for title, date, src, ifr_title in p['presentations']:
            a(f'{IND}                <div class="pres-embed">')
            if title:
                a(f'{IND}                    <h5>{title} <span class="pres-date">{date}</span></h5>')
            # Facade, not the embed itself: four Google frames opening at once
            # throttle the whole page to 15fps, so each one loads on request
            a(f'{IND}                    <button type="button" class="pres-facade" '
              f'data-embed="{src}" data-embed-title="{html.escape(ifr_title)}">'
              f'<span class="pres-play" aria-hidden="true"></span>'
              f'<span class="pres-facade-label">Load presentation</span></button>')
            a(f'{IND}                </div>')
        a(f'{IND}            </div>')
        a(f'{IND}        </section>')

    # ---- Footer: tags and cross-links ----
    a(f'{IND}        <div class="rp-tags">')
    for t in p['tags']:
        a(f'{IND}            <span class="tag">{t}</span>')
    a(f'{IND}        </div>')

    if p.get('crosslink'):
        label, links = p['crosslink']
        a(f'{IND}        <p class="rp-crosslink">')
        a(f'{IND}            {label}')
        for folder, text in links:
            a(f'{IND}            <button type="button" class="rp-crosslink-btn" data-goto-tech="{folder}">{text}</button>')
        a(f'{IND}        </p>')

    a(f'{IND}    </article>')
    a(f'{IND}</template>')
    return '\n'.join(L)


def main():
    idx = V2 / 'index.html'
    lines = idx.read_text().split('\n')

    start = next(i for i, l in enumerate(lines) if l.strip().startswith('<template data-panel='))
    end = max(i for i, l in enumerate(lines) if l.strip() == '</template>')
    assert lines[end + 1].strip() == '</section>', lines[end + 1]

    blocks = '\n\n'.join(render(p) for p in PANELS).split('\n')
    out = lines[:start] + blocks + lines[end + 1:]
    idx.write_text('\n'.join(out))
    print(f'rebuilt {len(PANELS)} panels ({len(blocks)} lines); index.html now {len(out)} lines')


if __name__ == '__main__':
    main()

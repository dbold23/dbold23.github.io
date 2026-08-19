#!/usr/bin/env python3
"""Single source for every contested quantity on the site.

The site states the same numbers on three surfaces: the Technology file tree, the
Research panels, and the CV. Typing them three times is how the shark pose metric
ended up as 98%, 96% and 0.96 under three different names. Anything here is
imported by build_panels.py and build_cv.py so a correction lands everywhere.

The Technology file tree is the source of truth for measured values, because it
is where the measurement is described alongside its protocol.
"""

# ---------------------------------------------------------------- sharks ----

SHARK = {
    # index.html folder-shark-morpho
    'box_map50': '0.96',
    'box_map50_label': 'box mAP50',
    'videos': '4,850',
    'corpus_size': '661 GB',
    'corpus_years': '2012–2026',
    'sites': 'Año Nuevo, Aptos, the Farallon Islands and Point Reyes',
    'site_count': '4',
    'pipeline_stages': '8',
    # Two distinct schemas. The pose model and the annotation platform are not the
    # same thing and have never had the same number of points.
    'pose_keypoints': '16',
    'annotator_skeleton_points': '15',
}

# ------------------------------------------------------------- porpoise -----

# Re-identification. One approach, more than one species. Numbers below come from
# marine-cv/porpoise-id/README.md and marine-cv/7Gill/, not from memory.

REID = {
    # --- harbor porpoise, dorsal fin shape: the worked case ---
    'porpoise_individuals': '198',
    'porpoise_images': '2,153',
    'porpoise_sightings': '2,393',
    'porpoise_backbone': 'MegaDescriptor-L-384',
    'porpoise_backbones_evaluated': 'MegaDescriptor-L-384, DINOv2-base and a two-backbone ensemble',
    'porpoise_backbone_note': 'chosen over DINOv2-base and the ensemble on this catalogue',
    # The unbiased evaluation, and the one the README says to quote
    'porpoise_temporal_rank1': '30.5%',
    'porpoise_temporal_rank5': '57.4%',
    'porpoise_temporal_condition': 'train ≤ 2022, test 2023+',
    'porpoise_temporal_config': 'MegaDescriptor with SGD, cosine schedule, scale 64',
    # Kept only because the gallery-size experiment needs it. The project README
    # is explicit that this number is inflated and should not be compared across
    # systems, because the ArcFace head sees the test samples during training.
    'porpoise_loo_rank1': '93.0%',
    'porpoise_loo_rank5': '98.3%',
    'porpoise_loo_condition': '94 individuals with at least 5 sightings',
    'porpoise_caveat': 'dorsal fin shape changes over years, which is what the temporal split exposes',

    # --- broadnose sevengill, spot constellations: same machinery, different signal ---
    'sevengill_species': 'Notorynchus cepedianus',
    'sevengill_signal': 'natural freckling, matched as a spot constellation rather than an outline',
    'sevengill_images': '1,099',
    'sevengill_labelled_individuals': '51',
    'sevengill_tracks': 'a fine-tuned MiewID head-crop embedding, a spot-graph GNN, and ALFRE-ID zero-shot local features',
    'sevengill_lowdata': 'below roughly 1,000 to 2,000 images, local-feature aggregation beats fine-tuned metric learning, so the zero-shot track leads',

    # --- the platform ---
    'platform_scope': 'any patterned marine species, with leopard sharks and eagle rays as the next candidates',
}

# ---------------------------------------------------------------- relay -----

RELAY = {
    'max_range': '1,700 ft',
    'detection_rate': '62%',
    'cost': 'under $100',
    'commercial_cost': '$100',   # placeholder, see COMMERCIAL below
    'commercial_receiver': '$695',
    'antenna': 'Yagi directional',
    'gain_sweep': '15–45 dB',
    'band': 'VHF',               # not acoustic. The tags are VHF.
    'sites': 'the Galápagos and multiple California coastal sites',
}

# ------------------------------------------------------------------ jue -----

JUE = {
    # All reconciled against TECAN_growth_curves/README.md in the project repo.
    # run_full_pipeline.py is the "Master orchestrator (11-step pipeline)"
    # (README.md:110); the old 6 counted analysis stages and skipped the
    # preprocessing, inter-operator and genomic steps either side of them.
    'pipeline_stages': '11',
    'strains': '92',
    # README.md:62 — "161 averaged curves, 6 groups, 3 operators, 2018-2025".
    # Groups 1-4 are one operator, 5 and 6 are the other two; the old 4 counted
    # only the first operator's.
    'groups': '6',
    'curves': '161',
    'operators': '3',
    # README.md:58 — 480 synthetic + 85 real audited curves are the TRAINING
    # set, at a 70/30 held-out split. The independent validation is a separate
    # 555-curve suite on a different seed (README.md:83). Calling 480 the
    # validation set, as this file used to, swapped the two.
    'train_synthetic': '480',
    'train_real': '85',
    'validation_curves': '555',
    'validation_accuracy': '98.7%',
    'heldout_accuracy': '99.5%',
}

# --------------------------------------------------------------- habhub -----

HABHUB = {
    'features': '47',
    'apis': '3 custom REST APIs',
    'dashboards': 'dual dashboards, one for growers and one for public safety',
    'award': '1st Place, NOAA SatHack 2025',
    'award_date': 'October 2025',
    # A talk about HABHub cannot predate the hackathon that produced it
    'esip_date': 'January 2026',
}

# -------------------------------------------------------------- fathomnet ---

FATHOMNET = {
    'migrations': '10',
    'rle_tests': '17',
    'export_formats': 'COCO, YOLO and Pascal VOC',
    'grading_tiers': 'accept, review and reject',
    'pilot': 'SAM 2',
    'full_run': 'SAM 3',
}

# ---------------------------------------------------------------- diving ----

FIELD = {
    'logged_dives': '143',
    'sa_hours': '31',
}

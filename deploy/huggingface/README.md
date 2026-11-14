---
title: Radians
emoji: 🔭
colorFrom: indigo
colorTo: yellow
sdk: docker
app_port: 7860
pinned: false
short_description: Blink NASA SPHEREx infrared images to find moving stars
---

# Radians — SPHEREx sky blink

Type a star name or coordinates and watch NASA SPHEREx infrared images of that patch of sky change
over time. Moving stars, variable stars and asteroids stand out; click any star for its 0.75–5 µm
spectrum and light curve.

Team: Mert Metin, Efe Gönderen, Bora Hısım, Emre Bozkaya.

NASA Space Apps Challenge 2026 — *Planet X and SPHEREx*. Source code: https://github.com/merttmtnn-sudo/Radians

Data: NASA SPHEREx (IRSA), ESA Gaia DR3, IMCCE SkyBoT, CSA NEOSSat (CADC), CDS Sesame and Aladin Lite.
The first look at a new position reads a few hundred SPHEREx exposures from IRSA; after that it is cached.

# Hugging Face Space build: fetches Radians from GitHub (public), so the Space holds only this file and
# README.md. "Factory rebuild" in the Space settings picks up the newest commit on main.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CACHE_DIR=/tmp/radians-cache MAX_WORKERS=32 WARM_ON_START=1 PORT=7860

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 user
WORKDIR /app
# changes whenever main moves on, so the clone below is never served from the build cache
ADD https://api.github.com/repos/merttmtnn-sudo/Radians/git/refs/heads/main /tmp/radians-main.json
RUN git clone --depth 1 https://github.com/merttmtnn-sudo/Radians.git /app \
    && pip install --no-cache-dir -r backend/requirements.txt \
    && chown -R user /app
USER user

EXPOSE 7860
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]

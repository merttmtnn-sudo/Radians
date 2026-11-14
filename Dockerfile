# Radians: one container serves the API and the static page (Hugging Face Docker Space, port 7860)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    CACHE_DIR=/tmp/radians-cache MAX_WORKERS=32 WARM_ON_START=1 PORT=7860

# Hugging Face runs the container as user 1000
RUN useradd -m -u 1000 user
WORKDIR /app
COPY --chown=user backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY --chown=user backend backend
COPY --chown=user frontend frontend
USER user

EXPOSE 7860
WORKDIR /app/backend
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]

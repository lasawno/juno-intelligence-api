# ── VibeVoice Realtime 0.5B — Railway Deployment ──────────────────────────────
# CPU-safe base; swap for nvcr.io/nvidia/pytorch:24.07-py3 when GPU is enabled
FROM python:3.11-slim

WORKDIR /app

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# ── PyTorch (CPU) ─────────────────────────────────────────────────────────────
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# ── Clone VibeVoice repo ──────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/microsoft/VibeVoice.git /vibevoice

# ── Install VibeVoice + streaming extras ─────────────────────────────────────
RUN cd /vibevoice && pip install --no-cache-dir -e ".[streamingtts]"

# ── Install server deps ───────────────────────────────────────────────────────
RUN pip install --no-cache-dir fastapi uvicorn scipy soundfile

# ── Copy service entrypoint ───────────────────────────────────────────────────
COPY server.py /app/server.py

# ── Environment ───────────────────────────────────────────────────────────────
ENV MODEL_DEVICE=cpu
ENV MODEL_PATH=microsoft/VibeVoice-Realtime-0.5B
ENV VIBEVOICE_SRC=/vibevoice
ENV HF_HOME=/data/hf-cache
ENV TRANSFORMERS_CACHE=/data/hf-cache

EXPOSE 8881

CMD ["python", "/app/server.py"]

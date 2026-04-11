# ── VibeVoice Realtime 0.5B — Railway GPU Deployment ─────────────────────────
# Recommended base: NVIDIA PyTorch Container 24.07+ (CUDA 12.x, PyTorch 2.x)
FROM nvcr.io/nvidia/pytorch:24.07-py3

WORKDIR /app

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# ── Clone VibeVoice repo ──────────────────────────────────────────────────────
RUN git clone --depth 1 https://github.com/microsoft/VibeVoice.git /vibevoice

# ── Install VibeVoice + streaming extras ─────────────────────────────────────
RUN cd /vibevoice && pip install --no-cache-dir -e ".[streamingtts]"

# ── Install server deps ───────────────────────────────────────────────────────
RUN pip install --no-cache-dir fastapi uvicorn scipy soundfile

# ── Copy service entrypoint ───────────────────────────────────────────────────
COPY server.py /app/server.py

# ── Environment ───────────────────────────────────────────────────────────────
ENV MODEL_DEVICE=cuda
ENV MODEL_PATH=microsoft/VibeVoice-Realtime-0.5B
ENV VIBEVOICE_SRC=/vibevoice
ENV PORT=8881

# Hugging Face cache → persistent Railway volume (optional, speeds up restarts)
ENV HF_HOME=/data/hf-cache
ENV TRANSFORMERS_CACHE=/data/hf-cache

EXPOSE 8881

# ── Start ─────────────────────────────────────────────────────────────────────
CMD ["python", "/app/server.py"]

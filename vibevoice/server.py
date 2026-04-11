import os
import sys
import io
import copy
import glob
import time
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import torch
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, JSONResponse
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("vibevoice-service")

DEVICE = os.environ.get("MODEL_DEVICE", "cuda" if os.path.exists("/usr/local/cuda") else "cpu")
MODEL_PATH = os.environ.get("MODEL_PATH", "microsoft/VibeVoice-Realtime-0.5B")
PORT = int(os.environ.get("PORT", "8881"))
# VIBEVOICE_SRC: override for Docker deployments where repo is at a fixed path
_default_src = Path(__file__).parent / "vibevoice-src"
SRC_DIR = Path(os.environ.get("VIBEVOICE_SRC", str(_default_src)))
DEMO_DIR = SRC_DIR / "demo"

# Globals — loaded lazily on first request
_model = None
_processor = None
_voices: dict[str, str] = {}
_model_ready = False
_model_loading = False
_model_error: str | None = None


def discover_voices() -> dict[str, str]:
    voices_dir = DEMO_DIR / "voices" / "streaming_model"
    result: dict[str, str] = {}
    if voices_dir.exists():
        for pt in sorted(voices_dir.rglob("*.pt")):
            name = pt.stem.lower()
            result[name] = str(pt)
    logger.info(f"Discovered {len(result)} voice preset(s): {list(result.keys())}")
    return result


def load_model() -> None:
    global _model, _processor, _model_ready, _model_loading, _model_error
    if _model_ready or _model_loading:
        return
    _model_loading = True
    try:
        sys.path.insert(0, str(SRC_DIR))
        from vibevoice.modular.modeling_vibevoice_streaming_inference import (
            VibeVoiceStreamingForConditionalGenerationInference,
        )
        from vibevoice.processor.vibevoice_streaming_processor import (
            VibeVoiceStreamingProcessor,
        )

        logger.info(f"Loading processor from {MODEL_PATH}")
        _processor = VibeVoiceStreamingProcessor.from_pretrained(MODEL_PATH)

        logger.info(f"Loading model on device={DEVICE}")
        _model = VibeVoiceStreamingForConditionalGenerationInference.from_pretrained(
            MODEL_PATH,
            torch_dtype=torch.float32,
            device_map=DEVICE,
            attn_implementation="sdpa",
        )
        _model.eval()
        _model.set_ddpm_inference_steps(num_steps=5)
        _model_ready = True
        _model_error = None
        logger.info("VibeVoice model ready")
    except Exception as exc:
        _model_error = str(exc)
        logger.error(f"Model load failed: {exc}")
    finally:
        _model_loading = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _voices
    _voices = discover_voices()
    logger.info(f"VibeVoice service starting — device={DEVICE}")
    yield
    logger.info("VibeVoice service stopped")


app = FastAPI(title="VibeVoice Service", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "status": "ready" if _model_ready else ("loading" if _model_loading else "idle"),
        "device": DEVICE,
        "model": MODEL_PATH,
        "ready": _model_ready,
        "voices": list(_voices.keys()),
        "error": _model_error,
    }


@app.get("/voices")
def list_voices():
    return {"voices": list(_voices.keys()), "count": len(_voices)}


class SynthesizeRequest(BaseModel):
    text: str
    speaker: str = "carter"
    cfg_scale: float = 1.5


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest):
    global _model, _processor, _model_ready

    if not req.text.strip():
        raise HTTPException(400, "text is required")

    if not _model_ready:
        if _model_error:
            raise HTTPException(503, f"Model failed to load: {_model_error}")
        load_model()
        if not _model_ready:
            raise HTTPException(503, "Model is still loading, please retry in a moment")

    if not _voices:
        raise HTTPException(503, "No voice presets found. Run setup.sh to download voices.")

    speaker = req.speaker.lower()
    if speaker not in _voices:
        speaker = next(iter(_voices))
        logger.warning(f"Speaker '{req.speaker}' not found, using '{speaker}'")

    voice_path = _voices[speaker]
    target_device = DEVICE if DEVICE != "cpu" else "cpu"

    try:
        start = time.time()
        voice_preset = torch.load(voice_path, map_location=target_device, weights_only=False)

        text = req.text[:500].replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')

        inputs = _processor.process_input_with_cached_prompt(
            text=text,
            cached_prompt=voice_preset,
            padding=True,
            return_tensors="pt",
            return_attention_mask=True,
        )
        for k, v in inputs.items():
            if torch.is_tensor(v):
                inputs[k] = v.to(target_device)

        with torch.no_grad():
            outputs = _model.generate(
                **inputs,
                max_new_tokens=None,
                cfg_scale=req.cfg_scale,
                tokenizer=_processor.tokenizer,
                generation_config={"do_sample": False},
                verbose=False,
                all_prefilled_outputs=copy.deepcopy(voice_preset),
            )

        elapsed = time.time() - start
        logger.info(f"Synthesis done in {elapsed:.2f}s for speaker={speaker}")

        if not outputs.speech_outputs or outputs.speech_outputs[0] is None:
            raise HTTPException(500, "No audio generated")

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = tmp.name

        _processor.save_audio(outputs.speech_outputs[0], output_path=tmp_path)

        with open(tmp_path, "rb") as f:
            audio_bytes = f.read()
        os.unlink(tmp_path)

        return Response(
            content=audio_bytes,
            media_type="audio/wav",
            headers={
                "X-Speaker": speaker,
                "X-Generation-Time": f"{elapsed:.2f}s",
                "Cache-Control": "no-store",
            },
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Synthesis error: {exc}")
        raise HTTPException(500, f"Synthesis failed: {exc}")


@app.post("/load")
def trigger_load():
    if _model_ready:
        return {"status": "already_loaded"}
    if _model_loading:
        return {"status": "loading"}
    import threading
    threading.Thread(target=load_model, daemon=True).start()
    return {"status": "loading_started"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, log_level="info")

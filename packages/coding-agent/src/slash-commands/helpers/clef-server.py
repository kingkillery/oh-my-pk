import importlib
import os
import sys
import threading

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from huggingface_hub import snapshot_download

os.environ.setdefault("HF_XET_HIGH_PERFORMANCE", "1")
MODEL_ID = os.environ["OMPK_CLEF_MODEL_ID"]
MODEL_NAME = "clef-flash" if MODEL_ID.endswith("clef-flash") else "clef"
PORT = int(os.environ.get("OMPK_CLEF_PORT", "8000"))

if not torch.cuda.is_available():
    raise RuntimeError("CUDA is required for Clef decision inference.")

DTYPE = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
gpu_gb = torch.cuda.get_device_properties(0).total_memory / (1024 ** 3)
USE_4BIT = gpu_gb < (60 if MODEL_NAME == "clef" else 24)

model_path = snapshot_download(MODEL_ID)
if model_path not in sys.path:
    sys.path.insert(0, model_path)

sys.modules.pop("joint_schema_model", None)
joint_schema_model = importlib.import_module("joint_schema_model")
load_release_model = joint_schema_model.load_release_model
systemone = joint_schema_model.systemone

load_kwargs = {}
if USE_4BIT:
    from transformers import BitsAndBytesConfig

    load_kwargs["quantization_config"] = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype=DTYPE,
    )

model, processor = load_release_model(
    model_path,
    device="cuda",
    dtype=DTYPE,
    **load_kwargs,
)

app = FastAPI(title="OMPK Clef Decision API", version="1.0.0", docs_url="/docs", redoc_url=None)
inference_lock = threading.Lock()


@app.get("/healthz")
def healthz():
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "model_id": MODEL_ID,
        "tailnet_only": True,
    }


@app.get("/v1/models")
def models():
    return {
        "data": [
            {
                "id": MODEL_NAME,
                "object": "model",
                "provider": "Cloudflare",
                "source": MODEL_ID,
            }
        ]
    }


@app.post("/v1/systemone")
def systemone_endpoint(payload: dict):
    request = dict(payload)
    request.setdefault("model", MODEL_NAME)
    if request["model"] not in {MODEL_NAME, MODEL_ID}:
        raise HTTPException(
            status_code=400,
            detail=f"This runtime loaded {MODEL_NAME}; got model={request['model']!r}.",
        )
    if request.get("images") or request.get("videos"):
        raise HTTPException(status_code=400, detail="Remote media transport is not enabled for this endpoint.")
    try:
        with inference_lock:
            return systemone(model, processor, request)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"{type(exc).__name__}: {exc}") from exc


uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info", access_log=True)

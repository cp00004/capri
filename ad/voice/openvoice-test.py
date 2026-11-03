import os, time, json
os.environ.setdefault("OMP_NUM_THREADS", "8")
import torch
torch.set_num_threads(8)
from openvoice.api import ToneColorConverter
from resemblyzer import VoiceEncoder, preprocess_wav
import numpy as np

CKPT = "checkpoints_v2/converter"
REF = "capri-ref.wav"
BASE = "base.wav"
OUT = "ov-test.wav"

t0 = time.time()
tc = ToneColorConverter(f"{CKPT}/config.json", device="cpu")
tc.load_ckpt(f"{CKPT}/checkpoint.pth")
print(f"load converter {time.time()-t0:.2f}s sr={tc.hps.data.sampling_rate}", flush=True)

t0 = time.time()
tgt_se = tc.extract_se(REF)
torch.save(tgt_se.cpu(), "capri-se.pth")
print(f"ref se {time.time()-t0:.2f}s", flush=True)

t0 = time.time()
src_se = tc.extract_se(BASE)
print(f"src se {time.time()-t0:.2f}s", flush=True)

t0 = time.time()
tc.convert(BASE, src_se, tgt_se, OUT)
conv = time.time() - t0
print(f"convert {conv:.2f}s", flush=True)

enc = VoiceEncoder("cpu")
ref_emb = enc.embed_utterance(preprocess_wav(REF))
base_emb = enc.embed_utterance(preprocess_wav(BASE))
out_emb = enc.embed_utterance(preprocess_wav(OUT))
cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
print(json.dumps({
    "convert_s": round(conv, 2),
    "sim_ref_base": round(cos(ref_emb, base_emb), 3),
    "sim_ref_out": round(cos(ref_emb, out_emb), 3),
    "sim_base_out": round(cos(base_emb, out_emb), 3),
}))

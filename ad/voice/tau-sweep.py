import os, time, json, itertools
os.environ.setdefault("OMP_NUM_THREADS", "10")
import torch, librosa, numpy as np
torch.set_num_threads(10)
from openvoice.api import ToneColorConverter
from resemblyzer import VoiceEncoder, preprocess_wav

CKPT = "checkpoints_v2/converter"
REF = "capri-ref.wav"
tc = ToneColorConverter(f"{CKPT}/config.json", device="cpu")
tc.load_ckpt(f"{CKPT}/checkpoint.pth")
tgt_se = tc.extract_se(REF)
torch.save(tgt_se.cpu(), "capri-se.pth")

enc = VoiceEncoder("cpu")
ref_emb = enc.embed_utterance(preprocess_wav(REF, source_sr=24000))
cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))

for src in ["base.wav", "base-gemini.wav"]:
    dur = librosa.get_duration(path=src)
    src_se = tc.extract_se(src)
    base_emb = enc.embed_utterance(preprocess_wav(src, source_sr=24000))
    for tau in (0.3, 0.5, 0.7):
        out = f"ov-{os.path.basename(src).rsplit('.',1)[0]}-t{int(tau*100)}.wav"
        t0 = time.time()
        tc.convert(src, src_se, tgt_se, out, tau=tau)
        conv = time.time() - t0
        emb = enc.embed_utterance(preprocess_wav(out, source_sr=22050))
        print(json.dumps({"src": src, "dur": round(dur, 2), "tau": tau, "conv_s": round(conv, 2),
                          "rtf": round(conv / dur, 2), "sim_ref": round(cos(ref_emb, emb), 3),
                          "sim_base": round(cos(base_emb, emb), 3), "sim_ref_base": round(cos(ref_emb, base_emb), 3)}), flush=True)

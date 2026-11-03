import os, time, json
os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("OMP_NUM_THREADS", "10")
import torch
torch.set_num_threads(10)
from TTS.api import TTS

TXT = ("Im a star, hello, I am Capri, your assistant, Im now on mobile and PC for free. "
       "I can help you make ideas, edit your computer, or help you not to go oon on NNN, no nut, November.")
t0 = time.time()
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
print(f"load {time.time()-t0:.1f}s", flush=True)
t0 = time.time()
tts.tts_to_file(text=TXT, speaker_wav="capri-ref.wav", language="en", file_path="xtts-full.wav")
print(f"gen {time.time()-t0:.1f}s chars {len(TXT)}", flush=True)

import numpy as np
from resemblyzer import VoiceEncoder, preprocess_wav
enc = VoiceEncoder("cpu")
ref = enc.embed_utterance(preprocess_wav("capri-ref.wav", source_sr=24000))
out = enc.embed_utterance(preprocess_wav("xtts-full.wav", source_sr=24000))
cos = float(np.dot(ref, out) / (np.linalg.norm(ref) * np.linalg.norm(out)))
print(json.dumps({"xtts_sim_ref": round(cos, 3)}), flush=True)

import os, time
os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("OMP_NUM_THREADS", "10")
import torch
torch.set_num_threads(10)
from TTS.api import TTS

LINES = [
  ("l18", "The link is on screen. Take it.", 1.12),
  ("l19", "Windows, Android, one voice. Say my name.", 1.1),
]
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
for lid, text, speed in LINES:
    dst = os.path.join("long", lid + ".wav")
    if os.path.exists(dst):
        os.remove(dst)
    t0 = time.time()
    tts.tts_to_file(text=text, speaker_wav="capri-ref.wav", language="en", file_path=dst, speed=speed)
    print(f"{lid} {time.time()-t0:.0f}s {os.path.getsize(dst)}B {text}", flush=True)
print("done", flush=True)

import os, time, sys
os.environ["COQUI_TOS_AGREED"] = "1"
os.environ.setdefault("OMP_NUM_THREADS", str(os.cpu_count()))
from TTS.api import TTS

t0 = time.time()
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
print("load %.1fs" % (time.time() - t0), flush=True)

text = "Hello choom, I am Capri. I run on your phone and your PC, and I am free."
t0 = time.time()
tts.tts_to_file(text=text, speaker_wav="capri-ref.wav", language="en", file_path="xtts-test.wav")
print("gen %.1fs for %d chars" % (time.time() - t0, len(text)), flush=True)

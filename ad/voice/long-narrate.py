import os, time, json, sys
os.environ.setdefault("COQUI_TOS_AGREED", "1")
os.environ.setdefault("OMP_NUM_THREADS", "10")
import torch
torch.set_num_threads(10)
from TTS.api import TTS

LINES = [
  ("l01",  "Hey. I'm Capri. Voice-first. On your PC, on your phone, and free."),
  ("l02",  "You don't click anything. You just say my name, Capri, and I answer out loud."),
  ("l03",  "Ask me anything. Or tell me what to do."),
  ("l04",  "One voice, everywhere. This is it: the same tone on Windows and on Android."),
  ("l05",  "No settings. No robot menu. Just me."),
  ("l06",  "On your PC I'm a real window. I open apps, write your notes, find your files."),
  ("l07",  "Every action asks first. And what I can undo, I undo."),
  ("l08",  "My eye floats over everything. I watch the tab, the video, the game,"),
  ("l09",  "and I say something worth hearing. Drag me anywhere."),
  ("l10",  "On Android I'm the same girl in your pocket. Wake me with your voice."),
  ("l11",  "I drive your phone, and answer in a notification, even with the app closed."),
  ("l12",  "I remember. Your name, your projects, the way you like things."),
  ("l13",  "Kept to your account, one profile each, and you can make me forget."),
  ("l14",  "And if it's November, I guard you. Sites blocked. Tabs blacked out."),
  ("l15",  "The app stays locked until December first. You asked. I keep it."),
  ("l16",  "Your keys stay on your machine. Your account stays yours. No subscription."),
  ("l17",  "I cost nothing. I'm just very good at this."),
  ("l18",  "Get me at cp zero zero zero zero four dot github dot io slash capri."),
  ("l19",  "Windows. Android. One voice. Say my name."),
  ("l20",  "I'm Capri. See you on the other side."),
]

outdir = "long"
os.makedirs(outdir, exist_ok=True)
missing = [l for l in LINES if not os.path.exists(os.path.join(outdir, l[0] + ".wav"))]
if not missing:
    print("all lines already rendered", flush=True)
    sys.exit(0)

t0 = time.time()
tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to("cpu")
print(f"load {time.time()-t0:.1f}s", flush=True)
for lid, text in missing:
    t0 = time.time()
    dst = os.path.join(outdir, lid + ".wav")
    tts.tts_to_file(text=text, speaker_wav="capri-ref.wav", language="en", file_path=dst)
    print(f"{lid} {time.time()-t0:.0f}s {os.path.getsize(dst)}B {text}", flush=True)
print("done", flush=True)

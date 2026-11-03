import numpy as np, librosa, soundfile as sf
from resemblyzer import VoiceEncoder, preprocess_wav
import scipy.signal as ss

def ltas(path, sr=24000):
    y, _ = librosa.load(path, sr=sr)
    y = y / (np.max(np.abs(y)) + 1e-9)
    n = 2048
    hop = 512
    win = np.hanning(n)
    frames = librosa.util.frame(y, frame_length=n, hop_length=hop).T
    energy = (frames ** 2).sum(axis=1)
    keep = frames[energy > np.percentile(energy, 40)]
    spec = np.abs(np.fft.rfft(keep * win, axis=1)).mean(axis=0)
    freqs = np.fft.rfftfreq(n, 1 / sr)
    # 1/6-octave smoothing
    out = spec.copy()
    for i, f in enumerate(freqs):
        if f < 60: continue
        lo, hi = f / 2 ** (1 / 12), f * 2 ** (1 / 12)
        m = (freqs >= lo) & (freqs <= hi)
        out[i] = spec[m].mean()
    return freqs, out

f_src, s_src = ltas("base-gemini.wav")
f_cnv, s_cnv = ltas("ov-base-gemini-t50.wav")
ratio = np.clip(20 * np.log10((s_cnv + 1e-9) / (s_src + 1e-9)), -12, 12)

def apply_eq(path, out_path, freqs, db, sr=24000):
    y, _ = librosa.load(path, sr=sr)
    n = 4096
    hop = n // 2
    win = np.hanning(n)
    gain = 10 ** (np.interp(np.fft.rfftfreq(n, 1 / sr), freqs, db) / 20)
    out = np.zeros(len(y) + n)
    norm = np.zeros(len(y) + n)
    for i in range(0, len(y) - n, hop):
        frame = y[i:i + n] * win
        spec = np.fft.rfft(frame) * gain
        out[i:i + n] += np.fft.irfft(spec) * win
        norm[i:i + n] += win ** 2
    out = out[:len(y)] / np.maximum(norm[:len(y)], 1e-6)
    out = out / (np.max(np.abs(out)) + 1e-9) * 0.9
    sf.write(out_path, out.astype(np.float32), sr)

apply_eq("gem-Leda.wav", "leda-eq.wav", f_src, ratio)
apply_eq("base-gemini.wav", "base-eq.wav", f_src, ratio)

enc = VoiceEncoder("cpu")
ref = enc.embed_utterance(preprocess_wav("capri-ref.wav", source_sr=24000))
cos = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
for f in ["gem-Leda.wav", "leda-eq.wav"]:
    e = enc.embed_utterance(preprocess_wav(f, source_sr=24000))
    print(f, round(cos(ref, e), 3))
# how much of the neural conversion the EQ recovers on the same content
conv = enc.embed_utterance(preprocess_wav("ov-base-gemini-t50.wav", source_sr=22050))
base = enc.embed_utterance(preprocess_wav("base-gemini.wav", source_sr=24000))
eqb = enc.embed_utterance(preprocess_wav("base-eq.wav", source_sr=24000))
print("base", round(cos(ref, base), 3), "eq-base", round(cos(ref, eqb), 3), "neural", round(cos(ref, conv), 3))
np.save("tone-eq.npy", np.stack([f_src, ratio]))
print("bands", [(int(f), round(float(d), 1)) for f, d in zip(f_src, ratio) if 80 < f < 12000][::24])

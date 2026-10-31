package com.capri.app;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;

import java.util.ArrayList;
import java.util.Locale;

// Phone-side ear: Google's own recognizer instead of shipping audio to the PC.
// It is a singleton because Android only allows one recognition session, and the
// activity (app open) and the service (app closed) take turns using it.
final class CapriVoice {
	interface Sink {
		void onHeard(String text, String remainder);
		void onError(String code);
	}

	private static final Handler MAIN = new Handler(Looper.getMainLooper());
	private static SpeechRecognizer recognizer;
	private static Context app;
	private static Sink sink;
	private static boolean running;
	private static boolean wakeMode;
	private static boolean finalSeen;
	private static boolean sessionActive;
	private static boolean restartQueued;
	private static int quietStreak;
	private static String lastText = "";

	private CapriVoice() {}

	static boolean available(Context context) {
		try { return SpeechRecognizer.isRecognitionAvailable(context); } catch (Exception err) { return false; }
	}

	static boolean running() {
		return running;
	}

	// wake=true listens until the name is said; wake=false is a single order.
	static void start(Context context, boolean wake, Sink cb) {
		Context appCtx = context.getApplicationContext();
		if (running && app != null && wakeMode == wake) {
			// Same ear, new callbacks. Rebuilding the session here is what made
			// the recognizer click every time the page re-armed the wake word.
			sink = cb;
			return;
		}
		if (!available(context)) {
			release();
			if (cb != null) cb.onError("unavailable");
			return;
		}
		boolean modeChanged = running && wakeMode != wake;
		app = appCtx;
		sink = cb;
		wakeMode = wake;
		running = true;
		finalSeen = false;
		lastText = "";
		quietStreak = 0;
		if (modeChanged) {
			// Cancel only; the recognizer object is reused.
			sessionActive = false;
			final SpeechRecognizer r = recognizer;
			if (r != null) { try { r.cancel(); } catch (Exception err) { /* idle */ } }
			restartQueued = true;
			MAIN.postDelayed(() -> {
				restartQueued = false;
				if (running) listen();
			}, 250);
			return;
		}
		MAIN.post(CapriVoice::listen);
	}

	// Ends the current take but keeps the recognizer warm for the next one.
	static void stop() {
		running = false;
		sessionActive = false;
		restartQueued = false;
		finalSeen = false;
		sink = null;
		final SpeechRecognizer r = recognizer;
		if (r != null) {
			MAIN.post(() -> {
				try { r.cancel(); } catch (Exception err) { /* already idle */ }
			});
		}
	}

	// Turns the ear off for good: the next start builds a fresh session.
	static void release() {
		stop();
		final SpeechRecognizer r = recognizer;
		recognizer = null;
		if (r != null) {
			MAIN.post(() -> {
				try { r.destroy(); } catch (Exception err) { /* already gone */ }
			});
		}
	}

	private static void listen() {
		if (!running || app == null || sessionActive) return;
		if (recognizer == null) {
			try {
				recognizer = SpeechRecognizer.createSpeechRecognizer(app);
			} catch (Exception err) {
				release();
				Sink cb = sink;
				if (cb != null) cb.onError("unavailable");
				return;
			}
			recognizer.setRecognitionListener(new Listener());
		}
		sessionActive = true;
		try {
			recognizer.startListening(intent());
		} catch (Exception err) {
			sessionActive = false;
			schedule(1000);
		}
	}

	private static void schedule(int delay) {
		if (!running || restartQueued) return;
		restartQueued = true;
		MAIN.postDelayed(() -> {
			restartQueued = false;
			if (running) listen();
		}, delay);
	}

	// While hunting for the name she is mostly hearing silence, so every
	// restart is spread further apart. That is quieter on the speaker, easier on
	// the battery, and still reacts the moment a voice lands.
	private static int quietDelay() {
		return Math.min(2600, 750 + 400 * quietStreak);
	}

	private static Intent intent() {
		Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
		intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
		intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US");
		intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
		intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, wakeMode ? 5000 : 1600);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, wakeMode ? 8000 : 2400);
		intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 800);
		return intent;
	}

	private static void handle(Bundle bundle, boolean isFinal) {
		if (!running || bundle == null) return;
		ArrayList<String> list = bundle.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
		if (list == null || list.isEmpty()) return;
		String text = String.valueOf(list.get(0) == null ? "" : list.get(0)).trim();
		if (text.isEmpty()) return;
		lastText = text;
		if (!isFinal) {
			quietStreak = 0;
			// The name plus an order in one breath: act on the partial instead
			// of waiting for the recognizer to close the take.
			if (wakeMode) {
				String rest = wakeRemainder(text);
				if (rest != null && !rest.isEmpty()) deliver(text);
			}
			return;
		}
		finalSeen = true;
		deliver(text);
	}

	private static void deliver(String text) {
		final String remainder = wakeRemainder(text);
		if (wakeMode) {
			if (remainder == null) {
				// Not the name: keep the ear open, without hammering the mic.
				schedule(550);
				return;
			}
			Sink cb = sink;
			stop();
			if (cb != null) cb.onHeard(text, remainder);
			return;
		}
		Sink cb = sink;
		stop();
		if (cb != null) cb.onHeard(text, "");
	}

	// null when the sentence does not contain the name; "" when only the name.
	static String wakeRemainder(String raw) {
		String text = String.valueOf(raw == null ? "" : raw).toLowerCase(Locale.US)
				.replaceAll("[^a-z0-9' ]+", " ")
				.replaceAll("\\s+", " ")
				.trim();
		if (text.isEmpty() || text.contains("capricorn")) return null;
		String[] words = text.split(" ");
		for (int i = 0; i < words.length; i += 1) {
			String word = words[i].replaceAll("^'+|'+$", "");
			boolean hit = WAKE.contains(word);
			int used = 1;
			if (!hit && word.equals("cap") && i + 1 < words.length) {
				String next = words[i + 1].replaceAll("[^a-z]", "");
				if (next.matches("ri|ree|ry|rie")) { hit = true; used = 2; }
			}
			if (!hit) continue;
			StringBuilder rest = new StringBuilder();
			for (int j = i + used; j < words.length; j += 1) {
				if (rest.length() > 0) rest.append(' ');
				rest.append(words[j]);
			}
			return rest.toString().trim();
		}
		return null;
	}

	private static class Listener implements RecognitionListener {
		@Override public void onReadyForSpeech(Bundle params) {
			lastText = "";
			quietStreak = 0;
		}

		@Override public void onBeginningOfSpeech() {
			quietStreak = 0;
		}

		@Override public void onRmsChanged(float rmsdB) {}
		@Override public void onBufferReceived(byte[] buffer) {}
		@Override public void onEndOfSpeech() {}

		@Override public void onPartialResults(Bundle partial) {
			handle(partial, false);
		}

		@Override public void onResults(Bundle results) {
			sessionActive = false;
			handle(results, true);
		}

		@Override
		public void onError(int error) {
			sessionActive = false;
			if (!running) return;
			if (!wakeMode && !lastText.isEmpty() && !finalSeen) {
				deliver(lastText);
				return;
			}
			boolean quiet = error == SpeechRecognizer.ERROR_NO_MATCH
					|| error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
					|| error == SpeechRecognizer.ERROR_NO_SPEECH;
			quietStreak = quiet ? Math.min(5, quietStreak + 1) : 0;
			schedule(error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ? 1500 : quietDelay());
		}

		@Override public void onEvent(int eventType, Bundle params) {}
	}

	private static final java.util.Set<String> WAKE = new java.util.HashSet<>(java.util.Arrays.asList(
			"capri", "capry", "capree", "caprie", "caprii", "kapri", "kapry", "kabri", "cabri",
			"caprice", "cappy", "cappi", "capra", "caprio", "capris"));
}

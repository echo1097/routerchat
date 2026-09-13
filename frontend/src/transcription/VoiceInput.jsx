import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square, X } from "lucide-react";
import { api } from "../api.js";
import { MaskIcon } from "../components/IconButton.jsx";
import "./voiceInput.css";

function releaseRecording(session) {
  clearTimeout(session.timer);
  cancelAnimationFrame(session.frame);
  session.stream?.getTracks().forEach((track) => track.stop());
  session.audioContext?.close().catch(() => {});
}

function readAudio(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.readAsDataURL(blob);
  });
}

export function VoiceInput({ value, setValue, onSubmit, disabled, contextKey }) {
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState("");
  const sessionRef = useRef(null);
  const canvasRef = useRef(null);
  const cancelRef = useRef(null);
  const micRef = useRef(null);
  const latestRef = useRef(null);
  latestRef.current = { value, setValue, onSubmit, disabled };
  const active = phase !== "idle";

  function cancelRecording(restoreFocus = true) {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      session.controller?.abort();
      if (session.recorder?.state === "recording") session.recorder.stop();
      releaseRecording(session);
    }
    setPhase("idle");
    setError("");
    if (restoreFocus) micRef.current?.focus();
  }

  useEffect(() => {
    cancelRecording(false);
    return () => {
      const session = sessionRef.current;
      sessionRef.current = null;
      if (!session) return;
      session.controller?.abort();
      if (session.recorder?.state === "recording") session.recorder.stop();
      releaseRecording(session);
    };
  }, [contextKey]);

  useEffect(() => {
    if (active) cancelRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (disabled && sessionRef.current) cancelRecording(false);
  }, [disabled]);

  async function transcribe(session, sendPrompt) {
    if (sessionRef.current !== session) return;
    setPhase("transcribing");
    setError("");
    try {
      if (!session.blob?.size) throw new Error("No audio was recorded. Cancel and try again.");
      if (session.blob.size > 12_000_000) throw new Error("This recording is too large. Cancel and record a shorter prompt.");
      const audio = await readAudio(session.blob);
      if (sessionRef.current !== session) return;
      session.controller = new AbortController();
      const result = await api("/api/transcription", {
        method: "POST",
        signal: session.controller.signal,
        body: JSON.stringify({ audio, format: session.format }),
      });
      if (sessionRef.current !== session || latestRef.current.disabled) return;
      if (!result.text?.trim()) throw new Error("No speech was detected. Cancel and try again.");
      const prompt = [latestRef.current.value.trimEnd(), result.text.trim()].filter(Boolean).join("\n");
      latestRef.current.setValue(prompt);
      cancelRecording();
      if (sendPrompt) latestRef.current.onSubmit(prompt);
    } catch (error) {
      if (sessionRef.current !== session) return;
      setError(error.message);
      setPhase("retry");
    }
  }

  function finishRecording(sendPrompt) {
    const session = sessionRef.current;
    if (!session || session.finishing) return;
    if (session.blob) {
      transcribe(session, sendPrompt);
      return;
    }
    if (session.recorder?.state !== "recording") return;
    session.finishing = true;
    session.sendPrompt = sendPrompt;
    setPhase("transcribing");
    session.recorder.stop();
    releaseRecording(session);
  }

  function drawWaveform(session) {
    const canvas = canvasRef.current;
    if (!canvas || sessionRef.current !== session) return;
    const context = canvas.getContext("2d");
    const samples = new Uint8Array(session.analyser.fftSize);
    const levels = Array(Math.max(12, Math.floor(canvas.clientWidth / 7))).fill(0);
    let lastTime = 0;
    function drawFrame(time) {
      if (sessionRef.current !== session || session.finishing) return;
      if (time - lastTime > 55) {
        lastTime = time;
        session.analyser.getByteTimeDomainData(samples);
        const energy = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
        levels.push(Math.min(1, energy * 7));
        levels.shift();
        canvas.width = Math.max(1, canvas.clientWidth * devicePixelRatio);
        canvas.height = Math.max(1, canvas.clientHeight * devicePixelRatio);
        context.clearRect(0, 0, canvas.width, canvas.height);
        const spacing = canvas.width / levels.length;
        context.strokeStyle = "#8c8c8c";
        context.lineWidth = Math.max(2, spacing * 0.45);
        context.lineCap = "round";
        levels.forEach((level, index) => {
          const height = Math.max(1, level * canvas.height * 0.8);
          context.beginPath();
          context.moveTo((index + 0.5) * spacing, (canvas.height - height) / 2);
          context.lineTo((index + 0.5) * spacing, (canvas.height + height) / 2);
          context.stroke();
        });
      }
      session.frame = requestAnimationFrame(drawFrame);
    }
    session.frame = requestAnimationFrame(drawFrame);
  }

  async function startRecording() {
    if (sessionRef.current || disabled) return;
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError("Microphone recording is unavailable. Use a supported browser on localhost or HTTPS.");
      return;
    }
    const session = { chunks: [] };
    sessionRef.current = session;
    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      session.stream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error("This browser does not support a compatible recording format.");
      session.format = mimeType.includes("mp4") ? "m4a" : mimeType.includes("ogg") ? "ogg" : "webm";
      session.recorder = new MediaRecorder(stream, { mimeType });
      session.recorder.ondataavailable = (event) => {
        if (event.data.size) session.chunks.push(event.data);
      };
      session.recorder.onstop = () => {
        if (sessionRef.current !== session) return;
        releaseRecording(session);
        session.blob = new Blob(session.chunks, { type: mimeType });
        session.chunks = [];
        session.finishing = false;
        transcribe(session, Boolean(session.sendPrompt));
      };
      session.recorder.onerror = () => {
        cancelRecording();
        setError("The microphone stopped unexpectedly. Please record again.");
      };
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      session.audioContext = new AudioContext();
      session.analyser = session.audioContext.createAnalyser();
      session.audioContext.createMediaStreamSource(stream).connect(session.analyser);
      session.recorder.start();
      setPhase("recording");
      drawWaveform(session);
      session.timer = setTimeout(() => finishRecording(false), 120_000);
    } catch (error) {
      if (sessionRef.current !== session) return;
      cancelRecording();
      setError(error.name === "NotAllowedError" ? "Microphone access was denied. Allow microphone access in your browser and try again." : error.message);
    }
  }

  return (
    <>
      <button ref={micRef} type="button" className="voice-mic" aria-label="Record prompt" title="Record prompt" disabled={disabled || active} onClick={startRecording}>
        <MaskIcon src="/icons/microphone.png" size={13} />
      </button>
      {active && (
        <div className="voice-recording" role="dialog" aria-label="Record a prompt" aria-modal="true" onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); cancelRecording(); }
          if (event.key === "Tab") {
            const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")];
            const index = buttons.indexOf(document.activeElement);
            event.preventDefault();
            buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
          }
        }}>
          <button ref={cancelRef} type="button" className="voice-round" aria-label="Cancel recording" onClick={() => cancelRecording()}><X size={23} /></button>
          <div className="voice-waveform">
            <canvas ref={canvasRef} aria-hidden="true" />
            <span role="status" className={phase === "recording" ? "sr-only" : "voice-status"}>{phase === "requesting" ? "Waiting for microphone…" : phase === "transcribing" ? "Transcribing…" : phase === "retry" ? "Try transcription again" : "Recording. Two minute limit."}</span>
          </div>
          <button type="button" className="voice-round" aria-label="Transcribe to prompt" title="Transcribe to prompt" disabled={!["recording", "retry"].includes(phase)} onClick={() => finishRecording(false)}><Square size={17} fill="currentColor" /></button>
          <button type="button" className="voice-round voice-send" aria-label="Transcribe and send" title="Transcribe and send" disabled={!["recording", "retry"].includes(phase)} onClick={() => finishRecording(true)}><ArrowUp size={26} /></button>
        </div>
      )}
      {error && <div role="alert" className="voice-error">{error}<button type="button" aria-label="Dismiss recording error" onClick={() => setError("")}><X size={14} /></button></div>}
    </>
  );
}

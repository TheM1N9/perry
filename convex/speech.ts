"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { assertDashboardKey } from "./lib/auth";

export const context = internalQuery({
  args: { id: v.id("meetings"), device: v.optional(v.id("petDevices")), seq: v.number() },
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.device !== args.device || meeting.status !== "listening") throw new Error("This computer isn't recording that meeting.");
    const settings = meeting.speech;
    if (settings?.provider !== "groq") throw new Error("Cloud transcription is off. Select Groq in speech settings before starting a new recording.");
    const saved = await ctx.db.query("meetingSegments").withIndex("by_meeting", (q) => q.eq("meetingId", args.id).eq("seq", args.seq)).first();
    return { settings, saved: saved ? { text: saved.text } : null };
  },
});

export const save = internalMutation({
  args: { id: v.id("meetings"), seq: v.number(), source: v.union(v.literal("you"), v.literal("them")), startMs: v.number(), endMs: v.number(), text: v.string() },
  handler: async (ctx, args) => {
    const meeting = await ctx.db.get(args.id);
    if (!meeting || meeting.status !== "listening") return;
    const existing = await ctx.db.query("meetingSegments").withIndex("by_meeting", (q) => q.eq("meetingId", args.id).eq("seq", args.seq)).first();
    if (existing) return;
    const { id, ...segment } = args;
    await ctx.db.insert("meetingSegments", { ...segment, meetingId: id });
    if (args.text) await ctx.db.patch(id, { segments: meeting.segments + 1, aliveAt: Date.now() });
  },
});

/** The key stays on Perry's server. A completed chunk is saved before its answer returns to the pet. */
export const transcribe = action({
  args: { key: v.string(), device: v.optional(v.id("petDevices")), id: v.id("meetings"), seq: v.number(), source: v.union(v.literal("you"), v.literal("them")), startMs: v.number(), endMs: v.number(), audio: v.string() },
  handler: async (ctx, args): Promise<{ text: string }> => {
    assertDashboardKey(args.key);
    if (!Number.isSafeInteger(args.seq) || args.seq < 0 || args.startMs < 0 || args.endMs <= args.startMs || args.endMs - args.startMs > 30_000 || args.audio.length > 1_400_000) throw new Error("Invalid speech chunk.");
    const { settings, saved } = await ctx.runQuery(internal.speech.context, { id: args.id, device: args.device, seq: args.seq });
    if (saved) return saved;
    const key = await ctx.runQuery(internal.secrets.get, { name: "GROQ_API_KEY" });
    if (!key) throw new Error("Add a Groq speech key in Settings → Desktop pet, or select the local model.");
    const audio = Buffer.from(args.audio, "base64");
    const expectedBytes = Math.round((args.endMs - args.startMs) * 16) * 2;
    if (audio.length !== expectedBytes || audio.length < 2) throw new Error("Speech must be 16 kHz mono PCM16.");
    const wave = Buffer.alloc(44 + audio.length);
    wave.write("RIFF", 0); wave.writeUInt32LE(36 + audio.length, 4); wave.write("WAVEfmt ", 8);
    wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
    wave.writeUInt32LE(16_000, 24); wave.writeUInt32LE(32_000, 28); wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
    wave.write("data", 36); wave.writeUInt32LE(audio.length, 40); audio.copy(wave, 44);
    const form = new FormData();
    form.set("file", new Blob([wave], { type: "audio/wav" }), "speech.wav");
    form.set("model", "whisper-large-v3");
    form.set("response_format", "json");
    if (settings.language !== "auto") form.set("language", settings.language);
    if (settings.vocabulary.trim()) form.set("prompt", settings.vocabulary.trim());
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(response.status === 401 ? "Groq rejected the speech key. Update it in Settings." : response.status === 429 ? "Groq's speech limit was reached. The audio chunk will be retried." : `Groq transcription failed (${response.status}).`);
    const answer = await response.json();
    if (typeof answer.text !== "string") throw new Error("Groq returned no transcript.");
    const text = answer.text.trim().slice(0, 4000);
    await ctx.runMutation(internal.speech.save, { id: args.id, seq: args.seq, source: args.source, startMs: args.startMs, endMs: args.endMs, text });
    return { text };
  },
});

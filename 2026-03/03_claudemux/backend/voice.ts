// Voice transcription via Gemini.
// Takes raw audio + terminal context, returns transcribed text.
// Context helps Gemini disambiguate technical terms (WASM, kubectl, etc).

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const TIMEOUT = 20_000;
const MAX_RETRIES = 3;

async function callGemini(
  apiKey: string,
  audioBase64: string,
  mimeType: string,
  contextHint: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
    body: JSON.stringify({
      system_instruction: {
        parts: [{
          text: 'You are a transcription service for a software engineering terminal session. The speaker is dictating commands, code, or discussing technical topics. Preserve technical terms, function names, variable names, CLI commands, and programming jargon accurately. Output ONLY the transcription, nothing else.',
        }],
      },
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' },
      },
      contents: [{
        parts: [
          { text: `Transcribe this voice message:${contextHint}` },
          { inlineData: { mimeType, data: audioBase64 } },
        ],
      }],
    }),
  });

  console.log(`[voice] Gemini responded: ${resp.status}`);

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[voice] Gemini error body:`, err);
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const json = (await resp.json()) as any;
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(empty transcription)';
}

export async function transcribe(
  audioBase64: string,
  mimeType: string,
  context: string,
): Promise<string> {
  const audioSizeKB = Math.round(audioBase64.length * 3 / 4 / 1024);
  console.log(`[voice] received ${audioSizeKB}KB ${mimeType}, context ${context.length} chars`);

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const contextHint = context
    ? `\n\nRecent terminal output for context (use this to disambiguate technical terms):\n${context}`
    : '';

  let lastErr: Error | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[voice] calling Gemini (${GEMINI_MODEL}), attempt ${attempt}/${MAX_RETRIES}...`);
      const text = await callGemini(apiKey, audioBase64, mimeType, contextHint);
      console.log(`[voice] transcribed: ${text}`);
      return text;
    } catch (err: any) {
      lastErr = err;
      console.error(`[voice] attempt ${attempt} failed:`, err.message || err);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  throw lastErr!;
}

// Transcribe audio using Gemini API.
// Ported from teleclaude — uses generativelanguage.googleapis.com.
// Retries with backoff: 0s, 3s, 10s delays between attempts.

const GEMINI_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-3-flash-preview';
const RETRY_DELAYS = [0, 3000, 10000]; // delays before each attempt

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  context?: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
    if (RETRY_DELAYS[attempt] > 0) {
      console.log(`[audio] retry ${attempt + 1}/${RETRY_DELAYS.length}, waiting ${RETRY_DELAYS[attempt] / 1000}s...`);
      await sleep(RETRY_DELAYS[attempt]);
    }

    try {
      const result = await callGemini(apiKey, audioBase64, mimeType, context);
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[audio] attempt ${attempt + 1}/${RETRY_DELAYS.length} failed:`, lastError.message);
    }
  }

  throw lastError!;
}

async function callGemini(
  apiKey: string,
  audioBase64: string,
  mimeType: string,
  context?: string,
): Promise<string> {
  const contextHint = context
    ? `\n\nRecent conversation for context (use this to disambiguate technical terms):\n${context}`
    : '';

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(120000),
      body: JSON.stringify({
        system_instruction: {
          parts: [{
            text: 'Transcribe this voice message accurately. Use the conversation context to correctly capture technical terms, function names, variable names, CLI commands, and programming jargon. Output ONLY the transcription, nothing else.',
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
    },
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error ${resp.status}: ${err}`);
  }

  const json = (await resp.json()) as any;
  return json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '(empty transcription)';
}

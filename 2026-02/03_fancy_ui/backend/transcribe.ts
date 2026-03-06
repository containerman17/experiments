// Transcribe audio using Gemini API.
// Ported from teleclaude — uses generativelanguage.googleapis.com.

const GEMINI_MODEL = process.env.GEMINI_TRANSCRIPTION_MODEL || 'gemini-3-flash-preview';

export async function transcribeAudio(
  audioBase64: string,
  mimeType: string,
  context?: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY env var not set');

  const contextHint = context
    ? `\n\nRecent conversation for context (use this to disambiguate technical terms):\n${context}`
    : '';

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60000),
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

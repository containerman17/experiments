export type TextPayload = {
    message: string;
    from: 'user' | 'bot';
}

export type FilePayload = {
    file_path: string;
    from: 'user' | 'bot';
}

export type PayloadElement = TextPayload | FilePayload;

export type AiMode = 'light' | 'heavy';

export type StreamCallback = (text: string, isComplete: boolean) => Promise<void>;

export type ProcessWithAiFunction = (
    history: PayloadElement[],
    mode?: AiMode,
    onStream?: StreamCallback,
    language?: 'ru' | 'en'
) => Promise<string>;

export const MAX_MESSAGE_LENGTH = 4096;
export const STREAMING_CHUNK_SIZE = MAX_MESSAGE_LENGTH * 0.7;

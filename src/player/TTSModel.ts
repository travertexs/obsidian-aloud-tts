import {
  REAL_HUME_API_URL,
  REAL_OPENAI_API_URL,
  TTSPluginSettings,
} from "./TTSPluginSettings";
import { base64ToArrayBuffer } from "../util/misc";

/**
 * options used by the audio model. Some options are used as a cache key, such that changes to the options
 * will cause audio to reload
 */
export interface TTSModelOptions {
  model: string;
  voice?: string;
  sourceType: string;
  instructions?: string;
  apiUri: string;
  apiKey: string;
}

export class TTSErrorInfo extends Error {
  status: string;
  httpErrorCode?: number;
  errorDetails: unknown;
  constructor(
    status: string,
    responseDetails: unknown,
    httpErrorCode?: number,
  ) {
    super(`Request failed due to '${httpErrorCode || status}'`);
    this.name = "TTSErrorInfo";
    this.message = `Request failed '${status}'`;
    this.httpErrorCode = httpErrorCode;
    this.status = status;
    this.errorDetails = responseDetails;
  }

  get isRetryable(): boolean {
    if (this.httpErrorCode === undefined) {
      return true;
    }
    return this.httpErrorCode === 429 || this.httpErrorCode >= 500;
  }

  ttsJsonMessage(): string | undefined {
    return (this.errorDetails as ErrorMessage)?.error?.message;
  }
  ttsErrorCode(): string | undefined {
    return (this.errorDetails as ErrorMessage)?.error?.code;
  }
}

export function toModelOptions(
  pluginSettings: TTSPluginSettings,
): TTSModelOptions {
  return {
    model: pluginSettings.model,
    voice: pluginSettings.ttsVoice || undefined,
    sourceType: pluginSettings.sourceType,
    instructions: pluginSettings.instructions || undefined,
    apiUri: pluginSettings.API_URL || (pluginSettings.modelProvider === 'hume' ? REAL_HUME_API_URL : REAL_OPENAI_API_URL),
    apiKey: pluginSettings.API_KEY,
  };
}

// Interface for single text-to-speech requests (OpenAI, compatible)
export interface TTSModel {
  (text: string, options: TTSModelOptions): Promise<ArrayBuffer>;
}

// Interface for batch text-to-speech requests (Hume)
export interface BatchTTSModel {
  (texts: string[], options: TTSModelOptions): Promise<ArrayBuffer[]>;
}

// Type guard to check if a response is a Hume batch response
interface HumeSnippet {
  id: string;
  text: string;
  generation_id: string;
  utterance_index: number;
  audio_format: string;
  audio: string; // Base64 encoded audio
}

interface HumeGeneration {
  generation_id: string;
  duration: number;
  file_size: number;
  encoding: { format: string; sample_rate: number };
  audio: string; // Base64 encoded audio for the *entire* generation (less useful here)
  snippets: HumeSnippet[][]; // Array of arrays of snippets
}

interface HumeBatchResponse {
  request_id: string;
  generations: HumeGeneration[];
}

function isHumeBatchResponse(data: unknown): data is HumeBatchResponse {
  return (
    typeof data === 'object' &&
    data !== null &&
    'generations' in data &&
    Array.isArray((data as HumeBatchResponse).generations) &&
    (data as HumeBatchResponse).generations.length > 0 &&
    'snippets' in (data as HumeBatchResponse).generations[0] &&
    Array.isArray((data as HumeBatchResponse).generations[0].snippets)
  );
}


// Implementation for Hume AI Batch Text-to-Speech
export const humeBatchTextToSpeech: BatchTTSModel = async function (
  texts: string[],
  options: TTSModelOptions,
): Promise<ArrayBuffer[]> {
  // Construct the utterances array for the Hume API request
  const utterances = texts.map((text, index) => {
    const utterance: {
      text: string;
      description?: string;
      voice?: { id: string; provider: string };
      speed?: number;
    } = {
      text: text,
      speed: 1.0,
    };

    // Only include voice and description for the first utterance for continuation
    if (index === 0) {
      if (options.voice) {
        utterance.voice = {
          id: options.voice,
          provider: options.sourceType.toUpperCase(),
        };
      }
      if (options.instructions) {
        utterance.description = options.instructions;
      }
    }
    return utterance;
  });

  const headers = await fetch(orDefaultHume(options.apiUri) + "/v0/tts", {
    headers: {
      "X-Hume-Api-Key": options.apiKey,
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({
      utterances: utterances,
      format: { type: "mp3" },
      num_generations: 1,
      split_utterances: false,
    }),
  });
  await validate200(headers);
  const res = await headers.json();

  if (!isHumeBatchResponse(res)) {
      console.error("Unexpected Hume API response format:", res);
      throw new Error("Unexpected Hume API response format");
  }

  // Hume might return multiple generations, we usually only care about the first one.
  const generation = res.generations[0];
  if (!generation || !generation.snippets) {
    console.error("Hume response missing generations or snippets:", res);
    throw new Error("Hume response missing generations or snippets");
  }


  // Create a map to store audio buffers by utterance index for easy sorting
  const audioBuffersMap = new Map<number, ArrayBuffer>();

  // Hume returns snippets nested in another array for some reason, flatten it first.
  const flattenedSnippets = generation.snippets.flat();

  for (const snippet of flattenedSnippets) {
      if (typeof snippet.utterance_index === 'number' && snippet.audio) {
          const audioData = base64ToArrayBuffer(snippet.audio);
          audioBuffersMap.set(snippet.utterance_index, audioData);
      } else {
          console.warn("Skipping snippet due to missing index or audio:", snippet);
      }
  }


  // Convert the map back to an array, ensuring the order matches the input texts
  const orderedAudioBuffers: ArrayBuffer[] = [];
  for (let i = 0; i < texts.length; i++) {
    const buffer = audioBuffersMap.get(i);
    if (buffer) {
      orderedAudioBuffers.push(buffer);
    } else {
      // Handle cases where a snippet might be missing for an utterance
      console.error(`Missing audio snippet for utterance index ${i}`);
      // Push an empty buffer or throw an error, depending on desired behavior
      // Throwing an error might be safer to indicate incomplete data.
      throw new Error(`Missing audio snippet for utterance index ${i}`);
      // orderedAudioBuffers.push(new ArrayBuffer(0)); // Alternative: push empty buffer
    }
  }

  if (orderedAudioBuffers.length !== texts.length) {
      throw new Error(`Mismatch between input texts (${texts.length}) and received audio buffers (${orderedAudioBuffers.length})`);
  }

  return orderedAudioBuffers;
};


// Original single-text Hume TTS function (kept for potential compatibility, but batch is preferred)
export const humeTextToSpeech: TTSModel = async function humeTextToSpeech(
  text: string,
  options: TTSModelOptions,
): Promise<ArrayBuffer> {
  const results = await humeBatchTextToSpeech([text], options);
  return results[0];
};

// OpenAI / Compatible API implementation
export const openAITextToSpeech: TTSModel = async function openAITextToSpeech(
  text: string,
  options: TTSModelOptions,
): Promise<ArrayBuffer> {
  const headers = await fetch(orDefaultOpenAI(options.apiUri) + "/v1/audio/speech", {
    headers: {
      Authorization: "Bearer " + options.apiKey,
      "Content-Type": "application/json",
    },
    method: "POST",
    body: JSON.stringify({
      model: options.model,
      voice: (options.voice ? options.voice : ""),
      ...(options.instructions && {
        instructions: options.instructions
      }),
      input: text,
      speed: 1.0,
    }),
  });
  await validate200(headers);
  const bf = await headers.arrayBuffer();
  return bf;
};

function orDefaultOpenAI(maybeUrl: string): string {
  return maybeUrl.replace(/\/$/, "") || REAL_OPENAI_API_URL;
}

function orDefaultHume(maybeUrl: string): string {
  return maybeUrl.replace(/\/$/, "") || REAL_HUME_API_URL;
}

export async function listOpenAIModels(
  settings: TTSPluginSettings,
): Promise<string[]> {
  const headers = await fetch(
    orDefaultOpenAI(settings.API_URL) + "/v1/models",
    {
      method: "GET",
      headers: {
        Authorization: "Bearer " + settings.API_KEY,
        "Content-Type": "application/json",
      },
    },
  );
  await validate200(headers);
  const models = await headers.json();
  return models.data as string[];
}

async function validate200(response: Response) {
  if (response.status >= 300) {
    let body;
    try {
      body = await response.json();
    } catch (ex) {
      // nothing
    }
    throw new TTSErrorInfo(
      `HTTP ${response.status} error`,
      body,
      response.status,
    );
  }
}

export class APIError extends Error {
  name = "APIError";
  status: number;
  json?: unknown;

  constructor(status: number, json?: unknown) {
    super(`API error (${status}) - ${JSON.stringify(json)})`);
    this.status = status;
    this.json = json;
  }
  jsonMessage(): string | undefined {
    return (this.json as ErrorMessage)?.error?.message;
  }
  errorCode(): string | undefined {
    return (this.json as ErrorMessage)?.error?.code;
  }
}

// {
//   "error": {
//     "message": "Incorrect API key provided: sk-DnweH**************************************qMr3. You can find your API key at https://platform.openai.com/account/api-keys.",
//     "type": "invalid_request_error",
//     "param": null,
//     "code": "invalid_api_key"
//   }
// }

type ErrorMessage = {
  error: {
    message: string;
    type: string;
    code: string;
    param: unknown;
  };
};

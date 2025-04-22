import { AudioCache } from "./AudioCache";
import { AudioSink, WebAudioSink } from "./AudioSink";
import { AudioStore, loadAudioStore } from "./AudioStore";
import { TTSModel, BatchTTSModel, humeTextToSpeech, humeBatchTextToSpeech, openAITextToSpeech } from "./TTSModel";
import { TTSPluginSettings, DEFAULT_SETTINGS } from "./TTSPluginSettings";
import { ChunkLoader } from "./ChunkLoader";
import { configurableAudioCache } from "../obsidian/ObsidianPlayer";

// Configuration options for the AudioSystem
export interface AudioSystemConfig {
  backgroundLoaderIntervalMillis: number;
}

export interface AudioSystem {
  readonly audioSink: AudioSink;
  readonly audioStore: AudioStore;
  readonly settings: TTSPluginSettings;
  readonly storage: AudioCache;
  readonly chunkLoader: ChunkLoader;
  readonly ttsModel: TTSModel | undefined;
  readonly humeBatchTTSModel: BatchTTSModel | undefined;
  readonly config: AudioSystemConfig;
}

// Define the AsLazyBuilder type
export type AsLazyBuilder<T> = {
  [K in keyof T]: (input: AudioSystem) => T[K];
};

// Define a type that makes all fields of a given type mutable
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

/** Poor Man's Dependency Injection via a global system */
export function createAudioSystem(
  opts: AsLazyBuilder<AudioSystem>,
): AudioSystem {
  const partial: Partial<Mutable<AudioSystem>> = {};
  const proxy = new Proxy(
    {},
    {
      get(_, prop: keyof AudioSystem) {
        if (!partial[prop]) {
          partial[prop] = opts[prop](proxy as AudioSystem) as any;
        }
        return partial[prop];
      },
      set() {
         // Prevent modification after initial lazy creation
         throw new Error("AudioSystem properties are read-only after creation.");
      }
    },
  );
  return proxy as AudioSystem;
}

// --- Default AudioSystem Factory ---

export async function defaultAudioSystem(pluginSettings: TTSPluginSettings): Promise<AudioSystem> {
    const settings = pluginSettings || DEFAULT_SETTINGS;

    const audio = await WebAudioSink.create();

    return createAudioSystem({
        settings: () => settings,
        config: () => ({
            backgroundLoaderIntervalMillis: 500, // Example value, could be configurable
        }),
        ttsModel: (system) => (
          system.settings.modelProvider === "hume" ?
            humeTextToSpeech :
            openAITextToSpeech
        ),
        humeBatchTTSModel: (system) => (
          system.settings.modelProvider === "hume" ?
            humeBatchTextToSpeech :
            undefined
        ),

        storage: () => configurableAudioCache(this.app, this.settings),
        chunkLoader: (system) => new ChunkLoader({ system }),
        audioSink: () => audio,
        audioStore: (system) => loadAudioStore({ system }),
    });
}

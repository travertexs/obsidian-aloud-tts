import * as mobx from "mobx";
import { AudioSystem } from "./AudioSystem";
import { TTSErrorInfo, TTSModelOptions, toModelOptions } from "./TTSModel";
import { AudioTextChunk } from "./AudioTextChunk";

/** manages loading and caching of tracks */
export class ChunkLoader {
  private MAX_BACKGROUND_REQUESTS = 3;
  private MAX_LOCAL_TTL_MILLIS = 60 * 1000;

  private system: AudioSystem;
  private backgroundQueue: BackgroundRequest[] = [];
  private backgroundActiveCount = 0;
  private localCache: CachedAudio[] = [];
  private backgroundRequestProcessor: IntervalDaemon;
  private garbageCollector: IntervalDaemon;

  constructor({ system }: { system: AudioSystem }) {
    this.system = system;

    this.backgroundRequestProcessor = IntervalDaemon(
      this.processBackgroundQueue.bind(this),
      { interval: system.config.backgroundLoaderIntervalMillis },
    );
    this.garbageCollector = IntervalDaemon(this.processGarbage.bind(this), {
      interval: this.MAX_LOCAL_TTL_MILLIS / 2,
    }).startIfNot();
  }

  expireBefore = (
    position: number = this.system.audioStore?.activeText?.position ?? 0,
  ): void => {
    this.backgroundQueue = this.backgroundQueue.filter(
      (x) => !(x.position < position),
    );
  };

  /**
   * Removes locally cached audio (e.g., if ArrayBuffer becomes detached).
   * Does not affect storage cache.
   */
  uncache(text: string): void {
    this.localCache = this.localCache.filter((x) => x.text !== text);
  }

  preload(text: string, options: TTSModelOptions, position: number): void {
    // Check if already queued
    const alreadyQueued = this.backgroundQueue.some(
      (x) => x.text === text && mobx.comparer.structural(x.options, options),
    );
    if (alreadyQueued) {
      return;
    }

    // Check if already in local memory cache (loading or loaded)
    const alreadyLoaded = this.localCache.some(
      (x) => x.text === text && mobx.comparer.structural(x.options, options),
    );
    if (alreadyLoaded) {
      // Update requested time to prevent garbage collection if needed
      const cached = this.localCache.find(x => x.text === text && mobx.comparer.structural(x.options, options));
      if (cached) cached.requestedTime = Date.now();
      return;
    }
    this.backgroundQueue.push({
      text,
      options,
      requestedTime: Date.now(),
      position,
    });
    // Sort queue by position to prioritize upcoming chunks
    this.backgroundQueue.sort((a, b) => a.position - b.position);
    this.backgroundRequestProcessor.startIfNot();
  }

  /**
   * Requests audio for a given text and options.
   * Returns a promise that resolves with the ArrayBuffer.
   * Handles local caching and triggers background loading if necessary.
   */
  /*
  async load(text: string, options: TTSModelOptions): Promise<ArrayBuffer> {
    const existing = this.localCache.find(
      (x) =>
        x.text === text &&
        mobx.comparer.structural(x.options, options) // Use structural comparison
    );

    if (existing) {
      existing.requestedTime = Date.now();
      return existing.result;
    } else {
      const audio = this.createCachedAudio(text, options);
      this.localCache.push(audio);
      return audio.result;
    }
  }
  */

  // --- Batch Loading Retry Logic ---
  async load(texts: string[], options: TTSModelOptions): Promise<ArrayBuffer[]> {
    let results: Promise<ArrayBuffer>[] = [];

    if (this.system.settings.batchMode === "off") {
      const existing = this.localCache.find(
        (x) =>
          x.text === texts[0] &&
          mobx.comparer.structural(x.options, options) // Use structural comparison
      );

      if (existing) {
        existing.requestedTime = Date.now();
        results.push(existing.result);
      } else {
        const audio = this.createCachedAudios([texts[0]], options)[0];
        this.localCache.push(audio);
        results.push(audio.result);
      }
    } else if (this.system.settings.batchMode === "reload_uncached_only") {
      for(let i = 0; i < texts.length; i++) {
        const existing = this.localCache.find(
          (x) =>
            x.text === texts[i] &&
            mobx.comparer.structural(x.options, options) // Use structural comparison
        );

        if (existing) {
          existing.requestedTime = Date.now();
          results.push(existing.result);
        } else {
          const audio = this.createCachedAudios([texts[i]], options)[0];
          this.localCache.push(audio);
          results.push(audio.result);
        }
      }
    } else if (this.system.settings.batchMode === "reload_from_first_uncached") {
      let index = 0;
      while(index < texts.length) {
        const existing = this.localCache.find(
          (x) =>
            x.text === texts[index] &&
            mobx.comparer.structural(x.options, options) // Use structural comparison
        );

        if (existing) {
          existing.requestedTime = Date.now();
          results.push(existing.result);
          index++;
        } else {
          break;
        }
      }

      if (index < texts.length) {
        const audios = this.createCachedAudios(texts.slice(index), options);
        for(let i = 0; i < audios.length; i++) {
          const existingIndex = this.localCache.findIndex(
            (x) =>
              x.text === texts[index + i] &&
              mobx.comparer.structural(x.options, options) // Use structural comparison
          );

          if (existingIndex === -1) {
            this.localCache.push(audios[i]);
          } else {
            this.localCache[existingIndex] = audios[i];
          }
          results.push(audios[i].result);
        }
      }
    } else if (this.system.settings.batchMode === "reload_all") {
      const audios = this.createCachedAudios(texts, options);
      for(let i = 0; i < texts.length; i++) {
        const existingIndex = this.localCache.findIndex(
          (x) =>
            x.text === texts[i] &&
            mobx.comparer.structural(x.options, options) // Use structural comparison
        );

        if (existingIndex === -1) {
          this.localCache.push(audios[i]);
        } else {
          this.localCache[existingIndex] = audios[i];
        }
        results.push(audios[i].result);
      }
    }

    return Promise.all(results);
  }

  destroy(): void {
    this.backgroundRequestProcessor.stop();
    this.garbageCollector.stop();
    // Clear caches and queue on destroy
    this.localCache = [];
    this.backgroundQueue = [];
    this.backgroundActiveCount = 0;
  }

/*
  private createCachedAudio(
    text: string,
    options: TTSModelOptions,
  ): CachedAudio {
    const audio = {
      text,
      options,
      requestedTime: Date.now(),
      result: this.tryLoadTrack([text], options, 0, 3).catch((e) => {
        this.destroyCachedAudio(audio);
        throw e;
      }),
    };
    return audio;
  }
*/

  private createCachedAudios(
    texts: string[],
    options: TTSModelOptions,
  ): CachedAudio[] {
    const audios: CachedAudio[] = new Array(texts.length);
    const resultsPromise = this.tryLoadTrack(texts, options, 0, 3).catch((e) => {
      for(let i = 0; i < texts.length; i++) {
        this.destroyCachedAudio(audios[i]);
      }
      throw e;
    });

    for (let i = 0; i < texts.length; i++) {
      audios[i] = {
        text: texts[i],
        options,
        requestedTime: Date.now(),
        result: resultsPromise.then(results => results[i]), // Resolve with the correct element from the results array
      }
    }

    return audios;
  }

  private destroyCachedAudio(audio: CachedAudio): void {
    const index = this.localCache.indexOf(audio);
    if (index !== -1) {
      this.localCache.splice(index, 1);
    }
  }

  // Processes the queue, deciding whether to batch (Hume) or send individually
  private processBackgroundQueue(): boolean {
    if (this.backgroundActiveCount >= this.MAX_BACKGROUND_REQUESTS) {
      return true;
    }
    if (this.backgroundQueue.length === 0) {
      return false;
    }

    let texts: string[] = [];
    let itemOptions: TTSModelOptions;

    const isInBatchMode = this.system.settings.batchMode !== "off";
    if (isInBatchMode) {
      // --- Batch Processing ---
      const items = [...this.backgroundQueue];
      this.backgroundQueue = [];
      texts = items.map(item => item.text);
      itemOptions = items[0].options;
    } else {
      // --- Non-Batch Processing ---
      const item = this.backgroundQueue.shift()!; // Take one item
      texts.push(item.text);
      itemOptions = item.options;
    }

    this.backgroundActiveCount += 1; // Increment active *requests* count by 1
    this.load(texts, itemOptions).finally(() => {
      this.backgroundActiveCount -= 1;
      this.processBackgroundQueue(); // Check for more work
    });

    return true; // Keep processor running if queue might still have items or requests are active
  }

  private processGarbage(): boolean {
    this.localCache = this.localCache.filter(
      (entry) => Date.now() - entry.requestedTime < this.MAX_LOCAL_TTL_MILLIS,
    );
    return true;
  }

  private async tryLoadTrack(
    tracks: string[],
    options: TTSModelOptions,
    attempt: number = 0,
    maxAttempts: number = 3,
  ): Promise<ArrayBuffer[]> {
    try {
      return await this.loadTrack(tracks, options);
    } catch (ex) {
      const errorInfo = ex instanceof TTSErrorInfo ? ex : undefined;
      const canRetry =
        attempt < maxAttempts && (errorInfo ? errorInfo.isRetryable : true);
      if (!canRetry) {
        throw ex;
      } else {
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * Math.pow(2, attempt)),
        );
        return await this.tryLoadTrack(
          tracks,
          options,
          attempt + 1,
          maxAttempts,
        );
      }
    }
  }

  /** non-stateful function (barring layers of caching and API calls) */
  private async loadTrack(
    texts: string[],
    options: TTSModelOptions,
  ): Promise<ArrayBuffer[]> {
    let audios: ArrayBuffer[] = [];

    if (this.system.settings.batchMode === "off") {
      // copy the settings to make sure audio isn't stored under under the wrong key
      // if the settings are changed while request is in flight
      const stored: ArrayBuffer | null = 
        await this.system.storage.getAudio(texts[0], options);
      if (stored) {
        audios[0] = stored;
      } else {
        const buff = (await this.system.ttsModel([texts[0]], options))[0];
        await this.system.storage.saveAudio(texts[0], options, buff);
        audios[0] = buff;
      }
    } else if (this.system.settings.batchMode === "reload_uncached_only") {
      for(let i = 0; i < texts.length; i++) {
        const stored: ArrayBuffer | null = 
          await this.system.storage.getAudio(texts[i], options);
        if (stored) {
          audios[i] = stored;
        } else {
          const buff = (await this.system.ttsModel([texts[0]], options))[0];
          await this.system.storage.saveAudio(texts[0], options, buff);
          audios[i] = buff;
        }
      }
    } else if (this.system.settings.batchMode === "reload_from_first_uncached") {
      let index = 0;
      while(index < texts.length) {
        const stored: ArrayBuffer | null = 
          await this.system.storage.getAudio(texts[index], options);
        if (stored) {
          audios[index] = stored;
        } else {
          break;
        }
      }

      if (index < texts.length) {
        const buff = await this.system.ttsModel(texts.slice(index), options);
        for(let i = 0; i < buff.length; i++) {
          const actualIndex = index + i;
          await this.system.storage.saveAudio(texts[actualIndex], options, buff[i]);
          audios[actualIndex] = buff[i];
        }
      }
    } else if (this.system.settings.batchMode === "reload_all") {
      const buff = await this.system.ttsModel(texts, options);
      for(let i = 0; i < texts.length; i++) {
        await this.system.storage.saveAudio(texts[i], options, buff[i]);
        audios[i] = buff[i];
      }
    }

    return audios;
  }
}

// --- Helper Interfaces and Functions ---
interface IntervalDaemon {
  stop: () => IntervalDaemon;
  startIfNot: () => IntervalDaemon;
}

type ShouldContinue = boolean;

/** runs the work function every interval, until the work function returns false. Can be stopped and started. */
export function IntervalDaemon(
  doWork: () => ShouldContinue,
  opts: {
    interval: number;
  },
): IntervalDaemon {
  let timer: undefined | ReturnType<typeof setInterval>;
  const processor: IntervalDaemon = {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      return processor;
    },
    startIfNot: () => {
      if (timer !== undefined) {
        return processor;
      }
      let shouldContinue = true;
      try {
        shouldContinue = doWork();
      } catch (ex) {
         // Decide whether to stop or continue based on error? For now, assume continue.
         shouldContinue = true;
      }
      if (shouldContinue) {
        timer = setInterval(() => {
          let shouldContinueInterval = true;
          try {
            shouldContinueInterval = doWork();
          } catch (ex) {
             // Decide whether to stop or continue based on error? For now, assume continue.
             shouldContinueInterval = true;
          }
          if (!shouldContinueInterval) {
            processor.stop();
          }
        }, opts.interval);
      }
      return processor;
    },
  };
  return processor;
}

interface BackgroundRequest {
  /** the text that was requested */
  text: string;
  /** the options used to generate this audio */
  options: TTSModelOptions;
  /** the time the request was made. Milliseconds since Unix Epoch */
  requestedTime: number;
  /** the track number that was requested */
  position: number;
}

interface CachedAudio {
  /** the text that was requested */
  readonly text: string;
  /** the options used to generate this audio */
  readonly options: TTSModelOptions;
  /** the final result of the request across retries */
  readonly result: Promise<ArrayBuffer>;
  /** the time the request was made. Milliseconds since Unix Epoch. May be updated to prevent deletion */
  requestedTime: number;
}